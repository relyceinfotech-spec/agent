import { describe, expect, it } from "vitest";
import type { Claim, SearchResult } from "../src/domain.js";
import { ResearchRunner } from "../src/research.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { MemorySessionStore } from "../src/store.js";

const result: SearchResult = {
  title: "Primary evidence",
  url: "https://example.com/evidence",
  snippet: "Evidence about React Native and Flutter performance",
};
const claim: Claim = {
  id: "claim-1",
  text: "The benchmark reports a measurable performance difference.",
  sourceIds: ["source-id"],
  evidence: "The benchmark reports a measurable performance difference.",
  confidence: 0.8,
};

describe("autonomous research loop", () => {
  it("observes tool results, verifies claims, and synthesizes", async () => {
    const calls: string[] = [];
    const tools = new ToolRegistry();
    for (const name of [
      "web_search",
      "search_again",
      "fetch_url",
      "extract_content",
      "extract_claims",
      "gather_evidence",
      "verify_claim",
      "detect_conflict",
      "synthesize",
    ])
      tools.register({
        name,
        description: name,
        execute: async () => {
          calls.push(name);
          if (name === "web_search" || name === "search_again") return [result];
          if (name === "fetch_url") return { url: result.url, html: "<article>Evidence</article>" };
          if (name === "extract_content")
            return {
              title: result.title,
              content:
                "A sufficiently long evidence sentence describing a measurable performance difference in the benchmark results.",
            };
          if (name === "extract_claims") return [claim, { ...claim, id: "claim-2" }];
          if (name === "verify_claim")
            return { verdict: "supported", rationale: "The evidence supports the claim." };
          if (name === "synthesize") return "Cited answer";
          return [];
        },
      });
    const store = new MemorySessionStore();
    const runner = new ResearchRunner(store, { search: async () => [result] }, undefined, tools);
    const session = await runner.start("Compare React Native vs Flutter performance", "deep");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await store.get(session.id);
      if (current?.status === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = await store.get(session.id);
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.answer).toContain("OpenRouter");
    expect(completed?.claims[0].verification?.verdict).toBe("supported");
    expect(calls).toEqual(
      expect.arrayContaining([
        "web_search",
        "fetch_url",
        "extract_claims",
        "gather_evidence",
        "verify_claim",
        "detect_conflict",
      ]),
    );
  });
});
