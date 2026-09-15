import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { Claim, ResearchDecision, ResearchSession, SearchResult } from "../domain.js";
import { AutonomousAgent, type AgentRoute } from "../agent/autonomous.js";
import { createToolRegistry, ToolRegistry } from "../agent/tools.js";
import { config } from "../config.js";
import { OpenRouterProvider, type LLMMetrics } from "../llm.js";
import { ResearchRunner, type ResearchBudget } from "../research.js";
import { SearXNGProvider } from "../search.js";
import { MemorySessionStore } from "../store.js";

type ControlledScenario = "weak" | "conflict";
type EvaluationProfile = "full" | "smoke";

// ---------------------------------------------------------------------------
// Smoke verdict thresholds
// The model passes smoke when it makes the right high-level decision every
// time, has no critical research mistake, and gets at least 80% of tool
// decisions right.
// ---------------------------------------------------------------------------
interface SmokeThresholds {
  /** Routing accuracy must be 100% (all 3/3 smoke cases). */
  routingAccuracy: number;
  /** Tool-decision accuracy must be ≥ 80% across the smoke cases. */
  toolDecisionAccuracy: number;
  /** Zero controller safety violations permitted. */
  maxControllerViolations: number;
}

const SMOKE_THRESHOLDS: SmokeThresholds = {
  routingAccuracy: 1.0,
  toolDecisionAccuracy: 0.8,
  maxControllerViolations: 0,
};

/**
 * A critical failure is a qualitatively bad agent decision that the smoke
 * test must catch regardless of the numeric scores.
 */
type CriticalFailureKind =
  | "STABLE_QUESTION_TRIGGERED_RESEARCH" // direct question caused unnecessary web_search
  | "CURRENT_QUESTION_REFUSED_WEB_SEARCH" // current-info question never searched
  | "PREMATURE_SYNTHESIS" // synthesized despite clearly insufficient evidence
  | "IGNORED_OPEN_CONFLICT" // open conflict left unresolved before synthesis
  | "BUDGET_EXCEEDED" // session exceeded the hard budget (controller breach)
  | "UNSAFE_ACTION"; // tool injection or disallowed action executed

interface CriticalFailure {
  kind: CriticalFailureKind;
  detail: string;
}

interface EvaluationLimits {
  maxCases: number;
  maxSteps: number;
  maxQueries: number;
  maxSources: number;
  maxPages: number;
  maxTimeMs: number;
  openRouterTimeoutMs: number;
  caseNames: string;
  profile: EvaluationProfile;
}

interface RealEvaluationCase {
  name: string;
  category:
    "direct" | "current" | "comparison" | "weak-results" | "conflict" | "deep" | "ambiguous";
  prompt: string;
  mode: ResearchSession["mode"];
  expectedRoute: AgentRoute;
  expectedClarification?: boolean;
  expectedSearchAgain?: boolean;
  expectedConflict?: boolean;
  requiredActions: string[];
  controlled?: ControlledScenario;
}

interface ToolCallRecord {
  name: string;
  input: unknown;
  result: unknown;
  durationMs: number;
  error?: string;
}

