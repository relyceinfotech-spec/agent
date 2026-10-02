import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createSupabaseAuthFetch } from "../supabase-auth-fetch.js";

export interface AuthSmokeTransportEvent {
  method: string;
  path: string;
  elapsedMs: number;
  requestAccept?: string;
  requestContentType?: string;
  requestAcceptEncoding?: string;
  status?: number;
  contentType?: string;
  contentLength?: string;
  contentEncoding?: string;
  transferEncoding?: string;
  responseObservedAt?: "auth-smoke-fetch-wrapper";
  responseBodyHashStage?: "fetch-response-body";
  responseBodyEncodingHint?: AuthSmokeBodyEncodingHint;
  responseDecodedBodyBytes?: number;
  responseDecodedBodySha256?: string;
  responseDecodedJsonValid?: boolean;
  responseBoundaryHeaders?: Record<string, string>;
  responseBodyBytes?: number;
  responseJsonValid?: boolean;
  responseBodyKind?: AuthSmokeResponseBodyKind;
  responseBodySha256?: string;
  responseTextPrefix?: string;
  responseTextPrefixOmitted?: boolean;
  responseBodyErrorName?: string;
  responseCaptureErrorName?: string;
  clientErrorName?: string;
  clientErrorStatus?: number;
  clientFailureClassification?: AuthSmokeFailureClassification;
  errorName?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
  aborted?: boolean;
  abortReason?: string;
}

export type AuthSmokeResponseBodyKind =
  | "empty"
  | "valid-json"
  | "truncated-json"
  | "invalid-json"
  | "html"
  | "non-json"
  | "plain-text"
  | "binary-or-encoded";

export type AuthSmokeBodyEncodingHint = "empty" | "valid-utf8" | "gzip" | "zstd" | "invalid-utf8";

export interface AuthSmokeResponseBodySummary {
  byteLength: number;
  sha256: string;
  kind: AuthSmokeResponseBodyKind;
  encodingHint: AuthSmokeBodyEncodingHint;
  jsonValid: boolean;
  decodedByteLength?: number;
  decodedSha256?: string;
  decodedJsonValid?: boolean;
  decodedKind?: AuthSmokeResponseBodyKind;
  textPrefix?: string;
  textPrefixOmitted: boolean;
}

export interface AuthSmokeResponseCapture {
  status: number;
  contentType?: string;
  body: Uint8Array;
}

export type AuthSmokeFailureClassification =
  | "malformed-compressed-response-metadata"
  | "response-body-parse-failure"
  | "timeout-or-abort"
  | "fetch-transport-failure"
  | "upstream-http-error"
  | "unknown";

interface BoundedFetchOptions {
  fetchImpl: typeof fetch;
  deadline: () => number;
  onEvent: (event: AuthSmokeTransportEvent) => void;
  perRequestTimeoutMs?: number;
  onAdminCreateResponse?: (capture: AuthSmokeResponseCapture) => void;
}

function describeThrownError(error: unknown) {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause =
    value.cause && typeof value.cause === "object" ? (value.cause as Record<string, unknown>) : {};
  return {
    name: typeof value.name === "string" ? value.name : "UnknownError",
    code: typeof value.code === "string" ? value.code : undefined,
    causeName: typeof cause.name === "string" ? cause.name : undefined,
    causeCode: typeof cause.code === "string" ? cause.code : undefined,
  };
}

function jsonLooksTruncated(text: string, errorMessage: string): boolean {
  if (/unexpected end|end of json input|unterminated string/i.test(errorMessage)) return true;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return false;
    }
  }

  return inString || stack.length > 0;
}

function safeTextPrefix(text: string, kind: AuthSmokeResponseBodyKind): string | undefined {
  if (kind === "html" || kind === "binary-or-encoded" || kind === "valid-json") return undefined;

  const normalized = text.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    /[<>[\]{}"'`]/.test(normalized) ||
    /@|https?:\/\/|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/i.test(normalized) ||
    /\b(?:email|password|token|authorization|cookie|secret|api[_-]?key|user[_ -]?id)\b/i.test(
      normalized,
    ) ||
    /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(normalized)
  ) {
    return undefined;
  }

  return normalized.slice(0, 120);
}

