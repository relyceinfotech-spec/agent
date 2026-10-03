import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAuthenticatedUser } from "../src/auth-context.js";
import { OpenRouterProvider } from "../src/llm.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import {
  ConversationIdempotencyConflictError,
  ConversationNotFoundError,
  SqliteSessionStore,
} from "../src/store.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { QuotaPolicy } from "../src/quota-policy.js";

const openApps: Array<Awaited<ReturnType<typeof createServer>>> = [];
afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
});

async function waitForJob(app: Awaited<ReturnType<typeof createServer>>, jobId: string) {
  const { jobStore } = getServerBackgroundServices(app);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await jobStore.getJob(jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

function user(ownerId: string) {
  return { userId: ownerId, accessToken: "fixture-token" };
}

describe("persistent conversation history", () => {
  it("creates a conversation for the first input, reuses its id, and separates New Chat", async () => {
    const store = new SqliteSessionStore(":memory:");
    const first = await store.appendConversationUserMessage({
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "First question",
      content: "First question",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = await store.appendConversationUserMessage({
      ownerId: "alice",
      conversationId: first.conversation.id,
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Second question",
      content: "Second question",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const separate = await store.appendConversationUserMessage({
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "New chat question",
      content: "New chat question",
      createdAt: "2026-01-01T00:02:00.000Z",
    });

    expect(first.conversation.title).toBe("First question");
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.message.turnIndex).toBe(1);
    expect(separate.conversation.id).not.toBe(first.conversation.id);
    expect(await store.listConversations("alice")).toHaveLength(2);
    store.close();
  });

  it("enforces ownership, hides foreign conversations, and rejects a deleted id", async () => {
    const store = new SqliteSessionStore(":memory:");
    const conversation = await store.createConversation("alice");
    expect(await store.getConversation("bob", conversation.id)).toBeUndefined();
    expect(await store.listConversations("bob")).toEqual([]);
    await expect(
      store.appendConversationUserMessage({
        ownerId: "bob",
        conversationId: conversation.id,
        newConversationId: randomUUID(),
        messageId: randomUUID(),
        title: "Intrusion",
        content: "Intrusion",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await store.deleteConversation("bob", conversation.id)).toBe(false);
    expect(await store.deleteConversation("alice", conversation.id)).toBe(true);
    await expect(
      store.appendConversationUserMessage({
        ownerId: "alice",
        conversationId: conversation.id,
        newConversationId: randomUUID(),
        messageId: randomUUID(),
        title: "Reuse deleted chat",
        content: "Reuse deleted chat",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    store.close();
  });

  it("orders messages chronologically and links direct/durable answers idempotently", async () => {
    const store = new SqliteSessionStore(":memory:");
    const userMessage = await store.appendConversationUserMessage({
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Question one",
      content: "Question one",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const userJobId = randomUUID();
    await store.linkConversationUserMessage(
      "alice",
      userMessage.conversation.id,
      0,
      userJobId,
      "research-1",
    );
    const jobId = randomUUID();
    const assistant = {
      ownerId: "alice",
      conversationId: userMessage.conversation.id,
      turnIndex: 0,
      messageId: randomUUID(),
      content: "Answer one",
      createdAt: "2026-01-01T00:00:01.000Z",
      jobId,
      researchId: "research-1",
    };
    expect(await store.completeConversationAssistantMessage(assistant)).toBe(true);
    expect(
      await store.completeConversationAssistantMessage({ ...assistant, messageId: randomUUID() }),
    ).toBe(true);
    await store.appendConversationUserMessage({
      ownerId: "alice",
      conversationId: userMessage.conversation.id,
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Question two",
      content: "Question two",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const messages = await store.listConversationMessages("alice", userMessage.conversation.id);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Question one"],
      ["assistant", "Answer one"],
      ["user", "Question two"],
    ]);
    expect(messages[0]).toMatchObject({ jobId: userJobId, researchId: "research-1" });
    store.close();
  });

  it("deduplicates the user input by hashed idempotency key without storing the key", async () => {
    const store = new SqliteSessionStore(":memory:");
    const requestKeyHash = createHash("sha256").update("owner:key").digest("hex");
    const input = {
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Retry this",
      content: "Retry this",
      createdAt: new Date().toISOString(),
      requestKeyHash,
    };
    const first = await store.appendConversationUserMessage(input);
    const retry = await store.appendConversationUserMessage({
      ...input,
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    expect(retry.inserted).toBe(false);
    expect(retry.conversation.id).toBe(first.conversation.id);
    expect(retry.message.id).toBe(first.message.id);
    await expect(
      store.appendConversationUserMessage({ ...input, content: "A different request" }),
    ).rejects.toBeInstanceOf(ConversationIdempotencyConflictError);
    expect(await store.listConversationMessages("alice", first.conversation.id)).toHaveLength(1);
    store.close();
  });

  it("passes only bounded earlier turns from this conversation and keeps semantic memory separate", async () => {
    const store = new SqliteSessionStore(":memory:");
    const first = await store.appendConversationUserMessage({
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "First question",
      content: "First question",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.completeConversationAssistantMessage({
      ownerId: "alice",
      conversationId: first.conversation.id,
      turnIndex: 0,
      messageId: randomUUID(),
      content: "First answer",
      createdAt: "2026-01-01T00:00:01.000Z",
      jobId: randomUUID(),
      researchId: "research-1",
    });
    await store.appendConversationUserMessage({
      ownerId: "alice",
      conversationId: first.conversation.id,
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Current question",
      content: "Current question",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await store.appendConversationUserMessage({
      ownerId: "alice",
      newConversationId: randomUUID(),
      messageId: randomUUID(),
      title: "Private other chat",
      content: "Private other chat",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    const context = await store.getConversationContext("alice", first.conversation.id, 1, 12, 8000);
    const turns = JSON.parse(context) as Array<{ role: string; content: string }>;
    expect(turns).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ]);
    expect(context).not.toContain("Current question");
    expect(context).not.toContain("Private other chat");
    const bounded = await store.getConversationContext("alice", first.conversation.id, 1, 12, 256);
    expect(bounded.length).toBeLessThanOrEqual(256);
    const savedMemories = await withAuthenticatedUser(user("alice"), () =>
      store.listUserMemories(),
    );
    expect(savedMemories).toEqual([]);
    store.close();
  });
});

describe("authenticated conversation API and chat context", () => {
  it("creates and deletes authenticated conversation records", async () => {
    const store = new SqliteSessionStore(":memory:");
    const alice = randomUUID();
    const app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      authVerifier: {
        verifyAccessToken: async (token) => (token === "alice-token" ? { id: alice } : undefined),
      },
      memoryService: {
        enabled: false,
        retrieveForQuestion: async () => ({ needed: false, memories: [] }),
      } as never,
    });
    openApps.push(app);
    const headers = { authorization: "Bearer alice-token" };
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers,
      payload: { title: "A new thread" },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json<{ conversation: { id: string; title: string } }>()
      .conversation.id;
    expect(created.json<{ conversation: { title: string } }>().conversation.title).toBe(
      "A new thread",
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/conversations/${conversationId}`,
          headers,
        })
      ).json<{ messages: unknown[] }>().messages,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/conversations/${conversationId}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/conversations/${conversationId}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("persists direct answers in one conversation, replays idempotently, and isolates users", async () => {
    const store = new SqliteSessionStore(":memory:");
    const alice = randomUUID();
    const bob = randomUUID();
    const model = new OpenRouterProvider();
    vi.spyOn(model, "enabled", "get").mockReturnValue(true);
    const modelInputs: string[] = [];
    const search = vi.fn(async () => []);
    vi.spyOn(model, "complete").mockImplementation(async (_system, input) => {
      modelInputs.push(input);
      return input.includes("What was the first question I asked?")
        ? "Your first question was: Explain closures in JavaScript."
        : "Closures preserve access to lexical variables.";
    });
    const app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      searchProvider: { search },
      llmProvider: model,
      authVerifier: {
        verifyAccessToken: async (token) =>
          token === "alice-token" ? { id: alice } : token === "bob-token" ? { id: bob } : undefined,
      },
      memoryService: {
        enabled: false,
        retrieveForQuestion: async () => ({ needed: false, memories: [] }),
      } as never,
      quotaPolicy: new QuotaPolicy(
        JSON.stringify({
          default: {
            quotas: {
              research: { limit: 20, windowSeconds: 3600 },
              deep_research: { limit: 20, windowSeconds: 3600 },
              followup: { limit: 20, windowSeconds: 3600 },
            },
            features: { research: true, deepResearch: true, postFollowUps: true },
          },
        }),
      ),
      researchBudget: {
        maxSteps: 3,
        maxQueries: 1,
        maxSources: 1,
        maxPages: 1,
        maxSearchPasses: 0,
        maxModelDecisions: 0,
        maxTimeMs: 1000,
      },
    });
    openApps.push(app);
    const worker = getServerBackgroundServices(app).worker;
    const aliceHeaders = { authorization: "Bearer alice-token" };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...aliceHeaders, "idempotency-key": "turn-one" },
      payload: { message: "Explain closures in JavaScript." },
    });
    expect([200, 202]).toContain(firstResponse.statusCode);
    const first = firstResponse.json<{
      conversationId: string;
      jobId: string;
      researchId: string;
    }>();
    expect(first.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    await worker.runNow(first.jobId);
    await waitForJob(app, first.jobId);

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...aliceHeaders, "idempotency-key": "turn-two" },
      payload: {
        conversationId: first.conversationId,
        message: "What was the first question I asked?",
      },
    });
    expect([200, 202]).toContain(secondResponse.statusCode);
    const second = secondResponse.json<{ conversationId: string; jobId: string }>();
    expect(second.conversationId).toBe(first.conversationId);
    await worker.runNow(second.jobId);
    await waitForJob(app, second.jobId);
    expect(modelInputs.at(-1)).toContain("Explain closures in JavaScript.");
    expect(modelInputs.at(-1)).toContain("Closures preserve access to lexical variables.");
    expect(modelInputs.at(-1)).not.toContain('"content":"What was the first question I asked?"');

    const researchedResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...aliceHeaders, "idempotency-key": "turn-three" },
      payload: {
        conversationId: first.conversationId,
        message: "Compare current HNSW and IVF performance with citations.",
      },
    });
    expect(researchedResponse.statusCode).toBe(202);
    const researched = researchedResponse.json<{ conversationId: string; jobId: string }>();
    await worker.runNow(researched.jobId);
    await waitForJob(app, researched.jobId);
    expect(search).toHaveBeenCalled();
    expect(researched.conversationId).toBe(first.conversationId);

    const historyResponse = await app.inject({
      method: "GET",
      url: `/api/conversations/${first.conversationId}`,
      headers: aliceHeaders,
    });
    expect(historyResponse.statusCode).toBe(200);
    const history = historyResponse.json<{
      messages: Array<{ role: string; content: string; jobId?: string; researchId?: string }>;
    }>();
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history.messages[0]?.content).toBe("Explain closures in JavaScript.");
    expect(history.messages[1]).toMatchObject({ jobId: first.jobId, researchId: first.researchId });
    expect(history.messages[5]).toMatchObject({ jobId: researched.jobId });

    const newChatResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...aliceHeaders, "idempotency-key": "new-chat-one" },
      payload: { message: "Explain iteration in JavaScript." },
    });
    expect([200, 202]).toContain(newChatResponse.statusCode);
    const newChat = newChatResponse.json<{ conversationId: string; jobId: string }>();
    expect(newChat.conversationId).not.toBe(first.conversationId);
    await worker.runNow(newChat.jobId);
    await waitForJob(app, newChat.jobId);
    expect(modelInputs.at(-1)).not.toContain("Explain closures in JavaScript.");

    const replay = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { ...aliceHeaders, "idempotency-key": "turn-one" },
      payload: { message: "Explain closures in JavaScript." },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ conversationId: string }>().conversationId).toBe(first.conversationId);
    const afterReplay = await app.inject({
      method: "GET",
      url: `/api/conversations/${first.conversationId}`,
      headers: aliceHeaders,
    });
    expect(afterReplay.json<{ messages: unknown[] }>().messages).toHaveLength(6);

    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/conversations/${first.conversationId}`,
      headers: { authorization: "Bearer bob-token" },
    });
    expect(foreignRead.statusCode).toBe(404);
    const foreignAppend = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: "Bearer bob-token" },
      payload: { conversationId: first.conversationId, message: "Read another user's chat" },
    });
    expect(foreignAppend.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: aliceHeaders,
    });
    expect(
      list.json<{ conversations: Array<{ id: string }> }>().conversations.map((item) => item.id),
    ).toEqual(expect.arrayContaining([first.conversationId, newChat.conversationId]));
  });
});
