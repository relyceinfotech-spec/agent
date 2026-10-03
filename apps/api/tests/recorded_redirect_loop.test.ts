import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: transport.fetch,
}));
import { safeFetch } from "../src/security.js";

afterEach(() => {
  vi.restoreAllMocks();
  transport.fetch.mockReset();
});
describe("local replay of the recorded source redirect loop", () => {
  it("resolves the recorded relative Location to the same URL and preserves the redirect ceiling", async () => {
    const url =
      "https://milvus.io/blog/understanding-ivf-vector-index-how-It-works-and-when-to-choose-it-over-hnsw.md";
    const location = new URL(url).pathname;
    expect(new URL(location, url).href).toBe(url);
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    transport.fetch.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(safeFetch(url, {}, 3, 1000)).rejects.toThrow(
      "Exceeded maximum redirect limit of 3",
    );
    expect(transport.fetch).toHaveBeenCalledTimes(4);
    expect(transport.fetch.mock.calls.every(([requested]) => String(requested) === url)).toBe(true);
  });
});
