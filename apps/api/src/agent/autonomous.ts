import { randomUUID } from "node:crypto";
import { currentWorkerContext } from "../worker-context.js";
import type {
  ResearchSession,
  ResearchMode,
  QueryInterpretation,
  SearchResult,
  Source,
  ResearchPlan,
} from "../domain.js";
import { OpenRouterProvider } from "../llm.js";
import { rankResults, selectResearchSources } from "../rank.js";
import { ResearchRunner } from "../research.js";
import type { SessionStore } from "../store.js";
import { ToolRegistry } from "./tools.js";
import { config } from "../config.js";
import { generateStructuredObjectives, planFastLookupQuery } from "../planner.js";
import type { SearchAttempt } from "../search.js";
import { runWithResearchExecutionContext } from "../execution-context.js";
import type { ResearchBudget } from "../research.js";
import { SourceRetrievalError } from "../source-retrieval.js";
import { subjectEntityMismatchReason } from "../entities.js";
import { querySubjectMismatchReason, relevantSourceContent } from "../query-relevance.js";
import { withOperationContext } from "../operation-context.js";
import {
  buildRequestedFactRequirements,
  extractRequestedFacts,
  requestedFactCoverage,
} from "../requested-facts.js";

type FastLookupLimits = Pick<
  ResearchBudget,
  "maxQueries" | "maxSources" | "maxPages" | "maxTimeMs"
>;

export type AgentRoute = "direct" | "web" | "deep";
type InternalEffort = "low" | "medium" | "high";

interface AgentRouteDecision {
  route: AgentRoute;
  effort: InternalEffort;
  reason: string;
}

export interface AgentToolEvent {
  tool: string;
  status: "running" | "complete" | "failed";
  message: string;
  phase?: "tool" | "decision";
  reason?: string;
}

export interface ChatResponse {
  route: AgentRoute;
  interpretation: QueryInterpretation;
  answer?: string;
  sources?: Source[];
  researchId?: string;
  jobId?: string;
  toolEvents: AgentToolEvent[];
  session?: ResearchSession;
  durationMs?: number;
}

export class AutonomousAgent {
  async preview(question: string, deepResearch: boolean) {
    const interpretation = (await this.tools.execute("understand_query", {
      question,
      allowModel: false,
    })) as QueryInterpretation;
    return { interpretation, decision: this.route(interpretation, deepResearch) };
  }
  constructor(
    private readonly tools: ToolRegistry,
    private readonly runner: ResearchRunner,
    private readonly llm: OpenRouterProvider,
    private readonly store?: SessionStore,
    private readonly fastLookupLimits: FastLookupLimits = {
      maxQueries: config.MAX_SEARCH_QUERIES,
      maxSources: config.MAX_SOURCES,
      maxPages: config.MAX_PAGES,
      maxTimeMs: config.MAX_RESEARCH_TIME_MS,
    },
  ) {}

  private async use<T>(events: AgentToolEvent[], name: string, input: unknown): Promise<T> {
    events.push({ tool: name, status: "running", message: `Running ${name}`, phase: "tool" });
    try {
      const result = (await this.tools.execute(name, input)) as T;
      events[events.length - 1] = {
        tool: name,
        status: "complete",
        message: `${name} complete`,
        phase: "tool",
      };
      return result;
    } catch (error) {
      events[events.length - 1] = {
        tool: name,
        status: "failed",
        message: error instanceof Error ? error.message : `${name} failed`,
        phase: "tool",
      };
      throw error;
    }
  }

