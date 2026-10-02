import { describe, expect, it } from "vitest";
import { sanitizeRequestLogUrl } from "../src/logging.js";

describe("request URL log redaction", () => {
  it("redacts public share bearer tokens in path segments", () => {
    expect(sanitizeRequestLogUrl(`/api/share/${"a".repeat(43)}`)).toBe("/api/share/[redacted]");
  });

  it("redacts every query value rather than trying to identify secret names", () => {
    expect(sanitizeRequestLogUrl("/api/research?question=private&access_token=secret")).toBe(
      "/api/research?[redacted]",
    );
  });

  it("preserves ordinary route paths for request diagnostics", () => {
    expect(sanitizeRequestLogUrl("/api/research/123")).toBe("/api/research/123");
  });
});
