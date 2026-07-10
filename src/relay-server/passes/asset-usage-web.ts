/**
 * asset-usage-web.ts — Phase 7c for react + next.
 *
 * Flutter's re-point rewrites `'assets/…'` literals and substituted `Icon(Icons.x)`
 * widgets into `AppAssets.<symbol>`. The web analogue of a substituted icon is not
 * an icon font — this stack ships none — it is a **hand-drawn inline `<svg>`**: the
 * build agent, unable to see a real asset, draws its own street grid where
 * `map_dark.png` belongs and its own basket where the product art belongs.
 *
 * So this pass does two things:
 *   • deterministic: `'assets/foo.svg'` string literals → `assets.foo` + import;
 *   • AI-gated: an inline `<svg>` whose enclosing component clearly stands in for a
 *     real exported IMAGE asset is reported (never rewritten blind — replacing a
 *     drawing with an <img> changes layout, and a wrong match is worse than none).
 *
 * The rewrite is conservative by construction: only symbols actually declared in
 * `src/resources/assets.ts` are ever emitted.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { listSourceFiles, ensureNamedImport, importPathBetween, escapeRe } from './web-app';

export const WEB_RESOURCES_RELS = ['src/resources/assets.ts', 'src/assets.ts'];
export const WEB_RESOURCES_SYMBOL = 'assets';

export interface WebIndexedAsset {
  symbolKey: string;
  name: string;
  newPath: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
}

export interface WebRepoint {
  file: string;
  from: 'raw-path' | 'inline-svg';
  original: string;
  symbol: string;
  how: 'deterministic' | 'ai';
}

export interface WebRepointSkip { file: string; what: string; reason: string }

/** `export const assets = { accountCircle: 'assets/icons/account_circle.svg', … }` */
export function parseDeclaredWebSymbols(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = /export\s+const\s+assets\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const\s*)?;/.exec(src);
  if (!block) return out;
  const re = /([A-Za-z0-9_$]+)\s*:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) out.set(m[1], m[2]);
  return out;
}

