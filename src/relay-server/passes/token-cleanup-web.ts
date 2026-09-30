/**
 * token-cleanup-web.ts — Phase 7f for react + next.
 *
 * Flutter substitutes `Color(0xFF1A1A1A)` → `AppTheme.ink` and strips dead private
 * consts. The web design system is the theme module Pre-flight recorded in
 * `.uix/design-system.json` (react `src/theme/theme.ts`, next `<root>/lib/theme/theme.ts`):
 *
 *   export const AppTheme = {
 *     color:   { ink: '#1a1a1a', … },
 *     radius:  { xl: 24, … },
 *     spacing: { s8: 8, … },
 *   } as const;
 *
 * So the substitutions are: a hex/rgba string literal that exactly equals a colour
 * token → `AppTheme.color.<name>`; a numeric literal in an unambiguous spacing or
 * radius position → `AppTheme.spacing.<name>` / `AppTheme.radius.<name>`.
 *
 * Conservative by construction — exact value match only, never a nearest-token
 * guess, and never inside the theme file itself (it DEFINES the tokens).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { loadWebApp, listWebSources, ensureNamedImport, importSpecFor, stillReferenced } from './web-app';
import { DESIGN_SYSTEM_RECORD } from '../design-system';
import { ladderNames } from '../design-vocabulary';
import { planVocabularyAmendment } from './token-vocabulary';

export interface WebThemeModel {
  themeFile: string;
  themeSymbol: string;
  /** The group keys AS THEY APPEAR in the theme object — `space` vs `spacing`,
   *  `color` vs `colors`. Emitting the name we hoped for instead of the one that
   *  exists produces `AppTheme.spacing.sm` against a theme that only has `space`:
   *  337 type errors, every one of them ours. */
  groupKeys: { color: string | null; spacing: string | null; radius: string | null; size?: string | null };
  colors: { name: string; value: string }[];
  spacing: { name: string; value: number }[];
  radius: { name: string; value: number }[];
  /** F4/F5: role-named sizes (`size: { iconMd: 24, buttonHeight: 56 }`). */
  sizes?: { name: string; value: number }[];
  textStyles: string[];
}

export interface WebTokenChange { file: string; kind: 'color' | 'spacing' | 'radius' | 'size' | 'add-token' | 'rename-token'; from: string; to: string }
export interface WebTokenReject { file: string; kind: string; literal: string; reason: string }

export interface WebTokenResult {
  themeFile: string | null;
  tokensAvailable: { colors: { name: string; argb: string }[]; spacing: { name: string; value: number }[]; radius: { name: string; value: number }[]; textStyles: string[] };
  substitutions: { colors: number; textStyles: number; spacing: number; radius: number; sizes?: number; renamed?: number };
  removals: { imports: number; consts: number; methods: number };
  /** F4/F5: vocabulary added to the theme module (recurring values, role-named). */
  vocabulary?: { added: string[]; renamed: Array<{ from: string; to: string }> };
  changes: WebTokenChange[];
  rejected: WebTokenReject[];
  /** Source files read. 0 = examined nothing. */
  filesScanned: number;
  /** Set when there was no input (no theme module / no sources). */
  skippedReason?: string;
}

const THEME_RELS = ['src/theme/theme.ts', 'src/theme/index.ts', 'src/theme.ts'];

/** Where the web theme module lives, most authoritative first (PG-18):
 *   1. the design-system contract Pre-flight recorded (`.uix/design-system.json`
 *      `themeFile` — `src/theme/theme.ts` on react, `<root>/lib/theme/theme.ts` on
 *      next, CONTRACTS §5);
 *   2. the shared resolver's `themeFile` (web-app.ts — every §5 location);
 *   3. the legacy react locations (THEME_RELS). */
export function locateWebTheme(projectRoot: string, resolverThemeFile?: string | null): string | null {
  try {
    const rec = JSON.parse(fsSync.readFileSync(path.join(projectRoot, DESIGN_SYSTEM_RECORD), 'utf-8')) as { themeFile?: unknown };
    if (typeof rec.themeFile === 'string' && /\.(ts|tsx|js)$/.test(rec.themeFile)) {
      const abs = path.join(projectRoot, rec.themeFile);
      if (fsSync.existsSync(abs)) return abs;
    }
  } catch { /* no record (older run / hand-made app) */ }
  if (resolverThemeFile && fsSync.existsSync(resolverThemeFile)) return resolverThemeFile;
  return THEME_RELS.map((r) => path.join(projectRoot, r)).find((p) => fsSync.existsSync(p)) ?? null;
}

/** Why 7f did not run on a web app — worded so it can never claim an absent theme
 *  when one exists (B12 fix round: on Next the old reason named only src/theme/ and
 *  said "no web theme module" beside a real lib/theme/theme.ts). A theme module that
 *  exists but whose token object the parser does not understand is "not read", with
 *  its path; only a project with no theme file anywhere gets "no theme module". */
export function webThemeSkipReason(projectRoot: string, themeFile: string | null): string {
  if (themeFile) {
    return `the token pass does not support the shape of this app's theme module: ${rel(projectRoot, themeFile)} was not read (it has no \`export const <Name> = { color: {…}, … }\` token object the parser understands) — PG-18`;
  }
  return `no web theme module in this app (looked in ${DESIGN_SYSTEM_RECORD}, the resolver's theme locations — lib/theme/theme.ts and src/lib/theme/theme.ts on Next — and ${THEME_RELS.join(', ')})`;
}

