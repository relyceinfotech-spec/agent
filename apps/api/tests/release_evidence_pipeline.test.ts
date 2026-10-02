import { describe, expect, it } from "vitest";
import type { Claim, QueryInterpretation, Source } from "../src/domain.js";
import { auditResearchCitations } from "../src/llm.js";
import { applyCanonicalFactCoverageToObjectives } from "../src/research.js";
import { generateStructuredObjectives } from "../src/planner.js";
import {
  isOfficialSourceForEntities,
  rankResults,
  selectResearchSourcesWithDecisions,
} from "../src/rank.js";
import { extractRequestedFacts, requestedFactCoverage } from "../src/requested-facts.js";
import { validateCitationEntailment } from "../src/citation-entailment.js";
import {
  assessLatestnessEvidence,
  extractReleaseEvidenceRecords,
} from "../src/version-evidence.js";

const question =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";

function source(
  id: string,
  url: string,
  title: string,
  content: string,
  snippet = content,
): Source {
  const parsed = new URL(url);
  return {
    id,
    url,
    title,
    snippet,
    content,
    domain: parsed.hostname,
    sourceType: parsed.hostname === "github.com" ? "unknown" : "official",
    quality: { relevance: 1, authority: 0.95, freshness: 1, completeness: 1, overall: 1 },
  };
}

function supportedClaim(id: string, sourceId: string, text: string): Claim {
  return {
    id,
    text,
    evidence: text,
    sourceIds: [sourceId],
    confidence: 1,
    verification: { verdict: "supported", rationale: "Deterministic exact fixture." },
  };
}

function interpretation(): QueryInterpretation {
  return {
    normalizedQuestion: question,
    intent: "current_information",
    entities: ["React"],
    topic: "React release",
    dimensions: ["version", "release date"],
    corrections: [],
    ambiguityScore: 0,
    ambiguityReasons: [],
    needsClarification: false,
    sourceRequirements: { officialSources: "required" },
  };
}

