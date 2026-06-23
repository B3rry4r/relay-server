// =============================================================================
// T28 — DESCRIBE CACHE + PARALLEL + GRANULAR PROGRESS proofs.
//
// 1. The descriptor cache is WRITTEN (canon-descriptors.json appears) and REUSED:
//    a second canonicalize over the same (unchanged) frames SKIPS the describe AI
//    call for cached frames; a CHANGED frame (different fingerprint) re-describes.
// 2. Describe runs CONCURRENTLY (the pool overlaps frame calls) — proven by a
//    runner that records max concurrent in-flight describe calls.
// 3. The `describing N/total` granular progress is emitted as frames resolve.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the reference-render seam describeFrame uses so we don't touch the UIX harness
// or render Chrome. getNodeTree returns a per-frame IR tree (its TEXT determines the
// frame fingerprint, so changing it = a "changed frame"); renderFrameReference is a
// no-op (no image). All other exports pass through (orchestrate doesn't need them).
const trees = new Map<string, string>();
vi.mock('../../src/relay-server/reference-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/relay-server/reference-render')>();
  return {
    ...actual,
    getNodeTree: vi.fn(async (_figKey: string, frameId: string) => trees.get(frameId) ?? ''),
    renderFrameReference: vi.fn(async () => null),
  };
});

let workspace: string;
let projectId: string;
let projectRoot: string;
let prevWorkspace: string | undefined;
let prevPool: string | undefined;

beforeAll(() => {
  prevWorkspace = process.env.WORKSPACE;
  prevPool = process.env.RELAY_CANON_DESCRIBE_POOL;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-t28-'));
  process.env.WORKSPACE = workspace;
  projectId = 'proj_t28';
  projectRoot = path.join(workspace, 'projects', projectId);
  fs.mkdirSync(projectRoot, { recursive: true });
});
afterAll(() => {
  // Restore env so sibling test files (which depend on WORKSPACE) aren't poisoned.
  if (prevWorkspace === undefined) delete process.env.WORKSPACE; else process.env.WORKSPACE = prevWorkspace;
  if (prevPool === undefined) delete process.env.RELAY_CANON_DESCRIBE_POOL; else process.env.RELAY_CANON_DESCRIBE_POOL = prevPool;
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});
afterEach(() => { vi.restoreAllMocks(); });

// A schema-valid descriptor JSON the mock runner returns for every describe call.
const DESCRIBE_JSON = JSON.stringify({
  role: 'screen', semanticName: 'home',
  sections: [{ kind: 'header', brief: 'top bar' }],
  widgets: [{ kind: 'primaryButton', count: 1 }],
  proposals: [],
});

// Three distinct frames (distinct IR trees → distinct fingerprints).
function seedFrames(): void {
  trees.clear();
  trees.set('f1', 'container "A" [393×852]\n├── text "t1" [100×20] "Hi"');
  trees.set('f2', 'container "B" [393×852]\n├── text "t2" [100×20] "Yo"');
  trees.set('f3', 'container "C" [393×852]\n├── icon "i3" [24×24]');
}
const FRAMES = [
  { frameId: 'f1', frameName: 'A', width: 393, height: 852 },
  { frameId: 'f2', frameName: 'B', width: 393, height: 852 },
  { frameId: 'f3', frameName: 'C', width: 393, height: 852 },
];

import { canonicalize } from '../../src/relay-server/canonicalize-ai/orchestrate';
import { setRunModel, type RunModelLike } from '../../src/relay-server/ai-observability';

