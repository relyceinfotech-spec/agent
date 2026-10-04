import { describe, expect, it, vi } from "vitest";
import {
  initialSearchQueryLimit,
  hasCitationValidationFailure,
  hasResearchChatFinalCoverageFailure,
  isNonRetryableResearchFailure,
  matchObjective,
  missingRequestedFactSupport,
  researchBudgetFor,
  ResearchRunner,
} from "../src/research.js";
import type { Claim, ResearchObjective, SearchResult, Source } from "../src/domain.js";
import { config } from "../src/config.js";
import { createToolRegistry, ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { MemorySessionStore } from "../src/store.js";

const objective = (id: string, category: string, label = category): ResearchObjective => ({
  id,
  category,
  label,
  importance: "high",
  status: "pending",
  evidenceIds: [],
  sourceIds: [],
  coverage: 0,
});

describe("evidence-to-objective matching", () => {
  const objectives = [
    objective("architecture", "architecture", "Core architecture and feature parity"),
    objective("performance", "performance", "Performance benchmarks and scalability"),
    objective("ecosystem", "ecosystem", "Developer tooling ecosystem and migration friction"),
    objective("limitations", "limitations", "Known limitations and trade-offs"),
  ];

  it("maps evidence to its closest research dimension, not the first objective", () => {
    expect(
      matchObjective("A benchmark measured frame rate and memory performance.", objectives)?.id,
    ).toBe("performance");
    expect(
      matchObjective("The developer community has a large package ecosystem.", objectives)?.id,
    ).toBe("ecosystem");
    expect(matchObjective("This limitation is a compatibility trade-off.", objectives)?.id).toBe(
      "limitations",
    );
  });

  it("does not assign unrelated evidence to an arbitrary objective", () => {
    expect(matchObjective("The documentation was updated last week.", objectives)).toBeUndefined();
  });

  it("does not lexically map a partial release claim to fact-driven objectives", () => {
    const factObjectives: ResearchObjective[] = [
      {
        ...objective(
          "obj-version-status",
          "status",
          "Determine the latest stable version of React",
        ),
        requiredFacts: ["version", "stable status", "latestness"],
      },
      {
        ...objective("obj-release-date", "release_date", "Verify the release date of React"),
        requiredFacts: ["release date"],
      },
    ];

    expect(
      matchObjective("React 19.3 is available and a feature is stable.", factObjectives),
    ).toBeUndefined();
  });
});

describe("controller-enforced research budgets", () => {
  it("fails citation validation for uncited final statements but accepts terminal citations", () => {
    const validated = { status: "VALIDATED" as const, finalAnswer: "", items: [] };

    expect(
      hasCitationValidationFailure(
        validated,
        validated,
        "React 19.2.0 was released on September 15, 2026. [1]\n\nSome statements were omitted because the cited evidence did not sufficiently support them.",
        1,
      ),
    ).toBe(false);
    expect(
      hasCitationValidationFailure(
        validated,
        validated,
        "Insufficient evidence to provide a verified answer: the release date and latestness are not established.",
        1,
      ),
    ).toBe(false);
    expect(
      hasCitationValidationFailure(
        validated,
        validated,
        "This is a factual sentence that has no source citation attached to it.",
        1,
      ),
    ).toBe(true);
    expect(
      hasCitationValidationFailure(
        validated,
        { status: "PARTIAL", finalAnswer: "partial", items: [] },
        "A partially supported cited result [1].",
        1,
      ),
    ).toBe(true);
    expect(
      hasCitationValidationFailure(
        validated,
        { status: "SKIPPED", finalAnswer: "skipped", items: [] },
        "A factual cited result [1].",
        1,
      ),
    ).toBe(true);
  });

  it("prevents Research Chat completion when final synthesis coverage is incomplete", () => {
    expect(
      hasResearchChatFinalCoverageFailure(true, {
        required: ["end-of-life date"],
        present: [],
        missing: ["end-of-life date"],
      }),
    ).toBe(true);
    expect(
      hasResearchChatFinalCoverageFailure(true, {
        required: ["end-of-life date"],
        present: ["end-of-life date"],
        missing: [],
      }),
    ).toBe(false);
    expect(
      hasResearchChatFinalCoverageFailure(false, {
        required: ["end-of-life date"],
        present: [],
        missing: ["end-of-life date"],
      }),
    ).toBe(false);
  });

  it("requires verified claims to state each specifically requested value", () => {
    const question =
      "Investigate the latest stable React release; verify the version and release date.";

    expect(
      missingRequestedFactSupport(question, [
        "The React releases page lists stable versions and release details.",
      ]),
    ).toEqual([
      "the requested version is not stated in a verified claim",
      "the requested release date is not stated in a verified claim",
      "the requested version is not explicitly identified as stable",
      "the requested latest/stable status is not established by a versioned claim",
    ]);
    expect(
      missingRequestedFactSupport(question, [
        "React 19.2.0 is the latest stable release, released on September 15, 2026.",
      ]),
    ).toEqual([]);
    expect(
      missingRequestedFactSupport("What is the exact maximum payload size?", [
        "The maximum payload size is 12 MB.",
      ]),
    ).toEqual([]);
    expect(
      missingRequestedFactSupport(
        "Investigate current official React release documentation and history; cite sources.",
        ["The official React release history links to detailed release documentation."],
      ),
    ).toEqual([]);
  });

  it("caps caller and evaluator overrides at the mode and deployment ceilings", () => {
    const overrides = {
      maxSteps: 100,
      maxQueries: 100,
      maxSources: 100,
      maxPages: 100,
      maxSearchPasses: 100,
      maxClaimsToVerify: 100,
      maxTimeMs: Number.MAX_SAFE_INTEGER,
      maxModelDecisions: 100,
    };

    expect(researchBudgetFor("quick", overrides)).toEqual({
      maxSteps: Math.min(config.MAX_RESEARCH_STEPS, 14),
      maxQueries: Math.min(config.MAX_SEARCH_QUERIES, 4),
      maxSources: Math.min(config.MAX_SOURCES, 6),
      maxPages: Math.min(config.MAX_PAGES, 4),
      maxSearchPasses: 2,
      maxClaimsToVerify: 3,
      maxTimeMs: config.MAX_RESEARCH_TIME_MS,
      maxModelDecisions: config.MAX_MODEL_DECISIONS,
    });

    expect(researchBudgetFor("deep", overrides)).toEqual({
      maxSteps: Math.min(config.MAX_RESEARCH_STEPS, 24),
      maxQueries: Math.min(config.MAX_SEARCH_QUERIES, 8),
      maxSources: Math.min(config.MAX_SOURCES, 12),
      maxPages: Math.min(config.MAX_PAGES, 6),
      maxSearchPasses: 2,
      maxClaimsToVerify: 6,
      maxTimeMs: config.MAX_RESEARCH_TIME_MS,
      maxModelDecisions: config.MAX_MODEL_DECISIONS,
    });
    expect(researchBudgetFor("deep", { maxSteps: 8, maxQueries: 8 })).toMatchObject({
      maxSteps: 8,
      maxQueries: 8,
    });
    expect(researchBudgetFor("quick")).toMatchObject({ maxSearchPasses: 1 });
    expect(researchBudgetFor("quick", { maxQueries: 2, maxSearchPasses: 2 })).toMatchObject({
      maxQueries: 2,
      maxSearchPasses: 2,
    });
    expect(initialSearchQueryLimit(2, 2, true)).toBe(1);
  });

  it("allows the isolated test evaluator to use its explicit five-search ceiling", () => {
    const evaluatorBudget = {
      maxSteps: 40,
      maxQueries: 5,
      maxSources: 5,
      maxPages: 5,
      maxSearchPasses: 4,
      maxClaimsToVerify: 5,
      maxTimeMs: 180_000,
      maxModelDecisions: 4,
    };

    expect(researchBudgetFor("quick", evaluatorBudget, evaluatorBudget)).toEqual(evaluatorBudget);
    expect(researchBudgetFor("quick", evaluatorBudget)).toMatchObject({
      maxQueries: 4,
      maxSearchPasses: 2,
    });
  });

  it("does not classify insufficient-evidence failures as retryable worker failures", () => {
    expect(isNonRetryableResearchFailure("INSUFFICIENT_EVIDENCE: no verified claims")).toBe(true);
    expect(isNonRetryableResearchFailure("CITATION_VALIDATION_FAILED: rejected answer")).toBe(true);
    expect(isNonRetryableResearchFailure("RESEARCH_INCOMPLETE: budget exhausted")).toBe(true);
    expect(isNonRetryableResearchFailure("Serper returned HTTP 503")).toBe(false);
    expect(isNonRetryableResearchFailure(undefined)).toBe(false);
  });

  it("fails closed when search succeeds but no retrieval/evidence steps can run", async () => {
    const calls: string[] = [];
    const result: SearchResult = {
      title: "React releases",
      url: "https://react.dev/versions",
      snippet: "The React releases page contains recent updates and version information.",
    };
    const tools = new ToolRegistry().register({
      name: "web_search",
      description: "Search test fixture",
      execute: async () => {
        calls.push("web_search");
        return [result];
      },
    });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools, {
      maxSteps: 1,
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxSearchPasses: 0,
      maxClaimsToVerify: 1,
      maxTimeMs: 5_000,
      maxModelDecisions: 0,
    });
    const started = await runner.start(
      "What is the latest stable React release? Verify the version and release date.",
      "quick",
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = await store.get(started.id);
    expect(calls).toEqual(["web_search"]);
    expect(
      finished?.steps.some(
        (step) => step.label.includes("web_search") && step.status === "complete",
      ),
    ).toBe(true);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(finished?.answer).toContain("Insufficient evidence");
    expect(finished?.answer).not.toContain("Research reached its bounded");
  });

  it("does not complete a release lookup when supported claims omit the requested version and date", async () => {
    const genericContent =
      "The React releases page lists stable versions and release details, and links to official documentation about recent updates. ".repeat(
        2,
      );
    const result: SearchResult = {
      title: "React releases",
      url: "https://react.dev/versions",
      snippet: "The React releases page contains recent updates and version information.",
    };
    const calls: string[] = [];
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claims_batch",
      "detect_conflict",
      "synthesize",
    ]) {
      tools.register({
        name,
        description: name,
        execute: async (input) => {
          calls.push(name);
          if (name === "web_search" || name === "search_again") return [result];
          if (name === "fetch_url") return { url: (input as { url: string }).url, html: "fixture" };
          if (name === "extract_content") return { title: result.title, content: genericContent };
          if (name === "extract_claims") {
            const source = (input as { sources: Array<{ id: string; content?: string }> })
              .sources[0]!;
            return [
              {
                id: "release-page-claim",
                text: "The React releases page lists stable versions and links to official release details.",
                evidence: genericContent,
                sourceIds: [source.id],
                confidence: 0.9,
              },
              {
                id: "release-history-claim",
                text: "The official release history records changes for each published React version.",
                evidence: genericContent,
                sourceIds: [source.id],
                confidence: 0.9,
              },
            ];
          }
          if (name === "gather_evidence") return (input as { claims: Claim[] }).claims;
          if (name === "verify_claims_batch")
            return (input as { claims: Array<{ id: string }> }).claims.map(({ id }) => ({
              id,
              verdict: "supported",
              rationale: "The source supports this general release-history claim.",
            }));
          if (name === "detect_conflict") return [];
          if (name === "synthesize") return "The current version is 19.2.0 [1].";
          return [];
        },
      });
    }

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools, {
      maxSteps: 12,
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxSearchPasses: 1,
      maxClaimsToVerify: 2,
      maxTimeMs: 5_000,
      maxModelDecisions: 0,
    });
    const started = await runner.start(
      "Investigate the latest stable React release; verify the version and release date.",
      "quick",
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = await store.get(started.id);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(finished?.error).toContain("requested version");
    expect(finished?.error).toContain("release date");
    expect(finished?.answer).toContain("Insufficient evidence");
    expect(calls).not.toContain("synthesize");
    expect(finished?.state?.evidenceStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(finished?.sources[0]?.taskEvidence).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      missingFacts: expect.arrayContaining([
        "the requested version is not stated in a verified claim",
        "the requested release date is not stated in a verified claim",
      ]),
    });
  });
});
import { OpenRouterProvider } from "../src/llm.js";
import { rankResults } from "../src/rank.js";
import type { ResearchPlan, ResearchState, Source } from "../src/domain.js";