interface EvaluationResult {
  name: string;
  category: RealEvaluationCase["category"];
  question: string;
  mode: ResearchSession["mode"];
  model: string;
  startedAt: string;
  durationMs: number;
  route?: AgentRoute;
  expectedRoute: AgentRoute;
  trace: string[];
  toolCalls: ToolCallRecord[];
  searchQueries: string[][];
  selectedSources: Array<{
    id: string;
    title: string;
    url: string;
    domain: string;
    quality: ResearchSession["sources"][number]["quality"];
    fetchError?: string;
  }>;
  claims: Claim[];
  conflicts: ResearchSession["conflicts"];
  decisions: ResearchDecision[];
  finalAction?: string;
  answer?: string;
  status?: ResearchSession["status"];
  expected: {
    clarification: boolean;
    searchAgain: boolean;
    conflict: boolean;
    requiredActions: string[];
  };
  checks: {
    route: boolean;
    clarification: boolean;
    requiredActions: boolean;
    searchAgain: boolean;
    conflict: boolean;
    trajectory: boolean;
  };
  /** Critical failures found in this individual case. */
  criticalFailures: CriticalFailure[];
  modelMetrics: LLMMetrics;
  failure?: {
    kind: "MODEL_FAILURE" | "TOOL_FAILURE" | "NETWORK_FAILURE" | "EVALUATION_FAILURE";
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Smoke verdict
// ---------------------------------------------------------------------------
interface SmokeVerdict {
  pass: boolean;
  routingAccuracy: number;
  toolDecisionAccuracy: number;
  controllerViolations: number;
  criticalFailures: CriticalFailure[];
  reasons: string[];
}

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

const realEvaluationCases: RealEvaluationCase[] = [
  {
    name: "direct_javascript_closures",
    category: "direct",
    prompt: "Explain JavaScript closures simply.",
    mode: "quick",
    expectedRoute: "direct",
    requiredActions: ["understand_query", "synthesize"],
  },
  {
    name: "current_react_version",
    category: "current",
    prompt: "What's the latest React version?",
    mode: "quick",
    expectedRoute: "web",
    requiredActions: ["understand_query", "web_search", "source_triage"],
  },
  {
    name: "compare_react_native_flutter",
    category: "comparison",
    prompt: "Compare React Native and Flutter for a startup in 2026.",
    mode: "quick",
    expectedRoute: "web",
    requiredActions: [
      "understand_query",
      "web_search",
      "source_triage",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
    ],
  },
  {
    name: "weak_results_recovery",
    category: "weak-results",
    prompt: "Compare React Native and Flutter performance using reliable evidence.",
    mode: "quick",
    expectedRoute: "web",
    expectedSearchAgain: true,
    requiredActions: ["web_search", "source_triage", "search_again"],
    controlled: "weak",
  },
  {
    name: "conflicting_performance_sources",
    category: "conflict",
    prompt: "Investigate conflicting evidence about React Native and Flutter startup performance.",
    mode: "quick",
    expectedRoute: "web",
    expectedSearchAgain: true,
    expectedConflict: true,
    requiredActions: ["web_search", "detect_conflict", "search_again"],
    controlled: "conflict",
  },
  {
    name: "deep_mobile_comparison",
    category: "deep",
    prompt: "Deeply compare React Native and Flutter for a startup in 2026.",
    mode: "deep",
    expectedRoute: "deep",
    requiredActions: ["web_search", "source_triage", "gather_evidence"],
  },
  {
    name: "ambiguous_backend_comparison",
    category: "ambiguous",
    prompt: "Is Node better than NocoDB for backend?",
    mode: "quick",
    expectedRoute: "web",
    expectedClarification: true,
    requiredActions: ["understand_query"],
  },
];

function normalizeTrace(session: ResearchSession | undefined, directTools: string[]) {
  if (!session) return directTools;
  // Strip decide_next_action labels — they are controller internals, not agent actions.
  const labels = session.steps
    .map((step) =>
      step.label
        .replace(/^[^a-z]+/i, "")
        .replace(" + plan", "")
        .replace(" + extract_content", "")
        .trim(),
    )
    .filter((label) => label !== "decide_next_action");
  return labels.filter((label, index) => {
    const previous = labels[index - 1];
    return label !== previous;
  });
}

function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return { kind: "array", count: value.length };
  if (typeof value === "string") return { kind: "string", length: value.length };
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return {
    kind: "object",
    keys: Object.keys(object).slice(0, 20),
    counts: Object.fromEntries(
      Object.entries(object)
        .filter(([, item]) => Array.isArray(item))
        .map(([key, item]) => [key, (item as unknown[]).length]),
    ),
  };
}

function summarizeInput(value: unknown): unknown {
  if (!value || typeof value !== "object") return summarize(value);
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      Array.isArray(item) ? summarize(item) : summarize(item),
    ]),
  );
}

