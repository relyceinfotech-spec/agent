import { afterEach, describe, expect, it } from "vitest";
import type { QueryInterpretation } from "../src/domain.js";
import type { EmbeddingBatch, EmbeddingProvider } from "../src/embeddings.js";
import { UserMemoryService } from "../src/memory.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { createServer } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { withAuthenticatedUser } from "../src/auth-context.js";

class ApiFakeEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "deterministic-api-test";
  readonly model = "api-fake-3d-v1";
  readonly calls: string[][] = [];
  failure?: Error;

  async embedMany(texts: string[]): Promise<EmbeddingBatch> {
    if (this.failure) throw this.failure;
    this.calls.push([...texts]);
    return {
      model: this.model,
      vectors: texts.map((text) =>
        /serper|search provider|web search/i.test(text) ? [1, 0, 0] : [0, 1, 0],
      ),
      usage: { totalTokens: texts.length * 2 },
    };
  }
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];
const searchToken = { userId: "memory-api-a", accessToken: "memory-api-token-a" };
const secondToken = { userId: "memory-api-b", accessToken: "memory-api-token-b" };

function interpretation(question: string): QueryInterpretation {
  return {
    normalizedQuestion: question,
    intent: "personal_context",
    entities: [],
    topic: "saved user context",
    dimensions: [],
    corrections: [],
    ambiguityScore: 0,
    ambiguityReasons: [],
    needsClarification: false,
    formatPreference: "direct",
  };
}

function makeTools(contexts: Array<string | undefined>) {
  return new ToolRegistry()
    .register({
      name: "understand_query",
      description: "Deterministic memory integration test query understanding.",
      execute: async (input) => interpretation((input as { question: string }).question),
    })
    .register({
      name: "synthesize",
      description: "Deterministic synthesis that records only the supplied private context.",
      execute: async (input) => {
        const memoryContext = (input as { memoryContext?: string }).memoryContext;
        contexts.push(memoryContext);
        return memoryContext
          ? "I recall the saved MAX search-provider choice."
          : "No saved context was needed.";
      },
    });
}

