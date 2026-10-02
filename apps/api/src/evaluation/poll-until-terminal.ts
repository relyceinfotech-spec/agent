import { setTimeout as delay } from "node:timers/promises";

interface PollResponse<T> {
  statusCode: number;
  retryAfterMs?: number;
  value?: T;
}

export interface PollObservation {
  pollCount: number;
  statusCode?: number;
  resourceStatus?: string;
  elapsedMs: number;
  rateLimitResponses: number;
  retryDelayMs?: number;
  readFailed?: boolean;
}

export interface EnqueueAndPollResult<Q, T> {
  queued: Q;
  terminal: T;
}

export interface PollingTelemetry {
  enqueueRequests: number;
  statusReads: number;
  resourceStatuses: string[];
  rateLimitResponses: number;
  retryDelaysMs: number[];
  totalRetryDelayMs: number;
  readFailures: number;
  lastHttpStatus?: number;
  elapsedMs: number;
}

export function summarizePollingTelemetry(
  observations: PollObservation[],
  enqueueRequests: number,
  elapsedMs: number,
): PollingTelemetry {
  return {
    enqueueRequests,
    statusReads: observations.length,
    resourceStatuses: observations
      .map((item) => item.resourceStatus)
      .filter((status): status is string => Boolean(status)),
    rateLimitResponses: observations.filter((item) => item.statusCode === 429).length,
    retryDelaysMs: observations
      .filter((item) => item.statusCode === 429 && item.retryDelayMs !== undefined)
      .map((item) => item.retryDelayMs!),
    totalRetryDelayMs: observations.reduce(
      (sum, item) => sum + (item.statusCode === 429 ? (item.retryDelayMs ?? 0) : 0),
      0,
    ),
    readFailures: observations.filter((item) => item.readFailed).length,
    lastHttpStatus: observations.at(-1)?.statusCode,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
  };
}

interface PollOptions<T> {
  timeoutMs: number;
  intervalMs: number;
  terminalStatuses: string[];
  maxRateLimitBackoffMs?: number;
  onPoll?: (observation: PollObservation) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const POLL_DEADLINE_ERROR =
  "Polled resource did not reach a terminal state before its bounded timeout";

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && retryAt > now ? retryAt - now : undefined;
}

export async function pollUntilTerminal<T extends { status?: string }>(
  read: (remainingMs: number) => Promise<PollResponse<T>>,
  options: PollOptions<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? (async (milliseconds) => delay(milliseconds).then(() => undefined));
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  const maxRateLimitBackoffMs = Math.max(
    options.intervalMs,
    options.maxRateLimitBackoffMs ?? options.intervalMs,
  );
  let pollCount = 0;
  let rateLimitResponses = 0;
  let consecutiveRateLimits = 0;

  while (now() < deadline) {
    const readStartedAt = now();
    const readRemainingMs = deadline - readStartedAt;
    let response: PollResponse<T>;
    let readTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      response = await Promise.race([
        read(readRemainingMs),
        new Promise<never>((_resolve, reject) => {
          readTimer = setTimeout(() => reject(new Error(POLL_DEADLINE_ERROR)), readRemainingMs);
        }),
      ]);
    } catch (error) {
      pollCount += 1;
      options.onPoll?.({
        pollCount,
        elapsedMs: Math.max(0, now() - startedAt),
        rateLimitResponses,
        readFailed: true,
      });
      throw error;
    } finally {
      if (readTimer) clearTimeout(readTimer);
    }

    pollCount += 1;
    const remainingMs = deadline - now();
    const elapsedMs = Math.max(0, now() - startedAt);

    if (remainingMs <= 0) {
      options.onPoll?.({
        pollCount,
        statusCode: response.statusCode,
        resourceStatus: response.value?.status,
        elapsedMs,
        rateLimitResponses,
      });
      break;
    }

    if (response.statusCode === 429) {
      rateLimitResponses += 1;
      consecutiveRateLimits += 1;
      const exponent = Math.min(consecutiveRateLimits - 1, 30);
      const exponentialBackoffMs = Math.min(
        maxRateLimitBackoffMs,
        options.intervalMs * 2 ** exponent,
      );
      const retryAfterMs =
        Number.isFinite(response.retryAfterMs) && (response.retryAfterMs ?? 0) > 0
          ? response.retryAfterMs!
          : 0;
      const retryDelayMs = Math.min(
        Math.max(options.intervalMs, exponentialBackoffMs, retryAfterMs),
        remainingMs,
      );
      options.onPoll?.({
        pollCount,
        statusCode: response.statusCode,
        elapsedMs,
        rateLimitResponses,
        retryDelayMs,
      });
      await sleep(retryDelayMs);
      continue;
    }

    if (response.statusCode !== 200) {
      options.onPoll?.({
        pollCount,
        statusCode: response.statusCode,
        elapsedMs,
        rateLimitResponses,
      });
      throw new Error(`Polled resource returned HTTP ${response.statusCode}`);
    }

    consecutiveRateLimits = 0;
    const value = response.value;
    if (value && options.terminalStatuses.includes(value.status ?? "")) {
      options.onPoll?.({
        pollCount,
        statusCode: response.statusCode,
        resourceStatus: value.status,
        elapsedMs,
        rateLimitResponses,
      });
      return value;
    }

    const retryDelayMs = Math.min(options.intervalMs, remainingMs);
    options.onPoll?.({
      pollCount,
      statusCode: response.statusCode,
      resourceStatus: value?.status,
      elapsedMs,
      rateLimitResponses,
      retryDelayMs,
    });
    await sleep(retryDelayMs);
  }

  throw new Error(POLL_DEADLINE_ERROR);
}

/** Enqueue exactly once, then retry only the read-only status operation. */
export async function enqueueOnceThenPoll<Q, T extends { status?: string }>(
  enqueue: () => Promise<Q>,
  read: (queued: Q, remainingMs: number) => Promise<PollResponse<T>>,
  options: PollOptions<T>,
): Promise<EnqueueAndPollResult<Q, T>> {
  const queued = await enqueue();
  const terminal = await pollUntilTerminal((remainingMs) => read(queued, remainingMs), options);
  return { queued, terminal };
}
