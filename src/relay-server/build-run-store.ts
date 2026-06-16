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
import * as crypto from 'crypto';
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
  width?: number;              // logical frame width (device-independent px)
  height?: number;             // logical frame height
  // ── P4 (RFC §4.3): the ACTUAL pixel dimensions of the reference render on disk.
  // Refs are exported @2× (a 393×852 frame → 786×1704 PNG), so vision-token cost is
  // driven by these, not the logical w/h. Stored at creation so the pre-flight gate
  // can estimate vision tokens (w·h/750 after the model's long-edge cap) without
  // re-reading every PNG. Falls back to width·2 / height·2 when absent.
  refWidthPx?: number;
  refHeightPx?: number;
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
// 'awaiting-approval' (P5, RFC §5) = the orchestrator paused at a HITL checkpoint
// gate and is waiting for a human to approve / edit before it proceeds. Which gate
// is named in `run.checkpoint`. A run in this state is gracefully paused (resumable).
export type RunStatus = 'running' | 'awaiting-approval' | 'needs-review' | 'done' | 'stopped';

// ── P5 (RFC §5): HITL checkpoint gates ───────────────────────────────────────
// The five milestones a human approves before the build proceeds. The orchestrator
// pauses (status 'awaiting-approval') at the enabled gates; approval resumes it.
//   flow            — after canonicalization/flow (edit clustering, set entry, fix nav)
//   plan            — after plan + pre-flight (approve routes/screens/tokens + cost)
//   design-system   — after design-system + screen-1 reference build (freeze visual language)
//   rolling         — rolling every N screens + non-whitelisted amendment approvals
//   pre-global      — before global wiring / full build / deploy (needs-review must be 0)
export type CheckpointGate = 'flow' | 'plan' | 'design-system' | 'rolling' | 'pre-global';
export const CHECKPOINT_GATES: CheckpointGate[] = ['flow', 'plan', 'design-system', 'rolling', 'pre-global'];

/** A pending HITL checkpoint the run is parked on (surfaced in the Runs UI). */
export interface RunCheckpoint {
  gate: CheckpointGate;
  /** human-readable summary of what to review at this gate. */
  message?: string;
  /** when the run paused here. */
  at: string;
}

// ── P5 (RFC §4.8): plan amendment protocol ───────────────────────────────────
// The plan is APPEND-ONLY + namespace-locked (no renames / dupe routes), not frozen.
// A screen that needs a missing route/component emits an amendment-request; the
// orchestrator auto-approves whitelisted classes, else parks at the 'rolling' gate.
export type AmendmentKind = 'add-route' | 'add-component';
export type AmendmentStatus = 'pending' | 'approved' | 'rejected';
export interface AmendmentRequest {
  id: string;
  kind: AmendmentKind;
  rationale: string;
  /** the proposed API surface (a route slug, or a component name + props sketch). */
  proposedApi: string;
  /** the screen/frame that requested it (for traceability). */
  fromFrameId?: string;
  status: AmendmentStatus;
  /** true when auto-approved by the whitelist (vs. a human at the rolling gate). */
  auto?: boolean;
  at: string;
}

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
  // ── P5 (RFC §4.8): plan version + amendments ─────────────────────────────────
  // The plan is append-only/namespace-locked; an approved amendment bumps planVersion
  // and regenerates the skeleton. Starts at 1. Amendments are journaled here.
  planVersion?: number;
  amendments?: AmendmentRequest[];
  // ── P5 (RFC §5): HITL checkpoints ────────────────────────────────────────────
  // checkpoints: which gates are ENABLED for this run (default: none → no pausing,
  //   preserving existing behavior). When a gate fires the run parks in
  //   'awaiting-approval' with `checkpoint` set until a human approves.
  checkpoints?: CheckpointGate[];
  // checkpoint: the gate the run is CURRENTLY parked on (set iff status is
  //   'awaiting-approval'). approved[] records gates already cleared this run so we
  //   don't re-pause on resume.
  checkpoint?: RunCheckpoint;
  approvedGates?: CheckpointGate[];
  // ── P5 (RFC §4.9): gated resume ──────────────────────────────────────────────
  // resumable: explicit graceful-pause flag. resumeInterruptedRuns ONLY re-starts a
  //   run that was gracefully paused (resumable:true) — never auto-resurrects a run
  //   that crashed or was stopped. Set true on graceful stop / checkpoint pause;
  //   cleared while a run is actively orchestrating.
  resumable?: boolean;
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
  // A run must NEVER report 'done' while a screen is 'failed' or 'needs-review'
  // (audit A.1 — 'failed' silently fell through to 'done' = silent ship). Both
  // hold the run open in the needs-review queue: a built-but-unverified screen and
  // a screen that errored both require a human to Accept / Corrected-retry / restart
  // before the run can complete or deploy (RFC §4.7). A 'failed' screen is surfaced
  // as needs-review (the orchestrator attaches a review payload at the failure site).
  if (screens.some(s => s.status === 'needs-review' || s.status === 'failed')) return 'needs-review';
  return 'done';
}

