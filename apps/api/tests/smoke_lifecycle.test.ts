import { describe, expect, it, vi } from "vitest";
import {
  addSmokeCleanupFailure,
  buildSmokeDiagnosticReport,
  createSmokeLifecycleDiagnostics,
  runSmokeLifecycle,
  safeSmokeError,
} from "../src/evaluation/smoke-lifecycle.js";

describe("bounded smoke lifecycle diagnostics", () => {
  it("runs setup, one execution, and cleanup on success", async () => {
    const calls: string[] = [];
    const outcome = await runSmokeLifecycle({
      classifyFailure: () => "APPLICATION_FAILURE",
      setup: async (diagnostics) => {
        calls.push("setup");
        diagnostics.stage = "listen_local_api";
        diagnostics.serverStartupCompleted = true;
        return { ready: true };
      },
      execute: async (_context, diagnostics) => {
        calls.push("execute");
        diagnostics.stage = "terminal_poll";
        diagnostics.researchSubmissionAttempted = true;
        diagnostics.researchJobAccepted = true;
        return "completed";
      },
      cleanup: async (_context, diagnostics) => {
        calls.push("cleanup");
        diagnostics.cleanup.apiServer = "completed";
      },
    });

    expect(calls).toEqual(["setup", "execute", "cleanup"]);
    expect(outcome.result).toBe("completed");
    expect(outcome.failure).toBeUndefined();
    expect(outcome.diagnostics.serverStartupCompleted).toBe(true);
    expect(outcome.diagnostics.researchJobAccepted).toBe(true);
  });

  it("reports a startup exception with stage, safe type, and repository-relative location", async () => {
    const error = new SyntaxError(
      'Transform failed at D:\\reserch maxx\\apps\\api\\src\\research-answer.ts:294:2: Unexpected "}"',
    );
    const outcome = await runSmokeLifecycle({
      classifyFailure: () => "APPLICATION_FAILURE",
      setup: async (diagnostics) => {
        diagnostics.stage = "import_server_module";
        throw error;
      },
      execute: async () => "must-not-run",
      cleanup: async (_context, diagnostics) => {
        diagnostics.cleanup.moduleApp = "not_required";
      },
    });

    expect(outcome.failure).toMatchObject({
      category: "APPLICATION_FAILURE",
      name: "SyntaxError",
      stage: "import_server_module",
      stackLocation: "apps/api/src/research-answer.ts:294:2",
    });
    expect(outcome.failure?.message).toContain("Unexpected");
    expect(outcome.diagnostics.serverStartupCompleted).toBe(false);
  });

  it("does not enqueue or invoke providers after startup failure and still cleans partial setup", async () => {
    const enqueueJob = vi.fn();
    const serperCall = vi.fn();
    const openRouterCall = vi.fn();
    const closePartialStore = vi.fn();
    const execute = vi.fn(async () => {
      enqueueJob();
      serperCall();
      openRouterCall();
      return "unexpected";
    });

    const outcome = await runSmokeLifecycle({
      classifyFailure: () => "APPLICATION_FAILURE",
      setup: async (diagnostics) => {
        diagnostics.stage = "create_fastify_server";
        throw new Error("server creation failed");
      },
      execute,
      cleanup: async (_context, diagnostics) => {
        diagnostics.cleanup.sessionStore = "attempted";
        closePartialStore();
        diagnostics.cleanup.sessionStore = "completed";
      },
    });

    expect(outcome.failure?.stage).toBe("create_fastify_server");
    expect(execute).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(serperCall).not.toHaveBeenCalled();
    expect(openRouterCall).not.toHaveBeenCalled();
    expect(closePartialStore).toHaveBeenCalledOnce();
    expect(outcome.diagnostics.researchSubmissionAttempted).toBe(false);
    expect(outcome.diagnostics.providerCallCountersAvailable).toBe(false);
    expect(outcome.diagnostics.cleanup.sessionStore).toBe("completed");
  });

  it("records rejected execute promises and always runs cleanup", async () => {
    const cleanup = vi.fn(async () => undefined);
    const outcome = await runSmokeLifecycle({
      classifyFailure: () => "POLLING_DEADLINE",
      setup: async (diagnostics) => {
        diagnostics.serverStartupCompleted = true;
        return { started: true };
      },
      execute: async (_context, diagnostics) => {
        diagnostics.stage = "terminal_poll";
        return Promise.reject(new Error("bounded timeout while polling"));
      },
      cleanup,
    });

    expect(outcome.failure).toMatchObject({
      category: "POLLING_DEADLINE",
      name: "Error",
      stage: "terminal_poll",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves the primary failure and reports cleanup failures separately", async () => {
    const outcome = await runSmokeLifecycle({
      classifyFailure: () => "APPLICATION_FAILURE",
      setup: async (diagnostics) => {
        diagnostics.stage = "start_local_worker";
        throw new Error("worker start failed");
      },
      execute: async () => undefined,
      cleanup: async (_context, diagnostics) => {
        diagnostics.cleanup.moduleApp = "failed";
        addSmokeCleanupFailure(diagnostics, "moduleApp", new Error("module close failed"));
      },
    });

    expect(outcome.failure).toMatchObject({
      category: "APPLICATION_FAILURE",
      stage: "start_local_worker",
      cleanupFailure: { stage: "cleanup:moduleApp", message: "module close failed" },
    });
  });

  it("redacts credentials and limits stack data to an application source location", () => {
    const error = new Error(
      "Bearer access-secret https://service.test/?token=private-value&api_key=private-key " +
        "D:\\reserch maxx\\apps\\api\\src\\server.ts:123:9",
    );
    const summary = safeSmokeError(error);

    expect(summary.message).not.toContain("access-secret");
    expect(summary.message).not.toContain("private-value");
    expect(summary.message).not.toContain("private-key");
    expect(summary.message).not.toContain("D:\\reserch maxx");
    expect(summary.message).toContain("[local-path]");
    expect(summary.stackLocation).toBe("apps/api/src/server.ts:123:9");
    expect(summary.stackLocation).not.toContain("D:\\reserch maxx");
  });

  it("starts with counters unavailable instead of implying zero provider calls", () => {
    const diagnostics = createSmokeLifecycleDiagnostics();
    expect(diagnostics.providerCallCountersAvailable).toBe(false);
    expect(diagnostics.serperCalls).toBeUndefined();
    expect(diagnostics.openRouterCalls).toBeUndefined();
  });

  it("generates an explicit startup-failure report without inventing provider counts", () => {
    const diagnostics = createSmokeLifecycleDiagnostics();
    diagnostics.stage = "import_server_module";
    diagnostics.cleanup.moduleApp = "not_required";
    const failure = {
      category: "APPLICATION_FAILURE",
      name: "SyntaxError",
      message: "Unexpected token at [local-path]",
      stage: diagnostics.stage,
      stackLocation: "apps/api/src/server.ts:10:4",
    };

    const report = buildSmokeDiagnosticReport(diagnostics, failure);

    expect(report).toMatchObject({
      failureStage: "import_server_module",
      serverStartupCompleted: false,
      researchSubmissionAttempted: false,
      researchJobAccepted: false,
      providerCallCountersAvailable: false,
      providerUsage: { status: "unknown" },
      cleanup: { moduleApp: "not_required" },
    });
  });
});
