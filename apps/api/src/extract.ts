import * as cheerio from "cheerio";

export interface ExtractedDocument {
  title: string;
  description: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  domain: string;
  language?: string;
  content: string;
  headings: string[];
}

export function extractHtml(html: string, url: URL): ExtractedDocument {
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer,header,aside,form,iframe,svg").remove();
  const title = $("meta[property='og:title']").attr("content") ?? $("title").text().trim();
  const description =
    $("meta[name='description'],meta[property='og:description']").first().attr("content") ?? "";
  const author = $("meta[name='author'],meta[property='article:author']").first().attr("content");
  const publishedAt =
    $("meta[property='article:published_time'],time[datetime]").first().attr("content") ??
    $("time[datetime]").first().attr("datetime");
  const canonicalUrl = $("link[rel='canonical']").attr("href");
  const headings = $("h1,h2,h3")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .slice(0, 50);
  const content = $("article").text() || $("main").text() || $("body").text();
  return {
    title: title.replace(/\s+/g, " ").trim(),
    description: description.trim(),
    author,
    publishedAt,
    canonicalUrl,
    domain: url.hostname,
    language: $("html").attr("lang"),
    content: content.replace(/\s+/g, " ").trim(),
    headings,
  };
}