export function findWebResourcesFile(projectRoot: string): string | null {
  for (const r of WEB_RESOURCES_RELS) {
    const p = path.join(projectRoot, r);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

/** Every `'assets/…'` literal that is not already inside the resources file. */
function findPathLiterals(src: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  const re = /(['"])(assets\/[^'"$]+?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ value: m[2], start: m.index, end: m.index + m[0].length });
  return out;
}

export type SvgScale = 'icon' | 'art';

/** Top-level `<svg …>…</svg>` spans, classified by drawing size.
 *
 *  Size is the discriminator that matters. An 18×18 inline `<svg>` is a glyph the
 *  agent drew instead of using an exported icon; a 380×380 one (or `width="100%"`)
 *  is a photo, map or illustration it drew instead of using an exported image.
 *  Matching a *name token* alone confuses the two: a padlock glyph in
 *  `UserDetailPanel.tsx` is not the `user_avatar` image. */
function findInlineSvgs(src: string): { start: number; end: number; scale: SvgScale }[] {
  const out: { start: number; end: number; scale: SvgScale }[] = [];
  const re = /<svg\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const close = src.indexOf('</svg>', m.index);
    if (close === -1) continue;
    const openTag = src.slice(m.index, src.indexOf('>', m.index) + 1);
    out.push({ start: m.index, end: close + '</svg>'.length, scale: classifySvg(openTag) });
  }
  return out;
}

const ICON_MAX = 48;

export function classifySvg(openTag: string): SvgScale {
  if (/(?:width|height)\s*=\s*["'](?:\d+%|100%)["']/.test(openTag)) return 'art';
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(openTag);
  if (vb) return Math.max(parseFloat(vb[1]), parseFloat(vb[2])) > ICON_MAX ? 'art' : 'icon';
  const w = /width\s*=\s*(?:["'](\d+)["']|\{(\d+)\})/.exec(openTag);
  const h = /height\s*=\s*(?:["'](\d+)["']|\{(\d+)\})/.exec(openTag);
  const num = (x: RegExpExecArray | null) => (x ? parseInt(x[1] ?? x[2], 10) : 0);
  const max = Math.max(num(w), num(h));
  // `width={size}` — a prop-driven glyph. Icon by convention.
  if (max === 0) return 'icon';
  return max > ICON_MAX ? 'art' : 'icon';
}

const normPath = (p: string): string => p.replace(/^\/+/, '').replace(/\\/g, '/');

/** Tokens that suggest a drawing stands in for a real image (file/component name). */
function tokensOf(s: string): Set<string> {
  return new Set(
    s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 2),
  );
}

export interface WebRepointOptions {
  dryRun?: boolean;
  onlyFiles?: string[];
}

export async function repointWeb(
  projectRoot: string,
  assets: WebIndexedAsset[],
  opts: WebRepointOptions,
): Promise<{ repointed: WebRepoint[]; skipped: WebRepointSkip[]; warnings: string[] }> {
  const repointed: WebRepoint[] = [];
  const skipped: WebRepointSkip[] = [];
  const warnings: string[] = [];

  const resourcesFile = findWebResourcesFile(projectRoot);
  if (!resourcesFile) {
    warnings.push(`no web resources file (looked for ${WEB_RESOURCES_RELS.join(', ')}) — nothing to re-point onto`);
    return { repointed, skipped, warnings };
  }
  const declared = parseDeclaredWebSymbols(await fs.readFile(resourcesFile, 'utf-8'));
  if (declared.size === 0) {
    warnings.push(`${rel(projectRoot, resourcesFile)} declares no asset symbols`);
    return { repointed, skipped, warnings };
  }

  // path → symbol, from the resources file itself (the only source of truth about
  // what actually exists on disk after the rename/dedupe pass).
  const byPath = new Map<string, string>();
  for (const [sym, p] of declared) byPath.set(normPath(p), sym);

  const imageAssets = assets.filter((a) => a.kind === 'image' && declared.has(a.symbolKey));

  const srcDir = path.join(projectRoot, 'src');
  const files = (await listSourceFiles(srcDir)).filter((f) => f !== resourcesFile);
  const targets = opts.onlyFiles?.length
    ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f)))
    : files;

  for (const file of targets) {
    let src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const before = src;

    // ── (a) raw path literals → assets.<symbol> ──────────────────────────────
    // Right-to-left so earlier offsets stay valid.
    for (const lit of findPathLiterals(src).reverse()) {
      const symbol = byPath.get(normPath(lit.value));
      if (!symbol) {
        skipped.push({ file: rel(projectRoot, file), what: lit.value, reason: 'no declared asset symbol for this path' });
        continue;
      }
      src = src.slice(0, lit.start) + `assets.${symbol}` + src.slice(lit.end);
      repointed.push({ file: rel(projectRoot, file), from: 'raw-path', original: lit.value, symbol, how: 'deterministic' });
    }

    // ── (b) hand-drawn <svg> standing in for a real asset ────────────────────
    // Reported, never rewritten: swapping a drawing for an <img> changes layout,
    // and a visual change belongs in the build loop's verify pass, not here.
    const svgs = findInlineSvgs(src);
    const art = svgs.filter((s) => s.scale === 'art');
    const glyphs = svgs.filter((s) => s.scale === 'icon');

    if (art.length > 0 && imageAssets.length > 0) {
      // An art-sized drawing means a real image was redrawn. WHICH image is a
      // separate question, and a single shared filename token does not answer it:
      // `DeliveryTrackingCard` shares "delivery" with `delivery_driver_avatar` while
      // the thing it actually draws is a street grid (`map_dark`). Name an asset only
      // on a strong match; otherwise report the drawing and list the candidates.
      const fileTokens = tokensOf(path.basename(file, path.extname(file)));
      const ranked = imageAssets
        .map((a) => ({ a, shared: [...fileTokens].filter((t) => tokensOf(a.name).has(t)) }))
        .filter((x) => x.shared.length >= 1)
        .sort((x, y) => y.shared.length - x.shared.length);
      const strong = ranked[0] && ranked[0].shared.length >= 2 ? ranked[0] : null;

      skipped.push({
        file: rel(projectRoot, file),
        what: `inline <svg> artwork (${art.length})`,
        reason: strong
          ? `HIGH: hand-drawn artwork where the design shipped \`assets.${strong.a.symbolKey}\` `
            + `(${strong.a.name}) — shared name tokens: ${strong.shared.join(', ')}. `
            + `Replace the drawing with <img src={\`/\${assets.${strong.a.symbolKey}}\`} />.`
          : `HIGH: hand-drawn artwork (art-sized inline <svg>) while the design exported ${imageAssets.length} real `
            + `image asset(s). Do not redraw a photo, map, avatar or illustration. Candidates: `
            + `${imageAssets.slice(0, 8).map((a) => `assets.${a.symbolKey} (${a.name})`).join('; ')}`
            + `${imageAssets.length > 8 ? `; …+${imageAssets.length - 8} more` : ''}. `
            + `Pick the one the reference actually shows and use <img src={\`/\${assets.x}\`} />.`,
      });
    }

    if (glyphs.length > 0 && declared.size > 0) {
      // An icon-sized glyph pairs with an ICON asset — the web analogue of Flutter's
      // `Icon(Icons.x)` substitution. We do NOT guess WHICH icon: a wrong pairing is
      // worse than none, and the symbol list is right there in the resources file.
      skipped.push({
        file: rel(projectRoot, file),
        what: `inline <svg> glyph (${glyphs.length})`,
        reason: `MED: ${glyphs.length} hand-drawn icon glyph(s) while the design exported real icon assets — `
          + `prefer <Icon name="…" /> (or <img src={\`/\${assets.x}\`} />) over redrawing the path data.`,
      });
    }

    if (src !== before) {
      src = ensureNamedImport(src, WEB_RESOURCES_SYMBOL, importPathBetween(file, resourcesFile));
      if (!opts.dryRun) await fs.writeFile(file, src, 'utf-8');
    }
  }

  return { repointed, skipped, warnings };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { parseDeclaredWebSymbols, findPathLiterals, findInlineSvgs, tokensOf, escapeRe };
