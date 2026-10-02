import { describe, expect, it } from "vitest";
import { assertSafeHttpUrl, canonicalizeUrl, privateIp, safeFetch } from "../src/security.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import { app } from "../src/server.js";

describe("URL Canonicalization", () => {
  it("removes tracking parameters and fragments", () => {
    expect(canonicalizeUrl("https://Example.com/a/?utm_source=x#part")).toBe(
      "https://example.com/a",
    );
  });
});

describe("SSRF: Private IP and Metadata Blocking", () => {
  it("blocks IPv4 loopback addresses", () => {
    expect(privateIp("127.0.0.1")).toBe(true);
    expect(privateIp("127.0.0.2")).toBe(true);
    expect(privateIp("127.255.255.255")).toBe(true);
  });

  it("blocks RFC1918 private IPv4 ranges", () => {
    expect(privateIp("10.0.0.1")).toBe(true);
    expect(privateIp("10.255.255.255")).toBe(true);
    expect(privateIp("172.16.0.1")).toBe(true);
    expect(privateIp("172.31.255.255")).toBe(true);
    expect(privateIp("192.168.0.1")).toBe(true);
    expect(privateIp("192.168.255.255")).toBe(true);
  });

  it("blocks AWS/GCP/Azure cloud metadata and link-local (169.254.x.x)", () => {
    expect(privateIp("169.254.169.254")).toBe(true);
    expect(privateIp("169.254.0.1")).toBe(true);
    expect(privateIp("169.254.255.255")).toBe(true);
  });

  it("blocks Carrier-Grade NAT (100.64.0.0/10)", () => {
    expect(privateIp("100.64.0.1")).toBe(true);
    expect(privateIp("100.127.255.255")).toBe(true);
  });

  it("blocks test, benchmark, multicast, and broadcast ranges", () => {
    expect(privateIp("0.0.0.0")).toBe(true);
    expect(privateIp("192.0.2.1")).toBe(true);
    expect(privateIp("198.51.100.1")).toBe(true);
    expect(privateIp("203.0.113.1")).toBe(true);
    expect(privateIp("224.0.0.1")).toBe(true); // multicast
    expect(privateIp("255.255.255.255")).toBe(true); // broadcast
  });

  it("blocks IPv6 loopback, link-local, site-local, unique local, and mapped IPv4", () => {
    expect(privateIp("::1")).toBe(true);
    expect(privateIp("::")).toBe(true);
    expect(privateIp("fe80::1")).toBe(true);
    expect(privateIp("fc00::1")).toBe(true);
    expect(privateIp("fd12::1")).toBe(true);
    expect(privateIp("fec0::1")).toBe(true);
    expect(privateIp("fec0:0:0:0:0:0:0:1")).toBe(true);
    expect(privateIp("fc00:0:0:0:0:0:0:1")).toBe(true);
    expect(privateIp("fe80:0:0:0:0:0:0:1")).toBe(true);
    expect(privateIp("::ffff:127.0.0.1")).toBe(true);
    expect(privateIp("::ffff:169.254.169.254")).toBe(true);
    expect(privateIp("::ffff:10.0.0.1")).toBe(true);
    expect(privateIp("::ffff:7f00:1")).toBe(true);
    expect(privateIp("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(privateIp("::ffff:c0a8:101")).toBe(true);
    expect(privateIp("::ffff:808:808")).toBe(false);
  });

  it("allows public internet IP addresses", () => {
    expect(privateIp("8.8.8.8")).toBe(false);
    expect(privateIp("1.1.1.1")).toBe(false);
    expect(privateIp("142.250.190.46")).toBe(false);
  });
});

describe("SSRF: assertSafeHttpUrl Safeguards", () => {
  it("rejects localhost, loopback, and internal hostnames", async () => {
    await expect(assertSafeHttpUrl("http://localhost/")).rejects.toThrow(/Blocked internal/);
    await expect(assertSafeHttpUrl("http://app.localhost/")).rejects.toThrow(/Blocked internal/);
    await expect(assertSafeHttpUrl("http://service.local/")).rejects.toThrow(/Blocked internal/);
    await expect(assertSafeHttpUrl("http://internal.lan/")).rejects.toThrow(/Blocked internal/);
    await expect(assertSafeHttpUrl("http://metadata.google.internal/")).rejects.toThrow(
      /Blocked internal/,
    );
  });

  it("rejects private IP literals", async () => {
    await expect(assertSafeHttpUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeHttpUrl("http://10.0.0.1/")).rejects.toThrow();
    await expect(assertSafeHttpUrl("http://192.168.1.1/")).rejects.toThrow();
    await expect(assertSafeHttpUrl("http://169.254.169.254/")).rejects.toThrow();
    await expect(assertSafeHttpUrl("http://[::1]/")).rejects.toThrow();
  });

  it("rejects non-HTTP protocols", async () => {
    await expect(assertSafeHttpUrl("file:///etc/passwd")).rejects.toThrow(/Only public HTTP/);
    await expect(assertSafeHttpUrl("ftp://example.com/")).rejects.toThrow(/Only public HTTP/);
    await expect(assertSafeHttpUrl("gopher://example.com/")).rejects.toThrow(/Only public HTTP/);
    await expect(assertSafeHttpUrl("data:text/plain,secret")).rejects.toThrow(/Only public HTTP/);
  });

  it("rejects embedded credentials", async () => {
    await expect(assertSafeHttpUrl("http://admin:secret@example.com/")).rejects.toThrow(
      /embedded credentials/,
    );
  });

  it("rejects dangerous internal ports", async () => {
    await expect(assertSafeHttpUrl("http://example.com:22/")).rejects.toThrow(
      /Blocked destination/,
    );
    await expect(assertSafeHttpUrl("http://example.com:6379/")).rejects.toThrow(
      /Blocked destination/,
    );
    await expect(assertSafeHttpUrl("http://example.com:27017/")).rejects.toThrow(
      /Blocked destination/,
    );
    await expect(assertSafeHttpUrl("http://example.com:3306/")).rejects.toThrow(
      /Blocked destination/,
    );
  });
});

describe("Backend Rate Limiter", () => {
  it("enforces sliding window limits and returns 429 after threshold", () => {
    const limiter = new RateLimiter(60000, 3);
    const ip = "192.0.2.55";

    const res1 = limiter.check(ip, 1000);
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);

    const res2 = limiter.check(ip, 2000);
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = limiter.check(ip, 3000);
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    // 4th request exceeds limit of 3
    const res4 = limiter.check(ip, 4000);
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
    expect(res4.resetMs).toBeGreaterThan(0);

    // After window expires (1000 + 60001 = 61001), slot frees up
    const res5 = limiter.check(ip, 61005);
    expect(res5.allowed).toBe(true);
  });
});

describe("Server Security & Guardrails", () => {
  it("rejects oversized request bodies with 413", async () => {
    const giantPayload = "x".repeat(70000); // 70KB exceeds 64KB bodyLimit
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: giantPayload },
    });

    expect(response.statusCode).toBe(413);
  });

  it("adds essential security headers to responses", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-xss-protection"]).toBe("1; mode=block");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sanitizes /ready response without leaking secrets or full internal URLs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    if (response.statusCode === 200) {
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(["configured", "missing_credentials"]).toContain(body.search);
      expect(body.searchProviders).toEqual(["serper"]);
      expect(typeof body.llm).toBe("boolean");
      // Never expose the actual OPENROUTER_API_KEY
      expect(body.OPENROUTER_API_KEY).toBeUndefined();
    }
  });

  it("handles malformed JSON gracefully without leaking stack traces", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { "content-type": "application/json" },
      payload: "{ invalid json ...",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("at Fastify");
    expect(response.body).not.toContain(".ts:");
  });
});

describe("Tool Argument Validation & Prompt Injection Boundaries", () => {
  it("validates web_search arguments and rejects oversized query lists", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );

    // Empty queries array rejected
    await expect(registry.execute("web_search", { queries: [] })).rejects.toThrow(
      /non-empty array/,
    );

    // Queries exceeding 10 items rejected
    const tooMany = new Array(15).fill("test query");
    await expect(registry.execute("web_search", { queries: tooMany })).rejects.toThrow(
      /exceeds maximum limit of 10/,
    );

    // Non-string query item rejected
    await expect(registry.execute("web_search", { queries: [123] })).rejects.toThrow(
      /must be non-empty strings/,
    );
  });

  it("validates fetch_url argument and rejects missing or oversized URLs", async () => {
    const llm = new OpenRouterProvider();
    const registry = createToolRegistry(
      {
        search: async () => [],
      },
      llm,
    );

    await expect(registry.execute("fetch_url", {})).rejects.toThrow(/url is required/);
    await expect(registry.execute("fetch_url", { url: "" })).rejects.toThrow(/cannot be empty/);
    await expect(registry.execute("fetch_url", { url: "a".repeat(3000) })).rejects.toThrow(
      /exceeds maximum length/,
    );
  });
});
