import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORK_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EMBEDDING_TIMEOUT_MS = 20_000;
const MAX_INSPECTED_RESPONSE_BYTES = 256 * 1024;
const REPORT_PATH = join(
  process.cwd(),
  "evaluation-results",
  "semantic-memory-embedding-diagnostic.json",
);

interface SafeProviderResponse {
  status: number;
  contentType?: string;
  contentEncoding?: string;
  contentLength?: string;
  bodyBytesObserved: number;
  bodyTruncated: boolean;
  bodyFormat: "empty" | "json" | "html" | "text" | "binary" | "truncated";
  bodySha256?: string;
  jsonValid: boolean | null;
  providerModel?: string;
  errorCategory?: string;
  errorCode?: string;
  errorType?: string;
  safeMessage?: string;
  promptTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

function boundedFetch(fetchImpl: typeof fetch, deadline: () => number): typeof fetch {
  return async (input, init = {}) => {
    const remainingMs = deadline() - Date.now();
    if (remainingMs <= 0) throw new Error("Embedding diagnostic deadline expired");

    const signals: AbortSignal[] = [AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs))];
    if (input instanceof Request && input.signal) signals.push(input.signal);
    if (init.signal) signals.push(init.signal);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function safeToken(value: unknown, sensitiveValues: readonly string[] = []): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    sensitiveValues.some((sensitiveValue) => sensitiveValue && trimmed.includes(sensitiveValue)) ||
    /sk-or-v1-|\bsb_(?:secret|publishable)_|\beyJ[A-Za-z0-9_-]{10,}\.|@|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
      trimmed,
    )
  ) {
    return undefined;
  }
  return /^[a-z0-9_.:/+-]{1,120}$/i.test(trimmed) ? trimmed : undefined;
}

function safeEndpoint(url: URL, sensitiveValues: readonly string[] = []): string {
  return sanitizeMessage(`${url.origin}${url.pathname}`, sensitiveValues) ?? "[redacted-endpoint]";
}

function responseCategory(
  status: number,
  jsonValid: boolean | null,
  bodyTruncated = false,
): string {
  if (status >= 200 && status < 300)
    return bodyTruncated
      ? "truncated_success_payload"
      : jsonValid
        ? "success_payload"
        : "invalid_success_payload";
  if (status === 400 || status === 422) return "request_validation";
  if (status === 401 || status === 403) return "authentication_or_permission";
  if (status === 404) return "endpoint_or_model_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_or_credit_limit";
  if (status >= 500) return "provider_or_gateway_failure";
  return "http_error";
}

function sanitizeMessage(message: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (typeof message !== "string") return undefined;
  let value = message;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) value = value.split(sensitiveValue).join("[redacted-diagnostic-value]");
  }
  return value
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/gi, "[redacted-key]")
    .replace(/\bsk[-_][A-Za-z0-9_-]{16,}\b/gi, "[redacted-key]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gi, "[redacted-key]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted-token]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

