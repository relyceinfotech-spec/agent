import type { ResearchSession } from "./domain.js";
import { DatabaseSync } from "node:sqlite";
import { SqliteDurableJobStore } from "./job-store.js";
import { currentWorkerContext, throwIfWorkerStopped } from "./worker-context.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalizeUrl } from "./security.js";
import type {
  NewUserMemoryRecord,
  UserMemoryRecord,
  UserMemorySearchResult,
  UserMemoryUpdate,
} from "./memory-domain.js";
import type {
  AutonomousRun,
  ResearchFollowUp,
  ResearchPost,
  TopicCandidate,
} from "./content-domain.js";
import { currentAuthenticatedUser, currentResearchOwnerId } from "./auth-context.js";
import type { ExportFormat, ExportResourceType, ExportStatus } from "./exports.js";
import { MAX_EXPORT_ATTEMPTS } from "./exports.js";

export interface StoredDocument {
  url: string;
  title: string;
  content: string;
  rawHtml: string;
  fetchedAt: string;
  lastVerifiedAt: string;
  publishedAt?: string;
  metadata?: {
    description?: string;
    author?: string;
    canonicalUrl?: string;
    domain?: string;
    language?: string;
    headings?: string[];
    contentType?: "html" | "rss" | "pdf" | "structured";
    retrievalMethod?: string;
    provider?: string;
    providers?: string[];
    engine?: string;
    query?: string;
    discoveredAt?: string;
  };
  contentHash: string;
  version: number;
}

export interface KnowledgeStore {
  getDocument(url: string): Promise<StoredDocument | undefined>;
  saveDocument(
    document: Omit<StoredDocument, "contentHash" | "version" | "lastVerifiedAt">,
  ): Promise<void>;
  searchDocuments(query: string, maxAgeMs: number, limit?: number): Promise<StoredDocument[]>;
}

export interface ContentStore {
  getTopicByUrl(url: string): Promise<TopicCandidate | undefined>;
  getTopic(id: string): Promise<TopicCandidate | undefined>;
  saveTopic(topic: TopicCandidate): Promise<void>;
  listTopics(limit?: number): Promise<TopicCandidate[]>;
  saveRun(run: AutonomousRun): Promise<void>;
  getRun(id: string): Promise<AutonomousRun | undefined>;
  listRuns(limit?: number): Promise<AutonomousRun[]>;
  savePost(post: ResearchPost): Promise<void>;
  publishPost(post: ResearchPost, topic: TopicCandidate, run: AutonomousRun): Promise<void>;
  getPost(id: string): Promise<ResearchPost | undefined>;
  getPublishedPost(id: string): Promise<ResearchPost | undefined>;
  listPosts(limit?: number): Promise<ResearchPost[]>;
  listPublishedPosts(limit?: number): Promise<ResearchPost[]>;
  saveFollowUp(followUp: ResearchFollowUp): Promise<void>;
  getFollowUp(id: string): Promise<ResearchFollowUp | undefined>;
}

export interface SessionStore {
  listDeletedIds?(ids: string[]): Promise<Set<string>>;
  create(session: ResearchSession): Promise<void>;
  get(id: string): Promise<ResearchSession | undefined>;
  update(session: ResearchSession): Promise<void>;
  list(limit?: number, cursor?: SessionCursor): Promise<ResearchSession[]>;
  listExistingIds(ids: string[]): Promise<Set<string>>;
  delete(id: string): Promise<void>;
}

export interface SessionCursor {
  createdAt: string;
  id: string;
}

export const DEFAULT_RESEARCH_SESSION_PAGE_SIZE = 50;
export const MAX_RESEARCH_SESSION_PAGE_SIZE = 100;

export function normalizeResearchSessionQueryLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RESEARCH_SESSION_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_RESEARCH_SESSION_PAGE_SIZE + 1, Math.trunc(limit)));
}

function isBeforeSessionCursor(session: ResearchSession, cursor?: SessionCursor): boolean {
  if (!cursor) return true;
  return (
    session.createdAt < cursor.createdAt ||
    (session.createdAt === cursor.createdAt && session.id < cursor.id)
  );
}

export type ShareResourceType = "research_session" | "published_post";

export interface ShareMetadata {
  id: string;
  ownerId: string;
  resourceType: ShareResourceType;
  resourceId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastAccessedAt?: string;
}

export interface NewShareRecord extends ShareMetadata {
  tokenHash: string;
}

export interface ResolvedShareRecord extends ShareMetadata {
  tokenHash: string;
}

export interface ShareStore {
  createShare(share: NewShareRecord): Promise<ShareMetadata>;
  listShares(ownerId: string, limit?: number): Promise<ShareMetadata[]>;
  revokeShare(id: string, ownerId: string, revokedAt: string): Promise<boolean>;
  resolveShare(tokenHash: string, accessedAt: string): Promise<ResolvedShareRecord | undefined>;
  classifyShareFailure(
    tokenHash: string,
    checkedAt: string,
  ): Promise<"unknown" | "expired" | "revoked" | "active">;
}

export interface ExportRecord {
  id: string;
  ownerId: string;
  resourceType: ExportResourceType;
  resourceId: string;
  format: ExportFormat;
  status: ExportStatus;
  snapshotHash: string;
  fileName: string;
  contentType: string;
  attempts: number;
  payloadBase64?: string;
  outputBytes?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failureReason?: string;
}

export type NewExportRecord = Pick<
  ExportRecord,
  | "id"
  | "ownerId"
  | "resourceType"
  | "resourceId"
  | "format"
  | "snapshotHash"
  | "fileName"
  | "contentType"
  | "attempts"
  | "createdAt"
  | "updatedAt"
>;

export interface ExportCompletion {
  payloadBase64: string;
  outputBytes: number;
  completedAt: string;
  updatedAt: string;
}

export interface ExportStore {
  createExport(record: NewExportRecord): Promise<{ record: ExportRecord; created: boolean }>;
  retryFailedExport(id: string, ownerId: string, updatedAt: string): Promise<boolean>;
  reclaimStaleExport(
    id: string,
    ownerId: string,
    staleBefore: string,
    updatedAt: string,
  ): Promise<boolean>;
  completeExport(id: string, ownerId: string, completion: ExportCompletion): Promise<boolean>;
  failExport(
    id: string,
    ownerId: string,
    updatedAt: string,
    failureReason: string,
  ): Promise<boolean>;
  getExport(id: string, ownerId: string): Promise<ExportRecord | undefined>;
  listExports(ownerId: string, limit?: number): Promise<ExportRecord[]>;
  deleteExport(id: string, ownerId: string): Promise<boolean>;
}

