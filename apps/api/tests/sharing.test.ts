import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousRun, ResearchPost, TopicCandidate } from "../src/content-domain.js";
import type { ResearchSession, Source } from "../src/domain.js";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { createServer } from "../src/server.js";
import {
  createShareToken,
  hashShareToken,
  projectPostForSharing,
  projectResearchForSharing,
} from "../src/sharing.js";
import { SqliteSessionStore } from "../src/store.js";

const USER_A = { userId: "sharing-owner-a", accessToken: "sharing-token-a" };
const USER_B = { userId: "sharing-owner-b", accessToken: "sharing-token-b" };
const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];

function source(): Source {
  return {
    id: "internal-source-id-1",
    title: "Official MAX documentation",
    url: "https://example.org/docs",
    snippet: "A short public snippet.",
    domain: "example.org",
    content: "PRIVATE_FETCH_BODY_SENTINEL",
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function completedSession(
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
        id: "private-claim-id",
        text: "MAX keeps evidence linked to sources.",
        sourceIds: ["internal-source-id-1"],
        evidence: "PRIVATE_CLAIM_EVIDENCE_SENTINEL",
        confidence: 0.99,
      },
    ],
    decisions: [
      {
        id: "internal-decision-id",
        controllerDecision: "allow",
        nextAction: "synthesize",
        reason: "PRIVATE_TRACE_SENTINEL",
        at: "2026-09-28T10:01:00.000Z",
      },
    ],
    state: {
      objectives: [],
      completedObjectives: [],
      missingObjectives: [],
      queries: [],
      sources: [],
      claims: [],
      conflicts: [],
      verifiedClaims: [],
      coverage: 1,
    },
    answer: "MAX preserves citations in the final answer [1].",
    steps: [],
  };
}

