import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/agent/tools.js";
import type { Claim, Source } from "../src/domain.js";
import { OpenRouterProvider } from "../src/llm.js";
import { ResearchRunner } from "../src/research.js";
import { ResilientSearchProvider, SerperProvider } from "../src/search.js";
import { MemorySessionStore } from "../src/store.js";

async function runTrajectory(failOneSource: boolean, searchOverride?: ResilientSearchProvider) {
  const results = [
    {
      title: "React Native performance architecture and benchmark",
      url: "https://reactnative.dev/docs/performance",
      snippet: "React Native performance compared with Flutter in current benchmarks",
    },
    {
      title: "Flutter performance architecture and benchmark",
      url: "https://docs.flutter.dev/perf",
      snippet: "Flutter performance compared with React Native in current benchmarks",
    },
    {
      title: "Independent React Native and Flutter production performance analysis",
      url: "https://engineering.example.org/mobile-performance",
      snippet: "Independent production analysis of mobile framework performance trade-offs",
    },
  ];
  const search =
    searchOverride ??
    new ResilientSearchProvider([
      {
        name: "broken-primary",
        provider: {
          search: async () => {
            throw new Error("primary offline");
          },
        },
      },
      { name: "working-secondary", provider: { search: async () => results } },
    ]);
  const registry = createToolRegistry(search, new OpenRouterProvider());
  registry.register({
    name: "fetch_url",
    description: "mock fetch",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      if (failOneSource && url.includes("flutter")) throw new Error("source HTTP 503");
      return { url, html: "<html><article>Fetched evidence</article></html>" };
    },
  });
  registry.register({
    name: "extract_content",
    description: "mock extraction",
    execute: async () => ({
      title: "Performance source",
      content:
        "This detailed benchmark explains measured performance and architecture, including methods, results, caveats, and reproducible evidence. ".repeat(
          3,
        ),
    }),
  });
  registry.register({
    name: "extract_claims",
    description: "mock claims",
    execute: async (input) =>
      (input as { sources: Source[] }).sources
        .filter((source) => source.content)
        .map((source): Claim => ({
          id: source.id,
          text: "The documented benchmark describes performance, methods, and architecture in detail.",
          sourceIds: [source.id],
          evidence: source.content!,
          confidence: 0.9,
        })),
  });
  registry.register({
    name: "verify_claims_batch",
    description: "mock verification",
    execute: async (input) =>
      (input as { claims: Array<{ id: string }> }).claims.map((claim) => ({
        id: claim.id,
        verdict: "supported",
        rationale: "Evidence supports it",
      })),
  });
  registry.register({
    name: "detect_conflict",
    description: "no conflict",
    execute: async () => [],
  });
  const store = new MemorySessionStore();
  const runner = new ResearchRunner(store, search, new OpenRouterProvider(), registry, {
    maxSteps: 16,
    maxQueries: 4,
    maxSources: 3,
    maxPages: 3,
    maxSearchPasses: 0,
    maxTimeMs: 5000,
  });
  const started = await runner.start("Compare React Native and Flutter performance", "quick");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const session = await store.get(started.id);
    if (session && ["COMPLETED", "FAILED"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Trajectory did not finish");
}

describe("retrieval fallback trajectories", () => {
  it("continues research through a secondary provider and records the failure path", async () => {
    const session = await runTrajectory(false);
    expect(session.status).toBe("COMPLETED");
    expect(
      session.searchAttempts?.some(
        (attempt) => attempt.provider === "broken-primary" && attempt.status === "failed",
      ),
    ).toBe(true);
    expect(
      session.searchAttempts?.some(
        (attempt) => attempt.provider === "working-secondary" && attempt.status === "success",
      ),
    ).toBe(true);
    expect(session.sources.filter((source) => source.content)).toHaveLength(3);
    expect(session.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(true);
  });

  it("continues with remaining evidence when one source cannot be fetched", async () => {
    const session = await runTrajectory(true);
    expect(session.status).toBe("COMPLETED");
    expect(session.sources.some((source) => source.fetchError?.includes("503"))).toBe(true);
    const retrieved = session.sources.filter((source) => source.content);
    expect(retrieved).toHaveLength(2);
    expect(new Set(retrieved.map((source) => source.domain))).toHaveLength(2);
    expect(session.claims).toHaveLength(2);
    expect(session.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(true);
  });

  it("runs the planned research trajectory through the Serper adapter", async () => {
    const requests: Array<{ url: string; query: string }> = [];
    const fixtureResults = [
      {
        title: "React Native performance architecture and benchmark",
        link: "https://reactnative.dev/docs/performance",
        snippet: "React Native performance compared with Flutter in current benchmarks",
        position: 1,
      },
      {
        title: "Flutter performance architecture and benchmark",
        link: "https://docs.flutter.dev/perf",
        snippet: "Flutter performance compared with React Native in current benchmarks",
        position: 2,
      },
      {
        title: "Independent React Native and Flutter production performance analysis",
        link: "https://engineering.example.org/mobile-performance",
        snippet: "Independent production analysis of mobile framework performance trade-offs",
        position: 3,
      },
    ];
    const provider = new SerperProvider("fixture-key", (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        query: (JSON.parse(String(init.body)) as { q: string }).q,
      });
      return {
        response: new Response(JSON.stringify({ organic: fixtureResults })),
        dispose: async () => undefined,
      };
    }) as never);
    const serper = new ResilientSearchProvider([{ name: "serper", provider }]);
    const session = await runTrajectory(false, serper);

    expect(session.status).toBe("COMPLETED");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url === "https://google.serper.dev/search")).toBe(
      true,
    );
    expect(
      requests.every((request) => request.query !== "Compare React Native and Flutter performance"),
    ).toBe(true);
    expect(session.searchAttempts?.every((attempt) => attempt.provider === "serper")).toBe(true);
    expect(session.sources.filter((source) => source.content)).toHaveLength(3);
    expect(session.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(true);
  });
});
