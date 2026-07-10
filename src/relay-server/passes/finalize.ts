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
//   7. auditInteractions       (7g) — flag controls that render but do nothing
//   8. productionHygiene       (7h) — strip verify scaffolding → clean deliverable
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

import { extractComponents, type ExtractGroupGuard } from './component-extraction';
import { applyModalOverlays } from './modal-overlay';
import { repointAssetUsage } from './asset-usage';
import { verifyFlowWiring } from './flow-wiring';
import { auditInteractions } from './interaction-audit';
import { runProductionHygiene } from './production-hygiene';
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
  | 'deepenTokensAndCleanup'
  | 'auditInteractions'
  | 'productionHygiene';

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
  /** Analyzer ERROR count before the sequence — the verify harness's real error
   *  budget (assert finalErrors ≤ baselineErrors = 0 NEW errors). Null = not flutter. */
  baselineErrors: number | null;
  /** Analyzer ERROR count after the sequence (null when not flutter / skipped). */
  finalErrors: number | null;
  /** Path the report was written to (null when noReport / write failed). */
  reportPath: string | null;
}

// ── Pass registry (order is load-bearing) ─────────────────────────────────────

interface PassDef {
  name: PassName;
  /** Run the pass with the shared finalize opts; return counts + warnings. The
   *  `proof` collector is swapped in per pass to tally AI firing. `ctx` carries
   *  orchestrator capabilities a pass may opt into (e.g. the per-group build guard
   *  for extractComponents — T32). */
  run: (projectId: string, opts: FinalizeOptions, proof: AiProofCollector, ctx: PassRunCtx) => Promise<{ counts: Record<string, number>; warnings: string[] }>;
}

