import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createToolRegistry, type ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { Source } from "../src/domain.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { ResilientSearchProvider } from "../src/search.js";
import { SqliteSessionStore } from "../src/store.js";

const reactClaim =
  "React Native recommends profiling release builds because development mode affects JavaScript and UI thread performance measurements.";
const flutterClaim =
  "Flutter recommends performance profiling in profile mode to measure release-like rendering behavior.";

class DeterministicModel extends OpenRouterProvider {
  override get enabled() {
    return true;
  }

  override async complete(system: string, user: string): Promise<string> {
    if (system.includes("evidence-first research writer")) {
      return [`- ${reactClaim} [1].`, `- ${flutterClaim} [2].`].join("\n");
    }
    if (/Which source supports the first verified finding/i.test(user)) {
      return `${reactClaim} [1]`;
    }
    const actions = user.match(/Allowed actions: ([^\n]+)/)?.[1]?.split(", ");
    return JSON.stringify({ action: actions?.[0] ?? "synthesize" });
  }
}

describe("bounded citation-quality API E2E with deterministic providers", () => {
  it("runs /api/chat through extraction, evidence, citation validation, and post follow-up", async () => {
    const store = new SqliteSessionStore(":memory:");
    const model = new DeterministicModel();
    const search = new ResilientSearchProvider([
      {
        name: "fixture-serper",
        provider: {
          search: async () => [
            {
              title: "React Native Performance Documentation",
              url: "https://reactnative.dev/docs/performance",
              snippet: "Guidance for profiling React Native performance.",
              provider: "fixture-serper",
            },
            {
              title: "Flutter Performance Documentation",
              url: "https://docs.flutter.dev/perf",
              snippet: "Guidance for profiling Flutter performance.",
              provider: "fixture-serper",
            },
          ],
        },
      },
    ]);
    const registry: ToolRegistry = createToolRegistry(search, model, store);
    registry.register({
      name: "fetch_url",
      description: "Deterministic fixture fetch for the API end-to-end test.",
      execute: async (input) => ({
        url: (input as { url: string }).url,
        html: "fixture html",
        contentType: "text/html",
        retrievalMethod: "fixture",
      }),
    });
    registry.register({
      name: "extract_content",
      description: "Return a source paragraph that acts as the test fixture evidence.",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        return url.includes("reactnative.dev")
          ? { title: "React Native Performance", content: reactClaim }
          : { title: "Flutter Performance", content: flutterClaim };
      },
    });
    registry.register({
      name: "verify_claim",
      description: "Fixture verification for one Research Chat claim at a time.",
      execute: async () => ({
        verdict: "supported",
        rationale: "Claim text exactly matches extracted source evidence",
      }),
    });
    registry.register({
      name: "verify_claims_batch",
      description: "Fixture verification; no paid model request is made.",
      execute: async (input) =>
        (input as { claims: Array<{ id: string }> }).claims.map(({ id }) => ({
          id,
          verdict: "supported",
          rationale: "Claim text exactly matches extracted source evidence",
        })),
    });

    const app = await createServer({
      store,
      authVerifier: {
        verifyAccessToken: async (token) =>
          token === "test-user-token" ? { id: "citation-user" } : undefined,
      },
      searchProvider: search,
      llmProvider: model,
      toolRegistry: registry,
      researchBudget: {
        maxSteps: 8,
        maxQueries: 2,
        maxSources: 2,
        maxPages: 2,
        maxClaimsToVerify: 2,
        maxTimeMs: 5_000,
        maxModelDecisions: 1,
        maxSearchPasses: 1,
      },
    });
    getServerBackgroundServices(app).worker.start();

    try {
      const chatResponse = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { authorization: "Bearer test-user-token" },
        payload: {
          message:
            "Compare React Native and Flutter performance profiling recommendations from documentation.",
          deepResearch: true,
        },
      });
      expect(chatResponse.statusCode).toBe(202);
      const started = chatResponse.json() as { researchId: string };
      const deadline = Date.now() + 5_000;
      let session: Awaited<ReturnType<SqliteSessionStore["get"]>>;
      do {
        session = await store.get(started.researchId);
        if (session && ["COMPLETED", "FAILED"].includes(session.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);

      expect(session?.status).toBe("COMPLETED");
      expect(session?.sources.some((source) => source.content?.includes(reactClaim))).toBe(true);
      expect(session?.sources.some((source) => source.content?.includes(flutterClaim))).toBe(true);
      expect(session?.answer).toContain("[1]");
      expect(session?.steps.map((step) => step.label).join(" ")).toContain("verify_claim");
      expect(model.metrics.citationEntailment).toMatchObject({ status: "VALIDATED" });
      expect(
        model.metrics.citationEntailment?.items.find((item) => item.sourceIds.length > 0),
      ).toMatchObject({
        verdict: "SUPPORTED",
        method: "exact_match",
      });

      const verifiedClaims = session!.claims.filter(
        (claim) => claim.verification?.verdict === "supported",
      );
      const postId = randomUUID();
      const topicId = randomUUID();
      const now = new Date().toISOString();
      const postSources = session!.sources as Source[];
      await store.saveTopic({
        id: topicId,
        title: "Test citation quality topic",
        url: postSources[0]?.url ?? "https://reactnative.dev/docs/performance",
        summary: session!.answer ?? "",
        provider: "fixture-serper",
        discoveredAt: now,
        score: 1,
        status: "RESEARCHED",
      });
      await store.savePost({
        id: postId,
        topicId,
        researchId: session!.id,
        title: "Test published research post",
        summary: session!.answer ?? "",
        whyItMatters: "Ensures follow-ups retain source provenance.",
        findings: verifiedClaims.map((claim) => ({
          claimId: claim.id,
          text: claim.text,
          sourceIds: claim.sourceIds,
        })),
        caveats: [],
        sources: postSources,
        claims: session!.claims,
        publishedAt: now,
        researchedAt: now,
        category: "fixture",
      });
      await store.saveRun({
        id: randomUUID(),
        trigger: "manual",
        status: "PUBLISHED",
        createdAt: now,
        updatedAt: now,
        topicId,
        researchId: session!.id,
        postId,
        events: [],
      });

      const askResponse = await app.inject({
        method: "POST",
        url: `/api/posts/${postId}/ask`,
        headers: { authorization: "Bearer test-user-token" },
        payload: { question: "Which source supports the first verified finding?" },
      });
      expect(askResponse.statusCode).toBe(202);
      const queued = askResponse.json() as { id: string };
      const followUpDeadline = Date.now() + 3_000;
      let followUp: Awaited<ReturnType<SqliteSessionStore["getFollowUp"]>>;
      do {
        followUp = await store.getFollowUp(queued.id);
        if (followUp && ["COMPLETED", "FAILED"].includes(followUp.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < followUpDeadline);

      expect(followUp?.status, followUp?.error).toBe("COMPLETED");
      expect(followUp?.answer).toContain("[1]");
      expect(followUp?.answer).toContain(reactClaim);
    } finally {
      await app.close();
    }
  });
});
