import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { ResearchRunner } from "../src/research.js";
import { SqliteSessionStore } from "../src/store.js";
import { rankResults, selectResearchSourcesWithDecisions } from "../src/rank.js";
import { comparisonObjective } from "../src/comparison-evidence.js";
import type { SearchResult } from "../src/domain.js";

afterEach(() => vi.restoreAllMocks());
const question =
  "Compare current performance differences between HNSW and IVF vector indexing strategies using relevant technical sources.";
const hnsw =
  "HNSW query latency is 10 milliseconds in the documented vector indexing benchmark workload.";
const ivf =
  "IVF query latency is 20 milliseconds in the documented vector indexing benchmark workload.";
const entry = (host: string, snippet: string, path = "benchmark"): SearchResult => ({
  title: "HNSW and IVF vector indexing performance benchmark",
  url: `https://${host}/${path}`,
  snippet,
});
async function scenario(
  results: SearchResult[],
  failures: Record<string, string> = {},
  maxSources = 3,
  articleFindings: Record<string, string> = {},
) {
  const llm = new OpenRouterProvider();
  vi.spyOn(llm, "enabled", "get").mockReturnValue(false);
  const complete = vi.spyOn(llm, "complete").mockRejectedValue(new Error("Unexpected live call"));
  const store = new SqliteSessionStore(":memory:");
  const search = { search: vi.fn(async () => results) };
  const tools = createToolRegistry(search, llm, store);
  const fetched: string[] = [];
  tools.register({
    name: "fetch_url",
    description: "offline source availability",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      fetched.push(url);
      if (failures[url]) throw new Error(failures[url]);
      const result = results.find((candidate) => candidate.url === url)!;
      const finding = articleFindings[url] ?? (result.snippet.includes("IVF query") ? ivf : hnsw);
      return {
        url,
        html: `<article><h2>${finding.startsWith("IVF") ? "IVF" : "HNSW"}</h2><p>${finding}</p><p>The documented study explains its workload and limitations without additional measured findings.</p></article>`,
        contentType: "text/html",
        retrievalMethod: "http",
      };
    },
  });
  tools.register({
    name: "verify_claim",
    description: "offline source bound verification",
    execute: async (input) => {
      const claim = input as { claim: string; evidence: string; sourceIds: string[] };
      expect(claim.claim).toBe(claim.evidence);
      expect(claim.sourceIds).toHaveLength(1);
      return { verdict: "supported", rationale: "Deterministic fixture" };
    },
  });
  const runner = new ResearchRunner(
    store,
    search,
    llm,
    tools,
    {
      maxQueries: 2,
      maxSources,
      maxPages: 3,
      maxSearchPasses: 1,
      maxSteps: 14,
      maxClaimsToVerify: 4,
      maxModelDecisions: 0,
      maxTimeMs: 5000,
    },
    undefined,
    true,
  );
  try {
    await runner.runQueued("acquisition", question, "quick", [], {
      researchChatOptimization: true,
      allowSnippetEvidence: false,
    });
    const session = (await store.get("acquisition"))!;
    expect(fetched.length).toBeLessThanOrEqual(3);
    expect(fetched.length).toBeLessThanOrEqual(maxSources);
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(search.search.mock.calls.length).toBeLessThanOrEqual(2);
    expect(complete).not.toHaveBeenCalled();
    if (process.env.SOURCE_ACQUISITION_TRACE_PATH)
      appendFileSync(
        process.env.SOURCE_ACQUISITION_TRACE_PATH,
        `${JSON.stringify({ results, failures, fetched, searchCount: search.search.mock.calls.length, terminalStatus: session.status, terminalReason: session.error, decisions: session.sourceSelectionDecisions, domains: session.sources.filter((source) => source.content).map((source) => source.domain), coverage: session.state?.comparisonCoverage })}\n`,
      );
    return { session, fetched, searchCount: search.search.mock.calls.length };
  } finally {
    store.close();
  }
}

