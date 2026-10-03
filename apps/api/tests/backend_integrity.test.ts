import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteSessionStore } from "../src/store.js";
import { withAuthenticatedUser, withResearchOwner } from "../src/auth-context.js";
import { withWorkerContext } from "../src/worker-context.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { understandQuery } from "../src/planner.js";
import { OpenRouterProvider } from "../src/llm.js";
import { ResearchRunner } from "../src/research.js";
import type { ResearchSession } from "../src/domain.js";

const identity = { userId: "integrity-user", accessToken: "fixture" };
const owner = <T>(operation: () => T) => withAuthenticatedUser(identity, operation);
function session(id = "session"): ResearchSession {
  const now = new Date().toISOString();
  return {
    id,
    question: "Explain closures",
    mode: "quick",
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    steps: [],
  };
}
async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for persisted outcome");
}

describe("backend integrity regressions", () => {
  it("honors the Post Agent durable-attempt cap supplied by an isolated acceptance harness", async () => {
    const store = new SqliteSessionStore(":memory:");
    const app = await createServer({ store, postAgentMaxAttempts: 1 });
    try {
      const run = await getServerBackgroundServices(app).contentAgent.trigger();
      const job = await getServerBackgroundServices(app).jobStore.getJob(run.id);

      expect(job).toMatchObject({ kind: "post_agent", attempts: 0, maxAttempts: 1 });
    } finally {
      await app.close();
    }
  });

  it("fences session writes after another worker takes the lease", async () => {
    const store = new SqliteSessionStore(":memory:");
    let now = Date.now();
    // Advance the fixture clock deterministically through expiry and recovery.
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const jobs = store.createJobStore();
    try {
      await jobs.enqueueJob({
        id: "job",
        kind: "research",
        ownerId: identity.userId,
        ownerScope: `user:${identity.userId}`,
        payload: { sessionId: "session" },
        maxAttempts: 3,
      });
      const first = (await jobs.claimJob("first", 5))!;
      const firstWrite = <T>(operation: () => T) =>
        withResearchOwner(identity.userId, () =>
          withWorkerContext(first, new AbortController().signal, async () => {}, operation),
        );
      await firstWrite(() => store.create(session()));
      now += 5001;
      await jobs.claimJob("second", 5);
      now += 2001;
      expect(await jobs.claimJob("second", 5)).toBeDefined();
      await expect(
        firstWrite(() => store.update({ ...session(), answer: "stale private answer" })),
      ).rejects.toThrow("lease");
      expect((await owner(() => store.get("session")))?.answer).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      jobs.close();
      store.close();
    }
  });

  it("keeps deletion markers across writes and protects foreign owners", async () => {
    const store = new SqliteSessionStore(":memory:");
    try {
      await owner(() => store.create(session()));
      await withAuthenticatedUser({ userId: "other", accessToken: "other" }, () =>
        store.delete("session"),
      );
      expect(await owner(() => store.get("session"))).toBeDefined();
      await owner(() => store.delete("session"));
      await expect(owner(() => store.create(session()))).rejects.toThrow("deleted");
      expect(await owner(() => store.listDeletedIds(["session"]))).toEqual(new Set(["session"]));
      expect(
        await withAuthenticatedUser({ userId: "other", accessToken: "other" }, () =>
          store.listDeletedIds(["session"]),
        ),
      ).toEqual(new Set());
    } finally {
      store.close();
    }
  });

  it("atomically rejects competing session jobs without charging a second quota", async () => {
    const store = new SqliteSessionStore(":memory:");
    const jobs = store.createJobStore();
    const input = {
      kind: "research" as const,
      ownerId: identity.userId,
      ownerScope: `user:${identity.userId}`,
      payload: { sessionId: "session" },
      maxAttempts: 3,
      quota: {
        ownerId: identity.userId,
        key: "research" as const,
        windowSeconds: 86400,
        limit: 20,
      },
    };
    try {
      const results = await Promise.allSettled([
        jobs.enqueueJob({ ...input, id: "first" }),
        jobs.enqueueJob({ ...input, id: "second" }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((await store.getUserQuotaUsage(identity.userId, "research", 86400)).used).toBe(1);
    } finally {
      jobs.close();
      store.close();
    }
  });

  it("replays a direct chat answer and charges simultaneous duplicate requests once", async () => {
    const store = new SqliteSessionStore(":memory:");
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "fixture",
      execute: async (input) =>
        understandQuery(
          (input as { question: string }).question,
          new OpenRouterProvider(),
          "quick",
          { allowModel: false },
        ),
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const synthesize = vi.fn(async () => {
      await pending;
      return "Closures retain access to their surrounding variables.";
    });
    tools.register({ name: "synthesize", description: "fixture", execute: synthesize });
    const app = await createServer({
      store,
      toolRegistry: tools,
      authVerifier: { verifyAccessToken: async () => ({ id: identity.userId }) },
      memoryService: {
        enabled: false,
        retrieveForQuestion: async () => ({ needed: false, memories: [] }),
      } as never,
    });
    const request = {
      method: "POST" as const,
      url: "/api/chat",
      headers: { authorization: "Bearer fixture", "idempotency-key": "direct-once" },
      payload: { message: "Explain JavaScript closures simply" },
    };
    try {
      const [first, duplicate] = await Promise.all([app.inject(request), app.inject(request)]);
      expect(first.statusCode).toBe(202);
      expect(duplicate.json().jobId).toBe(first.json().jobId);
      finish();
      const jobs = getServerBackgroundServices(app).jobStore;
      await waitFor(async () => (await jobs.getJob(first.json().jobId))?.status === "completed");
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().answer).toContain("Closures retain");
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect((await store.getUserQuotaUsage(identity.userId, "research", 86400)).used).toBe(1);
    } finally {
      finish();
      await app.close();
    }
  });

  it("repairs a stranded terminal session and hides deleted queued research", async () => {
    const store = new SqliteSessionStore(":memory:");
    const app = await createServer({
      store,
      authVerifier: { verifyAccessToken: async () => ({ id: identity.userId }) },
    });
    const jobs = getServerBackgroundServices(app).jobStore;
    const headers = { authorization: "Bearer fixture" };
    try {
      await owner(() => store.create(session("stranded")));
      await jobs.enqueueJob({
        id: "failed-job",
        kind: "research",
        ownerId: identity.userId,
        ownerScope: `user:${identity.userId}`,
        payload: { sessionId: "stranded", question: "Explain closures", mode: "quick" },
        maxAttempts: 1,
      });
      const lease = (await jobs.claimJob("fixture", 5))!;
      await jobs.failJob(lease, "Worker stopped", false, 0);
      expect((await app.inject({ url: "/api/research/stranded", headers })).json().status).toBe(
        "FAILED",
      );
      expect((await owner(() => store.get("stranded")))?.status).toBe("FAILED");
      await jobs.enqueueJob({
        id: "pending",
        kind: "research",
        ownerId: identity.userId,
        ownerScope: `user:${identity.userId}`,
        payload: { sessionId: "pending", question: "Explain closures", mode: "quick" },
        maxAttempts: 1,
      });
      expect(
        (await app.inject({ method: "DELETE", url: "/api/research/pending", headers })).statusCode,
      ).toBe(204);
      expect((await app.inject({ url: "/api/research/pending", headers })).statusCode).toBe(404);
      expect(
        (await app.inject({ url: "/api/research", headers }))
          .json()
          .some((item: ResearchSession) => item.id === "pending"),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("shares rate counters across connections to the same database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "max-rate-regression-"));
    const store = new SqliteSessionStore(join(directory, "rate.sqlite"));
    const replica = new SqliteSessionStore(join(directory, "rate.sqlite"));
    try {
      expect((await store.consumeRateLimit("api", "client", 60000, 1)).allowed).toBe(true);
      expect((await replica.consumeRateLimit("api", "client", 60000, 1)).allowed).toBe(false);
      expect((await store.consumeRateLimit("api", "different-client", 60000, 1)).allowed).toBe(
        true,
      );
    } finally {
      store.close();
      replica.close();
      if (!resolve(directory).startsWith(join(resolve(tmpdir()), "max-rate-regression-")))
        throw new Error("Unexpected temporary directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aborts child research provider work when its parent worker stops", async () => {
    const store = new SqliteSessionStore(":memory:");
    const provider = new OpenRouterProvider();
    const enabled = vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
    const signals: AbortSignal[] = [];
    let searched!: () => void;
    const started = new Promise<void>((resolve) => {
      searched = resolve;
    });
    const search = {
      search: async (_query: string, signal?: AbortSignal) => {
        if (!signal) throw new Error("Child research must carry an abort signal");
        signals.push(signal);
        searched();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const runner = new ResearchRunner(store, search, provider, undefined, { maxTimeMs: 2000 });
    const parent = new AbortController();
    try {
      const child = await runner.start(
        "Compare React Native and Flutter performance profiling",
        "deep",
        [],
        { signal: parent.signal },
      );
      await started;
      parent.abort(new Error("Worker is shutting down"));
      await waitFor(async () => (await store.get(child.id))?.status === "FAILED");
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      parent.abort();
      enabled.mockRestore();
      store.close();
    }
  });
});
