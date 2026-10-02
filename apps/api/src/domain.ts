import type {
  EvidenceStatus,
  RequestedFactCoverage,
  RequestedFactKind,
  RequestedFactRequirements,
} from "./requested-facts.js";

export type ResearchMode = "quick" | "deep";
export type ResearchStatus =
  | "QUEUED"
  | "PLANNING"
  | "NEEDS_CLARIFICATION"
  | "SEARCHING"
  | "FETCHING"
  | "ANALYZING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type QueryCategory = "DIRECT" | "OFFICIAL" | "RECENT" | "EXPERT" | "CONTRARY";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  position?: number;
  publishedAt?: string;
  provider?: string;
  providers?: string[];
  query?: string;
  discoveredAt?: string;
}

export interface FirstPartySourceClassification {
  entity: string;
  repository: string;
  contentKind: "repository" | "release_history" | "changelog";
}

export type ReleaseHistorySourceKind =
  | "official_history_page"
  | "github_releases_html"
  | "github_releases_feed"
  | "first_party_structured";

export interface Source extends SearchResult {
  id: string;
  domain: string;
  pagePublishedAt?: string;
  sourceType?:
    | "official"
    | "documentation"
    | "academic"
    | "government"
    | "news"
    | "blog"
    | "forum"
    | "commercial"
    | "unknown";
  firstPartyClassification?: FirstPartySourceClassification;
  releaseHistorySourceKind?: ReleaseHistorySourceKind;
  releaseHistoryComplete?: boolean;
  retrievalSourceUrl?: string;
  content?: string;
  fetchedAt?: string;
  quality: {
    relevance: number;
    authority: number;
    freshness: number;
    completeness: number;
    overall: number;
  };
  fetchError?: string;
  fetchFailureCategory?: "EXTRACTION" | "HTTP" | "UNSUPPORTED" | "NETWORK" | "TIMEOUT" | "UNKNOWN";
  canonicalUrl?: string;
  retrievalMethod?: "serper_snippet" | "rss" | "structured" | "http" | "browser" | "cache" | "pdf";
  extractionStatus?: "SUCCEEDED" | "INSUFFICIENT_CONTENT" | "FAILED";
  extractionConfidence?: number;
  retrievedContentLength?: number;
  retrievalAttempts?: string[];
  retrievalMethodsSkipped?: string[];
  retrievalReasons?: string[];
  subjectMismatchReason?: string;
  taskEvidence?: {
    status: EvidenceStatus | "UNVERIFIED";
    missingFacts: string[];
    presentFacts?: string[];
  };
}
export type OfficialSourceRequirement = "none" | "preferred" | "required";

export interface SourceSelectionDecision {
  query: string;
  sourceId: string;
  title: string;
  snippet: string;
  url: string;
  domain: string;
  sourceType?: Source["sourceType"];
  firstPartyClassification?: FirstPartySourceClassification;
  officialSource: boolean;
  officialSourceRequirement: OfficialSourceRequirement;
  selected: boolean;
  reason: string;
  subjectMismatchReason?: string;
  taskEvidence?: Source["taskEvidence"];
  quality: Source["quality"];
}

export type ObjectiveStatus = "pending" | "investigating" | "fulfilled" | "partial" | "blocked";
export type ObjectiveImportance = "critical" | "high" | "medium" | "low";
export type ClaimImportance = "critical" | "high" | "medium" | "low";

export interface ResearchObjective {
  id: string;
  label: string;
  category: string;
  importance: ObjectiveImportance;
  status: ObjectiveStatus;
  evidenceIds: string[];
  sourceIds: string[];
  coverage: number;
  requiredFacts?: RequestedFactKind[];
  presentFacts?: RequestedFactKind[];
  missingFacts?: RequestedFactKind[];
  dependsOn?: string[];
  requiresOfficialSource?: boolean;
  officialSourceSatisfied?: boolean;
  keyFinding?: string;
}

