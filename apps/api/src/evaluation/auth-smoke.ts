import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { ResearchSession } from "../domain.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { QuotaPolicy } from "../quota-policy.js";
import { createServer } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import type { OpenRouterProvider } from "../llm.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthSmokeUserPair,
  createAuthUserWithReconciliation,
} from "./auth-smoke-cleanup.js";
import {
  classifyAuthSmokeFailure,
  createAuthSmokeFetch,
  formatAuthSmokeError,
  type AuthSmokeTransportEvent,
} from "./auth-smoke-transport.js";
import {
  lookupResearchSessionOwner,
  summarizeOwnershipLookupError,
} from "./auth-smoke-ownership.js";

interface AuthSmokeReport {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "PASSED" | "FAILED";
  failedAt?: string;
  checks: Record<string, boolean>;
  providerCallsAfterQuotaDenial: number;
  cleanupVerified: boolean;
  errors: string[];
  authTransport: AuthSmokeTransportEvent[];
  ownershipTrace: Array<Record<string, unknown>>;
  databaseOwnership?: Record<string, unknown>;
  quotaTrace?: Record<string, unknown>;
  reportFile?: string;
  assertion?: {
    stage: string;
    operator?: string;
    expected: unknown;
    actual: unknown;
  };
}

function shortIdHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeResponseShape(value: unknown) {
  if (!value || typeof value !== "object") return { type: value === null ? "null" : typeof value };
  const record = value as Record<string, unknown>;
  return {
    type: Array.isArray(value) ? "array" : "object",
    keys: Object.keys(record).sort(),
    idHash: typeof record.id === "string" ? shortIdHash(record.id) : undefined,
  };
}

async function captureApiResponse(response: Response) {
  const text = await response.text();
  let body: unknown;
  let jsonValid = false;
  try {
    body = JSON.parse(text);
    jsonValid = true;
  } catch {
    body = undefined;
  }
  return {
    body,
    summary: {
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      bodyBytes: Buffer.byteLength(text, "utf8"),
      jsonValid,
      bodyShape: safeResponseShape(body),
    },
  };
}

function safeAssertionValue(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      hash: createHash("sha256").update(value).digest("hex").slice(0, 12),
    };
  }
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object") return { type: typeof value };

  const record = value as Record<string, unknown>;
  const summarizeId = (field: string) =>
    typeof record[field] === "string"
      ? createHash("sha256")
          .update(record[field] as string)
          .digest("hex")
          .slice(0, 12)
      : undefined;
  return {
    type: "object",
    keys: Object.keys(record).sort(),
    idHash: summarizeId("id"),
    ownerIdHash: summarizeId("owner_id"),
    statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
  };
}

function requireResult(
  result: { data: any; error: { message: string; status?: number } | null },
  operation: string,
): any {
  if (result.error) {
    const error = new Error(operation) as Error & { status?: number };
    if (typeof result.error.status === "number") error.status = result.error.status;
    throw error;
  }
  if (result.data === null) throw new Error(`${operation}: empty response`);
  return result.data;
}

function recordAuthCreateClientError(events: AuthSmokeTransportEvent[], error: unknown): void {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.method === "POST" && candidate.path === "/auth/v1/admin/users");
  if (!event) return;

  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  event.clientErrorName = typeof value.name === "string" ? value.name : "UnknownError";
  event.clientErrorStatus = typeof value.status === "number" ? value.status : undefined;
  event.clientFailureClassification = classifyAuthSmokeFailure(error, event);
}

async function findTemporaryAuthUserIds(
  admin: ReturnType<typeof createClient<any>>,
  targetEmails: ReadonlySet<string>,
): Promise<string[]> {
  const matchingIds: string[] = [];
  let page: number | null = 1;
  let pagesRead = 0;

  while (page !== null && pagesRead < 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Could not inspect temporary Auth fixtures during cleanup");

    for (const user of data.users) {
      if (user.email && targetEmails.has(user.email)) matchingIds.push(user.id);
    }

    page = data.nextPage;
    pagesRead += 1;
  }

  if (page !== null) {
    throw new Error("Temporary Auth cleanup scan exceeded its page bound");
  }

  return matchingIds;
}

