import { describe, expect, it } from "vitest";
import type { Claim, ResearchSession, SearchResult } from "../src/domain.js";
import { createToolRegistry, ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { ResearchRunner, selectVerificationClaims } from "../src/research.js";
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
        "React Native and Flutter performance benchmarks describe the source findings for the requested comparison and provide enough context for verification.",
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
    execute: async (input) => {
      const payload = input as { claims?: Claim[]; sources?: Array<{ id: string }> };
      const sourceNumbers = new Map(
        (payload.sources ?? []).map((source, index) => [source.id, index + 1]),
      );
      const claim = (payload.claims ?? []).find((candidate) =>
        candidate.sourceIds.some((sourceId) => sourceNumbers.has(sourceId)),
      );
      const sourceNumber = claim?.sourceIds
        .map((sourceId) => sourceNumbers.get(sourceId))
        .find((number): number is number => number !== undefined);
      return claim && sourceNumber
        ? `${claim.text} [${sourceNumber}]`
        : "Insufficient evidence to provide a verified answer.";
    },
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
  it("routes conflicting versioned latest-release claims to conflict verification", async () => {
    class OfflineVerifier extends OpenRouterProvider {
      override get enabled() {
        return false;
      }
    }

    const registry = createToolRegistry({ search: async () => [] }, new OfflineVerifier());
    const conflicts = await registry.execute("detect_conflict", {
      claims: [
        {
          id: "website-latest",
          text: "React 2.9.0 is the latest stable release.",
          evidence: "React 2.9.0 is the latest stable release.",
          sourceIds: ["official-site"],
          confidence: 1,
          verification: { verdict: "supported" },
        },
        {
          id: "github-latest",
          text: "React 2.10.0 is the latest stable release.",
          evidence: "React 2.10.0 is the latest stable release.",
          sourceIds: ["official-github"],
          confidence: 1,
          verification: { verdict: "supported" },
        },
      ],
    });

    expect(conflicts).toEqual([
      expect.objectContaining({
        claimIds: ["website-latest", "github-latest"],
        sourceIds: ["official-site", "official-github"],
        description: "Sources identify different versions as the latest release",
        status: "open",
      }),
    ]);
  });

  it("does not treat different products as conflicting latest-release claims", async () => {
    class OfflineVerifier extends OpenRouterProvider {
      override get enabled() {
        return false;
      }
    }

    const registry = createToolRegistry({ search: async () => [] }, new OfflineVerifier());
    const conflicts = await registry.execute("detect_conflict", {
      claims: [
        {
          id: "react-latest",
          text: "React 2.9.0 is the latest stable release.",
          evidence: "React 2.9.0 is the latest stable release.",
          sourceIds: ["react-source"],
          confidence: 1,
          verification: { verdict: "supported" },
        },
        {
          id: "react-native-latest",
          text: "React Native 0.83.0 is the latest stable release.",
          evidence: "React Native 0.83.0 is the latest stable release.",
          sourceIds: ["react-native-source"],
          confidence: 1,
          verification: { verdict: "supported" },
        },
      ],
    });

    expect(conflicts).toEqual([]);
  });

  it("allocates verification slots across sources before taking a second claim from one source", () => {
    const claims = [makeClaim("source-a", 1), makeClaim("source-a", 2), makeClaim("source-b", 3)];
    expect(selectVerificationClaims(claims, 2).map((claim) => claim.id)).toEqual([
      "claim-1",
      "claim-3",
    ]);
  });

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

  it("reserves pages for conflict follow-up instead of exhausting retrieval on the first pass", async () => {
    const fetchedUrls: string[] = [];
    const initialResults = [
      primaryResult,
      secondaryResult,
      {
        title: "Independent React Native and Flutter performance analysis",
        url: "https://analysis.example.org/mobile-performance",
        snippet: "Detailed comparison of React Native and Flutter performance.",
      },
      {
        title: "React Native Flutter benchmark methodology",
        url: "https://benchmarks.example.net/mobile-performance",
        snippet: "Reproducible performance methods for React Native and Flutter.",
      },
    ];
    const registry = createRegistry(initialResults, initialResults, [], fetchedUrls);
    let firstPassFetches = -1;
    registry.register({
      name: "search_again",
      description: "observe reserved fetch budget",
      execute: async () => {
        firstPassFetches = fetchedUrls.length;
        return initialResults;
      },
    });
    let conflictChecks = 0;
    registry.register({
      name: "detect_conflict",
      description: "conflict on first pass",
      execute: async () => {
        conflictChecks += 1;
        return conflictChecks === 1
          ? [
              {
                claimIds: ["claim-0", "claim-1"],
                sourceIds: [],
                description: "Results disagree",
                status: "open",
              },
            ]
          : [];
      },
    });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [] }, undefined, registry, {
      maxSteps: 20,
      maxQueries: 6,
      maxPages: 4,
      maxSources: 4,
      maxSearchPasses: 1,
      maxTimeMs: 5000,
    });
    const started = await runner.start("Compare React Native and Flutter performance", "quick");
    const completed = await waitForCompletion(store, started.id);

    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.error).toBeUndefined();
    expect(completed?.answer).toContain("[1]");
    expect(firstPassFetches).toBe(2);
    expect(fetchedUrls).toHaveLength(4);
    expect(completed?.steps.some((step) => step.label.includes("search_again"))).toBe(true);
    expect(completed?.steps.some((step) => step.label.includes("synthesize"))).toBe(true);
  });
});
