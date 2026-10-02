import { describe, expect, it } from "vitest";
import type { Claim, ResearchSession, Source } from "../src/domain.js";
import type { TopicCandidate } from "../src/content-domain.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { evaluatePostQuality, postFromResearch } from "../src/post-quality.js";
import { classifyFirstPartyGitHubSource } from "../src/rank.js";
import { selectVerificationClaims } from "../src/research.js";
import {
  assessLatestnessEvidence,
  extractReleaseEvidenceRecords,
  extractReleaseFactClaimCandidates,
  validateDeterministicReleaseFactCandidates,
} from "../src/version-evidence.js";
import type { RequestedFactKind } from "../src/requested-facts.js";

const question =
  "Investigate the latest stable React release using official React release sources; verify the version and release date.";
const requestedFacts: RequestedFactKind[] = [
  "version",
  "release date",
  "stable status",
  "latestness",
];

function releaseSource(overrides: Partial<Source> = {}): Source {
  const content = [
    "September 9, 2026 by The React Team",
    "React 19.3 is now available on npm!",
    "The compiler and performance features are now stable in React 19.3.",
    "The animation guide explains how transitions work in applications.",
    "React Native 0.85 is also discussed in the mobile release notes.",
  ].join("\n");
  return {
    id: "react-release",
    title: "React 19.3 – React",
    url: "https://react.dev/blog/2026/09/09/react-19-3",
    snippet: content,
    domain: "react.dev",
    sourceType: "official",
    content,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    ...overrides,
  };
}

function supported(claim: Claim): Claim {
  return {
    ...claim,
    verification: { verdict: "supported", rationale: "Deterministic test fixture." },
  };
}

