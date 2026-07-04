// =============================================================================
// File: src/relay-server/ai-screen-loop.ts
//
// Closed-loop, headless screen builder: implement → verify → fix → verify, until
// the built screen visually matches its reference render (or max iterations).
//
//   1. IMPLEMENT — spawn the coding agent with the client-built packet. It writes
//      the screen into the real project AND a per-screen *preview entrypoint*
//      that runs just this screen inside the app's real theme/router.
//   2. VERIFY    — build that preview entrypoint, screenshot it, and have a
//      SEPARATE (independent) agent compare it to the reference render, emitting
//      a strict JSON verdict {match, score, discrepancies}.
//   3. FIX       — if it doesn't match, resume the coding session with the
//      concrete discrepancies + both images and revise. Re-verify.
//
// Runs in the BACKGROUND: the route returns a jobId immediately and the loop
// survives the client tab closing. Progress streams to the shared job log;
// every iteration (verdict + candidate screenshot) is journaled under
// .uix/screens/<frameId>/ and a final result.json is written for the client.
// =============================================================================

import { type Express } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { resolveProjectRoot, resolveWorkspace, createTerminalEnv, getFlutterRoot, resolveProjectRelativePath } from './runtime';
import { runModel } from './ai-routes';
import { startJobLog, appendJobLog, finishJobLog, subscribeJobLog } from './ai-job-log';
import { captureUrlScreenshot, captureUrlTiles, serveDir } from './visual-routes';
import { isAIModel, type AIModel } from './ai-adapters';
import {
  createRun, getRun, listRuns, updateRunScreen, setRunStatus, setRunSession,
  saveRun, restartRun, appendRunLog, readRunLog,
  markRunCancelled, isRunCancelled, clearRunCancelled,
  isRunActive, markRunActive, clearRunActive,
  setRunPhase,
  clampParallel,
  gateIsActive, pauseAtCheckpoint, approveCheckpoint, setRunResumable, setRunPrepDone, setRunFinalized,
  addAmendment, resolveAmendment, writeFrameMap, mutateRun,
  type ScreenSpec, type CheckpointGate, type BuildRun, type RunScreen, type AmendmentKind,
} from './build-run-store';
import { notify } from './notify';
import { getProjectsRoot } from './runtime';
import {
  canonicalizeRun, writeCanonical, readCanonical, generateFlutterSkeleton,
  restampCanonicalHeaders, cleanOrphanScreens, syncLiveCanonical,
  nukeGeneratedAppSurface, planSemanticScreens, computeTabCluster,
  type Canonical, type CanonicalScreen,
} from './canonicalize';
import { canonicalize as aiCanonicalize, type CanonicalizeOptions } from './canonicalize-ai/orchestrate';
import { aiModelToCanonical } from './canonicalize-ai/to-canonical';
import type { DescribeFrameInput } from './canonicalize-ai/describe';
import type { ReduceFlow } from './canonicalize-ai/reduce';
import { AiStepError, runModelObserved, _emptyStreakConfig } from './ai-observability';
import { generateDesignSystem, seedContextWithThemeApi, ensureMainWired, consolidateDesignTokens, ensureScreenPreviewEntry, modalPresenterName, type ThemeTokens } from './design-system';
import { prepScreen, ensureIrComplete, getIrData, runAssetPass, type PrepConfig, type LocalizedAsset } from './reference-render';
import type { FigFrame, FlowGraph } from './agent-packet';
import { computePreflight } from './preflight';
import { reconcileScreen, reconcileSummary, type ReconcileResult } from './reconcile';
import { finalizeApp } from './passes/finalize';
import { repointAssetUsage, buildAssetInventory, renderAssetInventory } from './passes/asset-usage';
import { ensureProjectGit, commitCheckpoint, snapshotBeforeMutation, rollbackTo } from './version-control';

const execFile = promisify(execFileCb);

// ── T9 (RFC v2 §8.1): the canonical GENERATION phase sequence ────────────────
// Drives the "Phase X of N: <name>" the Runs UI shows. One ordered list spanning
// BOTH the prep route (prepare-and-run: prep + assets) and runAppLoop (canonicalize
// → skeleton → design-system → build → verify → finalize), so the index is stable
// end-to-end. Best-effort emission via phase(): a phase write never breaks a run.
// IMPORTANT: this list MUST be in CHRONOLOGICAL EXECUTION order so the displayed
// "Phase X/N" is monotonic (index derived via indexOf). The generation entrypoint
// (prepare-and-run) runs the prep route FIRST — which localizes + semantically
// renames assets — and ONLY THEN calls runAppLoop (canonicalize → skeleton →
// pre-flight → build → verify → finalize). So `Assets` is phase 1, not phase 4:
// emitting it after Canonicalize made the UI pill jump 4→1→2→3. (RFC v2 §8.1.)
const GEN_PHASES = [
  'Assets',             // 1 — localize + semantic rename + resources file (prep route, runs first)
  'Canonicalize',       // 2 — heavy-AI canonicalization (or degraded clusterer)
  'Skeleton',           // 3 — write-locked router/theme/component stubs
  'Pre-flight',         // 4 — token/cost gate + design-system extract
  'Build screens',      // 5 — per-screen implement→verify→fix loop
  'Verify',             // 6 — needs-review rollup / queue
  'Finalize',           // 7 — production-readiness passes + global wire
] as const;
const GEN_TOTAL = GEN_PHASES.length;
type GenPhaseName = typeof GEN_PHASES[number];
/** Best-effort: set the run's generation phase by name (index derived from the
 *  canonical sequence). `detail` carries live sub-progress ("screen 7/24").
 *  Returns the underlying write promise so a caller that MUST order a phase write
 *  before a subsequent run mutation (the terminal completion) can `await` it — both
 *  setRunPhase and setRunStatus do a full run read-modify-write, so a fire-and-forget
 *  final phase write can land AFTER setRunStatus('done') and clobber status back. */
function setGenPhase(projectId: string, runId: string, name: GenPhaseName, detail?: string, done?: boolean): Promise<void> {
  const index = GEN_PHASES.indexOf(name) + 1;
  return setRunPhase(projectId, runId, { index, total: GEN_TOTAL, name, detail, done });
}

/**
 * Best-effort checkpoint commit for a run phase (RFC §9.2). NEVER fails the run: the
 * version-control fns are already non-throwing, but we wrap defensively + tee the
 * outcome into the run log so the history is observable. A git hiccup must never
 * break a build.
 */
async function runCheckpoint(projectId: string, runId: string, projectRoot: string, label: string, detail?: string): Promise<void> {
  try {
    await commitCheckpoint(projectRoot, label, detail, {
      log: (msg) => { void appendRunLog(projectId, runId, msg); },
    });
  } catch { /* never break a run on a checkpoint */ }
}

/**
 * T12 (RFC v2 §3 Phase 5/6): the AppAssets symbol inventory injected at the TOP of
 * every per-screen contract, so the build agent emits `AppAssets.<x>` rather than
 * the raw `'assets/...'` literals carried in the IR tree (those literals point at
 * pre-rename/deduped files the asset pass renamed/deleted → runtime failures).
 * Returns a block terminated by the contract separator, or '' when the asset pass
 * produced no resources file/map (guard for absence — a no-asset project is
 * unaffected). Never throws.
 */
async function assetInventoryBlock(projectRoot: string): Promise<string> {
  try {
    const inv = await buildAssetInventory(projectRoot);
    if (!inv) return '';
    return `${renderAssetInventory(inv)}\n\n— — —\n`;
  } catch { return ''; }
}

/**
 * T12 SAFETY NET: re-point any raw `'assets/...'` literals (and Material-icon
 * substitutions) the build agent still emitted to the generated `AppAssets`
 * symbols — UNCONDITIONALLY, regardless of needs-review/failed screens. The old
 * code only re-pointed inside finalizeApp, which is gated on `blocking === 0` (all
 * screens accepted) — so a real run with ≥1 needs-review screen NEVER repointed and
 * shipped screens referencing renamed/deleted files. This always runs over the
 * built screens before the run parks or finishes.
 *
 * BUILD-SAFE via the T10 git snapshot/rollback: snapshot before the mutation, run
 * the deterministic+AI re-point, then on a flutter project gate on the analyze
 * ERROR count — if it regresses, roll back EXACTLY (so a bad re-point can never
 * break the app). On a non-buildable shape it still runs (a path-literal → symbol
 * swap is a same-value rename) and only a throw rolls back. Idempotent: a second
 * run is a no-op (already-`AppAssets.x` usages are recognized + skipped).
 */
async function runAssetRepoint(projectId: string, runId: string, projectRoot: string): Promise<void> {
  const log = (msg: string) => { void appendRunLog(projectId, runId, msg); };
  // Guard: nothing to do without a resources file/map (asset pass didn't produce one).
  const inv = await buildAssetInventory(projectRoot).catch(() => null);
  if (!inv) { log('[assets] re-point skipped — no AppAssets resources file/map (asset pass produced none)'); return; }

  const env = createTerminalEnv(resolveWorkspace());
  const vc = { log, env };
  try {
    await ensureProjectGit(projectRoot, vc);
  } catch { /* non-fatal — handled below */ }
  const gitReady = fsSync.existsSync(path.join(projectRoot, '.git'));

  // Baseline analyze (flutter only) so a regression can be detected + rolled back.
  const isFlutter = fsSync.existsSync(path.join(projectRoot, 'pubspec.yaml'))
    && fsSync.existsSync(path.join(projectRoot, 'lib'));
  let baselineErrors: number | null = null;
  if (isFlutter) {
    const a = await flutterAnalyzeErrors(projectRoot, env);
    baselineErrors = a;
  }

  // This runs in the Verify stage (after build, before the finalize/needs-review
  // branch). Emit 'Verify' — NOT 'Finalize' — so the phase index stays monotonic
  // (the needs-review path re-emits Verify right after; finalize emits 7 only in the
  // blocking===0 branch). Emitting 'Finalize' here caused a 6→7→6 pill jump.
  setGenPhase(projectId, runId, 'Verify', 're-pointing asset usages');
  // Snapshot BEFORE mutating (the rollback target). When git is unavailable there is
  // no rollback point — we still run (a path→symbol swap is conservative + same-value),
  // but log loudly, matching the finalize discipline (never silently /tmp-back-up).
  let preSha = '';
  if (gitReady) preSha = await snapshotBeforeMutation(projectRoot, 'T12 always-run asset re-point', vc);
  else log('[assets] WARNING: git unavailable — re-point runs with NO rollback point');

  let result;
  try {
    const finalizeModel = undefined; // deterministic path-literal rewrites need no AI; the
    // AI icon-match is a finalize-pass concern. The safety net's JOB is the raw-path
    // literals the agent emitted, which are 100% deterministic.
    void finalizeModel;
    result = await repointAssetUsage(projectId, {
      projectRoot,
      noAi: true,
      env,
    });
  } catch (e: any) {
    log(`[assets] re-point threw (${e?.message || 'unknown'}) — rolling back`);
    if (gitReady && preSha) await rollbackTo(projectRoot, preSha, vc);
    return;
  }

  const repointed = result.repointed.length;
  if (repointed === 0) {
    log(`[assets] re-point: 0 raw-path/icon usages to fix (already clean)${result.warnings.length ? ` — ${result.warnings.join('; ')}` : ''}`);
    return;
  }

  // Regression gate (flutter): if analyze ERRORS got worse, roll back exactly.
  if (isFlutter && baselineErrors != null) {
    const afterErrors = await flutterAnalyzeErrors(projectRoot, env);
    if (afterErrors != null && afterErrors > baselineErrors) {
      log(`[assets] re-point REGRESSED analyze errors (${baselineErrors} → ${afterErrors}) — rolling back`);
      if (gitReady && preSha) await rollbackTo(projectRoot, preSha, vc);
      else log('[assets] CRITICAL: no rollback point — re-point left in place despite regression');
      return;
    }
  }

  log(`[assets] re-point: ${repointed} raw-path/icon usage(s) → AppAssets symbols (${result.skipped.length} left alone)`);
  if (gitReady) await runCheckpoint(projectId, runId, projectRoot, 'phase asset re-point', `${repointed} repointed`);
}

/** Best-effort flutter analyze ERROR count (null if unavailable). Thin wrapper so
 *  the safety net doesn't pull in the whole finalize analyze plumbing. */
async function flutterAnalyzeErrors(projectRoot: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  try {
    const { stdout, stderr } = await execFile('flutter', ['analyze', '--no-pub'], {
      cwd: projectRoot, env, maxBuffer: 32 * 1024 * 1024, timeout: 300000,
    }).catch((e: any) => ({ stdout: e?.stdout ?? '', stderr: e?.stderr ?? '' }));
    const out = `${stdout}\n${stderr}`;
    // `error •` lines are analyzer errors (vs `info •` / `warning •`).
    const m = out.match(/^\s*error\s+•/gm);
    return m ? m.length : 0;
  } catch { return null; }
}

interface BuildScreenReq {
  projectId: string;
  model: AIModel;
  modelId?: string;
  sessionId?: string;
  framework: string;
  frameId: string;
  frameName: string;
  width?: number;
  height?: number;
  referenceImagePath: string; // project-relative path to the reference render
  implementPrompt: string;    // the client-built agent packet
  tree?: string;              // IR tree notation — snapshotted for cross-session context
  maxIterations?: number;
  jobId?: string;
  runId?: string;             // durable multi-screen run this screen belongs to
  userNotes?: string;         // the human's design rules — shared with verify/fix
  verify?: boolean;           // when false, implement only (no verify↔fix loop)
  // P2 (RFC §4.5): build this screen in a FRESH/stateless session — do NOT seed the
  // implement call with a cross-screen --resume sessionId. Coherence then rides on
  // the server-injected written contract (already baked into implementPrompt), not
  // the shared CLI session. The within-screen fix loop still resumes the session
  // started by THIS screen's implement call (full local context for the fixes).
  freshSession?: boolean;
  // P3 (RFC §4.5/§4.8): canonical context for the deterministic reconciliation gate
  // + amendment emitter. Present only on canonical runs; absent → both are no-ops
  // (existing per-frame behavior unchanged).
  canonical?: Canonical;
  canonicalId?: string;
  // P1-core: the lead screen's folded states/modals, each verified INDIVIDUALLY
  // against its own reference after the lead passes (replaces the up-front blanket
  // mark-done that shipped 13/13 unbuilt modals on Ping). Absent → no variant pass.
  variants?: ScreenVariant[];
}

/** P1-core: one folded state/modal of a canonical lead screen, carrying ITS OWN
 *  reference + dims so the variant verify pass compares the right ground truth. */
export interface ScreenVariant {
  kind: 'state' | 'modal';
  /** canonical state id ('success') or modal id ('m_313_9543'). */
  id: string;
  /** the folded frame this variant folds in (its run.screens[] identity). */
  frameId: string;
  frameName: string;
  referenceImagePath?: string;
  width?: number;
  height?: number;
}

interface Discrepancy { area?: string; issue: string; severity?: string }
// `recommendation` lets the verify agent — not a fixed counter — drive whether
// another fix pass is worthwhile: 'accept' (done / only trivial cosmetic diffs),
// 'fix' (real fixable discrepancies remain), 'stop' (broken or not converging —
// another auto-pass won't help; defer to a human).
type Recommendation = 'accept' | 'fix' | 'stop';
interface Verdict { match: boolean; score?: number; discrepancies: Discrepancy[]; recommendation: Recommendation }

// ── manifest the implement/fix agent writes (.uix/last-gen.json) ──────────────
interface LastGen {
  entry?: string;        // the screen source file
  previewEntry?: string; // a runnable entrypoint that shows JUST this screen
  framework?: string;
  files?: string[];
}

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, '_');

// P2: per-project BUILD mutex. With parallel workers the expensive LLM agent calls
// (implement/verify/fix) run concurrently, but the build+screenshot step writes to
// SHARED, per-project locations (build/web, dist/, .uix/last-gen.json), so two
// builds at once would clobber each other. We serialize ONLY that step per project:
// agents think in parallel, the bundle builds one at a time. (RFC §4.6's build-once/
// hot-swap would remove even this serialization; deferred — see renderPreview TODO.)
// Audit A.2 (FIXED): per-screen previewEntry isolation. The implement agent still
// writes a single shared .uix/last-gen.json, but runScreenLoop now SNAPSHOTS this
// screen's previewEntry right after its own agent call (snapshotLastGen) and feeds
// that snapshot into the build — it no longer re-reads the shared file inside the
// lock, so a sibling worker overwriting last-gen can't make worker A screenshot
// worker B's screen. With that, parallel>1 verifies the right screen. (The mutex
// still dominates wall-time on build-heavy frameworks until RFC §4.6 build-once.)
const buildLocks = new Map<string, Promise<void>>();
async function withBuildLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = buildLocks.get(projectRoot) ?? Promise.resolve();
  // The tail every later caller will chain on: prev finishing AND fn finishing.
  let release!: () => void;
  const done = new Promise<void>(r => { release = r; });
  const tail = prev.then(() => done);
  buildLocks.set(projectRoot, tail);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (buildLocks.get(projectRoot) === tail) buildLocks.delete(projectRoot);
  }
}

// References are exported @2× by the renderer (a 393px frame → 786px PNG). To make
// "match" verdicts trustworthy (RFC §4.6) the candidate MUST be captured at the SAME
// SCALE and the SAME framing as the reference — i.e. the FRAME's own height, NOT a
// forced-tall window. Flutter web fills whatever window height it's given, so the old
// fullPage path (which forces a ≥4000px window) rendered an 852px screen at the top
// of an 8000px canvas with a huge blank void below → every candidate scored low for
// "blank area below" vs the tight 1704px reference. Capture at the frame height
// (fullPage:false → window = width×height = the reference framing). Frames taller than
// TALL_FRAME_THRESHOLD use the separate viewport-tile path, so nothing is clipped.
const REF_DEVICE_SCALE = 2;
const CAPTURE_SHOT_OPTS = { deviceScale: REF_DEVICE_SCALE, fullPage: false } as const;
// P1 (RFC §4.6): a reference taller than this (logical px) is downsampled below the
// model's vision long-edge cap when judged as ONE image. Above it, capture the
// candidate as vertical viewport-tall tiles (full resolution) and verify per band.
const TALL_FRAME_THRESHOLD = 1500;

const routeNameFor = (name: string): string =>
  '/' + ((name || 'screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen');

/**
 * The GLOBAL app plan the server injects into EVERY screen's prompt: the complete,
 * fixed screen inventory + route table + navigation graph, plus a hard rule that
 * the agent must wire only to these screens and NEVER invent new ones. This is the
 * fix for "the AI builds its own screens" — each screen is built with the whole
 * app in view, so it registers routes to known screens instead of improvising.
 */
// ── P4 (RFC §4.4): DIGEST PLANNER ────────────────────────────────────────────
// Instead of feeding the planner full IR (≈150K tok for Ping), derive a COMPACT
// structural digest from each screen's already-on-disk IR/packet text — dominant
// colors, fonts, and which shared components recur — and fold that into the app
// plan as a DESIGN-SYSTEM SUMMARY + SHARED-COMPONENT INVENTORY. This is the
// planning signal that was missing (the agent had routes but no shared visual
// vocabulary), produced deterministically (no LLM pass) from cheap digests.
const HEX = /#[0-9a-fA-F]{6}\b/g;
// font hints appear as `font: Inter`, `fontFamily: SF Pro`, `"Inter"` etc.
const FONT_HINT = /(?:font(?:-?family|Family)?\s*[:=]\s*|typeface\s*[:=]\s*)["']?([A-Za-z][A-Za-z0-9 _-]{1,30})/g;
// component-ish node names: capitalized PascalCase tokens / `[component: X]` / Card/Button/etc.
const COMPONENT_HINT = /\b(?:component\s*[:=]\s*)?([A-Z][a-zA-Z]{2,}(?:Button|Card|Bar|Item|Tile|Field|Input|Header|Footer|Nav|List|Row|Avatar|Chip|Badge|Modal|Sheet|Tab|Cell|Icon))\b/g;

function topN<T>(counts: Map<T, number>, n: number): T[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}
function tally(re: RegExp, text: string, into: Map<string, number>, group = 0): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = (group ? m[group] : m[0])?.trim();
    if (key) into.set(key, (into.get(key) ?? 0) + 1);
  }
}

interface DesignDigest { colors: string[]; fonts: string[]; components: Array<{ name: string; screens: number }> }
function buildDesignDigest(run: import('./build-run-store').BuildRun): DesignDigest {
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  // Component recurrence: count DISTINCT screens a component name shows up in (a
  // name in many screens = a real shared component, not a one-off).
  const compScreenCounts = new Map<string, number>();
  for (const s of run.screens) {
    const text = `${s.spec?.tree ?? ''}\n${s.spec?.packet ?? ''}`;
    if (!text.trim()) continue;
    tally(HEX, text, colorCounts);
    tally(FONT_HINT, text, fontCounts, 1);
    const seenHere = new Set<string>();
    COMPONENT_HINT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPONENT_HINT.exec(text))) { const k = m[1]; if (k) seenHere.add(k); }
    for (const k of seenHere) compScreenCounts.set(k, (compScreenCounts.get(k) ?? 0) + 1);
  }
  const components = [...compScreenCounts.entries()]
    .filter(([, n]) => n >= 2)                  // shared = recurs across ≥2 screens
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, screens]) => ({ name, screens }));
  return { colors: topN(colorCounts, 8), fonts: topN(fontCounts, 4), components };
}

/**
 * Build a frameId → canonical route resolver. In canonical mode (RFC §4.2) routes
 * MUST derive from canonical.screens / canonicalId (the single identity axis), NOT
 * the mutable frameName — otherwise the skeleton (canonical routes) and the injected
 * app plan / API surface (frameName routes) disagree and the agent is handed two
 * route schemes (audit A.3). Every member frame (states/modals folded into a lead)
 * resolves to its canonical screen's route. Returns null when not canonical so the
 * legacy frameName scheme is used unchanged.
 */
function canonicalRouteResolver(canonical?: Canonical): ((frameId: string) => string) | null {
  if (!canonical) return null;
  const routeByFrame = new Map<string, string>();
  for (const cs of canonical.screens) {
    for (const fid of cs.frameIds) routeByFrame.set(fid, cs.route);
    for (const st of cs.states) routeByFrame.set(st.frameId, cs.route);
    for (const m of cs.modals) routeByFrame.set(m.frameId, cs.route);
  }
  return (frameId: string) => routeByFrame.get(frameId) ?? routeNameFor(frameId);
}

export function buildAppPlan(run: import('./build-run-store').BuildRun, canonical?: Canonical): string {
  const nameById = new Map(run.screens.map(s => [s.frameId, s.frameName]));
  // ONE route scheme: canonical (canonicalId-derived) when canonicalized, else the
  // legacy frameName slug. Keyed on frameId so canonical + legacy agree (audit A.3).
  const canonRoute = canonicalRouteResolver(canonical);
  const routeFor = (frameId: string, frameName: string): string =>
    canonRoute ? canonRoute(frameId) : routeNameFor(frameName);
  const out: string[] = [
    `APP PLAN — the COMPLETE, FIXED set of screens in this app. Wire navigation ONLY to these screens; NEVER create, invent, rename, or stub a screen that is not in this list. If a navigation target is not built yet, route to its route name below — a later step fills it in.`,
  ];
  // P4: design-system summary + shared-component inventory (from compact digests).
  const digest = buildDesignDigest(run);
  if (digest.colors.length || digest.fonts.length) {
    out.push(`DESIGN SYSTEM — a real theme file (lib/theme/app_theme.dart, class \`AppTheme\`) is GENERATED before screens build. IMPORT \`AppTheme.<token>\` for colors/spacing/radius/typeface; a raw Color(0x..)/fontSize/EdgeInsets literal that duplicates a token is a DEFECT the review flags. The exact symbol list is in .uix/context.md ("Design system (importable)").`);
    if (digest.colors.length) out.push(`- Palette behind the tokens (most-used): ${digest.colors.join(', ')}`);
    if (digest.fonts.length) out.push(`- Typeface(s): ${digest.fonts.join(', ')}`);
  }
  if (digest.components.length) {
    out.push(`SHARED COMPONENT INVENTORY (these recur across multiple screens — build each ONCE as a reusable widget and reuse it; do NOT re-implement per screen):`);
    for (const c of digest.components) out.push(`- ${c.name} (used in ${c.screens} screens)`);
  }
  if (run.flow?.entryFrameId) {
    const en = nameById.get(run.flow.entryFrameId) || run.flow.entryFrameId;
    out.push(`Entry / start screen: "${en}" (route ${routeFor(run.flow.entryFrameId, en)}).`);
  }
  out.push(`Screens (name → route):`);
  for (const s of run.screens) out.push(`- "${s.frameName}" → ${routeFor(s.frameId, s.frameName)}`);
  // P2: nav graph. When canonicalized, render the CANONICAL edges — they carry the
  // preserved 'replace' kind + the step-modal provenance (viaModalId: a nav that is
  // triggered from INSIDE a sheet, which the base screen must present first, never
  // skip). Legacy (non-canonical) runs keep the raw frame-level rendering.
  const canonEdges = canonical?.flow?.edges;
  if (canonEdges?.length) {
    const screenById = new Map(canonical!.screens.map(s => [s.canonicalId, s]));
    const modalById = new Map<string, { frameId: string; baseName: string }>();
    for (const s of canonical!.screens) for (const m of s.modals) modalById.set(m.id, { frameId: m.frameId, baseName: s.name });
    const nameOf = (id: string): string => {
      const s = screenById.get(id);
      if (s) return s.name;
      const m = modalById.get(id);
      if (m) return nameById.get(m.frameId) ?? id;
      return id;
    };
    out.push(`Navigation graph (build these transitions, no dead ends):`);
    for (const e of canonEdges) {
      let line = `- "${nameOf(e.fromCanonicalId)}" --(${e.kind}${e.label ? ` "${e.label}"` : ''})--> "${nameOf(e.toCanonicalId)}"`;
      if (e.viaModalId) {
        const via = modalById.get(e.viaModalId);
        const modalName = via ? (nameById.get(via.frameId) ?? e.viaModalId) : e.viaModalId;
        line += `  [FROM INSIDE the '${modalName}' sheet — the sheet's confirm action navigates; the base screen must NOT skip the sheet]`;
      }
      out.push(line);
    }
  } else if (run.flow?.connections?.length) {
    out.push(`Navigation graph (build these transitions, no dead ends):`);
    for (const c of run.flow.connections) {
      const f = nameById.get(c.from) || c.from, t = nameById.get(c.to) || c.to;
      out.push(`- "${f}" --(${c.type}${c.label ? ` "${c.label}"` : ''})--> "${t}"`);
    }
  }
  out.push(`Register ALL these routes in the central router by name (a placeholder/empty screen is fine for ones not built yet). Build ONLY the current screen below; do not implement, overwrite, or duplicate the others.`);
  return out.join('\n');
}