export type UserQuotaKey = "research" | "deep_research" | "followup";

export interface QuotaConsumption {
  allowed: boolean;
  used: number;
  resetsAt: string;
}

export interface UserQuotaStore {
  consumeUserQuota(
    userId: string,
    quotaKey: UserQuotaKey,
    windowSeconds: number,
    limit: number,
  ): Promise<QuotaConsumption>;
  getUserQuotaUsage?(
    userId: string,
    quotaKey: UserQuotaKey,
    windowSeconds: number,
  ): Promise<{ used: number; resetsAt: string }>;
}

export interface UserMemoryStore {
  createUserMemory(
    memory: NewUserMemoryRecord,
  ): Promise<{ memory: UserMemoryRecord; inserted: boolean }>;
  countRetainedUserMemories(): Promise<number>;
  findUserMemoryByHash(contentHash: string): Promise<UserMemoryRecord | undefined>;
  getUserMemory(
    id: string,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord | undefined>;
  listUserMemories(
    limit?: number,
    includeInactive?: boolean,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord[]>;
  updateUserMemory(
    id: string,
    update: UserMemoryUpdate,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord | undefined>;
  deleteUserMemory(id: string): Promise<boolean>;
  searchUserMemories(
    embedding: number[],
    embeddingModel: string,
    minSimilarity: number,
    candidateLimit: number,
    limit: number,
  ): Promise<UserMemorySearchResult[]>;
}

export interface MaxStore
  extends
    SessionStore,
    KnowledgeStore,
    ContentStore,
    UserQuotaStore,
    UserMemoryStore,
    ShareStore,
    ExportStore {
  recoverInterrupted(): number | Promise<number>;
  recoverAutonomousRuns(): number | Promise<number>;
  close(): void | Promise<void>;
  consumeRateLimit?(
    scope: string,
    clientKey: string,
    windowMs: number,
    limit: number,
  ): Promise<{
    allowed: boolean;
    limit: number;
    remaining: number;
    resetMs: number;
  }>;
}

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, { session: ResearchSession; ownerId?: string }>();
  private readonly deleted = new Map<string, string | undefined>();
  async create(session: ResearchSession) {
    await currentWorkerContext()?.assertLease(session.status === "CANCELLED");
    throwIfWorkerStopped(session.status === "CANCELLED");
    if (this.deleted.has(session.id)) throw new Error("Research session was deleted");
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    this.data.set(session.id, {
      session: structuredClone(session),
      ownerId,
    });
  }
  async get(id: string) {
    const value = this.data.get(id);
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    if (ownerId && value?.ownerId !== ownerId) return undefined;
    return value ? structuredClone(value.session) : undefined;
  }
  async update(session: ResearchSession) {
    await currentWorkerContext()?.assertLease(session.status === "CANCELLED");
    throwIfWorkerStopped(session.status === "CANCELLED");
    if (this.deleted.has(session.id)) throw new Error("Research session was deleted");
    const current = this.data.get(session.id);
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    if (ownerId && current?.ownerId !== ownerId) return;
    this.data.set(session.id, {
      session: structuredClone(session),
      ownerId: current?.ownerId ?? ownerId,
    });
  }
  async list(
    limit = DEFAULT_RESEARCH_SESSION_PAGE_SIZE,
    cursor?: SessionCursor,
  ): Promise<ResearchSession[]> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    return [...this.data.values()]
      .filter((row) => !ownerId || row.ownerId === ownerId)
      .filter((row) => isBeforeSessionCursor(row.session, cursor))
      .sort((a, b) => {
        if (a.session.createdAt !== b.session.createdAt) {
          return a.session.createdAt > b.session.createdAt ? -1 : 1;
        }
        if (a.session.id === b.session.id) return 0;
        return a.session.id > b.session.id ? -1 : 1;
      })
      .slice(0, normalizeResearchSessionQueryLimit(limit))
      .map((row) => structuredClone(row.session));
  }
  async listExistingIds(ids: string[]): Promise<Set<string>> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const requested = new Set(ids.slice(0, 100));
    return new Set(
      [...this.data.entries()]
        .filter(([id, row]) => requested.has(id) && (!ownerId || row.ownerId === ownerId))
        .map(([id]) => id),
    );
  }
  async delete(id: string) {
    const row = this.data.get(id);
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    if ((row && (!ownerId || row.ownerId === ownerId)) || (!row && ownerId)) {
      this.deleted.set(id, row?.ownerId ?? ownerId);
      this.data.delete(id);
    }
  }
  async listDeletedIds(ids: string[]): Promise<Set<string>> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    return new Set(
      ids.filter((id) => this.deleted.has(id) && (!ownerId || this.deleted.get(id) === ownerId)),
    );
  }
}

/** Durable embedded session store; callers retain the same SessionStore contract. */
export class SqliteSessionStore implements MaxStore {
  private readonly database: DatabaseSync;
  createJobStore(): SqliteDurableJobStore {
    return new SqliteDurableJobStore(this.database);
  }

  private assertWorkerLease(allowCancellation = false): void {
    const worker = currentWorkerContext();
    if (!worker) return;
    throwIfWorkerStopped(allowCancellation);
    const lease = worker.lease;
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId() ?? null;
    if ((lease.job.ownerId ?? null) !== ownerId) throw new Error("Research owner mismatch");
    // Tests can use an in-memory queue alongside an embedded session database.
    if (
      !this.database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='max_jobs'")
        .get()
    )
      return;
    const row = this.database
      .prepare(
        `SELECT id FROM max_jobs WHERE id = ?
      AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ? AND (status = 'running' OR (status = 'cancel_requested' AND ?))`,
      )
      .get(lease.job.id, lease.workerId, lease.generation, Date.now(), allowCancellation ? 1 : 0);
    if (!row) throw new Error("Job lease was lost");
  }

