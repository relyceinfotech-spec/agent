import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../src/agent/tools.js";
import { extractHtml } from "../src/extract.js";
import {
  comparisonCoverage,
  comparisonEvidencePassages,
  comparisonObjective,
} from "../src/comparison-evidence.js";
import { querySubjectMismatchReason } from "../src/query-relevance.js";
import { OpenRouterProvider } from "../src/llm.js";
import { rankResults } from "../src/rank.js";
import { ResearchRunner } from "../src/research.js";
import { SqliteSessionStore } from "../src/store.js";
import type { Claim, Source } from "../src/domain.js";

const question = "Compare current Aster and Beryl vector indexing performance";
const a =
  "Using a graph-based structure, this method provides lower search latency in the documented vector indexing workload.";
const b =
  "Inverted-file search reduces query latency by examining fewer vectors in the documented vector indexing workload.";
const html = (body: string) =>
  `<html><head><title>Aster and Beryl vector indexing performance</title></head><body><article>${body}</article></body></html>`;
const scopedArticle = html(`<h2>Aster</h2><p>${a}</p><h2>Beryl</h2><p>${b}</p>`);
function provider() {
  const llm = new OpenRouterProvider();
  vi.spyOn(llm, "enabled", "get").mockReturnValue(false);
  return llm;
}
async function pipeline(body: string, request = question) {
  const document = extractHtml(body, new URL("https://fixture.example.org/article"));
  const objective = comparisonObjective(request)!;
  const passages = comparisonEvidencePassages(objective, document.content);
  const retained = passages.filter((passage) => !querySubjectMismatchReason(request, passage));
  const source = {
    ...rankResults(request, [
      {
        title: document.title,
        url: "https://fixture.example.org/article",
        snippet: document.title,
      },
    ])[0]!,
    content: retained.join("\n\n"),
  } as Source;
  const tools = createToolRegistry({ search: async () => [] }, provider());
  const claims = (await tools.execute("extract_claims", {
    question: request,
    sources: [source],
    requestedFacts: [],
    researchChatOptimization: true,
  })) as Claim[];
  for (const claim of claims) {
    expect(claim.sourceIds).toEqual([source.id]);
    expect(source.content).toContain(claim.evidence);
    claim.verification = { verdict: "supported", rationale: "Exact local source-bound fixture" };
  }
  return {
    document,
    passages,
    retained,
    source,
    claims,
    coverage: comparisonCoverage(objective, claims),
  };
}