/**
 * P2 (RFC §4.5 — the coherence vehicle): the SERVER reads the agent's written
 * contract (.uix/context.md) and INJECTS it into every screen's prompt. Today the
 * packet only *tells* the agent to read context.md; that breaks the moment the CLI
 * is a cold/fresh session (codex & gemini ALWAYS are, claude is when freshSessions
 * is on) because the file may not be opened, and even when opened it competes with
 * the rest of the prompt for attention. Injecting it server-side guarantees the
 * established design system / routing / screens index is in-context for EVERY
 * screen, model-independently — which is what lets us drop the shared --resume
 * session and still keep visual coherence.
 *
 * Bounded so a runaway context.md can't blow the window (later screens append to it).
 */
const CONTEXT_SLICE_MAX = 12000;
async function readContextSlice(projectRoot: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'context.md'), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return '';
    // Keep the HEAD (design-system + routing live up top, written first) when the
    // file outgrows the budget; the tail is the per-screen index which the app plan
    // already covers.
    return trimmed.length > CONTEXT_SLICE_MAX
      ? trimmed.slice(0, CONTEXT_SLICE_MAX) + '\n…(context.md truncated — open .uix/context.md for the full contract)'
      : trimmed;
  } catch { return ''; }
}

/**
 * P2 (RFC §4.5): a canonical COMPONENT / ROUTE API surface derived deterministically
 * from the run — the signatures each screen must build against. Today this is the
 * route table (canonical names every screen wires to). Until canonicalization (P3)
 * produces real shared-component signatures, the surface is the stable route slugs
 * + the screens index from context.md. Kept as its own block so each screen builds
 * against a SHARED contract instead of re-inventing names per session.
 */
function buildComponentApiSurface(run: import('./build-run-store').BuildRun, canonical?: Canonical): string {
  const out: string[] = [
    `CANONICAL API SURFACE — the shared route/screen names every screen MUST build against (do NOT invent variants of these names; reuse them verbatim so cross-screen navigation resolves):`,
  ];
  // ONE route scheme — canonical routes when canonicalized (audit A.3), else legacy.
  if (canonical) {
    for (const cs of canonical.screens) out.push(`- route ${cs.route}  ⟶  screen "${cs.name}" (canonicalId ${cs.canonicalId})`);
    if (canonical.components.length) {
      for (const c of canonical.components) out.push(`- component ${c.name} (import from lib/components/)`);
    }
  } else {
    for (const s of run.screens) out.push(`- route ${routeNameFor(s.frameName)}  ⟶  screen "${s.frameName}"`);
  }
  // Component OWNERSHIP (option 3, Fix #1): recurring UI (from the digest) must be
  // extracted ONCE into lib/components/ and imported — not re-implemented per screen.
  // We can't author the widget bodies deterministically (that's the per-screen
  // agent's job), so we assign ownership + name them, and the review flags re-impl.
  const digest = buildDesignDigest(run);
  if (digest.components.length) {
    out.push(`SHARED WIDGETS — these recur across multiple screens; the FIRST screen that renders one CREATES it as a public widget in lib/components/<name>.dart and EXPORTS it, and every other screen IMPORTS it. Re-implementing one of these inline (a private _Foo widget duplicated across screens) is a DEFECT the review flags:`);
    for (const c of digest.components) out.push(`- ${c.name} (seen in ${c.screens} screens → lib/components/${c.name.replace(/[^A-Za-z0-9]/g, '')}.dart)`);
  }
  return out.join('\n');
}

/**
 * P2: assemble the full WRITTEN CONTRACT block the server injects ahead of a
 * screen's packet — app plan + canonical API surface + the injected context.md
 * slice. This is the model-independent coherence carrier (replaces leaning on the
 * CLI --resume session). `freshSessions` only changes a header note; the contract
 * body is identical so serial-shared-session and fresh-session builds converge on
 * the same design language.
 */
function buildWrittenContract(
  run: import('./build-run-store').BuildRun, appPlan: string, contextSlice: string, freshSession: boolean,
  canonical?: Canonical,
): string {
  const parts: string[] = [appPlan, buildComponentApiSurface(run, canonical)];
  if (contextSlice) {
    parts.push(
      [
        `ESTABLISHED PROJECT CONTRACT (.uix/context.md — written by earlier screens; AUTHORITATIVE for the design system, theme tokens, routing and shared components). REUSE what's here; do NOT redefine tokens/components that already exist, and EXTEND this file as you build:`,
        contextSlice,
      ].join('\n'),
    );
  } else if (freshSession) {
    parts.push(
      `No .uix/context.md exists yet — you are establishing the project contract. Create .uix/context.md (design system, routing, screens index) so every later screen builds against it.`,
    );
  }
  // THEME TOKENS — the reconciliation gate flags inline TextStyle/GoogleFonts/Color
  // literals (recon:inline-textstyle / recon:inline-color), which pushes otherwise-good
  // screens into needs-review. Tell the agent, authoritatively, to use AppTheme tokens.
  // (The exact token names live in .uix/context.md / lib/theme/app_theme.dart, already
  // injected above via the established contract.)
  parts.push([
    `THEME TOKENS — MANDATORY (the reconciliation gate REJECTS inline type/colour literals):`,
    `- Use the generated AppTheme for ALL text and colour: AppTheme text-style helpers for every Text, AppTheme colour tokens for every colour. Import lib/theme/app_theme.dart.`,
    `- NEVER inline a TextStyle(...), GoogleFonts.*(), Color(0x........), or Colors.* literal in a screen — these are flagged and the screen is sent back for review.`,
    `- The available token names are in the established project contract above (.uix/context.md). If a token you genuinely need is missing, request it via the amendment protocol below rather than inlining a literal.`,
  ].join('\n'));
  // P5 (RFC §4.8): AMENDMENT PROTOCOL. The plan is append-only + namespace-locked,
  // NOT frozen — but the agent must not silently invent routes/components. When a
  // route/component it genuinely needs is missing from the plan above, it REQUESTS
  // it instead of improvising, by writing .uix/amendment-request.json. The
  // orchestrator reads it after this screen and either auto-approves (whitelisted)
  // or queues it for human approval, then regenerates the skeleton.
  parts.push([
    `PLAN AMENDMENT PROTOCOL — the route/screen list above is the COMPLETE plan; do NOT invent a new top-level route or shared component. If you genuinely need one that is missing, DO NOT improvise it: write a request file at .uix/amendment-request.json and route to the nearest existing screen for now. The file is a JSON object (or an array of them):`,
    `{"kind": "add-route" | "add-component", "proposedApi": "<route slug like /foo, or a component name + props sketch>", "rationale": "<why the plan needs it>"}`,
    `Only emit this for a real gap — the reconciliation gate flags routes/components that are referenced but not in the plan.`,
  ].join('\n'));
  return parts.join('\n\n— — —\n');
}

// ── P1-core: folded-frame payloads in the lead screen's contract ──────────────
// The old canonical context named each folded state/modal in ONE line (`- modal
// "m_x" (frame N)`) — no reference image, no IR — although prep had ALREADY
// rendered every folded frame's reference to .uix/refs/ and its run.screens[]
// entry carries a full spec (tree + referenceImagePath). Result (Ping audit):
// 13/13 folded modals shipped as invented placeholders. These helpers emit the
// REAL payload per folded frame: its reference image path (with an explicit
// "open it" instruction), its (hygiene'd, bounded) IR tree, a deterministic
// presentation-kind hint from geometry, and the presenter contract the variant
// preview harness calls.

/** Bound a folded frame's IR so N variants can't blow the context window. */
const FOLDED_IR_MAX = 8000;
function boundFoldedIR(tree: string | undefined): string {
  const h = hygieneIR(tree) ?? '';
  return h.length > FOLDED_IR_MAX
    ? `${h.slice(0, FOLDED_IR_MAX)}\n…(IR truncated — the reference image is the full ground truth)`
    : h;
}

export type ModalPresentationKind = 'bottomSheet' | 'dialog' | 'fullOverlay';

// A tree-notation node line: `container "Modal" [375×627] …` → name + W×H.
const NODE_DIMS_RE = /"([^"]*)"\s*\[(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)\]/;
const MODALISH_NAME = /modal|sheet|dialog|dialogue|popup|pop-?over|drawer|overlay|toast|alert/i;

/**
 * P1-core: deterministic presentation-kind hint from the folded modal frame's
 * GEOMETRY (no LLM). The modal frame is authored at the base screen's full size;
 * what varies is its dominant content node:
 *   • narrow content (≪ frame width)                → centered DIALOG
 *   • near-full width + tall (≥60% of frame height) → FULL-SCREEN SCRIM OVERLAY
 *     (dimmed base + centered content — NOT a Material spinner dialog)
 *   • near-full width + short                        → BOTTOM SHEET
 * The content node is the largest modal-named (`Modal`/`Sheet`/`Dialog`/…) node in
 * the IR; a frame much smaller than the base is itself dialog-sized. Pure + tested.
 */
export function modalPresentationHint(
  tree: string | undefined, frameW?: number, frameH?: number, baseW?: number, baseH?: number,
): { kind: ModalPresentationKind; hint: string } {
  const hints: Record<ModalPresentationKind, string> = {
    bottomSheet: `BOTTOM SHEET — present via showModalBottomSheet over the reused base (content anchored to the bottom edge, scrim above).`,
    dialog: `centered DIALOG — present via showDialog over the reused base (small centered card, dimmed scrim around it).`,
    fullOverlay: `FULL-SCREEN SCRIM OVERLAY — dim the (reused) base behind a scrim and center this content over it. Do NOT use a Material spinner dialog and do NOT rebuild the base as a new page.`,
  };
  const lines = (tree ?? '').split('\n');
  // Root dims from the first node line when the caller has no frame dims.
  const rootM = lines.length ? NODE_DIMS_RE.exec(lines[0]) : null;
  const fw = frameW ?? (rootM ? parseFloat(rootM[2]) : undefined);
  const fh = frameH ?? (rootM ? parseFloat(rootM[3]) : undefined);
  // A frame authored much smaller than the base screen IS the dialog card itself.
  if (fw && fh && baseW && baseH && fw < baseW * 0.8 && fh < baseH * 0.8) {
    return { kind: 'dialog', hint: `${hints.dialog} (the modal frame is ${fw}×${fh}, well under the ${baseW}×${baseH} base — the frame itself is the card)` };
  }
  // Largest modal-named content node inside the frame decides the kind.
  let best: { w: number; h: number; name: string } | null = null;
  for (let i = 1; i < lines.length; i++) {
    const m = NODE_DIMS_RE.exec(lines[i]);
    if (!m || !MODALISH_NAME.test(m[1])) continue;
    const w = parseFloat(m[2]), h = parseFloat(m[3]);
    if (!best || w * h > best.w * best.h) best = { w, h, name: m[1] };
  }
  if (!best || !fw || !fh) {
    return { kind: 'bottomSheet', hint: `${hints.bottomSheet} (no clearer geometry signal in the IR — default)` };
  }
  const wr = best.w / fw, hr = best.h / fh;
  const evidence = `(content node "${best.name}" is ${best.w}×${best.h} in a ${fw}×${fh} frame)`;
  if (wr < 0.85) return { kind: 'dialog', hint: `${hints.dialog} ${evidence}` };
  if (hr >= 0.6) return { kind: 'fullOverlay', hint: `${hints.fullOverlay} ${evidence}` };
  return { kind: 'bottomSheet', hint: `${hints.bottomSheet} ${evidence}` };
}

/**
 * P3 (RFC §4.1/§4.2): the CANONICAL context the server injects when a run is built
 * canonically. For the lead frame of a canonical screen it spells out the screen's
 * states, modals (rendered as overlays over THIS reused base, not standalone
 * pages), template siblings, and its write-locked route slot — so the agent builds
 * one widget with a state param instead of N near-duplicate routes/files.
 *
 * P1-core: when `runScreens` is provided (callers inside a durable run have it),
 * each folded state/modal block carries its OWN reference image path + bounded IR
 * + presentation hint + presenter contract — the payload the agent needs to build
 * the variant for real instead of inventing a placeholder.
 */
export function buildCanonicalContext(canonical: Canonical, cs: CanonicalScreen, runScreens?: RunScreen[]): string {
  const out: string[] = [
    `CANONICAL SCREEN — this is ONE screen (canonicalId ${cs.canonicalId}, route ${cs.route}); build a SINGLE widget, not one page per variant. Its write-locked route slot already exists in lib/app_router.dart; fill the widget body, keep the route.`,
  ];
  const specOf = (frameId: string): ScreenSpec | undefined =>
    runScreens?.find(s => s.frameId === frameId)?.spec;
  const leadFrameId = cs.states[0]?.frameId ?? cs.frameIds[0];
  const leadSpec = leadFrameId ? specOf(leadFrameId) : undefined;
  const className = planSemanticScreens(canonical).get(cs.canonicalId)?.className ?? 'the screen widget';
  // P2: a TAB-cluster member is HOSTED — the shared AppShell owns the bottom nav
  // and tab switching. Without this, every tab screen improvises its own raster
  // navbar + pushNamed's its siblings (Ping audit).
  const tabCluster = computeTabCluster(canonical);
  if (tabCluster?.memberIds.includes(cs.canonicalId)) {
    out.push(
      `APP SHELL — this screen is a TAB destination hosted inside AppShell (lib/screens/app_shell.dart, an IndexedStack over the tab cluster). Do NOT render your own bottom navigation bar — the shell owns it (one shared bottom nav for all tabs). Never Navigator.push a tab route from inside a tab screen; tab switching is the shell's job (it only changes the IndexedStack index). Build this screen's body WITHOUT any bottom nav.`,
    );
  }
  let foldedPayloads = 0;
  if (cs.states.length > 1) {
    out.push(`States (one widget + a state param — NOT separate routes; each state is verified individually against its own reference):`);
    for (const s of cs.states) {
      const spec = s.frameId === leadFrameId ? undefined : specOf(s.frameId);
      if (!spec?.referenceImagePath) { out.push(`- state "${s.id}" (frame ${s.frameId})${s.frameId === leadFrameId ? ' — the base/default state this packet builds' : ''}`); continue; }
      foldedPayloads++;
      out.push([
        `- FOLDED STATE "${s.id}" (frame ${s.frameId}) — rendered by THIS widget as ${className}(state: '${s.id}'); NOT a separate route/file.`,
        `  REFERENCE IMAGE (ground truth): ${spec.referenceImagePath} — OPEN this image with your file-reading tool and match it EXACTLY (layout, text, colours).`,
        `  IR TREE of this state's frame:`,
        boundFoldedIR(spec.tree),
      ].join('\n'));
    }
  }
  if (cs.modals.length) {
    out.push(`Modals/sheets to present OVER this (reused) base screen — do NOT rebuild the base and do NOT make these full standalone pages:`);
    for (const m of cs.modals) {
      const spec = specOf(m.frameId);
      if (!spec?.referenceImagePath) { out.push(`- modal "${m.id}" (frame ${m.frameId})`); continue; }
      foldedPayloads++;
      const p = modalPresentationHint(spec.tree, spec.width, spec.height, leadSpec?.width, leadSpec?.height);
      out.push([
        `- FOLDED MODAL "${m.id}" (frame ${m.frameId}) — part of THIS screen.`,
        `  REFERENCE IMAGE (ground truth): ${spec.referenceImagePath} — OPEN this image with your file-reading tool and match it EXACTLY (layout, text, colours).`,
        `  PRESENTATION (derived from the frame's geometry): ${p.hint}`,
        `  PRESENTER CONTRACT: declare a top-level function \`Future<void> ${modalPresenterName(m.id)}(BuildContext context)\` in this screen's file that presents this modal. The name is FIXED — the automated preview harness calls it verbatim to screenshot the modal for verification.`,
        `  IR TREE of the modal frame:`,
        boundFoldedIR(spec.tree),
      ].join('\n'));
    }
  }
  if (foldedPayloads > 0) {
    out.push(
      `EVERY folded state/modal above is verified INDIVIDUALLY against its own reference image after the base screen passes — an unimplemented, missing, or wrong variant sends this screen back for fixes. Placeholder/deferred implementations are FORBIDDEN and will fail reconciliation: no "placeholder" sheets, no "real frames come later" comments, no empty onTap/onPressed handlers.`,
    );
  }
  if (cs.templateRef) {
    const sibs = canonical.templates.find(t => t.id === cs.templateRef)?.memberCanonicalIds.filter(id => id !== cs.canonicalId) ?? [];
    out.push(`This screen shares template "${cs.templateRef}" with ${sibs.length} sibling screen(s) — extract the shared layout into a reusable widget + thin per-screen config.`);
  }
  if (canonical.components.length) {
    out.push(`Shared components available (import from lib/components/ — reuse, don't re-invent): ${canonical.components.map(c => c.name).join(', ')}.`);
  }
  return out.join('\n');
}

/**
 * P1-core: the folded state/modal variants a canonical LEAD screen must realize —
 * each becomes an individually-verified target in runScreenLoop (its own preview
 * entry, screenshot, reference compare, fix loop, and terminal status). The lead
 * (default) state is NOT a variant — the lead's own loop verifies it.
 */
export function variantsForCanonicalScreen(cs: CanonicalScreen, runScreens: RunScreen[]): ScreenVariant[] {
  const lead = cs.states[0]?.frameId ?? cs.frameIds[0];
  const byFrame = new Map(runScreens.map(s => [s.frameId, s]));
  const out: ScreenVariant[] = [];
  for (const st of cs.states) {
    if (st.frameId === lead) continue;
    const rs = byFrame.get(st.frameId);
    out.push({
      kind: 'state', id: st.id, frameId: st.frameId, frameName: rs?.frameName ?? st.id,
      referenceImagePath: rs?.spec?.referenceImagePath, width: rs?.spec?.width, height: rs?.spec?.height,
    });
  }
  for (const m of cs.modals) {
    const rs = byFrame.get(m.frameId);
    out.push({
      kind: 'modal', id: m.id, frameId: m.frameId, frameName: rs?.frameName ?? m.id,
      referenceImagePath: rs?.spec?.referenceImagePath, width: rs?.spec?.width, height: rs?.spec?.height,
    });
  }
  return out;
}

// ── P4 (RFC §4.5): IR HYGIENE ────────────────────────────────────────────────
// The agent-facing IR carries dead weight: every asset line has a `[preview:<url>]`
// annotation (a CSS-renderer hint the coding agent never needs — measured as pure
// context cost in the failed Ping run), and lists/grids repeat near-identical
// sibling lines dozens of times. We (1) STRIP the preview annotations and (2)
// RUN-LENGTH-ENCODE consecutive identical sibling lines into `<line>  ×N`. This is
// applied to the IR `tree` and to the IR portion of the packet on the way INTO the
// agent prompt — the on-disk notation is untouched (renderer/UI still use it).
const PREVIEW_ANNOTATION = /\s*\[preview:[^\]]*\]/g;

/** Strip `[preview:<url>]` asset annotations from agent-facing IR text. */
export function stripPreviewAnnotations(ir: string): string {
  return ir ? ir.replace(PREVIEW_ANNOTATION, '') : ir;
}

// The tree uses box-drawing/indent prefixes (│ ├ └ etc.) before the node content.
// Two siblings are "the same" when the content AFTER the leading tree glyphs and
// whitespace is identical — RLE collapses a run of them so a 40-item list isn't 40
// lines. We keep the FIRST occurrence verbatim and append `  ×N`.
const TREE_PREFIX = /^[\s│├└─┬┴┼╰╯╭╮|`+\-]*/;
const stripTreePrefix = (line: string): string => line.replace(TREE_PREFIX, '').trim();

// OS chrome — an OS status bar, the software keyboard, and the home indicator are
// rendered by the real device, NOT the app. Figma iOS templates include them as
// layers ("Status Bar", "Keyboard", "Home Indicator") purely for prototyping, and
// the user's standing rule is to never build them. Strip such a node AND its whole
// subtree from the agent-facing IR so the agent doesn't waste effort reproducing OS
// chrome (and the screen's real content isn't pushed down by a fake 94px bar). The
// verify prompt already carries the matching "do not add a status bar/keyboard" rule.
const CHROME_NODE = /"[^"]*\b(?:status\s*bar|keyboard|home\s*indicator)\b[^"]*"/i;
const depthOf = (line: string): number => Math.round((line.match(TREE_PREFIX)?.[0].length ?? 0) / 4);
/** Remove OS status-bar / keyboard / home-indicator nodes (and their children). */
export function stripChromeNodes(ir: string): string {
  if (!ir) return ir;
  const lines = ir.split('\n');
  const out: string[] = [];
  let skipDepth = -1;
  for (const line of lines) {
    const d = depthOf(line);
    if (skipDepth >= 0) {
      if (line.trim() && d > skipDepth) continue;   // still inside the stripped subtree
      skipDepth = -1;                                 // back out to a sibling/ancestor
    }
    if (CHROME_NODE.test(stripTreePrefix(line))) { skipDepth = d; continue; }
    out.push(line);
  }
  return out.join('\n');
}

/** Collapse runs of consecutive identical sibling lines into `<line>  ×N`. */
export function rleRepeatedSiblings(ir: string): string {
  if (!ir) return ir;
  const lines = ir.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = stripTreePrefix(lines[i]);
    let n = 1;
    // Only collapse non-trivial content lines (skip blanks / 1-char glyphs).
    if (key.length > 2) {
      while (i + n < lines.length && stripTreePrefix(lines[i + n]) === key) n++;
    }
    out.push(n > 1 ? `${lines[i]}  ×${n}` : lines[i]);
    i += n;
  }
  return out.join('\n');
}

/** Full IR-hygiene pass for agent-facing IR: strip previews + RLE siblings. */
export function hygieneIR(ir: string | undefined): string | undefined {
  if (!ir) return ir;
  return rleRepeatedSiblings(stripChromeNodes(stripPreviewAnnotations(ir)));
}

async function readLastGen(projectRoot: string): Promise<LastGen> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'last-gen.json'), 'utf8');
    return JSON.parse(raw) as LastGen;
  } catch { return {}; }
}

// ── prompt builders ───────────────────────────────────────────────────────────

function verifyPrompt(refPath: string, candPath: string, frameName: string, prevScore: number | null, userNotes?: string): string {
  const notes = (userNotes ?? '').trim();
  return [
    `You are a STRICT visual-QA reviewer. Do not write or edit any files.`,
    `Open these two images with your file-reading tool:`,
    `  - REFERENCE (ground truth, the target design): ${refPath}`,
    `  - CANDIDATE (a screenshot of the current build of screen "${frameName}"): ${candPath}`,
    `Compare them carefully: layout & hierarchy, spacing/proportions, colours, typography, text content, icons/illustrations, and overall fidelity.`,
    notes ? `USER RULES / INTENT (authoritative) — respect these when judging; do NOT flag an INTENTIONAL omission as a discrepancy (e.g. if the user said no OS status bar / no default keyboard, then a missing status bar or keyboard is CORRECT, not a discrepancy):\n${notes}` : '',
    prevScore != null ? `The previous pass scored ${prevScore}/100 — judge whether this pass actually improved; if it's no better, another automated fix is unlikely to help (lean towards "stop").` : '',
    `If the reference shows a MODAL / OVERLAY / SHEET / POPUP over a base screen, the candidate should render that overlay ON TOP of the (reused) base screen — flag a discrepancy if the candidate rebuilt the whole screen or rendered the overlay as a standalone full page.`,
    `Respond with ONLY a single JSON object (no prose, no code fences):`,
    `{"match": <true|false>, "score": <0-100>, "recommendation": "accept|fix|stop", "discrepancies": [{"area":"<where>","issue":"<what's wrong vs the reference>","severity":"high|med|low"}]}`,
    `- "match": true ONLY if visually near-identical (no high/med discrepancies).`,
    `- "recommendation": "accept" = good enough, stop now (a match, or only trivial cosmetic diffs); "fix" = real fixable discrepancies remain and another pass is worthwhile; "stop" = broken / way off / clearly NOT converging, so another automated pass won't help — defer to a human.`,
    `List every concrete difference; be specific and actionable.`,
  ].filter(Boolean).join('\n');
}

