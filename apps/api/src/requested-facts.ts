import { containsExactEntity, extractKnownEntities } from "./entities.js";
import type { StructuredPersonRoleFact } from "./application-data.js";

export type EvidenceStatus = "GENERIC_SUPPORT" | "SUPPORTED_EVIDENCE" | "INSUFFICIENT_EVIDENCE";

export type RequestedFactKind =
  | "version"
  | "release date"
  | "release status"
  | "stable status"
  | "latestness"
  | "end-of-life date"
  | "price"
  | "technical value";

export interface RequestedFactCoverage {
  required: RequestedFactKind[];
  present: RequestedFactKind[];
  missing: RequestedFactKind[];
  requestedPredicate?: {
    predicate: string;
    present: boolean;
  };
}

export interface RequestedPredicateRequirement {
  predicate: string;
  entity: string;
  aliases: string[];
}

export interface RequestedFactRequirements {
  version: boolean;
  releaseDate: boolean;
  releaseStatus: boolean;
  stable: boolean;
  latest: boolean;
  endOfLifeDate: boolean;
  price: boolean;
  technicalValue: boolean;
}

export interface ReleaseFactEvidence {
  entity: string;
  version: string;
  releaseDate?: string;
  stability: "stable" | "prerelease" | "unknown";
  officialSource: boolean;
  releaseDateClaimIds?: string[];
  releaseDateConflicts?: string[];
  stabilityConflicts?: Array<"stable" | "prerelease">;
}

export function buildRequestedFactRequirements(
  requestedFacts: RequestedFactKind[],
): RequestedFactRequirements {
  const facts = new Set(requestedFacts);
  return {
    version: facts.has("version"),
    releaseDate: facts.has("release date"),
    releaseStatus: facts.has("release status"),
    stable: facts.has("stable status"),
    latest: facts.has("latestness"),
    endOfLifeDate: facts.has("end-of-life date"),
    price: facts.has("price"),
    technicalValue: facts.has("technical value"),
  };
}

const requestedDatePattern =
  /\b20\d{2}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}\b/i;
const lifecycleDatePattern =
  /\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}\b/i;
const requestedVersionPattern = /\bv?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?\b/i;
const requestedMeasurementPattern =
  /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|seconds?|minutes?|hours?|gb|mb|kb|bytes?|fps|hz|mhz|ghz|%|percent|requests?\/s|rps)\b|(?:[$€£₹]\s?\d)|\b\d+(?:\.\d+)?%\b/i;
const featureStabilityPattern =
  /\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?|renderers?)\b[^.!?\n]{0,120}\bstable\b|\bstable\b[^.!?\n]{0,120}\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?|renderers?)\b/i;
const releaseStabilityPattern =
  /\b(?:stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:release|version|channel)|(?:release|version|channel)\s+(?:is|was|became|remains)\s+(?:the\s+)?(?:latest\s+)?stable|(?:is|was|became|remains)\s+(?:now\s+)?(?:a\s+|the\s+)?stable(?:\s+(?:release|version|channel))?|(?:latest|newest|current)\s+stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:release|version|channel)|stable\s*\/\s*latest|latest\s*\/\s*stable)\b/i;

const predicateStopWords = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "does",
  "do",
  "did",
  "of",
  "at",
  "in",
  "for",
  "who",
  "what",
  "when",
  "where",
  "which",
  "how",
  "has",
  "have",
  "had",
  "with",
  "from",
]);

const broadConceptPredicatePattern =
  /\b(?:capabilit(?:y|ies)|features?|strengths?|weaknesses?|benefits?|limitations?|trade-offs?|overviews?|purposes?|use cases?|functionality|architecture|design|performance)\b/i;

const predicateAliases: Record<string, string[]> = {
  ceo: ["chief executive officer"],
  cfo: ["chief financial officer"],
  cto: ["chief technology officer", "chief technical officer"],
  coo: ["chief operating officer"],
  headquarters: ["headquarter", "head office", "main office"],
  headquartered: ["headquarters", "head office", "main office"],
};

