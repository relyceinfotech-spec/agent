import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { SupabaseStore } from "../supabase-store.js";

const serviceKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || "";
if (!config.SUPABASE_URL || !serviceKey) {
  throw new Error("Durable job live smoke requires configured Supabase backend credentials");
}
if (!config.SERPER_API_KEY || !config.OPENROUTER_API_KEY) {
  throw new Error("One bounded research run requires configured Serper and OpenRouter credentials");
}

const supabaseUrl = config.SUPABASE_URL;
const recoveryOnly = process.argv.includes("--recovery-only");
const store = new SupabaseStore(
  supabaseUrl,
  serviceKey,
  undefined,
  config.SUPABASE_PUBLISHABLE_KEY,
);
const admin = createClient<any>(config.SUPABASE_URL, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
}).schema("research");
const workerChild = fileURLToPath(new URL("./durable-job-worker-child.ts", import.meta.url));
const productionWorker = fileURLToPath(new URL("../worker.ts", import.meta.url));
const startedAt = Date.now();
const recoveryId = randomUUID();
const researchId = randomUUID();
const temporaryIds = [recoveryId, researchId];
const children = new Set<ChildProcess>();
let stage = "initialization";

function safeError(error: unknown) {
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  const message = String(value?.message ?? "Unknown failure")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sb_secret_|sk-or-v1-)[A-Za-z0-9_-]+/gi, "[redacted]")
    .slice(0, 400);
  return {
    name: String(value?.name ?? "Error"),
    code: typeof value?.code === "string" ? value.code.slice(0, 80) : undefined,
    message,
  };
}

function launch(script: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (/worker_started:/.test(text)) return;
    process.stderr.write(text.slice(0, 400));
  });
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getJob(id: string) {
  const job = await store.getJob(id);
  if (!job) throw new Error(`Durable job ${id} disappeared before verification`);
  return job;
}

async function forceStop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3000).then(() => {
      throw new Error("Diagnostic worker process did not terminate after forced stop");
    }),
  ]);
}

async function cleanup() {
  for (const child of [...children]) {
    try {
      await forceStop(child);
    } catch {
      // Cleanup below remains exact-ID scoped even when a child already exited.
    }
  }
  for (const id of temporaryIds) {
    const { error } = await admin.from("max_jobs").delete().eq("id", id);
    if (error) throw new Error(`Job cleanup failed: ${safeError(error).code ?? "unknown"}`);
  }
  const { data, error } = await admin.from("max_jobs").select("id").in("id", temporaryIds);
  if (error) throw new Error("Could not verify temporary durable job cleanup");
  if ((data ?? []).length !== 0) throw new Error("Temporary durable jobs remain after cleanup");
  const { error: sessionDeleteError } = await admin
    .from("max_research_sessions")
    .delete()
    .eq("id", researchId);
  if (sessionDeleteError) throw new Error("Could not clean up temporary research session");
  const { data: sessions, error: sessionReadError } = await admin
    .from("max_research_sessions")
    .select("id")
    .eq("id", researchId);
  if (sessionReadError) throw new Error("Could not verify temporary research-session cleanup");
  if ((sessions ?? []).length !== 0)
    throw new Error("Temporary research session remains after cleanup");
  process.stdout.write(
    `${JSON.stringify({ cleanup: { temporaryJobs: 0, temporarySessions: 0 } })}\n`,
  );
}

