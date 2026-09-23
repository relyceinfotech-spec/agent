import type { SearchResult, Source } from "./domain.js";
import { createHash } from "node:crypto";
import { canonicalizeUrl } from "./security.js";

const authoritativeTokens = [
  ".gov",
  ".edu",
  "who.int",
  "w3.org",
  "ietf.org",
  "github.com",
  "developer.mozilla.org",
  "react.dev",
  "nodejs.org",
  "python.org",
  "rust-lang.org",
  "golang.org",
  "arxiv.org",
];

function detectSourceType(domain: string, title: string, url: string): Source["sourceType"] {
  const value = `${domain} ${title} ${url}`.toLowerCase();
  if (domain.endsWith(".gov") || domain.includes("who.int") || domain.includes(".gov.")) {
    return "government";
  }
  if (domain.endsWith(".edu") || domain.includes("arxiv.org") || value.includes("journal") || value.includes("research paper")) {
    return "academic";
  }
  if (
    domain.startsWith("docs.") ||
    domain.includes("documentation") ||
    value.includes("docs.") ||
    value.includes("/docs/") ||
    value.includes("documentation") ||
    value.includes("official documentation") ||
    value.includes("api reference") ||
    value.includes("release notes")
  ) {
    return "documentation";
  }
  if (value.includes("official") || authoritativeTokens.some((token) => domain.includes(token))) {
    return "official";
  }
  if (
    domain.includes("news") ||
    value.includes("reuters") ||
    value.includes("techcrunch") ||
    value.includes("theverge") ||
    value.includes("bloomberg") ||
    value.includes("wired")
  ) {
    return "news";
  }
  if (
    domain.includes("reddit.com") ||
    domain.includes("stackoverflow.com") ||
    domain.includes("ycombinator.com") ||
    domain.includes("discourse") ||
    value.includes("community forum")
  ) {
    return "forum";
  }
  if (domain.includes("medium.com") || domain.includes("dev.to") || domain.includes("substack.com") || value.includes("blog")) {
    return "blog";
  }
  return "unknown";
}

export function rankResults(question: string, results: SearchResult[]): Source[] {
  const terms = new Set(
    question
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 3),
  );

  const seenUrls = new Set<string>();
  const initialSources: Source[] = [];

  for (const item of results) {
    const normalizedUrl = canonicalizeUrl(item.url);
    if (seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    let domain = "unknown";
    try {
      domain = new URL(normalizedUrl).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }

    const type = detectSourceType(domain, item.title, normalizedUrl);

    // Calculate lexical relevance based on query terms
    const textBlob = `${item.title} ${item.snippet}`.toLowerCase();
    const matchedTerms = [...terms].filter((term) => textBlob.includes(term)).length;
    const termRatio = matchedTerms / Math.max(1, Math.min(terms.size, 6));
    const relevance = Math.min(1, termRatio + 0.15);

    // Authority rating
    let authority = 0.55;
    if (
      type === "government" ||
      type === "academic" ||
      type === "documentation" ||
      type === "official" ||
      authoritativeTokens.some((token) => domain.endsWith(token) || domain.includes(token))
    ) {
      authority = 0.95;
    } else if (type === "news") {
      authority = 0.75;
    }

    const freshness = item.publishedAt ? 0.9 : 0.55;
    const completeness = Math.min(1, item.snippet.length / 500 + 0.35);

    const baseScore = relevance * 0.45 + authority * 0.25 + freshness * 0.15 + completeness * 0.15;

    initialSources.push({
      ...item,
      url: normalizedUrl,
      id: createHash("sha1").update(normalizedUrl).digest("hex").slice(0, 16),
      domain,
      sourceType: type,
      quality: {
        relevance: Number(relevance.toFixed(3)),
        authority,
        freshness,
        completeness: Number(completeness.toFixed(3)),
        overall: Number(baseScore.toFixed(3)),
      },
    });
  }

  // Sort by base quality first
  initialSources.sort((a, b) => b.quality.overall - a.quality.overall);

  // Apply Domain Diversity & Anti-Echo-Chamber Penalization:
  // Prevent 10 results from the same domain from monopolizing research
  const domainOccurrences = new Map<string, number>();
  const diverseRanked: Source[] = [];

  for (const source of initialSources) {
    const currentCount = domainOccurrences.get(source.domain) ?? 0;
    domainOccurrences.set(source.domain, currentCount + 1);

    // Progressive penalty for duplicate domain representation
    let diversityMultiplier = 1.0;
    if (currentCount === 1) {
      diversityMultiplier = 0.88; // 2nd occurrence from same domain
    } else if (currentCount >= 2) {
      diversityMultiplier = 0.65; // 3rd+ occurrence heavily penalized to favor distinct domains
    }

    const adjustedOverall = Number((source.quality.overall * diversityMultiplier).toFixed(3));

    diverseRanked.push({
      ...source,
      quality: {
        ...source.quality,
        overall: adjustedOverall,
      },
    });
  }

  // Final re-sort with diversity adjustments
  return diverseRanked.sort((a, b) => b.quality.overall - a.quality.overall);
}
