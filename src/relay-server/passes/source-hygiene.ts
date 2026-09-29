/**
 * source-hygiene.ts — framework-agnostic source clean-up used by Phase 7h
 * (production hygiene) on flutter, react and next (readability F1 + F6).
 *
 *  1. PROVENANCE STRIP (F6). Build agents narrate where a value came from in the
 *     comments they write — `(IR "Ellipse 2797–2800", 27×27 each)`, `(modal
 *     m_313_10287 / frame 81)`, `(added by /identity-verification)`. Ping shipped 68
 *     such comments (and every repair pass added more). They describe the design
 *     FILE, not the code, and mean nothing to the team the app is handed to. The
 *     strip removes the provenance fragment and keeps the behavioural sentence
 *     around it; a comment line left with no content is dropped. It only ever
 *     touches COMMENTS (a scanner that skips strings), and never a pipeline marker
 *     line (`// canonicalId: … route: …`, `GENERATED …`, `componentId:` …) — the
 *     canonicalId header is how every pass resolves a screen.
 *
 *  2. STUB COMPONENTS (F1). A shared-component file the skeleton wrote as a stub
 *     (`GENERATED SKELETON` / a `SizedBox.shrink()` body) that NO other source
 *     imports is dead weight a reader still has to open. It is deleted. A stub that
 *     something still imports is kept and reported (deleting it would break the
 *     build).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ── 1. Provenance strip ─────────────────────────────────────────────────────

/** Figma layer-type words that, followed by a number, are a layer NAME ("Rectangle 24"). */
const LAYER_WORDS = 'Frame|Group|Rectangle|Rect|Vector|Ellipse|Polygon|Star|Line|Union|Subtract|Intersect|Exclude|Mask|Layer|Instance|Slice';

/** One provenance token. Kept in sync with scripts/readability-report.cjs `figmaLeak`
 *  so the strip and the metric agree on what provenance is. */
const PROV_SRC = [
  String.raw`\bcanonicalId\s+[cm]_\d+_\d+\b`,
  String.raw`\b[cm]_\d+_\d+\b`,
  String.raw`\bI?\d{1,6}[:;]\d{2,7}(?:;\d+:\d+)*\b`,
  String.raw`\b(?:frames?|ref|node)\s*#?\s?\d{2,}(?:\s*(?:[/,&–-]|and)\s*\d{2,})*(?:\s*(?:—|–|-|:)\s*"[^"]*")?`,
  String.raw`\bIR(?:\s+(?:image\s+)?(?:"[^"]*"|'[^']*'))?(?:\s*\/\s*"[^"]*")*`,
  String.raw`\bFigma\b`,
  String.raw`\badded by \/[\w/-]*`,
  String.raw`\b(?:matches?|per) the (?:reference|design|ref)(?:'s)?\b`,
  String.raw`"?\b(?:${LAYER_WORDS}) \d+(?:\s*[–-]\s*\d+)?\b"?`,
  String.raw`\b\d+(?:\.\d+)?\s*×\s*\d+(?:\.\d+)?(?:\s*(?:px|pt))?(?:\s+each)?\b`,
  // a device-preset FRAME name ("iPhone 14 & 15 Pro - 85") and `frame "<name>"`
  String.raw`\bframe\s+"[^"]*"`,
  String.raw`"(?:iPhone|iPad|Android|Pixel|Galaxy|Desktop|MacBook)\b[^"]*"`,
];
const PROV_ANY = new RegExp(PROV_SRC.join('|'));
const PROV_G = new RegExp(PROV_SRC.join('|'), 'g');

/** A pipeline marker comment — never edited (the canonicalId header, GENERATED banners). */
const MARKER_RE = /GENERATED|write-locked|DO NOT EDIT|^\s*(canonicalId|componentId|states|modals|tabCluster|route):/i;

/** Does this comment text carry provenance? */
export function hasProvenance(text: string): boolean {
  return PROV_ANY.test(text);
}

