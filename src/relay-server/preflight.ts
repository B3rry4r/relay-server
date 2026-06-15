// =============================================================================
// File: src/relay-server/preflight.ts
//
// P4 (RFC §4.3): the TOKEN/COST PRE-FLIGHT GATE — computed deterministically from
// a run's JSON (NO LLM). Before a whole-app build starts, estimate how much each
// per-screen prompt costs in tokens (text + vision), project the cumulative
// shared-session transcript, resolve the CONCRETE model + its REAL context window
// (don't assume 1M), and produce best / expected / worst cost. Hard-block when any
// stage peak or the projected session exceeds the window; warn on cost/headroom.
//
// Everything here is an ESTIMATE — exact counts need /v1/messages/count_tokens,
// which we don't call from the build box. We use the RFC's heuristics:
//   • text tokens  ≈ chars / 3.4
//   • vision tokens ≈ (w·h) / 750  AFTER the model's long-edge cap
// =============================================================================

import type { BuildRun } from './build-run-store';

// ── Model metadata (sourced from the claude-api skill catalog, cached 2026-05-26) ──
// We resolve the CONCRETE model the CLI will actually run. `provider` is the relay
// adapter id (claude/codex/gemini/opencode); `modelId` is the concrete CLI model
// string (e.g. "claude-opus-4-8"). Context windows and $/1M tokens are the real
// published numbers for Anthropic models; non-Anthropic providers fall back to a
// conservative generic profile (we don't ship their price sheets here).
export interface ModelProfile {
  /** Concrete model id we resolved to (best-effort). */
  resolvedModelId: string;
  /** Real input context window in tokens (NOT assumed 1M). */
  contextWindow: number;
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** Longest image edge (px) the model accepts before it downsamples. */
  visionLongEdgeCap: number;
  /** True when these are real published numbers (Anthropic), false = generic estimate. */
  exact: boolean;
}

// Keyed by concrete model id. Anthropic numbers from the model catalog.
const ANTHROPIC_MODELS: Record<string, Omit<ModelProfile, 'resolvedModelId'>> = {
  'claude-fable-5':    { contextWindow: 1_000_000, inputPerMTok: 10, outputPerMTok: 50, visionLongEdgeCap: 2576, exact: true },
  'claude-opus-4-8':   { contextWindow: 1_000_000, inputPerMTok: 5,  outputPerMTok: 25, visionLongEdgeCap: 2576, exact: true },
  'claude-opus-4-7':   { contextWindow: 1_000_000, inputPerMTok: 5,  outputPerMTok: 25, visionLongEdgeCap: 2576, exact: true },
  'claude-opus-4-6':   { contextWindow: 1_000_000, inputPerMTok: 5,  outputPerMTok: 25, visionLongEdgeCap: 1568, exact: true },
  'claude-opus-4-5':   { contextWindow: 1_000_000, inputPerMTok: 5,  outputPerMTok: 25, visionLongEdgeCap: 1568, exact: true },
  'claude-sonnet-4-6': { contextWindow: 1_000_000, inputPerMTok: 3,  outputPerMTok: 15, visionLongEdgeCap: 1568, exact: true },
  'claude-sonnet-4-5': { contextWindow: 1_000_000, inputPerMTok: 3,  outputPerMTok: 15, visionLongEdgeCap: 1568, exact: true },
  'claude-haiku-4-5':  { contextWindow: 200_000,   inputPerMTok: 1,  outputPerMTok: 5,  visionLongEdgeCap: 1568, exact: true },
};

// Per-provider DEFAULT concrete model when the run didn't pin a modelId. claude's
// CLI default is the latest Opus; codex/gemini run their own defaults — for those
// we keep a conservative generic profile (large window, unknown price).
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'claude-opus-4-8',
};

// Generic fallback for non-Anthropic providers (or an unknown Anthropic id). A
// large-but-finite window so the gate still does SOMETHING; price 0 → cost shown
// as "unknown" rather than a fake number.
const GENERIC_PROFILE: Omit<ModelProfile, 'resolvedModelId'> = {
  contextWindow: 200_000, inputPerMTok: 0, outputPerMTok: 0, visionLongEdgeCap: 2048, exact: false,
};

