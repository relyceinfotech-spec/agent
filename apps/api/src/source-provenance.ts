import type { Claim, Source } from "./domain.js";
import { containsExactEntity } from "./entities.js";

// A deliberately small, conservative set of common multi-label public suffixes.
// Unknown suffixes collapse to the last two labels, which can under-count
// independent publishers but cannot create false independence from subdomains.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.in",
  "ac.jp",
  "ac.nz",
  "ac.uk",
  "asn.au",
  "co.in",
  "co.id",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.th",
  "co.uk",
  "co.za",
  "com.ar",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.in",
  "com.mx",
  "com.my",
  "com.ph",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.ua",
  "com.vn",
  "edu.au",
  "firm.in",
  "gov.au",
  "gov.in",
  "gov.uk",
  "gov.za",
  "net.au",
  "net.in",
  "net.nz",
  "net.uk",
  "org.au",
  "org.in",
  "org.nz",
  "org.uk",
  "org.za",
]);

function normalizedWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compact(value: string): string {
  return normalizedWords(value).replace(/\s+/g, "");
}

function isIpAddress(hostname: string): boolean {
  return hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function suffixLabelCount(labels: string[]): number {
  return labels.length >= 2 && MULTI_LABEL_PUBLIC_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
}

/** Normalize subdomains to a conservative publisher identity for diversity checks. */
export function publisherDomainKey(hostOrUrl: string): string {
  let hostname = hostOrUrl.trim().toLowerCase();
  try {
    hostname = new URL(hostname.includes("://") ? hostname : `https://${hostname}`).hostname;
  } catch {
    return hostname.replace(/^www\./, "");
  }
  hostname = hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!hostname || isIpAddress(hostname)) return hostname;
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;
  const suffixLabels = suffixLabelCount(labels);
  return labels.slice(-(suffixLabels + 1)).join(".");
}

function registeredEntityLabel(hostOrUrl: string): string {
  const domain = publisherDomainKey(hostOrUrl);
  if (!domain || isIpAddress(domain)) return "";
  return domain.split(".")[0] ?? "";
}

/** True only when the publisher host itself identifies the requested entity. */
export function isFirstPartySourceForEntities(source: Source, entities: string[]): boolean {
  if (
    source.firstPartyClassification &&
    entities.some((entity) => compact(entity) === compact(source.firstPartyClassification!.entity))
  ) {
    return true;
  }
  const hostLabel = compact(registeredEntityLabel(source.domain || source.url));
  if (!hostLabel) return false;
  return entities.some(
    (entity) => hostLabel === compact(entity) && containsExactEntity(source.title, entity),
  );
}

export interface ClaimSourceReliance {
  claimId: string;
  claimText: string;
  sourceIds: string[];
  sources: Array<{
    id: string;
    title: string;
    domain: string;
    publisherDomain: string;
    sourceType: Source["sourceType"] | "unknown";
    relationshipToEntity: "first_party" | "third_party_or_unclassified";
    authorityScore: number;
  }>;
  independentPublisherCount: number;
  corroboratedAcrossIndependentPublishers: boolean;
}

function normalizedClaimKey(text: string): string {
  return normalizedWords(text);
}

/**
 * Summarize only verified claims and source IDs. Corroboration is deliberately
 * conservative: separate single-source claims must have exactly matching text
 * and resolve to distinct publisher domains.
 */
export function buildClaimSourceReliance(
  claims: Claim[],
  sources: Source[],
  entities: string[],
): ClaimSourceReliance[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const supported = claims.filter((claim) => claim.verification?.verdict === "supported");
  const publisherDomainsByClaim = new Map<string, Set<string>>();
  for (const claim of supported) {
    if (claim.sourceIds.length !== 1) continue;
    const key = normalizedClaimKey(claim.text);
    const source = sourceById.get(claim.sourceIds[0]!);
    if (!key || !source) continue;
    const domains = publisherDomainsByClaim.get(key) ?? new Set<string>();
    domains.add(publisherDomainKey(source.domain || source.url));
    publisherDomainsByClaim.set(key, domains);
  }

  return supported.flatMap((claim) => {
    const claimSources = claim.sourceIds.flatMap((id) => {
      const source = sourceById.get(id);
      if (!source) return [];
      return [
        {
          id: source.id,
          title: source.title,
          domain: source.domain,
          publisherDomain: publisherDomainKey(source.domain || source.url),
          sourceType: source.sourceType ?? "unknown",
          relationshipToEntity: isFirstPartySourceForEntities(source, entities)
            ? ("first_party" as const)
            : ("third_party_or_unclassified" as const),
          authorityScore: Number(source.quality.authority.toFixed(2)),
        },
      ];
    });
    if (claimSources.length === 0) return [];
    const independentPublisherCount =
      publisherDomainsByClaim.get(normalizedClaimKey(claim.text))?.size ?? 0;
    return [
      {
        claimId: claim.id,
        claimText: claim.text,
        sourceIds: claim.sourceIds,
        sources: claimSources,
        independentPublisherCount,
        corroboratedAcrossIndependentPublishers: independentPublisherCount >= 2,
      },
    ];
  });
}

/** Qualify a precise-fact claim when one non-first-party publisher supports it. */
export function qualifySingleThirdPartyClaim(
  text: string,
  reliance: ClaimSourceReliance | undefined,
): string {
  if (
    !reliance ||
    reliance.corroboratedAcrossIndependentPublishers ||
    reliance.independentPublisherCount >= 2 ||
    reliance.sources.length === 0 ||
    reliance.sources.some((source) => source.relationshipToEntity === "first_party") ||
    /^(?:according to\b|(?:the|a|an)\b[^.!?]{0,100}\b(?:reports?|lists?|states?|says?|describes?|identifies?)\b|[\p{L}\p{N}_.-]+(?:\s+[\p{L}\p{N}_.-]+){0,3}\s+(?:reports?|lists?|states?|says?)\b)/iu.test(
      text.trim(),
    )
  ) {
    return text;
  }
  const source = reliance.sources[0];
  if (!source) return text;
  const listingLike = /\b(?:profile|directory|listing|staff|employee|people)\b/i.test(
    `${source.title} ${source.domain}`,
  );
  const attribution = listingLike
    ? `A third-party listing at ${source.domain} states that`
    : `The available third-party source at ${source.domain} reports that`;
  return `${attribution} ${text}`;
}
