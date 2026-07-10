/**
 * token-cleanup-web.ts — Phase 7f for react + next.
 *
 * Flutter substitutes `Color(0xFF1A1A1A)` → `AppTheme.ink` and strips dead private
 * consts. The web design system is `src/theme/theme.ts`:
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

import { listSourceFiles, ensureNamedImport, importPathBetween, stillReferenced } from './web-app';

export interface WebThemeModel {
  themeFile: string;
  themeSymbol: string;
  /** The group keys AS THEY APPEAR in the theme object — `space` vs `spacing`,
   *  `color` vs `colors`. Emitting the name we hoped for instead of the one that
   *  exists produces `AppTheme.spacing.sm` against a theme that only has `space`:
   *  337 type errors, every one of them ours. */
  groupKeys: { color: string | null; spacing: string | null; radius: string | null };
  colors: { name: string; value: string }[];
  spacing: { name: string; value: number }[];
  radius: { name: string; value: number }[];
  textStyles: string[];
}

export interface WebTokenChange { file: string; kind: 'color' | 'spacing' | 'radius'; from: string; to: string }
export interface WebTokenReject { file: string; kind: string; literal: string; reason: string }

export interface WebTokenResult {
  themeFile: string | null;
  tokensAvailable: { colors: { name: string; argb: string }[]; spacing: { name: string; value: number }[]; radius: { name: string; value: number }[]; textStyles: string[] };
  substitutions: { colors: number; textStyles: number; spacing: number; radius: number };
  removals: { imports: number; consts: number; methods: number };
  changes: WebTokenChange[];
  rejected: WebTokenReject[];
}

const THEME_RELS = ['src/theme/theme.ts', 'src/theme/index.ts', 'src/theme.ts'];

/** Parse the nested `export const AppTheme = { color: {...}, radius: {...} }` object. */
export function parseWebTheme(projectRoot: string): WebThemeModel | null {
  const themeFile = THEME_RELS.map((r) => path.join(projectRoot, r)).find((p) => fsSync.existsSync(p));
  if (!themeFile) return null;
  const src = fsSync.readFileSync(themeFile, 'utf-8');
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
  return {
    themeFile,
    themeSymbol: decl[1],
    groupKeys: {
      color: firstKey('color', 'colors'),
      spacing: firstKey('spacing', 'space'),
      radius: firstKey('radius', 'radii'),
    },
    colors,
    spacing,
    radius,
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
    changes: [], rejected: [],
  };

  const theme = parseWebTheme(projectRoot);
  if (!theme) return empty;

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

  const srcDir = path.join(projectRoot, 'src');
  const files = (await listSourceFiles(srcDir)).filter((f) => f !== theme.themeFile);
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;

  for (const file of targets) {
    const before = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!before) continue;
    let src = before;
    const relFile = rel(projectRoot, file);

    src = substituteColors(src, theme, (from, to) => {
      result.substitutions.colors++;
      result.changes.push({ file: relFile, kind: 'color', from, to });
    });
    src = substituteNumeric(src, theme, RADIUS_PROPS, theme.radius, theme.groupKeys.radius, (from, to) => {
      result.substitutions.radius++;
      result.changes.push({ file: relFile, kind: 'radius', from, to });
    });
    src = substituteNumeric(src, theme, SPACING_PROPS, theme.spacing, theme.groupKeys.spacing, (from, to) => {
      result.substitutions.spacing++;
      result.changes.push({ file: relFile, kind: 'spacing', from, to });
    });

    if (src !== before) src = ensureNamedImport(src, theme.themeSymbol, importPathBetween(file, theme.themeFile));

    const pruned = removeDeadImports(src);
    src = pruned.src;
    result.removals.imports += pruned.removed;

    if (src !== before && !opts.dryRun) await fs.writeFile(file, src, 'utf-8');
  }

  return result;
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { parseWebTheme, substituteColors, substituteNumeric, normColor };
