/**
 * Framework-parity gate. Runs the parity harness (run-parity.ts) over the three
 * fixtures and compares every pass × framework cell against expected.json.
 *
 *   npx vitest run test/parity                       # gate + matrix on stdout
 *   PARITY_OUT=/path/result.json npx vitest run test/parity   # also dump full evidence
 *
 * expected.json is the RATCHET: it records today's status per cell. A fix that turns
 * a cell IMPLEMENTED (or legitimately SKIPPED_WITH_REASON) must update expected.json
 * in the same commit — the gate fails if a cell's status differs from the recorded
 * one in EITHER direction, so a regression cannot hide and an improvement cannot go
 * unrecorded. Downgrading a cell in expected.json is never an acceptable "fix".
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runParity, renderMatrix, type ParityResult } from './run-parity';

const EXPECTED = path.join(__dirname, 'expected.json');

describe('framework parity (flutter / react / next)', () => {
  it('every pass × framework cell matches the recorded status', async () => {
    const res: ParityResult = await runParity();
    const out = process.env.PARITY_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(res, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n${renderMatrix(res)}\n`);

    const expected: Record<string, string> = fs.existsSync(EXPECTED) ? JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) : {};
    const mismatches: string[] = [];
    for (const c of res.cells) {
      const key = `${c.pass} | ${c.framework}`;
      const want = expected[key];
      if (!want) { mismatches.push(`${key}: no expected status recorded (actual ${c.cell_status})`); continue; }
      if (want !== c.cell_status) {
        const failing = c.checks.filter((k) => !k.ok).map((k) => `    ✗ ${k.id} [${k.cls}] ${k.what} — ${k.evidence}`).join('\n');
        mismatches.push(`${key}: expected ${want}, got ${c.cell_status}\n${failing}`);
      }
    }
    for (const key of Object.keys(expected)) {
      if (!res.cells.some((c) => `${c.pass} | ${c.framework}` === key)) mismatches.push(`${key}: expected ${expected[key]} but the cell no longer exists`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  }, 900_000);
});
