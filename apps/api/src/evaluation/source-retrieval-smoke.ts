import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createToolRegistry } from "../agent/tools.js";
import { config } from "../config.js";
import { OpenRouterProvider } from "../llm.js";
import { SerperProvider } from "../search.js";
import { runWithResearchExecutionContext } from "../execution-context.js";

const startedAt = Date.now();
const deadlineAt = startedAt + 45_000;
const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(new Error("Retrieval smoke deadline exceeded")),
  45_000,
);
const reportPath = resolve("evaluation-results/source-retrieval-smoke-report.json");
const report: Record<string, unknown> = {
  startedAt: new Date(startedAt).toISOString(),
  queryLimit: 1,
  sourceLimit: 1,
  pageLimit: 1,
  sessionTimeoutMs: 45_000,
  openRouterCalled: false,
};
let stage = "serper_search";

try {
  if (!config.SERPER_API_KEY) throw new Error("SERPER_API_KEY is not configured");
  await runWithResearchExecutionContext({ deadlineAt, signal: controller.signal }, async () => {
    const query = "React official performance documentation";
    report.query = query;
    const serper = new SerperProvider();
    const results = await serper.search(query, controller.signal);
    report.searchAttempts = [
      {
        provider: "serper",
        query,
        status: results.length ? "success" : "empty",
        resultCount: results.length,
      },
    ];
    report.resultCount = results.length;
    if (results.length === 0) {
      report.status = "NO_SEARCH_RESULTS";
      return;
    }

    stage = "source_retrieval";
    const selected = results[0];
    report.source = { title: selected.title, url: selected.url };
    const registry = createToolRegistry(serper, new OpenRouterProvider());
    const retrieval = (await registry.execute("fetch_url", {
      url: selected.url,
      title: selected.title,
      snippet: selected.snippet,
      question: "React performance documentation",
      allowSnippetEvidence: false,
    })) as {
      url: string;
      document: { content: string; canonicalUrl?: string };
      retrievalMethod?: string;
      retrievalAttempts?: string[];
      retrievalMethodsSkipped?: string[];
      retrievalReasons?: string[];
      extractionStatus?: string;
      extractionConfidence?: number;
      retrievedContentLength?: number;
    };
    report.status = "COMPLETED";
    report.retrievalMethod = retrieval.retrievalMethod;
    report.fallbackMethodsAttempted = retrieval.retrievalAttempts;
    report.methodsSkipped = retrieval.retrievalMethodsSkipped;
    report.escalationReasons = retrieval.retrievalReasons;
    report.extractionStatus = retrieval.extractionStatus;
    report.canonicalUrl = retrieval.document.canonicalUrl;
    report.contentBytes = Buffer.byteLength(retrieval.document.content, "utf8");
    report.extractionConfidence = retrieval.extractionConfidence;
    report.retrievedUrl = retrieval.url;
  });
} catch (error) {
  report.status = "FAILED";
  report.failureStage = stage;
  report.failureReason = error instanceof Error ? error.message : String(error);
} finally {
  clearTimeout(timer);
  report.elapsedMs = Date.now() - startedAt;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "COMPLETED") process.exitCode = 1;
}
