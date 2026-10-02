import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { QueryInterpretation, SearchResult, Source } from "../domain.js";
import {
  OpenRouterEmbeddingProvider,
  type EmbeddingBatch,
  type EmbeddingProvider,
  type EmbeddingUsage,
} from "../embeddings.js";
import { config } from "../config.js";
import { createToolRegistry, type ToolRegistry } from "../agent/tools.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { OpenRouterProvider } from "../llm.js";
import { UserMemoryService } from "../memory.js";
import { QuotaPolicy } from "../quota-policy.js";
import { createServer, getServerBackgroundServices } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import type { SearchProvider } from "../search.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
} from "./auth-smoke-cleanup.js";
import { safeErrorSummary } from "./safe-error-summary.js";

const MAX_EMBEDDING_REQUESTS = 2;
const REQUEST_TIMEOUT_MS = 12_000;
const JOB_TIMEOUT_MS = 60_000;
const memoryText = "For MAX I prefer concise answers with source links.";
const answerText = "The saved answer style was applied: concise with source links [1].";
const sourceContent =
  "The React releases page lists stable React versions and links to the official release details. " +
  "The official release history records changes for each published React version.";

class NoNetworkChatModel extends OpenRouterProvider {
  readonly completionCalls: Array<{ system: string; user: string }> = [];

  override get enabled() {
    return true;
  }

  override async complete(system: string, user: string): Promise<string> {
    this.completionCalls.push({ system, user });
    const allowed = user.match(/Allowed actions: ([^\n]+)/)?.[1]?.split(", ");
    if (allowed?.length) return JSON.stringify({ action: allowed[0] });
    if (system.includes("conflicts")) return JSON.stringify({ conflicts: [] });
    return JSON.stringify({ objectives: [], queryGroups: [] });
  }
}

function interpretation(question: string): QueryInterpretation {
  return {
    normalizedQuestion: question,
    intent: "current_information",
    entities: ["React"],
    topic: "official release documentation",
    dimensions: ["official release information"],
    corrections: [],
    ambiguityScore: 0,
    ambiguityReasons: [],
    needsClarification: false,
    formatPreference: "lookup",
  };
}

function createFixtureTools(
  search: SearchProvider,
  model: NoNetworkChatModel,
  store: SupabaseStore,
  state: {
    memoryReachedSynthesis: boolean;
    synthesisCalls: number;
  },
): ToolRegistry {
  const tools = createToolRegistry(search, model, store);
  tools.register({
    name: "understand_query",
    description: "Use the fixed interpretation for this bounded memory-path check.",
    execute: async (input) => interpretation((input as { question: string }).question),
  });
  tools.register({
    name: "fetch_url",
    description: "Return fixed page content without outbound web access.",
    execute: async (input) => ({
      url: (input as { url: string }).url,
      html: `<html><head><title>React releases</title></head><body><article><h1>React releases</h1><p>${sourceContent}</p></article></body></html>`,
      contentType: "text/html",
      retrievalMethod: "http",
      retrievalAttempts: ["fixture-http"],
      extractionConfidence: 1,
      extractionStatus: "SUCCEEDED",
      retrievedContentLength: sourceContent.length,
    }),
  });
  tools.register({
    name: "extract_claims",
    description: "Use two fixed claims supported by the local page fixture.",
    execute: async (input) => {
      const sources = (input as { sources: Source[] }).sources;
      const source = sources[0];
      if (!source) return [];
      const sentences = sourceContent.split(/(?<=[.!?])\s+/);
      return sentences.map((text, index) => ({
        id: `memory-smoke-claim-${index + 1}`,
        text,
        sourceIds: [source.id],
        evidence: text,
        confidence: 1,
      }));
    },
  });
  tools.register({
    name: "verify_claims_batch",
    description: "Verify only claims from the controlled local page fixture.",
    execute: async (input) =>
      (input as { claims: Array<{ id: string }> }).claims.map(({ id }) => ({
        id,
        verdict: "supported",
        rationale: "Exact match to deterministic fixture evidence.",
      })),
  });
  tools.register({
    name: "synthesize",
    description: "Record whether the worker supplied the saved context without a model call.",
    execute: async (input) => {
      state.synthesisCalls += 1;
      const context = (input as { memoryContext?: string }).memoryContext;
      state.memoryReachedSynthesis = Boolean(context?.includes(memoryText));
      return state.memoryReachedSynthesis
        ? answerText
        : "No saved answer-style context was supplied to synthesis [1].";
    },
  });
  return tools;
}

