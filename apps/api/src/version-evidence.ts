import type {
  Claim,
  LatestnessAssessment,
  LatestnessUnresolvedReason,
  ReleaseEvidenceRecord,
  Source,
  VersionEvidenceCandidate,
  VersionEvidenceComparison,
} from "./domain.js";
import type { RequestedFactKind } from "./requested-facts.js";
import { containsExactEntity, subjectEntityMismatchReason } from "./entities.js";
import { isOfficialSourceForEntities } from "./rank.js";
import {
  hasSemanticReleaseStatusCue,
  isFeatureStabilityPassage,
  isWithdrawnReleasePassage,
  parseOfficialReleaseHistorySource as parseOfficialReleaseHistoryEntries,
  resolveOfficialReleaseHistory,
} from "./release-history.js";

export interface VersionEvidenceInput {
  question: string;
  entities: string[];
  claims: Claim[];
  sources: Source[];
  officialSourcesRequired: boolean;
  stableRequired: boolean;
  releaseDateRequired?: boolean;
  releaseRecords?: ReleaseEvidenceRecord[];
}

export interface ReleaseFactCandidateInput {
  question: string;
  entities: string[];
  requestedFacts: RequestedFactKind[];
  sources: Source[];
  officialSourcesRequired: boolean;
}

interface ParsedVersion {
  raw: string;
  components: bigint[];
  prerelease: string[];
}

const versionPattern = /\bv?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/gi;
const prereleasePattern =
  /\b(?:canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i;
const latestPattern = /\b(?:latest|newest|current|most recent)\b/i;
const completeHistoryPattern =
  /\b(?:complete|full)\s+(?:official\s+)?(?:stable\s+)?(?:release|version)\s+history\b|\ball\s+stable\s+(?:releases|versions)\b|\bcomplete list of (?:stable )?(?:releases|versions)\b/i;
const stableReleasePattern =
  /\b(?:stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:releases?|versions?|channels?)|(?:release|version|channel)\s+(?:is|was|became|remains)\s+(?:the\s+)?(?:latest\s+)?stable|(?:is|was|became|remains)\s+(?:now\s+)?(?:a\s+|the\s+)?stable(?:\s+(?:release|version|channel))?|(?:latest|newest|current)\s+stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:releases?|versions?|channels?)|stable\s*\/\s*latest|latest\s*\/\s*stable|(?:belongs to|is in|uses)\s+(?:the\s+)?stable\s+(?:release\s+)?channel)\b/i;
const featureStabilityPattern =
  /\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?|both of these|these)\b[^.!?\n]{0,120}\bstable\b|\bstable\b[^.!?\n]{0,120}\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?)\b/i;
const releaseContextPattern =
  /\b(?:release announcement|release notes?|changelog|released|release date|now available|available on npm|published to npm|stable release)\b/i;
const releaseEventClaimPattern =
  /\b(?:release announcement|release notes?|released|release date|now available|available on npm|published to npm)\b/i;
const releaseDatePattern =
  /\b20\d{2}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}\b/gi;

export function compareVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;

  const componentCount = Math.max(a.components.length, b.components.length);
  for (let index = 0; index < componentCount; index += 1) {
    const leftPart = a.components[index] ?? 0n;
    const rightPart = b.components[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const identifierCount = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const normalized = value.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [core, prereleaseText] = normalized.split("-");
  if (!core || !/^\d+(?:\.\d+){1,3}$/.test(core)) return undefined;

  return {
    raw: normalized,
    components: core.split(".").map((part) => BigInt(part)),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

function versionStatement(text: string, index: number, length: number): string {
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

function normalizeDate(value: string): string | undefined {
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})(?=T|$)/i);
  if (iso) return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const monthNames: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const monthFirst = value.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i,
  );
  const dayFirst = value.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i,
  );
  const match = monthFirst ?? dayFirst;
  if (!match) return undefined;
  const monthName = (monthFirst ? match[1] : match[2])?.toLowerCase() ?? "";
  const month = monthNames[monthName];
  const day = Number(monthFirst ? match[2] : match[1]);
  const year = Number(match[3]);
  return month ? validIsoDate(year, month, day) : undefined;
}

function validIsoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function versionContexts(text: string, targetVersion: string): string[] {
  return [...text.matchAll(new RegExp(versionPattern.source, "gi"))]
    .filter((match) => {
      const version = parseVersion(match[1] ?? match[0]);
      return version && compareVersions(version.raw, targetVersion) === 0;
    })
    .map((match) => versionStatement(text, match.index ?? 0, match[0].length));
}

/**
 * Keep entity checks scoped to source identity and the passage making a claim.
 * A page may discuss several products; unrelated mentions elsewhere must not
 * veto a valid passage, while a passage about a more-specific sibling (for
 * example React Native for a React request) remains ineligible.
 */
function hasMatchingSourceIdentity(question: string, source: Source): boolean {
  const firstPartyEntity = source.firstPartyClassification?.entity ?? "";
  const identity = `${source.title}\n${source.url}\n${source.domain}\n${firstPartyEntity}`;
  return !subjectEntityMismatchReason(question, identity);
}

function isEntityScopedPassage(question: string, entity: string, passage: string): boolean {
  return containsExactEntity(passage, entity) && !subjectEntityMismatchReason(question, passage);
}

function entityScopedVersionContexts(
  question: string,
  entity: string,
  text: string,
  version: string,
): string[] {
  return versionContexts(text, version).filter((context) =>
    isEntityScopedPassage(question, entity, context),
  );
}

function dateIn(text: string): string | undefined {
  for (const [date] of text.matchAll(new RegExp(releaseDatePattern.source, "gi"))) {
    const normalized = normalizeDate(date);
    if (normalized) return normalized;
  }
  return undefined;
}

function urlPageDate(source: Source): string | undefined {
  try {
    const pathname = new URL(source.url).pathname;
    const match = pathname.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
    if (!match) return undefined;
    return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  } catch {
    return undefined;
  }
}

function pageDate(source: Source): {
  date?: string;
  origin?: "page_metadata" | "url" | "content" | "snippet";
  evidence?: string;
} {
  const content = source.content ?? "";
  const byline = content.slice(0, 1200);
  const bylineDates = [...byline.matchAll(new RegExp(releaseDatePattern.source, "gi"))];
  const attributedDate = bylineDates.find((match) =>
    /\b(?:by|author|published|posted)\b/i.test(
      byline.slice(Math.max(0, (match.index ?? 0) - 50), (match.index ?? 0) + match[0].length + 80),
    ),
  );
  const urlDate = urlPageDate(source);
  if (attributedDate) {
    return {
      date: normalizeDate(attributedDate[0]),
      origin: "content",
      evidence: byline
        .slice(
          Math.max(0, (attributedDate.index ?? 0) - 50),
          (attributedDate.index ?? 0) + attributedDate[0].length + 80,
        )
        .trim(),
    };
  }
  const metadataDate = normalizeDate(source.pagePublishedAt ?? "");
  if (metadataDate) {
    return { date: metadataDate, origin: "page_metadata", evidence: source.pagePublishedAt };
  }
  const snippetByline = (source.snippet ?? "").slice(0, 1200);
  const snippetDate = [...snippetByline.matchAll(new RegExp(releaseDatePattern.source, "gi"))].find(
    (match) =>
      /\b(?:by|author|published|posted)\b/i.test(
        snippetByline.slice(
          Math.max(0, (match.index ?? 0) - 50),
          (match.index ?? 0) + match[0].length + 80,
        ),
      ),
  );
  if (snippetDate) {
    return {
      date: normalizeDate(snippetDate[0]),
      origin: "snippet",
      evidence: snippetByline
        .slice(
          Math.max(0, (snippetDate.index ?? 0) - 50),
          (snippetDate.index ?? 0) + snippetDate[0].length + 80,
        )
        .trim(),
    };
  }
  if (urlDate) {
    return { date: urlDate, origin: "url", evidence: new URL(source.url).pathname };
  }
  return {};
}

