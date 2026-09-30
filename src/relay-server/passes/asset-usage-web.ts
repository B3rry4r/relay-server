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
 *   • deterministic: every spelling of a design-asset path — the IR's OPAQUE
 *     pre-rename `'assets/icons/vector_10_20.svg'` (asset-map oldPath, PG-15), the
 *     renamed path, the served `/assets/…` URL, `public/assets/…` — becomes
 *     `assets.<symbol>` + import; in a JSX attribute it becomes `src={assets.x}`
 *     (PG-16: a bare `src=assets.x` is a syntax error); every pre-B56 `/`-prefixed
 *     composition (`` `/${assets.x}` ``, `` `url(/${assets.x})` ``, `'/' + assets.x`)
 *     loses the prefix now that the values ARE URLs (rewriteServedPrefixes);
 *   • AI-gated: an inline `<svg>` whose enclosing component clearly stands in for a
 *     real exported IMAGE asset is reported (never rewritten blind — replacing a
 *     drawing with an <img> changes layout, and a wrong match is worse than none).
 *
 * The rewrite is conservative by construction: only symbols actually declared in
 * the resources module (found by the shared resolver: react `src/resources/assets.ts`,
 * next `<root>/lib/resources/assets.ts`) are ever emitted, and every source root the
 * resolver walks is scanned (PG-17: Next source lives in app/ and components/).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { listSourceFiles, listWebSources, loadWebApp, ensureNamedImport, importSpecFor, escapeRe } from './web-app';
import { webAssetKey } from './framework';

export const WEB_RESOURCES_RELS = ['lib/resources/assets.ts', 'src/lib/resources/assets.ts', 'src/resources/assets.ts', 'src/assets.ts'];
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
  from: 'raw-path' | 'inline-svg' | 'served-url-prefix';
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
    if (fsSync.existsSync(p) && parseDeclaredWebSymbols(fsSync.readFileSync(p, 'utf-8')).size > 0) return p;
  }
  return null;
}

/** Every design-asset path literal: `'assets/…'`, `'/assets/…'`, `'public/assets/…'`
 *  (single, double or back-quoted without interpolation). */
