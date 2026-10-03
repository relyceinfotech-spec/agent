import { randomUUID } from "node:crypto";
import {
  comparisonClaimHasTargetFinding,
  comparisonCoverage,
  comparisonEvidencePassages,
} from "./comparison-evidence.js";
import { currentWorkerContext } from "./worker-context.js";
import { config } from "./config.js";
import {
  activeResearchStage,
  getResearchExecutionContext,
  raceWithResearchAbort,
  researchStageTimingsSnapshot,
  runResearchStage,
  runWithResearchExecutionContext,
  throwIfResearchInactive,
  type ResearchExecutionContext,
} from "./execution-context.js";
import type {
  Claim,
  Conflict,
  ResearchDecision,
  ResearchEvent,
  ResearchSession,
  ResearchStep,
  ResearchMode,
  Source,
  SearchResult,
  ResearchObjective,
  ResearchState,
  ClaimImportance,
  OfficialSourceRequirement,
  SourceSelectionDecision,
  ResearchRecoveryRequirements,
  ResearchPlan,
  ReleaseEvidenceRecord,
  QueryInterpretation,
} from "./domain.js";
import { isQueryInterpretation } from "./domain.js";
import {
  assessLatestnessEvidence,
  compareVersions,
  extractReleaseEvidenceRecords,
} from "./version-evidence.js";
import { auditResearchCitations, OpenRouterProvider } from "./llm.js";
import { buildPlan, rewriteQueries, validateRecoveryQuery } from "./planner.js";
import {
  isOfficialSourceForEntities,
  rankResults,
  selectResearchSourcesWithDecisions,
} from "./rank.js";
import type { SearchProvider } from "./search.js";
import type { SessionStore } from "./store.js";
import { createToolRegistry, MAX_BATCH_VERIFICATION_CLAIMS, ToolRegistry } from "./agent/tools.js";
import type { SearchAttempt } from "./search.js";
import { searchDiagnosticTrace, safeSearchMessage } from "./search-diagnostics.js";
import { pMap } from "./concurrency.js";
import { isSerperSnippetSufficient, SourceRetrievalError } from "./source-retrieval.js";
import { containsExactEntity, subjectEntityMismatchReason } from "./entities.js";
import {
  querySubjectMismatchReason,
  comparisonClaimMismatchReason,
  relevantSourceContent,
  requestedSubjectNames,
} from "./query-relevance.js";
import { withOperationContext } from "./operation-context.js";
import type { CitationEntailmentReport } from "./citation-entailment.js";
import { enforceResearchChatBoundedFactCoverage } from "./research-chat-fact-gate.js";
import { reconcileLatestnessClaimDisposition } from "./research-answer.js";
import {
  extractRequestedFacts,
  classifyEvidenceStatus,
  classifyEvidenceStatusFromCoverage,
  hasCompleteRequestedFactCoverage,
  missingRequestedFactSupportFromCoverage,
  missingRequestedFactSupport as checkMissingRequestedFactSupport,
  requestedFactCoverage,
  requestedPredicatePresent,
  type RequestedFactCoverage,
  type RequestedFactKind,
  type RequestedPredicateRequirement,
} from "./requested-facts.js";
export { classifyEvidenceStatus } from "./requested-facts.js";

export const INSUFFICIENT_EVIDENCE_ERROR_PREFIX = "INSUFFICIENT_EVIDENCE:";
export const CITATION_VALIDATION_ERROR_PREFIX = "CITATION_VALIDATION_FAILED:";
export const RESEARCH_INCOMPLETE_ERROR_PREFIX = "RESEARCH_INCOMPLETE:";

export function isNonRetryableResearchFailure(error?: string): boolean {
  return Boolean(
    error?.startsWith(INSUFFICIENT_EVIDENCE_ERROR_PREFIX) ||
    error?.startsWith(CITATION_VALIDATION_ERROR_PREFIX) ||
    error?.startsWith(RESEARCH_INCOMPLETE_ERROR_PREFIX),
  );
}

type Listener = (event: ResearchEvent) => void;
type Action =
  | "web_search"
  | "source_triage"
  | "fetch_url"
  | "extract_claims"
  | "gather_evidence"
  | "verify_claims"
  | "detect_conflicts"
  | "search_again"
  | "synthesize";
export interface ResearchBudget {
  maxSteps: number;
  maxQueries: number;
  maxSources: number;
  maxPages: number;
  maxSearchPasses: number;
  maxClaimsToVerify: number;
  maxTimeMs: number;
  maxModelDecisions: number;
}

const TEST_EVALUATION_BUDGET_LIMITS: ResearchBudget = {
  maxSteps: 40,
  maxQueries: 5,
  maxSources: 5,
  maxPages: 5,
  maxSearchPasses: 4,
  maxClaimsToVerify: 6,
  maxTimeMs: 180_000,
  maxModelDecisions: 4,
};
interface LoopState {
  sessionId: string;
  jobId?: string;
  mode: ResearchMode;
  question: string;
  plan: Awaited<ReturnType<typeof buildPlan>>;
  objectives: ResearchObjective[];
  rawResults: SearchResult[];
  rankedSources: Source[];
  sourceSelectionDecisions: SourceSelectionDecision[];
  searchRecoveries: NonNullable<ResearchSession["searchRecoveries"]>;
  fetchedSources: Source[];
  claims: Claim[];
  conflicts: Conflict[];
  searched: boolean;
  triaged: boolean;
  searchPasses: number;
  fetchedUrls: Set<string>;
  claimsExtractedFor: number;
  evidenceGathered: boolean;
  verified: boolean;
  conflictsChecked: boolean;
  queriesIssued: number;
  modelDecisions: number;
  actionsExecuted: number;
  researchChatOptimization: boolean;
}

interface ResearchRunOptions {
  interpretation?: QueryInterpretation;
  researchChatOptimization?: boolean;
}

interface EvidenceAssessment {
  sufficient: boolean;
  status: ReturnType<typeof classifyEvidenceStatus>;
  reasons: string[];
  missingRequestedFacts: string[];
}

function verificationVerdict(
  value: string | undefined,
): NonNullable<Claim["verification"]>["verdict"] {
  const verdict = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (verdict === "supported") return "supported";
  if (verdict === "contradicted") return "contradicted";
  if (verdict === "uncertain") return "uncertain";
  return "unavailable";
}

export function hasCitationValidationFailure(
  previous: CitationEntailmentReport | undefined,
  current: CitationEntailmentReport | undefined,
  answer: string,
  sourceCount: number,
): boolean {
  const structuralAudit = auditResearchCitations(answer, sourceCount);
  return Boolean(
    (current && current !== previous && (current.status !== "VALIDATED" || current.failure)) ||
    structuralAudit.invalidMarkers.length > 0 ||
    structuralAudit.uncitedSentences.length > 0,
  );
}

export function hasResearchChatFinalCoverageFailure(
  researchChatOptimization: boolean,
  coverage: RequestedFactCoverage | undefined,
): boolean {
  return Boolean(
    researchChatOptimization && coverage && !hasCompleteRequestedFactCoverage(coverage),
  );
}

export function missingRequestedFactSupport(
  question: string,
  verifiedClaimTexts: string[],
  options: {
    latestnessProven?: boolean;
    latestnessVersion?: string;
    requestedFacts?: RequestedFactKind[];
    releaseEvidence?: ReleaseEvidenceRecord[];
    officialSourcesRequired?: boolean;
    requestedPredicate?: RequestedPredicateRequirement;
  } = {},
): string[] {
  return checkMissingRequestedFactSupport(question, verifiedClaimTexts, options);
}

function requestedFactsForPlan(plan: ResearchPlan): RequestedFactKind[] {
  return plan.requestedFacts ?? extractRequestedFacts(plan.interpretation.normalizedQuestion);
}

function factCoverageOptions(
  plan: ResearchPlan,
  latestnessProven?: boolean,
  releaseEvidence: ReleaseEvidenceRecord[] = [],
  latestnessVersion?: string,
): {
  latestnessProven?: boolean;
  latestnessVersion?: string;
  requestedFacts: RequestedFactKind[];
  releaseEvidence: ReleaseEvidenceRecord[];
  officialSourcesRequired: boolean;
  requestedPredicate?: RequestedPredicateRequirement;
} {
  return {
    latestnessProven,
    latestnessVersion,
    requestedFacts: requestedFactsForPlan(plan),
    releaseEvidence,
    officialSourcesRequired: plan.interpretation.sourceRequirements?.officialSources === "required",
    requestedPredicate: plan.interpretation.requestedPredicate,
  };
}

function sourceTaskEvidence(
  question: string,
  sources: Source[],
  claims: Claim[],
  requestedFacts: RequestedFactKind[],
  options: {
    releaseEvidence?: ReleaseEvidenceRecord[];
    officialSourcesRequired?: boolean;
    latestnessProven?: boolean;
    latestnessVersion?: string;
    latestnessSourceIds?: string[];
  } = {},
): Source[] {
  return sources.map((source) => {
    if (source.subjectMismatchReason) {
      return {
        ...source,
        taskEvidence: {
          status: "INSUFFICIENT_EVIDENCE",
          missingFacts: [
            source.subjectMismatchReason,
            ...missingRequestedFactSupport(question, [], { requestedFacts }),
          ],
        },
      };
    }
    const sourceClaims = claims.filter(
      (claim) => claim.verification?.verdict === "supported" && claim.sourceIds.includes(source.id),
    );
    const verifiedClaims = sourceClaims.map((claim) => `${claim.text}\n${claim.evidence}`);
    const sourceEvidenceOptions = {
      requestedFacts,
      releaseEvidence: (options.releaseEvidence ?? []).filter(
        (record) => record.sourceId === source.id,
      ),
      officialSourcesRequired: options.officialSourcesRequired,
      latestnessProven:
        options.latestnessProven && options.latestnessSourceIds?.includes(source.id),
      latestnessVersion: options.latestnessVersion,
    };
    const sourceCoverage = enforceResearchChatBoundedFactCoverage(
      requestedFactCoverage(question, verifiedClaims, sourceEvidenceOptions),
      question,
      sourceClaims,
      [source],
      options.officialSourcesRequired === true,
    );
    return {
      ...source,
      taskEvidence: {
        status: classifyEvidenceStatusFromCoverage(sourceCoverage, verifiedClaims.length > 0),
        missingFacts: missingRequestedFactSupportFromCoverage(sourceCoverage),
        presentFacts: sourceCoverage.present,
      },
    };
  });
}

function unverifiedTaskEvidence(
  question: string,
  content: string,
  requestedFacts: RequestedFactKind[],
) {
  const missingFacts = missingRequestedFactSupport(question, [content], { requestedFacts });
  return {
    status: missingFacts.length > 0 ? ("INSUFFICIENT_EVIDENCE" as const) : ("UNVERIFIED" as const),
    missingFacts,
  };
}

function classifyFetchFailure(error: unknown): NonNullable<Source["fetchFailureCategory"]> {
  const message = error instanceof Error ? error.message : String(error);
  if (/too short|challenge|login|access-denied|extracted content/i.test(message))
    return "EXTRACTION";
  if (/unsupported content type|unsupported source/i.test(message)) return "UNSUPPORTED";
  if (/HTTP \d{3}/i.test(message)) return "HTTP";
  if (/timeout|timed out|abort/i.test(message)) return "TIMEOUT";
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) return "NETWORK";
  return "UNKNOWN";
}

function verificationFocusTerms(
  dimensions: string[],
  requestedFacts: RequestedFactKind[] = [],
): string[] {
  const aliases: Record<string, string[]> = {
    performance: [
      "performance",
      "speed",
      "frame",
      "latency",
      "memory",
      "benchmark",
      "fps",
      "render",
    ],
    ecosystem: [
      "ecosystem",
      "package",
      "library",
      "plugin",
      "community",
      "integration",
      "tooling",
      "runtime",
    ],
    "developer experience": [
      "developer",
      "experience",
      "workflow",
      "learning",
      "tooling",
      "debug",
      "setup",
    ],
    "trade-offs": ["limitation", "trade-off", "tradeoff", "however", "caveat"],
  };
  const factAliases: Record<RequestedFactKind, string[]> = {
    version: ["version", "release"],
    "release date": ["release date", "released", "published", "announcement"],
    "release status": ["release status", "stable", "release channel"],
    "stable status": ["stable", "stable release", "release channel"],
    latestness: ["latest", "newest", "current version", "most recent"],
    "end-of-life date": ["end of life", "end-of-life", "EOL", "end of support", "supported until"],
    price: ["price", "pricing", "cost"],
    "technical value": ["specification", "technical", "limit", "capacity"],
  };
  return [
    ...new Set([
      ...dimensions.flatMap((dimension) => aliases[dimension.toLowerCase()] ?? [dimension]),
      ...requestedFacts.flatMap((fact) => factAliases[fact]),
    ]),
  ];
}

function requiresObjectiveCoverage(state: LoopState): boolean {
  const comparison =
    state.plan.interpretation.formatPreference === "comparison" &&
    state.plan.interpretation.dimensions.length >= 4;
  const broadDeepResearch = state.mode === "deep" && state.objectives.length >= 5;
  return comparison || broadDeepResearch;
}

const OBJECTIVE_KEYWORDS: Record<string, string[]> = {
  architecture: ["architecture", "rendering", "engine", "bridge", "aot", "feature parity"],
  performance: [
    "performance",
    "speed",
    "frame",
    "fps",
    "latency",
    "memory",
    "benchmark",
    "scalability",
  ],
  ecosystem: [
    "ecosystem",
    "developer",
    "tooling",
    "workflow",
    "learning",
    "migration",
    "package",
    "community",
    "integration",
  ],
  limitations: [
    "limitation",
    "failure",
    "trade-off",
    "tradeoff",
    "caveat",
    "risk",
    "cannot",
    "gap",
  ],
  foundation: ["foundation", "definition", "concept", "principle", "fundamental", "overview"],
  evidence: ["evidence", "empirical", "benchmark", "study", "data", "application", "measurement"],
  criticism: [
    "criticism",
    "limitation",
    "caveat",
    "conflict",
    "disagree",
    "risk",
    "trade-off",
    "tradeoff",
  ],
  best_practices: [
    "best practice",
    "recommendation",
    "recommended",
    "standard",
    "future direction",
    "industry practice",
  ],
  pricing: ["pricing", "price", "cost", "free", "plan", "billing"],
  auth: ["auth", "authentication", "authorization", "identity", "login", "sso"],
  status: ["version", "release", "latest", "current", "status"],
  release_date: ["date", "released", "published", "announcement", "changelog"],
  release_status: ["release status", "stable", "channel"],
  technical_value: ["specification", "technical", "limit", "capacity", "latency"],
  features: ["feature", "breaking change", "capability", "api"],
  documentation: ["documentation", "official", "docs", "guide"],
};

