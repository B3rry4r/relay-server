// =============================================================================
// File: src/relay-server/asset-naming.ts
//
// SEMANTIC asset RENAME (Phase-2 asset pass).
//
// Assets come out of the pipeline with opaque names (vector_290_4399.svg,
// netflix_icon_1_290_4408.png). This module renames each by WHAT IT DEPICTS,
// using the asset's own reference render (already on disk — the agent CLIs are
// multimodal and open files by path) plus its IR name/context, via ONE bounded,
// BATCHED AI call (cheap: one call for the whole batch, not per-asset).
//
// Output: a map oldRelPath → { name, newRelPath } plus the renamed file on disk,
// so the resources file uses semantic keys and a later re-point pass can remap
// IR-path → semantic path.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { runModel } from './ai-routes';
import type { AIModel } from './ai-adapters';
import type { LocalizedAsset } from './reference-render';

export interface RenamedAsset {
  /** original dir-relative path (e.g. assets/icons/vector_290_4399.svg). */
  oldRelPath: string;
  /** semantic snake_case name (no extension), e.g. add_circle. */
  name: string;
  /** new dir-relative path (e.g. assets/icons/add_circle.svg). */
  newRelPath: string;
  nodeId?: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
}

const toSnake = (s: string): string =>
  (s || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

/** Strip the trailing _<nodeId> + extension UIX bakes in, to seed a name hint. */
function baseHint(relPath: string): string {
  const base = path.basename(relPath).replace(/\.[a-z0-9]+$/i, '');
  // drop a trailing figma node id like _290_4408 / _290:4408
  return base.replace(/_\d+[_:]\d+$/i, '').replace(/_\d+$/i, '');
}

const isOpaque = (hint: string): boolean =>
  !hint || /^(vector|group|frame|rectangle|ellipse|union|subtract|mask|path|shape|icon|asset)$/i.test(hint);

/**
 * Build the batched naming prompt. The model is given each asset's index, its
 * current filename hint, and its on-disk render path (it opens the images), and
 * must reply with STRICT JSON: { "0": "add_circle", ... } snake_case semantic
 * names. Bounded: one call, JSON-only, no tools.
 */
function buildPrompt(items: Array<{ idx: number; hint: string; absPath: string; kind: string }>): string {
  const list = items.map(i =>
    `  ${i.idx}: ${i.kind} — current name "${i.hint || '(none)'}" — image file: ${i.absPath}`).join('\n');
  return [
    'You are naming UI asset files by WHAT THEY DEPICT. Open each image file listed',
    'below and give it a short, semantic, snake_case name (e.g. add_circle, home_tab,',
    'netflix_logo, profile_avatar, search). Name it after the thing it shows, NOT its',
    'shape (avoid "vector", "group", "rectangle"). For brand logos use the brand name.',
    '',
    'Assets:',
    list,
    '',
    'Reply with STRICT JSON only — an object mapping each index (as a string) to its',
    'snake_case name. No prose, no code fences. Example: {"0":"add_circle","1":"search"}',
  ].join('\n');
}

/** Best-effort JSON extraction from a model reply (handles fences / stray prose). */
function parseNameMap(text: string): Record<string, string> {
  const tryParse = (s: string): Record<string, string> | null => {
    try { const j = JSON.parse(s); return j && typeof j === 'object' ? j as Record<string, string> : null; }
    catch { return null; }
  };
  let out = tryParse(text.trim());
  if (!out) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) out = tryParse(m[0]);
  }
  return out ?? {};
}

/**
 * Rename a batch of localized assets to semantic names. Renders are already on
 * disk (localizeFrameAssets wrote them). Makes ONE AI call for the whole batch,
 * renames the files, and returns the rename map. On any failure (no model, bad
 * JSON) it falls back to the cleaned filename hint so the pass never blocks a build.
 *
 * `cap` bounds how many assets we send to the model (keep the call cheap); the
 * rest keep their hint-derived names.
 */
export async function renameAssetsSemantic(
  projectRoot: string,
  assets: LocalizedAsset[],
  model: AIModel,
  env: NodeJS.ProcessEnv,
  opts: { cap?: number; projectId?: string } = {},
): Promise<RenamedAsset[]> {
  const cap = opts.cap ?? 60;
  // Dedupe by path (a whole-app batch can re-list shared assets).
  const uniq = new Map<string, LocalizedAsset>();
  for (const a of assets) if (!uniq.has(a.relPath)) uniq.set(a.relPath, a);
  const list = [...uniq.values()];

  // Seed every asset with a hint-derived name; the AI refines the opaque ones.
  const seeded = list.map(a => ({ asset: a, hint: toSnake(baseHint(a.relPath)) }));
  const toAsk = seeded
    .filter(s => isOpaque(s.hint))
    .slice(0, cap)
    .map((s, i) => ({ idx: i, seed: s }));

  const names = new Map<string, string>(); // relPath → semantic name
  for (const s of seeded) names.set(s.asset.relPath, s.hint || 'asset');

  if (toAsk.length > 0) {
    const items = toAsk.map(t => ({
      idx: t.idx,
      hint: t.seed.hint,
      kind: t.seed.asset.kind,
      absPath: path.join(projectRoot, t.seed.asset.relPath),
    })).filter(i => fsSync.existsSync(i.absPath));
    if (items.length > 0) {
      try {
        const { text } = await runModel(model, buildPrompt(items), env, projectRoot, {
          format: 'json', projectId: opts.projectId,
        });
        const map = parseNameMap(text);
        for (const t of toAsk) {
          const got = map[String(t.idx)];
          const clean = toSnake(got || '');
          if (clean) names.set(t.seed.asset.relPath, clean);
        }
      } catch { /* keep hint names */ }
    }
  }

  // Apply renames on disk, deduping collisions, never overwriting an existing file.
  const usedByDir = new Map<string, Set<string>>();
  const result: RenamedAsset[] = [];
  for (const a of list) {
    const dir = path.posix.dirname(a.relPath);
    const ext = path.extname(a.relPath);
    let name = names.get(a.relPath) || 'asset';
    const used = usedByDir.get(dir) ?? new Set<string>();
    let candidate = name, n = 1;
    while (used.has(candidate)) candidate = `${name}_${++n}`;
    used.add(candidate);
    usedByDir.set(dir, used);
    name = candidate;

    const newRel = `${dir}/${name}${ext}`;
    if (newRel !== a.relPath) {
      const oldAbs = path.join(projectRoot, a.relPath);
      const newAbs = path.join(projectRoot, newRel);
      try {
        if (fsSync.existsSync(oldAbs) && !fsSync.existsSync(newAbs)) {
          await fs.rename(oldAbs, newAbs);
        }
      } catch { /* leave the original in place; map still records the intent */ }
    }
    result.push({
      oldRelPath: a.relPath, name, newRelPath: newRel,
      nodeId: a.nodeId, format: a.format, kind: a.kind,
    });
  }
  return result;
}
