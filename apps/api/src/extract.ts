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
  contentType?: "html" | "rss" | "pdf" | "structured";
  contentOrigin?: "metadata";
}

export function extractRetrievedDocument(
  raw: string,
  url: URL,
  contentType: string,
  sourceUrl?: string,
): ExtractedDocument {
  // The npm registry serves package metadata as text/plain on some paths.
  // Treat that specific JSON payload as structured evidence rather than HTML.
  if (
    /application\/json/i.test(contentType) ||
    (url.hostname === "registry.npmjs.org" && /^\s*\{/.test(raw))
  ) {
    return extractStructuredJson(raw, url);
  }
  if (/(?:rss|atom)\+xml|(?:text|application)\/xml/i.test(contentType)) {
    return extractFeed(raw, url, sourceUrl);
  }
  return extractHtml(raw, url);
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
  const paragraphSelector = "p,h1,h2,h3,h4,h5,h6,blockquote,li,table";
  const paragraphsIn = (element: typeof $ extends (input: infer T) => unknown ? T : never) =>
    $(element)
      .find(paragraphSelector)
      .toArray()
      .filter((paragraph) => !$(paragraph).parents("table").length)
      .flatMap((paragraph) => {
        const tag = paragraph.tagName.toLowerCase();
        const text = $(paragraph).text().replace(/\s+/g, " ").trim();
        if (/^h[1-6]$/.test(tag))
          return text && text.length <= 300 ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
        if (tag === "table") {
          const rows = $(paragraph).find("tr").toArray();
          const header = rows[0];
          if (!header || !$(header).children("th").length) return [];
          if ($(paragraph).find('[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"])').length)
            return [];
          const headers = $(header)
            .children("th,td")
            .toArray()
            .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
          if (headers.length < 2 || headers.some((label) => !label)) return [];
          return rows.slice(1).flatMap((row) => {
            const cells = $(row)
              .children("th,td")
              .toArray()
              .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
            if (cells.length !== headers.length || cells.some((cell) => !cell)) return [];
            const record = `Table row: ${headers.map((label, index) => `${label}: ${cells[index]}`).join("; ")}`;
            return record.length <= 3000 ? [record] : [];
          });
        }
        // Leaf list items retain their own text without duplicating nested lists
        // or a paragraph that is separately selected from the same item.
        if (tag === "li" && $(paragraph).find("li,p").length) return [];
        return text.length >= 30 && text.length <= 3000 ? [tag === "li" ? `- ${text}` : text] : [];
      });
  const contentScore = (element: typeof $ extends (input: infer T) => unknown ? T : never) =>
    paragraphsIn(element).reduce((total, paragraph) => total + paragraph.length, 0);
  const explicitRoots = $(
    "[itemprop='articleBody'],.post__content,.entry-content,.article-content,[class*='article-body']",
  )
    .toArray()
    .sort((first, second) => contentScore(second) - contentScore(first));
  const articleRoots = $("article")
    .toArray()
    .sort((first, second) => contentScore(second) - contentScore(first));
  const mainRoot = $("main,[role='main']").first().get(0);
  const bodyRoot = $("body").first().get(0);
  const explicitRoot = explicitRoots.find((element) => contentScore(element) >= 120);
  const articleRoot = articleRoots.find((element) => contentScore(element) >= 120);
  const root = explicitRoot ?? articleRoot ?? mainRoot ?? bodyRoot;
  const paragraphs = root ? paragraphsIn(root) : [];
  // Identical findings may belong to different sections; global deduplication
  // would discard the second section's source context.
  const distinctParagraphs = paragraphs;
  const content =
    distinctParagraphs.join("\n\n").length >= 120
      ? distinctParagraphs.join("\n\n")
      : root
        ? $(root).text()
        : "";
  return {
    title: title.replace(/\s+/g, " ").trim(),
    description: description.trim(),
    author,
    publishedAt,
    canonicalUrl,
    domain: url.hostname,
    language: $("html").attr("lang"),
    content: content
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    headings,
    contentType: "html",
  };
}

export function extractFeed(xml: string, url: URL, sourceUrl?: string): ExtractedDocument {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries = $("item,entry").slice(0, 30).toArray();
  const normalizePublishedDate = (value: string): string => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value.replace(/\s+/g, " ").trim();
    return new Date(timestamp).toISOString().slice(0, 10);
  };
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"])
        parsed.searchParams.delete(key);
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return value;
    }
  };
  const matchingEntries = sourceUrl
    ? entries.filter((entry) => {
        const item = $(entry);
        const link = item.find("link").first();
        const href =
          link.attr("href") || link.text().trim() || item.find("id").first().text().trim();
        return href && normalize(new URL(href, url).toString()) === normalize(sourceUrl);
      })
    : entries;
  const selectedEntries = sourceUrl ? matchingEntries : entries;
  const content = selectedEntries
    .map((entry) => {
      const item = $(entry);
      const title = item.find("title").first().text().trim();
      const description = $(entry).find("description,summary,content").first().text().trim();
      const published = item.find("pubDate,published,updated,date").first().text().trim();
      const categories = item
        .find("category")
        .map((_, category) => $(category).attr("term") ?? $(category).text().trim())
        .get()
        .filter(Boolean);
      const status = item.find("prerelease,draft,release-status,status").first().text().trim();
      return [
        title,
        published ? `published: ${normalizePublishedDate(published)}` : "",
        status ? `status: ${status}` : "",
        categories.length ? `categories: ${categories.join(", ")}` : "",
        description,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title:
      sourceUrl && selectedEntries.length > 0
        ? $(selectedEntries[0]).find("title").first().text().trim()
        : $("channel > title,feed > title").first().text().trim(),
    description: $("channel > description,feed > subtitle").first().text().trim(),
    author:
      selectedEntries.length > 0
        ? $(selectedEntries[0])
            .find("author name,author,email,dc\\:creator")
            .first()
            .text()
            .trim() || undefined
        : undefined,
    publishedAt:
      selectedEntries.length > 0
        ? $(selectedEntries[0]).find("pubDate,published,updated,date").first().text().trim() ||
          undefined
        : undefined,
    canonicalUrl:
      selectedEntries.length > 0
        ? (() => {
            const entry = $(selectedEntries[0]);
            const link = entry.find("link").first();
            const href = link.attr("href") ?? link.text().trim();
            return href ? new URL(href, url).toString() : undefined;
          })()
        : undefined,
    domain: url.hostname,
    content,
    headings: selectedEntries
      .map((entry) => $(entry).find("title").first().text().trim())
      .filter(Boolean),
    contentType: "rss",
  };
}

export function extractStructuredJson(raw: string, url: URL): ExtractedDocument {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Structured source is not a supported JSON object");
  }
  const record = data as Record<string, unknown>;
  const field = (name: string) =>
    typeof record[name] === "string"
      ? (record[name] as string).replace(/\s+/g, " ").trim().slice(0, 1000)
      : undefined;
  const name = field("name") ?? field("full_name") ?? url.hostname;
  const version = field("version") ?? field("tag_name");
  const description = field("description") ?? field("body") ?? "";
  const publishedAt = field("published_at") ?? field("created_at");
  const content = [
    `Source: ${name}.`,
    version ? `Published version or release tag: ${version}.` : "",
    description ? `Description: ${description}.` : "",
    publishedAt ? `Publication timestamp: ${publishedAt}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    title: `${name}${version ? ` ${version}` : ""}`,
    description,
    publishedAt,
    domain: url.hostname,
    content,
    headings: [],
    contentType: "structured",
  };
}

export function validateExtraction(document: ExtractedDocument): void {
  const content = document.content.trim();
  if (content.length < (document.contentType === "structured" ? 40 : 120)) {
    throw new Error("Extracted content is too short to use as evidence");
  }
  const rejection = [
    /verify you are human/i,
    /attention required.{0,80}cloudflare/i,
    /enable javascript to continue/i,
    /sign in to continue/i,
    /access denied/i,
    /captcha/i,
  ].find((pattern) => pattern.test(content.slice(0, 1500)));
  if (rejection) throw new Error("Retrieved page is a challenge, login, or access-denied page");
}
