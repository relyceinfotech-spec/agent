import { createClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  classifyAuthSmokeFailure,
  createAuthSmokeFetch,
  formatAuthSmokeError,
  safeAuthSmokeError,
  summarizeAuthSmokeResponseBody,
  type AuthSmokeTransportEvent,
} from "../src/evaluation/auth-smoke-transport.js";
import { createAuthUserWithReconciliation } from "../src/evaluation/auth-smoke-cleanup.js";
import { createSupabaseAuthFetch } from "../src/supabase-auth-fetch.js";

const supabaseUrl = "https://auth-smoke-unit-test.supabase.co";
const serverKey = "unit-test-server-key";

function createUserResponse(email: string, id: string) {
  return new Response(
    JSON.stringify({
      id,
      aud: "authenticated",
      role: "authenticated",
      email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeAdmin(fetcher: typeof fetch) {
  return createClient(supabaseUrl, serverKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
}

describe("Auth smoke transport diagnostics", () => {
  it("classifies valid JSON response bodies and hashes the observed bytes", () => {
    const summary = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode('{"id":"safe-test-id"}'),
      "application/json",
    );

    expect(summary).toMatchObject({
      kind: "valid-json",
      jsonValid: true,
      byteLength: 21,
      textPrefixOmitted: true,
    });
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recognizes gzip bytes and hashes the bounded decoded JSON without exposing it", () => {
    const decoded = JSON.stringify({ message: "safe synthetic fixture" });
    const encoded = gzipSync(decoded);
    const summary = summarizeAuthSmokeResponseBody(new Uint8Array(encoded), "application/json");

    expect(summary).toMatchObject({
      byteLength: encoded.byteLength,
      kind: "binary-or-encoded",
      encodingHint: "gzip",
      jsonValid: false,
      decodedByteLength: Buffer.byteLength(decoded),
      decodedJsonValid: true,
      decodedKind: "valid-json",
      textPrefixOmitted: true,
    });
    expect(summary.sha256).not.toBe(summary.decodedSha256);
    expect(JSON.stringify(summary)).not.toContain("safe synthetic fixture");
  });

  it("distinguishes invalid JSON from a truncated JSON body", () => {
    const invalid = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode('{"status": nope}'),
      "application/json",
    );
    const truncated = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode('{"user":{"id":"unfinished'),
      "application/json",
    );

    expect(invalid.kind).toBe("invalid-json");
    expect(truncated.kind).toBe("truncated-json");
    expect(invalid.textPrefixOmitted).toBe(true);
    expect(truncated.textPrefixOmitted).toBe(true);
  });

  it("classifies a non-JSON 200 HTML body without exposing its content", () => {
    const summary = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode("<!doctype html><html><body>temporary response</body></html>"),
      "text/html; charset=utf-8",
    );

    expect(summary.kind).toBe("html");
    expect(summary.jsonValid).toBe(false);
    expect(summary.textPrefix).toBeUndefined();
    expect(summary.textPrefixOmitted).toBe(true);
  });

  it("classifies a non-JSON 200 plain-text response and only exposes a safe prefix", () => {
    const summary = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode("Upstream gateway temporarily unavailable"),
      "text/plain; charset=utf-8",
    );

    expect(summary.kind).toBe("plain-text");
    expect(summary.textPrefix).toBe("Upstream gateway temporarily unavailable");
  });

  it("classifies a non-JSON payload mislabeled as JSON", () => {
    const summary = summarizeAuthSmokeResponseBody(
      new TextEncoder().encode("upstream gateway response"),
      "application/json",
    );

    expect(summary.kind).toBe("non-json");
  });

  it("classifies gzip bytes without Content-Encoding as malformed response metadata", () => {
    const summary = summarizeAuthSmokeResponseBody(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]));
    const classification = classifyAuthSmokeFailure(new Error("SDK parse failure"), {
      method: "POST",
      path: "/auth/v1/admin/users",
      elapsedMs: 10,
      status: 200,
      responseJsonValid: summary.jsonValid,
      responseBodyEncodingHint: summary.encodingHint,
    });

    expect(summary).toMatchObject({
      encodingHint: "gzip",
      jsonValid: false,
    });
    expect(classification).toBe("malformed-compressed-response-metadata");
  });

  it("requests identity encoding only for Supabase Auth while preserving status and body", async () => {
    const response = new Response('{"ok":true}', { status: 201 });
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    const fetcher = createSupabaseAuthFetch(fetchImpl);

    const result = await fetcher(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "preserved" },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("x-test")).toBe("preserved");
    expect(result).toBe(response);
    expect(result.status).toBe(201);
    expect(response.bodyUsed).toBe(false);
  });

  it("does not change unrelated fetch requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const fetcher = createSupabaseAuthFetch(fetchImpl);
    const init = { headers: { "x-test": "unchanged" } };

    await fetcher("https://project.supabase.co/rest/v1/max_research_sessions", init);
    await fetcher("https://example.com/data", init);

    expect(fetchImpl.mock.calls.map((call) => call[1])).toEqual([init, init]);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("accept-encoding")).toBe(false);
  });

  it("redacts identity and credential-like values from safe error summaries", () => {
    const summary = safeAuthSmokeError(
      new Error(
        "create failed for max@example.com with Bearer eyJhbGciOiJub25l.eyJ1c2VyIjoxfQ.sig password=hunter2",
      ),
      ["hunter2"],
    );

    expect(summary.message).not.toContain("max@example.com");
    expect(summary.message).not.toContain("eyJhbGciOiJub25l");
    expect(summary.message).not.toContain("hunter2");
    expect(summary.message).toContain("[redacted-email]");
    expect(summary.message).toContain("Bearer [redacted]");
  });

  it("creates two users sequentially through one reused supabase-js admin client", async () => {
    const requests: Array<{ method: string; email: string; acceptEncoding?: string }> = [];
    const events: AuthSmokeTransportEvent[] = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { email: string };
      requests.push({
        method: String(init?.method),
        email: body.email,
        acceptEncoding: new Headers(init?.headers).get("accept-encoding") ?? undefined,
      });
      return createUserResponse(body.email, `user-${requests.length}`);
    });
    const fetcher = createAuthSmokeFetch({
      fetchImpl: nativeFetch as typeof fetch,
      deadline: () => Date.now() + 60_000,
      onEvent: (event) => events.push(event),
    });
    const admin = makeAdmin(fetcher);
    const pauses = { request: vi.fn() as typeof fetch, pause: async () => undefined };
    const userAEmail = "smoke-a@example.com";
    const userBEmail = "smoke-b@example.com";

    const userA = await createAuthUserWithReconciliation(
      () => admin.auth.admin.createUser({ email: userAEmail, password: "test-password-A1!" }),
      supabaseUrl,
      serverKey,
      userAEmail,
      pauses,
    );
    const userB = await createAuthUserWithReconciliation(
      () => admin.auth.admin.createUser({ email: userBEmail, password: "test-password-B1!" }),
      supabaseUrl,
      serverKey,
      userBEmail,
      pauses,
    );

    expect(userA.id).toBe("user-1");
    expect(userB.id).toBe("user-2");
    expect(requests).toEqual([
      { method: "POST", email: userAEmail, acceptEncoding: "identity" },
      { method: "POST", email: userBEmail, acceptEncoding: "identity" },
    ]);
    expect(events.map(({ status, method, path }) => ({ status, method, path }))).toEqual([
      { status: 200, method: "POST", path: "/auth/v1/admin/users" },
      { status: 200, method: "POST", path: "/auth/v1/admin/users" },
    ]);
    expect(pauses.request).not.toHaveBeenCalled();
  });

  it("inspects a cloned successful response without consuming or reconstructing it", async () => {
    const events: AuthSmokeTransportEvent[] = [];
    const response = createUserResponse("clone-check@example.com", "user-clone-check");
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    const fetcher = createAuthSmokeFetch({
      fetchImpl,
      deadline: () => Date.now() + 60_000,
      onEvent: (event) => events.push(event),
    });

    const returnedResponse = await fetcher(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
    });

    expect(returnedResponse).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(events[0]).toMatchObject({
      status: 200,
      contentType: "application/json",
      responseObservedAt: "auth-smoke-fetch-wrapper",
      responseBodyHashStage: "fetch-response-body",
      responseBodyEncodingHint: "valid-utf8",
      responseDecodedJsonValid: true,
      responseJsonValid: true,
      responseBodyKind: "valid-json",
    });
    await expect(returnedResponse.json()).resolves.toMatchObject({ id: "user-clone-check" });
  });

  it("lets supabase-js parse Node-fetch-decoded gzip JSON after response instrumentation", async () => {
    const email = "gzip-response@example.com";
    const userId = "user-gzip-response";
    const plainResponse = createUserResponse(email, userId);
    const plainJson = await plainResponse.text();
    const compressedLength = gzipSync(plainJson).byteLength;
    // Native Node fetch exposes the decompressed body while retaining these wire headers.
    const decodedResponse = new Response(plainJson, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressedLength),
      },
    });
    const events: AuthSmokeTransportEvent[] = [];
    let capturedBody: Uint8Array | undefined;
    const fetcher = createAuthSmokeFetch({
      fetchImpl: vi.fn<typeof fetch>(async () => decodedResponse),
      deadline: () => Date.now() + 60_000,
      onEvent: (event) => events.push(event),
      onAdminCreateResponse: (capture) => {
        capturedBody = capture.body;
      },
    });

    const result = await makeAdmin(fetcher).auth.admin.createUser({
      email,
      password: "test-password-A1!",
    });

    expect(result.error).toBeNull();
    expect(result.data.user?.id).toBe(userId);
    expect(events[0]).toMatchObject({
      status: 200,
      contentType: "application/json",
      contentEncoding: "gzip",
      contentLength: String(compressedLength),
      responseObservedAt: "auth-smoke-fetch-wrapper",
      responseBodyHashStage: "fetch-response-body",
      responseBodyEncodingHint: "valid-utf8",
      responseDecodedBodySha256: events[0].responseBodySha256,
      responseDecodedJsonValid: true,
      responseJsonValid: true,
      responseBodyKind: "valid-json",
      responseBodyBytes: Buffer.byteLength(plainJson),
    });
    expect(new TextDecoder().decode(capturedBody)).toBe(plainJson);
  });

  it("records a native fetch timeout and propagates the bounded abort", async () => {
    const events: AuthSmokeTransportEvent[] = [];
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing timeout signal"));
        const rejectForAbort = () => reject(signal.reason);
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener("abort", rejectForAbort, { once: true });
      });
    const fetcher = createAuthSmokeFetch({
      fetchImpl,
      deadline: () => Date.now() + 1_000,
      perRequestTimeoutMs: 5,
      onEvent: (event) => events.push(event),
    });

    await expect(
      fetcher(`${supabaseUrl}/auth/v1/admin/users`, { method: "POST" }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "POST",
      path: "/auth/v1/admin/users",
      errorName: "TimeoutError",
      aborted: true,
      abortReason: "TimeoutError",
    });
  });

  it("distinguishes an SDK HTTP 0 wrapper from its recorded native fetch cause", async () => {
    const events: AuthSmokeTransportEvent[] = [];
    const fetchFailure = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const fetchImpl: typeof fetch = async () => {
      throw fetchFailure;
    };
    const fetcher = createAuthSmokeFetch({
      fetchImpl,
      deadline: () => Date.now() + 60_000,
      onEvent: (event) => events.push(event),
    });
    const { error } = await makeAdmin(fetcher).auth.admin.createUser({
      email: "transport-error@example.com",
      password: "test-password-A1!",
    });

    expect(error).toMatchObject({ name: "AuthRetryableFetchError", status: 0 });
    expect(formatAuthSmokeError(error)).toBe("AuthRetryableFetchError HTTP 0");
    expect(events[0]).toMatchObject({
      errorName: "TypeError",
      causeName: "Error",
      causeCode: "ECONNRESET",
    });
  });

  it("separates HTTP failures, network failures, and timeouts without leaking messages", () => {
    expect(
      classifyAuthSmokeFailure(new Error("server failure"), {
        method: "POST",
        path: "/auth/v1/admin/users",
        elapsedMs: 40,
        status: 503,
      }),
    ).toBe("upstream-http-error");
    expect(
      classifyAuthSmokeFailure(new Error("fetch failed"), {
        method: "POST",
        path: "/auth/v1/admin/users",
        elapsedMs: 2,
        errorName: "TypeError",
        causeCode: "EACCES",
      }),
    ).toBe("fetch-transport-failure");
    expect(
      classifyAuthSmokeFailure(new Error("timed out"), {
        method: "POST",
        path: "/auth/v1/admin/users",
        elapsedMs: 25_000,
        errorName: "TimeoutError",
        aborted: true,
      }),
    ).toBe("timeout-or-abort");
  });

  it("shows that SDK JSON parsing can normalize an HTTP 200 response to status 0", async () => {
    const events: AuthSmokeTransportEvent[] = [];
    let capturedBody: Uint8Array | undefined;
    const fetchImpl: typeof fetch = async () =>
      new Response("{malformed", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = createAuthSmokeFetch({
      fetchImpl,
      deadline: () => Date.now() + 60_000,
      onEvent: (event) => events.push(event),
      onAdminCreateResponse: (capture) => {
        capturedBody = capture.body;
      },
    });
    const { error } = await makeAdmin(fetcher).auth.admin.createUser({
      email: "malformed-response@example.com",
      password: "test-password-A1!",
    });

    expect(error).toMatchObject({ name: "AuthRetryableFetchError", status: 0 });
    expect(classifyAuthSmokeFailure(error, events[0])).toBe("response-body-parse-failure");
    expect(events[0]).toMatchObject({
      status: 200,
      contentType: "application/json",
      path: "/auth/v1/admin/users",
      responseJsonValid: false,
      responseBodyKind: "truncated-json",
      responseBodyBytes: 10,
    });
    expect(capturedBody).toBeDefined();
    expect(new TextDecoder().decode(capturedBody!)).toBe("{malformed");
    expect(formatAuthSmokeError(error)).toBe("AuthRetryableFetchError HTTP 0");
  });

  it("does not dispatch requests after the whole-smoke deadline", async () => {
    const events: AuthSmokeTransportEvent[] = [];
    const fetchImpl = vi.fn<typeof fetch>();
    const fetcher = createAuthSmokeFetch({
      fetchImpl,
      deadline: () => Date.now() - 1,
      onEvent: (event) => events.push(event),
    });

    await expect(
      fetcher(`${supabaseUrl}/auth/v1/admin/users`, { method: "POST" }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ errorName: "TimeoutError", aborted: true });
  });
});
