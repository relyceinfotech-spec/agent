import { describe, expect, it } from "vitest";
import type { ResearchSession } from "../src/domain.js";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { agentEvaluationCases } from "../src/evaluation/cases.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { ResearchRunner } from "../src/research.js";

function emptySession(question: string, mode: ResearchSession["mode"]): ResearchSession {
  const now = new Date().toISOString();
  return {
    id: "evaluation-session",
    question,
    mode,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    conflicts: [],
    steps: [],
  };
}

describe("autonomous decision quality v1", () => {
  it.each([
    ["Who is the CEO of Relyce Infotech?", "web", "medium"],
    ["Who founded OpenAI?", "web", "medium"],
    ["What is Tesla headquarters?", "web", "medium"],
    ["What is the CTO of Microsoft?", "web", "medium"],
    ["What does Company X do?", "web", "medium"],
    ["Explain JavaScript closures.", "direct", "low"],
    ["How do embeddings work?", "direct", "low"],
    ["Compare HNSW and IVF.", "direct", "low"],
    ["What is the latest React version?", "web", "medium"],
    ["Compare current HNSW and IVF benchmarks.", "web", "high"],
    ["Compare HNSW and IVF with citations.", "web", "high"],
  ] as const)("classifies factual lookup vs stable chat: %s", async (question, route, effort) => {
    const llm = new OpenRouterProvider();
    const agent = new AutonomousAgent(
      createToolRegistry({ search: async () => [] }, llm),
      {} as ResearchRunner,
      llm,
    );
    const preview = await agent.preview(question, false);
    expect(preview.decision).toMatchObject({ route, effort });
  });

  it("keeps explicit Deep Research and clarification priority", async () => {
    const llm = new OpenRouterProvider();
    const agent = new AutonomousAgent(
      createToolRegistry({ search: async () => [] }, llm),
      {} as ResearchRunner,
      llm,
    );
    expect(
      (await agent.preview("Who is the CEO of Relyce Infotech?", true)).decision,
    ).toMatchObject({
      route: "deep",
      effort: "high",
    });
    const ambiguousCase = agentEvaluationCases.find((testCase) => testCase.expect.clarification);
    expect(ambiguousCase).toBeDefined();
    const ambiguous = await agent.preview(ambiguousCase!.prompt, false);
    expect(ambiguous.interpretation.needsClarification).toBe(true);
    expect(ambiguous.decision.route).toBe("web");
  });

  it("routes representative prompts and records the decision trace", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) =>
        emptySession(question, mode),
    } as unknown as ResearchRunner;
    const agent = new AutonomousAgent(registry, runner, llm);
    const results = [];

    for (const testCase of agentEvaluationCases) {
      const response = await agent.handle(testCase.prompt, testCase.deepResearch ?? false);
      const decision = response.toolEvents.find((event) => event.tool === "decide_next_action");

      expect(decision?.phase).toBe("decision");
      expect(decision?.reason).toBeTruthy();
      expect(response.interpretation.normalizedQuestion).toBeTruthy();

      results.push({
        name: testCase.name,
        expectedRoute: testCase.expect.route,
        actualRoute: response.route,
        expectedClarification: testCase.expect.clarification ?? false,
        actualClarification: response.interpretation.needsClarification,
      });
    }

    const routingAccuracy =
      results.filter((result) => result.expectedRoute === result.actualRoute).length /
      results.length;
    const clarificationCases = results.filter((result) => result.expectedClarification);
    const clarificationAccuracy =
      clarificationCases.filter(
        (result) => result.expectedClarification === result.actualClarification,
      ).length / clarificationCases.length;

    console.info("Decision quality v1", {
      cases: results.length,
      routingAccuracy,
      clarificationAccuracy,
      routingMismatches: results.filter((result) => result.expectedRoute !== result.actualRoute),
    });

    expect(routingAccuracy).toBe(1);
    expect(clarificationAccuracy).toBe(1);
  });
});
