// =============================================================================
// P3 — analyzer ERRORS gate run completion.
//
// The Ping run logged `[run] complete — 35/35 built` while flutter analyze
// reported 17 ERRORS (finalize only measured baseline/final analyze and moved
// on). These tests prove:
//   • runAnalyzeGate: 0 errors passes; N errors with no model parks (no repair);
//     N errors with a model makes ONE bounded repair attempt then re-measures;
//     an unmeasurable analyzer NEVER blocks blind; the persisted finalErrors is
//     the fallback measurement.
//   • analyzeGateEnabled: default ON; RELAY_ANALYZE_GATE=off / run.analyzeGate
//     false disable it.
//   • Through the run (t31-style harness): analyzer errors → the run parks
//     'needs-review' with the loud `run NOT complete` line and finalized stays
//     false; 0 errors → completes; env off → old complete-anyway behavior.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAnalyzeGate, analyzeGateEnabled } from '../src/relay-server/passes/finalize';
import { registerScreenLoopRoutes } from '../src/relay-server/ai-screen-loop';
import { readRunLog, getRun, type BuildRun } from '../src/relay-server/build-run-store';

// ── unit: runAnalyzeGate ──────────────────────────────────────────────────────

const analyzeSeq = (results: Array<{ errors: number; errorLines?: string[] } | null>) => {
  let i = 0;
  const calls: number[] = [];
  const fn = async () => {
    calls.push(i);
    const r = results[Math.min(i++, results.length - 1)];
    return r ? { total: r.errors, errors: r.errors, errorLines: r.errorLines ?? [] } : null;
  };
  return { fn, calls };
};

describe('runAnalyzeGate (unit)', () => {
  it('0 errors → passes, no repair attempted', async () => {
    const a = analyzeSeq([{ errors: 0 }]);
    let modelCalls = 0;
    const g = await runAnalyzeGate({
      projectRoot: '/tmp/x', analyze: a.fn,
      model: 'claude' as any,
      runModel: async () => { modelCalls++; return { text: 'ok' }; },
    });
    expect(g.ok).toBe(true);
    expect(g.errors).toBe(0);
    expect(g.repairAttempted).toBe(false);
    expect(modelCalls).toBe(0);
  });

  it('unmeasurable analyzer + no fallback → passes (never blocks blind)', async () => {
    const g = await runAnalyzeGate({ projectRoot: '/tmp/x', analyze: async () => null });
    expect(g.ok).toBe(true);
    expect(g.errors).toBeNull();
    expect(g.repairAttempted).toBe(false);
  });

  it('N errors, no model/runner → blocks without a repair attempt', async () => {
    const a = analyzeSeq([{ errors: 17 }]);
    const g = await runAnalyzeGate({ projectRoot: '/tmp/x', analyze: a.fn });
    expect(g.ok).toBe(false);
    expect(g.errors).toBe(17);
    expect(g.repairAttempted).toBe(false);
  });

  it('N errors + model → ONE bounded repair ("change nothing else", lists the errors) then re-measure; fixed → passes', async () => {
    const a = analyzeSeq([
      { errors: 3, errorLines: ['error • Undefined name x • lib/a.dart:1:1', 'error • y • lib/b.dart:2:2', 'error • z • lib/c.dart:3:3'] },
      { errors: 0 },
    ]);
    const prompts: string[] = [];
    const g = await runAnalyzeGate({
      projectRoot: '/tmp/x', analyze: a.fn,
      model: 'claude' as any,
      runModel: async (_m, prompt) => { prompts.push(prompt); return { text: 'fixed' }; },
    });
    expect(g.ok).toBe(true);
    expect(g.errors).toBe(0);
    expect(g.initialErrors).toBe(3);
    expect(g.repairAttempted).toBe(true);
    expect(prompts).toHaveLength(1);                          // ONE bounded attempt
    expect(prompts[0]).toContain('Fix these 3 analyzer errors, change nothing else');
    expect(prompts[0]).toContain('Undefined name x');
    expect(a.calls.length).toBe(2);                           // measure + re-measure
  });

  it('N errors + model, repair does NOT fix → still blocks with the remaining count', async () => {
    const a = analyzeSeq([{ errors: 5 }, { errors: 2 }]);
    const g = await runAnalyzeGate({
      projectRoot: '/tmp/x', analyze: a.fn,
      model: 'claude' as any,
      runModel: async () => ({ text: 'tried' }),
    });
    expect(g.ok).toBe(false);
    expect(g.errors).toBe(2);
    expect(g.repairAttempted).toBe(true);
  });

  it('a THROWING repair is non-fatal — re-measures and verdicts normally', async () => {
    const a = analyzeSeq([{ errors: 4 }, { errors: 4 }]);
    const g = await runAnalyzeGate({
      projectRoot: '/tmp/x', analyze: a.fn,
      model: 'claude' as any,
      runModel: async () => { throw new Error('rate limited'); },
    });
    expect(g.ok).toBe(false);
    expect(g.errors).toBe(4);
    expect(g.repairAttempted).toBe(true);
  });

  it('live analyzer unavailable → falls back to the persisted finalErrors', async () => {
    const g = await runAnalyzeGate({ projectRoot: '/tmp/x', analyze: async () => null, initialErrors: 17 });
    expect(g.ok).toBe(false);
    expect(g.errors).toBe(17);
    expect(g.initialErrors).toBe(17);
  });
});

