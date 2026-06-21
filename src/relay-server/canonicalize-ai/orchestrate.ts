// =============================================================================
// File: src/relay-server/canonicalize-ai/orchestrate.ts
//
// CANONICALIZE (Phase 1 entrypoint) — the single orchestrator that runs the whole
// chain 1a → 1b → 1c → 1d and returns the final CanonicalModel. This is what Phase 7
// and the build pipeline call; they never have to know the per-stage modules exist.
//
//   1a DESCRIBE   — fan out describeFrame() across every frame (bounded one-frame
//                   context per call), each emitting a schema'd descriptor.
//   1b RECONCILE  — freeze the per-project lexicon (base + learned) + proposalMap.
//   1c REDUCE     — cluster descriptors + fingerprints + flow into the canonical model.
//   1d ADJUDICATE — vision-grounded review of the residue; correct + finalize.
//
// Cheap by construction: 1a is the only per-frame cost; 1b/1c make at most one bounded
// AI call each and cache it; 1d drills ONLY the uncertain items. Idempotent end-to-end
// (every stage caches its AI step by a deterministic signature). Imports the read-only
// 1a/1b/1c modules + 1d; never mutates them.
// =============================================================================

import { describeFrame, type DescribeFrameInput } from './describe';
import { reconcileLexicon } from './reconcile';
import { reduceToCanonical, type ReduceFlow, type CanonicalModel } from './reduce';
import { adjudicateCanonical, type AdjudicationChange } from './adjudicate';
import type { FrameDescriptor } from './descriptor-schema';
import type { AIModel } from '../ai-adapters';

export interface CanonicalizeOptions {
  /** AI provider (claude/codex/gemini) for every 1a–1d stage — respects the run's
   *  selected model so a codex/gemini run doesn't silently hard-depend on claude
   *  (RFC §0.1). Default 'claude' when unset. */
  provider?: AIModel;
  modelId?: string;
  /** durable build-run id — threaded into every stage's AI log ctx so the
   *  `[ai:canon.*] status=ok` firing proof lands in .uix/runs/<runId>.log. */
  runId?: string;
  /** skip ALL AI calls (deterministic-only) across 1a–1d — for tests / offline. */
  skipAi?: boolean;
  /** persist each stage's artifact (lexicon.json / canonical.json). Default true. */
  persist?: boolean;
  /** reference-render harness origin override (1a + 1d). */
  harnessBaseUrl?: string;
  /** reference render scale (default 2). */
  scale?: number;
  /** force fresh AI calls past the per-stage caches. */
  force?: boolean;
}

export interface CanonicalizeResult {
  canonical: CanonicalModel;
  descriptors: FrameDescriptor[];
  /** the 1d corrections applied (empty = 1c model was already confident). */
  changes: AdjudicationChange[];
  /** open doubts for the HITL checkpoint (1c warnings ∪ 1d unresolved). */
  warnings: string[];
  /** which uncertain items 1d drilled (audit of the cheap pass). */
  drilled: string[];
  /** per-stage AI-ran flags (for cost/telemetry). */
  stages: { describedFrames: number; lexiconAiMerged: boolean; reduceAiRefined: boolean; adjudicateVisionRan: boolean };
}

/**
 * Phase 1. Canonicalize a whole app from its frames + flow into the final
 * CanonicalModel the production pipeline keys off. Runs 1a fan-out → 1b → 1c → 1d.
 *
 * `frames` need width/height for the 1a + 1d reference renders (the vision grounding);
 * a frame missing dims still canonicalizes from its IR, just without an image.
 */
export async function canonicalize(
  projectId: string,
  figStorageKey: string,
  frames: DescribeFrameInput[],
  flow: ReduceFlow | undefined,
  opts: CanonicalizeOptions = {},
): Promise<CanonicalizeResult> {
  const persist = opts.persist !== false;

  // ── 1a DESCRIBE — fan out per frame. Sequential here for deterministic logging +
  // bounded concurrency on the CLI; callers wanting parallelism can pre-describe and
  // pass descriptors to the lower stages directly. A frame that fails to describe is
  // skipped (logged via throw) rather than aborting the whole app.
  const provider: AIModel = opts.provider ?? 'claude';
  const descriptors: FrameDescriptor[] = [];
  for (const f of frames) {
    const { descriptor } = await describeFrame(projectId, figStorageKey, f, {
      provider, modelId: opts.modelId, harnessBaseUrl: opts.harnessBaseUrl, scale: opts.scale, runId: opts.runId,
    });
    descriptors.push(descriptor);
  }

  // ── 1b RECONCILE — freeze the lexicon + proposalMap.
  const { lexicon, proposalMap, aiMerged } = await reconcileLexicon(projectId, descriptors, {
    provider, modelId: opts.modelId, skipAi: opts.skipAi, persist, forceRemerge: opts.force, runId: opts.runId,
  });

  // ── 1c REDUCE — the canonical model from descriptors + lexicon + flow.
  const { canonical: reduced, aiRefined } = await reduceToCanonical(
    projectId, figStorageKey, descriptors, lexicon, proposalMap, flow, {
      provider, modelId: opts.modelId, skipAi: opts.skipAi, persist, forceRefine: opts.force, runId: opts.runId,
    });

  // ── 1d ADJUDICATE — vision-grounded review of the residue + finalize.
  // Thread per-frame dims through so 1d can render the drilled frames' references.
  const frameDims: Record<string, { width: number; height: number }> = {};
  for (const f of frames) if (f.width && f.height) frameDims[f.frameId] = { width: f.width, height: f.height };
  const adj = await adjudicateCanonical(projectId, figStorageKey, reduced, descriptors, {
    provider, modelId: opts.modelId, skipAi: opts.skipAi, persist, forceAdjudicate: opts.force,
    harnessBaseUrl: opts.harnessBaseUrl, scale: opts.scale, frameDims, runId: opts.runId,
  });

  return {
    canonical: adj.canonical,
    descriptors,
    changes: adj.changes,
    warnings: adj.warnings,
    drilled: adj.drilled,
    stages: {
      describedFrames: descriptors.length,
      lexiconAiMerged: aiMerged,
      reduceAiRefined: aiRefined,
      adjudicateVisionRan: adj.visionRan,
    },
  };
}
