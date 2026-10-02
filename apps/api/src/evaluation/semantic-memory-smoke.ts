import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { LightMyRequestResponse } from "fastify";
import type { QueryInterpretation } from "../domain.js";
import { withAuthenticatedUser } from "../auth-context.js";
import { SupabaseAuthVerifier } from "../auth.js";
import { OpenRouterEmbeddingProvider, type EmbeddingProvider } from "../embeddings.js";
import { config } from "../config.js";
import { UserMemoryService } from "../memory.js";
import { QuotaPolicy } from "../quota-policy.js";
import { createServer } from "../server.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";
import { ToolRegistry } from "../agent/tools.js";
import {
  cleanupTemporaryAuthUsers,
  createAuthUserWithReconciliation,
} from "./auth-smoke-cleanup.js";
import { safeErrorSummary } from "./safe-error-summary.js";

const WORK_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 150_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_EMBEDDING_REQUESTS = 8;
const REPORT_PATH = join(process.cwd(), "evaluation-results", "semantic-memory-smoke-report.json");

interface SmokeReport {
  status: "PASSED" | "FAILED";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  failedAt?: string;
  failure?: { name: string; message?: string };
  auth?: {
    userASignIn?: AuthSignInResult;
    userBSignIn?: AuthSignInResult;
  };
  checks: Record<string, boolean>;
  retrieval?: {
    relevantMemoryRankedFirst: boolean;
    irrelevantMemoryExcluded: boolean;
    topSimilarity?: number;
    irrelevantSimilarity?: number;
    ownerBResults: number;
    ownerACrossUserResults: number;
  };
  chat?: {
    userAReceivedMemoryContext: boolean;
    userBReceivedNoMemoryContext: boolean;
    completedAnswers: number;
  };
  provider?: {
    embedding: string;
    model: string;
    requestCount: number;
    failure?: { name: string; message?: string };
    promptTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
    costReportedForEveryRequest: boolean;
    searchCalls: number;
    chatCompletionCalls: number;
  };
  cleanup?: {
    memoryRowsRemoved: boolean;
    usersRemoved: boolean;
    temporaryUsersCreated: number;
  };
  budgets?: {
    workTimeoutMs: number;
    totalTimeoutMs: number;
    cleanupReserveMs: number;
    requestTimeoutMs: number;
    maxEmbeddingRequests: number;
  };
}

interface AuthSignInResult {
  sessionReturned: boolean;
  error?: {
    name: string;
    status?: number;
    code?: string;
    message?: string;
  };
}

function boundedFetch(fetchImpl: typeof fetch, deadline: () => number): typeof fetch {
  return async (input, init = {}) => {
    const remainingMs = deadline() - Date.now();
    if (remainingMs <= 0) throw new Error("Semantic memory smoke exceeded its time limit");
    const signals: AbortSignal[] = [AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs))];
    if (input instanceof Request && input.signal) signals.push(input.signal);
    if (init.signal) signals.push(init.signal);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function authSignInResult(error: unknown, sessionReturned: boolean): AuthSignInResult {
  if (!error) return { sessionReturned };

  const summary = safeErrorSummary(error);
  const fields = typeof error === "object" && error !== null ? error : undefined;
  const status = fields && "status" in fields ? fields.status : undefined;
  const code = fields && "code" in fields ? fields.code : undefined;
  return {
    sessionReturned,
    error: {
      name: summary.name,
      ...(typeof status === "number" && Number.isFinite(status) ? { status } : {}),
      ...(typeof code === "string" && /^[a-z0-9_-]{1,80}$/i.test(code) ? { code } : {}),
      ...(summary.message ? { message: summary.message } : {}),
    },
  };
}

