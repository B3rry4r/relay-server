// =============================================================================
// P3 — REAL flow-wiring gaps requeue their FROM screens (no more warn-only).
//
// The Ping run shipped 4 known-missing modals: verifyFlowWiring reported them as
// `unmapped` "REAL gap — no presenter wires it" but nothing consumed the report.
// These tests prove:
//   • planFlowRequeue (pure): HIGH-class findings (unmapped REAL-gap /
//     tab-as-push / missing-step-presenter) map to their FROM screen's LEAD
//     frame; benign statuses (duplicate/wired) never requeue; findings for one
//     screen merge into ONE decision; a modal-id FROM resolves to its base
//     screen; non-'done' screens are never flipped (the idempotency half that
//     protects existing parks).
//   • requeueFlowGaps (orchestration): flips the right run screens to
//     needs-review with the findings as the review reason, and a second call
//     is a no-op (screens no longer 'done').
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planFlowRequeue, type FlowFindingLike, type CanonScreenLike, type RunScreenLike } from '../src/relay-server/passes/flow-requeue';
import { requeueFlowGaps } from '../src/relay-server/ai-screen-loop';
import { getRun, type BuildRun } from '../src/relay-server/build-run-store';

const canonScreens: CanonScreenLike[] = [
  { canonicalId: 'c_1_1', frameIds: ['1:1'], name: 'loginScreen',
    modals: [{ id: 'm_1_9', frameId: '1:9' }] },
  { canonicalId: 'c_1_2', frameIds: ['1:2'], name: 'homeScreen', modals: [] },
  { canonicalId: 'c_1_3', frameIds: ['1:3'], name: 'settingsScreen', modals: [] },
];

const runScreens: RunScreenLike[] = [
  { frameId: '1:1', frameName: 'Login', status: 'done' },
  { frameId: '1:2', frameName: 'Home', status: 'done' },
  { frameId: '1:3', frameName: 'Settings', status: 'done' },
];

const REAL_GAP = 'this sibling is UNMATCHED — no presenter wires it (REAL gap, not folded)';

describe('planFlowRequeue (pure mapper)', () => {
  it('unmapped REAL-gap + tab-as-push + missing-step-presenter requeue; duplicate/wired never do', () => {
    const findings: FlowFindingLike[] = [
      { from: 'c_1_1', to: 'm_1_8', status: 'unmapped', detail: REAL_GAP },
      { from: 'c_1_2', to: 'c_1_3', status: 'tab-as-push', detail: 'tab edge implemented as a push' },
      { from: 'c_1_3', to: 'c_1_2', status: 'missing-step-presenter', detail: 'base navigates directly, sheet skipped' },
      { from: 'c_1_2', to: 'm_1_7', status: 'duplicate', detail: 'intentional duplicate of a standalone screen' },
      { from: 'c_1_1', to: 'c_1_2', status: 'wired', detail: 'FROM navigates to TO' },
    ];
    const d = planFlowRequeue(findings, canonScreens, runScreens);
    expect(d.map(x => x.frameId).sort()).toEqual(['1:1', '1:2', '1:3']);
    const home = d.find(x => x.frameId === '1:2')!;
    expect(home.findings).toHaveLength(1);                    // duplicate did NOT add a finding
    expect(home.findings[0]).toContain('tab-as-push');
  });

  it('a plain unmapped (no REAL-gap marker — build drift, not a wiring gap) does NOT requeue', () => {
    const findings: FlowFindingLike[] = [
      { from: 'c_1_1', to: 'c_1_2', status: 'unmapped', detail: 'FROM has no built screen file' },
    ];
    expect(planFlowRequeue(findings, canonScreens, runScreens)).toHaveLength(0);
  });

  it('merges multiple findings for one screen into ONE decision (requeue cap: once per finalize)', () => {
    const findings: FlowFindingLike[] = [
      { from: 'c_1_1', to: 'm_1_8', status: 'unmapped', detail: REAL_GAP },
      { from: 'c_1_1', to: 'm_1_9', status: 'unmapped', detail: REAL_GAP },
    ];
    const d = planFlowRequeue(findings, canonScreens, runScreens);
    expect(d).toHaveLength(1);
    expect(d[0].frameId).toBe('1:1');
    expect(d[0].findings).toHaveLength(2);
  });

  it('a modal-id FROM (edge from inside a sheet) resolves to its base screen', () => {
    const findings: FlowFindingLike[] = [
      { from: 'm_1_9', to: 'c_1_3', status: 'missing-step-presenter', detail: 'sheet skipped' },
    ];
    const d = planFlowRequeue(findings, canonScreens, runScreens);
    expect(d).toHaveLength(1);
    expect(d[0].frameId).toBe('1:1');
    expect(d[0].canonicalId).toBe('c_1_1');
  });

  it('never flips a screen that is not currently done (protects existing parks + human decisions)', () => {
    const findings: FlowFindingLike[] = [
      { from: 'c_1_1', to: 'm_1_8', status: 'unmapped', detail: REAL_GAP },
    ];
    const parked: RunScreenLike[] = [{ frameId: '1:1', frameName: 'Login', status: 'needs-review' }];
    expect(planFlowRequeue(findings, canonScreens, parked)).toHaveLength(0);
  });

  it('an unresolvable FROM is skipped (warn-only stays for drift we cannot map)', () => {
    const findings: FlowFindingLike[] = [
      { from: 'c_9_9', to: 'c_1_2', status: 'tab-as-push', detail: 'x' },
    ];
    expect(planFlowRequeue(findings, canonScreens, runScreens)).toHaveLength(0);
  });
});

