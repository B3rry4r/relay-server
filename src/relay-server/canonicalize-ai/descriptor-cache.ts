// =============================================================================
// File: src/relay-server/canonicalize-ai/descriptor-cache.ts
//
// T28 — DESCRIBE DESCRIPTOR CACHE (Phase 1a). A 25-frame run that resumed re-ran 1a
// describe over ALL frames from scratch (~25 min wasted) because the per-frame
// descriptors it had already computed were discarded. This persists each frame's
// FrameDescriptor to <projectRoot>/.uix/canon-descriptors.json, keyed by frameId +
// the frame's structural FINGERPRINT — so a resumed/re-run canon REUSES prior
// describe work and only describes new or structurally-changed frames.
//
//   - Keyed by frameId; the entry records the frame's fingerprint so a frame whose
//     structure CHANGED (different fingerprint) re-describes (stale entry is ignored).
//   - Best-effort + crash-safe: a corrupt/absent cache reads as empty; a write
//     failure never breaks the build (describe just recomputes next time).
//   - Concurrency-safe under the parallel describe pool: writes go through a single
//     in-process serializer per project root so two workers finishing at once can't
//     clobber the JSON. (One process owns a run; cross-process is out of scope.)
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FrameDescriptor } from './descriptor-schema';

const CACHE_REL = path.join('.uix', 'canon-descriptors.json');

interface CacheEntry {
  /** the frame's structural fingerprint at the time it was described. */
  fingerprint: string;
  descriptor: FrameDescriptor;
  /** ISO timestamp the entry was written (debug/telemetry only). */
  at: string;
}
interface CacheFile {
  version: 1;
  /** frameId → entry. */
  frames: Record<string, CacheEntry>;
}

const EMPTY: CacheFile = { version: 1, frames: {} };

function cachePath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_REL);
}

/** Read the whole cache file (empty on absent/corrupt — never throws). */
export async function readDescriptorCache(projectRoot: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cachePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.frames && typeof parsed.frames === 'object') {
      return parsed as CacheFile;
    }
  } catch { /* absent / corrupt → empty */ }
  return { version: 1, frames: {} };
}

/**
 * Return the cached descriptor for `frameId` IFF it exists AND its recorded
 * fingerprint matches `fingerprint` (structure unchanged). A mismatch (frame
 * changed) or a miss returns null → the caller describes the frame fresh.
 */
export function lookupDescriptor(
  cache: CacheFile, frameId: string, fingerprint: string,
): FrameDescriptor | null {
  const e = cache.frames[frameId];
  if (e && e.fingerprint === fingerprint && e.descriptor) return e.descriptor;
  return null;
}

// Per-project write serializer: the parallel describe pool can finish several frames
// at once; chain every write so a read-modify-write of the shared JSON is atomic
// within this process.
const writeChains = new Map<string, Promise<void>>();

/**
 * Persist one frame's descriptor + fingerprint into the cache file (read-modify-write,
 * serialized per project root). Best-effort: a write failure is swallowed — the only
 * cost is re-describing that frame on a later run.
 */
export async function putDescriptor(
  projectRoot: string, frameId: string, fingerprint: string, descriptor: FrameDescriptor,
): Promise<void> {
  const prev = writeChains.get(projectRoot) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const cache = await readDescriptorCache(projectRoot);
      cache.frames[frameId] = { fingerprint, descriptor, at: new Date().toISOString() };
      const abs = cachePath(projectRoot);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // Write via a temp file + rename so a crash mid-write can't leave a truncated
      // (corrupt) JSON that would discard the WHOLE cache on the next read.
      const tmp = `${abs}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
      await fs.rename(tmp, abs);
    } catch { /* never break the build on a cache write */ }
  });
  writeChains.set(projectRoot, next.catch(() => {}));
  return next;
}

// Exposed for tracing/tests.
export const _internals = { CACHE_REL, EMPTY };
