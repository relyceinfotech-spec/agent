import { randomUUID } from "node:crypto";
import type { ResearchSession } from "./domain.js";
import type { Claim, Source } from "./domain.js";
import type { QualityGateResult, ResearchPost, TopicCandidate } from "./content-domain.js";
import { extractKnownEntities, subjectEntityMismatchReason } from "./entities.js";
import { bindVerifiedEndOfLifeClaimToSource } from "./research-chat-fact-gate.js";
import { hasCompleteRequestedFactCoverage, requestedFactCoverage } from "./requested-facts.js";
import { canonicalizeUrl } from "./security.js";

interface PublishableClaim {
  claim: Claim;
  sourceIds: string[];
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionsByEntity(value: string): Array<{ entity: string; version: string }> {
  return extractKnownEntities(value).flatMap((entity) => {
    const pattern = new RegExp(
      `\\b${escapeRegExp(entity)}\\s+(?:(?:version)\\s+|v\\s*)?(\\d+(?:\\.\\d+){0,3})\\b`,
      "gi",
    );
    return [...value.matchAll(pattern)].flatMap((match) =>
      match[1] ? [{ entity, version: match[1] }] : [],
    );
  });
}

function versionIsBoundToEvidence(claimText: string, evidence: string): boolean {
  const evidenceVersions = versionsByEntity(evidence);
  return versionsByEntity(claimText).every(({ entity, version }) =>
    evidenceVersions.some(
      (candidate) =>
        candidate.entity.toLowerCase() === entity.toLowerCase() &&
        version.split(".").every((part, index) => candidate.version.split(".")[index] === part),
    ),
  );
}

function sourceBoundEvidenceBody(evidence: string, source: Source): string | undefined {
  let body = evidence.trim();
  const titleMetadata = /^Page title metadata:\s*([^\r\n]+)\r?\n/i.exec(body);
  if (titleMetadata) {
    if (normalizeEvidenceText(titleMetadata[1] ?? "") !== normalizeEvidenceText(source.title)) {
      return undefined;
    }
    body = body.slice(titleMetadata[0].length).trim();
  }
  const anchor = normalizeEvidenceText(body).slice(0, 60);
  return anchor.length === 60 && normalizeEvidenceText(source.content ?? "").includes(anchor)
    ? body
    : undefined;
}

function entityScopedEvidence(claimText: string, evidence: string): string {
  const claimVersions = versionsByEntity(claimText);
  const statements = evidence.split(/\r?\n+|(?<=[.!?;])\s+/);
  if (claimVersions.length === 0) return evidence;
  const matchingStatements = statements.filter((statement) =>
    claimVersions.some(({ entity, version }) =>
      versionsByEntity(statement).some(
        (candidate) =>
          candidate.entity.toLowerCase() === entity.toLowerCase() &&
          version.split(".").every((part, index) => candidate.version.split(".")[index] === part),
      ),
    ),
  );
  return matchingStatements.length > 0 ? matchingStatements.join(" ") : evidence;
}

function sourceSupportsPublishableClaim(
  session: ResearchSession,
  claim: Claim,
  source: Source,
): boolean {
  if (
    claim.latestnessDisposition?.status === "superseded" ||
    claim.verification?.verdict !== "supported" ||
    claim.evidence.length < 80 ||
    !claim.sourceIds.includes(source.id)
  ) {
    return false;
  }

  const factPassage = sourceBoundEvidenceBody(claim.evidence, source);
  if (!factPassage) return false;
  const entityPassage = entityScopedEvidence(claim.text, factPassage);
  if (subjectEntityMismatchReason(claim.text, entityPassage)) return false;
  const claimEntities = extractKnownEntities(claim.text);
  const evidenceEntities = extractKnownEntities(entityPassage);
  if (claimEntities.some((entity) => !evidenceEntities.includes(entity))) return false;
  if (!versionIsBoundToEvidence(claim.text, entityPassage)) return false;

  const officialSourcesRequired =
    session.plan?.interpretation.sourceRequirements?.officialSources === "required";
  if (
    officialSourcesRequired &&
    source.sourceType !== "official" &&
    !source.firstPartyClassification
  ) {
    return false;
  }

  const requestedFacts = claim.requestedFacts ?? [];
  const lifecycleClaim =
    requestedFacts.includes("end-of-life date") ||
    /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|unsupported after)\b/i.test(claim.text);
  if (lifecycleClaim) {
    const binding = bindVerifiedEndOfLifeClaimToSource(
      session.question,
      claim,
      source,
      officialSourcesRequired,
    );
    if (binding.outcome !== "EXACT_SUPPORT") return false;
  }

