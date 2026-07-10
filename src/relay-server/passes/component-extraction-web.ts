/**
 * component-extraction-web.ts — Phase 7a for react + next.
 *
 * Collect the local (non-exported) function components declared inside screen files,
 * fingerprint each by JSX structure, and hoist a group that appears in ≥N screens
 * into `src/components/`.
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

import { listSourceFiles, ensureNamedImport, importPathBetween, escapeRe, stillReferenced } from './web-app';

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

/** Strategy.collectWidgets — every local (non-exported) JSX component in the screens. */
export async function collectWebWidgets(projectRoot: string, onlyFiles?: string[]): Promise<WebWidgetUnit[]> {
  const screensDir = path.join(projectRoot, 'src', 'screens');
  if (!fsSync.existsSync(screensDir)) return [];
  // *Preview.tsx is verify-harness scaffolding, not shipped UI. Hoisting a component
  // out of it would make the app depend on the harness.
  const files = (await listSourceFiles(screensDir)).filter((f) => !/Preview\.(tsx|jsx)$/.test(f));
  const targets = onlyFiles?.length ? files.filter((f) => onlyFiles.includes(path.basename(f))) : files;

  const units: WebWidgetUnit[] = [];
  for (const f of targets) {
    const src = await fs.readFile(f, 'utf-8').catch(() => '');
    if (src) units.push(...parseLocalComponents(src, f));
  }
  return units;
}

/** Strategy.extractGroup — hoist ONE duplicate group into src/components.
 *
 *  Returns null (a safe bail) when the sources are not identical modulo whitespace.
 *  Flutter parameterizes the differing literals into constructor args; doing the same
 *  for a JSX subtree means inventing props from token positions, and a wrong merge
 *  silently rewrites a screen that already matched its reference. A near-duplicate is
 *  worth reporting, not worth guessing. */
export async function extractWebGroup(
  projectRoot: string,
  group: WebWidgetUnit[],
  chosenName: string,
  kind: string,
  dryRun: boolean,
): Promise<WebExtracted | null> {
  const distinctFiles = new Set(group.map((u) => u.file));
  const bodies = new Set(group.map((u) => normalize(u.source.slice(u.source.indexOf('<')))));
  if (bodies.size > 1) return null;

  const componentsDir = path.join(projectRoot, 'src', 'components');
  const name = chosenName.replace(/^_+/, '');
  const componentPath = path.join(componentsDir, `${name}.tsx`);
  if (fsSync.existsSync(componentPath)) return null;   // never overwrite a real component

  if (!dryRun) {
    const source = group[0].source.replace(/^\s*/, '');
    await fs.mkdir(componentsDir, { recursive: true });
    await fs.writeFile(
      componentPath,
      `// extracted by relay-server phase 7a — shared by ${distinctFiles.size} screens\n`
        + `import React from 'react';\n\n`
        + `export ${source}\n`,
      'utf-8',
    );
    for (const file of distinctFiles) {
      let src = await fs.readFile(file, 'utf-8');
      for (const u of group.filter((x) => x.file === file)) {
        src = src.replace(u.source, '');
        src = src.replace(new RegExp(`\\b${escapeRe(u.localName)}\\b`, 'g'), name);
      }
      if (stillReferenced(src, name)) src = ensureNamedImport(src, name, importPathBetween(file, componentPath));
      await fs.writeFile(file, src.replace(/\n{3,}/g, '\n\n'), 'utf-8');
    }
  }

  return {
    name,
    kind: kind || kindOf(name),
    fromLocalNames: [...new Set(group.map((u) => u.localName))],
    usedIn: [...distinctFiles].map((f) => rel(projectRoot, f)),
    componentPath: rel(projectRoot, componentPath),
    occurrences: group.length,
  };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { parseLocalComponents, jsxStructuralSignature, extractDeclaration, matchDelim };
