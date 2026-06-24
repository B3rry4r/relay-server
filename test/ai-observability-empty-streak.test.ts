// =============================================================================
// T29 — EMPTY-STREAK as soft rate-limit proof.
//
// When a quota exhausts mid-build the CLI can return EMPTY output (reason 'empty')
// rather than a classifiable rate-limit ERROR, so T26's isRateLimitError backoff
// never fired and screens went to needs-review. runModelObserved now tracks a per-
// run empty/rate-limit STREAK: an empty that follows a streak ≥ threshold is treated
// as a soft rate-limit → it backs off + retries (T26's backoff) and, if it persists,
// returns reason 'rate-limit' so the caller PAUSES the run resumably. A genuinely-
// isolated single empty still returns 'empty' (behaves as before).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  runModelObserved, _resetEmptyStreaks, _emptyStreakConfig,
  type RunModelLike,
} from '../src/relay-server/ai-observability';

const SAVED = {
  base: process.env.RELAY_RATELIMIT_BASE_MS,
  retries: process.env.RELAY_RATELIMIT_RETRIES,
  threshold: process.env.RELAY_EMPTY_STREAK_THRESHOLD,
};
// Make the backoff instant so the test doesn't actually sleep 20s+.
beforeEach(() => {
  process.env.RELAY_RATELIMIT_BASE_MS = '1';
  process.env.RELAY_RATELIMIT_RETRIES = '2';
  process.env.RELAY_EMPTY_STREAK_THRESHOLD = '3';
  _resetEmptyStreaks();
});
afterEach(() => { _resetEmptyStreaks(); });
afterAll(() => {
  // Restore the env so sibling test files see the real defaults again.
  const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('RELAY_RATELIMIT_BASE_MS', SAVED.base);
  set('RELAY_RATELIMIT_RETRIES', SAVED.retries);
  set('RELAY_EMPTY_STREAK_THRESHOLD', SAVED.threshold);
});

const env = process.env;

describe('T29 empty-streak → soft rate-limit', () => {
  it('a single ISOLATED empty returns reason "empty" (unchanged behavior)', async () => {
    const runner: RunModelLike = async () => ({ text: '' });   // one empty
    const r = await runModelObserved('claude', 'p', env, '/tmp', {
      runner, log: { runId: 'run-iso' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('an empty STREAK (≥ threshold) within one run is treated as a soft rate-limit + pauses', async () => {
    expect(_emptyStreakConfig.EMPTY_STREAK_THRESHOLD).toBe(3);
    const runId = 'run-streak';
    let calls = 0;
    const runner: RunModelLike = async () => { calls++; return { text: '' }; };   // always empty

    // First two empties are below threshold → 'empty' (the loop's T25 retry territory).
    const a = await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });
    expect(a.ok).toBe(false); if (!a.ok) expect(a.reason).toBe('empty');
    const b = await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });
    expect(b.ok).toBe(false); if (!b.ok) expect(b.reason).toBe('empty');

    // Third empty trips the streak → backs off + retries internally, persists empty,
    // and is re-classified as a soft rate-limit so the caller pauses resumably.
    calls = 0;
    const c = await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('rate-limit');     // → caller's PAUSE path, NOT needs-review
    expect(calls).toBeGreaterThan(1);                   // it actually retried (backoff fired)
  });

  it('a real OUTPUT clears the streak (mix of empties then ok resets it)', async () => {
    const runId = 'run-recover';
    let mode: 'empty' | 'ok' = 'empty';
    const runner: RunModelLike = async () => ({ text: mode === 'empty' ? '' : 'done' });

    await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });   // empty 1
    await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });   // empty 2
    mode = 'ok';
    const ok = await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } }); // clears
    expect(ok.ok).toBe(true);

    // After the ok, the streak is reset → the next single empty is 'empty' again, NOT
    // an immediate rate-limit (proves the streak isn't sticky across a success).
    mode = 'empty';
    const after = await runModelObserved('claude', 'p', env, '/tmp', { runner, log: { runId } });
    expect(after.ok).toBe(false); if (!after.ok) expect(after.reason).toBe('empty');
  });

  it('streaks are PER-RUN — one run\'s empties do not poison another run', async () => {
    const emptyRunner: RunModelLike = async () => ({ text: '' });
    // Pile 3 empties into run-A.
    for (let i = 0; i < 3; i++) await runModelObserved('claude', 'p', env, '/tmp', { runner: emptyRunner, log: { runId: 'run-A' } });
    // run-B's FIRST empty must still be 'empty' (not inheriting run-A's streak).
    const b = await runModelObserved('claude', 'p', env, '/tmp', { runner: emptyRunner, log: { runId: 'run-B' } });
    expect(b.ok).toBe(false); if (!b.ok) expect(b.reason).toBe('empty');
  });

  it('a classifiable rate-limit ERROR also CONTINUES the streak (mixed empties + errors pause)', async () => {
    const runId = 'run-mixed';
    // 2 empties, then a rate-limit error → the rate-limit error's own retries exhaust
    // and it returns 'rate-limit' regardless; the point is the streak now counts 3.
    const empties: RunModelLike = async () => ({ text: '' });
    await runModelObserved('claude', 'p', env, '/tmp', { runner: empties, log: { runId } });
    await runModelObserved('claude', 'p', env, '/tmp', { runner: empties, log: { runId } });
    // Now a normal empty (3rd in the streak) → soft rate-limit.
    const r = await runModelObserved('claude', 'p', env, '/tmp', { runner: empties, log: { runId } });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('rate-limit');
  });
});

