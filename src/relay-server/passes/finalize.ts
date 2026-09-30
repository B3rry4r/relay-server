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

import { parseFlutterAnalyzeOutput, flutterAnalyzeFailure, type FlutterAnalysis } from './flutter-analyze-output';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { sanitizeChildEnv } from '../auth/secrets';
import { parseJsonc } from './web-app';
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
import { deepenTokensAndCleanup } from './token-cleanup';
import { detectFramework, type Framework } from './framework';
import { measureReadability, readabilityDelta, projectReadabilityGate, type ReadabilityDeltaBlock } from '../readability';
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
  /** `applied` = the pass examined real input (its counts say how much);
   *  `skipped` = it had no input or no support for this layout — `reason` says which
   *  (never `applied` with all-zero counts: that is how a stub launders itself). */
  status: PassStatus;
  /** Why the pass was skipped. Always present when status === 'skipped'. */
  reason?: string;
  /** Pass-specific counts (what it changed). */
  counts: Record<string, number>;
  /** Warnings surfaced by the pass (or the orchestrator). */
  warnings: string[];
  /** Present when status === 'reverted'. */
  error?: string;
  /** AI-firing proof for this pass (RFC §0.2). */
  aiProof?: PassAiProof;
  /** true when the PASS itself claimed `applied` with every count zero and only the
   *  orchestrator's safety net turned it into `skipped`. A pass must say why it had
   *  nothing to do; a guarded skip is a pass that would have lied (the parity
   *  harness's fz.no-zero-applied fails on it). */
  guarded?: boolean;
  /** true when a MUTATING pass examined real input and changed nothing (F9): it is
   *  recorded `skipped` with a "no-op" reason, never `applied` — an idempotent
   *  clean re-run and a pass that fixed everything must not read the same. */
  noop?: boolean;
}

/** Readability before/after the passes (readability F9) + the warn-only screen gate (F7). */
export interface FinalizeReadability extends ReadabilityDeltaBlock {
  /** warn-only readability findings over the finished screens (never blocks). */
  gate: { status: 'ran'; screens: number; warnings: number; byCode: Record<string, number>; sample: string[] } | { status: 'skipped'; reason: string };
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
  /** What the build-safety gate could actually run. A gate that could not run says
   *  so here with a reason — it never reads as a clean typecheck (PG-37). */
  gate: FinalizeGate;
  /** Readability metrics before/after the passes + the warn-only screen gate (F7/F9). */
  readability?: FinalizeReadability;
  /** Path the report was written to (null when noReport / write failed). */
  reportPath: string | null;
}

export interface GateCheck {
  status: 'ran' | 'skipped';
  /** Why the check could not run (status 'skipped'). */
  reason?: string;
  /** The tool that ran (e.g. `typescript@5.9.3 (node_modules)`). */
  tool?: string;
}

export interface FinalizeGate {
  /** flutter: `flutter analyze`; web: the project's own `tsc --noEmit`. */
  typecheck: GateCheck;
  /** flutter: `flutter build web`; web: `npm run build`. */
  build: GateCheck;
}

// ── Pass registry (order is load-bearing) ─────────────────────────────────────

interface PassDef {
  name: PassName;
  /** The pass rewrites source (vs. a report-only audit). A mutating pass that
   *  changed nothing is recorded as a no-op skip (F9). */
  mutates: boolean;
  /** Run the pass with the shared finalize opts; return counts + warnings. The
   *  `proof` collector is swapped in per pass to tally AI firing. `ctx` carries
   *  orchestrator capabilities a pass may opt into (e.g. the per-group build guard
   *  for extractComponents — T32). */
  run: (projectId: string, opts: FinalizeOptions, proof: AiProofCollector, ctx: PassRunCtx) => Promise<PassOutcome>;
}

/** What a pass adapter hands the orchestrator. `skipped` (a reason) means the pass
 *  had no input or no support for this layout; counts always include how much input
 *  the pass examined, so `applied` is never indistinguishable from a no-op stub. */
export interface PassOutcome {
  counts: Record<string, number>;
  warnings: string[];
  skipped?: string;
  /** How many edits the pass made (or would make, in a dry run). A mutating pass
   *  reporting 0 is a no-op (F9). Undefined for report-only passes. */
  changed?: number;
}

/** Settle a pass outcome into its recorded status. Safety net: a pass that reports
 *  nothing it looked at did not "apply" anything — recording it `applied` is exactly
 *  how six stubs finalized green (PG-01). When the net (not the pass) produced the
 *  skip, `guarded` says so: the pass itself would have claimed `applied`. */
