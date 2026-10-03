import type { SearchResult } from "./domain.js";
import { config } from "./config.js";
import { canonicalizeUrl, readBoundedText, safeFetchWithRetry } from "./security.js";
import type { KnowledgeStore } from "./store.js";
import { querySubjectMismatchReason } from "./query-relevance.js";
import {
  failedSearchAttempt,
  safeSearchMessage,
  searchFailureDetails,
  searchDiagnosticTrace,
} from "./search-diagnostics.js";

export type SearchFailureCode =
  | "MISSING_CREDENTIALS"
  | "INVALID_CREDENTIALS"
  | "CREDITS_EXHAUSTED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BLOCKED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "CAPTCHA"
  | "UNSUPPORTED"
  | "NETWORK_ERROR"
  | "MALFORMED_RESPONSE"
  | "SEARCH_PROVIDER_FAILURE";

export interface SearchAttempt {
  provider: string;
  query: string;
  status: "success" | "empty" | "failed";
  resultCount: number;
  durationMs: number;
  error?: string;
  errorCode?: SearchFailureCode;
  stage?: "SEARCH_PROVIDER";
  attemptNumber?: number;
  startedAt?: string;
  httpStatus?: number;
  failureType?:
    "timeout" | "network" | "http" | "malformed_response" | "configuration" | "provider";
  transportCode?: string;
}

export interface SearchBatch {
  results: SearchResult[];
  attempts: SearchAttempt[];
}

export interface SearchProvider {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  searchDetailed?(query: string, signal?: AbortSignal): Promise<SearchBatch>;
}

export class SearchProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
    readonly code?: SearchFailureCode,
    readonly httpStatus?: number,
    readonly cause?: unknown,
  ) {
    super(`${provider}: ${reason}`);
    this.name = "SearchProviderError";
  }
}

/** Google web discovery through Serper; MAX fetches and evaluates result pages itself. */
export class SerperProvider implements SearchProvider {
  constructor(
    private readonly apiKey = config.SERPER_API_KEY,
    private readonly request: typeof safeFetchWithRetry = safeFetchWithRetry,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!this.apiKey?.trim()) {
      throw new SearchProviderError(
        "serper",
        "SERPER_API_KEY is not configured",
        "MISSING_CREDENTIALS",
      );
    }

