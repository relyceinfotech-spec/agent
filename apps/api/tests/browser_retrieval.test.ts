import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The fixture is loopback-only. Production browserFetch uses the real SSRF guard.
vi.mock("../src/security.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/security.js")>()),
  assertSafeHttpUrl: async (url: string) => new URL(url),
  safeFetchWithRetry: async (url: string, init: RequestInit) => ({
    url,
    response: await fetch(url, init),
    dispose: async () => {},
  }),
  safeFetch: async (url: string, init: RequestInit) => ({
    url,
    response: await fetch(url, init),
    dispose: async () => {},
  }),
}));

import { browserFetch } from "../src/browser.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";

const hasBrowser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].some(existsSync);

describe("browser retrieval fallback", () => {
  it.skipIf(!hasBrowser)(
    "renders a JavaScript-only page under a bounded browser run",
    async () => {
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(`<html><body><div id="root"></div><script>
        document.getElementById('root').innerHTML = '<main>Client rendered research article with substantive evidence and explanation about the topic. This text is only present after JavaScript executes in a browser.</main>';
      </script></body></html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
        const result = await browserFetch(`http://127.0.0.1:${address.port}/article`);
        expect(result.html).toContain("Client rendered research article");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    25000,
  );

  it.skipIf(!hasBrowser)(
    "routes an HTTP JavaScript shell through browser retrieval before extracting evidence",
    async () => {
      let requests = 0;
      const article =
        "The client-rendered research article reports measured performance results, describes its methodology, and explains the limitations that readers should consider before applying the findings.";
      const server = createServer((_request, response) => {
        requests += 1;
        response.setHeader("content-type", "text/html");
        response.end(`<html><head><title>Rendered benchmark</title></head><body>
          <div id="root"></div><script>
            document.getElementById('root').innerHTML = '<main><article><h1>Rendered benchmark</h1><p>${article}</p></article></main>';
          </script></body></html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
        const url = `http://127.0.0.1:${address.port}/article`;
        const tools = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
        const fetched = (await tools.execute("fetch_url", { url })) as {
          url: string;
          html: string;
          retrievalMethod: string;
        };
        const extracted = (await tools.execute("extract_content", {
          url: fetched.url,
          html: fetched.html,
          contentType: "text/html",
        })) as { content: string };

        expect(fetched.retrievalMethod).toBe("browser");
        expect(fetched.html).toContain("Rendered benchmark");
        expect(extracted.content).toContain(article);
        expect(requests).toBeGreaterThanOrEqual(2);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    25000,
  );
});
