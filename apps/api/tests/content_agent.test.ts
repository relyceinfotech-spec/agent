import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResearchSession, Source } from "../src/domain.js";
import type { AutonomousRun, TopicCandidate } from "../src/content-domain.js";
import { ContentAgent } from "../src/content-agent.js";
import { DurableQueueWorker, InMemoryDurableJobStore } from "../src/jobs.js";
import { SqliteSessionStore } from "../src/store.js";
import { discoverTopics } from "../src/topic-discovery.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "max-content-test-"));
  directories.push(directory);
  return new SqliteSessionStore(join(directory, "max.sqlite"));
}

function topic(): TopicCandidate {
  return {
    id: randomUUID(),
    title: "New React rendering research findings",
    url: "https://react.dev/blog/new-rendering-findings",
    summary: "Official research article about the latest rendering changes and measured results.",
    provider: "test-feed",
    publishedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    score: 0.9,
    status: "CANDIDATE",
  };
}

function source(id: string, url: string): Source {
  return {
    id,
    title: "Verified research source",
    url,
    snippet: "Independent documented evidence",
    domain: new URL(url).hostname,
    content:
      "This source explains the measured rendering behavior, verification method, limitations, and evidence in enough detail for independent inspection. ".repeat(
        3,
      ),
    fetchedAt: new Date().toISOString(),
    quality: { relevance: 0.9, authority: 0.9, freshness: 0.9, completeness: 0.9, overall: 0.9 },
  };
}

function completedResearch(topicUrl: string, verified = true): ResearchSession {
  const now = new Date().toISOString();
  const sources = [
    source("s1", topicUrl),
    source("s2", "https://example.org/independent-analysis"),
  ];
  return {
    id: randomUUID(),
    question: "New React rendering research findings",
    mode: "deep",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources,
    claims: sources.map((item, index) => ({
      id: `c${index + 1}`,
      text: `The documented rendering behavior was measured and explained by source ${index + 1}, with practical limits and methodology clearly described.`,
      sourceIds: [item.id],
      evidence: item.content!.slice(0, 300),
      confidence: 0.9,
      verification: { verdict: verified ? "supported" : "uncertain" },
    })),
    conflicts: [],
    answer:
      "The research findings are supported by two independently retrieved sources. The reported behavior was checked against source documentation, and the limitations remain visible to readers.",
    steps: [],
  };
}

async function waitForRun(store: SqliteSessionStore, id: string): Promise<AutonomousRun> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await store.getRun(id);
    if (
      run &&
      ["PUBLISHED", "FAILED", "REJECTED", "REQUIRES_REVIEW", "CANCELLED"].includes(run.status)
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Autonomous test run did not finish");
}

async function waitForResearchId(store: SqliteSessionStore, id: string): Promise<AutonomousRun> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await store.getRun(id);
    if (run?.researchId) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Autonomous run did not start research");
}

