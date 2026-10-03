import * as cheerio from "cheerio";
import type { ReleaseHistorySourceKind, SearchResult, Source } from "./domain.js";
import { browserFetch } from "./browser.js";
import { extractHtml, extractRetrievedDocument, validateExtraction } from "./extract.js";
import { config } from "./config.js";
import {
  readBoundedBytes,
  readBoundedPrefixText,
  readBoundedText,
  safeFetchWithRetry,
} from "./security.js";
import { extractPdf } from "./pdf.js";
import type { ExtractedDocument } from "./extract.js";
import type { RequestedFactKind } from "./requested-facts.js";
import {
  containsExactEntity,
  extractKnownEntities,
  subjectEntityMismatchReason,
} from "./entities.js";
import { requestedFactCoverage } from "./requested-facts.js";
import { querySubjectMismatchReason } from "./query-relevance.js";
import {
  comparisonObjective,
  comparisonEvidencePassages,
  comparisonClaimHasTargetFinding,
} from "./comparison-evidence.js";
import { classifyFirstPartyGitHubSource } from "./rank.js";
import { parseOfficialReleaseHistorySource } from "./release-history.js";
import {
  getResearchExecutionContext,
  runResearchStage,
  throwIfResearchInactive,
} from "./execution-context.js";

export type RetrievalMethod = "serper_snippet" | "rss" | "structured" | "http" | "browser" | "pdf";

export interface RetrievedSource {
  url: string;
  html: string;
  contentType: string;
  document: ExtractedDocument;
  retrievalMethod: RetrievalMethod;
  retrievalAttempts: string[];
  extractionConfidence: number;
  extractionStatus: "SUCCEEDED";
  retrievedContentLength: number;
  retrievalMethodsSkipped: string[];
  retrievalReasons: string[];
  retrievalSourceUrl?: string;
  releaseHistorySourceKind?: ReleaseHistorySourceKind;
  releaseHistoryComplete?: boolean;
}

interface FetchResult {
  url: string;
  response: Response;
  dispose: () => Promise<void>;
}

export interface SourceRetrievalDependencies {
  fetch: (url: string, init?: RequestInit) => Promise<FetchResult>;
  browser: (url: string, signal?: AbortSignal) => Promise<{ url: string; html: string }>;
}

export class SourceRetrievalError extends Error {
  constructor(
    message: string,
    readonly attempts: string[],
    readonly skipped: string[] = [],
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = "SourceRetrievalError";
  }
}

function stopIfResearchDeadlineExpired(): void {
  const context = getResearchExecutionContext();
  if (context?.signal.aborted || (context && Date.now() >= context.deadlineAt)) {
    throwIfResearchInactive();
  }
}

const defaultDependencies: SourceRetrievalDependencies = {
  fetch: (url, init = {}) => {
    const headers = new Headers({
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/atom+xml,application/rss+xml,application/xml,application/json,text/plain;q=0.8",
    });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return safeFetchWithRetry(url, { ...init, headers }, 3, config.FETCH_TIMEOUT_MS);
  },
  browser: browserFetch,
};

function meaningfulTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(
    (term) =>
      !new Set(["what", "when", "where", "which", "does", "than", "best", "latest"]).has(term),
  );
}

export interface SnippetSufficiencyAssessment {
  sufficient: boolean;
  reason: string;
}

const snippetContextTerms = new Set([
  "about",
  "and",
  "cite",
  "comparison",
  "compatible",
  "compatibility",
  "current",
  "date",
  "evidence",
  "exact",
  "for",
  "from",
  "how",
  "latest",
  "many",
  "number",
  "official",
  "published",
  "release",
  "released",
  "research",
  "source",
  "sources",
  "spec",
  "specification",
  "stable",
  "support",
  "supporting",
  "technical",
  "the",
  "then",
  "using",
  "verify",
  "version",
  "what",
  "when",
  "which",
]);

/** Evaluate whether the snippet itself supports the kind of fact the question requests. */
export function assessSerperSnippet(
  result: Pick<SearchResult, "title" | "snippet">,
  question: string,
  requestedFacts?: RequestedFactKind[],
  options: { fullDocument?: boolean } = {},
): SnippetSufficiencyAssessment {
  const snippet = result.snippet.trim();
  if (snippet.length < 40) {
    return { sufficient: false, reason: "The Serper snippet is too short to support a claim." };
  }
  const entityMismatch = subjectEntityMismatchReason(question, `${result.title} ${snippet}`);
  if (entityMismatch) return { sufficient: false, reason: entityMismatch };
  const subjectMismatch = querySubjectMismatchReason(question, snippet);
  if (subjectMismatch) return { sufficient: false, reason: subjectMismatch };
  if (
    !options.fullDocument &&
    /\b(compare|comparison|versus|\bvs\b|deep research|comprehensive|in depth)\b/i.test(question)
  ) {
    return {
      sufficient: false,
      reason:
        "A single search snippet cannot establish the requested comparison or research depth.",
    };
  }

  const terms = meaningfulTerms(question);
  const snippetText = snippet.toLowerCase();
  const subjectTerms = terms.filter((term) => !snippetContextTerms.has(term));
  const subjectMatched = subjectTerms.some((term) => snippetText.includes(term));
  if (subjectTerms.length > 0 && !subjectMatched) {
    return {
      sufficient: false,
      reason: "The snippet does not mention the requested subject in its own text.",
    };
  }

  const factCoverage = requestedFactCoverage(question, snippet, { requestedFacts });
  const asksForVersion = factCoverage.required.includes("version");
  const asksForReleaseDate = factCoverage.required.includes("release date");
  const asksForPrice = factCoverage.required.includes("price");
  const asksForMeasuredTechnicalFact =
    /\b(?:exact|specification|spec|maximum|minimum|limit|capacity|latency|throughput|memory usage|payload|resolution|frequency|compatib(?:le|ility)|supported version)\b/i.test(
      question,
    );
  const asksForEndOfLifeDate = factCoverage.required.includes("end-of-life date");
  const containsVersion = factCoverage.present.includes("version");
  const containsDate = factCoverage.present.includes("release date");
  const containsMeasuredValue = factCoverage.present.some((fact) =>
    ["version", "release date", "technical value"].includes(fact),
  );

  if (
    asksForVersion &&
    (!containsVersion || !/\b(?:latest|current|stable|release|version)\b/i.test(snippet))
  ) {
    return {
      sufficient: false,
      reason: "The snippet does not state a concrete version and its release/current status.",
    };
  }
  if (asksForReleaseDate && !containsDate) {
    return { sufficient: false, reason: "The snippet does not state a specific release date." };
  }
  if (asksForPrice && !factCoverage.present.includes("price")) {
    return {
      sufficient: false,
      reason: "The snippet does not state a concrete price or free-cost claim.",
    };
  }
  if (asksForMeasuredTechnicalFact && !containsMeasuredValue) {
    return {
      sufficient: false,
      reason: "The snippet gives no concrete value for the requested technical fact.",
    };
  }
  if (asksForEndOfLifeDate && !factCoverage.present.includes("end-of-life date")) {
    return {
      sufficient: false,
      reason: "The snippet does not tie an end-of-life date to the requested entity/version.",
    };
  }

  const matched = terms.filter((term) => snippetText.includes(term)).length;
  const asksForCurrentValue =
    /\b(latest|current|version|price|cost|release|date|when|how many|number)\b/i.test(question);
  const containsConcreteValue = containsMeasuredValue || /\b(?:19|20)\d{2}\b/.test(snippet);
  const threshold = asksForCurrentValue && containsConcreteValue ? 1 : 2;
  const onTopic = matched >= Math.min(threshold, Math.max(1, subjectTerms.length));
  const directlyAsserted = /[.!?]/.test(snippet) || containsConcreteValue;
  if (!onTopic || !directlyAsserted) {
    return {
      sufficient: false,
      reason: "The snippet is generic or does not directly assert the requested fact.",
    };
  }

  return {
    sufficient: true,
    reason: asksForVersion
      ? "The snippet itself states a concrete version and its release/current status."
      : "The snippet directly states a sufficiently on-topic factual answer.",
  };
}

