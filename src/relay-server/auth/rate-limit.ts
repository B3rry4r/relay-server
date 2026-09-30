/*
 * Login rate limiter for POST /api/auth/login: exponential backoff per client IP,
 * never a hard lock.
 *
 * - The key is the client IP Express derives with `trust proxy` (the front door's
 *   X-Forwarded-For when it came through a trusted loopback proxy; the TCP peer
 *   otherwise). Never the raw left-most XFF value.
 * - Each failure doubles the key's wait (1 s, 2 s, 4 s … capped at 60 s). A
 *   success clears the key. A key with no failure for 15 min is forgotten.
 * - INVARIANT (no lockout): whether a key may try depends ONLY on that key's own
 *   failures, and its wait is never more than `maxDelayMs` after its own last
 *   failure. Other clients' failures can never refuse an attempt. (An earlier
 *   version refused every key once 30 failures/min were seen globally, so 30
 *   guesses from 30 addresses locked the owner out of a fresh address.)
 * - Global pressure: while more than `globalMaxPerMinute` failures/min are seen
 *   across all keys (a distributed guesser), each NEW failure is charged the
 *   maximum delay straight away instead of starting at 1 s. That only slows the
 *   failing keys; a key with no failures is always allowed.
 * - Box-local callers (loopback, no forwarding headers) are exempt.
 * - The break-glass login-link exchange does not use this limiter at all: its
 *   codes are 192-bit one-time secrets, so there is nothing to brute-force, and
 *   the owner must be able to use one while the password path is under attack
 *   (auth-audit §4.6).
 *
 * Topology note: behind a proxy that is NOT on loopback (e.g. Railway's edge),
 * every remote client shares the proxy's address and therefore one key. Set
 * RELAY_TRUST_PROXY (e.g. `1`) there so keys are per client; the relay logs a
 * warning the first time it sees that shape (routes.ts `warnIfSharedProxyKey`).
 */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

export type LoginRateLimiterOptions = {
  baseDelayMs: number;
  maxDelayMs: number;
  forgetAfterMs: number;
  globalMaxPerMinute: number;
};

export class LoginRateLimiter {
  private readonly keys = new Map<string, { failures: number; nextAllowedAt: number; lastFailureAt: number }>();
  private readonly globalFailures: number[] = [];
  private readonly opts: LoginRateLimiterOptions;

  constructor(opts: Partial<LoginRateLimiterOptions> = {}) {
    this.opts = {
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      forgetAfterMs: 15 * 60_000,
      globalMaxPerMinute: 30,
      ...opts,
    };
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const entry = this.keys.get(key);
    if (entry && now - entry.lastFailureAt > this.opts.forgetAfterMs) this.keys.delete(key);
    const live = this.keys.get(key);
    if (live && now < live.nextAllowedAt) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((live.nextAllowedAt - now) / 1000)) };
    }
    return { allowed: true };
  }

  /** Record a failed attempt for `key`; returns the delay (ms) now charged to it. */
  recordFailure(key: string, now = Date.now()): number {
    this.pruneGlobal(now);
    const underPressure = this.globalFailures.length >= this.opts.globalMaxPerMinute;
    const entry = this.keys.get(key) ?? { failures: 0, nextAllowedAt: 0, lastFailureAt: 0 };
    entry.failures += 1;
    const delay = underPressure
      ? this.opts.maxDelayMs
      : Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (entry.failures - 1));
    entry.nextAllowedAt = now + delay;
    entry.lastFailureAt = now;
    this.keys.set(key, entry);
    this.globalFailures.push(now);
    // Bound memory: the window only needs `globalMaxPerMinute` entries to decide.
    if (this.globalFailures.length > this.opts.globalMaxPerMinute * 4) {
      this.globalFailures.splice(0, this.globalFailures.length - this.opts.globalMaxPerMinute * 4);
    }
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
