import type { ReleaseHistorySourceKind, Source } from "./domain.js";
import { subjectEntityMismatchReason } from "./entities.js";
import { classifyFirstPartyGitHubSource, isOfficialSourceForEntities } from "./rank.js";

export interface OfficialReleaseHistoryEntry {
  version: string;
  releaseDate?: string;
  stability: "stable" | "prerelease" | "unknown";
  withdrawn: boolean;
  withdrawalEvidence?: string;
  releaseChannel?: string;
  explicitlyLatest: boolean;
  passage: string;
  evidence: string;
  sourceId: string;
  sourceKind: ReleaseHistorySourceKind;
  completeHistory: boolean;
}

export interface ReleaseHistoryResolution {
  records: OfficialReleaseHistoryEntry[];
  attemptedKinds: ReleaseHistorySourceKind[];
  selectedKind?: ReleaseHistorySourceKind;
  complete: boolean;
  sourceIds: string[];
  completeSourceIds: string[];
}

const kindOrder: ReleaseHistorySourceKind[] = [
  "official_history_page",
  "github_releases_html",
  "github_releases_feed",
  "first_party_structured",
];

const versionPattern = /\bv?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/gi;
const prereleasePattern =
  /\b(?:canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i;
const latestPattern = /\b(?:latest|newest|current|most recent)\b/i;
const releaseContextPattern =
  /\b(?:release announcement|release notes?|changelog|released|release date|now available|available on npm|published to npm)\b/i;
const stableReleasePattern =
  /\b(?:stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:releases?|versions?|channels?)|(?:release|version|channel)\s+(?:is|was|became|remains)\s+(?:the\s+)?(?:latest\s+)?stable|(?:is|was|became|remains)\s+(?:now\s+)?(?:a\s+|the\s+)?stable(?:\s+(?:release|version|channel))?|(?:latest|newest|current)\s+stable(?:\s+[a-z][\w.-]*){0,2}\s+(?:releases?|versions?|channels?)|stable\s*\/\s*latest|latest\s*\/\s*stable|(?:belongs to|is in|uses)\s+(?:the\s+)?stable\s+(?:release\s+)?channel)\b/i;
const featureStabilityPattern =
  /\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?|both of these|these)\b[^.!?\n]{0,120}\bstable\b|\bstable\b[^.!?\n]{0,120}\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?)\b/i;
const featureReleaseStatusPattern =
  /\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?)\b[^.!?\n]{0,120}\b(?:general availability|generally available|production release|production channel|ga release|ga channel)\b|\b(?:general availability|generally available|production release|production channel|ga release|ga channel)\b[^.!?\n]{0,120}\b(?:features?|apis?|capabilities|experiments?|flags?|components?|hooks?|transitions?|refs?)\b/i;
const completeHistoryPattern =
  /\b(?:complete|full|all)\s+(?:official\s+)?(?:stable\s+)?(?:release|version)\s+history\b|\bcomplete list of (?:stable )?(?:releases|versions)\b/i;
const completeStableHistoryPattern =
  /\b(?:complete|full|all)\s+(?:official\s+)?stable\s+(?:release|version)\s+history\b|\ball\s+stable\s+(?:releases|versions)\b|\bcomplete list of stable (?:releases|versions)\b/i;
const withdrawalPattern =
  /\b(?:yanked|withdrawn|retracted|removed from (?:the )?(?:release|version)(?: history| list)?|no longer available)\b/i;
const draftReleasePattern =
  /\b(?:draft release|release draft|unpublished draft)\b|["']?(?:is_?draft|draft)["']?\s*:\s*true\b/i;
const versionDatePattern =
  /\b20\d{2}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}\b/i;

function normalizedText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:tr|li|p|h[1-6]|article|entry|item)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function versionTokens(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(new RegExp(versionPattern.source, "gi"))]
        .map((match) => (match[1] ?? match[0]).replace(/^v/i, "").split("+")[0])
        .filter((version) => /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/.test(version)),
    ),
  ];
}

function dateFrom(text: string): string | undefined {
  const match = text.match(versionDatePattern);
  if (!match) return undefined;
  const value = match[0];
  const iso = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const months: Record<string, number> = {
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
      /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})$/i,
    );
    const dayFirst = value.match(
      /^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})$/i,
    );
    const parsed = monthFirst ?? dayFirst;
    if (!parsed) return undefined;
    const monthName = (monthFirst ? parsed[1] : parsed[2])?.toLowerCase() ?? "";
    month = months[monthName];
    day = Number(monthFirst ? parsed[2] : parsed[1]);
    year = Number(parsed[3]);
  }
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