  private route(interpretation: QueryInterpretation, deepResearch: boolean): AgentRouteDecision {
    if (deepResearch) {
      return {
        route: "deep",
        effort: "high",
        reason:
          "Deep Research was requested, so the agent selected the comprehensive multi-step research loop.",
      };
    }
    const normalized = interpretation.normalizedQuestion.toLowerCase();
    if (interpretation.ambiguityScore >= 0.6) {
      return {
        route: "web",
        effort: "high",
        reason:
          "The interpretation is highly ambiguous, so the research path can clarify before committing to a factual answer.",
      };
    }

    const explicitlyFresh =
      /\b(?:latest|current|today|recent|newest|most recent|news|this week|pricing|price|cost|release date|when was|what version|status of)\b|\b(?:19|20)\d{2}\b/i.test(
        normalized,
      );
    const stableConcept =
      /\b(?:closure|closures|scope|scoping|syntax|hoisting|let and const|let.*const|version control|algorithm complexity|big o)\b/i.test(
        normalized,
      );
    const isComparison =
      interpretation.formatPreference === "comparison" ||
      /\b(compare|comparison|versus|\bvs\b|better|best|difference between|differences)\b/i.test(
        normalized,
      );

    const explicitlyRequiresSources =
      interpretation.sourceRequirements?.officialSources === "required" ||
      interpretation.sourceRequirements?.officialSources === "preferred";
    const explicitEvidenceRequest =
      /\b(?:measured|measurements?|benchmark(?:s|ed)?|empirical|according to|stud(?:y|ies)|sources?|citations?|cite|references?|external evidence|research)\b/i.test(
        normalized,
      ) ||
      explicitlyRequiresSources ||
      interpretation.formatPreference === "research";

    if (
      !explicitlyFresh &&
      !explicitEvidenceRequest &&
      stableConcept &&
      !explicitlyRequiresSources
    ) {
      return {
        route: "direct",
        effort: "low",
        reason:
          "The request asks for a stable concept that does not require fresh external evidence.",
      };
    }

    const isDeepInvestigation =
      /\b(deep|investigate|thorough|in-depth|comprehensive|evaluate|benchmark|analy[sz]e)\b/i.test(
        normalized,
      );

    if (isDeepInvestigation) {
      return {
        route: "web",
        effort: "high",
        reason: "The request asks for a detailed investigation that requires external research.",
      };
    }

    if (isComparison && (explicitlyFresh || explicitEvidenceRequest)) {
      return {
        route: "web",
        effort: "high",
        reason:
          "The comparison requests current or external evidence, so the agent selected the bounded research path.",
      };
    }

    if (explicitEvidenceRequest) {
      return {
        route: "web",
        effort: "high",
        reason:
          "The request requires external or official evidence, so the agent selected the bounded research path.",
      };
    }

    // Medium effort for fast factual lookups, current status, release versions, or time-sensitive facts
    if (
      interpretation.formatPreference === "lookup" ||
      /\b(latest|current|today|recent|news|this week|release date|when was|what version|status of)\b/i.test(
        normalized,
      )
    ) {
      return {
        route: "web",
        effort: "medium",
        reason: "The question depends on current or time-sensitive facts; running fast web lookup.",
      };
    }

    if (isComparison) {
      return {
        route: "direct",
        effort: "low",
        reason: "The comparison asks about stable concepts and does not request fresh evidence.",
      };
    }

    // Low effort for stable, factual, or conceptual questions
    return {
      route: "direct",
      effort: "low",
      reason: "The question is stable and can be answered without external research.",
    };
  }

