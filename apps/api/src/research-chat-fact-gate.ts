import type { Claim, Source } from "./domain.js";
import { extractKnownEntities } from "./entities.js";
import type { RequestedFactCoverage, RequestedFactKind } from "./requested-facts.js";

export type ResearchChatFactOutcome =
  | "EXACT_SUPPORT"
  | "PARTIAL_SUPPORT"
  | "WRONG_ENTITY"
  | "WRONG_VERSION"
  | "WRONG_FACT"
  | "UNSUPPORTED"
  | "MISSING_CITATION";

export interface ResearchChatFactBinding {
  fact: "end-of-life date";
  entity?: string;
  version?: string;
  value?: string;
  evidenceSourceIds: string[];
  verificationStatus: "VERIFIED" | "UNVERIFIED";
  outcome: ResearchChatFactOutcome;
}

export interface ResearchChatFactContext {
  question: string;
  requestedFacts: string[];
  claims: Claim[];
  officialSourcesRequired: boolean;
}

export interface ResearchChatFactStatement {
  text: string;
  sourceIds: string[];
}

interface LifecycleAssertion {
  entity: string;
  version?: string;
  date?: string;
  precision: "day" | "month" | "none";
}

interface LifecycleTarget {
  entity: string;
  version?: string;
}

const lifecycleMarker =
  /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until|through)|unsupported\s+after)\b/i;
const exactIsoDate = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const exactNamedDate =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i;
const partialDate =
  /\b(20\d{2})-(0[1-9]|1[0-2])\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i;
const monthNumbers: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function exactDateValue(text: string): string | undefined {
  const iso = exactIsoDate.exec(text);
  if (iso) return validCalendarDate(iso[1]!, iso[2]!, iso[3]!) ? iso[0] : undefined;
  const named = exactNamedDate.exec(text);
  if (!named) return undefined;
  const monthName = (named[1] ?? named[5] ?? "").slice(0, 3).toLowerCase();
  const day = named[2] ?? named[4];
  const year = named[3] ?? named[6];
  const month = monthNumbers[monthName];
  if (!day || !year || !month || !validCalendarDate(year, month, day)) return undefined;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function validCalendarDate(year: string, month: string, day: string): boolean {
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

function lifecycleTarget(question: string): LifecycleTarget | undefined {
  const entity = extractKnownEntities(question)[0];
  if (!entity) return undefined;
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = question.match(
    new RegExp(`\\b${escaped}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "i"),
  )?.[1];
  return { entity, ...(version ? { version } : {}) };
}

function extractLifecycleAssertions(text: string): LifecycleAssertion[] {
  const sentences = text.split(/\n+|(?<=[.!?;])\s+/);
  const passages = sentences.flatMap((sentence) =>
    sentence.split(/(?:,\s*|\s+)\b(?:while|whereas|but|however)\b(?:\s*,)?/i),
  );
  return passages.flatMap((passage) => {
    if (!lifecycleMarker.test(passage)) return [];
    const entities = extractKnownEntities(passage);
    const fullDate = exactDateValue(passage);
    const partial = partialDate.exec(passage);
    const partialValue = partial
      ? partial[1] && partial[2]
        ? `${partial[1]}-${partial[2]}`
        : `${monthNumbers[(partial[3] ?? "").slice(0, 3).toLowerCase()] ?? ""}-${partial[4] ?? ""}`
      : undefined;
    return entities.flatMap((entity) => {
      const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const versions = [
        ...new Set(
          [
            ...passage.matchAll(
              new RegExp(`\\b${escaped}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "gi"),
            ),
          ]
            .map((match) => match[1])
            .filter((version): version is string => Boolean(version)),
        ),
      ];
      // A passage that contains multiple versions without a clear clause boundary
      // cannot safely bind its lifecycle marker/date to either version.
      if (versions.length > 1) return [];
      const version = versions[0];
      return [
        {
          entity,
          ...(version ? { version } : {}),
          ...((fullDate ?? partialValue) ? { date: fullDate ?? partialValue } : {}),
          precision: fullDate ? "day" : partialValue ? "month" : "none",
        } satisfies LifecycleAssertion,
      ];
    });
  });
}

