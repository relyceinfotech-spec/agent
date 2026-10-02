import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { SupabaseStore } from "../supabase-store.js";

const secretKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || "";
if (!config.SUPABASE_URL || !secretKey) {
  throw new Error("API-restart smoke requires configured Supabase backend credentials");
}

const supabaseUrl = config.SUPABASE_URL;
const jobId = randomUUID();
const apiChildScript = fileURLToPath(new URL("./durable-job-api-child.ts", import.meta.url));
const store = new SupabaseStore(supabaseUrl, secretKey, undefined, config.SUPABASE_PUBLISHABLE_KEY);
const admin = createClient<any>(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
}).schema("research");
const children = new Set<ChildProcess>();

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an API port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function launch(port: number): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", apiChildScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAX_PERSISTENCE_PROVIDER: "supabase",
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.stderr?.on("data", (chunk: Buffer) =>
    process.stderr.write(chunk.toString("utf8").slice(0, 400)),
  );
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("API child exited before health became ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) return;
    } catch {
      // The server is still starting; retry only this read-only localhost health request.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for API child health");
}

async function stop(child: ChildProcess, force = false): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill(force ? "SIGKILL" : "SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(4000).then(() => {
      throw new Error("API child did not terminate");
    }),
  ]);
}

async function cleanup(): Promise<void> {
  for (const child of [...children]) {
    try {
      await stop(child, true);
    } catch {
      // Exact-ID database cleanup and read-back still run.
    }
  }
  const { error } = await admin.from("max_jobs").delete().eq("id", jobId);
  if (error) throw new Error("Could not delete API restart fixture");
  const { data, error: readError } = await admin.from("max_jobs").select("id").eq("id", jobId);
  if (readError) throw new Error("Could not verify API restart fixture cleanup");
  if ((data ?? []).length !== 0) throw new Error("API restart fixture remains after cleanup");
}

async function main() {
  const port = await reservePort();
  let primaryError: unknown;
  let cleanupError: unknown;
  let firstHealth = false;
  let restartedHealth = false;
  let persisted = false;

  try {
    const enqueued = await store.enqueueJob({
      id: jobId,
      kind: "research",
      ownerScope: "system",
      payload: { sessionId: jobId, question: "API restart persistence fixture", mode: "quick" },
      maxAttempts: 1,
    });
    if (!enqueued.created) throw new Error("Could not enqueue API restart fixture");

    const firstApi = launch(port);
    await waitForHealth(port, firstApi);
    firstHealth = true;
    await stop(firstApi, true);

    const restartedApi = launch(port);
    await waitForHealth(port, restartedApi);
    restartedHealth = true;
    const reopenedStore = new SupabaseStore(
      supabaseUrl,
      secretKey,
      undefined,
      config.SUPABASE_PUBLISHABLE_KEY,
    );
    const job = await reopenedStore.getJob(jobId);
    persisted = job?.status === "queued" && job.attempts === 0;
    await reopenedStore.close();
    if (!persisted) throw new Error("Queued job changed or disappeared across API restart");
    await stop(restartedApi);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
    await store.close();
  }

  if (primaryError || cleanupError) {
    const error = primaryError instanceof Error ? primaryError.message.slice(0, 300) : undefined;
    process.stderr.write(
      `${JSON.stringify({ passed: false, firstHealth, restartedHealth, persisted, error, cleanupPassed: !cleanupError })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ passed: true, firstHealth, restartedHealth, persisted, cleanupPassed: true })}\n`,
  );
}

await main();
