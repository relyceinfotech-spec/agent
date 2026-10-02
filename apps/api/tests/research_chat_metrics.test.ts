import { describe, expect, it } from "vitest";
import type { ResearchDecision, Source } from "../src/domain.js";
import {
  researchActionsUsed,
  researchChatRetrievalMetrics,
} from "../src/evaluation/research-chat-metrics.js";

function source(overrides: Partial<Source>): Source {
  return {
    id: "source-1",
    title: "Node.js release schedule",
    url: "https://nodejs.org/en/about/previous-releases",
    snippet: "",
    domain: "nodejs.org",
    quality: {
      relevance: 1,
      authority: 1,
      freshness: 1,
      completeness: 1,
      overall: 1,
    },
    ...overrides,
  };
}

function decision(nextAction: string): ResearchDecision {
  return {
    id: nextAction,
    at: "2026-10-01T00:00:00.000Z",
    controllerDecision: "fallback",
    nextAction,
    reason: "test",
  };
}

describe("Research Chat smoke budget and retrieval metrics", () => {
  it("counts research actions separately from activity events and final synthesis", () => {
    const decisions = [
      decision("web_search"),
      decision("source_triage"),
      decision("fetch_url"),
      decision("extract_claims"),
      decision("gather_evidence"),
      decision("verify_claims"),
      decision("detect_conflicts"),
      decision("synthesize"),
    ];

    expect(researchActionsUsed(decisions)).toBe(7);
    expect(decisions.length).toBe(8);
  });

  it("does not count a Serper snippet as a fetched page", () => {
    const metrics = researchChatRetrievalMetrics([
      source({
        content: "Node.js 22 reaches end of life on 2027-04-30.",
        retrievalMethod: "serper_snippet",
        retrievalAttempts: ["serper_snippet"],
      }),
    ]);

    expect(metrics).toEqual({
      evidenceContentSources: 1,
      snippetEvidenceSources: 1,
      pageRetrievalSources: 0,
      unknownMethodSources: 0,
    });
  });

  it("reports one page and one snippet separately after a bounded recovery search", () => {
    const metrics = researchChatRetrievalMetrics([
      source({
        id: "initial-page",
        url: "https://nodejs.org/en/about/previous-releases",
        content:
          "Node.js 22 entered Maintenance LTS in October 2024. The official support schedule describes lifecycle phases and dates for each major release.",
        retrievalMethod: "http",
        retrievalAttempts: ["serper_snippet", "http"],
      }),
      source({
        id: "recovery-snippet",
        url: "https://nodejs.org/en/about/releases",
        content: "Node.js 22 reaches end of life on 2027-04-30.",
        retrievalMethod: "serper_snippet",
        retrievalAttempts: ["serper_snippet"],
      }),
    ]);

    expect(metrics).toEqual({
      evidenceContentSources: 2,
      snippetEvidenceSources: 1,
      pageRetrievalSources: 1,
      unknownMethodSources: 0,
    });
  });

  it("counts real retrievals and failed page attempts independently of evidence content", () => {
    const metrics = researchChatRetrievalMetrics([
      source({
        url: "https://nodejs.org/about/releases",
        content: "Node.js 22 reaches end of life on 2027-04-30.",
        retrievalMethod: "http",
        retrievalAttempts: ["serper_snippet", "rss", "http"],
      }),
      source({
        id: "failed-source",
        url: "https://nodejs.org/en/about/old-releases",
        fetchError: "HTTP 503",
        retrievalAttempts: ["serper_snippet", "http"],
      }),
      source({
        id: "unknown-source",
        url: "https://example.test/unknown",
        content: "Some content without retrieval provenance.",
      }),
    ]);

    expect(metrics).toEqual({
      evidenceContentSources: 2,
      snippetEvidenceSources: 0,
      pageRetrievalSources: 2,
      unknownMethodSources: 1,
    });
  });
});
