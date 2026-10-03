import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { rankResults, selectResearchSources } from "../src/rank.js";
import { ResearchRunner } from "../src/research.js";
import { SqliteSessionStore } from "../src/store.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { withWorkerContext } from "../src/worker-context.js";
import { withOperationContext } from "../src/operation-context.js";
import type { ResearchSession } from "../src/domain.js";
import { config } from "../src/config.js";
import { InternalKnowledgeProvider } from "../src/search.js";
import { assessSerperSnippet } from "../src/source-retrieval.js";

const question =
  "What are the verified performance differences between vector indexing strategies?";
const react = {
  title: "React versioning policy",
  url: "https://react.dev/community/versioning-policy",
  snippet:
    "All stable builds of React go through a high level of testing and follow semantic versioning (semver). React also offers unstable release channels to encourage early feedback on experimental features. This page describes what you can expect from React releases. This versioning policy describes our approach to version numbers for packages such as react and react-dom. Minor releases are the most common type of release.",
};

describe("research query isolation", () => {
  it("isolates a previous React run, fresh vector job, and its retry against the shared document cache", async () => {
    const store = new SqliteSessionStore(":memory:");
    const provider = new OpenRouterProvider();
    const disabled = vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
    const vector = {
      title: "Vector indexing benchmarks",
      url: "https://vector.example.org/benchmarks",
      snippet:
        "Vector indexing strategies trade recall, query latency and build cost across measured benchmark workloads.",
    };
    const search = {
      search: async (query: string) => (query.includes("vector") ? [vector] : [react]),
    };
    const registry = createToolRegistry(search, provider, store);
    registry.register({
      name: "fetch_url",
      description: "offline fixture",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        const result = url === react.url ? react : vector;
        return {
          url,
          html: `<html><head><title>${result.title}</title></head><body><article>${Array(8).fill(result.snippet).join(" ")}</article></body></html>`,
          contentType: "text/html",
        };
      },
    });
    const checked: string[] = [];
    const verifierScopes: Array<{ sessionId?: string; jobId?: string; question?: string }> = [];
    registry.register({
      name: "verify_claims_batch",
      description: "offline unavailable verifier",
      execute: async (input) =>
        (input as { claims: Array<{ id: string; claim: string }> }).claims.map((claim) => {
          verifierScopes.push(input as { sessionId?: string; jobId?: string; question?: string });
          checked.push(claim.claim);
          return {
            id: claim.id,
            verdict: "unavailable",
            rationale: "Verifier unavailable: OpenRouter returned 429",
          };
        }),
    });
    const created: ResearchSession[] = [];
    const create = store.create.bind(store);
    vi.spyOn(store, "create").mockImplementation(async (session) => {
      created.push(structuredClone(session));
      await create(session);
    });
    const runner = new ResearchRunner(store, search, provider, registry, {
      maxSteps: 12,
      maxQueries: 1,
      maxSearchPasses: 0,
      maxSources: 2,
      maxPages: 2,
      maxTimeMs: 3000,
      maxModelDecisions: 0,
    });
    const queue = new InMemoryDurableJobStore();
    try {
      await runner.runQueued("previous-react", "Explain React versioning policy", "quick", [], {
        allowSnippetEvidence: false,
      });
      const previous = (await store.get("previous-react"))!;
      expect(previous.claims.some((claim) => /React/i.test(claim.text))).toBe(true);
      expect(await store.getDocument(react.url)).toBeDefined();
      expect(
        (await store.searchDocuments(question, 30 * 86400000)).some(
          (document) => document.url === react.url,
        ),
      ).toBe(true);
      expect(await new InternalKnowledgeProvider(store).search(question)).toEqual([]);
      checked.length = 0;
      verifierScopes.length = 0;
      await queue.enqueueJob({
        id: "vector-job",
        kind: "research",
        ownerScope: "system",
        payload: { sessionId: "vector-session", question },
        maxAttempts: 2,
      });
      const lease = (await queue.claimJob("fixture", 45))!;
      await withWorkerContext(
        lease,
        new AbortController().signal,
        async () => {},
        () =>
          runner.runQueued("vector-session", question, "quick", [], {
            allowSnippetEvidence: false,
          }),
      );
      const current = (await store.get("vector-session"))!;
      expect(current.claims.length).toBeGreaterThan(0);
      expect(current.sources.some((source) => source.url.includes("react.dev"))).toBe(false);
      expect(current.claims.some((claim) => /React/i.test(claim.text + claim.evidence))).toBe(
        false,
      );
      expect(
        current.claims.every(
          (claim) =>
            claim.provenance?.sessionId === current.id &&
            claim.provenance.jobId === lease.job.id &&
            claim.provenance.question === question,
        ),
      ).toBe(true);
      expect(
        current.claims.every((claim) =>
          claim.sourceIds.every((id) => current.sources.some((source) => source.id === id)),
        ),
      ).toBe(true);
      expect(checked.some((text) => /React/i.test(text))).toBe(false);
      expect(verifierScopes.length).toBeGreaterThan(0);
      expect(
        verifierScopes.every(
          (scope) =>
            scope.sessionId === current.id &&
            scope.jobId === lease.job.id &&
            scope.question === question,
        ),
      ).toBe(true);
      expect(current.state?.verifiedClaims).toEqual([]);
      expect(current.status).toBe("FAILED");
      expect(current.error).toContain("OpenRouter returned 429");
      expect(current.claims.every((claim) => claim.verification?.verdict === "unavailable")).toBe(
        true,
      );
      await withWorkerContext(
        { ...lease, generation: 2 },
        new AbortController().signal,
        async () => {},
        () =>
          runner.runQueued("vector-session", question, "quick", [], {
            allowSnippetEvidence: false,
          }),
      );
      expect(
        (await store.get("vector-session"))?.claims.some((claim) => /React/i.test(claim.text)),
      ).toBe(false);
      expect(
        created.every(
          (session) =>
            session.claims.length === 0 && session.sources.length === 0 && !session.state,
        ),
      ).toBe(true);
      expect((await store.get("previous-react"))?.claims).toEqual(previous.claims);
      await expect(runner.runQueued("previous-react", question, "quick")).rejects.toThrow(
        "different request",
      );
    } finally {
      disabled.mockRestore();
      store.close();
    }
  });

  it("a 429 verifier call does not inherit a previous operation's verdict or citation report", async () => {
    const provider = new OpenRouterProvider({ maxAttempts: 1 });
    const registry = createToolRegistry({ search: async () => [] }, provider);
    const previousKey = config.OPENROUTER_API_KEY;
    const fetch = vi.spyOn(globalThis, "fetch");
    config.OPENROUTER_API_KEY = "fixture-only";
    try {
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verifications: [{ id: "react-claim", verdict: "supported" }],
                  }),
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await withOperationContext(async () => {
        const result = await registry.execute("verify_claims_batch", {
          claims: [
            {
              id: "react-claim",
              claim: "React releases use semantic versioning.",
              evidence: "React releases use semantic versioning.",
            },
          ],
        });
        expect(result).toEqual([
          expect.objectContaining({ id: "react-claim", verdict: "supported" }),
        ]);
        await provider.validateCitedAnswer("Previous React report", []);
        expect(provider.metrics.citationEntailment).toBeDefined();
      });
      fetch.mockResolvedValue(new Response("rate limited", { status: 429 }));
      await withOperationContext(async () => {
        expect(provider.metrics.citationEntailment).toBeUndefined();
        const result = await registry.execute("verify_claims_batch", {
          claims: [
            {
              id: "vector-claim",
              claim: "Vector indexes trade recall for latency.",
              evidence: "Vector indexes trade recall for latency.",
            },
            {
              id: "vector-skipped",
              claim: "Vector indexes require build time.",
              evidence: "Vector indexes require build time.",
            },
          ],
        });
        expect(result).toEqual([
          expect.objectContaining({ id: "vector-claim", verdict: "unavailable" }),
          expect.objectContaining({ id: "vector-skipped", verdict: "unavailable" }),
        ]);
        expect(provider.metrics.citationEntailment).toBeUndefined();
        expect(provider.metrics.calls).toBe(1);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("rejects a cached unrelated source even when its ranking score is forged", async () => {
    const provider = new OpenRouterProvider();
    const registry = createToolRegistry({ search: async () => [] }, provider);
    const source = rankResults("Explain React versioning policy", [react])[0]!;
    const claims = await registry.execute("extract_claims", {
      sources: [{ ...source, content: react.snippet }],
      question,
      entities: [],
    });
    expect(claims).toEqual([]);
  });

  it("rejects stale request provenance and foreign source IDs before verification or coverage", async () => {
    const store = new SqliteSessionStore(":memory:");
    const provider = new OpenRouterProvider();
    const disabled = vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
    const vector = {
      title: "Vector indexing benchmarks",
      url: "https://vector.example.org/benchmarks",
      snippet:
        "Vector indexing strategies trade recall and latency on controlled benchmark workloads.",
    };
    const search = { search: async () => [vector] };
    const original = createToolRegistry(search, provider);
    const registry = createToolRegistry(search, provider);
    registry.register({
      name: "fetch_url",
      description: "offline fixture",
      execute: async () => ({
        url: vector.url,
        html: `<article>${Array(8).fill(vector.snippet).join(" ")}</article>`,
      }),
    });
    registry.register({
      name: "extract_claims",
      description: "stale tool fixture",
      execute: async (input) => {
        const claims = (await original.execute(
          "extract_claims",
          input,
        )) as import("../src/domain.js").Claim[];
        const valid = claims[0]!;
        expect(valid).toBeDefined();
        return [
          ...claims,
          {
            ...valid,
            id: "stale-session",
            provenance: { sessionId: "previous-session", jobId: "previous-job", question },
          },
          { ...valid, id: "foreign-source", sourceIds: ["previous-source"] },
          {
            ...valid,
            id: "stale-question",
            provenance: {
              sessionId: "current-session",
              question: "Explain React versioning policy",
            },
          },
        ];
      },
    });
    const verifiedIds: string[] = [];
    registry.register({
      name: "verify_claims_batch",
      description: "offline verifier",
      execute: async (input) =>
        (input as { claims: Array<{ id: string }> }).claims.map((claim) => {
          verifiedIds.push(claim.id);
          return {
            id: claim.id,
            verdict: "unavailable",
            rationale: "Verifier unavailable: OpenRouter returned 429",
          };
        }),
    });
    const runner = new ResearchRunner(store, search, provider, registry, {
      maxSteps: 12,
      maxQueries: 1,
      maxSearchPasses: 0,
      maxPages: 1,
      maxModelDecisions: 0,
      maxTimeMs: 3000,
    });
    try {
      const session = (await runner.runQueued("current-session", question, "quick", [], {
        allowSnippetEvidence: false,
      }))!;
      expect(session.claims.length).toBeGreaterThan(0);
      expect(verifiedIds.length).toBeGreaterThan(0);
      const invalid = ["stale-session", "foreign-source", "stale-question"];
      expect(verifiedIds.some((id) => invalid.includes(id))).toBe(false);
      expect(session.claims.some((claim) => invalid.includes(claim.id))).toBe(false);
      expect(
        session.state?.objectives.some((objective) =>
          objective.evidenceIds.some((id) => invalid.includes(id)),
        ),
      ).toBe(false);
    } finally {
      disabled.mockRestore();
      store.close();
    }
  });

  it("rejects unrelated React metadata despite overlap on the generic word what", () => {
    const ranked = rankResults(question, [react]);
    expect(selectResearchSources(ranked, [], 4, "none", question)).toEqual([]);
  });

  it("does not accept an internal knowledge snippet because it contains what and are", () => {
    expect(assessSerperSnippet(react, question).sufficient).toBe(false);
  });

  it("does not extract unrelated React passages from a previous cached document", async () => {
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const sources = rankResults(question, [react]).map((source) => ({
      ...source,
      content: react.snippet,
    }));
    const claims = await registry.execute("extract_claims", {
      sources,
      question,
      entities: [],
      requestedFacts: [],
    });
    expect(claims).toEqual([]);
  });
});