describe("fact-targeted release claim extraction", () => {
  it("extracts version and version-bound date candidates without promoting feature stability", () => {
    const source = releaseSource();
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts,
      sources: [source],
      officialSourcesRequired: true,
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "React 19.3 is now available on npm",
          requestedFacts: expect.arrayContaining(["version"]),
          sourceIds: [source.id],
        }),
        expect.objectContaining({
          text: "React 19.3 release announcement is dated September 9, 2026.",
          requestedFacts: ["release date"],
          evidence: expect.stringContaining("September 9, 2026 by The React Team"),
        }),
      ]),
    );
    expect(candidates.some((claim) => /stable/i.test(claim.text))).toBe(false);
    expect(candidates.some((claim) => /latest|newest/i.test(claim.text))).toBe(false);
    expect(candidates.every((claim) => claim.verification === undefined)).toBe(true);
  });

  it("routes explicit release-channel language to a fact-targeted verifier candidate", () => {
    const source = releaseSource({
      content: "React 19.3 reached general availability on September 9, 2026.",
      snippet: "React 19.3 reached general availability on September 9, 2026.",
    });
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts: ["stable status"],
      sources: [source],
      officialSourcesRequired: true,
    });
    const stabilityCandidate = candidates.find((candidate) =>
      candidate.requestedFacts?.includes("stable status"),
    );

    expect(stabilityCandidate).toMatchObject({
      text: expect.stringContaining("general availability"),
      requestedFacts: ["stable status"],
    });
    expect(
      extractReleaseEvidenceRecords({
        question,
        entities: ["React"],
        claims: stabilityCandidate ? [supported(stabilityCandidate)] : [],
        sources: [source],
        officialSourcesRequired: true,
        stableRequired: true,
      }),
    ).toEqual([expect.objectContaining({ version: "19.3", stability: "stable" })]);
  });

  it("does not route feature-level general availability as release stability", () => {
    const source = releaseSource({
      content: "React 19.3 APIs reached general availability.",
      snippet: "React 19.3 APIs reached general availability.",
    });
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts: ["stable status"],
      sources: [source],
      officialSourcesRequired: true,
    });

    expect(candidates).toEqual([]);
  });

  it("keeps official-source filtering and entity binding strict", () => {
    const official = releaseSource();
    const nonOfficial = releaseSource({
      id: "copied-release",
      title: "React release summary",
      url: "https://example.org/react-release",
      domain: "example.org",
      sourceType: "blog",
    });

    expect(
      extractReleaseFactClaimCandidates({
        question,
        entities: ["React"],
        requestedFacts,
        sources: [nonOfficial],
        officialSourcesRequired: true,
      }),
    ).toEqual([]);
    expect(
      extractReleaseFactClaimCandidates({
        question: "What is the latest stable Flutter release?",
        entities: ["Flutter"],
        requestedFacts,
        sources: [official],
        officialSourcesRequired: true,
      }),
    ).toEqual([]);
  });

  it("does not let an unrelated React Native mention veto a React release passage", () => {
    const source = releaseSource();
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts,
      sources: [source],
      officialSourcesRequired: true,
    });

    expect(candidates.some((claim) => claim.text === "React 19.3 is now available on npm")).toBe(
      true,
    );
    expect(candidates.some((claim) => /React Native 0\.85/.test(claim.text))).toBe(false);
  });

  it("rejects React Native source identity and React Native fact passages for a React request", () => {
    const reactNativePage = releaseSource({
      id: "react-native-release",
      title: "React Native 0.85 release",
      url: "https://reactnative.dev/blog/2026/09/09/0.85",
      domain: "reactnative.dev",
      content: "React Native 0.85 is now available.",
      snippet: "React Native 0.85 is now available.",
    });
    const reactNativePassageOnReactPage = releaseSource({
      content: "React Native 19.3 is now available on npm!",
      snippet: "React Native 19.3 is now available on npm!",
    });

    for (const source of [reactNativePage, reactNativePassageOnReactPage]) {
      expect(
        extractReleaseFactClaimCandidates({
          question,
          entities: ["React"],
          requestedFacts,
          sources: [source],
          officialSourcesRequired: true,
        }),
      ).toEqual([]);
    }
  });

  it("retains an explicit latest-stable assertion as a candidate without complete history", () => {
    const source = releaseSource({
      content: "React 19.3 is the latest stable release.",
      snippet: "React 19.3 is the latest stable release.",
    });
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts,
      sources: [source],
      officialSourcesRequired: true,
    });
    const claim = candidates.find((candidate) => candidate.requestedFacts?.includes("latestness"));

    expect(claim?.text).toBe("React 19.3 is the latest stable release.");
    expect(claim?.verification).toBeUndefined();
    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims: claim ? [supported(claim)] : [],
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: true,
    });
    expect(latestness.conclusion).toBe("UNRESOLVED");
    expect(latestness.candidateVersions[0]?.explicitlyLatest).toBe(true);
  });

  it("binds a supported date candidate to the identified release but leaves stability/latestness unproven", () => {
    const source = releaseSource();
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts,
      sources: [source],
      officialSourcesRequired: true,
    });
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: candidates.map(supported),
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records).toEqual([
      expect.objectContaining({
        version: "19.3",
        releaseDate: "2026-09-09",
        dateAssociationReason: "dated-release-announcement",
        stability: "unknown",
        officialSource: true,
      }),
    ]);
    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims: candidates.map(supported),
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
      releaseRecords: records,
    });
    expect(latestness.conclusion).toBe("UNRESOLVED");
    expect(latestness.comparisons).toEqual([]);
  });

  it("uses the same scoped entity rule for candidate and release-record extraction", () => {
    const source = releaseSource();
    const candidates = extractReleaseFactClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts,
      sources: [source],
      officialSourcesRequired: true,
    });
    const validRecords = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: candidates.map(supported),
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const invalidReactNativeClaim: Claim = supported({
      id: "wrong-entity",
      text: "React Native 19.3 is now available on npm!",
      evidence: "React Native 19.3 is now available on npm!",
      sourceIds: [source.id],
      confidence: 1,
      importance: "critical",
      requestedFacts: ["version"],
    });

    expect(validRecords).toEqual([
      expect.objectContaining({
        version: "19.3",
        releaseDate: "2026-09-09",
        stability: "unknown",
      }),
    ]);
    expect(
      extractReleaseEvidenceRecords({
        question,
        entities: ["React"],
        claims: [invalidReactNativeClaim],
        sources: [source],
        officialSourcesRequired: true,
        stableRequired: true,
      }),
    ).toEqual([]);
    expect(
      assessLatestnessEvidence({
        question,
        entities: ["React"],
        claims: candidates.map(supported),
        sources: [source],
        officialSourcesRequired: true,
        stableRequired: true,
        releaseDateRequired: true,
        releaseRecords: validRecords,
      }).conclusion,
    ).toBe("UNRESOLVED");
  });

  it("surfaces targeted candidates ahead of generic claims in the extraction tool", async () => {
    const source = releaseSource();
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const claims = (await registry.execute("extract_claims", {
      sources: [source],
      question,
      entities: ["React"],
      requestedFacts,
      officialSourcesRequired: true,
    })) as Claim[];

    expect(claims[0]?.requestedFacts).toBeDefined();
    expect(claims.some((claim) => claim.requestedFacts?.includes("release date"))).toBe(true);
    expect(claims.some((claim) => claim.text.includes("animation guide"))).toBe(false);
    expect(
      claims.find((claim) => claim.requestedFacts?.includes("release date"))?.verification,
    ).toMatchObject({ verdict: "supported" });
  });

  it("keeps independent source claims when a large official history exceeds the claim cap", async () => {
    const historyUrl = "https://github.com/facebook/react/releases";
    const entries = [
      "React 19.3.0 was released on 2026-09-09.",
      ...Array.from(
        { length: 39 },
        (_, index) => `React 18.0.${39 - index} was released on 2025-08-01.`,
      ),
    ];
    const historyContent = ["Complete official stable release history.", ...entries].join("\n");
    const historySource = releaseSource({
      id: "react-github-history",
      title: "React releases",
      url: historyUrl,
      domain: "github.com",
      content: historyContent,
      snippet: historyContent,
      retrievalMethod: "structured",
      releaseHistorySourceKind: "first_party_structured",
      releaseHistoryComplete: true,
      firstPartyClassification: classifyFirstPartyGitHubSource(historyUrl),
    });
    const announcementSource = releaseSource({ id: "react-announcement" });
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());

    const claims = (await registry.execute("extract_claims", {
      sources: [historySource, announcementSource],
      question,
      entities: ["React"],
      requestedFacts,
      officialSourcesRequired: true,
    })) as Claim[];

    expect(claims).toHaveLength(30);
    expect(
      claims.some(
        (claim) =>
          claim.sourceIds.includes(announcementSource.id) &&
          claim.requestedFacts?.includes("release date") &&
          claim.verification?.verdict === "supported",
      ),
    ).toBe(true);
  });
});

