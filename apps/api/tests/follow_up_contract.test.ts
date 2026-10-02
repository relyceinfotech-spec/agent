import { describe, expect, it } from "vitest";
import { inspectFollowUpCitationContract } from "../src/evaluation/follow-up-contract.js";

describe("live follow-up citation contract diagnostics", () => {
  it("accepts a completed answer with an in-range citation, source, and model call", () => {
    expect(
      inspectFollowUpCitationContract({
        status: "COMPLETED",
        answer: "The official release note supports this. [1]",
        sourceIds: ["source-a"],
        modelCallsBefore: 4,
        modelCallsAfter: 6,
      }),
    ).toMatchObject({
      passed: true,
      citationNumbers: [1],
      sourceIdCount: 1,
      modelCallsDelta: 2,
      failedChecks: [],
    });
  });

  it("identifies each missing citation-contract condition without storing answer text", () => {
    const result = inspectFollowUpCitationContract({
      status: "COMPLETED",
      answer: "I could not find one. [3]",
      sourceIds: [],
      modelCallsBefore: 4,
      modelCallsAfter: 4,
    });

    expect(result).toMatchObject({
      passed: false,
      answerPresent: true,
      answerLength: "I could not find one. [3]".length,
      citationNumbers: [3],
      sourceIdCount: 0,
      modelCallsDelta: 0,
      failedChecks: ["sourceIdsPresent", "citationsInRange", "modelCallObserved"],
    });
    expect(result).not.toHaveProperty("answer");
  });

  it("distinguishes missing citations from a non-completed follow-up", () => {
    const result = inspectFollowUpCitationContract({
      status: "FAILED",
      answer: "No cited evidence was returned.",
      sourceIds: ["source-a"],
      modelCallsBefore: 1,
      modelCallsAfter: 2,
    });

    expect(result.failedChecks).toEqual(["completed", "cited", "citationsInRange"]);
  });
});