// P1 (RFC §4.6): verify a TALL screen judged as vertical tiles. The candidate is
// supplied as full-resolution top→bottom bands (with overlap); the single
// reference covers the whole screen. The agent reads every band and judges the
// WHOLE screen — tiling exists to keep candidate detail above the model's
// downsample cap, not to compare bands in isolation.
function tiledVerifyPrompt(refPath: string, candTilePaths: string[], frameName: string, prevScore: number | null, userNotes?: string): string {
  const notes = (userNotes ?? '').trim();
  return [
    `You are a STRICT visual-QA reviewer. Do not write or edit any files.`,
    `The screen "${frameName}" is TALL, so its current build is given as ${candTilePaths.length} full-resolution VERTICAL TILES (top→bottom, slightly overlapping) instead of one downsized image. Open ALL of these with your file-reading tool:`,
    `  - REFERENCE (ground truth, the WHOLE screen): ${refPath}`,
    ...candTilePaths.map((p, i) => `  - CANDIDATE tile ${i + 1}/${candTilePaths.length} (top→bottom band of the current build): ${p}`),
    `Mentally stack the candidate tiles into the full screen and compare it to the reference: layout & hierarchy, spacing/proportions, colours, typography, text content, icons/illustrations, and overall fidelity across the ENTIRE height (the lower portion matters too).`,
    notes ? `USER RULES / INTENT (authoritative) — respect these; do NOT flag an INTENTIONAL omission as a discrepancy:\n${notes}` : '',
    prevScore != null ? `The previous pass scored ${prevScore}/100 — judge whether this pass actually improved; if it's no better, another automated fix is unlikely to help (lean towards "stop").` : '',
    `Respond with ONLY a single JSON object (no prose, no code fences):`,
    `{"match": <true|false>, "score": <0-100>, "recommendation": "accept|fix|stop", "discrepancies": [{"area":"<where, incl. which band>","issue":"<what's wrong vs the reference>","severity":"high|med|low"}]}`,
    `- "match": true ONLY if visually near-identical (no high/med discrepancies) across all bands.`,
    `- "recommendation": "accept" = good enough; "fix" = real fixable discrepancies remain; "stop" = broken / not converging.`,
    `List every concrete difference; be specific and actionable.`,
  ].filter(Boolean).join('\n');
}

function fixPrompt(frameName: string, refPath: string, candPath: string, v: Verdict, userNotes?: string): string {
  const items = v.discrepancies.map((d, i) => `  ${i + 1}. [${d.severity ?? 'med'}] ${d.area ? d.area + ': ' : ''}${d.issue}`).join('\n');
  const notes = (userNotes ?? '').trim();
  return [
    `The screen "${frameName}" you built does NOT yet match its reference design (visual score ${v.score ?? '?'} / 100).`,
    `Reference (ground truth): ${refPath}`,
    `Current build screenshot:  ${candPath}`,
    notes ? `USER RULES / INTENT (authoritative — DO NOT violate, even to satisfy a discrepancy below; e.g. do NOT add an OS status bar or default keyboard if the user excluded them):\n${notes}\n` : '',
    `Open BOTH images, then revise the EXISTING screen file(s) to fix these specific discrepancies — but skip any that contradict the user rules above:`,
    items || '  (general fidelity — bring it closer to the reference)',
    `Reuse the project's existing design system / theme / shared components — do not restyle inline.`,
    `Keep the preview entrypoint working and keep .uix/last-gen.json accurate (including "previewEntry"). Output a one-line summary.`,
  ].filter(Boolean).join('\n');
}

// ── parse the verify agent's JSON verdict (robust to fences / stray prose) ─────
function parseVerdict(text: string): Verdict {
  // A broken/unparseable verify result is itself a reason to stop (not to keep
  // burning fix passes blindly), so default recommendation 'stop'.
  const fail = (issue: string): Verdict => ({ match: false, discrepancies: [{ issue, severity: 'high' }], recommendation: 'stop' });
  if (!text) return fail('verify agent produced no output');
  // Grab the largest brace-balanced JSON object in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('verify output had no JSON object');
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const match = !!j.match;
    const discrepancies = Array.isArray(j.discrepancies)
      ? j.discrepancies.map((d: any) => ({ area: d?.area, issue: String(d?.issue ?? d ?? 'unspecified'), severity: d?.severity }))
      : [];
    const rec: Recommendation = j.recommendation === 'accept' || j.recommendation === 'fix' || j.recommendation === 'stop'
      ? j.recommendation
      : (match ? 'accept' : (discrepancies.length ? 'fix' : 'accept'));
    return { match, score: typeof j.score === 'number' ? j.score : undefined, discrepancies, recommendation: rec };
  } catch { return fail('verify output JSON was malformed'); }
}

// ── BUILD-ONCE GUARD (RFC §4.6) ──────────────────────────────────────────────
// The old loop ran a full `flutter build web --release` (or `npm run build`) on
// EVERY verify iteration — up to 6×N builds at N=100, the dominant wall-clock cost
// and the reason the parallel pool buys little. The fully-correct fix (a held dev
// server hot-swapping the entrypoint per iteration) is a larger change; the SAFE
// SUBSET we land here:
//   (a) a content-hash GUARD over the screen's source (lib/ for Flutter, src/ +
//       config for web) + the target entrypoint: re-verifies whose source is
//       byte-identical to the last successful build REUSE that build instead of
//       rebuilding. A fix pass changes source so it rebuilds; a transient
//       screenshot retry / unchanged re-verify does not.
//   (b) Flutter builds default to the FASTER non-`--release` web build (the
//       dev/profile compiler), opt back into release with RELAY_PREVIEW_RELEASE=1.
// TODO(P1, RFC §4.6 full): hold ONE persistent dev server (`flutter run -d
// web-server` / `vite dev`) per run and hot-swap only the preview entrypoint per
// screen/iteration — removes even the incremental rebuild. Deferred (needs a
// long-lived process lifecycle + readiness/recompile signaling), guarded behind
// this build-once subset so it stays correct + compiling in the meantime.
const FLUTTER_RELEASE_PREVIEW = process.env.RELAY_PREVIEW_RELEASE === '1';

/** Hash the source that determines a build's output, so an unchanged re-verify can
 *  skip the rebuild. Walks the framework's source dir(s) + the target entrypoint;
 *  cheap (mtime+size) so it doesn't read every byte of a large project. */