    let fetched: Awaited<ReturnType<typeof this.request>>;
    try {
      fetched = await this.request(
        "https://google.serper.dev/search",
        {
          method: "POST",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: JSON.stringify({
            q: query,
            num: 10,
            gl: config.SERPER_GL,
            hl: config.SERPER_HL,
          }),
        },
        0,
        config.FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      const details = searchFailureDetails(error);
      throw new SearchProviderError(
        "serper",
        safeSearchMessage(error, [this.apiKey]),
        details.errorCode,
        details.httpStatus,
        error,
      );
    }
    const { response, dispose } = fetched;

    try {
      if (!response.ok) {
        const code: SearchFailureCode =
          response.status === 401 || response.status === 403
            ? "INVALID_CREDENTIALS"
            : response.status === 402
              ? "CREDITS_EXHAUSTED"
              : response.status === 429
                ? "RATE_LIMITED"
                : response.status >= 500
                  ? "PROVIDER_UNAVAILABLE"
                  : "SEARCH_PROVIDER_FAILURE";
        throw new SearchProviderError(
          "serper",
          `Serper returned HTTP ${response.status}`,
          code,
          response.status,
        );
      }

      const body = await readBoundedText(response, 2_000_000, config.FETCH_TIMEOUT_MS);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new SearchProviderError(
          "serper",
          "Serper returned malformed JSON",
          "MALFORMED_RESPONSE",
          response.status,
        );
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        ("organic" in parsed && !Array.isArray(parsed.organic))
      ) {
        throw new SearchProviderError(
          "serper",
          "Serper returned a malformed search response",
          "MALFORMED_RESPONSE",
          response.status,
        );
      }
      const payload = parsed as {
        organic?: Array<{
          title?: string;
          link?: string;
          snippet?: string;
          date?: string;
          position?: number;
        }>;
      };
      const discoveredAt = new Date().toISOString();
      return (payload.organic ?? []).slice(0, 10).flatMap((item) => {
        if (
          !item ||
          typeof item !== "object" ||
          (item.title !== undefined && typeof item.title !== "string") ||
          (item.link !== undefined && typeof item.link !== "string") ||
          (item.snippet !== undefined && typeof item.snippet !== "string")
        ) {
          throw new SearchProviderError(
            "serper",
            "Serper returned a malformed search result",
            "MALFORMED_RESPONSE",
            response.status,
          );
        }
        const title = item.title?.trim();
        if (!title || !item.link) return [];
        try {
          const url = canonicalizeUrl(item.link);
          const parsed = new URL(url);
          if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return [];
          const parsedDate = item.date ? Date.parse(item.date) : Number.NaN;
          return [
            {
              title,
              url,
              snippet: item.snippet?.trim() ?? "",
              publishedAt: Number.isFinite(parsedDate)
                ? new Date(parsedDate).toISOString()
                : undefined,
              position: Number.isSafeInteger(item.position) ? item.position : undefined,
              engine: "google",
              provider: "serper",
              query,
              discoveredAt,
            },
          ];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError(
        "serper",
        safeSearchMessage(error, [this.apiKey]),
        searchFailureDetails(error).errorCode,
        response.status,
        error,
      );
    } finally {
      await dispose();
    }
  }
}

/** Retrieves previously fetched documents; this is local knowledge lookup, not a web provider. */
export class InternalKnowledgeProvider implements SearchProvider {
  constructor(
    private readonly knowledge: KnowledgeStore,
    private readonly maxAgeMs = 30 * 24 * 60 * 60 * 1000,
  ) {}

  async search(query: string): Promise<SearchResult[]> {
    const documents = await this.knowledge.searchDocuments(query, this.maxAgeMs, 10);
    return documents
      .filter(
        (document) =>
          !querySubjectMismatchReason(query, `${document.title} ${document.content.slice(0, 800)}`),
      )
      .map((document) => ({
        title: document.title,
        url: document.url,
        snippet: document.content.slice(0, 800),
        publishedAt: document.publishedAt,
        provider: "internal-knowledge",
        query,
        discoveredAt: document.lastVerifiedAt,
      }));
  }
}

/** Normalizes and deduplicates provider results while preserving attempt provenance. */
export class ResilientSearchProvider implements SearchProvider {
  constructor(private readonly providers: Array<{ name: string; provider: SearchProvider }>) {
    if (providers.length === 0) throw new Error("At least one search provider is required");
  }

  async searchDetailed(query: string, signal?: AbortSignal): Promise<SearchBatch> {
    const attempts: SearchAttempt[] = [];
    const merged = new Map<string, SearchResult>();
    for (const { name, provider } of this.providers) {
      if (signal?.aborted) break;
      const started = performance.now();
      const startedAt = new Date().toISOString();
      try {
        const results = await provider.search(query, signal);
        let discardedResults = 0;
        const normalized = results.flatMap((result) => {
          try {
            if (
              !result ||
              typeof result.title !== "string" ||
              typeof result.url !== "string" ||
              typeof result.snippet !== "string"
            ) {
              discardedResults += 1;
              return [];
            }
            const url = canonicalizeUrl(result.url);
            const parsedUrl = new URL(url);
            if (
              !["http:", "https:"].includes(parsedUrl.protocol) ||
              parsedUrl.username.length > 0 ||
              parsedUrl.password.length > 0
            ) {
              discardedResults += 1;
              return [];
            }
            return [
              {
                ...result,
                url,
                provider: result.provider ?? name,
                providers: [result.provider ?? name],
                query: result.query ?? query,
                discoveredAt: result.discoveredAt ?? new Date().toISOString(),
              },
            ];
          } catch {
            discardedResults += 1;
            return [];
          }
        });
        const unique = [...new Map(normalized.map((result) => [result.url, result])).values()];
        for (const result of unique) {
          const previous = merged.get(result.url);
          merged.set(
            result.url,
            previous
              ? {
                  ...previous,
                  providers: [
                    ...new Set([...(previous.providers ?? [previous.provider ?? name]), name]),
                  ],
                  snippet:
                    previous.snippet.length >= result.snippet.length
                      ? previous.snippet
                      : result.snippet,
                }
              : result,
          );
        }
        attempts.push({
          provider: name,
          stage: "SEARCH_PROVIDER",
          startedAt,
          query,
          status: unique.length ? "success" : "empty",
          resultCount: unique.length,
          durationMs: Math.round(performance.now() - started),
          error: discardedResults
            ? `${discardedResults} invalid search result${discardedResults === 1 ? "" : "s"} discarded`
            : undefined,
        });
        if (merged.size >= 8) break;
      } catch (error) {
        attempts.push(failedSearchAttempt(name, query, error, started, startedAt));
      }
    }
    return { results: [...merged.values()], attempts: searchDiagnosticTrace(attempts) };
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    return (await this.searchDetailed(query, signal)).results;
  }
}
