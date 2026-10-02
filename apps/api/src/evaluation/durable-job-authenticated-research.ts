import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { SupabaseAuthVerifier } from "../auth.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { config } from "../config.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingUsage,
} from "../embeddings.js";
import { createIdempotentJobId } from "../jobs.js";
import { OpenRouterProvider } from "../llm.js";
import { UserMemoryService } from "../memory.js";
import type { UserMemorySearchResult } from "../memory-domain.js";
import { QuotaPolicy } from "../quota-policy.js";
import { createServer } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import { evaluatePostQuality, postFromResearch } from "../post-quality.js";
import type { AutonomousRun, TopicCandidate } from "../content-domain.js";
import { auditResearchCitations } from "../llm.js";
import {
  diagnoseMemoryRecall,
  observeMemorySearchMisses,
  parsePostgresVector,
  type MemoryRecallDiagnostic,
} from "./memory-recall-diagnostic.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
  findTemporaryAuthUserIds,
} from "./auth-smoke-cleanup.js";
import { checkLiveNetwork, type LiveNetworkCheckResult } from "./live-network-check.js";

if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY || !config.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Authenticated queue smoke requires the Signova URL and server/client keys");
}
if (!config.SERPER_API_KEY || !config.OPENROUTER_API_KEY) {
  throw new Error("One bounded authenticated research job requires Serper and OpenRouter keys");
}
if (!config.MEMORY_ENABLED || !config.OPENROUTER_API_KEY) {
  throw new Error("The integrated backend smoke requires configured semantic-memory embeddings");
}
if (process.env.MAX_TEMPORARY_PUBLIC_SMOKE_POST_APPROVED !== "1") {
  throw new Error(
    "The authenticated follow-up requires a temporary published post; set MAX_TEMPORARY_PUBLIC_SMOKE_POST_APPROVED=1 only after approving its brief Discover visibility",
  );
}

const supabaseUrl = config.SUPABASE_URL;
const serverKey = config.SUPABASE_SECRET_KEY;
const publishableKey = config.SUPABASE_PUBLISHABLE_KEY;
const email = `max-queue-smoke-${randomUUID()}@example.com`;
const password = `${randomBytes(32).toString("base64url")}!aA9`;
const idempotencyKey = `queue-smoke-${randomUUID()}`;
const rejectedIdempotencyKey = `queue-smoke-quota-${randomUUID()}`;
const memoryText = "For MAX I prefer concise answers with source links.";
const question =
  "Based on what I said about my preferred answer style, investigate current official React release documentation and history; cite sources.";
const serviceFetch = createSupabaseFetch();
const adminClient = createClient<any>(supabaseUrl, serverKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { fetch: serviceFetch },
});
const userClient = createClient<any>(supabaseUrl, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { fetch: serviceFetch },
});
const researchAdmin = adminClient.schema("research");
const productionWorker = fileURLToPath(new URL("../worker.ts", import.meta.url));
const cleanupEmails = [email];
let userId: string | undefined;
let temporaryAccessToken: string | undefined;
let jobId: string | undefined;
let sessionId: string | undefined;
let memoryId: string | undefined;
let topicId: string | undefined;
let postId: string | undefined;
let runId: string | undefined;
let followUpId: string | undefined;
let api: Awaited<ReturnType<typeof createServer>> | undefined;
let retrievalApi: Awaited<ReturnType<typeof createServer>> | undefined;
let worker: ChildProcess | undefined;
let stage = "initialization";
let providerCallsBeforeWorker = 0;
let authCreateAttempted = false;
let networkPreflight: LiveNetworkCheckResult | undefined;

function safeError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: String(value?.name ?? "Error"),
    code: typeof value?.code === "string" ? value.code.slice(0, 80) : undefined,
    message: String(value?.message ?? "Unknown failure")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sb_secret_|sk-or-v1-)[A-Za-z0-9_-]+/gi, "[redacted]")
      .slice(0, 400),
  };
}

async function listenLocal(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Fastify did not bind an ephemeral port");
  return `http://127.0.0.1:${address.port}`;
}

