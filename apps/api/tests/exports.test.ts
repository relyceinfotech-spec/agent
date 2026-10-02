import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchPost, AutonomousRun, TopicCandidate } from "../src/content-domain.js";
import type { ResearchSession, Source } from "../src/domain.js";
import { withAuthenticatedUser } from "../src/auth-context.js";
import {
  collectBoundedPdfStream,
  createExportProjection,
  hashExportProjection,
  renderExportMarkdown,
  renderExportPdf,
  sanitizeExportFileName,
  serializeExportProjection,
} from "../src/exports.js";
import { extractPdf } from "../src/pdf.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { createServer } from "../src/server.js";
import { createShareToken } from "../src/sharing.js";
import { SqliteSessionStore } from "../src/store.js";

const USER_A = { userId: "export-owner-a", accessToken: "export-token-a" };
const USER_B = { userId: "export-owner-b", accessToken: "export-token-b" };
const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];

function source(): Source {
  return {
    id: "private-source-id",
    title: "Official MAX API manual",
    url: "https://example.org/official",
    snippet: "Safe source snippet",
    publishedAt: "2026-09-27T00:00:00.000Z",
    sourceType: "documentation",
    domain: "example.org",
    content: "PRIVATE_FETCH_BODY_SENTINEL",
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function session(
  id = "research-a",
  status: ResearchSession["status"] = "COMPLETED",
): ResearchSession {
  return {
    id,
    question: "How does MAX preserve cited evidence?",
    mode: "quick",
    status,
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:02:00.000Z",
    sources: [source()],
    claims: [
      {
        id: "PRIVATE_CLAIM_ID_SENTINEL",
        text: "MAX keeps each finding linked to a cited source.",
        sourceIds: ["private-source-id"],
        evidence: "PRIVATE_EVIDENCE_BODY_SENTINEL",
        confidence: 0.98,
        verification: { verdict: "supported", rationale: "PRIVATE_VERIFIER_TRACE_SENTINEL" },
      },
    ],
    decisions: [
      {
        id: "PRIVATE_DECISION_ID_SENTINEL",
        controllerDecision: "allow",
        nextAction: "synthesize",
        reason: "PRIVATE_CONTROLLER_TRACE_SENTINEL",
        at: "2026-09-28T10:01:00.000Z",
      },
    ],
    state: {
      objectives: [],
      completedObjectives: [],
      missingObjectives: [],
      queries: ["PRIVATE_QUERY_TRACE_SENTINEL"],
      sources: [],
      claims: [],
      conflicts: [],
      verifiedClaims: [],
      currentHypothesis: "PRIVATE_MEMORY_CONTEXT_SENTINEL",
      coverage: 1,
    },
    answer: "MAX keeps claims linked to their sources [1].\n\nThe persisted answer is preserved.",
    steps: [],
  };
}

function post(researchId = "research-a", id = "published-post-a"): ResearchPost {
  return {
    id,
    topicId: "topic-a",
    researchId,
    title: "A published MAX research summary",
    summary: "A concise public summary.",
    whyItMatters: "It preserves evidence attribution.",
    findings: [
      {
        claimId: "PRIVATE_POST_CLAIM_ID_SENTINEL",
        text: "The finding is supported by a cited source.",
        sourceIds: ["private-source-id"],
      },
    ],
    caveats: ["This is a deterministic fixture."],
    sources: [source()],
    claims: [
      {
        id: "PRIVATE_POST_CLAIM_ID_SENTINEL",
        text: "The finding is supported by a cited source.",
        sourceIds: ["private-source-id"],
        evidence: "PRIVATE_POST_EVIDENCE_SENTINEL",
        confidence: 1,
      },
    ],
    publishedAt: "2026-09-28T10:02:00.000Z",
    researchedAt: "2026-09-28T10:00:00.000Z",
    category: "engineering",
  };
}

function topic(status: TopicCandidate["status"] = "PUBLISHED"): TopicCandidate {
  return {
    id: "topic-a",
    title: "A MAX research topic",
    url: "https://example.org/topic",
    summary: "A deterministic topic fixture.",
    provider: "test",
    discoveredAt: "2026-09-28T09:00:00.000Z",
    score: 1,
    status,
  };
}

function publishedRun(postId = "published-post-a", status: AutonomousRun["status"] = "PUBLISHED") {
  return {
    id: "published-run-a",
    trigger: "manual" as const,
    status,
    createdAt: "2026-09-28T09:30:00.000Z",
    updatedAt: "2026-09-28T10:02:00.000Z",
    topicId: "topic-a",
    researchId: "research-a",
    postId,
    events: [],
  } satisfies AutonomousRun;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function makeServer(
  options: {
    store?: SqliteSessionStore;
    exportPdfRenderer?: (projection: Parameters<typeof renderExportPdf>[0]) => Promise<Buffer>;
    searchCalls?: { count: number };
    llmCalls?: { count: number };
  } = {},
) {
  const store = options.store ?? new SqliteSessionStore(":memory:");
  const app = await createServer({
    store,
    jobStore: new InMemoryDurableJobStore(),
    authVerifier: {
      verifyAccessToken: async (token) => {
        if (token === USER_A.accessToken) return { id: USER_A.userId };
        if (token === USER_B.accessToken) return { id: USER_B.userId };
        return undefined;
      },
    },
    searchProvider: {
      search: async () => {
        if (options.searchCalls) options.searchCalls.count += 1;
        throw new Error("Export path must not search");
      },
    },
    llmProvider: {
      enabled: true,
      complete: async () => {
        if (options.llmCalls) options.llmCalls.count += 1;
        throw new Error("Export path must not call a model");
      },
    } as never,
    exportPdfRenderer: options.exportPdfRenderer,
  });
  servers.push(app);
  return { app, store };
}

async function seedResearch(store: SqliteSessionStore, identity = USER_A) {
  await withAuthenticatedUser(identity, () => store.create(session()));
}

async function seedPublishedPost(store: SqliteSessionStore, identity = USER_A) {
  await seedResearch(store, identity);
  await store.saveTopic(topic());
  await store.savePost(post());
  await store.saveRun(publishedRun());
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Exports v1 safe projection and rendering", () => {
  it("uses one allowlisted projection, retains citation relationships, and excludes private fields", () => {
    const projection = createExportProjection({
      resourceType: "research_session",
      session: session(),
    });
    expect(projection).toMatchObject({
      schema: "max.export.v1",
      resourceType: "research_session",
      answer: "MAX keeps claims linked to their sources [1].\n\nThe persisted answer is preserved.",
      claims: [
        {
          statement: "MAX keeps each finding linked to a cited source.",
          citations: [1],
          verification: "supported",
        },
      ],
      sources: [{ citation: 1, url: "https://example.org/official", sourceType: "documentation" }],
    });
    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "PRIVATE_CLAIM_ID_SENTINEL",
      "PRIVATE_EVIDENCE_BODY_SENTINEL",
      "PRIVATE_VERIFIER_TRACE_SENTINEL",
      "PRIVATE_CONTROLLER_TRACE_SENTINEL",
      "PRIVATE_QUERY_TRACE_SENTINEL",
      "PRIVATE_MEMORY_CONTEXT_SENTINEL",
      "PRIVATE_FETCH_BODY_SENTINEL",
      "ownerId",
      "accessToken",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(hashExportProjection(projection!)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createExportProjection({ resourceType: "research_session", session: session("a", "FAILED") }),
    ).toBeUndefined();

    const invalidClaim = session();
    invalidClaim.claims[0]!.sourceIds = ["unknown-source-id"];
    expect(
      createExportProjection({ resourceType: "research_session", session: invalidClaim }),
    ).toBeUndefined();

    const unsafeCitedSource = session();
    unsafeCitedSource.sources[0]!.url = "http://127.0.0.1/private";
    expect(
      createExportProjection({ resourceType: "research_session", session: unsafeCitedSource }),
    ).toBeUndefined();
  });

  it("fails closed rather than exporting credential-shaped text or secret-bearing source URLs", () => {
    const leakedAnswer = session();
    leakedAnswer.answer = "The temporary password: super-private-value [1].";
    expect(
      createExportProjection({ resourceType: "research_session", session: leakedAnswer }),
    ).toBeUndefined();

    const secretSource = session();
    secretSource.sources[0]!.url = "https://example.org/docs?access_token=private-value";
    expect(
      createExportProjection({ resourceType: "research_session", session: secretSource }),
    ).toBeUndefined();
  });

  it("renders deterministic Markdown and stable-schema JSON from the same projection", () => {
    const projection = createExportProjection({
      resourceType: "research_session",
      session: session(),
    })!;
    const markdown = renderExportMarkdown(projection);
    const json = serializeExportProjection(projection);
    expect(markdown).toContain("# How does MAX preserve cited evidence?");
    expect(markdown).toContain("MAX keeps claims linked to their sources [1].");
    expect(markdown).toContain("[1] Official MAX API manual (documentation)");
    expect(markdown).toContain("https://example.org/official");
    expect(markdown).not.toContain("PRIVATE_FETCH_BODY_SENTINEL");
    expect(markdown).not.toContain("javascript:");
    expect(JSON.parse(json)).toEqual(projection);
    expect(json).toBe(serializeExportProjection(projection));
    expect(hashExportProjection(projection)).toBe(hashExportProjection(JSON.parse(json)));

    const unsafeMarkdownProjection = {
      ...projection,
      answer: '<img src=x onerror="alert(1)"> [click](javascript:alert(1))',
    };
    const safeMarkdown = renderExportMarkdown(unsafeMarkdownProjection);
    expect(safeMarkdown).not.toContain("<img");
    expect(safeMarkdown).not.toContain("javascript:");
    expect(safeMarkdown).toContain("click");
  });

  it("renders a deterministic, readable PDF with citations and source provenance", async () => {
    const projection = createExportProjection({
      resourceType: "research_session",
      session: session(),
    })!;
    const first = await renderExportPdf(projection);
    const second = await renderExportPdf(projection);
    expect(first.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(first.equals(second)).toBe(true);
    expect(first.byteLength).toBeLessThan(2_000_000);
    const extracted = await extractPdf(first, new URL("https://example.org/export.pdf"));
    expect(extracted.content).toContain("How does MAX preserve cited evidence?");
    expect(extracted.content).toContain("MAX keeps claims linked to their sources");
    expect(extracted.content).toContain("[1]");
    expect(extracted.content).toContain("Official MAX API manual");
    expect(extracted.content.replace(/\s/g, "")).toContain("https://example.org/official");
    expect(extracted.content).not.toContain("PRIVATE_EVIDENCE_BODY_SENTINEL");
  });

  it("bounds PDF stream duration and output bytes", async () => {
    const stalled = new PassThrough();
    await expect(collectBoundedPdfStream(stalled, { timeoutMs: 10, maxBytes: 10 })).rejects.toThrow(
      "render time limit",
    );

    const oversized = new PassThrough();
    const output = collectBoundedPdfStream(oversized, { timeoutMs: 100, maxBytes: 4 });
    oversized.write(Buffer.from("12345"));
    await expect(output).rejects.toThrow("output size limit");
  });

  it("sanitizes filenames and never accepts traversal material", () => {
    expect(sanitizeExportFileName("../../report/秘密", "pdf")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/,
    );
    expect(sanitizeExportFileName("...", "markdown")).toBe("research-export.md");
  });

  it("projects a published post only with its completed owner-linked research", () => {
    const projected = createExportProjection({
      resourceType: "published_post",
      post: post(),
      session: session(),
    });
    expect(projected).toMatchObject({
      schema: "max.export.v1",
      resourceType: "published_post",
      findings: [{ statement: "The finding is supported by a cited source.", citations: [1] }],
      sources: [{ citation: 1, url: "https://example.org/official" }],
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_POST_EVIDENCE_SENTINEL");
    expect(
      createExportProjection({
        resourceType: "published_post",
        post: post(),
        session: session("other-session"),
      }),
    ).toBeUndefined();
  });
});

describe("Exports v1 API and owner isolation", () => {
  it("requires an owner, exports all formats from persisted data, deduplicates, and downloads safely", async () => {
    const searchCalls = { count: 0 };
    const llmCalls = { count: 0 };
    const pdfCalls = vi.fn(renderExportPdf);
    const { app, store } = await makeServer({
      searchCalls,
      llmCalls,
      exportPdfRenderer: pdfCalls,
    });
    await seedResearch(store);

    const input = {
      resourceType: "research_session",
      resourceId: "research-a",
      format: "markdown",
    };
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/exports",
      payload: input,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload: input,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toContain("no-store");
    const firstMetadata = created.json<{ id: string; status: string; downloadUrl: string }>();
    expect(firstMetadata.status).toBe("completed");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload: input,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(firstMetadata.id);

    for (const format of ["json", "pdf"] as const) {
      const createdFormat = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: auth(USER_A.accessToken),
        payload: { ...input, format },
      });
      expect(createdFormat.statusCode).toBe(201);
    }
    expect(pdfCalls).toHaveBeenCalledTimes(1);

    const list = await app.inject({
      method: "GET",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ exports: Array<{ id: string; status: string }> }>().exports).toHaveLength(3);
    expect(JSON.stringify(list.json())).not.toContain("payloadBase64");

    for (const item of list.json<{ exports: Array<{ id: string; format: string }> }>().exports) {
      const downloaded = await app.inject({
        method: "GET",
        url: `/api/exports/${item.id}/download`,
        headers: auth(USER_A.accessToken),
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers["content-disposition"]).toMatch(
        /^attachment; filename="[A-Za-z0-9._-]+"$/,
      );
      expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
      if (item.format === "markdown") {
        expect(downloaded.body).toContain("[1]");
        expect(downloaded.body).toContain("https://example.org/official");
        expect(downloaded.body).not.toContain("PRIVATE_CONTROLLER_TRACE_SENTINEL");
      } else if (item.format === "json") {
        expect(JSON.parse(downloaded.body)).toMatchObject({ schema: "max.export.v1" });
        expect(downloaded.body).not.toContain("PRIVATE_FETCH_BODY_SENTINEL");
      } else {
        expect(downloaded.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      }
    }
    expect(searchCalls.count).toBe(0);
    expect(llmCalls.count).toBe(0);
    expect(
      (await withAuthenticatedUser(USER_A, () => store.listExports(USER_A.userId))).length,
    ).toBe(3);
  });

  it("prevents a second user and a public share reader from accessing owner exports", async () => {
    const { app, store } = await makeServer();
    await seedResearch(store);
    const created = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "research-a", format: "json" },
    });
    const exportId = created.json<{ id: string }>().id;
    const share = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "research-a" },
    });
    const shareToken = share.json<{ token: string }>().token;
    expect((await app.inject({ method: "GET", url: `/api/share/${shareToken}` })).statusCode).toBe(
      200,
    );

    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/exports/${exportId}`,
        headers: auth(USER_B.accessToken),
      });
      expect(response.statusCode).toBe(404);
    }
    const otherDownload = await app.inject({
      method: "GET",
      url: `/api/exports/${exportId}/download`,
      headers: auth(USER_B.accessToken),
    });
    const shareReader = await app.inject({
      method: "GET",
      url: `/api/exports/${exportId}/download`,
    });
    const otherList = await app.inject({
      method: "GET",
      url: "/api/exports",
      headers: auth(USER_B.accessToken),
    });
    expect(otherDownload.statusCode).toBe(404);
    expect(shareReader.statusCode).toBe(401);
    expect(otherList.json()).toEqual({ exports: [] });

    const hiddenCreate = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_B.accessToken),
      payload: { resourceType: "research_session", resourceId: "research-a", format: "json" },
    });
    expect(hiddenCreate.statusCode).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/api/exports/${shareToken}` })).statusCode,
    ).toBe(404);
    expect(
      (await withAuthenticatedUser(USER_A, () => store.listExports(USER_A.userId))).length,
    ).toBe(1);
  });

  it("rejects ineligible resources, invalid types/formats, and traversal-shaped IDs", async () => {
    const { app, store } = await makeServer();
    for (const status of ["SEARCHING", "FAILED", "CANCELLED"] as const) {
      await withAuthenticatedUser(USER_A, () => store.create(session(`session-${status}`, status)));
    }
    const requests = [
      { resourceType: "research_session", resourceId: "not-found", format: "json", expected: 404 },
      {
        resourceType: "research_session",
        resourceId: "session-SEARCHING",
        format: "json",
        expected: 409,
      },
      {
        resourceType: "research_session",
        resourceId: "session-FAILED",
        format: "json",
        expected: 409,
      },
      {
        resourceType: "research_session",
        resourceId: "session-CANCELLED",
        format: "json",
        expected: 409,
      },
      { resourceType: "made_up", resourceId: "research-a", format: "json", expected: 400 },
      { resourceType: "research_session", resourceId: "research-a", format: "zip", expected: 400 },
      {
        resourceType: "research_session",
        resourceId: "../../private",
        format: "json",
        expected: 400,
      },
    ];
    for (const { expected, ...payload } of requests) {
      const response = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: auth(USER_A.accessToken),
        payload,
      });
      expect(response.statusCode).toBe(expected);
    }

    await seedPublishedPost(store);
    const unpublishedTopic = {
      ...topic("RESEARCHED"),
      id: "topic-draft",
      url: "https://example.org/draft",
    };
    await store.saveTopic(unpublishedTopic);
    await store.savePost({ ...post("research-a", "draft-post"), topicId: "topic-draft" });
    const draft = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "published_post", resourceId: "draft-post", format: "json" },
    });
    const postExport = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "published_post", resourceId: "published-post-a", format: "json" },
    });
    expect(draft.statusCode).toBe(404);
    expect(postExport.statusCode).toBe(201);
    expect(
      JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: postExport.json<{ downloadUrl: string }>().downloadUrl,
            headers: auth(USER_A.accessToken),
          })
        ).body,
      ),
    ).toMatchObject({ resourceType: "published_post" });
  });

  it("persists renderer failure, allows a bounded retry, and keeps completed snapshots immutable", async () => {
    let fail = true;
    const { app, store } = await makeServer({
      exportPdfRenderer: async (projection) => {
        if (fail) throw new Error("renderer transport details must not be stored");
        return renderExportPdf(projection);
      },
    });
    await seedResearch(store);
    const payload = { resourceType: "research_session", resourceId: "research-a", format: "pdf" };
    const failed = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("renderer transport details");
    const exportId = failed.json<{ exportId: string }>().exportId;
    const failedRecord = await withAuthenticatedUser(USER_A, () =>
      store.getExport(exportId, USER_A.userId),
    );
    expect(failedRecord).toMatchObject({
      status: "failed",
      failureReason: "renderer_failed",
      attempts: 1,
    });

    fail = false;
    const retried = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload,
    });
    expect(retried.statusCode).toBe(200);
    const completed = await withAuthenticatedUser(USER_A, () =>
      store.getExport(exportId, USER_A.userId),
    );
    expect(completed).toMatchObject({ status: "completed", attempts: 2 });

    const changedResource = session();
    changedResource.answer = "The persisted answer changed [1].";
    await withAuthenticatedUser(USER_A, () => store.update(changedResource));
    const oldDownload = await app.inject({
      method: "GET",
      url: `/api/exports/${exportId}/download`,
      headers: auth(USER_A.accessToken),
    });
    expect(oldDownload.statusCode).toBe(200);
    const oldPdf = await extractPdf(
      oldDownload.rawPayload,
      new URL("https://example.org/old-export.pdf"),
    );
    expect(oldPdf.content).toContain("MAX keeps claims linked");
    const newSnapshot = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload,
    });
    expect(newSnapshot.statusCode).toBe(201);
    expect(newSnapshot.json().id).not.toBe(exportId);
  });

  it("caps failed export rendering at three total attempts", async () => {
    const renderer = vi.fn(async () => {
      throw new Error("bounded renderer failure");
    });
    const { app, store } = await makeServer({ exportPdfRenderer: renderer });
    await seedResearch(store);
    const payload = { resourceType: "research_session", resourceId: "research-a", format: "pdf" };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: auth(USER_A.accessToken),
        payload,
      });
      expect(failed.statusCode).toBe(503);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/exports",
      headers: auth(USER_A.accessToken),
      payload,
    });
    expect(limited.statusCode).toBe(409);
    expect(limited.body).toContain("retry limit");
    expect(renderer).toHaveBeenCalledTimes(3);
    const records = await withAuthenticatedUser(USER_A, () => store.listExports(USER_A.userId));
    expect(records[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("persists and reads the exact owner snapshot after a SQLite store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "max-exports-v1-"));
    const databasePath = join(directory, "exports.sqlite");
    try {
      let store = new SqliteSessionStore(databasePath);
      await seedResearch(store);
      const projection = createExportProjection({
        resourceType: "research_session",
        session: session(),
      })!;
      await withAuthenticatedUser(USER_A, async () => {
        const created = await store.createExport({
          id: "00000000-0000-4000-8000-000000000001",
          ownerId: USER_A.userId,
          resourceType: "research_session",
          resourceId: "research-a",
          format: "json",
          snapshotHash: hashExportProjection(projection),
          fileName: "research-a.json",
          contentType: "application/json; charset=utf-8",
          attempts: 1,
          createdAt: "2026-09-28T10:03:00.000Z",
          updatedAt: "2026-09-28T10:03:00.000Z",
        });
        expect(created.created).toBe(true);
        expect(
          await store.completeExport(created.record.id, USER_A.userId, {
            payloadBase64: Buffer.from(serializeExportProjection(projection)).toString("base64"),
            outputBytes: Buffer.byteLength(serializeExportProjection(projection)),
            completedAt: "2026-09-28T10:03:01.000Z",
            updatedAt: "2026-09-28T10:03:01.000Z",
          }),
        ).toBe(true);
      });
      store.close();
      store = new SqliteSessionStore(databasePath);
      const persisted = await withAuthenticatedUser(USER_A, () =>
        store.getExport("00000000-0000-4000-8000-000000000001", USER_A.userId),
      );
      expect(persisted?.status).toBe("completed");
      expect(Buffer.from(persisted!.payloadBase64!, "base64").toString("utf8")).toBe(
        serializeExportProjection(projection),
      );
      expect(
        await withAuthenticatedUser(USER_B, () =>
          store.getExport("00000000-0000-4000-8000-000000000001", USER_B.userId),
        ),
      ).toBeUndefined();
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
