import { describe, expect, it, vi } from "vitest";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import {
  createToolRegistry,
  ToolRegistry,
  NORMAL_CHAT_VERIFICATION_COMPLETION_TOKENS,
} from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import {
  buildPlan,
  planFastLookupQuery,
  rewriteQueries,
  understandQuery,
  validateRecoveryQuery,
} from "../src/planner.js";
import {
  comparisonClaimMismatchReason,
  querySubjectMismatchReason,
  relevantSourceContent,
} from "../src/query-relevance.js";
import { rankResults } from "../src/rank.js";
import { ResearchRunner } from "../src/research.js";
import { InternalKnowledgeProvider } from "../src/search.js";
import { assessSerperSnippet } from "../src/source-retrieval.js";
import { SqliteSessionStore } from "../src/store.js";
import type { Claim, Source } from "../src/domain.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { QuotaPolicy } from "../src/quota-policy.js";

function offline() {
  const llm = new OpenRouterProvider();
  vi.spyOn(llm, "enabled", "get").mockReturnValue(false);
  return llm;
}

describe("normal Chat integrity", () => {
  it.each([
    "This article breaks down how HNSW and IVF families compare and which parameters drive vector indexing latency and recall.",
    "How Data Preparation Shapes Index Performance Retrieval quality starts upstream of vector indexing.",
    "It also shows how Unstructured helps you produce clean JSON chunks so your vector database keeps performance predictable.",
  ])("rejects generic page descriptions as comparison claims: %s", (text) => {
    expect(
      comparisonClaimMismatchReason(
        "Compare current HNSW and IVF vector indexing performance",
        text,
      ),
    ).toBeDefined();
  });

  it("extracts concrete target findings rather than descriptive metadata for a comparison", async () => {
    const question = "Compare current HNSW and IVF vector indexing performance";
    const metadata =
      "This article breaks down how HNSW and IVF families compare and which parameters drive vector indexing latency and recall.";
    const hnsw =
      "HNSW vector indexing uses a graph to reduce search latency while requiring more memory for stored neighbor connections.";
    const ivf =
      "IVF vector indexing uses clustered partitions to reduce memory usage while probing more partitions improves search recall.";
    const source = {
      ...rankResults(question, [
        {
          title: "HNSW and IVF vector indexing performance",
          url: "https://vector.example.org/findings",
          snippet: metadata,
        },
      ])[0],
      content: `${metadata}\n${hnsw}\n${ivf}`,
    } as Source;
    const registry = createToolRegistry({ search: async () => [] }, offline());
    const claims = (await registry.execute("extract_claims", {
      question,
      sources: [source],
      researchChatOptimization: true,
    })) as Claim[];
    expect(claims.map((claim) => claim.text)).toEqual([hnsw, ivf]);
    expect(comparisonClaimMismatchReason(question, hnsw)).toBeUndefined();
    expect(comparisonClaimMismatchReason(question, ivf)).toBeUndefined();
  });

  it.each([false, true])(
    "uses a bounded normal Chat verifier allowance and preserves truncation failure (%s)",
    async (truncated) => {
      const llm = offline();
      vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
      const complete = vi
        .spyOn(llm, "complete")
        .mockImplementation(async (_system, _user, options) => {
          expect(options?.maxCompletionTokens).toBe(NORMAL_CHAT_VERIFICATION_COMPLETION_TOKENS);
          expect(options?.responseFormat).toEqual({ type: "json_object" });
          if (truncated) throw new Error("OpenRouter completion exceeded the output-token budget");
          return JSON.stringify({ verifications: [{ id: "claim", verdict: "supported" }] });
        });
      const registry = createToolRegistry({ search: async () => [] }, llm);
      const result = await registry.execute("verify_claim", {
        claim: "HNSW uses a graph.",
        evidence: "HNSW uses a graph.",
        researchChatOptimization: true,
      });
      expect(result).toMatchObject({ verdict: truncated ? "unavailable" : "supported" });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(NORMAL_CHAT_VERIFICATION_COMPLETION_TOKENS).toBeLessThanOrEqual(8192);
    },
  );

  it.each([false, true])(
    "completes a comparison only with actual target findings (%s)",
    async (includeFindings) => {
      const llm = offline();
      const store = new SqliteSessionStore(":memory:");
      const question = "Compare current HNSW and IVF vector indexing performance";
      const metadata =
        "This article breaks down how HNSW and IVF families compare and which parameters drive vector indexing latency and recall.";
      const findings =
        "HNSW vector indexing uses a graph to reduce search latency while requiring more memory for stored neighbor connections. IVF vector indexing uses clustered partitions to reduce memory usage while probing more partitions improves search recall.";
      const search = {
        search: async () => [
          {
            title: "HNSW and IVF vector indexing performance",
            url: "https://vector.example.org/findings",
            snippet: metadata,
          },
        ],
      };
      const registry = createToolRegistry(search, llm, store);
      registry.register({
        name: "fetch_url",
        description: "offline",
        execute: async () => ({ html: "offline" }),
      });
      registry.register({
        name: "extract_content",
        description: "offline",
        execute: async () => ({
          title: "HNSW and IVF vector indexing performance",
          content: metadata + (includeFindings ? `\n${findings}` : ""),
        }),
      });
      const verify = vi.fn(async (input: unknown) => {
        expect(input).toMatchObject({ researchChatOptimization: true });
        expect((input as { claim: string }).claim).not.toContain("article breaks down");
        return { verdict: "supported" };
      });
      registry.register({ name: "verify_claim", description: "offline", execute: verify });
      const synthesize = vi.fn(async (input: unknown) =>
        (input as { claims: Claim[] }).claims.map((claim) => `${claim.text} [1].`).join("\n\n"),
      );
      registry.register({ name: "synthesize", description: "offline", execute: synthesize });
      const runner = new ResearchRunner(
        store,
        search,
        llm,
        registry,
        {
          maxQueries: 1,
          maxSources: 1,
          maxPages: 1,
          maxSteps: 14,
          maxSearchPasses: 0,
          maxModelDecisions: 0,
          maxTimeMs: 4000,
        },
        undefined,
        true,
      );
      try {
        await runner.runQueued(`comparison-${includeFindings}`, question, "quick", [], {
          researchChatOptimization: true,
          allowSnippetEvidence: false,
        });
        const session = (await store.get(`comparison-${includeFindings}`))!;
        expect(session.status).toBe(includeFindings ? "COMPLETED" : "FAILED");
        expect(session.claims).toHaveLength(includeFindings ? 2 : 0);
        expect(verify).toHaveBeenCalledTimes(includeFindings ? 2 : 0);
        expect(synthesize).toHaveBeenCalledTimes(includeFindings ? 1 : 0);
      } finally {
        store.close();
      }
    },
  );

  it("preserves an uncatalogued comparison target in discovery and recovery", async () => {
    const llm = offline();
    const question = "Compare the current pricing of Supabase and Acme";
    const plan = await buildPlan(question, "quick", llm);
    expect(plan.queries[0]).toContain("Supabase");
    expect(plan.queries[0]).toContain("Acme");
    const recovery = await rewriteQueries(
      question,
      plan,
      [],
      "quick",
      llm,
      plan.structuredObjectives?.slice(0, 1),
    );
    expect(recovery[0]).toContain("Acme");
    expect(
      querySubjectMismatchReason(question, "Acme pricing starts at $10 per month"),
    ).toBeUndefined();
    expect(
      querySubjectMismatchReason(question, "Unrelated pricing starts at $10 per month"),
    ).toBeDefined();
  });

  it.each([false, true])(
    "requires price evidence for both comparison targets before completion (second target present: %s)",
    async (includeSecondTarget) => {
      const llm = offline();
      const store = new SqliteSessionStore(":memory:");
      const question = "Compare the current pricing of Supabase and Firebase";
      const first =
        "Supabase has a free plan for individual developers with a published price of zero dollars per month. Supabase paid plan pricing starts at $25 per month for the documented base project tier.";
      const second = includeSecondTarget
        ? "Firebase has a free plan for individual developers with a published price of zero dollars per month. Firebase usage pricing is billed at $10 per month for this explicitly bounded offline workload."
        : first;
      const results = [
        { title: "Supabase pricing", url: "https://supabase.com/pricing", snippet: first },
        {
          title: includeSecondTarget ? "Firebase pricing" : "Independent Supabase pricing",
          url: "https://engineering.example.org/pricing",
          snippet: second,
        },
      ];
      const search = { search: async () => results };
      const tools = createToolRegistry(search, llm, store);
      tools.register({
        name: "fetch_url",
        description: "offline",
        execute: async (input) => ({ html: "offline", url: (input as { url: string }).url }),
      });
      tools.register({
        name: "extract_content",
        description: "offline",
        execute: async (input) => {
          const index = results.findIndex(
            (source) => source.url === (input as { url: string }).url,
          );
          return { title: results[index].title, content: index === 0 ? first : second };
        },
      });
      tools.register({
        name: "verify_claim",
        description: "offline",
        execute: async () => ({ verdict: "supported" }),
      });
      tools.register({
        name: "synthesize",
        description: "offline",
        execute: async (input) => {
          const payload = input as { claims: Claim[]; sources: Source[] };
          return payload.claims
            .map(
              (claim) =>
                `${claim.text} [${payload.sources.findIndex((source) => claim.sourceIds.includes(source.id)) + 1}].`,
            )
            .join("\n\n");
        },
      });
      const runner = new ResearchRunner(
        store,
        search,
        llm,
        tools,
        {
          maxQueries: 1,
          maxPages: 2,
          maxSources: 2,
          maxSteps: 18,
          maxSearchPasses: 0,
          maxModelDecisions: 0,
          maxTimeMs: 3000,
        },
        undefined,
        true,
      );
      try {
        await runner.runQueued("pricing-comparison", question, "quick", [], {
          researchChatOptimization: true,
          allowSnippetEvidence: false,
        });
        const session = (await store.get("pricing-comparison"))!;
        expect(session.claims.some((claim) => claim.verification?.verdict === "supported")).toBe(
          true,
        );
        expect(session.status).toBe(includeSecondTarget ? "COMPLETED" : "FAILED");
        expect(session.state?.requestedFactCoverage?.missing.includes("price")).toBe(
          !includeSecondTarget,
        );
      } finally {
        store.close();
      }
    },
  );
  it.each([
    ["What is a closure in JavaScript?", "FAILED", false],
    ["What does it mean?", "NEEDS_CLARIFICATION", false],
    ["What is the current Node.js LTS version?", "FAILED", true],
  ])(
    "preserves one interpretation and truthful outcome through HTTP and the durable worker: %s",
    async (question, status, expectSearch) => {
      const llm = offline();
      const complete = vi.spyOn(llm, "complete");
      const store = new SqliteSessionStore(":memory:");
      const search = { search: vi.fn(async (_query: string) => []) };
      const tools = createToolRegistry(search, llm, store);
      const execute = vi.spyOn(tools, "execute");
      const app = await createServer({
        store,
        jobStore: new InMemoryDurableJobStore(),
        searchProvider: search,
        llmProvider: llm,
        toolRegistry: tools,
        authVerifier: { verifyAccessToken: async () => ({ id: "offline-user" }) },
        memoryService: {
          enabled: false,
          retrieveForQuestion: async () => ({ needed: false, memories: [] }),
        } as never,
        quotaPolicy: new QuotaPolicy(
          JSON.stringify({
            default: {
              quotas: {
                research: { limit: 10, windowSeconds: 3600 },
                deep_research: { limit: 10, windowSeconds: 3600 },
                followup: { limit: 10, windowSeconds: 3600 },
              },
              features: { research: true, deepResearch: true, postFollowUps: true },
            },
          }),
        ),
        researchBudget: {
          maxSteps: 12,
          maxQueries: 1,
          maxPages: 1,
          maxSources: 1,
          maxSearchPasses: 0,
          maxModelDecisions: 0,
          maxTimeMs: 3000,
        },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/chat",
          headers: { authorization: "Bearer offline-token" },
          payload: { message: question, deepResearch: false },
        });
        expect([200, 202]).toContain(response.statusCode);
        const queued = response.json<{ jobId: string; researchId: string }>();
        await getServerBackgroundServices(app).worker.runNow(queued.jobId);
        const session = await store.get(queued.researchId);
        expect(session?.status).toBe(status);
        expect(execute.mock.calls.filter(([name]) => name === "understand_query")).toHaveLength(1);
        expect(complete).not.toHaveBeenCalled();
        expect(search.search.mock.calls.length > 0).toBe(expectSearch);
        if (expectSearch) expect(search.search.mock.calls[0][0]).toMatch(/Node\.js.*LTS/i);
      } finally {
        await app.close();
      }
    },
  );
  it.each(["", "Insufficient evidence to provide a verified answer."])(
    "does not complete an empty or unavailable synthesis result: %s",
    async (answer) => {
      const llm = offline();
      const store = new SqliteSessionStore(":memory:");
      const content =
        "Vector indexing architecture uses graphs for efficient approximate search across large datasets and measured benchmark workloads. Vector indexing benchmarks measure recall and query latency with explicit limitations.";
      const search = {
        search: async () => [
          {
            title: "Vector indexing benchmark",
            url: "https://vector.example.org/report",
            snippet: content,
          },
        ],
      };
      const tools = createToolRegistry(search, llm, store);
      tools.register({
        name: "fetch_url",
        description: "offline",
        execute: async () => ({ html: "offline", url: "https://vector.example.org/report" }),
      });
      tools.register({
        name: "extract_content",
        description: "offline",
        execute: async () => ({ title: "Vector indexing benchmark", content }),
      });
      tools.register({
        name: "verify_claims_batch",
        description: "offline",
        execute: async (input) =>
          (input as { claims: Claim[] }).claims.map((claim) => ({
            id: claim.id,
            verdict: "supported",
          })),
      });
      tools.register({ name: "synthesize", description: "offline", execute: async () => answer });
      const runner = new ResearchRunner(store, search, llm, tools, {
        maxQueries: 1,
        maxPages: 1,
        maxSources: 1,
        maxSteps: 12,
        maxSearchPasses: 0,
        maxModelDecisions: 0,
        maxTimeMs: 3000,
      });
      try {
        await runner.runQueued(
          "unusable-synthesis",
          "Explain vector indexing performance",
          "quick",
          [],
          { allowSnippetEvidence: false },
        );
        const session = (await store.get("unusable-synthesis"))!;
        expect(
          session.claims.filter((claim) => claim.verification?.verdict === "supported").length,
        ).toBeGreaterThanOrEqual(2);
        expect(session.status).toBe("FAILED");
        expect(session.error).toMatch(/RESEARCH_INCOMPLETE|CITATION_VALIDATION/);
      } finally {
        store.close();
      }
    },
  );
  it.each(["timeout", "401", "malformed JSON", "429", "unavailable"])(
    "keeps a previous supported run out of a failed single-verifier operation: %s",
    async (failure) => {
      const llm = offline();
      const store = new SqliteSessionStore(":memory:");
      const content =
        "Vector indexing architecture uses graphs for efficient approximate search across large datasets and measured benchmark workloads. Vector indexing benchmarks measure recall and query latency with explicit limitations.";
      const search = {
        search: async () => [
          { title: "Vector indexing", url: "https://vector.example.org/report", snippet: content },
        ],
      };
      const defaults = createToolRegistry(search, llm, store);
      const tools = new ToolRegistry();
      for (const tool of defaults.list().filter((tool) => tool.name !== "verify_claims_batch"))
        tools.register({ ...tool, execute: (input) => defaults.execute(tool.name, input) });
      tools.register({
        name: "fetch_url",
        description: "offline",
        execute: async () => ({ html: "offline", url: "https://vector.example.org/report" }),
      });
      tools.register({
        name: "extract_content",
        description: "offline",
        execute: async () => ({ title: "Vector indexing", content }),
      });
      let fail = false;
      tools.register({
        name: "verify_claim",
        description: "offline single verifier",
        execute: async () => {
          if (fail) throw new Error(failure === "429" ? "OpenRouter returned 429" : failure);
          return { verdict: "supported" };
        },
      });
      const synthesize = vi.fn(async (input) =>
        (input as { claims: Claim[] }).claims.map((claim) => `${claim.text} [1].`).join("\n\n"),
      );
      tools.register({ name: "synthesize", description: "offline", execute: synthesize });
      const runner = new ResearchRunner(store, search, llm, tools, {
        maxQueries: 1,
        maxPages: 1,
        maxSources: 1,
        maxSteps: 12,
        maxSearchPasses: 0,
        maxModelDecisions: 0,
        maxTimeMs: 3000,
      });
      try {
        await runner.runQueued(
          "supported-first",
          "Explain vector indexing performance",
          "quick",
          [],
          { allowSnippetEvidence: false },
        );
        expect((await store.get("supported-first"))?.status).toBe("COMPLETED");
        synthesize.mockClear();
        fail = true;
        await runner.runQueued("failed-next", "Explain vector indexing performance", "quick", [], {
          allowSnippetEvidence: false,
        });
        const session = (await store.get("failed-next"))!;
        expect(session.claims.length).toBeGreaterThan(0);
        expect(
          session.claims.every(
            (claim) =>
              claim.provenance?.sessionId === "failed-next" &&
              claim.verification?.verdict === "unavailable",
          ),
        ).toBe(true);
        expect(session.status).toBe("FAILED");
        expect(synthesize).not.toHaveBeenCalled();
        expect(
          (await store.get("supported-first"))?.claims.every(
            (claim) => claim.verification?.verdict === "supported",
          ),
        ).toBe(true);
      } finally {
        store.close();
      }
    },
  );
  it.each([
    ["What is a closure in JavaScript?", "direct"],
    ["What is a version control system?", "direct"],
    ["Explain the difference between JavaScript let and const", "direct"],
    ["Compare a JavaScript closure with a Python closure", "direct"],
    ["Compare HNSW and IVF vector indexing strategies.", "direct"],
    ["Compare React and Vue conceptually.", "direct"],
    ["Compare the current performance of HNSW and IVF.", "web"],
    ["Compare recent measured HNSW and IVF benchmark results.", "web"],
    ["Compare React and Vue releases from 2020 using official sources.", "web"],
    ["Compare REST and GraphQL and cite sources.", "web"],
    ["What is the latest stable React version?", "web"],
    ["What is the current Node.js LTS version?", "web"],
    ["Compare the current pricing of X and Y.", "web"],
  ])("routes %s to %s without provider calls during preview", async (question, route) => {
    const llm = offline();
    const complete = vi.spyOn(llm, "complete");
    const search = { search: vi.fn(async () => []) };
    const agent = new AutonomousAgent(createToolRegistry(search, llm), {} as never, llm);
    expect((await agent.preview(question, false)).decision.route).toBe(route);
    expect(search.search).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("clarifies an unspecified reference without interpretation transport, search or research", async () => {
    const llm = offline();
    const complete = vi.spyOn(llm, "complete");
    const search = { search: vi.fn(async () => []) };
    const runner = { start: vi.fn() };
    const store = new SqliteSessionStore(":memory:");
    try {
      const response = await new AutonomousAgent(
        createToolRegistry(search, llm),
        runner as never,
        llm,
        store,
      ).handle("What does it mean?", false);
      expect(response.session?.status).toBe("NEEDS_CLARIFICATION");
      expect(response.interpretation.needsClarification).toBe(true);
      expect(complete).not.toHaveBeenCalled();
      expect(search.search).not.toHaveBeenCalled();
      expect(runner.start).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("answers a stable request directly without Serper and uses Deep only when requested", async () => {
    const llm = offline();
    const search = { search: vi.fn(async () => []) };
    const tools = createToolRegistry(search, llm);
    tools.register({
      name: "synthesize",
      description: "offline direct writer",
      execute: async () => "A closure retains access to its enclosing lexical scope.",
    });
    const start = vi.fn(async (question, mode) => ({
      id: "deep",
      question,
      mode,
      status: "QUEUED",
      sources: [],
      claims: [],
      steps: [],
    }));
    const agent = new AutonomousAgent(tools, { start } as never, llm);
    const direct = await agent.handle("What is a closure in JavaScript?", false);
    expect(direct.answer).toContain("lexical scope");
    expect(search.search).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const deep = await agent.handle("What is a closure in JavaScript?", true);
    expect(deep.route).toBe("deep");
    expect(start).toHaveBeenCalledWith(
      expect.any(String),
      "deep",
      [],
      expect.objectContaining({ researchChatOptimization: true }),
    );
  });

  it("uses the shared quick evidence controller for durable current Chat, reusing its interpretation", async () => {
    const llm = offline();
    const search = { search: vi.fn(async () => []) };
    const tools = createToolRegistry(search, llm);
    const interpret = vi.spyOn(tools, "execute");
    const enqueue = vi.fn(async (question, mode, _memory, interpretation) => ({
      session: {
        id: "current",
        question,
        mode,
        status: "QUEUED",
        sources: [],
        claims: [],
        steps: [],
        plan: { interpretation },
      } as never,
      jobId: "current-job",
    }));
    const agent = new AutonomousAgent(tools, {} as never, llm);
    const preview = await agent.preview("What is the current Node.js LTS version?", false);
    interpret.mockClear();
    const response = await agent.handle(
      "What is the current Node.js LTS version?",
      false,
      undefined,
      enqueue,
      preview.interpretation,
    );
    expect(response.route).toBe("web");
    expect(enqueue).toHaveBeenCalledWith(
      expect.any(String),
      "quick",
      undefined,
      preview.interpretation,
    );
    expect(interpret).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it.each([
    ["What is the current Node.js LTS version?", ["current", "Node.js", "LTS", "version"]],
    ["What was React 18.2.0's release date in 2022?", ["React", "18.2.0", "release date", "2022"]],
    [
      "What was React's stable version as of September 2022?",
      ["React", "stable", "September 2022"],
    ],
    ["Compare the current pricing of X and Y.", ["current", "pricing", "X", "Y"]],
  ])("preserves requested facts in fast query: %s", async (question, terms) => {
    const interpretation = await understandQuery(question, offline(), "quick", {
      allowModel: false,
    });
    const query = planFastLookupQuery(interpretation);
    for (const term of terms) expect(query).toContain(term);
    if (question.includes("2022")) expect(query).not.toContain("latest");
  });

  it("rejects model interpretation and discovery drift, then preserves vector subject in recovery", async () => {
    const question = "Explain vector indexing performance strategies";
    const llm = offline();
    const enabled = vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
    const complete = vi.spyOn(llm, "complete").mockResolvedValue(
      JSON.stringify({
        normalizedQuestion: "What is the latest React version?",
        intent: "release",
        entities: ["React"],
        dimensions: ["version"],
        ambiguityScore: 0,
      }),
    );
    try {
      const interpretation = await understandQuery(question, llm);
      expect(interpretation.normalizedQuestion).toBe(question);
      expect(interpretation.entities).not.toContain("React");
      complete.mockResolvedValue(
        JSON.stringify({ queryGroups: [{ category: "DIRECT", queries: ["React release notes"] }] }),
      );
      const plan = await buildPlan(question, "quick", llm, interpretation);
      expect(plan.queries.length).toBeGreaterThan(0);
      expect(plan.queries.join(" ")).not.toContain("React");
      const recovery = await rewriteQueries(
        question,
        plan,
        [],
        "quick",
        llm,
        plan.structuredObjectives?.slice(0, 1),
      );
      expect(recovery).toHaveLength(1);
      expect(recovery[0]).toMatch(/vector.*indexing/i);
      expect(
        validateRecoveryQuery("performance architecture release notes", question, plan).accepted,
      ).toBe(false);
      expect(validateRecoveryQuery(recovery[0], question, plan).accepted).toBe(true);
    } finally {
      enabled.mockRestore();
      complete.mockRestore();
    }
  });

  it.each([
    ["vector indexing strategies", "Eigenvector rendering performance"],
    ["vector indexing performance", "Vector drawing performance benchmarks"],
    ["React performance", "React versioning policy uses semantic versions for stable releases"],
    ["latest stable Zed version", "Acme stable version 12"],
    ["vector indexing strategies", "Banana sorting latency is 3 milliseconds"],
    ["Compare current pricing of X and Y", "An unrelated system pricing report"],
  ])("rejects unrelated generic or substring overlap: %s / %s", (question, candidate) => {
    expect(
      querySubjectMismatchReason(question, candidate, "Vector indexing benchmarks"),
    ).toBeDefined();
    expect(
      rankResults(question, [
        { title: candidate, snippet: candidate, url: "https://unrelated.example.org/report" },
      ])[0].subjectMismatchReason,
    ).toBeDefined();
  });

  it("keeps relevant sections and rejects a neighboring unrelated benchmark section", () => {
    const content =
      "Vector indexing uses HNSW graphs to accelerate approximate nearest neighbor retrieval.\nBanana sorting latency is 3 milliseconds in a warehouse benchmark.\nThe benchmark measured sorting throughput across warehouses.";
    const relevant = relevantSourceContent(
      "vector indexing performance",
      content,
      "Vector indexing benchmark",
    );
    expect(relevant).toContain("HNSW");
    expect(relevant).not.toContain("Banana");
    expect(relevant).not.toContain("warehouses");
    expect(querySubjectMismatchReason("vector indexing", relevant)).toBeUndefined();
  });

  it("treats full comparison documents differently from isolated search snippets", () => {
    const result = {
      title: "Vector indexing comparison",
      snippet:
        "Vector indexing comparison benchmarks measure HNSW and IVF latency and recall over reproducible workloads.",
    };
    expect(assessSerperSnippet(result, "Compare vector indexing performance").sufficient).toBe(
      false,
    );
    expect(
      assessSerperSnippet(result, "Compare vector indexing performance", [], { fullDocument: true })
        .sufficient,
    ).toBe(true);
  });

  it("rejects cached vector sources for a fresh React request, and vice versa", async () => {
    const store = new SqliteSessionStore(":memory:");
    const now = new Date().toISOString();
    try {
      for (const [url, title, content] of [
        [
          "https://vector.example.org/report",
          "Vector indexing",
          "What vector indexing strategies are available for fast performance?",
        ],
        [
          "https://react.dev/versions",
          "React releases",
          "What React versions are stable and available today?",
        ],
      ])
        await store.saveDocument({
          url,
          title,
          content,
          rawHtml: "",
          fetchedAt: now,
          lastVerifiedAt: now,
          contentHash: url,
          version: 1,
        });
      const provider = new InternalKnowledgeProvider(store);
      const react = await provider.search("What React version is current?");
      const vector = await provider.search("What vector indexing strategies are available?");
      expect(react.length).toBeGreaterThan(0);
      expect(vector.length).toBeGreaterThan(0);
      expect(react.every((source) => !source.url.includes("vector"))).toBe(true);
      expect(vector.every((source) => !source.url.includes("react"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reuses a fresh full comparison document without an external fetch", async () => {
    const store = new SqliteSessionStore(":memory:");
    const now = new Date().toISOString();
    const url = "https://vector.example.org/comparison";
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden in this test"));
    try {
      await store.saveDocument({
        url,
        title: "Vector indexing comparison",
        content:
          "Vector indexing comparison benchmarks measure HNSW and IVF latency and recall over reproducible workloads with documented methodology and limitations.",
        rawHtml: "",
        metadata: { contentType: "html", domain: "vector.example.org" },
        fetchedAt: now,
        lastVerifiedAt: now,
        contentHash: "comparison",
        version: 1,
      });
      const tools = createToolRegistry({ search: async () => [] }, offline(), store);
      expect(
        await tools.execute("fetch_url", {
          url,
          question: "Compare vector indexing performance",
          allowSnippetEvidence: false,
        }),
      ).toMatchObject({ cached: true, retrievalMethod: "cache" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      store.close();
    }
  });

  it("keeps queries, documents, claims, evidence, verdicts and synthesis isolated across successful runs", async () => {
    const llm = offline();
    const store = new SqliteSessionStore(":memory:");
    const reactText =
      "React versioning policy uses semantic versions to communicate documented compatibility changes across stable releases. React versioning policy documents limitations and release practices for application developers.";
    const vectorText =
      "Vector indexing architecture uses graphs for efficient approximate search across large datasets and measured benchmark workloads. Vector indexing performance benchmarks measure recall and latency under documented limitations.";
    const queries: string[] = [];
    const search = {
      search: async (query: string) => {
        queries.push(query);
        const react = /React/i.test(query);
        return [
          {
            title: react ? "React versioning policy" : "Vector indexing benchmarks",
            url: react ? "https://react.dev/policy" : "https://vector.example.org/report",
            snippet: react ? reactText : vectorText,
          },
        ];
      },
    };
    const tools = createToolRegistry(search, llm, store);
    tools.register({
      name: "fetch_url",
      description: "offline document",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "offline" }),
    });
    tools.register({
      name: "extract_content",
      description: "offline document",
      execute: async (input) => {
        const react = (input as { url: string }).url.includes("react");
        return {
          title: react ? "React versioning policy" : "Vector indexing",
          content: react
            ? reactText
            : `${vectorText}\nBanana sorting latency is 3 milliseconds in an unrelated warehouse benchmark.`,
        };
      },
    });
    const verifications: unknown[] = [];
    tools.register({
      name: "verify_claim",
      description: "offline verifier",
      execute: async (input) => {
        verifications.push(structuredClone(input));
        return { verdict: "supported", rationale: "Current source contains the exact evidence." };
      },
    });
    const synthesis: Array<{ question: string; sources: Source[]; claims: Claim[] }> = [];
    tools.register({
      name: "synthesize",
      description: "offline writer",
      execute: async (input) => {
        const current = input as { question: string; sources: Source[]; claims: Claim[] };
        synthesis.push(structuredClone(current));
        return current.claims.map((claim) => `${claim.text} [1].`).join("\n\n");
      },
    });
    const runner = new ResearchRunner(
      store,
      search,
      llm,
      tools,
      {
        maxQueries: 3,
        maxPages: 2,
        maxSources: 2,
        maxSteps: 18,
        maxSearchPasses: 1,
        maxModelDecisions: 0,
        maxTimeMs: 4000,
      },
      undefined,
      true,
    );
    try {
      await runner.runQueued("run-react", "Explain React versioning policy", "quick", [], {
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      });
      expect((await store.get("run-react"))?.status).toBe("COMPLETED");
      queries.length = 0;
      verifications.length = 0;
      synthesis.length = 0;
      await runner.runQueued("run-vector", "Explain vector indexing performance", "quick", [], {
        researchChatOptimization: true,
        allowSnippetEvidence: false,
      });
      const session = (await store.get("run-vector"))!;
      expect(session.status).toBe("COMPLETED");
      expect(synthesis).toHaveLength(1);
      expect(verifications.length).toBeGreaterThan(0);
      expect(queries).toHaveLength(1);
      expect(
        JSON.stringify({
          queries,
          sources: session.sources,
          claims: session.claims,
          state: session.state,
          verifications,
          synthesis,
        }),
      ).not.toMatch(/React|Banana/i);
      expect(
        session.claims.every(
          (claim) =>
            claim.provenance?.sessionId === "run-vector" &&
            claim.verification?.verdict === "supported",
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reconstructs supplied evidence from current content rather than trusting an authentic prefix", async () => {
    const llm = offline();
    const store = new SqliteSessionStore(":memory:");
    const content =
      "Vector indexing architecture uses graphs for efficient approximate search across large datasets and measured benchmark workloads. Vector indexing benchmarks measure recall and query latency with explicit limitations.";
    const search = {
      search: async () => [
        { title: "Vector indexing", url: "https://vector.example.org/report", snippet: content },
      ],
    };
    const tools = createToolRegistry(search, llm, store);
    tools.register({
      name: "fetch_url",
      description: "offline",
      execute: async () => ({ html: "offline", url: "https://vector.example.org/report" }),
    });
    tools.register({
      name: "extract_content",
      description: "offline",
      execute: async () => ({ title: "Vector indexing", content }),
    });
    tools.register({
      name: "extract_claims",
      description: "forged suffix regression",
      execute: async (input) => [
        {
          id: "forged-evidence",
          text: "Vector indexing benchmarks measure query latency.",
          sourceIds: [(input as { sources: Source[] }).sources[0].id],
          evidence: `${content.slice(0, 80)} Vector indexing has unlimited capacity and zero latency.`,
          confidence: 0.9,
        },
      ],
    });
    const observed: string[] = [];
    tools.register({
      name: "verify_claim",
      description: "offline",
      execute: async (input) => {
        observed.push((input as { evidence: string }).evidence);
        return { verdict: "uncertain" };
      },
    });
    const runner = new ResearchRunner(
      store,
      search,
      llm,
      tools,
      {
        maxQueries: 1,
        maxPages: 1,
        maxSources: 1,
        maxSteps: 12,
        maxSearchPasses: 0,
        maxModelDecisions: 0,
        maxTimeMs: 3000,
      },
      undefined,
      true,
    );
    try {
      await runner.runQueued(
        "forged-evidence",
        "Explain vector indexing performance",
        "quick",
        [],
        { researchChatOptimization: true, allowSnippetEvidence: false },
      );
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(content.split(/(?<=[.!?])\s+/).join("\n"));
      expect(observed[0]).not.toContain("unlimited");
    } finally {
      store.close();
    }
  });

  it.each(["unsupported", "not supported", "timeout", "401", "malformed JSON", "429"])(
    "never supports a malformed or unavailable verifier result: %s",
    async (failure) => {
      const llm = offline();
      const store = new SqliteSessionStore(":memory:");
      const sourceText =
        "Vector indexing architecture uses graphs for efficient approximate search across large datasets and measured benchmark workloads. Vector indexing performance benchmarks measure recall and latency under documented limitations.";
      const search = {
        search: async () => [
          {
            title: "Vector indexing benchmark",
            url: "https://vector.example.org/report",
            snippet: sourceText,
          },
        ],
      };
      const tools = createToolRegistry(search, llm, store);
      tools.register({
        name: "fetch_url",
        description: "offline",
        execute: async () => ({ html: "offline", url: "https://vector.example.org/report" }),
      });
      tools.register({
        name: "extract_content",
        description: "offline",
        execute: async () => ({ title: "Vector indexing", content: sourceText }),
      });
      tools.register({
        name: "verify_claims_batch",
        description: "offline malformed verifier",
        execute: async (input) => {
          if (["timeout", "401", "malformed JSON"].includes(failure)) throw new Error(failure);
          return (input as { claims: Claim[] }).claims.map((claim) => ({
            id: claim.id,
            verdict: failure === "429" ? "unavailable" : failure,
            rationale: failure === "429" ? "OpenRouter returned 429" : failure,
          }));
        },
      });
      const synthesis = vi.fn(async () => "should not be called");
      tools.register({ name: "synthesize", description: "offline", execute: synthesis });
      const runner = new ResearchRunner(store, search, llm, tools, {
        maxQueries: 1,
        maxPages: 1,
        maxSources: 1,
        maxSteps: 12,
        maxSearchPasses: 0,
        maxModelDecisions: 0,
        maxTimeMs: 3000,
      });
      try {
        await runner.runQueued(
          `failure-${failure}`,
          "Explain vector indexing performance",
          "quick",
          [],
          { allowSnippetEvidence: false },
        );
        const session = (await store.get(`failure-${failure}`))!;
        expect(session.claims.length).toBeGreaterThan(0);
        expect(session.claims.every((claim) => claim.verification?.verdict === "unavailable")).toBe(
          true,
        );
        expect(session.status).toBe("FAILED");
        expect(synthesis).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    },
  );
});
