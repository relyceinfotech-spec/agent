import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieval = vi.hoisted(() => ({ retrieveSource: vi.fn() }));

vi.mock("../src/source-retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/source-retrieval.js")>();
  return { ...actual, retrieveSource: retrieval.retrieveSource };
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
  beforeEach(() => retrieval.retrieveSource.mockReset());

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
});
