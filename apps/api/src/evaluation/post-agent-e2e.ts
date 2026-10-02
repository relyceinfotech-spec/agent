import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const PER_RESEARCH_TIMEOUT_MS = 120_000;
const MODEL_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MODEL_DECISIONS = 3;
const MAX_RESEARCH_STEPS = 12;
const QUESTION = "Discover one fresh GitHub blog topic, then research and publish it.";

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 260) : String(error).slice(0, 260);
}

function isActiveRunStatus(status: string | undefined): boolean {
  return Boolean(
    status && ["QUEUED", "DISCOVERING", "RESEARCHING", "QUALITY_GATE"].includes(status),
  );
}

async function main() {
  if (!process.env.SERPER_API_KEY || !process.env.OPENROUTER_API_KEY) {
    throw new Error("post-agent-e2e requires SERPER_API_KEY and OPENROUTER_API_KEY in .env");
  }

  // Isolate the real run from the user's persistent DB and scheduler. Keep discovery bounded to
  // one RSS feed and, if needed, one trusted-domain Serper fallback query.
  process.env.NODE_ENV = "test";
  process.env.AUTONOMOUS_SCHEDULER_ENABLED = "false";
  process.env.MAX_ADMIN_TOKEN = randomUUID();
  process.env.MAX_TOPIC_FEEDS = "https://github.blog/feed/";
  process.env.MAX_TOPIC_ALLOWED_DOMAINS = "github.blog";
  process.env.MAX_TOPIC_MAX_AGE_DAYS = "14";
  process.env.MAX_RESEARCH_STEPS = String(MAX_RESEARCH_STEPS);
  process.env.MAX_SEARCH_QUERIES = "2";
  process.env.MAX_SOURCES = "4";
  process.env.MAX_PAGES = "3";
  process.env.MAX_RESEARCH_TIME_MS = String(PER_RESEARCH_TIMEOUT_MS);
  process.env.MAX_MODEL_DECISIONS = String(MAX_MODEL_DECISIONS);
  process.env.OPENROUTER_TIMEOUT_MS = String(MODEL_REQUEST_TIMEOUT_MS);
  process.env.POST_AGENT_MODEL_TIMEOUT_MS = String(MODEL_REQUEST_TIMEOUT_MS);

  const [
    { createServer, app: moduleApp },
    { createPostAgentLLMProviders, OpenRouterProvider },
    { ResilientSearchProvider, SerperProvider },
    { SqliteSessionStore },
  ] = await Promise.all([
    import("../server.js"),
    import("../llm.js"),
    import("../search.js"),
    import("../store.js"),
  ]);

  const llm = new OpenRouterProvider(MODEL_REQUEST_TIMEOUT_MS);
  const postAgentLLMProviders = createPostAgentLLMProviders();
  const search = new ResilientSearchProvider([{ name: "serper", provider: new SerperProvider() }]);
  const store = new SqliteSessionStore(":memory:");
  const server = await createServer({
    store,
    searchProvider: search,
    llmProvider: llm,
    postAgentLLMProviders,
    postAgentResearchBudget: {
      maxSteps: MAX_RESEARCH_STEPS,
      maxQueries: 2,
      maxSources: 4,
      maxPages: 3,
      maxSearchPasses: 2,
      maxClaimsToVerify: 4,
      maxTimeMs: PER_RESEARCH_TIMEOUT_MS,
      maxModelDecisions: MAX_MODEL_DECISIONS,
    },
    researchBudget: {
      maxSteps: MAX_RESEARCH_STEPS,
      maxQueries: 2,
      maxSources: 4,
      maxPages: 3,
      maxSearchPasses: 1,
      maxClaimsToVerify: 4,
      maxTimeMs: PER_RESEARCH_TIMEOUT_MS,
      maxModelDecisions: MAX_MODEL_DECISIONS,
    },
  });
  const startedAt = performance.now();
  const failures: Array<{ stage: string; reason: string }> = [];
  let run: import("../content-domain.js").AutonomousRun | undefined;
  let research: import("../domain.js").ResearchSession | undefined;
  let post: import("../content-domain.js").ResearchPost | undefined;
  let followUp: import("../content-domain.js").ResearchFollowUp | undefined;
  let discoverContainsPost = false;
  let detailVisible = false;
  let runDurationMs = 0;
  let followUpDurationMs = 0;
  let runId: string | undefined;
  let followUpId: string | undefined;

  try {
    const runStart = performance.now();
    const queued = await server.inject({
      method: "POST",
      url: "/api/autonomous/runs",
      headers: { authorization: `Bearer ${process.env.MAX_ADMIN_TOKEN}` },
      payload: {},
    });
    if (queued.statusCode !== 202) {
      throw new Error(`POST /api/autonomous/runs returned HTTP ${queued.statusCode}`);
    }
    const queuedRun = queued.json() as { id: string };
    runId = queuedRun.id;
    const runDeadline = Date.now() + PER_RESEARCH_TIMEOUT_MS + 35_000;
    while (Date.now() < runDeadline) {
      run = await store.getRun(queuedRun.id);
      if (
        run &&
        ["PUBLISHED", "FAILED", "REJECTED", "REQUIRES_REVIEW", "CANCELLED"].includes(run.status)
      ) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    }
    runDurationMs = Math.round(performance.now() - runStart);
    if (
      !run ||
      !["PUBLISHED", "FAILED", "REJECTED", "REQUIRES_REVIEW", "CANCELLED"].includes(run.status)
    ) {
      await server.inject({
        method: "POST",
        url: `/api/autonomous/runs/${queuedRun.id}/cancel`,
        headers: { authorization: `Bearer ${process.env.MAX_ADMIN_TOKEN}` },
      });
      const cancelDeadline = Date.now() + 10_000;
      while (Date.now() < cancelDeadline) {
        run = await store.getRun(queuedRun.id);
        if (run && ["CANCELLED", "FAILED", "REQUIRES_REVIEW"].includes(run.status)) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      throw new Error("Post run exceeded the 155-second controller/evaluator deadline");
    }
    const runStatus = await server.inject({
      method: "GET",
      url: `/api/autonomous/runs/${run.id}`,
    });
    if (runStatus.statusCode !== 200)
      throw new Error("Terminal run was not visible through its API route");
    if (run.researchId) {
      const result = await server.inject({ method: "GET", url: `/api/research/${run.researchId}` });
      if (result.statusCode === 200) research = result.json() as typeof research;
    }
    if (run.status !== "PUBLISHED" || !run.postId) {
      throw new Error(`Post run ended in ${run.status}: ${run.error ?? "no publication"}`);
    }

    const discover = await server.inject({ method: "GET", url: "/api/discover" });
    if (discover.statusCode !== 200)
      throw new Error(`/api/discover returned ${discover.statusCode}`);
    discoverContainsPost = (discover.json() as Array<{ id: string }>).some(
      (candidate) => candidate.id === run!.postId,
    );
    const detail = await server.inject({ method: "GET", url: `/api/posts/${run.postId}` });
    if (detail.statusCode !== 200) throw new Error(`/api/posts/:id returned ${detail.statusCode}`);
    post = detail.json() as import("../content-domain.js").ResearchPost;
    detailVisible = true;
    if (!discoverContainsPost) throw new Error("Published post did not appear in Discover API");

    const followUpStart = performance.now();
    const question = `What are the most recent updates about ${post.title} in 2026?`;
    const asked = await server.inject({
      method: "POST",
      url: `/api/posts/${post.id}/ask`,
      payload: { question },
    });
    if (asked.statusCode !== 202)
      throw new Error(`Post follow-up returned HTTP ${asked.statusCode}`);
    const queuedFollowUp = asked.json() as { id: string };
    followUpId = queuedFollowUp.id;
    const followUpDeadline = Date.now() + PER_RESEARCH_TIMEOUT_MS + 35_000;
    while (Date.now() < followUpDeadline) {
      followUp = await store.getFollowUp(queuedFollowUp.id);
      if (followUp && ["COMPLETED", "FAILED"].includes(followUp.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    }
    followUpDurationMs = Math.round(performance.now() - followUpStart);
    if (followUp?.status !== "COMPLETED") {
      throw new Error(
        `Post follow-up ended in ${followUp?.status ?? "timeout"}: ${followUp?.error ?? "no detail"}`,
      );
    }
    if (!followUp.usedLiveResearch || !followUp.liveResearchId) {
      throw new Error("Follow-up answered from saved evidence without continuing live research");
    }
    const liveResult = await server.inject({
      method: "GET",
      url: `/api/research/${followUp.liveResearchId}`,
    });
    if (liveResult.statusCode !== 200)
      throw new Error("Follow-up live research session was not retrievable");
    const liveSession = liveResult.json() as import("../domain.js").ResearchSession;
    if (!liveSession.searchAttempts?.some((attempt) => attempt.status === "success")) {
      throw new Error("Follow-up did not complete a successful live search");
    }
    const followUpStatus = await server.inject({
      method: "GET",
      url: `/api/posts/${post.id}/ask/${followUp.id}`,
    });
    if (followUpStatus.statusCode !== 200)
      throw new Error("Completed follow-up was not visible through its API route");
  } catch (error) {
    failures.push({
      stage: run?.status === "PUBLISHED" ? "post_follow_up" : "post_run",
      reason: message(error),
    });
  } finally {
    const activeRun = runId ? await store.getRun(runId) : undefined;
    if (isActiveRunStatus(activeRun?.status)) {
      await server.inject({
        method: "POST",
        url: `/api/autonomous/runs/${activeRun!.id}/cancel`,
        headers: { authorization: `Bearer ${process.env.MAX_ADMIN_TOKEN}` },
      });
    }
    const activeFollowUp = followUpId ? await store.getFollowUp(followUpId) : undefined;
    if (
      activeFollowUp?.liveResearchId &&
      ["QUEUED", "RESEARCHING", "SYNTHESIZING"].includes(activeFollowUp.status)
    ) {
      await server.inject({
        method: "POST",
        url: `/api/research/${activeFollowUp.liveResearchId}/cancel`,
      });
    }
    const settleDeadline = Date.now() + 15_000;
    while (Date.now() < settleDeadline) {
      const currentRun = runId ? await store.getRun(runId) : undefined;
      const currentFollowUp = followUpId ? await store.getFollowUp(followUpId) : undefined;
      const runActive = isActiveRunStatus(currentRun?.status);
      const followUpActive = Boolean(
        currentFollowUp &&
        ["QUEUED", "RESEARCHING", "SYNTHESIZING"].includes(currentFollowUp.status),
      );
      if (!runActive && !followUpActive) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    await server.close();
    await moduleApp.close();
  }

  const report = {
    question: QUESTION,
    discovery: {
      feed: "github.blog RSS",
      fallbackDomain: "github.blog",
      candidateId: run?.topicId,
    },
    hardLimits: {
      feedCount: 1,
      fallbackSearchDomains: 1,
      stepsPerResearch: MAX_RESEARCH_STEPS,
      queriesPerResearch: 2,
      sourcesPerResearch: 4,
      pagesPerResearch: 3,
      researchTimeoutMs: PER_RESEARCH_TIMEOUT_MS,
      openRouterRequestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      maxModelDecisionsPerResearch: MAX_MODEL_DECISIONS,
      schedulerEnabled: false,
      persistence: "isolated in-memory SQLite",
    },
    run: {
      id: run?.id,
      status: run?.status,
      durationMs: runDurationMs,
      events: run?.events ?? [],
      error: run?.error,
    },
    research: research
      ? {
          id: research.id,
          status: research.status,
          answer: research.answer,
          plan: research.plan,
          steps: research.steps,
          decisions: research.decisions,
          searchAttempts: research.searchAttempts ?? [],
          sources: research.sources.map((source) => ({
            title: source.title,
            url: source.url,
            domain: source.domain,
            hasContent: Boolean(source.content),
            fetchError: source.fetchError,
            fetchFailureCategory: source.fetchFailureCategory,
            quality: source.quality,
          })),
          claims: research.claims.map((claim) => ({
            text: claim.text,
            sourceIds: claim.sourceIds,
            verdict: claim.verification?.verdict,
          })),
          conflicts: research.conflicts ?? [],
        }
      : undefined,
    publication: {
      postId: post?.id,
      title: post?.title,
      findingCount: post?.findings.length,
      discoverContainsPost,
      detailVisible,
    },
    followUp: {
      status: followUp?.status,
      usedLiveResearch: followUp?.usedLiveResearch,
      liveResearchId: followUp?.liveResearchId,
      answer: followUp?.answer,
      sourceIds: followUp?.sourceIds ?? [],
      durationMs: followUpDurationMs,
    },
    model: process.env.OPENROUTER_MODEL,
    llm: llm.metrics,
    modelRoles: Object.fromEntries(
      Object.entries(postAgentLLMProviders).map(([role, provider]) => [
        role,
        {
          configuredModel: provider.model,
          configuredFallbackModel: provider.fallbackModel ?? null,
          fallbackAttempted: provider.metrics.records.some((record) => record.fallbackUsed),
          metrics: provider.metrics,
        },
      ]),
    ),
    failureClassification: {
      discoveryFailureCategory: run?.events.some(
        (event) =>
          event.status === "failed" && /fetch failed|network|ECONN|ENOTFOUND/i.test(event.detail),
      )
        ? "NETWORK_ERROR"
        : undefined,
      discoveryFallbackRoutesAttempted:
        run?.events.filter(
          (event) => event.stage.startsWith("feed") || event.stage.startsWith("topic_search:"),
        ).length ?? 0,
      openRouterTimeouts: [
        ...llm.metrics.records,
        ...Object.values(postAgentLLMProviders).flatMap((provider) => provider.metrics.records),
      ].filter((record) => /timed out|timeout/i.test(record.error ?? "")).length,
      modelRoleFailures: Object.entries(postAgentLLMProviders).flatMap(([role, provider]) =>
        provider.metrics.records
          .filter((record) => Boolean(record.error))
          .map((record) => ({
            role,
            model: record.model,
            attempt: record.attempt,
            fallbackUsed: record.fallbackUsed,
            category: record.failureCategory,
            reason: record.error,
          })),
      ),
      sourceFetchFailures:
        research?.sources.filter((source) => Boolean(source.fetchError)).length ?? 0,
      qualityGate: run?.events.find(
        (event) => event.stage === "quality_gate" && event.status === "failed",
      )?.detail,
    },
    totalDurationMs: Math.round(performance.now() - startedAt),
    failures,
  };

  const reportDirectory = resolve("evaluation-results");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "post-agent-production-e2e-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(`Bounded Post Agent E2E failed to start: ${message(error)}`);
  process.exitCode = 1;
});