async function makeApp(
  options: { memoryService?: UserMemoryService; memoryMaxRecords?: number } = {},
) {
  const store = new SqliteSessionStore(":memory:");
  const embeddings = new ApiFakeEmbeddingProvider();
  const memoryService =
    options.memoryService ??
    new UserMemoryService(store, embeddings, {
      embeddingDimensions: 3,
      maxRecords: options.memoryMaxRecords,
    });
  const contexts: Array<string | undefined> = [];
  let searchCalls = 0;
  const app = await createServer({
    store,
    memoryService,
    authVerifier: {
      verifyAccessToken: async (token) => {
        if (token === searchToken.accessToken) return { id: searchToken.userId };
        if (token === secondToken.accessToken) return { id: secondToken.userId };
        return undefined;
      },
    },
    quotaPolicy: new QuotaPolicy(
      JSON.stringify({
        default: {
          enabled: true,
          quotas: {
            research: { limit: 20, windowSeconds: 3600 },
            deep_research: { limit: 5, windowSeconds: 3600 },
            followup: { limit: 5, windowSeconds: 3600 },
          },
          features: { research: true, deepResearch: true, postFollowUps: true },
        },
      }),
    ),
    searchProvider: {
      search: async () => {
        searchCalls += 1;
        return [];
      },
    },
    llmProvider: { enabled: true } as never,
    toolRegistry: makeTools(contexts),
  });
  servers.push(app);
  return { app, store, embeddings, memoryService, contexts, getSearchCalls: () => searchCalls };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createMemory(
  app: Awaited<ReturnType<typeof createServer>>,
  token = searchToken.accessToken,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/memories",
    headers: auth(token),
    payload: { text: "For MAX I chose Serper as the web search provider." },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ memory: { id: string; content: string } }>().memory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("authenticated semantic memory API", () => {
  it("requires authentication and rejects a caller-supplied user_id", async () => {
    const { app, store } = await makeApp();
    const unauthenticated = await app.inject({ method: "GET", url: "/api/memories" });
    const forged = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: auth(searchToken.accessToken),
      payload: {
        text: "For MAX I chose Serper as the web search provider.",
        user_id: secondToken.userId,
      },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forged.statusCode).toBe(400);
    await expect(
      withAuthenticatedUser(searchToken, () => store.listUserMemories()),
    ).resolves.toEqual([]);
  });

  it("allows own list/get/update/delete while denying every cross-user operation", async () => {
    const { app } = await makeApp();
    const memory = await createMemory(app);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/memories/${memory.id}`,
          headers: auth(searchToken.accessToken),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/memories/${memory.id}`,
          headers: auth(secondToken.accessToken),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/memories/${memory.id}`,
          headers: auth(secondToken.accessToken),
          payload: { isActive: false },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/memories/${memory.id}`,
          headers: auth(secondToken.accessToken),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/memories/${memory.id}`,
          headers: auth(searchToken.accessToken),
          payload: { isActive: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/memories/${memory.id}`,
          headers: auth(searchToken.accessToken),
        })
      ).json().isActive,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/memories/${memory.id}`,
          headers: auth(searchToken.accessToken),
        })
      ).statusCode,
    ).toBe(204);
  });

  it("counts inactive memories toward the retained cap without charging reactivation another slot", async () => {
    const { app, embeddings, memoryService } = await makeApp({ memoryMaxRecords: 1 });
    const memory = await createMemory(app);
    await withAuthenticatedUser(searchToken, () =>
      memoryService.update(memory.id, { isActive: false }),
    );

    const additional = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: auth(searchToken.accessToken),
      payload: { text: "I prefer Flutter for mobile app development." },
    });
    expect(additional.statusCode).toBe(409);
    expect(embeddings.calls).toHaveLength(1);

    const reactivated = await app.inject({
      method: "PATCH",
      url: `/api/memories/${memory.id}`,
      headers: auth(searchToken.accessToken),
      payload: { isActive: true },
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json()).toMatchObject({ isActive: true });
  });

  it("injects matching private context into only the owner’s authenticated chat", async () => {
    const { app, contexts, getSearchCalls } = await makeApp();
    const memory = await createMemory(app);
    const question = "Which search provider did I choose for MAX?";

    const alice = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(searchToken.accessToken),
      payload: { message: question },
    });
    expect(alice.statusCode).toBe(200);
    expect(contexts[0]).toContain(memory.content);
    expect(alice.json().toolEvents[0].tool).toBe("memory_retrieval");

    const bob = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(secondToken.accessToken),
      payload: { message: question },
    });
    expect(bob.statusCode).toBe(200);
    expect(contexts[1]).toBeUndefined();
    expect(bob.body).not.toContain(memory.content);
    expect(getSearchCalls()).toBe(0);

    const publicDiscover = await app.inject({ method: "GET", url: "/api/discover" });
    expect(publicDiscover.statusCode).toBe(200);
    expect(publicDiscover.body).not.toContain(memory.content);
  });

  it("captures only explicit chat memory and acknowledges without sending it to the agent", async () => {
    const { app, contexts } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(searchToken.accessToken),
      payload: { message: "Remember that I prefer concise explanations for technical topics." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().answer).toContain("Saved");
    expect(contexts).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/memories",
          headers: auth(searchToken.accessToken),
        })
      ).json(),
    ).toHaveLength(1);
  });

  it("continues the chat without memory when embedding retrieval fails", async () => {
    const { app, embeddings, contexts } = await makeApp();
    await createMemory(app);
    embeddings.failure = new Error("deterministic embedding outage");
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(searchToken.accessToken),
      payload: { message: "Which search provider did I choose for MAX?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().answer).toBe("No saved context was needed.");
    expect(contexts).toEqual([undefined]);
    expect(response.json().toolEvents[0]).toMatchObject({
      tool: "memory_retrieval",
      status: "failed",
    });
  });

  it("keeps stored memory out of public post/discover content", async () => {
    const { app } = await makeApp();
    await createMemory(app);

    const discover = await app.inject({ method: "GET", url: "/api/discover" });
    expect(discover.statusCode).toBe(200);
    expect(discover.body).not.toContain("For MAX I chose Serper");
  });
});
