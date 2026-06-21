// =============================================================================
// File: src/relay-server/passes/asset-phase.ts
//
// PHASE-2 ASSET PHASE for ALREADY-BUILT apps (the resolve path).
//
// The generation path runs the asset pass per-frame at build time (localize →
// semantic-rename → emit resources → re-point). The RESOLVE path (resolve-app, for
// an app whose screens are already emitted as code — e.g. Ping) historically went
// straight from canonical-resolve → finalize and DROPPED this asset phase: the
// on-disk assets keep their opaque Figma names, there is no resources file, and the
// six P7 passes' repoint silently no-ops (no asset-map). This module closes that
// gap by running the asset pass over the EXISTING on-disk assets.
//
// THE KEY HAZARD — ATOMICITY. runAssetPass RENAMES the asset files on disk to
// semantic names. The instant it does, every existing `'assets/icons/<old>.svg'`
// reference in lib/ points at a missing file and the build is BROKEN until
// repointAssetUsage rewrites those references. So the rename + the re-point are ONE
// atomic, build-safe unit — they CANNOT be two independently build-checked steps
// (the first would "regress" and be reverted before the second runs). We therefore:
//   1. snapshot lib/ + assets/ (full bytes) + pubspec.yaml,
//   2. capture a baseline `flutter analyze` count,
//   3. run rename + emit-resources + asset-map + repoint (no build check between),
//   4. ONE build check: `flutter analyze` ≤ baseline AND `flutter build web` ok,
//   5. on ANY failure (or a thrown step) restore EVERYTHING (lib + assets + pubspec)
//      and delete the emitted resources file + asset-map.json — never leave broken.
//
// IDEMPOTENT: a second run (assets already semantic, refs already AppAssets, map
// present) renames nothing new and re-points nothing — a near no-op, build green.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AIModel } from '../ai-adapters';
import { getFlutterRoot } from '../runtime';
import { gatherExistingAssets, runAssetPass } from '../reference-render';
import { repointAssetUsage } from './asset-usage';
import { detectFramework, type Framework } from './token-cleanup';
import { ensureProjectGit, snapshotBeforeMutation, rollbackTo, commitCheckpoint } from '../version-control';

// ── Public contract ──────────────────────────────────────────────────────────

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface AssetPhaseOptions {
  /** Resolved absolute project root (the built app, e.g. /workspace/projects/Ping). */
  projectRoot: string;
  /** AI model for the semantic-rename + icon-match seams. Optional (falls back to hints). */
  model?: AIModel;
  /** Injected model runner (relay's runModel adapted to the {text} seam). */
  runModel?: RunModelFn;
  /** Env for the model runner / flutter commands. */
  env?: NodeJS.ProcessEnv;
  /** Report what WOULD happen without leaving a net mutation. Default false. */
  dryRun?: boolean;
  /** Streaming log callback (one line, no trailing newline). */
  log?: (msg: string) => void;
  /** Override the build-safety check entirely (testing): no analyze/build is run and
   *  only a THROWING step triggers rollback. Default false. */
  skipBuildCheck?: boolean;
}

export type AssetPhaseStatus = 'applied' | 'skipped' | 'reverted' | 'dry-run';