function releaseDateForVersion(
  source: Source,
  version: string,
  sourceText: string,
  question: string,
  entity: string,
): Pick<
  ReleaseEvidenceRecord,
  | "releaseDate"
  | "pageDate"
  | "dateAssociationReason"
  | "releaseDateEvidence"
  | "releaseDateSourceIds"
  | "releaseDateConfidence"
  | "releaseDateExplicit"
  | "releaseDateOrigin"
> {
  const historyEntry = parseOfficialReleaseHistoryEntries(source, question, entity).find(
    (entry) => entry.version === version && entry.releaseDate,
  );
  if (historyEntry?.releaseDate) {
    return {
      releaseDate: historyEntry.releaseDate,
      pageDate: historyEntry.releaseDate,
      dateAssociationReason: "versioned-release-statement",
      releaseDateEvidence: historyEntry.evidence,
      releaseDateSourceIds: [source.id],
      releaseDateConfidence: 1,
      releaseDateExplicit: true,
      releaseDateOrigin: "content",
    };
  }

  const versionedReleaseDate = [
    { text: source.content ?? "", origin: "content" as const },
    { text: source.snippet ?? "", origin: "snippet" as const },
  ].flatMap(({ text, origin }) =>
    entityScopedVersionContexts(question, entity, text, version)
      .filter((context) => dateIn(context) && releaseContextPattern.test(context))
      .map((context) => ({ context, origin })),
  )[0];
  if (versionedReleaseDate) {
    const dateSource = pageDate(source);
    return {
      releaseDate: dateIn(versionedReleaseDate.context),
      pageDate: dateSource.date,
      dateAssociationReason: "versioned-release-statement",
      releaseDateEvidence: versionedReleaseDate.context.trim(),
      releaseDateSourceIds: [source.id],
      releaseDateConfidence: 1,
      releaseDateExplicit: true,
      releaseDateOrigin: versionedReleaseDate.origin,
    };
  }

  const sourcePageDate = pageDate(source);
  const hasVersionInPageIdentity = versionsInText(`${source.title}\n${source.url}`).some(
    (pageVersion) => compareVersions(pageVersion, version) === 0,
  );
  const hasEntityScopedReleaseContext = entityScopedVersionContexts(
    question,
    entity,
    `${source.content ?? ""}\n${source.snippet ?? ""}`,
    version,
  ).some((context) => releaseContextPattern.test(context));
  if (sourcePageDate.date && hasVersionInPageIdentity && hasEntityScopedReleaseContext) {
    return {
      releaseDate: sourcePageDate.date,
      pageDate: sourcePageDate.date,
      dateAssociationReason: "dated-release-announcement",
      releaseDateEvidence:
        `${sourcePageDate.evidence ?? sourcePageDate.date}\n${source.title}\n${source.snippet ?? source.content ?? ""}`.trim(),
      releaseDateSourceIds: [source.id],
      releaseDateConfidence: sourcePageDate.origin === "url" ? 0.9 : 0.85,
      releaseDateExplicit: false,
      releaseDateOrigin: sourcePageDate.origin,
    };
  }

  return {
    pageDate: sourcePageDate.date,
    dateAssociationReason: sourcePageDate.date ? "publication-date-only" : undefined,
  };
}

function claimSupportsReleaseDate(
  claimText: string,
  claimEvidence: string,
  version: string,
  releaseDate: string,
  source: Source,
  question: string,
  entity: string,
): boolean {
  const claimBindsDateToRelease = versionContexts(claimText, version).some(
    (context) => dateIn(context) === releaseDate && releaseEventClaimPattern.test(context),
  );
  if (!claimBindsDateToRelease || dateIn(claimEvidence) !== releaseDate) return false;

  const sourcePassages = entityScopedVersionContexts(
    question,
    entity,
    `${source.content ?? ""}\n${source.snippet ?? ""}`,
    version,
  );
  const directReleasePassage = sourcePassages.find(
    (passage) => dateIn(passage) === releaseDate && releaseEventClaimPattern.test(passage),
  );
  const byline = attributedPageDate(source.content ?? "");
  const attributedAnnouncement = Boolean(
    byline &&
    normalizeDate(byline.value) === releaseDate &&
    versionsInText(`${source.title}\n${source.url}`).some(
      (pageVersion) => compareVersions(pageVersion, version) === 0,
    ) &&
    sourcePassages.some((passage) => releaseEventClaimPattern.test(passage)),
  );
  const historyEntrySupportsDate = parseOfficialReleaseHistoryEntries(
    source,
    question,
    entity,
  ).some(
    (entry) =>
      entry.version === version &&
      entry.releaseDate === releaseDate &&
      claimEvidence.includes(entry.passage),
  );
  return Boolean(directReleasePassage || attributedAnnouncement || historyEntrySupportsDate);
}

function releaseStability(
  version: string,
  sourceText: string,
): {
  stability: ReleaseEvidenceRecord["stability"];
  evidence?: string;
  reason: NonNullable<ReleaseEvidenceRecord["stabilityReason"]>;
  featureEvidence?: string;
} {
  const contexts = versionContexts(sourceText, version);
  const prereleaseEvidence = contexts.find((context) => prereleasePattern.test(context));
  if (parseVersion(version)?.prerelease.length || prereleaseEvidence) {
    return {
      stability: "prerelease",
      evidence: prereleaseEvidence?.trim() ?? `${version} is a prerelease version`,
      reason: "prerelease-version",
    };
  }

  const stableStatement = contexts.find(
    (context) => stableReleasePattern.test(context) && !featureStabilityPattern.test(context),
  );
  if (stableStatement) {
    return {
      stability: "stable",
      evidence: stableStatement.trim(),
      reason: "explicit-version-release",
    };
  }

  const featureEvidence = contexts.find((context) => featureStabilityPattern.test(context));

  const stableReleaseSection = sourceText.match(
    /\b(?:stable|production)\s+releases?\s*[:\-]\s*([\s\S]{0,4000})/i,
  );
  if (
    stableReleaseSection &&
    versionsInText(stableReleaseSection[1] ?? "").some(
      (listed) => compareVersions(listed, version) === 0,
    )
  ) {
    return {
      stability: "stable",
      evidence: `Stable-release list: ${stableReleaseSection[0].slice(0, 500).trim()}`,
      reason: "stable-release-list",
    };
  }

  const completeStableHistory = completeHistoryPattern.test(sourceText)
    ? sourceText.match(
        /[^.!?\n]*\b(?:complete|full|all)\b[^.!?\n]*\bstable\b[^.!?\n]*\b(?:release|version)\s+history\b[^.!?\n]*/i,
      )?.[0]
    : undefined;
  if (
    completeStableHistory &&
    versionsInText(sourceText).some((listed) => compareVersions(listed, version) === 0)
  ) {
    return {
      stability: "stable",
      evidence: completeStableHistory.trim(),
      reason: "complete-stable-history",
    };
  }
  return {
    stability: "unknown",
    reason: featureEvidence ? "feature-stability-only" : "not-established",
    featureEvidence: featureEvidence?.trim(),
  };
}

