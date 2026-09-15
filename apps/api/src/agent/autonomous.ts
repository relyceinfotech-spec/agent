import type { ResearchSession, QueryInterpretation } from "../domain.js";
import { OpenRouterProvider } from "../llm.js";
import { ResearchRunner } from "../research.js";
import { ToolRegistry } from "./tools.js";

export type AgentRoute = "direct" | "web" | "deep";

export interface AgentRouteDecision {
  route: AgentRoute;
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
  researchId?: string;
  toolEvents: AgentToolEvent[];
  session?: ResearchSession;
}

export class AutonomousAgent {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly runner: ResearchRunner,
    private readonly llm: OpenRouterProvider,
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
        reason: "Deep Research was requested, so the agent selected the larger research budget.",
      };
    }
    const normalized = interpretation.normalizedQuestion.toLowerCase();
    if (interpretation.ambiguityScore >= 0.6) {
      return {
        route: "web",
        reason:
          "The interpretation is highly ambiguous, so the research path can clarify before committing to a factual answer.",
      };
    }
    if (/\b(latest|current|today|recent|news|2026|this week)\b/.test(normalized)) {
      return {
        route: "web",
        reason: "The question depends on current or time-sensitive information.",
      };
    }
    if (
      /\b(compare|comparison|versus|\bvs\b|better|best|faster|benchmark|investigate|research|analy[sz]e)\b/.test(
        normalized,
      )
    ) {
      return {
        route: "web",
        reason:
          "The question needs comparison, investigation, or evidence from multiple perspectives.",
      };
    }
    return {
      route: "direct",
      reason: "The question is stable and can be answered without external research.",
    };
  }
  async handle(question: string, deepResearch: boolean): Promise<ChatResponse> {
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
    if (decision.route === "direct") {
      const answer = await this.use<string>(toolEvents, "synthesize", { kind: "direct", question });
      return {
        route: decision.route,
        interpretation,
        answer,
        toolEvents,
      };
    }
    const session = await this.runner.start(question, decision.route === "deep" ? "deep" : "quick");
    return {
      route: decision.route,
      interpretation,
      researchId: session.id,
      toolEvents,
      session,
    };
  }
}
