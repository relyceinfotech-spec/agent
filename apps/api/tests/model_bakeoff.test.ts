import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  MODEL_BAKEOFF_MODELS,
  MODEL_BAKEOFF_QUESTION,
  evaluationChildEnvironment,
  evaluateBakeoffContinuation,
  parseResumeReportPaths,
  renderBakeoffMarkdown,
  resolveCanonicalReportPath,
  resolveEvaluationReportPath,
  runSequentialModelTasks,
  summarizeBakeoffRun,
} from "../src/evaluation/model-bakeoff.js";

const passingResearchReport = (modelId = MODEL_BAKEOFF_MODELS[0]) => ({
  model: modelId,
  status: "RESEARCH_VERIFIED",
  question: MODEL_BAKEOFF_QUESTION,
  limits: {
    deepResearch: false,
    maxSteps: 40,
    maxQueries: 5,
    maxSources: 5,
    maxPages: 5,
    maxSearchPasses: 4,
    maxRecoverySearches: 4,
    maxResearchTimeMs: 180_000,
    maxModelDecisions: 4,
    maxOpenRouterCalls: 8,
    modelRequestTimeoutMs: 25_000,
    openRouterMaxAttempts: 1,
    maxJobAttempts: 1,
  },
  memoryPath: "excluded from this Serper/retrieval/citation phase",
  executionScope: "research-only; no Post Agent, topic, run, post, or follow-up",
  postAgent: "SKIPPED",
  postFollowUp: "SKIPPED",
  cleanupVerified: true,
  cleanupFailures: [],
  temporaryUserId: "user-a",
  sessionId: "session-a",
  jobId: "job-a",
  ownerReadbackResult: "PASSED",
  ownerReadbackDurationMs: 24,
  totalDurationMs: 12_500,
  serper: { requests: 2, queries: ["official React releases", "React latest release"] },
  openRouter: {
    usage: {
      promptTokens: 900,
      completionTokens: 200,
      reasoningTokens: 30,
      totalTokens: 1_100,
      cost: 0.001,
    },
    records: [
      {
        model: modelId,
        provider: "openrouter",
        purpose: "research_action_decision",
        durationMs: 250,
        responseParseResult: "VALID_JSON",
      },
    ],
  },
  research: {
    status: "COMPLETED",
    jobStatus: "completed",
    attempts: 1,
    steps: [{ durationMs: 100 }],
    serperRequests: 2,
    sources: [
      { title: "React releases", url: "https://react.dev/versions", sourceType: "official" },
    ],
    pageFetchSources: [{ url: "https://react.dev/versions", retrievalMethod: "http" }],
    officialSources: [{ url: "https://react.dev/versions" }],
    officialEvidenceStatus: { required: true, missingRequestedFacts: [] },
    answerCoverage: {
      requiredFacts: ["version", "release date", "stable status", "latestness"],
      resolvedFacts: ["version", "release date", "stable status", "latestness"],
      missingRequestedFacts: [],
    },
    answer: "React X is stable and latest. [1]",
    citationAudit: { invalidMarkers: [], uncitedSentences: [] },
    citationValidationStatus: "VALIDATED",
    citationValidation: { items: [] },
    synthesisTelemetry: {
      attempted: true,
      finalAnswerSource: "model",
      fallbackUsed: false,
    },
    decisions: [{ controllerDecision: "allow" }],
  },
});

function summarize(runReport: Record<string, unknown>, modelId = MODEL_BAKEOFF_MODELS[0]) {
  return summarizeBakeoffRun({
    modelId,
    startedAt: "2026-09-28T00:00:00.000Z",
    endedAt: "2026-09-28T00:00:12.500Z",
    durationMs: 12_500,
    processExitCode: 0,
    runReport,
    credentialAuditPassed: true,
    environmentRestored: true,
  });
}