describe('analyzeGateEnabled', () => {
  it('defaults ON', () => {
    expect(analyzeGateEnabled(undefined, {})).toBe(true);
    expect(analyzeGateEnabled({}, {})).toBe(true);
  });
  it('env RELAY_ANALYZE_GATE=off|0|false disables', () => {
    expect(analyzeGateEnabled(undefined, { RELAY_ANALYZE_GATE: 'off' })).toBe(false);
    expect(analyzeGateEnabled(undefined, { RELAY_ANALYZE_GATE: '0' })).toBe(false);
    expect(analyzeGateEnabled(undefined, { RELAY_ANALYZE_GATE: 'false' })).toBe(false);
    expect(analyzeGateEnabled(undefined, { RELAY_ANALYZE_GATE: 'on' })).toBe(true);
  });
  it('run flag analyzeGate:false disables', () => {
    expect(analyzeGateEnabled({ analyzeGate: false }, {})).toBe(false);
    expect(analyzeGateEnabled({ analyzeGate: true }, {})).toBe(true);
  });
});

// ── through the run (t31-style harness) ──────────────────────────────────────

const PROJECT_ID = 'app';
let tmpWorkspace: string;
let app: Express;

function makeRun(id: string, overrides: Partial<BuildRun> = {}): BuildRun {
  const now = new Date().toISOString();
  const screens = Array.from({ length: 3 }, (_, i) => ({
    frameId: `frame_${i + 1}`,
    frameName: `Screen ${i + 1}`,
    status: 'done' as const,
    matched: true,
    spec: { width: 390, height: 844 } as any,
  }));
  return {
    id, projectId: PROJECT_ID, kind: 'whole-app',
    framework: 'flutter',
    model: 'human',                 // NON-AI → no repair attempt fires in tests
    verify: true,
    screens, status: 'done',
    createdAt: now, updatedAt: now,
    ...overrides,
  } as BuildRun;
}

async function writeRun(run: BuildRun): Promise<void> {
  const runsDir = path.join(tmpWorkspace, 'projects', PROJECT_ID, '.uix', 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8');
}

/** A pre-existing finalize report → the run's finalize branch SKIPS finalizeApp
 *  and the gate falls back to the persisted finalErrors (no flutter SDK in the
 *  tmp workspace, so the live analyzer is unavailable). */
async function writeFinalizeReport(finalErrors: number): Promise<void> {
  const uix = path.join(tmpWorkspace, 'projects', PROJECT_ID, '.uix');
  await fs.mkdir(uix, { recursive: true });
  await fs.writeFile(path.join(uix, 'finalize-report.json'), JSON.stringify({
    version: 1, projectId: PROJECT_ID, framework: 'flutter', dryRun: false,
    passes: [], baselineAnalyze: 28, finalAnalyze: 28, baselineErrors: finalErrors, finalErrors,
  }, null, 2), 'utf-8');
}

async function waitForLog(runId: string, needle: string, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await readRunLog(PROJECT_ID, runId);
    if (log.includes(needle)) return log;
    if (Date.now() > deadline) return log;
    await new Promise(r => setTimeout(r, 100));
  }
}

beforeEach(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'p3gate-'));
  process.env.WORKSPACE = tmpWorkspace;
  await fs.mkdir(path.join(tmpWorkspace, 'projects', PROJECT_ID), { recursive: true });
  app = express();
  app.use(express.json({ limit: '10mb' }));
  registerScreenLoopRoutes(app);
});

afterEach(async () => {
  delete process.env.WORKSPACE;
  delete process.env.RELAY_ANALYZE_GATE;
  try { await fs.rm(tmpWorkspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('P3 analyze gate through the run', () => {
  it('analyzer errors → parks needs-review with the loud line; finalized stays false', async () => {
    const runId = 'run_1700000000010_gate';
    await writeRun(makeRun(runId));
    await writeFinalizeReport(17);

    await request(app).post(`/api/ai/runs/${runId}/start`).send({ projectId: PROJECT_ID }).expect(200);
    const log = await waitForLog(runId, 'run NOT complete');

    expect(log).toContain('[finalize] 17 analyzer error(s) remain — run NOT complete');
    expect(log).not.toContain('[run] complete');
    const run = await getRun(PROJECT_ID, runId);
    expect(run?.status).toBe('needs-review');
    expect(run?.finalized ?? false).toBe(false);   // NOT finalize-complete
  }, 30000);

  it('0 analyzer errors → completes and finalizes as before', async () => {
    const runId = 'run_1700000000011_ok';
    await writeRun(makeRun(runId));
    await writeFinalizeReport(0);

    await request(app).post(`/api/ai/runs/${runId}/start`).send({ projectId: PROJECT_ID }).expect(200);
    const log = await waitForLog(runId, '[run] complete');

    expect(log).toContain('[run] complete');
    expect(log).not.toContain('run NOT complete');
    const run = await getRun(PROJECT_ID, runId);
    expect(run?.status).toBe('done');
    expect(run?.finalized).toBe(true);
  }, 30000);

  it('RELAY_ANALYZE_GATE=off → old behavior (completes despite errors, logs the gate is off)', async () => {
    process.env.RELAY_ANALYZE_GATE = 'off';
    const runId = 'run_1700000000012_off';
    await writeRun(makeRun(runId));
    await writeFinalizeReport(17);

    await request(app).post(`/api/ai/runs/${runId}/start`).send({ projectId: PROJECT_ID }).expect(200);
    const log = await waitForLog(runId, '[run] complete');

    expect(log).toContain('[finalize] analyze gate OFF');
    expect(log).toContain('[run] complete');
    const run = await getRun(PROJECT_ID, runId);
    expect(run?.status).toBe('done');
    expect(run?.finalized).toBe(true);
  }, 30000);
});