const OBJECTIVE_LABEL_STOP_WORDS = new Set([
  "core",
  "known",
  "between",
  "and",
  "for",
  "with",
  "the",
  "from",
  "into",
  "their",
  "react",
  "native",
  "flutter",
  "supabase",
  "firebase",
  "node",
  "bun",
]);

export function matchObjective(
  text: string,
  objectives: ResearchObjective[],
): ResearchObjective | undefined {
  const normalized = text.toLowerCase();
  let best: ResearchObjective | undefined;
  let bestScore = 0;
  for (const objective of objectives) {
    if (objective.requiredFacts?.length || objective.requiresOfficialSource) continue;
    const labelTerms = objective.label
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 4 && !OBJECTIVE_LABEL_STOP_WORDS.has(term));
    const terms = new Set([
      ...(OBJECTIVE_KEYWORDS[objective.category.toLowerCase()] ?? []),
      objective.category.toLowerCase(),
      ...labelTerms,
    ]);
    const score = [...terms].reduce(
      (total, term) => total + (normalized.includes(term) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = objective;
      bestScore = score;
    }
  }
  return best;
}

/** Apply the one aggregate fact result to structured objectives and retain field-level provenance. */
export function applyCanonicalFactCoverageToObjectives(
  objectives: ResearchObjective[],
  coverage: RequestedFactCoverage,
  releaseRecords: ReleaseEvidenceRecord[],
  latestnessAssessment: ResearchState["latestnessAssessment"],
  verifiedClaims: Claim[],
  sources: Source[],
  entities: string[],
): ResearchState["objectiveCoverage"] {
  const claimById = new Map(verifiedClaims.map((claim) => [claim.id, claim]));
  const officialSourceIds = new Set(
    sources
      .filter((source) => isOfficialSourceForEntities(source, entities))
      .map((source) => source.id),
  );
  const targetVersion =
    latestnessAssessment?.latestVersion ?? latestnessAssessment?.highestCandidateVersion;
  const targetRecords = targetVersion
    ? releaseRecords.filter((record) => record.version === targetVersion)
    : releaseRecords;

  for (const objective of objectives) {
    if (!objective.requiredFacts?.length && !objective.requiresOfficialSource) continue;

    const requiredFacts = objective.requiredFacts ?? [];
    const presentFacts = requiredFacts.filter((fact) => coverage.present.includes(fact));
    const missingFacts = requiredFacts.filter((fact) => !presentFacts.includes(fact));
    const evidenceIds = new Set<string>();
    const sourceIds = new Set<string>();
    const claimIds = new Set<string>();

    for (const fact of presentFacts) {
      if (fact === "latestness") {
        for (const sourceId of latestnessAssessment?.supportingSourceIds ?? []) {
          sourceIds.add(sourceId);
        }
        for (const record of targetRecords) {
          for (const claimId of record.latestnessClaimIds ?? []) claimIds.add(claimId);
          for (const evidenceId of record.evidenceIds ?? []) evidenceIds.add(evidenceId);
        }
        continue;
      }

      const factRecords = targetRecords.filter((record) => {
        if (fact === "version") return Boolean(record.version);
        if (fact === "release date")
          return Boolean(
            record.releaseDate &&
            record.releaseDateClaimIds?.length &&
            !record.releaseDateConflicts?.length,
          );
        if (fact === "stable status") return record.stability === "stable";
        if (fact === "release status") return record.stability !== "unknown";
        return false;
      });
      for (const record of factRecords) {
        const fieldSources =
          fact === "version"
            ? (record.versionSourceIds ?? record.sourceIds ?? [record.sourceId])
            : fact === "release date"
              ? (record.releaseDateSourceIds ?? [])
              : (record.stabilitySourceIds ?? []);
        const fieldClaims =
          fact === "version"
            ? (record.versionClaimIds ?? record.claimIds)
            : fact === "release date"
              ? (record.releaseDateClaimIds ?? [])
              : (record.stabilityClaimIds ?? record.claimIds);
        for (const sourceId of fieldSources) sourceIds.add(sourceId);
        for (const claimId of fieldClaims) claimIds.add(claimId);
        const fieldEvidenceIds =
          fact === "version"
            ? (record.versionClaimIds ?? record.claimIds)
            : fact === "release date"
              ? (record.releaseDateEvidenceIds ?? [])
              : (record.stabilityEvidenceIds ?? record.claimIds);
        for (const evidenceId of fieldEvidenceIds) evidenceIds.add(evidenceId);
      }
    }

    if (objective.requiresOfficialSource) {
      for (const claim of verifiedClaims) {
        const linkedOfficialSource = claim.sourceIds.find((sourceId) =>
          officialSourceIds.has(sourceId),
        );
        if (!linkedOfficialSource) continue;
        sourceIds.add(linkedOfficialSource);
        claimIds.add(claim.id);
        evidenceIds.add(claim.id);
      }
      for (const record of releaseRecords.filter((candidate) => candidate.officialSource)) {
        for (const sourceId of record.sourceIds ?? [record.sourceId]) sourceIds.add(sourceId);
      }
      objective.officialSourceSatisfied = [...sourceIds].some((sourceId) =>
        officialSourceIds.has(sourceId),
      );
    }

    const dependencies = (objective.dependsOn ?? [])
      .map((id) => objectives.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is ResearchObjective => Boolean(candidate));
    const dependenciesSatisfied = dependencies.every(
      (dependency) => dependency.status === "fulfilled",
    );
    const hasRequiredFacts = missingFacts.length === 0;
    const officialRequirementSatisfied =
      !objective.requiresOfficialSource || objective.officialSourceSatisfied === true;
    const total =
      requiredFacts.length + dependencies.length + (objective.requiresOfficialSource ? 1 : 0);
    const satisfied =
      presentFacts.length +
      dependencies.filter((dependency) => dependency.status === "fulfilled").length +
      (officialRequirementSatisfied && objective.requiresOfficialSource ? 1 : 0);
    objective.coverage = total === 0 ? 0 : Number((satisfied / total).toFixed(3));
    objective.presentFacts = presentFacts;
    objective.missingFacts = missingFacts;
    objective.evidenceIds = [...evidenceIds];
    objective.sourceIds = [...sourceIds];
    objective.status =
      hasRequiredFacts && dependenciesSatisfied && officialRequirementSatisfied
        ? "fulfilled"
        : presentFacts.length > 0 || sourceIds.size > 0
          ? "partial"
          : "pending";
    const findingClaim = [...claimIds].map((id) => claimById.get(id)).find(Boolean);
    objective.keyFinding = findingClaim?.text ?? objective.keyFinding;
  }

  return objectives.map((objective) => ({
    objectiveId: objective.id,
    status: objective.status,
    requiredFacts: objective.requiredFacts ?? [],
    presentFacts: objective.presentFacts ?? [],
    missingFacts: objective.missingFacts ?? [],
    sourceIds: [...objective.sourceIds],
    claimIds: [...new Set(objective.evidenceIds.filter((id) => claimById.has(id)))],
    officialSourceSatisfied: objective.officialSourceSatisfied,
  }));
}