  const otherRequestedFacts = requestedFacts.filter((fact) => fact !== "end-of-life date");
  if (otherRequestedFacts.length === 0) return true;

  const releaseEvidence = (session.state?.releaseRecords ?? [])
    .filter(
      (record) =>
        (record.sourceId === source.id || record.sourceIds?.includes(source.id)) &&
        record.versionClaimIds?.includes(claim.id),
    )
    .map((record) => {
      const dateBoundToClaim = record.releaseDateClaimIds?.includes(claim.id) ?? false;
      const stabilityBoundToClaim = record.stabilityClaimIds?.includes(claim.id) ?? false;
      return {
        entity: record.entity,
        version: record.version,
        releaseDate: dateBoundToClaim ? record.releaseDate : undefined,
        stability: stabilityBoundToClaim ? record.stability : "unknown",
        officialSource: record.officialSource,
        releaseDateClaimIds: dateBoundToClaim ? [claim.id] : [],
        releaseDateConflicts: dateBoundToClaim ? record.releaseDateConflicts : undefined,
        stabilityConflicts: stabilityBoundToClaim ? record.stabilityConflicts : undefined,
      };
    });
  const latestnessAssessment = session.state?.latestnessAssessment;
  const requestedVersion = versionsByEntity(claim.text).find((version) =>
    extractKnownEntities(claim.text).includes(version.entity),
  )?.version;
  const latestnessProven = otherRequestedFacts.includes("latestness")
    ? Boolean(
        latestnessAssessment?.conclusion === "PROVEN" &&
        latestnessAssessment.latestVersion &&
        requestedVersion &&
        latestnessAssessment.latestVersion
          .split(".")
          .every((part, index) => requestedVersion.split(".")[index] === part) &&
        latestnessAssessment.supportingSourceIds.includes(source.id),
      )
    : undefined;
  const coverage = requestedFactCoverage(session.question, factPassage, {
    requestedFacts: otherRequestedFacts,
    releaseEvidence,
    latestnessProven,
    latestnessVersion: latestnessAssessment?.latestVersion,
    officialSourcesRequired,
  });
  return hasCompleteRequestedFactCoverage(coverage);
}

function usefulSources(session: ResearchSession): Source[] {
  return session.sources.filter((source) =>
    Boolean(
      source.content &&
      source.content.length >= 120 &&
      source.contentOrigin !== "metadata" &&
      source.retrievalMethod !== "serper_snippet" &&
      !source.fetchError &&
      source.quality.overall >= 0.4,
    ),
  );
}

function publishableClaims(session: ResearchSession, sources: Source[]): PublishableClaim[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return session.claims.flatMap((claim) => {
    const sourceIds = [...new Set(claim.sourceIds)].filter((sourceId) => {
      const source = sourceById.get(sourceId);
      return source ? sourceSupportsPublishableClaim(session, claim, source) : false;
    });
    return sourceIds.length > 0 ? [{ claim, sourceIds }] : [];
  });
}