/** Resolve a run's (provider, modelId) to a concrete ModelProfile. */
export function resolveModelProfile(provider?: string, modelId?: string): ModelProfile {
  const id = (modelId || '').trim() || PROVIDER_DEFAULT_MODEL[provider || ''] || '';
  const m = id && ANTHROPIC_MODELS[id];
  if (m) return { resolvedModelId: id, ...m };
  // Unknown concrete id → generic profile, but keep the id we guessed for display.
  return { resolvedModelId: id || `${provider || 'unknown'} (default)`, ...GENERIC_PROFILE };
}

// ── Token heuristics (RFC §4.3) ─────────────────────────────────────────────
const CHARS_PER_TOKEN = 3.4;
export const estTextTokens = (s: string | undefined): number =>
  s ? Math.ceil(s.length / CHARS_PER_TOKEN) : 0;

/** Vision tokens for ONE reference image: (w·h)/750 AFTER long-edge downscale. */
export function estVisionTokens(wPx: number, hPx: number, longEdgeCap: number): number {
  if (!wPx || !hPx) return 0;
  const longEdge = Math.max(wPx, hPx);
  const scale = longEdge > longEdgeCap ? longEdgeCap / longEdge : 1;
  const w = wPx * scale, h = hPx * scale;
  return Math.ceil((w * h) / 750);
}

// ── Per-screen + run-level report ───────────────────────────────────────────
export interface ScreenEstimate {
  frameId: string;
  frameName: string;
  textTokens: number;    // packet + tree text
  visionTokens: number;  // reference render at the resolved scale
  promptTokens: number;  // text + vision (one screen's input)
}
export interface PreflightReport {
  model: ModelProfile;
  screens: ScreenEstimate[];
  /** The single biggest per-screen prompt (drives per-call peak). */
  peakScreenTokens: number;
  /** Sum of every screen's input — the floor on total input across the run. */
  totalScreenTokens: number;
  /** Projected cumulative SHARED-session transcript at the LAST screen (worst case
   *  for a single --resume session that never compacts: prior prompts accrue). */
  projectedSessionTokens: number;
  /** Fraction of the context window the projected session occupies (0..n). */
  sessionWindowFraction: number;
  /** Fraction the single peak screen occupies. */
  peakWindowFraction: number;
  cost: { best: number | null; expected: number | null; worst: number | null; currency: 'USD'; exact: boolean };
  verdict: 'ok' | 'warn' | 'block';
  notes: string[];
}

// Thresholds (RFC §4.3): hard-block when a stage peak > 0.9× window or the
// projected session > window; warn on > 0.5× window. Cost ceiling is advisory.
const BLOCK_PEAK_FRACTION = 0.9;
const WARN_PEAK_FRACTION = 0.5;
const COST_WARN_CEILING_USD = 25;

// Rough per-screen OUTPUT-token assumptions for the 3 cost scenarios. A screen
// build writes code + a preview entrypoint + (with verify) iterates. best = one
// clean pass, expected = a couple iterations, worst = the iteration cap.
function outputScenarios(run: BuildRun): { best: number; expected: number; worst: number } {
  const iters = Math.max(1, Math.min(run.maxIterations ?? 4, 8));
  const perPassOut = 6000; // generous per-pass output estimate (code-heavy)
  return { best: perPassOut, expected: perPassOut * Math.min(2, iters), worst: perPassOut * iters };
}