function releaseChannelForVersion(
  version: string,
  sourceText: string,
  stability: ReleaseEvidenceRecord["stability"],
): string | undefined {
  if (stability === "stable") return "stable";
  const prerelease = parseVersion(version)?.prerelease[0]?.toLowerCase();
  if (prerelease) return prerelease;
  const contexts = versionContexts(sourceText, version);
  for (const context of contexts) {
    const channel = context.match(/\b(canary|nightly|alpha|beta|preview|rc)\b/i)?.[1];
    if (channel) return channel.toLowerCase();
  }
  return undefined;
}

function latestnessEvidenceForVersion(version: string, sourceText: string): string | undefined {
  return versionContexts(sourceText, version)
    .find((context) => latestPattern.test(context) && stableReleasePattern.test(context))
    ?.trim();
}

function evidenceStatements(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function attributedPageDate(text: string): { value: string; statement: string } | undefined {
  const byline = text.slice(0, 1200);
  for (const match of byline.matchAll(new RegExp(releaseDatePattern.source, "gi"))) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 50);
    const end = Math.min(byline.length, index + match[0].length + 80);
    const nearby = byline.slice(start, end);
    if (!/\b(?:by|author|published|posted)\b/i.test(nearby)) continue;
    const statement = evidenceStatements(byline).find((item) => item.includes(match[0])) ?? nearby;
    return { value: match[0], statement };
  }
  return undefined;
}

function sourceFragmentContaining(
  text: string,
  snippets: string[],
  maxChars = 1500,
): string | undefined {
  const positions = snippets
    .map((snippet) => ({ snippet, index: text.indexOf(snippet) }))
    .filter((item) => item.index >= 0);
  if (positions.length !== snippets.length) return undefined;
  const start = Math.min(...positions.map((item) => item.index));
  const end = Math.max(...positions.map((item) => item.index + item.snippet.length));
  if (end - start > maxChars) return undefined;
  return text.slice(start, end).trim();
}

function pageTitleBoundEvidence(source: Source, version: string, evidence: string): string {
  const titleVersions = versionsInText(source.title);
  const titleMatchesVersion = titleVersions.some(
    (titleVersion) => compareVersions(titleVersion, version) === 0,
  );
  if (!titleMatchesVersion) return evidence;

  return `Page title metadata: ${source.title.trim().slice(0, 240)}\n${evidence}`;
}

/** Parse only explicit, entity-scoped rows from eligible first-party release-history sources. */
export function extractOfficialReleaseHistoryClaimCandidates(
  input: ReleaseFactCandidateInput,
): Claim[] {
  const entity = input.entities.length === 1 ? input.entities[0] : undefined;
  if (!entity || !input.officialSourcesRequired) return [];

  const requested = new Set(input.requestedFacts);
  const claims = new Map<string, Claim>();
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const history = resolveOfficialReleaseHistory({
    sources: input.sources,
    question: input.question,
    entity,
  });
  for (const entry of history.records) {
    const source = sourceById.get(entry.sourceId);
    if (!source) continue;
    const facts: RequestedFactKind[] = [];
    if (requested.has("version")) facts.push("version");
    if (entry.releaseDate && requested.has("release date")) facts.push("release date");
    if (entry.stability === "stable" && requested.has("stable status")) facts.push("stable status");
    if (entry.stability !== "unknown" && requested.has("release status"))
      facts.push("release status");
    if (entry.explicitlyLatest && requested.has("latestness")) facts.push("latestness");
    if (facts.length === 0) continue;

    const statusText =
      entry.stability === "stable"
        ? "is a stable release"
        : entry.stability === "prerelease"
          ? `is a ${entry.releaseChannel ?? "prerelease"} release`
          : "is listed in the official release history";
    const dateText = entry.releaseDate ? `, released on ${entry.releaseDate}` : "";
    const latestText = entry.explicitlyLatest
      ? " and is identified as the latest stable release"
      : "";
    const versionKey = entry.version.replace(/[^a-z\d]+/gi, "-").replace(/^-|-$/g, "");
    const id = `history-${source.id}-${versionKey}`;
    claims.set(id, {
      id,
      text: `${entity} ${entry.version} ${statusText}${dateText}${latestText}.`,
      evidence: entry.evidence,
      sourceIds: [source.id],
      confidence: source.quality.overall,
      importance: "critical",
      requestedFacts: facts,
      verification: {
        verdict: "supported",
        rationale: "Deterministic parse of an eligible official release-history entry.",
      },
    });
  }
  return [...claims.values()];
}

/** Promote only exact official release facts that can be validated from source text and identity. */
export function validateDeterministicReleaseFactCandidates(input: {
  question: string;
  entities: string[];
  claims: Claim[];
  sources: Source[];
  officialSourcesRequired: boolean;
}): Claim[] {
  const entity = input.entities.length === 1 ? input.entities[0] : undefined;
  if (!entity || !input.officialSourcesRequired) return input.claims;

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  return input.claims.map((claim) => {
    if (claim.verification || !claim.requestedFacts?.length) return claim;
    const facts = new Set(claim.requestedFacts);
    if (
      !["version", "release date", "release status", "stable status", "latestness"].some((fact) =>
        facts.has(fact as RequestedFactKind),
      )
    )
      return claim;

    for (const sourceId of claim.sourceIds) {
      const source = sourceById.get(sourceId);
      if (
        !source?.content?.trim() ||
        !hasMatchingSourceIdentity(input.question, source) ||
        !isOfficialSourceForEntities(source, [entity])
      )
        continue;

      const versions = versionsInText(claim.text);
      if (versions.length !== 1) continue;
      const version = versions[0]!;
      const sourcePassages = entityScopedVersionContexts(
        input.question,
        entity,
        source.content,
        version,
      );
      const historyEntry = parseOfficialReleaseHistoryEntries(source, input.question, entity).find(
        (entry) => entry.version === version && claim.evidence.includes(entry.passage),
      );
      const hasVersionReleaseEvent =
        sourcePassages.some(
          (passage) => releaseEventClaimPattern.test(passage) && claim.evidence.includes(passage),
        ) || Boolean(historyEntry);
      const attributedDate = attributedPageDate(source.content);
      const attributedDateMatch = Boolean(
        attributedDate &&
        dateIn(claim.text) === normalizeDate(attributedDate.value) &&
        versionsInText(`${source.title}\n${source.url}`).some(
          (pageVersion) => compareVersions(pageVersion, version) === 0,
        ) &&
        claim.evidence.includes(attributedDate.statement) &&
        sourcePassages.some(
          (passage) => releaseEventClaimPattern.test(passage) && claim.evidence.includes(passage),
        ),
      );
      const factSupported = claim.requestedFacts!.every((fact) => {
        if (fact === "version" || fact === "release status") return hasVersionReleaseEvent;
        if (fact === "release date") {
          const claimedDate = dateIn(claim.text);
          const directDatePassage = sourcePassages.some(
            (passage) =>
              dateIn(passage) === claimedDate &&
              releaseEventClaimPattern.test(passage) &&
              claim.evidence.includes(passage),
          );
          return Boolean(
            claimedDate &&
            claim.evidence.trim() &&
            (directDatePassage || attributedDateMatch || historyEntry?.releaseDate === claimedDate),
          );
        }
        if (fact === "stable status") {
          return (
            sourcePassages.some(
              (passage) =>
                releaseStability(version, passage).stability === "stable" &&
                claim.evidence.includes(passage),
            ) || historyEntry?.stability === "stable"
          );
        }
        if (fact === "latestness") {
          return sourcePassages.some(
            (passage) =>
              Boolean(latestnessEvidenceForVersion(version, passage)) &&
              claim.evidence.includes(passage),
          );
        }
        return false;
      });
      if (!factSupported) continue;

      return {
        ...claim,
        verification: {
          verdict: "supported",
          rationale:
            "Deterministically matched to an explicit official release fact and its source context.",
        },
      };
    }
    return claim;
  });
}