/** Provenance that is a sentence SUBJECT ("Frame 83 shows …", "IR nodes are …"):
 *  the sentence was about the design file and cannot stand without it. A pixel size
 *  at the start ("7×7 finder squares") is only an adjective — the token goes, the
 *  sentence stays. */
const SUBJECT_PROV = new RegExp(PROV_SRC.filter((p) => !p.includes('×')).join('|'));

/** A sentence that now ends on one of these was cut mid-thought. */
const DANGLING = /\b(?:is|are|was|were|be|been|a|an|the|of|at|in|on|to|with|by|from|for|into|onto|over|under|as|and|or|sits|uses|shows|than)$/i;

/** Words (≥2 letters) left once provenance is gone — does a fragment still say anything? */
const wordCount = (s: string): number => (s.replace(PROV_G, ' ').match(/[A-Za-z]{2,}/g) ?? []).length;

/** Clean one comment line (no `//` prefix): sentence-lead provenance drops the
 *  sentence, any other token goes with its joining punctuation, then tidy. Leading
 *  indentation and a list bullet are preserved. */
function cleanLine(line: string): string {
  if (MARKER_RE.test(line) || !hasProvenance(line)) return line;
  const lead = /^(\s*(?:[-*•]\s+)?)/.exec(line)![1];
  let s = line.slice(lead.length).trimStart();
  s = s.split(/(?<=[.;!?])\s+/).filter((sent) => {
    const m = SUBJECT_PROV.exec(sent.replace(/^["'`]+/, ''));
    return !(m && m.index === 0);
  }).join(' ');
  // Remove tokens sentence by sentence: a sentence whose removal leaves it hanging on
  // a function word ("Dots are 27×27 each." → "Dots are.") goes whole.
  const TOKEN_RE = new RegExp(String.raw`(?:\s*[,;:]|\s+(?:—|–|-|\/)|\s+(?:in|at|on|from|of|see|via|for|by))?\s*(?:${PROV_SRC.join('|')})`, 'g');
  s = s.split(/(?<=[.;!?])\s+/).map((sent) => {
    const cut = sent.replace(TOKEN_RE, '');
    if (cut === sent) return sent;
    const body = cut.replace(/[\s.;!?,:]+$/, '');
    return DANGLING.test(body) || !/[A-Za-z]{2,}/.test(body) ? '' : cut;
  }).filter((x) => x.trim()).join(' ');
  s = s
    .replace(/\bframes?\s*(?=[/,;)]|$)/g, '')          // a bare "frame" left behind by its id
    .replace(/\(\s*[,;/—–-]*\s*\)/g, '')
    .replace(/(\S)[ \t]+([,.;:!?)])/g, '$1$2')
    .replace(/([(])\s+/g, '$1')
    .replace(/(?:\s*[,;/—–-])+\s*([.:!?]?)\s*$/, '$1')
    .replace(/^\s*(?:[.,;:—–-]+|\/(?![\w-]))\s*/, '')
    .trimEnd();
  if (!s.replace(/[\s•*\-–—"'`.,;:()/[\]]/g, '').length) return '';
  return lead + s;
}

/**
 * Clean a run of comment lines (prefix already removed), treated as ONE text so a
 * parenthetical that wraps onto the next line is handled whole. A parenthetical
 * carrying provenance keeps only what still says something ("(push, frame 92)" →
 * "(push)"; "(IR \"Icons\" 24×24 slot)" → gone). Returns the new lines; a line that
 * was non-empty and is now empty is removed (an originally blank separator stays).
 */
export function stripProvenanceLines(lines: string[]): string[] {
  let text = lines.join('\n');
  if (!hasProvenance(text)) return lines;
  for (let guard = 0; guard < 6; guard++) {
    const next = text.replace(/[ \t]*\(([^()]*)\)/g, (m, inner: string) => {
      if (!hasProvenance(inner)) return m;
      const cleaned = inner.split('\n').map((l) => cleanLine(l)).filter((l) => l.trim()).join(' ').trim();
      // A parenthetical that wrapped keeps its line breaks AFTER it, so the
      // comment's line structure (and length) survives.
      const breaks = '\u0002'.repeat((inner.match(/\n/g) ?? []).length);
      return (wordCount(cleaned) >= 2 ? ` (${cleaned})` : '\u0001') + breaks;
    });
    if (next === text) break;
    text = next;
  }
  // \u0001 = a removed parenthetical, \u0002 = a line break it carried: re-break
  // there, and drop the whitespace a removal leaves at the start of a line.
  text = text.replace(/\u0002[ \t]*/g, '\n').replace(/\u0001/g, '');
  const out: string[] = [];
  for (const l of text.split('\n')) {
    const c = cleanLine(l);
    if (!c.trim() && l.trim()) continue;
    const line = c.trim() ? c : l;
    // A line left holding only the punctuation that closed a removed parenthetical
    // ("." / ",") joins the line above.
    if (/^\s*[.,;:]+\s*$/.test(line) && out.length) {
      if (!/[.,;:!?]$/.test(out[out.length - 1])) out[out.length - 1] += line.trim();
      continue;
    }
    out.push(line);
  }
  // A leading "." / "," (or a space) left where a removed parenthetical started a line.
  return out.map((l, i) => {
    const orig = lines[i] ?? '';
    const origLead = /^\s*/.exec(orig)![0];
    const fixed = l.replace(/^(\s*)[.,;:]\s+(?=\S)/, '$1');
    return /^\s/.test(fixed) && !origLead ? fixed.trimStart() : fixed;
  });
}

/** Single-line convenience (tests / trailing comments). '' = nothing left. */
export function stripProvenanceText(line: string): string {
  const r = stripProvenanceLines([line]);
  return r.length ? r[0] : '';
}

type Lang = 'dart' | 'ts';

/** Every comment in `src` as [start, end) offsets, skipping string literals. */
function commentSpans(src: string, lang: Lang): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; out.push([i, end]); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; out.push([i, end]); i = end; continue; }
    if (c === '"' || c === "'" || (lang === 'ts' && c === '`')) {
      const triple = lang === 'dart' && src.startsWith(c.repeat(3), i);
      const raw = lang === 'dart' && src[i - 1] === 'r';
      if (triple) { const e = src.indexOf(c.repeat(3), i + 3); i = e === -1 ? n : e + 3; continue; }
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && !raw) j++;
        else if (c !== '`' && src[j] === '\n') break;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {   // template expression: skip balanced braces
          let depth = 0;
          for (j++; j < n; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

export interface ProvenanceStripResult { src: string; stripped: number; linesRemoved: number }

/**
 * Strip provenance from every comment of one source file. Consecutive whole-line
 * `//` comments with the same indent + prefix are one block (a parenthetical may
 * wrap); a trailing comment after code and each block comment are handled alone.
 */
export function stripProvenance(src: string, lang: Lang): ProvenanceStripResult {
  const spans = commentSpans(src, lang);
  // Group whole-line // comments into runs.
  type Run = { start: number; end: number; indent: string; prefix: string; lines: string[]; block: boolean };
  const runs: Run[] = [];
  for (const [a, b] of spans) {
    const ls = src.lastIndexOf('\n', a - 1) + 1;
    const indent = src.slice(ls, a);
    const text = src.slice(a, b);
    const whole = /^[ \t]*$/.test(indent);
    if (text.startsWith('//')) {
      const m = /^(\/\/\/?[ \t]?)(.*)$/s.exec(text)!;
      const prev = runs[runs.length - 1];
      if (whole && prev && !prev.block && prev.indent === indent && prev.prefix.trim() === m[1].trim() && src.slice(prev.end, ls) === '\n') {
        prev.end = b; prev.lines.push(m[2]);
      } else {
        runs.push({ start: whole ? ls : a, end: b, indent: whole ? indent : '', prefix: m[1], lines: [m[2]], block: !whole });
      }
    } else {
      runs.push({ start: a, end: b, indent: '', prefix: '', lines: [text], block: true });
    }
  }
  let stripped = 0;
  let linesRemoved = 0;
  let out = src;
  for (const r of runs.reverse()) {
    const text = r.lines.join('\n');
    if (!hasProvenance(text)) continue;
    let replacement: string;
    if (r.prefix && !text.startsWith('/*')) {
      // whole-line run (or a trailing // comment when r.block)
      const kept = r.lines.map((l) => (MARKER_RE.test(l) ? l : null));
      if (kept.every((k) => k !== null)) continue;
      const cleaned = stripProvenanceLines(r.lines.filter((l) => !MARKER_RE.test(l)));
      // re-insert marker lines at the top (they are never mid-prose in practice)
      const markers = r.lines.filter((l) => MARKER_RE.test(l));
      const all = [...markers, ...cleaned];
      if (all.join('\n') === text) continue;
      stripped++;
      linesRemoved += Math.max(0, r.lines.length - all.length);
      if (r.block) {
        replacement = all.length && all[0].trim() ? `${r.prefix}${all[0]}` : '';
      } else {
        replacement = all.map((l) => `${r.indent}${r.prefix}${l}`.replace(/[ \t]+$/, '')).join('\n');
      }
    } else {
      // /* … */ block comment: clean its inner lines.
      const lines = text.split('\n');
      const heads: string[] = [];
      const bodies: string[] = [];
      for (const ln of lines) {
        const m = /^(\s*(?:\/\*+|\*(?!\/))?\s?)(.*?)$/.exec(ln)!;
        heads.push(m[1]); bodies.push(m[2]);
      }
      const tail = /\s*\*\/$/.exec(bodies[bodies.length - 1])?.[0] ?? '';
      if (tail) bodies[bodies.length - 1] = bodies[bodies.length - 1].slice(0, -tail.length);
      const cleaned = stripProvenanceLines(bodies);
      if (cleaned.join('\n') === bodies.join('\n')) continue;
      stripped++;
      linesRemoved += Math.max(0, bodies.length - cleaned.length);
      const head0 = heads[0];
      const mid = heads[1] ?? ' * ';
      const lastHead = heads[heads.length - 1];
      const closesAlone = lines.length > 1 && !bodies[bodies.length - 1].trim();
      const rebuilt = cleaned.map((l, i) => (closesAlone && i === cleaned.length - 1 && !l.trim()
        ? lastHead
        : `${i === 0 ? head0 : mid}${l}`.replace(/[ \t]+$/, '')));
      const hasText = rebuilt.some((l) => l.replace(/^\s*(?:\/\*+|\*)\s*/, '').trim());
      replacement = hasText ? `${rebuilt.join('\n')}${closesAlone ? tail.trimStart() : tail}` : '';
    }
    let start = r.start;
    let end = r.end;
    if (!replacement) {
      if (!r.block || /^[ \t]*$/.test(out.slice(out.lastIndexOf('\n', start - 1) + 1, start))) {
        start = out.lastIndexOf('\n', start - 1) + 1;
        end = out[end] === '\n' ? end + 1 : end;
      } else {
        while (start > 0 && /[ \t]/.test(out[start - 1])) start--;
      }
    }
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return { src: out, stripped, linesRemoved };
}

export interface ProvenanceSweep { filesScanned: number; filesChanged: number; commentsStripped: number; changedFiles: string[] }

/** Strip provenance from every source file under `dirs` (absolute). */
export async function stripProvenanceInTree(projectRoot: string, files: string[], dryRun: boolean): Promise<ProvenanceSweep> {
  const res: ProvenanceSweep = { filesScanned: 0, filesChanged: 0, commentsStripped: 0, changedFiles: [] };
  for (const f of files) {
    const lang: Lang | null = f.endsWith('.dart') ? 'dart' : /\.(tsx?|jsx?|mjs|cjs|css)$/.test(f) ? 'ts' : null;
    if (!lang) continue;
    let src: string;
    try { src = await fs.readFile(f, 'utf8'); } catch { continue; }
    res.filesScanned++;
    const r = stripProvenance(src, lang);
    if (r.src === src) continue;
    res.filesChanged++;
    res.commentsStripped += r.stripped;
    res.changedFiles.push(path.relative(projectRoot, f).split(path.sep).join('/'));
    if (!dryRun) await fs.writeFile(f, r.src, 'utf8');
  }
  return res;
}

// ── 2. Stub components ──────────────────────────────────────────────────────

const DART_STUB_BODY = /Widget\s+build\s*\([^)]*\)\s*(?:=>\s*const\s+SizedBox\.shrink\(\)\s*;|\{\s*return\s+const\s+SizedBox\.shrink\(\);\s*\})/;
const WEB_STUB_BODY = /GENERATED SKELETON[^\n]*component stub|return\s+null\s*;?\s*\}\s*$/;

/** A shared-component file that is still the skeleton's stub (never built). */
export function isStubComponent(src: string, lang: Lang): boolean {
  if (lang === 'dart') {
    const classes = src.match(/^class\s+\w+\s+extends\s+\w+/gm) ?? [];
    return classes.length === 1 && DART_STUB_BODY.test(src) && !/extends\s+State</.test(src);
  }
  return /GENERATED SKELETON/.test(src) && WEB_STUB_BODY.test(src.trim());
}

export interface StubComponentSweep { examined: number; removed: string[]; kept: Array<{ file: string; importers: string[] }> }

/**
 * Delete stub component files under `componentsDir` that no file in `allSources`
 * imports. `importsFile(src, fromFile, target)` decides whether a source imports the
 * target (Dart relative/package import or a TS specifier resolved by the caller).
 */
export async function removeStubComponents(
  projectRoot: string, componentsDir: string, allSources: string[], lang: Lang,
  importsFile: (src: string, fromFile: string, target: string) => boolean, dryRun: boolean,
): Promise<StubComponentSweep> {
  const res: StubComponentSweep = { examined: 0, removed: [], kept: [] };
  if (!fsSync.existsSync(componentsDir)) return res;
  const ext = lang === 'dart' ? /\.dart$/ : /\.(tsx|jsx|ts|js)$/;
  const comps = allSources.filter((f) => f.startsWith(componentsDir + path.sep) && ext.test(f));
  const texts = new Map<string, string>();
  for (const f of allSources) texts.set(f, await fs.readFile(f, 'utf8').catch(() => ''));
  const rel = (p: string): string => path.relative(projectRoot, p).split(path.sep).join('/');
  for (const c of comps) {
    res.examined++;
    if (!isStubComponent(texts.get(c) ?? '', lang)) continue;
    const importers = allSources.filter((f) => f !== c && importsFile(texts.get(f) ?? '', f, c));
    if (importers.length) { res.kept.push({ file: rel(c), importers: importers.map(rel) }); continue; }
    res.removed.push(rel(c));
    if (!dryRun) await fs.rm(c, { force: true });
  }
  return res;
}

/** Dart: does `src` (in `fromFile`) import `target`? Relative and package: imports. */
export function dartImportsFile(projectRoot: string, pkgName: string | null) {
  return (src: string, fromFile: string, target: string): boolean => {
    for (const m of src.matchAll(/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      let abs: string | null = null;
      if (spec.startsWith('package:')) {
        const [pkg, ...rest] = spec.slice('package:'.length).split('/');
        if (pkgName && pkg === pkgName) abs = path.join(projectRoot, 'lib', ...rest);
      } else if (!spec.startsWith('dart:')) abs = path.resolve(path.dirname(fromFile), spec);
      if (abs && path.normalize(abs) === path.normalize(target)) return true;
    }
    return false;
  };
}

export const __test = { commentSpans, PROV_SRC, cleanLine };
