import type {
  Claim,
  ReleaseEvidenceRecord,
  ResearchPlan,
  ResearchState,
  Source,
} from "./domain.js";
import {
  extractRequestedFacts,
  requestedFactCoverage,
  type RequestedFactCoverage,
  type RequestedFactKind,
  type ReleaseFactEvidence,
} from "./requested-facts.js";
import type { ControllerVerifiedStatement } from "./citation-entailment.js";
import {
  bindVerifiedEndOfLifeClaimToSource,
  enforceResearchChatBoundedFactCoverage,
} from "./research-chat-fact-gate.js";

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

const MAX_STATEMENTS = 10;
const MAX_TEXT_CHARS = 500;
const MAX_SOURCES_PER_STATEMENT = 3;

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
      const text = statement.text
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.!?]+$/, "");
      return `- ${text}. ${numbers.map((number) => `[${number}]`).join("")}`;
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
  const supportedClaims = claims
    .filter(
      (claim) =>
        claim.verification?.verdict === "supported" &&
        claim.sourceIds.some((id) => sourceIds.has(id)) &&
        (!requestedFacts.includes("latestness") ||
          latestnessProven ||
          !/\b(?:latest|newest|most recent|current)\b.{0,60}\b(?:release|version)\b|\b(?:release|version)\b.{0,60}\b(?:latest|newest|most recent|current)\b/i.test(
            claim.text,
          )) &&
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
  const evidenceCoverage = enforceResearchChatBoundedFactCoverage(
    requestedFactCoverage(question, verifiedTexts, {
      requestedFacts,
      latestnessProven,
      latestnessVersion,
      releaseEvidence,
      officialSourcesRequired,
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

  for (const claim of supportedClaims) {
    addStatement(
      claim.text,
      claim.sourceIds.filter((id) => sourceIds.has(id)),
    );
  }

  const answer = renderStructuredResearchAnswer(statements, sources);
  const answerCoverage = enforceResearchChatBoundedFactCoverage(
    requestedFactCoverage(question, [answer], { requestedFacts }),
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