function sourceKind(
  source: Source,
  question: string,
  entity: string,
): ReleaseHistorySourceKind | undefined {
  if (
    !source.content?.trim() ||
    source.subjectMismatchReason ||
    subjectEntityMismatchReason(question, `${source.title}\n${source.url}`) ||
    !isOfficialSourceForEntities(source, [entity])
  ) {
    return undefined;
  }

  const firstParty = source.firstPartyClassification ?? classifyFirstPartyGitHubSource(source.url);
  if (firstParty && firstParty.entity !== entity) return undefined;

  if (source.releaseHistorySourceKind) {
    if (firstParty || isOfficialSourceForEntities(source, [entity])) {
      return source.releaseHistorySourceKind;
    }
  }

  if (firstParty?.contentKind === "release_history") {
    let path = "";
    try {
      path = new URL(source.url).pathname.toLowerCase();
    } catch {
      return undefined;
    }
    if (source.retrievalMethod === "rss" || path.endsWith(".atom")) {
      return "github_releases_feed";
    }
    return "github_releases_html";
  }

  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return undefined;
  }
  if (url.hostname === "github.com") return undefined;
  const historyIdentity = /\b(?:releases|versions|changelog|history)\b/i.test(
    `${source.title}\n${url.pathname}`,
  );
  if (!historyIdentity) return undefined;
  return "official_history_page";
}

