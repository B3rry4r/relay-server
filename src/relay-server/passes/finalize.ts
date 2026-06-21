// =============================================================================
// File: src/relay-server/passes/finalize.ts
//
// Phase 7 — FINALIZE orchestrator. Runs the six already-built production-readiness
// passes IN ORDER over an already-built app, framework-agnostic (each pass detects
// the framework internally):
//
//   1. extractComponents       (7a) — de-duplicate widgets → shared components
//   2. applyModalOverlays      (7b) — routed modals → true overlays + triggers
//   3. repointAssetUsage       (7c) — Material-icon / raw-path → resources symbols
//   4. verifyFlowWiring        (7d) — verify + safe auto-fix the canonical flow
//   5. renameSemantic          (7e) — machine names → semantic file/class/route
//   6. deepenTokensAndCleanup  (7f) — token deepening + dead-code cleanup
//
// BUILD-SAFE ORCHESTRATION (critical): each pass mutates real source. A pass that
// leaves the app un-buildable (or throws mid-write) would crash the preview / the
// shipped app. So finalize:
//   - snapshots the app's source dir (flutter: lib/ + test/) to a temp backup
//     BEFORE the sequence;
//   - establishes a baseline build-check (flutter: `flutter analyze` issue count);
//   - after EACH pass, re-runs the build-check. If the pass threw, OR analyze got
//     WORSE than baseline, OR `flutter build web` fails, the pass's delta is
//     RESTORED from the pre-pass snapshot, the pass is recorded `reverted` with the
//     error, and the sequence CONTINUES with the next pass (never aborts, never
//     leaves the app broken);
//   - re-snapshots after each SUCCESSFUL pass so the next pass's rollback is precise.
//
// Non-flutter / no-lib projects: the build-check degrades gracefully (no analyzer
// → passes still run, rollback only fires on a thrown pass). The six passes are
// individually idempotent, so finalize is idempotent: a second run is a near no-op.
//
// This module ONLY orchestrates — it never reimplements pass internals.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AIModel } from '../ai-adapters';
import { getFlutterRoot } from '../runtime';

import { extractComponents } from './component-extraction';
import { applyModalOverlays } from './modal-overlay';
import { repointAssetUsage } from './asset-usage';
import { verifyFlowWiring } from './flow-wiring';
import { renameSemantic } from './semantic-rename';
import { deepenTokensAndCleanup, detectFramework, type Framework } from './token-cleanup';

// ── Public contract ──────────────────────────────────────────────────────────

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

/** Canonical pass identifiers used by `onlyPasses`. */
export type PassName =
  | 'extractComponents'
  | 'applyModalOverlays'
  | 'repointAssetUsage'
  | 'verifyFlowWiring'
  | 'renameSemantic'
  | 'deepenTokensAndCleanup';

export interface FinalizeOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model injected into every pass (for their AI seams). */
  model?: AIModel;
  /** Env for the model runner / build commands. */
  env?: NodeJS.ProcessEnv;
  /** Injected model runner (passes need the real adapter). Same shape as routes. */
  runModel?: RunModelFn;
  /** Report what WOULD change; do not write. Forwarded to every pass. Default false. */
  dryRun?: boolean;
  /** Restrict to a subset of passes (by PassName). When set, others are 'skipped'. */
  onlyPasses?: string[];
  /** Streaming log callback. Receives one line at a time (no trailing newline). */
  log?: (msg: string) => void;
  /** Skip writing the finalize report (testing). Default false. */
  noReport?: boolean;
  /** Override the build-safety check entirely (testing): force "always OK". When
   *  true, no analyze/build is run and only THROWING passes are reverted. */
  skipBuildCheck?: boolean;
}

export type PassStatus = 'applied' | 'skipped' | 'reverted';

export interface PassReport {
  name: PassName;
  status: PassStatus;
  /** Pass-specific counts (what it changed). */
  counts: Record<string, number>;
  /** Warnings surfaced by the pass (or the orchestrator). */
  warnings: string[];
  /** Present when status === 'reverted'. */
  error?: string;
}

