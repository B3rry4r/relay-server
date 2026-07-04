// =============================================================================
// P2 — reduce.ts fixes, unit-level (deterministic: skipAi + persist:false).
//
//   1. MODAL→BASE BINDING honours the VISUAL backdrop: when the 1a descriptor's
//      isModalGuess.base names a DIFFERENT existing screen than the flow edge-from,
//      the base is overridden to the visual backdrop (+ a warning); the trigger
//      keeps the edge-from screen. An unresolvable guess changes nothing.
//   2. STEP-MODALS: an edge FROM a modal frame re-parents onto the base screen but
//      carries `viaModalId` provenance (the sheet step is not erased).
//   3. 'replace' edges survive the flow rewrite (no silent replace→push collapse).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { reduceToCanonical, type ReduceFlow } from '../../src/relay-server/canonicalize-ai/reduce';
import type { FrameDescriptor } from '../../src/relay-server/canonicalize-ai/descriptor-schema';
import type { FrozenLexicon } from '../../src/relay-server/canonicalize-ai/reconcile';

const LEXICON: FrozenLexicon = {
  lexiconVersion: 'lex-v1', projectId: 'p2-test', contentHash: 'x', base: [], learned: [],
};

function screenDesc(frameId: string, sem: string, fp: string): FrameDescriptor {
  return {
    frameId, role: 'screen', semanticName: sem,
    sections: [{ kind: 'content', brief: sem }],
    widgets: [{ kind: 'primaryButton', count: 1, fingerprint: `w_${frameId}` }],
    fingerprint: fp, proposals: [],
  };
}
function modalDesc(frameId: string, sem: string, fp: string, guessBase?: string): FrameDescriptor {
  const d: FrameDescriptor = {
    frameId, role: 'modal', semanticName: sem,
    sections: [{ kind: 'card', brief: sem }],
    widgets: [{ kind: 'scrim', count: 1, fingerprint: `w_${frameId}` }],
    fingerprint: fp, proposals: [],
  };
  if (guessBase) d.isModalGuess = { base: guessBase, trigger: 'tap something' };
  return d;
}

// Screens: otp (edge-from), cardList (visual backdrop), qr. Modal: loading (over
// cardList per the descriptor, but the flow edge comes FROM otp).
const DESCRIPTORS: FrameDescriptor[] = [
  screenDesc('10:1', 'otpScreen', 'fp_otp'),
  screenDesc('10:2', 'cardListSuccessScreen', 'fp_cardlist'),
  screenDesc('10:3', 'qrScreen', 'fp_qr'),
  screenDesc('10:5', 'welcomeScreen', 'fp_welcome'),
  modalDesc('10:4', 'cardAddedLoadingModal', 'fp_loading', 'cardListScreen'),   // fuzzy: no exact sem match
  modalDesc('10:6', 'selectedBankSheet', 'fp_bank'),
  modalDesc('10:7', 'mysteryModal', 'fp_mystery', 'somethingNonexistent'),
];

const FLOW: ReduceFlow = {
  entryFrameId: '10:5',
  connections: [
    { from: '10:5', to: '10:1', type: 'replace', label: 'Start' },              // replace preserved
    { from: '10:1', to: '10:4', type: 'modal', label: 'Loading state' },        // edge-from = otp; visual = cardList
    { from: '10:1', to: '10:6', type: 'modal', label: 'Selected Bank' },
    { from: '10:6', to: '10:3', type: 'push', label: 'Confirm' },               // FROM the modal → viaModalId
    { from: '10:1', to: '10:7', type: 'modal', label: 'Mystery' },              // unresolvable guess → edge-from stands
  ],
};

async function reduce() {
  return reduceToCanonical('p2-reduce-test-no-such-project', 'test.fig', DESCRIPTORS, LEXICON, {}, FLOW, {
    skipAi: true, persist: false,
  });
}

describe('P2 reduce: visual-backdrop modal binding', () => {
  it('overrides the edge-from base with the described visual backdrop (+ warning), keeping the edge-from trigger', async () => {
    const { canonical } = await reduce();
    const loading = canonical.modals.find(m => m.canonicalId === 'm_10_4')!;
    expect(loading).toBeTruthy();
    // base = the VISUAL backdrop (cardListScreen ⇒ cardListSuccessScreen, token containment)
    expect(loading.baseCanonicalId).toBe('c_10_2');
    // trigger = the edge-from screen (otp), with the edge's label
    expect(loading.trigger.fromScreen).toBe('c_10_1');
    expect(loading.trigger.element).toBe('Loading state');
    // warning records the override
    expect(canonical.warnings.some(w => /cardAddedLoadingModal/.test(w) && /visual backdrop/i.test(w))).toBe(true);
  });

  it('keeps the edge-from base when the guess does not resolve to a real screen (no guessing)', async () => {
    const { canonical } = await reduce();
    const mystery = canonical.modals.find(m => m.canonicalId === 'm_10_7')!;
    expect(mystery.baseCanonicalId).toBe('c_10_1');
    expect(mystery.trigger.fromScreen).toBe('c_10_1');
    expect(canonical.warnings.some(w => /mysteryModal/.test(w) && /visual backdrop/i.test(w))).toBe(false);
  });

  it('keeps the edge-from base when there is no guess at all', async () => {
    const { canonical } = await reduce();
    const bank = canonical.modals.find(m => m.canonicalId === 'm_10_6')!;
    expect(bank.baseCanonicalId).toBe('c_10_1');
  });
});

describe('P2 reduce: step-modal provenance + replace preservation', () => {
  it('sets viaModalId on an edge whose raw `from` was a modal frame (re-parented onto the base)', async () => {
    const { canonical } = await reduce();
    const via = canonical.flow.edges.find(e => e.viaModalId);
    expect(via).toBeTruthy();
    expect(via!.from).toBe('c_10_1');            // re-parented onto the modal's base screen
    expect(via!.to).toBe('c_10_3');              // still reaches the push target
    expect(via!.kind).toBe('push');
    expect(via!.viaModalId).toBe('m_10_6');      // …but the sheet step is recorded
  });

  it("preserves kind 'replace' through the flow rewrite", async () => {
    const { canonical } = await reduce();
    const rep = canonical.flow.edges.find(e => e.from === 'c_10_5' && e.to === 'c_10_1');
    expect(rep).toBeTruthy();
    expect(rep!.kind).toBe('replace');
  });

  it('screen→screen edges without modal provenance carry no viaModalId', async () => {
    const { canonical } = await reduce();
    for (const e of canonical.flow.edges.filter(e => e.kind === 'overlay')) {
      expect(e.viaModalId).toBeUndefined();
    }
  });
});