/** Compatibility helper for callers that need only the sufficiency decision. */
export function isSerperSnippetSufficient(
  result: Pick<SearchResult, "title" | "snippet">,
  question: string,
  requestedFacts?: RequestedFactKind[],
): boolean {
  return assessSerperSnippet(result, question, requestedFacts).sufficient;
}

function qualityConfidence(document: ExtractedDocument): number {
  const content = document.content.trim();
  if (content.length < 40) return 0;
  const sentenceCount = (content.match(/[.!?](?:\s|$)/g) ?? []).length;
  const metadataBoost =
    Number(Boolean(document.title)) * 0.05 + Number(Boolean(document.publishedAt)) * 0.05;
  const lengthScore = Math.min(0.65, content.length / 1600);
  const sentenceScore = Math.min(0.25, sentenceCount * 0.05);
  return Math.min(1, Number((lengthScore + sentenceScore + metadataBoost).toFixed(2)));
}

function missingRequestedFactsForDocument(
  question: string,
  document: ExtractedDocument,
  requestedFacts?: RequestedFactKind[],
  researchChatOptimization = false,
): string[] {
  if (!researchChatOptimization) return [];
  const missing = requestedFacts?.length
    ? requestedFactCoverage(question, document.content, { requestedFacts }).missing
    : [];
  const comparison = comparisonObjective(question);
  if (
    comparison &&
    !comparisonEvidencePassages(comparison, document.content).some(
      (passage) =>
        !querySubjectMismatchReason(question, passage) &&
        comparisonClaimHasTargetFinding(comparison, passage),
    )
  )
    return [...missing, "a source-linked comparison finding"];
  return missing;
}