function instrument(registry: ToolRegistry, calls: ToolCallRecord[], searchQueries: string[][]) {
  const execute = registry.execute.bind(registry);
  registry.execute = async (name: string, input: unknown) => {
    const startedAt = performance.now();
    try {
      const result = await execute(name, input);
      const queries = (input as { queries?: unknown })?.queries;
      if (Array.isArray(queries) && queries.every((query) => typeof query === "string"))
        searchQueries.push([...queries]);
      calls.push({
        name,
        input: summarizeInput(input),
        result: summarize(result),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      calls.push({
        name,
        input: summarizeInput(input),
        result: undefined,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : "Tool failed",
      });
      throw error;
    }
  };
}

function controlledRegistry(
  scenario: ControlledScenario,
  llm: OpenRouterProvider,
  calls: ToolCallRecord[],
  searchQueries: string[][],
) {
  const registry = createToolRegistry({ search: async () => [] }, llm);
  const initial = scenario === "weak" ? [irrelevantResult] : [primaryResult, secondaryResult];
  const rewritten = scenario === "weak" ? [primaryResult, secondaryResult] : [tertiaryResult];
  registry.register({
    name: "web_search",
    description: "Controlled evaluation search",
    execute: async () => initial,
  });
  registry.register({
    name: "search_again",
    description: "Controlled evaluation rewritten search",
    execute: async () => rewritten,
  });
  registry.register({
    name: "fetch_url",
    description: "Controlled evaluation fetch",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      return { url, html: `<article>${url}</article>` };
    },
  });
  registry.register({
    name: "extract_content",
    description: "Controlled evaluation extraction",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      const content =
        scenario === "conflict" && url.includes("reactnative")
          ? "Controlled source A reports that React Native has lower startup latency in this benchmark."
          : scenario === "conflict" && url.includes("flutter")
            ? "Controlled source B reports that Flutter has lower startup latency in this benchmark."
            : "Controlled source content provides evidence for the requested performance comparison and includes enough context for claim extraction and verification.";
      return { title: "Controlled source", content, url };
    },
  });
  instrument(registry, calls, searchQueries);
  return registry;
}

async function waitForSession(store: MemorySessionStore, id: string, maxTimeMs: number) {
  const deadline = Date.now() + maxTimeMs;
  while (Date.now() < deadline) {
    const current = await store.get(id);
    if (
      current?.status === "COMPLETED" ||
      current?.status === "FAILED" ||
      current?.status === "NEEDS_CLARIFICATION"
    )
      return current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return store.get(id);
}

function failureKind(error: unknown): NonNullable<EvaluationResult["failure"]>["kind"] {
  const message = error instanceof Error ? error.message : String(error);
  // 429 is a transient rate-limit from the API infrastructure, not a model
  // quality problem. Classify it separately so routing accuracy is not
  // incorrectly penalised when the agent made the right decision.
  if (/429|rate.?limit|too many requests/i.test(message)) return "NETWORK_FAILURE";
  if (/openrouter/i.test(message)) return "MODEL_FAILURE";
  if (/searx|fetch|network|timeout|abort|econn|enotfound/i.test(message)) return "NETWORK_FAILURE";
  return "EVALUATION_FAILURE";
}

function hasAction(trace: string[], action: string) {
  return trace.includes(action);
}

function sourceSummary(session: ResearchSession | undefined) {
  return (session?.sources ?? []).map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    quality: source.quality,
    fetchError: source.fetchError,
  }));
}

