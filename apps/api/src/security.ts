import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import {
  getResearchExecutionContext,
  raceWithResearchAbort,
  remainingResearchTimeMs,
  throwIfResearchInactive,
} from "./execution-context.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const BLOCKED_INTERNAL_PORTS = new Set([
  21, // FTP
  22, // SSH
  23, // Telnet
  25, // SMTP
  53, // DNS
  69, // TFTP
  111, // Portmapper
  135, // RPC
  137, // NetBIOS
  138, // NetBIOS
  139, // NetBIOS
  445, // SMB
  1433, // MSSQL
  1521, // Oracle
  2375, // Docker
  2376, // Docker SSL
  3306, // MySQL
  5432, // PostgreSQL
  6379, // Redis
  8080, // Alternate HTTP port; private and loopback destinations remain blocked
  9200, // Elasticsearch
  11211, // Memcached
  27017, // MongoDB
]);

export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true; // Invalid format treated as unsafe
    }
    const [a, b, c, d] = parts;

    return (
      a === 0 || // 0.0.0.0/8 (Current network)
      a === 10 || // 10.0.0.0/8 (Private RFC1918)
      a === 127 || // 127.0.0.0/8 (Loopback)
      (a === 169 && b === 254) || // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (Private RFC1918)
      (a === 192 && b === 168) || // 192.168.0.0/16 (Private RFC1918)
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (Shared / Carrier-Grade NAT)
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 (IETF Protocol Assignments)
      (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 (TEST-NET-1)
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (Benchmarking)
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 (TEST-NET-2)
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 (TEST-NET-3)
      (a >= 224 && a <= 239) || // 224.0.0.0/4 (Multicast)
      a >= 240 || // 240.0.0.0/4 (Reserved)
      (a === 255 && b === 255 && c === 255 && d === 255) // Broadcast
    );
  }

  if (net.isIPv6(ip)) {
    const words = parseIpv6Words(ip);
    if (!words) return true;

    // IPv4-mapped addresses can be written with dotted or hexadecimal tails.
    // Classify the embedded IPv4 address so DNS answers cannot bypass SSRF checks.
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      const [high, low] = words.slice(6);
      return privateIp([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
    }

    const firstWord = words[0];
    const allTrailingWordsZero = words.slice(1).every((word) => word === 0);
    return (
      (firstWord === 0 && allTrailingWordsZero) || // Unspecified address
      (firstWord === 0 && words[7] === 1 && words.slice(1, 7).every((word) => word === 0)) || // Loopback
      (firstWord & 0xfe00) === 0xfc00 || // Unique local (fc00::/7)
      (firstWord & 0xffc0) === 0xfe80 || // Link-local (fe80::/10)
      (firstWord & 0xffc0) === 0xfec0 || // Deprecated site-local (fec0::/10)
      (firstWord & 0xff00) === 0xff00 // Multicast (ff00::/8)
    );
  }

  return true; // Any non-IP address is treated as unsafe for IP check
}

function parseIpv6Words(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;

  let normalized = ip.toLowerCase();
  const dottedTail = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedTail) {
    const octets = dottedTail[1].split(".").map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return undefined;
    const first = ((octets[0] << 8) | octets[1]).toString(16);
    const second = ((octets[2] << 8) | octets[3]).toString(16);
    const dottedTailIndex = normalized.length - dottedTail[1].length;
    normalized = `${normalized.slice(0, dottedTailIndex)}${first}:${second}`;
  }

  const compressionIndex = normalized.indexOf("::");
  const left = (compressionIndex === -1 ? normalized : normalized.slice(0, compressionIndex))
    .split(":")
    .filter(Boolean);
  const right = (compressionIndex === -1 ? "" : normalized.slice(compressionIndex + 2))
    .split(":")
    .filter(Boolean);
  const missingWords = compressionIndex === -1 ? 0 : 8 - left.length - right.length;
  const words = [...left, ...Array.from({ length: missingWords }, () => "0"), ...right].map(
    (word) => Number.parseInt(word, 16),
  );

  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : undefined;
}

