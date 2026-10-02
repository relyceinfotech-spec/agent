import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { Claim, ResearchSession, Source } from "../src/domain.js";
import type {
  AutonomousRun,
  ResearchFollowUp,
  ResearchPost,
  TopicCandidate,
} from "../src/content-domain.js";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { createSupabaseFetch, SupabaseStore } from "../src/supabase-store.js";

type Row = Record<string, unknown>;
class FakeQuery implements PromiseLike<{ data: Row[]; error: { message: string } | null }> {
  private readonly filters: Array<[string, unknown]> = [];
  private readonly inclusionFilters: Array<[string, unknown[]]> = [];
  private maximum = Number.POSITIVE_INFINITY;
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private before?: { createdAt: string; id: string };

  constructor(
    private readonly rows: Row[],
    private readonly updateValues?: Row,
  ) {}

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inclusionFilters.push([column, values]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  or(filter: string) {
    const match = filter.match(
      /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
    );
    if (!match || match[1] !== match[2]) throw new Error(`Unsupported fake filter: ${filter}`);
    this.before = { createdAt: match[1]!, id: match[3]! };
    return this;
  }

  select(_columns?: string) {
    return this;
  }

  limit(value: number) {
    this.maximum = value;
    return this;
  }

  async maybeSingle() {
    const rows = this.filtered();
    const row = rows[0];
    if (row && this.updateValues) Object.assign(row, this.updateValues);
    return { data: row ?? null, error: null };
  }

  then<TResult1 = { data: Row[]; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[];
          error: { message: string } | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.filtered(), error: null }).then(onfulfilled, onrejected);
  }

  private filtered() {
    let result = this.rows.filter(
      (row) =>
        this.filters.every(([column, value]) => row[column] === value) &&
        this.inclusionFilters.every(([column, values]) => values.includes(row[column])) &&
        (!this.before ||
          String(row.created_at) < this.before.createdAt ||
          (String(row.created_at) === this.before.createdAt && String(row.id) < this.before.id)),
    );
    if (this.orderBy) {
      const orderBy = this.orderBy;
      result = [...result].sort((left, right) => {
        for (const order of orderBy) {
          const leftValue = String(left[order.column]);
          const rightValue = String(right[order.column]);
          if (leftValue !== rightValue) {
            const ascending = leftValue < rightValue ? -1 : 1;
            return order.ascending ? ascending : -ascending;
          }
        }
        return 0;
      });
    }
    return result.slice(0, this.maximum);
  }
}

function fakeClient() {
  const tables = new Map<string, Row[]>();
  const rpc = vi.fn(async (_name: string, _args?: Row) => ({ data: null, error: null }));
  const client = {
    schema(_schema: string) {
      return this;
    },
    from(table: string) {
      const rows = tables.get(table) ?? [];
      tables.set(table, rows);
      const keyColumn = table === "max_knowledge_documents" ? "url" : "id";
      return {
        insert: async (value: Row) => {
          if (rows.some((row) => row[keyColumn] === value[keyColumn])) {
            return { data: null, error: { message: "duplicate key" } };
          }
          rows.push(value);
          return { data: null, error: null };
        },
        upsert: async (value: Row) => {
          const index = rows.findIndex((row) => row[keyColumn] === value[keyColumn]);
          if (index < 0) rows.push(value);
          else rows[index] = { ...rows[index], ...value };
          return { data: null, error: null };
        },
        update: (value: Row) => new FakeQuery(rows, value),
        select: () => new FakeQuery(rows),
        delete: () => {
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            then<TResult1 = { data: null; error: null }, TResult2 = never>(
              onfulfilled?:
                ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              const index = rows.findIndex((row) =>
                filters.every(([column, value]) => row[column] === value),
              );
              if (index >= 0) rows.splice(index, 1);
              return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
            },
          };
          return query;
        },
      };
    },
    rpc,
  };
  return { client, tables, rpc };
}

function sampleSession(): ResearchSession {
  return {
    id: "session-1",
    question: "Explain the current React performance guidance",
    mode: "quick",
    status: "COMPLETED",
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:01:00.000Z",
    sources: [],
    claims: [],
    steps: [],
    answer: "Use the supported evidence.",
  };
}

