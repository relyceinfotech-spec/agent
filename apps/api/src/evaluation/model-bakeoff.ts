import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { checkLiveNetwork } from "./live-network-check.js";

export const MODEL_BAKEOFF_QUESTION =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";

export const MODEL_BAKEOFF_MODELS = [
  "qwen/qwen3.7-flash",
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-pro",
  "openai/gpt-5-nano",
  "mistralai/mistral-small-2603",
  "deepseek/deepseek-v3.2",
  "minimax/minimax-m2.5",
  "google/gemini-3.1-flash-lite",
] as const;

const REQUIRED_FACTS = ["version", "release date", "stable status", "latestness"] as const;
const REQUIRED_CANONICAL_LIMITS = {
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
} as const;
const MAX_CAPTURED_OUTPUT = 128_000;
const SECRET_VALUE_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9_-]{16,}/gi,
  /sb_secret_[A-Za-z0-9_-]{16,}/gi,
  /sb_publishable_[A-Za-z0-9_-]{16,}/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g,
];

type JsonRecord = Record<string, unknown>;

export interface BakeoffGate {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ModelBakeoffResult {
  modelId: string;
  provider: "OpenRouter";
  status: "COMPLETE" | "PARTIAL" | "BLOCKED" | "UNAVAILABLE";
  modelAvailability: "AVAILABLE" | "UNAVAILABLE" | "REQUEST_FAILED" | "NOT_TESTED";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  processExitCode: number | null;
  reportPath?: string;
  failureStage?: string;
  failure?: JsonRecord;
  gates: BakeoffGate[];
  metrics: JsonRecord;
  cleanupVerified: boolean;
  credentialAuditPassed: boolean;
  environmentRestored: boolean;
  recoveredExistingRun?: boolean;
  safeToContinue: boolean;
  continuationReason: string;
  rawRunResult?: JsonRecord;
}

export interface SequentialRunResult<T> {
  results: T[];
  stoppedIndex?: number;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  return [record.name, record.message, record.code, record.status, record.statusCode]
    .filter((part) => part !== undefined && part !== null)
    .map(String)
    .join(" ");
}

function scrubText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((text, pattern) => {
    pattern.lastIndex = 0;
    return text.replace(pattern, "[REDACTED]");
  }, value);
}

function sanitizeJson(value: unknown, key = ""): unknown {
  if (/(?:password|authorization|access.?token|refresh.?token|secret|api.?key|cookie)/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      sanitizeJson(childValue, childKey),
    ]),
  );
}

function containsCredentialMaterial(value: unknown): boolean {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  const record = asRecord(value);
  return Boolean(
    record &&
    Object.entries(record).some(([key, child]) =>
      /(?:password|authorization|access.?token|refresh.?token|secret|api.?key|cookie)/i.test(key)
        ? Boolean(child)
        : containsCredentialMaterial(child),
    ),
  );
}

function httpStatusFrom(text: string): number | undefined {
  const match = /\b(?:HTTP\s*)?(4\d\d|5\d\d)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function modelUnavailable(records: unknown[], failure: unknown): boolean {
  const messages = [
    ...records.map((record) => errorText(asRecord(record)?.error)),
    errorText(failure),
  ].join("\n");
  const hasNotFoundStatus = records.some((record) => {
    const item = asRecord(record);
    const error = asRecord(item?.error);
    return (
      finiteNumber(item?.httpStatus) === 404 ||
      finiteNumber(item?.statusCode) === 404 ||
      finiteNumber(error?.status) === 404 ||
      finiteNumber(error?.statusCode) === 404 ||
      httpStatusFrom(errorText(item?.error)) === 404
    );
  });
  return (
    hasNotFoundStatus ||
    /model.{0,60}(?:not found|does not exist|unavailable|no endpoints)|(?:not found|does not exist|unavailable|no endpoints).{0,60}model/i.test(
      messages,
    )
  );
}

function coverageFactSet(research: JsonRecord | undefined): Set<string> {
  return new Set(stringArray(asRecord(research?.answerCoverage)?.resolvedFacts));
}

function countDuplicateStatements(answer: string): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const line of answer.split(/\r?\n/)) {
    const normalized = line
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/\[\d+\]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!normalized) continue;
    if (seen.has(normalized)) duplicates += 1;
    else seen.add(normalized);
  }
  return duplicates;
}

function citationMetrics(research: JsonRecord | undefined): JsonRecord {
  const audit = asRecord(research?.citationAudit);
  const report = asRecord(research?.citationValidation);
  const items = asArray(report?.items).map(asRecord).filter(Boolean) as JsonRecord[];
  return {
    validationStatus: research?.citationValidationStatus ?? "NOT_REACHED",
    invalidCitationMarkers: asArray(audit?.invalidMarkers),
    uncitedSentences: asArray(audit?.uncitedSentences),
    unsupportedStatements: items.filter((item) => item.verdict === "UNSUPPORTED").length,
    partiallySupportedStatements: items.filter((item) => item.verdict === "PARTIALLY_SUPPORTED")
      .length,
    insufficientEvidenceStatements: items.filter((item) => item.verdict === "INSUFFICIENT_EVIDENCE")
      .length,
    semanticItems: items,
  };
}

