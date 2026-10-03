import { describe, expect, it, vi } from "vitest";
import {
  comparisonObjective,
  comparisonCoverage,
  comparisonClaimDimensions,
  comparisonEvidencePassages,
} from "../src/comparison-evidence.js";
import { buildPlan, rewriteQueries, validateRecoveryQuery } from "../src/planner.js";
import { OpenRouterProvider } from "../src/llm.js";
import {
  createToolRegistry,
  NORMAL_CHAT_VERIFICATION_COMPLETION_TOKENS,
} from "../src/agent/tools.js";
import { ResearchRunner } from "../src/research.js";
import { SqliteSessionStore } from "../src/store.js";
import { config } from "../src/config.js";
import { rankResults, selectResearchSourcesWithDecisions } from "../src/rank.js";
import { withOperationContext } from "../src/operation-context.js";
import type { Claim, ResearchRecoveryRequirements, Source } from "../src/domain.js";

const question = "Compare current Aster and Beryl on latency and recall";
function offline() {
  const provider = new OpenRouterProvider();
  vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
  return provider;
}

describe("comparison evidence depth", () => {
  it("preserves a results-in continuation with its original subject through extraction", async () => {
    const objective = { targets: ["Aster", "Beryl"], dimensions: ["latency"] };
    const anchor =
      "Aster traverses a sparse graph during vector indexing in the documented workload.";
    const effect = "This results in lower latency because fewer neighboring records are scanned.";
    expect(comparisonEvidencePassages(objective, `${anchor} ${effect}`)).toContain(
      `${anchor} ${effect}`,
    );
    expect(comparisonEvidencePassages(objective, `${anchor}\n\n${effect}`)).not.toContain(
      `${anchor} ${effect}`,
    );
    const source = {
      ...rankResults(question, [
        {
          url: "https://context.example.org/results",
          title: "Aster and Beryl latency recall comparison",
          snippet: "Aster and Beryl latency recall vector indexing benchmark",
        },
      ])[0],
      content: `${anchor} ${effect}`,
    } as Source;
    const registry = createToolRegistry({ search: async () => [] }, offline());
    const claims = (await registry.execute("extract_claims", {
      question: "Compare Aster and Beryl on latency",
      sources: [source],
      requestedFacts: [],
      researchChatOptimization: true,
    })) as Claim[];
    expect(claims.map((claim) => claim.text)).toEqual([`${anchor} ${effect}`]);
    expect(claims[0]?.evidence).toBe(`${anchor} ${effect}`);
  });
  it("plans named noncatalog comparisons without a model round trip or raw-question query", async () => {
    const llm = offline();
    vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
    const complete = vi.spyOn(llm, "complete").mockRejectedValue(new Error("must not call"));
    const plan = await buildPlan(question, "quick", llm, undefined, {
      researchChatOptimization: true,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(plan.interpretation.entities).toEqual(["Aster", "Beryl"]);
    expect(plan.queries[0]).toMatch(/^Aster vs Beryl latency recall/);
    expect(plan.queries[0]).toContain("current");
    expect(plan.queries[0]).not.toContain("Compare current");
  });
  it("retains original adjacent subject context without crossing paragraphs or another target", async () => {
    const objective = { targets: ["Aster", "Beryl"], dimensions: ["latency"] };
    const anchor = "Aster connects neighboring items through a graph during vector indexing.";
    const finding = "This means it achieves lower latency on the documented workload.";
    expect(comparisonEvidencePassages(objective, `${anchor} ${finding}`)).toContain(
      `${anchor} ${finding}`,
    );
    expect(comparisonEvidencePassages(objective, `${anchor}\n\n${finding}`)).not.toContain(
      `${anchor} ${finding}`,
    );
    const b = "Beryl latency is 20 milliseconds on the documented workload.";
    expect(comparisonEvidencePassages(objective, `${anchor} ${b}`)).not.toContain(`${anchor} ${b}`);
    const source = {
      ...rankResults(question, [
        {
          title: "Aster Beryl latency recall",
          url: "https://context.example.org/measurements",
          snippet: "Aster and Beryl indexing latency recall comparison",
        },
      ])[0],
      content: `${anchor} ${finding}`,
    } as Source;
    const registry = createToolRegistry({ search: async () => [] }, offline());
    const claims = (await registry.execute("extract_claims", {
      question: "Compare Aster and Beryl on latency",
      sources: [source],
      researchChatOptimization: true,
    })) as Claim[];
    expect(claims.map((claim) => claim.text)).toEqual([`${anchor} ${finding}`]);
    expect(claims[0]?.evidence).toBe(`${anchor} ${finding}`);
  });
  it("does not spend a verification candidate on a detached implicit subject", async () => {
    const source = {
      ...rankResults(question, [
        {
          title: "Aster Beryl latency recall",
          url: "https://detached.example.org/measurements",
          snippet: "Aster and Beryl latency and recall comparison",
        },
      ])[0],
      content:
        "This means the engine requires less memory and achieves lower latency in measured workloads.",
    } as Source;
    const registry = createToolRegistry({ search: async () => [] }, offline());
    expect(
      await registry.execute("extract_claims", {
        question,
        sources: [source],
        researchChatOptimization: true,
      }),
    ).toEqual([]);
  });
  it.each([false, true])(
    "prefers readable comparison sources while retaining explicit video requests (%s)",
    (videoRequested) => {
      const q = `Compare Aster and Beryl on latency${videoRequested ? " using videos" : ""}`;
      const ranked = rankResults(q, [
        {
          title: "Aster vs Beryl latency comparison",
          url: "https://youtube.com/watch?v=abc",
          snippet: "Aster and Beryl latency comparison measured benchmark workload and results",
        },
        {
          title: "Aster vs Beryl latency comparison",
          url: "https://text.example.org/benchmarks",
          snippet: "Aster and Beryl latency comparison measured benchmark workload and results",
        },
      ]);
      const selection = selectResearchSourcesWithDecisions(
        ranked,
        [],
        2,
        "none",
        q,
        undefined,
        true,
      );
      expect(selection.selected.some((source) => source.domain === "youtube.com")).toBe(
        videoRequested,
      );
      expect(selection.selected.some((source) => source.domain === "text.example.org")).toBe(true);
    },
  );
  it("does not ban media sources when no readable alternatives are available", () => {
    const ranked = rankResults(question, [
      {
        title: "Aster and Beryl latency recall benchmarks",
        url: "https://youtube.com/watch?v=abc",
        snippet: "Aster and Beryl latency and recall benchmark measured comparison results",
      },
    ]);
    expect(
      selectResearchSourcesWithDecisions(ranked, [], 2, "none", question, undefined, true).selected,
    ).toHaveLength(1);
  });
  it("does not interpret capitalized criteria or source names as comparison targets", () => {
    expect(
      comparisonObjective("Compare Aster and Beryl on Latency and Recall using Microsoft sources"),
    ).toEqual({ targets: ["Aster", "Beryl"], dimensions: ["latency", "recall"] });
  });
  it.each([", ", ",", "; ", ". "])(
    "does not lend a measurement to a generic target clause separated by %s",
    (separator) => {
      const objective = { targets: ["Aster", "Beryl"], dimensions: ["latency"] };
      const text = `Aster latency is 10 ms${separator}Beryl is used for search.`;
      const coverage = comparisonCoverage(objective, [
        {
          id: "claim",
          text,
          evidence: text,
          sourceIds: ["source"],
          confidence: 1,
          verification: { verdict: "supported", rationale: "offline" },
        },
      ]);
      expect(coverage.sufficient).toBe(false);
      expect(coverage.missing).toEqual([{ target: "Beryl", dimension: "latency" }]);
      expect(coverage.cells[0]?.claimIds).toEqual(["claim"]);
    },
  );
  it("requires a shared performance measure without inventing an exhaustive metric list", async () => {
    const request = "Compare current Aster and Beryl vector indexing performance";
    const llm = offline();
    const plan = await buildPlan(request, "quick", llm, undefined, {
      researchChatOptimization: true,
    });
    const claim = (text: string, id: string): Claim => ({
      id,
      text,
      evidence: text,
      sourceIds: ["source"],
      confidence: 1,
      verification: { verdict: "supported", rationale: "offline" },
    });
    const initial = [
      claim("Aster vector indexing latency is 10 milliseconds.", "a"),
      claim("Beryl vector indexing memory usage requires 20 gigabytes.", "b"),
    ];
    const incomplete = comparisonCoverage(plan.interpretation.comparison!, initial);
    expect(incomplete.sufficient).toBe(false);
    expect(incomplete.performanceDimensions).toEqual({
      observed: ["latency", "memory"],
      shared: [],
    });
    const requirements: ResearchRecoveryRequirements = {
      comparison: incomplete,
      requestedFacts: [],
      resolvedFacts: [],
      unresolvedFacts: [],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: true, stable: false },
      officialSourceRequirement: "none",
      officialEvidenceResolved: false,
    };
    const [query] = await rewriteQueries(request, plan, [], "quick", llm, [], requirements);
    expect(query).toContain("Aster vs Beryl performance latency memory");
    expect(validateRecoveryQuery(query!, request, plan, requirements).accepted).toBe(true);
    const complete = comparisonCoverage(plan.interpretation.comparison!, [
      ...initial,
      claim("Beryl vector indexing latency is 15 milliseconds.", "b-latency"),
    ]);
    expect(complete.sufficient).toBe(true);
    expect(complete.performanceDimensions?.shared).toEqual(["latency"]);
    expect(complete.cells.find((cell) => cell.target === "Beryl")?.claimIds).toEqual(["b-latency"]);
    expect(
      comparisonCoverage(plan.interpretation.comparison!, [
        claim(
          "Aster vector indexing is faster than Beryl vector indexing in this measured workload.",
          "relative",
        ),
      ]).sufficient,
    ).toBe(true);
  });
  it("checks a complete first source before fetching a second candidate for known entities", async () => {
    const llm = offline();
    const store = new SqliteSessionStore(":memory:");
    const request = "Compare current React Native and Flutter on latency and recall";
    const content =
      "React Native latency is 10 milliseconds and React Native recall is 95 percent in this offline benchmark workload. Flutter latency is 20 milliseconds and Flutter recall is 90 percent in the same offline benchmark workload.";
    const search = {
      search: vi.fn(async () =>
        ["first", "second"].map((name) => ({
          title: "React Native and Flutter latency and recall",
          url: `https://${name}.example.org/benchmark`,
          snippet: content,
        })),
      ),
    };
    const registry = createToolRegistry(search, llm, store);
    const fetch = vi.fn(async () => ({ html: "offline" }));
    registry.register({ name: "fetch_url", description: "offline", execute: fetch });
    registry.register({
      name: "extract_content",
      description: "offline",
      execute: async () => ({ title: "React Native and Flutter latency and recall", content }),
    });
    registry.register({
      name: "verify_claim",
      description: "offline",
      execute: async () => ({ verdict: "supported" }),
    });
    registry.register({
      name: "synthesize",
      description: "offline",
      execute: async (input) =>
        (input as { claims: Claim[] }).claims.map((claim) => `${claim.text} [1].`).join("\n\n"),
    });
    const runner = new ResearchRunner(
      store,
      search,
      llm,
      registry,
      {
        maxQueries: 2,
        maxSources: 2,
        maxPages: 2,
        maxSearchPasses: 1,
        maxSteps: 14,
        maxModelDecisions: 0,
        maxTimeMs: 4000,
      },
      undefined,
      true,
    );
    try {
      await runner.runQueued("known-first-source", request, "quick", [], {
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      });
      expect((await store.get("known-first-source"))?.status).toBe("COMPLETED");
      expect(search.search).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
  it("retains performance when pricing is requested too, without accepting pricing as performance", async () => {
    const plan = await buildPlan(
      "Compare current Aster and Beryl performance and pricing",
      "quick",
      offline(),
      undefined,
      { researchChatOptimization: true },
    );
    expect(plan.interpretation.comparison?.dimensions).toEqual(["pricing", "performance"]);
    expect(
      comparisonClaimDimensions(
        plan.interpretation.comparison!,
        "Aster performance pricing starts at $10 per month.",
      ),
    ).toEqual(["pricing"]);
  });
  it("does not mistake computational indexing cost for a request for pricing", async () => {
    const llm = offline();
    const plan = await buildPlan(
      "Compare current Aster and Beryl on build/indexing cost",
      "quick",
      llm,
      undefined,
      { researchChatOptimization: true },
    );
    expect(plan.interpretation.comparison?.dimensions).toEqual(["build/indexing cost"]);
    expect(plan.requestedFacts).not.toContain("price");
    const withPrice = await buildPlan(
      "Compare current Aster and Beryl on build cost and pricing",
      "quick",
      llm,
      undefined,
      { researchChatOptimization: true },
    );
    expect(withPrice.requestedFacts).toContain("price");
    expect(withPrice.interpretation.comparison?.dimensions).toEqual([
      "build/indexing cost",
      "pricing",
    ]);
  });
  it("does not count a verified missing-data disclosure as resolved comparison evidence", () => {
    const objective = comparisonObjective("Compare Aster and Beryl on security")!;
    expect(
      comparisonClaimDimensions(objective, "Aster security is unknown and not documented."),
    ).toEqual([]);
  });
  it("does not assign one target's measurement to another target's generic clause", () => {
    const text = "Aster latency is 10 milliseconds while Beryl is used for vector search.";
    const objective = comparisonObjective(question)!;
    const coverage = comparisonCoverage(objective, [
      {
        id: "mixed",
        text,
        evidence: text,
        sourceIds: ["source"],
        confidence: 1,
        verification: { verdict: "supported", rationale: "offline" },
      },
    ]);
    expect(
      coverage.cells.find((cell) => cell.target === "Aster" && cell.dimension === "latency")
        ?.claimIds,
    ).toEqual(["mixed"]);
    expect(
      coverage.cells.find((cell) => cell.target === "Beryl" && cell.dimension === "latency")
        ?.claimIds,
    ).toEqual([]);
  });
  it("retains arbitrary targets and only requested dimensions", async () => {
    const plan = await buildPlan(question, "quick", offline(), undefined, {
      researchChatOptimization: true,
    });
    expect(plan.interpretation.comparison).toEqual({
      targets: ["Aster", "Beryl"],
      dimensions: ["latency", "recall"],
    });
    expect(plan.structuredObjectives?.map((objective) => objective.category)).toEqual([
      "latency",
      "recall",
    ]);
    expect(plan.queries[0]).toMatch(/Aster.*Beryl/);
    expect(plan.queries[0]).toMatch(/current|latest/i);
    expect(
      comparisonObjective("Compare Aster and Beryl on energy efficiency and durability")
        ?.dimensions,
    ).toEqual(["energy efficiency", "reliability"]);
    expect(comparisonObjective("Compare Aster and Beryl on error recovery")?.dimensions).toEqual([
      "error recovery",
    ]);
    expect(comparisonObjective("Compare HNSW and IVF performance")?.dimensions).toEqual([
      "performance",
    ]);
  });

  it.each([
    "Aster is used for vector search.",
    "Beryl improves search efficiency.",
    "This article compares Aster and Beryl latency and recall.",
  ])("does not license generic evidence: %s", (text) => {
    expect(comparisonClaimDimensions(comparisonObjective(question)!, text)).toEqual([]);
    expect(
      comparisonCoverage(comparisonObjective(question)!, [
        {
          id: "generic",
          text,
          sourceIds: ["s"],
          evidence: text,
          confidence: 1,
          verification: { verdict: "supported", rationale: "offline" },
        },
      ]).sufficient,
    ).toBe(false);
  });

  it("targets missing recall without adding resolved latency or dropping either target", async () => {
    const llm = offline();
    const plan = await buildPlan(question, "quick", llm, undefined, {
      researchChatOptimization: true,
    });
    const claims = ["Aster", "Beryl"].map((target, index): Claim => ({
      id: String(index),
      text: `${target} latency is 10 milliseconds.`,
      sourceIds: ["s"],
      evidence: `${target} latency is 10 milliseconds.`,
      confidence: 1,
      verification: { verdict: "supported", rationale: "offline" },
    }));
    const comparison = comparisonCoverage(plan.interpretation.comparison!, claims);
    expect(comparison.missing).toEqual([
      { target: "Aster", dimension: "recall" },
      { target: "Beryl", dimension: "recall" },
    ]);
    const requirements: ResearchRecoveryRequirements = {
      comparison,
      requestedFacts: [],
      resolvedFacts: [],
      unresolvedFacts: [],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: true, stable: false },
      officialSourceRequirement: "none",
      officialEvidenceResolved: false,
    };
    const [query] = await rewriteQueries(question, plan, [], "quick", llm, [], requirements);
    expect(query).toMatch(/Aster vs Beryl recall/);
    expect(query).not.toContain("latency");
    expect(query).toMatch(/current|latest/);
    expect(validateRecoveryQuery(query!, question, plan, requirements).accepted).toBe(true);
    expect(
      validateRecoveryQuery("current vector indexing performance", question, plan, requirements)
        .accepted,
    ).toBe(false);
  });

  it.each([
    "generic-recover",
    "partial-recover",
    "exhausted",
    "complete-first",
    "none",
    "broad-recover",
    "complete-single-claim",
    "context-first",
  ])("adapts comparison research: %s", async (scenario) => {
    const llm = offline();
    const store = new SqliteSessionStore(":memory:");
    const request = ["broad-recover", "context-first"].includes(scenario)
      ? "Compare current Aster and Beryl vector indexing performance"
      : question;
    const generic =
      "This article compares Aster and Beryl latency and recall for measured benchmark workloads, without reporting the comparison results.";
    const latency =
      "Aster latency is 10 milliseconds under the documented benchmark workload. Beryl latency is 20 milliseconds under the same documented benchmark workload.";
    const recall =
      "Aster recall is 95 percent under the documented benchmark workload. Beryl recall is 90 percent under the same documented benchmark workload.";
    const complete =
      "Aster latency is 10 milliseconds and Aster recall is 95 percent in the documented benchmark. Beryl latency is 20 milliseconds and Beryl recall is 90 percent in the documented benchmark.";
    const queries: string[] = [];
    const search = {
      search: async (query: string) => {
        queries.push(query);
        if (scenario === "none") return [];
        return [
          {
            title: "Aster and Beryl latency and recall benchmarks",
            url:
              queries.length === 1
                ? "https://first.example.org/benchmarks"
                : "https://second.example.org/benchmarks",
            snippet: generic,
          },
          ...(scenario === "partial-recover" && queries.length === 1
            ? [
                {
                  title: "Aster and Beryl latency and recall benchmarks",
                  url: "https://decoy.example.org/benchmarks",
                  snippet: generic,
                },
              ]
            : []),
        ];
      },
    };
    const registry = createToolRegistry(search, llm, store);
    registry.register({
      name: "fetch_url",
      description: "offline",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "offline" }),
    });
    registry.register({
      name: "extract_content",
      description: "offline",
      execute: async (input) => ({
        title: "Aster and Beryl latency and recall benchmarks",
        content: (input as { url: string }).url.includes("second")
          ? scenario === "broad-recover"
            ? "Beryl vector indexing latency is 15 milliseconds in the documented workload."
            : scenario === "partial-recover"
              ? recall
              : complete
          : scenario === "context-first"
            ? "Aster links nearby items in a graph during vector indexing. This means it requires less memory and keeps latency stable in the documented workload.\n\nBeryl groups vectors into partitions around shared centers. This means its scan depth controls latency and recall on the documented workload."
            : scenario === "broad-recover"
              ? "Aster vector indexing latency is 10 milliseconds in the documented workload. Beryl vector indexing memory usage requires 20 gigabytes in the documented workload."
              : scenario === "partial-recover"
                ? latency
                : scenario === "complete-single-claim"
                  ? "Aster latency is 10 milliseconds and recall is 95 percent in this workload, whereas Beryl latency is 20 milliseconds and recall is 90 percent in this workload."
                  : scenario === "complete-first"
                    ? complete
                    : generic,
      }),
    });
    const verify = vi.fn(async () => ({ verdict: "supported" }));
    registry.register({ name: "verify_claim", description: "offline", execute: verify });
    const synthesize = vi.fn(async (input) => {
      const value = input as { claims: Claim[]; sources: Source[] };
      return value.claims
        .map((claim) =>
          claim.text
            .split(/(?<=[.!?])\s+/)
            .map(
              (sentence) =>
                `${sentence} [${value.sources.findIndex((source) => source.id === claim.sourceIds[0]) + 1}].`,
            )
            .join(" "),
        )
        .join("\n\n");
    });
    registry.register({ name: "synthesize", description: "offline", execute: synthesize });
    const runner = new ResearchRunner(
      store,
      search,
      llm,
      registry,
      {
        maxQueries: scenario === "exhausted" ? 1 : 2,
        maxSources: 2,
        maxPages: 2,
        maxSteps: 14,
        maxSearchPasses: 1,
        maxModelDecisions: 0,
        maxTimeMs: 5000,
      },
      undefined,
      true,
    );
    try {
      await runner.runQueued(scenario, request, "quick", [], {
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      });
      const session = (await store.get(scenario))!;
      expect(session.status, session.error).toBe(
        ["exhausted", "none"].includes(scenario) ? "FAILED" : "COMPLETED",
      );
      expect(session.state?.comparisonCoverage?.sufficient).toBe(
        !["exhausted", "none"].includes(scenario),
      );
      expect(session.state?.comparisonOutcome).toBe(
        scenario === "none"
          ? "no_relevant_evidence"
          : scenario === "exhausted"
            ? "relevant_but_insufficient"
            : "sufficient",
      );
      expect(queries).toHaveLength(
        ["exhausted", "complete-first", "complete-single-claim", "context-first"].includes(scenario)
          ? 1
          : 2,
      );
      if (queries.length === 2) {
        expect(queries[1]).toMatch(/Aster vs Beryl/);
        expect(queries[1]).toContain(scenario === "broad-recover" ? "memory" : "recall");
        if (scenario === "broad-recover") {
          expect(queries[1]).toContain("latency");
          expect(
            session.searchRecoveries?.[0].requirements?.comparison?.performanceDimensions?.shared,
          ).toEqual([]);
          expect(session.state?.comparisonCoverage?.performanceDimensions?.shared).toEqual([
            "latency",
          ]);
        }
        if (scenario === "partial-recover") expect(queries[1]).not.toContain("latency");
        expect(
          session.searchRecoveries?.[0].requirements?.comparison?.missing.length,
        ).toBeGreaterThan(0);
      }
      if (scenario === "partial-recover")
        expect(session.sources.some((source) => source.url.includes("decoy"))).toBe(false);
      if (scenario === "context-first") {
        expect(session.sources).toHaveLength(1);
        expect(session.state?.comparisonCoverage?.performanceDimensions?.shared).toContain(
          "latency",
        );
        expect(session.state?.verifiedClaims.every((claim) => /Aster|Beryl/.test(claim.text))).toBe(
          true,
        );
      }
      if (["exhausted", "none"].includes(scenario)) {
        expect(session.error).toMatch(/INSUFFICIENT_EVIDENCE.*comparison evidence/);
        expect(verify).not.toHaveBeenCalled();
        expect(synthesize).not.toHaveBeenCalled();
      } else {
        expect(verify.mock.calls.length).toBeGreaterThanOrEqual(
          scenario === "complete-single-claim" ? 1 : 2,
        );
        if (scenario === "complete-single-claim") {
          expect(verify).toHaveBeenCalledTimes(1);
          expect(session.claims).toHaveLength(1);
        }
        expect(synthesize).toHaveBeenCalledTimes(1);
      }
    } finally {
      store.close();
    }
  });

  it.each([383, 385, 2049])(
    "handles compact verification with %s completion tokens without stale verdicts",
    async (tokens) => {
      const previousKey = config.OPENROUTER_API_KEY;
      config.OPENROUTER_API_KEY = "test-only-key";
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).max_completion_tokens).toBe(
          NORMAL_CHAT_VERIFICATION_COMPLETION_TOKENS,
        );
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: tokens > 2048 ? "length" : "stop",
                message: {
                  content: JSON.stringify({
                    verifications: [{ id: "claim", verdict: "supported" }],
                  }),
                },
              },
            ],
            usage: {
              completion_tokens: tokens,
              completion_tokens_details: { reasoning_tokens: tokens - 30 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      const provider = new OpenRouterProvider({ maxAttempts: 1 });
      const registry = createToolRegistry({ search: async () => [] }, provider);
      try {
        await withOperationContext(async () => {
          const result = await registry.execute("verify_claim", {
            claim: "Aster latency is 10 ms.",
            evidence: "Aster latency is 10 ms.",
            researchChatOptimization: true,
          });
          expect(result).toMatchObject({ verdict: tokens > 2048 ? "unavailable" : "supported" });
          expect(provider.metrics.calls).toBe(1);
          expect(provider.metrics.failures).toBe(tokens > 2048 ? 1 : 0);
        });
        await withOperationContext(async () => {
          expect(provider.metrics.calls).toBe(0);
          expect(provider.metrics.citationEntailment).toBeUndefined();
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        config.OPENROUTER_API_KEY = previousKey;
        fetch.mockRestore();
      }
    },
  );

  it("captures actual scoped provider calls for diagnostics without leaking to the next operation", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
            usage: { completion_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new OpenRouterProvider({ maxAttempts: 1 });
    const registry = createToolRegistry({ search: async () => [] }, provider);
    try {
      const snapshot = await withOperationContext(async () => {
        await provider.complete("system", "one");
        await provider.complete("system", "two");
        await provider.complete("system", "three");
        return registry.providerMetrics!();
      });
      expect(snapshot.writer.calls).toBe(3);
      expect(snapshot.writer.records).toHaveLength(3);
      expect(snapshot.writer.usage.completionTokens).toBe(15);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(provider.metrics.calls).toBe(0);
      await withOperationContext(async () => {
        expect(registry.providerMetrics!().writer.calls).toBe(0);
      });
      expect(snapshot.writer.calls).toBe(3);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      fetch.mockRestore();
    }
  });

  it("does not reuse a previous supported verdict when a later operation exhausts its token allowance", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const finish_reason of ["stop", "length"])
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason,
                message: {
                  content: JSON.stringify({
                    verifications: [{ id: "claim", verdict: "supported" }],
                  }),
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const provider = new OpenRouterProvider({ maxAttempts: 1 });
    const registry = createToolRegistry({ search: async () => [] }, provider);
    const input = {
      claim: "Aster latency is 10 ms.",
      evidence: "Aster latency is 10 ms.",
      researchChatOptimization: true,
    };
    try {
      const previous = await withOperationContext(() => registry.execute("verify_claim", input));
      expect(previous).toMatchObject({ verdict: "supported" });
      const current = await withOperationContext(async () => {
        expect(provider.metrics.calls).toBe(0);
        const result = await registry.execute("verify_claim", input);
        expect(provider.metrics.calls).toBe(1);
        expect(provider.metrics.failures).toBe(1);
        return result;
      });
      expect(current).toMatchObject({ verdict: "unavailable" });
      expect(previous).toMatchObject({ verdict: "supported" });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      fetch.mockRestore();
    }
  });

  it("persists worker-scoped verifier metrics in the research snapshot", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verifications: [{ id: "claim", verdict: "supported" }],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const store = new SqliteSessionStore(":memory:");
    const planner = offline();
    const verifier = new OpenRouterProvider({ maxAttempts: 1 });
    const content =
      "Aster latency is 10 milliseconds and Aster recall is 95 percent in the documented benchmark. Beryl latency is 20 milliseconds and Beryl recall is 90 percent in the documented benchmark.";
    const search = {
      search: async () => [
        {
          title: "Aster and Beryl latency and recall benchmarks",
          url: "https://metrics.example.org/benchmark",
          snippet: content,
        },
      ],
    };
    const registry = createToolRegistry(search, planner, store, { verifier });
    registry.register({
      name: "fetch_url",
      description: "offline",
      execute: async () => ({ html: "offline" }),
    });
    registry.register({
      name: "extract_content",
      description: "offline",
      execute: async () => ({ title: "Aster and Beryl latency and recall benchmarks", content }),
    });
    registry.register({
      name: "synthesize",
      description: "offline",
      execute: async (input) =>
        (input as { claims: Claim[] }).claims.map((claim) => `${claim.text} [1].`).join("\n\n"),
    });
    const runner = new ResearchRunner(
      store,
      search,
      planner,
      registry,
      {
        maxQueries: 1,
        maxSources: 1,
        maxPages: 1,
        maxSearchPasses: 0,
        maxSteps: 14,
        maxModelDecisions: 0,
        maxTimeMs: 4000,
      },
      undefined,
      true,
    );
    try {
      await runner.runQueued("metrics-job", question, "quick", [], {
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      });
      const session = (await store.get("metrics-job"))!;
      expect(session.error).toBeUndefined();
      expect(session.status).toBe("COMPLETED");
      expect(session.state?.providerMetrics?.verifier.calls).toBe(2);
      expect(session.state?.providerMetrics?.verifier.records).toHaveLength(2);
      expect(session.state?.providerMetrics?.writer.calls).toBe(0);
      expect(verifier.metrics.calls).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
      config.OPENROUTER_API_KEY = previousKey;
      fetch.mockRestore();
    }
  });
});
