import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { OpenRouterProvider } from "../src/llm.js";
import { withOperationContext } from "../src/operation-context.js";
import { ResearchRunner } from "../src/research.js";
import {
  remainingResearchTimeMs,
  runWithResearchExecutionContext,
} from "../src/execution-context.js";
import { readBoundedText, safeFetchWithRetry } from "../src/security.js";
import { MemorySessionStore } from "../src/store.js";
import { createToolRegistry, ToolRegistry } from "../src/agent/tools.js";
import { DurableQueueWorker, InMemoryDurableJobStore } from "../src/jobs.js";
import type { Claim, SearchResult } from "../src/domain.js";

const originalKey = config.OPENROUTER_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  config.OPENROUTER_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function createHangingFetch() {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected the controller to pass an abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(new Error("Request aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("Request aborted")), {
          once: true,
        });
      }),
  );
}

async function waitForTerminal(store: MemorySessionStore, id: string) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const session = await store.get(id);
    if (session && ["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Research session did not reach a terminal state");
}

async function waitForJobTerminal(store: InMemoryDurableJobStore, id: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = await store.getJob(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Durable research job did not reach a terminal state");
}

describe("research execution deadline and cancellation", () => {
  it("refuses to begin source retrieval after the session is cancelled or expired", async () => {
    const deadlineController = new AbortController();
    await expect(
      runWithResearchExecutionContext(
        { deadlineAt: Date.now() - 1, signal: deadlineController.signal },
        () => safeFetchWithRetry("https://example.org"),
      ),
    ).rejects.toThrow("Research session deadline exhausted");

    const cancelledController = new AbortController();
    cancelledController.abort();
    await expect(
      runWithResearchExecutionContext(
        { deadlineAt: Date.now() + 10_000, signal: cancelledController.signal },
        () => safeFetchWithRetry("https://example.org"),
      ),
    ).rejects.toThrow("Research execution was cancelled");
  });

  it("calculates operation timeouts from the remaining research deadline", async () => {
    const controller = new AbortController();
    const context = { deadlineAt: Date.now() + 100, signal: controller.signal };
    await runWithResearchExecutionContext(context, async () => {
      const remaining = remainingResearchTimeMs(500);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(100);
    });
    await expect(
      runWithResearchExecutionContext(
        { deadlineAt: Date.now() - 1, signal: new AbortController().signal },
        async () => remainingResearchTimeMs(500),
      ),
    ).rejects.toThrow("Research session deadline exhausted");
  });

  it("aborts response-body reads when the shared research deadline expires", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
    );
    const deadlineAt = Date.now() + 1000;
    const timer = setTimeout(
      () => controller.abort(new Error("Research time budget exhausted")),
      25,
    );
    try {
      await expect(
        runWithResearchExecutionContext({ deadlineAt, signal: controller.signal }, () =>
          readBoundedText(response, 1024, 5000),
        ),
      ).rejects.toThrow("Research time budget exhausted");
      expect(controller.signal.aborted).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("keeps overlapping sessions on their own deadlines when they share an LLM provider", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      if (request.messages[1]?.content === "short-session") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Request aborted")), {
            once: true,
          });
        });
      }
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({ choices: [{ message: { content: "Long session answer" } }] }),
                { headers: { "content-type": "application/json" } },
              ),
            ),
          80,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Request aborted"));
          },
          { once: true },
        );
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const llm = new OpenRouterProvider(1000);
    llm.setDeadline(Date.now() + 10);
    const shortController = new AbortController();
    const longController = new AbortController();

    const [shortResult, longResult] = await Promise.allSettled([
      runWithResearchExecutionContext(
        { deadlineAt: Date.now() + 40, signal: shortController.signal },
        () => llm.complete("System", "short-session"),
      ),
      runWithResearchExecutionContext(
        { deadlineAt: Date.now() + 500, signal: longController.signal },
        () => llm.complete("System", "long-session"),
      ),
    ]);

    expect(shortResult.status).toBe("rejected");
    expect(longResult).toMatchObject({ status: "fulfilled", value: "Long session answer" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the session time limit expires before verified evidence is available", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = createHangingFetch();
    globalThis.fetch = fetchMock as typeof fetch;
    const llm = new OpenRouterProvider(5000);
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [] }, llm, new ToolRegistry(), {
      // Leave enough room for the async research pipeline to enter the mocked
      // provider call even when the full serialized suite is under load.
      maxTimeMs: 250,
    });

    await withOperationContext(async () => {
      const started = await runner.start(
        "Summarize recent discoveries in quantum computing and fusion energy",
        "quick",
      );
      const completed = await waitForTerminal(store, started.id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(llm.metrics.failures).toBe(1);
      expect(completed.status).toBe("FAILED");
      expect(completed.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
      expect(completed.answer).toMatch(/insufficient evidence|time limit/i);
      expect(completed.steps.some((step) => step.label.includes("budget exhausted"))).toBe(true);
    });
  });

  it("bounds an uncooperative search and records one failed terminal state", async () => {
    config.OPENROUTER_API_KEY = "";
    const result: SearchResult = {
      title: "React 19.3 release information",
      url: "https://react.dev/blog/2026/09/09/react-19-3",
      snippet: "The official React release page describes React 19.3 and its release details.",
    };
    let searchSignal: AbortSignal | undefined;
    const search = {
      search: vi.fn((_query: string, signal?: AbortSignal) => {
        searchSignal = signal;
        return new Promise<SearchResult[]>(() => undefined);
      }),
    };
    const llm = new OpenRouterProvider(1000);
    const store = new MemorySessionStore();
    const registry = createToolRegistry(search, llm);
    const runner = new ResearchRunner(store, search, llm, registry, {
      maxTimeMs: 350,
      maxQueries: 1,
    });

    const started = await runner.start(
      "Investigate the latest stable React release and verify its release date.",
      "quick",
    );
    const completed = await waitForTerminal(store, started.id);

    expect(search.search).toHaveBeenCalled();
    expect(searchSignal?.aborted).toBe(true);
    expect(completed.status).toBe("FAILED");
    expect(completed.error).toMatch(/^INSUFFICIENT_EVIDENCE: Research time budget exhausted/);
    expect(completed.failureStage).toBe("serper");
    expect(completed.stageTimings?.serper).toBeGreaterThan(0);
    expect(
      completed.steps.filter((step) => step.label.includes("budget exhausted (deadline)")),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await store.get(started.id))?.status).toBe("FAILED");
  });

  it("preserves triaged sources when a fetch operation ignores cancellation", async () => {
    config.OPENROUTER_API_KEY = "";
    const result: SearchResult = {
      title: "React 19.3 release information",
      url: "https://react.dev/blog/2026/09/09/react-19-3",
      snippet: "The official React release page describes React 19.3 and its release details.",
    };
    const search = { search: vi.fn(async () => [result]) };
    const llm = new OpenRouterProvider(1000);
    const registry = createToolRegistry(search, llm);
    const fetchSource = vi.fn(() => new Promise<never>(() => undefined));
    registry.register({
      name: "fetch_url",
      description: "Provider-free hanging fixture",
      execute: fetchSource,
    });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, search, llm, registry, {
      maxTimeMs: 500,
      maxQueries: 1,
    });

    const started = await runner.start(
      "Investigate the latest stable React release and verify its release date.",
      "quick",
    );
    const completed = await waitForTerminal(store, started.id);

    expect(search.search).toHaveBeenCalled();
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(completed.status).toBe("FAILED");
    expect(completed.failureStage).toBe("retrieval");
    expect(completed.stageTimings?.retrieval).toBeGreaterThan(0);
    expect(completed.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: result.url })]),
    );
  });

  it("fails closed when the verifier ignores abort and the research deadline expires", async () => {
    config.OPENROUTER_API_KEY = "";
    const result: SearchResult = {
      title: "React release information",
      url: "https://react.dev/blog/react-19-3",
      snippet: "The official React release page documents React 19.3.0.",
    };
    const llm = new OpenRouterProvider(1000);
    const registry = new ToolRegistry();
    const verifier = vi.fn(() => new Promise<never>(() => undefined));
    const synthesis = vi.fn(async () => "This must not run without verified claims.");
    registry.register({
      name: "web_search",
      description: "Provider-free search result fixture",
      execute: async () => [result],
    });
    registry.register({
      name: "fetch_url",
      description: "Provider-free fetched source fixture",
      execute: async (input) => ({
        url: (input as { url: string }).url,
        html: "fixture",
        contentType: "text/html",
        retrievalMethod: "fixture-http",
      }),
    });
    registry.register({
      name: "extract_content",
      description: "Provider-free extraction fixture",
      execute: async () => ({
        title: "React 19.3.0 release",
        content:
          "React 19.3.0 is the latest stable React release and was released on September 9, 2026. The official React release page documents the stable release.",
      }),
    });
    registry.register({
      name: "extract_claims",
      description: "Provider-free claim fixture",
      execute: async (input) => {
        const source = (input as { sources: Array<{ id: string }> }).sources[0];
        const claim: Claim = {
          id: "react-release-claim",
          text: "React 19.3.0 is the latest stable release and was released on September 9, 2026.",
          sourceIds: [source.id],
          evidence:
            "React 19.3.0 is the latest stable React release and was released on September 9, 2026.",
          confidence: 0.9,
          importance: "critical",
          requestedFacts: ["version", "release date", "stable status", "latestness"],
        };
        return [claim];
      },
    });
    registry.register({
      name: "gather_evidence",
      description: "Provider-free evidence fixture",
      execute: async (input) => (input as { claims: Claim[] }).claims,
    });
    registry.register({
      name: "verify_claims_batch",
      description: "Unresponsive provider-free verifier fixture",
      execute: verifier,
    });
    registry.register({
      name: "detect_conflict",
      description: "Provider-free conflict fixture",
      execute: async () => [],
    });
    registry.register({
      name: "synthesize",
      description: "Must not be called after verifier timeout",
      execute: synthesis,
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, llm, registry, {
      maxSteps: 10,
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxSearchPasses: 0,
      maxClaimsToVerify: 1,
      maxTimeMs: 900,
      maxModelDecisions: 0,
    });
    const started = await runner.start(
      "Investigate the latest stable React release and verify its version and release date.",
      "quick",
    );
    const completed = await waitForTerminal(store, started.id);

    expect(verifier).toHaveBeenCalledOnce();
    expect(synthesis).not.toHaveBeenCalled();
    expect(completed.status).toBe("FAILED");
    expect(completed.failureStage).toBe("verification");
    expect(completed.stageTimings?.verification).toBeGreaterThan(0);
    expect(completed.claims[0]?.verification?.verdict).toBeUndefined();
    expect(completed.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
  });

  it("durably fails a research job after a hanging research operation instead of leaving it running", async () => {
    config.OPENROUTER_API_KEY = "";
    const sessionStore = new MemorySessionStore();
    const jobStore = new InMemoryDurableJobStore();
    const question = "What is the latest stable React release?";
    const sessionId = "deadline-worker-session";
    const jobId = "deadline-worker-job";
    const search = {
      search: vi.fn(
        (_query: string, _signal?: AbortSignal) => new Promise<SearchResult[]>(() => undefined),
      ),
    };
    const llm = new OpenRouterProvider(1000);
    const runner = new ResearchRunner(sessionStore, search, llm, createToolRegistry(search, llm), {
      maxTimeMs: 350,
    });
    await jobStore.enqueueJob({
      id: jobId,
      kind: "research",
      ownerId: "test-user",
      ownerScope: "user:test-user",
      payload: { sessionId, question, mode: "quick" },
      maxAttempts: 1,
    });
    const failJob = vi.spyOn(jobStore, "failJob");
    const worker = new DurableQueueWorker(
      jobStore,
      {
        research: async (_job, context) => {
          const session = await runner.runQueued(sessionId, question, "quick", [], {
            signal: context.signal,
          });
          if (session?.status === "FAILED") throw new Error(session.error ?? "Research failed");
          return { status: session?.status ?? "missing" };
        },
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, leaseSeconds: 5, heartbeatIntervalMs: 250 },
    );

    worker.start();
    try {
      await waitForJobTerminal(jobStore, jobId);
    } finally {
      await worker.stop();
    }
    const job = await jobStore.getJob(jobId);
    const session = await sessionStore.get(sessionId);

    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
    expect(job?.progress).toMatchObject({
      stage: "terminal_transition",
      terminalOutcome: "failed",
    });
    expect(job?.errorSummary).toContain("INSUFFICIENT_EVIDENCE");
    expect(failJob).toHaveBeenCalledOnce();
    expect(session?.status).toBe("FAILED");
    expect(session?.failureStage).toBe("serper");
  });

  it("aborts the active model request when the user cancels a research session", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = createHangingFetch();
    globalThis.fetch = fetchMock as typeof fetch;
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      new OpenRouterProvider(5000),
      new ToolRegistry(),
      { maxTimeMs: 5000 },
    );
    const events: string[] = [];
    const started = await runner.start(
      "Summarize recent discoveries in quantum computing and fusion energy",
      "quick",
    );
    runner.subscribe(started.id, (event) => events.push(event.type));
    const requestDeadline = Date.now() + 1000;
    while (!fetchMock.mock.calls.length && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    await runner.cancel(started.id);
    const cancelled = await waitForTerminal(store, started.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(events).toContain("research.cancelled");
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not begin model work when a queued session is cancelled immediately", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = createHangingFetch();
    globalThis.fetch = fetchMock as typeof fetch;
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      new OpenRouterProvider(5000),
      new ToolRegistry(),
      { maxTimeMs: 5000 },
    );

    const started = await runner.start(
      "Summarize recent discoveries in quantum computing and fusion energy",
      "quick",
    );
    await runner.cancel(started.id);
    const cancelled = await store.get(started.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelled?.status).toBe("CANCELLED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (Reflect.get(runner, "activeControllers") as Map<string, AbortController>).has(started.id),
    ).toBe(false);
  });
});