function sourceFingerprint(projectRoot: string, framework: string, target: string): string {
  const fw = framework.toLowerCase();
  const roots = fw === 'flutter'
    ? ['lib', 'pubspec.yaml', 'pubspec.lock']
    : ['src', 'package.json', 'index.html', 'vite.config.ts', 'vite.config.js'];
  const parts: string[] = [target];
  const walk = (rel: string): void => {
    const abs = path.join(projectRoot, rel);
    let st: fsSync.Stats;
    try { st = fsSync.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try { entries = fsSync.readdirSync(abs); } catch { return; }
      for (const e of entries.sort()) walk(path.join(rel, e));
    } else {
      parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  for (const r of roots) walk(r);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}
// Per-project last successful build: fingerprint of the source + the served output
// dir. A matching fingerprint means the existing build/web (or dist/) is still
// valid → reuse it (no rebuild). Cleared implicitly when the fingerprint changes.
const lastBuild = new Map<string, { fingerprint: string; outDir: string }>();

// ── render the preview entrypoint of the REAL project to a PNG ────────────────
// Builds the screen's standalone entrypoint within the actual project (real
// theme/fonts/router) and screenshots it. Returns the PNG or a build-error tail.
// Build-once subset (above) skips the rebuild when source is unchanged.
async function renderPreview(
  projectRoot: string, framework: string, previewEntry: string | undefined,
  width: number, height: number, env: NodeJS.ProcessEnv,
  shot: { deviceScale?: number; fullPage?: boolean; tiles?: boolean } = {},
): Promise<{ png?: Buffer; tiles?: Buffer[]; error?: string }> {
  const fw = framework.toLowerCase();
  // Capture the screenshot (or vertical tiles for a tall reference) from a served
  // dir, shared by the cached + freshly-built paths.
  const capture = async (url: string): Promise<{ png?: Buffer; tiles?: Buffer[]; error?: string }> => {
    if (shot.tiles) {
      const tiles = await captureUrlTiles(url, width, height, 60000, { deviceScale: shot.deviceScale });
      return tiles?.length ? { tiles } : { error: 'tiled screenshot of built app failed' };
    }
    const png = await captureUrlScreenshot(url, width, height, 60000, shot);
    return png ? { png } : { error: 'screenshot of built app failed' };
  };
  try {
    if (fw === 'flutter') {
      const flutter = path.join(getFlutterRoot(), 'bin', 'flutter');
      if (!fsSync.existsSync(flutter)) return { error: 'Flutter SDK not available' };
      if (!fsSync.existsSync(path.join(projectRoot, 'web'))) {
        await execFile(flutter, ['create', '--platforms=web', '.'], { cwd: projectRoot, env, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      }
      const target = previewEntry && fsSync.existsSync(path.join(projectRoot, previewEntry)) ? previewEntry : 'lib/main.dart';
      const webDir = path.join(projectRoot, 'build', 'web');
      // Build-once guard: reuse the existing build when the source is unchanged.
      const fp = sourceFingerprint(projectRoot, fw, target);
      const cached = lastBuild.get(projectRoot);
      const reuse = cached && cached.fingerprint === fp && cached.outDir === webDir
        && fsSync.existsSync(path.join(webDir, 'index.html'));
      if (!reuse) {
        const args = ['build', 'web', ...(FLUTTER_RELEASE_PREVIEW ? ['--release'] : []), '-t', target];
        try {
          await execFile(flutter, args, { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
        } catch (e: any) {
          lastBuild.delete(projectRoot);
          return { error: `flutter build web failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
        }
        if (!fsSync.existsSync(path.join(webDir, 'index.html'))) { lastBuild.delete(projectRoot); return { error: 'flutter build produced no web output' }; }
        lastBuild.set(projectRoot, { fingerprint: fp, outDir: webDir });
      }
      const srv = await serveDir(webDir);
      try { return await capture(srv.url); } finally { srv.close(); }
    }

    // Web (Vite/React/Next static export). Best-effort: build, serve the output
    // dir, navigate to the preview route if one was provided.
    const target = previewEntry && previewEntry.startsWith('/') ? previewEntry : 'lib/main.dart';
    const fp = sourceFingerprint(projectRoot, fw, target);
    const cached = lastBuild.get(projectRoot);
    let outDir = cached && cached.fingerprint === fp && fsSync.existsSync(path.join(cached.outDir, 'index.html'))
      ? cached.outDir : '';
    if (!outDir) {
      try {
        await execFile('npm', ['run', 'build'], { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
      } catch (e: any) {
        lastBuild.delete(projectRoot);
        return { error: `web build (npm run build) failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
      }
      const found = ['dist', 'out', 'build'].map(d => path.join(projectRoot, d)).find(d => fsSync.existsSync(path.join(d, 'index.html')));
      if (!found) { lastBuild.delete(projectRoot); return { error: 'web build produced no servable output (dist/ out/ build/)' }; }
      outDir = found;
      lastBuild.set(projectRoot, { fingerprint: fp, outDir });
    }
    const srv = await serveDir(outDir);
    try {
      const route = previewEntry && previewEntry.startsWith('/') ? previewEntry : '';
      const url = route ? `${srv.url.replace(/\/index\.html$/, '')}${route}` : srv.url;
      return await capture(url);
    } finally { srv.close(); }
  } catch (e: any) {
    return { error: e?.message || 'preview render failed' };
  }
}

// ── BUG 1: robust verify-rollup verdict (no silent 0/0 finalize) ──────────────
// The verify rollup read `getRun` ONCE and let `total/built/blocking` collapse to 0
// when that read returned null / a screens-less / an under-populated run (a transient
// read during heavy concurrent writes). A 0/0 collapse skipped the `blocking>0` park
// and FINALIZED a half-built app (a run with 17/30 needs-review screens shipped done).
//
// `resolveRollupVerdict` is the PURE guard: given the freshly-read run and the
// authoritative expected count (the in-memory run.screens.length), it returns one of:
//   - 'finalize'           : the read is consistent (total === expected), blocking 0,
//                            AND built > 0 → safe to finalize / mark done.
//   - 'park-needs-review'  : consistent read, blocking > 0 → park at needs-review
//                            (unchanged normal behavior).
//   - 'fault'              : the read is null / under-populated (screens vanished) OR
//                            a zero-built "complete" → a FAULT: never finalize, never
//                            mark done; the caller logs loudly + parks resumable.
// It is total/built/needsReview/failed computed from the RESOLVED run so a fault read
// can never masquerade as a clean 0/0 completion.
export type RollupVerdict = 'finalize' | 'park-needs-review' | 'fault';
export interface RollupRollup {
  verdict: RollupVerdict;
  total: number;
  built: number;
  needsReview: number;
  failed: number;
  blocking: number;
}
export function resolveRollupVerdict(resolved: BuildRun | null | undefined, expectedCount: number): RollupRollup {
  const screens = resolved?.screens;
  // A null / undefined / screens-less / under-populated read is a FAULT — refuse to
  // collapse it to 0/0. Require the resolved read to be non-null AND carry EXACTLY the
  // expected number of screens (no screens vanished mid-read).
  if (!resolved || !Array.isArray(screens) || screens.length !== expectedCount) {
    const total = Array.isArray(screens) ? screens.length : 0;
    const built = Array.isArray(screens) ? screens.filter(s => s.status === 'done').length : 0;
    const needsReview = Array.isArray(screens) ? screens.filter(s => s.status === 'needs-review').length : 0;
    const failed = Array.isArray(screens) ? screens.filter(s => s.status === 'failed').length : 0;
    return { verdict: 'fault', total, built, needsReview, failed, blocking: needsReview + failed };
  }
  const total = screens.length;
  const built = screens.filter(s => s.status === 'done').length;
  const needsReview = screens.filter(s => s.status === 'needs-review').length;
  // Audit A.1: a 'failed' screen ALSO blocks completion (never silently ship a run
  // with an errored screen). Both needs-review and failed hold the run open.
  const failed = screens.filter(s => s.status === 'failed').length;
  const blocking = needsReview + failed;
  if (blocking > 0) return { verdict: 'park-needs-review', total, built, needsReview, failed, blocking };
  // blocking === 0, but a ZERO-built run is never "complete" — that is itself a fault
  // (e.g. every screen was skipped/never ran). Only a positive built count finalizes.
  if (built <= 0) return { verdict: 'fault', total, built, needsReview, failed, blocking };
  return { verdict: 'finalize', total, built, needsReview, failed, blocking };
}

// Re-read the run with a bounded retry until it returns a run whose screens.length
// matches the EXPECTED count (the authoritative in-memory list size). Prefer the
// freshest CONSISTENT read; if all retries fail, fall back to the in-memory run
// (NEVER an empty object) so the guard sees real data, not a collapsed 0/0.
async function readRollupRun(
  projectId: string, runId: string, inMemory: BuildRun, tries = 3, delayMs = 250,
): Promise<BuildRun | null> {
  const expected = inMemory.screens.length;
  let last: BuildRun | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await getRun(projectId, runId);
    if (r) last = r;
    if (r && Array.isArray(r.screens) && r.screens.length === expected) return r;
    if (i < tries - 1) await new Promise<void>((res) => setTimeout(res, delayMs));
  }
  // No consistent read after the retries → fall back to the freshest non-null read,
  // else the authoritative in-memory run (never null/empty).
  return last ?? inMemory;
}

// ── Auto-resume after a rate-limit reset ──────────────────────────────────────
// The claude CLI emits a reset hint in its error text ("You've hit your session
// limit · resets 6pm (UTC)" / "resets at 18:00" / "resets in 2 hours"). We parse it
// to an absolute epoch so a periodic sweep can re-launch the paused run the moment
// the quota window reopens — no human, no long in-process timer (which a redeploy
// would lose). CAP bounds the re-pause loop if the quota is STILL exhausted on
// resume; the sweep runs every SWEEP_INTERVAL_MS.
export const AUTO_RESUME_CAP = 12;
export const AUTO_RESUME_SWEEP_MS = 2 * 60 * 1000;   // 2 min
const DEFAULT_RESUME_DELAY_MS = 60 * 60 * 1000;       // 60 min — used when the hint is unparseable

/**
 * Parse a CLI rate-limit reset hint into an absolute epoch (ms, UTC). Handles:
 *   "resets 6pm (UTC)" / "resets 11 pm" / "resets at 18:00"     → next occurrence of that clock time
 *   "resets in 2 hours" / "resets in 90 minutes"                → now + that duration
 * Anything unrecognised → `now + DEFAULT_RESUME_DELAY_MS` (a safe 60-min retry). All
 * absolute clock times are interpreted in UTC (the CLI quotes UTC); if the parsed
 * time already passed today it rolls to tomorrow. Pure + deterministic given `now`.
 */
export function parseResetHintToEpoch(hint: string | undefined, now: number = Date.now()): number {
  const fallback = now + DEFAULT_RESUME_DELAY_MS;
  if (!hint) return fallback;
  const text = hint.toLowerCase();

  // "resets in N hour(s)/minute(s)" — a relative duration from now.
  const rel = text.match(/resets?\s+in\s+(\d+)\s*(hour|hr|minute|min)/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    if (Number.isFinite(n)) {
      const unitMs = /hour|hr/.test(rel[2]) ? 60 * 60 * 1000 : 60 * 1000;
      return now + n * unitMs;
    }
  }

  // "resets [at] 6pm" / "11 pm" / "18:00" / "6:30pm" — an absolute UTC clock time.
  // Matches an optional "at", then H[:MM] with an optional am/pm suffix.
  const abs = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (abs) {
    let hour = parseInt(abs[1], 10);
    const minute = abs[2] ? parseInt(abs[2], 10) : 0;
    const mer = abs[3];
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
      const d = new Date(now);
      const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
      // If that clock time already passed today, the window reopens tomorrow.
      return target > now ? target : target + 24 * 60 * 60 * 1000;
    }
  }

  return fallback;
}

// T26/T29: pause a run RESUMABLY because a model call hit a persistent rate limit
// (a classifiable quota rejection, or an empty-streak the observed path re-classified
// as a soft rate-limit). The SINGLE pause path: mark this screen pending so it
// rebuilds, flag the run resumable + stopped, and request a graceful orchestrator
// halt — a resume after the quota resets continues from here instead of dumping
// screens to needs-review. Idempotent: a second call (e.g. impl + verify both rate
// limited in the same screen) just re-asserts the same stopped/resumable state.
//
// `resetHint` is the CLI's error text (carries "resets …"); it is parsed to an
// absolute `resumeAt` epoch and stamped on the run (with `rateLimitPaused:true` and
// the bumped `autoResumeCount`) so the auto-resume sweep can relaunch the run once
// the window reopens. A user Stop does NOT go through here, so it never gets the
// rateLimitPaused flag and is never auto-resumed.
async function pauseRunRateLimited(
  projectId: string, runId: string, frameId: string, _session?: string, reason?: string, resetHint?: string,
): Promise<void> {
  const resumeAt = parseResetHintToEpoch(resetHint);
  await appendRunLog(projectId, runId, reason
    ?? `[run] PAUSED — rate limited: API quota exhausted (after backoff+retry). Auto-resume ~${new Date(resumeAt).toISOString().slice(11, 16)} UTC when the window resets — built screens are skipped, this one rebuilds.`);
  try { await updateRunScreen(projectId, runId, frameId, { status: 'pending' }); } catch { /* non-fatal */ }
  // Stamp the rate-limit pause metadata so the sweep can auto-resume. mutateRun
  // serializes this with the status/screen writes (T31). The counter is PRESERVED
  // across re-pauses (a resume that immediately re-limits keeps counting → CAP stops
  // the loop); it is reset to 0 only on a fresh non-rate-limit start (see runAppLoop).
  try {
    await mutateRun(projectId, runId, (run) => {
      run.rateLimitPaused = true;
      run.resumeAt = resumeAt;
      run.autoResumeCount = run.autoResumeCount ?? 0;
    });
  } catch { /* non-fatal */ }
  try { await setRunResumable(projectId, runId, true); } catch { /* non-fatal */ }
  try { await setRunStatus(projectId, runId, 'stopped'); } catch { /* non-fatal */ }
  markRunCancelled(runId);   // orchestrator halts gracefully after this screen
  // Best-effort push notification (inert unless a sink env is set).
  const at = new Date(resumeAt).toISOString().slice(11, 16);
  void notify({
    kind: 'rate-limit-paused', projectId, runId, resumeAt,
    detail: `Build paused — rate limit, auto-resume ~${at} UTC`,
  });
}

// ── the loop ──────────────────────────────────────────────────────────────────
async function runScreenLoop(req: BuildScreenReq, projectRoot: string, jobId: string): Promise<string | undefined> {
  const { model, modelId, framework, frameId, frameName, referenceImagePath, implementPrompt } = req;
  const width = req.width || 393, height = req.height || 852;
  // maxIterations is a SAFETY BACKSTOP, not the policy: the verify agent's
  // recommendation + score-plateau detection decide when to actually stop, so a
  // screen that matches on pass 1 costs 1 pass, not N.
  const maxIterations = Math.min(Math.max(req.maxIterations ?? 4, 1), 6);
  // Build the env from the WORKSPACE root (like /api/ai/generate), NOT the
  // project: createTerminalEnv sets HOME to its arg, and the claude/gemini CLIs
  // read their login from $HOME/.claude (etc.). Rooting it at the project made
  // the spawned agent look for credentials in <project>/.claude → "claude error
  // login", and mis-rooted every tool path (Flutter/npm/mise). The project is
  // the cwd of each runModel/build call, passed separately.
  const env = createTerminalEnv(resolveWorkspace());

  // T13 (RFC v2 §0.1/§0.2/§8.4): the per-screen build/verify/fix model calls are the
  // longest, most AI-heavy phase, yet they bypassed the observed path — so the run's
  // ai{ok,failed} tally and the `[ai:…]` proof lines were FROZEN during the whole
  // build. Route them through `runModelObserved` WITH this run's runId + a `build:` /
  // `verify:` / `fix:` step label so each call bumps the tally and emits a proof line.
  // Behavior is preserved: these are BUILD calls (not requireModel) — a failed turn
  // returns empty text (tallied as `failed`) and the existing build-fail / parseVerdict
  // / retry / needs-review logic handles it, never a fatal abort. When there's no runId
  // (per-frame jobs outside a durable run) it still observes through the job log.
  const stepLabel = (kind: 'build' | 'verify' | 'fix'): string => `${kind}:${frameName}`;
  const observedBuildCall = async (
    kind: 'build' | 'verify' | 'fix',
    prompt: string,
    callOpts: { sessionId?: string } = {},
  ): Promise<{ text: string; sessionId?: string; failed: boolean; rateLimited: boolean; stalled: boolean; resetHint?: string }> => {
    const r = await runModelObserved(model, prompt, env, projectRoot, {
      agent: true, modelId, sessionId: callOpts.sessionId,
      log: { projectId: req.projectId, runId: req.runId, jobId, step: stepLabel(kind) },
    });
    // Tolerant: a failed AI turn becomes empty text (already tallied `failed` by the
    // observed path) so the loop's existing handling (build/verify failure → fix or
    // needs-review) proceeds without a fatal throw. We surface `failed`/`rateLimited`
    // so the caller can retry a transient hang (T25) and never mislabel an UNBUILT
    // screen as an asset defect (T24). runModelObserved already backed off + retried a
    // rate-limit several times before returning reason 'rate-limit'. `resetHint` carries
    // the CLI error text (which holds the "resets …" window) into the pause so it can
    // compute an absolute auto-resume time.
    return r.ok
      ? { text: r.text, sessionId: r.sessionId, failed: false, rateLimited: false, stalled: false }
      // BUG 2: a `rate-limit` reason flagged `softStall` is NOT a real 429 — it's a
      // STREAK of zero-output/timeout agent calls (likely throttle / agent stall). It
      // takes the SAME resumable-pause action as a rate limit but logs a distinct reason.
      : { text: '', sessionId: callOpts.sessionId, failed: true, rateLimited: r.reason === 'rate-limit', stalled: r.reason === 'rate-limit' && r.softStall === true, resetHint: r.error };
  };
  // The pause reason for a soft agent-stall storm (vs a real 429). Mirrors the
  // rate-limit pause action (screen→pending, resumable, stopped) but tells the human
  // the API/agent stalled rather than the quota being exhausted.
  const stallPauseReason = `[run] PAUSED — ${_emptyStreakConfig.EMPTY_STREAK_THRESHOLD}+ consecutive zero-output/timeout agent calls (likely throttle/agent stall); resume after the API recovers — built screens are skipped, this one rebuilds.`;
  const screenDir = path.join(projectRoot, '.uix', 'screens', sanitizeId(frameId));
  await fs.mkdir(screenDir, { recursive: true });
  const relScreenDir = path.join('.uix', 'screens', sanitizeId(frameId));
  // Snapshot the IR tree so a future session has this screen's design context
  // (exact colours/text/layout) without re-fetching from the design source.
  if (req.tree) { try { await fs.writeFile(path.join(screenDir, 'ir.txt'), req.tree); } catch { /* non-fatal */ } }
  if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'building' }); } catch { /* non-fatal */ } }

  // In freshSession mode the implement call starts COLD (no cross-screen resume);
  // the contract injected into the prompt carries coherence. The fix loop below
  // still resumes whatever session THIS implement call returns.
  let session = req.freshSession ? undefined : req.sessionId;
  let finalVerdict: Verdict | null = null;
  let matched = false;
  let accepted = false;
  let stopReason = 'reached iteration cap';
  let iterationsRun = 0;
  let prevScore: number | null = null;
  let lastCandRel: string | null = null;   // newest candidate screenshot (for review)

  // P2/P3 (audit A.2): PER-SCREEN previewEntry isolation. Parallel workers share one
  // .uix/last-gen.json; the build mutex serialized the build+screenshot but a sibling
  // worker could overwrite previewEntry between THIS screen's implement and its verify
  // build → worker A would screenshot worker B's screen. We snapshot THIS screen's
  // previewEntry/framework right after its OWN agent call returns (when last-gen still
  // reflects this screen) and pass that snapshot into the build — never re-reading the
  // shared file inside the lock. So parallel>1 verifies the right screen.
  let screenPreviewEntry: string | undefined;
  let screenFramework = framework;
  const snapshotLastGen = async (): Promise<void> => {
    const lastGen = await readLastGen(projectRoot);
    // Only adopt a previewEntry that exists on disk for THIS screen (a stale/sibling
    // entry is rejected so we don't capture the wrong screen). Falls back to the
    // previous snapshot (or main.dart in renderPreview) when absent.
    if (lastGen.previewEntry && fsSync.existsSync(path.join(projectRoot, lastGen.previewEntry))) {
      screenPreviewEntry = lastGen.previewEntry;
    }
    if (lastGen.framework) screenFramework = lastGen.framework;
  };

  // 1. IMPLEMENT
  appendJobLog(jobId, `[loop] implement: "${frameName}"`);
  let impl = await observedBuildCall('build', implementPrompt);
  // T25: a transient CLI hang (~7% of build calls) returns empty after the timeout —
  // retry ONCE before proceeding; a fresh call usually succeeds. (Rate-limit was already
  // backed-off + retried inside runModelObserved, so don't double-retry that here.)
  if (impl.failed && !impl.rateLimited) {
    appendJobLog(jobId, `[loop] implement returned empty (transient hang) — retrying once`);
    impl = await observedBuildCall('build', implementPrompt);
  }
  const implBuilt = !impl.failed;   // T24: only trust an asset-defect verdict if the screen was actually built
  // T26/T29: PERSISTENT rate limit (a classifiable quota REJECTION, or — T29 — a
  // SILENT empty-streak the observed path re-classified as a soft rate-limit). Do NOT
  // cascade this + every following screen to spurious "broken/not converging"
  // needs-review. PAUSE the run RESUMABLY so a resume after the quota resets continues
  // from here; leave this screen pending so it rebuilds. ONE pause path (used by the
  // implement, verify AND fix calls) so we never double-pause with a conflicting one.
  if (impl.rateLimited && req.runId) {
    await pauseRunRateLimited(req.projectId, req.runId, frameId, session, impl.stalled ? stallPauseReason : undefined, impl.resetHint);
    return session;
  }
  if (impl.sessionId) session = impl.sessionId;
  await snapshotLastGen();   // capture this screen's previewEntry before any sibling can clobber it
  // Deterministic per-screen preview entry: render the screen we JUST built (at the
  // screenshot's device viewport) for verify — NEVER fall back to main.dart, which
  // renders the app entry (a different/stub screen) and produces false "broken"
  // verdicts on good screens. Overrides the agent's last-gen entry (more reliable).
  // P1-core: canonicalId lets the entry resolve SEMANTIC-named screen files (the
  // skeleton stamps `// canonicalId:` headers) — legacy `screen_<frameId>.dart`
  // resolution alone silently missed them.
  try { const pe = await ensureScreenPreviewEntry(projectRoot, screenFramework, frameId, { canonicalId: req.canonicalId }); if (pe) screenPreviewEntry = pe; }
  catch { /* non-fatal — falls back to last-gen/main.dart */ }

  // verify:false (or no reference render to compare against) → implement-only.
  // Write a result and mark the screen done so the run still completes.
  if (req.verify === false || !referenceImagePath) {
    const result = {
      frameId, frameName, framework, matched: false, accepted: true,
      stopReason: 'verify disabled — implemented only', iterations: 1, maxIterations,
      finalVerdict: null, sessionId: session, referenceImage: referenceImagePath,
      ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined, at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
    if (req.runId) {
      try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched: false, sessionId: session }); } catch { /* non-fatal */ }
      // P1-core: verify-off is implement-only for the folded variants too — resolve
      // them so the run can complete (there is no verify pass to gate them on).
      for (const v of req.variants ?? []) {
        try { await updateRunScreen(req.projectId, req.runId, v.frameId, { status: 'done', matched: false, sessionId: session }); } catch { /* non-fatal */ }
      }
      // T9 (RFC v2 §8.2): emit the explicit terminal ACCEPTED line on the verify-off
      // done path too, so the at-a-glance run log is complete (consistent with the
      // verified/matched path). The "(verify off)" tag flags it was implement-only.
      try { await appendRunLog(req.projectId, req.runId, `[screen ${frameName}] ACCEPTED (verify off)`); } catch { /* non-fatal */ }
    }
    finishJobLog(jobId, `[loop] done: "${frameName}" implemented (verify off)`);
    return session;
  }

  // 2/3. VERIFY ↔ FIX — the verify agent's recommendation + score plateau drive
  // when to stop; maxIterations is only a runaway backstop.
  for (let iter = 1; iter <= maxIterations; iter++) {
    iterationsRun = iter;
    appendJobLog(jobId, `[loop] verify ${iter}/${maxIterations}: building & screenshotting`);
    // Build + screenshot under the per-project build lock so a sibling parallel
    // worker can't clobber build/web mid-build. (No-op for serial runs.) Audit A.2:
    // use THIS screen's snapshotted previewEntry/framework (captured right after its
    // own agent call) — NOT a fresh read of the shared last-gen.json, which a sibling
    // worker may have overwritten with a different screen between our agent + build.
    // P1 (RFC §4.6): tall screens are captured as vertical tiles (full-res bands)
    // rather than one downsampled full-page image so the lower portion is judged at
    // the right resolution.
    const tall = height > TALL_FRAME_THRESHOLD;
    const shot = await withBuildLock(projectRoot, () =>
      renderPreview(projectRoot, screenFramework, screenPreviewEntry, width, height, env,
        tall ? { deviceScale: REF_DEVICE_SCALE, tiles: true } : CAPTURE_SHOT_OPTS),
    );

    let verdict: Verdict;
    let candRel: string | null = null;
    const hasShot = !shot.error && (shot.png || (shot.tiles && shot.tiles.length));
    if (!hasShot) {
      // A failed build IS a failure to fix — feed the compiler error back (and
      // keep fixing: a build error is exactly what another pass should repair).
      verdict = { match: false, score: 0, discrepancies: [{ area: 'build', issue: shot.error || 'the screen failed to build/screenshot', severity: 'high' }], recommendation: 'fix' };
      appendJobLog(jobId, `[loop] verify ${iter}: build/screenshot failed`);
    } else if (shot.tiles && shot.tiles.length) {
      // Tiled tall-screen verify: persist every band, compare the stack to the ref.
      const tileRels: string[] = [];
      for (let t = 0; t < shot.tiles.length; t++) {
        const rel = path.join(relScreenDir, `cand-${iter}-tile${t + 1}.png`);
        await fs.writeFile(path.join(projectRoot, rel), shot.tiles[t]);
        tileRels.push(rel);
      }
      candRel = tileRels[0];
      lastCandRel = tileRels[0];   // first band is the representative thumbnail for review
      appendJobLog(jobId, `[loop] verify ${iter}: comparing to reference (${tileRels.length} tiles)`);
      const v = await observedBuildCall('verify', tiledVerifyPrompt(referenceImagePath, tileRels, frameName, prevScore, req.userNotes));
      // T29: a rate-limited (incl. empty-streak soft-limit) verify must PAUSE the run
      // resumably — NOT fall through to parseVerdict('') → needs-review.
      if (v.rateLimited && req.runId) { await pauseRunRateLimited(req.projectId, req.runId, frameId, session, v.stalled ? stallPauseReason : undefined, v.resetHint); return session; }
      verdict = parseVerdict(v.text);
    } else {
      const candAbs = path.join(screenDir, `cand-${iter}.png`);
      await fs.writeFile(candAbs, shot.png!);
      candRel = path.join(relScreenDir, `cand-${iter}.png`);
      lastCandRel = candRel;
      appendJobLog(jobId, `[loop] verify ${iter}: comparing to reference`);
      const v = await observedBuildCall('verify', verifyPrompt(referenceImagePath, candRel, frameName, prevScore, req.userNotes));
      // T29: rate-limited (incl. empty-streak soft-limit) verify → pause resumably.
      if (v.rateLimited && req.runId) { await pauseRunRateLimited(req.projectId, req.runId, frameId, session, v.stalled ? stallPauseReason : undefined, v.resetHint); return session; }
      verdict = parseVerdict(v.text);
    }
    finalVerdict = verdict;
    await fs.writeFile(path.join(screenDir, `iter-${iter}.json`), JSON.stringify({ iter, verdict, candidate: candRel, at: new Date().toISOString() }, null, 2));
    appendJobLog(jobId, `[loop] verify ${iter}: match=${verdict.match} score=${verdict.score ?? '?'} rec=${verdict.recommendation} issues=${verdict.discrepancies.length}`);

    // STOP CONDITIONS (verify-agent driven, not a fixed count):
    if (verdict.match || verdict.recommendation === 'accept') {
      matched = verdict.match; accepted = true; stopReason = verdict.match ? 'matched the reference' : 'verify agent accepted (good enough)';
      break;
    }
    if (verdict.recommendation === 'stop') { stopReason = 'verify agent said stop (broken / not converging)'; break; }
    // ASSET-DEFECT fast-fail: a broken/incomplete/missing illustration or asset is an
    // UPSTREAM extraction defect — the build agent cannot repair it no matter how many
    // passes. Don't burn iterations + the fix timeout (we saw a screen waste ~10 min on
    // exactly this). Detect a HIGH-severity discrepancy about an asset/illustration that
    // is broken/clipped/missing and stop NOW, flagged distinctly so it's queued for an
    // ASSET fix, not a generic non-convergence.
    const assetDefect = verdict.discrepancies.find(d =>
      d.severity === 'high'
      && /illustrat|asset|image|graphic|icon|logo|photo/i.test(`${d.area ?? ''} ${d.issue}`)
      && /broke|corrupt|clip|cut[\s-]?off|missing|absent|incomplete|fragment|spill|overflow|empty (panel|white)/i.test(d.issue));
    // T24: only trust an "asset defect" verdict if the screen actually BUILT this run
    // (implBuilt) AND we screenshotted a real candidate (hasShot). If the implement
    // hung/failed, the screen is UNBUILT — everything looks "missing/broken", which is
    // a build failure to retry, NOT an upstream asset defect. (Screens 61/64 were
    // mislabeled exactly this way.)
    if (assetDefect && implBuilt && hasShot) {
      stopReason = `asset defect — ${assetDefect.area ?? 'illustration'}: broken/incomplete upstream asset; needs an ASSET fix (the build agent cannot repair it)`;
      appendJobLog(jobId, `[loop] asset defect detected — stopping early (no agent fix can repair a broken upstream asset): ${assetDefect.area ?? ''}`);
      break;
    }
    // Plateau guard: after a real attempt, if the score didn't improve, more
    // automated passes are unlikely to help — stop rather than waste calls.
    const score = verdict.score ?? 0;
    if (iter >= 2 && prevScore != null && score <= prevScore) { stopReason = `score plateaued (${prevScore}→${score})`; break; }
    prevScore = score;
    if (iter === maxIterations) break;

    // FIX (resume the implementation session so the agent keeps full context).
    appendJobLog(jobId, `[loop] fix ${iter}: applying ${verdict.discrepancies.length} change(s)`);
    const fix = await observedBuildCall('fix', fixPrompt(frameName, referenceImagePath, candRel ?? '(build failed — no screenshot)', verdict, req.userNotes), { sessionId: session });
    // T29: a rate-limited (incl. empty-streak soft-limit) fix → pause resumably rather
    // than burning the remaining iterations on empty calls + ending in needs-review.
    if (fix.rateLimited && req.runId) { await pauseRunRateLimited(req.projectId, req.runId, frameId, session, fix.stalled ? stallPauseReason : undefined, fix.resetHint); return session; }
    if (fix.sessionId) session = fix.sessionId;
    await snapshotLastGen();   // re-capture in case the fix moved/renamed the previewEntry (audit A.2)
    // Re-assert the deterministic per-screen entry (the screen file the agent just
    // edited still exists; keep verify pointed at THIS screen, not the app entry).
    try { const pe = await ensureScreenPreviewEntry(projectRoot, screenFramework, frameId, { canonicalId: req.canonicalId }); if (pe) screenPreviewEntry = pe; }
    catch { /* non-fatal */ }
  }

  // P3 (RFC §4.5): DETERMINISTIC RECONCILIATION GATE (no LLM). The visual loop only
  // judges appearance — it never catches an invented route, an un-imported theme, or
  // inline colour/text literals. Grep the just-built screen on disk for structural
  // drift; a HIGH-severity flag DEMOTES even a visual match to needs-review (with the
  // recon reason) so it isn't shipped silently. No-op without canonical context, so
  // existing per-frame runs are unaffected.
  let recon: ReconcileResult | null = null;
  try {
    recon = await reconcileScreen({
      projectRoot, framework: screenFramework, canonical: req.canonical, canonicalId: req.canonicalId,
      previewEntry: screenPreviewEntry,
    });
    if (recon.flags.length) appendJobLog(jobId, `[loop] ${reconcileSummary(recon)}`);
  } catch { /* recon is best-effort — never block on a grep error */ }
  const reconBlocked = !!recon && !recon.ok;
  if (reconBlocked && matched) {
    matched = false;
    stopReason = `reconciliation failed (${recon!.flags.filter(f => f.severity === 'high').map(f => f.code).join(', ')})`;
  }

  // ── P1-core: PER-STATE / PER-MODAL visual verification ──────────────────────
  // The prompt's old claim "each state is verified individually" was FALSE: only
  // the lead's default-constructor preview was ever screenshot, and every folded
  // state/modal frame was blanket-marked done up-front (13/13 of Ping's folded
  // modals shipped broken, their prepped references opened ZERO times). Now, after
  // the LEAD passes, each folded variant gets its OWN verify pass: a variant
  // preview entry (`Screen(state:'x')` / auto-presented modal), screenshot vs ITS
  // OWN reference, and the existing fix loop on mismatch (bounded by the same
  // maxIterations). The folded frame is marked done ONLY when its verify passes;
  // cap/stop/plateau → needs-review (same statuses/logging as the lead). Resume:
  // an already-done folded frame skips. A rate-limited call pauses the run against
  // the LEAD frame (consistent with the lead loop: the whole screen rebuilds).
  let variantFixesApplied = 0;
  const verifyVariant = async (v: ScreenVariant): Promise<'done' | 'needs-review' | 'paused'> => {
    const vLabel = `${v.kind} "${v.id}"`;
    const vFrameName = `${frameName} — ${v.kind} ${v.id}`;
    const vDir = path.join(projectRoot, '.uix', 'screens', sanitizeId(v.frameId));
    const vRelDir = path.join('.uix', 'screens', sanitizeId(v.frameId));
    await fs.mkdir(vDir, { recursive: true });
    const vW = v.width || width, vH = v.height || height;
    let vMatched = false;
    let vStop = 'reached iteration cap';
    let vVerdict: Verdict | null = null;
    let vCand: string | null = null;
    let vPrev: number | null = null;
    let vIters = 0;
    for (let iter = 1; iter <= maxIterations; iter++) {
      vIters = iter;
      // (Re)generate the variant preview each pass — a fix may have renamed the
      // screen class / presenter. A missing presenter surfaces as a COMPILE error
      // naming the exact function (precise feedback for the fix pass below).
      let vEntry: string | undefined;
      try {
        vEntry = await ensureScreenPreviewEntry(projectRoot, screenFramework, frameId,
          { canonicalId: req.canonicalId, variant: { kind: v.kind, id: v.id } });
      } catch { /* handled below */ }
      if (!vEntry) { vStop = 'variant preview entry could not be generated (screen file not found)'; break; }
      appendJobLog(jobId, `[loop] variant ${vLabel} verify ${iter}/${maxIterations}: building & screenshotting`);
      const tall = vH > TALL_FRAME_THRESHOLD;
      const shot = await withBuildLock(projectRoot, () =>
        renderPreview(projectRoot, screenFramework, vEntry, vW, vH, env,
          tall ? { deviceScale: REF_DEVICE_SCALE, tiles: true } : CAPTURE_SHOT_OPTS));
      let verdict: Verdict;
      const hasShot = !shot.error && (shot.png || (shot.tiles && shot.tiles.length));
      if (!hasShot) {
        verdict = { match: false, score: 0, discrepancies: [{ area: 'build', issue: shot.error || `the ${v.kind} variant preview failed to build/screenshot`, severity: 'high' }], recommendation: 'fix' };
        appendJobLog(jobId, `[loop] variant ${vLabel} verify ${iter}: build/screenshot failed`);
      } else if (shot.tiles && shot.tiles.length) {
        const tileRels: string[] = [];
        for (let t = 0; t < shot.tiles.length; t++) {
          const rel = path.join(vRelDir, `cand-${iter}-tile${t + 1}.png`);
          await fs.writeFile(path.join(projectRoot, rel), shot.tiles[t]);
          tileRels.push(rel);
        }
        vCand = tileRels[0];
        const r = await observedBuildCall('verify', tiledVerifyPrompt(v.referenceImagePath!, tileRels, vFrameName, vPrev, req.userNotes));
        if (r.rateLimited) { await pauseRunRateLimited(req.projectId, req.runId!, frameId, session, r.stalled ? stallPauseReason : undefined, r.resetHint); return 'paused'; }
        verdict = parseVerdict(r.text);
      } else {
        const rel = path.join(vRelDir, `cand-${iter}.png`);
        await fs.writeFile(path.join(projectRoot, rel), shot.png!);
        vCand = rel;
        const r = await observedBuildCall('verify', verifyPrompt(v.referenceImagePath!, rel, vFrameName, vPrev, req.userNotes));
        if (r.rateLimited) { await pauseRunRateLimited(req.projectId, req.runId!, frameId, session, r.stalled ? stallPauseReason : undefined, r.resetHint); return 'paused'; }
        verdict = parseVerdict(r.text);
      }
      vVerdict = verdict;
      await fs.writeFile(path.join(vDir, `iter-${iter}.json`), JSON.stringify({ iter, verdict, candidate: vCand, at: new Date().toISOString() }, null, 2));
      appendJobLog(jobId, `[loop] variant ${vLabel} verify ${iter}: match=${verdict.match} score=${verdict.score ?? '?'} rec=${verdict.recommendation} issues=${verdict.discrepancies.length}`);
      if (verdict.match || verdict.recommendation === 'accept') {
        vMatched = verdict.match;
        vStop = verdict.match ? 'matched the reference' : 'verify agent accepted (good enough)';
        break;
      }
      if (verdict.recommendation === 'stop') { vStop = 'verify agent said stop (broken / not converging)'; break; }
      const score = verdict.score ?? 0;
      if (iter >= 2 && vPrev != null && score <= vPrev) { vStop = `score plateaued (${vPrev}→${score})`; break; }
      vPrev = score;
      if (iter === maxIterations) break;
      appendJobLog(jobId, `[loop] variant ${vLabel} fix ${iter}: applying ${verdict.discrepancies.length} change(s)`);
      const fix = await observedBuildCall('fix', fixPrompt(vFrameName, v.referenceImagePath!, vCand ?? '(build failed — no screenshot)', verdict, req.userNotes), { sessionId: session });
      if (fix.rateLimited) { await pauseRunRateLimited(req.projectId, req.runId!, frameId, session, fix.stalled ? stallPauseReason : undefined, fix.resetHint); return 'paused'; }
      if (fix.sessionId) session = fix.sessionId;
      variantFixesApplied++;
    }
    // Journal the variant's own result.json (same shape as the lead's).
    try {
      await fs.writeFile(path.join(vDir, 'result.json'), JSON.stringify({
        frameId: v.frameId, frameName: v.frameName, framework, variantOf: frameId,
        variant: { kind: v.kind, id: v.id },
        matched: vMatched, accepted: vMatched, stopReason: vStop,
        iterations: vIters, maxIterations, finalVerdict: vVerdict, sessionId: session,
        referenceImage: v.referenceImagePath, candidateImage: vCand ?? undefined,
        at: new Date().toISOString(),
      }, null, 2));
    } catch { /* journaling is best-effort */ }
    if (vMatched) {
      await updateRunScreen(req.projectId, req.runId!, v.frameId, { status: 'done', matched: true, sessionId: session, review: undefined });
      await appendRunLog(req.projectId, req.runId!, `[screen ${frameName}] ${vLabel} ACCEPTED${typeof vVerdict?.score === 'number' ? ` (score ${vVerdict.score})` : ''}`);
      return 'done';
    }
    await updateRunScreen(req.projectId, req.runId!, v.frameId, {
      status: 'needs-review', matched: false, sessionId: session,
      review: {
        candidateImagePath: vCand ?? undefined,
        referenceImagePath: v.referenceImagePath,
        score: vVerdict?.score,
        reason: `${v.kind} "${v.id}": ${vStop}`,
        discrepancies: vVerdict?.discrepancies ?? [],
      },
    });
    await appendRunLog(req.projectId, req.runId!, `[screen ${frameName}] ${vLabel} NEEDS REVIEW (${vStop})`);
    return 'needs-review';
  };

  if (req.runId && req.variants?.length) {
    if (matched) {
      for (const v of req.variants) {
        // Resume semantics: an already-verified folded frame skips.
        const live = await getRun(req.projectId, req.runId);
        const cur = live?.screens.find(s => s.frameId === v.frameId);
        if (cur?.status === 'done') continue;
        if (!v.referenceImagePath) {
          // No reference render exists for this folded frame — nothing to verify
          // against; resolve it (implement-only, like verify-off) but say so.
          try { await updateRunScreen(req.projectId, req.runId, v.frameId, { status: 'done', matched: false, sessionId: session }); } catch { /* non-fatal */ }
          await appendRunLog(req.projectId, req.runId, `[screen ${frameName}] ${v.kind} "${v.id}" ACCEPTED (no reference render — variant verify skipped)`);
          continue;
        }
        try { await updateRunScreen(req.projectId, req.runId, v.frameId, { status: 'building' }); } catch { /* non-fatal */ }
        const outcome = await verifyVariant(v);
        if (outcome === 'paused') return session;   // run parked resumably (lead rebuilds)
      }
      // A variant FIX pass edits the shared screen file — re-run the deterministic
      // reconciliation gate so drift introduced by those fixes (placeholders, dead
      // handlers, invented routes) still demotes the lead, exactly like the lead's
      // own gate above.
      if (variantFixesApplied > 0) {
        try {
          const recon2 = await reconcileScreen({
            projectRoot, framework: screenFramework, canonical: req.canonical, canonicalId: req.canonicalId,
            previewEntry: screenPreviewEntry,
          });
          if (recon2.flags.length) appendJobLog(jobId, `[loop] post-variant ${reconcileSummary(recon2)}`);
          recon = recon2;
          if (!recon2.ok && matched) {
            matched = false;
            stopReason = `reconciliation failed after variant fixes (${recon2.flags.filter(f => f.severity === 'high').map(f => f.code).join(', ')})`;
          }
        } catch { /* best-effort */ }
      }
    } else {
      // The LEAD did not pass — its folded variants were never verified. Queue them
      // for review (NOT done) so the run's rollup blocks honestly on them too.
      for (const v of req.variants) {
        const live = await getRun(req.projectId, req.runId);
        const cur = live?.screens.find(s => s.frameId === v.frameId);
        if (cur?.status === 'done') continue;
        try {
          await updateRunScreen(req.projectId, req.runId, v.frameId, {
            status: 'needs-review', matched: false,
            review: { referenceImagePath: v.referenceImagePath, reason: `lead screen "${frameName}" did not pass verification — folded ${v.kind} "${v.id}" was not verified` },
          });
          await appendRunLog(req.projectId, req.runId, `[screen ${frameName}] ${v.kind} "${v.id}" NEEDS REVIEW (lead did not pass — variant unverified)`);
        } catch { /* non-fatal */ }
      }
    }
  }

  // P5 (RFC §4.8): AMENDMENT EMITTER. The packet instructs the agent to write
  // .uix/amendment-request.json when it legitimately needs a route/component not in
  // the plan. Read it here and store the amendment(s) (whitelisted → auto-approved +
  // skeleton regen; else pending for the rolling gate). Consume the file so it isn't
  // re-read for the next screen. No-op (no file) for the common case.
  if (req.runId) { try { await consumeAmendmentRequests(req.projectId, req.runId, projectRoot, frameId, jobId); } catch { /* non-fatal */ } }

  const result = {
    frameId, frameName, framework, matched, accepted, stopReason,
    iterations: iterationsRun, maxIterations,
    finalVerdict, sessionId: session,
    reconciliation: recon ? { ok: recon.ok, flags: recon.flags } : undefined,
    referenceImage: referenceImagePath,
    candidateImage: lastCandRel ?? undefined,
    ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined,
    at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
  // RFC §4.7: `done` requires a TRUSTWORTHY visual match AND a clean reconciliation.
  // A screen that only the automated verify "accepted" (not matched), plateaued, was
  // stopped, hit the cap, OR failed reconciliation is NOT shipped silently — it goes
  // to the needs-review queue. Only matched:true (recon-clean) is marked 'done'.
  if (req.runId) {
    try {
      if (matched) {
        await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched: true, sessionId: session, review: undefined });
        // T9 (RFC v2 §8.2): explicit terminal outcome line — at a glance "ACCEPTED",
        // not just "loop done", so the human doesn't have to parse the log to know it
        // passed. Score (when the verify agent gave one) rides along.
        await appendRunLog(req.projectId, req.runId,
          `[screen ${frameName}] ACCEPTED${typeof finalVerdict?.score === 'number' ? ` (score ${finalVerdict.score})` : ''}`);
      } else {
        // Surface recon flags alongside the visual discrepancies in the review queue.
        const reconDiscs = (recon?.flags ?? []).map(f => ({ area: `recon:${f.code}`, issue: f.message, severity: f.severity }));
        await updateRunScreen(req.projectId, req.runId, frameId, {
          status: 'needs-review', matched: false, sessionId: session,
          review: {
            candidateImagePath: lastCandRel ?? undefined,
            referenceImagePath,
            score: finalVerdict?.score,
            reason: stopReason,
            discrepancies: [...(finalVerdict?.discrepancies ?? []), ...reconDiscs],
          },
        });
        // T9 (RFC v2 §8.2): explicit needs-review terminal line with the reason.
        await appendRunLog(req.projectId, req.runId, `[screen ${frameName}] NEEDS REVIEW (${stopReason})`);
      }
    } catch { /* non-fatal */ }
  }
  finishJobLog(jobId, `[loop] done: "${frameName}" ${matched ? 'MATCHED' : 'needs review'} after ${iterationsRun} iteration(s) — ${stopReason}`);
  return session;
}

