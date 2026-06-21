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
import { runModelObserved } from '../ai-observability';

import { extractComponents } from './component-extraction';
import { applyModalOverlays } from './modal-overlay';
import { repointAssetUsage } from './asset-usage';
import { verifyFlowWiring } from './flow-wiring';
import { renameSemantic } from './semantic-rename';
import { deepenTokensAndCleanup, detectFramework, type Framework } from './token-cleanup';
import { ensureProjectGit, snapshotBeforeMutation, rollbackTo, commitCheckpoint } from '../version-control';

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

/** Per-pass AI-firing proof (RFC §0.2: "AI firing is observable"). Records whether
 *  the pass actually invoked the model, how many times, and the first call's proof
 *  (id + token estimate). `fired:false` with `available:true` means the pass ran
 *  but its AI seam wasn't needed (deterministic path covered everything) — a
 *  legitimate, surfaced "no AI required". `available:false` means no model/runner
 *  was injected (degraded mode). */
export interface PassAiProof {
  /** A model + runner were injected (the pass COULD fire AI). */
  available: boolean;
  /** The pass actually invoked the model at least once. */
  fired: boolean;
  /** Number of model invocations the pass made during this run. */
  calls: number;
  /** How many of those returned usable output (status=ok). */
  okCalls: number;
  /** First call's proof for the report (id + ≈tokens + ms), when any fired. */
  firstCall?: { callId: string; tokens: number; durMs: number; status: 'ok' | 'empty' | 'error' };
}

export interface PassReport {
  name: PassName;
  status: PassStatus;
  /** Pass-specific counts (what it changed). */
  counts: Record<string, number>;
  /** Warnings surfaced by the pass (or the orchestrator). */
  warnings: string[];
  /** Present when status === 'reverted'. */
  error?: string;
  /** AI-firing proof for this pass (RFC §0.2). */
  aiProof?: PassAiProof;
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
  /** Run the pass with the shared finalize opts; return counts + warnings. The
   *  `proof` collector is swapped in per pass to tally AI firing. */
  run: (projectId: string, opts: FinalizeOptions, proof: AiProofCollector) => Promise<{ counts: Record<string, number>; warnings: string[] }>;
}

/** A mutable collector the orchestrator swaps in PER PASS so the wrapped runner
 *  records AI-firing proof for exactly that pass. */
interface AiProofCollector {
  available: boolean;
  calls: number;
  okCalls: number;
  firstCall?: PassAiProof['firstCall'];
}

/**
 * Adapt the shared finalize RunModelFn into each pass's identically-shaped seam,
 * routing every call through `runModelObserved` so (a) the standard `[ai:…]`
 * structured line is logged (RFC §0.2 — provable firing) and (b) the per-pass
 * collector tallies invocations + captures the first call's proof. The pass sees
 * the same `{text}` contract; observability is transparent to it.
 */
function passRunModel(opts: FinalizeOptions, proof: AiProofCollector, passName: PassName): RunModelFn | undefined {
  if (!opts.runModel || !opts.model) return undefined;
  return async (model, prompt, env, cwd, o) => {
    proof.calls++;
    const res = await runModelObserved(model, prompt, env, cwd, {
      format: o?.format,
      runner: async (m, p, e, c, ro) => {
        // Delegate to the injected adapter; map its richer shape to RunModelLike.
        const out = await opts.runModel!(m, p, e, c, { format: ro?.format });
        return { text: out.text };
      },
      log: { step: passName },
    });
    if (res.ok) {
      proof.okCalls++;
      if (!proof.firstCall) proof.firstCall = { callId: res.callId, tokens: res.tokens, durMs: res.durMs, status: 'ok' };
      return { text: res.text };
    }
    if (!proof.firstCall) proof.firstCall = { callId: res.callId, tokens: res.tokens, durMs: res.durMs, status: res.reason === 'empty' ? 'empty' : 'error' };
    // Preserve the pass's existing error-handling contract: a non-ok observed
    // result throws so the pass's own try/catch degrades exactly as before (and
    // the failure is already LOGGED by runModelObserved — never silent).
    throw new Error(`[ai:${passName}] model ${model} did not fire (${res.reason})${res.error ? ': ' + res.error.slice(0, 120) : ''}`);
  };
}

/** noAi for a pass: true when there is no model OR no runModel to drive it. */
function noAi(opts: FinalizeOptions): boolean {
  return !opts.model || !opts.runModel;
}

