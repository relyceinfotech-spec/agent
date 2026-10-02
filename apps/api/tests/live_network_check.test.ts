import { describe, expect, it, vi } from "vitest";
import { checkLiveNetwork } from "../src/evaluation/live-network-check.js";

const baseOptions = {
  supabaseUrl: "https://signova.supabase.co",
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  requiredConfiguration: [{ name: "SERPER_API_KEY", configured: true }],
};

describe("live network preflight", () => {
  it("treats any HTTP response as transport reachability without sending credentials", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeUndefined();
      return new Response(null, { status: 405 });
    });
    const resolveHost = vi.fn(async () => [{ address: "203.0.113.10" }]);

    const result = await checkLiveNetwork({ ...baseOptions, request, resolveHost });

    expect(result.ready).toBe(true);
    expect(result.status).toBe("NETWORK READY");
    expect(result.endpoints.map((endpoint) => endpoint.statusCode)).toEqual([405, 405, 405]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(resolveHost).toHaveBeenCalledTimes(3);
  });

  it("classifies a nested EACCES as an outbound permission block", async () => {
    const denied = Object.assign(new Error("socket denied"), { code: "EACCES" });
    const request = vi.fn(async () => {
      throw new AggregateError([denied], "fetch failed");
    });

    const result = await checkLiveNetwork({
      ...baseOptions,
      request: request as typeof fetch,
      resolveHost: async () => [],
    });

    expect(result.ready).toBe(false);
    expect(result.endpoints).toHaveLength(3);
    expect(result.endpoints.every((endpoint) => endpoint.errorCode === "EACCES")).toBe(true);
    expect(
      result.endpoints.every((endpoint) => endpoint.failureLayer === "OUTBOUND_PERMISSION"),
    ).toBe(true);
  });

  it("does not attempt HTTPS when DNS resolution fails", async () => {
    const request = vi.fn();
    const dnsError = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });

    const result = await checkLiveNetwork({
      ...baseOptions,
      request: request as typeof fetch,
      resolveHost: async () => {
        throw dnsError;
      },
    });

    expect(result.ready).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(result.endpoints.every((endpoint) => endpoint.dns === "FAIL")).toBe(true);
    expect(result.endpoints.every((endpoint) => endpoint.https === "SKIPPED")).toBe(true);
  });

  it("reports missing configuration by name without exposing configured values", async () => {
    const result = await checkLiveNetwork({
      ...baseOptions,
      requiredConfiguration: [
        { name: "SERPER_API_KEY", configured: false },
        { name: "SUPABASE_SECRET_KEY", configured: true },
      ],
      request: async () => new Response(null, { status: 401 }),
      resolveHost: async () => [],
    });

    expect(result.ready).toBe(false);
    expect(result.missingConfiguration).toEqual(["SERPER_API_KEY"]);
    expect(JSON.stringify(result)).not.toContain("SUPABASE_SECRET_KEY");
  });

  it("rejects non-HTTPS or credential-bearing service URLs", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));

    const result = await checkLiveNetwork({
      ...baseOptions,
      supabaseUrl: "http://user:password@localhost:54321",
      request: request as typeof fetch,
      resolveHost: async () => [],
    });

    expect(result.ready).toBe(false);
    expect(result.endpoints[0]).toMatchObject({
      service: "supabase",
      dns: "SKIPPED",
      https: "SKIPPED",
      failureLayer: "CONFIGURATION",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("password");
  });
});
