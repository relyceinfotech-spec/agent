import { config } from "./config.js";
import { safeErrorSummary } from "./evaluation/safe-error-summary.js";
import type { SearchAttempt } from "./search.js";

const categories = [
  "MISSING_CREDENTIALS",
  "INVALID_CREDENTIALS",
  "CREDITS_EXHAUSTED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_BLOCKED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "CAPTCHA",
  "UNSUPPORTED",
  "NETWORK_ERROR",
  "SEARCH_PROVIDER_FAILURE",
  "MALFORMED_RESPONSE",
] as const;
const networkCodes =
  /^(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/;

export function safeSearchMessage(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  let message = error instanceof Error ? error.message : "Unknown search provider failure";
  for (const secret of [
    ...secrets,
    config.SERPER_API_KEY,
    config.OPENROUTER_API_KEY,
    config.SUPABASE_SERVICE_ROLE_KEY,
  ]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  message = message
    .replace(
      /\b(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)["']?\s*[:=]\s*(?:["'][^"']*["']|[^\r\n,;}]+)/gi,
      "[redacted-header]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/(?:response body|response payload|body)\s*[:=][\s\S]*$/i, "provider body omitted");
  return safeErrorSummary(new Error(message)).message ?? "Search provider failure";
}

export function searchFailureDetails(
  error: unknown,
): Pick<SearchAttempt, "errorCode" | "httpStatus" | "failureType" | "transportCode"> {
  const value = error as
    | {
        code?: unknown;
        httpStatus?: unknown;
        cause?: { code?: unknown };
        name?: string;
        message?: string;
      }
    | undefined;
  const message = value?.message ?? "";
  const status =
    typeof value?.httpStatus === "number"
      ? value.httpStatus
      : Number(message.match(/(?:HTTP(?: status)?|status)\s+(\d{3})\b/i)?.[1]);
  const httpStatus =
    Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  let transportCode: string | undefined;
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const cause = current as { code?: unknown; cause?: unknown };
    if (typeof cause.code === "string" && networkCodes.test(cause.code)) {
      transportCode = cause.code;
      break;
    }
    current = cause.cause;
  }
  let errorCode: NonNullable<SearchAttempt["errorCode"]> = "SEARCH_PROVIDER_FAILURE";
  if (typeof value?.code === "string" && (categories as readonly string[]).includes(value.code))
    errorCode = value.code as NonNullable<SearchAttempt["errorCode"]>;
  else if (httpStatus)
    errorCode =
      httpStatus === 401 || httpStatus === 403
        ? "INVALID_CREDENTIALS"
        : httpStatus === 402
          ? "CREDITS_EXHAUSTED"
          : httpStatus === 429
            ? "RATE_LIMITED"
            : httpStatus >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "SEARCH_PROVIDER_FAILURE";
  else if (
    /timeout|timed?\s*out|abort/i.test(`${value?.name} ${message}`) ||
    transportCode === "ETIMEDOUT" ||
    /TIMEOUT/.test(transportCode ?? "")
  )
    errorCode = "PROVIDER_TIMEOUT";
  else if (transportCode || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message))
    errorCode = "NETWORK_ERROR";
  else if (/SERPER_API_KEY.*not configured/i.test(message)) errorCode = "MISSING_CREDENTIALS";
  else if (/credits? exhausted|insufficient credits/i.test(message))
    errorCode = "CREDITS_EXHAUSTED";
  else if (/401|invalid.*api.?key|unauthorized/i.test(message)) errorCode = "INVALID_CREDENTIALS";
  else if (/429|rate.?limit|too many requests/i.test(message)) errorCode = "RATE_LIMITED";
  else if (/403|blocked|forbidden/i.test(message)) errorCode = "PROVIDER_BLOCKED";
  else if (/captcha|challenge/i.test(message)) errorCode = "CAPTCHA";
  else if (/unsupported/i.test(message)) errorCode = "UNSUPPORTED";
  else if (/provider unavailable/i.test(message)) errorCode = "PROVIDER_UNAVAILABLE";
  const failureType =
    errorCode === "PROVIDER_TIMEOUT"
      ? "timeout"
      : errorCode === "NETWORK_ERROR"
        ? "network"
        : errorCode === "MALFORMED_RESPONSE"
          ? "malformed_response"
          : httpStatus
            ? "http"
            : errorCode === "MISSING_CREDENTIALS"
              ? "configuration"
              : "provider";
  return {
    errorCode,
    failureType,
    ...(httpStatus ? { httpStatus } : {}),
    ...(transportCode ? { transportCode } : {}),
  };
}

export function failedSearchAttempt(
  provider: string,
  query: string,
  error: unknown,
  started: number,
  startedAt: string,
): SearchAttempt {
  return {
    provider,
    query,
    status: "failed",
    stage: "SEARCH_PROVIDER",
    resultCount: 0,
    durationMs: Math.round(performance.now() - started),
    startedAt,
    error: safeSearchMessage(error),
    ...searchFailureDetails(error),
  };
}

/** Whitelist only diagnostic fields; never serialize request headers or response bodies. */
export function searchDiagnosticTrace(attempts: readonly SearchAttempt[] = []): SearchAttempt[] {
  const counts = new Map<string, number>();
  return attempts.map((attempt) => {
    const attemptNumber = (counts.get(attempt.provider) ?? 0) + 1;
    counts.set(attempt.provider, attemptNumber);
    return {
      provider: attempt.provider,
      query: attempt.query,
      status: attempt.status,
      resultCount: attempt.resultCount,
      durationMs: attempt.durationMs,
      attemptNumber,
      stage: "SEARCH_PROVIDER",
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      ...(attempt.error ? { error: safeSearchMessage(new Error(attempt.error)) } : {}),
      ...(attempt.errorCode && (categories as readonly string[]).includes(attempt.errorCode)
        ? { errorCode: attempt.errorCode }
        : {}),
      ...(Number.isInteger(attempt.httpStatus) &&
      attempt.httpStatus! >= 100 &&
      attempt.httpStatus! <= 599
        ? { httpStatus: attempt.httpStatus }
        : {}),
      ...(attempt.failureType ? { failureType: attempt.failureType } : {}),
      ...(attempt.transportCode && networkCodes.test(attempt.transportCode)
        ? { transportCode: attempt.transportCode }
        : {}),
    };
  });
}
