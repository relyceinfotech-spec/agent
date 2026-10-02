import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseAuthVerifier } from "../src/auth.js";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { config } from "../src/config.js";
import { SqliteDurableJobStore } from "../src/job-store.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { createServer } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";
import type { ResearchSession } from "../src/domain.js";

const stores: SqliteSessionStore[] = [];
const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];
const serverStores = new Set<SqliteSessionStore>();

function makeStore() {
  const store = new SqliteSessionStore(":memory:");
  stores.push(store);
  return store;
}

function session(id: string): ResearchSession {
  const now = new Date().toISOString();
  return {
    id,
    question: "Test private research ownership",
    mode: "quick",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    steps: [],
  };
}

async function makeServer(
  store = makeStore(),
  options: {
    search?: () => unknown;
    llmCall?: () => void;
    jobStore?: SqliteDurableJobStore;
    authVerifier?: { verifyAccessToken: (token: string) => Promise<{ id: string } | undefined> };
  } = {},
) {
  serverStores.add(store);
  const app = await createServer({
    store,
    jobStore: options.jobStore,
    authVerifier: options.authVerifier ?? {
      verifyAccessToken: async (token) => {
        if (token === "user-a-token") return { id: "user-a", email: "a@example.test" };
        if (token === "user-b-token") return { id: "user-b", email: "b@example.test" };
        return undefined;
      },
    },
    searchProvider: {
      search: async () => {
        options.search?.();
        return [];
      },
    },
    llmProvider: new Proxy(
      { enabled: true },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => {
            options.llmCall?.();
            throw new Error("The test model must not be called");
          };
        },
      },
    ) as never,
    quotaPolicy: new QuotaPolicy(
      JSON.stringify({
        default: {
          enabled: true,
          quotas: {
            research: { limit: 1, windowSeconds: 86400 },
            deep_research: { limit: 1, windowSeconds: 86400 },
            followup: { limit: 1, windowSeconds: 86400 },
          },
          features: { research: true, deepResearch: true, postFollowUps: true },
        },
      }),
    ),
  });
  servers.push(app);
  return { app, store };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const store of stores.splice(0)) {
    if (!serverStores.has(store)) store.close();
    serverStores.delete(store);
  }
});