function appendLifecycleTableEvidence(
  document: ExtractedDocument,
  raw: string,
  question: string,
  requestedFacts?: RequestedFactKind[],
  researchChatOptimization = false,
  retrievalReasons?: string[],
): ExtractedDocument {
  if (!researchChatOptimization || !requestedFacts?.includes("end-of-life date")) return document;

  const diagnostic: {
    requestedFact: "end-of-life date";
    entity?: string;
    targetVersion?: string;
    sourceEntityMatched: boolean;
    tablesFound: number;
    headerRowsFound: number;
    lifecycleHeaderTablesFound: number;
    rawCandidateCount: number;
    candidates: Array<{
      version: string;
      date: string;
      requestedVersionMatch: boolean;
      outcome: "accepted" | "rejected";
      rejectionReason?: "unparseable_version" | "wrong_version" | "missing_or_invalid_date";
    }>;
    omittedCandidateCount: number;
    normalizedCandidateCount: number;
    rejectionReason?: string;
  } = {
    requestedFact: "end-of-life date",
    sourceEntityMatched: false,
    tablesFound: 0,
    headerRowsFound: 0,
    lifecycleHeaderTablesFound: 0,
    rawCandidateCount: 0,
    candidates: [],
    omittedCandidateCount: 0,
    normalizedCandidateCount: 0,
  };
  const recordDiagnostic = () => {
    retrievalReasons?.push("Lifecycle table extraction diagnostic: " + JSON.stringify(diagnostic));
  };
  const entity = extractKnownEntities(question)[0];
  if (!entity) {
    diagnostic.rejectionReason = "requested_entity_not_detected";
    recordDiagnostic();
    return document;
  }
  diagnostic.entity = entity;
  if (!containsExactEntity(document.title + " " + document.description, entity)) {
    diagnostic.rejectionReason = "source_title_and_description_do_not_match_requested_entity";
    recordDiagnostic();
    return document;
  }
  const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const targetVersion = question.match(
    new RegExp(`\\b${escapedEntity}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "i"),
  )?.[1];
  diagnostic.sourceEntityMatched = true;
  if (!targetVersion) {
    diagnostic.rejectionReason = "requested_version_not_detected";
    recordDiagnostic();
    return document;
  }
  diagnostic.targetVersion = targetVersion;

  const $ = cheerio.load(raw);
  const rows: string[] = [];
  let matchingVersionRows = 0;
  let invalidDateRows = 0;
  diagnostic.tablesFound = $("table").length;
  $("table").each((_tableIndex, table) => {
    let headers: string[] = [];
    let lifecycleHeadersCounted = false;
    $(table)
      .find("tr")
      .each((_rowIndex, row) => {
        const cells = $(row)
          .children("th,td")
          .toArray()
          .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
        if (cells.length === 0) return;

        const isHeader = $(row).children("th").length > 0 && $(row).children("td").length === 0;
        if (isHeader) {
          diagnostic.headerRowsFound += 1;
          headers = cells;
          return;
        }
        if (headers.length === 0) return;

        const versionIndex = headers.findIndex((header) => /\b(?:version|release)\b/i.test(header));
        const lifecycleIndex = headers.findIndex((header) =>
          /\b(?:eol|end(?:\s|-)*of(?:\s|-)*(?:life|support))\b/i.test(header),
        );
        if (versionIndex < 0 || lifecycleIndex < 0) return;
        if (!lifecycleHeadersCounted) {
          diagnostic.lifecycleHeaderTablesFound += 1;
          lifecycleHeadersCounted = true;
        }
        diagnostic.rawCandidateCount += 1;

        const versionCell = cells[versionIndex] ?? "";
        const releaseVersion = versionCell.match(/\bv?(\d+(?:\.\d+){0,3})(?:\.x)?\b/i)?.[1];
        const requestedParts = targetVersion.split(".");
        const rowParts = releaseVersion?.split(".") ?? [];
        const sameRequestedVersion =
          releaseVersion &&
          (requestedParts.length === 1
            ? rowParts[0] === requestedParts[0] && rowParts.length === 1
            : releaseVersion === targetVersion);
        const sameVersion = Boolean(sameRequestedVersion);
        const lifecycleDate = cells[lifecycleIndex] ?? "";
        const dateIsValid =
          /^\s*(?:20\d{2}-(?:0[1-9]|1[0-2])(?:-\d{2})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:20\d{2}|\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}))\s*$/i.test(
            lifecycleDate,
          );
        const rejectionReason:
          "unparseable_version" | "wrong_version" | "missing_or_invalid_date" | undefined =
          !releaseVersion
            ? "unparseable_version"
            : !sameVersion
              ? "wrong_version"
              : !dateIsValid
                ? "missing_or_invalid_date"
                : undefined;
        const candidate = {
          version: (releaseVersion ?? "unparsed").slice(0, 40),
          date: lifecycleDate.replace(/\s+/g, " ").slice(0, 40),
          requestedVersionMatch: sameVersion,
          outcome: rejectionReason ? ("rejected" as const) : ("accepted" as const),
          ...(rejectionReason ? { rejectionReason } : {}),
        };
        if (diagnostic.candidates.length < 20) diagnostic.candidates.push(candidate);
        else diagnostic.omittedCandidateCount += 1;

        if (!sameVersion) return;
        matchingVersionRows += 1;
        if (!dateIsValid) {
          invalidDateRows += 1;
          return;
        }

        rows.push(
          entity + " version " + releaseVersion + " end-of-life date: " + lifecycleDate + ".",
        );
        diagnostic.normalizedCandidateCount += 1;
      });
  });

  if (rows.length === 0) {
    diagnostic.rejectionReason =
      diagnostic.tablesFound === 0
        ? "no_html_tables"
        : diagnostic.lifecycleHeaderTablesFound === 0
          ? "no_version_and_lifecycle_columns"
          : matchingVersionRows === 0
            ? "no_requested_version_row"
            : invalidDateRows > 0
              ? "requested_version_date_invalid"
              : "no_normalizable_lifecycle_rows";
    recordDiagnostic();
    return document;
  }
  recordDiagnostic();
  return {
    ...document,
    contentType: "structured",
    content: [...new Set([...document.content.split(/\n+/), ...rows])].filter(Boolean).join("\n"),
  };
}

function structuredDocumentFromHtml(raw: string, url: URL): ExtractedDocument | undefined {
  const $ = cheerio.load(raw);
  const records: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      const parsed = JSON.parse($(element).contents().text()) as unknown;
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if (item["@graph"]) visit(item["@graph"]);
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (types.some((type) => typeof type === "string" && /article|news/i.test(type))) {
          records.push(item);
        }
      };
      visit(parsed);
    } catch {
      // Invalid embedded metadata is ignored; the safe HTML extractor remains available.
    }
  });
  const record =
    records.find(
      (item) => typeof item.articleBody === "string" && item.articleBody.length >= 120,
    ) ??
    records.find((item) => typeof item.description === "string" && item.description.length >= 80);
  const field = (value: unknown): string | undefined =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : undefined;
  if (!record) {
    const description =
      $("meta[property='og:description'],meta[name='description']")
        .first()
        .attr("content")
        ?.replace(/\s+/g, " ")
        .trim() ?? "";
    if (description.length < 80) return undefined;
    const canonical = $("link[rel='canonical']").attr("href");
    return {
      title: $("meta[property='og:title']").attr("content") ?? $("title").text().trim(),
      description,
      canonicalUrl: canonical ? new URL(canonical, url).toString() : undefined,
      domain: url.hostname,
      content: description,
      headings: [],
      contentType: "structured",
      contentOrigin: "metadata",
    };
  }
  const author =
    typeof record.author === "string"
      ? record.author
      : record.author && typeof record.author === "object"
        ? field((record.author as Record<string, unknown>).name)
        : undefined;
  const description = field(record.description) ?? "";
  const articleBody = field(record.articleBody);
  const content = articleBody ?? description;
  const document: ExtractedDocument = {
    title: field(record.headline) ?? field(record.name) ?? "",
    description,
    author,
    publishedAt: field(record.datePublished) ?? field(record.dateCreated),
    canonicalUrl: field(record.url) ?? field(record.mainEntityOfPage),
    domain: url.hostname,
    content,
    headings: [],
    contentType: "structured",
    ...(articleBody ? {} : { contentOrigin: "metadata" as const }),
  };
  try {
    validateExtraction(document);
    return document;
  } catch {
    return undefined;
  }
}

function feedCandidates(raw: string, pageUrl: URL): string[] {
  const $ = cheerio.load(raw);
  const urls = $("link[rel~='alternate']")
    .toArray()
    .filter((element) => /rss|atom|xml/i.test($(element).attr("type") ?? ""))
    .map((element) => {
      try {
        return new URL($(element).attr("href") ?? "", pageUrl).toString();
      } catch {
        return undefined;
      }
    })
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => new URL(candidate).hostname === pageUrl.hostname);
  return [...new Set(urls)].slice(0, 2);
}

function isHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

function isSupported(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml|text\/plain|application\/(?:rss|atom)\+xml|text\/xml|application\/xml|application\/(?:[\w.-]+\+)?json/i.test(
    contentType,
  );
}

function indicatesClientRenderedContent(rawHtml: string): boolean {
  return /__NEXT_DATA__|__next_f\.push|__NUXT__|window\.__INITIAL_STATE__|data-reactroot|ng-version=/i.test(
    rawHtml,
  );
}

function success(
  url: string,
  raw: string,
  contentType: string,
  document: ExtractedDocument,
  retrievalMethod: RetrievalMethod,
  retrievalAttempts: string[],
  retrievalMethodsSkipped: string[] = [],
  retrievalReasons: string[] = [],
): RetrievedSource {
  validateExtraction(document);
  return {
    url,
    html: raw,
    contentType,
    document,
    retrievalMethod,
    retrievalAttempts,
    extractionConfidence: qualityConfidence(document),
    extractionStatus: "SUCCEEDED",
    retrievedContentLength: document.content.length,
    retrievalMethodsSkipped,
    retrievalReasons,
  };
}

function advertisedLinks(header: string | null, pageUrl: URL, kind: "feed" | "json"): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((item) => {
    const target = item.match(/<([^>]+)>/)?.[1];
    const rel = item.match(/\brel\s*=\s*["']?([^;"',]+)["']?/i)?.[1] ?? "";
    const type = item.match(/\btype\s*=\s*["']?([^;"',]+)["']?/i)?.[1] ?? "";
    const expected = kind === "feed" ? /rss|atom|xml/i : /application\/json/i;
    if (!target || !/alternate/i.test(rel) || !expected.test(type)) return [];
    try {
      const url = new URL(target, pageUrl);
      return url.hostname === pageUrl.hostname ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
}

async function readMetadataHead(
  url: string,
  dependencies: SourceRetrievalDependencies,
): Promise<{ url: string; contentType: string; link: string | null }> {
  const fetched = await runResearchStage("http_extraction", () =>
    dependencies.fetch(url, { method: "HEAD" }),
  );
  try {
    if (!fetched.response.ok) throw new Error(`HEAD HTTP ${fetched.response.status}`);
    return {
      url: fetched.url,
      contentType: fetched.response.headers.get("content-type") ?? "",
      link: fetched.response.headers.get("link"),
    };
  } finally {
    if (!fetched.response.bodyUsed) {
      await fetched.response.body?.cancel().catch(() => undefined);
    }
    await fetched.dispose();
  }
}

async function readPreview(
  url: string,
  dependencies: SourceRetrievalDependencies,
): Promise<{ url: string; raw: string; contentType: string }> {
  const fetched = await runResearchStage("http_extraction", () =>
    dependencies.fetch(url, { headers: { range: "bytes=0-65535" } }),
  );
  try {
    if (!fetched.response.ok && fetched.response.status !== 206) {
      throw new Error(`Metadata preview HTTP ${fetched.response.status}`);
    }
    const contentType = fetched.response.headers.get("content-type") ?? "";
    return {
      url: fetched.url,
      raw: await runResearchStage("http_extraction", () =>
        readBoundedPrefixText(fetched.response, 65_536, config.FETCH_TIMEOUT_MS),
      ),
      contentType,
    };
  } finally {
    if (!fetched.response.bodyUsed) {
      await fetched.response.body?.cancel().catch(() => undefined);
    }
    await fetched.dispose();
  }
}

async function readFullDocument(
  url: string,
  dependencies: SourceRetrievalDependencies,
): Promise<{
  url: string;
  raw: string;
  contentType: string;
  link: string | null;
  document?: ExtractedDocument;
}> {
  const fetched = await runResearchStage("http_extraction", () =>
    dependencies.fetch(url, { method: "GET" }),
  );
  try {
    if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
    const contentType = fetched.response.headers.get("content-type") ?? "";
    const link = fetched.response.headers.get("link");
    if (/^application\/pdf\b/i.test(contentType)) {
      const bytes = await runResearchStage("http_extraction", () =>
        readBoundedBytes(fetched.response, 8_000_000, config.FETCH_TIMEOUT_MS),
      );
      const document = await runResearchStage("http_extraction", () =>
        extractPdf(bytes, new URL(fetched.url)),
      );
      validateExtraction(document);
      return { url: fetched.url, raw: "", contentType, link, document };
    }
    if (!isSupported(contentType)) {
      throw new Error(`Unsupported source content type: ${contentType || "missing"}`);
    }
    return {
      url: fetched.url,
      raw: await runResearchStage("http_extraction", () =>
        readBoundedText(fetched.response, config.MAX_CONTENT_BYTES, config.FETCH_TIMEOUT_MS),
      ),
      contentType,
      link,
    };
  } finally {
    if (!fetched.response.bodyUsed) {
      await fetched.response.body?.cancel().catch(() => undefined);
    }
    await fetched.dispose();
  }
}

function releaseHistoryProbe(input: {
  url: string;
  repository: string;
  classification: NonNullable<ReturnType<typeof classifyFirstPartyGitHubSource>>;
  title: string;
  content: string;
  retrievalMethod: Source["retrievalMethod"];
  kind: ReleaseHistorySourceKind;
  complete: boolean;
}): Source {
  return {
    id: "release-history-retrieval-probe",
    title: input.title,
    url: input.url,
    snippet: "",
    domain: "github.com",
    sourceType: "official",
    firstPartyClassification: input.classification,
    releaseHistorySourceKind: input.kind,
    releaseHistoryComplete: input.complete,
    retrievalMethod: input.retrievalMethod,
    content: input.content,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function historyVersionCount(probe: Source, question: string, entity: string): number {
  return new Set(
    parseOfficialReleaseHistorySource(probe, question, entity).map((entry) => entry.version),
  ).size;
}

function normalizedApiDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(20\d{2}-\d{2}-\d{2})/);
  return match?.[1];
}

const GITHUB_RELEASES_API_PAGE_SIZE = 30;
const MAX_GITHUB_RELEASES_API_PAGES = 5;

interface GitHubRepositoryIdentity {
  owner: string;
  name: string;
  fullName: string;
  id: number;
}

function isExactGitHubRepositoryMetadataUrl(rawUrl: string, repository: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.github.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.toLowerCase() === `/repos/${repository.toLowerCase()}` &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function githubRepositoryIdentity(
  raw: string,
  repository: string,
): GitHubRepositoryIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const metadata = parsed as Record<string, unknown>;
  const [expectedOwner, expectedName, ...extra] = repository.split("/");
  const owner = metadata.owner;
  if (
    extra.length > 0 ||
    !expectedOwner ||
    !expectedName ||
    typeof metadata.full_name !== "string" ||
    metadata.full_name !== repository ||
    metadata.name !== expectedName ||
    !owner ||
    typeof owner !== "object" ||
    (owner as Record<string, unknown>).login !== expectedOwner ||
    typeof metadata.id !== "number" ||
    !Number.isSafeInteger(metadata.id) ||
    metadata.id <= 0
  ) {
    return undefined;
  }

  return {
    owner: expectedOwner,
    name: expectedName,
    fullName: repository,
    id: metadata.id,
  };
}

async function readGitHubRepositoryIdentity(
  repository: string,
  dependencies: SourceRetrievalDependencies,
): Promise<GitHubRepositoryIdentity> {
  const metadataUrl = `https://api.github.com/repos/${repository}`;
  const metadata = await readFullDocument(metadataUrl, dependencies);
  if (!isExactGitHubRepositoryMetadataUrl(metadata.url, repository)) {
    throw new Error("GitHub repository metadata resolved outside the exact repository endpoint.");
  }
  const identity = githubRepositoryIdentity(metadata.raw, repository);
  if (!identity) {
    throw new Error("GitHub repository metadata did not match the expected canonical identity.");
  }
  return identity;
}

function numericRepositoryId(rawUrl: string): number | undefined {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^\/repositories\/(\d+)\/releases$/i);
    if (!match) return undefined;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 && String(id) === match[1] ? id : undefined;
  } catch {
    return undefined;
  }
}

