import { containsExactEntity, extractKnownEntities } from "./entities.js";

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
  } = {},
): RequestedFactCoverage {
  const required = options.requestedFacts ?? extractRequestedFacts(question);
  const evidenceItems = Array.isArray(evidence) ? evidence : [evidence];
  const combinedEvidence = evidenceItems.join("\n");
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
  return { required, present, missing };
}

export function missingRequestedFactSupportFromCoverage(coverage: RequestedFactCoverage): string[] {
  return coverage.missing.map((kind) => missingFactMessages[kind]);
}

export function classifyEvidenceStatusFromCoverage(
  coverage: RequestedFactCoverage,
  hasVerifiedEvidence: boolean,
): EvidenceStatus {
  if (!hasVerifiedEvidence) return "INSUFFICIENT_EVIDENCE";
  return coverage.missing.length > 0 ? "GENERIC_SUPPORT" : "SUPPORTED_EVIDENCE";
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
  } = {},
): EvidenceStatus {
  return classifyEvidenceStatusFromCoverage(
    requestedFactCoverage(question, verifiedClaimTexts, options),
    verifiedClaimTexts.length > 0,
  );
}
