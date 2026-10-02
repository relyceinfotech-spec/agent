import { describe, expect, it } from "vitest";
import type { Source } from "../src/domain.js";
import {
  parseOfficialReleaseHistorySource,
  resolveOfficialReleaseHistory,
} from "../src/release-history.js";
import { classifyFirstPartyGitHubSource } from "../src/rank.js";

const question = "Compare official Python releases and identify the latest stable version.";

function source(overrides: Partial<Source> = {}): Source {
  const content = [
    "Python 3.12.0 | release date: 2023-10-02 | status: stable",
    "Python 3.13.0 | release date: 2024-10-07 | status: stable",
  ].join("\n");
  return {
    id: "python-history",
    title: "Python release history",
    url: "https://www.python.org/downloads/",
    snippet: content,
    domain: "www.python.org",
    sourceType: "official",
    content,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    ...overrides,
  };
}

describe("generic official release-history resolver", () => {
  it("parses a first-party release-history page with dated stable records", () => {
    const history = source();
    const records = parseOfficialReleaseHistorySource(history, question, "Python");

    expect(records).toEqual([
      expect.objectContaining({
        version: "3.12.0",
        releaseDate: "2023-10-02",
        stability: "stable",
        sourceKind: "official_history_page",
      }),
      expect.objectContaining({
        version: "3.13.0",
        releaseDate: "2024-10-07",
        stability: "stable",
        sourceKind: "official_history_page",
      }),
    ]);
  });

  it("recognizes exact first-party GitHub Releases HTML as a history source", () => {
    const url = "https://github.com/python/cpython/releases";
    const history = source({
      id: "cpython-releases-html",
      title: "Releases · python/cpython",
      url,
      domain: "github.com",
      firstPartyClassification: classifyFirstPartyGitHubSource(url),
      content:
        "3.12.0 | release date: 2023-10-02 | status: stable\n3.13.0 | release date: 2024-10-07 | status: stable",
    });

    expect(parseOfficialReleaseHistorySource(history, question, "Python")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKind: "github_releases_html", version: "3.13.0" }),
      ]),
    );
  });

  it("recognizes Atom/RSS and first-party structured history distinctly", () => {
    const feedUrl = "https://github.com/python/cpython/releases.atom";
    const feed = source({
      id: "cpython-releases-feed",
      title: "python/cpython releases",
      url: feedUrl,
      domain: "github.com",
      retrievalMethod: "rss",
      content: "Python 3.13.0 | published: 2024-10-07 | categories: Stable",
    });
    const apiUrl = "https://github.com/python/cpython/releases";
    const api = source({
      id: "cpython-releases-api",
      title: "python/cpython official GitHub Releases",
      url: apiUrl,
      domain: "github.com",
      releaseHistorySourceKind: "first_party_structured",
      releaseHistoryComplete: true,
      retrievalMethod: "structured",
      content:
        "3.12.0 | release date: 2023-10-02 | status: stable\n3.13.0 | release date: 2024-10-07 | status: stable",
    });

    expect(parseOfficialReleaseHistorySource(feed, question, "Python")).toEqual([
      expect.objectContaining({
        sourceKind: "github_releases_feed",
        releaseDate: "2024-10-07",
        stability: "stable",
      }),
    ]);
    expect(parseOfficialReleaseHistorySource(api, question, "Python")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "first_party_structured",
          version: "3.13.0",
          completeHistory: true,
        }),
      ]),
    );
  });

  it("prefers a complete lower-tier history over an incomplete higher-tier page", () => {
    const partialPage = source({
      id: "partial-python-page",
      content: "Python 3.13.0 | release date: 2024-10-07 | status: stable",
    });
    const structuredUrl = "https://github.com/python/cpython/releases";
    const completeStructured = source({
      id: "complete-python-api",
      title: "python/cpython official GitHub Releases",
      url: structuredUrl,
      domain: "github.com",
      releaseHistorySourceKind: "first_party_structured",
      releaseHistoryComplete: true,
      content:
        "3.12.0 | release date: 2023-10-02 | status: stable\n3.13.0 | release date: 2024-10-07 | status: stable",
    });
    const resolved = resolveOfficialReleaseHistory({
      sources: [partialPage, completeStructured],
      question,
      entity: "Python",
    });

    expect(resolved).toMatchObject({
      complete: true,
      selectedKind: "first_party_structured",
      sourceIds: [completeStructured.id],
      completeSourceIds: [completeStructured.id],
    });
    expect(resolved.attemptedKinds).toEqual(["official_history_page", "first_party_structured"]);
  });

  it("keeps incomplete or single-version histories incomplete", () => {
    const partial = source({
      releaseHistoryComplete: false,
      content: "Python 3.13.0 | release date: 2024-10-07 | status: stable",
    });
    const resolved = resolveOfficialReleaseHistory({
      sources: [partial],
      question,
      entity: "Python",
    });

    expect(resolved.complete).toBe(false);
    expect(resolved.completeSourceIds).toEqual([]);
    expect(resolved.records).toHaveLength(1);
  });

  it("normalizes chronological ISO dates and preserves an explicitly missing date", () => {
    const history = source({
      id: "python-dated-history",
      title: "Complete Python stable release history",
      content: [
        "Python 3.14.0 is a stable release, released on 2026-09-01.",
        "Python 3.15.0 is a stable release, released on 2026-09-15.",
        "Python 3.16.0 is a stable release with no recorded release date.",
      ].join("\n"),
    });
    const records = parseOfficialReleaseHistorySource(history, question, "Python");

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "3.14.0", releaseDate: "2026-09-01" }),
        expect.objectContaining({ version: "3.15.0", releaseDate: "2026-09-15" }),
        expect.objectContaining({ version: "3.16.0", releaseDate: undefined }),
      ]),
    );
  });

  it("distinguishes stable, prerelease, and unknown without borrowing feature stability", () => {
    const history = source({
      content: [
        "This complete stable release history lists:",
        "Python 3.14.0-rc.1 | release date: 2025-07-15 | status: prerelease",
        "Python 3.14.0 | release date: 2025-10-07 | status: stable",
        "Python 3.15.0 APIs are stable.",
      ].join("\n"),
    });
    const records = parseOfficialReleaseHistorySource(history, question, "Python");

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "3.14.0-rc.1", stability: "prerelease" }),
        expect.objectContaining({ version: "3.14.0", stability: "stable" }),
      ]),
    );
    expect(records.find((record) => record.version === "3.15.0")).toMatchObject({
      stability: "unknown",
    });
  });

  it("rejects a mismatched first-party entity", () => {
    const url = "https://github.com/facebook/react/releases";
    const react = source({
      title: "Releases · facebook/react",
      url,
      domain: "github.com",
      firstPartyClassification: classifyFirstPartyGitHubSource(url),
    });

    expect(parseOfficialReleaseHistorySource(react, question, "Python")).toEqual([]);
  });
});