function isExactGitHubReleaseApiPage(
  rawUrl: string,
  repository: string,
  expectedPage: number,
  identity?: GitHubRepositoryIdentity,
): boolean {
  try {
    const url = new URL(rawUrl);
    const expectedPath = `/repos/${repository.toLowerCase()}/releases`;
    const numericId = numericRepositoryId(rawUrl);
    const repositoryPathMatches = url.pathname.toLowerCase() === expectedPath;
    const numericPathMatches =
      numericId !== undefined && identity !== undefined && numericId === identity.id;
    const pageValues = url.searchParams.getAll("page");
    const pageSizeValues = url.searchParams.getAll("per_page");
    const allowedParams = new Set(["page", "per_page"]);
    const page = pageValues.length === 0 ? 1 : Number(pageValues[0]);

    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.github.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (repositoryPathMatches || numericPathMatches) &&
      [...url.searchParams.keys()].every((key) => allowedParams.has(key)) &&
      pageValues.length <= 1 &&
      pageSizeValues.length === 1 &&
      pageSizeValues[0] === String(GITHUB_RELEASES_API_PAGE_SIZE) &&
      Number.isSafeInteger(page) &&
      page === expectedPage &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function safePaginationPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      segment.length > 80 || /^[a-f\d]{32,}$/i.test(segment) ? "[redacted]" : segment,
    )
    .join("/")
    .slice(0, 256);
}

function paginationDiagnostic(
  currentPageUrl: URL,
  nextPageUrl: URL | undefined,
  repository: string,
  expectedPage: number,
  identity?: GitHubRepositoryIdentity,
  rejectionReason?: string,
): { message: string; rejectionReason?: string } {
  const pageValues = nextPageUrl?.searchParams.getAll("page") ?? [];
  const pageValue = pageValues.length === 1 ? Number(pageValues[0]) : undefined;
  const parsedPage = Number.isSafeInteger(pageValue) ? pageValue : null;
  const queryKeys = nextPageUrl
    ? [...nextPageUrl.searchParams.keys()]
        .map((key) => (/^[a-z\d_-]{1,40}$/i.test(key) ? key : "[other]"))
        .sort()
    : [];
  const originMatches = Boolean(
    nextPageUrl &&
    nextPageUrl.protocol === "https:" &&
    nextPageUrl.origin === "https://api.github.com" &&
    !nextPageUrl.username &&
    !nextPageUrl.password,
  );
  const repositoryPathMatches = Boolean(
    nextPageUrl &&
    nextPageUrl.pathname.toLowerCase() === `/repos/${repository.toLowerCase()}/releases`,
  );
  const numericId = nextPageUrl ? numericRepositoryId(nextPageUrl.toString()) : undefined;
  const repositoryIdBound = identity !== undefined;
  const repositoryIdMatch =
    numericId !== undefined && identity !== undefined && numericId === identity.id;
  const acceptedRepositoryPath = repositoryPathMatches || repositoryIdMatch;
  const sequentialPageMatches = parsedPage === expectedPage && pageValues.length === 1;
  const allowedQueryKeys = queryKeys.every((key) => key === "page" || key === "per_page");
  const pageSizeMatches =
    (nextPageUrl?.searchParams.getAll("per_page").length ?? 0) === 1 &&
    nextPageUrl?.searchParams.get("per_page") === String(GITHUB_RELEASES_API_PAGE_SIZE);
  const reason =
    rejectionReason ??
    (!originMatches
      ? "origin_mismatch"
      : !acceptedRepositoryPath
        ? numericId === undefined
          ? "repository_path_mismatch"
          : !repositoryIdBound
            ? "repository_id_unbound"
            : "repository_id_mismatch"
        : !allowedQueryKeys
          ? "unexpected_query_key"
          : !pageSizeMatches
            ? "page_size_mismatch"
            : !sequentialPageMatches
              ? "non_sequential_or_invalid_page"
              : nextPageUrl?.hash
                ? "fragment_not_allowed"
                : undefined);

  return {
    message: `GitHub pagination diagnostic: ${JSON.stringify({
      sourceOrigin: currentPageUrl.origin,
      sourcePath: safePaginationPath(currentPageUrl.pathname),
      nextOrigin: nextPageUrl?.origin ?? null,
      nextPath: nextPageUrl ? safePaginationPath(nextPageUrl.pathname) : null,
      queryKeys,
      parsedPage,
      expectedPage,
      originMatches,
      repositoryPathMatches,
      numericRepositoryId: numericId ?? null,
      repositoryIdBound,
      repositoryIdMatch: numericId === undefined ? null : repositoryIdMatch,
      boundRepository: identity?.fullName ?? null,
      boundRepositoryId: identity?.id ?? null,
      acceptedRepositoryPath,
      sequentialPageMatches,
      allowedQueryKeys,
      pageSizeMatches,
      credentialsAbsent: Boolean(nextPageUrl && !nextPageUrl.username && !nextPageUrl.password),
      fragmentAbsent: Boolean(nextPageUrl && !nextPageUrl.hash),
      rejectionReason: reason ?? null,
    })}`,
    rejectionReason: reason,
  };
}

