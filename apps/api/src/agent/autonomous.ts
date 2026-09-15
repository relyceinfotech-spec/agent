import { randomUUID } from "node:crypto";
import type {
  ResearchSession,
  QueryInterpretation,
  SearchResult,
  Source,
  ResearchPlan,
} from "../domain.js";
import { OpenRouterProvider } from "../llm.js";
import { rankResults } from "../rank.js";
import { ResearchRunner } from "../research.js";
import type { SessionStore } from "../store.js";
import { ToolRegistry } from "./tools.js";
import { pMap } from "../concurrency.js";
import { config } from "../config.js";

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
  toolEvents: AgentToolEvent[];
  session?: ResearchSession;
  durationMs?: number;
}

export class AutonomousAgent {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly runner: ResearchRunner,
    private readonly llm: OpenRouterProvider,
    private readonly store?: SessionStore,
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

    const isComparison =
      interpretation.formatPreference === "comparison" ||
      /\b(compare|comparison|versus|\bvs\b|better|difference between|differences)\b/i.test(
        normalized,
      ) ||
      interpretation.entities.length >= 2;

    const isDeepInvestigation =
      /\b(deep|investigate|thorough|in-depth|comprehensive|evaluate|benchmark|analy[sz]e)\b/i.test(
        normalized,
      );

    // High effort for complex comparisons or deep investigations
    if (isDeepInvestigation || (isComparison && interpretation.entities.length >= 2)) {
      return {
        route: "web",
        effort: "high",
        reason:
          "The question requires comparative or deep evidence analysis from multiple perspectives.",
      };
    }

    // Medium effort for fast factual lookups, current status, release versions, or time-sensitive facts
    if (
      interpretation.formatPreference === "lookup" ||
      /\b(latest|current|today|recent|news|2026|this week|version|release date|when was|what version|status of)\b/i.test(
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
        route: "web",
        effort: "high",
        reason: "The question needs comparison or evidence from multiple perspectives.",
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
  ): Promise<ChatResponse> {
    const now = new Date().toISOString();
    const searchQuery = interpretation.normalizedQuestion;

    // 1. Search web (1 pass)
    let rawResults: SearchResult[] = [];
    try {
      rawResults = await this.use<SearchResult[]>(toolEvents, "web_search", {
        queries: [searchQuery],
      });
    } catch {
      rawResults = [];
    }

    // 2. Rank results and pick top 1-2 authoritative sources
    const ranked = rankResults(interpretation.normalizedQuestion, rawResults);
    const topCandidates = ranked.slice(0, 2);

    // 3. Fetch content with bounded concurrency for top candidates
    const fetchedSources: Source[] = await pMap(
      topCandidates,
      async (candidate) => {
        try {
          const fetched = await this.use<{ url: string; html: string }>(toolEvents, "fetch_url", {
            url: candidate.url,
          });
          const extracted = await this.use<{ content: string }>(toolEvents, "extract_content", {
            html: fetched.html,
            url: fetched.url,
          });
          return {
            ...candidate,
            content: extracted.content.slice(0, 4000),
            fetchedAt: new Date().toISOString(),
          };
        } catch {
          return candidate;
        }
      },
      config.MAX_CONCURRENT_FETCHES,
    );

    // 4. Synthesize directly with citations
    const plan: ResearchPlan = {
      objectives: [
        `Find factual and current information for: ${interpretation.normalizedQuestion}`,
        "Provide a direct, verified answer with source citations",
      ],
      queries: [searchQuery],
      queryGroups: [{ category: "DIRECT", queries: [searchQuery] }],
      interpretation,
    };

    let answer: string;
    if (!this.llm.enabled) {
      answer =
        fetchedSources.length > 0
          ? `Retrieved ${fetchedSources.length} sources for "${question}". OPENROUTER_API_KEY is not configured for synthesis.`
          : "OPENROUTER_API_KEY is not configured, so MAX cannot generate a direct answer yet.";
    } else {
      toolEvents.push({
        tool: "synthesize",
        status: "running",
        message: "Synthesizing fast lookup response",
        phase: "tool",
      });
      try {
        answer = await this.llm.synthesize(question, plan, fetchedSources, []);
        toolEvents[toolEvents.length - 1] = {
          tool: "synthesize",
          status: "complete",
          message: "synthesize complete",
          phase: "tool",
        };
      } catch (err) {
        toolEvents[toolEvents.length - 1] = {
          tool: "synthesize",
          status: "failed",
          message: err instanceof Error ? err.message : "synthesize failed",
          phase: "tool",
        };
        answer = `Failed to synthesize response: ${err instanceof Error ? err.message : "Unknown error"}`;
      }
    }

    // 5. Create completed session in store so frontend has full session data and citations
    const sessionId = randomUUID();
    const session: ResearchSession = {
      id: sessionId,
      question,
      mode: "quick",
      status: "COMPLETED",
      createdAt: now,
      updatedAt: new Date().toISOString(),
      plan,
      sources: fetchedSources,
      claims: [],
      conflicts: [],
      answer,
      steps: [
        {
          id: randomUUID().slice(0, 8),
          label: "🔎 web_search",
          status: "complete",
          detail: `Searched: "${searchQuery}" (${rawResults.length} results found)`,
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "📄 fetch_url",
          status: "complete",
          detail: `Retrieved and analyzed ${fetchedSources.length} sources`,
          at: now,
        },
        {
          id: randomUUID().slice(0, 8),
          label: "✍️ synthesize",
          status: "complete",
          detail: "Generated concise lookup answer with citations",
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

  async handle(question: string, deepResearch: boolean): Promise<ChatResponse> {
    const startedAt = Date.now();
    const toolEvents: AgentToolEvent[] = [];
    const interpretation = await this.use<QueryInterpretation>(toolEvents, "understand_query", {
      question,
    });
    const decision = this.route(interpretation, deepResearch);
    toolEvents.push({
      tool: "decide_next_action",
      status: "complete",
      message: `Selected ${decision.route}`,
      phase: "decision",
      reason: decision.reason,
    });

    // 1. Direct answer without external web search
    if (decision.effort === "low") {
      const answer = await this.use<string>(toolEvents, "synthesize", {
        kind: "direct",
        question,
        interpretation,
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
    if (decision.effort === "medium") {
      return this.fastWebLookup(question, interpretation, toolEvents, startedAt);
    }

    // 3. Deep research loop
    const session = await this.runner.start(question, decision.route === "deep" ? "deep" : "quick");
    return {
      route: decision.route,
      interpretation,
      researchId: session.id,
      toolEvents,
      session,
      durationMs: Date.now() - startedAt,
    };
  }
}
