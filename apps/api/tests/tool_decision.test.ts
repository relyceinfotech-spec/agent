import { describe, expect, it } from "vitest";
import type { Claim, ResearchSession, SearchResult } from "../src/domain.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { ResearchRunner } from "../src/research.js";
import { MemorySessionStore } from "../src/store.js";

const primaryResult: SearchResult = {
  title: "React Native performance documentation",
  url: "https://reactnative.dev/docs/performance",
  snippet:
    "Official React Native performance documentation explains rendering performance and profiling.",
};
const secondaryResult: SearchResult = {
  title: "Flutter performance benchmarks",
  url: "https://docs.flutter.dev/perf",
  snippet: "Flutter performance benchmarks and profiling guidance for production applications.",
};
const irrelevantResults: SearchResult[] = [
  {
    title: "Best travel destinations",
    url: "https://example.com/travel",
    snippet: "A guide to popular travel destinations and vacation planning.",
  },
  {
    title: "Easy weeknight recipes",
    url: "https://example.com/recipes",
    snippet: "Simple recipes for busy weeknights and family dinners.",
  },
  {
    title: "Home gardening tips",
    url: "https://example.com/gardening",
    snippet: "Practical advice for growing vegetables in a home garden.",
  },
  {
    title: "Beginner photography guide",
    url: "https://example.com/photography",
    snippet: "Learn camera settings, composition, and photography basics.",
  },
  {
    title: "Personal finance checklist",
    url: "https://example.com/finance",
    snippet: "A checklist for budgeting, saving, and household finances.",
  },
  {
    title: "Weekend fitness routine",
    url: "https://example.com/fitness",
    snippet: "A simple fitness routine for a healthy weekend schedule.",
  },
];

function waitForCompletion(store: MemorySessionStore, id: string) {
  return (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(id);
      if (current?.status === "COMPLETED" || current?.status === "FAILED") return current;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return store.get(id);
  })();
}

function makeClaim(sourceId: string, index: number): Claim {
  return {
    id: `claim-${index}`,
    text: `The source reports evidence for the requested performance comparison ${index}.`,
    sourceIds: [sourceId],
    evidence: "The source reports evidence for the requested performance comparison.",
    confidence: 0.9,
  };
}

function createRegistry(
  initialResults: SearchResult[],
  rewrittenResults: SearchResult[] = initialResults,
  observedQueries: string[][] = [],
  fetchedUrls: string[] = [],
  claimsPerSource = 1,
) {
  const registry = new ToolRegistry();
  registry.register({
    name: "web_search",
    description: "test search",
    execute: async (input) => {
      const queries = (input as { queries: string[] }).queries;
      observedQueries.push(queries);
      return initialResults;
    },
  });
  registry.register({
    name: "search_again",
    description: "test rewritten search",
    execute: async (input) => {
      const queries = (input as { queries: string[] }).queries;
      observedQueries.push(queries);
      return rewrittenResults;
    },
  });
  registry.register({
    name: "fetch_url",
    description: "test fetch",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      fetchedUrls.push(url);
      return { url, html: `<article>${url}</article>` };
    },
  });
  registry.register({
    name: "extract_content",
    description: "test extraction",
    execute: async (input) => ({
      title: "Extracted source",
      content:
        "This sufficiently long evidence sentence describes the source findings for the requested comparison and provides enough context for verification.",
      url: (input as { url: string }).url,
    }),
  });
  registry.register({
    name: "extract_claims",
    description: "test claims",
    execute: async (input) =>
      ((input as { sources: Array<{ id: string }> }).sources ?? []).flatMap((source, sourceIndex) =>
        Array.from({ length: claimsPerSource }, (_, claimIndex) =>
          makeClaim(source.id, sourceIndex * claimsPerSource + claimIndex),
        ),
      ),
  });
  registry.register({
    name: "gather_evidence",
    description: "test evidence",
    execute: async (input) => (input as { claims: Claim[] }).claims,
  });
  registry.register({
    name: "verify_claim",
    description: "test verification",
    execute: async () => ({ verdict: "supported", rationale: "The test evidence supports it." }),
  });
  registry.register({
    name: "detect_conflict",
    description: "test conflicts",
    execute: async () => [],
  });
  registry.register({
    name: "synthesize",
    description: "test synthesis",
    execute: async () => "Cited test answer",
  });
  return registry;
}

async function runResearch(
  question: string,
  mode: ResearchSession["mode"],
  registry: ToolRegistry,
) {
  const store = new MemorySessionStore();
  const runner = new ResearchRunner(store, { search: async () => [] }, undefined, registry);
  const session = await runner.start(question, mode);
  const completed = await waitForCompletion(store, session.id);
  return completed;
}

describe("tool decision quality", () => {
  it("fetches only triaged relevant sources instead of every search result", async () => {
    const observedQueries: string[][] = [];
    const fetchedUrls: string[] = [];
    const registry = createRegistry(
      [primaryResult, secondaryResult, ...irrelevantResults],
      [primaryResult, secondaryResult],
      observedQueries,
      fetchedUrls,
    );

    const completed = await runResearch(
      "Compare React Native and Flutter performance",
      "quick",
      registry,
    );

    expect(completed?.status).toBe("COMPLETED");
    expect(fetchedUrls).toEqual(expect.arrayContaining([primaryResult.url, secondaryResult.url]));
    expect(fetchedUrls).toHaveLength(2);
    expect(observedQueries).toHaveLength(1);
  });

  it("rewrites queries after weak evidence and uses the second result set", async () => {
    const observedQueries: string[][] = [];
    const fetchedUrls: string[] = [];
    const registry = createRegistry(
      irrelevantResults,
      [primaryResult, secondaryResult],
      observedQueries,
      fetchedUrls,
    );

    const completed = await runResearch(
      "Compare React Native and Flutter performance",
      "deep",
      registry,
    );

    expect(completed?.status).toBe("COMPLETED");
    expect(observedQueries.length).toBeGreaterThanOrEqual(2);
    expect(observedQueries[1]).not.toEqual(observedQueries[0]);
    expect(fetchedUrls).toEqual(expect.arrayContaining([primaryResult.url, secondaryResult.url]));
  });

  it("stops after strong evidence instead of spending a second search pass", async () => {
    const observedQueries: string[][] = [];
    const registry = createRegistry([primaryResult], [secondaryResult], observedQueries, [], 2);

    const completed = await runResearch("React Native performance", "quick", registry);

    expect(completed?.status).toBe("COMPLETED");
    expect(observedQueries).toHaveLength(1);
    expect(completed?.steps.some((step) => step.label.includes("search_again"))).toBe(false);
  });
});
