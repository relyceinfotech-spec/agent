import { describe, expect, it, vi } from "vitest";
import type { ResearchRecoveryRequirements, SearchResult, Source } from "../src/domain.js";
import { OpenRouterProvider } from "../src/llm.js";
import { buildPlan, rewriteQueries, validateRecoveryQuery } from "../src/planner.js";
import { ResearchRunner } from "../src/research.js";
import { MemorySessionStore } from "../src/store.js";
import { ToolRegistry } from "../src/agent/tools.js";

const question = "Who is the CEO of Relyce Infotech?";
const supportedStatement = "Ukenthiran A is the Founder & CEO of Relyce Infotech.";
const supportedContent =
  "The company profile states that Ukenthiran A is the Founder & CEO of Relyce Infotech. This profile identifies the executive role and leads its technology and consulting teams.";
const genericContent =
  "Relyce Infotech provides software engineering, cloud, application development, and technology consulting services to business customers. Its team supports organizations with implementation and technical advisory services.";
const linkedinSearchExcerpt =
  "Startup Fest 2025 at Sathyabama Institute of Science & Technology, Chennai was a resounding success, and Relyce infotech presented its stall. The event provided a platform to showcase its vision and solutions and received encouraging feedback from investors and mentors. The team participated in discussions about its technology and AI solution. Core Team: Ukenthiran A Founder & CEO of Relyce infotech Dharsan L | Tamizharuvi P | GOHULA KANNAN | Naveenkumar Sivarajan.";
const linkedinPredicatePassage =
  "Core Team: Ukenthiran A Founder & CEO of Relyce infotech Dharsan L | Tamizharuvi P | GOHULA KANNAN | Naveenkumar Sivarajan.";

type ControllerChoice = (
  observation: Record<string, unknown>,
  allowedActions: string[],
) => string | undefined | Promise<string | undefined>;

type LookupOptions = {
  initialResults: SearchResult[];
  recoveryResults?: SearchResult[];
  contentByUrl: Map<string, string>;
  chooseAction: ControllerChoice;
  recoveryQueryResponse?: string;
  synthesisAnswer?: string;
  maxModelDecisions?: number;
  maxPages?: number;
  maxClaimsToVerify?: number;
  genericClaimsBeforePredicate?: boolean;
  predicateClaimText?: string;
  siteDiscoverySeedUrl?: string;
  siteDiscoveryCandidate?: SearchResult;
};

async function terminalSession(store: MemorySessionStore, id: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const session = await store.get(id);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(session?.status ?? "")) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Adaptive research fixture did not reach a terminal state");
}