// ── server-orchestrated full-app build ─────────────────────────────────────────
// Builds every screen in a durable run SERVER-SIDE. Survives the browser tab
// closing; resumable after Stop / rate-limit / redeploy (already-done screens are
// skipped). Every job-log line for the run's screens is teed to the durable run
// log so the client can replay the full history on reconnect.
//
// Two coherence vehicles (RFC §4.5):
//   • DEFAULT — one shared CLI --resume session threaded screen→screen (serial).
//   • freshSessions — each screen builds COLD against the server-injected WRITTEN
//     CONTRACT (app plan + canonical API surface + .uix/context.md slice). No
//     shared session → identical on claude/codex/gemini, bounded context, and
//     parallelizable: with `parallel>1` a bounded worker pool builds N screens at
//     once. (A shared --resume session can't be parallelized, so parallel implies
//     fresh sessions.)

/** Build ONE screen of a run server-side, injecting the written contract. Shared
 *  by the serial and parallel paths. `sharedSession` is the threaded session for
 *  serial/non-fresh runs (undefined in fresh-session mode). Returns the session
 *  the screen ended on (so serial mode can thread it forward). */
async function buildRunScreen(
  run: import('./build-run-store').BuildRun, screen: import('./build-run-store').RunScreen,
  projectRoot: string, appPlan: string, sharedSession: string | undefined,
  canonicalCtx?: { canonical: Canonical; screen: CanonicalScreen },
): Promise<string | undefined> {
  // ONE route scheme: when canonicalized, the API surface in the written contract
  // derives from canonical.screens (audit A.3) — same as the appPlan caller built.
  const canonical = canonicalCtx?.canonical;
  const { projectId, id: runId } = run;
  const fresh = run.freshSessions === true;
  if (!screen.spec) {
    await appendRunLog(projectId, runId, `[run] skip "${screen.frameName}" — no build spec`);
    // A failed screen must NOT let the run report 'done' (audit A.1). Attach a
    // review payload so it surfaces in the needs-review queue (Accept / restart).
    await updateRunScreen(projectId, runId, screen.frameId, {
      status: 'failed', review: { reason: 'no build spec — screen was not built' },
    });
    await appendRunLog(projectId, runId, `[screen ${screen.frameName}] FAILED (no build spec)`);
    return sharedSession;
  }
  const jobId = `${runId}:${screen.frameId}`;
  startJobLog(jobId, { projectId, firstLine: `[loop] queued "${screen.frameName}"` });
  // Read the written contract FRESH per screen — earlier screens append to
  // .uix/context.md, so each screen sees the latest established tokens/components.
  const contextSlice = await readContextSlice(projectRoot);
  let contract = buildWrittenContract(run, appPlan, contextSlice, fresh, canonical);
  // T12 (RFC v2 §3 Phase 5/6): inject the AppAssets symbol inventory so the agent
  // references real exported assets via `AppAssets.<x>` from the START — never the
  // raw 'assets/...' literals in the IR (those point at pre-rename/deduped files
  // that the asset pass renamed or deleted, so they FAIL at runtime). Guarded: only
  // injected when the asset pass actually produced a resources file + map.
  contract = `${await assetInventoryBlock(projectRoot)}${contract}`;
  // P3: when this is a canonical lead frame, prepend its states/modals/template +
  // route-slot context so the agent builds ONE widget instead of per-variant pages.
  // P1-core: run.screens rides along so each folded state/modal block carries its
  // OWN reference image path + bounded IR + presentation hint (not just a name).
  if (canonicalCtx) contract = `${buildCanonicalContext(canonicalCtx.canonical, canonicalCtx.screen, run.screens)}\n\n— — —\n${contract}`;
  // P4: strip [preview:…] + RLE repeated siblings from the agent-facing IR.
  const cleanPacket = hygieneIR(screen.spec.packet) ?? screen.spec.packet;
  const sreq: BuildScreenReq = {
    projectId, model: run.model as AIModel, modelId: run.modelId, sessionId: sharedSession,
    framework: run.framework || 'flutter', frameId: screen.frameId, frameName: screen.frameName,
    width: screen.spec.width, height: screen.spec.height,
    referenceImagePath: screen.spec.referenceImagePath,
    implementPrompt: `${contract}\n\n— — —\nNOW BUILD THIS SCREEN:\n${cleanPacket}`,
    tree: hygieneIR(screen.spec.tree), maxIterations: run.maxIterations, jobId, runId,
    userNotes: run.userNotes, verify: run.verify, freshSession: fresh,
    // P3 (RFC §4.5): canonical context for the reconciliation gate (no-op without it).
    canonical, canonicalId: canonicalCtx?.screen.canonicalId,
    // P1-core: the folded states/modals this lead must realize — each is verified
    // individually against its own reference after the lead passes.
    variants: canonicalCtx ? variantsForCanonicalScreen(canonicalCtx.screen, run.screens) : undefined,
  };
  try {
    return await runScreenLoop(sreq, projectRoot, jobId);
  } catch (e: any) {
    appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
    finishJobLog(jobId, '[loop] failed');
    // Surface the failure in the needs-review queue so the run can't report 'done'
    // around an errored screen (audit A.1) and a human can Corrected-retry / restart.
    await updateRunScreen(projectId, runId, screen.frameId, {
      status: 'failed', review: { reason: `build error: ${e?.message || 'unknown'}` },
    });
    await appendRunLog(projectId, runId, `[screen ${screen.frameName}] FAILED (${e?.message || 'unknown'})`);
    return sharedSession;
  }
}

// P5 (RFC §5): pause the run at a HITL gate if it's enabled + not yet cleared.
// Returns true when the orchestrator should STOP (the run is now parked awaiting a
// human approval); false to proceed. No-op (returns false) when the gate is off.
async function gate(run: BuildRun, gateName: CheckpointGate, message: string): Promise<boolean> {
  if (!gateIsActive(run, gateName)) return false;
  await appendRunLog(run.projectId, run.id, `[hitl] checkpoint "${gateName}" — paused for approval: ${message}`);
  await pauseAtCheckpoint(run.projectId, run.id, gateName, message);
  return true;
}

