import type {
  Claim,
  LatestnessAssessment,
  ReleaseEvidenceRecord,
  ResearchPlan,
  ResearchState,
  Source,
} from "./domain.js";
import { containsExactEntity, extractKnownEntities } from "./entities.js";
import {
  claimTextSupportsStructuredFact,
  extractRequestedFacts,
  requestedFactCoverage,
  requestedPredicatePresent,
  type RequestedFactCoverage,
  type RequestedFactKind,
  type RequestedPredicateRequirement,
  type ReleaseFactEvidence,
} from "./requested-facts.js";
import type { ControllerVerifiedStatement } from "./citation-entailment.js";
import {
  bindVerifiedEndOfLifeClaimToSource,
  enforceResearchChatBoundedFactCoverage,
} from "./research-chat-fact-gate.js";
import { compareVersions } from "./version-evidence.js";
import {
  buildClaimSourceReliance,
  isFirstPartySourceForEntities,
  qualifySingleThirdPartyClaim,
  type ClaimSourceReliance,
} from "./source-provenance.js";

export interface StructuredAnswerStatement {
  text: string;
  sourceIds: string[];
}

export interface DeterministicResearchAnswer {
  answer: string;
  statements: StructuredAnswerStatement[];
  controllerVerifiedStatements: ControllerVerifiedStatement[];
  evidenceCoverage: RequestedFactCoverage;
  answerCoverage: RequestedFactCoverage;
  officialSourcesRequired: boolean;
}

/** Return one exact, source-bound JSON-LD role fact from a first-party page. */
export function firstPartyStructuredRoleForClaim(
  claim: Claim,
  source: Source,
  entities: string[],
  requirement: RequestedPredicateRequirement,
) {
  if (
    !claim.sourceIds.includes(source.id) ||
    !source.content?.trim() ||
    source.subjectMismatchReason ||
    !isFirstPartySourceForEntities(source, entities)
  ) {
    return undefined;
  }

  const sourceUrls = [source.url, source.canonicalUrl, source.retrievalSourceUrl];
  const matches = (source.structuredFacts ?? []).filter(
    (fact) =>
      sourceUrls.includes(fact.sourceUrl) &&
      claimTextSupportsStructuredFact(claim.text, fact, requirement),
  );
  const distinct = new Map(
    matches.map((fact) => [
      `${fact.entity}\u0000${fact.person}\u0000${fact.relationship}\u0000${fact.jobTitle}\u0000${fact.sourceUrl}`,
      fact,
    ]),
  );
  return distinct.size === 1 ? distinct.values().next().value : undefined;
}

/** Ensure a precise fact from one non-first-party publisher remains attributed. */
export function qualifyUncorroboratedThirdPartyFactStatements(
  statements: StructuredAnswerStatement[],
  claims: Claim[],
  sources: Source[],
  entities: string[],
  requirement: ResearchPlan["interpretation"]["requestedPredicate"],
): StructuredAnswerStatement[] {
  if (!requirement) return statements;
  const relianceByClaim = new Map<string, ClaimSourceReliance>(
    buildClaimSourceReliance(claims, sources, entities).map((summary) => [
      summary.claimId,
      summary,
    ]),
  );
  return statements.map((statement) => {
    if (!requestedPredicatePresent(statement.text, requirement)) return statement;
    const matching = claims
      .filter(
        (claim) =>
          claim.verification?.verdict === "supported" &&
          claim.sourceIds.some((sourceId) => statement.sourceIds.includes(sourceId)) &&
          requestedPredicatePresent(`${claim.text}. ${claim.evidence}`, requirement),
      )
      .map((claim) => relianceByClaim.get(claim.id))
      .filter((summary): summary is ClaimSourceReliance => Boolean(summary));
    if (matching.some((summary) => summary.corroboratedAcrossIndependentPublishers))
      return statement;
    const reliance = matching[0];
    if (!reliance) return statement;
    const text = qualifySingleThirdPartyClaim(statement.text, reliance);
    return text === statement.text ? statement : { ...statement, text };
  });
}

const MAX_STATEMENTS = 10;
const MAX_TEXT_CHARS = 500;
const MAX_SOURCES_PER_STATEMENT = 3;
const currentReleaseAssertionPattern =
  /\b(?:latest|newest|most recent|current)\b[^.!?\n]{0,100}\b(?:release|version)\b|\b(?:release|version)\b[^.!?\n]{0,100}\b(?:latest|newest|most recent|current)\b/i;
