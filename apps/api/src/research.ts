import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type {
  Claim,
  Conflict,
  ResearchDecision,
  ResearchEvent,
  ResearchSession,
  ResearchStep,
  ResearchMode,
  Source,
  SearchResult,
} from "./domain.js";
import { OpenRouterProvider } from "./llm.js";
import { buildPlan, rewriteQueries } from "./planner.js";
import { rankResults } from "./rank.js";
import type { SearchProvider } from "./search.js";
import type { SessionStore } from "./store.js";
import { createToolRegistry, ToolRegistry } from "./agent/tools.js";

type Listener = (event: ResearchEvent) => void;
type Action =
  | "web_search"
  | "source_triage"
  | "fetch_url"
  | "extract_claims"
  | "gather_evidence"
  | "verify_claims"
  | "detect_conflicts"
  | "search_again"
  | "synthesize";
export interface ResearchBudget {
  maxSteps: number;
  maxQueries: number;
  maxSources: number;
  maxPages: number;
  maxSearchPasses: number;
  maxClaimsToVerify: number;
  maxTimeMs: number;
  maxModelDecisions: number;
}
interface LoopState {
  mode: ResearchMode;
  plan: Awaited<ReturnType<typeof buildPlan>>;
  rawResults: SearchResult[];
  rankedSources: Source[];
  fetchedSources: Source[];
  claims: Claim[];
  conflicts: Conflict[];
  searched: boolean;
  triaged: boolean;
  searchPasses: number;
  fetchedUrls: Set<string>;
  claimsExtractedFor: number;
  evidenceGathered: boolean;
  verified: boolean;
  conflictsChecked: boolean;
  queriesIssued: number;
  modelDecisions: number;
  actionsExecuted: number;
}

interface EvidenceAssessment {
  sufficient: boolean;
  reasons: string[];
}

function budgetFor(mode: ResearchMode, overrides: Partial<ResearchBudget> = {}): ResearchBudget {
  const deep = mode === "deep";
  const defaults: ResearchBudget = {
    maxSteps: Math.max(config.MAX_RESEARCH_STEPS, deep ? 20 : 10),
    maxQueries: Math.min(config.MAX_SEARCH_QUERIES, deep ? 16 : 8),
    maxSources: Math.min(config.MAX_SOURCES, deep ? 12 : 6),
    maxPages: Math.min(config.MAX_PAGES, deep ? 8 : 4),
    maxSearchPasses: deep ? 2 : 1,
    maxClaimsToVerify: deep ? 10 : 5,
    maxTimeMs: config.MAX_RESEARCH_TIME_MS,
    maxModelDecisions: config.MAX_MODEL_DECISIONS,
  };
  return {
    maxSteps: Math.min(defaults.maxSteps, overrides.maxSteps ?? defaults.maxSteps),
    maxQueries: Math.min(defaults.maxQueries, overrides.maxQueries ?? defaults.maxQueries),
    maxSources: Math.min(defaults.maxSources, overrides.maxSources ?? defaults.maxSources),
    maxPages: Math.min(defaults.maxPages, overrides.maxPages ?? defaults.maxPages),
    maxSearchPasses: Math.min(
      defaults.maxSearchPasses,
      overrides.maxSearchPasses ?? defaults.maxSearchPasses,
    ),
    maxClaimsToVerify: Math.min(
      defaults.maxClaimsToVerify,
      overrides.maxClaimsToVerify ?? defaults.maxClaimsToVerify,
    ),
    maxTimeMs: Math.min(defaults.maxTimeMs, overrides.maxTimeMs ?? defaults.maxTimeMs),
    maxModelDecisions: Math.min(
      defaults.maxModelDecisions,
      overrides.maxModelDecisions ?? defaults.maxModelDecisions,
    ),
  };
}
function statusFor(action: Action): ResearchSession["status"] {
  if (action === "web_search" || action === "search_again") return "SEARCHING";
  if (action === "fetch_url") return "FETCHING";
  if (action === "synthesize") return "SYNTHESIZING";
  return "ANALYZING";
}
function labelFor(action: Action) {
  return {
    web_search: "🔎 web_search",
    source_triage: "🧭 source_triage",
    fetch_url: "📄 fetch_url + extract_content",
    extract_claims: "🧠 extract_claims",
    gather_evidence: "🔗 gather_evidence",
    verify_claims: "✅ verify_claim",
    detect_conflicts: "⚖️ detect_conflict",
    search_again: "🔄 search_again",
    synthesize: "✍️ synthesize",
  }[action];
}

