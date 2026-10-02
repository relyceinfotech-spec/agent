import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { z } from "zod";
import { config, persistenceProvider } from "./config.js";
import { isNonRetryableResearchFailure, ResearchRunner } from "./research.js";
import { ResilientSearchProvider, SerperProvider } from "./search.js";
import {
  DEFAULT_RESEARCH_SESSION_PAGE_SIZE,
  MAX_RESEARCH_SESSION_PAGE_SIZE,
  SqliteSessionStore,
  type MaxStore,
  type SessionCursor,
} from "./store.js";
import { SupabaseStore } from "./supabase-store.js";
import { createPostAgentLLMProviders, OpenRouterProvider } from "./llm.js";
import { AutonomousAgent } from "./agent/autonomous.js";
import { createToolRegistry, type ToolRegistry } from "./agent/tools.js";
import { RateLimiter } from "./rate-limiter.js";
import { installGracefulShutdown } from "./lifecycle.js";
import { sanitizeRequestLogUrl } from "./logging.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { ContentAgent } from "./content-agent.js";
import { PostFollowUpService, ResearchPostNotFoundError } from "./post-followup.js";
import type { SearchProvider } from "./search.js";
import type { ResearchBudget } from "./research.js";
import { SupabaseAuthVerifier, type AuthVerifier } from "./auth.js";
import { withAuthenticatedUser } from "./auth-context.js";
import { QuotaPolicy } from "./quota-policy.js";
import type { UserQuotaKey } from "./store.js";
import { createEmbeddingProvider } from "./embeddings.js";
import {
  createExportProjection,
  exportMimeType,
  hashExportProjection,
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_OUTPUT_BYTES,
  renderExportBytes,
  renderExportPdf,
  sanitizeExportFileName,
  type ExportFormat,
  type ExportProjection,
  type ExportResourceType,
} from "./exports.js";
import {
  buildUserMemoryAcknowledgement,
  DuplicateMemoryError,
  extractExplicitMemoryCandidate,
  MemoryLimitError,
  SensitiveMemoryError,
  UserMemoryService,
} from "./memory.js";
import { USER_MEMORY_CATEGORIES } from "./memory-domain.js";
import {
  createIdempotentJobId,
  createJobId,
  DurableQueueWorker,
  InMemoryDurableJobStore,
  RetryableJobError,
  type DurableJob,
  type DurableJobStore,
  type JobJsonValue,
} from "./jobs.js";
import { SqliteDurableJobStore } from "./job-store.js";
import { withResearchOwner } from "./auth-context.js";
import { isQueryInterpretation } from "./domain.js";
import type {
  QueryInterpretation,
  ResearchMode,
  ResearchSession,
  ResearchStatus,
  SearchResult,
} from "./domain.js";
import {
  BillingProviderNotConfiguredError,
  BillingService,
  BillingSignatureError,
  BillingWebhookValidationError,
  BillingWebhookVerificationError,
} from "./billing.js";
import { InMemoryBillingRepository, SupabaseBillingRepository } from "./billing-store.js";
import type { BillingProvider, BillingRepository } from "./billing-domain.js";
import {
  createShareToken,
  hashShareToken,
  isShareToken,
  projectPostForPublicApi,
  projectPostForSharing,
  projectResearchForSharing,
} from "./sharing.js";
import type { ExportRecord, ShareMetadata } from "./store.js";

export interface ServerDependencies {
  store?: MaxStore;
  searchProvider?: SearchProvider;
  llmProvider?: OpenRouterProvider;
  postAgentLLMProviders?: {
    planner: OpenRouterProvider;
    research: OpenRouterProvider;
    verifier: OpenRouterProvider;
  };
  toolRegistry?: ToolRegistry;
  researchBudget?: Partial<ResearchBudget>;
  evaluationBudgetCeilings?: Partial<ResearchBudget>;
  postAgentResearchBudget?: Partial<ResearchBudget>;
  fastLookupLimits?: Pick<ResearchBudget, "maxQueries" | "maxSources" | "maxPages" | "maxTimeMs">;
  authVerifier?: AuthVerifier;
  quotaPolicy?: QuotaPolicy;
  billingRepository?: BillingRepository;
  billingProviders?: BillingProvider[];
  billingService?: BillingService;
  shareResolveRateLimiter?: RateLimiter;
  exportPdfRenderer?: (projection: ExportProjection) => Promise<Buffer>;
  memoryService?: UserMemoryService;
  jobStore?: DurableJobStore;
}

const backgroundServices = new WeakMap<
  object,
  { worker: DurableQueueWorker; contentAgent: ContentAgent; jobStore: DurableJobStore }
>();

const researchSessionListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RESEARCH_SESSION_PAGE_SIZE)
    .default(DEFAULT_RESEARCH_SESSION_PAGE_SIZE),
  cursor: z.string().min(1).max(256).optional(),
});

function decodeResearchSessionCursor(token: string): SessionCursor | undefined {
  try {
    const decoded = Buffer.from(token, "base64url");
    if (decoded.toString("base64url") !== token) return undefined;
    const value = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 2 ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    ) {
      return undefined;
    }
    const date = new Date(value.createdAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.createdAt)
      return undefined;
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    return undefined;
  }
}

function encodeResearchSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function getServerBackgroundServices(app: object) {
  const services = backgroundServices.get(app);
  if (!services) throw new Error("Background services are unavailable for this server instance");
  return services;
}

export const rateLimiter = new RateLimiter(
  config.RATE_LIMIT_WINDOW_MS,
  config.RATE_LIMIT_MAX_REQUESTS,
);

