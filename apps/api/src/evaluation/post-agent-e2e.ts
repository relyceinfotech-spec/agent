import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const PER_RESEARCH_TIMEOUT_MS = 120_000;
const MODEL_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MODEL_DECISIONS = 3;
const MAX_RESEARCH_STEPS = 8;
const POST_AGENT_MAX_ATTEMPTS = 1;
const RESEARCH_MAX_ATTEMPTS = 1;
const TEST_USER_ID = "post-agent-e2e-user";
const TEST_ACCESS_TOKEN = "post-agent-e2e-local-token";
const TEST_AUTH_HEADERS = { authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
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
    { createServer, app: moduleApp, getServerBackgroundServices },
    { createPostAgentLLMProviders, OpenRouterProvider },
    { ResilientSearchProvider, SerperProvider },
    { SqliteSessionStore },
    { QuotaPolicy },
  ] = await Promise.all([
    import("../server.js"),
    import("../llm.js"),
    import("../search.js"),
    import("../store.js"),
    import("../quota-policy.js"),
  ]);

  const llm = new OpenRouterProvider(MODEL_REQUEST_TIMEOUT_MS);
  const postAgentLLMProviders = createPostAgentLLMProviders();
  const search = new ResilientSearchProvider([{ name: "serper", provider: new SerperProvider() }]);
  const store = new SqliteSessionStore(":memory:");
  const quotaPolicy = new QuotaPolicy(
    JSON.stringify({
      "post-agent-e2e": {
        quotas: {
          research: { limit: 1, windowSeconds: 3600 },
          deep_research: { limit: 1, windowSeconds: 3600 },
          followup: { limit: 1, windowSeconds: 3600 },
        },
        features: { research: true, deepResearch: true, postFollowUps: true },
      },
    }),
    JSON.stringify({ [TEST_USER_ID]: "post-agent-e2e" }),
  );
  const server = await createServer({
    store,
    authVerifier: {
      verifyAccessToken: async (token) =>
        token === TEST_ACCESS_TOKEN ? { id: TEST_USER_ID } : undefined,
    },
    quotaPolicy,
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
    postAgentMaxAttempts: POST_AGENT_MAX_ATTEMPTS,
    researchMaxAttempts: RESEARCH_MAX_ATTEMPTS,
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
  getServerBackgroundServices(server).worker.start();
  const startedAt = performance.now();
  const failures: Array<{ stage: string; reason: string }> = [];
  let run: import("../content-domain.js").AutonomousRun | undefined;
  let research: import("../domain.js").ResearchSession | undefined;
  let followUpResearch: import("../domain.js").ResearchSession | undefined;
  let post: import("../content-domain.js").ResearchPost | undefined;
  let followUp: import("../content-domain.js").ResearchFollowUp | undefined;
  let discoverContainsPost = false;
  let detailVisible = false;
  let runDurationMs = 0;
  let followUpDurationMs = 0;
  let runId: string | undefined;
  let followUpId: string | undefined;
  let postJob: import("../jobs.js").DurableJob | undefined;
  let followUpJob: import("../jobs.js").DurableJob | undefined;
  let currentStage = "post_run_enqueue";

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
    const durableJobs = getServerBackgroundServices(server).jobStore;
    currentStage = "post_run_wait";
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
    currentStage = "post_run_api_readback";
    const runStatus = await server.inject({
      method: "GET",
      url: `/api/autonomous/runs/${run.id}`,
      headers: { authorization: `Bearer ${process.env.MAX_ADMIN_TOKEN}` },
    });
    if (runStatus.statusCode !== 200)
      throw new Error("Terminal run was not visible through its API route");
    const apiRun = runStatus.json() as import("../content-domain.js").AutonomousRun;
    if (apiRun.id !== run.id || apiRun.status !== run.status)
      throw new Error("Autonomous run API readback disagreed with persisted run state");
    if (run.researchId) {
      currentStage = "research_session_readback";
      research = await store.get(run.researchId);
      if (!research) throw new Error("Post Agent research session was not persisted");
    }
    currentStage = "post_job_readback";
    const jobDeadline = Date.now() + 10_000;
    while (Date.now() < jobDeadline) {
      postJob = await durableJobs.getJob(run.id);
      if (postJob && ["completed", "failed", "cancelled"].includes(postJob.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!postJob || postJob.status !== "completed")
      throw new Error(`Post Agent durable job ended in ${postJob?.status ?? "missing"}`);
    if (postJob.attempts !== 1 || postJob.maxAttempts !== POST_AGENT_MAX_ATTEMPTS)
      throw new Error("Post Agent live acceptance used more than one durable attempt");
    currentStage = "post_terminal_validation";
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
    const publishedForTopic = (await store.listPublishedPosts(100)).filter(
      (candidate) => candidate.topicId === run!.topicId,
    );
    if (publishedForTopic.length !== 1)
      throw new Error(
        `Expected one publication for the selected topic; found ${publishedForTopic.length}`,
      );
    if (!discoverContainsPost) throw new Error("Published post did not appear in Discover API");

    currentStage = "follow_up_enqueue";
    const followUpStart = performance.now();
    const question = `What are the most recent updates about ${post.title} in 2026?`;
    const asked = await server.inject({
      method: "POST",
      url: `/api/posts/${post.id}/ask`,
      headers: { ...TEST_AUTH_HEADERS, "idempotency-key": randomUUID() },
      payload: { question },
    });
    if (asked.statusCode !== 202)
      throw new Error(`Post follow-up returned HTTP ${asked.statusCode}`);
    const queuedFollowUp = asked.json() as { id: string };
    followUpId = queuedFollowUp.id;
    currentStage = "follow_up_wait";
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
    currentStage = "follow_up_job_readback";
    const followUpJobDeadline = Date.now() + 10_000;
    while (Date.now() < followUpJobDeadline) {
      followUpJob = await durableJobs.getJob(queuedFollowUp.id);
      if (followUpJob && ["completed", "failed", "cancelled"].includes(followUpJob.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!followUpJob || followUpJob.status !== "completed")
      throw new Error(`Follow-up durable job ended in ${followUpJob?.status ?? "missing"}`);
    if (followUpJob.attempts !== 1 || followUpJob.maxAttempts !== RESEARCH_MAX_ATTEMPTS)
      throw new Error("Post follow-up acceptance used more than one durable attempt");
    if (!followUp.usedLiveResearch || !followUp.liveResearchId) {
      throw new Error("Follow-up answered from saved evidence without continuing live research");
    }
    const liveResult = await server.inject({
      method: "GET",
      url: `/api/research/${followUp.liveResearchId}`,
      headers: TEST_AUTH_HEADERS,
    });
    if (liveResult.statusCode !== 200)
      throw new Error("Follow-up live research session was not retrievable");
    followUpResearch = liveResult.json() as import("../domain.js").ResearchSession;
    if (!followUpResearch.searchAttempts?.some((attempt) => attempt.status === "success")) {
      throw new Error("Follow-up did not complete a successful live search");
    }
    currentStage = "follow_up_api_readback";
    const followUpStatus = await server.inject({
      method: "GET",
      url: `/api/posts/${post.id}/ask/${followUp.id}`,
      headers: TEST_AUTH_HEADERS,
    });
    if (followUpStatus.statusCode !== 200)
      throw new Error("Completed follow-up was not visible through its API route");
  } catch (error) {
    failures.push({
      stage:
        run?.events
          .slice()
          .reverse()
          .find((event) => event.status === "failed")?.stage ?? currentStage,
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
      postAgentMaxAttempts: POST_AGENT_MAX_ATTEMPTS,
      followUpMaxAttempts: RESEARCH_MAX_ATTEMPTS,
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
            retrievalMethod: source.retrievalMethod,
            retrievalAttempts: source.retrievalAttempts,
            retrievalReasons: source.retrievalReasons,
            contentOrigin: source.contentOrigin,
            hasContent: Boolean(source.content),
            contentLength: source.content?.length ?? 0,
            fetchError: source.fetchError,
            fetchFailureCategory: source.fetchFailureCategory,
            quality: source.quality,
          })),
          claims: research.claims.map((claim) => ({
            text: claim.text,
            evidence: claim.evidence,
            sourceIds: claim.sourceIds,
            verdict: claim.verification?.verdict,
            verificationRationale: claim.verification?.rationale,
            latestnessDisposition: claim.latestnessDisposition,
          })),
          citationValidation: postAgentLLMProviders.research.metrics.citationEntailment,
          synthesis: postAgentLLMProviders.research.metrics.synthesis,
          conflicts: research.conflicts ?? [],
        }
      : undefined,
    publication: {
      postId: post?.id,
      title: post?.title,
      findingCount: post?.findings.length,
      findings: post?.findings,
      claimCount: post?.claims.length,
      claimIds: post?.claims.map((claim) => claim.id),
      sourceCount: post?.sources.length,
      sourceIds: post?.sources.map((source) => source.id),
      discoverContainsPost,
      detailVisible,
      uniquePublicationCountForTopic: post?.topicId
        ? (await store.listPublishedPosts(100)).filter(
            (candidate) => candidate.topicId === post!.topicId,
          ).length
        : 0,
    },
    followUp: {
      status: followUp?.status,
      usedLiveResearch: followUp?.usedLiveResearch,
      liveResearchId: followUp?.liveResearchId,
      answer: followUp?.answer,
      sourceIds: followUp?.sourceIds ?? [],
      sources: followUp?.sources?.map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
      })),
      research: followUpResearch
        ? {
            id: followUpResearch.id,
            status: followUpResearch.status,
            searchAttempts: followUpResearch.searchAttempts ?? [],
            sources: followUpResearch.sources.map((source) => ({
              title: source.title,
              url: source.url,
              retrievalMethod: source.retrievalMethod,
              fetchError: source.fetchError,
            })),
            claims: followUpResearch.claims.map((claim) => ({
              text: claim.text,
              evidence: claim.evidence,
              sourceIds: claim.sourceIds,
              verdict: claim.verification?.verdict,
            })),
          }
        : undefined,
      durationMs: followUpDurationMs,
    },
    durableJobs: {
      postAgent: postJob
        ? {
            status: postJob.status,
            attempts: postJob.attempts,
            maxAttempts: postJob.maxAttempts,
            result: postJob.result,
            errorSummary: postJob.errorSummary,
          }
        : undefined,
      followUp: followUpJob
        ? {
            status: followUpJob.status,
            attempts: followUpJob.attempts,
            maxAttempts: followUpJob.maxAttempts,
            result: followUpJob.result,
            errorSummary: followUpJob.errorSummary,
          }
        : undefined,
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
