import { describe, expect, it } from "vitest";
import { buildSmokeVerdict, computeToolDecisionAccuracy } from "../src/evaluation/real.js";

describe("real-model evaluation verdict", () => {
  it("does not report unobserved model decisions as perfect accuracy", () => {
    expect(computeToolDecisionAccuracy([])).toBeNull();
  });

  it("fails a smoke run when its required tool trajectory is incomplete", () => {
    const result = {
      name: "current_react_version",
      category: "current",
      decisions: [],
      criticalFailures: [],
      claims: [],
      conflicts: [],
      checks: { route: true, evidence: false, trajectory: false },
      modelMetrics: { calls: 0 },
    };

    const verdict = buildSmokeVerdict([result as never], {
      routingAccuracy: 1,
      toolTrajectoryAccuracy: 0,
    } as never);

    expect(verdict.pass).toBe(false);
    expect(verdict.toolDecisionAccuracy).toBeNull();
    expect(verdict.modelCalls).toBe(0);
    expect(verdict.reasons).toContain(
      "Tool-trajectory accuracy 0% < 100% required. Incomplete: current_react_version.",
    );
  });

  it("allows a complete deterministic fast path while labeling model accuracy unmeasured", () => {
    const result = {
      name: "current_react_version",
      category: "current",
      decisions: [],
      criticalFailures: [],
      claims: [],
      conflicts: [],
      checks: { route: true, evidence: true, trajectory: true },
      modelMetrics: { calls: 0 },
    };

    const verdict = buildSmokeVerdict([result as never], {
      routingAccuracy: 1,
      toolTrajectoryAccuracy: 1,
    } as never);

    expect(verdict.pass).toBe(true);
    expect(verdict.currentEvidenceRate).toBe(1);
    expect(verdict.toolDecisionAccuracy).toBeNull();
    expect(verdict.toolDecisionCount).toBe(0);
    expect(verdict.modelCalls).toBe(0);
  });

  it("does not pass current-info smoke when the expected path yielded no source content", () => {
    const result = {
      name: "current_react_version",
      category: "current",
      decisions: [],
      criticalFailures: [],
      claims: [],
      conflicts: [],
      checks: { route: true, evidence: false, trajectory: true },
      modelMetrics: { calls: 0 },
    };

    const verdict = buildSmokeVerdict([result as never], {
      routingAccuracy: 1,
      toolTrajectoryAccuracy: 1,
    } as never);

    expect(verdict.pass).toBe(false);
    expect(verdict.currentEvidenceRate).toBe(0);
    expect(verdict.reasons).toContain(
      "Current-information evidence unavailable for: current_react_version. Routing success is not a research-quality pass.",
    );
  });
});