const result: SearchResult = {
  title: "Primary evidence",
  url: "https://example.com/evidence",
  snippet: "Evidence about React Native and Flutter performance",
};
const claim: Claim = {
  id: "claim-1",
  text: "The benchmark reports a measurable performance difference.",
  sourceIds: ["source-id"],
  evidence: "The benchmark reports a measurable performance difference.",
  confidence: 0.8,
};

describe("bounded research query allocation", () => {
  it("reserves two of four queries for objective recovery in complex comparisons", () => {
    expect(initialSearchQueryLimit(4, 1, true)).toBe(2);
  });

  it("keeps the usual one-query rewrite reserve for other quick research", () => {
    expect(initialSearchQueryLimit(4, 1, false)).toBe(3);
  });

  it("does not increase the query ceiling for deeper research", () => {
    expect(initialSearchQueryLimit(8, 2, true)).toBe(6);
  });

  it("never schedules a query when the controller has a zero-query ceiling", () => {
    expect(initialSearchQueryLimit(0, 1, true)).toBe(0);
  });

  it("reserves exactly four one-query recovery opportunities under a five-query ceiling", () => {
    const initialQueries = initialSearchQueryLimit(5, 4, false, true);
    const recoveryCapacity = Math.min(4, 5 - initialQueries);

    expect(initialQueries).toBe(1);
    expect(initialQueries + recoveryCapacity).toBe(5);
  });

  it("keeps legacy initial batching unless the adaptive Research Chat policy is enabled", () => {
    expect(initialSearchQueryLimit(5, 0, false)).toBe(4);
    expect(initialSearchQueryLimit(5, 4, false, true)).toBe(1);
  });
});