export function settlePassOutcome(out: PassOutcome): { skipReason: string | undefined; guarded: boolean; noop?: true } {
  if (out.skipped) return { skipReason: out.skipped, guarded: false };
  if (Object.values(out.counts).every((v) => !v)) {
    return { skipReason: 'examined no input — every count is zero (the pass reported nothing it looked at)', guarded: true };
  }
  // F9: a mutating pass that looked at real input and changed NOTHING did not
  // "apply" — the Ping finalize reported renameSemantic/deepenTokens `applied` with
  // zero edits while `git diff -- lib` was empty. Say what it examined instead.
  if (out.changed === 0) {
    const examined = Object.entries(out.counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
    return { skipReason: `no-op: nothing to change (already clean) — examined ${examined}`, guarded: false, noop: true };
  }
  return { skipReason: undefined, guarded: false };
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
    mutates: true,
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
        counts: { scanned: r.scanned, extracted: r.extracted.length, rejected: r.rejected.length },
        warnings: r.rejected.map((x) => `rejected ${x.names.join('/')}: ${x.reason}`),
        skipped: r.skippedReason,
        changed: r.extracted.length,
      };
    },
  },
  {
    name: 'applyModalOverlays',
    mutates: true,
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
        skipped: r.skippedReason,
        // a web modal that was only credited (already presented) wrote nothing.
        changed: r.transformed.filter((t) => t.edited !== false).length,
      };
    },
  },
  {
    name: 'repointAssetUsage',
    mutates: true,
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
        counts: { filesScanned: r.filesScanned, repointed: r.repointed.length, skipped: r.skipped.length },
        warnings: [...r.warnings, ...r.skipped.map((s) => `${s.file}: ${s.what} — ${s.reason}`)],
        skipped: r.skippedReason,
        changed: r.repointed.length,
      };
    },
  },
  {
    name: 'verifyFlowWiring',
    // Its product is the edge-by-edge report (auto-fixes are a side benefit), so a
    // run that fixed nothing still produced its verdicts.
    mutates: false,
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
        skipped: r.skippedReason,
      };
    },
  },
  {
    name: 'renameSemantic',
    mutates: true,
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
        skipped: r.skippedReason,
        changed: s.renamed,
      };
    },
  },
  {
    name: 'deepenTokensAndCleanup',
    mutates: true,
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
          filesScanned: r.report.filesScanned ?? 0,
          colors: sub.colors,
          textStyles: sub.textStyles,
          spacing: sub.spacing,
          radius: sub.radius,
          removedImports: rem.imports,
          removedConsts: rem.consts,
          removedClasses: rem.methods,
        },
        warnings: r.report.rejected.map((rej) => `${rej.file}: ${rej.kind} ${rej.literal} — ${rej.reason}`),
        skipped: r.report.skippedReason,
        changed: sub.colors + sub.textStyles + sub.spacing + sub.radius + rem.imports + rem.consts + rem.methods,
      };
    },
  },
  {
    name: 'auditInteractions',
    mutates: false,
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
        counts: { filesScanned: s.filesScanned, total: s.total, high: s.high, med: s.med, screensAffected: s.screensAffected },
        warnings: r.report.findings
          .filter((f) => f.severity === 'high')
          .map((f) => `${f.file}:${f.line} — dead ${f.handler} on "${f.element ?? '<unlabelled>'}" (${f.kind})`),
        skipped: r.skippedReason,
      };
    },
  },
  {
    name: 'productionHygiene',
    mutates: true,
    run: async (_projectId, opts) => {
      const r = await runProductionHygiene({ projectRoot: opts.projectRoot, dryRun: opts.dryRun });
      return {
        counts: {
          filesScanned: r.filesScanned,
          previewRoutesRemoved: r.previewRoutesRemoved,
          previewFilesRemoved: r.previewFilesRemoved,
          placeholderRemoved: r.placeholderRemoved ? 1 : 0,
          stubComponentsRemoved: r.stubComponentsRemoved,
          commentsStripped: r.commentsStripped,
          unreferencedAssets: r.unreferencedAssets,
        },
        warnings: r.warnings,
        skipped: r.skippedReason,
        changed: r.previewRoutesRemoved + r.previewFilesRemoved + (r.placeholderRemoved ? 1 : 0) + r.stubComponentsRemoved + r.commentsStripped,
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

  // What the gate can actually run. Every check starts `skipped` with the reason it
  // could not run, and only becomes `ran` once a real checker produced a result — a
  // checker that is missing is REPORTED, never read as a clean pass (PG-37).
  const notBuildable = opts.dryRun ? 'dry run — nothing is written, nothing to gate'
    : opts.skipBuildCheck ? 'skipBuildCheck set by the caller'
      : isWeb ? 'no package.json — not a buildable web project'
        : framework === 'flutter' ? 'no lib/ — not a buildable flutter project'
          : `no build gate for framework '${framework}'`;
  const gate: FinalizeGate = {
    typecheck: { status: 'skipped', reason: buildCheckable ? 'not measured yet' : notBuildable },
    build: { status: 'skipped', reason: buildCheckable ? 'not measured yet' : notBuildable },
  };
  const gateHook: GateHook = {
    typecheck: (c) => { if (gate.typecheck.status !== 'ran') gate.typecheck = c; },
    build: (c) => { if (gate.build.status !== 'ran') gate.build = c; },
  };

  // Baseline analyze (best-effort). On a non-buildable project this is null and the
  // gate uses thrown-pass detection only.
  let baselineAnalyze: number | null = null;
  let baselineErrors: number | null = null;
  let baselineBuildBroken = false;
  if (buildCheckable) {
    const a = await analyzeErrorsFor(framework, projectRoot, opts.env, gateHook);
    baselineAnalyze = a?.total ?? null;
    baselineErrors = a?.errors ?? null;
    log(`[finalize] baseline analyze: ${baselineAnalyze ?? 'n/a'} issue(s), ${baselineErrors ?? 'n/a'} error(s)`);
    if (gate.typecheck.status === 'skipped') {
      log(`[finalize] WARNING: ${framework} typecheck gate UNAVAILABLE — ${gate.typecheck.reason}. Passes are NOT typechecked; only a build failure or a thrown pass is rolled back.`);
    }
    // Baseline build. A build that already fails BEFORE any pass cannot judge a pass:
    // without this every pass was reverted for a failure none of them caused.
    const baseBuild = await buildOkFor(framework, projectRoot, opts.env, gateHook);
    if (baseBuild.ok === false) {
      baselineBuildBroken = true;
      gate.build = { status: 'skipped', reason: `the build already fails before any pass — build failures cannot be attributed to a pass: ${(baseBuild.error ?? '').replace(/\s+/g, ' ').slice(-240)}` };
      log(`[finalize] WARNING: baseline ${framework} build FAILS before any pass — the build gate cannot judge passes (typecheck still gates): ${gate.build.reason}`);
    } else if (baseBuild.ok === null) {
      log(`[finalize] WARNING: ${framework} build gate UNAVAILABLE — ${baseBuild.reason}`);
    }
  } else if (!opts.dryRun) {
    log(`[finalize] build-check disabled (framework=${framework}: ${notBuildable}) — only a THROWING pass is rolled back`);
  }

  // F9: readability BEFORE any pass (the metrics script, all three frameworks). The
  // report records the before/after delta, so "5 applied" with an unchanged tree is
  // visible as exactly that.
  const readabilityBefore = measureReadability(projectRoot, framework);

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
      passReports.push({ name: def.name, status: 'skipped', reason: 'not in onlyPasses', counts: {}, warnings: ['not in onlyPasses'] });
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
            const a = await analyzeErrorsFor(framework, projectRoot, opts.env, gateHook);
            const afterErrors = a?.errors ?? null;
            if (afterErrors != null && budgetAtPassStart != null && afterErrors > budgetAtPassStart) {
              return { ok: false, reason: `analyze errors ${budgetAtPassStart} → ${afterErrors}` };
            }
            if (baselineBuildBroken) return { ok: true };
            const built = await buildOkFor(framework, projectRoot, opts.env, gateHook);
            return built.ok !== false ? { ok: true } : { ok: false, reason: `build failed: ${built.error}` };
          },
        };
      },
    };

    let skipReason: string | undefined;
    let guarded = false;
    let noop = false;
    try {
      const out = await def.run(projectId, opts, proof, ctx);
      counts = out.counts;
      warnings = out.warnings;
      const settled = settlePassOutcome(def.mutates ? out : { ...out, changed: undefined });
      ({ skipReason, guarded } = settled);
      noop = !!settled.noop;
    } catch (e) {
      threw = e as Error;
    }
    const okStatus: PassStatus = skipReason ? 'skipped' : 'applied';
    const okExtra = skipReason ? { reason: skipReason, ...(guarded ? { guarded: true } : {}), ...(noop ? { noop: true } : {}) } : {};
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
        passReports.push({ name: def.name, status: okStatus, ...okExtra, counts, warnings, aiProof });
        log(`[finalize] ${def.name}: ${skipReason ? `skipped — ${skipReason}` : summarizeCounts(counts)} (dry-run)`);
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
      const a = await analyzeErrorsFor(framework, projectRoot, opts.env, gateHook);
      const afterErrors = a?.errors ?? null;
      if (afterErrors != null && lastGoodErrors != null && afterErrors > lastGoodErrors) {
        failure = `${framework} typecheck errors regressed (${lastGoodErrors} → ${afterErrors} error(s))`;
      } else {
        const built: BuildOutcome = baselineBuildBroken ? { ok: null, reason: 'baseline build already failing' } : await buildOkFor(framework, projectRoot, opts.env, gateHook);
        if (built.ok === false) failure = `${framework} build failed: ${built.error}`;
        else {
          // Pass is good: advance the error bar to this pass's error count.
          lastGoodErrors = afterErrors ?? lastGoodErrors;
        }
      }
    }

    if (!failure) {
      passReports.push({ name: def.name, status: okStatus, ...okExtra, counts, warnings, aiProof });
      log(`[finalize] ${def.name}: ${skipReason ? `skipped — ${skipReason}` : `applied — ${summarizeCounts(counts)}`}`);
      // Commit the applied pass as a durable checkpoint (RFC §9.2). This both
      // records history AND establishes the clean baseline the NEXT pass's
      // snapshotBeforeMutation will return — so a later pass rolls back only its own
      // delta, not earlier applied passes'.
      if (gitReady) {
        await commitCheckpoint(projectRoot, `${def.name} ${okStatus}`, skipReason ?? summarizeCounts(counts), vc);
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
    const fa = await analyzeErrorsFor(framework, projectRoot, opts.env, gateHook);
    finalAnalyze = fa?.total ?? null;
    finalErrors = fa?.errors ?? null;
    log(`[finalize] final analyze: ${finalAnalyze ?? 'n/a'} issue(s), ${finalErrors ?? 'n/a'} error(s) (baseline ${baselineAnalyze ?? 'n/a'} issue(s), ${baselineErrors ?? 'n/a'} error(s))`);
  }

  // F9 + F7: readability AFTER, the delta, and the warn-only screen gate.
  const readabilityAfter = opts.dryRun ? readabilityBefore : measureReadability(projectRoot, framework);
  const delta: ReadabilityDeltaBlock = opts.dryRun
    ? { ...readabilityDelta(readabilityBefore, readabilityAfter), unchanged: false, unmeasured: 'dry run — nothing was written, so there is no "after"' }
    : readabilityDelta(readabilityBefore, readabilityAfter);
  const pg = projectReadabilityGate(projectRoot, framework);
  const byCode: Record<string, number> = {};
  if (pg.ok) for (const f of pg.findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  const readability: FinalizeReadability = {
    ...delta,
    gate: pg.ok
      ? { status: 'ran', screens: pg.screens, warnings: pg.findings.length, byCode, sample: pg.findings.slice(0, 20).map((f) => `${f.file}: ${f.message}`) }
      : { status: 'skipped', reason: pg.reason },
  };
  if (delta.unmeasured) log(`[finalize] ${opts.dryRun ? '' : 'WARNING: '}readability not measured — ${delta.unmeasured}`);
  else if (delta.unchanged) log(`[finalize] readability: UNCHANGED by this finalize (${delta.after?.loc ?? '?'} LOC, magic ${delta.after?.magicNumbers ?? '?'}, figma-leak comments ${delta.after?.figmaLeakComments ?? '?'})`);
  else log(`[finalize] readability: ${Object.entries(delta.delta).map(([k, v]) => `${k} ${(delta.before as any)?.[k]}→${(delta.after as any)?.[k]}`).join(', ')}`);
  if (pg.ok && pg.findings.length) log(`[finalize] readability gate (warn-only): ${pg.findings.length} finding(s) over ${pg.screens} screen(s) — ${Object.entries(byCode).map(([k, v]) => `${k}×${v}`).join(', ')}`);

  const applied = passReports.filter((p) => p.status === 'applied').length;
  const reverted = passReports.filter((p) => p.status === 'reverted').length;
  const skipped = passReports.filter((p) => p.status === 'skipped').length;
  const noops = passReports.filter((p) => p.noop).length;
  log(`[finalize] done — ${applied} applied, ${reverted} reverted, ${skipped} skipped${noops ? ` (${noops} no-op)` : ''}`);

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
    gate,
    readability,
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

/** Reports what each gate check could actually run (first real result wins). */
interface GateHook {
  typecheck: (c: GateCheck) => void;
  build: (c: GateCheck) => void;
}

/** ERROR count for the framework. Flutter: `flutter analyze`. Web: the project's own
 *  `tsc --noEmit`. Null when the checker is unavailable → the gate degrades to
 *  build-only and the report says so (gate.typecheck.status 'skipped' + reason);
 *  it never degrades to a silent pass. */
async function analyzeErrorsFor(
  framework: Framework, projectRoot: string, env?: NodeJS.ProcessEnv, hook?: GateHook,
): Promise<{ total: number; errors: number } | null> {
  if (framework === 'flutter') {
    const a = await flutterAnalyze(projectRoot, env);
    hook?.typecheck(a ? { status: 'ran', tool: 'flutter analyze' }
      : { status: 'skipped', reason: flutterBin() ? (lastFlutterAnalyzeFailure ?? '`flutter analyze` produced no output') : `flutter SDK not found (${safeFlutterRoot()}/bin/flutter)` });
    return a ? { total: a.total, errors: a.errors } : null;
  }
  if (framework === 'react' || framework === 'next') {
    const t = await webTypecheck(projectRoot, framework, env);
    if (t.ok) {
      hook?.typecheck({ status: 'ran', tool: t.tool });
      return { total: t.errors, errors: t.errors };
    }
    hook?.typecheck({ status: 'skipped', reason: t.reason });
    return null;
  }
  return null;
}

/** Build check. `ok: null` = the build could not be run (reported with `reason`,
 *  never counted as a pass); `ok: false` = it ran and failed. */
async function buildOkFor(
  framework: Framework, projectRoot: string, env?: NodeJS.ProcessEnv, hook?: GateHook,
): Promise<BuildOutcome> {
  const r = framework === 'flutter' ? await flutterBuildWebOk(projectRoot, env)
    : (framework === 'react' || framework === 'next') ? await webBuildOk(projectRoot, env)
      : { ok: null, reason: `no build check for framework '${framework}'` } as BuildOutcome;
  hook?.build(r.ok === null ? { status: 'skipped', reason: r.reason } : { status: 'ran', tool: r.tool });
  return r;
}

export interface BuildOutcome { ok: boolean | null; error?: string; reason?: string; tool?: string }

type TypecheckOutcome =
  | { ok: true; errors: number; lines: string[]; tool: string; /** stale .next/types route files removed first */ pruned?: string[] }
  | { ok: false; reason: string };

/** The project's OWN TypeScript compiler, or null. Never `npx tsc`: in a project
 *  without a local typescript (and a production image with no global tsc) npx
 *  installs the unrelated `tsc@2` package, which prints a banner, reports zero
 *  `error TS` lines, and read as a clean typecheck that never ran (PG-37). The
 *  package name is checked, so a stray `tsc` package in node_modules is refused. */
export function resolveLocalTypescript(projectRoot: string): { tscJs: string; version: string } | null {
  const pkgPath = path.join(projectRoot, 'node_modules', 'typescript', 'package.json');
  try {
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
    if (pkg.name !== 'typescript') return null;
    const tscJs = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    return fsSync.existsSync(tscJs) ? { tscJs, version: pkg.version ?? '?' } : null;
  } catch {
    return null;
  }
}

/** The tsconfig(s) to check. A solution-style root (`"files": []` + `references`,
 *  the Vite react-ts template) typechecks NOTHING with a bare `tsc --noEmit` — exit
 *  0 over a planted error — so each referenced project is checked instead. */
export function tscProjectsFor(projectRoot: string): Array<{ config: string; composite: boolean }> {
  const root = path.join(projectRoot, 'tsconfig.json');
  const read = (file: string) => {
    try { return parseJsonc(fsSync.readFileSync(file, 'utf8')) as { files?: unknown[]; include?: unknown[]; references?: Array<{ path?: string }>; compilerOptions?: { composite?: boolean } } | null; } catch { return null; }
  };
  const cfg = read(root);
  if (!cfg) return [{ config: root, composite: false }];
  const out: Array<{ config: string; composite: boolean }> = [];
  const solutionOnly = Array.isArray(cfg.files) && cfg.files.length === 0 && !cfg.include;
  if (!solutionOnly) out.push({ config: root, composite: !!cfg.compilerOptions?.composite });
  for (const ref of cfg.references ?? []) {
    if (!ref?.path) continue;
    let file = path.resolve(projectRoot, ref.path);
    if (fsSync.existsSync(file) && fsSync.statSync(file).isDirectory()) file = path.join(file, 'tsconfig.json');
    if (!fsSync.existsSync(file)) continue;
    out.push({ config: file, composite: !!read(file)?.compilerOptions?.composite });
  }
  return out.length ? out : [{ config: root, composite: false }];
}

/** Parse `tsc --noEmit --pretty false` output. Null when the output is not a real
 *  typecheck: a non-zero exit with no `error TS` diagnostic is a checker that did not
 *  run (the tsc@2 banner, a crash, OOM, a missing binary) — never "0 errors". */
export function parseTscOutput(raw: string, exitCode: number | null): { errors: number; lines: string[] } | null {
  const lines = raw.split('\n').filter((l) => /\berror TS\d+:/.test(l)).map((l) => l.trim());
  if (exitCode === 0) return { errors: 0, lines: [] };
  if (lines.length === 0) return null;
  return { errors: lines.length, lines };
}

/** Typecheck a web project with its own compiler across every tsconfig it builds. */
export async function webTypecheck(projectRoot: string, framework: 'react' | 'next', env?: NodeJS.ProcessEnv): Promise<TypecheckOutcome> {
  if (!fsSync.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
    return { ok: false, reason: 'no tsconfig.json — nothing to typecheck' };
  }
  const ts = resolveLocalTypescript(projectRoot);
  if (!ts) {
    return {
      ok: false,
      reason: fsSync.existsSync(path.join(projectRoot, 'node_modules'))
        ? 'no typescript installed (node_modules/typescript missing) — the web typecheck gate did not run'
        : 'no typescript installed (node_modules missing — dependencies not installed) — the web typecheck gate did not run',
    };
  }
  // Next 15.5+/16 declares route types (LayoutProps, PageProps) in generated
  // .next/types; without them a pristine app fails tsc. Generate them first.
  // Older Next has no `typegen` (its CLI would read the word as a project dir), so
  // the route type files the last `next build` wrote are never regenerated: a
  // route deleted or renamed since then (7b deletes dead modal routes) leaves a
  // .next/types file importing a page that is gone. `next build` put
  // `.next/types/**/*.ts` in tsconfig's include, so the gate counted those TS2307s
  // — errors in build output no source edit can fix, which parked the run and
  // reverted every pass that ran after the deletion (B56 fix round, PG-36).
  let pruned: string[] = [];
  if (framework === 'next') {
    const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (fsSync.existsSync(nextBin) && nextHasTypegen(projectRoot)) {
      await runCmdStatus(process.execPath, [nextBin, 'typegen'], projectRoot, env, 120_000).catch(() => null);
    }
    pruned = pruneStaleNextRouteTypes(projectRoot);
  }
  let errors = 0;
  const all: string[] = [];
  for (const p of tscProjectsFor(projectRoot)) {
    const args = [ts.tscJs, '--noEmit', '--pretty', 'false', '-p', p.config];
    // Never leave a tsconfig.tsbuildinfo behind in the app (Next sets incremental).
    if (!p.composite) args.push('--incremental', 'false');
    const r = await runCmdStatus(process.execPath, args, projectRoot, env, 300_000).catch((e: Error) => ({ code: null as number | null, out: String(e?.message ?? e) }));
    const parsed = parseTscOutput(r.out, r.code);
    if (!parsed) {
      const first = r.out.split('\n').map((l) => l.trim()).find(Boolean) ?? '(no output)';
      return { ok: false, reason: `typescript@${ts.version} on ${path.relative(projectRoot, p.config)} exited ${r.code ?? 'abnormally'} without a single TS diagnostic — not a real typecheck: ${first.slice(0, 200)}` };
    }
    errors += parsed.errors;
    all.push(...parsed.lines);
  }
  return { ok: true, errors, lines: all, tool: `typescript@${ts.version} (node_modules)`, ...(pruned.length ? { pruned } : {}) };
}

/** True when the project's installed Next has `next typegen` (added in 15.5). */
export function nextHasTypegen(projectRoot: string): boolean {
  try {
    const v = String((JSON.parse(fsSync.readFileSync(path.join(projectRoot, 'node_modules', 'next', 'package.json'), 'utf8')) as { version?: string }).version ?? '');
    const [maj, min] = v.split('.').map((x) => parseInt(x, 10));
    return maj > 15 || (maj === 15 && min >= 5);
  } catch { return false; }
}

/** Remove the route type files under `.next/types` whose route module no longer
 *  exists (a page/layout/route deleted or renamed since the last `next build`).
 *  Each one is `// File: <abs source>` + `import * as entry from '<rel>/page.js'`;
 *  when neither the import nor the recorded file resolves, the type file checks a
 *  module that is gone and can only ever produce TS2307. `.next` is build output
 *  and `next build` regenerates it. Files that import nothing relative
 *  (package.json, link.d.ts, cache-life.d.ts) are left alone. Returns the removed
 *  project-relative paths. */
export function pruneStaleNextRouteTypes(projectRoot: string): string[] {
  const typesDir = path.join(projectRoot, '.next', 'types');
  const removed: string[] = [];
  const walk = (dir: string): string[] => {
    let entries: fsSync.Dirent[] = [];
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
  };
  const exists = (base: string): boolean => {
    const noJs = base.replace(/\.(?:js|jsx|mjs)$/, '');
    return [base, noJs, `${noJs}.tsx`, `${noJs}.ts`, `${noJs}.jsx`, `${noJs}.js`, `${noJs}.mdx`].some((c) => {
      try { return fsSync.statSync(c).isFile(); } catch { return false; }
    });
  };
  for (const f of walk(typesDir)) {
    let src = '';
    try { src = fsSync.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = /import\s+\*\s+as\s+entry\s+from\s+['"](\.[^'"]+)['"]/.exec(src)?.[1]
      ?? /typeof\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(src)?.[1] ?? null;
    if (!rel) continue;
    if (exists(path.resolve(path.dirname(f), rel))) continue;
    const recorded = /^\/\/\s*File:\s*(.+)$/m.exec(src)?.[1]?.trim();
    if (recorded && path.isAbsolute(recorded) && exists(recorded)) continue;
    try { fsSync.rmSync(f, { force: true }); removed.push(path.relative(projectRoot, f).split(path.sep).join('/')); } catch { /* best-effort */ }
  }
  return removed;
}

/** The project's real build. `npm run build` when the script exists — the only
 *  check that catches what `tsc --noEmit` cannot (bundler resolution, missing
 *  imports behind path aliases). It can only run with dependencies installed; a
 *  missing node_modules is reported as a build that did NOT run, never as ok. */
export async function webBuildOk(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<BuildOutcome> {
  let hasBuild = false;
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    hasBuild = !!pkg.scripts?.build;
  } catch { return { ok: null, reason: 'package.json unreadable — build gate did not run' }; }
  if (!hasBuild) return { ok: null, reason: 'package.json has no "build" script — build gate did not run' };
  if (!fsSync.existsSync(path.join(projectRoot, 'node_modules'))) {
    return { ok: null, reason: 'node_modules missing (dependencies not installed) — `npm run build` cannot run; build gate did not run' };
  }
  try {
    // A production build must run with NODE_ENV=production: a server (or test
    // runner) started with NODE_ENV=development/test leaks it into the child, and
    // `next build` then fails prerendering its own /_global-error page ("Cannot read
    // properties of null (reading 'useContext')") — a build failure no pass caused.
    await runCmd('npm', ['run', 'build'], projectRoot, { ...(env ?? process.env), NODE_ENV: 'production' }, true);
    return { ok: true, tool: 'npm run build' };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 400), tool: 'npm run build' };
  }
}

// ── Build-safety checks (flutter) ─────────────────────────────────────────────

/** Run `flutter analyze` and return BOTH the total issue count (for the report)
 *  and the ERROR count (the gate keys on errors, not total — see the gate), plus
 *  the raw `error •` lines (the analyze-gate repair prompt lists them). Null
 *  when flutter is unavailable OR its output is not an analysis (a crashed or
 *  git-refused SDK is never "0 issues" — parseFlutterAnalyzeOutput); the reason is
 *  kept in `lastFlutterAnalyzeFailure` for the gate report. */
let lastFlutterAnalyzeFailure: string | null = null;
async function flutterAnalyze(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<FlutterAnalysis | null> {
  lastFlutterAnalyzeFailure = null;
  const flutter = flutterBin();
  if (!flutter) return null;
  const raw = await runCmd(flutter, ['analyze', '--no-pub'], projectRoot, env).catch((e: Error) => { lastFlutterAnalyzeFailure = String(e?.message ?? e).slice(0, 200); return null; });
  if (raw == null) return null;
  const a = parseFlutterAnalyzeOutput(raw);
  if (!a) lastFlutterAnalyzeFailure = `\`flutter analyze\` printed no analysis (no summary, no issue line) — not a real check: ${flutterAnalyzeFailure(raw)}`;
  return a;
}

/** Back-compat total-only count (used for the report fields baseline/finalAnalyze). */
async function flutterAnalyzeCount(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<number | null> {
  const a = await flutterAnalyze(projectRoot, env);
  return a?.total ?? null;
}

/** Run `flutter build web` and report whether it succeeded. */
async function flutterBuildWebOk(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<BuildOutcome> {
  const flutter = flutterBin();
  // can't verify → don't block, but REPORT that the build did not run.
  if (!flutter) return { ok: null, reason: `flutter SDK not found (${safeFlutterRoot()}/bin/flutter) — build gate did not run` };
  // Ensure a web/ dir exists so build web doesn't fail spuriously on a fresh project.
  await ensureFlutterWebDir(flutter, projectRoot, env);
  try {
    await runCmd(flutter, ['build', 'web', '-t', 'lib/main.dart'], projectRoot, env, true);
    const ok = fsSync.existsSync(path.join(projectRoot, 'build', 'web', 'index.html'));
    return ok ? { ok: true, tool: 'flutter build web' } : { ok: false, error: 'no web output produced', tool: 'flutter build web' };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e).slice(-400), tool: 'flutter build web' };
  }
}

/** Add ONLY `web/` to a project that lacks it. `flutter create --platforms=web .`
 *  in the project also scaffolds test/widget_test.dart (importing flutter_test and
 *  a `MyApp` that does not exist), README.md, analysis_options.yaml — 17 analyzer
 *  errors the typecheck gate then blamed on whichever pass ran next, reverting all
 *  of them. Scaffold into a temp dir and copy `web/` across instead. */
async function ensureFlutterWebDir(flutter: string, projectRoot: string, env?: NodeJS.ProcessEnv): Promise<void> {
  if (fsSync.existsSync(path.join(projectRoot, 'web'))) return;
  let name = 'app';
  try {
    const m = /^name:\s*([a-z_][a-z0-9_]*)\s*$/m.exec(fsSync.readFileSync(path.join(projectRoot, 'pubspec.yaml'), 'utf8'));
    if (m) name = m[1];
  } catch { /* default name */ }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-flutter-web-'));
  try {
    const scaffold = path.join(tmp, name);
    await runCmd(flutter, ['create', '--platforms=web', '--project-name', name, scaffold], tmp, env).catch(() => '');
    if (fsSync.existsSync(path.join(scaffold, 'web'))) {
      await fs.cp(path.join(scaffold, 'web'), path.join(projectRoot, 'web'), { recursive: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function safeFlutterRoot(): string {
  try { return getFlutterRoot(); } catch { return '<flutter root unresolved>'; }
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
    const p = spawn(cmd, args, { cwd, env: sanitizeChildEnv(env ?? process.env) });
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

/** Spawn and resolve `{code, out}` (combined output) whatever the exit status —
 *  the caller needs the exit code to tell "found errors" from "did not run". */
function runCmdStatus(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 0): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: sanitizeChildEnv(env ?? process.env) });
    let out = '';
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) timer = setTimeout(() => { out += `\n[timeout after ${timeoutMs}ms]`; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out }); });
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
  /** The framework whose checker the gate measured with. */
  framework?: Framework;
  /** The checker (`flutter analyze`, `typescript@5.x (node_modules)`), when it ran. */
  tool?: string;
  /** Set when the gate could not re-measure after a repair and therefore did not
   *  park the run on a stale count — the caller records this reason in the run. */
  unmeasured?: string;
}

/** Gate on/off switch. Default ON; env RELAY_ANALYZE_GATE=off|0|false or a run
 *  flag `analyzeGate === false` disables it (emergency escape hatch). */
export function analyzeGateEnabled(run?: { analyzeGate?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RELAY_ANALYZE_GATE ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (run && run.analyzeGate === false) return false;
  return true;
}

type GateMeasure = { total: number; errors: number; errorLines: string[]; tool?: string } | null;

/** The framework's own ERROR measure: flutter → `flutter analyze`; react/next → the
 *  project's own `tsc --noEmit` over every tsconfig it builds (PG-36). Null when the
 *  checker cannot run (reason in `why`). */
async function measureErrorsFor(framework: Framework, projectRoot: string, env?: NodeJS.ProcessEnv, why?: (r: string) => void): Promise<GateMeasure> {
  if (framework === 'react' || framework === 'next') {
    const t = await webTypecheck(projectRoot, framework, env);
    if (!t.ok) { why?.(t.reason); return null; }
    return { total: t.errors, errors: t.errors, errorLines: t.lines, tool: t.tool };
  }
  const a = await flutterAnalyze(projectRoot, env);
  if (!a) why?.(flutterBin() ? (lastFlutterAnalyzeFailure ?? '`flutter analyze` produced no output') : `flutter SDK not found (${safeFlutterRoot()}/bin/flutter)`);
  return a ? { ...a, tool: 'flutter analyze' } : null;
}

/** The repair prompt, in the idiom of the framework's checker. */
function gateRepairPrompt(framework: Framework, n: number, lines: string[], projectRoot: string): string {
  const web = framework === 'react' || framework === 'next';
  // The exact check the gate runs: a solution-style root tsconfig (Vite react-ts)
  // checks NOTHING with `-p .`, so name every project it builds.
  const cmd = web
    ? tscProjectsFor(projectRoot).map((p) => `node_modules/.bin/tsc --noEmit -p ${path.relative(projectRoot, p.config) || 'tsconfig.json'}`).join(' && ')
    : '';
  const head = web
    ? `The ${framework === 'next' ? 'Next.js' : 'React (Vite)'} TypeScript project in the current directory has ${n} TypeScript ERROR(S) (run the project's own compiler, \`${cmd}\`, to see them).`
    : `The Flutter project in the current directory has ${n} analyzer ERROR(S) (run \`flutter analyze\` to see them).`;
  const what = web ? 'TypeScript errors' : 'analyzer errors';
  return [
    head,
    `Fix these ${n} ${what}, change nothing else — no refactors, no style changes, no new features. Warnings${web ? ', lint findings' : '/infos'} are out of scope.`,
    ...(lines.length ? [`The errors:`, ...lines.map((l) => `  ${l}`)] : []),
    `When done, output a one-line summary of what you fixed.`,
  ].join('\n');
}

/**
 * Measure ERRORS with the framework's own checker (flutter analyze / the project's
 * tsc) and, when >0 and a model is available, make ONE bounded repair attempt then
 * RE-MEASURE with the same checker. Warnings/infos never gate. When the live checker
 * is unavailable at the start, the measurement falls back to `initialErrors` (the
 * finalize report's persisted finalErrors, measured by the same checker); when
 * NOTHING is measurable the gate passes — it never blocks blind. After a repair the
 * gate never keeps a stale count it cannot re-measure: that parked a web run
 * needs-review forever even when the repair worked (PG-36) — it reports
 * `unmeasured` with the reason instead.
 * `analyze` is an injection seam for tests; production measures per framework.
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
  /** Override detection (tests); production detects from the project. */
  framework?: Framework;
  analyze?: (projectRoot: string, env?: NodeJS.ProcessEnv) => Promise<{ total: number; errors: number; errorLines: string[] } | null>;
}): Promise<AnalyzeGateResult> {
  const log = opts.log ?? (() => { /* no-op */ });
  const framework = opts.framework ?? await detectFramework(opts.projectRoot);
  let lastWhy = '';
  const analyze: (root: string, env?: NodeJS.ProcessEnv) => Promise<GateMeasure> = opts.analyze
    ?? ((root, env) => measureErrorsFor(framework, root, env, (r) => { lastWhy = r; }));
  const checker = framework === 'react' || framework === 'next' ? 'tsc' : 'analyzer';

  const a = await analyze(opts.projectRoot, opts.env).catch(() => null);
  const initialErrors = a?.errors ?? opts.initialErrors ?? null;
  const errorLines = a?.errorLines ?? [];
  const tool = (a as { tool?: string } | null)?.tool;

  if (initialErrors == null) {
    log(`[finalize] analyze gate (${framework}): ${checker} unavailable${lastWhy ? ` (${lastWhy})` : ''} — gate passes (cannot measure)`);
    return { errors: null, initialErrors: null, repairAttempted: false, ok: true, framework, ...(lastWhy ? { unmeasured: lastWhy } : {}) };
  }
  if (initialErrors === 0) {
    return { errors: 0, initialErrors: 0, repairAttempted: false, ok: true, framework, ...(tool ? { tool } : {}) };
  }

  // >0 errors. ONE bounded repair attempt when a model + runner are available;
  // skip gracefully (straight to the verdict) when not.
  let errors: number | null = initialErrors;
  let repairAttempted = false;
  let unmeasured: string | undefined;
  if (opts.model && opts.runModel) {
    repairAttempted = true;
    log(`[finalize] analyze gate (${framework}): ${initialErrors} ${checker} error(s) — one bounded AI repair attempt (model=${opts.model})`);
    const prompt = gateRepairPrompt(framework, initialErrors, errorLines.slice(0, 40), opts.projectRoot);
    try {
      await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    } catch (e) {
      log(`[finalize] analyze gate: repair attempt failed (non-fatal): ${(e as Error).message}`);
    }
    lastWhy = '';
    const b = await analyze(opts.projectRoot, opts.env).catch(() => null);
    if (b) {
      errors = b.errors;
      log(`[finalize] analyze gate (${framework}): post-repair ${checker} — ${b.errors} error(s)`);
    } else {
      // The repair ran and nothing can re-measure it. Keeping the pre-repair count
      // would park the run forever (a resume cannot measure either); blocking on a
      // number that may be stale is blocking blind. Record why instead.
      errors = null;
      unmeasured = `the ${checker} could not re-measure after the repair${lastWhy ? `: ${lastWhy}` : ''} — pre-repair count was ${initialErrors}`;
      log(`[finalize] analyze gate (${framework}): WARNING ${unmeasured}; not parking on a stale count`);
    }
  } else {
    log(`[finalize] analyze gate (${framework}): ${initialErrors} ${checker} error(s), no model/runner — skipping repair attempt`);
  }

  return {
    errors, initialErrors, repairAttempted, ok: errors === null || errors === 0, framework,
    ...(tool ? { tool } : {}), ...(unmeasured ? { unmeasured } : {}),
  };
}

// ── small utils ────────────────────────────────────────────────────────────────

function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : 'no changes';
}

// Test-only surface for source-dir resolution. Exported so the resolution contract
// can be unit-tested without a live server / Flutter SDK. The build-safe rollback is
// now git-based (see ../version-control); not part of the runtime API.
export const __test = { sourceDirsFor, webBuildOk, analyzeErrorsFor, buildOkFor };
