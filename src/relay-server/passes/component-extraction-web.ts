/**
 * component-extraction-web.ts — Phase 7a for react + next.
 *
 * Collect the local (non-exported) function components declared inside screen files,
 * fingerprint each by JSX structure, and hoist a group that appears in ≥N screens
 * into the app's components dir (react `src/components/`, Next `components/` beside a
 * root `app/` — CONTRACTS §5). Screens come from the shared resolver, so Next
 * `app/…/page.tsx` pages are read (PG-07).
 *
 * Where Flutter parameterizes differing literals into constructor args, this pass
 * merges only groups whose sources are IDENTICAL modulo whitespace. Inventing props
 * for a JSX subtree means rewriting every call site with values inferred from token
 * positions — plausible, and wrong often enough that a near-duplicate is reported
 * as `rejected` for a human (or the build loop) instead. Extracting a duplicate that
 * is not really a duplicate silently changes a screen that already matched its
 * reference.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  loadWebApp, listSourceFiles, listWebSources, resolveSpecifier, ensureNamedImport, importPathBetween, importSpecFor, escapeRe, stillReferenced,
  EXTRACTED_COMPONENT_MARKER,
} from './web-app';

export interface WebWidgetUnit {
  localName: string;
  file: string;
  source: string;
  signature: string;
}

export interface WebExtracted {
  name: string;
  kind: string;
  fromLocalNames: string[];
  usedIn: string[];
  componentPath: string;
  occurrences: number;
}

/**
 * Component declarations in a screen file — `function Foo(…) {` or
 * `const Foo = (…) =>`, exported or not.
 *
 * The Dart pass looks for PRIVATE `_Foo` widgets because Flutter screens inline
 * their sub-widgets. The generated web app does the opposite: it exports one
 * component per file. Restricting to non-exported declarations found exactly one
 * candidate across twenty screens — and that one was a `const BUILDINGS` array.
 * So: take exported components too, and exclude the things that are not reusable
 * units — the screen/page entry points, the verify-harness previews, and
 * SCREAMING_CASE data constants.
 */
function parseLocalComponents(src: string, file: string): WebWidgetUnit[] {
  const out: WebWidgetUnit[] = [];
  const re = /^(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z][A-Za-z0-9_$]*)\s*\(|const\s+([A-Z][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] ?? m[2];
    if (!/^[A-Z][a-z]/.test(name)) continue;              // SCREAMING_CASE data, not a component
    if (/(?:Screen|Page|Preview)$/.test(name)) continue;  // entry points / harness, never hoisted
    const body = extractDeclaration(src, m.index);
    if (!body) continue;
    if (!/<[A-Za-z]/.test(body)) continue;                // no JSX → not a component
    const signature = jsxStructuralSignature(body);
    if (!signature) continue;
    out.push({ localName: name, file, source: body, signature });
  }
  return out;
}

/**
 * The full text of a component declaration starting at `start`.
 *
 * The naive "count brackets from the declaration keyword" approach closes on the
 * PARAMETER LIST — `function Card(props)` balances at `)` — and returns a signature
 * line with no JSX in it. Skip the params, then match the real body: a brace block
 * for `function`/`=> {`, or a paren expression for `=> (`.
 */
function extractDeclaration(src: string, start: number): string | null {
  const isFn = /^\s*(?:export\s+)?(?:default\s+)?function\b/.test(src.slice(start, start + 40));
  let bodyStart: number;

  if (isFn) {
    const open = src.indexOf('(', start);
    if (open === -1) return null;
    const close = matchDelim(src, open, '(', ')');
    if (close === -1) return null;
    bodyStart = src.indexOf('{', close);
    if (bodyStart === -1) return null;
  } else {
    const arrow = src.indexOf('=>', start);
    if (arrow === -1) return null;
    bodyStart = arrow + 2;
    while (bodyStart < src.length && /\s/.test(src[bodyStart])) bodyStart++;
  }

  const opener = src[bodyStart];
  if (opener !== '{' && opener !== '(') return null;
  const end = matchDelim(src, bodyStart, opener, opener === '{' ? '}' : ')');
  if (end === -1) return null;
  return src.slice(start, end + 1);
}

