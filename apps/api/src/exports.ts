import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import type { Readable } from "node:stream";
import type { ResearchSession, Source } from "./domain.js";
import type { ResearchPost } from "./content-domain.js";
import { projectPostForSharing, projectResearchForSharing } from "./sharing.js";

export const EXPORT_PROJECTION_SCHEMA = "max.export.v1" as const;
export const MAX_EXPORT_PROJECTION_BYTES = 512_000;
export const MAX_EXPORT_OUTPUT_BYTES = 2_000_000;
export const MAX_EXPORT_PDF_RENDER_MS = 5_000;
export const MAX_EXPORT_PDF_PAGES = 80;
export const MAX_EXPORT_ATTEMPTS = 3;

export type ExportFormat = "markdown" | "json" | "pdf";
export type ExportResourceType = "research_session" | "published_post";
export type ExportStatus = "pending" | "completed" | "failed";

export interface ExportSource {
  citation: number;
  title: string;
  url: string;
  publishedAt?: string;
  sourceType?: Source["sourceType"];
}

export interface ExportClaim {
  statement: string;
  citations: number[];
  verification: "supported" | "contradicted" | "uncertain" | "unavailable";
}

export interface ResearchExportProjection {
  schema: typeof EXPORT_PROJECTION_SCHEMA;
  resourceType: "research_session";
  title: string;
  createdAt: string;
  answer: string;
  claims: ExportClaim[];
  sources: ExportSource[];
}

export interface PublishedPostExportProjection {
  schema: typeof EXPORT_PROJECTION_SCHEMA;
  resourceType: "published_post";
  title: string;
  summary: string;
  whyItMatters: string;
  findings: Array<{ statement: string; citations: number[] }>;
  caveats: string[];
  category: string;
  publishedAt: string;
  researchedAt: string;
  sources: ExportSource[];
}

export type ExportProjection = ResearchExportProjection | PublishedPostExportProjection;

export interface ExportProjectionInput {
  resourceType: ExportResourceType;
  session?: ResearchSession;
  post?: ResearchPost;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "auth",
  "signature",
  "sig",
  "credential",
  "code",
]);

function containsCredentialLikeText(value: string): boolean {
  return (
    /\b(?:password|passphrase|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret|private[\s_-]*key|recovery[\s_-]*code)\s*(?:is|:|=)\s*\S+/i.test(
      value,
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(value) ||
    /\b(?:sk-or-v1-[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,})\b/i.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value)
  );
}

function containsSensitiveSourceUrl(urlText: string): boolean {
  if (containsCredentialLikeText(urlText)) return true;
  try {
    const url = new URL(urlText);
    return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()));
  } catch {
    return true;
  }
}

export function createExportProjection(input: ExportProjectionInput): ExportProjection | undefined {
  if (input.resourceType === "research_session") {
    const session = input.session;
    const shared = session && projectResearchForSharing(session);
    if (!session || !shared || shared.type !== "research") return undefined;
    if (
      containsCredentialLikeText(shared.question) ||
      containsCredentialLikeText(shared.answer) ||
      session.claims.some((claim) => containsCredentialLikeText(claim.text)) ||
      shared.sources.some(
        (source) =>
          containsCredentialLikeText(source.title) || containsSensitiveSourceUrl(source.url),
      )
    ) {
      return undefined;
    }

    const citationBySourceId = new Map(
      session.sources.map((source, index) => [source.id, index + 1]),
    );
    const safeCitations = new Set(shared.sources.map((source) => source.citation));
    const claims: ExportClaim[] = [];
    for (const claim of session.claims) {
      const citations = claim.sourceIds.map((sourceId) => citationBySourceId.get(sourceId));
      if (citations.some((citation) => citation === undefined || !safeCitations.has(citation))) {
        return undefined;
      }
      claims.push({
        statement: claim.text.slice(0, 10_000),
        citations: citations as number[],
        verification: claim.verification?.verdict ?? "unavailable",
      });
    }

    return enforceProjectionSize({
      schema: EXPORT_PROJECTION_SCHEMA,
      resourceType: "research_session",
      title: shared.question,
      createdAt: shared.createdAt,
      answer: shared.answer,
      claims,
      sources: shared.sources,
    });
  }

  const post = input.post;
  const session = input.session;
  const shared = post && projectPostForSharing(post);
  if (
    !post ||
    !session ||
    session.id !== post.researchId ||
    session.status !== "COMPLETED" ||
    !shared ||
    shared.type !== "post"
  ) {
    return undefined;
  }
  if (
    [shared.title, shared.summary, shared.whyItMatters, ...shared.caveats].some(
      containsCredentialLikeText,
    ) ||
    shared.findings.some((finding) => containsCredentialLikeText(finding.text)) ||
    shared.sources.some(
      (source) =>
        containsCredentialLikeText(source.title) || containsSensitiveSourceUrl(source.url),
    )
  ) {
    return undefined;
  }

  return enforceProjectionSize({
    schema: EXPORT_PROJECTION_SCHEMA,
    resourceType: "published_post",
    title: shared.title,
    summary: shared.summary,
    whyItMatters: shared.whyItMatters,
    findings: shared.findings.map((finding) => ({
      statement: finding.text,
      citations: finding.citations,
    })),
    caveats: shared.caveats,
    category: shared.category,
    publishedAt: shared.publishedAt,
    researchedAt: shared.researchedAt,
    sources: shared.sources,
  });
}

