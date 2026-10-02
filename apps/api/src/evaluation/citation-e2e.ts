import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const RESEARCH_BUDGET = {
  maxSteps: 8,
  maxQueries: 2,
  maxSources: 2,
  maxPages: 2,
  maxClaimsToVerify: 2,
  maxTimeMs: 150_000,
  maxModelDecisions: 2,
  maxSearchPasses: 1,
};
const MODEL_REQUEST_TIMEOUT_MS = 22_000;
const FOLLOW_UP_TIMEOUT_MS = 45_000;
const QUESTION =
  "Compare React Native and Flutter performance according to their official documentation, including how each approaches performance measurement.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

function classifyFailure(reason: string): string {
  if (/serper|search provider|web_search/i.test(reason)) return "SERPER_OR_SEARCH_FAILURE";
  if (/openrouter returned 429|rate limit/i.test(reason)) return "OPENROUTER_RATE_LIMIT";
  if (/openrouter|model request|model synthesis/i.test(reason)) return "OPENROUTER_FAILURE";
  if (/timed out|timeout|deadline|budget/i.test(reason)) return "TIMEOUT_OR_BUDGET";
  if (/citation|support|evidence|cited answer/i.test(reason)) return "CITATION_QUALITY_GATE";
  if (/fetch|source content|extract/i.test(reason)) return "SOURCE_RETRIEVAL_FAILURE";
  return "APPLICATION_FAILURE";
}

