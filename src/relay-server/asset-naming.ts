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
import type { AIModel } from './ai-adapters';
import type { LocalizedAsset } from './reference-render';
import { requireModel, AiNotFiredError, AiUnusableError } from './ai-observability';

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

/** A token is "node-id-ish" garbage — a pure number, an instance id (`i285`), or
 *  a residue of chained ids (`941_i285`, `290_4378`) — i.e. carries no depicted
 *  meaning. Such a hint MUST be sent to the model and MUST be rejected if the
 *  model fails to replace it (never written to disk as-is). */
const isNodeIdish = (s: string): boolean => {
  if (!s) return false;
  const t = s.toLowerCase();
  // pure number, single instance id, or ONLY number/i-id segments joined by `_`.
  return /^\d+$/.test(t)
    || /^i\d+$/.test(t)
    || /^(?:\d+|i\d+)(?:_(?:\d+|i\d+))+$/.test(t);
};

/**
 * Strip the trailing Figma node-id segments UIX bakes into an asset filename, to
 * seed a name hint. UIX names assets `<semantic?>_<nodeId tails>` where a tail is
 * one or more groups of `_<digits>`, `_I<digits>`, `_<digits>:<digits>` — and
 * there can be SEVERAL chained (e.g. `angle-left_I285_2444_568_5957_330_3036`,
 * `vector_i290_4378_288_3484_I290_4378_288_3484`). We strip them ALL from the
 * end, leaving only the leading human token(s) (or empty when the whole name was
 * node-id garbage like `941_I285_2444_568_5946`).
 */
function baseHint(relPath: string): string {
  let base = path.basename(relPath).replace(/\.[a-z0-9]+$/i, '');
  // Repeatedly peel a trailing node-id-ish group:
  //   _290_4408   _290:4408   _I290_4378   _i285   (Figma instance/node ids)
  // A bare trailing `_<digits>` is AMBIGUOUS: it may be a Figma node id (large,
  // e.g. _2444) OR a collision suffix WE added on a previous run (small, e.g.
  // a re-run of an already-semantic `visibility_off_2`). We only strip a bare
  // `_<n>` when it looks like a node id (3+ digits) OR what precedes it is still
  // node-id garbage — so an already-semantic name with a small collision suffix
  // (`visibility_off_2`, `graphic_1`) survives verbatim → re-run is a no-op.
  let prev: string;
  do {
    prev = base;
    base = base
      .replace(/_\d+[_:]\d+$/i, '')   // _<digits>_<digits> / _<digits>:<digits>
      .replace(/_i\d+$/i, '');         // _I<digits> (instance id)
    const m = /^(.*?)_(\d+)$/i.exec(base);
    if (m) {
      const stem = m[1];
      const isNodeIdNumber = m[2].length >= 3;
      // strip the bare _<digits> when it's node-id-sized, or the stem is empty /
      // still node-id-ish (so `941_I285` fully collapses, but `graphic_1` stays).
      if (isNodeIdNumber || !stem || isNodeIdish(toSnake(stem))) base = stem;
    }
  } while (base !== prev && base.length > 0);
  return base;
}

const SHAPE_TOKENS = new Set([
  'vector', 'group', 'frame', 'rectangle', 'rect', 'ellipse', 'oval', 'circle',
  'union', 'subtract', 'intersect', 'exclude', 'mask', 'path', 'shape', 'icon',
  'image', 'img', 'asset', 'layer', 'component', 'instance', 'clip', 'bg',
  'background', 'fill', 'stroke', 'line', 'polygon', 'star', 'object',
]);

/** A hint is "shape-ish" (non-semantic) when EVERY token is a generic shape word
 *  or a bare number — i.e. it carries no depicted meaning. Catches `vector`,
 *  `ellipse_53` (Figma layer index), `mask_group`, `group_2`, `vector_path`. A
 *  hint with ANY real word (`arrow_back`, `green_circle`, `netflix_icon_1`,
 *  `line_chart`) is NOT shape-ish — that word is the depicted thing. */
const isShapeish = (hint: string): boolean => {
  const toks = hint.split('_').filter(Boolean);
  if (toks.length === 0) return false;
  return toks.every(t => SHAPE_TOKENS.has(t.toLowerCase()) || /^\d+$/.test(t));
};

/** Opaque = empty, shape-ish (generic shape words / layer-indexed), or
 *  node-id-ish garbage. Opaque hints are the ones the AI MUST name (and the
 *  validator MUST reject if unnamed). */
const isOpaque = (hint: string): boolean =>
  !hint || isShapeish(hint) || isNodeIdish(hint);

/** True when a name CONTAINS Figma node-id residue in ANY token — a `i<digits>`
 *  instance id or a `<3+ digits>` node-id-sized number — even when other tokens
 *  are real words (`arrow_941_i285`, `logo_290_4378`). The AI-name validator
 *  rejects these so a single real word can't smuggle node-id garbage into a
 *  symbol; the resources file must have 0 node-id symbols (RFC §5 Phase 5). A
 *  short trailing index (`graphic_1`, `icon_2`) is NOT residue (≤2 digits). */
