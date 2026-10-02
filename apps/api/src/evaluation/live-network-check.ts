import { lookup } from "node:dns/promises";

export type NetworkFailureLayer = "DNS" | "OUTBOUND_PERMISSION" | "TCP" | "TLS" | "HTTPS";

export interface NetworkEndpointCheck {
  service: "supabase" | "serper" | "openrouter";
  dns: "PASS" | "FAIL" | "SKIPPED";
  https: "HTTP_RESPONSE" | "NO_RESPONSE" | "SKIPPED";
  statusCode?: number;
  errorCode?: string;
  failureLayer?: NetworkFailureLayer | "CONFIGURATION";
  elapsedMs?: number;
}

export interface LiveNetworkCheckResult {
  status: "NETWORK READY" | "NETWORK BLOCKED";
  ready: boolean;
  missingConfiguration: string[];
  endpoints: NetworkEndpointCheck[];
  note: string;
}

export interface LiveNetworkCheckOptions {
  supabaseUrl?: string;
  openRouterBaseUrl?: string;
  requiredConfiguration: Array<{ name: string; configured: boolean }>;
  timeoutMs?: number;
  resolveHost?: (hostname: string) => Promise<unknown>;
  request?: typeof fetch;
}

interface EndpointTarget {
  service: NetworkEndpointCheck["service"];
  url?: string;
}

function safeHttpsUrl(value: string | undefined, path: string): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const basePath = url.pathname.replace(/\/+$/, "");
    const relativePath = path.replace(/^\/+/, "");
    url.pathname = `${basePath}/${relativePath}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function findErrorCode(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    const value = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
      name?: unknown;
    };
    if (typeof value.code === "string") return value.code;
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
    if (typeof value.name === "string" && /timeout|abort/i.test(value.name)) return value.name;
  }

  return undefined;
}

function classifyFailure(code?: string): NetworkFailureLayer {
  if (code === "EACCES" || code === "EPERM") return "OUTBOUND_PERMISSION";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return "DNS";
  if (/^CERT_|^ERR_TLS|SELF_SIGNED|CERTIFICATE/i.test(code ?? "")) return "TLS";
  if (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code ?? "")
  ) {
    return "TCP";
  }
  return "HTTPS";
}

export async function checkLiveNetwork(
  options: LiveNetworkCheckOptions,
): Promise<LiveNetworkCheckResult> {
  const missingConfiguration = options.requiredConfiguration
    .filter((entry) => !entry.configured)
    .map((entry) => entry.name);
  const targets: EndpointTarget[] = [
    { service: "supabase", url: safeHttpsUrl(options.supabaseUrl, "/auth/v1/health") },
    { service: "serper", url: "https://google.serper.dev/search" },
    {
      service: "openrouter",
      url: safeHttpsUrl(options.openRouterBaseUrl, "/models"),
    },
  ];
  const resolveHost =
    options.resolveHost ??
    (async (hostname: string) => {
      const records = await lookup(hostname, { all: true });
      if (records.length === 0)
        throw Object.assign(new Error("No DNS records"), { code: "ENODATA" });
      return records;
    });
  const request = options.request ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  const endpoints = await Promise.all(
    targets.map(async ({ service, url }): Promise<NetworkEndpointCheck> => {
      if (!url) {
        return {
          service,
          dns: "SKIPPED",
          https: "SKIPPED",
          errorCode: "MISSING_OR_INVALID_HTTPS_URL",
          failureLayer: "CONFIGURATION",
        };
      }

      const hostname = new URL(url).hostname;
      try {
        await resolveHost(hostname);
      } catch (error) {
        const errorCode = findErrorCode(error);
        return {
          service,
          dns: "FAIL",
          https: "SKIPPED",
          errorCode,
          failureLayer: "DNS",
        };
      }

      const startedAt = Date.now();
      try {
        const response = await request(url, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          service,
          dns: "PASS",
          https: "HTTP_RESPONSE",
          statusCode: response.status,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        const errorCode = findErrorCode(error);
        return {
          service,
          dns: "PASS",
          https: "NO_RESPONSE",
          errorCode,
          failureLayer: classifyFailure(errorCode),
          elapsedMs: Date.now() - startedAt,
        };
      }
    }),
  );

  const ready =
    missingConfiguration.length === 0 &&
    endpoints.every((endpoint) => endpoint.dns === "PASS" && endpoint.https === "HTTP_RESPONSE");

  return {
    status: ready ? "NETWORK READY" : "NETWORK BLOCKED",
    ready,
    missingConfiguration,
    endpoints,
    note: "Unauthenticated HEAD probes only; no provider operation, user creation, or database write was performed.",
  };
}