/**
 * Prepare unverified, source-linked candidates for requested release facts.
 * This only selects/copies source material; callers must still verify every
 * candidate before it can contribute to release records or objective coverage.
 */
export function extractReleaseFactClaimCandidates(input: ReleaseFactCandidateInput): Claim[] {
  const entity = input.entities.length === 1 ? input.entities[0] : undefined;
  const releaseFacts = new Set<RequestedFactKind>([
    "version",
    "release date",
    "release status",
    "stable status",
    "latestness",
  ]);
  const requested = new Set(input.requestedFacts.filter((fact) => releaseFacts.has(fact)));
  if (!entity || requested.size === 0) return [];

  const result = new Map<string, Claim>();
  const addCandidate = (
    source: Source,
    version: string,
    kind: string,
    facts: RequestedFactKind[],
    text: string,
    evidence: string,
  ) => {
    const relevantFacts = facts.filter((fact) => requested.has(fact));
    if (!relevantFacts.length || !text.trim() || !evidence.trim()) return;
    const versionKey = version.replace(/[^a-z\d]+/gi, "-").replace(/^-|-$/g, "");
    const id = `fact-${source.id}-${versionKey}-${kind}`;
    if (result.has(id)) return;
    result.set(id, {
      id,
      text: text.trim(),
      evidence: evidence.trim(),
      sourceIds: [source.id],
      confidence: source.quality.overall,
      importance: "critical",
      requestedFacts: relevantFacts,
    });
  };

  for (const source of input.sources) {
    const content = source.content?.trim() || source.snippet.trim();
    if (!content || !hasMatchingSourceIdentity(input.question, source)) continue;
    if (input.officialSourcesRequired && !isOfficialSourceForEntities(source, [entity])) continue;

    const versions = versionsInText(content);
    const dateEvidence = attributedPageDate(content);

    for (const version of versions) {
      const versionContextsForSource = entityScopedVersionContexts(
        input.question,
        entity,
        content,
        version,
      );
      for (const context of versionContextsForSource) {
        const isFeatureStability = featureStabilityPattern.test(context);
        const isReleaseStability = stableReleasePattern.test(context) && !isFeatureStability;
        const isReleaseEvent = releaseEventClaimPattern.test(context);

        if ((requested.has("version") || requested.has("release status")) && isReleaseEvent) {
          addCandidate(
            source,
            version,
            "version-release",
            ["version", "release status"],
            context,
            context,
          );
        }

        if (
          requested.has("stable status") &&
          (isReleaseStability || hasSemanticReleaseStatusCue(context))
        ) {
          addCandidate(source, version, "release-stability", ["stable status"], context, context);
        }

        if (requested.has("latestness") && isReleaseStability && latestPattern.test(context)) {
          addCandidate(
            source,
            version,
            "explicit-latestness",
            ["latestness", "stable status", "version"],
            context,
            context,
          );
        }

        if (requested.has("release date") && isReleaseEvent) {
          const explicitDate = dateIn(context);
          if (explicitDate) {
            addCandidate(source, version, "release-date", ["release date"], context, context);
          } else if (dateEvidence) {
            const evidence = sourceFragmentContaining(content, [dateEvidence.statement, context]);
            if (evidence) {
              addCandidate(
                source,
                version,
                "release-date",
                ["release date"],
                `${entity} ${version} release announcement is dated ${dateEvidence.value}.`,
                pageTitleBoundEvidence(source, version, evidence),
              );
            }
          }
        }
      }
    }
  }

  return [...result.values()];
}

/** Extract source-attributed release records only when a supported claim ties the version to it. */
export function extractReleaseEvidenceRecords(
  input: VersionEvidenceInput,
): ReleaseEvidenceRecord[] {
  const requestedEntity = input.entities.length === 1 ? input.entities[0] : undefined;
  if (!requestedEntity) return [];

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const records: ReleaseEvidenceRecord[] = [];
  for (const claim of input.claims) {
    if (claim.verification?.verdict !== "supported") continue;
    const claimText = `${claim.text}\n${claim.evidence}`;
    const claimVersions = versionsInText(claimText);
    if (claimVersions.length === 0) continue;

    for (const sourceId of claim.sourceIds) {
      const source = sourceById.get(sourceId);
      if (
        !source ||
        (!source.content && !source.snippet) ||
        !hasMatchingSourceIdentity(input.question, source)
      )
        continue;
      const officialSource = isOfficialSourceForEntities(source, [requestedEntity]);
      if (input.officialSourcesRequired && !officialSource) continue;

      const sourceText = `${source.title}\n${source.url}\n${source.content ?? ""}\n${source.snippet ?? ""}`;
      const sourceVersions = versionsInText(sourceText);
      for (const version of claimVersions) {
        if (!sourceVersions.some((pageVersion) => compareVersions(pageVersion, version) === 0)) {
          continue;
        }
        const claimPassages = entityScopedVersionContexts(
          input.question,
          requestedEntity,
          claimText,
          version,
        );
        const sourcePassages = entityScopedVersionContexts(
          input.question,
          requestedEntity,
          sourceText,
          version,
        );
        const claimSourcePassages = sourcePassages.filter((passage) =>
          claim.evidence.includes(passage),
        );
        const historyEntry = parseOfficialReleaseHistoryEntries(
          source,
          input.question,
          requestedEntity,
        ).find((entry) => entry.version === version);
        if (!claimPassages.length || (!sourcePassages.length && !historyEntry)) continue;

        const scopedClaimText = claimPassages.join("\n");
        const sourceScopedText = claimSourcePassages.join("\n");
        let stability =
          historyEntry && historyEntry.stability !== "unknown"
            ? {
                stability: historyEntry.stability,
                evidence: historyEntry.evidence,
                reason:
                  historyEntry.stability === "prerelease"
                    ? ("prerelease-version" as const)
                    : ("stable-release-list" as const),
                featureEvidence: undefined,
              }
            : releaseStability(version, sourceScopedText);
        if (
          stability.stability === "unknown" &&
          claim.requestedFacts?.includes("stable status") &&
          claim.verification?.verdict === "supported"
        ) {
          const semanticStatusPassage = claimSourcePassages.find(
            (passage) =>
              claim.evidence.includes(passage) &&
              hasSemanticReleaseStatusCue(passage) &&
              !isFeatureStabilityPassage(passage),
          );
          if (semanticStatusPassage) {
            stability = {
              stability: "stable",
              evidence: semanticStatusPassage,
              reason: "explicit-version-release",
            };
          }
        }
        const releaseChannel = releaseChannelForVersion(
          version,
          sourceScopedText || scopedClaimText,
          stability.stability,
        );
        const date = releaseDateForVersion(
          source,
          version,
          sourceText,
          input.question,
          requestedEntity,
        );
        const latestnessEvidence = latestnessEvidenceForVersion(version, scopedClaimText);
        const claimSupportsStability = Boolean(
          claim.requestedFacts?.some(
            (fact) => fact === "stable status" || fact === "release status",
          ) ||
          (stableReleasePattern.test(claimText) && !featureStabilityPattern.test(claimText)) ||
          prereleasePattern.test(claimText),
        );
        const releaseDateClaimIds =
          date.releaseDate &&
          claimSupportsReleaseDate(
            claim.text,
            claim.evidence,
            version,
            date.releaseDate,
            source,
            input.question,
            requestedEntity,
          )
            ? [claim.id]
            : [];
        records.push({
          entity: requestedEntity,
          version,
          releaseChannel,
          ...date,
          releaseDateReason: date.dateAssociationReason,
          releaseDateClaimIds,
          releaseDateEvidenceIds: releaseDateClaimIds,
          stability: stability.stability,
          withdrawn:
            historyEntry?.withdrawn ??
            isWithdrawnReleasePassage(sourceScopedText || scopedClaimText),
          withdrawalEvidence:
            historyEntry?.withdrawalEvidence ??
            ([sourceScopedText, scopedClaimText].find(isWithdrawnReleasePassage) || undefined),
          stabilityEvidence: stability.evidence,
          stabilityConfidence: stability.evidence ? 1 : 0,
          stabilityExplicit: stability.stability !== "unknown",
          stabilityReason: stability.reason,
          featureStabilityEvidence: stability.featureEvidence,
          stabilitySourceIds: stability.evidence ? [source.id] : [],
          stabilityClaimIds: stability.evidence && claimSupportsStability ? [claim.id] : [],
          stabilityEvidenceIds: stability.evidence && claimSupportsStability ? [claim.id] : [],
          latestnessEvidence,
          explicitlyLatest: Boolean(latestnessEvidence),
          latestnessConfidence: latestnessEvidence ? 1 : 0,
          latestnessExplicit: Boolean(latestnessEvidence),
          latestnessSourceIds: latestnessEvidence ? [source.id] : [],
          latestnessClaimIds: latestnessEvidence ? [claim.id] : [],
          versionSourceIds: [source.id],
          versionClaimIds: [claim.id],
          versionConfidence: claim.confidence,
          versionExplicit: true,
          evidenceIds: [claim.id],
          sourceId: source.id,
          sourceIds: [source.id],
          claimIds: [claim.id],
          sourceType: source.sourceType,
          officialSource,
          firstPartyClassification: source.firstPartyClassification,
          releaseHistorySourceKind: historyEntry?.sourceKind ?? source.releaseHistorySourceKind,
          releaseHistoryComplete: Boolean(
            historyEntry?.completeHistory || source.releaseHistoryComplete,
          ),
        });
      }
    }
  }
  return mergeCompatibleReleaseRecords(records);
}

