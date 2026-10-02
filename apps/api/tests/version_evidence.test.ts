import { describe, expect, it } from "vitest";
import type { Claim, Source } from "../src/domain.js";
import { classifyFirstPartyGitHubSource } from "../src/rank.js";
import {
  assessLatestnessEvidence,
  compareVersions,
  extractOfficialReleaseHistoryClaimCandidates,
  extractReleaseEvidenceRecords,
} from "../src/version-evidence.js";

const question = "What is the latest stable React version?";

function source(
  id: string,
  domain = "react.dev",
  content = "Official release and version information.",
  title = "Official release notes",
  url = `https://${domain}/releases`,
): Source {
  return {
    id,
    title,
    url,
    snippet: content,
    domain,
    sourceType: "official",
    content,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function claim(id: string, text: string, sourceIds: string[], evidence = text): Claim {
  return {
    id,
    text,
    sourceIds,
    evidence,
    confidence: 1,
    verification: { verdict: "supported", rationale: "Provider-free source-evidence fixture." },
  };
}

function assess(
  claims: Claim[],
  sources: Source[],
  stableRequired = true,
  releaseDateRequired = false,
) {
  return assessLatestnessEvidence({
    question,
    entities: ["React"],
    claims,
    sources,
    officialSourcesRequired: true,
    stableRequired,
    releaseDateRequired,
  });
}

describe("generic latestness and ordered-version evidence", () => {
  it("compares semver-like versions numerically and handles prerelease ordering", () => {
    expect(compareVersions("v1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.9.0", "2.10.0")).toBe(-1);
    expect(compareVersions("2.4", "2.4.0")).toBe(0);
    expect(compareVersions("3.0.0-beta.1", "3.0.0")).toBe(-1);
    expect(compareVersions("3.0.0", "3.1.0-rc.1")).toBe(-1);
    expect(compareVersions("3.0.0-rc.2", "3.0.0-rc.10")).toBe(-1);
    expect(compareVersions("3.0.0-rc.1", "3.0.0")).toBe(-1);
    expect(compareVersions("release-3", "3.0.0")).toBeUndefined();
  });

  it("enforces LATESTNESS_PROMOTION_INVARIANT without comparable complete history", () => {
    const release = source(
      "release-current",
      "react.dev",
      "React 19.3.0 is the latest stable release, released on September 15, 2026.",
      "React 19.3 release announcement",
    );
    const result = assess([claim("claim-current", release.content!, [release.id])], [release]);

    expect(result).toMatchObject({
      conclusion: "UNRESOLVED",
      supportingSourceIds: [],
    });
    expect(result.latestVersion).toBeUndefined();
    expect(result.unresolvedState).toMatchObject({
      status: "unresolved",
      reason: "incomplete_official_history",
      recommendedNextAction: "retrieve_additional_official_evidence",
      candidates: [
        {
          entity: "React",
          version: "19.3.0",
          stability: "stable",
          withdrawn: false,
          sourceIds: [release.id],
        },
      ],
    });
    expect(result.candidateVersions).toEqual([
      expect.objectContaining({
        entity: "React",
        version: "19.3.0",
        stability: "stable",
        sourceIds: [release.id],
        claimIds: ["claim-current"],
        latestnessSourceIds: [release.id],
        releaseDates: ["2026-09-15"],
        explicitlyLatest: true,
      }),
    ]);
    expect(result.releaseRecords).toEqual([
      expect.objectContaining({
        entity: "React",
        version: "19.3.0",
        releaseDate: "2026-09-15",
        dateAssociationReason: "versioned-release-statement",
        stability: "stable",
        latestnessEvidence: expect.stringContaining("latest stable release"),
        sourceId: release.id,
        sourceType: "official",
        officialSource: true,
      }),
    ]);
  });

  it("associates a dated official release announcement with its version, not feature stability", () => {
    const announcement = source(
      "react-193-dated",
      "react.dev",
      "September 9, 2026 by The React Team\nReact 19.3 is now available on npm!\nFeatures are stable in React 19.3.",
      "React 19.3 release announcement",
      "https://react.dev/blog/2026/09/09/react-19-3",
    );
    const claims = [
      claim("react-193-claim", "React 19.3 is now available on npm.", [announcement.id]),
    ];
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources: [announcement],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records).toEqual([
      expect.objectContaining({
        entity: "React",
        version: "19.3",
        releaseDate: "2026-09-09",
        pageDate: "2026-09-09",
        dateAssociationReason: "dated-release-announcement",
        stability: "unknown",
        sourceId: announcement.id,
      }),
    ]);
    expect(assess(claims, [announcement], true, true)).toMatchObject({
      conclusion: "UNRESOLVED",
      releaseRecords: [expect.objectContaining({ stability: "unknown" })],
    });
  });

  it("does not promote a URL-derived date without a date-specific supported claim", () => {
    const announcement = source(
      "url-date-only",
      "react.dev",
      "React 19.3 is now available on npm!",
      "React 19.3 release announcement",
      "https://react.dev/blog/2026/09/09/react-19-3",
    );
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim("version-only", announcement.content!, [announcement.id])],
      sources: [announcement],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records[0]).toMatchObject({
      releaseDate: "2026-09-09",
      releaseDateOrigin: "url",
      releaseDateExplicit: false,
      releaseDateClaimIds: [],
    });
  });

  it("does not parse a single release announcement as a complete history source", () => {
    const announcement = source(
      "single-release-announcement",
      "react.dev",
      "React 19.3.0 is the latest stable release, released on September 9, 2026.",
      "React 19.3 release announcement",
      "https://react.dev/blog/react-19-3",
    );

    expect(
      extractOfficialReleaseHistoryClaimCandidates({
        question,
        entities: ["React"],
        requestedFacts: ["version", "release date", "stable status", "latestness"],
        sources: [announcement],
        officialSourcesRequired: true,
      }),
    ).toEqual([]);
  });

  it("keeps a generic byline date as publication-only without release context", () => {
    const page = source(
      "react-193-update",
      "react.dev",
      "A React 19.3 project update.\nSeptember 9, 2026 by The React Team.",
      "React 19.3 project update",
      "https://react.dev/blog/react-19-3-update",
    );
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim("update-version", "This page discusses React 19.3.", [page.id])],
      sources: [page],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: "19.3",
      pageDate: "2026-09-09",
      dateAssociationReason: "publication-date-only",
    });
    expect(records[0]).not.toHaveProperty("releaseDate");
  });

  it("does not use a search-provider date as page metadata, but accepts extracted page metadata", () => {
    const resultWithOnlySearchDate = {
      ...source(
        "serper-date-only",
        "react.dev",
        "React 19.3 is now available on npm!",
        "React 19.3 release announcement",
        "https://react.dev/blog/react-19-3",
      ),
      publishedAt: "2026-09-09T00:00:00.000Z",
    };
    const pageMetadataSource = {
      ...resultWithOnlySearchDate,
      id: "page-date-metadata",
      pagePublishedAt: "2026-09-09T00:00:00.000Z",
    };
    const claimFor = (sourceId: string) =>
      claim(`version-${sourceId}`, "React 19.3 is now available on npm!", [sourceId]);
    const extract = (candidate: Source) =>
      extractReleaseEvidenceRecords({
        question,
        entities: ["React"],
        claims: [claimFor(candidate.id)],
        sources: [candidate],
        officialSourcesRequired: true,
        stableRequired: true,
        releaseDateRequired: true,
      })[0];

    expect(extract(resultWithOnlySearchDate)).not.toHaveProperty("releaseDate");
    expect(extract(pageMetadataSource)).toMatchObject({
      releaseDate: "2026-09-09",
      dateAssociationReason: "dated-release-announcement",
    });
    expect(extract(pageMetadataSource)?.releaseDateClaimIds).toEqual([]);
  });

  it("does not bind a claimed date to a different release date in the source", () => {
    const release = source(
      "release-date-mismatch",
      "react.dev",
      "React 19.3 was released on September 10, 2026.",
      "React 19.3 release announcement",
    );
    const mismatchedClaim = claim(
      "wrong-release-date",
      "React 19.3 was released on September 9, 2026.",
      [release.id],
      release.content!,
    );
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [mismatchedClaim],
      sources: [release],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records[0]).toMatchObject({
      releaseDate: "2026-09-10",
      releaseDateClaimIds: [],
    });
  });

  it("recognizes explicit version-level stable wording but not feature-level stability", () => {
    const stable = source("stable", "react.dev", "React 19.3 is stable.");
    const featureOnly = source("feature", "react.dev", "Features are stable in React 19.3.");
    const stableRecord = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim("stable-claim", stable.content!, [stable.id])],
      sources: [stable],
      officialSourcesRequired: true,
      stableRequired: true,
    });
    const featureRecord = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim("feature-claim", featureOnly.content!, [featureOnly.id])],
      sources: [featureOnly],
      officialSourcesRequired: true,
      stableRequired: true,
    });

    expect(stableRecord[0]).toMatchObject({ version: "19.3", stability: "stable" });
    expect(featureRecord[0]).toMatchObject({ version: "19.3", stability: "unknown" });
  });

  it("keeps a single first-party GitHub release record as a candidate", () => {
    const githubRelease = {
      ...source(
        "github-react-release",
        "github.com",
        "React 19.3.0 is the latest stable release, released on September 9, 2026.",
        "React 19.3.0 release",
        "https://github.com/facebook/react/releases/tag/v19.3.0",
      ),
      firstPartyClassification: classifyFirstPartyGitHubSource(
        "https://github.com/facebook/react/releases/tag/v19.3.0",
      ),
    } satisfies Source;
    const result = assess(
      [claim("github-release-claim", githubRelease.content!, [githubRelease.id])],
      [githubRelease],
    );

    expect(result).toMatchObject({
      conclusion: "UNRESOLVED",
      releaseRecords: [
        expect.objectContaining({
          sourceId: githubRelease.id,
          sourceType: "official",
          officialSource: true,
          firstPartyClassification: {
            entity: "React",
            repository: "facebook/react",
            contentKind: "release_history",
          },
        }),
      ],
    });
    expect(result.latestVersion).toBeUndefined();
  });

  it("does not treat a stable version's existence as proof that it is latest", () => {
    const release = source("release-192", "react.dev", "React 19.2.0 is a stable release.");
    const result = assess([claim("claim-192", release.content!, [release.id])], [release]);

    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.highestCandidateVersion).toBe("19.2.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.unresolvedReasons[0]).toContain("no evidence establishes");
  });

  it("orders stable candidates while keeping the higher candidate unproven as latest", () => {
    const older = source("release-192", "react.dev", "React 19.2.0 is a stable release.");
    const newer = source("release-193", "react.dev", "React 19.3.0 is a stable release.");
    const result = assess(
      [
        claim("claim-192", older.content!, [older.id]),
        claim("claim-193", newer.content!, [newer.id]),
      ],
      [older, newer],
    );

    expect(result.conclusion).toBe("CANDIDATE_ONLY");
    expect(result.highestCandidateVersion).toBe("19.3.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.comparisons).toEqual([
      { olderVersion: "19.2.0", newerVersion: "19.3.0", sourceIds: [older.id, newer.id] },
    ]);
  });

  it("does not let a newer canary displace an explicitly stable candidate", () => {
    const stable = source("stable-release", "react.dev", "React 19.2.0 is a stable release.");
    const canary = source(
      "canary-release",
      "react.dev",
      "React 19.4.0-canary.1 is a canary release, not a stable release.",
    );
    const result = assess(
      [
        claim("stable-claim", stable.content!, [stable.id]),
        claim("canary-claim", canary.content!, [canary.id]),
      ],
      [stable, canary],
    );

    expect(result.candidateVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "19.2.0", stability: "stable" }),
        expect.objectContaining({ version: "19.4.0-canary.1", stability: "prerelease" }),
      ]),
    );
    expect(result.highestCandidateVersion).toBe("19.2.0");
    expect(result.comparisons).toEqual([]);
    expect(result.conclusion).toBe("UNRESOLVED");
  });

  it("does not treat a newer release candidate as the latest stable release", () => {
    const stable = source("stable-30", "react.dev", "React 3.0.0 is a stable release.");
    const releaseCandidate = source(
      "rc-31",
      "react.dev",
      "React 3.1.0-rc.1 is a prerelease release candidate, not a stable release.",
    );
    const result = assess(
      [
        claim("stable-30-claim", stable.content!, [stable.id]),
        claim("rc-31-claim", releaseCandidate.content!, [releaseCandidate.id]),
      ],
      [stable, releaseCandidate],
    );

    expect(result.candidateVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "3.0.0", stability: "stable", withdrawn: false }),
        expect.objectContaining({ version: "3.1.0-rc.1", stability: "prerelease" }),
      ]),
    );
    expect(result.highestCandidateVersion).toBe("3.0.0");
    expect(result.latestVersion).toBeUndefined();
  });

  it("does not treat a yanked stable release as the current latest candidate", () => {
    const history = source(
      "history-with-yanked-release",
      "react.dev",
      [
        "This complete stable release history lists React 3.0.0 as a stable release, released on 2026-09-01.",
        "React 3.1.0 is a stable release, released on 2026-09-15, but was yanked.",
      ].join("\n"),
      "Complete React stable release history",
    );
    const result = assess(
      [
        claim("history-30", "React 3.0.0 is a stable release, released on 2026-09-01.", [
          history.id,
        ]),
        claim("history-31-yanked", "React 3.1.0 is a stable release, released on 2026-09-15.", [
          history.id,
        ]),
      ],
      [history],
    );

    expect(result.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "3.1.0", stability: "stable", withdrawn: true }),
      ]),
    );
    expect(result.candidateVersions).toEqual(
      expect.arrayContaining([expect.objectContaining({ version: "3.1.0", withdrawn: true })]),
    );
    expect(result.highestCandidateVersion).toBe("3.0.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.conclusion).toBe("UNRESOLVED");

    const standaloneNotice = source(
      "standalone-yanked-notice",
      "react.dev",
      "React 3.1.0 was a stable release, but it was yanked and is no longer available.",
      "React 3.1.0 withdrawal notice",
      "https://react.dev/blog/react-3-1-withdrawal",
    );
    const standaloneResult = assess(
      [claim("standalone-yanked-claim", standaloneNotice.content!, [standaloneNotice.id])],
      [standaloneNotice],
    );

    expect(standaloneResult.releaseRecords).toEqual([
      expect.objectContaining({ version: "3.1.0", withdrawn: true }),
    ]);
    expect(standaloneResult.candidateVersions).toEqual(
      expect.arrayContaining([expect.objectContaining({ version: "3.1.0", withdrawn: true })]),
    );
    expect(standaloneResult.latestVersion).toBeUndefined();
  });

  it("keeps a website/GitHub latest-version disagreement unresolved", () => {
    const website = source(
      "official-site-history",
      "react.dev",
      [
        "This complete stable release history lists React 2.8.0 as a stable release, released on 2026-08-01.",
        "React 2.9.0 is the latest stable release, released on 2026-09-01.",
      ].join("\n"),
      "Complete React stable release history",
    );
    const githubUrl = "https://github.com/facebook/react/releases";
    const github = {
      ...source(
        "official-github-history",
        "github.com",
        [
          "This complete stable release history lists React 2.9.0 as a stable release, released on 2026-09-01.",
          "React 2.10.0 is the latest stable release, released on 2026-09-15.",
        ].join("\n"),
        "Complete React stable release history",
        githubUrl,
      ),
      firstPartyClassification: classifyFirstPartyGitHubSource(githubUrl),
    } satisfies Source;
    const claims = [
      claim("site-28", "React 2.8.0 is a stable release, released on 2026-08-01.", [website.id]),
      claim("site-29-latest", "React 2.9.0 is the latest stable release, released on 2026-09-01.", [
        website.id,
      ]),
      claim("github-29", "React 2.9.0 is a stable release, released on 2026-09-01.", [github.id]),
      claim(
        "github-210-latest",
        "React 2.10.0 is the latest stable release, released on 2026-09-15.",
        [github.id],
      ),
    ];
    const result = assess(claims, [website, github]);

    expect(result.conclusion).not.toBe("PROVEN");
    expect(result.highestCandidateVersion).toBe("2.10.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.completeHistorySourceIds).toEqual([website.id]);
    expect(result.unresolvedReasons.join(" ")).toMatch(/older version latest while newer/i);
    expect(result.unresolvedState).toMatchObject({
      status: "unresolved",
      reason: "conflicting_official_sources",
      recommendedNextAction: "retrieve_additional_official_evidence",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          version: "2.9.0",
          sourceIds: expect.arrayContaining([website.id, github.id]),
        }),
        expect.objectContaining({
          version: "2.10.0",
          sourceIds: [github.id],
        }),
      ]),
    });
  });

  it("keeps prerelease versions from different release channels incomparable", () => {
    const beta = source("react-beta", "react.dev", "React 19.4.0-beta.1 is a beta prerelease.");
    const canary = source(
      "react-canary",
      "react.dev",
      "React 19.4.0-canary.1 is a canary prerelease.",
    );
    const result = assess(
      [
        claim("beta-claim", beta.content!, [beta.id]),
        claim("canary-claim", canary.content!, [canary.id]),
      ],
      [beta, canary],
      false,
    );

    expect(result.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "19.4.0-beta.1", releaseChannel: "beta" }),
        expect.objectContaining({ version: "19.4.0-canary.1", releaseChannel: "canary" }),
      ]),
    );
    expect(result.comparisons).toEqual([]);
  });

  it("ignores an official sibling-product source for the requested entity", () => {
    const sibling = source(
      "react-native-release",
      "reactnative.dev",
      "React Native 0.81.0 is the latest stable release.",
      "React Native releases",
    );
    const result = assess([claim("sibling-claim", sibling.content!, [sibling.id])], [sibling]);

    expect(result.candidateVersions).toEqual([]);
    expect(result.conclusion).toBe("UNRESOLVED");
  });

  it("does not accept a newer non-official version when official evidence is required", () => {
    const official = source("official-192", "react.dev", "React 19.2.0 is a stable release.");
    const thirdParty = source(
      "third-party-193",
      "versions.example",
      "React 19.3.0 is the latest stable release.",
      "Independent version tracker",
    );
    const result = assess(
      [
        claim("official-claim", official.content!, [official.id]),
        claim("third-party-claim", thirdParty.content!, [thirdParty.id]),
      ],
      [official, thirdParty],
    );

    expect(result.candidateVersions.map((candidate) => candidate.version)).toEqual(["19.2.0"]);
    expect(result.highestCandidateVersion).toBe("19.2.0");
    expect(result.conclusion).toBe("UNRESOLVED");
  });

  it("records version ordering and corresponding dates from official release history", () => {
    const history = source(
      "official-history",
      "react.dev",
      "The React release history lists stable releases: React 19.2.0, released September 10, 2025; React 19.3.0, released October 12, 2025.",
      "React release history",
    );
    const result = assess(
      [
        claim("history-192", "React 19.2.0 is a stable release, released September 10, 2025.", [
          history.id,
        ]),
        claim("history-193", "React 19.3.0 is a stable release, released October 12, 2025.", [
          history.id,
        ]),
      ],
      [history],
    );

    expect(result.comparisons).toEqual([
      { olderVersion: "19.2.0", newerVersion: "19.3.0", sourceIds: [history.id] },
    ]);
    expect(result.highestCandidateVersion).toBe("19.3.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.conclusion).toBe("CANDIDATE_ONLY");
    expect(result.candidateVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "19.2.0", releaseDates: ["2025-09-10"] }),
        expect.objectContaining({ version: "19.3.0", releaseDates: ["2025-10-12"] }),
      ]),
    );
  });

  it("uses explicit completeness of an official history as closure, not mere search exhaustion", () => {
    const history = source(
      "complete-history",
      "react.dev",
      "This complete stable release history lists React 19.2.0, released September 10, 2025; React 19.3.0, released October 12, 2025.",
      "Complete React release history",
    );
    const result = assess(
      [
        claim("complete-192", "React 19.2.0 is a stable release, released September 10, 2025.", [
          history.id,
        ]),
        claim("complete-193", "React 19.3.0 is a stable release, released October 12, 2025.", [
          history.id,
        ]),
      ],
      [history],
    );

    expect(result).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "19.3.0",
      completeHistorySourceIds: [history.id],
    });
    expect(result.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "19.2.0", releaseDate: "2025-09-10" }),
        expect.objectContaining({ version: "19.3.0", releaseDate: "2025-10-12" }),
      ]),
    );
  });

  it("resolves latest stable versions for a generic entity from complete official history", () => {
    const pythonQuestion = "Identify the latest stable Python release.";
    const history = source(
      "complete-python-history",
      "python.org",
      "This complete stable release history lists Python 3.12.0, released September 10, 2025; Python 3.13.0, released October 12, 2025.",
      "Complete Python stable release history",
      "https://www.python.org/downloads/release-history/",
    );
    const claims = extractOfficialReleaseHistoryClaimCandidates({
      question: pythonQuestion,
      entities: ["Python"],
      requestedFacts: ["version", "stable status", "release status"],
      sources: [history],
      officialSourcesRequired: true,
    });
    const result = assessLatestnessEvidence({
      question: pythonQuestion,
      entities: ["Python"],
      claims,
      sources: [history],
      officialSourcesRequired: true,
      stableRequired: true,
    });

    expect(result).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "3.13.0",
      comparisons: [{ olderVersion: "3.12.0", newerVersion: "3.13.0" }],
      completeHistorySourceIds: [history.id],
    });
  });

  it("parses official version/date/status tables and compares complete stable history", () => {
    const url = "https://github.com/facebook/react/releases";
    const history = {
      ...source(
        "react-history-table",
        "github.com",
        [
          "This complete stable release history follows.",
          "| Version | Release date | Status |",
          "| --- | --- | --- |",
          "| 19.2.0 | 2025-09-15 | Stable |",
          "| 19.3.0 | 2026-09-09 | Stable |",
        ].join("\n"),
        "React releases",
        url,
      ),
      firstPartyClassification: classifyFirstPartyGitHubSource(url),
    } satisfies Source;
    const historyClaims = extractOfficialReleaseHistoryClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      sources: [history],
      officialSourcesRequired: true,
    });
    const result = assess(historyClaims, [history], true, true);

    expect(historyClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("19.2.0"),
          requestedFacts: expect.arrayContaining(["release date", "stable status"]),
          verification: expect.objectContaining({ verdict: "supported" }),
        }),
        expect.objectContaining({
          text: expect.stringContaining("19.3.0"),
          requestedFacts: expect.arrayContaining(["release date", "stable status"]),
          verification: expect.objectContaining({ verdict: "supported" }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "19.3.0",
      comparisons: [expect.objectContaining({ olderVersion: "19.2.0", newerVersion: "19.3.0" })],
    });
    expect(result.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "19.2.0",
          releaseDate: "2025-09-15",
          stability: "stable",
        }),
        expect.objectContaining({
          version: "19.3.0",
          releaseDate: "2026-09-09",
          stability: "stable",
        }),
      ]),
    );
  });

  it("does not close latestness from a single highest observed stable history entry", () => {
    const url = "https://github.com/facebook/react/releases";
    const history = {
      ...source(
        "partial-history-table",
        "github.com",
        "| Version | Release date | Status |\n| --- | --- | --- |\n| 19.3.0 | 2026-09-09 | Stable |",
        "React releases",
        url,
      ),
      firstPartyClassification: classifyFirstPartyGitHubSource(url),
    } satisfies Source;
    const claims = extractOfficialReleaseHistoryClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      sources: [history],
      officialSourcesRequired: true,
    });
    const result = assess(claims, [history], true, true);

    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.highestCandidateVersion).toBe("19.3.0");
    expect(result.latestVersion).toBeUndefined();
    expect(result.comparisons).toEqual([]);
  });

  it("keeps a history table's Published column distinct from its Release date", () => {
    const url = "https://github.com/facebook/react/releases";
    const history = {
      ...source(
        "published-history-table",
        "github.com",
        "| Version | Published | Status |\n| --- | --- | --- |\n| 19.3.0 | 2026-09-09 | Stable |",
        "React releases",
        url,
      ),
      firstPartyClassification: classifyFirstPartyGitHubSource(url),
    } satisfies Source;
    const claims = extractOfficialReleaseHistoryClaimCandidates({
      question,
      entities: ["React"],
      requestedFacts: ["version", "release date", "stable status"],
      sources: [history],
      officialSourcesRequired: true,
    });

    expect(claims).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("19.3.0"),
        requestedFacts: ["version", "stable status"],
      }),
    ]);
  });

  it("requires an unambiguous release date for the latest candidate when the date is requested", () => {
    const history = source(
      "history-missing-date",
      "react.dev",
      "This complete stable release history lists React 19.2.0, released September 10, 2025; React 19.3.0 is a stable release.",
      "Complete React release history",
    );
    const result = assess(
      [
        claim("dated-192", "React 19.2.0 is a stable release, released September 10, 2025.", [
          history.id,
        ]),
        claim("undated-193", "React 19.3.0 is a stable release.", [history.id]),
      ],
      [history],
      true,
      true,
    );

    expect(result.conclusion).toBe("CANDIDATE_ONLY");
    expect(result.proof).toBeUndefined();
    expect(result.latestVersion).toBeUndefined();
    expect(result.completeHistorySourceIds).toEqual([history.id]);
    expect(result.releaseRecords.find((record) => record.version === "19.3.0")?.releaseDate).toBe(
      undefined,
    );
  });

  it("compares all 85 complete structured releases when only 15 have claim-backed records", () => {
    const sourceId = "e174a0cca306d7ab";
    const historyRows = Array.from({ length: 84 }, (_, index) => {
      const releaseDate = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
      return {
        version: `18.${index}.0`,
        releaseDate,
        text: `React 18.${index}.0 is a stable release, released on ${releaseDate}.`,
      };
    });
    historyRows.push({
      version: "19.3.0",
      releaseDate: "2026-09-09",
      text: "React 19.3.0 is a stable release, released on 2026-09-09.",
    });
    const history = source(
      sourceId,
      "react.dev",
      ["This complete stable release history lists:", ...historyRows.map((row) => row.text)].join(
        "\n",
      ),
      "Complete React stable release history",
    );
    const boundedClaims = historyRows
      .slice(-15)
      .map((row, index) => claim(`history-claim-${index}`, row.text, [history.id]));

    const result = assess(boundedClaims, [history], true, true);

    expect(result.releaseRecords).toHaveLength(15);
    expect(result.candidateVersions).toHaveLength(85);
    expect(result.comparisons).toHaveLength((85 * 84) / 2);
    expect(
      result.comparisons.every((comparison) => comparison.sourceIds.includes(history.id)),
    ).toBe(true);
    expect(result).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "19.3.0",
      completeHistorySourceIds: ["e174a0cca306d7ab"],
      supportingSourceIds: ["e174a0cca306d7ab"],
      proofEvidence: expect.stringContaining("3570 pairwise version comparisons"),
    });
    expect(
      result.candidateVersions.find((candidate) => candidate.version === "19.3.0")?.releaseDates,
    ).toEqual(["2026-09-09"]);
  });

  it("excludes prereleases, withdrawn releases, drafts, and sibling entities from latest-stable comparisons", () => {
    const history = source(
      "filtered-history",
      "react.dev",
      [
        "This complete stable release history lists:",
        "React 19.1.0 is a stable release, released on 2026-07-01, but was withdrawn.",
        "React 19.2.0 is a stable release, released on 2026-08-01.",
        "React 19.3.0 is a stable release, released on 2026-09-09.",
        "React 19.4.0-rc.1 is a prerelease release candidate, released on 2026-09-20.",
        "React 19.4.0-rc.2 is a prerelease release candidate, released on 2026-09-21.",
        "Draft release: React 19.5.0 is a stable release, released on 2026-09-25.",
        '{"tag_name":"19.6.0","draft":true,"body":"React 19.6.0 is a stable release, released on 2026-09-26."}',
        "React Native 0.81.0 is a stable release, released on 2026-09-26.",
      ].join("\n"),
      "Complete React stable release history",
    );

    const result = assess([], [history], true, true);

    expect(result).toMatchObject({ conclusion: "PROVEN", latestVersion: "19.3.0" });
    expect(result.candidateVersions.map((candidate) => candidate.version)).not.toContain("19.5.0");
    expect(result.candidateVersions.map((candidate) => candidate.version)).not.toContain("19.6.0");
    expect(result.candidateVersions.map((candidate) => candidate.version)).not.toContain("0.81.0");
    expect(result.comparisons).toEqual([
      {
        olderVersion: "19.2.0",
        newerVersion: "19.3.0",
        sourceIds: [history.id],
      },
    ]);
  });

  it("does not promote when complete structured history lacks candidate stability evidence", () => {
    const history = source(
      "unknown-candidate-stability",
      "react.dev",
      [
        "This complete release history lists:",
        "| Version | Release date | Status |",
        "| --- | --- | --- |",
        "| 19.2.0 | 2026-08-01 | Stable |",
        "| 19.3.0 | 2026-09-09 | Unknown |",
      ].join("\n"),
      "Complete React release history",
    );

    const result = assess([], [history], true, true);

    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.latestVersion).toBeUndefined();
    expect(result.completeHistorySourceIds).toEqual([]);
  });

  it("keeps a partial official history unresolved even when it lists comparable stable releases", () => {
    const history = source(
      "partial-history-no-closure",
      "react.dev",
      [
        "React 19.2.0 is a stable release, released on 2026-08-01.",
        "React 19.3.0 is a stable release, released on 2026-09-09.",
      ].join("\n"),
      "React release history",
    );
    const claims = [
      claim("partial-192", "React 19.2.0 is a stable release, released on 2026-08-01.", [
        history.id,
      ]),
      claim("partial-193", "React 19.3.0 is a stable release, released on 2026-09-09.", [
        history.id,
      ]),
    ];

    const result = assess(claims, [history], true, true);

    expect(result.conclusion).not.toBe("PROVEN");
    expect(result.latestVersion).toBeUndefined();
    expect(result.completeHistorySourceIds).toEqual([]);
    expect(result.comparisons).toHaveLength(1);
  });

  it("keeps complete history unresolved when rows collapse to one comparable version", () => {
    const history = source(
      "semver-equivalent-history",
      "react.dev",
      [
        "This complete stable release history lists:",
        "React 19.3 is a stable release, released on 2026-09-09.",
        "React 19.3.0 is a stable release, released on 2026-09-09.",
      ].join("\n"),
      "Complete React stable release history",
    );

    const result = assess([], [history], true, true);

    expect(result.releaseHistoryResolution).toMatchObject({ complete: true, recordCount: 2 });
    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.latestVersion).toBeUndefined();
    expect(result.completeHistorySourceIds).toEqual([]);
    expect(result.comparisons).toEqual([]);
  });

  it("keeps conflicting stability between claim-backed and structured history unresolved", () => {
    const history = source(
      "conflicting-history-stability",
      "react.dev",
      [
        "This complete stable release history lists:",
        "React 19.2.0 is a stable release, released on 2026-08-01.",
        "React 19.3.0 is a stable release, released on 2026-09-09.",
        "React 19.3.0 version was a prerelease.",
      ].join("\n"),
      "Complete React stable release history",
    );
    const contradictoryClaim = claim(
      "react-193-prerelease-claim",
      "React 19.3.0 version was a prerelease.",
      [history.id],
    );

    const result = assess([contradictoryClaim], [history], true, true);

    expect(result.conclusion).not.toBe("PROVEN");
    expect(result.latestVersion).toBeUndefined();
    expect(result.stabilityConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "React",
          version: "19.3.0",
          stabilities: expect.arrayContaining(["stable", "prerelease"]),
        }),
      ]),
    );
  });

  it("does not close an official history when a listed version lacks verified claim provenance", () => {
    const history = source(
      "partially-read-history",
      "react.dev",
      "This complete stable release history lists React 19.2.0 and React 19.3.0.",
      "Complete React release history",
    );
    const result = assess(
      [claim("only-verified-entry", "React 19.2.0 is a stable release.", [history.id])],
      [history],
    );

    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.completeHistorySourceIds).toEqual([]);
  });

  it("keeps latestness unresolved when bounded evidence contains no closure proof", () => {
    const onlyResult = source("only-result", "react.dev", "React 4.2.0 is a stable release.");
    const result = assess(
      [claim("only-claim", onlyResult.content!, [onlyResult.id])],
      [onlyResult],
    );

    expect(result.conclusion).toBe("UNRESOLVED");
    expect(result.proof).toBeUndefined();
    expect(result.unresolvedReasons).toHaveLength(1);
  });

  it("does not complete release facts when the verifier timed out", () => {
    const release = source(
      "timed-out-release",
      "react.dev",
      "React 19.3.0 is the latest stable release, released on September 15, 2026.",
    );
    const unverified = claim("timed-out-claim", release.content!, [release.id]);
    unverified.verification = {
      verdict: "unavailable",
      rationale: "OpenRouter verifier request timed out.",
    };

    const releaseRecords = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [unverified],
      sources: [release],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const latestness = assess([unverified], [release], true, true);

    expect(releaseRecords).toEqual([]);
    expect(latestness.conclusion).toBe("UNRESOLVED");
    expect(latestness.latestVersion).toBeUndefined();
    expect(latestness.candidateVersions).toEqual([]);
  });

  it("retains source and claim provenance for every candidate and comparison", () => {
    const first = source("source-a", "react.dev", "React 3.2.0 is a stable release.");
    const second = source("source-b", "react.dev", "React 3.3.0 is a stable release.");
    const result = assess(
      [
        claim("claim-a", first.content!, [first.id]),
        claim("claim-b", second.content!, [second.id]),
      ],
      [first, second],
    );

    expect(result.candidateVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "3.2.0", sourceIds: [first.id], claimIds: ["claim-a"] }),
        expect.objectContaining({
          version: "3.3.0",
          sourceIds: [second.id],
          claimIds: ["claim-b"],
        }),
      ]),
    );
    expect(result.comparisons[0]?.sourceIds).toEqual([first.id, second.id]);
  });
});
