import { describe, expect, it } from "vitest";
import type { ResearchSession } from "../src/domain.js";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import { createToolRegistry, ToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { ResearchRunner } from "../src/research.js";
import { MemorySessionStore } from "../src/store.js";

function mockSession(question: string, mode: ResearchSession["mode"]): ResearchSession {
  const now = new Date().toISOString();
  return {
    id: "mock-session-id",
    question,
    mode,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    sources: [],
    claims: [],
    conflicts: [],
    steps: [],
  };
}

describe("Single-Chat Autonomous Agent (Zero User Modes)", () => {
  it("simple question → autonomous direct answer", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => mockSession(question, mode),
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    // User asks without any mode selector
    const res = await agent.handle("Explain JavaScript closures simply.", false);

    expect(res.route).toBe("direct");
    expect(res.toolEvents.some((e) => e.tool === "web_search")).toBe(false);
    expect(res.toolEvents.some((e) => e.tool === "synthesize")).toBe(true);
    expect(res.answer).toBeDefined();
  });

  it("current question → autonomous web search", async () => {
    const llm = new OpenRouterProvider();
    const registry = new ToolRegistry();
    registry.register({
      name: "understand_query",
      description: "fixture query interpretation",
      execute: async () => ({
        normalizedQuestion: "What's the latest React version?",
        intent: "Find the current React release",
        entities: ["React"],
        topic: "React",
        timeframe: "latest",
        dimensions: ["release"],
        corrections: [],
        ambiguityScore: 0,
        ambiguityReasons: [],
        needsClarification: false,
        formatPreference: "lookup",
      }),
    });
    registry.register({
      name: "web_search",
      description: "fixture source discovery",
      execute: async () => [
        {
          title: "React Versions – official documentation",
          url: "https://react.dev/versions",
          snippet: "Official React versions",
        },
        {
          title: "React package metadata – npm registry",
          url: "https://registry.npmjs.org/react/latest",
          snippet: "Latest React package metadata",
        },
      ],
    });
    registry.register({
      name: "fetch_url",
      description: "fixture source retrieval",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "fixture" }),
    });
    registry.register({
      name: "extract_content",
      description: "fixture source extraction",
      execute: async (input) => ({
        content: (input as { url: string }).url.includes("npmjs")
          ? "Source: react. Published version or release tag: 19.3.0."
          : "Official React release history.",
      }),
    });
    registry.register({
      name: "synthesize",
      description: "unused for structured React version lookup",
      execute: async () => "Unexpected synthesis call",
    });
    let runnerCalled = false;
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => {
        runnerCalled = true;
        return mockSession(question, mode);
      },
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    // User asks without choosing a "web search mode"
    const res = await agent.handle("What's the latest React version?", false);

    expect(res.route).toBe("web");
    // Handled autonomously via fast web retrieval without requiring heavy manual research runner
    expect(runnerCalled).toBe(false);
    expect(res.toolEvents.some((e) => e.tool === "web_search")).toBe(true);
    expect(res.session?.status).toBe("COMPLETED");
    expect(res.sources?.length).toBeGreaterThanOrEqual(1);
    expect(res.answer).toContain("19.3.0");

    // Verify session stored for cited sources
    const stored = await store.get(res.researchId!);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("COMPLETED");
  });

  it("complex question → autonomous deeper research", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );
    let runnerCalled = false;
    let runnerMode: string | undefined;
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => {
        runnerCalled = true;
        runnerMode = mode;
        return mockSession(question, mode);
      },
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    // User asks a comparative question in the same normal chat
    const res = await agent.handle("Compare React Native vs Flutter for a startup.", false);

    expect(res.route).toBe("web");
    expect(runnerCalled).toBe(true);
    expect(runnerMode).toBe("quick");
    expect(res.researchId).toBe("mock-session-id");
  });

  it("Deep Research button → same autonomous agent with larger budget", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );
    let runnerCalled = false;
    let runnerMode: string | undefined;
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => {
        runnerCalled = true;
        runnerMode = mode;
        return mockSession(question, mode);
      },
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    // User toggled the one manual override: [ Deep Research ]
    const res = await agent.handle("React Native vs Flutter", true);

    expect(res.route).toBe("deep");
    expect(runnerCalled).toBe(true);
    expect(runnerMode).toBe("deep"); // same agent receives larger depth budget
  });

  it("no LOW/MEDIUM/HIGH user-facing modes exist in API contracts", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => mockSession(question, mode),
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    const directRes = await agent.handle("Explain JavaScript closures simply.", false);
    const lookupRes = await agent.handle("What's the latest React version?", false);

    // Neither response contains an 'effort' property exposed to user/client
    expect((directRes as Record<string, unknown>).effort).toBeUndefined();
    expect((lookupRes as Record<string, unknown>).effort).toBeUndefined();

    // Tool events never mention low/medium/high effort concepts
    for (const event of [...directRes.toolEvents, ...lookupRes.toolEvents]) {
      expect(event.message.toLowerCase()).not.toContain("effort");
      expect(event.message.toLowerCase()).not.toContain("low");
      expect(event.message.toLowerCase()).not.toContain("medium");
      expect(event.message.toLowerCase()).not.toContain("high");
    }
  });

  it("user never needs to manually choose web search", async () => {
    const llm = new OpenRouterProvider();
    let searchInvoked = false;
    const registry = createToolRegistry(
      {
        search: async () => {
          searchInvoked = true;
          return [];
        },
      },
      llm,
    );
    const runner = {
      start: async (question: string, mode: ResearchSession["mode"]) => mockSession(question, mode),
    } as unknown as ResearchRunner;
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(registry, runner, llm, store);

    // The user passes normal text with NO web flag
    await agent.handle("What is the latest release of Next.js?", false);
    expect(searchInvoked).toBe(true); // Agent autonomously invoked web search
  });
});