export interface ResearchState {
  objectives: ResearchObjective[];
  completedObjectives: string[];
  missingObjectives: string[];
  queries: string[];
  sources: Source[];
  claims: Claim[];
  conflicts: Conflict[];
  verifiedClaims: Claim[];
  currentHypothesis?: string;
  nextBestAction?: string;
  coverage: number;
  evidenceStatus?: EvidenceStatus;
  requestedFactCoverage?: RequestedFactCoverage;
  objectiveCoverage?: Array<{
    objectiveId: string;
    status: ObjectiveStatus;
    requiredFacts: RequestedFactKind[];
    presentFacts: RequestedFactKind[];
    missingFacts: RequestedFactKind[];
    sourceIds: string[];
    claimIds: string[];
    officialSourceSatisfied?: boolean;
  }>;
  missingRequestedFacts?: string[];
  latestnessAssessment?: LatestnessAssessment;
  releaseRecords?: ReleaseEvidenceRecord[];
}

export interface VersionEvidenceCandidate {
  entity: string;
  version: string;
  releaseChannel?: string;
  stability: "stable" | "prerelease" | "unknown";
  withdrawn?: boolean;
  sourceIds: string[];
  claimIds: string[];
  latestnessSourceIds: string[];
  releaseDates: string[];
  explicitlyLatest: boolean;
}

export interface ReleaseEvidenceRecord {
  entity: string;
  version: string;
  releaseChannel?: string;
  releaseDate?: string;
  pageDate?: string;
  releaseDateReason?:
    "versioned-release-statement" | "dated-release-announcement" | "publication-date-only";
  dateAssociationReason?:
    "versioned-release-statement" | "dated-release-announcement" | "publication-date-only";
  releaseDateEvidence?: string;
  releaseDateSourceIds?: string[];
  releaseDateClaimIds?: string[];
  releaseDateEvidenceIds?: string[];
  releaseDateConfidence?: number;
  releaseDateExplicit?: boolean;
  releaseDateOrigin?: "claim" | "content" | "page_metadata" | "url" | "snippet";
  releaseDateConflicts?: string[];
  versionSourceIds?: string[];
  versionClaimIds?: string[];
  versionConfidence?: number;
  versionExplicit?: boolean;
  stability: "stable" | "prerelease" | "unknown";
  withdrawn?: boolean;
  withdrawalEvidence?: string;
  stabilityEvidence?: string;
  stabilityConfidence?: number;
  stabilityExplicit?: boolean;
  stabilityReason?:
    | "explicit-version-release"
    | "stable-release-list"
    | "complete-stable-history"
    | "prerelease-version"
    | "feature-stability-only"
    | "not-established";
  featureStabilityEvidence?: string;
  stabilitySourceIds?: string[];
  stabilityClaimIds?: string[];
  stabilityEvidenceIds?: string[];
  stabilityConflicts?: Array<"stable" | "prerelease">;
  latestnessEvidence?: string;
  explicitlyLatest?: boolean;
  latestnessConfidence?: number;
  latestnessExplicit?: boolean;
  latestnessSourceIds?: string[];
  latestnessClaimIds?: string[];
  evidenceIds?: string[];
  sourceId: string;
  sourceIds?: string[];
  claimIds: string[];
  sourceType?: Source["sourceType"];
  officialSource: boolean;
  firstPartyClassification?: FirstPartySourceClassification;
  releaseHistorySourceKind?: ReleaseHistorySourceKind;
  releaseHistoryComplete?: boolean;
}

export interface VersionEvidenceComparison {
  olderVersion: string;
  newerVersion: string;
  sourceIds: string[];
}

export type LatestnessUnresolvedReason =
  | "ambiguous_entity"
  | "conflicting_official_sources"
  | "conflicting_release_stability"
  | "incomplete_official_history"
  | "insufficient_version_comparison"
  | "no_verified_release_candidates"
  | "release_stability_unresolved";

