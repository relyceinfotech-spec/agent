import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AutonomousRun, AutonomousRunStatus, TopicCandidate } from "./content-domain.js";
import type { SearchResult, ResearchSession } from "./domain.js";
import { evaluatePostQuality, postFromResearch } from "./post-quality.js";
import type { ResearchRunner } from "./research.js";
import type { ContentStore, SessionStore } from "./store.js";
import { discoverTopics, fetchTopicFeed } from "./topic-discovery.js";
import type { FeedEntry } from "./topic-discovery.js";
import type { SearchProvider } from "./search.js";

type ResearchController = Pick<ResearchRunner, "start" | "cancel">;
type PlatformStore = SessionStore & ContentStore;

export class ContentAgent {
  private activeRunId?: string;
  private readonly queue: string[] = [];
  private readonly requestedTopics = new Map<string, string | undefined>();
  private readonly cancelled = new Set<string>();
  private readonly activeSignals = new Map<string, AbortSignal>();
  private readonly progressReporters = new Map<
    string,
    (progress: Record<string, string | number | boolean | null>) => Promise<boolean>
  >();
  private scheduler?: ReturnType<typeof setInterval>;
  private schedulerTickInFlight = false;

  constructor(
    private readonly store: PlatformStore,
    private readonly research: ResearchController,
    private readonly feedUrls = config.MAX_TOPIC_FEEDS.split(",")
      .map((feed) => feed.trim())
      .filter(Boolean),
    private readonly fetchFeed: (url: string) => Promise<FeedEntry[]> = fetchTopicFeed,
    private readonly fallbackSearch?: SearchProvider,
    private readonly enqueueDurableRun?: (run: AutonomousRun) => Promise<void>,
    private readonly hasActiveDurableRun?: () => Promise<boolean>,
  ) {}

  async trigger(topicId?: string, trigger: AutonomousRun["trigger"] = "manual", retryOf?: string) {
    if (topicId && !(await this.store.getTopic(topicId))) throw new Error("Topic not found");
    const now = new Date().toISOString();
    const run: AutonomousRun = {
      id: randomUUID(),
      trigger,
      status: "QUEUED",
      createdAt: now,
      updatedAt: now,
      topicId,
      retryOf,
      events: [{ at: now, stage: "queue", status: "started", detail: "Run queued" }],
    };
    await this.store.saveRun(run);
    if (this.enqueueDurableRun) {
      try {
        await this.enqueueDurableRun(run);
      } catch (error) {
        run.error = "Could not persist the autonomous job in the durable queue";
        await this.setStatus(run, "FAILED", run.error);
        throw error;
      }
      return run;
    }
    this.requestedTopics.set(run.id, topicId);
    this.queue.push(run.id);
    void this.drain();
    return run;
  }

  async retry(id: string) {
    const old = await this.store.getRun(id);
    if (!old) throw new Error("Autonomous run not found");
    if (!["FAILED", "REQUIRES_REVIEW", "REJECTED", "CANCELLED"].includes(old.status)) {
      throw new Error("Only finished unsuccessful runs can be retried");
    }
    let retries = 0;
    let current: AutonomousRun | undefined = old;
    while (current?.retryOf) {
      retries += 1;
      current = await this.store.getRun(current.retryOf);
    }
    if (retries >= 2) throw new Error("Autonomous retry limit reached");
    return this.trigger(old.topicId, "retry", old.id);
  }

  async cancel(id: string) {
    const run = await this.store.getRun(id);
    if (!run) return undefined;
    if (["PUBLISHED", "FAILED", "REJECTED", "REQUIRES_REVIEW", "CANCELLED"].includes(run.status))
      return run;
    this.cancelled.add(id);
    if (run.researchId) await this.research.cancel(run.researchId);
    return this.setStatus(run, "CANCELLED", "Cancellation requested");
  }

  startScheduler(options: { enabled?: boolean; intervalMs?: number } = {}) {
    const enabled = options.enabled ?? config.AUTONOMOUS_SCHEDULER_ENABLED;
    const intervalMs = options.intervalMs ?? config.AUTONOMOUS_INTERVAL_MINUTES * 60_000;
    if (this.scheduler || !enabled) return;
    this.scheduler = setInterval(() => {
      if (this.schedulerTickInFlight || this.activeRunId || this.queue.length > 0) return;
      this.schedulerTickInFlight = true;
      void (async () => {
        try {
          if (await this.hasActiveDurableRun?.()) return;
          await this.trigger(undefined, "schedule");
        } catch {
          console.error("Autonomous scheduler failed to queue a run");
        } finally {
          this.schedulerTickInFlight = false;
        }
      })();
    }, intervalMs);
    this.scheduler.unref();
  }

