// =============================================================================
// BUG 1 — verify-rollup must be FAULT-SAFE (no silent 0/0 finalize).
//
// The rollup read `getRun` ONCE; a null / screens-less / under-populated read (a
// transient read during heavy concurrent writes) collapsed total/built/blocking to 0,
// the `blocking>0` park was skipped, and a HALF-BUILT app got FINALIZED + marked done
// (a 17/30 needs-review run shipped "0/0 built"). `resolveRollupVerdict` is the pure
// guard that drives the finalize/park/fault decision; this proves each branch.
//
// Verdict → orchestrator action (in ai-screen-loop.ts):
//   'fault'             → log loudly + setRunResumable(true) + status 'needs-review' + RETURN (never finalize)
//   'park-needs-review' → status 'needs-review' (unchanged normal park)
//   'finalize'          → pre-global gate + finalize + status 'done'
// =============================================================================

import { describe, it, expect } from 'vitest';
import { resolveRollupVerdict, type RollupVerdict } from '../src/relay-server/ai-screen-loop';
import type { BuildRun, RunScreen } from '../src/relay-server/build-run-store';

type Status = RunScreen['status'];
const screens = (...statuses: Status[]): RunScreen[] =>
  statuses.map((status, i) => ({ frameId: `f${i}`, frameName: `Screen ${i}`, status }));
const run = (...statuses: Status[]): BuildRun =>
  ({ screens: screens(...statuses) } as unknown as BuildRun);

describe('BUG 1 — resolveRollupVerdict (fault-safe rollup)', () => {
  // The authoritative in-memory run for these cases has 30 screens.
  const EXPECTED = 30;

  it('(a) getRun → null → FAULT (does NOT finalize)', () => {
    const r = resolveRollupVerdict(null, EXPECTED);
    expect(r.verdict).toBe<RollupVerdict>('fault');
    // total/built collapse but the verdict is FAULT, so the loop logs the fault +
    // parks resumable rather than finalizing a 0/0 run.
    expect(r.total).toBe(0);
    expect(r.built).toBe(0);
  });

  it('(a2) getRun → screens-less / empty object → FAULT', () => {
    expect(resolveRollupVerdict({} as unknown as BuildRun, EXPECTED).verdict).toBe('fault');
    expect(resolveRollupVerdict(run(), EXPECTED).verdict).toBe('fault'); // 0 screens ≠ 30 expected
  });

  it('(b) read has FEWER screens than expected (screens vanished) → FAULT', () => {
    // 17 done out of an expected 30 — a partial/under-populated read. Must NOT finalize.
    const partial = run(...Array<Status>(17).fill('done'));
    const r = resolveRollupVerdict(partial, EXPECTED);
    expect(r.verdict).toBe('fault');
    expect(r.total).toBe(17);          // read size, surfaced for the loud log
    expect(r.built).toBe(17);
  });

  it('(c) all done, built>0, blocking 0, count matches → FINALIZE proceeds', () => {
    const allDone = run(...Array<Status>(EXPECTED).fill('done'));
    const r = resolveRollupVerdict(allDone, EXPECTED);
    expect(r.verdict).toBe('finalize');
    expect(r.built).toBe(30);
    expect(r.blocking).toBe(0);
  });

  it('(c2) a zero-built but consistent read is NOT "complete" → FAULT (no 0/0 finalize)', () => {
    // 30 screens that are all still pending — blocking 0 but built 0. Never finalize.
    const allPending = run(...Array<Status>(EXPECTED).fill('pending'));
    const r = resolveRollupVerdict(allPending, EXPECTED);
    expect(r.verdict).toBe('fault');
    expect(r.built).toBe(0);
    expect(r.blocking).toBe(0);
  });

  it('(d) blocking>0 (needs-review / failed) with full count → PARK at needs-review (unchanged)', () => {
    // 13 done, 15 needs-review, 2 failed = 30 → blocking 17 → park, NOT finalize/fault.
    const mixed = run(
      ...Array<Status>(13).fill('done'),
      ...Array<Status>(15).fill('needs-review'),
      ...Array<Status>(2).fill('failed'),
    );
    const r = resolveRollupVerdict(mixed, EXPECTED);
    expect(r.verdict).toBe('park-needs-review');
    expect(r.built).toBe(13);
    expect(r.needsReview).toBe(15);
    expect(r.failed).toBe(2);
    expect(r.blocking).toBe(17);
  });
});