// ── requeueFlowGaps (orchestration over the run store) ────────────────────────

const PROJECT_ID = 'app';
let tmpWorkspace: string;
let projectRoot: string;

beforeEach(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'p3req-'));
  process.env.WORKSPACE = tmpWorkspace;
  projectRoot = path.join(tmpWorkspace, 'projects', PROJECT_ID);
  await fs.mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  delete process.env.WORKSPACE;
  try { await fs.rm(tmpWorkspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('requeueFlowGaps', () => {
  it('flips the right screens to needs-review with the findings as the review reason; second run is a no-op', async () => {
    const runId = 'run_1700000000020_req';
    const now = new Date().toISOString();
    const run: BuildRun = {
      id: runId, projectId: PROJECT_ID, kind: 'whole-app', model: 'human',
      screens: [
        { frameId: '1:1', frameName: 'Login', status: 'done', matched: true },
        { frameId: '1:2', frameName: 'Home', status: 'done', matched: true },
        { frameId: '1:3', frameName: 'Settings', status: 'done', matched: true },
      ],
      status: 'done', createdAt: now, updatedAt: now,
    } as BuildRun;
    const runsDir = path.join(projectRoot, '.uix', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2), 'utf-8');
    await fs.writeFile(path.join(runsDir, `${runId}.canonical.json`), JSON.stringify({
      version: 1, screens: canonScreens.map(s => ({ ...s, states: [], role: 'screen', route: `/x-${s.canonicalId}` })),
      components: [], templates: [], flow: { entryCanonicalId: 'c_1_1', edges: [] }, frameMap: {}, warnings: [],
    }, null, 2), 'utf-8');
    await fs.writeFile(path.join(projectRoot, '.uix', 'flow-wiring-report.json'), JSON.stringify({
      version: 1, projectId: PROJECT_ID, findings: [
        { from: 'c_1_1', to: 'm_1_8', kind: 'overlay', status: 'unmapped', detail: REAL_GAP },
        { from: 'c_1_1', to: 'm_1_9', kind: 'overlay', status: 'unmapped', detail: REAL_GAP },
        { from: 'c_1_2', to: 'c_1_3', kind: 'tab', status: 'tab-as-push', detail: 'tab edge pushed' },
        { from: 'c_1_3', to: 'c_1_2', kind: 'overlay', status: 'duplicate', detail: 'benign duplicate' },
      ],
    }, null, 2), 'utf-8');

    const n = await requeueFlowGaps(PROJECT_ID, runId, projectRoot);
    expect(n).toBe(2);                                        // Login (2 findings merged) + Home

    const after = await getRun(PROJECT_ID, runId);
    const login = after!.screens.find(s => s.frameId === '1:1')!;
    const home = after!.screens.find(s => s.frameId === '1:2')!;
    const settings = after!.screens.find(s => s.frameId === '1:3')!;
    expect(login.status).toBe('needs-review');
    expect(login.review?.reason).toContain('[flow-wiring]');
    expect(login.review?.reason).toContain('REAL gap');
    expect(home.status).toBe('needs-review');
    expect(home.review?.reason).toContain('tab-as-push');
    expect(settings.status).toBe('done');                     // benign duplicate never requeues
    expect(after!.status).toBe('needs-review');               // rollup derives the parked run

    // Idempotent: the screens are no longer 'done', so a re-run flips nothing.
    const n2 = await requeueFlowGaps(PROJECT_ID, runId, projectRoot);
    expect(n2).toBe(0);
  });

  it('no report / no canonical → 0 (warn-only behavior unchanged)', async () => {
    expect(await requeueFlowGaps(PROJECT_ID, 'run_none', projectRoot)).toBe(0);
  });
});