function publishedPost(researchId = "research-a"): ResearchPost {
  return {
    id: "published-post-a",
    topicId: "topic-a",
    researchId,
    title: "A published MAX research summary",
    summary: "A concise public summary.",
    whyItMatters: "It preserves evidence attribution.",
    findings: [
      {
        claimId: "private-claim-id",
        text: "The finding is supported by a cited source.",
        sourceIds: ["internal-source-id-1"],
      },
    ],
    caveats: ["This is a deterministic fixture."],
    sources: [source()],
    claims: [
      {
        id: "private-claim-id",
        text: "The finding is supported by a cited source.",
        sourceIds: ["internal-source-id-1"],
        evidence: "PRIVATE_POST_CLAIM_SENTINEL",
        confidence: 1,
      },
    ],
    publishedAt: "2026-09-28T10:02:00.000Z",
    researchedAt: "2026-09-28T10:00:00.000Z",
    category: "engineering",
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function makeServer(
  options: {
    store?: SqliteSessionStore;
    shareResolveRateLimiter?: RateLimiter;
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
    shareResolveRateLimiter: options.shareResolveRateLimiter,
    searchProvider: { search: async () => [] },
    llmProvider: { enabled: true } as never,
  });
  servers.push(app);
  return { app, store };
}

async function seedSession(store: SqliteSessionStore, identity = USER_A) {
  await withAuthenticatedUser(identity, () => store.create(completedSession()));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Sharing v1", () => {
  it("uses high-entropy URL-safe tokens and stores only a one-way token hash", async () => {
    const first = createShareToken();
    const second = createShareToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(hashShareToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashShareToken(first)).not.toBe(first);
    expect(() => hashShareToken("short-token")).toThrow("Invalid share token format");
    const unsafeCitation = completedSession();
    unsafeCitation.sources[0]!.url = "http://127.0.0.1/private";
    expect(projectResearchForSharing(unsafeCitation)).toBeUndefined();

    for (const unsafeUrl of [
      "http://[::1]/private",
      "http://[::ffff:7f00:1]/private",
      "https://example.org/docs?access_token=private-value",
    ]) {
      const unsafeSource = completedSession();
      unsafeSource.sources[0]!.url = unsafeUrl;
      expect(projectResearchForSharing(unsafeSource)).toBeUndefined();
    }

    const unsafePost = publishedPost();
    unsafePost.sources[0]!.url = "https://example.org/docs?api_key=private-value";
    expect(projectPostForSharing(unsafePost)).toBeUndefined();
  });

  it("rejects cloud-signed capability URLs but preserves ordinary source URLs", () => {
    const signedUrls = [
      "https://bucket.example.org/file?X-Amz-Credential=client&X-Amz-Signature=signature",
      "https://bucket.example.org/file?%58-Amz-Signature=signature",
      "https://storage.googleapis.com/bucket/file?X-Goog-Credential=client&X-Goog-Signature=signature",
      "https://blob.example.org/file?sv=2026-01-01&sig=signature",
      "https://bucket.example.org/file?AWSAccessKeyId=client&Signature=signature",
      "https://bucket.cos.ap-guangzhou.myqcloud.com/file?q-sign-algorithm=sha1&q-ak=client&q-sign-time=now&q-signature=signature&x-cos-security-token=token",
    ];

    for (const url of signedUrls) {
      const session = completedSession();
      session.sources[0]!.url = url;
      expect(projectResearchForSharing(session)).toBeUndefined();

      const post = publishedPost();
      post.sources[0]!.url = url;
      expect(projectPostForSharing(post)).toBeUndefined();
    }

    const ordinarySession = completedSession();
    ordinarySession.sources[0]!.url = "https://example.org/docs?lang=en#overview";
    expect(projectResearchForSharing(ordinarySession)?.sources[0]?.url).toBe(
      ordinarySession.sources[0]!.url,
    );

    const ordinaryMetadataSession = completedSession();
    ordinaryMetadataSession.sources[0]!.url = "https://example.org/docs?x-amz-meta-label=public";
    expect(projectResearchForSharing(ordinaryMetadataSession)?.sources[0]?.url).toBe(
      ordinaryMetadataSession.sources[0]!.url,
    );

    const ordinaryPost = publishedPost();
    ordinaryPost.sources[0]!.url = "https://example.org/docs?lang=en#overview";
    expect(projectPostForSharing(ordinaryPost)?.sources[0]?.url).toBe(ordinaryPost.sources[0]!.url);
  });

  it("requires authentication, enforces owner isolation, and returns an allowlisted cited result", async () => {
    const { app, store } = await makeServer();
    await seedSession(store);

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { resourceType: "research_session", resourceId: "research-a" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "research-a" },
    });
    const share = created.json<{ id: string; token: string; url: string }>();
    const listedByOwner = await app.inject({
      method: "GET",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
    });
    const listedByOther = await app.inject({
      method: "GET",
      url: "/api/shares",
      headers: auth(USER_B.accessToken),
    });
    const otherRevoke = await app.inject({
      method: "DELETE",
      url: `/api/shares/${share.id}`,
      headers: auth(USER_B.accessToken),
    });
    const publicRead = await app.inject({ method: "GET", url: `/api/share/${share.token}` });
    const publicWrite = await app.inject({
      method: "POST",
      url: `/api/share/${share.token}`,
      payload: { answer: "overwrite" },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(created.statusCode).toBe(201);
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.url).toContain(`/api/share/${share.token}`);
    expect(listedByOwner.statusCode).toBe(200);
    expect(listedByOwner.json()).toHaveLength(1);
    expect(JSON.stringify(listedByOwner.json())).not.toContain("tokenHash");
    expect(JSON.stringify(listedByOwner.json())).not.toContain(share.token);
    expect(listedByOther.json()).toEqual([]);
    expect(otherRevoke.statusCode).toBe(404);
    expect(publicRead.statusCode).toBe(200);
    expect(publicWrite.statusCode).toBe(404);
    expect(publicRead.headers["cache-control"]).toContain("no-store");
    const shared = publicRead.json<Record<string, unknown>>();
    expect(shared).toMatchObject({
      type: "research",
      question: "How does MAX preserve cited evidence?",
      answer: "MAX preserves citations in the final answer [1].",
      sources: [
        { citation: 1, title: "Official MAX documentation", url: "https://example.org/docs" },
      ],
    });
    const publicBody = JSON.stringify(shared);
    for (const forbidden of [
      "private-claim-id",
      "PRIVATE_FETCH_BODY_SENTINEL",
      "PRIVATE_CLAIM_EVIDENCE_SENTINEL",
      "PRIVATE_TRACE_SENTINEL",
      "ownerId",
      "research-a",
      "tokenHash",
    ]) {
      expect(publicBody).not.toContain(forbidden);
    }
  });

  it("allows only an owner-linked published post and projects finding citations without internal IDs", async () => {
    const { app, store } = await makeServer();
    await seedSession(store);
    const topic: TopicCandidate = {
      id: "topic-a",
      title: "A MAX research topic",
      url: "https://example.org/topic",
      summary: "A deterministic topic fixture.",
      provider: "test",
      discoveredAt: "2026-09-28T09:00:00.000Z",
      score: 1,
      status: "PUBLISHED",
    };
    await store.saveTopic(topic);
    await store.savePost(publishedPost());
    const draftTopic = {
      ...topic,
      id: "topic-draft",
      url: "https://example.org/topic-draft",
      status: "RESEARCHED" as const,
    };
    await store.saveTopic(draftTopic);
    await store.savePost({
      ...publishedPost(),
      id: "unpublished-post",
      topicId: draftTopic.id,
      publishedAt: "2026-09-28T10:03:00.000Z",
    });
    const run: AutonomousRun = {
      id: "published-run-a",
      trigger: "manual",
      status: "PUBLISHED",
      createdAt: "2026-09-28T09:30:00.000Z",
      updatedAt: "2026-09-28T10:02:00.000Z",
      topicId: topic.id,
      researchId: "research-a",
      postId: "published-post-a",
      events: [],
    };
    await store.saveRun(run);

    const publicFeed = await app.inject({ method: "GET", url: "/api/discover" });
    const publicDetail = await app.inject({
      method: "GET",
      url: "/api/posts/published-post-a",
    });
    const unpublishedDetail = await app.inject({
      method: "GET",
      url: "/api/posts/unpublished-post",
    });
    expect(publicFeed.statusCode).toBe(200);
    expect(publicDetail.statusCode).toBe(200);
    expect(unpublishedDetail.statusCode).toBe(404);
    expect(publicFeed.json()).toHaveLength(1);
    expect(publicFeed.body).toContain('"citations":[1]');
    for (const forbidden of [
      "topicId",
      "researchId",
      "claimId",
      "sourceIds",
      "PRIVATE_POST_CLAIM_SENTINEL",
      "PRIVATE_FETCH_BODY_SENTINEL",
      "quality",
      "retrievalMethod",
    ]) {
      expect(publicFeed.body).not.toContain(forbidden);
      expect(publicDetail.body).not.toContain(forbidden);
    }

    const unpublished = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "published_post", resourceId: "unpublished-post" },
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_B.accessToken),
      payload: { resourceType: "published_post", resourceId: "published-post-a" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "published_post", resourceId: "published-post-a" },
    });
    const token = created.json<{ token: string }>().token;
    const resolved = await app.inject({ method: "GET", url: `/api/share/${token}` });
    const body = resolved.json<Record<string, unknown>>();

    expect(denied.statusCode).toBe(404);
    expect(unpublished.statusCode).toBe(404);
    expect(created.statusCode).toBe(201);
    expect(resolved.statusCode).toBe(200);
    expect(body).toMatchObject({
      type: "post",
      title: "A published MAX research summary",
      findings: [{ text: "The finding is supported by a cited source.", citations: [1] }],
      sources: [{ citation: 1, url: "https://example.org/docs" }],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private-claim-id");
    expect(serialized).not.toContain("PRIVATE_POST_CLAIM_SENTINEL");
    expect(serialized).not.toContain("published-post-a");
  });

  it("uses one indistinguishable 404 for invalid, expired, and revoked links", async () => {
    const { app, store } = await makeServer();
    await seedSession(store);
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "research-a" },
    });
    const share = created.json<{ id: string; token: string }>();
    const expiredToken = createShareToken();
    const oldTime = new Date(Date.now() - 86_400_000).toISOString();
    await withAuthenticatedUser(USER_A, () =>
      store.createShare({
        id: "expired-share",
        ownerId: USER_A.userId,
        resourceType: "research_session",
        resourceId: "research-a",
        tokenHash: hashShareToken(expiredToken),
        createdAt: oldTime,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    const invalid = await app.inject({ method: "GET", url: `/api/share/${createShareToken()}` });
    const expired = await app.inject({ method: "GET", url: `/api/share/${expiredToken}` });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/shares/${share.id}`,
      headers: auth(USER_A.accessToken),
    });
    const afterRevocation = await app.inject({ method: "GET", url: `/api/share/${share.token}` });

    expect(invalid.statusCode).toBe(404);
    expect(expired.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(204);
    expect(afterRevocation.statusCode).toBe(404);
    expect(expired.json()).toEqual(invalid.json());
    expect(afterRevocation.json()).toEqual(invalid.json());
  });

  it("fails closed on invalid resources and applies a dedicated public-resolution limit", async () => {
    const { app, store } = await makeServer({
      shareResolveRateLimiter: new RateLimiter(60_000, 1),
    });
    await withAuthenticatedUser(USER_A, () =>
      store.create(completedSession("in-progress", "SEARCHING")),
    );
    const invalidInput = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "in-progress", unexpected: true },
    });
    const unfinished = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: auth(USER_A.accessToken),
      payload: { resourceType: "research_session", resourceId: "in-progress" },
    });
    const malformed = await app.inject({ method: "GET", url: "/api/share/not-a-token" });
    const limited = await app.inject({ method: "GET", url: `/api/share/${createShareToken()}` });

    expect(invalidInput.statusCode).toBe(400);
    expect(unfinished.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(limited.statusCode).toBe(429);
  });

  it("persists only the token hash and keeps a share valid across an API/store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "max-sharing-v1-"));
    const databasePath = join(directory, "sharing.sqlite");
    let app: Awaited<ReturnType<typeof createServer>> | undefined;
    let store: SqliteSessionStore | undefined;
    try {
      store = new SqliteSessionStore(databasePath);
      ({ app } = await makeServer({ store }));
      await seedSession(store);
      const created = await app.inject({
        method: "POST",
        url: "/api/shares",
        headers: auth(USER_A.accessToken),
        payload: { resourceType: "research_session", resourceId: "research-a" },
      });
      const token = created.json<{ token: string }>().token;
      const expectedHash = hashShareToken(token);
      await app.close();
      servers.splice(servers.indexOf(app), 1);
      app = undefined;
      store = undefined;

      const database = new DatabaseSync(databasePath);
      const stored = database.prepare("SELECT token_hash FROM share_links").get() as
        { token_hash: string } | undefined;
      database.close();
      expect(stored?.token_hash).toBe(expectedHash);
      expect(stored?.token_hash).not.toBe(token);

      store = new SqliteSessionStore(databasePath);
      ({ app } = await makeServer({ store }));
      const afterRestart = await app.inject({ method: "GET", url: `/api/share/${token}` });
      expect(afterRestart.statusCode).toBe(200);
      expect(afterRestart.json()).toMatchObject({ type: "research", answer: expect.any(String) });
    } finally {
      if (app) {
        await app.close();
        const index = servers.indexOf(app);
        if (index >= 0) servers.splice(index, 1);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