  stopScheduler() {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  async resumeQueuedRuns(): Promise<number> {
    if (this.enqueueDurableRun) return 0;
    const queued = (await this.store.listRuns(500))
      .filter((run) => run.status === "QUEUED")
      .reverse();
    let resumed = 0;
    for (const run of queued) {
      if (run.id === this.activeRunId || this.queue.includes(run.id)) continue;
      this.requestedTopics.set(run.id, run.topicId);
      this.queue.push(run.id);
      resumed += 1;
    }
    if (resumed > 0) void this.drain();
    return resumed;
  }

  private async setStatus(run: AutonomousRun, status: AutonomousRunStatus, detail: string) {
    run.status = status;
    run.updatedAt = new Date().toISOString();
    run.events.push({
      at: run.updatedAt,
      stage: status.toLowerCase(),
      status: status === "FAILED" ? "failed" : "complete",
      detail,
    });
    await this.store.saveRun(run);
    const report = this.progressReporters.get(run.id);
    if (report) {
      const accepted = await report({
        stage: status.toLowerCase(),
        status,
        detail: detail.slice(0, 256),
        updatedAt: run.updatedAt,
      });
      if (!accepted) throw new Error("Autonomous job lease was lost");
    }
    return run;
  }

  async runQueued(
    id: string,
    signal: AbortSignal,
    reportProgress: (
      progress: Record<string, string | number | boolean | null>,
    ) => Promise<boolean>,
  ): Promise<AutonomousRun | undefined> {
    const run = await this.store.getRun(id);
    if (!run) throw new Error("Queued autonomous run was not found");
    if (["PUBLISHED", "REQUIRES_REVIEW", "REJECTED", "CANCELLED"].includes(run.status)) {
      return run;
    }
    this.activeRunId = id;
    this.activeSignals.set(id, signal);
    this.progressReporters.set(id, reportProgress);
    const cancelResearch = () => {
      if (
        signal.reason instanceof Error &&
        signal.reason.message === "Job cancellation requested"
      ) {
        this.cancelled.add(id);
        if (run.researchId) void this.research.cancel(run.researchId);
      }
    };
    if (signal.aborted) cancelResearch();
    else signal.addEventListener("abort", cancelResearch, { once: true });
    try {
      await this.execute(run, signal);
      return this.store.getRun(id);
    } finally {
      signal.removeEventListener("abort", cancelResearch);
      this.activeSignals.delete(id);
      this.progressReporters.delete(id);
      if (this.activeRunId === id) this.activeRunId = undefined;
      this.cancelled.delete(id);
    }
  }

  private async drain(): Promise<void> {
    if (this.activeRunId) return;
    const id = this.queue.shift();
    if (!id) return;
    this.activeRunId = id;
    try {
      const run = await this.store.getRun(id);
      if (run && !this.cancelled.has(id)) await this.execute(run);
    } finally {
      this.activeRunId = undefined;
      this.requestedTopics.delete(id);
      this.cancelled.delete(id);
      if (this.queue.length) void this.drain();
    }
  }

  private ensureActive(id: string) {
    if (this.cancelled.has(id)) throw new Error("Run cancelled");
    if (this.activeSignals.get(id)?.aborted) {
      throw this.activeSignals.get(id)?.reason ?? new Error("Worker shutdown requested");
    }
  }

  private async awaitResearch(id: string, researchId: string): Promise<ResearchSession> {
    const deadline = Date.now() + config.MAX_RESEARCH_TIME_MS + 30_000;
    while (Date.now() < deadline) {
      this.ensureActive(id);
      const session = await this.store.get(researchId);
      if (
        session &&
        ["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(session.status)
      ) {
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await this.research.cancel(researchId);
    throw new Error("Autonomous research timed out");
  }

  private async execute(run: AutonomousRun, signal?: AbortSignal): Promise<void> {
    try {
      let topic: TopicCandidate | undefined;
      const requested = this.requestedTopics.get(run.id) ?? run.topicId;
      if (requested) topic = await this.store.getTopic(requested);
      if (!topic) {
        await this.setStatus(run, "DISCOVERING", "Discovering novel, timely topics");
        const discovery = await discoverTopics(
          this.store,
          this.feedUrls,
          this.fetchFeed,
          this.fallbackSearch,
          signal,
        );
        run.events.push(
          ...discovery.failures.map((failure) => ({
            at: new Date().toISOString(),
            stage: "feed",
            status: "failed" as const,
            detail: `${failure.feed}: ${failure.error}`,
          })),
        );
        run.events.push(
          ...discovery.searchAttempts.map((attempt) => ({
            at: new Date().toISOString(),
            stage: `topic_search:${attempt.provider}`,
            status: attempt.status === "failed" ? ("failed" as const) : ("complete" as const),
            detail: `${attempt.status}: ${attempt.resultCount} results${attempt.error ? `; ${attempt.error}` : ""}`,
            durationMs: attempt.durationMs,
          })),
        );
        topic = discovery.candidates.find((candidate) => candidate.score >= 0.65);
        if (!topic) {
          const failedSearchAttempts = discovery.searchAttempts.filter(
            (attempt) => attempt.status === "failed",
          );
          const allDiscoveryRoutesFailed =
            discovery.successfulFeeds === 0 &&
            discovery.successfulSearches === 0 &&
            (discovery.failures.length > 0 || failedSearchAttempts.length > 0);
          if (allDiscoveryRoutesFailed) {
            const reasons = [
              ...discovery.failures.map((failure) => `${failure.feed}: ${failure.error}`),
              ...failedSearchAttempts.map(
                (attempt) =>
                  `${attempt.provider}: ${attempt.error ?? attempt.errorCode ?? "failed"}`,
              ),
            ];
            run.error = `All topic discovery routes failed: ${reasons.join("; ")}`;
            await this.setStatus(run, "FAILED", run.error);
          } else {
            await this.setStatus(
              run,
              "REJECTED",
              "No novel topic met the research-value threshold",
            );
          }
          return;
        }
      }
      this.ensureActive(run.id);
      if (
        topic.status === "PUBLISHED" ||
        (await this.store.listPosts(200)).some((post) => post.topicId === topic!.id)
      ) {
        await this.setStatus(
          run,
          "REJECTED",
          "Topic is already published; no research was started",
        );
        return;
      }
      topic.status = "SELECTED";
      await this.store.saveTopic(topic);
      run.topicId = topic.id;
      await this.setStatus(run, "RESEARCHING", `Researching ${topic.title}`);
      const seed: SearchResult = {
        title: topic.title,
        url: topic.url,
        snippet: topic.summary,
        publishedAt: topic.publishedAt,
        provider: "topic-feed",
        query: topic.title,
        discoveredAt: topic.discoveredAt,
      };
      const session = await this.research.start(topic.title, "deep", [seed], {
        allowSnippetEvidence: false,
        signal,
      });
      run.researchId = session.id;
      await this.store.saveRun(run);
      const completed = await this.awaitResearch(run.id, session.id);
      this.ensureActive(run.id);
      if (completed.status !== "COMPLETED") {
        run.error = `Research stage unavailable (${completed.status}): ${completed.error ?? "no verified result"}`;
        await this.setStatus(run, "REQUIRES_REVIEW", run.error);
        return;
      }
      topic.status = "RESEARCHED";
      await this.store.saveTopic(topic);
      await this.setStatus(
        run,
        "QUALITY_GATE",
        "Checking evidence, source diversity, freshness, and conflicts",
      );
      const quality = evaluatePostQuality(topic, completed, await this.store.listPosts(200));
      run.events.push({
        at: new Date().toISOString(),
        stage: "quality_gate",
        status: quality.status === "READY_TO_PUBLISH" ? "complete" : "failed",
        detail: `${quality.status}: ${quality.reasons.join("; ") || "all checks passed"}`,
      });
      if (quality.status !== "READY_TO_PUBLISH") {
        run.error = quality.reasons.join("; ");
        await this.setStatus(
          run,
          quality.status === "REJECTED" ? "REJECTED" : "REQUIRES_REVIEW",
          run.error,
        );
        return;
      }
      this.ensureActive(run.id);
      const post = postFromResearch(topic, completed);
      topic.status = "PUBLISHED";
      const publishedAt = new Date().toISOString();
      const publishedRun: AutonomousRun = {
        ...run,
        status: "PUBLISHED",
        postId: post.id,
        updatedAt: publishedAt,
        events: [
          ...run.events,
          {
            at: publishedAt,
            stage: "published",
            status: "complete",
            detail: `Published post ${post.id}`,
          },
        ],
      };
      await this.store.publishPost(post, topic, publishedRun);
      Object.assign(run, publishedRun);
    } catch (error) {
      if (
        this.cancelled.has(run.id) ||
        (signal?.aborted &&
          signal.reason instanceof Error &&
          signal.reason.message === "Job cancellation requested")
      ) {
        if (run.researchId) await this.research.cancel(run.researchId);
        await this.setStatus(run, "CANCELLED", "Cancellation requested");
        return;
      }
      run.error = error instanceof Error ? error.message : String(error);
      await this.setStatus(run, "FAILED", run.error);
    }
  }
}
