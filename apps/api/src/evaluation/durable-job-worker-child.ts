import { config } from "../config.js";
import { DurableQueueWorker } from "../jobs.js";
import { SupabaseStore } from "../supabase-store.js";

const mode = process.argv[2];
if (mode !== "hold" && mode !== "complete") {
  throw new Error("Worker diagnostic mode must be hold or complete");
}

const secretKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || "";
const store = new SupabaseStore(
  config.SUPABASE_URL ?? "",
  secretKey,
  undefined,
  config.SUPABASE_PUBLISHABLE_KEY,
);
const worker = new DurableQueueWorker(
  store,
  {
    research: async (_job, context) => {
      await context.reportProgress({ stage: mode === "hold" ? "crash-test-held" : "recovered" });
      if (mode === "hold") return new Promise<Record<string, never>>(() => undefined);
      return { recoveredBy: "replacement-worker", pid: process.pid };
    },
    post_agent: async () => {
      throw new Error("Unexpected Post Agent job in queue recovery diagnostic");
    },
  },
  {
    concurrency: 1,
    leaseSeconds: 5,
    pollIntervalMs: 100,
    heartbeatIntervalMs: 1000,
    workerIdPrefix: `durable-job-diagnostic-${mode}-${process.pid}`,
  },
);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await store.close();
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
worker.start();
process.stdout.write(`worker_started:${mode}\n`);
