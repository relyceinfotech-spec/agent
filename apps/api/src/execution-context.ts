import { AsyncLocalStorage } from "node:async_hooks";
import type { ResearchSession } from "./domain.js";

export interface ResearchExecutionContext {
  deadlineAt: number;
  signal: AbortSignal;
  stageTimings?: Record<string, number>;
  activeStages?: Map<string, { startedAt: number; activeCount: number }>;
  capturePartialState?: () => Partial<ResearchSession>;
  lastFailedStage?: string;
}

const contextStorage = new AsyncLocalStorage<ResearchExecutionContext>();

export function runWithResearchExecutionContext<T>(
  context: ResearchExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(context, operation);
}

export function getResearchExecutionContext(): ResearchExecutionContext | undefined {
  return contextStorage.getStore();
}

export function remainingResearchTimeMs(operationLimitMs?: number): number | undefined {
  const context = getResearchExecutionContext();
  if (!context) return operationLimitMs;
  throwIfResearchInactive();
  const remaining = context.deadlineAt - Date.now();
  return operationLimitMs === undefined ? remaining : Math.min(operationLimitMs, remaining);
}

export function throwIfResearchInactive(): void {
  const context = getResearchExecutionContext();
  if (!context) return;
  if (context.signal.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof Error && reason.name !== "AbortError"
      ? reason
      : new Error("Research execution was cancelled");
  }
  if (Date.now() >= context.deadlineAt) {
    throw new Error("Research session deadline exhausted");
  }
}

export function activeResearchStage(): string | undefined {
  const context = getResearchExecutionContext();
  if (context?.lastFailedStage) return context.lastFailedStage;
  const stages = context?.activeStages;
  if (!stages?.size) return undefined;
  return [...stages.entries()].sort(
    (left, right) => right[1].startedAt - left[1].startedAt,
  )[0]?.[0];
}

export function researchStageTimingsSnapshot(): Record<string, number> | undefined {
  const context = getResearchExecutionContext();
  if (!context) return undefined;
  const timings = { ...(context.stageTimings ?? {}) };
  for (const [stage, active] of context.activeStages ?? []) {
    timings[stage] = (timings[stage] ?? 0) + Math.max(0, Date.now() - active.startedAt);
  }
  return timings;
}

export async function runResearchStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const context = getResearchExecutionContext();
  throwIfResearchInactive();
  if (!context) return operation();

  const activeStages = (context.activeStages ??= new Map());
  context.lastFailedStage = undefined;
  const existing = activeStages.get(stage);
  if (existing) existing.activeCount += 1;
  else activeStages.set(stage, { startedAt: Date.now(), activeCount: 1 });
  const startedAt = Date.now();
  try {
    const result = await raceWithResearchAbort(Promise.resolve().then(operation), context.signal);
    throwIfResearchInactive();
    return result;
  } catch (error) {
    context.lastFailedStage ??= stage;
    throw error;
  } finally {
    const elapsed = Math.max(0, Date.now() - startedAt);
    context.stageTimings ??= {};
    context.stageTimings[stage] = (context.stageTimings[stage] ?? 0) + elapsed;
    const active = activeStages.get(stage);
    if (active && --active.activeCount <= 0) activeStages.delete(stage);
  }
}

export function raceWithResearchAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(
      signal.reason instanceof Error && signal.reason.name !== "AbortError"
        ? signal.reason
        : new Error("Research execution was cancelled"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error && signal.reason.name !== "AbortError"
          ? signal.reason
          : new Error("Research execution was cancelled"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