export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL format");
  }

  // 1. Enforce public HTTP/HTTPS protocols only
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only public HTTP and HTTPS protocols are allowed");
  }

  // 2. Reject embedded credentials (e.g. http://user:pass@host)
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase();

  // 3. Reject empty or oversized hostnames
  if (!hostname || hostname.length > 253) {
    throw new Error("Invalid hostname");
  }

  // 4. Reject known loopback, internal, and cloud metadata hostnames
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".onion")
  ) {
    throw new Error("Blocked internal, loopback, or metadata destination");
  }

  // 5. Port validation
  if (url.port) {
    const portNum = Number(url.port);
    if (BLOCKED_INTERNAL_PORTS.has(portNum)) {
      throw new Error(`Blocked destination port: ${portNum}`);
    }
  }

  // 6. Direct IP literal check
  if (net.isIP(hostname)) {
    if (privateIp(hostname)) {
      throw new Error("Blocked private, link-local, or multicast IP literal");
    }
  }

  // 7. DNS resolution check (protects against domain pointing to private/loopback/metadata IP)
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `Failed to resolve destination hostname: ${err instanceof Error ? err.message : "Lookup failed"}`,
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new Error("Blocked unresolvable destination");
  }

  // Every resolved IP address must be public
  for (const entry of addresses) {
    if (privateIp(entry.address)) {
      throw new Error("Blocked private or local IP destination from DNS resolution");
    }
  }

  return url;
}

export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
  ].forEach((key) => url.searchParams.delete(key));
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Fetch a URL with SSRF protection on every redirect hop.
 * Uses manual redirect inspection so redirect targets are strictly validated.
 */