describe('T28 describe cache + parallel + progress', () => {
  afterEach(() => { setRunModel(null as unknown as RunModelLike); });

  it('writes the descriptor cache, reuses it on re-run, and re-describes a CHANGED frame', async () => {
    process.env.RELAY_CANON_DESCRIBE_POOL = '3';
    seedFrames();
    const cacheFile = path.join(projectRoot, '.uix', 'canon-descriptors.json');
    try { fs.rmSync(cacheFile, { force: true }); } catch { /* ignore */ }

    // ── First canon: every frame's describe AI call fires. Count describe calls.
    let describeCalls1 = 0;
    setRunModel(async (_m, prompt) => {
      // describe prompts contain "UI design ANALYST"; reconcile/reduce/adjudicate differ.
      if (/UI design ANALYST/.test(prompt)) describeCalls1++;
      // Return the descriptor for describe; an empty {} is harmless for other stages
      // (they validate/parse their own shapes and degrade — skipAi keeps them cheap).
      return { text: /UI design ANALYST/.test(prompt) ? DESCRIBE_JSON : '{}' };
    });
    const r1 = await canonicalize(projectId, 'figkey', FRAMES as any, undefined, { skipAi: true, persist: false });
    expect(describeCalls1).toBe(3);                       // all 3 described
    expect(r1.descriptors.length).toBe(3);
    expect(fs.existsSync(cacheFile)).toBe(true);          // cache WRITTEN

    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(Object.keys(cache.frames).sort()).toEqual(['f1', 'f2', 'f3']);
    const f3fp = cache.frames.f3.fingerprint;

    // ── Second canon over the SAME frames: describe AI call must be SKIPPED (cache hit).
    let describeCalls2 = 0;
    setRunModel(async (_m, prompt) => {
      if (/UI design ANALYST/.test(prompt)) describeCalls2++;
      return { text: /UI design ANALYST/.test(prompt) ? DESCRIBE_JSON : '{}' };
    });
    const r2 = await canonicalize(projectId, 'figkey', FRAMES as any, undefined, { skipAi: true, persist: false });
    expect(describeCalls2).toBe(0);                       // ALL cached → no describe calls
    expect(r2.descriptors.length).toBe(3);

    // ── Change f3's structure → its fingerprint changes → ONLY f3 re-describes.
    trees.set('f3', 'container "C" [393×852]\n├── icon "i3" [24×24]\n├── text "extra" [80×20] "new"');
    let describeCalls3 = 0;
    const describedIds: string[] = [];
    setRunModel(async (_m, prompt) => {
      if (/UI design ANALYST/.test(prompt)) {
        describeCalls3++;
        const m = prompt.match(/id="([^"]+)"/);
        if (m) describedIds.push(m[1]);
      }
      return { text: /UI design ANALYST/.test(prompt) ? DESCRIBE_JSON : '{}' };
    });
    const r3 = await canonicalize(projectId, 'figkey', FRAMES as any, undefined, { skipAi: true, persist: false });
    expect(describeCalls3).toBe(1);                       // f1/f2 cached, only f3 changed
    expect(describedIds).toEqual(['f3']);
    expect(r3.descriptors.length).toBe(3);

    const cache3 = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cache3.frames.f3.fingerprint).not.toBe(f3fp); // fingerprint advanced
  });

  it('describes frames CONCURRENTLY (bounded by the pool) and emits describing N/total', async () => {
    process.env.RELAY_CANON_DESCRIBE_POOL = '3';
    seedFrames();
    try { fs.rmSync(path.join(projectRoot, '.uix', 'canon-descriptors.json'), { force: true }); } catch { /* ignore */ }

    let inFlight = 0, maxInFlight = 0;
    setRunModel(async (_m, prompt) => {
      if (/UI design ANALYST/.test(prompt)) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 40));        // hold so calls overlap
        inFlight--;
        return { text: DESCRIBE_JSON };
      }
      return { text: '{}' };
    });

    const progress: string[] = [];
    await canonicalize(projectId, 'figkey', FRAMES as any, undefined, {
      skipAi: true, persist: false,
      onDescribeProgress: (p) => { if (p.stage === 'describe') progress.push(`describing ${p.done}/${p.total}`); },
    });

    // POOL=3 + 3 frames → all three describe calls run at once.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Granular progress reached the final frame.
    expect(progress).toContain('describing 3/3');
    expect(progress.length).toBe(3);
  });
});
