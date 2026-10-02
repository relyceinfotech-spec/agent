import { describe, expect, it } from "vitest";
import { semanticMemoryEmbeddingDiagnosticInternals } from "../src/evaluation/semantic-memory-embedding-diagnostic.js";

describe("semantic memory embedding diagnostic telemetry", () => {
  it("classifies provider errors and redacts diagnostic credentials and input", async () => {
    const email = "temporary-diagnostic@example.com";
    const input = "diagnostic-only memory content";
    const response = new Response(
      JSON.stringify({
        error: {
          message: `Invalid request for ${input}; key=sk-or-v1-abcdef123456 and user ${email}`,
          type: "invalid_request_error",
          code: "invalid_dimensions",
        },
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "content-length": "123",
        },
      },
    );

    const result = await semanticMemoryEmbeddingDiagnosticInternals.inspectResponse(response, [
      email,
      input,
    ]);

    expect(result.status).toBe(400);
    expect(result.contentType).toBe("application/json");
    expect(result.bodyFormat).toBe("json");
    expect(result.jsonValid).toBe(true);
    expect(result.errorCategory).toBe("request_validation");
    expect(result.errorCode).toBe("invalid_dimensions");
    expect(result.errorType).toBe("invalid_request_error");
    expect(result.safeMessage).not.toContain(email);
    expect(result.safeMessage).not.toContain(input);
    expect(result.safeMessage).not.toContain("sk-or-v1-abcdef123456");
    expect(result.safeMessage).toContain("[redacted-key]");
  });

  it("bounds response inspection and marks a truncated body as unverified", async () => {
    const largeBody = JSON.stringify({ error: { message: "x".repeat(300_000) } });
    const response = new Response(largeBody, {
      status: 502,
      headers: { "content-type": "application/json" },
    });

    const result = await semanticMemoryEmbeddingDiagnosticInternals.inspectResponse(response, []);

    expect(result.status).toBe(502);
    expect(result.bodyBytesObserved).toBe(256 * 1024);
    expect(result.bodyTruncated).toBe(true);
    expect(result.bodyFormat).toBe("truncated");
    expect(result.jsonValid).toBeNull();
    expect(result.errorCategory).toBe("provider_or_gateway_failure");
    expect(result.safeMessage).toBeUndefined();
  });

  it("parses full embedding JSON responses larger than 16 KiB", async () => {
    const largeBody = JSON.stringify({
      data: [{ embedding: Array.from({ length: 5_000 }, () => 0.125), index: 0 }],
      model: "openai/text-embedding-3-small",
    });
    const result = await semanticMemoryEmbeddingDiagnosticInternals.inspectResponse(
      new Response(largeBody, { status: 200, headers: { "content-type": "application/json" } }),
      [],
    );

    expect(result.bodyBytesObserved).toBe(new TextEncoder().encode(largeBody).byteLength);
    expect(result.bodyTruncated).toBe(false);
    expect(result.bodyFormat).toBe("json");
    expect(result.jsonValid).toBe(true);
    expect(result.providerModel).toBe("openai/text-embedding-3-small");
  });

  it("distinguishes an invalid successful payload from HTTP errors", () => {
    expect(semanticMemoryEmbeddingDiagnosticInternals.responseCategory(200, false)).toBe(
      "invalid_success_payload",
    );
    expect(semanticMemoryEmbeddingDiagnosticInternals.responseCategory(200, null, true)).toBe(
      "truncated_success_payload",
    );
    expect(semanticMemoryEmbeddingDiagnosticInternals.responseCategory(429, false)).toBe(
      "rate_or_credit_limit",
    );
  });
});
