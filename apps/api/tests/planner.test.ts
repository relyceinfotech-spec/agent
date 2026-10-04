import { describe, expect, it, vi } from "vitest";
import {
  isQueryInterpretation,
  type QueryInterpretation,
  type ResearchRecoveryRequirements,
} from "../src/domain.js";
import { OpenRouterProvider } from "../src/llm.js";
import { buildPlan, rewriteQueries, validateRecoveryQuery } from "../src/planner.js";

describe("query understanding and planning", () => {
  const llm = new OpenRouterProvider();

  it("uses a precomputed interpretation without repeating query understanding", async () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "Which one should I choose?",
      intent: "Clarify the user's intended comparison",
      entities: [],
      topic: "general topic",
      dimensions: [],
      corrections: [],
      ambiguityScore: 0.7,
      ambiguityReasons: ["The comparison target is missing"],
      needsClarification: true,
      clarificationQuestion: "Which options should I compare?",
      formatPreference: "research",
      sourceRequirements: { officialSources: "none" },
    };
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("The precomputed interpretation should be reused");
      }),
    } as unknown as OpenRouterProvider;

    const plan = await buildPlan("Which one should I choose?", "deep", model, interpretation);

    expect(plan.interpretation).toBe(interpretation);
    expect(plan.interpretation.needsClarification).toBe(true);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("accepts persisted query interpretations only when their required shape is valid", () => {
    const valid: QueryInterpretation = {
      normalizedQuestion: "What is React?",
      intent: "Explain React",
      entities: ["React"],
      topic: "React",
      dimensions: [],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "direct",
      sourceRequirements: { officialSources: "none" },
    };

    expect(isQueryInterpretation(valid)).toBe(true);
    expect(isQueryInterpretation({ ...valid, ambiguityScore: 1.2 })).toBe(false);
    expect(isQueryInterpretation({ ...valid, entities: ["React", 3] })).toBe(false);
    expect(
      isQueryInterpretation({ ...valid, sourceRequirements: { officialSources: "maybe" } }),
    ).toBe(false);
  });

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

  it("plans clear deep comparisons without a slow model call and preserves requested dimensions", async () => {
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Planning model should not be called for a clear request");
      }),
    } as unknown as OpenRouterProvider;
    const plan = await buildPlan(
      "Compare Supabase and Firebase for pricing, auth, scalability and developer experience",
      "deep",
      model,
    );
    expect(model.complete).not.toHaveBeenCalled();
    expect(plan.interpretation.dimensions).toEqual(
      expect.arrayContaining(["pricing", "auth", "scalability", "developer experience"]),
    );
    expect(plan.structuredObjectives?.map((objective) => objective.category)).toEqual(
      expect.arrayContaining(["pricing", "auth", "performance", "ecosystem"]),
    );
    expect(plan.queryGroups.map((group) => group.category)).toEqual(
      expect.arrayContaining(["DIRECT", "OFFICIAL", "RECENT", "EXPERT", "CONTRARY"]),
    );
  });

  it("does not add pricing as a research objective for a mobile-framework comparison", async () => {
    const plan = await buildPlan(
      "Compare React Native and Flutter for a startup in 2026",
      "quick",
      llm,
    );
    expect(plan.structuredObjectives?.some((objective) => objective.category === "pricing")).toBe(
      false,
    );
    expect(
      plan.structuredObjectives?.some((objective) => objective.category === "performance"),
    ).toBe(true);
    expect(plan.queries.slice(0, 3)).toEqual([
      expect.stringContaining("React Native vs Flutter"),
      "React Native official performance documentation 2026",
      "Flutter official performance documentation 2026",
    ]);
  });

  it("puts requested version and release-date facts in the first lookup query", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.",
      "quick",
      llm,
    );

    expect(plan.interpretation.formatPreference).toBe("lookup");
    expect(plan.interpretation.sourceRequirements?.officialSources).toBe("required");
    expect(plan.queries[0]).toBe("React latest stable version release date official source");
    expect(plan.requestedFacts).toEqual(["version", "release date", "stable status", "latestness"]);
    expect(plan.requestedFactRequirements).toEqual({
      version: true,
      releaseDate: true,
      releaseStatus: false,
      stable: true,
      latest: true,
      endOfLifeDate: false,
      price: false,
      technicalValue: false,
    });
    expect(plan.interpretation.entities).toEqual(["React"]);
    expect(plan.interpretation.dimensions).toEqual([]);
    expect(plan.structuredObjectives?.map((objective) => objective.label)).toEqual([
      "Determine the latest stable version of React",
      "Verify the release date corresponding to the requested React version",
      "Verify official-source provenance for the requested React facts",
    ]);
    expect(plan.structuredObjectives?.map((objective) => objective.category)).toEqual([
      "status",
      "release_date",
      "documentation",
    ]);
    expect(plan.objectives.join(" ")).not.toMatch(
      /capabilit|benchmark|trade-off|limitation|comparison review|production analysis/i,
    );
    expect(plan.queries[0]).toContain("React");
    expect(plan.queries[0]).toContain("version");
    expect(plan.queries[0]).toContain("release date");
    expect(plan.queries[0]).toContain("official source");
  });

  it("keeps precise fact requests focused and does not invent facts for a general question", async () => {
    const latestPlan = await buildPlan("What is the latest version of React?", "quick", llm);
    const stablePlan = await buildPlan("What is the stable version of React?", "quick", llm);
    const datePlan = await buildPlan("What is the release date for React 19.3?", "quick", llm);
    const statusPlan = await buildPlan("What is the release status of React 19.3?", "quick", llm);
    const genericPlan = await buildPlan("What are React's capabilities?", "quick", llm);

    expect(latestPlan.requestedFacts).toEqual(["version", "latestness"]);
    expect(stablePlan.requestedFacts).toEqual(["version", "stable status"]);
    expect(datePlan.requestedFacts).toEqual(["release date"]);
    expect(statusPlan.requestedFacts).toEqual(["release status"]);
    expect(genericPlan.requestedFacts).toEqual([]);
    expect(genericPlan.requestedFactRequirements).toEqual({
      version: false,
      releaseDate: false,
      releaseStatus: false,
      stable: false,
      latest: false,
      endOfLifeDate: false,
      price: false,
      technicalValue: false,
    });
    expect(
      genericPlan.structuredObjectives?.some((objective) => objective.category === "status"),
    ).toBe(false);
    expect(genericPlan.interpretation.dimensions).toContain("capabilities");
  });

  it("plans Research Chat lifecycle questions around the requested entity and major version", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("The deterministic lifecycle planner should not need a model call");
      }),
    } as unknown as OpenRouterProvider;
    const plan = await buildPlan(question, "deep", model, undefined, {
      researchChatOptimization: true,
    });

    expect(model.complete).not.toHaveBeenCalled();
    expect(plan.requestedFacts).toEqual(["end-of-life date"]);
    expect(plan.requestedFactRequirements.endOfLifeDate).toBe(true);
    expect(plan.interpretation.entities).toEqual(["Node.js"]);
    expect(plan.interpretation.formatPreference).toBe("lookup");
    expect(plan.interpretation.dimensions).toEqual([]);
    expect(plan.queries[0]).toBe("Node.js 22 end of life date official support schedule");
    expect(plan.queries.join(" ")).not.toMatch(/capabilities|trade-offs|limitations/i);
    expect(plan.structuredObjectives?.map((objective) => objective.category)).toEqual([
      "end_of_life",
      "documentation",
    ]);
  });

  it("keeps support-lifecycle extraction opt-in outside Research Chat", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const plan = await buildPlan(question, "deep", llm);

    expect(plan.requestedFacts).toEqual([]);
    expect(plan.requestedFactRequirements.endOfLifeDate).toBe(false);
  });

  it("recovers lifecycle gaps with a version-specific official schedule query", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const plan = await buildPlan(question, "deep", llm, undefined, {
      researchChatOptimization: true,
    });
    const recoveryRequirements: ResearchRecoveryRequirements = {
      requestedFacts: ["end-of-life date"],
      resolvedFacts: [],
      unresolvedFacts: ["end-of-life date"],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: false, stable: false },
      officialSourceRequirement: "required",
      officialEvidenceResolved: false,
    };

    const queries = await rewriteQueries(
      question,
      plan,
      [],
      "deep",
      llm,
      undefined,
      recoveryRequirements,
    );

    expect(queries).toEqual([
      "Node.js 22 end-of-life date support lifecycle official release schedule",
    ]);
    expect(queries[0]).not.toBe(plan.queries[0]);
    expect(queries[0]).toContain("lifecycle");
    expect(validateRecoveryQuery(queries[0]!, question, plan, recoveryRequirements).accepted).toBe(
      true,
    );
  });

  it("chooses an untried generic source class for precise-fact recovery", async () => {
    const question = "Who is the CTO of Acme Systems?";
    const plan = await buildPlan(question, "quick", llm);
    const requirements: ResearchRecoveryRequirements = {
      requestedPredicate: {
        requirement: plan.interpretation.requestedPredicate!,
        resolved: false,
      },
      requestedFacts: [],
      resolvedFacts: [],
      unresolvedFacts: [],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: false, stable: false },
      officialSourceRequirement: "none",
      officialEvidenceResolved: false,
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          sourceClass: "company_profiles",
          query: '"Acme Systems" CTO company profile',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          sourceClass: "independent_reporting",
          query: '"Acme Systems" CTO interview',
        }),
      );
    const model = { enabled: true, complete } as unknown as OpenRouterProvider;
    const observation = {
      domain: "acmesystems.example",
      title: "Acme Systems services",
      sourceType: "official",
      retrievalStatus: "fetched" as const,
      extractionStatus: "SUCCEEDED",
      missingFacts: ["requested predicate"],
    };

    const [first] = await rewriteQueries(
      question,
      plan,
      [],
      "quick",
      model,
      undefined,
      requirements,
      { attemptedSourceClasses: ["company_profiles"], observedSources: [observation] },
    );
    expect(first).toMatch(/Acme Systems.*CTO.*professional biography staff directory/i);
    expect(first).not.toMatch(/company profile business directory/i);
    expect(validateRecoveryQuery(first!, question, plan, requirements).accepted).toBe(true);
    expect(complete.mock.calls[0]?.[1]).toContain("acmesystems.example");

    const [second] = await rewriteQueries(
      question,
      plan,
      [],
      "quick",
      model,
      undefined,
      requirements,
      {
        attemptedQueries: [first!],
        attemptedSourceClasses: ["company_profiles", "professional_profiles"],
        observedSources: [observation],
      },
    );
    expect(second).toMatch(/Acme Systems.*CTO.*news interview independent reporting/i);
    expect(validateRecoveryQuery(second!, question, plan, requirements).accepted).toBe(true);
  });

  it("turns price and technical specification requests into explicit requirements", async () => {
    const pricePlan = await buildPlan("What is the current price of React Pro?", "quick", llm);
    const technicalPlan = await buildPlan(
      "What is the maximum supported React version?",
      "quick",
      llm,
    );

    expect(pricePlan.requestedFacts).toContain("price");
    expect(technicalPlan.requestedFacts).toContain("technical value");
  });

  it("does not require official sources unless the user asks for them", async () => {
    const plan = await buildPlan("What is the latest React version?", "quick", llm);

    expect(plan.interpretation.sourceRequirements?.officialSources).toBe("none");
  });

  it("rejects model-generated generic searches when entity extraction found no topic entity", async () => {
    const question = "Rendering huge pull requests in the GitHub Copilot app";
    const model = {
      enabled: true,
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            normalizedQuestion: question,
            intent: "Explain and investigate the topic",
            entities: [],
            topic: "general topic",
            dimensions: ["capabilities", "trade-offs"],
            ambiguityScore: 0.28,
            needsClarification: false,
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            queryGroups: [{ category: "DIRECT", queries: ["What defines general topic?"] }],
          }),
        ),
    } as unknown as OpenRouterProvider;

    const plan = await buildPlan(question, "quick", model);

    expect(model.complete).toHaveBeenCalledTimes(2);
    expect(model.complete.mock.calls[1]?.[1]).toContain(`Research topic: ${question}`);
    expect(plan.queries).not.toContain("What defines general topic?");
    expect(plan.queries.some((query) => /pull|requests|github|copilot/i.test(query))).toBe(true);
  });

  it("uses a contextual heuristic plan for a clear entity-light Deep Research title without a model call", async () => {
    const question = "Rendering huge pull requests in the GitHub Copilot app";
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Clear entity-light Deep Research should use the heuristic plan");
      }),
    } as unknown as OpenRouterProvider;

    const plan = await buildPlan(question, "deep", model);

    expect(model.complete).not.toHaveBeenCalled();
    expect(plan.queries[0]).toContain("Rendering huge pull requests in the GitHub Copilot app");
  });

  it("tries a model recovery query for a known gap, then preserves the deterministic fallback", async () => {
    const plan = await buildPlan(
      "Compare React Native and Flutter for a startup in 2026",
      "quick",
      llm,
    );
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Known evidence gaps should use targeted queries");
      }),
    } as unknown as OpenRouterProvider;
    const missing =
      plan.structuredObjectives?.filter((item) => item.category === "ecosystem") ?? [];
    const queries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      model,
      missing,
    );
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(queries.some((query) => query.includes("ecosystem"))).toBe(true);
  });

  it("rewrites missing version and release-date facts into a distinct official recovery query", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date.",
      "quick",
      llm,
    );
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Known fact gaps should use a deterministic targeted query");
      }),
    } as unknown as OpenRouterProvider;
    const queries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      model,
      [],
      {
        requestedFacts: ["version", "release date", "stable status", "latestness"],
        resolvedFacts: [],
        unresolvedFacts: ["version", "release date", "stable status", "latestness"],
        latestnessRequired: true,
        latestnessResolved: false,
        qualifiers: { latest: true, stable: true },
        officialSourceRequirement: "required",
        officialEvidenceResolved: false,
      },
    );

    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toBe(plan.queries[0]);
    expect(queries[0]).toContain("React");
    expect(queries[0]).toContain("latest stable");
    expect(queries[0]).toContain("version");
    expect(queries[0]).toContain("release date");
    expect(queries[0]).toContain("official");
    expect(queries[0]).toContain("release notes");
  });

  it("targets a new maintainer schedule after an official source omitted the lifecycle fact", async () => {
    const question =
      "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
    const plan = await buildPlan(question, "deep", llm);
    const requirements: ResearchRecoveryRequirements = {
      requestedFacts: ["end-of-life date"],
      resolvedFacts: [],
      unresolvedFacts: ["end-of-life date"],
      factInsufficientSources: [
        {
          url: "https://nodejs.org/en/about/previous-releases",
          missingFacts: ["end-of-life date"],
        },
      ],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: false, stable: false },
      officialSourceRequirement: "required",
      officialEvidenceResolved: false,
    };
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Known lifecycle gaps must use deterministic recovery wording");
      }),
    } as unknown as OpenRouterProvider;

    const queries = await rewriteQueries(question, plan, [], "deep", model, [], requirements);

    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("Node.js 22");
    expect(queries[0]).toContain("end-of-life date");
    expect(queries[0]).toContain("maintainer working group schedule");
    expect(validateRecoveryQuery(queries[0]!, question, plan, requirements).accepted).toBe(true);
  });

  it("focuses the next recovery only on unresolved latestness after version and date resolve", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date.",
      "quick",
      llm,
    );
    const requirements: ResearchRecoveryRequirements = {
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      resolvedFacts: ["version", "release date", "stable status"],
      unresolvedFacts: ["latestness"],
      latestnessRequired: true,
      latestnessResolved: false,
      qualifiers: { latest: true, stable: true },
      officialSourceRequirement: "required",
      officialEvidenceResolved: true,
    };
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Structured latestness gaps must use a focused deterministic query");
      }),
    } as unknown as OpenRouterProvider;

    const firstRequirements: ResearchRecoveryRequirements = {
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      resolvedFacts: [],
      unresolvedFacts: ["version", "release date", "stable status", "latestness"],
      latestnessRequired: true,
      latestnessResolved: false,
      qualifiers: { latest: true, stable: true },
      officialSourceRequirement: "required",
      officialEvidenceResolved: false,
    };
    const firstQueries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      model,
      plan.structuredObjectives,
      firstRequirements,
    );
    const queries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      model,
      plan.structuredObjectives,
      requirements,
    );

    expect(firstQueries).toHaveLength(1);
    expect(firstQueries[0]).toContain("version");
    expect(firstQueries[0]).toContain("release date");
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toBe(firstQueries[0]);
    expect(queries[0]).toContain("latest");
    expect(queries[0]).toContain("stable");
    expect(queries[0]).toContain("release");
    expect(queries[0]).not.toContain("date");
    expect(queries[0]).not.toContain("version");
    expect(queries[0]).toContain("official");
    expect(queries[0]).not.toContain("features");
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it("targets a version newer than the highest known candidate instead of repeating a generic query", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date.",
      "quick",
      llm,
    );
    const requirements: ResearchRecoveryRequirements = {
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      resolvedFacts: ["version", "stable status"],
      unresolvedFacts: ["release date", "latestness"],
      latestnessRequired: true,
      latestnessResolved: false,
      knownVersionCandidates: ["19.2.0"],
      qualifiers: { latest: true, stable: true },
      officialSourceRequirement: "required",
      officialEvidenceResolved: true,
    };
    const model = {
      enabled: true,
      complete: vi.fn(async () => {
        throw new Error("Version-aware recovery should be deterministic");
      }),
    } as unknown as OpenRouterProvider;

    const queries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      model,
      [],
      requirements,
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("newer than 19.2.0");
    expect(queries[0]).toContain("latest stable");
    expect(queries[0]).toContain("official release notes history");
    expect(queries[0]).not.toBe(plan.queries[0]);
    expect(
      validateRecoveryQuery(queries[0]!, plan.interpretation.normalizedQuestion, plan, requirements)
        .accepted,
    ).toBe(true);
    expect(
      validateRecoveryQuery(
        "React latest stable release date official release notes history",
        plan.interpretation.normalizedQuestion,
        plan,
        requirements,
      ).reasons,
    ).toContain("latestness recovery query omitted the highest known version candidate");
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a broad recovery query that omits unresolved facts and official provenance", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date.",
      "quick",
      llm,
    );
    const requirements: ResearchRecoveryRequirements = {
      requestedFacts: ["version", "release date", "stable status", "latestness"],
      resolvedFacts: [],
      unresolvedFacts: ["version", "release date", "stable status", "latestness"],
      latestnessRequired: true,
      latestnessResolved: false,
      qualifiers: { latest: true, stable: true },
      officialSourceRequirement: "required",
      officialEvidenceResolved: false,
    };

    const result = validateRecoveryQuery(
      "React capabilities trade-offs latest",
      plan.interpretation.normalizedQuestion,
      plan,
      requirements,
    );

    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "recovery query omitted the stable-release qualifier",
        "recovery query does not target unresolved fact: version",
        "recovery query does not target unresolved fact: release date",
        "recovery query omitted the required official/primary-source constraint",
      ]),
    );
  });

  it("rejects a sibling entity from re-entering through recovery search", async () => {
    const plan = await buildPlan(
      "Investigate the latest stable React release using official React release sources; verify the version and release date.",
      "quick",
      llm,
    );
    const result = validateRecoveryQuery(
      "React Native latest stable version release date official release notes",
      plan.interpretation.normalizedQuestion,
      plan,
      {
        requestedFacts: ["version", "release date", "stable status", "latestness"],
        resolvedFacts: [],
        unresolvedFacts: ["version", "release date", "stable status", "latestness"],
        latestnessRequired: true,
        latestnessResolved: false,
        qualifiers: { latest: true, stable: true },
        officialSourceRequirement: "required",
        officialEvidenceResolved: false,
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain(
      "Candidate names React Native, a more-specific entity than the requested React.",
    );
  });

  it("targets the least-covered objectives before higher-coverage gaps", async () => {
    const plan = await buildPlan(
      "Compare React Native and Flutter for a startup in 2026",
      "quick",
      llm,
    );
    const missing = (plan.structuredObjectives ?? [])
      .filter((item) =>
        ["architecture", "performance", "ecosystem", "limitations"].includes(item.category),
      )
      .map((item) => ({
        ...item,
        coverage: item.category === "architecture" || item.category === "ecosystem" ? 0.5 : 0,
      }));
    const queries = await rewriteQueries(
      plan.interpretation.normalizedQuestion,
      plan,
      [],
      "quick",
      llm,
      missing,
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("performance");
    expect(queries[0]).not.toContain("limitations");
  });
});
