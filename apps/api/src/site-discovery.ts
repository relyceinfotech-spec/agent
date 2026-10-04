import * as cheerio from "cheerio";
import { containsExactEntity } from "./entities.js";
import { config } from "./config.js";
import { readBoundedPrefixText, safeFetchWithRetry } from "./security.js";
import { throwIfResearchInactive } from "./execution-context.js";
import type { RequestedPredicateRequirement } from "./requested-facts.js";
import type { SearchResult, Source } from "./domain.js";

const MAX_SITE_MANIFEST_REQUESTS = 3;
const MAX_SITE_MANIFEST_BYTES = 256_000;
const MAX_RAW_SITE_CANDIDATES = 80;
const ASSET_PATH =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip|xml\.gz)(?:$|\/)/i;
const EXCLUDED_PATH =
  /(?:^|\/)(?:login|log-in|sign-in|signup|sign-up|logout|cart|checkout|privacy|terms|cookie-policy)(?:\/|$)/i;
const LEADERSHIP_SECTIONS =
  /\b(?:leadership|team|people|management|executive|founder|founders|board|officers?)\b/i;
const COMPANY_SECTIONS =
  /\b(?:about|company|who we are|our story|history|profile|contact|locations?)\b/i;

export interface SiteDiscoveryFetchResult {
  url: string;
  response: Response;
  dispose: () => Promise<void>;
}

export interface SiteDiscoveryDependencies {
  fetch: (
    url: string,
    init?: RequestInit,
    maxRedirects?: number,
    allowedOrigin?: string,
  ) => Promise<SiteDiscoveryFetchResult>;
}

export interface SiteDiscoveryInput {
  rootUrl: string;
  rootTitle: string;
  rootHtml: string;
  entity: string;
  predicate: RequestedPredicateRequirement;
  maxCandidates: number;
}

export interface InternalSiteCandidate extends SearchResult {
  provider: "site-discovery";
  siteDiscoveryOrigin: string;
}

const defaultDependencies: SiteDiscoveryDependencies = {
  fetch: (url, init, maxRedirects, allowedOrigin) =>
    safeFetchWithRetry(url, init, maxRedirects ?? 3, config.FETCH_TIMEOUT_MS, 1, allowedOrigin),
};

function normalizeWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hostnameEntityLabel(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return "";
  const lastTwo = labels.slice(-2).join(".");
  const publicSecondLevelSuffix = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const baseLabelIndex =
    labels.length >= 3 && publicSecondLevelSuffix.has(labels.at(-2) ?? "")
      ? labels.length - 3
      : labels.length - 2;
  return labels[baseLabelIndex] ?? (lastTwo ? (labels[0] ?? "") : "");
}

/** Returns an origin only for a source whose title and host identify the requested entity. */
export function entityMatchedSiteOrigin(input: {
  url: string;
  title: string;
  entities: string[];
  sourceType?: Source["sourceType"];
}): string | undefined {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throwIfResearchInactive();
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || !input.entities.length) {
    return undefined;
  }
  const entity = input.entities.find((candidate) => containsExactEntity(input.title, candidate));
  if (!entity) return undefined;
  const declaredOfficial = input.sourceType === "official";
  const hostLabel = normalizeWords(hostnameEntityLabel(url.hostname)).replace(/\s+/g, "");
  const entityLabel = normalizeWords(entity).replace(/\s+/g, "");
  if (!declaredOfficial && (!hostLabel || hostLabel !== entityLabel)) return undefined;
  return url.origin;
}