function findPathLiterals(src: string): { value: string; start: number; end: number; quote: string }[] {
  const out: { value: string; start: number; end: number; quote: string }[] = [];
  const re = /(['"`])(\/?(?:public\/)?assets\/[^'"`$\n]+?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ value: m[2], start: m.index, end: m.index + m[0].length, quote: m[1] });
  return out;
}

/** True when the literal starting at `at` is a JSX ATTRIBUTE value (`src="…"`) — it
 *  must become `src={assets.x}`; a bare `src=assets.x` does not parse (PG-16). An
 *  object value (`search: '…'`) or an assignment outside a tag is not one. */
export function isJsxAttrValue(src: string, at: number): boolean {
  const before = src.slice(Math.max(0, at - 600), at);
  if (!/[A-Za-z_$][\w$:.-]*\s*=\s*$/.test(before)) return false;
  const lt = before.search(/<[A-Za-z][\w.:-]*[^<]*$/);
  if (lt < 0) return false;
  // Still inside that opening tag: no `>` since it (arrow functions aside).
  return !before.slice(lt).replace(/=>/g, '').includes('>');
}

/** `` `/${assets.x}` `` / `` `/${assets[k]}` `` — the pre-B56 shape the packet taught
 *  (values were paths, the screen added the slash). Now that the values ARE served
 *  URLs this yields `//assets/…`, a protocol-relative URL to a host named "assets". */
function findServedPrefixTemplates(src: string): { start: number; end: number; expr: string }[] {
  const out: { start: number; end: number; expr: string }[] = [];
  const re = /`\/\$\{\s*(assets\s*(?:\.\s*[A-Za-z0-9_$]+|\[[^\]`]+\]))\s*\}`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ start: m.index, end: m.index + m[0].length, expr: m[1].replace(/\s+/g, '') });
  return out;
}

/** An `assets` member expression: `assets.x`, `assets[key]`. */
const ASSET_EXPR = String.raw`assets\s*(?:\.\s*[A-Za-z0-9_$]+|\[[^\]\`\n]+\])`;

/** True when offset `at` is inside a template literal's text (an odd number of
 *  unescaped backticks before it). Cheap and conservative: nested templates inside
 *  an interpolation break the parity, and then nothing is rewritten there. */
function inTemplateText(src: string, at: number): boolean {
  let n = 0;
  for (let i = 0; i < at; i++) if (src[i] === '`' && src[i - 1] !== '\\') n++;
  return n % 2 === 1;
}

export interface ServedPrefixHit { original: string; expr: string }

/**
 * Every composition that PREFIXES a served asset URL with `/` — each one yields the
 * protocol-relative `//assets/…` now that the resources values are served URLs
 * (`/assets/x.png`), which a browser requests from a host named "assets"
 * (net::ERR_NAME_NOT_RESOLVED) while tsc and the bundler stay green. The pre-B56
 * packet taught "prefix the value with /", so every spelling of that is migrated:
 *   • the whole template        `` `/${assets.x}` ``             → `assets.x`
 *   • inside a larger template  `` `url(/${assets.mapDark})` `` → `` `url(${assets.mapDark})` ``
 *                               `` `${origin}/${assets.x}` ``  → `` `${origin}${assets.x}` ``
 *   • string concatenation      `'/' + assets.userAvatar`       → `assets.userAvatar`
 *                               `'https://cdn/' + assets.x`     → `'https://cdn' + assets.x`
 * `//${assets.x}` (a comment, or an intentional double slash) is left alone.
 */
export function rewriteServedPrefixes(src: string): { src: string; hits: ServedPrefixHit[] } {
  const hits: ServedPrefixHit[] = [];
  const norm = (e: string): string => e.replace(/\s+/g, '');
  // 1. the whole template is the prefixed interpolation.
  let out = src;
  for (const t of findServedPrefixTemplates(out).reverse()) {
    hits.push({ original: out.slice(t.start, t.end), expr: t.expr });
    out = out.slice(0, t.start) + t.expr + out.slice(t.end);
  }
  // 2. a `/` right before an interpolation inside a larger template.
  const inner = new RegExp(String.raw`\/(\$\{\s*(${ASSET_EXPR})\s*\})`, 'g');
  const edits: Array<{ at: number; len: number; text: string; hit: ServedPrefixHit }> = [];
  let m: RegExpExecArray | null;
  while ((m = inner.exec(out)) !== null) {
    if (out[m.index - 1] === '/') continue;            // `//${…}` — a comment or deliberate
    if (!inTemplateText(out, m.index)) continue;       // JSX text / a plain string: not interpolated
    edits.push({ at: m.index, len: m[0].length, text: m[1], hit: { original: m[0], expr: norm(m[2]) } });
  }
  // 3. `'…/' + assets.x` — a string literal ending in `/` concatenated with the URL.
  const concat = new RegExp(String.raw`(['"\`])([^'"\`\n$\\]*)\/\1(\s*\+\s*)(${ASSET_EXPR})`, 'g');
  while ((m = concat.exec(out)) !== null) {
    const [whole, q, head, , expr] = m;
    if (head.endsWith('/')) continue;                  // `'//' + …` — deliberate
    edits.push({ at: m.index, len: whole.length, text: head ? `${q}${head}${q} + ${expr}` : expr, hit: { original: whole, expr: norm(expr) } });
  }
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);
    hits.push(e.hit);
  }
  return { src: out, hits };
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
  /** asset-map path (OLD opaque pre-rename AND new) → symbolKey — the same index the
   *  flutter strategy re-points through (PG-15). */
  byPath?: Map<string, string>;
}