async function runAppLoop(projectId: string, runId: string): Promise<void> {
  if (isRunActive(runId)) return;          // already orchestrating in this process
  markRunActive(runId);
  clearRunCancelled(runId);
  // Audit A.4 (RFC §4.9): an ACTIVELY-orchestrating run must survive a redeploy —
  // a container restart mid-build (the common interruption) leaves the run 'running',
  // and resumeInterruptedRuns picks it back up at boot. So mark it resumable WHILE it
  // orchestrates (a live build is, by definition, resumable). It is flipped back to
  // NOT-resumable only on terminal completion, and a user Stop moves it to 'stopped'
  // (which the boot scan excludes), so the only thing auto-resumed is a build that was
  // genuinely interrupted while running — never a user-stopped or completed run.
  void setRunResumable(projectId, runId, true);
  // The run is actively orchestrating again → it is no longer rate-limit-paused. Clear
  // the flag (so the sweep won't double-fire) + the scheduled resumeAt; the
  // autoResumeCount counter is PRESERVED so a resume that immediately re-limits keeps
  // counting toward AUTO_RESUME_CAP (only a fresh /start or restart resets it).
  void mutateRun(projectId, runId, (run) => { run.rateLimitPaused = false; run.resumeAt = undefined; });
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { clearRunActive(runId); return; }

  // RFC §9 — version-control harness. Ensure the managed project is a git repo
  // (auto-init + .gitignore) and checkpoint at run start, so no run ever mutates an
  // untracked project and every phase below has a baseline to roll back to. All git
  // ops are best-effort + non-fatal (a git hiccup never breaks a build).
  try {
    await ensureProjectGit(projectRoot, { log: (msg) => { void appendRunLog(projectId, runId, msg); } });
    await runCheckpoint(projectId, runId, projectRoot, 'run start', `run ${runId}`);
  } catch { /* non-fatal */ }

  // Tee every screen job's log line to the run's durable, replayable log.
  const unsub = subscribeJobLog((e) => {
    if (e.kind !== 'line' || !e.line || !e.jobKey.startsWith(`${runId}:`)) return;
    void appendRunLog(projectId, runId, e.line);
  });

  try {
    const run = await getRun(projectId, runId);
    if (!run) return;
    // The global app plan (screen inventory + routes + nav graph + "never invent
    // screens" rule) — prepended to every screen's prompt so the flow shapes the
    // whole build, not just per-screen nav lines. In canonical mode the route scheme
    // derives from canonical.screens (audit A.3), so the plan is rebuilt below once
    // the pre-pass has produced `canonical` — one route scheme, never two.
    let appPlan = buildAppPlan(run);

    // ── P3: canonicalization pre-pass (RFC §4.1/§4.2) ────────────────────────
    // Cluster frames → canonical screens, rewrite the flow, write canonical.json,
    // and generate the write-locked skeleton. The build then iterates ONLY the
    // canonical LEAD frames (states/modals fold into their lead screen); the
    // non-lead frames are marked done so the run can complete. Behind run.canonical
    // → existing one-frame-per-screen behavior is untouched when the flag is off.
    let canonical: Canonical | undefined;
    const canonByLeadFrame = new Map<string, CanonicalScreen>();   // leadFrameId → canonical screen
    const leadFrameIds = new Set<string>();
    if (run.canonical) {
      setGenPhase(projectId, runId, 'Canonicalize',
        run.canonMode === 'deterministic' ? 'degraded (deterministic)' : 'heavy-AI (1a→1d)');
      // Resume-cheap: the canonicalization pre-pass is deterministic from the run's
      // frames+flow and is persisted to canonical.json on the FIRST start. On every
      // later (re)start — resume after redeploy, a restart, a checkpoint approve —
      // REUSE the persisted result instead of re-clustering, re-writing the
      // skeleton, and re-folding from scratch. This is the "why does the preparing
      // phase always repeat" fix: prep runs ONCE, then we pick up where we left off.
      const persisted = await readCanonical(projectRoot, runId);
      if (persisted) {
        canonical = persisted;
        // T35: re-assert OWNERSHIP of the live `.uix/canonical.json` on resume — a
        // DIFFERENT run may have written it since. Keyed to THIS run so the finalize
        // passes (which read the live file) always reconcile against the built app.
        await syncLiveCanonical(projectRoot, runId, canonical);
        await appendRunLog(projectId, runId, `[canon] reusing persisted canonicalization (${canonical.screens.length} screen(s), ${canonical.components.length} component(s)) — prep already done, skipping re-canonicalize + skeleton + fold; re-synced live canonical.json to this run`);
      } else {
        // RFC v2 §4.2: the HEAVY-AI chain is THE canonicalization. The deterministic
        // clusterer is ONLY reachable as an EXPLICIT, logged `degraded` mode
        // (run.canonMode === 'deterministic'); default is AI. An AI no-fire FAILS LOUD
        // — it parks at HITL Checkpoint 0, never silently falls back (RFC §0.1/§0.4).
        const degraded = run.canonMode === 'deterministic';
        let canonFailed = false;
        try {
          if (degraded) {
            await appendRunLog(projectId, runId, `[canon] DEGRADED: deterministic mode (AI canonicalization skipped by request)`);
            canonical = canonicalizeRun(run.screens, run.flow);
          } else {
            // Heavy-AI chain (1a describe → 1b reconcile → 1c reduce → 1d adjudicate).
            // describeFrame renders references + reads the IR tree itself off the
            // figStorageKey, so we pass only frames (id/name/dims) + the flow + ids.
            const figKey = run.figStorageKey;
            if (!figKey) throw new Error('AI canonicalization requires run.figStorageKey (ingest must run first)');
            const aiFrames: DescribeFrameInput[] = run.screens.map(s => ({
              frameId: s.frameId,
              frameName: s.frameName,
              width: s.spec?.width,
              height: s.spec?.height,
            }));
            const aiFlow: ReduceFlow | undefined = run.flow
              ? { entryFrameId: run.flow.entryFrameId ?? null, connections: run.flow.connections ?? [] }
              : undefined;
            // Thread the run's selected provider (claude/codex/gemini) into the heavy-AI
            // canon chain so a codex/gemini run doesn't silently hard-depend on claude
            // (RFC §0.1 / T14.10). Guard with isAIModel; default 'claude' otherwise.
            const aiOpts: CanonicalizeOptions = {
              runId,
              ...(isAIModel(run.model) ? { provider: run.model } : {}),
              ...(run.modelId ? { modelId: run.modelId } : {}),
              // T28: GRANULAR PROGRESS — surface `describing N/total` (and the later
              // 1b/1c/1d sub-stage) as the heavy-AI chain runs, so the Runs UI shows
              // real progress instead of a static "Canonicalize" that looks stuck.
              onDescribeProgress: (p) => {
                const detail = p.stage === 'describe'
                  ? `describing ${p.done}/${p.total}${p.cached ? ` (${p.cached} cached)` : ''}`
                  : p.stage === 'reconcile' ? 'reconciling lexicon'
                  : p.stage === 'reduce' ? 'reducing to canonical'
                  : 'adjudicating (vision)';
                setGenPhase(projectId, runId, 'Canonicalize', detail);
              },
            };
            await appendRunLog(projectId, runId, `[canon] heavy-AI canonicalization — 1a describe → 1b reconcile → 1c reduce → 1d adjudicate over ${aiFrames.length} frame(s)`);
            const result = await aiCanonicalize(projectId, figKey, aiFrames, aiFlow, aiOpts);
            await appendRunLog(projectId, runId, `[canon] AI chain done — described ${result.stages.describedFrames} frame(s), lexicon-AI-merged=${result.stages.lexiconAiMerged}, reduce-AI-refined=${result.stages.reduceAiRefined}, adjudicate-vision=${result.stages.adjudicateVisionRan}, ${result.drilled.length} drilled, ${result.changes.length} correction(s)`);
            // Adapter: CanonicalModel → the build flow's Canonical (folds top-level
            // modals into base screens, rebuilds frameMap, maps states/templates/flow).
            canonical = aiModelToCanonical(result.canonical);
          }
          // Generate the deterministic skeleton (Flutter only for now; other
          // frameworks still get canonical.json + the manifest, no router file).
          // (Skeleton writes are additive — a built screen file is never clobbered.)
          // generateFlutterSkeleton derives SEMANTIC file/class/route-const/route-PATH
          // names and REWRITES canonical.screens[].route to the semantic path, so the
          // canonical must be PERSISTED AFTER the skeleton runs (below) — otherwise the
          // sidecar carries machine routes the router no longer uses.
          if ((run.framework || 'flutter').toLowerCase() === 'flutter') {
            try {
              setGenPhase(projectId, runId, 'Skeleton');
              // T35: reap stale screen files from a prior (different/smaller) build so
              // lib/screens/ holds ONLY the current canonical's screens before we add stubs.
              const orphans = await cleanOrphanScreens(projectRoot, canonical);
              if (orphans.removed.length) await appendRunLog(projectId, runId, `[canon] orphan cleanup — removed ${orphans.removed.length} stale screen file(s) not in the current canonical`);
              const sk = await generateFlutterSkeleton(projectRoot, canonical);
              await appendRunLog(projectId, runId, `[canon] skeleton: ${sk.files.length} file(s), ${sk.routes.length} route(s)`);
            } catch (e: any) {
              await appendRunLog(projectId, runId, `[canon] skeleton generation failed (continuing): ${e?.message || 'unknown'}`);
            }
          } else {
            // T15 (RFC §0.1 — no silent degrade): the write-locked router/theme/component
            // skeleton is flutter-only. A react/web run gets NO skeleton — say so LOUDLY
            // (canonical.json + the manifest are still written above) instead of a silent no-op.
            await appendRunLog(projectId, runId, `[canon] skeleton SKIPPED — ${(run.framework || 'flutter')} not yet supported by this phase; flutter-only (no router/theme/component stubs were generated)`);
          }
          // Persist AFTER the skeleton has rewritten canonical.screens[].route to the
          // SEMANTIC path — so the per-run sidecar + the live `.uix/canonical.json`
          // (which the finalize passes read) both match the built router. T35: stamp
          // the live file with this run's id so a stale file from another run is detectable.
          await writeCanonical(projectRoot, runId, canonical);
          await syncLiveCanonical(projectRoot, runId, canonical);
          // P5 (RFC §4.2/§4.9): persist frame-map.json — the SINGLE identity axis
          // (frameId → canonicalId). All durability + route derivation key on this.
          await writeFrameMap(projectId, runId, canonical.frameMap);
          // P1-core: folded STATE/MODAL frames are NO LONGER blanket-marked done
          // up-front — that shipped 13/13 unbuilt modals as "done" on Ping. Each is
          // now verified INDIVIDUALLY inside its lead screen's loop (variant verify)
          // and only reaches 'done' when ITS OWN verify passes. Frames folded as
          // pure duplicates/components (members that are neither the lead, a
          // non-default state, nor a modal) still auto-resolve here — they have no
          // variant of their own to verify. Only on the FIRST canonicalization; on
          // resume every frame keeps its persisted status.
          const memberToLead = new Map<string, string>();   // any member frameId → lead frameId
          const variantFrames = new Set<string>();          // frames verified via the lead's variant pass
          for (const cs of canonical.screens) {
            const lead = cs.states[0]?.frameId ?? cs.frameIds[0];
            if (!lead) continue;
            for (const fid of cs.frameIds) memberToLead.set(fid, lead);
            for (const st of cs.states) if (st.frameId !== lead) variantFrames.add(st.frameId);
            for (const m of cs.modals) { memberToLead.set(m.frameId, lead); variantFrames.add(m.frameId); }
          }
          const leadSet = new Set([...canonical.screens].map(cs => cs.states[0]?.frameId ?? cs.frameIds[0]).filter(Boolean) as string[]);
          let folded = 0;
          for (const s of run.screens) {
            if (memberToLead.has(s.frameId) && !leadSet.has(s.frameId) && !variantFrames.has(s.frameId) && s.status !== 'done') {
              await updateRunScreen(projectId, runId, s.frameId, { status: 'done', matched: true });
              folded++;
            }
          }
          const deferredVariants = [...variantFrames].filter(fid => !leadSet.has(fid)).length;
          await appendRunLog(projectId, runId, `[canon] ${run.screens.length} frame(s) → ${canonical.screens.length} canonical screen(s), ${canonical.components.length} component(s)${folded ? `, ${folded} folded duplicate/component frame(s)` : ''}${deferredVariants ? `, ${deferredVariants} state/modal frame(s) deferred to per-variant verify` : ''}${canonical.warnings.length ? ` — ${canonical.warnings.length} warning(s)` : ''}`);
          for (const w of canonical.warnings) await appendRunLog(projectId, runId, `[canon] WARNING: ${w}`);
          // RFC §9.2 — checkpoint after canonicalization (canonical.json + skeleton).
          await runCheckpoint(projectId, runId, projectRoot, 'phase canonicalize', `${canonical.screens.length} screen(s), ${canonical.components.length} component(s)`);
        } catch (e: any) {
          // RFC §0.1/§0.4 — NO SILENT FALLBACK. The heavy-AI canon is THE
          // canonicalization; if the AI did not fire (AiStepError) or the pass
          // otherwise failed, we must NOT quietly drop to a deterministic guess or to
          // per-frame builds. Park the run at HITL Checkpoint 0 (flow gate) so a human
          // sees the failure + can fix the flow / re-run / opt into degraded mode.
          canonical = undefined;
          canonFailed = true;
          const aiNoFire = e instanceof AiStepError;
          const reason = aiNoFire
            ? `AI canonicalization did not fire (${e.message})`
            : `canonicalization failed: ${e?.message || 'unknown'}`;
          await appendRunLog(projectId, runId, `[canon] ERROR — ${reason}`);
          await appendRunLog(projectId, runId, `[canon] no silent fallback (RFC §0.1) — parking at HITL Checkpoint 0 (flow). ${degraded ? 'Deterministic (degraded) mode failed — fix the run inputs.' : 'Re-run, fix the flow, or set canonMode=\'deterministic\' to opt into the explicit degraded clusterer.'}`);
          await pauseAtCheckpoint(projectId, runId, 'flow', `canonicalization failed — ${reason}`);
        }
        if (canonFailed) return;          // STOP — the run is parked, awaiting a human.
      }
      // Build the lead maps from the canonical (fresh OR reused) — these drive which
      // frames are buildable targets and carry each screen's canonical context.
      if (canonical) {
        for (const cs of canonical.screens) {
          const lead = cs.states[0]?.frameId ?? cs.frameIds[0];
          if (!lead) continue;
          leadFrameIds.add(lead);
          canonByLeadFrame.set(lead, cs);
        }
      }
    }
    // Audit A.3: once canonicalized, rebuild the app plan so its route scheme derives
    // from canonical.screens / canonicalId — matching the generated skeleton + the
    // injected API surface. Without this the agent sees frameName routes in the plan
    // but canonical routes in the skeleton (two divergent schemes).
    if (canonical) appPlan = buildAppPlan(run, canonical);

    // ── EXTRACT-FIRST design system + app wiring (RFC §4.4) ──────────────────────
    // BEFORE any screen builds: (1) turn the deterministic digest (dominant colors +
    // fonts) into a REAL importable theme file (lib/theme/app_theme.dart → AppTheme)
    // and seed .uix/context.md with the importable symbol list — fixes the root cause
    // of per-screen hardcoding (there was no named token to import). (2) WIRE main.dart
    // to the generated router — the canonical skeleton built AppRouter but never made
    // the app run it, so the whole app was dead code behind a counter-demo main.dart.
    // Both are idempotent (skip when already done / never clobber a real main.dart).
    let themeTokens: ThemeTokens | undefined;
    // T15 (RFC §0.1 — no silent degrade): the EXTRACT-FIRST theme file + main.dart
    // router wiring + AppAssets repoint below are flutter-only. A react/web run gets
    // a degraded design-system (description only, no importable token file) and NO
    // main wiring — make that gap LOUD up-front so the user knows, rather than the
    // theme/app-wiring phases quietly no-op'ing on a non-flutter build.
    const isFlutterRun = (run.framework || 'flutter').toLowerCase() === 'flutter';
    if (!isFlutterRun) {
      await appendRunLog(projectId, runId, `[design-system] DEGRADED — ${(run.framework || 'flutter')} not yet supported by this phase; flutter-only. No importable AppTheme token file is generated (the agent gets a theme DESCRIPTION only).`);
      await appendRunLog(projectId, runId, `[app-wiring] SKIPPED — ${(run.framework || 'flutter')} not yet supported by this phase; flutter-only. main.dart router wiring is a no-op (the entrypoint is NOT auto-wired).`);
    }
    setGenPhase(projectId, runId, 'Pre-flight', 'design system + token extract');
    try {
      const digest = buildDesignDigest(run);
      const ds = await generateDesignSystem(projectRoot, run.framework || 'flutter', { colors: digest.colors, fonts: digest.fonts });
      themeTokens = ds.tokens;
      if (ds.wrote) await seedContextWithThemeApi(projectRoot, ds.api);
      await appendRunLog(projectId, runId, `[design-system] ${ds.wrote ? 'generated' : 'reused'} ${ds.themeFile} with ${ds.tokenCount} color token(s)${digest.fonts[0] ? ` + ${digest.fonts[0]}` : ''} — screens import AppTheme.* (no per-screen hardcoding)`);
    } catch (e: any) {
      await appendRunLog(projectId, runId, `[design-system] generation skipped (non-fatal): ${e?.message || 'unknown'}`);
    }
    try {
      const wired = await ensureMainWired(projectRoot, run.framework || 'flutter');
      if (wired.wrote) await appendRunLog(projectId, runId, `[app-wiring] main.dart → runApp(AppRouter) (${wired.reason}) — the app now actually runs the generated router + screens`);
    } catch (e: any) {
      await appendRunLog(projectId, runId, `[app-wiring] main.dart wiring skipped (non-fatal): ${e?.message || 'unknown'}`);
    }

    // When canonicalized, only the lead frames are buildable targets.
    const isBuildTarget = (frameId: string): boolean => !canonical || leadFrameIds.has(frameId);
    const canonCtxFor = (frameId: string) => {
      const cs = canonByLeadFrame.get(frameId);
      return canonical && cs ? { canonical, screen: cs } : undefined;
    };

    // ── HITL Checkpoint 0 (RFC §5): after canonicalization/flow ──────────────────
    // Re-read the run so the gate sees the latest approvedGates (set by an approve
    // that resumed this loop). If a gate fires the loop returns; approve resumes it.
    {
      const live = await getRun(projectId, runId) ?? run;
      const flowMsg = `${canonical ? `${canonical.screens.length} canonical screen(s)` : `${run.screens.length} frame(s)`}, ${run.flow?.connections?.length ?? 0} nav link(s)${run.flow?.connections?.length ? '' : ' — NO navigation graph; set entry + nav'}`;
      if (await gate(live, 'flow', flowMsg)) return;
    }
    // ── HITL Checkpoint 1 (RFC §5): after plan + pre-flight ──────────────────────
    {
      const live = await getRun(projectId, runId) ?? run;
      if (await gate(live, 'plan', `approve ${run.screens.length} route(s)/screen(s) + token/cost pre-flight`)) return;
    }

    // P2: a parallel pool only makes sense with fresh sessions (a shared --resume
    // session can't be used by two workers at once), so it forces freshSessions.
    const workers = run.freshSessions ? clampParallel(run.parallel ?? 1) : 1;
    await appendRunLog(projectId, runId, `[run] start — ${run.screens.length} screen(s)${canonical ? ` (${leadFrameIds.size} canonical)` : ''}, model=${run.model}, verify=${run.verify !== false}, flow=${run.flow?.connections?.length ?? 0} link(s), sessions=${run.freshSessions ? 'fresh-per-screen' : 'shared'}, workers=${workers}`);

    // T9: enter the per-screen BUILD phase. The detail tracks "screen done/total"
    // (built-or-resolved-so-far over the buildable target count), updated as each
    // screen reaches a terminal state — so the UI shows "Building screen 7/24".
    const buildTargets = run.screens.filter(s => isBuildTarget(s.frameId)).length;
    const countBuilt = async (): Promise<number> => {
      const live = await getRun(projectId, runId);
      return live?.screens.filter(s => isBuildTarget(s.frameId) && (s.status === 'done' || s.status === 'needs-review' || s.status === 'failed')).length ?? 0;
    };
    const emitBuildProgress = async (): Promise<void> => {
      setGenPhase(projectId, runId, 'Build screens', `${await countBuilt()}/${buildTargets} built`);
    };
    // Show the screen CURRENTLY building (not just the completed count) so the phase
    // visibly advances the moment a screen starts — otherwise the detail sits on the
    // completed count for the whole multi-minute implement→verify→fix loop and reads
    // as "stuck". `n` is the 1-based position of the screen about to build.
    const emitBuilding = async (frameName: string): Promise<void> => {
      const n = Math.min((await countBuilt()) + 1, buildTargets);
      setGenPhase(projectId, runId, 'Build screens', `building ${n}/${buildTargets}: ${frameName}`);
    };
    await emitBuildProgress();

    const stillNeeded = async (frameId: string): Promise<boolean> => {
      const live = await getRun(projectId, runId);
      const cur = live?.screens.find(s => s.frameId === frameId);
      return cur?.status !== 'done';   // skip already-built (resume)
    };

    // ── T31: all-done fast-path — skip the WHOLE build loop on resume/finalize ────
    // When every buildable target is already 'done' (the run reached terminal
    // success, e.g. resuming a done-but-unfinalized run, or after the last
    // needs-review screen was Accepted), there is NOTHING to (re)build or (re)verify.
    // The serial loop already `continue`s a 'done' screen, but a resume still spun
    // through the worker setup + per-screen live reads + phase emits; worse, ANY
    // non-done screen (a stale 'building' from a hard crash) would re-implement.
    // Make the skip authoritative: if blocking==0 over the build targets, bypass the
    // loop entirely and fall straight through to the verify-rollup + finalize branch
    // below. Result: resuming a done run does ZERO screen rebuilds and reaches
    // finalize in seconds.
    const buildTargetScreens = run.screens.filter(s => isBuildTarget(s.frameId));
    const allTargetsDone = buildTargetScreens.length > 0 && buildTargetScreens.every(s => s.status === 'done');
    if (allTargetsDone) {
      await appendRunLog(projectId, runId, `[run] all ${buildTargetScreens.length} target screen(s) already done — skipping build loop, proceeding to verify/finalize`);
    } else if (workers > 1) {
      // ── Bounded parallel worker pool (fresh sessions only) ──────────────────
      // A shared work queue drained by `workers` concurrent builders. No session
      // threading (each screen is cold against the written contract), so order
      // only affects which screens see the most-extended context.md, not output.
      const queue = run.screens.filter(s => isBuildTarget(s.frameId));   // P3: leads only when canonical
      let cancelled = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (isRunCancelled(runId)) { cancelled = true; return; }
          const screen = queue.shift();
          if (!screen) return;
          if (!(await stillNeeded(screen.frameId))) continue;
          await emitBuilding(screen.frameName);   // show the screen as it STARTS
          await buildRunScreen(run, screen, projectRoot, appPlan, undefined, canonCtxFor(screen.frameId));
          await emitBuildProgress();   // T9: bump "screen X/N" as each worker finishes one
          // RFC §9.2 — checkpoint when a screen reaches a terminal accepted/done state.
          if (!(await stillNeeded(screen.frameId))) {
            await runCheckpoint(projectId, runId, projectRoot, `screen ${screen.frameId} accepted`, screen.frameName);
          }
        }
      };
      await Promise.all(Array.from({ length: workers }, () => worker()));
      if (cancelled || isRunCancelled(runId)) {
        await appendRunLog(projectId, runId, '[run] stopped by user');
        await setRunStatus(projectId, runId, 'stopped');
        return;
      }
    } else {
      // ── Serial (shared session by default, or fresh-serial) ─────────────────
      let session = run.freshSessions ? undefined : run.sessionId;
      // P5: rolling-review cadence (RFC §5 Checkpoint 3) — pause every N built screens.
      const ROLLING_EVERY = 5;
      let builtSinceGate = 0;
      let screensBuilt = 0;
      for (const screen of run.screens) {
        if (isRunCancelled(runId)) {
          await appendRunLog(projectId, runId, '[run] stopped by user');
          await setRunStatus(projectId, runId, 'stopped');
          return;
        }
        if (!isBuildTarget(screen.frameId)) continue;   // P3: non-lead frame folded into its canonical lead
        // Skip screens already built (resume): re-read live status each time.
        const live = await getRun(projectId, runId);
        const cur = live?.screens.find(s => s.frameId === screen.frameId);
        if (cur?.status === 'done') { session = run.freshSessions ? undefined : (cur.sessionId || session); continue; }
        await emitBuilding(screen.frameName);   // show the screen as it STARTS (not just on completion)
        const sess = await buildRunScreen(run, screen, projectRoot, appPlan, session, canonCtxFor(screen.frameId));
        // In fresh-session mode there is no cross-screen thread to carry forward.
        if (sess && !run.freshSessions) { session = sess; await setRunSession(projectId, runId, session); }
        screensBuilt++; builtSinceGate++;
        await emitBuildProgress();   // T9: bump "screen X/N" after each serial screen
        // RFC §9.2 — checkpoint when this screen reaches a terminal accepted/done state.
        {
          const after = await getRun(projectId, runId);
          const st = after?.screens.find(s => s.frameId === screen.frameId);
          if (st?.status === 'done') await runCheckpoint(projectId, runId, projectRoot, `screen ${screen.frameId} accepted`, screen.frameName);
        }

        // ── HITL Checkpoint 2 (RFC §5): after the FIRST screen — freeze the visual
        // language (design system + screen-1 reference build) before scaling.
        if (screensBuilt === 1) {
          const l2 = await getRun(projectId, runId) ?? run;
          if (await gate(l2, 'design-system', 'review the design system + screen-1 reference build before scaling')) return;
        }
        // ── HITL Checkpoint 3 (RFC §5): rolling review every N screens. ──────────
        if (builtSinceGate >= ROLLING_EVERY) {
          builtSinceGate = 0;
          const l3 = await getRun(projectId, runId) ?? run;
          if (await gate(l3, 'rolling', `rolling review — ${screensBuilt} screen(s) built so far`)) return;
        }
      }
    }

    if (isRunCancelled(runId)) {
      await appendRunLog(projectId, runId, '[run] stopped by user');
      await setRunStatus(projectId, runId, 'stopped');
      return;
    }
    setGenPhase(projectId, runId, 'Verify', 'rolling up screen verdicts');
    // BUG 1: ROBUST + FAULT-SAFE rollup read. A single getRun could return null / a
    // screens-less / an under-populated run during heavy concurrent writes → total &
    // blocking collapsed to 0 → the blocking>0 park was skipped → it FINALIZED a half-
    // built app (a 17/30 needs-review run shipped done, logged "0/0 built"). Re-read
    // with a bounded retry until screens.length matches the authoritative in-memory
    // count; never fall back to an empty object. Then derive the verdict from a pure,
    // tested guard that NEVER lets a fault read masquerade as a clean 0/0 completion.
    const done = await readRollupRun(projectId, runId, run);
    const rollup = resolveRollupVerdict(done, run.screens.length);
    const { total, built, needsReview, failed, blocking } = rollup;

    // ── CONSOLIDATION PASS (option 3): de-duplicate token literals ───────────────
    // Every screen is built; sweep the generated screens/components and replace raw
    // color literals that EXACTLY match a design token with AppTheme.<token> (+ add
    // the theme import). Pure, reversible textual substitution — opaque-only, so a
    // translucent overlay is never altered. This retro-fixes screens that hardcoded
    // before/around the theme being generated, and keeps a single source of truth.
    if (themeTokens && (run.framework || 'flutter').toLowerCase() === 'flutter') {
      try {
        const c = await consolidateDesignTokens(projectRoot, themeTokens);
        if (c.replacements > 0) await appendRunLog(projectId, runId, `[consolidate] ${c.replacements} hardcoded color literal(s) → AppTheme tokens across ${c.filesChanged} file(s)`);
      } catch (e: any) {
        await appendRunLog(projectId, runId, `[consolidate] skipped (non-fatal): ${e?.message || 'unknown'}`);
      }
    }
    // ── T12 (RFC v2 §3 Phase 5/6): ALWAYS-RUN ASSET RE-POINT SAFETY NET ──────────
    // Convert any raw 'assets/...' literals the build agent still emitted → AppAssets
    // symbols, REGARDLESS of needs-review/failed screens. This is the critical fix:
    // re-point previously lived only inside finalizeApp (the `else` branch below),
    // which is gated on blocking === 0, so a run with ≥1 needs-review screen NEVER
    // repointed and shipped screens referencing renamed/deleted asset files. It runs
    // here, unconditionally, over the built screens — build-safe via the T10 git
    // snapshot/rollback (a regression rolls back exactly). Idempotent, so the finalize
    // re-point below (when blocking === 0) is a no-op after this.
    try {
      await runAssetRepoint(projectId, runId, projectRoot);
    } catch (e: any) {
      await appendRunLog(projectId, runId, `[assets] re-point safety net skipped (non-fatal): ${e?.message || 'unknown'}`);
    }
    // ── BUG 1 HARD GUARD: a FAULT rollup never finalizes / marks done ────────────
    // The resolved read was null / under-populated (screens vanished mid-read) OR the
    // run is zero-built "complete". Either way it is NOT a real completion — refuse to
    // finalize. Park the run resumable so a human / resume rebuilds it (an empty 0/0
    // never silently ships). RETURN before the finalize/park branch.
    if (rollup.verdict === 'fault') {
      await appendRunLog(projectId, runId, `[run] rollup read inconsistent — refusing to finalize a possibly-incomplete app (no silent 0/0). expected=${run.screens.length} read=${total} built=${built} needs-review=${needsReview} failed=${failed}`);
      await setGenPhase(projectId, runId, 'Verify', 'rollup read inconsistent — held for review', true);
      try { await setRunResumable(projectId, runId, true); } catch { /* non-fatal */ }
      await setRunStatus(projectId, runId, 'needs-review');
      return;
    }
    // ── HITL Checkpoint 4 (RFC §5): before global wiring / full build / deploy ────
    // Only gate here when the queue is clear (a blocking screen parks the run for
    // review below — the pre-global gate is the human sign-off once it's clean).
    if (rollup.verdict === 'finalize' && done) {
      if (await gate(done, 'pre-global', `pre-global sign-off — ${built}/${total} built, needs-review 0`)) return;
    }
    // RFC §4.7 + audit A.1: a run does NOT report complete while any screen is
    // needs-review OR failed — it parks in 'needs-review' until a human Accepts /
    // Corrected-retries / restarts every queued or errored screen.
    if (rollup.verdict === 'park-needs-review') {
      // T9: terminal-but-blocked — leave the phase on Verify with a queue detail so
      // the UI reads "Phase 6/7: Verify — k need review" alongside the needs-review state.
      // AWAIT the phase write before the status flip (same read-modify-write clobber as
      // the terminal-done path: a fire-and-forget phase write could overwrite status).
      await setGenPhase(projectId, runId, 'Verify', `${needsReview} need review${failed ? `, ${failed} failed` : ''}`, true);
      await setRunStatus(projectId, runId, 'needs-review');
      await appendRunLog(projectId, runId, `[run] paused for review — ${built}/${total} matched, ${needsReview} need review${failed ? `, ${failed} failed` : ''}`);
      void notify({
        kind: 'needs-review', projectId, runId,
        detail: `Build parked — ${needsReview} screen(s) need review${failed ? `, ${failed} failed` : ''} (${built}/${total} matched)`,
      });
    } else {
      // ── P7 FINALIZE PHASE (best-effort, build-safe) ──────────────────────────
      // The screen loop is finished and every screen matched (blocking === 0), so
      // the run reached terminal success. Run the six production-readiness passes
      // (finalizeApp) over the built app as a final phase, streaming its log into
      // the run's durable log. This runs ONLY here — AFTER the screen loop, never
      // while it is still going. It is gated to whole-app builds + a run flag, and
      // wrapped in try/catch so a finalize failure NEVER flips this successful build
      // to failed: we log and move on, leaving the run 'done'. Idempotence: skip if
      // .uix/finalize-report.json already exists (matches the canonicalization
      // "reuse persisted, don't redo" pattern), so a resume after redeploy that
      // re-enters this branch does not re-run finalize.
      const finalizeEnabled = run.kind === 'whole-app' && run.finalize !== false;
      const finalizeReportPath = path.join(projectRoot, '.uix', 'finalize-report.json');
      const finalizeAlreadyRan = fsSync.existsSync(finalizeReportPath);
      // T14.8 HEADER PRESERVATION — RE-STAMP the `// canonicalId: … route: …`
      // header onto any screen file the per-screen agent rewrote without it, BEFORE
      // finalize: 8b (modal→overlay), 8d (flow-wiring) + 8e (semantic-rename) map a
      // file back to its canonical screen via that marker. Deterministic + idempotent
      // (file→canonicalId is the skeleton's slug convention; a file that already has
      // the header is untouched). Best-effort: never fail the run on it.
      if (finalizeEnabled && !finalizeAlreadyRan) {
        try {
          const canonForStamp = await readCanonical(projectRoot, runId);
          if (canonForStamp) {
            const r = await restampCanonicalHeaders(projectRoot, canonForStamp);
            if (r.stamped.length || r.missingFiles.length) {
              await appendRunLog(projectId, runId,
                `[finalize] header re-stamp — restored canonicalId header on ${r.stamped.length} screen file(s)`
                + (r.missingFiles.length ? `; ${r.missingFiles.length} canonical screen(s) had no file on disk` : ''));
            }
          }
        } catch (e: any) {
          await appendRunLog(projectId, runId, `[finalize] header re-stamp skipped (non-fatal): ${e?.message || 'unknown'}`);
        }
      }
      if (finalizeEnabled && !finalizeAlreadyRan) {
        try {
          setGenPhase(projectId, runId, 'Finalize', 'production passes');
          const finalizeModel = isAIModel(run.model) ? (run.model as AIModel) : undefined;
          const env = createTerminalEnv(resolveWorkspace());
          await appendRunLog(projectId, runId, `[finalize] starting P7 production passes (model=${finalizeModel ?? 'none'})`);
          const report = await finalizeApp(projectId, {
            projectRoot,
            model: finalizeModel,
            env,
            log: (msg) => { void appendRunLog(projectId, runId, msg); },
            runModel: async (m, prompt, e, cwd, opts) => {
              const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
              return { text };
            },
          });
          const applied = report.passes.filter(p => p.status === 'applied').length;
          const reverted = report.passes.filter(p => p.status === 'reverted').length;
          await appendRunLog(projectId, runId, `[finalize] complete — ${applied} applied, ${reverted} reverted (analyze ${report.baselineAnalyze ?? 'n/a'} → ${report.finalAnalyze ?? 'n/a'})`);
          // RFC §9.2 — checkpoint after finalize (the production passes are already
          // per-pass committed inside finalizeApp; this captures any net residue).
          await runCheckpoint(projectId, runId, projectRoot, 'phase finalize', `${applied} applied, ${reverted} reverted`);
        } catch (e: any) {
          // Never let a finalize failure change the run's terminal status.
          await appendRunLog(projectId, runId, `[finalize] skipped (non-fatal — build stays complete): ${e?.message || 'unknown'}`);
        }
      } else if (finalizeAlreadyRan) {
        await appendRunLog(projectId, runId, `[finalize] already ran for this run (finalize-report.json present) — skipping`);
      }

      // T31: mark the run finalized once the P7 phase has actually run (report on
      // disk) OR when finalize is disabled for this run (a no-finalize run is, by
      // definition, "done with no further finalize to do"). This drives the Runs UI
      // "Finalize" action and the resume/accept auto-finalize guard below — a done
      // run that is NOT finalized still has finalize to run.
      const finalizeDidRun = !finalizeEnabled || fsSync.existsSync(finalizeReportPath);
      if (finalizeDidRun) { try { await setRunFinalized(projectId, runId, true); } catch { /* non-fatal */ } }

      // Terminal completion: clear the resumable flag so a finished run is never
      // re-launched on a later boot (audit A.4). Also clear any rate-limit pause
      // bookkeeping so a stale resumeAt can't make the sweep re-launch a done run.
      await setRunResumable(projectId, runId, false);
      try { await mutateRun(projectId, runId, (run) => { run.rateLimitPaused = false; run.resumeAt = undefined; }); } catch { /* non-fatal */ }
      // AWAIT the terminal phase write BEFORE flipping status: both setRunPhase and
      // setRunStatus do a full run read-modify-write, so a fire-and-forget phase write
      // here could land AFTER setRunStatus('done') and clobber status back to the value
      // it had read ('running') — leaving a finished run stuck reporting 'running'. The
      // all-done fast-path made this race deterministic (the writes interleave tightly).
      await setGenPhase(projectId, runId, 'Finalize', `done — ${built}/${total} accepted`, true);
      await setRunStatus(projectId, runId, 'done');
      await appendRunLog(projectId, runId, `[run] complete — ${built}/${total} built`);
      void notify({
        kind: 'done', projectId, runId,
        detail: `Build finished: ${built}/${total} screens built`,
      });
    }
  } catch (e: any) {
    await appendRunLog(projectId, runId, `[run] error: ${e?.message || 'unknown'}`);
  } finally {
    unsub();
    clearRunActive(runId);
    clearRunCancelled(runId);
  }
}