function enforceProjectionSize<T extends ExportProjection>(projection: T): T | undefined {
  return Buffer.byteLength(JSON.stringify(projection), "utf8") <= MAX_EXPORT_PROJECTION_BYTES
    ? projection
    : undefined;
}

export function serializeExportProjection(projection: ExportProjection): string {
  return JSON.stringify(projection, null, 2) + "\n";
}

export function hashExportProjection(projection: ExportProjection): string {
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
}

function escapeHeading(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function safeMarkdownBody(value: string): string {
  return value
    .replace(/^\s{0,3}\[[^\]\r\n]+\]:\s*\S+.*$/gm, "")
    .replace(/!?\[([^\]\r\n]{0,1000})\]\([^\r\n)]{0,4000}\)/g, "$1")
    .replace(/<[^>\r\n]{0,4000}>/g, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/https?:\/\//gi, (scheme) => scheme.replace(":", "&#58;"));
}

function sourceMarkdown(sources: ExportSource[]): string[] {
  return sources.map((source) => {
    const date = source.publishedAt ? ` — ${source.publishedAt}` : "";
    const kind = source.sourceType ? ` (${source.sourceType})` : "";
    return `[${source.citation}] ${escapeHeading(source.title)}${kind}${date}\n\n${source.url}`;
  });
}

function citationLabel(citations: number[]): string {
  return citations.map((citation) => `[${citation}]`).join(", ");
}

export function renderExportMarkdown(projection: ExportProjection): string {
  const sections = [`# ${escapeHeading(projection.title)}`];
  if (projection.resourceType === "research_session") {
    sections.push(
      `Created: ${projection.createdAt}`,
      "## Answer",
      safeMarkdownBody(projection.answer),
    );
    if (projection.claims.length) {
      sections.push(
        "## Evidence-linked claims",
        ...projection.claims.map(
          (claim) =>
            `- ${safeMarkdownBody(claim.statement)}${claim.citations.length ? ` ${citationLabel(claim.citations)}` : ""} — ${claim.verification}`,
        ),
      );
    }
  } else {
    sections.push(
      `Category: ${escapeHeading(projection.category)}`,
      `Published: ${projection.publishedAt}`,
      `Researched: ${projection.researchedAt}`,
      "## Summary",
      safeMarkdownBody(projection.summary),
      "## Why it matters",
      safeMarkdownBody(projection.whyItMatters),
      "## Findings",
      ...projection.findings.map(
        (finding) =>
          `- ${safeMarkdownBody(finding.statement)}${finding.citations.length ? ` ${citationLabel(finding.citations)}` : ""}`,
      ),
      ...(projection.caveats.length
        ? ["## Caveats", ...projection.caveats.map((caveat) => `- ${safeMarkdownBody(caveat)}`)]
        : []),
    );
  }
  if (projection.sources.length) {
    sections.push(
      "## Sources",
      ...sourceMarkdown(projection.sources).map((source) => `- ${source}`),
    );
  }
  return `${sections.join("\n\n").trim()}\n`;
}