/** Orchestrator-provided capabilities a pass may use during a real run. */
interface PassRunCtx {
  /** Build the per-group build-safety guard for component extraction (T32), or
   *  null when this run cannot build-gate (dry-run / no git / not flutter). */
  makeExtractGroupGuard: () => ExtractGroupGuard | null;
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
    run: async (projectId, opts, proof, ctx) => {
      const r = await extractComponents(projectId, {
        projectRoot: opts.projectRoot,
        model: opts.model,
        // extract-components uses `noAiConfirm` (not `noAi`).
        noAiConfirm: noAi(opts),
        dryRun: opts.dryRun,
        env: opts.env,
        runModel: passRunModel(opts, proof, 'extractComponents'),
        // T32: per-group build safety. One code-gen-unsafe merge is reverted in
        // isolation; the safe groups still apply (no all-or-nothing revert).
        perGroupGuard: ctx.makeExtractGroupGuard() ?? undefined,
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
          wrongVerb: s.wrongVerb,
          tabAsPush: s.tabAsPush,
          missingStepPresenter: s.missingStepPresenter,
          missing: s.missing,
          deadTrigger: s.deadTrigger,
          unmapped: s.unmapped,
        },
        warnings: r.report.findings
          .filter((f) => f.status === 'wrong-target' || f.status === 'missing' || f.status === 'unmapped'
            || f.status === 'wrong-verb' || f.status === 'tab-as-push' || f.status === 'missing-step-presenter')
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
  {
    name: 'auditInteractions',
    run: async (projectId, opts) => {
      // Report-only: it never mutates source, so it is not build-gated. The loop
      // requeues HIGH findings to needs-review (planInteractionRequeue) so the
      // build agent wires the real behaviour — a dead control is not something a
      // deterministic pass can safely guess.
      const r = await auditInteractions(projectId, {
        projectRoot: opts.projectRoot,
        noReport: opts.dryRun,
      });
      const s = r.report.summary;
      return {
        counts: { total: s.total, high: s.high, med: s.med, screensAffected: s.screensAffected },
        warnings: r.report.findings
          .filter((f) => f.severity === 'high')
          .map((f) => `${f.file}:${f.line} — dead ${f.handler} on "${f.element ?? '<unlabelled>'}" (${f.kind})`),
      };
    },
  },
  {
    name: 'productionHygiene',
    run: async (_projectId, opts) => {
      const r = await runProductionHygiene({ projectRoot: opts.projectRoot, dryRun: opts.dryRun });
      return {
        counts: {
          previewRoutesRemoved: r.previewRoutesRemoved,
          previewFilesRemoved: r.previewFilesRemoved,
          placeholderRemoved: r.placeholderRemoved ? 1 : 0,
          unreferencedAssets: r.unreferencedAssets,
        },
        warnings: r.warnings,
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
  const isWeb = framework === 'react' || framework === 'next';
  const buildCheckable =
    !opts.dryRun &&
    !opts.skipBuildCheck &&
    ((framework === 'flutter' && fsSync.existsSync(path.join(projectRoot, 'lib')))
      // 7b/7c REWRITE web sources (dead routes, asset symbols). Without a gate here a
      // broken pass shipped silently, since only a THROWN pass was ever rolled back.
      || (isWeb && fsSync.existsSync(path.join(projectRoot, 'package.json'))));

  // Baseline analyze (best-effort). On a non-buildable project this is null and the
  // gate uses thrown-pass detection only.
  let baselineAnalyze: number | null = null;
  let baselineErrors: number | null = null;
  if (buildCheckable) {
    const a = await analyzeErrorsFor(framework, projectRoot, opts.env);
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
    if (!gitReady) log(`[finalize] WARNING: git unavailable — destructive passes will be REFUSED (no rollback point)`);
  }

  // T11 fix #4 — REFUSE destructive passes with no rollback. Every finalize pass
  // mutates real source IRREVERSIBLY (extract/move/rename/cleanup). When this is a
  // real (non-dry) run over a project WITH source dirs but git is unavailable, there
  // is no snapshot to roll back to — so, matching asset-phase, we do NOT mutate.
  // Each pass is recorded `reverted` with a loud reason instead of running. (Dry-run
  // never writes, and a no-source project has nothing to protect, so both still run.)
  const passReports: PassReport[] = [];
  const refuseNoGit = !opts.dryRun && sourceDirs.length > 0 && !gitReady;
  if (refuseNoGit) {
    const reason = 'git unavailable — REFUSING destructive finalize passes without a rollback snapshot (RFC §9; never mutate source irreversibly without a recovery point)';
    log(`[finalize] ABORT passes — ${reason}`);
    for (const def of PASSES) {
      passReports.push({
        name: def.name,
        status: 'reverted',
        counts: {},
        warnings: [],
        error: reason,
      });
    }
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

  for (const def of PASSES) {
    if (refuseNoGit) break;   // T11 #4 — refused above; do not mutate without rollback.
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

    // Per-pass context. T32: a per-group build guard for extractComponents — built
    // only when this run can actually build-gate (buildCheckable + git ready). It
    // snapshots/restores via git and build-checks against the CURRENT error budget
    // (`lastGoodErrors` at the moment this pass starts), so one bad group reverts in
    // isolation while safe groups persist. Captured by value below.
    const budgetAtPassStart = lastGoodErrors;
    const ctx: PassRunCtx = {
      makeExtractGroupGuard: (): ExtractGroupGuard | null => {
        if (!buildCheckable || !gitReady) return null;
        return {
          snapshot: () => snapshotBeforeMutation(projectRoot, `${def.name} group (P8 per-group)`, vc),
          restore: (token: string) => rollbackTo(projectRoot, token, vc),
          buildOk: async () => {
            const a = await analyzeErrorsFor(framework, projectRoot, opts.env);
            const afterErrors = a?.errors ?? null;
            if (afterErrors != null && budgetAtPassStart != null && afterErrors > budgetAtPassStart) {
              return { ok: false, reason: `analyze errors ${budgetAtPassStart} → ${afterErrors}` };
            }
            const built = await buildOkFor(framework, projectRoot, opts.env);
            return built.ok ? { ok: true } : { ok: false, reason: `build failed: ${built.error}` };
          },
        };
      },
    };

    try {
      const out = await def.run(projectId, opts, proof, ctx);
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
      const a = await analyzeErrorsFor(framework, projectRoot, opts.env);
      const afterErrors = a?.errors ?? null;
      if (afterErrors != null && lastGoodErrors != null && afterErrors > lastGoodErrors) {
        failure = `${framework} typecheck errors regressed (${lastGoodErrors} → ${afterErrors} error(s))`;
      } else {
        const built = await buildOkFor(framework, projectRoot, opts.env);
        if (!built.ok) failure = `${framework} build failed: ${built.error}`;
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
  let finalErrors: number | null = null;
  if (buildCheckable) {
    const fa = await analyzeErrorsFor(framework, projectRoot, opts.env);
    finalAnalyze = fa?.total ?? null;
    finalErrors = fa?.errors ?? null;
    log(`[finalize] final analyze: ${finalAnalyze ?? 'n/a'} issue(s), ${finalErrors ?? 'n/a'} error(s) (baseline ${baselineAnalyze ?? 'n/a'} issue(s), ${baselineErrors ?? 'n/a'} error(s))`);
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
    baselineErrors,
    finalErrors,
    reportPath: null,
  };

  // A dry run must not persist a report. `.uix/finalize-report.json` is the marker
  // the P7 gate skips on and the record of what the app contains — a dry run wrote
  // over the real one with a report describing a build that was never applied.
  if (!opts.noReport && !opts.dryRun) {
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
  } else if (framework === 'react' || framework === 'next') {
    for (const d of ['src', 'app', 'pages', 'components']) {
      const abs = path.join(projectRoot, d);
      if (fsSync.existsSync(abs)) dirs.push(abs);
    }
  }
  return dirs;
}

// ── Build-safety checks (framework-agnostic seam) ────────────────────────────

/** ERROR count for the framework. Flutter: `flutter analyze`. Web: `tsc --noEmit`
 *  diagnostics. Null when the toolchain is unavailable → the gate degrades to
 *  build-only, never to silently-pass. */
async function analyzeErrorsFor(
  framework: Framework, projectRoot: string, env?: NodeJS.ProcessEnv,
): Promise<{ total: number; errors: number } | null> {
  if (framework === 'flutter') {
    const a = await flutterAnalyze(projectRoot, env);
    return a ? { total: a.total, errors: a.errors } : null;
  }
  if (framework === 'react' || framework === 'next') return tscErrors(projectRoot, env);
  return null;
}

async function buildOkFor(
  framework: Framework, projectRoot: string, env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; error?: string }> {
  if (framework === 'flutter') return flutterBuildWebOk(projectRoot, env);
  if (framework === 'react' || framework === 'next') return webBuildOk(projectRoot, env);
  return { ok: true };
}

/** `tsc --noEmit` error count. A generated app has a plain tsconfig (no project
 *  references), so this really does typecheck the sources. */
async function tscErrors(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ total: number; errors: number } | null> {
  if (!fsSync.existsSync(path.join(projectRoot, 'tsconfig.json'))) return null;
  // runCmd resolves with combined output on a non-zero exit, which is exactly what
  // tsc does when it finds errors. A spawn failure (no npx) must degrade to null —
  // returning 0 there would report a clean typecheck that never ran.
  const raw = await runCmd('npx', ['tsc', '--noEmit', '--pretty', 'false'], projectRoot, env).catch(() => null);
  if (raw == null) return null;
  const errors = (raw.match(/^\S.*\berror TS\d+:/gm) ?? []).length;
  return { total: errors, errors };
}

/** The project's real build. `npm run build` when the script exists — the only
 *  check that catches what `tsc --noEmit` cannot (bundler resolution, missing
 *  imports behind path aliases). */
async function webBuildOk(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; error?: string }> {
  let hasBuild = false;
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    hasBuild = !!pkg.scripts?.build;
  } catch { return { ok: true }; }
  if (!hasBuild) return { ok: true };
  if (!fsSync.existsSync(path.join(projectRoot, 'node_modules'))) return { ok: true }; // deps not installed → can't verify, don't block
  try {
    await runCmd('npm', ['run', 'build'], projectRoot, env, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 400) };
  }
}

// ── Build-safety checks (flutter) ─────────────────────────────────────────────

/** Run `flutter analyze` and return BOTH the total issue count (for the report)
 *  and the ERROR count (the gate keys on errors, not total — see the gate), plus
 *  the raw `error •` lines (the analyze-gate repair prompt lists them). Null
 *  when flutter is unavailable. Mirrors asset-phase.flutterAnalyze. */
async function flutterAnalyze(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<{ total: number; errors: number; errorLines: string[] } | null> {
  const flutter = flutterBin();
  if (!flutter) return null;
  const raw = await runCmd(flutter, ['analyze', '--no-pub'], projectRoot, env).catch(() => null);
  if (raw == null) return null;
  const errorLines = (raw.match(/^\s*error\s+•.*$/gm) || []).map((l) => l.trim());
  const errors = errorLines.length;
  if (/no issues found/i.test(raw)) return { total: 0, errors: 0, errorLines: [] };
  const summ = /(\d+)\s+issues?\s+found/.exec(raw);
  if (summ) return { total: Number(summ[1]), errors, errorLines };
  const total = (raw.match(/^\s*(error|warning|info)\s+•/gm) || []).length;
  return { total, errors, errorLines };
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

// ── P3: ANALYZE GATE — analyzer ERRORS gate run completion ─────────────────────
// The Ping run finalized and logged `complete — 35/35 built` while flutter analyze
// reported 17 ERRORS (finalize only *measured* baseline/final analyze and moved
// on). The gate makes analyzer ERRORS (never warnings/infos) a completion blocker:
// after finalize, if the final analyze reports >0 errors, run ONE bounded AI
// repair attempt ("fix these N analyzer errors, change nothing else") through the
// same runModel plumbing finalize already has, re-analyze, and if errors remain
// the caller parks the run `needs-review` (finalized stays false) instead of
// logging complete. Opt-out for emergencies: env RELAY_ANALYZE_GATE=off|0|false,
// or per-run `analyzeGate: false`. Default ON.

export interface AnalyzeGateResult {
  /** Error count AFTER any repair attempt (null = unmeasurable → gate passes). */
  errors: number | null;
  /** Error count when the gate started (before the repair attempt). */
  initialErrors: number | null;
  /** True when the single bounded AI repair call was made. */
  repairAttempted: boolean;
  /** True when the gate passes: 0 errors, or unmeasurable (never block blind). */
  ok: boolean;
}

/** Gate on/off switch. Default ON; env RELAY_ANALYZE_GATE=off|0|false or a run
 *  flag `analyzeGate === false` disables it (emergency escape hatch). */
export function analyzeGateEnabled(run?: { analyzeGate?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RELAY_ANALYZE_GATE ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (run && run.analyzeGate === false) return false;
  return true;
}

/**
 * Measure analyzer ERRORS and, when >0 and a model is available, make ONE bounded
 * repair attempt then re-measure. Warnings/infos never gate. When the live
 * analyzer is unavailable (no flutter SDK / non-flutter project) the measurement
 * falls back to `initialErrors` (the finalize report's persisted finalErrors);
 * when NOTHING is measurable the gate passes — it never blocks blind.
 * `analyze` is an injection seam for tests; production uses flutterAnalyze.
 */
export async function runAnalyzeGate(opts: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  model?: AIModel;
  runModel?: RunModelFn;
  log?: (msg: string) => void;
  /** Persisted finalErrors from the finalize report — the fallback measurement
   *  when the live analyzer is unavailable. */
  initialErrors?: number | null;
  analyze?: (projectRoot: string, env?: NodeJS.ProcessEnv) => Promise<{ total: number; errors: number; errorLines: string[] } | null>;
}): Promise<AnalyzeGateResult> {
  const log = opts.log ?? (() => { /* no-op */ });
  const analyze = opts.analyze ?? flutterAnalyze;

  const a = await analyze(opts.projectRoot, opts.env).catch(() => null);
  const initialErrors = a?.errors ?? opts.initialErrors ?? null;
  let errorLines = a?.errorLines ?? [];

  if (initialErrors == null) {
    log(`[finalize] analyze gate: analyzer unavailable — gate passes (cannot measure)`);
    return { errors: null, initialErrors: null, repairAttempted: false, ok: true };
  }
  if (initialErrors === 0) {
    return { errors: 0, initialErrors: 0, repairAttempted: false, ok: true };
  }

  // >0 errors. ONE bounded repair attempt when a model + runner are available;
  // skip gracefully (straight to the verdict) when not.
  let errors: number | null = initialErrors;
  let repairAttempted = false;
  if (opts.model && opts.runModel) {
    repairAttempted = true;
    log(`[finalize] analyze gate: ${initialErrors} analyzer error(s) — one bounded AI repair attempt (model=${opts.model})`);
    const listed = errorLines.slice(0, 40);
    const prompt = [
      `The Flutter project in the current directory has ${initialErrors} analyzer ERROR(S) (run \`flutter analyze\` to see them).`,
      `Fix these ${initialErrors} analyzer errors, change nothing else — no refactors, no style changes, no new features. Warnings/infos are out of scope.`,
      ...(listed.length ? [`The errors:`, ...listed.map((l) => `  ${l}`)] : []),
      `When done, output a one-line summary of what you fixed.`,
    ].join('\n');
    try {
      await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    } catch (e) {
      log(`[finalize] analyze gate: repair attempt failed (non-fatal): ${(e as Error).message}`);
    }
    const b = await analyze(opts.projectRoot, opts.env).catch(() => null);
    // Unmeasurable after a repair → keep the initial count (conservative: still
    // parked; a later resume with a working analyzer re-measures).
    errors = b?.errors ?? errors;
    log(`[finalize] analyze gate: post-repair analyze — ${b ? `${b.errors} error(s)` : 'unavailable (keeping pre-repair count)'}`);
  } else {
    log(`[finalize] analyze gate: ${initialErrors} analyzer error(s), no model/runner — skipping repair attempt`);
  }

  return { errors, initialErrors, repairAttempted, ok: errors === 0 };
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
