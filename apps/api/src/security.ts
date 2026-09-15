import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

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
  8080, // Often local dev/SearXNG - allow only public if resolved, blocked if private
  9200, // Elasticsearch
  11211, // Memcached
  27017, // MongoDB
]);

export function privateIp(ip: string): boolean {
  // Check for IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const targetIp = v4Mapped ? v4Mapped[1] : ip;

  if (net.isIPv4(targetIp)) {
    const parts = targetIp.split(".").map(Number);
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

  if (net.isIPv6(targetIp)) {
    const lower = targetIp.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") || // Unique Local Address (fc00::/7)
      lower.startsWith("fd") || // Unique Local Address (fd00::/8)
      lower.startsWith("fe8") || // Link-Local (fe80::/10)
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff") // Multicast (ff00::/8)
    );
  }

  return true; // Any non-IP address is treated as unsafe for IP check
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
): Promise<{ url: string; response: Response }> {
  let currentUrl = urlInput;
  let redirectsCount = 0;

  while (true) {
    const validatedUrl = await assertSafeHttpUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(validatedUrl, {
        ...init,
        signal: controller.signal,
        redirect: "manual", // Prevent automatic following of unsafe redirect destinations
      });

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
        // Re-validate the redirect destination against SSRF!
        await assertSafeHttpUrl(resolvedRedirect);
        currentUrl = resolvedRedirect;
        continue;
      }

      return { url: validatedUrl.toString(), response };
    } finally {
      clearTimeout(timer);
    }
  }
}