// ── Needs-review: human Corrected-retry (RFC §4.7) ─────────────────────────────
// Re-build ONE needs-review screen with a concrete human correction note injected
// into a fresh fix pass (the automated 3-pass loop already failed, so the human's
// input is what's new). Runs server-side like the main loop; survives tab close.
async function retryScreenLoop(projectId: string, runId: string, frameId: string, note: string): Promise<void> {
  const jobKey = `${runId}:${frameId}`;
  if (isRunActive(jobKey)) return;
  markRunActive(jobKey);
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { clearRunActive(jobKey); return; }
  const unsub = subscribeJobLog((e) => {
    if (e.kind !== 'line' || !e.line || !e.jobKey.startsWith(`${runId}:`)) return;
    void appendRunLog(projectId, runId, e.line);
  });
  try {
    const run = await getRun(projectId, runId);
    const screen = run?.screens.find(s => s.frameId === frameId);
    if (!run || !screen || !screen.spec) {
      await appendRunLog(projectId, runId, `[review] retry skipped "${frameId}" — no build spec`);
      return;
    }
    // Audit A.3: reuse the canonical route scheme on a corrected-retry too (one
    // scheme), reading the persisted canonical.json when the run was canonicalized.
    const canonical = run.canonical ? (await readCanonical(projectRoot, runId)) ?? undefined : undefined;
    // P1-core: a corrected-retry can now target a FOLDED state/modal frame (they
    // land in needs-review individually). Rebuilding such a frame STANDALONE would
    // recreate the exact defect canonicalization prevents (a modal as its own
    // page) — REDIRECT the retry to the frame's LEAD screen, whose loop rebuilds
    // and re-verifies every non-done folded variant in place.
    let targetFrameId = frameId;
    let canonScreen: CanonicalScreen | undefined;
    if (canonical) {
      const leadOf = (cs: CanonicalScreen): string | undefined => cs.states[0]?.frameId ?? cs.frameIds[0];
      canonScreen = canonical.screens.find(cs => leadOf(cs) === frameId);
      if (!canonScreen) {
        const owner = canonical.screens.find(cs =>
          cs.states.some(st => st.frameId === frameId) || cs.modals.some(m => m.frameId === frameId) || cs.frameIds.includes(frameId));
        const ownerLead = owner ? leadOf(owner) : undefined;
        if (owner && ownerLead) {
          canonScreen = owner;
          targetFrameId = ownerLead;
          await appendRunLog(projectId, runId, `[review] "${screen.frameName}" is a folded state/modal of ${owner.canonicalId} — retrying its LEAD screen (the variant is rebuilt + verified inside the lead, never as a standalone page)`);
        }
      }
    }
    const target = run.screens.find(s => s.frameId === targetFrameId) ?? screen;
    if (!target.spec) {
      await appendRunLog(projectId, runId, `[review] retry skipped "${targetFrameId}" — no build spec on the lead screen`);
      return;
    }
    await updateRunScreen(projectId, runId, targetFrameId, { status: 'building' });
    const appPlan = buildAppPlan(run, canonical);
    // P2: inject the same written contract (app plan + API surface + context.md) so a
    // corrected-retry builds against the established design system, not in a vacuum.
    const contextSlice = await readContextSlice(projectRoot);
    // T12: a corrected-retry must also see the AppAssets inventory (so a re-build
    // emits symbols, not raw paths).
    let contract = `${await assetInventoryBlock(projectRoot)}${buildWrittenContract(run, appPlan, contextSlice, run.freshSessions === true, canonical)}`;
    // P1-core: a canonical lead's retry also carries its states/modals payload
    // (reference paths + IR + presentation hints) — same contract as the build.
    if (canonical && canonScreen) contract = `${buildCanonicalContext(canonical, canonScreen, run.screens)}\n\n— — —\n${contract}`;
    // The human correction is authoritative and injected up-front so the fresh pass
    // acts on it (the previous automated discrepancies didn't converge).
    const correction = `HUMAN CORRECTION (authoritative — the automated loop did NOT converge; apply this specific guidance):\n${note}`;
    const startJobId = jobKey;
    startJobLog(startJobId, { projectId, firstLine: `[loop] corrected-retry "${target.frameName}"` });
    await appendRunLog(projectId, runId, `[review] corrected-retry "${target.frameName}": ${note.replace(/\s+/g, ' ').trim()}`);
    const sreq: BuildScreenReq = {
      projectId, model: run.model as AIModel, modelId: run.modelId, sessionId: target.sessionId || run.sessionId,
      framework: run.framework || 'flutter', frameId: targetFrameId, frameName: target.frameName,
      width: target.spec.width, height: target.spec.height,
      referenceImagePath: target.spec.referenceImagePath,
      implementPrompt: `${contract}\n\n— — —\n${correction}\n\n— — —\nNOW REVISE THIS SCREEN:\n${hygieneIR(target.spec.packet) ?? target.spec.packet}`,
      tree: hygieneIR(target.spec.tree), maxIterations: run.maxIterations, jobId: startJobId, runId,
      userNotes: [run.userNotes?.trim(), note.trim()].filter(Boolean).join('\n\n'), verify: run.verify,
      // P3 (RFC §4.5): reconciliation gate also applies to a corrected-retry.
      canonical, canonicalId: canonical?.frameMap[targetFrameId],
      // P1-core: re-verify the lead's non-done folded variants too.
      variants: canonScreen ? variantsForCanonicalScreen(canonScreen, run.screens) : undefined,
    };
    try {
      const sess = await runScreenLoop(sreq, projectRoot, startJobId);
      if (sess) await setRunSession(projectId, runId, sess);
    } catch (e: any) {
      appendJobLog(startJobId, `[loop] error: ${e?.message || 'unknown'}`);
      finishJobLog(startJobId, '[loop] failed');
      await updateRunScreen(projectId, runId, targetFrameId, { status: 'needs-review' });
    }
    // Re-derive the run status: if this was the last needs-review screen and it now
    // matched, deriveStatus (via updateRunScreen) already flipped the run to 'done'.
  } finally {
    unsub();
    clearRunActive(jobKey);
  }
}

/**
 * T15 (resume-during-prep): the GENERATION entrypoint's server-side PREP + start.
 * Runs the reference render + packet build + asset pass over every screen, then
 * hands off to runAppLoop. Reconstructs ALL its inputs from the persisted run
 * (figStorageKey/framework/flow/model/figmaUrl/scale + frameIds/frameNames off
 * run.screens), so it is callable BOTH from the prepare-and-run route (fresh) AND
 * from resumeInterruptedRuns after a redeploy mid-prep.
 *
 * The MAJOR fix: it marks the run `resumable:true` the INSTANT prep begins (before
 * the old code only set resumable once runAppLoop started), so a redeploy during
 * PREP no longer leaves the run `running`+`resumable:false` (stuck — skipped by the
 * boot scan). On a clean prep finish it sets `prepDone:true` so a later resume goes
 * straight into runAppLoop instead of re-prepping. Prep itself is idempotent (the
 * per-frame reference cache + content-addressed assets make a re-run cheap), so a
 * mid-prep resume that re-runs prep is safe.
 */
async function prepAndRun(projectId: string, runId: string): Promise<void> {
  const run = await getRun(projectId, runId);
  if (!run) return;
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { await appendRunLog(projectId, runId, `[prep] fatal: project root missing — run not started`); return; }

  // MAJOR FIX: a build interrupted DURING prep must be auto-resumable. Mark it the
  // instant prep starts (the old gap: resumable was only set once runAppLoop ran, so
  // a redeploy mid-prep left the run running+resumable:false → resumeInterruptedRuns
  // skipped it → prep never re-ran → stuck).
  await setRunResumable(projectId, runId, true);

  const figStorageKey = run.figStorageKey ?? '';
  if (!figStorageKey) { await appendRunLog(projectId, runId, `[prep] fatal: run has no figStorageKey — cannot prep`); return; }
  const framework = run.framework || 'flutter';
  const scale = typeof run.scale === 'number' && run.scale > 0 ? run.scale : 2;
  const figmaUrl = run.figmaUrl ?? '';
  const frameIds = run.screens.map(s => s.frameId);
  const frameNames: Record<string, string> = {};
  for (const s of run.screens) frameNames[s.frameId] = s.frameName;
  // Reconstruct the FlowGraph (PrepConfig shape) from the run's RunFlow.
  const flow: FlowGraph = {
    entryFrameId: run.flow?.entryFrameId ?? null,
    connections: (run.flow?.connections ?? []).map(c => ({
      from: c.from, to: c.to, type: c.type as FlowGraph['connections'][number]['type'], label: c.label,
    })),
  };
  const userNotes = run.userNotes;
  const model = run.model;

  try {
    await appendRunLog(projectId, runId, `[prep] preparing ${frameIds.length} screen(s) server-side (framework ${framework}, scale ${scale}×)`);
    // (a) Hybrid completion from the design URL (fill external/library gaps) — log progress.
    if (figmaUrl) {
      await appendRunLog(projectId, runId, `[prep] completing IR from design URL…`);
      await ensureIrComplete(figStorageKey, figmaUrl, (s) => { void appendRunLog(projectId, runId, `[prep] ir-complete: ${s}`); });
    }

    // Resolve the frame geometry from the IR (the client used to pass it; the
    // server reads it from UIX so the packet/cache get real dimensions).
    const irData = await getIrData(figStorageKey);
    const frameById = new Map<string, FigFrame>();
    for (const f of (irData?.frames ?? [])) frameById.set(f.id, f);
    const allFrames: FigFrame[] = frameIds.map(id => frameById.get(id) ?? {
      id, name: frameNames[id] ?? id, x: 0, y: 0, width: 393, height: 852, pageId: '', pageName: '',
    });

    // (b) Prep each frame with bounded concurrency. Screen 1 bootstraps the
    // project; every later screen is forced bootstrapped (shared scaffold).
    // A shared `seen` set dedupes asset writes across the batch.
    const seen = new Set<string>();
    // Accumulate every frame's localized assets so the asset pass (semantic
    // rename + resources file) runs ONCE over the whole-app union below.
    const allAssets: LocalizedAsset[] = [];
    const POOL = 3;
    let prepared = 0;
    // T16 (RFC §0.1 — no silent degrade): track how each screen's reference was
    // resolved so the prep-done summary reports it honestly. A frame that FAILED
    // to render (harness present, every attempt failed) is a weaker packet-only
    // reference and a human must see it — it is NOT the same as a cache hit.
    let renderedCount = 0;        // freshly rendered references this run
    let cacheHitCount = 0;        // restored from the prep cache
    let renderFailedCount = 0;    // harness present but render failed → packet-only
    let noHarnessCount = 0;       // harness/Chrome absent → packet-only by design
    let firstDone = false;
    const order = [...frameIds];
    let idx = 0;
    // Serialize the run's read-modify-write so concurrent prep workers don't
    // clobber each other's spec writes (each saves the WHOLE run object).
    let saveChain: Promise<void> = Promise.resolve();
    const persistSpec = (frameId: string, spec: ScreenSpec): Promise<void> => {
      saveChain = saveChain.then(async () => {
        const cur = await getRun(projectId, runId);
        const sc = cur?.screens.find(s => s.frameId === frameId);
        if (sc && cur) { sc.spec = spec; await saveRun(projectId, cur); }
      });
      return saveChain;
    };
    const prepOne = async (frameId: string, bootstrapped: boolean): Promise<void> => {
      const frame = allFrames.find(f => f.id === frameId)!;
      const cfg: PrepConfig = {
        figStorageKey, framework, flow, frames: allFrames,
        bootstrapped, userNotes, scale,
      };
      try {
        const r = await prepScreen(projectId, frame, cfg, seen);
        if (!r) { await appendRunLog(projectId, runId, `[prep] frame "${frame.name}" — prep failed (no project root)`); return; }
        await persistSpec(frameId, r.spec);
        if (r.assets?.length) allAssets.push(...r.assets);
        // T16: report the reference outcome honestly and count each kind.
        let how: string;
        if (r.cacheHit) {
          how = 'cache HIT'; cacheHitCount++;
        } else if (r.rendered) {
          how = 'rendered'; renderedCount++;
        } else if (r.renderFailure === 'failed') {
          // LOUD warning (RFC §0.1): the harness exists but every retry failed, so
          // this screen builds against a WEAKER packet-only reference. Surface it
          // attributably; do NOT hard-fail the whole run for one frame.
          how = `WARNING: render FAILED after ${r.renderAttempts ?? '?'} attempt(s) — reference is packet-only (weaker verify)`;
          renderFailedCount++;
          await appendRunLog(projectId, runId,
            `[prep] WARNING: frame "${frame.name}" failed to render after ${r.renderAttempts ?? '?'} attempt(s) — reference is packet-only (weaker verify)`);
        } else {
          how = 'no harness — packet only'; noHarnessCount++;
        }
        await appendRunLog(projectId, runId, `[prep] frame "${frame.name}" ${how}, localized ${r.assetCount} asset(s)`);
        prepared++;
      } catch (e: any) {
        await appendRunLog(projectId, runId, `[prep] frame "${frame.name}" — prep error: ${e?.message || 'unknown'}`);
      }
    };
    // Prep the FIRST frame alone (it bootstraps the project / establishes the
    // cache for shared assets), then the rest with bounded concurrency.
    if (order.length) { await prepOne(order[0], false); firstDone = true; idx = 1; }
    const worker = async (): Promise<void> => {
      while (idx < order.length) { const fid = order[idx++]; await prepOne(fid, firstDone); }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, Math.max(0, order.length - 1)) }, worker));
    // T16: report rendered vs packet-only counts so a human sees any degrade.
    // packet-only = render-failed (loud) + cache-hit (no fresh render this run) is
    // NOT counted as a degrade; only render-failed + no-harness are weaker refs.
    const packetOnly = renderFailedCount + noHarnessCount;
    const summaryTail = packetOnly > 0
      ? `, ${packetOnly} packet-only (${renderFailedCount} render FAILED, ${noHarnessCount} no harness)`
      : '';
    await appendRunLog(projectId, runId,
      `[prep] done — ${prepared}/${frameIds.length} prepared, ${renderedCount} rendered, ${cacheHitCount} cache-hit${summaryTail}; starting build`);
    if (renderFailedCount > 0) {
      await appendRunLog(projectId, runId,
        `[prep] WARNING: ${renderFailedCount} screen(s) FAILED to render (harness present) and will build against a packet-only reference — verify is weaker for those screens`);
    }

    // (b.5) ASSET PASS: semantic-rename the union of localized assets + emit the
    // framework's resources/constants file. The semantic rename is AI-REQUIRED
    // (RFC §0.1 — "a fail is a fail"). If the model does not fire / returns
    // unusable output it THROWS, and per the no-silent-fallback principle the
    // run MUST NOT continue to the per-screen build as though assets succeeded —
    // it PARKS at the design-system gate (HITL 2) so a human sees the failure.
    let assetAiFailed = false;
    try {
      // T9: surface the asset phase (semantic rename count rides in `detail`).
      setGenPhase(projectId, runId, 'Assets', `naming ${allAssets.length} asset(s)`);
      const assetEnv = createTerminalEnv(resolveWorkspace());
      const pass = await runAssetPass(projectId, framework, allAssets, model as AIModel, assetEnv, { runId });
      if (pass) {
        setGenPhase(projectId, runId, 'Assets', `${pass.renamed}/${pass.unique} named`);
        await appendRunLog(projectId, runId,
          `[prep] asset pass: ${pass.gathered} gathered → ${pass.unique} unique-by-content, ${pass.renamed} named, ${pass.duplicatesDeleted} duplicate(s) deleted, ${pass.repaired} raster(s) repaired`
          + (pass.resourcesPath ? `, resources → ${pass.resourcesPath}` : ''));
        // RFC §9.2 — checkpoint after the (generation) asset pass.
        await runCheckpoint(projectId, runId, projectRoot, 'phase assets', `${pass.renamed} named, ${pass.duplicatesDeleted} deduped`);
      }
    } catch (e: any) {
      // A loud AI failure (AiNotFiredError/AiUnusableError) is NOT a silent
      // "skipped": surface it AND halt the run. No garbage resources file was
      // written (the throw came before emit).
      const isAiFail = e?.name === 'AiNotFiredError' || e?.name === 'AiUnusableError';
      assetAiFailed = isAiFail;
      await appendRunLog(projectId, runId,
        isAiFail
          ? `[prep] asset pass FAILED (AI did not fire — assets NOT renamed, no resources file written): ${e?.message || 'unknown'}`
          : `[prep] asset pass error: ${e?.message || 'unknown'}`);
    }

    if (assetAiFailed) {
      // PARK, do NOT proceed to the build. The run is held at the design-system
      // gate (resumable): the asset pipeline is the contract the per-screen
      // build consumes, so building on a failed asset pass would ship
      // Material-icon substitutions / opaque paths and report "applied".
      await appendRunLog(projectId, runId,
        `[prep] HALTED at design-system gate — asset pipeline (AI semantic rename) failed; run will not build until assets resolve (re-run prep or fix model access, then approve)`);
      await pauseAtCheckpoint(projectId, runId, 'design-system',
        'Asset pipeline failed: the AI semantic-rename did not fire / returned unusable output, so assets were NOT renamed and no resources file was written. The per-screen build is blocked because it consumes the asset pipeline. Resolve model access and re-run the asset pass, then approve to continue.');
      return;
    }

    // T15: prep finished cleanly — mark it so a later resume skips straight to the
    // build (runAppLoop) instead of re-running prep.
    await setRunPrepDone(projectId, runId, true);
    // (c) Kick off the server-side orchestration.
    void runAppLoop(projectId, runId).catch(() => {});
  } catch (e: any) {
    await appendRunLog(projectId, runId, `[prep] fatal: ${e?.message || 'unknown'} — run not started`);
  }
}

/**
 * Re-start runs that were GRACEFULLY PAUSED when the process died (e.g. a redeploy).
 * Called once on server boot so a full-app build survives a container restart.
 *
 * P5 (RFC §4.9): no auto-resurrect of crashed / stopped runs. Only a run with the
 * explicit `resumable:true` graceful-pause flag is restarted — a run that was
 * 'running' (mid-screen) when the box died is left alone (its in-flight state is
 * untrustworthy) and a human restarts it from the Runs UI. This kills the old
 * behavior where any 'running' run was blindly re-launched on every redeploy.
 *
 * T15 (resume-during-prep): a resumable+running run that has NOT finished prep
 * (`prepDone` falsy AND no screen yet carries a spec) re-enters via prepAndRun so
 * PREP + the asset pass actually re-run — the old code always jumped to runAppLoop,
 * which skipped prep entirely and left a mid-prep run with no specs/assets stuck.
 */
export async function resumeInterruptedRuns(): Promise<void> {
  try {
    const root = getProjectsRoot();
    if (!fsSync.existsSync(root)) return;
    const projectIds = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    for (const projectId of projectIds) {
      const runs = await listRuns(projectId, 50);
      for (const r of runs) {
        // Audit A.4 (RFC §4.9): auto-resume ONLY a run that was actively orchestrating
        // (status 'running') and is flagged resumable — i.e. a build interrupted by a
        // redeploy/restart. This restores the "survives redeploy" guarantee for the
        // common case. A 'stopped' run (user-stopped or stopped after a crash) and an
        // 'awaiting-approval' run (parked at a HITL gate) are NOT auto-resurrected — a
        // human restarts / approves those from the Runs UI. 'done'/'needs-review' runs
        // are terminal-for-orchestration and likewise left alone.
        const resumable = r.resumable === true && r.status === 'running';
        if (resumable && !isRunActive(r.id)) {
          // T15: a generation run (has figStorageKey) interrupted BEFORE prep
          // finished (prepDone falsy) re-enters via prepAndRun so PREP + the asset
          // pass actually re-run; otherwise jump straight into runAppLoop. Without
          // this, a redeploy mid-prep resumed into runAppLoop with no specs/assets.
          const needsPrep = !!r.figStorageKey && r.prepDone !== true;
          if (needsPrep) {
            void appendRunLog(projectId, r.id, '[run] resuming interrupted run after server restart (redeploy) — prep was not complete, re-running prep + asset pass');
            void prepAndRun(projectId, r.id);
          } else {
            void appendRunLog(projectId, r.id, '[run] resuming interrupted run after server restart (redeploy)');
            void runAppLoop(projectId, r.id);
          }
        }
      }
    }
  } catch { /* boot resume is best-effort */ }
}

// ── Auto-resume sweep ─────────────────────────────────────────────────────────
/**
 * Pure decision: should the periodic sweep auto-resume this run NOW? A run qualifies
 * iff it was paused by a RATE LIMIT (rateLimitPaused — never a user Stop), is parked
 * 'stopped', its parsed reset window (resumeAt) has elapsed, and it is under the cap.
 * The `active` check is applied by the sweep (it knows the in-process set), not here.
 */
export function shouldAutoResume(run: BuildRun, now: number = Date.now()): boolean {
  return run.status === 'stopped'
    && run.rateLimitPaused === true
    && typeof run.resumeAt === 'number'
    && run.resumeAt <= now
    && (run.autoResumeCount ?? 0) < AUTO_RESUME_CAP;
}

/**
 * Periodic sweep (every AUTO_RESUME_SWEEP_MS) — robust across redeploys (no long
 * in-process timer to lose). Scans every run; any run that `shouldAutoResume` AND is
 * not already orchestrating in this process gets its counter bumped, the
 * rateLimitPaused flag cleared, status flipped to 'running', and runAppLoop kicked
 * (the same resume path as POST /start with restart:false). A run that immediately
 * re-limits sets a fresh resumeAt + keeps the counter climbing; the CAP stops an
 * infinite loop. Best-effort: never throws.
 */
export async function sweepRateLimitedRuns(now: number = Date.now()): Promise<void> {
  try {
    const root = getProjectsRoot();
    if (!fsSync.existsSync(root)) return;
    const projectIds = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    for (const projectId of projectIds) {
      const runs = await listRuns(projectId, 50);
      for (const r of runs) {
        if (!shouldAutoResume(r, now) || isRunActive(r.id)) continue;
        const attempt = (r.autoResumeCount ?? 0) + 1;
        // Bump the counter + clear the pause flag + flip to running ATOMICALLY before
        // kicking the loop, so a concurrent sweep tick can't double-resume the run.
        await mutateRun(projectId, r.id, (run) => {
          run.autoResumeCount = attempt;
          run.rateLimitPaused = false;
          run.resumeAt = undefined;
          run.status = 'running';
        });
        await appendRunLog(projectId, r.id, `[run] auto-resume — rate-limit window reset (attempt ${attempt}/${AUTO_RESUME_CAP})`);
        void notify({
          kind: 'auto-resumed', projectId, runId: r.id,
          detail: `Build auto-resumed (attempt ${attempt}/${AUTO_RESUME_CAP}) — rate-limit window reset`,
        });
        void runAppLoop(projectId, r.id).catch(() => {});
      }
    }
  } catch { /* the sweep is best-effort */ }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** Start the periodic auto-resume sweep (idempotent). Wired on boot next to
 *  resumeInterruptedRuns. The interval is unref'd so it never holds the process open. */
export function startAutoResumeSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepRateLimitedRuns(); }, AUTO_RESUME_SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/**
 * P5 (RFC §4.8): regenerate the write-locked skeleton after an approved amendment
 * bumps the plan version. Reuses the persisted canonical.json (the skeleton
 * generator is additive — it never clobbers a built screen file, only fills in the
 * router/route-table + missing stubs), so downstream screens see plan v+1. Flutter
 * only for now (matches generateFlutterSkeleton's scope). Best-effort + logged.
 */
async function regenSkeletonForRun(projectId: string, run: BuildRun): Promise<void> {
  if (!run.canonical || (run.framework || 'flutter').toLowerCase() !== 'flutter') return;
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) return;
  try {
    const canonical = (await readCanonical(projectRoot, run.id)) ?? canonicalizeRun(run.screens, run.flow);
    const sk = await generateFlutterSkeleton(projectRoot, canonical);
    await appendRunLog(projectId, run.id, `[amend] skeleton regenerated for plan v${run.planVersion ?? 1}: ${sk.files.length} file(s), ${sk.routes.length} route(s)`);
  } catch (e: any) {
    await appendRunLog(projectId, run.id, `[amend] skeleton regen failed (continuing): ${e?.message || 'unknown'}`);
  }
}

// ── P5 (RFC §4.8): AMENDMENT EMITTER — orchestrator side ─────────────────────
// The build packet tells the agent to write .uix/amendment-request.json when it
// legitimately needs a route/component not in the plan. After a screen builds we
// read that file (a single request or an array), record each via addAmendment
// (whitelisted classes auto-approve + regen the skeleton; else they queue pending
// for the rolling gate), then DELETE the file so it isn't re-applied next screen.
// No-op when the file is absent (the common case).
interface AmendmentFileEntry { kind?: string; rationale?: string; proposedApi?: string }
async function consumeAmendmentRequests(
  projectId: string, runId: string, projectRoot: string, fromFrameId: string, jobId: string,
): Promise<void> {
  const file = path.join(projectRoot, '.uix', 'amendment-request.json');
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return; }   // no request → no-op
  // Consume immediately so a parse/store failure can't loop on a poison file.
  try { await fs.rm(file, { force: true }); } catch { /* ignore */ }
  let entries: AmendmentFileEntry[] = [];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    appendJobLog(jobId, `[loop] amendment-request.json was malformed — ignored`);
    return;
  }
  for (const e of entries) {
    const kind = e?.kind === 'add-route' || e?.kind === 'add-component' ? e.kind as AmendmentKind : null;
    const proposedApi = typeof e?.proposedApi === 'string' ? e.proposedApi.trim() : '';
    if (!kind || !proposedApi) { appendJobLog(jobId, `[loop] amendment skipped — needs kind ('add-route'|'add-component') + proposedApi`); continue; }
    const rationale = typeof e?.rationale === 'string' ? e.rationale.trim() : '';
    const result = await addAmendment(projectId, runId, { kind, rationale, proposedApi, fromFrameId });
    if (!result) continue;
    const { run, amendment } = result;
    await appendRunLog(projectId, runId, `[amend] ${amendment.kind} "${amendment.proposedApi}" requested by "${fromFrameId}" — ${amendment.status}${amendment.auto ? ' (auto, whitelisted)' : ' (queued for rolling-gate approval)'}`);
    if (amendment.status === 'approved') await regenSkeletonForRun(projectId, run);
  }
}

