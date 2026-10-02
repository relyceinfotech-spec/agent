import { createHash, randomUUID } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type {
  AutonomousRun,
  ResearchFollowUp,
  ResearchPost,
  TopicCandidate,
} from "../content-domain.js";
import type { Claim, ResearchSession, Source } from "../domain.js";
import { createSupabaseFetch, SupabaseStore } from "../supabase-store.js";

interface SmokeReport {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "PASSED" | "FAILED";
  failedAt?: string;
  tablesTouched: string[];
  relationshipsVerified: string[];
  cleanup: "complete" | "failed";
  cleanupVerified: boolean;
  updateVerified: boolean;
  httpResponses: Array<{
    path: string;
    status: number;
    acceptEncoding?: string;
    contentType?: string;
    contentEncoding?: string;
    bodyPrefixHex: string;
  }>;
  errors: string[];
}

function safeError(error: unknown): string {
  const details =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  let message =
    error instanceof Error
      ? error.message
      : typeof details?.message === "string"
        ? details.message
        : String(error);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(message)) {
    const context = message.includes(":") ? `${message.slice(0, message.indexOf(":"))}: ` : "";
    message = `${context}non-text upstream response body omitted`;
  }

  const context = [
    typeof details?.name === "string" ? `name ${details.name}` : undefined,
    typeof details?.status === "number" ? `HTTP ${details.status}` : undefined,
    typeof details?.code === "string" ? `code ${details.code}` : undefined,
    details?.cause &&
    typeof details.cause === "object" &&
    typeof (details.cause as Record<string, unknown>).name === "string"
      ? `cause ${(details.cause as Record<string, unknown>).name}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const safeMessage = message
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[REDACTED]")
    .slice(0, 500);
  return context ? `${safeMessage} (${context})` : safeMessage;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const url = config.SUPABASE_URL;
  const secretKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "Set SUPABASE_URL and backend-only SUPABASE_SECRET_KEY in the API environment to run this smoke test.",
    );
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const httpResponses: SmokeReport["httpResponses"] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (requestUrl.pathname.includes("/rest/v1/")) {
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      httpResponses.push({
        path: requestUrl.pathname,
        status: response.status,
        acceptEncoding: new Headers(init?.headers).get("accept-encoding") ?? undefined,
        contentType: response.headers.get("content-type") ?? undefined,
        contentEncoding: response.headers.get("content-encoding") ?? undefined,
        bodyPrefixHex: Array.from(bytes.slice(0, 16), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(" "),
      });
    }
    return response;
  };
  const ids = {
    session: randomUUID(),
    topic: randomUUID(),
    run: randomUUID(),
    post: randomUUID(),
    followUp: randomUUID(),
  };
  const documentUrl = `https://smoke.invalid/${ids.session}`;
  const tablesTouched = [
    "max_research_sessions",
    "max_knowledge_documents",
    "max_topics",
    "max_autonomous_runs",
    "max_posts",
    "max_post_sources",
    "max_post_claims",
    "max_post_followups",
  ];
  const report: SmokeReport = {
    startedAt,
    status: "FAILED",
    tablesTouched,
    relationshipsVerified: [],
    cleanup: "failed",
    cleanupVerified: false,
    updateVerified: false,
    httpResponses,
    errors: [],
  };
  let currentStage = "create session";
  const store = new SupabaseStore(url, secretKey);
  const client = createClient<any>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: createSupabaseFetch() },
  });
  const researchClient = client.schema("research");
  const contentClient = client.schema("content");

  const now = new Date().toISOString();
  const source: Source = {
    id: randomUUID(),
    title: "MAX persistence smoke source",
    url: documentUrl,
    snippet: "Temporary smoke-test provenance.",
    domain: "smoke.invalid",
    content: "Temporary MAX persistence test evidence.",
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
  const claim: Claim = {
    id: randomUUID(),
    text: "MAX test records preserve their source relationship.",
    sourceIds: [source.id],
    evidence: "Temporary smoke-test evidence.",
    confidence: 1,
    verification: { verdict: "supported", rationale: "Deterministic database smoke fixture." },
  };
  const session: ResearchSession = {
    id: ids.session,
    question: "MAX Supabase persistence integration smoke test",
    mode: "quick",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    sources: [source],
    claims: [claim],
    steps: [{ id: randomUUID(), status: "complete", label: "Smoke fixture", at: now }],
    answer: "Temporary persistence smoke-test answer.",
  };
  const topic: TopicCandidate = {
    id: ids.topic,
    title: "MAX persistence smoke topic",
    url: documentUrl,
    summary: "Temporary persistence smoke-test topic.",
    provider: "smoke-test",
    discoveredAt: now,
    score: 1,
    status: "SELECTED",
  };
  const run: AutonomousRun = {
    id: ids.run,
    trigger: "manual",
    status: "QUALITY_GATE",
    createdAt: now,
    updatedAt: now,
    topicId: topic.id,
    researchId: session.id,
    events: [{ at: now, stage: "smoke", status: "complete", detail: "Temporary fixture" }],
  };
  const post: ResearchPost = {
    id: ids.post,
    topicId: topic.id,
    researchId: session.id,
    title: topic.title,
    summary: topic.summary,
    whyItMatters: "Verifies transactional content persistence.",
    findings: [{ claimId: claim.id, text: claim.text, sourceIds: [source.id] }],
    caveats: [],
    sources: [source],
    claims: [claim],
    publishedAt: now,
    researchedAt: now,
    category: "smoke-test",
  };
  const publishedTopic = { ...topic, status: "PUBLISHED" as const };
  const publishedRun: AutonomousRun = {
    ...run,
    status: "PUBLISHED",
    postId: post.id,
    updatedAt: now,
  };
  const followUp: ResearchFollowUp = {
    id: ids.followUp,
    postId: post.id,
    question: "Verify the saved source relationship.",
    status: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    usedLiveResearch: false,
    sourceIds: [source.id],
    sources: [source],
    answer: "Temporary follow-up smoke result.",
  };
  const document = {
    url: documentUrl,
    title: source.title,
    content: "MAX Supabase persistence smoke searchable content.",
    rawHtml: "<main>MAX Supabase persistence smoke searchable content.</main>",
    fetchedAt: now,
    metadata: { provider: "smoke-test" },
  };

  try {
    await store.create(session);
    const updatedSession: ResearchSession = {
      ...session,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      answer: "Updated temporary persistence smoke-test answer.",
    };
    currentStage = "update research session";
    await store.update(updatedSession);
    currentStage = "verify updated session snapshot";
    deepStrictEqual(await store.get(ids.session), updatedSession);
    report.updateVerified = true;

    currentStage = "save knowledge document";
    await store.saveDocument(document);
    currentStage = "save topic";
    await store.saveTopic(topic);
    currentStage = "save autonomous run";
    await store.saveRun(run);
    currentStage = "publish post";
    await store.publishPost(post, publishedTopic, publishedRun);
    currentStage = "save follow-up";
    await store.saveFollowUp(followUp);

    currentStage = "verify session snapshot";
    deepStrictEqual(await store.get(ids.session), updatedSession);
    currentStage = "verify knowledge document read";
    const savedDocument = await store.getDocument(documentUrl);
    assert(savedDocument, "Document was not readable after save");
    assert(
      Date.parse(savedDocument.fetchedAt) === Date.parse(document.fetchedAt),
      "Document fetchedAt did not round-trip to the same instant",
    );
    assert(
      Number.isFinite(Date.parse(savedDocument.lastVerifiedAt)),
      "Document lastVerifiedAt did not round-trip as a valid timestamp",
    );
    const {
      fetchedAt: _savedFetchedAt,
      lastVerifiedAt: _lastVerifiedAt,
      ...savedDocumentData
    } = savedDocument;
    const { fetchedAt: _expectedFetchedAt, ...expectedDocumentData } = document;
    deepStrictEqual(savedDocumentData, {
      ...expectedDocumentData,
      publishedAt: undefined,
      contentHash: createHash("sha256").update(document.content).digest("hex"),
      version: 1,
    });
    currentStage = "verify full-text search";
    assert(
      (await store.searchDocuments("persistence searchable content", 60_000)).some(
        (item) => item.url === documentUrl,
      ),
      "Full-text document search missed the fixture",
    );
    currentStage = "verify topic read";
    deepStrictEqual(await store.getTopic(ids.topic), publishedTopic);
    currentStage = "verify run relationship";
    deepStrictEqual(await store.getRun(ids.run), publishedRun);
    currentStage = "verify post read";
    deepStrictEqual(await store.getPost(ids.post), post);
    currentStage = "verify follow-up read";
    deepStrictEqual(await store.getFollowUp(ids.followUp), followUp);
    assert(post.researchId === ids.session, "Post→research session relationship was not preserved");
    assert(publishedRun.postId === post.id, "Run→post relationship was not preserved");

    currentStage = "verify post references";
    const [sourceRows, claimRows] = await Promise.all([
      contentClient.from("max_post_sources").select("source_id,url").eq("post_id", ids.post),
      contentClient.from("max_post_claims").select("claim_id").eq("post_id", ids.post),
    ]);
    if (sourceRows.error) throw sourceRows.error;
    if (claimRows.error) throw claimRows.error;
    deepStrictEqual(sourceRows.data, [{ source_id: source.id, url: source.url }]);
    deepStrictEqual(claimRows.data, [{ claim_id: claim.id }]);
    report.relationshipsVerified = [
      "post→topic",
      "post→source reference",
      "post→claim reference",
      "follow-up→post",
      "run→published post",
    ];
    report.status = "PASSED";
  } catch (error) {
    report.failedAt = currentStage;
    report.errors.push(safeError(error));
  } finally {
    const cleanupOperations = [
      () => contentClient.from("max_post_followups").delete().eq("id", ids.followUp),
      () => contentClient.from("max_post_sources").delete().eq("post_id", ids.post),
      () => contentClient.from("max_post_claims").delete().eq("post_id", ids.post),
      () => contentClient.from("max_posts").delete().eq("id", ids.post),
      () => contentClient.from("max_autonomous_runs").delete().eq("id", ids.run),
      () => contentClient.from("max_topics").delete().eq("id", ids.topic),
      () => researchClient.from("max_knowledge_documents").delete().eq("url", documentUrl),
      () => researchClient.from("max_research_sessions").delete().eq("id", ids.session),
    ];
    const cleanupErrors: string[] = [];
    for (const cleanup of cleanupOperations) {
      try {
        const result = await cleanup();
        if (result.error) cleanupErrors.push(safeError(result.error));
      } catch (error) {
        cleanupErrors.push(safeError(error));
      }
    }
    if (cleanupErrors.length === 0) {
      try {
        const [
          remainingSession,
          remainingDocument,
          remainingTopic,
          remainingRun,
          remainingPost,
          remainingFollowUp,
          remainingSources,
          remainingClaims,
        ] = await Promise.all([
          store.get(ids.session),
          store.getDocument(documentUrl),
          store.getTopic(ids.topic),
          store.getRun(ids.run),
          store.getPost(ids.post),
          store.getFollowUp(ids.followUp),
          contentClient.from("max_post_sources").select("source_id").eq("post_id", ids.post),
          contentClient.from("max_post_claims").select("claim_id").eq("post_id", ids.post),
        ]);
        if (remainingSources.error) throw remainingSources.error;
        if (remainingClaims.error) throw remainingClaims.error;
        report.cleanupVerified =
          remainingSession === undefined &&
          remainingDocument === undefined &&
          remainingTopic === undefined &&
          remainingRun === undefined &&
          remainingPost === undefined &&
          remainingFollowUp === undefined &&
          remainingSources.data?.length === 0 &&
          remainingClaims.data?.length === 0;
        if (!report.cleanupVerified) {
          cleanupErrors.push("One or more temporary smoke records remained after cleanup.");
        }
      } catch (error) {
        cleanupErrors.push(`Cleanup verification failed: ${safeError(error)}`);
      }
    }

    if (cleanupErrors.length === 0) report.cleanup = "complete";
    else report.errors.push(...cleanupErrors);

    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    const reportDirectory = join(process.cwd(), "evaluation-results");
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(
      join(reportDirectory, "supabase-persistence-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASSED" || report.cleanup !== "complete") process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