function mergeCompatibleReleaseRecords(input: ReleaseEvidenceRecord[]): ReleaseEvidenceRecord[] {
  const byVersion = new Map<string, ReleaseEvidenceRecord[]>();
  for (const record of input) {
    const key = `${record.entity.toLowerCase()}|${record.version.toLowerCase()}`;
    const group = byVersion.get(key) ?? [];
    group.push(record);
    byVersion.set(key, group);
  }

  const result: ReleaseEvidenceRecord[] = [];
  for (const records of byVersion.values()) {
    const channels = [...new Set(records.map((record) => record.releaseChannel).filter(Boolean))];
    const buckets = new Map<string, ReleaseEvidenceRecord[]>();
    for (const channel of channels) buckets.set(channel!, []);
    if (channels.length !== 1) buckets.set("unknown", []);
    for (const record of records) {
      const bucket = record.releaseChannel ?? (channels.length === 1 ? channels[0]! : "unknown");
      buckets.get(bucket)!.push(record);
    }
    for (const [channel, bucket] of buckets) {
      if (bucket.length === 0) continue;
      result.push(mergeReleaseRecordGroup(bucket, channel === "unknown" ? undefined : channel));
    }
  }
  return result;
}

function mergeReleaseRecordGroup(
  records: ReleaseEvidenceRecord[],
  channel: string | undefined,
): ReleaseEvidenceRecord {
  const candidateDateRecords = records.filter((record) => record.releaseDate);
  const verifiedDateRecords = candidateDateRecords.filter(
    (record) => record.releaseDateClaimIds?.length,
  );
  // A URL or page publication date remains available as a candidate, but it
  // cannot override or conflict with a release date tied to a supported claim.
  const releaseDateRecords = verifiedDateRecords.length
    ? verifiedDateRecords
    : candidateDateRecords;
  const releaseDates = [...new Set(releaseDateRecords.map((record) => record.releaseDate))].filter(
    (date): date is string => Boolean(date),
  );
  const stableValues = [
    ...new Set(
      records
        .map((record) => record.stability)
        .filter((value): value is "stable" | "prerelease" => value !== "unknown"),
    ),
  ];
  const sourceIds = [
    ...new Set(records.flatMap((record) => record.sourceIds ?? [record.sourceId])),
  ];
  const claimIds = [...new Set(records.flatMap((record) => record.claimIds))];
  const stabilityRecords = records.filter((record) => record.stability !== "unknown");
  const latestnessRecords = records.filter((record) => record.latestnessEvidence);
  const representative = records[0]!;
  const releaseDate = releaseDates.length === 1 ? releaseDates[0] : undefined;
  const stability = stableValues.length === 1 ? stableValues[0]! : "unknown";
  const releaseDateEvidence = [
    ...new Set(releaseDateRecords.map((record) => record.releaseDateEvidence).filter(Boolean)),
  ];
  const stabilityEvidence = [
    ...new Set(stabilityRecords.map((record) => record.stabilityEvidence).filter(Boolean)),
  ];
  const featureStabilityEvidence = [
    ...new Set(records.map((record) => record.featureStabilityEvidence).filter(Boolean)),
  ];
  const latestnessEvidence = [
    ...new Set(latestnessRecords.map((record) => record.latestnessEvidence).filter(Boolean)),
  ];

  return {
    ...representative,
    releaseChannel: channel,
    ...(releaseDate ? { releaseDate } : {}),
    pageDate: [...new Set(records.map((record) => record.pageDate).filter(Boolean))][0],
    dateAssociationReason: releaseDate
      ? releaseDateRecords.find((record) => record.releaseDate === releaseDate)
          ?.dateAssociationReason
      : records.find((record) => record.pageDate)?.dateAssociationReason,
    releaseDateReason: releaseDate
      ? (releaseDateRecords.find((record) => record.releaseDate === releaseDate)
          ?.releaseDateReason ??
        releaseDateRecords.find((record) => record.releaseDate === releaseDate)
          ?.dateAssociationReason)
      : (records.find((record) => record.pageDate)?.releaseDateReason ??
        records.find((record) => record.pageDate)?.dateAssociationReason),
    releaseDateEvidence: releaseDateEvidence.join("\n---\n") || undefined,
    releaseDateSourceIds: [
      ...new Set(releaseDateRecords.flatMap((record) => record.releaseDateSourceIds ?? [])),
    ],
    releaseDateClaimIds: [
      ...new Set(verifiedDateRecords.flatMap((record) => record.releaseDateClaimIds ?? [])),
    ],
    releaseDateEvidenceIds: [
      ...new Set(verifiedDateRecords.flatMap((record) => record.releaseDateEvidenceIds ?? [])),
    ],
    releaseDateConfidence: releaseDate
      ? Math.max(
          ...releaseDateRecords
            .filter((record) => record.releaseDate === releaseDate)
            .map((record) => record.releaseDateConfidence ?? 0),
        )
      : undefined,
    versionConfidence: Math.max(...records.map((record) => record.versionConfidence ?? 0)),
    versionExplicit: records.some((record) => record.versionExplicit),
    releaseDateExplicit: releaseDate
      ? releaseDateRecords.some(
          (record) => record.releaseDate === releaseDate && record.releaseDateExplicit,
        )
      : undefined,
    releaseDateOrigin: releaseDateRecords.find((record) => record.releaseDate === releaseDate)
      ?.releaseDateOrigin,
    releaseDateConflicts: releaseDates.length > 1 ? releaseDates : undefined,
    versionSourceIds: [
      ...new Set(records.flatMap((record) => record.versionSourceIds ?? [record.sourceId])),
    ],
    versionClaimIds: [
      ...new Set(records.flatMap((record) => record.versionClaimIds ?? record.claimIds)),
    ],
    stability,
    withdrawn: records.some((record) => record.withdrawn),
    withdrawalEvidence: records.find((record) => record.withdrawn)?.withdrawalEvidence,
    stabilityEvidence: stabilityEvidence.join("\n---\n") || undefined,
    stabilityConfidence:
      stabilityEvidence.length > 0
        ? Math.max(...stabilityRecords.map((record) => record.stabilityConfidence ?? 0))
        : 0,
    stabilityExplicit: stability !== "unknown",
    stabilityReason:
      stableValues.length > 1
        ? "not-established"
        : (stabilityRecords[0]?.stabilityReason ??
          (featureStabilityEvidence.length ? "feature-stability-only" : "not-established")),
    featureStabilityEvidence: featureStabilityEvidence.join("\n---\n") || undefined,
    stabilitySourceIds: [
      ...new Set(
        stabilityRecords.flatMap((record) => record.stabilitySourceIds ?? [record.sourceId]),
      ),
    ],
    stabilityClaimIds: [
      ...new Set(stabilityRecords.flatMap((record) => record.stabilityClaimIds ?? record.claimIds)),
    ],
    stabilityEvidenceIds: [
      ...new Set(
        stabilityRecords.flatMap((record) => record.stabilityEvidenceIds ?? record.claimIds),
      ),
    ],
    stabilityConflicts: stableValues.length > 1 ? stableValues : undefined,
    latestnessEvidence: latestnessEvidence.join("\n---\n") || undefined,
    explicitlyLatest: latestnessEvidence.length > 0,
    latestnessConfidence:
      latestnessEvidence.length > 0
        ? Math.max(...latestnessRecords.map((record) => record.latestnessConfidence ?? 0))
        : 0,
    latestnessExplicit: latestnessEvidence.length > 0,
    latestnessSourceIds: [
      ...new Set(
        latestnessRecords.flatMap((record) => record.latestnessSourceIds ?? [record.sourceId]),
      ),
    ],
    latestnessClaimIds: [
      ...new Set(
        latestnessRecords.flatMap((record) => record.latestnessClaimIds ?? record.claimIds),
      ),
    ],
    evidenceIds: [...new Set(records.flatMap((record) => record.evidenceIds ?? record.claimIds))],
    sourceId: representative.sourceId,
    sourceIds,
    claimIds,
    officialSource: records.every((record) => record.officialSource),
    sourceType: records.every((record) => record.sourceType === "official")
      ? "official"
      : representative.sourceType,
  };
}