describe("autonomous research loop", () => {
  const buildEfficiencyFixture = async (
    adaptiveEvidenceLoop: boolean,
    recoverWithSecondSource = false,
    claimsPerSource = 1,
    preverifiedClaims = false,
    maxPages = 4,
    snippetFirstSource = false,
  ) => {
    const question = "What is the boiling point of pure water at standard atmospheric pressure?";
    const results: SearchResult[] = [
      {
        title: "Water boiling point at standard pressure",
        url: "https://www.nist.gov/water-boiling-point",
        snippet: "Pure water boils at 100 degrees Celsius at standard atmospheric pressure.",
      },
      {
        title: "Water properties and boiling point",
        url: "https://www.usgs.gov/water-properties",
        snippet: "At one atmosphere, water boils at 100 degrees Celsius.",
      },
      {
        title: "Physical properties of water",
        url: "https://www.britannica.com/science/water",
        snippet: "Water's boiling point at standard pressure is 100 degrees Celsius.",
      },
    ];
    const calls: string[] = [];
    let fetchCalls = 0;
    const researchChatPolicyFlags: boolean[] = [];
    const extractedBatchSizes: number[] = [];
    const verificationBatches: string[][] = [];
    const verifiedClaimTexts: string[] = [];
    const synthesizedClaimCounts: number[] = [];
    const controllerProposals: string[][] = [];
    const claimFacts = [
      "Pure water boils at 100 degrees Celsius at standard atmospheric pressure.",
      "The boiling point of pure water is 100 degrees Celsius at one atmosphere.",
      "Water boils at 100 degrees Celsius when pressure is one atmosphere.",
      "At standard atmospheric pressure, pure water reaches its boiling point at 100 degrees Celsius.",
      "Pure water changes from liquid to vapor at 100 degrees Celsius under one atmosphere of pressure.",
      "One atmosphere is the standard pressure used for this boiling-point measurement.",
      "The boiling point measurement is specific to pure water at standard atmospheric pressure.",
    ];
    const sourceContent = claimFacts.join(" ");
    const registry = new ToolRegistry();
    registry.register({
      name: "web_search",
      description: "Deterministic search fixture",
      execute: async (input) => {
        calls.push("web_search");
        const queries = (input as { queries: string[] }).queries;
        expect(queries).toHaveLength(adaptiveEvidenceLoop ? 1 : 3);
        if (preverifiedClaims) modelEnabled = true;
        return recoverWithSecondSource ? results.slice(0, 1) : results;
      },
    });
    registry.register({
      name: "search_again",
      description: "Deterministic recovery fixture",
      execute: async () => {
        calls.push("search_again");
        return recoverWithSecondSource ? results.slice(1, 2) : [];
      },
    });
    registry.register({
      name: "fetch_url",
      description: "Deterministic page fixture",
      execute: async (input) => {
        calls.push("fetch_url");
        researchChatPolicyFlags.push(
          (input as { researchChatOptimization?: boolean }).researchChatOptimization === true,
        );
        fetchCalls += 1;
        const snippetOnly = snippetFirstSource && fetchCalls === 1;
        return {
          url: (input as { url: string }).url,
          html: "fixture",
          retrievalMethod: snippetOnly ? "serper_snippet" : "http",
          retrievalAttempts: snippetOnly ? ["serper_snippet"] : ["serper_snippet", "http"],
        };
      },
    });
    registry.register({
      name: "extract_content",
      description: "Deterministic extraction fixture",
      execute: async (input) => {
        calls.push("extract_content");
        const url = (input as { url: string }).url;
        const source = results.find((result) => result.url === url)!;
        return {
          title: source.title,
          content: sourceContent,
        };
      },
    });
    registry.register({
      name: "extract_claims",
      description: "One source-linked fixture claim per source",
      execute: async (input) => {
        calls.push("extract_claims");
        const sources = (input as { sources: Source[] }).sources;
        extractedBatchSizes.push(sources.length);
        return sources.flatMap((source) => {
          const sourceIndex = results.findIndex((result) => result.url === source.url);
          return Array.from({ length: claimsPerSource }, (_, index) => {
            const fact = claimFacts[sourceIndex * claimsPerSource + index];
            return {
              id: `boiling-point-${sourceIndex}-${index}-${source.id}`,
              text: fact,
              sourceIds: [source.id],
              evidence: fact,
              confidence: 0.95,
              ...(preverifiedClaims
                ? {
                    verification: {
                      verdict: "supported" as const,
                      rationale: "The deterministic evidence gate already supports this claim.",
                    },
                  }
                : {}),
            };
          });
        });
      },
    });
    registry.register({
      name: "gather_evidence",
      description: "Deterministic evidence fixture",
      execute: async (input) => {
        calls.push("gather_evidence");
        return (input as { claims: Claim[] }).claims;
      },
    });
    registry.register({
      name: "verify_claim",
      description: "Verify one claim at a time for Research Chat.",
      execute: async (input) => {
        calls.push("verify_claim");
        const claim = (input as { claim: string }).claim;
        verifiedClaimTexts.push(claim);
        return {
          verdict: "supported",
          rationale: "The fixture source states the claim directly.",
        };
      },
    });
    registry.register({
      name: "verify_claims_batch",
      description: "Deterministic verification fixture",
      execute: async (input) => {
        calls.push("verify_claims_batch");
        const claims = (input as { claims: Array<{ id: string }> }).claims;
        verificationBatches.push(claims.map(({ id }) => id));
        return claims.map(({ id }) => ({
          id,
          verdict: "supported",
          rationale: "The fixture source states the claim directly.",
        }));
      },
    });
    registry.register({
      name: "detect_conflict",
      description: "No conflicts in fixture evidence",
      execute: async () => {
        calls.push("detect_conflict");
        return [];
      },
    });
    registry.register({
      name: "synthesize",
      description: "Deterministic cited answer fixture",
      execute: async (input) => {
        calls.push("synthesize");
        synthesizedClaimCounts.push((input as { claims: Claim[] }).claims.length);
        return "At standard atmospheric pressure, pure water boils at 100 °C [1].";
      },
    });

    const store = new MemorySessionStore();
    const llm = new OpenRouterProvider();
    let modelEnabled = false;
    Object.defineProperty(llm, "enabled", { get: () => modelEnabled });
    llm.proposeResearchAction = async (_observation, allowedActions) => {
      controllerProposals.push([...allowedActions]);
      return allowedActions[0] ?? "synthesize";
    };
    const runner = new ResearchRunner(
      store,
      { search: async () => results },
      llm,
      registry,
      {
        maxSteps: 18,
        maxQueries: 5,
        maxSources: 3,
        maxPages,
        maxSearchPasses: 2,
        maxClaimsToVerify: 4,
        maxTimeMs: 10_000,
        maxModelDecisions: preverifiedClaims ? 8 : 0,
      },
      undefined,
      adaptiveEvidenceLoop,
    );
    const started = await runner.start(question, "deep", [], {
      researchChatOptimization: adaptiveEvidenceLoop,
    });
    let completed: Awaited<ReturnType<typeof store.get>>;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      completed = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(completed?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    completed = await store.get(started.id);
    return {
      calls,
      completed,
      extractedBatchSizes,
      verificationBatches,
      verifiedClaimTexts,
      synthesizedClaimCounts,
      controllerProposals,
      researchChatPolicyFlags,
    };
  };

  it("Research Chat fetches the minimum independent sources and stops before the unused page", async () => {
    const { calls, completed, extractedBatchSizes, verifiedClaimTexts, researchChatPolicyFlags } =
      await buildEfficiencyFixture(true);

    expect(completed?.status).toBe("COMPLETED");
    expect(calls.filter((call) => call === "web_search")).toHaveLength(1);
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(2);
    expect(calls.filter((call) => call === "extract_content")).toHaveLength(2);
    expect(extractedBatchSizes).toEqual([2]);
    expect(calls.filter((call) => call === "verify_claim")).toHaveLength(2);
    expect(calls).not.toContain("verify_claims_batch");
    expect(verifiedClaimTexts).toHaveLength(2);
    expect(
      completed?.steps?.filter(
        (step) => step.label.includes("verify") && step.status === "complete",
      ),
    ).toHaveLength(1);
    expect(calls.filter((call) => call === "synthesize")).toHaveLength(1);
    expect(calls).not.toContain("search_again");
    expect(researchChatPolicyFlags).toEqual([true, true]);
  });

  it("does not spend Research Chat page budget on source data supplied only by a Serper snippet", async () => {
    const { calls, completed, extractedBatchSizes } = await buildEfficiencyFixture(
      true,
      false,
      2,
      false,
      1,
      true,
    );

    expect(completed?.status).toBe("COMPLETED");
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(2);
    expect(calls.filter((call) => call === "extract_content")).toHaveLength(2);
    expect(extractedBatchSizes).toEqual([1, 1]);
    expect(
      completed?.sources.filter((source) => source.retrievalMethod === "serper_snippet"),
    ).toHaveLength(1);
    expect(completed?.sources.filter((source) => source.retrievalMethod === "http")).toHaveLength(
      1,
    );
    expect(calls).not.toContain("search_again");
  });

  it("completes a focused Deep Research lifecycle lookup from one verified official source", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const releaseFact = "Node.js 22 reaches end of life on 2027-04-30.";
    const result: SearchResult = {
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/previous-releases",
      snippet: "Official Node.js release schedule and support lifecycle dates.",
    };
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "web_search",
      description: "Provider-free search fixture",
      execute: async (input) => {
        const queries = (input as { queries: string[] }).queries;
        calls.push(`search:${queries[0]}`);
        expect(queries[0]).toContain("Node.js 22");
        expect(queries[0]).toMatch(/end of life|eol/i);
        expect(queries[0]).toMatch(/official|schedule/i);
        return [result];
      },
    });
    registry.register({
      name: "search_again",
      description: "No additional evidence fixture",
      execute: async () => {
        calls.push("search_again");
        return [];
      },
    });
    registry.register({
      name: "fetch_url",
      description: "Provider-free page fixture",
      execute: async (input) => {
        calls.push("fetch_url");
        expect((input as { requestedFacts: string[] }).requestedFacts).toEqual([
          "end-of-life date",
        ]);
        return {
          url: result.url,
          html: "fixture",
          contentType: "text/html",
          retrievalMethod: "http",
          retrievalAttempts: ["serper_snippet", "http"],
          document: {
            title: result.title,
            domain: "nodejs.org",
            content: releaseFact,
            headings: [],
            contentType: "article",
          },
        };
      },
    });
    registry.register({
      name: "extract_content",
      description: "Provider-free extraction fixture",
      execute: async () => ({ title: result.title, content: releaseFact }),
    });
    registry.register({
      name: "extract_claims",
      description: "Fact-tagged lifecycle claim fixture",
      execute: async (input) => {
        calls.push("extract_claims");
        expect((input as { requestedFacts: string[] }).requestedFacts).toEqual([
          "end-of-life date",
        ]);
        const sources = (input as { sources: Source[] }).sources;
        return [
          {
            id: "node-22-eol",
            text: releaseFact,
            sourceIds: [sources[0]!.id],
            evidence: releaseFact,
            confidence: 1,
            importance: "critical",
            requestedFacts: ["end-of-life date"],
          },
        ];
      },
    });
    registry.register({
      name: "gather_evidence",
      description: "Evidence fixture",
      execute: async (input) => (input as { claims: Claim[] }).claims,
    });
    registry.register({
      name: "verify_claim",
      description: "Verifier fixture",
      execute: async (input) => {
        calls.push("verify_claim");
        return { claim: (input as { claim: string }).claim, verdict: "supported" };
      },
    });
    registry.register({
      name: "detect_conflict",
      description: "No-conflict fixture",
      execute: async () => [],
    });
    registry.register({
      name: "synthesize",
      description: "Cited synthesis fixture",
      execute: async (input) => {
        calls.push("synthesize");
        expect((input as { claims: Claim[] }).claims).toHaveLength(1);
        return `${releaseFact} [1]`;
      },
    });

    const store = new MemorySessionStore();
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => false });
    const runner = new ResearchRunner(
      store,
      { search: async () => [result] },
      llm,
      registry,
      {
        maxSteps: 8,
        maxQueries: 2,
        maxSources: 2,
        maxPages: 1,
        maxSearchPasses: 1,
        maxClaimsToVerify: 2,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "deep", [], {
      researchChatOptimization: true,
    });
    let completed: Awaited<ReturnType<typeof store.get>>;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      completed = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(completed?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    completed = await store.get(started.id);

    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.answer).toContain("2027-04-30.");
    expect(completed?.answer).toContain("[1]");
    expect(completed?.state?.requestedFactCoverage).toEqual({
      required: ["end-of-life date"],
      present: ["end-of-life date"],
      missing: [],
    });
    expect(completed?.sources).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("search:"))).toHaveLength(1);
    expect(calls).not.toContain("search_again");
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(1);
    expect(calls.filter((call) => call === "verify_claim")).toHaveLength(1);
    expect(calls.filter((call) => call === "synthesize")).toHaveLength(1);
  });

  it("fails a Node.js 22 lifecycle lookup when a mixed passage only dates Node.js 18 EOL", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const mixedLifecyclePassage =
      "Node.js 22 is supported, while Node.js 18 reached end of life on 2025-04-30.";
    const content =
      `${mixedLifecyclePassage} The official Node.js lifecycle page lists support phases and maintenance status for supported major release lines. `.repeat(
        2,
      );
    const result: SearchResult = {
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/previous-releases",
      snippet: "Official Node.js release schedule and support lifecycle dates.",
    };
    const wrongVersionResult: SearchResult = {
      title: "Node.js 18 end-of-life schedule",
      url: "https://nodejs.org/en/about/node-18-eol",
      snippet: "Node.js 18 reached end of life on 2025-04-30.",
    };
    const calls: string[] = [];
    const fetchedUrls: string[] = [];
    const registry = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ]) {
      registry.register({
        name,
        description: `Provider-free ${name} fixture`,
        execute: async (input) => {
          calls.push(name);
          if (name === "web_search") return [result];
          if (name === "search_again") return [wrongVersionResult];
          if (name === "fetch_url") {
            fetchedUrls.push((input as { url: string }).url);
            return {
              url: (input as { url: string }).url,
              html: "fixture",
              contentType: "text/html",
              retrievalMethod: "http",
              retrievalAttempts: ["serper_snippet", "http"],
              document: {
                title: result.title,
                domain: "nodejs.org",
                content,
                headings: [],
                contentType: "article",
              },
            };
          }
          if (name === "extract_content") return { title: result.title, content };
          if (name === "extract_claims") {
            const source = (input as { sources: Source[] }).sources[0]!;
            return [
              {
                id: "wrong-version-eol",
                text: "Node.js 22 reached end of life on 2025-04-30.",
                evidence: mixedLifecyclePassage,
                sourceIds: [source.id],
                confidence: 1,
                importance: "critical",
                requestedFacts: ["end-of-life date"],
              },
            ];
          }
          if (name === "gather_evidence") return (input as { claims: Claim[] }).claims;
          if (name === "verify_claim")
            return { verdict: "supported", rationale: "Adversarial fixture verifier." };
          if (name === "detect_conflict") return [];
          if (name === "synthesize") return "Node.js 22 reached end of life on 2025-04-30. [1]";
          return [];
        },
      });
    }

    const store = new MemorySessionStore();
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => false });
    const runner = new ResearchRunner(
      store,
      { search: async () => [result] },
      llm,
      registry,
      {
        maxSteps: 8,
        maxQueries: 2,
        maxSources: 2,
        maxPages: 1,
        maxSearchPasses: 1,
        maxClaimsToVerify: 1,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "deep", [], {
      researchChatOptimization: true,
    });
    let finished: Awaited<ReturnType<typeof store.get>>;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      finished = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(finished?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    finished = await store.get(started.id);

    expect(finished?.status).toBe("FAILED");
    expect(finished?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(finished?.state?.requestedFactCoverage).toEqual({
      required: ["end-of-life date"],
      present: [],
      missing: ["end-of-life date"],
    });
    expect(finished?.answer).toContain("Insufficient evidence");
    expect(finished?.answer).not.toContain("2025-04-30");
    expect(calls.filter((name) => name === "search_again")).toHaveLength(1);
    expect(fetchedUrls).toEqual([result.url]);
    expect(finished?.sourceSelectionDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: wrongVersionResult.url,
          selected: false,
        }),
      ]),
    );
    expect(calls).not.toContain("synthesize");
  });

  it("uses one fact-specific recovery and a sufficient Serper snippet after the page cap is spent", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const initialQuery = "Node.js 22 end of life date official support schedule";
    const searches: string[] = [];
    const fetchedUrls: string[] = [];
    const initialResult: SearchResult = {
      title: "Node.js previous releases",
      url: "https://nodejs.org/en/about/previous-releases",
      snippet: "Official Node.js release schedule and support lifecycle dates.",
    };
    const recoveryResult: SearchResult = {
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/releases",
      snippet: "Node.js 22 reaches end of life on 2027-04-30.",
    };
    const genericRecoveryResult: SearchResult = {
      title: "Node.js lifecycle schedule",
      url: "https://nodejs.org/en/about/support-policy",
      snippet: "Official support lifecycle schedule for Node.js release lines.",
    };
    const wrongVersionRecoveryResult: SearchResult = {
      title: "Node.js 18 end-of-life schedule",
      url: "https://nodejs.org/en/about/node-18-eol",
      snippet: "Node.js 18 reached end of life on 2025-04-30.",
    };
    const calls: string[] = [];
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async (query) => {
          searches.push(query);
          return searches.length === 1
            ? [initialResult]
            : [initialResult, genericRecoveryResult, wrongVersionRecoveryResult, recoveryResult];
        },
      },
      llm,
    );
    registry.register({
      name: "fetch_url",
      description: "Provider-free retrieval fixture",
      execute: async (input) => {
        const source = input as { url: string; snippet: string };
        fetchedUrls.push(source.url);
        calls.push("fetch_url");
        const snippetOnly = source.url === recoveryResult.url;
        return {
          url: source.url,
          html: "",
          contentType: "text/html",
          retrievalMethod: snippetOnly ? "serper_snippet" : "http",
          retrievalAttempts: snippetOnly ? ["serper_snippet"] : ["serper_snippet", "http"],
          document: {
            title: snippetOnly ? recoveryResult.title : initialResult.title,
            domain: "nodejs.org",
            content: snippetOnly
              ? source.snippet
              : "Node.js 22 entered Maintenance LTS in October 2024. The official support schedule describes lifecycle phases and dates for each major release.",
            headings: [],
            contentType: "article",
          },
        };
      },
    });
    registry.register({
      name: "extract_content",
      description: "Use the fixture document unchanged",
      execute: async (input) => (input as { document: unknown }).document,
    });
    registry.register({
      name: "verify_claim",
      description: "Verify only the exact requested lifecycle fact",
      execute: async (input) => {
        calls.push("verify_claim");
        const claim = input as { claim: string; evidence: string };
        expect(claim.claim).toContain("2027-04-30");
        expect(claim.evidence).toContain("Node.js 22");
        return {
          verdict: "supported",
          rationale: "The official snippet states the version and date.",
        };
      },
    });
    registry.register({
      name: "synthesize",
      description: "Return the verified cited lifecycle fact",
      execute: async (input) => {
        calls.push("synthesize");
        expect((input as { claims: Claim[] }).claims).toHaveLength(1);
        return "Node.js 22 reaches end of life on 2027-04-30. [1]";
      },
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      llm,
      registry,
      {
        maxSteps: 8,
        maxQueries: 2,
        maxSources: 2,
        maxPages: 1,
        maxSearchPasses: 1,
        maxClaimsToVerify: 1,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "deep", [], {
      researchChatOptimization: true,
    });
    let completed: Awaited<ReturnType<typeof store.get>>;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      completed = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(completed?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    completed = await store.get(started.id);

    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.answer).toContain("Node.js 22 reaches end of life on 2027-04-30.");
    expect(completed?.answer).toContain("[1]");
    expect(searches).toHaveLength(2);
    expect(searches[0]).toBe(initialQuery);
    expect(searches[1]).not.toBe(searches[0]);
    expect(searches[1]).toMatch(/Node.js 22/i);
    expect(searches[1]).toMatch(/lifecycle|eol/i);
    expect(searches[1]).toMatch(/official|schedule/i);
    expect(searches[1]).toMatch(/maintainer working group/i);
    expect(completed?.searchRecoveries).toHaveLength(1);
    expect(completed?.searchRecoveries[0]?.queries).toEqual([searches[1]]);
    expect(completed?.searchRecoveries[0]?.requirements?.factInsufficientSources).toEqual([
      expect.objectContaining({
        url: initialResult.url,
        missingFacts: ["end-of-life date"],
      }),
    ]);
    expect(completed?.state?.requestedFactCoverage).toEqual({
      required: ["end-of-life date"],
      present: ["end-of-life date"],
      missing: [],
    });
    expect(completed?.sources).toHaveLength(2);
    expect(completed?.sources.map((source) => source.retrievalMethod)).toEqual([
      "http",
      "serper_snippet",
    ]);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls.filter((url) => url === initialResult.url)).toHaveLength(1);
    expect(fetchedUrls).not.toContain(genericRecoveryResult.url);
    expect(fetchedUrls).not.toContain(wrongVersionRecoveryResult.url);
    expect(calls).toContain("verify_claim");
    expect(calls).toContain("synthesize");
    expect(completed?.decisions.map((decision) => decision.nextAction)).toEqual([
      "web_search",
      "fetch_url",
      "search_again",
      "fetch_url",
      "extract_claims",
      "verify_claims",
      "synthesize",
    ]);
    expect(completed?.decisions.length).toBeLessThanOrEqual(8);
    expect(searches).toHaveLength(2);
    expect(completed?.sources.filter((source) => source.retrievalMethod === "http")).toHaveLength(
      1,
    );
    expect(
      completed?.sourceSelectionDecisions?.find((decision) => decision.url === initialResult.url)
        ?.reason,
    ).toContain("Previously evaluated source omitted unresolved fact(s): end-of-life date");
    expect(completed?.steps.some((step) => step.label.includes("source_triage"))).toBe(true);
  });

  it("leaves the default runner's batched retrieval policy unchanged for Post Agent callers", async () => {
    const { calls, completed, extractedBatchSizes, researchChatPolicyFlags } =
      await buildEfficiencyFixture(false);

    expect(completed?.status).toBe("COMPLETED");
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(3);
    expect(calls.filter((call) => call === "extract_content")).toHaveLength(3);
    expect(extractedBatchSizes).toEqual([3]);
    expect(calls.filter((call) => call === "verify_claims_batch")).toHaveLength(1);
    expect(calls).not.toContain("verify_claim");
    expect(researchChatPolicyFlags).toEqual([false, false, false]);
  });

  it("verifies claims one at a time and omits unneeded claims from synthesis once Deep Research is sufficient", async () => {
    const { calls, completed, verifiedClaimTexts, synthesizedClaimCounts } =
      await buildEfficiencyFixture(true, false, 2);

    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.claims).toHaveLength(4);
    expect(
      completed?.claims.filter((claim) => claim.verification?.verdict === "supported"),
    ).toHaveLength(2);
    expect(completed?.claims.filter((claim) => !claim.verification)).toHaveLength(2);
    expect(verifiedClaimTexts).toHaveLength(2);
    expect(new Set(verifiedClaimTexts).size).toBe(2);
    expect(synthesizedClaimCounts).toEqual([2]);
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(2);
    expect(calls).not.toContain("search_again");
  });

  it("uses bounded controller choices to collect independent preverified evidence without re-verifying it", async () => {
    const { calls, completed, controllerProposals } = await buildEfficiencyFixture(
      true,
      false,
      1,
      true,
    );

    expect(completed?.status).toBe("COMPLETED");
    expect(calls).not.toContain("verify_claim");
    expect(calls).not.toContain("verify_claims_batch");
    expect(controllerProposals).toHaveLength(2);
    expect(
      controllerProposals.every(
        (allowed) =>
          allowed.includes("search_again") &&
          allowed.some((action) => action.startsWith("fetch_url:")),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(2);
    expect(calls).not.toContain("search_again");
  });

  it("uses one targeted recovery and does not re-verify already supported claims", async () => {
    const { calls, completed, extractedBatchSizes, verifiedClaimTexts } =
      await buildEfficiencyFixture(true, true);

    expect(completed?.status).toBe("COMPLETED");
    expect(calls.filter((call) => call === "web_search")).toHaveLength(1);
    expect(calls.filter((call) => call === "search_again")).toHaveLength(1);
    expect(calls.filter((call) => call === "fetch_url")).toHaveLength(2);
    expect(extractedBatchSizes).toEqual([1, 1]);
    expect(verifiedClaimTexts).toHaveLength(2);
    expect(verifiedClaimTexts[0]).not.toBe(verifiedClaimTexts[1]);
    expect(calls.filter((call) => call === "synthesize")).toHaveLength(1);
  });

  it("classifies an empty extraction and spends only the bounded recovery search", async () => {
    const calls: string[] = [];
    const initialResults: SearchResult[] = [
      {
        title: "React Native performance benchmark results",
        url: "https://reactnative.dev/blog/benchmark-results",
        snippet: "Official benchmark results and methodology for React Native.",
      },
      {
        title: "Flutter performance benchmark results",
        url: "https://flutter.dev/blog/benchmark-results",
        snippet: "Independent benchmark results and methodology for Flutter.",
      },
    ];
    const recoveryResult: SearchResult = {
      title: "Independent mobile framework benchmark study",
      url: "https://engineering.example.org/mobile-benchmark",
      snippet: "A detailed independent study compares mobile framework benchmark results.",
    };
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claims_batch",
      "detect_conflict",
      "synthesize",
    ])
      tools.register({
        name,
        description: name,
        execute: async (input) => {
          calls.push(name);
          if (name === "web_search") return initialResults;
          if (name === "search_again") return [recoveryResult];
          if (name === "fetch_url") return { url: (input as { url: string }).url, html: "fixture" };
          if (name === "extract_content") {
            const url = (input as { url: string }).url;
            if (url.includes("reactnative.dev"))
              throw new Error("Extracted content is too short to use as evidence");
            return {
              title: "Benchmark evidence",
              content:
                "The study reports benchmark results and methodology for mobile frameworks, including measured performance and the limits of the tested workloads. ".repeat(
                  2,
                ),
            };
          }
          if (name === "extract_claims") {
            const sources = (input as { sources: Source[] }).sources.filter((item) => item.content);
            return sources.map((item, index) => ({
              ...claim,
              id: `claim-${index}`,
              sourceIds: [item.id],
              evidence: item.content!.slice(0, 180),
            }));
          }
          if (name === "verify_claims_batch")
            return ((input as { claims: Array<{ id: string }> }).claims ?? []).map((item) => ({
              id: item.id,
              verdict: "supported",
            }));
          if (name === "synthesize") return "Bounded recovered answer [1].";
          return [];
        },
      });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => initialResults },
      undefined,
      tools,
      {
        maxSteps: 8,
        maxQueries: 2,
        maxSources: 4,
        maxPages: 3,
        maxSearchPasses: 2,
        maxClaimsToVerify: 4,
        maxTimeMs: 5000,
        maxModelDecisions: 0,
      },
    );
    const session = await runner.start("Compare React Native and Flutter performance", "deep");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(session.id);
      if (["COMPLETED", "FAILED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = await store.get(session.id);
    const extractionFailure = finished?.sources.find((source) => source.fetchFailureCategory);

    expect(extractionFailure?.fetchFailureCategory).toBe("EXTRACTION");
    expect(
      finished?.sources.some((source) => source.url.includes("flutter.dev") && source.content),
    ).toBe(true);
    expect(calls.filter((name) => name === "search_again")).toHaveLength(1);
    expect(calls.filter((name) => name === "web_search" || name === "search_again")).toHaveLength(
      2,
    );
  });

  it("observes tool results and refuses deep synthesis without independent sources", async () => {
    const calls: string[] = [];
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ])
      tools.register({
        name,
        description: name,
        execute: async (input) => {
          calls.push(name);
          if (name === "web_search" || name === "search_again") return [result];
          if (name === "fetch_url") return { url: result.url, html: "<article>Evidence</article>" };
          if (name === "extract_content")
            return {
              title: result.title,
              content:
                "React Native and Flutter have a measurable performance difference in the documented benchmark results from this source.",
            };
          if (name === "extract_claims") {
            const source = (input as { sources: Source[] }).sources[0]!;
            return [claim, { ...claim, id: "claim-2" }].map((item) => ({
              ...item,
              sourceIds: [source.id],
            }));
          }
          if (name === "verify_claim")
            return { verdict: "supported", rationale: "The evidence supports the claim." };
          if (name === "synthesize") return "Cited answer";
          return [];
        },
      });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools);
    const session = await runner.start("Compare React Native vs Flutter performance", "deep");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await store.get(session.id);
      if (["COMPLETED", "FAILED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = await store.get(session.id);
    expect(completed?.status).toBe("FAILED");
    expect(completed?.answer).toContain("Insufficient evidence");
    expect(completed?.error).toContain("verified claims lack independent source domains");
    expect(completed?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(completed?.claims[0].verification?.verdict).toBe("supported");
    expect(completed?.stageTimings?.["understand_query + plan"]).toBeTypeOf("number");
    expect(completed?.stageTimings?.web_search).toBeTypeOf("number");
    expect(completed?.stageTimings?.synthesize).toBeTypeOf("number");
    expect(calls).toEqual(
      expect.arrayContaining([
        "web_search",
        "fetch_url",
        "extract_claims",
        "gather_evidence",
        "verify_claim",
        "detect_conflict",
      ]),
    );
  });

  it("fails closed when verifier calls time out and does not synthesize unverified claims", async () => {
    const calls: string[] = [];
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claims_batch",
      "detect_conflict",
      "synthesize",
    ])
      tools.register({
        name,
        description: name,
        execute: async () => {
          calls.push(name);
          if (name === "web_search" || name === "search_again") return [result];
          if (name === "fetch_url") return { url: result.url, html: "<article>Evidence</article>" };
          if (name === "extract_content") return { title: result.title, content: claim.evidence };
          if (name === "extract_claims") return [claim, { ...claim, id: "claim-2" }];
          if (name === "verify_claims_batch")
            return [
              {
                id: claim.id,
                verdict: "unavailable",
                rationale: "Batch verification provider failed: OpenRouter request timed out",
              },
              {
                id: "claim-2",
                verdict: "unavailable",
                rationale: "Batch verification provider failed: OpenRouter request timed out",
              },
            ];
          return [];
        },
      });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools);
    const session = await runner.start("Compare React Native vs Flutter performance", "quick");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(session.id);
      if (["COMPLETED", "FAILED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = await store.get(session.id);

    expect(completed?.claims.every((item) => item.verification?.verdict === "unavailable")).toBe(
      true,
    );
    expect(completed?.answer).toContain("Insufficient evidence");
    expect(completed?.status).toBe("FAILED");
    expect(completed?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(calls).not.toContain("synthesize");
  });

  it("fails closed when semantic citation validation rejects a synthesized answer", async () => {
    const reactResult: SearchResult = {
      title: "React documentation",
      url: "https://react.dev/learn",
      snippet:
        "React is a JavaScript library for building user interfaces and rendering components.",
    };
    const provider = new OpenRouterProvider();
    let enabled = false;
    let citationEntailment: { status: "REJECTED"; failure?: string } | undefined;
    Object.defineProperty(provider, "enabled", { get: () => enabled });
    Object.defineProperty(provider, "metrics", {
      get: () => ({
        calls: 0,
        failures: 0,
        durationMs: 0,
        usage: {},
        records: [],
        citationEntailment,
      }),
    });

    const registry = new ToolRegistry();
    registry.register({
      name: "web_search",
      description: "Fixture search",
      execute: async () => [reactResult],
    });
    registry.register({
      name: "search_again",
      description: "Fixture recovery search",
      execute: async () => [result],
    });
    registry.register({
      name: "fetch_url",
      description: "Fixture page retrieval",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "fixture" }),
    });
    registry.register({
      name: "extract_content",
      description: "Fixture extraction",
      execute: async () => ({
        title: "React documentation",
        content:
          "React is a JavaScript library for building user interfaces, with documented component and rendering concepts for web applications.",
      }),
    });
    registry.register({
      name: "extract_claims",
      description: "Fixture claim extraction",
      execute: async (input) => {
        const source = (input as { sources: Source[] }).sources[0]!;
        return [
          {
            ...claim,
            text: "React is a JavaScript library for building user interfaces.",
            sourceIds: [source.id],
            evidence: source.content ?? claim.evidence,
          },
          {
            ...claim,
            id: "claim-2",
            text: "React documentation describes components for user interfaces.",
            sourceIds: [source.id],
            evidence: source.content ?? claim.evidence,
          },
        ];
      },
    });
    registry.register({
      name: "gather_evidence",
      description: "Fixture evidence gathering",
      execute: async (input) => (input as { claims: Claim[] }).claims,
    });
    registry.register({
      name: "verify_claims_batch",
      description: "Fixture verification",
      execute: async (input) =>
        (input as { claims: Array<{ id: string }> }).claims.map(({ id }) => ({
          id,
          verdict: "supported",
        })),
    });
    registry.register({
      name: "detect_conflict",
      description: "Enable deterministic synthesis after verification",
      execute: async () => {
        enabled = true;
        return [];
      },
    });
    registry.register({
      name: "synthesize",
      description: "Fixture synthesis rejected by citation validation",
      execute: async () => {
        citationEntailment = {
          status: "REJECTED",
          failure: "Citation judge rejected the answer",
        };
        return "Unsupported React claim [1].";
      },
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, provider, registry, {
      maxSteps: 10,
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxSearchPasses: 0,
      maxClaimsToVerify: 2,
      maxTimeMs: 5_000,
      maxModelDecisions: 0,
    });
    const started = await runner.start("What is React?", "quick");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = await store.get(started.id);
    expect(citationEntailment?.status).toBe("REJECTED");
    expect(finished?.status).toBe("FAILED");
    expect(finished?.error).toMatch(/^CITATION_VALIDATION_FAILED:/);
  });

  it("stops on a verification rate limit without wasting a second search pass", async () => {
    const calls: string[] = [];
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claims_batch",
    ])
      tools.register({
        name,
        description: name,
        execute: async (input) => {
          calls.push(name);
          if (name === "web_search") return [result];
          if (name === "fetch_url") return { url: result.url, html: "<article>Evidence</article>" };
          if (name === "extract_content") return { title: result.title, content: claim.evidence };
          if (name === "extract_claims")
            return [{ ...claim, sourceIds: [(input as { sources: Source[] }).sources[0]!.id] }];
          if (name === "verify_claims_batch")
            return [
              {
                id: claim.id,
                verdict: "unavailable",
                rationale: "Batch verification provider failed: OpenRouter returned 429",
              },
            ];
          return [];
        },
      });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools);
    const session = await runner.start("Compare React Native vs Flutter performance", "quick");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(session.id);
      if (current?.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const failed = await store.get(session.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.error).toContain("OpenRouter returned 429");
    expect(failed?.claims).toEqual([
      expect.objectContaining({
        verification: expect.objectContaining({ verdict: "unavailable" }),
      }),
    ]);
    expect(calls).not.toContain("search_again");
  });

  it("completes with cited verified findings when the final OpenRouter synthesis times out", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const question = "Compare React Native vs Flutter for performance and developer experience.";
      const results: SearchResult[] = [
        {
          title: "React Native performance documentation",
          url: "https://reactnative.dev/docs/performance",
          snippet: "React Native performance guidance and profiling.",
        },
        {
          title: "Flutter performance documentation",
          url: "https://docs.flutter.dev/perf/best-practices",
          snippet: "Flutter performance guidance and rendering best practices.",
        },
      ];
      const ranked = rankResults(question, results);
      const evidence = [
        "React Native aims for 60 frames per second on the UI thread.",
        "Flutter recommends avoiding expensive operations to maintain smooth rendering.",
      ];
      const claims: Claim[] = ranked.map((source, index) => ({
        id: `timeout-claim-${index}`,
        text: evidence[index],
        sourceIds: [source.id],
        evidence: evidence[index],
        confidence: 0.9,
      }));
      const llm = new OpenRouterProvider();
      vi.spyOn(llm, "complete").mockRejectedValue(new Error("OpenRouter request timed out"));
      const registry = new ToolRegistry();
      registry.register({
        name: "web_search",
        description: "fixture search",
        execute: async () => results,
      });
      registry.register({
        name: "search_again",
        description: "fixture follow-up search",
        execute: async () => results,
      });
      registry.register({
        name: "fetch_url",
        description: "fixture retrieval",
        execute: async (input) => ({
          url: (input as { url: string }).url,
          html: "<article>Fixture source</article>",
        }),
      });
      registry.register({
        name: "extract_content",
        description: "fixture extraction",
        execute: async (input) => {
          const url = (input as { url: string }).url;
          const index = results.findIndex((item) => item.url === url);
          return { title: results[index].title, content: evidence[index] };
        },
      });
      registry.register({
        name: "extract_claims",
        description: "fixture claims",
        execute: async () => claims,
      });
      registry.register({
        name: "gather_evidence",
        description: "fixture evidence",
        execute: async (input) => (input as { claims: Claim[] }).claims,
      });
      registry.register({
        name: "verify_claims_batch",
        description: "fixture verification",
        execute: async (input) =>
          (input as { claims: Array<{ id: string }> }).claims.map((claim) => ({
            id: claim.id,
            verdict: "supported",
            rationale: "The retrieved source supports this claim.",
          })),
      });
      registry.register({
        name: "detect_conflict",
        description: "fixture conflict detection",
        execute: async () => [],
      });
      registry.register({
        name: "synthesize",
        description: "real synthesis fallback",
        execute: async (input) => {
          const payload = input as {
            question: string;
            plan: ResearchPlan;
            sources: Source[];
            claims: Claim[];
            researchState: ResearchState;
            mode: "quick" | "deep";
          };
          return llm.synthesize(
            payload.question,
            payload.plan,
            payload.sources,
            payload.claims,
            payload.researchState,
            payload.mode,
          );
        },
      });

      const store = new MemorySessionStore();
      const runner = new ResearchRunner(store, { search: async () => results }, llm, registry, {
        maxSteps: 12,
        maxQueries: 4,
        maxSources: 2,
        maxPages: 2,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
        maxSearchPasses: 1,
        maxClaimsToVerify: 2,
      });
      const started = await runner.start(question, "quick");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await store.get(started.id);
        if (current?.status === "COMPLETED" || current?.status === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const completed = await store.get(started.id);

      expect(completed?.status).toBe("COMPLETED");
      expect(completed?.answer).not.toContain("Model synthesis timed out");
      expect(completed?.answer).toMatch(
        /React Native aims for 60 frames per second on the UI thread\. \[\d+\]/,
      );
      expect(completed?.answer).toMatch(
        /Flutter recommends avoiding expensive operations to maintain smooth rendering\. \[\d+\]/,
      );
      expect(
        completed?.steps.some(
          (step) => step.label.includes("synthesize") && step.status === "complete",
        ),
      ).toBe(true);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("recovers with the exact requested predicate and fails closed on generic entity evidence", async () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const queries: string[] = [];
    const fetched: Array<{ url: string; content: string }> = [];
    const initialResults: SearchResult[] = [
      {
        title: "ITC Infotech CEO Sudip Singh",
        url: "https://itc.example/leadership/sudip-singh",
        snippet: "Sudip Singh is the CEO and MD of ITC Infotech.",
      },
      {
        title: "Relyce Infotech overview",
        url: "https://in.linkedin.com/company/relyce-infotech",
        snippet: "Relyce Infotech is led by an experienced team of technology professionals.",
      },
      {
        title: "Relyce Infotech team profile",
        url: "https://company-directory.example/relyce-infotech",
        snippet: "Relyce Infotech is an Indian software and consulting company.",
      },
    ];
    const recoveryResult: SearchResult = {
      title: "Relyce Infotech leadership profile",
      url: "https://leadership-index.example/relyce-infotech",
      snippet: "Company leadership and executive profile for Relyce Infotech.",
    };
    const results = [...initialResults, recoveryResult];
    const contents = [
      "Sudip Singh is the CEO and MD of ITC Infotech.",
      "Relyce Infotech is led by a team of experienced professionals and provides application development, cloud, and IT consulting services to businesses.",
      "Relyce Infotech is an Indian software and consulting company serving business customers.",
      "Relyce Infotech is a technology consulting company with a team of executives and software engineers.",
    ];
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => false });
    const registry = createToolRegistry({ search: async () => [] }, llm);
    const runInitialSearch = async (input: unknown) => {
      const payload = input as { queries?: string[] };
      const batch = payload.queries ?? [];
      return batch.flatMap((query) => {
        queries.push(query);
        return initialResults.map((result) => ({ ...result, query }));
      });
    };
    registry.register({
      name: "web_search",
      description: "Mock initial search",
      execute: runInitialSearch,
    });
    registry.register({
      name: "search_again",
      description: "Mock recovery search",
      execute: async (input) => {
        const batch = (input as { queries?: string[] }).queries ?? [];
        return batch.flatMap((query) => {
          queries.push(query);
          return [{ ...recoveryResult, query }];
        });
      },
    });
    registry.register({
      name: "fetch_url",
      description: "Return a generic company page fixture",
      execute: async (input) => {
        const source = input as { url: string; title: string; snippet: string };
        const index = Math.max(
          0,
          results.findIndex((result) => result.url === source.url),
        );
        const content = contents[index]!;
        fetched.push({ url: source.url, content });
        return {
          url: source.url,
          html: "",
          contentType: "text/html",
          retrievalMethod: "http",
          extractionStatus: "SUCCEEDED",
          extractionConfidence: 0.9,
          retrievedContentLength: content.length,
          document: {
            title: source.title,
            domain: new URL(source.url).hostname,
            content,
            headings: [],
            contentType: "article",
          },
        };
      },
    });
    registry.register({
      name: "extract_content",
      description: "Use the fixture document unchanged",
      execute: async (input) => (input as { document: unknown }).document,
    });
    registry.register({
      name: "verify_claim",
      description: "Mark only the supplied generic claim supported by its page",
      execute: async (input) => ({
        claim: (input as { claim: string }).claim,
        verdict: "supported",
        rationale: "The page contains the company profile statement.",
      }),
    });
    registry.register({
      name: "detect_conflict",
      description: "No conflict in generic profile fixtures",
      execute: async () => [],
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      llm,
      registry,
      {
        maxSteps: 12,
        maxQueries: 2,
        maxSources: 2,
        maxPages: 2,
        maxSearchPasses: 1,
        maxClaimsToVerify: 2,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "quick", [], { researchChatOptimization: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = await store.get(started.id);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/Relyce Infotech.*CEO/i);
    expect(queries[1]).toMatch(/Relyce Infotech.*CEO/i);
    expect(queries[1]).toMatch(/company profile business directory/i);
    expect(queries.every((query) => /CEO|chief executive officer/i.test(query))).toBe(true);
    expect(fetched).toHaveLength(2);
    expect(initialResults.map((source) => source.url)).toContain(fetched[0]?.url);
    expect(fetched.map((source) => source.url)).not.toContain(initialResults[0]!.url);
    expect(fetched[1]?.url).toBe(recoveryResult.url);
    expect(fetched.map((source) => source.url)).not.toContain(initialResults[2]!.url);
    expect(completed?.status).toBe("FAILED");
    expect(completed?.error).toMatch(/^INSUFFICIENT_EVIDENCE:/);
    expect(completed?.answer).toMatch(/Insufficient evidence/i);
    expect(completed?.answer).toMatch(/CEO/i);
    expect(completed?.answer).not.toMatch(/Sudip Singh|ITC Infotech/i);
    expect(completed?.answer).not.toMatch(/IT consulting|software development company/i);
    expect(completed?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: false,
    });
    expect(completed?.searchRecoveries?.[0]?.requirements?.requestedPredicate).toEqual({
      requirement: expect.objectContaining({
        predicate: "CEO",
        entity: "Relyce Infotech",
      }),
      resolved: false,
    });
    expect(completed?.searchRecoveries?.[0]?.queries).toEqual([queries[1]]);
  });

  it("completes a precise entity lookup when verified evidence states the requested predicate", async () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const result: SearchResult = {
      title: "Relyce Infotech leadership",
      url: "https://relyceinfotech.com/en/leadership",
      snippet: "Jane Doe is the chief executive officer of Relyce Infotech.",
    };
    const content =
      "Jane Doe is the chief executive officer of Relyce Infotech, where she leads its product and engineering teams.";
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => false });
    const registry = createToolRegistry({ search: async () => [] }, llm);
    registry.register({
      name: "web_search",
      description: "Return the exact-predicate result",
      execute: async (input) => {
        const queries = (input as { queries?: string[] }).queries ?? [];
        return queries.map((query) => ({ ...result, query }));
      },
    });
    registry.register({
      name: "fetch_url",
      description: "Return the CEO source fixture",
      execute: async () => ({
        url: result.url,
        html: "",
        contentType: "text/html",
        retrievalMethod: "http",
        extractionStatus: "SUCCEEDED",
        extractionConfidence: 0.9,
        retrievedContentLength: content.length,
        document: {
          title: result.title,
          domain: new URL(result.url).hostname,
          content,
          headings: [],
          contentType: "article",
        },
      }),
    });
    registry.register({
      name: "extract_content",
      description: "Use the source document unchanged",
      execute: async (input) => (input as { document: unknown }).document,
    });
    registry.register({
      name: "verify_claim",
      description: "Verify the role claim against the exact source passage",
      execute: async (input) => ({
        claim: (input as { claim: string }).claim,
        verdict: "supported",
      }),
    });
    registry.register({
      name: "detect_conflict",
      description: "No conflicting role evidence in the fixture",
      execute: async () => [],
    });
    registry.register({
      name: "synthesize",
      description: "Return the verified requested fact with its citation",
      execute: async () => "Jane Doe is the CEO of Relyce Infotech. [1]",
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      llm,
      registry,
      {
        maxSteps: 10,
        maxQueries: 2,
        maxSources: 1,
        maxPages: 1,
        maxSearchPasses: 1,
        maxClaimsToVerify: 1,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "quick", [], { researchChatOptimization: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = await store.get(started.id);

    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.answer).toContain("Jane Doe is the CEO of Relyce Infotech.");
    expect(completed?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: true,
    });
    expect(completed?.searchRecoveries).toHaveLength(0);
  });

  it("completes precise-fact recovery only from the recovered exact-entity predicate source", async () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const initialSources: SearchResult[] = [
      {
        title: "Relyce Infotech services",
        url: "https://relyceinfotech.com/services",
        snippet: "Relyce Infotech provides web, software, and technology consulting services.",
      },
      {
        title: "Relyce Infotech company overview",
        url: "https://relyceinfotech.com/en",
        snippet: "Company profile and technology services from Relyce Infotech.",
      },
    ];
    const unrelatedCompany: SearchResult = {
      title: "ITC Infotech CEO Sudip Singh",
      url: "https://itc.example/leadership/sudip-singh",
      snippet: "Sudip Singh is the CEO and MD of ITC Infotech.",
    };
    const profileResult: SearchResult = {
      title: "Relyce Infotech company profile",
      url: "https://company-directory.example/relyce-infotech",
      snippet: "A general company profile for Relyce Infotech and its technology services.",
    };
    const recovered: SearchResult = {
      title: "Relyce Infotech | LinkedIn",
      url: "https://www.linkedin.com/company/relyce-infotech",
      snippet:
        "Company profile: Ukenthiran A is Founder & CEO of Relyce Infotech and leads its technology and consulting teams.",
    };
    const recoveredContent =
      "Core Team: Ukenthiran A is the Founder & CEO of Relyce Infotech and leads its technology and consulting teams.";
    const genericContent =
      "Relyce Infotech provides software engineering, cloud, application development, and technology consulting services to business customers.";
    const queries: string[] = [];
    const fetchedUrls: string[] = [];
    const verifiedClaims: string[] = [];
    const synthesisInputs: unknown[] = [];
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => false });
    const registry = createToolRegistry({ search: async () => [] }, llm);
    registry.register({
      name: "web_search",
      description: "Return first-party pages with generic company information",
      execute: async (input) => {
        const batch = (input as { queries?: string[] }).queries ?? [];
        return batch.flatMap((query) => {
          queries.push(query);
          return [...initialSources, unrelatedCompany].map((source) => ({ ...source, query }));
        });
      },
    });
    registry.register({
      name: "search_again",
      description: "Return source-diverse public profile and reporting candidates",
      execute: async (input) => {
        const batch = (input as { queries?: string[] }).queries ?? [];
        return batch.flatMap((query) => {
          queries.push(query);
          if (/company profile business directory/i.test(query))
            return [{ ...profileResult, query }];
          if (/professional biography staff directory/i.test(query)) return [];
          if (/news interview independent reporting/i.test(query)) return [{ ...recovered, query }];
          return [];
        });
      },
    });
    registry.register({
      name: "fetch_url",
      description: "Return generic first-party pages or the recovered profile body",
      execute: async (input) => {
        const source = input as { url: string; title: string };
        fetchedUrls.push(source.url);
        const content = source.url === recovered.url ? recoveredContent : genericContent;
        return {
          url: source.url,
          html: "",
          contentType: "text/html",
          retrievalMethod: "http",
          extractionStatus: "SUCCEEDED",
          extractionConfidence: 0.95,
          retrievedContentLength: content.length,
          document: {
            title: source.title,
            domain: new URL(source.url).hostname,
            content,
            headings: [],
            contentType: "article",
          },
        };
      },
    });
    registry.register({
      name: "extract_content",
      description: "Use the fetched source document unchanged",
      execute: async (input) => (input as { document: unknown }).document,
    });
    registry.register({
      name: "extract_claims",
      description: "Extract only the requested fact when the source states it",
      execute: async (input) => {
        const sources = (input as { sources: Source[] }).sources;
        return sources
          .filter((source) => source.content?.includes("Ukenthiran A is the Founder & CEO"))
          .map((source) => ({
            ...claim,
            id: `precise-fact-${source.id}`,
            text: "Ukenthiran A is the Founder & CEO of Relyce Infotech.",
            sourceIds: [source.id],
            evidence: recoveredContent,
          }));
      },
    });
    registry.register({
      name: "verify_claim",
      description: "Verify extracted claims against the recovered page",
      execute: async (input) => {
        const claim = (input as { claim: string }).claim;
        verifiedClaims.push(claim);
        return {
          claim,
          verdict: "supported",
          rationale: "The recovered source states the named entity and CEO predicate together.",
        };
      },
    });
    registry.register({
      name: "detect_conflict",
      description: "No conflict in the recovered exact-fact fixture",
      execute: async () => [],
    });
    registry.register({
      name: "synthesize",
      description: "Synthesize the verified recovered fact with its citation",
      execute: async (input) => {
        synthesisInputs.push(input);
        return "Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]";
      },
    });

    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      llm,
      registry,
      {
        maxSteps: 14,
        maxQueries: 4,
        maxSources: 4,
        maxPages: 3,
        maxClaimsToVerify: 2,
        maxTimeMs: 10_000,
        maxModelDecisions: 0,
      },
      undefined,
      true,
    );
    const started = await runner.start(question, "quick", [], { researchChatOptimization: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await store.get(started.id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current?.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = await store.get(started.id);

    expect(queries).toHaveLength(4);
    expect(queries[0]).toMatch(/Relyce Infotech.*CEO/i);
    expect(queries.slice(1)).toHaveLength(3);
    expect(queries.slice(1).every((query) => /Relyce Infotech/i.test(query))).toBe(true);
    expect(queries.slice(1).every((query) => /CEO|chief executive officer/i.test(query))).toBe(
      true,
    );
    expect(queries[1]).toMatch(/company profile business directory/i);
    expect(queries[2]).toMatch(/professional biography staff directory/i);
    expect(queries[3]).toMatch(/news interview independent reporting/i);
    expect(fetchedUrls).toContain(initialSources[0]!.url);
    expect(fetchedUrls).not.toContain(initialSources[1]!.url);
    expect(fetchedUrls).not.toContain(unrelatedCompany.url);
    expect(fetchedUrls).toContain(profileResult.url);
    expect(fetchedUrls.at(-1)).toBe(recovered.url);
    expect(completed?.searchRecoveries).toHaveLength(3);
    expect(completed?.searchRecoveries?.map((recovery) => recovery.queries)).toEqual(
      queries.slice(1).map((query) => [query]),
    );
    expect(completed?.status, completed?.error).toBe("COMPLETED");
    expect(completed?.error).toBeUndefined();
    expect(completed?.answer).toBe("Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]");
    expect(verifiedClaims.length).toBeGreaterThan(0);
    expect(verifiedClaims.some((claim) => /Ukenthiran A/i.test(claim))).toBe(true);
    expect(JSON.stringify(synthesisInputs)).toContain(recovered.url);
    expect(JSON.stringify(synthesisInputs)).toContain("Ukenthiran A");
    expect(JSON.stringify(synthesisInputs)).not.toContain("Sudip Singh");
    expect(completed?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: true,
    });
  });
});