async function main() {
  if (!process.env.SERPER_API_KEY || !process.env.OPENROUTER_API_KEY) {
    throw new Error("citation-e2e requires SERPER_API_KEY and OPENROUTER_API_KEY in .env");
  }

  // The server factory is imported only after selecting test mode, so its module-level app
  // remains unbound to a public port; the harness still exercises the real Fastify routes.
  process.env.NODE_ENV = "test";

  const [
    { createServer, app: moduleApp },
    { OpenRouterProvider },
    { ResilientSearchProvider, SerperProvider },
    { SqliteSessionStore },
  ] = await Promise.all([
    import("../server.js"),
    import("../llm.js"),
    import("../search.js"),
    import("../store.js"),
  ]);

  const store = new SqliteSessionStore(":memory:");
  const searchProvider = new ResilientSearchProvider([
    { name: "serper", provider: new SerperProvider() },
  ]);
  const llm = new OpenRouterProvider(MODEL_REQUEST_TIMEOUT_MS);
  const app = await createServer({
    store,
    searchProvider,
    llmProvider: llm,
    researchBudget: RESEARCH_BUDGET,
    fastLookupLimits: {
      maxQueries: RESEARCH_BUDGET.maxQueries,
      maxSources: RESEARCH_BUDGET.maxSources,
      maxPages: RESEARCH_BUDGET.maxPages,
      maxTimeMs: RESEARCH_BUDGET.maxTimeMs,
    },
  });

  const startedAt = performance.now();
  const startedIso = new Date().toISOString();
  const failureReasons: string[] = [];
  let chatStatusCode: number | undefined;
  let route: string | undefined;
  let session: import("../domain.js").ResearchSession | undefined;
  let followUpResult: import("../content-domain.js").ResearchFollowUp | undefined;
  let chatEntailment: import("../citation-entailment.js").CitationEntailmentReport | undefined;
  let chatDurationMs = 0;
  let followUpDurationMs = 0;

  try {
    llm.setDeadline(Date.now() + RESEARCH_BUDGET.maxTimeMs);
    const chatStarted = performance.now();
    const chatResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: QUESTION, deepResearch: true },
    });
    chatStatusCode = chatResponse.statusCode;
    if (![200, 202].includes(chatResponse.statusCode)) {
      throw new Error(`POST /api/chat returned HTTP ${chatResponse.statusCode}`);
    }
    const chat = chatResponse.json() as {
      route?: string;
      answer?: string;
      researchId?: string;
      session?: import("../domain.js").ResearchSession;
    };
    route = chat.route;
    if (
      chat.session &&
      ["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(chat.session.status)
    ) {
      session = chat.session;
    } else if (chat.researchId) {
      const deadline = Date.now() + RESEARCH_BUDGET.maxTimeMs + 5_000;
      while (Date.now() < deadline) {
        const response = await app.inject({
          method: "GET",
          url: `/api/research/${chat.researchId}`,
        });
        if (response.statusCode !== 200) {
          throw new Error(`GET /api/research/:id returned HTTP ${response.statusCode}`);
        }
        const current = response.json() as import("../domain.js").ResearchSession;
        if (["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(current.status)) {
          session = current;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (!session) {
        await app.inject({ method: "POST", url: `/api/research/${chat.researchId}/cancel` });
        throw new Error("Research session exceeded its 150-second harness deadline");
      }
    } else if (chat.answer) {
      throw new Error("Deep Research request returned an answer without a persisted session");
    }

    if (!session) throw new Error("Chat response did not include a research session");
    chatDurationMs = Math.round(performance.now() - chatStarted);
    if (session.status !== "COMPLETED") {
      throw new Error(`Research ended in ${session.status}: ${session.error ?? "no detail"}`);
    }
    chatEntailment = llm.metrics.citationEntailment;
    if (session.sources.filter((source) => source.content?.trim()).length === 0) {
      throw new Error("No source content was fetched through the chat research path");
    }
    if (!session.answer || !/\[\d+\]/.test(session.answer)) {
      throw new Error("Research completed without a cited final answer");
    }
    if (!chatEntailment || chatEntailment.status === "SKIPPED") {
      throw new Error("No semantic citation entailment result was recorded for the answer");
    }
    if (chatEntailment.status === "REJECTED") {
      throw new Error("Semantic citation validation rejected all factual answer claims");
    }

    const supportedClaims = session.claims
      .filter((claim) => claim.verification?.verdict === "supported")
      .filter((claim) =>
        claim.sourceIds.some((sourceId) => session!.sources.some((s) => s.id === sourceId)),
      );
    if (supportedClaims.length === 0) {
      throw new Error("No verified source-linked claim was available to seed the follow-up");
    }

    const postId = randomUUID();
    const now = new Date().toISOString();
    await store.savePost({
      id: postId,
      topicId: randomUUID(),
      researchId: session.id,
      title: "Bounded live citation-quality validation",
      summary: session.answer.slice(0, 700),
      whyItMatters: "Validates cited claims through the actual chat and follow-up routes.",
      findings: supportedClaims.slice(0, 4).map((claim) => ({
        claimId: claim.id,
        text: claim.text,
        sourceIds: claim.sourceIds,
      })),
      caveats: (session.conflicts ?? []).map((conflict) => conflict.description),
      sources: session.sources,
      claims: session.claims,
      publishedAt: now,
      researchedAt: now,
      category: "live-quality-evaluation",
    });

    const followUpStarted = performance.now();
    llm.setDeadline(Date.now() + FOLLOW_UP_TIMEOUT_MS);
    const askResponse = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/ask`,
      payload: { question: "Which source supports the first verified finding?" },
    });
    if (askResponse.statusCode !== 202) {
      throw new Error(`POST /api/posts/:id/ask returned HTTP ${askResponse.statusCode}`);
    }
    const queued = askResponse.json() as { id: string };
    const followUpDeadline = Date.now() + FOLLOW_UP_TIMEOUT_MS + 2_000;
    while (Date.now() < followUpDeadline) {
      const response = await app.inject({
        method: "GET",
        url: `/api/posts/${postId}/ask/${queued.id}`,
      });
      if (response.statusCode !== 200) {
        throw new Error(`GET /api/posts/:id/ask/:followUpId returned HTTP ${response.statusCode}`);
      }
      const current = response.json() as import("../content-domain.js").ResearchFollowUp;
      if (["COMPLETED", "FAILED"].includes(current.status)) {
        followUpResult = current;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    followUpDurationMs = Math.round(performance.now() - followUpStarted);
    if (!followUpResult) throw new Error("Follow-up exceeded its 45-second harness deadline");
    if (followUpResult.status !== "COMPLETED") {
      throw new Error(
        `Follow-up ended in ${followUpResult.status}: ${followUpResult.error ?? "no detail"}`,
      );
    }
    const followUpEntailment = llm.metrics.citationEntailment;
    if (!followUpEntailment || followUpEntailment.status === "SKIPPED") {
      failureReasons.push("Follow-up returned no semantic citation validation result");
    }
    if (followUpEntailment?.status === "REJECTED") {
      failureReasons.push("Follow-up citation validation rejected its factual answer claims");
    }
    if (!followUpResult.answer || !/\[\d+\]/.test(followUpResult.answer)) {
      failureReasons.push("Follow-up did not return a cited answer");
    }
  } catch (error) {
    failureReasons.push(errorMessage(error));
  } finally {
    await app.close();
    await moduleApp.close();
  }

  const metrics = llm.metrics;
  const report = {
    startedAt: startedIso,
    model: process.env.OPENROUTER_MODEL ?? "configured model",
    searchProvider: "serper",
    question: QUESTION,
    limits: {
      maxSteps: RESEARCH_BUDGET.maxSteps,
      maxQueries: RESEARCH_BUDGET.maxQueries,
      maxSources: RESEARCH_BUDGET.maxSources,
      maxPages: RESEARCH_BUDGET.maxPages,
      maxResearchSessionMs: RESEARCH_BUDGET.maxTimeMs,
      modelRequestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      followUpTimeoutMs: FOLLOW_UP_TIMEOUT_MS,
    },
    chat: {
      httpStatus: chatStatusCode,
      route,
      status: session?.status,
      durationMs: chatDurationMs,
      answer: session?.answer,
      trace: session?.steps.map((step) => step.label) ?? [],
      searchAttempts: session?.searchAttempts ?? [],
      sources:
        session?.sources.map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          hasExtractedContent: Boolean(source.content?.trim()),
        })) ?? [],
      claims:
        session?.claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          sourceIds: claim.sourceIds,
          verdict: claim.verification?.verdict,
        })) ?? [],
      citationEntailment: chatEntailment,
    },
    followUp: {
      status: followUpResult?.status,
      durationMs: followUpDurationMs,
      question: followUpResult?.question,
      answer: followUpResult?.answer,
      sourceIds: followUpResult?.sourceIds ?? [],
      citationEntailment: metrics.citationEntailment,
    },
    llm: {
      calls: metrics.calls,
      failures: metrics.failures,
      usage: {
        promptTokens: metrics.usage.promptTokens,
        completionTokens: metrics.usage.completionTokens,
        reasoningTokens: metrics.usage.reasoningTokens,
        totalTokens: metrics.usage.totalTokens,
        cost: metrics.usage.cost,
      },
      records: metrics.records,
    },
    totalDurationMs: Math.round(performance.now() - startedAt),
    failures: failureReasons.map((reason) => ({ category: classifyFailure(reason), reason })),
  };

  const outputDirectory = resolve("evaluation-results");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "citation-quality-e2e-report.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath: outputPath }, null, 2));
  if (failureReasons.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(`Bounded citation-quality E2E failed to start: ${errorMessage(error)}`);
  process.exitCode = 1;
});
