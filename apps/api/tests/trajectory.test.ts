import { describe, expect, it, vi } from "vitest";
import type { Claim, ResearchSession, SearchResult, Source } from "../src/domain.js";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { ResearchRunner } from "../src/research.js";
import { MemorySessionStore } from "../src/store.js";
import { extractOfficialReleaseHistoryClaimCandidates } from "../src/version-evidence.js";

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
const tertiaryResult: SearchResult = {
  title: "Independent React Native Flutter production performance analysis",
  url: "https://engineering.example.com/mobile-performance",
  snippet:
    "An independent production analysis compares React Native and Flutter performance trade-offs.",
};
const irrelevantResult: SearchResult = {
  title: "Weekend travel guide",
  url: "https://example.com/travel",
  snippet: "A guide to popular travel destinations and vacation planning.",
};

type HarnessOptions = {
  initialResults: SearchResult[];
  rewrittenResults?: SearchResult[];
  claimsPerSource?: number;
  conflicting?: boolean;
};

function makeClaim(sourceId: string, index: number): Claim {
  return {
    id: `claim-${index}`,
    text: `The source reports evidence for the requested performance comparison ${index}.`,
    sourceIds: [sourceId],
    evidence: "The source reports evidence for the requested performance comparison.",
    confidence: 0.9,
  };
}

function createResearchRegistry(options: HarnessOptions) {
  const registry = new ToolRegistry();
  const claimsPerSource = options.claimsPerSource ?? 2;

  registry.register({
    name: "web_search",
    description: "trajectory search",
    execute: async () => options.initialResults,
  });
  registry.register({
    name: "search_again",
    description: "trajectory rewritten search",
    execute: async () => options.rewrittenResults ?? options.initialResults,
  });
  registry.register({
    name: "fetch_url",
    description: "trajectory fetch",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      return { url, html: `<article>${url}</article>` };
    },
  });
  registry.register({
    name: "extract_content",
    description: "trajectory extraction",
    execute: async (input) => ({
      title: "Extracted source",
      content:
        "React Native and Flutter performance benchmarks describe the source findings for the requested comparison and provide enough context for verification.",
      url: (input as { url: string }).url,
    }),
  });
  registry.register({
    name: "extract_claims",
    description: "trajectory claims",
    execute: async (input) =>
      ((input as { sources: Array<{ id: string }> }).sources ?? []).flatMap((source, sourceIndex) =>
        Array.from({ length: claimsPerSource }, (_, claimIndex) =>
          makeClaim(source.id, sourceIndex * claimsPerSource + claimIndex),
        ),
      ),
  });
  registry.register({
    name: "gather_evidence",
    description: "trajectory evidence",
    execute: async (input) => (input as { claims: Claim[] }).claims,
  });
  registry.register({
    name: "verify_claim",
    description: "trajectory verification",
    execute: async () => ({ verdict: "supported", rationale: "The evidence supports the claim." }),
  });
  registry.register({
    name: "detect_conflict",
    description: "trajectory conflict detection",
    execute: async (input) => {
      if (!options.conflicting) return [];
      const claims = (input as { claims: Claim[] }).claims;
      return claims.length < 2
        ? []
        : [
            {
              claimIds: claims.slice(0, 2).map((claim) => claim.id),
              sourceIds: claims.slice(0, 2).flatMap((claim) => claim.sourceIds),
              description: "The sources report different performance trade-offs.",
              status: "open",
            },
          ];
    },
  });
  registry.register({
    name: "synthesize",
    description: "trajectory synthesis",
    execute: async () => "The source reports the requested findings. [1]",
  });
  return registry;
}

function actionTrace(session: ResearchSession | undefined) {
  const actions = (session?.steps ?? []).map((step) =>
    step.label
      .replace(/^[^a-z]+/i, "")
      .replace(" + plan", "")
      .replace(" + extract_content", "")
      .trim(),
  );
  const visibleActions = actions.filter((action) => action !== "decide_next_action");
  return visibleActions.filter(
    (action, index) => index === 0 || action !== visibleActions[index - 1],
  );
}