export function summarizeAuthSmokeResponseBody(
  body: Uint8Array,
  contentType?: string,
): AuthSmokeResponseBodySummary {
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (body.byteLength === 0) {
    return {
      byteLength: 0,
      sha256,
      kind: "empty",
      encodingHint: "empty",
      jsonValid: false,
      decodedByteLength: 0,
      decodedSha256: sha256,
      decodedJsonValid: false,
      decodedKind: "empty",
      textPrefixOmitted: true,
    };
  }

  const isGzip = body[0] === 0x1f && body[1] === 0x8b;
  const isZstd = body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd;
  if (isGzip) {
    try {
      const decoded = new Uint8Array(gunzipSync(body, { maxOutputLength: 1_000_000 }));
      const decodedSummary = summarizeAuthSmokeResponseBody(decoded, contentType);
      return {
        byteLength: body.byteLength,
        sha256,
        kind: "binary-or-encoded",
        encodingHint: "gzip",
        jsonValid: false,
        decodedByteLength: decodedSummary.byteLength,
        decodedSha256: decodedSummary.sha256,
        decodedJsonValid: decodedSummary.jsonValid,
        decodedKind: decodedSummary.kind,
        textPrefix: decodedSummary.textPrefix,
        textPrefixOmitted: decodedSummary.textPrefixOmitted,
      };
    } catch {
      return {
        byteLength: body.byteLength,
        sha256,
        kind: "binary-or-encoded",
        encodingHint: "gzip",
        jsonValid: false,
        textPrefixOmitted: true,
      };
    }
  }
  if (isZstd) {
    return {
      byteLength: body.byteLength,
      sha256,
      kind: "binary-or-encoded",
      encodingHint: "zstd",
      jsonValid: false,
      textPrefixOmitted: true,
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return {
      byteLength: body.byteLength,
      sha256,
      kind: "binary-or-encoded",
      encodingHint: "invalid-utf8",
      jsonValid: false,
      textPrefixOmitted: true,
    };
  }

  try {
    JSON.parse(text);
    return {
      byteLength: body.byteLength,
      sha256,
      kind: "valid-json",
      encodingHint: "valid-utf8",
      jsonValid: true,
      decodedByteLength: body.byteLength,
      decodedSha256: sha256,
      decodedJsonValid: true,
      decodedKind: "valid-json",
      textPrefixOmitted: true,
    };
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : "";
    const trimmed = text.trimStart();
    const declaredHtml = contentType?.toLowerCase().includes("text/html") ?? false;
    const looksHtml = /^<!doctype\s+html\b|^<html\b/i.test(trimmed);
    let kind: AuthSmokeResponseBodyKind;

    if (declaredHtml || looksHtml) kind = "html";
    else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      kind = jsonLooksTruncated(trimmed, parseMessage) ? "truncated-json" : "invalid-json";
    } else if (contentType?.toLowerCase().includes("json")) kind = "non-json";
    else if (contentType?.toLowerCase().startsWith("text/")) kind = "plain-text";
    else kind = "non-json";

    const prefix = safeTextPrefix(text, kind);
    return {
      byteLength: body.byteLength,
      sha256,
      kind,
      encodingHint: "valid-utf8",
      jsonValid: false,
      decodedByteLength: body.byteLength,
      decodedSha256: sha256,
      decodedJsonValid: false,
      decodedKind: kind,
      textPrefix: prefix,
      textPrefixOmitted: prefix === undefined,
    };
  }
}

function safeResponseBoundaryHeaders(headers: Headers): Record<string, string> {
  const allowed = [
    "server",
    "via",
    "cf-ray",
    "x-request-id",
    "x-correlation-id",
    "x-supabase-api-version",
    "x-kong-request-id",
    "x-kong-proxy-latency",
    "x-kong-upstream-latency",
  ];
  const result: Record<string, string> = {};

  for (const name of allowed) {
    const value = headers.get(name);
    if (!value) continue;
    result[name] = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  }

  return result;
}

function requestHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  return headers.get(name) ?? undefined;
}

export function classifyAuthSmokeFailure(
  error: unknown,
  event?: AuthSmokeTransportEvent,
): AuthSmokeFailureClassification {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = typeof value.status === "number" ? value.status : undefined;

  if (
    event?.status !== undefined &&
    event.status >= 200 &&
    event.status < 300 &&
    event.responseJsonValid === false &&
    event.responseBodyEncodingHint === "gzip" &&
    !event.contentEncoding
  ) {
    return "malformed-compressed-response-metadata";
  }

  if (
    event?.status !== undefined &&
    event.status >= 200 &&
    event.status < 300 &&
    event.responseJsonValid === false
  ) {
    return "response-body-parse-failure";
  }
  if (event?.aborted || event?.errorName === "TimeoutError") return "timeout-or-abort";
  if (event?.errorName || status === 0 || event?.status === undefined) {
    return "fetch-transport-failure";
  }
  if (event.status >= 400 || (status !== undefined && status >= 400)) {
    return "upstream-http-error";
  }
  return "unknown";
}

