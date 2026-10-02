import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResearchSession, Source } from "../src/domain.js";
import type {
  AutonomousRun,
  ResearchFollowUp,
  ResearchPost,
  TopicCandidate,
} from "../src/content-domain.js";
import { SqliteSessionStore } from "../src/store.js";
import { InternalKnowledgeProvider } from "../src/search.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "max-store-test-"));
  directories.push(directory);
  return join(directory, "max.sqlite");
}

function session(id: string, status: ResearchSession["status"] = "COMPLETED"): ResearchSession {
  return {
    id,
    question: "What is React?",
    mode: "quick",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sources: [],
    claims: [],
    steps: [],
  };
}

describe("durable research sessions", () => {
  it("retains session content and updates after reopening", async () => {
    const path = databasePath();
    const first = new SqliteSessionStore(path);
    await first.create(session("one"));
    const updated = (await first.get("one"))!;
    updated.answer = "React is a UI library.";
    await first.update(updated);
    first.close();

    const reopened = new SqliteSessionStore(path);
    expect((await reopened.get("one"))?.answer).toBe("React is a UI library.");
    expect((await reopened.list()).map((item) => item.id)).toEqual(["one"]);
    reopened.close();
  });

  it("marks interrupted in-flight research as failed without losing its evidence", async () => {
    const path = databasePath();
    const first = new SqliteSessionStore(path);
    const pending = session("pending", "FETCHING");
    pending.claims = [
      { id: "c1", text: "Evidence", sourceIds: [], evidence: "Text", confidence: 0.5 },
    ];
    await first.create(pending);
    await first.create(session("done"));
    first.close();

    const reopened = new SqliteSessionStore(path);
    expect(reopened.recoverInterrupted()).toBe(1);
    expect(await reopened.get("pending")).toMatchObject({
      status: "FAILED",
      claims: [{ id: "c1" }],
    });
    expect((await reopened.get("done"))?.status).toBe("COMPLETED");
    reopened.close();
  });

  it("stores versioned documents and retrieves only fresh matching knowledge", async () => {
    const path = databasePath();
    const first = new SqliteSessionStore(path);
    await first.saveDocument({
      url: "https://react.dev/versions?utm_source=test",
      title: "React versions",
      content: "React release history and official documentation describe the supported versions.",
      rawHtml:
        "<html><body>React release history and official documentation describe the supported versions.</body></html>",
      fetchedAt: new Date().toISOString(),
      metadata: {
        domain: "react.dev",
        contentType: "html",
        retrievalMethod: "http",
        provider: "official-source",
        query: "React versions",
        headings: ["Version history"],
      },
    });
    const initial = await first.getDocument("https://react.dev/versions");
    expect(initial?.version).toBe(1);
    expect(initial?.contentHash).toHaveLength(64);
    first.close();

    const reopened = new SqliteSessionStore(path);
    const discovered = await new InternalKnowledgeProvider(reopened).search("React versions");
    expect(discovered).toMatchObject([
      {
        provider: "internal-knowledge",
        url: "https://react.dev/versions",
      },
    ]);
    expect((await reopened.getDocument("https://react.dev/versions"))?.metadata).toMatchObject({
      contentType: "html",
      retrievalMethod: "http",
      provider: "official-source",
      headings: ["Version history"],
    });
    expect(await reopened.searchDocuments("unrelated foobar", 24 * 60 * 60 * 1000)).toEqual([]);
    await reopened.saveDocument({
      url: "https://react.dev/versions",
      title: "React versions",
      content: "React changed its release documentation substantially.",
      rawHtml: "<html><body>React changed its release documentation substantially.</body></html>",
      fetchedAt: new Date().toISOString(),
    });
    expect((await reopened.getDocument("https://react.dev/versions"))?.version).toBe(2);
    reopened.close();
  });

  it("migrates older document tables and reuses cached PDF text without a raw HTML body", async () => {
    const path = databasePath();
    const initial = new SqliteSessionStore(path);
    await initial.saveDocument({
      url: "https://example.org/report.pdf",
      title: "Performance report",
      content:
        "This cached PDF contains a detailed performance report, its measured results, methodology, limitations, and supporting evidence for later research reuse.",
      rawHtml: "",
      fetchedAt: new Date().toISOString(),
      metadata: {
        domain: "example.org",
        contentType: "pdf",
        retrievalMethod: "pdf",
        headings: ["Results", "Limitations"],
      },
    });
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      initial,
    );
    const fetched = (await registry.execute("fetch_url", {
      url: "https://example.org/report.pdf",
    })) as {
      cached: boolean;
      document: { content: string; contentType: string };
      retrievalMethod: string;
    };
    expect(fetched).toMatchObject({ cached: true, retrievalMethod: "cache" });
    expect(fetched.document.contentType).toBe("pdf");
    expect(fetched.document.content).toContain("cached PDF");
    const extracted = (await registry.execute("extract_content", {
      url: "https://example.org/report.pdf",
      html: "",
      document: fetched.document,
      cached: fetched.cached,
      retrievalMethod: fetched.retrievalMethod,
    })) as { content: string };
    expect(extracted.content).toContain("cached PDF");
    initial.close();

    const legacyDatabase = new DatabaseSync(path);
    legacyDatabase.exec("ALTER TABLE documents DROP COLUMN metadata_json");
    legacyDatabase.close();

    const reopened = new SqliteSessionStore(path);
    expect((await reopened.getDocument("https://example.org/report.pdf"))?.metadata).toEqual({});
    reopened.close();
  });

  it("retains posts and safely terminates interrupted publishing and follow-up work on restart", async () => {
    const path = databasePath();
    const now = new Date().toISOString();
    const topic: TopicCandidate = {
      id: "topic-1",
      title: "Documented release investigation",
      url: "https://example.org/release",
      summary: "Documented release evidence",
      provider: "fixture",
      discoveredAt: now,
      score: 0.9,
      status: "PUBLISHED",
    };
    const post: ResearchPost = {
      id: "post-1",
      topicId: topic.id,
      researchId: "research-1",
      title: topic.title,
      summary: topic.summary,
      whyItMatters: "Readers can inspect the original evidence.",
      findings: [],
      caveats: [],
      sources: [],
      claims: [],
      publishedAt: now,
      researchedAt: now,
      category: "releases",
    };
    const run: AutonomousRun = {
      id: "run-1",
      trigger: "manual",
      status: "RESEARCHING",
      topicId: topic.id,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const queuedRun: AutonomousRun = {
      ...run,
      id: "run-queued",
      status: "QUEUED",
      events: [{ at: now, stage: "queue", status: "started", detail: "Run queued" }],
    };
    const followUp: ResearchFollowUp = {
      id: "follow-up-1",
      postId: post.id,
      question: "What changed?",
      status: "SYNTHESIZING",
      createdAt: now,
      updatedAt: now,
      usedLiveResearch: true,
      sourceIds: [],
    };
    const first = new SqliteSessionStore(path);
    await first.saveTopic(topic);
    await first.savePost(post);
    await first.saveRun(run);
    await first.saveRun(queuedRun);
    await first.saveFollowUp(followUp);
    first.close();

    const reopened = new SqliteSessionStore(path);
    expect(reopened.recoverAutonomousRuns()).toBe(1);
    expect(await reopened.getPost(post.id)).toMatchObject({ title: post.title, topicId: topic.id });
    expect(await reopened.getRun(run.id)).toMatchObject({
      status: "FAILED",
      events: [{ stage: "recovery", status: "failed" }],
    });
    expect(await reopened.getRun(queuedRun.id)).toMatchObject({
      status: "QUEUED",
      events: [{ stage: "queue", status: "started" }],
    });
    expect(await reopened.getFollowUp(followUp.id)).toMatchObject({
      status: "FAILED",
      usedLiveResearch: true,
    });
    reopened.close();
  });

  it("rolls back the post, topic, and run together when atomic publication fails", async () => {
    const store = new SqliteSessionStore(databasePath());
    const now = new Date().toISOString();
    const topic: TopicCandidate = {
      id: "topic-atomic",
      title: "Atomic publishing fixture",
      url: "https://example.org/atomic-release",
      summary: "Evidence for the atomic publication test",
      provider: "fixture",
      discoveredAt: now,
      score: 0.9,
      status: "RESEARCHED",
    };
    const run: AutonomousRun = {
      id: "run-atomic",
      trigger: "manual",
      status: "QUALITY_GATE",
      topicId: topic.id,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const source: Source = {
      id: "duplicate-source",
      url: "https://example.org/source-a",
      title: "Fixture source",
      snippet: "Verified evidence",
      domain: "example.org",
      content: "Verified source content",
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const post: ResearchPost = {
      id: "post-atomic",
      topicId: topic.id,
      researchId: "research-atomic",
      title: topic.title,
      summary: topic.summary,
      whyItMatters: "The transaction must keep publication state consistent.",
      findings: [],
      caveats: [],
      sources: [source, { ...source, url: "https://example.org/source-b" }],
      claims: [],
      publishedAt: now,
      researchedAt: now,
      category: "testing",
    };
    const publishedTopic = { ...topic, status: "PUBLISHED" as const };
    const publishedRun: AutonomousRun = {
      ...run,
      status: "PUBLISHED",
      postId: post.id,
      updatedAt: now,
      events: [{ at: now, stage: "published", status: "complete", detail: "Published fixture" }],
    };

    await store.saveTopic(topic);
    await store.saveRun(run);
    await expect(store.publishPost(post, publishedTopic, publishedRun)).rejects.toThrow();

    expect(await store.getPost(post.id)).toBeUndefined();
    expect((await store.getTopic(topic.id))?.status).toBe("RESEARCHED");
    expect((await store.getRun(run.id))?.status).toBe("QUALITY_GATE");
    store.close();
  });

  it("persists extraction metadata and search provenance with a fetched document", async () => {
    const store = new SqliteSessionStore(databasePath());
    const registry = createToolRegistry(
      { search: async () => [] },
      new OpenRouterProvider(),
      store,
    );
    const paragraph =
      "This article describes a measured rendering benchmark, its repeatable methodology, the observed performance results, and limitations that researchers should consider before applying the findings.";
    await registry.execute("extract_content", {
      html: `<html lang="en"><head><title>Rendering benchmark</title><meta name="description" content="A test description"><meta name="author" content="Research Team"><link rel="canonical" href="https://example.org/canonical"></head><body><main><h1>Measured Results</h1><p>${paragraph}</p></main></body></html>`,
      url: "https://example.org/benchmark",
      contentType: "text/html",
      retrievalMethod: "browser",
      sourceMetadata: {
        provider: "official-source",
        providers: ["official-source", "serper"],
        engine: "official",
        query: "rendering benchmark",
        discoveredAt: "2026-09-24T00:00:00.000Z",
      },
    });

    const document = await store.getDocument("https://example.org/benchmark");
    expect(document?.metadata).toMatchObject({
      description: "A test description",
      author: "Research Team",
      canonicalUrl: "https://example.org/canonical",
      domain: "example.org",
      language: "en",
      headings: ["Measured Results"],
      contentType: "html",
      retrievalMethod: "browser",
      provider: "official-source",
      providers: ["official-source", "serper"],
      query: "rendering benchmark",
    });
    expect(document?.contentHash).toHaveLength(64);
    store.close();
  });
});
