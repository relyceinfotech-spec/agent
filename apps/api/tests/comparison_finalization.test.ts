import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../src/agent/tools.js";
import type { Claim, Source } from "../src/domain.js";
import { auditResearchCitations, OpenRouterProvider } from "../src/llm.js";
import { buildPlan } from "../src/planner.js";
import * as planner from "../src/planner.js";
import { renderStructuredResearchAnswer } from "../src/research-answer.js";
import { validateCitationEntailment } from "../src/citation-entailment.js";
import { comparisonCoverage, comparisonObjective } from "../src/comparison-evidence.js";
import { rankResults } from "../src/rank.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { SqliteSessionStore } from "../src/store.js";

const question =
  "Compare the current performance differences between HNSW and IVF vector indexing strategies using relevant technical sources.";
const passages = [
  "HNSW connects neighboring vectors in a graph during vector indexing. This means it achieves lower latency in the documented workload.",
  "HNSW query latency is 10 milliseconds in the documented vector indexing benchmark workload.",
  "IVF groups vectors into partitions around shared centers during vector indexing. This means its scan depth controls query latency in the documented workload.",
];
function fixtures() {
  const sources = rankResults(
    question,
    passages.map((content, index) => ({
      title: "HNSW and IVF vector indexing performance benchmark",
      url: `https://fixture${index}.example.org/benchmarks`,
      snippet: content,
    })),
  ).map((source) => ({
    ...source,
    content: passages[Number(source.domain.match(/fixture(\d)/)?.[1])],
  })) as Source[];
  const claims: Claim[] = sources.map((source, index) => ({
    id: `claim-${index}`,
    text: source.content!,
    evidence: source.content!,
    sourceIds: [source.id],
    confidence: 1,
    verification: { verdict: "supported" },
  }));
  return { sources, claims };
}
afterEach(() => vi.restoreAllMocks());

