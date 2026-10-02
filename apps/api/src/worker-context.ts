import { AsyncLocalStorage } from "node:async_hooks";
import type { JobLease } from "./jobs.js";

const workers = new AsyncLocalStorage<{
  lease: JobLease;
  signal: AbortSignal;
  assertLease: (allowCancellation?: boolean) => Promise<void>;
}>();
export function withWorkerContext<T>(
  lease: JobLease,
  signal: AbortSignal,
  assertLease: (allowCancellation?: boolean) => Promise<void>,
  operation: () => T,
): T {
  return workers.run({ lease, signal, assertLease }, operation);
}
export function currentWorkerContext() {
  return workers.getStore();
}

export function throwIfWorkerStopped(allowCancellation = false): void {
  const worker = workers.getStore();
  if (
    allowCancellation &&
    worker?.signal.reason instanceof Error &&
    worker.signal.reason.message === "Job cancellation requested"
  )
    return;
  if (worker?.signal.aborted) throw worker.signal.reason ?? new Error("Worker stopped");
}
