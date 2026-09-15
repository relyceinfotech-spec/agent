import { describe, expect, it } from "vitest";
import { rankResults } from "../src/rank.js";

describe("rankResults", () => {
  it("deduplicates URLs and returns explainable scores", () => {
    const result = rankResults("climate policy", [
      {
        title: "Climate policy",
        url: "https://www.gov.example/a?utm_source=x",
        snippet: "Climate policy evidence",
      },
      { title: "Duplicate", url: "https://www.gov.example/a", snippet: "same" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].quality.overall).toBeGreaterThan(0);
  });
});