async function inspectResponse(
  response: Response,
  sensitiveValues: readonly string[],
): Promise<SafeProviderResponse> {
  const reader = response.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let bodyBytesObserved = 0;
  let bodyTruncated = false;

  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const room = MAX_INSPECTED_RESPONSE_BYTES - bodyBytesObserved;
        if (value.byteLength > room) {
          if (room > 0) {
            chunks.push(value.slice(0, room));
            bodyBytesObserved += room;
          }
          bodyTruncated = true;
          void reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        bodyBytesObserved += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(bodyBytesObserved);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let parsed: Record<string, unknown> | undefined;
  let jsonValid: boolean | null = bodyTruncated ? null : false;
  if (!bodyTruncated && bodyBytesObserved > 0) {
    try {
      const value: unknown = JSON.parse(decoded);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }

  const errorValue =
    parsed?.error && typeof parsed.error === "object"
      ? (parsed.error as Record<string, unknown>)
      : parsed;
  const contentType = response.headers.get("content-type") ?? undefined;
  const isHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(decoded);
  const hasBinaryControl = /[\u0000-\u0008\u000e-\u001f\u007f]/.test(decoded);
  const bodyFormat: SafeProviderResponse["bodyFormat"] = bodyTruncated
    ? "truncated"
    : bodyBytesObserved === 0
      ? "empty"
      : jsonValid
        ? "json"
        : isHtml || contentType?.toLowerCase().includes("text/html")
          ? "html"
          : hasBinaryControl
            ? "binary"
            : "text";
  const status = response.status;
  const code = safeToken(errorValue?.code, sensitiveValues);
  const type = safeToken(errorValue?.type, sensitiveValues);
  const responseModel = safeToken(parsed?.model, sensitiveValues);
  const usage =
    parsed?.usage && typeof parsed.usage === "object"
      ? (parsed.usage as Record<string, unknown>)
      : undefined;
  const promptTokens = usage?.prompt_tokens;
  const totalTokens = usage?.total_tokens;
  const costUsd = usage?.cost;
  const message = sanitizeMessage(errorValue?.message, sensitiveValues);

  return {
    status,
    ...(contentType ? { contentType } : {}),
    ...(response.headers.get("content-encoding")
      ? { contentEncoding: response.headers.get("content-encoding")! }
      : {}),
    ...(response.headers.get("content-length")
      ? { contentLength: response.headers.get("content-length")! }
      : {}),
    bodyBytesObserved,
    bodyTruncated,
    bodyFormat,
    ...(bodyBytesObserved > 0
      ? { bodySha256: createHash("sha256").update(bytes).digest("hex") }
      : {}),
    jsonValid,
    ...(responseModel ? { providerModel: responseModel } : {}),
    errorCategory: responseCategory(status, jsonValid, bodyTruncated),
    ...(code ? { errorCode: code } : {}),
    ...(type ? { errorType: type } : {}),
    ...(message ? { safeMessage: message } : {}),
    ...(typeof promptTokens === "number" && Number.isFinite(promptTokens) ? { promptTokens } : {}),
    ...(typeof totalTokens === "number" && Number.isFinite(totalTokens) ? { totalTokens } : {}),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function safeThrownError(error: unknown, sensitiveValues: readonly string[]) {
  const value = error instanceof Error ? error : new Error("Unknown diagnostic failure");
  const safeMessage = sanitizeMessage(value.message, sensitiveValues);
  return {
    name: /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.name) ? value.name : "Error",
    ...(safeMessage ? { message: safeMessage } : {}),
  };
}

async function main() {
  // Keep Fastify's initialization from resuming or scheduling any Post Agent work.
  process.env.NODE_ENV = "test";

  const [
    { createClient },
    { config },
    { OpenRouterEmbeddingProvider },
    { UserMemoryService },
    { QuotaPolicy },
    { SupabaseAuthVerifier },
    { createServer },
    { createSupabaseFetch, SupabaseStore },
    { ToolRegistry },
    { cleanupTemporaryAuthUsers, createAuthUserWithReconciliation },
  ] = await Promise.all([
    import("@supabase/supabase-js"),
    import("../config.js"),
    import("../embeddings.js"),
    import("../memory.js"),
    import("../quota-policy.js"),
    import("../auth.js"),
    import("../server.js"),
    import("../supabase-store.js"),
    import("../agent/tools.js"),
    import("./auth-smoke-cleanup.js"),
  ]);

  const startedAtMs = Date.now();
  const workDeadlineAt = startedAtMs + WORK_TIMEOUT_MS;
  const cleanupDeadlineAt = startedAtMs + TOTAL_TIMEOUT_MS;
  let activeDeadlineAt = workDeadlineAt;
  const originalFetch = globalThis.fetch;
  const nativeFetch = originalFetch.bind(globalThis);
  const boundedRequest = boundedFetch(nativeFetch, () => activeDeadlineAt);
  globalThis.fetch = boundedRequest;

  const randomSuffix = randomUUID();
  const email = `max-memory-embedding-${randomSuffix}@example.com`;
  const password = `${randomUUID()}!eE7`;
  const memoryText = `Diagnostic-only MAX embedding probe ${randomUUID()}.`;
  const sensitiveValues = [email, password, memoryText];
  const endpoint = new URL(`${config.EMBEDDING_BASE_URL.replace(/\/+$/, "")}/embeddings`);
  const effectiveEmbeddingTimeoutMs = EMBEDDING_TIMEOUT_MS;
  const report: Record<string, unknown> = {
    status: "FAILED",
    startedAt: new Date(startedAtMs).toISOString(),
    budgets: {
      workTimeoutMs: WORK_TIMEOUT_MS,
      totalTimeoutMs: TOTAL_TIMEOUT_MS,
      cleanupReserveMs: TOTAL_TIMEOUT_MS - WORK_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      configuredEmbeddingTimeoutMs: config.EMBEDDING_TIMEOUT_MS,
      effectiveEmbeddingTimeoutMs,
      maxTemporaryUsers: 1,
      maxTemporaryMemories: 1,
      maxEmbeddingRequests: 1,
    },
    configuration: {
      memoryEnabled: config.MEMORY_ENABLED,
      provider: config.EMBEDDING_PROVIDER,
      model: config.EMBEDDING_MODEL,
      endpoint: safeEndpoint(endpoint, sensitiveValues),
      requestedDimensions: config.EMBEDDING_DIMENSIONS,
      requestedFormat: "JSON; input is a one-item string array; encoding_format=float",
    },
    auth: { createAttempted: false, userCreated: false, authenticated: false },
    memory: { createAttempted: false, stored: false, readBackVerified: false, deleted: false },
    embedding: { requestCount: 0, response: undefined, failure: undefined, usage: undefined },
    otherProviders: { serperCalls: 0, chatCompletionCalls: 0 },
    cleanup: { memoryRowsRemoved: false, userRemoved: false, verified: false },
  };

  let admin: ReturnType<typeof createClient<any>> | undefined;
  let authClient: ReturnType<typeof createClient<any>> | undefined;
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let store: InstanceType<typeof SupabaseStore> | undefined;
  let userId: string | undefined;
  let accessToken: string | undefined;
  let createAttempted = false;
  let embeddingRequestCount = 0;
  let searchCalls = 0;
  let chatCompletionCalls = 0;
  let memoryId: string | undefined;
  let apiMemoryListVerifiedEmpty = false;
  let failureStage = "preflight";
  const supabaseFetch = createSupabaseFetch();

  const writeReport = () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAtMs;
    if (report.status === "FAILED") report.failedAt ??= failureStage;
    else report.completedAt = "embedding request, memory read-back, and cleanup verified";
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
      throw new Error("Diagnostic requires configured Supabase and OpenRouter embeddings");
    }
    if (Date.now() >= workDeadlineAt)
      throw new Error("Diagnostic work deadline expired at preflight");

    failureStage = "initialize bounded clients and Fastify dependencies";
    admin = createClient<any>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: supabaseFetch },
    });
    authClient = createClient<any>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: supabaseFetch },
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

    const rawEmbeddingProvider = new OpenRouterEmbeddingProvider({
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.EMBEDDING_BASE_URL,
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      timeoutMs: effectiveEmbeddingTimeoutMs,
      fetchImplementation: async (input, init) => {
        embeddingRequestCount += 1;
        const embeddingReport = report.embedding as Record<string, unknown>;
        embeddingReport.requestCount = embeddingRequestCount;
        if (embeddingRequestCount !== 1) {
          throw new Error("Diagnostic refused a second embedding request");
        }
        const actualUrl = new URL(
          typeof input === "string" || input instanceof URL ? String(input) : input.url,
        );
        let requestBody: Record<string, unknown> | undefined;
        if (typeof init?.body === "string") {
          try {
            const parsed: unknown = JSON.parse(init.body);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              requestBody = parsed as Record<string, unknown>;
            }
          } catch {
            requestBody = undefined;
          }
        }
        const requestInput = requestBody?.input;
        embeddingReport.request = {
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          endpoint: safeEndpoint(actualUrl, sensitiveValues),
          contentType: new Headers(init?.headers).get("content-type") ?? undefined,
          accept: new Headers(init?.headers).get("accept") ?? undefined,
          acceptEncoding: new Headers(init?.headers).get("accept-encoding") ?? undefined,
          inputFormat: "JSON",
          inputType: Array.isArray(requestInput) ? "array" : typeof requestInput,
          inputCount: Array.isArray(requestInput) ? requestInput.length : undefined,
          inputItemLengths:
            Array.isArray(requestInput) && requestInput.every((item) => typeof item === "string")
              ? requestInput.map((item) => (item as string).length)
              : undefined,
          model: safeToken(requestBody?.model, sensitiveValues) ?? "unavailable",
          dimensions:
            typeof requestBody?.dimensions === "number" ? requestBody.dimensions : undefined,
          encodingFormat: safeToken(requestBody?.encoding_format, sensitiveValues) ?? "unavailable",
          timeoutMs: effectiveEmbeddingTimeoutMs,
        };
        const requestStartedAt = Date.now();
        const remainingMs = activeDeadlineAt - requestStartedAt;
        const timeoutSignal = AbortSignal.timeout(
          Math.max(1, Math.min(effectiveEmbeddingTimeoutMs, remainingMs)),
        );
        const signals: AbortSignal[] = [timeoutSignal];
        if (input instanceof Request && input.signal) signals.push(input.signal);
        if (init?.signal) signals.push(init.signal);
        const effectiveSignal = AbortSignal.any(signals);
        try {
          const response = await nativeFetch(input, { ...init, signal: effectiveSignal });
          const safeResponse = await inspectResponse(response, sensitiveValues);
          embeddingReport.response = safeResponse;
          embeddingReport.responseUsage = {
            ...(typeof safeResponse.promptTokens === "number"
              ? { promptTokens: safeResponse.promptTokens }
              : {}),
            ...(typeof safeResponse.totalTokens === "number"
              ? { totalTokens: safeResponse.totalTokens }
              : {}),
            ...(typeof safeResponse.costUsd === "number" ? { costUsd: safeResponse.costUsd } : {}),
          };
          embeddingReport.elapsedMs = Date.now() - requestStartedAt;
          return response;
        } catch (error) {
          embeddingReport.elapsedMs = Date.now() - requestStartedAt;
          const safeError = safeThrownError(error, sensitiveValues);
          const timeoutSource = init?.signal?.aborted
            ? "embedding_provider_timeout"
            : timeoutSignal.aborted
              ? remainingMs < effectiveEmbeddingTimeoutMs
                ? "session_deadline"
                : "diagnostic_request_timeout"
              : undefined;
          embeddingReport.failure = {
            ...safeError,
            category: timeoutSource
              ? "timeout_or_abort"
              : safeError.name === "TypeError"
                ? "fetch_or_network_error"
                : "request_error",
            signalAborted: effectiveSignal.aborted,
            ...(timeoutSource ? { timeoutSource } : {}),
          };
          throw error;
        }
      },
    });
    const embeddingProvider = {
      providerName: rawEmbeddingProvider.providerName,
      model: rawEmbeddingProvider.model,
      async embedMany(texts: string[]) {
        try {
          const result = await rawEmbeddingProvider.embedMany(texts);
          const embeddingReport = report.embedding as Record<string, unknown>;
          embeddingReport.responseModel = result.model;
          embeddingReport.returnedVectorDimensions = result.vectors.map((vector) => vector.length);
          embeddingReport.usage = {
            ...(typeof result.usage?.promptTokens === "number"
              ? { promptTokens: result.usage.promptTokens }
              : {}),
            ...(typeof result.usage?.totalTokens === "number"
              ? { totalTokens: result.usage.totalTokens }
              : {}),
            ...(typeof result.usage?.costUsd === "number" ? { costUsd: result.usage.costUsd } : {}),
          };
          return result;
        } catch (error) {
          const embeddingReport = report.embedding as Record<string, unknown>;
          const response = embeddingReport.response as SafeProviderResponse | undefined;
          const fetchFailure = embeddingReport.failure as Record<string, unknown> | undefined;
          const errorFields =
            error && typeof error === "object" ? (error as Record<string, unknown>) : {};
          embeddingReport.failure = {
            ...(fetchFailure ?? {}),
            ...safeThrownError(error, sensitiveValues),
            ...(errorFields.code === "EMBEDDING_RESPONSE_INVALID"
              ? { code: errorFields.code }
              : {}),
            ...(typeof errorFields.reason === "string" &&
            [
              "invalid_utf8",
              "invalid_json",
              "invalid_response_shape",
              "invalid_batch",
              "invalid_index",
              "invalid_vector",
            ].includes(errorFields.reason)
              ? { reason: errorFields.reason }
              : {}),
            category:
              (typeof fetchFailure?.category === "string" ? fetchFailure.category : undefined) ??
              response?.errorCategory ??
              (embeddingRequestCount === 0 ? "request_not_sent" : "provider_response_error"),
            signalAborted:
              typeof fetchFailure?.signalAborted === "boolean"
                ? fetchFailure.signalAborted
                : Boolean((error as { name?: unknown } | null)?.name === "AbortError"),
          };
          throw error;
        }
      },
    };

    const memoryService = new UserMemoryService(store, embeddingProvider);
    const llmProvider = new Proxy(
      { enabled: true },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => {
            chatCompletionCalls += 1;
            throw new Error("Unexpected chat-completion call in embedding diagnostic");
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
        boundedRequest,
      ),
      quotaPolicy: new QuotaPolicy(),
      searchProvider: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      llmProvider,
      toolRegistry: new ToolRegistry(),
    });

    failureStage = "create exactly one temporary Auth user";
    createAttempted = true;
    (report.auth as Record<string, unknown>).createAttempted = true;
    const user = await createAuthUserWithReconciliation(
      () =>
        admin!.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        }),
      config.SUPABASE_URL,
      config.SUPABASE_SECRET_KEY,
      email,
      {
        request: boundedRequest,
        stopAfterUncertainCreate: true,
        onReconciledUser: (reconciled) => {
          userId = reconciled.id;
        },
      },
    );
    userId = user.id;
    (report.auth as Record<string, unknown>).userCreated = true;

    failureStage = "authenticate the temporary user";
    const signIn = await authClient.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session?.access_token) {
      const value = signIn.error as { status?: unknown; code?: unknown } | null;
      throw new Error(
        `Temporary user sign-in failed (status=${typeof value?.status === "number" ? value.status : "unknown"}; code=${safeToken(value?.code) ?? "unavailable"})`,
      );
    }
    accessToken = signIn.data.session.access_token;
    (report.auth as Record<string, unknown>).authenticated = true;
    (report.auth as Record<string, unknown>).signInStatus = "success";

    failureStage = "create one memory through authenticated Fastify endpoint";
    (report.memory as Record<string, unknown>).createAttempted = true;
    const created = await api.inject({
      method: "POST",
      url: "/api/memories",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { text: memoryText },
    });
    (report.memory as Record<string, unknown>).createHttpStatus = created.statusCode;
    const embeddingReport = report.embedding as Record<string, unknown>;
    if (created.statusCode !== 201) {
      throw new Error(`Fastify memory creation returned HTTP ${created.statusCode}`);
    }
    const createdBody = created.json() as { memory?: { id?: unknown } };
    if (typeof createdBody.memory?.id !== "string") {
      throw new Error("Fastify memory creation response omitted a memory ID");
    }
    memoryId = createdBody.memory.id;
    (report.memory as Record<string, unknown>).stored = true;
    (report.memory as Record<string, unknown>).idHash = createHash("sha256")
      .update(memoryId)
      .digest("hex")
      .slice(0, 12);

    failureStage = "read the created memory back through authenticated Fastify";
    const readBack = await api.inject({
      method: "GET",
      url: `/api/memories/${encodeURIComponent(memoryId)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (readBack.statusCode !== 200) {
      throw new Error(`Fastify memory read-back returned HTTP ${readBack.statusCode}`);
    }
    const readMemory = readBack.json() as { id?: unknown; content?: unknown };
    assert.equal(readMemory.id, memoryId);
    assert.equal(readMemory.content, memoryText);
    (report.memory as Record<string, unknown>).readBackVerified = true;
    (report.status as string) = "PASSED";
    failureStage = "completed; cleanup pending";
  } catch (error) {
    report.failedAt = failureStage;
    report.failure = safeThrownError(error, sensitiveValues);
    report.status = "FAILED";
    const embeddingReport = report.embedding as Record<string, unknown>;
    if (embeddingRequestCount === 0 && failureStage.includes("memory")) {
      embeddingReport.failure ??= {
        category: "embedding_request_not_reached",
        ...safeThrownError(error, sensitiveValues),
      };
    }
  } finally {
    activeDeadlineAt = cleanupDeadlineAt;
    (report.auth as Record<string, unknown>).userCreated = Boolean(userId);
    (report.otherProviders as Record<string, unknown>).serperCalls = searchCalls;
    (report.otherProviders as Record<string, unknown>).chatCompletionCalls = chatCompletionCalls;

    if (api && accessToken) {
      failureStage = "delete temporary memories and verify no residual rows";
      try {
        const list = await api.inject({
          method: "GET",
          url: "/api/memories?limit=50&includeInactive=true",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (list.statusCode !== 200) throw new Error("Could not list temporary user's memories");
        const memories = list.json() as Array<{ id?: unknown }>;
        if (!Array.isArray(memories) || memories.some((item) => typeof item.id !== "string")) {
          throw new Error("Temporary memory list was malformed");
        }
        for (const item of memories) {
          const deleted = await api.inject({
            method: "DELETE",
            url: `/api/memories/${encodeURIComponent(item.id as string)}`,
            headers: { authorization: `Bearer ${accessToken}` },
          });
          if (deleted.statusCode !== 204) throw new Error("Could not delete a temporary memory");
          if (item.id === memoryId) (report.memory as Record<string, unknown>).deleted = true;
        }
        const verify = await api.inject({
          method: "GET",
          url: "/api/memories?limit=50&includeInactive=true",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        apiMemoryListVerifiedEmpty =
          verify.statusCode === 200 && Array.isArray(verify.json()) && verify.json().length === 0;
        if (!apiMemoryListVerifiedEmpty)
          throw new Error("Temporary memory rows remain after cleanup");
        (report.cleanup as Record<string, unknown>).memoryRowsRemoved = true;
        (report.memory as Record<string, unknown>).residualRowsVerifiedZero = true;
      } catch (error) {
        report.failedAt = failureStage;
        (report.cleanup as Record<string, unknown>).memoryCleanupError = safeThrownError(
          error,
          sensitiveValues,
        );
        report.status = "FAILED";
        report.failure ??= safeThrownError(error, sensitiveValues);
      }
    } else if (!createAttempted) {
      apiMemoryListVerifiedEmpty = true;
      (report.cleanup as Record<string, unknown>).memoryRowsRemoved = true;
      (report.memory as Record<string, unknown>).residualRowsVerifiedZero = true;
    } else if (accessToken) {
      apiMemoryListVerifiedEmpty = false;
    } else {
      // A newly created Auth user with no sign-in token cannot have passed the memory route.
      apiMemoryListVerifiedEmpty = !memoryId;
      (report.cleanup as Record<string, unknown>).memoryRowsRemoved = apiMemoryListVerifiedEmpty;
    }

    try {
      if (authClient) await authClient.auth.signOut();
    } catch {
      // Exact temporary-user deletion below also revokes this test session.
    }

    if (admin && createAttempted && config.SUPABASE_URL && config.SUPABASE_SECRET_KEY) {
      failureStage = "delete exact temporary Auth user and verify cleanup";
      try {
        await cleanupTemporaryAuthUsers(
          admin.auth.admin,
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY,
          [email],
          [userId],
          boundedRequest,
        );
        (report.cleanup as Record<string, unknown>).userRemoved = true;
        (report.cleanup as Record<string, unknown>).exactEmailMatchesAfterDelete = 0;
      } catch (error) {
        report.failedAt = failureStage;
        (report.cleanup as Record<string, unknown>).userRemoved = false;
        (report.cleanup as Record<string, unknown>).userCleanupError = safeThrownError(
          error,
          sensitiveValues,
        );
        report.status = "FAILED";
        report.failure ??= safeThrownError(error, sensitiveValues);
      }
    } else {
      (report.cleanup as Record<string, unknown>).userRemoved = !createAttempted;
      (report.cleanup as Record<string, unknown>).exactEmailMatchesAfterDelete = createAttempted
        ? "not_verified"
        : 0;
    }

    (report.cleanup as Record<string, unknown>).verified =
      Boolean((report.cleanup as Record<string, unknown>).memoryRowsRemoved) &&
      Boolean((report.cleanup as Record<string, unknown>).userRemoved);
    if (!(report.cleanup as Record<string, unknown>).verified) report.status = "FAILED";

    try {
      if (api) await api.close();
    } catch {
      report.status = "FAILED";
      report.failure ??= { name: "Error", message: "Fastify diagnostic instance failed to close" };
    }
    try {
      store?.close();
    } catch {
      // SupabaseStore.close is intentionally a no-op.
    }

    globalThis.fetch = originalFetch;
    try {
      writeReport();
    } catch {
      report.status = "FAILED";
      report.reportWriteFailed = true;
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASSED" || !apiMemoryListVerifiedEmpty) process.exitCode = 1;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("semantic-memory-embedding-diagnostic.ts")) {
  void main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "FAILED", failure: safeThrownError(error, []) })}\n`,
    );
    process.exitCode = 1;
  });
}

export const semanticMemoryEmbeddingDiagnosticInternals = {
  inspectResponse,
  responseCategory,
  sanitizeMessage,
};