export interface AssetPhaseReport {
  status: AssetPhaseStatus;
  framework: Framework;
  /** present when skipped. */
  reason?: string;
  /** present when reverted. */
  error?: string;
  /** assets discovered on disk (the input). */
  gathered: number;
  /** unique-by-content representatives kept after dedup (the AI-named set). */
  unique: number;
  /** redundant byte-identical duplicate files deleted from disk. */
  duplicatesDeleted: number;
  /** files renamed to semantic names (runAssetPass). */
  renamed: number;
  /** of `renamed`, how many were harness-repaired rasters (always 0 here — gathered
   *  assets are not re-rasterized). */
  repaired: number;
  /** project-relative path of the emitted resources file (null if none / reverted). */
  resourcesPath: string | null;
  /** project-relative path of the asset-map (null if none / reverted). */
  assetMapPath: string | null;
  /** re-points applied by repointAssetUsage (raw-path + material-icon). */
  repointed: number;
  /** usages deliberately skipped by the re-point pass. */
  repointSkipped: number;
  /** warnings surfaced by the re-point pass. */
  warnings: string[];
  /** `flutter analyze` issue count before / after (null when not buildable). */
  baselineAnalyze: number | null;
  finalAnalyze: number | null;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

const FLUTTER_RESOURCES_REL = 'lib/resources/app_assets.dart';
const ASSET_MAP_REL = '.uix/asset-map.json';

export async function runAssetPhaseOnBuild(
  projectId: string,
  opts: AssetPhaseOptions,
): Promise<AssetPhaseReport> {
  const { projectRoot } = opts;
  const log = opts.log ?? (() => { /* no-op */ });
  const env = opts.env ?? process.env;
  const framework = await detectFramework(projectRoot);

  const base: AssetPhaseReport = {
    status: 'skipped', framework, gathered: 0, unique: 0, duplicatesDeleted: 0,
    renamed: 0, repaired: 0,
    resourcesPath: null, assetMapPath: null, repointed: 0, repointSkipped: 0,
    warnings: [], baselineAnalyze: null, finalAnalyze: null,
  };

  log(`[asset-phase] start — project ${projectId}, framework ${framework}${opts.dryRun ? ' (dry-run)' : ''}`);

  // 1. Gather existing on-disk assets. No assets → nothing to do.
  const gathered = await gatherExistingAssets(projectRoot, framework);
  base.gathered = gathered.length;
  if (gathered.length === 0) {
    log('[asset-phase] no on-disk assets found — skipped');
    return { ...base, status: 'skipped', reason: 'no on-disk assets' };
  }
  log(`[asset-phase] gathered ${gathered.length} on-disk asset(s)`);

  const resourcesAbs = path.join(projectRoot, FLUTTER_RESOURCES_REL);
  const assetMapAbs = path.join(projectRoot, ASSET_MAP_REL);

  // IDEMPOTENCE GUARD. The asset pass (semantic-rename) is NOT itself idempotent:
  // re-running it over already-semantic files re-derives names with a fresh
  // collision counter, churning `visibility_off.svg` → `visibility_off_5.svg` and
  // breaking the AppAssets paths that already point at the first run's names. The
  // build-safe rollback would catch that and revert — correct, but a REVERT is not
  // the "near no-op" idempotence demands. So before mutating, detect an ALREADY-
  // APPLIED state: a valid asset-map + a resources file, every mapped newPath on
  // disk. When applied, run ONLY the (idempotent) re-point — it sees refs already
  // pointing at AppAssets and changes nothing — and report a clean no-op.
  if (!opts.dryRun && await alreadyApplied(projectRoot, resourcesAbs, assetMapAbs)) {
    log('[asset-phase] already applied (asset-map + resources present, paths resolve) — skipping rename, idempotent no-op');
    return { ...base, status: 'skipped', reason: 'already applied (idempotent no-op)' };
  }

  // Build-safety: only flutter with a lib/ gets the analyze/build gate.
  const buildCheckable =
    !opts.skipBuildCheck &&
    framework === 'flutter' &&
    fsSync.existsSync(path.join(projectRoot, 'lib'));

  // VERSION-CONTROL SNAPSHOT (RFC §9.3/§9.4) — replaces the /tmp byte-snapshot.
  // This pass is the SHARPEST hazard: runAssetPass DELETES dedup duplicates and
  // MOVES files on semantic-rename, breaking every existing reference until repoint
  // fixes it. The git snapshot-before + rollback (reset --hard + clean -fd) restores
  // ALL deleted/moved files AND removes pass-created artifacts (the resources file +
  // .uix/asset-map.json are untracked-then-created, so `clean -fd` removes them on
  // revert — no special-casing needed). .git lives under the project (persistent),
  // so this survives a redeploy; /tmp did not. Without a snapshot we cannot guarantee
  // rollback, so we refuse to mutate (the hazard is too sharp).
  const vc = { log, env };
  await ensureProjectGit(projectRoot, vc);
  const gitReady = fsSync.existsSync(path.join(projectRoot, '.git'));
  if (!gitReady) {
    const error = 'git unavailable — refusing to run the destructive asset pass without a rollback snapshot (RFC §9; /tmp is not an acceptable fallback)';
    log(`[asset-phase] ABORT — ${error}`);
    return { ...base, status: 'reverted', error };
  }
  const preSha = await snapshotBeforeMutation(projectRoot, 'asset-phase (rename+dedup+repoint)', vc);
  if (!preSha) {
    const error = 'could not establish a git snapshot baseline (refusing to mutate without rollback)';
    log(`[asset-phase] ABORT — ${error}`);
    return { ...base, status: 'reverted', error };
  }
  log(`[asset-phase] git snapshot baseline ${preSha.slice(0, 8)} — rollback restores all deleted/moved/created files`);
  // Track which artifacts existed before (for accurate reporting on revert).
  const resourcesExistedBefore = fsSync.existsSync(resourcesAbs);
  const assetMapExistedBefore = fsSync.existsSync(assetMapAbs);

  // Baseline analyze (best-effort). We track BOTH the total issue count (for the
  // report) and the ERROR count (the gate). See the gate below for why errors, not
  // total, decide pass/fail.
  let baselineAnalyze: number | null = null;
  let baselineErrors: number | null = null;
  if (buildCheckable) {
    const a = await flutterAnalyze(projectRoot, env);
    baselineAnalyze = a?.total ?? null;
    baselineErrors = a?.errors ?? null;
    log(`[asset-phase] baseline analyze: ${baselineAnalyze ?? 'n/a'} issue(s), ${baselineErrors ?? 'n/a'} error(s)`);
  }
  base.baselineAnalyze = baselineAnalyze;

  // Restore helper — git rollback to the pre-mutation snapshot. `reset --hard` reverts
  // every modified/deleted/moved tracked file (lib/, assets/, pubspec.yaml) to the
  // baseline, and `clean -fd` removes everything the pass CREATED (the renamed asset
  // files that are now duplicates of restored originals, the resources file, and
  // .uix/asset-map.json when they didn't exist before). One primitive restores the
  // whole atomic unit — no per-artifact bookkeeping.
  const rollback = async (): Promise<void> => {
    await rollbackTo(projectRoot, preSha, vc);
  };

  // EXPLICIT no-AI when no model/runner is provided (allowed, surfaced as a
  // degraded hint-only rename — NOT a silent swallow). When a model IS provided,
  // the semantic rename is AI-REQUIRED: renameAssetsSemantic THROWS on a no-fire
  // / unusable result, which propagates to the catch below → the whole atomic
  // unit is rolled back and the phase reports `reverted` with the error (the
  // loud-fail surface; no garbage resources file survives).
  const noAi = !opts.model || !opts.runModel;
  const model = (opts.model ?? ('claude' as AIModel));

  // Run the ATOMIC unit: rename + emit-resources + asset-map + repoint. No build
  // check between — the intermediate state (renamed files, stale refs) is broken BY
  // DESIGN; the single check after both steps is the only meaningful gate.
  let renamed = 0;
  let repaired = 0;
  let unique = 0;
  let duplicatesDeleted = 0;
  let resourcesPath: string | null = null;
  let repointed = 0;
  let repointSkipped = 0;
  const warnings: string[] = [];
  let threw: Error | null = null;

  try {
    log(`[asset-phase] runAssetPass: content-dedup + semantic-rename${noAi ? ' (DEGRADED: no-AI, hint names)' : ' (AI-required)'} + emit resources + asset-map…`);
    const ap = await runAssetPass(projectId, framework, gathered, model, env, { noAi });
    if (ap) {
      renamed = ap.renamed;
      repaired = ap.repaired;
      unique = ap.unique;
      duplicatesDeleted = ap.duplicatesDeleted;
      resourcesPath = ap.resourcesPath;
    }
    log(`[asset-phase] runAssetPass: gathered=${base.gathered} unique-by-content=${unique} renamed=${renamed} duplicatesDeleted=${duplicatesDeleted}, resources=${resourcesPath ?? 'none'}`);

    log('[asset-phase] repointAssetUsage: rewrite code refs → AppAssets symbols…');
    const rp = await repointAssetUsage(projectId, {
      projectRoot,
      model: opts.model,
      noAi,
      dryRun: false,
      env,
      runModel: opts.runModel,
    });
    repointed = rp.repointed.length;
    repointSkipped = rp.skipped.length;
    warnings.push(...rp.warnings);
    log(`[asset-phase] repointAssetUsage: repointed=${repointed}, skipped=${repointSkipped}`);
  } catch (e) {
    threw = e as Error;
    log(`[asset-phase] ERROR during rename+repoint: ${threw.message}`);
  }

  base.renamed = renamed;
  base.repaired = repaired;
  base.unique = unique;
  base.duplicatesDeleted = duplicatesDeleted;
  base.resourcesPath = resourcesPath;
  base.assetMapPath = fsSync.existsSync(assetMapAbs) ? ASSET_MAP_REL : null;
  base.repointed = repointed;
  base.repointSkipped = repointSkipped;
  base.warnings = warnings;

  // ── Single build check (the whole atomic unit) ──────────────────────────────
  // GATE: (a) the analyze ERROR count must not rise, AND (b) `flutter build web`
  // must succeed. We deliberately gate on ERRORS, not the total issue count: the
  // re-point pass legitimately perturbs cosmetic LINTS (an `info`
  // prefer_const_constructors shift, or — for a raw-path swap that lands inside an
  // already-`SvgPicture.asset()` call — a benign `unused_import` warning it inserts).
  // Reverting a perfectly BUILDABLE app over a style lint would defeat the entire
  // purpose of the phase. Errors + a real `flutter build web` are the true
  // breakage signal; the total count is tracked for the report only.
  let failure: string | null = threw ? `threw: ${threw.message}` : null;
  let finalAnalyze: number | null = null;
  let finalErrors: number | null = null;
  if (!failure && buildCheckable) {
    const a = await flutterAnalyze(projectRoot, env);
    finalAnalyze = a?.total ?? null;
    finalErrors = a?.errors ?? null;
    if (finalErrors != null && baselineErrors != null && finalErrors > baselineErrors) {
      failure = `flutter analyze errors regressed (${baselineErrors} → ${finalErrors} error(s))`;
    } else {
      const built = await flutterBuildWebOk(projectRoot, env);
      if (!built.ok) failure = `flutter build web failed: ${built.error}`;
    }
  }
  base.finalAnalyze = finalAnalyze;

  // ── dry-run: always restore (report would-be counts, leave no net change) ────
  if (opts.dryRun) {
    await rollback();
    log(`[asset-phase] dry-run — restored snapshot; would-be renamed=${renamed}, repointed=${repointed}`);
    return { ...base, status: 'dry-run', finalAnalyze: baselineAnalyze };
  }

  // ── failure → roll EVERYTHING back ──────────────────────────────────────────
  if (failure) {
    await rollback();
    const after = buildCheckable ? (await flutterAnalyze(projectRoot, env))?.total ?? null : baselineAnalyze;
    log(`[asset-phase] REVERTED — ${failure} (rolled back; analyze now ${after ?? 'n/a'})`);
    return {
      ...base,
      status: 'reverted',
      error: failure,
      // restored: resources/map removed if created here.
      resourcesPath: resourcesExistedBefore ? base.resourcesPath : null,
      assetMapPath: assetMapExistedBefore ? base.assetMapPath : null,
      finalAnalyze: after,
    };
  }

  // ── success ─────────────────────────────────────────────────────────────────
  // Commit the applied asset pass as a durable checkpoint (RFC §9.2) — the renamed
  // files + resources + asset-map are now history, recoverable from any later pass.
  await commitCheckpoint(projectRoot, 'phase assets applied', `renamed=${renamed}, deduped=${duplicatesDeleted}, repointed=${repointed}`, vc);
  log(`[asset-phase] applied — renamed=${renamed}, repointed=${repointed}, analyze ${baselineAnalyze ?? 'n/a'} → ${finalAnalyze ?? 'n/a'}`);
  return { ...base, status: 'applied', finalAnalyze };
}

// ── idempotence detection ──────────────────────────────────────────────────────

/**
 * True when the asset phase has ALREADY run successfully against this tree: a
 * resources file exists, a non-empty asset-map exists, and EVERY mapped `newPath`
 * resolves to a real file on disk (i.e. the rename landed and was not reverted).
 * In that state a re-run must NOT rename again (it would churn names). Best-effort:
 * any read/parse failure → treat as NOT-applied (fall through to a normal run).
 */
async function alreadyApplied(projectRoot: string, resourcesAbs: string, assetMapAbs: string): Promise<boolean> {
  if (!fsSync.existsSync(resourcesAbs) || !fsSync.existsSync(assetMapAbs)) return false;
  try {
    const map = JSON.parse(await fs.readFile(assetMapAbs, 'utf8')) as {
      assets?: Array<{ newPath?: string }>;
    };
    const assets = Array.isArray(map.assets) ? map.assets : [];
    if (assets.length === 0) return false;
    for (const a of assets) {
      if (!a.newPath) return false;
      if (!fsSync.existsSync(path.join(projectRoot, a.newPath))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Build-safety checks (flutter) — mirror finalize.ts's local helpers ─────────

/** Run `flutter analyze` once and return BOTH the total issue count and the ERROR
 *  count (null when flutter is unavailable). The gate keys off `errors`; `total`
 *  is for reporting (mirrors finalize.ts's count parsing, extended for errors). */
async function flutterAnalyze(
  projectRoot: string, env?: NodeJS.ProcessEnv,
): Promise<{ total: number; errors: number } | null> {
  const flutter = flutterBin();
  if (!flutter) return null;
  const raw = await runCmd(flutter, ['analyze', '--no-pub'], projectRoot, env).catch(() => null);
  if (raw == null) return null;
  const errors = (raw.match(/^\s*error\s+•/gm) || []).length;
  if (/no issues found/i.test(raw)) return { total: 0, errors: 0 };
  const summ = /(\d+)\s+issues?\s+found/.exec(raw);
  if (summ) return { total: Number(summ[1]), errors };
  const total = (raw.match(/^\s*(error|warning|info)\s+•/gm) || []).length;
  return { total, errors };
}

async function flutterBuildWebOk(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; error?: string }> {
  const flutter = flutterBin();
  if (!flutter) return { ok: true };
  if (!fsSync.existsSync(path.join(projectRoot, 'web'))) {
    await runCmd(flutter, ['create', '--platforms=web', '.'], projectRoot, env).catch(() => '');
  }
  try {
    await runCmd(flutter, ['build', 'web', '-t', 'lib/main.dart'], projectRoot, env, true);
    const ok = fsSync.existsSync(path.join(projectRoot, 'build', 'web', 'index.html'));
    return ok ? { ok: true } : { ok: false, error: 'no web output produced' };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e).slice(-400) };
  }
}

function flutterBin(): string | null {
  try {
    const bin = path.join(getFlutterRoot(), 'bin', 'flutter');
    return fsSync.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function runCmd(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, rejectOnNonZero = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (rejectOnNonZero && code !== 0) reject(new Error(out.slice(-400) || `exit ${code}`));
      else resolve(out);
    });
  });
}