export function registerScreenLoopRoutes(app: Express): void {
  /**
   * POST /api/ai/build-screen — start the headless implement→verify→fix loop.
   * Returns { jobId } immediately; poll /api/ai/progress and read the per-screen
   * .uix/screens/<frameId>/result.json when the job is done.
   */
  app.post('/api/ai/build-screen', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !isAIModel(b.model) || !b.frameId || !b.implementPrompt || !b.referenceImagePath) {
      res.status(400).json({ error: 'projectId, valid model, frameId, referenceImagePath and implementPrompt are required' });
      return;
    }
    const projectRoot = resolveProjectRoot(b.projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) {
      res.status(404).json({ error: `project not found: ${b.projectId}` });
      return;
    }
    const jobId = b.jobId || `${b.projectId}:${b.frameId}:loop:${Date.now()}`;
    startJobLog(jobId, { projectId: b.projectId, firstLine: `[loop] queued "${b.frameName ?? b.frameId}"` });
    res.json({ jobId, started: true });
    // Fire-and-forget: the loop owns its own logging + error handling so the
    // client tab can close while it runs.
    void runScreenLoop(b as BuildScreenReq, projectRoot, jobId).catch((e: any) => {
      appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
      finishJobLog(jobId, '[loop] failed');
      // Mark the screen FAILED in its run so resume re-attempts it.
      if (b.runId) void updateRunScreen(b.projectId, b.runId, b.frameId, { status: 'failed' }).catch(() => {});
    });
  });

  // ── Durable build runs (resumable after Stop / error / rate limit / redeploy) ──
  // POST /api/ai/runs — create a run for a set of screens. Returns the run.
  app.post('/api/ai/runs', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !Array.isArray(b.screens) || b.screens.length === 0) {
      res.status(400).json({ error: 'projectId and a non-empty screens[] are required' });
      return;
    }
    if (!isAIModel(b.model)) { res.status(400).json({ error: 'a valid model is required' }); return; }
    const run = await createRun(b.projectId, {
      kind: b.kind === 'selected' || b.kind === 'single' ? b.kind : 'whole-app',
      framework: b.framework, figStorageKey: b.figStorageKey,
      model: b.model, modelId: b.modelId,
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : undefined,
      verify: b.verify !== false,
      userNotes: typeof b.userNotes === 'string' ? b.userNotes : undefined,
      // P2: opt into fresh-per-screen sessions (model-independent written contract)
      // and an optional bounded parallel worker pool. parallel>1 implies fresh.
      freshSessions: b.freshSessions === true || (typeof b.parallel === 'number' && b.parallel > 1),
      parallel: typeof b.parallel === 'number' ? b.parallel : undefined,
      // P3: opt into the canonicalization pre-pass + write-locked skeleton.
      canonical: b.canonical === true,
      // P5: enable HITL checkpoint gates (RFC §5). Pass a subset of gate names
      // ('flow','plan','design-system','rolling','pre-global') to pause the run for
      // human approval at those milestones. Omitted/empty → no gating (old behavior).
      checkpoints: Array.isArray(b.checkpoints) ? b.checkpoints.map((g: any) => String(g)) as CheckpointGate[] : undefined,
      flow: b.flow && (Array.isArray(b.flow.connections) || b.flow.entryFrameId !== undefined) ? {
        entryFrameId: b.flow.entryFrameId ?? null,
        connections: Array.isArray(b.flow.connections) ? b.flow.connections.map((c: any) => ({
          from: String(c.from), to: String(c.to), type: String(c.type ?? 'push'), label: c.label ? String(c.label) : undefined,
        })) : [],
      } : undefined,
      screens: b.screens.map((s: any): { frameId: string; frameName: string; spec?: ScreenSpec } => ({
        frameId: String(s.frameId),
        frameName: String(s.frameName ?? s.frameId),
        spec: s.spec && s.spec.packet ? {
          packet: String(s.spec.packet),
          referenceImagePath: String(s.spec.referenceImagePath ?? ''),
          tree: typeof s.spec.tree === 'string' ? s.spec.tree : undefined,
          width: typeof s.spec.width === 'number' ? s.spec.width : undefined,
          height: typeof s.spec.height === 'number' ? s.spec.height : undefined,
          // P4: actual reference-render pixel size (refs are @2×) — drives the
          // pre-flight vision-token estimate. Stored at creation per RFC §4.3.
          refWidthPx: typeof s.spec.refWidthPx === 'number' ? s.spec.refWidthPx : undefined,
          refHeightPx: typeof s.spec.refHeightPx === 'number' ? s.spec.refHeightPx : undefined,
        } : undefined,
      })),
    });
    if (!run) { res.status(404).json({ error: `project not found: ${b.projectId}` }); return; }
    res.json({ run });
  });

  // ── SERVER-SIDE PREP + RUN (the client no longer prepares specs) ─────────────
  // POST /api/ai/prepare-and-run — prepare every screen's build spec ON THE SERVER
  // (render the reference via the headless harness, build the agent packet, localize
  // the frame's assets — cached per-frame), then create the durable run with the
  // prepped screens and kick off the server-side orchestration. Returns { run }
  // immediately; prep streams into the run's durable log. ONE path for both the
  // whole-app build (many frameIds) and a single-frame build (one frameId).
  //
  // Body: {
  //   projectId, figStorageKey, figmaUrl?, frameIds[], frameNames?{id:name},
  //   framework, model, modelId?, flow, userNotes?, verify?, freshSessions?,
  //   parallel?, canonical?, checkpoints?, scale?
  // }
  app.post('/api/ai/prepare-and-run', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const figStorageKey = b.figStorageKey as string;
    const frameIds: string[] = Array.isArray(b.frameIds) ? b.frameIds.map((x: any) => String(x)) : [];
    if (!projectId || !figStorageKey || frameIds.length === 0) {
      res.status(400).json({ error: 'projectId, figStorageKey and a non-empty frameIds[] are required' }); return;
    }
    if (!isAIModel(b.model)) { res.status(400).json({ error: 'a valid model is required' }); return; }
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) { res.status(404).json({ error: `project not found: ${projectId}` }); return; }

    // RFC §9.1 — auto-init git the moment the pipeline touches a managed project, so
    // it is never untracked before prep starts mutating it. Best-effort, non-fatal.
    await ensureProjectGit(projectRoot, {}).catch(() => { /* non-fatal */ });

    const framework = typeof b.framework === 'string' && b.framework ? b.framework : 'flutter';
    const frameNames: Record<string, string> = (b.frameNames && typeof b.frameNames === 'object') ? b.frameNames : {};
    const userNotes = typeof b.userNotes === 'string' ? b.userNotes : undefined;
    const scale = typeof b.scale === 'number' && b.scale > 0 ? b.scale : 2;
    const figmaUrl = typeof b.figmaUrl === 'string' ? b.figmaUrl.trim() : '';
    const flow: FlowGraph = b.flow && (Array.isArray(b.flow.connections) || b.flow.entryFrameId !== undefined)
      ? {
          entryFrameId: b.flow.entryFrameId ?? null,
          connections: Array.isArray(b.flow.connections) ? b.flow.connections.map((c: any) => ({
            from: String(c.from), to: String(c.to), type: String(c.type ?? 'push') as FlowGraph['connections'][number]['type'],
            label: c.label ? String(c.label) : undefined, tabIndex: typeof c.tabIndex === 'number' ? c.tabIndex : undefined,
          })) : [],
        }
      : { entryFrameId: null, connections: [] };
    // The run-store RunFlow shape (no tabIndex) — what createRun + orderScreensByFlow want.
    const runFlow = { entryFrameId: flow.entryFrameId, connections: flow.connections.map(c => ({ from: c.from, to: c.to, type: c.type, label: c.label })) };

    // Create the run FIRST (empty screens) so its durable log + Runs-table row exist
    // immediately and prep progress attaches to a real run. We fill its screens once
    // each is prepped, then start the orchestration.
    const single = frameIds.length === 1;
    const run = await createRun(projectId, {
      kind: single ? 'single' : 'whole-app',
      framework, figStorageKey,
      model: b.model, modelId: b.modelId,
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : undefined,
      verify: b.verify !== false,
      userNotes,
      // T15: persist prep inputs so a redeploy mid-prep can re-run prep on resume.
      figmaUrl: figmaUrl || undefined, scale,
      freshSessions: b.freshSessions === true || (typeof b.parallel === 'number' && b.parallel > 1),
      parallel: typeof b.parallel === 'number' ? b.parallel : undefined,
      canonical: b.canonical === true,
      checkpoints: Array.isArray(b.checkpoints) ? b.checkpoints.map((g: any) => String(g)) as CheckpointGate[] : undefined,
      flow: runFlow,
      // Seed the screens as pending now (name only); prep populates each spec below.
      screens: frameIds.map(id => ({ frameId: id, frameName: frameNames[id] ?? id })),
    });
    if (!run) { res.status(404).json({ error: `project not found: ${projectId}` }); return; }
    res.json({ run });

    // ── Prep + start in the background (survives the request returning) ───────────
    // T15: prepAndRun marks the run resumable the instant prep begins and re-runs
    // prep faithfully on a redeploy mid-prep (resume reconstructs its inputs off the
    // run). The route just kicks it off; resumeInterruptedRuns calls the same fn.
    void prepAndRun(projectId, run.id).catch(() => {});
  });


  // POST /api/ai/runs/:runId/start { projectId, steerNotes?, restart? } — kick off
  // (or resume) the SERVER-SIDE orchestration of the whole run. Returns immediately.
  app.post('/api/ai/runs/:runId/start', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    let run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (isRunActive(runId)) { res.json({ run, started: false, alreadyRunning: true }); return; }
    clearRunCancelled(runId);
    if (b.restart) {
      run = await restartRun(projectId, runId) ?? run;
      // RESTART = CLEAN SLATE. restartRun resets screen statuses + clears phase/
      // checkpoint/finalized + drops finalize-report.json, but NEVER clears the
      // generated lib/ tree — so a same-.fig restart would rebuild ON TOP of the
      // prior build (old+new files mix, stale components/previews, scrambled assets).
      // Take a RECOVERABLE git checkpoint first, THEN nuke the generated surface so
      // the existing flow regenerates it fresh. SAFE-BY-CONSTRUCTION: if version
      // control can't give us a recoverable snapshot, we DO NOT nuke (fail safe —
      // never irrecoverably delete). The resume path never reaches here.
      const projectRoot = resolveProjectRoot(projectId);
      if (projectRoot) {
        const framework = run.framework || 'flutter';
        const vc = { log: (msg: string) => { void appendRunLog(projectId, runId, msg); } };
        let snapshotSha: string | null = null;
        try {
          await ensureProjectGit(projectRoot, vc);
          if (fsSync.existsSync(path.join(projectRoot, '.git'))) {
            snapshotSha = await commitCheckpoint(
              projectRoot,
              `pre-restart: clean slate snapshot (${runId})`,
              undefined,
              vc,
            );
          }
        } catch { snapshotSha = null; }
        // A recoverable snapshot is a HARD requirement before a destructive nuke. A
        // clean tree (nothing to commit) returns null but is STILL recoverable — git
        // is initialized and HEAD captures the pre-nuke state — so allow the nuke when
        // .git exists. Only refuse when there's no repo at all (data safety OFF).
        const gitReady = fsSync.existsSync(path.join(projectRoot, '.git'));
        if (!gitReady) {
          await appendRunLog(projectId, runId,
            `[run] restart — ABORTED clean-slate nuke: NO recoverable version-control snapshot ` +
            `(git unavailable at ${projectRoot}); refusing to irrecoverably delete the generated surface. ` +
            `Rebuilding additively instead (resume-like). Fix git to enable a true clean-slate restart.`);
        } else {
          try {
            const nuked = await nukeGeneratedAppSurface(projectRoot, framework);
            const removedCount = nuked.removedDirs.length + nuked.removedFiles.length;
            if (nuked.skipped) {
              await appendRunLog(projectId, runId, `[run] restart — clean slate: ${nuked.skipped}`);
            } else {
              await appendRunLog(projectId, runId,
                `[run] restart — clean slate: snapshot ${snapshotSha ? snapshotSha.slice(0, 8) : '(clean tree, HEAD recoverable)'}, ` +
                `removed ${removedCount} generated file(s); regenerating from scratch`);
            }
          } catch (e) {
            // Nuke is best-effort + never throws, but belt+braces: never break the handler.
            await appendRunLog(projectId, runId, `[run] restart — clean-slate nuke error (non-fatal): ${(e as Error).message}`);
          }
        }
      }
    }
    const steer = typeof b.steerNotes === 'string' ? b.steerNotes.trim() : '';
    if (steer) {
      run.userNotes = [run.userNotes?.trim(), steer].filter(Boolean).join('\n\n');
      await saveRun(projectId, run);
      // T33: set status THROUGH mutateRun (emits run:state) so the UI flips to running.
      if (run.status !== 'running') { await setRunStatus(projectId, runId, 'running'); run.status = 'running'; }
    } else if (run.status === 'stopped') {
      await setRunStatus(projectId, runId, 'running');
      run.status = 'running';
    } else if ((run.status === 'done' || run.status === 'needs-review') && !b.restart) {
      // T31: resume a done-but-unfinalized run (or one whose last needs-review screen
      // was just Accepted) to RUN FINALIZE through the run. runAppLoop's all-done
      // fast-path skips the build loop and goes straight to the finalize branch — no
      // screen rebuilds, no re-verify. T33: flip to running THROUGH mutateRun (emits
      // run:state) so the UI reflects the active finalize phase + streams it (the loop
      // sets it back to 'done' on completion).
      await setRunStatus(projectId, runId, 'running');
      run.status = 'running';
      await appendRunLog(projectId, runId, `[run] resume → finalize (no rebuilds; all screens already done)`);
    }
    void runAppLoop(projectId, runId).catch(() => {});
    res.json({ run, started: true });
  });

  // POST /api/ai/runs/:runId/stop { projectId } — request a graceful stop after
  // the in-flight screen finishes. Marks the run 'stopped' (resumable later).
  app.post('/api/ai/runs/:runId/stop', async (req, res) => {
    const projectId = (req.body?.projectId ?? req.query.projectId) as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    markRunCancelled(runId);
    await appendRunLog(projectId, runId, '[run] stop requested');
    // P5 (RFC §4.9): a user Stop is a GRACEFUL pause → mark resumable so a later
    // /start (or, if the user opts in, boot-resume) can pick it back up. (A crash
    // leaves resumable:false, so only intentional stops are resumable.)
    await setRunResumable(projectId, runId, true);
    // Reflect the stop IMMEDIATELY: 'stopped' is a STICKY status (STICKY_RUN_STATUS),
    // so the orchestrator's per-screen deriveStatus won't flip it back to 'running',
    // and the cancel flag halts the loop after the in-flight screen. Previously this
    // only set 'stopped' when the run was NOT active — so during a build (active) the
    // run kept showing 'running' for minutes until the loop next checked, and the
    // Stop button looked like it did nothing.
    await setRunStatus(projectId, runId, 'stopped');
    res.json({ stopped: true });
  });

  // ── P5: HITL checkpoint gates (RFC §5) ───────────────────────────────────────
  // POST /api/ai/runs/:runId/checkpoint { projectId, action: 'approve'|'edit',
  //   gate?, edits? } — clear the parked checkpoint and resume the build. 'edit'
  //   applies optional edits to the run (entryFrameId / steerNotes) before resuming
  //   — the minimal "edit" affordance the RFC's checkpoint UI needs.
  app.post('/api/ai/runs/:runId/checkpoint', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    let run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (run.status !== 'awaiting-approval' || !run.checkpoint) {
      res.status(409).json({ error: `run is not awaiting approval (status: ${run.status})` }); return;
    }
    const gateName = (b.gate as CheckpointGate) ?? run.checkpoint.gate;
    // Optional edits applied at the gate (RFC §5: edit clustering/entry/nav, steer).
    const edits = b.edits ?? {};
    if (run.flow && typeof edits.entryFrameId === 'string') { run.flow.entryFrameId = edits.entryFrameId; await saveRun(projectId, run); }
    if (typeof edits.steerNotes === 'string' && edits.steerNotes.trim()) {
      run.userNotes = [run.userNotes?.trim(), edits.steerNotes.trim()].filter(Boolean).join('\n\n');
      await saveRun(projectId, run);
      await appendRunLog(projectId, runId, `[hitl] checkpoint "${gateName}" steered: ${edits.steerNotes.trim().replace(/\s+/g, ' ')}`);
    }
    run = (await approveCheckpoint(projectId, runId, gateName)) ?? run;
    await appendRunLog(projectId, runId, `[hitl] checkpoint "${gateName}" approved — resuming`);
    if (b.action === 'reject') {
      // Reject = stop the run here (resumable so it can be restarted later).
      await setRunResumable(projectId, runId, true);
      await setRunStatus(projectId, runId, 'stopped');
      res.json({ run: await getRun(projectId, runId), resumed: false }); return;
    }
    res.json({ run, resumed: true });
    // Resume orchestration: the cleared gate is recorded in approvedGates so it
    // won't re-fire; the loop continues from where it parked (already-done screens
    // are skipped). Fire-and-forget — survives the request returning.
    void runAppLoop(projectId, runId).catch(() => {});
  });

  // ── P5: plan amendment protocol (RFC §4.8) ───────────────────────────────────
  // POST /api/ai/runs/:runId/amendments { projectId, kind, rationale, proposedApi,
  //   fromFrameId? } — a screen requests a missing route/component. Whitelisted
  //   classes auto-approve (planVersion++ + skeleton regen); else it's queued for
  //   approval at the rolling gate. Returns the created amendment.
  app.post('/api/ai/runs/:runId/amendments', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const kind = b.kind as AmendmentKind;
    const rationale = typeof b.rationale === 'string' ? b.rationale.trim() : '';
    const proposedApi = typeof b.proposedApi === 'string' ? b.proposedApi.trim() : '';
    if (!projectId || (kind !== 'add-route' && kind !== 'add-component') || !proposedApi) {
      res.status(400).json({ error: "projectId, kind ('add-route'|'add-component') and proposedApi are required" }); return;
    }
    const runId = req.params.runId;
    const result = await addAmendment(projectId, runId, { kind, rationale, proposedApi, fromFrameId: b.fromFrameId });
    if (!result) { res.status(404).json({ error: 'run not found' }); return; }
    const { run, amendment } = result;
    await appendRunLog(projectId, runId, `[amend] ${amendment.kind} "${amendment.proposedApi}" — ${amendment.status}${amendment.auto ? ' (auto, whitelisted)' : ' (queued for rolling-gate approval)'}`);
    if (amendment.status === 'approved') await regenSkeletonForRun(projectId, run);
    res.json({ amendment, planVersion: run.planVersion });
  });

  // POST /api/ai/runs/:runId/amendments/:amendmentId { projectId, decision } —
  //   human resolves a pending amendment at the rolling gate. approved → planVersion++
  //   + skeleton regen.
  app.post('/api/ai/runs/:runId/amendments/:amendmentId', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const decision = b.decision === 'approved' ? 'approved' : b.decision === 'rejected' ? 'rejected' : null;
    if (!projectId || !decision) { res.status(400).json({ error: "projectId and decision ('approved'|'rejected') are required" }); return; }
    const runId = req.params.runId;
    const result = await resolveAmendment(projectId, runId, req.params.amendmentId, decision);
    if (!result) { res.status(404).json({ error: 'run or amendment not found' }); return; }
    const { run, amendment } = result;
    await appendRunLog(projectId, runId, `[amend] ${amendment.kind} "${amendment.proposedApi}" — ${decision} (human)`);
    if (decision === 'approved') await regenSkeletonForRun(projectId, run);
    res.json({ amendment, planVersion: run.planVersion });
  });

  // ── Needs-review workflow (RFC §4.7) ─────────────────────────────────────────
  // POST /api/ai/runs/:runId/accept { projectId, frameId } — human accepts a
  // needs-review screen AS-IS. Marks it 'done' (matched stays false; accepted by a
  // human). If it was the last needs-review screen the run flips to 'done'.
  app.post('/api/ai/runs/:runId/accept', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const frameId = b.frameId as string;
    if (!projectId || !frameId) { res.status(400).json({ error: 'projectId and frameId are required' }); return; }
    const runId = req.params.runId;
    const run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const screen = run.screens.find(s => s.frameId === frameId);
    if (!screen) { res.status(404).json({ error: 'screen not found in run' }); return; }
    // Audit A.1: a 'failed' screen is also surfaced in the review queue (with a
    // review payload) and may be human-accepted as-is, so the run can clear it.
    if (screen.status !== 'needs-review' && screen.status !== 'failed') { res.status(409).json({ error: `screen is not reviewable (status: ${screen.status})` }); return; }
    const updated = await updateRunScreen(projectId, runId, frameId, { status: 'done', review: undefined });
    await appendRunLog(projectId, runId, `[review] accepted "${screen.frameName}" as-is (human)`);
    res.json({ run: updated });

    // T31: AUTO-RUN FINALIZE when this Accept clears the LAST blocker. Previously
    // accepting the final needs-review screen flipped the run to 'done' (via the
    // deriveStatus rollup in updateRunScreen) but NEVER re-entered the finalize phase
    // — so Phase 8 only ran via the standalone finalize-app endpoint, invisible in the
    // run log. Here: if the run is now fully done (blocking==0) on a whole-app run that
    // hasn't finalized yet, kick off runAppLoop. Its all-done fast-path skips every
    // screen (zero rebuilds) and runs the existing finalize branch — streaming
    // [finalize] + the Finalize phase into THIS run. Fire-and-forget, guarded so it
    // never runs twice (isRunActive) or on a non-whole-app / already-finalized run.
    const after = updated ?? (await getRun(projectId, runId));
    const blocking = after?.screens.filter(s => s.status === 'needs-review' || s.status === 'failed').length ?? 0;
    if (after && blocking === 0 && after.kind === 'whole-app' && after.finalize !== false && !isRunActive(runId)) {
      const projectRoot = resolveProjectRoot(projectId);
      const finalizeReportPath = projectRoot ? path.join(projectRoot, '.uix', 'finalize-report.json') : '';
      const alreadyFinalized = after.finalized === true || (!!finalizeReportPath && fsSync.existsSync(finalizeReportPath));
      if (!alreadyFinalized) {
        // T33: the Accept rolled the run to 'done' (deriveStatus). Flip it back to
        // 'running' THROUGH mutateRun (emits run:state) BEFORE kicking runAppLoop, or
        // the UI shows a stopped/done run with no live finalize stream.
        await setRunStatus(projectId, runId, 'running');
        await appendRunLog(projectId, runId, `[review] last blocker cleared — auto-running finalize`);
        void runAppLoop(projectId, runId).catch(() => {});
      }
    }
  });

  // POST /api/ai/runs/:runId/retry { projectId, frameId, note } — human Corrected-
  // retry: rebuild this needs-review screen with the human's correction injected
  // into a fresh fix pass. Returns immediately; the rebuild runs server-side.
  app.post('/api/ai/runs/:runId/retry', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const frameId = b.frameId as string;
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    if (!projectId || !frameId) { res.status(400).json({ error: 'projectId and frameId are required' }); return; }
    if (!note) { res.status(400).json({ error: 'a correction note is required for a corrected-retry' }); return; }
    const runId = req.params.runId;
    const run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const screen = run.screens.find(s => s.frameId === frameId);
    if (!screen) { res.status(404).json({ error: 'screen not found in run' }); return; }
    if (isRunActive(`${runId}:${frameId}`)) { res.json({ started: false, alreadyRunning: true }); return; }
    res.json({ started: true });
    void retryScreenLoop(projectId, runId, frameId, note).catch((e: any) => {
      void appendRunLog(projectId, runId, `[review] retry error: ${e?.message || 'unknown'}`);
    });
  });

  // GET /api/ai/runs/:runId/log?projectId= — the durable, replayable run log.
  app.get('/api/ai/runs/:runId/log', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const log = await readRunLog(projectId, req.params.runId);
    res.json({ log, active: isRunActive(req.params.runId) });
  });

  // GET /api/ai/review-image?projectId=&path= — serve a needs-review screenshot
  // (candidate or reference PNG) as raw bytes. Path is sandboxed to the project's
  // .uix dir so the Runs UI can show candidate-vs-reference inline.
  app.get('/api/ai/review-image', async (req, res) => {
    const projectId = req.query.projectId as string;
    const rel = String(req.query.path || '');
    if (!projectId || !rel) { res.status(400).json({ error: 'projectId and path are required' }); return; }
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) { res.status(404).json({ error: 'project not found' }); return; }
    const abs = resolveProjectRelativePath(projectRoot, rel);
    // Only ever serve images out of .uix/ (refs + per-screen candidates live there).
    if (!abs || !abs.startsWith(path.join(projectRoot, '.uix') + path.sep) || !fsSync.existsSync(abs)) {
      res.status(404).json({ error: 'image not found' }); return;
    }
    try {
      const ext = path.extname(abs).toLowerCase();
      res.setHeader('Content-Type', ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png');
      res.end(await fs.readFile(abs));
    } catch { res.status(500).json({ error: 'failed to read image' }); }
  });

  // GET /api/ai/runs?projectId= — list recent runs (newest first).
  app.get('/api/ai/runs', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    res.json({ runs: await listRuns(projectId) });
  });

  // GET /api/ai/runs/:runId/preflight?projectId= — P4 (RFC §4.3): the deterministic
  // token/cost pre-flight gate (NO LLM). Resolve the concrete model + real window,
  // estimate text+vision tokens per screen, project the cumulative shared-session
  // transcript, best/expected/worst cost, and a block/warn/ok verdict. Shown at
  // HITL Checkpoint 1 BEFORE the run is started.
  app.get('/api/ai/runs/:runId/preflight', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const run = await getRun(projectId, req.params.runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    try {
      res.json({ preflight: computePreflight(run) });
    } catch (e: any) {
      res.status(500).json({ error: `preflight failed: ${e?.message || 'unknown'}` });
    }
  });

  // GET /api/ai/runs/:runId?projectId= — one run.
  app.get('/api/ai/runs/:runId', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const run = await getRun(projectId, req.params.runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({ run });
  });
}