function mergeCandidates(candidates: VersionEvidenceCandidate[]): VersionEvidenceCandidate[] {
  const merged = new Map<string, VersionEvidenceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.entity.toLowerCase()}|${candidate.version.toLowerCase()}|${candidate.releaseChannel ?? "unknown"}|${candidate.stability}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...candidate,
        sourceIds: [...new Set(candidate.sourceIds)],
        claimIds: [...new Set(candidate.claimIds)],
        latestnessSourceIds: [...new Set(candidate.latestnessSourceIds)],
        releaseDates: [...new Set(candidate.releaseDates)],
      });
      continue;
    }
    existing.sourceIds = [...new Set([...existing.sourceIds, ...candidate.sourceIds])];
    existing.claimIds = [...new Set([...existing.claimIds, ...candidate.claimIds])];
    existing.latestnessSourceIds = [
      ...new Set([...existing.latestnessSourceIds, ...candidate.latestnessSourceIds]),
    ];
    existing.releaseDates = [...new Set([...existing.releaseDates, ...candidate.releaseDates])];
    existing.explicitlyLatest ||= candidate.explicitlyLatest;
    existing.withdrawn ||= candidate.withdrawn;
  }
  return [...merged.values()];
}

function versionsInText(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(new RegExp(versionPattern.source, "gi"))]
        .map((match) => parseVersion(match[1] ?? match[0])?.raw)
        .filter((version): version is string => Boolean(version)),
    ),
  ];
}

function compareCandidates(candidates: VersionEvidenceCandidate[]): VersionEvidenceComparison[] {
  const comparisons: VersionEvidenceComparison[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!;
      if (
        left.entity !== right.entity ||
        left.stability !== right.stability ||
        !left.releaseChannel ||
        left.releaseChannel !== right.releaseChannel
      ) {
        continue;
      }
      const order = compareVersions(left.version, right.version);
      if (order === undefined || order === 0) continue;
      comparisons.push({
        olderVersion: order < 0 ? left.version : right.version,
        newerVersion: order < 0 ? right.version : left.version,
        sourceIds: [...new Set([...left.sourceIds, ...right.sourceIds])],
      });
    }
  }
  return comparisons;
}

function candidateFromHistoryEntry(
  entity: string,
  entry: ReturnType<typeof parseOfficialReleaseHistoryEntries>[number],
): VersionEvidenceCandidate {
  return {
    entity,
    version: entry.version,
    releaseChannel: entry.releaseChannel,
    stability: entry.stability,
    withdrawn: entry.withdrawn,
    sourceIds: [entry.sourceId],
    claimIds: [],
    latestnessSourceIds: entry.explicitlyLatest ? [entry.sourceId] : [],
    releaseDates: entry.releaseDate ? [entry.releaseDate] : [],
    explicitlyLatest: entry.explicitlyLatest,
  };
}

function distinctHistoryVersions(
  entries: ReturnType<typeof parseOfficialReleaseHistoryEntries>,
): ReturnType<typeof parseOfficialReleaseHistoryEntries> {
  const distinct: typeof entries = [];
  for (const entry of entries) {
    if (
      distinct.some(
        (existing) =>
          existing.releaseChannel === entry.releaseChannel &&
          compareVersions(existing.version, entry.version) === 0,
      )
    ) {
      continue;
    }
    distinct.push(entry);
  }
  return distinct;
}

function hasCompleteHistoryComparisonCoverage(
  entity: string,
  sourceId: string,
  entries: ReturnType<typeof parseOfficialReleaseHistoryEntries>,
): {
  stableEntries: ReturnType<typeof parseOfficialReleaseHistoryEntries>;
  comparisons: VersionEvidenceComparison[];
  complete: boolean;
} {
  const stableEntries = distinctHistoryVersions(
    entries.filter(
      (entry) =>
        entry.sourceId === sourceId &&
        entry.stability === "stable" &&
        entry.releaseChannel === "stable" &&
        !entry.withdrawn,
    ),
  );
  const historyCandidates = stableEntries.map((entry) => candidateFromHistoryEntry(entity, entry));
  const comparisons = compareCandidates(historyCandidates);
  const expectedComparisonCount = (stableEntries.length * (stableEntries.length - 1)) / 2;
  const everyPairCovered = stableEntries.every((left, leftIndex) =>
    stableEntries.slice(leftIndex + 1).every((right) => {
      const order = compareVersions(left.version, right.version);
      if (order === undefined || order === 0) return false;
      const olderVersion = order < 0 ? left.version : right.version;
      const newerVersion = order < 0 ? right.version : left.version;
      return comparisons.some(
        (comparison) =>
          comparison.olderVersion === olderVersion &&
          comparison.newerVersion === newerVersion &&
          comparison.sourceIds.includes(sourceId),
      );
    }),
  );

  return {
    stableEntries,
    comparisons,
    complete:
      stableEntries.length >= 2 &&
      comparisons.length === expectedComparisonCount &&
      everyPairCovered,
  };
}

