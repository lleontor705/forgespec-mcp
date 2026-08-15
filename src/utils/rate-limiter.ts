/**
 * Simple in-memory sliding-window rate limiter per actor/identity.
 * Prevents autonomous agents from entering infinite retry or mutation loops.
 */
export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export class ActorRateLimiter {
  private requests = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: RateLimiterOptions = { windowMs: 60_000, maxRequests: 60 }) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  /**
   * Checks whether the given actor is within rate limits.
   * If allowed, records the invocation and returns allowed: true.
   * If rate limited, returns allowed: false with retryAfterMs.
   */
  check(actor: string, nowMs = Date.now()): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    const key = actor || "anonymous";
    const history = this.requests.get(key) || [];
    const cutoff = nowMs - this.windowMs;

    // Filter out timestamps outside the window
    const valid = history.filter((t) => t > cutoff);

    if (valid.length >= this.maxRequests) {
      const oldest = valid[0];
      const retryAfterMs = oldest + this.windowMs - nowMs;
      this.requests.set(key, valid);
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs), remaining: 0 };
    }

    valid.push(nowMs);
    this.requests.set(key, valid);
    return { allowed: true, remaining: this.maxRequests - valid.length };
  }

  /**
   * Resets rate limit records for a given actor or all actors.
   */
  reset(actor?: string): void {
    if (actor) {
      this.requests.delete(actor);
    } else {
      this.requests.clear();
    }
  }
}
