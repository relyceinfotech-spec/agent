import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import type { ResearchSession, Source } from "./domain.js";
import type { ResearchPost } from "./content-domain.js";
import { privateIp } from "./security.js";

const SHARE_TOKEN_BYTES = 32;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SENSITIVE_SOURCE_QUERY_KEYS = new Set([
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
  "awsaccesskeyid",
  "googleaccessid",
  "x-amz-algorithm",
  "x-amz-content-sha256",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-security-token",
  "x-amz-signature",
  "x-amz-signedheaders",
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signature",
  "x-goog-signedheaders",
  "q-ak",
  "q-key-time",
  "q-sign-algorithm",
  "q-sign-time",
  "q-signature",
  "x-cos-security-token",
]);

export interface SharedSource {
  citation: number;
  title: string;
  url: string;
  publishedAt?: string;
  sourceType?: Source["sourceType"];
}

export type SharedResource =
  | {
      type: "research";
      question: string;
      answer: string;
      createdAt: string;
      sources: SharedSource[];
    }
  | {
      type: "post";
      title: string;
      summary: string;
      whyItMatters: string;
      findings: Array<{ text: string; citations: number[] }>;
      caveats: string[];
      publishedAt: string;
      researchedAt: string;
      category: string;
      sources: SharedSource[];
    };

export interface PublicPostProjection {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  findings: Array<{ text: string; citations: number[] }>;
  caveats: string[];
  publishedAt: string;
  researchedAt: string;
  category: string;
  sources: SharedSource[];
}

export function createShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export function isShareToken(value: string): boolean {
  return SHARE_TOKEN_PATTERN.test(value);
}

export function hashShareToken(token: string): string {
  if (!isShareToken(token)) throw new Error("Invalid share token format");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const ipHostname =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      hostname.length > 0 &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal") &&
      !hostname.endsWith(".lan") &&
      !hostname.endsWith(".home.arpa") &&
      !hostname.endsWith(".onion") &&
      ![...url.searchParams.keys()].some(isSensitiveSourceQueryKey) &&
      (!net.isIP(ipHostname) || !privateIp(ipHostname))
    );
  } catch {
    return false;
  }
}

function isSensitiveSourceQueryKey(key: string): boolean {
  return SENSITIVE_SOURCE_QUERY_KEYS.has(key.trim().toLowerCase());
}

function projectSources(sources: Source[]): {
  sources: SharedSource[];
  safeCitationNumbers: Set<number>;
} {
  const safeCitationNumbers = new Set<number>();
  const projected = sources.flatMap((source, index) => {
    if (!isPublicHttpUrl(source.url)) return [];
    safeCitationNumbers.add(index + 1);
    return [
      {
        citation: index + 1,
        title: source.title.slice(0, 500),
        url: source.url,
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        ...(source.sourceType ? { sourceType: source.sourceType } : {}),
      },
    ];
  });
  return { sources: projected, safeCitationNumbers };
}

export function projectResearchForSharing(session: ResearchSession): SharedResource | undefined {
  if (session.status !== "COMPLETED" || !session.answer?.trim()) return undefined;
  const projectedSources = projectSources(session.sources);
  const citedNumbers = [...session.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (
    citedNumbers.some(
      (number) =>
        !Number.isInteger(number) ||
        number < 1 ||
        number > session.sources.length ||
        !projectedSources.safeCitationNumbers.has(number),
    )
  ) {
    return undefined;
  }
  return {
    type: "research",
    question: session.question.slice(0, 4000),
    answer: session.answer.slice(0, 100_000),
    createdAt: session.createdAt,
    sources: projectedSources.sources,
  };
}

export function projectPostForSharing(post: ResearchPost): SharedResource | undefined {
  if (!post.publishedAt || !post.title.trim()) return undefined;
  const projectedSources = projectSources(post.sources);
  const citationsById = new Map(post.sources.map((source, index) => [source.id, index + 1]));
  if (
    post.findings.some((finding) =>
      finding.sourceIds.some((sourceId) => {
        const citation = citationsById.get(sourceId);
        return citation === undefined || !projectedSources.safeCitationNumbers.has(citation);
      }),
    )
  ) {
    return undefined;
  }
  return {
    type: "post",
    title: post.title.slice(0, 1000),
    summary: post.summary.slice(0, 20_000),
    whyItMatters: post.whyItMatters.slice(0, 20_000),
    findings: post.findings.slice(0, 100).map((finding) => ({
      text: finding.text.slice(0, 10_000),
      citations: finding.sourceIds
        .map((sourceId) => citationsById.get(sourceId))
        .filter((citation): citation is number => citation !== undefined),
    })),
    caveats: post.caveats.slice(0, 100).map((caveat) => caveat.slice(0, 4000)),
    publishedAt: post.publishedAt,
    researchedAt: post.researchedAt,
    category: post.category.slice(0, 200),
    sources: projectedSources.sources,
  };
}

export function projectPostForPublicApi(post: ResearchPost): PublicPostProjection | undefined {
  const shared = projectPostForSharing(post);
  if (!shared || shared.type !== "post") return undefined;

  return {
    id: post.id,
    title: shared.title,
    summary: shared.summary,
    whyItMatters: shared.whyItMatters,
    findings: shared.findings,
    caveats: shared.caveats,
    publishedAt: shared.publishedAt,
    researchedAt: shared.researchedAt,
    category: shared.category,
    sources: shared.sources,
  };
}
