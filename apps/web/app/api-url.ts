export function getApiBaseUrl(apiUrl: string | undefined, nodeEnv: string | undefined): string {
  const configuredUrl = apiUrl?.trim();

  if (!configuredUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is required outside development.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL must be an absolute HTTP(S) URL.");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_API_URL must use HTTP or HTTPS.");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("NEXT_PUBLIC_API_URL must not contain credentials, a query, or a fragment.");
  }
  if (parsedUrl.pathname !== "/") {
    throw new Error("NEXT_PUBLIC_API_URL must be an origin without a path.");
  }

  if (nodeEnv === "production") {
    const hostname = parsedUrl.hostname.toLowerCase();
    const isLoopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.startsWith("127.") ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]";

    if (parsedUrl.protocol !== "https:") {
      throw new Error("NEXT_PUBLIC_API_URL must use HTTPS in production.");
    }
    if (isLoopback) {
      throw new Error("NEXT_PUBLIC_API_URL must not target localhost in production.");
    }
  }

  return parsedUrl.origin;
}
