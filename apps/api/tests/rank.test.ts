import { describe, expect, it } from "vitest";
import {
  classifyFirstPartyGitHubSource,
  isOfficialSourceForEntities,
  rankResults,
  selectResearchSources,
  selectResearchSourcesWithDecisions,
} from "../src/rank.js";

describe("rankResults", () => {
  it("deduplicates URLs and returns explainable scores", () => {
    const result = rankResults("climate policy", [
      {
        title: "Climate policy",
        url: "https://www.gov.example/a?utm_source=x",
        snippet: "Climate policy evidence",
      },
      { title: "Duplicate", url: "https://www.gov.example/a", snippet: "same" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].quality.overall).toBeGreaterThan(0);
  });

  it("prioritizes official version evidence over recently crawled tutorials", () => {
    const ranked = rankResults("What is the latest React version?", [
      {
        title: "React Tutorial",
        url: "https://www.tutorialspoint.com/reactjs/index.htm",
        snippet: "What is the latest React version? Learn React with this tutorial.",
        publishedAt: new Date().toISOString(),
        provider: "serper",
      },
      {
        title: "React Versions – official documentation",
        url: "https://react.dev/versions",
        snippet: "Official React versions and release history.",
        provider: "official-source",
      },
      {
        title: "React package metadata – npm registry",
        url: "https://registry.npmjs.org/react/latest",
        snippet: "Published React package version metadata from the npm registry.",
        provider: "official-source",
      },
    ]);
    expect(ranked.slice(0, 2).map((source) => source.provider)).toEqual([
      "official-source",
      "official-source",
    ]);
  });

  it("ranks specific requested facts and excludes a more-specific sibling product", () => {
    const question =
      "Investigate the latest stable React release; verify the version and release date.";
    const ranked = rankResults(question, [
      {
        title: "React stable release overview",
        url: "https://blog.example/react-release-overview",
        snippet:
          "The React stable release overview discusses version history and links to recent release notes.",
      },
      {
        title: "React Versions — Official documentation",
        url: "https://react.dev/versions",
        snippet: "Official React versions and release history.",
      },
      {
        title: "Releases Overview — React Native",
        url: "https://reactnative.dev/releases/overview",
        snippet: "The schedule lists recent stable React Native releases and dates.",
      },
      {
        title: "React 19.2.0 release announcement",
        url: "https://react.dev/blog/fixture-release",
        snippet: "React 19.2.0 is the latest stable release, released on September 15, 2026.",
      },
    ]);
    const selected = selectResearchSources(ranked, ["React"], 3);

    expect(
      ranked.find((source) => source.domain === "reactnative.dev")?.subjectMismatchReason,
    ).toBe("Candidate names React Native, a more-specific entity than the requested React.");
    expect(selected.map((source) => source.domain)).not.toContain("reactnative.dev");
    expect(selected.map((source) => source.domain)).toContain("blog.example");
    expect(selected[0]?.url).toBe("https://react.dev/blog/fixture-release");
  });

  it("rejects a sibling entity named only in the result snippet", () => {
    const question = "What is the latest stable React release?";
    const ranked = rankResults(question, [
      {
        title: "Stable release overview",
        url: "https://releases.example/releases/overview",
        snippet: "React Native publishes its own stable release versions and dates.",
      },
      {
        title: "React versions",
        url: "https://react.dev/versions",
        snippet: "Official React versions and release history.",
      },
    ]);
    const selected = selectResearchSources(ranked, ["React"], 2);

    expect(
      ranked.find((source) => source.domain === "releases.example")?.subjectMismatchReason,
    ).toBe("Candidate names React Native, a more-specific entity than the requested React.");
    expect(ranked.find((source) => source.domain === "releases.example")?.quality.relevance).toBe(
      0,
    );
    expect(ranked.find((source) => source.domain === "releases.example")?.quality.overall).toBe(0);
    expect(selected.map((source) => source.domain)).not.toContain("releases.example");
    expect(selected.map((source) => source.domain)).toContain("react.dev");
  });

  it("detects compound entity identity from a domain when result text is generic", () => {
    const ranked = rankResults("What is the latest stable React release?", [
      {
        title: "Release overview",
        url: "https://reactnative.dev/releases",
        snippet: "Official stable versions and release dates.",
      },
    ]);

    expect(ranked[0]?.subjectMismatchReason).toBe(
      "Candidate names React Native, a more-specific entity than the requested React.",
    );
    expect(selectResearchSources(ranked, ["React"], 2)).toEqual([]);
  });

  it("reapplies the same mismatch filter to alternate-source results", () => {
    const question = "What is the latest stable React release?";
    const passes = [
      [
        {
          title: "React versions",
          url: "https://react.dev/versions",
          snippet: "Official React versions and release history.",
        },
      ],
      [
        {
          title: "Release overview",
          url: "https://mobile-releases.example/react-native",
          snippet: "React Native stable releases and release dates.",
        },
      ],
    ];

    const selectedByPass = passes.map((results) =>
      selectResearchSources(rankResults(question, results), ["React"], 2),
    );

    expect(selectedByPass[0]?.map((source) => source.domain)).toContain("react.dev");
    expect(selectedByPass[1]).toHaveLength(0);
  });

  it("reserves relevant vendor documentation before high-keyword SEO comparisons", () => {
    const question = "Compare React Native and Flutter for a startup in 2026";
    const seo = Array.from({ length: 5 }, (_, index) => ({
      title: `React Native vs Flutter startup comparison 2026 ${index}`,
      url: `https://comparisons-${index}.example.org/react-native-flutter`,
      snippet: "Compare React Native Flutter startup options for 2026. ".repeat(4),
    }));
    const ranked = rankResults(question, [
      ...seo,
      {
        title: "React Native performance documentation",
        url: "https://reactnative.dev/docs/performance",
        snippet: "React Native official performance guidance.",
      },
      {
        title: "Flutter performance documentation",
        url: "https://docs.flutter.dev/perf",
        snippet: "Flutter official performance guidance.",
      },
      {
        title: "Official React Native Flutter comparison",
        url: "https://react.dev.evil.example/docs/comparison",
        snippet: "Official documentation for React Native and Flutter.",
      },
    ]);
    const selected = selectResearchSources(ranked, ["React Native", "Flutter"], 4);
    expect(selected.slice(0, 2).map((source) => source.domain)).toEqual([
      "reactnative.dev",
      "docs.flutter.dev",
    ]);
    expect(
      ranked.find((source) => source.domain === "react.dev.evil.example")?.quality.authority,
    ).toBeLessThan(0.9);
  });

  it("does not treat GitHub Community discussions as official documentation", () => {
    const [source] = rankResults("Compare Flutter vs React Native", [
      {
        title: "Flutter vs React Native – Which is Better? · community · Discussion #162725",
        url: "https://github.com/orgs/community/discussions/162725",
        snippet: "A community discussion comparing Flutter and React Native.",
      },
    ]);

    expect(source.sourceType).toBe("forum");
    expect(source.quality.authority).toBeLessThan(0.9);
  });

  it("does not infer a GitHub repository is an official source from its host alone", () => {
    const [source] = rankResults("React Native architecture", [
      {
        title: "React Native architecture discussion",
        url: "https://github.com/example/project",
        snippet: "Notes about React Native architecture.",
      },
    ]);

    expect(source.sourceType).toBe("unknown");
    expect(source.quality.authority).toBeLessThan(0.9);
  });

  it("requires an entity-appropriate official source only when the task requests one", () => {
    const question =
      "Find the latest stable React version and release date using official React sources.";
    const ranked = rankResults(question, [
      {
        title: "React latest stable version and release date — Wikipedia",
        url: "https://en.wikipedia.org/wiki/React_(software)",
        snippet:
          "React latest stable version and release date details, with an overview of the JavaScript library.",
      },
      {
        title: "React Versions — official documentation",
        url: "https://react.dev/versions",
        snippet: "Official React versions and release history.",
      },
    ]);

    const defaultSelection = selectResearchSources(ranked, ["React"], 2);
    const requiredSelection = selectResearchSourcesWithDecisions(ranked, ["React"], 2, "required");

    expect(defaultSelection.map((source) => source.domain)).toContain("en.wikipedia.org");
    expect(requiredSelection.selected.map((source) => source.domain)).toEqual(["react.dev"]);
    expect(requiredSelection.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "en.wikipedia.org",
          officialSource: false,
          officialSourceRequirement: "required",
          selected: false,
          reason: expect.stringContaining("requires official sources"),
        }),
        expect.objectContaining({
          domain: "react.dev",
          officialSource: true,
          selected: true,
        }),
      ]),
    );
  });

  it("prefers an eligible official release source whose metadata covers the requested facts", () => {
    const question =
      "Investigate the latest stable React release using official React release sources; verify the version and release date.";
    const releaseUrl = "https://react.dev/blog/react-release";
    const ranked = rankResults(question, [
      {
        title: "React Versions — Official Documentation",
        url: "https://react.dev/versions",
        snippet: "The official versions page lists stable releases and links to announcements.",
      },
      {
        title: "React 19.2.0 release announcement",
        url: releaseUrl,
        snippet: "React 19.2.0 is the latest stable React release, released on September 15, 2026.",
      },
    ]);

    const selection = selectResearchSourcesWithDecisions(
      ranked,
      ["React"],
      2,
      "required",
      question,
    );

    expect(selection.selected[0]?.url).toBe(releaseUrl);
    expect(selection.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: releaseUrl,
          selected: true,
          reason: expect.stringContaining("mentions 4/4 requested fact(s)"),
        }),
      ]),
    );
  });

  it("excludes a fact-insufficient URL and ranks fact-bearing recovery metadata first", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const previousIndexUrl = "https://nodejs.org/en/about/previous-releases";
    const ranked = rankResults(question, [
      {
        title: "Node.js previous releases",
        url: previousIndexUrl,
        snippet: "Official Node.js release schedule and support lifecycle dates.",
      },
      {
        title: "Node.js lifecycle schedule",
        url: "https://nodejs.org/en/about/releases",
        snippet: "Official support lifecycle schedule for Node.js release lines.",
      },
      {
        title: "Node.js 22 end-of-life date",
        url: "https://nodejs.org/en/about/node-22-eol",
        snippet: "Node.js 22 reaches end of life on 2027-04-30.",
      },
    ]);

    const selection = selectResearchSourcesWithDecisions(
      ranked,
      ["Node.js"],
      2,
      "required",
      question,
      {
        unresolvedFacts: ["end-of-life date"],
        factInsufficientSources: [{ url: previousIndexUrl, missingFacts: ["end-of-life date"] }],
      },
    );

    expect(selection.selected[0]?.url).toBe("https://nodejs.org/en/about/node-22-eol");
    expect(selection.selected.some((source) => source.url === previousIndexUrl)).toBe(false);
    expect(selection.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: previousIndexUrl,
          selected: false,
          reason: expect.stringContaining("Previously evaluated source omitted"),
        }),
        expect.objectContaining({
          url: "https://nodejs.org/en/about/node-22-eol",
          selected: true,
        }),
      ]),
    );
  });

  it("rejects recovery metadata that only supports a different requested lifecycle version", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const wrongVersion = rankResults(question, [
      {
        title: "Node.js 18 end-of-life schedule",
        url: "https://nodejs.org/en/about/node-18-eol",
        snippet: "Node.js 18 reached end of life on 2025-04-30.",
      },
    ]);
    const selection = selectResearchSourcesWithDecisions(
      wrongVersion,
      ["Node.js"],
      2,
      "required",
      question,
      { unresolvedFacts: ["end-of-life date"], factInsufficientSources: [] },
    );

    expect(selection.selected).toEqual([]);
    expect(selection.decisions[0]).toMatchObject({
      selected: false,
      reason: expect.stringContaining("does not indicate an unresolved requested fact"),
    });
  });

  it("does not fetch a generic result with no signal for the unresolved fact", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const generic = rankResults(question, [
      {
        title: "Node.js documentation overview",
        url: "https://nodejs.org/en/docs",
        snippet: "Documentation for the Node.js runtime and its APIs.",
      },
    ]);
    const selection = selectResearchSourcesWithDecisions(
      generic,
      ["Node.js"],
      2,
      "required",
      question,
      { unresolvedFacts: ["end-of-life date"], factInsufficientSources: [] },
    );

    expect(selection.selected).toEqual([]);
    expect(selection.decisions[0]?.reason).toContain(
      "Search metadata does not indicate an unresolved requested fact",
    );
  });

  it("keeps sibling-entity metadata out of a fact-specific recovery", () => {
    const question = "What is the React 19.3 release date from official React sources?";
    const ranked = rankResults(question, [
      {
        title: "React Native 19.3 release announcement",
        url: "https://reactnative.dev/blog/19-3",
        snippet: "React Native 19.3 was released on September 9, 2026.",
      },
    ]);
    const selection = selectResearchSourcesWithDecisions(
      ranked,
      ["React"],
      2,
      "required",
      question,
      { unresolvedFacts: ["release date"], factInsufficientSources: [] },
    );

    expect(selection.selected).toEqual([]);
    expect(selection.decisions[0]?.selected).toBe(false);
  });

  it("checks official domains against requested entities rather than trusting generic labels", () => {
    expect(
      isOfficialSourceForEntities({ domain: "react.dev", sourceType: "official" }, ["React"]),
    ).toBe(true);
    expect(
      isOfficialSourceForEntities({ domain: "react.dev.evil.example", sourceType: "official" }, [
        "React",
      ]),
    ).toBe(false);
    expect(
      isOfficialSourceForEntities({ domain: "registry.npmjs.org", sourceType: "official" }, [
        "React",
      ]),
    ).toBe(false);
  });

  it("recognizes a known first-party GitHub repository but not GitHub as a blanket official host", () => {
    const [officialRepository] = rankResults("React official release history", [
      {
        title: "React official repository releases",
        url: "https://github.com/facebook/react/releases",
        snippet: "Official React release history and source tags.",
      },
    ]);
    const [unrelatedRepository] = rankResults("React official release history", [
      {
        title: "React release history",
        url: "https://github.com/example/react-releases",
        snippet: "React release history mirrored by a third-party repository.",
      },
    ]);

    expect(isOfficialSourceForEntities(officialRepository, ["React"])).toBe(true);
    expect(officialRepository).toMatchObject({
      sourceType: "official",
      firstPartyClassification: {
        entity: "React",
        repository: "facebook/react",
        contentKind: "release_history",
      },
    });
    expect(isOfficialSourceForEntities(unrelatedRepository, ["React"])).toBe(false);
  });

  it("classifies exact first-party changelogs for different entities and rejects sibling repositories", () => {
    const reactChangelog = classifyFirstPartyGitHubSource(
      "https://github.com/facebook/react/blob/main/CHANGELOG.md",
    );
    const flutterChangelog = classifyFirstPartyGitHubSource(
      "https://github.com/flutter/flutter/blob/master/CHANGELOG.md",
    );
    const reactNativeReleases = classifyFirstPartyGitHubSource(
      "https://github.com/facebook/react-native/releases",
    );
    const reactReleaseAlias = classifyFirstPartyGitHubSource(
      "https://github.com/react/react/releases",
    );
    const unrelated = classifyFirstPartyGitHubSource(
      "https://github.com/someone/react-version-mirror/releases",
    );

    expect(reactChangelog).toMatchObject({
      entity: "React",
      repository: "facebook/react",
      contentKind: "changelog",
    });
    expect(flutterChangelog).toMatchObject({
      entity: "Flutter",
      repository: "flutter/flutter",
      contentKind: "changelog",
    });
    expect(reactNativeReleases?.entity).toBe("React Native");
    expect(reactReleaseAlias).toMatchObject({
      entity: "React",
      repository: "react/react",
      contentKind: "release_history",
    });
    expect(
      isOfficialSourceForEntities(
        {
          domain: "github.com",
          sourceType: "official",
          url: "https://github.com/facebook/react-native/releases",
        },
        ["React"],
      ),
    ).toBe(false);
    expect(unrelated).toBeUndefined();
    expect(
      isOfficialSourceForEntities(
        {
          domain: "github.com",
          sourceType: "official",
          url: "https://github.com/react/react/releases",
        },
        ["React"],
      ),
    ).toBe(true);
    expect(
      classifyFirstPartyGitHubSource("https://github.com/react/react-mirror/releases"),
    ).toBeUndefined();
  });

  it("does not elevate a first-party repository root or arbitrary page to release evidence", () => {
    const root = classifyFirstPartyGitHubSource("https://github.com/facebook/react");
    const issue = classifyFirstPartyGitHubSource("https://github.com/facebook/react/issues/1");

    expect(root?.contentKind).toBe("repository");
    expect(issue?.contentKind).toBe("repository");
    expect(
      isOfficialSourceForEntities(
        { domain: "github.com", sourceType: "official", url: "https://github.com/facebook/react" },
        ["React"],
      ),
    ).toBe(false);
    expect(
      isOfficialSourceForEntities(
        {
          domain: "github.com",
          sourceType: "official",
          url: "https://github.com/facebook/react/issues/1",
        },
        ["React"],
      ),
    ).toBe(false);
  });
});
