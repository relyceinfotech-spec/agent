import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { config } from "../src/config.js";
import type {
  Claim,
  LatestnessAssessment,
  ResearchPlan,
  ResearchSession,
  ResearchState,
  ReleaseEvidenceRecord,
  Source,
} from "../src/domain.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { auditResearchCitations, OpenRouterProvider } from "../src/llm.js";
import { requestedFactCoverage } from "../src/requested-facts.js";
import {
  parseStructuredResearchAnswer,
  renderStructuredResearchAnswer,
} from "../src/research-answer.js";
import { createServer } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";

const question =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";
const expectedLatest = "The latest stable release of React is version 19.3.0.";
const expectedDate = "React 19.3.0 was released on September 9, 2026.";
const auth = { userId: "react-answer-owner", accessToken: "react-answer-owner-token" };
const previousApiKey = config.OPENROUTER_API_KEY;

function fixture() {
  const source: Source = {
    id: "react-release-history",
    title: "React official release history",
    url: "https://github.com/react/react/releases",
    domain: "github.com",
    snippet: "Official stable React releases.",
    content:
      "React 19.3.0 | release date: 2026-09-09 | status: stable\nReact 19.2.0 | release date: 2025-10-01 | status: stable",
    sourceType: "official",
    firstPartyClassification: {
      entity: "React",
      repository: "react/react",
      contentKind: "release_history",
    },
    releaseHistoryComplete: true,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
  const record: ReleaseEvidenceRecord = {
    entity: "React",
    version: "19.3.0",
    releaseDate: "2026-09-09",
    dateAssociationReason: "versioned-release-statement",
    releaseDateExplicit: true,
    releaseDateEvidence: "React 19.3.0 | release date: 2026-09-09",
    releaseDateSourceIds: [source.id],
    releaseDateClaimIds: ["claim-react-date"],
    stability: "stable",
    stabilityReason: "stable-release-list",
    stabilityEvidence: "React 19.3.0 | status: stable",
    stabilitySourceIds: [source.id],
    sourceId: source.id,
    sourceIds: [source.id],
    claimIds: ["claim-react-date"],
    sourceType: "official",
    officialSource: true,
    firstPartyClassification: source.firstPartyClassification,
    releaseHistoryComplete: true,
  };
  const assessment: LatestnessAssessment = {
    required: true,
    conclusion: "PROVEN",
    proof: "complete-official-history",
    proofEvidence:
      "19.3.0 is newer than every other eligible stable React release in the complete official history.",
    requestedEntity: "React",
    highestCandidateVersion: "19.3.0",
    latestVersion: "19.3.0",
    candidateVersions: [],
    releaseRecords: [record],
    comparisons: [{ olderVersion: "19.2.0", newerVersion: "19.3.0", sourceIds: [source.id] }],
    supportingSourceIds: [source.id],
    completeHistorySourceIds: [source.id],
    releaseHistoryResolution: {
      attemptedKinds: ["github_releases_html"],
      selectedKind: "github_releases_html",
      recordCount: 2,
      complete: true,
      sourceIds: [source.id],
    },
    unresolvedReasons: [],
  };
  const claim: Claim = {
    id: "claim-react-date",
    text: expectedDate,
    evidence: "React 19.3.0 | release date: 2026-09-09 | status: stable",
    sourceIds: [source.id],
    confidence: 1,
    requestedFacts: ["release date"],
    verification: { verdict: "supported" },
  };
  const plan: ResearchPlan = {
    objectives: ["Identify latest stable React release and release date"],
    requestedFacts: ["version", "release date", "stable status", "latestness"],
    requestedFactRequirements: {
      version: true,
      releaseDate: true,
      releaseStatus: false,
      stable: true,
      latest: true,
      endOfLifeDate: false,
      price: false,
      technicalValue: false,
    },
    queries: ["official React release history"],
    queryGroups: [],
    interpretation: {
      normalizedQuestion: question,
      intent: "research",
      entities: ["React"],
      topic: "latest stable React release",
      dimensions: ["version", "release date"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
      sourceRequirements: { officialSources: "required" },
    },
  };
  const state: ResearchState = {
    objectives: [],
    completedObjectives: [plan.objectives[0]!],
    missingObjectives: [],
    queries: plan.queries,
    sources: [source],
    claims: [claim],
    conflicts: [],
    verifiedClaims: [claim],
    coverage: 1,
    requestedFactCoverage: {
      required: plan.requestedFacts,
      present: plan.requestedFacts,
      missing: [],
    },
    latestnessAssessment: assessment,
    releaseRecords: [record],
  };
  return { source, record, assessment, claim, plan, state };
}

function response(statements: Array<{ text: string; sourceIds?: string[] }>) {
  return JSON.stringify({
    statements: statements.map((statement) => ({
      text: statement.text,
      sourceIds: statement.sourceIds ?? ["react-release-history"],
    })),
  });
}

function validModelResponse() {
  return response([{ text: expectedLatest }, { text: expectedDate }]);
}

function makeModel() {
  return new OpenRouterProvider({ maxAttempts: 1 });
}

afterEach(() => {
  config.OPENROUTER_API_KEY = previousApiKey;
  vi.restoreAllMocks();
});

describe("provider-free synthesis resilience", () => {
  it("accepts compact structured synthesis when all verified facts and citations survive", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    const complete = vi.spyOn(provider, "complete").mockResolvedValue(validModelResponse());

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis).toMatchObject({
      attempted: true,
      fallbackUsed: false,
      finalAnswerSource: "model",
      requiredFactCoverage: { missing: [] },
      evidenceFactCoverage: { missing: [] },
      citationValidationResult: "VALIDATED",
    });
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      maxCompletionTokens: 1024,
      responseFormat: { type: "json_object" },
      purpose: "research_synthesis",
    });
    expect(complete.mock.calls[0]?.[2]?.responseValidator).toBeTypeOf("function");
    expect(complete.mock.calls[0]?.[1]).toContain("Verified answer skeleton");
  });

  it("rejects malformed synthesis and uses the complete deterministic answer", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    vi.spyOn(provider, "complete").mockResolvedValue("not json");

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis).toMatchObject({
      failureCategory: "MALFORMED_RESPONSE",
      fallbackUsed: true,
      finalAnswerSource: "deterministic",
      citationValidationResult: "VALIDATED",
    });
  });

  it("falls back when synthesis is truncated or exhausts its output budget", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    vi.spyOn(provider, "complete").mockRejectedValue(
      new Error("OpenRouter completion exceeded the output-token budget"),
    );

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis).toMatchObject({
      failureCategory: "TRUNCATED",
      fallbackUsed: true,
      finalAnswerSource: "deterministic",
    });
  });

  it.each([
    ["stable status", [expectedDate, "React 19.3.0 is the latest release."]],
    ["latestness", [expectedDate, "React 19.3.0 is a stable release."]],
    ["release date", [expectedLatest]],
    ["version", ["The latest stable React release has an official release date."]],
  ])("falls back when model text omits requested %s", async (_missing, lines) => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    vi.spyOn(provider, "complete").mockResolvedValue(response(lines.map((text) => ({ text }))));

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis?.fallbackUsed).toBe(true);
    expect(provider.metrics.synthesis?.requiredFactCoverage.missing).toEqual([]);
  });

  it("rejects duplicate or incomplete statement arrays", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    vi.spyOn(provider, "complete").mockResolvedValue(
      response([{ text: expectedLatest }, { text: expectedLatest }]),
    );

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis?.failureCategory).toBe("MALFORMED_RESPONSE");
    expect(provider.metrics.synthesis?.fallbackUsed).toBe(true);
  });

  it("records a provider 429 and completes through the deterministic fallback", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    const { plan, source, claim, state } = fixture();
    vi.spyOn(provider, "complete").mockRejectedValue(new Error("OpenRouter returned 429"));

    const answer = await provider.synthesize(question, plan, [source], [claim], state);

    expect(answer).toContain(expectedLatest);
    expect(answer).toContain(expectedDate);
    expect(provider.metrics.synthesis).toMatchObject({
      failureCategory: "RATE_LIMIT",
      fallbackUsed: true,
      finalAnswerSource: "deterministic",
      citationValidationResult: "VALIDATED",
    });
  });

  it("fails closed when latestness is unresolved even if the model proposes all facts", async () => {
    config.OPENROUTER_API_KEY = "";
    const provider = makeModel();
    const { plan, source, claim, state, assessment } = fixture();
    const unresolvedState: ResearchState = {
      ...state,
      latestnessAssessment: {
        ...assessment,
        conclusion: "CANDIDATE_ONLY",
        proof: undefined,
        proofEvidence: undefined,
        latestVersion: undefined,
        unresolvedReasons: ["incomplete_official_history"],
      },
      requestedFactCoverage: {
        required: plan.requestedFacts,
        present: ["version", "release date", "stable status"],
        missing: ["latestness"],
      },
    };
    const complete = vi.spyOn(provider, "complete").mockResolvedValue(validModelResponse());

    const answer = await provider.synthesize(question, plan, [source], [claim], unresolvedState);

    expect(complete).not.toHaveBeenCalled();
    expect(answer).not.toContain("latest stable release");
    expect(answer).toContain("Insufficient evidence");
    expect(provider.metrics.synthesis).toMatchObject({
      attempted: false,
      failureCategory: "EVIDENCE_INCOMPLETE",
      finalAnswerSource: "deterministic",
      evidenceFactCoverage: { missing: ["latestness"] },
    });
  });

  it("requires source IDs to be known, unique, official when required, and non-duplicated", () => {
    expect(() => parseStructuredResearchAnswer("{broken", ["react-release-history"])).toThrow();
    expect(() =>
      parseStructuredResearchAnswer(response([{ text: expectedLatest, sourceIds: ["unknown"] }]), [
        "react-release-history",
      ]),
    ).toThrow(/invalid source IDs/);
    expect(() =>
      parseStructuredResearchAnswer(
        response([{ text: expectedLatest }]),
        ["react-release-history"],
        [],
        true,
      ),
    ).toThrow(/non-official/);
  });

  it("binds controller-generated citations to exact statement text and source IDs", async () => {
    const { source } = fixture();
    const fallback = renderStructuredResearchAnswer(
      [{ text: expectedLatest, sourceIds: [source.id] }],
      [source],
    );
    const { validateCitationEntailment } = await import("../src/citation-entailment.js");
    const report = await validateCitationEntailment(fallback, [source], undefined, [
      { text: expectedLatest, sourceIds: [source.id] },
    ]);
    expect(report.status).toBe("VALIDATED");
    expect(report.items[0]).toMatchObject({ method: "controller_verified", verdict: "SUPPORTED" });
    expect(
      await validateCitationEntailment(fallback, [source], undefined, [
        { text: expectedLatest, sourceIds: ["different-source"] },
      ]),
    ).toMatchObject({ status: "REJECTED" });
  });
});

