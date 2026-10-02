import { describe, expect, it } from "vitest";
import { safeErrorSummary } from "../src/evaluation/safe-error-summary.js";

describe("safe smoke error summaries", () => {
  it("redacts provider keys, bearer/JWT tokens, and credential fields", () => {
    const error = new Error(
      "Bearer abc123 sk-or-v1-test_secret_12345678901234567890 " +
        "sk_abcdefghijklmnopqrstuvwxyz123456 sb_secret_test123 sb_publishable_test456 " +
        "eyJhbGciOiJIUzI1NiJ9.payloadabcdefghijk.signatureabcdefghijk " +
        "password=hunter2 access_token:access123 refresh-token=refresh123 api_key=key123 " +
        "secret=secret123 cookie=session123",
    );

    const summary = safeErrorSummary(error);

    expect(summary.name).toBe("Error");
    expect(summary.message).toContain("Bearer [redacted]");
    expect(summary.message).not.toMatch(
      /abc123|sk-or-v1-|sk_abcdefghijklmnopqrstuvwxyz|sb_secret_|sb_publishable_|payloadabcdefghijk|hunter2|access123|refresh123|key123|secret123|session123/,
    );
    expect(summary.message?.match(/\[redacted-key\]/g)).toHaveLength(4);
    expect(summary.message).toContain("[redacted-token]");
    expect(summary.message).toContain("password=[redacted]");
    expect(summary.message).toContain("access_token=[redacted]");
    expect(summary.message).toContain("refresh-token=[redacted]");
  });

  it("redacts emails and UUIDs, normalizes whitespace, and bounds output", () => {
    const summary = safeErrorSummary(
      new Error(
        `failed for user@example.com\n${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)} ${"x".repeat(400)}`,
      ),
    );

    expect(summary.message).toContain("[email]");
    expect(summary.message).toContain("[uuid]");
    expect(summary.message).not.toContain("\n");
    expect(summary.message).toHaveLength(300);
  });

  it("redacts sensitive query-string values", () => {
    const summary = safeErrorSummary(
      new Error(
        "request failed at https://example.test/path?token=private123&view=full&api_key=secret456",
      ),
    );

    expect(summary.message).toContain("token=[redacted]");
    expect(summary.message).toContain("api_key=[redacted]");
    expect(summary.message).toContain("view=full");
    expect(summary.message).not.toContain("private123");
    expect(summary.message).not.toContain("secret456");
  });

  it("does not include arbitrary non-error objects", () => {
    expect(safeErrorSummary({ password: "do-not-log" })).toEqual({
      name: "Error",
      message: "Unknown smoke failure",
    });
  });
});
