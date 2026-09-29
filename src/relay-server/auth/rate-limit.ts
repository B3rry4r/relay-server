/*
 * Login rate limiter: exponential backoff per client IP, never a hard lock.
 *
 * - The key is the client IP Express derives with `trust proxy` (the front door's
 *   X-Forwarded-For when it came through a trusted loopback proxy; the TCP peer
 *   otherwise). Never the raw left-most XFF value.
 * - Each failure doubles the wait (1 s, 2 s, 4 s … capped at 60 s). A success
 *   clears the key. A key with no failure for 15 min is forgotten.
 * - A global ceiling (30 failures / rolling minute across all IPs) slows a
 *   distributed guesser down; it too only delays, it never locks.
 * - Box-local callers (loopback, no forwarding headers) are exempt: the owner can
 *   always get in from a terminal (`relay-auth login-link`).
 */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

export class LoginRateLimiter {
  private readonly keys = new Map<string, { failures: number; nextAllowedAt: number; lastFailureAt: number }>();
  private readonly globalFailures: number[] = [];

  constructor(
    private readonly opts = {
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      forgetAfterMs: 15 * 60_000,
      globalMaxPerMinute: 30,
    },
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    this.pruneGlobal(now);
    const entry = this.keys.get(key);
    if (entry && now - entry.lastFailureAt > this.opts.forgetAfterMs) this.keys.delete(key);
    const live = this.keys.get(key);
    if (live && now < live.nextAllowedAt) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((live.nextAllowedAt - now) / 1000)) };
    }
    if (this.globalFailures.length >= this.opts.globalMaxPerMinute) {
      const oldest = this.globalFailures[0];
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
    }
    return { allowed: true };
  }

  recordFailure(key: string, now = Date.now()): number {
    const entry = this.keys.get(key) ?? { failures: 0, nextAllowedAt: 0, lastFailureAt: 0 };
    entry.failures += 1;
    const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (entry.failures - 1));
    entry.nextAllowedAt = now + delay;
    entry.lastFailureAt = now;
    this.keys.set(key, entry);
    this.globalFailures.push(now);
    if (this.keys.size > 10_000) this.evictOldest();
    return delay;
  }

  recordSuccess(key: string): void {
    this.keys.delete(key);
  }

  reset(): void {
    this.keys.clear();
    this.globalFailures.length = 0;
  }

  private pruneGlobal(now: number): void {
    while (this.globalFailures.length && now - this.globalFailures[0] >= 60_000) this.globalFailures.shift();
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, entry] of this.keys) {
      if (entry.lastFailureAt < oldest) { oldest = entry.lastFailureAt; oldestKey = key; }
    }
    if (oldestKey) this.keys.delete(oldestKey);
  }
}