const PASSES: PassDef[] = [
  {
    name: 'extractComponents',
    run: async (projectId, opts, proof) => {
      const r = await extractComponents(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        // extract-components uses `noAiConfirm` (not `noAi`).
        noAiConfirm: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'extractComponents'),
      });
      return {
        counts: { extracted: r.extracted.length, rejected: r.rejected.length },
        warnings: r.rejected.map((x) => `rejected ${x.names.join('/')}: ${x.reason}`),
      };
    },
  },
  {
    name: 'applyModalOverlays',
    run: async (projectId, opts, proof) => {
      const r = await applyModalOverlays(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'applyModalOverlays'),
      });
      return {
        counts: { transformed: r.transformed.length, skipped: r.skipped.length },
        warnings: r.skipped.map((s) => `${s.name}: ${s.reason}`),
      };
    },
  },
  {
    name: 'repointAssetUsage',
    run: async (projectId, opts, proof) => {
      const r = await repointAssetUsage(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'repointAssetUsage'),
      });
      return {
        counts: { repointed: r.repointed.length, skipped: r.skipped.length },
        warnings: [...r.warnings, ...r.skipped.map((s) => `${s.file}: ${s.what} — ${s.reason}`)],
      };
    },
  },
  {
    name: 'verifyFlowWiring',
    run: async (projectId, opts, proof) => {
      const r = await verifyFlowWiring(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'verifyFlowWiring'),
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
    run: async (projectId, opts, proof) => {
      const r = await renameSemantic(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'renameSemantic'),
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
    run: async (projectId, opts, proof) => {
      const r = await deepenTokensAndCleanup(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        noAi: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'deepenTokensAndCleanup'),
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
  let baselineErrors: number | null = null;
  if (buildCheckable) {
    const a = await flutterAnalyze(projectRoot, opts.env);
    baselineAnalyze = a?.total ?? null;
    baselineErrors = a?.errors ?? null;
    log(`[finalize] baseline analyze: ${baselineAnalyze ?? 'n/a'} issue(s), ${baselineErrors ?? 'n/a'} error(s)`);
  } else if (!opts.dryRun) {
    log(`[finalize] build-check disabled (framework=${framework}, lib/=${fsSync.existsSync(path.join(projectRoot, 'lib'))}) — only a THROWING pass is rolled back`);
  }

  // VERSION-CONTROL SNAPSHOTS (RFC §9.3): replace the fragile /tmp byte-snapshots
  // with git. .git lives UNDER the project in /workspace (persistent), so a snapshot
  // survives a redeploy — unlike /tmp, which is wiped on container restart (the
  // exact incident this guards against). We snapshot BEFORE each pass
  // (`snapshotBeforeMutation` → a committed clean baseline + the sha to roll back
  // to) and on regression/throw `rollbackTo(preSha)` restores the tree EXACTLY
  // (reset --hard + clean -fd → un-deletes deleted/moved files, removes pass-created
  // files). On success we `commitCheckpoint` so the applied pass is durable history.
  // `gitReady` gates this: if git is unavailable, every pass still runs but with NO
  // rollback (surfaced loudly by ensureProjectGit) — never a silent /tmp fallback.
  const vc = { log, env: opts.env };
  let gitReady = false;
  if (!opts.dryRun && sourceDirs.length) {
    await ensureProjectGit(projectRoot, vc);
    gitReady = fsSync.existsSync(path.join(projectRoot, '.git'));
    if (!gitReady) log(`[finalize] WARNING: git unavailable — passes run WITHOUT rollback (data safety degraded)`);
  }

  // The analyze ERROR count we measure against AFTER a pass — it tracks the LAST
  // good state (baseline, then each successful pass's post-count). A pass is judged
  // against this, not the original baseline, so a pass that fixes errors raises the
  // bar for the next one only if it's actually better. We gate on ERRORS (not total
  // issues) to match the asset phase: the production passes legitimately shuffle
  // cosmetic lints (prefer_const_constructors infos shift line-to-line as code
  // moves, unused-import warnings are pruned) — those must NOT force a revert, but a
  // real ERROR (undefined name, invalid constant, broken build) still does.
  let lastGoodErrors = baselineErrors;

  const passReports: PassReport[] = [];

  for (const def of PASSES) {
    if (!want(def.name)) {
      passReports.push({ name: def.name, status: 'skipped', counts: {}, warnings: ['not in onlyPasses'] });
      log(`[finalize] ${def.name}: skipped (not in onlyPasses)`);
      continue;
    }

    // SNAPSHOT BEFORE this pass (git). preSha is the clean baseline to roll back to
    // if the pass regresses/throws. Empty when git is unavailable → no rollback.
    let preSha = '';
    if (!opts.dryRun && gitReady) {
      preSha = await snapshotBeforeMutation(projectRoot, `${def.name} (P8 pass)`, vc);
    }

    log(`[finalize] ${def.name}: running…`);
    let counts: Record<string, number> = {};
    let warnings: string[] = [];
    let threw: Error | null = null;
    // Fresh AI-firing collector for THIS pass. `available` reflects whether a
    // model + runner were injected (the pass could fire AI at all).
    const proof: AiProofCollector = { available: !noAi(opts), calls: 0, okCalls: 0 };
    try {
      const out = await def.run(projectId, opts, proof);
      counts = out.counts;
      warnings = out.warnings;
    } catch (e) {
      threw = e as Error;
    }
    const aiProof: PassAiProof = {
      available: proof.available,
      fired: proof.calls > 0,
      calls: proof.calls,
      okCalls: proof.okCalls,
      ...(proof.firstCall ? { firstCall: proof.firstCall } : {}),
    };
    log(`[finalize] ${def.name}: ai ${aiProof.available ? (aiProof.fired ? `fired ${aiProof.okCalls}/${aiProof.calls} ok${aiProof.firstCall ? ` (call=${aiProof.firstCall.callId} ≈${aiProof.firstCall.tokens}tok)` : ''}` : 'available but not needed (deterministic path)') : 'unavailable (degraded — no model/runner)'}`);

    // dry-run never writes → never needs a rollback; just record.
    if (opts.dryRun) {
      if (threw) {
        passReports.push({ name: def.name, status: 'reverted', counts: {}, warnings, error: threw.message, aiProof });
        log(`[finalize] ${def.name}: ERROR (dry-run, nothing written): ${threw.message}`);
      } else {
        passReports.push({ name: def.name, status: 'applied', counts, warnings, aiProof });
        log(`[finalize] ${def.name}: ${summarizeCounts(counts)} (dry-run)`);
      }
      continue;
    }

    // Decide pass/fail. A throw ALWAYS fails (and may have partially written).
    let failure: string | null = threw ? `threw: ${threw.message}` : null;

    // Build-safety gate (only when buildable & the pass didn't already throw).
    // Gate on the analyze ERROR count (not total issues) AND a successful build —
    // a pass that introduces a real error or breaks the build is reverted; a pass
    // that only churns cosmetic info/warning lints is allowed (matches asset-phase).
    if (!failure && buildCheckable) {
      const a = await flutterAnalyze(projectRoot, opts.env);
      const afterErrors = a?.errors ?? null;
      if (afterErrors != null && lastGoodErrors != null && afterErrors > lastGoodErrors) {
        failure = `flutter analyze errors regressed (${lastGoodErrors} → ${afterErrors} error(s))`;
      } else {
        const built = await flutterBuildWebOk(projectRoot, opts.env);
        if (!built.ok) failure = `flutter build web failed: ${built.error}`;
        else {
          // Pass is good: advance the error bar to this pass's error count.
          lastGoodErrors = afterErrors ?? lastGoodErrors;
        }
      }
    }

    if (!failure) {
      passReports.push({ name: def.name, status: 'applied', counts, warnings, aiProof });
      log(`[finalize] ${def.name}: applied — ${summarizeCounts(counts)}`);
      // Commit the applied pass as a durable checkpoint (RFC §9.2). This both
      // records history AND establishes the clean baseline the NEXT pass's
      // snapshotBeforeMutation will return — so a later pass rolls back only its own
      // delta, not earlier applied passes'.
      if (gitReady) {
        await commitCheckpoint(projectRoot, `${def.name} applied`, summarizeCounts(counts), vc);
      }
      continue;
    }

    // FAILURE → restore the tree EXACTLY to the pre-pass snapshot via git
    // (reset --hard + clean -fd): un-deletes files the pass deleted/moved, reverts
    // modifications, removes files the pass created. Then continue with the next pass.
    let restored = false;
    if (gitReady && preSha) {
      await rollbackTo(projectRoot, preSha, vc);
      restored = true;
    } else if (gitReady && !preSha) {
      log(`[finalize] CRITICAL: no snapshot sha for ${def.name} — cannot roll back this pass`);
    }
    passReports.push({
      name: def.name,
      status: 'reverted',
      counts: {},
      warnings,
      error: failure + (restored ? ' (reverted via git)' : gitReady ? ' (rollback FAILED — no snapshot)' : ' (no git — could not revert)'),
      aiProof,
    });
    log(`[finalize] ${def.name}: REVERTED — ${failure}${restored ? ' (rolled back via git)' : ''}`);
    // lastGoodErrors is unchanged — the rollback returns the tree to the last good
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

// ── Build-safety checks (flutter) ─────────────────────────────────────────────

/** Run `flutter analyze` and return BOTH the total issue count (for the report)
 *  and the ERROR count (the gate keys on errors, not total — see the gate). Null
 *  when flutter is unavailable. Mirrors asset-phase.flutterAnalyze. */
async function flutterAnalyze(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ total: number; errors: number } | null> {
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

/** Back-compat total-only count (used for the report fields baseline/finalAnalyze). */
async function flutterAnalyzeCount(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<number | null> {
  const a = await flutterAnalyze(projectRoot, env);
  return a?.total ?? null;
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

// Test-only surface for source-dir resolution. Exported so the resolution contract
// can be unit-tested without a live server / Flutter SDK. The build-safe rollback is
// now git-based (see ../version-control); not part of the runtime API.
export const __test = { sourceDirsFor };