describe("Supabase Auth request authorization and private ownership", () => {
  it("rejects missing and invalid credentials without echoing the token", async () => {
    const { app } = await makeServer();
    const missing = await app.inject({ method: "GET", url: "/api/research" });
    const secret = "invalid-token-do-not-log";
    const invalid = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer(secret),
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).not.toContain(secret);
    const expired = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer("expired-token"),
    });
    expect(expired.statusCode).toBe(401);
  });

  it("scopes list, read, update, and delete operations to the verified owner", async () => {
    const { app, store } = await makeServer();
    await withAuthenticatedUser({ userId: "user-a", accessToken: "user-a-token" }, () =>
      store.create(session("session-a")),
    );
    await withAuthenticatedUser({ userId: "user-b", accessToken: "user-b-token" }, () =>
      store.create(session("session-b")),
    );

    const aList = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer("user-a-token"),
    });
    const bCannotReadA = await app.inject({
      method: "GET",
      url: "/api/research/session-a",
      headers: bearer("user-b-token"),
    });
    const aCannotReadB = await app.inject({
      method: "GET",
      url: "/api/research/session-b",
      headers: bearer("user-a-token"),
    });
    const bCannotDeleteA = await app.inject({
      method: "DELETE",
      url: "/api/research/session-a",
      headers: bearer("user-b-token"),
    });
    const bCannotCancelA = await app.inject({
      method: "POST",
      url: "/api/research/session-a/cancel",
      headers: bearer("user-b-token"),
    });
    const aCannotCancelB = await app.inject({
      method: "POST",
      url: "/api/research/session-b/cancel",
      headers: bearer("user-a-token"),
    });
    const aStillOwnsA = await app.inject({
      method: "GET",
      url: "/api/research/session-a",
      headers: bearer("user-a-token"),
    });
    await withAuthenticatedUser({ userId: "user-b", accessToken: "user-b-token" }, () =>
      store.update({ ...session("session-a"), question: "Attempted cross-user overwrite" }),
    );
    const aAfterForeignUpdate = await app.inject({
      method: "GET",
      url: "/api/research/session-a",
      headers: bearer("user-a-token"),
    });
    const forgedOwner = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: bearer("user-a-token"),
      payload: {
        question: "Start a research session for user B",
        mode: "quick",
        user_id: "user-b",
      },
    });
    const createdId = forgedOwner.json().id;
    const userBCannotReadForgedSession = await app.inject({
      method: "GET",
      url: `/api/research/${createdId}`,
      headers: bearer("user-b-token"),
    });
    const userACanReadForgedSession = await app.inject({
      method: "GET",
      url: `/api/research/${createdId}`,
      headers: bearer("user-a-token"),
    });

    expect(aList.statusCode).toBe(200);
    expect(aList.json().map((item: ResearchSession) => item.id)).toEqual(["session-a"]);
    expect(bCannotReadA.statusCode).toBe(404);
    expect(aCannotReadB.statusCode).toBe(404);
    expect(bCannotDeleteA.statusCode).toBe(404);
    expect(bCannotCancelA.statusCode).toBe(404);
    expect(aCannotCancelB.statusCode).toBe(404);
    expect(aStillOwnsA.statusCode).toBe(200);
    expect(aAfterForeignUpdate.json().question).toBe("Test private research ownership");
    expect(forgedOwner.statusCode).toBe(202);
    expect(userBCannotReadForgedSession.statusCode).toBe(404);
    expect(userACanReadForgedSession.statusCode).toBe(200);
  });

  it("returns bounded research-session pages with an owner-scoped next cursor", async () => {
    const { app, store } = await makeServer();
    const createdAt = [
      "2026-09-26T00:00:00.000Z",
      "2026-09-25T00:00:00.000Z",
      "2026-09-24T00:00:00.000Z",
    ];
    await withAuthenticatedUser({ userId: "user-a", accessToken: "user-a-token" }, async () => {
      for (const [index, id] of ["session-c", "session-b", "session-a"].entries()) {
        await store.create({ ...session(id), createdAt: createdAt[index]! });
      }
    });

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/research?limit=2&client=web",
      headers: { ...bearer("user-a-token"), origin: "http://localhost:3000" },
    });
    const cursor = firstPage.headers["x-next-cursor"];
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/research?limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      headers: bearer("user-a-token"),
    });
    const invalidLimit = await app.inject({
      method: "GET",
      url: "/api/research?limit=101",
      headers: bearer("user-a-token"),
    });
    const invalidCursor = await app.inject({
      method: "GET",
      url: "/api/research?cursor=not-a-cursor",
      headers: bearer("user-a-token"),
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().map((item: ResearchSession) => item.id)).toEqual([
      "session-c",
      "session-b",
    ]);
    expect(typeof cursor).toBe("string");
    expect(firstPage.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().map((item: ResearchSession) => item.id)).toEqual(["session-a"]);
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidCursor.statusCode).toBe(400);
  });

  it("does not repeat detached queued jobs on later session pages", async () => {
    const store = makeStore();
    const jobStore = new SqliteDurableJobStore(":memory:");
    const { app } = await makeServer(store, { jobStore });
    const createdAt = [
      "2026-09-26T00:00:00.000Z",
      "2026-09-25T00:00:00.000Z",
      "2026-09-24T00:00:00.000Z",
    ];
    await withAuthenticatedUser({ userId: "user-a", accessToken: "user-a-token" }, async () => {
      for (const [index, id] of ["session-c", "session-b", "session-a"].entries()) {
        await store.create({ ...session(id), createdAt: createdAt[index]! });
      }
    });
    await jobStore.enqueueJob({
      id: "pending-job",
      kind: "research",
      ownerId: "user-a",
      ownerScope: "user:user-a",
      payload: {
        sessionId: "pending-session",
        question: "Pending research",
        mode: "quick",
      },
      maxAttempts: 3,
    });

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/research?limit=2",
      headers: bearer("user-a-token"),
    });
    const cursor = firstPage.headers["x-next-cursor"];
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/research?limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      headers: bearer("user-a-token"),
    });

    expect(firstPage.json().map((item: ResearchSession) => item.id)).toContain("pending-session");
    expect(secondPage.json().map((item: ResearchSession) => item.id)).toEqual(["session-a"]);
  });

  it("keeps Discover public and does not grant admin access to an authenticated user", async () => {
    const originalAdminToken = config.MAX_ADMIN_TOKEN;
    config.MAX_ADMIN_TOKEN = "test-admin-token";
    try {
      const { app } = await makeServer();
      const discover = await app.inject({ method: "GET", url: "/api/discover" });
      const normalUser = await app.inject({
        method: "GET",
        url: "/api/autonomous/runs",
        headers: bearer("user-a-token"),
      });
      const admin = await app.inject({
        method: "GET",
        url: "/api/autonomous/runs",
        headers: bearer("test-admin-token"),
      });

      expect(discover.statusCode).toBe(200);
      expect(normalUser.statusCode).toBe(401);
      expect(admin.statusCode).toBe(200);
    } finally {
      config.MAX_ADMIN_TOKEN = originalAdminToken;
    }
  });

  it("returns a generic error when Supabase Auth is unavailable", async () => {
    const secret = "do-not-echo-auth-verification-detail";
    const { app } = await makeServer(makeStore(), {
      authVerifier: {
        verifyAccessToken: async () => {
          throw new Error(secret);
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer("user-token"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(secret);
    expect(response.body).toContain("This capability is currently unavailable");
  });

  it("does not call providers after a quota is exhausted", async () => {
    const search = vi.fn();
    const llmCall = vi.fn();
    const store = makeStore();
    const { app } = await makeServer(store, { search, llmCall });
    await store.consumeUserQuota("user-a", "research", 86400, 1);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer("user-a-token"),
      payload: { message: "Explain JavaScript closures simply" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().quota).toBe("research");
    expect(search).not.toHaveBeenCalled();
    expect(llmCall).not.toHaveBeenCalled();
    await expect(store.consumeUserQuota("user-a", "research", 86400, 1)).resolves.toMatchObject({
      allowed: false,
      used: 1,
    });
  });
});

describe("configurable quota policies and atomic counters", () => {
  it("supports plan identities, enablement, limits, feature flags, and user overrides", () => {
    const policy = new QuotaPolicy(
      JSON.stringify({
        default: {
          enabled: true,
          quotas: { research: { limit: 8, windowSeconds: 3600 } },
          features: { research: true, deepResearch: false },
          billingMetadata: { source: "not-configured" },
        },
        internal: {
          enabled: false,
          quotas: { research: { limit: 50, windowSeconds: 86400 } },
        },
      }),
      JSON.stringify({ "user-a": "internal" }),
    );

    expect(policy.forUser("user-a").id).toBe("internal");
    expect(policy.forUser("user-a").enabled).toBe(false);
    expect(policy.definition("user-a", "research")).toBeUndefined();
    expect(policy.definition("user-b", "research")).toEqual({ limit: 8, windowSeconds: 3600 });
    expect(policy.definition("user-b", "deep_research")).toBeUndefined();
    expect(policy.snapshot().map((plan) => plan.id)).toEqual(["default", "internal"]);
  });

  it("isolates usage by user and serializes concurrent limit checks", async () => {
    const store = makeStore();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.consumeUserQuota("user-a", "research", 86400, 3)),
    );
    const otherUser = await store.consumeUserQuota("user-b", "research", 86400, 3);

    expect(results.filter((item) => item.allowed)).toHaveLength(3);
    expect(results.filter((item) => !item.allowed)).toHaveLength(9);
    expect(otherUser.allowed).toBe(true);
    expect(otherUser.used).toBe(1);
  });

  it("starts a fresh bucket when a configured quota window changes", async () => {
    const store = makeStore();
    await expect(store.consumeUserQuota("user-a", "research", 86400, 1)).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
    await expect(store.consumeUserQuota("user-a", "research", 3600, 1)).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
  });
});

describe("Supabase access-token verification", () => {
  function makeVerifier(response: unknown) {
    const getClaims = vi.fn().mockResolvedValue(response);
    const client = { auth: { getClaims } };
    return {
      verifier: new SupabaseAuthVerifier(
        "https://project.supabase.co",
        "test-key",
        client as never,
      ),
      getClaims,
    };
  }

  it("accepts verified authenticated claims and returns only server-verified identity", async () => {
    const { verifier, getClaims } = makeVerifier({
      data: {
        claims: {
          sub: "user-a",
          role: "authenticated",
          email: "a@example.test",
          user_metadata: { role: "admin" },
        },
      },
      error: null,
    });

    await expect(verifier.verifyAccessToken("verified-token")).resolves.toEqual({
      id: "user-a",
      email: "a@example.test",
    });
    expect(getClaims).toHaveBeenCalledWith("verified-token");
  });

  it("preserves a bad_jwt 403 when Supabase returns a malformed error body", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("not-json", {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-sb-error-code": "bad_jwt",
          },
        }),
    ) as unknown as typeof fetch;
    const verifier = new SupabaseAuthVerifier(
      "https://project.supabase.co",
      "test-key",
      undefined,
      fetcher,
    );
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub: "user-a",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.${Buffer.from([0, 0, 0]).toString("base64url")}`;

    const { app } = await makeServer(makeStore(), {
      authVerifier: {
        verifyAccessToken: (accessToken) => verifier.verifyAccessToken(accessToken),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(401);
    expect(fetcher).toHaveBeenCalledOnce();
    const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(requestInit?.headers).get("accept-encoding")).toBe("identity");
  });

  it.each([
    { label: "invalid token", status: 403 },
    { label: "malformed token", status: 400 },
    { label: "expired token", status: 401 },
  ])("maps a Supabase $label response to HTTP 401", async ({ status }) => {
    const { verifier } = makeVerifier({
      data: null,
      error: { status },
    });
    const { app } = await makeServer(makeStore(), {
      authVerifier: {
        verifyAccessToken: (token) => verifier.verifyAccessToken(token),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/research",
      headers: bearer("untrusted-token"),
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("untrusted-token");
  });

  it.each([
    { sub: "user-a", role: "anon" },
    { sub: "user-a", role: "authenticated", is_anonymous: true },
    { role: "authenticated" },
  ])("rejects claims that do not represent a regular authenticated user", async (claims) => {
    const { verifier } = makeVerifier({ data: { claims }, error: null });
    await expect(verifier.verifyAccessToken("token")).resolves.toBeUndefined();
  });

  it("treats expired/invalid-token responses as unauthenticated and propagates service failures", async () => {
    const { verifier } = makeVerifier({ data: { claims: null }, error: { status: 401 } });
    await expect(verifier.verifyAccessToken("expired-token")).resolves.toBeUndefined();

    const serviceFailure = new Error("Auth unavailable");
    const unavailable = makeVerifier({ data: null, error: serviceFailure });
    await expect(unavailable.verifier.verifyAccessToken("token")).rejects.toBe(serviceFailure);
  });
});