export function safeAuthSmokeError(error: unknown, redactValues: readonly string[] = []) {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof value.name === "string" ? value.name : "UnknownError";
  const status = typeof value.status === "number" ? value.status : undefined;
  let message = typeof value.message === "string" ? value.message : "";

  for (const secret of redactValues) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  message = message
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "[redacted-token]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(
      /\b(password|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
  if (/[{}<>]/.test(message) || message.length > 200)
    message = "[omitted: response-like or long message]";

  return { name, status, message: message || undefined };
}

export function createAuthSmokeFetch({
  fetchImpl,
  deadline,
  onEvent,
  perRequestTimeoutMs = 25_000,
  onAdminCreateResponse,
}: BoundedFetchOptions): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const event: AuthSmokeTransportEvent = {
      method: String(
        init?.method ?? (input instanceof Request ? input.method : "GET"),
      ).toUpperCase(),
      path: url.pathname,
      elapsedMs: 0,
      requestAccept: requestHeader(input, init, "accept"),
      requestContentType: requestHeader(input, init, "content-type"),
      requestAcceptEncoding: requestHeader(input, init, "accept-encoding"),
    };
    const remainingMs = deadline() - startedAt;

    if (remainingMs <= 0) {
      const error = new DOMException("Auth smoke time budget exhausted", "TimeoutError");
      const details = describeThrownError(error);
      event.elapsedMs = Date.now() - startedAt;
      Object.assign(event, {
        errorName: details.name,
        errorCode: details.code,
        causeName: details.causeName,
        causeCode: details.causeCode,
        aborted: true,
        abortReason: error.name,
      });
      onEvent(event);
      throw error;
    }

    const timeout = AbortSignal.timeout(Math.max(1, Math.min(perRequestTimeoutMs, remainingMs)));
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    const authAwareFetch = createSupabaseAuthFetch(async (requestInput, requestInit) => {
      event.requestAcceptEncoding = requestHeader(requestInput, requestInit, "accept-encoding");
      return fetchImpl(requestInput, requestInit);
    });

    try {
      const response = await authAwareFetch(input, { ...init, signal });
      event.status = response.status;
      event.contentType = response.headers.get("content-type") ?? undefined;
      event.contentLength = response.headers.get("content-length") ?? undefined;
      event.contentEncoding = response.headers.get("content-encoding") ?? undefined;
      event.transferEncoding = response.headers.get("transfer-encoding") ?? undefined;
      if (event.method === "POST" && event.path === "/auth/v1/admin/users") {
        event.responseObservedAt = "auth-smoke-fetch-wrapper";
        event.responseBodyHashStage = "fetch-response-body";
        event.responseBoundaryHeaders = safeResponseBoundaryHeaders(response.headers);
        try {
          const body = new Uint8Array(await response.clone().arrayBuffer());
          const summary = summarizeAuthSmokeResponseBody(body, event.contentType);
          event.responseBodyBytes = summary.byteLength;
          event.responseJsonValid = summary.jsonValid;
          event.responseBodyKind = summary.kind;
          event.responseBodyEncodingHint = summary.encodingHint;
          event.responseDecodedBodyBytes = summary.decodedByteLength;
          event.responseDecodedBodySha256 = summary.decodedSha256;
          event.responseDecodedJsonValid = summary.decodedJsonValid;
          event.responseBodySha256 = summary.sha256;
          event.responseTextPrefix = summary.textPrefix;
          event.responseTextPrefixOmitted = summary.textPrefixOmitted;
          try {
            onAdminCreateResponse?.({
              status: response.status,
              contentType: event.contentType,
              body,
            });
          } catch (error) {
            event.responseCaptureErrorName = describeThrownError(error).name;
          }
        } catch (error) {
          event.responseBodyErrorName = describeThrownError(error).name;
        }
      }
      event.elapsedMs = Date.now() - startedAt;
      event.aborted = signal.aborted;
      event.abortReason = signal.aborted ? String(signal.reason?.name ?? signal.reason) : undefined;
      onEvent(event);
      return response;
    } catch (error) {
      const details = describeThrownError(error);
      event.elapsedMs = Date.now() - startedAt;
      Object.assign(event, {
        errorName: details.name,
        errorCode: details.code,
        causeName: details.causeName,
        causeCode: details.causeCode,
        aborted: signal.aborted,
        abortReason: signal.aborted ? String(signal.reason?.name ?? signal.reason) : undefined,
      });
      onEvent(event);
      throw error;
    }
  };
}

export function formatAuthSmokeError(error: unknown): string {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof value.name === "string" ? value.name : "Unknown smoke failure";
  const status = typeof value.status === "number" ? ` HTTP ${value.status}` : "";
  const code = typeof value.code === "string" ? ` code=${value.code}` : "";
  const cause =
    value.cause && typeof value.cause === "object" ? (value.cause as Record<string, unknown>) : {};
  const causeName = typeof cause.name === "string" ? ` cause=${cause.name}` : "";
  const causeCode = typeof cause.code === "string" ? ` causeCode=${cause.code}` : "";
  return `${name}${status}${code}${causeName}${causeCode}`;
}