const versionMentionPattern =
  /\bv?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/gi;

function sentenceSegments(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'`(])|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isHistoricalLatestAssertion(sentence: string): boolean {
  return (
    /\b(?:previously|formerly|historically)\b[^.!?\n]{0,80}\b(?:latest|newest|most recent|current)\b/i.test(
      sentence,
    ) ||
    /\b(?:was|were|had been|used to be)\b[^.!?\n]{0,80}\b(?:latest|newest|most recent|current)\b[^.!?\n]{0,80}\b(?:as of|in 19\d{2}|in 20\d{2}|during|until|at the time|back then)\b/i.test(
      sentence,
    ) ||
    /\b(?:as of|in|during)\s+(?:19|20)\d{2}\b[^.!?\n]{0,80}\b(?:latest|newest|most recent|current)\b/i.test(
      sentence,
    ) ||
    /\b(?:latest|newest|most recent|current)\b[^.!?\n]{0,80}\b(?:as of|in|during)\s+(?:19|20)\d{2}\b/i.test(
      sentence,
    )
  );
}

function isExplicitHistoricalRelease(
  sentence: string,
  versionIndex: number,
  versionLength: number,
) {
  const context = sentence.slice(Math.max(0, versionIndex - 70), versionIndex + versionLength + 90);
  return /\b(?:previous|previously|prior|older|historical|historically|former(?:ly)?|no longer current|was released|were released|released\s+(?:on|in)|release(?:d)?\s+in|at that time|back then)\b/i.test(
    context,
  );
}

/**
 * A proven controller latest version is the canonical current version for its
 * requested entity. Keep explicit historical statements, but reject another
 * version presented as current or an older version with no historical framing.
 */
