import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const QUESTION =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";
const RESEARCH_TIMEOUT_MS = 180_000;
const MODEL_REQUEST_TIMEOUT_MS = 25_000;
const FOLLOW_UP_TIMEOUT_MS = 35_000;
const MAX_RESEARCH_OPENROUTER_CALLS = 8;

function safeError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: String(value?.name ?? "Error"),
    code: typeof value?.code === "string" ? value.code.slice(0, 80) : undefined,
    message: String(value?.message ?? "Unknown failure")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sb_secret_|sk-or-v1-)[A-Za-z0-9_-]+/gi, "[redacted]")
      .slice(0, 300),
  };
}

interface UsageNumbers {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: number;
}

function usageDelta(after: UsageNumbers, before: UsageNumbers) {
  const keys = [
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "totalTokens",
    "cost",
  ] as const;
  return Object.fromEntries(
    keys
      .filter((key) => after[key] !== undefined)
      .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
}

function sourceTrace(source: {
  id: string;
  title: string;
  url: string;
  domain: string;
  sourceType?: string;
  retrievalMethod?: string;
  extractionStatus?: string;
  retrievalAttempts?: string[];
  retrievalReasons?: string[];
  subjectMismatchReason?: string;
  taskEvidence?: {
    status: string;
    missingFacts: string[];
  };
  extractionConfidence?: number;
  content?: string;
}) {
  const attemptedSnippet = source.retrievalAttempts?.includes("serper_snippet") ?? false;
  const snippetAccepted = source.retrievalMethod === "serper_snippet";
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    sourceType: source.sourceType,
    retrievalMethod: source.retrievalMethod,
    extractionStatus: source.extractionStatus,
    retrievalAttempts: source.retrievalAttempts ?? [],
    retrievalReasons: source.retrievalReasons ?? [],
    subjectMismatchReason: source.subjectMismatchReason,
    taskEvidence: source.taskEvidence,
    snippetDecision: !attemptedSnippet
      ? "NOT_ATTEMPTED"
      : snippetAccepted
        ? "ACCEPTED"
        : "REJECTED",
    snippetDecisionReason: source.retrievalReasons?.[0],
    extractionConfidence: source.extractionConfidence,
    contentChars: source.content?.length ?? 0,
    fetched: Boolean(source.content?.trim()),
  };
}

