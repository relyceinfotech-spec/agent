import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AutonomousAgent, type AgentRoute } from "../agent/autonomous.js";
import { createToolRegistry } from "../agent/tools.js";
import { config } from "../config.js";
import type { Claim, ResearchObjective, ResearchSession, Source } from "../domain.js";
import { OpenRouterProvider, type LLMMetrics } from "../llm.js";
import { ResearchRunner, type ResearchBudget } from "../research.js";
import { ResilientSearchProvider, SerperProvider } from "../search.js";
import { MemorySessionStore } from "../store.js";

// ============================================================================
// EVALUATION BUDGETS & SLA LIMITS (QUALITY EVALUATOR v2)
// ============================================================================
const QUALITY_BUDGET: ResearchBudget = {
  maxSteps: config.EVAL_QUALITY_MAX_RESEARCH_STEPS,
  maxQueries: config.EVAL_QUALITY_MAX_SEARCH_QUERIES,
  maxSources: config.EVAL_QUALITY_MAX_SOURCES,
  maxPages: config.EVAL_QUALITY_MAX_PAGES,
  maxClaimsToVerify: 4,
  maxTimeMs: config.EVAL_QUALITY_SESSION_TIMEOUT_MS,
  maxModelDecisions: 4,
  maxSearchPasses: 2,
};

const OPENROUTER_TIMEOUT_MS = config.EVAL_QUALITY_OPENROUTER_TIMEOUT_MS;
const SESSION_TIMEOUT_MS = config.EVAL_QUALITY_SESSION_TIMEOUT_MS;

export type FailureClassification = "INFRASTRUCTURE_FAILURE" | "MODEL_QUALITY_FAILURE" | "NONE";

export type QualityFailureCategory =
  | "SEARCH_PROVIDER_FAILURE"
  | "SOURCE_FETCH_FAILURE"
  | "ZERO_RESULTS"
  | "OPENROUTER_FAILURE"
  | "OPENROUTER_RATE_LIMIT"
  | "TIMEOUT"
  | "FABRICATED_CITATIONS"
  | "UNGROUNDED_CLAIMS"
  | "MISSING_ENTITIES"
  | "INCOMPLETE_COVERAGE"
  | "CONTRADICTION_UNRESOLVED"
  | "LATENCY_SLA_VIOLATION"
  | "EVALUATION_BUDGET_EXHAUSTED";

export interface QualityCaseBudget {
  maxSteps: number;
  maxQueries: number;
  maxSources: number;
  maxPages: number;
  maxClaimsToVerify: number;
  maxTimeMs: number;
  maxModelDecisions: number;
  maxSearchPasses: number;
  openRouterRequestTimeoutMs: number;
  evaluatorWaitTimeoutMs: number;
}

export function classifyOpenRouterFailure(message: string): QualityFailureCategory | undefined {
  if (/openrouter returned 429/i.test(message)) return "OPENROUTER_RATE_LIMIT";
  if (
    /openrouter request timed out|openrouter request skipped: research session budget exhausted/i.test(
      message,
    )
  )
    return "TIMEOUT";
  if (/openrouter|api\.openrouter/i.test(message)) return "OPENROUTER_FAILURE";
  return undefined;
}

export function isEvidenceInsufficiencyResponse(answer: string): boolean {
  return /(?:cannot|can't|unable to|not enough|insufficient|lack(?:s|ing)?\s+(?:of\s+)?(?:enough\s+)?evidence|evidence\s+(?:is\s+)?(?:insufficient|not strong enough)|not sufficiently verified|research reached its bounded\s+\d+-step budget|research ended without enough extractable evidence)/i.test(
    answer,
  );
}

export function isOfficialPrimarySourceDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  return [
    "react.dev",
    "reactjs.org",
    "npmjs.com",
    "registry.npmjs.org",
    "endoflife.date",
    "reactnative.dev",
  ].some((trusted) => normalized === trusted || normalized.endsWith(`.${trusted}`));
}

export type GroundingVerdict =
  "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED" | "UNCERTAIN";

export interface EvaluatedClaim {
  text: string;
  verdict: GroundingVerdict;
  importance: "critical" | "high" | "medium" | "low";
  supportingSourceIds: string[];
  rationale: string;
}

export interface CitationValidation {
  totalCitationsInAnswer: number;
  validCitationsCount: number;
  groundedCitationsCount: number;
  fabricatedCitationsCount: number;
  citationPrecision: number;
  citationGroundedRate: number;
  citationDetails: Array<{
    marker: string;
    sourceIndex: number;
    source?: { title: string; url: string; domain: string };
    isValidSource: boolean;
    isGrounded: boolean;
    excerpt: string;
  }>;
}

export interface DimensionScores {
  factualCorrectness: "PASS" | "FAIL";
  evidenceGrounding: "PASS" | "FAIL";
  citationCorrectness: "PASS" | "FAIL";
  sourceRelevance: "PASS" | "FAIL";
  sourceQuality: "PASS" | "FAIL";
  objectiveCoverage: number; // 0 - 100%
  completeness: "PASS" | "FAIL";
  contradictionHandling: "PASS" | "FAIL" | "N/A";
  unsupportedClaimRate: number; // 0.0 - 1.0
  usefulnessScore: number; // 1 - 5
}

export interface QualityCaseResult {
  caseIndex: number;
  name: string;
  category: "factual_lookup" | "comparison" | "multi_objective" | "conflict" | "ambiguous";
  prompt: string;
  deepResearch: boolean;
  effectiveBudget: QualityCaseBudget;
  routeTaken?: AgentRoute;
  durationMs: number;
  slaLimitMs: number;
  status: "COMPLETED" | "FAILED" | "TIMEOUT";
  finalAnswer: string;
  sourcesRetrieved: Array<{
    id: string;
    title: string;
    url: string;
    domain: string;
    sourceType?: string;
    fetchError?: string;
    authority: number;
    relevance: number;
  }>;
  objectives: Array<{
    label: string;
    importance: string;
    status: string;
    coverage: number;
  }>;
  claimsEvaluated: EvaluatedClaim[];
  researchClaims: Array<{
    text: string;
    sourceIds: string[];
    verdict?: string;
    rationale?: string;
  }>;
  citationValidation: CitationValidation;
  dimensionScores: DimensionScores;
  failureType: FailureClassification;
  failureCategory?: QualityFailureCategory;
  stageTimings?: Record<string, number>;
  llmMetrics: LLMMetrics;
  researchTrace: {
    toolSequence: string[];
    searchCount: number;
    fetchCount: number;
    searchAgainOccurred: boolean;
    verificationOccurred: boolean;
    conflictsDetected: number;
    evidenceSufficientAtStop: boolean;
  };
  searchAttempts?: ResearchSession["searchAttempts"];
  criticalIssues: string[];
  passed: boolean;
}