function nextGitHubReleaseApiPage(
  responseLink: string | null,
  currentPageUrl: string,
  repository: string,
  identity?: GitHubRepositoryIdentity,
):
  | { kind: "end" }
  | { kind: "invalid"; diagnostic: string; reason: string }
  | { kind: "identity_required"; diagnostic: string; url: string; page: number }
  | { kind: "next"; url: string; page: number; diagnostic: string } {
  const currentUrl = new URL(currentPageUrl);
  const currentPage = Number(currentUrl.searchParams.get("page") ?? "1");
  const expectedPage = currentPage + 1;
  const links = (responseLink ?? "").split(/,(?=\s*<)/);
  const nextLink = links.find((link) => {
    const rel = link.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;,\s]+))/i);
    return (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "")
      .split(/\s+/)
      .some((value) => value.toLowerCase() === "next");
  });
  if (!nextLink) return { kind: "end" };

  const target = nextLink.match(/<([^>]+)>/)?.[1];
  if (!target) {
    const diagnostic = paginationDiagnostic(
      currentUrl,
      undefined,
      repository,
      expectedPage,
      identity,
      "missing_target",
    );
    return {
      kind: "invalid",
      diagnostic: diagnostic.message,
      reason: "missing_target",
    };
  }

  try {
    const nextUrl = new URL(target, currentUrl);
    const diagnostic = paginationDiagnostic(
      currentUrl,
      nextUrl,
      repository,
      expectedPage,
      identity,
    );
    const numericId = numericRepositoryId(nextUrl.toString());
    if (numericId !== undefined && identity === undefined) {
      return {
        kind: "identity_required",
        diagnostic: diagnostic.message,
        url: nextUrl.toString(),
        page: expectedPage,
      };
    }
    if (!isExactGitHubReleaseApiPage(nextUrl.toString(), repository, expectedPage, identity)) {
      return {
        kind: "invalid",
        diagnostic: diagnostic.message,
        reason: diagnostic.rejectionReason ?? "other_url_validation_failure",
      };
    }
    return {
      kind: "next",
      url: nextUrl.toString(),
      page: expectedPage,
      diagnostic: diagnostic.message,
    };
  } catch {
    const diagnostic = paginationDiagnostic(
      currentUrl,
      undefined,
      repository,
      expectedPage,
      identity,
      "malformed_url",
    );
    return {
      kind: "invalid",
      diagnostic: diagnostic.message,
      reason: "malformed_url",
    };
  }
}

function githubReleaseApiRows(raw: string, pageUrl: string, entity: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  return parsed.slice(0, GITHUB_RELEASES_API_PAGE_SIZE).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const release = item as Record<string, unknown>;
    if (release.draft === true || typeof release.tag_name !== "string") return [];
    const version = release.tag_name.trim().replace(/^v(?=\d)/i, "");
    if (!/^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/.test(version)) return [];
    const releaseName = typeof release.name === "string" ? release.name.trim() : "";
    if (subjectEntityMismatchReason(entity, `${entity} ${releaseName}`)) return [];
    const releaseDate = normalizedApiDate(release.published_at);
    const status =
      typeof release.prerelease === "boolean"
        ? release.prerelease
          ? "prerelease"
          : "stable"
        : "unknown";
    return [
      `${entity} ${version} | release date: ${releaseDate ?? "unknown"} | status: ${status} | source page: ${pageUrl}`,
    ];
  });
}

function githubReleaseApiDocument(
  rows: string[],
  pageUrls: string[],
  pageUrl: string,
  repository: string,
  complete: boolean,
): { document: ExtractedDocument; complete: boolean } | undefined {
  if (rows.length === 0) return undefined;
  return {
    document: {
      title: `${repository} official GitHub Releases`,
      description: `Structured release records from the exact first-party repository across ${pageUrls.length} page(s).`,
      canonicalUrl: pageUrl,
      domain: "github.com",
      content: rows.join("\n"),
      headings: rows.slice(0, 30),
      contentType: "structured",
    },
    complete,
  };
}

/**
 * A small, first-party-only ladder for GitHub release-history search results.
 * It reuses the existing safe fetcher and never performs a new search.
 */