function boundedFetch(fetchImplementation: typeof fetch, deadlineAt: number): typeof fetch {
  return async (input, init = {}) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Queued memory smoke exceeded its time limit");
    const signals: AbortSignal[] = [AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs))];
    if (input instanceof Request && input.signal) signals.push(input.signal);
    if (init.signal) signals.push(init.signal);
    return fetchImplementation(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

async function main() {
  const startedAt = Date.now();
  const deadlineAt = startedAt + JOB_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  const request = boundedFetch(originalFetch.bind(globalThis), deadlineAt);
  globalThis.fetch = request;

  const suffix = randomUUID();
  const email = `max-queued-memory-${suffix}@example.com`;
  const password = `${randomBytes(32).toString("base64url")}!aA9`;
  const question =
    "Based on what I said about my preferred answer style, investigate the latest React release and keep the summary concise with source links.";
  const report: Record<string, unknown> = {
    status: "FAILED",
    startedAt: new Date(startedAt).toISOString(),
    enqueueStatus: null,
    jobStatus: null,
    researchStatus: null,
    memoryRetrievalApplied: false,
    memoryInJobPayload: false,
    memoryReachedWorkerSynthesis: false,
    resultReadableByOwner: false,
    embedding: {
      provider: config.EMBEDDING_PROVIDER,
      requestedModel: config.EMBEDDING_MODEL,
      requests: 0,
      usage: { promptTokens: null, totalTokens: null, costUsd: null },
    },
    externalSearchProviderCalls: 0,
    externalChatCompletionCalls: 0,
    fixtureSearchCalls: 0,
    fixtureSynthesisCalls: 0,
    durationMs: null,
    cleanup: { rowsRemoved: false, userRemoved: false, verifiedNoResidue: false },
  };

  let stage = "preflight";
  let userId: string | undefined;
  let accessToken: string | undefined;
  let memoryId: string | undefined;
  let jobId: string | undefined;
  let sessionId: string | undefined;
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let workerStarted = false;
  let embeddingRequests = 0;
  let embeddingModelUsed: string | undefined;
  const embeddingUsage: EmbeddingUsage[] = [];
  let fixtureSearchCalls = 0;
  const synthesisState = { memoryReachedSynthesis: false, synthesisCalls: 0 };
  const admin =
    config.SUPABASE_URL && config.SUPABASE_SECRET_KEY
      ? createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
          global: { fetch: createSupabaseFetch() },
        })
      : undefined;
  const userClient =
    config.SUPABASE_URL && config.SUPABASE_PUBLISHABLE_KEY
      ? createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
          global: { fetch: createSupabaseFetch() },
        })
      : undefined;

  try {
    assert(
      config.SUPABASE_URL &&
        config.SUPABASE_SECRET_KEY &&
        config.SUPABASE_PUBLISHABLE_KEY &&
        config.OPENROUTER_API_KEY &&
        config.MEMORY_ENABLED &&
        config.EMBEDDING_PROVIDER === "openrouter" &&
        config.EMBEDDING_DIMENSIONS === 1536,
      "Queued memory smoke requires Signova and configured 1536-dimensional OpenRouter embeddings",
    );
    assert(admin && userClient, "Supabase clients were not initialized");

    const store = new SupabaseStore(
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      undefined,
      config.SUPABASE_PUBLISHABLE_KEY,
    );
    const embeddingProvider = new OpenRouterEmbeddingProvider({
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.EMBEDDING_BASE_URL,
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      timeoutMs: Math.min(config.EMBEDDING_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
      fetchImplementation: request,
    });
    const boundedEmbeddings: EmbeddingProvider = {
      providerName: embeddingProvider.providerName,
      model: embeddingProvider.model,
      async embedMany(texts): Promise<EmbeddingBatch> {
        if (embeddingRequests >= MAX_EMBEDDING_REQUESTS) {
          throw new Error("Queued memory smoke exceeded its two-request embedding budget");
        }
        embeddingRequests += 1;
        const batch = await embeddingProvider.embedMany(texts);
        embeddingModelUsed = batch.model;
        embeddingUsage.push(batch.usage ?? {});
        return batch;
      },
    };
    const memoryService = new UserMemoryService(store, boundedEmbeddings);
    const model = new NoNetworkChatModel();
    const search: SearchProvider = {
      async search(query): Promise<SearchResult[]> {
        fixtureSearchCalls += 1;
        return [
          {
            title: "React official release history",
            url: "https://react.dev/versions",
            snippet: "Official React versions and release details.",
            provider: "local-memory-fixture",
            query,
            publishedAt: new Date().toISOString(),
          },
        ];
      },
    };
    const tools = createFixtureTools(search, model, store, synthesisState);

    stage = "initialize Fastify with live Supabase store and local-only research fixtures";
    api = await createServer({
      store,
      searchProvider: search,
      llmProvider: model,
      toolRegistry: tools,
      memoryService,
      authVerifier: new SupabaseAuthVerifier(
        config.SUPABASE_URL,
        config.SUPABASE_PUBLISHABLE_KEY,
        undefined,
        request,
      ),
      quotaPolicy: new QuotaPolicy(),
      researchBudget: {
        maxSteps: 8,
        maxQueries: 1,
        maxSources: 1,
        maxPages: 1,
        maxSearchPasses: 1,
        maxClaimsToVerify: 2,
        maxModelDecisions: 1,
        maxTimeMs: 45_000,
      },
    });

    const services = getServerBackgroundServices(api);
    if (
      (await services.jobStore.hasRunnableOrRunningJobs("research")) ||
      (await services.jobStore.hasRunnableOrRunningJobs("post_agent"))
    ) {
      throw new Error("Signova already has runnable jobs; refusing to start a shared-queue smoke");
    }

    stage = "create one temporary authenticated user";
    const createdUser = await createAuthUserWithReconciliation(
      () =>
        admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      email,
      { request },
    );
    userId = createdUser.id;

    stage = "authenticate temporary user";
    const signIn = await userClient.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session?.access_token) {
      throw new Error("Temporary user sign-in did not return an authenticated session");
    }
    accessToken = signIn.data.session.access_token;
    const headers = { authorization: `Bearer ${accessToken}` };

    stage = "create one private saved-memory fixture";
    const memoryResponse = await api.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { text: memoryText },
    });
    const memoryBody = memoryResponse.json() as { memory?: { id?: string } };
    if (memoryResponse.statusCode !== 201 || typeof memoryBody.memory?.id !== "string") {
      throw new Error(
        `Memory creation did not return HTTP 201 (received ${memoryResponse.statusCode})`,
      );
    }
    memoryId = memoryBody.memory.id;

    stage = "enqueue one authenticated chat with memory retrieval";
    const enqueue = await api.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...headers, "idempotency-key": `queued-memory-${suffix}` },
      payload: { message: question, deepResearch: false },
    });
    const chat = enqueue.json() as {
      route?: string;
      jobId?: string;
      researchId?: string;
      toolEvents?: Array<{ tool: string; status: string; message?: string }>;
    };
    report.enqueueStatus = enqueue.statusCode;
    if (enqueue.statusCode !== 202 || chat.route !== "web" || !chat.jobId || !chat.researchId) {
      throw new Error(`Chat did not enqueue a research job (HTTP ${enqueue.statusCode})`);
    }
    jobId = chat.jobId;
    sessionId = chat.researchId;
    const retrievalEvent = chat.toolEvents?.find((event) => event.tool === "memory_retrieval");
    report.memoryRetrievalApplied =
      retrievalEvent?.status === "complete" &&
      /Applied\s+1\s+relevant saved/i.test(retrievalEvent.message ?? "");
    if (!report.memoryRetrievalApplied) {
      throw new Error(
        "Authenticated chat did not report applying the single relevant saved memory",
      );
    }
    if (embeddingRequests !== 2) {
      throw new Error(
        `Expected two bounded embedding requests before worker start; observed ${embeddingRequests}`,
      );
    }

    const queuedJob = await services.jobStore.getOwnedJob(jobId, userId);
    const memoryContext = queuedJob?.payload.memoryContext;
    report.memoryInJobPayload =
      typeof memoryContext === "string" &&
      memoryContext.includes(memoryText) &&
      memoryContext.length <= config.MEMORY_MAX_CONTEXT_CHARS;
    if (!report.memoryInJobPayload) {
      throw new Error("Relevant saved memory was absent from the owned durable-job payload");
    }

    stage = "run the existing queue worker and await the durable result";
    services.worker.start();
    workerStarted = true;
    let completedJob = await services.jobStore.getOwnedJob(jobId, userId);
    while (Date.now() < deadlineAt && completedJob?.status !== "completed") {
      if (completedJob && ["failed", "cancelled"].includes(completedJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      completedJob = await services.jobStore.getOwnedJob(jobId, userId);
    }
    if (completedJob?.status !== "completed") {
      throw new Error(`Queued job did not complete (status ${completedJob?.status ?? "missing"})`);
    }
    report.jobStatus = completedJob.status;
    const completedSession = await store.get(sessionId);
    report.researchStatus = completedSession?.status ?? null;
    report.memoryReachedWorkerSynthesis = synthesisState.memoryReachedSynthesis;
    if (
      completedSession?.status !== "COMPLETED" ||
      !synthesisState.memoryReachedSynthesis ||
      synthesisState.synthesisCalls !== 1 ||
      completedSession.answer !== answerText
    ) {
      throw new Error(
        "Worker did not apply saved memory at synthesis and persist the expected result",
      );
    }

    stage = "read the completed job and result through owner-scoped Fastify routes";
    const jobRead = await api.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers,
    });
    const sessionRead = await api.inject({
      method: "GET",
      url: `/api/research/${sessionId}`,
      headers,
    });
    const publicJob = jobRead.json() as { status?: string; result?: { sessionId?: string } };
    const publicSession = sessionRead.json() as { status?: string; answer?: string };
    report.resultReadableByOwner =
      jobRead.statusCode === 200 &&
      sessionRead.statusCode === 200 &&
      publicJob.status === "completed" &&
      publicJob.result?.sessionId === sessionId &&
      publicSession.status === "COMPLETED" &&
      publicSession.answer === answerText;
    if (!report.resultReadableByOwner)
      throw new Error("Owner could not read the completed chat result");

    report.status = "PASSED";
  } catch (error) {
    report.failedAt = stage;
    report.failure = safeErrorSummary(error);
  } finally {
    if (api) {
      try {
        const services = getServerBackgroundServices(api);
        if (workerStarted) await services.worker.stop();
      } catch {
        report.workerStopFailed = true;
      }
    }

    let rowsRemoved = true;
    if (admin && userId) {
      for (const [schema, table, column] of [
        ["research", "max_jobs", "owner_id"],
        ["research", "max_research_sessions", "owner_id"],
        ["research", "max_user_memories", "owner_id"],
        ["research", "max_user_quota_windows", "user_id"],
      ] as const) {
        try {
          const client = admin.schema(schema);
          const { error } = await client.from(table).delete().eq(column, userId);
          if (error) throw error;
        } catch {
          rowsRemoved = false;
        }
      }
      if (jobId) {
        try {
          const { error } = await admin
            .schema("research")
            .from("max_jobs")
            .delete()
            .eq("id", jobId);
          if (error) throw error;
        } catch {
          rowsRemoved = false;
        }
      }
      if (sessionId) {
        try {
          const { error } = await admin
            .schema("research")
            .from("max_research_sessions")
            .delete()
            .eq("id", sessionId);
          if (error) throw error;
        } catch {
          rowsRemoved = false;
        }
      }
      if (memoryId) {
        try {
          const { error } = await admin
            .schema("research")
            .from("max_user_memories")
            .delete()
            .eq("id", memoryId);
          if (error) throw error;
        } catch {
          rowsRemoved = false;
        }
      }
      try {
        const checks = await Promise.all([
          admin.schema("research").from("max_jobs").select("id").eq("owner_id", userId),
          admin
            .schema("research")
            .from("max_research_sessions")
            .select("id")
            .eq("owner_id", userId),
          admin.schema("research").from("max_user_memories").select("id").eq("owner_id", userId),
          admin
            .schema("research")
            .from("max_user_quota_windows")
            .select("user_id")
            .eq("user_id", userId),
        ]);
        if (checks.some(({ data, error }) => error || (data?.length ?? 0) > 0)) rowsRemoved = false;
      } catch {
        rowsRemoved = false;
      }
    } else if (userId) {
      rowsRemoved = false;
    }
    report.cleanup = { rowsRemoved, userRemoved: false, verifiedNoResidue: false };

    if (admin && config.SUPABASE_URL && config.SUPABASE_SECRET_KEY) {
      try {
        await cleanupTemporaryAuthUsers(
          admin.auth.admin,
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY,
          [email],
          [userId],
          request,
        );
        report.cleanup = { rowsRemoved, userRemoved: true, verifiedNoResidue: rowsRemoved };
      } catch (error) {
        report.cleanup = { rowsRemoved, userRemoved: false, verifiedNoResidue: false };
        report.cleanupFailure = safeErrorSummary(error);
      }
    }

    if (!(report.cleanup as { verifiedNoResidue?: boolean }).verifiedNoResidue) {
      report.status = "FAILED";
      report.failedAt ??= "remove and verify temporary Supabase data";
    }

    if (api) {
      try {
        await api.close();
      } catch {
        report.apiCloseFailed = true;
      }
    }
    if (userClient) {
      try {
        await userClient.auth.signOut();
      } catch {
        // The exact temporary Auth user is removed below regardless.
      }
    }
    globalThis.fetch = originalFetch;

    const usage = embeddingUsage;
    report.embedding = {
      provider: config.EMBEDDING_PROVIDER,
      requestedModel: config.EMBEDDING_MODEL,
      actualModel: embeddingModelUsed ?? null,
      dimensions: config.EMBEDDING_DIMENSIONS,
      requests: embeddingRequests,
      usage: {
        promptTokens: usage.every((item) => typeof item.promptTokens === "number")
          ? usage.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0)
          : null,
        totalTokens: usage.every((item) => typeof item.totalTokens === "number")
          ? usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0)
          : null,
        costUsd:
          usage.length > 0 && usage.every((item) => typeof item.costUsd === "number")
            ? usage.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)
            : null,
      },
    };
    report.fixtureSearchCalls = fixtureSearchCalls;
    report.fixtureSynthesisCalls = synthesisState.synthesisCalls;
    report.externalSearchProviderCalls = 0;
    report.externalChatCompletionCalls = 0;
    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
  }

  if (
    report.status !== "PASSED" ||
    !(report.cleanup as { verifiedNoResidue?: boolean }).verifiedNoResidue
  ) {
    process.exitCode = 1;
  }
}

await main();
