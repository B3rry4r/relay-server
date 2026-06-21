// =============================================================================
// Phase 1c REDUCE — full REAL-AI pipeline smoke (1a describe → 1b reconcile → 1c
// reduce) over the 8 Ping frames. Opt-in: spawns the claude CLI 8+ times, so it is
// slow + costs tokens. Run with RUN_REAL_AI=1. Asserts the same canonical contract
// as the deterministic verify, but with descriptors the model actually produced.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { describeFrame } from '../../src/relay-server/canonicalize-ai/describe';
import { reconcileLexicon } from '../../src/relay-server/canonicalize-ai/reconcile';
import { reduceToCanonical, type ReduceFlow } from '../../src/relay-server/canonicalize-ai/reduce';
import type { FrameDescriptor } from '../../src/relay-server/canonicalize-ai/descriptor-schema';

const FIG = '5d055820-e6af-46f4-8ce5-14c35e9e44a3.fig';
const PROJECT = 'Ping';

const FRAMES = [
  { frameId: '283:1967', frameName: 'Login', width: 393, height: 852 },
  { frameId: '285:2443', frameName: 'Login filled', width: 393, height: 852 },
  { frameId: '294:3343', frameName: 'Settings', width: 393, height: 1161 },
  { frameId: '290:3657', frameName: 'Link Banks', width: 393, height: 852 },
  { frameId: '290:4046', frameName: 'Verify card', width: 393, height: 852 },
  { frameId: '290:4060', frameName: 'Card list', width: 393, height: 852 },
  { frameId: '315:3794', frameName: 'Alert 2', width: 375, height: 812 },
  { frameId: '315:3863', frameName: 'Alert 4', width: 375, height: 812 },
];

const FLOW: ReduceFlow = {
  entryFrameId: '283:1967',
  connections: [
    { from: '283:1967', to: '294:3343', type: 'push', label: 'Continue' },
    { from: '294:3343', to: '290:3657', type: 'push', label: 'Link Banks' },
    { from: '290:3657', to: '290:4046', type: 'push', label: 'Verify card' },
    { from: '290:4046', to: '290:4060', type: 'push', label: 'Success' },
    { from: '294:3343', to: '315:3794', type: 'modal', label: 'Show alert' },
  ],
};

const RUN = process.env.RUN_REAL_AI === '1';

(RUN ? describe : describe.skip)('Phase 1c full real-AI pipeline (Ping 8 frames)', () => {
  it('1a→1b→1c produces a coherent canonical model', async () => {
    const descriptors: FrameDescriptor[] = [];
    for (const f of FRAMES) {
      const { descriptor, rendered } = await describeFrame(PROJECT, FIG, f, { modelId: 'sonnet' });
      console.log(`[1a] ${f.frameId} role=${descriptor.role} name=${descriptor.semanticName} fp=${descriptor.fingerprint} rendered=${rendered} widgets=${descriptor.widgets.map(w => w.kind + (w.proposedName ? `(${w.proposedName})` : '')).join(',')}`);
      descriptors.push(descriptor);
    }
    const { lexicon, proposalMap, aiMerged } = await reconcileLexicon(PROJECT, descriptors, { persist: true });
    console.log(`[1b] learned=${lexicon.learned.map(e => e.canonicalName).join(',')} aiMerged=${aiMerged}`);

    const { canonical: c, aiRefined } = await reduceToCanonical(PROJECT, FIG, descriptors, lexicon, proposalMap, FLOW, { persist: true });
    console.log(`[1c] aiRefined=${aiRefined} hash=${c.contentHash}`);
    console.log('screens', c.screens.map(s => `${s.canonicalId}(${s.states.length})`).join(' '));
    console.log('modals', c.modals.map(m => `${m.canonicalId}->base:${m.baseCanonicalId}`).join(' '));
    console.log('components', c.components.map(x => `${x.canonicalName}×${x.usedIn.length}`).join(' '));
    console.log('warnings', c.warnings);

    // the Alert sheet must be a modal, not a screen.
    expect(c.modals.some(m => m.frameId === '315:3794')).toBe(true);
    expect(c.screens.some(s => s.frameIds.includes('315:3794'))).toBe(false);
    expect(c.contentHash).toMatch(/^[0-9a-f]{16}$/);
  }, 900_000);
});