async function retrieveGitHubReleaseHistory(
  input: {
    result: Pick<SearchResult, "url" | "title" | "snippet">;
    question: string;
  },
  initial: RetrievedSource,
  dependencies: SourceRetrievalDependencies,
): Promise<RetrievedSource> {
  const classification = classifyFirstPartyGitHubSource(input.result.url);
  if (!classification || classification.contentKind !== "release_history") return initial;

  const repository = classification.repository;
  const entity = classification.entity;
  const historyUrl = `https://github.com/${repository}/releases`;
  const attempts = [...initial.retrievalAttempts];
  const reasons = [...initial.retrievalReasons];
  const skipped = [...initial.retrievalMethodsSkipped];
  const appendAttempt = (label: string) => {
    if (!attempts.includes(label)) attempts.push(label);
  };
  const makeResult = (
    document: ExtractedDocument,
    raw: string,
    contentType: string,
    method: RetrievalMethod,
    sourceUrl: string,
    kind: ReleaseHistorySourceKind,
    complete: boolean,
    reason: string,
  ) => {
    const result = success(historyUrl, raw, contentType, document, method, attempts, skipped, [
      ...reasons,
      reason,
    ]);
    return {
      ...result,
      retrievalSourceUrl: sourceUrl,
      releaseHistorySourceKind: kind,
      releaseHistoryComplete: complete,
    };
  };
  const probe = (
    document: ExtractedDocument,
    method: Source["retrievalMethod"],
    kind: ReleaseHistorySourceKind,
    complete = false,
  ) =>
    releaseHistoryProbe({
      url: historyUrl,
      repository,
      classification,
      title: document.title || initial.document.title || input.result.title,
      content: document.content,
      retrievalMethod: method,
      kind,
      complete,
    });

  let best = initial;
  let bestCount = 0;
  const initialKind: ReleaseHistorySourceKind =
    initial.retrievalMethod === "rss" || /\.atom(?:$|\?)/i.test(input.result.url)
      ? "github_releases_feed"
      : "github_releases_html";
  const initialProbe = probe(initial.document, initial.retrievalMethod, initialKind);
  bestCount = historyVersionCount(initialProbe, input.question, entity);
  if (bestCount > 0) {
    best = {
      ...initial,
      url: historyUrl,
      retrievalSourceUrl: initial.url,
      releaseHistorySourceKind: initialKind,
      releaseHistoryComplete: false,
    };
  }

  const completeHistory = (source: Source) =>
    parseOfficialReleaseHistorySource(source, input.question, entity).length >= 2 &&
    parseOfficialReleaseHistorySource(source, input.question, entity).every(
      (entry) => entry.completeHistory && entry.stability !== "unknown",
    );
  if (bestCount >= 2 && completeHistory(initialProbe)) {
    return { ...best, releaseHistoryComplete: true };
  }

  const alreadyFetchedFullHtml =
    initial.retrievalAttempts.includes("http") && initial.url === historyUrl;
  if (!alreadyFetchedFullHtml) {
    appendAttempt("github_releases_html");
    try {
      const html = await readFullDocument(historyUrl, dependencies);
      if (new URL(html.url).hostname.toLowerCase() !== "github.com") {
        throw new Error("GitHub releases HTML redirected outside github.com.");
      }
      const document = extractRetrievedDocument(html.raw, new URL(html.url), html.contentType);
      validateExtraction(document);
      const htmlProbe = probe(document, "http", "github_releases_html");
      const count = historyVersionCount(htmlProbe, input.question, entity);
      reasons.push("Read the exact allowlisted repository's full Releases HTML page.");
      if (count > bestCount) {
        bestCount = count;
        best = makeResult(
          document,
          html.raw,
          html.contentType,
          "http",
          html.url,
          "github_releases_html",
          false,
          "Full Releases HTML was retained as the best available history candidate.",
        );
      }
      if (count >= 2 && completeHistory(htmlProbe)) {
        return makeResult(
          document,
          html.raw,
          html.contentType,
          "http",
          html.url,
          "github_releases_html",
          true,
          "The official history page explicitly identified a complete, status-labeled history.",
        );
      }
    } catch {
      stopIfResearchDeadlineExpired();
      reasons.push("The bounded full Releases HTML request was unavailable or not useful.");
    }
  }

  appendAttempt("github_releases_feed");
  const feedUrl = `https://github.com/${repository}/releases.atom`;
  try {
    const feed = await readFullDocument(feedUrl, dependencies);
    if (new URL(feed.url).hostname.toLowerCase() !== "github.com") {
      throw new Error("GitHub releases feed redirected outside github.com.");
    }
    const document = extractRetrievedDocument(feed.raw, new URL(feed.url), feed.contentType);
    validateExtraction(document);
    const feedProbe = probe(document, "rss", "github_releases_feed");
    const count = historyVersionCount(feedProbe, input.question, entity);
    reasons.push("Read the exact allowlisted repository's Releases Atom feed.");
    if (count > bestCount) {
      bestCount = count;
      best = makeResult(
        document,
        feed.raw,
        feed.contentType,
        "rss",
        feed.url,
        "github_releases_feed",
        false,
        "The Releases Atom feed was retained as the best available history candidate.",
      );
    }
    if (count >= 2 && completeHistory(feedProbe)) {
      return makeResult(
        document,
        feed.raw,
        feed.contentType,
        "rss",
        feed.url,
        "github_releases_feed",
        true,
        "The official feed explicitly identified a complete, status-labeled history.",
      );
    }
  } catch {
    stopIfResearchDeadlineExpired();
    reasons.push("The bounded Releases Atom feed request was unavailable or not useful.");
  }

  appendAttempt("github_releases_api");
  const apiUrl = `https://api.github.com/repos/${repository}/releases?per_page=${GITHUB_RELEASES_API_PAGE_SIZE}`;
  try {
    const pages: Array<{ url: string; raw: string; contentType: string }> = [];
    const rows: string[] = [];
    const seenPageUrls = new Set<string>();
    let requestUrl = apiUrl;
    let expectedPage = 1;
    let complete = false;
    let paginationStoppedReason: string | undefined;
    let repositoryIdentity: GitHubRepositoryIdentity | undefined;

    while (pages.length < MAX_GITHUB_RELEASES_API_PAGES) {
      let structured: Awaited<ReturnType<typeof readFullDocument>>;
      try {
        structured = await readFullDocument(requestUrl, dependencies);
      } catch (error) {
        stopIfResearchDeadlineExpired();
        if (pages.length === 0) throw error;
        paginationStoppedReason = "A later first-party API page could not be retrieved.";
        break;
      }

      if (
        !isExactGitHubReleaseApiPage(structured.url, repository, expectedPage, repositoryIdentity)
      ) {
        if (pages.length === 0) {
          throw new Error("GitHub releases API redirected outside the exact repository endpoint.");
        }
        paginationStoppedReason =
          "A later API page resolved outside the exact repository endpoint.";
        break;
      }

      const pageRows = githubReleaseApiRows(structured.raw, structured.url, entity);
      if (!pageRows) {
        if (pages.length === 0) {
          throw new Error("GitHub releases API returned no parseable release records.");
        }
        paginationStoppedReason = "A later API page did not contain parseable release records.";
        break;
      }
      pages.push({ url: structured.url, raw: structured.raw, contentType: structured.contentType });
      rows.push(...pageRows);
      seenPageUrls.add(structured.url);

      let nextPage = nextGitHubReleaseApiPage(
        structured.link,
        structured.url,
        repository,
        repositoryIdentity,
      );
      if (nextPage.kind === "end") {
        complete = true;
        break;
      }
      if (nextPage.kind === "identity_required") {
        const unboundDiagnostic = nextPage.diagnostic;
        try {
          repositoryIdentity = await readGitHubRepositoryIdentity(repository, dependencies);
        } catch {
          stopIfResearchDeadlineExpired();
          reasons.push(unboundDiagnostic);
          paginationStoppedReason =
            "The numeric repository pagination link could not be bound to validated canonical repository metadata.";
          break;
        }
        nextPage = nextGitHubReleaseApiPage(
          structured.link,
          structured.url,
          repository,
          repositoryIdentity,
        );
        if (nextPage.kind === "identity_required") {
          reasons.push(nextPage.diagnostic);
          paginationStoppedReason =
            "The numeric repository pagination link remained unbound after metadata validation.";
          break;
        }
      }
      if (nextPage.kind === "end") {
        complete = true;
        break;
      }
      reasons.push(nextPage.diagnostic);
      if (nextPage.kind === "invalid") {
        paginationStoppedReason = `The API advertised an invalid or unsafe next-page link (${nextPage.reason}).`;
        break;
      }
      if (seenPageUrls.has(nextPage.url)) {
        paginationStoppedReason = "The API pagination link repeated an already-read page.";
        break;
      }
      if (pages.length >= MAX_GITHUB_RELEASES_API_PAGES) {
        paginationStoppedReason = "The bounded API page limit was reached before history ended.";
        break;
      }

      requestUrl = nextPage.url;
      expectedPage = nextPage.page;
    }

    const api = githubReleaseApiDocument(
      rows,
      pages.map((page) => page.url),
      historyUrl,
      repository,
      complete,
    );
    if (!api) throw new Error("GitHub releases API returned no parseable release records.");
    const pageProvenance = pages.map(({ url }) => url).join(", ");
    const apiProbe = probe(api.document, "structured", "first_party_structured", api.complete);
    const count = historyVersionCount(apiProbe, input.question, entity);
    reasons.push(
      api.complete
        ? `The exact first-party Releases API history ended after ${pages.length} page(s).`
        : (paginationStoppedReason ??
            "The first-party Releases API indicated additional pages; history remains incomplete."),
    );
    if (count > bestCount || (count === bestCount && api.complete)) {
      bestCount = count;
      best = makeResult(
        api.document,
        pages.map(({ raw }) => raw).join("\n"),
        pages[0]?.contentType ?? "application/vnd.github+json",
        "structured",
        pages[0]?.url ?? apiUrl,
        "first_party_structured",
        api.complete,
        api.complete
          ? `Structured releases from the complete first-party API history were selected (${pageProvenance}).`
          : `Structured releases were selected, but API pagination keeps the history incomplete (${pageProvenance}).`,
      );
    }
    if (api.complete && count >= 2 && completeHistory(apiProbe)) return best;
  } catch {
    stopIfResearchDeadlineExpired();
    reasons.push("The bounded first-party Releases API request was unavailable or not useful.");
  }

  if (best !== initial) {
    return {
      ...best,
      retrievalAttempts: attempts,
      retrievalMethodsSkipped: skipped,
      retrievalReasons: reasons,
    };
  }
  return {
    ...initial,
    retrievalAttempts: attempts,
    retrievalMethodsSkipped: skipped,
    retrievalReasons: reasons,
  };
}

