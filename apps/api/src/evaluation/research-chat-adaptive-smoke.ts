import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchSession } from "../domain.js";
import type { OpenRouterProvider } from "../llm.js";
import type { InMemoryDurableJobStore } from "../jobs.js";
import type { SqliteSessionStore } from "../store.js";
import type { FastifyInstance } from "fastify";
import { researchActionsUsed, researchChatRetrievalMetrics } from "./research-chat-metrics.js";
import { searchDiagnosticTrace } from "../search-diagnostics.js";
import type { SearchAttempt } from "../search.js";
import {
  enqueueOnceThenPoll,
  parseRetryAfterMs,
  summarizePollingTelemetry,
  type PollObservation,
} from "./poll-until-terminal.js";
import {
  addSmokeCleanupFailure,
  buildSmokeDiagnosticReport,
  createSmokeLifecycleDiagnostics,
  runSmokeLifecycle,
  safeSmokeError,
  type SmokeLifecycleDiagnostics,
} from "./smoke-lifecycle.js";

const QUESTION =
  "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
const ACCESS_TOKEN = "local-research-chat-adaptive-smoke-token";
const USER_ID = "local-research-chat-adaptive-smoke-user";
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_EXPONENTIAL_POLL_BACKOFF_MS = 8_000;
const MAX_OPENROUTER_CALLS = 6;
const MAX_RESEARCH_STEPS = 8;
const MAX_SEARCH_QUERIES = 2;
const MAX_SEARCH_PASSES = 1;
const MAX_SOURCES = 2;
const MAX_PAGES = 1;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

type ServerModule = typeof import("../server.js");
type ApiServer = Awaited<ReturnType<ServerModule["createServer"]>>;
type BackgroundServices = ReturnType<ServerModule["getServerBackgroundServices"]>;

interface SmokeRuntime {
  api: ApiServer;
  moduleApp: FastifyInstance;
  background: BackgroundServices;
  baseUrl: string;
  store: SqliteSessionStore;
  jobStore: InMemoryDurableJobStore;
  llm: OpenRouterProvider;
  queries: string[];
}

interface SmokeResources {
  serverModule?: ServerModule;
  moduleApp?: FastifyInstance;
  api?: ApiServer;
  background?: BackgroundServices;
  store?: SqliteSessionStore;
  jobStore?: InMemoryDurableJobStore;
  llm?: OpenRouterProvider;
  queries?: string[];
  workerStarted: boolean;
  sessionStoreClosed: boolean;
  openRouterRequests?: number;
  baseUrl?: string;
}

function failureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/RESEARCH_ACCEPTANCE_FAILED/i.test(message)) return "RESEARCH_ACCEPTANCE_FAILED";
  if (/requires configured Serper and OpenRouter keys/i.test(message))
    return "CONFIGURATION_FAILURE";
  if (/429|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/bounded timeout|terminal state/i.test(message)) return "POLLING_DEADLINE";
  if (/timeout|timed out|deadline|abort/i.test(message)) return "TIMEOUT";
  if (/serper|search provider/i.test(message)) return "SERPER_FAILURE";
  if (/openrouter|model/i.test(message)) return "OPENROUTER_FAILURE";
  return "APPLICATION_FAILURE";
}

function setCleanupStatus(
  diagnostics: SmokeLifecycleDiagnostics,
  resource: string,
  status: "not_started" | "not_required" | "attempted" | "completed" | "failed",
) {
  diagnostics.cleanup[resource] = status;
}

