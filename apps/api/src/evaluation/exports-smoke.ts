import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import type { ResearchSession, Source } from "../domain.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { config } from "../config.js";
import { InMemoryDurableJobStore } from "../jobs.js";
import { extractPdf } from "../pdf.js";
import { createServer } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
  findTemporaryAuthUserIds,
} from "./auth-smoke-cleanup.js";
import { safeErrorSummary } from "./safe-error-summary.js";

const WORK_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_PATH = join(process.cwd(), "evaluation-results", "exports-smoke-report.json");

interface ExportsSmokeReport {
  status: "PASSED" | "FAILED";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  failedAt?: string;
  failure?: { name: string; message?: string };
  checks: Record<string, boolean>;
  temporaryUserIds: string[];
  temporarySessionId: string;
  temporaryExportIds: string[];
  temporaryShareId?: string;
  apiRequests: number;
  authRequests: number;
  searchProviderCalls: number;
  openRouterCalls: number;
  cleanup: {
    exportsRemoved: boolean;
    sharesRemoved: boolean;
    researchSessionsRemoved: boolean;
    usersRemoved: boolean;
    zeroTemporaryRows: boolean;
  };
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function boundedFetch(fetchImplementation: typeof fetch, deadline: () => number): typeof fetch {
  return async (input, init = {}) => {
    const remainingMs = deadline() - Date.now();
    if (remainingMs <= 0) throw new Error("Exports smoke exceeded its bounded deadline");
    const signals = [AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs))];
    if (input instanceof Request && input.signal) signals.push(input.signal);
    if (init.signal) signals.push(init.signal);
    return fetchImplementation(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

function fixtureSession(id: string): ResearchSession {
  const createdAt = new Date().toISOString();
  const source: Source = {
    id: `export-source-${randomUUID()}`,
    title: "Official export verification source",
    url: "https://example.org/max-exports-verification",
    snippet: "This search snippet must not be copied into the export.",
    domain: "example.org",
    sourceType: "documentation",
    content: "PRIVATE_EXPORT_SMOKE_FETCHED_BODY_SENTINEL",
    fetchedAt: createdAt,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
  return {
    id,
    question: "How does MAX preserve cited evidence in a saved research result?",
    mode: "quick",
    status: "COMPLETED",
    createdAt,
    updatedAt: createdAt,
    sources: [source],
    claims: [
      {
        id: `export-claim-${randomUUID()}`,
        text: "The saved result keeps each finding linked to a cited source.",
        sourceIds: [source.id],
        evidence: "PRIVATE_EXPORT_SMOKE_EVIDENCE_SENTINEL",
        confidence: 1,
        verification: { verdict: "supported" },
      },
    ],
    answer: "MAX keeps each persisted finding connected to a cited source [1].",
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
  let apiRequests = 0;
  const request: typeof fetch = async (input, init) => {
    const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (new URL(inputUrl).pathname.includes("/auth/v1/")) authRequests += 1;
    return boundedRequest(input, init);
  };
  globalThis.fetch = request;

  const suffix = randomUUID();
  const emailA = `max-exports-a-${suffix}@example.com`;
  const emailB = `max-exports-b-${suffix}@example.com`;
  const passwordA = `${randomUUID()}!aA7`;
  const passwordB = `${randomUUID()}!bB8`;
  const sessionId = `exports-smoke-${suffix}`;
  const report: ExportsSmokeReport = {
    status: "FAILED",
    startedAt: new Date(started).toISOString(),
    checks: {},
    temporaryUserIds: [],
    temporarySessionId: sessionId,
    temporaryExportIds: [],
    apiRequests: 0,
    authRequests: 0,
    searchProviderCalls: 0,
    openRouterCalls: 0,
    cleanup: {
      exportsRemoved: true,
      sharesRemoved: true,
      researchSessionsRemoved: true,
      usersRemoved: true,
      zeroTemporaryRows: true,
    },
  };

  const knownUserIds: Array<string | undefined> = [undefined, undefined];
  const accessTokens: Array<string | undefined> = [undefined, undefined];
  const exportIds = new Set<string>();
  let shareId: string | undefined;
  let shareToken: string | undefined;
  let app: FastifyInstance | undefined;
  let store: SupabaseStore | undefined;
  let admin: ReturnType<typeof createClient<any>> | undefined;
  let searchProviderCalls = 0;
  let openRouterCalls = 0;
  let failedAt = "read-only Signova connectivity preflight";

  const writeReport = () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    mkdirSync(join(process.cwd(), "evaluation-results"), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };

  const createApp = async (): Promise<FastifyInstance> =>
    createServer({
      store: store!,
      jobStore: new InMemoryDurableJobStore(),
      authVerifier: new SupabaseAuthVerifier(
        config.SUPABASE_URL!,
        config.SUPABASE_PUBLISHABLE_KEY!,
        undefined,
        request,
      ),
      searchProvider: {
        search: async () => {
          searchProviderCalls += 1;
          throw new Error("Unexpected Serper/search call in Exports smoke");
        },
      },
      llmProvider: new Proxy(
        { enabled: true },
        {
          get(target, property) {
            if (property in target) return target[property as keyof typeof target];
            return async () => {
              openRouterCalls += 1;
              throw new Error("Unexpected OpenRouter call in Exports smoke");
            };
          },
        },
      ) as never,
    });

  try {
    if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY || !config.SUPABASE_PUBLISHABLE_KEY) {
      throw new Error("Exports smoke requires configured Signova Supabase credentials");
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

    failedAt = "create temporary export owner User A";
    const userA = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({ email: emailA, password: passwordA, email_confirm: true }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailA,
      { request, onReconciledUser: (user) => (knownUserIds[0] = user.id) },
    );
    knownUserIds[0] = userA.id;
    const signInA = await authClientA.auth.signInWithPassword({
      email: emailA,
      password: passwordA,
    });
    assert(
      !signInA.error && signInA.data.session?.access_token,
      "Temporary User A could not authenticate",
    );
    accessTokens[0] = signInA.data.session.access_token;

    failedAt = "create temporary isolation User B";
    const userB = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({ email: emailB, password: passwordB, email_confirm: true }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emailB,
      { request, onReconciledUser: (user) => (knownUserIds[1] = user.id) },
    );
    knownUserIds[1] = userB.id;
    const signInB = await authClientB.auth.signInWithPassword({
      email: emailB,
      password: passwordB,
    });
    assert(
      !signInB.error && signInB.data.session?.access_token,
      "Temporary User B could not authenticate",
    );
    accessTokens[1] = signInB.data.session.access_token;
    report.temporaryUserIds = [userA.id, userB.id];
    report.checks.twoTemporaryUsersAuthenticated = true;

    failedAt = "start the real Fastify server with the Signova owner-scoped store";
    app = await createApp();
    report.checks.fastifyStackStarted = true;

    failedAt = "seed and read the completed temporary research fixture as User A";
    const session = fixtureSession(sessionId);
    await withAuthenticatedUser({ userId: userA.id, accessToken: accessTokens[0]! }, () =>
      store!.create(session),
    );
    const ownerFixture = await withAuthenticatedUser(
      { userId: userA.id, accessToken: accessTokens[0]! },
      () => store!.get(sessionId),
    );
    assert(ownerFixture?.status === "COMPLETED", "Owner could not read the persisted fixture");
    report.checks.ownerFixturePersistedAndReadable = true;

    failedAt = "create all three export formats through authenticated Fastify";
    const formatBodies: Record<string, unknown> = {};
    for (const format of ["markdown", "json", "pdf"] as const) {
      const response: InjectResponse = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: authorization(accessTokens[0]!),
        payload: { resourceType: "research_session", resourceId: sessionId, format },
      });
      apiRequests += 1;
      assert.equal(response.statusCode, 201, `Export creation failed for ${format}`);
      const metadata = response.json() as { id?: string; status?: string; downloadUrl?: string };
      assert(metadata.id && metadata.status === "completed" && metadata.downloadUrl);
      exportIds.add(metadata.id);
      formatBodies[format] = metadata;
    }
    report.temporaryExportIds = [...exportIds];
    report.checks.markdownJsonPdfCreated = true;

    failedAt = "download and inspect Markdown, JSON, and PDF exports";
    for (const [format, rawMetadata] of Object.entries(formatBodies)) {
      const metadata = rawMetadata as { id: string; downloadUrl: string; fileName: string };
      const response: InjectResponse = await app.inject({
        method: "GET",
        url: metadata.downloadUrl,
        headers: authorization(accessTokens[0]!),
      });
      apiRequests += 1;
      assert.equal(response.statusCode, 200, `${format} download failed`);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.match(
        String(response.headers["content-disposition"]),
        /^attachment; filename="[A-Za-z0-9._-]+"$/,
      );
      if (format === "markdown") {
        assert.match(
          response.body,
          /MAX keeps each persisted finding connected to a cited source \[1\]/,
        );
        assert.match(response.body, /https:\/\/example\.org\/max-exports-verification/);
        assert(!response.body.includes("PRIVATE_EXPORT_SMOKE_FETCHED_BODY_SENTINEL"));
      } else if (format === "json") {
        const projection = JSON.parse(response.body) as Record<string, unknown>;
        assert.equal(projection.schema, "max.export.v1");
        assert(!response.body.includes("PRIVATE_EXPORT_SMOKE_EVIDENCE_SENTINEL"));
        assert(!response.body.includes("PRIVATE_EXPORT_SMOKE_FETCHED_BODY_SENTINEL"));
      } else {
        assert.equal(response.rawPayload.subarray(0, 5).toString("ascii"), "%PDF-");
        const extracted = await extractPdf(
          response.rawPayload,
          new URL("https://example.org/export.pdf"),
        );
        assert(
          extracted.content.includes(
            "MAX keeps each persisted finding connected to a cited source",
          ),
        );
        assert(extracted.content.includes("https://example.org/max-exports-verification"));
        assert(!extracted.content.includes("PRIVATE_EXPORT_SMOKE_EVIDENCE_SENTINEL"));
      }
    }
    report.checks.ownerDownloadsAndContent = true;

    failedAt = "verify snapshot idempotency and owner-only API/RLS isolation";
    const markdownMetadata = formatBodies.markdown as { id: string; downloadUrl: string };
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: authorization(accessTokens[0]!),
      payload: { resourceType: "research_session", resourceId: sessionId, format: "markdown" },
    });
    apiRequests += 1;
    assert.equal(duplicate.statusCode, 200);
    assert.equal((duplicate.json() as { id: string }).id, markdownMetadata.id);

    const ownerList = await app.inject({
      method: "GET",
      url: "/api/exports",
      headers: authorization(accessTokens[0]!),
    });
    const otherList = await app.inject({
      method: "GET",
      url: "/api/exports",
      headers: authorization(accessTokens[1]!),
    });
    const otherMetadata = await app.inject({
      method: "GET",
      url: `/api/exports/${markdownMetadata.id}`,
      headers: authorization(accessTokens[1]!),
    });
    const otherDownload = await app.inject({
      method: "GET",
      url: markdownMetadata.downloadUrl,
      headers: authorization(accessTokens[1]!),
    });
    const otherDelete = await app.inject({
      method: "DELETE",
      url: `/api/exports/${markdownMetadata.id}`,
      headers: authorization(accessTokens[1]!),
    });
    const crossOwnerCreate = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: authorization(accessTokens[1]!),
      payload: { resourceType: "research_session", resourceId: sessionId, format: "json" },
    });
    apiRequests += 6;
    assert.equal(ownerList.statusCode, 200);
    assert.equal((ownerList.json() as { exports: unknown[] }).exports.length, 3);
    assert.equal((otherList.json() as { exports: unknown[] }).exports.length, 0);
    assert.equal(otherMetadata.statusCode, 404);
    assert.equal(otherDownload.statusCode, 404);
    assert.equal(otherDelete.statusCode, 404);
    assert.equal(crossOwnerCreate.statusCode, 404);

    const directRlsRead = await createClient<any>(
      config.SUPABASE_URL,
      config.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        global: { fetch: createSupabaseFetch(), headers: authorization(accessTokens[1]!) },
      },
    )
      .schema("content")
      .from("max_exports")
      .select("id")
      .eq("id", markdownMetadata.id)
      .maybeSingle();
    assert(
      !directRlsRead.error && directRlsRead.data === null,
      "RLS exposed another owner's export row",
    );
    report.checks.apiAndRlsOwnerIsolation = true;

    failedAt = "verify a public share does not grant export access";
    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: authorization(accessTokens[0]!),
      payload: { resourceType: "research_session", resourceId: sessionId, expiresInDays: 1 },
    });
    apiRequests += 1;
    assert.equal(share.statusCode, 201);
    const shareBody = share.json() as { id?: string; token?: string };
    assert(shareBody.id && shareBody.token);
    shareId = shareBody.id;
    shareToken = shareBody.token;
    const publicRead = await app.inject({ method: "GET", url: `/api/share/${shareToken}` });
    const unauthenticatedDownload = await app.inject({
      method: "GET",
      url: markdownMetadata.downloadUrl,
    });
    apiRequests += 2;
    assert.equal(publicRead.statusCode, 200);
    assert.equal(unauthenticatedDownload.statusCode, 401);
    assert(
      !JSON.stringify(publicRead.json()).includes("PRIVATE_EXPORT_SMOKE_FETCHED_BODY_SENTINEL"),
    );
    report.checks.publicShareDoesNotGrantExportAccess = true;

    failedAt = "restart Fastify and prove persisted export snapshot readback";
    await app.close();
    app = await createApp();
    const afterRestart = await app.inject({
      method: "GET",
      url: `/api/exports/${markdownMetadata.id}`,
      headers: authorization(accessTokens[0]!),
    });
    const downloadAfterRestart = await app.inject({
      method: "GET",
      url: markdownMetadata.downloadUrl,
      headers: authorization(accessTokens[0]!),
    });
    apiRequests += 2;
    assert.equal(afterRestart.statusCode, 200);
    assert.equal((afterRestart.json() as { status: string }).status, "completed");
    assert.equal(downloadAfterRestart.statusCode, 200);
    report.checks.snapshotSurvivedFastifyRestart = true;
    assert.equal(searchProviderCalls, 0);
    assert.equal(openRouterCalls, 0);
    report.checks.noSearchOrModelCalls = true;
    report.status = "PASSED";
  } catch (error) {
    report.failedAt = failedAt;
    report.failure = safeErrorSummary(error);
  } finally {
    requestDeadlineAt = cleanupDeadlineAt;

    if (app && accessTokens[0] && knownUserIds[0]) {
      for (const exportId of exportIds) {
        try {
          const removed = await app.inject({
            method: "DELETE",
            url: `/api/exports/${exportId}`,
            headers: authorization(accessTokens[0]),
          });
          report.apiRequests += 1;
          assert([204, 404].includes(removed.statusCode));
        } catch {
          report.cleanup.exportsRemoved = false;
        }
      }
      if (shareId) {
        try {
          const removed = await app.inject({
            method: "DELETE",
            url: `/api/shares/${shareId}`,
            headers: authorization(accessTokens[0]),
          });
          report.apiRequests += 1;
          assert([204, 404].includes(removed.statusCode));
        } catch {
          report.cleanup.sharesRemoved = false;
        }
      }
      try {
        await withAuthenticatedUser({ userId: knownUserIds[0], accessToken: accessTokens[0] }, () =>
          store?.delete(sessionId),
        );
      } catch {
        report.cleanup.researchSessionsRemoved = false;
      }
    }

    if (admin) {
      if (exportIds.size) {
        try {
          const { error } = await admin
            .schema("content")
            .from("max_exports")
            .delete()
            .in("id", [...exportIds]);
          assert(!error, "Temporary export cleanup failed");
          report.cleanup.exportsRemoved = true;
        } catch {
          report.cleanup.exportsRemoved = false;
        }
      }
      if (shareId) {
        try {
          const { error } = await admin
            .schema("content")
            .from("max_shares")
            .delete()
            .eq("id", shareId);
          assert(!error, "Temporary share cleanup failed");
          report.cleanup.sharesRemoved = true;
        } catch {
          report.cleanup.sharesRemoved = false;
        }
      }
      if (sessionId) {
        try {
          const { error } = await admin
            .schema("research")
            .from("max_research_sessions")
            .delete()
            .eq("id", sessionId);
          assert(!error, "Temporary research fixture cleanup failed");
          report.cleanup.researchSessionsRemoved = true;
        } catch {
          report.cleanup.researchSessionsRemoved = false;
        }
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
        const [remainingExports, remainingShare, remainingSession, remainingUsers] =
          await Promise.all([
            admin
              .schema("content")
              .from("max_exports")
              .select("id")
              .or(
                `resource_id.eq.${sessionId}${knownUserIds.filter(Boolean).length ? `,owner_id.in.(${knownUserIds.filter(Boolean).join(",")})` : ""}`,
              ),
            shareId
              ? admin.schema("content").from("max_shares").select("id").eq("id", shareId)
              : Promise.resolve({ data: [], error: null }),
            admin.schema("research").from("max_research_sessions").select("id").eq("id", sessionId),
            findTemporaryAuthUserIds(
              config.SUPABASE_URL!,
              config.SUPABASE_SECRET_KEY!,
              new Set([emailA.toLowerCase(), emailB.toLowerCase()]),
              request,
            ),
          ]);
        assert(!remainingExports.error && !remainingShare.error && !remainingSession.error);
        report.cleanup.zeroTemporaryRows =
          remainingExports.data.length === 0 &&
          remainingShare.data.length === 0 &&
          remainingSession.data.length === 0 &&
          remainingUsers.length === 0;
      } catch {
        report.cleanup.zeroTemporaryRows = false;
      }
    }

    if (Object.values(report.cleanup).some((cleaned) => !cleaned)) {
      report.status = "FAILED";
      report.failedAt ??= "exact temporary export/user cleanup verification";
    }
    try {
      if (app) await app.close();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "close Fastify smoke instance";
    }
    report.temporaryUserIds = knownUserIds.filter((id): id is string => Boolean(id));
    report.temporaryExportIds = [...exportIds];
    report.temporaryShareId = shareId;
    report.apiRequests = apiRequests;
    report.authRequests = authRequests;
    report.searchProviderCalls = searchProviderCalls;
    report.openRouterCalls = openRouterCalls;
    globalThis.fetch = originalFetch;
    try {
      writeReport();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "write Exports smoke report";
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASSED") process.exitCode = 1;
}

void main();