describe("independent comparison source acquisition", () => {
  it("a promising search snippet never substitutes for the retrieved article's evidence", async () => {
    const primary = entry("primary.example.edu", hnsw);
    const misleading = entry("independent.example.net", ivf);
    const { session } = await scenario([primary, misleading], {}, 3, { [misleading.url]: hnsw });
    expect(session.status).toBe("FAILED");
    expect(session.error).toMatch(/^INSUFFICIENT_EVIDENCE/);
    expect(session.claims.every((claim) => !claim.text.includes("IVF"))).toBe(true);
  });
  it("missing-target selection uses arbitrary comparison names", () => {
    const request = "Compare Aster and Beryl vector indexing performance";
    const ranked = rankResults(request, [
      entry(
        "aster.example.org",
        "Aster query latency is 10 milliseconds in this vector indexing benchmark.",
      ),
      entry(
        "beryl.example.net",
        "Beryl query latency is 20 milliseconds in this vector indexing benchmark.",
      ),
    ]);
    const selection = selectResearchSourcesWithDecisions(
      ranked,
      [],
      1,
      "none",
      request,
      undefined,
      true,
      {
        comparison: comparisonObjective(request)!,
        neededTargets: ["Beryl"],
        usedDomains: ["aster.example.org"],
        unavailableUrls: [],
      },
    );
    expect(selection.selected[0]?.domain).toBe("beryl.example.net");
    expect(
      selection.decisions.find((decision) => decision.selected)?.acquisition?.targetLeads,
    ).toEqual(["Beryl"]);
  });
  it("uses missing-target discovery leads instead of spending the budget on broad unavailable candidates", async () => {
    const aws = entry("docs.primary.example.org", hnsw);
    const medium = entry(
      "publication.second.example.net",
      "HNSW and IVF vector indexing performance are discussed by this technical article.",
    );
    const milvus = entry(
      "publication.third.example.net",
      "Learn about HNSW and IVF vector indexing performance in this overview.",
    );
    const alternate = entry("benchmarks.independent.example.edu", ivf);
    const { session, fetched } = await scenario([aws, medium, milvus, alternate], {
      [medium.url]: "HTTP 403",
      [milvus.url]: "Exceeded maximum redirect limit of 3",
    });
    expect(session.status, session.error).toBe("COMPLETED");
    expect(fetched).toEqual(expect.arrayContaining([aws.url, alternate.url]));
    expect(fetched).not.toContain(medium.url);
    expect(fetched).not.toContain(milvus.url);
    expect(session.state?.comparisonCoverage?.performanceDimensions?.shared).toContain("latency");
  });
  it.each([
    "HTTP 403",
    "Exceeded maximum redirect limit of 3",
    "Fetch timed out",
    "Malformed retrieved document",
    "Extracted content is too short to use as evidence",
  ])("replaces a failed IVF lead (%s) from the same result set", async (failure) => {
    const aws = entry("docs.primary.example.org", hnsw);
    const first = entry("benchmarks.first.example.edu", ivf);
    const second = entry("benchmarks.second.example.net", ivf);
    const { session, fetched } = await scenario([aws, first, second], { [first.url]: failure });
    expect(fetched).toContain(first.url);
    expect(fetched).toContain(second.url);
    expect(session.status, session.error).toBe("COMPLETED");
    const failed = session.sourceSelectionDecisions?.find((decision) => decision.url === first.url);
    expect(failed?.retrieval?.status).toBe("failed");
    expect(failed?.retrieval?.replacementUrl).toBe(fetched[fetched.indexOf(first.url) + 1]);
    if (failure === "HTTP 403") expect(failed?.retrieval?.httpStatus).toBe(403);
    if (/redirect/.test(failure)) expect(failed?.retrieval?.category).toBe("REDIRECT_LIMIT");
    expect(
      session.sources.filter((source) => source.content).map((source) => source.domain),
    ).toHaveLength(2);
  });
  it("fails truthfully when every independent IVF candidate is unavailable", async () => {
    const aws = entry("docs.primary.example.org", hnsw);
    const first = entry("benchmarks.first.example.edu", ivf);
    const second = entry("benchmarks.second.example.net", ivf);
    const { session } = await scenario([aws, first, second], {
      [first.url]: "HTTP 403",
      [second.url]: "Exceeded maximum redirect limit of 3",
    });
    expect(session.status).toBe("FAILED");
    expect(session.error).toMatch(/^INSUFFICIENT_EVIDENCE/);
    expect(session.state?.comparisonCoverage?.sufficient).toBe(false);
    expect(session.claims.every((claim) => !claim.text.includes("IVF"))).toBe(true);
  });
  it("selects an equally relevant independent domain ahead of a same-domain duplicate", () => {
    const initial = entry("docs.same.example.org", hnsw);
    const duplicate = entry("docs.same.example.org", ivf, "ivf");
    const independent = entry("docs.independent.example.net", ivf);
    const ranked = rankResults(question, [duplicate, independent]);
    ranked.forEach((source) => {
      source.quality = { ...source.quality, overall: 0.8, relevance: 1 };
    });
    const selection = selectResearchSourcesWithDecisions(
      ranked,
      [],
      1,
      "none",
      question,
      undefined,
      true,
      {
        comparison: comparisonObjective(question)!,
        neededTargets: ["IVF"],
        usedDomains: ["docs.same.example.org"],
        unavailableUrls: [],
      },
    );
    expect(selection.selected[0]?.url).toBe(independent.url);
    expect(
      selection.decisions.find((decision) => decision.url === independent.url)?.acquisition,
    ).toMatchObject({ targetLeads: ["IVF"], independentDomain: true });
    expect(initial.url).not.toBe(independent.url);
  });
  it("keeps the separate source ceiling strict after a failed retrieval", async () => {
    const first = entry("benchmarks.first.example.edu", ivf);
    const duplicate = entry("benchmarks.first.example.edu", ivf, "duplicate");
    const alternate = entry("docs.second.example.net", hnsw);
    const { fetched, session } = await scenario(
      [first, duplicate, alternate],
      { [first.url]: "HTTP 403" },
      2,
    );
    expect(fetched).toHaveLength(2);
    expect(session.status).toBe("FAILED");
    expect(session.error).toMatch(/^INSUFFICIENT_EVIDENCE/);
  });
  it("reaches a candidate beyond the original shortlist after a failure using only three page attempts", async () => {
    const failed = entry("initial.example.edu", `${hnsw} ${ivf}`);
    const useful = entry("primary.example.edu", hnsw);
    const redundant = entry("redundant.example.edu", hnsw);
    const alternate = entry("alternate.example.net", ivf);
    const results = [failed, useful, redundant, alternate];
    const initial = selectResearchSourcesWithDecisions(
      rankResults(question, results),
      [],
      3,
      "none",
      question,
      undefined,
      true,
      {
        comparison: comparisonObjective(question)!,
        neededTargets: ["HNSW", "IVF"],
        usedDomains: [],
        unavailableUrls: [],
      },
    );
    expect(initial.selected.map((source) => source.url)).not.toContain(alternate.url);
    const { session, fetched } = await scenario(results, { [failed.url]: "HTTP 403" });
    expect(session.status, session.error).toBe("COMPLETED");
    expect(fetched).toHaveLength(3);
    expect(fetched).toContain(alternate.url);
    expect(fetched).not.toContain(redundant.url);
  });
  it("never reselects a current-run unavailable URL or invents IVF from IVFFlat metadata", () => {
    const failed = entry("failed.example.org", ivf);
    const alias = entry(
      "alias.example.org",
      "IVFFlat query latency is 20 milliseconds in the documented vector indexing benchmark workload.",
    );
    const selection = selectResearchSourcesWithDecisions(
      rankResults(question, [failed, alias]),
      [],
      2,
      "none",
      question,
      undefined,
      true,
      {
        comparison: comparisonObjective(question)!,
        neededTargets: ["IVF"],
        usedDomains: [],
        unavailableUrls: [failed.url],
      },
    );
    expect(selection.selected.some((source) => source.url === failed.url)).toBe(false);
    expect(
      selection.decisions.find((decision) => decision.url === alias.url)?.acquisition?.targetLeads,
    ).toEqual([]);
  });
  it("zero remaining capacity cannot reserve an official source outside the budget", () => {
    const selection = selectResearchSourcesWithDecisions(
      rankResults("Compare React and Flutter latency", [
        {
          title: "React latency documentation",
          url: "https://react.dev/learn",
          snippet: "React latency is lower in this documented benchmark workload.",
        },
      ]),
      ["React", "Flutter"],
      0,
      "preferred",
    );
    expect(selection.selected).toEqual([]);
  });
});
