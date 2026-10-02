import { describe, expect, it } from "vitest";
import { OpenRouterProvider, type LLMCallRecord } from "../src/llm.js";
import { withOperationContext } from "../src/operation-context.js";

describe("operation diagnostics", () => {
  it("isolates concurrent citation reports and starts the next operation empty", async () => {
    const provider = new OpenRouterProvider();
    await provider.validateCitedAnswer("A previous private answer outside this operation", []);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    await Promise.all([
      withOperationContext(async () => {
        const report = await provider.validateCitedAnswer("First private answer", []);
        unblock();
        await Promise.resolve();
        expect(provider.metrics.citationEntailment).toBe(report);
      }),
      withOperationContext(async () => {
        await gate;
        expect(provider.metrics.citationEntailment).toBeUndefined();
        const report = await provider.validateCitedAnswer("Second private answer", []);
        expect(provider.metrics.citationEntailment).toBe(report);
      }),
    ]);
    withOperationContext(() => {
      expect(provider.metrics.citationEntailment).toBeUndefined();
      expect(provider.metrics.calls).toBe(0);
    });
  });

  it("bounds retained records while keeping accurate totals", () => {
    const provider = new OpenRouterProvider();
    withOperationContext(() => {
      const record = provider as unknown as { recordCall(call: LLMCallRecord): void };
      for (let index = 0; index < 300; index++) {
        record.recordCall({
          durationMs: 2,
          usage: { totalTokens: 3 },
          error: index % 2 ? "failed" : undefined,
        });
      }
      expect(provider.metrics).toMatchObject({
        calls: 300,
        failures: 150,
        durationMs: 600,
        usage: { totalTokens: 900 },
      });
      expect(provider.metrics.records).toHaveLength(200);
    });
    expect(provider.metrics.calls).toBe(0);
  });
});