function makeSession(id: string): ResearchSession {
  const now = new Date().toISOString();
  return {
    id,
    question: "Temporary MAX auth ownership smoke fixture",
    mode: "quick",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    conflicts: [],
    decisions: [],
    steps: [],
    answer: "Temporary fixture for owner-isolation verification.",
  };
}

async function main() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY || !config.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Auth smoke requires SUPABASE_URL, a rotated server-only SUPABASE_SECRET_KEY, and SUPABASE_PUBLISHABLE_KEY.",
    );
  }
  const supabaseUrl = config.SUPABASE_URL;
  const supabaseSecretKey = config.SUPABASE_SECRET_KEY;

  const started = Date.now();
  let deadline = started + 60_000;
  const cleanupDeadline = started + 90_000;
  const startedAt = new Date(started).toISOString();
  // Keep the same native-fetch binding used by the isolated response diagnostic.
  // The wrapper replaces globalThis.fetch later, so retain an explicit native reference.
  const originalFetch = globalThis.fetch.bind(globalThis);
  const authTransport: AuthSmokeTransportEvent[] = [];
  const ids = {
    userA: undefined as string | undefined,
    userB: undefined as string | undefined,
    sessionA: randomUUID(),
    sessionB: randomUUID(),
  };
  const passwords = { userA: `${randomUUID()}!aA9`, userB: `${randomUUID()}!bB8` };
  const emailSuffix = randomUUID();
  const emails = {
    userA: `max-auth-smoke-a-${emailSuffix}@example.com`,
    userB: `max-auth-smoke-b-${emailSuffix}@example.com`,
  };
  const report: AuthSmokeReport = {
    startedAt,
    status: "FAILED",
    checks: {},
    providerCallsAfterQuotaDenial: 0,
    cleanupVerified: false,
    errors: [],
    authTransport,
    ownershipTrace: [],
  };
  let failedAt = "initialize temporary clients";
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let store: SupabaseStore | undefined;

  const boundedFetch = createAuthSmokeFetch({
    fetchImpl: originalFetch,
    deadline: () => deadline,
    onEvent: (event) => {
      if (event.path.startsWith("/auth/v1/")) authTransport.push(event);
    },
  });
  globalThis.fetch = boundedFetch;
  const clientOptions = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  };
  const admin = createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    ...clientOptions,
    global: { fetch: createSupabaseFetch() },
  });
  const authClientA = createClient<any>(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    clientOptions,
  );
  const authClientB = createClient<any>(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    clientOptions,
  );
  store = new SupabaseStore(
    config.SUPABASE_URL,
    config.SUPABASE_SECRET_KEY,
    undefined,
    config.SUPABASE_PUBLISHABLE_KEY,
  );
  const researchAdmin = admin.schema("research");
  const quotaPolicy = new QuotaPolicy(
    JSON.stringify({
      default: {
        quotas: {
          research: { limit: 1, windowSeconds: 604800 },
          deep_research: { limit: 1, windowSeconds: 604800 },
          followup: { limit: 1, windowSeconds: 604800 },
        },
      },
    }),
  );
  let providerCalls = 0;
  let searchCalls = 0;
  let mockedLlmCalls = 0;
  const searchProvider = {
    search: async () => {
      providerCalls += 1;
      searchCalls += 1;
      return [];
    },
  };
  const llmProvider = new Proxy(
    { enabled: true },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return async () => {
          providerCalls += 1;
          mockedLlmCalls += 1;
          if (property === "complete") {
            return "A JavaScript closure is a function that retains access to its surrounding scope.";
          }
          throw new Error("Unexpected model operation in the Auth smoke");
        };
      },
    },
  ) as unknown as OpenRouterProvider;

  try {
    failedAt = "start bounded Fastify backend on configured local port";
    store.recoverInterrupted = async () => 0;
    store.recoverAutonomousRuns = async () => 0;
    store.listRuns = async () => [];
    api = await createServer({
      store,
      authVerifier: new SupabaseAuthVerifier(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY),
      quotaPolicy,
      searchProvider,
      llmProvider,
    });
    await api.listen({ port: config.PORT, host: "127.0.0.1" });
    const apiOrigin = `http://127.0.0.1:${config.PORT}`;
    const healthResponse = await originalFetch(`${apiOrigin}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(healthResponse.status, 200, "Fastify health check over HTTP failed");
    report.checks.fastifyHttp = true;
    failedAt = "verify Fastify readiness reports Supabase persistence";
    const readinessResponse = await originalFetch(`${apiOrigin}/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    const readinessCapture = await captureApiResponse(readinessResponse);
    const readinessBody = readinessCapture.body as { status?: string } | undefined;
    assert.equal(readinessCapture.summary.status, 200);
    assert.equal(readinessBody?.status, "ready");
    // The readiness endpoint reports the process-level configured provider, which can differ
    // from the injected SupabaseStore used by this smoke. A 200 here also proves store.list()
    // succeeded on that injected store.
    report.checks.supabaseStoreReady = true;

    const { userA: createdA, userB: createdB } = await createAuthSmokeUserPair(
      async () => {
        failedAt = "create temporary User A";
        return createAuthUserWithReconciliation(
          async () => {
            try {
              const result = await admin.auth.admin.createUser({
                email: emails.userA,
                password: passwords.userA,
                email_confirm: true,
              });
              if (result.error) recordAuthCreateClientError(authTransport, result.error);
              return result;
            } catch (error) {
              recordAuthCreateClientError(authTransport, error);
              throw error;
            }
          },
          supabaseUrl,
          supabaseSecretKey,
          emails.userA,
          {
            stopAfterUncertainCreate: true,
            onReconciledUser: (user) => {
              ids.userA = user.id;
            },
          },
        );
      },
      (userA) => {
        ids.userA = userA.id;
        failedAt = "create temporary User B";
      },
      () =>
        createAuthUserWithReconciliation(
          () =>
            admin.auth.admin.createUser({
              email: emails.userB,
              password: passwords.userB,
              email_confirm: true,
            }),
          supabaseUrl,
          supabaseSecretKey,
          emails.userB,
          {
            recoverByIdentity: async () => {
              const { data, error } = await authClientB.auth.signInWithPassword({
                email: emails.userB,
                password: passwords.userB,
              });
              if (error || !data.user?.id) return undefined;
              return { id: data.user.id };
            },
          },
        ),
    );
    ids.userA = createdA.id;
    ids.userB = createdB.id;
    const userAId = createdA.id;
    const userBId = createdB.id;

    failedAt = "sign in and verify both temporary users";
    const signedInA = requireResult(
      await authClientA.auth.signInWithPassword({ email: emails.userA, password: passwords.userA }),
      "sign in temporary user A",
    );
    const signedInB = requireResult(
      await authClientB.auth.signInWithPassword({ email: emails.userB, password: passwords.userB }),
      "sign in temporary user B",
    );
    const accessTokenA: string | undefined = signedInA.session?.access_token;
    const accessTokenB: string | undefined = signedInB.session?.access_token;
    assert(accessTokenA && accessTokenB, "Supabase did not return both access tokens");
    const verifier = new SupabaseAuthVerifier(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY);
    const verifiedA = await verifier.verifyAccessToken(accessTokenA);
    const verifiedB = await verifier.verifyAccessToken(accessTokenB);
    assert.equal(verifiedA?.id, userAId);
    assert.equal(verifiedB?.id, userBId);
    report.checks.authenticatedUsers = true;

    failedAt = "verify research-session RLS ownership";
    const sessionA = makeSession(ids.sessionA);
    const sessionB = makeSession(ids.sessionB);
    await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
      store!.create(sessionA),
    );
    await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
      store!.create(sessionB),
    );
    assert.deepEqual(
      await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
        store!.get(ids.sessionA),
      ),
      sessionA,
    );
    assert.equal(
      await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
        store!.get(ids.sessionA),
      ),
      undefined,
    );
    await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
      store!.update({ ...sessionA, question: "unauthorized update attempt" }),
    ).catch(() => undefined);
    await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
      store!.delete(ids.sessionA),
    );
    assert.equal(
      (
        await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
          store!.get(ids.sessionA),
        )
      )?.question,
      sessionA.question,
    );
    assert.equal(
      await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
        store!.get(ids.sessionB),
      ),
      undefined,
    );
    await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
      store!.update({ ...sessionB, question: "unauthorized reverse update attempt" }),
    ).catch(() => undefined);
    await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
      store!.delete(ids.sessionB),
    );
    assert.deepEqual(
      await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
        store!.get(ids.sessionB),
      ),
      sessionB,
    );
    report.checks.sessionOwnerIsolation = true;

    failedAt = "Fastify User A GET own session";
    const ownSessionResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionA)}`,
      {
        headers: { authorization: `Bearer ${accessTokenA}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const ownSessionCapture = await captureApiResponse(ownSessionResponse);
    const ownSessionTrace: Record<string, unknown> = {
      assertion: "user_a_reads_own_session",
      method: "GET",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedStatus: 200,
      actualStatus: ownSessionCapture.summary.status,
      expectedOwnership: "authenticated_user_is_owner",
      response: ownSessionCapture.summary,
      bodyMatchesExpectedSession: isDeepStrictEqual(ownSessionCapture.body, sessionA),
    };
    report.ownershipTrace.push(ownSessionTrace);
    failedAt = "Fastify User A GET own-session status is 200";
    assert.equal(ownSessionCapture.summary.status, 200);
    failedAt = "Fastify User A GET own-session body matches stored session";
    assert.deepEqual(ownSessionCapture.body, sessionA);
    failedAt = "Fastify User B GET own session";
    const ownSessionBResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionB)}`,
      {
        headers: { authorization: `Bearer ${accessTokenB}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const ownSessionBCapture = await captureApiResponse(ownSessionBResponse);
    const ownSessionBTrace: Record<string, unknown> = {
      assertion: "user_b_reads_own_session",
      method: "GET",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedStatus: 200,
      actualStatus: ownSessionBCapture.summary.status,
      expectedOwnership: "authenticated_user_is_owner",
      response: ownSessionBCapture.summary,
      bodyMatchesExpectedSession: isDeepStrictEqual(ownSessionBCapture.body, sessionB),
    };
    report.ownershipTrace.push(ownSessionBTrace);
    failedAt = "Fastify User B GET own-session status is 200";
    assert.equal(ownSessionBCapture.summary.status, 200);
    failedAt = "Fastify User B GET own-session body matches stored session";
    assert.deepEqual(ownSessionBCapture.body, sessionB);
    failedAt = "Fastify User B GET User A session returns 404";
    const foreignSessionResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionA)}`,
      {
        headers: { authorization: `Bearer ${accessTokenB}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const foreignSessionCapture = await captureApiResponse(foreignSessionResponse);
    report.ownershipTrace.push({
      assertion: "user_b_cannot_read_user_a_session",
      method: "GET",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedStatus: 404,
      actualStatus: foreignSessionCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: foreignSessionCapture.summary,
      recordReturned: false,
    });
    assert.equal(foreignSessionCapture.summary.status, 404);
    failedAt = "Fastify User A GET User B session returns 404";
    const reverseForeignSessionResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionB)}`,
      {
        headers: { authorization: `Bearer ${accessTokenA}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const reverseForeignSessionCapture = await captureApiResponse(reverseForeignSessionResponse);
    report.ownershipTrace.push({
      assertion: "user_a_cannot_read_user_b_session",
      method: "GET",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedStatus: 404,
      actualStatus: reverseForeignSessionCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: reverseForeignSessionCapture.summary,
      recordReturned: false,
    });
    assert.equal(reverseForeignSessionCapture.summary.status, 404);
    failedAt = "Fastify User B DELETE User A session returns 404";
    const foreignSessionDeleteResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionA)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessTokenB}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const foreignSessionDeleteCapture = await captureApiResponse(foreignSessionDeleteResponse);
    report.ownershipTrace.push({
      assertion: "user_b_cannot_delete_user_a_session",
      method: "DELETE",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedStatus: 404,
      actualStatus: foreignSessionDeleteCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: foreignSessionDeleteCapture.summary,
    });
    assert.equal(foreignSessionDeleteCapture.summary.status, 404);
    failedAt = "Fastify User B cancel User A session returns 404";
    const foreignSessionCancelResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionA)}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessTokenB}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const foreignSessionCancelCapture = await captureApiResponse(foreignSessionCancelResponse);
    report.ownershipTrace.push({
      assertion: "user_b_cannot_cancel_user_a_session",
      method: "POST",
      endpoint: "/api/research/:id/cancel",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedStatus: 404,
      actualStatus: foreignSessionCancelCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: foreignSessionCancelCapture.summary,
    });
    assert.equal(foreignSessionCancelCapture.summary.status, 404);
    failedAt = "Fastify User A DELETE User B session returns 404";
    const reverseForeignSessionDeleteResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionB)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessTokenA}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const reverseForeignSessionDeleteCapture = await captureApiResponse(
      reverseForeignSessionDeleteResponse,
    );
    report.ownershipTrace.push({
      assertion: "user_a_cannot_delete_user_b_session",
      method: "DELETE",
      endpoint: "/api/research/:id",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedStatus: 404,
      actualStatus: reverseForeignSessionDeleteCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: reverseForeignSessionDeleteCapture.summary,
    });
    assert.equal(reverseForeignSessionDeleteCapture.summary.status, 404);
    failedAt = "Fastify User A cancel User B session returns 404";
    const reverseForeignSessionCancelResponse = await originalFetch(
      `${apiOrigin}/api/research/${encodeURIComponent(ids.sessionB)}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessTokenA}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const reverseForeignSessionCancelCapture = await captureApiResponse(
      reverseForeignSessionCancelResponse,
    );
    report.ownershipTrace.push({
      assertion: "user_a_cannot_cancel_user_b_session",
      method: "POST",
      endpoint: "/api/research/:id/cancel",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedStatus: 404,
      actualStatus: reverseForeignSessionCancelCapture.summary.status,
      expectedOwnership: "requester_is_not_owner_resource_hidden",
      response: reverseForeignSessionCancelCapture.summary,
    });
    assert.equal(reverseForeignSessionCancelCapture.summary.status, 404);

    failedAt = "direct RLS User B UPDATE of User A session is denied";
    const updateOtherUserSessionAsB = await authClientB
      .schema("research")
      .from("max_research_sessions")
      .update({ owner_id: userBId, data: { ...sessionA, question: "forbidden update" } })
      .eq("id", ids.sessionA)
      .select("id");
    report.ownershipTrace.push({
      assertion: "user_b_direct_rls_update_user_a_denied",
      method: "PATCH",
      endpoint: "/rest/v1/max_research_sessions",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedDenied: true,
      actualDenied: Boolean(
        updateOtherUserSessionAsB.error || updateOtherUserSessionAsB.data.length === 0,
      ),
      errorCode: updateOtherUserSessionAsB.error?.code,
      returnedRows: updateOtherUserSessionAsB.data?.length ?? 0,
    });
    assert(
      updateOtherUserSessionAsB.error || updateOtherUserSessionAsB.data.length === 0,
      "User B unexpectedly updated User A's session through PostgREST",
    );
    failedAt = "direct RLS User B DELETE of User A session is denied";
    const deleteOtherUserSessionAsB = await authClientB
      .schema("research")
      .from("max_research_sessions")
      .delete()
      .eq("id", ids.sessionA)
      .select("id");
    report.ownershipTrace.push({
      assertion: "user_b_direct_rls_delete_user_a_denied",
      method: "DELETE",
      endpoint: "/rest/v1/max_research_sessions",
      authenticatedUserHash: shortIdHash(userBId),
      resourceIdHash: shortIdHash(ids.sessionA),
      expectedDenied: true,
      actualDenied: Boolean(
        deleteOtherUserSessionAsB.error || deleteOtherUserSessionAsB.data.length === 0,
      ),
      errorCode: deleteOtherUserSessionAsB.error?.code,
      returnedRows: deleteOtherUserSessionAsB.data?.length ?? 0,
    });
    assert(
      deleteOtherUserSessionAsB.error || deleteOtherUserSessionAsB.data.length === 0,
      "User B unexpectedly deleted User A's session through PostgREST",
    );
    failedAt = "direct RLS User A UPDATE of User B session is denied";
    const updateOtherUserSessionAsA = await authClientA
      .schema("research")
      .from("max_research_sessions")
      .update({ owner_id: userAId, data: { ...sessionB, question: "forbidden reverse update" } })
      .eq("id", ids.sessionB)
      .select("id");
    report.ownershipTrace.push({
      assertion: "user_a_direct_rls_update_user_b_denied",
      method: "PATCH",
      endpoint: "/rest/v1/max_research_sessions",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedDenied: true,
      actualDenied: Boolean(
        updateOtherUserSessionAsA.error || updateOtherUserSessionAsA.data.length === 0,
      ),
      errorCode: updateOtherUserSessionAsA.error?.code,
      returnedRows: updateOtherUserSessionAsA.data?.length ?? 0,
    });
    assert(
      updateOtherUserSessionAsA.error || updateOtherUserSessionAsA.data.length === 0,
      "User A unexpectedly updated User B's session through PostgREST",
    );
    failedAt = "direct RLS User A DELETE of User B session is denied";
    const deleteOtherUserSessionAsA = await authClientA
      .schema("research")
      .from("max_research_sessions")
      .delete()
      .eq("id", ids.sessionB)
      .select("id");
    report.ownershipTrace.push({
      assertion: "user_a_direct_rls_delete_user_b_denied",
      method: "DELETE",
      endpoint: "/rest/v1/max_research_sessions",
      authenticatedUserHash: shortIdHash(userAId),
      resourceIdHash: shortIdHash(ids.sessionB),
      expectedDenied: true,
      actualDenied: Boolean(
        deleteOtherUserSessionAsA.error || deleteOtherUserSessionAsA.data.length === 0,
      ),
      errorCode: deleteOtherUserSessionAsA.error?.code,
      returnedRows: deleteOtherUserSessionAsA.data?.length ?? 0,
    });
    assert(
      deleteOtherUserSessionAsA.error || deleteOtherUserSessionAsA.data.length === 0,
      "User A unexpectedly deleted User B's session through PostgREST",
    );
    failedAt = "verify User A session unchanged after cross-user RLS attempts";
    assert.equal(
      (
        await withAuthenticatedUser({ userId: userAId, accessToken: accessTokenA }, () =>
          store!.get(ids.sessionA),
        )
      )?.question,
      sessionA.question,
    );
    failedAt = "verify User B session unchanged after cross-user RLS attempts";
    assert.deepEqual(
      await withAuthenticatedUser({ userId: userBId, accessToken: accessTokenB }, () =>
        store!.get(ids.sessionB),
      ),
      sessionB,
    );

    failedAt = "read admin ownership rows for both temporary sessions";
    const [sessionOwnerA, sessionOwnerB] = await Promise.all([
      lookupResearchSessionOwner(admin, ids.sessionA),
      lookupResearchSessionOwner(admin, ids.sessionB),
    ]);
    report.databaseOwnership = {
      query: {
        schema: "research",
        table: "max_research_sessions",
        select: "owner_id",
        filter: "id = exact temporary session ID",
        cardinality: "maybeSingle",
      },
      userA: {
        resourceIdHash: shortIdHash(ids.sessionA),
        expectedOwnerHash: shortIdHash(userAId),
        actualOwnerHash: sessionOwnerA.ownerId ? shortIdHash(sessionOwnerA.ownerId) : undefined,
        ownerMatches: sessionOwnerA.ownerId === userAId,
        queryError: summarizeOwnershipLookupError(sessionOwnerA.error),
      },
      userB: {
        resourceIdHash: shortIdHash(ids.sessionB),
        expectedOwnerHash: shortIdHash(userBId),
        actualOwnerHash: sessionOwnerB.ownerId ? shortIdHash(sessionOwnerB.ownerId) : undefined,
        ownerMatches: sessionOwnerB.ownerId === userBId,
        queryError: summarizeOwnershipLookupError(sessionOwnerB.error),
      },
    };
    failedAt = "verify admin ownership lookup returned no errors";
    assert.equal(sessionOwnerA.error, null);
    assert.equal(sessionOwnerB.error, null);
    failedAt = "verify User A session owner_id matches authenticated User A";
    assert.equal(sessionOwnerA.ownerId, userAId);
    failedAt = "verify User B session owner_id matches authenticated User B";
    assert.equal(sessionOwnerB.ownerId, userBId);
    report.checks.httpResearchOwnership = true;

    failedAt = "verify authenticated Fastify quota operations and pre-provider rejection";
    const quotaWindowSeconds = 604800;
    const readQuotaUsage = async () => {
      const { data, error } = await researchAdmin
        .from("max_user_quota_windows")
        .select("user_id, quota_key, used")
        .in("user_id", [userAId, userBId])
        .eq("quota_key", "research");
      if (error || !Array.isArray(data)) {
        throw new Error("Could not read quota usage for the exact temporary users");
      }
      const usage = new Map(
        data.map((row: { user_id: string; used: number }) => [row.user_id, Number(row.used)]),
      );
      return {
        userAUsed: usage.get(userAId) ?? 0,
        userBUsed: usage.get(userBId) ?? 0,
      };
    };
    const postDirectChat = (accessToken: string, spoofedUserId: string) =>
      originalFetch(`${apiOrigin}/api/chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: "Explain JavaScript closures simply",
          user_id: spoofedUserId,
        }),
        signal: AbortSignal.timeout(10_000),
      });

    const providerCallsBeforeUserA = providerCalls;
    const userAAllowedResponse = await postDirectChat(accessTokenA, userBId);
    const userAAllowedCapture = await captureApiResponse(userAAllowedResponse);
    const userAAllowedBody = userAAllowedCapture.body as
      { answer?: string; route?: string } | undefined;
    failedAt = "User A first authenticated Fastify quota operation is allowed";
    assert.equal(userAAllowedCapture.summary.status, 200);
    assert.equal(userAAllowedBody?.route, "direct");
    assert.equal(typeof userAAllowedBody?.answer, "string");
    const usageAfterUserAAllowed = await readQuotaUsage();
    failedAt = "User A first Fastify quota operation is recorded against authenticated User A";
    assert.deepEqual(usageAfterUserAAllowed, { userAUsed: 1, userBUsed: 0 });

    const providerCallsBeforeQuotaRejection = providerCalls;
    const quotaResponse = await postDirectChat(accessTokenA, userBId);
    const quotaCapture = await captureApiResponse(quotaResponse);
    const quotaResponseBody = quotaCapture.body as { used?: number; limit?: number } | undefined;
    const providerCallsAfterRequest = providerCalls;
    failedAt = "Fastify rejects User A after quota exhaustion with HTTP 429";
    assert.equal(quotaCapture.summary.status, 429);
    failedAt = "Fastify quota rejection returned a valid response body";
    assert(quotaResponseBody, "Fastify quota response body was not JSON");
    failedAt = "Fastify quota response reports one consumed unit and configured limit";
    assert.equal(quotaResponseBody.used, 1);
    assert.equal(quotaResponseBody.limit, 1);
    const usageAfterRejectedRequest = await readQuotaUsage();
    report.quotaTrace = {
      limit: 1,
      windowSeconds: quotaWindowSeconds,
      usageAfterRejectedRequest,
    };
    failedAt = "quota remains exhausted after rejected request";
    assert.deepEqual(usageAfterRejectedRequest, { userAUsed: 1, userBUsed: 0 });
    assert.equal(providerCalls, providerCallsBeforeQuotaRejection);
    assert(providerCallsBeforeQuotaRejection > providerCallsBeforeUserA);
    report.providerCallsAfterQuotaDenial = providerCalls - providerCallsBeforeQuotaRejection;

    const providerCallsBeforeUserB = providerCalls;
    const userBAllowedResponse = await postDirectChat(accessTokenB, userAId);
    const userBAllowedCapture = await captureApiResponse(userBAllowedResponse);
    const userBAllowedBody = userBAllowedCapture.body as
      { answer?: string; route?: string } | undefined;
    failedAt = "User B has an independent authenticated Fastify quota allowance";
    assert.equal(userBAllowedCapture.summary.status, 200);
    assert.equal(userBAllowedBody?.route, "direct");
    assert.equal(typeof userBAllowedBody?.answer, "string");
    const usageAfterUserBAllowed = await readQuotaUsage();
    failedAt = "User B usage is independent of exhausted User A quota";
    assert.deepEqual(usageAfterUserBAllowed, { userAUsed: 1, userBUsed: 1 });
    assert.equal(searchCalls, 0);
    report.quotaTrace = {
      limit: 1,
      windowSeconds: quotaWindowSeconds,
      httpOperations: [
        {
          userHash: shortIdHash(userAId),
          attempt: 1,
          expectedStatus: 200,
          actualStatus: userAAllowedCapture.summary.status,
          spoofedBodyUserId: true,
          usageAfter: usageAfterUserAAllowed,
        },
        {
          userHash: shortIdHash(userAId),
          attempt: 2,
          expectedStatus: 429,
          actualStatus: quotaCapture.summary.status,
          spoofedBodyUserId: true,
          usageAfter: usageAfterRejectedRequest,
          providerCallsBefore: providerCallsBeforeQuotaRejection,
          providerCallsAfter: providerCallsAfterRequest,
          providerCallsDelta: providerCallsAfterRequest - providerCallsBeforeQuotaRejection,
          responseShape: quotaCapture.summary.bodyShape,
        },
        {
          userHash: shortIdHash(userBId),
          attempt: 1,
          expectedStatus: 200,
          actualStatus: userBAllowedCapture.summary.status,
          spoofedBodyUserId: true,
          usageAfter: usageAfterUserBAllowed,
          providerCallsDelta: providerCalls - providerCallsBeforeUserB,
        },
      ],
      providerInstrumentation: {
        mockedLlmCalls,
        searchCalls,
        realPaidProviderCalls: 0,
      },
    };
    report.checks.quotaIsolationAndEnforcement = true;
    report.status = "PASSED";
  } catch (error) {
    report.failedAt = failedAt;
    if (
      error &&
      typeof error === "object" &&
      (error as Record<string, unknown>).code === "ERR_ASSERTION"
    ) {
      const assertion = error as Record<string, unknown>;
      report.assertion = {
        stage: failedAt,
        operator: typeof assertion.operator === "string" ? assertion.operator : undefined,
        expected: safeAssertionValue(assertion.expected),
        actual: safeAssertionValue(assertion.actual),
      };
    }
    report.errors.push(formatAuthSmokeError(error));
  } finally {
    deadline = cleanupDeadline;
    const cleanupErrors: string[] = [];
    try {
      if (api) {
        await api
          .close()
          .catch(() => cleanupErrors.push("Could not close the temporary API server"));
      }

      const attemptCleanup = async (
        message: string,
        operation: () => PromiseLike<{ error?: unknown }>,
      ) => {
        try {
          const result = await operation();
          if (result.error) cleanupErrors.push(message);
        } catch {
          cleanupErrors.push(message);
        }
      };

      for (const [client, userId] of [
        [authClientA, ids.userA],
        [authClientB, ids.userB],
      ] as const) {
        if (!userId) continue;
        await attemptCleanup("Could not revoke a temporary auth session", async () => {
          const { error } = await client.auth.signOut({ scope: "global" });
          return { error };
        });
      }

      for (const id of [ids.sessionA, ids.sessionB]) {
        await attemptCleanup("Could not delete a temporary research session row", () =>
          researchAdmin.from("max_research_sessions").delete().eq("id", id),
        );
      }

      try {
        await cleanupTemporaryAuthUsers(
          admin.auth.admin,
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY,
          Object.values(emails),
          [ids.userA, ids.userB],
        );
      } catch {
        cleanupErrors.push("Could not delete and verify temporary Auth fixtures");
      }

      const [sessions, quotaRows, users] = await Promise.all([
        researchAdmin
          .from("max_research_sessions")
          .select("id")
          .in("id", [ids.sessionA, ids.sessionB]),
        researchAdmin
          .from("max_user_quota_windows")
          .select("user_id")
          .in("user_id", [ids.userA, ids.userB].filter(Boolean)),
        Promise.all(
          [ids.userA, ids.userB]
            .filter((id): id is string => Boolean(id))
            .map((id) => admin.auth.admin.getUserById(id)),
        ),
      ]);
      const responses = [sessions, quotaRows];
      if (responses.some((response) => response.error)) {
        cleanupErrors.push("Cleanup verification query failed");
      } else if (
        responses.some((response) => response.data?.length !== 0) ||
        users.some(
          (response) =>
            response.data?.user ||
            (response.error && (response.error as { status?: number }).status !== 404),
        )
      ) {
        cleanupErrors.push("Temporary auth or persistence fixtures remain");
      }
    } catch {
      cleanupErrors.push("Temporary cleanup or cleanup verification could not complete");
    } finally {
      globalThis.fetch = originalFetch;
    }

    report.cleanupVerified = cleanupErrors.length === 0;
    if (cleanupErrors.length > 0) {
      report.status = "FAILED";
      report.errors.push(...cleanupErrors);
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    const directory = join(process.cwd(), "evaluation-results");
    mkdirSync(directory, { recursive: true });
    const reportFile = join(directory, `auth-smoke-report-${startedAt.replace(/[:.]/g, "-")}.json`);
    report.reportFile = reportFile;
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    globalThis.fetch = originalFetch;
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASSED" || !report.cleanupVerified) process.exitCode = 1;
}

main().catch((error) => {
  console.error(formatAuthSmokeError(error));
  process.exitCode = 1;
});