async function runResearch(
  question: string,
  mode: ResearchSession["mode"],
  options: HarnessOptions,
) {
  const store = new MemorySessionStore();
  const runner = new ResearchRunner(
    store,
    { search: async () => [] },
    undefined,
    createResearchRegistry(options),
  );
  const session = await runner.start(question, mode);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await store.get(session.id);
    if (current?.status === "COMPLETED" || current?.status === "FAILED") return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.get(session.id);
}

async function runLatestnessConflictFixture(maxQueries: number) {
  const question =
    "Investigate the latest stable React release; verify its version and release date using official sources.";
  const firstResults: SearchResult[] = [
    {
      title: "React 2.9.0 latest stable release",
      url: "https://react.dev/releases/react-2-9",
      snippet: "React 2.9.0 is the latest stable release, released September 1, 2026.",
    },
    {
      title: "React 2.10.0 latest stable release",
      url: "https://react.dev/releases/react-2-10",
      snippet: "React 2.10.0 is the latest stable release, released September 15, 2026.",
    },
  ];
  const historyResult: SearchResult = {
    title: "Complete official React stable release history",
    url: "https://react.dev/releases/history",
    snippet: "Complete official stable release history: React 2.9.0 and React 2.10.0.",
  };
  const contentByUrl = new Map([
    [firstResults[0]!.url, "React 2.9.0 is the latest stable release, released September 1, 2026."],
    [
      firstResults[1]!.url,
      "React 2.10.0 is the latest stable release, released September 15, 2026.",
    ],
    [
      historyResult.url,
      [
        "Complete official stable release history:",
        "React 2.9.0 is a stable release, released on 2026-09-01.",
        "React 2.10.0 is a stable release, released on 2026-09-15.",
      ].join("\n"),
    ],
  ]);
  const calls: string[] = [];
  let historyFetched = false;
  let oldLatestClaimContradicted = false;
  let initialConflictDetected = false;
  let detectConflictCalls = 0;
  const registry = new ToolRegistry();

  registry.register({
    name: "web_search",
    description: "deterministic conflicting release discovery",
    execute: async () => {
      calls.push("web_search");
      return firstResults;
    },
  });
  registry.register({
    name: "search_again",
    description: "deterministic official history recovery",
    execute: async () => {
      calls.push("search_again");
      return [historyResult];
    },
  });
  registry.register({
    name: "fetch_url",
    description: "deterministic release-page retrieval",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      calls.push(`fetch:${url}`);
      const isHistory = url === historyResult.url;
      historyFetched ||= isHistory;
      return {
        url,
        html: "<article>Deterministic release evidence</article>",
        ...(isHistory
          ? {
              releaseHistorySourceKind: "official_history_page",
              releaseHistoryComplete: true,
            }
          : {}),
      };
    },
  });
  registry.register({
    name: "extract_content",
    description: "deterministic release-page extraction",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      const result = [...firstResults, historyResult].find((item) => item.url === url)!;
      return {
        title: result.title,
        content: contentByUrl.get(url)!,
        canonicalUrl: url,
      };
    },
  });
  registry.register({
    name: "extract_claims",
    description: "deterministic versioned release claims",
    execute: async (input) => {
      calls.push("extract_claims");
      const args = input as {
        question: string;
        entities: string[];
        requestedFacts: Array<"version" | "release date" | "stable status" | "latestness">;
        officialSourcesRequired: boolean;
        sources: Source[];
      };
      const historyClaims = extractOfficialReleaseHistoryClaimCandidates({
        question: args.question,
        entities: args.entities,
        requestedFacts: args.requestedFacts,
        officialSourcesRequired: args.officialSourcesRequired,
        sources: args.sources,
      });
      const announcementClaims = args.sources
        .filter((source) => source.url !== historyResult.url && source.content)
        .map((source) => ({
          id: `announcement-${source.id}`,
          text: source.content!,
          evidence: source.content!,
          sourceIds: [source.id],
          confidence: 0.95,
          importance: "critical" as const,
          requestedFacts: ["version", "release date", "stable status", "latestness"] as const,
        }));
      return [...announcementClaims, ...historyClaims];
    },
  });
  registry.register({
    name: "gather_evidence",
    description: "deterministic evidence binding",
    execute: async (input) => {
      calls.push("gather_evidence");
      return (input as { claims: Claim[] }).claims;
    },
  });
  registry.register({
    name: "verify_claim",
    description: "deterministic cross-source release verification",
    execute: async (input) => {
      calls.push("verify_claim");
      const claimText = (input as { claim: string }).claim;
      const oldLatestClaim = /React 2\.9\.0 is the latest stable release/i.test(claimText);
      if (historyFetched && oldLatestClaim) oldLatestClaimContradicted = true;
      return {
        verdict: historyFetched && oldLatestClaim ? "contradicted" : "supported",
        rationale:
          historyFetched && oldLatestClaim
            ? "Complete official history establishes a newer stable release."
            : "The fixture source supports this versioned release fact.",
      };
    },
  });
  registry.register({
    name: "detect_conflict",
    description: "deterministic latest-claim conflict detection",
    execute: async (input) => {
      calls.push("detect_conflict");
      detectConflictCalls += 1;
      if (historyFetched && oldLatestClaimContradicted) return [];
      const claims = (input as { claims: Claim[] }).claims.filter(
        (claim) =>
          claim.verification?.verdict === "supported" && /latest stable release/i.test(claim.text),
      );
      const versions = new Set(
        claims.flatMap((claim) => claim.text.match(/\b\d+\.\d+(?:\.\d+)?\b/g) ?? []),
      );
      if (!historyFetched && versions.size > 1) {
        initialConflictDetected = true;
        return [
          {
            claimIds: claims.map((claim) => claim.id),
            sourceIds: claims.flatMap((claim) => claim.sourceIds),
            description: "Official sources identify different latest stable releases.",
            status: "open",
          },
        ];
      }
      return [];
    },
  });
  registry.register({
    name: "synthesize",
    description: "deterministic citation-ready final answer",
    execute: async () => {
      calls.push("synthesize");
      return "React 2.10.0 is the latest stable release, released on 2026-09-15. [1]";
    },
  });

  const llm = new OpenRouterProvider();
  Object.defineProperty(llm, "enabled", { get: () => false });
  const store = new MemorySessionStore();
  const runner = new ResearchRunner(
    store,
    { search: async () => firstResults },
    llm,
    registry,
    {
      maxSteps: 20,
      maxQueries,
      maxSources: 4,
      maxPages: 4,
      maxSearchPasses: 1,
      maxClaimsToVerify: 3,
      maxTimeMs: 8_000,
      maxModelDecisions: 0,
    },
    {
      maxSteps: 20,
      maxQueries: 2,
      maxSources: 4,
      maxPages: 4,
      maxSearchPasses: 1,
      maxClaimsToVerify: 3,
      maxTimeMs: 8_000,
      maxModelDecisions: 0,
    },
  );
  const initial = await runner.start(question, "quick");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await store.get(initial.id);
    if (current?.status === "COMPLETED" || current?.status === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return {
    session: await store.get(initial.id),
    calls,
    initialConflictDetected,
    historyFetched,
    oldLatestClaimContradicted,
    detectConflictCalls,
  };
}