describe("article structure to comparison evidence attribution", () => {
  const vectorQuestion = "Compare HNSW and IVF vector indexing on latency";
  it("uppercase coordinated subjects remain a broad heading", async () => {
    const result = await pipeline(
      html(
        `<h2>HNSW PERFORMANCE AND IVFFLAT</h2><p>This approach achieves lower query latency in the documented vector indexing workload.</p><p>The technical study documents workload limitations without additional measured findings.</p>`,
      ),
      vectorQuestion,
    );
    expect(result.claims).toEqual([]);
  });
  it("coordinated dimension labels do not erase an unambiguous target heading", async () => {
    const result = await pipeline(
      html(
        `<h2>HNSW Recall and Memory</h2><p>This approach achieves lower query latency in the documented vector indexing workload.</p><p>The technical study documents workload limitations without additional measured findings.</p>`,
      ),
      vectorQuestion,
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toMatch(/^HNSW Recall and Memory /);
  });
  it("a broad section cannot bind an implicit continuation through a sentence naming a competing source subject", async () => {
    const result = await pipeline(
      html(
        `<h2>IVFFlat and HNSW</h2><p>IVFFlat differs from HNSW in graph structure during vector indexing. It requires less memory in the documented vector indexing workload.</p>`,
      ),
      "Compare HNSW and IVF vector indexing on memory",
    );
    expect(result.claims).toEqual([]);
    expect(result.passages).toContain(
      "It requires less memory in the documented vector indexing workload.",
    );
  });
  it.each(["IVF", "HNSW"])(
    "a mixed-name broad heading leaves an explicit %s child bound only to itself",
    async (target) => {
      const result = await pipeline(
        html(
          `<h2>IVFFlat and HNSW</h2><p>${target} query latency is 10 milliseconds in the documented vector indexing workload.</p><p>The technical study documents workload limitations without additional measured findings.</p>`,
        ),
        vectorQuestion,
      );
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]?.text).toBe(
        `${target} query latency is 10 milliseconds in the documented vector indexing workload.`,
      );
      expect(result.coverage.cells.find((cell) => cell.target === target)?.claimIds).toEqual([
        result.claims[0]!.id,
      ]);
      expect(result.coverage.cells.find((cell) => cell.target !== target)?.claimIds).toEqual([]);
    },
  );
  it.each(["This method", "This approach", "In some cases"])(
    "a mixed-name broad heading does not bind an implicit '%s' finding",
    async (subject) => {
      const result = await pipeline(
        html(
          `<h2>IVFFlat and HNSW</h2><p>${subject} achieves lower query latency in the documented vector indexing workload.</p>`,
        ),
        vectorQuestion,
      );
      expect(result.claims).toEqual([]);
    },
  );
  it("does not turn the recorded IVFFlat-only parallel build finding into HNSW or an invented IVF alias", async () => {
    const finding =
      "In some cases, along with giving more memory, you can speed up index build time further by building an index in parallel (only available with IVFFlat as of this writing).";
    const result = await pipeline(
      html(
        `<h2>Implementation and performance results using sequential scan, IVFFlat, and HNSW indexes</h2><p>${finding}</p>`,
      ),
      "Compare HNSW and IVF vector indexing performance",
    );
    expect(result.passages).toEqual([finding]);
    expect(result.claims).toEqual([]);
  });
  it("an explicit child target later in a broad section wins without inheriting the heading", async () => {
    const result = await pipeline(
      html(
        `<h2>IVFFlat and HNSW</h2><p>This approach provides lower query latency in an unspecified vector indexing workload.</p><p>IVF query latency is 20 milliseconds in the documented vector indexing workload.</p>`,
      ),
      vectorQuestion,
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toMatch(/^IVF query/);
    expect(result.claims[0]?.text).not.toContain("HNSW");
  });
  it.each(["IVFFlat and HNSW", "IVFFlat, and HNSW", "IVFFlat / HNSW", "IVFFlat vs HNSW"])(
    "a broad nested heading '%s' blocks the parent and neutral dimension subheading",
    async (heading) => {
      const result = await pipeline(
        html(
          `<h2>HNSW</h2><h3>${heading}</h3><h4>Query latency</h4><p>This method achieves lower query latency in the documented vector indexing workload.</p>`,
        ),
        vectorQuestion,
      );
      expect(result.claims).toEqual([]);
    },
  );
  it("an unambiguous local target subsection restores context beneath a broad heading", async () => {
    const result = await pipeline(
      html(
        `<h2>IVFFlat and HNSW</h2><h3>HNSW</h3><h4>Query latency</h4><p>This method achieves lower query latency in the documented vector indexing workload.</p>`,
      ),
      vectorQuestion,
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toMatch(/^HNSW /);
  });
  it("a source-named competing subject blocks inheritance without vector-specific rules", async () => {
    const result = await pipeline(
      html(
        `<h2>Asterine and Beryl</h2><p>This approach achieves lower query latency in the documented vector indexing workload.</p>`,
      ),
    );
    expect(result.claims).toEqual([]);
  });
  it("a blocked heading cannot inherit even when it contains one requested known entity", async () => {
    const result = await pipeline(
      html(
        `<h2>React and HNSW</h2><p>This approach achieves lower query latency in the documented vector indexing workload.</p>`,
      ),
      vectorQuestion,
    );
    expect(result.claims).toEqual([]);
  });
  it("a trailing target clause does not lend its measurement to the relative comparison", () => {
    const text =
      "Compared with Beryl, Aster provides lower latency and Beryl requires 20 gigabytes of memory.";
    const objective = { targets: ["Aster", "Beryl"], dimensions: ["latency", "memory"] };
    const coverage = comparisonCoverage(objective, [
      {
        id: "relative",
        text,
        evidence: text,
        sourceIds: ["fixture"],
        confidence: 1,
        verification: { verdict: "supported" },
      },
    ]);
    expect(
      coverage.cells.find((cell) => cell.target === "Aster" && cell.dimension === "memory")
        ?.claimIds,
    ).toEqual([]);
    expect(
      coverage.cells.find((cell) => cell.target === "Beryl" && cell.dimension === "memory")
        ?.claimIds,
    ).toEqual(["relative"]);
    expect(
      coverage.cells
        .filter((cell) => cell.dimension === "latency")
        .every((cell) => cell.claimIds.length === 1),
    ).toBe(true);
  });
  it("ambiguous table spans are not flattened into false target measurements", async () => {
    const result = await pipeline(
      html(
        `<p>This vector indexing report describes benchmark limitations and does not provide additional findings.</p><table><tr><th>Technique</th><th>Search latency</th><th>Recall</th></tr><tr><td rowspan="2">Aster</td><td>10 milliseconds</td><td>95 percent</td></tr><tr><td>20 milliseconds</td><td>90 percent</td></tr></table>`,
      ),
    );
    expect(result.claims).toEqual([]);
  });
  it("a multi-target subheading blocks inherited single-target context", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><h3>Aster and Beryl</h3><p>These methods reduce query latency in the documented vector indexing workload.</p><p>Both approaches require lower memory in the documented vector indexing workload.</p>`,
      ),
    );
    expect(result.claims).toEqual([]);
  });
  it("plural generic subjects do not inherit even a single-target heading", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><p>These methods reduce query latency in the documented vector indexing workload.</p><p>Both approaches require lower memory in the documented vector indexing workload.</p>`,
      ),
    );
    expect(result.claims).toEqual([]);
  });
  it("an explicit different target overrides the heading for its continuation", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><p>Beryl groups vectors into partitions during vector indexing. This results in lower latency in the documented vector indexing workload.</p><p>The documented workload describes the limitations of measurements for readers.</p>`,
      ),
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toContain("Beryl");
    expect(result.claims[0]?.text).not.toContain("Aster");
  });
  it("a named foreign entity does not inherit target context", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><p>React performance profiling achieves lower latency in the documented workload.</p><p>This means lower memory usage in the unrelated documented workload.</p>`,
      ),
    );
    expect(result.claims).toEqual([]);
  });
  it("a comparison reference without an explicit comparative predicate does not fill both targets", async () => {
    const result = await pipeline(
      html(
        `<p>Compared with Beryl, Aster query latency is 10 milliseconds in the documented vector indexing workload.</p><p>The article explains the limitations of measurements and does not establish additional findings.</p>`,
      ),
    );
    expect(result.coverage.sufficient).toBe(false);
    expect(result.coverage.performanceDimensions?.shared).toEqual([]);
  });
  it("preserves short target headings before relevance filtering", async () => {
    const result = await pipeline(scopedArticle);
    expect(result.document.content).toContain("## Aster");
    expect(result.document.content).toContain("## Beryl");
    expect(result.claims).toHaveLength(2);
    expect(result.coverage.sufficient).toBe(true);
    expect(result.coverage.performanceDimensions?.shared).toContain("latency");
  });
  it("supports bare target headings for only the immediately following paragraph", () => {
    const passages = comparisonEvidencePassages(
      comparisonObjective(question)!,
      `Aster\n\n${a}\n\nThis method requires lower memory in another undocumented context.`,
    );
    expect(passages).toContain(`Aster ${a}`);
    expect(passages).not.toContain(
      "Aster This method requires lower memory in another undocumented context.",
    );
  });
  it.each(["This means", "This results in", "This leads to"])(
    "reaches claim binding and coverage through %s continuation",
    async (prefix) => {
      const result = await pipeline(
        html(
          `<p>Aster connects nearby vectors through a graph during vector indexing. ${prefix} lower latency in the documented vector indexing workload.</p><p>Beryl query latency is lower when fewer partitions are scanned in the documented vector indexing workload.</p>`,
        ),
      );
      expect(result.coverage.sufficient).toBe(true);
      expect(
        result.claims.some(
          (claim) => claim.text.includes(`Aster connects`) && claim.text.includes(prefix),
        ),
      ).toBe(true);
    },
  );
  it("keeps separate requested-target sections and measurements separate", async () => {
    const result = await pipeline(scopedArticle);
    const ac = result.claims.find((claim) => claim.text.includes("Aster"))!;
    const bc = result.claims.find((claim) => claim.text.includes("Beryl"))!;
    expect(ac.text).not.toContain("Beryl");
    expect(bc.text).not.toContain("Aster");
    expect(result.coverage.cells.find((cell) => cell.target === "Aster")?.claimIds).toEqual([
      ac.id,
    ]);
    expect(result.coverage.cells.find((cell) => cell.target === "Beryl")?.claimIds).toEqual([
      bc.id,
    ]);
  });
  it("ends target context at a sibling unrelated heading", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><p>${a}</p><h2>Unrelated benchmark</h2><p>This method achieves lower memory usage in a different vector indexing workload.</p><h2>Beryl</h2><p>${b}</p>`,
      ),
    );
    expect(result.claims.some((claim) => claim.text.includes("lower memory"))).toBe(false);
  });
  it("retains parent target context under a nested dimension heading", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><h3>Query latency</h3><p>${a}</p><h2>Beryl</h2><h3>Query latency</h3><p>${b}</p>`,
      ),
    );
    expect(result.coverage.sufficient).toBe(true);
  });
  it("does not drop repeated findings in different target sections", async () => {
    const result = await pipeline(html(`<h2>Aster</h2><p>${a}</p><h2>Beryl</h2><p>${a}</p>`));
    expect(result.claims).toHaveLength(2);
    expect(result.coverage.sufficient).toBe(true);
  });
  it("retains article list findings under their actual target headings", async () => {
    const result = await pipeline(
      html(`<h2>Aster</h2><ul><li>${a}</li></ul><h2>Beryl</h2><ul><li>${b}</li></ul>`),
    );
    expect(result.coverage.sufficient).toBe(true);
  });
  it("binds simple technical table headers to each target row", async () => {
    const result = await pipeline(
      html(
        `<p>Documented vector indexing benchmark with measured latency and recall on the same workload.</p><table><tr><th>Technique</th><th>Search latency</th><th>Measured recall</th></tr><tr><td>Aster</td><td>10 milliseconds</td><td>95 percent</td></tr><tr><td>Beryl</td><td>20 milliseconds</td><td>90 percent</td></tr></table>`,
      ),
    );
    expect(result.claims).toHaveLength(2);
    expect(result.coverage.sufficient).toBe(true);
    expect(result.claims.find((claim) => claim.text.includes("Aster"))?.text).not.toContain(
      "20 milliseconds",
    );
  });
  it("generic findings under a multi-target overview fill neither target", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster and Beryl</h2><p>These methods reduce search cost and provide lower query latency across vector indexing workloads.</p><p>Vector search can be faster when fewer candidate records are examined in production systems.</p>`,
      ),
    );
    expect(result.claims).toEqual([]);
    expect(result.coverage.cells.every((cell) => !cell.claimIds.length)).toBe(true);
  });
  it("a relative comparison can bind both targets to the explicitly shared axis", async () => {
    const result = await pipeline(
      html(
        `<p>Compared with Beryl, Aster provides lower search latency in the same documented vector indexing workload.</p><p>This technical study documents the workload and its limitations without establishing additional measured performance claims.</p>`,
      ),
    );
    expect(result.coverage.sufficient).toBe(true);
    expect(result.coverage.cells[0]?.claimIds).toEqual(result.coverage.cells[1]?.claimIds);
  });
  it("a heading cannot lend one target's measurement to the other", async () => {
    const result = await pipeline(
      html(
        `<h2>Aster</h2><p>Beryl query latency is 20 milliseconds in the documented vector indexing workload.</p><h2>Limitations</h2><p>This benchmark describes workload limitations and does not establish any measurement for the other technique.</p>`,
      ),
    );
    expect(result.coverage.cells.find((cell) => cell.target === "Aster")?.claimIds).toEqual([]);
    expect(result.claims.every((claim) => !claim.text.includes("Aster"))).toBe(true);
  });
  it("a single supported target finding still fails a broad comparison without a shared axis", async () => {
    const result = await pipeline(
      html(
        `<p>Aster query latency is 10 milliseconds in the documented vector indexing workload.</p><p>This article introduces Beryl vector indexing but does not report its measured performance.</p>`,
      ),
    );
    expect(result.claims).toHaveLength(1);
    expect(result.coverage.performanceDimensions?.observed).toContain("latency");
    expect(result.coverage.performanceDimensions?.shared).toEqual([]);
    expect(result.coverage.cells.every((cell) => cell.claimIds.length === 0)).toBe(true);
  });
  it.each(["AWS-like", "Emergent-Mind-like", "adjacent-results", "adjacent-leads"])(
    "runs %s HTML through the actual extraction tool, runner, verifier binding, synthesis and coverage",
    async (shape) => {
      const llm = provider();
      const store = new SqliteSessionStore(":memory:");
      const request = question.replace("Aster", "HNSW").replace("Beryl", "IVF");
      const article =
        shape === "AWS-like"
          ? scopedArticle.replaceAll("Aster", "HNSW").replaceAll("Beryl", "IVF")
          : shape === "Emergent-Mind-like"
            ? html(
                `<h2>Technical findings for HNSW</h2><ul><li>${a}</li></ul><h2>Technical findings for IVF</h2><ul><li>${b}</li></ul>`,
              )
                .replaceAll("Aster", "HNSW")
                .replaceAll("Beryl", "IVF")
            : html(
                `<p>HNSW links neighboring vectors in a graph during vector indexing. This ${shape === "adjacent-results" ? "results in" : "leads to"} lower query latency in the documented vector indexing workload.</p><p>IVF groups vectors around shared centers during vector indexing. This ${shape === "adjacent-results" ? "results in" : "leads to"} lower query latency in the documented vector indexing workload.</p>`,
              )
                .replaceAll("Aster", "HNSW")
                .replaceAll("Beryl", "IVF");
      const search = {
        search: async () => [
          {
            title: "HNSW and IVF vector indexing performance",
            url: "https://fixture.example.org/article",
            snippet: "HNSW and IVF vector indexing performance latency benchmark workload results.",
          },
        ],
      };
      const tools = createToolRegistry(search, llm, store);
      tools.register({
        name: "fetch_url",
        description: "offline HTML",
        execute: async (input) => ({
          url: (input as { url: string }).url,
          html: article,
          contentType: "text/html",
          retrievalMethod: "http",
        }),
      });
      const expectedPassages = comparisonEvidencePassages(
        comparisonObjective(request)!,
        extractHtml(article, new URL("https://fixture.example.org/article")).content,
      );
      tools.register({
        name: "verify_claim",
        description: "offline source binding",
        execute: async (input) => {
          const value = input as { claim: string; evidence: string; sourceIds: string[] };
          expect(expectedPassages).toContain(value.evidence);
          expect(value.claim).toBe(value.evidence);
          expect(value.sourceIds).toHaveLength(1);
          return { verdict: "supported" };
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
          maxSteps: 14,
          maxSearchPasses: 0,
          maxModelDecisions: 0,
          maxTimeMs: 5000,
        },
        undefined,
        true,
      );
      try {
        await runner.runQueued(shape, request, "quick", [], {
          researchChatOptimization: true,
          allowSnippetEvidence: false,
        });
        const session = (await store.get(shape))!;
        expect(session.status, session.error).toBe("COMPLETED");
        expect(session.state?.comparisonCoverage?.sufficient).toBe(true);
        expect(session.claims).toHaveLength(2);
        expect(session.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(
          true,
        );
      } finally {
        store.close();
      }
    },
  );
});
