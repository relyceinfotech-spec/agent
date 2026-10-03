import type {
  FirstPartySourceClassification,
  SearchResult,
  ResearchRecoveryRequirements,
  Source,
  SourceSelectionDecision,
  ComparisonObjective,
} from "./domain.js";
import { createHash } from "node:crypto";
import { canonicalizeUrl } from "./security.js";
import { containsExactEntity, subjectEntityMismatchReason } from "./entities.js";
import { requestedFactCoverage } from "./requested-facts.js";
import { querySubjectMismatchReason } from "./query-relevance.js";
import { comparisonClaimHasTargetFinding } from "./comparison-evidence.js";

export interface SourceAcquisitionContext {
  comparison: ComparisonObjective;
  neededTargets: string[];
  usedDomains: string[];
  unavailableUrls: string[];
}

const authoritativeDomains = [
  "who.int",
  "w3.org",
  "ietf.org",
  "developer.mozilla.org",
  "react.dev",
  "reactnative.dev",
  "flutter.dev",
  "firebase.google.com",
  "supabase.com",
  "bun.sh",
  "trpc.io",
  "graphql.org",
  "nextjs.org",
  "nodejs.org",
  "python.org",
  "rust-lang.org",
  "golang.org",
  "arxiv.org",
  "registry.npmjs.org",
  "openai.com",
  "apple.com",
  "microsoft.com",
];

const officialDomainsByEntity: Record<string, string[]> = {
  React: ["react.dev"],
  "React Native": ["reactnative.dev"],
  Flutter: ["flutter.dev"],
  OpenAI: ["openai.com"],
  Apple: ["apple.com"],
  Microsoft: ["microsoft.com"],
  Python: ["python.org"],
  "Node.js": ["nodejs.org"],
  "Next.js": ["nextjs.org"],
  Supabase: ["supabase.com"],
  Firebase: ["firebase.google.com"],
  Bun: ["bun.sh"],
  Rust: ["rust-lang.org"],
  Go: ["golang.org"],
};
interface FirstPartyGitHubRepository {
  entity: string;
  repository: string;
}

// Trust is attached to exact repository identities, never to GitHub as a host.
// Keep this as a data registry so additional entities can use the same path
// and release-history classifier without broad organization-level trust.
const firstPartyGitHubRepositories: FirstPartyGitHubRepository[] = [
  { entity: "React", repository: "facebook/react" },
  { entity: "React", repository: "react/react" },
  { entity: "React Native", repository: "facebook/react-native" },
  { entity: "Flutter", repository: "flutter/flutter" },
  { entity: "Python", repository: "python/cpython" },
  { entity: "Node.js", repository: "nodejs/node" },
  { entity: "Next.js", repository: "vercel/next.js" },
];

function githubContentKind(pathname: string): FirstPartySourceClassification["contentKind"] {
  const path = pathname.toLowerCase();
  if (/^\/(?:releases(?:\.atom)?|tags)(?:\/|$)/.test(path)) return "release_history";
  if (/^\/blob\/[^/]+\/(?:.+\/)?(?:changelog|changes|history)(?:\.[^/]*)?$/i.test(path)) {
    return "changelog";
  }
  return "repository";
}

/** Resolve an exact first-party GitHub repository and classify its requested page. */
export function classifyFirstPartyGitHubSource(
  rawUrl: string,
): FirstPartySourceClassification | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return undefined;
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2) return undefined;

  const repository = `${segments[0]}/${segments[1].replace(/\.git$/i, "")}`.toLowerCase();
  for (const trustedRepository of firstPartyGitHubRepositories) {
    if (trustedRepository.repository.toLowerCase() !== repository) continue;
    return {
      entity: trustedRepository.entity,
      repository,
      contentKind: githubContentKind(`/${segments.slice(2).join("/")}`),
    };
  }
  return undefined;
}