function urlOnOrigin(value: string, base: URL, origin: string): URL | undefined {
  try {
    const candidate = new URL(value, base);
    if (
      !["http:", "https:"].includes(candidate.protocol) ||
      candidate.origin !== origin ||
      candidate.username ||
      candidate.password
    ) {
      return undefined;
    }
    candidate.hash = "";
    candidate.search = "";
    candidate.pathname = candidate.pathname.replace(/\/+$/, "") || "/";
    if (ASSET_PATH.test(candidate.pathname) || EXCLUDED_PATH.test(candidate.pathname)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function isSitemapIndex(xml: string): boolean {
  return /<\s*sitemapindex\b/i.test(xml);
}

function sitemapLocations(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("loc")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(Boolean)
    .slice(0, MAX_RAW_SITE_CANDIDATES);
}

function sitemapHints(robots: string): string[] {
  return robots
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
}

function linkCandidates(input: SiteDiscoveryInput, base: URL, origin: string) {
  const $ = cheerio.load(input.rootHtml);
  const found: Array<{ url: URL; label: string; source: "navigation" }> = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href) return;
    const target = urlOnOrigin(href, base, origin);
    if (!target || target.pathname === base.pathname) return;
    const label = [$(element).text(), $(element).attr("aria-label"), $(element).attr("title")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    found.push({ url: target, label, source: "navigation" });
  });
  return found;
}

function relevanceScore(
  candidate: { url: URL; label: string },
  predicate: RequestedPredicateRequirement,
) {
  const surface = normalizeWords(`${candidate.label} ${candidate.url.pathname}`);
  if (!surface) return 0;
  const predicateTerms = [predicate.predicate, ...predicate.aliases]
    .map(normalizeWords)
    .filter((term) => term.length >= 3);
  let score = 0;
  for (const term of predicateTerms) {
    if (surface.includes(term)) score = Math.max(score, 10);
    else {
      const words = term.split(" ").filter((word) => word.length >= 3);
      if (words.length && words.some((word) => surface.split(" ").includes(word))) {
        score = Math.max(score, 7);
      }
    }
  }
  if (LEADERSHIP_SECTIONS.test(surface)) score = Math.max(score, 7);
  if (COMPANY_SECTIONS.test(surface)) score = Math.max(score, 4);
  return score;
}

async function readManifest(
  url: URL,
  origin: string,
  dependencies: SiteDiscoveryDependencies,
): Promise<string | undefined> {
  let fetched: SiteDiscoveryFetchResult | undefined;
  try {
    fetched = await dependencies.fetch(url.toString(), { method: "GET" }, 3, origin);
    if (fetched.url && new URL(fetched.url).origin !== origin) return undefined;
    if (!fetched.response.ok) return undefined;
    return await readBoundedPrefixText(
      fetched.response,
      MAX_SITE_MANIFEST_BYTES,
      config.FETCH_TIMEOUT_MS,
    );
  } catch {
    return undefined;
  } finally {
    if (fetched) {
      if (!fetched.response.bodyUsed) await fetched.response.body?.cancel().catch(() => undefined);
      await fetched.dispose().catch(() => undefined);
    }
  }
}

/**
 * Finds likely task-relevant pages from one already fetched entity-matched site page.
 * It reads at most three small same-origin sitemap/robots manifests and returns URLs only;
 * normal fetch_url actions open selected pages under the research page budget.
 */
export async function discoverInternalSiteCandidates(
  input: SiteDiscoveryInput,
  dependencies: SiteDiscoveryDependencies = defaultDependencies,
): Promise<InternalSiteCandidate[]> {
  const maxCandidates = Math.max(0, Math.min(6, Math.floor(input.maxCandidates)));
  if (!maxCandidates || !input.rootHtml.trim()) return [];
  let root: URL;
  try {
    root = new URL(input.rootUrl);
  } catch {
    return [];
  }
  if (root.protocol !== "https:" || root.username || root.password) return [];
  const origin = root.origin;
  const candidates = new Map<string, { url: URL; label: string }>();
  for (const candidate of linkCandidates(input, root, origin)) {
    candidates.set(candidate.url.toString(), candidate);
  }

  let manifestRequests = 0;
  const manifestCandidates = new Map<string, URL>();
  const robotsUrl = new URL("/robots.txt", origin);
  const robots = await readManifest(robotsUrl, origin, dependencies);
  manifestRequests += 1;
  const hinted = (robots ? sitemapHints(robots) : [])
    .map((value) => urlOnOrigin(value, robotsUrl, origin))
    .filter((url): url is URL => Boolean(url));
  if (hinted.length) {
    for (const url of hinted) manifestCandidates.set(url.toString(), url);
  } else {
    const defaultSitemap = new URL("/sitemap.xml", origin);
    manifestCandidates.set(defaultSitemap.toString(), defaultSitemap);
  }

  const sitemapQueue = [...manifestCandidates.values()].slice(0, 2);
  for (const sitemapUrl of sitemapQueue) {
    if (manifestRequests >= MAX_SITE_MANIFEST_REQUESTS) break;
    const xml = await readManifest(sitemapUrl, origin, dependencies);
    manifestRequests += 1;
    if (!xml) continue;
    const locations = sitemapLocations(xml);
    if (isSitemapIndex(xml) && manifestRequests < MAX_SITE_MANIFEST_REQUESTS) {
      const nestedMap = locations
        .map((value) => urlOnOrigin(value, sitemapUrl, origin))
        .find((url): url is URL => Boolean(url));
      if (nestedMap) {
        const nestedXml = await readManifest(nestedMap, origin, dependencies);
        manifestRequests += 1;
        if (nestedXml) locations.push(...sitemapLocations(nestedXml));
      }
    }
    for (const location of locations) {
      const url = urlOnOrigin(location, sitemapUrl, origin);
      if (!url || url.toString() === root.toString()) continue;
      if (!candidates.has(url.toString())) candidates.set(url.toString(), { url, label: "" });
      if (candidates.size >= MAX_RAW_SITE_CANDIDATES) break;
    }
  }

  const ranked = [...candidates.values()]
    .map((candidate) => ({ ...candidate, score: relevanceScore(candidate, input.predicate) }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.url.pathname.length - right.url.pathname.length,
    )
    .slice(0, maxCandidates);
  const entity = input.entity.trim();
  return ranked.map(({ url, label }, index) => ({
    url: url.toString(),
    title: `${entity} — ${label || url.pathname.split("/").filter(Boolean).at(-1) || "Company information"}`,
    snippet: `${input.rootTitle}. Same-origin site page discovered for the requested ${input.predicate.predicate} fact${label ? `; navigation label: ${label}` : ""}.`,
    provider: "site-discovery",
    siteDiscoveryOrigin: origin,
    position: index + 1,
    query: "same-origin site discovery",
    discoveredAt: new Date().toISOString(),
  }));
}