const source: Source = {
  id: "source-1",
  title: "React documentation",
  url: "https://react.dev/learn",
  snippet: "Official docs",
  domain: "react.dev",
  quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
};

const claim: Claim = {
  id: "claim-1",
  text: "The docs recommend measuring before optimizing.",
  sourceIds: [source.id],
  evidence: "Measure first.",
  confidence: 0.95,
};

describe("SupabaseStore", () => {
  it("counts owner-scoped retained memories including inactive rows", async () => {
    const requests: Array<{ url: URL; method: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, {
        status: 200,
        headers: { "content-range": "0-1/2" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      undefined,
      "sb_publishable_test",
    );

    try {
      await expect(
        withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
          store.countRetainedUserMemories(),
        ),
      ).resolves.toBe(2);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.pathname).toBe("/rest/v1/max_user_memories");
      expect(requests[0]?.url.searchParams.get("owner_id")).toBe("eq.owner-a");
      expect(requests[0]?.url.searchParams.has("is_active")).toBe(false);
      expect(requests[0]?.authorization).toBe("Bearer owner-a-token");
    } finally {
      await store.close();
      vi.unstubAllGlobals();
    }
  });

  it("decodes headerless Brotli JSON responses from PostgREST", async () => {
    const expected = [{ claim_id: "claim-1" }];
    const acceptEncodings: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      acceptEncodings.push(new Headers(init?.headers).get("accept-encoding") ?? "");
      return new Response(brotliCompressSync(Buffer.from(JSON.stringify(expected))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await createSupabaseFetch()(
        "https://project.supabase.co/rest/v1/max_post_claims",
      );

      await expect(response.json()).resolves.toEqual(expected);
      expect(acceptEncodings).toEqual(["gzip"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests identity encoding for Supabase Auth without changing PostgREST encoding", async () => {
    const acceptEncodings: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      acceptEncodings.push(new Headers(init?.headers).get("accept-encoding") ?? "");
      return new Response('{"users":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await createSupabaseFetch()(
        "https://project.supabase.co/auth/v1/admin/users",
      );

      await expect(response.json()).resolves.toEqual({ users: [] });
      expect(acceptEncodings).toEqual(["identity"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips full research session snapshots and supports deletion", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const session = {
      ...sampleSession(),
      state: {
        objectives: [],
        completedObjectives: [],
        missingObjectives: ["Verify release date"],
        queries: [],
        sources: [],
        claims: [],
        conflicts: [],
        verifiedClaims: [],
        coverage: 0.5,
        evidenceStatus: "GENERIC_SUPPORT" as const,
        requestedFactCoverage: {
          required: ["version", "release date", "stable status", "latestness"] as const,
          present: ["version"] as const,
          missing: ["release date", "stable status", "latestness"] as const,
        },
        objectiveCoverage: [
          {
            objectiveId: "obj-release-date",
            status: "partial" as const,
            requiredFacts: ["release date"] as const,
            presentFacts: [] as const,
            missingFacts: ["release date"] as const,
            sourceIds: ["source-193"],
            claimIds: ["claim-193"],
          },
        ],
        releaseRecords: [
          {
            entity: "React",
            version: "19.3",
            releaseDate: "2026-09-09",
            dateAssociationReason: "dated-release-announcement" as const,
            releaseDateSourceIds: ["source-193"],
            releaseDateEvidenceIds: ["claim-193"],
            releaseDateConfidence: 0.9,
            releaseDateExplicit: false,
            stability: "unknown" as const,
            stabilityReason: "feature-stability-only" as const,
            featureStabilityEvidence: "Features are stable in React 19.3.",
            sourceId: "source-193",
            sourceIds: ["source-193"],
            claimIds: ["claim-193"],
            officialSource: true,
          },
        ],
        latestnessAssessment: {
          required: true,
          conclusion: "UNRESOLVED" as const,
          requestedEntity: "React",
          highestCandidateVersion: "19.3",
          candidateVersions: [],
          releaseRecords: [],
          comparisons: [],
          supportingSourceIds: [],
          completeHistorySourceIds: [],
          unresolvedReasons: ["No complete release history was verified."],
        },
      },
    };

    await store.create(session);
    expect(await store.get(session.id)).toEqual(session);
    expect((await store.get(session.id))?.state).toMatchObject({
      requestedFactCoverage: { missing: ["release date", "stable status", "latestness"] },
      objectiveCoverage: [{ objectiveId: "obj-release-date", status: "partial" }],
      releaseRecords: [
        { releaseDateSourceIds: ["source-193"], stabilityReason: "feature-stability-only" },
      ],
      latestnessAssessment: { conclusion: "UNRESOLVED", highestCandidateVersion: "19.3" },
    });
    expect(await store.list()).toEqual([session]);

    const updated = { ...session, answer: "Updated answer" };
    await store.update(updated);
    expect(await store.get(session.id)).toEqual(updated);

    await store.delete(session.id);
    expect(await store.get(session.id)).toBeUndefined();
  });

  it("uses owner-filtered server writes after removing direct authenticated table writes", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const owned = sampleSession();
    const foreign = { ...sampleSession(), id: "session-b", answer: "user B data" };

    await withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, async () => {
      await store.create(owned);
      await store.update({ ...owned, answer: "updated by owner A" });
    });

    const sessionRows = fake.tables.get("max_research_sessions") ?? [];
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({
      id: owned.id,
      owner_id: "owner-a",
      data: { answer: "updated by owner A" },
    });

    sessionRows.push({
      id: foreign.id,
      owner_id: "owner-b",
      created_at: foreign.createdAt,
      updated_at: foreign.updatedAt,
      status: foreign.status,
      data: foreign,
    });
    await expect(
      withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
        store.update({ ...foreign, answer: "cross-owner overwrite" }),
      ),
    ).rejects.toThrow("Research session could not be updated");
    expect(sessionRows[1]?.data).toMatchObject({ answer: "user B data" });

    await withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
      store.delete(owned.id),
    );
    expect(sessionRows.map((row) => row.id)).toEqual([foreign.id]);
  });

  it("updates owned follow-ups without allowing an id collision to overwrite another owner", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const followUp: ResearchFollowUp = {
      id: "follow-up-a",
      postId: "post-a",
      question: "What is the evidence?",
      status: "QUEUED",
      createdAt: "2026-09-24T12:00:00.000Z",
      updatedAt: "2026-09-24T12:00:00.000Z",
      usedLiveResearch: false,
      sourceIds: [],
    };

    await withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
      store.saveFollowUp(followUp),
    );
    await withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
      store.saveFollowUp({ ...followUp, status: "COMPLETED" }),
    );
    const followUpRows = fake.tables.get("max_post_followups") ?? [];
    expect(followUpRows[0]).toMatchObject({
      owner_id: "owner-a",
      status: "COMPLETED",
      data: { status: "COMPLETED" },
    });

    followUpRows.push({
      id: "follow-up-b",
      owner_id: "owner-b",
      post_id: "post-b",
      status: "QUEUED",
      updated_at: followUp.updatedAt,
      data: { ...followUp, id: "follow-up-b", postId: "post-b" },
    });
    await expect(
      withAuthenticatedUser({ userId: "owner-a", accessToken: "owner-a-token" }, () =>
        store.saveFollowUp({ ...followUp, id: "follow-up-b", status: "FAILED" }),
      ),
    ).rejects.toThrow("duplicate key");
    expect(followUpRows[1]?.data).toMatchObject({ postId: "post-b", status: "QUEUED" });
  });

  it("keyset-pages session reads and bounds existing-id checks", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const sessions = [
      { ...sampleSession(), id: "session-c", createdAt: "2026-09-26T00:00:00.000Z" },
      { ...sampleSession(), id: "session-b", createdAt: "2026-09-25T00:00:00.000Z" },
      { ...sampleSession(), id: "session-a", createdAt: "2026-09-24T00:00:00.000Z" },
    ];

    for (const item of sessions) {
      await store.create(item);
    }
    const rows = await store.list(3);
    const existing = await store.listExistingIds(["session-a", "missing"]);
    const pageOne = { rows, existing };
    expect(pageOne.rows.map((item) => item.id)).toEqual(["session-c", "session-b", "session-a"]);
    expect(pageOne.existing).toEqual(new Set(["session-a"]));

    const firstPage = await store.list(2);
    const last = firstPage[1]!;
    const nextPage = await store.list(2, { createdAt: last.createdAt, id: last.id });
    expect(firstPage.map((item) => item.id)).toEqual(["session-c", "session-b"]);
    expect(nextPage.map((item) => item.id)).toEqual(["session-a"]);
  });

  it("deletes user memory through the authenticated owner-scoped Supabase client", async () => {
    const requests: Array<{ url: URL; method: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ id: "memory-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      undefined,
      "sb_publishable_test",
    );

    try {
      await expect(
        withAuthenticatedUser({ userId: "owner-1", accessToken: "owner-access-token" }, () =>
          store.deleteUserMemory("memory-1"),
        ),
      ).resolves.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "DELETE",
        authorization: "Bearer owner-access-token",
      });
      expect(requests[0]?.url.pathname).toBe("/rest/v1/max_user_memories");
      expect(requests[0]?.url.searchParams.get("owner_id")).toBe("eq.owner-1");
      expect(requests[0]?.url.searchParams.get("id")).toBe("eq.memory-1");
    } finally {
      await store.close();
      vi.unstubAllGlobals();
    }
  });

  it("reads headerless gzip responses from session and document tables", async () => {
    const session = sampleSession();
    const documentRow = {
      url: "https://react.dev/learn",
      title: "React documentation",
      content: "Measure performance before optimizing.",
      raw_html: "<main>Measure performance before optimizing.</main>",
      fetched_at: session.createdAt,
      last_verified_at: session.updatedAt,
      published_at: null,
      metadata: { retrievalMethod: "http" },
      content_hash: "hash",
      version: 1,
    };
    const acceptEncodings: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      acceptEncodings.push(new Headers(init?.headers).get("accept-encoding") ?? "");
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const rows = requestUrl.pathname.endsWith("max_research_sessions")
        ? [{ data: session }]
        : [documentRow];
      const responseBody = gzipSync(Buffer.from(JSON.stringify(rows)));
      return new Response(responseBody, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const store = new SupabaseStore("https://project.supabase.co", "sb_secret_test");

      await expect(store.get(session.id)).resolves.toEqual(session);
      await expect(store.getDocument(documentRow.url)).resolves.toMatchObject({
        url: documentRow.url,
        content: documentRow.content,
        version: documentRow.version,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(acceptEncodings).toEqual(["gzip", "gzip"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses atomic database functions for versioned documents and full-text search", async () => {
    const fake = fakeClient();
    const document = {
      url: "https://react.dev/learn",
      title: "React documentation",
      content: "Measure performance before optimizing.",
      rawHtml: "<main>Measure performance before optimizing.</main>",
      fetchedAt: "2026-09-24T12:00:00.000Z",
      metadata: { retrievalMethod: "http" },
    };
    const storedDocument = {
      ...document,
      publishedAt: undefined,
      lastVerifiedAt: "2026-09-24T12:02:00.000Z",
      contentHash: "hash",
      version: 1,
    };
    fake.tables.set("max_knowledge_documents", [
      {
        url: document.url,
        title: document.title,
        content: document.content,
        raw_html: document.rawHtml,
        fetched_at: document.fetchedAt,
        last_verified_at: storedDocument.lastVerifiedAt,
        metadata: document.metadata,
        content_hash: storedDocument.contentHash,
        version: storedDocument.version,
      },
    ]);
    fake.rpc.mockImplementation(async (name, args) => {
      if (name === "max_search_knowledge_documents") {
        expect(args?.p_query).toBe("react OR performance OR optimizing");
        return { data: [fake.tables.get("max_knowledge_documents")![0]], error: null };
      }
      return { data: null, error: null };
    });
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );

    await store.saveDocument(document);
    expect(fake.rpc).toHaveBeenCalledWith(
      "max_save_knowledge_document",
      expect.objectContaining({ p_document: expect.objectContaining({ url: document.url }) }),
    );
    expect(await store.getDocument(document.url)).toEqual(storedDocument);
    expect(await store.searchDocuments("React performance optimizing", 60_000)).toEqual([
      storedDocument,
    ]);
  });

  it("round-trips content records and delegates publication atomically", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const topic: TopicCandidate = {
      id: "topic-1",
      title: "React performance",
      url: "https://react.dev/learn",
      summary: "An official React guide.",
      provider: "feed",
      discoveredAt: "2026-09-24T12:00:00.000Z",
      score: 0.9,
      status: "SELECTED",
    };
    const run: AutonomousRun = {
      id: "run-1",
      trigger: "manual",
      status: "QUEUED",
      createdAt: topic.discoveredAt,
      updatedAt: topic.discoveredAt,
      events: [],
    };
    const post: ResearchPost = {
      id: "post-1",
      topicId: topic.id,
      researchId: "session-1",
      title: topic.title,
      summary: topic.summary,
      whyItMatters: "It helps avoid premature optimization.",
      findings: [{ claimId: claim.id, text: claim.text, sourceIds: [source.id] }],
      caveats: [],
      sources: [source],
      claims: [claim],
      publishedAt: topic.discoveredAt,
      researchedAt: topic.discoveredAt,
      category: "engineering",
    };
    const followUp: ResearchFollowUp = {
      id: "follow-up-1",
      postId: post.id,
      question: "What evidence supports this?",
      status: "QUEUED",
      createdAt: topic.discoveredAt,
      updatedAt: topic.discoveredAt,
      usedLiveResearch: false,
      sourceIds: [],
    };
    fake.rpc.mockImplementation(async (name, args) => {
      if (name === "max_save_post") {
        fake.tables.set("max_posts", [{ id: "post-1", data: args?.p_post }]);
      }
      if (name === "max_publish_post") return { data: null, error: null };
      return { data: null, error: null };
    });

    await store.saveTopic(topic);
    await store.saveRun(run);
    await store.savePost(post);
    await store.saveFollowUp(followUp);
    expect(await store.getTopic(topic.id)).toEqual(topic);
    expect(await store.getTopicByUrl(topic.url)).toEqual(topic);
    expect(await store.getRun(run.id)).toEqual(run);
    expect(await store.getPost(post.id)).toEqual(post);
    expect(await store.listPosts()).toEqual([post]);
    expect(await store.getFollowUp(followUp.id)).toEqual(followUp);
    await store.recoverInterrupted();
    await store.recoverAutonomousRuns();

    const publishedTopic = { ...topic, status: "PUBLISHED" as const };
    const publishedRun = {
      ...run,
      status: "PUBLISHED" as const,
      topicId: topic.id,
      postId: post.id,
    };
    await store.publishPost(post, publishedTopic, publishedRun);
    expect(fake.rpc).toHaveBeenCalledWith("max_publish_post", {
      p_post: post,
      p_topic: publishedTopic,
      p_run: publishedRun,
    });
    expect(await store.listTopics(999)).toEqual([topic]);
    expect(await store.listRuns(999)).toEqual([run]);
    expect(fake.rpc).toHaveBeenCalledWith("max_recover_interrupted_sessions");
    expect(fake.rpc).toHaveBeenCalledWith("max_recover_interrupted_content");
  });

  it("rejects mismatched publication state and surfaces database errors", async () => {
    const fake = fakeClient();
    const store = new SupabaseStore(
      "https://project.supabase.co",
      "sb_secret_test",
      fake.client as never,
    );
    const post = { ...({} as ResearchPost), id: "post-1", topicId: "topic-1" };
    const topic = { ...({} as TopicCandidate), id: "topic-1" };
    const run = {
      ...({} as AutonomousRun),
      topicId: "other-topic",
      postId: post.id,
      status: "PUBLISHED",
    };

    await expect(store.publishPost(post, topic, run as AutonomousRun)).rejects.toThrow(
      "Published post, topic, and run state do not match",
    );
    expect(fake.rpc).not.toHaveBeenCalled();

    fake.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(store.recoverInterrupted()).rejects.toThrow(
      "Supabase persistence operation failed: database unavailable",
    );
  });
});