export function selectVerificationClaims(
  claims: Claim[],
  limit: number,
  focusTerms: string[] = [],
  requestedFacts: RequestedFactKind[] = [],
): Claim[] {
  const importance = { critical: 4, high: 3, medium: 2, low: 1 };
  const releaseFactKinds = new Set<RequestedFactKind>([
    "version",
    "release date",
    "release status",
    "stable status",
    "latestness",
  ]);
  const focusedLifecycleFacts = new Set(
    requestedFacts.filter((fact) => fact === "end-of-life date"),
  );
  const requiredReleaseFacts = new Set(requestedFacts.filter((fact) => releaseFactKinds.has(fact)));
  const requiredTargetFacts = new Set([...requiredReleaseFacts, ...focusedLifecycleFacts]);
  const relevance = (claim: Claim) => {
    const text = claim.text.toLowerCase();
    return focusTerms.reduce(
      (score, term) => score + (text.includes(term.toLowerCase()) ? 1 : 0),
      0,
    );
  };
  const groups = new Map<string, Claim[]>();
  const pendingClaims = claims.filter((item) => {
    if (item.verification) return false;
    if (requiredTargetFacts.size === 0) return true;
    return Boolean(item.requestedFacts?.some((fact) => requiredTargetFacts.has(fact)));
  });
  for (const claim of pendingClaims) {
    const sourceId = claim.sourceIds[0] ?? claim.id;
    const group = groups.get(sourceId) ?? [];
    group.push(claim);
    groups.set(sourceId, group);
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        releaseFactPriority(b, requiredReleaseFacts) -
          releaseFactPriority(a, requiredReleaseFacts) ||
        importance[b.importance ?? "medium"] - importance[a.importance ?? "medium"] ||
        relevance(b) - relevance(a),
    );
  }
  const selected: Claim[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const claim = group.shift();
      if (claim) {
        selected.push(claim);
        added = true;
        if (selected.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

function releaseFactPriority(claim: Claim, requested: Set<RequestedFactKind>): number {
  const priority: Partial<Record<RequestedFactKind, number>> = {
    latestness: 5,
    "stable status": 4,
    "release status": 3,
    "release date": 2,
    version: 1,
    "end-of-life date": 6,
  };
  return (claim.requestedFacts ?? []).reduce(
    (score, fact) => (requested.has(fact) ? Math.max(score, priority[fact] ?? 0) : score),
    0,
  );
}

export function researchBudgetFor(
  mode: ResearchMode,
  overrides: Partial<ResearchBudget> = {},
  evaluationBudgetCeilings?: Partial<ResearchBudget>,
): ResearchBudget {
  if (evaluationBudgetCeilings && config.NODE_ENV !== "test") {
    throw new Error("Extended research budgets are available only in test/evaluation mode");
  }
  const deep = mode === "deep";
  const defaults: ResearchBudget = {
    maxSteps: Math.min(config.MAX_RESEARCH_STEPS, deep ? 24 : 14),
    maxQueries: Math.min(config.MAX_SEARCH_QUERIES, deep ? 8 : 4),
    maxSources: Math.min(config.MAX_SOURCES, deep ? 12 : 6),
    maxPages: Math.min(config.MAX_PAGES, deep ? 6 : 4),
    // Search passes count bounded recovery searches after the initial query.
    maxSearchPasses: deep ? 2 : 1,
    maxClaimsToVerify: deep ? 6 : 3,
    maxTimeMs: config.MAX_RESEARCH_TIME_MS,
    maxModelDecisions: config.MAX_MODEL_DECISIONS,
  };
  const testCeiling = (key: keyof ResearchBudget) =>
    Math.min(
      TEST_EVALUATION_BUDGET_LIMITS[key],
      Math.max(0, Math.floor(evaluationBudgetCeilings?.[key] ?? defaults[key])),
    );
  const ceilings: ResearchBudget = evaluationBudgetCeilings
    ? {
        maxSteps: testCeiling("maxSteps"),
        maxQueries: testCeiling("maxQueries"),
        maxSources: testCeiling("maxSources"),
        maxPages: testCeiling("maxPages"),
        maxSearchPasses: testCeiling("maxSearchPasses"),
        maxClaimsToVerify: testCeiling("maxClaimsToVerify"),
        maxTimeMs: testCeiling("maxTimeMs"),
        maxModelDecisions: testCeiling("maxModelDecisions"),
      }
    : defaults;
  const maxSearchPassCeiling = evaluationBudgetCeilings ? ceilings.maxSearchPasses : 2;
  return {
    maxSteps: Math.min(ceilings.maxSteps, overrides.maxSteps ?? ceilings.maxSteps),
    maxQueries: Math.min(ceilings.maxQueries, overrides.maxQueries ?? ceilings.maxQueries),
    maxSources: Math.min(ceilings.maxSources, overrides.maxSources ?? ceilings.maxSources),
    maxPages: Math.min(ceilings.maxPages, overrides.maxPages ?? ceilings.maxPages),
    // Quick mode defaults to one recovery pass. Explicit bounded harnesses may
    // raise this only through the test-only bounded evaluator ceiling. The
    // independent maxQueries ceiling still controls total provider searches.
    maxSearchPasses: Math.min(
      maxSearchPassCeiling,
      Math.max(0, Math.floor(overrides.maxSearchPasses ?? defaults.maxSearchPasses)),
    ),
    maxClaimsToVerify: Math.min(
      ceilings.maxClaimsToVerify,
      overrides.maxClaimsToVerify ?? ceilings.maxClaimsToVerify,
    ),
    maxTimeMs: Math.min(ceilings.maxTimeMs, overrides.maxTimeMs ?? ceilings.maxTimeMs),
    maxModelDecisions: Math.min(
      ceilings.maxModelDecisions,
      overrides.maxModelDecisions ?? ceilings.maxModelDecisions,
    ),
  };
}

export function initialSearchQueryLimit(
  maxQueries: number,
  maxSearchPasses: number,
  needsObjectiveCoverage: boolean,
  adaptiveEvidenceLoop = false,
): number {
  const queryCeiling = Math.max(0, Math.floor(maxQueries));
  if (queryCeiling === 0) return 0;

  if (adaptiveEvidenceLoop) {
    // Start with one search, then inspect its results before spending more of
    // the query ceiling. Recovery queries are generated from the evidence gap.
    return 1;
  }

  // Preserve the legacy allocation for callers such as the Post Agent.
  const configuredRecoveryPasses = Math.max(0, Math.floor(maxSearchPasses));
  const recoveryReserve = Math.min(
    queryCeiling - 1,
    Math.max(configuredRecoveryPasses, needsObjectiveCoverage ? 2 : 1),
  );
  return Math.max(1, queryCeiling - recoveryReserve);
}

function statusFor(action: Action): ResearchSession["status"] {
  if (action === "web_search" || action === "search_again") return "SEARCHING";
  if (action === "fetch_url") return "FETCHING";
  if (action === "synthesize") return "SYNTHESIZING";
  return "ANALYZING";
}
function labelFor(action: Action) {
  return {
    web_search: "🔎 web_search",
    source_triage: "🧭 source_triage",
    fetch_url: "📄 fetch_url + extract_content",
    extract_claims: "🧠 extract_claims",
    gather_evidence: "🔗 gather_evidence",
    verify_claims: "✅ verify_claim",
    detect_conflicts: "⚖️ detect_conflict",
    search_again: "🔄 search_again",
    synthesize: "✍️ synthesize",
  }[action];
}

export class ResearchRunner {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly snippetEvidencePolicy = new Map<string, boolean>();
  private readonly memoryContexts = new Map<string, string>();
  private readonly conversationContexts = new Map<string, string>();
  private readonly registry: ToolRegistry;
  constructor(
    private readonly store: SessionStore,
    private readonly search: SearchProvider,
    private readonly llm = new OpenRouterProvider(),
    registry?: ToolRegistry,
    private readonly budgetOverrides: Partial<ResearchBudget> = {},
    private readonly evaluationBudgetCeilings?: Partial<ResearchBudget>,
    private readonly adaptiveEvidenceLoop = false,
    private readonly synthesisProvider = llm,
  ) {
    if (evaluationBudgetCeilings && config.NODE_ENV !== "test") {
      throw new Error("Extended research budgets are available only in test/evaluation mode");
    }
    this.registry = registry ?? createToolRegistry(search, llm);
  }
  subscribe(id: string, listener: Listener): () => void {
    const bucket = this.listeners.get(id) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(id, bucket);
    return () => bucket.delete(listener);
  }
  private emit(id: string, event: ResearchEvent) {
    this.listeners.get(id)?.forEach((listener) => listener(event));
  }
  async start(
    question: string,
    mode: ResearchMode,
    seedResults: SearchResult[] = [],
    options: {
      allowSnippetEvidence?: boolean;
      memoryContext?: string;
      conversationContext?: string;
      interpretation?: QueryInterpretation;
      researchChatOptimization?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ResearchSession> {
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: randomUUID(),
      question,
      mode,
      status: "QUEUED",
      executionJobId: currentWorkerContext()?.lease.job.id,
      executionLeaseGeneration: currentWorkerContext()?.lease.generation,
      seedResults: seedResults.slice(0, 3),
      createdAt: now,
      updatedAt: now,
      sources: [],
      claims: [],
      conflicts: [],
      decisions: [],
      steps: [],
    };
    await this.store.create(session);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });
    this.activeControllers.set(session.id, controller);
    this.snippetEvidencePolicy.set(session.id, options.allowSnippetEvidence ?? true);
    if (options.memoryContext) this.memoryContexts.set(session.id, options.memoryContext);
    if (options.conversationContext)
      this.conversationContexts.set(session.id, options.conversationContext);
    void this.run(session.id, controller, options)
      .finally(() => options.signal?.removeEventListener("abort", abortFromParent))
      .catch(() => undefined);
    return session;
  }
  async runQueued(
    id: string,
    question: string,
    mode: ResearchMode,
    seedResults: SearchResult[] = [],
    options: {
      allowSnippetEvidence?: boolean;
      memoryContext?: string;
      conversationContext?: string;
      resume?: boolean;
      signal?: AbortSignal;
      interpretation?: QueryInterpretation;
      researchChatOptimization?: boolean;
    } = {},
  ): Promise<ResearchSession | undefined> {
    const current = await this.store.get(id);
    if (current && current.question !== question && !options.resume) {
      throw new Error("Research session belongs to a different request");
    }
    if (current?.status === "CANCELLED") return current;
    if (
      current?.status === "COMPLETED" ||
      (current?.status === "NEEDS_CLARIFICATION" && !options.resume)
    ) {
      return current;
    }

    const now = new Date().toISOString();
    const session: ResearchSession = current
      ? {
          ...current,
          question,
          mode,
          status: "QUEUED",
          updatedAt: now,
          seedResults: seedResults.slice(0, 3),
          plan: undefined,
          sources: [],
          claims: [],
          conflicts: [],
          decisions: [],
          state: undefined,
          coverage: undefined,
          answer: undefined,
          error: undefined,
          stageTimings: undefined,
          searchAttempts: undefined,
          sourceSelectionDecisions: [],
          searchRecoveries: [],
        }
      : {
          id,
          question,
          mode,
          status: "QUEUED",
          seedResults: seedResults.slice(0, 3),
          createdAt: now,
          updatedAt: now,
          sources: [],
          claims: [],
          conflicts: [],
          decisions: [],
          sourceSelectionDecisions: [],
          searchRecoveries: [],
          steps: [],
        };
    const worker = currentWorkerContext();
    if (worker) {
      session.executionJobId = worker.lease.job.id;
      session.executionLeaseGeneration = worker.lease.generation;
    }
    if (current) await this.store.update(session);
    else await this.store.create(session);

    if (
      options.signal?.aborted &&
      options.signal.reason instanceof Error &&
      options.signal.reason.message === "Job cancellation requested"
    ) {
      const cancelled = {
        ...session,
        status: "CANCELLED" as const,
        error: "Research cancelled by user",
      };
      await this.store.update(cancelled);
      return cancelled;
    }

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });
    this.activeControllers.set(id, controller);
    this.snippetEvidencePolicy.set(id, options.allowSnippetEvidence ?? true);
    if (options.memoryContext) this.memoryContexts.set(id, options.memoryContext);
    if (options.conversationContext) this.conversationContexts.set(id, options.conversationContext);
    try {
      await this.run(id, controller, {
        interpretation:
          !options.resume && isQueryInterpretation(options.interpretation)
            ? options.interpretation
            : undefined,
        researchChatOptimization: options.researchChatOptimization === true,
      });
    } finally {
      options.signal?.removeEventListener("abort", abortFromParent);
    }
    return this.store.get(id);
  }
  async resume(id: string, clarification: string): Promise<ResearchSession | undefined> {
    const current = await this.store.get(id);
    if (!current || current.status !== "NEEDS_CLARIFICATION") return current;
    const next = await this.update(id, {
      question: `${current.question}\nClarification: ${clarification.trim()}`,
      status: "QUEUED",
      plan: undefined,
      sources: [],
      claims: [],
      conflicts: [],
      decisions: [],
      sourceSelectionDecisions: [],
      searchRecoveries: [],
      answer: undefined,
      error: undefined,
      steps: [],
    });
    if (next) {
      this.activeControllers.set(id, new AbortController());
      void this.run(id);
    }
    return next;
  }
  async cancel(id: string): Promise<ResearchSession | undefined> {
    const current = await this.store.get(id);
    if (!current || ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return current;
    this.activeControllers.get(id)?.abort(new Error("Research session cancelled"));
    const next = await this.update(id, {
      status: "CANCELLED",
      error: "Research session cancelled by user",
    });
    if (next) {
      await this.step(id, "⏹️ cancel_session", "complete", "Research session cancelled by user");
      this.emit(id, {
        type: "research.cancelled",
        message: "Research session cancelled by user",
        session: next,
      });
    }
    return next;
  }
  private async update(id: string, patch: Partial<ResearchSession>) {
    const current = await this.store.get(id);
    if (!current) return;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return current;
    const terminalPatch = ["COMPLETED", "FAILED", "CANCELLED"].includes(patch.status ?? "");
    const execution = getResearchExecutionContext();
    const deadlineReached = execution !== undefined && Date.now() >= execution.deadlineAt;
    if (
      (execution?.signal.aborted || deadlineReached) &&
      (!terminalPatch || patch.status === "COMPLETED")
    )
      return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const contextualTimings = researchStageTimingsSnapshot();
    if (contextualTimings) {
      next.stageTimings = {
        ...(current.stageTimings ?? {}),
        ...(patch.stageTimings ?? {}),
        ...contextualTimings,
      };
    }
    if ((execution?.signal.aborted || deadlineReached) && terminalPatch) {
      await this.store.update(next);
    } else {
      if (execution?.signal.aborted) return;
      await runResearchStage("persistence", () => this.store.update(next));
    }
    return next;
  }
  private async step(
    id: string,
    label: string,
    status: ResearchStep["status"],
    detail?: string,
    durationMs?: number,
  ) {
    const current = await this.store.get(id);
    if (!current) return;
    const item: ResearchStep = {
      id: randomUUID(),
      label,
      status,
      detail,
      at: new Date().toISOString(),
      durationMs,
    };
    const next = await this.update(id, { steps: [...current.steps, item] });
    if (!next) return;
    this.emit(id, { type: "research.step", message: detail ?? label, step: item });
    return next;
  }
  private async recordDecision(id: string, decision: Omit<ResearchDecision, "id" | "at">) {
    const current = await this.store.get(id);
    if (!current) return;
    const item: ResearchDecision = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...decision,
    };
    await this.update(id, { decisions: [...(current.decisions ?? []), item] });
    await this.step(
      id,
      "🤔 decide_next_action",
      "complete",
      `${decision.controllerDecision}: ${decision.nextAction} — ${decision.reason}`,
    );
  }
  private async useTool<T>(id: string, action: Action, input: unknown): Promise<T> {
    const label = labelFor(action);
    const start = performance.now();
    await this.step(id, label, "running");
    try {
      const result = (await this.registry.execute(
        action === "source_triage"
          ? "compare_sources"
          : action === "extract_claims"
            ? "extract_claims"
            : action === "verify_claims"
              ? "verify_claims_batch"
              : action === "detect_conflicts"
                ? "detect_conflict"
                : action,
        input,
      )) as T;
      const dur = Math.round(performance.now() - start);
      await this.step(id, label, "complete", undefined, dur);
      return result;
    } catch (error) {
      const dur = Math.round(performance.now() - start);
      await this.step(
        id,
        label,
        "failed",
        error instanceof Error ? error.message : "Tool execution failed",
        dur,
      );
      throw error;
    }
  }
  private async searchBatch(queries: string[]): Promise<SearchResult[]> {
    return this.registry.execute("web_search", { queries }) as Promise<SearchResult[]>;
  }

  private async searchWithTrace(
    id: string,
    action: "web_search" | "search_again",
    queries: string[],
  ) {
    const attempts: SearchAttempt[] = [];
    try {
      return await this.useTool<SearchResult[]>(id, action, {
        queries,
        onSearchAttempt: (attempt: SearchAttempt) => attempts.push(attempt),
      });
    } finally {
      if (attempts.length) {
        const session = await this.store.get(id);
        if (session) {
          await this.update(id, {
            searchAttempts: searchDiagnosticTrace([
              ...((session.searchAttempts ?? []) as SearchAttempt[]),
              ...attempts,
            ]),
          });
        }
      }
    }
  }
  private pendingSource(state: LoopState, budget: ResearchBudget) {
    const candidates = state.rankedSources.filter(
      (source) => !state.fetchedUrls.has(source.url) && !source.fetchError,
    );
    if (this.pagesUsed(state) < this.pageLimitForPass(state, budget)) return candidates[0];
    if (!state.researchChatOptimization) return undefined;
    return candidates.find((source) => this.isSnippetSufficientForState(state, source));
  }

  private pageRetrievalCount(state: LoopState): number {
    const pageUrls = state.fetchedSources
      .filter((source) => {
        const attempts = source.retrievalAttempts;
        if (attempts?.length) return attempts.some((method) => method !== "serper_snippet");
        return source.retrievalMethod !== "serper_snippet";
      })
      .map((source) => source.url);
    return new Set(pageUrls).size;
  }

  private pagesUsed(state: LoopState): number {
    return state.researchChatOptimization
      ? this.pageRetrievalCount(state)
      : Math.max(state.fetchedSources.length, state.fetchedUrls.size);
  }

  private isFocusedLifecycleLookup(state: LoopState): boolean {
    const requestedFacts = requestedFactsForPlan(state.plan);
    return (
      state.researchChatOptimization &&
      requestedFacts.length === 1 &&
      requestedFacts[0] === "end-of-life date" &&
      state.plan.interpretation.entities.length === 1 &&
      !state.plan.interpretation.needsClarification
    );
  }

  private hasUnresolvedRequestedPredicate(state: LoopState): boolean {
    const requirement = state.plan.interpretation.requestedPredicate;
    if (!state.researchChatOptimization || !requirement || state.plan.interpretation.comparison)
      return false;
    return (
      this.computeResearchState(state).requestedFactCoverage?.requestedPredicate?.present !== true
    );
  }

  private pageLimitForPass(state: LoopState, budget: ResearchBudget): number {
    if (state.searchPasses > 0 || budget.maxSearchPasses === 0) return budget.maxPages;
    if (
      this.hasUnresolvedRequestedPredicate(state) &&
      budget.maxPages >= 2 &&
      this.canSearchAgain(state, budget)
    )
      return budget.maxPages - 1;
    if (
      state.researchChatOptimization &&
      state.mode === "quick" &&
      state.plan.interpretation.comparison &&
      budget.maxPages >= 2 &&
      this.canSearchAgain(state, budget)
    )
      return budget.maxPages - 1;
    // Reserve a bounded second pass for research modes with enough page budget.
    // A two-page budget cannot be split without making the first evidence check too weak.
    return budget.maxPages > 2
      ? Math.min(budget.maxPages - 1, state.mode === "deep" ? 3 : 2)
      : budget.maxPages;
  }

  private adaptiveInitialFetchCount(state: LoopState, remainingSlots: number): number {
    if (!this.adaptiveEvidenceLoop || state.fetchedSources.length > 0 || state.searchPasses > 0) {
      return Math.min(1, remainingSlots);
    }

    const requestedFacts = requestedFactsForPlan(state.plan);
    if (this.isFocusedLifecycleLookup(state)) return Math.min(1, remainingSlots);
    if (
      state.researchChatOptimization &&
      state.mode === "quick" &&
      state.plan.interpretation.comparison
    )
      return Math.min(1, remainingSlots);
    const needsIndependentEvidence =
      state.mode === "deep" ||
      state.plan.interpretation.entities.length >= 2 ||
      requestedFacts.includes("latestness");
    return Math.min(needsIndependentEvidence ? 2 : 1, remainingSlots);
  }

  private taskEligibleClaims(state: LoopState): Claim[] {
    const sourceIds = new Set(
      state.fetchedSources
        .filter((source) => !source.subjectMismatchReason)
        .map((source) => source.id),
    );
    const currentClaims = state.claims.filter(
      (claim) =>
        claim.provenance?.sessionId === state.sessionId &&
        claim.provenance.question === state.question &&
        claim.provenance.jobId === state.jobId &&
        claim.sourceIds.length > 0 &&
        claim.sourceIds.every((sourceId) => sourceIds.has(sourceId)),
    );
    if (state.plan.interpretation.sourceRequirements?.officialSources !== "required") {
      return currentClaims;
    }

    const eligibleOfficialSourceIds = new Set(
      state.fetchedSources
        .filter(
          (source) =>
            source.content &&
            !source.subjectMismatchReason &&
            isOfficialSourceForEntities(source, state.plan.interpretation.entities),
        )
        .map((source) => source.id),
    );

    return currentClaims.filter((claim) =>
      claim.sourceIds.some((sourceId) => eligibleOfficialSourceIds.has(sourceId)),
    );
  }

  private synthesisClaims(state: LoopState): Claim[] {
    const eligibleClaims = this.taskEligibleClaims(state);
    return state.researchChatOptimization
      ? eligibleClaims.filter((claim) => claim.verification?.verdict === "supported")
      : eligibleClaims;
  }

  private computeResearchState(state: LoopState): ResearchState {
    const objectives: ResearchObjective[] = (state.objectives || []).map((obj) => ({
      ...obj,
      evidenceIds: [...obj.evidenceIds],
      sourceIds: [...obj.sourceIds],
    }));
    const eligibleClaims = this.taskEligibleClaims(state);

    // Fact-driven objectives are completed from canonical fact coverage below;
    // lexical matching is reserved for open-ended research objectives.
    for (const claim of eligibleClaims) {
      const claimText = `${claim.text} ${claim.evidence || ""}`.toLowerCase();
      const matched = matchObjective(claimText, objectives);

      if (matched) {
        claim.objectiveId = matched.id;
        claim.importance = matched.importance;
        if (!matched.evidenceIds.includes(claim.id)) {
          matched.evidenceIds.push(claim.id);
        }
        for (const sId of claim.sourceIds) {
          if (!matched.sourceIds.includes(sId)) {
            matched.sourceIds.push(sId);
          }
        }
      } else {
        claim.importance = claim.importance || "medium";
      }
    }

    // Evaluate each objective's fulfillment status
    for (const obj of objectives) {
      if (obj.requiredFacts?.length || obj.requiresOfficialSource) continue;
      const matchingClaims = eligibleClaims.filter((c) => c.objectiveId === obj.id);
      const supported = matchingClaims.filter((c) => c.verification?.verdict === "supported");
      const contradicted = matchingClaims.filter((c) => c.verification?.verdict === "contradicted");

      if (supported.length > 0) {
        obj.status = "fulfilled";
        obj.coverage = 1.0;
        obj.keyFinding = supported[0].text;
      } else if (contradicted.length > 0 && supported.length === 0) {
        obj.status = "blocked";
        obj.coverage = 0.2;
      } else if (matchingClaims.length > 0) {
        obj.status = "partial";
        obj.coverage = 0.5;
      } else {
        obj.status = "pending";
        obj.coverage = 0.0;
      }
    }

    const requestedFacts = requestedFactsForPlan(state.plan);
    const officialSourcesRequired =
      state.plan.interpretation.sourceRequirements?.officialSources === "required";
    const releaseEvidenceInput = {
      question: state.question,
      entities: state.plan.interpretation.entities,
      claims: eligibleClaims,
      sources: state.fetchedSources,
      officialSourcesRequired,
      stableRequired: requestedFacts.includes("stable status"),
      releaseDateRequired: requestedFacts.includes("release date"),
    };
    const releaseRecords = extractReleaseEvidenceRecords(releaseEvidenceInput);
    const latestnessAssessment = requestedFacts.includes("latestness")
      ? assessLatestnessEvidence({
          ...releaseEvidenceInput,
          releaseRecords,
        })
      : undefined;
    state.claims = reconcileLatestnessClaimDisposition(
      state.claims,
      requestedFacts.includes("latestness"),
      latestnessAssessment,
    );
    const currentEligibleClaims = this.taskEligibleClaims(state);
    const verifiedClaims = currentEligibleClaims.filter(
      (claim) => claim.verification?.verdict === "supported",
    );
    const verifiedClaimTexts = verifiedClaims.map((claim) => `${claim.text}\n${claim.evidence}`);
    const latestnessProven = latestnessAssessment?.conclusion === "PROVEN";
    const coverageOptions = factCoverageOptions(
      state.plan,
      latestnessProven,
      releaseRecords,
      latestnessAssessment?.latestVersion ?? latestnessAssessment?.highestCandidateVersion,
    );
    // This is the sole aggregate requested-fact computation for the research
    // state. Controller sufficiency, objective completion, and recovery all
    // consume this exact value.
    const verifiedFactCoverage = enforceResearchChatBoundedFactCoverage(
      requestedFactCoverage(state.question, verifiedClaimTexts, coverageOptions),
      state.question,
      verifiedClaims,
      state.fetchedSources,
      officialSourcesRequired,
    );
    if (
      state.researchChatOptimization &&
      requestedFacts.includes("price") &&
      state.plan.interpretation.formatPreference === "comparison"
    ) {
      const subjects = [
        ...new Set([
          ...state.plan.interpretation.entities,
          ...requestedSubjectNames(state.question),
        ]),
      ];
      const missingPriceSubject =
        subjects.length >= 2 &&
        subjects.some(
          (subject) =>
            !verifiedClaims.some(
              (claim) =>
                containsExactEntity(claim.text, subject) &&
                requestedFactCoverage(state.question, claim.text, {
                  requestedFacts: ["price"],
                }).present.includes("price"),
            ),
        );
      if (missingPriceSubject) {
        verifiedFactCoverage.present = verifiedFactCoverage.present.filter(
          (fact) => fact !== "price",
        );
        if (!verifiedFactCoverage.missing.includes("price"))
          verifiedFactCoverage.missing.push("price");
      }
    }
    const objectiveCoverage = applyCanonicalFactCoverageToObjectives(
      objectives,
      verifiedFactCoverage,
      releaseRecords,
      latestnessAssessment,
      verifiedClaims,
      state.fetchedSources,
      state.plan.interpretation.entities,
    );

    const comparison =
      state.researchChatOptimization && state.plan.interpretation.comparison
        ? comparisonCoverage(state.plan.interpretation.comparison, verifiedClaims)
        : undefined;
    if (comparison) {
      for (const objective of objectives) {
        const cells = comparison.cells.filter((cell) => cell.dimension === objective.category);
        const covered = cells.filter((cell) => cell.claimIds.length > 0);
        objective.coverage = cells.length ? covered.length / cells.length : 0;
        objective.status =
          objective.coverage === 1 ? "fulfilled" : objective.coverage > 0 ? "partial" : "pending";
        objective.evidenceIds = [...new Set(covered.flatMap((cell) => cell.claimIds))];
        objective.sourceIds = [...new Set(covered.flatMap((cell) => cell.sourceIds))];
        const canonicalObjective = objectiveCoverage?.find(
          (entry) => entry.objectiveId === objective.id,
        );
        if (canonicalObjective) {
          canonicalObjective.status = objective.status;
          canonicalObjective.claimIds = [...objective.evidenceIds];
          canonicalObjective.sourceIds = [...objective.sourceIds];
        }
      }
    }
    const weights: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0.5 };
    let totalWeight = 0;
    let weightedScore = 0;
    for (const obj of objectives) {
      const weight = weights[obj.importance] || 1;
      totalWeight += weight;
      weightedScore += obj.coverage * weight;
    }
    const coverage = totalWeight > 0 ? Number((weightedScore / totalWeight).toFixed(3)) : 0;
    const completedObjectives = objectives
      .filter((objective) => objective.status === "fulfilled")
      .map((objective) => objective.label);
    const missingObjectives = objectives
      .filter((objective) => objective.status !== "fulfilled")
      .map((objective) => objective.label);

    return {
      objectives,
      comparisonCoverage: comparison,
      comparisonOutcome: comparison
        ? comparison.sufficient
          ? "sufficient"
          : state.fetchedSources.some((source) => source.content && !source.subjectMismatchReason)
            ? "relevant_but_insufficient"
            : "no_relevant_evidence"
        : undefined,
      ...(state.researchChatOptimization
        ? {
            providerMetrics: this.registry.providerMetrics?.() ?? {
              planner: this.llm.metrics,
              writer: this.synthesisProvider.metrics,
            },
          }
        : {}),
      completedObjectives,
      missingObjectives,
      queries: state.plan.queries,
      sources: state.fetchedSources.length > 0 ? state.fetchedSources : state.rankedSources,
      claims: state.claims,
      conflicts: state.conflicts,
      verifiedClaims,
      coverage,
      evidenceStatus:
        comparison && !comparison.sufficient
          ? "INSUFFICIENT_EVIDENCE"
          : classifyEvidenceStatusFromCoverage(verifiedFactCoverage, verifiedClaims.length > 0),
      requestedFactCoverage: verifiedFactCoverage,
      objectiveCoverage,
      missingRequestedFacts: missingRequestedFactSupportFromCoverage(verifiedFactCoverage),
      latestnessAssessment,
      releaseRecords,
      nextBestAction: latestnessAssessment?.unresolvedState
        ? `Retrieve additional official release-history evidence to resolve latestness: ${latestnessAssessment.unresolvedState.reason}`
        : missingObjectives.length > 0
          ? `Investigate missing objective: ${missingObjectives[0]}`
          : "Synthesize research evidence",
    };
  }

  private assessEvidence(state: LoopState): EvidenceAssessment {
    const eligibleClaims = this.taskEligibleClaims(state);
    const supportedClaims = eligibleClaims.filter(
      (claim) => claim.verification?.verdict === "supported",
    );
    const researchState = this.computeResearchState(state);
    const canonicalCoverage = researchState.requestedFactCoverage ?? {
      required: [],
      present: [],
      missing: [],
    };
    const missingRequestedFacts = missingRequestedFactSupportFromCoverage(canonicalCoverage);
    const supported = supportedClaims.length;
    const sourceDomains = new Map(state.fetchedSources.map((source) => [source.id, source.domain]));
    const independentDomains = new Set(
      supportedClaims.flatMap((claim) =>
        claim.sourceIds.map((id) => sourceDomains.get(id)).filter(Boolean),
      ),
    );
    const compactLookup =
      this.isFocusedLifecycleLookup(state) ||
      (state.mode === "quick" &&
        state.plan.interpretation.formatPreference === "lookup" &&
        state.plan.interpretation.entities.length <= 1 &&
        state.plan.interpretation.dimensions.length <= 2);
    const minimumClaims =
      (state.mode === "quick" && researchState.comparisonCoverage?.sufficient) || compactLookup
        ? 1
        : state.plan.interpretation.dimensions.length > 4
          ? 4
          : 2;
    const reasons: string[] = [];
    if (researchState.comparisonCoverage && !researchState.comparisonCoverage.sufficient) {
      reasons.push(
        `${researchState.comparisonOutcome === "no_relevant_evidence" ? "No relevant comparison evidence" : "Relevant but insufficient comparison evidence"}: ${researchState.comparisonCoverage.missing.map((gap) => `${gap.target}: ${gap.dimension}`).join(", ")}`,
      );
    }
    const objectiveCoverage = researchState.coverage;
    reasons.push(...missingRequestedFactSupportFromCoverage(canonicalCoverage));
    if (researchState.latestnessAssessment?.unresolvedState) {
      reasons.push(
        `latestness remains unresolved (${researchState.latestnessAssessment.unresolvedState.reason})`,
      );
    }

    if (
      state.plan.interpretation.sourceRequirements?.officialSources === "required" &&
      supportedClaims.length === 0
    ) {
      reasons.push(
        "no verified claim is supported by a fetched official source for the requested entity",
      );
    }

    if (state.rankedSources.length === 0) reasons.push("no relevant sources passed triage");
    if (eligibleClaims.length < minimumClaims)
      reasons.push(`only ${eligibleClaims.length}/${minimumClaims} eligible claims were extracted`);
    if (supported < Math.min(2, minimumClaims))
      reasons.push(`only ${supported}/${Math.min(2, minimumClaims)} claims are supported`);
    if (requiresObjectiveCoverage(state) && objectiveCoverage < 0.7)
      reasons.push(
        `verified objective coverage is ${Math.round(objectiveCoverage * 100)}%, below 70%`,
      );
    if (
      supported >= 2 &&
      (state.mode === "deep" ||
        (state.plan.interpretation.entities.length >= 2 &&
          !researchState.comparisonCoverage?.sufficient)) &&
      independentDomains.size < 2
    ) {
      reasons.push("verified claims lack independent source domains");
    }
    if (state.conflicts.some((conflict) => conflict.status === "open") && state.searchPasses === 0)
      reasons.push("credible source conflicts remain open");

    return {
      sufficient: reasons.length === 0,
      status: researchState.evidenceStatus ?? "INSUFFICIENT_EVIDENCE",
      reasons,
      missingRequestedFacts,
    };
  }
  private needsMoreEvidence(state: LoopState, budget: ResearchBudget) {
    if (state.searchPasses >= budget.maxSearchPasses) return false;
    return !this.assessEvidence(state).sufficient;
  }
  private nextAction(state: LoopState, budget: ResearchBudget): Action {
    if (!this.adaptiveEvidenceLoop) {
      if (!state.searched) return "web_search";
      if (!state.triaged) return "source_triage";
      if (this.pendingSource(state, budget)) return "fetch_url";
      if (
        state.fetchedSources.length > 0 &&
        state.claimsExtractedFor !== state.fetchedSources.length
      )
        return "extract_claims";
      if (!state.evidenceGathered) return "gather_evidence";
      if (!state.verified) return "verify_claims";
      if (!state.conflictsChecked) return "detect_conflicts";
      if (state.queriesIssued < budget.maxQueries && this.needsMoreEvidence(state, budget))
        return "search_again";
      return "synthesize";
    }

    if (!state.searched) return "web_search";
    if (!state.triaged) return "source_triage";
    const hasFetchedSources = state.fetchedSources.length > 0;
    const hasClaims = state.claims.length > 0;
    if (this.shouldRecoverLifecycleGapBeforeExtraction(state, budget)) return "search_again";
    if (this.shouldFetchLifecycleSnippetBeforeExtraction(state, budget)) return "fetch_url";
    if (
      hasFetchedSources &&
      state.fetchedSources.some((source) => source.content && !source.subjectMismatchReason) &&
      state.claimsExtractedFor !== state.fetchedSources.length
    )
      return "extract_claims";
    if (hasClaims && !state.evidenceGathered) return "gather_evidence";
    if (hasClaims && !state.verified) return "verify_claims";
    if (hasClaims && !state.conflictsChecked) return "detect_conflicts";
    if (hasFetchedSources && this.assessEvidence(state).sufficient) return "synthesize";
    // Fetch one source, process its evidence, then reassess before fetching the
    // next candidate. The source/page ceilings remain hard upper bounds.
    if (this.pendingSource(state, budget)) return "fetch_url";
    const canFetchMore = this.pagesUsed(state) < budget.maxPages;
    const canSearchMore = this.canSearchAgain(state, budget);
    const latestnessUnresolved =
      this.computeResearchState(state).latestnessAssessment?.unresolvedState;
    if (latestnessUnresolved && canFetchMore && canSearchMore) {
      return "search_again";
    }
    if (
      canSearchMore &&
      (canFetchMore ||
        this.isFocusedLifecycleLookup(state) ||
        this.hasUnresolvedRequestedPredicate(state)) &&
      this.needsMoreEvidence(state, budget)
    )
      return "search_again";
    return "synthesize";
  }
  /**
   * Returns the set of actions the model may choose from at this point.
   *
   * The model is only consulted when there is a GENUINE branch — more than one
   * action is valid. When only one action is possible the controller executes
   * it deterministically without an LLM round-trip, saving ~15 s of latency
   * per skipped call.
   *
   * Branch points where the model adds real value:
   *  • After evidence is gathered: model may synthesize early when evidence is
   *    already sufficient, or continue with verify_claims for thoroughness.
   *    The evidence guard still applies — "synthesize" is only offered when
   *    assessEvidence() says sufficient, so the model cannot bypass it.
   */
  private allowedActions(state: LoopState, budget: ResearchBudget): Action[] {
    const next = this.nextAction(state, budget);
    const evidence = this.assessEvidence(state);

    // Once Research Chat has enough supported evidence, do not spend another
    // controller/verifier call on incidental claims. Preserve conflict
    // detection before synthesis when it has not run yet.
    if (
      this.adaptiveEvidenceLoop &&
      state.researchChatOptimization &&
      next === "verify_claims" &&
      evidence.sufficient
    ) {
      return [state.conflictsChecked ? "synthesize" : "detect_conflicts"];
    }

    // All other steps are fully deterministic — skip the LLM call.
    return [next];
  }
  private observation(state: LoopState, budget: ResearchBudget): Record<string, unknown> {
    const evidence = this.assessEvidence(state);
    const researchState = this.computeResearchState(state);
    const officialSourceRequirement =
      state.plan.interpretation.sourceRequirements?.officialSources ?? "none";
    const eligibleSupportedClaims = this.taskEligibleClaims(state).filter(
      (claim) => claim.verification?.verdict === "supported",
    );
    const officialEvidenceResolved = eligibleSupportedClaims.some((claim) =>
      claim.sourceIds.some((sourceId) =>
        state.fetchedSources.some(
          (source) =>
            source.id === sourceId &&
            source.content &&
            isOfficialSourceForEntities(source, state.plan.interpretation.entities),
        ),
      ),
    );
    return {
      objectives: researchState.objectives.map((o) => `[${o.status.toUpperCase()}] ${o.label}`),
      requestedFacts: requestedFactsForPlan(state.plan),
      requestedFactRequirements: state.plan.requestedFactRequirements,
      coverage: `${Math.round(researchState.coverage * 100)}%`,
      comparisonCoverage: researchState.comparisonCoverage,
      comparisonOutcome: researchState.comparisonOutcome,
      completedObjectives: researchState.completedObjectives,
      missingObjectives: researchState.missingObjectives,
      dimensions: state.plan.interpretation.dimensions,
      relevantSources: `${state.rankedSources.length}/${state.rawResults.length}`,
      fetchedSources: state.fetchedSources.filter((source) => source.content).length,
      sourceRequirements: { officialSources: officialSourceRequirement },
      fetchedOfficialSources: state.fetchedSources.filter(
        (source) =>
          source.content &&
          !source.subjectMismatchReason &&
          isOfficialSourceForEntities(source, state.plan.interpretation.entities),
      ).length,
      claims: state.claims.length,
      supportedClaims: eligibleSupportedClaims.length,
      openConflicts: state.conflicts.filter((conflict) => conflict.status === "open").length,
      evidenceStatus: evidence.sufficient ? "SUFFICIENT" : "INSUFFICIENT",
      requestedFactEvidenceStatus: evidence.status,
      requestedFactCoverage: researchState.requestedFactCoverage,
      missingRequestedFacts: researchState.missingRequestedFacts,
      latestnessAssessment: researchState.latestnessAssessment,
      releaseRecords: researchState.releaseRecords,
      missingEvidence: evidence.reasons,
      latestnessRequirement: {
        required: researchState.requestedFactCoverage?.required.includes("latestness") ?? false,
        resolved: researchState.requestedFactCoverage?.present.includes("latestness") ?? false,
      },
      officialEvidence: {
        requirement: officialSourceRequirement,
        resolved: officialEvidenceResolved,
      },
      latestRecoveryRequirements: state.searchRecoveries.at(-1)?.requirements,
      budgetRemaining: {
        queries: Math.max(0, budget.maxQueries - state.queriesIssued),
        pages: Math.max(0, budget.maxPages - this.pagesUsed(state)),
        searchPasses: Math.max(0, budget.maxSearchPasses - state.searchPasses),
        steps: Math.max(0, budget.maxSteps - state.actionsExecuted),
        modelDecisions: Math.max(0, budget.maxModelDecisions - state.modelDecisions),
      },
    };
  }
  private async chooseAction(
    id: string,
    state: LoopState,
    budget: ResearchBudget,
  ): Promise<Action> {
    const allowed = this.allowedActions(state, budget);
    const recommended = allowed[0];
    const evidence = this.assessEvidence(state);

    // Skip the LLM when the next step is fully deterministic — only one option
    // exists so there is no real decision to make. This eliminates the largest
    // source of unnecessary latency (~15 s per skipped call).
    if (allowed.length === 1) {
      const unresolvedLatestness =
        this.computeResearchState(state).latestnessAssessment?.unresolvedState;
      await this.recordDecision(id, {
        requestedAction: undefined,
        controllerDecision: "fallback",
        nextAction: recommended,
        reason:
          recommended === "search_again" && unresolvedLatestness
            ? `latestness remains unresolved (${unresolvedLatestness.reason}); retrieve additional official evidence. ${evidence.reasons.join("; ")}`
            : recommended === "search_again" && evidence.reasons.length > 0
              ? `evidence remains insufficient: ${evidence.reasons.join("; ")}`
              : recommended === "synthesize" && unresolvedLatestness
                ? `research budget exhausted for latestness resolution; report uncertainty (${unresolvedLatestness.reason})`
                : "deterministic controller step — single valid action, no model decision needed",
      });
      return recommended;
    }

    // Genuine branch: model has real options. Consult it if available.
    let requestedAction: string | undefined;
    if (this.llm.enabled && state.modelDecisions < budget.maxModelDecisions) {
      try {
        requestedAction = await this.llm.proposeResearchAction(
          this.observation(state, budget),
          allowed,
        );
        state.modelDecisions += 1;
      } catch {
        requestedAction = undefined;
      }
    }
    const requested = requestedAction as Action | undefined;
    if (requested && allowed.includes(requested)) {
      await this.recordDecision(id, {
        requestedAction,
        controllerDecision: "allow",
        nextAction: requested,
        reason: evidence.sufficient
          ? "evidence sufficiency guard passed"
          : "action is valid for the current state",
      });
      return requested;
    }
    await this.recordDecision(id, {
      requestedAction,
      controllerDecision: requestedAction ? "override" : "fallback",
      nextAction: recommended,
      reason: requestedAction
        ? `requested action is not in the allowed set; ${evidence.reasons.join("; ") || "controller sequencing guard"}`
        : "model decision unavailable — deterministic fallback",
    });
    return recommended;
  }
  private async triageSources(id: string, state: LoopState, budget: ResearchBudget) {
    const ranked = rankResults(state.plan.interpretation.normalizedQuestion, state.rawResults);
    const comparison = state.researchChatOptimization
      ? state.plan.interpretation.comparison
      : undefined;
    const supportedClaims = state.claims.filter(
      (claim) => claim.verification?.verdict === "supported",
    );
    const supportedSources = state.fetchedSources.filter((source) =>
      supportedClaims.some((claim) => claim.sourceIds.includes(source.id)),
    );
    const recoveryRequirements = state.researchChatOptimization
      ? state.searchRecoveries.at(-1)?.requirements
      : undefined;
    const unresolvedPredicate =
      recoveryRequirements?.requestedPredicate && !recoveryRequirements.requestedPredicate.resolved
        ? recoveryRequirements.requestedPredicate.requirement
        : undefined;
    const candidates =
      comparison || unresolvedPredicate
        ? ranked.filter((source) => !state.fetchedUrls.has(source.url))
        : ranked;
    if (unresolvedPredicate) {
      const recoveryQueries = new Set(
        (state.searchRecoveries.at(-1)?.queries ?? []).map((query) => query.trim().toLowerCase()),
      );
      candidates.sort((left, right) => {
        const leftIsFresh = recoveryQueries.has((left.query ?? "").trim().toLowerCase());
        const rightIsFresh = recoveryQueries.has((right.query ?? "").trim().toLowerCase());
        const leftNamesFact = requestedPredicatePresent(
          `${left.title}. ${left.snippet}`,
          unresolvedPredicate,
        );
        const rightNamesFact = requestedPredicatePresent(
          `${right.title}. ${right.snippet}`,
          unresolvedPredicate,
        );
        return (
          Number(rightIsFresh) - Number(leftIsFresh) ||
          Number(rightNamesFact) - Number(leftNamesFact) ||
          right.quality.overall - left.quality.overall
        );
      });
    }
    const reservePredicateSource =
      state.researchChatOptimization &&
      !!state.plan.interpretation.requestedPredicate &&
      !comparison &&
      state.searchRecoveries.length === 0 &&
      budget.maxSources >= 2 &&
      this.canSearchAgain(state, budget);
    const sourceLimit = comparison
      ? Math.max(0, budget.maxSources - state.fetchedSources.length)
      : unresolvedPredicate
        ? Math.max(0, budget.maxSources - state.fetchedSources.length)
        : reservePredicateSource
          ? budget.maxSources - 1
          : budget.maxSources;
    const officialSourceRequirement =
      state.plan.interpretation.sourceRequirements?.officialSources ?? "none";
    const selection = selectResearchSourcesWithDecisions(
      candidates,
      state.plan.interpretation.entities,
      sourceLimit,
      officialSourceRequirement,
      state.question,
      recoveryRequirements,
      state.researchChatOptimization && !!state.plan.interpretation.comparison,
      comparison
        ? {
            comparison,
            neededTargets: comparison.targets.filter(
              (target) =>
                !supportedClaims.some((claim) =>
                  comparisonClaimHasTargetFinding({ ...comparison, targets: [target] }, claim.text),
                ),
            ),
            usedDomains: supportedSources.map((source) => source.domain),
            unavailableUrls: state.fetchedSources
              .filter(
                (source) =>
                  source.fetchError || source.subjectMismatchReason || !source.content?.trim(),
              )
              .map((source) => source.url),
          }
        : undefined,
    );
    state.rankedSources = comparison
      ? [
          ...state.fetchedSources.filter(
            (source) =>
              source.content?.trim() && !source.subjectMismatchReason && !source.fetchError,
          ),
          ...selection.selected,
        ]
      : selection.selected;
    const priorDecisions = new Map(
      state.sourceSelectionDecisions.map((decision) => [
        `${decision.query.toLowerCase()}|${decision.sourceId}`,
        decision,
      ]),
    );
    const decisions = selection.decisions.map((decision) => {
      const source = ranked.find((candidate) => candidate.id === decision.sourceId);
      const query =
        source?.query ?? state.plan.queries[0] ?? state.plan.interpretation.normalizedQuestion;
      const prior = priorDecisions.get(`${query.toLowerCase()}|${decision.sourceId}`);
      const taskEvidence = source?.taskEvidence ??
        prior?.taskEvidence ?? {
          status: "UNVERIFIED" as const,
          missingFacts: missingRequestedFactSupport(state.question, [decision.snippet], {
            requestedFacts: requestedFactsForPlan(state.plan),
          }),
        };

      return {
        ...decision,
        query,
        taskEvidence: {
          ...taskEvidence,
          presentFacts: requestedFactCoverage(state.question, [decision.title, decision.snippet], {
            requestedFacts: requestedFactsForPlan(state.plan),
          }).present,
        },
      };
    });
    const decisionsByKey = new Map(
      [...state.sourceSelectionDecisions, ...decisions].map((decision) => [
        `${decision.query.toLowerCase()}|${decision.sourceId}`,
        decision,
      ]),
    );
    state.sourceSelectionDecisions = [...decisionsByKey.values()];
    state.triaged = true;
    await this.update(id, { sourceSelectionDecisions: state.sourceSelectionDecisions });
    await this.step(
      id,
      labelFor("source_triage"),
      "complete",
      `${state.rankedSources.length} of ${ranked.length} sources selected under the ${officialSourceRequirement} official-source policy after relevance, authority, freshness, entity, and duplicate checks; ${ranked.filter((source) => source.subjectMismatchReason).length} rejected for subject mismatch`,
    );
  }
  private isSnippetSufficientForState(state: LoopState, source: Source) {
    return isSerperSnippetSufficient(
      source,
      state.plan.interpretation.normalizedQuestion,
      requestedFactsForPlan(state.plan),
    );
  }
  private canSearchAgain(state: LoopState, budget: ResearchBudget) {
    const execution = getResearchExecutionContext();
    return (
      state.queriesIssued < budget.maxQueries &&
      state.searchPasses < budget.maxSearchPasses &&
      state.actionsExecuted < budget.maxSteps &&
      (!execution || Date.now() < execution.deadlineAt)
    );
  }
  private shouldRecoverLifecycleGapBeforeExtraction(state: LoopState, budget: ResearchBudget) {
    if (!state.researchChatOptimization || !this.isFocusedLifecycleLookup(state)) return false;
    if (!this.canSearchAgain(state, budget)) return false;
    const sourcesWithContent = state.fetchedSources.filter(
      (source) => source.content && !source.subjectMismatchReason,
    );
    if (sourcesWithContent.length === 0) return false;
    const factCoverage = requestedFactCoverage(
      state.question,
      sourcesWithContent.map((source) => source.content ?? ""),
      { requestedFacts: ["end-of-life date"] },
    );
    if (!factCoverage.missing.includes("end-of-life date")) return false;
    return !this.pendingSource(state, budget);
  }
  private shouldFetchLifecycleSnippetBeforeExtraction(state: LoopState, budget: ResearchBudget) {
    if (!state.researchChatOptimization || !this.isFocusedLifecycleLookup(state)) return false;
    if (this.pagesUsed(state) < budget.maxPages) return false;
    const sourcesWithContent = state.fetchedSources.filter(
      (source) => source.content && !source.subjectMismatchReason,
    );
    if (sourcesWithContent.length === 0) return false;
    const factCoverage = requestedFactCoverage(
      state.question,
      sourcesWithContent.map((source) => source.content ?? ""),
      { requestedFacts: ["end-of-life date"] },
    );
    return (
      factCoverage.missing.includes("end-of-life date") &&
      this.pendingSource(state, budget) !== undefined
    );
  }
  private bindClaimEvidence(state: LoopState) {
    const sourceMap = new Map(state.fetchedSources.map((source) => [source.id, source]));
    state.claims = state.claims.map((claim) => ({
      ...claim,
      evidence: claim.sourceIds.some(
        (sourceId) =>
          Boolean(claim.evidence?.trim()) &&
          sourceMap.get(sourceId)?.content?.includes(claim.evidence),
      )
        ? claim.evidence.slice(0, 1200)
        : claim.sourceIds
            .map((sourceId) => sourceMap.get(sourceId)?.content ?? "")
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 1200),
    }));
  }
  private async executeAction(
    id: string,
    state: LoopState,
    action: Action,
    budget: ResearchBudget,
  ) {
    if (action === "web_search") {
      const initialQueryLimit = initialSearchQueryLimit(
        budget.maxQueries,
        budget.maxSearchPasses,
        requiresObjectiveCoverage(state),
        this.adaptiveEvidenceLoop,
      );
      const queries = state.plan.queries.slice(
        0,
        Math.min(initialQueryLimit, budget.maxQueries - state.queriesIssued),
      );
      const results = await this.searchWithTrace(id, action, queries);
      state.rawResults.push(
        ...results.map((result) => ({
          ...result,
          ...(result.query || queries.length !== 1 ? {} : { query: queries[0] }),
        })),
      );
      state.queriesIssued += queries.length;
      state.searched = true;
      if (state.researchChatOptimization) await this.triageSources(id, state, budget);
      return;
    }
    if (action === "source_triage") {
      await this.triageSources(id, state, budget);
      return;
    }
    if (action === "fetch_url") {
      const remainingSlots = Math.max(
        0,
        this.pageLimitForPass(state, budget) - this.pagesUsed(state),
      );
      const candidates = state.rankedSources.filter(
        (source) => !state.fetchedUrls.has(source.url) && !source.fetchError,
      );
      const pendingSources =
        remainingSlots > 0
          ? candidates.slice(
              0,
              this.adaptiveEvidenceLoop
                ? this.adaptiveInitialFetchCount(state, remainingSlots)
                : remainingSlots,
            )
          : state.researchChatOptimization
            ? candidates
                .filter((source) => this.isSnippetSufficientForState(state, source))
                .slice(0, 1)
            : [];

      if (pendingSources.length === 0) return;

      for (const source of pendingSources) {
        for (const decision of state.sourceSelectionDecisions) {
          if (
            decision.retrieval?.status === "failed" ||
            decision.retrieval?.status === "unusable"
          ) {
            decision.retrieval.replacementUrl ??= source.url;
          }
        }
        state.fetchedUrls.add(source.url);
      }

      const priorFetchedCount = state.fetchedSources.length;
      await this.step(
        id,
        labelFor(action),
        "running",
        this.adaptiveEvidenceLoop
          ? `Fetching ${pendingSources.length} selected source(s) before reassessing evidence`
          : undefined,
      );
      await pMap(
        pendingSources,
        async (source) => {
          try {
            const fetched = (await this.registry.execute("fetch_url", {
              url: source.url,
              title: source.title,
              snippet: source.snippet,
              provider: source.provider,
              question: state.question,
              allowSnippetEvidence: this.snippetEvidencePolicy.get(id) ?? true,
              requestedFacts: requestedFactsForPlan(state.plan),
              researchChatOptimization: state.researchChatOptimization,
            })) as {
              html: string;
              url: string;
              contentType?: string;
              cached?: boolean;
              document?: unknown;
              retrievalMethod?: string;
              retrievalAttempts?: string[];
              retrievalMethodsSkipped?: string[];
              retrievalReasons?: string[];
              retrievalSourceUrl?: string;
              releaseHistorySourceKind?: Source["releaseHistorySourceKind"];
              releaseHistoryComplete?: boolean;
              extractionConfidence?: number;
              extractionStatus?: Source["extractionStatus"];
              retrievedContentLength?: number;
            };
            const document = (await this.registry.execute("extract_content", {
              html: fetched.html,
              url: fetched.url,
              contentType: fetched.contentType,
              cached: fetched.cached,
              document: fetched.document,
              retrievalMethod: fetched.retrievalMethod,
              sourceMetadata: {
                provider: source.provider,
                providers: source.providers,
                engine: source.engine,
                query: source.query,
                discoveredAt: source.discoveredAt,
                retrievalMethod: fetched.retrievalMethod,
                retrievalAttempts: fetched.retrievalAttempts,
                retrievalMethodsSkipped: fetched.retrievalMethodsSkipped,
                retrievalReasons: fetched.retrievalReasons,
                retrievalSourceUrl: fetched.retrievalSourceUrl,
                releaseHistorySourceKind: fetched.releaseHistorySourceKind,
                releaseHistoryComplete: fetched.releaseHistoryComplete,
                extractionConfidence: fetched.extractionConfidence,
                extractionStatus: fetched.extractionStatus,
                retrievedContentLength: fetched.retrievedContentLength,
                canonicalUrl:
                  fetched.document && typeof fetched.document === "object"
                    ? (fetched.document as { canonicalUrl?: string }).canonicalUrl
                    : undefined,
              },
            })) as {
              title: string;
              content: string;
              canonicalUrl?: string;
              publishedAt?: string;
              contentOrigin?: Source["contentOrigin"];
            };
            const subjectMismatchReason =
              subjectEntityMismatchReason(
                state.plan.interpretation.normalizedQuestion,
                document.title,
              ) ??
              querySubjectMismatchReason(
                state.question,
                document.content,
                `${source.title} ${source.snippet}`,
              );
            const taskEvidence = subjectMismatchReason
              ? {
                  status: "INSUFFICIENT_EVIDENCE" as const,
                  missingFacts: [
                    subjectMismatchReason,
                    ...missingRequestedFactSupport(
                      state.plan.interpretation.normalizedQuestion,
                      [],
                      { requestedFacts: requestedFactsForPlan(state.plan) },
                    ),
                  ],
                }
              : unverifiedTaskEvidence(
                  state.plan.interpretation.normalizedQuestion,
                  document.content,
                  requestedFactsForPlan(state.plan),
                );
            state.fetchedSources.push({
              ...source,
              title:
                document.title && !querySubjectMismatchReason(state.question, document.title)
                  ? document.title
                  : source.title,
              content:
                state.researchChatOptimization && state.plan.interpretation.comparison
                  ? comparisonEvidencePassages(
                      state.plan.interpretation.comparison,
                      document.content,
                    )
                      .filter((passage) => !querySubjectMismatchReason(state.question, passage))
                      .join("\n\n")
                      .slice(0, 12000)
                  : state.researchChatOptimization
                    ? relevantSourceContent(
                        state.question,
                        document.content,
                        `${source.title} ${document.title} ${source.snippet}`,
                      ).slice(0, 12000)
                    : document.content.slice(0, 12000),
              pagePublishedAt: document.publishedAt,
              fetchedAt: new Date().toISOString(),
              canonicalUrl: document.canonicalUrl,
              contentOrigin: document.contentOrigin,
              retrievalMethod: fetched.retrievalMethod as Source["retrievalMethod"],
              retrievalSourceUrl: fetched.retrievalSourceUrl,
              releaseHistorySourceKind: fetched.releaseHistorySourceKind,
              releaseHistoryComplete: fetched.releaseHistoryComplete,
              retrievalAttempts: fetched.retrievalAttempts,
              retrievalMethodsSkipped: fetched.retrievalMethodsSkipped,
              extractionConfidence: fetched.extractionConfidence,
              extractionStatus: fetched.extractionStatus,
              retrievedContentLength: fetched.retrievedContentLength,
              subjectMismatchReason,
              quality: subjectMismatchReason
                ? { ...source.quality, relevance: 0, overall: 0 }
                : source.quality,
              retrievalReasons: subjectMismatchReason
                ? [
                    ...(fetched.retrievalReasons ?? []),
                    `The extracted page title did not match the requested subject: ${subjectMismatchReason}`,
                  ]
                : fetched.retrievalReasons,
              taskEvidence,
            });
          } catch (error) {
            const retrievalError = error instanceof SourceRetrievalError ? error : undefined;
            const message = error instanceof Error ? error.message : "Fetch failed";
            state.fetchedSources.push({
              ...source,
              fetchError: message,
              fetchFailureCategory: classifyFetchFailure(error),
              extractionStatus: /too short|insufficient content/i.test(message)
                ? "INSUFFICIENT_CONTENT"
                : "FAILED",
              extractionConfidence: 0,
              retrievalAttempts: retrievalError?.attempts,
              retrievalMethodsSkipped: retrievalError?.skipped,
              retrievalReasons: retrievalError?.reasons,
              taskEvidence: {
                status: "INSUFFICIENT_EVIDENCE",
                missingFacts: missingRequestedFactSupport(
                  state.plan.interpretation.normalizedQuestion,
                  [source.snippet],
                  { requestedFacts: requestedFactsForPlan(state.plan) },
                ),
              },
            });
          }
        },
        config.MAX_CONCURRENT_FETCHES,
      );
      const fetchedById = new Map(state.fetchedSources.map((source) => [source.id, source]));
      state.sourceSelectionDecisions = state.sourceSelectionDecisions.map((decision) => {
        const source = fetchedById.get(decision.sourceId);
        return source
          ? {
              ...decision,
              taskEvidence: source.taskEvidence
                ? {
                    ...source.taskEvidence,
                    presentFacts:
                      decision.taskEvidence?.presentFacts ?? source.taskEvidence.presentFacts,
                  }
                : decision.taskEvidence,
              subjectMismatchReason: source.subjectMismatchReason ?? decision.subjectMismatchReason,
              retrieval: {
                ...decision.retrieval,
                status: source.fetchError
                  ? "failed"
                  : source.subjectMismatchReason || !source.content?.trim()
                    ? "unusable"
                    : "success",
                category: source.fetchError
                  ? /redirect/i.test(source.fetchError)
                    ? "REDIRECT_LIMIT"
                    : source.fetchFailureCategory
                  : undefined,
                httpStatus: source.fetchError
                  ? Number(source.fetchError.match(/HTTP\s+(\d{3})/)?.[1]) || undefined
                  : undefined,
                message: source.fetchError
                  ? safeSearchMessage(new Error(source.fetchError))
                  : source.subjectMismatchReason,
              },
            }
          : decision;
      });
      await this.update(id, { sourceSelectionDecisions: state.sourceSelectionDecisions });
      if (this.adaptiveEvidenceLoop) {
        const addedUsableContent = state.fetchedSources
          .slice(priorFetchedCount)
          .some((source) => source.content && !source.subjectMismatchReason);
        if (addedUsableContent) {
          state.evidenceGathered = false;
          state.verified = false;
          state.conflictsChecked = false;
        } else {
          // A failed or mismatched page adds no evidence, so preserve completed
          // analysis and avoid re-verifying the same claims.
          state.claimsExtractedFor = state.fetchedSources.length;
        }
      }
      // Refill the bounded candidate slots from the existing result set. Failed
      // fetches remain counted against both source/page limits and are never retried.
      if (state.researchChatOptimization && state.plan.interpretation.comparison) {
        await this.triageSources(id, state, budget);
      }
      await this.step(id, labelFor(action), "complete");
      return;
    }
    if (action === "extract_claims") {
      const sourcesToExtract = this.adaptiveEvidenceLoop
        ? state.fetchedSources
            .slice(state.claimsExtractedFor)
            .filter((source) => !source.subjectMismatchReason)
        : state.fetchedSources.filter((source) => !source.subjectMismatchReason);
      const extractedInput = await this.useTool<Claim[]>(id, action, {
        sources: sourcesToExtract,
        question: state.plan.interpretation.normalizedQuestion,
        entities: state.plan.interpretation.entities,
        requestedFacts: requestedFactsForPlan(state.plan),
        officialSourcesRequired:
          state.plan.interpretation.sourceRequirements?.officialSources === "required",
        researchChatOptimization: state.researchChatOptimization,
      });
      const sourceIds = new Set(sourcesToExtract.map((source) => source.id));
      const extracted = extractedInput
        .filter(
          (claim) =>
            (!claim.provenance ||
              (claim.provenance.sessionId === id &&
                claim.provenance.question === state.question &&
                claim.provenance.jobId === state.jobId)) &&
            claim.sourceIds.length > 0 &&
            claim.sourceIds.every((sourceId) => sourceIds.has(sourceId)) &&
            !(
              state.researchChatOptimization &&
              state.plan.interpretation.comparison &&
              !comparisonClaimHasTargetFinding(state.plan.interpretation.comparison, claim.text)
            ) &&
            !(
              state.researchChatOptimization &&
              comparisonClaimMismatchReason(state.question, claim.text)
            ) &&
            !querySubjectMismatchReason(
              state.question,
              claim.text,
              sourcesToExtract
                .filter((source) => claim.sourceIds.includes(source.id))
                .map((source) => `${source.title} ${source.snippet}`)
                .join("\n"),
            ),
        )
        .map((claim) => ({
          ...claim,
          sourceIds: [...claim.sourceIds],
          provenance: { sessionId: id, jobId: state.jobId, question: state.question },
        }));
      if (this.adaptiveEvidenceLoop) {
        const seen = new Set(
          state.claims.map(
            (claim) =>
              `${[...claim.sourceIds].sort().join(",")}\u0000${claim.text.trim().toLowerCase()}`,
          ),
        );
        for (const claim of extracted) {
          const key = `${[...claim.sourceIds].sort().join(",")}\u0000${claim.text.trim().toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            state.claims.push(claim);
          }
        }
      } else {
        state.claims = extracted;
      }
      state.claimsExtractedFor = state.fetchedSources.length;
      if (state.researchChatOptimization) {
        this.bindClaimEvidence(state);
        state.evidenceGathered = true;
      }
      return;
    }
    if (action === "gather_evidence") {
      this.bindClaimEvidence(state);
      await this.useTool<Claim[]>(id, action, { claims: state.claims });
      state.evidenceGathered = true;
      return;
    }
    if (action === "verify_claims") {
      this.computeResearchState(state);
      const pending = selectVerificationClaims(
        this.taskEligibleClaims(state),
        Math.min(budget.maxClaimsToVerify, MAX_BATCH_VERIFICATION_CLAIMS),
        verificationFocusTerms(
          state.plan.interpretation.dimensions,
          requestedFactsForPlan(state.plan),
        ),
        requestedFactsForPlan(state.plan),
      );

      if (pending.length > 0) {
        const verifyStart = performance.now();
        await this.step(
          id,
          labelFor(action),
          "running",
          `Verifying ${pending.length} fact-targeted claims with the available verifier`,
        );
        const hasBatch = this.registry.list().some((t) => t.name === "verify_claims_batch");
        const hasSingleVerifier = this.registry.list().some((t) => t.name === "verify_claim");
        let verificationSummary: string;
        if (state.researchChatOptimization) {
          let checked = 0;
          for (const claim of pending) {
            if (this.assessEvidence(state).sufficient) break;

            try {
              let verdict: string | undefined;
              let rationale: string | undefined;
              if (hasSingleVerifier) {
                const result = (await this.registry.execute("verify_claim", {
                  sessionId: id,
                  jobId: state.jobId,
                  question: state.question,
                  sourceIds: claim.sourceIds,
                  researchChatOptimization: true,
                  claim: claim.text,
                  evidence: claim.evidence,
                })) as { verdict?: string; status?: string; rationale?: string; reason?: string };
                verdict = result.verdict ?? result.status;
                rationale = result.rationale ?? result.reason;
              } else if (hasBatch) {
                const results = (await this.registry.execute("verify_claims_batch", {
                  sessionId: id,
                  jobId: state.jobId,
                  question: state.question,
                  claims: [{ id: claim.id, claim: claim.text, evidence: claim.evidence }],
                  researchChatOptimization: true,
                })) as Array<{ id: string; verdict?: string; rationale?: string }>;
                const result = results.find((candidate) => candidate.id === claim.id);
                verdict = result?.verdict;
                rationale = result?.rationale;
              }

              const normalizedVerdict = verificationVerdict(verdict);
              claim.verification = { verdict: normalizedVerdict, rationale };
              if (
                normalizedVerdict === "unavailable" &&
                /openrouter returned 429/i.test(rationale ?? "")
              ) {
                throw new Error(rationale);
              }
              claim.verification = {
                verdict: normalizedVerdict,
                rationale:
                  rationale ??
                  (hasSingleVerifier || hasBatch
                    ? "Verifier did not return a usable verdict"
                    : "No claim verifier is available"),
              };
            } catch (error) {
              if (error instanceof Error && /openrouter returned 429/i.test(error.message)) {
                for (const unchecked of state.claims.filter((item) => !item.verification)) {
                  unchecked.verification = {
                    verdict: "unavailable",
                    rationale: "Verification skipped after provider rate limit",
                  };
                }
                claim.verification = { verdict: "unavailable", rationale: error.message };
                throw error;
              }
              claim.verification = {
                verdict: "unavailable",
                rationale: "Verification request failed",
              };
            }

            checked += 1;
            if (this.assessEvidence(state).sufficient) break;
          }
          verificationSummary =
            checked < pending.length && this.assessEvidence(state).sufficient
              ? `Evidence became sufficient after checking ${checked} of ${pending.length} claims`
              : `${checked} claims checked`;
        } else if (hasBatch) {
          try {
            const batchResults = (await this.registry.execute("verify_claims_batch", {
              sessionId: id,
              jobId: state.jobId,
              question: state.question,
              claims: pending.map((c) => ({ id: c.id, claim: c.text, evidence: c.evidence })),
            })) as Array<{ id: string; verdict?: string; rationale?: string }>;

            const rateLimit = batchResults.find(
              (result) =>
                result.verdict === "unavailable" &&
                /openrouter returned 429/i.test(result.rationale ?? ""),
            );
            const resultMap = new Map(batchResults.map((r) => [r.id, r]));
            for (const claim of pending) {
              const res = resultMap.get(claim.id);
              claim.verification = {
                verdict: verificationVerdict(res?.verdict),
                rationale: res?.rationale ?? "Batch verification did not return a verdict",
              };
            }
            if (rateLimit) {
              for (const unchecked of state.claims.filter((item) => !item.verification)) {
                unchecked.verification = {
                  verdict: "unavailable",
                  rationale: "Verification skipped after provider rate limit",
                };
              }
              throw new Error(rateLimit.rationale ?? "OpenRouter returned 429");
            }
          } catch (error) {
            if (error instanceof Error && /openrouter returned 429/i.test(error.message))
              throw error;
            for (const claim of pending) {
              claim.verification = {
                verdict: "unavailable",
                rationale: "Batch verification failed",
              };
            }
          }
          verificationSummary = `${pending.length} claims verified`;
        } else {
          await pMap(
            pending,
            async (claim) => {
              try {
                const result = (await this.registry.execute("verify_claim", {
                  sessionId: id,
                  jobId: state.jobId,
                  question: state.question,
                  sourceIds: claim.sourceIds,
                  claim: claim.text,
                  evidence: claim.evidence,
                })) as { verdict?: string; rationale?: string };
                claim.verification = {
                  verdict: verificationVerdict(result.verdict),
                  rationale: result.rationale ?? "Verification did not return a verdict",
                };
              } catch (error) {
                claim.verification = {
                  verdict: "unavailable",
                  rationale:
                    error instanceof Error ? error.message.slice(0, 240) : "Failed verification",
                };
              }
            },
            3,
          );
          verificationSummary = `${pending.length} claims verified`;
        }
        const verifyDur = Math.round(performance.now() - verifyStart);
        await this.step(
          id,
          labelFor(action),
          "complete",
          `${verificationSummary} in ${verifyDur}ms`,
          verifyDur,
        );
      }
      const verifiedResearchState = this.computeResearchState(state);
      state.fetchedSources = sourceTaskEvidence(
        state.plan.interpretation.normalizedQuestion,
        state.fetchedSources,
        state.claims,
        requestedFactsForPlan(state.plan),
        {
          releaseEvidence: verifiedResearchState.releaseRecords,
          officialSourcesRequired:
            state.plan.interpretation.sourceRequirements?.officialSources === "required",
          latestnessProven: verifiedResearchState.latestnessAssessment?.conclusion === "PROVEN",
          latestnessVersion:
            verifiedResearchState.latestnessAssessment?.latestVersion ??
            verifiedResearchState.latestnessAssessment?.highestCandidateVersion,
          latestnessSourceIds: verifiedResearchState.latestnessAssessment?.supportingSourceIds,
        },
      );
      const evidenceBySourceId = new Map(state.fetchedSources.map((source) => [source.id, source]));
      state.sourceSelectionDecisions = state.sourceSelectionDecisions.map((decision) => {
        const source = evidenceBySourceId.get(decision.sourceId);
        return source
          ? {
              ...decision,
              taskEvidence: source.taskEvidence
                ? {
                    ...source.taskEvidence,
                    presentFacts: source.taskEvidence.presentFacts,
                  }
                : decision.taskEvidence,
              subjectMismatchReason: source.subjectMismatchReason ?? decision.subjectMismatchReason,
            }
          : decision;
      });
      await this.update(id, { sourceSelectionDecisions: state.sourceSelectionDecisions });
      state.verified = true;
      if (state.researchChatOptimization && state.plan.interpretation.comparison) {
        await this.triageSources(id, state, budget);
      }
      if (state.researchChatOptimization && this.synthesisClaims(state).length <= 1) {
        state.conflictsChecked = true;
      }
      return;
    }
    if (action === "detect_conflicts") {
      const detected = await this.useTool<
        Array<{
          claimIds?: string[];
          sourceIds?: string[];
          description?: string;
          status?: "open" | "resolved" | "uncertain";
        }>
      >(id, action, { claims: state.claims });
      state.conflicts = detected.map((conflict) => ({
        id: randomUUID().slice(0, 8),
        claimIds: conflict.claimIds ?? [],
        sourceIds: conflict.sourceIds ?? [],
        description: conflict.description ?? "Sources may disagree",
        status: conflict.status ?? "open",
      }));
      state.conflictsChecked = true;
      return;
    }
    if (action === "search_again") {
      const researchState = this.computeResearchState(state);
      const missingObjs = researchState.objectives.filter((o) => o.status !== "fulfilled");
      const evidence = this.assessEvidence(state);
      const officialSourceRequirement: OfficialSourceRequirement =
        state.plan.interpretation.sourceRequirements?.officialSources ?? "none";
      const eligibleSupportedClaims = this.taskEligibleClaims(state).filter(
        (claim) => claim.verification?.verdict === "supported",
      );
      const factCoverage = researchState.requestedFactCoverage ?? {
        required: [],
        present: [],
        missing: [],
      };
      const knownVersionCandidates = [
        ...new Set(
          (researchState.latestnessAssessment?.candidateVersions ?? [])
            .filter(
              (candidate) =>
                !requestedFactsForPlan(state.plan).includes("stable status") ||
                candidate.stability === "stable",
            )
            .map((candidate) => candidate.version),
        ),
      ].sort((left, right) => compareVersions(left, right) ?? 0);
      const recoveryRequirements: ResearchRecoveryRequirements = {
        comparison: researchState.comparisonCoverage,
        ...(state.plan.interpretation.requestedPredicate
          ? {
              requestedPredicate: {
                requirement: state.plan.interpretation.requestedPredicate,
                resolved: researchState.requestedFactCoverage?.requestedPredicate?.present === true,
              },
            }
          : {}),
        requestedFacts: factCoverage.required,
        resolvedFacts: factCoverage.present,
        unresolvedFacts: factCoverage.missing,
        ...(state.researchChatOptimization
          ? {
              factInsufficientSources: state.fetchedSources.flatMap((source) => {
                if (
                  !source.content ||
                  source.subjectMismatchReason ||
                  factCoverage.missing.length === 0
                )
                  return [];
                const sourceCoverage = requestedFactCoverage(state.question, source.content, {
                  requestedFacts: factCoverage.missing,
                  releaseEvidence: (researchState.releaseRecords ?? []).filter(
                    (record) => record.sourceId === source.id,
                  ),
                  officialSourcesRequired: officialSourceRequirement === "required",
                  latestnessProven: researchState.latestnessAssessment?.conclusion === "PROVEN",
                  latestnessVersion:
                    researchState.latestnessAssessment?.latestVersion ??
                    researchState.latestnessAssessment?.highestCandidateVersion,
                });
                if (sourceCoverage.missing.length === 0) return [];
                return [
                  {
                    url: source.url,
                    canonicalUrl: source.canonicalUrl,
                    missingFacts: sourceCoverage.missing,
                  },
                ];
              }),
            }
          : {}),
        latestnessRequired: factCoverage.required.includes("latestness"),
        latestnessResolved: factCoverage.present.includes("latestness"),
        knownVersionCandidates,
        qualifiers: {
          latest:
            state.plan.requestedFactRequirements?.latest ??
            /\b(?:latest|newest|current|most recent)\b/i.test(state.question),
          stable:
            state.plan.requestedFactRequirements?.stable ?? /\bstable\b/i.test(state.question),
        },
        officialSourceRequirement,
        officialEvidenceResolved: eligibleSupportedClaims.some((claim) =>
          claim.sourceIds.some((sourceId) =>
            state.fetchedSources.some(
              (source) =>
                source.id === sourceId &&
                source.content &&
                isOfficialSourceForEntities(source, state.plan.interpretation.entities),
            ),
          ),
        ),
      };
      const rewritten = await rewriteQueries(
        state.researchChatOptimization
          ? state.question
          : state.plan.interpretation.normalizedQuestion,
        state.plan,
        state.rawResults,
        state.mode,
        this.llm,
        missingObjs,
        recoveryRequirements,
      );
      const candidate = rewritten[0] ?? "";
      const queryValidation = validateRecoveryQuery(
        candidate,
        state.question,
        state.plan,
        recoveryRequirements,
        recoveryRequirements.unresolvedFacts.length === 0 ? missingObjs.slice(0, 1) : [],
      );
      const queryAvailable = state.queriesIssued < budget.maxQueries;
      const accepted = queryValidation.accepted && queryAvailable;
      const queries = accepted ? [candidate] : [];
      const recovery = {
        reason: evidence.reasons,
        missingRequestedFacts: missingRequestedFactSupportFromCoverage(
          researchState.requestedFactCoverage ?? factCoverage,
        ),
        officialSourceRequirement,
        requirements: recoveryRequirements,
        queries,
        queryValidation: {
          candidate,
          accepted,
          reasons: queryAvailable
            ? queryValidation.reasons
            : [...queryValidation.reasons, "search query budget is exhausted"],
        },
      };
      state.searchRecoveries.push(recovery);
      await this.update(id, { searchRecoveries: state.searchRecoveries });
      if (!accepted) {
        state.searchPasses = budget.maxSearchPasses;
        return;
      }
      const results = await this.searchWithTrace(id, action, queries);
      const resultsWithQuery = results.map((result) => ({
        ...result,
        ...(result.query || queries.length !== 1 ? {} : { query: queries[0] }),
      }));
      // Newly targeted results win equal-quality ties before the bounded
      // selection can be filled by older results from the initial query.
      if (state.researchChatOptimization && state.plan.interpretation.comparison)
        state.rawResults.unshift(...resultsWithQuery);
      else state.rawResults.push(...resultsWithQuery);
      state.queriesIssued += queries.length;
      state.searchPasses += 1;
      state.triaged = false;
      state.fetchedUrls = new Set(state.fetchedSources.map((source) => source.url));
      if (!this.adaptiveEvidenceLoop) {
        state.evidenceGathered = false;
        state.verified = false;
        state.conflictsChecked = false;
      }
      state.plan = { ...state.plan, queries: [...state.plan.queries, ...queries] };
      await this.update(id, {
        plan: state.plan,
        searchRecoveries: state.searchRecoveries,
      });
      if (state.researchChatOptimization) await this.triageSources(id, state, budget);
      return;
    }
  }
  private async run(
    id: string,
    controllerOverride?: AbortController,
    options: ResearchRunOptions = {},
  ) {
    const controller =
      controllerOverride ?? this.activeControllers.get(id) ?? new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineContext: ResearchExecutionContext | undefined;
    this.activeControllers.set(id, controller);
    try {
      const session = await this.store.get(id);
      if (!session || session.status === "CANCELLED") return;
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof Error &&
        controller.signal.reason.message === "Job cancellation requested"
      ) {
        const cancelled = await this.update(id, {
          status: "CANCELLED",
          error: "Research cancelled by user",
        });
        if (cancelled) {
          this.emit(id, {
            type: "research.cancelled",
            message: "Research cancelled by user",
            session: cancelled,
          });
        }
        return;
      }
      const budget = researchBudgetFor(
        session.mode,
        this.budgetOverrides,
        this.evaluationBudgetCeilings,
      );
      const startedAt = Date.now();
      deadlineContext = {
        deadlineAt: startedAt + budget.maxTimeMs,
        signal: controller.signal,
        stageTimings: {},
      };
      timer = setTimeout(
        () => controller.abort(new Error("Research time budget exhausted")),
        budget.maxTimeMs,
      );
      const execution = withOperationContext(() =>
        runWithResearchExecutionContext(deadlineContext!, () => this.runWithinContext(id, options)),
      );
      await raceWithResearchAbort(execution, controller.signal);
    } catch (error) {
      const finalize = async () => {
        const current = await this.store.get(id);
        if (!current || ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return;
        const message = error instanceof Error ? error.message : "Research failed";
        const reason = controller.signal.reason;
        const deadlineExceeded =
          message === "Research time budget exhausted" ||
          message === "Research session deadline exhausted" ||
          (deadlineContext !== undefined && Date.now() >= deadlineContext.deadlineAt);
        const userCancelled =
          reason instanceof Error &&
          /Job cancellation requested|Research session cancelled|Research cancelled by user/i.test(
            reason.message,
          );
        const failedStage = activeResearchStage() ?? (deadlineExceeded ? "research" : "worker");
        const partialState = deadlineContext?.capturePartialState?.() ?? {};
        const stageTimings = researchStageTimingsSnapshot() ?? current.stageTimings ?? {};
        const terminalStatus = userCancelled ? "CANCELLED" : "FAILED";
        const terminalMessage = deadlineExceeded
          ? `Research time budget exhausted during ${failedStage}`
          : userCancelled
            ? "Research cancelled by worker or user request"
            : message;
        const step: ResearchStep = {
          id: randomUUID(),
          label: deadlineExceeded
            ? "🛑 research budget exhausted (deadline)"
            : "🛑 research stopped",
          status: deadlineExceeded ? "failed" : "complete",
          detail: terminalMessage,
          at: new Date().toISOString(),
        };
        const terminal = await this.update(id, {
          ...partialState,
          status: terminalStatus,
          error:
            terminalStatus === "FAILED"
              ? deadlineExceeded
                ? `${INSUFFICIENT_EVIDENCE_ERROR_PREFIX} ${terminalMessage}`
                : terminalMessage
              : "Research cancelled",
          answer: deadlineExceeded
            ? "Insufficient evidence: the research time limit was reached before MAX could verify a complete answer."
            : current.answer,
          failureStage: deadlineExceeded ? failedStage : undefined,
          stageTimings,
          steps: [...current.steps, step],
        });
        if (terminal) {
          this.emit(id, {
            type: terminalStatus === "CANCELLED" ? "research.cancelled" : "research.failed",
            message: terminalMessage,
            session: terminal,
          });
        }
      };
      if (deadlineContext) {
        await runWithResearchExecutionContext(deadlineContext, finalize);
      } else {
        await finalize();
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.snippetEvidencePolicy.delete(id);
      this.memoryContexts.delete(id);
      this.conversationContexts.delete(id);
      if (this.activeControllers.get(id) === controller) this.activeControllers.delete(id);
    }
  }

  private async runWithinContext(id: string, options: ResearchRunOptions = {}) {
    try {
      const session = await this.store.get(id);
      if (!session || session.status === "CANCELLED") return;
      const budget = researchBudgetFor(
        session.mode,
        this.budgetOverrides,
        this.evaluationBudgetCeilings,
      );
      const startedAt = Date.now();
      const stageTimings: Record<string, number> = {};

      await this.update(id, { status: "PLANNING" });
      const planStart = performance.now();
      const plan = await runResearchStage("planning", () =>
        buildPlan(
          session.question,
          session.mode,
          this.llm,
          isQueryInterpretation(options.interpretation) ? options.interpretation : undefined,
          { researchChatOptimization: options.researchChatOptimization === true },
        ),
      );
      const planDur = Math.round(performance.now() - planStart);
      stageTimings["understand_query + plan"] = planDur;

      await this.update(id, { plan, stageTimings });
      await this.step(
        id,
        "🧠 understand_query + plan",
        "complete",
        `${plan.interpretation.intent}; ambiguity ${plan.interpretation.ambiguityScore.toFixed(2)}`,
        planDur,
      );
      if (plan.interpretation.needsClarification) {
        const waiting = await this.update(id, { status: "NEEDS_CLARIFICATION" });
        await this.step(
          id,
          "❓ clarification",
          "complete",
          plan.interpretation.clarificationQuestion,
        );
        if (waiting)
          this.emit(id, {
            type: "research.clarification",
            message:
              plan.interpretation.clarificationQuestion ?? "Please clarify the research request",
            session: waiting,
          });
        return;
      }
      if (Date.now() - startedAt >= budget.maxTimeMs) {
        await this.step(
          id,
          "🛑 budget exhausted",
          "complete",
          "Stopped safely because the session budget was exhausted during planning",
        );
        const failed = await this.update(id, {
          status: "FAILED",
          error: `${INSUFFICIENT_EVIDENCE_ERROR_PREFIX} session budget was exhausted during planning.`,
          plan,
          answer:
            "Insufficient evidence: the configured research budget was exhausted during planning.",
        });
        if (failed)
          this.emit(id, {
            type: "research.failed",
            message: "Research could not begin before its bounded session budget expired",
            session: failed,
          });
        return;
      }
      const state: LoopState = {
        sessionId: id,
        jobId: currentWorkerContext()?.lease.job.id,
        mode: session.mode,
        question: session.question,
        plan,
        objectives: plan.structuredObjectives || [],
        rawResults: session.seedResults ?? [],
        rankedSources: [],
        sourceSelectionDecisions: [],
        searchRecoveries: [],
        fetchedSources: [],
        claims: [],
        conflicts: [],
        searched: false,
        triaged: false,
        searchPasses: 0,
        fetchedUrls: new Set(),
        claimsExtractedFor: 0,
        evidenceGathered: false,
        verified: false,
        conflictsChecked: false,
        queriesIssued: 0,
        modelDecisions: 0,
        actionsExecuted: 0,
        researchChatOptimization:
          this.adaptiveEvidenceLoop && options.researchChatOptimization === true,
      };
      const execution = getResearchExecutionContext();
      if (execution) {
        execution.capturePartialState = () => {
          const researchState = this.computeResearchState(state);
          return structuredClone({
            plan: state.plan,
            sources: state.fetchedSources.length ? state.fetchedSources : state.rankedSources,
            claims: state.claims,
            conflicts: state.conflicts,
            state: researchState,
            coverage: researchState.coverage,
            sourceSelectionDecisions: state.sourceSelectionDecisions,
            searchRecoveries: state.searchRecoveries,
            stageTimings: researchStageTimingsSnapshot(),
          });
        };
      }
      let answer = "";
      let synthesisCompleted = false;
      let citationValidationFailed = false;
      let iterations = 0;
      while (iterations < budget.maxSteps && Date.now() - startedAt < budget.maxTimeMs) {
        const currentSession = await this.store.get(id);
        if (currentSession?.status === "CANCELLED") return;
        const action = await this.chooseAction(id, state, budget);
        const currentResearchState = this.computeResearchState(state);
        await this.update(id, {
          status: statusFor(action),
          sources: state.fetchedSources.length ? state.fetchedSources : state.rankedSources,
          claims: state.claims,
          conflicts: state.conflicts,
          state: currentResearchState,
          coverage: currentResearchState.coverage,
        });
        if (action === "synthesize") {
          state.fetchedSources.sort(
            (left, right) =>
              Number(Boolean(left.subjectMismatchReason)) -
              Number(Boolean(right.subjectMismatchReason)),
          );
          const evidenceSources = state.fetchedSources.filter(
            (source) => !source.subjectMismatchReason,
          );
          const evidence = this.assessEvidence(state);
          const researchState = this.computeResearchState(state);
          const synthesisClaims = this.synthesisClaims(state);
          const synthStart = performance.now();
          const citationReportBefore = this.synthesisProvider.metrics?.citationEntailment;
          if (!evidence.sufficient)
            answer = `Research collected evidence but cannot present it as sufficiently verified: ${evidence.reasons.join(
              "; ",
            )}.`;
          else if (state.claims.length === 0)
            answer =
              "Research completed, but the retrieved sources did not contain extractable text.";
          else {
            answer = (await runResearchStage("synthesis", () =>
              this.registry.execute("synthesize", {
                kind: "research",
                question: session.question,
                plan: state.plan,
                sources: evidenceSources,
                claims: synthesisClaims,
                researchState,
                mode: session.mode,
                memoryContext: this.memoryContexts.get(id),
                conversationContext: this.conversationContexts.get(id),
                researchChatOptimization: state.researchChatOptimization,
              }),
            )) as string;
          }
          const citationReportAfter = this.synthesisProvider.metrics?.citationEntailment;
          citationValidationFailed =
            evidence.sufficient &&
            hasCitationValidationFailure(
              citationReportBefore,
              citationReportAfter,
              answer,
              evidenceSources.length,
            );
          synthesisCompleted =
            Boolean(answer?.trim()) &&
            !/^Insufficient evidence|^Research collected evidence but cannot/i.test(answer) &&
            this.synthesisProvider.metrics?.synthesis?.finalAnswerSource !== "unavailable";
          const synthDur = Math.round(performance.now() - synthStart);
          stageTimings["synthesize"] = synthDur;
          await this.step(
            id,
            "✍️ synthesize",
            "complete",
            answer.startsWith("Model synthesis ")
              ? "OpenRouter failed; returned only verified, source-linked findings."
              : undefined,
            synthDur,
          );
          break;
        }
        const actionStart = performance.now();
        const stageByAction: Record<Action, string> = {
          web_search: "serper",
          source_triage: "source_triage",
          fetch_url: "retrieval",
          extract_claims: "claim_extraction",
          gather_evidence: "evidence_gathering",
          verify_claims: "verification",
          detect_conflicts: "conflict_detection",
          search_again: "search_recovery",
          synthesize: "synthesis",
        };
        await runResearchStage(stageByAction[action], () =>
          this.executeAction(id, state, action, budget),
        );
        const actionDur = Math.round(performance.now() - actionStart);
        stageTimings[action] = (stageTimings[action] ?? 0) + actionDur;
        iterations += 1;
        state.actionsExecuted = iterations;
        await this.update(id, { stageTimings });
      }
      if (!answer)
        await this.step(
          id,
          "🛑 budget exhausted",
          "complete",
          `Stopped safely after ${iterations} research actions within the configured session budget`,
        );
      if (!answer && state.claims.length > 0 && this.assessEvidence(state).sufficient) {
        state.fetchedSources.sort(
          (left, right) =>
            Number(Boolean(left.subjectMismatchReason)) -
            Number(Boolean(right.subjectMismatchReason)),
        );
        const evidenceSources = state.fetchedSources.filter(
          (source) => !source.subjectMismatchReason,
        );
        const synthesisClaims = this.synthesisClaims(state);
        await this.recordDecision(id, {
          controllerDecision: "fallback",
          nextAction: "synthesize",
          reason:
            "evidence is sufficient after the bounded research action budget; finalize without another research action",
        });
        await this.step(
          id,
          "✍️ synthesize",
          "running",
          "Synthesizing answer from gathered evidence",
        );
        try {
          const budgetResearchState = this.computeResearchState(state);
          const synthStart = performance.now();
          const citationReportBefore = this.synthesisProvider.metrics?.citationEntailment;
          answer = (await runResearchStage("synthesis", () =>
            this.registry.execute("synthesize", {
              kind: "research",
              question: session.question,
              plan: state.plan,
              sources: evidenceSources,
              claims: synthesisClaims,
              researchState: budgetResearchState,
              mode: session.mode,
              memoryContext: this.memoryContexts.get(id),
              conversationContext: this.conversationContexts.get(id),
              researchChatOptimization: state.researchChatOptimization,
            }),
          )) as string;
          const citationReportAfter = this.synthesisProvider.metrics?.citationEntailment;
          citationValidationFailed = hasCitationValidationFailure(
            citationReportBefore,
            citationReportAfter,
            answer,
            evidenceSources.length,
          );
          synthesisCompleted =
            Boolean(answer?.trim()) &&
            !/^Insufficient evidence|^Research collected evidence but cannot/i.test(answer) &&
            this.synthesisProvider.metrics?.synthesis?.finalAnswerSource !== "unavailable";
          const synthDur = Math.round(performance.now() - synthStart);
          stageTimings["synthesize"] = synthDur;
          await this.step(
            id,
            "✍️ synthesize",
            "complete",
            answer.startsWith("Model synthesis ")
              ? "OpenRouter failed; returned only verified, source-linked findings."
              : undefined,
            synthDur,
          );
        } catch {
          // fallback below
        }
      }
      const finalEvidence = this.assessEvidence(state);
      if (!finalEvidence.sufficient) {
        answer = `Insufficient evidence to provide a verified answer: ${finalEvidence.reasons.join("; ")}.`;
      } else if (!answer) {
        answer = `Research reached its bounded ${budget.maxSteps}-step budget before synthesis. Evidence was collected, but MAX could not produce a final answer.`;
      }
      const terminalError = !finalEvidence.sufficient
        ? `${INSUFFICIENT_EVIDENCE_ERROR_PREFIX} ${finalEvidence.reasons.join("; ")}`
        : hasResearchChatFinalCoverageFailure(
              state.researchChatOptimization,
              this.synthesisProvider.metrics?.synthesis?.requiredFactCoverage,
            )
          ? `${INSUFFICIENT_EVIDENCE_ERROR_PREFIX} the final answer omitted required facts: ${this.synthesisProvider.metrics?.synthesis?.requiredFactCoverage.missing.join(", ") ?? "one or more required facts"}`
          : citationValidationFailed
            ? `${CITATION_VALIDATION_ERROR_PREFIX} the final answer did not pass semantic or structural citation validation.`
            : !synthesisCompleted
              ? `${RESEARCH_INCOMPLETE_ERROR_PREFIX} the run ended before a final answer was synthesized.`
              : undefined;
      const terminalStatus = terminalError ? "FAILED" : "COMPLETED";
      const finalResearchState = this.computeResearchState(state);
      throwIfResearchInactive();
      const complete = await this.update(id, {
        status: terminalStatus,
        sources: state.fetchedSources.length ? state.fetchedSources : state.rankedSources,
        claims: state.claims,
        conflicts: state.conflicts,
        plan: state.plan,
        state: finalResearchState,
        sourceSelectionDecisions: state.sourceSelectionDecisions,
        searchRecoveries: state.searchRecoveries,
        coverage: finalResearchState.coverage,
        answer,
        error: terminalError,
        stageTimings,
      });
      if (complete)
        this.emit(id, {
          type: terminalStatus === "COMPLETED" ? "research.completed" : "research.failed",
          message:
            terminalStatus === "COMPLETED"
              ? "Research completed with sufficient evidence"
              : (terminalError ?? "Research did not produce a validated answer"),
          session: complete,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Research failed";
      const current = await this.store.get(id);
      if (current?.status === "CANCELLED") return;
      const execution = getResearchExecutionContext();
      if (current && ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return;
      if (execution?.signal.aborted || (execution && Date.now() >= execution.deadlineAt))
        throw error;
      const failed = await this.update(id, {
        ...execution?.capturePartialState?.(),
        status: "FAILED",
        error: message,
        failureStage: activeResearchStage() ?? "research",
        stageTimings: researchStageTimingsSnapshot(),
      });
      this.emit(id, { type: "research.failed", message, session: failed });
    }
  }
}
