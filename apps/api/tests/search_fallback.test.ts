import { describe, expect, it, vi } from "vitest";
import { SerperProvider, ResilientSearchProvider } from "../src/search.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { KnowledgeStore } from "../src/store.js";

describe("Serper search provider", () => {
  it("sends planner queries to Serper and normalizes organic results", async () => {
    const dispose = vi.fn(async () => undefined);
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://google.serper.dev/search");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-api-key")).toBe("test-serper-key");
      expect(JSON.parse(String(init.body))).toEqual({
        q: "React Native release notes",
        num: 10,
        gl: "in",
        hl: "en",
      });
      return {
        response: new Response(
          JSON.stringify({
            organic: [
              {
                title: "React Native releases",
                link: "https://reactnative.dev/blog?utm_source=serper",
                snippet: "Official release notes",
                date: "2026-09-20",
                position: 1,
              },
              { title: "Malformed result", link: "javascript:alert(1)", snippet: "Unsafe" },
              { link: "https://example.org/no-title", snippet: "No title" },
            ],
          }),
        ),
        dispose,
      };
    });
    const provider = new SerperProvider("test-serper-key", request as never);

    await expect(provider.search("React Native release notes")).resolves.toMatchObject([
      {
        title: "React Native releases",
        url: "https://reactnative.dev/blog",
        snippet: "Official release notes",
        engine: "google",
        provider: "serper",
        query: "React Native release notes",
        position: 1,
        publishedAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not send a request without credentials and reports the missing-key failure", async () => {
    const request = vi.fn();
    const search = new ResilientSearchProvider([
      { name: "serper", provider: new SerperProvider("", request as never) },
    ]);

    const batch = await search.searchDetailed("latest React version");

    expect(request).not.toHaveBeenCalled();
    expect(batch.results).toEqual([]);
    expect(batch.attempts[0]).toMatchObject({
      provider: "serper",
      status: "failed",
      errorCode: "MISSING_CREDENTIALS",
    });
    expect(batch.attempts[0].error).not.toContain("test-serper-key");
  });

  it.each([
    [401, "INVALID_CREDENTIALS"],
    [402, "CREDITS_EXHAUSTED"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const)("classifies Serper HTTP %i without exposing credentials", async (status, code) => {
    const request = vi.fn(async () => ({
      response: new Response("provider error", { status }),
      dispose: async () => undefined,
    }));
    const search = new ResilientSearchProvider([
      { name: "serper", provider: new SerperProvider("secret-test-value", request as never) },
    ]);

    const batch = await search.searchDetailed("bounded test query");

    expect(batch.attempts[0]).toMatchObject({ status: "failed", errorCode: code });
    expect(batch.attempts[0].error).not.toContain("secret-test-value");
  });

  it("deduplicates normalized results and preserves provider provenance", async () => {
    const search = new ResilientSearchProvider([
      {
        name: "serper",
        provider: {
          search: async () => [
            {
              title: "Official documentation",
              url: "https://example.org/docs?utm_source=x",
              snippet: "Docs",
            },
            { title: "Duplicate", url: "https://example.org/docs", snippet: "More detail" },
          ],
        },
      },
    ]);

    const batch = await search.searchDetailed("official documentation");

    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]).toMatchObject({
      url: "https://example.org/docs",
      provider: "serper",
      providers: ["serper"],
    });
    expect(batch.results[0].snippet).toBe("More detail");
  });

  it("continues to the next planned query after an individual search failure", async () => {
    const registry = createToolRegistry(
      {
        search: async (query) => {
          if (query === "bad query") throw new Error("upstream failed");
          return [{ title: "Result", url: "https://example.org", snippet: "Useful" }];
        },
      },
      new OpenRouterProvider(),
    );
    const attempts: string[] = [];

    const results = await registry.execute("web_search", {
      queries: ["bad query", "good query"],
      onSearchAttempt: (attempt: { status: string }) => attempts.push(attempt.status),
    });

    expect(attempts).toEqual(["failed", "success"]);
    expect(results).toHaveLength(1);
  });

  it("reports complete provider failure instead of silently returning no matches", async () => {
    const registry = createToolRegistry(
      {
        search: async () => {
          throw new Error("unavailable");
        },
      },
      new OpenRouterProvider(),
    );

    await expect(registry.execute("web_search", { queries: ["test query"] })).rejects.toThrow(
      "All search providers failed",
    );
  });

  it("uses fresh local knowledge when Serper is unavailable and records both paths", async () => {
    const request = vi.fn();
    const knowledge: KnowledgeStore = {
      getDocument: async () => undefined,
      saveDocument: async () => undefined,
      searchDocuments: async () => [
        {
          url: "https://react.dev/versions",
          title: "React versions",
          content: "The local cache contains the official React release history.",
          rawHtml: "",
          fetchedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          contentHash: "test-hash",
          version: 1,
        },
      ],
    };
    const attempts: Array<{ provider: string; status: string; errorCode?: string }> = [];
    const registry = createToolRegistry(
      new ResilientSearchProvider([
        { name: "serper", provider: new SerperProvider("", request as never) },
      ]),
      new OpenRouterProvider(),
      knowledge,
    );

    const results = await registry.execute("web_search", {
      queries: ["latest React version"],
      onSearchAttempt: (attempt: { provider: string; status: string; errorCode?: string }) =>
        attempts.push(attempt),
    });

    expect(results).toMatchObject([
      {
        title: "React versions",
        provider: "internal-knowledge",
        url: "https://react.dev/versions",
      },
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(attempts).toMatchObject([
      { provider: "serper", status: "failed", errorCode: "MISSING_CREDENTIALS" },
      { provider: "internal-knowledge", status: "success" },
    ]);
  });

  it("merges fresh internal knowledge with successful Serper results and preserves provenance", async () => {
    const knowledge: KnowledgeStore = {
      getDocument: async () => undefined,
      saveDocument: async () => undefined,
      searchDocuments: async () => [
        {
          url: "https://example.org/current?utm_source=cache",
          title: "Cached current result",
          content:
            "The cached React version article has longer, previously verified supporting detail.",
          rawHtml: "",
          fetchedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          contentHash: "test-hash",
          version: 1,
        },
        {
          url: "https://react.dev/versions",
          title: "Cached official version history",
          content: "A recently fetched official React version history.",
          rawHtml: "",
          fetchedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          contentHash: "test-hash-2",
          version: 1,
        },
      ],
    };
    const registry = createToolRegistry(
      new ResilientSearchProvider([
        {
          name: "serper",
          provider: {
            search: async () => [
              {
                title: "Live current result",
                url: "https://example.org/current",
                snippet: "A live search result.",
                provider: "serper",
              },
            ],
          },
        },
      ]),
      new OpenRouterProvider(),
      knowledge,
    );
    const attempts: Array<{ provider: string; status: string }> = [];

    const results = (await registry.execute("web_search", {
      queries: ["current React version"],
      onSearchAttempt: (attempt: { provider: string; status: string }) => attempts.push(attempt),
    })) as Array<{ url: string; provider?: string; providers?: string[]; snippet: string }>;

    expect(results).toHaveLength(2);
    expect(results.find((result) => result.url === "https://example.org/current")).toMatchObject({
      provider: "serper",
      providers: ["serper", "internal-knowledge"],
      snippet: "A live search result.",
    });
    expect(results.map((result) => result.url)).toContain("https://react.dev/versions");
    expect(attempts).toMatchObject([
      { provider: "serper", status: "success" },
      { provider: "internal-knowledge", status: "success" },
    ]);
  });

  it("keeps live results when the internal knowledge lookup fails", async () => {
    const registry = createToolRegistry(
      new ResilientSearchProvider([
        {
          name: "serper",
          provider: {
            search: async () => [
              {
                title: "Live source",
                url: "https://example.org/live",
                snippet: "Serper returned a usable result.",
              },
            ],
          },
        },
      ]),
      new OpenRouterProvider(),
      {
        getDocument: async () => undefined,
        saveDocument: async () => undefined,
        searchDocuments: async () => {
          throw new Error("Local knowledge index unavailable");
        },
      },
    );
    const attempts: Array<{ provider: string; status: string }> = [];

    const results = (await registry.execute("web_search", {
      queries: ["current information"],
      onSearchAttempt: (attempt: { provider: string; status: string }) => attempts.push(attempt),
    })) as Array<{ url: string }>;

    expect(results).toMatchObject([{ url: "https://example.org/live" }]);
    expect(attempts).toMatchObject([
      { provider: "serper", status: "success" },
      { provider: "internal-knowledge", status: "failed" },
    ]);
  });
});