function startProductionWorker(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", productionWorker], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAX_PERSISTENCE_PROVIDER: "supabase",
      MAX_RESEARCH_STEPS: "4",
      MAX_SEARCH_QUERIES: "1",
      MAX_SOURCES: "2",
      MAX_PAGES: "2",
      MAX_RESEARCH_TIME_MS: "90000",
      MAX_MODEL_DECISIONS: "2",
      OPENROUTER_TIMEOUT_MS: "25000",
      EMBEDDING_TIMEOUT_MS: "10000",
      MAX_JOB_WORKER_CONCURRENCY: "1",
      MAX_JOB_LEASE_SECONDS: "45",
      MAX_JOB_POLL_INTERVAL_MS: "200",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (/ExperimentalWarning/.test(text)) return;
    process.stderr.write(text.slice(0, 400));
  });
  return child;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(5000).then(() => {
        throw new Error("Research worker did not stop gracefully");
      }),
    ]);
  } catch {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function waitForTerminal(
  store: SupabaseStore,
  id: string,
): Promise<
  Awaited<ReturnType<SupabaseStore["getJob"]>> extends infer T ? Exclude<T, undefined> : never
> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const job = await store.getJob(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job as never;
    if (worker?.exitCode !== null && worker?.exitCode !== undefined) {
      throw new Error("Production worker exited before the research job reached a terminal state");
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the authenticated research job");
}

async function cleanup(): Promise<void> {
  const failures: string[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      const diagnostic = safeError(error);
      failures.push(
        `${label}: ${diagnostic.name}${diagnostic.code ? `/${diagnostic.code}` : ""} ${diagnostic.message}`,
      );
    }
  };

  if (worker) await attempt("worker stop", () => stopWorker(worker!));

  if (userId && memoryId) {
    const ownerId = userId;
    const ownerMemoryId = memoryId;
    await attempt("memory rows", async () => {
      if (!temporaryAccessToken) {
        throw new Error("Temporary owner token is unavailable for memory cleanup");
      }
      const memoryStore = new SupabaseStore(supabaseUrl, serverKey, undefined, publishableKey);
      const identity = { userId: ownerId, accessToken: temporaryAccessToken };
      try {
        await withAuthenticatedUser(identity, () => memoryStore.deleteUserMemory(ownerMemoryId));
        const remaining = await withAuthenticatedUser(identity, () =>
          memoryStore.getUserMemory(ownerMemoryId),
        );
        if (remaining) throw new Error("Temporary owner memory remains after cleanup");
      } finally {
        await memoryStore.close();
      }
    });
  }

  if (api) {
    await attempt("API close", () => api!.close());
    api = undefined;
  }
  if (retrievalApi) {
    await attempt("retrieval API close", () => retrievalApi!.close());
    retrievalApi = undefined;
  }

  if (!authCreateAttempted) return;

  const contentAdmin = adminClient.schema("content");
  if (followUpId) {
    await attempt("follow-up delete", async () => {
      const { error } = await contentAdmin.from("max_post_followups").delete().eq("id", followUpId);
      if (error) throw error;
    });
  }
  if (postId) {
    await attempt("post follow-ups delete", async () => {
      const { error } = await contentAdmin
        .from("max_post_followups")
        .delete()
        .eq("post_id", postId);
      if (error) throw error;
    });
  }
  if (runId) {
    await attempt("run delete", async () => {
      const { error } = await contentAdmin.from("max_autonomous_runs").delete().eq("id", runId);
      if (error) throw error;
    });
  }
  if (postId) {
    await attempt("post delete", async () => {
      const { error } = await contentAdmin.from("max_posts").delete().eq("id", postId);
      if (error) throw error;
    });
  }
  if (topicId) {
    await attempt("topic delete", async () => {
      const { error } = await contentAdmin.from("max_topics").delete().eq("id", topicId);
      if (error) throw error;
    });
  }

  if (sessionId) {
    await attempt("session delete", async () => {
      const { error } = await researchAdmin
        .from("max_research_sessions")
        .delete()
        .eq("id", sessionId);
      if (error) throw error;
    });
  }
  const jobIds = [
    jobId,
    userId ? createIdempotentJobId(`user:${userId}`, rejectedIdempotencyKey) : undefined,
  ].filter((id): id is string => Boolean(id));
  if (jobIds.length) {
    await attempt("job delete", async () => {
      const { error } = await researchAdmin.from("max_jobs").delete().in("id", jobIds);
      if (error) throw error;
    });
  }
  if (userId) {
    await attempt("quota rows delete", async () => {
      const { error } = await researchAdmin
        .from("max_user_quota_windows")
        .delete()
        .eq("user_id", userId);
      if (error) throw error;
    });
  }

  for (const [schema, table, id] of [
    ["content", "max_post_followups", followUpId],
    ["content", "max_posts", postId],
    ["content", "max_topics", topicId],
    ["content", "max_autonomous_runs", runId],
    ["research", "max_research_sessions", sessionId],
  ] as const) {
    if (!id) continue;
    await attempt(`${table} verify`, async () => {
      const client = schema === "content" ? contentAdmin : researchAdmin;
      const { data, error } = await client.from(table).select("id").eq("id", id);
      if (error || (data ?? []).length > 0) throw error ?? new Error("row remains");
    });
  }
  if (jobIds.length) {
    await attempt("job verify", async () => {
      const { data, error } = await researchAdmin.from("max_jobs").select("id").in("id", jobIds);
      if (error || (data ?? []).length > 0) throw error ?? new Error("rows remain");
    });
  }
  if (userId) {
    await attempt("quota verify", async () => {
      const { data, error } = await researchAdmin
        .from("max_user_quota_windows")
        .select("user_id")
        .eq("user_id", userId);
      if (error || (data ?? []).length > 0) throw error ?? new Error("rows remain");
    });
  }

  await attempt("temporary user cleanup", () =>
    cleanupTemporaryAuthUsers(
      { deleteUser: (id) => adminClient.auth.admin.deleteUser(id) },
      supabaseUrl,
      serverKey,
      cleanupEmails,
      [userId],
      serviceFetch,
    ),
  );
  await attempt("temporary user verification", async () => {
    const remainingUsers = await findTemporaryAuthUserIds(
      supabaseUrl,
      serverKey,
      new Set(cleanupEmails.map((value) => value.toLowerCase())),
      serviceFetch,
    );
    if (remainingUsers.length) throw new Error("test users remain");
  });

  if (failures.length) {
    throw new Error(`Temporary fixture cleanup incomplete: ${failures.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let userCreated = false;
  let accepted = false;
  let idempotencyReplayed = false;
  let quotaRejected = false;
  let ownerVerified = false;
  let resultRetrievedThroughFastify = false;
  let memoryRecalledByChat = false;
  let memoryPassedToWorker = false;
  let memoryRetrievalOutcome: { status: string; message: string } | undefined;
  let memoryRecallDiagnostic: MemoryRecallDiagnostic | undefined;
  let storedMemoryRow: {
    visible?: boolean;
    readError?: string;
    ownerId?: string;
    embeddingModel?: string;
    confidence?: number;
    isActive?: boolean;
    vector?: number[];
  } = {};
  let temporaryUserIsAnonymous = false;
  let followUpCompleted = false;
  let initialJobStatus: string | undefined;
  let quotaUsage: Record<string, number> | undefined;
  let finalMetrics: Record<string, unknown> | undefined;
  let liveJob: Awaited<ReturnType<SupabaseStore["getJob"]>>;
  let liveSession: Awaited<ReturnType<SupabaseStore["get"]>>;
  let providerMetrics: Record<string, unknown> | undefined;
  let externalSearchRequests = 0;
  let internalKnowledgeLookups = 0;
  let contentFetches = 0;
  let embeddingRequests = 0;
  let configuredEmbeddingModel: string | undefined;
  const embeddingModels: string[] = [];
  const embeddingVectors: Array<{ model: string; vector: number[] }> = [];
  let embeddingUsage: EmbeddingUsage = {};
  let serperRequests = 0;
  let supportedClaims = 0;
  let citationAudit: ReturnType<typeof auditResearchCitations> | undefined;
  let citationValidationStatus: string | undefined;
  let retrievalMethods: string[] = [];
  let temporaryPostQuality: ReturnType<typeof evaluatePostQuality> | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    stage = "network/config preflight";
    networkPreflight = await checkLiveNetwork({
      supabaseUrl,
      openRouterBaseUrl: config.OPENROUTER_BASE_URL,
      requiredConfiguration: [
        { name: "SUPABASE_URL", configured: Boolean(config.SUPABASE_URL) },
        { name: "SUPABASE_SECRET_KEY", configured: Boolean(config.SUPABASE_SECRET_KEY) },
        { name: "SUPABASE_PUBLISHABLE_KEY", configured: Boolean(config.SUPABASE_PUBLISHABLE_KEY) },
        { name: "SERPER_API_KEY", configured: Boolean(config.SERPER_API_KEY) },
        { name: "OPENROUTER_API_KEY", configured: Boolean(config.OPENROUTER_API_KEY) },
        { name: "MEMORY_ENABLED", configured: config.MEMORY_ENABLED },
      ],
    });
    if (!networkPreflight.ready) {
      throw new Error("Live smoke stopped at network/config preflight; no test data was created");
    }

    stage = "create one temporary Auth user";
    authCreateAttempted = true;
    const created = await createAuthUserWithReconciliation(
      () =>
        adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        }),
      supabaseUrl,
      serverKey,
      email,
      {
        request: serviceFetch,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          userId = user.id;
        },
      },
    );
    userId = created.id;
    userCreated = true;

    stage = "authenticate temporary user";
    const { data: signedIn, error: signInError } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signedIn.user?.id || !signedIn.session?.access_token) {
      throw signInError ?? new Error("Temporary user sign-in returned no access token");
    }
    if (signedIn.user.id !== userId)
      throw new Error("Authenticated identity did not match the created user");
    const accessToken = signedIn.session.access_token;
    temporaryAccessToken = accessToken;
    temporaryUserIsAnonymous = signedIn.user.is_anonymous === true;

    const store = new SupabaseStore(supabaseUrl, serverKey, undefined, publishableKey);
    const quotaPolicy = new QuotaPolicy(
      JSON.stringify({
        "durable-job-smoke": {
          quotas: {
            research: { limit: 1, windowSeconds: 3600 },
            followup: { limit: 1, windowSeconds: 3600 },
          },
        },
      }),
      JSON.stringify({ [userId]: "durable-job-smoke" }),
    );
    const apiProviderCounters = { search: 0, model: 0 };
    const searchProvider = {
      search: async () => {
        apiProviderCounters.search += 1;
        return [];
      },
    };
    class NoCallModel extends OpenRouterProvider {
      override get enabled() {
        return false;
      }
      override async complete(): Promise<string> {
        apiProviderCounters.model += 1;
        throw new Error("API must not invoke model work before a worker starts");
      }
    }

    const baseEmbeddingProvider = createEmbeddingProvider();
    if (!baseEmbeddingProvider) throw new Error("Semantic-memory embeddings are unavailable");
    configuredEmbeddingModel = baseEmbeddingProvider.model;
    const embeddingProvider: EmbeddingProvider = {
      providerName: baseEmbeddingProvider.providerName,
      model: baseEmbeddingProvider.model,
      embedMany: async (texts) => {
        embeddingRequests += 1;
        if (embeddingRequests > 2) {
          throw new Error("Integrated smoke exceeded its two embedding-request budget");
        }
        const batch = await baseEmbeddingProvider.embedMany(texts);
        embeddingModels.push(batch.model);
        const firstVector = batch.vectors[0];
        if (firstVector) embeddingVectors.push({ model: batch.model, vector: [...firstVector] });
        embeddingUsage = {
          promptTokens: (embeddingUsage.promptTokens ?? 0) + (batch.usage?.promptTokens ?? 0),
          totalTokens: (embeddingUsage.totalTokens ?? 0) + (batch.usage?.totalTokens ?? 0),
          costUsd: (embeddingUsage.costUsd ?? 0) + (batch.usage?.costUsd ?? 0),
        };
        return batch;
      },
    };
    const memoryDiagnosticStore = observeMemorySearchMisses<UserMemorySearchResult, SupabaseStore>(
      store,
      (observation) => {
        const storedBatch = embeddingVectors[0];
        const databaseCandidate = observation.candidates.find(
          (candidate) => candidate.id === memoryId,
        );
        const rpcError = observation.diagnosticError
          ? safeError(observation.diagnosticError)
          : undefined;
        memoryRecallDiagnostic = diagnoseMemoryRecall({
          temporaryUserId: userId ?? "unknown",
          authenticatedUserId: signedIn.user.id,
          authenticatedUserIsAnonymous: temporaryUserIsAnonymous,
          memoryId: memoryId ?? "unknown",
          storedRowVisible: storedMemoryRow.visible,
          storedRowReadError: storedMemoryRow.readError,
          storedOwnerId: storedMemoryRow.ownerId,
          storedEmbeddingModel: storedMemoryRow.embeddingModel ?? storedBatch?.model,
          queryEmbeddingModel: observation.embeddingModel,
          storedConfidence: storedMemoryRow.confidence,
          storedIsActive: storedMemoryRow.isActive,
          storedVector: storedMemoryRow.vector ?? storedBatch?.vector,
          queryVector: observation.embedding,
          databaseSimilarity: databaseCandidate?.similarity,
          databaseCandidateCount: observation.candidates.length,
          temporaryMemoryReturnedByThresholdRelaxedRpc: Boolean(databaseCandidate),
          databaseDiagnosticError: rpcError
            ? { name: rpcError.name, code: rpcError.code }
            : undefined,
          configuredSimilarityThreshold: observation.minSimilarity,
          schemaDimensions: config.EMBEDDING_DIMENSIONS,
        });
      },
    );
    const memoryService = new UserMemoryService(memoryDiagnosticStore, embeddingProvider);

    api = await createServer({
      store,
      authVerifier: new SupabaseAuthVerifier(supabaseUrl, publishableKey, undefined, serviceFetch),
      quotaPolicy,
      searchProvider,
      llmProvider: new NoCallModel(),
      memoryService,
      fastLookupLimits: { maxQueries: 1, maxSources: 2, maxPages: 2, maxTimeMs: 90000 },
      researchBudget: {
        maxSteps: 4,
        maxQueries: 1,
        maxSources: 2,
        maxPages: 2,
        maxSearchPasses: 1,
        maxClaimsToVerify: 2,
        maxModelDecisions: 2,
        maxTimeMs: 90000,
      },
    });
    const apiOrigin = await listenLocal(api);

    stage = "create one authenticated temporary memory fixture";
    const memoryResponse = await fetch(`${apiOrigin}/api/memories`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: memoryText }),
    });
    const memoryBody = (await memoryResponse.json()) as {
      memory?: { id?: string; content?: string };
    };
    if (
      memoryResponse.status !== 201 ||
      !memoryBody.memory?.id ||
      memoryBody.memory.content !== memoryText
    ) {
      throw new Error(`Temporary memory creation returned HTTP ${memoryResponse.status}`);
    }
    memoryId = memoryBody.memory.id;

    try {
      const { data, error } = await userClient
        .schema("research")
        .from("max_user_memories")
        .select("id, owner_id, embedding_model, confidence, is_active, embedding")
        .eq("id", memoryId)
        .maybeSingle();
      if (error) {
        const summary = safeError(error);
        storedMemoryRow.readError = `${summary.name}${summary.code ? `/${summary.code}` : ""}`;
      } else if (!data) {
        storedMemoryRow.visible = false;
      } else {
        storedMemoryRow = {
          visible: true,
          ownerId: String(data.owner_id),
          embeddingModel: String(data.embedding_model),
          confidence: Number(data.confidence),
          isActive: data.is_active === true,
          vector: parsePostgresVector(data.embedding),
        };
      }
    } catch (error) {
      const summary = safeError(error);
      storedMemoryRow.readError = `${summary.name}${summary.code ? `/${summary.code}` : ""}`;
    }

    stage = "authenticated chat enqueue with memory, quota, and idempotency checks";
    const headers = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    };
    jobId = createIdempotentJobId(`user:${userId}`, idempotencyKey);
    sessionId = jobId;
    const response = await fetch(`${apiOrigin}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: question, deepResearch: false }),
    });
    const responseBody = (await response.json()) as {
      researchId?: string;
      jobId?: string;
      route?: string;
      session?: { id?: string; status?: string };
      toolEvents?: Array<{ tool?: string; status?: string; message?: string }>;
    };
    if (
      response.status !== 202 ||
      !responseBody.researchId ||
      !responseBody.jobId ||
      responseBody.route !== "web"
    ) {
      throw new Error(
        `Authenticated chat enqueue did not create a queued research job (HTTP ${response.status})`,
      );
    }
    accepted = true;
    if (responseBody.jobId !== jobId || responseBody.researchId !== sessionId) {
      throw new Error("Chat response did not match its deterministic idempotency identity");
    }
    initialJobStatus = responseBody.session?.status;
    if (initialJobStatus !== "QUEUED") {
      throw new Error("The authenticated chat request did not persist an initially queued job");
    }
    const memoryEvent = responseBody.toolEvents?.find((event) => event.tool === "memory_retrieval");
    if (memoryEvent) {
      memoryRetrievalOutcome = {
        status: memoryEvent.status ?? "unknown",
        message: memoryEvent.message ?? "No event message",
      };
    }
    memoryRecalledByChat =
      memoryEvent?.status === "complete" && /Applied/.test(memoryEvent.message ?? "");
    const queuedMemoryJob = await store.getOwnedJob(jobId, userId);
    const queuedMemoryContext = queuedMemoryJob?.payload.memoryContext;
    memoryPassedToWorker =
      typeof queuedMemoryContext === "string" &&
      queuedMemoryContext.includes(memoryText) &&
      queuedMemoryContext.length <= config.MEMORY_MAX_CONTEXT_CHARS;
    if (!memoryRecalledByChat || !memoryPassedToWorker) {
      throw new Error(
        `Queued chat memory check failed (event=${memoryRetrievalOutcome?.status ?? "missing"}: ${memoryRetrievalOutcome?.message ?? "no retrieval event"}; queued context=${memoryPassedToWorker ? "present" : "missing"})`,
      );
    }

    const replay = await fetch(`${apiOrigin}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: question, deepResearch: false }),
    });
    const replayBody = (await replay.json()) as { researchId?: string; jobId?: string };
    idempotencyReplayed =
      replay.status === 202 && replayBody.jobId === jobId && replayBody.researchId === sessionId;
    if (!idempotencyReplayed) throw new Error("Idempotent enqueue did not return the original job");

    const rejectedJobId = createIdempotentJobId(`user:${userId}`, rejectedIdempotencyKey);
    const rejected = await fetch(`${apiOrigin}/api/chat`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": rejectedIdempotencyKey },
      body: JSON.stringify({
        message: "A second request must be quota rejected.",
        deepResearch: false,
      }),
    });
    const rejectedBody = (await rejected.json()) as { error?: string };
    quotaRejected = rejected.status === 429;
    const rejectedJob = await store.getJob(rejectedJobId);
    if (!quotaRejected || rejectedJob !== undefined) {
      throw new Error(
        `Quota check did not reject before creating another job (${rejected.status})`,
      );
    }
    if (rejectedBody.error !== "Usage limit reached for this time window") {
      throw new Error("Quota rejection response did not match the configured quota path");
    }
    if (embeddingRequests !== 2) {
      throw new Error("Replay or quota rejection unexpectedly repeated user-memory embedding work");
    }
    providerCallsBeforeWorker = apiProviderCounters.search + apiProviderCounters.model;
    if (providerCallsBeforeWorker !== 0)
      throw new Error("Provider work occurred before worker start");

    const ownedJob = await store.getOwnedJob(jobId, userId);
    const foreignView = await store.getOwnedJob(jobId, randomUUID());
    ownerVerified = ownedJob?.ownerId === userId && foreignView === undefined;
    if (!ownerVerified)
      throw new Error("Persisted job ownership did not match verified Auth identity");
    const persistedMemoryContext = ownedJob?.payload.memoryContext;
    if (
      typeof persistedMemoryContext !== "string" ||
      !persistedMemoryContext.includes(memoryText) ||
      persistedMemoryContext.length > config.MEMORY_MAX_CONTEXT_CHARS
    ) {
      throw new Error("Relevant memory was not preserved in the bounded worker job payload");
    }

    const { data: oneAttempt, error: attemptError } = await researchAdmin
      .from("max_jobs")
      .update({ max_attempts: 1 })
      .eq("id", jobId)
      .select("id, max_attempts")
      .single();
    if (attemptError || oneAttempt?.max_attempts !== 1) {
      throw new Error("Could not enforce one-attempt limit for the temporary research job");
    }

    await api.close();
    api = undefined;

    const pollStore = new SupabaseStore(supabaseUrl, serverKey, undefined, publishableKey);
    worker = startProductionWorker();
    stage = "bounded production worker research execution";
    liveJob = await waitForTerminal(pollStore, jobId);
    liveSession = await pollStore.get(sessionId);
    if (
      liveJob.status !== "completed" ||
      liveJob.attempts !== 1 ||
      liveSession?.status !== "COMPLETED"
    ) {
      throw new Error("Authenticated research job did not complete in its single allowed attempt");
    }
    const ownerJob = await pollStore.getJobForSession(sessionId, userId);
    ownerVerified = ownerVerified && ownerJob?.id === jobId;
    if (!ownerVerified) throw new Error("Worker did not preserve owner-scoped job lookup");

    externalSearchRequests =
      liveSession.searchAttempts?.filter((attempt) => attempt.provider !== "internal-knowledge")
        .length ?? 0;
    serperRequests =
      liveSession.searchAttempts?.filter((attempt) => attempt.provider.toLowerCase() === "serper")
        .length ?? 0;
    internalKnowledgeLookups =
      liveSession.searchAttempts?.filter((attempt) => attempt.provider === "internal-knowledge")
        .length ?? 0;
    contentFetches = liveSession.sources.filter((source) => Boolean(source.content)).length;
    supportedClaims = liveSession.claims.filter(
      (claim) => claim.verification?.verdict === "supported",
    ).length;
    retrievalMethods = [
      ...new Set(
        liveSession.sources
          .map((source) => source.retrievalMethod)
          .filter((method): method is NonNullable<typeof method> => method !== undefined),
      ),
    ];
    citationAudit = auditResearchCitations(liveSession.answer ?? "", liveSession.sources.length);
    const resultMetrics = liveJob.result?.modelMetrics;
    providerMetrics =
      resultMetrics && typeof resultMetrics === "object" && !Array.isArray(resultMetrics)
        ? (resultMetrics as Record<string, unknown>)
        : undefined;
    const citationValidation = providerMetrics?.citationEntailment;
    if (citationValidation && typeof citationValidation === "object") {
      const status = (citationValidation as { status?: unknown }).status;
      if (typeof status === "string") citationValidationStatus = status;
    }

    stage = "owner-scoped Fastify result read after API restart";
    retrievalApi = await createServer({
      store: new SupabaseStore(supabaseUrl, serverKey, undefined, publishableKey),
      authVerifier: new SupabaseAuthVerifier(supabaseUrl, publishableKey, undefined, serviceFetch),
      quotaPolicy,
      llmProvider: new NoCallModel(),
    });
    const retrievalOrigin = await listenLocal(retrievalApi);
    const jobResponse = await fetch(`${retrievalOrigin}/api/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const publicJob = (await jobResponse.json()) as {
      status?: string;
      attempts?: number;
      result?: Record<string, unknown>;
    };
    const sessionResponse = await fetch(`${retrievalOrigin}/api/research/${sessionId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const publicSession = (await sessionResponse.json()) as { id?: string; status?: string };
    resultRetrievedThroughFastify =
      jobResponse.status === 200 &&
      publicJob.status === "completed" &&
      publicJob.attempts === 1 &&
      sessionResponse.status === 200 &&
      publicSession.id === sessionId &&
      publicSession.status === "COMPLETED";
    if (!resultRetrievedThroughFastify) throw new Error("Owner-scoped Fastify result read failed");

    const { data: sessionOwnership, error: sessionOwnershipError } = await researchAdmin
      .from("max_research_sessions")
      .select("owner_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessionOwnershipError || sessionOwnership?.owner_id !== userId) {
      throw new Error("Research-session owner was not preserved by the background worker");
    }

    if (!liveSession.answer || !liveSession.sources.some((source) => source.content?.trim())) {
      throw new Error("The completed worker result lacks an answer or retrieved source content");
    }
    if (externalSearchRequests > 1 || liveSession.sources.length > 2 || contentFetches > 2) {
      throw new Error("The live worker exceeded its one-query, two-source, or two-page budget");
    }
    if (serperRequests !== 1) {
      throw new Error(
        `The live worker made ${serperRequests} Serper requests instead of exactly one`,
      );
    }
    if (
      supportedClaims < 1 ||
      citationValidationStatus !== "VALIDATED" ||
      citationAudit.invalidMarkers.length > 0 ||
      citationAudit.uncitedSentences.length > 0
    ) {
      throw new Error(
        "The live result lacks validated evidence-backed claims or contains incomplete citations",
      );
    }

    stage = "quality-gated temporary post and one authenticated follow-up";
    const followUpCandidates = liveSession.sources.filter((source) => source.content?.trim());
    let followUpSource = undefined;
    for (const source of followUpCandidates) {
      if (!(await store.getTopicByUrl(source.url))) {
        followUpSource = source;
        break;
      }
    }
    if (!followUpSource) {
      throw new Error(
        "No unclaimed retrieved source was available for a safe temporary post fixture",
      );
    }
    const now = new Date().toISOString();
    const topic: TopicCandidate = {
      id: randomUUID(),
      title: "Temporary MAX backend integration smoke",
      url: followUpSource.url,
      summary: liveSession.answer,
      provider: "serper",
      discoveredAt: now,
      score: 1,
      status: "RESEARCHED",
    };
    topicId = topic.id;
    const post = postFromResearch(topic, liveSession);
    postId = post.id;
    if (JSON.stringify(post).includes(memoryText)) {
      throw new Error("Private user memory would leak into the public follow-up post");
    }
    temporaryPostQuality = evaluatePostQuality(topic, liveSession, await store.listPosts(100));
    if (temporaryPostQuality.status !== "READY_TO_PUBLISH") {
      throw new Error(
        `Existing quality gate withheld the temporary follow-up post (${temporaryPostQuality.status})`,
      );
    }
    const run: AutonomousRun = {
      id: randomUUID(),
      trigger: "manual",
      status: "PUBLISHED",
      createdAt: now,
      updatedAt: now,
      topicId: topic.id,
      researchId: liveSession.id,
      postId: post.id,
      events: [
        {
          at: now,
          stage: "quality_gate",
          status: "complete",
          detail: "Passed the existing publication quality gate for the bounded smoke fixture",
        },
      ],
    };
    runId = run.id;
    await store.saveTopic(topic);
    await store.saveRun(run);
    await store.publishPost(post, topic, run);

    const followUpResponse = await fetch(`${retrievalOrigin}/api/posts/${post.id}/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "Which source supports the React release finding?" }),
    });
    const queuedFollowUp = (await followUpResponse.json()) as {
      id?: string;
      postId?: string;
    };
    if (
      followUpResponse.status !== 202 ||
      !queuedFollowUp.id ||
      queuedFollowUp.postId !== post.id
    ) {
      throw new Error(`Authenticated follow-up enqueue returned HTTP ${followUpResponse.status}`);
    }
    followUpId = queuedFollowUp.id;
    const followUpDeadline = Date.now() + 15000;
    let completedFollowUp:
      { id?: string; status?: string; answer?: string; sourceIds?: string[] } | undefined;
    while (Date.now() < followUpDeadline) {
      const poll = await fetch(`${retrievalOrigin}/api/posts/${post.id}/ask/${followUpId}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (poll.status !== 200) {
        throw new Error(`Authenticated follow-up read returned HTTP ${poll.status}`);
      }
      completedFollowUp = (await poll.json()) as typeof completedFollowUp;
      if (completedFollowUp?.status === "COMPLETED" || completedFollowUp?.status === "FAILED") {
        break;
      }
      await delay(150);
    }
    followUpCompleted =
      completedFollowUp?.status === "COMPLETED" &&
      Boolean(completedFollowUp.answer?.includes("[1]")) &&
      Boolean(completedFollowUp.sourceIds?.length) &&
      !completedFollowUp.answer?.includes(memoryText);
    if (!followUpCompleted) {
      throw new Error("Authenticated follow-up did not complete with a source citation");
    }
    const contentAdmin = adminClient.schema("content");
    const { data: followUpRow, error: followUpReadError } = await contentAdmin
      .from("max_post_followups")
      .select("owner_id")
      .eq("id", followUpId)
      .maybeSingle();
    if (followUpReadError || followUpRow?.owner_id !== userId) {
      throw new Error("Persisted follow-up did not retain the authenticated user owner");
    }
    const { data: quotaRows, error: quotaReadError } = await researchAdmin
      .from("max_user_quota_windows")
      .select("quota_key, used")
      .eq("user_id", userId);
    if (quotaReadError) throw new Error("Could not verify temporary quota usage");
    quotaUsage = Object.fromEntries(
      (quotaRows ?? []).map((row) => [String(row.quota_key), Number(row.used)]),
    );
    if (quotaUsage.research !== 1 || quotaUsage.followup !== 1) {
      throw new Error("The live user's independent research/follow-up quota usage was incorrect");
    }

    finalMetrics = {
      passed: true,
      temporaryUserId: userId,
      memoryId,
      userCreated: userCreated,
      jobId,
      sessionId,
      initialJobStatus,
      authenticatedEnqueue: accepted,
      memoryRecalledByChat,
      memoryPassedToWorker,
      memoryRecallDiagnostic,
      embeddingRequests,
      configuredEmbeddingModel,
      embeddingModels,
      embeddingUsage,
      idempotencyReplay: idempotencyReplayed,
      quotaDeniedBeforeJob: quotaRejected,
      providerCallsBeforeWorker,
      ownerPreserved: ownerVerified,
      researchStatus: liveSession.status,
      workerClaimedAt: liveJob.startedAt,
      jobAttempts: liveJob.attempts,
      workerSteps: liveSession.steps.map((step) => ({ label: step.label, status: step.status })),
      externalSearchRequests,
      serperRequests,
      internalKnowledgeLookups,
      contentFetches,
      retrievalMethods,
      sources: liveSession.sources.map((source) => ({
        url: source.url,
        retrievalMethod: source.retrievalMethod,
        extractionStatus: source.extractionStatus,
        contentChars: source.content?.length ?? 0,
      })),
      supportedClaims,
      citationAudit,
      citationValidationStatus,
      providerMetrics,
      retrievedThroughFastify: resultRetrievedThroughFastify,
      followUpCompleted,
      temporaryPostQuality,
      quotaUsage,
      networkPreflight,
    };
    await pollStore.close();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
  }

  if (primaryError || cleanupError) {
    process.stderr.write(
      `${JSON.stringify({
        passed: false,
        stage,
        temporaryUserId: userId,
        memoryId,
        userCreated,
        accepted,
        idempotencyReplayed,
        quotaRejected,
        ownerVerified,
        resultRetrievedThroughFastify,
        memoryRecalledByChat,
        memoryPassedToWorker,
        memoryRetrievalOutcome,
        memoryRecallDiagnostic,
        followUpCompleted,
        serperRequests,
        embeddingRequests,
        configuredEmbeddingModel,
        embeddingModels,
        embeddingUsage,
        supportedClaims,
        citationAudit,
        citationValidationStatus,
        temporaryPostQuality,
        networkPreflight,
        failure: primaryError ? safeError(primaryError) : undefined,
        cleanupFailure: cleanupError ? safeError(cleanupError) : undefined,
        durationMs: Date.now() - startedAt,
      })}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${JSON.stringify({ ...finalMetrics, cleanupVerified: true, durationMs: Date.now() - startedAt })}\n`,
    );
  }
}

await main();