async function retrieveSourceWithTrace(
  input: {
    result: Pick<SearchResult, "url" | "title" | "snippet">;
    question: string;
    allowSnippetEvidence?: boolean;
    requestedFacts?: RequestedFactKind[];
    researchChatOptimization?: boolean;
  },
  dependencies: SourceRetrievalDependencies = defaultDependencies,
  attempts: string[] = ["serper_snippet"],
  skipped: string[] = [],
  reasons: string[] = [],
): Promise<RetrievedSource> {
  const snippetAssessment = assessSerperSnippet(input.result, input.question, input.requestedFacts);
  const isGitHubReleaseHistory =
    classifyFirstPartyGitHubSource(input.result.url)?.contentKind === "release_history";
  if (
    !isGitHubReleaseHistory &&
    input.allowSnippetEvidence !== false &&
    snippetAssessment.sufficient
  ) {
    const url = new URL(input.result.url);
    const document: ExtractedDocument = {
      title: input.result.title,
      description: input.result.snippet,
      domain: url.hostname,
      content: input.result.snippet.trim(),
      headings: [],
      contentType: "structured",
    };
    return success(
      input.result.url,
      "",
      "text/plain",
      document,
      "serper_snippet",
      attempts,
      ["rss", "structured", "http", "browser"],
      [snippetAssessment.reason],
    );
  }
  reasons.push(
    input.allowSnippetEvidence === false
      ? "Snippet evidence was disabled by the research policy; source-level retrieval is required."
      : snippetAssessment.reason,
  );
  let head: { url: string; contentType: string; link: string | null } | undefined;
  try {
    head = await readMetadataHead(input.result.url, dependencies);
  } catch {
    stopIfResearchDeadlineExpired();
    reasons.push("A safe metadata-only HEAD request did not yield source hints.");
  }
  const pageUrl = new URL(head?.url ?? input.result.url);
  if (head && /^application\/pdf\b/i.test(head.contentType)) {
    const full = await readFullDocument(head.url, dependencies);
    if (full.document) {
      attempts.push("http", "pdf");
      return success(
        full.url,
        "",
        full.contentType,
        full.document,
        "pdf",
        attempts,
        ["rss", "structured", "browser"],
        [...reasons, "The server identified the source as a PDF document."],
      );
    }
  }
  const feedUrls = [
    ...advertisedLinks(head?.link ?? null, pageUrl, "feed"),
    ...(head && /rss|atom|xml/i.test(head.contentType) ? [head.url] : []),
  ]
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, 2);
  const triedFeeds = new Set<string>();

  const useFeed = async (urls: string[]) => {
    if (urls.length === 0) return undefined;
    if (!attempts.includes("rss")) attempts.push("rss");
    for (const feedUrl of urls) {
      if (triedFeeds.has(feedUrl)) continue;
      triedFeeds.add(feedUrl);
      try {
        const feed = await readFullDocument(feedUrl, dependencies);
        const document = extractRetrievedDocument(
          feed.raw,
          new URL(feed.url),
          feed.contentType,
          feedUrl === input.result.url ? undefined : input.result.url,
        );
        validateExtraction(document);
        const missingFacts = missingRequestedFactsForDocument(
          input.question,
          document,
          input.requestedFacts,
          input.researchChatOptimization,
        );
        if (missingFacts.length > 0) {
          reasons.push(
            `The matching feed entry omitted requested fact(s): ${missingFacts.join(", ")}; continuing to the next retrieval method.`,
          );
          continue;
        }
        reasons.push(
          "A same-site feed was advertised and its entry matched the selected article URL.",
        );
        return success(
          feed.url,
          feed.raw,
          feed.contentType,
          document,
          "rss",
          attempts,
          ["structured", "http", "browser"],
          reasons,
        );
      } catch {
        stopIfResearchDeadlineExpired();
        reasons.push(
          "The advertised feed was unavailable, unmatched, or too thin to support the task.",
        );
      }
    }
    return undefined;
  };

  const headerFeed = await useFeed(feedUrls);
  if (headerFeed) return headerFeed;
  if (feedUrls.length === 0) {
    attempts.push("rss");
    reasons.push("Response headers did not advertise an RSS/Atom source.");
  }

  const jsonUrls = advertisedLinks(head?.link ?? null, pageUrl, "json").slice(0, 1);
  if (jsonUrls.length > 0) {
    attempts.push("structured");
    try {
      const structured = await readFullDocument(jsonUrls[0], dependencies);
      const document = extractRetrievedDocument(
        structured.raw,
        new URL(structured.url),
        structured.contentType,
      );
      validateExtraction(document);
      const missingFacts = missingRequestedFactsForDocument(
        input.question,
        document,
        input.requestedFacts,
        input.researchChatOptimization,
      );
      if (missingFacts.length === 0) {
        return success(
          structured.url,
          structured.raw,
          structured.contentType,
          document,
          "structured",
          attempts,
          ["http", "browser"],
          [...reasons, "The source advertised an alternate JSON representation."],
        );
      }
      reasons.push(
        `The advertised JSON representation omitted requested fact(s): ${missingFacts.join(", ")}; continuing to the source page.`,
      );
    } catch {
      stopIfResearchDeadlineExpired();
      reasons.push("The advertised JSON representation was unavailable or insufficient.");
    }
  }

  let preview: { url: string; raw: string; contentType: string } | undefined;
  if (head && /application\/json/i.test(head.contentType)) {
    attempts.push("structured");
    const structured = await readFullDocument(head.url, dependencies);
    const document = extractRetrievedDocument(
      structured.raw,
      new URL(structured.url),
      structured.contentType,
    );
    reasons.push("The source declared a structured JSON content type.");
    const missingFacts = missingRequestedFactsForDocument(
      input.question,
      document,
      input.requestedFacts,
      input.researchChatOptimization,
    );
    if (missingFacts.length > 0) {
      reasons.push(
        `The structured response omitted requested fact(s): ${missingFacts.join(", ")}; no richer representation is available at this URL.`,
      );
    }
    return success(
      structured.url,
      structured.raw,
      structured.contentType,
      document,
      "structured",
      attempts,
      ["http", "browser"],
      reasons,
    );
  }

  // A capped range preview discovers feed and embedded metadata without downloading the article.
  try {
    preview = await readPreview(head?.url ?? input.result.url, dependencies);
  } catch {
    stopIfResearchDeadlineExpired();
    reasons.push(
      "The bounded metadata preview was unavailable; escalation will use the safe full fetcher.",
    );
  }
  if (preview && isHtml(preview.contentType)) {
    const previewFeedUrls = feedCandidates(preview.raw, new URL(preview.url))
      .filter((url) => !feedUrls.includes(url))
      .slice(0, 2);
    const previewFeed = await useFeed(previewFeedUrls);
    if (previewFeed) return previewFeed;
    if (previewFeedUrls.length === 0) {
      reasons.push("The capped page preview contained no feed link.");
    }
  }

  if (preview && /application\/json/i.test(preview.contentType)) {
    if (!attempts.includes("structured")) attempts.push("structured");
    try {
      const document = extractRetrievedDocument(
        preview.raw,
        new URL(preview.url),
        preview.contentType,
      );
      validateExtraction(document);
      const missingFacts = missingRequestedFactsForDocument(
        input.question,
        document,
        input.requestedFacts,
        input.researchChatOptimization,
      );
      if (missingFacts.length === 0) {
        return success(
          preview.url,
          preview.raw,
          preview.contentType,
          document,
          "structured",
          attempts,
          ["http", "browser"],
          [...reasons, "The bounded response preview contained sufficient structured JSON."],
        );
      }
      reasons.push(
        `The bounded JSON preview omitted requested fact(s): ${missingFacts.join(", ")}; full retrieval is required.`,
      );
    } catch {
      stopIfResearchDeadlineExpired();
      reasons.push("The bounded structured response was truncated or insufficient.");
    }
  }
  if (preview && isHtml(preview.contentType)) {
    if (!attempts.includes("structured")) attempts.push("structured");
    const structured = structuredDocumentFromHtml(preview.raw, new URL(preview.url));
    if (structured) {
      const missingFacts = missingRequestedFactsForDocument(
        input.question,
        structured,
        input.requestedFacts,
        input.researchChatOptimization,
      );
      if (missingFacts.length === 0) {
        return success(
          preview.url,
          preview.raw,
          preview.contentType,
          structured,
          "structured",
          attempts,
          ["http", "browser"],
          [...reasons, "JSON-LD or OpenGraph metadata in the bounded preview was sufficient."],
        );
      }
      reasons.push(
        `JSON-LD or OpenGraph metadata omitted requested fact(s): ${missingFacts.join(", ")}; continuing to normal HTML extraction.`,
      );
    }
    reasons.push("No task-sufficient JSON, JSON-LD, or OpenGraph data appeared in the preview.");
  } else if (
    preview &&
    /application\/(?:rss|atom)\+xml|text\/xml|application\/xml/i.test(preview.contentType)
  ) {
    if (!attempts.includes("rss")) attempts.push("rss");
    try {
      const document = extractRetrievedDocument(
        preview.raw,
        new URL(preview.url),
        preview.contentType,
      );
      validateExtraction(document);
      const missingFacts = missingRequestedFactsForDocument(
        input.question,
        document,
        input.requestedFacts,
      );
      if (missingFacts.length > 0) {
        reasons.push(
          `The source feed omitted requested fact(s): ${missingFacts.join(", ")}; no richer page representation is available at this URL.`,
        );
      }
      return success(
        preview.url,
        preview.raw,
        preview.contentType,
        document,
        "rss",
        attempts,
        ["structured", "http", "browser"],
        [...reasons, "The source itself exposed an RSS/Atom document."],
      );
    } catch {
      stopIfResearchDeadlineExpired();
      reasons.push("The source feed did not contain enough usable article content.");
    }
  } else if (!attempts.includes("structured")) {
    attempts.push("structured");
    reasons.push("The lightweight response did not expose sufficient structured data.");
  }

  attempts.push("http");
  reasons.push(
    "Lightweight result, feed, and structured-data paths were insufficient; full extraction is justified.",
  );
  const full = await readFullDocument(preview?.url ?? head?.url ?? input.result.url, dependencies);
  if (!isHtml(full.contentType)) {
    const document =
      full.document ?? extractRetrievedDocument(full.raw, new URL(full.url), full.contentType);
    const missingFacts = missingRequestedFactsForDocument(
      input.question,
      document,
      input.requestedFacts,
    );
    return success(
      full.url,
      full.raw,
      full.contentType,
      document,
      full.document ? "pdf" : "http",
      attempts,
      ["browser"],
      missingFacts.length > 0
        ? [
            ...reasons,
            `The retrieved structured source still lacks requested fact(s): ${missingFacts.join(", ")}.`,
          ]
        : reasons,
    );
  }
  let document: ExtractedDocument;
  try {
    document = appendLifecycleTableEvidence(
      extractHtml(full.raw, new URL(full.url)),
      full.raw,
      input.question,
      input.requestedFacts,
      input.researchChatOptimization,
      reasons,
    );
    validateExtraction(document);
  } catch (error) {
    const isShell = /<script|<div\s+id=["'](?:root|app|__next)/i.test(full.raw);
    if (!(isShell && error instanceof Error && error.message.includes("too short"))) throw error;
    reasons.push("Full HTML was an empty JavaScript shell, so browser rendering was warranted.");

    attempts.push("browser");
    const rendered = await runResearchStage("browser_extraction", () =>
      dependencies.browser(full.url, getResearchExecutionContext()?.signal),
    );
    const renderedDocument = appendLifecycleTableEvidence(
      extractHtml(rendered.html, new URL(rendered.url)),
      rendered.html,
      input.question,
      input.requestedFacts,
      input.researchChatOptimization,
      reasons,
    );
    return success(
      rendered.url,
      rendered.html,
      full.contentType,
      renderedDocument,
      "browser",
      attempts,
      [],
      reasons,
    );
  }

  const missingFacts = requestedFactCoverage(input.question, document.content, {
    requestedFacts: input.requestedFacts,
  }).missing;
  if (missingFacts.length > 0 && indicatesClientRenderedContent(full.raw)) {
    reasons.push(
      `Normal HTML extraction omitted requested fact(s): ${missingFacts.join(", ")}; hydration markers indicate client-rendered content, so bounded browser rendering was warranted.`,
    );
    attempts.push("browser");
    const rendered = await runResearchStage("browser_extraction", () =>
      dependencies.browser(full.url, getResearchExecutionContext()?.signal),
    );
    const renderedDocument = appendLifecycleTableEvidence(
      extractHtml(rendered.html, new URL(rendered.url)),
      rendered.html,
      input.question,
      input.requestedFacts,
      input.researchChatOptimization,
      reasons,
    );
    validateExtraction(renderedDocument);
    const renderedMissingFacts = requestedFactCoverage(input.question, renderedDocument.content, {
      requestedFacts: input.requestedFacts,
    }).missing;
    reasons.push(
      renderedMissingFacts.length === 0
        ? "Rendered page exposed the requested fact values absent from normal HTML."
        : `Rendered content still lacks requested fact(s): ${renderedMissingFacts.join(", ")}.`,
    );
    return success(
      rendered.url,
      rendered.html,
      full.contentType,
      renderedDocument,
      "browser",
      attempts,
      [],
      reasons,
    );
  }

  const completionReason =
    missingFacts.length > 0
      ? `Normal HTML extraction succeeded but lacks requested fact(s): ${missingFacts.join(", ")}; no client-rendering indicators justified browser use.`
      : "Normal HTML extraction produced usable article content; browser rendering was skipped.";
  return success(
    full.url,
    full.raw,
    full.contentType,
    document,
    "http",
    attempts,
    ["browser"],
    [...reasons, completionReason],
  );
}

