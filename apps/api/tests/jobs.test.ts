import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableQueueWorker,
  InMemoryDurableJobStore,
  RetryableJobError,
  type DurableJobStore,
  type EnqueueJobInput,
} from "../src/jobs.js";
import { SqliteDurableJobStore } from "../src/job-store.js";

const ownerA = "user-a";
const ownerB = "user-b";

function input(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    id: "job-1",
    kind: "research",
    ownerId: ownerA,
    ownerScope: `user:${ownerA}`,
    idempotencyKey: "request-1",
    payload: {
      sessionId: overrides.id ? `session-${overrides.id}` : "session-1",
      question: "Explain durable queues",
    },
    maxAttempts: 3,
    ...overrides,
  };
}

async function enqueue(store: DurableJobStore, overrides: Partial<EnqueueJobInput> = {}) {
  const result = await store.enqueueJob(input(overrides));
  if (!result.job) throw new Error("Test job was not created");
  return result.job;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for queue state");
}

describe("durable queue state machine", () => {
  it("creates a queued job without executing it", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
  });

  it("returns the original job for an idempotent replay", async () => {
    const store = new InMemoryDurableJobStore();
    const first = await enqueue(store);
    const replay = await store.enqueueJob(input({ id: "other-id", payload: input().payload }));
    expect(replay.created).toBe(false);
    expect(replay.job?.id).toBe(first.id);
  });

  it("rejects reuse of an idempotency key for different work", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    await expect(
      store.enqueueJob(input({ id: "other-id", payload: { question: "Different request" } })),
    ).rejects.toThrow(/different job request/);
  });

  it("keeps identical idempotency keys separate across owners", async () => {
    const store = new InMemoryDurableJobStore();
    const first = await enqueue(store);
    const second = await enqueue(store, {
      id: "job-2",
      ownerId: ownerB,
      ownerScope: `user:${ownerB}`,
    });
    expect(second.id).not.toBe(first.id);
  });

  it("charges quota only on the first idempotent enqueue", async () => {
    const store = new InMemoryDurableJobStore();
    const quota = { ownerId: ownerA, key: "research", windowSeconds: 60, limit: 1 };
    const first = await store.enqueueJob(input({ quota }));
    const replay = await store.enqueueJob(
      input({ id: "other-id", quota, payload: input().payload }),
    );
    expect(first.quota?.used).toBe(1);
    expect(replay.created).toBe(false);
    expect(replay.quota).toBeUndefined();
  });

  it("does not create a job when quota is exhausted", async () => {
    const store = new InMemoryDurableJobStore();
    const quota = { ownerId: ownerA, key: "research", windowSeconds: 60, limit: 1 };
    await enqueue(store, { quota });
    const blocked = await store.enqueueJob(
      input({ id: "job-2", idempotencyKey: "request-2", quota }),
    );
    expect(blocked.job).toBeUndefined();
    expect(blocked.quota?.allowed).toBe(false);
  });

  it("isolates quota usage by user", async () => {
    const store = new InMemoryDurableJobStore();
    const quotaA = { ownerId: ownerA, key: "research", windowSeconds: 60, limit: 1 };
    const quotaB = { ownerId: ownerB, key: "research", windowSeconds: 60, limit: 1 };
    await enqueue(store, { quota: quotaA });
    const second = await enqueue(store, {
      id: "job-2",
      ownerId: ownerB,
      ownerScope: `user:${ownerB}`,
      idempotencyKey: "request-1",
      quota: quotaB,
    });
    expect(second.ownerId).toBe(ownerB);
  });

  it("resets quota at the next configured time window", async () => {
    let now = 120_000;
    const store = new InMemoryDurableJobStore(() => now);
    const quota = { ownerId: ownerA, key: "research", windowSeconds: 60, limit: 1 };
    await enqueue(store, { quota });
    now += 60_000;
    const nextWindow = await enqueue(store, {
      id: "job-2",
      idempotencyKey: "request-2",
      quota,
    });
    expect(nextWindow.status).toBe("queued");
  });

  it("claims a job once and increments the fencing generation", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = await store.claimJob("worker-a", 5);
    expect(lease?.job.attempts).toBe(1);
    expect(lease?.generation).toBe(1);
    expect(lease?.job.leaseOwner).toBe("worker-a");
  });

  it("allows only one of simultaneous workers to claim a job", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const leases = await Promise.all([
      store.claimJob("worker-a", 5),
      store.claimJob("worker-b", 5),
      store.claimJob("worker-c", 5),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it("persists heartbeat progress and extends the lease", async () => {
    let now = 10_000;
    const store = new InMemoryDurableJobStore(() => now);
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    now += 3000;
    const heartbeat = await store.heartbeatJob(lease, 5, { stage: "fetching", count: 2 });
    expect(heartbeat.leaseValid).toBe(true);
    expect((await store.getJob(lease.job.id))?.progress).toEqual({ stage: "fetching", count: 2 });
    expect(Date.parse((await store.getJob(lease.job.id))!.leaseExpiresAt!)).toBe(now + 5000);
  });

  it("rejects heartbeats from a stale worker generation", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    await store.cancelJob(lease.job.id, ownerA);
    const heartbeat = await store.heartbeatJob(lease, 5, {});
    expect(heartbeat.cancelRequested).toBe(true);
  });

  it("stores a single completion result", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    expect(await store.completeJob(lease, { answer: "done" })).toBe("completed");
    expect((await store.getJob(lease.job.id))?.result).toEqual({ answer: "done" });
    expect(await store.completeJob(lease, { answer: "duplicate" })).toBeUndefined();
  });

  it("schedules retryable failures with bounded backoff", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    expect(await store.failJob(lease, "temporary", true, 3)).toBe("retrying");
    const updated = await store.getJob(lease.job.id);
    expect(updated?.errorSummary).toBe("temporary");
    expect(Date.parse(updated!.availableAt) - Date.parse(updated!.updatedAt)).toBe(3000);
  });

  it("uses one retry timestamp for the SQLite job update and availability", async () => {
    const directory = mkdtempSync(join(tmpdir(), "max-durable-retry-"));
    const path = join(directory, "jobs.sqlite");
    let now = 10_000;
    const store = new SqliteDurableJobStore(path, () => now);
    try {
      await enqueue(store);
      const lease = (await store.claimJob("worker-a", 5))!;
      now += 125;

      expect(await store.failJob(lease, "temporary", true, 3)).toBe("retrying");
      const updated = await store.getJob(lease.job.id);

      expect(Date.parse(updated!.availableAt) - Date.parse(updated!.updatedAt)).toBe(3000);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("makes non-retryable failures terminal", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    expect(await store.failJob(lease, "invalid payload", false, 0)).toBe("failed");
  });

  it("does not retry after the configured attempt limit", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store, { maxAttempts: 1 });
    const lease = (await store.claimJob("worker-a", 5))!;
    expect(await store.failJob(lease, "transient", true, 0)).toBe("failed");
  });

  it("recovers an expired lease and fences the previous attempt", async () => {
    let now = 50_000;
    const store = new InMemoryDurableJobStore(() => now);
    await enqueue(store);
    const firstLease = (await store.claimJob("worker-a", 5))!;
    now += 5001;
    expect(await store.completeJob(firstLease, { stale: true })).toBeUndefined();
    expect(await store.claimJob("worker-b", 5)).toBeUndefined();
    now += 2000;
    const secondLease = (await store.claimJob("worker-b", 5))!;
    expect(secondLease.generation).toBe(2);
    expect(secondLease.job.attempts).toBe(2);
  });

  it("fails after the final worker lease expires", async () => {
    let now = 70_000;
    const store = new InMemoryDurableJobStore(() => now);
    await enqueue(store, { maxAttempts: 1 });
    const lease = (await store.claimJob("worker-a", 5))!;
    now += 5001;
    expect(await store.claimJob("worker-b", 5)).toBeUndefined();
    expect((await store.getJob(lease.job.id))?.status).toBe("failed");
  });

  it("cancels a queued job immediately", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    expect((await store.cancelJob(job.id, ownerA))?.status).toBe("cancelled");
    expect(await store.claimJob("worker-a", 5)).toBeUndefined();
  });

  it("records cancellation for a running job until the worker acknowledges it", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store);
    const lease = (await store.claimJob("worker-a", 5))!;
    const cancelled = await store.cancelJob(lease.job.id, ownerA);
    expect(cancelled?.status).toBe("cancel_requested");
    expect((await store.heartbeatJob(lease, 5, {})).cancelRequested).toBe(true);
    expect(await store.completeJob(lease, {})).toBe("cancelled");
  });

  it("does not let one owner inspect or cancel another owner's job", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    expect(await store.getOwnedJob(job.id, ownerB)).toBeUndefined();
    expect(await store.cancelJob(job.id, ownerB)).toBeUndefined();
    expect((await store.getJob(job.id))?.status).toBe("queued");
  });

  it("requires explicit system-job permission for administrative cancellation", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store, {
      id: "system-job",
      kind: "post_agent",
      ownerId: undefined,
      ownerScope: "system",
      idempotencyKey: undefined,
      payload: { runId: "system-job" },
    });
    expect(await store.cancelJob(job.id)).toBeUndefined();
    expect((await store.cancelJob(job.id, undefined, true))?.status).toBe("cancelled");
  });

  it("finds the latest durable job for an owned research session", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    expect((await store.getJobForSession("session-1", ownerA))?.id).toBe(job.id);
    expect(await store.getJobForSession("session-1", ownerB)).toBeUndefined();
  });

  it("runs and persists a worker handler result", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    const worker = new DurableQueueWorker(
      store,
      {
        research: async () => ({ sessionId: "session-1", status: "COMPLETED" }),
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, leaseSeconds: 5 },
    );
    worker.start();
    await waitFor(async () => (await store.getJob(job.id))?.status === "completed");
    await worker.stop();
    expect((await store.getJob(job.id))?.result).toEqual({
      sessionId: "session-1",
      status: "COMPLETED",
    });
  });

  it("continues polling when completion and failure persistence both throw", async () => {
    const store = new InMemoryDurableJobStore();
    const first = await enqueue(store, { id: "first", idempotencyKey: undefined });
    const second = await enqueue(store, { id: "second", idempotencyKey: undefined });
    vi.spyOn(store, "completeJob").mockRejectedValueOnce(new Error("database unavailable"));
    vi.spyOn(store, "failJob").mockRejectedValueOnce(new Error("database unavailable"));
    const worker = new DurableQueueWorker(
      store,
      {
        research: async () => ({ status: "COMPLETED" }),
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, leaseSeconds: 5 },
    );
    worker.start();
    try {
      await waitFor(async () => (await store.getJob(second.id))?.status === "completed");
      expect((await store.getJob(first.id))?.status).toBe("running");
    } finally {
      await worker.stop();
    }
  });

  it("persists terminal transition progress after handler-reported recovery progress", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    const worker = new DurableQueueWorker(
      store,
      {
        research: async (_job, context) => {
          await context.reportProgress({ stage: "recovered" });
          return { recoveredBy: "replacement-worker" };
        },
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, leaseSeconds: 5 },
    );

    worker.start();
    await waitFor(async () => (await store.getJob(job.id))?.status === "completed");
    await worker.stop();

    expect(await store.getJob(job.id)).toMatchObject({
      status: "completed",
      attempts: 1,
      progress: {
        stage: "terminal_transition",
        terminalOutcome: "completed",
      },
      result: { recoveredBy: "replacement-worker" },
    });
  });

  it("retries only errors explicitly marked retryable", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store, { maxAttempts: 2 });
    let executions = 0;
    const worker = new DurableQueueWorker(
      store,
      {
        research: async () => {
          executions += 1;
          if (executions === 1) throw new RetryableJobError("transient provider failure");
          return { status: "COMPLETED" };
        },
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, leaseSeconds: 5, maxRetryDelaySeconds: 1 },
    );
    worker.start();
    await waitFor(async () => (await store.getJob(job.id))?.status === "completed", 3500);
    await worker.stop();
    expect(executions).toBe(2);
    expect((await store.getJob(job.id))?.attempts).toBe(2);
  });

  it("aborts a running handler after durable cancellation", async () => {
    const store = new InMemoryDurableJobStore();
    const job = await enqueue(store);
    const worker = new DurableQueueWorker(
      store,
      {
        research: async (_job, context) =>
          new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          }),
        post_agent: async () => ({}),
      },
      { pollIntervalMs: 100, heartbeatIntervalMs: 250, leaseSeconds: 5 },
    );
    worker.start();
    await waitFor(async () => (await store.getJob(job.id))?.status === "running");
    await store.cancelJob(job.id, ownerA);
    await waitFor(async () => (await store.getJob(job.id))?.status === "cancelled");
    await worker.stop();
    expect((await store.getJob(job.id))?.attempts).toBe(1);
  });

  it("limits simultaneous handler execution to configured concurrency", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueue(store, { id: "job-1", idempotencyKey: undefined });
    await enqueue(store, { id: "job-2", idempotencyKey: undefined });
    await enqueue(store, { id: "job-3", idempotencyKey: undefined });
    let active = 0;
    let maximum = 0;
    const worker = new DurableQueueWorker(
      store,
      {
        research: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 80));
          active -= 1;
          return { status: "COMPLETED" };
        },
        post_agent: async () => ({}),
      },
      { concurrency: 2, pollIntervalMs: 100, leaseSeconds: 5 },
    );
    worker.start();
    await waitFor(async () => !(await store.hasRunnableOrRunningJobs("research")), 2500);
    await worker.stop();
    expect(maximum).toBe(2);
  });

  it("persists queue records across a local process/store restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "max-durable-jobs-"));
    const path = join(directory, "jobs.sqlite");
    try {
      const first = new SqliteDurableJobStore(path);
      const job = await enqueue(first);
      first.close();
      const restarted = new SqliteDurableJobStore(path);
      expect((await restarted.getJob(job.id))?.status).toBe("queued");
      const lease = await restarted.claimJob("worker-after-restart", 5);
      expect(lease?.job.id).toBe(job.id);
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
