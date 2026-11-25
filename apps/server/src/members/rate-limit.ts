/** Requests a connected agent's token may make at once before it has to slow down. */
export const AGENT_BURST = 30;
/** Requests a token may make per minute, on average. */
export const AGENT_PER_MINUTE = 120;

interface Bucket {
  tokens: number;
  at: number;
}

export type RateGate = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Per-token rate limits for connected agents (§C.3): a token bucket that holds `burst` requests
 * and refills at `perMinute`. A long `wait_for_session` counts once. In memory: a restart
 * forgets it. Failed tokens are throttled separately, per address, like sign-in.
 */
export class AgentRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly burst = AGENT_BURST,
    private readonly perMinute = AGENT_PER_MINUTE,
  ) {}

  /** Spend one request for `key` (a token id), or say how long to wait. */
  take(key: string): RateGate {
    const now = this.now();
    const refillPerMs = this.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) * refillPerMs);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}