  private async workerWrite(operation: () => void, allowCancellation = false): Promise<void> {
    if (!currentWorkerContext()) {
      operation();
      return;
    }
    await currentWorkerContext()!.assertLease(allowCancellation);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertWorkerLease(allowCancellation);
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deleted_research_sessions (id TEXT PRIMARY KEY, owner_id TEXT);
      CREATE TABLE IF NOT EXISTS request_rate_limits (key TEXT PRIMARY KEY, window_end INTEGER NOT NULL, used INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS request_rate_limits_expiry ON request_rate_limits(window_end);

      CREATE TABLE IF NOT EXISTS research_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_sessions_created
        ON research_sessions(created_at DESC);
      CREATE TABLE IF NOT EXISTS documents (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_html TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        published_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(url UNINDEXED, title, content);
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        score REAL NOT NULL,
        discovered_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomous_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomous_runs_created
        ON autonomous_runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL UNIQUE,
        research_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY(topic_id) REFERENCES topics(id)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
      CREATE TABLE IF NOT EXISTS post_sources (
        post_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY(post_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS post_claims (
        post_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        PRIMARY KEY(post_id, claim_id)
      );
      CREATE TABLE IF NOT EXISTS post_followups (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        post_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_quota_windows (
        user_id TEXT NOT NULL,
        quota_key TEXT NOT NULL CHECK (quota_key IN ('research', 'deep_research', 'followup')),
        window_start INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL DEFAULT 86400,
        used INTEGER NOT NULL CHECK (used > 0),
        PRIMARY KEY (user_id, quota_key)
      );
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        provenance_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        embedding_json TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_user_memories_owner_active_updated
        ON user_memories(owner_id, is_active, updated_at DESC);
      CREATE TRIGGER IF NOT EXISTS user_memories_retained_limit_insert
      BEFORE INSERT ON user_memories
      WHEN NOT EXISTS (
        SELECT 1 FROM user_memories
        WHERE owner_id = NEW.owner_id AND content_hash = NEW.content_hash
      ) AND (
        SELECT count(*) FROM user_memories WHERE owner_id = NEW.owner_id
      ) >= 500
      BEGIN
        SELECT RAISE(ABORT, 'retained user memory limit reached');
      END;
      CREATE TRIGGER IF NOT EXISTS user_memories_retained_limit_owner_change
      BEFORE UPDATE OF owner_id ON user_memories
      WHEN NEW.owner_id IS NOT OLD.owner_id AND (
        SELECT count(*)
        FROM user_memories
        WHERE owner_id = NEW.owner_id AND id IS NOT OLD.id
      ) >= 500
      BEGIN
        SELECT RAISE(ABORT, 'retained user memory limit reached');
      END;
      CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('research_session', 'published_post')),
        resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_accessed_at TEXT,
        CHECK (expires_at > created_at),
        CHECK (julianday(expires_at) <= julianday(created_at) + 90)
      );
      CREATE INDEX IF NOT EXISTS idx_share_links_owner_created
        ON share_links(owner_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('research_session', 'published_post')),
        resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
        format TEXT NOT NULL CHECK (format IN ('markdown', 'json', 'pdf')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
        file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 96),
        content_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
        payload_base64 TEXT,
        output_bytes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT,
        UNIQUE(owner_id, resource_type, resource_id, format, snapshot_hash),
        CHECK (
          (status = 'completed' AND payload_base64 IS NOT NULL AND output_bytes BETWEEN 1 AND 2000000 AND completed_at IS NOT NULL AND failure_reason IS NULL)
          OR (status = 'pending' AND payload_base64 IS NULL AND output_bytes IS NULL AND completed_at IS NULL AND failure_reason IS NULL)
          OR (status = 'failed' AND payload_base64 IS NULL AND output_bytes IS NULL AND completed_at IS NULL AND failure_reason IS NOT NULL)
        ),
        CHECK (payload_base64 IS NULL OR length(payload_base64) <= 2666668)
      );
      CREATE INDEX IF NOT EXISTS idx_exports_owner_created
        ON exports(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exports_resource
        ON exports(owner_id, resource_type, resource_id, format, snapshot_hash);
    `);
    for (const table of ["research_sessions", "post_followups"]) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "owner_id")) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT`);
      }
    }
    const quotaColumns = this.database
      .prepare("PRAGMA table_info(user_quota_windows)")
      .all() as Array<{ name: string }>;
    if (!quotaColumns.some((column) => column.name === "window_seconds")) {
      this.database.exec(
        "ALTER TABLE user_quota_windows ADD COLUMN window_seconds INTEGER NOT NULL DEFAULT 86400",
      );
    }
    const documentColumns = this.database.prepare("PRAGMA table_info(documents)").all() as Array<{
      name: string;
    }>;
    if (!documentColumns.some((column) => column.name === "metadata_json")) {
      this.database.exec(
        "ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' ",
      );
    }
  }