function isAuthoritativeDomain(domain: string): boolean {
  return authoritativeDomains.some(
    (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
  );
}

export function isOfficialSource(source: Pick<Source, "domain" | "sourceType">): boolean {
  return source.sourceType === "official" || source.sourceType === "government";
}

export function isOfficialSourceForEntities(
  source: Pick<Source, "domain" | "sourceType"> & Partial<Pick<Source, "url">>,
  entities: string[],
): boolean {
  const matchesDeclaredDomain = entities.some((entity) =>
    (officialDomainsByEntity[entity] ?? []).some(
      (domain) => source.domain === domain || source.domain.endsWith(`.${domain}`),
    ),
  );
  if (matchesDeclaredDomain) return true;

  const firstParty = source.url ? classifyFirstPartyGitHubSource(source.url) : undefined;
  if (firstParty) {
    return (
      entities.includes(firstParty.entity) &&
      (firstParty.contentKind === "release_history" || firstParty.contentKind === "changelog")
    );
  }

  // GitHub is a hosting platform, not an entity-level trust signal. Unmapped
  // repositories must not inherit sourceType="official" from generic metadata.
  if (source.domain.toLowerCase() === "github.com") return false;

  const hasUnmappedEntity = entities.some(
    (entity) =>
      !officialDomainsByEntity[entity] &&
      !firstPartyGitHubRepositories.some((entry) => entry.entity === entity),
  );
  return hasUnmappedEntity ? isOfficialSource(source) : false;
}

function isGitHubConversation(domain: string, title: string, url: string): boolean {
  if (domain !== "github.com") return false;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return (
    /\/(?:discussions|issues)(?:\/|$)/i.test(path) ||
    /\b(?:community discussion|issue #\d+)\b/i.test(title)
  );
}

function detectSourceType(domain: string, title: string, url: string): Source["sourceType"] {
  const value = `${domain} ${title} ${url}`.toLowerCase();
  const firstParty = classifyFirstPartyGitHubSource(url);
  if (firstParty?.contentKind === "release_history" || firstParty?.contentKind === "changelog") {
    return "official";
  }
  if (isGitHubConversation(domain, title, url)) return "forum";
  if (domain === "github.com") return "unknown";
  if (domain.endsWith(".gov") || domain.includes("who.int") || domain.includes(".gov.")) {
    return "government";
  }
  if (
    domain.endsWith(".edu") ||
    domain === "arxiv.org" ||
    domain.endsWith(".arxiv.org") ||
    value.includes("journal") ||
    value.includes("research paper")
  ) {
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
  if (isAuthoritativeDomain(domain)) {
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
  if (
    domain.includes("medium.com") ||
    domain.includes("dev.to") ||
    domain.includes("substack.com") ||
    value.includes("blog")
  ) {
    return "blog";
  }
  return "unknown";
}

export function rankResults(question: string, results: SearchResult[]): Source[] {
  const versionLookup = /\b(latest|current|version|release)\b/i.test(question);
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
    const firstPartyClassification = classifyFirstPartyGitHubSource(normalizedUrl);

    // Calculate lexical relevance based on query terms
    const textBlob = `${item.title} ${item.snippet}`.toLowerCase();
    const matchedTerms = [...terms].filter((term) => textBlob.includes(term)).length;
    const termRatio = matchedTerms / Math.max(1, Math.min(terms.size, 6));
    const subjectMismatchReason =
      subjectEntityMismatchReason(question, `${item.title} ${item.snippet} ${normalizedUrl}`) ??
      querySubjectMismatchReason(question, `${item.title} ${item.snippet}`);
    const relevance = subjectMismatchReason ? 0 : Math.min(1, termRatio + 0.15);
    const factCoverage = requestedFactCoverage(question, `${item.title} ${item.snippet}`);
    const factSpecificityBonus = factCoverage.required.length
      ? (factCoverage.present.length / factCoverage.required.length) * 0.18
      : 0;

    // Authority rating
    let authority = 0.55;
    const isVideoOrSocial =
      domain.includes("youtube.com") ||
      domain.includes("youtu.be") ||
      domain.includes("vimeo.com") ||
      domain.includes("tiktok.com") ||
      domain.includes("instagram.com") ||
      domain.includes("facebook.com") ||
      domain.includes("twitter.com") ||
      domain.includes("x.com");

    if (isVideoOrSocial) {
      authority = 0.1;
    } else if (
      type === "government" ||
      type === "academic" ||
      type === "documentation" ||
      type === "official" ||
      isAuthoritativeDomain(domain)
    ) {
      authority =
        isAuthoritativeDomain(domain) || type === "government" || domain.endsWith(".edu")
          ? 0.95
          : 0.8;
    } else if (type === "news") {
      authority = 0.75;
    }

    const freshness = item.publishedAt
      ? item.provider === "serper"
        ? 0.65 // Search-provider dates may be crawl dates, not publication dates.
        : 0.9
      : 0.55;
    const completeness = Math.min(1, item.snippet.length / 500 + 0.35);

    const intentBonus =
      versionLookup &&
      authority >= 0.9 &&
      /\b(versions?|releases?|latest|changelog)\b/i.test(`${item.title} ${normalizedUrl}`)
        ? 0.16
        : 0;
    const tutorialPenalty =
      versionLookup && /\b(tutorial|quick start|getting started|what is)\b/i.test(item.title)
        ? 0.1
        : 0;
    const baseScore = subjectMismatchReason
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            relevance * 0.45 +
              authority * 0.25 +
              freshness * 0.15 +
              completeness * 0.15 +
              intentBonus +
              factSpecificityBonus -
              tutorialPenalty,
          ),
        );

    initialSources.push({
      ...item,
      url: normalizedUrl,
      id: createHash("sha1").update(normalizedUrl).digest("hex").slice(0, 16),
      domain,
      sourceType: type,
      firstPartyClassification,
      subjectMismatchReason,
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

/** Explain source eligibility and reserve relevant official sources when possible. */
export function selectResearchSourcesWithDecisions(
  ranked: Source[],
  entities: string[],
  limit: number,
  officialSourceRequirement: "none" | "preferred" | "required" = "none",
  taskQuestion?: string,
  recoveryRequirements?: Pick<
    ResearchRecoveryRequirements,
    "unresolvedFacts" | "factInsufficientSources"
  >,
  preferReadableText = false,
  acquisition?: SourceAcquisitionContext,
): { selected: Source[]; decisions: Array<Omit<SourceSelectionDecision, "query">> } {
  const recoveryFacts = recoveryRequirements?.unresolvedFacts ?? [];
  const factInsufficientUrls = new Map<string, Set<string>>();
  for (const source of recoveryRequirements?.factInsufficientSources ?? []) {
    for (const url of [source.url, source.canonicalUrl].filter(
      (value): value is string => !!value,
    )) {
      let facts = factInsufficientUrls.get(canonicalizeUrl(url));
      if (!facts) {
        facts = new Set<string>();
        factInsufficientUrls.set(canonicalizeUrl(url), facts);
      }
      source.missingFacts.forEach((fact) => facts!.add(fact));
    }
  }
  const excludedForMissingFact = (source: Source) => {
    const urls = [source.url, source.canonicalUrl].filter((value): value is string => !!value);
    return urls.some((url) =>
      recoveryFacts.some((fact) => factInsufficientUrls.get(canonicalizeUrl(url))?.has(fact)),
    );
  };
  const metadataSignalsMissingFact = (source: Source) =>
    recoveryFacts.some((fact) =>
      recoveryMetadataIndicatesFact(
        `${source.title} ${source.snippet} ${source.url}`,
        fact,
        taskQuestion,
        entities,
      ),
    );
  const relevanceEligible = ranked.filter(
    (source) =>
      !acquisition?.unavailableUrls.includes(source.url) &&
      !source.subjectMismatchReason &&
      !excludedForMissingFact(source) &&
      (recoveryFacts.length === 0 || metadataSignalsMissingFact(source)) &&
      source.quality.relevance >= 0.3 &&
      source.quality.overall >= 0.4,
  );
  const entityEligible = (source: Source) =>
    entities.length === 0 ||
    entities.some((entity) =>
      containsExactEntity(`${source.title} ${source.snippet} ${source.url}`, entity),
    );
  const officialEligible = relevanceEligible.filter(
    (source) => isOfficialSourceForEntities(source, entities) && entityEligible(source),
  );
  const officialFactCoverage = (source: Source) =>
    taskQuestion
      ? requestedFactCoverage(taskQuestion, `${source.title} ${source.snippet}`, {
          requestedFacts: recoveryFacts.length > 0 ? recoveryFacts : undefined,
        }).present.length
      : 0;
  const recoverySignalCount = (source: Source) =>
    recoveryFacts.filter((fact) =>
      recoveryMetadataIndicatesFact(
        `${source.title} ${source.snippet} ${source.url}`,
        fact,
        taskQuestion,
        entities,
      ),
    ).length;
  const prioritizedOfficial =
    (officialSourceRequirement === "required" ||
      (recoveryFacts.length > 0 && officialSourceRequirement === "preferred")) &&
    taskQuestion
      ? [...officialEligible].sort(
          (a, b) =>
            officialFactCoverage(b) - officialFactCoverage(a) ||
            recoverySignalCount(b) - recoverySignalCount(a) ||
            b.quality.overall - a.quality.overall,
        )
      : officialEligible;
  const policyEligible =
    officialSourceRequirement === "required"
      ? prioritizedOfficial
      : officialSourceRequirement === "preferred" && officialEligible.length > 0
        ? [
            ...prioritizedOfficial,
            ...relevanceEligible.filter((source) => !prioritizedOfficial.includes(source)),
          ]
        : relevanceEligible;
  const mediaPage = (source: Source) =>
    /(^|\.)(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com)$/.test(source.domain);
  const textEligible = policyEligible.filter((source) => !mediaPage(source));
  const eligible =
    preferReadableText &&
    textEligible.length > 0 &&
    !/\b(?:videos?|transcripts?|youtube|vimeo)\b/i.test(taskQuestion ?? "")
      ? textEligible
      : policyEligible;
  const selected: Source[] = [];
  const selectedUrls = new Set<string>();
  const domains = new Set(acquisition?.usedDomains ?? []);
  const needed = new Set(acquisition?.neededTargets ?? []);
  // Search metadata guides discovery only; it never establishes verified
  // comparison coverage or supplies publication evidence.
  const discovery = (source: Source) => {
    const targetLeads = acquisition
      ? [...needed].filter((target) =>
          comparisonClaimHasTargetFinding(
            { ...acquisition.comparison, targets: [target] },
            source.snippet,
          ),
        )
      : [];
    const targetMentions = acquisition
      ? [...needed].filter((target) => containsExactEntity(source.snippet, target))
      : [];
    const independentDomain = !domains.has(source.domain);
    return {
      targetLeads,
      targetMentions,
      independentDomain,
      score: Number(
        (
          source.quality.overall +
          targetLeads.length * 4 +
          targetMentions.length * 2 +
          (independentDomain ? 0.5 : 0)
        ).toFixed(3),
      ),
    };
  };
  const selectionSignals = new Map<string, ReturnType<typeof discovery>>();
  const select = (source: Source) => {
    const signal = discovery(source);
    selectionSignals.set(source.id, signal);
    selected.push(source);
    selectedUrls.add(source.url);
    if (acquisition) {
      domains.add(source.domain);
      signal.targetLeads.forEach((target) => needed.delete(target));
    }
  };
  const authoritativeLimit = Math.min(2, Math.max(1, Math.floor(limit / 2)));
  for (const entity of entities.slice(0, authoritativeLimit)) {
    if (selected.length >= limit) break;
    const match = eligible.find(
      (source) =>
        isOfficialSourceForEntities(source, entities) &&
        entityEligible(source) &&
        !selectedUrls.has(source.url) &&
        containsExactEntity(`${source.title} ${source.snippet} ${source.url}`, entity),
    );
    if (match) {
      select(match);
    }
  }
  if (selected.length === 0 && limit > 0) {
    const bestOfficial = eligible.find(
      (source) => isOfficialSourceForEntities(source, entities) && entityEligible(source),
    );
    if (bestOfficial) {
      select(bestOfficial);
    }
  }
  while (selected.length < limit) {
    const remaining = eligible.filter((source) => !selectedUrls.has(source.url));
    if (acquisition) remaining.sort((a, b) => discovery(b).score - discovery(a).score);
    if (!remaining[0]) break;
    select(remaining[0]);
  }

  const selectedIds = new Set(selected.map((source) => source.id));
  const decisions = ranked.map((source) => {
    const officialSource = isOfficialSourceForEntities(source, entities);
    let reason = "Eligible result fell outside the selected-source limit.";
    if (acquisition?.unavailableUrls.includes(source.url)) {
      reason = "Source is unavailable for this run after an unsuccessful retrieval; skipped.";
    } else if (excludedForMissingFact(source)) {
      const excludedFacts = recoveryRequirements?.factInsufficientSources
        ?.filter((excluded) =>
          [excluded.url, excluded.canonicalUrl]
            .filter((value): value is string => !!value)
            .some((url) => canonicalizeUrl(url) === canonicalizeUrl(source.url)),
        )
        .flatMap((excluded) => excluded.missingFacts)
        .filter((fact) => recoveryFacts.includes(fact));
      reason = `Previously evaluated source omitted unresolved fact(s): ${[...new Set(excludedFacts)].join(", ")}.`;
    } else if (recoveryFacts.length > 0 && !metadataSignalsMissingFact(source)) {
      reason =
        "Search metadata does not indicate an unresolved requested fact; skipped during bounded recovery.";
    } else if (source.subjectMismatchReason) {
      reason = source.subjectMismatchReason;
    } else if (policyEligible.includes(source) && !eligible.includes(source)) {
      reason =
        "Readable text sources were preferred for this bounded comparison; media-page metadata does not establish a usable transcript.";
    } else if (source.quality.relevance < 0.3) {
      reason = "Relevance score was below the source-selection threshold.";
    } else if (source.quality.overall < 0.4) {
      reason = "Overall quality score was below the source-selection threshold.";
    } else if (officialSourceRequirement === "required" && !officialSource) {
      reason = "This task requires official sources; this domain is not classified as official.";
    } else if (officialSourceRequirement === "required" && !entityEligible(source)) {
      reason = "The official source does not match any requested entity.";
    } else if (selectedIds.has(source.id)) {
      const requiredFacts = taskQuestion
        ? requestedFactCoverage(taskQuestion, `${source.title} ${source.snippet}`, {
            requestedFacts: recoveryFacts.length > 0 ? recoveryFacts : undefined,
          })
        : undefined;
      reason =
        officialSource && requiredFacts?.required.length
          ? `Selected as an eligible official source; search metadata mentions ${requiredFacts.present.length}/${requiredFacts.required.length} requested fact(s).`
          : officialSource
            ? "Selected as an eligible official source for the requested subject."
            : "Selected as an eligible source under the task's source policy.";
    }

    const acquisitionSignal = acquisition
      ? (selectionSignals.get(source.id) ?? discovery(source))
      : undefined;
    if (selectedIds.has(source.id) && acquisitionSignal)
      reason += ` Discovery priority ${acquisitionSignal.score}; missing-target finding leads: ${acquisitionSignal.targetLeads.join(", ") || "none"}; ${acquisitionSignal.independentDomain ? "independent" : "already used"} domain. Metadata remains unverified.`;

    return {
      sourceId: source.id,
      title: source.title,
      snippet: source.snippet,
      url: source.url,
      domain: source.domain,
      sourceType: source.sourceType,
      firstPartyClassification: source.firstPartyClassification,
      officialSource,
      officialSourceRequirement,
      selected: selectedIds.has(source.id),
      reason,
      subjectMismatchReason: source.subjectMismatchReason,
      quality: source.quality,
      acquisition: acquisitionSignal,
    };
  });

  return { selected, decisions };
}

function recoveryMetadataIndicatesFact(
  metadata: string,
  fact: ResearchRecoveryRequirements["unresolvedFacts"][number],
  taskQuestion?: string,
  entities: string[] = [],
): boolean {
  const requestedLifecycleVersion =
    fact === "end-of-life date" && taskQuestion
      ? requestedLifecycleVersionFromQuestion(taskQuestion, entities)
      : undefined;
  if (requestedLifecycleVersion) {
    const entity = requestedLifecycleVersion.entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentions = [
      ...metadata.matchAll(
        new RegExp(`\\b${entity}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})(?:\\.x)?\\b`, "gi"),
      ),
      ...metadata.matchAll(/\bv(\d+(?:\.\d+){0,3})(?:\.x)?\b/gi),
      ...metadata.matchAll(/\b(\d+)\.x\b/gi),
    ].map((match) => match[1]?.replace(/^v/i, ""));
    if (
      mentions.length > 0 &&
      !mentions.some((version) => version === requestedLifecycleVersion.version)
    ) {
      return false;
    }
  }

  switch (fact) {
    case "end-of-life date":
      return /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until)|lifecycle|release schedule|support schedule|working group)\b/i.test(
        metadata,
      );
    case "release date":
      return /\b(?:release date|released on|published on|available on npm|release announcement|changelog)\b/i.test(
        metadata,
      );
    case "release status":
    case "stable status":
      return (
        /\b(?:release|version|channel)\b/i.test(metadata) &&
        /\b(?:stable|canary|experimental|nightly|alpha|beta|preview|pre[- ]?release|rc)\b/i.test(
          metadata,
        )
      );
    case "latestness":
      return (
        /\b(?:release\s+history|version\s+history|all\s+versions|all\s+releases|changelog)\b/i.test(
          metadata,
        ) ||
        (/\b(?:latest|newest|current|most recent)\b/i.test(metadata) &&
          /\b(?:release|version|changelog|history)\b/i.test(metadata))
      );
    case "version":
      return /\b(?:version|release|changelog|history)\b/i.test(metadata);
    case "price":
      return /\b(?:price|pricing|cost|plan)\b/i.test(metadata);
    case "technical value":
      return /\b(?:specification|specs?|limits?|capacity|latency|throughput|benchmark|measurements?)\b/i.test(
        metadata,
      );
  }
}

function requestedLifecycleVersionFromQuestion(
  question: string,
  entities: string[],
): { entity: string; version: string } | undefined {
  const knownEntity = entities.find((entity) =>
    question.toLowerCase().includes(entity.toLowerCase()),
  );
  if (!knownEntity) return undefined;
  const escapedEntity = knownEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = question.match(
    new RegExp(`\\b${escapedEntity}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "i"),
  )?.[1];
  return version ? { entity: knownEntity, version } : undefined;
}

export function selectResearchSources(
  ranked: Source[],
  entities: string[],
  limit: number,
  officialSourceRequirement: "none" | "preferred" | "required" = "none",
  taskQuestion?: string,
): Source[] {
  return selectResearchSourcesWithDecisions(
    ranked,
    entities,
    limit,
    officialSourceRequirement,
    taskQuestion,
  ).selected;
}
