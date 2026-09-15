import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "../src/llm.js";
import { buildPlan } from "../src/planner.js";

describe("query understanding and planning", () => {
  const llm = new OpenRouterProvider();

  it("normalizes obvious typos and never emits the raw sentence as a search query", async () => {
    const raw = "how react natve perfomance compare fluter 2026";
    const plan = await buildPlan(raw, "deep", llm);
    expect(plan.interpretation.entities).toEqual(
      expect.arrayContaining(["React Native", "Flutter"]),
    );
    expect(plan.interpretation.corrections.length).toBeGreaterThan(0);
    expect(plan.queries.every((query) => query.toLowerCase() !== raw)).toBe(true);
    expect(plan.queryGroups.map((group) => group.category)).toEqual(
      expect.arrayContaining(["DIRECT", "OFFICIAL", "RECENT", "EXPERT", "CONTRARY"]),
    );
  });

  it("pauses ambiguous comparisons instead of silently choosing a criterion", async () => {
    const plan = await buildPlan("Is Node better than NocoDB for backend?", "quick", llm);
    expect(plan.interpretation.ambiguityScore).toBeGreaterThanOrEqual(0.6);
    expect(plan.interpretation.needsClarification).toBe(true);
  });
});
