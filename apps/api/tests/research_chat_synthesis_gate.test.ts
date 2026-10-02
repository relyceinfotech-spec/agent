import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import type { Claim, ResearchPlan, Source } from "../src/domain.js";
import { OpenRouterProvider } from "../src/llm.js";

const question =
  "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";
const previousApiKey = config.OPENROUTER_API_KEY;

function fixture() {
  const source: Source = {
    id: "node18-eol",
    title: "Node.js 18 EOL announcement",
    url: "https://nodejs.org/en/blog/announcements/node-18-eol-support",
    domain: "nodejs.org",
    snippet: "",
    content: "Node.js 22 is supported, while Node.js 18 reached end of life on 2025-04-30.",
    sourceType: "official",
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
  const claim: Claim = {
    id: "node22-eol-claim",
    text: "Node.js 22 reached end of life on 2025-04-30.",
    evidence: source.content!,
    sourceIds: [source.id],
    requestedFacts: ["end-of-life date"],
    confidence: 1,
    verification: { verdict: "supported" },
  };
  const plan: ResearchPlan = {
    objectives: ["Verify the Node.js 22 end-of-life date"],
    requestedFacts: ["end-of-life date"],
    requestedFactRequirements: {
      version: false,
      releaseDate: false,
      releaseStatus: false,
      stable: false,
      latest: false,
      endOfLifeDate: true,
      price: false,
      technicalValue: false,
    },
    queries: ["Node.js 22 end of life official release schedule"],
    queryGroups: [],
    interpretation: {
      normalizedQuestion: question,
      intent: "research",
      entities: ["Node.js"],
      topic: "Node.js 22 end of life",
      dimensions: ["end-of-life date"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
      sourceRequirements: { officialSources: "required" },
    },
  };
  return { source, claim, plan };
}

afterEach(() => {
  config.OPENROUTER_API_KEY = previousApiKey;
  vi.restoreAllMocks();
});

describe("Research Chat final EOL answer gate", () => {
  it("fails closed when a mixed-version passage binds Node.js 18 EOL evidence to Node.js 22", async () => {
    config.OPENROUTER_API_KEY = "";
    const provider = new OpenRouterProvider({ maxAttempts: 1 });
    const complete = vi.spyOn(provider, "complete");
    const { source, claim, plan } = fixture();

    const answer = await provider.synthesize(
      question,
      plan,
      [source],
      [claim],
      undefined,
      "deep",
      undefined,
      undefined,
      true,
    );

    expect(answer).toMatch(/insufficient evidence/i);
    expect(answer).not.toContain("Node.js 22 reached end of life");
    expect(answer).not.toContain("2025-04-30");
    expect(complete).not.toHaveBeenCalled();
    expect(provider.metrics.synthesis).toMatchObject({
      attempted: false,
      failureCategory: "EVIDENCE_INCOMPLETE",
      finalAnswerSource: "deterministic",
      requiredFactCoverage: { missing: ["end-of-life date"] },
      evidenceFactCoverage: { missing: ["end-of-life date"] },
      citationValidationResult: "VALIDATED",
      requestedFactBindings: [{ outcome: "UNSUPPORTED", verificationStatus: "UNVERIFIED" }],
    });
  });

  it("preserves the required EOL date when model synthesis omits it", async () => {
    config.OPENROUTER_API_KEY = "test-only-key";
    const provider = new OpenRouterProvider({ maxAttempts: 1 });
    const { source: fixtureSource, claim: fixtureClaim, plan } = fixture();
    const source: Source = {
      ...fixtureSource,
      id: "node22-eol",
      content: "Node.js 22 reaches end of life on 2027-04-30.",
    };
    const claim: Claim = {
      ...fixtureClaim,
      id: "node22-eol-verified",
      text: source.content!,
      evidence: source.content!,
      sourceIds: [source.id],
    };
    const complete = vi.spyOn(provider, "complete").mockResolvedValue(
      JSON.stringify({
        statements: [{ text: "Node.js 22 is in Maintenance LTS.", sourceIds: [source.id] }],
      }),
    );

    const answer = await provider.synthesize(
      question,
      plan,
      [source],
      [claim],
      undefined,
      "deep",
      undefined,
      undefined,
      true,
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(answer).toContain("Node.js 22 reaches end of life on 2027-04-30.");
    expect(answer).toContain("[1]");
    expect(provider.metrics.synthesis).toMatchObject({
      fallbackUsed: true,
      finalAnswerSource: "deterministic",
      requiredFactCoverage: { missing: [] },
    });
  });
});