async function main() {
  process.env.NODE_ENV = "test";
  process.env.MAX_PERSISTENCE_PROVIDER = "supabase";

  const [
    { config },
    { createServer, getServerBackgroundServices, app: moduleApp },
    { SupabaseAuthVerifier },
    { UserMemoryService },
    { OpenRouterProvider, auditResearchCitations },
    { SerperProvider, ResilientSearchProvider },
    { SupabaseStore, createSupabaseFetch },
    { createIdempotentJobId },
    { evaluatePostQuality, postFromResearch },
    { cleanupTemporaryAuthUsers, createAuthUserWithReconciliation, findTemporaryAuthUserIds },
    { classifyEvidenceStatus, missingRequestedFactSupport, researchBudgetFor },
    { pollUntilTerminal },
    { inspectFollowUpCitationContract },
    { requestedFactCoverage },
    { researchFactCoverage },
    { isOfficialSourceForEntities },
    { checkLiveNetwork },
  ] = await Promise.all([
    import("../config.js"),
    import("../server.js"),
    import("../auth.js"),
    import("../memory.js"),
    import("../llm.js"),
    import("../search.js"),
    import("../supabase-store.js"),
    import("../jobs.js"),
    import("../post-quality.js"),
    import("./auth-smoke-cleanup.js"),
    import("../research.js"),
    import("./poll-until-terminal.js"),
    import("./follow-up-contract.js"),
    import("../requested-facts.js"),
    import("./research-fact-coverage.js"),
    import("../rank.js"),
    import("./live-network-check.js"),
  ]);

  const researchOnly = process.argv.includes("--research-only");
  const supabaseUrl = config.SUPABASE_URL;
  const serverKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey = config.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !serverKey || !publishableKey) {
    throw new Error("Serper citation integration requires configured Signova Supabase credentials");
  }
  if (!config.SERPER_API_KEY || !config.OPENROUTER_API_KEY) {
    throw new Error("Serper citation integration requires Serper and OpenRouter configuration");
  }
  if (!researchOnly && process.env.MAX_TEMPORARY_PUBLIC_SMOKE_POST_APPROVED !== "1") {
    throw new Error("The authenticated follow-up requires the previously approved temporary post");
  }

  const email = `max-serper-citation-${randomUUID()}@example.com`;
  const password = `${randomBytes(32).toString("base64url")}!aA9`;
  const idempotencyKey = `serper-citation-${randomUUID()}`;
  const rejectedIdempotencyKey = `serper-citation-quota-${randomUUID()}`;
  const serviceFetch = createSupabaseFetch();
  const adminClient = createClient<any>(supabaseUrl, serverKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: serviceFetch },
  });
  const userClient = createClient<any>(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: serviceFetch },
  });
  const researchAdmin = adminClient.schema("research");
  const contentAdmin = adminClient.schema("content");
  const researchBudget = {
    maxSteps: 40,
    maxQueries: 5,
    maxSources: 5,
    maxPages: 5,
    maxSearchPasses: 4,
    maxClaimsToVerify: 5,
    maxTimeMs: RESEARCH_TIMEOUT_MS,
    maxModelDecisions: 4,
  };
  const evaluationBudgetCeilings = { ...researchBudget };
  const effectiveResearchBudget = researchBudgetFor(
    "quick",
    researchBudget,
    evaluationBudgetCeilings,
  );
  const startedAt = Date.now();
  const report: Record<string, unknown> = {
    status: "RUNNING",
    question: QUESTION,
    model: config.OPENROUTER_MODEL,
    ownerReadbackResult: "NOT_REACHED",
    limits: {
      deepResearch: false,
      maxSteps: effectiveResearchBudget.maxSteps,
      maxQueries: effectiveResearchBudget.maxQueries,
      maxSources: effectiveResearchBudget.maxSources,
      maxPages: effectiveResearchBudget.maxPages,
      maxSearchPasses: effectiveResearchBudget.maxSearchPasses,
      maxRecoverySearches: effectiveResearchBudget.maxSearchPasses,
      maxResearchTimeMs: RESEARCH_TIMEOUT_MS,
      maxModelDecisions: effectiveResearchBudget.maxModelDecisions,
      maxOpenRouterCalls: researchOnly ? MAX_RESEARCH_OPENROUTER_CALLS : undefined,
      modelRequestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      followUpTimeoutMs: researchOnly ? undefined : FOLLOW_UP_TIMEOUT_MS,
      openRouterMaxAttempts: 1,
      maxJobAttempts: 1,
    },
    memoryPath: "excluded from this Serper/retrieval/citation phase",
    executionScope: researchOnly
      ? "research-only; no Post Agent, topic, run, post, or follow-up"
      : "research plus quality-gated temporary post and authenticated follow-up",
  };

  const cleanupEmails = [email];
  let userId: string | undefined;
  let accessToken: string | undefined;
  let jobId: string | undefined;
  let sessionId: string | undefined;
  let postId: string | undefined;
  let topicId: string | undefined;
  let runId: string | undefined;
  let followUpId: string | undefined;
  let authCreateAttempted = false;
  let api: Awaited<ReturnType<typeof createServer>> | undefined;
  let worker: ReturnType<typeof getServerBackgroundServices>["worker"] | undefined;
  let store: InstanceType<typeof SupabaseStore> | undefined;
  let researchLlm: InstanceType<typeof OpenRouterProvider> | undefined;
  let openRouterCallRequests = 0;
  let serperQueries: string[] = [];
  let transitions: Array<{
    status: string;
    at: string;
    attempts: number;
    updatedAt?: string;
    stage?: string;
    terminalOutcome?: string;
    terminalStartedAt?: string;
    failureSummary?: string;
    errorSummary?: string;
  }> = [];
  let rejectedJobId: string | undefined;
  let stage = "network/config preflight";
  let primaryError: unknown;
  let cleanupError: unknown;
  const cleanupFailures: string[] = [];
  const observedSerperRequests = () => serperQueries.length;

  const attemptCleanup = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      const safe = safeError(error);
      cleanupFailures.push(`${label}: ${safe.name}${safe.code ? `/${safe.code}` : ""}`);
    }
  };

  try {
    stage = "network/config preflight";
    const preflight = await checkLiveNetwork({
      supabaseUrl,
      openRouterBaseUrl: config.OPENROUTER_BASE_URL,
      requiredConfiguration: [
        { name: "SUPABASE_URL", configured: Boolean(supabaseUrl) },
        { name: "SUPABASE_SERVER_KEY", configured: Boolean(serverKey) },
        { name: "SUPABASE_PUBLISHABLE_KEY", configured: Boolean(publishableKey) },
        { name: "SERPER_API_KEY", configured: Boolean(config.SERPER_API_KEY) },
        { name: "OPENROUTER_API_KEY", configured: Boolean(config.OPENROUTER_API_KEY) },
      ],
    });
    report.networkPreflight = preflight;
    if (!preflight.ready)
      throw new Error("Network/config preflight failed before test data creation");

    stage = "create and authenticate one temporary user";
    authCreateAttempted = true;
    const created = await createAuthUserWithReconciliation(
      () => adminClient.auth.admin.createUser({ email, password, email_confirm: true }),
      supabaseUrl,
      serverKey,
      email,
      {
        request: serviceFetch,
        stopAfterUncertainCreate: true,
        onReconciledUser: (user) => {
          userId = user.id;
        },
      },
    );
    userId = created.id;
    report.temporaryUserId = userId;

    const { data: signedIn, error: signInError } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || signedIn.user?.id !== userId || !signedIn.session?.access_token) {
      throw signInError ?? new Error("Temporary identity did not authenticate as the created user");
    }
    accessToken = signedIn.session.access_token;

    store = new SupabaseStore(supabaseUrl, serverKey, undefined, publishableKey);
    const quotaPolicy = new (await import("../quota-policy.js")).QuotaPolicy(
      JSON.stringify({
        "serper-citation-live": {
          quotas: {
            research: { limit: 1, windowSeconds: 3600 },
            ...(researchOnly ? {} : { followup: { limit: 1, windowSeconds: 3600 } }),
          },
        },
      }),
      JSON.stringify({ [userId]: "serper-citation-live" }),
    );
    const serper = new SerperProvider();
    serperQueries = [];
    const searchProvider = new ResilientSearchProvider([
      {
        name: "serper",
        provider: {
          search: async (query: string, signal?: AbortSignal) => {
            if (serperQueries.length >= 5) {
              throw new Error("Evaluation controller blocked a sixth Serper request");
            }
            serperQueries.push(query);
            return serper.search(query, signal);
          },
        },
      },
    ]);
    const activeResearchLlm = new OpenRouterProvider({
      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      maxAttempts: 1,
    });
    if (researchOnly) {
      const completeOnce = activeResearchLlm.complete.bind(activeResearchLlm);
      activeResearchLlm.complete = async (
        ...args: Parameters<typeof activeResearchLlm.complete>
      ) => {
        if (openRouterCallRequests >= MAX_RESEARCH_OPENROUTER_CALLS) {
          throw new Error("Research-only evaluator reached its OpenRouter call ceiling");
        }
        openRouterCallRequests += 1;
        return completeOnce(...args);
      };
    }
    researchLlm = activeResearchLlm;
    const memoryService = new UserMemoryService(store, undefined);
    api = await createServer({
      store,
      authVerifier: new SupabaseAuthVerifier(supabaseUrl, publishableKey, undefined, serviceFetch),
      quotaPolicy,
      searchProvider,
      llmProvider: activeResearchLlm,
      memoryService,
      researchBudget,
      evaluationBudgetCeilings,
      fastLookupLimits: {
        maxQueries: 5,
        maxSources: 5,
        maxPages: 5,
        maxTimeMs: RESEARCH_TIMEOUT_MS,
      },
    });

    stage = "authenticated durable research enqueue and quota check";
    const headers = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    };
    const enqueue = await api.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { message: QUESTION, deepResearch: false },
    });
    if (enqueue.statusCode !== 202) {
      throw new Error(`Authenticated research enqueue returned HTTP ${enqueue.statusCode}`);
    }
    const queued = enqueue.json() as {
      route?: string;
      researchId?: string;
      jobId?: string;
      session?: { status?: string };
    };
    if (queued.route !== "web" || !queued.researchId || !queued.jobId) {
      throw new Error("The non-deep research request did not create a durable web job");
    }
    jobId = queued.jobId;
    sessionId = queued.researchId;
    report.jobId = jobId;
    report.sessionId = sessionId;
    if (queued.session?.status !== "QUEUED") {
      throw new Error("The persisted research request was not initially queued");
    }
    const job = await store.getOwnedJob(jobId, userId);
    if (!job || job.ownerId !== userId || job.payload.memoryContext !== undefined) {
      throw new Error("Durable job owner or non-memory payload check failed");
    }
    const createdCallsBeforeWorker = activeResearchLlm.metrics.calls;
    if (observedSerperRequests() !== 0 || createdCallsBeforeWorker !== 0) {
      throw new Error("Provider work occurred before the durable worker started");
    }

    rejectedJobId = createIdempotentJobId(`user:${userId}`, rejectedIdempotencyKey);
    const quotaRejection = await api.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...headers, "idempotency-key": rejectedIdempotencyKey },
      payload: {
        message: "Investigate another current React release detail.",
        deepResearch: false,
      },
    });
    const rejectedJob = await store.getJob(rejectedJobId);
    if (quotaRejection.statusCode !== 429 || rejectedJob) {
      throw new Error("Per-user quota did not reject before another job/provider operation");
    }

    const { data: attemptLimit, error: attemptLimitError } = await researchAdmin
      .from("max_jobs")
      .update({ max_attempts: 1 })
      .eq("id", jobId)
      .select("id, max_attempts")
      .single();
    if (attemptLimitError || attemptLimit?.max_attempts !== 1) {
      throw new Error("Could not enforce a single durable worker attempt for the test job");
    }

    const quotaRows = async () => {
      const { data, error } = await researchAdmin
        .from("max_user_quota_windows")
        .select("quota_key, used")
        .eq("user_id", userId);
      if (error) throw error;
      return Object.fromEntries(
        (data ?? []).map((row) => [String(row.quota_key), Number(row.used)]),
      );
    };
    const quotaBeforeWorker = await quotaRows();
    if (quotaBeforeWorker.research !== 1)
      throw new Error("Research quota was not persisted before worker start");

    stage = "durable worker research, source retrieval, and citation validation";
    const services = getServerBackgroundServices(api);
    worker = services.worker;
    activeResearchLlm.setDeadline(Date.now() + RESEARCH_TIMEOUT_MS);
    transitions = [];
    const captureJob = async () => {
      const current = await store!.getJob(jobId!);
      if (!current) throw new Error("Queued durable job disappeared before execution");
      const observed = {
        status: current.status,
        attempts: current.attempts,
        updatedAt: current.updatedAt,
        stage: typeof current.progress.stage === "string" ? current.progress.stage : undefined,
        terminalOutcome:
          typeof current.progress.terminalOutcome === "string"
            ? current.progress.terminalOutcome
            : undefined,
        terminalStartedAt:
          typeof current.progress.terminalStartedAt === "string"
            ? current.progress.terminalStartedAt
            : undefined,
        failureSummary:
          typeof current.progress.failureSummary === "string"
            ? current.progress.failureSummary
            : undefined,
        errorSummary: current.errorSummary,
      };
      const prior = transitions.at(-1);
      if (
        !prior ||
        prior.status !== observed.status ||
        prior.stage !== observed.stage ||
        prior.terminalOutcome !== observed.terminalOutcome
      ) {
        transitions.push({
          at: new Date().toISOString(),
          ...observed,
        });
        report.jobTransitions = transitions;
      }
      return current;
    };
    await captureJob();
    worker.start();
    let completedJob = await captureJob();
    const jobDeadline = Date.now() + RESEARCH_TIMEOUT_MS + 15_000;
    while (!["completed", "failed", "cancelled"].includes(completedJob.status)) {
      if (Date.now() >= jobDeadline)
        throw new Error("Durable worker job exceeded its bounded deadline");
      await delay(250);
      completedJob = await captureJob();
    }
    report.jobTransitions = transitions;
    const session = await store.get(sessionId);
    if (!session) throw new Error("Research session disappeared before worker read-back");
    const serperAttempts =
      session.searchAttempts?.filter((attempt) => attempt.provider.toLowerCase() === "serper") ??
      [];
    const extractedSources = session.sources.filter((source) => Boolean(source.content?.trim()));
    const pageFetchSources = session.sources.filter((source) =>
      source.retrievalAttempts?.some((method) => method !== "serper_snippet"),
    );
    const requestedEntities = session.plan?.interpretation.entities ?? [];
    const officialSources = extractedSources.filter(
      (source) =>
        !source.subjectMismatchReason && isOfficialSourceForEntities(source, requestedEntities),
    );
    const searchRecoveries = session.searchRecoveries ?? [];
    const officialSourceRequirement =
      session.plan?.interpretation.sourceRequirements?.officialSources ?? "none";
    const officialEvidenceSourceIds = new Set(
      extractedSources
        .filter(
          (source) =>
            !source.subjectMismatchReason && isOfficialSourceForEntities(source, requestedEntities),
        )
        .map((source) => source.id),
    );
    const validClaims = session.claims.filter(
      (claim) =>
        claim.verification?.verdict === "supported" &&
        claim.sourceIds.some(
          (sourceId) =>
            extractedSources.some((source) => source.id === sourceId) &&
            (officialSourceRequirement !== "required" || officialEvidenceSourceIds.has(sourceId)),
        ),
    );
    const officialValidClaims = validClaims.filter((claim) =>
      claim.sourceIds.some((sourceId) => officialEvidenceSourceIds.has(sourceId)),
    );
    const verifiedClaimTexts = validClaims.map((claim) => `${claim.text}\n${claim.evidence}`);
    const verifiedOfficialClaimTexts = officialValidClaims.map(
      (claim) => `${claim.text}\n${claim.evidence}`,
    );
    const latestnessProven = session.state?.latestnessAssessment?.conclusion === "PROVEN";
    const coverageResult = researchFactCoverage({
      question: QUESTION,
      verifiedClaimTexts,
      verifiedOfficialClaimTexts,
      latestnessProven,
      latestnessVersion:
        session.state?.latestnessAssessment?.latestVersion ??
        session.state?.latestnessAssessment?.highestCandidateVersion,
      requestedFacts: session.state?.requestedFactCoverage?.required,
      releaseRecords: session.state?.releaseRecords ?? [],
      officialSourcesRequired: officialSourceRequirement === "required",
    });
    const requestedCoverage = coverageResult.requested;
    const officialFactCoverage = coverageResult.official;
    const answerCoverage = requestedFactCoverage(QUESTION, [session.answer ?? ""]);
    const citationAudit = auditResearchCitations(session.answer ?? "", session.sources.length);
    const persistedMetrics = completedJob.result?.modelMetrics;
    const persistedCitationValidation =
      persistedMetrics && typeof persistedMetrics === "object"
        ? (persistedMetrics as Record<string, unknown>).citationEntailment
        : undefined;
    const citationValidationStatus =
      persistedCitationValidation && typeof persistedCitationValidation === "object"
        ? (persistedCitationValidation as { status?: unknown }).status
        : (activeResearchLlm.metrics.citationEntailment?.status ?? "NOT_REACHED");
    const persistedSynthesis =
      persistedMetrics && typeof persistedMetrics === "object"
        ? (persistedMetrics as Record<string, unknown>).synthesis
        : undefined;
    const synthesisTelemetry: Record<string, unknown> = {
      ...(persistedSynthesis && typeof persistedSynthesis === "object"
        ? (persistedSynthesis as Record<string, unknown>)
        : (activeResearchLlm.metrics.synthesis ?? {})),
      ownerReadbackResult: "NOT_REACHED",
    };
    const researchReport = {
      sessionId,
      jobId,
      route: queued.route,
      mode: job.payload.mode,
      status: session.status,
      plan: session.plan,
      steps: session.steps,
      sourceSelectionDecisions: session.sourceSelectionDecisions ?? [],
      researchState: session.state,
      latestnessAssessment: session.state?.latestnessAssessment,
      jobStatus: completedJob.status,
      attempts: completedJob.attempts,
      serperRequests: observedSerperRequests(),
      searchAttempts: serperAttempts,
      actualQueries: serperQueries,
      initialQuery: serperQueries[0] ?? null,
      recoveryQueries: searchRecoveries.flatMap((recovery, index) =>
        recovery.queries.map((query) => ({
          pass: index + 1,
          query,
          reason: recovery.reason,
          requestedFacts: recovery.requirements?.requestedFacts,
          resolvedFacts: recovery.requirements?.resolvedFacts,
          unresolvedFacts: recovery.requirements?.unresolvedFacts,
          latestnessRequired: recovery.requirements?.latestnessRequired,
          latestnessResolved: recovery.requirements?.latestnessResolved,
          knownVersionCandidates: recovery.requirements?.knownVersionCandidates,
          qualifiers: recovery.requirements?.qualifiers,
          officialSourceRequirement: recovery.officialSourceRequirement,
          officialEvidenceResolved: recovery.requirements?.officialEvidenceResolved,
          validation: recovery.queryValidation,
        })),
      ),
      searchRecoveries,
      pageFetchSources: pageFetchSources.map((source) => ({
        id: source.id,
        url: source.url,
        retrievalMethod: source.retrievalMethod,
        retrievalAttempts: source.retrievalAttempts,
      })),
      officialSources: officialSources.map((source) => ({
        domain: source.domain,
        sourceType: source.sourceType,
        url: source.url,
      })),
      retrievalMethods: [
        ...new Set(session.sources.map((source) => source.retrievalMethod ?? "unknown")),
      ],
      sources: session.sources.map(sourceTrace),
      evidenceStatus: {
        status: classifyEvidenceStatus(
          QUESTION,
          verifiedClaimTexts,
          coverageResult.requestedOptions,
        ),
        requiredFacts: requestedCoverage.required,
        resolvedFacts: requestedCoverage.present,
        missingRequestedFacts: missingRequestedFactSupport(QUESTION, verifiedClaimTexts, {
          ...coverageResult.requestedOptions,
        }),
        latestnessRequired: requestedCoverage.required.includes("latestness"),
        latestnessResolved: requestedCoverage.present.includes("latestness"),
        officialSourceRequirement,
        officialEvidenceResolved: validClaims.some((claim) =>
          claim.sourceIds.some((sourceId) => officialEvidenceSourceIds.has(sourceId)),
        ),
        supportedClaims: validClaims.length,
        extractedSources: extractedSources.length,
        totalClaims: session.claims.length,
      },
      officialEvidenceStatus: {
        required: true,
        resolvedFacts: officialFactCoverage.present,
        missingRequestedFacts: officialFactCoverage.missing,
        supportedOfficialClaims: officialValidClaims.length,
      },
      answerCoverage: {
        requiredFacts: answerCoverage.required,
        resolvedFacts: answerCoverage.present,
        missingRequestedFacts: answerCoverage.missing,
      },
      claims: session.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        sourceIds: claim.sourceIds,
        verdict: claim.verification?.verdict,
      })),
      decisions: session.decisions ?? [],
      answer: session.answer,
      citationAudit,
      citationValidationStatus,
      citationValidation: persistedCitationValidation,
      synthesisTelemetry,
      modelCalls: activeResearchLlm.metrics.calls,
      modelUsage: activeResearchLlm.metrics.usage,
    };
    report.research = researchReport;

    if (completedJob.status !== "completed" || completedJob.attempts !== 1) {
      throw new Error(
        `Durable worker ended ${completedJob.status} after ${completedJob.attempts} attempt(s)`,
      );
    }
    if (session.status !== "COMPLETED" || !session.answer) {
      throw new Error(`Persisted research session did not complete: ${session.status}`);
    }
    if (observedSerperRequests() > 5 || serperAttempts.length > 5) {
      throw new Error("Research exceeded the five-query Serper evaluation budget");
    }
    if (searchRecoveries.length > 4) {
      throw new Error("Research exceeded the four-pass recovery evaluation budget");
    }
    if (session.sources.length > 5 || extractedSources.length > 5 || pageFetchSources.length > 5) {
      throw new Error("Research exceeded the five-source/five-page evaluation budget");
    }
    if (officialSources.length === 0) {
      throw new Error("No eligible official React release source was retrieved");
    }
    if (researchReport.officialEvidenceStatus.missingRequestedFacts.length > 0) {
      throw new Error("Eligible official evidence did not support every requested fact");
    }
    if (researchReport.officialEvidenceStatus.missingRequestedFacts.length > 0) {
      throw new Error("Eligible official evidence did not support every requested fact");
    }
    if (
      researchReport.evidenceStatus.status !== "SUPPORTED_EVIDENCE" ||
      researchReport.evidenceStatus.missingRequestedFacts.length > 0
    ) {
      throw new Error("Verified claims did not establish the requested version and release date");
    }
    if (researchReport.answerCoverage.missingRequestedFacts.length > 0) {
      throw new Error("Final answer did not state every requested fact");
    }
    if (extractedSources.length === 0)
      throw new Error("No retrieved source yielded extractable content");
    if (validClaims.length === 0)
      throw new Error("No supported claim maps to extracted source evidence");
    if (
      citationValidationStatus !== "VALIDATED" ||
      citationAudit.invalidMarkers.length > 0 ||
      citationAudit.uncitedSentences.length > 0
    ) {
      throw new Error("Persisted answer did not pass semantic and structural citation validation");
    }

    const ownerReadbackStartedAt = Date.now();
    const ownerJob = await store.getOwnedJob(jobId, userId);
    const ownerSession = await api.inject({
      method: "GET",
      url: `/api/research/${sessionId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const ownerJobResponse = await api.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (
      ownerJob?.ownerId !== userId ||
      ownerSession.statusCode !== 200 ||
      ownerJobResponse.statusCode !== 200 ||
      ownerSession.json<{ id: string; status: string }>().id !== sessionId ||
      ownerJobResponse.json<{ status: string }>().status !== "completed"
    ) {
      const ownerReadbackDurationMs = Date.now() - ownerReadbackStartedAt;
      synthesisTelemetry.ownerReadbackDurationMs = ownerReadbackDurationMs;
      report.ownerReadbackDurationMs = ownerReadbackDurationMs;
      synthesisTelemetry.ownerReadbackResult = "FAILED";
      report.ownerReadbackResult = "FAILED";
      throw new Error("Owner-authenticated Fastify read-back of the persisted result failed");
    }
    const ownerReadbackDurationMs = Date.now() - ownerReadbackStartedAt;
    synthesisTelemetry.ownerReadbackDurationMs = ownerReadbackDurationMs;
    report.ownerReadbackDurationMs = ownerReadbackDurationMs;
    synthesisTelemetry.ownerReadbackResult = "PASSED";
    report.ownerReadbackResult = "PASSED";
    report.supabasePersistence = {
      jobReadBack: true,
      sessionReadBack: true,
      ownerIdPreserved: ownerJob.ownerId === userId,
      quotaBeforeWorker,
    };
    report.postAgent = researchOnly ? "SKIPPED" : undefined;
    report.postFollowUp = researchOnly ? "SKIPPED" : undefined;
    report.openRouterBudget = {
      maxCalls: researchOnly ? MAX_RESEARCH_OPENROUTER_CALLS : undefined,
      callsRequested: researchOnly ? openRouterCallRequests : undefined,
      requestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      maxAttemptsPerRequest: 1,
    };
    report.openRouterBudget = {
      maxCalls: researchOnly ? MAX_RESEARCH_OPENROUTER_CALLS : undefined,
      callsRequested: researchOnly ? openRouterCallRequests : undefined,
      requestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      maxAttemptsPerRequest: 1,
    };

    if (researchOnly && activeResearchLlm.metrics.calls > MAX_RESEARCH_OPENROUTER_CALLS) {
      throw new Error("Research exceeded the bounded OpenRouter call ceiling");
    }

    if (researchOnly) {
      report.status = "RESEARCH_VERIFIED";
      report.jobTransitions = transitions;
      report.totalDurationMs = Date.now() - startedAt;
    } else {
      const topicSource = extractedSources.find((source) => source.content?.trim());
      if (!topicSource)
        throw new Error("No extracted source was available for the follow-up fixture");
      const topic = {
        id: randomUUID(),
        title: "Temporary MAX Serper citation integration check",
        url: topicSource.url,
        summary: session.answer,
        provider: "serper",
        discoveredAt: new Date().toISOString(),
        score: 1,
        status: "RESEARCHED" as const,
      };
      topicId = topic.id;
      if (await store.getTopicByUrl(topic.url)) {
        throw new Error("Selected source URL is already associated with a topic; stopping safely");
      }
      const post = postFromResearch(topic, session);
      postId = post.id;
      const quality = evaluatePostQuality(topic, session, await store.listPosts(100));
      report.temporaryPostQuality = quality;
      if (quality.status !== "READY_TO_PUBLISH") {
        throw new Error(`Existing quality gate withheld the temporary post (${quality.status})`);
      }
      const now = new Date().toISOString();
      runId = randomUUID();
      const run = {
        id: runId,
        trigger: "manual" as const,
        status: "PUBLISHED" as const,
        createdAt: now,
        updatedAt: now,
        topicId: topic.id,
        researchId: session.id,
        postId: post.id,
        events: [
          {
            at: now,
            stage: "quality_gate",
            status: "complete" as const,
            detail: "Existing publication quality gate passed for the temporary follow-up fixture",
          },
        ],
      };
      await store.saveTopic(topic);
      await store.saveRun(run);
      await store.publishPost(post, topic, run);
      report.postAgent = { status: "PUBLISHED_TEMPORARILY", qualityGate: quality };

      stage = "quality-gated temporary post and authenticated follow-up";
      const modelCallsBeforeFollowUp = activeResearchLlm.metrics.calls;
      const modelUsageBeforeFollowUp = activeResearchLlm.metrics.usage;
      activeResearchLlm.setDeadline(Date.now() + FOLLOW_UP_TIMEOUT_MS);
      const followUpApi = api;
      if (!followUpApi) throw new Error("Fastify was not available for the follow-up smoke");
      const followUpResponse = await followUpApi.inject({
        method: "POST",
        url: `/api/posts/${post.id}/ask`,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        payload: { question: "Which source supports the verified React release finding?" },
      });
      if (followUpResponse.statusCode !== 202) {
        throw new Error(
          `Authenticated follow-up enqueue returned HTTP ${followUpResponse.statusCode}`,
        );
      }
      const followUpQueued = followUpResponse.json() as { id?: string; postId?: string };
      if (!followUpQueued.id || followUpQueued.postId !== post.id) {
        throw new Error("Authenticated follow-up returned an invalid persisted identity");
      }
      followUpId = followUpQueued.id;
      const followUpTrace = {
        enqueue: "ACCEPTED",
        status: "QUEUED",
        pollCount: 0,
        rateLimitResponses: 0,
      };
      report.postFollowUp = followUpTrace;
      const followUp = await pollUntilTerminal(
        async () => {
          followUpTrace.pollCount += 1;
          const poll = await followUpApi.inject({
            method: "GET",
            url: `/api/posts/${post.id}/ask/${followUpId}`,
            headers: { authorization: `Bearer ${accessToken}` },
          });
          if (poll.statusCode === 429) followUpTrace.rateLimitResponses += 1;
          const retryAfter = Number(poll.headers["retry-after"]);
          const value =
            poll.statusCode === 200
              ? (poll.json() as {
                  id?: string;
                  status?: string;
                  answer?: string;
                  sourceIds?: string[];
                })
              : undefined;
          if (value?.status) followUpTrace.status = value.status;
          return {
            statusCode: poll.statusCode,
            retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
            value,
          };
        },
        {
          timeoutMs: FOLLOW_UP_TIMEOUT_MS,
          intervalMs: 2_000,
          terminalStatuses: ["COMPLETED", "FAILED"],
        },
      );
      followUpTrace.status = followUp.status ?? "UNKNOWN";
      const followUpContract = inspectFollowUpCitationContract({
        status: followUp.status,
        answer: followUp.answer,
        sourceIds: followUp.sourceIds,
        modelCallsBefore: modelCallsBeforeFollowUp,
        modelCallsAfter: activeResearchLlm.metrics.calls,
      });
      const followUpRow = await store.getFollowUp(followUpId);
      const quotaAfterFollowUp = await quotaRows();
      report.followUp = {
        ...followUpContract,
        modelCalls: followUpContract.modelCallsDelta,
        persistedStatus: followUpRow?.status,
        persistedAnswerPresent: Boolean(followUpRow?.answer?.trim()),
        persistedAnswerLength: followUpRow?.answer?.length ?? 0,
        persistedSourceIdCount: followUpRow?.sourceIds.length ?? 0,
        usedLiveResearch: followUpRow?.usedLiveResearch,
        persistenceMatched:
          Boolean(followUpRow) &&
          followUpRow?.status === followUp.status &&
          followUpRow?.answer === followUp.answer &&
          followUpRow?.sourceIds.length === followUp.sourceIds?.length,
        modelUsage: usageDelta(activeResearchLlm.metrics.usage, modelUsageBeforeFollowUp),
        quotaAfterFollowUp,
      };
      if (!followUpContract.passed) {
        throw new Error(
          `Authenticated follow-up contract failed: ${followUpContract.failedChecks.join(", ") || "unknown"}`,
        );
      }
      if (!followUpRow || followUpRow.status !== "COMPLETED" || quotaAfterFollowUp.followup !== 1) {
        throw new Error("Follow-up persistence or per-user follow-up quota verification failed");
      }
      if (serperQueries.length > 5) {
        throw new Error("Follow-up exceeded the five-query Serper evaluation budget");
      }
      report.status = "VERIFIED";
      report.jobTransitions = transitions;
      report.totalDurationMs = Date.now() - startedAt;
    }
  } catch (error) {
    primaryError = error;
    report.status = "BLOCKED";
    report.failureStage = stage;
    report.failure = safeError(error);
    report.totalDurationMs = Date.now() - startedAt;
    if (store && jobId) {
      try {
        const currentJob = await store.getJob(jobId);
        if (currentJob) {
          const progress = currentJob.progress;
          const observed = {
            status: currentJob.status,
            attempts: currentJob.attempts,
            updatedAt: currentJob.updatedAt,
            stage: typeof progress.stage === "string" ? progress.stage : undefined,
            terminalOutcome:
              typeof progress.terminalOutcome === "string" ? progress.terminalOutcome : undefined,
            terminalStartedAt:
              typeof progress.terminalStartedAt === "string"
                ? progress.terminalStartedAt
                : undefined,
            failureSummary:
              typeof progress.failureSummary === "string" ? progress.failureSummary : undefined,
            errorSummary: currentJob.errorSummary,
          };
          if (
            transitions.at(-1)?.status !== observed.status ||
            transitions.at(-1)?.stage !== observed.stage ||
            transitions.at(-1)?.terminalOutcome !== observed.terminalOutcome
          )
            transitions.push({ at: new Date().toISOString(), ...observed });
          report.jobTransitions = transitions;
          report.durableJobAtFailure = observed;
        }
      } catch {
        report.durableJobSnapshotError = "Could not read the durable job before cleanup";
      }
    }
    if (store && sessionId) {
      try {
        const session = await store.get(sessionId);
        if (session) {
          report.partialResearch = {
            status: session.status,
            failureStage: session.failureStage,
            error: session.error,
            updatedAt: session.updatedAt,
            stageTimings: session.stageTimings,
            plan: session.plan,
            steps: session.steps,
            state: session.state,
            coverage: session.coverage,
            sources: session.sources.map(sourceTrace),
            claims: session.claims.map((claim) => ({
              id: claim.id,
              text: claim.text,
              sourceIds: claim.sourceIds,
              verdict: claim.verification?.verdict,
            })),
            searchAttempts: session.searchAttempts,
          };
        }
      } catch {
        report.partialResearchSnapshotError = "Could not read the research session before cleanup";
      }
    }
  } finally {
    if (worker) {
      await attemptCleanup("worker stop", () => worker!.stop());
    }
    if (api) {
      await attemptCleanup("API close", () => api!.close());
      api = undefined;
    }
    if (authCreateAttempted) {
      if (followUpId) {
        await attemptCleanup("follow-up delete", async () => {
          const { error } = await contentAdmin
            .from("max_post_followups")
            .delete()
            .eq("id", followUpId);
          if (error) throw error;
        });
      }
      if (postId) {
        for (const childTable of ["max_post_followups", "max_post_sources", "max_post_claims"]) {
          await attemptCleanup(`${childTable} cleanup`, async () => {
            const { error } = await contentAdmin.from(childTable).delete().eq("post_id", postId);
            if (error) throw error;
          });
        }
        await attemptCleanup("post delete", async () => {
          const { error } = await contentAdmin.from("max_posts").delete().eq("id", postId);
          if (error) throw error;
        });
      }
      if (runId) {
        await attemptCleanup("run delete", async () => {
          const { error } = await contentAdmin.from("max_autonomous_runs").delete().eq("id", runId);
          if (error) throw error;
        });
      }
      if (topicId) {
        await attemptCleanup("topic delete", async () => {
          const { error } = await contentAdmin.from("max_topics").delete().eq("id", topicId);
          if (error) throw error;
        });
      }
      if (jobId || rejectedJobId || userId) {
        await attemptCleanup("job cleanup", async () => {
          let query = researchAdmin.from("max_jobs").delete();
          if (userId) query = query.eq("owner_id", userId);
          else if (jobId || rejectedJobId) {
            query = query.in("id", [jobId, rejectedJobId].filter(Boolean));
          }
          const { error } = await query;
          if (error) throw error;
        });
      }
      if (sessionId || userId) {
        await attemptCleanup("session cleanup", async () => {
          let query = researchAdmin.from("max_research_sessions").delete();
          if (sessionId) query = query.eq("id", sessionId);
          if (userId) query = query.eq("owner_id", userId);
          const { error } = await query;
          if (error) throw error;
        });
      }
      if (userId) {
        await attemptCleanup("quota cleanup", async () => {
          const { error } = await researchAdmin
            .from("max_user_quota_windows")
            .delete()
            .eq("user_id", userId);
          if (error) throw error;
        });
      }
      await attemptCleanup("temporary Auth user cleanup", () =>
        cleanupTemporaryAuthUsers(
          { deleteUser: (id) => adminClient.auth.admin.deleteUser(id) },
          supabaseUrl,
          serverKey,
          cleanupEmails,
          [userId],
          serviceFetch,
        ),
      );
      await attemptCleanup("temporary Auth user verification", async () => {
        const remaining = await findTemporaryAuthUserIds(
          supabaseUrl,
          serverKey,
          new Set(cleanupEmails.map((value) => value.toLowerCase())),
          serviceFetch,
        );
        if (remaining.length) throw new Error("Temporary Auth user remains");
      });
      const cleanupVerifications: Array<[string, string, string, string | undefined]> = [
        ["research", "max_jobs", "owner_id", userId],
        ["research", "max_research_sessions", "owner_id", userId],
        ["research", "max_user_quota_windows", "user_id", userId],
      ];
      if (!researchOnly) {
        cleanupVerifications.push(
          ["content", "max_post_followups", "owner_id", userId],
          ["content", "max_posts", "id", postId],
          ["content", "max_topics", "id", topicId],
          ["content", "max_autonomous_runs", "id", runId],
        );
      }
      for (const [schemaName, table, column, value] of cleanupVerifications) {
        if (!value) continue;
        await attemptCleanup(`${schemaName}.${table} cleanup verification`, async () => {
          const schema = adminClient.schema(schemaName);
          const { data, error } = await schema.from(table).select(column).eq(column, value);
          if (error || (data ?? []).length > 0) throw error ?? new Error("Temporary rows remain");
        });
      }
    }
    if (researchLlm) {
      const metrics = researchLlm.metrics;
      report.openRouter = {
        model: config.OPENROUTER_MODEL,
        calls: metrics.calls,
        failures: metrics.failures,
        durationMs: metrics.durationMs,
        usage: metrics.usage,
        records: metrics.records.map((record) => ({
          role: record.role,
          purpose: record.purpose,
          model: record.model,
          durationMs: record.durationMs,
          attempt: record.attempt,
          fallbackUsed: record.fallbackUsed,
          promptChars: record.promptChars,
          requestBodyBytes: record.requestBodyBytes,
          maxCompletionTokens: record.maxCompletionTokens,
          responseFormat: record.responseFormat,
          responseParseResult: record.responseParseResult,
          responseValidationResult: record.responseValidationResult,
          effectiveTimeoutMs: record.effectiveTimeoutMs,
          timeoutCause: record.timeoutCause,
          failureCategory: record.failureCategory,
          usage: record.usage,
          error: record.error ? safeError(new Error(record.error)) : undefined,
        })),
      };
    }
    report.serper = { requests: observedSerperRequests(), queries: serperQueries };
    if (store)
      await attemptCleanup("store close", async () => {
        await store!.close();
      });
    await attemptCleanup("module app close", () => moduleApp.close());
    report.cleanupVerified = cleanupFailures.length === 0;
    report.cleanupFailures = cleanupFailures;
    report.totalDurationMs = Date.now() - startedAt;
    if (cleanupFailures.length > 0) {
      cleanupError = new Error(cleanupFailures.join("; "));
      report.status = "BLOCKED_CLEANUP";
      report.cleanupFailure = safeError(cleanupError);
    }
  }

  const outputPath = resolve(
    "evaluation-results",
    `serper-citation-integration-${randomUUID()}.json`,
  );
  await mkdir(resolve("evaluation-results"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: outputPath })}\n`);
  if (primaryError || cleanupError) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ status: "BLOCKED_BEFORE_RUN", failure: safeError(error) })}\n`,
  );
  process.exitCode = 1;
});