// P5: statuses that must NOT be overwritten by a per-screen status derivation —
// they are run-level lifecycle states owned by the orchestrator / human, not by
// the screen rollup. (A screen finishing must not unpause an awaiting-approval run.)
const STICKY_RUN_STATUS: ReadonlySet<RunStatus> = new Set<RunStatus>(['stopped', 'awaiting-approval']);

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
    checkpoints?: CheckpointGate[];
    screens: Array<{ frameId: string; frameName: string; spec?: ScreenSpec }>;
  },
): Promise<BuildRun | null> {
  // (refWidthPx/refHeightPx ride along on each ScreenSpec — see the create-run route.)
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
    // P5: plan starts at v1; checkpoints default to NONE (no pausing) so existing
    // callers keep their old non-gated behavior. resumable starts false (a run only
    // becomes resumable once it gracefully pauses).
    planVersion: 1,
    checkpoints: data.checkpoints && data.checkpoints.length
      ? data.checkpoints.filter((g): g is CheckpointGate => CHECKPOINT_GATES.includes(g))
      : undefined,
    resumable: false,
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

// A real run file is EXACTLY `<runId>.json` where runId = `run_<ts>_<rand>`. The
// sidecars `<runId>.canonical.json` and `<runId>.frame-map.json` are also *.json
// but are NOT runs — frame-map has no `screens` (so `r.screens.map` threw and the
// outer catch wiped the WHOLE list → "No build runs yet" while a run was live),
// and canonical's `screens` are a different shape. Match the run-id pattern only.
const RUN_FILE_RE = /^run_\d+_[a-z0-9]+\.json$/i;

/** List runs — WITHOUT the heavy per-screen specs (keeps the list payload small). */
export async function listRuns(projectId: string, limit = 30): Promise<BuildRun[]> {
  const root = rootFor(projectId);
  if (!root) return [];
  try {
    const files = (await fs.readdir(runsDir(root))).filter(f => RUN_FILE_RE.test(f));
    const runs = await Promise.all(files.map(async f => {
      try {
        const r = JSON.parse(await fs.readFile(path.join(runsDir(root), f), 'utf-8')) as BuildRun;
        // Defensive: never let one malformed file throw and empty the whole list.
        return Array.isArray(r?.screens) ? r : null;
      } catch { return null; }
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
  run.status = STICKY_RUN_STATUS.has(run.status) ? run.status : deriveStatus(run.screens);
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
  // P5: a restart re-runs every gate from scratch and drops a parked checkpoint.
  run.checkpoint = undefined;
  run.approvedGates = undefined;
  run.resumable = false;
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

// ── P5 (RFC §5): HITL checkpoint gate control ────────────────────────────────
/** True when a gate is enabled for this run AND not already cleared this run. */
export function gateIsActive(run: BuildRun, gate: CheckpointGate): boolean {
  return !!run.checkpoints?.includes(gate) && !(run.approvedGates ?? []).includes(gate);
}
/** Park a run at a checkpoint gate (status 'awaiting-approval', resumable). The
 *  orchestrator calls this then returns; a human approve resumes the build. */
export async function pauseAtCheckpoint(projectId: string, runId: string, gate: CheckpointGate, message?: string): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  run.status = 'awaiting-approval';
  run.checkpoint = { gate, message, at: new Date().toISOString() };
  run.resumable = true;                 // a gracefully-paused run IS resumable
  await saveRun(projectId, run);
  return run;
}
/** Clear a parked checkpoint (human approved). Marks the gate cleared so it does
 *  not re-fire on resume, drops the parked checkpoint and flips back to 'running'. */
export async function approveCheckpoint(projectId: string, runId: string, gate?: CheckpointGate): Promise<BuildRun | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  const g = gate ?? run.checkpoint?.gate;
  if (g) run.approvedGates = [...new Set([...(run.approvedGates ?? []), g])];
  run.checkpoint = undefined;
  run.status = 'running';
  await saveRun(projectId, run);
  return run;
}

// ── P5 (RFC §4.9): explicit resumable graceful-pause flag ────────────────────
export async function setRunResumable(projectId: string, runId: string, resumable: boolean): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  const run = await getRun(projectId, runId);
  if (!run) return;
  run.resumable = resumable;
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(runFile(root, runId), JSON.stringify(run, null, 2), 'utf-8');
}

// ── P5 (RFC §4.8): plan amendment protocol ───────────────────────────────────
// Auto-approve whitelist: a new leaf route that is ALREADY a target in the flow
// graph (a known screen the plan just hasn't slotted) is safe to add without a
// human. Everything else (new components, routes not in the flow) parks at the
// rolling gate. Kept conservative on purpose — append-only, namespace-locked.
export function amendmentIsWhitelisted(run: BuildRun, req: { kind: AmendmentKind; proposedApi: string }): boolean {
  if (req.kind !== 'add-route') return false;
  const slug = req.proposedApi.trim().toLowerCase();
  if (!slug) return false;
  // A leaf route already referenced by the flow (entry or any edge target) is a
  // known screen → whitelisted. We match by route slug derived from a frame name.
  const slugify = (s: string) => '/' + (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen');
  const known = new Set<string>();
  for (const s of run.screens) known.add(slugify(s.frameName));
  const want = slug.startsWith('/') ? slug : slugify(slug);
  return known.has(want);
}
/** Record an amendment request on the run. Returns the created request. */
export async function addAmendment(
  projectId: string, runId: string,
  req: { kind: AmendmentKind; rationale: string; proposedApi: string; fromFrameId?: string },
): Promise<{ run: BuildRun; amendment: AmendmentRequest } | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  const auto = amendmentIsWhitelisted(run, req);
  const amendment: AmendmentRequest = {
    id: `amd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    kind: req.kind, rationale: req.rationale, proposedApi: req.proposedApi,
    fromFrameId: req.fromFrameId,
    status: auto ? 'approved' : 'pending',
    auto: auto || undefined,
    at: new Date().toISOString(),
  };
  run.amendments = [...(run.amendments ?? []), amendment];
  // An approved amendment bumps the plan version (skeleton regen is the caller's job).
  if (auto) run.planVersion = (run.planVersion ?? 1) + 1;
  await saveRun(projectId, run);
  return { run, amendment };
}
/** Resolve a pending amendment (human at the rolling gate). Approved → planVersion++. */
export async function resolveAmendment(
  projectId: string, runId: string, amendmentId: string, decision: 'approved' | 'rejected',
): Promise<{ run: BuildRun; amendment: AmendmentRequest } | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const run = await getRun(projectId, runId);
  if (!run) return null;
  const amendment = run.amendments?.find(a => a.id === amendmentId);
  if (!amendment) return null;
  if (amendment.status === 'pending') {
    amendment.status = decision;
    if (decision === 'approved') run.planVersion = (run.planVersion ?? 1) + 1;
  }
  await saveRun(projectId, run);
  return { run, amendment };
}

// ── P5 (RFC §4.2/§4.9): frame-map.json — the SINGLE identity axis ─────────────
// Persist frameId → canonicalId as a standalone, durable file so durability +
// route derivation key on ONE content-addressed axis (kills the frameName/frameId
// split + re-import drift). Lives alongside the run for resume + cross-run lookup.
const frameMapFile = (root: string, runId: string) => path.join(runsDir(root), `${runId}.frame-map.json`);
export async function writeFrameMap(projectId: string, runId: string, frameMap: Record<string, string>): Promise<void> {
  const root = rootFor(projectId);
  if (!root) return;
  try {
    await fs.mkdir(runsDir(root), { recursive: true });
    await fs.writeFile(frameMapFile(root, runId), JSON.stringify(frameMap, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}
export async function readFrameMap(projectId: string, runId: string): Promise<Record<string, string>> {
  const root = rootFor(projectId);
  if (!root) return {};
  try { return JSON.parse(await fs.readFile(frameMapFile(root, runId), 'utf-8')) as Record<string, string>; }
  catch { return {}; }
}

// ── P5 (RFC §4.9): asset dedup by content hash ACROSS runs ───────────────────
// A project-level content-addressed asset store: identical bytes are written once
// (named by their sha256), and a manifest maps logical paths → hash so repeated
// runs/resumes reuse the same physical asset instead of re-writing duplicates.
const assetsDir = (root: string) => path.join(root, '.uix', 'assets');
const assetIndexFile = (root: string) => path.join(assetsDir(root), 'index.json');
type AssetIndex = Record<string, string>; // logicalKey → contentHash
export function hashAsset(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
/**
 * Store an asset content-addressed. Returns the content hash + the project-relative
 * path of the (deduped) physical file. Re-storing identical bytes is a no-op write.
 */
export async function putAsset(projectId: string, logicalKey: string, bytes: Buffer): Promise<{ hash: string; relPath: string } | null> {
  const root = rootFor(projectId);
  if (!root) return null;
  const hash = hashAsset(bytes);
  const ext = path.extname(logicalKey) || '';
  const rel = path.join('.uix', 'assets', `${hash}${ext}`);
  const abs = path.join(root, rel);
  await fs.mkdir(assetsDir(root), { recursive: true });
  // Content-addressed: if the hashed file already exists the bytes are identical —
  // skip the write (the dedup across runs/resumes).
  if (!fsSync.existsSync(abs)) await fs.writeFile(abs, bytes);
  // Update the logical-key → hash index (best-effort).
  try {
    let idx: AssetIndex = {};
    try { idx = JSON.parse(await fs.readFile(assetIndexFile(root), 'utf-8')) as AssetIndex; } catch { /* fresh */ }
    idx[logicalKey] = hash;
    await fs.writeFile(assetIndexFile(root), JSON.stringify(idx, null, 2), 'utf-8');
  } catch { /* index is an optimization, not a correctness requirement */ }
  return { hash, relPath: rel };
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
