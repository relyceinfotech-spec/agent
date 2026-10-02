import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryInterpretation, ResearchSession } from "../src/domain.js";
import type { EmbeddingBatch, EmbeddingProvider } from "../src/embeddings.js";
import { createToolRegistry, type ToolRegistry } from "../src/agent/tools.js";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { postFromResearch } from "../src/post-quality.js";
import { UserMemoryService } from "../src/memory.js";
import { OpenRouterProvider } from "../src/llm.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { getServerBackgroundServices, createServer } from "../src/server.js";
import { ResilientSearchProvider } from "../src/search.js";
import { SqliteSessionStore } from "../src/store.js";
import type { TopicCandidate } from "../src/content-domain.js";

const privatePreference = "For MAX I prefer concise answers with source links.";
const irrelevantMemory = "My favorite sport is cricket.";
const reactEvidence =
  "The official React documentation explains how to build user interfaces with React.";
const reactRepositoryEvidence =
  "The official React repository's history lists published versions and their release notes.";

class IntegrationEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "system-integration-fixture";
  readonly model = "system-integration-3d-v1";
  readonly inputs: string[][] = [];

  async embedMany(texts: string[]): Promise<EmbeddingBatch> {
    this.inputs.push([...texts]);
    return {
      model: this.model,
      vectors: texts.map((text) => (/cricket/i.test(text) ? [0, 1, 0] : [1, 0, 0])),
      usage: { totalTokens: texts.length },
    };
  }
}

class IntegrationModel extends OpenRouterProvider {
  readonly prompts: Array<{ system: string; user: string }> = [];

  override get enabled() {
    return true;
  }

  override async complete(system: string, user: string): Promise<string> {
    this.prompts.push({ system, user });
    if (system.includes("evidence-first research writer")) {
      return `- ${reactEvidence} [1].\n- ${reactRepositoryEvidence} [2].`;
    }
    if (/What does the React documentation explain/i.test(user)) {
      return `${reactEvidence} [1]`;
    }
    const allowedActions = user.match(/Allowed actions: ([^\n]+)/)?.[1]?.split(", ");
    return JSON.stringify({ action: allowedActions?.[0] ?? "synthesize" });
  }
}

const alice = { id: "system-integration-alice", token: "system-integration-token-a" };
const bob = { id: "system-integration-bob", token: "system-integration-token-b" };
const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];

function interpretation(question: string): QueryInterpretation {
  return {
    normalizedQuestion: question,
    intent: "current_information",
    entities: ["React"],
    topic: "official React project documentation",
    dimensions: ["official documentation", "project repository"],
    corrections: [],
    ambiguityScore: 0,
    ambiguityReasons: [],
    needsClarification: false,
    formatPreference: "direct",
  };
}

function createIntegrationTools(
  search: ResilientSearchProvider,
  model: IntegrationModel,
  store: SqliteSessionStore,
  observations: { sourceFetches: number },
): ToolRegistry {
  const tools = createToolRegistry(search, model, store);
  tools.register({
    name: "understand_query",
    description: "Return a deterministic interpretation for the integration scenario.",
    execute: async (input) => interpretation((input as { question: string }).question),
  });
  tools.register({
    name: "fetch_url",
    description: "Return a bounded synthetic HTTP response without network access.",
    execute: async (input) => ({
      url: (input as { url: string }).url,
      html: "Fixture response; extraction is deterministic.",
      contentType: "text/html",
      retrievalMethod: "fixture-http",
    }),
  });
  tools.register({
    name: "extract_content",
    description: "Return source-specific fixture evidence.",
    execute: async (input) => {
      const url = (input as { url: string }).url;
      observations.sourceFetches += 1;
      return url.includes("react.dev")
        ? { title: "React releases", content: reactEvidence }
        : { title: "React repository releases", content: reactRepositoryEvidence };
    },
  });
  tools.register({
    name: "verify_claim",
    description: "Mark one exact fixture-supported claim as supported.",
    execute: async () => ({
      verdict: "supported",
      rationale: "Claim exactly matches retrieved official-source fixture evidence.",
    }),
  });
  tools.register({
    name: "verify_claims_batch",
    description: "Mark exact fixture-supported claims as supported.",
    execute: async (input) =>
      (input as { claims: Array<{ id: string }> }).claims.map(({ id }) => ({
        id,
        verdict: "supported",
        rationale: "Claim exactly matches retrieved official-source fixture evidence.",
      })),
  });
  return tools;
}

