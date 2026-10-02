import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import type { Claim, ResearchPlan, ResearchState, Source } from "../src/domain.js";
import { auditResearchCitations, decodeOpenRouterJson, OpenRouterProvider } from "../src/llm.js";
import { buildPlan } from "../src/planner.js";
import {
  buildBatchVerificationPrompt,
  createToolRegistry,
  BATCH_VERIFICATION_COMPLETION_TOKENS,
  MAX_BATCH_VERIFICATION_CLAIMS,
  MAX_BATCH_VERIFICATION_PROMPT_BYTES,
  parseBatchVerificationResponse,
} from "../src/agent/tools.js";
import { runWithResearchExecutionContext } from "../src/execution-context.js";

describe("OpenRouter response transport", () => {
  const body = { choices: [{ message: { content: "Grounded answer [1]" } }] };

  it("parses an ordinary JSON response", () => {
    expect(decodeOpenRouterJson(Buffer.from(JSON.stringify(body)))).toEqual(body);
  });

  it("unwraps a gzip body left compressed by an upstream proxy", () => {
    expect(decodeOpenRouterJson(gzipSync(JSON.stringify(body)))).toEqual(body);
    expect(decodeOpenRouterJson(gzipSync(gzipSync(JSON.stringify(body))))).toEqual(body);
  });

  it("rejects excessive nested compression", () => {
    const triple = gzipSync(gzipSync(gzipSync(JSON.stringify(body))));
    expect(() => decodeOpenRouterJson(triple)).toThrow("compression-depth limit");
  });

  it("flags uncited factual sentences and out-of-range citation markers", () => {
    const audit = auditResearchCitations(
      "React Native targets 60 fps [2]. Flutter is universally faster than React Native. Reference [9].",
      2,
    );
    expect(audit.invalidMarkers).toEqual([9]);
    expect(audit.uncitedSentences).toEqual(["Flutter is universally faster than React Native."]);
  });

  it("keeps trailing citations attached while auditing each sentence and list item", () => {
    const audit = auditResearchCitations(
      [
        "This sentence is supported. [1]",
        "The official release date is September 15, 2026. [1][2]",
        "- React 19.2.0 is the latest stable release [2].",
        "Some statements were omitted because the cited evidence did not sufficiently support them.",
      ].join("\n"),
      2,
    );

    expect(audit).toEqual({ invalidMarkers: [], uncitedSentences: [] });
  });

  it("still flags an uncited sentence following a cited sentence on the same line", () => {
    const audit = auditResearchCitations(
      "This sentence is supported. [1] This separate factual sentence has no citation.",
      1,
    );

    expect(audit.uncitedSentences).toEqual(["This separate factual sentence has no citation."]);
  });

  it("replaces an uncited model draft with only verified source findings", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const plan = await buildPlan("Compare React Native and Flutter", "quick", provider);
      const source: Source = {
        id: "official-rn",
        title: "Performance Overview",
        url: "https://reactnative.dev/docs/performance",
        domain: "reactnative.dev",
        snippet: "React Native performance",
        content: "React Native aims for 60 frames per second.",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      };
      const claim: Claim = {
        id: "rn-claim",
        text: "React Native aims for 60 frames per second.",
        evidence: "React Native aims for 60 frames per second.",
        sourceIds: [source.id],
        confidence: 1,
        verification: { verdict: "supported" },
      };
      vi.spyOn(provider, "complete").mockResolvedValue(
        "React Native aims for 60 frames per second [1]. Flutter is always faster for every workload.",
      );
      const answer = await provider.synthesize(
        "Compare React Native and Flutter",
        plan,
        [source],
        [claim],
      );
      expect(answer).toContain("React Native aims for 60 frames per second. [1]");
      expect(answer).not.toContain("always faster");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("passes controller release records and citation-bound latestness into synthesis", async () => {
    const priorKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const question =
        "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";
      const plan = await buildPlan(question, "quick", provider);
      const source: Source = {
        id: "react-release-193",
        title: "React 19.3.0 release announcement",
        url: "https://react.dev/blog/2026/09/09/react-19-3",
        domain: "react.dev",
        sourceType: "official",
        snippet: "React 19.3.0 is the latest stable release, released September 9, 2026.",
        content: "React 19.3.0 is the latest stable release, released September 9, 2026.",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      };
      const claim: Claim = {
        id: "react-release-claim",
        text: "React 19.3.0 is the latest stable release, released September 9, 2026.",
        evidence: source.content!,
        sourceIds: [source.id],
        confidence: 1,
        verification: { verdict: "supported" },
      };
      const releaseRecord = {
        entity: "React",
        version: "19.3.0",
        releaseDate: "2026-09-09",
        pageDate: "2026-09-09",
        dateAssociationReason: "versioned-release-statement" as const,
        releaseDateExplicit: true,
        releaseDateClaimIds: [claim.id],
        releaseDateSourceIds: [source.id],
        stability: "stable" as const,
        stabilityEvidence: "React 19.3.0 is the latest stable release.",
        latestnessEvidence: claim.text,
        sourceId: source.id,
        claimIds: [claim.id],
        sourceType: "official" as const,
        officialSource: true,
      };
      const state = {
        objectives: [],
        completedObjectives: [],
        missingObjectives: [],
        queries: [],
        sources: [source],
        claims: [claim],
        conflicts: [],
        verifiedClaims: [claim],
        coverage: 1,
        releaseRecords: [releaseRecord],
        latestnessAssessment: {
          required: true,
          conclusion: "PROVEN",
          proof: "explicit-official-claim",
          proofEvidence: "React 19.3.0 is supported as latest by official evidence.",
          requestedEntity: "React",
          highestCandidateVersion: "19.3.0",
          latestVersion: "19.3.0",
          candidateVersions: [],
          releaseRecords: [releaseRecord],
          comparisons: [],
          supportingSourceIds: [source.id],
          completeHistorySourceIds: [],
          unresolvedReasons: [],
        },
      } satisfies ResearchState;
      let synthesisInput = "";
      vi.spyOn(provider, "complete").mockImplementation(async (_system, user) => {
        synthesisInput = user;
        return "React 19.3.0 is the latest stable release, released September 9, 2026 [1].";
      });

      await provider.synthesize(question, plan, [source], [claim], state);

      expect(synthesisInput).toContain("CONTROLLER-VALIDATED RELEASE EVIDENCE");
      expect(synthesisInput).toContain("Verified release date: 2026-09-09");
      expect(synthesisInput).toContain("Release stability: stable");
      expect(synthesisInput).toContain("CONTROLLER LATESTNESS ASSESSMENT: PROVEN");
      expect(synthesisInput).toContain("Latest version established by controller: 19.3.0");
      expect(synthesisInput).toContain(
        "Controller-validated latestness evidence: React 19.3.0 is supported as latest by official evidence.",
      );
      expect(synthesisInput).toContain("Supporting sources: [1]");
    } finally {
      config.OPENROUTER_API_KEY = priorKey;
    }
  });

  it("returns only source-linked verified findings when synthesis times out", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const plan = await buildPlan("Compare React Native and Flutter", "quick", provider);
      const source: Source = {
        id: "official-rn",
        title: "Performance Overview",
        url: "https://reactnative.dev/docs/performance",
        domain: "reactnative.dev",
        snippet: "React Native performance",
        content: "React Native aims for 60 frames per second.",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      };
      const claim: Claim = {
        id: "rn-claim",
        text: "React Native aims for 60 frames per second.",
        evidence: "React Native aims for 60 frames per second.",
        sourceIds: [source.id],
        confidence: 1,
        verification: { verdict: "supported" },
      };
      vi.spyOn(provider, "complete").mockRejectedValue(new Error("OpenRouter request timed out"));

      const answer = await provider.synthesize(
        "Compare React Native and Flutter",
        plan,
        [source],
        [claim],
      );

      expect(answer).toContain("React Native aims for 60 frames per second. [1]");
      expect(answer).not.toContain("Flutter is faster");
      expect(provider.metrics.citationEntailment?.status).toBe("VALIDATED");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("does not invent findings when synthesis fails without verified claims", async () => {
    const provider = new OpenRouterProvider();
    const plan = await buildPlan("Compare React Native and Flutter", "quick", provider);
    vi.spyOn(provider, "complete").mockRejectedValue(new Error("OpenRouter request timed out"));

    const answer = await provider.synthesize("Compare React Native and Flutter", plan, [], []);

    expect(answer).toContain("Insufficient evidence to provide a verified answer");
    expect(answer).not.toContain("React Native is");
  });

  it("falls back to exact previously verified findings when semantic draft validation fails", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const source: Source = {
        id: "github-source",
        title: "Large pull request rendering",
        url: "https://github.blog/engineering/large-pull-requests",
        snippet: "Rendering large pull requests",
        domain: "github.blog",
        content:
          "The scheduler waits until the pull request view is idle before measuring visible sections.",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      };
      const verifiedClaim: Claim = {
        id: "claim-1",
        text: "The scheduler waits until the pull request view is idle before measuring visible sections.",
        evidence:
          "The scheduler waits until the pull request view is idle before measuring visible sections.",
        sourceIds: [source.id],
        confidence: 1,
        verification: { verdict: "supported" },
      };
      const plan: ResearchPlan = {
        objectives: ["Explain the rendering approach"],
        requestedFacts: [],
        requestedFactRequirements: {
          version: false,
          releaseDate: false,
          stable: false,
          latest: false,
          endOfLifeDate: false,
          price: false,
          technicalValue: false,
        },
        queries: [],
        queryGroups: [],
        interpretation: {
          normalizedQuestion: "Explain the rendering approach",
          intent: "Explain",
          entities: [],
          topic: "rendering",
          dimensions: [],
          corrections: [],
          ambiguityScore: 0,
          ambiguityReasons: [],
          needsClarification: false,
        },
      };
      vi.spyOn(provider, "complete")
        .mockResolvedValueOnce("The renderer is five times faster on all devices [1].")
        .mockRejectedValueOnce(new Error("OpenRouter completion exceeded the output-token budget"));

      const answer = await provider.synthesize(
        "Explain the rendering approach",
        plan,
        [source],
        [verifiedClaim],
        undefined,
        "deep",
      );

      expect(answer).toContain(verifiedClaim.text.replace(/[.!?]+$/, ""));
      expect(answer).toContain("[1]");
      expect(answer).not.toContain("five times faster");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("bounds a quick synthesis response to the short-answer output budget", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const plan = await buildPlan("Compare React Native and Flutter", "quick", provider);
      const complete = vi.spyOn(provider, "complete").mockResolvedValue("Short answer [1].");

      await provider.synthesize("Compare React Native and Flutter", plan, [], []);

      expect(complete.mock.calls[0]?.[2]).toMatchObject({
        maxCompletionTokens: 1024,
        responseFormat: { type: "json_object" },
        purpose: "research_synthesis",
      });
      expect(complete.mock.calls[0]?.[2]?.responseValidator).toBeTypeOf("function");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("caps completion tokens in the backend request and rejects truncated answers", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Incomplete answer" }, finish_reason: "length" }],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 8192,
            completion_tokens_details: { reasoning_tokens: 7600 },
            total_tokens: 8272,
            cost: 0.0012,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider();
      await expect(
        provider.complete("System", "Question", { maxCompletionTokens: 50_000 }),
      ).rejects.toThrow("output-token budget");
      const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(request.body)).max_completion_tokens).toBe(8192);
      expect(provider.metrics.failures).toBe(1);
      expect(provider.metrics.usage).toMatchObject({
        promptTokens: 80,
        completionTokens: 8192,
        reasoningTokens: 7600,
        totalTokens: 8272,
        cost: 0.0012,
      });
      expect(provider.metrics.records[0]?.usage?.totalTokens).toBe(8272);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Verified" } }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(provider.complete("System", "Verification")).resolves.toBe("Verified");
      const [, verificationRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(String(verificationRequest.body))).not.toHaveProperty(
        "max_completion_tokens",
      );
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("uses one compact JSON-mode verifier request per claim", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const complete = vi.spyOn(provider, "complete").mockResolvedValue(
        JSON.stringify({
          verifications: [{ id: "claim-1", verdict: "supported" }],
        }),
      );
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const results = (await registry.execute("verify_claims_batch", {
        claims: [
          {
            id: "claim-1",
            claim: "React supports server rendering.",
            evidence: "The documentation describes server rendering support.",
          },
        ],
      })) as Array<{ id: string; verdict: string }>;

      expect(complete.mock.calls[0]?.[0]).toContain("No rationale, analysis, markdown");
      expect(complete.mock.calls[0]?.[0]).toContain("explicitly or unambiguously entails");
      expect(complete.mock.calls[0]?.[2]).toMatchObject({
        maxCompletionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        responseFormat: { type: "json_object" },
        purpose: "claim_verification_batch",
        responseValidator: expect.any(Function),
      });
      expect(results).toEqual([expect.objectContaining({ id: "claim-1", verdict: "supported" })]);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("returns independent compact verdicts for a multi-claim verification input", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const complete = vi.spyOn(provider, "complete").mockImplementation(async (_system, user) => {
        const serialized = user.match(
          /<untrusted_retrieved_data>\n([\s\S]*)\n<\/untrusted_retrieved_data>/,
        )?.[1];
        const [item] = JSON.parse(serialized ?? "[]") as Array<{ id: string; claim: string }>;
        return JSON.stringify({
          verifications: [
            {
              id: item!.id,
              verdict: item!.claim.includes("first") ? "supported" : "uncertain",
            },
          ],
        });
      });
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const results = (await registry.execute("verify_claims_batch", {
        claims: [
          { id: "claim-1", claim: "The first claim.", evidence: "Evidence for the first claim." },
          { id: "claim-2", claim: "The second claim.", evidence: "Evidence for the second claim." },
          { id: "claim-3", claim: "The third claim.", evidence: "Evidence for the third claim." },
        ],
      })) as Array<{ id: string; verdict: string }>;

      expect(results.map(({ id, verdict }) => [id, verdict])).toEqual([
        ["claim-1", "supported"],
        ["claim-2", "uncertain"],
        ["claim-3", "uncertain"],
      ]);
      expect(complete).toHaveBeenCalledTimes(3);
      for (const [, userMessage, options] of complete.mock.calls) {
        const serialized = userMessage.match(
          /<untrusted_retrieved_data>\n([\s\S]*)\n<\/untrusted_retrieved_data>/,
        )?.[1];
        expect(JSON.parse(serialized ?? "[]")).toHaveLength(1);
        expect(options?.maxCompletionTokens).toBe(BATCH_VERIFICATION_COMPLETION_TOKENS);
      }
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it.each([
    ["reasoning text without a verdict", "<think>Need to inspect every possibility...</think>"],
    ["malformed JSON", '{"verifications":['],
    ["missing verdict", JSON.stringify({ verifications: [{ id: "claim-1" }] })],
    [
      "unknown verdict value",
      JSON.stringify({ verifications: [{ id: "claim-1", verdict: "probably_supported" }] }),
    ],
    [
      "duplicate verdict rows",
      JSON.stringify({
        verifications: [
          { id: "claim-1", verdict: "supported" },
          { id: "claim-1", verdict: "contradicted" },
        ],
      }),
    ],
    [
      "duplicate verdict object keys",
      '{"verifications":[{"id":"claim-1","verdict":"supported","verdict":"contradicted"}]}',
    ],
    [
      "unknown claim id",
      JSON.stringify({ verifications: [{ id: "other-claim", verdict: "supported" }] }),
    ],
  ])("keeps %s unavailable", async (_caseName, response) => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      vi.spyOn(provider, "complete").mockResolvedValue(response);
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const result = (await registry.execute("verify_claims_batch", {
        claims: [{ id: "claim-1", claim: "Claim one.", evidence: "Evidence one." }],
      })) as Array<{ id: string; verdict: string }>;

      expect(result).toEqual([expect.objectContaining({ id: "claim-1", verdict: "unavailable" })]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("keeps an exact output-budget exhaustion unavailable without retrying", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider({ maxAttempts: 1 });
      const complete = vi
        .spyOn(provider, "complete")
        .mockRejectedValue(new Error("OpenRouter completion exceeded the output-token budget"));
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const result = (await registry.execute("verify_claims_batch", {
        claims: [{ id: "claim-1", claim: "Claim one.", evidence: "Evidence one." }],
      })) as Array<{ id: string; verdict: string }>;

      expect(result[0]).toMatchObject({ id: "claim-1", verdict: "unavailable" });
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("keeps only the affected claim unavailable when a verifier response is partial", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      vi.spyOn(provider, "complete")
        .mockResolvedValueOnce(
          JSON.stringify({ verifications: [{ id: "claim-1", verdict: "supported" }] }),
        )
        .mockResolvedValueOnce(JSON.stringify({ verifications: [] }));
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const result = (await registry.execute("verify_claims_batch", {
        claims: [
          { id: "claim-1", claim: "Claim one.", evidence: "Evidence one." },
          { id: "claim-2", claim: "Claim two.", evidence: "Evidence two." },
        ],
      })) as Array<{ id: string; verdict: string }>;

      expect(result.map(({ id, verdict }) => [id, verdict])).toEqual([
        ["claim-1", "supported"],
        ["claim-2", "unavailable"],
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("bounds verifier input fields and rejects oversized batches before a model call", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const complete = vi.spyOn(provider, "complete").mockResolvedValue(
        JSON.stringify({
          verifications: [{ id: "claim-1", verdict: "supported" }],
        }),
      );
      const registry = createToolRegistry({ search: async () => [] }, provider);
      const claims = [
        {
          id: "claim-1",
          claim: ` ${"claim ".repeat(200)} `,
          evidence: ` ${"evidence ".repeat(300)} `,
        },
      ];

      await registry.execute("verify_claims_batch", { claims });
      const [, userMessage] = complete.mock.calls[0]!;
      const serialized = userMessage.match(
        /<untrusted_retrieved_data>\n([\s\S]*)\n<\/untrusted_retrieved_data>/,
      )?.[1];
      expect(serialized).toBeDefined();
      const sent = JSON.parse(serialized!) as Array<{ claim: string; evidence: string }>;
      expect(sent[0]?.claim.length).toBeLessThanOrEqual(800);
      expect(sent[0]?.evidence.length).toBeLessThanOrEqual(1500);
      expect(userMessage).not.toContain("claim ".repeat(200));
      const bounded = buildBatchVerificationPrompt([
        {
          id: "large-but-bounded",
          claim: "claim ".repeat(200),
          evidence: "evidence ".repeat(300),
        },
      ]);
      expect(bounded.promptBytes).toBeLessThanOrEqual(MAX_BATCH_VERIFICATION_PROMPT_BYTES);
      expect(bounded.promptChars).toBeGreaterThan(0);

      const oversized = Array.from({ length: MAX_BATCH_VERIFICATION_CLAIMS + 1 }, (_, index) => ({
        id: `claim-${index}`,
        claim: "A bounded claim.",
        evidence: "Its supplied evidence.",
      }));
      const rejected = (await registry.execute("verify_claims_batch", {
        claims: oversized,
      })) as Array<{ verdict: string }>;

      expect(rejected).toHaveLength(oversized.length);
      expect(rejected.every((result) => result.verdict === "unavailable")).toBe(true);

      const oversizedPrompt = Array.from({ length: MAX_BATCH_VERIFICATION_CLAIMS }, (_, index) => ({
        id: `unicode-${index}`,
        claim: "\ud800".repeat(800),
        evidence: "\ud800".repeat(1500),
      }));
      expect(() => buildBatchVerificationPrompt(oversizedPrompt)).toThrow(
        "Verifier prompt exceeds the bounded input-size limit",
      );
      const byteRejected = (await registry.execute("verify_claims_batch", {
        claims: oversizedPrompt,
      })) as Array<{ verdict: string }>;
      expect(byteRejected.every((result) => result.verdict === "unavailable")).toBe(true);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("records verifier prompt, token, and strict JSON parse metrics without prompt text", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  verifications: [{ id: "claim-1", verdict: "supported" }],
                }),
              },
            },
          ],
          usage: {
            completion_tokens: 12,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({ role: "verifier", timeoutMs: 2000 });
      const system = "Verifier instructions";
      const user = "One claim and its evidence";
      await provider.complete(system, user, {
        maxCompletionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        responseFormat: { type: "json_object" },
        responseValidator: (content) => parseBatchVerificationResponse(content, "claim-1"),
        purpose: "claim_verification_batch",
      });

      const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = String(request.body);
      expect(provider.metrics.records[0]).toMatchObject({
        role: "verifier",
        purpose: "claim_verification_batch",
        promptChars: system.length + user.length,
        requestBodyBytes: Buffer.byteLength(body),
        maxCompletionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        responseFormat: "json_object",
        responseParseResult: "VALID_JSON",
        responseValidationResult: "PASSED",
        effectiveTimeoutMs: 2000,
        usage: { completionTokens: 12, reasoningTokens: 3 },
      });
      expect(JSON.parse(body)).toMatchObject({
        max_completion_tokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        response_format: { type: "json_object" },
      });
      expect(body).not.toContain("responseValidator");
      expect(provider.metrics.records[0]).not.toHaveProperty("prompt");
      expect(provider.metrics.records[0]).not.toHaveProperty("user");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("records an exhausted completion allowance as truncated and malformed", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: '{"verifications":' } }],
          usage: {
            completion_tokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
            completion_tokens_details: {
              reasoning_tokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const provider = new OpenRouterProvider({ role: "verifier", maxAttempts: 1 });

      await expect(
        provider.complete("Verifier", "One claim", {
          maxCompletionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
          responseFormat: { type: "json_object" },
          responseValidator: (content) => parseBatchVerificationResponse(content, "claim-1"),
          purpose: "claim_verification_batch",
        }),
      ).rejects.toThrow("OpenRouter completion exceeded the output-token budget");

      expect(provider.metrics.records[0]).toMatchObject({
        purpose: "claim_verification_batch",
        maxCompletionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        responseParseResult: "TRUNCATED",
        responseValidationResult: "NOT_RUN",
        failureCategory: "MALFORMED_RESPONSE",
        usage: {
          completionTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
          reasoningTokens: BATCH_VERIFICATION_COMPLETION_TOKENS,
        },
      });
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("records invalid JSON and failed verdict-schema validation separately", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const response = (content: string) =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response('{"verifications":'))
      .mockResolvedValueOnce(response(JSON.stringify({ verifications: [] })));
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({ role: "verifier", maxAttempts: 1 });
      const options = {
        responseFormat: { type: "json_object" } as const,
        purpose: "claim_verification_batch",
      };

      await expect(provider.complete("Verifier", "One claim", options)).rejects.toThrow(
        "invalid JSON-mode content",
      );
      await expect(
        provider.complete("Verifier", "One claim", {
          ...options,
          responseValidator: (content) => parseBatchVerificationResponse(content, "claim-1"),
        }),
      ).rejects.toThrow("exactly one verdict");

      expect(provider.metrics.records).toMatchObject([
        {
          responseParseResult: "INVALID_JSON",
          failureCategory: "MALFORMED_RESPONSE",
        },
        {
          responseParseResult: "VALID_JSON",
          responseValidationResult: "FAILED",
          failureCategory: "MALFORMED_RESPONSE",
        },
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("uses the research deadline when it is shorter than the request timeout", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("fetch failed")), {
            once: true,
          });
        }),
    );
    globalThis.fetch = fetchMock;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = new OpenRouterProvider({
        role: "verifier",
        timeoutMs: 2000,
        maxAttempts: 1,
      });
      const controller = new AbortController();
      const deadlineAt = Date.now() + 30;
      deadlineTimer = setTimeout(
        () => controller.abort(new Error("Research time budget exhausted")),
        30,
      );

      await expect(
        runWithResearchExecutionContext({ deadlineAt, signal: controller.signal }, () =>
          provider.complete("System", "Question", { purpose: "claim_verification_batch" }),
        ),
      ).rejects.toThrow(/timed out/i);

      expect(provider.metrics.records[0]).toMatchObject({
        purpose: "claim_verification_batch",
        failureCategory: "TIMEOUT",
        timeoutCause: "research_deadline",
      });
      expect(provider.metrics.records[0]?.effectiveTimeoutMs).toBeLessThanOrEqual(30);
      expect(provider.metrics.records[0]?.effectiveTimeoutMs).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("records a request-cap timeout without retrying a single-attempt verifier call", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("fetch failed")), {
            once: true,
          });
        }),
    );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({
        role: "verifier",
        timeoutMs: 10,
        maxAttempts: 1,
      });

      await expect(
        provider.complete("Verifier", "Four bounded claims", {
          purpose: "claim_verification_batch",
        }),
      ).rejects.toThrow("OpenRouter request timed out");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(provider.metrics.records[0]).toMatchObject({
        role: "verifier",
        purpose: "claim_verification_batch",
        failureCategory: "TIMEOUT",
        timeoutCause: "request",
        effectiveTimeoutMs: 10,
      });
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps timed-out batch verification unavailable and does not retry a bounded call", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider({
        role: "verifier",
        timeoutMs: 5,
        maxAttempts: 1,
      });
      vi.spyOn(provider, "complete").mockRejectedValue(new Error("OpenRouter request timed out"));
      const registry = createToolRegistry({ search: async () => [] }, provider);

      const result = (await registry.execute("verify_claims_batch", {
        claims: [
          {
            id: "timeout-claim",
            claim: "React 19.3 was released on the stated date.",
            evidence: "The source describes a React 19.3 release.",
          },
        ],
      })) as Array<{ id: string; verdict: string; rationale: string }>;

      expect(result).toEqual([
        expect.objectContaining({
          id: "timeout-claim",
          verdict: "unavailable",
          rationale: expect.stringContaining("timed out"),
        }),
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("keeps invalid or duplicate verifier response IDs unavailable", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      vi.spyOn(provider, "complete").mockResolvedValue(
        JSON.stringify({
          verifications: [
            { id: "claim-1", verdict: "supported" },
            { id: "claim-1", verdict: "supported" },
            { id: "unexpected", verdict: "supported" },
          ],
        }),
      );
      const registry = createToolRegistry({ search: async () => [] }, provider);
      const result = (await registry.execute("verify_claims_batch", {
        claims: [
          { id: "claim-1", claim: "Claim one.", evidence: "Evidence one." },
          { id: "claim-2", claim: "Claim two.", evidence: "Evidence two." },
        ],
      })) as Array<{ id: string; verdict: string }>;

      expect(result).toEqual([
        expect.objectContaining({ id: "claim-1", verdict: "unavailable" }),
        expect.objectContaining({ id: "claim-2", verdict: "unavailable" }),
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("gives semantic citation validation a bounded response allowance", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const provider = new OpenRouterProvider();
      const complete = vi.spyOn(provider, "complete").mockResolvedValue(
        JSON.stringify({
          judgments: [
            {
              id: "answer-1",
              isFactual: true,
              verdict: "SUPPORTED",
              rationale: "The cited source supports the statement.",
            },
          ],
        }),
      );
      const source: Source = {
        id: "source-1",
        title: "Rendering performance",
        url: "https://example.org/rendering-performance",
        snippet: "Details of a pull-request renderer.",
        domain: "example.org",
        content: "The article describes techniques used in a pull-request rendering system.",
        quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
      };

      const report = await provider.validateCitedAnswer(
        "The renderer reduces redundant work while displaying large pull requests [1].",
        [source],
      );

      expect(complete.mock.calls[0]?.[2]).toEqual({
        maxCompletionTokens: 4096,
        purpose: "citation_entailment",
      });
      expect(report.failure).toBeUndefined();
      expect(report.status).toBe("VALIDATED");
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("retries one transient server failure but does not retry rate limits", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Recovered answer" } }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider(2000);
      await expect(provider.complete("System", "Question")).resolves.toBe("Recovered answer");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(provider.metrics.calls).toBe(2);
      expect(provider.metrics.failures).toBe(1);

      const rateLimited = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
      globalThis.fetch = rateLimited;
      const limitedProvider = new OpenRouterProvider(2000);
      await expect(limitedProvider.complete("System", "Question")).rejects.toThrow(
        "OpenRouter returned 429",
      );
      expect(rateLimited).toHaveBeenCalledTimes(1);
      expect(limitedProvider.metrics.failures).toBe(1);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("can enforce a single OpenRouter attempt for bounded evaluations", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Must not retry" } }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({ timeoutMs: 2000, maxAttempts: 1 });
      await expect(provider.complete("System", "Question")).rejects.toThrow(
        "OpenRouter returned 503",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(provider.metrics.calls).toBe(1);
      expect(provider.metrics.failures).toBe(1);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("uses a configured fallback model after a primary rate limit and records role metrics", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({
        role: "planner",
        model: "primary/model",
        fallbackModel: "fallback/model",
        timeoutMs: 2000,
      });

      await expect(provider.complete("System", "Question")).resolves.toBe("Fallback answer");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestModels = fetchMock.mock.calls.map(
        ([, request]) => JSON.parse(String((request as RequestInit).body)).model,
      );
      expect(requestModels).toEqual(["primary/model", "fallback/model"]);
      expect(provider.metrics.records).toMatchObject([
        {
          role: "planner",
          model: "primary/model",
          fallbackUsed: false,
          failureCategory: "RATE_LIMIT",
        },
        { role: "planner", model: "fallback/model", fallbackUsed: true, attempt: 1 },
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("routes verification and writing calls to their configured logical roles", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = "test-only-key";
    try {
      const planner = new OpenRouterProvider({ role: "planner" });
      const writer = new OpenRouterProvider({ role: "research" });
      const verifier = new OpenRouterProvider({ role: "verifier" });
      const plannerCall = vi.spyOn(planner, "complete").mockResolvedValue(
        JSON.stringify({
          normalizedQuestion: "is mercury a good choice for this backend?",
          intent: "ambiguous_comparison",
          entities: ["Mercury"],
          dimensions: ["backend"],
          ambiguityScore: 0.7,
          needsClarification: true,
        }),
      );
      const writerCall = vi.spyOn(writer, "complete").mockResolvedValue("A concise answer.");
      const verifierCall = vi
        .spyOn(verifier, "complete")
        .mockResolvedValue('{"verifications":[{"id":"claim","verdict":"supported"}]}');
      const registry = createToolRegistry({ search: async () => [] }, writer, undefined, {
        planner,
        research: writer,
        verifier,
      });

      await registry.execute("understand_query", { question: "is mercury good for it" });
      await registry.execute("verify_claim", {
        claim: "React supports server rendering.",
        evidence: "The documentation describes server rendering support.",
      });
      await registry.execute("synthesize", {
        kind: "direct",
        question: "Explain server rendering simply.",
      });

      expect(verifierCall).toHaveBeenCalledOnce();
      expect(writerCall).toHaveBeenCalledOnce();
      expect(plannerCall).toHaveBeenCalledOnce();
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("uses the role fallback after a bounded primary timeout", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("fetch failed")));
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({
        role: "research",
        model: "primary/model",
        fallbackModel: "fallback/model",
        timeoutMs: 5,
      });

      await expect(provider.complete("System", "Question")).resolves.toBe("Fallback answer");
      expect(provider.metrics.records[0]).toMatchObject({
        role: "research",
        model: "primary/model",
        failureCategory: "TIMEOUT",
        timeoutCause: "request",
        effectiveTimeoutMs: 5,
      });
      expect(provider.metrics.records[1]).toMatchObject({
        role: "research",
        model: "fallback/model",
        fallbackUsed: true,
      });
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });

  it("reports primary and fallback failure without retrying a rate limit indefinitely", async () => {
    const previousKey = config.OPENROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    config.OPENROUTER_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("invalid key", { status: 401 }));
    globalThis.fetch = fetchMock;
    try {
      const provider = new OpenRouterProvider({
        role: "verifier",
        model: "primary/model",
        fallbackModel: "fallback/model",
        timeoutMs: 2000,
      });
      await expect(provider.complete("System", "Question")).rejects.toThrow(
        /verifier role failed; primary primary\/model: OpenRouter returned 429; fallback fallback\/model: OpenRouter returned 401/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(provider.metrics.records.map((record) => record.failureCategory)).toEqual([
        "RATE_LIMIT",
        "AUTH",
      ]);
    } finally {
      config.OPENROUTER_API_KEY = previousKey;
      globalThis.fetch = previousFetch;
    }
  });
});