function getGates(report: JsonRecord | undefined): BakeoffGate[] {
  const research = asRecord(report?.research);
  const answerCoverage = asRecord(research?.answerCoverage);
  const officialCoverage = asRecord(research?.officialEvidenceStatus);
  const citation = citationMetrics(research);
  const missingAnswerFacts = stringArray(answerCoverage?.missingRequestedFacts);
  const resolvedAnswerFacts = coverageFactSet(research);
  const officialSources = asArray(research?.officialSources);
  const citationStatus = citation.validationStatus;
  const cleanupFailures = stringArray(report?.cleanupFailures);
  const researchStatus = research?.status === "COMPLETED";
  const workerStatus = research?.jobStatus === "completed";
  const limits = asRecord(report?.limits);
  const canonicalContractPassed =
    report?.question === MODEL_BAKEOFF_QUESTION &&
    Object.entries(REQUIRED_CANONICAL_LIMITS).every(
      ([key, expected]) => limits?.[key] === expected,
    ) &&
    report?.memoryPath === "excluded from this Serper/retrieval/citation phase" &&
    report?.executionScope === "research-only; no Post Agent, topic, run, post, or follow-up" &&
    (report?.postAgent === undefined || report.postAgent === "SKIPPED") &&
    (report?.postFollowUp === undefined || report.postFollowUp === "SKIPPED");
  const audit = asRecord(research?.citationAudit);
  const gates: BakeoffGate[] = [
    {
      name: "canonical_run_contract",
      passed: canonicalContractPassed,
      detail: canonicalContractPassed
        ? "question, research-only scope, memory exclusion, and existing limits match"
        : "question, scope, memory exclusion, or existing evaluation limits differ",
    },
    {
      name: "isolated_fixture_ids_present",
      passed: Boolean(report?.temporaryUserId && report?.sessionId && report?.jobId),
      detail: "temporary user, session, and job identifiers are required for isolation audit",
    },
    {
      name: "research_completed",
      passed: researchStatus && workerStatus,
      detail: `research=${String(research?.status ?? "NOT_REACHED")}; worker=${String(research?.jobStatus ?? "NOT_REACHED")}`,
    },
    ...REQUIRED_FACTS.map((fact) => ({
      name: `answer_fact:${fact}`,
      passed: resolvedAnswerFacts.has(fact) && !missingAnswerFacts.includes(fact),
      detail: resolvedAnswerFacts.has(fact) ? "present" : "missing",
    })),
    {
      name: "official_provenance",
      passed:
        officialCoverage?.required === true &&
        stringArray(officialCoverage.missingRequestedFacts).length === 0 &&
        officialSources.length > 0,
      detail: `${officialSources.length} official source(s); missing official facts=${stringArray(officialCoverage?.missingRequestedFacts).join(",") || "none"}`,
    },
    {
      name: "citation_validation",
      passed:
        citationStatus === "VALIDATED" &&
        asArray(audit?.invalidMarkers).length === 0 &&
        asArray(audit?.uncitedSentences).length === 0 &&
        Number(citation.unsupportedStatements) === 0 &&
        Number(citation.partiallySupportedStatements) === 0 &&
        Number(citation.insufficientEvidenceStatements) === 0,
      detail: `status=${String(citationStatus)}; invalid=${asArray(audit?.invalidMarkers).length}; uncited=${asArray(audit?.uncitedSentences).length}`,
    },
    {
      name: "owner_readback",
      passed: report?.ownerReadbackResult === "PASSED",
      detail: String(report?.ownerReadbackResult ?? "NOT_REACHED"),
    },
    {
      name: "cleanup",
      passed: report?.cleanupVerified === true && cleanupFailures.length === 0,
      detail:
        cleanupFailures.join("; ") ||
        (report?.cleanupVerified === true ? "verified" : "not verified"),
    },
  ];
  return gates;
}

function usageMetrics(report: JsonRecord | undefined): JsonRecord {
  const openRouter = asRecord(report?.openRouter);
  const usage = asRecord(openRouter?.usage);
  return {
    promptTokens: finiteNumber(usage?.promptTokens) ?? null,
    completionTokens: finiteNumber(usage?.completionTokens) ?? null,
    reasoningTokens: finiteNumber(usage?.reasoningTokens) ?? null,
    cachedTokens: finiteNumber(usage?.cachedTokens) ?? null,
    totalTokens: finiteNumber(usage?.totalTokens) ?? null,
    reportedOpenRouterCost: finiteNumber(usage?.cost) ?? null,
    serperCost: null,
    note: "Null means the current provider response/runner did not report that metric.",
  };
}

function providerErrors(report: JsonRecord | undefined): JsonRecord[] {
  const openRouter = asRecord(report?.openRouter);
  return asArray(openRouter?.records)
    .map(asRecord)
    .filter((record): record is JsonRecord => Boolean(record))
    .filter(
      (record) =>
        Boolean(record.failureCategory) ||
        record.responseParseResult === "INVALID_JSON" ||
        record.responseParseResult === "TRUNCATED" ||
        record.responseValidationResult === "FAILED",
    )
    .map((record) => {
      const error = errorText(record.error);
      const errorDetails = asRecord(record.error);
      return {
        provider: record.provider ?? "OpenRouter",
        model: record.model,
        purpose: record.purpose,
        role: record.role,
        httpStatus:
          finiteNumber(record.httpStatus) ??
          finiteNumber(record.statusCode) ??
          finiteNumber(errorDetails?.status) ??
          finiteNumber(errorDetails?.statusCode) ??
          httpStatusFrom(error) ??
          null,
        failureCategory:
          record.failureCategory ?? record.responseParseResult ?? "VALIDATION_FAILURE",
        durationMs: record.durationMs,
        responseParseResult: record.responseParseResult,
        responseValidationResult: record.responseValidationResult,
        error: scrubText(error),
      };
    });
}