/** Index of the delimiter matching the one at `open`. String- and comment-aware. */
function matchDelim(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) return -1; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i === -1) return -1; i++; continue; }
    if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Structural fingerprint of a JSX body: element names and prop KEYS are structural;
 * string literals, numbers, and value identifiers collapse. Two cards with different
 * copy and colours share a signature; a card with an extra child does not.
 */
export function jsxStructuralSignature(body: string): string {
  const jsx = body.slice(body.indexOf('<'));
  if (!jsx) return '';
  const tokens: string[] = [];
  const re = /<\/?([A-Za-z][A-Za-z0-9_.$]*)|([a-zA-Z][a-zA-Z0-9_$]*)\s*=|(['"`])(?:\\.|(?!\3)[^\\])*\3|-?\d+(?:\.\d+)?|[{}()[\],;]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsx)) !== null) {
    if (m[1]) tokens.push(`<${m[1]}`);          // element name — structural
    else if (m[2]) tokens.push(`${m[2]}=`);     // prop key — structural
    else if (m[3]) tokens.push('S');            // string literal — value
    else if (/^-?\d/.test(m[0])) tokens.push('N');
    else tokens.push(m[0]);
  }
  return tokens.join(' ');
}

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

const kindOf = (name: string): string =>
  /button|pill|cta/i.test(name) ? 'button'
    : /field|input|otp|pin/i.test(name) ? 'input'
      : /logo|badge|icon/i.test(name) ? 'brand'
        : /heading|title|label/i.test(name) ? 'text'
          : 'component';

/** The files a web app's screens are made of, from the shared resolver (PG-07):
 *  every indexed (non-placeholder) screen file — Next `app/…/page.tsx` included —
 *  plus every other module under the resolver's screen root (a sibling panel beside
 *  its screen). Verify-harness previews are never read: hoisting a component out of
 *  one would make the app depend on the harness. */
export async function webScreenFiles(projectRoot: string): Promise<string[]> {
  const ix = await loadWebApp(projectRoot);
  if (!ix) return [];
  const out = new Set<string>();
  for (const s of [...ix.byId.values(), ...ix.byRoute.values()]) {
    if (!s.placeholder && s.file !== ix.routerFile && fsSync.existsSync(s.file)) out.add(s.file);
  }
  if (fsSync.existsSync(ix.screensDir)) for (const f of await listSourceFiles(ix.screensDir)) out.add(f);
  return [...out].filter((f) => !/Preview\.(tsx|jsx)$/.test(f)).sort();
}

/** Strategy.collectWidgets — every JSX component declared inside the screen files. */
export async function collectWebWidgets(projectRoot: string, onlyFiles?: string[]): Promise<WebWidgetUnit[]> {
  const files = await webScreenFiles(projectRoot);
  const targets = onlyFiles?.length ? files.filter((f) => onlyFiles.includes(path.basename(f))) : files;
  const units: WebWidgetUnit[] = [];
  for (const f of targets) {
    const src = await fs.readFile(f, 'utf-8').catch(() => '');
    if (src) units.push(...parseLocalComponents(src, f));
  }
  return units;
}

/** Where a hoisted component lands: the resolver's components dir (CONTRACTS §5 —
 *  `components/` beside a root `app/`, `src/components` on react / `src/app`). */
export async function webComponentsDir(projectRoot: string): Promise<string> {
  const ix = await loadWebApp(projectRoot);
  return ix?.componentsDir ?? path.join(projectRoot, 'src', 'components');
}

// ── Import bookkeeping ───────────────────────────────────────────────────────

export interface ImportBinding {
  local: string;
  /** `default` | `*` | the exported name. */
  imported: string;
  spec: string;
  typeOnly: boolean;
}

/** Every binding of every static `import … from '…'` statement (default, namespace,
 *  named with `as`, `import type`, inline `type` specifiers). */
export function parseImportBindings(src: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const re = /^import\s+(type\s+)?([^'";]*?)\s+from\s*['"]([^'"]+)['"];?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const stmtType = !!m[1];
    const clause = m[2].trim();
    const spec = m[3];
    const braces = /\{([^}]*)\}/.exec(clause);
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,\s*$/, '').trim().replace(/,$/, '').trim();
    for (const part of head.split(',').map((x) => x.trim()).filter(Boolean)) {
      const ns = /^\*\s+as\s+([A-Za-z0-9_$]+)$/.exec(part);
      if (ns) out.push({ local: ns[1], imported: '*', spec, typeOnly: stmtType });
      else if (/^[A-Za-z0-9_$]+$/.test(part)) out.push({ local: part, imported: 'default', spec, typeOnly: stmtType });
    }
    if (braces) {
      for (const raw of braces[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const t = /^type\s+/.test(raw);
        const [imp, loc] = raw.replace(/^type\s+/, '').split(/\s+as\s+/).map((x) => x.trim());
        out.push({ local: loc ?? imp, imported: imp, spec, typeOnly: stmtType || t });
      }
    }
  }
  return out;
}