  private async fastWebLookup(
    question: string,
    interpretation: QueryInterpretation,
    toolEvents: AgentToolEvent[],
    startedAt: number,
    memoryContext?: string,
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    const deadlineAt = startedAt + this.fastLookupLimits.maxTimeMs;
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    const parent = currentWorkerContext()?.signal;
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    try {
      return await runWithResearchExecutionContext({ deadlineAt, signal }, () =>
        this.fastWebLookupWithinBudget(
          question,
          interpretation,
          toolEvents,
          startedAt,
          memoryContext,
        ),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fastWebLookupWithinBudget(
    question: string,
    interpretation: QueryInterpretation,
    toolEvents: AgentToolEvent[],
    startedAt: number,
    memoryContext?: string,
  ): Promise<ChatResponse> {
    const now = new Date().toISOString();
    const searchQuery = planFastLookupQuery(interpretation);
    const searchAttempts: SearchAttempt[] = [];
    const lookupText = `${question} ${interpretation.normalizedQuestion}`;
    const isReactVersionLookup =
      /\breact(?:\.js)?\b(?!\s+(?:native|router|query|navigation))\b/i.test(lookupText) &&
      !/\breact native\b/i.test(lookupText) &&
      /\b(version|release)\b/i.test(lookupText);

    // 1. Search web (1 pass)
    let rawResults: SearchResult[] = [];
    try {
      rawResults = await this.use<SearchResult[]>(toolEvents, "web_search", {
        queries: [searchQuery].slice(0, this.fastLookupLimits.maxQueries),
        onSearchAttempt: (attempt: SearchAttempt) => searchAttempts.push(attempt),
      });
    } catch {
      rawResults = [];
    }

    // 2. Rank results and pick top 1-2 authoritative sources
    const registryUrl = "https://registry.npmjs.org/react/latest";
    const registryResult: SearchResult = {
      title: "React latest package metadata",
      url: registryUrl,
      snippet: "Latest published React package version from the npm registry.",
      provider: "npm-registry",
      engine: "npm-registry",
      query: searchQuery,
      discoveredAt: new Date().toISOString(),
    };
    const searchResults = isReactVersionLookup
      ? [
          ...rawResults.filter((result) => result.url !== registryUrl),
          rawResults.find((result) => result.url === registryUrl) ?? registryResult,
        ]
      : rawResults;
    const ranked = rankResults(interpretation.normalizedQuestion, searchResults);
    const relevantRanked = ranked.filter((source) => !source.subjectMismatchReason);
    let rankedForFetch = relevantRanked;
    if (isReactVersionLookup) {
      const registryCandidate = relevantRanked.find((result) => result.url === registryUrl);
      const documentationResult =
        relevantRanked.find((result) => {
          try {
            const url = new URL(result.url);
            return url.hostname === "react.dev" && url.pathname.startsWith("/versions");
          } catch {
            return false;
          }
        }) ?? relevantRanked.find((result) => result.url !== registryUrl);
      rankedForFetch = [
        ...(registryCandidate ? [registryCandidate] : []),
        ...(documentationResult ? [documentationResult] : []),
        ...relevantRanked.filter(
          (result) => result.url !== registryUrl && result !== documentationResult,
        ),
      ];
    }
    const sourceLimit = Math.min(
      2,
      this.fastLookupLimits.maxSources,
      this.fastLookupLimits.maxPages,
    );
    const officialSourceRequirement = interpretation.sourceRequirements?.officialSources ?? "none";
    const topCandidates =
      officialSourceRequirement === "none"
        ? rankedForFetch.slice(0, sourceLimit)
        : selectResearchSources(
            rankedForFetch,
            interpretation.entities,
            sourceLimit,
            officialSourceRequirement,
            interpretation.normalizedQuestion,
          );
    toolEvents.push({
      tool: "source_triage",
      status: topCandidates.length > 0 ? "complete" : "failed",
      message: isReactVersionLookup
        ? `Selected ${topCandidates.length} sources from ${rawResults.length} search results under the ${officialSourceRequirement} official-source policy${topCandidates.some((source) => source.url === registryUrl) ? ", including package registry metadata" : ""}`
        : `Selected ${topCandidates.length} of ${rawResults.length} search results under the ${officialSourceRequirement} official-source policy`,
      phase: "tool",
    });

    // 3. Fetch content with bounded concurrency for top candidates
    const fetchedSources: Source[] = [];
    const compactLookup =
      interpretation.formatPreference === "lookup" &&
      !isReactVersionLookup &&
      !/\b(compare|comparison|versus|\bvs\b|deep|comprehensive|in depth)\b/i.test(
        interpretation.normalizedQuestion,
      );
    for (const candidate of topCandidates) {
      let retrieved: Source;
      try {
        const fetched = await this.use<{
          url: string;
          html: string;
          contentType?: string;
          cached?: boolean;
          document?: unknown;
          retrievalMethod?: string;
          retrievalAttempts?: string[];
          retrievalMethodsSkipped?: string[];
          retrievalReasons?: string[];
          extractionConfidence?: number;
          extractionStatus?: Source["extractionStatus"];
          retrievedContentLength?: number;
        }>(toolEvents, "fetch_url", {
          url: candidate.url,
          title: candidate.title,
          snippet: candidate.snippet,
          provider: candidate.provider,
          researchChatOptimization: true,
          question: interpretation.normalizedQuestion,
        });
        const extracted = await this.use<{
          title?: string;
          content: string;
          canonicalUrl?: string;
        }>(toolEvents, "extract_content", {
          html: fetched.html,
          url: fetched.url,
          contentType: fetched.contentType,
          cached: fetched.cached,
          document: fetched.document,
          retrievalMethod: fetched.retrievalMethod,
          sourceMetadata: {
            provider: candidate.provider,
            providers: candidate.providers,
            engine: candidate.engine,
            query: candidate.query,
            discoveredAt: candidate.discoveredAt,
            retrievalMethod: fetched.retrievalMethod,
            retrievalAttempts: fetched.retrievalAttempts,
            retrievalMethodsSkipped: fetched.retrievalMethodsSkipped,
            retrievalReasons: fetched.retrievalReasons,
            extractionConfidence: fetched.extractionConfidence,
            extractionStatus: fetched.extractionStatus,
            retrievedContentLength: fetched.retrievedContentLength,
            canonicalUrl:
              fetched.document && typeof fetched.document === "object"
                ? (fetched.document as { canonicalUrl?: string }).canonicalUrl
                : undefined,
          },
        });
        const fetchedDocument =
          fetched.document && typeof fetched.document === "object"
            ? (fetched.document as { title?: string; canonicalUrl?: string })
            : undefined;
        const extractedTitle = extracted.title || fetchedDocument?.title;
        const subjectMismatchReason =
          (extractedTitle ? subjectEntityMismatchReason(question, extractedTitle) : undefined) ??
          querySubjectMismatchReason(
            question,
            extracted.content,
            `${candidate.title} ${candidate.snippet}`,
          );
        retrieved = {
          ...candidate,
          title: extractedTitle || candidate.title,
          content: subjectMismatchReason
            ? ""
            : relevantSourceContent(
                question,
                extracted.content,
                `${extractedTitle || candidate.title} ${candidate.snippet}`,
              ).slice(0, 4000),
          fetchedAt: new Date().toISOString(),
          canonicalUrl:
            fetched.document && typeof fetched.document === "object"
              ? (fetched.document as { canonicalUrl?: string }).canonicalUrl
              : undefined,
          retrievalMethod: fetched.retrievalMethod as Source["retrievalMethod"],
          retrievalAttempts: fetched.retrievalAttempts,
          retrievalMethodsSkipped: fetched.retrievalMethodsSkipped,
          extractionConfidence: fetched.extractionConfidence,
          extractionStatus: fetched.extractionStatus,
          retrievedContentLength: fetched.retrievedContentLength,
          subjectMismatchReason,
          quality: subjectMismatchReason
            ? { ...candidate.quality, relevance: 0, overall: 0 }
            : candidate.quality,
          taskEvidence: subjectMismatchReason
            ? {
                status: "INSUFFICIENT_EVIDENCE",
                missingFacts: [subjectMismatchReason],
              }
            : undefined,
          retrievalReasons: subjectMismatchReason
            ? [
                ...(fetched.retrievalReasons ?? []),
                `The extracted page title did not match the requested subject: ${subjectMismatchReason}`,
              ]
            : fetched.retrievalReasons,
        };
      } catch (error) {
        retrieved = {
          ...candidate,
          fetchError: error instanceof Error ? error.message : "Source retrieval failed",
          retrievalAttempts: error instanceof SourceRetrievalError ? error.attempts : undefined,
          retrievalMethodsSkipped:
            error instanceof SourceRetrievalError ? error.skipped : undefined,
          retrievalReasons: error instanceof SourceRetrievalError ? error.reasons : undefined,
          extractionStatus: /too short|insufficient content/i.test(
            error instanceof Error ? error.message : String(error),
          )
            ? "INSUFFICIENT_CONTENT"
            : "FAILED",
          extractionConfidence: 0,
        };
      }
      fetchedSources.push(retrieved);
      // Verify the first useful lookup source before spending a page budget on weaker results.
      if (
        compactLookup &&
        retrieved.content?.trim() &&
        !retrieved.subjectMismatchReason &&
        requestedFactCoverage(question, retrieved.content).missing.length === 0
      )
        break;
    }

    fetchedSources.sort(
      (left, right) =>
        Number(Boolean(left.subjectMismatchReason)) - Number(Boolean(right.subjectMismatchReason)),
    );
    const evidenceSources = fetchedSources.filter((source) => !source.subjectMismatchReason);

    // 4. Synthesize directly with citations
    const requestedFacts = extractRequestedFacts(interpretation.normalizedQuestion);
    const structuredObjectives = generateStructuredObjectives(
      interpretation,
      "quick",
      requestedFacts,
    );
    const plan: ResearchPlan = {
      objectives: structuredObjectives.map((objective) => objective.label),
      structuredObjectives,
      requestedFacts,
      requestedFactRequirements: buildRequestedFactRequirements(requestedFacts),
      queries: [searchQuery],
      queryGroups: [{ category: "DIRECT", queries: [searchQuery] }],
      interpretation,
    };

    let answer: string;
    let answerSucceeded = false;
    let synthesisFailure: string | undefined;
    const registryIndex = evidenceSources.findIndex(
      (source) =>
        source.url === "https://registry.npmjs.org/react/latest" && Boolean(source.content),
    );
    const version =
      registryIndex >= 0
        ? evidenceSources[registryIndex].content?.match(
            /Published version or release tag:\s*(\d+\.\d+\.\d+)/i,
          )?.[1]
        : undefined;
    const canAnswerFromLatestRegistry =
      isReactVersionLookup &&
      version &&
      registryIndex >= 0 &&
      /\b(latest|current|newest|most recent)\b/i.test(question) &&
      !/\b\d+\.\d+(?:\.\d+)?\b/.test(question) &&
      requestedFacts.every((fact) => fact === "version" || fact === "latestness");
    if (canAnswerFromLatestRegistry) {
      answer = `The latest published React release on npm is version ${version} [${registryIndex + 1}].`;
      const validation = await this.llm.validateCitedAnswer(answer, evidenceSources);
      answer = validation.finalAnswer;
      toolEvents.push({
        tool: "synthesize",
        status: "complete",
        message: "Answered from verified structured source data",
        phase: "tool",
      });
      answerSucceeded =
        validation.status === "VALIDATED" &&
        !validation.failure &&
        requestedFactCoverage(question, [answer], { requestedFacts }).missing.length === 0;
    } else if (evidenceSources.every((source) => !source.content?.trim())) {
      answer =
        "I couldn't verify this current information from a retrieved source. Please try again later or narrow the question.";
      toolEvents.push({
        tool: "synthesize",
        status: "failed",
        message: "Synthesis skipped because no source content was successfully retrieved",
        phase: "tool",
      });
    } else if (!this.llm.enabled) {
      answer =
        "I found source links but couldn't generate a verified answer because synthesis is unavailable.";
      toolEvents.push({
        tool: "synthesize",
        status: "failed",
        message: "Synthesis unavailable because OpenRouter is not configured",
        phase: "tool",
      });
    } else {
      toolEvents.push({
        tool: "synthesize",
        status: "running",
        message: "Synthesizing fast lookup response",
        phase: "tool",
      });
      try {
        answer = await this.llm.synthesize(
          question,
          plan,
          evidenceSources,
          [],
          undefined,
          "quick",
          undefined,
          memoryContext,
        );
        const metrics = this.llm.metrics;
        answerSucceeded =
          answer.trim().length > 0 &&
          metrics.citationEntailment?.status === "VALIDATED" &&
          !metrics.citationEntailment.failure &&
          metrics.synthesis?.finalAnswerSource !== "unavailable" &&
          metrics.synthesis?.requiredFactCoverage.missing.length === 0 &&
          metrics.synthesis?.evidenceFactCoverage.missing.length === 0 &&
          !/Insufficient evidence|couldn't verify|cannot present it as sufficiently verified/i.test(
            answer,
          );
        if (!answerSucceeded) {
          answer = "I couldn't produce an answer grounded in the retrieved source content.";
        }
        toolEvents[toolEvents.length - 1] = {
          tool: "synthesize",
          status: answerSucceeded ? "complete" : "failed",
          message: answerSucceeded ? "synthesize complete" : "Synthesis returned no answer",
          phase: "tool",
        };
      } catch (err) {
        synthesisFailure = err instanceof Error ? err.message : "Unknown synthesis error";
        toolEvents[toolEvents.length - 1] = {
          tool: "synthesize",
          status: "failed",
          message: synthesisFailure,
          phase: "tool",
        };
        answer = `Failed to synthesize response: ${synthesisFailure}`;
      }
    }

    // 5. Persist the actual outcome; a transparent fallback is not a completed research result.
    const job = currentWorkerContext()?.lease.job;
    const sessionId =
      job?.payload.task === "chat" && typeof job.payload.sessionId === "string"
        ? job.payload.sessionId
        : randomUUID();
    const retrievedSources = evidenceSources.filter((source) => source.content?.trim());
    const fetchErrors = fetchedSources
      .map((source) => source.fetchError)
      .filter((error): error is string => Boolean(error));
    const failureReason = !rawResults.length
      ? "No search provider returned results."
      : retrievedSources.length === 0
        ? `No source content could be retrieved${fetchErrors.length ? `: ${fetchErrors.join("; ")}` : "."}`
        : !this.llm.enabled
          ? "Synthesis is unavailable because OpenRouter is not configured."
          : synthesisFailure
            ? `Synthesis failed: ${synthesisFailure}`
            : "Synthesis did not produce a usable answer.";
    const session: ResearchSession = {
      id: sessionId,
      question,
      mode: "quick",
      status: answerSucceeded ? "COMPLETED" : "FAILED",
      executionJobId: job?.id,
      executionLeaseGeneration: currentWorkerContext()?.lease.generation,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      plan,
      sources: fetchedSources,
      claims: [],
      conflicts: [],
      answer,
      error: answerSucceeded ? undefined : failureReason,
      searchAttempts,
      steps: [
        {
          id: randomUUID().slice(0, 8),
          label: "🧠 understand_query",
          status: "complete",
          detail: "Normalized the request and identified its intent",
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "🔎 web_search",
          status: rawResults.length > 0 ? "complete" : "failed",
          detail: `Searched: "${searchQuery}" (${rawResults.length} results found)`,
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "🧭 source_triage",
          status: topCandidates.length > 0 ? "complete" : "failed",
          detail: `Selected ${topCandidates.length} of ${rawResults.length} results for retrieval`,
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "📄 fetch_url",
          status: retrievedSources.length > 0 ? "complete" : "failed",
          detail: `Retrieved usable content from ${retrievedSources.length} of ${fetchedSources.length} sources`,
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "✍️ synthesize",
          status: answerSucceeded ? "complete" : "failed",
          detail: answerSucceeded
            ? "Generated concise lookup answer with citations"
            : failureReason,
          at: new Date().toISOString(),
        },
      ],
    };

    if (this.store) {
      await this.store.create(session);
    }

    return {
      route: "web",
      interpretation,
      answer,
      sources: fetchedSources,
      researchId: sessionId,
      session,
      toolEvents,
      durationMs: Date.now() - startedAt,
    };
  }

  async handle(...args: Parameters<AutonomousAgent["handleWithinContext"]>): Promise<ChatResponse> {
    return withOperationContext(() => this.handleWithinContext(...args));
  }

  private async handleWithinContext(
    question: string,
    deepResearch: boolean,
    memoryContext?: string,
    enqueueResearch?: (
      question: string,
      mode: ResearchMode,
      memoryContext?: string,
      interpretation?: QueryInterpretation,
    ) => Promise<{ session: ResearchSession; jobId: string }>,
    interpretationOverride?: QueryInterpretation,
  ): Promise<ChatResponse> {
    const startedAt = Date.now();
    const toolEvents: AgentToolEvent[] = [];
    const interpretation =
      interpretationOverride ??
      (await this.use<QueryInterpretation>(toolEvents, "understand_query", {
        question,
        allowModel: false,
      }));
    if (interpretationOverride)
      toolEvents.push({
        tool: "understand_query",
        status: "complete",
        message: "Applied the persisted request interpretation",
        phase: "tool",
      });
    const decision = this.route(interpretation, deepResearch);
    toolEvents.push({
      tool: "decide_next_action",
      status: "complete",
      message: `Selected ${decision.route}`,
      phase: "decision",
      reason: decision.reason,
    });

    if (interpretation.needsClarification || interpretation.ambiguityScore >= 0.6) {
      const now = new Date().toISOString();
      const session: ResearchSession = {
        id:
          typeof currentWorkerContext()?.lease.job.payload.sessionId === "string"
            ? String(currentWorkerContext()!.lease.job.payload.sessionId)
            : randomUUID(),
        question,
        mode: deepResearch ? "deep" : "quick",
        status: "NEEDS_CLARIFICATION",
        createdAt: now,
        updatedAt: now,
        sources: [],
        claims: [],
        steps: [],
        answer:
          interpretation.clarificationQuestion ??
          "Please specify the subject and what you want to know.",
      };
      if (this.store) {
        if (await this.store.get(session.id)) await this.store.update(session);
        else await this.store.create(session);
      }
      return {
        route: decision.route,
        interpretation,
        answer: session.answer,
        session,
        researchId: session.id,
        toolEvents,
        durationMs: Date.now() - startedAt,
      };
    }

    // 1. Direct answer without external web search
    if (decision.effort === "low") {
      const answer = await this.use<string>(toolEvents, "synthesize", {
        kind: "direct",
        question,
        interpretation,
        memoryContext,
      });
      return {
        route: decision.route,
        interpretation,
        answer,
        toolEvents,
        durationMs: Date.now() - startedAt,
      };
    }

    // 2. Fast web lookup
    if (decision.effort === "medium" && !enqueueResearch) {
      return this.fastWebLookup(question, interpretation, toolEvents, startedAt, memoryContext);
    }

    // Durable normal Chat and Deep Research share the same evidence controller.
    const mode = decision.route === "deep" ? "deep" : "quick";
    const queued = enqueueResearch
      ? await enqueueResearch(question, mode, memoryContext, interpretation)
      : undefined;
    const session =
      queued?.session ??
      (await this.runner.start(question, mode, [], {
        memoryContext,
        interpretation,
        researchChatOptimization: true,
      }));
    return {
      route: decision.route,
      interpretation,
      researchId: session.id,
      ...(queued ? { jobId: queued.jobId } : {}),
      toolEvents,
      session,
      durationMs: Date.now() - startedAt,
    };
  }
}