/** Compute the deterministic pre-flight report for a run. */
export function computePreflight(run: BuildRun): PreflightReport {
  const model = resolveModelProfile(run.model, run.modelId);
  const notes: string[] = [];

  const screens: ScreenEstimate[] = run.screens.map((s) => {
    const spec = s.spec;
    const textTokens = estTextTokens(spec?.packet) + estTextTokens(spec?.tree);
    // Reference render pixel size: prefer stored ref px, else logical w/h ×2 (refs
    // are exported @2×), else 0 (no ref → no vision cost estimate).
    const wPx = spec?.refWidthPx ?? (spec?.width ? spec.width * 2 : 0);
    const hPx = spec?.refHeightPx ?? (spec?.height ? spec.height * 2 : 0);
    const visionTokens = estVisionTokens(wPx, hPx, model.visionLongEdgeCap);
    return { frameId: s.frameId, frameName: s.frameName, textTokens, visionTokens, promptTokens: textTokens + visionTokens };
  });

  const peakScreenTokens = screens.reduce((m, s) => Math.max(m, s.promptTokens), 0);
  const totalScreenTokens = screens.reduce((sum, s) => sum + s.promptTokens, 0);

  // Shared-session projection: a single --resume session accrues each screen's
  // prompt on top of the prior transcript. The LAST screen sees ~the whole sum
  // (the written-contract + earlier turns), so the cumulative high-water mark is
  // the running sum. With freshSessions the per-screen session is reset → the peak
  // is just the biggest single screen instead.
  const projectedSessionTokens = run.freshSessions ? peakScreenTokens : totalScreenTokens;
  const sessionWindowFraction = model.contextWindow > 0 ? projectedSessionTokens / model.contextWindow : 0;
  const peakWindowFraction = model.contextWindow > 0 ? peakScreenTokens / model.contextWindow : 0;

  // Cost: input is paid per call (≈ projected input across all screens), output
  // scales with iterations. best/expected/worst vary the output assumption AND the
  // input re-read (shared session re-sends the growing transcript every turn — the
  // worst case roughly doubles input; we keep it simple: input once + output band).
  let cost: PreflightReport['cost'];
  if (!model.exact || model.inputPerMTok === 0) {
    cost = { best: null, expected: null, worst: null, currency: 'USD', exact: false };
    notes.push(`Cost unknown — "${model.resolvedModelId}" is not in the priced model catalog (non-Anthropic or unrecognized model).`);
  } else {
    const out = outputScenarios(run);
    const n = Math.max(1, screens.length);
    const inputUSD = (totalScreenTokens / 1_000_000) * model.inputPerMTok;
    const outUSD = (perScreen: number) => (perScreen * n / 1_000_000) * model.outputPerMTok;
    // Shared session re-sends the accumulating transcript each iteration → input
    // cost grows super-linearly. Approximate worst input as ~2× the one-pass input.
    const inputMult = run.freshSessions ? 1 : 1.6;
    cost = {
      best: round2(inputUSD + outUSD(out.best)),
      expected: round2(inputUSD * (run.freshSessions ? 1 : 1.3) + outUSD(out.expected)),
      worst: round2(inputUSD * inputMult + outUSD(out.worst)),
      currency: 'USD', exact: true,
    };
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  let verdict: PreflightReport['verdict'] = 'ok';
  if (model.contextWindow > 0) {
    if (peakWindowFraction > BLOCK_PEAK_FRACTION) {
      verdict = 'block';
      notes.push(`A single screen's prompt (~${fmt(peakScreenTokens)} tok) exceeds ${pct(BLOCK_PEAK_FRACTION)} of the ${fmt(model.contextWindow)}-tok window — it will not fit. Trim the IR (size-gate / section build) before starting.`);
    }
    if (sessionWindowFraction > 1) {
      verdict = 'block';
      notes.push(`The projected ${run.freshSessions ? 'peak' : 'cumulative shared-session'} transcript (~${fmt(projectedSessionTokens)} tok) overflows the ${fmt(model.contextWindow)}-tok window. ${run.freshSessions ? 'Reduce per-screen IR.' : 'Enable fresh-per-screen sessions, or split the run.'}`);
    } else if (verdict !== 'block' && (sessionWindowFraction > WARN_PEAK_FRACTION || peakWindowFraction > WARN_PEAK_FRACTION)) {
      verdict = 'warn';
      notes.push(`Projected usage is over ${pct(WARN_PEAK_FRACTION)} of the context window — quality degrades well before the hard limit. Consider fresh-per-screen sessions or a smaller batch.`);
    }
  }
  if (cost.exact && cost.worst != null && cost.worst > COST_WARN_CEILING_USD) {
    if (verdict === 'ok') verdict = 'warn';
    notes.push(`Worst-case cost (~$${cost.worst}) is over the $${COST_WARN_CEILING_USD} advisory ceiling.`);
  }
  if (!model.exact) {
    notes.push(`Context window for "${model.resolvedModelId}" is a conservative estimate; the real window may differ.`);
  }
  if (screens.some((s) => s.visionTokens === 0)) {
    notes.push(`Some screens have no reference-render dimensions on record — their vision-token cost is not counted (re-create the run to capture refWidthPx/refHeightPx).`);
  }
  if (verdict === 'ok') notes.unshift('Within safe limits — clear to start.');

  return {
    model, screens,
    peakScreenTokens, totalScreenTokens,
    projectedSessionTokens, sessionWindowFraction, peakWindowFraction,
    cost, verdict, notes,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n);
const pct = (f: number): string => `${Math.round(f * 100)}%`;