export async function createServer(dependencies: ServerDependencies = {}) {
  const app = Fastify({
    trustProxy: config.MAX_TRUSTED_PROXIES.split(",")
      .map((proxy) => proxy.trim())
      .filter(Boolean),
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      serializers: {
        req: (request) => ({
          method: request.method,
          url: sanitizeRequestLogUrl(request.url),
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }),
      },
    },
    bodyLimit: config.MAX_BODY_BYTES, // 64KB strict request body limit
  });

  // Strict CORS policy: only configured WEB_URL (and local dev if not production)
  const allowedOrigins = new Set([
    config.WEB_URL,
    ...(config.NODE_ENV !== "production" ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow non-browser agents or same-origin requests where origin is undefined
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS policy"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["X-Next-Cursor"],
  });

  await app.register(sensible);

  // Security headers on all responses
  app.addHook("onSend", async (_request, reply) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
    void reply.header("X-XSS-Protection", "1; mode=block");
    void reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (config.NODE_ENV === "production") {
      void reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // Rate limiting hook for all /api/ endpoints
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      const clientIp = request.ip || "127.0.0.1";
      const result = await checkRateLimit(
        "api",
        clientIp,
        config.RATE_LIMIT_WINDOW_MS,
        config.RATE_LIMIT_MAX_REQUESTS,
        rateLimiter,
      );

      void reply.header("X-RateLimit-Limit", result.limit);
      void reply.header("X-RateLimit-Remaining", result.remaining);

      if (!result.allowed) {
        const retrySec = Math.ceil(result.resetMs / 1000);
        void reply.header("Retry-After", retrySec);
        return reply.code(429).send({
          error: "Too many requests. Please slow down and try again.",
          retryAfterSeconds: retrySec,
        });
      }
    }
  });

  const store: MaxStore =
    dependencies.store ??
    (persistenceProvider === "supabase"
      ? new SupabaseStore(
          config.SUPABASE_URL ?? "",
          config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || "",
          undefined,
          config.SUPABASE_PUBLISHABLE_KEY,
        )
      : new SqliteSessionStore(
          config.NODE_ENV === "test"
            ? ":memory:"
            : resolve(config.MAX_DATABASE_PATH ?? "data/max.sqlite"),
        ));
  const jobStore =
    dependencies.jobStore ??
    (store instanceof SupabaseStore
      ? store
      : store instanceof SqliteSessionStore
        ? store.createJobStore()
        : config.NODE_ENV === "test"
          ? new InMemoryDurableJobStore()
          : new SqliteDurableJobStore(resolve(config.MAX_DATABASE_PATH ?? "data/max.sqlite")));
  async function checkRateLimit(
    scope: string,
    key: string,
    windowMs: number,
    limit: number,
    fallback: RateLimiter,
  ) {
    return store.consumeRateLimit
      ? store.consumeRateLimit(scope, key, windowMs, limit)
      : fallback.check(key);
  }
  const search =
    dependencies.searchProvider ??
    new ResilientSearchProvider([{ name: "serper", provider: new SerperProvider() }]);
  const llm = dependencies.llmProvider ?? new OpenRouterProvider();
  const registry = dependencies.toolRegistry ?? createToolRegistry(search, llm, store);
  const runner = new ResearchRunner(
    store,
    search,
    llm,
    registry,
    dependencies.researchBudget,
    dependencies.evaluationBudgetCeilings,
    true,
  );
  const agent = new AutonomousAgent(registry, runner, llm, store, dependencies.fastLookupLimits);
  const memoryService =
    dependencies.memoryService ?? new UserMemoryService(store, createEmbeddingProvider());
  const postAgentLLM =
    dependencies.postAgentLLMProviders ??
    (dependencies.llmProvider
      ? {
          planner: dependencies.llmProvider,
          research: dependencies.llmProvider,
          verifier: dependencies.llmProvider,
        }
      : createPostAgentLLMProviders());
  const postRegistry = createToolRegistry(search, postAgentLLM.research, store, postAgentLLM);
  const postResearch = new ResearchRunner(
    store,
    search,
    postAgentLLM.planner,
    postRegistry,
    {
      maxSteps: 8,
      maxQueries: 2,
      maxSources: 4,
      maxPages: 3,
      maxSearchPasses: 2,
      maxClaimsToVerify: 8,
      maxTimeMs: 120_000,
      maxModelDecisions: 8,
      ...dependencies.postAgentResearchBudget,
    },
    undefined,
    false,
    postAgentLLM.research,
  );
  const contentAgent = new ContentAgent(
    store,
    postResearch,
    undefined,
    undefined,
    search,
    async (run) => {
      const queued = await jobStore.enqueueJob({
        id: run.id,
        kind: "post_agent",
        ownerScope: "system",
        payload: { runId: run.id },
        maxAttempts: 3,
      });
      if (!queued.job) throw new Error("Autonomous job could not be persisted");
    },
    () => jobStore.hasRunnableOrRunningJobs("post_agent"),
  );
  const followUps = new PostFollowUpService(store, runner, llm);
  const followUpLimiter = new RateLimiter(60_000, 5);
  const shareResolveLimiter = dependencies.shareResolveRateLimiter ?? new RateLimiter(60_000, 30);
  const exportPdfRenderer = dependencies.exportPdfRenderer ?? renderExportPdf;
  function jobModelMetrics(): JobJsonValue {
    const metrics = llm.metrics ?? { calls: 0, failures: 0, durationMs: 0, usage: {} };
    return JSON.parse(
      JSON.stringify({
        calls: metrics.calls,
        failures: metrics.failures,
        durationMs: metrics.durationMs,
        usage: metrics.usage,
        citationEntailment: metrics.citationEntailment,
        synthesis: metrics.synthesis,
      }),
    ) as JobJsonValue;
  }
  const queueWorker = new DurableQueueWorker(
    jobStore,
    {
      research: async (job, context): Promise<Record<string, JobJsonValue>> => {
        if (job.payload.task === "followup") {
          const execute = () =>
            followUps.runQueued(
              job.id,
              String(job.payload.postId),
              String(job.payload.question),
              context.signal,
            );
          const followUp = job.ownerId
            ? await withResearchOwner(job.ownerId, execute)
            : await execute();
          if (followUp.status === "FAILED") throw new Error(followUp.error ?? "Follow-up failed");
          return { followUpId: followUp.id, status: followUp.status };
        }
        if (job.payload.task === "chat") {
          const execute = async () => {
            const sessionId = String(job.payload.sessionId);
            const response = await agent.handle(
              String(job.payload.question),
              job.payload.mode === "deep",
              typeof job.payload.memoryContext === "string" ? job.payload.memoryContext : undefined,
              async (question, mode, memoryContext, interpretation) => {
                const session = await runner.runQueued(sessionId, question, mode, [], {
                  signal: context.signal,
                  memoryContext,
                  interpretation,
                  researchChatOptimization: true,
                });
                if (!session) throw new Error("Chat research result is unavailable");
                return { session, jobId: job.id };
              },
              isQueryInterpretation(job.payload.interpretation) &&
                job.payload.interpretation.ambiguityScore < 0.4
                ? job.payload.interpretation
                : undefined,
            );
            if (response.route === "direct") {
              const now = new Date().toISOString();
              const session: ResearchSession = {
                id: sessionId,
                question: String(job.payload.question),
                mode: "quick",
                status: "COMPLETED",
                createdAt: job.createdAt,
                updatedAt: now,
                sources: [],
                claims: [],
                steps: [],
                answer: response.answer,
              };
              if (await store.get(sessionId)) await store.update(session);
              else await store.create(session);
            }
            if (job.payload.memoryToolEvent)
              response.toolEvents.unshift(
                job.payload
                  .memoryToolEvent as unknown as import("./agent/autonomous.js").AgentToolEvent,
              );
            const persisted = await store.get(sessionId);
            if (!persisted) throw new Error("Chat result could not be persisted");
            if (persisted.status === "FAILED")
              throw new Error(persisted.error ?? "Chat research failed");
            const { session: _session, sources: _sources, ...compact } = response;
            return {
              sessionId,
              status: persisted.status,
              modelMetrics: jobModelMetrics(),
              response: JSON.parse(
                JSON.stringify({ ...compact, researchId: sessionId, jobId: job.id }),
              ) as JobJsonValue,
            };
          };
          return job.ownerId ? withResearchOwner(job.ownerId, execute) : execute();
        }
        const payload = job.payload;
        const sessionId = payload.sessionId;
        const question = payload.question;
        const mode = payload.mode;
        if (
          typeof sessionId !== "string" ||
          typeof question !== "string" ||
          (mode !== "quick" && mode !== "deep")
        ) {
          throw new Error("Queued research job has an invalid payload");
        }
        const unsubscribe = runner.subscribe(sessionId, (event) => {
          void context
            .reportProgress({
              stage: event.type,
              message: event.message.slice(0, 240),
              sessionId,
              ...(event.session
                ? {
                    researchStatus: event.session.status,
                    updatedAt: event.session.updatedAt,
                    stepCount: event.session.steps.length,
                  }
                : {}),
            })
            .catch(() => undefined);
        });
        try {
          const execute = () =>
            runner.runQueued(
              sessionId,
              question,
              mode,
              Array.isArray(payload.seedResults)
                ? (payload.seedResults as unknown as import("./domain.js").SearchResult[])
                : [],
              {
                allowSnippetEvidence: payload.allowSnippetEvidence !== false,
                memoryContext:
                  typeof payload.memoryContext === "string" ? payload.memoryContext : undefined,
                resume: payload.resume === true,
                interpretation:
                  payload.resume !== true && isQueryInterpretation(payload.interpretation)
                    ? payload.interpretation
                    : undefined,
                researchChatOptimization: payload.researchChatOptimization === true,
                signal: context.signal,
              },
            );
          const session = job.ownerId
            ? await withResearchOwner(job.ownerId, execute)
            : await execute();
          if (!session) throw new Error("Research worker did not persist a session result");
          if (session.status === "FAILED") {
            if (job.attempts < job.maxAttempts && !isNonRetryableResearchFailure(session.error)) {
              const retry = () => store.update({ ...session, status: "QUEUED", error: undefined });
              if (job.ownerId) await withResearchOwner(job.ownerId, retry);
              else await retry();
              throw new RetryableJobError(session.error ?? "Research attempt failed");
            }
            throw new Error(session.error ?? "Research failed after the final attempt");
          }
          const modelMetrics = llm.metrics;
          return {
            sessionId,
            status: session.status,
            model: llm.model,
            modelMetrics: {
              calls: modelMetrics.calls,
              failures: modelMetrics.failures,
              durationMs: modelMetrics.durationMs,
              usage: modelMetrics.usage as unknown as JobJsonValue,
              ...(modelMetrics.citationEntailment
                ? {
                    citationEntailment: modelMetrics.citationEntailment as unknown as JobJsonValue,
                  }
                : {}),
              ...(modelMetrics.synthesis
                ? { synthesis: modelMetrics.synthesis as unknown as JobJsonValue }
                : {}),
            },
          };
        } finally {
          unsubscribe();
        }
      },
      post_agent: async (job, context) => {
        const runId = job.payload.runId;
        if (typeof runId !== "string" || runId !== job.id) {
          throw new Error("Queued Post Agent job has an invalid run identity");
        }
        const run = await contentAgent.runQueued(runId, context.signal, context.reportProgress);
        if (!run) throw new Error("Post Agent worker did not persist a run result");
        if (run.status === "FAILED") {
          if (job.attempts < job.maxAttempts) {
            throw new RetryableJobError(run.error ?? "Post Agent attempt failed");
          }
          throw new Error(run.error ?? "Post Agent failed after the final attempt");
        }
        return { runId, runStatus: run.status };
      },
    },
    {
      concurrency: config.MAX_JOB_WORKER_CONCURRENCY,
      leaseSeconds: config.MAX_JOB_LEASE_SECONDS,
      pollIntervalMs: config.MAX_JOB_POLL_INTERVAL_MS,
    },
  );
  backgroundServices.set(app, { worker: queueWorker, contentAgent, jobStore });
  app.addHook("onClose", async () => {
    contentAgent.stopScheduler();
    await queueWorker.stop();
    if (jobStore !== (store as unknown as DurableJobStore)) await jobStore.close?.();
    await store.close();
  });

  function authorizeAdmin(header: string | undefined) {
    const token = config.MAX_ADMIN_TOKEN;
    if (!token) return "unconfigured" as const;
    const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBytes = Buffer.from(token);
    const suppliedBytes = Buffer.from(supplied);
    return (
      expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
    );
  }

  const authVerifier =
    dependencies.authVerifier ??
    (config.SUPABASE_URL &&
    (config.SUPABASE_SECRET_KEY ||
      config.SUPABASE_SERVICE_ROLE_KEY ||
      config.SUPABASE_PUBLISHABLE_KEY)
      ? new SupabaseAuthVerifier(
          config.SUPABASE_URL,
          config.SUPABASE_SECRET_KEY ||
            config.SUPABASE_SERVICE_ROLE_KEY ||
            config.SUPABASE_PUBLISHABLE_KEY!,
        )
      : undefined);
  const quotaPolicy = dependencies.quotaPolicy ?? new QuotaPolicy();
  const billingRepository =
    dependencies.billingRepository ??
    (store instanceof SupabaseStore
      ? new SupabaseBillingRepository(
          config.SUPABASE_URL ?? "",
          config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || "",
        )
      : new InMemoryBillingRepository());
  const billingUsageReader =
    typeof store.getUserQuotaUsage === "function"
      ? {
          getUserQuotaUsage: (userId: string, key: UserQuotaKey, windowSeconds: number) =>
            store.getUserQuotaUsage!(userId, key, windowSeconds),
        }
      : undefined;
  const billingService =
    dependencies.billingService ??
    new BillingService(
      billingRepository,
      quotaPolicy,
      dependencies.billingProviders ?? [],
      billingUsageReader,
    );

  type RouteHandler = (request: any, reply: any) => unknown;
  function requireUser(handler: RouteHandler): RouteHandler {
    return async (request, reply) => {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
        return reply.unauthorized("Authentication required");
      }
      if (!authVerifier) return reply.serviceUnavailable("Authentication is unavailable");

      let user;
      try {
        user = await authVerifier.verifyAccessToken(authorization.slice(7));
      } catch {
        request.log.warn("Supabase Auth token verification failed");
        return reply.serviceUnavailable("Authentication is temporarily unavailable");
      }
      if (!user) return reply.unauthorized("Invalid or expired authentication token");

      request.authUser = user;
      return withAuthenticatedUser(
        {
          userId: user.id,
          accessToken: authorization.slice(7),
          email: user.email,
        },
        () => handler(request, reply),
      );
    };
  }

  function requireAdmin(handler: RouteHandler): RouteHandler {
    return async (request, reply) => {
      const authorization = authorizeAdmin(request.headers.authorization);
      if (authorization === "unconfigured")
        return reply.serviceUnavailable("Admin access is unavailable");
      if (!authorization) return reply.unauthorized("Admin token required");
      return handler(request, reply);
    };
  }

  async function consumeQuota(userId: string, key: UserQuotaKey, reply: any) {
    let entitlements;
    try {
      entitlements = await billingService.getEffectiveEntitlements(userId);
    } catch {
      reply.serviceUnavailable("Account entitlements are temporarily unavailable");
      return false;
    }
    if (!entitlements.enabled) {
      reply.forbidden("This account is disabled");
      return false;
    }
    const featureKey = {
      research: "research",
      deep_research: "deepResearch",
      followup: "postFollowUps",
    }[key];
    const definition =
      entitlements.features[featureKey] === false ? undefined : entitlements.limits[key];
    if (!definition) {
      reply.forbidden("This capability is not enabled for this account");
      return false;
    }
    const result = await store.consumeUserQuota(
      userId,
      key,
      definition.windowSeconds,
      definition.limit,
    );
    if (result.allowed) return true;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((Date.parse(result.resetsAt) - Date.now()) / 1000),
    );
    reply.header("Retry-After", retryAfterSeconds);
    reply.code(429).send({
      error: "Usage limit reached for this time window",
      quota: key,
      used: result.used,
      limit: definition.limit,
      resetsAt: result.resetsAt,
      retryAfterSeconds,
    });
    return false;
  }

  const requestSchema = z.object({
    question: z.string().trim().min(4).max(2000),
    mode: z.enum(["quick", "deep"]).default("quick"),
  });
  const clarificationSchema = z.object({ answer: z.string().trim().min(1).max(1000) });
  const chatSchema = z.object({
    message: z.string().trim().min(1).max(2000),
    deepResearch: z.boolean().default(false),
  });

  function queuedResearchSnapshot(job: DurableJob): ResearchSession {
    const payload = job.payload;
    const mode: ResearchMode = payload.mode === "deep" ? "deep" : "quick";
    const progressStatus = job.progress.researchStatus;
    const resultStatus = job.result?.status;
    let status: ResearchStatus;
    if (job.status === "queued" || job.status === "retrying") status = "QUEUED";
    else if (job.status === "cancel_requested" || job.status === "cancelled") status = "CANCELLED";
    else if (job.status === "failed") status = "FAILED";
    else if (job.status === "completed") {
      status = (typeof resultStatus === "string" ? resultStatus : "COMPLETED") as ResearchStatus;
    } else {
      status = (typeof progressStatus === "string" ? progressStatus : "PLANNING") as ResearchStatus;
    }
    return {
      id: typeof payload.sessionId === "string" ? payload.sessionId : job.id,
      question: typeof payload.question === "string" ? payload.question : "Research request queued",
      mode,
      status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      seedResults: Array.isArray(payload.seedResults)
        ? (payload.seedResults as unknown as SearchResult[])
        : [],
      sources: [],
      claims: [],
      conflicts: [],
      decisions: [],
      steps: [],
      error: job.errorSummary,
    };
  }

  async function researchJob(id: string, ownerId: string, session?: ResearchSession) {
    return (
      (await jobStore.getJobForSession(id, ownerId)) ??
      (session?.executionJobId
        ? await jobStore.getOwnedJob(session.executionJobId, ownerId)
        : undefined)
    );
  }

  async function researchSnapshot(
    session: ResearchSession | undefined,
    job: DurableJob | undefined,
  ): Promise<ResearchSession | undefined> {
    if (!job) return session;
    if (!session) return job.payload.task === "followup" ? undefined : queuedResearchSnapshot(job);
    const terminal = ["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(
      session.status,
    );
    if (
      !terminal &&
      session.executionLeaseGeneration !== undefined &&
      session.executionLeaseGeneration < job.leaseGeneration &&
      session.id !== job.payload.sessionId
    ) {
      const superseded = {
        ...session,
        status: "FAILED" as const,
        updatedAt: job.updatedAt,
        error: "Research attempt was superseded by a recovered worker",
      };
      await store.update(superseded);
      return superseded;
    }
    if (["queued", "retrying"].includes(job.status))
      return session.id === job.payload.sessionId
        ? queuedResearchSnapshot(job)
        : terminal
          ? session
          : { ...session, status: "QUEUED", updatedAt: job.updatedAt };
    if (["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(session.status))
      return session;
    if (["failed", "cancelled", "cancel_requested"].includes(job.status)) {
      const terminal = {
        ...session,
        status: job.status === "failed" ? ("FAILED" as const) : ("CANCELLED" as const),
        updatedAt: job.updatedAt,
        error:
          job.errorSummary ??
          (job.status === "failed" ? "Worker job failed" : "Research cancelled"),
      };
      await store.update(terminal);
      return terminal;
    }
    if (job.status === "completed") {
      const terminal = {
        ...session,
        status: "FAILED" as const,
        updatedAt: job.updatedAt,
        error: "Worker finished without a terminal research result",
      };
      await store.update(terminal);
      return terminal;
    }
    return session;
  }

  function publicJob(job: DurableJob) {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      availableAt: job.availableAt,
      progress: job.progress,
      result: job.result,
      errorSummary: job.errorSummary,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  async function enqueueResearchJob(input: {
    ownerId: string;
    question: string;
    mode: ResearchMode;
    seedResults?: SearchResult[];
    memoryContext?: string;
    interpretation?: QueryInterpretation;
    researchChatOptimization?: boolean;
    allowSnippetEvidence?: boolean;
    resume?: boolean;
    sessionId?: string;
    idempotencyKey?: string;
    chargeQuota?: boolean;
    quotaKey?: UserQuotaKey;
    taskPayload?: Record<string, JobJsonValue>;
  }): Promise<{
    job?: DurableJob;
    quota?: { allowed: boolean; used: number; resetsAt: string };
    blocked?: "account" | "capability" | "unavailable";
    quotaLimit?: number;
  }> {
    const ownerScope = `user:${input.ownerId}`;
    const id = input.idempotencyKey
      ? createIdempotentJobId(ownerScope, input.idempotencyKey)
      : createJobId();
    const payload: Record<string, JobJsonValue> = {
      sessionId: input.sessionId ?? id,
      question: input.question,
      mode: input.mode,
      seedResults: (input.seedResults ?? []) as unknown as JobJsonValue,
      allowSnippetEvidence: input.allowSnippetEvidence !== false,
      resume: input.resume === true,
      ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
      ...(isQueryInterpretation(input.interpretation)
        ? {
            interpretation: JSON.parse(JSON.stringify(input.interpretation)) as JobJsonValue,
          }
        : {}),
      ...(input.researchChatOptimization ? { researchChatOptimization: true } : {}),
      ...input.taskPayload,
    };
    let quota:
      { ownerId: string; key: UserQuotaKey; windowSeconds: number; limit: number } | undefined;
    let quotaLimit: number | undefined;
    if (input.chargeQuota) {
      let entitlements;
      try {
        entitlements = await billingService.getEffectiveEntitlements(input.ownerId);
      } catch {
        return { blocked: "unavailable" };
      }
      if (!entitlements.enabled) return { blocked: "account" };
      const key: UserQuotaKey =
        input.quotaKey ?? (input.mode === "deep" ? "deep_research" : "research");
      const featureKey =
        key === "deep_research"
          ? "deepResearch"
          : key === "followup"
            ? "postFollowUps"
            : "research";
      const definition =
        entitlements.features[featureKey] === false ? undefined : entitlements.limits[key];
      if (!definition) return { blocked: "capability" as const };
      quotaLimit = definition.limit;
      quota = {
        ownerId: input.ownerId,
        key,
        windowSeconds: definition.windowSeconds,
        limit: definition.limit,
      };
    }
    const result = await jobStore.enqueueJob({
      id,
      kind: "research",
      ownerId: input.ownerId,
      ownerScope,
      idempotencyKey: input.idempotencyKey,
      payload,
      maxAttempts: 3,
      quota,
    });
    return { ...result, blocked: undefined, quotaLimit };
  }

  function readIdempotencyKey(request: any): string | undefined | null {
    const header = request.headers["idempotency-key"];
    if (header === undefined) return undefined;
    if (typeof header !== "string") return null;
    const key = header.trim();
    return key.length > 0 && key.length <= 128 ? key : null;
  }

  function sendQuotaRejection(
    result: {
      quota?: { allowed: boolean; used: number; resetsAt: string };
      quotaLimit?: number;
    },
    key: UserQuotaKey,
    reply: any,
  ) {
    if (result.quota?.allowed !== false) return false;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((Date.parse(result.quota.resetsAt) - Date.now()) / 1000),
    );
    reply.header("Retry-After", retryAfterSeconds);
    reply.code(429).send({
      error: "Usage limit reached for this time window",
      quota: key,
      used: result.quota.used,
      limit: result.quotaLimit,
      resetsAt: result.quota.resetsAt,
      retryAfterSeconds,
    });
    return true;
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "research-agent-max-api",
    time: new Date().toISOString(),
  }));

  app.get("/ready", async () => {
    // Probe persistence through an indexed, bounded lookup; never materialize all user sessions.
    await store.get("00000000-0000-0000-0000-000000000000");
    return {
      status: "ready",
      search: config.SERPER_API_KEY ? "configured" : "missing_credentials",
      searchProviders: ["serper"],
      llm: Boolean(config.OPENROUTER_API_KEY),
      persistence: persistenceProvider,
    };
  });

  app.get("/api/plans", async (_request, reply) => {
    try {
      return { plans: await billingService.listPlans() };
    } catch {
      return reply.serviceUnavailable("Plans are temporarily unavailable");
    }
  });

  app.get(
    "/api/billing/me",
    requireUser(async (request, reply) => {
      try {
        return await billingService.accountSummary(request.authUser.id);
      } catch {
        request.log.warn("Billing account summary could not be loaded");
        return reply.serviceUnavailable("Billing account is temporarily unavailable");
      }
    }),
  );

  await app.register(async (billingWebhookRoutes) => {
    billingWebhookRoutes.post<{ Params: { providerId: string } }>(
      "/api/billing/webhooks/:providerId",
      {
        preParsing: async (request, reply, payload) => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of payload) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > config.MAX_BODY_BYTES) {
              reply.code(413).send({ error: "Webhook body is too large" });
              return Readable.from([]);
            }
            chunks.push(bytes);
          }
          const rawBody = Buffer.concat(chunks, size);
          (request as typeof request & { billingRawBody?: Buffer }).billingRawBody = rawBody;
          return Readable.from([rawBody]);
        },
      },
      async (request, reply) => {
        const rawBody = (request as typeof request & { billingRawBody?: Buffer }).billingRawBody;
        if (!rawBody) return reply.badRequest("Webhook body is invalid");
        const signature = request.headers["x-billing-signature"];
        try {
          const disposition = await billingService.processWebhook(
            request.params.providerId,
            rawBody,
            typeof signature === "string" ? signature : undefined,
          );
          return reply.send({ disposition });
        } catch (error) {
          if (error instanceof BillingSignatureError)
            return reply.unauthorized("Invalid webhook signature");
          if (error instanceof BillingWebhookValidationError)
            return reply.badRequest("Invalid webhook event");
          if (error instanceof BillingWebhookVerificationError) {
            return reply.serviceUnavailable(
              "Billing webhook verification is temporarily unavailable",
            );
          }
          if (error instanceof BillingProviderNotConfiguredError) {
            return reply.serviceUnavailable("Billing provider is not configured");
          }
          request.log.warn("Billing webhook processing failed");
          return reply.serviceUnavailable("Billing webhook processing is temporarily unavailable");
        }
      },
    );
  });

  app.post(
    "/api/chat",
    requireUser(async (request, reply) => {
      const parsed = chatSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
      const idempotencyKey = readIdempotencyKey(request);
      if (idempotencyKey === null) {
        return reply.badRequest("Idempotency-Key must contain 1-128 non-whitespace characters");
      }
      const quotaKey = parsed.data.deepResearch ? "deep_research" : "research";
      if (idempotencyKey) {
        const replayId = createIdempotentJobId(`user:${request.authUser.id}`, idempotencyKey);
        const existingJob = await jobStore.getOwnedJob(replayId, request.authUser.id);
        if (existingJob) {
          const mode: ResearchMode = parsed.data.deepResearch ? "deep" : "quick";
          if (
            existingJob.kind !== "research" ||
            existingJob.payload.task !== "chat" ||
            existingJob.payload.question !== parsed.data.message ||
            existingJob.payload.mode !== mode
          ) {
            return reply.conflict("Idempotency key was already used for a different request");
          }
          const sessionId =
            typeof existingJob.payload.sessionId === "string"
              ? existingJob.payload.sessionId
              : existingJob.id;
          if ((await store.listDeletedIds?.([sessionId]))?.has(sessionId))
            return reply.notFound("Research session not found");
          const session = await store.get(sessionId);
          if (existingJob.status === "completed" && existingJob.result?.response) {
            const response = existingJob.result.response as Record<string, JobJsonValue>;
            return reply
              .code(response.route === "direct" || response.answer ? 200 : 202)
              .send({ ...response, session, sources: session?.sources });
          }
          return reply.code(202).send({
            route: mode === "deep" ? "deep" : "web",
            researchId: sessionId,
            jobId: existingJob.id,
            session: await researchSnapshot(session, existingJob),
            toolEvents: [
              {
                tool: "idempotency_replay",
                status: "complete",
                message: "Returned the existing research job without charging quota again",
                phase: "tool",
              },
            ],
            durationMs: 0,
          });
        }
      }

      const explicitMemory = extractExplicitMemoryCandidate(parsed.data.message);
      if (explicitMemory) {
        if (!memoryService.enabled) {
          return reply.serviceUnavailable("Explicit memory capture is unavailable");
        }
        try {
          await memoryService.captureExplicit(
            explicitMemory.content,
            {
              sourceType: "explicit_chat",
              sourceRef: request.id,
              capturedAt: new Date().toISOString(),
            },
            explicitMemory.category,
          );
          return reply.send(
            buildUserMemoryAcknowledgement(
              "Saved this for future relevant conversations.",
              "saved",
            ),
          );
        } catch (error) {
          if (error instanceof SensitiveMemoryError) {
            return reply.send(
              buildUserMemoryAcknowledgement(
                "I can't store passwords, API keys, tokens, or other credentials as memory.",
                "rejected",
              ),
            );
          }
          if (error instanceof MemoryLimitError) {
            return reply.conflict(error.message);
          }
          request.log.warn("Explicit memory capture failed; no memory was stored");
          return reply.serviceUnavailable("Could not save this memory");
        }
      }

      let memoryContext: string | undefined;
      let memoryToolEvent:
        { tool: string; status: "complete" | "failed"; message: string; phase: "tool" } | undefined;
      try {
        const retrieval = await memoryService.retrieveForQuestion(parsed.data.message);
        if (retrieval.needed) {
          memoryContext = retrieval.context;
          memoryToolEvent = {
            tool: "memory_retrieval",
            status: "complete",
            message: retrieval.memories.length
              ? `Applied ${retrieval.memories.length} relevant saved context item(s)`
              : "No sufficiently relevant saved context found",
            phase: "tool",
          };
        }
      } catch {
        memoryToolEvent = {
          tool: "memory_retrieval",
          status: "failed",
          message: "Memory retrieval was unavailable; continuing without saved context",
          phase: "tool",
        };
        request.log.warn("Memory retrieval failed; continuing without saved context");
      }

      const preview = await agent.preview(parsed.data.message, parsed.data.deepResearch);
      const queued = await enqueueResearchJob({
        ownerId: request.authUser.id,
        question: parsed.data.message,
        mode: parsed.data.deepResearch ? "deep" : "quick",
        memoryContext,
        interpretation: preview.interpretation,
        researchChatOptimization: true,
        idempotencyKey,
        chargeQuota: true,
        taskPayload: {
          task: "chat",
          ...(memoryToolEvent
            ? { memoryToolEvent: memoryToolEvent as unknown as JobJsonValue }
            : {}),
        },
      });
      if (queued.blocked === "account") return reply.forbidden("This account is disabled");
      if (queued.blocked === "capability")
        return reply.forbidden("This capability is not enabled for this account");
      if (queued.blocked === "unavailable")
        return reply.serviceUnavailable("Account entitlements are temporarily unavailable");
      if (sendQuotaRejection(queued, quotaKey, reply)) return reply;
      if (!queued.job) return reply.internalServerError("Could not persist chat request");
      // Fast responses still return inline. Slow work continues under a durable lease
      // and clients can follow the same research stream used by queued research.
      if (preview.decision.effort !== "high") {
        const execution = queueWorker.runNow(queued.job.id).catch(() => undefined);
        await Promise.race([execution, new Promise((resolve) => setTimeout(resolve, 250))]);
      }
      const current = await jobStore.getOwnedJob(queued.job.id, request.authUser.id);
      const session = await store.get(String(queued.job.payload.sessionId));
      if (current?.status === "completed" && current.result?.response) {
        const response = current.result.response as Record<string, JobJsonValue>;
        return reply
          .code(response.route === "direct" || response.answer ? 200 : 202)
          .send({ ...response, session, sources: session?.sources });
      }
      return reply
        .code(202)
        .send({
          route: parsed.data.deepResearch ? "deep" : "web",
          interpretation: preview.interpretation,
          researchId: queued.job.payload.sessionId,
          jobId: queued.job.id,
          session: await researchSnapshot(session, current ?? queued.job),
          toolEvents: memoryToolEvent ? [memoryToolEvent] : [],
        });
    }),
  );

  const memoryCreateSchema = z
    .object({
      text: z.string().trim().min(8).max(config.MEMORY_MAX_TEXT_CHARS),
      category: z.enum(USER_MEMORY_CATEGORIES).optional(),
    })
    .strict();
  const memoryUpdateSchema = z
    .object({
      text: z.string().trim().min(8).max(config.MEMORY_MAX_TEXT_CHARS).optional(),
      category: z.enum(USER_MEMORY_CATEGORIES).optional(),
      importance: z.number().min(0).max(1).optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one update field is required");

  app.get(
    "/api/memories",
    requireUser(async (request) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(50),
          includeInactive: z.enum(["true", "false"]).default("false"),
        })
        .safeParse(request.query);
      if (!query.success) throw app.httpErrors.badRequest("Invalid memory list options");
      return memoryService.list(query.data.limit, query.data.includeInactive === "true");
    }),
  );

  app.post(
    "/api/memories",
    requireUser(async (request, reply) => {
      const parsed = memoryCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
      if (!memoryService.enabled) return reply.serviceUnavailable("Semantic memory is unavailable");
      try {
        const result = await memoryService.captureExplicit(
          parsed.data.text,
          {
            sourceType: "explicit_api",
            sourceRef: request.id,
            capturedAt: new Date().toISOString(),
          },
          parsed.data.category,
        );
        return reply.code(result.inserted ? 201 : 200).send({
          memory: result.memory,
          created: result.inserted,
        });
      } catch (error) {
        if (error instanceof SensitiveMemoryError) return reply.badRequest(error.message);
        if (error instanceof MemoryLimitError) return reply.conflict(error.message);
        request.log.warn("Explicit memory creation failed");
        return reply.serviceUnavailable("Could not create semantic memory");
      }
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/memories/:id",
    requireUser(async (request, reply) => {
      const memory = await memoryService.get(request.params.id);
      return memory ? memory : reply.notFound("Memory not found");
    }),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/memories/:id",
    requireUser(async (request, reply) => {
      const parsed = memoryUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
      try {
        const memory = await memoryService.update(request.params.id, {
          text: parsed.data.text,
          category: parsed.data.category,
          importance: parsed.data.importance,
          isActive: parsed.data.isActive,
        });
        return memory ? memory : reply.notFound("Memory not found");
      } catch (error) {
        if (error instanceof SensitiveMemoryError) return reply.badRequest(error.message);
        if (error instanceof DuplicateMemoryError) return reply.conflict(error.message);
        if (error instanceof MemoryLimitError) return reply.conflict(error.message);
        request.log.warn("Memory update failed");
        return reply.serviceUnavailable("Could not update memory");
      }
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/memories/:id",
    requireUser(async (request, reply) => {
      const deleted = await memoryService.delete(request.params.id);
      return deleted ? reply.code(204).send() : reply.notFound("Memory not found");
    }),
  );

  app.post(
    "/api/research",
    requireUser(async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
      const quotaKey = parsed.data.mode === "deep" ? "deep_research" : "research";
      const idempotencyKey = readIdempotencyKey(request);
      if (idempotencyKey === null) {
        return reply.badRequest("Idempotency-Key must contain 1-128 non-whitespace characters");
      }
      const queued = await enqueueResearchJob({
        ownerId: request.authUser.id,
        question: parsed.data.question,
        mode: parsed.data.mode,
        idempotencyKey,
        chargeQuota: true,
      });
      if (queued.blocked === "account") return reply.forbidden("This account is disabled");
      if (queued.blocked === "capability") {
        return reply.forbidden("This capability is not enabled for this account");
      }
      if (queued.blocked === "unavailable") {
        return reply.serviceUnavailable("Account entitlements are temporarily unavailable");
      }
      if (sendQuotaRejection(queued, quotaKey, reply)) return reply;
      if (!queued.job) return reply.internalServerError("Could not persist research job");
      return reply.code(202).send({
        id: String(queued.job.payload.sessionId),
        jobId: queued.job.id,
        status: queued.job.status,
      });
    }),
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/api/research",
    requireUser(async (request, reply) => {
      const parsedQuery = researchSessionListQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) return reply.badRequest("Invalid research pagination parameters");
      const cursor = parsedQuery.data.cursor
        ? decodeResearchSessionCursor(parsedQuery.data.cursor)
        : undefined;
      if (parsedQuery.data.cursor && !cursor) {
        return reply.badRequest("Invalid research pagination cursor");
      }
      const { limit } = parsedQuery.data;
      const [sessionRows, jobs] = await Promise.all([
        store.list(limit + 1, cursor),
        jobStore.listOwnedJobs(request.authUser.id, 100),
      ]);
      const hasMore = sessionRows.length > limit;
      const sessions = sessionRows.slice(0, limit);
      if (hasMore) {
        const lastSession = sessions.at(-1);
        if (lastSession) {
          reply.header(
            "X-Next-Cursor",
            encodeResearchSessionCursor({ createdAt: lastSession.createdAt, id: lastSession.id }),
          );
        }
      }
      const jobSessionIds = jobs.flatMap((job) =>
        typeof job.payload.sessionId === "string" ? [job.payload.sessionId] : [],
      );
      const persistedJobSessionIds = await store.listExistingIds(jobSessionIds);
      const deletedSessionIds = (await store.listDeletedIds?.(jobSessionIds)) ?? new Set<string>();
      const detachedActiveJobs = cursor
        ? []
        : jobs.filter((job) => {
            const sessionId = job.payload.sessionId;
            return (
              job.kind === "research" &&
              job.payload.task !== "followup" &&
              typeof sessionId === "string" &&
              !deletedSessionIds.has(sessionId) &&
              !persistedJobSessionIds.has(sessionId)
            );
          });
      const activeJobsBySession = new Map<string, DurableJob>();
      for (const job of jobs) {
        if (
          job.kind === "research" &&
          job.payload.task !== "followup" &&
          typeof job.payload.sessionId === "string" &&
          !activeJobsBySession.has(job.payload.sessionId)
        ) {
          activeJobsBySession.set(job.payload.sessionId, job);
        }
      }
      return [
        ...(await Promise.all(
          sessions.map(async (session) => {
            const job =
              activeJobsBySession.get(session.id) ??
              jobs.find((candidate) => candidate.id === session.executionJobId);
            return (await researchSnapshot(session, job))!;
          }),
        )),
        ...detachedActiveJobs.map(queuedResearchSnapshot),
      ];
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/research/:id",
    requireUser(async (request, reply) => {
      if ((await store.listDeletedIds?.([request.params.id]))?.has(request.params.id))
        return reply.notFound("Research session not found");
      const session = await store.get(request.params.id);
      const job = await researchJob(request.params.id, request.authUser.id, session);
      if (!session && job?.payload.task === "followup")
        return reply.notFound("Research session not found");
      if (!session && !job) return reply.notFound("Research session not found");
      return researchSnapshot(session, job);
    }),
  );

  app.get(
    "/api/jobs",
    requireUser(async (request) =>
      (await jobStore.listOwnedJobs(request.authUser.id, 100)).map(publicJob),
    ),
  );

  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id",
    requireUser(async (request, reply) => {
      const job = await jobStore.getOwnedJob(request.params.id, request.authUser.id);
      return job ? publicJob(job) : reply.notFound("Job not found");
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/cancel",
    requireUser(async (request, reply) => {
      const job = await jobStore.cancelJob(request.params.id, request.authUser.id);
      if (!job) return reply.notFound("Job not found");
      if (job.kind === "research" && typeof job.payload.sessionId === "string") {
        const session = await store.get(job.payload.sessionId);
        if (session && !["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) {
          await runner.cancel(session.id);
        }
      }
      return publicJob(job);
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/research/:id/clarify",
    requireUser(async (request, reply) => {
      const parsed = clarificationSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(JSON.stringify(parsed.error.flatten()));
      const current = await store.get(request.params.id);
      if (!current || current.status !== "NEEDS_CLARIFICATION")
        return reply.notFound("Clarification is not available for this research session");
      const quotaKey = current.mode === "deep" ? "deep_research" : "research";
      const idempotencyKey = readIdempotencyKey(request);
      if (idempotencyKey === null) {
        return reply.badRequest("Idempotency-Key must contain 1-128 non-whitespace characters");
      }
      let researchChatOptimization = false;
      try {
        const previousJob = await jobStore.getJobForSession(current.id, request.authUser.id);
        researchChatOptimization = previousJob?.payload.researchChatOptimization === true;
      } catch {
        request.log.warn(
          "Could not recover Research Chat policy for clarification; using the default research policy",
        );
      }
      const queued = await enqueueResearchJob({
        ownerId: request.authUser.id,
        question: `${current.question}\nClarification: ${parsed.data.answer}`,
        mode: current.mode,
        seedResults: current.seedResults,
        resume: true,
        researchChatOptimization,
        sessionId: current.id,
        idempotencyKey,
        chargeQuota: true,
      });
      if (queued.blocked === "account") return reply.forbidden("This account is disabled");
      if (queued.blocked === "capability") {
        return reply.forbidden("This capability is not enabled for this account");
      }
      if (queued.blocked === "unavailable") {
        return reply.serviceUnavailable("Account entitlements are temporarily unavailable");
      }
      if (sendQuotaRejection(queued, quotaKey, reply)) return reply;
      if (!queued.job) return reply.internalServerError("Could not persist clarification job");
      return reply.code(202).send({
        id: current.id,
        jobId: queued.job.id,
        status: queued.job.status,
      });
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/research/:id/cancel",
    requireUser(async (request, reply) => {
      const job = await researchJob(
        request.params.id,
        request.authUser.id,
        await store.get(request.params.id),
      );
      if (job) {
        const cancelled = await jobStore.cancelJob(job.id, request.authUser.id);
        const session = await store.get(request.params.id);
        if (session && !["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) {
          await runner.cancel(session.id);
        }
        return reply.code(200).send({
          id: request.params.id,
          jobId: job.id,
          status: session?.status ?? cancelled?.status,
        });
      }
      const session = await runner.cancel(request.params.id);
      return session
        ? reply.code(200).send({ id: session.id, status: session.status })
        : reply.notFound("Research session not found");
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/research/:id",
    requireUser(async (request, reply) => {
      const session = await store.get(request.params.id);
      const job = await researchJob(request.params.id, request.authUser.id, session);
      if (!session && (!job || job.payload.task === "followup"))
        return reply.notFound("Research session not found");
      if (job && ["queued", "retrying", "running", "cancel_requested"].includes(job.status)) {
        await jobStore.cancelJob(job.id, request.authUser.id);
        if (session && !["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) {
          await runner.cancel(session.id);
        }
      }
      await store.delete(request.params.id);
      return reply.code(204).send();
    }),
  );

  const exportManagementView = (record: ExportRecord) => ({
    id: record.id,
    resourceType: record.resourceType,
    format: record.format,
    status: record.status,
    fileName: record.fileName,
    contentType: record.contentType,
    outputBytes: record.outputBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    downloadUrl: record.status === "completed" ? `/api/exports/${record.id}/download` : undefined,
  });

  const addPrivateExportHeaders = (reply: any) => {
    void reply.header("Cache-Control", "private, no-store, max-age=0");
    void reply.header("Pragma", "no-cache");
  };

  app.post(
    "/api/exports",
    requireUser(async (request, reply) => {
      const parsed = z
        .object({
          resourceType: z.enum(["research_session", "published_post"]),
          resourceId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
          format: z.enum(["markdown", "json", "pdf"]),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) return reply.badRequest("Invalid export request");

      const ownerId = request.authUser.id;
      const resourceType = parsed.data.resourceType as ExportResourceType;
      const format = parsed.data.format as ExportFormat;
      const resourceId = parsed.data.resourceId;
      const requestedAt = new Date().toISOString();
      app.log.info(
        { event: "export.requested", resourceType, format },
        "Owner requested an export",
      );

      try {
        let projection: ExportProjection | undefined;
        if (resourceType === "research_session") {
          const session = await store.get(resourceId);
          if (!session) return reply.notFound("Exportable resource not found");
          if (session.status !== "COMPLETED" || !session.answer?.trim()) {
            return reply.conflict("Only completed research results can be exported");
          }
          projection = createExportProjection({ resourceType, session });
        } else {
          const post = await store.getPublishedPost(resourceId);
          if (!post) return reply.notFound("Exportable resource not found");
          const session = await store.get(post.researchId);
          if (!session || session.status !== "COMPLETED") {
            return reply.notFound("Exportable resource not found");
          }
          projection = createExportProjection({ resourceType, post, session });
        }
        if (!projection) return reply.unprocessableEntity("Resource cannot be exported safely");

        const snapshotHash = hashExportProjection(projection);
        const fileName = sanitizeExportFileName(projection.title, format);
        const created = await store.createExport({
          id: randomUUID(),
          ownerId,
          resourceType,
          resourceId,
          format,
          snapshotHash,
          fileName,
          contentType: exportMimeType(format),
          attempts: 1,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        });
        let exportRecord = created.record;
        let shouldRender = created.created;

        if (!created.created && exportRecord.status === "completed") {
          addPrivateExportHeaders(reply);
          return reply.code(200).send(exportManagementView(exportRecord));
        }
        if (!created.created && exportRecord.status === "failed") {
          shouldRender = await store.retryFailedExport(exportRecord.id, ownerId, requestedAt);
        } else if (!created.created && exportRecord.status === "pending") {
          const staleBefore = new Date(Date.parse(requestedAt) - 30_000).toISOString();
          shouldRender = await store.reclaimStaleExport(
            exportRecord.id,
            ownerId,
            staleBefore,
            requestedAt,
          );
        }
        if (!shouldRender) {
          addPrivateExportHeaders(reply);
          if (exportRecord.attempts >= MAX_EXPORT_ATTEMPTS) {
            return reply.code(409).send({ error: "The export retry limit has been reached" });
          }
          return reply.code(409).send({ error: "This export is already being prepared" });
        }
        exportRecord = (await store.getExport(exportRecord.id, ownerId)) ?? exportRecord;
        const startedAt = Date.now();
        app.log.info(
          { event: "export.started", exportId: exportRecord.id, resourceType, format },
          "Export rendering started",
        );

        try {
          const bytes = await renderExportBytes(projection, format, exportPdfRenderer);
          if (bytes.length < 1 || bytes.length > MAX_EXPORT_OUTPUT_BYTES) {
            throw new Error("output_limit");
          }
          if (format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
            throw new Error("renderer_failed");
          }
          const completedAt = new Date().toISOString();
          const completed = await store.completeExport(exportRecord.id, ownerId, {
            payloadBase64: bytes.toString("base64"),
            outputBytes: bytes.length,
            completedAt,
            updatedAt: completedAt,
          });
          if (!completed) {
            const winner = await store.getExport(exportRecord.id, ownerId);
            if (!winner || winner.status !== "completed") {
              throw new Error("persistence_failed");
            }
            exportRecord = winner;
          } else {
            exportRecord = (await store.getExport(exportRecord.id, ownerId)) ?? exportRecord;
          }
          app.log.info(
            {
              event: "export.completed",
              exportId: exportRecord.id,
              resourceType,
              format,
              outputBytes: bytes.length,
              durationMs: Date.now() - startedAt,
            },
            "Export rendering completed",
          );
        } catch (error) {
          const errorText = error instanceof Error ? error.message : "";
          const failureReason = /render time limit/i.test(errorText)
            ? "pdf_render_timeout"
            : /output size limit|output_limit/i.test(errorText)
              ? "output_limit"
              : "renderer_failed";
          try {
            await store.failExport(
              exportRecord.id,
              ownerId,
              new Date().toISOString(),
              failureReason,
            );
          } catch {
            // The API response remains fail-closed if even failure persistence is unavailable.
          }
          app.log.error(
            {
              event: "export.failed",
              exportId: exportRecord.id,
              resourceType,
              format,
              failureReason,
              errorType: error instanceof Error ? error.name : "unknown",
              durationMs: Date.now() - startedAt,
            },
            "Export rendering failed",
          );
          addPrivateExportHeaders(reply);
          return reply.code(503).send({
            error: "The export could not be created",
            exportId: exportRecord.id,
            status: "failed",
          });
        }

        addPrivateExportHeaders(reply);
        return reply.code(created.created ? 201 : 200).send(exportManagementView(exportRecord));
      } catch (error) {
        request.log.error(
          {
            event: "export.failed",
            resourceType,
            format,
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Export persistence or projection failed",
        );
        addPrivateExportHeaders(reply);
        return reply.serviceUnavailable("Export storage is temporarily unavailable");
      }
    }),
  );

  app.get(
    "/api/exports",
    requireUser(async (request, reply) => {
      try {
        const records = await store.listExports(request.authUser.id, 100);
        addPrivateExportHeaders(reply);
        return { exports: records.map(exportManagementView) };
      } catch (error) {
        request.log.error(
          {
            event: "export.list_failed",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Could not list exports",
        );
        return reply.serviceUnavailable("Export storage is temporarily unavailable");
      }
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/exports/:id",
    requireUser(async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.notFound("Export not found");
      }
      try {
        const record = await store.getExport(request.params.id, request.authUser.id);
        if (!record) return reply.notFound("Export not found");
        addPrivateExportHeaders(reply);
        return exportManagementView(record);
      } catch (error) {
        request.log.error(
          {
            event: "export.read_failed",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Could not read export metadata",
        );
        return reply.serviceUnavailable("Export storage is temporarily unavailable");
      }
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/exports/:id/download",
    requireUser(async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.notFound("Export not found");
      }
      try {
        const record = await store.getExport(request.params.id, request.authUser.id);
        if (!record) return reply.notFound("Export not found");
        if (record.status !== "completed" || !record.payloadBase64 || !record.outputBytes) {
          return reply.conflict("Export is not ready to download");
        }
        const fileNameValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,91}\.(?:md|json|pdf)$/.test(
          record.fileName,
        );
        if (!fileNameValid) return reply.serviceUnavailable("Stored export metadata is invalid");
        const bytes = Buffer.from(record.payloadBase64, "base64");
        if (
          bytes.length !== record.outputBytes ||
          bytes.length > MAX_EXPORT_OUTPUT_BYTES ||
          bytes.toString("base64") !== record.payloadBase64
        ) {
          return reply.serviceUnavailable("Stored export content is invalid");
        }
        if (record.format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
          return reply.serviceUnavailable("Stored export content is invalid");
        }
        addPrivateExportHeaders(reply);
        void reply.header("Content-Disposition", `attachment; filename="${record.fileName}"`);
        void reply.header("Content-Length", bytes.length);
        void reply.header("X-Content-Type-Options", "nosniff");
        app.log.info(
          {
            event: "export.downloaded",
            exportId: record.id,
            format: record.format,
            outputBytes: bytes.length,
          },
          "Owner downloaded export",
        );
        return reply.type(record.contentType).send(bytes);
      } catch (error) {
        request.log.error(
          {
            event: "export.download_failed",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Could not download export",
        );
        return reply.serviceUnavailable("Export storage is temporarily unavailable");
      }
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/exports/:id",
    requireUser(async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.notFound("Export not found");
      }
      try {
        if (!(await store.deleteExport(request.params.id, request.authUser.id))) {
          return reply.notFound("Export not found");
        }
        addPrivateExportHeaders(reply);
        return reply.code(204).send();
      } catch (error) {
        request.log.error(
          {
            event: "export.delete_failed",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Could not delete export",
        );
        return reply.serviceUnavailable("Export storage is temporarily unavailable");
      }
    }),
  );

  const shareManagementView = (share: ShareMetadata) => ({
    id: share.id,
    resourceType: share.resourceType,
    resourceId: share.resourceId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    lastAccessedAt: share.lastAccessedAt,
  });

  app.post(
    "/api/shares",
    requireUser(async (request, reply) => {
      const parsed = z
        .object({
          resourceType: z.enum(["research_session", "published_post"]),
          resourceId: z.string().trim().min(1).max(200),
          expiresInDays: z.number().int().min(1).max(90).default(30),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) return reply.badRequest("Invalid share request");

      const ownerId = request.authUser.id;
      if (parsed.data.resourceType === "research_session") {
        const session = await store.get(parsed.data.resourceId);
        if (!session || !projectResearchForSharing(session)) {
          return reply.notFound("Shareable resource not found");
        }
      } else {
        const post = await store.getPublishedPost(parsed.data.resourceId);
        const ownerSession = post
          ? await withResearchOwner(ownerId, () => store.get(post.researchId))
          : undefined;
        if (
          !post ||
          !projectPostForSharing(post) ||
          !ownerSession ||
          ownerSession.status !== "COMPLETED"
        ) {
          return reply.notFound("Shareable resource not found");
        }
      }

      const now = new Date();
      const token = createShareToken();
      const share = await store.createShare({
        id: randomUUID(),
        ownerId,
        resourceType: parsed.data.resourceType,
        resourceId: parsed.data.resourceId,
        tokenHash: hashShareToken(token),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000).toISOString(),
      });
      app.log.info(
        { event: "share.create", resourceType: share.resourceType },
        "Share link created",
      );
      return reply.code(201).send({
        ...shareManagementView(share),
        url: new URL(`/api/share/${token}`, config.APP_URL).toString(),
        token,
      });
    }),
  );

  app.get(
    "/api/shares",
    requireUser(async (request) => {
      const shares = await store.listShares(request.authUser.id, 100);
      return shares.map(shareManagementView);
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/shares/:id",
    requireUser(async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.notFound("Share not found");
      }
      const revoked = await store.revokeShare(
        request.params.id,
        request.authUser.id,
        new Date().toISOString(),
      );
      if (!revoked) return reply.notFound("Share not found");
      app.log.info({ event: "share.revoke" }, "Share link revoked");
      return reply.code(204).send();
    }),
  );

  app.get<{ Params: { token: string } }>(
    "/api/share/:token",
    { logLevel: "silent" },
    async (request, reply) => {
      void reply.header("Cache-Control", "private, no-store, max-age=0");
      void reply.header("Pragma", "no-cache");
      const allowance = dependencies.shareResolveRateLimiter
        ? shareResolveLimiter.check(request.ip || "127.0.0.1")
        : await checkRateLimit("share", request.ip || "127.0.0.1", 60_000, 30, shareResolveLimiter);
      void reply.header("X-RateLimit-Limit", allowance.limit);
      void reply.header("X-RateLimit-Remaining", allowance.remaining);
      if (!allowance.allowed) {
        const retryAfter = Math.max(1, Math.ceil(allowance.resetMs / 1000));
        void reply.header("Retry-After", retryAfter);
        app.log.warn({ event: "share.resolve", outcome: "rate_limited" }, "Share resolve limited");
        return reply.code(429).send({ error: "Too many requests. Please try again later." });
      }

      if (!isShareToken(request.params.token)) {
        app.log.info({ event: "share.resolve", outcome: "not_found" }, "Share link unavailable");
        return reply.notFound("Share not found");
      }

      try {
        const checkedAt = new Date().toISOString();
        const tokenHash = hashShareToken(request.params.token);
        const share = await store.resolveShare(tokenHash, checkedAt);
        if (!share) {
          const reason = await store.classifyShareFailure(tokenHash, checkedAt);
          if (reason === "expired") {
            app.log.info({ event: "share.expiry_rejected" }, "Expired share link rejected");
          } else {
            app.log.info(
              { event: "share.resolve", outcome: reason === "revoked" ? "revoked" : "not_found" },
              "Share link unavailable",
            );
          }
          return reply.notFound("Share not found");
        }

        let sharedContent;
        if (share.resourceType === "research_session") {
          const session = await withResearchOwner(share.ownerId, () => store.get(share.resourceId));
          sharedContent = session ? projectResearchForSharing(session) : undefined;
        } else {
          const post = await store.getPublishedPost(share.resourceId);
          const ownerSession = post
            ? await withResearchOwner(share.ownerId, () => store.get(post.researchId))
            : undefined;
          sharedContent =
            post && ownerSession?.status === "COMPLETED" ? projectPostForSharing(post) : undefined;
        }
        if (!sharedContent) {
          app.log.info(
            { event: "share.resolve", outcome: "resource_unavailable" },
            "Share resource unavailable",
          );
          return reply.notFound("Share not found");
        }
        app.log.info(
          { event: "share.resolve", outcome: "success", resourceType: share.resourceType },
          "Share link resolved",
        );
        return reply.send(sharedContent);
      } catch (error) {
        app.log.error(
          {
            event: "share.resolve",
            outcome: "error",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "Share resolution failed",
        );
        return reply.serviceUnavailable("Shared content is temporarily unavailable");
      }
    },
  );

  app.get("/api/discover", async () =>
    (await store.listPublishedPosts(50)).flatMap((post) => {
      const projection = projectPostForPublicApi(post);
      return projection ? [projection] : [];
    }),
  );
  app.get<{ Params: { id: string } }>("/api/posts/:id", async (request, reply) => {
    const post = await store.getPublishedPost(request.params.id);
    const projection = post ? projectPostForPublicApi(post) : undefined;
    return projection ?? reply.notFound("Research post not found");
  });
  app.post<{ Params: { id: string } }>(
    "/api/posts/:id/ask",
    requireUser(async (request, reply) => {
      const allowance = await checkRateLimit(
        "followup",
        request.authUser.id,
        60_000,
        5,
        followUpLimiter,
      );
      if (!allowance.allowed) return reply.tooManyRequests("Too many post follow-up requests");
      const parsed = z
        .object({ question: z.string().trim().min(4).max(1000) })
        .safeParse(request.body);
      if (!parsed.success) return reply.badRequest("A question of 4-1000 characters is required");
      try {
        if (!(await store.getPublishedPost(request.params.id)))
          return reply.notFound("Research post not found");
        const idempotencyKey = readIdempotencyKey(request);
        if (idempotencyKey === null) return reply.badRequest("Invalid Idempotency-Key");
        const queued = await enqueueResearchJob({
          ownerId: request.authUser.id,
          question: parsed.data.question,
          mode: "quick",
          chargeQuota: true,
          quotaKey: "followup",
          idempotencyKey,
          taskPayload: { task: "followup", postId: request.params.id },
        });
        if (queued.blocked === "account" || queued.blocked === "capability")
          return reply.forbidden("Follow-ups are not enabled for this account");
        if (queued.blocked === "unavailable")
          return reply.serviceUnavailable("Account entitlements are temporarily unavailable");
        if (sendQuotaRejection(queued, "followup", reply)) return reply;
        if (!queued.job) return reply.internalServerError("Could not persist follow-up request");
        return reply
          .code(202)
          .send({
            id: queued.job.id,
            postId: request.params.id,
            question: parsed.data.question,
            status: "QUEUED",
            createdAt: queued.job.createdAt,
            updatedAt: queued.job.updatedAt,
            usedLiveResearch: false,
            sourceIds: [],
          });
      } catch (error) {
        if (error instanceof ResearchPostNotFoundError)
          return reply.notFound("Research post not found");
        request.log.error({ err: error }, "Could not start research post follow-up");
        return reply.internalServerError("Could not start research follow-up");
      }
    }),
  );
  app.get<{ Params: { id: string; followUpId: string } }>(
    "/api/posts/:id/ask/:followUpId",
    requireUser(async (request, reply) => {
      let followUp = await store.getFollowUp(request.params.followUpId);
      const job = await jobStore.getOwnedJob(request.params.followUpId, request.authUser.id);
      if (job?.payload.task === "followup" && job.payload.postId === request.params.id) {
        if (!followUp)
          followUp = {
            id: job.id,
            postId: request.params.id,
            question: String(job.payload.question),
            status: "QUEUED",
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            usedLiveResearch: false,
            sourceIds: [],
          };
        if (["failed", "cancelled"].includes(job.status))
          followUp = {
            ...followUp,
            status: "FAILED",
            error: job.errorSummary ?? "Follow-up stopped",
            updatedAt: job.updatedAt,
          };
      }
      return followUp?.postId === request.params.id
        ? followUp
        : reply.notFound("Research follow-up not found");
    }),
  );
  app.get(
    "/api/topics",
    requireAdmin(async () => store.listTopics(100)),
  );
  app.get(
    "/api/autonomous/runs",
    requireAdmin(async () => store.listRuns(100)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/autonomous/runs/:id",
    requireAdmin(async (request, reply) => {
      const run = await store.getRun(request.params.id);
      return run ?? reply.notFound("Autonomous run not found");
    }),
  );

  app.post("/api/autonomous/runs", async (request, reply) => {
    const authorization = authorizeAdmin(request.headers.authorization);
    if (authorization === "unconfigured")
      return reply.serviceUnavailable("MAX_ADMIN_TOKEN is not configured");
    if (!authorization) return reply.unauthorized("Admin token required");
    const parsed = z
      .object({ topicId: z.string().uuid().optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.badRequest("Invalid autonomous run request");
    try {
      const run = await contentAgent.trigger(parsed.data.topicId);
      return reply.code(202).send(run);
    } catch (error) {
      return reply.badRequest(error instanceof Error ? error.message : "Could not queue run");
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/autonomous/runs/:id/retry",
    requireAdmin(async (request, reply) => {
      const authorization = authorizeAdmin(request.headers.authorization);
      if (authorization === "unconfigured")
        return reply.serviceUnavailable("MAX_ADMIN_TOKEN is not configured");
      if (!authorization) return reply.unauthorized("Admin token required");
      try {
        return reply.code(202).send(await contentAgent.retry(request.params.id));
      } catch (error) {
        return reply.badRequest(error instanceof Error ? error.message : "Could not retry run");
      }
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/autonomous/runs/:id/cancel",
    requireAdmin(async (request, reply) => {
      const authorization = authorizeAdmin(request.headers.authorization);
      if (authorization === "unconfigured")
        return reply.serviceUnavailable("MAX_ADMIN_TOKEN is not configured");
      if (!authorization) return reply.unauthorized("Admin token required");
      await jobStore.cancelJob(request.params.id, undefined, true);
      const run = await contentAgent.cancel(request.params.id);
      return run ?? reply.notFound("Autonomous run not found");
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/research/:id/events",
    requireUser(async (request, reply) => {
      const ownerId = request.authUser.id;
      if ((await store.listDeletedIds?.([request.params.id]))?.has(request.params.id))
        return reply.notFound("Research session not found");
      let currentSession = await store.get(request.params.id);
      let currentJob = await researchJob(request.params.id, ownerId, currentSession);
      if (!currentSession && currentJob?.payload.task === "followup")
        return reply.notFound("Research session not found");
      if (!currentSession && !currentJob) return reply.notFound("Research session not found");
      if (!currentSession && currentJob) currentSession = queuedResearchSnapshot(currentJob);
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": config.WEB_URL,
      });
      const send = (event: unknown, eventId?: string) => {
        if (eventId) response.write(`id: ${eventId}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      let closed = false;
      let lastUpdatedAt = "";
      let lastStepCount = 0;
      const onClose = () => {
        closed = true;
      };
      request.raw.on("close", onClose);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
      const terminal = (session: ResearchSession) =>
        ["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(session.status);
      try {
        while (!closed && !response.destroyed) {
          const latest = await store.get(request.params.id);
          currentJob = await researchJob(request.params.id, ownerId, latest);
          if ((await store.listDeletedIds?.([request.params.id]))?.has(request.params.id)) break;
          currentSession = await researchSnapshot(latest, currentJob);
          if (!currentSession) break;
          if (currentSession.updatedAt !== lastUpdatedAt || lastStepCount === 0) {
            send({ type: "research.snapshot", session: currentSession }, currentSession.updatedAt);
            for (const step of currentSession.steps.slice(lastStepCount)) {
              send(
                {
                  type: "research.step",
                  message: step.detail ?? step.label,
                  step,
                  session: currentSession,
                },
                step.at,
              );
            }
            lastUpdatedAt = currentSession.updatedAt;
            lastStepCount = currentSession.steps.length;
          }
          if (terminal(currentSession)) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } finally {
        clearInterval(heartbeat);
        request.raw.off("close", onClose);
        if (!response.destroyed) response.end();
      }
    }),
  );

  // Sanitized error handler: never leaks stack traces, internal paths, or API keys
  app.setErrorHandler((error, request, reply) => {
    request.log.error({
      err: error,
      url: sanitizeRequestLogUrl(request.url),
      method: request.method,
    });
    if (reply.sent) return;

    const err = error as { statusCode?: number; message?: string };
    if (
      /Research session already has an active job|max_jobs_active_research_session_idx|Idempotency key was already used/i.test(
        err.message ?? "",
      )
    ) {
      return reply
        .code(409)
        .send({ error: "This request conflicts with an existing research job." });
    }
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({ error: "Payload exceeds maximum allowed size of 64KB." });
    }
    if (status === 429) {
      return reply.code(429).send({ error: err.message || "Too many requests." });
    }
    if (status === 503) {
      return reply.code(503).send({ error: "This capability is currently unavailable." });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message || "Invalid request." });
    }
    return reply
      .code(500)
      .send({ error: "An unexpected server error occurred. Please try again." });
  });

  return app;
}

export const app = process.env.MAX_WORKER_PROCESS === "1" ? Fastify() : await createServer();

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule && process.env.NODE_ENV !== "test" && process.env.MAX_WORKER_PROCESS !== "1") {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  installGracefulShutdown(
    process,
    () => app.close(),
    (error) => {
      app.log.error({ err: error }, "Fastify shutdown failed");
      process.exitCode = 1;
    },
  );
}
