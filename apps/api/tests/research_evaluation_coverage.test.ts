import type { ReleaseEvidenceRecord } from "../src/domain.js";
import { researchFactCoverage } from "../src/evaluation/research-fact-coverage.js";
import { describe, expect, it } from "vitest";

const question =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";

const officialStableRecord: ReleaseEvidenceRecord = {
  entity: "React",
  version: "19.3.0",
  releaseDate: "2026-09-09",
  releaseDateClaimIds: ["react-date-claim"],
  stability: "stable",
  stabilityExplicit: true,
  stabilityEvidence: "React 19.3.0 is an explicitly identified stable release.",
  sourceId: "react-official-history",
  claimIds: [],
  officialSource: true,
  releaseHistoryComplete: false,
};

describe("research evaluation requested-fact coverage", () => {
  it("reports explicit official release-record stability without claiming unresolved latestness", () => {
    const result = researchFactCoverage({
      question,
      verifiedClaimTexts: ["React 19.3.0 was released on September 9, 2026."],
      verifiedOfficialClaimTexts: ["React 19.3.0 was released on September 9, 2026."],
      latestnessProven: false,
      latestnessVersion: "19.3.0",
      releaseRecords: [officialStableRecord],
      officialSourcesRequired: true,
    });

    expect(result.requested.present).toEqual(["version", "release date", "stable status"]);
    expect(result.official.present).toEqual(["version", "release date", "stable status"]);
    expect(result.requested.missing).toEqual(["latestness"]);
    expect(result.official.missing).toEqual(["latestness"]);
  });

  it("does not let a non-official record satisfy the official evidence summary", () => {
    const result = researchFactCoverage({
      question,
      verifiedClaimTexts: ["React 19.3.0 was released on September 9, 2026."],
      verifiedOfficialClaimTexts: [],
      latestnessProven: false,
      latestnessVersion: "19.3.0",
      releaseRecords: [{ ...officialStableRecord, officialSource: false }],
      officialSourcesRequired: false,
    });

    expect(result.requested.present).toEqual(["version", "release date", "stable status"]);
    expect(result.official.present).toEqual([]);
    expect(result.official.missing).toEqual([
      "version",
      "release date",
      "stable status",
      "latestness",
    ]);
  });
});
