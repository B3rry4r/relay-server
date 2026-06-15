// =============================================================================
// File: src/relay-server/build-run-store.ts
//
// Durable record of a multi-screen build RUN, persisted per project under
// .uix/runs/<runId>.json (+ <runId>.log). The run carries EVERYTHING the server
// needs to build each screen itself (packet, reference render, IR), so the whole
// app builds SERVER-SIDE — it keeps going when the browser tab is closed and is
// resumable after a relay redeploy. Logs are persisted + replayable.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { resolveProjectRoot } from './runtime';

// 'needs-review' = built but NOT a trustworthy visual match (accepted-but-not-matched,
// verify said stop, or the deterministic reconciliation failed). It is NOT 'done':
// a run must not report complete while any screen is 'needs-review'. A human then
// Accepts it as-is (→ 'done') or does a Corrected-retry (→ rebuild with a note).
export type RunScreenStatus = 'pending' | 'building' | 'needs-review' | 'done' | 'failed';

/** Everything the server needs to build ONE screen without the client. */
export interface ScreenSpec {
  packet: string;              // the implement prompt (client-built agent packet)
  referenceImagePath: string;  // project-relative reference render
  tree?: string;
  width?: number;
  height?: number;
}
/** The verify evidence surfaced in the needs-review UI (candidate vs reference). */
export interface ReviewInfo {
  candidateImagePath?: string;   // project-relative latest candidate screenshot
  referenceImagePath?: string;   // project-relative reference render
  score?: number;                // last verify score (0-100)
  reason?: string;               // why it needs review (stopReason / recon failure)
  discrepancies?: Array<{ area?: string; issue: string; severity?: string }>;
}
export interface RunScreen {
  frameId: string;
  frameName: string;
  status: RunScreenStatus;
  matched?: boolean;
  sessionId?: string;
  at?: string;
  spec?: ScreenSpec;
  /** Populated when status === 'needs-review' (candidate-vs-reference + verdict). */
  review?: ReviewInfo;
}
// 'needs-review' = the orchestrator finished every screen but one or more landed in
// the needs-review queue, so the run is NOT complete (it must not deploy) until a
// human clears the queue. Distinct from 'running' (still building) and 'done'.
export type RunStatus = 'running' | 'needs-review' | 'done' | 'stopped';

/** Navigation flow graph — stored ON the run so the SERVER owns build order +
 *  the global app plan it injects into every screen's prompt (the flow shapes the
 *  output, instead of the client pre-chewing a flat list). */
export interface RunFlowConn { from: string; to: string; type: string; label?: string }
export interface RunFlow { entryFrameId: string | null; connections: RunFlowConn[] }