export interface LatestnessUnresolvedState {
  status: "unresolved";
  reason: LatestnessUnresolvedReason;
  candidates: Array<{
    entity: string;
    version: string;
    releaseChannel?: string;
    stability: "stable" | "prerelease" | "unknown";
    withdrawn: boolean;
    sourceIds: string[];
  }>;
  unresolvedReasons: string[];
  recommendedNextAction: "retrieve_additional_official_evidence";
}

export interface LatestnessAssessment {
  required: boolean;
  conclusion: "PROVEN" | "CANDIDATE_ONLY" | "UNRESOLVED";
  proof?: "explicit-official-claim" | "complete-official-history";
  proofEvidence?: string;
  requestedEntity?: string;
  highestCandidateVersion?: string;
  latestVersion?: string;
  candidateVersions: VersionEvidenceCandidate[];
  releaseRecords: ReleaseEvidenceRecord[];
  comparisons: VersionEvidenceComparison[];
  stabilityConflicts?: Array<{
    entity: string;
    version: string;
    stabilities: Array<"stable" | "prerelease">;
    sourceIds: string[];
  }>;
  supportingSourceIds: string[];
  completeHistorySourceIds: string[];
  releaseHistoryResolution?: {
    attemptedKinds: ReleaseHistorySourceKind[];
    selectedKind?: ReleaseHistorySourceKind;
    recordCount: number;
    complete: boolean;
    sourceIds: string[];
  };
  unresolvedReasons: string[];
  unresolvedState?: LatestnessUnresolvedState;
}

export interface Claim {
  id: string;
  text: string;
  sourceIds: string[];
  evidence: string;
  confidence: number;
  importance?: ClaimImportance;
  objectiveId?: string;
  requestedFacts?: RequestedFactKind[];
  verification?: {
    verdict: "supported" | "contradicted" | "uncertain" | "unavailable";
    rationale?: string;
  };
}
export interface Conflict {
  id: string;
  claimIds: string[];
  sourceIds: string[];
  description: string;
  status: "open" | "resolved" | "uncertain";
}
export interface LanguageProfile {
  detected: string;
  name: string;
  respondIn: string;
}

export type ResponseFormatPreference = "direct" | "lookup" | "comparison" | "research" | "code";

