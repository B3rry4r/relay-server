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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// HERMETIC INPUTS. This proof is about what the chain does when the MODEL does not
// fire — not about the Figma IR or the render harness. It used to read the real Ping
// IR from the UIX service and need a `Ping` project under /workspace/projects, so on
// any machine without both it failed at describeFrame's project/IR preconditions
// ("project not found") before the model was ever asked, proving nothing. Stub only
// the IR/reference inputs (a real-shaped tree per frame; no reference image) and give
// it a throwaway WORKSPACE with a `Ping` project; the describe → requireModel path
// under test is the real one.
const IR_TREES: Record<string, string> = {
  '283:1967': 'Screen: Login (393×852)\n├─ AppBar [ROW, h:56]\n│   ├─ Text "Login"\n├─ Button "Continue"',
  '294:3343': 'Screen: Settings (393×1161)\n├─ AppBar [ROW, h:56]\n│   ├─ Text "Settings"\n├─ ListTile "Link Banks"',
};
vi.mock('../../src/relay-server/reference-render', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/relay-server/reference-render')>();
  return {
    ...real,
    getNodeTree: vi.fn(async (_fig: string, nodeId: string) => IR_TREES[nodeId] ?? ''),
    renderFrameReference: vi.fn(async () => null),
  };
});
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
  let workspace: string;
  const prevWorkspace = process.env.WORKSPACE;
  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'no-fallback-ws-'));
    await fs.mkdir(path.join(workspace, 'projects', PROJECT), { recursive: true });
    process.env.WORKSPACE = workspace;
  });
  afterAll(async () => {
    setRunModel(null as any);
    if (prevWorkspace === undefined) delete process.env.WORKSPACE; else process.env.WORKSPACE = prevWorkspace;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('the wired AI path THROWS when the model does not fire (no deterministic stub)', async () => {
    // Bind a runner that always returns empty text → requireModel raises AiNotFiredError.
    let modelCalls = 0;
    setRunModel(async () => { modelCalls++; return { text: '', sessionId: undefined } as any; });

    let threw: unknown = null;
    try {
      await aiCanonicalize(PROJECT, FIG, FRAMES, FLOW, { runId: `t3-nofire-${Date.now()}`, modelId: 'sonnet' });
    } catch (e) {
      threw = e;
    }
    // It must FAIL LOUD, not return a (deterministic) canonical — and it must be the
    // MODEL that was asked and did not fire, not a precondition that failed first.
    expect(threw).toBeInstanceOf(AiNotFiredError);
    expect(modelCalls).toBeGreaterThan(0);
    // No descriptor was persisted for a frame the model never described.
    await expect(fs.access(path.join(workspace, 'projects', PROJECT, '.uix', 'canon-descriptors.json'))).rejects.toThrow();
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