/** Render bindings as import statements, one per specifier. */
function renderImports(bindings: ImportBinding[]): string {
  const bySpec = new Map<string, ImportBinding[]>();
  for (const b of bindings) bySpec.set(b.spec, [...(bySpec.get(b.spec) ?? []), b]);
  const lines: string[] = [];
  for (const [spec, bs] of bySpec) {
    const ns = bs.find((b) => b.imported === '*');
    if (ns) lines.push(`import ${ns.typeOnly ? 'type ' : ''}* as ${ns.local} from '${spec}';`);
    const def = bs.find((b) => b.imported === 'default');
    const named = bs.filter((b) => b.imported !== 'default' && b.imported !== '*');
    const allType = [def, ...named].filter(Boolean).every((b) => b!.typeOnly);
    const namedTxt = named.map((b) => `${!allType && b.typeOnly ? 'type ' : ''}${b.imported === b.local ? b.local : `${b.imported} as ${b.local}`}`).join(', ');
    if (def || named.length) {
      const parts = [def ? def.local : '', named.length ? `{ ${namedTxt} }` : ''].filter(Boolean).join(', ');
      lines.push(`import ${allType ? 'type ' : ''}${parts} from '${spec}';`);
    }
  }
  return lines.join('\n');
}

/** Re-path a specifier written in `fromFile` so it resolves identically from `toFile`.
 *  Packages and tsconfig aliases (`@/…`) resolve the same from anywhere — kept. */