async function main() {
  let recoveryWorker: ChildProcess | undefined;
  let replacementWorker: ChildProcess | undefined;
  let researchWorker: ChildProcess | undefined;
  let recoveryPassed = false;
  let researchPassed = false;
  let recoverySummary: Record<string, unknown> | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    stage = "read-only REST preflight";
    await store.getJob(randomUUID());
    const { error: tablePreflightError } = await admin
      .from("max_jobs")
      .select("id")
      .eq("id", recoveryId)
      .maybeSingle();
    if (tablePreflightError) throw tablePreflightError;

    stage = "enqueue crash-recovery fixture";
    const recovery = await store.enqueueJob({
      id: recoveryId,
      kind: "research",
      ownerScope: "system",
      payload: {
        sessionId: recoveryId,
        question: "durable worker recovery diagnostic",
        mode: "quick",
      },
      maxAttempts: 3,
    });
    if (!recovery.created || recovery.job?.status !== "queued") {
      throw new Error("Supabase durable enqueue did not create the recovery fixture");
    }

    stage = "first worker lease";
    recoveryWorker = launch(workerChild, ["hold"]);
    await waitFor(
      "first worker lease and persisted progress",
      async () => {
        const job = await getJob(recoveryId);
        return (
          job.status === "running" && job.attempts === 1 && job.progress.stage === "crash-test-held"
        );
      },
      8000,
    );
    const firstLease = await getJob(recoveryId);
    stage = "forced worker termination and expired lease";
    await forceStop(recoveryWorker);
    await delay(6500);

    stage = "replacement worker lease recovery";
    replacementWorker = launch(workerChild, ["complete"]);
    await waitFor(
      "lease recovery and replacement worker completion",
      async () => {
        const job = await getJob(recoveryId);
        return job.status === "completed";
      },
      15000,
    );
    const recovered = await getJob(recoveryId);
    const recoveryChecks = {
      firstLeaseGeneration: firstLease.leaseGeneration === 1,
      completedByReplacement: recovered.status === "completed",
      attemptIncremented: recovered.attempts === 2,
      leaseGenerationIncremented: recovered.leaseGeneration === 2,
      terminalProgressRecorded:
        recovered.progress.stage === "terminal_transition" &&
        recovered.progress.terminalOutcome === "completed",
      replacementResultPersisted: recovered.result?.recoveredBy === "replacement-worker",
    };
    recoveryPassed = Object.values(recoveryChecks).every(Boolean);
    process.stdout.write(
      `${JSON.stringify({
        recovery: {
          passed: recoveryPassed,
          checks: recoveryChecks,
          status: recovered.status,
          attempts: recovered.attempts,
          leaseGenerations: recovered.leaseGeneration,
          progressStage: recovered.progress.stage,
          terminalOutcome: recovered.progress.terminalOutcome,
          recoveredBy: recovered.result?.recoveredBy,
        },
      })}\n`,
    );
    if (!recoveryPassed) throw new Error("Replacement worker did not recover the expired lease");
    replacementWorker.kill("SIGTERM");

    recoverySummary = {
      checks: recoveryChecks,
      status: recovered.status,
      attempts: recovered.attempts,
      leaseGenerations: recovered.leaseGeneration,
      progressStage: recovered.progress.stage,
      terminalOutcome: recovered.progress.terminalOutcome,
      recoveredBy: recovered.result?.recoveredBy,
    };

    if (!recoveryOnly) {
      stage = "enqueue bounded live research";
      const research = await store.enqueueJob({
        id: researchId,
        kind: "research",
        ownerScope: "system",
        payload: {
          sessionId: researchId,
          question: "What is the latest stable React version?",
          mode: "quick",
        },
        maxAttempts: 1,
      });
      if (!research.created || research.job?.id !== researchId) {
        throw new Error("Could not enqueue bounded live research fixture");
      }

      stage = "persisted job read after store restart";
      await store.close();
      const reopenedStore = new SupabaseStore(
        supabaseUrl,
        serviceKey,
        undefined,
        config.SUPABASE_PUBLISHABLE_KEY,
      );
      const persistedAcrossReconnect = await reopenedStore.getJob(researchId);
      if (!persistedAcrossReconnect || persistedAcrossReconnect.status !== "queued") {
        await reopenedStore.close();
        throw new Error("Queued job did not persist across API/store restart boundary");
      }
      await reopenedStore.close();

      stage = "production worker live research";
      researchWorker = launch(productionWorker, [], {
        MAX_PERSISTENCE_PROVIDER: "supabase",
        MAX_JOB_LEASE_SECONDS: "10",
        MAX_JOB_POLL_INTERVAL_MS: "100",
        MAX_RESEARCH_STEPS: "4",
        MAX_SEARCH_QUERIES: "1",
        MAX_SOURCES: "2",
        MAX_PAGES: "1",
        MAX_RESEARCH_TIME_MS: "60000",
        MAX_MODEL_DECISIONS: "2",
      });

      const liveStore = new SupabaseStore(
        supabaseUrl,
        serviceKey,
        undefined,
        config.SUPABASE_PUBLISHABLE_KEY,
      );
      await waitFor(
        "bounded live research terminal status",
        async () => {
          const job = await liveStore.getJob(researchId);
          return Boolean(job && ["completed", "failed"].includes(job.status));
        },
        90000,
      );
      const liveJob = await liveStore.getJob(researchId);
      const liveSession = await liveStore.get(researchId);
      researchPassed =
        liveJob?.status === "completed" &&
        liveSession?.status === "COMPLETED" &&
        liveJob.attempts === 1 &&
        liveJob.progress.stage !== undefined;
      process.stdout.write(
        `${JSON.stringify({
          recovery: {
            passed: recoveryPassed,
            attempts: recovered.attempts,
            leaseGenerations: recovered.leaseGeneration,
            persistedProgress: recovered.progress.stage,
          },
          liveResearch: {
            passed: researchPassed,
            jobStatus: liveJob?.status,
            sessionStatus: liveSession?.status,
            externalSearchRequests:
              liveSession?.searchAttempts?.filter(
                (attempt) => attempt.provider !== "internal-knowledge",
              ).length ?? 0,
            internalKnowledgeLookups:
              liveSession?.searchAttempts?.filter(
                (attempt) => attempt.provider === "internal-knowledge",
              ).length ?? 0,
            fetches: liveSession?.sources.filter((source) => source.content).length ?? 0,
            attempts: liveJob?.attempts,
            progressStage: liveJob?.progress.stage,
            elapsedMs: Date.now() - startedAt,
          },
        })}\n`,
      );
      await liveStore.close();
      if (!researchPassed) throw new Error("Bounded live research did not complete successfully");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (researchWorker?.exitCode === null) researchWorker.kill("SIGTERM");
      if (replacementWorker?.exitCode === null) replacementWorker.kill("SIGTERM");
      await cleanup();
    } catch (error) {
      cleanupError = error;
    } finally {
      await store.close();
    }
  }

  if (primaryError || cleanupError) {
    process.stderr.write(
      `${JSON.stringify({
        stage,
        primaryFailure: primaryError ? safeError(primaryError) : undefined,
        cleanupFailure: cleanupError ? safeError(cleanupError) : undefined,
        fixtureIds: temporaryIds,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (recoveryOnly) {
    process.stdout.write(
      `${JSON.stringify({ status: "RECOVERY_VERIFIED", recovery: recoverySummary, cleanupVerified: true })}\n`,
    );
  }
}

await main();