export class ResearchRunner {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly registry: ToolRegistry;
  constructor(
    private readonly store: SessionStore,
    private readonly search: SearchProvider,
    private readonly llm = new OpenRouterProvider(),
    registry?: ToolRegistry,
    private readonly budgetOverrides: Partial<ResearchBudget> = {},
  ) {
    this.registry = registry ?? createToolRegistry(search, llm);
  }
  subscribe(id: string, listener: Listener): () => void {
    const bucket = this.listeners.get(id) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(id, bucket);
    return () => bucket.delete(listener);
  }
  private emit(id: string, event: ResearchEvent) {
    this.listeners.get(id)?.forEach((listener) => listener(event));
  }
  async start(question: string, mode: ResearchMode): Promise<ResearchSession> {
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: randomUUID(),
      question,
      mode,
      status: "QUEUED",
      createdAt: now,
      updatedAt: now,
      sources: [],
      claims: [],
      conflicts: [],
      decisions: [],
      steps: [],
    };
    await this.store.create(session);
    void this.run(session.id);
    return session;
  }
  async resume(id: string, clarification: string): Promise<ResearchSession | undefined> {
    const current = await this.store.get(id);
    if (!current || current.status !== "NEEDS_CLARIFICATION") return current;
    const next = await this.update(id, {
      question: `${current.question}\nClarification: ${clarification.trim()}`,
      status: "QUEUED",
      plan: undefined,
      sources: [],
      claims: [],
      conflicts: [],
      decisions: [],
      answer: undefined,
      error: undefined,
      steps: [],
    });
    if (next) void this.run(id);
    return next;
  }
  private async update(id: string, patch: Partial<ResearchSession>) {
    const current = await this.store.get(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.store.update(next);
    return next;
  }
  private async step(id: string, label: string, status: ResearchStep["status"], detail?: string) {
    const current = await this.store.get(id);
    if (!current) return;
    const item: ResearchStep = {
      id: randomUUID(),
      label,
      status,
      detail,
      at: new Date().toISOString(),
    };
    const next = await this.update(id, { steps: [...current.steps, item] });
    this.emit(id, { type: "research.step", message: detail ?? label, step: item });
    return next;
  }
  private async recordDecision(id: string, decision: Omit<ResearchDecision, "id" | "at">) {
    const current = await this.store.get(id);
    if (!current) return;
    const item: ResearchDecision = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...decision,
    };
    await this.update(id, { decisions: [...(current.decisions ?? []), item] });
    await this.step(
      id,
      "🤔 decide_next_action",
      "complete",
      `${decision.controllerDecision}: ${decision.nextAction} — ${decision.reason}`,
    );
  }
  private async useTool<T>(id: string, action: Action, input: unknown): Promise<T> {
    const label = labelFor(action);
    await this.step(id, label, "running");
    try {
      const result = (await this.registry.execute(
        action === "source_triage"
          ? "compare_sources"
          : action === "extract_claims"
            ? "extract_claims"
            : action === "verify_claims"
              ? "verify_claim"
              : action === "detect_conflicts"
                ? "detect_conflict"
                : action,
        input,
      )) as T;
      await this.step(id, label, "complete");
      return result;
    } catch (error) {
      await this.step(
        id,
        label,
        "failed",
        error instanceof Error ? error.message : `${label} failed`,
      );
      throw error;
    }
  }
  private async searchBatch(queries: string[]): Promise<SearchResult[]> {
    return this.registry.execute("web_search", { queries }) as Promise<SearchResult[]>;
  }
  private pendingSource(state: LoopState, budget: ResearchBudget) {
    if (state.fetchedSources.length >= budget.maxPages) return undefined;
    return state.rankedSources.find(
      (source) => !state.fetchedUrls.has(source.url) && !source.fetchError,
    );
  }
  private assessEvidence(state: LoopState): EvidenceAssessment {
    const supported = state.claims.filter(
      (claim) => claim.verification?.verdict === "supported",
    ).length;
    const minimumClaims = state.plan.interpretation.dimensions.length > 4 ? 4 : 2;
    const reasons: string[] = [];
    if (state.rankedSources.length === 0) reasons.push("no relevant sources passed triage");
    if (state.claims.length < minimumClaims)
      reasons.push(`only ${state.claims.length}/${minimumClaims} claims were extracted`);
    if (supported < Math.min(2, minimumClaims))
      reasons.push(`only ${supported}/${Math.min(2, minimumClaims)} claims are supported`);
    if (state.conflicts.some((conflict) => conflict.status === "open"))
      reasons.push("credible source conflicts remain open");
    return { sufficient: reasons.length === 0, reasons };
  }
  private needsMoreEvidence(state: LoopState, budget: ResearchBudget) {
    return !this.assessEvidence(state).sufficient && state.searchPasses < budget.maxSearchPasses;
  }
  private nextAction(state: LoopState, budget: ResearchBudget): Action {
    if (!state.searched) return "web_search";
    if (!state.triaged) return "source_triage";
    if (this.pendingSource(state, budget)) return "fetch_url";
    if (state.fetchedSources.length > 0 && state.claimsExtractedFor !== state.fetchedSources.length)
      return "extract_claims";
    if (!state.evidenceGathered) return "gather_evidence";
    if (!state.verified) return "verify_claims";
    if (!state.conflictsChecked) return "detect_conflicts";
    if (state.queriesIssued < budget.maxQueries && this.needsMoreEvidence(state, budget))
      return "search_again";
    return "synthesize";
  }
  /**
   * Returns the set of actions the model may choose from at this point.
   *
   * The model is only consulted when there is a GENUINE branch — more than one
   * action is valid. When only one action is possible the controller executes
   * it deterministically without an LLM round-trip, saving ~15 s of latency
   * per skipped call.
   *
   * Branch points where the model adds real value:
   *  • After evidence is gathered: model may synthesize early when evidence is
   *    already sufficient, or continue with verify_claims for thoroughness.
   *    The evidence guard still applies — "synthesize" is only offered when
   *    assessEvidence() says sufficient, so the model cannot bypass it.
   *  • After conflict detection: when budget allows a search_again the model
   *    may choose to investigate further or synthesize if time is short.
   */
  private allowedActions(state: LoopState, budget: ResearchBudget): Action[] {
    const next = this.nextAction(state, budget);
    const evidence = this.assessEvidence(state);
    const queriesLeft = budget.maxQueries - state.queriesIssued;

    // Branch: post-evidence-gathering, offer synthesize early only when
    // evidence is genuinely sufficient — controller guard is preserved.
    if (next === "verify_claims" && evidence.sufficient) {
      return ["verify_claims", "synthesize"];
    }

    // Branch: when search_again is recommended due to open conflicts, the
    // model may choose to investigate further or accept current evidence.
    if (
      next === "search_again" &&
      queriesLeft > 0 &&
      state.conflicts.some((conflict) => conflict.status === "open")
    ) {
      return ["search_again", "synthesize"];
    }

    // All other steps are fully deterministic — skip the LLM call.
    return [next];
  }
  private observation(state: LoopState, budget: ResearchBudget): Record<string, unknown> {
    const evidence = this.assessEvidence(state);
    return {
      objectives: state.plan.objectives,
      dimensions: state.plan.interpretation.dimensions,
      relevantSources: `${state.rankedSources.length}/${state.rawResults.length}`,
      fetchedSources: state.fetchedSources.filter((source) => source.content).length,
      claims: state.claims.length,
      supportedClaims: state.claims.filter((claim) => claim.verification?.verdict === "supported")
        .length,
      openConflicts: state.conflicts.filter((conflict) => conflict.status === "open").length,
      evidenceStatus: evidence.sufficient ? "SUFFICIENT" : "INSUFFICIENT",
      missingEvidence: evidence.reasons,
      budgetRemaining: {
        queries: Math.max(0, budget.maxQueries - state.queriesIssued),
        pages: Math.max(0, budget.maxPages - state.fetchedSources.length),
        searchPasses: Math.max(0, budget.maxSearchPasses - state.searchPasses),
        steps: Math.max(0, budget.maxSteps - state.actionsExecuted),
        modelDecisions: Math.max(0, budget.maxModelDecisions - state.modelDecisions),
      },
    };
  }
  private async chooseAction(
    id: string,
    state: LoopState,
    budget: ResearchBudget,
  ): Promise<Action> {
    const allowed = this.allowedActions(state, budget);
    const recommended = allowed[0];
    const evidence = this.assessEvidence(state);

    // Skip the LLM when the next step is fully deterministic — only one option
    // exists so there is no real decision to make. This eliminates the largest
    // source of unnecessary latency (~15 s per skipped call).
    if (allowed.length === 1) {
      await this.recordDecision(id, {
        requestedAction: undefined,
        controllerDecision: "fallback",
        nextAction: recommended,
        reason: "deterministic controller step — single valid action, no model decision needed",
      });
      return recommended;
    }

    // Genuine branch: model has real options. Consult it if available.
    let requestedAction: string | undefined;
    if (this.llm.enabled && state.modelDecisions < budget.maxModelDecisions) {
      try {
        requestedAction = await this.llm.proposeResearchAction(
          this.observation(state, budget),
          allowed,
        );
        state.modelDecisions += 1;
      } catch {
        requestedAction = undefined;
      }
    }
    const requested = requestedAction as Action | undefined;
    if (requested && allowed.includes(requested)) {
      await this.recordDecision(id, {
        requestedAction,
        controllerDecision: "allow",
        nextAction: requested,
        reason: evidence.sufficient
          ? "evidence sufficiency guard passed"
          : "action is valid for the current state",
      });
      return requested;
    }
    await this.recordDecision(id, {
      requestedAction,
      controllerDecision: requestedAction ? "override" : "fallback",
      nextAction: recommended,
      reason: requestedAction
        ? `requested action is not in the allowed set; ${evidence.reasons.join("; ") || "controller sequencing guard"}`
        : "model decision unavailable — deterministic fallback",
    });
    return recommended;
  }
  private async executeAction(
    id: string,
    state: LoopState,
    action: Action,
    budget: ResearchBudget,
  ) {
    if (action === "web_search") {
      const reservedRewriteQueries = Math.min(budget.maxSearchPasses, budget.maxQueries - 1);
      const initialQueryLimit = Math.max(1, budget.maxQueries - reservedRewriteQueries);
      const queries = state.plan.queries.slice(
        0,
        Math.min(initialQueryLimit, budget.maxQueries - state.queriesIssued),
      );
      const results = await this.useTool<SearchResult[]>(id, action, {
        queries,
      });
      state.rawResults.push(...results);
      state.queriesIssued += queries.length;
      state.searched = true;
      return;
    }
    if (action === "source_triage") {
      const ranked = rankResults(state.plan.interpretation.normalizedQuestion, state.rawResults);
      const relevant = ranked.filter(
        (source) => source.quality.relevance >= 0.3 && source.quality.overall >= 0.4,
      );
      state.rankedSources = relevant.slice(0, budget.maxSources);
      state.triaged = true;
      await this.step(
        id,
        labelFor(action),
        "complete",
        `${state.rankedSources.length} of ${ranked.length} sources selected after relevance, authority, freshness, and duplicate checks`,
      );
      return;
    }
    if (action === "fetch_url") {
      const source = this.pendingSource(state, budget);
      if (!source) return;
      try {
        const fetched = await this.useTool<{ html: string; url: string }>(id, action, {
          url: source.url,
        });
        const document = (await this.registry.execute("extract_content", {
          html: fetched.html,
          url: fetched.url,
        })) as { title: string; content: string };
        state.fetchedSources.push({
          ...source,
          title: document.title || source.title,
          content: document.content.slice(0, 12000),
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        state.fetchedSources.push({
          ...source,
          fetchError: error instanceof Error ? error.message : "Fetch failed",
        });
      }
      state.fetchedUrls.add(source.url);
      return;
    }
    if (action === "extract_claims") {
      state.claims = await this.useTool<Claim[]>(id, action, { sources: state.fetchedSources });
      state.claimsExtractedFor = state.fetchedSources.length;
      return;
    }
    if (action === "gather_evidence") {
      const sourceMap = new Map(state.fetchedSources.map((source) => [source.id, source]));
      state.claims = state.claims.map((claim) => ({
        ...claim,
        evidence:
          claim.sourceIds
            .map((sourceId) => sourceMap.get(sourceId)?.content ?? "")
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 1200) || claim.evidence,
      }));
      await this.useTool<Claim[]>(id, action, { claims: state.claims });
      state.evidenceGathered = true;
      return;
    }
    if (action === "verify_claims") {
      const pending = state.claims
        .filter((claim) => !claim.verification)
        .slice(0, budget.maxClaimsToVerify);
      for (const claim of pending) {
        const result = await this.useTool<{
          verdict?: string;
          rationale?: string;
          status?: string;
        }>(id, action, { claim: claim.text, evidence: claim.evidence });
        const rawVerdict = result.verdict?.toLowerCase() ?? "";
        const verdict = rawVerdict.includes("support")
          ? "supported"
          : rawVerdict.includes("contrad")
            ? "contradicted"
            : rawVerdict.includes("uncertain")
              ? "uncertain"
              : "unavailable";
        claim.verification = {
          verdict,
          rationale:
            result.rationale ??
            (result.status === "unavailable"
              ? "Verification unavailable without an LLM provider"
              : undefined),
        };
      }
      state.verified = true;
      return;
    }
    if (action === "detect_conflicts") {
      const detected = await this.useTool<
        Array<{
          claimIds?: string[];
          sourceIds?: string[];
          description?: string;
          status?: "open" | "resolved" | "uncertain";
        }>
      >(id, action, { claims: state.claims });
      state.conflicts = detected.map((conflict) => ({
        id: randomUUID().slice(0, 8),
        claimIds: conflict.claimIds ?? [],
        sourceIds: conflict.sourceIds ?? [],
        description: conflict.description ?? "Sources may disagree",
        status: conflict.status ?? "open",
      }));
      state.conflictsChecked = true;
      return;
    }
    if (action === "search_again") {
      const rewritten = await rewriteQueries(
        state.plan.interpretation.normalizedQuestion,
        state.plan,
        state.rawResults,
        state.mode,
        this.llm,
      );
      if (rewritten.length === 0) {
        state.searchPasses = budget.maxSearchPasses;
        return;
      }
      const queries = rewritten.slice(0, budget.maxQueries - state.queriesIssued);
      if (queries.length === 0) {
        state.searchPasses = budget.maxSearchPasses;
        return;
      }
      const results = await this.useTool<SearchResult[]>(id, action, { queries });
      state.rawResults.push(...results);
      state.queriesIssued += queries.length;
      state.searchPasses += 1;
      state.triaged = false;
      state.fetchedUrls = new Set(state.fetchedSources.map((source) => source.url));
      state.evidenceGathered = false;
      state.verified = false;
      state.conflictsChecked = false;
      state.plan = { ...state.plan, queries: [...state.plan.queries, ...rewritten] };
      await this.update(id, { plan: state.plan });
      return;
    }
  }
  private async run(id: string) {
    try {
      const session = await this.store.get(id);
      if (!session) return;
      const budget = budgetFor(session.mode, this.budgetOverrides);
      const startedAt = Date.now();
      await this.update(id, { status: "PLANNING" });
      const plan = await buildPlan(session.question, session.mode, this.llm);
      await this.update(id, { plan });
      await this.step(
        id,
        "🧠 understand_query + plan",
        "complete",
        `${plan.interpretation.intent}; ambiguity ${plan.interpretation.ambiguityScore.toFixed(2)}`,
      );
      if (plan.interpretation.needsClarification) {
        const waiting = await this.update(id, { status: "NEEDS_CLARIFICATION" });
        await this.step(
          id,
          "❓ clarification",
          "complete",
          plan.interpretation.clarificationQuestion,
        );
        if (waiting)
          this.emit(id, {
            type: "research.clarification",
            message:
              plan.interpretation.clarificationQuestion ?? "Please clarify the research request",
            session: waiting,
          });
        return;
      }
      if (Date.now() - startedAt >= budget.maxTimeMs) {
        await this.step(
          id,
          "🛑 budget exhausted",
          "complete",
          "Stopped safely because the session budget was exhausted during planning",
        );
        const completed = await this.update(id, {
          status: "COMPLETED",
          plan,
          answer:
            "Research stopped safely because the configured session budget was exhausted during planning.",
        });
        if (completed)
          this.emit(id, {
            type: "research.completed",
            message: "Research completed within the bounded session budget",
            session: completed,
          });
        return;
      }
      const state: LoopState = {
        mode: session.mode,
        plan,
        rawResults: [],
        rankedSources: [],
        fetchedSources: [],
        claims: [],
        conflicts: [],
        searched: false,
        triaged: false,
        searchPasses: 0,
        fetchedUrls: new Set(),
        claimsExtractedFor: 0,
        evidenceGathered: false,
        verified: false,
        conflictsChecked: false,
        queriesIssued: 0,
        modelDecisions: 0,
        actionsExecuted: 0,
      };
      let answer = "";
      let iterations = 0;
      while (iterations < budget.maxSteps && Date.now() - startedAt < budget.maxTimeMs) {
        const action = await this.chooseAction(id, state, budget);
        await this.update(id, {
          status: statusFor(action),
          sources: state.fetchedSources.length ? state.fetchedSources : state.rankedSources,
          claims: state.claims,
          conflicts: state.conflicts,
        });
        if (action === "synthesize") {
          const evidence = this.assessEvidence(state);
          if (!evidence.sufficient)
            answer = `Research stopped within its bounded budget before evidence was sufficient: ${evidence.reasons.join(
              "; ",
            )}.`;
          else if (state.claims.length === 0)
            answer =
              "Research completed, but the retrieved sources did not contain extractable text.";
          else if (this.llm.enabled)
            answer = (await this.registry.execute("synthesize", {
              kind: "research",
              question: session.question,
              plan: state.plan,
              sources: state.fetchedSources,
              claims: state.claims,
            })) as string;
          else
            answer = `## Research summary\n\nOpenRouter is not configured, so automated synthesis is unavailable. MAX collected ${state.claims.length} claims from ${state.fetchedSources.filter((source) => source.content).length} pages.`;
          await this.step(id, "✍️ synthesize", "complete");
          break;
        }
        await this.executeAction(id, state, action, budget);
        iterations += 1;
        state.actionsExecuted = iterations;
      }
      if (!answer)
        await this.step(
          id,
          "🛑 budget exhausted",
          "complete",
          `Stopped safely after ${iterations} research actions within the configured session budget`,
        );
      if (!answer)
        answer =
          state.claims.length > 0
            ? `Research reached its bounded ${budget.maxSteps}-step budget with ${state.claims.length} claims. Review the evidence and sources collected.`
            : "Research ended without enough extractable evidence.";
      const complete = await this.update(id, {
        status: "COMPLETED",
        sources: state.fetchedSources.length ? state.fetchedSources : state.rankedSources,
        claims: state.claims,
        conflicts: state.conflicts,
        plan: state.plan,
        answer,
      });
      if (complete)
        this.emit(id, {
          type: "research.completed",
          message: "Research completed",
          session: complete,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Research failed";
      const failed = await this.update(id, { status: "FAILED", error: message });
      this.emit(id, { type: "research.failed", message, session: failed });
    }
  }
}