const hasNodeIdResidue = (name: string): boolean =>
  name.split('_').filter(Boolean).some(t => /^i\d+$/i.test(t) || /^\d{3,}$/.test(t));

/** The validator's verdict for a SINGLE AI-returned name: usable only when it is
 *  non-empty, not opaque (shape/empty/pure node-id), and carries no node-id
 *  residue token. This is the gate that rejects `941_i285`-style garbage. */
const isUsableAiName = (clean: string): boolean =>
  !!clean && !isOpaque(clean) && !hasNodeIdResidue(clean);

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
 * renames the files, and returns the rename map.
 *
 * AI-PURPOSE step (RFC v2 §5 Phase 5): the model IS the point. The semantic
 * rename FAILS LOUD if the model doesn't fire or returns unusable output — it
 * does NOT silently keep node-id/opaque hint names. This is the step that
 * produced the `941_i285` garbage and reported "applied"; that is now impossible.
 *
 * A deterministic HINT is still computed as a SEED (so non-opaque assets that
 * already depict-name themselves don't need the model), but for every OPAQUE
 * asset we send to the model, the model MUST return a real name — if it doesn't
 * fire, or returns no usable names for the opaque batch, this THROWS
 * (AiNotFiredError / AiUnusableError) and writes NOTHING to disk.
 *
 * `cap` bounds how many assets we send to the model (keep the call cheap). If
 * there are more opaque assets than `cap`, the overflow keeps its hint name —
 * the cap is a cost bound, not a silent-AI-failure escape hatch.
 *
 * EXPLICIT no-AI is signalled by `noAi: true` (e.g. tests / offline). In that
 * mode the deterministic hints are kept and the call is a logged `degraded`
 * path — NOT a masqueraded clean result.
 */
export async function renameAssetsSemantic(
  projectRoot: string,
  assets: LocalizedAsset[],
  model: AIModel,
  env: NodeJS.ProcessEnv,
  opts: { batchSize?: number; projectId?: string; runId?: string; noAi?: boolean } = {},
): Promise<RenamedAsset[]> {
  // How many opaque assets to send the model PER call (bounds each call's cost /
  // image-open count). We chunk over ALL opaque assets — there is no cap that
  // DROPS opaque assets and writes them out node-id-ish (that would fail the
  // "0 opaque/node-id symbols" exit criterion). The only cost knob is batch size.
  // Default 10: each batch opens this many image files in ONE non-agent model
  // call, which has a HARD 120s cap (ai-routes AI_TIMEOUT_MS). Batches of 20–40
  // intermittently blew past it when the model inspected every distinct image
  // carefully (observed a clean 120s timeout on a diverse ellipse batch). 10
  // keeps each call well under the cap; the cost is more (smaller) calls
  // (≈23 for Ping's 223 opaque assets), each retried with backoff on a blip.
  const batchSize = Math.max(1, opts.batchSize ?? 10);
  // Dedupe by path (a whole-app batch can re-list shared assets).
  const uniq = new Map<string, LocalizedAsset>();
  for (const a of assets) if (!uniq.has(a.relPath)) uniq.set(a.relPath, a);
  const list = [...uniq.values()];

  // Seed every asset with a hint-derived name; the AI refines the opaque ones.
  // An already-semantic name (`visibility_off`, `angle_left`) is kept verbatim —
  // it is NOT opaque, never sent to the model, so a re-run is a true no-op.
  const seeded = list.map(a => ({ asset: a, hint: toSnake(baseHint(a.relPath)) }));
  const names = new Map<string, string>(); // relPath → semantic name
  for (const s of seeded) names.set(s.asset.relPath, s.hint || 'asset');

  // Every OPAQUE asset that exists on disk must be named by the model (chunked).
  const askable = seeded
    .filter(s => isOpaque(s.hint))
    .filter(s => fsSync.existsSync(path.join(projectRoot, s.asset.relPath)));

  if (askable.length > 0) {
    if (opts.noAi) {
      // EXPLICIT no-AI: keep deterministic hints, but make the degradation LOUD
      // (logged + recorded), never a silent clean result. (RFC §0.1). The opaque
      // residue is later de-opaqued by a non-node-id fallback below.
      // eslint-disable-next-line no-console
      console.log(`[ai:asset-rename] degraded — noAi set, keeping ${askable.length} hint name(s) for opaque assets`);
    } else {
      // AI-REQUIRED, chunked over ALL opaque assets. requireModel THROWS
      // (AiNotFiredError) if a batch's model call doesn't fire / returns empty,
      // and (via the validator) AiUnusableError if a batch returns NO usable
      // names. We do NOT fall back to node-id hints — that is the silent garbage
      // this step exists to forbid. (A batch that fires and yields ≥1 real name
      // passes; per-asset residue is handled by the de-opaque fallback below.)
      let totalNamed = 0;
      const batches = Math.ceil(askable.length / batchSize);
      for (let b = 0; b < batches; b++) {
        const batch = askable.slice(b * batchSize, (b + 1) * batchSize)
          .map((s, i) => ({ idx: i, seed: s }));
        const items = batch.map(t => ({
          idx: t.idx,
          hint: t.seed.hint,
          kind: t.seed.asset.kind,
          absPath: path.join(projectRoot, t.seed.asset.relPath),
        }));
        const validate = (text: string): Record<string, string> => {
          const map = parseNameMap(text);
          const usable: Record<string, string> = {};
          for (const t of batch) {
            const clean = toSnake(map[String(t.idx)] || '');
            // A real name must be non-empty, not opaque (shape word / pure
            // node-id), AND carry no node-id residue token. This is what rejects
            // `941_i285`-style garbage AND `arrow_941_i285`-style smuggling.
            if (isUsableAiName(clean)) usable[String(t.idx)] = clean;
          }
          if (Object.keys(usable).length === 0) {
            // Plain Error — requireModel re-wraps validator throws as
            // AiUnusableError with the real call id.
            throw new Error(`model returned no usable semantic names for batch ${b + 1}/${batches} (${batch.length} opaque asset(s))`);
          }
          return usable;
        };
        // Retry (with backoff) on a transient model error/timeout AND on an unusable
        // response. Running ~11 heavy image-open calls back-to-back intermittently
        // trips API overload / a brief rate-limit, surfacing as a CLI "Command
        // failed"; separately, a batch occasionally returns a malformed/oversized
        // body that parses to zero usable names (observed: batch 11/12 of a 20-screen
        // run returned ~114 tokens of garbage, then a clean 47-token map on retry —
        // and the single failure HALTED the whole run at the design-system gate).
        // Re-asking is NOT a silent fallback: nothing is accepted that the validator
        // rejects, and if ALL attempts fail the loud error still propagates and the
        // whole atomic unit rolls back. The backoff only rides out transient blips.
        const callBatch = () => requireModel<Record<string, string>>(
          model, buildPrompt(items), env, projectRoot,
          { format: 'json', validate, log: { projectId: opts.projectId, runId: opts.runId, step: `asset-rename:${b + 1}/${batches}` } },
        );
        const MAX_ATTEMPTS = 3;
        let res: Awaited<ReturnType<typeof callBatch>> | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            res = await callBatch();
            break;
          } catch (e) {
            const transient = (e instanceof AiNotFiredError && (e.reason === 'error' || e.reason === 'timeout'))
              || e instanceof AiUnusableError;
            if (!transient || attempt === MAX_ATTEMPTS) throw e;
            const why = e instanceof AiUnusableError ? 'unusable output' : (e as AiNotFiredError).reason;
            const backoffMs = 3000 * attempt;
            // eslint-disable-next-line no-console
            console.log(`[ai:asset-rename] batch ${b + 1}/${batches}: retryable model failure (${why}) attempt ${attempt}/${MAX_ATTEMPTS} — backing off ${backoffMs}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
        const { value: usable, callId, tokens } = res!;
        for (const t of batch) {
          const clean = usable[String(t.idx)];
          if (clean) { names.set(t.seed.asset.relPath, clean); totalNamed++; }
        }
        // eslint-disable-next-line no-console
        console.log(`[ai:asset-rename] batch ${b + 1}/${batches}: applied ${Object.keys(usable).length}/${batch.length} AI names (call=${callId} tokens≈${tokens})`);
      }
      // eslint-disable-next-line no-console
      console.log(`[ai:asset-rename] total ${totalNamed}/${askable.length} opaque assets named by AI across ${batches} batch(es)`);
    }
  }

  // DE-OPAQUE the residue. Any asset whose final name is STILL opaque (the model
  // genuinely couldn't name an ambiguous external-component instance, or noAi) is
  // given a non-node-id, kind-scoped best-effort name (`graphic_1`/`picture_1`) —
  // NEVER a node-id (`941_i285`). This guarantees the resources file has 0
  // node-id/opaque symbols (RFC §5 Phase 5), and is logged as best-effort so the
  // degradation is surfaced, not masqueraded (RFC §0.1).
  const deOpaqued: string[] = [];
  const fallbackCount = new Map<string, number>(); // kind → running index
  for (const s of seeded) {
    const cur = names.get(s.asset.relPath) || '';
    if (isOpaque(cur) || hasNodeIdResidue(cur)) {
      const stem = s.asset.kind === 'image' ? 'picture' : 'graphic';
      const n = (fallbackCount.get(stem) ?? 0) + 1;
      fallbackCount.set(stem, n);
      const fb = `${stem}_${n}`;
      names.set(s.asset.relPath, fb);
      deOpaqued.push(`${s.asset.relPath} → ${fb}`);
    }
  }
  if (deOpaqued.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[ai:asset-rename] best-effort: ${deOpaqued.length} ambiguous asset(s) de-opaqued to kind-scoped names (no AI depicted-name): ${deOpaqued.slice(0, 5).join(', ')}${deOpaqued.length > 5 ? ' …' : ''}`);
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