  async getTopicByUrl(url: string): Promise<TopicCandidate | undefined> {
    const row = this.database
      .prepare("SELECT data FROM topics WHERE url = ?")
      .get(canonicalizeUrl(url)) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TopicCandidate) : undefined;
  }

  async getTopic(id: string): Promise<TopicCandidate | undefined> {
    const row = this.database.prepare("SELECT data FROM topics WHERE id = ?").get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TopicCandidate) : undefined;
  }

  async saveTopic(topic: TopicCandidate): Promise<void> {
    await this.workerWrite(() => {
      const url = canonicalizeUrl(topic.url);
      this.database
        .prepare(
          `
      INSERT INTO topics (id, url, status, score, discovered_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, score = excluded.score, data = excluded.data
    `,
        )
        .run(
          topic.id,
          url,
          topic.status,
          topic.score,
          topic.discoveredAt,
          JSON.stringify({ ...topic, url }),
        );
    });
  }

  async listTopics(limit = 100): Promise<TopicCandidate[]> {
    const rows = this.database
      .prepare("SELECT data FROM topics ORDER BY discovered_at DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as TopicCandidate);
  }

  async saveRun(run: AutonomousRun): Promise<void> {
    await this.workerWrite(() => {
      this.database
        .prepare(
          `
      INSERT INTO autonomous_runs (id, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, updated_at = excluded.updated_at, data = excluded.data
    `,
        )
        .run(run.id, run.status, run.createdAt, run.updatedAt, JSON.stringify(run));
    }, run.status === "CANCELLED");
  }

  async getRun(id: string): Promise<AutonomousRun | undefined> {
    const row = this.database.prepare("SELECT data FROM autonomous_runs WHERE id = ?").get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AutonomousRun) : undefined;
  }

  async listRuns(limit = 100): Promise<AutonomousRun[]> {
    const rows = this.database
      .prepare("SELECT data FROM autonomous_runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as AutonomousRun);
  }

  async savePost(post: ResearchPost): Promise<void> {
    await currentWorkerContext()?.assertLease();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertWorkerLease();
      this.insertPostRows(post);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async publishPost(post: ResearchPost, topic: TopicCandidate, run: AutonomousRun): Promise<void> {
    await currentWorkerContext()?.assertLease();
    if (
      post.topicId !== topic.id ||
      run.topicId !== topic.id ||
      run.postId !== post.id ||
      run.status !== "PUBLISHED"
    ) {
      throw new Error("Published post, topic, and run state do not match");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertWorkerLease();
      this.insertPostRows(post);
      const topicUpdate = this.database
        .prepare(
          `
        UPDATE topics SET status = ?, data = ? WHERE id = ?
      `,
        )
        .run(topic.status, JSON.stringify(topic), topic.id);
      if (Number(topicUpdate.changes) !== 1) throw new Error("Publication topic was not found");

      const runUpdate = this.database
        .prepare(
          `
        UPDATE autonomous_runs SET status = ?, updated_at = ?, data = ? WHERE id = ?
      `,
        )
        .run(run.status, run.updatedAt, JSON.stringify(run), run.id);
      if (Number(runUpdate.changes) !== 1) throw new Error("Autonomous run was not found");

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertPostRows(post: ResearchPost): void {
    this.database
      .prepare(
        `
      INSERT INTO posts (id, topic_id, research_id, published_at, data)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(post.id, post.topicId, post.researchId, post.publishedAt, JSON.stringify(post));
    const sourceStatement = this.database.prepare(
      "INSERT INTO post_sources (post_id, source_id, url) VALUES (?, ?, ?)",
    );
    for (const source of post.sources) sourceStatement.run(post.id, source.id, source.url);
    const claimStatement = this.database.prepare(
      "INSERT INTO post_claims (post_id, claim_id) VALUES (?, ?)",
    );
    for (const claim of post.claims) claimStatement.run(post.id, claim.id);
  }

  async getPost(id: string): Promise<ResearchPost | undefined> {
    const row = this.database.prepare("SELECT data FROM posts WHERE id = ?").get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ResearchPost) : undefined;
  }

  async getPublishedPost(id: string): Promise<ResearchPost | undefined> {
    const publishedRun = this.database
      .prepare(
        "SELECT 1 FROM autonomous_runs WHERE status = 'PUBLISHED' AND json_extract(data, '$.postId') = ? LIMIT 1",
      )
      .get(id);
    return publishedRun ? this.getPost(id) : undefined;
  }

  async listPosts(limit = 100): Promise<ResearchPost[]> {
    const rows = this.database
      .prepare("SELECT data FROM posts ORDER BY published_at DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ResearchPost);
  }

  async listPublishedPosts(limit = 100): Promise<ResearchPost[]> {
    const rows = this.database
      .prepare(
        `
      SELECT post.data
      FROM posts AS post
      WHERE EXISTS (
        SELECT 1
        FROM autonomous_runs AS run
        WHERE run.status = 'PUBLISHED'
          AND json_extract(run.data, '$.postId') = post.id
      )
      ORDER BY post.published_at DESC
      LIMIT ?
    `,
      )
      .all(Math.min(500, Math.max(1, limit))) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ResearchPost);
  }

  async saveFollowUp(followUp: ResearchFollowUp): Promise<void> {
    await this.workerWrite(() => {
      const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId() ?? null;
      this.database
        .prepare(
          `
      INSERT INTO post_followups (id, owner_id, post_id, status, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, updated_at = excluded.updated_at, data = excluded.data
      WHERE post_followups.owner_id IS excluded.owner_id
    `,
        )
        .run(
          followUp.id,
          ownerId,
          followUp.postId,
          followUp.status,
          followUp.updatedAt,
          JSON.stringify(followUp),
        );
    });
  }

  async getFollowUp(id: string): Promise<ResearchFollowUp | undefined> {
    const userId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const row = (
      userId
        ? this.database
            .prepare("SELECT data FROM post_followups WHERE id = ? AND owner_id = ?")
            .get(id, userId)
        : this.database.prepare("SELECT data FROM post_followups WHERE id = ?").get(id)
    ) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ResearchFollowUp) : undefined;
  }

  recoverAutonomousRuns(): number {
    const rows = this.database
      .prepare(
        `
      SELECT id, data FROM autonomous_runs
      WHERE status IN ('DISCOVERING', 'RESEARCHING', 'QUALITY_GATE')
    `,
      )
      .all() as Array<{ id: string; data: string }>;
    for (const row of rows) {
      const run = JSON.parse(row.data) as AutonomousRun;
      run.status = "FAILED";
      run.error = "Autonomous run was interrupted by a server restart; retry it manually.";
      run.updatedAt = new Date().toISOString();
      run.events.push({
        at: run.updatedAt,
        stage: "recovery",
        status: "failed",
        detail: run.error,
      });
      this.database
        .prepare(
          `
        UPDATE autonomous_runs SET status = ?, updated_at = ?, data = ? WHERE id = ?
      `,
        )
        .run(run.status, run.updatedAt, JSON.stringify(run), run.id);
    }
    const followUps = this.database
      .prepare(
        `
      SELECT id, data FROM post_followups
      WHERE status IN ('QUEUED', 'RESEARCHING', 'SYNTHESIZING')
    `,
      )
      .all() as Array<{ id: string; data: string }>;
    for (const row of followUps) {
      const followUp = JSON.parse(row.data) as ResearchFollowUp;
      followUp.status = "FAILED";
      followUp.error = "Follow-up research was interrupted by a server restart; ask again.";
      followUp.updatedAt = new Date().toISOString();
      this.database
        .prepare(
          `
        UPDATE post_followups SET status = ?, updated_at = ?, data = ? WHERE id = ?
      `,
        )
        .run(followUp.status, followUp.updatedAt, JSON.stringify(followUp), row.id);
    }
    return rows.length;
  }

  async getDocument(url: string): Promise<StoredDocument | undefined> {
    const row = this.database
      .prepare("SELECT * FROM documents WHERE url = ?")
      .get(canonicalizeUrl(url)) as Record<string, string | number> | undefined;
    return row ? this.documentFromRow(row) : undefined;
  }

  async saveDocument(
    document: Omit<StoredDocument, "contentHash" | "version" | "lastVerifiedAt">,
  ): Promise<void> {
    const url = canonicalizeUrl(document.url);
    const old = await this.getDocument(url);
    const contentHash = createHash("sha256").update(document.content).digest("hex");
    const version = old && old.contentHash !== contentHash ? old.version + 1 : (old?.version ?? 1);
    const verifiedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `
        INSERT INTO documents (url, title, content, raw_html, fetched_at,
          last_verified_at, published_at, metadata_json, content_hash, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title, content = excluded.content,
          raw_html = excluded.raw_html, fetched_at = excluded.fetched_at,
          last_verified_at = excluded.last_verified_at,
          published_at = excluded.published_at,
          metadata_json = excluded.metadata_json,
          content_hash = excluded.content_hash, version = excluded.version
      `,
        )
        .run(
          url,
          document.title,
          document.content,
          document.rawHtml,
          document.fetchedAt,
          verifiedAt,
          document.publishedAt ?? null,
          JSON.stringify(document.metadata ?? {}),
          contentHash,
          version,
        );
      this.database.prepare("DELETE FROM documents_fts WHERE url = ?").run(url);
      this.database
        .prepare("INSERT INTO documents_fts (url, title, content) VALUES (?, ?, ?)")
        .run(url, document.title, document.content);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async searchDocuments(query: string, maxAgeMs: number, limit = 10): Promise<StoredDocument[]> {
    const tokens =
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.slice(0, 8) ?? [];
    if (tokens.length === 0) return [];
    const terms = tokens.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
    const oldest = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.database
      .prepare(
        `
      SELECT d.* FROM documents_fts AS f
      JOIN documents AS d ON d.url = f.url
      WHERE documents_fts MATCH ? AND d.last_verified_at >= ?
      ORDER BY bm25(documents_fts), d.last_verified_at DESC
      LIMIT ?
    `,
      )
      .all(terms, oldest, Math.min(30, Math.max(1, limit))) as Array<
      Record<string, string | number>
    >;
    return rows.map((row) => this.documentFromRow(row));
  }

  private documentFromRow(row: Record<string, string | number>): StoredDocument {
    return {
      url: String(row.url),
      title: String(row.title),
      content: String(row.content),
      rawHtml: String(row.raw_html),
      fetchedAt: String(row.fetched_at),
      lastVerifiedAt: String(row.last_verified_at),
      publishedAt: row.published_at ? String(row.published_at) : undefined,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : {},
      contentHash: String(row.content_hash),
      version: Number(row.version),
    };
  }

  async create(session: ResearchSession): Promise<void> {
    await this.workerWrite(() => {
      if (
        this.database
          .prepare("SELECT id FROM deleted_research_sessions WHERE id = ?")
          .get(session.id)
      )
        throw new Error("Research session was deleted");
      const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId() ?? null;
      this.database
        .prepare(
          `
      INSERT INTO research_sessions (id, owner_id, created_at, updated_at, status, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
          session.id,
          ownerId,
          session.createdAt,
          session.updatedAt,
          session.status,
          JSON.stringify(session),
        );
    });
  }

  async get(id: string): Promise<ResearchSession | undefined> {
    const userId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const row = (
      userId
        ? this.database
            .prepare("SELECT data FROM research_sessions WHERE id = ? AND owner_id = ?")
            .get(id, userId)
        : this.database.prepare("SELECT data FROM research_sessions WHERE id = ?").get(id)
    ) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ResearchSession) : undefined;
  }

  async update(session: ResearchSession): Promise<void> {
    await this.workerWrite(() => {
      if (
        this.database
          .prepare("SELECT id FROM deleted_research_sessions WHERE id = ?")
          .get(session.id)
      )
        throw new Error("Research session was deleted");
      const userId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
      const query = userId
        ? this.database.prepare(`
          UPDATE research_sessions SET updated_at = ?, status = ?, data = ?
          WHERE id = ? AND owner_id = ?
        `)
        : this.database.prepare(`
          UPDATE research_sessions SET updated_at = ?, status = ?, data = ? WHERE id = ?
        `);
      if (userId) {
        query.run(session.updatedAt, session.status, JSON.stringify(session), session.id, userId);
      } else {
        query.run(session.updatedAt, session.status, JSON.stringify(session), session.id);
      }
    }, session.status === "CANCELLED");
  }

  async list(
    limit = DEFAULT_RESEARCH_SESSION_PAGE_SIZE,
    cursor?: SessionCursor,
  ): Promise<ResearchSession[]> {
    const userId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const values: Array<string | number> = [];
    const ownerFilter = userId ? "owner_id = ? AND " : "";
    if (userId) values.push(userId);
    const cursorFilter = cursor ? "(created_at < ? OR (created_at = ? AND id < ?)) AND " : "";
    if (cursor) values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    values.push(normalizeResearchSessionQueryLimit(limit));
    const rows = this.database
      .prepare(
        `SELECT data FROM research_sessions
         WHERE ${ownerFilter}${cursorFilter}1 = 1
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...values) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ResearchSession);
  }

  async listExistingIds(ids: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(ids)].slice(0, 100);
    if (uniqueIds.length === 0) return new Set();
    const userId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const query = userId
      ? this.database.prepare(
          `SELECT id FROM research_sessions WHERE owner_id = ? AND id IN (${placeholders})`,
        )
      : this.database.prepare(`SELECT id FROM research_sessions WHERE id IN (${placeholders})`);
    const rows = (userId ? query.all(userId, ...uniqueIds) : query.all(...uniqueIds)) as Array<{
      id: string;
    }>;
    return new Set(rows.map((row) => row.id));
  }

  async listDeletedIds(ids: string[]): Promise<Set<string>> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    return new Set(
      ids.filter((id) =>
        this.database
          .prepare(
            `SELECT id FROM deleted_research_sessions WHERE id = ? ${ownerId ? "AND owner_id = ?" : ""}`,
          )
          .get(...(ownerId ? [id, ownerId] : [id])),
      ),
    );
  }

  async delete(id: string): Promise<void> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          `SELECT owner_id FROM research_sessions WHERE id = ? ${ownerId ? "AND owner_id = ?" : ""}`,
        )
        .get(...(ownerId ? [id, ownerId] : [id])) as { owner_id: string | null } | undefined;
      if (
        row ||
        (ownerId && !this.database.prepare("SELECT id FROM research_sessions WHERE id = ?").get(id))
      ) {
        this.database
          .prepare("INSERT OR IGNORE INTO deleted_research_sessions (id, owner_id) VALUES (?, ?)")
          .run(id, row?.owner_id ?? ownerId ?? null);
        this.database.prepare("DELETE FROM research_sessions WHERE id = ?").run(id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async consumeRateLimit(scope: string, clientKey: string, windowMs: number, limit: number) {
    const now = Date.now();
    const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
    const key = createHash("sha256").update(`${scope}\0${clientKey}`).digest("hex");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "DELETE FROM request_rate_limits WHERE key IN (SELECT key FROM request_rate_limits WHERE window_end <= ? LIMIT 100)",
        )
        .run(now);
      const row = this.database
        .prepare(
          `INSERT INTO request_rate_limits(key,window_end,used) VALUES (?,?,1)
        ON CONFLICT(key) DO UPDATE SET window_end=excluded.window_end,
          used=CASE WHEN request_rate_limits.window_end=excluded.window_end THEN MIN(request_rate_limits.used+1,?) ELSE 1 END
        RETURNING used`,
        )
        .get(key, windowEnd, limit + 1) as { used: number };
      this.database.exec("COMMIT");
      return {
        allowed: row.used <= limit,
        limit,
        remaining: Math.max(0, limit - row.used),
        resetMs: windowEnd - now,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async consumeUserQuota(
    userId: string,
    quotaKey: UserQuotaKey,
    windowSeconds: number,
    limit: number,
  ): Promise<QuotaConsumption> {
    if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 604800) {
      throw new Error("Invalid quota window");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      throw new Error("Invalid quota limit");
    }
    const windowStart = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          "SELECT window_start, window_seconds, used FROM user_quota_windows WHERE user_id = ? AND quota_key = ?",
        )
        .get(userId, quotaKey) as
        { window_start: number; window_seconds: number; used: number } | undefined;
      const used =
        row && row.window_start === windowStart && row.window_seconds === windowSeconds
          ? Number(row.used)
          : 0;
      const allowed = used < limit;
      const nextUsed = allowed ? used + 1 : used;
      if (allowed) {
        this.database
          .prepare(
            `
            INSERT INTO user_quota_windows (user_id, quota_key, window_start, window_seconds, used)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, quota_key) DO UPDATE SET
              window_start = excluded.window_start,
              window_seconds = excluded.window_seconds,
              used = excluded.used
          `,
          )
          .run(userId, quotaKey, windowStart, windowSeconds, nextUsed);
      }
      this.database.exec("COMMIT");
      return {
        allowed,
        used: nextUsed,
        resetsAt: new Date((windowStart + windowSeconds) * 1000).toISOString(),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getUserQuotaUsage(userId: string, quotaKey: UserQuotaKey, windowSeconds: number) {
    if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 604800) {
      throw new Error("Invalid quota window");
    }
    const windowStart = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds;
    const row = this.database
      .prepare(
        "SELECT window_start, window_seconds, used FROM user_quota_windows WHERE user_id = ? AND quota_key = ?",
      )
      .get(userId, quotaKey) as
      { window_start: number; window_seconds: number; used: number } | undefined;
    const used =
      row && row.window_start === windowStart && row.window_seconds === windowSeconds
        ? Number(row.used)
        : 0;
    return {
      used,
      resetsAt: new Date((windowStart + windowSeconds) * 1000).toISOString(),
    };
  }

  private authenticatedMemoryOwner(): string {
    const ownerId = currentAuthenticatedUser()?.userId;
    if (!ownerId) throw new Error("User memory access requires authentication");
    return ownerId;
  }

  private userMemoryFromRow(row: Record<string, string | number | null>): UserMemoryRecord {
    return {
      id: String(row.id),
      category: String(row.category) as UserMemoryRecord["category"],
      content: String(row.content),
      contentHash: String(row.content_hash),
      sourceType: String(row.source_type) as UserMemoryRecord["sourceType"],
      sourceRef: row.source_ref ? String(row.source_ref) : undefined,
      provenance: JSON.parse(String(row.provenance_json)) as UserMemoryRecord["provenance"],
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      embedding: JSON.parse(String(row.embedding_json)) as number[],
      embeddingModel: String(row.embedding_model),
      isActive: Number(row.is_active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async createUserMemory(
    memory: NewUserMemoryRecord,
  ): Promise<{ memory: UserMemoryRecord; inserted: boolean }> {
    const ownerId = this.authenticatedMemoryOwner();
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `
        INSERT INTO user_memories (
          id, owner_id, category, content, content_hash, source_type, source_ref,
          provenance_json, confidence, importance, embedding_json, embedding_model,
          is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(owner_id, content_hash) DO NOTHING
      `,
      )
      .run(
        id,
        ownerId,
        memory.category,
        memory.content,
        memory.contentHash,
        memory.sourceType,
        memory.sourceRef ?? null,
        JSON.stringify(memory.provenance),
        memory.confidence,
        memory.importance,
        JSON.stringify(memory.embedding),
        memory.embeddingModel,
        now,
        now,
      );
    const row = this.database
      .prepare("SELECT * FROM user_memories WHERE owner_id = ? AND content_hash = ?")
      .get(ownerId, memory.contentHash) as Record<string, string | number | null> | undefined;
    if (!row) throw new Error("User memory could not be created");
    return { memory: this.userMemoryFromRow(row), inserted: Number(result.changes) > 0 };
  }

  async countRetainedUserMemories(): Promise<number> {
    const ownerId = this.authenticatedMemoryOwner();
    const row = this.database
      .prepare("SELECT count(*) AS count FROM user_memories WHERE owner_id = ?")
      .get(ownerId) as { count: number };
    return Number(row.count);
  }

  async findUserMemoryByHash(contentHash: string): Promise<UserMemoryRecord | undefined> {
    const ownerId = this.authenticatedMemoryOwner();
    const row = this.database
      .prepare("SELECT * FROM user_memories WHERE owner_id = ? AND content_hash = ?")
      .get(ownerId, contentHash) as Record<string, string | number | null> | undefined;
    return row ? this.userMemoryFromRow(row) : undefined;
  }

  async getUserMemory(
    id: string,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord | undefined> {
    const ownerId = this.authenticatedMemoryOwner();
    const row = this.database
      .prepare("SELECT * FROM user_memories WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as Record<string, string | number | null> | undefined;
    return row ? this.userMemoryPublicFromRow(row) : undefined;
  }

  async listUserMemories(
    limit = 50,
    includeInactive = false,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord[]> {
    const ownerId = this.authenticatedMemoryOwner();
    const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = (
      includeInactive
        ? this.database
            .prepare(
              "SELECT * FROM user_memories WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?",
            )
            .all(ownerId, boundedLimit)
        : this.database
            .prepare(
              "SELECT * FROM user_memories WHERE owner_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT ?",
            )
            .all(ownerId, boundedLimit)
    ) as Array<Record<string, string | number | null>>;
    return rows.map((row) => this.userMemoryPublicFromRow(row));
  }

  async updateUserMemory(
    id: string,
    update: UserMemoryUpdate,
  ): Promise<import("./memory-domain.js").UserMemoryPublicRecord | undefined> {
    const ownerId = this.authenticatedMemoryOwner();
    const assignments: string[] = ["updated_at = ?"];
    const values: Array<string | number> = [update.updatedAt];
    if (update.category !== undefined) {
      assignments.push("category = ?");
      values.push(update.category);
    }
    if (update.content !== undefined) {
      assignments.push("content = ?");
      values.push(update.content);
    }
    if (update.contentHash !== undefined) {
      assignments.push("content_hash = ?");
      values.push(update.contentHash);
    }
    if (update.importance !== undefined) {
      assignments.push("importance = ?");
      values.push(update.importance);
    }
    if (update.embedding !== undefined) {
      assignments.push("embedding_json = ?");
      values.push(JSON.stringify(update.embedding));
    }
    if (update.embeddingModel !== undefined) {
      assignments.push("embedding_model = ?");
      values.push(update.embeddingModel);
    }
    if (update.isActive !== undefined) {
      assignments.push("is_active = ?");
      values.push(update.isActive ? 1 : 0);
    }
    this.database
      .prepare(`UPDATE user_memories SET ${assignments.join(", ")} WHERE id = ? AND owner_id = ?`)
      .run(...values, id, ownerId);
    return this.getUserMemory(id);
  }

  async deleteUserMemory(id: string): Promise<boolean> {
    const ownerId = this.authenticatedMemoryOwner();
    const result = this.database
      .prepare("DELETE FROM user_memories WHERE id = ? AND owner_id = ?")
      .run(id, ownerId);
    return Number(result.changes) > 0;
  }

  async createShare(share: NewShareRecord): Promise<ShareMetadata> {
    this.assertShareOwner(share.ownerId);
    this.database
      .prepare(
        `INSERT INTO share_links (
          id, owner_id, resource_type, resource_id, token_hash,
          created_at, expires_at, revoked_at, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        share.id,
        share.ownerId,
        share.resourceType,
        share.resourceId,
        share.tokenHash,
        share.createdAt,
        share.expiresAt,
        share.revokedAt ?? null,
        share.lastAccessedAt ?? null,
      );
    return this.shareMetadata(share);
  }

  async listShares(ownerId: string, limit = 100): Promise<ShareMetadata[]> {
    this.assertShareOwner(ownerId);
    const rows = this.database
      .prepare("SELECT * FROM share_links WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(ownerId, Math.min(100, Math.max(1, limit))) as Array<Record<string, string | null>>;
    return rows.map((row) => this.shareMetadataFromRow(row));
  }

  async revokeShare(id: string, ownerId: string, revokedAt: string): Promise<boolean> {
    this.assertShareOwner(ownerId);
    const result = this.database
      .prepare(
        "UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND owner_id = ?",
      )
      .run(revokedAt, id, ownerId);
    return Number(result.changes) > 0;
  }

  async resolveShare(
    tokenHash: string,
    accessedAt: string,
  ): Promise<ResolvedShareRecord | undefined> {
    this.database
      .prepare(
        `UPDATE share_links SET last_accessed_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(accessedAt, tokenHash, accessedAt);
    const row = this.database
      .prepare(
        `SELECT * FROM share_links
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, accessedAt) as Record<string, string | null> | undefined;
    return row ? this.resolvedShareFromRow(row) : undefined;
  }

  async classifyShareFailure(
    tokenHash: string,
    checkedAt: string,
  ): Promise<"unknown" | "expired" | "revoked" | "active"> {
    const row = this.database
      .prepare("SELECT expires_at, revoked_at FROM share_links WHERE token_hash = ?")
      .get(tokenHash) as { expires_at: string; revoked_at: string | null } | undefined;
    if (!row) return "unknown";
    if (row.revoked_at) return "revoked";
    if (Date.parse(row.expires_at) <= Date.parse(checkedAt)) return "expired";
    return "active";
  }

  private authenticatedExportOwner(ownerId?: string): string {
    const currentOwner = currentAuthenticatedUser()?.userId;
    if (!currentOwner || (ownerId !== undefined && currentOwner !== ownerId)) {
      throw new Error("Export access requires the authenticated owner context");
    }
    return currentOwner;
  }

  private exportRecordFromRow(row: Record<string, string | number | null>): ExportRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      resourceType: String(row.resource_type) as ExportResourceType,
      resourceId: String(row.resource_id),
      format: String(row.format) as ExportFormat,
      status: String(row.status) as ExportStatus,
      snapshotHash: String(row.snapshot_hash),
      fileName: String(row.file_name),
      contentType: String(row.content_type),
      attempts: Number(row.attempts),
      ...(row.payload_base64 ? { payloadBase64: String(row.payload_base64) } : {}),
      ...(row.output_bytes !== null ? { outputBytes: Number(row.output_bytes) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.failure_reason ? { failureReason: String(row.failure_reason) } : {}),
    };
  }

  async createExport(record: NewExportRecord): Promise<{ record: ExportRecord; created: boolean }> {
    const ownerId = this.authenticatedExportOwner(record.ownerId);
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO exports (
          id, owner_id, resource_type, resource_id, format, status, snapshot_hash,
          file_name, content_type, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        ownerId,
        record.resourceType,
        record.resourceId,
        record.format,
        record.snapshotHash,
        record.fileName,
        record.contentType,
        record.attempts,
        record.createdAt,
        record.updatedAt,
      );
    const row = this.database
      .prepare(
        `SELECT * FROM exports WHERE owner_id = ? AND resource_type = ? AND resource_id = ?
          AND format = ? AND snapshot_hash = ?`,
      )
      .get(ownerId, record.resourceType, record.resourceId, record.format, record.snapshotHash) as
      Record<string, string | number | null> | undefined;
    if (!row) throw new Error("Export request could not be persisted");
    return {
      record: this.exportRecordFromRow(row),
      created: Number(result.changes) > 0,
    };
  }

  async retryFailedExport(id: string, ownerId: string, updatedAt: string): Promise<boolean> {
    const owner = this.authenticatedExportOwner(ownerId);
    const result = this.database
      .prepare(
        `UPDATE exports SET status = 'pending', attempts = attempts + 1, updated_at = ?,
          payload_base64 = NULL, output_bytes = NULL, completed_at = NULL, failure_reason = NULL
          WHERE id = ? AND owner_id = ? AND status = 'failed' AND attempts < ?`,
      )
      .run(updatedAt, id, owner, MAX_EXPORT_ATTEMPTS);
    return Number(result.changes) > 0;
  }

  async reclaimStaleExport(
    id: string,
    ownerId: string,
    staleBefore: string,
    updatedAt: string,
  ): Promise<boolean> {
    const owner = this.authenticatedExportOwner(ownerId);
    const result = this.database
      .prepare(
        `UPDATE exports SET attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'pending' AND updated_at <= ? AND attempts < ?`,
      )
      .run(updatedAt, id, owner, staleBefore, MAX_EXPORT_ATTEMPTS);
    return Number(result.changes) > 0;
  }

  async completeExport(
    id: string,
    ownerId: string,
    completion: ExportCompletion,
  ): Promise<boolean> {
    const owner = this.authenticatedExportOwner(ownerId);
    const result = this.database
      .prepare(
        `UPDATE exports SET status = 'completed', payload_base64 = ?, output_bytes = ?,
          completed_at = ?, updated_at = ?, failure_reason = NULL
         WHERE id = ? AND owner_id = ? AND status = 'pending'`,
      )
      .run(
        completion.payloadBase64,
        completion.outputBytes,
        completion.completedAt,
        completion.updatedAt,
        id,
        owner,
      );
    return Number(result.changes) > 0;
  }

  async failExport(
    id: string,
    ownerId: string,
    updatedAt: string,
    failureReason: string,
  ): Promise<boolean> {
    const owner = this.authenticatedExportOwner(ownerId);
    const safeReason = failureReason.slice(0, 80);
    const result = this.database
      .prepare(
        `UPDATE exports SET status = 'failed', updated_at = ?, failure_reason = ?,
          payload_base64 = NULL, output_bytes = NULL, completed_at = NULL
         WHERE id = ? AND owner_id = ? AND status = 'pending'`,
      )
      .run(updatedAt, safeReason, id, owner);
    return Number(result.changes) > 0;
  }

  async getExport(id: string, ownerId: string): Promise<ExportRecord | undefined> {
    const owner = this.authenticatedExportOwner(ownerId);
    const row = this.database
      .prepare("SELECT * FROM exports WHERE id = ? AND owner_id = ?")
      .get(id, owner) as Record<string, string | number | null> | undefined;
    return row ? this.exportRecordFromRow(row) : undefined;
  }

  async listExports(ownerId: string, limit = 100): Promise<ExportRecord[]> {
    const owner = this.authenticatedExportOwner(ownerId);
    const rows = this.database
      .prepare(
        `SELECT id,owner_id,resource_type,resource_id,format,status,snapshot_hash,file_name,
          content_type,attempts,output_bytes,created_at,updated_at,completed_at,failure_reason
         FROM exports WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(owner, Math.min(100, Math.max(1, limit))) as Array<
      Record<string, string | number | null>
    >;
    return rows.map((row) => this.exportRecordFromRow(row));
  }

  async deleteExport(id: string, ownerId: string): Promise<boolean> {
    const owner = this.authenticatedExportOwner(ownerId);
    const result = this.database
      .prepare("DELETE FROM exports WHERE id = ? AND owner_id = ?")
      .run(id, owner);
    return Number(result.changes) > 0;
  }

  private assertShareOwner(ownerId: string): void {
    if (currentAuthenticatedUser()?.userId !== ownerId) {
      throw new Error("Share management requires the authenticated owner context");
    }
  }

  private shareMetadata(share: ShareMetadata): ShareMetadata {
    return {
      id: share.id,
      ownerId: share.ownerId,
      resourceType: share.resourceType,
      resourceId: share.resourceId,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      ...(share.revokedAt ? { revokedAt: share.revokedAt } : {}),
      ...(share.lastAccessedAt ? { lastAccessedAt: share.lastAccessedAt } : {}),
    };
  }

  private shareMetadataFromRow(row: Record<string, string | null>): ShareMetadata {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      resourceType: row.resource_type as ShareResourceType,
      resourceId: String(row.resource_id),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
    };
  }

  private resolvedShareFromRow(row: Record<string, string | null>): ResolvedShareRecord {
    return {
      ...this.shareMetadataFromRow(row),
      tokenHash: String(row.token_hash),
    };
  }

  async searchUserMemories(
    embedding: number[],
    embeddingModel: string,
    minSimilarity: number,
    candidateLimit: number,
    limit: number,
  ): Promise<UserMemorySearchResult[]> {
    const ownerId = this.authenticatedMemoryOwner();
    const rows = this.database
      .prepare(
        "SELECT * FROM user_memories WHERE owner_id = ? AND is_active = 1 AND confidence >= 0.5 AND embedding_model = ?",
      )
      .all(ownerId, embeddingModel) as Array<Record<string, string | number | null>>;
    const cosineSimilarity = (left: number[], right: number[]) => {
      if (left.length !== right.length || left.length === 0) return undefined;
      let dot = 0;
      let leftNorm = 0;
      let rightNorm = 0;
      for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] * left[index];
        rightNorm += right[index] * right[index];
      }
      if (leftNorm === 0 || rightNorm === 0) return undefined;
      return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
    };
    return rows
      .map((row) => {
        const memory = this.userMemoryFromRow(row);
        return { memory, similarity: cosineSimilarity(embedding, memory.embedding) };
      })
      .filter(
        (item): item is { memory: UserMemoryRecord; similarity: number } =>
          item.similarity !== undefined && item.similarity >= minSimilarity,
      )
      .sort(
        (a, b) =>
          b.similarity - a.similarity ||
          b.memory.importance - a.memory.importance ||
          b.memory.updatedAt.localeCompare(a.memory.updatedAt),
      )
      .slice(0, Math.min(100, Math.max(1, candidateLimit), Math.max(1, limit)))
      .map(({ memory, similarity }) => {
        return { ...this.toUserMemoryPublicRecord(memory), similarity };
      });
  }

  private userMemoryPublicFromRow(
    row: Record<string, string | number | null>,
  ): import("./memory-domain.js").UserMemoryPublicRecord {
    return this.toUserMemoryPublicRecord(this.userMemoryFromRow(row));
  }

  private toUserMemoryPublicRecord(
    memory: UserMemoryRecord,
  ): import("./memory-domain.js").UserMemoryPublicRecord {
    const {
      contentHash: _hash,
      embedding: _vector,
      embeddingModel: _model,
      ...publicMemory
    } = memory;
    return publicMemory;
  }

  /** In-flight jobs cannot be resumed safely without their process-local controller. */
  recoverInterrupted(): number {
    const rows = this.database
      .prepare(
        `
      SELECT id, data FROM research_sessions
      WHERE status IN ('QUEUED', 'PLANNING', 'SEARCHING', 'FETCHING', 'ANALYZING', 'SYNTHESIZING')
    `,
      )
      .all() as Array<{ id: string; data: string }>;
    const update = this.database.prepare(`
      UPDATE research_sessions SET updated_at = ?, status = 'FAILED', data = ? WHERE id = ?
    `);
    for (const row of rows) {
      const session = JSON.parse(row.data) as ResearchSession;
      session.status = "FAILED";
      session.error = "Research was interrupted by a server restart; retry the request.";
      session.updatedAt = new Date().toISOString();
      update.run(session.updatedAt, JSON.stringify(session), row.id);
    }
    return rows.length;
  }

  close(): void {
    this.database.close();
  }
}