export function summarizeBakeoffRun(args: {
  modelId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  processExitCode: number | null;
  reportPath?: string;
  runReport?: JsonRecord;
  credentialAuditPassed: boolean;
  environmentRestored: boolean;
}): ModelBakeoffResult {
  const report = args.runReport;
  const research = asRecord(report?.research);
  const callRecords = asArray(asRecord(report?.openRouter)?.records);
  const errors = providerErrors(report);
  const gates = getGates(report);
  const requiredFacts = stringArray(asRecord(research?.answerCoverage)?.requiredFacts);
  const answer = typeof research?.answer === "string" ? research.answer : "";
  const synthesis = asRecord(research?.synthesisTelemetry);
  const decisions = asArray(research?.decisions).map(asRecord).filter(Boolean) as JsonRecord[];
  const actionCalls = callRecords
    .map(asRecord)
    .filter((record) => record?.purpose === "research_action_decision");
  const rawFailure = asRecord(report?.failure);
  const unavailable = modelUnavailable(callRecords, rawFailure);
  const failedCallCount = errors.length;
  const successfulCallCount = callRecords.filter((record) => {
    const item = asRecord(record);
    return (
      !item?.failureCategory &&
      item?.error === undefined &&
      item?.responseParseResult !== "INVALID_JSON" &&
      item?.responseParseResult !== "TRUNCATED" &&
      item?.responseValidationResult !== "FAILED"
    );
  }).length;
  const cleanupVerified = report?.cleanupVerified === true;
  const allGatesPassed = gates.every((gate) => gate.passed);
  const status: ModelBakeoffResult["status"] = allGatesPassed
    ? "COMPLETE"
    : unavailable
      ? "UNAVAILABLE"
      : report
        ? "PARTIAL"
        : "BLOCKED";
  const stepDurations = asArray(research?.steps)
    .map(asRecord)
    .map((step) => finiteNumber(step?.durationMs) ?? 0);
  const sources = asArray(research?.sources);
  const pages = asArray(research?.pageFetchSources);
  const search = asRecord(report?.serper);
  const startId = typeof report?.temporaryUserId === "string" ? report.temporaryUserId : undefined;
  const jobTransitions = asArray(report?.jobTransitions);

  return {
    modelId: args.modelId,
    provider: "OpenRouter",
    status,
    modelAvailability: unavailable
      ? "UNAVAILABLE"
      : successfulCallCount > 0
        ? "AVAILABLE"
        : failedCallCount > 0
          ? "REQUEST_FAILED"
          : "NOT_TESTED",
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMs: args.durationMs,
    processExitCode: args.processExitCode,
    reportPath: args.reportPath,
    failureStage: typeof report?.failureStage === "string" ? report.failureStage : undefined,
    failure: rawFailure ? (sanitizeJson(rawFailure) as JsonRecord) : undefined,
    gates,
    metrics: {
      researchStatus: research?.status ?? "NOT_REACHED",
      workerStatus: research?.jobStatus ?? "NOT_REACHED",
      attempts: research?.attempts ?? null,
      stepCount: asArray(research?.steps).length,
      researchStepDurationMs: stepDurations.reduce((total, value) => total + value, 0),
      totalDurationMs: finiteNumber(report?.totalDurationMs) ?? args.durationMs,
      totalOpenRouterCalls: callRecords.length,
      serperCalls: finiteNumber(search?.requests) ?? research?.serperRequests ?? 0,
      searchQueries: asArray(search?.queries),
      sourcesSelected: sources.length,
      sourceSummaries: sources.map((source) => {
        const item = asRecord(source);
        return {
          title: item?.title,
          url: item?.url,
          domain: item?.domain,
          sourceType: item?.sourceType,
          retrievalMethod: item?.retrievalMethod,
          extractionStatus: item?.extractionStatus,
        };
      }),
      pagesFetched: pages.length,
      pageSummaries: pages,
      actionDecisionCalls: actionCalls.length,
      successfulModelDecisions: decisions.filter(
        (decision) => decision.controllerDecision === "allow",
      ).length,
      rateLimitFailures: errors.filter((error) => error.failureCategory === "RATE_LIMIT").length,
      malformedResponses: errors.filter(
        (error) =>
          error.failureCategory === "MALFORMED_RESPONSE" ||
          error.failureCategory === "INVALID_JSON" ||
          error.failureCategory === "TRUNCATED",
      ).length,
      timeoutFailures: errors.filter((error) => error.failureCategory === "TIMEOUT").length,
      deterministicActionFallbacks: decisions.filter(
        (decision) => decision.controllerDecision === "fallback",
      ).length,
      invalidModelActions: decisions.filter(
        (decision) => decision.controllerDecision === "override",
      ).length,
      synthesisAttempted: synthesis?.attempted ?? false,
      synthesisFailure: synthesis?.failureCategory ?? null,
      synthesisSource: synthesis?.finalAnswerSource ?? "unavailable",
      deterministicSynthesisFallback: synthesis?.fallbackUsed ?? null,
      requiredFacts,
      resolvedFacts: stringArray(asRecord(research?.answerCoverage)?.resolvedFacts),
      missingFacts: stringArray(asRecord(research?.answerCoverage)?.missingRequestedFacts),
      versionStated: coverageFactSet(research).has("version"),
      releaseDateStated: coverageFactSet(research).has("release date"),
      stableStatusStated: coverageFactSet(research).has("stable status"),
      latestnessStated: coverageFactSet(research).has("latestness"),
      officialProvenanceSatisfied:
        gates.find((gate) => gate.name === "official_provenance")?.passed ?? false,
      allRequiredFactsCovered:
        requiredFacts.length === REQUIRED_FACTS.length &&
        REQUIRED_FACTS.every((fact) => coverageFactSet(research).has(fact)),
      duplicateStatements: countDuplicateStatements(answer),
      omittedStatements: stringArray(asRecord(research?.answerCoverage)?.missingRequestedFacts),
      citation: citationMetrics(research),
      ownerReadback: report?.ownerReadbackResult ?? "NOT_REACHED",
      ownerReadbackAttempted:
        report?.ownerReadbackResult !== undefined && report.ownerReadbackResult !== "NOT_REACHED",
      ownerReadbackDurationMs: finiteNumber(report?.ownerReadbackDurationMs) ?? null,
      openRouterUsage: usageMetrics(report),
      providerErrors: errors,
      jobTransitions,
      temporaryUserId: startId,
      sessionId:
        typeof report?.sessionId === "string"
          ? report.sessionId
          : typeof research?.sessionId === "string"
            ? research.sessionId
            : undefined,
      jobId:
        typeof report?.jobId === "string"
          ? report.jobId
          : typeof research?.jobId === "string"
            ? research.jobId
            : undefined,
      cleanupFailures: stringArray(report?.cleanupFailures),
      reportedModelId: typeof report?.model === "string" ? report.model : undefined,
      actualCallModelIds: callRecords
        .map((record) => asRecord(record)?.model)
        .filter((value): value is string => typeof value === "string"),
    },
    cleanupVerified,
    credentialAuditPassed: args.credentialAuditPassed,
    environmentRestored: args.environmentRestored,
    safeToContinue: false,
    continuationReason: "Continuation safety has not been evaluated",
    rawRunResult: report ? (sanitizeJson(report) as JsonRecord) : undefined,
  };
}