function markdownToPdfText(value: string): string {
  return safeMarkdownBody(value)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export async function collectBoundedPdfStream(
  stream: Readable,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? MAX_EXPORT_PDF_RENDER_MS;
  const maxBytes = options.maxBytes ?? MAX_EXPORT_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve(result ?? Buffer.concat(chunks, totalBytes));
      }
    };
    const onData = (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        finish(new Error("PDF export exceeded the output size limit"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, totalBytes));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("PDF export exceeded the render time limit")),
      timeoutMs,
    );
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function projectionMarkdown(projection: ExportProjection): string {
  return renderExportMarkdown(projection);
}

export async function renderExportPdf(projection: ExportProjection): Promise<Buffer> {
  const markdown = projectionMarkdown(projection);
  const trustedSourceUrls = new Set(projection.sources.map((source) => source.url));
  if (Buffer.byteLength(markdown, "utf8") > MAX_EXPORT_PROJECTION_BYTES) {
    throw new Error("Export document exceeds the PDF input size limit");
  }
  const stableDate = new Date(
    projection.resourceType === "research_session" ? projection.createdAt : projection.publishedAt,
  );
  if (!Number.isFinite(stableDate.getTime())) throw new Error("Export timestamp is invalid");

  const document = new PDFDocument({
    size: "A4",
    margin: 54,
    lang: "en-US",
    info: {
      Title: projection.title.slice(0, 250),
      Author: "Research Agent MAX",
      Creator: "Research Agent MAX Exports v1",
      Producer: "Research Agent MAX Exports v1",
      CreationDate: stableDate,
      ModDate: stableDate,
    },
  });
  let pages = 1;
  document.on("pageAdded", () => {
    pages += 1;
    if (pages > MAX_EXPORT_PDF_PAGES) {
      document.destroy(new Error("PDF export exceeded the page limit"));
    }
  });

  const output = collectBoundedPdfStream(document, {
    timeoutMs: MAX_EXPORT_PDF_RENDER_MS,
    maxBytes: MAX_EXPORT_OUTPUT_BYTES,
  });
  document.font("Helvetica-Bold").fontSize(19).text(projection.title.slice(0, 500));
  document.moveDown(0.5);
  document.font("Helvetica").fontSize(9).fillColor("#475569");
  if (projection.resourceType === "research_session") {
    document.text(`Research result · ${projection.createdAt}`);
  } else {
    document.text(
      `${projection.category} · Published ${projection.publishedAt} · Researched ${projection.researchedAt}`,
    );
  }
  document.moveDown(1);
  document.fillColor("#111827");

  let inSourcesSection = false;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      document.moveDown(0.35);
      continue;
    }
    const heading = /^(#{1,3})\s+/.exec(trimmed);
    if (heading) {
      inSourcesSection = trimmed.toLowerCase() === "## sources";
      document.moveDown(0.35);
      document.font("Helvetica-Bold").fontSize(heading[1]!.length === 1 ? 15 : 12);
      document.text(markdownToPdfText(trimmed.replace(/^#{1,3}\s+/, "")), { paragraphGap: 3 });
      document.font("Helvetica").fontSize(10);
      continue;
    }
    document.font("Helvetica").fontSize(10);
    const text =
      inSourcesSection && trustedSourceUrls.has(trimmed) ? trimmed : markdownToPdfText(trimmed);
    document.text(text, { lineGap: 2 });
  }
  document.end();
  return output;
}

export function exportMimeType(format: ExportFormat): string {
  if (format === "markdown") return "text/markdown; charset=utf-8";
  if (format === "json") return "application/json; charset=utf-8";
  return "application/pdf";
}

export function exportExtension(format: ExportFormat): string {
  if (format === "markdown") return "md";
  return format;
}

export function sanitizeExportFileName(title: string, format: ExportFormat): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/[. ]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 72)
    .replace(/[. -]+$/g, "");
  return `${stem || "research-export"}.${exportExtension(format)}`;
}

export function renderExportBytes(
  projection: ExportProjection,
  format: ExportFormat,
  pdfRenderer: (projection: ExportProjection) => Promise<Buffer> = renderExportPdf,
): Promise<Buffer> | Buffer {
  if (format === "markdown") return Buffer.from(renderExportMarkdown(projection), "utf8");
  if (format === "json") return Buffer.from(serializeExportProjection(projection), "utf8");
  return pdfRenderer(projection);
}