async function cleanupAction(
  diagnostics: SmokeLifecycleDiagnostics,
  resource: string,
  action: () => void | Promise<void>,
): Promise<boolean> {
  diagnostics.stage = `cleanup:${resource}`;
  setCleanupStatus(diagnostics, resource, "attempted");
  try {
    await action();
    setCleanupStatus(diagnostics, resource, "completed");
    return true;
  } catch (error) {
    setCleanupStatus(diagnostics, resource, "failed");
    addSmokeCleanupFailure(diagnostics, resource, error);
    return false;
  }
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const startedIso = new Date().toISOString();
  const resources: SmokeResources = {
    workerStarted: false,
    sessionStoreClosed: false,
  };
  let queued: { route: string; researchId: string; jobId: string } | undefined;
  let session: ResearchSession | undefined;
  let terminalStatus: string | undefined;
  let terminalStage: string | undefined;
  let attempts = 0;
  let completedEarly = false;
  let enqueueRequests = 0;
  let pollObservations: PollObservation[] = [];
  let pollStartedAt: number | undefined;
  let cancellationRequested = false;
  let answerFailure: { category: string; name: string } | undefined;

  const lifecycle = await runSmokeLifecycle<SmokeRuntime, void>({
    classifyFailure: failureCategory,
    setup: async (diagnostics) => {
      diagnostics.stage = "configure_local_runtime";
      process.env.NODE_ENV = "test";
      process.env.MAX_PERSISTENCE_PROVIDER = "sqlite";

      diagnostics.stage = "import_config";
      const { config } = await import("../config.js");

      diagnostics.stage = "import_server_module";
      resources.serverModule = await import("../server.js");
      resources.moduleApp = resources.serverModule.app;

      diagnostics.stage = "import_openrouter_adapter";
      const { OpenRouterProvider } = await import("../llm.js");
      diagnostics.stage = "import_search_adapters";
      const { ResilientSearchProvider, SerperProvider } = await import("../search.js");
      diagnostics.stage = "import_local_stores";
      const { SqliteSessionStore } = await import("../store.js");
      const { InMemoryDurableJobStore } = await import("../jobs.js");
      diagnostics.stage = "import_local_services";
      const { UserMemoryService } = await import("../memory.js");
      const { QuotaPolicy } = await import("../quota-policy.js");

      diagnostics.stage = "validate_provider_configuration";
      if (!config.SERPER_API_KEY || !config.OPENROUTER_API_KEY) {
        throw new Error("Live Research Chat smoke requires configured Serper and OpenRouter keys");
      }

      diagnostics.stage = "create_local_session_store";
      const store = new SqliteSessionStore(":memory:");
      resources.store = store;
      const originalStoreClose = store.close.bind(store);
      store.close = () => {
        if (resources.sessionStoreClosed) return;
        originalStoreClose();
        resources.sessionStoreClosed = true;
      };

      diagnostics.stage = "create_local_job_store";
      const baseJobStore = new InMemoryDurableJobStore();
      const jobStore = new Proxy(baseJobStore, {
        get(target, property, receiver) {
          if (property === "enqueueJob") {
            return (input: Parameters<typeof target.enqueueJob>[0]) =>
              target.enqueueJob({ ...input, maxAttempts: 1 });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      resources.jobStore = jobStore;

      diagnostics.stage = "create_model_provider";
      const llm = new OpenRouterProvider({
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxAttempts: 1,
      });
      resources.llm = llm;
      resources.openRouterRequests = 0;
      const complete = llm.complete.bind(llm);
      llm.complete = async (...args: Parameters<typeof llm.complete>) => {
        const requests = resources.openRouterRequests ?? 0;
        if (requests >= MAX_OPENROUTER_CALLS) {
          throw new Error(
            "Smoke evaluator blocked an OpenRouter request beyond its six-call ceiling",
          );
        }
        resources.openRouterRequests = requests + 1;
        diagnostics.openRouterCalls = resources.openRouterRequests;
        return complete(...args);
      };

      diagnostics.stage = "create_search_provider";
      const serper = new SerperProvider();
      const queries: string[] = [];
      resources.queries = queries;
      const search = new ResilientSearchProvider([
        {
          name: "serper",
          provider: {
            search: async (query: string, signal?: AbortSignal) => {
              if (queries.length >= MAX_SEARCH_QUERIES) {
                throw new Error(
                  "Smoke evaluator blocked a Serper query beyond its two-query ceiling",
                );
              }
              queries.push(query);
              diagnostics.serperCalls = queries.length;
              return serper.search(query, signal);
            },
          },
        },
      ]);
      diagnostics.providerCallCountersAvailable = true;
      diagnostics.serperCalls = 0;
      diagnostics.openRouterCalls = 0;

      diagnostics.stage = "create_fastify_server";
      const api = await resources.serverModule.createServer({
        store,
        jobStore,
        authVerifier: {
          verifyAccessToken: async (token: string) =>
            token === ACCESS_TOKEN ? { id: USER_ID } : undefined,
        },
        quotaPolicy: new QuotaPolicy(),
        searchProvider: search,
        llmProvider: llm,
        memoryService: new UserMemoryService(store, undefined),
        researchBudget: {
          maxSteps: MAX_RESEARCH_STEPS,
          maxQueries: MAX_SEARCH_QUERIES,
          maxSources: MAX_SOURCES,
          maxPages: MAX_PAGES,
          maxSearchPasses: MAX_SEARCH_PASSES,
          maxClaimsToVerify: 2,
          maxTimeMs: SESSION_TIMEOUT_MS,
          maxModelDecisions: 3,
        },
        evaluationBudgetCeilings: {
          maxSteps: MAX_RESEARCH_STEPS,
          maxQueries: MAX_SEARCH_QUERIES,
          maxSources: MAX_SOURCES,
          maxPages: MAX_PAGES,
          maxSearchPasses: MAX_SEARCH_PASSES,
          maxClaimsToVerify: 2,
          maxTimeMs: SESSION_TIMEOUT_MS,
          maxModelDecisions: 3,
        },
        fastLookupLimits: {
          maxQueries: MAX_SEARCH_QUERIES,
          maxSources: MAX_SOURCES,
          maxPages: MAX_PAGES,
          maxTimeMs: SESSION_TIMEOUT_MS,
        },
      });
      resources.api = api;

      diagnostics.stage = "resolve_background_services";
      const background = resources.serverModule.getServerBackgroundServices(api);
      resources.background = background;

      diagnostics.stage = "listen_local_api";
      const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
      resources.baseUrl = baseUrl;

      diagnostics.stage = "start_local_worker";
      background.worker.start();
      resources.workerStarted = true;

      diagnostics.stage = "set_research_deadline";
      llm.setDeadline(Date.now() + SESSION_TIMEOUT_MS);
      diagnostics.serverStartupCompleted = true;

      return {
        api,
        moduleApp: resources.moduleApp,
        background,
        baseUrl,
        store,
        jobStore,
        llm,
        queries,
      };
    },
    execute: async (runtime, diagnostics) => {
      diagnostics.stage = "enqueue_and_poll_research_chat";
      const outcome = await enqueueOnceThenPoll(
        async () => {
          enqueueRequests += 1;
          diagnostics.researchSubmissionAttempted = true;
          const enqueueResponse = await fetch(`${runtime.baseUrl}/api/chat`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${ACCESS_TOKEN}`,
              "content-type": "application/json",
              "idempotency-key": `adaptive-deep-smoke-${Date.now()}`,
            },
            body: JSON.stringify({ message: QUESTION, deepResearch: true }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 5_000),
          });
          if (enqueueResponse.status !== 202) {
            throw new Error(`Deep Research Chat enqueue returned HTTP ${enqueueResponse.status}`);
          }
          diagnostics.researchJobAccepted = true;

          const value = (await enqueueResponse.json()) as {
            route?: string;
            researchId?: string;
            jobId?: string;
          };
          if (value.route !== "deep" || !value.researchId || !value.jobId) {
            throw new Error("/api/chat did not create a Deep Research durable job");
          }
          queued = {
            route: value.route,
            researchId: value.researchId,
            jobId: value.jobId,
          };
          pollStartedAt = performance.now();
          return queued;
        },
        async (identity, remainingMs) => {
          const response = await fetch(`${runtime.baseUrl}/api/research/${identity.researchId}`, {
            headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
            signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remainingMs))),
          });
          if (response.status === 429) {
            await response.body?.cancel();
            return {
              statusCode: 429,
              retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
            };
          }
          if (response.status !== 200) {
            await response.body?.cancel();
            return { statusCode: response.status };
          }

          session = (await response.json()) as ResearchSession;
          const job = await runtime.background.jobStore.getOwnedJob(identity.jobId, USER_ID);
          if (!job) return { statusCode: 404 };
          terminalStatus = job.status;
          terminalStage = typeof job.progress.stage === "string" ? job.progress.stage : undefined;
          attempts = job.attempts;
          return { statusCode: 200, value: { status: job.status, session, job } };
        },
        {
          timeoutMs: SESSION_TIMEOUT_MS + 5_000,
          intervalMs: POLL_INTERVAL_MS,
          maxRateLimitBackoffMs: MAX_EXPONENTIAL_POLL_BACKOFF_MS,
          terminalStatuses: TERMINAL_STATUSES,
          onPoll: (observation) => pollObservations.push(observation),
        },
      );
      queued = outcome.queued;
      session = outcome.terminal.session;
      terminalStatus = outcome.terminal.job.status;
      terminalStage =
        typeof outcome.terminal.job.progress.stage === "string"
          ? outcome.terminal.job.progress.stage
          : undefined;
      attempts = outcome.terminal.job.attempts;

      const retrievalMetrics = researchChatRetrievalMetrics(session.sources);
      const actionsUsed = researchActionsUsed(session.decisions ?? []);
      const unusedBudget = {
        queries: Math.max(0, MAX_SEARCH_QUERIES - runtime.queries.length),
        sources: Math.max(0, MAX_SOURCES - session.sources.length),
        pages: Math.max(0, MAX_PAGES - retrievalMetrics.pageRetrievalSources),
        steps: Math.max(0, MAX_RESEARCH_STEPS - actionsUsed),
        openRouterRequests: Math.max(0, MAX_OPENROUTER_CALLS - (resources.openRouterRequests ?? 0)),
      };
      completedEarly =
        session.status === "COMPLETED" &&
        session.decisions?.at(-1)?.nextAction === "synthesize" &&
        [unusedBudget.queries, unusedBudget.sources, unusedBudget.pages, unusedBudget.steps].some(
          (remaining) => remaining > 0,
        );

      if (session.status !== "COMPLETED" || !completedEarly || attempts !== 1) {
        answerFailure = { category: "RESEARCH_ACCEPTANCE_FAILED", name: "SmokeAcceptanceError" };
        throw new Error(
          "RESEARCH_ACCEPTANCE_FAILED: bounded Research Chat acceptance criteria failed",
        );
      }
    },
    cleanup: async (_runtime, diagnostics) => {
      if (resources.llm) {
        await cleanupAction(diagnostics, "llmDeadline", () =>
          resources.llm!.setDeadline(undefined),
        );
      } else {
        setCleanupStatus(diagnostics, "llmDeadline", "not_required");
      }

      if (queued && !TERMINAL_STATUSES.includes(terminalStatus ?? "") && resources.background) {
        const cancelled = await cleanupAction(diagnostics, "activeJob", async () => {
          const result = await resources.background!.jobStore.cancelJob(queued!.jobId, USER_ID);
          if (!result)
            throw new Error("Local nonterminal smoke job cancellation was not confirmed");
          cancellationRequested = true;
        });
        if (!cancelled) cancellationRequested = false;
      } else if (diagnostics.researchJobAccepted && !queued) {
        setCleanupStatus(diagnostics, "activeJob", "failed");
        addSmokeCleanupFailure(
          diagnostics,
          "activeJob",
          new Error("Local job was accepted but its identity was unavailable for cancellation"),
        );
      } else {
        setCleanupStatus(diagnostics, "activeJob", "not_required");
      }

      if (resources.background && resources.workerStarted) {
        await cleanupAction(diagnostics, "worker", () => resources.background!.worker.stop());
      } else {
        setCleanupStatus(diagnostics, "worker", "not_required");
      }

      let apiClosed = false;
      if (resources.api) {
        apiClosed = await cleanupAction(diagnostics, "apiServer", () => resources.api!.close());
      } else {
        setCleanupStatus(diagnostics, "apiServer", "not_required");
      }

      if (resources.store && !resources.sessionStoreClosed) {
        if (apiClosed) {
          resources.sessionStoreClosed = true;
        } else {
          await cleanupAction(diagnostics, "sessionStore", () => resources.store!.close());
        }
      }
      if (resources.sessionStoreClosed) {
        setCleanupStatus(diagnostics, "sessionStore", "completed");
      } else if (!resources.store) {
        setCleanupStatus(diagnostics, "sessionStore", "not_required");
      }

      if (resources.jobStore) {
        if (apiClosed) {
          setCleanupStatus(diagnostics, "jobStore", "completed");
        } else {
          await cleanupAction(diagnostics, "jobStore", async () => {
            await resources.jobStore!.close?.();
          });
        }
      } else {
        setCleanupStatus(diagnostics, "jobStore", "not_required");
      }

      if (resources.moduleApp && resources.moduleApp !== resources.api) {
        await cleanupAction(diagnostics, "moduleApp", () => resources.moduleApp!.close());
      } else {
        setCleanupStatus(diagnostics, "moduleApp", "not_required");
      }
    },
  });

  const diagnostics = lifecycle.diagnostics;
  // The worker owns a separate AsyncLocalStorage scope. Read its persisted
  // snapshot, not the provider's empty metrics in this evaluator's scope.
  const llmMetrics = session?.state?.providerMetrics?.writer ?? resources.llm?.metrics;
  const retrievalMetrics = session ? researchChatRetrievalMetrics(session.sources) : undefined;
  const actionsUsed = researchActionsUsed(session?.decisions ?? []);
  const polling = summarizePollingTelemetry(
    pollObservations,
    enqueueRequests,
    pollStartedAt === undefined ? 0 : performance.now() - pollStartedAt,
  );
  const finalFailure =
    lifecycle.failure ??
    (answerFailure ? { ...answerFailure, stage: "research_acceptance" } : undefined);
  const cleanupComplete = Object.values(diagnostics.cleanup).every(
    (status) => status === "completed" || status === "not_required",
  );
  const result = {
    route: queued?.route,
    jobStatus: terminalStatus,
    sessionStatus: session?.status,
    jobAttempts: attempts,
    terminalStage,
    providerCallCountersAvailable: diagnostics.providerCallCountersAvailable,
    ...(diagnostics.providerCallCountersAvailable
      ? {
          serperCalls: diagnostics.serperCalls,
          openRouterCalls: diagnostics.openRouterCalls,
        }
      : { providerUsage: "unknown" }),
    initialSearchQuery: resources.queries?.[0],
    recoveryQueries: (session?.searchRecoveries ?? []).flatMap((recovery) => recovery.queries),
    totalSearchQueries: resources.queries?.length,
    searchPassesUsed: (session?.searchRecoveries ?? []).filter(
      (recovery) => recovery.queries.length > 0,
    ).length,
    queries: resources.queries,
    selectedSources: session?.sources.length ?? 0,
    evidenceContentSources: retrievalMetrics?.evidenceContentSources ?? 0,
    snippetEvidenceSources: retrievalMetrics?.snippetEvidenceSources ?? 0,
    pageRetrievalSources: retrievalMetrics?.pageRetrievalSources ?? 0,
    unknownMethodSources: retrievalMetrics?.unknownMethodSources ?? 0,
    sources: (session?.sources ?? []).map((source) => ({
      title: source.title,
      url: source.url,
      retrievalMethod: source.retrievalMethod,
      retrievalAttempts: source.retrievalAttempts ?? [],
      extractionStatus: source.extractionStatus,
      extractionConfidence: source.extractionConfidence,
      retrievedContentLength: source.retrievedContentLength,
      retrievalReasons: source.retrievalReasons ?? [],
      taskEvidence: source.taskEvidence
        ? {
            status: source.taskEvidence.status,
            presentFacts: source.taskEvidence.presentFacts ?? [],
            missingFacts: source.taskEvidence.missingFacts,
          }
        : undefined,
      hasEvidenceContent: Boolean(source.content?.trim()),
      pageRetrievalAttempted: Boolean(
        source.retrievalAttempts?.some((method) => method !== "serper_snippet"),
      ),
    })),
    retrievalMethods: [
      ...new Set((session?.sources ?? []).map((source) => source.retrievalMethod ?? "unknown")),
    ],
    browserUsed: (session?.sources ?? []).some((source) => source.retrievalMethod === "browser"),
    modelMetrics: llmMetrics
      ? {
          calls: llmMetrics.calls,
          failures: llmMetrics.failures,
          durationMs: llmMetrics.durationMs,
          usage: llmMetrics.usage,
          synthesis: llmMetrics.synthesis,
          citationEntailmentStatus: llmMetrics.citationEntailment?.status,
          records: llmMetrics.records.map((record) => ({
            durationMs: record.durationMs,
            purpose: record.purpose,
            model: record.model,
            promptChars: record.promptChars,
            requestBodyBytes: record.requestBodyBytes,
            effectiveTimeoutMs: record.effectiveTimeoutMs,
            responseParseResult: record.responseParseResult,
            responseValidationResult: record.responseValidationResult,
            failureCategory: record.failureCategory,
            usage: record.usage,
          })),
        }
      : undefined,
    elapsedMs: Math.round(performance.now() - startedAt),
    stepsUsed: actionsUsed,
    activityStepEvents: session?.steps.length ?? 0,
    actionDecisions: (session?.decisions ?? []).map((decision) => decision.nextAction),
    claimDiagnostics: {
      candidateClaims: session?.claims.length ?? 0,
      eligibleClaims: session?.state?.claims.length ?? 0,
      requestedFactClaims:
        session?.state?.claims.filter((claim) => (claim.requestedFacts?.length ?? 0) > 0).length ??
        0,
      verifiedClaims: session?.state?.verifiedClaims.length ?? 0,
    },
    requestedFactCoverage: session?.state?.requestedFactCoverage,
    searchRecoveries: (session?.searchRecoveries ?? []).map((recovery) => ({
      reason: recovery.reason,
      missingRequestedFacts: recovery.missingRequestedFacts,
      requirements: recovery.requirements,
      queries: recovery.queries,
      queryValidation: recovery.queryValidation,
    })),
    searchAttempts: searchDiagnosticTrace(session?.searchAttempts as SearchAttempt[] | undefined),
    unusedBudget: {
      queries: Math.max(0, MAX_SEARCH_QUERIES - (resources.queries?.length ?? 0)),
      sources: Math.max(0, MAX_SOURCES - (session?.sources.length ?? 0)),
      pages: Math.max(0, MAX_PAGES - (retrievalMetrics?.pageRetrievalSources ?? 0)),
      steps: Math.max(0, MAX_RESEARCH_STEPS - actionsUsed),
      openRouterRequests: diagnostics.providerCallCountersAvailable
        ? Math.max(0, MAX_OPENROUTER_CALLS - (resources.openRouterRequests ?? 0))
        : undefined,
    },
    stopReason: session?.error ?? terminalStage ?? session?.status ?? finalFailure?.category,
    earlyStopDemonstrated: completedEarly,
    answer: session?.answer,
    error: session?.error ? safeSmokeError(new Error(session.error)).message : undefined,
  };

  const report = {
    startedAt: startedIso,
    question: QUESTION,
    mode: "deep",
    persistence: "local in-memory/SQLite only; no remote database writes",
    auth: "local deterministic test verifier; no temporary Supabase identity",
    searchProvider: "Serper",
    model: resources.llm?.model,
    limits: {
      initialSerperQueries: 1,
      maxSearchQueries: MAX_SEARCH_QUERIES,
      maxSearchPasses: MAX_SEARCH_PASSES,
      maxSources: MAX_SOURCES,
      maxPages: MAX_PAGES,
      maxSteps: MAX_RESEARCH_STEPS,
      maxClaimsToVerify: 2,
      maxModelDecisions: 3,
      maxResearchSessionMs: SESSION_TIMEOUT_MS,
      openRouterRequestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxOpenRouterRequests: MAX_OPENROUTER_CALLS,
      maxJobAttempts: 1,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxExponentialPollBackoffMs: MAX_EXPONENTIAL_POLL_BACKOFF_MS,
      maxPollingSessionMs: SESSION_TIMEOUT_MS + 5_000,
    },
    diagnostics: buildSmokeDiagnosticReport(diagnostics, finalFailure),
    polling,
    result,
    failure: finalFailure,
    cleanup: {
      ...diagnostics.cleanup,
      cancellationRequested,
      remoteTestDataCreated: false,
      status: cleanupComplete ? "complete" : "incomplete",
    },
  };

  let serializedReport: string;
  try {
    serializedReport = JSON.stringify(report, null, 2);
  } catch (error) {
    const reportFailure = {
      category: "REPORT_FAILURE",
      stage: "serialize_report",
      ...safeSmokeError(error),
    };
    process.stderr.write(
      `${JSON.stringify(
        { diagnostics: buildSmokeDiagnosticReport(diagnostics, reportFailure) },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${serializedReport}\n`);
  } catch (error) {
    const reportFailure = {
      category: "REPORT_FAILURE",
      stage: "write_report",
      ...safeSmokeError(error),
    };
    try {
      process.stderr.write(
        `${JSON.stringify(
          { diagnostics: buildSmokeDiagnosticReport(diagnostics, reportFailure) },
          null,
          2,
        )}\n`,
      );
    } finally {
      process.exitCode = 1;
    }
    return;
  }
  if (finalFailure || !cleanupComplete) process.exitCode = 1;
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  void main().catch((error: unknown) => {
    const diagnostics = createSmokeLifecycleDiagnostics();
    const failure = {
      category: failureCategory(error),
      stage: "entrypoint_or_unhandled_runner_failure",
      ...safeSmokeError(error),
    };
    try {
      process.stderr.write(
        `${JSON.stringify({ diagnostics: buildSmokeDiagnosticReport(diagnostics, failure) }, null, 2)}\n`,
      );
    } catch {
      process.stderr.write(
        "Bounded Research Chat smoke failed; sanitized report could not be emitted.\n",
      );
    }
    process.exitCode = 1;
  });
}