export async function runSequentialModelTasks<T>(
  models: readonly string[],
  runOne: (model: string, index: number) => Promise<T>,
  continueAfter: (result: T, index: number) => boolean,
  afterResult?: (result: T, allResults: readonly T[], index: number) => Promise<void>,
): Promise<SequentialRunResult<T>> {
  const results: T[] = [];
  for (let index = 0; index < models.length; index += 1) {
    const result = await runOne(models[index]!, index);
    results.push(result);
    await afterResult?.(result, results, index);
    if (!continueAfter(result, index)) return { results, stoppedIndex: index };
  }
  return { results };
}

function markdownCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ");
}

export function renderBakeoffMarkdown(report: JsonRecord): string {
  const results = asArray(report.results).map(asRecord).filter(Boolean) as JsonRecord[];
  const rows = results.map((result) => {
    const metrics = asRecord(result.metrics) ?? {};
    const usage = asRecord(metrics.openRouterUsage) ?? {};
    const citation = asRecord(metrics.citation) ?? {};
    const tokens = usage.totalTokens ?? "n/a";
    const cost = usage.reportedOpenRouterCost;
    return `| ${markdownCell(result.modelId)} | ${markdownCell(metrics.researchStatus)} | ${markdownCell(`${stringArray(metrics.resolvedFacts).length}/${stringArray(metrics.requiredFacts).length}`)} | ${markdownCell(citation.validationStatus)} | ${markdownCell(metrics.ownerReadback)} | ${markdownCell(metrics.deterministicSynthesisFallback)} | ${markdownCell(metrics.totalDurationMs)} ms | ${markdownCell(tokens)} | ${cost === null || cost === undefined ? "n/a" : `$${Number(cost).toFixed(6)}`} | ${markdownCell(result.status)} |`;
  });
  const sections = results.map((result) => {
    const metrics = asRecord(result.metrics) ?? {};
    const gates = asArray(result.gates).map(asRecord).filter(Boolean) as JsonRecord[];
    const errors = asArray(metrics.providerErrors).map(asRecord).filter(Boolean) as JsonRecord[];
    const usage = asRecord(metrics.openRouterUsage) ?? {};
    const failedGates = gates.filter((gate) => gate.passed !== true);
    return [
      `## ${String(result.modelId)}`,
      "",
      `Status: ${String(result.status)} (${String(result.modelAvailability)})`,
      `Failure stage: ${String(result.failureStage ?? "none recorded")}`,
      `Research: ${String(metrics.researchStatus)}; worker=${String(metrics.workerStatus)}; steps=${String(metrics.stepCount)}; Serper=${String(metrics.serperCalls)}; sources=${String(metrics.sourcesSelected)}; pages=${String(metrics.pagesFetched)}`,
      `Answer: resolved=${stringArray(metrics.resolvedFacts).join(", ") || "none"}; missing=${stringArray(metrics.missingFacts).join(", ") || "none"}; duplicates=${String(metrics.duplicateStatements)}`,
      `Citations: ${String(asRecord(metrics.citation)?.validationStatus)}; unsupported=${String(asRecord(metrics.citation)?.unsupportedStatements)}; partial=${String(asRecord(metrics.citation)?.partiallySupportedStatements)}; invalid=${asArray(asRecord(metrics.citation)?.invalidCitationMarkers).length}; uncited=${asArray(asRecord(metrics.citation)?.uncitedSentences).length}`,
      `Owner readback: attempted=${String(metrics.ownerReadbackAttempted)}; result=${String(metrics.ownerReadback)}${metrics.ownerReadbackDurationMs === null ? "" : ` (${String(metrics.ownerReadbackDurationMs)} ms)`}`,
      `Provider errors: ${errors.length ? errors.map((error) => `${String(error.failureCategory)}${error.httpStatus ? ` HTTP ${String(error.httpStatus)}` : ""} ${String(error.error ?? "")}`).join("; ") : "none"}`,
      `Fallback used: ${String(metrics.deterministicSynthesisFallback)}; synthesis=${String(metrics.synthesisSource)}${metrics.synthesisFailure ? ` (${String(metrics.synthesisFailure)})` : ""}`,
      `Latency: ${String(metrics.totalDurationMs)} ms`,
      `Tokens: prompt=${String(usage.promptTokens)}, completion=${String(usage.completionTokens)}, reasoning=${String(usage.reasoningTokens)}, cached=${String(usage.cachedTokens)}, total=${String(usage.totalTokens)}`,
      `Cost: OpenRouter=${usage.reportedOpenRouterCost === null ? "not reported" : `$${String(usage.reportedOpenRouterCost)}`}; Serper=${String(usage.serperCost)}`,
      `Cleanup: ${String(result.cleanupVerified)}; credentials audit=${String(result.credentialAuditPassed)}; config restored=${String(result.environmentRestored)}`,
      `Failed gates: ${failedGates.length ? failedGates.map((gate) => `${String(gate.name)} (${String(gate.detail ?? "failed")})`).join("; ") : "none"}`,
      `Failure: ${JSON.stringify(result.failure ?? null)}`,
      "",
    ].join("\n");
  });
  return [
    "# MODEL BAKE-OFF",
    "",
    `Evaluation status: ${String(report.status)}`,
    `Canonical question: ${String(report.question)}`,
    `Runs: ${results.length}/${MODEL_BAKEOFF_MODELS.length}`,
    "",
    "| Model | Research | Fact Coverage | Citation | Owner Readback | Fallback | Latency | Tokens | Cost | Result |",
    "|------|----------|---------------|----------|----------------|----------|---------|--------|------|--------|",
    ...rows,
    "",
    ...sections,
    "## CROSS-MODEL OBSERVATIONS",
    "",
    `Completed run entries: ${results.length}. Quality-gate passes: ${results.filter((result) => result.status === "COMPLETE").length}.`,
    `Provider/model failures recorded: ${results.reduce((total, result) => total + asArray(asRecord(result.metrics)?.providerErrors).length, 0)}.`,
    `Cleanup verified for: ${results.filter((result) => result.cleanupVerified === true).length}/${results.length}.`,
    "No subjective ranking is calculated.",
    "",
  ].join("\n");
}

