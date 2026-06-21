// =============================================================================
// RFC v2 T3 — REAL-AI SEAM proof. Runs the EXACT path runAppLoop wires:
//   aiCanonicalize(projectId, figStorageKey, frames, flow, { runId })  →  the heavy
//   chain (1a describe → 1b reconcile → 1c reduce → 1d adjudicate) firing real claude
//   →  aiModelToCanonical(model)  →  the build-flow Canonical (screens/frameMap/flow).
//
// Opt-in (RUN_REAL_AI=1): spawns the claude CLI per frame, so it's slow + costs tokens.
// 4 Ping frames are enough to prove the seam. Asserts:
//   - AI FIRED (stages.describedFrames > 0; the run log carries [ai:canon.*] status=ok);
//   - a valid CanonicalModel came back;
//   - the adapter produced a valid build Canonical (screens, frameMap covers frames, flow).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { canonicalize as aiCanonicalize } from '../../src/relay-server/canonicalize-ai/orchestrate';
import { aiModelToCanonical } from '../../src/relay-server/canonicalize-ai/to-canonical';
import type { DescribeFrameInput } from '../../src/relay-server/canonicalize-ai/describe';
import type { ReduceFlow } from '../../src/relay-server/canonicalize-ai/reduce';
import { readRunLog } from '../../src/relay-server/build-run-store';

const FIG = '5d055820-e6af-46f4-8ce5-14c35e9e44a3.fig';
const PROJECT = 'Ping';

const FRAMES: DescribeFrameInput[] = [
  { frameId: '283:1967', frameName: 'Login', width: 393, height: 852 },
  { frameId: '294:3343', frameName: 'Settings', width: 393, height: 1161 },
  { frameId: '290:3657', frameName: 'Link Banks', width: 393, height: 852 },
  { frameId: '315:3794', frameName: 'Alert 2', width: 375, height: 812 },
];

const FLOW: ReduceFlow = {
  entryFrameId: '283:1967',
  connections: [
    { from: '283:1967', to: '294:3343', type: 'push', label: 'Continue' },
    { from: '294:3343', to: '290:3657', type: 'push', label: 'Link Banks' },
    { from: '294:3343', to: '315:3794', type: 'modal', label: 'Show alert' },
  ],
};

const RUN = process.env.RUN_REAL_AI === '1';

(RUN ? describe : describe.skip)('RFC T3 real-AI seam (Ping 4 frames)', () => {
  it('aiCanonicalize → adapter produces a valid build Canonical with AI fired', async () => {
    const runId = `t3-seam-${Date.now()}`;
    const result = await aiCanonicalize(PROJECT, FIG, FRAMES, FLOW, { runId, modelId: 'sonnet' });

    // AI fired.
    console.log('[seam] stages', JSON.stringify(result.stages));
    expect(result.stages.describedFrames).toBe(FRAMES.length);

    // valid CanonicalModel.
    const model = result.canonical;
    expect(model.version).toBe(1);
    expect(model.screens.length).toBeGreaterThan(0);
    console.log('[seam] model screens', model.screens.map(s => s.canonicalId).join(' '));
    console.log('[seam] model modals', model.modals.map(m => `${m.canonicalId}->base:${m.baseCanonicalId}`).join(' '));

    // adapter → build Canonical.
    const canonical = aiModelToCanonical(model);
    expect(canonical.version).toBe(1);
    expect(canonical.screens.length).toBeGreaterThan(0);
    // frameMap covers every input frame.
    for (const f of FRAMES) expect(canonical.frameMap[f.frameId]).toBeTruthy();
    // flow carried through.
    expect(canonical.flow).toBeDefined();
    console.log('[seam] canonical screens', canonical.screens.map(s => `${s.canonicalId}(states:${s.states.length},modals:${s.modals.length})`).join(' '));
    console.log('[seam] frameMap', JSON.stringify(canonical.frameMap));

    // the firing proof landed in the DURABLE run log (runId threaded through).
    const log = await readRunLog(PROJECT, runId);
    console.log('[seam] run log AI lines:\n' + log.split('\n').filter(l => /\[ai:canon\./.test(l)).join('\n'));
    expect(/\[ai:canon\.\w+\].*status=ok/.test(log)).toBe(true);
  }, 600_000);
});
