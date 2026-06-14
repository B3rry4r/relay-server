// =============================================================================
// File: src/relay-server/build-run-store.ts
//
// Durable record of a multi-screen build RUN, persisted per project under
// .uix/runs/<runId>.json. Survives the client tab closing AND a relay redeploy,
// so a build interrupted for ANY reason (Stop, error, rate limit, container
// restart) knows exactly which screens are done / remaining and can resume.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { resolveProjectRoot } from './runtime';

export type RunScreenStatus = 'pending' | 'building' | 'done' | 'failed';
export interface RunScreen {
  frameId: string;
  frameName: string;
  status: RunScreenStatus;
  matched?: boolean;     // verified against the reference render
  sessionId?: string;    // CLI session for resume / continuity
  at?: string;
}
export type RunStatus = 'running' | 'done' | 'stopped';
export interface BuildRun {
  id: string;
  projectId: string;
  kind: 'whole-app' | 'selected' | 'single';
  framework?: string;
  figStorageKey?: string;
  screens: RunScreen[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

const runsDir = (root: string) => path.join(root, '.uix', 'runs');
const runFile = (root: string, id: string) => path.join(runsDir(root), `${id}.json`);

function rootFor(projectId: string): string | null {
  const root = resolveProjectRoot(projectId);
  return root && fsSync.existsSync(root) ? root : null;
}

// Derive overall run status from its screens.
function deriveStatus(screens: RunScreen[]): RunStatus {
  if (screens.some(s => s.status === 'pending' || s.status === 'building')) return 'running';
  return 'done';
}

export async function createRun(
  projectId: string,
  data: { kind: BuildRun['kind']; framework?: string; figStorageKey?: string; screens: Array<{ frameId: string; frameName: string }> },
): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const now = new Date().toISOString();
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const run: BuildRun = {
    id, projectId, kind: data.kind, framework: data.framework, figStorageKey: data.figStorageKey,
    screens: data.screens.map(s => ({ frameId: s.frameId, frameName: s.frameName, status: 'pending' as const })),
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

export async function listRuns(projectId: string, limit = 30): Promise<BuildRun[]> {
  const root = rootFor(projectId);
  if (!root) return [];
  try {
    const files = (await fs.readdir(runsDir(root))).filter(f => f.endsWith('.json'));
    const runs = await Promise.all(files.map(async f => {
      try { return JSON.parse(await fs.readFile(path.join(runsDir(root), f), 'utf-8')) as BuildRun; } catch { return null; }
    }));
    return runs.filter((r): r is BuildRun => !!r).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
  } catch { return []; }
}

/** Upsert one screen's status in a run; recomputes the run's overall status. */
export async function updateRunScreen(
  projectId: string, runId: string, frameId: string, patch: Partial<Omit<RunScreen, 'frameId' | 'frameName'>>,
): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  const s = run.screens.find(x => x.frameId === frameId);
  if (s) Object.assign(s, patch, { at: new Date().toISOString() });
  run.status = deriveStatus(run.screens);
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, runId), JSON.stringify(run, null, 2), 'utf-8');
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
