import { describe, expect, it, vi } from "vitest";
import {
  enqueueOnceThenPoll,
  parseRetryAfterMs,
  pollUntilTerminal,
  summarizePollingTelemetry,
  type PollObservation,
} from "../src/evaluation/poll-until-terminal.js";

describe("bounded evaluation polling", () => {
  it("waits between reads and honors Retry-After on rate limiting", async () => {
    let now = 0;
    const waits: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    });
    const responses = [
      { statusCode: 200, value: { status: "QUEUED" } },
      { statusCode: 429, retryAfterMs: 4_000 },
      { statusCode: 200, value: { status: "COMPLETED" } },
    ];
    const read = vi.fn(async () => responses.shift()!);

    const result = await pollUntilTerminal(read, {
      timeoutMs: 10_000,
      intervalMs: 2_000,
      terminalStatuses: ["COMPLETED", "FAILED"],
      now: () => now,
      sleep,
    });

    expect(result.status).toBe("COMPLETED");
    expect(read).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    expect(parseRetryAfterMs("3", now)).toBe(3_000);
    expect(parseRetryAfterMs("Fri, 02 Oct 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfterMs("invalid", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it("backs off across repeated 429 responses and records polling separately", async () => {
    let now = 0;
    const waits: number[] = [];
    const observations: PollObservation[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    });
    const responses = [
      { statusCode: 429 },
      { statusCode: 429 },
      { statusCode: 200, value: { status: "COMPLETED" } },
    ];

    const result = await pollUntilTerminal(async () => responses.shift()!, {
      timeoutMs: 10_000,
      intervalMs: 1_000,
      maxRateLimitBackoffMs: 4_000,
      terminalStatuses: ["COMPLETED"],
      now: () => now,
      sleep,
      onPoll: (observation) => observations.push(observation),
    });

    expect(result.status).toBe("COMPLETED");
    expect(waits).toEqual([1_000, 2_000]);
    expect(observations.map(({ statusCode }) => statusCode)).toEqual([429, 429, 200]);
    expect(observations.map(({ rateLimitResponses }) => rateLimitResponses)).toEqual([1, 2, 2]);
    expect(observations[0]).toMatchObject({ retryDelayMs: 1_000 });
    expect(observations[1]).toMatchObject({ retryDelayMs: 2_000 });
    const telemetry = summarizePollingTelemetry(observations, 1, 3_000);
    expect(telemetry).toMatchObject({
      enqueueRequests: 1,
      statusReads: 3,
      resourceStatuses: ["COMPLETED"],
      rateLimitResponses: 2,
      retryDelaysMs: [1_000, 2_000],
      totalRetryDelayMs: 3_000,
      elapsedMs: 3_000,
    });
    expect(telemetry).not.toHaveProperty("serperCalls");
    expect(telemetry).not.toHaveProperty("openRouterCalls");
  });

  it("stops repeated 429 responses at the hard deadline", async () => {
    let now = 0;
    const waits: number[] = [];
    const read = vi.fn(async () => ({ statusCode: 429 }));
    const sleep = async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    };

    await expect(
      pollUntilTerminal(read, {
        timeoutMs: 5_000,
        intervalMs: 1_000,
        maxRateLimitBackoffMs: 4_000,
        terminalStatuses: ["COMPLETED"],
        now: () => now,
        sleep,
      }),
    ).rejects.toThrow("bounded timeout");

    expect(waits).toEqual([1_000, 2_000, 2_000]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["FAILED", "CANCELLED"])("returns terminal %s without further reads", async (status) => {
    const read = vi.fn(async () => ({ statusCode: 200, value: { status } }));
    const result = await pollUntilTerminal(read, {
      timeoutMs: 1_000,
      intervalMs: 100,
      terminalStatuses: ["COMPLETED", "FAILED", "CANCELLED"],
    });

    expect(result.status).toBe(status);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("enqueues once and retries only status reads, never provider actions", async () => {
    const enqueue = vi.fn(async () => ({ jobId: "job-1" }));
    const providerAction = vi.fn();
    const observations: PollObservation[] = [];
    let now = 0;
    const sleep = async (milliseconds: number) => {
      now += milliseconds;
    };
    const responses = [
      { statusCode: 429 },
      { statusCode: 200, value: { status: "running" } },
      { statusCode: 200, value: { status: "completed" } },
    ];
    const read = vi.fn(async () => responses.shift()!);

    const outcome = await enqueueOnceThenPoll(enqueue, read, {
      timeoutMs: 5_000,
      intervalMs: 500,
      maxRateLimitBackoffMs: 2_000,
      terminalStatuses: ["completed", "failed", "cancelled"],
      now: () => now,
      sleep,
      onPoll: (observation) => observations.push(observation),
    });

    expect(outcome).toMatchObject({
      queued: { jobId: "job-1" },
      terminal: { status: "completed" },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(providerAction).not.toHaveBeenCalled();
    expect(observations.map((item) => item.rateLimitResponses)).toEqual([1, 1, 1]);
  });

  it("bounds a status read that never resolves", async () => {
    let remainingMs = 0;
    await expect(
      pollUntilTerminal(
        async (remaining) => {
          remainingMs = remaining;
          return new Promise(() => undefined);
        },
        { timeoutMs: 25, intervalMs: 5, terminalStatuses: ["COMPLETED"] },
      ),
    ).rejects.toThrow("bounded timeout");
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(25);
  });

  it("fails on a non-retryable read error", async () => {
    await expect(
      pollUntilTerminal(async () => ({ statusCode: 500 }), {
        timeoutMs: 5_000,
        intervalMs: 2_000,
        terminalStatuses: ["COMPLETED"],
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("does not poll beyond its deadline", async () => {
    let now = 0;
    const read = vi.fn(async () => ({ statusCode: 200, value: { status: "QUEUED" } }));
    const sleep = async (milliseconds: number) => {
      now += milliseconds;
    };

    await expect(
      pollUntilTerminal(read, {
        timeoutMs: 2_500,
        intervalMs: 2_000,
        terminalStatuses: ["COMPLETED"],
        now: () => now,
        sleep,
      }),
    ).rejects.toThrow("terminal state");
    expect(read).toHaveBeenCalledTimes(2);
    expect(now).toBe(2_500);
  });
});