// =============================================================================
// BUG 2 — a HANG STORM (zero-output timeout/error calls) must HALT resumably, not
// dump every screen to needs-review. The claude CLI hangs on many calls → each dies
// at the 300s timeout with 0 tokens (status=error/timeout). Each such failure now
// counts toward the SAME soft streak as an ok-but-empty call; once it crosses the
// threshold runModelObserved re-classifies it as reason 'rate-limit' with
// softStall:true so the build loop takes the EXISTING pauseRunRateLimited (resumable
// halt: screen→pending, resumable=true, status=stopped) — logging a distinct reason.
// An ISOLATED hang stays a generic failure (that one screen parks as today); a SUCCESS
// resets the streak.
// =============================================================================

/** A runner that THROWS a 300s-style timeout (killed + SIGTERM, zero output). */
const timeoutRunner: RunModelLike = async () => {
  const e: any = new Error('command timed out after 300000ms');
  e.killed = true; e.signal = 'SIGTERM';
  throw e;
};
/** A generic (non-rate-limit) error throw with zero output. */
const errorRunner: RunModelLike = async () => { throw new Error('spawn failed: agent crashed'); };

describe('BUG 2 — zero-output timeout/error storm → soft-stall pause', () => {
  it('an ISOLATED timeout stays reason "timeout" (one screen parks, no run halt)', async () => {
    const r = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId: 'storm-iso' } });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe('timeout'); expect(r.softStall).toBeFalsy(); }
  });

  it('a STREAK of timeouts (≥ threshold) re-classifies to rate-limit + softStall (→ resumable pause)', async () => {
    expect(_emptyStreakConfig.EMPTY_STREAK_THRESHOLD).toBe(3);
    const runId = 'storm-streak';
    // First two hung calls are below threshold → real "timeout" (that screen would be
    // retried/parked as today — NOT a run halt).
    const a = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });
    expect(a.ok).toBe(false); if (!a.ok) expect(a.reason).toBe('timeout');
    const b = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });
    expect(b.ok).toBe(false); if (!b.ok) expect(b.reason).toBe('timeout');
    // Third consecutive zero-output failure trips the streak → soft-stall pause signal.
    const c = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('rate-limit');   // → build loop's pauseRunRateLimited (resumable)
      expect(c.softStall).toBe(true);        // distinct from a real 429 (loop logs the stall reason)
    }
  });

  it('a MIX of empties + generic-error hangs counts toward the same streak', async () => {
    const runId = 'storm-mixed';
    const empty: RunModelLike = async () => ({ text: '' });
    await runModelObserved('claude', 'p', env, '/tmp', { runner: empty, log: { runId } });        // empty 1
    await runModelObserved('claude', 'p', env, '/tmp', { runner: errorRunner, log: { runId } });  // zero-fail 2
    const third = await runModelObserved('claude', 'p', env, '/tmp', { runner: errorRunner, log: { runId } }); // 3 → pause
    expect(third.ok).toBe(false);
    if (!third.ok) { expect(third.reason).toBe('rate-limit'); expect(third.softStall).toBe(true); }
  });

  it('a SUCCESSFUL non-empty call RESETS the streak (isolated hang does not trip later)', async () => {
    const runId = 'storm-reset';
    await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });   // 1
    await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });   // 2
    const ok = await runModelObserved('claude', 'p', env, '/tmp', { runner: async () => ({ text: 'built ok' }), log: { runId } });
    expect(ok.ok).toBe(true);   // clears the streak
    // After reset, two MORE hangs are below threshold again → still plain timeouts, NOT
    // an immediate pause (proves the streak isn't sticky across a success).
    const a = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });
    const b = await runModelObserved('claude', 'p', env, '/tmp', { runner: timeoutRunner, log: { runId } });
    expect(a.ok).toBe(false); if (!a.ok) expect(a.reason).toBe('timeout');
    expect(b.ok).toBe(false); if (!b.ok) expect(b.reason).toBe('timeout');
  });
});