function matchesTarget(assertion: LifecycleAssertion, target: LifecycleTarget): boolean {
  if (assertion.entity.toLowerCase() !== target.entity.toLowerCase()) return false;
  if (!target.version) return true;
  if (!assertion.version) return false;
  const requestedParts = target.version.split(".");
  const foundParts = assertion.version.split(".");
  return requestedParts.every((part, index) => foundParts[index] === part);
}

function sourceIsOfficial(source: Source): boolean {
  return source.sourceType === "official" || Boolean(source.firstPartyClassification);
}

function sourceText(source: Source): string {
  return [source.content, source.snippet].filter(Boolean).join("\n");
}

function verifiedClaimForSource(
  context: ResearchChatFactContext,
  source: Source,
  target: LifecycleTarget,
  date: string,
): boolean {
  return context.claims.some((claim) => {
    if (
      claim.verification?.verdict !== "supported" ||
      !claim.requestedFacts?.includes("end-of-life date") ||
      !claim.sourceIds.includes(source.id)
    ) {
      return false;
    }
    return extractLifecycleAssertions(claim.evidence).some(
      (assertion) =>
        assertion.precision === "day" &&
        assertion.date === date &&
        matchesTarget(assertion, target),
    );
  });
}

/**
 * A supported lifecycle claim must be tied to the same exact entity/version/day
 * in its own cited source. A verifier label alone is not source provenance.
 */
export function bindVerifiedEndOfLifeClaimToSource(
  question: string,
  claim: Claim,
  source: Source,
  officialSourcesRequired: boolean,
): ResearchChatFactBinding {
  const target = lifecycleTarget(question);
  const base: ResearchChatFactBinding = {
    fact: "end-of-life date",
    ...(target?.entity ? { entity: target.entity } : {}),
    ...(target?.version ? { version: target.version } : {}),
    evidenceSourceIds: [],
    verificationStatus: "UNVERIFIED",
    outcome: "UNSUPPORTED",
  };
  if (!target || claim.verification?.verdict !== "supported") return base;
  if (!claim.requestedFacts?.includes("end-of-life date")) return base;
  if (officialSourcesRequired && !sourceIsOfficial(source)) return base;

  const claimAssertions = extractLifecycleAssertions(`${claim.text}\n${claim.evidence}`);
  const sourceAssertions = extractLifecycleAssertions(sourceText(source));
  const wrongEntity = sourceAssertions.some(
    (assertion) =>
      assertion.entity.toLowerCase() !== target.entity.toLowerCase() &&
      claimAssertions.some((claimAssertion) => matchesTarget(claimAssertion, target)),
  );
  if (wrongEntity) return { ...base, outcome: "WRONG_ENTITY" };

  const sourceTarget = sourceAssertions.filter((assertion) => matchesTarget(assertion, target));
  const claimTarget = claimAssertions.filter((assertion) => matchesTarget(assertion, target));
  if (sourceTarget.length === 0 || claimTarget.length === 0) {
    const otherVersion = sourceAssertions.some(
      (assertion) =>
        assertion.entity.toLowerCase() === target.entity.toLowerCase() &&
        assertion.version &&
        target.version &&
        !matchesTarget(assertion, target),
    );
    return { ...base, outcome: otherVersion ? "WRONG_VERSION" : "WRONG_FACT" };
  }

  const exactClaimDates = new Set(
    claimTarget
      .filter((assertion) => assertion.precision === "day" && assertion.date)
      .map((assertion) => assertion.date!),
  );
  const exactSourceDates = new Set(
    sourceTarget
      .filter((assertion) => assertion.precision === "day" && assertion.date)
      .map((assertion) => assertion.date!),
  );
  const date = [...exactClaimDates].find((candidate) => exactSourceDates.has(candidate));
  if (!date) {
    const partial = [...claimTarget, ...sourceTarget].some(
      (assertion) => assertion.precision === "month",
    );
    return {
      ...base,
      ...(claimTarget.find((assertion) => assertion.date)?.date
        ? { value: claimTarget.find((assertion) => assertion.date)!.date }
        : {}),
      outcome: partial ? "PARTIAL_SUPPORT" : "WRONG_FACT",
    };
  }
  if (!claim.sourceIds.includes(source.id)) return { ...base, value: date, outcome: "UNSUPPORTED" };
  return {
    ...base,
    value: date,
    evidenceSourceIds: [source.id],
    verificationStatus: "VERIFIED",
    outcome: "EXACT_SUPPORT",
  };
}

