import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { QuotaPolicy } from "../quota-policy.js";

const QUESTION = "What's the latest React version?";
const TIMEOUT_MS = 45_000;
const TEST_USER_ID = "citation-product-e2e-user";
const TEST_ACCESS_TOKEN = "citation-product-e2e-local-token";
const TEST_AUTH_HEADERS = { authorization: `Bearer ${TEST_ACCESS_TOKEN}` };

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

async function main() {
  if (!process.env.SERPER_API_KEY) {
    throw new Error("citation-product-e2e requires SERPER_API_KEY in .env");
  }
  process.env.NODE_ENV = "test";

  const [
    { createServer, getServerBackgroundServices, app: moduleApp },
    { OpenRouterProvider },
    { ResilientSearchProvider, SerperProvider },
    { SqliteSessionStore },
  ] = await Promise.all([
    import("../server.js"),
    import("../llm.js"),
    import("../search.js"),
    import("../store.js"),
  ]);

  class NoNetworkModel extends OpenRouterProvider {
    override get enabled() {
      return false;
    }
  }

  const store = new SqliteSessionStore(":memory:");
  const llm = new NoNetworkModel();
  const search = new ResilientSearchProvider([{ name: "serper", provider: new SerperProvider() }]);
  const quotaPolicy = new QuotaPolicy(
    JSON.stringify({
      "citation-product-e2e": {
        quotas: {
          research: { limit: 1, windowSeconds: 3600 },
          deep_research: { limit: 1, windowSeconds: 3600 },
          followup: { limit: 1, windowSeconds: 3600 },
        },
        features: { research: true, deepResearch: true, postFollowUps: true },
      },
    }),
    JSON.stringify({ [TEST_USER_ID]: "citation-product-e2e" }),
  );
  const app = await createServer({
    store,
    authVerifier: {
      verifyAccessToken: async (token) =>
        token === TEST_ACCESS_TOKEN ? { id: TEST_USER_ID } : undefined,
    },
    quotaPolicy,
    searchProvider: search,
    llmProvider: llm,
    researchBudget: {
      maxSteps: 4,
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxSearchPasses: 1,
      maxClaimsToVerify: 2,
      maxTimeMs: TIMEOUT_MS,
      maxModelDecisions: 1,
    },
    fastLookupLimits: {
      maxQueries: 1,
      maxSources: 1,
      maxPages: 1,
      maxTimeMs: TIMEOUT_MS,
    },
  });

  const startedAt = performance.now();
  const failures: string[] = [];
  let durableJobStatus: string | undefined;
  let durableJobAttempts: number | undefined;
  let chat:
    | {
        route?: string;
        answer?: string;
        durationMs?: number;
        session?: import("../domain.js").ResearchSession;
      }
    | undefined;
  let followUp: import("../content-domain.js").ResearchFollowUp | undefined;
  let chatEntailment: import("../citation-entailment.js").CitationEntailmentReport | undefined;
  let followUpEntailment: import("../citation-entailment.js").CitationEntailmentReport | undefined;
  let followUpDurationMs = 0;

  try {
    const background = getServerBackgroundServices(app);
    background.worker.start();
    llm.setDeadline(Date.now() + TIMEOUT_MS);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: TEST_AUTH_HEADERS,
      payload: { message: QUESTION, deepResearch: false },
    });
    if (response.statusCode !== 202) throw new Error(`/api/chat returned ${response.statusCode}`);
    const enqueue = response.json() as { route?: string; researchId?: string; jobId?: string };
    if (!enqueue.researchId || !enqueue.jobId) {
      throw new Error("/api/chat did not return a durable research job identity");
    }
    const researchId = enqueue.researchId;
    const jobId = enqueue.jobId;
    const researchDeadline = Date.now() + TIMEOUT_MS;
    let polledSession: import("../domain.js").ResearchSession | undefined;
    while (Date.now() < researchDeadline) {
      const result = await app.inject({
        method: "GET",
        url: `/api/research/${researchId}`,
        headers: TEST_AUTH_HEADERS,
      });
      if (result.statusCode !== 200) {
        throw new Error(`Research polling returned ${result.statusCode}`);
      }
      polledSession = result.json() as import("../domain.js").ResearchSession;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(polledSession.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    const durableJob = await background.jobStore.getJob(jobId);
    durableJobStatus = durableJob?.status;
    durableJobAttempts = durableJob?.attempts;
    chat = { route: enqueue.route, session: polledSession };
    if (polledSession?.status !== "COMPLETED") {
      throw new Error(
        `Durable research job did not complete: ${polledSession?.error ?? polledSession?.status ?? "deadline exceeded"}`,
      );
    }
    const session = chat?.session;
    if (!session || session.status !== "COMPLETED") {
      throw new Error(
        `Chat did not complete: ${session?.error ?? session?.status ?? "no session"}`,
      );
    }
    if (!session.answer || !/\[\d+\]/.test(session.answer)) {
      throw new Error("Chat did not return a cited answer");
    }
    if (!session.searchAttempts?.some((attempt) => attempt.provider === "serper")) {
      throw new Error("The chat did not perform a recorded Serper search");
    }
    if (!session.sources.some((source) => source.content?.trim())) {
      throw new Error("The chat did not fetch and extract source content");
    }
    chatEntailment = llm.metrics.citationEntailment;
    if (!chatEntailment || chatEntailment.status !== "VALIDATED") {
      throw new Error("The cited chat answer did not pass local semantic citation validation");
    }
    const supported = chatEntailment.items.find(
      (item) => item.isFactual && item.verdict === "SUPPORTED" && item.sourceIds.length > 0,
    );
    if (!supported) throw new Error("No factual answer claim was supported by fetched source data");

    const source = session.sources.find((candidate) => candidate.id === supported.sourceIds[0]);
    if (!source) throw new Error("The supported citation did not map to a fetched source");
    const claim = {
      id: randomUUID().slice(0, 8),
      text: supported.text,
      sourceIds: [source.id],
      evidence: source.content ?? "",
      confidence: 1,
      verification: { verdict: "supported" as const, rationale: supported.rationale },
    };
    const now = new Date().toISOString();
    const topicId = randomUUID();
    const postId = randomUUID();
    await store.saveTopic({
      id: topicId,
      title: "Bounded live citation E2E",
      url: source.url,
      summary: supported.text,
      provider: "serper",
      discoveredAt: now,
      score: 1,
      status: "RESEARCHED",
    });
    await store.savePost({
      id: postId,
      topicId,
      researchId: session.id,
      title: "Bounded live citation E2E",
      summary: session.answer,
      whyItMatters: "Exercises a cited follow-up from the real chat result.",
      findings: [{ claimId: claim.id, text: claim.text, sourceIds: claim.sourceIds }],
      caveats: [],
      sources: session.sources,
      claims: [claim],
      publishedAt: now,
      researchedAt: now,
      category: "citation-quality-e2e",
    });

    llm.setDeadline(Date.now() + TIMEOUT_MS);
    const followUpStarted = performance.now();
    const ask = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/ask`,
      headers: TEST_AUTH_HEADERS,
      payload: { question: "Which source supports the React version finding?" },
    });
    if (ask.statusCode !== 202) throw new Error(`/api/posts/:id/ask returned ${ask.statusCode}`);
    const queued = ask.json() as { id: string };
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await app.inject({
        method: "GET",
        url: `/api/posts/${postId}/ask/${queued.id}`,
        headers: TEST_AUTH_HEADERS,
      });
      if (result.statusCode !== 200)
        throw new Error(`Follow-up polling returned ${result.statusCode}`);
      const current = result.json() as import("../content-domain.js").ResearchFollowUp;
      if (["COMPLETED", "FAILED"].includes(current.status)) {
        followUp = current;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    followUpDurationMs = Math.round(performance.now() - followUpStarted);
    if (!followUp || followUp.status !== "COMPLETED") {
      throw new Error(`Follow-up did not complete: ${followUp?.error ?? "deadline exceeded"}`);
    }
    if (!followUp.answer || !/\[\d+\]/.test(followUp.answer)) {
      throw new Error("Follow-up did not preserve a source citation");
    }
    followUpEntailment = llm.metrics.citationEntailment;
    if (followUpEntailment?.status !== "VALIDATED") {
      throw new Error("Follow-up did not pass local semantic citation validation");
    }
  } catch (error) {
    failures.push(message(error));
  } finally {
    await app.close();
    await moduleApp.close();
  }

  const session = chat?.session;
  const report = {
    question: QUESTION,
    searchProvider: "Serper (one-query ceiling)",
    model: "none (no OpenRouter requests; structured React registry fast path)",
    limits: { maxQueries: 1, maxSources: 1, maxPages: 1, timeoutMs: TIMEOUT_MS },
    chat: {
      route: chat?.route,
      status: session?.status,
      durableJobStatus,
      durableJobAttempts,
      answer: session?.answer,
      durationMs: chat?.durationMs,
      searchAttempts: session?.searchAttempts ?? [],
      steps: session?.steps.map((step) => step.label) ?? [],
      sources:
        session?.sources.map((source) => ({
          title: source.title,
          url: source.url,
          hasExtractedContent: Boolean(source.content?.trim()),
        })) ?? [],
      citationEntailment: chatEntailment,
    },
    followUp: {
      status: followUp?.status,
      answer: followUp?.answer,
      sourceIds: followUp?.sourceIds ?? [],
      durationMs: followUpDurationMs,
      citationEntailment: followUpEntailment,
    },
    modelUsage: { calls: llm.metrics.calls, tokens: llm.metrics.usage.totalTokens ?? 0, cost: 0 },
    totalDurationMs: Math.round(performance.now() - startedAt),
    failures,
  };

  const outputDirectory = resolve("evaluation-results");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "citation-product-e2e-report.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath: outputPath }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(`Bounded citation product E2E failed to start: ${message(error)}`);
  process.exitCode = 1;
});
