import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { ResearchSession } from "../domain.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { createServer } from "../server.js";
import { SupabaseStore, createSupabaseFetch } from "../supabase-store.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
} from "./auth-smoke-cleanup.js";
import { createAuthSmokeFetch, safeAuthSmokeError } from "./auth-smoke-transport.js";

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

function responseShape(value: unknown) {
  if (!value || typeof value !== "object") return { type: value === null ? "null" : typeof value };
  const record = value as Record<string, unknown>;
  return {
    type: Array.isArray(value) ? "array" : "object",
    keys: Object.keys(record).sort(),
    hasId: typeof record.id === "string",
    idHash: typeof record.id === "string" ? shortHash(record.id) : undefined,
  };
}

function makeSession(id: string): ResearchSession {
  const now = new Date().toISOString();
  return {
    id,
    question: "Temporary ownership diagnostic fixture",
    mode: "quick",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    conflicts: [],
    decisions: [],
    steps: [],
    answer: "Temporary fixture; no provider work is involved.",
  };
}

async function main() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY || !config.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Ownership diagnostic requires configured Supabase server credentials.");
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadlineAt = started + 90_000;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const suffix = randomUUID();
  const emailA = `max-auth-owner-a-${suffix}@example.com`;
  const emailB = `max-auth-owner-b-${suffix}@example.com`;
  const passwordA = `${randomUUID()}!aA9`;
  const passwordB = `${randomUUID()}!bB8`;
  const sessionId = randomUUID();
  const userIds: { a?: string; b?: string } = {};
  const observations: Record<string, unknown> = {};
  const events: unknown[] = [];
  const report: Record<string, unknown> = {
    startedAt,
    status: "FAILED",
    sessionIdHash: shortHash(sessionId),
    observations,
    cleanupVerified: false,
    errors: [],
  };
  let stage = "initialize";
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let store: SupabaseStore | undefined;
  let clientA: ReturnType<typeof createClient<any>> | undefined;
  let clientB: ReturnType<typeof createClient<any>> | undefined;

  const boundedFetch = createAuthSmokeFetch({
    fetchImpl: originalFetch,
    deadline: () => deadlineAt,
    onEvent: (event) => events.push(event),
  });
  globalThis.fetch = boundedFetch;
  const clientOptions = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: createSupabaseFetch() },
  };
  const admin = createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, clientOptions);
  clientA = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, clientOptions);
  clientB = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, clientOptions);
  store = new SupabaseStore(
    config.SUPABASE_URL,
    config.SUPABASE_SECRET_KEY,
    undefined,
    config.SUPABASE_PUBLISHABLE_KEY,
  );
  const researchAdmin = admin.schema("research");

  try {
    stage = "start bounded Fastify";
    store.recoverInterrupted = async () => 0;
    store.recoverAutonomousRuns = async () => 0;
    store.listRuns = async () => [];
    api = await createServer({
      store,
      authVerifier: new SupabaseAuthVerifier(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY),
      searchProvider: { search: async () => [] },
    });
    await api.listen({ port: config.PORT, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${config.PORT}`;
    const health = await originalFetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
    observations.fastifyHealth = { status: health.status, expected: 200 };

    stage = "create exactly two temporary users";
    const userA = await createAuthUserWithReconciliation(
      () =>
        admin.auth.admin.createUser({
          email: emailA,
          password: passwordA,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailA,
      {
        request: boundedFetch,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => (userIds.a = user.id),
      },
    );
    userIds.a = userA.id;
    const userB = await createAuthUserWithReconciliation(
      () =>
        admin.auth.admin.createUser({
          email: emailB,
          password: passwordB,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailB,
      {
        request: boundedFetch,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => (userIds.b = user.id),
      },
    );
    userIds.b = userB.id;
    observations.identities = {
      userAHash: shortHash(userIds.a),
      userBHash: shortHash(userIds.b),
      distinct: userIds.a !== userIds.b,
    };

    stage = "authenticate temporary users and verify token identities";
    const signedInA = await clientA.auth.signInWithPassword({ email: emailA, password: passwordA });
    const signedInB = await clientB.auth.signInWithPassword({ email: emailB, password: passwordB });
    if (signedInA.error || !signedInA.data.session || signedInB.error || !signedInB.data.session) {
      throw new Error("A temporary user could not authenticate");
    }
    const tokenA = signedInA.data.session.access_token;
    const tokenB = signedInB.data.session.access_token;
    const verifier = new SupabaseAuthVerifier(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY);
    const verifiedA = await verifier.verifyAccessToken(tokenA);
    const verifiedB = await verifier.verifyAccessToken(tokenB);
    observations.verifiedIdentities = {
      userAHash: verifiedA?.id ? shortHash(verifiedA.id) : undefined,
      userBHash: verifiedB?.id ? shortHash(verifiedB.id) : undefined,
      userAMatchesCreatedUser: verifiedA?.id === userIds.a,
      userBMatchesCreatedUser: verifiedB?.id === userIds.b,
    };

    stage = "create one owner-bound temporary session";
    const session = makeSession(sessionId);
    await withAuthenticatedUser({ userId: userIds.a, accessToken: tokenA }, () =>
      store!.create(session),
    );
    const adminRow = await researchAdmin
      .from("max_research_sessions")
      .select("id,owner_id")
      .eq("id", sessionId)
      .maybeSingle();
    observations.database = {
      queryErrorCode: adminRow.error?.code,
      rowExists: Boolean(adminRow.data),
      sessionIdMatches: adminRow.data?.id === sessionId,
      ownerHash: adminRow.data?.owner_id ? shortHash(adminRow.data.owner_id) : undefined,
      ownerMatchesA: adminRow.data?.owner_id === userIds.a,
      ownerMatchesB: adminRow.data?.owner_id === userIds.b,
    };

    stage = "query direct RLS visibility";
    const rlsA = await clientA
      .schema("research")
      .from("max_research_sessions")
      .select("id,owner_id")
      .eq("id", sessionId)
      .maybeSingle();
    const rlsB = await clientB
      .schema("research")
      .from("max_research_sessions")
      .select("id,owner_id")
      .eq("id", sessionId)
      .maybeSingle();
    observations.directRls = {
      userA: {
        errorCode: rlsA.error?.code,
        rowVisible: Boolean(rlsA.data),
        ownerMatchesA: rlsA.data?.owner_id === userIds.a,
      },
      userB: {
        errorCode: rlsB.error?.code,
        rowVisible: Boolean(rlsB.data),
        expectedVisible: false,
      },
    };

    stage = "GET own session through Fastify as User A";
    const ownResponse = await originalFetch(`${origin}/api/research/${sessionId}`, {
      headers: { authorization: `Bearer ${tokenA}` },
      signal: AbortSignal.timeout(10_000),
    });
    const ownText = await ownResponse.text();
    let ownBody: unknown;
    try {
      ownBody = JSON.parse(ownText);
    } catch {
      ownBody = undefined;
    }
    observations.fastifyOwnReadA = {
      method: "GET",
      path: "/api/research/:id",
      authenticatedUserHash: shortHash(userIds.a),
      sessionIdHash: shortHash(sessionId),
      expectedStatus: 200,
      status: ownResponse.status,
      responseShape: responseShape(ownBody),
      bodyMatchesSessionId: (ownBody as { id?: string } | undefined)?.id === sessionId,
      bodyMatchesExpectedSession: isDeepStrictEqual(ownBody, session),
      databaseOwnerMatchesIdentity: adminRow.data?.owner_id === userIds.a,
    };

    stage = "GET User A session through Fastify as User B";
    const foreignResponse = await originalFetch(`${origin}/api/research/${sessionId}`, {
      headers: { authorization: `Bearer ${tokenB}` },
      signal: AbortSignal.timeout(10_000),
    });
    const foreignText = await foreignResponse.text();
    let foreignBody: unknown;
    try {
      foreignBody = JSON.parse(foreignText);
    } catch {
      foreignBody = undefined;
    }
    observations.fastifyForeignReadB = {
      method: "GET",
      path: "/api/research/:id",
      authenticatedUserHash: shortHash(userIds.b),
      sessionIdHash: shortHash(sessionId),
      expectedStatus: 404,
      status: foreignResponse.status,
      responseShape: responseShape(foreignBody),
      recordReturned: (foreignBody as { id?: string } | undefined)?.id === sessionId,
      databaseOwnerMatchesIdentity: adminRow.data?.owner_id === userIds.b,
    };

    const checks = {
      fastifyHealthy: health.status === 200,
      distinctAuthenticatedUsers:
        verifiedA?.id === userIds.a && verifiedB?.id === userIds.b && userIds.a !== userIds.b,
      databaseRowOwnedByA:
        adminRow.error === null &&
        adminRow.data?.id === sessionId &&
        adminRow.data?.owner_id === userIds.a,
      directRlsAReadsOwn:
        !rlsA.error && rlsA.data?.id === sessionId && rlsA.data.owner_id === userIds.a,
      directRlsBDeniesA: !rlsB.error && rlsB.data === null,
      fastifyAReadsOwn:
        ownResponse.status === 200 && (ownBody as { id?: string } | undefined)?.id === sessionId,
      fastifyBDeniesA: foreignResponse.status === 404,
    };
    report.checks = checks;
    report.status = Object.values(checks).every(Boolean) ? "PASSED" : "FAILED";
    if (report.status === "FAILED") {
      (report.errors as string[]).push(
        "One or more recorded ownership checks did not match expectations.",
      );
    }
  } catch (error) {
    report.failedAt = stage;
    (report.errors as unknown[]).push(
      safeAuthSmokeError(error, [emailA, emailB, passwordA, passwordB]),
    );
  } finally {
    try {
      if (api) await api.close();
    } catch {
      (report.errors as string[]).push("Fastify shutdown failed");
    }

    const cleanupErrors: string[] = [];
    try {
      for (const client of [clientA, clientB]) {
        if (!client) continue;
        const { error } = await client.auth.signOut({ scope: "global" });
        if (error) cleanupErrors.push("A temporary Auth session could not be revoked");
      }
      const { error: sessionDeleteError } = await researchAdmin
        .from("max_research_sessions")
        .delete()
        .eq("id", sessionId);
      if (sessionDeleteError) cleanupErrors.push("The temporary session row could not be deleted");
      await cleanupTemporaryAuthUsers(
        admin.auth.admin,
        config.SUPABASE_URL,
        config.SUPABASE_SECRET_KEY,
        [emailA, emailB],
        [userIds.a, userIds.b],
        boundedFetch,
      );
      const verifyRow = await researchAdmin
        .from("max_research_sessions")
        .select("id")
        .eq("id", sessionId)
        .maybeSingle();
      if (verifyRow.error || verifyRow.data)
        cleanupErrors.push("The temporary session row remains");
      report.cleanupVerified = cleanupErrors.length === 0;
    } catch {
      cleanupErrors.push("Temporary Auth/session cleanup or exact-identity verification failed");
      report.cleanupVerified = false;
    }
    if (cleanupErrors.length) (report.errors as string[]).push(...cleanupErrors);
    globalThis.fetch = originalFetch;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    report.transportEvents = events;
    const directory = join(process.cwd(), "evaluation-results");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "auth-ownership-diagnostic.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASSED" || !report.cleanupVerified) process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeAuthSmokeError(error));
  process.exitCode = 1;
});