/**
 * Produces the Research Chat-specific binding for an answer statement. The
 * optional result is undefined when the statement is not making a lifecycle
 * assertion, allowing unrelated facts to use the existing citation judge.
 */
export function evaluateResearchChatLifecycleCitation(
  context: ResearchChatFactContext,
  statement: ResearchChatFactStatement,
  sources: Source[],
): ResearchChatFactBinding | undefined {
  if (!context.requestedFacts.includes("end-of-life date")) return undefined;
  const answerAssertions = extractLifecycleAssertions(statement.text);
  if (answerAssertions.length === 0) return undefined;
  const target = lifecycleTarget(context.question);
  const base: ResearchChatFactBinding = {
    fact: "end-of-life date",
    ...(target?.entity ? { entity: target.entity } : {}),
    ...(target?.version ? { version: target.version } : {}),
    evidenceSourceIds: [],
    verificationStatus: "UNVERIFIED",
    outcome: "UNSUPPORTED",
  };
  if (!target) return base;

  const targetAnswer = answerAssertions.find((assertion) => matchesTarget(assertion, target));
  if (!targetAnswer) {
    return {
      ...base,
      outcome: answerAssertions.some(
        (assertion) => assertion.entity.toLowerCase() !== target.entity.toLowerCase(),
      )
        ? "WRONG_ENTITY"
        : "WRONG_VERSION",
    };
  }
  if (statement.sourceIds.length === 0) return { ...base, outcome: "MISSING_CITATION" };
  const cited = statement.sourceIds
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is Source => Boolean(source));
  if (cited.length === 0) return { ...base, value: targetAnswer.date, outcome: "MISSING_CITATION" };

  const rejectedOutcomes: ResearchChatFactOutcome[] = [];
  const citedAssertions = new Map<Source, LifecycleAssertion[]>();
  for (const source of cited) {
    if (context.officialSourcesRequired && !sourceIsOfficial(source)) {
      rejectedOutcomes.push("UNSUPPORTED");
      continue;
    }
    const sourceAssertions = extractLifecycleAssertions(sourceText(source));
    citedAssertions.set(source, sourceAssertions);
    const targetAssertions = sourceAssertions.filter((assertion) =>
      matchesTarget(assertion, target),
    );
    if (
      targetAnswer.precision === "day" &&
      targetAnswer.date &&
      targetAssertions.some(
        (assertion) => assertion.precision === "day" && assertion.date === targetAnswer.date,
      )
    ) {
      const verifiedClaim = verifiedClaimForSource(context, source, target, targetAnswer.date);
      if (verifiedClaim) {
        return {
          ...base,
          value: targetAnswer.date,
          evidenceSourceIds: [source.id],
          verificationStatus: "VERIFIED",
          outcome: "EXACT_SUPPORT",
        };
      }
      rejectedOutcomes.push("UNSUPPORTED");
      continue;
    }

    if (
      sourceAssertions.some(
        (assertion) =>
          assertion.entity.toLowerCase() === target.entity.toLowerCase() &&
          assertion.version &&
          target.version &&
          !matchesTarget(assertion, target),
      )
    ) {
      rejectedOutcomes.push("WRONG_VERSION");
    } else if (
      sourceAssertions.some(
        (assertion) => assertion.entity.toLowerCase() !== target.entity.toLowerCase(),
      )
    ) {
      rejectedOutcomes.push("WRONG_ENTITY");
    } else if (targetAssertions.some((assertion) => assertion.precision === "month")) {
      rejectedOutcomes.push("PARTIAL_SUPPORT");
    } else if (
      extractKnownEntities(sourceText(source)).some(
        (entity) => entity.toLowerCase() !== target.entity.toLowerCase(),
      )
    ) {
      rejectedOutcomes.push("WRONG_ENTITY");
    } else {
      rejectedOutcomes.push("WRONG_FACT");
    }
  }

  if (targetAnswer.precision !== "day" || !targetAnswer.date) {
    const sourceWrongVersion = [...citedAssertions.values()].some((assertions) =>
      assertions.some(
        (assertion) =>
          assertion.entity.toLowerCase() === target.entity.toLowerCase() &&
          assertion.version &&
          target.version &&
          !matchesTarget(assertion, target),
      ),
    );
    if (sourceWrongVersion) return { ...base, value: targetAnswer.date, outcome: "WRONG_VERSION" };
    return {
      ...base,
      ...(targetAnswer.date ? { value: targetAnswer.date } : {}),
      outcome: targetAnswer.precision === "month" ? "PARTIAL_SUPPORT" : "WRONG_FACT",
    };
  }

  const priority: ResearchChatFactOutcome[] = [
    "WRONG_ENTITY",
    "WRONG_VERSION",
    "PARTIAL_SUPPORT",
    "WRONG_FACT",
    "UNSUPPORTED",
  ];
  return {
    ...base,
    value: targetAnswer.date,
    outcome: priority.find((outcome) => rejectedOutcomes.includes(outcome)) ?? "UNSUPPORTED",
  };
}