describe("canonical React synthesis owner-readback fixture", () => {
  it("persists the four verified facts only after citation validation and reads them as the owner", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = makeModel();
    vi.spyOn(provider, "complete").mockRejectedValue(new Error("OpenRouter returned 429"));
    const { plan, source, claim, state } = fixture();
    const answer = await provider.synthesize(question, plan, [source], [claim], state);
    const coverage = requestedFactCoverage(question, [answer]);
    expect(coverage.missing).toEqual([]);
    expect(provider.metrics.citationEntailment?.status).toBe("VALIDATED");
    expect(auditResearchCitations(answer, 1)).toEqual({ invalidMarkers: [], uncitedSentences: [] });

    const store = new SqliteSessionStore(":memory:");
    const app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      authVerifier: {
        verifyAccessToken: async (token) =>
          token === auth.accessToken ? { id: auth.userId } : undefined,
      },
    });
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: randomUUID(),
      question,
      mode: "quick",
      status: "COMPLETED",
      createdAt: now,
      updatedAt: now,
      plan,
      sources: [source],
      claims: [claim],
      state,
      answer,
      steps: [],
    };
    try {
      await withAuthenticatedUser(auth, () => store.create(session));
      const readback = await app.inject({
        method: "GET",
        url: `/api/research/${session.id}`,
        headers: { authorization: `Bearer ${auth.accessToken}` },
      });
      expect(readback.statusCode).toBe(200);
      const saved = readback.json<ResearchSession>();
      expect(saved.status).toBe("COMPLETED");
      expect(saved.answer).toContain(expectedLatest);
      expect(saved.answer).toContain(expectedDate);
      expect(requestedFactCoverage(question, [saved.answer ?? ""]).missing).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
