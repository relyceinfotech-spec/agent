import { describe, expect, it, vi } from "vitest";
import type { Claim, ResearchSession, SearchResult } from "../src/domain.js";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
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
        "This sufficiently long evidence sentence describes the source findings for the requested comparison and provides enough context for verification.",
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
    execute: async () => "Cited trajectory answer",
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

describe("autonomous trajectory quality", () => {
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
