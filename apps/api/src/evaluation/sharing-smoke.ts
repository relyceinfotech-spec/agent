import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { ResearchSession } from "../domain.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { config } from "../config.js";
import { InMemoryDurableJobStore } from "../jobs.js";
import { createServer } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
} from "./auth-smoke-cleanup.js";
import { safeErrorSummary } from "./safe-error-summary.js";

const WORK_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_PATH = join(process.cwd(), "evaluation-results", "sharing-smoke-report.json");

interface SharingSmokeReport {
  status: "PASSED" | "FAILED";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  failedAt?: string;
  failure?: { name: string; message?: string };
  checks: Record<string, boolean>;
  temporaryUsersCreated: number;
  authRequests: number;
  apiRequests: number;
  searchProviderCalls: number;
  openRouterCalls: number;
  cleanup: {
    sharesRemoved: boolean;
    researchSessionsRemoved: boolean;
    usersRemoved: boolean;
    zeroTemporaryRows: boolean;
  };
}

function boundedFetch(fetchImplementation: typeof fetch, deadline: () => number): typeof fetch {
  return async (input, init = {}) => {
    const remainingMs = deadline() - Date.now();
    if (remainingMs <= 0) throw new Error("Sharing smoke exceeded its bounded deadline");
    const signals = [AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs))];
    if (input instanceof Request && input.signal) signals.push(input.signal);
    if (init.signal) signals.push(init.signal);
    return fetchImplementation(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function authHeader(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

function fixtureSession(id: string): ResearchSession {
  const now = new Date().toISOString();
  return {
    id,
    question: "How does MAX preserve citations in research results?",
    mode: "quick",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources: [
      {
        id: `source-${randomUUID()}`,
        title: "MAX share smoke source",
        url: "https://example.org/max-sharing-smoke",
        snippet: "This snippet must not be included in the share.",
        domain: "example.org",
        content: "PRIVATE_SHARING_SMOKE_SOURCE_BODY",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      },
    ],
    claims: [],
    answer: "The result preserves its citation attribution [1].",
    steps: [],
  };
}

async function main() {
  const started = Date.now();
  const workDeadlineAt = started + WORK_TIMEOUT_MS;
  const cleanupDeadlineAt = started + TOTAL_TIMEOUT_MS;
  let requestDeadlineAt = workDeadlineAt;
  const originalFetch = globalThis.fetch;
  const boundedRequest = boundedFetch(originalFetch.bind(globalThis), () => requestDeadlineAt);
  let authRequests = 0;
  const request: typeof fetch = async (input, init) => {
    const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (new URL(inputUrl).pathname.includes("/auth/v1/")) authRequests += 1;
    return boundedRequest(input, init);
  };
  globalThis.fetch = request;

  const suffix = randomUUID();
  const emailA = `max-sharing-a-${suffix}@example.com`;
  const emailB = `max-sharing-b-${suffix}@example.com`;
  const passwordA = `${randomUUID()}!aA7`;
  const passwordB = `${randomUUID()}!bB8`;
  const sessionId = `sharing-smoke-${suffix}`;
  const report: SharingSmokeReport = {
    status: "FAILED",
    startedAt: new Date(started).toISOString(),
    checks: {},
    temporaryUsersCreated: 0,
    authRequests: 0,
    apiRequests: 0,
    searchProviderCalls: 0,
    openRouterCalls: 0,
    cleanup: {
      sharesRemoved: true,
      researchSessionsRemoved: true,
      usersRemoved: true,
      zeroTemporaryRows: true,
    },
  };

  const knownUserIds: Array<string | undefined> = [undefined, undefined];
  const accessTokens: Array<string | undefined> = [undefined, undefined];
  let shareId: string | undefined;
  let shareToken: string | undefined;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  let store: SupabaseStore | undefined;
  let admin: ReturnType<typeof createClient<any>> | undefined;
  let searchProviderCalls = 0;
  let openRouterCalls = 0;
  let failedAt = "read-only Supabase connectivity preflight";

  const writeReport = () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    mkdirSync(join(process.cwd(), "evaluation-results"), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };

  try {
    if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY || !config.SUPABASE_PUBLISHABLE_KEY) {
      throw new Error("Sharing smoke requires configured Signova Supabase credentials");
    }
    const preflight = await request(`${config.SUPABASE_URL}/auth/v1/health`, {
      method: "GET",
      headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY, "accept-encoding": "identity" },
    });
    assert(preflight.ok, `Supabase Auth health returned HTTP ${preflight.status}`);
    report.checks.readOnlySupabasePreflight = true;

    admin = createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: createSupabaseFetch() },
    });
    store = new SupabaseStore(
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      undefined,
      config.SUPABASE_PUBLISHABLE_KEY,
    );
    store.recoverInterrupted = async () => 0;
    store.recoverAutonomousRuns = async () => 0;
    store.listRuns = async () => [];

    const authClientA = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: createSupabaseFetch() },
    });
    const authClientB = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: createSupabaseFetch() },
    });

    const llmProvider = new Proxy(
      { enabled: true },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => {
            openRouterCalls += 1;
            throw new Error("Unexpected OpenRouter call in sharing smoke");
          };
        },
      },
    ) as never;

    app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      authVerifier: new SupabaseAuthVerifier(
        config.SUPABASE_URL,
        config.SUPABASE_PUBLISHABLE_KEY,
        undefined,
        request,
      ),
      searchProvider: {
        search: async () => {
          searchProviderCalls += 1;
          throw new Error("Unexpected Serper/search call in sharing smoke");
        },
      },
      llmProvider,
    });
    report.checks.fastifyStackCreated = true;

    failedAt = "create temporary authenticated User A";
    const userA = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({ email: emailA, password: passwordA, email_confirm: true }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailA,
      {
        request,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          knownUserIds[0] = user.id;
        },
      },
    );
    knownUserIds[0] = userA.id;
    report.temporaryUsersCreated += 1;
    const signInA = await authClientA.auth.signInWithPassword({
      email: emailA,
      password: passwordA,
    });
    assert(
      !signInA.error && signInA.data.session?.access_token,
      "Temporary User A could not authenticate",
    );
    accessTokens[0] = signInA.data.session.access_token;

    failedAt = "create temporary authenticated User B";
    const userB = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({ email: emailB, password: passwordB, email_confirm: true }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailB,
      {
        request,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          knownUserIds[1] = user.id;
        },
      },
    );
    knownUserIds[1] = userB.id;
    report.temporaryUsersCreated += 1;
    const signInB = await authClientB.auth.signInWithPassword({
      email: emailB,
      password: passwordB,
    });
    assert(
      !signInB.error && signInB.data.session?.access_token,
      "Temporary User B could not authenticate",
    );
    accessTokens[1] = signInB.data.session.access_token;
    report.checks.twoTemporaryUsersAuthenticated = true;

    failedAt = "create temporary completed owner-scoped research fixture";
    const session = fixtureSession(sessionId);
    await withAuthenticatedUser({ userId: userA.id, accessToken: accessTokens[0]! }, () =>
      store!.create(session),
    );
    const ownerRead = await withAuthenticatedUser(
      { userId: userA.id, accessToken: accessTokens[0]! },
      () => store!.get(sessionId),
    );
    assert(ownerRead?.status === "COMPLETED", "The owner could not read the temporary result");
    report.checks.ownerResearchFixtureCreatedAndRead = true;

    failedAt = "create a share through authenticated Fastify";
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authHeader(accessTokens[0]!),
      payload: { resourceType: "research_session", resourceId: sessionId, expiresInDays: 1 },
    });
    report.apiRequests += 1;
    assert.equal(created.statusCode, 201, "Fastify share creation did not return HTTP 201");
    const createdBody = created.json() as { id?: string; token?: string; url?: string };
    assert(typeof createdBody.id === "string" && typeof createdBody.token === "string");
    assert.match(createdBody.token, /^[A-Za-z0-9_-]{43}$/);
    assert(createdBody.url?.includes(createdBody.token));
    shareId = createdBody.id;
    shareToken = createdBody.token;
    report.checks.ownerCreatedShare = true;

    failedAt = "read share metadata through the owner API and verify token hash storage";
    const ownerList = await app.inject({
      method: "GET",
      url: "/api/shares",
      headers: authHeader(accessTokens[0]!),
    });
    report.apiRequests += 1;
    assert.equal(ownerList.statusCode, 200);
    const ownerRows = ownerList.json() as Array<Record<string, unknown>>;
    assert(ownerRows.some((row) => row.id === shareId));
    assert(!JSON.stringify(ownerRows).includes(shareToken));
    assert(!JSON.stringify(ownerRows).includes("tokenHash"));
    const storedShare = await admin
      .schema("content")
      .from("max_shares")
      .select("id,owner_id,resource_type,resource_id,token_hash,expires_at")
      .eq("id", shareId)
      .maybeSingle();
    assert(
      !storedShare.error && storedShare.data,
      "Share row could not be read back independently",
    );
    assert.equal(storedShare.data.owner_id, userA.id);
    assert.equal(storedShare.data.token_hash.length, 64);
    assert.notEqual(storedShare.data.token_hash, shareToken);
    report.checks.tokenHashOnlyPersistence = true;
    report.checks.ownerReadback = true;

    failedAt = "verify the second owner's RLS and API isolation";
    const otherList = await app.inject({
      method: "GET",
      url: "/api/shares",
      headers: authHeader(accessTokens[1]!),
    });
    const otherDelete = await app.inject({
      method: "DELETE",
      url: `/api/shares/${shareId}`,
      headers: authHeader(accessTokens[1]!),
    });
    report.apiRequests += 2;
    assert.equal(otherList.statusCode, 200);
    assert.deepEqual(otherList.json(), []);
    assert.equal(otherDelete.statusCode, 404);
    const directRlsRead = await createClient<any>(
      config.SUPABASE_URL,
      config.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        global: {
          fetch: createSupabaseFetch(),
          headers: { Authorization: `Bearer ${accessTokens[1]!}` },
        },
      },
    )
      .schema("content")
      .from("max_shares")
      .select("id")
      .eq("id", shareId)
      .maybeSingle();
    assert(
      !directRlsRead.error && directRlsRead.data === null,
      "RLS exposed another owner's share",
    );
    report.checks.ownerIsolationAndRls = true;

    failedAt = "read the public share and check the allowlisted projection";
    const publicRead = await app.inject({ method: "GET", url: `/api/share/${shareToken}` });
    report.apiRequests += 1;
    assert.equal(publicRead.statusCode, 200);
    const shared = publicRead.json() as Record<string, unknown>;
    assert.equal(shared.type, "research");
    assert.equal(shared.answer, "The result preserves its citation attribution [1].");
    assert(!JSON.stringify(shared).includes(userA.id));
    assert(!JSON.stringify(shared).includes(sessionId));
    assert(!JSON.stringify(shared).includes("PRIVATE_SHARING_SMOKE_SOURCE_BODY"));
    assert(!JSON.stringify(shared).includes("snippet"));
    assert(!JSON.stringify(shared).includes("tokenHash"));
    report.checks.publicReadAndRedaction = true;

    failedAt = "revoke the share and verify public access stops immediately";
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/shares/${shareId}`,
      headers: authHeader(accessTokens[0]!),
    });
    report.apiRequests += 1;
    assert.equal(revoked.statusCode, 204);
    const publicAfterRevoke = await app.inject({ method: "GET", url: `/api/share/${shareToken}` });
    report.apiRequests += 1;
    assert.equal(publicAfterRevoke.statusCode, 404);
    const ownerAfterRevoke = await app.inject({
      method: "GET",
      url: "/api/shares",
      headers: authHeader(accessTokens[0]!),
    });
    report.apiRequests += 1;
    const revokedOwnerRow = (ownerAfterRevoke.json() as Array<Record<string, unknown>>).find(
      (row) => row.id === shareId,
    );
    assert(revokedOwnerRow && typeof revokedOwnerRow.revokedAt === "string");
    assert(typeof revokedOwnerRow.lastAccessedAt === "string");
    report.checks.ownerRevocationAndPostRevokeFailure = true;
    report.status = "PASSED";
  } catch (error) {
    report.failedAt = failedAt;
    report.failure = safeErrorSummary(error);
  } finally {
    requestDeadlineAt = cleanupDeadlineAt;

    if (app && accessTokens[0]) {
      try {
        await withAuthenticatedUser(
          { userId: knownUserIds[0]!, accessToken: accessTokens[0] },
          () => store?.delete(sessionId),
        );
        report.cleanup.researchSessionsRemoved = true;
      } catch {
        report.cleanup.researchSessionsRemoved = false;
      }
    }
    if (admin) {
      try {
        if (shareId) {
          const { error } = await admin
            .schema("content")
            .from("max_shares")
            .delete()
            .eq("id", shareId);
          assert(!error, "Temporary share cleanup failed");
        }
        report.cleanup.sharesRemoved = true;
      } catch {
        report.cleanup.sharesRemoved = false;
      }
    }

    if (admin && config.SUPABASE_URL && config.SUPABASE_SECRET_KEY) {
      try {
        await cleanupTemporaryAuthUsers(
          admin.auth.admin,
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY,
          [emailA, emailB],
          knownUserIds,
          request,
        );
        report.cleanup.usersRemoved = true;
      } catch {
        report.cleanup.usersRemoved = false;
      }
    }

    if (admin) {
      try {
        const [remainingShare, remainingSession, remainingOwnerShares, remainingOwnerSessions] =
          await Promise.all([
            shareId
              ? admin.schema("content").from("max_shares").select("id").eq("id", shareId)
              : Promise.resolve({ data: [], error: null }),
            admin.schema("research").from("max_research_sessions").select("id").eq("id", sessionId),
            knownUserIds.filter(Boolean).length
              ? admin
                  .schema("content")
                  .from("max_shares")
                  .select("id")
                  .in("owner_id", knownUserIds.filter(Boolean))
              : Promise.resolve({ data: [], error: null }),
            knownUserIds.filter(Boolean).length
              ? admin
                  .schema("research")
                  .from("max_research_sessions")
                  .select("id")
                  .in("owner_id", knownUserIds.filter(Boolean))
              : Promise.resolve({ data: [], error: null }),
          ]);
        const responses = [
          remainingShare,
          remainingSession,
          remainingOwnerShares,
          remainingOwnerSessions,
        ];
        assert(responses.every((response) => !response.error));
        report.cleanup.zeroTemporaryRows = responses.every(
          (response) => Array.isArray(response.data) && response.data.length === 0,
        );
      } catch {
        report.cleanup.zeroTemporaryRows = false;
      }
    }

    if (Object.values(report.cleanup).some((cleaned) => !cleaned)) {
      report.status = "FAILED";
      report.failedAt ??= "independent temporary-row/user cleanup verification";
    }

    try {
      if (app) await app.close();
      else store?.close();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "close Fastify smoke instance";
    }
    report.searchProviderCalls = searchProviderCalls;
    report.openRouterCalls = openRouterCalls;
    report.authRequests = authRequests;
    report.temporaryUsersCreated = Math.max(
      report.temporaryUsersCreated,
      knownUserIds.filter(Boolean).length,
    );
    globalThis.fetch = originalFetch;
    try {
      writeReport();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "write Sharing smoke report";
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASSED") process.exitCode = 1;
}

void main();
