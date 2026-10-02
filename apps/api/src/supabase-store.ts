import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import type { ResearchSession } from "./domain.js";
import type {
  AutonomousRun,
  ResearchFollowUp,
  ResearchPost,
  TopicCandidate,
} from "./content-domain.js";
import { canonicalizeUrl } from "./security.js";
import { normalizeResearchSessionQueryLimit } from "./store.js";
import type {
  ContentStore,
  KnowledgeStore,
  QuotaConsumption,
  SessionStore,
  StoredDocument,
  UserQuotaKey,
  UserQuotaStore,
  UserMemoryStore,
  NewShareRecord,
  ResolvedShareRecord,
  ShareMetadata,
  ShareResourceType,
  ShareStore,
  ExportRecord,
  NewExportRecord,
  ExportCompletion,
  ExportStore,
  SessionCursor,
} from "./store.js";
import type { ExportFormat, ExportResourceType, ExportStatus } from "./exports.js";
import { MAX_EXPORT_ATTEMPTS } from "./exports.js";
import { currentAuthenticatedUser, currentResearchOwnerId } from "./auth-context.js";
import { createSupabaseAuthFetch } from "./supabase-auth-fetch.js";
import type {
  NewUserMemoryRecord,
  UserMemoryRecord,
  UserMemoryPublicRecord,
  UserMemorySearchResult,
  UserMemoryUpdate,
} from "./memory-domain.js";
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

type Row = Record<string, unknown>;
type SupabaseClient = ReturnType<typeof createClient<any>>;
type SupabaseSchemaClient = ReturnType<SupabaseClient["schema"]>;
const MAX_SUPABASE_RESPONSE_BYTES = 32 * 1024 * 1024;
const SHARE_METADATA_COLUMNS =
  "id,owner_id,resource_type,resource_id,created_at,expires_at,revoked_at,last_accessed_at";
const SHARE_RESOLVED_COLUMNS = `${SHARE_METADATA_COLUMNS},token_hash`;
const EXPORT_COLUMNS =
  "id,owner_id,resource_type,resource_id,format,status,snapshot_hash,file_name,content_type,attempts,payload_base64,output_bytes,created_at,updated_at,completed_at";

const DURABLE_JOB_KINDS = new Set<DurableJobKind>(["research", "post_agent"]);
const DURABLE_JOB_STATUSES = new Set<DurableJobStatus>([
  "queued",
  "running",
  "retrying",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
]);

function durableJobFromRow(value: unknown): DurableJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase returned an invalid durable job row");
  }
  const row = value as Row;
  const kind = String(row.kind) as DurableJobKind;
  const status = String(row.status) as DurableJobStatus;
  if (!DURABLE_JOB_KINDS.has(kind) || !DURABLE_JOB_STATUSES.has(status)) {
    throw new Error("Supabase returned an unsupported durable job state");
  }
  const jsonObject = (input: unknown): Record<string, JobJsonValue> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    return input as Record<string, JobJsonValue>;
  };
  return {
    id: String(row.id),
    kind,
    ownerId: row.owner_id ? String(row.owner_id) : undefined,
    ownerScope: String(row.owner_scope),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    payload: jsonObject(row.payload),
    status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
    cancelRequestedAt: row.cancel_requested_at ? String(row.cancel_requested_at) : undefined,
    progress: jsonObject(row.progress),
    result: row.result == null ? undefined : jsonObject(row.result),
    errorSummary: row.error_summary ? String(row.error_summary) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}

function isJsonResponseBody(body: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return true;
  } catch {
    return false;
  }
}