describe("verified comparison finalization without live providers", () => {
  it("does not let repeated citations bypass the distinct-source limit", async () => {
    const { sources, claims } = fixtures();
    const fourth = { ...sources[0]!, id: "fourth-source" };
    const report = await validateCitationEntailment(
      renderStructuredResearchAnswer(
        [{ text: claims[0]!.text, sourceIds: [...sources.map((source) => source.id), fourth.id] }],
        [...sources, fourth],
      ),
      [...sources, fourth],
      undefined,
      claims,
    );
    expect(report.status).toBe("REJECTED");
    expect(report.items[0]?.sourceLimitExceeded).toBe(true);
  });

  it("rejects repeated citations bound to a different source from the verified claim", async () => {
    const { sources, claims } = fixtures();
    const report = await validateCitationEntailment(
      renderStructuredResearchAnswer(
        [{ text: claims[0]!.text, sourceIds: [sources[1]!.id] }],
        sources,
      ),
      sources,
      undefined,
      claims,
    );
    expect(report.status).toBe("REJECTED");
    expect(report.items[0]?.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });
  it("cites every sentence while retaining source-bound controller verification", async () => {
    const { sources, claims } = fixtures();
    const answer = renderStructuredResearchAnswer(claims, sources);
    expect(auditResearchCitations(answer, sources.length)).toEqual({
      invalidMarkers: [],
      uncitedSentences: [],
    });
    const judge = vi.fn();
    const report = await validateCitationEntailment(answer, sources, judge, claims);
    expect(report.status).toBe("VALIDATED");
    expect(report.items).toHaveLength(3);
    expect(judge).not.toHaveBeenCalled();
  });

  it.each(["model", "deterministic"])(
    "completes real %s synthesis for exactly three verified comparison claims",
    async (mode) => {
      const provider = new OpenRouterProvider();
      vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
      const plan = await buildPlan(question, "quick", provider, undefined, {
        researchChatOptimization: true,
      });
      // Unrelated prose objectives are not required facts or comparison cells.
      plan.objectives.push("Identify an unrelated default release version");
      const { sources, claims } = fixtures();
      expect(comparisonCoverage(comparisonObjective(question)!, claims).sufficient).toBe(true);
      vi.spyOn(provider, "enabled", "get").mockReturnValue(true);
      const complete = vi.spyOn(provider, "complete");
      if (mode === "model")
        complete.mockResolvedValue(
          JSON.stringify({
            statements: claims.map(({ text, sourceIds }) => ({ text, sourceIds })),
          }),
        );
      else complete.mockRejectedValue(new Error("fixture synthesis unavailable"));
      const answer = await provider.synthesize(
        question,
        plan,
        sources,
        claims,
        undefined,
        "quick",
        undefined,
        undefined,
        true,
      );
      expect(answer).not.toMatch(/^Insufficient evidence/);
      expect(provider.metrics.synthesis).toMatchObject({
        finalAnswerSource: mode,
        requiredFactCoverage: { missing: [] },
        citationValidationResult: "VALIDATED",
      });
      expect(auditResearchCitations(answer, 3).uncitedSentences).toEqual([]);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "complete",
    "stale-state",
    "unrelated-objective",
    "missing",
    "unavailable",
    "invalid-citations",
    "empty-synthesis",
    "deadline",
    "deadline-after-evidence",
  ])("keeps durable session and job terminal states consistent: %s", async (scenario) => {
    const unrelatedObjective = "Resolve quasar neutrino ledger certificate";
    if (scenario === "unrelated-objective") {
      const original = planner.buildPlan;
      vi.spyOn(planner, "buildPlan").mockImplementation(async (...args) => {
        const plan = await original(...args);
        plan.objectives.push(unrelatedObjective);
        return plan;
      });
    }
    const provider = new OpenRouterProvider();
    vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
    const complete = vi
      .spyOn(provider, "complete")
      .mockRejectedValue(new Error("Unexpected fixture model call"));
    if (scenario === "deadline-after-evidence") {
      const original = provider.synthesize.bind(provider);
      vi.spyOn(provider, "synthesize").mockImplementationOnce(async (...args) => {
        const answer = await original(...args);
        const expiredAt = Date.now() + 6000;
        vi.spyOn(Date, "now").mockReturnValue(expiredAt);
        return answer;
      });
    }
    if (scenario === "stale-state") {
      provider.metrics.citationEntailment = {
        status: "REJECTED",
        finalAnswer: "previous run",
        items: [],
        failure: "previous failure",
      };
      provider.metrics.synthesis = {
        attempted: true,
        fallbackUsed: true,
        finalAnswerSource: "unavailable",
        requiredFactCoverage: { required: ["version"], present: [], missing: ["version"] },
        evidenceFactCoverage: { required: ["version"], present: [], missing: ["version"] },
        citationValidationResult: "REJECTED",
      };
    }
    const store = new SqliteSessionStore(":memory:");
    const jobs = new InMemoryDurableJobStore();
    let searches = 0;
    const search = {
      search: async () => {
        searches++;
        const indices = searches === 1 ? [0, 1] : scenario === "missing" ? [] : [2];
        return indices.map((index) => ({
          title: "HNSW and IVF vector indexing performance benchmark",
          url: `https://fixture${index}.example.org/benchmarks`,
          snippet:
            "HNSW and IVF vector indexing performance latency benchmarks and measured workload results.",
        }));
      },
    };
    const tools = createToolRegistry(search, provider, store);
    tools.register({
      name: "fetch_url",
      description: "offline",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "fixture" }),
    });
    tools.register({
      name: "extract_content",
      description: "offline",
      execute: async (input) => ({
        title: "HNSW and IVF performance",
        content: passages[Number((input as { url: string }).url.match(/fixture(\d)/)?.[1])],
      }),
    });
    tools.register({
      name: "verify_claim",
      description: "offline",
      execute: async () =>
        scenario === "unavailable"
          ? { verdict: "unavailable", rationale: "Fixture provider unavailable" }
          : { verdict: "supported" },
    });
    if (scenario === "invalid-citations" || scenario === "empty-synthesis")
      tools.register({
        name: "synthesize",
        description: "offline failure",
        execute: async () =>
          scenario === "empty-synthesis"
            ? ""
            : "HNSW and IVF query latency differs in this workload. [99]",
      });
    const app = await createServer({
      store,
      jobStore: jobs,
      searchProvider: search,
      llmProvider: provider,
      toolRegistry: tools,
      authVerifier: { verifyAccessToken: async () => ({ id: "finalization-user" }) },
      memoryService: {
        enabled: false,
        retrieveForQuestion: async () => ({ needed: false, memories: [] }),
      } as never,
      researchBudget: {
        maxQueries: 2,
        maxSources: 3,
        maxPages: 3,
        maxSteps: 20,
        maxClaimsToVerify: 3,
        maxSearchPasses: 1,
        maxModelDecisions: 0,
        maxTimeMs: scenario === "deadline" ? 1 : 5000,
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { authorization: "Bearer fixture-token" },
        payload: { message: question, deepResearch: false },
      });
      expect(response.statusCode).toBe(202);
      const queued = response.json<{ jobId: string; researchId: string }>();
      await getServerBackgroundServices(app).worker.runNow(queued.jobId);
      const readback = await app.inject({
        method: "GET",
        url: `/api/research/${queued.researchId}`,
        headers: { authorization: "Bearer fixture-token" },
      });
      const session = readback.json();
      const job = await jobs.getJob(queued.jobId);
      const success = ["complete", "stale-state", "unrelated-objective"].includes(scenario);
      expect(session.status, session.error).toBe(success ? "COMPLETED" : "FAILED");
      expect(job?.status).toBe(success ? "completed" : "failed");
      if (scenario === "deadline-after-evidence") {
        expect(
          session.claims.filter((claim: Claim) => claim.verification?.verdict === "supported"),
        ).toHaveLength(3);
        expect(session.error).toMatch(/deadline|time.*budget/i);
      }
      if (scenario === "invalid-citations" || scenario === "empty-synthesis") {
        expect(session.state.comparisonCoverage.sufficient).toBe(true);
        expect(session.error).toMatch(
          scenario === "invalid-citations" ? /CITATION_VALIDATION_FAILED/ : /RESEARCH_INCOMPLETE/,
        );
      }
      if (success) {
        if (scenario === "unrelated-objective")
          expect(session.plan.objectives).toContain(unrelatedObjective);
        expect(session.claims).toHaveLength(3);
        expect(
          session.claims.every((claim: Claim) => claim.verification?.verdict === "supported"),
        ).toBe(true);
        expect(session.state.comparisonCoverage.sufficient).toBe(true);
        expect(session.state.comparisonCoverage.performanceDimensions.shared).toContain("latency");
        expect(session.searchRecoveries).toHaveLength(1);
        expect(auditResearchCitations(session.answer, 3).uncitedSentences).toEqual([]);
      }
      expect(complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