export interface QualitySmokeReport {
  timestamp: string;
  model: string;
  searchProvider: "serper";
  searchConfigured: boolean;
  configuredBudget: Omit<QualityCaseBudget, "maxTimeMs"> & {
    maxTimeMs: number;
    maxCases: number;
  };
  totalCases: number;
  passedCases: number;
  overallPassed: boolean;
  metrics: {
    avgCitationPrecision: number;
    avgCitationGroundedRate: number;
    avgUnsupportedClaimRate: number;
    avgObjectiveCoverage: number;
    avgDurationSec: number;
    totalFabricatedCitations: number;
    totalCriticalUnsupportedClaims: number;
    infrastructureFailures: number;
    modelQualityFailures: number;
    llmCalls: number;
    llmFailures: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    reportedCostUsd?: number;
  };
  cases: QualityCaseResult[];
}

// ----------------------------------------------------------------------------
// TEST CASES SPECIFICATION WITH EXPLICIT SLAs
// ----------------------------------------------------------------------------
export const QUALITY_CASES: Array<{
  name: string;
  category: QualityCaseResult["category"];
  prompt: string;
  deepResearch: boolean;
  requiredEntities: string[];
  expectedDimensions: string[];
  conflictExpected: boolean;
  officialSourceExpected: boolean;
  slaLimitMs: number;
}> = [
  {
    name: "CASE 1 — Current factual lookup",
    category: "factual_lookup",
    prompt: "What is the latest React version?",
    deepResearch: false,
    requiredEntities: ["react"],
    expectedDimensions: ["version", "release"],
    conflictExpected: false,
    officialSourceExpected: true,
    slaLimitMs: 45000, // SLA target <25s, hard limit 45s
  },
  {
    name: "CASE 2 — Technical comparison",
    category: "comparison",
    prompt: "Compare React Native and Flutter for a startup in 2026.",
    deepResearch: false,
    requiredEntities: ["react native", "flutter"],
    expectedDimensions: ["performance", "developer velocity", "ecosystem"],
    conflictExpected: false,
    officialSourceExpected: false,
    slaLimitMs: 80000, // SLA target <50s, hard limit 80s
  },
  {
    name: "CASE 3 — Multi-objective research",
    category: "multi_objective",
    prompt:
      "Compare Supabase and Firebase for a SaaS considering pricing, auth, scalability and developer experience.",
    deepResearch: true,
    requiredEntities: ["supabase", "firebase"],
    expectedDimensions: ["pricing", "auth", "scalability", "developer experience"],
    conflictExpected: false,
    officialSourceExpected: false,
    slaLimitMs: 110000, // SLA target <70s, hard limit 110s
  },
  {
    name: "CASE 4 — Conflicting evidence",
    category: "conflict",
    prompt: "Is Bun faster and ready to replace Node.js in real-world production systems?",
    deepResearch: true,
    requiredEntities: ["bun", "node"],
    expectedDimensions: ["performance", "compatibility", "production readiness"],
    conflictExpected: true,
    officialSourceExpected: false,
    slaLimitMs: 90000, // SLA target <60s, hard limit 90s
  },
  {
    name: "CASE 5 — Ambiguous / messy question",
    category: "ambiguous",
    prompt: "wat is differnce btween trpc and graphql for nextjs api?",
    deepResearch: false,
    requiredEntities: ["trpc", "graphql"],
    expectedDimensions: ["typescript", "schema", "api", "type"],
    conflictExpected: false,
    officialSourceExpected: false,
    slaLimitMs: 40000, // SLA target <20s, hard limit 40s
  },
];

// ----------------------------------------------------------------------------
// CITATION & CLAIM VALIDATION ENGINE (BUGFIXED & MATHEMATICALLY PRECISE)
// ----------------------------------------------------------------------------
export function evaluateCitations(answer: string, sources: Source[]): CitationValidation {
  const citationRegex = /\[(\d+)\]/g;
  const rawMatches = [...answer.matchAll(citationRegex)];

  // FILTER OUT publication years like [2024], [2025], [2026] FIRST
  // before calculating total count and precision
  const matches = rawMatches.filter((match) => {
    const idx = parseInt(match[1], 10);
    return idx < 1900 || idx > 2099;
  });

  const details: CitationValidation["citationDetails"] = [];
  let validCount = 0;
  let groundedCount = 0;
  let fabricatedCount = 0;

  for (const match of matches) {
    const marker = match[0];
    const sourceIndex = parseInt(match[1], 10);
    const isValid = sourceIndex >= 1 && sourceIndex <= sources.length;

    let isGrounded = false;
    let sourceObj: { title: string; url: string; domain: string } | undefined;

    // Extract enclosing sentence for the citation marker
    const matchIndex = match.index ?? 0;
    const sentenceBefore =
      answer
        .slice(0, matchIndex)
        .split(/(?<=[.?!])\s+/)
        .pop() ?? "";
    const sentenceAfter = answer.slice(matchIndex).split(/(?<=[.?!])\s+/)[0] ?? "";
    const excerpt = (sentenceBefore + sentenceAfter).replace(/\s+/g, " ").trim();

    if (isValid && sources.length > 0) {
      validCount++;
      const source = sources[sourceIndex - 1];
      sourceObj = {
        title: source.title,
        url: source.url,
        domain: source.domain,
      };

      const excerptWords = excerpt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3);

      const sourceContentLower = (
        (source.content || "") +
        " " +
        (source.snippet || "") +
        " " +
        source.title +
        " " +
        source.domain
      ).toLowerCase();

      const matchingWords = excerptWords.filter((w) => sourceContentLower.includes(w));
      const matchRatio = excerptWords.length > 0 ? matchingWords.length / excerptWords.length : 0;
      const domainMatch = Boolean(
        source.domain && excerpt.toLowerCase().includes(source.domain.toLowerCase()),
      );

      isGrounded = matchRatio >= 0.2 || matchingWords.length >= 2 || domainMatch;
      if (isGrounded) groundedCount++;
    } else {
      fabricatedCount++;
    }

    details.push({
      marker,
      sourceIndex,
      source: sourceObj,
      isValidSource: isValid && sources.length > 0,
      isGrounded,
      excerpt,
    });
  }

  const total = matches.length;
  // Mathematical correctness: If citations exist, precision is valid / total.
  // If no citations exist in a research response that fetched sources, precision is 0.0.
  let citationPrecision = 1.0;
  if (total > 0) {
    citationPrecision = validCount / total;
  } else if (sources.length > 0) {
    citationPrecision = 0.0; // Missing citations when sources are available
  }

  const citationGroundedRate = validCount > 0 ? groundedCount / validCount : 0.0;

  return {
    totalCitationsInAnswer: total,
    validCitationsCount: validCount,
    groundedCitationsCount: groundedCount,
    fabricatedCitationsCount: fabricatedCount,
    citationPrecision: Number(citationPrecision.toFixed(4)),
    citationGroundedRate: Number(citationGroundedRate.toFixed(4)),
    citationDetails: details,
  };
}

