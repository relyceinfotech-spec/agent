import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { config } from "./config.js";
import type { TopicCandidate } from "./content-domain.js";
import type { ContentStore } from "./store.js";
import { canonicalizeUrl, readBoundedText, safeFetchWithRetry } from "./security.js";
import type { SearchAttempt, SearchProvider } from "./search.js";

export interface FeedEntry {
  title: string;
  url: string;
  summary: string;
  publishedAt?: string;
  provider: string;
}

export interface TopicDiscoveryResult {
  candidates: TopicCandidate[];
  failures: Array<{ feed: string; error: string }>;
  searchAttempts: SearchAttempt[];
  successfulFeeds: number;
  successfulSearches: number;
}

export function parseTopicFeed(xml: string, feedUrl: string): FeedEntry[] {
  const $ = load(xml, { xmlMode: true });
  return $("item,entry")
    .slice(0, 40)
    .toArray()
    .flatMap((item) => {
      const title = $(item).find("title").first().text().replace(/\s+/g, " ").trim();
      const link = $(item).find("link").first();
      const rawUrl = link.attr("href") || link.text().trim();
      if (!title || !rawUrl) return [];
      try {
        const url = canonicalizeUrl(new URL(rawUrl, feedUrl).toString());
        const description = $(item)
          .find("description,summary,content\\:encoded,content")
          .first()
          .text();
        const summary = load(description).text().replace(/\s+/g, " ").trim().slice(0, 600);
        const rawDate = $(item).find("pubDate,published,updated,dc\\:date").first().text();
        const publishedAt =
          rawDate && !Number.isNaN(Date.parse(rawDate))
            ? new Date(rawDate).toISOString()
            : undefined;
        return [{ title, url, summary, publishedAt, provider: feedUrl }];
      } catch {
        return [];
      }
    });
}

export async function fetchTopicFeed(feedUrl: string): Promise<FeedEntry[]> {
  const { response, dispose } = await safeFetchWithRetry(
    feedUrl,
    {
      headers: { accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" },
    },
    2,
    config.FETCH_TIMEOUT_MS,
  );
  try {
    if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
    const xml = await readBoundedText(response, 1_000_000, config.FETCH_TIMEOUT_MS);
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("Feed response is not RSS or Atom");
    return parseTopicFeed(xml, feedUrl);
  } finally {
    await dispose();
  }
}

function titleSimilarity(a: string, b: string): number {
  const terms = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const left = terms(a);
  const right = terms(b);
  if (!left.size || !right.size) return 0;
  return [...left].filter((word) => right.has(word)).length / new Set([...left, ...right]).size;
}

function topicScore(entry: FeedEntry, now: number): number {
  if (!entry.publishedAt) return 0.35;
  const ageDays = Math.max(0, (now - Date.parse(entry.publishedAt)) / 86_400_000);
  if (ageDays > config.MAX_TOPIC_MAX_AGE_DAYS) return 0;
  const freshness = 1 - ageDays / config.MAX_TOPIC_MAX_AGE_DAYS;
  const substance = Math.min(1, entry.summary.length / 180);
  const specificity = Math.min(1, entry.title.length / 50);
  const promotional = /sponsored|advertisement|giveaway|sale|coupon/i.test(entry.title) ? 0.5 : 0;
  return Math.max(
    0,
    Math.min(1, 0.45 * freshness + 0.3 * substance + 0.25 * specificity - promotional),
  );
}

export async function discoverTopics(
  store: ContentStore,
  feedUrls = config.MAX_TOPIC_FEEDS.split(",")
    .map((feed) => feed.trim())
    .filter(Boolean),
  fetcher: (url: string) => Promise<FeedEntry[]> = fetchTopicFeed,
  fallbackSearch?: SearchProvider,
): Promise<TopicDiscoveryResult> {
  const settled = await Promise.allSettled(feedUrls.map((feed) => fetcher(feed)));
  const failures: TopicDiscoveryResult["failures"] = [];
  const entries: FeedEntry[] = [];
  let successfulFeeds = 0;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successfulFeeds += 1;
      entries.push(...result.value);
    } else {
      failures.push({
        feed: feedUrls[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  const searchAttempts: SearchAttempt[] = [];
  let successfulSearches = 0;
  const existingPosts = await store.listPosts(100);
  const existingTopics = await store.listTopics(200);
  const seen = new Set<string>();
  const now = Date.now();
  const candidates: TopicCandidate[] = [];
  const collectCandidates = async (items: FeedEntry[]) => {
    for (const entry of items) {
      const url = canonicalizeUrl(entry.url);
      if (seen.has(url) || (await store.getTopicByUrl(url))) continue;
      seen.add(url);
      if (existingPosts.some((post) => titleSimilarity(post.title, entry.title) >= 0.72)) continue;
      if (existingTopics.some((topic) => titleSimilarity(topic.title, entry.title) >= 0.82))
        continue;
      if (candidates.some((candidate) => titleSimilarity(candidate.title, entry.title) >= 0.82))
        continue;
      const score = topicScore(entry, now);
      if (score < 0.5) continue;
      candidates.push({
        id: randomUUID(),
        title: entry.title,
        url,
        summary: entry.summary,
        publishedAt: entry.publishedAt,
        provider: entry.provider,
        discoveredAt: new Date(now).toISOString(),
        score,
        status: "CANDIDATE",
      });
    }
  };
  await collectCandidates(entries);

  // A feed can succeed while yielding only stale, duplicate, or low-value entries.
  // Try the independent discovery route when it produced no usable candidate.
  if (candidates.length === 0 && fallbackSearch) {
    const domains = config.MAX_TOPIC_ALLOWED_DOMAINS.split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
      .slice(0, 4);
    const year = new Date().getUTCFullYear();
    for (const domain of domains) {
      const query = `site:${domain} new release research announcement ${year}`;
      try {
        const batch = fallbackSearch.searchDetailed
          ? await fallbackSearch.searchDetailed(query)
          : { results: await fallbackSearch.search(query), attempts: [] };
        searchAttempts.push(...batch.attempts);
        if (
          batch.attempts.length === 0 ||
          batch.attempts.some((attempt) => attempt.status !== "failed")
        ) {
          successfulSearches += 1;
        }
        const fallbackEntries = batch.results
          .filter((result) => {
            try {
              const hostname = new URL(result.url).hostname;
              return (
                (hostname === domain || hostname.endsWith(`.${domain}`)) &&
                /release|research|announc|shipped|introduc|launch|update/i.test(result.title) &&
                Boolean(result.publishedAt)
              );
            } catch {
              return false;
            }
          })
          .map((result) => ({
            title: result.title,
            url: result.url,
            summary: result.snippet,
            publishedAt: result.publishedAt,
            provider: result.provider ?? "search-fallback",
          }));
        await collectCandidates(fallbackEntries);
      } catch (error) {
        failures.push({
          feed: `search:${domain}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (candidates.length > 0) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates.slice(0, 20)) await store.saveTopic(candidate);
  return {
    candidates: candidates.slice(0, 20),
    failures,
    searchAttempts,
    successfulFeeds,
    successfulSearches,
  };
}
