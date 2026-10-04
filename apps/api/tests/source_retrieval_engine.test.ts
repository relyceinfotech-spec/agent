import { describe, expect, it, vi } from "vitest";
import {
  assessSerperSnippet,
  isSerperSnippetSufficient,
  retrieveSource,
  type SourceRetrievalDependencies,
} from "../src/source-retrieval.js";
import type { Source } from "../src/domain.js";
import { classifyFirstPartyGitHubSource } from "../src/rank.js";
import { resolveOfficialReleaseHistory } from "../src/release-history.js";
import {
  assessLatestnessEvidence,
  extractOfficialReleaseHistoryClaimCandidates,
} from "../src/version-evidence.js";
import { runWithResearchExecutionContext } from "../src/execution-context.js";
import { requestedFactCoverage } from "../src/requested-facts.js";

const pageUrl = "https://research.example/article";
const article =
  "The report describes measured performance in production applications, explains how the benchmark was conducted, and documents limitations that affect interpretation of the results.";
const searchResult = {
  url: pageUrl,
  title: "Performance report",
  snippet: "A short search snippet.",
};

function htmlResponse(body: string, contentType = "text/html") {
  return new Response(body, { headers: { "content-type": contentType } });
}

function dependencies(
  routes: Record<string, Response | Error | (() => Response)>,
  browserHtml?: string,
  resolvedUrls: Record<string, string> = {},
  browserApplicationResponses: Array<{ path: string; contentType: string; body: string }> = [],
): SourceRetrievalDependencies {
  return {
    fetch: vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const isRange = Boolean(new Headers(init.headers).get("range"));
      const route =
        routes[`${method} ${url}${isRange ? " range" : ""}`] ??
        routes[`${method} ${url}`] ??
        routes[url];
      if (route instanceof Error) throw route;
      if (!route) throw new Error(`No fixture for ${url}`);
      return {
        url: resolvedUrls[url] ?? url,
        response: typeof route === "function" ? route() : route,
        dispose: async () => {},
      };
    }),
    browser: vi.fn(async (url: string) => ({
      url,
      html: browserHtml ?? "<main></main>",
      applicationResponses: browserApplicationResponses,
    })),
  };
}

function fullPageGetCount(deps: SourceRetrievalDependencies): number {
  const calls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, RequestInit?]
  >;
  return calls.filter(([url, init]) => {
    const method = init?.method ?? "GET";
    const isPreview = new Headers(init?.headers).has("range");
    return url === pageUrl && method === "GET" && !isPreview;
  }).length;
}

