import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../src/lifecycle.js";

describe("API graceful shutdown", () => {
  it("closes the server once when SIGTERM and SIGINT race", async () => {
    const signals = new EventEmitter();
    const close = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    installGracefulShutdown(signals, close, onError);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports close failures without creating an unhandled rejection", async () => {
    const signals = new EventEmitter();
    const failure = new Error("close failed");
    const close = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    installGracefulShutdown(signals, close, onError);
    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