export function assessLatestnessEvidence(input: VersionEvidenceInput): LatestnessAssessment {
  const requestedEntity = input.entities.length === 1 ? input.entities[0] : undefined;
  const releaseRecords = input.releaseRecords ?? extractReleaseEvidenceRecords(input);
  const historyResolution = requestedEntity
    ? resolveOfficialReleaseHistory({
        sources: input.sources,
        question: input.question,
        entity: requestedEntity,
      })
    : undefined;
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const hasOfficialSourceIdentity = (sourceId: string): boolean => {
    const source = sourceById.get(sourceId);
    return Boolean(
      requestedEntity &&
      source &&
      !source.subjectMismatchReason &&
      !subjectEntityMismatchReason(input.question, `${source.title}\n${source.url}`) &&
      isOfficialSourceForEntities(source, [requestedEntity]),
    );
  };
  const hasOfficialRecordProvenance = (record: ReleaseEvidenceRecord): boolean => {
    const sourceIds = record.sourceIds ?? [record.sourceId];
    return (
      record.officialSource && sourceIds.length > 0 && sourceIds.every(hasOfficialSourceIdentity)
    );
  };
  const trustedReleaseRecords = requestedEntity
    ? releaseRecords.filter(
        (record) => record.entity === requestedEntity && hasOfficialRecordProvenance(record),
      )
    : [];
  const historyEntries = (historyResolution?.records ?? []).filter(
    (entry) =>
      requestedEntity &&
      hasOfficialSourceIdentity(entry.sourceId) &&
      entry.sourceKind !== undefined,
  );
  const historySummary = historyResolution
    ? {
        attemptedKinds: historyResolution.attemptedKinds,
        selectedKind: historyResolution.selectedKind,
        recordCount: historyEntries.length,
        complete: historyResolution.complete,
        sourceIds: [...new Set(historyEntries.map((entry) => entry.sourceId))],
      }
    : undefined;
  const completeHistorySourceIds =
    requestedEntity && historyResolution?.complete
      ? [...new Set(historyResolution.completeSourceIds)].filter((sourceId) => {
          const entries = historyEntries.filter((entry) => entry.sourceId === sourceId);
          return (
            entries.length >= 2 &&
            distinctHistoryVersions(entries).length >= 2 &&
            entries.every((entry) => entry.completeHistory && entry.stability !== "unknown")
          );
        })
      : [];
  const completeHistoryEntries = historyEntries.filter((entry) =>
    completeHistorySourceIds.includes(entry.sourceId),
  );
  const stabilityEvidenceByVersion = new Map<
    string,
    {
      entity: string;
      version: string;
      stabilities: Set<"stable" | "prerelease">;
      sourceIds: Set<string>;
    }
  >();
  const recordStability = (
    entity: string,
    version: string,
    stability: "stable" | "prerelease" | "unknown",
    sourceIds: string[],
    conflicts: Array<"stable" | "prerelease"> = [],
  ) => {
    const key = `${entity.toLowerCase()}|${version.toLowerCase()}`;
    const group = stabilityEvidenceByVersion.get(key) ?? {
      entity,
      version,
      stabilities: new Set<"stable" | "prerelease">(),
      sourceIds: new Set<string>(),
    };
    if (stability !== "unknown") group.stabilities.add(stability);
    for (const conflict of conflicts) group.stabilities.add(conflict);
    for (const sourceId of sourceIds) group.sourceIds.add(sourceId);
    stabilityEvidenceByVersion.set(key, group);
  };
  for (const record of trustedReleaseRecords) {
    recordStability(
      record.entity,
      record.version,
      record.stability,
      record.sourceIds ?? [record.sourceId],
      record.stabilityConflicts,
    );
  }
  for (const entry of completeHistoryEntries) {
    recordStability(requestedEntity ?? "", entry.version, entry.stability, [entry.sourceId]);
  }
  const stabilityConflicts = [...stabilityEvidenceByVersion.values()]
    .filter((group) => group.stabilities.size > 1)
    .map((group) => ({
      entity: group.entity,
      version: group.version,
      stabilities: [...group.stabilities],
      sourceIds: [...group.sourceIds],
    }));
  const base = {
    required: true,
    conclusion: "UNRESOLVED" as const,
    requestedEntity,
    candidateVersions: [] as VersionEvidenceCandidate[],
    releaseRecords,
    comparisons: [] as VersionEvidenceComparison[],
    stabilityConflicts,
    supportingSourceIds: [] as string[],
    completeHistorySourceIds: [] as string[],
    releaseHistoryResolution: historySummary,
    unresolvedReasons: [] as string[],
  };

  const withUnresolvedState = (
    assessment: LatestnessAssessment,
    reason: LatestnessUnresolvedReason,
  ): LatestnessAssessment => ({
    ...assessment,
    unresolvedState: {
      status: "unresolved",
      reason,
      candidates: assessment.candidateVersions.map((candidate) => ({
        entity: candidate.entity,
        version: candidate.version,
        releaseChannel: candidate.releaseChannel,
        stability: candidate.stability,
        withdrawn: Boolean(candidate.withdrawn),
        sourceIds: [...candidate.sourceIds],
      })),
      unresolvedReasons: [...assessment.unresolvedReasons],
      recommendedNextAction: "retrieve_additional_official_evidence",
    },
  });

  if (!requestedEntity) {
    return withUnresolvedState(
      {
        ...base,
        unresolvedReasons: ["latestness comparison requires one unambiguous requested entity"],
      },
      "ambiguous_entity",
    );
  }

  const claimCandidateEvidence: VersionEvidenceCandidate[] = trustedReleaseRecords.map(
    (record) => ({
      entity: record.entity,
      version: record.version,
      releaseChannel: record.releaseChannel,
      stability: record.stability,
      withdrawn: Boolean(record.withdrawn),
      sourceIds: record.sourceIds ?? [record.sourceId],
      claimIds: record.claimIds,
      latestnessSourceIds:
        record.latestnessSourceIds ?? (record.latestnessEvidence ? [record.sourceId] : []),
      releaseDates:
        record.releaseDate &&
        record.releaseDateClaimIds?.length &&
        !record.releaseDateConflicts?.length
          ? [record.releaseDate]
          : [],
      explicitlyLatest: Boolean(record.latestnessEvidence),
    }),
  );
  const historyCandidateEvidence = completeHistoryEntries.map((entry) =>
    candidateFromHistoryEntry(requestedEntity, entry),
  );
  const candidates = mergeCandidates([...claimCandidateEvidence, ...historyCandidateEvidence]);
  const eligibleCandidates = candidates.filter(
    (candidate) =>
      !candidate.withdrawn &&
      (input.stableRequired
        ? candidate.stability === "stable"
        : candidate.stability !== "prerelease"),
  );
  const comparisons = compareCandidates(eligibleCandidates);
  const comparisonCoverageBySource = new Map(
    completeHistorySourceIds.map((sourceId) => [
      sourceId,
      hasCompleteHistoryComparisonCoverage(requestedEntity, sourceId, historyEntries),
    ]),
  );
  const conflictedVersionKeys = new Set(
    stabilityConflicts.map(
      (conflict) => `${conflict.entity.toLowerCase()}|${conflict.version.toLowerCase()}`,
    ),
  );
  const conflictFilteredCandidates = eligibleCandidates.filter(
    (candidate) =>
      !conflictedVersionKeys.has(
        `${candidate.entity.toLowerCase()}|${candidate.version.toLowerCase()}`,
      ),
  );

  if (conflictFilteredCandidates.length === 0) {
    const result: LatestnessAssessment = {
      ...base,
      candidateVersions: candidates,
      comparisons,
      completeHistorySourceIds: [...completeHistorySourceIds],
      unresolvedReasons: [
        stabilityConflicts.length > 0
          ? "official evidence conflicts about whether the same version is stable or prerelease"
          : input.stableRequired
            ? "no requested-entity version has explicit stable-release evidence from an eligible source"
            : "no comparable requested-entity version evidence was found",
      ],
    };
    const reason: LatestnessUnresolvedReason =
      stabilityConflicts.length > 0
        ? "conflicting_release_stability"
        : candidates.length === 0
          ? "no_verified_release_candidates"
          : input.stableRequired
            ? "release_stability_unresolved"
            : "insufficient_version_comparison";
    return withUnresolvedState(result, reason);
  }

  const ordered = [...conflictFilteredCandidates].sort(
    (left, right) => compareVersions(left.version, right.version) ?? 0,
  );
  const highest = ordered.at(-1)!;
  const contradictoryLatestClaim = conflictFilteredCandidates.some(
    (candidate) =>
      candidate.explicitlyLatest && compareVersions(candidate.version, highest.version) === -1,
  );
  const explicitLatestSourceIds = highest.latestnessSourceIds;
  const completeHistorySourceIdsForHighest = completeHistorySourceIds.filter((sourceId) =>
    comparisonCoverageBySource
      .get(sourceId)
      ?.stableEntries.some((entry) => compareVersions(entry.version, highest.version) === 0),
  );
  const candidateHistoryEntries = historyEntries.filter(
    (entry) =>
      completeHistorySourceIdsForHighest.includes(entry.sourceId) &&
      entry.stability === "stable" &&
      entry.releaseChannel === "stable" &&
      !entry.withdrawn &&
      compareVersions(entry.version, highest.version) === 0,
  );
  const candidateClaimRecords = trustedReleaseRecords.filter(
    (record) =>
      record.stability === "stable" &&
      !record.withdrawn &&
      compareVersions(record.version, highest.version) === 0,
  );
  const candidateReleaseDates = [
    ...candidateHistoryEntries.map((entry) => entry.releaseDate),
    ...candidateClaimRecords
      .filter(
        (record) =>
          record.releaseDate &&
          record.releaseDateClaimIds?.length &&
          !record.releaseDateConflicts?.length &&
          record.releaseDateReason !== "publication-date-only" &&
          (record.releaseDateSourceIds ?? record.sourceIds ?? [record.sourceId]).every(
            hasOfficialSourceIdentity,
          ),
      )
      .map((record) => record.releaseDate),
  ].filter((date): date is string => Boolean(date));
  const distinctCandidateReleaseDates = [...new Set(candidateReleaseDates)];
  const candidateHasRequiredEvidence =
    candidateHistoryEntries.length > 0 &&
    (!input.releaseDateRequired || distinctCandidateReleaseDates.length === 1);
  const hasCompleteHistoryProof = completeHistorySourceIdsForHighest.some((sourceId) => {
    const coverage = comparisonCoverageBySource.get(sourceId);
    const stableEntries = coverage?.stableEntries ?? [];
    const stableVersions = new Set(stableEntries.map((entry) => entry.version));
    const candidateIsGreatest = stableEntries.every((entry) => {
      const order = compareVersions(highest.version, entry.version);
      return order === 0 || order === 1;
    });
    return (
      coverage?.complete === true &&
      stableVersions.size >= 2 &&
      candidateIsGreatest &&
      candidateHasRequiredEvidence &&
      stabilityConflicts.length === 0
    );
  });

  // LATESTNESS_PROMOTION_INVARIANT: promotion requires a dated, stable
  // requested-entity candidate inside complete official history, complete
  // pairwise coverage of that history, and no unresolved conflict.
  if (!contradictoryLatestClaim && hasCompleteHistoryProof) {
    const proofCoverage = completeHistorySourceIdsForHighest
      .map((sourceId) => ({ sourceId, coverage: comparisonCoverageBySource.get(sourceId)! }))
      .find(
        ({ sourceId, coverage }) =>
          coverage.complete &&
          coverage.stableEntries.some(
            (entry) => compareVersions(entry.version, highest.version) === 0,
          ),
      )!;
    const comparisonCount = proofCoverage.coverage.comparisons.length;
    return {
      required: true,
      conclusion: "PROVEN",
      proof: "complete-official-history",
      requestedEntity,
      highestCandidateVersion: highest.version,
      latestVersion: highest.version,
      proofEvidence: `${highest.version} is newer than every other eligible stable ${requestedEntity} release in the complete official history; ${proofCoverage.coverage.stableEntries.length} stable releases were covered by ${comparisonCount} pairwise version comparisons.`,
      candidateVersions: candidates,
      releaseRecords,
      comparisons,
      supportingSourceIds: [...new Set(completeHistorySourceIdsForHighest)],
      completeHistorySourceIds: [...completeHistorySourceIds],
      releaseHistoryResolution: historySummary,
      unresolvedReasons: [],
    };
  }

  const result: LatestnessAssessment = {
    ...base,
    conclusion: comparisons.length > 0 ? "CANDIDATE_ONLY" : "UNRESOLVED",
    highestCandidateVersion: highest.version,
    candidateVersions: candidates,
    comparisons,
    completeHistorySourceIds: [...completeHistorySourceIds],
    unresolvedReasons: [
      contradictoryLatestClaim
        ? "an eligible source calls an older version latest while newer eligible evidence exists"
        : hasCompleteHistoryProof
          ? "latestness claims conflict with the ordered eligible candidates"
          : completeHistorySourceIdsForHighest.some(
                (sourceId) => !comparisonCoverageBySource.get(sourceId)?.complete,
              )
            ? "complete official history did not produce complete pairwise comparison coverage"
            : candidateHistoryEntries.length > 0 &&
                input.releaseDateRequired &&
                distinctCandidateReleaseDates.length !== 1
              ? "the latest stable candidate lacks one unambiguous official release date"
              : stabilityConflicts.length > 0
                ? "official evidence conflicts about the stability of a release"
                : explicitLatestSourceIds.length > 0
                  ? "an explicit latestness statement is only a candidate without complete official release history and verified version comparisons"
                  : "the highest eligible version found is only a candidate; no evidence establishes that the history is complete or that no newer stable release exists",
    ],
  };
  return withUnresolvedState(
    result,
    contradictoryLatestClaim
      ? "conflicting_official_sources"
      : stabilityConflicts.length > 0
        ? "conflicting_release_stability"
        : historyResolution?.complete &&
            completeHistorySourceIdsForHighest.some(
              (sourceId) => !comparisonCoverageBySource.get(sourceId)?.complete,
            )
          ? "insufficient_version_comparison"
          : "incomplete_official_history",
  );
}