describe("deterministic official release facts", () => {
  it("supports an explicit version-bound release date without a model verifier", () => {
    const source = releaseSource({
      content: "React 19.3 was released on September 9, 2026.",
      snippet: "React 19.3 was released on September 9, 2026.",
    });
    const input = {
      question,
      entities: ["React"],
      requestedFacts: ["version", "release date"] as RequestedFactKind[],
      sources: [source],
      officialSourcesRequired: true,
    };
    const candidates = extractReleaseFactClaimCandidates(input);
    const validated = validateDeterministicReleaseFactCandidates({
      ...input,
      claims: candidates,
    });
    const dateClaim = validated.find((claim) => claim.requestedFacts?.includes("release date"));

    expect(dateClaim).toMatchObject({
      text: "React 19.3 was released on September 9, 2026.",
      verification: { verdict: "supported" },
    });
    expect(
      extractReleaseEvidenceRecords({
        question,
        entities: ["React"],
        claims: validated,
        sources: [source],
        officialSourcesRequired: true,
        stableRequired: false,
        releaseDateRequired: true,
      })[0],
    ).toMatchObject({
      version: "19.3",
      releaseDate: "2026-09-09",
      releaseDateClaimIds: expect.arrayContaining([dateClaim?.id]),
      releaseDateOrigin: "content",
    });
  });

  it("preserves version-bound release dates but does not publish candidate-only latestness", () => {
    const article = releaseSource({ retrievalMethod: "browser" });
    const history: Source = {
      id: "react-history",
      title: "react/react official GitHub Releases",
      url: "https://github.com/react/react/releases",
      domain: "github.com",
      snippet: "Official React release history",
      sourceType: "official",
      retrievalMethod: "structured",
      content:
        "Complete official React stable release history: React 19.3.0 was released on September 9, 2026. Earlier stable releases include React 19.2.8, allowing direct version comparison.",
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const input = {
      question,
      entities: ["React"],
      requestedFacts,
      sources: [article, history],
      officialSourcesRequired: true,
    };
    const candidates = extractReleaseFactClaimCandidates(input);
    const validated = validateDeterministicReleaseFactCandidates({
      ...input,
      claims: candidates,
    });
    const dateClaim = validated.find(
      (claim) =>
        claim.requestedFacts?.includes("release date") && claim.sourceIds[0] === article.id,
    );
    const historyClaim = supported({
      id: "react-history-latestness",
      text: "React 19.3.0 is newer than earlier stable React 19.2.8 releases.",
      sourceIds: [history.id],
      evidence: history.content!,
      confidence: 1,
      requestedFacts: ["latestness"],
    });
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: "research-quality-evidence",
      question,
      mode: "quick",
      status: "COMPLETED",
      createdAt: now,
      updatedAt: now,
      sources: [article, history],
      claims: [dateClaim!, historyClaim],
      conflicts: [],
      steps: [],
      answer:
        "React 19.3.0 is the latest stable release, with an official release date of September 9, 2026. The release history compares it with earlier stable releases.",
    };
    const claims = [dateClaim!, historyClaim];
    const releaseRecords = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources: [article, history],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const latestnessAssessment = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims,
      sources: [article, history],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
      releaseRecords,
    });
    session.state = {
      objectives: [],
      completedObjectives: [],
      missingObjectives: [],
      queries: [],
      sources: session.sources,
      claims,
      conflicts: [],
      verifiedClaims: claims,
      coverage: 1,
      latestnessAssessment,
      releaseRecords,
    };
    const topic: TopicCandidate = {
      id: "react-release-topic",
      title: "React 19.3 release",
      url: article.url,
      summary: "Official React release announcement",
      provider: "serper",
      publishedAt: now,
      discoveredAt: now,
      score: 1,
      status: "RESEARCHED",
    };
    const quality = evaluatePostQuality(topic, session, []);

    expect(dateClaim?.verification?.verdict).toBe("supported");
    expect(dateClaim?.evidence).toContain("Page title metadata: React 19.3 – React");
    expect(dateClaim?.evidence).toContain("September 9, 2026 by The React Team");
    expect(dateClaim?.evidence).toContain("React 19.3 is now available on npm");
    expect(dateClaim?.evidence.length).toBeGreaterThanOrEqual(80);
    expect(quality).toMatchObject({
      status: "REQUIRES_RESEARCH",
      usefulSources: 2,
      supportedClaims: 1,
      sourceDomains: 2,
    });
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).toContain(
      dateClaim?.id,
    );
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).not.toContain(
      historyClaim.id,
    );

    const wrongDateClaimId = "react-release-wrong-date";
    const correctDateRecord = releaseRecords.find(
      (record) =>
        record.sourceId === article.id && record.releaseDateClaimIds?.includes(dateClaim!.id),
    );
    expect(correctDateRecord).toBeDefined();
    const wrongDateClaim = supported({
      ...dateClaim!,
      id: wrongDateClaimId,
      text: "React 19.3 release announcement is dated September 10, 2026.",
      requestedFacts: ["release date"],
    });
    const claimsWithWrongDate = [wrongDateClaim, historyClaim];
    session.claims = claimsWithWrongDate;
    session.state = {
      ...session.state,
      claims: claimsWithWrongDate,
      verifiedClaims: claimsWithWrongDate,
      releaseRecords: releaseRecords.map((record) =>
        record === correctDateRecord
          ? {
              ...record,
              versionClaimIds: [...new Set([...(record.versionClaimIds ?? []), wrongDateClaimId])],
            }
          : record,
      ),
    };
    const wrongDateQuality = evaluatePostQuality(topic, session, []);
    expect(wrongDateQuality.supportedClaims).toBe(0);
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).not.toContain(
      wrongDateClaimId,
    );
  });

  it("does not turn a URL date into a verified release-date fact", () => {
    const source = releaseSource({
      content: "React 19.3 is now available on npm!",
      snippet: "React 19.3 is now available on npm!",
      url: "https://react.dev/blog/2026/09/09/react-19-3",
    });
    const input = {
      question,
      entities: ["React"],
      requestedFacts: ["version", "release date"] as RequestedFactKind[],
      sources: [source],
      officialSourcesRequired: true,
    };
    const candidates = extractReleaseFactClaimCandidates(input);
    const validated = validateDeterministicReleaseFactCandidates({
      ...input,
      claims: candidates,
    });
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: validated,
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: false,
      releaseDateRequired: true,
    });

    expect(
      validated.find((claim) => claim.requestedFacts?.includes("release date")),
    ).toBeUndefined();
    expect(records[0]).toMatchObject({
      releaseDate: "2026-09-09",
      releaseDateOrigin: "url",
      releaseDateClaimIds: [],
    });
  });

  it("rejects stable wording about React Server Components as release stability", () => {
    const source = releaseSource({
      content: "Stable release of React Server Components in React 19.0.0.",
      snippet: "Stable release of React Server Components in React 19.0.0.",
    });
    const records = extractReleaseEvidenceRecords({
      question: "What is the stable React release?",
      entities: ["React"],
      claims: [
        supported({
          id: "server-components-stability",
          text: source.content!,
          evidence: source.content!,
          sourceIds: [source.id],
          confidence: 1,
        }),
      ],
      sources: [source],
      officialSourcesRequired: true,
      stableRequired: true,
    });

    expect(records).toEqual([expect.objectContaining({ stability: "unknown" })]);
  });
});