export async function repointWeb(
  projectRoot: string,
  assets: WebIndexedAsset[],
  opts: WebRepointOptions,
): Promise<{ repointed: WebRepoint[]; skipped: WebRepointSkip[]; warnings: string[]; filesScanned: number; skippedReason?: string }> {
  const repointed: WebRepoint[] = [];
  const skipped: WebRepointSkip[] = [];
  const warnings: string[] = [];

  const ix = await loadWebApp(projectRoot);
  const fromIx = ix?.resourcesFile && fsSync.existsSync(ix.resourcesFile)
    && parseDeclaredWebSymbols(await fs.readFile(ix.resourcesFile, 'utf-8')).size > 0 ? ix.resourcesFile : null;
  const resourcesFile = fromIx ?? findWebResourcesFile(projectRoot);
  if (!resourcesFile) {
    const reason = `no web resources module declaring asset symbols (looked for ${WEB_RESOURCES_RELS.join(', ')}) — nothing to re-point onto`;
    warnings.push(reason);
    return { repointed, skipped, warnings, filesScanned: 0, skippedReason: reason };
  }
  const declared = parseDeclaredWebSymbols(await fs.readFile(resourcesFile, 'utf-8'));

  // Every spelling of an asset path → its declared symbol: the resources file's own
  // values (what exists NOW) plus the asset-map's old + new paths (what the IR the
  // agent built from calls it — the opaque pre-rename names).
  const byKey = new Map<string, string>();
  for (const [sym, p] of declared) byKey.set(webAssetKey(p), sym);
  for (const [p, sym] of opts.byPath ?? []) {
    if (declared.has(sym) && !byKey.has(webAssetKey(p))) byKey.set(webAssetKey(p), sym);
  }
  const valuesAreUrls = [...declared.values()].every((v) => v.startsWith('/'));

  const imageAssets = assets.filter((a) => a.kind === 'image' && declared.has(a.symbolKey));

  // Every source root the shared resolver walks (src/, app/, components/, lib/,
  // pages/) — never just src/ (PG-17). Generated resources modules are not code
  // that USES assets (a legacy re-export included).
  const all = ix ? await listWebSources(ix) : await listSourceFiles(path.join(projectRoot, 'src'));
  const files: string[] = [];
  for (const f of all) {
    if (f === resourcesFile) continue;
    const head = await fs.readFile(f, 'utf-8').catch(() => '');
    if (head.includes('GENERATED by relay-server asset pass')) continue;
    files.push(f);
  }
  const targets = opts.onlyFiles?.length
    ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f)))
    : files;

  for (const file of targets) {
    let src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const before = src;
    const fileRel = rel(projectRoot, file);

    // ── (a) every `/`-prefixed composition → the URL itself (values are served URLs) ──
    if (valuesAreUrls) {
      const r = rewriteServedPrefixes(src);
      src = r.src;
      for (const h of r.hits) {
        repointed.push({ file: fileRel, from: 'served-url-prefix', original: h.original, symbol: h.expr.replace(/^assets\.?/, ''), how: 'deterministic' });
      }
    }

    // ── (b) raw path literals → assets.<symbol> ──────────────────────────────
    // Right-to-left so earlier offsets stay valid.
    for (const lit of findPathLiterals(src).reverse()) {
      const symbol = byKey.get(webAssetKey(lit.value));
      if (!symbol) {
        skipped.push({ file: fileRel, what: lit.value, reason: 'no declared asset symbol for this path (not in the resources module or the asset-map)' });
        continue;
      }
      const expr = `assets.${symbol}`;
      const replacement = lit.quote !== '`' && isJsxAttrValue(src, lit.start) ? `{${expr}}` : expr;
      src = src.slice(0, lit.start) + replacement + src.slice(lit.end);
      repointed.push({ file: fileRel, from: 'raw-path', original: lit.value, symbol, how: 'deterministic' });
    }

    // ── (c) hand-drawn <svg> standing in for a real asset ────────────────────
    // Reported, never rewritten: swapping a drawing for an <img> changes layout,
    // and a visual change belongs in the build loop's verify pass, not here.
    const svgs = findInlineSvgs(src);
    const art = svgs.filter((x) => x.scale === 'art');
    const glyphs = svgs.filter((x) => x.scale === 'icon');

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
        file: fileRel,
        what: `inline <svg> artwork (${art.length})`,
        reason: strong
          ? `HIGH: hand-drawn artwork where the design shipped \`assets.${strong.a.symbolKey}\` `
            + `(${strong.a.name}) — shared name tokens: ${strong.shared.join(', ')}. `
            + `Replace the drawing with <img src={assets.${strong.a.symbolKey}} />.`
          : `HIGH: hand-drawn artwork (art-sized inline <svg>) while the design exported ${imageAssets.length} real `
            + `image asset(s). Do not redraw a photo, map, avatar or illustration. Candidates: `
            + `${imageAssets.slice(0, 8).map((a) => `assets.${a.symbolKey} (${a.name})`).join('; ')}`
            + `${imageAssets.length > 8 ? `; …+${imageAssets.length - 8} more` : ''}. `
            + `Pick the one the reference actually shows and use <img src={assets.x} />.`,
      });
    }

    if (glyphs.length > 0 && declared.size > 0) {
      // An icon-sized glyph pairs with an ICON asset — the web analogue of Flutter's
      // `Icon(Icons.x)` substitution. We do NOT guess WHICH icon: a wrong pairing is
      // worse than none, and the symbol list is right there in the resources file.
      skipped.push({
        file: fileRel,
        what: `inline <svg> glyph (${glyphs.length})`,
        reason: `MED: ${glyphs.length} hand-drawn icon glyph(s) while the design exported real icon assets — `
          + `prefer <Icon name="…" /> (or <img src={assets.x} />) over redrawing the path data.`,
      });
    }

    if (src !== before) {
      // One `assets` binding per module: a file that already imports it (from the
      // legacy location or an alias) keeps that import.
      if (!/import\s*\{[^}]*\bassets\b[^}]*\}\s*from/.test(src)) {
        src = ensureNamedImport(src, WEB_RESOURCES_SYMBOL, importSpecFor(file, resourcesFile, src));
      }
      if (!opts.dryRun) await fs.writeFile(file, src, 'utf-8');
    }
  }

  return {
    repointed, skipped, warnings, filesScanned: targets.length,
    ...(targets.length === 0 ? { skippedReason: `no source files to scan (source roots: ${(ix?.sourceRoots ?? [path.join(projectRoot, 'src')]).map((r) => rel(projectRoot, r) || '.').join(', ')})` } : {}),
  };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { parseDeclaredWebSymbols, findPathLiterals, findInlineSvgs, findServedPrefixTemplates, rewriteServedPrefixes, tokensOf, escapeRe };