describe("shared source retrieval ladder", () => {
  it.each(["opengraph", "jsonld"])(
    "does not stop at %s descriptions when a comparison has no discrete fact list",
    async (metadataKind) => {
      const question = "Compare current Aster and Beryl indexing performance";
      const description =
        "A technical overview of the available indexing approaches, their background, and advice for readers choosing tools for a production application.";
      const metadata =
        metadataKind === "opengraph"
          ? `<meta property="og:description" content="${description}">`
          : `<script type="application/ld+json">${JSON.stringify({ "@type": "Article", headline: "Aster and Beryl indexing performance", description })}</script>`;
      const body =
        "Aster indexing achieves lower latency by traversing fewer graph neighbors in the documented benchmark workload. Beryl indexing achieves higher throughput by grouping queries into partitions in the documented workload.";
      const deps = dependencies({
        [`HEAD ${pageUrl}`]: htmlResponse(""),
        [`GET ${pageUrl} range`]: htmlResponse(
          `<html><head><title>Aster and Beryl indexing performance</title>${metadata}</head></html>`,
        ),
        [`GET ${pageUrl}`]: htmlResponse(
          `<html><head><title>Aster and Beryl indexing performance</title>${metadata}</head><article><p>${body}</p></article></html>`,
        ),
      });
      const result = await retrieveSource(
        {
          result: {
            url: pageUrl,
            title: "Aster and Beryl indexing performance",
            snippet: description,
          },
          question,
          requestedFacts: [],
          researchChatOptimization: true,
          allowSnippetEvidence: false,
        },
        deps,
      );
      expect(result.retrievalMethod).toBe("http");
      expect(result.document.content).toContain(body);
      expect(fullPageGetCount(deps)).toBe(1);
      expect(result.retrievalReasons.join(" ")).toContain("a source-linked comparison finding");
    },
  );
  it("retains a task-useful structured article without requiring complete comparison coverage", async () => {
    const body =
      "Aster indexing achieves lower latency by traversing fewer neighboring records in this documented benchmark workload.";
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: htmlResponse(""),
      [`GET ${pageUrl} range`]: htmlResponse(
        `<html><head><title>Aster and Beryl indexing performance</title><script type="application/ld+json">${JSON.stringify({ "@type": "Article", headline: "Aster and Beryl indexing performance", articleBody: body + " The benchmark is reproducible." })}</script></head></html>`,
      ),
    });
    const result = await retrieveSource(
      {
        result: { url: pageUrl, title: "Aster and Beryl indexing performance", snippet: "" },
        question: "Compare Aster and Beryl indexing performance",
        requestedFacts: [],
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      },
      deps,
    );
    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toContain(body);
    expect(fullPageGetCount(deps)).toBe(0);
  });
  it("uses a sufficient Serper snippet without crawling", async () => {
    const snippet = {
      title: "React Native performance benchmark",
      snippet:
        "The React Native performance benchmark measured startup latency and memory usage in production builds across several representative devices.",
    };
    expect(isSerperSnippetSufficient(snippet, "React Native performance benchmark")).toBe(true);
    const deps = dependencies({});
    const result = await retrieveSource(
      { result: { ...searchResult, ...snippet }, question: "React Native performance benchmark" },
      deps,
    );
    expect(result.retrievalMethod).toBe("serper_snippet");
    expect(result.retrievalAttempts).toEqual(["serper_snippet"]);
    expect(result.retrievalMethodsSkipped).toEqual(["rss", "structured", "http", "browser"]);
    expect(result.retrievalReasons).toHaveLength(1);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts a concise current version value but not a complex comparison snippet", () => {
    expect(
      isSerperSnippetSufficient(
        {
          title: "React version",
          snippet: "React 19.3.0 is the latest stable release.",
        },
        "What is the latest React version?",
      ),
    ).toBe(true);
    expect(
      isSerperSnippetSufficient(
        {
          title: "React Native and Flutter",
          snippet:
            "React Native and Flutter have several performance trade-offs across startup, memory, and rendering workloads in real production apps.",
        },
        "Compare React Native and Flutter performance",
      ),
    ).toBe(false);
  });

  it("accepts a direct simple factual answer only when the snippet itself states it", () => {
    expect(
      isSerperSnippetSufficient(
        {
          title: "React overview",
          snippet: "React is a JavaScript library for building user interfaces.",
        },
        "What is React?",
      ),
    ).toBe(true);
    expect(
      isSerperSnippetSufficient(
        {
          title: "React is a JavaScript library",
          snippet: "Explore product updates, release notes, and project resources.",
        },
        "What is React?",
      ),
    ).toBe(false);
  });

  it("rejects generic snippets when the request needs a version and exact release date", () => {
    const question =
      "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";
    const generic = {
      title: "React 19.3.0 release details",
      snippet:
        "The React releases page contains information about stable versions and recent updates.",
    };
    const missingDate = {
      title: "React latest release",
      snippet: "React 19.3.0 is the latest stable release.",
    };

    expect(assessSerperSnippet(generic, question)).toMatchObject({
      sufficient: false,
      reason: "The snippet does not state a concrete version and its release/current status.",
    });
    expect(assessSerperSnippet(missingDate, question)).toMatchObject({
      sufficient: false,
      reason: "The snippet does not state a specific release date.",
    });
    expect(
      isSerperSnippetSufficient(
        {
          title: "React release",
          snippet: "React 19.3.0 is the latest stable release, released on September 15, 2026.",
        },
        question,
      ),
    ).toBe(true);
  });

  it("does not treat a company profile or generic leadership snippet as CEO evidence", () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const profile = {
      title: "Relyce Infotech CEO and leadership profile",
      snippet: "Relyce Infotech provides IT consulting and software development services.",
    };
    const genericLeadership = {
      title: "Relyce Infotech leadership",
      snippet: "Relyce Infotech is led by an experienced team of technology professionals.",
    };
    const supportedPredicate = {
      title: "Relyce Infotech executive team",
      snippet: "Jane Doe is the chief executive officer of Relyce Infotech.",
    };

    expect(assessSerperSnippet(profile, question)).toMatchObject({
      sufficient: false,
      reason: "The snippet does not state the requested CEO fact.",
    });
    expect(isSerperSnippetSufficient(genericLeadership, question)).toBe(false);
    expect(isSerperSnippetSufficient(supportedPredicate, question)).toBe(true);
  });

  it("preserves an explicit CEO statement embedded late in a long LinkedIn result", async () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const snippet =
      "Startup Fest 2025 at Sathyabama Institute of Science & Technology, Chennai was a resounding success, and Relyce infotech presented its stall. The event provided a platform to showcase its vision and solutions and received encouraging feedback from investors and mentors. The team participated in discussions about its technology and AI solution. Core Team: Ukenthiran A Founder & CEO of Relyce infotech Dharsan L | Tamizharuvi P | GOHULA KANNAN | Naveenkumar Sivarajan.";
    const result = {
      ...searchResult,
      title: "Relyce infotech | LinkedIn",
      url: "https://www.linkedin.com/company/relyce-infotech",
      snippet,
    };
    const deps = dependencies({});

    expect(assessSerperSnippet(result, question).sufficient).toBe(true);
    const retrieved = await retrieveSource({ result, question }, deps);

    expect(retrieved.retrievalMethod).toBe("serper_snippet");
    expect(retrieved.document.content).toContain("Ukenthiran A Founder & CEO of Relyce infotech");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("requires a snippet to support the requested entity/version lifecycle date", () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const requestedFacts = ["end-of-life date"] as const;

    expect(
      assessSerperSnippet(
        {
          title: "Node.js release schedule",
          snippet: "Node.js 22 is an LTS release. End-of-life dates appear in the schedule.",
        },
        question,
        [...requestedFacts],
      ).sufficient,
    ).toBe(false);
    expect(
      assessSerperSnippet(
        {
          title: "Node.js release schedule",
          snippet:
            "Node.js 22 reaches end of life on 2027-04-30 according to the release schedule.",
        },
        question,
        [...requestedFacts],
      ).sufficient,
    ).toBe(true);
    expect(
      assessSerperSnippet(
        {
          title: "Node.js release schedule",
          snippet:
            "Node.js 20 reaches end of life on 2027-04-30 according to the release schedule.",
        },
        question,
        [...requestedFacts],
      ).sufficient,
    ).toBe(false);
  });

  it("rejects a precise-looking snippet about a more-specific sibling entity", () => {
    const question =
      "Investigate the latest stable React release; verify the version and release date.";
    expect(
      assessSerperSnippet(
        {
          title: "React Native 0.80.0 release",
          snippet:
            "React Native 0.80.0 is the latest stable release, released on September 15, 2026.",
        },
        question,
      ),
    ).toMatchObject({
      sufficient: false,
      reason: "Candidate names React Native, a more-specific entity than the requested React.",
    });
  });

  it("rejects marketing copy for a precise technical-value question", () => {
    expect(
      isSerperSnippetSufficient(
        {
          title: "React performance and payload limits",
          snippet:
            "React provides a flexible and efficient experience for building modern applications.",
        },
        "What is the exact maximum payload limit for React?",
      ),
    ).toBe(false);
  });

  it("records why a weak version snippet was rejected and escalates to source retrieval", async () => {
    const question =
      "Investigate the latest stable React release; verify its version and release date.";
    const articleBody =
      "React 19.3.0 is the latest stable release, released on September 15, 2026. The official release entry documents the version and publication date.";
    const raw = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      headline: "React release entry",
      articleBody,
      datePublished: "2026-09-15",
    })}</script></head><body><main>Release information</main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });
    const result = await retrieveSource(
      {
        result: {
          ...searchResult,
          title: "React 19.3.0 release",
          snippet: "The React releases page lists stable versions and recent updates.",
        },
        question,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("structured");
    expect(result.retrievalAttempts).toEqual(["serper_snippet", "rss", "structured"]);
    expect(result.retrievalReasons[0]).toBe(
      "The snippet does not state a concrete version and its release/current status.",
    );
    expect(result.document.content).toContain("React 19.3.0");
  });

  it("uses a useful discoverable RSS feed before the page HTML", async () => {
    const feedUrl = "https://research.example/feed.xml";
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () =>
        new Response(null, {
          headers: {
            "content-type": "text/html",
            link: '<https://research.example/feed.xml>; rel="alternate"; type="application/rss+xml"',
          },
        }),
      [feedUrl]: htmlResponse(
        `<rss><channel><title>Research</title><item><title>Performance findings</title><link>${pageUrl}</link><description>${article.repeat(2)}</description><pubDate>Thu, 20 Aug 2026 00:00:00 GMT</pubDate><author>Research Desk</author></item></channel></rss>`,
        "application/rss+xml",
      ),
    });
    const result = await retrieveSource({ result: searchResult, question: "performance" }, deps);
    expect(result.retrievalMethod).toBe("rss");
    expect(result.retrievalAttempts).toEqual(["serper_snippet", "rss"]);
    expect(result.document.canonicalUrl).toBe(pageUrl);
    expect(result.document.author).toBe("Research Desk");
    expect(result.document.publishedAt).toContain("2026");
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(fullPageGetCount(deps)).toBe(0);
    expect(result.retrievalMethodsSkipped).toEqual(["structured", "http", "browser"]);
  });

  it("selects useful JSON-LD article data before normal HTML extraction", async () => {
    const raw = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      headline: "Performance report",
      articleBody: article.repeat(2),
      datePublished: "2026-08-01",
    })}</script></head><body><main>Navigation only</main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });
    const result = await retrieveSource({ result: searchResult, question: "performance" }, deps);
    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toContain("measured performance");
    expect(result.document.publishedAt).toBe("2026-08-01");
    expect(fullPageGetCount(deps)).toBe(0);
    expect(result.retrievalMethodsSkipped).toEqual(["http", "browser"]);
  });

  it("uses task-sufficient lifecycle JSON-LD without downloading the full page", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const requestedFacts = ["end-of-life date"] as const;
    const supportedBody =
      "Node.js 22 reaches end of life on 2027-04-30. The official release schedule lists support lifecycle dates for each supported major release line.";
    const raw = `<html><head><title>Node.js Releases</title><script type="application/ld+json">${JSON.stringify(
      {
        "@type": "Article",
        headline: "Node.js Releases",
        articleBody: supportedBody,
      },
    )}</script></head><body><main>Schedule metadata</main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });

    const result = await retrieveSource(
      {
        result: searchResult,
        question,
        requestedFacts: [...requestedFacts],
        researchChatOptimization: true,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toContain(supportedBody);
    expect(
      requestedFactCoverage(question, result.document.content, {
        requestedFacts: [...requestedFacts],
      }).present,
    ).toContain("end-of-life date");
    expect(fullPageGetCount(deps)).toBe(0);
  });

  it("escalates lifecycle metadata missing the requested fact and preserves exact table row binding", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const requestedFacts = ["end-of-life date"] as const;
    const description =
      "The official Node.js release schedule lists support states and planned lifecycle milestones for maintained major release lines.";
    const raw = `<html><head><title>Node.js Releases</title><script type="application/ld+json">${JSON.stringify(
      {
        "@type": "Article",
        headline: "Node.js Releases",
        description,
      },
    )}</script></head><body><main><h1>Node.js Releases</h1><table><thead><tr><th>Version</th><th>Status</th><th>End-of-Life</th></tr></thead><tbody><tr><td>20.x</td><td>Maintenance LTS</td><td>2026-04-30</td></tr><tr><td>22.x</td><td>Active LTS</td><td>2027-04-30</td></tr></tbody></table></main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
      [`GET ${pageUrl}`]: () => htmlResponse(raw),
    });

    const result = await retrieveSource(
      {
        result: searchResult,
        question,
        requestedFacts: [...requestedFacts],
        researchChatOptimization: true,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("http");
    expect(result.retrievalAttempts).toEqual(["serper_snippet", "rss", "structured", "http"]);
    expect(result.document.content).toContain("Node.js version 22 end-of-life date: 2027-04-30.");
    expect(
      requestedFactCoverage(question, result.document.content, {
        requestedFacts: [...requestedFacts],
      }).present,
    ).toContain("end-of-life date");
    expect(result.document.content).not.toContain(
      "Node.js version 22 end-of-life date: 2026-04-30.",
    );
    expect(result.retrievalReasons.join(" ")).toContain("continuing to normal HTML extraction");
    expect(fullPageGetCount(deps)).toBe(1);
    expect(deps.browser).not.toHaveBeenCalled();
  });

  it("extracts the requested lifecycle row from bounded browser-rendered HTML", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const requestedFacts = ["end-of-life date"] as const;
    const shell =
      '<html><head><title>Node.js Releases</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const renderedHtml =
      "<html><head><title>Node.js Releases</title></head><body><main><h1>Node.js Releases</h1><table><thead><tr><th>Version</th><th>Status</th><th>End-of-Life</th></tr></thead><tbody><tr><td>20.x</td><td>Maintenance LTS</td><td>2026-04-30</td></tr><tr><td>22.x</td><td>Active LTS</td><td>2027-04-30</td></tr></tbody></table></main></body></html>";
    const deps = dependencies(
      {
        [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
        [`GET ${pageUrl} range`]: () => htmlResponse(shell),
        [`GET ${pageUrl}`]: () => htmlResponse(shell),
      },
      renderedHtml,
    );

    const result = await retrieveSource(
      {
        result: {
          ...searchResult,
          title: "Node.js Releases",
          snippet: "The official Node.js releases page lists lifecycle information by version.",
        },
        question,
        requestedFacts: [...requestedFacts],
        researchChatOptimization: true,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("browser");
    expect(result.retrievalAttempts).toEqual([
      "serper_snippet",
      "rss",
      "structured",
      "http",
      "browser",
    ]);
    expect(result.document.content).toContain("Node.js version 22 end-of-life date: 2027-04-30.");
    expect(result.document.content).not.toContain(
      "Node.js version 22 end-of-life date: 2026-04-30.",
    );
    expect(
      requestedFactCoverage(question, result.document.content, {
        requestedFacts: [...requestedFacts],
      }).present,
    ).toContain("end-of-life date");

    const diagnosticPrefix = "Lifecycle table extraction diagnostic: ";
    const diagnosticText = result.retrievalReasons.find(
      (reason) =>
        reason.startsWith(diagnosticPrefix) && reason.includes('"normalizedCandidateCount":1'),
    );
    expect(diagnosticText).toBeDefined();
    const diagnostic = JSON.parse(diagnosticText!.slice(diagnosticPrefix.length)) as {
      sourceEntityMatched: boolean;
      targetVersion: string;
      tablesFound: number;
      lifecycleHeaderTablesFound: number;
      rawCandidateCount: number;
      normalizedCandidateCount: number;
      candidates: Array<{ version: string; requestedVersionMatch: boolean; outcome: string }>;
    };
    expect(diagnostic).toMatchObject({
      sourceEntityMatched: true,
      targetVersion: "22",
      tablesFound: 1,
      lifecycleHeaderTablesFound: 1,
      rawCandidateCount: 2,
      normalizedCandidateCount: 1,
    });
    expect(diagnostic.candidates).toEqual([
      expect.objectContaining({ version: "20", requestedVersionMatch: false, outcome: "rejected" }),
      expect.objectContaining({ version: "22", requestedVersionMatch: true, outcome: "accepted" }),
    ]);
    expect(deps.browser).toHaveBeenCalledOnce();
  });

  it("keeps structured-metadata selection unchanged for callers outside Research Chat", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const description =
      "The official Node.js release schedule lists support states and planned lifecycle milestones for maintained major release lines.";
    const raw = `<html><head><title>Node.js Releases</title><script type="application/ld+json">${JSON.stringify(
      {
        "@type": "Article",
        headline: "Node.js Releases",
        description,
      },
    )}</script></head><body><main>Full release table is available here.</main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });

    const result = await retrieveSource(
      {
        result: searchResult,
        question,
        requestedFacts: ["end-of-life date"],
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toBe(description);
    expect(result.retrievalReasons.join(" ")).not.toContain("continuing to normal HTML extraction");
    expect(fullPageGetCount(deps)).toBe(0);
  });

  it("uses an advertised JSON endpoint without downloading the article page", async () => {
    const apiUrl = "https://research.example/api/latest";
    const payload = JSON.stringify({
      name: "Bun",
      version: "1.2.3",
      description:
        "A stable runtime release with documented package metadata and compatibility details.",
    });
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () =>
        new Response(null, {
          headers: {
            "content-type": "text/html",
            link: '<https://research.example/api/latest>; rel="alternate"; type="application/json"',
          },
        }),
      [apiUrl]: htmlResponse(payload, "application/json"),
    });
    const result = await retrieveSource(
      { result: searchResult, question: "Bun current version" },
      deps,
    );

    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toContain("1.2.3");
    expect(result.retrievalMethodsSkipped).toEqual(["http", "browser"]);
    expect(fullPageGetCount(deps)).toBe(0);
  });

  it("uses sufficient OpenGraph metadata from the bounded preview without a full crawl", async () => {
    const description =
      "The current Bun release is version 1.2.3, with a stable runtime update and published compatibility details for developers.";
    const raw = `<html><head><meta property="og:title" content="Bun current release"><meta property="og:description" content="${description}"></head><body><main></main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });
    const result = await retrieveSource(
      { result: searchResult, question: "Bun current version" },
      deps,
    );

    expect(result.retrievalMethod).toBe("structured");
    expect(result.document.content).toContain("version 1.2.3");
    expect(result.document.contentOrigin).toBe("metadata");
    expect(fullPageGetCount(deps)).toBe(0);
  });

  it("continues from an insufficient RSS entry to sufficient structured data without a full page crawl", async () => {
    const feedUrl = "https://research.example/feed.xml";
    const raw = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "Performance report",
      articleBody: article.repeat(2),
    })}</script></head><body><main>Shell metadata</main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () =>
        new Response(null, {
          headers: {
            "content-type": "text/html",
            link: '<https://research.example/feed.xml>; rel="alternate"; type="application/rss+xml"',
          },
        }),
      [feedUrl]: htmlResponse(
        `<rss><channel><title>Research</title><item><title>Different article</title><link>https://research.example/other</link><description>${article.repeat(2)}</description></item></channel></rss>`,
        "application/rss+xml",
      ),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
    });
    const result = await retrieveSource({ result: searchResult, question: "performance" }, deps);

    expect(result.retrievalMethod).toBe("structured");
    expect(result.retrievalAttempts).toEqual(["serper_snippet", "rss", "structured"]);
    expect(result.document.contentOrigin).toBeUndefined();
    expect(fullPageGetCount(deps)).toBe(0);
    expect(result.retrievalReasons).toContain(
      "The advertised feed was unavailable, unmatched, or too thin to support the task.",
    );
  });

  it("falls through insufficient structured metadata to useful HTML", async () => {
    const raw = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "Short summary",
      description: "Too short to establish useful evidence.",
    })}</script></head><body><article><h1>Performance report</h1><p>${article}</p><p>${article}</p></article></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(raw),
      [`GET ${pageUrl}`]: () => htmlResponse(raw),
    });
    const result = await retrieveSource({ result: searchResult, question: "performance" }, deps);
    expect(result.retrievalMethod).toBe("http");
    expect(result.retrievalAttempts).toEqual(["serper_snippet", "rss", "structured", "http"]);
    expect(fullPageGetCount(deps)).toBe(1);
    expect(deps.fetch).toHaveBeenCalledWith(pageUrl, expect.objectContaining({ method: "GET" }));
    expect(deps.browser).not.toHaveBeenCalled();
  });

  it("uses bounded browser rendering when extracted HTML misses requested facts and has hydration data", async () => {
    const question =
      "Investigate the latest stable React release; verify the version and release date.";
    const genericText =
      "The React versions page explains how the documentation tracks stable releases and archives older documentation. The page links to release announcements and provides information for developers maintaining React applications.";
    const hydratedHtml = `<html><head><title>React versions</title><script>self.__next_f.push([1,"hydration"])</script></head><body><main><h1>React versions</h1><p>${genericText}</p></main></body></html>`;
    const renderedHtml = `<html><body><main><article><h1>React release</h1><p>React 19.2.0 is the latest stable release, released on September 15, 2026. The official React release page records the stable version and its publication date for users.</p></article></main></body></html>`;
    const deps = dependencies(
      {
        [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
        [`GET ${pageUrl} range`]: () => htmlResponse(hydratedHtml),
        [`GET ${pageUrl}`]: () => htmlResponse(hydratedHtml),
      },
      renderedHtml,
    );

    const result = await retrieveSource(
      {
        result: {
          ...searchResult,
          title: "React versions",
          snippet: "The official React versions page lists stable releases and release history.",
        },
        question,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("browser");
    expect(result.retrievalAttempts).toEqual([
      "serper_snippet",
      "rss",
      "structured",
      "http",
      "browser",
    ]);
    expect(result.document.content).toContain("React 19.2.0");
    expect(result.retrievalReasons).toContain(
      "Rendered page exposed the requested fact values absent from normal HTML.",
    );
    expect(deps.browser).toHaveBeenCalledTimes(1);
    expect(fullPageGetCount(deps)).toBe(1);
  });

  it("does not browser-render readable static HTML merely because requested facts are absent", async () => {
    const question =
      "Investigate the latest stable React release; verify the version and release date.";
    const staticHtml = `<html><head><title>React versions</title></head><body><main><h1>React versions</h1><p>${article} ${article}</p></main></body></html>`;
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(staticHtml),
      [`GET ${pageUrl}`]: () => htmlResponse(staticHtml),
    });

    const result = await retrieveSource(
      {
        result: {
          ...searchResult,
          title: "React versions",
          snippet: "The official React versions page lists stable releases and release history.",
        },
        question,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("http");
    expect(result.retrievalReasons.at(-1)).toContain(
      "Normal HTML extraction succeeded but lacks requested fact(s): version, release date",
    );
    expect(deps.browser).not.toHaveBeenCalled();
  });

  it("uses the bounded browser fallback only for a JavaScript shell", async () => {
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const deps = dependencies(
      {
        [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
        [`GET ${pageUrl} range`]: () => htmlResponse(shell),
        [`GET ${pageUrl}`]: () => htmlResponse(shell),
      },
      `<html><body><main><article><h1>Performance report</h1><p>${article.repeat(2)}</p></article></main></body></html>`,
    );
    const result = await retrieveSource({ result: searchResult, question: "performance" }, deps);
    expect(result.retrievalMethod).toBe("browser");
    expect(result.retrievalAttempts).toEqual([
      "serper_snippet",
      "rss",
      "structured",
      "http",
      "browser",
    ]);
    expect(deps.browser).toHaveBeenCalledTimes(1);
    expect(fullPageGetCount(deps)).toBe(1);
  });

  it("extracts a same-origin public JSON fact when rendered DOM remains sparse", async () => {
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const appData = JSON.stringify({
      company: {
        name: "Relyce Infotech",
        leadership: [
          { name: "Ukenthiran A", role: "Founder & CEO", email: "private@example.test" },
        ],
        api_key: "must-not-be-retained",
      },
    });
    const deps = dependencies(
      {
        [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
        [`GET ${pageUrl} range`]: () => htmlResponse(shell),
        [`GET ${pageUrl}`]: () => htmlResponse(shell),
      },
      '<html><body><main><div id="app"></div></main></body></html>',
      {},
      [{ path: "/api/company/about", contentType: "application/json", body: appData }],
    );

    const result = await retrieveSource(
      {
        result: { url: pageUrl, title: "Relyce Infotech", snippet: "" },
        question: "Who is the CEO of Relyce Infotech?",
        allowSnippetEvidence: false,
        researchChatOptimization: true,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("browser");
    expect(result.document.content).toContain("company.name: Relyce Infotech");
    expect(result.document.content).toContain("Founder & CEO");
    expect(result.document.content).toContain("Ukenthiran A");
    expect(result.document.content).not.toContain("private@example.test");
    expect(result.document.content).not.toContain("must-not-be-retained");
    expect(result.retrievalReasons.join("\n")).toContain(
      "same-origin browser response(s): /api/company/about",
    );
  });

  it("keeps discovered-page browser rendering pinned to the validated site origin", async () => {
    const origin = "https://relyceinfotech.com";
    const childUrl = `${origin}/company/leadership`;
    const ceoEvidence = "Ukenthiran A is the Founder & CEO of Relyce Infotech.";
    const renderedBody = `${ceoEvidence} The company profile identifies his executive role and describes his responsibility for the organization's strategy, technology operations, consulting services, and long-term development.`;
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const rendered = `<html><body><main><article><h1>Relyce Infotech leadership</h1><p>${renderedBody}</p></article></main></body></html>`;
    const deps = dependencies(
      {
        [`HEAD ${childUrl}`]: htmlResponse(""),
        [`GET ${childUrl} range`]: htmlResponse(shell),
        [`GET ${childUrl}`]: htmlResponse(shell),
      },
      rendered,
    );
    const result = await retrieveSource(
      {
        result: { url: childUrl, title: "Relyce Infotech leadership", snippet: "" },
        question: "Who is the CEO of Relyce Infotech?",
        allowSnippetEvidence: false,
        researchChatOptimization: true,
        allowedOrigin: origin,
      },
      deps,
    );

    expect(result.retrievalMethod).toBe("browser");
    expect(result.document.content).toContain(ceoEvidence);
    expect(deps.browser).toHaveBeenCalledWith(childUrl, undefined, origin);
    expect(
      (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.every((call) => call[3] === origin),
    ).toBe(true);
  });

  it("rejects a discovered page whose final HTTP URL leaves the validated origin", async () => {
    const origin = "https://relyceinfotech.com";
    const childUrl = `${origin}/company/leadership`;
    const deps = dependencies(
      {
        [`HEAD ${childUrl}`]: htmlResponse(""),
        [`GET ${childUrl} range`]: htmlResponse("<html><head></head></html>"),
        [`GET ${childUrl}`]: htmlResponse(
          "<html><body>Relyce Infotech leadership information</body></html>",
        ),
      },
      undefined,
      { [childUrl]: "https://attacker.example/company/leadership" },
    );

    await expect(
      retrieveSource(
        {
          result: { url: childUrl, title: "Relyce Infotech leadership", snippet: "" },
          question: "Who is the CEO of Relyce Infotech?",
          allowSnippetEvidence: false,
          allowedOrigin: origin,
        },
        deps,
      ),
    ).rejects.toThrow("Fetch result is outside the discovered site origin");
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.browser).not.toHaveBeenCalled();
  });

  it("cancels an unresponsive browser fallback at the shared research deadline", async () => {
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(shell),
      [`GET ${pageUrl}`]: () => htmlResponse(shell),
    });
    deps.browser = vi.fn(() => new Promise<{ url: string; html: string }>(() => undefined));
    const controller = new AbortController();
    const context = {
      deadlineAt: Date.now() + 2000,
      signal: controller.signal,
      stageTimings: {},
    };
    const retrieval = runWithResearchExecutionContext(context, () =>
      retrieveSource({ result: searchResult, question: "performance" }, deps),
    );
    const browserDeadline = Date.now() + 1000;
    while (!deps.browser.mock.calls.length && Date.now() < browserDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(deps.browser).toHaveBeenCalledOnce();
    controller.abort(new Error("Research time budget exhausted"));

    await expect(retrieval).rejects.toThrow("Research time budget exhausted");
    expect(context.stageTimings.browser_extraction).toBeGreaterThan(0);
  });

  it("fails closed when browser rendering remains empty and never retries a source", async () => {
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    const deps = dependencies({
      [`HEAD ${pageUrl}`]: () => new Response(null, { headers: { "content-type": "text/html" } }),
      [`GET ${pageUrl} range`]: () => htmlResponse(shell),
      [`GET ${pageUrl}`]: () => htmlResponse(shell),
    });
    await expect(
      retrieveSource({ result: searchResult, question: "performance" }, deps),
    ).rejects.toThrow("too short");
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(fullPageGetCount(deps)).toBe(1);
    expect(deps.browser).toHaveBeenCalledTimes(1);
  });
});

describe("bounded first-party GitHub release-history fallback", () => {
  const releasesUrl = "https://github.com/python/cpython/releases";
  const feedUrl = "https://github.com/python/cpython/releases.atom";
  const apiUrl = "https://api.github.com/repos/python/cpython/releases?per_page=30";
  const apiPage2Url = "https://api.github.com/repos/python/cpython/releases?per_page=30&page=2";
  const historyQuestion = "Compare official Python stable releases and their dates.";
  const previewHtml =
    '<html><head><title>Releases · python/cpython</title><script type="application/ld+json">' +
    JSON.stringify({
      "@type": "Article",
      headline: "Python releases preview",
      description:
        "The official Python release history page provides a short preview for maintainers and links to the complete release archive.",
    }) +
    "</script></head><body><main><p>Python releases.</p></main></body></html>";
  const historyHtml =
    "<html><head><title>Releases · python/cpython</title></head><body><main><h1>Python release history</h1><p>Python 3.12.0 | release date: 2023-10-02 | status: stable. Published as a stable Python release for general use.</p><p>Python 3.13.0 | release date: 2024-10-07 | status: stable. Published as a stable Python release for general use.</p></main></body></html>";
  const atom =
    "<feed><title>Python releases</title>" +
    '<entry><title>Python 3.13.0</title><published>2024-10-07T00:00:00Z</published><category term="Stable"/><summary>Stable release.</summary></entry>' +
    '<entry><title>Python 3.12.0</title><published>2023-10-02T00:00:00Z</published><category term="Stable"/><summary>Stable release.</summary></entry>' +
    "</feed>";
  const releases = JSON.stringify([
    { tag_name: "3.14.0-rc.1", published_at: "2025-07-15T00:00:00Z", prerelease: true },
    { tag_name: "3.13.0", published_at: "2024-10-07T00:00:00Z", prerelease: false },
    { tag_name: "3.12.0", published_at: "2023-10-02T00:00:00Z", prerelease: false },
  ]);

  const reactReleaseHistoryUrl = "https://github.com/react/react/releases";
  const reactReleaseFeedUrl = `${reactReleaseHistoryUrl}.atom`;
  const reactReleaseApiUrl = "https://api.github.com/repos/react/react/releases?per_page=30";
  const reactRepositoryMetadataUrl = "https://api.github.com/repos/react/react";
  const reactNumericReleasePage2Url =
    "https://api.github.com/repositories/10270250/releases?per_page=30&page=2";
  const minimalReactReleasePage1 = JSON.stringify([
    { tag_name: "19.3.0", published_at: "2026-09-09T00:00:00Z", prerelease: false },
    { tag_name: "19.2.0", published_at: "2025-10-01T00:00:00Z", prerelease: false },
  ]);
  const minimalReactReleasePage2 = JSON.stringify([
    { tag_name: "19.1.0", published_at: "2025-03-28T00:00:00Z", prerelease: false },
  ]);
  const validReactRepositoryMetadata = JSON.stringify({
    id: 10270250,
    name: "react",
    full_name: "react/react",
    owner: { login: "react" },
  });

  function numericReactHistoryDependencies(options: {
    metadata: Response | Error;
    nextUrl?: string;
    metadataResolvedUrl?: string;
  }) {
    const nextUrl = options.nextUrl ?? reactNumericReleasePage2Url;
    return dependencies(
      {
        ["HEAD " + reactReleaseHistoryUrl]: () =>
          new Response(null, { headers: { "content-type": "text/html" } }),
        ["GET " + reactReleaseHistoryUrl + " range"]: () => htmlResponse(previewHtml),
        ["GET " + reactReleaseHistoryUrl]: () => htmlResponse(previewHtml),
        ["GET " + reactReleaseFeedUrl]: () =>
          new Response("<feed><title>React releases</title></feed>", {
            headers: { "content-type": "application/atom+xml" },
          }),
        ["GET " + reactReleaseApiUrl]: () =>
          new Response(minimalReactReleasePage1, {
            headers: {
              "content-type": "application/vnd.github+json",
              link: `<${nextUrl}>; rel="next"`,
            },
          }),
        ["GET " + reactRepositoryMetadataUrl]: options.metadata,
        ["GET " + nextUrl]: () =>
          new Response(minimalReactReleasePage2, {
            headers: { "content-type": "application/vnd.github+json" },
          }),
      },
      undefined,
      options.metadataResolvedUrl
        ? { [reactRepositoryMetadataUrl]: options.metadataResolvedUrl }
        : {},
    );
  }

  function historyDependencies(
    apiLink?: string,
    apiPage2?: Response | Error,
    apiBody = releases,
    apiPage2RequestUrl = apiPage2Url,
  ) {
    return dependencies({
      ["HEAD " + releasesUrl]: () =>
        new Response(null, { headers: { "content-type": "text/html" } }),
      ["GET " + releasesUrl + " range"]: () => htmlResponse(previewHtml),
      ["GET " + releasesUrl]: () => htmlResponse(historyHtml),
      ["GET " + feedUrl]: () =>
        new Response(atom, { headers: { "content-type": "application/atom+xml" } }),
      ["GET " + apiUrl]: () =>
        new Response(apiBody, {
          headers: {
            "content-type": "application/vnd.github+json",
            ...(apiLink ? { link: apiLink } : {}),
          },
        }),
      ...(apiPage2
        ? {
            ["GET " + apiPage2RequestUrl]: apiPage2,
          }
        : {}),
    });
  }

  it("escalates thin preview through full HTML, Atom, then the exact structured API", async () => {
    const deps = historyDependencies();
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result).toMatchObject({
      url: releasesUrl,
      retrievalMethod: "structured",
      retrievalSourceUrl: apiUrl,
      releaseHistorySourceKind: "first_party_structured",
      releaseHistoryComplete: true,
    });
    expect(result.document.content).toContain("3.14.0-rc.1");
    expect(result.document.content).toContain("status: prerelease");
    expect(result.document.content).toContain("3.13.0 | release date: 2024-10-07 | status: stable");
    expect(result.retrievalAttempts).toEqual(
      expect.arrayContaining([
        "github_releases_html",
        "github_releases_feed",
        "github_releases_api",
      ]),
    );

    const urls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
    expect(urls.indexOf(releasesUrl)).toBeLessThan(urls.indexOf(feedUrl));
    expect(urls.indexOf(feedUrl)).toBeLessThan(urls.indexOf(apiUrl));
    expect(urls.filter((url) => url === apiUrl)).toHaveLength(1);
    expect(
      result.retrievalReasons.some((reason) => reason.startsWith("GitHub pagination diagnostic:")),
    ).toBe(false);
  });

  it("follows a valid next-page link and resolves a complete paginated history", async () => {
    const page2Releases = JSON.stringify([
      { tag_name: "3.11.0", published_at: "2022-10-24T00:00:00Z", prerelease: false },
      { tag_name: "3.10.0", published_at: "2021-10-04T00:00:00Z", prerelease: false },
    ]);
    const deps = historyDependencies(
      '<https://api.github.com/repos/python/cpython/releases?per_page=30&page=2>; rel="next"',
      new Response(page2Releases, { headers: { "content-type": "application/vnd.github+json" } }),
    );
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistorySourceKind).toBe("first_party_structured");
    expect(result.releaseHistoryComplete).toBe(true);
    expect(result.document.content).toContain("3.11.0 | release date: 2022-10-24 | status: stable");
    expect(result.document.content).toContain(apiPage2Url);
    const paginationDiagnostic = result.retrievalReasons.find((reason) =>
      reason.startsWith("GitHub pagination diagnostic:"),
    );
    expect(paginationDiagnostic).toContain('"sourcePath":"/repos/python/cpython/releases"');
    expect(paginationDiagnostic).toContain('"nextPath":"/repos/python/cpython/releases"');
    expect(paginationDiagnostic).toContain('"queryKeys":["page","per_page"]');
    expect(paginationDiagnostic).toContain('"parsedPage":2');
    expect(paginationDiagnostic).toContain('"expectedPage":2');
    expect(paginationDiagnostic).toContain('"originMatches":true');
    expect(paginationDiagnostic).toContain('"repositoryPathMatches":true');
    expect(paginationDiagnostic).toContain('"sequentialPageMatches":true');
    expect(paginationDiagnostic).toContain('"rejectionReason":null');
    expect(deps.fetch).toHaveBeenCalledWith(
      apiPage2Url,
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.retrievalReasons.join(" ")).toContain("ended after 2 page(s)");
  });

  it("resolves a relative Link target against the validated current release endpoint", async () => {
    const deps = historyDependencies(
      '</repos/python/cpython/releases?per_page=30&page=2>; rel="next"',
      new Response(
        JSON.stringify([
          { tag_name: "3.11.0", published_at: "2022-10-24T00:00:00Z", prerelease: false },
          { tag_name: "3.10.0", published_at: "2021-10-04T00:00:00Z", prerelease: false },
        ]),
        { headers: { "content-type": "application/vnd.github+json" } },
      ),
    );
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(true);
    expect(deps.fetch).toHaveBeenCalledWith(
      apiPage2Url,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("accepts a sequential exact-endpoint Link when query parameters are reordered", async () => {
    const reorderedPage2Url =
      "https://api.github.com/repos/python/cpython/releases?page=2&per_page=30";
    const deps = historyDependencies(
      `<${reorderedPage2Url}>; rel="next"`,
      new Response(
        JSON.stringify([
          { tag_name: "3.11.0", published_at: "2022-10-24T00:00:00Z", prerelease: false },
          { tag_name: "3.10.0", published_at: "2021-10-04T00:00:00Z", prerelease: false },
        ]),
        { headers: { "content-type": "application/vnd.github+json" } },
      ),
      releases,
      reorderedPage2Url,
    );
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(true);
    expect(deps.fetch).toHaveBeenCalledWith(
      reorderedPage2Url,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps history incomplete when an advertised continuation cannot be retrieved", async () => {
    const deps = historyDependencies(
      '<https://api.github.com/repos/python/cpython/releases?per_page=30&page=2>; rel="next"',
    );
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistorySourceKind).toBe("first_party_structured");
    expect(result.releaseHistoryComplete).toBe(false);
    expect(result.document.content).toContain("3.13.0");
    expect(result.retrievalReasons.join(" ")).toContain(
      "later first-party API page could not be retrieved",
    );
    expect(deps.fetch).toHaveBeenCalledTimes(6);

    const pythonHistory: Source = {
      id: "python-incomplete-paginated-history",
      title: result.document.title,
      url: result.url,
      snippet: result.document.content,
      domain: "github.com",
      sourceType: "official",
      firstPartyClassification: classifyFirstPartyGitHubSource(result.url),
      releaseHistorySourceKind: result.releaseHistorySourceKind,
      releaseHistoryComplete: result.releaseHistoryComplete,
      retrievalSourceUrl: result.retrievalSourceUrl,
      retrievalMethod: result.retrievalMethod,
      content: result.document.content,
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const pythonLatestQuestion = "What is the latest stable Python release?";
    const claims = extractOfficialReleaseHistoryClaimCandidates({
      question: pythonLatestQuestion,
      entities: ["Python"],
      requestedFacts: ["version", "release date", "stable status", "release status"],
      sources: [pythonHistory],
      officialSourcesRequired: true,
    });
    const latestness = assessLatestnessEvidence({
      question: pythonLatestQuestion,
      entities: ["Python"],
      claims,
      sources: [pythonHistory],
      officialSourcesRequired: true,
      stableRequired: true,
    });
    expect(latestness.conclusion).not.toBe("PROVEN");
    expect(latestness.latestVersion).toBeUndefined();
    expect(latestness.releaseHistoryResolution?.complete).toBe(false);
  });

  it("rejects an advertised continuation outside the exact first-party API endpoint", async () => {
    const deps = historyDependencies(
      '<https://api.github.com/repos/example/other/releases?per_page=30&page=2&private_token=never-log-this>; rel="next"',
    );
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(result.retrievalReasons.join(" ")).toContain("invalid or unsafe next-page link");
    const paginationDiagnostic = result.retrievalReasons.find((reason) =>
      reason.startsWith("GitHub pagination diagnostic:"),
    );
    expect(paginationDiagnostic).toContain('"nextOrigin":"https://api.github.com"');
    expect(paginationDiagnostic).toContain('"repositoryPathMatches":false');
    expect(paginationDiagnostic).toContain('"rejectionReason":"repository_path_mismatch"');
    expect(paginationDiagnostic).not.toContain("never-log-this");
    expect(deps.fetch).not.toHaveBeenCalledWith(
      "https://api.github.com/repos/example/other/releases?per_page=30&page=2",
      expect.anything(),
    );
  });

  it.each([
    {
      label: "a different origin",
      link: '<https://api.github.com.evil/repos/python/cpython/releases?per_page=30&page=2>; rel="next"',
      rejection: "origin_mismatch",
      diagnosticField: '"originMatches":false',
    },
    {
      label: "a non-sequential page",
      link: '<https://api.github.com/repos/python/cpython/releases?per_page=30&page=3>; rel="next"',
      rejection: "non_sequential_or_invalid_page",
      diagnosticField: '"parsedPage":3',
    },
    {
      label: "a malformed page number",
      link: '<https://api.github.com/repos/python/cpython/releases?per_page=30&page=two>; rel="next"',
      rejection: "non_sequential_or_invalid_page",
      diagnosticField: '"parsedPage":null',
    },
    {
      label: "an unexpected query key",
      link: '<https://api.github.com/repos/python/cpython/releases?per_page=30&page=2&access_token=not-for-logs>; rel="next"',
      rejection: "unexpected_query_key",
      diagnosticField: '"allowedQueryKeys":false',
    },
    {
      label: "a next relation without a target",
      link: 'rel="next"',
      rejection: "missing_target",
      diagnosticField: '"nextPath":null',
    },
  ])(
    "keeps pagination incomplete and diagnoses $label",
    async ({ link, rejection, diagnosticField }) => {
      const deps = historyDependencies(link);
      const result = await retrieveSource(
        {
          result: {
            url: releasesUrl,
            title: "Releases · python/cpython",
            snippet: "The official Python release archive lists stable versions and dates.",
          },
          question: historyQuestion,
        },
        deps,
      );

      expect(result.releaseHistoryComplete).toBe(false);
      const diagnostic = result.retrievalReasons.find((reason) =>
        reason.startsWith("GitHub pagination diagnostic:"),
      );
      expect(diagnostic).toContain(diagnosticField);
      expect(diagnostic).toContain(`"rejectionReason":"${rejection}"`);
      expect(diagnostic).not.toContain("not-for-logs");
      expect(diagnostic).not.toContain("private_token");
      expect(deps.fetch).not.toHaveBeenCalledWith(apiPage2Url, expect.anything());
    },
  );

  it("does not treat a release with missing channel metadata as a complete stable-history record", async () => {
    const rowsWithUnknownStatus = JSON.stringify([
      { tag_name: "3.13.0", published_at: "2024-10-07T00:00:00Z", prerelease: false },
      { tag_name: "3.14.0", published_at: "2025-10-07T00:00:00Z" },
    ]);
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      historyDependencies(undefined, undefined, rowsWithUnknownStatus),
    );
    const historySource: Source = {
      id: "python-history-unknown-status",
      title: result.document.title,
      url: result.url,
      snippet: result.document.content,
      domain: "github.com",
      sourceType: "official",
      firstPartyClassification: classifyFirstPartyGitHubSource(result.url),
      releaseHistorySourceKind: result.releaseHistorySourceKind,
      releaseHistoryComplete: result.releaseHistoryComplete,
      retrievalSourceUrl: result.retrievalSourceUrl,
      retrievalMethod: result.retrievalMethod,
      content: result.document.content,
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const resolution = resolveOfficialReleaseHistory({
      sources: [historySource],
      question: historyQuestion,
      entity: "Python",
    });

    expect(result.releaseHistoryComplete).toBe(true);
    expect(result.document.content).toContain(
      "3.14.0 | release date: 2025-10-07 | status: unknown",
    );
    expect(resolution.complete).toBe(false);
    expect(resolution.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "3.14.0",
          stability: "unknown",
          completeHistory: false,
        }),
      ]),
    );
  });

  it("bounds pagination and leaves history incomplete when more pages remain", async () => {
    const routes: Record<string, Response | Error | (() => Response)> = {
      ["HEAD " + releasesUrl]: () =>
        new Response(null, { headers: { "content-type": "text/html" } }),
      ["GET " + releasesUrl + " range"]: () => htmlResponse(previewHtml),
      ["GET " + releasesUrl]: () => htmlResponse(historyHtml),
      ["GET " + feedUrl]: () =>
        new Response(atom, { headers: { "content-type": "application/atom+xml" } }),
    };
    for (let page = 1; page <= 5; page += 1) {
      const url = `https://api.github.com/repos/python/cpython/releases?per_page=30${page === 1 ? "" : `&page=${page}`}`;
      const nextUrl = `https://api.github.com/repos/python/cpython/releases?per_page=30&page=${page + 1}`;
      routes["GET " + url] = () =>
        new Response(releases, {
          headers: {
            "content-type": "application/vnd.github+json",
            link: `<${nextUrl}>; rel="next"`,
          },
        });
    }
    const deps = dependencies(routes);
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(result.retrievalReasons.join(" ")).toContain("bounded API page limit was reached");
    const apiCalls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).startsWith("https://api.github.com/repos/python/cpython/releases"),
    );
    expect(apiCalls).toHaveLength(5);
  });

  it("resolves latest stable React from complete paginated first-party history", async () => {
    const reactReleasesUrl = "https://github.com/react/react/releases";
    const reactFeedUrl = "https://github.com/react/react/releases.atom";
    const reactApiPage1 = "https://api.github.com/repos/react/react/releases?per_page=30";
    const reactMetadataUrl = "https://api.github.com/repos/react/react";
    const reactApiPage2 =
      "https://api.github.com/repositories/10270250/releases?per_page=30&page=2";
    const reactQuestion = "What is the latest stable React version?";
    const page1 = JSON.stringify([
      {
        tag_name: "v19.3.0",
        name: "React 19.3.0",
        published_at: "2026-09-09T00:00:00Z",
        prerelease: false,
      },
      {
        tag_name: "v19.2.0",
        name: "React 19.2.0",
        published_at: "2025-10-01T00:00:00Z",
        prerelease: false,
      },
      {
        tag_name: "v19.4.0-rc.1",
        name: "React 19.4.0 Release Candidate",
        published_at: "2026-12-01T00:00:00Z",
        prerelease: true,
      },
      {
        tag_name: "0.81.0",
        name: "React Native 0.81.0",
        published_at: "2026-08-12T00:00:00Z",
        prerelease: false,
      },
      {
        tag_name: "19.3.1",
        name: "Draft React release",
        published_at: "2026-09-12T00:00:00Z",
        prerelease: false,
        draft: true,
      },
    ]);
    const page2 = JSON.stringify([
      {
        tag_name: "v19.1.0",
        name: "React 19.1.0",
        published_at: "2025-03-28T00:00:00Z",
        prerelease: false,
      },
    ]);
    const reactPreview =
      "<html><head><title>Releases · react/react</title></head><body><main><p>React release history.</p></main></body></html>";
    const deps = dependencies({
      ["HEAD " + reactReleasesUrl]: () =>
        new Response(null, { headers: { "content-type": "text/html" } }),
      ["GET " + reactReleasesUrl + " range"]: () => htmlResponse(reactPreview),
      ["GET " + reactReleasesUrl]: () => htmlResponse(reactPreview),
      ["GET " + reactFeedUrl]: () =>
        new Response("<feed><title>React releases</title></feed>", {
          headers: { "content-type": "application/atom+xml" },
        }),
      ["GET " + reactApiPage1]: () =>
        new Response(page1, {
          headers: {
            "content-type": "application/vnd.github+json",
            link: `<${reactApiPage2}>; rel="next"`,
          },
        }),
      ["GET " + reactMetadataUrl]: () =>
        new Response(
          JSON.stringify({
            id: 10270250,
            name: "react",
            full_name: "react/react",
            owner: { login: "react" },
          }),
          { headers: { "content-type": "application/vnd.github+json" } },
        ),
      ["GET " + reactApiPage2]: () =>
        new Response(page2, { headers: { "content-type": "application/vnd.github+json" } }),
    });

    const retrieved = await retrieveSource(
      {
        result: {
          url: reactReleasesUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: reactQuestion,
      },
      deps,
    );
    const reactHistory: Source = {
      id: "react-paginated-history",
      title: retrieved.document.title,
      url: retrieved.url,
      snippet: retrieved.document.content,
      domain: "github.com",
      sourceType: "official",
      firstPartyClassification: classifyFirstPartyGitHubSource(retrieved.url),
      releaseHistorySourceKind: retrieved.releaseHistorySourceKind,
      releaseHistoryComplete: retrieved.releaseHistoryComplete,
      retrievalSourceUrl: retrieved.retrievalSourceUrl,
      retrievalMethod: retrieved.retrievalMethod,
      content: retrieved.document.content,
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const claims = extractOfficialReleaseHistoryClaimCandidates({
      question: reactQuestion,
      entities: ["React"],
      requestedFacts: ["version", "release date", "stable status", "release status"],
      sources: [reactHistory],
      officialSourcesRequired: true,
    });
    const latestness = assessLatestnessEvidence({
      question: reactQuestion,
      entities: ["React"],
      claims,
      sources: [reactHistory],
      officialSourcesRequired: true,
      stableRequired: true,
    });

    expect(retrieved.releaseHistoryComplete).toBe(true);
    expect(retrieved.document.content).toContain("source page: " + reactApiPage2);
    const numericPaginationDiagnostic = retrieved.retrievalReasons.find(
      (reason) =>
        reason.startsWith("GitHub pagination diagnostic:") && reason.includes("repositories/"),
    );
    expect(numericPaginationDiagnostic).toContain('"repositoryIdBound":true');
    expect(numericPaginationDiagnostic).toContain('"repositoryIdMatch":true');
    expect(numericPaginationDiagnostic).toContain('"boundRepository":"react/react"');
    expect(numericPaginationDiagnostic).toContain('"boundRepositoryId":10270250');
    expect(deps.fetch).toHaveBeenCalledWith(
      reactMetadataUrl,
      expect.objectContaining({ method: "GET" }),
    );
    expect(retrieved.document.content).not.toContain("React Native 0.81.0");
    expect(retrieved.document.content).not.toContain("19.3.1");
    expect(latestness).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "19.3.0",
    });
    expect(latestness.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ olderVersion: "19.2.0", newerVersion: "19.3.0" }),
      ]),
    );
    expect(latestness.candidateVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "19.4.0-rc.1",
          stability: "prerelease",
          releaseChannel: "rc",
        }),
      ]),
    );
    expect(latestness.comparisons).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ olderVersion: "19.3.0", newerVersion: "19.4.0-rc.1" }),
      ]),
    );
    expect(latestness.releaseRecords.every((record) => record.sourceId === reactHistory.id)).toBe(
      true,
    );
    expect(latestness.releaseRecords.every((record) => record.releaseHistoryComplete)).toBe(true);
  });

  it("rejects a numeric repository ID that differs from validated canonical metadata", async () => {
    const mismatchedNextUrl =
      "https://api.github.com/repositories/10270251/releases?per_page=30&page=2";
    const deps = numericReactHistoryDependencies({
      metadata: new Response(validReactRepositoryMetadata, {
        headers: { "content-type": "application/vnd.github+json" },
      }),
      nextUrl: mismatchedNextUrl,
    });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalledWith(mismatchedNextUrl, expect.anything());
    expect(result.retrievalReasons.join(" ")).toContain("repository_id_mismatch");
  });

  it("binds a numeric repository ID from canonical metadata instead of a hardcoded route ID", async () => {
    const metadataId = 87654321;
    const nextUrl = `https://api.github.com/repositories/${metadataId}/releases?per_page=30&page=2`;
    const deps = numericReactHistoryDependencies({
      metadata: new Response(
        JSON.stringify({
          id: metadataId,
          name: "react",
          full_name: "react/react",
          owner: { login: "react" },
        }),
        { headers: { "content-type": "application/vnd.github+json" } },
      ),
      nextUrl,
    });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(true);
    expect(result.document.content).toContain("source page: " + nextUrl);
    expect(result.retrievalReasons.join(" ")).toContain(`"boundRepositoryId":${metadataId}`);
  });

  it.each([
    {
      label: "metadata naming a different repository",
      body: JSON.stringify({
        id: 10270250,
        name: "other",
        full_name: "react/other",
        owner: { login: "react" },
      }),
    },
    {
      label: "metadata with an incorrect owner",
      body: JSON.stringify({
        id: 10270250,
        name: "react",
        full_name: "react/react",
        owner: { login: "someone-else" },
      }),
    },
    {
      label: "metadata with a malformed repository ID",
      body: JSON.stringify({
        id: "10270250",
        name: "react",
        full_name: "react/react",
        owner: { login: "react" },
      }),
    },
  ])("keeps numeric pagination incomplete when $label", async ({ body }) => {
    const deps = numericReactHistoryDependencies({
      metadata: new Response(body, {
        headers: { "content-type": "application/vnd.github+json" },
      }),
    });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalledWith(reactNumericReleasePage2Url, expect.anything());
    expect(result.retrievalReasons.join(" ")).toContain(
      "could not be bound to validated canonical repository metadata",
    );
  });

  it("rejects canonical repository metadata redirected outside api.github.com", async () => {
    const deps = numericReactHistoryDependencies({
      metadata: new Response(validReactRepositoryMetadata, {
        headers: { "content-type": "application/vnd.github+json" },
      }),
      metadataResolvedUrl: "https://api.github.com.evil/repos/react/react",
    });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalledWith(reactNumericReleasePage2Url, expect.anything());
  });

  it.each([
    "https://api.github.com/repositories/not-a-number/releases?per_page=30&page=2",
    "https://api.github.com/repositories/0/releases?per_page=30&page=2",
    "https://api.github.com/repositories/010270250/releases?per_page=30&page=2",
    "https://api.github.com/repositories/10270250/releases?per_page=30&page=3",
  ])("rejects malformed or non-sequential numeric continuation %s", async (nextUrl) => {
    const deps = numericReactHistoryDependencies({
      metadata: new Response(validReactRepositoryMetadata, {
        headers: { "content-type": "application/vnd.github+json" },
      }),
      nextUrl,
    });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(result.retrievalReasons.join(" ")).toMatch(
      /repository_path_mismatch|non_sequential_or_invalid_page/,
    );
    expect(deps.fetch).not.toHaveBeenCalledWith(nextUrl, expect.anything());
  });

  it("does not follow a numeric continuation when canonical metadata cannot be fetched", async () => {
    const deps = numericReactHistoryDependencies({ metadata: new Error("fixture: unavailable") });
    const result = await retrieveSource(
      {
        result: {
          url: reactReleaseHistoryUrl,
          title: "Releases · react/react",
          snippet: "Official React releases and history.",
        },
        question: "What is the latest stable React version?",
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalledWith(reactNumericReleasePage2Url, expect.anything());
    expect(result.retrievalReasons.join(" ")).toContain(
      '"rejectionReason":"repository_id_unbound"',
    );
  });

  it("continues to the structured API when HTML and Atom retrieval fail", async () => {
    const deps = dependencies({
      ["HEAD " + releasesUrl]: () =>
        new Response(null, { headers: { "content-type": "text/html" } }),
      ["GET " + releasesUrl + " range"]: () => htmlResponse(previewHtml),
      ["GET " + releasesUrl]: new Error("fixture: HTML unavailable"),
      ["GET " + feedUrl]: new Error("fixture: Atom unavailable"),
      ["GET " + apiUrl]: () =>
        new Response(releases, {
          headers: { "content-type": "application/vnd.github+json" },
        }),
    });
    const result = await retrieveSource(
      {
        result: {
          url: releasesUrl,
          title: "Releases · python/cpython",
          snippet: "The official Python release archive lists stable versions and dates.",
        },
        question: historyQuestion,
      },
      deps,
    );

    expect(result.releaseHistoryComplete).toBe(true);
    expect(result.document.content).toContain("3.14.0-rc.1");
    expect(result.retrievalReasons.join(" ")).toContain("HTML request was unavailable");
    expect(result.retrievalReasons.join(" ")).toContain("Atom feed request was unavailable");
  });

  it("does not apply the allowlisted GitHub history ladder to arbitrary repositories", async () => {
    const arbitraryUrl = "https://github.com/example/project/releases";
    const deps = dependencies({
      ["HEAD " + arbitraryUrl]: () =>
        new Response(null, { headers: { "content-type": "text/html" } }),
      ["GET " + arbitraryUrl + " range"]: () =>
        htmlResponse("<html><head><title>Project</title></head></html>"),
      ["GET " + arbitraryUrl]: () =>
        htmlResponse(
          "<html><head><title>Project</title></head><body><main><article><h1>Project</h1><p>" +
            article.repeat(2) +
            "</p></article></main></body></html>",
        ),
    });
    await retrieveSource(
      {
        result: {
          url: arbitraryUrl,
          title: "Project releases",
          snippet: "Short result snippet.",
        },
        question: "Project release history",
      },
      deps,
    );

    expect(deps.fetch).not.toHaveBeenCalledWith(feedUrl, expect.anything());
    expect(deps.fetch).not.toHaveBeenCalledWith(apiUrl, expect.anything());
  });
});
