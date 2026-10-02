import { createHash, randomUUID } from "node:crypto";
import { withOperationContext } from "./operation-context.js";
import { withWorkerContext } from "./worker-context.js";

export type DurableJobKind = "research" | "post_agent";
export type DurableJobStatus =
  "queued" | "running" | "retrying" | "cancel_requested" | "completed" | "failed" | "cancelled";

export type JobJsonValue =
  null | boolean | number | string | JobJsonValue[] | { [key: string]: JobJsonValue };

export interface DurableJob {
  id: string;
  kind: DurableJobKind;
  ownerId?: string;
  ownerScope: string;
  idempotencyKey?: string;
  payload: Record<string, JobJsonValue>;
  status: DurableJobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  cancelRequestedAt?: string;
  progress: Record<string, JobJsonValue>;
  result?: Record<string, JobJsonValue>;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobQuotaRequest {
  ownerId: string;
  key: string;
  windowSeconds: number;
  limit: number;
}

export interface EnqueueJobInput {
  id: string;
  kind: DurableJobKind;
  ownerId?: string;
  ownerScope: string;
  idempotencyKey?: string;
  payload: Record<string, JobJsonValue>;
  maxAttempts: number;
  quota?: JobQuotaRequest;
}

export interface EnqueueJobResult {
  job?: DurableJob;
  created: boolean;
  quota?: {
    allowed: boolean;
    used: number;
    resetsAt: string;
  };
}

export interface JobLease {
  job: DurableJob;
  workerId: string;
  generation: number;
}

export interface JobHeartbeatResult {
  leaseValid: boolean;
  cancelRequested: boolean;
}

export interface DurableJobStore {
  enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult>;
  claimJob(workerId: string, leaseSeconds: number, jobId?: string): Promise<JobLease | undefined>;
  heartbeatJob(
    lease: JobLease,
    leaseSeconds: number,
    progress: Record<string, JobJsonValue>,
  ): Promise<JobHeartbeatResult>;
  completeJob(
    lease: JobLease,
    result: Record<string, JobJsonValue>,
  ): Promise<"completed" | "cancelled" | undefined>;
  failJob(
    lease: JobLease,
    errorSummary: string,
    retryable: boolean,
    retryDelaySeconds: number,
  ): Promise<DurableJobStatus | undefined>;
  cancelJob(
    id: string,
    ownerId?: string,
    includeSystemJobs?: boolean,
  ): Promise<DurableJob | undefined>;
  getJob(id: string): Promise<DurableJob | undefined>;
  getOwnedJob(id: string, ownerId: string): Promise<DurableJob | undefined>;
  listOwnedJobs(ownerId: string, limit?: number): Promise<DurableJob[]>;
  getJobForSession(sessionId: string, ownerId: string): Promise<DurableJob | undefined>;
  hasRunnableOrRunningJobs(kind: DurableJobKind): Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface JobWorkerContext {
  signal: AbortSignal;
  reportProgress(progress: Record<string, JobJsonValue>): Promise<boolean>;
}

export type DurableJobHandler = (
  job: DurableJob,
  context: JobWorkerContext,
) => Promise<Record<string, JobJsonValue>>;

export class RetryableJobError extends Error {
  readonly retryable = true;
}

export interface DurableQueueWorkerOptions {
  concurrency?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxRetryDelaySeconds?: number;
  workerIdPrefix?: string;
}

export class InMemoryDurableJobStore implements DurableJobStore {
  private readonly jobs = new Map<string, DurableJob>();
  private readonly idempotency = new Map<string, string>();
  private readonly quotas = new Map<string, { windowStart: number; used: number }>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  async enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    this.validateInput(input);
    const idemKey = input.idempotencyKey
      ? `${input.ownerScope}\u0000${input.idempotencyKey}`
      : undefined;
    const existingId = idemKey ? this.idempotency.get(idemKey) : undefined;
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (
        existing.kind !== input.kind ||
        JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
      ) {
        throw new Error("Idempotency key was already used for a different job request");
      }
      return { job: structuredClone(existing), created: false };
    }