function repathSpecifier(spec: string, fromFile: string, toFile: string): string {
  if (!spec.startsWith('.')) return spec;
  const target = resolveSpecifier(fromFile, spec);
  if (target) return importPathBetween(toFile, target);
  let r = path.relative(path.dirname(toFile), path.resolve(path.dirname(fromFile), spec)).split(path.sep).join('/');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

/** Remove the given local bindings from `src`'s import statements (dropping a
 *  statement left empty). Only bindings named here are touched. */
function dropImportBindings(src: string, locals: Set<string>): string {
  if (!locals.size) return src;
  return src.replace(/^import\s+(type\s+)?([^'";]*?)\s+from\s*(['"][^'"]+['"]);?[ \t]*\n?/gm, (full, t: string | undefined, _clause: string, specQ: string) => {
    const bs = parseImportBindings(full.trim().endsWith(';') ? full : `${full.trim()};`);
    const keep = bs.filter((b) => !locals.has(b.local));
    if (keep.length === bs.length) return full;
    if (!keep.length) return '';
    return `${renderImports(keep.map((b) => ({ ...b, typeOnly: b.typeOnly || !!t })))}\n`.replace(/'[^']+'(;\n)$/, `${specQ}$1`);
  });
}

/** Names declared at module scope (functions, classes, const/let/var, types, enums). */
function topLevelNames(src: string): Set<string> {
  const out = new Set<string>();
  const re = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

const usesIdent = (code: string, name: string): boolean => new RegExp(`(?<![.\\w$])${escapeRe(name)}(?![\\w$])`).test(code);

/** Strip string literals and comments so an identifier test never matches inside text. */
const codeOnly = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');

/** Strategy.extractGroup — hoist ONE duplicate group into the components dir.
 *
 *  Returns `{bail}` (a safe, reported bail) when the sources are not identical modulo
 *  whitespace. Flutter parameterizes the differing literals into constructor args;
 *  doing the same for a JSX subtree means inventing props from token positions, and a
 *  wrong merge silently rewrites a screen that already matched its reference. A
 *  near-duplicate is worth reporting, not worth guessing.
 *
 *  The hoisted module is self-sufficient (PG-08): an existing `export`/`default`
 *  modifier is stripped before re-exporting, every import the body references is
 *  carried over (re-pathed from the new file), `'use client'` is kept when a source
 *  had it, and the screens drop the imports only the hoisted body used. */
export async function extractWebGroup(
  projectRoot: string,
  group: WebWidgetUnit[],
  chosenName: string,
  kind: string,
  dryRun: boolean,
): Promise<WebExtracted | { bail: string }> {
  const distinctFiles = [...new Set(group.map((u) => u.file))];
  const bodies = new Set(group.map((u) => normalize(u.source.slice(u.source.indexOf('<')))));
  if (bodies.size > 1) return { bail: 'near-duplicate: the declarations differ beyond whitespace — web merges byte-identical components only' };

  const componentsDir = await webComponentsDir(projectRoot);
  const name = chosenName.replace(/^_+/, '');
  const componentPath = path.join(componentsDir, `${name}.tsx`);
  const decl = group[0].source.replace(/^\s*/, '').replace(/^export\s+(?:default\s+)?/, '');
  // Rename the declaration itself when the chosen name differs from the local one.
  const declNamed = decl.replace(new RegExp(`^((?:async\\s+)?function\\s+|const\\s+)${escapeRe(group[0].localName)}\\b`), `$1${name}`);

  // Reuse an identical component already hoisted there (a screen built after the
  // last finalize re-declared it); never overwrite a different one.
  let reuse = false;
  if (fsSync.existsSync(componentPath)) {
    const existing = await fs.readFile(componentPath, 'utf-8');
    const theirs = parseLocalComponents(existing, componentPath).find((u) => u.localName === name);
    if (!theirs || normalize(theirs.source.slice(theirs.source.indexOf('<'))) !== normalize(declNamed.slice(declNamed.indexOf('<')))) {
      return { bail: `${rel(projectRoot, componentPath)} already exists with a different ${name} — never overwritten` };
    }
    reuse = true;
  }

  // Everything the body references must come with it: imports are carried; a
  // module-level helper of the screen (a const table, another local component) is
  // not something we can move blind → bail and report.
  const bodyCode = codeOnly(declNamed.replace(/^[^(]*/, ''));
  const carried: ImportBinding[] = [];
  const perFileUsedImports = new Map<string, Set<string>>();
  let useClient = false;
  for (const file of distinctFiles) {
    const src = await fs.readFile(file, 'utf-8');
    if (/^\s*(?:\/\/[^\n]*\n\s*)*['"]use client['"]/.test(src)) useClient = true;
    const imports = parseImportBindings(src);
    const used = new Set<string>();
    for (const b of imports) {
      if (!usesIdent(bodyCode, b.local)) continue;
      used.add(b.local);
      const spec = repathSpecifier(b.spec, file, componentPath);
      if (!carried.some((c) => c.local === b.local)) carried.push({ ...b, spec });
      else if (carried.find((c) => c.local === b.local)!.spec !== spec) {
        return { bail: `\`${b.local}\` resolves to different modules in ${distinctFiles.map((f) => rel(projectRoot, f)).join(' and ')}` };
      }
    }
    perFileUsedImports.set(file, used);
    const own = new Set(group.filter((u) => u.file === file).map((u) => u.localName));
    const helpers = [...topLevelNames(src)].filter((n) => !own.has(n) && !imports.some((b) => b.local === n) && usesIdent(bodyCode, n));
    if (helpers.length) return { bail: `the body uses ${helpers.map((h) => `\`${h}\``).join(', ')} declared in ${rel(projectRoot, file)} — hoisting it alone would not compile` };
  }

  if (!dryRun) {
    if (!reuse) {
      await fs.mkdir(componentsDir, { recursive: true });
      const header = `${useClient ? "'use client';\n" : ''}${EXTRACTED_COMPONENT_MARKER} — shared by ${distinctFiles.length} screens\n`;
      const imports = renderImports(carried);
      await fs.writeFile(componentPath, `${header}${imports ? `${imports}\n` : ''}\nexport ${declNamed}\n`, 'utf-8');
    }
    for (const file of distinctFiles) {
      let src = await fs.readFile(file, 'utf-8');
      const hoistedFromHere = group.filter((x) => x.file === file);
      for (const u of hoistedFromHere) {
        src = src.replace(u.source, '');
        if (u.localName !== name) src = src.replace(new RegExp(`\\b${escapeRe(u.localName)}\\b`, 'g'), name);
      }
      // Imports only the hoisted body used, now unreferenced in this screen.
      const drop = new Set([...(perFileUsedImports.get(file) ?? [])].filter((n) => !stillReferenced(src, n)));
      src = dropImportBindings(src, drop);
      if (stillReferenced(src, name)) src = ensureNamedImport(src, name, importSpecFor(file, componentPath, src));
      await fs.writeFile(file, src.replace(/\n{3,}/g, '\n\n'), 'utf-8');
      // A hoisted component that was EXPORTED from the screen may be imported by
      // other modules: point them at the shared file.
      if (group.some((u) => u.file === file && /^\s*export\b/.test(u.source))) {
        await repointImporters(projectRoot, file, [...new Set(hoistedFromHere.map((u) => u.localName))], name, componentPath);
      }
    }
  }

  return {
    name,
    kind: kind || kindOf(name),
    fromLocalNames: [...new Set(group.map((u) => u.localName))],
    usedIn: distinctFiles.map((f) => rel(projectRoot, f)),
    componentPath: rel(projectRoot, componentPath),
    occurrences: group.length,
  };
}

/** Rewrite `import { Old } from '<screen>'` in every other source to the shared file. */
async function repointImporters(projectRoot: string, screenFile: string, oldNames: string[], name: string, componentPath: string): Promise<void> {
  const ix = await loadWebApp(projectRoot);
  if (!ix) return;
  for (const f of await listWebSources(ix)) {
    if (f === screenFile || f === componentPath) continue;
    let src = await fs.readFile(f, 'utf-8').catch(() => '');
    if (!src) continue;
    const hit = parseImportBindings(src).filter((b) => oldNames.includes(b.imported) && resolveSpecifier(f, b.spec) === screenFile);
    if (!hit.length) continue;
    src = dropImportBindings(src, new Set(hit.map((b) => b.local)));
    for (const b of hit) {
      if (b.local !== name) src = src.replace(new RegExp(`\\b${escapeRe(b.local)}\\b`, 'g'), name);
    }
    src = ensureNamedImport(src, name, importSpecFor(f, componentPath, src));
    await fs.writeFile(f, src, 'utf-8');
  }
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { parseLocalComponents, jsxStructuralSignature, extractDeclaration, matchDelim, parseImportBindings, renderImports, dropImportBindings };
