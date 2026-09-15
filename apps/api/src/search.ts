import type { SearchResult } from "./domain.js";
import { canonicalizeUrl } from "./security.js";
import { config } from "./config.js";

export interface SearchProvider {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export class SearXNGProvider implements SearchProvider {
  constructor(private readonly baseUrl: string) {}
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const endpoint = new URL("/search", this.baseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("language", "en");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
      const body = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          engine?: string;
          publishedDate?: string;
        }>;
      };
      return (body.results ?? []).flatMap((item) => {
        if (!item.url || !item.title) return [];
        try {
          return [
            {
              title: item.title,
              url: canonicalizeUrl(item.url),
              snippet: item.content ?? "",
              engine: item.engine,
              publishedAt: item.publishedDate,
            },
          ];
        } catch {
          return [];
        }
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