    const nowMs = this.clock();
    if (
      input.kind === "research" &&
      typeof input.payload.sessionId === "string" &&
      [...this.jobs.values()].some(
        (job) =>
          job.kind === "research" &&
          job.ownerScope === input.ownerScope &&
          job.payload.sessionId === input.payload.sessionId &&
          ["queued", "retrying", "running", "cancel_requested"].includes(job.status),
      )
    ) {
      throw new Error("Research session already has an active job");
    }
    let quotaResult: EnqueueJobResult["quota"];
    if (input.quota) {
      quotaResult = this.consumeQuota(input.quota, nowMs);
      if (!quotaResult.allowed) return { created: false, quota: quotaResult };
    }
    if (this.jobs.has(input.id)) throw new Error("Job ID already exists");

    const now = new Date(nowMs).toISOString();
    const job: DurableJob = {
      id: input.id,
      kind: input.kind,
      ownerId: input.ownerId,
      ownerScope: input.ownerScope,
      idempotencyKey: input.idempotencyKey,
      payload: structuredClone(input.payload),
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      availableAt: now,
      leaseGeneration: 0,
      progress: {},
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (idemKey) this.idempotency.set(idemKey, job.id);
    return { job: structuredClone(job), created: true, quota: quotaResult };
  }

  async claimJob(
    workerId: string,
    leaseSeconds: number,
    jobId?: string,
  ): Promise<JobLease | undefined> {
    this.validateLease(leaseSeconds);
    const nowMs = this.clock();
    this.recoverExpired(nowMs);
    const job = [...this.jobs.values()]
      .filter(
        (candidate) =>
          (candidate.status === "queued" || candidate.status === "retrying") &&
          (!jobId || candidate.id === jobId) &&
          Date.parse(candidate.availableAt) <= nowMs,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!job) return undefined;

    job.status = "running";
    job.attempts += 1;
    job.leaseGeneration += 1;
    job.leaseOwner = workerId;
    job.leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
    job.startedAt ??= new Date(nowMs).toISOString();
    job.updatedAt = new Date(nowMs).toISOString();
    return { job: structuredClone(job), workerId, generation: job.leaseGeneration };
  }

  async heartbeatJob(
    lease: JobLease,
    leaseSeconds: number,
    progress: Record<string, JobJsonValue>,
  ): Promise<JobHeartbeatResult> {
    this.validateLease(leaseSeconds);
    const job = this.matchLease(lease);
    if (!job || !["running", "cancel_requested"].includes(job.status)) {
      return { leaseValid: false, cancelRequested: false };
    }
    const nowMs = this.clock();
    job.leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
    job.progress = structuredClone(progress);
    job.updatedAt = new Date(nowMs).toISOString();
    return { leaseValid: true, cancelRequested: job.status === "cancel_requested" };
  }

  async completeJob(
    lease: JobLease,
    result: Record<string, JobJsonValue>,
  ): Promise<"completed" | "cancelled" | undefined> {
    const job = this.matchLease(lease);
    if (!job || !["running", "cancel_requested"].includes(job.status)) return undefined;
    const cancelled = job.status === "cancel_requested";
    this.finish(job, cancelled ? "cancelled" : "completed");
    if (!cancelled) job.result = structuredClone(result);
    return cancelled ? "cancelled" : "completed";
  }

  async failJob(
    lease: JobLease,
    errorSummary: string,
    retryable: boolean,
    retryDelaySeconds: number,
  ): Promise<DurableJobStatus | undefined> {
    const job = this.matchLease(lease);
    if (!job || !["running", "cancel_requested"].includes(job.status)) return undefined;
    job.errorSummary = errorSummary.slice(0, 512);
    if (job.status === "cancel_requested") {
      this.finish(job, "cancelled");
    } else if (retryable && job.attempts < job.maxAttempts) {
      job.status = "retrying";
      const retryScheduledAt = this.clock();
      job.availableAt = new Date(
        retryScheduledAt + Math.max(0, retryDelaySeconds) * 1000,
      ).toISOString();
      this.clearLease(job);
      job.updatedAt = new Date(retryScheduledAt).toISOString();
    } else {
      this.finish(job, "failed");
    }
    return job.status;
  }

