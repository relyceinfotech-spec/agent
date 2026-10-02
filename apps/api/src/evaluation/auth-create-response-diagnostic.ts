import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { createSupabaseAuthFetch } from "../supabase-auth-fetch.js";
import { findTemporaryAuthUserIds } from "./auth-smoke-cleanup.js";
import {
  classifyAuthSmokeFailure,
  createAuthSmokeFetch,
  safeAuthSmokeError,
  type AuthSmokeResponseCapture,
  type AuthSmokeTransportEvent,
} from "./auth-smoke-transport.js";

interface DiagnosticReport {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  projectRef: string;
  testEmail: string;
  runtime: {
    node: string;
    fetchName: string;
    fastifyStarted: boolean;
    fastifyHealthStatus?: number;
    globalFetchReplaced: false;
    proxyEnvironmentConfigured: {
      http: boolean;
      https: boolean;
      all: boolean;
    };
    perRequestTimeoutMs: number;
  };
  remoteCreateAttempts: number;
  nativeFetchResponse?: Omit<AuthSmokeTransportEvent, "method" | "path" | "elapsedMs"> & {
    method: string;
    path: string;
    elapsedMs: number;
  };
  supabaseJsOutcome?: {
    hasUserId: boolean;
    error?: ReturnType<typeof safeAuthSmokeError>;
    failureClassification?: string;
  };
  localSdkReplay?: {
    networkRequests: 0;
    hasUserId: boolean;
    error?: ReturnType<typeof safeAuthSmokeError>;
    failureClassification?: string;
  };
  cleanup: {
    matchingUsersBeforeDelete?: number;
    deleteStatus?: number;
    matchingUsersAfterDelete?: number;
    verified: boolean;
    error?: string;
  };
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    throw new Error("The response diagnostic requires the Signova URL and server-only key.");
  }

  const supabaseUrl = config.SUPABASE_URL;
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0] ?? "unknown";
  if (projectRef !== "atntvlkwchxavnjkthjv") {
    throw new Error("The response diagnostic is restricted to the configured Signova project.");
  }

  const started = Date.now();
  const deadline = started + 60_000;
  const startedAt = new Date(started).toISOString();
  const email = `max-auth-response-${randomUUID()}@example.com`;
  const password = `${randomUUID()}!aA9`;
  const events: AuthSmokeTransportEvent[] = [];
  let capturedResponse: AuthSmokeResponseCapture | undefined;
  let remoteCreateAttempts = 0;
  let sdkResult:
    | Awaited<ReturnType<ReturnType<typeof createClient<any>>["auth"]["admin"]["createUser"]>>
    | undefined;
  let sdkThrown: unknown;
  let knownUserId: string | undefined;

  const report: DiagnosticReport = {
    startedAt,
    projectRef,
    testEmail: email,
    runtime: {
      node: process.versions.node,
      fetchName: globalThis.fetch.name || "anonymous",
      fastifyStarted: false,
      globalFetchReplaced: false,
      proxyEnvironmentConfigured: {
        http: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
        https: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
        all: Boolean(process.env.ALL_PROXY || process.env.all_proxy),
      },
      perRequestTimeoutMs: 25_000,
    },
    remoteCreateAttempts: 0,
    cleanup: { verified: false },
  };

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const tracedFetch = createAuthSmokeFetch({
    fetchImpl: nativeFetch,
    deadline: () => deadline,
    perRequestTimeoutMs: report.runtime.perRequestTimeoutMs,
    onEvent: (event) => events.push(event),
    onAdminCreateResponse: (response) => {
      capturedResponse = {
        status: response.status,
        contentType: response.contentType,
        body: response.body.slice(),
      };
    },
  });
  const noDuplicateCreateFetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();

    if (method === "POST" && url.pathname === "/auth/v1/admin/users") {
      remoteCreateAttempts += 1;
      if (remoteCreateAttempts > 1) {
        return Promise.reject(new Error("Diagnostic blocked a second remote user creation"));
      }
    }

    return tracedFetch(input, init);
  };

  const client = createClient<any>(supabaseUrl, config.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: noDuplicateCreateFetch },
  });

  try {
    const healthTimeout = AbortSignal.timeout(2_000);
    const healthResponse = await nativeFetch(`http://127.0.0.1:${config.PORT}/health`, {
      signal: healthTimeout,
    });
    report.runtime.fastifyHealthStatus = healthResponse.status;
    const healthPayload = healthResponse.ok
      ? ((await healthResponse.json()) as { service?: unknown; status?: unknown })
      : undefined;
    report.runtime.fastifyStarted =
      healthPayload?.service === "research-agent-max-api" && healthPayload.status === "ok";
    if (!report.runtime.fastifyStarted) {
      throw new Error("MAX Fastify health preflight failed; no temporary user was created");
    }

    try {
      sdkResult = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      knownUserId = sdkResult.data?.user?.id ?? undefined;
      if (sdkResult.error) sdkThrown = sdkResult.error;
    } catch (error) {
      sdkThrown = error;
    }

    report.remoteCreateAttempts = remoteCreateAttempts;
    const createEvent = events.find(
      (event) => event.method === "POST" && event.path === "/auth/v1/admin/users",
    );
    report.nativeFetchResponse = createEvent;
    report.supabaseJsOutcome = {
      hasUserId: Boolean(knownUserId),
      error: sdkThrown
        ? safeAuthSmokeError(sdkThrown, [email, password, config.SUPABASE_SECRET_KEY])
        : undefined,
      failureClassification: sdkThrown
        ? classifyAuthSmokeFailure(sdkThrown, createEvent)
        : undefined,
    };

    if (capturedResponse) {
      let replayFetchCalls = 0;
      const replayClient = createClient<any>(supabaseUrl, config.SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        global: {
          fetch: async () => {
            replayFetchCalls += 1;
            return new Response(capturedResponse!.body.slice(), {
              status: capturedResponse!.status,
              headers: capturedResponse!.contentType
                ? { "content-type": capturedResponse!.contentType }
                : undefined,
            });
          },
        },
      });

      try {
        const replayResult = await replayClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        const replayError = replayResult.error;
        report.localSdkReplay = {
          networkRequests: 0,
          hasUserId: Boolean(replayResult.data?.user?.id),
          error: replayError
            ? safeAuthSmokeError(replayError, [email, password, config.SUPABASE_SECRET_KEY])
            : undefined,
          failureClassification: replayError
            ? classifyAuthSmokeFailure(replayError, createEvent)
            : undefined,
        };
      } catch (error) {
        report.localSdkReplay = {
          networkRequests: 0,
          hasUserId: false,
          error: safeAuthSmokeError(error, [email, password, config.SUPABASE_SECRET_KEY]),
          failureClassification: classifyAuthSmokeFailure(error, createEvent),
        };
      }

      if (replayFetchCalls !== 1) {
        report.cleanup.error = "Local SDK replay did not make exactly one mocked fetch call";
      }
    }
  } finally {
    try {
      const lookupFetch: typeof fetch = (input, init) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return Promise.reject(
            new DOMException("Diagnostic time budget exhausted", "TimeoutError"),
          );
        }
        const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const timeout = AbortSignal.timeout(Math.min(10_000, remainingMs));
        const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
        return createSupabaseAuthFetch(nativeFetch)(input, { ...init, signal });
      };
      const targetEmails = new Set([email.toLowerCase()]);
      const matches = await findTemporaryAuthUserIds(
        supabaseUrl,
        config.SUPABASE_SECRET_KEY,
        targetEmails,
        lookupFetch,
      );
      report.cleanup.matchingUsersBeforeDelete = matches.length;

      if (matches.length > 1) {
        throw new Error("Exact-email reconciliation found more than one temporary user");
      }

      const userIdToDelete = matches[0] ?? knownUserId;
      if (userIdToDelete) {
        const deleteResponse = await lookupFetch(
          new URL(`/auth/v1/admin/users/${encodeURIComponent(userIdToDelete)}`, supabaseUrl),
          {
            method: "DELETE",
            headers: {
              apikey: config.SUPABASE_SECRET_KEY,
              authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`,
            },
          },
        );
        await deleteResponse.arrayBuffer();
        report.cleanup.deleteStatus = deleteResponse.status;
        if (!deleteResponse.ok)
          throw new Error(`Exact temporary-user delete returned HTTP ${deleteResponse.status}`);
      }

      const remaining = await findTemporaryAuthUserIds(
        supabaseUrl,
        config.SUPABASE_SECRET_KEY,
        targetEmails,
        lookupFetch,
      );
      report.cleanup.matchingUsersAfterDelete = remaining.length;
      report.cleanup.verified = remaining.length === 0;
      if (!report.cleanup.verified)
        report.cleanup.error = "Exact temporary user still exists after cleanup";
    } catch (error) {
      report.cleanup.error = safeAuthSmokeError(error, [
        email,
        password,
        config.SUPABASE_SECRET_KEY,
      ]).message;
    }

    report.remoteCreateAttempts = remoteCreateAttempts;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    capturedResponse?.body.fill(0);

    const outputDirectory = join(process.cwd(), "evaluation-results");
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      join(outputDirectory, "auth-create-response-diagnostic.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  const { testEmail: _testEmail, ...safeReport } = report;
  console.log(JSON.stringify(safeReport, null, 2));
  if (remoteCreateAttempts !== 1 || !report.nativeFetchResponse || !report.cleanup.verified) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: safeAuthSmokeError(error) }));
  process.exitCode = 1;
});
