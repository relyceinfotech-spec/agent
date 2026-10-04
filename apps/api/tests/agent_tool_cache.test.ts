import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieval = vi.hoisted(() => ({ retrieveSource: vi.fn() }));
const siteDiscovery = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock("../src/source-retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/source-retrieval.js")>();
  return { ...actual, retrieveSource: retrieval.retrieveSource };
});

vi.mock("../src/site-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/site-discovery.js")>();
  return { ...actual, discoverInternalSiteCandidates: siteDiscovery.discover };
});

import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { RetrievedSource } from "../src/source-retrieval.js";
import type { KnowledgeStore, StoredDocument } from "../src/store.js";

const sourceUrl = "https://react.dev/versions";
const versionDateQuestion =
  "Investigate the latest stable React release; verify the version and release date.";

function storedDocument(content: string): StoredDocument {
  const now = new Date().toISOString();
  return {
    url: sourceUrl,
    title: "React releases",
    content,
    rawHtml: "",
    fetchedAt: now,
    lastVerifiedAt: now,
    metadata: { contentType: "structured", domain: "react.dev" },
    contentHash: "cached-content-hash",
    version: 1,
  };
}

function retrievedSource(): RetrievedSource {
  return {
    url: sourceUrl,
    html: "<article>Fresh retrieved release details</article>",
    contentType: "text/html",
    document: {
      title: "React releases",
      description: "",
      domain: "react.dev",
      content:
        "React 19.2.0 is the latest stable release, released on September 15, 2026. Official release details document the version and publication date.",
      headings: [],
      contentType: "html",
    },
    retrievalMethod: "http",
    retrievalAttempts: ["serper_snippet", "rss", "structured", "http"],
    retrievalMethodsSkipped: ["browser"],
    retrievalReasons: ["Fresh article text was extracted."],
    extractionConfidence: 0.9,
    extractionStatus: "SUCCEEDED",
    retrievedContentLength: 131,
  };
}

function createKnowledgeStore(document: StoredDocument): KnowledgeStore {
  return {
    getDocument: vi.fn(async () => document),
    saveDocument: vi.fn(async () => {}),
    searchDocuments: vi.fn(async () => []),
  };
}