function timestampSlug(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

export function resolveEvaluationReportPath(pathValue: string, apiRoot: string): string {
  const reportsDirectory = resolve(apiRoot, "evaluation-results");
  const reportPath = resolve(apiRoot, pathValue);
  if (
    dirname(reportPath).toLowerCase() !== reportsDirectory.toLowerCase() ||
    !/^serper-citation-integration-[\w-]+\.json$/.test(basename(reportPath))
  ) {
    throw new Error("Canonical evaluator report path is outside its evaluation-results directory");
  }
  return reportPath;
}

export function resolveCanonicalReportPath(rawJsonPath: string, apiRoot: string): string {
  let decodedPath: string;
  try {
    decodedPath = JSON.parse(`"${rawJsonPath}"`) as string;
  } catch {
    throw new Error("Canonical evaluator emitted an invalid JSON report path");
  }
  return resolveEvaluationReportPath(decodedPath, apiRoot);
}

export function parseResumeReportPaths(arguments_: readonly string[]): string[] {
  const paths: string[] = [];
  const forwardedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  for (let index = 0; index < forwardedArguments.length; index += 1) {
    const argument = forwardedArguments[index]!;
    if (argument.startsWith("--resume-report=")) {
      const value = argument.slice("--resume-report=".length);
      if (!value) throw new Error("--resume-report requires a path");
      paths.push(value);
      continue;
    }
    if (argument === "--resume-report") {
      const value = forwardedArguments[index + 1];
      if (!value) throw new Error("--resume-report requires a path");
      paths.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown model bake-off argument: ${argument}`);
  }
  return paths;
}

export function evaluationChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  modelId: string,
): NodeJS.ProcessEnv {
  return { ...baseEnvironment, OPENROUTER_MODEL: modelId };
}

async function spawnCanonicalRun(modelId: string, apiRoot: string) {
  const childEnv = evaluationChildEnvironment(process.env, modelId);
  let stdoutTail = "";
  let stderrTail = "";
  const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--env-file=../../.env",
          "--import",
          "tsx",
          "src/evaluation/serper-citation-integration.ts",
          "--research-only",
        ],
        { cwd: apiRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutTail = appendTail(stdoutTail, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
    },
  );

  const pathMatch = [...stdoutTail.matchAll(/"reportPath"\s*:\s*"([^"]+\.json)"/g)].at(-1)?.[1];
  let reportPath: string | undefined;
  let runReport: JsonRecord | undefined;
  if (pathMatch) {
    reportPath = resolveCanonicalReportPath(pathMatch, apiRoot);
    runReport = asRecord(JSON.parse(await readFile(reportPath, "utf8")));
  }
  return {
    ...exit,
    reportPath,
    runReport,
    stderrSummary: scrubText(stderrTail.slice(-4_000)),
  };
}

function summarizeTransportPreflight(result: Awaited<ReturnType<typeof checkLiveNetwork>>) {
  return {
    status: result.status,
    ready: result.ready,
    missingConfiguration: result.missingConfiguration,
    endpoints: result.endpoints,
    note: result.note,
  };
}

function hasCompletedResearch(runReport: JsonRecord | undefined): boolean {
  const research = asRecord(runReport?.research);
  return research?.status === "COMPLETED" && research.jobStatus === "completed";
}

function continuationReason(result: ModelBakeoffResult, runReport: JsonRecord | undefined): string {
  if (!runReport)
    return "Canonical per-run report is missing; stopping because the run is unverified";
  if (!result.cleanupVerified)
    return "Cleanup was not verified; stopping before another remote fixture";
  if (!result.credentialAuditPassed)
    return "Credential audit failed; stopping at the safety boundary";
  if (!result.environmentRestored) return "Production model configuration was not restored";
  if (result.gates.find((gate) => gate.name === "canonical_run_contract")?.passed !== true) {
    return "The canonical question, scope, model budget, or no-memory contract did not match";
  }
  if (result.metrics.isolationIdsPresent !== true) {
    return "Temporary user, research session, or durable job identity is missing";
  }
  if (result.modelAvailability === "UNAVAILABLE") {
    return "Requested model was unavailable; exact provider failure was recorded and the next model may run";
  }
  if (result.modelAvailability === "REQUEST_FAILED") {
    return "OpenRouter request failed for this model; failure was recorded and the next model may run";
  }
  if (asArray(result.metrics.providerErrors).length > 0) {
    return "An OpenRouter call failed or returned an invalid response; recorded it and will compare the next model";
  }
  if (result.modelAvailability === "NOT_TESTED") {
    return "No OpenRouter request was recorded; this run did not test the requested model";
  }
  if (hasCompletedResearch(runReport)) {
    return result.status === "COMPLETE"
      ? "Quality gates passed; safe to continue with the next isolated model run"
      : "Research completed but quality gates were not all met; safe to compare the next isolated model";
  }
  return "Research/job did not complete and no model-specific provider failure explains it";
}

export function evaluateBakeoffContinuation(
  result: ModelBakeoffResult,
  runReport: JsonRecord | undefined,
  modelIdentityMatches = true,
): { safeToContinue: boolean; reason: string } {
  const canContinue =
    Boolean(runReport) &&
    result.cleanupVerified &&
    result.credentialAuditPassed &&
    result.environmentRestored &&
    modelIdentityMatches &&
    result.gates.find((gate) => gate.name === "canonical_run_contract")?.passed === true &&
    result.metrics.isolationIdsPresent === true &&
    (result.modelAvailability === "UNAVAILABLE" ||
      result.modelAvailability === "REQUEST_FAILED" ||
      asArray(result.metrics.providerErrors).length > 0 ||
      hasCompletedResearch(runReport));
  const reason = !modelIdentityMatches
    ? "The requested model ID did not match the reported or called model"
    : continuationReason(result, runReport);
  return { safeToContinue: canContinue, reason };
}

function shouldContinueAfterRun(result: ModelBakeoffResult): boolean {
  return result.safeToContinue;
}

async function recoverExistingRun(args: {
  pathValue: string;
  modelId: string;
  apiRoot: string;
  environmentFile: string;
  environmentFileDigest: string;
  originalProcessModel: string | undefined;
}): Promise<ModelBakeoffResult> {
  const reportPath = resolveEvaluationReportPath(args.pathValue, args.apiRoot);
  const fileInfo = await stat(reportPath);
  const runReport = asRecord(JSON.parse(await readFile(reportPath, "utf8")));
  if (!runReport) throw new Error("Resumed canonical report is not a JSON object");
  const rawHadCredentials = containsCredentialMaterial(runReport);
  const sanitizedReport = sanitizeJson(runReport) as JsonRecord;
  if (rawHadCredentials) {
    await writeFile(reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, "utf8");
  }
  const endedAt = new Date(fileInfo.mtimeMs).toISOString();
  const durationMs = finiteNumber(runReport.totalDurationMs) ?? 0;
  const result = summarizeBakeoffRun({
    modelId: args.modelId,
    startedAt: new Date(fileInfo.mtimeMs - durationMs).toISOString(),
    endedAt,
    durationMs,
    processExitCode: runReport.status === "RESEARCH_VERIFIED" ? 0 : 1,
    reportPath,
    runReport: sanitizedReport,
    credentialAuditPassed: !rawHadCredentials,
    environmentRestored:
      process.env.OPENROUTER_MODEL === args.originalProcessModel &&
      createHash("sha256")
        .update(await readFile(args.environmentFile))
        .digest("hex") === args.environmentFileDigest,
  });
  result.recoveredExistingRun = true;
  const research = asRecord(sanitizedReport.research);
  result.metrics.sessionId =
    typeof sanitizedReport.sessionId === "string"
      ? sanitizedReport.sessionId
      : typeof research?.sessionId === "string"
        ? research.sessionId
        : undefined;
  result.metrics.jobId =
    typeof sanitizedReport.jobId === "string"
      ? sanitizedReport.jobId
      : typeof research?.jobId === "string"
        ? research.jobId
        : undefined;
  result.metrics.isolationIdsPresent = Boolean(
    result.metrics.temporaryUserId && result.metrics.sessionId && result.metrics.jobId,
  );
  const actualCallModels = stringArray(
    asArray(asRecord(sanitizedReport.openRouter)?.records).map((record) => asRecord(record)?.model),
  );
  const identityMatches =
    sanitizedReport.model === args.modelId &&
    actualCallModels.length > 0 &&
    actualCallModels.every((actual) => actual === args.modelId);
  if (!identityMatches) {
    result.status = "BLOCKED";
    result.failure = {
      name: "ModelIdentityMismatch",
      message: `Resumed trace does not prove the requested ${args.modelId} model was used`,
    };
  }
  if (rawHadCredentials) {
    result.status = "BLOCKED";
    result.failure = {
      name: "CredentialMaterialDetected",
      message: "Resumed canonical report contained credential-shaped data and was redacted",
    };
  }
  const continuation = evaluateBakeoffContinuation(result, sanitizedReport, identityMatches);
  result.safeToContinue = continuation.safeToContinue;
  result.continuationReason = continuation.reason;
  return result;
}

export async function runModelBakeoff(): Promise<void> {
  const resumeReportArguments = parseResumeReportPaths(process.argv.slice(2));
  if (resumeReportArguments.length > MODEL_BAKEOFF_MODELS.length) {
    throw new Error("More resumed reports were supplied than configured bake-off models");
  }
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const apiRoot = resolve(sourceDirectory, "../..");
  const repositoryRoot = resolve(apiRoot, "../..");
  const outputDirectory = resolve(apiRoot, "evaluation-results");
  const outputSlug = `${timestampSlug()}-${randomUUID()}`;
  const jsonPath = resolve(outputDirectory, `model-bakeoff-${outputSlug}.json`);
  const markdownPath = resolve(outputDirectory, `model-bakeoff-${outputSlug}.md`);
  const environmentFile = resolve(repositoryRoot, ".env");
  const environmentFileDigest = createHash("sha256")
    .update(await readFile(environmentFile))
    .digest("hex");
  const originalProcessModel = process.env.OPENROUTER_MODEL;
  const configuredModel = config.OPENROUTER_MODEL;
  const startedAt = new Date().toISOString();
  const report: JsonRecord = {
    schemaVersion: 1,
    status: "RUNNING",
    question: MODEL_BAKEOFF_QUESTION,
    models: [...MODEL_BAKEOFF_MODELS],
    startedAt,
    productionModelBefore: configuredModel,
    environmentOverride: "OPENROUTER_MODEL set only in each child process",
    resumedRunReports: [],
    processConfigRestored: false,
    envFileRestored: false,
    results: [],
  };
  const results: ModelBakeoffResult[] = [];

  for (const [index, pathValue] of resumeReportArguments.entries()) {
    const expectedModel = MODEL_BAKEOFF_MODELS[index];
    if (!expectedModel)
      throw new Error("Resume report model index is outside the configured model list");
    const recovered = await recoverExistingRun({
      pathValue,
      modelId: expectedModel,
      apiRoot,
      environmentFile,
      environmentFileDigest,
      originalProcessModel,
    });
    results.push(recovered);
    (report.resumedRunReports as string[]).push(recovered.reportPath ?? pathValue);
    if (!recovered.safeToContinue) report.stopReason = recovered.continuationReason;
  }

  const writeCheckpoint = async (status: string) => {
    report.status = status;
    report.completedAt = new Date().toISOString();
    report.processConfigRestored = process.env.OPENROUTER_MODEL === originalProcessModel;
    const currentDigest = createHash("sha256")
      .update(await readFile(environmentFile))
      .digest("hex");
    report.envFileRestored = currentDigest === environmentFileDigest;
    report.productionModelAfter = config.OPENROUTER_MODEL;
    report.results = results;
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, renderBakeoffMarkdown(report), "utf8");
  };

  const preflight = await checkLiveNetwork({
    supabaseUrl: config.SUPABASE_URL,
    openRouterBaseUrl: config.OPENROUTER_BASE_URL,
    requiredConfiguration: [
      { name: "SUPABASE_URL", configured: Boolean(config.SUPABASE_URL) },
      {
        name: "SUPABASE_SECRET_KEY",
        configured: Boolean(config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY),
      },
      { name: "SUPABASE_PUBLISHABLE_KEY", configured: Boolean(config.SUPABASE_PUBLISHABLE_KEY) },
      { name: "SERPER_API_KEY", configured: Boolean(config.SERPER_API_KEY) },
      { name: "OPENROUTER_API_KEY", configured: Boolean(config.OPENROUTER_API_KEY) },
    ],
  });
  report.networkPreflight = summarizeTransportPreflight(preflight);
  if (!preflight.ready) {
    await writeCheckpoint("BLOCKED_PREFLIGHT");
    process.stdout.write(`Bake-off stopped at side-effect-free preflight. Report: ${jsonPath}\n`);
    process.exitCode = 1;
    return;
  }

  if (report.stopReason) {
    await writeCheckpoint("BLOCKED_RESUMED_RUN");
    process.stdout.write(`Bake-off stopped while validating a resumed run. Report: ${jsonPath}\n`);
    process.exitCode = 1;
    return;
  }

  if (results.length > 0) {
    const cleanupIds = results.map((item) => item.metrics.temporaryUserId).filter(Boolean);
    const sessionIds = results.map((item) => item.metrics.sessionId).filter(Boolean);
    const jobIds = results.map((item) => item.metrics.jobId).filter(Boolean);
    const uniqueAndPresent =
      results.every((item) => item.metrics.isolationIdsPresent === true) &&
      new Set(cleanupIds).size === cleanupIds.length &&
      new Set(sessionIds).size === sessionIds.length &&
      new Set(jobIds).size === jobIds.length;
    report.isolationIdsUnique = uniqueAndPresent;
    if (!uniqueAndPresent) {
      report.stopReason = "Resumed runs do not prove unique temporary user/session/job IDs";
      await writeCheckpoint("BLOCKED_RESUMED_ISOLATION");
      process.exitCode = 1;
      return;
    }
  }

  const resumedResults = [...results];
  const modelsToRun = MODEL_BAKEOFF_MODELS.slice(resumedResults.length);
  await runSequentialModelTasks(
    modelsToRun,
    async (modelId, index) => {
      const modelIndex = resumedResults.length + index;
      const startedAt = new Date().toISOString();
      const startedClock = Date.now();
      process.stdout.write(
        `[${modelIndex + 1}/${MODEL_BAKEOFF_MODELS.length}] Starting ${modelId}\n`,
      );
      let child: Awaited<ReturnType<typeof spawnCanonicalRun>>;
      try {
        child = await spawnCanonicalRun(modelId, apiRoot);
      } catch (error) {
        const result: ModelBakeoffResult = {
          modelId,
          provider: "OpenRouter",
          status: "BLOCKED",
          modelAvailability: "NOT_TESTED",
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedClock,
          processExitCode: null,
          failure: {
            name: error instanceof Error ? error.name : "SpawnFailure",
            message: scrubText(
              error instanceof Error ? error.message : "Canonical runner failed to start",
            ),
          },
          gates: [],
          metrics: {},
          cleanupVerified: false,
          credentialAuditPassed: true,
          environmentRestored: process.env.OPENROUTER_MODEL === originalProcessModel,
          safeToContinue: false,
          continuationReason: "Canonical runner did not start; no run or cleanup can be verified",
        };
        return result;
      }
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startedClock;
      const runReport = child.runReport;
      const rawHadCredentials = runReport ? containsCredentialMaterial(runReport) : false;
      const sanitizedReport = runReport ? (sanitizeJson(runReport) as JsonRecord) : undefined;
      if (rawHadCredentials && child.reportPath && sanitizedReport) {
        await writeFile(child.reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, "utf8");
      }
      const environmentDigest = createHash("sha256")
        .update(await readFile(environmentFile))
        .digest("hex");
      const environmentRestored =
        process.env.OPENROUTER_MODEL === originalProcessModel &&
        environmentDigest === environmentFileDigest;
      const result = summarizeBakeoffRun({
        modelId,
        startedAt,
        endedAt,
        durationMs,
        processExitCode: child.exitCode,
        reportPath: child.reportPath,
        runReport: sanitizedReport,
        credentialAuditPassed: !rawHadCredentials,
        environmentRestored,
      });
      if (!child.runReport) {
        result.status = "BLOCKED";
        result.modelAvailability = "NOT_TESTED";
        result.failure = {
          name: "CanonicalRunnerReportMissing",
          message:
            child.stderrSummary || "Canonical evaluator did not produce a per-run JSON report",
        };
      }
      if (sanitizedReport && sanitizedReport.model !== modelId) {
        result.status = "BLOCKED";
        result.failure = {
          name: "ModelOverrideMismatch",
          message: `Requested ${modelId}; canonical evaluator reported ${String(sanitizedReport.model ?? "no model id")}`,
        };
      }
      if (rawHadCredentials) {
        result.status = "BLOCKED";
        result.failure = {
          name: "CredentialMaterialDetected",
          message:
            "The canonical run report contained a credential-shaped value; value was redacted before aggregation",
        };
      }
      const actualCallModels = asArray(asRecord(sanitizedReport?.openRouter)?.records)
        .map(asRecord)
        .map((record) => record?.model)
        .filter((value): value is string => typeof value === "string");
      if (actualCallModels.some((actual) => actual !== modelId)) {
        result.status = "BLOCKED";
        result.failure = {
          name: "ModelSubstitutionDetected",
          message: `Requested ${modelId}; calls recorded other model IDs: ${[...new Set(actualCallModels.filter((actual) => actual !== modelId))].join(", ")}`,
        };
      }
      const runResearch = asRecord(sanitizedReport?.research);
      result.metrics.sessionId =
        typeof sanitizedReport?.sessionId === "string"
          ? sanitizedReport.sessionId
          : typeof runResearch?.sessionId === "string"
            ? runResearch.sessionId
            : undefined;
      result.metrics.jobId =
        typeof sanitizedReport?.jobId === "string"
          ? sanitizedReport.jobId
          : typeof runResearch?.jobId === "string"
            ? runResearch.jobId
            : undefined;
      result.metrics.isolationIdsPresent = Boolean(
        result.metrics.temporaryUserId && result.metrics.sessionId && result.metrics.jobId,
      );
      const identityMatches =
        sanitizedReport?.model === modelId &&
        actualCallModels.length > 0 &&
        actualCallModels.every((actual) => actual === modelId);
      const continuation = evaluateBakeoffContinuation(result, sanitizedReport, identityMatches);
      result.safeToContinue = continuation.safeToContinue;
      result.continuationReason = continuation.reason;
      process.stdout.write(
        `[${modelIndex + 1}/${MODEL_BAKEOFF_MODELS.length}] ${modelId}: ${result.status}; cleanup=${result.cleanupVerified}; duration=${durationMs}ms\n`,
      );
      return result;
    },
    (result) => shouldContinueAfterRun(result),
    async (result, accumulated, index) => {
      results.splice(0, results.length, ...resumedResults, ...accumulated);
      const cleanupIds = results.map((item) => item.metrics.temporaryUserId).filter(Boolean);
      const sessionIds = results.map((item) => item.metrics.sessionId).filter(Boolean);
      const jobIds = results.map((item) => item.metrics.jobId).filter(Boolean);
      const isolationUnique =
        results.every((item) => item.metrics.isolationIdsPresent === true) &&
        new Set(cleanupIds).size === cleanupIds.length &&
        new Set(sessionIds).size === sessionIds.length &&
        new Set(jobIds).size === jobIds.length;
      report.isolationIdsUnique = isolationUnique;
      if (!isolationUnique) {
        result.status = "BLOCKED";
        result.safeToContinue = false;
        result.continuationReason =
          "Temporary user/session/job IDs are missing or reused across model runs";
        result.failure = {
          name: "EvaluationIsolationViolation",
          message:
            "A temporary user, research session, or durable job ID was reused across model runs",
        };
      }
      const environmentRestored = process.env.OPENROUTER_MODEL === originalProcessModel;
      const environmentDigest = createHash("sha256")
        .update(await readFile(environmentFile))
        .digest("hex");
      if (!environmentRestored || environmentDigest !== environmentFileDigest) {
        result.environmentRestored = false;
        result.status = "BLOCKED";
        result.safeToContinue = false;
        result.continuationReason = "Production model configuration changed during a run";
        result.failure = {
          name: "ProductionConfigurationChanged",
          message: "The bake-off process environment or .env changed during a model evaluation",
        };
      }
      if (!shouldContinueAfterRun(result)) {
        report.stopReason = result.continuationReason;
      }
      const done = resumedResults.length + index + 1 === MODEL_BAKEOFF_MODELS.length;
      const status = report.stopReason ? "BLOCKED" : done ? "COMPLETED" : "RUNNING";
      await writeCheckpoint(status);
    },
  ).then(async (sequence) => {
    results.splice(0, results.length, ...resumedResults, ...sequence.results);
    if (sequence.stoppedIndex !== undefined) await writeCheckpoint("BLOCKED");
  });

  const finalStatus = report.stopReason
    ? "BLOCKED"
    : results.length === MODEL_BAKEOFF_MODELS.length &&
        results.every(
          (result, index) =>
            result.modelId === MODEL_BAKEOFF_MODELS[index] &&
            result.cleanupVerified &&
            result.credentialAuditPassed &&
            result.environmentRestored &&
            result.safeToContinue,
        ) &&
        report.isolationIdsUnique === true
      ? "COMPLETED"
      : "INCOMPLETE";
  await writeCheckpoint(finalStatus);
  const saved = JSON.parse(await readFile(jsonPath, "utf8")) as JsonRecord;
  const savedResults = asArray(saved.results);
  if (
    savedResults.length !== results.length ||
    savedResults.some((entry, index) => asRecord(entry)?.modelId !== results[index]?.modelId)
  ) {
    throw new Error("Final bake-off report failed its result-count/order audit");
  }
  const finalDigest = createHash("sha256")
    .update(await readFile(environmentFile))
    .digest("hex");
  if (
    finalDigest !== environmentFileDigest ||
    process.env.OPENROUTER_MODEL !== originalProcessModel
  ) {
    throw new Error("Production model configuration restoration audit failed");
  }
  process.stdout.write(
    `Bake-off ${finalStatus}: ${results.length}/${MODEL_BAKEOFF_MODELS.length} model entries.\nJSON: ${jsonPath}\nMarkdown: ${markdownPath}\n`,
  );
  if (finalStatus !== "COMPLETED") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runModelBakeoff().catch((error) => {
    const message =
      error instanceof Error ? scrubText(error.message) : "Unknown bake-off harness failure";
    process.stderr.write(`Bake-off harness failed safely: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