export function isLatestnessConsistentText(
  text: string,
  assessment: LatestnessAssessment | undefined,
): boolean {
  if (
    !assessment?.required ||
    assessment?.conclusion !== "PROVEN" ||
    !assessment.latestVersion ||
    !assessment.requestedEntity
  ) {
    return true;
  }

  const knownEntities = extractKnownEntities(text);
  if (!containsExactEntity(text, assessment.requestedEntity) && knownEntities.length > 0) {
    return true;
  }

  for (const sentence of sentenceSegments(text)) {
    const sentenceEntities = extractKnownEntities(sentence);
    if (sentenceEntities.length > 0 && !containsExactEntity(sentence, assessment.requestedEntity)) {
      continue;
    }
    const versions = [...sentence.matchAll(versionMentionPattern)];
    if (versions.length === 0) continue;

    const historicalLatest = isHistoricalLatestAssertion(sentence);
    const assertsCurrent = currentReleaseAssertionPattern.test(sentence);
    for (const version of versions) {
      const mentionedVersion = version[1];
      const versionIndex = version.index ?? 0;
      if (!mentionedVersion) continue;
      const comparison = compareVersions(mentionedVersion, assessment.latestVersion);
      const differsFromCurrent = comparison !== 0;
      if (differsFromCurrent && assertsCurrent && !historicalLatest) return false;

      if (
        comparison === -1 &&
        !isExplicitHistoricalRelease(sentence, versionIndex, version[0].length) &&
        !(assertsCurrent && historicalLatest)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Remove claims that could present a superseded release as current during synthesis. */
export function filterLatestnessClaims(
  claims: Claim[],
  latestnessRequested: boolean,
  assessment: LatestnessAssessment | undefined,
): Claim[] {
  if (!latestnessRequested) return claims;
  return claims.filter((claim) => {
    const text = `${claim.text}\n${claim.evidence}`;
    if (assessment?.conclusion === "PROVEN") return isLatestnessConsistentText(text, assessment);
    return !sentenceSegments(text).some(
      (sentence) =>
        currentReleaseAssertionPattern.test(sentence) && !isHistoricalLatestAssertion(sentence),
    );
  });
}

/** Keep source support intact while making superseded current-version claims explicit in the ledger. */
export function reconcileLatestnessClaimDisposition(
  claims: Claim[],
  latestnessRequested: boolean,
  assessment: LatestnessAssessment | undefined,
): Claim[] {
  const canReconcile = Boolean(
    latestnessRequested &&
    assessment?.required &&
    assessment.conclusion === "PROVEN" &&
    assessment.requestedEntity &&
    assessment.latestVersion,
  );
  const synthesisEligibleIds = new Set(
    canReconcile
      ? filterLatestnessClaims(claims, true, assessment).map((claim) => claim.id)
      : claims.map((claim) => claim.id),
  );

  // Keep the array and claim objects stable. The controller can reconcile
  // claims while another step still holds references to them (for example,
  // the verifier mutates the selected claim after state computation).
  for (const claim of claims) {
    delete claim.latestnessDisposition;
    if (canReconcile && !synthesisEligibleIds.has(claim.id)) {
      claim.latestnessDisposition = {
        status: "superseded",
        entity: assessment!.requestedEntity!,
        acceptedVersion: assessment!.latestVersion!,
      };
    }
  }
  return claims;
}

/** Require model synthesis to retain controller-issued current version/date facts exactly. */
export function preservesCanonicalLatestnessFacts(
  candidate: Array<{ text: string }>,
  canonicalStatements: Array<{ text: string }>,
  assessment: LatestnessAssessment | undefined,
  releaseDateRequired: boolean,
): boolean {
  if (
    !assessment?.required ||
    assessment?.conclusion !== "PROVEN" ||
    !assessment.latestVersion ||
    !assessment.requestedEntity
  ) {
    return true;
  }

  const canonicalFacts = canonicalStatements.filter((statement) => {
    if (!containsExactEntity(statement.text, assessment.requestedEntity!)) return false;
    const versionMatches = [...statement.text.matchAll(versionMentionPattern)].some(
      (match) => compareVersions(match[1] ?? "", assessment.latestVersion!) === 0,
    );
    if (!versionMatches) return false;
    return (
      currentReleaseAssertionPattern.test(statement.text) ||
      (releaseDateRequired && /\b(?:released|release date)\b/i.test(statement.text))
    );
  });
  if (!canonicalFacts.length) return true;

  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  if (
    !canonicalFacts.every((expected) =>
      candidate.some((actual) => normalize(actual.text) === normalize(expected.text)),
    )
  )
    return false;

  const canonicalDateFacts = canonicalFacts.filter((statement) =>
    /\b(?:released|release date)\b/i.test(statement.text),
  );
  if (!releaseDateRequired || !canonicalDateFacts.length) return true;
  return !candidate.some((statement) => {
    if (
      !containsExactEntity(statement.text, assessment.requestedEntity!) ||
      !/\b(?:released|release date)\b/i.test(statement.text)
    ) {
      return false;
    }
    const matchesCurrentVersion = [...statement.text.matchAll(versionMentionPattern)].some(
      (match) => compareVersions(match[1] ?? "", assessment.latestVersion!) === 0,
    );
    return (
      matchesCurrentVersion &&
      canonicalDateFacts.every((expected) => normalize(statement.text) !== normalize(expected.text))
    );
  });
}

function normalizeStatement(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function officialSource(source: Source | undefined): source is Source {
  return Boolean(source && (source.sourceType === "official" || source.firstPartyClassification));
}

export function renderStructuredResearchAnswer(
  statements: StructuredAnswerStatement[],
  sources: Source[],
): string {
  const numberById = new Map(sources.map((source, index) => [source.id, index + 1]));
  return statements
    .map((statement) => {
      const numbers = statement.sourceIds
        .map((id) => numberById.get(id))
        .filter((number): number is number => number !== undefined);
      const citations = numbers.map((number) => `[${number}]`).join("");
      // A verified statement may retain several sentences of adjacent context.
      // Attach its source binding to every sentence so the structural audit does
      // not reject the earlier context in both model and deterministic answers.
      const text = statement.text
        .replace(/\s+/g, " ")
        .trim()
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => `${sentence.replace(/[.!?]+$/, "")}. ${citations}`)
        .join(" ");
      return `- ${text}`;
    })
    .join("\n");
}

export function parseStructuredResearchAnswer(
  raw: string,
  allowedSourceIds: string[],
  officialSourceIds: string[] = [],
  officialSourcesRequired = false,
): StructuredAnswerStatement[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Synthesis response must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Array.isArray(root.statements)) {
    throw new Error("Synthesis response must contain only a statements array");
  }
  if (root.statements.length === 0 || root.statements.length > MAX_STATEMENTS) {
    throw new Error("Synthesis statements are empty or exceed the bounded response size");
  }

  const allowed = new Set(allowedSourceIds);
  const official = new Set(officialSourceIds);
  const seen = new Set<string>();
  return root.statements.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Synthesis statement ${index + 1} is malformed`);
    }
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).length !== 2 ||
      typeof value.text !== "string" ||
      !Array.isArray(value.sourceIds)
    ) {
      throw new Error(`Synthesis statement ${index + 1} has an invalid shape`);
    }
    const text = value.text.trim();
    if (!text || text.length > MAX_TEXT_CHARS || /[\r\n]/.test(text) || /\[\d+\]/.test(text)) {
      throw new Error(`Synthesis statement ${index + 1} is empty, oversized, or pre-cited`);
    }
    const normalized = normalizeStatement(text);
    if (seen.has(normalized)) throw new Error("Synthesis response contains duplicate statements");
    seen.add(normalized);

    if (
      value.sourceIds.length === 0 ||
      value.sourceIds.length > MAX_SOURCES_PER_STATEMENT ||
      value.sourceIds.some((id) => typeof id !== "string" || !allowed.has(id)) ||
      new Set(value.sourceIds).size !== value.sourceIds.length
    ) {
      throw new Error(`Synthesis statement ${index + 1} has invalid source IDs`);
    }
    const sourceIds = value.sourceIds as string[];
    if (officialSourcesRequired && sourceIds.some((id) => !official.has(id))) {
      throw new Error(`Synthesis statement ${index + 1} cites a non-official source`);
    }
    return { text, sourceIds };
  });
}

function releaseFactEvidence(record: ReleaseEvidenceRecord): ReleaseFactEvidence {
  return {
    entity: record.entity,
    version: record.version,
    releaseDate: record.releaseDate,
    stability: record.stability,
    officialSource: record.officialSource,
    releaseDateClaimIds: record.releaseDateClaimIds,
    releaseDateConflicts: record.releaseDateConflicts,
    stabilityConflicts: record.stabilityConflicts,
  };
}

function formatReleaseDate(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthName = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][month - 1];
  if (!monthName || day < 1 || day > 31) return undefined;
  return `${monthName} ${day}, ${year}`;
}

function uniqueSourceIds(
  sourceIds: string[],
  sources: Source[],
  requireOfficial: boolean,
): string[] {
  return [...new Set(sourceIds)]
    .filter((id) => {
      const source = sources.find((candidate) => candidate.id === id);
      return Boolean(source && (!requireOfficial || officialSource(source)));
    })
    .slice(0, MAX_SOURCES_PER_STATEMENT);
}

function verifiedReleaseRecord(
  requestedFacts: RequestedFactKind[],
  state: ResearchState,
  sources: Source[],
  officialSourcesRequired: boolean,
) {
  const assessment = state.latestnessAssessment;
  const latestnessRequired = requestedFacts.includes("latestness");

  if (latestnessRequired) {
    if (
      !assessment ||
      assessment.conclusion !== "PROVEN" ||
      !assessment.latestVersion ||
      !assessment.proofEvidence ||
      assessment.unresolvedReasons.length > 0 ||
      !["explicit-official-claim", "complete-official-history"].includes(assessment.proof ?? "")
    ) {
      return undefined;
    }
    if (
      assessment.proof === "complete-official-history" &&
      (!assessment.releaseHistoryResolution?.complete ||
        assessment.comparisons.length === 0 ||
        uniqueSourceIds(assessment.completeHistorySourceIds, sources, officialSourcesRequired)
          .length === 0 ||
        !assessment.comparisons.some(
          (comparison) =>
            uniqueSourceIds(comparison.sourceIds, sources, officialSourcesRequired).length > 0,
        ))
    ) {
      return undefined;
    }
    if (
      assessment.proof === "explicit-official-claim" &&
      uniqueSourceIds(assessment.supportingSourceIds, sources, officialSourcesRequired).length === 0
    ) {
      return undefined;
    }
  }

  const version = latestnessRequired ? assessment?.latestVersion : undefined;
  const entity = assessment?.requestedEntity;
  const records = state.releaseRecords?.length
    ? state.releaseRecords
    : (assessment?.releaseRecords ?? []);
  return records.find((record) => {
    if (version && record.version !== version) return false;
    if (entity && record.entity.toLowerCase() !== entity.toLowerCase()) return false;
    if (
      (latestnessRequired || requestedFacts.includes("stable status")) &&
      (record.withdrawn || record.stability !== "stable")
    ) {
      return false;
    }
    if (record.stabilityReason === "feature-stability-only" || record.stabilityConflicts?.length) {
      return false;
    }
    if (
      (requestedFacts.includes("stable status") || latestnessRequired) &&
      !record.stabilityEvidence
    ) {
      return false;
    }
    if (
      requestedFacts.includes("release date") &&
      (!record.releaseDate ||
        !record.releaseDateExplicit ||
        !record.releaseDateClaimIds?.length ||
        record.dateAssociationReason === "publication-date-only" ||
        record.releaseDateConflicts?.length)
    ) {
      return false;
    }
    if (officialSourcesRequired && !record.officialSource) return false;
    const sourceIds = uniqueSourceIds(
      [
        record.sourceId,
        ...(record.sourceIds ?? []),
        ...(record.versionSourceIds ?? []),
        ...(record.releaseDateSourceIds ?? []),
        ...(record.stabilitySourceIds ?? []),
      ],
      sources,
      officialSourcesRequired,
    );
    if (sourceIds.length === 0) return false;
    if (
      officialSourcesRequired &&
      !sourceIds.some((id) => officialSource(sources.find((source) => source.id === id)))
    ) {
      return false;
    }
    return true;
  });
}

export function buildDeterministicResearchAnswer(args: {
  question: string;
  plan: ResearchPlan;
  sources: Source[];
  claims: Claim[];
  researchState?: ResearchState;
  researchChatOptimization?: boolean;
}): DeterministicResearchAnswer {
  const { question, plan, sources, claims, researchState } = args;
  const researchChatOptimization = args.researchChatOptimization === true;
  const officialSourcesRequired =
    plan.interpretation.sourceRequirements?.officialSources === "required";
  const requestedFacts =
    plan.requestedFacts.length > 0
      ? plan.requestedFacts
      : (researchState?.requestedFactCoverage?.required ?? extractRequestedFacts(question));
  const sourceIds = new Set(sources.map((source) => source.id));
  const assessment = researchState?.latestnessAssessment;
  const hasReleaseFacts = requestedFacts.some((fact) =>
    ["version", "release date", "release status", "stable status", "latestness"].includes(fact),
  );
  const baseRecord =
    researchState && hasReleaseFacts
      ? verifiedReleaseRecord(
          requestedFacts.filter((fact) => fact !== "latestness"),
          researchState,
          sources,
          officialSourcesRequired,
        )
      : undefined;
  const latestnessRecord =
    researchState && requestedFacts.includes("latestness")
      ? verifiedReleaseRecord(requestedFacts, researchState, sources, officialSourcesRequired)
      : undefined;
  const record = latestnessRecord ?? baseRecord;
  const latestnessProven =
    assessment?.conclusion === "PROVEN" &&
    (!requestedFacts.includes("latestness") || Boolean(latestnessRecord));
  const supportedClaims = filterLatestnessClaims(
    claims,
    requestedFacts.includes("latestness"),
    assessment,
  )
    .filter(
      (claim) =>
        claim.verification?.verdict === "supported" &&
        claim.sourceIds.some((id) => sourceIds.has(id)) &&
        (!officialSourcesRequired ||
          claim.sourceIds.some((id) => officialSource(sources.find((source) => source.id === id)))),
    )
    .filter((claim) => {
      const isLifecycleClaim =
        /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until|through))\b/i.test(
          `${claim.text}\n${claim.evidence}`,
        );
      if (
        !researchChatOptimization ||
        !requestedFacts.includes("end-of-life date") ||
        !isLifecycleClaim
      ) {
        return true;
      }
      return claim.sourceIds.some((sourceId) => {
        const source = sources.find((candidate) => candidate.id === sourceId);
        return Boolean(
          source &&
          bindVerifiedEndOfLifeClaimToSource(question, claim, source, officialSourcesRequired)
            .outcome === "EXACT_SUPPORT",
        );
      });
    });
  const releaseEvidence = record ? [releaseFactEvidence(record)] : [];
  const latestnessVersion = latestnessProven ? record?.version : undefined;
  const verifiedTexts = supportedClaims.flatMap((claim) => [claim.text, claim.evidence]);
  const requestedPredicate = plan.interpretation.requestedPredicate;
  const structuredRoleBindings = requestedPredicate
    ? supportedClaims.flatMap((claim) =>
        sources.flatMap((source) => {
          if (!claim.sourceIds.includes(source.id)) return [];
          return (source.structuredFacts ?? [])
            .filter(
              (fact) =>
                [source.url, source.canonicalUrl, source.retrievalSourceUrl].includes(
                  fact.sourceUrl,
                ) && claimTextSupportsStructuredFact(claim.text, fact, requestedPredicate),
            )
            .map((fact) => ({ claimId: claim.id, sourceId: source.id, fact }));
        }),
      )
    : [];
  const verifiedStructuredFacts = structuredRoleBindings.map((binding) => binding.fact);
  const evidenceCoverage = enforceResearchChatBoundedFactCoverage(
    requestedFactCoverage(question, verifiedTexts, {
      requestedFacts,
      latestnessProven,
      latestnessVersion,
      releaseEvidence,
      officialSourcesRequired,
      requestedPredicate,
      structuredFacts: verifiedStructuredFacts,
    }),
    question,
    supportedClaims,
    sources,
    officialSourcesRequired,
  );

  const statements: StructuredAnswerStatement[] = [];
  const controllerVerifiedStatements: ControllerVerifiedStatement[] = [];
  const addStatement = (text: string, ids: string[]) => {
    const usableIds = uniqueSourceIds(ids, sources, officialSourcesRequired);
    if (!text.trim() || usableIds.length === 0 || statements.length >= MAX_STATEMENTS) return;
    if (
      statements.some(
        (statement) => normalizeStatement(statement.text) === normalizeStatement(text),
      )
    ) {
      return;
    }
    statements.push({ text, sourceIds: usableIds });
    controllerVerifiedStatements.push({ text, sourceIds: usableIds });
  };

  if (record) {
    const entity = assessment?.requestedEntity ?? record.entity;
    const latestnessSources = uniqueSourceIds(
      [
        ...(assessment?.supportingSourceIds ?? []),
        ...(assessment?.completeHistorySourceIds ?? []),
        record.sourceId,
      ],
      sources,
      officialSourcesRequired,
    );
    if (requestedFacts.includes("latestness") && latestnessProven && latestnessSources.length > 0) {
      addStatement(
        `The latest stable release of ${entity} is version ${record.version}.`,
        latestnessSources,
      );
    } else if (requestedFacts.includes("version")) {
      addStatement(`A verified ${entity} release is version ${record.version}.`, [record.sourceId]);
    }
    if (
      requestedFacts.includes("stable status") &&
      !latestnessProven &&
      record.stability === "stable"
    ) {
      addStatement(`${entity} ${record.version} is a stable release.`, [
        ...(record.stabilitySourceIds ?? []),
        record.sourceId,
      ]);
    }
    if (requestedFacts.includes("release date") && record.releaseDate) {
      const date = formatReleaseDate(record.releaseDate);
      if (date) {
        addStatement(`${entity} ${record.version} was released on ${date}.`, [
          ...(record.releaseDateSourceIds ?? []),
          record.sourceId,
        ]);
      }
    }
  }

  const relianceByClaim = new Map(
    buildClaimSourceReliance(supportedClaims, sources, plan.interpretation.entities).map(
      (summary) => [summary.claimId, summary],
    ),
  );
  for (const claim of supportedClaims) {
    const structuredRole = structuredRoleBindings.find((binding) => binding.claimId === claim.id);
    const structuredRoleStatement = structuredRole
      ? `${structuredRole.fact.person} is the ${structuredRole.fact.jobTitle} of ${structuredRole.fact.entity}.`
      : undefined;
    addStatement(
      qualifySingleThirdPartyClaim(
        structuredRoleStatement ?? claim.text,
        relianceByClaim.get(claim.id),
      ),
      structuredRole
        ? [structuredRole.sourceId]
        : claim.sourceIds.filter((id) => sourceIds.has(id)),
    );
  }

  const answer = renderStructuredResearchAnswer(statements, sources);
  const answerCoverage = enforceResearchChatBoundedFactCoverage(
    requestedFactCoverage(question, [answer], {
      requestedFacts,
      requestedPredicate: plan.interpretation.requestedPredicate,
    }),
    question,
    supportedClaims,
    sources,
    officialSourcesRequired,
  );
  return {
    answer,
    statements,
    controllerVerifiedStatements,
    evidenceCoverage,
    answerCoverage,
    officialSourcesRequired,
  };
}