export function evaluatePostQuality(
  topic: TopicCandidate,
  session: ResearchSession,
  existingPosts: ResearchPost[],
): QualityGateResult {
  const reasons: string[] = [];
  if (existingPosts.some((post) => post.topicId === topic.id)) {
    return {
      status: "REJECTED",
      reasons: ["Topic is already published"],
      usefulSources: 0,
      supportedClaims: 0,
      sourceDomains: 0,
    };
  }
  const useful = usefulSources(session);
  const domains = new Set(useful.map((source) => source.domain.replace(/^www\./, "")));
  const supported = publishableClaims(session, useful);
  const claimSources = new Set(supported.flatMap((entry) => entry.sourceIds));
  const supportedDomains = new Set(
    useful
      .filter((source) => claimSources.has(source.id))
      .map((source) => source.domain.replace(/^www\./, "")),
  );
  if (session.status !== "COMPLETED") reasons.push("Research run did not complete");
  if (useful.length < 2) reasons.push("Fewer than two usable fetched sources");
  if (domains.size < 2) reasons.push("Sources lack independent domain diversity");
  if (supported.length < 2 || claimSources.size < 2 || supportedDomains.size < 2) {
    reasons.push("Too few verified claims supported by independent sources");
  }
  if (!useful.some((source) => canonicalizeUrl(source.url) === canonicalizeUrl(topic.url))) {
    reasons.push("Original topic source was not fetched and validated");
  }
  if (topic.publishedAt) {
    const publishedAt = Date.parse(topic.publishedAt);
    if (!Number.isFinite(publishedAt) || Date.now() - publishedAt > 14 * 86_400_000) {
      reasons.push("Topic is no longer fresh enough for autonomous publication");
    }
  }
  const evidenceIssue = reasons.length > 0;
  if (session.conflicts?.some((conflict) => conflict.status === "open")) {
    reasons.push("Open source conflict requires review");
  }
  if (
    !session.answer ||
    session.answer.length < 120 ||
    /budget exhausted|reached its bounded.{0,80}budget|not sufficiently verified|cannot present.{0,80}sufficiently verified|without enough extractable evidence|automated synthesis is unavailable|openrouter is not configured|model synthesis (?:failed|timed out)|couldn't verify a sufficiently supported answer|available evidence is insufficient/i.test(
      session.answer,
    )
  ) {
    reasons.push("Research synthesis is incomplete or explicitly uncertain");
  }
  const status =
    reasons.length === 0
      ? "READY_TO_PUBLISH"
      : evidenceIssue
        ? "REQUIRES_RESEARCH"
        : "REQUIRES_REVIEW";
  return {
    status,
    reasons,
    usefulSources: useful.length,
    supportedClaims: supported.length,
    sourceDomains: domains.size,
  };
}

/** Assemble publication text from verified claim text; no unsupported facts are invented. */
export function postFromResearch(topic: TopicCandidate, session: ResearchSession): ResearchPost {
  const eligibleSources = usefulSources(session);
  const eligibleClaims = publishableClaims(session, eligibleSources).slice(0, 8);
  const claims = eligibleClaims.map(({ claim, sourceIds }) => ({ ...claim, sourceIds }));
  const sourceIds = new Set(eligibleClaims.flatMap((entry) => entry.sourceIds));
  const useful = eligibleSources.filter((source) => sourceIds.has(source.id));
  const findings = claims.map((claim) => ({
    claimId: claim.id,
    text: claim.text,
    sourceIds: claim.sourceIds.filter((id) => sourceIds.has(id)),
  }));
  const summary = findings
    .slice(0, 2)
    .map((finding) => finding.text)
    .join(" ")
    .slice(0, 550);
  const caveats = [
    ...(session.conflicts ?? [])
      .filter((conflict) => conflict.status === "open")
      .map((conflict) => conflict.description),
    ...session.claims
      .filter((claim) => claim.verification?.verdict === "uncertain")
      .slice(0, 3)
      .map((claim) => `Uncertain: ${claim.text}`),
  ];
  return {
    id: randomUUID(),
    topicId: topic.id,
    researchId: session.id,
    title: topic.title,
    summary,
    whyItMatters: `MAX investigated this development using ${useful.length} retrieved sources. Review the linked findings and caveats before drawing conclusions.`,
    findings,
    caveats,
    sources: useful,
    claims,
    publishedAt: new Date().toISOString(),
    researchedAt: session.updatedAt,
    category: session.plan?.interpretation.topic ?? "Research",
  };
}
