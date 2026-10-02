import type { Claim, Source } from "./domain.js";

export type TopicStatus = "CANDIDATE" | "SELECTED" | "RESEARCHED" | "PUBLISHED" | "REJECTED";

export interface TopicCandidate {
  id: string;
  title: string;
  url: string;
  summary: string;
  provider: string;
  publishedAt?: string;
  discoveredAt: string;
  score: number;
  status: TopicStatus;
}

export type AutonomousRunStatus =
  | "QUEUED"
  | "DISCOVERING"
  | "RESEARCHING"
  | "QUALITY_GATE"
  | "PUBLISHED"
  | "REQUIRES_REVIEW"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED";

export interface AutonomousRunEvent {
  at: string;
  stage: string;
  status: "started" | "complete" | "failed" | "skipped";
  detail: string;
  durationMs?: number;
}

export interface AutonomousRun {
  id: string;
  trigger: "manual" | "schedule" | "retry";
  status: AutonomousRunStatus;
  createdAt: string;
  updatedAt: string;
  topicId?: string;
  researchId?: string;
  postId?: string;
  retryOf?: string;
  error?: string;
  events: AutonomousRunEvent[];
}

export interface ResearchPost {
  id: string;
  topicId: string;
  researchId: string;
  title: string;
  summary: string;
  whyItMatters: string;
  findings: Array<{ claimId: string; text: string; sourceIds: string[] }>;
  caveats: string[];
  sources: Source[];
  claims: Claim[];
  publishedAt: string;
  researchedAt: string;
  category: string;
}

export type QualityGateStatus =
  "READY_TO_PUBLISH" | "REQUIRES_RESEARCH" | "REQUIRES_REVIEW" | "REJECTED" | "FAILED";

export interface QualityGateResult {
  status: QualityGateStatus;
  reasons: string[];
  usefulSources: number;
  supportedClaims: number;
  sourceDomains: number;
}

export interface ResearchFollowUp {
  id: string;
  postId: string;
  question: string;
  status: "QUEUED" | "RESEARCHING" | "SYNTHESIZING" | "COMPLETED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  liveResearchId?: string;
  usedLiveResearch: boolean;
  answer?: string;
  sourceIds: string[];
  sources?: Source[];
  error?: string;
}
