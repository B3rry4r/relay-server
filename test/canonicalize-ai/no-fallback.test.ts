// =============================================================================
// RFC v2 T3 / §0.1 — NO SILENT FALLBACK proof (no real AI; bogus runner).
//
//   (a) when the AI does NOT fire, the wired heavy-AI path (aiCanonicalize) THROWS
//       AiNotFiredError — it does NOT silently emit a deterministic canonical;
//   (b) the EXPLICIT degraded path (canonicalizeRun, the deterministic clusterer) DOES
//       produce a Canonical without any AI — the only permitted non-AI route.
//
// We bind a runner that always returns empty text so requireModel's no-fire detection
// fires (AiNotFiredError), proving the chain can't be tricked into a deterministic stub.
// =============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import { setRunModel, AiNotFiredError } from '../../src/relay-server/ai-observability';
import { canonicalize as aiCanonicalize } from '../../src/relay-server/canonicalize-ai/orchestrate';
import { canonicalizeRun } from '../../src/relay-server/canonicalize';
import type { DescribeFrameInput } from '../../src/relay-server/canonicalize-ai/describe';
import type { ReduceFlow } from '../../src/relay-server/canonicalize-ai/reduce';
import type { RunScreen, RunFlow } from '../../src/relay-server/build-run-store';

const FIG = '5d055820-e6af-46f4-8ce5-14c35e9e44a3.fig';
const PROJECT = 'Ping';

const FRAMES: DescribeFrameInput[] = [
  { frameId: '283:1967', frameName: 'Login', width: 393, height: 852 },
  { frameId: '294:3343', frameName: 'Settings', width: 393, height: 1161 },
];

const FLOW: ReduceFlow = {
  entryFrameId: '283:1967',
  connections: [{ from: '283:1967', to: '294:3343', type: 'push' }],
};

describe('RFC T3 no silent fallback', () => {
  afterAll(() => { setRunModel(null as any); });

  it('the wired AI path THROWS when the model does not fire (no deterministic stub)', async () => {
    // Bind a runner that always returns empty text → requireModel raises AiNotFiredError.
    setRunModel(async () => ({ text: '', sessionId: undefined } as any));

    let threw: unknown = null;
    try {
      await aiCanonicalize(PROJECT, FIG, FRAMES, FLOW, { runId: `t3-nofire-${Date.now()}`, modelId: 'sonnet' });
    } catch (e) {
      threw = e;
    }
    // It must FAIL LOUD, not return a (deterministic) canonical.
    expect(threw).toBeInstanceOf(AiNotFiredError);
  });

  it('the explicit degraded path (canonicalizeRun) produces a Canonical with NO AI', () => {
    const screens: RunScreen[] = [
      { frameId: '283:1967', frameName: 'Login', status: 'pending', spec: { packet: '', referenceImagePath: '', width: 393, height: 852, tree: 'Screen: Login (393×852)\n├─ AppBar [ROW, h:56]\n│   ├─ Text "Login"' } },
      { frameId: '294:3343', frameName: 'Settings', status: 'pending', spec: { packet: '', referenceImagePath: '', width: 393, height: 1161, tree: 'Screen: Settings (393×1161)\n├─ AppBar [ROW, h:56]\n│   ├─ Text "Settings"' } },
    ];
    const flow: RunFlow = { entryFrameId: '283:1967', connections: [{ from: '283:1967', to: '294:3343', type: 'push' }] };
    const canonical = canonicalizeRun(screens, flow);
    expect(canonical.version).toBe(1);
    expect(canonical.screens.length).toBeGreaterThan(0);
    expect(Object.keys(canonical.frameMap).length).toBeGreaterThan(0);
  });
});