async function runLookup(options: LookupOptions) {
  const searchQueries: string[] = [];
  const recoveryQueries: string[] = [];
  const fetchedUrls: string[] = [];
  const controllerOptions: string[][] = [];
  const synthesisInputs: unknown[] = [];
  const verifiedClaims: string[] = [];
  const siteDiscoveryBudgets: number[] = [];
  const recoveryResults = options.recoveryResults ?? [];

  const plannerModel = new OpenRouterProvider();
  vi.spyOn(plannerModel, "enabled", "get").mockReturnValue(false);
  const plan = await buildPlan(question, "quick", plannerModel);

  const llm = new OpenRouterProvider();
  vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
  vi.spyOn(llm, "complete").mockImplementation(
    async () => options.recoveryQueryResponse ?? JSON.stringify({ query: "Relyce Infotech CEO" }),
  );
  vi.spyOn(llm, "proposeResearchAction").mockImplementation(async (observation, allowed) => {
    controllerOptions.push([...allowed]);
    return options.chooseAction(observation, allowed);
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "web_search",
    description: "Deterministic initial-search fixture",
    execute: async (input) => {
      const queries = (input as { queries?: string[] }).queries ?? [];
      searchQueries.push(...queries);
      return options.initialResults.flatMap((result) =>
        queries.map((query) => ({ ...result, query })),
      );
    },
  });
  registry.register({
    name: "search_again",
    description: "Deterministic recovery-search fixture",
    execute: async (input) => {
      const queries = (input as { queries?: string[] }).queries ?? [];
      recoveryQueries.push(...queries);
      return recoveryResults.flatMap((result) => queries.map((query) => ({ ...result, query })));
    },
  });
  registry.register({
    name: "fetch_url",
    description: "Fixture retrieval; never performs network requests",
    execute: async (input) => {
      const source = input as {
        url: string;
        title: string;
        siteDiscoveryMaxCandidates?: number;
      };
      fetchedUrls.push(source.url);
      siteDiscoveryBudgets.push(source.siteDiscoveryMaxCandidates ?? 0);
      const content = options.contentByUrl.get(source.url) ?? genericContent;
      return {
        url: source.url,
        html: "",
        contentType: "text/html",
        retrievalMethod: "http",
        extractionStatus: "SUCCEEDED",
        extractionConfidence: 0.95,
        retrievedContentLength: content.length,
        document: {
          title: source.title,
          domain: new URL(source.url).hostname,
          content,
          headings: [],
          contentType: "article",
        },
        siteDiscoveryCandidates:
          source.url === options.siteDiscoverySeedUrl &&
          (source.siteDiscoveryMaxCandidates ?? 0) > 0 &&
          options.siteDiscoveryCandidate
            ? [options.siteDiscoveryCandidate]
            : [],
      };
    },
  });
  registry.register({
    name: "extract_content",
    description: "Return the deterministic fetched document",
    execute: async (input) => (input as { document: unknown }).document,
  });
  registry.register({
    name: "extract_claims",
    description: "Extract only the fixture's explicit entity-and-predicate statement",
    execute: async (input) => {
      const sources = (input as { sources: Source[] }).sources;
      const predicateClaimText = options.predicateClaimText ?? supportedStatement;
      return sources
        .filter((source) => source.content?.includes(predicateClaimText))
        .flatMap((source) => [
          ...(options.genericClaimsBeforePredicate
            ? [
                {
                  id: `generic-${source.id}`,
                  text: "Relyce Infotech participated in a startup event and presented its work.",
                  evidence: source.content ?? "",
                  sourceIds: [source.id],
                  confidence: 0.98,
                },
              ]
            : []),
          {
            id: `ceo-${source.id}`,
            text: predicateClaimText,
            evidence: predicateClaimText,
            sourceIds: [source.id],
            confidence: 0.98,
          },
        ]);
    },
  });
  registry.register({
    name: "gather_evidence",
    description: "Pass extracted claims through the deterministic fixture",
    execute: async (input) => (input as { claims: unknown[] }).claims,
  });
  registry.register({
    name: "verify_claim",
    description: "Verify a claim only when its statement is present in the source",
    execute: async (input) => {
      const claim = (input as { claim: string }).claim;
      verifiedClaims.push(claim);
      return claim === (options.predicateClaimText ?? supportedStatement)
        ? { claim, verdict: "supported", rationale: "Exact fixture statement matched." }
        : { claim, verdict: "uncertain", rationale: "The fixture has no matching statement." };
    },
  });
  registry.register({
    name: "verify_claims_batch",
    description: "Deterministic batched fixture verification",
    execute: async (input) =>
      ((input as { claims: Array<{ id: string }> }).claims ?? []).map(({ id }) => ({
        id,
        verdict: "supported",
      })),
  });
  registry.register({
    name: "detect_conflict",
    description: "The deterministic fixture contains no conflicts",
    execute: async () => [],
  });
  registry.register({
    name: "synthesize",
    description: "Return the configured synthesis fixture",
    execute: async (input) => {
      synthesisInputs.push(input);
      return options.synthesisAnswer ?? `${supportedStatement} [1]`;
    },
  });

  const store = new MemorySessionStore();
  const runner = new ResearchRunner(
    store,
    { search: async () => [] },
    llm,
    registry,
    {
      maxSteps: 16,
      maxQueries: 2,
      maxSources: 4,
      maxPages: options.maxPages ?? 2,
      maxSearchPasses: 1,
      maxClaimsToVerify: options.maxClaimsToVerify ?? 2,
      maxTimeMs: 8_000,
      maxModelDecisions: options.maxModelDecisions ?? 4,
    },
    undefined,
    true,
  );
  const started = await runner.start(question, "quick", [], {
    researchChatOptimization: true,
    interpretation: plan.interpretation,
  });
  const session = await terminalSession(store, started.id);
  return {
    session,
    searchQueries,
    recoveryQueries,
    fetchedUrls,
    controllerOptions,
    synthesisInputs,
    verifiedClaims,
    siteDiscoveryBudgets,
    llm,
  };
}