export function createSupabaseFetch(): typeof fetch {
  const authAwareFetch = createSupabaseAuthFetch((input, init) => fetch(input, init));
  return async (input, init) => {
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
    requestHeaders.set("accept-encoding", "gzip");

    const response = await authAwareFetch(input, { ...init, headers: requestHeaders });
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );

    if (!requestUrl.pathname.includes("/rest/v1/") || !response.body) {
      return response;
    }

    const body = new Uint8Array(await response.clone().arrayBuffer());
    const isGzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
    let decodedBody: ReturnType<typeof gunzipSync>;
    if (isGzip) {
      decodedBody = gunzipSync(body, { maxOutputLength: MAX_SUPABASE_RESPONSE_BYTES });
    } else {
      if (isJsonResponseBody(body)) return response;

      try {
        decodedBody = brotliDecompressSync(body, {
          maxOutputLength: MAX_SUPABASE_RESPONSE_BYTES,
        });
      } catch {
        return response;
      }
      if (!isJsonResponseBody(decodedBody)) return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(decodedBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function raiseIfError(error: { message: string; code?: string; status?: number } | null): void {
  if (!error) return;

  const hasNonTextMessage = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(
    error.message,
  );
  const context = [
    error.status ? `HTTP ${error.status}` : undefined,
    error.code,
    hasNonTextMessage ? `error fields: ${Object.keys(error).join(",")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const contextSuffix = context ? ` (${context})` : "";
  const failure = new Error(
    `Supabase persistence operation failed${contextSuffix}: ${error.message}`,
  ) as Error & { code?: string };
  if (error.code) failure.code = error.code;
  throw failure;
}

function fromDocumentRow(row: Row): StoredDocument {
  return {
    url: String(row.url),
    title: String(row.title),
    content: String(row.content),
    rawHtml: String(row.raw_html),
    fetchedAt: String(row.fetched_at),
    lastVerifiedAt: String(row.last_verified_at),
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    metadata: (row.metadata as StoredDocument["metadata"]) ?? {},
    contentHash: String(row.content_hash),
    version: Number(row.version),
  };
}

function fromExportRow(row: Row): ExportRecord {
  const resourceType = String(row.resource_type) as ExportResourceType;
  const format = String(row.format) as ExportFormat;
  const status = String(row.status) as ExportStatus;
  if (
    !["research_session", "published_post"].includes(resourceType) ||
    !["markdown", "json", "pdf"].includes(format) ||
    !["pending", "completed", "failed"].includes(status)
  ) {
    throw new Error("Supabase returned an invalid export record");
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    resourceType,
    resourceId: String(row.resource_id),
    format,
    status,
    snapshotHash: String(row.snapshot_hash),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    attempts: Number(row.attempts),
    ...(row.payload_base64 ? { payloadBase64: String(row.payload_base64) } : {}),
    ...(row.output_bytes !== null && row.output_bytes !== undefined
      ? { outputBytes: Number(row.output_bytes) }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.failure_reason ? { failureReason: String(row.failure_reason) } : {}),
  };
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function vectorFromRow(value: unknown): number[] {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? JSON.parse(value)
      : undefined;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error("Supabase returned an invalid stored memory embedding");
  }
  return parsed as number[];
}

function provenanceFromRow(value: unknown): UserMemoryRecord["provenance"] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Supabase returned invalid memory provenance");
  return parsed as UserMemoryRecord["provenance"];
}

function fromMemoryRow(row: Row): UserMemoryRecord {
  return {
    id: String(row.id),
    category: String(row.category) as UserMemoryRecord["category"],
    content: String(row.content),
    contentHash: String(row.content_hash),
    sourceType: String(row.source_type) as UserMemoryRecord["sourceType"],
    sourceRef: row.source_ref ? String(row.source_ref) : undefined,
    provenance: provenanceFromRow(row.provenance),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    embedding: vectorFromRow(row.embedding),
    embeddingModel: String(row.embedding_model),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromPublicMemoryRow(row: Row): UserMemoryPublicRecord {
  return {
    id: String(row.id),
    category: String(row.category) as UserMemoryRecord["category"],
    content: String(row.content),
    sourceType: String(row.source_type) as UserMemoryRecord["sourceType"],
    sourceRef: row.source_ref ? String(row.source_ref) : undefined,
    provenance: provenanceFromRow(row.provenance),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const USER_MEMORY_PUBLIC_COLUMNS =
  "id,category,content,source_type,source_ref,provenance,confidence,importance,is_active,created_at,updated_at";

/** Supabase-backed implementation of the same application persistence contracts as SQLite. */
export class SupabaseStore
  implements
    SessionStore,
    KnowledgeStore,
    ContentStore,
    UserQuotaStore,
    UserMemoryStore,
    ShareStore,
    ExportStore,
    DurableJobStore
{
  private readonly research: SupabaseSchemaClient;
  private readonly content: SupabaseSchemaClient;
  private readonly url: string;
  private readonly publishableKey?: string;

  constructor(
    url: string,
    secretKey: string,
    injectedClient?: SupabaseClient,
    publishableKey?: string,
  ) {
    if (!url || !secretKey) {
      throw new Error(
        "Supabase persistence requires SUPABASE_URL and a backend-only Supabase secret key",
      );
    }
    this.url = url;
    this.publishableKey = publishableKey;
    const client =
      injectedClient ??
      createClient<any>(url, secretKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: { fetch: createSupabaseFetch() },
      });
    this.research = client.schema("research");
    this.content = client.schema("content");
  }

  private userResearch(): SupabaseSchemaClient | undefined {
    const identity = currentAuthenticatedUser();
    if (!identity) return undefined;
    if (!this.publishableKey) {
      throw new Error("User-scoped Supabase persistence is not configured");
    }
    return createClient<any>(this.url, this.publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        fetch: createSupabaseFetch(),
        headers: { Authorization: `Bearer ${identity.accessToken}` },
      },
    }).schema("research");
  }

  private userContent(): SupabaseSchemaClient | undefined {
    const identity = currentAuthenticatedUser();
    if (!identity) return undefined;
    if (!this.publishableKey) {
      throw new Error("User-scoped Supabase persistence is not configured");
    }
    return createClient<any>(this.url, this.publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        fetch: createSupabaseFetch(),
        headers: { Authorization: `Bearer ${identity.accessToken}` },
      },
    }).schema("content");
  }

  async create(session: ResearchSession): Promise<void> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const { error } = await this.research.from("max_research_sessions").insert({
      id: session.id,
      owner_id: ownerId ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      status: session.status,
      data: session,
    });
    raiseIfError(error);
  }

  async get(id: string): Promise<ResearchSession | undefined> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    let query = (this.userResearch() ?? this.research)
      .from("max_research_sessions")
      .select("data")
      .eq("id", id);
    if (ownerId) query = query.eq("owner_id", ownerId);
    const { data, error } = await query.maybeSingle();
    raiseIfError(error);
    return data ? (data.data as ResearchSession) : undefined;
  }

  async update(session: ResearchSession): Promise<void> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    const values: any = {
      id: session.id,
      ...(ownerId ? { owner_id: ownerId } : { owner_id: null }),
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      status: session.status,
      data: session,
    };
    if (ownerId) {
      const { data, error } = await this.research
        .from("max_research_sessions")
        .update(values)
        .eq("id", session.id)
        .eq("owner_id", ownerId)
        .select("id")
        .maybeSingle();
      raiseIfError(error);
      if (!data) throw new Error("Research session could not be updated");
      return;
    }
    const { error } = await this.research
      .from("max_research_sessions")
      .upsert(values, { onConflict: "id" });
    raiseIfError(error);
  }

  async list(limit = 50, cursor?: SessionCursor): Promise<ResearchSession[]> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    let query = (this.userResearch() ?? this.research)
      .from("max_research_sessions")
      .select("id,created_at,data")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (ownerId) query = query.eq("owner_id", ownerId);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query.limit(normalizeResearchSessionQueryLimit(limit));
    raiseIfError(error);
    return (data ?? []).map((row) => row.data as ResearchSession);
  }

  async listExistingIds(ids: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(ids)].slice(0, 100);
    if (uniqueIds.length === 0) return new Set();
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    let query = this.research.from("max_research_sessions").select("id").in("id", uniqueIds);
    if (ownerId) query = query.eq("owner_id", ownerId);
    const { data, error } = await query;
    raiseIfError(error);
    return new Set((data ?? []).map((row) => String(row.id)));
  }

  async delete(id: string): Promise<void> {
    const ownerId = currentAuthenticatedUser()?.userId ?? currentResearchOwnerId();
    let query = this.research.from("max_research_sessions").delete().eq("id", id);
    if (ownerId) query = query.eq("owner_id", ownerId);
    const { error } = await query;
    raiseIfError(error);
  }

  async recoverInterrupted(): Promise<number> {
    const { data, error } = await this.research.rpc("max_recover_interrupted_sessions");
    raiseIfError(error);
    return Number(data ?? 0);
  }

  async consumeUserQuota(
    userId: string,
    quotaKey: UserQuotaKey,
    windowSeconds: number,
    limit: number,
  ): Promise<QuotaConsumption> {
    const { data, error } = await this.research.rpc("max_consume_user_quota", {
      p_user_id: userId,
      p_quota_key: quotaKey,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    raiseIfError(error);
    const row = (Array.isArray(data) ? data[0] : data) as
      { allowed: boolean; used: number; resets_at: string } | undefined;
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("Supabase returned an invalid user quota result");
    }
    return {
      allowed: row.allowed,
      used: Number(row.used),
      resetsAt: String(row.resets_at),
    };
  }

  async getUserQuotaUsage(userId: string, quotaKey: UserQuotaKey, windowSeconds: number) {
    if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 604800) {
      throw new Error("Invalid quota window");
    }
    const { data, error } = await this.research
      .from("max_user_quota_windows")
      .select("window_start,window_seconds,used")
      .eq("user_id", userId)
      .eq("quota_key", quotaKey)
      .maybeSingle();
    raiseIfError(error);

    const windowStartMs = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
    const row = data as { window_start?: string; window_seconds?: number; used?: number } | null;
    const rowStart = row?.window_start ? Date.parse(row.window_start) : Number.NaN;
    const used =
      row &&
      Number.isFinite(rowStart) &&
      rowStart === windowStartMs &&
      Number(row.window_seconds) === windowSeconds
        ? Number(row.used ?? 0)
        : 0;
    return {
      used,
      resetsAt: new Date(windowStartMs + windowSeconds * 1000).toISOString(),
    };
  }

  private requireMemoryOwner(): { userId: string } {
    const identity = currentAuthenticatedUser();
    if (!identity) throw new Error("User memory access requires authentication");
    return identity;
  }

  async createUserMemory(
    memory: NewUserMemoryRecord,
  ): Promise<{ memory: UserMemoryRecord; inserted: boolean }> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { data, error } = await research
      .from("max_user_memories")
      .insert({
        owner_id: identity.userId,
        category: memory.category,
        content: memory.content,
        content_hash: memory.contentHash,
        source_type: memory.sourceType,
        source_ref: memory.sourceRef ?? null,
        provenance: memory.provenance,
        confidence: memory.confidence,
        importance: memory.importance,
        embedding: vectorLiteral(memory.embedding),
        embedding_model: memory.embeddingModel,
      })
      .select("*")
      .single();
    if (!error && data) return { memory: fromMemoryRow(data), inserted: true };
    if (error?.code === "23505") {
      const existing = await this.findUserMemoryByHash(memory.contentHash);
      if (existing) return { memory: existing, inserted: false };
    }
    raiseIfError(error);
    throw new Error("Supabase did not return the created user memory");
  }

  async countRetainedUserMemories(): Promise<number> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { count, error } = await research
      .from("max_user_memories")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", identity.userId);
    raiseIfError(error);
    return Number(count ?? 0);
  }

  async findUserMemoryByHash(contentHash: string): Promise<UserMemoryRecord | undefined> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { data, error } = await research
      .from("max_user_memories")
      .select("*")
      .eq("owner_id", identity.userId)
      .eq("content_hash", contentHash)
      .maybeSingle();
    raiseIfError(error);
    return data ? fromMemoryRow(data) : undefined;
  }

  async getUserMemory(id: string): Promise<UserMemoryPublicRecord | undefined> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { data, error } = await research
      .from("max_user_memories")
      .select(USER_MEMORY_PUBLIC_COLUMNS)
      .eq("owner_id", identity.userId)
      .eq("id", id)
      .maybeSingle();
    raiseIfError(error);
    return data ? fromPublicMemoryRow(data) : undefined;
  }

  async listUserMemories(limit = 50, includeInactive = false): Promise<UserMemoryPublicRecord[]> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    let query = research
      .from("max_user_memories")
      .select(USER_MEMORY_PUBLIC_COLUMNS)
      .eq("owner_id", identity.userId)
      .order("updated_at", { ascending: false })
      .limit(Math.min(50, Math.max(1, Math.floor(limit))));
    if (!includeInactive) query = query.eq("is_active", true);
    const { data, error } = await query;
    raiseIfError(error);
    return (data ?? []).map(fromPublicMemoryRow);
  }

  async updateUserMemory(
    id: string,
    update: UserMemoryUpdate,
  ): Promise<UserMemoryPublicRecord | undefined> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const values: Row = { updated_at: update.updatedAt };
    if (update.category !== undefined) values.category = update.category;
    if (update.content !== undefined) values.content = update.content;
    if (update.contentHash !== undefined) values.content_hash = update.contentHash;
    if (update.importance !== undefined) values.importance = update.importance;
    if (update.embedding !== undefined) values.embedding = vectorLiteral(update.embedding);
    if (update.embeddingModel !== undefined) values.embedding_model = update.embeddingModel;
    if (update.isActive !== undefined) values.is_active = update.isActive;
    const { data, error } = await research
      .from("max_user_memories")
      .update(values)
      .eq("owner_id", identity.userId)
      .eq("id", id)
      .select(USER_MEMORY_PUBLIC_COLUMNS)
      .maybeSingle();
    raiseIfError(error);
    return data ? fromPublicMemoryRow(data) : undefined;
  }

  async deleteUserMemory(id: string): Promise<boolean> {
    const identity = this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { data, error } = await research
      .from("max_user_memories")
      .delete()
      .eq("owner_id", identity.userId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async searchUserMemories(
    embedding: number[],
    embeddingModel: string,
    minSimilarity: number,
    candidateLimit: number,
    limit: number,
  ): Promise<UserMemorySearchResult[]> {
    this.requireMemoryOwner();
    const research = this.userResearch();
    if (!research) throw new Error("User-scoped Supabase persistence is unavailable");
    const { data, error } = await research.rpc("max_match_user_memories", {
      p_query_embedding: vectorLiteral(embedding),
      p_embedding_model: embeddingModel,
      p_min_similarity: minSimilarity,
      p_candidate_limit: candidateLimit,
      p_match_count: limit,
    });
    raiseIfError(error);
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id),
      category: String(row.category) as UserMemoryRecord["category"],
      content: String(row.content),
      sourceType: String(row.source_type) as UserMemoryRecord["sourceType"],
      sourceRef: row.source_ref ? String(row.source_ref) : undefined,
      provenance: provenanceFromRow(row.provenance),
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      isActive: true,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      similarity: Number(row.similarity),
    }));
  }

  async enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    const { data, error } = await this.research.rpc("max_enqueue_job", {
      p_id: input.id,
      p_kind: input.kind,
      p_owner_id: input.ownerId ?? null,
      p_owner_scope: input.ownerScope,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_payload: input.payload,
      p_max_attempts: input.maxAttempts,
      p_quota_key: input.quota?.key ?? null,
      p_quota_window_seconds: input.quota?.windowSeconds ?? null,
      p_quota_limit: input.quota?.limit ?? null,
    });
    raiseIfError(error);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Supabase returned an invalid job enqueue result");
    }
    const result = data as Row;
    const quotaValue =
      result.quota && typeof result.quota === "object" ? (result.quota as Row) : undefined;
    return {
      job: result.job ? durableJobFromRow(result.job) : undefined,
      created: result.created === true,
      quota:
        quotaValue && typeof quotaValue.allowed === "boolean"
          ? {
              allowed: quotaValue.allowed,
              used: Number(quotaValue.used ?? 0),
              resetsAt: String(quotaValue.resets_at),
            }
          : undefined,
    };
  }

  async claimJob(workerId: string, leaseSeconds: number): Promise<JobLease | undefined> {
    const { data, error } = await this.research.rpc("max_claim_job", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    raiseIfError(error);
    if (!data) return undefined;
    const job = durableJobFromRow(data);
    if (!job.leaseOwner || job.leaseOwner !== workerId) {
      throw new Error("Supabase returned a job without the expected lease owner");
    }
    return { job, workerId, generation: job.leaseGeneration };
  }

  async heartbeatJob(
    lease: JobLease,
    leaseSeconds: number,
    progress: Record<string, JobJsonValue>,
  ): Promise<JobHeartbeatResult> {
    const { data, error } = await this.research.rpc("max_heartbeat_job", {
      p_id: lease.job.id,
      p_worker_id: lease.workerId,
      p_generation: lease.generation,
      p_lease_seconds: leaseSeconds,
      p_progress: progress,
    });
    raiseIfError(error);
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    return {
      leaseValid: row?.lease_valid === true,
      cancelRequested: row?.cancel_requested === true,
    };
  }

  async completeJob(
    lease: JobLease,
    result: Record<string, JobJsonValue>,
  ): Promise<"completed" | "cancelled" | undefined> {
    const { data, error } = await this.research.rpc("max_complete_job", {
      p_id: lease.job.id,
      p_worker_id: lease.workerId,
      p_generation: lease.generation,
      p_result: result,
    });
    raiseIfError(error);
    return data === "completed" || data === "cancelled" ? data : undefined;
  }

  async failJob(
    lease: JobLease,
    errorSummary: string,
    retryable: boolean,
    retryDelaySeconds: number,
  ): Promise<DurableJobStatus | undefined> {
    const { data, error } = await this.research.rpc("max_fail_job", {
      p_id: lease.job.id,
      p_worker_id: lease.workerId,
      p_generation: lease.generation,
      p_error_summary: errorSummary.slice(0, 512),
      p_retryable: retryable,
      p_retry_delay_seconds: retryDelaySeconds,
    });
    raiseIfError(error);
    const status = typeof data === "string" ? (data as DurableJobStatus) : undefined;
    return status && DURABLE_JOB_STATUSES.has(status) ? status : undefined;
  }

  async cancelJob(
    id: string,
    ownerId?: string,
    includeSystemJobs = false,
  ): Promise<DurableJob | undefined> {
    const { data, error } = await this.research.rpc("max_cancel_job", {
      p_id: id,
      p_owner_id: ownerId ?? null,
      p_include_system: includeSystemJobs,
    });
    raiseIfError(error);
    return data ? durableJobFromRow(data) : undefined;
  }

  async getJob(id: string): Promise<DurableJob | undefined> {
    const { data, error } = await this.research
      .from("max_jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    raiseIfError(error);
    return data ? durableJobFromRow(data) : undefined;
  }

  async getOwnedJob(id: string, ownerId: string): Promise<DurableJob | undefined> {
    const { data, error } = await this.research
      .from("max_jobs")
      .select("*")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    raiseIfError(error);
    return data ? durableJobFromRow(data) : undefined;
  }

  async listOwnedJobs(ownerId: string, limit = 50): Promise<DurableJob[]> {
    const { data, error } = await this.research
      .from("max_jobs")
      .select("*")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, Math.floor(limit))));
    raiseIfError(error);
    return (data ?? []).map(durableJobFromRow);
  }

  async getJobForSession(sessionId: string, ownerId: string): Promise<DurableJob | undefined> {
    const { data, error } = await this.research
      .from("max_jobs")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("kind", "research")
      .order("created_at", { ascending: false })
      .limit(100);
    raiseIfError(error);
    const row = (data ?? []).find(
      (job) => (job.payload as Record<string, unknown> | null)?.sessionId === sessionId,
    );
    return row ? durableJobFromRow(row) : undefined;
  }

  async hasRunnableOrRunningJobs(kind: DurableJobKind): Promise<boolean> {
    const { data, error } = await this.research
      .from("max_jobs")
      .select("id")
      .eq("kind", kind)
      .in("status", ["queued", "retrying", "running", "cancel_requested"])
      .limit(1);
    raiseIfError(error);
    return Boolean(data?.length);
  }

  async getTopicByUrl(url: string): Promise<TopicCandidate | undefined> {
    const { data, error } = await this.content
      .from("max_topics")
      .select("data")
      .eq("url", canonicalizeUrl(url))
      .maybeSingle();
    raiseIfError(error);
    return data ? (data.data as TopicCandidate) : undefined;
  }

  async getTopic(id: string): Promise<TopicCandidate | undefined> {
    const { data, error } = await this.content
      .from("max_topics")
      .select("data")
      .eq("id", id)
      .maybeSingle();
    raiseIfError(error);
    return data ? (data.data as TopicCandidate) : undefined;
  }

  async saveTopic(topic: TopicCandidate): Promise<void> {
    const url = canonicalizeUrl(topic.url);
    const { error } = await this.content.from("max_topics").upsert(
      {
        id: topic.id,
        url,
        status: topic.status,
        score: topic.score,
        discovered_at: topic.discoveredAt,
        data: { ...topic, url },
      },
      { onConflict: "id" },
    );
    raiseIfError(error);
  }

  async listTopics(limit = 100): Promise<TopicCandidate[]> {
    const { data, error } = await this.content
      .from("max_topics")
      .select("data")
      .order("discovered_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, limit)));
    raiseIfError(error);
    return (data ?? []).map((row) => row.data as TopicCandidate);
  }

  async saveRun(run: AutonomousRun): Promise<void> {
    const { error } = await this.content.from("max_autonomous_runs").upsert(
      {
        id: run.id,
        status: run.status,
        created_at: run.createdAt,
        updated_at: run.updatedAt,
        data: run,
      },
      { onConflict: "id" },
    );
    raiseIfError(error);
  }

  async getRun(id: string): Promise<AutonomousRun | undefined> {
    const { data, error } = await this.content
      .from("max_autonomous_runs")
      .select("data")
      .eq("id", id)
      .maybeSingle();
    raiseIfError(error);
    return data ? (data.data as AutonomousRun) : undefined;
  }

  async listRuns(limit = 100): Promise<AutonomousRun[]> {
    const { data, error } = await this.content
      .from("max_autonomous_runs")
      .select("data")
      .order("created_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, limit)));
    raiseIfError(error);
    return (data ?? []).map((row) => row.data as AutonomousRun);
  }

  async recoverAutonomousRuns(): Promise<number> {
    const { data, error } = await this.content.rpc("max_recover_interrupted_content");
    raiseIfError(error);
    return Number(data ?? 0);
  }

  async savePost(post: ResearchPost): Promise<void> {
    const { error } = await this.content.rpc("max_save_post", { p_post: post });
    raiseIfError(error);
  }

  async publishPost(post: ResearchPost, topic: TopicCandidate, run: AutonomousRun): Promise<void> {
    if (
      post.topicId !== topic.id ||
      run.topicId !== topic.id ||
      run.postId !== post.id ||
      run.status !== "PUBLISHED"
    ) {
      throw new Error("Published post, topic, and run state do not match");
    }
    const { error } = await this.content.rpc("max_publish_post", {
      p_post: post,
      p_topic: topic,
      p_run: run,
    });
    raiseIfError(error);
  }

  async getPost(id: string): Promise<ResearchPost | undefined> {
    const { data, error } = await this.content
      .from("max_posts")
      .select("data")
      .eq("id", id)
      .maybeSingle();
    raiseIfError(error);
    return data ? (data.data as ResearchPost) : undefined;
  }

  async getPublishedPost(id: string): Promise<ResearchPost | undefined> {
    const { data: run, error: runError } = await this.content
      .from("max_autonomous_runs")
      .select("id")
      .eq("status", "PUBLISHED")
      .contains("data", { postId: id })
      .limit(1)
      .maybeSingle();
    raiseIfError(runError);
    if (!run) return undefined;
    return this.getPost(id);
  }

  async createShare(share: NewShareRecord): Promise<ShareMetadata> {
    const identity = currentAuthenticatedUser();
    if (!identity || identity.userId !== share.ownerId) {
      throw new Error("Share creation requires the authenticated owner context");
    }
    const userContent = this.userContent();
    if (!userContent) throw new Error("User-scoped share persistence is unavailable");
    const { data, error } = await userContent
      .from("max_shares")
      .insert({
        id: share.id,
        owner_id: share.ownerId,
        resource_type: share.resourceType,
        resource_id: share.resourceId,
        token_hash: share.tokenHash,
        expires_at: share.expiresAt,
      })
      .select(SHARE_METADATA_COLUMNS)
      .single();
    raiseIfError(error);
    if (!data) throw new Error("Supabase did not return the created share metadata");
    return shareMetadataFromRow(data as Row);
  }

  async listShares(ownerId: string, limit = 100): Promise<ShareMetadata[]> {
    const identity = currentAuthenticatedUser();
    if (!identity || identity.userId !== ownerId) {
      throw new Error("Share listing requires the authenticated owner context");
    }
    const userContent = this.userContent();
    if (!userContent) throw new Error("User-scoped share persistence is unavailable");
    const { data, error } = await userContent
      .from("max_shares")
      .select(SHARE_METADATA_COLUMNS)
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, limit)));
    raiseIfError(error);
    return (data ?? []).map((row) => shareMetadataFromRow(row as Row));
  }

  async revokeShare(id: string, ownerId: string, revokedAt: string): Promise<boolean> {
    const identity = currentAuthenticatedUser();
    if (!identity || identity.userId !== ownerId) {
      throw new Error("Share revocation requires the authenticated owner context");
    }
    const userContent = this.userContent();
    if (!userContent) throw new Error("User-scoped share persistence is unavailable");
    const { data, error } = await userContent
      .from("max_shares")
      .update({ revoked_at: revokedAt })
      .eq("id", id)
      .eq("owner_id", ownerId)
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    if (data) return true;
    const { data: existing, error: readError } = await userContent
      .from("max_shares")
      .select("id")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    raiseIfError(readError);
    return Boolean(existing);
  }

  async resolveShare(
    tokenHash: string,
    accessedAt: string,
  ): Promise<ResolvedShareRecord | undefined> {
    const { data, error } = await this.content
      .from("max_shares")
      .update({ last_accessed_at: accessedAt })
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", accessedAt)
      .select(SHARE_RESOLVED_COLUMNS)
      .maybeSingle();
    raiseIfError(error);
    return data ? resolvedShareFromRow(data as Row) : undefined;
  }

  async classifyShareFailure(
    tokenHash: string,
    checkedAt: string,
  ): Promise<"unknown" | "expired" | "revoked" | "active"> {
    const { data, error } = await this.content
      .from("max_shares")
      .select("expires_at,revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    raiseIfError(error);
    if (!data) return "unknown";
    if (data.revoked_at) return "revoked";
    if (Date.parse(String(data.expires_at)) <= Date.parse(checkedAt)) return "expired";
    return "active";
  }

  private authenticatedExportContent(ownerId?: string): SupabaseSchemaClient {
    const identity = currentAuthenticatedUser();
    if (!identity || (ownerId !== undefined && identity.userId !== ownerId)) {
      throw new Error("Export access requires the authenticated owner context");
    }
    const content = this.userContent();
    if (!content) throw new Error("User-scoped export persistence is unavailable");
    return content;
  }

  async createExport(record: NewExportRecord): Promise<{ record: ExportRecord; created: boolean }> {
    const content = this.authenticatedExportContent(record.ownerId);
    const { data, error } = await content
      .from("max_exports")
      .insert({
        id: record.id,
        owner_id: record.ownerId,
        resource_type: record.resourceType,
        resource_id: record.resourceId,
        format: record.format,
        status: "pending",
        snapshot_hash: record.snapshotHash,
        file_name: record.fileName,
        content_type: record.contentType,
        attempts: record.attempts,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .select(EXPORT_COLUMNS)
      .maybeSingle();
    if (!error && data) return { record: fromExportRow(data as Row), created: true };
    if (!error) throw new Error("Supabase did not return the created export record");
    if (error.code !== "23505") raiseIfError(error);

    const { data: existing, error: readError } = await content
      .from("max_exports")
      .select(EXPORT_COLUMNS)
      .eq("owner_id", record.ownerId)
      .eq("resource_type", record.resourceType)
      .eq("resource_id", record.resourceId)
      .eq("format", record.format)
      .eq("snapshot_hash", record.snapshotHash)
      .maybeSingle();
    raiseIfError(readError);
    if (!existing) throw new Error("Existing idempotent export record could not be read");
    return { record: fromExportRow(existing as Row), created: false };
  }

  async retryFailedExport(id: string, ownerId: string, updatedAt: string): Promise<boolean> {
    const content = this.authenticatedExportContent(ownerId);
    const { data: prior, error: readError } = await content
      .from("max_exports")
      .select("attempts")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "failed")
      .maybeSingle();
    raiseIfError(readError);
    if (!prior) return false;
    const attempts = Number((prior as Row).attempts);
    const { data, error } = await content
      .from("max_exports")
      .update({
        status: "pending",
        attempts: attempts + 1,
        updated_at: updatedAt,
        payload_base64: null,
        output_bytes: null,
        completed_at: null,
        failure_reason: null,
      })
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "failed")
      .eq("attempts", attempts)
      .lt("attempts", MAX_EXPORT_ATTEMPTS)
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async reclaimStaleExport(
    id: string,
    ownerId: string,
    staleBefore: string,
    updatedAt: string,
  ): Promise<boolean> {
    const content = this.authenticatedExportContent(ownerId);
    const { data: prior, error: readError } = await content
      .from("max_exports")
      .select("attempts")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "pending")
      .lte("updated_at", staleBefore)
      .maybeSingle();
    raiseIfError(readError);
    if (!prior) return false;
    const attempts = Number((prior as Row).attempts);
    const { data, error } = await content
      .from("max_exports")
      .update({ updated_at: updatedAt, attempts: attempts + 1 })
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "pending")
      .eq("attempts", attempts)
      .lt("attempts", MAX_EXPORT_ATTEMPTS)
      .lte("updated_at", staleBefore)
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async completeExport(
    id: string,
    ownerId: string,
    completion: ExportCompletion,
  ): Promise<boolean> {
    const content = this.authenticatedExportContent(ownerId);
    const { data, error } = await content
      .from("max_exports")
      .update({
        status: "completed",
        payload_base64: completion.payloadBase64,
        output_bytes: completion.outputBytes,
        completed_at: completion.completedAt,
        updated_at: completion.updatedAt,
        failure_reason: null,
      })
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async failExport(
    id: string,
    ownerId: string,
    updatedAt: string,
    failureReason: string,
  ): Promise<boolean> {
    const content = this.authenticatedExportContent(ownerId);
    const { data, error } = await content
      .from("max_exports")
      .update({
        status: "failed",
        updated_at: updatedAt,
        failure_reason: failureReason.slice(0, 80),
        payload_base64: null,
        output_bytes: null,
        completed_at: null,
      })
      .eq("id", id)
      .eq("owner_id", ownerId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async getExport(id: string, ownerId: string): Promise<ExportRecord | undefined> {
    const content = this.authenticatedExportContent(ownerId);
    const { data, error } = await content
      .from("max_exports")
      .select(EXPORT_COLUMNS)
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    raiseIfError(error);
    return data ? fromExportRow(data as Row) : undefined;
  }

  async listExports(ownerId: string, limit = 100): Promise<ExportRecord[]> {
    const content = this.authenticatedExportContent(ownerId);
    const { data, error } = await content
      .from("max_exports")
      .select(
        "id,owner_id,resource_type,resource_id,format,status,snapshot_hash,file_name,content_type,attempts,output_bytes,created_at,updated_at,completed_at",
      )
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, limit)));
    raiseIfError(error);
    return (data ?? []).map((row) => fromExportRow(row as Row));
  }

  async deleteExport(id: string, ownerId: string): Promise<boolean> {
    const content = this.authenticatedExportContent(ownerId);
    const { data, error } = await content
      .from("max_exports")
      .delete()
      .eq("id", id)
      .eq("owner_id", ownerId)
      .select("id")
      .maybeSingle();
    raiseIfError(error);
    return Boolean(data);
  }

  async listPosts(limit = 100): Promise<ResearchPost[]> {
    const { data, error } = await this.content
      .from("max_posts")
      .select("data")
      .order("published_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, limit)));
    raiseIfError(error);
    return (data ?? []).map((row) => row.data as ResearchPost);
  }

  async listPublishedPosts(limit = 100): Promise<ResearchPost[]> {
    const boundedLimit = Math.min(500, Math.max(1, limit));
    const { data: runRows, error: runError } = await this.content
      .from("max_autonomous_runs")
      .select("data")
      .eq("status", "PUBLISHED")
      .order("updated_at", { ascending: false })
      .limit(boundedLimit);
    raiseIfError(runError);

    const postIds = [
      ...new Set(
        (runRows ?? [])
          .map((row) => (row.data as { postId?: unknown } | null)?.postId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ].slice(0, boundedLimit);
    if (postIds.length === 0) return [];

    const { data, error } = await this.content
      .from("max_posts")
      .select("id,data")
      .in("id", postIds);
    raiseIfError(error);
    const postsById = new Map(
      (data ?? []).map((row) => [row.id as string, row.data as ResearchPost]),
    );
    return postIds.flatMap((id) => {
      const post = postsById.get(id);
      return post ? [post] : [];
    });
  }

  async saveFollowUp(followUp: ResearchFollowUp): Promise<void> {
    const identity = currentAuthenticatedUser();
    const values = {
      id: followUp.id,
      owner_id: identity?.userId ?? null,
      post_id: followUp.postId,
      status: followUp.status,
      updated_at: followUp.updatedAt,
      data: followUp,
    };
    if (identity) {
      const { data, error } = await this.content
        .from("max_post_followups")
        .update(values)
        .eq("id", followUp.id)
        .eq("owner_id", identity.userId)
        .select("id")
        .maybeSingle();
      raiseIfError(error);
      if (data) return;
      const { error: insertError } = await this.content.from("max_post_followups").insert(values);
      raiseIfError(insertError);
      return;
    }
    const { error } = await this.content
      .from("max_post_followups")
      .upsert(values, { onConflict: "id" });
    raiseIfError(error);
  }

  async getFollowUp(id: string): Promise<ResearchFollowUp | undefined> {
    const identity = currentAuthenticatedUser();
    let query = (this.userContent() ?? this.content)
      .from("max_post_followups")
      .select("data")
      .eq("id", id);
    if (identity) query = query.eq("owner_id", identity.userId);
    const { data, error } = await query.maybeSingle();
    raiseIfError(error);
    return data ? (data.data as ResearchFollowUp) : undefined;
  }

  async getDocument(url: string): Promise<StoredDocument | undefined> {
    const { data, error } = await this.research
      .from("max_knowledge_documents")
      .select("*")
      .eq("url", canonicalizeUrl(url))
      .maybeSingle();
    raiseIfError(error);
    return data ? fromDocumentRow(data) : undefined;
  }

  async saveDocument(
    document: Omit<StoredDocument, "contentHash" | "version" | "lastVerifiedAt">,
  ): Promise<void> {
    const normalized = { ...document, url: canonicalizeUrl(document.url) };
    const contentHash = createHash("sha256").update(normalized.content).digest("hex");
    const { error } = await this.research.rpc("max_save_knowledge_document", {
      p_document: normalized,
      p_content_hash: contentHash,
      p_verified_at: new Date().toISOString(),
    });
    raiseIfError(error);
  }

  async searchDocuments(query: string, maxAgeMs: number, limit = 10): Promise<StoredDocument[]> {
    const tokens =
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.slice(0, 8) ?? [];
    if (tokens.length === 0) return [];

    const { data, error } = await this.research.rpc("max_search_knowledge_documents", {
      p_query: tokens.join(" OR "),
      p_verified_after: new Date(Date.now() - maxAgeMs).toISOString(),
      p_limit: Math.min(30, Math.max(1, limit)),
    });
    raiseIfError(error);
    return ((data ?? []) as Row[]).map(fromDocumentRow);
  }

  close(): void {}
}

function shareMetadataFromRow(row: Row): ShareMetadata {
  const resourceType = String(row.resource_type) as ShareResourceType;
  if (resourceType !== "research_session" && resourceType !== "published_post") {
    throw new Error("Supabase returned an unsupported share resource type");
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    resourceType,
    resourceId: String(row.resource_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    ...(row.last_accessed_at ? { lastAccessedAt: String(row.last_accessed_at) } : {}),
  };
}

function resolvedShareFromRow(row: Row): ResolvedShareRecord {
  const tokenHash = String(row.token_hash);
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new Error("Supabase returned an invalid share token hash");
  }
  return { ...shareMetadataFromRow(row), tokenHash };
}