function cleanPredicatePart(value: string): string {
  return value
    .replace(/[?!.]+$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNamedSubject(value: string): boolean {
  return extractKnownEntities(value).length > 0 || /\b[\p{Lu}][\p{L}\p{N}&.'-]*/u.test(value);
}

function predicateForms(predicate: string): string[] {
  const normalized = cleanPredicatePart(predicate);
  const forms = [normalized, ...(predicateAliases[normalized.toLowerCase()] ?? [])];
  const words = normalized.split(/\s+/);
  if (words.length === 1) {
    const word = words[0]!.toLowerCase();
    if (word.endsWith("ied") && word.length > 4) {
      const stem = `${word.slice(0, -3)}y`;
      forms.push(stem, `${stem}er`, `${stem}ing`);
    } else if (word.endsWith("ed") && word.length > 4) {
      const stem = word.slice(0, -2);
      forms.push(stem, `${stem}er`, `${stem}ing`);
    } else if (word.endsWith("er") && word.length > 4) {
      const stem = word.slice(0, -2);
      forms.push(stem, `${stem}ed`, `${stem}ing`);
    }
  }
  return [...new Set(forms.map(cleanPredicatePart).filter(Boolean))].slice(0, 6);
}

/** Extract a precise relation from common entity-question forms without broadening its meaning. */
export function extractRequestedPredicate(
  question: string,
): RequestedPredicateRequirement | undefined {
  // The established typed checklist remains authoritative for version, price, and specification facts.
  if (extractRequestedFacts(question).length > 0) return undefined;

  const text = question.trim().replace(/\s+/g, " ");
  const patterns: Array<{ pattern: RegExp; predicateGroup: number; entityGroup: number }> = [
    {
      pattern:
        /^(?:who|what|when|where)\s+(?:is|are|was|were|does|do|did)\s+(?:the\s+)?(.+?)\s+(?:of|at|in|for)\s+(.+?)\??$/i,
      predicateGroup: 1,
      entityGroup: 2,
    },
    {
      pattern: /^(?:who|what|where)\s+(?:is|are|was|were)\s+(.+?)[’']s\s+(.+?)\??$/i,
      predicateGroup: 2,
      entityGroup: 1,
    },
    {
      pattern: /^(?:where|when)\s+(?:is|are|was|were)\s+(.+?)\s+([\p{L}][\p{L}-]{2,})\??$/iu,
      predicateGroup: 2,
      entityGroup: 1,
    },
    {
      pattern: /^who\s+([\p{L}][\p{L}-]{2,})\s+(.+?)\??$/iu,
      predicateGroup: 1,
      entityGroup: 2,
    },
    {
      pattern: /^when\s+was\s+(.+?)\s+([\p{L}][\p{L}-]{2,})\??$/iu,
      predicateGroup: 2,
      entityGroup: 1,
    },
  ];

  for (const { pattern, predicateGroup, entityGroup } of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const predicate = cleanPredicatePart(match[predicateGroup] ?? "");
    const entity = cleanPredicatePart(match[entityGroup] ?? "");
    if (
      !predicate ||
      predicateStopWords.has(predicate.toLowerCase()) ||
      broadConceptPredicatePattern.test(predicate) ||
      !entity ||
      !looksLikeNamedSubject(entity)
    ) {
      continue;
    }
    return { predicate, entity, aliases: predicateForms(predicate) };
  }
  return undefined;
}

export function requestedPredicatePresent(
  evidence: string | string[],
  requirement?: RequestedPredicateRequirement,
  structuredFacts?: StructuredPersonRoleFact[],
): boolean {
  if (!requirement) return true;
  const items = Array.isArray(evidence) ? evidence : [evidence];
  const textMatch = items.some((item) =>
    item.split(/\n+|(?<=[.!?;])\s+/).some((statement) => {
      if (!containsExactEntity(statement, requirement.entity)) return false;
      return predicateAliasPresent(statement, requirement);
    }),
  );
  if (textMatch) return true;
  return Boolean(
    structuredFacts?.some((fact) => structuredFactMatchesPredicate(fact, requirement)),
  );
}

function predicateAliasPresent(text: string, requirement: RequestedPredicateRequirement): boolean {
  return requirement.aliases.some((alias) => {
    const words = alias.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b${words.join("\\s+")}\\b`, "i").test(text);
  });
}

/** Match a predicate only against a normalized, source-bound person/role relation. */
export function structuredFactMatchesPredicate(
  fact: StructuredPersonRoleFact,
  requirement: RequestedPredicateRequirement,
): boolean {
  return (
    fact.sourceFormat === "json-ld" &&
    Boolean(fact.person.trim()) &&
    Boolean(fact.relationship.trim()) &&
    containsExactEntity(fact.entity, requirement.entity) &&
    predicateAliasPresent(fact.jobTitle, requirement)
  );
}

/**
 * Bind a supported claim to one source-derived JSON-LD role relation.
 *
 * Structured claim text can be serialized as key/value fields separated by
 * semicolons, so sentence splitting would incorrectly separate a person's
 * name from their job title. The structured fact is the relation boundary;
 * the claim must still name the requested entity, person, and role.
 */
export function claimTextSupportsStructuredFact(
  claimText: string,
  fact: StructuredPersonRoleFact,
  requirement: RequestedPredicateRequirement,
): boolean {
  if (!structuredFactMatchesPredicate(fact, requirement)) return false;
  return (
    containsExactEntity(claimText, requirement.entity) &&
    containsExactEntity(claimText, fact.person) &&
    predicateAliasPresent(claimText, requirement)
  );
}

export function hasCompleteRequestedFactCoverage(coverage: RequestedFactCoverage): boolean {
  return (
    coverage.missing.length === 0 &&
    (!coverage.requestedPredicate || coverage.requestedPredicate.present)
  );
}

export function extractRequestedFacts(
  question: string,
  options: { includeSupportLifecycle?: boolean } = {},
): RequestedFactKind[] {
  const required: RequestedFactKind[] = [];
  const asksForVersion =
    /\b(?:version|semver)\b/i.test(question) ||
    /\b(?:latest|current|stable)\s+(?:stable\s+)?(?:[\p{L}\p{N}._+-]+\s+)?release\b/iu.test(
      question,
    );
  const asksForLatestness =
    asksForVersion && /\b(?:latest|newest|current|most recent)\b/i.test(question);
  const asksForStableStatus = asksForVersion && /\bstable\b/i.test(question);
  const asksForReleaseDate =
    /\b(?:release date|date of (?:the )?release|date released|released on)\b/i.test(question) ||
    (asksForVersion && /\bdate\b/i.test(question));
  const asksForReleaseStatus =
    /\b(?:release|version)\s+status\b|\bstatus\s+of\s+(?:the\s+)?(?:release|version)\b/i.test(
      question,
    );
  const asksForPrice = /\b(?:price|pricing|cost)\b/i.test(question);
  const asksForMeasuredTechnicalFact =
    /\b(?:exact|specification|spec|maximum|minimum|limit|capacity|latency|throughput|memory usage|payload|resolution|frequency|compatib(?:le|ility)|supported version)\b/i.test(
      question,
    );
  const asksForEndOfLifeDate =
    options.includeSupportLifecycle === true &&
    /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until)|when\s+(?:will|does)\s+.+\s+(?:be\s+)?unsupported)\b/i.test(
      question,
    );

  if (asksForVersion) required.push("version");
  if (asksForReleaseDate) required.push("release date");
  if (asksForReleaseStatus) required.push("release status");
  if (asksForStableStatus) required.push("stable status");
  if (asksForLatestness) required.push("latestness");
  if (asksForEndOfLifeDate) required.push("end-of-life date");
  if (asksForPrice) required.push("price");
  if (asksForMeasuredTechnicalFact) required.push("technical value");
  return required;
}

function hasFact(kind: RequestedFactKind, evidence: string): boolean {
  switch (kind) {
    case "version":
      return requestedVersionPattern.test(evidence);
    case "release date":
      return hasVersionAssociatedReleaseDate(evidence);
    case "release status":
      return hasReleaseStatusEvidence(evidence);
    case "latestness":
      return false;
    case "end-of-life date":
      return false;
    case "stable status":
      return hasStableVersionEvidence(evidence);
    case "price":
      return /(?:[$€£₹]\s?\d|\bfree\b|\bno cost\b)/i.test(evidence);
    case "technical value":
      return requestedMeasurementPattern.test(evidence);
  }
}

function lifecycleTarget(question: string): { entity?: string; version?: string } {
  const entity = extractKnownEntities(question)[0];
  if (!entity) return {};
  const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = question.match(
    new RegExp(`\\b${escapedEntity}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "i"),
  );
  return { entity, ...(match?.[1] ? { version: match[1] } : {}) };
}

function hasEndOfLifeDateEvidence(question: string, evidence: string): boolean {
  const target = lifecycleTarget(question);
  if (!target.entity) return false;
  return evidence.split(/\n+|(?<=[.!?;])\s+/).some((passage) => {
    if (!hasExactLifecycleDate(passage)) return false;
    if (
      !/\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until)|unsupported\s+after)\b/i.test(
        passage,
      )
    ) {
      return false;
    }
    if (!containsExactEntity(passage, target.entity!)) return false;
    if (!target.version) return true;
    const escapedVersion = target.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedVersion}(?:\\.\\d+){0,3}\\b`, "i").test(passage);
  });
}

function hasExactLifecycleDate(text: string): boolean {
  const match = text.match(lifecycleDatePattern)?.[0];
  if (!match) return false;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(match);
  const monthNames = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const monthFirst =
      /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i.exec(
        match,
      );
    const dayFirst =
      /^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})$/i.exec(
        match,
      );
    const named = monthFirst ?? dayFirst;
    if (!named) return false;
    const monthName = (monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase();
    month = monthNames.indexOf(monthName) + 1;
    day = Number(monthFirst ? named[2] : named[1]);
    year = Number(named[3]);
  }
  if (!year || month < 1 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function hasReleaseStatusEvidence(evidence: string): boolean {
  const versions = evidence.matchAll(new RegExp(requestedVersionPattern.source, "gi"));
  for (const match of versions) {
    const context = evidenceStatement(evidence, match.index ?? 0, match[0].length);
    if (featureStabilityPattern.test(context)) continue;
    if (releaseStabilityPattern.test(context)) return true;
    if (
      /\b(?:canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i.test(context) &&
      /\b(?:release|version|channel|prerelease|pre-release)\b/i.test(context)
    ) {
      return true;
    }
  }
  return false;
}

function hasLatestnessEvidence(evidence: string, stableRequired: boolean): boolean {
  const versions = evidence.matchAll(new RegExp(requestedVersionPattern.source, "gi"));
  for (const match of versions) {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(evidence.length, match.index + match[0].length + 80);
    const context = evidence.slice(start, end);
    const statement = evidenceStatement(evidence, match.index ?? 0, match[0].length);
    if (
      stableRequired &&
      (!releaseStabilityPattern.test(statement) || featureStabilityPattern.test(statement))
    )
      continue;
    if (
      /\b(?:canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i.test(context)
    ) {
      continue;
    }
    if (
      /\b(?:latest|newest|current|most recent)\b.{0,80}\b(?:stable\s+)?(?:release|version)\b|\b(?:stable\s+)?(?:release|version)\b.{0,80}\b(?:latest|newest|current|most recent)\b/i.test(
        context,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasStableVersionEvidence(evidence: string): boolean {
  const matches = evidence.matchAll(new RegExp(requestedVersionPattern.source, "gi"));
  for (const match of matches) {
    const context = evidenceStatement(evidence, match.index ?? 0, match[0].length);
    if (
      /\b(?:canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i.test(context)
    ) {
      continue;
    }
    if (!featureStabilityPattern.test(context) && releaseStabilityPattern.test(context)) {
      return true;
    }
  }
  return false;
}

function evidenceStatement(text: string, index: number, length: number): string {
  const boundaries = [...text.matchAll(/[!?;]|\n+|(?<=\.)\s+(?=[A-Z])/g)];
  let start = 0;
  let end = text.length;
  for (const boundary of boundaries) {
    const boundaryIndex = boundary.index ?? 0;
    if (boundaryIndex < index) {
      start = boundaryIndex + boundary[0].length;
      continue;
    }
    if (boundaryIndex >= index + length) {
      end = boundaryIndex;
      break;
    }
  }
  return text.slice(start, end);
}

function hasVersionAssociatedReleaseDate(evidence: string): boolean {
  const versions = evidence.matchAll(new RegExp(requestedVersionPattern.source, "gi"));
  for (const match of versions) {
    const context = evidenceStatement(evidence, match.index ?? 0, match[0].length);
    if (
      requestedDatePattern.test(context) &&
      /\b(?:release|released|release date|published to npm|available on npm)\b/i.test(context)
    ) {
      return true;
    }
  }
  return false;
}

export function requestedFactCoverage(
  question: string,
  evidence: string | string[],
  options: {
    latestnessProven?: boolean;
    latestnessVersion?: string;
    requestedFacts?: RequestedFactKind[];
    releaseEvidence?: ReleaseFactEvidence[];
    officialSourcesRequired?: boolean;
    requestedPredicate?: RequestedPredicateRequirement;
    predicateEvidence?: string[];
    structuredFacts?: StructuredPersonRoleFact[];
  } = {},
): RequestedFactCoverage {
  const required = options.requestedFacts ?? extractRequestedFacts(question);
  const evidenceItems = Array.isArray(evidence) ? evidence : [evidence];
  const combinedEvidence = evidenceItems.join("\n");
  const requestedPredicate = options.requestedPredicate ?? extractRequestedPredicate(question);
  const stableRequired = required.includes("stable status") || /\bstable\b/i.test(question);
  const releaseEvidence = (options.releaseEvidence ?? []).filter(
    (record) => !options.officialSourcesRequired || record.officialSource,
  );
  const releaseFactRecords = options.latestnessVersion
    ? releaseEvidence.filter((record) => record.version === options.latestnessVersion)
    : releaseEvidence;
  const dateConflictingVersions = new Set<string>();
  const stabilityConflictingVersions = new Set<string>();
  const recordsByVersion = new Map<string, ReleaseFactEvidence[]>();
  for (const record of releaseFactRecords) {
    const key = `${record.entity.toLowerCase()}|${record.version.toLowerCase()}`;
    const group = recordsByVersion.get(key) ?? [];
    group.push(record);
    recordsByVersion.set(key, group);
  }
  for (const [key, records] of recordsByVersion) {
    const stabilityValues = new Set(
      records.flatMap((record) => (record.stability === "unknown" ? [] : [record.stability])),
    );
    const dateValues = new Set(
      records.flatMap((record) =>
        record.releaseDateClaimIds?.length
          ? [
              ...(record.releaseDate ? [record.releaseDate] : []),
              ...(record.releaseDateConflicts ?? []),
            ]
          : [],
      ),
    );
    if (
      dateValues.size > 1 ||
      records.some(
        (record) => record.releaseDateClaimIds?.length && record.releaseDateConflicts?.length,
      )
    ) {
      dateConflictingVersions.add(key);
    }
    if (stabilityValues.size > 1 || records.some((record) => record.stabilityConflicts?.length)) {
      stabilityConflictingVersions.add(key);
    }
  }
  const unconflictedDateRecords = releaseFactRecords.filter(
    (record) =>
      !dateConflictingVersions.has(
        `${record.entity.toLowerCase()}|${record.version.toLowerCase()}`,
      ),
  );
  const unconflictedStabilityRecords = releaseFactRecords.filter(
    (record) =>
      !stabilityConflictingVersions.has(
        `${record.entity.toLowerCase()}|${record.version.toLowerCase()}`,
      ),
  );
  const present = required.filter((kind) => {
    if (kind === "latestness") {
      return options.latestnessProven === undefined
        ? evidenceItems.some((item) => hasLatestnessEvidence(item, stableRequired))
        : options.latestnessProven;
    }
    if (kind === "end-of-life date") {
      return evidenceItems.some((item) => hasEndOfLifeDateEvidence(question, item));
    }
    if (kind === "version" && releaseFactRecords.some((record) => record.version)) return true;
    if (
      kind === "release date" &&
      unconflictedDateRecords.some(
        (record) => record.releaseDate && record.releaseDateClaimIds?.length,
      )
    ) {
      return true;
    }
    if (
      kind === "stable status" &&
      unconflictedStabilityRecords.some((record) => record.stability === "stable")
    ) {
      return true;
    }
    if (
      kind === "release status" &&
      unconflictedStabilityRecords.some((record) => record.stability !== "unknown")
    ) {
      return true;
    }
    if (
      (kind === "release date" || kind === "release status" || kind === "stable status") &&
      (kind === "release date"
        ? dateConflictingVersions.size > 0
        : stabilityConflictingVersions.size > 0)
    ) {
      return false;
    }
    if (
      options.officialSourcesRequired &&
      ["version", "release date", "release status", "stable status"].includes(kind)
    ) {
      return false;
    }
    return hasFact(kind, combinedEvidence);
  });
  const missing = required.filter((kind) => !present.includes(kind));
  return {
    required,
    present,
    missing,
    ...(requestedPredicate
      ? {
          requestedPredicate: {
            predicate: requestedPredicate.predicate,
            present: requestedPredicatePresent(
              options.predicateEvidence ?? evidenceItems,
              requestedPredicate,
              options.structuredFacts,
            ),
          },
        }
      : {}),
  };
}

export function missingRequestedFactSupportFromCoverage(coverage: RequestedFactCoverage): string[] {
  return [
    ...coverage.missing.map((kind) => missingFactMessages[kind]),
    ...(coverage.requestedPredicate && !coverage.requestedPredicate.present
      ? [
          `the requested ${coverage.requestedPredicate.predicate} fact is not stated in verified evidence`,
        ]
      : []),
  ];
}

export function classifyEvidenceStatusFromCoverage(
  coverage: RequestedFactCoverage,
  hasVerifiedEvidence: boolean,
): EvidenceStatus {
  if (!hasVerifiedEvidence) return "INSUFFICIENT_EVIDENCE";
  return hasCompleteRequestedFactCoverage(coverage) ? "SUPPORTED_EVIDENCE" : "GENERIC_SUPPORT";
}

const missingFactMessages: Record<RequestedFactKind, string> = {
  version: "the requested version is not stated in a verified claim",
  "release date": "the requested release date is not stated in a verified claim",
  "release status": "the requested release status is not stated for a specific version",
  "stable status": "the requested version is not explicitly identified as stable",
  latestness: "the requested latest/stable status is not established by a versioned claim",
  "end-of-life date": "the requested end-of-life date is not tied to the specified entity/version",
  price: "the requested price is not stated in a verified claim",
  "technical value": "the requested technical value is not stated in a verified claim",
};

export function missingRequestedFactSupport(
  question: string,
  verifiedClaimTexts: string[],
  options: {
    latestnessProven?: boolean;
    latestnessVersion?: string;
    requestedFacts?: RequestedFactKind[];
    releaseEvidence?: ReleaseFactEvidence[];
    officialSourcesRequired?: boolean;
    requestedPredicate?: RequestedPredicateRequirement;
    predicateEvidence?: string[];
    structuredFacts?: StructuredPersonRoleFact[];
  } = {},
): string[] {
  return missingRequestedFactSupportFromCoverage(
    requestedFactCoverage(question, verifiedClaimTexts, options),
  );
}

/** Classify whether verified claims support the requested facts, not merely any claim. */
export function classifyEvidenceStatus(
  question: string,
  verifiedClaimTexts: string[],
  options: {
    latestnessProven?: boolean;
    latestnessVersion?: string;
    requestedFacts?: RequestedFactKind[];
    releaseEvidence?: ReleaseFactEvidence[];
    officialSourcesRequired?: boolean;
    requestedPredicate?: RequestedPredicateRequirement;
    predicateEvidence?: string[];
    structuredFacts?: StructuredPersonRoleFact[];
  } = {},
): EvidenceStatus {
  return classifyEvidenceStatusFromCoverage(
    requestedFactCoverage(question, verifiedClaimTexts, options),
    verifiedClaimTexts.length > 0,
  );
}