describe("bounded LLM-guided research controller", () => {
  it("verifies a late explicit fact from a long LinkedIn result before its generic claim", async () => {
    const linkedin: SearchResult = {
      title: "Relyce infotech | LinkedIn",
      url: "https://www.linkedin.com/company/relyce-infotech",
      snippet: linkedinSearchExcerpt,
    };
    const run = await runLookup({
      initialResults: [linkedin],
      contentByUrl: new Map([[linkedin.url, linkedinSearchExcerpt]]),
      maxPages: 1,
      maxClaimsToVerify: 1,
      genericClaimsBeforePredicate: true,
      predicateClaimText: linkedinPredicatePassage,
      synthesisAnswer: "Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]",
      chooseAction: (_observation, allowed) =>
        allowed.find((action) => action.startsWith("fetch_url:")) ?? allowed[0],
    });

    expect(run.fetchedUrls).toEqual([linkedin.url]);
    expect(run.verifiedClaims).toEqual([linkedinPredicatePassage]);
    expect(run.session?.status, run.session?.error).toBe("COMPLETED");
    expect(run.session?.answer).toBe("Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]");
    expect(run.session?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: true,
    });
  });

  it("opens a relevant same-site page discovered from an entity-matched company domain", async () => {
    const root: SearchResult = {
      title: "Relyce Infotech | Technology consulting",
      url: "https://relyceinfotech.com/en",
      snippet: "Relyce Infotech provides software and technology consulting services.",
    };
    const leadership: SearchResult = {
      title: "Relyce Infotech — Leadership team",
      url: "https://relyceinfotech.com/company/leadership",
      snippet: "Relyce Infotech leadership page; navigation label: Leadership team.",
      provider: "site-discovery",
      siteDiscoveryOrigin: "https://relyceinfotech.com",
      query: "same-origin site discovery",
    };
    const run = await runLookup({
      initialResults: [root],
      siteDiscoverySeedUrl: root.url,
      siteDiscoveryCandidate: leadership,
      contentByUrl: new Map([[leadership.url, supportedContent]]),
      maxPages: 3,
      synthesisAnswer: "Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]",
      chooseAction: (observation, allowed) => {
        const candidates = (observation.candidateSources ?? []) as Array<{
          sourceId: string;
          title: string;
        }>;
        const internalPage = candidates.find((candidate) => /leadership/i.test(candidate.title));
        if (internalPage) return `fetch_url:${internalPage.sourceId}`;
        if (allowed.includes("synthesize")) return "synthesize";
        return allowed[0];
      },
    });

    expect(
      run.fetchedUrls,
      JSON.stringify({
        budgets: run.siteDiscoveryBudgets,
        decisions: run.session?.sourceSelectionDecisions?.map((decision) => ({
          title: decision.title,
          url: decision.url,
          selected: decision.selected,
          reason: decision.reason,
        })),
      }),
    ).toEqual([root.url, leadership.url]);
    expect(run.session?.status, run.session?.error).toBe("COMPLETED");
    expect(run.session?.sources.find((source) => source.url === leadership.url)?.content).toContain(
      "Founder & CEO",
    );
    expect(run.session?.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: supportedStatement,
          verification: expect.objectContaining({ verdict: "supported" }),
        }),
      ]),
    );
    expect(run.session?.answer).toContain("Ukenthiran A");
    expect(run.session?.state?.requestedFactCoverage?.requestedPredicate?.present).toBe(true);
  });

  it("does not complete from a discovered internal page without the requested fact", async () => {
    const root: SearchResult = {
      title: "Relyce Infotech | Technology consulting",
      url: "https://relyceinfotech.com/en",
      snippet: "Relyce Infotech provides software and technology consulting services.",
    };
    const leadership: SearchResult = {
      title: "Relyce Infotech — Leadership team",
      url: "https://relyceinfotech.com/company/leadership",
      snippet: "Relyce Infotech leadership page.",
      provider: "site-discovery",
      siteDiscoveryOrigin: "https://relyceinfotech.com",
    };
    const run = await runLookup({
      initialResults: [root],
      siteDiscoverySeedUrl: root.url,
      siteDiscoveryCandidate: leadership,
      contentByUrl: new Map([[leadership.url, genericContent]]),
      maxPages: 3,
      chooseAction: (observation, allowed) => {
        const candidates = (observation.candidateSources ?? []) as Array<{
          sourceId: string;
          title: string;
        }>;
        const internalPage = candidates.find((candidate) => /leadership/i.test(candidate.title));
        if (internalPage) return `fetch_url:${internalPage.sourceId}`;
        return allowed.includes("synthesize") ? "synthesize" : allowed[0];
      },
    });

    expect(
      run.fetchedUrls,
      JSON.stringify({
        budgets: run.siteDiscoveryBudgets,
        decisions: run.session?.sourceSelectionDecisions?.map((decision) => ({
          title: decision.title,
          url: decision.url,
          selected: decision.selected,
          reason: decision.reason,
        })),
      }),
    ).toEqual([root.url, leadership.url]);
    expect(run.session?.status).not.toBe("COMPLETED");
    expect(run.session?.claims.some((claim) => claim.verification?.verdict === "supported")).toBe(
      false,
    );
    expect(run.session?.state?.requestedFactCoverage?.requestedPredicate?.present).toBe(false);
    expect(run.session?.answer).not.toMatch(/ITC Infotech|CEO is/i);
  });

  it("does not exceed a one-page research budget to explore a same-site candidate", async () => {
    const root: SearchResult = {
      title: "Relyce Infotech | Technology consulting",
      url: "https://relyceinfotech.com/en",
      snippet: "Relyce Infotech provides software and technology consulting services.",
    };
    const leadership: SearchResult = {
      title: "Relyce Infotech — Leadership team",
      url: "https://relyceinfotech.com/company/leadership",
      snippet: "Relyce Infotech leadership page.",
      provider: "site-discovery",
      siteDiscoveryOrigin: "https://relyceinfotech.com",
    };
    const run = await runLookup({
      initialResults: [root],
      siteDiscoverySeedUrl: root.url,
      siteDiscoveryCandidate: leadership,
      contentByUrl: new Map([[leadership.url, supportedContent]]),
      maxPages: 1,
      chooseAction: (_observation, allowed) =>
        allowed.find((action) => action.startsWith("fetch_url:")) ?? allowed[0],
    });

    expect(run.fetchedUrls).toEqual([root.url]);
    expect(run.siteDiscoveryBudgets).toEqual([0]);
    expect(run.session?.status).not.toBe("COMPLETED");
  });

  it("rejects a recovery query that drops the requested entity and predicate", async () => {
    const plannerModel = new OpenRouterProvider();
    vi.spyOn(plannerModel, "enabled", "get").mockReturnValue(false);
    const plan = await buildPlan(question, "quick", plannerModel);
    const requirement = plan.interpretation.requestedPredicate!;
    const recoveryRequirements: ResearchRecoveryRequirements = {
      requestedPredicate: { requirement, resolved: false },
      requestedFacts: [],
      resolvedFacts: [],
      unresolvedFacts: [],
      latestnessRequired: false,
      latestnessResolved: false,
      qualifiers: { latest: false, stable: false },
      officialSourceRequirement: "none",
      officialEvidenceResolved: false,
    };
    const controller = new OpenRouterProvider();
    vi.spyOn(controller, "enabled", "get").mockReturnValue(true);
    vi.spyOn(controller, "complete").mockResolvedValue(
      JSON.stringify({ query: "who leads the company" }),
    );

    const [query] = await rewriteQueries(
      question,
      plan,
      [],
      "quick",
      controller,
      undefined,
      recoveryRequirements,
    );

    expect(controller.complete).toHaveBeenCalledTimes(1);
    expect(query).toBeDefined();
    expect(query).toMatch(/Relyce Infotech/i);
    expect(query).toMatch(/CEO|chief executive officer/i);
    expect(query).not.toMatch(/who leads the company/i);
    expect(validateRecoveryQuery(query!, question, plan, recoveryRequirements).accepted).toBe(true);
  });

  it("lets the controller recover with a new query, select the returned source, and complete from its evidence", async () => {
    const firstParty: SearchResult[] = [
      {
        title: "Relyce Infotech services",
        url: "https://relyceinfotech.com/services",
        snippet: "Relyce Infotech provides technology and consulting services.",
      },
      {
        title: "Relyce Infotech company overview",
        url: "https://relyceinfotech.com/en",
        snippet: "Company profile and technology services from Relyce Infotech.",
      },
    ];
    const recovered: SearchResult = {
      title: "Relyce Infotech leadership interview",
      url: "https://company-news.example/relyce-leadership",
      snippet: supportedStatement,
    };
    let requestedRecovery = false;
    const run = await runLookup({
      initialResults: firstParty,
      recoveryResults: [recovered],
      contentByUrl: new Map([[recovered.url, supportedContent]]),
      recoveryQueryResponse: JSON.stringify({
        sourceClass: "independent_reporting",
        query: '"Relyce Infotech" CEO leadership interview',
      }),
      maxPages: 1,
      chooseAction: (observation, allowed) => {
        if (!requestedRecovery && allowed.includes("search_again")) {
          requestedRecovery = true;
          return "search_again";
        }
        const candidates = (observation.candidateSources ?? []) as Array<{
          sourceId: string;
          domain: string;
          title: string;
        }>;
        const leadershipInterview = candidates.find((candidate) =>
          /leadership interview/i.test(candidate.title),
        );
        if (leadershipInterview) return `fetch_url:${leadershipInterview.sourceId}`;
        if (allowed.includes("synthesize")) return "synthesize";
        return allowed[0];
      },
    });

    expect(run.session?.status, run.session?.error).toBe("COMPLETED");
    expect(run.searchQueries).toHaveLength(1);
    expect(run.recoveryQueries).toHaveLength(1);
    expect(run.recoveryQueries[0]).toMatch(/Relyce Infotech.*CEO/i);
    expect(run.recoveryQueries[0]).toMatch(/news interview independent reporting/i);
    expect(run.session?.searchRecoveries?.[0]?.queries).toEqual(run.recoveryQueries);
    expect(run.session?.searchRecoveries?.[0]?.sourceClass).toBe("independent_reporting");
    expect(run.fetchedUrls).toEqual([recovered.url]);
    expect(
      run.session?.sources.some((source) => source.url === recovered.url && source.content),
    ).toBe(true);
    expect(
      run.session?.claims.some(
        (claim) => claim.text === supportedStatement && claim.verification?.verdict === "supported",
      ),
    ).toBe(true);
    expect(run.session?.answer).toContain("Ukenthiran A");
    expect(run.session?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: true,
    });
    expect(run.synthesisInputs).toHaveLength(1);
    expect(JSON.stringify(run.synthesisInputs)).toContain(recovered.url);
    expect(run.controllerOptions[0]).toContain("search_again");
    expect(
      run.controllerOptions.some((allowed) =>
        allowed.some((item) => item.startsWith("fetch_url:")),
      ),
    ).toBe(true);
  });

  it("lets the controller select one promising source by its allowed ID instead of fetching the whole candidate batch", async () => {
    const generic: SearchResult = {
      title: "Relyce Infotech services",
      url: "https://relyceinfotech.com/services",
      snippet: "Relyce Infotech provides technology and consulting services.",
    };
    const exact: SearchResult = {
      title: "Relyce Infotech leadership profile",
      url: "https://www.linkedin.com/company/relyce-infotech",
      snippet: supportedStatement,
    };
    const run = await runLookup({
      initialResults: [generic, exact],
      contentByUrl: new Map([[exact.url, supportedContent]]),
      maxPages: 1,
      chooseAction: (observation, allowed) => {
        const candidates = (observation.candidateSources ?? []) as Array<{
          sourceId: string;
          domain: string;
        }>;
        const preferred = candidates.find((candidate) => /linkedin\.com$/i.test(candidate.domain));
        if (preferred) return `fetch_url:${preferred.sourceId}`;
        if (allowed.includes("synthesize")) return "synthesize";
        return allowed[0];
      },
    });
    const selected = run.session?.sources.find((source) => source.url === exact.url);

    expect(run.session?.status, run.session?.error).toBe("COMPLETED");
    expect(run.searchQueries).toHaveLength(1);
    expect(run.recoveryQueries).toEqual([]);
    expect(run.fetchedUrls).toEqual([exact.url]);
    expect(run.controllerOptions[0]).toContain("search_again");
    expect(run.controllerOptions[0]).toContain(`fetch_url:${selected?.id}`);
    expect(run.session?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedAction: `fetch_url:${selected?.id}`,
          controllerDecision: "allow",
          nextAction: "fetch_url",
        }),
      ]),
    );
  });

  it("rejects an invented URL token and falls back to a source ID from the allowed set", async () => {
    const source: SearchResult = {
      title: "Relyce Infotech leadership profile",
      url: "https://relyceinfotech.com/en/leadership",
      snippet: supportedStatement,
    };
    const run = await runLookup({
      initialResults: [source],
      contentByUrl: new Map([[source.url, supportedContent]]),
      maxPages: 1,
      chooseAction: () => "fetch_url:https://attacker.invalid/private",
    });

    expect(run.session?.status, run.session?.error).toBe("COMPLETED");
    expect(run.fetchedUrls).toEqual([source.url]);
    expect(run.fetchedUrls).not.toContain("https://attacker.invalid/private");
    expect(run.session?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedAction: "fetch_url:https://attacker.invalid/private",
          controllerDecision: "override",
          nextAction: "fetch_url",
        }),
      ]),
    );
  });

  it("counts a failed controller request against its decision budget and records only a safe failure category", async () => {
    const sources: SearchResult[] = [
      {
        title: "Relyce Infotech services",
        url: "https://relyceinfotech.com/services",
        snippet: "Relyce Infotech provides application development and technology consulting.",
      },
      {
        title: "Relyce Infotech overview",
        url: "https://profiles.example/relyce-infotech",
        snippet: "Relyce Infotech is a software consulting company.",
      },
    ];
    const run = await runLookup({
      initialResults: sources,
      contentByUrl: new Map(),
      maxModelDecisions: 1,
      chooseAction: () => {
        const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        throw error;
      },
    });

    expect(run.llm.proposeResearchAction).toHaveBeenCalledTimes(1);
    expect(run.session?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          controllerDecision: "fallback",
          reason: expect.stringContaining("network_error"),
        }),
      ]),
    );
    expect(run.session?.status).toBe("FAILED");
    expect(run.session?.answer).toMatch(/insufficient evidence/i);
    expect(JSON.stringify(run.session?.decisions)).not.toContain("ECONNRESET");
    expect(JSON.stringify(run.session?.decisions)).not.toContain("fetch failed");
  });

  it("cannot turn generic company pages into a completed CEO answer when the model requests synthesis early", async () => {
    const sources: SearchResult[] = [
      {
        title: "Relyce Infotech services",
        url: "https://relyceinfotech.com/services",
        snippet: "Relyce Infotech provides technology consulting services.",
      },
      {
        title: "Relyce Infotech overview",
        url: "https://profiles.example/relyce-infotech",
        snippet: "Relyce Infotech is a software consulting company.",
      },
    ];
    const run = await runLookup({
      initialResults: sources,
      recoveryResults: [],
      contentByUrl: new Map(),
      synthesisAnswer: "Jane Doe is the CEO of Relyce Infotech. [1]",
      chooseAction: () => "synthesize",
    });

    expect(run.controllerOptions.length).toBeGreaterThan(0);
    expect(run.controllerOptions[0]).not.toContain("synthesize");
    expect(run.fetchedUrls.every((url) => sources.some((source) => source.url === url))).toBe(true);
    expect(run.session?.status).toBe("FAILED");
    expect(run.session?.error).toMatch(/INSUFFICIENT_EVIDENCE|CITATION_VALIDATION_FAILED/);
    expect(run.session?.answer).not.toContain("Jane Doe");
    expect(run.session?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
      predicate: "CEO",
      present: false,
    });
  });
});
