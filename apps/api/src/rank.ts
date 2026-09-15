import type { SearchResult, Source } from "./domain.js";
import { createHash } from "node:crypto";
import { canonicalizeUrl } from "./security.js";

const authoritative = new Set([".gov", ".edu", "who.int", "w3.org", "ietf.org", "github.com"]);
function sourceType(domain: string, title: string): Source["sourceType"] {
  const value = `${domain} ${title}`.toLowerCase();
  if (domain.endsWith(".gov") || domain.includes("who.int")) return "government";
  if (domain.endsWith(".edu") || value.includes("journal") || value.includes("paper"))
    return "academic";
  if (value.includes("documentation") || value.includes("docs")) return "documentation";
  if (value.includes("news")) return "news";
  if (value.includes("blog")) return "blog";
  return "unknown";
}
export function rankResults(question: string, results: SearchResult[]): Source[] {
  const terms = new Set(
    question
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 3),
  );
  const seen = new Set<string>();
  return results
    .flatMap((item, index) => {
      const normalizedUrl = canonicalizeUrl(item.url);
      if (seen.has(normalizedUrl)) return [];
      seen.add(normalizedUrl);
      const domain = new URL(normalizedUrl).hostname.replace(/^www\./, "");
      const relevance = Math.min(
        1,
        [...terms].filter((term) => `${item.title} ${item.snippet}`.toLowerCase().includes(term))
          .length /
          Math.max(1, Math.min(terms.size, 6)) +
          0.15,
      );
      const type = sourceType(domain, item.title);
      const authority =
        type === "government" ||
        type === "academic" ||
        type === "documentation" ||
        [...authoritative].some((token) => domain.endsWith(token) || domain.includes(token))
          ? 0.95
          : 0.55;
      const freshness = item.publishedAt ? 0.9 : 0.55;
      const completeness = Math.min(1, item.snippet.length / 500 + 0.35);
      const overall = Number(
        (relevance * 0.45 + authority * 0.25 + freshness * 0.15 + completeness * 0.15).toFixed(3),
      );
      return [
        {
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
            overall,
          },
        },
      ];
    })
    .sort((a, b) => b.quality.overall - a.quality.overall);
}