  async cancelJob(
    id: string,
    ownerId?: string,
    includeSystemJobs = false,
  ): Promise<DurableJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.ownerId ? job.ownerId !== ownerId : !includeSystemJobs) return undefined;
    if (["completed", "failed", "cancelled"].includes(job.status)) return structuredClone(job);
    if (job.status === "queued" || job.status === "retrying") {
      this.finish(job, "cancelled");
    } else {
      job.status = "cancel_requested";
      job.cancelRequestedAt = new Date(this.clock()).toISOString();
      job.updatedAt = job.cancelRequestedAt;
    }
    return structuredClone(job);
  }

  async getJob(id: string) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async getOwnedJob(id: string, ownerId: string) {
    const job = this.jobs.get(id);
    return job?.ownerId === ownerId ? structuredClone(job) : undefined;
  }

  async listOwnedJobs(ownerId: string, limit = 50) {
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === ownerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(100, Math.max(1, Math.floor(limit))))
      .map((job) => structuredClone(job));
  }

  async getJobForSession(sessionId: string, ownerId: string) {
    const job = [...this.jobs.values()]
      .filter(
        (candidate) => candidate.ownerId === ownerId && candidate.payload.sessionId === sessionId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return job ? structuredClone(job) : undefined;
  }

  async hasRunnableOrRunningJobs(kind: DurableJobKind) {
    return [...this.jobs.values()].some(
      (job) =>
        job.kind === kind &&
        ["queued", "retrying", "running", "cancel_requested"].includes(job.status),
    );
  }

  close(): void {}

  private validateInput(input: EnqueueJobInput) {
    if (!input.id || !input.ownerScope || !["research", "post_agent"].includes(input.kind)) {
      throw new Error("Invalid job request");
    }
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5) {
      throw new Error("Job attempts must be between 1 and 5");
    }
    if (input.idempotencyKey && input.idempotencyKey.length > 128) {
      throw new Error("Idempotency key is too long");
    }
    if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > 256 * 1024) {
      throw new Error("Job payload is too large");
    }
    if (input.quota && (!input.ownerId || input.quota.ownerId !== input.ownerId)) {
      throw new Error("Quota owner must match job owner");
    }
  }

  private validateLease(leaseSeconds: number) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error("Job lease must be between 5 and 300 seconds");
    }
  }

  private matchLease(lease: JobLease) {
    const job = this.jobs.get(lease.job.id);
    if (
      !job ||
      job.leaseOwner !== lease.workerId ||
      job.leaseGeneration !== lease.generation ||
      !job.leaseExpiresAt ||
      Date.parse(job.leaseExpiresAt) <= this.clock()
    ) {
      return undefined;
    }
    return job;
  }

  private consumeQuota(request: JobQuotaRequest, nowMs: number) {
    const periodMs = request.windowSeconds * 1000;
    const windowStart = Math.floor(nowMs / periodMs) * periodMs;
    const key = `${request.ownerId}\u0000${request.key}`;
    const current = this.quotas.get(key);
    const used = current && current.windowStart === windowStart ? current.used : 0;
    const allowed = used < request.limit;
    const nextUsed = allowed ? used + 1 : used;
    if (allowed) this.quotas.set(key, { windowStart, used: nextUsed });
    return {
      allowed,
      used: nextUsed,
      resetsAt: new Date(windowStart + periodMs).toISOString(),
    };
  }

  private recoverExpired(nowMs: number) {
    for (const job of this.jobs.values()) {
      if (
        !["running", "cancel_requested"].includes(job.status) ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) > nowMs
      ) {
        continue;
      }
      if (job.status === "cancel_requested") {
        this.finish(job, "cancelled");
      } else if (job.attempts < job.maxAttempts) {
        job.status = "retrying";
        job.errorSummary = "Worker lease expired; the job will be recovered.";
        job.availableAt = new Date(nowMs + Math.min(30, 2 ** job.attempts) * 1000).toISOString();
        this.clearLease(job);
        job.updatedAt = new Date(nowMs).toISOString();
      } else {
        job.errorSummary = "Worker lease expired after the final attempt.";
        this.finish(job, "failed");
      }
    }
  }

  private finish(job: DurableJob, status: "completed" | "failed" | "cancelled") {
    const now = new Date(this.clock()).toISOString();
    job.status = status;
    job.finishedAt = now;
    job.updatedAt = now;
    this.clearLease(job);
  }

  private clearLease(job: DurableJob) {
    job.leaseOwner = undefined;
    job.leaseExpiresAt = undefined;
  }
}

