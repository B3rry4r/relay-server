// =============================================================================
// FEATURE 1 — auto-resume after a rate-limit reset.
//
// Two pure, tested seams in ai-screen-loop.ts:
//   parseResetHintToEpoch(hint, now) — turns the CLI's "resets …" text into an
//     absolute epoch (UTC). Unparseable → now + 60min.
//   shouldAutoResume(run, now)       — the sweep's selection guard: only a
//     stopped + rateLimitPaused + resumeAt-elapsed + under-CAP run qualifies. A
//     user Stop (no flag) NEVER qualifies.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseResetHintToEpoch, shouldAutoResume, AUTO_RESUME_CAP,
} from '../src/relay-server/ai-screen-loop';
import type { BuildRun } from '../src/relay-server/build-run-store';

// A fixed reference "now": 2026-06-28T09:00:00Z.
const NOW = Date.UTC(2026, 5, 28, 9, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe('FEATURE 1 — parseResetHintToEpoch', () => {
  it('"resets 6pm (UTC)" → 18:00 UTC today', () => {
    const got = parseResetHintToEpoch('You\'ve hit your session limit · resets 6pm (UTC)', NOW);
    expect(got).toBe(Date.UTC(2026, 5, 28, 18, 0, 0, 0));
  });

  it('"resets at 18:00" → 18:00 UTC today', () => {
    expect(parseResetHintToEpoch('resets at 18:00', NOW)).toBe(Date.UTC(2026, 5, 28, 18, 0, 0, 0));
  });

  it('"resets 11 pm" → 23:00 UTC today', () => {
    expect(parseResetHintToEpoch('resets 11 pm', NOW)).toBe(Date.UTC(2026, 5, 28, 23, 0, 0, 0));
  });

  it('"resets in 90 minutes" → now + 90min', () => {
    expect(parseResetHintToEpoch('resets in 90 minutes', NOW)).toBe(NOW + 90 * MIN);
  });

  it('"resets in 2 hours" → now + 2h', () => {
    expect(parseResetHintToEpoch('resets in 2 hours', NOW)).toBe(NOW + 2 * HOUR);
  });

  it('a clock time already passed today rolls to tomorrow', () => {
    // "resets 6am" but now is 09:00 → 06:00 already passed → +24h.
    expect(parseResetHintToEpoch('resets 6am', NOW)).toBe(Date.UTC(2026, 5, 29, 6, 0, 0, 0));
  });

  it('garbage / undefined → now + 60min default', () => {
    expect(parseResetHintToEpoch('completely unrelated text', NOW)).toBe(NOW + 60 * MIN);
    expect(parseResetHintToEpoch(undefined, NOW)).toBe(NOW + 60 * MIN);
    expect(parseResetHintToEpoch('', NOW)).toBe(NOW + 60 * MIN);
  });
});

describe('FEATURE 1 — shouldAutoResume (sweep selection)', () => {
  const base = (over: Partial<BuildRun>): BuildRun =>
    ({ id: 'run_1', status: 'stopped', rateLimitPaused: true, resumeAt: NOW - 1, autoResumeCount: 0, ...over } as unknown as BuildRun);

  it('stopped + rateLimitPaused + resumeAt elapsed + under CAP → selected', () => {
    expect(shouldAutoResume(base({}), NOW)).toBe(true);
  });

  it('user-stopped run (no rateLimitPaused flag) → NOT selected', () => {
    expect(shouldAutoResume(base({ rateLimitPaused: undefined }), NOW)).toBe(false);
    expect(shouldAutoResume(base({ rateLimitPaused: false }), NOW)).toBe(false);
  });

  it('resumeAt still in the FUTURE → NOT selected', () => {
    expect(shouldAutoResume(base({ resumeAt: NOW + HOUR }), NOW)).toBe(false);
  });

  it('autoResumeCount at/over CAP → NOT selected', () => {
    expect(shouldAutoResume(base({ autoResumeCount: AUTO_RESUME_CAP }), NOW)).toBe(false);
    expect(shouldAutoResume(base({ autoResumeCount: AUTO_RESUME_CAP + 5 }), NOW)).toBe(false);
  });

  it('a non-stopped run (running / needs-review / done) → NOT selected', () => {
    expect(shouldAutoResume(base({ status: 'running' }), NOW)).toBe(false);
    expect(shouldAutoResume(base({ status: 'needs-review' }), NOW)).toBe(false);
    expect(shouldAutoResume(base({ status: 'done' }), NOW)).toBe(false);
  });

  it('no resumeAt set → NOT selected', () => {
    expect(shouldAutoResume(base({ resumeAt: undefined }), NOW)).toBe(false);
  });
});
