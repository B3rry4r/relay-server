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

export interface WebTokenChange { file: string; kind: 'color' | 'spacing' | 'radius' | 'size' | 'add-token'; from: string; to: string }
export interface WebTokenReject { file: string; kind: string; literal: string; reason: string }

export interface WebTokenResult {
  themeFile: string | null;
  tokensAvailable: { colors: { name: string; argb: string }[]; spacing: { name: string; value: number }[]; radius: { name: string; value: number }[]; textStyles: string[] };
  substitutions: { colors: number; textStyles: number; spacing: number; radius: number; sizes?: number };
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
export function scanWebSizeSites(src: string): WebSizeSite[] {
  const sites: WebSizeSite[] = [];
  const num = (body: string, key: string, base: number): { value: number; start: number; end: number } | null => {
    const m = new RegExp(`(?<![\\w$-])${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)(?![\\w.])`).exec(body);
    return m ? { value: parseFloat(m[1]), start: base + m.index + m[0].length - m[1].length, end: base + m.index + m[0].length } : null;
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
    const dims = [w?.value, h?.value].filter((v): v is number => typeof v === 'number');
    if (br && dims.length && !circle && br.value * 2 >= Math.min(...dims)) sites.push({ family: 'pill', ...br });
  }
  // <img width={18} height={18}> / <Image width={40} height={40}>: a square JSX box
  for (const m of src.matchAll(/<([A-Za-z][\w.]*)\b([^<>]*?)\/?>/g)) {
    const attrs = m[2];
    const w = /\bwidth=\{(\d+(?:\.\d+)?)\}/.exec(attrs); const h = /\bheight=\{(\d+(?:\.\d+)?)\}/.exec(attrs);
    if (!w || !h || w[1] !== h[1]) continue;
    const v = parseFloat(w[1]);
    const fam = v < 28 ? 'icon' : /avatar/i.test(attrs) ? 'avatar' : v <= 120 ? 'tile' : null;
    if (!fam) continue;
    const base = m.index! + 1 + m[1].length;
    for (const a of [w, h]) { const at = base + a.index + a[0].length - 1 - a[1].length; sites.push({ family: fam, value: v, start: at, end: at + a[1].length, el: `j${base}` }); }
  }
  // <SomeIcon size={24} />
  for (const m of src.matchAll(/<([A-Z]\w*)\b[^>]*?\bsize=\{(\d+(?:\.\d+)?)\}/g)) {
    const at = m.index! + m[0].length - 1 - m[2].length;
    if (parseFloat(m[2]) <= 48) sites.push({ family: 'icon', value: parseFloat(m[2]), start: at, end: at + m[2].length });
  }
  return sites;
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
    for (const s of sites) if (s.family === fam && Number.isInteger(s.value) && !have.some((z) => z.value === s.value && z.name.startsWith(fam === 'button' ? 'buttonHeight' : fam))) els.set(s.value, (els.get(s.value) ?? new Set()).add(s.el ?? String(s.start)));
    const counts = new Map([...els].map(([v, set]) => [v, set.size]));
    for (const t of ladderNames(counts, ladder, md, 2)) {
      if (taken.has(t.name)) continue;
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
function substituteWebSizes(src: string, theme: WebThemeModel, onChange: (kind: 'size' | 'radius', from: string, to: string) => void): string {
  const sizes = theme.sizes ?? [];
  const pill = theme.radius.find((r) => r.name === 'pill');
  if (!sizes.length && !pill) return src;
  const sizeKey = theme.groupKeys.size ?? 'size';
  const sites = scanWebSizeSites(src).sort((a, b) => b.start - a.start);
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

  // F4/F5: recurring sized values with no token get ONE role-named entry in the
  // theme object (≥2 uses); the substitution below then uses it.
  {
    const allSites: WebSizeSite[] = [];
    for (const [fi, f] of targets.entries()) { const src = await fs.readFile(f, 'utf-8').catch(() => ''); if (src) allSites.push(...scanWebSizeSites(src).map((x) => ({ ...x, el: `${fi}:${x.el ?? x.start}` }))); }
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
    src = substituteWebSizes(src, themeM, (kind, from, to) => {
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

export const __test = { parseWebTheme, substituteColors, substituteNumeric, normColor };