export interface FinalizeReport {
  version: 1;
  projectId: string;
  framework: Framework;
  generatedAt: string;
  dryRun: boolean;
  passes: PassReport[];
  /** Analyzer issue count before the sequence (null when not flutter / skipped). */
  baselineAnalyze: number | null;
  /** Analyzer issue count after the sequence (null when not flutter / skipped). */
  finalAnalyze: number | null;
  /** Path the report was written to (null when noReport / write failed). */
  reportPath: string | null;
}

// ── Pass registry (order is load-bearing) ─────────────────────────────────────

interface PassDef {
  name: PassName;
  /** Run the pass with the shared finalize opts; return counts + warnings. */
  run: (projectId: string, opts: FinalizeOptions) => Promise<{ counts: Record<string, number>; warnings: string[] }>;
}

/** Adapt the shared finalize RunModelFn into each pass's identically-shaped seam. */
function passRunModel(opts: FinalizeOptions): RunModelFn | undefined {
  return opts.runModel;
}

/** noAi for a pass: true when there is no model OR no runModel to drive it. */
function noAi(opts: FinalizeOptions): boolean {
  return !opts.model || !opts.runModel;
}

const PASSES: PassDef[] = [
  {
    name: 'extractComponents',
    run: async (projectId, opts) => {
      const r = await extractComponents(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        // extract-components uses `noAiConfirm` (not `noAi`).
        noAiConfirm: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      return {
        counts: { extracted: r.extracted.length, rejected: r.rejected.length },
        warnings: r.rejected.map((x) => `rejected ${x.names.join('/')}: ${x.reason}`),
      };
    },
  },
  {
    name: 'applyModalOverlays',
    run: async (projectId, opts) => {
      const r = await applyModalOverlays(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      return {
        counts: { transformed: r.transformed.length, skipped: r.skipped.length },
        warnings: r.skipped.map((s) => `${s.name}: ${s.reason}`),
      };
    },
  },
  {
    name: 'repointAssetUsage',
    run: async (projectId, opts) => {
      const r = await repointAssetUsage(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      return {
        counts: { repointed: r.repointed.length, skipped: r.skipped.length },
        warnings: [...r.warnings, ...r.skipped.map((s) => `${s.file}: ${s.what} — ${s.reason}`)],
      };
    },
  },
  {
    name: 'verifyFlowWiring',
    run: async (projectId, opts) => {
      const r = await verifyFlowWiring(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      const s = r.report.summary;
      return {
        counts: {
          totalEdges: s.totalEdges,
          wired: s.wired,
          autoFixesApplied: r.autoFixesApplied,
          wrongTarget: s.wrongTarget,
          missing: s.missing,
          deadTrigger: s.deadTrigger,
          unmapped: s.unmapped,
        },
        warnings: r.report.findings
          .filter((f) => f.status === 'wrong-target' || f.status === 'missing' || f.status === 'unmapped')
          .map((f) => `${f.from}→${f.to} [${f.status}]: ${f.detail}`),
      };
    },
  },
  {
    name: 'renameSemantic',
    run: async (projectId, opts) => {
      const r = await renameSemantic(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      const s = r.report.summary;
      return {
        counts: { renamed: s.renamed, skipped: s.skipped, filesTouched: s.filesTouched },
        warnings: r.report.skipped.map((sk) => `${sk.canonicalId}: ${sk.reason}`),
      };
    },
  },
  {
    name: 'deepenTokensAndCleanup',
    run: async (projectId, opts) => {
      const r = await deepenTokensAndCleanup(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts),
      });
      const sub = r.report.substitutions;
      const rem = r.report.removals;
      return {
        counts: {
          colors: sub.colors,
          textStyles: sub.textStyles,
          spacing: sub.spacing,
          radius: sub.radius,
          removedImports: rem.imports,
          removedConsts: rem.consts,
          removedClasses: rem.methods,
        },
        warnings: r.report.rejected.map((rej) => `${rej.file}: ${rej.kind} ${rej.literal} — ${rej.reason}`),
      };
    },
  },
];

const ALL_PASS_NAMES = new Set<string>(PASSES.map((p) => p.name));

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function finalizeApp(projectId: string, opts: FinalizeOptions): Promise<FinalizeReport> {
  const { projectRoot } = opts;
  const log = opts.log ?? (() => { /* no-op */ });
  const framework = await detectFramework(projectRoot);

  log(`[finalize] start — project ${projectId}, framework ${framework}${opts.dryRun ? ' (dry-run)' : ''}`);

  // Validate onlyPasses (warn on unknown names rather than silently ignore).
  if (opts.onlyPasses) {
    for (const n of opts.onlyPasses) {
      if (!ALL_PASS_NAMES.has(n)) log(`[finalize] WARNING: unknown pass in onlyPasses ignored: ${n}`);
    }
  }
  const want = (name: PassName): boolean => !opts.onlyPasses || opts.onlyPasses.includes(name);

  // Build-safety setup. Only flutter (with a lib/) gets the analyze/build gate; any
  // other shape degrades to "thrown-pass-only rollback" (skipBuildCheck behaviour).
  const sourceDirs = sourceDirsFor(framework, projectRoot);
  const buildCheckable =
    !opts.dryRun &&
    !opts.skipBuildCheck &&
    framework === 'flutter' &&
    fsSync.existsSync(path.join(projectRoot, 'lib'));

  // Baseline analyze (best-effort). On a non-buildable project this is null and the
  // gate uses thrown-pass detection only.
  let baselineAnalyze: number | null = null;
  if (buildCheckable) {
    baselineAnalyze = await flutterAnalyzeCount(projectRoot, opts.env);
    log(`[finalize] baseline analyze: ${baselineAnalyze ?? 'n/a'} issue(s)`);
  } else if (!opts.dryRun) {
    log(`[finalize] build-check disabled (framework=${framework}, lib/=${fsSync.existsSync(path.join(projectRoot, 'lib'))}) — only a THROWING pass is rolled back`);
  }

  // Pre-sequence snapshot. We snapshot once; after each successful pass we re-snapshot
  // so a later pass's rollback restores only THAT pass's delta (not earlier passes').
  let snapshot: Snapshot | null = null;
  if (!opts.dryRun && sourceDirs.length) {
    try {
      snapshot = await takeSnapshot(sourceDirs);
      log(`[finalize] snapshot: ${snapshot.fileCount} file(s) across ${sourceDirs.map((d) => path.relative(projectRoot, d) || '.').join(', ')}`);
    } catch (e) {
      log(`[finalize] WARNING: could not snapshot source (rollback disabled for this run): ${(e as Error).message}`);
      snapshot = null;
    }
  }

  // The analyze count we measure against AFTER a pass — it tracks the LAST good
  // state (baseline, then each successful pass's post-count). A pass is judged
  // against this, not the original baseline, so a pass that improves analyze raises
  // the bar for the next one only if it's actually better.
  let lastGoodAnalyze = baselineAnalyze;

  const passReports: PassReport[] = [];

  for (const def of PASSES) {
    if (!want(def.name)) {
      passReports.push({ name: def.name, status: 'skipped', counts: {}, warnings: ['not in onlyPasses'] });
      log(`[finalize] ${def.name}: skipped (not in onlyPasses)`);
      continue;
    }

    log(`[finalize] ${def.name}: running…`);
    let counts: Record<string, number> = {};
    let warnings: string[] = [];
    let threw: Error | null = null;
    try {
      const out = await def.run(projectId, opts);
      counts = out.counts;
      warnings = out.warnings;
    } catch (e) {
      threw = e as Error;
    }

    // dry-run never writes → never needs a rollback; just record.
    if (opts.dryRun) {
      if (threw) {
        passReports.push({ name: def.name, status: 'reverted', counts: {}, warnings, error: threw.message });
        log(`[finalize] ${def.name}: ERROR (dry-run, nothing written): ${threw.message}`);
      } else {
        passReports.push({ name: def.name, status: 'applied', counts, warnings });
        log(`[finalize] ${def.name}: ${summarizeCounts(counts)} (dry-run)`);
      }
      continue;
    }

    // Decide pass/fail. A throw ALWAYS fails (and may have partially written).
    let failure: string | null = threw ? `threw: ${threw.message}` : null;

    // Build-safety gate (only when buildable & the pass didn't already throw).
    if (!failure && buildCheckable) {
      const after = await flutterAnalyzeCount(projectRoot, opts.env);
      if (after != null && lastGoodAnalyze != null && after > lastGoodAnalyze) {
        failure = `flutter analyze regressed (${lastGoodAnalyze} → ${after} issues)`;
      } else {
        const built = await flutterBuildWebOk(projectRoot, opts.env);
        if (!built.ok) failure = `flutter build web failed: ${built.error}`;
        else {
          // Pass is good: advance the bar to this pass's analyze count.
          lastGoodAnalyze = after ?? lastGoodAnalyze;
        }
      }
    }

    if (!failure) {
      passReports.push({ name: def.name, status: 'applied', counts, warnings });
      log(`[finalize] ${def.name}: applied — ${summarizeCounts(counts)}`);
      // Re-snapshot so the NEXT pass rolls back only its own delta.
      if (snapshot && sourceDirs.length) {
        try { snapshot = await takeSnapshot(sourceDirs); }
        catch (e) { log(`[finalize] WARNING: re-snapshot after ${def.name} failed (rollback may be imprecise): ${(e as Error).message}`); }
      }
      continue;
    }

    // FAILURE → restore this pass's delta from the pre-pass snapshot, then continue.
    let restored = false;
    if (snapshot && sourceDirs.length) {
      try {
        await restoreSnapshot(snapshot, sourceDirs);
        restored = true;
      } catch (e) {
        log(`[finalize] CRITICAL: rollback of ${def.name} FAILED: ${(e as Error).message}`);
      }
    }
    passReports.push({
      name: def.name,
      status: 'reverted',
      counts: {},
      warnings,
      error: failure + (restored ? ' (reverted)' : snapshot ? ' (rollback FAILED)' : ' (no snapshot to revert)'),
    });
    log(`[finalize] ${def.name}: REVERTED — ${failure}${restored ? ' (rolled back)' : ''}`);
    // lastGoodAnalyze is unchanged — the restore returns the tree to the last good
    // state, so the next pass is measured from the same bar.
  }

  // Final analyze (best-effort; reflects the net of applied+reverted passes).
  let finalAnalyze: number | null = null;
  if (buildCheckable) {
    finalAnalyze = await flutterAnalyzeCount(projectRoot, opts.env);
    log(`[finalize] final analyze: ${finalAnalyze ?? 'n/a'} issue(s) (baseline ${baselineAnalyze ?? 'n/a'})`);
  }

  const applied = passReports.filter((p) => p.status === 'applied').length;
  const reverted = passReports.filter((p) => p.status === 'reverted').length;
  const skipped = passReports.filter((p) => p.status === 'skipped').length;
  log(`[finalize] done — ${applied} applied, ${reverted} reverted, ${skipped} skipped`);

  const report: FinalizeReport = {
    version: 1,
    projectId,
    framework,
    generatedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    passes: passReports,
    baselineAnalyze,
    finalAnalyze,
    reportPath: null,
  };

  if (!opts.noReport) {
    try {
      const abs = path.join(projectRoot, '.uix', 'finalize-report.json');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');
      report.reportPath = abs;
    } catch (e) {
      log(`[finalize] WARNING: could not write finalize-report.json: ${(e as Error).message}`);
    }
  }

  return report;
}

// ── Source-dir resolution ─────────────────────────────────────────────────────

/** The source directories a finalize run may mutate, per framework. We snapshot
 *  exactly these so rollback restores the full delta of any pass. */
function sourceDirsFor(framework: Framework, projectRoot: string): string[] {
  const dirs: string[] = [];
  if (framework === 'flutter') {
    for (const d of ['lib', 'test']) {
      const abs = path.join(projectRoot, d);
      if (fsSync.existsSync(abs)) dirs.push(abs);
    }
  } else if (framework === 'react') {
    const abs = path.join(projectRoot, 'src');
    if (fsSync.existsSync(abs)) dirs.push(abs);
  }
  return dirs;
}

// ── Snapshot / restore (precise rollback) ─────────────────────────────────────

interface Snapshot {
  /** absolute file path → file content (utf8). Only text files are tracked. */
  files: Map<string, Buffer>;
  /** the set of dirs the snapshot covers (so restore can delete created files). */
  roots: string[];
  fileCount: number;
}

async function listFilesRec(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await walk(dir);
  return out;
}

/** Capture the full byte content of every file under the given source dirs. */
async function takeSnapshot(dirs: string[]): Promise<Snapshot> {
  const files = new Map<string, Buffer>();
  for (const dir of dirs) {
    for (const f of await listFilesRec(dir)) {
      files.set(f, await fs.readFile(f));
    }
  }
  return { files, roots: [...dirs], fileCount: files.size };
}

/**
 * Restore the source dirs to EXACTLY the snapshot state:
 *  - files that changed are overwritten with the snapshot bytes,
 *  - files CREATED since the snapshot are deleted,
 *  - files DELETED since the snapshot (e.g. a renamed/moved screen) are recreated.
 * This makes rollback complete even when a pass partially wrote then threw, or
 * moved files (semantic-rename).
 */
async function restoreSnapshot(snap: Snapshot, dirs: string[]): Promise<void> {
  // 1) Delete files that exist now but were NOT in the snapshot (created by the pass).
  const current = new Set<string>();
  for (const dir of dirs) for (const f of await listFilesRec(dir)) current.add(f);
  for (const f of current) {
    if (!snap.files.has(f)) {
      try { await fs.rm(f, { force: true }); } catch { /* best-effort */ }
    }
  }
  // 2) Re-write / recreate every snapshot file with its original bytes.
  for (const [f, buf] of snap.files) {
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, buf);
    } catch { /* best-effort; reported by caller via try/catch around restore */ }
  }
}

// ── Build-safety checks (flutter) ─────────────────────────────────────────────

/** Run `flutter analyze` and return the issue count (null if flutter unavailable). */
async function flutterAnalyzeCount(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<number | null> {
  const flutter = flutterBin();
  if (!flutter) return null;
  const raw = await runCmd(flutter, ['analyze', '--no-pub'], projectRoot, env).catch(() => null);
  if (raw == null) return null;
  const summ = /(\d+)\s+issues?\s+found/.exec(raw);
  if (summ) return Number(summ[1]);
  // "No issues found!" → 0. Otherwise count diagnostic lines.
  if (/no issues found/i.test(raw)) return 0;
  const diagRe = /^\s*(error|warning|info)\s+•/gm;
  return (raw.match(diagRe) || []).length;
}

/** Run `flutter build web` and report whether it succeeded. */
async function flutterBuildWebOk(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; error?: string }> {
  const flutter = flutterBin();
  if (!flutter) return { ok: true }; // can't verify → don't block (analyze already gated).
  // Ensure a web/ dir exists so build web doesn't fail spuriously on a fresh project.
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

/** Absolute path to the flutter binary, or null if the SDK is not present. */
function flutterBin(): string | null {
  try {
    const bin = path.join(getFlutterRoot(), 'bin', 'flutter');
    return fsSync.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a command and resolve its combined stdout+stderr. `flutter analyze` exits
 * non-zero when issues exist (not a failure for counting), so by default a non-zero
 * exit still RESOLVES. When `rejectOnNonZero` is set (build web), a non-zero exit
 * REJECTS so the caller treats it as a failed build.
 */
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

// ── small utils ────────────────────────────────────────────────────────────────

function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : 'no changes';
}

// Test-only surface for the build-safe rollback primitives (snapshot/restore +
// source-dir resolution). Exported so the precise-rollback contract can be unit-
// tested without a live server / Flutter SDK. Not part of the runtime API.
export const __test = { takeSnapshot, restoreSnapshot, sourceDirsFor };
