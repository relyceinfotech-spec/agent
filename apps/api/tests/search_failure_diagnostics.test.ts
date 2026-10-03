import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SerperProvider,
  ResilientSearchProvider,
  SearchProviderError,
  type SearchAttempt,
} from "../src/search.js";
import { searchDiagnosticTrace } from "../src/search-diagnostics.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";

afterEach(() => vi.restoreAllMocks());
const query = "Compare current HNSW and IVF vector indexing performance";
const key = "fixture-private-serper-value";
function resilient(request: (...args: never[]) => unknown) {
  return new ResilientSearchProvider([
    { name: "serper", provider: new SerperProvider(key, request as never) },
  ]);
}

describe("sanitized Serper failure diagnostics", () => {
  it.each(["TimeoutError", "AbortError"])("retains %s as a timeout", async (name) => {
    const error = new Error("Search request timed out");
    error.name = name;
    const search = resilient(
      vi.fn(async () => {
        throw error;
      }),
    );
    const batch = await search.searchDetailed(query);
    expect(batch.attempts[0]).toMatchObject({
      provider: "serper",
      attemptNumber: 1,
      stage: "SEARCH_PROVIDER",
      status: "failed",
      errorCode: "PROVIDER_TIMEOUT",
      failureType: "timeout",
    });
    expect(batch.attempts[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(batch.attempts[0].startedAt!))).toBe(true);
  });
  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])(
    "retains transport cause %s",
    async (code) => {
      const search = resilient(
        vi.fn(async () => {
          throw new TypeError("fetch failed", { cause: { code } });
        }),
      );
      const batch = await search.searchDetailed(query);
      expect(batch.attempts[0]).toMatchObject({
        transportCode: code,
        errorCode: code.includes("TIMEOUT") ? "PROVIDER_TIMEOUT" : "NETWORK_ERROR",
        failureType: code.includes("TIMEOUT") ? "timeout" : "network",
      });
    },
  );
  it.each([
    [401, "INVALID_CREDENTIALS"],
    [403, "INVALID_CREDENTIALS"],
    [402, "CREDITS_EXHAUSTED"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
  ])("retains HTTP %s independently of the terminal outcome", async (status, errorCode) => {
    const dispose = vi.fn(async () => undefined);
    const batch = await resilient(
      vi.fn(async () => ({
        response: new Response(`secret provider body ${key}`, { status: status as number }),
        dispose,
      })),
    ).searchDetailed(query);
    expect(batch.attempts[0]).toMatchObject({
      httpStatus: status,
      errorCode,
      failureType: "http",
      stage: "SEARCH_PROVIDER",
    });
    expect(JSON.stringify(batch)).not.toContain(key);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("retains a terminal HTTP status thrown by the retry transport", async () => {
    const batch = await resilient(
      vi.fn(async () => {
        throw new Error("Retryable HTTP status 503");
      }),
    ).searchDetailed(query);
    expect(batch.attempts[0]).toMatchObject({
      httpStatus: 503,
      errorCode: "PROVIDER_UNAVAILABLE",
      failureType: "http",
    });
  });
  it.each(["not JSON", "null", "[]", '{"organic":{}}', '{"organic":[null]}'])(
    "records malformed successful response %s without the body",
    async (body) => {
      const batch = await resilient(
        vi.fn(async () => ({ response: new Response(body), dispose: async () => undefined })),
      ).searchDetailed(query);
      expect(batch.attempts[0]).toMatchObject({
        httpStatus: 200,
        errorCode: "MALFORMED_RESPONSE",
        failureType: "malformed_response",
        status: "failed",
      });
      expect(batch.attempts[0].error).toMatch(/malformed/);
    },
  );
  it("preserves successful and valid empty search behavior", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            organic: [
              {
                title: "Technical comparison",
                link: "https://fixture.example.org/indexes",
                snippet: "Measured latency",
              },
            ],
          }),
        ),
        dispose: async () => undefined,
      })
      .mockResolvedValueOnce({
        response: new Response('{"organic":[]}'),
        dispose: async () => undefined,
      });
    const search = resilient(request);
    const success = await search.searchDetailed(query);
    expect(success.results).toMatchObject([
      {
        title: "Technical comparison",
        url: "https://fixture.example.org/indexes",
        snippet: "Measured latency",
        provider: "serper",
      },
    ]);
    expect(success.attempts[0]).toMatchObject({ status: "success", resultCount: 1 });
    expect(success.attempts[0].errorCode).toBeUndefined();
    expect((await search.searchDetailed(query)).attempts[0].status).toBe("empty");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("redacts configured request keys, authorization/cookie headers and payloads before recording", async () => {
    const batch = await resilient(
      vi.fn(async () => {
        throw new Error(
          `fetch failed ${key}; authorization: Bearer authorization-private; x-api-key: header-private; cookie: session=cookie-private; body: provider-private`,
        );
      }),
    ).searchDetailed(query);
    const serialized = JSON.stringify(searchDiagnosticTrace(batch.attempts));
    for (const secret of [
      key,
      "authorization-private",
      "header-private",
      "cookie-private",
      "provider-private",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("NETWORK_ERROR");
  });
  it("records direct adapter failures through the tool callback with their provider identity", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => {
          throw new SearchProviderError("serper", "Serper returned HTTP 429", "RATE_LIMITED", 429);
        },
      },
      llm,
    );
    const attempts: SearchAttempt[] = [];
    await expect(
      registry.execute("web_search", {
        queries: [query],
        onSearchAttempt: (attempt: SearchAttempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow("All search providers failed");
    expect(attempts[0]).toMatchObject({
      provider: "serper",
      httpStatus: 429,
      errorCode: "RATE_LIMITED",
      stage: "SEARCH_PROVIDER",
    });
  });
  it("trace serialization whitelists fields and numbers each provider's recovery attempts", () => {
    const attempt = {
      provider: "serper",
      query,
      status: "failed",
      resultCount: 0,
      durationMs: 1,
      error: "authorization: Bearer private-value",
      headers: { "x-api-key": "never-copy" },
      responseBody: "never-copy",
    };
    const trace = searchDiagnosticTrace([
      attempt as SearchAttempt,
      { ...attempt, provider: "internal-knowledge" } as SearchAttempt,
      attempt as SearchAttempt,
    ]);
    expect(trace.map((value) => value.attemptNumber)).toEqual([1, 1, 2]);
    expect(JSON.stringify(trace)).not.toMatch(/private-value|never-copy|responseBody|headers/);
  });
  it("preserves independent initial/recovery failures in session, durable job and HTTP readback", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(`fetch failed ${key}`, { cause: { code: "ENOTFOUND" } }))
      .mockResolvedValueOnce({
        response: new Response("provider body", { status: 429 }),
        dispose: async () => undefined,
      });
    const search = resilient(request);
    const llm = new OpenRouterProvider();
    vi.spyOn(llm, "enabled", "get").mockReturnValue(false);
    const complete = vi
      .spyOn(llm, "complete")
      .mockRejectedValue(new Error("Unexpected model invocation"));
    const store = new SqliteSessionStore(":memory:");
    const jobs = new InMemoryDurableJobStore();
    const app = await createServer({
      store,
      jobStore: jobs,
      searchProvider: search,
      llmProvider: llm,
      authVerifier: { verifyAccessToken: async () => ({ id: "diagnostics-fixture-user" }) },
      memoryService: {
        enabled: false,
        retrieveForQuestion: async () => ({ needed: false, memories: [] }),
      } as never,
      researchBudget: {
        maxQueries: 2,
        maxPages: 3,
        maxSources: 3,
        maxSteps: 14,
        maxSearchPasses: 1,
        maxModelDecisions: 0,
        maxTimeMs: 5000,
      },
    });
    try {
      const headers = { authorization: "Bearer diagnostics-fixture" };
      const enqueue = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers,
        payload: { message: query, deepResearch: false },
      });
      expect(enqueue.statusCode).toBe(202);
      const queued = enqueue.json();
      await getServerBackgroundServices(app).worker.runNow(queued.jobId);
      const readback = await app.inject({
        method: "GET",
        url: `/api/research/${queued.researchId}`,
        headers,
      });
      const session = readback.json();
      expect(session.status).toBe("FAILED");
      expect(session.error).toMatch(/^INSUFFICIENT_EVIDENCE/);
      const attempts = session.searchAttempts.filter(
        (attempt: SearchAttempt) => attempt.provider === "serper",
      );
      expect(attempts).toMatchObject([
        {
          attemptNumber: 1,
          transportCode: "ENOTFOUND",
          errorCode: "NETWORK_ERROR",
          failureType: "network",
        },
        { attemptNumber: 2, httpStatus: 429, errorCode: "RATE_LIMITED", failureType: "http" },
      ]);
      const jobReadback = await app.inject({
        method: "GET",
        url: `/api/jobs/${queued.jobId}`,
        headers,
      });
      expect(jobReadback.statusCode).toBe(200);
      const job = jobReadback.json();
      expect(job.status).toBe("failed");
      expect(job.progress.searchAttempts).toEqual(session.searchAttempts);
      expect(searchDiagnosticTrace(session.searchAttempts)).toEqual(session.searchAttempts);
      expect(JSON.stringify({ session, job })).not.toContain(key);
      expect(session.sources).toEqual([]);
      expect(session.claims).toEqual([]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
