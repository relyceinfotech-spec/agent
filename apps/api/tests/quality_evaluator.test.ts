import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Source } from "../src/domain.js";
import {
  classifyOpenRouterFailure,
  detectVersionTerminologyError,
  evaluateClaims,
  evaluateCitations,
  isEvaluationBudgetExhausted,
  isEvidenceInsufficiencyResponse,
  isOfficialPrimarySourceDomain,
  writeQualityReports,
  type QualitySmokeReport,
} from "../src/evaluation/quality.js";

const releaseSource: Source = {
  id: "react-versions",
  title: "React Versions",
  url: "https://react.dev/versions",
  domain: "react.dev",
  snippet: "Latest version: 19.3.0",
  content: "Latest version: 19.3.0. React 19.3 is a minor release of React 19.",
  quality: {
    relevance: 1,
    authority: 1,
    freshness: 1,
    completeness: 1,
    overall: 1,
  },
};

describe("quality evaluator release terminology", () => {
  it("recognizes official package registries without accepting deceptive suffixes", () => {
    expect(isOfficialPrimarySourceDomain("registry.npmjs.org")).toBe(true);
    expect(isOfficialPrimarySourceDomain("cdn.registry.npmjs.org")).toBe(true);
    expect(isOfficialPrimarySourceDomain("github.com")).toBe(false);
    expect(isOfficialPrimarySourceDomain("github.com.attacker.example")).toBe(false);
    expect(isOfficialPrimarySourceDomain("registry.npmjs.org.attacker.example")).toBe(false);
    expect(isOfficialPrimarySourceDomain("notreact.dev.example")).toBe(false);
  });

  it("recognizes an explicit evidence-insufficiency response without treating it as a factual claim", () => {
    expect(
      isEvidenceInsufficiencyResponse(
        "Research collected evidence but cannot present it as sufficiently verified: coverage is 50%.",
      ),
    ).toBe(true);
    expect(isEvidenceInsufficiencyResponse("React 19.3 is the latest version [1].")).toBe(false);
    expect(
      isEvidenceInsufficiencyResponse(
        "Research reached its bounded 8-step budget with 8 claims. Review the evidence and sources collected.",
      ),
    ).toBe(true);
    expect(
      isEvidenceInsufficiencyResponse("Research ended without enough extractable evidence."),
    ).toBe(true);
  });

  it("attributes provider rate limits to infrastructure rather than model quality", () => {
    expect(classifyOpenRouterFailure("OpenRouter returned 429")).toBe("OPENROUTER_RATE_LIMIT");
    expect(classifyOpenRouterFailure("OpenRouter returned 503")).toBe("OPENROUTER_FAILURE");
    expect(classifyOpenRouterFailure("OpenRouter request timed out")).toBe("TIMEOUT");
    expect(
      classifyOpenRouterFailure(
        "Batch verification provider failed: OpenRouter completion exceeded the output-token budget",
      ),
    ).toBe("OPENROUTER_FAILURE");
    expect(classifyOpenRouterFailure("unrelated parsing error")).toBeUndefined();
  });

  it("rejects a semantically wrong major-version claim despite high text overlap", () => {
    const answer = "The official React page marks 19.3 as the latest major version [1].";
    expect(evaluateCitations(answer, [releaseSource]).citationPrecision).toBe(1);
    const claims = evaluateClaims(answer, [releaseSource], []);
    expect(claims[0].verdict).toBe("CONTRADICTED");
    expect(claims[0].rationale).toContain("mislabeled as a major version");
  });

  it("does not reject a correctly described minor release", () => {
    const answer = "React 19.3 is a minor release of major version 19 [1].";
    expect(detectVersionTerminologyError(answer)).toBeUndefined();
    expect(evaluateClaims(answer, [releaseSource], [])[0].verdict).toBe("SUPPORTED");
  });

  it("does not call an uncited research assertion grounded from unrelated corpus words", () => {
    const answer =
      "React is widely used by product teams today. Teams should migrate immediately because its new release is universally faster.";
    const claims = evaluateClaims(answer, [releaseSource], []);
    expect(claims).toHaveLength(2);
    expect(claims.every((claim) => claim.verdict === "UNSUPPORTED")).toBe(true);
    expect(claims[0].supportingSourceIds).toEqual([]);
  });

  it("recognizes a cited sentence that repeats a verified claim from its cited source", () => {
    const verified = {
      id: "react-version-claim",
      text: "React 19.3 is a minor release of major version 19.",
      evidence: "React 19.3 is a minor release of major version 19.",
      sourceIds: [releaseSource.id],
      confidence: 1,
      verification: { verdict: "supported" as const },
    };
    const evaluated = evaluateClaims(
      "For clarity, React 19.3 is a minor release of major version 19 [1].",
      [releaseSource],
      [verified],
    );
    expect(evaluated[0].verdict).toBe("SUPPORTED");
    expect(evaluated[0].supportingSourceIds).toEqual([releaseSource.id]);
  });

  it("does not classify a major-only version as a minor release", () => {
    expect(detectVersionTerminologyError("Major version 19 is current.")).toBeUndefined();
    expect(detectVersionTerminologyError("Major version 19.0 is current.")).toBeUndefined();
  });
});