export interface BuildRun {
  id: string;
  projectId: string;
  kind: 'whole-app' | 'selected' | 'single';
  framework?: string;
  figStorageKey?: string;
  // Build config the server orchestrator needs:
  model: string;
  modelId?: string;
  maxIterations?: number;
  verify?: boolean;
  userNotes?: string;
  flow?: RunFlow;
  sessionId?: string;          // shared CLI session threaded across screens
  // ── P2: written-contract-driven builds (RFC §4.5) ────────────────────────────
  // freshSessions: build each screen in a NEW/stateless CLI session that reads the
  //   server-injected written contract (.uix/context.md + app plan + component API
  //   surface) instead of relying on the threaded --resume session. Model-independent
  //   (codex/gemini are already resume:false, so this just makes claude behave the
  //   same), bounds context growth, and is what ENABLES parallel workers. Default
  //   off → existing shared-session behavior is unchanged.
  freshSessions?: boolean;
  // parallel: max screens to build CONCURRENTLY (bounded worker pool). Only takes
  //   effect with freshSessions (a shared --resume session can't be used by two
  //   workers at once). Clamped to a small cap. Default 1 (serial) = old behavior.
  parallel?: number;
  // ── P3: canonicalization (RFC §4.1/§4.2) ─────────────────────────────────────
  // canonical: run the deterministic canonicalization pre-pass before building —
  //   cluster frames → canonical screens/states/modals/components, rewrite the
  //   flow onto canonical ids, and generate a write-locked skeleton (router +
  //   theme + component stubs). The build then iterates CANONICAL screens (one
  //   build per canonicalId, all its states/modals in view) instead of one build
  //   per raw frame. Default off → existing one-frame-per-screen behavior is
  //   unchanged. The pre-pass result is persisted to .uix/runs/<id>.canonical.json.
  canonical?: boolean;
  screens: RunScreen[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

// P2: hard ceiling on concurrent screen workers, regardless of what the caller
// asks for. Each worker spawns a coding-agent CLI + a Flutter/web release build,
// so a small cap keeps CPU/memory/rate-limits sane on the relay box.
export const MAX_PARALLEL_WORKERS = 3;
/** Normalize a requested parallel worker count into [1, MAX_PARALLEL_WORKERS]. */
export function clampParallel(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1;
  return Math.min(Math.max(v, 1), MAX_PARALLEL_WORKERS);
}

const runsDir = (root: string) => path.join(root, '.uix', 'runs');
const runFile = (root: string, id: string) => path.join(runsDir(root), `${id}.json`);
const runLogFile = (root: string, id: string) => path.join(runsDir(root), `${id}.log`);

function rootFor(projectId: string): string | null {
  const root = resolveProjectRoot(projectId);
  return root && fsSync.existsSync(root) ? root : null;
}

function deriveStatus(screens: RunScreen[]): RunStatus {
  if (screens.some(s => s.status === 'pending' || s.status === 'building')) return 'running';
  // Built-but-unverified screens hold the run open for human review — a run must
  // NOT report complete while needs-review > 0 (RFC §4.7).
  if (screens.some(s => s.status === 'needs-review')) return 'needs-review';
  return 'done';
}

/** Order screens by the flow graph: entry first, then DFS along connections, then
 *  tab destinations, then any remaining. Traverses edges even through nodes that
 *  aren't in the build set (e.g. the entry/splash already built), so the flow is
 *  always honored. THE SERVER owns this ordering. */
export function orderScreensByFlow<T extends { frameId: string }>(screens: T[], flow?: RunFlow): T[] {
  if (!flow || (!flow.entryFrameId && !flow.connections.length)) return screens;
  const byId = new Map(screens.map(s => [s.frameId, s]));
  const adj = new Map<string, string[]>();
  for (const c of flow.connections) { const a = adj.get(c.from) ?? []; a.push(c.to); adj.set(c.from, a); }
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const s = byId.get(id);
    if (s) out.push(s);                       // build it if it's in the set
    for (const t of (adj.get(id) ?? [])) visit(t);   // always follow edges
  };
  if (flow.entryFrameId) visit(flow.entryFrameId);
  for (const c of flow.connections) if (c.type === 'tab') visit(c.to);
  for (const s of screens) if (!seen.has(s.frameId)) { seen.add(s.frameId); out.push(s); }
  return out;
}

export async function createRun(
  projectId: string,
  data: {
    kind: BuildRun['kind']; framework?: string; figStorageKey?: string;
    model: string; modelId?: string; maxIterations?: number; verify?: boolean; userNotes?: string;
    flow?: RunFlow;
    freshSessions?: boolean; parallel?: number; canonical?: boolean;
    screens: Array<{ frameId: string; frameName: string; spec?: ScreenSpec }>;
  },
): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const now = new Date().toISOString();
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // THE SERVER orders the batch by the flow graph (not the client's order).
  const orderedScreens = orderScreensByFlow(data.screens, data.flow);
  const run: BuildRun = {
    id, projectId, kind: data.kind, framework: data.framework, figStorageKey: data.figStorageKey,
    model: data.model, modelId: data.modelId, maxIterations: data.maxIterations, verify: data.verify, userNotes: data.userNotes,
    flow: data.flow,
    freshSessions: data.freshSessions === true ? true : undefined,
    parallel: data.parallel != null ? clampParallel(data.parallel) : undefined,
    canonical: data.canonical === true ? true : undefined,
    screens: orderedScreens.map(s => ({ frameId: s.frameId, frameName: s.frameName, status: 'pending' as const, spec: s.spec })),
    status: 'running', createdAt: now, updatedAt: now,
  };
  await fs.mkdir(runsDir(root), { recursive: true });
  await fs.writeFile(runFile(root, id), JSON.stringify(run, null, 2), 'utf-8');
  return run;
}

