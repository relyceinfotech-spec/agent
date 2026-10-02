import { describe, expect, it } from "vitest";
import {
  classifyEvidenceStatus,
  extractRequestedFacts,
  missingRequestedFactSupport,
  requestedFactCoverage,
} from "../src/requested-facts.js";

const releaseQuestion =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";

describe("task-specific requested-fact evidence", () => {
  it("extracts explicit version, date, stable, and latest requirements from natural language", () => {
    expect(extractRequestedFacts(releaseQuestion)).toEqual([
      "version",
      "release date",
      "stable status",
      "latestness",
    ]);
    expect(extractRequestedFacts("What is the latest version of React?")).toEqual([
      "version",
      "latestness",
    ]);
    expect(extractRequestedFacts("What is the stable version of React?")).toEqual([
      "version",
      "stable status",
    ]);
    expect(extractRequestedFacts("What is the release date for React 19.3?")).toEqual([
      "release date",
    ]);
    expect(extractRequestedFacts("What is the release status of React 19.3?")).toEqual([
      "release status",
    ]);
    expect(extractRequestedFacts("What are React's capabilities?")).toEqual([]);
  });

  it("recognizes support lifecycle only when explicitly enabled for Research Chat", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";

    expect(extractRequestedFacts(question)).toEqual([]);
    expect(extractRequestedFacts(question, { includeSupportLifecycle: true })).toEqual([
      "end-of-life date",
    ]);
  });

  it("requires the lifecycle date, marker, entity, and requested version in one passage", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const requestedFacts = extractRequestedFacts(question, { includeSupportLifecycle: true });
    const supported = "Node.js 22 reaches end of life on 2027-04-30.";

    expect(requestedFactCoverage(question, supported, { requestedFacts }).present).toEqual([
      "end-of-life date",
    ]);
    expect(
      requestedFactCoverage(question, "Node.js 20 reaches end of life on 2027-04-30.", {
        requestedFacts,
      }).present,
    ).toEqual([]);
    expect(
      requestedFactCoverage(question, "Node.js 22 is supported. End of life: 2027-04-30.", {
        requestedFacts,
      }).present,
    ).toEqual([]);
    expect(
      requestedFactCoverage(question, "Node.js 22 is supported through April 2027.", {
        requestedFacts,
      }).present,
    ).toEqual([]);
    expect(
      requestedFactCoverage(question, "Node.js 22 is actively supported until April 2027.", {
        requestedFacts,
      }).present,
    ).toEqual([]);
  });

  it("classifies generic supported claims separately from fact-supporting evidence", () => {
    const genericClaims = ["The React versions page links to release documentation."];

    expect(classifyEvidenceStatus(releaseQuestion, genericClaims)).toBe("GENERIC_SUPPORT");
    expect(classifyEvidenceStatus(releaseQuestion, [])).toBe("INSUFFICIENT_EVIDENCE");
    expect(missingRequestedFactSupport(releaseQuestion, genericClaims)).toEqual([
      "the requested version is not stated in a verified claim",
      "the requested release date is not stated in a verified claim",
      "the requested version is not explicitly identified as stable",
      "the requested latest/stable status is not established by a versioned claim",
    ]);
  });

  it("requires each requested precise fact before classifying evidence as sufficient", () => {
    const versionOnly = "React 19.2.0 is the latest stable release.";
    const dateOnly = "The latest stable React release was published on September 15, 2026.";
    const verifiedRelease =
      "React 19.2.0 is the latest stable release and was released on September 15, 2026.";

    expect(classifyEvidenceStatus(releaseQuestion, [versionOnly])).toBe("GENERIC_SUPPORT");
    expect(classifyEvidenceStatus(releaseQuestion, [dateOnly])).toBe("GENERIC_SUPPORT");
    expect(
      requestedFactCoverage(releaseQuestion, "React 19.2.0 was released on September 15, 2026."),
    ).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date"],
      missing: ["stable status", "latestness"],
    });
    expect(
      requestedFactCoverage(
        releaseQuestion,
        "React 19.2.0 is the latest release, dated September 15, 2026.",
      ),
    ).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date"],
      missing: ["stable status", "latestness"],
    });
    expect(
      requestedFactCoverage(
        releaseQuestion,
        "React 19.2.0 is the latest stable release, released on September 15, 2026.",
      ).missing,
    ).toEqual([]);
    expect(requestedFactCoverage(releaseQuestion, dateOnly)).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: [],
      missing: ["version", "release date", "stable status", "latestness"],
    });
    expect(requestedFactCoverage(releaseQuestion, verifiedRelease)).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date", "stable status", "latestness"],
      missing: [],
    });
    expect(classifyEvidenceStatus(releaseQuestion, [verifiedRelease])).toBe("SUPPORTED_EVIDENCE");
  });

  it("requires stable evidence to be tied to a version and rejects canary as stable", () => {
    expect(
      requestedFactCoverage("What is the latest stable React version?", [
        "React 19.3.0 is the latest stable version.",
      ]),
    ).toEqual({
      required: ["version", "stable status", "latestness"],
      present: ["version", "stable status", "latestness"],
      missing: [],
    });

    expect(
      requestedFactCoverage("What is the latest stable React version?", [
        "React 19.4.0-canary.1 is the latest stable version.",
      ]).present,
    ).toEqual(["version"]);

    expect(
      requestedFactCoverage("What is the latest stable React version?", [
        "Features are stable in React 19.3.0.",
      ]).present,
    ).toEqual(["version"]);
    expect(
      requestedFactCoverage("What is the stable React version?", [
        "React 19.3.0 is a stable release.",
      ]).present,
    ).toEqual(["version", "stable status"]);
  });

  it("uses one matching structured release record and enforces official provenance", () => {
    const records = [
      {
        entity: "React",
        version: "19.2.0",
        releaseDate: "2025-09-15",
        stability: "stable" as const,
        officialSource: true,
        releaseDateClaimIds: ["react-192-date"],
      },
      {
        entity: "React",
        version: "19.3.0",
        stability: "stable" as const,
        officialSource: true,
      },
    ];

    expect(
      requestedFactCoverage(releaseQuestion, [], {
        releaseEvidence: records,
        officialSourcesRequired: true,
        latestnessVersion: "19.3.0",
        latestnessProven: false,
      }),
    ).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "stable status"],
      missing: ["release date", "latestness"],
    });

    expect(
      requestedFactCoverage(releaseQuestion, [], {
        releaseEvidence: [{ ...records[0]!, officialSource: false }],
        officialSourcesRequired: true,
        latestnessProven: false,
      }).present,
    ).toEqual([]);

    expect(
      requestedFactCoverage(releaseQuestion, [], {
        releaseEvidence: [{ ...records[0]!, releaseDateClaimIds: [] }],
        officialSourcesRequired: true,
        latestnessProven: false,
      }).present,
    ).toEqual(["version", "stable status"]);
  });

  it("recognizes newest/current version language as a latestness requirement", () => {
    expect(requestedFactCoverage("What is the newest React version?", "React 19.3.0")).toEqual({
      required: ["version", "latestness"],
      present: ["version"],
      missing: ["latestness"],
    });
    expect(
      requestedFactCoverage("What is the current stable version of React?", "React 19.3.0 stable"),
    ).toEqual({
      required: ["version", "stable status", "latestness"],
      present: ["version"],
      missing: ["stable status", "latestness"],
    });
  });

  it("lets a provenance-checked controller proof satisfy latestness without weakening other facts", () => {
    const evidence = "React 19.3.0 is a stable release published on September 15, 2026.";
    expect(requestedFactCoverage(releaseQuestion, evidence, { latestnessProven: true })).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date", "stable status", "latestness"],
      missing: [],
    });

    expect(
      requestedFactCoverage(
        releaseQuestion,
        "React 19.2.0 is the latest stable release, released on September 15, 2025.",
        { latestnessProven: false },
      ).missing,
    ).toEqual(["latestness"]);
  });

  it("preserves generic research behavior when no precise value was requested", () => {
    expect(
      classifyEvidenceStatus("Explain the React release process.", [
        "The official React release history links to detailed release documentation.",
      ]),
    ).toBe("SUPPORTED_EVIDENCE");
  });
});