describe("model bake-off evaluator", () => {
  it("uses the exact canonical question and ordered model list", () => {
    expect(MODEL_BAKEOFF_QUESTION).toBe(
      "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.",
    );
    expect(MODEL_BAKEOFF_MODELS).toEqual([
      "qwen/qwen3.7-flash",
      "openai/gpt-6-luna",
      "openai/gpt-6-luna-pro",
      "openai/gpt-5-nano",
      "mistralai/mistral-small-2603",
      "deepseek/deepseek-v3.2",
      "minimax/minimax-m2.5",
      "google/gemini-3.1-flash-lite",
    ]);
  });

  it("marks a run complete only when research, requested facts, citations, owner readback, and cleanup pass", () => {
    const result = summarize(passingResearchReport());

    expect(result.status).toBe("COMPLETE");
    expect(result.modelAvailability).toBe("AVAILABLE");
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
    expect(result.metrics).toMatchObject({
      versionStated: true,
      releaseDateStated: true,
      stableStatusStated: true,
      latestnessStated: true,
      allRequiredFactsCovered: true,
      ownerReadback: "PASSED",
      ownerReadbackAttempted: true,
      temporaryUserId: "user-a",
      sessionId: "session-a",
      jobId: "job-a",
    });
  });

  it("keeps unresolved latestness partial instead of passing the quality gates", () => {
    const report = passingResearchReport();
    const research = report.research;
    research.answerCoverage.resolvedFacts = ["version", "release date", "stable status"];
    research.answerCoverage.missingRequestedFacts = ["latestness"];

    const result = summarize(report);

    expect(result.status).toBe("PARTIAL");
    expect(result.gates.find((gate) => gate.name === "answer_fact:latestness")?.passed).toBe(false);
  });

  it("records a 404 model as unavailable and allows the next model after verified cleanup", () => {
    const report = {
      ...passingResearchReport(),
      research: undefined,
      openRouter: {
        records: [
          {
            model: MODEL_BAKEOFF_MODELS[0],
            failureCategory: "PROVIDER_FAILURE",
            error: { name: "Error", message: "HTTP 404 model not found", status: 404 },
          },
        ],
      },
    };
    const result = summarize(report);
    result.metrics.isolationIdsPresent = true;
    const continuation = evaluateBakeoffContinuation(result, report, true);

    expect(result.modelAvailability).toBe("UNAVAILABLE");
    expect(result.metrics.providerErrors[0]).toMatchObject({ httpStatus: 404 });
    expect(continuation.safeToContinue).toBe(true);
    expect(continuation.reason).toContain("unavailable");
  });

  it("records rate-limit and malformed model failures without treating them as successful calls", () => {
    const rateLimited = summarize({
      ...passingResearchReport(),
      research: undefined,
      openRouter: {
        records: [
          {
            model: MODEL_BAKEOFF_MODELS[0],
            failureCategory: "RATE_LIMIT",
            error: { name: "Error", message: "HTTP 429 rate limit" },
          },
        ],
      },
    });
    const malformed = summarize({
      ...passingResearchReport(),
      research: undefined,
      openRouter: {
        records: [
          {
            model: MODEL_BAKEOFF_MODELS[0],
            responseParseResult: "TRUNCATED",
            responseValidationResult: "FAILED",
          },
        ],
      },
    });

    expect(rateLimited.modelAvailability).toBe("REQUEST_FAILED");
    expect(rateLimited.metrics.rateLimitFailures).toBe(1);
    expect(malformed.modelAvailability).toBe("REQUEST_FAILED");
    expect(malformed.metrics.malformedResponses).toBe(1);
    expect(malformed.metrics.providerErrors[0]?.failureCategory).toBe("TRUNCATED");
  });

  it("continues after model-specific request failure but stops on cleanup or infrastructure failures", () => {
    const providerFailureReport = {
      ...passingResearchReport(),
      research: undefined,
      openRouter: {
        records: [
          {
            model: MODEL_BAKEOFF_MODELS[0],
            failureCategory: "RATE_LIMIT",
            error: "HTTP 429 rate limit",
          },
        ],
      },
    };
    const providerFailure = summarize(providerFailureReport);
    providerFailure.metrics.isolationIdsPresent = true;
    expect(evaluateBakeoffContinuation(providerFailure, providerFailureReport).safeToContinue).toBe(
      true,
    );

    const infrastructureFailure = summarize({
      ...passingResearchReport(),
      research: undefined,
      failure: { name: "SerperUnavailable", message: "Search provider failed" },
    });
    infrastructureFailure.metrics.isolationIdsPresent = true;
    expect(
      evaluateBakeoffContinuation(infrastructureFailure, infrastructureFailureReport())
        .safeToContinue,
    ).toBe(false);

    function infrastructureFailureReport() {
      return {
        ...passingResearchReport(),
        research: undefined,
        failure: { name: "SerperUnavailable", message: "Search provider failed" },
      };
    }

    const cleanupFailure = summarize({
      ...providerFailureReport,
      cleanupVerified: false,
      cleanupFailures: ["test cleanup failure"],
    });
    cleanupFailure.metrics.isolationIdsPresent = true;
    expect(evaluateBakeoffContinuation(cleanupFailure, providerFailureReport).safeToContinue).toBe(
      false,
    );
  });

  it("continues when a later model response fails after earlier calls succeeded", () => {
    const report = {
      ...passingResearchReport(),
      research: undefined,
      openRouter: {
        records: [
          { model: MODEL_BAKEOFF_MODELS[0], purpose: "research_action_decision" },
          {
            model: MODEL_BAKEOFF_MODELS[0],
            purpose: "research_synthesis",
            responseParseResult: "TRUNCATED",
            responseValidationResult: "FAILED",
          },
        ],
      },
    };
    const result = summarize(report);
    result.metrics.isolationIdsPresent = true;

    expect(result.modelAvailability).toBe("AVAILABLE");
    expect(result.metrics.providerErrors).toHaveLength(1);
    expect(evaluateBakeoffContinuation(result, report).safeToContinue).toBe(true);
  });

  it("continues to compare another model after a completed research run with quality-gate failures", () => {
    const report = passingResearchReport();
    report.research.answerCoverage.missingRequestedFacts = ["latestness"];
    report.research.answerCoverage.resolvedFacts = ["version", "release date", "stable status"];
    const result = summarize(report);
    result.metrics.isolationIdsPresent = true;

    expect(result.status).toBe("PARTIAL");
    expect(evaluateBakeoffContinuation(result, report).safeToContinue).toBe(true);
  });

  it("overrides only the child model environment without mutating the parent", () => {
    const parent = { OPENROUTER_MODEL: "production/model", PATH: "original-path" };
    const child = evaluationChildEnvironment(parent, "evaluation/model");

    expect(child.OPENROUTER_MODEL).toBe("evaluation/model");
    expect(child.PATH).toBe("original-path");
    expect(parent).toEqual({ OPENROUTER_MODEL: "production/model", PATH: "original-path" });
  });

  it("accepts only canonical evaluation-result paths in relative, absolute, and JSON-escaped forms", () => {
    const apiRoot = "D:\\reserch maxx\\apps\\api";
    const relativePath = "evaluation-results/serper-citation-integration-run-1.json";
    const absolutePath = resolve(apiRoot, relativePath);

    expect(resolveEvaluationReportPath(relativePath, apiRoot)).toBe(absolutePath);
    expect(resolveEvaluationReportPath(absolutePath, apiRoot)).toBe(absolutePath);
    expect(resolveCanonicalReportPath(JSON.stringify(absolutePath).slice(1, -1), apiRoot)).toBe(
      absolutePath,
    );
    expect(() => resolveEvaluationReportPath("../outside/report.json", apiRoot)).toThrow(
      "outside its evaluation-results directory",
    );
    expect(parseResumeReportPaths(["--resume-report", absolutePath])).toEqual([absolutePath]);
    expect(parseResumeReportPaths([`--resume-report=${absolutePath}`])).toEqual([absolutePath]);
    expect(parseResumeReportPaths(["--", `--resume-report=${absolutePath}`])).toEqual([
      absolutePath,
    ]);
    expect(() => parseResumeReportPaths(["--unexpected"])).toThrow(
      "Unknown model bake-off argument",
    );
  });

  it("runs model tasks one at a time and stops only when the safety callback says stop", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await runSequentialModelTasks(
      ["a", "b", "c"],
      async (model) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${model}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(`end:${model}`);
        active -= 1;
        return model;
      },
      () => true,
    );

    expect(result.results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("continues after one safely cleaned unavailable model and stops on an unsafe run", async () => {
    const attempted: string[] = [];
    const result = await runSequentialModelTasks(
      ["unavailable", "next-model", "must-not-run"],
      async (model) => {
        attempted.push(model);
        return {
          model,
          safeToContinue: model !== "next-model",
        };
      },
      (run) => run.safeToContinue,
    );

    expect(attempted).toEqual(["unavailable", "next-model"]);
    expect(result.results).toHaveLength(2);
    expect(result.stoppedIndex).toBe(1);
  });

  it("renders a measurable markdown table without subjective ranking", () => {
    const result = summarize(passingResearchReport());
    const markdown = renderBakeoffMarkdown({
      status: "COMPLETED",
      question: MODEL_BAKEOFF_QUESTION,
      results: [result],
    });

    expect(markdown).toContain(
      "| Model | Research | Fact Coverage | Citation | Owner Readback | Fallback | Latency | Tokens | Cost | Result |",
    );
    expect(markdown).toContain("| qwen/qwen3.7-flash |");
    expect(markdown).toContain("No subjective ranking is calculated.");
  });
});