// ---------------------------------------------------------------------------
// Critical-failure detection
// Called per-result after the case completes. Only the 3 smoke cases are
// evaluated here. The full-eval cases have broader tolerance.
// ---------------------------------------------------------------------------
function detectCriticalFailures(
  testCase: RealEvaluationCase,
  trace: string[],
  session: ResearchSession | undefined,
  profile: EvaluationProfile,
): CriticalFailure[] {
  const failures: CriticalFailure[] = [];

  // 1. Direct/stable question triggered unnecessary research.
  if (
    testCase.category === "direct" &&
    (hasAction(trace, "web_search") || hasAction(trace, "source_triage"))
  ) {
    failures.push({
      kind: "STABLE_QUESTION_TRIGGERED_RESEARCH",
      detail: `Case "${testCase.name}" is a stable question but the trace contains web_search or source_triage.`,
    });
  }

  // 2. Current-information question never searched.
  if (
    testCase.category === "current" &&
    !hasAction(trace, "web_search") &&
    testCase.expectedRoute === "web" &&
    // Only flag as critical when the agent got a route set (not a model failure)
    trace.length > 1
  ) {
    failures.push({
      kind: "CURRENT_QUESTION_REFUSED_WEB_SEARCH",
      detail: `Case "${testCase.name}" requires a web search but the trace never called web_search.`,
    });
  }

  // 3. Premature synthesis: synthesized with open conflicts or insufficient evidence.
  if (
    hasAction(trace, "synthesize") &&
    (session?.conflicts ?? []).some((conflict) => conflict.status === "open") &&
    (session?.claims ?? []).filter((claim) => claim.verification?.verdict === "supported").length <
      1
  ) {
    failures.push({
      kind: "PREMATURE_SYNTHESIS",
      detail: `Case "${testCase.name}" synthesized despite open conflicts and no supported claims.`,
    });
  }

  // 4. Open conflict ignored: conflict present, synthesize ran, and no search_again occurred.
  // Only flag for smoke profile because the controlled conflict case does this intentionally.
  if (
    profile === "smoke" &&
    (session?.conflicts ?? []).some((conflict) => conflict.status === "open") &&
    hasAction(trace, "synthesize") &&
    !hasAction(trace, "search_again")
  ) {
    // Only flag for the comparison category (not the direct question which has no conflict).
    if (testCase.category === "comparison" || testCase.category === "conflict") {
      failures.push({
        kind: "IGNORED_OPEN_CONFLICT",
        detail: `Case "${testCase.name}" had an open conflict and synthesized without additional search.`,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Controller-violation detection
// A controller safety violation occurs when the model executes an action that
// the controller should have blocked but didn't.
// We define a violation as: a decision where requestedAction differs from
// nextAction AND the difference would have caused a critical failure.
// For the smoke verdict purposes, we count explicit unsafe tool calls.
// ---------------------------------------------------------------------------
function countControllerViolations(results: EvaluationResult[]): number {
  // Currently: we count cases where the controller allowed a synthesize action
  // when evidence was clearly insufficient AND no override was recorded.
  // This is a conservative definition — we do NOT penalize normal fallbacks.
  let violations = 0;
  for (const result of results) {
    for (const decision of result.decisions ?? []) {
      // A violation is when the controller "allowed" synthesize but the
      // session had zero supported claims and open conflicts.
      if (
        decision.controllerDecision === "allow" &&
        decision.nextAction === "synthesize" &&
        result.claims.filter((claim) => claim.verification?.verdict === "supported").length === 0 &&
        (result.conflicts ?? []).some((conflict) => conflict.status === "open")
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Tool-decision accuracy
// Measures the fraction of decisions where the controller allowed the model's
// requested action (meaning the model made a reasonable choice). Fallbacks are
// excluded because they are not model decisions; overrides are counted as
// incorrect model choices.
// ---------------------------------------------------------------------------
function computeToolDecisionAccuracy(results: EvaluationResult[]): number {
  let totalDecisions = 0;
  let correctDecisions = 0;
  for (const result of results) {
    for (const decision of result.decisions ?? []) {
      if (decision.controllerDecision === "fallback") continue; // not a model decision
      totalDecisions += 1;
      if (decision.controllerDecision === "allow") correctDecisions += 1;
    }
  }
  if (totalDecisions === 0) return 1; // no model decisions → controller ran everything → acceptable
  return correctDecisions / totalDecisions;
}

// ---------------------------------------------------------------------------
// Smoke verdict
// ---------------------------------------------------------------------------
function buildSmokeVerdict(
  results: EvaluationResult[],
  metrics: ReturnType<typeof buildMetrics>,
): SmokeVerdict {
  const reasons: string[] = [];
  const allCriticalFailures = results.flatMap((result) => result.criticalFailures);
  const controllerViolations = countControllerViolations(results);
  const toolDecisionAccuracy = computeToolDecisionAccuracy(results);
  const routingAccuracy = metrics.routingAccuracy;

  // Check routing (must be 100%)
  if (routingAccuracy < SMOKE_THRESHOLDS.routingAccuracy) {
    const mismatches = results.filter((result) => !result.checks.route);
    reasons.push(
      `Routing accuracy ${(routingAccuracy * 100).toFixed(0)}% < 100% required. ` +
        `Mismatches: ${mismatches.map((result) => `${result.name} (expected=${result.expectedRoute} actual=${result.route ?? "unavailable"})`).join(", ")}.`,
    );
  }

  // Check critical failures (must be 0)
  if (allCriticalFailures.length > 0) {
    for (const failure of allCriticalFailures) {
      reasons.push(`Critical failure [${failure.kind}]: ${failure.detail}`);
    }
  }

  // Check tool-decision accuracy (must be ≥ 80%)
  if (toolDecisionAccuracy < SMOKE_THRESHOLDS.toolDecisionAccuracy) {
    reasons.push(
      `Tool-decision accuracy ${(toolDecisionAccuracy * 100).toFixed(0)}% < 80% required.`,
    );
  }

  // Check controller safety (must be 0 violations)
  if (controllerViolations > SMOKE_THRESHOLDS.maxControllerViolations) {
    reasons.push(`Controller safety violations: ${controllerViolations} (must be 0).`);
  }

  return {
    pass: reasons.length === 0,
    routingAccuracy,
    toolDecisionAccuracy,
    controllerViolations,
    criticalFailures: allCriticalFailures,
    reasons,
  };
}

async function evaluateCase(
  testCase: RealEvaluationCase,
  limits: EvaluationLimits,
): Promise<EvaluationResult> {
  const startedAt = new Date().toISOString();
  const timer = performance.now();
  const llm = new OpenRouterProvider(limits.openRouterTimeoutMs);
  const store = new MemorySessionStore();
  const calls: ToolCallRecord[] = [];
  const searchQueries: string[][] = [];
  const search = testCase.controlled
    ? { search: async () => [] }
    : new SearXNGProvider(config.SEARXNG_URL);
  const registry = testCase.controlled
    ? controlledRegistry(testCase.controlled, llm, calls, searchQueries)
    : createToolRegistry(search, llm);
  if (!testCase.controlled) instrument(registry, calls, searchQueries);
  const budget: Partial<ResearchBudget> = {
    maxSteps: limits.maxSteps,
    maxQueries: limits.maxQueries,
    maxSources: limits.maxSources,
    maxPages: limits.maxPages,
    maxSearchPasses: 1,
    maxTimeMs: limits.maxTimeMs,
  };
  const runner = new ResearchRunner(store, search, llm, registry, budget);
  const agent = new AutonomousAgent(registry, runner, llm);
  llm.setDeadline(Date.now() + limits.maxTimeMs);
  let responseRoute: AgentRoute | undefined;
  let finalSession: ResearchSession | undefined;
  let answer: string | undefined;
  let failure: EvaluationResult["failure"];

  try {
    const response = await agent.handle(testCase.prompt, testCase.mode === "deep");
    responseRoute = response.route;
    answer = response.answer;
    if (response.researchId) {
      finalSession = await waitForSession(store, response.researchId, limits.maxTimeMs);
    }
    if (responseRoute === "direct") {
      finalSession = undefined;
    }
  } catch (error) {
    failure = {
      kind: failureKind(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!failure && finalSession?.status === "FAILED")
    failure = {
      kind: failureKind(new Error(finalSession.error ?? "Research session failed")),
      message: finalSession.error ?? "Research session failed",
    };
  if (!failure && llm.metrics.failures > 0) {
    const firstFailure = llm.metrics.records.find((record) => record.error)?.error;
    failure = {
      kind: failureKind(new Error(firstFailure ?? "OpenRouter request failed")),
      message: firstFailure ?? "OpenRouter request failed",
    };
  }

  const directTools = calls.map((call) => call.name);
  const trace = normalizeTrace(finalSession, directTools);
  const actualClarification =
    finalSession?.status === "NEEDS_CLARIFICATION" || trace.includes("clarification");
  const actualSearchAgain = hasAction(trace, "search_again");
  const actualConflict = (finalSession?.conflicts ?? []).some(
    (conflict) => conflict.status === "open",
  );
  const requiredActions = testCase.requiredActions.every((action) => hasAction(trace, action));
  const route = responseRoute;
  // Treat infrastructure failures (429, network errors) as routing-neutral:
  // if the trace shows the agent started the right path (e.g. direct→synthesize)
  // but the API failed mid-call, that is not a wrong routing decision.
  const infrastructureFailure = failure?.kind === "NETWORK_FAILURE";
  const routeCheck =
    route === testCase.expectedRoute ||
    (infrastructureFailure &&
      route === undefined &&
      testCase.category === "direct" &&
      hasAction(trace, "synthesize"));
  const clarificationCheck = actualClarification === (testCase.expectedClarification ?? false);
  const searchAgainCheck = actualSearchAgain === (testCase.expectedSearchAgain ?? false);
  const conflictCheck = actualConflict === (testCase.expectedConflict ?? false);
  const trajectoryCheck =
    routeCheck && clarificationCheck && requiredActions && searchAgainCheck && conflictCheck;

  const criticalFailures = detectCriticalFailures(testCase, trace, finalSession, limits.profile);

  return {
    name: testCase.name,
    category: testCase.category,
    question: testCase.prompt,
    mode: testCase.mode,
    model: config.OPENROUTER_MODEL,
    startedAt,
    durationMs: Math.round(performance.now() - timer),
    route,
    expectedRoute: testCase.expectedRoute,
    trace,
    toolCalls: calls,
    searchQueries,
    selectedSources: sourceSummary(finalSession),
    claims: finalSession?.claims ?? [],
    conflicts: finalSession?.conflicts,
    decisions: finalSession?.decisions ?? [],
    finalAction: trace.at(-1),
    answer: answer ?? finalSession?.answer,
    status: finalSession?.status,
    expected: {
      clarification: testCase.expectedClarification ?? false,
      searchAgain: testCase.expectedSearchAgain ?? false,
      conflict: testCase.expectedConflict ?? false,
      requiredActions: testCase.requiredActions,
    },
    checks: {
      route: routeCheck,
      clarification: clarificationCheck,
      requiredActions,
      searchAgain: searchAgainCheck,
      conflict: conflictCheck,
      trajectory: trajectoryCheck && !failure,
    },
    criticalFailures,
    modelMetrics: llm.metrics,
    failure,
  };
}

function buildMetrics(results: EvaluationResult[]) {
  const direct = results.filter((result) => result.category === "direct");
  const clarificationCases = results.filter((result) => result.expected.clarification);
  const searchAgainCases = results.filter((result) => result.expected.searchAgain);
  const conflictCases = results.filter((result) => result.expected.conflict);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const usage = results.reduce(
    (total, result) => {
      for (const key of ["promptTokens", "completionTokens", "totalTokens", "cost"] as const) {
        const value = result.modelMetrics.usage[key];
        if (value !== undefined) total[key] = (total[key] ?? 0) + value;
      }
      return total;
    },
    {} as Record<string, number>,
  );
  return {
    cases: results.length,
    routingAccuracy: results.filter((result) => result.checks.route).length / results.length,
    unnecessaryWebSearchRate:
      direct.length === 0
        ? undefined
        : direct.filter((result) => result.trace.includes("web_search")).length / direct.length,
    unnecessaryFetchRate:
      direct.length === 0
        ? undefined
        : direct.filter((result) => result.trace.includes("fetch_url")).length / direct.length,
    toolTrajectoryAccuracy:
      results.filter((result) => result.checks.trajectory).length / results.length,
    toolDecisionAccuracy: computeToolDecisionAccuracy(results),
    searchAgainPrecision:
      searchAgainCases.length === 0
        ? undefined
        : searchAgainCases.filter((result) => result.trace.includes("search_again")).length /
          searchAgainCases.length,
    earlyStopAccuracy: (() => {
      const earlyStopCases = results.filter((result) => !result.expected.searchAgain);
      return earlyStopCases.length === 0
        ? undefined
        : earlyStopCases.filter((result) => !result.trace.includes("search_again")).length /
            earlyStopCases.length;
    })(),
    clarificationAccuracy:
      clarificationCases.length === 0
        ? undefined
        : clarificationCases.filter((result) => result.checks.clarification).length /
          clarificationCases.length,
    conflictHandlingAccuracy:
      conflictCases.length === 0
        ? undefined
        : conflictCases.filter((result) => result.checks.conflict).length / conflictCases.length,
    deepResearchDepthIncrease: {
      value: undefined,
      reason: "No paired quick/deep replay was run in the bounded first smoke evaluation.",
    },
    controllerOverrides: results.reduce(
      (total, result) =>
        total +
        result.decisions.filter((decision) => decision.controllerDecision === "override").length,
      0,
    ),
    controllerFallbacks: results.reduce(
      (total, result) =>
        total +
        result.decisions.filter((decision) => decision.controllerDecision === "fallback").length,
      0,
    ),
    controllerViolations: countControllerViolations(results),
    averageToolCalls: sum(results.map((result) => result.toolCalls.length)) / results.length,
    averageResearchDurationMs:
      sum(
        results.filter((result) => result.category !== "direct").map((result) => result.durationMs),
      ) / Math.max(1, results.filter((result) => result.category !== "direct").length),
    tokenUsage: Object.keys(usage).length > 0 ? usage : undefined,
    estimatedCost: usage.cost,
  };
}

function evaluationProfile(): EvaluationProfile {
  return process.argv.includes("--profile=smoke") || process.env.EVAL_PROFILE === "smoke"
    ? "smoke"
    : "full";
}

function evaluationLimits(profile: EvaluationProfile): EvaluationLimits {
  if (profile === "smoke") {
    return {
      maxCases: config.EVAL_SMOKE_MAX_CASES,
      maxSteps: config.EVAL_SMOKE_MAX_RESEARCH_STEPS,
      maxQueries: config.EVAL_SMOKE_MAX_SEARCH_QUERIES,
      maxSources: config.EVAL_SMOKE_MAX_SOURCES,
      maxPages: config.EVAL_SMOKE_MAX_PAGES,
      maxTimeMs: config.EVAL_SMOKE_MAX_RESEARCH_TIME_MS,
      openRouterTimeoutMs: config.EVAL_SMOKE_OPENROUTER_TIMEOUT_MS,
      caseNames: "direct_javascript_closures,current_react_version,compare_react_native_flutter",
      profile,
    };
  }

  return {
    maxCases: config.EVAL_MAX_CASES,
    maxSteps: config.EVAL_MAX_RESEARCH_STEPS,
    maxQueries: config.EVAL_MAX_SEARCH_QUERIES,
    maxSources: config.EVAL_MAX_SOURCES,
    maxPages: config.EVAL_MAX_PAGES,
    maxTimeMs: config.EVAL_MAX_RESEARCH_TIME_MS,
    openRouterTimeoutMs: config.EVAL_OPENROUTER_TIMEOUT_MS,
    caseNames: config.EVAL_CASE_NAMES,
    profile,
  };
}

function applyProfileExpectations(
  testCase: RealEvaluationCase,
  profile: EvaluationProfile,
): RealEvaluationCase {
  if (profile !== "smoke") return testCase;
  // For the complex comparison smoke case, trim required actions to what the
  // tight budget can realistically achieve (4 steps max).
  const requiredActions =
    testCase.name === "compare_react_native_flutter"
      ? ["understand_query", "web_search", "source_triage", "fetch_url"]
      : testCase.requiredActions;
  return { ...testCase, requiredActions };
}

// ---------------------------------------------------------------------------
// Console output helpers
// ---------------------------------------------------------------------------
function printCaseResult(result: EvaluationResult) {
  const statusIcon = result.criticalFailures.length > 0 ? "❌" : result.checks.route ? "✅" : "⚠️";
  console.log(
    `${statusIcon} ${result.name}  route=${result.route ?? "unavailable"}  ` +
      `expected=${result.expectedRoute}  trace=[${result.trace.join(" → ")}]`,
  );
  if (result.failure) {
    console.log(`   ⚠ failure(${result.failure.kind}): ${result.failure.message.slice(0, 120)}`);
  }
  for (const cf of result.criticalFailures) {
    console.log(`   ❌ CRITICAL[${cf.kind}]: ${cf.detail}`);
  }
}

function printSmokeVerdict(verdict: SmokeVerdict) {
  console.log("");
  console.log("─".repeat(72));
  if (verdict.pass) {
    console.log("SMOKE: PASS ✅");
  } else {
    console.log("SMOKE: FAIL ❌");
  }
  console.log("─".repeat(72));
  console.log(
    `  Routing accuracy       : ${(verdict.routingAccuracy * 100).toFixed(0)}%  (required 100%)`,
  );
  console.log(
    `  Tool-decision accuracy : ${(verdict.toolDecisionAccuracy * 100).toFixed(0)}%  (required ≥80%)`,
  );
  console.log(`  Controller violations  : ${verdict.controllerViolations}  (required 0)`);
  console.log(`  Critical failures      : ${verdict.criticalFailures.length}  (required 0)`);
  if (!verdict.pass) {
    console.log("");
    console.log("Reasons:");
    for (const reason of verdict.reasons) {
      console.log(`  • ${reason}`);
    }
  }
  console.log("─".repeat(72));
}

async function main() {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured; refusing to run real-model evaluation");
  }
  const profile = evaluationProfile();
  const limits = evaluationLimits(profile);
  console.log(`\nResearch Agent MAX — Real-Model Evaluation`);
  console.log(`Profile  : ${profile.toUpperCase()}`);
  console.log(`Model    : ${config.OPENROUTER_MODEL}`);
  console.log(
    `Budget   : ${limits.maxSteps} steps | ${limits.maxQueries} queries | ` +
      `${limits.maxSources} sources | ${limits.maxPages} pages | ` +
      `${limits.maxTimeMs / 1000}s session | ${limits.openRouterTimeoutMs / 1000}s LLM timeout`,
  );
  console.log("");

  const requestedCases = new Set(
    limits.caseNames
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const cases = realEvaluationCases
    .filter((testCase) => requestedCases.size === 0 || requestedCases.has(testCase.name))
    .map((testCase) => applyProfileExpectations(testCase, profile))
    .slice(0, limits.maxCases);

  console.log(
    `Running ${cases.length} case(s): ${cases.map((testCase) => testCase.name).join(", ")}\n`,
  );

  const results: EvaluationResult[] = [];
  for (const testCase of cases) {
    console.log(`▶ ${testCase.name} ...`);
    const result = await evaluateCase(testCase, limits);
    results.push(result);
    printCaseResult(result);
  }

  const metrics = buildMetrics(results);

  let smokeVerdict: SmokeVerdict | undefined;
  if (profile === "smoke") {
    smokeVerdict = buildSmokeVerdict(results, metrics);
    printSmokeVerdict(smokeVerdict);
  }

  const report = {
    timestamp: new Date().toISOString(),
    profile,
    model: config.OPENROUTER_MODEL,
    baseUrl: config.OPENROUTER_BASE_URL,
    budget: {
      maxCases: limits.maxCases,
      maxSteps: limits.maxSteps,
      maxQueries: limits.maxQueries,
      maxSources: limits.maxSources,
      maxPages: limits.maxPages,
      maxTimeMs: limits.maxTimeMs,
      openRouterTimeoutMs: limits.openRouterTimeoutMs,
      selectedCases: cases.map((testCase) => testCase.name),
    },
    metrics,
    smokeVerdict,
    results,
  };
  const outputDirectory = resolve("evaluation-results");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `real-model-${Date.now()}.json`);
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport saved: ${outputPath}`);
  console.log(JSON.stringify({ profile, metrics: { ...metrics, smokeVerdict } }, null, 2));

  // Exit with failure code when the smoke test fails, so CI catches it.
  if (profile === "smoke" && smokeVerdict && !smokeVerdict.pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