export async function retrieveSource(
  input: {
    result: Pick<SearchResult, "url" | "title" | "snippet">;
    question: string;
    allowSnippetEvidence?: boolean;
    requestedFacts?: RequestedFactKind[];
    researchChatOptimization?: boolean;
  },
  dependencies: SourceRetrievalDependencies = defaultDependencies,
): Promise<RetrievedSource> {
  const attempts = ["serper_snippet"];
  const skipped: string[] = [];
  const reasons: string[] = [];
  try {
    const classification = classifyFirstPartyGitHubSource(input.result.url);
    let initial: RetrievedSource;
    try {
      initial = await retrieveSourceWithTrace(input, dependencies, attempts, skipped, reasons);
    } catch (error) {
      if (classification?.contentKind !== "release_history") throw error;
      stopIfResearchDeadlineExpired();
      const retrievalError = error instanceof SourceRetrievalError ? error : undefined;
      if (retrievalError) {
        attempts.splice(0, attempts.length, ...retrievalError.attempts);
        skipped.push(...retrievalError.skipped);
        reasons.push(...retrievalError.reasons);
      }
      reasons.push(
        "The general retrieval path failed; trying bounded first-party release-history fallbacks.",
      );
      const url = "https://github.com/" + classification.repository + "/releases";
      initial = {
        url,
        html: "",
        contentType: "",
        document: {
          title: input.result.title,
          description: "",
          domain: "github.com",
          content: "",
          headings: [],
          contentType: "structured",
        },
        retrievalMethod: "http",
        retrievalAttempts: [...attempts],
        extractionConfidence: 0,
        extractionStatus: "SUCCEEDED",
        retrievedContentLength: 0,
        retrievalMethodsSkipped: [...skipped],
        retrievalReasons: [...reasons],
      };
    }
    const resolved = await retrieveGitHubReleaseHistory(input, initial, dependencies);
    if (resolved.document.content.trim()) return resolved;
    if (initial.retrievedContentLength > 0) return resolved;
    if (resolved !== initial) {
      throw new SourceRetrievalError(
        "No bounded first-party release-history retrieval method produced usable records.",
        resolved.retrievalAttempts,
        resolved.retrievalMethodsSkipped,
        resolved.retrievalReasons,
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof SourceRetrievalError) throw error;
    throw new SourceRetrievalError(
      error instanceof Error ? error.message : String(error),
      attempts,
      skipped,
      reasons,
    );
  }
}
