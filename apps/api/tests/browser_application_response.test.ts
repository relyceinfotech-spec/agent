import { describe, expect, it } from "vitest";
import { shouldCaptureBrowserApplicationResponse } from "../src/browser.js";

const pageUrl = "https://relyce.example/about";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    pageUrl,
    requestUrl: "https://relyce.example/api/about",
    responseUrl: "https://relyce.example/api/about",
    method: "GET",
    status: 200,
    contentType: "application/json; charset=utf-8",
    responseBytes: 2_000,
    capturedCount: 0,
    capturedBytes: 0,
    ...overrides,
  };
}

describe("browser application response capture policy", () => {
  it("allows small successful same-origin JSON GET responses", () => {
    expect(shouldCaptureBrowserApplicationResponse(candidate())).toBe(true);
    expect(
      shouldCaptureBrowserApplicationResponse(
        candidate({ contentType: "application/vnd.example+json" }),
      ),
    ).toBe(true);
  });

  it.each([
    ["cross-origin request", { requestUrl: "https://cdn.example/api/about" }],
    ["cross-origin redirect", { responseUrl: "https://other.example/api/about" }],
    ["non-GET request", { method: "POST" }],
    ["error response", { status: 401 }],
    ["non-JSON response", { contentType: "text/html" }],
    ["oversized response", { responseBytes: 64_001 }],
    ["response-count budget exhausted", { capturedCount: 4 }],
    ["aggregate-byte budget exhausted", { capturedBytes: 127_000, responseBytes: 2_000 }],
  ])("rejects %s", (_label, overrides) => {
    expect(shouldCaptureBrowserApplicationResponse(candidate(overrides))).toBe(false);
  });
});