async function waitForJob(
  store: InMemoryDurableJobStore,
  id: string,
  terminal: string[] = ["completed", "failed", "cancelled"],
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await store.getJob(id);
    if (job && terminal.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable Post Agent job did not reach a terminal state");
}

describe("autonomous content agent", () => {
  it("discovers a feed topic, researches it, passes the quality gate, and publishes provenance", async () => {
    const store = makeStore();
    const publishedAt = new Date().toISOString();
    const research = {
      start: vi.fn(async (_question: string, _mode: string, seeds: Array<{ url: string }>) => {
        const session = completedResearch(seeds[0].url);
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, ["fixture-feed"], async () => [
      {
        title: "New React rendering research findings",
        url: "https://react.dev/blog/new-rendering-findings",
        summary: "Official research article with measured results and methodology. ".repeat(4),
        publishedAt,
        provider: "fixture-feed",
      },
    ]);

    const run = await waitForRun(store, (await agent.trigger()).id);

    try {
      expect(run.status).toBe("PUBLISHED");
      expect(run.events.map((event) => event.stage)).toEqual(
        expect.arrayContaining(["discovering", "researching", "quality_gate", "published"]),
      );
      expect(research.start).toHaveBeenCalledWith(
        "New React rendering research findings",
        "deep",
        [
          expect.objectContaining({
            url: "https://react.dev/blog/new-rendering-findings",
            provider: "topic-feed",
          }),
        ],
        { allowSnippetEvidence: false },
      );
      const topicRecord = (await store.getTopic(run.topicId!))!;
      expect(topicRecord.status).toBe("PUBLISHED");
      const post = (await store.getPost(run.postId!))!;
      expect(post.researchId).toBe(run.researchId);
      expect(post.sources.map((item) => item.url)).toContain(topicRecord.url);
      expect(post.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("publishes a provenance-linked post from a verified research session", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: vi.fn(async () => {
        const session = completedResearch(candidate.url);
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);
    const run = await waitForRun(store, (await agent.trigger(candidate.id)).id);
    expect(run.status).toBe("PUBLISHED");
    const post = (await store.getPost(run.postId!))!;
    expect(post.researchId).toBe(run.researchId);
    expect(post.findings).toHaveLength(2);
    expect(post.sources.map((item) => item.id)).toEqual(["s1", "s2"]);

    const duplicate = await waitForRun(store, (await agent.trigger(candidate.id)).id);
    expect(duplicate.status).toBe("REJECTED");
    expect(research.start).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("holds a weak research package for review instead of publishing", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: async () => {
        const session = completedResearch(candidate.url, false);
        await store.create(session);
        return session;
      },
      cancel: async () => undefined,
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);
    const run = await waitForRun(store, (await agent.trigger(candidate.id)).id);
    expect(run.status).toBe("REQUIRES_REVIEW");
    expect(run.error).toContain("Too few verified claims");
    expect(await store.listPosts()).toHaveLength(0);
    store.close();
  });

  it("does not publish when a verifier-supported claim cites a different entity/version", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: vi.fn(async () => {
        const session = completedResearch(candidate.url);
        const wrongEntitySource = session.sources[0]!;
        wrongEntitySource.sourceType = "official";
        wrongEntitySource.content =
          "React Native 0.80 is now available and documents the mobile framework release, compatibility notes, and migration guidance for application developers.";
        session.claims[0] = {
          ...session.claims[0]!,
          text: "React 19.3 is now available with release improvements.",
          sourceIds: [wrongEntitySource.id],
          evidence: wrongEntitySource.content,
        };
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);

    try {
      const run = await waitForRun(store, (await agent.trigger(candidate.id)).id);

      expect(run.status).toBe("REQUIRES_REVIEW");
      expect(run.error).toContain("Too few verified claims");
      expect(await store.listPosts()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("preserves failed-stage evidence and sends model-stage failures to safe review", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: vi.fn(async () => {
        const session = completedResearch(candidate.url);
        session.status = "FAILED";
        session.error = "Verifier fallback failed: OpenRouter returned 429";
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);

    try {
      const run = await waitForRun(store, (await agent.trigger(candidate.id)).id);

      expect(run.status).toBe("REQUIRES_REVIEW");
      expect(run.error).toContain("Verifier fallback failed");
      expect((await store.get(run.researchId!))?.sources).toHaveLength(2);
      expect(await store.listPosts()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("cancels an active research run and records the terminal state", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const researchSessionId = randomUUID();
    let starts = 0;
    const research = {
      start: vi.fn(async () => {
        starts += 1;
        if (starts > 1) {
          const completed = completedResearch(candidate.url);
          await store.create(completed);
          return completed;
        }
        const now = new Date().toISOString();
        const session: ResearchSession = {
          id: researchSessionId,
          question: candidate.title,
          mode: "deep",
          status: "SEARCHING",
          createdAt: now,
          updatedAt: now,
          sources: [],
          claims: [],
          conflicts: [],
          steps: [],
        };
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);

    try {
      const queued = await agent.trigger(candidate.id);
      const active = await waitForResearchId(store, queued.id);
      expect(active.status).toBe("RESEARCHING");

      const cancelled = await agent.cancel(queued.id);

      expect(cancelled?.status).toBe("CANCELLED");
      expect(research.cancel).toHaveBeenCalledWith(researchSessionId);
      expect((await store.getRun(queued.id))?.events.at(-1)?.stage).toBe("cancelled");

      const laterRun = await waitForRun(store, (await agent.trigger(candidate.id)).id);
      expect(laterRun.status).toBe("PUBLISHED");
      expect(research.start).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("retries failed runs at most twice and preserves retry provenance", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: vi.fn(async () => {
        throw new Error("fixture research failure");
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);

    try {
      const original = await waitForRun(store, (await agent.trigger(candidate.id)).id);
      const retryOne = await waitForRun(store, (await agent.retry(original.id)).id);
      const retryTwo = await waitForRun(store, (await agent.retry(retryOne.id)).id);

      expect([original.status, retryOne.status, retryTwo.status]).toEqual([
        "FAILED",
        "FAILED",
        "FAILED",
      ]);
      expect(retryOne.retryOf).toBe(original.id);
      expect(retryTwo.retryOf).toBe(retryOne.id);
      await expect(agent.retry(retryTwo.id)).rejects.toThrow("Autonomous retry limit reached");
      expect(research.start).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
    }
  });

  it("records discovery outages as failed instead of rejecting them as low-value topics", async () => {
    const store = makeStore();
    const research = {
      start: vi.fn(),
      cancel: vi.fn(),
    };
    const search = {
      search: vi.fn(async () => {
        throw new Error("Serper credentials missing");
      }),
    };
    const agent = new ContentAgent(
      store,
      research as never,
      ["offline-feed"],
      async () => {
        throw new Error("Feed host unavailable");
      },
      search,
    );

    try {
      const run = await waitForRun(store, (await agent.trigger()).id);

      expect(run.status).toBe("FAILED");
      expect(run.error).toContain("All topic discovery routes failed");
      expect(run.error).toContain("Feed host unavailable");
      expect(run.error).toContain("Serper credentials missing");
      expect(research.start).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("resumes persisted queued runs after an application restart", async () => {
    const store = makeStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const now = new Date().toISOString();
    const queued: AutonomousRun = {
      id: randomUUID(),
      trigger: "manual",
      status: "QUEUED",
      topicId: candidate.id,
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, stage: "queue", status: "started", detail: "Run queued" }],
    };
    await store.saveRun(queued);
    const research = {
      start: vi.fn(async () => {
        const session = completedResearch(candidate.url);
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(store, research as never, [], async () => []);

    try {
      expect(await agent.resumeQueuedRuns()).toBe(1);
      const resumed = await waitForRun(store, queued.id);
      expect(resumed.status).toBe("PUBLISHED");
      expect(resumed.topicId).toBe(candidate.id);
      expect(research.start).toHaveBeenCalledOnce();
      expect(await agent.resumeQueuedRuns()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("executes a persisted topic through the durable Post Agent worker", async () => {
    const store = makeStore();
    const jobs = new InMemoryDurableJobStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const research = {
      start: vi.fn(async () => {
        const session = completedResearch(candidate.url);
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(async () => undefined),
    };
    const agent = new ContentAgent(
      store,
      research as never,
      [],
      async () => [],
      undefined,
      async (run) => {
        const result = await jobs.enqueueJob({
          id: run.id,
          kind: "post_agent",
          ownerScope: "system",
          payload: { runId: run.id },
          maxAttempts: 2,
        });
        if (!result.job) throw new Error("Could not enqueue fixture Post Agent run");
      },
    );
    const worker = new DurableQueueWorker(
      jobs,
      {
        research: async () => ({}),
        post_agent: async (job, context) => {
          const run = await agent.runQueued(
            String(job.payload.runId),
            context.signal,
            context.reportProgress,
          );
          if (!run) throw new Error("Post Agent run was not persisted");
          return { runId: run.id, runStatus: run.status };
        },
      },
      { pollIntervalMs: 100, leaseSeconds: 5, workerIdPrefix: "content-agent-test" },
    );

    try {
      worker.start();
      const queuedRun = await agent.trigger(candidate.id);
      const job = await waitForJob(jobs, queuedRun.id);
      const completedRun = await store.getRun(queuedRun.id);

      expect(job.status).toBe("completed");
      expect(job.result).toMatchObject({ runId: queuedRun.id, runStatus: "PUBLISHED" });
      expect(completedRun?.status).toBe("PUBLISHED");
      expect(research.start).toHaveBeenCalledOnce();
      expect((await store.getPost(completedRun!.postId!))?.researchId).toBe(
        completedRun?.researchId,
      );
    } finally {
      await worker.stop();
      store.close();
    }
  });

  it("cancels a durable Post Agent run during topic discovery", async () => {
    const store = makeStore();
    const jobs = new InMemoryDurableJobStore();
    let releaseFeed!: (entries: []) => void;
    const feedPending = new Promise<[]>((resolve) => {
      releaseFeed = resolve;
    });
    const agent = new ContentAgent(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      ["fixture-feed"],
      async () => feedPending,
      undefined,
      async (run) => {
        const result = await jobs.enqueueJob({
          id: run.id,
          kind: "post_agent",
          ownerScope: "system",
          payload: { runId: run.id },
          maxAttempts: 2,
        });
        if (!result.job) throw new Error("Could not enqueue fixture Post Agent run");
      },
    );
    const worker = new DurableQueueWorker(
      jobs,
      {
        research: async () => ({}),
        post_agent: async (job, context) => {
          const run = await agent.runQueued(
            String(job.payload.runId),
            context.signal,
            context.reportProgress,
          );
          if (!run) throw new Error("Post Agent run was not persisted");
          return { runId: run.id, runStatus: run.status };
        },
      },
      { pollIntervalMs: 100, leaseSeconds: 5, workerIdPrefix: "content-agent-cancel-test" },
    );

    try {
      worker.start();
      const queuedRun = await agent.trigger();
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        (await store.getRun(queuedRun.id))?.status !== "DISCOVERING"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await store.getRun(queuedRun.id))?.status).toBe("DISCOVERING");
      expect(await jobs.cancelJob(queuedRun.id, undefined, true)).toMatchObject({
        status: "cancel_requested",
      });
      releaseFeed([]);

      const job = await waitForJob(jobs, queuedRun.id);
      expect(job.status).toBe("cancelled");
      expect((await store.getRun(queuedRun.id))?.status).toBe("CANCELLED");
    } finally {
      releaseFeed?.([]);
      await worker.stop();
      store.close();
    }
  });

  it("durably enqueues a retry with the original topic and retry provenance", async () => {
    const store = makeStore();
    const jobs = new InMemoryDurableJobStore();
    const candidate = topic();
    await store.saveTopic(candidate);
    const agent = new ContentAgent(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      [],
      async () => [],
      undefined,
      async (run) => {
        const result = await jobs.enqueueJob({
          id: run.id,
          kind: "post_agent",
          ownerScope: "system",
          payload: { runId: run.id },
          maxAttempts: 2,
        });
        if (!result.job) throw new Error("Could not enqueue fixture Post Agent run");
      },
    );

    try {
      const original = await agent.trigger(candidate.id);
      original.status = "FAILED";
      await store.saveRun(original);

      const retry = await agent.retry(original.id);
      const retryJob = await jobs.getJob(retry.id);

      expect(retry.status).toBe("QUEUED");
      expect(retry.topicId).toBe(candidate.id);
      expect(retry.retryOf).toBe(original.id);
      expect(retryJob).toMatchObject({
        id: retry.id,
        kind: "post_agent",
        status: "queued",
        payload: { runId: retry.id },
      });
    } finally {
      store.close();
    }
  });

  it("queues a scheduled discovery run at its interval and stops cleanly", async () => {
    const store = makeStore();
    const agent = new ContentAgent(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      ["empty-feed"],
      async () => [],
    );
    vi.useFakeTimers();
    try {
      agent.startScheduler({ enabled: true, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      const scheduledRuns = await store.listRuns();
      expect(scheduledRuns).toHaveLength(1);
      expect(scheduledRuns[0].trigger).toBe("schedule");

      agent.stopScheduler();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await store.listRuns()).toHaveLength(1);
    } finally {
      agent.stopScheduler();
      vi.useRealTimers();
      store.close();
    }
  });

  it("continues topic discovery when one feed fails and avoids near-duplicate topics", async () => {
    const store = makeStore();
    const now = new Date().toISOString();
    const result = await discoverTopics(store, ["bad-feed", "good-feed"], async (url) => {
      if (url === "bad-feed") throw new Error("HTTP 503");
      return [
        {
          title: "New React rendering research findings",
          url: "https://react.dev/blog/a",
          summary: "Documented findings ".repeat(20),
          publishedAt: now,
          provider: url,
        },
        {
          title: "New React rendering research findings",
          url: "https://example.org/same-story",
          summary: "Documented findings ".repeat(20),
          publishedAt: now,
          provider: url,
        },
      ];
    });
    expect(result.failures).toMatchObject([{ feed: "bad-feed", error: "HTTP 503" }]);
    expect(result.candidates).toHaveLength(1);
    store.close();
  });

  it("uses bounded trusted-domain search when every configured feed fails", async () => {
    const store = makeStore();
    const fallback = {
      search: vi.fn(async () => [
        {
          title: "GitHub announces a new research release",
          url: "https://github.blog/changelog/research-release",
          snippet: "Detailed research announcement with technical context. ".repeat(4),
          publishedAt: new Date().toISOString(),
          provider: "serper",
        },
      ]),
    };
    const result = await discoverTopics(
      store,
      ["unavailable-feed"],
      async () => {
        throw new Error("feed offline");
      },
      fallback,
    );
    expect(result.failures[0].error).toContain("feed offline");
    expect(result.candidates).toHaveLength(1);
    expect(fallback.search).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("uses trusted-domain search when feeds return only stale or unusable topics", async () => {
    const store = makeStore();
    const fallback = {
      search: vi.fn(async () => [
        {
          title: "GitHub announces a new research release",
          url: "https://github.blog/changelog/fresh-research-release",
          snippet: "Detailed research announcement with technical context. ".repeat(4),
          publishedAt: new Date().toISOString(),
          provider: "serper",
        },
      ]),
    };
    const result = await discoverTopics(
      store,
      ["stale-feed"],
      async () => [
        {
          title: "A stale announcement from an RSS feed",
          url: "https://example.com/old-announcement",
          summary: "Old news that should not suppress the independent discovery fallback.",
          publishedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          provider: "stale-feed",
        },
      ],
      fallback,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe("https://github.blog/changelog/fresh-research-release");
    expect(fallback.search).toHaveBeenCalledTimes(1);
    store.close();
  });
});

describe("saved topic discovery backlog", () => {
  it("returns timely unpublished candidates on later discovery runs", async () => {
    const store = makeStore();
    const saved = topic();
    saved.summary =
      "Official research measurements, reproducible benchmark methodology, implementation details and independent documented limitations for readers. ".repeat(
        2,
      );
    try {
      await store.saveTopic(saved);
      const result = await discoverTopics(store, ["empty-feed"], async () => []);
      expect(result.candidates.map((candidate) => candidate.id)).toContain(saved.id);
      saved.status = "PUBLISHED";
      await store.saveTopic(saved);
      expect((await discoverTopics(store, ["empty-feed"], async () => [])).candidates).toHaveLength(
        0,
      );
    } finally {
      store.close();
    }
  });
});