function sectionStatus(statement: string): OfficialReleaseHistoryEntry["stability"] | undefined {
  const heading = statement.replace(/^\s*(?:#{1,6}\s*)?\|?\s*/, "").trim();
  if (/^(?:pre[- ]?releases?|canary|nightly|preview|beta|alpha)\b/i.test(heading)) {
    return "prerelease";
  }
  if (/^(?:stable|production)\s+(?:releases?|versions?|channel)\b/i.test(heading)) {
    return "stable";
  }
  return undefined;
}

function parseStatus(
  version: string,
  statement: string,
  inherited?: OfficialReleaseHistoryEntry["stability"],
  completeStableHistory = false,
): OfficialReleaseHistoryEntry["stability"] {
  const prereleaseVersion = version.match(/-(canary|nightly|alpha|beta|preview|rc)(?:[.-]|$)/i);
  const explicitPrereleaseStatus =
    /\b(?:status|channel|categories):\s*(?:pre[- ]?release|canary|nightly|preview|beta|alpha|rc)\b/i.test(
      statement,
    ) ||
    /(?:\|\s*|[—–:]\s*)(?:pre[- ]?release|canary|nightly|preview|beta|alpha|rc)(?:\s*\||\s*$)/i.test(
      statement,
    ) ||
    /\b(?:release|version|channel)\s+(?:is|was|became|remains)\s+(?:a\s+)?(?:pre[- ]?release|canary|nightly|preview|beta|alpha|rc)\b/i.test(
      statement,
    );
  if (prereleaseVersion || explicitPrereleaseStatus) return "prerelease";
  if (/\b(?:status|channel|categories):\s*(?:stable|production)\b/i.test(statement)) {
    return "stable";
  }
  if (featureStabilityPattern.test(statement) || featureReleaseStatusPattern.test(statement)) {
    return "unknown";
  }
  if (stableReleasePattern.test(statement) && !featureStabilityPattern.test(statement)) {
    return "stable";
  }
  if (
    /(?:\|\s*|[—–:]\s*)(?:stable|production)(?:\s*\||\s*$)/i.test(statement) &&
    !featureStabilityPattern.test(statement)
  ) {
    return "stable";
  }
  if (completeStableHistory) return "stable";
  return inherited ?? "unknown";
}

export function parseOfficialReleaseHistorySource(
  source: Source,
  question: string,
  entity: string,
): OfficialReleaseHistoryEntry[] {
  const kind = sourceKind(source, question, entity);
  if (!kind) return [];

  const content = normalizedText(source.content ?? "");
  const allText = `${source.title}\n${content}`;
  const completeStableHistory = completeStableHistoryPattern.test(allText);
  const completeHistory =
    Boolean(source.releaseHistoryComplete) || completeHistoryPattern.test(allText);
  const lines = content.split(/\r?\n/).slice(0, 2_000);
  let sectionStability: OfficialReleaseHistoryEntry["stability"] | undefined;
  let releaseDateColumn = false;
  const entries: OfficialReleaseHistoryEntry[] = [];

  for (const line of lines) {
    const sectionHeading = line.trim();
    if (/\b(?:stable|production)\s+(?:releases?|versions?)\s*:/i.test(sectionHeading)) {
      sectionStability = "stable";
    } else if (
      /\b(?:pre[- ]?release|canary|nightly|preview|beta|alpha)\s+(?:releases?|versions?)\s*:/i.test(
        sectionHeading,
      )
    ) {
      sectionStability = "prerelease";
    }
    if (
      /\bversion\b/i.test(line) &&
      /\b(?:release\s+date|date\s+released)\b/i.test(line) &&
      /[|\t]/.test(line)
    ) {
      releaseDateColumn = true;
      continue;
    }

    const statements = line
      .split(/;\s*/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      if (draftReleasePattern.test(statement)) continue;

      const declaredStability = sectionStatus(statement);
      if (declaredStability) {
        sectionStability = declaredStability;
        continue;
      }

      const versions = versionTokens(statement);
      if (versions.length !== 1 || subjectEntityMismatchReason(question, statement)) continue;
      const version = versions[0]!;
      const beginsWithVersion =
        /^\s*(?:\|\s*)?(?:[\w@.-]+\s+)?v?\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?=$|[\s|(:—–-])/i.test(
          statement,
        );
      const releaseContext =
        releaseContextPattern.test(statement) || stableReleasePattern.test(statement);
      if (!beginsWithVersion && !releaseContext) continue;

      const status = parseStatus(version, statement, sectionStability, completeStableHistory);
      const latestness = latestPattern.test(statement) && stableReleasePattern.test(statement);
      const releaseDate =
        releaseDateColumn ||
        (kind === "github_releases_feed" && /\bpublished\s*:/i.test(statement)) ||
        /\b(?:release\s+date|date\s+released|released|release announcement.{0,40}(?:dated|on)|available on npm|published to npm)\b/i.test(
          statement,
        )
          ? dateFrom(statement)
          : undefined;
      const explicitStableDeclaration = completeStableHistory
        ? allText.match(
            /[^.!?\n]*\b(?:complete|full|all)\b[^.!?\n]*\bstable\b[^.!?\n]*\b(?:release|version)\s+history\b[^.!?\n]*/i,
          )?.[0]
        : undefined;
      const evidence = [explicitStableDeclaration, statement].filter(Boolean).join("\n");
      const withdrawalEvidence = withdrawalPattern.test(statement) ? statement : undefined;
      const prereleaseChannel = version.match(
        /-(canary|nightly|alpha|beta|preview|rc)(?:[.-]|$)/i,
      )?.[1];
      entries.push({
        version,
        releaseDate,
        stability: status,
        withdrawn: Boolean(withdrawalEvidence),
        withdrawalEvidence,
        releaseChannel:
          status === "stable"
            ? "stable"
            : (prereleaseChannel?.toLowerCase() ??
              (status === "prerelease"
                ? (statement
                    .match(/\b(canary|nightly|alpha|beta|preview|rc)\b/i)?.[1]
                    ?.toLowerCase() ?? "prerelease")
                : undefined)),
        explicitlyLatest: latestness,
        passage: statement,
        evidence,
        sourceId: source.id,
        sourceKind: kind,
        completeHistory: completeHistory && status !== "unknown",
      });
    }
  }

  return entries.slice(0, 100);
}

function uniqueVersions(records: OfficialReleaseHistoryEntry[]): Set<string> {
  return new Set(
    records.map((record) => `${record.version}|${record.releaseChannel ?? "unknown"}`),
  );
}

/**
 * Resolves official history from already retrieved, provenance-checked sources.
 * More authoritative history representations are preferred; an incomplete
 * representation is retained only as candidate evidence while the resolver
 * checks the next bounded representation.
 */
export function resolveOfficialReleaseHistory(input: {
  sources: Source[];
  question: string;
  entity: string;
}): ReleaseHistoryResolution {
  let best: OfficialReleaseHistoryEntry[] = [];
  let selectedKind: ReleaseHistorySourceKind | undefined;
  const attemptedKinds: ReleaseHistorySourceKind[] = [];

  for (const kind of kindOrder) {
    const sources = input.sources.filter(
      (source) => sourceKind(source, input.question, input.entity) === kind,
    );
    if (sources.length === 0) continue;
    attemptedKinds.push(kind);

    const rows = sources.flatMap((source) =>
      parseOfficialReleaseHistorySource(source, input.question, input.entity),
    );
    const completeForKind = sources
      .map((source) => ({
        source,
        rows: rows.filter((row) => row.sourceId === source.id),
      }))
      .filter(({ rows: sourceRows }) => {
        return (
          sourceRows.length >= 2 &&
          uniqueVersions(sourceRows).size >= 2 &&
          sourceRows.every((row) => row.completeHistory && row.stability !== "unknown")
        );
      });

    if (completeForKind.length > 0) {
      const completeIds = completeForKind.map(({ source }) => source.id);
      const completeRows = rows.filter((row) => completeIds.includes(row.sourceId));
      return {
        records: completeRows,
        attemptedKinds,
        selectedKind: kind,
        complete: true,
        sourceIds: completeIds,
        completeSourceIds: completeIds,
      };
    }

    const rowCount = uniqueVersions(rows).size;
    const bestCount = uniqueVersions(best).size;
    if (rowCount > bestCount) {
      best = rows;
      selectedKind = kind;
    }
  }

  return {
    records: best,
    attemptedKinds,
    selectedKind,
    complete: false,
    sourceIds: [...new Set(best.map((record) => record.sourceId))],
    completeSourceIds: [],
  };
}

/** A conservative cue gate for fact-targeted semantic release-status checks. */
export function hasSemanticReleaseStatusCue(passage: string): boolean {
  return (
    /\b(?:general availability|generally available|production release|production channel|ga release|ga channel)\b/i.test(
      passage,
    ) &&
    !featureStabilityPattern.test(passage) &&
    !featureReleaseStatusPattern.test(passage)
  );
}

export function isWithdrawnReleasePassage(passage: string): boolean {
  return withdrawalPattern.test(passage);
}

export function isFeatureStabilityPassage(passage: string): boolean {
  return featureStabilityPattern.test(passage) || featureReleaseStatusPattern.test(passage);
}