describe("question-aware retrieval cache", () => {
  beforeEach(() => {
    retrieval.retrieveSource.mockReset();
    siteDiscovery.discover.mockReset();
  });

  it("revalidates cached latest-release discovery before using it as normal Chat evidence", async () => {
    const cached = storedDocument(
      "React 18.2.0 is the latest stable release, released on June 14, 2022. Official release details document the version and date.",
    );
    retrieval.retrieveSource.mockResolvedValue(retrievedSource());
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      createKnowledgeStore(cached),
    );
    const result = await registry.execute("fetch_url", {
      url: sourceUrl,
      title: "React releases",
      snippet: cached.content,
      provider: "internal-knowledge",
      question: versionDateQuestion,
      researchChatOptimization: true,
      requestedFacts: ["version", "release date", "stable status", "latestness"],
    });
    expect(retrieval.retrieveSource).toHaveBeenCalledOnce();
    expect(retrieval.retrieveSource.mock.calls[0][0].result.snippet).toBe("");
    expect(result).toMatchObject({ cached: false, retrievalMethod: "http" });
  });

  it("rejects a fresh but factually insufficient cache entry and continues retrieval", async () => {
    const cached = storedDocument(
      "The React releases page lists stable versions and recent release information for developers.",
    );
    const fetched = retrievedSource();
    retrieval.retrieveSource.mockResolvedValue(fetched);
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      createKnowledgeStore(cached),
    );

    const result = (await registry.execute("fetch_url", {
      url: sourceUrl,
      title: "React releases",
      snippet: "Official React release page.",
      question: versionDateQuestion,
      requestedFacts: ["version", "release date", "stable status", "latestness"],
    })) as RetrievedSource & { cached: boolean };

    expect(retrieval.retrieveSource).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(result.retrievalMethod).toBe("http");
    expect(result.retrievalAttempts).toEqual([
      "cache",
      "serper_snippet",
      "rss",
      "structured",
      "http",
    ]);
    expect(result.retrievalReasons?.[0]).toContain("version");
  });

  it("uses a fresh cache entry when its text answers the requested fact", async () => {
    const cached = storedDocument(
      "React 19.2.0 is the latest stable release, released on September 15, 2026. Official release details document the version and date.",
    );
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      createKnowledgeStore(cached),
    );

    const result = (await registry.execute("fetch_url", {
      url: sourceUrl,
      title: "React releases",
      snippet: "Official React release page.",
      question: versionDateQuestion,
      requestedFacts: ["version", "release date", "stable status", "latestness"],
    })) as RetrievedSource & { cached: boolean };

    expect(retrieval.retrieveSource).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.retrievalMethod).toBe("cache");
  });

  it("adds bounded same-origin page candidates for an unresolved precise company fact", async () => {
    const rootUrl = "https://relyceinfotech.com/en";
    const fetched = retrievedSource();
    fetched.url = rootUrl;
    fetched.html = '<nav><a href="/company/leadership">Leadership</a></nav>';
    fetched.document = {
      title: "Relyce Infotech | Company",
      description: "Company profile",
      domain: "relyceinfotech.com",
      content:
        "Relyce Infotech provides software development, cloud consulting, and implementation services for business customers.",
      headings: [],
      contentType: "html",
    };
    retrieval.retrieveSource.mockResolvedValue(fetched);
    const candidate = {
      title: "Relyce Infotech — Leadership",
      url: "https://relyceinfotech.com/company/leadership",
      snippet: "A same-origin leadership page.",
      provider: "site-discovery",
      siteDiscoveryOrigin: "https://relyceinfotech.com",
    };
    siteDiscovery.discover.mockResolvedValue([candidate]);
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());

    const result = (await registry.execute("fetch_url", {
      url: rootUrl,
      title: "Relyce Infotech | Company",
      snippet: "Relyce Infotech company profile.",
      sourceType: "commercial",
      question: "Who is the CEO of Relyce Infotech?",
      requestedPredicate: {
        entity: "Relyce Infotech",
        predicate: "CEO",
        aliases: ["CEO", "chief executive officer"],
      },
      entities: ["Relyce Infotech"],
      siteDiscoveryMaxCandidates: 2,
      researchChatOptimization: true,
      allowSnippetEvidence: false,
    })) as RetrievedSource & { siteDiscoveryCandidates: (typeof candidate)[] };

    expect(siteDiscovery.discover).toHaveBeenCalledWith(
      expect.objectContaining({ rootUrl, entity: "Relyce Infotech", maxCandidates: 2 }),
    );
    expect(result.siteDiscoveryCandidates).toEqual([candidate]);
    expect(result.retrievalReasons?.at(-1)).toContain("Same-origin discovery found 1");
  });

  it("pins discovered-page retrieval to its recorded same origin and disables snippets", async () => {
    const childUrl = "https://relyceinfotech.com/company/leadership";
    retrieval.retrieveSource.mockResolvedValue(retrievedSource());
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());

    await registry.execute("fetch_url", {
      url: childUrl,
      title: "Relyce Infotech — Leadership",
      snippet: "A same-origin leadership page.",
      provider: "site-discovery",
      siteDiscoveryOrigin: "https://relyceinfotech.com",
      question: "Who is the CEO of Relyce Infotech?",
      allowSnippetEvidence: true,
      researchChatOptimization: true,
    });

    expect(retrieval.retrieveSource).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOrigin: "https://relyceinfotech.com",
        allowSnippetEvidence: false,
      }),
    );
  });

  it("preserves metadata-only provenance when a validated cache entry is reused", async () => {
    const cached = storedDocument(
      "React 19.2.0 is the latest stable release, released on September 15, 2026. Official release details document the version and date.",
    );
    cached.metadata!.contentOrigin = "metadata";
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      createKnowledgeStore(cached),
    );

    const result = (await registry.execute("fetch_url", {
      url: sourceUrl,
      title: "React releases",
      snippet: "Official React release page.",
      question: versionDateQuestion,
      requestedFacts: ["version", "release date", "stable status", "latestness"],
    })) as RetrievedSource & { cached: boolean };

    expect(result.cached).toBe(true);
    expect(result.document.contentOrigin).toBe("metadata");
  });

  it("recognizes legacy structured cache entries that contain only the page description", async () => {
    const description =
      "React 19.2.0 is the latest stable release, released on September 15, 2026. Official release details document the version and date.";
    const cached = storedDocument(description);
    cached.metadata = {
      contentType: "structured",
      retrievalMethod: "structured",
      description,
      domain: "react.dev",
    };
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      createKnowledgeStore(cached),
    );

    const result = (await registry.execute("fetch_url", {
      url: sourceUrl,
      title: "React releases",
      snippet: "Official React release page.",
      question: versionDateQuestion,
      requestedFacts: ["version", "release date", "stable status", "latestness"],
    })) as RetrievedSource & { cached: boolean };

    expect(result.cached).toBe(true);
    expect(result.document.contentOrigin).toBe("metadata");
  });
});