describe("fact-targeted verifier claim selection", () => {
  it("selects requested release-fact candidates and excludes generic filler", () => {
    const claims: Claim[] = [
      {
        id: "generic",
        text: "The animation guide explains how transitions work in applications.",
        sourceIds: ["react-release"],
        evidence: "The animation guide explains how transitions work in applications.",
        confidence: 1,
        importance: "critical",
      },
      {
        id: "version",
        text: "React 19.3 is now available on npm!",
        sourceIds: ["react-release"],
        evidence: "React 19.3 is now available on npm!",
        confidence: 1,
        importance: "critical",
        requestedFacts: ["version"],
      },
      {
        id: "date",
        text: "React 19.3 release announcement is dated September 9, 2026.",
        sourceIds: ["react-release"],
        evidence: "September 9, 2026 by The React Team\nReact 19.3 is now available on npm!",
        confidence: 1,
        importance: "critical",
        requestedFacts: ["release date"],
      },
    ];

    expect(
      selectVerificationClaims(claims, 2, [], requestedFacts).map((claim) => claim.id),
    ).toEqual(["date", "version"]);
    expect(
      selectVerificationClaims(claims, 3, [], ["latestness"]).map((claim) => claim.id),
    ).toEqual([]);
    expect(selectVerificationClaims(claims, 2).map((claim) => claim.id)).toContain("generic");
  });

  it("tags and selects only the verified-eligible lifecycle passage for Research Chat", async () => {
    const lifecycleQuestion =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const source: Source = {
      id: "node-lifecycle",
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/previous-releases",
      snippet: "",
      domain: "nodejs.org",
      content:
        "Node.js 22 reaches end of life on 2027-04-30 according to the official Node.js release schedule.",
      retrievalMethod: "http",
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const claims = (await registry.execute("extract_claims", {
      sources: [source],
      question: lifecycleQuestion,
      entities: ["Node.js"],
      requestedFacts: ["end-of-life date"],
      officialSourcesRequired: true,
    })) as Claim[];
    const generic: Claim = {
      id: "generic-lifecycle",
      text: "The Node.js release schedule includes multiple support lines.",
      sourceIds: [source.id],
      evidence: "The Node.js release schedule includes multiple support lines.",
      confidence: 1,
    };

    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: source.content,
          requestedFacts: ["end-of-life date"],
        }),
      ]),
    );
    expect(
      selectVerificationClaims([...claims, generic], 2, [], ["end-of-life date"]).map(
        (claim) => claim.id,
      ),
    ).toEqual([claims.find((claim) => claim.requestedFacts?.includes("end-of-life date"))?.id]);
  });

  it("keeps concise normalized lifecycle rows only when entity, version, and date are bound", async () => {
    const lifecycleQuestion =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const row = (id: string, content: string): Source => ({
      id,
      title: "Node.js release schedule",
      url: `https://nodejs.org/en/about/previous-releases#${id}`,
      snippet: "",
      domain: "nodejs.org",
      content,
      retrievalMethod: "http",
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    });
    const contents = [
      "Node.js version 22 end-of-life date: 2027-04-30.",
      "Node.js version 20 end-of-life date: 2027-04-30.",
      "Node.js version 22. End-of-life date: 2027-04-30.",
    ];
    const extracted = await Promise.all(
      contents.map(
        async (content, index) =>
          (await registry.execute("extract_claims", {
            sources: [row(`lifecycle-row-${index}`, content)],
            question: lifecycleQuestion,
            entities: ["Node.js"],
            requestedFacts: ["end-of-life date"],
            officialSourcesRequired: true,
          })) as Claim[],
      ),
    );

    expect(extracted[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: contents[0],
          requestedFacts: ["end-of-life date"],
        }),
      ]),
    );
    expect(extracted[1]?.some((claim) => claim.requestedFacts?.includes("end-of-life date"))).toBe(
      false,
    );
    expect(extracted[2]?.some((claim) => claim.requestedFacts?.includes("end-of-life date"))).toBe(
      false,
    );
  });
});