export interface QueryInterpretation {
  normalizedQuestion: string;
  intent: string;
  entities: string[];
  topic: string;
  timeframe?: string;
  dimensions: string[];
  corrections: Array<{ from: string; to: string; confidence: number }>;
  ambiguityScore: number;
  ambiguityReasons: string[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  language?: LanguageProfile;
  formatPreference?: ResponseFormatPreference;
  sourceRequirements?: {
    officialSources: OfficialSourceRequirement;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQueryInterpretation(value: unknown): value is QueryInterpretation {
  if (!isRecord(value)) return false;
  if (
    typeof value.normalizedQuestion !== "string" ||
    typeof value.intent !== "string" ||
    !Array.isArray(value.entities) ||
    !value.entities.every((entity) => typeof entity === "string") ||
    typeof value.topic !== "string" ||
    (value.timeframe !== undefined && typeof value.timeframe !== "string") ||
    !Array.isArray(value.dimensions) ||
    !value.dimensions.every((dimension) => typeof dimension === "string") ||
    !Array.isArray(value.corrections) ||
    !value.corrections.every(
      (correction) =>
        isRecord(correction) &&
        typeof correction.from === "string" &&
        typeof correction.to === "string" &&
        typeof correction.confidence === "number" &&
        Number.isFinite(correction.confidence) &&
        correction.confidence >= 0 &&
        correction.confidence <= 1,
    ) ||
    typeof value.ambiguityScore !== "number" ||
    !Number.isFinite(value.ambiguityScore) ||
    value.ambiguityScore < 0 ||
    value.ambiguityScore > 1 ||
    !Array.isArray(value.ambiguityReasons) ||
    !value.ambiguityReasons.every((reason) => typeof reason === "string") ||
    typeof value.needsClarification !== "boolean" ||
    (value.clarificationQuestion !== undefined && typeof value.clarificationQuestion !== "string")
  ) {
    return false;
  }

  if (value.language !== undefined) {
    if (
      !isRecord(value.language) ||
      typeof value.language.detected !== "string" ||
      typeof value.language.name !== "string" ||
      typeof value.language.respondIn !== "string"
    ) {
      return false;
    }
  }

  const formats: ResponseFormatPreference[] = [
    "direct",
    "lookup",
    "comparison",
    "research",
    "code",
  ];
  if (
    value.formatPreference !== undefined &&
    !formats.includes(value.formatPreference as ResponseFormatPreference)
  ) {
    return false;
  }

  const sourceRequirements = value.sourceRequirements;
  if (
    sourceRequirements !== undefined &&
    (!isRecord(sourceRequirements) ||
      !["none", "preferred", "required"].includes(String(sourceRequirements.officialSources)))
  ) {
    return false;
  }

  return true;
}

export interface QueryGroup {
  category: QueryCategory;
  queries: string[];
}
export interface ResearchPlan {
  objectives: string[];
  structuredObjectives?: ResearchObjective[];
  requestedFacts: RequestedFactKind[];
  requestedFactRequirements: RequestedFactRequirements;
  queries: string[];
  queryGroups: QueryGroup[];
  interpretation: QueryInterpretation;
}

export interface ResearchRecoveryRequirements {
  requestedFacts: RequestedFactKind[];
  resolvedFacts: RequestedFactKind[];
  unresolvedFacts: RequestedFactKind[];
  factInsufficientSources?: Array<{
    url: string;
    canonicalUrl?: string;
    missingFacts: RequestedFactKind[];
  }>;
  latestnessRequired: boolean;
  latestnessResolved: boolean;
  knownVersionCandidates?: string[];
  qualifiers: {
    latest: boolean;
    stable: boolean;
  };
  officialSourceRequirement: OfficialSourceRequirement;
  officialEvidenceResolved: boolean;
}

export interface ResearchSession {
  id: string;
  question: string;
  mode: ResearchMode;
  status: ResearchStatus;
  createdAt: string;
  updatedAt: string;
  plan?: ResearchPlan;
  seedResults?: SearchResult[];
  sourceSelectionDecisions?: SourceSelectionDecision[];
  searchRecoveries?: Array<{
    reason: string[];
    missingRequestedFacts: string[];
    officialSourceRequirement: OfficialSourceRequirement;
    queries: string[];
    requirements?: ResearchRecoveryRequirements;
    queryValidation?: {
      candidate: string;
      accepted: boolean;
      reasons: string[];
    };
  }>;
  sources: Source[];
  claims: Claim[];
  conflicts?: Conflict[];
  decisions?: ResearchDecision[];
  state?: ResearchState;
  coverage?: number;
  answer?: string;
  error?: string;
  failureStage?: string;
  stageTimings?: Record<string, number>;
  steps: ResearchStep[];
  searchAttempts?: Array<{
    provider: string;
    query: string;
    status: "success" | "empty" | "failed";
    resultCount: number;
    durationMs: number;
    error?: string;
    errorCode?: string;
  }>;
}
export interface ResearchStep {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  label: string;
  detail?: string;
  at: string;
  durationMs?: number;
}
export interface ResearchDecision {
  id: string;
  requestedAction?: string;
  controllerDecision: "allow" | "override" | "fallback";
  nextAction: string;
  reason: string;
  at: string;
}
export type ResearchEvent = {
  type:
    | "research.step"
    | "source.found"
    | "research.clarification"
    | "research.completed"
    | "research.cancelled"
    | "research.failed";
  message: string;
  step?: ResearchStep;
  session?: ResearchSession;
};