export function evaluateClaims(
  answer: string,
  sources: Source[],
  sessionClaims: Claim[],
): EvaluatedClaim[] {
  const evaluated: EvaluatedClaim[] = [];
  const supportedSessionClaims = sessionClaims.filter(
    (c) => c.verification?.verdict === "supported",
  );

  const sentences = answer
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 25 &&
        !s.startsWith("#") &&
        !s.startsWith("---") &&
        !s.toLowerCase().startsWith("sources:") &&
        !s.toLowerCase().startsWith("supporting context:") &&
        !s.toLowerCase().startsWith("here’s") &&
        !s.toLowerCase().startsWith("here is") &&
        !s.toLowerCase().startsWith("the generated draft included") &&
        !s.toLowerCase().startsWith("max can verify only") &&
        !s.toLowerCase().startsWith("broader conclusions need more verified evidence"),
    );

  for (const sentence of sentences.slice(0, 10)) {
    const versionIssue = detectVersionTerminologyError(sentence);
    const citedIndices = [...sentence.matchAll(/\[(\d+)\]/g)]
      .map((match) => Number(match[1]) - 1)
      .filter((index) => index >= 0 && index < sources.length);
    const citedSources = [...new Set(citedIndices)].map((index) => sources[index]);
    const citedSourceIds = new Set(citedSources.map((source) => source.id));
    const combinedSourceText = citedSources
      .map((source) => `${source.title} ${source.snippet} ${source.content || ""}`)
      .join(" ")
      .toLowerCase();
    const relevantVerifiedClaims = supportedSessionClaims.filter((claim) =>
      claim.sourceIds.some((sourceId) => citedSourceIds.has(sourceId)),
    );
    const normalizeEvidenceText = (text: string) =>
      text
        .toLowerCase()
        .replace(/\[\d+\]/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const normalizedSentence = normalizeEvidenceText(sentence);
    const exactVerifiedClaim = relevantVerifiedClaims.some((claim) => {
      const normalizedClaim = normalizeEvidenceText(claim.text);
      return (
        normalizedClaim.length >= 40 &&
        (normalizedSentence.includes(normalizedClaim) ||
          normalizedClaim.includes(normalizedSentence))
      );
    });
    const combinedClaimText = relevantVerifiedClaims
      .map((claim) => `${claim.text} ${claim.evidence}`)
      .join(" ")
      .toLowerCase();
    const sentenceWords = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);

    if (sentenceWords.length < 3) continue;

    const sourceMatches = sentenceWords.filter((w) => combinedSourceText.includes(w));
    const sourceOverlap =
      sentenceWords.length > 0 ? sourceMatches.length / sentenceWords.length : 0;

    const claimMatches = sentenceWords.filter((w) => combinedClaimText.includes(w));
    const claimOverlap = sentenceWords.length > 0 ? claimMatches.length / sentenceWords.length : 0;

    const maxOverlap = Math.max(sourceOverlap, claimOverlap);

    // CRITICAL CORRECTION: If sources.length === 0, claims CANNOT be supported by web research
    let verdict: GroundingVerdict = "UNSUPPORTED";
    if (versionIssue) {
      verdict = "CONTRADICTED";
    } else if (citedSources.length === 0) {
      verdict = "UNSUPPORTED";
    } else if (
      exactVerifiedClaim ||
      maxOverlap >= 0.55 ||
      relevantVerifiedClaims.some((c) =>
        c.text.toLowerCase().includes(sentenceWords.slice(0, 3).join(" ")),
      )
    ) {
      verdict = "SUPPORTED";
    } else if (maxOverlap >= 0.3) {
      verdict = "PARTIALLY_SUPPORTED";
    } else {
      verdict = "UNSUPPORTED";
    }

    const isCritical =
      /\b(19\.|flutter|react native|supabase|firebase|bun|node|trpc|graphql|\d+%|\$\d+)\b/i.test(
        sentence,
      );

    evaluated.push({
      text: sentence,
      verdict,
      importance: isCritical ? "critical" : "high",
      supportingSourceIds: citedSources.map((source) => source.id),
      rationale: versionIssue
        ? versionIssue
        : citedSources.length === 0
          ? "No valid source citation attached to this sentence"
          : `Lexical overlap: ${Math.round(maxOverlap * 100)}% with cited sources; semantic entailment not established`,
    });
  }

  // Include verified claims from session ONLY if sources exist
  if (sources.length > 0) {
    for (const claim of supportedSessionClaims.slice(0, 5)) {
      evaluated.push({
        text: claim.text,
        verdict: "SUPPORTED",
        importance: claim.importance || "high",
        supportingSourceIds: claim.sourceIds || [],
        rationale: claim.verification?.rationale || "Verified supported by LLM cross-check",
      });
    }
  }

  return evaluated;
}