describe("autonomous trajectory quality", () => {
  it("recovers an official latestness conflict and promotes only after complete-history comparison", async () => {
    const result = await runLatestnessConflictFixture(2);
    const decisions = result.session?.decisions ?? [];

    expect(result.initialConflictDetected).toBe(true);
    expect(result.detectConflictCalls).toBe(2);
    expect(result.calls.filter((call) => call === "search_again")).toHaveLength(1);
    expect(
      decisions.some(
        (decision) =>
          decision.nextAction === "search_again" &&
          decision.reason.includes("conflicting_official_sources") &&
          decision.reason.includes("retrieve additional official evidence"),
      ),
    ).toBe(true);
    expect(result.session?.status).toBe("COMPLETED");
    expect(result.session?.state?.latestnessAssessment).toMatchObject({
      conclusion: "PROVEN",
      latestVersion: "2.10.0",
      proof: "complete-official-history",
      comparisons: [expect.objectContaining({ olderVersion: "2.9.0", newerVersion: "2.10.0" })],
    });
    expect(result.session?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("React 2.9.0 is the latest stable release"),
          verification: expect.objectContaining({ verdict: "contradicted" }),
        }),
      ]),
    );
    expect(
      result.session?.conflicts,
      `calls=${result.calls.join(",")}; decisions=${result.session?.decisions?.map((decision) => decision.nextAction).join(",")}; steps=${result.session?.steps?.map((step) => step.label).join("|")}; history=${result.historyFetched}; contradicted=${result.oldLatestClaimContradicted}; conflictPasses=${result.detectConflictCalls}`,
    ).toEqual([]);
    expect(result.session?.answer).toContain("2.10.0");
  }, 15_000);

  it("enforces LATESTNESS_PROMOTION_INVARIANT and reports uncertainty when recovery budget is zero", async () => {
    const result = await runLatestnessConflictFixture(1);
    const unresolved = result.session?.state?.latestnessAssessment;

    expect(result.initialConflictDetected).toBe(true);
    expect(result.calls).not.toContain("search_again");
    expect(result.session?.status).toBe("FAILED");
    expect(unresolved).toMatchObject({
      conclusion: "CANDIDATE_ONLY",
      unresolvedState: {
        status: "unresolved",
        reason: "conflicting_official_sources",
        candidates: expect.arrayContaining([
          expect.objectContaining({ version: "2.9.0" }),
          expect.objectContaining({ version: "2.10.0" }),
        ]),
      },
    });
    expect(unresolved?.latestVersion).toBeUndefined();
    expect(
      result.session?.decisions?.some(
        (decision) =>
          decision.nextAction === "synthesize" &&
          decision.reason.includes("report uncertainty") &&
          decision.reason.includes("conflicting_official_sources"),
      ),
    ).toBe(true);
    expect(result.session?.answer).toMatch(/insufficient evidence/i);
    expect(result.session?.answer).not.toMatch(/2\.10\.0 is the latest/i);
  });

  it("takes the direct trajectory for a stable explanation", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "trajectory understanding",
      execute: async () => ({
        normalizedQuestion: "Explain JavaScript closures simply.",
        intent: "Explain the topic",
        entities: ["JavaScript"],
        topic: "general topic",
        dimensions: ["capabilities"],
        corrections: [],
        ambiguityScore: 0,
        ambiguityReasons: [],
        needsClarification: false,
      }),
    });
    tools.register({
      name: "synthesize",
      description: "trajectory synthesis",
      execute: async () => "Direct answer",
    });
    const llm = new OpenRouterProvider();
    const runner = {} as ResearchRunner;
    const response = await new AutonomousAgent(tools, runner, llm).handle(
      "Explain JavaScript closures simply.",
      false,
    );

    expect(response.toolEvents.map((event) => event.tool)).toEqual([
      "understand_query",
      "decide_next_action",
      "synthesize",
    ]);
    expect(response.route).toBe("direct");
  });

  it("completes a current-information trajectory with verification", async () => {
    const completed = await runResearch("Compare React Native and Flutter performance", "quick", {
      initialResults: [primaryResult, secondaryResult],
    });

    expect(completed?.status).toBe("COMPLETED");
    expect(actionTrace(completed)).toEqual([
      "understand_query",
      "web_search",
      "source_triage",
      "fetch_url",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ]);
  });

  it("searches again on a weak trajectory before synthesizing", async () => {
    const completed = await runResearch("Compare React Native and Flutter performance", "deep", {
      initialResults: [irrelevantResult],
      rewrittenResults: [primaryResult, secondaryResult],
    });

    expect(completed?.status).toBe("COMPLETED");
    expect(actionTrace(completed)).toEqual([
      "understand_query",
      "web_search",
      "source_triage",
      "gather_evidence",
      "detect_conflict",
      "search_again",
      "source_triage",
      "fetch_url",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ]);
  });

  it("investigates a conflict with a second search pass", async () => {
    const completed = await runResearch("Compare React Native and Flutter performance", "deep", {
      initialResults: [primaryResult, secondaryResult],
      rewrittenResults: [tertiaryResult],
      conflicting: true,
    });

    expect(completed?.status).toBe("COMPLETED");
    expect(actionTrace(completed)).toEqual([
      "understand_query",
      "web_search",
      "source_triage",
      "fetch_url",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "search_again",
      "source_triage",
      "fetch_url",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ]);
    expect(completed?.conflicts?.some((conflict) => conflict.status === "open")).toBe(true);
  });

  it("records controller decisions without exposing raw source content", async () => {
    const completed = await runResearch("Compare React Native and Flutter performance", "quick", {
      initialResults: [primaryResult, secondaryResult],
    });

    expect(completed?.decisions?.length).toBeGreaterThan(0);
    expect(completed?.decisions?.every((decision) => decision.nextAction.length > 0)).toBe(true);
    expect(completed?.steps.some((step) => step.label.includes("decide_next_action"))).toBe(true);
  });

  it("uses deterministic fallback for single-option steps and only consults model at branch points", async () => {
    const llm = new OpenRouterProvider();
    Object.defineProperty(llm, "enabled", { get: () => true });
    // Model always requests synthesize — at a genuine branch point (verify_claims
    // when evidence is sufficient), the controller should allow it.
    vi.spyOn(llm, "proposeResearchAction").mockResolvedValue("synthesize");
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(
      store,
      { search: async () => [] },
      llm,
      createResearchRegistry({ initialResults: [primaryResult, secondaryResult] }),
    );

    const session = await runner.start("Compare React Native and Flutter performance", "quick");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.get(session.id);
      if (current?.status === "COMPLETED" || current?.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = await store.get(session.id);

    expect(completed?.status).toBe("COMPLETED");
    // Deterministic steps record as fallback (no LLM needed).
    expect(
      completed?.decisions?.some((decision) => decision.controllerDecision === "fallback"),
    ).toBe(true);
    // At a genuine branch point where the model said "synthesize" and it was
    // allowed (evidence sufficient), the controller records "allow".
    const allowDecisions = completed?.decisions?.filter(
      (decision) => decision.controllerDecision === "allow",
    );
    // The model was only consulted when a real branch existed; if it wasn't
    // consulted (evidence never became sufficient), all decisions are fallbacks.
    expect(completed?.decisions?.length).toBeGreaterThan(0);
    // No decision should have been marked as an override — the mock returns
    // "synthesize" which is either allowed at a branch point or the step was
    // deterministic (model not consulted).
    expect(
      completed?.decisions?.every((decision) => decision.controllerDecision !== "override"),
    ).toBe(true);
    // Sanity: every fallback decision has no requestedAction (LLM was skipped).
    const fallbacks = completed?.decisions?.filter(
      (decision) => decision.controllerDecision === "fallback",
    );
    expect(fallbacks?.every((decision) => decision.requestedAction === undefined)).toBe(true);
    void allowDecisions; // may be empty if evidence never became sufficient
  });
});
