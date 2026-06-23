// T31 — Phase 8 (finalize) runs THROUGH the run + is visible in the Runs UI.
//
// Proves the three server fixes without a full 25-screen build (heavy AI is never
// invoked — the run uses a non-AI model so finalize's model is undefined, and the
// project is empty so finalize's deterministic passes bail fast):
//
//   1. /start on an all-`done` run takes the all-done FAST-PATH: ZERO screen
//      rebuilds (no `[loop] implement …` lines), reaches the finalize phase, and
//      emits `[finalize]` lines + a `Finalize` phase to the run log / run:state.
//   2. The run flips to `done` AND is marked `finalized:true` (so the UI drops the
//      Finalize action and won't re-offer it).
//   3. Accepting the LAST needs-review screen auto-kicks the finalize run (the
//      accept route logs `[review] last blocker cleared — auto-running finalize`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerScreenLoopRoutes } from '../src/relay-server/ai-screen-loop';
import { readRunLog, getRun, type BuildRun } from '../src/relay-server/build-run-store';
import { subscribeRunEvents } from '../src/relay-server/run-events';

const PROJECT_ID = 'app';
let tmpWorkspace: string;
let app: Express;

function makeRun(id: string, overrides: Partial<BuildRun> = {}): BuildRun {
  const now = new Date().toISOString();
  const screens = Array.from({ length: 5 }, (_, i) => ({
    frameId: `frame_${i + 1}`,
    frameName: `Screen ${i + 1}`,
    status: 'done' as const,
    matched: true,
    spec: { width: 390, height: 844 } as any,
  }));
  return {
    id, projectId: PROJECT_ID, kind: 'whole-app',
    framework: 'flutter',
    model: 'human',                 // NON-AI → finalize model is undefined (no AI calls)
    verify: true,
    screens, status: 'done',
    createdAt: now, updatedAt: now,
    ...overrides,
  } as BuildRun;
}

async function writeRun(run: BuildRun): Promise<void> {
  const root = path.join(tmpWorkspace, 'projects', PROJECT_ID);
  const runsDir = path.join(root, '.uix', 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8');
}

/** Poll until the run's log contains `needle` (or time out). Returns the full log. */
async function waitForLog(runId: string, needle: string, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await readRunLog(PROJECT_ID, runId);
    if (log.includes(needle)) return log;
    if (Date.now() > deadline) return log; // return what we have; the assertion reports it
    await new Promise(r => setTimeout(r, 150));
  }
}

/** Poll the run JSON until `status` is reached (terminal writes settle async). */
async function waitForStatus(runId: string, status: string, timeoutMs = 20000): Promise<BuildRun | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(PROJECT_ID, runId);
    if (run?.status === status) return run;
    if (Date.now() > deadline) return run;
    await new Promise(r => setTimeout(r, 100));
  }
}

beforeEach(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 't31-'));
  process.env.WORKSPACE = tmpWorkspace;
  await fs.mkdir(path.join(tmpWorkspace, 'projects', PROJECT_ID), { recursive: true });
  app = express();
  app.use(express.json({ limit: '10mb' }));
  registerScreenLoopRoutes(app);
});

afterEach(async () => {
  delete process.env.WORKSPACE;
  try { await fs.rm(tmpWorkspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('T31 — finalize runs through the run', () => {
  it('/start on an all-done run skips the build loop and runs finalize (zero rebuilds)', async () => {
    const runId = 'run_1700000000000_aaaa';
    await writeRun(makeRun(runId));

    const res = await request(app).post(`/api/ai/runs/${runId}/start`).send({ projectId: PROJECT_ID });
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);

    // Wait until the run actually reaches a terminal `[run] complete` line.
    const joined = await waitForLog(runId, '[run] complete');

    // (a) ZERO screen rebuilds: not a single `[loop] implement` line.
    expect(joined).not.toMatch(/\[loop] implement/);
    // The fast-path announces itself.
    expect(joined).toMatch(/all 5 target screen\(s\) already done — skipping build loop/);
    // (b) it reached finalize: the `[finalize]` phase lines streamed into the run log.
    expect(joined).toMatch(/\[finalize] starting P7 production passes/);
    // (c) the run is terminal-done AND marked finalized (drives the Runs UI).
    const run = await waitForStatus(runId, 'done');
    expect(run?.status).toBe('done');
    expect(run?.finalized).toBe(true);
    // The terminal phase pill is `Finalize` (phase 7/7, done:true).
    expect(run?.phase?.name).toBe('Finalize');
    expect(run?.phase?.done).toBe(true);
  }, 30000);

  it('a finalize:false all-done run still skips rebuilds, marks finalized, no finalize passes', async () => {
    const runId = 'run_1700000000001_bbbb';
    await writeRun(makeRun(runId, { finalize: false }));

    await request(app).post(`/api/ai/runs/${runId}/start`).send({ projectId: PROJECT_ID }).expect(200);
    const joined = await waitForLog(runId, '[run] complete');
    expect(joined).not.toMatch(/\[loop] implement/);
    expect(joined).not.toMatch(/\[finalize] starting P7/);   // finalize disabled → no passes
    const run = await waitForStatus(runId, 'done');
    if(run?.status!=='done'){ console.error('PROBE LOG:\n'+await readRunLog(PROJECT_ID,runId)); console.error('PROBE RUN:', JSON.stringify(run)); }
    expect(run?.status).toBe('done');
    expect(run?.finalized).toBe(true);     // a no-finalize run is "finalized" (nothing more to do)
  }, 30000);

  it('accepting the LAST needs-review screen auto-runs finalize through the run', async () => {
    const runId = 'run_1700000000002_cccc';
    // 4 done + 1 needs-review → blocking 1; accepting it should clear blocking → finalize.
    const run = makeRun(runId, { status: 'needs-review' });
    run.screens[4].status = 'needs-review';
    run.screens[4].matched = false;
    await writeRun(run);

    // T33: capture run:state statuses so we can prove the auto-finalize path flips
    // the run to `running` (via mutateRun/emitRunState) BEFORE runAppLoop, instead of
    // leaving the UI on a `done` run with no live stream.
    const statuses: string[] = [];
    const unsub = subscribeRunEvents((e) => {
      if (e.type === 'run:state' && e.runId === runId && e.status) statuses.push(e.status);
    });

    const res = await request(app)
      .post(`/api/ai/runs/${runId}/accept`)
      .send({ projectId: PROJECT_ID, frameId: 'frame_5' });
    expect(res.status).toBe(200);

    // The accept route fired the auto-finalize trigger…
    const log = await waitForLog(runId, '[review] last blocker cleared');
    expect(log).toMatch(/\[review] last blocker cleared — auto-running finalize/);
    // T33: the run flipped to `running` for the live finalize stream.
    expect(statuses).toContain('running');
    unsub();
    // …and finalize ran through THIS run (no rebuilds) to terminal done.
    const joined = await waitForLog(runId, '[run] complete');
    expect(joined).not.toMatch(/\[loop] implement/);
    expect(joined).toMatch(/\[finalize] starting P7 production passes/);
    const after = await waitForStatus(runId, 'done');
    expect(after?.status).toBe('done');
    expect(after?.finalized).toBe(true);
  }, 30000);
});
