import { describe, expect, it, vi } from "vitest";
import { AutonomousAgent } from "../src/agent/autonomous.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { QueryInterpretation } from "../src/domain.js";
import { MemorySessionStore } from "../src/store.js";
import { OpenRouterProvider } from "../src/llm.js";

describe("evidence-first fast lookup", () => {
  it.each([
    "What version was React 18.2.0?",
    "What is the latest React version and its release date?",
    "What is the current Bun version?",
  ])("does not complete unsupported lookup: %s", async (question) => {
    const react = question.includes("React");
    const interpretation: QueryInterpretation = {
      normalizedQuestion: question,
      intent: "Find release information",
      entities: [react ? "React" : "Bun"],
      topic: "software release",
      dimensions: ["version"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "fixture",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "fixture",
      execute: async () => [
        {
          url: react ? "https://registry.npmjs.org/react/latest" : "https://bun.sh/blog/release",
          title: react ? "React package metadata" : "Bun release",
          snippet: "Release metadata",
        },
      ],
    });
    tools.register({
      name: "fetch_url",
      description: "fixture",
      execute: async (input) => ({
        url: (input as { url: string }).url,
        html: "fixture",
      }),
    });
    tools.register({
      name: "extract_content",
      description: "fixture",
      execute: async () => ({
        title: react ? "React package metadata" : "Bun release",
        content: react
          ? "Published version or release tag: 99.0.0"
          : "No verified current Bun release is documented.",
      }),
    });
    const llm = new OpenRouterProvider();
    const enabled = vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
    const synthesize = vi
      .spyOn(llm, "synthesize")
      .mockResolvedValue("Insufficient evidence to establish the requested version or date.");
    const validation = vi.spyOn(llm, "validateCitedAnswer");
    try {
      const response = await new AutonomousAgent(
        tools,
        {} as never,
        llm,
        new MemorySessionStore(),
      ).handle(question, false);
      expect(synthesize).toHaveBeenCalledOnce();
      expect(validation).not.toHaveBeenCalled();
      expect(response.session?.status).toBe("FAILED");
      expect(response.answer).not.toContain("99.0.0");
    } finally {
      enabled.mockRestore();
      synthesize.mockRestore();
      validation.mockRestore();
    }
  });

  it("routes explicitly required official-source lookups through the bounded research loop, not Deep mode", async () => {
    const question = "What is the latest React version? Use official React sources.";
    const interpretation: QueryInterpretation = {
      normalizedQuestion: question,
      intent: "Find current release",
      entities: ["React"],
      topic: "software release",
      timeframe: "latest",
      dimensions: ["version", "release date"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
      sourceRequirements: { officialSources: "required" },
    };
    const search = vi.fn(async () => []);
    const runner = {
      start: vi.fn(
        async () =>
          ({
            id: "official-source-quick-run",
            status: "QUEUED",
            question,
            mode: "quick",
            sources: [],
            claims: [],
            steps: [],
          }) as never,
      ),
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({ name: "web_search", description: "search", execute: search });
    const agent = new AutonomousAgent(
      tools,
      runner as never,
      new OpenRouterProvider(),
      new MemorySessionStore(),
    );

    const response = await agent.handle(question, false);

    expect(response.route).toBe("web");
    expect(runner.start).toHaveBeenCalledWith(question, "quick", [], {
      memoryContext: undefined,
      interpretation,
      researchChatOptimization: true,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps a page-title sibling mismatch out of fast-lookup synthesis", async () => {
    const question = "What is the latest React release?";
    const interpretation: QueryInterpretation = {
      normalizedQuestion: question,
      intent: "Find current release",
      entities: ["React"],
      topic: "software release",
      timeframe: "latest",
      dimensions: ["release"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const fetchedUrls: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "search",
      execute: async () => [
        {
          title: "React release overview",
          url: "https://release-index.example/releases/overview",
          snippet: "React releases, versions, and stable release history.",
        },
      ],
    });
    tools.register({
      name: "fetch_url",
      description: "fetch",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        fetchedUrls.push(url);
        return {
          url,
          html: "fixture",
          extractionStatus: "SUCCEEDED" as const,
          extractionConfidence: 0.95,
          retrievedContentLength: 120,
        };
      },
    });
    tools.register({
      name: "extract_content",
      description: "extract",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        if (url.includes("npmjs")) {
          return {
            title: "React package metadata",
            content:
              "Source: react. Published version or release tag: 19.3.0. Description: React is a user interface library.",
          };
        }
        return {
          title: "React Native Releases Overview",
          content:
            "React Native 0.84.0 is the latest stable React Native release, published on September 20, 2026.",
        };
      },
    });

    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(tools, {} as never, new OpenRouterProvider(), store);
    const response = await agent.handle(question, false);
    const session = await store.get(response.researchId!);
    const rejectedSource = session?.sources.find(
      (source) => source.title === "React Native Releases Overview",
    );

    expect(response.answer).toContain("19.3.0");
    expect(fetchedUrls).toContain("https://release-index.example/releases/overview");
    expect(rejectedSource).toMatchObject({
      title: "React Native Releases Overview",
      extractionStatus: "SUCCEEDED",
      subjectMismatchReason:
        "Candidate names React Native, a more-specific entity than the requested React.",
      taskEvidence: {
        status: "INSUFFICIENT_EVIDENCE",
        missingFacts: [
          "Candidate names React Native, a more-specific entity than the requested React.",
        ],
      },
    });
    expect(session?.sources[0]?.url).toBe("https://registry.npmjs.org/react/latest");
    expect(session?.answer).not.toContain("React Native 0.84.0");
  });

  it.each(["React", "React.js"])(
    "uses planned queries and answers a %s release version from structured evidence",
    async (entity) => {
      const question = "What is the latest React version?";
      const interpretation: QueryInterpretation = {
        normalizedQuestion: question,
        intent: "Find current release",
        entities: [entity],
        topic: "general topic",
        timeframe: "latest",
        dimensions: ["release"],
        corrections: [],
        ambiguityScore: 0,
        ambiguityReasons: [],
        needsClarification: false,
        formatPreference: "lookup",
      };
      const queries: string[] = [];
      const fetchedUrls: string[] = [];
      const synthesize = vi.fn();
      const tools = new ToolRegistry();
      tools.register({
        name: "understand_query",
        description: "understand",
        execute: async () => interpretation,
      });
      tools.register({
        name: "web_search",
        description: "search",
        execute: async (input) => {
          queries.push(...(input as { queries: string[] }).queries);
          return [
            {
              title: "React Versions – official documentation",
              url: "https://react.dev/versions",
              snippet: "Official React versions",
            },
            {
              title: "React Native Versions",
              url: "https://reactnative.dev/versions",
              snippet: "React Native release versions",
            },
          ];
        },
      });
      tools.register({
        name: "fetch_url",
        description: "fetch",
        execute: async (input) => {
          const url = (input as { url: string }).url;
          fetchedUrls.push(url);
          return { url, html: "source body" };
        },
      });
      tools.register({
        name: "extract_content",
        description: "extract",
        execute: async (input) => ({
          content: (input as { url: string }).url.includes("npmjs")
            ? "Source: react. Published version or release tag: 19.3.0. Description: React is a user interface library."
            : "The official React versions page provides release history and current documentation.",
        }),
      });
      tools.register({ name: "synthesize", description: "synthesize", execute: synthesize });
      const store = new MemorySessionStore();
      const agent = new AutonomousAgent(tools, {} as never, new OpenRouterProvider(), store);
      const response = await agent.handle(question, false);
      expect(response.route).toBe("web");
      expect(queries).not.toContain(question);
      expect(response.answer).toContain("latest published React release");
      expect(response.answer).toContain("19.3.0");
      expect(response.answer).toMatch(/\[\d+\]/);
      expect(fetchedUrls).toContain("https://registry.npmjs.org/react/latest");
      expect(fetchedUrls).toContain("https://react.dev/versions");
      expect(fetchedUrls).not.toContain("https://reactnative.dev/versions");
      expect(synthesize).not.toHaveBeenCalled();
      expect(response.toolEvents.some((event) => event.tool === "source_triage")).toBe(true);
      expect(response.researchId).toBeTruthy();
      const stored = await store.get(response.researchId!);
      expect(stored?.sources).toHaveLength(2);
      expect(
        stored?.sources.find((source) => source.url.includes("registry.npmjs.org")),
      ).toMatchObject({
        domain: "registry.npmjs.org",
        provider: "npm-registry",
        quality: { authority: expect.any(Number) },
      });
      expect(stored?.steps.map((step) => step.label)).toEqual([
        "🧠 understand_query",
        "🔎 web_search",
        "🧭 source_triage",
        "📄 fetch_url",
        "✍️ synthesize",
      ]);
    },
  );

  it("enforces evaluation query, source, and page budgets on the fast route", async () => {
    const question = "What is the latest React version?";
    const interpretation: QueryInterpretation = {
      normalizedQuestion: question,
      intent: "Find current release",
      entities: ["React"],
      topic: "general topic",
      timeframe: "latest",
      dimensions: ["release"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const queries: string[] = [];
    const fetchedUrls: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "search",
      execute: async (input) => {
        queries.push(...(input as { queries: string[] }).queries);
        return [
          {
            title: "React versions",
            url: "https://react.dev/versions",
            snippet: "Official React version history",
          },
        ];
      },
    });
    tools.register({
      name: "fetch_url",
      description: "fetch",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        fetchedUrls.push(url);
        return { url, html: "source body" };
      },
    });
    tools.register({
      name: "extract_content",
      description: "extract",
      execute: async (input) => ({
        content: (input as { url: string }).url.includes("npmjs")
          ? "Source: react. Published version or release tag: 19.3.0. Description: React is a user interface library."
          : "The official React versions page provides release history and current documentation.",
      }),
    });
    tools.register({
      name: "synthesize",
      description: "synthesize",
      execute: async () => "unused",
    });
    const limits = {
      maxSteps: 4,
      maxQueries: 1,
      maxSources: 2,
      maxPages: 1,
      maxTimeMs: 1000,
      maxClaimsToVerify: 1,
      maxModelDecisions: 1,
      maxSearchPasses: 1,
    };
    const agent = new AutonomousAgent(
      tools,
      {} as never,
      new OpenRouterProvider(),
      new MemorySessionStore(),
      limits,
    );

    const response = await agent.handle(question, false);

    expect(queries).toHaveLength(1);
    expect(queries).not.toContain(question);
    expect(fetchedUrls).toEqual(["https://registry.npmjs.org/react/latest"]);
    expect(response.sources).toHaveLength(1);
    expect(response.answer).toContain("latest published React release");
  });

  it("does not report a completed lookup when every source fetch fails", async () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "What is the latest React version?",
      intent: "Find current release",
      entities: ["React"],
      topic: "general topic",
      timeframe: "latest",
      dimensions: ["release"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "search",
      execute: async () => [
        {
          title: "React package metadata",
          url: "https://registry.npmjs.org/react/latest",
          snippet: "Current package metadata",
        },
      ],
    });
    tools.register({
      name: "fetch_url",
      description: "fetch",
      execute: async () => {
        throw new Error("fetch failed");
      },
    });
    const store = new MemorySessionStore();
    const agent = new AutonomousAgent(tools, {} as never, new OpenRouterProvider(), store);

    const response = await agent.handle("What is the latest React version?", false);
    const stored = await store.get(response.researchId!);

    expect(response.answer).toContain("couldn't verify");
    expect(stored?.status).toBe("FAILED");
    expect(stored?.error).toContain("fetch failed");
    expect(stored?.steps.find((step) => step.label.includes("fetch_url"))?.status).toBe("failed");
    expect(stored?.steps.find((step) => step.label.includes("synthesize"))?.status).toBe("failed");
    expect(response.toolEvents.find((event) => event.tool === "synthesize")?.status).toBe("failed");
  });

  it("checks a sufficient first lookup source before fetching weaker alternatives", async () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "What is the current Bun version?",
      intent: "Find a current release value",
      entities: ["Bun"],
      topic: "software release",
      timeframe: "current",
      dimensions: ["version"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const fetchedUrls: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "search",
      execute: async () => [
        {
          title: "Bun current version",
          url: "https://bun.sh/blog/current-release",
          snippet: "A short search summary.",
        },
        {
          title: "Bun release notes mirror",
          url: "https://engineering.example.org/bun-release",
          snippet: "A weaker alternate source.",
        },
      ],
    });
    tools.register({
      name: "fetch_url",
      description: "fetch",
      execute: async (input) => {
        const url = (input as { url: string }).url;
        fetchedUrls.push(url);
        return { url, html: "bounded retrieval result" };
      },
    });
    tools.register({
      name: "extract_content",
      description: "extract",
      execute: async () => ({
        content:
          "Bun 1.2.3 is the current stable runtime release, according to the official release announcement.",
      }),
    });
    const llm = {
      enabled: true,
      synthesize: vi.fn().mockResolvedValue("Bun 1.2.3 is the current stable release [1]."),
    };
    const agent = new AutonomousAgent(tools, {} as never, llm as never, new MemorySessionStore());

    await agent.handle(interpretation.normalizedQuestion, false);

    expect(fetchedUrls).toEqual(["https://bun.sh/blog/current-release"]);
  });

  it("preserves the synthesis timeout reason in the failed research record", async () => {
    const interpretation: QueryInterpretation = {
      normalizedQuestion: "What is the latest React Router version?",
      intent: "Find current release",
      entities: ["React Router"],
      topic: "software release",
      timeframe: "latest",
      dimensions: ["release"],
      corrections: [],
      ambiguityScore: 0,
      ambiguityReasons: [],
      needsClarification: false,
      formatPreference: "lookup",
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "understand_query",
      description: "understand",
      execute: async () => interpretation,
    });
    tools.register({
      name: "web_search",
      description: "search",
      execute: async () => [
        {
          title: "React Router releases",
          url: "https://reactrouter.com/start/framework/installation",
          snippet: "Official React Router documentation and release information.",
        },
      ],
    });
    tools.register({
      name: "fetch_url",
      description: "fetch",
      execute: async (input) => ({ url: (input as { url: string }).url, html: "source body" }),
    });
    tools.register({
      name: "extract_content",
      description: "extract",
      execute: async () => ({
        content:
          "React Router 7.0.0 is the current release version in this offline fixture. Consult the official release history for current package versions and compatibility details.",
      }),
    });
    const store = new MemorySessionStore();
    const llm = {
      enabled: true,
      synthesize: vi.fn().mockRejectedValue(new Error("OpenRouter request timed out")),
    };
    const agent = new AutonomousAgent(tools, {} as never, llm as never, store);

    const response = await agent.handle("What is the latest React Router version?", false);
    const stored = await store.get(response.researchId!);

    expect(stored?.status).toBe("FAILED");
    expect(stored?.error).toContain("OpenRouter request timed out");
    expect(response.toolEvents.find((event) => event.tool === "synthesize")?.message).toContain(
      "OpenRouter request timed out",
    );
  });
});
