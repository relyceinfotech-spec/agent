export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastCleanup = Date.now();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitResult {
    // Periodic garbage collection of expired keys every 2 minutes
    if (now - this.lastCleanup > 120_000) {
      this.cleanup(now);
      this.lastCleanup = now;
    }

    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((time) => time > windowStart);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const resetMs = Math.max(0, oldest + this.windowMs - now);
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetMs,
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetMs: this.windowMs,
    };
  }

  private cleanup(now: number): void {
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.hits.entries()) {
      const active = timestamps.filter((time) => time > windowStart);
      if (active.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, active);
      }
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