describe("release evidence pipeline regression", () => {
  it("binds release metadata across eligible sources and produces consistent objective, citation, and persisted-state inputs", async () => {
    const react192 = source(
      "react-192",
      "https://react.dev/blog/2025/10/01/react-19-2",
      "React 19.2 release",
      "React 19.2 is a stable release, released on October 1, 2025.",
    );
    const react193 = source(
      "react-193",
      "https://react.dev/blog/2026/09/09/react-19-3",
      "React 19.3 – React",
      "React 19.3 is now available on npm. Both of these are now stable in React 19.3.",
      "September 9, 2026 by The React Team. React 19.3 was released on September 9, 2026.",
    );
    const history = source(
      "react-history",
      "https://github.com/react/react/releases",
      "Releases · react/react",
      "React 19.3 is the latest stable release. React 19.3 is a stable release.",
    );
    const reactNative = source(
      "react-native",
      "https://reactnative.dev/versions",
      "React Native releases",
      "React Native 0.81.0 is a stable release.",
    );
    const thirdParty = source(
      "third-party",
      "https://versions.example/react",
      "React version tracker",
      "React 19.4 is the latest stable release.",
    );
    const sources = [react192, react193, history, reactNative, thirdParty];
    const ranked = rankResults(
      question,
      sources.map(({ title, url, snippet }) => ({ title, url, snippet })),
    );
    const selection = selectResearchSourcesWithDecisions(
      ranked,
      ["React"],
      5,
      "required",
      question,
    );
    expect(selection.selected.map((item) => item.url)).toEqual(
      expect.arrayContaining([react192.url, react193.url, history.url]),
    );
    expect(selection.selected.map((item) => item.url)).not.toContain(reactNative.url);
    expect(selection.selected.map((item) => item.url)).not.toContain(thirdParty.url);

    const claims = [
      supportedClaim("claim-192", react192.id, react192.content!),
      supportedClaim("claim-193-announcement", react193.id, "React 19.3 is now available on npm."),
      supportedClaim(
        "claim-193-date",
        react193.id,
        "React 19.3 was released on September 9, 2026.",
      ),
      supportedClaim("claim-193-history", history.id, history.content!),
      supportedClaim("claim-native", reactNative.id, reactNative.content!),
      supportedClaim("claim-third-party", thirdParty.id, thirdParty.content!),
    ];
    const officialClaims = claims.filter((claim) =>
      claim.sourceIds.some((sourceId) => {
        const item = sources.find((candidate) => candidate.id === sourceId)!;
        return isOfficialSourceForEntities(item, ["React"]);
      }),
    );

    const releaseRecords = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources,
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const react193Record = releaseRecords.find((record) => record.version === "19.3");

    expect(react193Record).toMatchObject({
      releaseDate: "2026-09-09",
      dateAssociationReason: "versioned-release-statement",
      releaseDateExplicit: true,
      releaseDateOrigin: "snippet",
      releaseDateSourceIds: [react193.id],
      stability: "stable",
      stabilitySourceIds: [history.id],
      latestnessSourceIds: [history.id],
      sourceIds: [react193.id, history.id],
    });
    expect(react193Record?.featureStabilityEvidence).toBeUndefined();
    expect(releaseRecords.map((record) => record.version)).not.toContain("0.81.0");
    expect(releaseRecords.map((record) => record.version)).not.toContain("19.4");

    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims: officialClaims,
      sources,
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
      releaseRecords,
    });
    expect(latestness).toMatchObject({
      conclusion: "CANDIDATE_ONLY",
      comparisons: [{ olderVersion: "19.2", newerVersion: "19.3" }],
    });
    expect(latestness.latestVersion).toBeUndefined();

    const requestedFacts = extractRequestedFacts(question);
    const coverage = requestedFactCoverage(
      question,
      officialClaims.map((claim) => claim.text),
      {
        requestedFacts,
        releaseEvidence: releaseRecords,
        officialSourcesRequired: true,
        latestnessVersion: latestness.latestVersion,
        latestnessProven: latestness.conclusion === "PROVEN",
      },
    );
    expect(coverage).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date", "stable status"],
      missing: ["latestness"],
    });

    const objectives = generateStructuredObjectives(interpretation(), "quick", requestedFacts);
    const objectiveCoverage = applyCanonicalFactCoverageToObjectives(
      objectives,
      coverage,
      releaseRecords,
      latestness,
      officialClaims,
      sources,
      ["React"],
    );
    expect(
      objectives
        .filter((objective) => objective.importance === "critical")
        .every((objective) => objective.status === "fulfilled"),
    ).toBe(false);
    expect(
      objectiveCoverage?.some((objective) => objective.missingFacts.includes("latestness")),
    ).toBe(true);
    expect(
      objectiveCoverage?.find((objective) => objective.objectiveId === "obj-release-date")
        ?.sourceIds,
    ).toContain(react193.id);

    const answer =
      "React 19.3 was released on September 9, 2026. [1]\n\nReact 19.3 is the latest stable release. [2]";
    expect(auditResearchCitations(answer, 2)).toEqual({ invalidMarkers: [], uncitedSentences: [] });
    const semanticAudit = await validateCitationEntailment(answer, [react193, history]);
    expect(semanticAudit.status).toBe("VALIDATED");
    expect(semanticAudit.finalAnswer).toBe(answer);

    // Research sessions are persisted as a complete JSON snapshot; this fixture
    // ensures the new evidence/objective fields remain serializable in that shape.
    const persistedSnapshot = JSON.parse(
      JSON.stringify({
        answer,
        state: {
          requestedFactCoverage: coverage,
          objectiveCoverage,
          releaseRecords,
          latestnessAssessment: latestness,
        },
      }),
    );
    expect(persistedSnapshot.state.requestedFactCoverage).toEqual(coverage);
    expect(persistedSnapshot.state.releaseRecords[0].sourceIds).toBeDefined();
    expect(persistedSnapshot.state.latestnessAssessment.comparisons).toHaveLength(1);
  });

  it("keeps partial facts partial and fails closed for missing date, feature-only stability, or unproven latestness", () => {
    const announcement = source(
      "dated-features-only",
      "https://react.dev/blog/2026/09/09/react-19-3",
      "React 19.3 release announcement",
      "React 19.3 is now available on npm. Both of these are now stable in React 19.3.",
    );
    const claim = supportedClaim(
      "claim-release",
      announcement.id,
      "React 19.3 is now available on npm.",
    );
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim],
      sources: [announcement],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims: [claim],
      sources: [announcement],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
      releaseRecords: records,
    });
    const coverage = requestedFactCoverage(question, [claim.text], {
      requestedFacts: extractRequestedFacts(question),
      releaseEvidence: records,
      latestnessVersion: latestness.highestCandidateVersion,
      latestnessProven: false,
      officialSourcesRequired: true,
    });

    expect(records[0]).toMatchObject({ releaseDate: "2026-09-09", stability: "unknown" });
    expect(coverage.present).toEqual(["version"]);
    expect(coverage.missing).toEqual(["release date", "stable status", "latestness"]);
    expect(records[0]?.releaseDateClaimIds).toEqual([]);
    expect(latestness.conclusion).toBe("UNRESOLVED");

    const noDateSource = source(
      "no-date",
      "https://react.dev/releases",
      "React 19.3 release notes",
      "React 19.3 is a stable release.",
    );
    const noDateClaim = supportedClaim("claim-no-date", noDateSource.id, noDateSource.content!);
    const noDateRecords = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [noDateClaim],
      sources: [noDateSource],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    expect(noDateRecords[0]?.releaseDate).toBeUndefined();
  });

  it("does not mark release objectives completed when only version existence is covered", () => {
    const requestedFacts = extractRequestedFacts(question);
    const objectives = generateStructuredObjectives(interpretation(), "quick", requestedFacts);
    const coverage = {
      required: requestedFacts,
      present: ["version"] as const,
      missing: ["release date", "stable status", "latestness"] as const,
    };
    const release = source(
      "partial-release",
      "https://react.dev/blog/react-19-3",
      "React 19.3 release notes",
      "React 19.3 is now available. A feature in the release is stable.",
    );
    const claim = supportedClaim("partial-claim", release.id, release.content!);

    applyCanonicalFactCoverageToObjectives(
      objectives,
      coverage,
      [
        {
          entity: "React",
          version: "19.3",
          stability: "unknown",
          stabilityReason: "feature-stability-only",
          featureStabilityEvidence: "A feature in the release is stable.",
          sourceId: release.id,
          sourceIds: [release.id],
          claimIds: [claim.id],
          versionSourceIds: [release.id],
          versionClaimIds: [claim.id],
          officialSource: true,
        },
      ],
      {
        required: true,
        conclusion: "UNRESOLVED",
        requestedEntity: "React",
        highestCandidateVersion: "19.3",
        candidateVersions: [],
        releaseRecords: [],
        comparisons: [],
        supportingSourceIds: [],
        completeHistorySourceIds: [],
        unresolvedReasons: ["No latestness proof."],
      },
      [claim],
      [release],
      ["React"],
    );

    expect(objectives.find((objective) => objective.id === "obj-version-status")).toMatchObject({
      status: "partial",
      presentFacts: ["version"],
      missingFacts: ["stable status", "latestness"],
    });
    expect(objectives.find((objective) => objective.id === "obj-release-date")).toMatchObject({
      status: "pending",
      missingFacts: ["release date"],
      sourceIds: [],
      evidenceIds: [],
    });
    expect(objectives.some((objective) => objective.status === "fulfilled")).toBe(false);
  });

  it("binds field-level provenance to the supported claim that actually establishes each release fact", () => {
    const release = source(
      "fact-provenance",
      "https://react.dev/blog/2026/09/09/react-19-3",
      "React 19.3 release",
      "React 19.3 was released on September 9, 2026. React 19.3 is a stable release. React 19.3 is the latest stable release.",
    );
    const claims = [
      supportedClaim(
        "claim-release-date",
        release.id,
        "React 19.3 was released on September 9, 2026.",
      ),
      supportedClaim("claim-stability", release.id, "React 19.3 is a stable release."),
      supportedClaim("claim-latestness", release.id, "React 19.3 is the latest stable release."),
    ];

    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources: [release],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const record = records[0];

    expect(record).toMatchObject({
      releaseDateClaimIds: ["claim-release-date"],
      stabilityClaimIds: ["claim-stability", "claim-latestness"],
      latestnessClaimIds: ["claim-latestness"],
    });
  });

  it("does not promote unverified page-level stability or latestness from a supported version-only claim", () => {
    const release = source(
      "unverified-page-facts",
      "https://react.dev/blog/2026/09/09/react-19-3",
      "React 19.3 release",
      "React 19.3 is now available on npm. React 19.3 is the latest stable release.",
    );
    const claim = supportedClaim(
      "claim-version-event-only",
      release.id,
      "React 19.3 is now available on npm.",
    );

    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims: [claim],
      sources: [release],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });
    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims: [claim],
      sources: [release],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
      releaseRecords: records,
    });

    expect(records[0]).toMatchObject({
      releaseDate: "2026-09-09",
      stability: "unknown",
      latestnessEvidence: undefined,
      stabilityClaimIds: [],
      latestnessClaimIds: [],
    });
    expect(latestness.conclusion).toBe("UNRESOLVED");
  });

  it("does not let lexical third-party claims satisfy official release-fact requirements", () => {
    const coverage = requestedFactCoverage(
      question,
      ["React 19.4 is the latest stable release, released on September 10, 2026."],
      {
        requestedFacts: ["version", "release date", "stable status", "latestness"],
        officialSourcesRequired: true,
        releaseEvidence: [],
        latestnessProven: false,
      },
    );

    expect(coverage).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: [],
      missing: ["version", "release date", "stable status", "latestness"],
    });
  });

  it("preserves same-version field conflicts and prevents conflicted fields from satisfying coverage", () => {
    const first = source(
      "date-a",
      "https://react.dev/blog/2026/09/09/react-19-3",
      "React 19.3 release",
      "React 19.3 is a stable release, released on September 9, 2026.",
    );
    const second = source(
      "date-b",
      "https://react.dev/blog/2026/09/10/react-19-3-correction",
      "React 19.3 release correction",
      "React 19.3 is a stable release, released on September 10, 2026.",
    );
    const claims = [
      supportedClaim("claim-date-a", first.id, first.content!),
      supportedClaim("claim-date-b", second.id, second.content!),
    ];
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources: [first, second],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseDateRequired: true,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: "19.3",
      releaseDateConflicts: ["2026-09-09", "2026-09-10"],
      stability: "stable",
    });
    const coverage = requestedFactCoverage(
      question,
      claims.map((claim) => claim.text),
      {
        requestedFacts: ["release date", "stable status"],
        releaseEvidence: records,
        latestnessVersion: "19.3",
        officialSourcesRequired: true,
      },
    );
    expect(coverage).toEqual({
      required: ["release date", "stable status"],
      present: ["stable status"],
      missing: ["release date"],
    });
  });

  it("does not count feature stability as release stability or accept nearby generic stable wording", () => {
    const featureOnly = source(
      "feature-only",
      "https://react.dev/blog/react-19-3",
      "React 19.3 feature update",
      "Feature X is stable in React 19.3.",
    );
    const featureClaim = supportedClaim("feature-claim", featureOnly.id, featureOnly.content!);
    const records = extractReleaseEvidenceRecords({
      question: "What is the stable React release?",
      entities: ["React"],
      claims: [featureClaim],
      sources: [featureOnly],
      officialSourcesRequired: true,
      stableRequired: true,
    });
    expect(records[0]).toMatchObject({
      stability: "unknown",
      stabilityReason: "feature-stability-only",
      featureStabilityEvidence: "Feature X is stable in React 19.3.",
    });
  });

  it("records contradictory stable/prerelease evidence instead of proving a latest stable version", () => {
    const stable = source(
      "stable-assertion",
      "https://react.dev/releases/stable",
      "React stable releases",
      "React 19.3 is a stable release.",
    );
    const prerelease = source(
      "prerelease-assertion",
      "https://github.com/react/react/releases",
      "React release channel",
      "React 19.3 is a prerelease release.",
    );
    const claims = [
      supportedClaim("stable-claim", stable.id, stable.content!),
      supportedClaim("prerelease-claim", prerelease.id, prerelease.content!),
    ];
    const records = extractReleaseEvidenceRecords({
      question,
      entities: ["React"],
      claims,
      sources: [stable, prerelease],
      officialSourcesRequired: true,
      stableRequired: true,
    });
    const latestness = assessLatestnessEvidence({
      question,
      entities: ["React"],
      claims,
      sources: [stable, prerelease],
      officialSourcesRequired: true,
      stableRequired: true,
      releaseRecords: records,
    });

    expect(records[0]?.stability).toBe("unknown");
    expect(records[0]?.stabilityConflicts).toEqual(["stable", "prerelease"]);
    expect(latestness.conclusion).toBe("UNRESOLVED");
    expect(latestness.stabilityConflicts).toHaveLength(1);
  });
});
