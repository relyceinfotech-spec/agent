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
  publishedAt?: string;
}
export interface Source extends SearchResult {
  id: string;
  domain: string;
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
}

export interface Claim {
  id: string;
  text: string;
  sourceIds: string[];
  evidence: string;
  confidence: number;
  importance?: ClaimImportance;
  objectiveId?: string;
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
}
export interface QueryGroup {
  category: QueryCategory;
  queries: string[];
}
export interface ResearchPlan {
  objectives: string[];
  structuredObjectives?: ResearchObjective[];
  queries: string[];
  queryGroups: QueryGroup[];
  interpretation: QueryInterpretation;
}
export interface ResearchSession {
  id: string;
  question: string;
  mode: ResearchMode;
  status: ResearchStatus;
  createdAt: string;
  updatedAt: string;
  plan?: ResearchPlan;
  sources: Source[];
  claims: Claim[];
  conflicts?: Conflict[];
  decisions?: ResearchDecision[];
  state?: ResearchState;
  coverage?: number;
  answer?: string;
  error?: string;
  steps: ResearchStep[];
}
export interface ResearchStep {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  label: string;
  detail?: string;
  at: string;
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
    | "research.failed";
  message: string;
  step?: ResearchStep;
  session?: ResearchSession;
};
