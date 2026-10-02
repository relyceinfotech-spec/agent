import { DatabaseSync } from "node:sqlite";
import type {
  DurableJob,
  DurableJobKind,
  DurableJobStatus,
  DurableJobStore,
  EnqueueJobInput,
  EnqueueJobResult,
  JobHeartbeatResult,
  JobLease,
  JobJsonValue,
} from "./jobs.js";

type SqliteJobRow = {
  id: string;
  kind: DurableJobKind;
  owner_id: string | null;
  owner_scope: string;
  idempotency_key: string | null;
  payload_json: string;
  status: DurableJobStatus;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  cancel_requested_at: number | null;
  progress_json: string;
  result_json: string | null;
  error_summary: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export class SqliteDurableJobStore implements DurableJobStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    path: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS max_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('research', 'post_agent')),
        owner_id TEXT,
        owner_scope TEXT NOT NULL,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'cancel_requested', 'completed', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        cancel_requested_at INTEGER,
        progress_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        CHECK (length(payload_json) <= 262144),
        CHECK (length(progress_json) <= 65536),
        CHECK (result_json IS NULL OR length(result_json) <= 262144)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS max_jobs_idempotency_idx
        ON max_jobs(owner_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS max_jobs_claim_idx
        ON max_jobs(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS max_jobs_owner_created_idx
        ON max_jobs(owner_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS user_quota_windows (
        user_id TEXT NOT NULL,
        quota_key TEXT NOT NULL CHECK (quota_key IN ('research', 'deep_research', 'followup')),
        window_start INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL DEFAULT 86400,
        used INTEGER NOT NULL CHECK (used > 0),
        PRIMARY KEY (user_id, quota_key)
      );
    `);
  }

  async enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    this.validateInput(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existingRow = this.database
          .prepare("SELECT * FROM max_jobs WHERE owner_scope = ? AND idempotency_key = ?")
          .get(input.ownerScope, input.idempotencyKey) as SqliteJobRow | undefined;
        if (existingRow) {
          const existing = fromRow(existingRow);
          if (
            existing.kind !== input.kind ||
            JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
          ) {
            throw new Error("Idempotency key was already used for a different job request");
          }
          this.database.exec("COMMIT");
          return { job: existing, created: false };
        }
      }

      const now = this.clock();
      let quota: EnqueueJobResult["quota"];
      if (input.quota) {
        quota = this.consumeQuota(
          input.quota.ownerId,
          input.quota.key,
          input.quota.windowSeconds,
          input.quota.limit,
          now,
        );
        if (!quota.allowed) {
          this.database.exec("COMMIT");
          return { created: false, quota };
        }
      }
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
        availableAt: new Date(now).toISOString(),
        leaseGeneration: 0,
        progress: {},
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      this.insertJob(job);
      this.database.exec("COMMIT");
      return { job, created: true, quota };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async claimJob(workerId: string, leaseSeconds: number): Promise<JobLease | undefined> {
    validateLease(leaseSeconds);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock();
      const expired = this.database
        .prepare(
          `SELECT * FROM max_jobs
             WHERE status IN ('running', 'cancel_requested')
               AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .all(now) as SqliteJobRow[];
      for (const row of expired) this.recoverExpired(fromRow(row), now);

      const candidate = this.database
        .prepare(
          `SELECT * FROM max_jobs
             WHERE status IN ('queued', 'retrying') AND available_at <= ?
             ORDER BY created_at, id LIMIT 1`,
        )
        .get(now) as SqliteJobRow | undefined;
      if (!candidate) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const job = fromRow(candidate);
      job.status = "running";
      job.attempts += 1;
      job.leaseGeneration += 1;
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(now + leaseSeconds * 1000).toISOString();
      job.startedAt ??= new Date(now).toISOString();
      job.updatedAt = new Date(now).toISOString();
      this.updateJob(job);
      this.database.exec("COMMIT");
      return { job, workerId, generation: job.leaseGeneration };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async heartbeatJob(
    lease: JobLease,
    leaseSeconds: number,
    progress: Record<string, JobJsonValue>,
  ): Promise<JobHeartbeatResult> {
    validateLease(leaseSeconds);
    const now = this.clock();
    const updated = this.database
      .prepare(
        `UPDATE max_jobs
            SET lease_expires_at = ?, progress_json = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND lease_generation = ?
            AND lease_expires_at > ? AND status IN ('running', 'cancel_requested')
          RETURNING status`,
      )
      .get(
        now + leaseSeconds * 1000,
        JSON.stringify(progress),
        now,
        lease.job.id,
        lease.workerId,
        lease.generation,
        now,
      ) as { status: DurableJobStatus } | undefined;
    return {
      leaseValid: Boolean(updated),
      cancelRequested: updated?.status === "cancel_requested",
    };
  }

  async completeJob(
    lease: JobLease,
    result: Record<string, JobJsonValue>,
  ): Promise<"completed" | "cancelled" | undefined> {
    const now = this.clock();
    const updated = this.database
      .prepare(
        `UPDATE max_jobs
            SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' ELSE 'completed' END,
                result_json = CASE WHEN status = 'cancel_requested' THEN result_json ELSE ? END,
                finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ? AND lease_owner = ? AND lease_generation = ?
            AND lease_expires_at > ? AND status IN ('running', 'cancel_requested')
          RETURNING status`,
      )
      .get(
        JSON.stringify(result),
        now,
        now,
        lease.job.id,
        lease.workerId,
        lease.generation,
        now,
      ) as { status: "completed" | "cancelled" } | undefined;
    return updated?.status;
  }

  async failJob(
    lease: JobLease,
    errorSummary: string,
    retryable: boolean,
    retryDelaySeconds: number,
  ): Promise<DurableJobStatus | undefined> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getMatchingLease(lease);
      if (!job || !["running", "cancel_requested"].includes(job.status)) {
        this.database.exec("COMMIT");
        return undefined;
      }
      job.errorSummary = errorSummary.slice(0, 512);
      if (job.status === "cancel_requested") {
        this.finish(job, "cancelled");
      } else if (retryable && job.attempts < job.maxAttempts) {
        job.status = "retrying";
        const retryScheduledAt = this.clock();
        job.availableAt = new Date(
          retryScheduledAt + Math.max(0, retryDelaySeconds) * 1000,
        ).toISOString();
        clearLease(job);
        job.updatedAt = new Date(retryScheduledAt).toISOString();
        this.updateJob(job);
      } else {
        this.finish(job, "failed");
      }
      this.database.exec("COMMIT");
      return job.status;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async cancelJob(
    id: string,
    ownerId?: string,
    includeSystemJobs = false,
  ): Promise<DurableJob | undefined> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureOpen();
      const row = this.database.prepare("SELECT * FROM max_jobs WHERE id = ?").get(id) as
        SqliteJobRow | undefined;
      const job = row ? fromRow(row) : undefined;
      if (!job || (job.ownerId ? job.ownerId !== ownerId : !includeSystemJobs)) {
        this.database.exec("COMMIT");
        return undefined;
      }
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        if (job.status === "queued" || job.status === "retrying") {
          this.finish(job, "cancelled");
        } else {
          job.status = "cancel_requested";
          job.cancelRequestedAt = new Date(this.clock()).toISOString();
          job.updatedAt = job.cancelRequestedAt;
          this.updateJob(job);
        }
      }
      this.database.exec("COMMIT");
      return job;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getJob(id: string) {
    this.ensureOpen();
    const row = this.database.prepare("SELECT * FROM max_jobs WHERE id = ?").get(id) as
      SqliteJobRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async getOwnedJob(id: string, ownerId: string) {
    this.ensureOpen();
    const row = this.database
      .prepare("SELECT * FROM max_jobs WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as SqliteJobRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async listOwnedJobs(ownerId: string, limit = 50) {
    this.ensureOpen();
    const rows = this.database
      .prepare("SELECT * FROM max_jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(ownerId, Math.min(100, Math.max(1, Math.floor(limit)))) as SqliteJobRow[];
    return rows.map(fromRow);
  }

  async getJobForSession(sessionId: string, ownerId: string) {
    this.ensureOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM max_jobs
          WHERE owner_id = ? AND kind = 'research'
            AND json_extract(payload_json, '$.sessionId') = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(ownerId, sessionId) as SqliteJobRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async hasRunnableOrRunningJobs(kind: DurableJobKind) {
    this.ensureOpen();
    const row = this.database
      .prepare(
        `SELECT 1 as present FROM max_jobs
          WHERE kind = ? AND status IN ('queued', 'retrying', 'running', 'cancel_requested')
          LIMIT 1`,
      )
      .get(kind) as { present: number } | undefined;
    return Boolean(row);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private validateInput(input: EnqueueJobInput) {
    this.ensureOpen();
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
    if (input.quota && (!input.ownerId || input.ownerId !== input.quota.ownerId)) {
      throw new Error("Quota owner must match job owner");
    }
  }

  private consumeQuota(
    ownerId: string,
    quotaKey: string,
    windowSeconds: number,
    limit: number,
    now: number,
  ) {
    if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 604800) {
      throw new Error("Invalid quota window");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      throw new Error("Invalid quota limit");
    }
    const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
    const current = this.database
      .prepare(
        "SELECT window_start, window_seconds, used FROM user_quota_windows WHERE user_id = ? AND quota_key = ?",
      )
      .get(ownerId, quotaKey) as
      { window_start: number; window_seconds: number; used: number } | undefined;
    const used =
      current && current.window_start === windowStart && current.window_seconds === windowSeconds
        ? current.used
        : 0;
    const allowed = used < limit;
    const nextUsed = allowed ? used + 1 : used;
    if (allowed) {
      this.database
        .prepare(
          `INSERT INTO user_quota_windows (user_id, quota_key, window_start, window_seconds, used)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, quota_key) DO UPDATE SET
             window_start = excluded.window_start,
             window_seconds = excluded.window_seconds,
             used = excluded.used`,
        )
        .run(ownerId, quotaKey, windowStart, windowSeconds, nextUsed);
    }
    return {
      allowed,
      used: nextUsed,
      resetsAt: new Date((windowStart + windowSeconds) * 1000).toISOString(),
    };
  }

  private getMatchingLease(lease: JobLease) {
    const job = this.database.prepare("SELECT * FROM max_jobs WHERE id = ?").get(lease.job.id) as
      SqliteJobRow | undefined;
    if (!job) return undefined;
    const value = fromRow(job);
    if (
      value.leaseOwner !== lease.workerId ||
      value.leaseGeneration !== lease.generation ||
      !value.leaseExpiresAt ||
      Date.parse(value.leaseExpiresAt) <= this.clock()
    ) {
      return undefined;
    }
    return value;
  }

  private recoverExpired(job: DurableJob, now: number) {
    if (job.status === "cancel_requested") {
      this.finish(job, "cancelled");
    } else if (job.attempts < job.maxAttempts) {
      job.status = "retrying";
      job.errorSummary = "Worker lease expired; the job will be recovered.";
      job.availableAt = new Date(now + Math.min(30, 2 ** job.attempts) * 1000).toISOString();
      clearLease(job);
      job.updatedAt = new Date(now).toISOString();
      this.updateJob(job);
    } else {
      job.errorSummary = "Worker lease expired after the final attempt.";
      this.finish(job, "failed");
    }
  }

  private insertJob(job: DurableJob) {
    this.database
      .prepare(
        `INSERT INTO max_jobs (
           id, kind, owner_id, owner_scope, idempotency_key, payload_json, status,
           attempts, max_attempts, available_at, lease_owner, lease_generation,
           lease_expires_at, cancel_requested_at, progress_json, result_json,
           error_summary, created_at, updated_at, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...toValues(job));
  }

  private updateJob(job: DurableJob) {
    this.database
      .prepare(
        `UPDATE max_jobs SET
           kind=?, owner_id=?, owner_scope=?, idempotency_key=?, payload_json=?, status=?,
           attempts=?, max_attempts=?, available_at=?, lease_owner=?, lease_generation=?,
           lease_expires_at=?, cancel_requested_at=?, progress_json=?, result_json=?,
           error_summary=?, created_at=?, updated_at=?, started_at=?, finished_at=?
         WHERE id=?`,
      )
      .run(...toValues(job).slice(1), job.id);
  }

  private finish(job: DurableJob, status: "completed" | "failed" | "cancelled") {
    const now = new Date(this.clock()).toISOString();
    job.status = status;
    job.finishedAt = now;
    job.updatedAt = now;
    clearLease(job);
    this.updateJob(job);
  }

  private ensureOpen() {
    if (this.closed) throw new Error("Job store is closed");
  }
}

function validateLease(leaseSeconds: number) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new Error("Job lease must be between 5 and 300 seconds");
  }
}

function clearLease(job: DurableJob) {
  job.leaseOwner = undefined;
  job.leaseExpiresAt = undefined;
}

function toValues(job: DurableJob): Array<string | number | null> {
  const epoch = (value?: string) => (value ? Date.parse(value) : null);
  return [
    job.id,
    job.kind,
    job.ownerId ?? null,
    job.ownerScope,
    job.idempotencyKey ?? null,
    JSON.stringify(job.payload),
    job.status,
    job.attempts,
    job.maxAttempts,
    epoch(job.availableAt)!,
    job.leaseOwner ?? null,
    job.leaseGeneration,
    epoch(job.leaseExpiresAt),
    epoch(job.cancelRequestedAt),
    JSON.stringify(job.progress),
    job.result ? JSON.stringify(job.result) : null,
    job.errorSummary ?? null,
    epoch(job.createdAt)!,
    epoch(job.updatedAt)!,
    epoch(job.startedAt),
    epoch(job.finishedAt),
  ];
}

function fromRow(row: SqliteJobRow): DurableJob {
  const iso = (value: number | null) => (value == null ? undefined : new Date(value).toISOString());
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id ?? undefined,
    ownerScope: row.owner_scope,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, JobJsonValue>,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: new Date(row.available_at).toISOString(),
    leaseOwner: row.lease_owner ?? undefined,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: iso(row.lease_expires_at),
    cancelRequestedAt: iso(row.cancel_requested_at),
    progress: JSON.parse(row.progress_json) as Record<string, JobJsonValue>,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, JobJsonValue>)
      : undefined,
    errorSummary: row.error_summary ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}