function authHeader(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

async function deleteAndVerifyOwnedMemories(
  api: Awaited<ReturnType<typeof createServer>>,
  accessToken: string,
): Promise<boolean> {
  const headers = authHeader(accessToken);
  const before = await api.inject({
    method: "GET",
    url: "/api/memories?limit=50&includeInactive=true",
    headers,
  });
  if (before.statusCode !== 200) return false;

  const memories = before.json() as Array<{ id?: unknown }>;
  if (!Array.isArray(memories) || memories.some((memory) => typeof memory.id !== "string")) {
    return false;
  }
  for (const memory of memories) {
    const deleted = await api.inject({
      method: "DELETE",
      url: `/api/memories/${encodeURIComponent(memory.id as string)}`,
      headers,
    });
    if (deleted.statusCode !== 204) return false;
  }

  const after = await api.inject({
    method: "GET",
    url: "/api/memories?limit=50&includeInactive=true",
    headers,
  });
  return after.statusCode === 200 && Array.isArray(after.json()) && after.json().length === 0;
}

function interpretation(question: string): QueryInterpretation {
  return {
    normalizedQuestion: question,
    intent: "personal_context",
    entities: ["MAX"],
    topic: "saved user context",
    dimensions: [],
    corrections: [],
    ambiguityScore: 0,
    ambiguityReasons: [],
    needsClarification: false,
    formatPreference: "direct",
  };
}

async function main() {
  const started = Date.now();
  const workDeadlineAt = started + WORK_TIMEOUT_MS;
  const cleanupDeadlineAt = started + TOTAL_TIMEOUT_MS;
  let requestDeadlineAt = workDeadlineAt;
  const originalFetch = globalThis.fetch;
  const nativeFetch = originalFetch.bind(globalThis);
  const request = boundedFetch(nativeFetch, () => requestDeadlineAt);
  globalThis.fetch = request;
  const supabaseFetch = createSupabaseFetch();

  const suffix = randomUUID();
  const emails = {
    userA: `max-memory-smoke-a-${suffix}@example.com`,
    userB: `max-memory-smoke-b-${suffix}@example.com`,
  };
  const passwords = { userA: `${randomUUID()}!aA7`, userB: `${randomUUID()}!bB8` };
  const ids: {
    userA?: string;
    userB?: string;
    memoriesA: string[];
    memoriesB: string[];
  } = { memoriesA: [], memoriesB: [] };
  const accessTokens: { userA?: string; userB?: string } = {};
  const usage: Array<{ promptTokens?: number; totalTokens?: number; costUsd?: number }> = [];
  let embeddingRequests = 0;
  let embeddingFailure: { name: string; message?: string } | undefined;
  let searchCalls = 0;
  let chatCompletionCalls = 0;
  let failedAt = "preflight";
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let store: SupabaseStore | undefined;
  let admin: ReturnType<typeof createClient<any>> | undefined;
  let authClientA: ReturnType<typeof createClient<any>> | undefined;
  let authClientB: ReturnType<typeof createClient<any>> | undefined;
  let userAResearch: ReturnType<ReturnType<typeof createClient<any>>["schema"]> | undefined;
  let userBResearch: ReturnType<ReturnType<typeof createClient<any>>["schema"]> | undefined;
  const observations: Array<string | undefined> = [];
  const report: SmokeReport = {
    status: "FAILED",
    startedAt: new Date(started).toISOString(),
    checks: {},
    cleanup: { memoryRowsRemoved: false, usersRemoved: false, temporaryUsersCreated: 0 },
  };

  const writeReport = () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    report.budgets = {
      workTimeoutMs: WORK_TIMEOUT_MS,
      totalTimeoutMs: TOTAL_TIMEOUT_MS,
      cleanupReserveMs: TOTAL_TIMEOUT_MS - WORK_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxEmbeddingRequests: MAX_EMBEDDING_REQUESTS,
    };
    report.provider = {
      embedding: config.EMBEDDING_PROVIDER,
      model: config.EMBEDDING_MODEL,
      requestCount: embeddingRequests,
      ...(embeddingFailure ? { failure: embeddingFailure } : {}),
      promptTokens: usage.every((entry) => typeof entry.promptTokens === "number")
        ? usage.reduce((sum, entry) => sum + (entry.promptTokens ?? 0), 0)
        : null,
      totalTokens: usage.every((entry) => typeof entry.totalTokens === "number")
        ? usage.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0)
        : null,
      costUsd:
        usage.length > 0 && usage.every((entry) => typeof entry.costUsd === "number")
          ? usage.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
          : null,
      costReportedForEveryRequest:
        usage.length === embeddingRequests &&
        usage.every((entry) => typeof entry.costUsd === "number"),
      searchCalls,
      chatCompletionCalls,
    };
    mkdirSync(join(process.cwd(), "evaluation-results"), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };

  try {
    if (
      !config.SUPABASE_URL ||
      !config.SUPABASE_SECRET_KEY ||
      !config.SUPABASE_PUBLISHABLE_KEY ||
      !config.OPENROUTER_API_KEY ||
      !config.MEMORY_ENABLED ||
      config.EMBEDDING_PROVIDER !== "openrouter"
    ) {
      throw new Error(
        "Semantic smoke requires Supabase keys, OpenRouter embeddings, and MEMORY_ENABLED=true",
      );
    }
    assert(Date.now() < workDeadlineAt, "Smoke work deadline expired during preflight");
    report.checks.configured = true;

    failedAt = "initialize bounded clients and services";
    admin = createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: createSupabaseFetch() },
    });
    authClientA = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: supabaseFetch },
    });
    authClientB = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: supabaseFetch },
    });
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.EMBEDDING_BASE_URL,
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      timeoutMs: Math.min(config.EMBEDDING_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
      fetchImplementation: request,
    });
    const embeddings: EmbeddingProvider = {
      providerName: provider.providerName,
      model: provider.model,
      async embedMany(texts) {
        if (embeddingRequests >= MAX_EMBEDDING_REQUESTS) {
          throw new Error("Semantic memory smoke exceeded its embedding request budget");
        }
        embeddingRequests += 1;
        let result: Awaited<ReturnType<EmbeddingProvider["embedMany"]>>;
        try {
          result = await provider.embedMany(texts);
        } catch (error) {
          embeddingFailure = safeErrorSummary(error);
          throw error;
        }
        usage.push(result.usage ?? {});
        return result;
      },
    };

    store = new SupabaseStore(
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      undefined,
      config.SUPABASE_PUBLISHABLE_KEY,
    );
    store.recoverInterrupted = async () => 0;
    store.recoverAutonomousRuns = async () => 0;
    store.listRuns = async () => [];
    const memoryService = new UserMemoryService(store, embeddings);
    const tools = new ToolRegistry()
      .register({
        name: "understand_query",
        description: "Deterministic local-only query understanding for the bounded memory smoke.",
        execute: async (input) => interpretation((input as { question: string }).question),
      })
      .register({
        name: "synthesize",
        description: "Capture bounded memory context without making an LLM chat-completion call.",
        execute: async (input) => {
          const memoryContext = (input as { memoryContext?: string }).memoryContext;
          observations.push(memoryContext);
          return memoryContext
            ? "The saved user context was available to this authenticated answer."
            : "No saved user context was supplied to this authenticated answer.";
        },
      });
    const llmProvider = new Proxy(
      { enabled: true },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => {
            chatCompletionCalls += 1;
            throw new Error("Unexpected chat-completion provider call in memory smoke");
          };
        },
      },
    ) as never;

    api = await createServer({
      store,
      memoryService,
      authVerifier: new SupabaseAuthVerifier(
        config.SUPABASE_URL,
        config.SUPABASE_PUBLISHABLE_KEY,
        undefined,
        request,
      ),
      quotaPolicy: new QuotaPolicy(),
      searchProvider: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      llmProvider,
      toolRegistry: tools,
    });
    report.checks.apiStackCreated = true;

    failedAt = "create temporary authenticated User A";
    const userA = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({
          email: emails.userA,
          password: passwords.userA,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emails.userA,
      {
        request,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          ids.userA = user.id;
        },
      },
    );
    ids.userA = userA.id;
    const signInA = await authClientA.auth.signInWithPassword({
      email: emails.userA,
      password: passwords.userA,
    });
    report.auth = {
      ...report.auth,
      userASignIn: authSignInResult(signInA.error, Boolean(signInA.data.session?.access_token)),
    };
    if (signInA.error || !signInA.data.session?.access_token) {
      throw new Error(
        `Temporary User A could not authenticate (${JSON.stringify(report.auth.userASignIn)})`,
      );
    }
    accessTokens.userA = signInA.data.session.access_token;
    userAResearch = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        fetch: supabaseFetch,
        headers: { Authorization: `Bearer ${accessTokens.userA}` },
      },
    }).schema("research");
    report.checks.userAAuthenticated = true;

    failedAt = "create a relevant memory and a distractor through Fastify";
    const memoryInputs = [
      "For MAX I chose Serper as the web search provider.",
      "I enjoy hiking and cooking vegetable curry on quiet weekends.",
    ];
    for (const text of memoryInputs) {
      const response: LightMyRequestResponse = await api!.inject({
        method: "POST",
        url: "/api/memories",
        headers: authHeader(accessTokens.userA),
        payload: { text },
      });
      assert.equal(response.statusCode, 201, "memory creation did not return HTTP 201");
      const body = response.json() as { memory?: { id?: string } };
      const memoryId = body.memory?.id;
      if (typeof memoryId !== "string") {
        throw new Error("Memory create response omitted its ID");
      }
      ids.memoriesA.push(memoryId);
    }
    report.checks.userAMemoriesCreated = ids.memoriesA.length === 2;

    failedAt = "run isolated semantic retrieval as User A";
    const question = "Which search provider did I choose for MAX?";
    const retrievalA = await withAuthenticatedUser(
      { userId: userA.id, accessToken: accessTokens.userA },
      () => memoryService.retrieveForQuestion(question),
    );
    const relevant = retrievalA.memories[0];
    const irrelevant = retrievalA.memories.find((memory) => memory.id === ids.memoriesA[1]);
    assert.equal(relevant?.id, ids.memoriesA[0], "the relevant memory was not ranked first");
    assert.equal(irrelevant, undefined, "the unrelated distractor passed the relevance threshold");
    report.retrieval = {
      relevantMemoryRankedFirst: relevant?.id === ids.memoriesA[0],
      irrelevantMemoryExcluded: irrelevant === undefined,
      topSimilarity: relevant?.similarity,
      irrelevantSimilarity: undefined,
      ownerBResults: 0,
      ownerACrossUserResults: 0,
    };
    assert(
      retrievalA.context?.includes("Serper"),
      "retrieved context did not contain the relevant memory",
    );
    report.checks.semanticRetrieval = true;

    failedAt = "verify User A can read the created memory";
    const readA = await api.inject({
      method: "GET",
      url: `/api/memories/${ids.memoriesA[0]}`,
      headers: authHeader(accessTokens.userA),
    });
    assert.equal(readA.statusCode, 200);

    failedAt = "create and authenticate temporary User B";
    const userB = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({
          email: emails.userB,
          password: passwords.userB,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      emails.userB,
      {
        request,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          ids.userB = user.id;
        },
      },
    );
    ids.userB = userB.id;
    const signInB = await authClientB.auth.signInWithPassword({
      email: emails.userB,
      password: passwords.userB,
    });
    report.auth = {
      ...report.auth,
      userBSignIn: authSignInResult(signInB.error, Boolean(signInB.data.session?.access_token)),
    };
    if (signInB.error || !signInB.data.session?.access_token) {
      throw new Error(
        `Temporary User B could not authenticate (${JSON.stringify(report.auth.userBSignIn)})`,
      );
    }
    accessTokens.userB = signInB.data.session.access_token;
    userBResearch = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        fetch: supabaseFetch,
        headers: { Authorization: `Bearer ${accessTokens.userB}` },
      },
    }).schema("research");
    report.checks.userBAuthenticated = true;

    failedAt = "create a distinct User B-owned memory through Fastify";
    const createBMemory = await api.inject({
      method: "POST",
      url: "/api/memories",
      headers: authHeader(accessTokens.userB),
      payload: { text: "For backend prototypes, I prefer the Rust programming language." },
    });
    assert.equal(createBMemory.statusCode, 201);
    const bMemoryId = (createBMemory.json() as { memory?: { id?: string } }).memory?.id;
    assert.equal(typeof bMemoryId, "string", "User B memory response omitted its ID");
    ids.memoriesB.push(bMemoryId as string);
    report.checks.userBMemoryCreated = true;

    failedAt = "verify both users' JWTs are enforced by memory-table RLS";
    if (!userAResearch || !userBResearch) throw new Error("An authenticated RLS client is missing");
    const directBRead = await userBResearch
      .from("max_user_memories")
      .select("id")
      .eq("id", ids.memoriesA[0])
      .maybeSingle();
    assert.equal(directBRead.error, null);
    assert.equal(directBRead.data, null, "RLS exposed User A memory to User B");
    const directBUpdate = await userBResearch
      .from("max_user_memories")
      .update({ content: "Unauthorized cross-user update attempt." })
      .eq("id", ids.memoriesA[0])
      .select("id");
    assert.equal(directBUpdate.error, null);
    assert.deepEqual(directBUpdate.data, [], "RLS allowed User B to update User A memory");
    const directBDelete = await userBResearch
      .from("max_user_memories")
      .delete()
      .eq("id", ids.memoriesA[0])
      .select("id");
    assert.equal(directBDelete.error, null);
    assert.deepEqual(directBDelete.data, [], "RLS allowed User B to delete User A memory");

    const directARead = await userAResearch
      .from("max_user_memories")
      .select("id")
      .eq("id", ids.memoriesB[0])
      .maybeSingle();
    assert.equal(directARead.error, null);
    assert.equal(directARead.data, null, "RLS exposed User B memory to User A");
    const directAUpdate = await userAResearch
      .from("max_user_memories")
      .update({ content: "Unauthorized reverse cross-user update attempt." })
      .eq("id", ids.memoriesB[0])
      .select("id");
    assert.equal(directAUpdate.error, null);
    assert.deepEqual(directAUpdate.data, [], "RLS allowed User A to update User B memory");
    const directADelete = await userAResearch
      .from("max_user_memories")
      .delete()
      .eq("id", ids.memoriesB[0])
      .select("id");
    assert.equal(directADelete.error, null);
    assert.deepEqual(directADelete.data, [], "RLS allowed User A to delete User B memory");
    report.checks.databaseRlsOwnerIsolation = true;

    failedAt = "verify both semantic retrieval directions and API ownership";
    const retrievalB = await withAuthenticatedUser(
      { userId: userB.id, accessToken: accessTokens.userB },
      () => memoryService.retrieveForQuestion(question),
    );
    assert.deepEqual(retrievalB.memories, [], "User B semantic retrieval returned User A memory");
    const questionForBMemory = "Which programming language do I prefer for backend prototypes?";
    const retrievalAForBMemory = await withAuthenticatedUser(
      { userId: userA.id, accessToken: accessTokens.userA },
      () => memoryService.retrieveForQuestion(questionForBMemory),
    );
    assert.deepEqual(
      retrievalAForBMemory.memories,
      [],
      "User A semantic retrieval returned User B memory",
    );
    const listB = await api.inject({
      method: "GET",
      url: "/api/memories",
      headers: authHeader(accessTokens.userB),
    });
    assert.equal(listB.statusCode, 200);
    assert.deepEqual(
      (listB.json() as Array<{ id: string }>).map((memory) => memory.id).sort(),
      [...ids.memoriesB].sort(),
    );
    const getAAsB = await api.inject({
      method: "GET",
      url: `/api/memories/${ids.memoriesA[0]}`,
      headers: authHeader(accessTokens.userB),
    });
    assert.equal(getAAsB.statusCode, 404);
    const getBAsB = await api.inject({
      method: "GET",
      url: `/api/memories/${ids.memoriesB[0]}`,
      headers: authHeader(accessTokens.userB),
    });
    assert.equal(getBAsB.statusCode, 200);
    const listA = await api.inject({
      method: "GET",
      url: "/api/memories",
      headers: authHeader(accessTokens.userA),
    });
    assert.equal(listA.statusCode, 200);
    assert.deepEqual(
      (listA.json() as Array<{ id: string }>).map((memory) => memory.id).sort(),
      [...ids.memoriesA].sort(),
    );
    const getBAsA = await api.inject({
      method: "GET",
      url: `/api/memories/${ids.memoriesB[0]}`,
      headers: authHeader(accessTokens.userA),
    });
    assert.equal(getBAsA.statusCode, 404);
    report.retrieval = {
      ...report.retrieval!,
      ownerBResults: retrievalB.memories.length,
      ownerACrossUserResults: retrievalAForBMemory.memories.length,
    };
    report.checks.semanticRetrievalUserIsolation = true;

    failedAt = "complete bounded authenticated chat memory integration";
    const chatA = await api.inject({
      method: "POST",
      url: "/api/chat",
      headers: authHeader(accessTokens.userA),
      payload: { message: question },
    });
    assert.equal(chatA.statusCode, 200);
    assert.equal(observations.length, 1);
    assert(
      observations[0]?.includes("Serper"),
      "User A chat did not receive relevant memory context",
    );
    const chatB = await api.inject({
      method: "POST",
      url: "/api/chat",
      headers: authHeader(accessTokens.userB),
      payload: { message: question },
    });
    assert.equal(chatB.statusCode, 200);
    assert.equal(observations.length, 2);
    assert.equal(observations[1], undefined, "User B chat received User A memory context");
    const chatBodyA = chatA.json<{
      answer?: string;
      toolEvents?: Array<{ tool: string; status: string }>;
    }>();
    const chatBodyB = chatB.json<{
      answer?: string;
      toolEvents?: Array<{ tool: string; status: string }>;
    }>();
    assert(chatBodyA.answer && chatBodyB.answer, "one of the chat answer paths did not complete");
    assert(
      chatBodyA.toolEvents?.some(
        (event) => event.tool === "memory_retrieval" && event.status === "complete",
      ),
    );
    assert(
      chatBodyB.toolEvents?.some(
        (event) => event.tool === "memory_retrieval" && event.status === "complete",
      ),
    );
    assert.equal(searchCalls, 0, "the smoke unexpectedly called the search provider");
    assert.equal(chatCompletionCalls, 0, "the smoke unexpectedly called an LLM chat completion");
    report.chat = {
      userAReceivedMemoryContext: true,
      userBReceivedNoMemoryContext: true,
      completedAnswers: 2,
    };
    report.checks.chatIntegration = true;

    failedAt = "cleanup and verify both users' temporary memory rows";
    assert(accessTokens.userA && accessTokens.userB);
    assert(await deleteAndVerifyOwnedMemories(api, accessTokens.userA));
    assert(await deleteAndVerifyOwnedMemories(api, accessTokens.userB));
    report.cleanup = { memoryRowsRemoved: true, usersRemoved: false, temporaryUsersCreated: 2 };
    report.checks.memoryCleanup = true;
    report.status = "PASSED";
  } catch (error) {
    report.failedAt = failedAt;
    report.failure = safeErrorSummary(error);
  } finally {
    requestDeadlineAt = cleanupDeadlineAt;
    let memoryRowsRemoved = true;
    if (api) {
      for (const accessToken of [accessTokens.userA, accessTokens.userB]) {
        if (!accessToken) continue;
        try {
          if (!(await deleteAndVerifyOwnedMemories(api, accessToken))) memoryRowsRemoved = false;
        } catch {
          memoryRowsRemoved = false;
        }
      }
    } else if (ids.memoriesA.length > 0 || ids.memoriesB.length > 0) {
      memoryRowsRemoved = false;
    }
    if (!memoryRowsRemoved) {
      report.cleanup = {
        memoryRowsRemoved: false,
        usersRemoved: report.cleanup?.usersRemoved ?? false,
        temporaryUsersCreated: report.cleanup?.temporaryUsersCreated ?? 0,
      };
      report.status = "FAILED";
      report.failedAt ??= "verify both users' memory cleanup";
    } else if (report.cleanup) {
      report.cleanup.memoryRowsRemoved = true;
    }

    try {
      if (authClientA) await authClientA.auth.signOut();
      if (authClientB) await authClientB.auth.signOut();
    } catch {
      // Deleting the exact temporary users below also revokes their data ownership.
    }

    if (admin && config.SUPABASE_URL && config.SUPABASE_SECRET_KEY) {
      try {
        await cleanupTemporaryAuthUsers(
          admin.auth.admin,
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY,
          [emails.userA, emails.userB],
          [ids.userA, ids.userB],
          request,
        );
        report.cleanup = {
          memoryRowsRemoved: report.cleanup?.memoryRowsRemoved ?? false,
          usersRemoved: true,
          temporaryUsersCreated: Number(Boolean(ids.userA)) + Number(Boolean(ids.userB)),
        };
        report.checks.usersCleanup = true;
      } catch (error) {
        report.cleanup = {
          memoryRowsRemoved: report.cleanup?.memoryRowsRemoved ?? false,
          usersRemoved: false,
          temporaryUsersCreated: Number(Boolean(ids.userA)) + Number(Boolean(ids.userB)),
        };
        report.status = "FAILED";
        report.failedAt ??= "delete and verify exact temporary Auth users";
        report.failure ??= safeErrorSummary(error);
      }
    }

    try {
      if (api) await api.close();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "close Fastify smoke instance";
    }
    try {
      store?.close();
    } catch {
      // Preserve the test result; closing a Supabase store is intentionally a no-op.
    }
    globalThis.fetch = originalFetch;
    try {
      writeReport();
    } catch {
      report.status = "FAILED";
      report.failedAt ??= "write semantic-memory-smoke report";
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASSED") process.exitCode = 1;
}

void main();
