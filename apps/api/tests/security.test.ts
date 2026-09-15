import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../src/security.js";

describe("canonicalizeUrl", () => {
  it("removes tracking parameters and fragments", () =>
    expect(canonicalizeUrl("https://Example.com/a/?utm_source=x#part")).toBe(
      "https://example.com/a",
    ));
});
