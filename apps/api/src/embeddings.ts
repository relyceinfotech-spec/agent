import { config } from "./config.js";
import { readBoundedBytes } from "./security.js";

export interface EmbeddingUsage {
  promptTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface EmbeddingBatch {
  model: string;
  vectors: number[][];
  usage?: EmbeddingUsage;
}

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly model: string;
  embedMany(texts: string[]): Promise<EmbeddingBatch>;
}

export interface OpenRouterEmbeddingProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

interface OpenRouterEmbeddingResponse {
  model?: unknown;
  data?: Array<{ index?: unknown; embedding?: unknown }>;
  usage?: {
    prompt_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
  };
}

export type EmbeddingResponseInvalidReason =
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_response_shape"
  | "invalid_batch"
  | "invalid_index"
  | "invalid_vector";

export class EmbeddingResponseInvalidError extends Error {
  readonly code = "EMBEDDING_RESPONSE_INVALID";

  constructor(readonly reason: EmbeddingResponseInvalidReason) {
    super("Embedding provider returned an invalid response");
    this.name = "EmbeddingResponseInvalidError";
  }
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "openrouter";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenRouterEmbeddingProviderOptions = {}) {
    this.apiKey = options.apiKey ?? config.OPENROUTER_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? config.EMBEDDING_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? config.EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? config.EMBEDDING_DIMENSIONS;
    this.timeoutMs = options.timeoutMs ?? config.EMBEDDING_TIMEOUT_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async embedMany(texts: string[]): Promise<EmbeddingBatch> {
    if (!this.apiKey) throw new Error("Embedding provider is not configured");
    if (texts.length === 0 || texts.length > config.MEMORY_MAX_EMBEDDING_BATCH) {
      throw new Error("Embedding batch is outside the configured limit");
    }
    if (
      texts.some(
        (text) =>
          typeof text !== "string" ||
          text.trim().length === 0 ||
          text.length > config.MEMORY_MAX_TEXT_CHARS,
      )
    ) {
      throw new Error("Embedding input is outside the configured text limit");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
          "HTTP-Referer": config.WEB_URL,
          "X-Title": "Research Agent MAX",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
          encoding_format: "float",
        }),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the HTTP status without logging a potentially sensitive body.
        }
        throw new Error(`Embedding provider returned HTTP ${response.status}`);
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBytes(response, 256 * 1024, this.timeoutMs);
      } catch (error) {
        if (error instanceof Error && /timed out/i.test(error.message)) {
          throw new Error("Embedding provider request timed out");
        }
        if (
          error instanceof Error &&
          /response body is empty|content-size limit/i.test(error.message)
        ) {
          throw new EmbeddingResponseInvalidError("invalid_response_shape");
        }
        throw error;
      }
      let responseText: string;
      try {
        responseText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new EmbeddingResponseInvalidError("invalid_utf8");
      }

      let body: OpenRouterEmbeddingResponse;
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new EmbeddingResponseInvalidError("invalid_response_shape");
        }
        body = parsed as OpenRouterEmbeddingResponse;
      } catch (error) {
        if (error instanceof EmbeddingResponseInvalidError) throw error;
        throw new EmbeddingResponseInvalidError("invalid_json");
      }

      const responseModel = body?.model;
      if (
        typeof responseModel !== "string" ||
        responseModel.length > 120 ||
        !/^[a-z0-9][a-z0-9_.:/+-]*$/i.test(responseModel)
      ) {
        throw new EmbeddingResponseInvalidError("invalid_response_shape");
      }
      if (!Array.isArray(body?.data) || body.data.length !== texts.length) {
        throw new EmbeddingResponseInvalidError("invalid_batch");
      }

      const ordered: Array<{ index: number; embedding: unknown }> = new Array(texts.length);
      for (const item of body.data) {
        if (!item || typeof item !== "object") {
          throw new EmbeddingResponseInvalidError("invalid_batch");
        }
        if (
          typeof item.index !== "number" ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= texts.length ||
          ordered[item.index] !== undefined
        ) {
          throw new EmbeddingResponseInvalidError("invalid_index");
        }
        ordered[item.index] = { index: item.index, embedding: item.embedding };
      }

      if (ordered.some((item) => item === undefined)) {
        throw new EmbeddingResponseInvalidError("invalid_index");
      }

      const vectors = ordered.map((item) => {
        if (
          !Array.isArray(item.embedding) ||
          item.embedding.length !== this.dimensions ||
          !item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          throw new EmbeddingResponseInvalidError("invalid_vector");
        }
        return item.embedding as number[];
      });

      return {
        model: responseModel,
        vectors,
        usage: {
          promptTokens: finiteTokenCount(body.usage?.prompt_tokens),
          totalTokens: finiteTokenCount(body.usage?.total_tokens),
          costUsd: finiteTokenCount(body.usage?.cost),
        },
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Embedding provider request timed out");
      if (error instanceof Error) throw error;
      throw new Error("Embedding provider request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createEmbeddingProvider(): EmbeddingProvider | undefined {
  if (!config.MEMORY_ENABLED || !config.OPENROUTER_API_KEY) return undefined;
  if (config.EMBEDDING_PROVIDER === "openrouter") return new OpenRouterEmbeddingProvider();
  return undefined;
}
