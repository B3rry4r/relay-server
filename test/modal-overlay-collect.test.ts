// =============================================================================
// P1-core — pass 8b (modal → overlay) must read NESTED modals.
//
// The authoritative canonical schema (canonicalize.ts) nests each modal under its
// base screen's `modals[]` and emits NO top-level `modals[]` — but 8b read ONLY
// the top level, so on every real AI-canonical run it examined ZERO modals and
// was a structural no-op (Ping: 13 folded modals, none inspected). collectModals
// (ported from flow-wiring.ts) flattens both shapes; a nested modal's presenting
// screen is BY DEFINITION its base, so a trigger is synthesized instead of the
// modal being dropped as an "orphan".
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectModals, applyModalOverlays } from '../src/relay-server/passes/modal-overlay';

const nestedCanonical = {
  version: 1,
  screens: [
    {
      canonicalId: 'c_286_3158', name: 'userRegistrationScreen', route: '/user-registration', frameIds: ['286:3158'],
      modals: [
        { id: 'm_313_9543', frameId: '313:9543', baseCanonicalId: 'c_286_3158' },
        { id: 'm_313_9647', frameId: '313:9647', baseCanonicalId: null },
      ],
    },
    { canonicalId: 'c_285_2443', name: 'loginScreen', route: '/login', frameIds: ['285:2443'], modals: [
      { id: 'm_313_10816', frameId: '313:10816', baseCanonicalId: 'c_285_2443' },
    ] },
  ],
  // legacy top-level shape must still be honoured (and deduped by canonicalId)
  modals: [
    { canonicalId: 'm_1_1', name: 'legacyModal', frameId: '1:1', baseCanonicalId: 'c_285_2443', trigger: { fromScreen: 'c_285_2443', element: 'Open', edgeType: 'overlay' } },
    { canonicalId: 'm_313_9543', name: 'dupe — already nested', frameId: '313:9543', baseCanonicalId: 'c_286_3158', trigger: { fromScreen: 'c_286_3158', edgeType: 'overlay' } },
  ],
};

describe('collectModals (8b)', () => {
  it('flattens nested screens[].modals + legacy top-level, deduped by id', () => {
    const all = collectModals(nestedCanonical as any);
    expect(all.map(m => m.canonicalId).sort()).toEqual(['m_1_1', 'm_313_10816', 'm_313_9543', 'm_313_9647']);
    // a nested modal synthesizes its trigger from the base (its presenting screen)
    const nested = all.find(m => m.canonicalId === 'm_313_10816')!;
    expect(nested.baseCanonicalId).toBe('c_285_2443');
    expect(nested.trigger.fromScreen).toBe('c_285_2443');
    // baseCanonicalId:null falls back to the OWNING screen
    const nullBase = all.find(m => m.canonicalId === 'm_313_9647')!;
    expect(nullBase.baseCanonicalId).toBe('c_286_3158');
  });

  it('applyModalOverlays now EXAMINES nested modals (per-modal outcomes, not an early no-op)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), '8b-nested-'));
    try {
      await fs.mkdir(path.join(root, '.uix'), { recursive: true });
      await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\n');
      await fs.writeFile(path.join(root, '.uix', 'canonical.json'), JSON.stringify(nestedCanonical));
      const res = await applyModalOverlays('p', { projectRoot: root, dryRun: true, noAi: true });
      expect(res.framework).toBe('flutter');
      // Every modal (nested + legacy) gets a per-modal outcome with a reason —
      // previously this returned {transformed:[], skipped:[]} without looking.
      expect(res.transformed.length + res.skipped.length).toBe(4);
      for (const id of ['m_313_9543', 'm_313_9647', 'm_313_10816', 'm_1_1']) {
        expect(res.skipped.some(s => s.canonicalId === id) || res.transformed.some(t => t.canonicalId === id)).toBe(true);
      }
      // No screen files exist in this temp project → each nested modal reports the
      // honest gap reason, not "orphan — no trigger".
      const gap = res.skipped.find(s => s.canonicalId === 'm_313_10816');
      expect(gap?.reason ?? '').not.toContain('orphan');
    } finally {
      try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Guard against the real-data regression: when the Ping canonical is available
  // locally, the pass must see all 13 nested modals (this is the run that shipped
  // 13/13 broken). Skipped on machines without the fixture.
  const PING_CANON = '/workspace/projects/Ping/.uix/runs/run_1783030771326_20xpn.canonical.json';
  it.skipIf(!fsSync.existsSync(PING_CANON))('finds all 13 modals in the real Ping canonical', async () => {
    const canon = JSON.parse(await fs.readFile(PING_CANON, 'utf8'));
    const all = collectModals(canon);
    expect(all).toHaveLength(13);
    expect(all.every(m => m.baseCanonicalId && m.trigger.fromScreen === m.baseCanonicalId)).toBe(true);
  });
});
