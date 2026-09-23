import { describe, expect, it } from "vitest";
import { generateStructuredObjectives, rewriteQueries } from "../src/planner.js";
import { rankResults } from "../src/rank.js";
import type { QueryInterpretation, SearchResult, ResearchObjective } from "../src/domain.js";
import { OpenRouterProvider } from "../src/llm.js";

describe("Research Intelligence v2 — Objectives, Diversity & Evidence Engine", () => {
  it("generates structured objectives with importance for comparison inquiries", () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "Compare Supabase vs Firebase for my startup",
      intent: "comparison",
      entities: ["Supabase", "Firebase"],
      topic: "Supabase vs Firebase comparison",
      dimensions: ["pricing", "auth", "scalability", "developer experience"],
      corrections: [],
      ambiguityScore: 0.1,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "comparison",
    };

    const objectives = generateStructuredObjectives(interpretation, "deep");
    expect(objectives.length).toBeGreaterThanOrEqual(4);

    const categories = objectives.map((o) => o.category);
    expect(categories).toContain("architecture");
    expect(categories).toContain("pricing");
    expect(categories).toContain("performance");
    expect(categories).toContain("ecosystem");

    const criticalObjs = objectives.filter((o) => o.importance === "critical");
    expect(criticalObjs.length).toBeGreaterThanOrEqual(2);
  });

  it("generates structured objectives for factual lookup inquiries", () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "What is the latest React version?",
      intent: "lookup",
      entities: ["React"],
      topic: "React",
      dimensions: ["version", "features"],
      corrections: [],
      ambiguityScore: 0.05,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };

    const objectives = generateStructuredObjectives(interpretation, "quick");
    expect(objectives.length).toBeGreaterThanOrEqual(2);

    const statusObj = objectives.find((o) => o.category === "status");
    expect(statusObj).toBeDefined();
    expect(statusObj?.importance).toBe("critical");
  });

  it("penalizes duplicate domains to enforce source diversity and prevent echo chambers", () => {
    const mockResults: SearchResult[] = [
      {
        title: "Medium Blog 1 - React State",
        url: "https://medium.com/@dev/post-1",
        snippet: "React Native performance and state benchmarks discussion",
      },
      {
        title: "Medium Blog 2 - React Architecture",
        url: "https://medium.com/@dev/post-2",
        snippet: "React Native vs Flutter comparison on medium",
      },
      {
        title: "Medium Blog 3 - React Opinions",
        url: "https://medium.com/@dev/post-3",
        snippet: "React Native mobile dev blog post",
      },
      {
        title: "Medium Blog 4 - Flutter Opinions",
        url: "https://medium.com/@dev/post-4",
        snippet: "Flutter mobile dev blog post",
      },
      {
        title: "Official React Native Documentation",
        url: "https://reactnative.dev/docs/performance",
        snippet: "Official documentation guide on React Native performance benchmarks",
      },
    ];

    const ranked = rankResults("React Native performance", mockResults);

    // Official documentation should be ranked at the very top
    expect(ranked[0].domain).toBe("reactnative.dev");
    expect(ranked[0].sourceType).toBe("documentation");

    // Medium blogs should receive diversity penalties as occurrences increase
    const mediumSources = ranked.filter((s) => s.domain === "medium.com");
    expect(mediumSources.length).toBe(4);
    expect(mediumSources[0].quality.overall).toBeGreaterThan(mediumSources[1].quality.overall);
    expect(mediumSources[1].quality.overall).toBeGreaterThan(mediumSources[2].quality.overall);
  });

  it("targets missing objectives during adaptive query rewriting", async () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "Compare Supabase vs Firebase",
      intent: "comparison",
      entities: ["Supabase", "Firebase"],
      topic: "comparison",
      dimensions: ["pricing", "scalability"],
      corrections: [],
      ambiguityScore: 0.1,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "comparison",
    };

    const missingObjectives: ResearchObjective[] = [
      {
        id: "obj-scalability",
        label: "Performance benchmarks, scalability, and production limits",
        category: "scalability",
        importance: "high",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
    ];

    const plan = {
      objectives: ["Compare Supabase vs Firebase"],
      queries: ["Supabase vs Firebase overview"],
      queryGroups: [],
      interpretation,
    };

    const disabledLLM = new OpenRouterProvider();
    const rewritten = await rewriteQueries(
      "Compare Supabase vs Firebase",
      plan,
      [],
      "deep",
      disabledLLM,
      missingObjectives,
    );

    expect(rewritten.length).toBeGreaterThanOrEqual(1);
    // Rewritten queries should explicitly include terms targeting the missing objective
    const mentionsMissing = rewritten.some(
      (q) => q.toLowerCase().includes("scalability") || q.toLowerCase().includes("benchmark"),
    );
    expect(mentionsMissing).toBe(true);
  });
});