/** Parse the nested `export const AppTheme = { color: {...}, radius: {...} }` object. */
export function parseWebTheme(projectRoot: string, resolverThemeFile?: string | null): WebThemeModel | null {
  const themeFile = locateWebTheme(projectRoot, resolverThemeFile);
  if (!themeFile) return null;
  return parseWebThemeSource(fsSync.readFileSync(themeFile, 'utf-8'), themeFile);
}

/** Parse a theme module's source (the object parser behind parseWebTheme). */
export function parseWebThemeSource(src: string, themeFile: string): WebThemeModel | null {
  const decl = /export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*\{/.exec(src);
  if (!decl) return null;
  const foundKeys = new Set<string>();
  const firstKey = (...names: string[]): string | null => names.find((n) => foundKeys.has(n)) ?? null;

  const group = (name: string): string | null => {
    const re = new RegExp(`\\b${name}\\s*:\\s*\\{`);
    const m = re.exec(src);
    if (!m) return null;
    foundKeys.add(name);
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index + m[0].length, i); }
    }
    return null;
  };

  const strEntries = (body: string | null): { name: string; value: string }[] => {
    if (!body) return [];
    const out: { name: string; value: string }[] = [];
    const re = /([A-Za-z0-9_$]+)\s*:\s*(['"])([^'"]+)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push({ name: m[1], value: m[3] });
    return out;
  };
  const numEntries = (body: string | null): { name: string; value: number }[] => {
    if (!body) return [];
    const out: { name: string; value: number }[] = [];
    const re = /([A-Za-z0-9_$]+)\s*:\s*(-?[\d.]+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push({ name: m[1], value: parseFloat(m[2]) });
    return out;
  };

  const textBody = group('text') ?? group('typography') ?? group('type');
  const colors = strEntries(group('color') ?? group('colors'));
  const spacing = numEntries(group('spacing') ?? group('space'));
  const radius = numEntries(group('radius') ?? group('radii'));
  const sizes = numEntries(group('size') ?? group('sizes'));
  return {
    themeFile,
    themeSymbol: decl[1],
    groupKeys: {
      color: firstKey('color', 'colors'),
      spacing: firstKey('spacing', 'space'),
      radius: firstKey('radius', 'radii'),
      size: firstKey('size', 'sizes'),
    },
    colors,
    spacing,
    radius,
    sizes,
    textStyles: textBody ? [...new Set([...textBody.matchAll(/([A-Za-z0-9_$]+)\s*:/g)].map((m) => m[1]))] : [],
  };
}

const normColor = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, '');

/** Replace hex / rgba string literals whose value exactly equals a colour token.
 *
 *  A literal in JSX ATTRIBUTE position (`fill="#f59e0b"`) must become an expression
 *  container — `fill={AppTheme.color.x}`. Substituting the bare expression produces
 *  `fill=AppTheme.color.x`, which is a syntax error, not a token. */
function substituteColors(src: string, theme: WebThemeModel, onChange: (from: string, to: string) => void): string {
  const byValue = new Map<string, string>();
  for (const c of theme.colors) if (!byValue.has(normColor(c.value))) byValue.set(normColor(c.value), c.name);
  const groupKey = theme.groupKeys.color;
  if (!groupKey) return src;
  const isJsxAttr = (before: string): boolean => /[A-Za-z_$][A-Za-z0-9_$-]*\s*=\s*$/.test(before);
  return src.replace(/(['"])(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\1/g, (full, _q: string, val: string, offset: number) => {
    const name = byValue.get(normColor(val));
    if (!name) return full;
    const token = `${theme.themeSymbol}.${groupKey}.${name}`;
    const replacement = isJsxAttr(src.slice(Math.max(0, offset - 40), offset)) ? `{${token}}` : token;
    onChange(val, replacement);
    return replacement;
  });
}

/** Only unambiguous positions: `borderRadius: 24` and the spacing props. A bare 24
 *  in `fontSize` or `width` is not a radius, whatever the token table says. */
const SPACING_PROPS = ['gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
const RADIUS_PROPS = ['borderRadius'];

function substituteNumeric(
  src: string, theme: WebThemeModel, props: string[], tokens: { name: string; value: number }[],
  groupKey: string | null, onChange: (from: string, to: string) => void,
): string {
  if (tokens.length === 0 || !groupKey) return src;
  const byValue = new Map<number, string>();
  for (const t of tokens) if (!byValue.has(t.value)) byValue.set(t.value, t.name);
  const re = new RegExp(`\\b(${props.join('|')})\\s*:\\s*(\\d+(?:\\.\\d+)?)\\b`, 'g');
  return src.replace(re, (full, prop: string, num: string) => {
    const name = byValue.get(parseFloat(num));
    if (!name) return full;
    const to = `${theme.themeSymbol}.${groupKey}.${name}`;
    onChange(`${prop}: ${num}`, `${prop}: ${to}`);
    return `${prop}: ${to}`;
  });
}

// ── F4/F5: sizes, pills, vocabulary amendment (web) ───────────────────────────

/** Object literals `{ … }` in a source with their numeric width/height/borderRadius. */
interface WebSizeSite { family: 'icon' | 'avatar' | 'tile' | 'button' | 'pill'; value: number; start: number; end: number; /** one element (a square's width + height are ONE use). */ el?: string }

/** Square style objects (`{ width: 24, height: 24 }`), control heights next to a text
 *  child, JSX `size={24}` on icon components, and stadium radii (≥ half the box). */
export function scanWebSizeSites(src: string, resolve?: (expr: string) => number | null, box: WebBoxContext = {}): WebSizeSite[] {
  const sites: WebSizeSite[] = [];
  // `resolve` (planning only) also counts a position already holding a token
  // (`width: AppTheme.size.iconMd`) as a use of its value, so a second run plans the
  // same ladder as the first — 7f converges. Substitution never passes it.
  const V = '(\\d+(?:\\.\\d+)?|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+)';
  const valueOf = (t: string): number | null => (/^\d/.test(t) ? parseFloat(t) : resolve ? resolve(t) : null);
  const num = (body: string, key: string, base: number): { value: number; start: number; end: number } | null => {
    const m = new RegExp(`(?<![\\w$-])${key}\\s*:\\s*${V}(?![\\w.])`).exec(body);
    if (!m) return null;
    const value = valueOf(m[1]);
    return value == null ? null : { value, start: base + m.index + m[0].length - m[1].length, end: base + m.index + m[0].length };
  };
  // innermost `{ … }` object literals (style objects are flat)
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1];
    const base = m.index! + 1;
    if (!/\b(width|height|borderRadius)\s*:/.test(body)) continue;
    const w = num(body, 'width', base); const h = num(body, 'height', base);
    const br = num(body, 'borderRadius', base);
    const circle = !!br && !!w && !!h && w.value === h.value && br.value * 2 >= w.value;
    if (w && h && w.value === h.value) {
      const fam = w.value < 28 ? 'icon' : circle ? 'avatar' : w.value <= 120 ? 'tile' : null;
      if (fam) { sites.push({ family: fam, ...w, el: `o${base}` }); sites.push({ family: fam, ...h, el: `o${base}` }); }
    } else if (h && !w && h.value >= 36 && h.value <= 64) {
      sites.push({ family: 'button', ...h });
    }
    // A pill only when the RENDERED box is provably a stadium already (see
    // stadiumIsExact): CSS `height` is the content box, so padding or a border
    // makes the painted box taller and `borderRadius: 20` on `height: 40` is then a
    // rounded rectangle — 9999 would change pixels.
    if (br && !circle && stadiumIsExact(src, m.index!, body, br.value, box)) sites.push({ family: 'pill', ...br });
  }
  // <img width={18} height={18}> / <Image width={40} height={40}>: a square JSX box
  for (const m of src.matchAll(/<([A-Za-z][\w.]*)\b([^<>]*?)\/?>/g)) {
    const attrs = m[2];
    const w = new RegExp(`\\bwidth=\\{${V}\\}`).exec(attrs); const h = new RegExp(`\\bheight=\\{${V}\\}`).exec(attrs);
    if (!w || !h) continue;
    const wv = valueOf(w[1]); const hv = valueOf(h[1]);
    if (wv == null || hv == null || wv !== hv) continue;
    const v = wv;
    const fam = v < 28 ? 'icon' : /avatar/i.test(attrs) ? 'avatar' : v <= 120 ? 'tile' : null;
    if (!fam) continue;
    const base = m.index! + 1 + m[1].length;
    for (const a of [w, h]) { const at = base + a.index + a[0].length - 1 - a[1].length; sites.push({ family: fam, value: v, start: at, end: at + a[1].length, el: `j${base}` }); }
  }
  // <SomeIcon size={24} />
  for (const m of src.matchAll(new RegExp(`<([A-Z]\\w*)\\b[^>]*?\\bsize=\\{${V}\\}`, 'g'))) {
    const v = valueOf(m[2]);
    if (v == null) continue;
    const at = m.index! + m[0].length - 1 - m[2].length;
    if (v <= 48) sites.push({ family: 'icon', value: v, start: at, end: at + m[2].length });
  }
  return sites;
}

/** What the box-model check needs beyond the source: token values (a padding that
 *  7f already turned into `AppTheme.spacing.s10` must still count as 10 on run 2) and
 *  whether the app resets every element to `box-sizing: border-box`. */
export interface WebBoxContext { resolve?: (expr: string) => number | null; borderBox?: boolean }

/** Does the app's global CSS reset every element to border-box? (Tailwind's preflight
 *  does, as do most resets: `*, ::before, ::after { box-sizing: border-box }`.) */
export function detectGlobalBorderBox(cssSources: string[]): boolean {
  return cssSources.some((css) => /@tailwind\s+base\b|@import\s+["']tailwindcss(?:\/preflight)?(?:\.css)?["']/.test(css)
    || /(?:^|[}\s,])\*\s*(?:,[^{}]*)?\{[^{}]*box-sizing\s*:\s*border-box/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
}

/** A flat object-literal body → key → raw value text (top-level commas only). A
 *  spread (`...base`) is recorded as the key `...` — its keys are unknown. */
function objectEntries(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const push = (seg: string): void => {
    const t = seg.trim();
    if (!t) return;
    if (t.startsWith('...')) { out.set('...', t); return; }
    const m = /^(?:(['"])([\w-]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(t);
    if (m) out.set(m[2] ?? m[3], m[4].trim());
    else out.set('?', t);
  };
  let depth = 0; let q: string | null = null; let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { push(body.slice(start, i)); start = i + 1; }
  }
  push(body.slice(start));
  return out;
}

/** CSS lengths in a style value: `10`, `'10px'`, `'4px 8px'`, `0`, or a token
 *  expression the resolver knows. null = not provably a pixel length. */
function cssLengths(raw: string, resolve?: (expr: string) => number | null): number[] | null {
  const t = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return [parseFloat(t)];
  const s = /^(['"`])([^'"`$]*)\1$/.exec(t);
  if (s) {
    const parts = s[2].trim().split(/\s+/).filter(Boolean);
    const vals = parts.map((p) => /^(\d+(?:\.\d+)?)(?:px)?$/.exec(p));
    return parts.length && vals.every((v) => v) ? vals.map((v) => parseFloat(v![1])) : null;
  }
  const r = resolve?.(t);
  return r == null ? null : [r];
}

/** CSS 1–4 value shorthand → [top, right, bottom, left]. */
function fourSides(v: number[]): [number, number, number, number] | null {
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  if (v.length === 3) return [v[0], v[1], v[2], v[1]];
  if (v.length === 4) return [v[0], v[1], v[2], v[3]];
  return null;
}

/** A `border` / `borderTop` shorthand's width: `'1px solid #eee'` → 1, `'none'` → 0,
 *  a style with no width → 3 (CSS `medium`). null = unknown. */
function borderShorthandWidth(raw: string, resolve?: (expr: string) => number | null): number | null {
  const t = raw.trim();
  if (/^0$/.test(t)) return 0;
  const s = /^(['"`])([^'"`$]*)\1$/.exec(t);
  if (!s) { const r = resolve?.(t); return r ?? null; }
  const parts = s[2].trim().split(/\s+/);
  const w = parts.map((p) => /^(\d+(?:\.\d+)?)(?:px)?$/.exec(p)).find((x) => x);
  if (w) return parseFloat(w[1]);
  if (parts.some((p) => /^(none|hidden)$/.test(p))) return 0;
  if (parts.some((p) => /^(thin)$/.test(p))) return 1;
  if (parts.some((p) => /^(medium|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(p))) return parts.includes('thick') ? 5 : 3;
  return null;
}

const INLINE_TAGS = new Set(['span', 'a', 'em', 'strong', 'b', 'i', 'small', 'label', 'code', 'abbr', 'cite', 'q', 's', 'u', 'sub', 'sup', 'time', 'mark', 'kbd', 'var', 'bdi', 'bdo', 'data', 'dfn']);
/** Elements every engine's UA sheet sizes as border-box. */
const UA_BORDER_BOX_TAGS = new Set(['button', 'select']);

/** The JSX element a `style={{ … }}` object belongs to: its tag and whether it also
 *  takes a className (whose padding we cannot see). null = not a JSX style prop. */
function styleOwner(src: string, open: number, close: number): { tag: string; className: boolean } | null {
  const before = src.slice(0, open);
  if (!/\bstyle=\{\s*$/.test(before)) return null;
  const t = /<([A-Za-z][\w.]*)(?=[\s/>])[^<]*$/.exec(before);
  if (!t) return null;
  // the tag's remaining attributes: up to its `>` / `/>` at brace depth 0 (`=>` is not a close)
  let depth = 0; let end = close + 1;
  for (; end < src.length; end++) {
    const c = src[end];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0 && src[end - 1] !== '=') break;
  }
  const attrs = before.slice(t.index) + src.slice(close + 1, end);
  return { tag: t[1], className: /\bclass(?:Name)?=/.test(attrs) };
}

/**
 * Is `borderRadius: r` on this style object ALREADY a full stadium in the browser, so
 * the pill token (9999) paints the same pixels? CSS clamps a uniform radius r to
 * min(W, H) / 2 of the BORDER box, so it is exact iff 2r ≥ min(W, H). The border box
 * is only bounded when the object proves it: an explicit px width/height, padding
 * and border widths we can read (content-box adds them; border-box includes them),
 * no min-size that could grow it, no flex growth on an axis we would rely on, and an
 * element whose width/height apply at all (not an inline `<span>`). A className on
 * a content-box element could add padding we cannot see — not provable.
 */
export function stadiumIsExact(src: string, open: number, body: string, r: number, box: WebBoxContext = {}): boolean {
  const e = objectEntries(body);
  if (e.has('...') || e.has('?')) return false;
  const res = box.resolve;
  const owner = styleOwner(src, open, open + body.length + 1);
  const bs = e.get('boxSizing')?.replace(/['"`\s]/g, '');
  let borderBox: boolean;
  if (bs === 'border-box') borderBox = true;
  else if (bs === 'content-box') borderBox = false;
  else if (bs != null) return false;
  else if (owner && UA_BORDER_BOX_TAGS.has(owner.tag)) borderBox = true;
  else borderBox = !!box.borderBox;
  if (!owner && !borderBox) return false;                               // unknown element, content-box: padding unknowable
  if (owner && /^[A-Z]|\./.test(owner.tag) && !borderBox) return false;  // a component may add its own padding
  if (owner && owner.className && !borderBox) return false;
  const display = e.get('display')?.replace(/['"`\s]/g, '');
  if (display === 'inline' || display === 'contents' || display === 'none') return false;
  if (!display && owner && INLINE_TAGS.has(owner.tag)) return false;   // width/height do not apply
  // padding + border per side [top, right, bottom, left]
  const pad: [number, number, number, number] = [0, 0, 0, 0];
  const brd: [number, number, number, number] = [0, 0, 0, 0];
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;
  for (const [k, raw] of e) {
    if (k === 'padding') { const v = cssLengths(raw, res); const f = v && fourSides(v); if (!f) return false; f.forEach((x, i) => { pad[i] = x; }); }
  }
  for (const [k, raw] of e) {
    const side = /^padding(Top|Right|Bottom|Left)$/.exec(k);
    const logical = /^padding(Block|Inline)$/.exec(k);
    if (side) { const v = cssLengths(raw, res); if (!v || v.length !== 1) return false; pad[SIDES.indexOf(side[1] as typeof SIDES[number])] = v[0]; }
    else if (logical) { const v = cssLengths(raw, res); if (!v || v.length > 2) return false; const [a, b] = [v[0], v[1] ?? v[0]]; if (logical[1] === 'Block') { pad[0] = a; pad[2] = b; } else { pad[3] = a; pad[1] = b; } }
    else if (/^padding/.test(k) && k !== 'padding') return false;
  }
  for (const [k, raw] of e) {
    if (!/^border/.test(k) || /Radius$|Color$/.test(k)) continue;
    if (k === 'border') { const w = borderShorthandWidth(raw, res); if (w == null) return false; brd.fill(w); continue; }
    if (k === 'borderWidth') { const v = cssLengths(raw, res); const f = v && fourSides(v); if (!f) return false; f.forEach((x, i) => { brd[i] = x; }); continue; }
  }
  for (const [k, raw] of e) {
    if (!/^border/.test(k) || /Radius$|Color$/.test(k) || k === 'border' || k === 'borderWidth') continue;
    const sh = /^border(Top|Right|Bottom|Left)$/.exec(k);
    const sw = /^border(Top|Right|Bottom|Left)Width$/.exec(k);
    if (sh) { const w = borderShorthandWidth(raw, res); if (w == null) return false; brd[SIDES.indexOf(sh[1] as typeof SIDES[number])] = w; }
    else if (sw) { const v = cssLengths(raw, res); if (!v || v.length !== 1) return false; brd[SIDES.indexOf(sw[1] as typeof SIDES[number])] = v[0]; }
    else return false;                                                  // borderStyle alone (medium width), borderImage, logical borders …
  }
  const dim = (key: 'width' | 'height'): number | null => {
    const raw = e.get(key);
    if (raw == null) return null;
    const v = cssLengths(raw, res);
    return v && v.length === 1 ? v[0] : null;
  };
  const bound = (key: 'width' | 'height', a: number, b: number): number | null => {
    const d = dim(key);
    if (d == null) return null;
    const extra = pad[a] + pad[b] + brd[a] + brd[b];
    let used = borderBox ? Math.max(d, extra) : d + extra;
    const minKey = key === 'width' ? 'minWidth' : 'minHeight';
    if (e.has(minKey)) { const mv = cssLengths(e.get(minKey)!, res); if (!mv || mv.length !== 1) return null; used = Math.max(used, mv[0]); }
    return used;
  };
  const W = bound('width', 3, 1);
  const H = bound('height', 0, 2);
  const flex = e.get('flex') ?? e.get('flexGrow');
  const grows = flex != null && !/^(['"`]?)(?:0(?:\.0+)?(?:\s[^'"`]*)?|none)\1$/.test(flex.trim());
  if (grows || e.has('flexBasis')) return W != null && H != null && 2 * r >= W && 2 * r >= H;
  return (W != null && 2 * r >= W) || (H != null && 2 * r >= H);
}

const WEB_LADDERS: Array<[WebSizeSite['family'], string[], number]> = [
  ['icon', ['iconXs', 'iconSm', 'iconMd', 'iconLg', 'iconXl'], 2],
  ['avatar', ['avatarSm', 'avatar', 'avatarLg'], 1],
  ['tile', ['tileXs', 'tileSm', 'tile', 'tileLg', 'tileXl'], 2],
  ['button', ['buttonHeightSm', 'buttonHeight', 'buttonHeightLg'], 1],
];

/** Plan the size / pill tokens to add (≥2 uses, role-named, whole pixels). */
export function planWebVocabulary(theme: WebThemeModel, sites: WebSizeSite[]): { sizes: Array<{ name: string; value: number }>; pill: boolean } {
  const have = theme.sizes ?? [];
  const taken = new Set(have.map((z) => z.name));
  const sizes: Array<{ name: string; value: number }> = [];
  for (const [fam, ladder, md] of WEB_LADDERS) {
    const els = new Map<number, Set<string>>();
    const tokened = (v: number): boolean => have.some((z) => z.value === v && z.name.startsWith(fam === 'button' ? 'buttonHeight' : fam));
    // token-held positions are counted too (see scanWebSizeSites `resolve`): the
    // ladder stays the one the first run planned; tokened values are skipped.
    for (const s of sites) if (s.family === fam && Number.isInteger(s.value)) els.set(s.value, (els.get(s.value) ?? new Set()).add(s.el ?? String(s.start)));
    const counts = new Map([...els].map(([v, set]) => [v, set.size]));
    for (const t of ladderNames(counts, ladder, md, 2)) {
      if (tokened(t.value) || taken.has(t.name)) continue;
      taken.add(t.name); sizes.push({ name: t.name, value: t.value });
    }
  }
  const pill = new Set(sites.filter((s) => s.family === 'pill').map((s) => s.el ?? String(s.start))).size >= 2 && !theme.radius.some((r) => r.name === 'pill');
  return { sizes, pill };
}

/** Add entries to the theme object's `size` / `radius` groups (creating `size`). */
export function amendWebThemeSource(src: string, theme: WebThemeModel, plan: { sizes: Array<{ name: string; value: number }>; pill: boolean }): string {
  let out = src;
  const addToGroup = (key: string, entries: string[]): boolean => {
    const m = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(out);
    if (!m) return false;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) {
          const inner = out.slice(m.index + m[0].length, i);
          const sep = inner.trim() ? (inner.trimEnd().endsWith(',') ? ' ' : ', ') : ' ';
          out = `${out.slice(0, i).replace(/\s*$/, '')}${sep}${entries.join(', ')} ${out.slice(i)}`;
          return true;
        }
      }
    }
    return false;
  };
  if (plan.pill && theme.groupKeys.radius) addToGroup(theme.groupKeys.radius, ['pill: 9999']);
  if (plan.sizes.length) {
    const entries = plan.sizes.map((z) => `${z.name}: ${z.value}`);
    if (!(theme.groupKeys.size && addToGroup(theme.groupKeys.size, entries))) {
      // no size group yet: add one before the object's closing `}` (`} as const`)
      const decl = new RegExp(`export\\s+const\\s+${theme.themeSymbol}\\s*=\\s*\\{`).exec(out);
      if (decl) {
        let depth = 0;
        for (let i = decl.index + decl[0].length - 1; i < out.length; i++) {
          if (out[i] === '{') depth++;
          else if (out[i] === '}') { depth--; if (depth === 0) { out = `${out.slice(0, i).replace(/,?\s*$/, ',')}\n  size: { ${entries.join(', ')} },\n${out.slice(i)}`; break; } }
        }
      }
    }
  }
  return out;
}

/** Replace sized literals with the theme's size / pill tokens. */
function substituteWebSizes(src: string, theme: WebThemeModel, box: WebBoxContext, onChange: (kind: 'size' | 'radius', from: string, to: string) => void): string {
  const sizes = theme.sizes ?? [];
  const pill = theme.radius.find((r) => r.name === 'pill');
  if (!sizes.length && !pill) return src;
  const sizeKey = theme.groupKeys.size ?? 'size';
  const sites = scanWebSizeSites(src, undefined, box).sort((a, b) => b.start - a.start);
  let out = src;
  const done = new Set<number>();
  for (const s of sites) {
    if (done.has(s.start)) continue;
    let to: string | null = null;
    if (s.family === 'pill') { if (pill && theme.groupKeys.radius) to = `${theme.themeSymbol}.${theme.groupKeys.radius}.pill`; }
    else {
      const prefix = s.family === 'button' ? 'buttonHeight' : s.family;
      const tok = sizes.find((z) => z.value === s.value && z.name.startsWith(prefix));
      if (tok) to = `${theme.themeSymbol}.${sizeKey}.${tok.name}`;
    }
    if (!to) continue;
    // JSX attribute value `size={24}` keeps its braces; the number is replaced inside them.
    const from = out.slice(s.start, s.end);
    out = out.slice(0, s.start) + to + out.slice(s.end);
    done.add(s.start);
    onChange(s.family === 'pill' ? 'radius' : 'size', from, to);
  }
  return out;
}

/** F4 (web): counter-named colour keys (`neutral1`, `ink2`, `accent2` — what the
 *  pre-F4 design system wrote into theme.ts) → role names, with the same planner
 *  the Flutter side uses. Only `#rrggbb` values are classified. Pure. */
export function planWebColorRenames(theme: WebThemeModel, refs: Map<string, number>): Array<{ from: string; to: string }> {
  const colors = theme.colors.flatMap((c) => {
    const h = /^#([0-9a-fA-F]{6})$/.exec(c.value.trim());
    return h ? [{ name: c.name, argb: `ff${h[1].toLowerCase()}` }] : [];
  });
  return planVocabularyAmendment({
    className: theme.themeSymbol, themeFileRel: '', colors, spacing: theme.spacing, radius: theme.radius,
    sizes: theme.sizes ?? [], corners: [],
  }, [], refs).renames;
}

/** Rewrite one source for the colour renames: `AppTheme.color.<from>` member
 *  references and `var(--color-<from>)` / `--color-<from>:` CSS custom properties. */
export function applyWebColorRenames(src: string, theme: WebThemeModel, renames: Array<{ from: string; to: string }>): { src: string; count: number } {
  let count = 0;
  let out = src;
  const key = theme.groupKeys.color ?? 'color';
  for (const r of renames) {
    out = out.replace(new RegExp(`\\b${theme.themeSymbol}\\.${key}\\.${r.from}\\b`, 'g'), () => { count++; return `${theme.themeSymbol}.${key}.${r.to}`; });
    out = out.replace(new RegExp(`--color-${r.from}(?![\\w-])`, 'g'), () => { count++; return `--color-${r.to}`; });
  }
  return { src: out, count };
}

/** Unused local `const X = …` at module scope, and imports nothing references. */
function removeDeadImports(src: string): { src: string; removed: number } {
  let removed = 0;
  const out = src.replace(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"];?\s*$\n?/gm, (full, names: string) => {
    const kept = names.split(',').map((n) => n.trim()).filter(Boolean).filter((n) => stillReferenced(src, n.split(/\s+as\s+/).pop()!.trim()));
    if (kept.length === names.split(',').map((n) => n.trim()).filter(Boolean).length) return full;
    if (kept.length === 0) { removed++; return ''; }
    removed++;
    return full.replace(/\{[^}]*\}/, `{ ${kept.join(', ')} }`);
  });
  return { src: out, removed };
}

export interface WebTokenOptions { dryRun?: boolean; onlyFiles?: string[] }

export async function deepenWebTokens(projectRoot: string, opts: WebTokenOptions): Promise<WebTokenResult> {
  const empty: WebTokenResult = {
    themeFile: null,
    tokensAvailable: { colors: [], spacing: [], radius: [], textStyles: [] },
    substitutions: { colors: 0, textStyles: 0, spacing: 0, radius: 0 },
    removals: { imports: 0, consts: 0, methods: 0 },
    changes: [], rejected: [], filesScanned: 0,
  };

  const ix = await loadWebApp(projectRoot);
  const themeAt = locateWebTheme(projectRoot, ix?.themeFile ?? null);
  const parsed = themeAt ? parseWebThemeSource(fsSync.readFileSync(themeAt, 'utf-8'), themeAt) : null;
  if (!parsed) return { ...empty, skippedReason: webThemeSkipReason(projectRoot, themeAt) };
  let theme: WebThemeModel = parsed;

  const result: WebTokenResult = {
    ...empty,
    themeFile: rel(projectRoot, theme.themeFile),
    tokensAvailable: {
      colors: theme.colors.map((c) => ({ name: c.name, argb: c.value })),
      spacing: theme.spacing,
      radius: theme.radius,
      textStyles: theme.textStyles,
    },
    changes: [], rejected: [],
  };

  // Every resolver source root (src/, app/, components/, lib/, pages/) — a Next app's
  // screens live under app/, never only src/ (PG-18). Previews are not walked.
  const roots = ix?.sourceRoots ?? [path.join(projectRoot, 'src')];
  const files = (await listWebSources({ sourceRoots: roots })).filter((f) => f !== theme.themeFile);
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;

  result.filesScanned = targets.length;
  if (targets.length === 0) result.skippedReason = `no source files to scan under ${roots.map((r) => rel(projectRoot, r) || '.').join(', ')}`;

  // Does the app's global CSS make every element border-box? (the pill check needs it)
  const globalBorderBox = detectGlobalBorderBox(await readProjectCss(projectRoot, roots));

  // F4/F5: recurring sized values with no token get ONE role-named entry in the
  // theme object (≥2 uses); the substitution below then uses it.
  {
    const allSites: WebSizeSite[] = [];
    const sizeKey = theme.groupKeys.size ?? 'size';
    const radiusKey = theme.groupKeys.radius ?? 'radius';
    const tokenValues = new Map<string, number>([
      ...(theme.sizes ?? []).map((z) => [`${theme.themeSymbol}.${sizeKey}.${z.name}`, z.value] as [string, number]),
      ...theme.radius.map((z) => [`${theme.themeSymbol}.${radiusKey}.${z.name}`, z.value] as [string, number]),
    ]);
    const resolve = (expr: string): number | null => tokenValues.get(expr) ?? null;
    for (const [fi, f] of targets.entries()) { const src = await fs.readFile(f, 'utf-8').catch(() => ''); if (src) allSites.push(...scanWebSizeSites(src, resolve, boxContext(theme, globalBorderBox)).map((x) => ({ ...x, el: `${fi}:${x.el ?? x.start}` }))); }
    const plan = planWebVocabulary(theme, allSites);
    if (plan.sizes.length || plan.pill) {
      const cur = fsSync.readFileSync(theme.themeFile, 'utf-8');
      const next = amendWebThemeSource(cur, theme, plan);
      const reparsed = next !== cur ? parseWebThemeSource(next, theme.themeFile) : null;
      if (reparsed) {
        if (!opts.dryRun) await fs.writeFile(theme.themeFile, next, 'utf-8');
        const added = [...plan.sizes.map((z) => `${z.name}=${z.value}`), ...(plan.pill ? ['pill'] : [])];
        result.vocabulary = { added, renamed: [] };
        for (const a of added) result.changes.push({ file: rel(projectRoot, theme.themeFile), kind: 'add-token', from: '', to: a });
        theme = reparsed;
        result.tokensAvailable.radius = theme.radius;
      }
    }
  }
  // F4 (web): counter-named colour keys get their role name across the theme
  // module, its CSS custom properties and every reference.
  {
    const key = theme.groupKeys.color ?? 'color';
    const refs = new Map<string, number>();
    const srcs = new Map<string, string>();
    for (const f of targets) {
      const src = await fs.readFile(f, 'utf-8').catch(() => '');
      srcs.set(f, src);
      for (const m of src.matchAll(new RegExp(`\\b${theme.themeSymbol}\\.${key}\\.([A-Za-z_$][\\w$]*)`, 'g'))) refs.set(m[1], (refs.get(m[1]) ?? 0) + 1);
    }
    const renames = planWebColorRenames(theme, refs);
    if (renames.length) {
      const themeSrc = fsSync.readFileSync(theme.themeFile, 'utf-8');
      let nextTheme = themeSrc;
      for (const r of renames) nextTheme = nextTheme.replace(new RegExp(`(?<![\\w$-])${r.from}(?=\\s*:)`, 'g'), r.to);
      nextTheme = applyWebColorRenames(nextTheme, theme, renames).src;
      const reparsed = parseWebThemeSource(nextTheme, theme.themeFile);
      if (reparsed && reparsed.colors.length === theme.colors.length) {
        let refCount = 0;
        const writes: Array<[string, string]> = [[theme.themeFile, nextTheme]];
        // the CSS mirror (theme.css next to theme.ts, or the design-system record's cssFile)
        const cssFiles = new Set<string>();
        try {
          const rec = JSON.parse(fsSync.readFileSync(path.join(projectRoot, DESIGN_SYSTEM_RECORD), 'utf-8')) as { cssFile?: unknown };
          if (typeof rec.cssFile === 'string') cssFiles.add(path.resolve(projectRoot, rec.cssFile));
        } catch { /* no record */ }
        const sibling = theme.themeFile.replace(/\.[cm]?[jt]sx?$/, '.css');
        if (sibling !== theme.themeFile) cssFiles.add(sibling);
        for (const css of cssFiles) {
          if (!fsSync.existsSync(css)) continue;
          const before = fsSync.readFileSync(css, 'utf-8');
          const r = applyWebColorRenames(before, theme, renames);
          if (r.count) writes.push([css, r.src]);
        }
        for (const [f, src] of srcs) {
          const r = applyWebColorRenames(src, theme, renames);
          if (r.count) { writes.push([f, r.src]); refCount += r.count; }
        }
        if (!opts.dryRun) for (const [f, src] of writes) await fs.writeFile(f, src, 'utf-8');
        result.substitutions.renamed = refCount;
        result.vocabulary = { added: result.vocabulary?.added ?? [], renamed: renames };
        for (const r of renames) result.changes.push({ file: rel(projectRoot, theme.themeFile), kind: 'rename-token', from: r.from, to: r.to });
        theme = reparsed;
        result.tokensAvailable.colors = theme.colors.map((c) => ({ name: c.name, argb: c.value }));
      }
    }
  }
  const themeM = theme;
  for (const file of targets) {
    const before = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!before) continue;
    let src = before;
    const relFile = rel(projectRoot, file);

    src = substituteColors(src, theme, (from, to) => {
      result.substitutions.colors++;
      result.changes.push({ file: relFile, kind: 'color', from, to });
    });
    src = substituteWebSizes(src, themeM, boxContext(themeM, globalBorderBox), (kind, from, to) => {
      if (kind === 'size') result.substitutions.sizes = (result.substitutions.sizes ?? 0) + 1;
      else result.substitutions.radius++;
      result.changes.push({ file: relFile, kind, from, to });
    });
    src = substituteNumeric(src, theme, RADIUS_PROPS, theme.radius.filter((r) => r.name !== 'pill'), theme.groupKeys.radius, (from, to) => {
      result.substitutions.radius++;
      result.changes.push({ file: relFile, kind: 'radius', from, to });
    });
    src = substituteNumeric(src, theme, SPACING_PROPS, theme.spacing, theme.groupKeys.spacing, (from, to) => {
      result.substitutions.spacing++;
      result.changes.push({ file: relFile, kind: 'spacing', from, to });
    });

    if (src !== before) src = ensureNamedImport(src, theme.themeSymbol, importSpecFor(file, theme.themeFile, src));

    const pruned = removeDeadImports(src);
    src = pruned.src;
    result.removals.imports += pruned.removed;

    if (src !== before && !opts.dryRun) await fs.writeFile(file, src, 'utf-8');
  }

  return result;
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

/** Every theme numeric token (spacing, radius, size) → its value, for the box check. */
function boxContext(theme: WebThemeModel, borderBox: boolean): WebBoxContext {
  const vals = new Map<string, number>();
  const add = (key: string | null | undefined, list: Array<{ name: string; value: number }> | undefined): void => {
    if (!key || !list) return;
    for (const t of list) vals.set(`${theme.themeSymbol}.${key}.${t.name}`, t.value);
  };
  add(theme.groupKeys.spacing, theme.spacing);
  add(theme.groupKeys.radius, theme.radius);
  add(theme.groupKeys.size ?? 'size', theme.sizes);
  return { resolve: (expr) => vals.get(expr) ?? null, borderBox };
}

/** The app's stylesheets: every .css under the source roots and the usual global files. */
async function readProjectCss(projectRoot: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let ents: fsSync.Dirent[];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) await walk(f, depth + 1);
      else if (/\.(css|scss)$/.test(d.name) && !seen.has(f)) { seen.add(f); out.push(await fs.readFile(f, 'utf-8').catch(() => '')); }
    }
  };
  for (const r of [...roots, path.join(projectRoot, 'styles')]) await walk(r, 0);
  return out;
}

export const __test = { parseWebTheme, substituteColors, substituteNumeric, normColor };