async function waitForJob(app: Awaited<ReturnType<typeof createServer>>, id: string) {
  const { jobStore } = getServerBackgroundServices(app);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await jobStore.getJob(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Integration research job did not reach a terminal state");
}

async function waitForFollowUp(
  app: Awaited<ReturnType<typeof createServer>>,
  postId: string,
  followUpId: string,
) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: "GET",
      url: `/api/posts/${postId}/ask/${followUpId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    if (response.statusCode === 200) {
      const followUp = response.json<{ status: string; answer?: string; sources?: unknown[] }>();
      if (["COMPLETED", "FAILED"].includes(followUp.status)) return followUp;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Authenticated post follow-up did not finish");
}

const integrationOriginalRateMax = config.RATE_LIMIT_MAX_REQUESTS;
afterEach(async () => {
  config.RATE_LIMIT_MAX_REQUESTS = integrationOriginalRateMax;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("provider-free full backend integration", () => {
  it("joins Auth, quota, memory, idempotent queue, worker, retrieval, citations, persistence, SSE, and follow-up", async () => {
    config.RATE_LIMIT_MAX_REQUESTS = 2000; // Rapid fixture polling must not consume the production API allowance.
    const store = new SqliteSessionStore(":memory:");
    const embeddings = new IntegrationEmbeddingProvider();
    const memory = new UserMemoryService(store, embeddings, {
      embeddingDimensions: 3,
      minSimilarity: 0.45,
    });
    const model = new IntegrationModel();
    const observations = { sourceFetches: 0, searchRequests: 0 };
    const search = new ResilientSearchProvider([
      {
        name: "integration-search",
        provider: {
          search: async () => {
            observations.searchRequests += 1;
            return [
              {
                title: "Official React documentation",
                url: "https://react.dev/learn",
                snippet: "Official documentation for building user interfaces with React.",
                provider: "integration-search",
              },
              {
                title: "Official React repository release history",
                url: "https://github.com/facebook/react/releases",
                snippet: "Official React repository history and release notes.",
                provider: "integration-search",
              },
            ];
          },
        },
      },
    ]);
    const tools = createIntegrationTools(search, model, store, observations);
    const quotaPolicy = new QuotaPolicy(
      JSON.stringify({
        default: {
          quotas: {
            research: { limit: 1, windowSeconds: 3600 },
            deep_research: { limit: 1, windowSeconds: 3600 },
            followup: { limit: 2, windowSeconds: 3600 },
          },
          features: { research: true, deepResearch: true, postFollowUps: true },
        },
      }),
    );
    const app = await createServer({
      store,
      authVerifier: {
        verifyAccessToken: async (token) =>
          token === alice.token
            ? { id: alice.id }
            : token === bob.token
              ? { id: bob.id }
              : undefined,
      },
      quotaPolicy,
      memoryService: memory,
      searchProvider: search,
      llmProvider: model,
      toolRegistry: tools,
      researchBudget: {
        maxSteps: 12,
        maxQueries: 1,
        maxSources: 2,
        maxPages: 2,
        maxClaimsToVerify: 2,
        maxTimeMs: 5000,
        maxModelDecisions: 1,
        maxSearchPasses: 1,
      },
    });
    servers.push(app);
    const { worker, jobStore } = getServerBackgroundServices(app);
    const authAlice = { authorization: `Bearer ${alice.token}` };
    const authBob = { authorization: `Bearer ${bob.token}` };
    const idempotencyKey = `backend-integration-${randomUUID()}`;
    const question =
      "Based on what I said about my preferred answer style, investigate the current official React documentation and its repository history; summarize what each provides with citations.";

    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/api/jobs" });
      expect(unauthenticated.statusCode).toBe(401);

      const savedPreference = await app.inject({
        method: "POST",
        url: "/api/memories",
        headers: authAlice,
        payload: { text: privatePreference },
      });
      expect(savedPreference.statusCode).toBe(201);
      const preferenceId = savedPreference.json<{ memory: { id: string } }>().memory.id;
      const savedIrrelevant = await app.inject({
        method: "POST",
        url: "/api/memories",
        headers: authAlice,
        payload: { text: irrelevantMemory },
      });
      expect(savedIrrelevant.statusCode).toBe(201);
      const irrelevantId = savedIrrelevant.json<{ memory: { id: string } }>().memory.id;

      const forgedMemory = await app.inject({
        method: "POST",
        url: "/api/memories",
        headers: authAlice,
        payload: { text: "A forged ownership memory fixture", user_id: bob.id },
      });
      expect(forgedMemory.statusCode).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/memories", headers: authBob })).json(),
      ).toEqual([]);

      const request = {
        method: "POST" as const,
        url: "/api/chat",
        headers: { ...authAlice, "idempotency-key": idempotencyKey },
        payload: { message: question, user_id: bob.id },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(202);
      const firstBody = first.json<{
        route: string;
        researchId: string;
        jobId: string;
        toolEvents?: Array<{ tool: string; status: string; message: string }>;
      }>();
      expect(firstBody.route).toBe("web");
      expect(firstBody.jobId).toBeTruthy();
      expect(firstBody.toolEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "memory_retrieval",
            status: "complete",
            message: expect.stringMatching(/^Applied 1 relevant saved context item/),
          }),
        ]),
      );

      const embeddingCallsBeforeReplay = embeddings.inputs.length;
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(202);
      expect(replay.json<{ jobId: string }>().jobId).toBe(firstBody.jobId);
      expect(embeddings.inputs).toHaveLength(embeddingCallsBeforeReplay);
      const queuedJob = await jobStore.getJob(firstBody.jobId);
      expect(queuedJob).toMatchObject({
        id: firstBody.jobId,
        ownerId: alice.id,
        status: "queued",
      });
      expect(queuedJob?.payload.memoryContext).toContain(privatePreference);
      expect(queuedJob?.payload.memoryContext).not.toContain(irrelevantMemory);
      expect(queuedJob?.payload.researchChatOptimization).toBe(true);
      expect(queuedJob?.payload.interpretation).toMatchObject({
        normalizedQuestion: question,
        entities: expect.any(Array),
        dimensions: expect.any(Array),
      });

      const conflictingReplay = await app.inject({
        ...request,
        payload: { message: "A different question must not reuse the original job." },
      });
      expect(conflictingReplay.statusCode).toBe(409);
      expect(embeddings.inputs).toHaveLength(embeddingCallsBeforeReplay);

      const differentRequest = await app.inject({
        ...request,
        headers: { ...authAlice, "idempotency-key": `${idempotencyKey}-different` },
        payload: { message: "A distinct request should exceed this user's research quota." },
      });
      expect(differentRequest.statusCode).toBe(429);

      const bobRequest = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { ...authBob, "idempotency-key": `bob-${randomUUID()}` },
        payload: {
          message: "Investigate current official React release documentation and cite sources.",
        },
      });
      expect(bobRequest.statusCode).toBe(202);
      const bobJobId = bobRequest.json<{ jobId: string }>().jobId;
      expect(await jobStore.getJob(bobJobId)).toMatchObject({ ownerId: bob.id, status: "queued" });
      const bobCancel = await app.inject({
        method: "POST",
        url: `/api/jobs/${bobJobId}/cancel`,
        headers: authBob,
      });
      expect(bobCancel.statusCode).toBe(200);
      expect((await jobStore.getJob(bobJobId))?.status).toBe("cancelled");

      const bobCannotReadJob = await app.inject({
        method: "GET",
        url: `/api/jobs/${firstBody.jobId}`,
        headers: authBob,
      });
      const bobCannotReadResearch = await app.inject({
        method: "GET",
        url: `/api/research/${firstBody.researchId}`,
        headers: authBob,
      });
      const bobCannotReadMemory = await app.inject({
        method: "GET",
        url: `/api/memories/${preferenceId}`,
        headers: authBob,
      });
      expect(bobCannotReadJob.statusCode).toBe(404);
      expect(bobCannotReadResearch.statusCode).toBe(404);
      expect(bobCannotReadMemory.statusCode).toBe(404);
      expect(observations.searchRequests).toBe(0);
      expect(model.prompts).toHaveLength(0);

      worker.start();
      const job = await waitForJob(app, firstBody.jobId);
      const session = await withAuthenticatedUser(
        { userId: alice.id, accessToken: alice.token },
        () => store.get(firstBody.researchId),
      );
      expect(job.status, job.errorSummary).toBe("completed");
      expect(job.attempts).toBe(1);
      expect(await jobStore.getJob(firstBody.jobId)).toMatchObject({ ownerId: alice.id });
      expect(job.result?.modelMetrics).toMatchObject({
        citationEntailment: { status: "VALIDATED" },
      });

      expect(session?.status).toBe("COMPLETED");
      expect(session?.plan?.interpretation).toEqual(queuedJob?.payload.interpretation);
      expect(session?.sources).toHaveLength(2);
      expect(session?.claims.map((claim) => claim.text)).toEqual(
        expect.arrayContaining([reactEvidence, reactRepositoryEvidence]),
      );
      expect(session?.claims.every((claim) => claim.verification?.verdict === "supported")).toBe(
        true,
      );
      expect(session?.answer).toMatch(/\[\d+\]/);
      expect(model.metrics.citationEntailment).toBeUndefined();
      expect(
        model.prompts.some(({ system }) =>
          system.startsWith("Return JSON only. Understand the user's request conservatively."),
        ),
      ).toBe(false);
      expect(
        model.prompts.some(
          ({ system, user }) =>
            system.includes("evidence-first research writer") && user.includes(privatePreference),
        ),
      ).toBe(true);
      expect(model.prompts.every(({ user }) => !user.includes(irrelevantMemory))).toBe(true);
      expect(embeddings.inputs.length).toBeGreaterThanOrEqual(3);
      expect(observations.searchRequests).toBe(1);
      expect(observations.sourceFetches).toBe(2);

      const result = await app.inject({
        method: "GET",
        url: `/api/research/${firstBody.researchId}`,
        headers: authAlice,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json<ResearchSession>().status).toBe("COMPLETED");

      const events = await app.inject({
        method: "GET",
        url: `/api/research/${firstBody.researchId}/events`,
        headers: authAlice,
      });
      expect(events.statusCode).toBe(200);
      expect(events.body).toContain("research.snapshot");
      expect(events.body).toContain("COMPLETED");

      const topic: TopicCandidate = {
        id: randomUUID(),
        title: "Fixture topic from completed integrated research",
        url: session!.sources[0].url,
        summary: session!.answer!,
        provider: "integration-search",
        discoveredAt: new Date().toISOString(),
        score: 0.9,
        status: "RESEARCHED",
      };
      const post = postFromResearch(topic, session!);
      await withAuthenticatedUser({ userId: alice.id, accessToken: alice.token }, async () => {
        await store.saveTopic(topic);
        await store.savePost(post);
        await store.saveRun({
          id: randomUUID(),
          trigger: "manual",
          status: "PUBLISHED",
          createdAt: topic.discoveredAt,
          updatedAt: topic.discoveredAt,
          topicId: topic.id,
          researchId: session!.id,
          postId: post.id,
          events: [],
        });
      });

      const ask = await app.inject({
        method: "POST",
        url: `/api/posts/${post.id}/ask`,
        headers: authAlice,
        payload: { question: "What does the React documentation explain?" },
      });
      expect(ask.statusCode).toBe(202);
      const followUpId = ask.json<{ id: string }>().id;
      const followUp = await waitForFollowUp(app, post.id, followUpId);
      expect(followUp.status).toBe("COMPLETED");
      expect(followUp.answer).toContain("[1]");

      const foreignFollowUp = await app.inject({
        method: "GET",
        url: `/api/posts/${post.id}/ask/${followUpId}`,
        headers: authBob,
      });
      expect(foreignFollowUp.statusCode).toBe(404);

      const discover = await app.inject({ method: "GET", url: "/api/discover" });
      expect(discover.statusCode).toBe(200);
      expect(discover.body).not.toContain(privatePreference);
      expect(discover.body).not.toContain(irrelevantMemory);

      const ownMemories = await app.inject({
        method: "GET",
        url: "/api/memories",
        headers: authAlice,
      });
      expect(ownMemories.json<Array<{ id: string }>>().map((entry) => entry.id)).toEqual(
        expect.arrayContaining([preferenceId, irrelevantId]),
      );
    } finally {
      await app.close();
    }
  });
});
