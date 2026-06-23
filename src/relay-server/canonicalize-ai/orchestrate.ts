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
import { readDescriptorCache } from './descriptor-cache';
import { reconcileLexicon } from './reconcile';
import { reduceToCanonical, type ReduceFlow, type CanonicalModel } from './reduce';
import { adjudicateCanonical, type AdjudicationChange } from './adjudicate';
import type { FrameDescriptor } from './descriptor-schema';
import type { AIModel } from '../ai-adapters';
import { resolveProjectRoot } from '../runtime';

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
  /** force fresh AI calls past the per-stage caches (incl. the 1a describe cache). */
  force?: boolean;
  /** T28: granular progress sink for the 1a fan-out — called as each frame resolves
   *  so the caller can surface `describing N/total` (and a sub-label) in the UI. */
  onDescribeProgress?: (p: { done: number; total: number; cached: number; described: number; stage: 'describe' | 'reconcile' | 'reduce' | 'adjudicate' }) => void;
}

// T28: bounded concurrency for the 1a describe fan-out (mirrors prep's POOL pattern).
// describe is independent per frame (the bounded context = ONE frame), so frames run
// concurrently instead of serially (~45–105s/frame × 25 was the wasted serial cost).
// Env-overridable; default 3 — matches the heavier-than-fetch agent/render cost.
const DESCRIBE_POOL = Number(process.env.RELAY_CANON_DESCRIBE_POOL) > 0
  ? Number(process.env.RELAY_CANON_DESCRIBE_POOL) : 3;

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

  // ── 1a DESCRIBE — fan out per frame with BOUNDED CONCURRENCY (T28). describe is
  // independent per frame (the bounded context = ONE frame), so a DESCRIBE_POOL of
  // workers describe frames concurrently instead of serially. The persisted descriptor
  // CACHE (loaded ONCE here) lets a re-run/resume reuse prior describe work and only
  // describe new/changed frames — so a resumed canon no longer re-describes all frames
  // from scratch. Granular progress is emitted as each frame resolves so the UI shows
  // `describing N/total` rather than a static "Canonicalize".
  const provider: AIModel = opts.provider ?? 'claude';
  // Preserve input order in the output (results[i] ↔ frames[i]) regardless of the
  // order the pool finishes in — the lower stages don't require order, but a stable
  // order keeps logs/telemetry deterministic.
  const results: (FrameDescriptor | null)[] = new Array(frames.length).fill(null);
  const total = frames.length;
  // Load the cache ONCE for the whole fan-out (each frame reuses this snapshot for its
  // lookup; writes still go through the cache module's per-root serializer).
  const root = resolveProjectRoot(projectId);
  const cache = (root) ? await readDescriptorCache(root) : undefined;
  let done = 0, cachedCount = 0, describedCount = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= frames.length) return;
      const f = frames[i];
      const { descriptor, cached } = await describeFrame(projectId, figStorageKey, f, {
        provider, modelId: opts.modelId, harnessBaseUrl: opts.harnessBaseUrl, scale: opts.scale,
        runId: opts.runId, force: opts.force, cache,
      });
      results[i] = descriptor;
      done++;
      if (cached) cachedCount++; else describedCount++;
      opts.onDescribeProgress?.({ done, total, cached: cachedCount, described: describedCount, stage: 'describe' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(DESCRIBE_POOL, frames.length) }, worker));
  const descriptors: FrameDescriptor[] = results.filter((d): d is FrameDescriptor => d != null);

  // ── 1b RECONCILE — freeze the lexicon + proposalMap.
  opts.onDescribeProgress?.({ done, total, cached: cachedCount, described: describedCount, stage: 'reconcile' });
  const { lexicon, proposalMap, aiMerged } = await reconcileLexicon(projectId, descriptors, {
    provider, modelId: opts.modelId, skipAi: opts.skipAi, persist, forceRemerge: opts.force, runId: opts.runId,
  });

  // ── 1c REDUCE — the canonical model from descriptors + lexicon + flow.
  opts.onDescribeProgress?.({ done, total, cached: cachedCount, described: describedCount, stage: 'reduce' });
  const { canonical: reduced, aiRefined } = await reduceToCanonical(
    projectId, figStorageKey, descriptors, lexicon, proposalMap, flow, {
      provider, modelId: opts.modelId, skipAi: opts.skipAi, persist, forceRefine: opts.force, runId: opts.runId,
    });

  // ── 1d ADJUDICATE — vision-grounded review of the residue + finalize.
  // Thread per-frame dims through so 1d can render the drilled frames' references.
  const frameDims: Record<string, { width: number; height: number }> = {};
  for (const f of frames) if (f.width && f.height) frameDims[f.frameId] = { width: f.width, height: f.height };
  opts.onDescribeProgress?.({ done, total, cached: cachedCount, described: describedCount, stage: 'adjudicate' });
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
