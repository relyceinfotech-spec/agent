import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAgent } from "../src/content-agent.js";
import type { FeedEntry } from "../src/topic-discovery.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { ResearchRunner } from "../src/research.js";
import { ResilientSearchProvider } from "../src/search.js";
import { SqliteSessionStore } from "../src/store.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { validateCitationEntailment } from "../src/citation-entailment.js";
import type { OpenRouterProvider } from "../src/llm.js";
import type { SearchResult } from "../src/domain.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function waitForRun(store: SqliteSessionStore, id: string) {
  const deadline = Date.now() + 8000;
  return new Promise<Awaited<ReturnType<SqliteSessionStore["getRun"]>>>((resolve, reject) => {
    const poll = async () => {
      const run = await store.getRun(id);
      if (
        run &&
        ["PUBLISHED", "FAILED", "REJECTED", "REQUIRES_REVIEW", "CANCELLED"].includes(run.status)
      ) {
        resolve(run);
      } else if (Date.now() >= deadline) {
        reject(new Error("Autonomous full research fixture did not finish"));
      } else {
        setTimeout(() => void poll(), 20);
      }
    };
    void poll();
  });
}

describe("autonomous shared-research end-to-end flow", () => {
  it("recovers from primary search failure, verifies fetched evidence, publishes, and persists provenance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "max-autonomous-e2e-"));
    directories.push(directory);
    const databasePath = join(directory, "max.sqlite");
    const store = new SqliteSessionStore(databasePath);
    let storeClosed = false;
    const topicUrl = "https://react.dev/blog/2026-rendering-performance";
    const publishedAt = new Date().toISOString();
    const topic: FeedEntry = {
      title: "React reports 2026 rendering performance benchmark results",
      url: topicUrl,
      summary:
        "The official report describes React rendering performance measurements, benchmark methodology, repeated runs, and limitations. ".repeat(
          2,
        ),
      publishedAt,
      provider: "fixture-rss",
    };
    const results: SearchResult[] = [
      {
        title: "React rendering performance benchmark results",
        url: topicUrl,
        snippet: "Official React rendering performance measurements and benchmark methodology.",
        publishedAt,
      },
      {
        title: "React rendering performance methodology",
        url: "https://developer.mozilla.org/en-US/blog/react-rendering-performance",
        snippet: "Independent React rendering performance test methods and measured results.",
        publishedAt,
      },
      {
        title: "React performance benchmark analysis",
        url: "https://engineering.example.org/react-performance-benchmark",
        snippet: "Production React rendering performance benchmark data and limitations.",
        publishedAt,
      },
    ];
    const search = new ResilientSearchProvider([
      {
        name: "fixture-primary-down",
        provider: {
          search: async () => {
            throw new Error("fixture primary provider offline");
          },
        },
      },
      {
        name: "fixture-secondary",
        provider: { search: async () => results },
      },
    ]);

    const fakeModel = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("This deterministic fixture does not call the model transport");
      }),
      proposeResearchAction: vi.fn(async (_observation: unknown, allowed: string[]) =>
        allowed.includes("synthesize") ? "synthesize" : allowed[0],
      ),
      synthesize: vi.fn(
        async (
          _question: string,
          _plan: unknown,
          sources: Array<{ id: string; content?: string }>,
          claims: Array<{ text: string; sourceIds: string[]; verification?: { verdict: string } }>,
        ) =>
          validateCitationEntailment(
            claims
              .filter((claim) => claim.verification?.verdict === "supported")
              .slice(0, 4)
              .map((claim) => {
                const sourceNumber =
                  sources.findIndex((source) => claim.sourceIds.includes(source.id)) + 1;
                return `${claim.text} [${sourceNumber}].`;
              })
              .join("\n\n"),
            sources as never,
          ).then((report) => report.finalAnswer),
      ),
      validateCitedAnswer: vi.fn((answer: string, sources: never[]) =>
        validateCitationEntailment(answer, sources),
      ),
    } as unknown as OpenRouterProvider;

    const registry = createToolRegistry(search, fakeModel, store);
    registry.register({
      name: "fetch_url",
      description: "Fixture source retrieval; no external URL requests are made.",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        const body =
          "The 2026 React rendering performance benchmark measured component updates across representative interfaces. The report records the test environment, profiling procedure, rendering latency, memory use, repeated runs, and important limitations when comparing results. ".repeat(
            2,
          );
        return {
          url,
          contentType: "text/html",
          retrievalMethod: "fixture-http",
          html: `<html><head><title>React Rendering Performance Study</title></head><body><main><h1>React Rendering Performance</h1><p>${body}</p></main></body></html>`,
        };
      },
    });
    registry.register({
      name: "verify_claims_batch",
      description: "Deterministic fixture verification over fetched document evidence.",
      execute: async (input) =>
        (input as { claims: Array<{ id: string }> }).claims.map((claim) => ({
          id: claim.id,
          verdict: "supported",
          rationale: "Fixture evidence contains the measured claim",
        })),
    });

    const runner = new ResearchRunner(store, search, fakeModel, registry, {
      maxSteps: 18,
      maxQueries: 6,
      maxSources: 5,
      maxPages: 4,
      maxSearchPasses: 1,
      maxClaimsToVerify: 4,
      maxTimeMs: 6000,
      maxModelDecisions: 2,
    });
    const contentAgent = new ContentAgent(
      store,
      runner,
      ["fixture-rss"],
      async () => [topic],
      search,
    );

    try {
      const queued = await contentAgent.trigger();
      const run = await waitForRun(store, queued.id);

      expect(run?.status).toBe("PUBLISHED");
      expect(run?.researchId).toBeTruthy();
      expect(run?.postId).toBeTruthy();
      expect(fakeModel.complete).not.toHaveBeenCalled();
      expect(fakeModel.synthesize).toHaveBeenCalledOnce();

      const session = await store.get(run!.researchId!);
      expect(session?.status).toBe("COMPLETED");
      expect(session?.searchAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "fixture-primary-down", status: "failed" }),
          expect.objectContaining({ provider: "fixture-secondary", status: "success" }),
        ]),
      );
      const executedStages = session?.steps.map((step) => step.label).join(" ") ?? "";
      expect(executedStages).toContain("web_search");
      expect(executedStages).toContain("source_triage");
      expect(executedStages).toContain("fetch_url");
      expect(executedStages).toContain("verify_claim");
      expect(executedStages).toContain("synthesize");
      expect(session?.sources.filter((source) => source.content)).toHaveLength(3);
      expect(
        session?.claims.filter((claim) => claim.verification?.verdict === "supported").length,
      ).toBeGreaterThanOrEqual(2);

      const post = await store.getPost(run!.postId!);
      expect(post?.researchId).toBe(session?.id);
      expect(post?.sources.map((source) => source.url)).toContain(topicUrl);
      expect(post?.findings.length).toBeGreaterThanOrEqual(2);
      expect(
        await store.searchDocuments("React rendering performance", 24 * 60 * 60 * 1000),
      ).toHaveLength(3);

      const api = await createServer({
        store,
        authVerifier: {
          verifyAccessToken: async (token) =>
            token === "test-user-token" ? { id: "post-owner" } : undefined,
        },
        searchProvider: search,
        llmProvider: fakeModel,
        toolRegistry: registry,
        researchBudget: {
          maxSteps: 18,
          maxQueries: 6,
          maxSources: 5,
          maxPages: 4,
          maxSearchPasses: 1,
          maxClaimsToVerify: 4,
          maxTimeMs: 6000,
          maxModelDecisions: 2,
        },
      });
      getServerBackgroundServices(api).worker.start();
      try {
        const discover = await api.inject({ method: "GET", url: "/api/discover" });
        expect(discover.statusCode).toBe(200);
        expect(discover.json()).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: post!.id })]),
        );

        const detail = await api.inject({ method: "GET", url: `/api/posts/${post!.id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).not.toHaveProperty("researchId");

        const ask = await api.inject({
          method: "POST",
          url: `/api/posts/${post!.id}/ask`,
          headers: { authorization: "Bearer test-user-token" },
          payload: { question: "What newer React performance findings appeared since 2025?" },
        });
        expect(ask.statusCode).toBe(202);
        const queued = ask.json() as { id: string };
        const followUpDeadline = Date.now() + 5000;
        let followUp: Awaited<ReturnType<SqliteSessionStore["getFollowUp"]>>;
        do {
          followUp = await store.getFollowUp(queued.id);
          if (followUp && ["COMPLETED", "FAILED"].includes(followUp.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < followUpDeadline);
        expect(followUp?.status, followUp?.error).toBe("COMPLETED");
        expect(followUp?.usedLiveResearch).toBe(true);
        expect(followUp?.liveResearchId).toBeTruthy();
        expect(followUp?.answer).toMatch(/\[\d+\]/);
        expect(
          (await store.get(followUp!.liveResearchId!))?.searchAttempts?.length,
        ).toBeGreaterThan(0);
      } finally {
        await api.close();
        storeClosed = true;
      }

      const reopened = new SqliteSessionStore(databasePath);
      try {
        expect((await reopened.getRun(run!.id))?.status).toBe("PUBLISHED");
        expect((await reopened.getPost(run!.postId!))?.researchId).toBe(session?.id);
        expect((await reopened.get(run!.researchId!))?.status).toBe("COMPLETED");
        expect(
          await reopened.searchDocuments("React rendering performance", 24 * 60 * 60 * 1000),
        ).toHaveLength(3);
      } finally {
        reopened.close();
      }
    } finally {
      if (!storeClosed) store.close();
    }
  });
});