export async function getRun(projectId: string, id: string): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  try { return JSON.parse(await fs.readFile(runFile(root, id), 'utf-8')) as BuildRun; }
  catch { return null; }
}

/** List runs — WITHOUT the heavy per-screen specs (keeps the list payload small). */
export async function listRuns(projectId: string, limit = 30): Promise<BuildRun[]> {
  const root = rootFor(projectId);
  if (!root) return [];
  try {
    const files = (await fs.readdir(runsDir(root))).filter(f => f.endsWith('.json'));
    const runs = await Promise.all(files.map(async f => {
      try { return JSON.parse(await fs.readFile(path.join(runsDir(root), f), 'utf-8')) as BuildRun; } catch { return null; }
    }));
    return runs.filter((r): r is BuildRun => !!r)
      .map(r => ({ ...r, screens: r.screens.map(s => ({ ...s, spec: undefined })) }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
  } catch { return []; }
}

export async function updateRunScreen(
  projectId: string, runId: string, frameId: string, patch: Partial<Omit<RunScreen, 'frameId' | 'frameName' | 'spec'>>,
): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  const s = run.screens.find(x => x.frameId === frameId);
  if (s) Object.assign(s, patch, { at: new Date().toISOString() });
  run.status = run.status === 'stopped' ? 'stopped' : deriveStatus(run.screens);
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, runId), JSON.stringify(run, null, 2), 'utf-8');
  return run;
}

/** Low-level: persist a mutated run object (route handlers mutate then save). */
export async function saveRun(projectId: string, run: BuildRun): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, run.id), JSON.stringify(run, null, 2), 'utf-8');
}

/** Reset every screen to pending + status running (for a restart). */
export async function restartRun(projectId: string, runId: string): Promise<BuildRun | null> {
  const run = await getRun(projectId, runId);
  if (!run) return null;
  for (const s of run.screens) { s.status = 'pending'; s.matched = undefined; s.at = undefined; s.review = undefined; }
  run.sessionId = undefined;
  run.status = 'running';
  await saveRun(projectId, run);
  return run;
}

export async function setRunStatus(projectId: string, runId: string, status: RunStatus): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  const run = await getRun(projectId, runId);
  if (!run) return;
  run.status = status;
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, runId), JSON.stringify(run, null, 2), 'utf-8');
}

export async function setRunSession(projectId: string, runId: string, sessionId: string): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  const run = await getRun(projectId, runId);
  if (!run) return;
  run.sessionId = sessionId;
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, runId), JSON.stringify(run, null, 2), 'utf-8');
}

// ── Durable, replayable run log ────────────────────────────────────────────────
export async function appendRunLog(projectId: string, runId: string, line: string): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  try { await fs.mkdir(runsDir(root), { recursive: true }); await fs.appendFile(runLogFile(root, runId), line + '\n', 'utf-8'); }
  catch { /* logging must never throw */ }
}
export async function readRunLog(projectId: string, runId: string, maxBytes = 256 * 1024): Promise<string> {
  const root = rootFor(projectId);
  if (!root) return '';
  try {
    const buf = await fs.readFile(runLogFile(root, runId), 'utf-8');
    return buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
  } catch { return ''; }
}

// ── In-memory cancellation (Stop) — checked between screens by the orchestrator ──
const cancelled = new Set<string>();
export function markRunCancelled(runId: string): void { cancelled.add(runId); }
export function isRunCancelled(runId: string): boolean { return cancelled.has(runId); }
export function clearRunCancelled(runId: string): void { cancelled.delete(runId); }

// Runs currently orchestrating in THIS server process (so we don't double-start).
const active = new Set<string>();
export function isRunActive(runId: string): boolean { return active.has(runId); }
export function markRunActive(runId: string): void { active.add(runId); }
export function clearRunActive(runId: string): void { active.delete(runId); }
