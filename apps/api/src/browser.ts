import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { config } from "./config.js";
import { assertSafeHttpUrl, readBoundedBytes, safeFetch } from "./security.js";
import {
  getResearchExecutionContext,
  raceWithResearchAbort,
  remainingResearchTimeMs,
  throwIfResearchInactive,
} from "./execution-context.js";

function executablePath(): string | undefined {
  const candidates = [
    config.BROWSER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
}

export interface BrowserApplicationResponse {
  /** Same-origin path only; query strings are deliberately omitted. */
  path: string;
  contentType: string;
  body: string;
}

interface ApplicationResponseCaptureCandidate {
  pageUrl: string;
  requestUrl: string;
  responseUrl: string;
  method: string;
  status: number;
  contentType: string;
  responseBytes: number;
  capturedCount: number;
  capturedBytes: number;
}

const MAX_CAPTURED_APPLICATION_RESPONSES = 4;
const MAX_CAPTURED_APPLICATION_RESPONSE_BYTES = 64_000;
const MAX_CAPTURED_APPLICATION_BYTES = 128_000;

/** Keep application-data capture passive, same-origin, public, and bounded. */
export function shouldCaptureBrowserApplicationResponse(
  candidate: ApplicationResponseCaptureCandidate,
): boolean {
  if (
    candidate.method !== "GET" ||
    candidate.status < 200 ||
    candidate.status >= 300 ||
    candidate.capturedCount >= MAX_CAPTURED_APPLICATION_RESPONSES ||
    candidate.responseBytes <= 0 ||
    candidate.responseBytes > MAX_CAPTURED_APPLICATION_RESPONSE_BYTES ||
    candidate.capturedBytes + candidate.responseBytes > MAX_CAPTURED_APPLICATION_BYTES ||
    !/^(?:application\/json|application\/[\w.+-]+\+json)\b/i.test(candidate.contentType)
  ) {
    return false;
  }
  try {
    const pageOrigin = new URL(candidate.pageUrl).origin;
    return (
      new URL(candidate.requestUrl).origin === pageOrigin &&
      new URL(candidate.responseUrl).origin === pageOrigin
    );
  } catch {
    return false;
  }
}

/** Bounded browser retrieval for client-rendered public pages only. */
export async function browserFetch(
  url: string,
  requestSignal?: AbortSignal,
  allowedOrigin?: string,
): Promise<{ url: string; html: string; applicationResponses?: BrowserApplicationResponse[] }> {
  const researchSignal = getResearchExecutionContext()?.signal;
  const signal =
    requestSignal && researchSignal && requestSignal !== researchSignal
      ? AbortSignal.any([requestSignal, researchSignal])
      : (requestSignal ?? researchSignal);
  const boundOperation = <T>(operation: Promise<T>) =>
    signal ? raceWithResearchAbort(operation, signal) : operation;
  throwIfResearchInactive();
  await boundOperation(assertSafeHttpUrl(url));
  const pageOrigin = new URL(url).origin;
  if (allowedOrigin && new URL(allowedOrigin).origin !== pageOrigin) {
    throw new Error("Browser source is outside the validated site origin");
  }
  const browserPath = executablePath();
  if (!browserPath)
    throw new Error("Browser fallback is unavailable: no browser executable configured");
  // A dead proxy prevents un-intercepted Chromium requests from reaching the network.
  const launch = chromium.launch({
    executablePath: browserPath,
    headless: true,
    proxy: { server: "http://127.0.0.1:9" },
  });
  let browser: Awaited<typeof launch> | undefined;
  if (signal) {
    void launch
      .then((lateBrowser) => {
        if (signal.aborted) void lateBrowser.close();
      })
      .catch(() => undefined);
    browser = await boundOperation(launch);
  } else {
    browser = await launch;
  }
  let closePromise: Promise<void> | undefined;
  const closeBrowser = () => {
    closePromise ??= browser!.close();
    return closePromise;
  };
  const onAbort = () => void closeBrowser();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const contextTimeout =
      remainingResearchTimeMs(config.BROWSER_TIMEOUT_MS) ?? config.BROWSER_TIMEOUT_MS;
    const context = await boundOperation(
      browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
        javaScriptEnabled: true,
      }),
    );
    context.routeWebSocket("**/*", (socket) => socket.close());
    let requests = 0;
    let totalBytes = 0;
    let capturedApplicationBytes = 0;
    const applicationResponses: BrowserApplicationResponse[] = [];
    await boundOperation(
      context.route("**/*", async (route) => {
        const request = route.request();
        if (
          allowedOrigin &&
          request.isNavigationRequest() &&
          new URL(request.url()).origin !== allowedOrigin
        ) {
          await route.abort();
          return;
        }
        if (["image", "font", "media"].includes(request.resourceType())) {
          await route.abort();
          return;
        }
        try {
          const requestOrigin =
            allowedOrigin && request.isNavigationRequest() ? allowedOrigin : undefined;
          if (++requests > 30 || !["GET", "HEAD"].includes(request.method())) {
            await route.abort();
            return;
          }
          const requestHeaders = request.headers();
          const fetched = await safeFetch(
            request.url(),
            {
              method: request.method(),
              signal,
              headers: {
                accept: requestHeaders.accept ?? "*/*",
                "accept-language": requestHeaders["accept-language"] ?? "en-US,en;q=0.8",
              },
            },
            3,
            config.BROWSER_TIMEOUT_MS,
            requestOrigin,
          );
          try {
            const bytes = await readBoundedBytes(
              fetched.response,
              Math.min(config.MAX_CONTENT_BYTES, 2_000_000),
              remainingResearchTimeMs(config.BROWSER_TIMEOUT_MS) ?? config.BROWSER_TIMEOUT_MS,
            );
            totalBytes += bytes.byteLength;
            if (totalBytes > 6_000_000) throw new Error("Browser total resource budget exceeded");
            const contentType = fetched.response.headers.get("content-type") ?? "";
            if (
              shouldCaptureBrowserApplicationResponse({
                pageUrl: url,
                requestUrl: request.url(),
                responseUrl: fetched.url,
                method: request.method(),
                status: fetched.response.status,
                contentType,
                responseBytes: bytes.byteLength,
                capturedCount: applicationResponses.length,
                capturedBytes: capturedApplicationBytes,
              })
            ) {
              const pathname = new URL(fetched.url).pathname;
              applicationResponses.push({
                path: pathname.slice(0, 512),
                contentType: contentType.split(";")[0].trim(),
                body: Buffer.from(bytes).toString("utf8"),
              });
              capturedApplicationBytes += bytes.byteLength;
            }
            const headers: Record<string, string> = {};
            for (const name of [
              "content-type",
              "cache-control",
              "access-control-allow-origin",
              "access-control-allow-credentials",
            ]) {
              const value = fetched.response.headers.get(name);
              if (value) headers[name] = value;
            }
            await boundOperation(
              route.fulfill({
                status: fetched.response.status,
                headers,
                body: Buffer.from(bytes),
              }),
            );
          } finally {
            await fetched.dispose();
          }
        } catch {
          await route.abort();
        }
      }),
    );
    const page = await boundOperation(context.newPage());
    page.setDefaultTimeout(contextTimeout);
    const response = await boundOperation(
      page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: remainingResearchTimeMs(config.BROWSER_TIMEOUT_MS) ?? config.BROWSER_TIMEOUT_MS,
      }),
    );
    if (response && response.status() >= 400) {
      throw new Error(`Browser navigation HTTP ${response.status()}`);
    }
    await boundOperation(page.waitForTimeout(Math.min(500, remainingResearchTimeMs(500) ?? 500)));
    const finalUrl = page.url();
    await boundOperation(assertSafeHttpUrl(finalUrl));
    if (allowedOrigin && new URL(finalUrl).origin !== allowedOrigin) {
      throw new Error("Browser navigation left the allowed site origin");
    }
    const html = await boundOperation(page.content());
    throwIfResearchInactive();
    if (Buffer.byteLength(html, "utf8") > config.MAX_CONTENT_BYTES) {
      throw new Error("Browser-rendered page exceeds content-size limit");
    }
    return {
      url: finalUrl,
      html,
      ...(applicationResponses.length ? { applicationResponses } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeBrowser();
  }
}
