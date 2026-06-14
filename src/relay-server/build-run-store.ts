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

export type RunScreenStatus = 'pending' | 'building' | 'done' | 'failed';

/** Everything the server needs to build ONE screen without the client. */
export interface ScreenSpec {
  packet: string;              // the implement prompt (client-built agent packet)
  referenceImagePath: string;  // project-relative reference render
  tree?: string;
  width?: number;
  height?: number;
}
export interface RunScreen {
  frameId: string;
  frameName: string;
  status: RunScreenStatus;
  matched?: boolean;
  sessionId?: string;
  at?: string;
  spec?: ScreenSpec;
}
export type RunStatus = 'running' | 'done' | 'stopped';
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
  sessionId?: string;          // shared CLI session threaded across screens
  screens: RunScreen[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
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
  return 'done';
}

export async function createRun(
  projectId: string,
  data: {
    kind: BuildRun['kind']; framework?: string; figStorageKey?: string;
    model: string; modelId?: string; maxIterations?: number; verify?: boolean; userNotes?: string;
    screens: Array<{ frameId: string; frameName: string; spec?: ScreenSpec }>;
  },
): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const now = new Date().toISOString();
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const run: BuildRun = {
    id, projectId, kind: data.kind, framework: data.framework, figStorageKey: data.figStorageKey,
    model: data.model, modelId: data.modelId, maxIterations: data.maxIterations, verify: data.verify, userNotes: data.userNotes,
    screens: data.screens.map(s => ({ frameId: s.frameId, frameName: s.frameName, status: 'pending' as const, spec: s.spec })),
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
  for (const s of run.screens) { s.status = 'pending'; s.matched = undefined; s.at = undefined; }
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