// A lexical overlap score cannot establish that a release was described correctly.
// This deliberately narrow invariant catches an observed false positive; it does
// not purport to be a general semantic fact checker.
export function detectVersionTerminologyError(sentence: string): string | undefined {
  const labeledMajor =
    /\b(?:marks|calls|labels|describes|identifies)\s+v?(\d+)\.(\d+)(?:\.\d+)?\s+as\s+(?:the\s+)?(?:latest\s+)?major version\b/i;
  const directMajor = /\bmajor version\s+(?:is\s+|of\s+|:\s*)?v?(\d+)\.(\d+)(?:\.\d+)?\b/i;
  const match = sentence.match(labeledMajor) ?? sentence.match(directMajor);
  if (match && Number(match[2]) > 0) {
    return `Release ${match[1]}.${match[2]} was mislabeled as a major version; its nonzero minor component makes it a minor release within major version ${match[1]}.`;
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// WAIT FOR RESEARCH SESSION HELPER
// ----------------------------------------------------------------------------
async function waitForSession(store: MemorySessionStore, id: string, maxTimeMs: number) {
  const deadline = Date.now() + maxTimeMs;
  while (Date.now() < deadline) {
    const current = await store.get(id);
    if (
      current?.status === "COMPLETED" ||
      current?.status === "FAILED" ||
      current?.status === "NEEDS_CLARIFICATION" ||
      current?.status === "CANCELLED"
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return store.get(id);
}

export function isEvaluationBudgetExhausted(
  session: Pick<ResearchSession, "sources" | "steps" | "searchAttempts"> | undefined,
  budget: ResearchBudget,
): boolean {
  if (!session) return false;
  if (session.steps.some((step) => /budget exhausted/i.test(step.label))) return true;

  const attemptedPages = session.sources.filter(
    (source) => Boolean(source.content) || Boolean(source.fetchError),
  ).length;
  if (budget.maxPages > 0 && attemptedPages >= budget.maxPages) return true;

  return budget.maxQueries > 0 && (session.searchAttempts?.length ?? 0) >= budget.maxQueries;
}

// ----------------------------------------------------------------------------
// RUNNER FUNCTION (EVALUATOR v2)
// ----------------------------------------------------------------------------
export async function runQualitySmokeEvaluation(): Promise<QualitySmokeReport> {
  console.log("\n================================================================================");
  console.log(" 🔬 RESEARCH AGENT MAX — RETRIEVAL RELIABILITY & QUALITY EVALUATOR v2");
  console.log("================================================================================");
  console.log(`Model:           ${config.OPENROUTER_MODEL}`);
  console.log(
    `Search Provider: Serper (${config.SERPER_API_KEY ? "key configured" : "no API key"})`,
  );
  console.log(`Step Budget:     ${QUALITY_BUDGET.maxSteps} steps`);
  console.log(
    `Search Budget:   ${QUALITY_BUDGET.maxQueries} queries, ${QUALITY_BUDGET.maxSources} sources, ${QUALITY_BUDGET.maxPages} pages`,
  );
  console.log("================================================================================\n");

  const searchProvider = new ResilientSearchProvider([
    { name: "serper", provider: new SerperProvider() },
  ]);

  const results: QualityCaseResult[] = [];
  const caseArg = process.argv.find((a) => a.startsWith("--case="));
  const packArg = process.argv.find((a) => a.startsWith("--pack="));
  const isSmoke = process.argv.includes("--smoke");
  const targetCaseIndex = isSmoke ? 1 : caseArg ? parseInt(caseArg.split("=")[1], 10) : undefined;
  const maxPackCases = packArg ? parseInt(packArg.split("=")[1], 10) : undefined;

  for (let i = 0; i < QUALITY_CASES.length; i++) {
    const testCase = QUALITY_CASES[i];
    const caseIndex = i + 1;
    if (targetCaseIndex !== undefined && targetCaseIndex !== caseIndex) {
      continue;
    }
    if (maxPackCases !== undefined && caseIndex > maxPackCases) {
      continue;
    }
    console.log(
      `\n--------------------------------------------------------------------------------`,
    );
    console.log(`▶ RUNNING [${caseIndex}/5] ${testCase.name}`);
    console.log(`  Question: "${testCase.prompt}" (Deep: ${testCase.deepResearch})`);
    console.log(`  SLA Limit: ${(testCase.slaLimitMs / 1000).toFixed(0)}s`);
    console.log(`--------------------------------------------------------------------------------`);

    const store = new MemorySessionStore();
    const caseBudget: ResearchBudget = {
      ...QUALITY_BUDGET,
      maxTimeMs: Math.min(QUALITY_BUDGET.maxTimeMs, Math.max(10_000, testCase.slaLimitMs - 5_000)),
    };
    const llm = new OpenRouterProvider(OPENROUTER_TIMEOUT_MS);
    llm.setDeadline(Date.now() + caseBudget.maxTimeMs);
    const registry = createToolRegistry(searchProvider, llm);
    const runner = new ResearchRunner(store, searchProvider, llm, registry, caseBudget);
    const agent = new AutonomousAgent(registry, runner, llm, store, caseBudget);

    const startedAt = performance.now();
    const criticalIssues: string[] = [];
    let status: QualityCaseResult["status"] = "COMPLETED";
    let failureType: FailureClassification = "NONE";
    let failureCategory: QualityFailureCategory | undefined;
    let finalAnswer = "";
    let session: ResearchSession | undefined;
    let routeTaken: AgentRoute | undefined;

    try {
      const chatResponse = await agent.handle(testCase.prompt, testCase.deepResearch);
      routeTaken = chatResponse.route;

      if (chatResponse.answer) {
        finalAnswer = chatResponse.answer;
        session = chatResponse.session;
      } else if (chatResponse.researchId) {
        console.log(`  ⏳ Awaiting background research loop (ID: ${chatResponse.researchId})...`);
        const unsubscribe = runner.subscribe(chatResponse.researchId, (event) => {
          if (event.type === "research.step" && event.step) {
            console.log(
              `    ↳ [${event.step.status.toUpperCase()}] ${event.step.label}${event.step.detail ? `: ${event.step.detail}` : ""}`,
            );
          }
        });
        try {
          session = await waitForSession(
            store,
            chatResponse.researchId,
            Math.min(SESSION_TIMEOUT_MS, caseBudget.maxTimeMs + 3_000),
          );
        } finally {
          unsubscribe();
        }
        if (!session || session.status !== "COMPLETED") {
          if (session && !["FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(session.status)) {
            await runner.cancel(chatResponse.researchId);
          }
          status = session?.status === "FAILED" ? "FAILED" : "TIMEOUT";
          finalAnswer = session?.answer || session?.error || "Session did not complete in time";
          failureType = "INFRASTRUCTURE_FAILURE";
          failureCategory =
            session?.status === "FAILED"
              ? (classifyOpenRouterFailure(session.error ?? "") ??
                (/timed out|timeout/i.test(session.error ?? "")
                  ? "TIMEOUT"
                  : "SEARCH_PROVIDER_FAILURE"))
              : "TIMEOUT";
        } else {
          finalAnswer = session.answer || "";
        }
      }
    } catch (err: unknown) {
      status = "FAILED";
      const errMsg = err instanceof Error ? err.message : String(err);
      finalAnswer = `Execution failed: ${errMsg}`;
      failureType = "INFRASTRUCTURE_FAILURE";
      if (classifyOpenRouterFailure(errMsg)) failureCategory = classifyOpenRouterFailure(errMsg);
      else if (/search|serper/i.test(errMsg)) failureCategory = "SEARCH_PROVIDER_FAILURE";
      else if (/timed out|timeout/i.test(errMsg)) failureCategory = "TIMEOUT";
      else failureCategory = "SEARCH_PROVIDER_FAILURE";
      criticalIssues.push(`Exception occurred: ${errMsg}`);
    }

    const llmMetrics = llm.metrics;
    if (/^Model synthesis (?:timed out|failed);/i.test(finalAnswer)) {
      failureType = "INFRASTRUCTURE_FAILURE";
      failureCategory = /timed out/i.test(finalAnswer) ? "TIMEOUT" : "OPENROUTER_FAILURE";
      criticalIssues.push(
        "OpenRouter synthesis failed; MAX returned a verified-evidence fallback.",
      );
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const sources = session?.sources || [];
    const claims = session?.claims || [];
    const objectives: QualityCaseResult["objectives"] = (
      session?.state?.objectives ||
      session?.plan?.structuredObjectives ||
      []
    ).map((o) => ({
      label: o.label,
      importance: o.importance,
      status: o.status,
      coverage: o.coverage,
    }));

    const isDirect = testCase.category === "ambiguous" && routeTaken === "direct";
    const isEvidenceInsufficiency = !isDirect && isEvidenceInsufficiencyResponse(finalAnswer);
    const evaluationBudgetExhausted =
      isEvidenceInsufficiency && isEvaluationBudgetExhausted(session, caseBudget);

    // CHECK ZERO-RESULT / RETRIEVAL INTEGRITY FIRST
    if (!isDirect && sources.length === 0 && failureType === "NONE") {
      const attempts = session?.searchAttempts ?? [];
      const allFailed =
        attempts.length > 0 && attempts.every((attempt) => attempt.status === "failed");
      failureType = allFailed ? "INFRASTRUCTURE_FAILURE" : "MODEL_QUALITY_FAILURE";
      failureCategory = allFailed ? "SEARCH_PROVIDER_FAILURE" : "ZERO_RESULTS";
      criticalIssues.push(
        allFailed
          ? "Search providers failed before usable sources could be retrieved."
          : "No usable sources were selected from the discovery results.",
      );
    }

    if (
      !isDirect &&
      sources.length > 0 &&
      sources.every((source) => !source.content) &&
      sources.some((source) => source.fetchError)
    ) {
      failureType = "INFRASTRUCTURE_FAILURE";
      failureCategory = "SOURCE_FETCH_FAILURE";
      criticalIssues.push(
        `All selected sources failed retrieval: ${sources
          .map((source) => source.fetchError)
          .filter(Boolean)
          .join("; ")}`,
      );
    }

    const verificationProviderFailure = claims
      .map((claim) => claim.verification?.rationale ?? "")
      .find((rationale) => /batch verification provider failed: openrouter/i.test(rationale));
    if (verificationProviderFailure) {
      failureType = "INFRASTRUCTURE_FAILURE";
      failureCategory =
        classifyOpenRouterFailure(verificationProviderFailure) ?? "OPENROUTER_FAILURE";
      criticalIssues.push(`Claim verification provider failed: ${verificationProviderFailure}`);
    }

    if (isEvidenceInsufficiency) {
      criticalIssues.push(
        "MAX correctly disclosed that collected evidence was insufficient, but did not complete the requested research.",
      );
      if (failureType === "NONE") {
        failureType = evaluationBudgetExhausted
          ? "INFRASTRUCTURE_FAILURE"
          : "MODEL_QUALITY_FAILURE";
        failureCategory = evaluationBudgetExhausted
          ? "EVALUATION_BUDGET_EXHAUSTED"
          : "INCOMPLETE_COVERAGE";
        if (evaluationBudgetExhausted) {
          criticalIssues.push(
            "The configured evaluation page, query, or step ceiling was exhausted before evidence coverage was sufficient.",
          );
        }
      }
    }

    // 1. Citation Validation
    const citationValidation = evaluateCitations(finalAnswer, sources);
    if (citationValidation.fabricatedCitationsCount > 0) {
      criticalIssues.push(
        `Model Quality Issue: ${citationValidation.fabricatedCitationsCount} fabricated citation marker(s) found!`,
      );
      if (failureType === "NONE") {
        failureType = "MODEL_QUALITY_FAILURE";
        failureCategory = "FABRICATED_CITATIONS";
      }
    }

    // 2. Claim Grounding
    const evaluatedClaims =
      failureType === "INFRASTRUCTURE_FAILURE" || isDirect || isEvidenceInsufficiency
        ? []
        : evaluateClaims(finalAnswer, sources, claims);
    const criticalClaims = evaluatedClaims.filter(
      (c) => c.importance === "critical" || c.importance === "high",
    );
    const unsupportedCritical = criticalClaims.filter(
      (c) => c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED",
    );
    const unsupportedClaimRate =
      criticalClaims.length > 0 ? unsupportedCritical.length / criticalClaims.length : 0.0;

    if (!isDirect && !isEvidenceInsufficiency && sources.length === 0) {
      criticalIssues.push("Grounding Failure: Cannot ground claims when 0 sources were retrieved.");
    } else if (unsupportedCritical.length > 0) {
      criticalIssues.push(
        `Model Quality Issue: ${unsupportedCritical.length} critical factual claim(s) unsupported or contradicted!`,
      );
      if (failureType === "NONE") {
        failureType = "MODEL_QUALITY_FAILURE";
        failureCategory = "UNGROUNDED_CLAIMS";
      }
    }

    // 3. Question / Dimension Relevance
    const answerLower = finalAnswer.toLowerCase();
    const missedEntities = testCase.requiredEntities.filter((e) => !answerLower.includes(e));
    const coveredDimensions = testCase.expectedDimensions.filter((d) => answerLower.includes(d));
    const completenessRatio =
      testCase.expectedDimensions.length > 0
        ? coveredDimensions.length / testCase.expectedDimensions.length
        : 1.0;

    if (!isEvidenceInsufficiency && missedEntities.length > 0) {
      criticalIssues.push(`Answer missed primary entity: ${missedEntities.join(", ")}`);
      if (failureType === "NONE") {
        failureType = "MODEL_QUALITY_FAILURE";
        failureCategory = "MISSING_ENTITIES";
      }
    }

    // 4. Source Quality Check
    let officialSourceFound = false;
    if (testCase.officialSourceExpected) {
      officialSourceFound = sources.some((source) => isOfficialPrimarySourceDomain(source.domain));
      if (!officialSourceFound && sources.length > 0) {
        criticalIssues.push("An official or primary source was expected but not retrieved.");
      }
    }

    // 5. Conflict Check
    let conflictHandled: "PASS" | "FAIL" | "N/A" = "N/A";
    if (testCase.conflictExpected && !isEvidenceInsufficiency) {
      const mentionsTradeoffs =
        /\b(tradeoff|trade-off|disagree|however|contrary|benchmark|memory|stability|ecosystem|production readiness|depends)\b/i.test(
          finalAnswer,
        );
      conflictHandled = mentionsTradeoffs ? "PASS" : "FAIL";
      if (!mentionsTradeoffs) {
        criticalIssues.push(
          "Conflict case failed to represent technical tradeoffs between Bun and Node.js.",
        );
        if (failureType === "NONE") {
          failureType = "MODEL_QUALITY_FAILURE";
          failureCategory = "CONTRADICTION_UNRESOLVED";
        }
      }
    }

    // 6. Latency SLA Enforcement
    if (durationMs > testCase.slaLimitMs) {
      criticalIssues.push(
        `Latency SLA Violated: ${(durationMs / 1000).toFixed(1)}s exceeded SLA limit of ${(testCase.slaLimitMs / 1000).toFixed(0)}s`,
      );
      if (failureType === "NONE") {
        failureType = "MODEL_QUALITY_FAILURE";
        failureCategory = "LATENCY_SLA_VIOLATION";
      }
    }

    // Objective coverage
    const objectiveCoverage =
      sources.length === 0 && !isDirect
        ? 0
        : (session?.coverage ?? session?.state?.coverage ?? (objectives.length > 0 ? 0.85 : 1.0));

    const dimensionScores: DimensionScores = {
      factualCorrectness:
        isEvidenceInsufficiency || (sources.length > 0 && unsupportedCritical.length === 0)
          ? "PASS"
          : isDirect
            ? "PASS"
            : "FAIL",
      evidenceGrounding:
        isEvidenceInsufficiency ||
        (sources.length > 0 && citationValidation.citationGroundedRate >= 0.75)
          ? "PASS"
          : isDirect
            ? "PASS"
            : "FAIL",
      citationCorrectness:
        citationValidation.fabricatedCitationsCount === 0 &&
        (isEvidenceInsufficiency ||
          citationValidation.citationPrecision >= 0.9 ||
          (isDirect && citationValidation.totalCitationsInAnswer === 0))
          ? "PASS"
          : "FAIL",
      sourceRelevance:
        isDirect || (sources.length > 0 && missedEntities.length === 0) ? "PASS" : "FAIL",
      sourceQuality: !testCase.officialSourceExpected || officialSourceFound ? "PASS" : "FAIL",
      objectiveCoverage: Math.round(objectiveCoverage * 100),
      completeness: !isEvidenceInsufficiency && completenessRatio >= 0.6 ? "PASS" : "FAIL",
      contradictionHandling: conflictHandled,
      unsupportedClaimRate: Number(unsupportedClaimRate.toFixed(2)),
      usefulnessScore: finalAnswer.length > 120 && criticalIssues.length === 0 ? 5 : 3,
    };

    const passed =
      status === "COMPLETED" &&
      criticalIssues.length === 0 &&
      (isDirect || sources.length > 0) &&
      dimensionScores.citationCorrectness === "PASS" &&
      dimensionScores.factualCorrectness === "PASS" &&
      dimensionScores.evidenceGrounding === "PASS" &&
      dimensionScores.completeness === "PASS" &&
      durationMs <= testCase.slaLimitMs;

    results.push({
      caseIndex,
      name: testCase.name,
      category: testCase.category,
      prompt: testCase.prompt,
      deepResearch: testCase.deepResearch,
      effectiveBudget: {
        ...caseBudget,
        openRouterRequestTimeoutMs: OPENROUTER_TIMEOUT_MS,
        evaluatorWaitTimeoutMs: SESSION_TIMEOUT_MS,
      },
      routeTaken,
      durationMs,
      slaLimitMs: testCase.slaLimitMs,
      status,
      finalAnswer,
      sourcesRetrieved: sources.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        domain: s.domain,
        sourceType: s.sourceType,
        fetchError: s.fetchError,
        authority: s.quality?.authority ?? 0,
        relevance: s.quality?.relevance ?? 0,
      })),
      objectives,
      claimsEvaluated: evaluatedClaims,
      researchClaims: claims.map((claim) => ({
        text: claim.text.slice(0, 480),
        sourceIds: claim.sourceIds,
        verdict: claim.verification?.verdict,
        rationale: claim.verification?.rationale,
      })),
      citationValidation,
      dimensionScores,
      failureType,
      failureCategory,
      stageTimings: session?.stageTimings,
      llmMetrics,
      researchTrace: {
        toolSequence: session?.steps.map((step) => step.label) ?? [],
        searchCount: (session?.searchAttempts ?? []).filter(
          (attempt) => attempt.provider === "serper",
        ).length,
        fetchCount: sources.filter((source) => Boolean(source.content) && !source.fetchError)
          .length,
        searchAgainOccurred:
          session?.steps.some((step) => step.label.includes("search_again")) ?? false,
        verificationOccurred:
          session?.steps.some((step) => step.label.includes("verify_claim")) ?? false,
        conflictsDetected: session?.conflicts?.length ?? 0,
        evidenceSufficientAtStop:
          session?.status === "COMPLETED" &&
          (session.coverage ?? session.state?.coverage ?? 0) >= 0.7 &&
          !isEvidenceInsufficiency,
      },
      searchAttempts: session?.searchAttempts,
      criticalIssues,
      passed,
    });

    console.log(
      `\n  📝 ANSWER PREVIEW:\n  ${finalAnswer.slice(0, 300).replace(/\n/g, "\n  ")}...\n`,
    );
    console.log(
      `  ⏱️  Duration:          ${(durationMs / 1000).toFixed(1)}s (SLA Limit: ${(testCase.slaLimitMs / 1000).toFixed(0)}s)`,
    );
    if (session?.stageTimings && Object.keys(session.stageTimings).length > 0) {
      console.log(`  ⏱️  STAGE LATENCY BREAKDOWN:`);
      for (const [stg, ms] of Object.entries(session.stageTimings)) {
        console.log(`     ↳ ${(stg + ":").padEnd(25)} ${(ms / 1000).toFixed(1)}s`);
      }
    }
    console.log(`  🌐 Sources Retrieved: ${sources.length}`);
    console.log(
      `  🎯 Citations:         ${citationValidation.validCitationsCount}/${citationValidation.totalCitationsInAnswer} valid (${(citationValidation.citationPrecision * 100).toFixed(1)}% precision, ${citationValidation.fabricatedCitationsCount} fabricated)`,
    );
    console.log(
      `  ⚖️  Claims Grounded:   ${criticalClaims.length - unsupportedCritical.length}/${criticalClaims.length}`,
    );
    console.log(
      `  🏷️  Classification:    ${failureType !== "NONE" ? `[${failureType}] ${failureCategory}` : "CLEAN"}`,
    );
    console.log(`  📊 Verdict:           ${passed ? "✅ PASS" : "❌ FAIL"}`);
    if (criticalIssues.length > 0) {
      console.log(`  ⚠️  Critical Issues:  ${criticalIssues.join("; ")}`);
    }
  }

  // --------------------------------------------------------------------------
  // AGGREGATE SCORES
  // --------------------------------------------------------------------------
  const passedCases = results.filter((r) => r.passed).length;
  const avgCitationPrecision =
    results.reduce((acc, r) => acc + r.citationValidation.citationPrecision, 0) / results.length;
  const avgCitationGroundedRate =
    results.reduce((acc, r) => acc + r.citationValidation.citationGroundedRate, 0) / results.length;
  const avgUnsupportedClaimRate =
    results.reduce((acc, r) => acc + r.dimensionScores.unsupportedClaimRate, 0) / results.length;
  const avgObjectiveCoverage =
    results.reduce((acc, r) => acc + r.dimensionScores.objectiveCoverage, 0) / results.length;
  const avgDurationSec = results.reduce((acc, r) => acc + r.durationMs, 0) / results.length / 1000;
  const totalFabricatedCitations = results.reduce(
    (acc, r) => acc + r.citationValidation.fabricatedCitationsCount,
    0,
  );
  const totalCriticalUnsupportedClaims = results.reduce(
    (acc, r) =>
      acc +
      r.claimsEvaluated.filter(
        (c) =>
          (c.importance === "critical" || c.importance === "high") &&
          (c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED"),
      ).length,
    0,
  );
  const infrastructureFailures = results.filter(
    (r) => r.failureType === "INFRASTRUCTURE_FAILURE",
  ).length;
  const modelQualityFailures = results.filter(
    (r) => r.failureType === "MODEL_QUALITY_FAILURE",
  ).length;
  const llmTotals = results.reduce(
    (totals, result) => {
      const usage = result.llmMetrics.usage;
      totals.calls += result.llmMetrics.calls;
      totals.failures += result.llmMetrics.failures;
      totals.promptTokens += usage.promptTokens ?? 0;
      totals.completionTokens += usage.completionTokens ?? 0;
      totals.reasoningTokens += usage.reasoningTokens ?? 0;
      totals.totalTokens += usage.totalTokens ?? 0;
      if (usage.cost !== undefined) totals.reportedCostUsd += usage.cost;
      return totals;
    },
    {
      calls: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      reportedCostUsd: 0,
    },
  );
  const hasReportedCost = results.some((result) => result.llmMetrics.usage.cost !== undefined);

  const overallPassed =
    passedCases === results.length &&
    totalFabricatedCitations === 0 &&
    totalCriticalUnsupportedClaims === 0 &&
    infrastructureFailures === 0;

  const report: QualitySmokeReport = {
    timestamp: new Date().toISOString(),
    model: config.OPENROUTER_MODEL,
    searchProvider: "serper",
    searchConfigured: Boolean(config.SERPER_API_KEY),
    configuredBudget: {
      ...QUALITY_BUDGET,
      maxTimeMs: QUALITY_BUDGET.maxTimeMs,
      maxCases: config.EVAL_QUALITY_MAX_CASES,
      openRouterRequestTimeoutMs: OPENROUTER_TIMEOUT_MS,
      evaluatorWaitTimeoutMs: SESSION_TIMEOUT_MS,
    },
    totalCases: results.length,
    passedCases,
    overallPassed,
    metrics: {
      avgCitationPrecision: Number(avgCitationPrecision.toFixed(3)),
      avgCitationGroundedRate: Number(avgCitationGroundedRate.toFixed(3)),
      avgUnsupportedClaimRate: Number(avgUnsupportedClaimRate.toFixed(3)),
      avgObjectiveCoverage: Number(avgObjectiveCoverage.toFixed(1)),
      avgDurationSec: Number(avgDurationSec.toFixed(1)),
      totalFabricatedCitations,
      totalCriticalUnsupportedClaims,
      infrastructureFailures,
      modelQualityFailures,
      llmCalls: llmTotals.calls,
      llmFailures: llmTotals.failures,
      promptTokens: llmTotals.promptTokens,
      completionTokens: llmTotals.completionTokens,
      reasoningTokens: llmTotals.reasoningTokens,
      totalTokens: llmTotals.totalTokens,
      reportedCostUsd: hasReportedCost ? Number(llmTotals.reportedCostUsd.toFixed(8)) : undefined,
    },
    cases: results,
  };

  // --------------------------------------------------------------------------
  // WRITE OUTPUT FILES
  // --------------------------------------------------------------------------
  const reportPaths = await writeQualityReports(
    report,
    resolve(process.cwd(), "evaluation-results"),
  );

  console.log("\n================================================================================");
  console.log(
    ` 🏁 QUALITY EVALUATION v2 COMPLETE: ${passedCases}/${results.length} PASSED (${overallPassed ? "ALL GREEN" : "ISSUES IDENTIFIED"})`,
  );
  console.log(` 🏗️  Infrastructure Failures: ${infrastructureFailures}`);
  console.log(` 🧠 Model Quality Failures:   ${modelQualityFailures}`);
  console.log(
    ` 🪙 LLM usage: ${llmTotals.calls} requests, ${llmTotals.totalTokens} tokens${hasReportedCost ? `, $${llmTotals.reportedCostUsd.toFixed(6)} reported` : ", provider cost not reported"}`,
  );
  console.log(` 📄 JSON Report: ${reportPaths.latestJson}`);
  console.log(` 📝 Markdown:    ${reportPaths.latestMarkdown}`);
  console.log(` 🗂️  Run archive:  ${reportPaths.runJson}`);
  console.log("================================================================================\n");

  return report;
}

export async function writeQualityReports(
  report: QualitySmokeReport,
  outputDirectory: string,
): Promise<{
  latestJson: string;
  latestMarkdown: string;
  runJson: string;
}> {
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = report.timestamp.replace(/[:.]/g, "-");
  const latestJson = resolve(outputDirectory, "quality-smoke-report.json");
  const latestMarkdown = resolve(outputDirectory, "quality-smoke-report.md");
  const runJson = resolve(outputDirectory, `quality-smoke-run-${timestamp}.json`);
  const runMarkdown = resolve(outputDirectory, `quality-smoke-run-${timestamp}.md`);

  // Preserve the previous latest report before updating the stable paths.
  try {
    const previousJson = await readFile(latestJson, "utf8");
    const previousTimestamp = (JSON.parse(previousJson) as { timestamp?: unknown }).timestamp;
    if (typeof previousTimestamp === "string") {
      const previousId = previousTimestamp.replace(/[:.]/g, "-");
      const archivedJson = resolve(outputDirectory, `quality-smoke-run-${previousId}.json`);
      const archivedMarkdown = resolve(outputDirectory, `quality-smoke-run-${previousId}.md`);
      await writeIfMissing(archivedJson, previousJson);
      try {
        await writeIfMissing(archivedMarkdown, await readFile(latestMarkdown, "utf8"));
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const json = JSON.stringify(report, null, 2);
  const markdown = generateMarkdownReport(report);
  await writeFile(runJson, json, { encoding: "utf8", flag: "wx" });
  await writeFile(runMarkdown, markdown, { encoding: "utf8", flag: "wx" });
  await writeFile(latestJson, json, "utf8");
  await writeFile(latestMarkdown, markdown, "utf8");

  return { latestJson, latestMarkdown, runJson };
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function generateMarkdownReport(report: QualitySmokeReport): string {
  const lines: string[] = [];
  lines.push("# Research Agent MAX — Retrieval Reliability & Quality Evaluator Report v2\n");
  lines.push(`- **Date**: ${report.timestamp}`);
  lines.push(`- **Model**: \`${report.model}\``);
  lines.push(
    `- **Search Provider**: Serper (${report.searchConfigured ? "API key configured" : "API key missing"})`,
  );
  lines.push(
    `- **Configured Budget**: ${report.configuredBudget.maxSteps} steps, ${report.configuredBudget.maxQueries} queries, ${report.configuredBudget.maxSources} sources, ${report.configuredBudget.maxPages} pages, ${Math.round(report.configuredBudget.maxTimeMs / 1000)}s session, ${Math.round(report.configuredBudget.openRouterRequestTimeoutMs / 1000)}s/model request`,
  );
  lines.push(
    `- **Overall Verdict**: **${report.overallPassed ? "PASS ✅" : "FAIL ❌"}** (${report.passedCases}/${report.totalCases} cases passed)\n`,
  );

  lines.push("## Summary Metrics\n");
  lines.push("| Metric | Value | Target | Status |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Citation Precision | ${(report.metrics.avgCitationPrecision * 100).toFixed(1)}% | ≥ 90% | ${report.metrics.avgCitationPrecision >= 0.9 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Citation Grounding Rate | ${(report.metrics.avgCitationGroundedRate * 100).toFixed(1)}% | ≥ 75% | ${report.metrics.avgCitationGroundedRate >= 0.75 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Unsupported Claim Rate | ${(report.metrics.avgUnsupportedClaimRate * 100).toFixed(1)}% | ≤ 10% | ${report.metrics.avgUnsupportedClaimRate <= 0.1 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Objective Coverage | ${report.metrics.avgObjectiveCoverage}% | ≥ 80% | ${report.metrics.avgObjectiveCoverage >= 80 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Fabricated Citations | ${report.metrics.totalFabricatedCitations} | 0 | ${report.metrics.totalFabricatedCitations === 0 ? "PASS ✅" : "CRITICAL ❌"} |`,
  );
  lines.push(
    `| Critical Unsupported Claims | ${report.metrics.totalCriticalUnsupportedClaims} | 0 | ${report.metrics.totalCriticalUnsupportedClaims === 0 ? "PASS ✅" : "CRITICAL ❌"} |`,
  );
  lines.push(
    `| Infrastructure Failures | ${report.metrics.infrastructureFailures} | 0 | ${report.metrics.infrastructureFailures === 0 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Model Quality Failures | ${report.metrics.modelQualityFailures} | 0 | ${report.metrics.modelQualityFailures === 0 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(
    `| Average Latency | ${report.metrics.avgDurationSec}s | < 60s | ${report.metrics.avgDurationSec < 60 ? "PASS ✅" : "WARN ⚠️"} |\n`,
  );
  lines.push(`| LLM Requests | ${report.metrics.llmCalls} | — | — |`);
  lines.push(
    `| LLM Request Failures | ${report.metrics.llmFailures} | 0 | ${report.metrics.llmFailures === 0 ? "PASS ✅" : "FAIL ❌"} |`,
  );
  lines.push(`| LLM Total Tokens | ${report.metrics.totalTokens} | — | — |`);
  lines.push(
    `| Provider-Reported Cost | ${report.metrics.reportedCostUsd === undefined ? "not reported" : `$${report.metrics.reportedCostUsd.toFixed(6)}`} | — | — |\n`,
  );

  lines.push("## Case-by-Case Breakdown\n");

  for (const c of report.cases) {
    lines.push(`### ${c.name} (${c.passed ? "PASS ✅" : "FAIL ❌"})\n`);
    lines.push(`**Prompt**: *"${c.prompt}"*  `);
    lines.push(
      `**Route**: \`${c.routeTaken || "default"}\` | **Duration**: ${(c.durationMs / 1000).toFixed(1)}s (Limit: ${(c.slaLimitMs / 1000).toFixed(0)}s) | **Sources**: ${c.sourcesRetrieved.length} | **Coverage**: ${c.dimensionScores.objectiveCoverage}%\n`,
    );
    lines.push(
      `**Effective Budget**: ${c.effectiveBudget.maxSteps} steps, ${c.effectiveBudget.maxQueries} queries, ${c.effectiveBudget.maxSources} sources, ${c.effectiveBudget.maxPages} pages, ${Math.round(c.effectiveBudget.maxTimeMs / 1000)}s session, ${Math.round(c.effectiveBudget.openRouterRequestTimeoutMs / 1000)}s/model request  `,
    );
    lines.push(`**Trace**: ${c.researchTrace.toolSequence.join(" → ") || "no research tools"}  `);
    lines.push(
      `**Tool counts**: ${c.researchTrace.searchCount} searches, ${c.researchTrace.fetchCount} fetched pages, search-again=${c.researchTrace.searchAgainOccurred}, verification=${c.researchTrace.verificationOccurred}, conflicts=${c.researchTrace.conflictsDetected}, sufficient-at-stop=${c.researchTrace.evidenceSufficientAtStop}  `,
    );
    lines.push(
      `**LLM usage**: ${c.llmMetrics.calls} requests, ${c.llmMetrics.failures} failed, ${c.llmMetrics.usage.totalTokens ?? "unknown"} tokens, ${c.llmMetrics.usage.cost === undefined ? "cost not reported" : `$${c.llmMetrics.usage.cost.toFixed(6)}`}\n`,
    );
    if (c.failureType !== "NONE") {
      lines.push(`**Classification**: \`[${c.failureType}] ${c.failureCategory || "GENERAL"}\`\n`);
    }

    lines.push("#### Final MAX Answer\n");
    lines.push("```markdown");
    lines.push(c.finalAnswer);
    lines.push("```\n");

    lines.push("#### Retrieved Sources\n");
    if (c.sourcesRetrieved.length === 0) {
      lines.push("*No external sources fetched (direct synthesis or retrieval failed).*\n");
    } else {
      c.sourcesRetrieved.forEach((s, idx) => {
        lines.push(
          `- **[${idx + 1}]** [${s.title}](${s.url}) (\`${s.domain}\` — ${s.sourceType || "web"})`,
        );
      });
      lines.push("");
    }

    lines.push("#### Dimension Quality Scores\n");
    lines.push("| Dimension | Score / Verdict | Target |");
    lines.push("|---|---|---|");
    lines.push(`| Factual Correctness | ${c.dimensionScores.factualCorrectness} | PASS |`);
    lines.push(`| Evidence Grounding | ${c.dimensionScores.evidenceGrounding} | PASS |`);
    lines.push(`| Citation Correctness | ${c.dimensionScores.citationCorrectness} | PASS |`);
    lines.push(`| Source Relevance | ${c.dimensionScores.sourceRelevance} | PASS |`);
    lines.push(`| Source Quality | ${c.dimensionScores.sourceQuality} | PASS |`);
    lines.push(`| Objective Coverage | ${c.dimensionScores.objectiveCoverage}% | ≥ 80% |`);
    lines.push(`| Completeness | ${c.dimensionScores.completeness} | PASS |`);
    lines.push(
      `| Contradiction Handling | ${c.dimensionScores.contradictionHandling} | PASS or N/A |`,
    );
    lines.push(
      `| Unsupported Claim Rate | ${(c.dimensionScores.unsupportedClaimRate * 100).toFixed(0)}% | 0% |`,
    );
    lines.push(`| Usefulness Rating | ${c.dimensionScores.usefulnessScore}/5 | ≥ 4/5 |\n`);

    if (c.stageTimings && Object.keys(c.stageTimings).length > 0) {
      lines.push("#### Stage Latency Telemetry\n");
      lines.push("| Pipeline Stage | Latency |");
      lines.push("|---|---|");
      for (const [stage, ms] of Object.entries(c.stageTimings)) {
        lines.push(`| \`${stage}\` | ${(ms / 1000).toFixed(1)}s |`);
      }
      lines.push("");
    }

    if (c.criticalIssues.length > 0) {
      lines.push("#### ⚠️ Critical Findings\n");
      c.criticalIssues.forEach((issue) => lines.push(`- ${issue}`));
      lines.push("");
    }

    lines.push("---\n");
  }

  return lines.join("\n");
}

// Direct execution entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("quality.ts")) {
  runQualitySmokeEvaluation()
    .then((report) => {
      process.exit(report.overallPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error("Evaluation runtime failed:", err);
      process.exit(1);
    });
}
