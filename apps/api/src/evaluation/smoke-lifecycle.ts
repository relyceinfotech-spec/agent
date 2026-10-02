import { safeErrorSummary } from "./safe-error-summary.js";

export type SmokeCleanupStatus =
  "not_started" | "not_required" | "attempted" | "completed" | "failed";

export interface SmokeLifecycleDiagnostics {
  stage: string;
  serverStartupCompleted: boolean;
  researchSubmissionAttempted: boolean;
  researchJobAccepted: boolean;
  providerCallCountersAvailable: boolean;
  serperCalls?: number;
  openRouterCalls?: number;
  cleanup: Record<string, SmokeCleanupStatus>;
  cleanupFailures: Array<{
    resource: string;
    name: string;
    message?: string;
    stackLocation?: string;
  }>;
}

export interface SmokeFailureDiagnostic {
  category: string;
  name: string;
  message?: string;
  stage: string;
  stackLocation?: string;
  cleanupFailure?: {
    name: string;
    message?: string;
    stage: string;
    stackLocation?: string;
  };
}

export interface SmokeDiagnosticReport {
  failureStage?: string;
  failure?: SmokeFailureDiagnostic;
  serverStartupCompleted: boolean;
  researchSubmissionAttempted: boolean;
  researchJobAccepted: boolean;
  providerCallCountersAvailable: boolean;
  providerUsage:
    { status: "known"; serperCalls: number; openRouterCalls: number } | { status: "unknown" };
  cleanup: Record<string, SmokeCleanupStatus>;
  cleanupFailures: SmokeLifecycleDiagnostics["cleanupFailures"];
}

export interface SmokeLifecycleOutcome<TContext, TResult> {
  context?: TContext;
  result?: TResult;
  diagnostics: SmokeLifecycleDiagnostics;
  failure?: SmokeFailureDiagnostic;
}

export interface SmokeLifecycleHandlers<TContext, TResult> {
  setup: (diagnostics: SmokeLifecycleDiagnostics) => Promise<TContext>;
  execute: (context: TContext, diagnostics: SmokeLifecycleDiagnostics) => Promise<TResult>;
  cleanup: (context: TContext | undefined, diagnostics: SmokeLifecycleDiagnostics) => Promise<void>;
  classifyFailure: (error: unknown) => string;
}

export function createSmokeLifecycleDiagnostics(): SmokeLifecycleDiagnostics {
  return {
    stage: "initializing",
    serverStartupCompleted: false,
    researchSubmissionAttempted: false,
    researchJobAccepted: false,
    providerCallCountersAvailable: false,
    cleanup: {
      activeJob: "not_started",
      worker: "not_started",
      apiServer: "not_started",
      moduleApp: "not_started",
      sessionStore: "not_started",
      jobStore: "not_started",
      llmDeadline: "not_started",
    },
    cleanupFailures: [],
  };
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const allowed = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "AggregateError",
    "AbortError",
    "TransformError",
    "ZodError",
    "FastifyError",
  ]);
  return allowed.has(error.name) ? error.name : "Error";
}

export function safeStackLocation(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const text = `${error.message}\n${error.stack ?? ""}`.replaceAll("\\", "/");
  const pattern = /((?:apps\/(?:api|web)\/)?(?:src|tests)\/[A-Za-z0-9._/-]+):(\d+):(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    const location = match[1];
    if (location) return `${location}:${match[2]}:${match[3]}`;
  }
  return undefined;
}

export function safeSmokeError(
  error: unknown,
): Pick<SmokeFailureDiagnostic, "name" | "message" | "stackLocation"> {
  const safe = safeErrorSummary(error);
  const message = safe.message?.replace(
    /\b[A-Z]:[\\/][^:\r\n]+(?=:\d+(?::\d+)?)/gi,
    "[local-path]",
  );
  return {
    name: safeErrorName(error),
    ...(message ? { message } : {}),
    ...(safeStackLocation(error) ? { stackLocation: safeStackLocation(error) } : {}),
  };
}

function summarizeFailure(error: unknown, stage: string, category: string): SmokeFailureDiagnostic {
  return { category, stage, ...safeSmokeError(error) };
}

export function addSmokeCleanupFailure(
  diagnostics: SmokeLifecycleDiagnostics,
  resource: string,
  error: unknown,
): void {
  diagnostics.cleanupFailures.push({ resource, ...safeSmokeError(error) });
}

export function buildSmokeDiagnosticReport(
  diagnostics: SmokeLifecycleDiagnostics,
  failure?: SmokeFailureDiagnostic,
): SmokeDiagnosticReport {
  return {
    ...(failure ? { failureStage: failure.stage, failure } : {}),
    serverStartupCompleted: diagnostics.serverStartupCompleted,
    researchSubmissionAttempted: diagnostics.researchSubmissionAttempted,
    researchJobAccepted: diagnostics.researchJobAccepted,
    providerCallCountersAvailable: diagnostics.providerCallCountersAvailable,
    providerUsage: diagnostics.providerCallCountersAvailable
      ? {
          status: "known",
          serperCalls: diagnostics.serperCalls ?? 0,
          openRouterCalls: diagnostics.openRouterCalls ?? 0,
        }
      : { status: "unknown" },
    cleanup: { ...diagnostics.cleanup },
    cleanupFailures: [...diagnostics.cleanupFailures],
  };
}

export async function runSmokeLifecycle<TContext, TResult>(
  handlers: SmokeLifecycleHandlers<TContext, TResult>,
): Promise<SmokeLifecycleOutcome<TContext, TResult>> {
  const diagnostics = createSmokeLifecycleDiagnostics();
  let context: TContext | undefined;
  let result: TResult | undefined;
  let failure: SmokeFailureDiagnostic | undefined;

  try {
    const setupContext = await handlers.setup(diagnostics);
    context = setupContext;
    result = await handlers.execute(setupContext, diagnostics);
  } catch (error) {
    failure = summarizeFailure(error, diagnostics.stage, handlers.classifyFailure(error));
  } finally {
    diagnostics.stage = "cleanup";
    try {
      await handlers.cleanup(context, diagnostics);
    } catch (error) {
      const cleanupFailure = summarizeFailure(error, diagnostics.stage, "CLEANUP_FAILURE");
      if (failure) {
        failure.cleanupFailure = {
          name: cleanupFailure.name,
          ...(cleanupFailure.message ? { message: cleanupFailure.message } : {}),
          stage: cleanupFailure.stage,
          ...(cleanupFailure.stackLocation ? { stackLocation: cleanupFailure.stackLocation } : {}),
        };
      } else {
        failure = cleanupFailure;
      }
    }
  }

  if (!failure && diagnostics.cleanupFailures.length > 0) {
    const first = diagnostics.cleanupFailures[0]!;
    failure = {
      category: "CLEANUP_FAILURE",
      name: first.name,
      ...(first.message ? { message: first.message } : {}),
      stage: `cleanup:${first.resource}`,
      ...(first.stackLocation ? { stackLocation: first.stackLocation } : {}),
    };
  } else if (failure && diagnostics.cleanupFailures.length > 0) {
    const first = diagnostics.cleanupFailures[0]!;
    failure.cleanupFailure = {
      name: first.name,
      ...(first.message ? { message: first.message } : {}),
      stage: `cleanup:${first.resource}`,
      ...(first.stackLocation ? { stackLocation: first.stackLocation } : {}),
    };
  }

  return {
    ...(context === undefined ? {} : { context }),
    ...(result === undefined ? {} : { result }),
    diagnostics,
    ...(failure ? { failure } : {}),
  };
}
