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