describe("quality evaluation report history", () => {
  function report(timestamp: string): QualitySmokeReport {
    return {
      timestamp,
      model: "test/model",
      searchProvider: "serper",
      searchConfigured: true,
      configuredBudget: {
        maxSteps: 16,
        maxQueries: 6,
        maxSources: 6,
        maxPages: 4,
        maxClaimsToVerify: 4,
        maxTimeMs: 120000,
        maxModelDecisions: 4,
        maxSearchPasses: 2,
        openRouterRequestTimeoutMs: 45000,
        evaluatorWaitTimeoutMs: 120000,
        maxCases: 5,
      },
      totalCases: 0,
      passedCases: 0,
      overallPassed: false,
      metrics: {
        avgCitationPrecision: 0,
        avgCitationGroundedRate: 0,
        avgUnsupportedClaimRate: 0,
        avgObjectiveCoverage: 0,
        avgDurationSec: 0,
        totalFabricatedCitations: 0,
        totalCriticalUnsupportedClaims: 0,
        infrastructureFailures: 0,
        modelQualityFailures: 0,
        llmCalls: 0,
        llmFailures: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        reportedCostUsd: 0,
      },
      cases: [],
    };
  }

  it("archives the previous report before replacing the latest report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "max-quality-eval-"));
    const first = report("2026-09-24T12:00:00.000Z");
    const second = report("2026-09-24T12:01:00.000Z");

    try {
      const firstPaths = await writeQualityReports(first, directory);
      const secondPaths = await writeQualityReports(second, directory);
      const archivedFirst = await readFile(firstPaths.runJson, "utf8");
      const latest = await readFile(secondPaths.latestJson, "utf8");
      const latestMarkdown = await readFile(secondPaths.latestMarkdown, "utf8");
      const files = await readdir(directory);

      expect(JSON.parse(archivedFirst).timestamp).toBe(first.timestamp);
      expect(JSON.parse(latest).timestamp).toBe(second.timestamp);
      expect(JSON.parse(latest).configuredBudget.maxPages).toBe(4);
      expect(latestMarkdown).toContain(
        "**Configured Budget**: 16 steps, 6 queries, 6 sources, 4 pages",
      );
      expect(files).toContain("quality-smoke-report.json");
      expect(files).toContain("quality-smoke-run-2026-09-24T12-00-00-000Z.json");
      expect(files).toContain("quality-smoke-run-2026-09-24T12-01-00-000Z.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("quality evaluation budget diagnosis", () => {
  const defaultBudget = {
    maxSteps: 8,
    maxQueries: 3,
    maxSources: 2,
    maxPages: 1,
    maxClaimsToVerify: 4,
    maxTimeMs: 75000,
    maxModelDecisions: 4,
    maxSearchPasses: 2,
  };

  it("classifies an exhausted fetched-page ceiling as a harness limit", () => {
    const session = {
      sources: [releaseSource],
      steps: [],
      searchAttempts: [],
    };
    expect(isEvaluationBudgetExhausted(session, defaultBudget)).toBe(true);
    expect(isEvaluationBudgetExhausted(session, { ...defaultBudget, maxPages: 2 })).toBe(false);
  });

  it("recognizes query and explicit step-budget exhaustion", () => {
    const session = {
      sources: [],
      steps: [{ label: "🛑 budget exhausted" }],
      searchAttempts: [
        {
          provider: "serper",
          query: "query",
          status: "success" as const,
          resultCount: 2,
          durationMs: 10,
        },
      ],
    };
    expect(isEvaluationBudgetExhausted(session, defaultBudget)).toBe(true);
    expect(
      isEvaluationBudgetExhausted(session, { ...defaultBudget, maxSteps: 1, maxPages: 2 }),
    ).toBe(true);
  });
});