export function enforceResearchChatBoundedFactCoverage(
  coverage: RequestedFactCoverage,
  question: string,
  claims: Claim[],
  sources: Source[],
  officialSourcesRequired: boolean,
): RequestedFactCoverage {
  if (!coverage.required.includes("end-of-life date")) return coverage;
  const target = lifecycleTarget(question);
  const supportedBinding = Boolean(
    target &&
    claims.some(
      (claim) =>
        claim.requestedFacts?.includes("end-of-life date") &&
        claim.verification?.verdict === "supported" &&
        claim.sourceIds.some((sourceId) => {
          const source = sources.find((candidate) => candidate.id === sourceId);
          if (!source) return false;
          const binding = bindVerifiedEndOfLifeClaimToSource(
            question,
            claim,
            source,
            officialSourcesRequired,
          );
          return binding.outcome === "EXACT_SUPPORT";
        }),
    ),
  );
  const present: RequestedFactKind[] = coverage.present.filter(
    (fact) => fact !== "end-of-life date",
  );
  const missing: RequestedFactKind[] = coverage.missing.filter(
    (fact) => fact !== "end-of-life date",
  );
  if (supportedBinding) present.push("end-of-life date");
  else missing.push("end-of-life date");
  return { ...coverage, present, missing };
}

export function buildResearchChatFactBindings(
  context: ResearchChatFactContext,
  statements: ResearchChatFactStatement[],
  sources: Source[],
): ResearchChatFactBinding[] {
  if (!context.requestedFacts.includes("end-of-life date")) return [];
  const lifecycleStatements = statements.filter(
    (statement) => extractLifecycleAssertions(statement.text).length > 0,
  );
  if (lifecycleStatements.length === 0) {
    const target = lifecycleTarget(context.question);
    return [
      {
        fact: "end-of-life date",
        ...(target?.entity ? { entity: target.entity } : {}),
        ...(target?.version ? { version: target.version } : {}),
        evidenceSourceIds: [],
        verificationStatus: "UNVERIFIED",
        outcome: "UNSUPPORTED",
      },
    ];
  }
  return lifecycleStatements.map(
    (statement) =>
      evaluateResearchChatLifecycleCitation(context, statement, sources) ?? {
        fact: "end-of-life date",
        evidenceSourceIds: [],
        verificationStatus: "UNVERIFIED",
        outcome: "UNSUPPORTED",
      },
  );
}