export class DurableQueueWorker {
  private readonly controllers = new Map<string, AbortController>();
  private readonly completion = new Map<string, Promise<void>>();
  private stopping = false;
  private started = false;
  private loopTasks: Promise<void>[] = [];
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxRetryDelaySeconds: number;
  private readonly workerIdPrefix: string;

  constructor(
    private readonly store: DurableJobStore,
    private readonly handlers: Record<DurableJobKind, DurableJobHandler>,
    options: DurableQueueWorkerOptions = {},
  ) {
    this.concurrency = Math.min(8, Math.max(1, Math.floor(options.concurrency ?? 1)));
    this.leaseSeconds = Math.min(300, Math.max(5, Math.floor(options.leaseSeconds ?? 45)));
    this.pollIntervalMs = Math.min(
      10_000,
      Math.max(100, Math.floor(options.pollIntervalMs ?? 1000)),
    );
    this.heartbeatIntervalMs = Math.min(
      this.leaseSeconds * 500,
      Math.max(250, Math.floor(options.heartbeatIntervalMs ?? (this.leaseSeconds * 1000) / 3)),
    );
    this.maxRetryDelaySeconds = Math.min(300, Math.max(1, options.maxRetryDelaySeconds ?? 30));
    this.workerIdPrefix = options.workerIdPrefix ?? `max-worker-${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopTasks = Array.from({ length: this.concurrency }, (_, index) =>
      this.poll(`${this.workerIdPrefix}-${index + 1}`),
    );
  }

  async stop(): Promise<void> {
    if (!this.started && !this.controllers.size) return;
    this.stopping = true;
    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Worker is shutting down"));
    }
    await Promise.all(this.loopTasks);
    await Promise.all(this.completion.values());
    this.loopTasks = [];
    this.started = false;
  }

  async runNow(jobId: string): Promise<boolean> {
    if (this.stopping) return false;
    const lease = await this.store.claimJob(
      `${this.workerIdPrefix}-request-${randomUUID()}`,
      this.leaseSeconds,
      jobId,
    );
    if (!lease) return false;
    await withOperationContext(() => this.execute(lease));
    return true;
  }

  private async poll(workerId: string): Promise<void> {
    while (!this.stopping) {
      let lease: JobLease | undefined;
      try {
        lease = await this.store.claimJob(workerId, this.leaseSeconds);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }
      if (!lease) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }
      try {
        await withOperationContext(() => this.execute(lease!));
      } catch {
        // Persistence may be unavailable during the terminal transition. Keep polling;
        // the database recovers the unfinished lease when it expires.
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  private async execute(lease: JobLease): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(lease.job.id, controller);
    let latestProgress: Record<string, JobJsonValue> = { stage: "started" };
    let cancellationSeen = false;
    let leaseLost = false;
    let heartbeatInFlight = Promise.resolve();
    const heartbeat = async () => {
      heartbeatInFlight = heartbeatInFlight.then(async () => {
        if (controller.signal.aborted) return;
        try {
          const state = await this.store.heartbeatJob(lease, this.leaseSeconds, latestProgress);
          if (!state.leaseValid) {
            leaseLost = true;
            controller.abort(new Error("Job lease was lost"));
          } else if (state.cancelRequested) {
            cancellationSeen = true;
            controller.abort(new Error("Job cancellation requested"));
          }
        } catch {
          // A transient heartbeat failure does not release the job. The next bounded heartbeat
          // retries; an expired lease is recovered by the database if connectivity stays lost.
        }
      });
      await heartbeatInFlight;
    };
    const heartbeatTimer = setInterval(() => void heartbeat(), this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const reportProgress = async (progress: Record<string, JobJsonValue>) => {
      latestProgress = structuredClone(progress);
      await heartbeat();
      return !controller.signal.aborted;
    };

    const run = (async () => {
      try {
        const assertLease = async (allowCancellation = false) => {
          if (controller.signal.aborted && !(allowCancellation && cancellationSeen))
            throw controller.signal.reason;
          const current = await this.store.getJob(lease.job.id);
          if (
            !current ||
            !["running", "cancel_requested"].includes(current.status) ||
            current.leaseOwner !== lease.workerId ||
            current.leaseGeneration !== lease.generation ||
            !current.leaseExpiresAt ||
            Date.parse(current.leaseExpiresAt) <= Date.now()
          ) {
            leaseLost = true;
            controller.abort(new Error("Job lease was lost"));
            throw controller.signal.reason;
          }
          if (current.status === "cancel_requested") {
            cancellationSeen = true;
            controller.abort(new Error("Job cancellation requested"));
            if (!allowCancellation) throw controller.signal.reason;
          }
        };
        const result = await withWorkerContext(lease, controller.signal, assertLease, () =>
          this.handlers[lease.job.kind](lease.job, {
            signal: controller.signal,
            reportProgress,
          }),
        );
        latestProgress = {
          ...latestProgress,
          stage: "terminal_transition",
          terminalOutcome: "completed",
          terminalStartedAt: new Date().toISOString(),
        };
        await heartbeat();
        if (this.stopping && !cancellationSeen) {
          await this.store.failJob(lease, "Worker shut down while the job was running.", true, 1);
          return;
        }
        const state = await this.store.completeJob(lease, result);
        if (state === undefined && !leaseLost) {
          leaseLost = true;
          controller.abort(new Error("Job lease was lost before completion"));
        }
      } catch (error) {
        if (leaseLost) return;
        const cancelled = cancellationSeen || lease.job.status === "cancel_requested";
        const message = error instanceof Error ? error.message : "Job execution failed";
        const safeSummary = sanitizeJobErrorSummary(message);
        latestProgress = {
          ...latestProgress,
          stage: "terminal_transition",
          terminalOutcome: cancelled ? "cancelled" : "failed",
          terminalStartedAt: new Date().toISOString(),
          failureSummary: safeSummary,
        };
        await heartbeat();
        const retryable =
          !cancelled && !this.stopping && (error as { retryable?: boolean })?.retryable === true;
        const delay = Math.min(
          this.maxRetryDelaySeconds,
          Math.max(1, 2 ** Math.max(0, lease.job.attempts - 1)),
        );
        await this.store.failJob(lease, safeSummary, retryable || this.stopping, delay);
      } finally {
        clearInterval(heartbeatTimer);
        this.controllers.delete(lease.job.id);
      }
    })();
    this.completion.set(lease.job.id, run);
    try {
      await run;
    } finally {
      this.completion.delete(lease.job.id);
    }
  }
}

export function createJobId(): string {
  return randomUUID();
}

export function createIdempotentJobId(ownerScope: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update(`${ownerScope}\u0000${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeJobErrorSummary(message: string): string {
  return (
    message
      .replace(/\s+/g, " ")
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
      .replace(/((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
      .slice(0, 512) || "Job execution failed"
  );
}
