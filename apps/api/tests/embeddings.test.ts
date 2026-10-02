import { describe, expect, it, vi } from "vitest";
import { OpenRouterEmbeddingProvider } from "../src/embeddings.js";

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "test-embedding-model",
    data: [
      { index: 0, embedding: [0.1, 0.2, 0.3] },
      { index: 1, embedding: [0.4, 0.5, 0.6] },
    ],
    usage: { prompt_tokens: 7, total_tokens: 7, cost: 0.00001 },
    ...overrides,
  };
}

function makeProvider(fetchImplementation: typeof fetch) {
  return new OpenRouterEmbeddingProvider({
    apiKey: "test-only-key",
    baseUrl: "https://openrouter.test/api/v1",
    model: "test-embedding-model",
    dimensions: 3,
    timeoutMs: 100,
    fetchImplementation,
  });
}

async function expectInvalidResponse(operation: Promise<unknown>, reason: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    code: "EMBEDDING_RESPONSE_INVALID",
    reason,
  });
}

describe("OpenRouter embedding adapter", () => {
  it("posts a bounded batch and returns vectors in input order with usage", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(
        JSON.stringify(
          responseBody({
            data: [
              { index: 1, embedding: [0.4, 0.5, 0.6] },
              { index: 0, embedding: [0.1, 0.2, 0.3] },
            ],
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = makeProvider(fetchImplementation);
    const result = await provider.embedMany(["first input", "second input"]);

    expect(requestUrl).toBe("https://openrouter.test/api/v1/embeddings");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
    expect(new Headers(requestInit?.headers).get("accept-encoding")).toBe("identity");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: "test-embedding-model",
      input: ["first input", "second input"],
      dimensions: 3,
      encoding_format: "float",
    });
    expect(result.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7, costUsd: 0.00001 });
  });

  it("rejects vectors with the wrong configured dimension", async () => {
    const invalidVector = makeProvider(
      async () =>
        new Response(
          JSON.stringify({
            model: "test-embedding-model",
            data: [{ index: 0, embedding: [1, 2] }],
          }),
          { status: 200 },
        ),
    );
    await expectInvalidResponse(invalidVector.embedMany(["one input"]), "invalid_vector");
  });

  it("preserves the provider-reported model identifier", async () => {
    const resolvedModel = makeProvider(
      async () =>
        new Response(
          JSON.stringify({
            model: "openai/text-embedding-3-small",
            data: [{ index: 0, embedding: [1, 2, 3] }],
          }),
          { status: 200 },
        ),
    );
    await expect(resolvedModel.embedMany(["one input"])).resolves.toMatchObject({
      model: "openai/text-embedding-3-small",
      vectors: [[1, 2, 3]],
    });
  });

  it("rejects missing or malformed provider-reported model identifiers", async () => {
    for (const model of [undefined, "", "invalid model", "x".repeat(121)]) {
      const invalidModel = makeProvider(
        async () =>
          new Response(JSON.stringify({ model, data: [{ index: 0, embedding: [1, 2, 3] }] }), {
            status: 200,
          }),
      );
      await expectInvalidResponse(invalidModel.embedMany(["one input"]), "invalid_response_shape");
    }
  });

  it("classifies invalid UTF-8 and non-JSON success bodies", async () => {
    const invalidJson = makeProvider(
      async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expectInvalidResponse(invalidJson.embedMany(["one input"]), "invalid_json");

    const binary = makeProvider(
      async () =>
        new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    await expectInvalidResponse(binary.embedMany(["one input"]), "invalid_utf8");
  });

  it("rejects a malformed compressed success body without guessing a decoder", async () => {
    const malformedCompressed = makeProvider(
      async () =>
        new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        }),
    );

    await expectInvalidResponse(malformedCompressed.embedMany(["one input"]), "invalid_utf8");
  });

  it("rejects a missing data array and a missing embedding vector", async () => {
    const missingData = makeProvider(
      async () => new Response(JSON.stringify({ model: "test-embedding-model" }), { status: 200 }),
    );
    await expectInvalidResponse(missingData.embedMany(["one input"]), "invalid_batch");

    const missingEmbedding = makeProvider(
      async () =>
        new Response(JSON.stringify({ model: "test-embedding-model", data: [{ index: 0 }] }), {
          status: 200,
        }),
    );
    await expectInvalidResponse(missingEmbedding.embedMany(["one input"]), "invalid_vector");
  });

  it("rejects missing, duplicate, and out-of-range result indexes", async () => {
    for (const data of [
      [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      [
        { index: 0, embedding: [0.1, 0.2, 0.3] },
        { index: 0, embedding: [0.4, 0.5, 0.6] },
      ],
      [
        { index: 2, embedding: [0.1, 0.2, 0.3] },
        { index: 0, embedding: [0.4, 0.5, 0.6] },
      ],
    ]) {
      const provider = makeProvider(
        async () =>
          new Response(JSON.stringify({ model: "test-embedding-model", data }), { status: 200 }),
      );
      await expectInvalidResponse(provider.embedMany(["first", "second"]), "invalid_index");
    }
  });

  it("reports provider status without copying an error response body", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response("private provider error body", { status: 429 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImplementation);

    await expect(provider.embedMany(["short query"])).rejects.toThrow("HTTP 429");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-request abort timeout", async () => {
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: "test-only-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "test-embedding-model",
      dimensions: 3,
      timeoutMs: 5,
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    await expect(provider.embedMany(["short query"])).rejects.toThrow("request timed out");
  });

  it("does not make a provider call when no backend key is configured", async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: "",
      baseUrl: "https://openrouter.test/api/v1",
      model: "test-embedding-model",
      dimensions: 3,
      fetchImplementation,
    });

    await expect(provider.embedMany(["short query"])).rejects.toThrow(/not configured/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("does not replace global fetch while making an embedding request", async () => {
    const previousFetch = globalThis.fetch;
    const provider = makeProvider(
      async () =>
        new Response(
          JSON.stringify({
            model: "test-embedding-model",
            data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          }),
          {
            status: 200,
          },
        ),
    );

    await provider.embedMany(["one input"]);

    expect(globalThis.fetch).toBe(previousFetch);
  });
});
