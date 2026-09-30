/**
 * Regression tests for the three problems the B1 verifier found
 * (scratchpad/reports/journal-B1-parity-foundations-verify-1.json):
 *
 *  #1 auditInteractions on the Next layout the pipeline produces (app/ + a pipeline
 *     src/resources/assets.ts) was recorded `applied` with filesScanned=1 — it read
 *     only src/resources/assets.ts and audited no page.
 *  #2 two skips claimed ABSENT input although the input exists: extractComponents on
 *     Next ("no local component declarations found") and auditInteractions on
 *     flutter ("0 files matched" with 7 .dart screens on disk).
 *  #3 the harness check fz.no-zero-applied could not fail, because finalize's safety
 *     net turns every all-zero `applied` into `skipped` before the check looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditInteractions } from '../src/relay-server/passes/interaction-audit';
import { extractComponents } from '../src/relay-server/passes/component-extraction';
import { settlePassOutcome } from '../src/relay-server/passes/finalize';
import { zeroAppliedViolations, honestSkipReason } from './parity/run-parity';

const FIXTURES = path.resolve(__dirname, 'fixtures', 'parity');
let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b1-regress-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function copyFixture(fw: 'flutter' | 'react' | 'next'): Promise<string> {
  const root = path.join(dir, fw);
  await fs.cp(path.join(FIXTURES, fw), root, { recursive: true });
  return root;
}

describe('#1 auditInteractions never reports `applied` on a Next app whose pages it did not read', () => {
  // B1 verify #1 was fixed first by an honest skip (B12); PG-24 (B34) now audits every
  // resolver source root, so the same layout is AUDITED — `applied` is grounded in the
  // planted control being found in app/, never in a src/resources/assets.ts read.
  it('app/ + src/resources/assets.ts (the resources-emit layout): the pages under app/ are audited', async () => {
    const root = await copyFixture('next');
    await fs.mkdir(path.join(root, 'src', 'resources'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'resources', 'assets.ts'), "export const assets = { logo: '/assets/logo.svg' } as const;\n");
    const r = await auditInteractions('p', { projectRoot: root, noReport: true });
    expect(r.skippedReason).toBeUndefined();
    const resolve = r.report.findings.find((f) => f.file === 'app/10-3/page.tsx' && f.element === 'Resolve');
    expect(resolve).toMatchObject({ screenCanonicalId: 'c_10_3', severity: 'high' });
    expect(r.report.summary.filesScanned).toBeGreaterThan(1);
  });

  it('a src/app Next app is audited through src/ (the router is inside the walked root)', async () => {
    const root = await copyFixture('next');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.rename(path.join(root, 'app'), path.join(root, 'src', 'app'));
    const r = await auditInteractions('p', { projectRoot: root, noReport: true });
    expect(r.skippedReason).toBeUndefined();
    expect(r.report.findings.some((f) => f.file === 'src/app/10-3/page.tsx')).toBe(true);
  });

  it('react (src/screens) is still audited and finds the planted control', async () => {
    const root = await copyFixture('react');
    const r = await auditInteractions('p', { projectRoot: root, noReport: true });
    expect(r.skippedReason).toBeUndefined();
    expect(r.report.findings.some((f) => f.file === 'src/screens/IPhone1415Pro57Screen.tsx')).toBe(true);
  });
});

describe('#2 a skip names the unsupported layout, never absent input', () => {
  it('flutter audit with .dart screens on disk: the Dart files are read (PG-22), never "0 files matched"', async () => {
    const root = await copyFixture('flutter');
    const r = await auditInteractions('p', { projectRoot: root, noReport: true });
    expect(r.skippedReason).toBeUndefined();
    expect(r.report.summary.filesScanned).toBeGreaterThanOrEqual(7);
    expect(r.report.findings.find((f) => f.file === 'lib/screens/screen_10_3.dart' && f.element === 'Resolve')).toMatchObject({ screenCanonicalId: 'c_10_3', severity: 'high' });
  });

  it('extractComponents on Next with locally-declared components: the pages under app/ are read (PG-07), never "no declarations found"', async () => {
    const root = await copyFixture('next');
    expect(await fs.readFile(path.join(root, 'app', '10-3', 'page.tsx'), 'utf8')).toMatch(/^function SectionHeading\b/m);
    const r = await extractComponents('p', { projectRoot: root, dryRun: true, noAiConfirm: true });
    expect(r.skippedReason).toBeUndefined();
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.extracted.map((e) => e.componentPath)).toContain('components/SectionHeading.tsx');
  });

  it('the harness predicate rejects the two old reasons', () => {
    expect(honestSkipReason('no local component declarations found to compare (the next strategy collected 0 candidates)')).toBe(false);
    expect(honestSkipReason('no .dart screen files were read under lib/screens/ (0 files matched)')).toBe(false);
  });
});

describe('#3 fz.no-zero-applied can fail', () => {
  it('finalize marks a skip that only its safety net produced as `guarded`', () => {
    expect(settlePassOutcome({ counts: { filesScanned: 0, total: 0 }, warnings: [] })).toEqual({
      skipReason: expect.stringMatching(/examined no input/), guarded: true,
    });
    expect(settlePassOutcome({ counts: { filesScanned: 0 }, warnings: [], skipped: 'no theme' })).toEqual({ skipReason: 'no theme', guarded: false });
    expect(settlePassOutcome({ counts: { filesScanned: 3 }, warnings: [] })).toEqual({ skipReason: undefined, guarded: false });
  });

  it('the check flags a guarded skip and an all-zero applied, and passes honest reports', () => {
    expect(zeroAppliedViolations([
      { name: 'auditInteractions', status: 'skipped', counts: { filesScanned: 0 }, guarded: true },
      { name: 'extractComponents', status: 'applied', counts: { scanned: 0, extracted: 0 } },
      { name: 'renameSemantic', status: 'skipped', counts: {} },
      { name: 'verifyFlowWiring', status: 'applied', counts: { totalEdges: 7 } },
    ])).toEqual(['auditInteractions (all-zero applied, skipped only by the safety net)', 'extractComponents']);
    expect(zeroAppliedViolations([{ name: 'verifyFlowWiring', status: 'applied', counts: { totalEdges: 7 } }])).toEqual([]);
  });
});