export async function safeFetch(
  urlInput: string,
  init: RequestInit = {},
  maxRedirects = 3,
  timeoutMs = 12000,
  allowedOrigin?: string,
): Promise<{ url: string; response: Response; dispose: () => Promise<void> }> {
  let currentUrl = urlInput;
  let redirectsCount = 0;
  const runContext = getResearchExecutionContext();
  throwIfResearchInactive();
  const bounded = <T>(operation: Promise<T>) =>
    runContext ? raceWithResearchAbort(operation, runContext.signal) : operation;

  while (true) {
    const remainingMs = runContext ? runContext.deadlineAt - Date.now() : undefined;
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new Error("Research session deadline exhausted");
    }
    const validatedUrl = await bounded(assertSafeHttpUrl(currentUrl));
    if (allowedOrigin && validatedUrl.origin !== allowedOrigin) {
      throw new Error("Fetch destination is outside the allowed site origin");
    }
    // Pin the connection to an address that was checked immediately before use.
    const addresses = await bounded(
      dns.lookup(validatedUrl.hostname, { all: true, verbatim: true }),
    );
    if (addresses.length === 0 || addresses.some((entry) => privateIp(entry.address))) {
      throw new Error("Blocked private or unresolvable destination at connection time");
    }
    const selected = addresses[0];
    const dispatcher = new Agent({
      connect: {
        autoSelectFamily: false,
        lookup: (hostname, _options, callback) => {
          if (hostname.toLowerCase() !== validatedUrl.hostname.toLowerCase()) {
            callback(new Error("Unexpected connection hostname"), "", 4);
            return;
          }
          callback(null, selected.address, selected.family);
        },
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(timeoutMs, remainingMs ?? timeoutMs),
    );
    const signals = [controller.signal, init.signal, runContext?.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );

    try {
      const response = (await undiciFetch(validatedUrl, {
        ...init,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        redirect: "manual", // Prevent automatic following of unsafe redirect destinations
        dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

      // Handle HTTP redirects securely
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirectsCount++;
        if (redirectsCount > maxRedirects) {
          throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response missing Location header");
        }
        const resolvedRedirect = new URL(location, validatedUrl).toString();
        if (allowedOrigin && new URL(resolvedRedirect).origin !== allowedOrigin) {
          await response.body?.cancel();
          await dispatcher.close();
          throw new Error("Redirect destination is outside the allowed site origin");
        }
        // Re-validate the redirect destination against SSRF!
        await bounded(assertSafeHttpUrl(resolvedRedirect));
        await response.body?.cancel();
        await dispatcher.close();
        currentUrl = resolvedRedirect;
        continue;
      }

      return {
        url: validatedUrl.toString(),
        response,
        dispose: async () => dispatcher.close(),
      };
    } catch (error) {
      dispatcher.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isTransientFetchError(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  while (current && typeof current === "object") {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.cause;
  }
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|aborted/i.test(
    messages.join(" "),
  );
}

/** Retry transient fetch failures once; validation and permanent HTTP errors fail immediately. */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  maxAttempts = 2,
  retryable: (error: unknown) => boolean = isTransientFetchError,
): Promise<T> {
  const attempts = Math.max(1, Math.min(3, Math.floor(maxAttempts)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  throw new Error("Fetch retry loop ended unexpectedly");
}

class RetryableHttpStatus extends Error {}

export function isRetryableFetchStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function safeFetchWithRetry(
  urlInput: string,
  init: RequestInit = {},
  maxRedirects = 3,
  timeoutMs = 12000,
  maxAttempts = 2,
  allowedOrigin?: string,
): Promise<{ url: string; response: Response; dispose: () => Promise<void> }> {
  return retryTransient(
    async () => {
      const fetched = await safeFetch(urlInput, init, maxRedirects, timeoutMs, allowedOrigin);
      if (isRetryableFetchStatus(fetched.response.status)) {
        await fetched.response.body?.cancel();
        await fetched.dispose();
        const retryAfter = Number(fetched.response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 1000)));
        }
        throw new RetryableHttpStatus(`Retryable HTTP status ${fetched.response.status}`);
      }
      return fetched;
    },
    maxAttempts,
    (error) => {
      const contextSignal = getResearchExecutionContext()?.signal;
      return (
        !init.signal?.aborted &&
        !contextSignal?.aborted &&
        (error instanceof RetryableHttpStatus || isTransientFetchError(error))
      );
    },
  );
}

async function readWithDeadline<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  timeoutMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const effectiveTimeout = remainingResearchTimeMs(timeoutMs) ?? timeoutMs;
  if (effectiveTimeout <= 0) throw new Error("Research session deadline exhausted");
  const signal = getResearchExecutionContext()?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error(timeoutMessage));
    }, effectiveTimeout);
  });
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          void reader.cancel().catch(() => undefined);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Research execution was cancelled"),
          );
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    return await Promise.race([operation(), deadline, ...(aborted ? [aborted] : [])]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Read a response body with a byte budget and the smaller of its timeout or session remainder. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("Response exceeds content-size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await readWithDeadline(reader, timeoutMs, "Response body timed out", async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeds content-size limit");
      }
      chunks.push(next.value);
    }
  });
  const charset = response.headers.get("content-type")?.match(/charset=([^;\s]+)/i)?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(Buffer.concat(chunks));
}

/** Read only a bounded response prefix for metadata discovery; never buffer the remaining body. */
export async function readBoundedPrefixText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    await readWithDeadline(reader, timeoutMs, "Response prefix timed out", async () => {
      while (bytes < maxBytes) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = maxBytes - bytes;
        const chunk = next.value.subarray(0, remaining);
        chunks.push(chunk);
        bytes += chunk.byteLength;
        if (chunk.byteLength < next.value.byteLength || bytes >= maxBytes) {
          await reader.cancel();
          break;
        }
      }
    });
    const charset = response.headers.get("content-type")?.match(/charset=([^;\s]+)/i)?.[1];
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset ?? "utf-8");
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    return decoder.decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("Response exceeds content-size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await readWithDeadline(reader, timeoutMs, "Response body timed out", async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeds content-size limit");
      }
      chunks.push(next.value);
    }
  });
  return Buffer.concat(chunks);
}
