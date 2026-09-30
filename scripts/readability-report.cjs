#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// scripts/readability-report.cjs
//
// Measure how READABLE a generated project is (flutter | react | next), so a
// readability fix can be proven by a number moving, not by a pass saying it ran.
//
//   node scripts/readability-report.cjs <projectDir> [options]
//
//   --framework flutter|react|next   override auto-detection
//   --out <file.json>                write the JSON report there (default: stdout)
//   --summary                        print a human summary table to stderr
//   --compare <baseline.json>        print totals deltas vs an earlier report (stderr)
//   --min-dup-tokens <n>             smallest subtree hashed for duplication (default 40)
//   --tools                          also run analyzer/tsc when available (default: auto)
//   --no-tools                       never run external tools
//
// Zero dependencies (node >= 18). Everything is a heuristic over a small
// hand-written tokenizer (Dart) / tokenizer + JSX scanner (TS/TSX) — NOT a
// compiler. Each metric documents exactly what it matches so a number can be
// traced back to lines (`--details` keeps per-occurrence line lists).
//
// Metrics per file (theme/token files are exempt from the literal counts —
// they are where literals are SUPPOSED to live):
//   loc                   non-blank lines carrying code (comments excluded)
//   machineNames          identifiers / literals shaped like Figma machine names:
//                         Frame12, Group_4, Rectangle 7, Vector3, IPhone1415Pro57,
//                         cmp_other_17, screen_290_3657, c2903657 …
//   rawNodeIds            Figma node ids in code or strings (283:1967, 290_3657, /283-1967)
//   numericSuffixNames    generic stems with a meaningless counter (ink2, neutral3, _Item_2)
//   inlineColors          colour literals at a use site (Color(0x…), '#12ae89', bg-[#…], rgba())
//   fileLocalColorConsts  colour literals hoisted to a FILE-LOCAL const (per-screen palette)
//   materialColors        Colors.<name> (flutter) — a literal that bypasses the theme
//   magicNumbers          numeric layout literals (width/height/padding/fontSize/radius/… ≠ 0,1)
//   figmaFractionals      numbers with ≥2 decimals (21.94, 15.85) — raw Figma geometry leaking
//   maxNesting            deepest widget-constructor (flutter) / JSX element (web) nesting
//   nodesOverDepth        widget/element nodes deeper than --deep (default 10)
//   noopHandlers          onX: () {} / onClick={() => {}} / => null
//   stubHandlers          handlers whose whole body is a print/console.log
//   unusedImports         imports whose bound names are never referenced (web: exact;
//                         dart: resolvable project imports only; the rest is "unknown")
//   positioned / stacks   Positioned(…) / Stack(…) (flutter); absolute classes/styles (web)
//   comments              figmaLeak / commentedOutCode / todo / pipelineMarker / decorative
//   duplicates            normalized-subtree hashing across the whole project
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const VERSION = 1;

// ── file discovery ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.dart_tool', 'build', 'dist', '.next', 'out', '.uix',
  'ios', 'android', 'macos', 'windows', 'linux', 'web', 'coverage', '.turbo', '.vercel',
]);

function detectFramework(root) {
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) return 'flutter';
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return 'next';
      if (deps.react) return 'react';
    } catch { /* fall through to extension sniffing */ }
  }
  if (fs.existsSync(path.join(root, 'next.config.js')) || fs.existsSync(path.join(root, 'next.config.mjs'))
    || fs.existsSync(path.join(root, 'next.config.ts'))) return 'next';
  // Extension majority (a bare folder of generated files).
  let dart = 0, web = 0;
  walk(root, (f) => { if (f.endsWith('.dart')) dart++; else if (/\.(tsx|jsx)$/.test(f)) web++; });
  if (dart && dart >= web) return 'flutter';
  if (web) return 'react';
  return 'unknown';
}

function walk(dir, cb, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) && rel === '') continue;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.dart_tool') continue;
      walk(dir, cb, r);
    } else if (e.isFile()) cb(r);
  }
}

function collectFiles(root, framework) {
  const out = [];
  walk(root, (rel) => {
    if (framework === 'flutter') {
      if (!rel.endsWith('.dart')) return;
      if (/\.(g|freezed|mocks|gr)\.dart$/.test(rel)) return;
      if (!rel.startsWith('lib/') && !rel.startsWith('test/') && rel.includes('/')) return;
      if (rel.startsWith('test/')) return; // tests are not the deliverable being judged
      out.push(rel);
    } else {
      if (!/\.(tsx|ts|jsx|js)$/.test(rel)) return;
      if (/\.d\.ts$/.test(rel)) return;
      if (/(^|\/)(vite|next|tailwind|postcss|eslint|vitest|jest)\.config\.[cm]?[jt]s$/.test(rel)) return;
      if (/\.(test|spec)\.[jt]sx?$/.test(rel)) return;
      out.push(rel);
    }
  });
  return out.sort();
}

function categorize(rel, framework) {
  const r = rel.toLowerCase();
  if (/(^|\/)_preview\//.test(r) || /preview\.(tsx|jsx|dart)$/.test(r) || /_preview\.dart$/.test(r) || /placeholderscreen/.test(r)) return 'preview';
  if (/(^|\/)theme(s)?\//.test(r) || /(^|\/)(app_)?theme\.(dart|ts|tsx|js)$/.test(r) || /(^|\/)tokens?\.(ts|js)$/.test(r) || /design[-_]?tokens/.test(r)) return 'theme';
  if (framework === 'flutter') {
    if (r.startsWith('lib/screens/')) return 'screen';
    if (r.startsWith('lib/components/') || r.startsWith('lib/widgets/')) return 'component';
    if (r.startsWith('lib/resources/') || r.startsWith('lib/data/')) return 'support';
    return 'other';
  }
  if (/(^|\/)screens?\//.test(r) || /(^|\/)app\/(.*\/)?page\.(tsx|jsx)$/.test(r) || /(^|\/)pages\//.test(r)) return 'screen';
  if (/(^|\/)components?\//.test(r) || /(^|\/)ui\//.test(r)) return 'component';
  if (/(^|\/)(resources|data|lib|api|router|routes)\//.test(r)) return 'support';
  return 'other';
}

// ── tokenizer ─────────────────────────────────────────────────────────────────
// Token: { k: 'id'|'num'|'str'|'punct'|'comment'|'jsxtext', v, s (start offset), e (end), line }

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/** Scan a quoted string starting at i (src[i] is the quote). Handles Dart raw /
 *  triple-quoted strings and `${…}` interpolation (Dart + TS templates). */
function scanString(src, i, lang) {
  let raw = false;
  if (lang === 'dart' && src[i] === 'r' && (src[i + 1] === '"' || src[i + 1] === "'")) { raw = true; i++; }
  const q = src[i];
  const triple = lang === 'dart' && src.substr(i, 3) === q.repeat(3);
  let j = i + (triple ? 3 : 1);
  while (j < src.length) {
    const c = src[j];
    if (!raw && c === '\\') { j += 2; continue; }
    if (triple) { if (src.substr(j, 3) === q.repeat(3)) return j + 3; }
    else if (c === q) return j + 1;
    if (!triple && q !== '`' && c === '\n') return j; // unterminated single-line string
    if (!raw && c === '$' && src[j + 1] === '{' && (lang === 'dart' || q === '`')) {
      // skip interpolation with brace depth, honouring nested strings
      let depth = 0; j += 1;
      while (j < src.length) {
        const d = src[j];
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) { j++; break; } }
        else if (d === '"' || d === "'" || d === '`') { j = scanString(src, j, lang); continue; }
        j++;
      }
      continue;
    }
    j++;
  }
  return j;
}

function scanNumber(src, i) {
  const m = /^(0[xX][0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
  return m ? i + m[0].length : i + 1;
}

/** Dart tokenizer (no JSX). */
function tokenizeDart(src) {
  const toks = [];
  const lineOf = lineIndex(src);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length;
      toks.push({ k: 'comment', v: src.slice(i, j), s: i, e: j, line: lineOf(i) }); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2;
      toks.push({ k: 'comment', v: src.slice(i, j), s: i, e: j, line: lineOf(i) }); i = j; continue;
    }
    if (c === '"' || c === "'" || (c === 'r' && (src[i + 1] === '"' || src[i + 1] === "'") && !ID_PART.test(src[i - 1] || ''))) {
      const j = scanString(src, i, 'dart');
      toks.push({ k: 'str', v: src.slice(i, j), s: i, e: j, line: lineOf(i) }); i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !ID_PART.test(src[i - 1] || ''))) {
      const j = scanNumber(src, i);
      toks.push({ k: 'num', v: src.slice(i, j), s: i, e: j, line: lineOf(i) }); i = j; continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1; while (j < src.length && ID_PART.test(src[j])) j++;
      toks.push({ k: 'id', v: src.slice(i, j), s: i, e: j, line: lineOf(i) }); i = j; continue;
    }
    const two = src.substr(i, 2);
    const p = (two === '=>' || two === '?.' || two === '??' || two === '..') ? two : c;
    toks.push({ k: 'punct', v: p, s: i, e: i + p.length, line: lineOf(i) }); i += p.length;
  }
  return { toks, elements: [] };
}

/**
 * TS/TSX tokenizer with a recursive-descent JSX scanner. Emits the same token
 * stream as tokenizeDart plus `jsxtext` tokens for element text, and an
 * `elements` list: { name, depth, startTok, endTok, line }.
 */
function tokenizeTs(src) {
  const toks = [];
  const elements = [];
  const lineOf = lineIndex(src);
  let i = 0;
  const push = (k, s, e) => toks.push({ k, v: src.slice(s, e), s, e, line: lineOf(s) });

  const prevSignificant = () => {
    for (let t = toks.length - 1; t >= 0; t--) if (toks[t].k !== 'comment') return toks[t];
    return null;
  };
  const JSX_PREV_PUNCT = new Set(['(', '[', '{', ',', ';', '=', ':', '?', '&', '|', '!', '>', '=>', '&&', '||', '??', '}']);
  const looksLikeJsxStart = () => {
    if (src[i] !== '<') return false;
    const n = src[i + 1];
    if (!(n === '>' || (n && /[A-Za-z]/.test(n)))) return false;
    const p = prevSignificant();
    if (!p) return true;
    if (p.k === 'id') return p.v === 'return' || p.v === 'yield' || p.v === 'default' || p.v === 'case';
    if (p.k === 'punct') return JSX_PREV_PUNCT.has(p.v);
    return false;
  };

  function skipWsAndComments() {
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; push('comment', i, j); i = j; continue; }
      if (c === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; push('comment', i, j); i = j; continue; }
      break;
    }
  }

  // Code mode until an unmatched closer in `stopAt` (e.g. '}' for a JSX expression container).
  function scanCode(depth, stopAtBrace) {
    let braces = 0;
    while (i < src.length) {
      skipWsAndComments();
      if (i >= src.length) break;
      const c = src[i];
      if (stopAtBrace && c === '}' && braces === 0) return;
      if (looksLikeJsxStart()) { scanJsxElement(depth); continue; }
      if (c === '"' || c === "'" || c === '`') { const j = scanString(src, i, 'ts'); push('str', i, j); i = j; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !ID_PART.test(src[i - 1] || ''))) { const j = scanNumber(src, i); push('num', i, j); i = j; continue; }
      if (ID_START.test(c)) { let j = i + 1; while (j < src.length && ID_PART.test(src[j])) j++; push('id', i, j); i = j; continue; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      const three = src.substr(i, 3);
      const two = src.substr(i, 2);
      const p = three === '...' ? three : (['=>', '?.', '??', '&&', '||', '==', '!=', '<=', '>='].includes(two) ? two : c);
      push('punct', i, i + p.length); i += p.length;
    }
  }

  // At '<' in a JSX position.
  function scanJsxElement(depth) {
    const startTok = toks.length;
    const line = lineOf(i);
    push('punct', i, i + 1); i++; // '<'
    let name = '';
    if (src[i] === '>') { name = '<>'; push('punct', i, i + 1); i++; }
    else {
      const m = /^[A-Za-z_$][\w$.:-]*/.exec(src.slice(i, i + 200));
      name = m ? m[0] : '?';
      push('id', i, i + name.length); i += name.length;
      // generic type args on a component: <Foo<Bar> …> — rare, ignore.
      // attributes
      for (;;) {
        skipWsAndComments();
        if (i >= src.length) break;
        const c = src[i];
        if (c === '/' && src[i + 1] === '>') {
          push('punct', i, i + 2); i += 2;
          elements.push({ name, depth, startTok, endTok: toks.length - 1, line });
          return;
        }
        if (c === '>') { push('punct', i, i + 1); i++; break; }
        if (c === '{') { push('punct', i, i + 1); i++; scanCode(depth + 1, true); if (src[i] === '}') { push('punct', i, i + 1); i++; } continue; }
        if (c === '"' || c === "'") { const j = scanString(src, i, 'ts'); push('str', i, j); i = j; continue; }
        if (ID_START.test(c)) { const m = /^[A-Za-z_$][\w$:-]*/.exec(src.slice(i, i + 200)); push('id', i, i + m[0].length); i += m[0].length; continue; }
        push('punct', i, i + 1); i++;
      }
    }
    // children
    for (;;) {
      if (i >= src.length) break;
      const c = src[i];
      if (c === '<' && src[i + 1] === '/') {
        // closing tag
        const close = src.indexOf('>', i);
        const end = close < 0 ? src.length : close + 1;
        push('punct', i, end); i = end;
        elements.push({ name, depth, startTok, endTok: toks.length - 1, line });
        return;
      }
      if (c === '<') { scanJsxElement(depth + 1); continue; }
      if (c === '{') {
        push('punct', i, i + 1); i++;
        scanCode(depth + 1, true);
        if (src[i] === '}') { push('punct', i, i + 1); i++; }
        continue;
      }
      // text run
      let j = i;
      while (j < src.length && src[j] !== '<' && src[j] !== '{') j++;
      if (src.slice(i, j).trim()) push('jsxtext', i, j);
      i = j;
    }
    elements.push({ name, depth, startTok, endTok: toks.length - 1, line });
  }

  scanCode(0, false);
  return { toks, elements };
}

// ── pattern library ───────────────────────────────────────────────────────────

// Figma default layer names as they appear in identifiers (Frame12, Group_4,
// Rectangle7, Vector3) or in text ("Frame 12", "Group 4").
const LAYER_WORDS = 'Frame|Group|Rectangle|Rect|Vector|Ellipse|Polygon|Star|Line|Union|Subtract|Intersect|Exclude|Mask|Layer|Instance|Component|Section|Slice';
// In IDENTIFIERS only the unambiguous layer words count: `section16` / `line2` /
// `star3` are as often a type-scale helper or a real noun as a Figma default.
const ID_LAYER_WORDS = 'Frame|Group|Rectangle|Rect|Vector|Ellipse|Polygon|Union|Subtract|Intersect|Mask|Layer|Instance|Component';
const MACHINE_ID_RE = new RegExp(`^_?(?:${ID_LAYER_WORDS})_?\\d+(?:[A-Z_]\\w*)?$`, 'i');
// In text/paths: "Frame 12", "Group 4", and asset stems like vector_10_20.svg / frame-7.png
const MACHINE_TEXT_RE = new RegExp(`(?:^|[^A-Za-z])(?:${ID_LAYER_WORDS})[ _-]?\\d{1,7}(?![A-Za-z0-9])`, 'gi');
// Device-preset frame names: IPhone1415Pro57, iPhone 14 & 15 Pro - 57, Android Large - 3, Desktop - 12
const PRESET_ID_RE = /^_?(?:I[Pp]hone|Android|Desktop|Mac[Bb]ook|IPad|Ipad|Tablet|Web|Screen)(?:[A-Z]?[a-z]*)?\d{2,}\w*$/;
const PRESET_TEXT_RE = /\b(?:iPhone|Android|Desktop|MacBook|iPad)[\w &]*?\s-\s\d+\b/g;
// Figma node ids: 283:1967, I12:34;56:78 (colon form, ≥3 digits on one side so 10:30 times don't match)
// A MEASURED pixel size in a comment: with a unit or "each" (`24×24px`, `27×27 each`),
// or a bare `40×40` that is not the predicate of its sentence. `3×3` / `7×7` grid
// counts (both < 10, no unit) and "is 40×40 so …" are not leaks. Kept in sync with
// source-hygiene.ts SIZE_PROV (the 7h strip removes exactly what this counts).
const SIZE_LEAK_RE = /(?<!\w|\d\.)(?!0x)(?:\d+(?:\.\d+)?\s*[×x]\s*\d+(?:\.\d+)?(?:\s*(?:px|pt)(?:\s+each)?|\s+each)|(?<!\b(?:is|are|was|were|be|been|of|a|an|the|at|to|into|by|than|as|from|becomes?)\s+)(?=\d{2}|\d+\.\d|\d+\s*[×x]\s*(?:\d{2}|\d+\.\d))\d+(?:\.\d+)?\s*×\s*\d+(?:\.\d+)?)(?!\w|\.\d)/;
const NODE_ID_TEXT_RE = /\b(?:I?\d{1,6}[:;](?:\d{3,7})|I?\d{3,6}[:;]\d{1,7})(?:;\d+:\d+)*\b/g;
// Node ids inside identifiers / paths / routes: screen_290_3657, showModal_313_9543, c2903657, /283-1967, c_290_4388
const NODE_ID_IDENT_RE = /(?:^|_)(\d{2,6})_(\d{3,7})(?:_|$)|^[cm]\d{6,}$|^[cm]_\d{2,6}_\d{3,7}$/;
const NODE_ID_ROUTE_RE = /(^|\/)\d{2,6}-\d{3,7}(\/|$)/;
// Generic stems where a trailing counter carries no meaning (ink2, neutral3, _Item_2, cmp_other_17)
const GENERIC_STEMS = new Set(['ink', 'neutral', 'accent', 'color', 'colour', 'widget', 'screen', 'component', 'container',
  'frame', 'group', 'item', 'section', 'image', 'img', 'icon', 'row', 'column', 'col', 'stack', 'box', 'view', 'element',
  'node', 'layer', 'rectangle', 'vector', 'ellipse', 'cmp', 'other', 'variant', 'style', 'text', 'wrapper', 'div', 'block',
  'part', 'content', 'child', 'shape', 'grey', 'gray', 'surface', 'bg', 'background', 'panel', 'tile', 'value', 'data']);

function isNumericSuffixName(id) {
  const bare = id.replace(/^_+/, '');
  // snake counter: foo_bar_12  (not a node-id pair, that is counted separately)
  let m = /^([A-Za-z][A-Za-z0-9]*?)(?:_[A-Za-z][A-Za-z0-9]*)*_(\d{1,3})$/.exec(bare);
  if (m) return true;
  // camel/plain counter: ink2, neutral3, Container2, accent10 — only on generic stems
  m = /^([A-Za-z]+?)(\d{1,3})$/.exec(bare);
  if (!m) return false;
  const stemWords = m[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
  return GENERIC_STEMS.has(stemWords[stemWords.length - 1]);
}

const FLUTTER_LAYOUT_KEYS = new Set(['width', 'height', 'size', 'fontSize', 'left', 'top', 'right', 'bottom', 'horizontal',
  'vertical', 'radius', 'spacing', 'runSpacing', 'letterSpacing', 'wordSpacing', 'elevation', 'blurRadius', 'spreadRadius',
  'dimension', 'thickness', 'indent', 'endIndent', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'strokeWidth',
  'iconSize', 'mainAxisSpacing', 'crossAxisSpacing', 'childAspectRatio', 'itemExtent', 'borderRadius', 'gap', 'start', 'end']);
const FLUTTER_NUMERIC_CALLEES = new Set(['all', 'circular', 'fromLTRB', 'Offset', 'Size', 'elliptical', 'square', 'symmetric', 'only', 'fromSize', 'fromRadius']);
const WEB_LAYOUT_KEYS = new Set(['width', 'height', 'fontSize', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft',
  'paddingRight', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'top', 'left', 'right', 'bottom',
  'gap', 'rowGap', 'columnGap', 'borderRadius', 'lineHeight', 'letterSpacing', 'minWidth', 'maxWidth', 'minHeight',
  'maxHeight', 'borderWidth', 'size', 'strokeWidth', 'inset']);
// Constructors that are VALUES, not widgets — excluded from nesting depth.
const FLUTTER_VALUE_TYPES = new Set(['EdgeInsets', 'EdgeInsetsDirectional', 'TextStyle', 'BoxDecoration', 'ShapeDecoration',
  'BorderRadius', 'Radius', 'Color', 'Colors', 'Offset', 'Size', 'Duration', 'BoxShadow', 'Border', 'BorderSide',
  'LinearGradient', 'RadialGradient', 'Alignment', 'AlignmentDirectional', 'BoxConstraints', 'RoundedRectangleBorder',
  'StadiumBorder', 'CircleBorder', 'OutlineInputBorder', 'UnderlineInputBorder', 'InputDecoration', 'TextSpan',
  'ColorFilter', 'Matrix4', 'FontWeight', 'GoogleFonts', 'AppTheme', 'Key', 'ValueKey', 'GlobalKey', 'ButtonStyle',
  'EdgeInsetsGeometry', 'Rect', 'Curves', 'Tween', 'TextEditingController', 'FocusNode', 'MaterialPageRoute',
  'PageRouteBuilder', 'Future', 'Stream', 'Uri', 'DateTime', 'List', 'Map', 'Set', 'String', 'Object', 'Theme',
  'MediaQuery', 'Navigator', 'ScaffoldMessenger', 'Image', 'SvgPicture', 'BorderDirectional', 'DecorationImage',
  'AssetImage', 'NetworkImage', 'ImageFilter', 'Shadow', 'Paint', 'Path', 'TextPainter', 'SystemUiOverlayStyle',
  'ThemeData', 'ColorScheme', 'TextTheme', 'IconThemeData', 'AppBarTheme', 'WidgetStatePropertyAll', 'MaterialStatePropertyAll']);
// Image/SvgPicture ARE widgets but are almost always leaves; excluding them only
// understates depth by one on image leaves. Kept conservative on purpose.

const HEX_COLOR_IN_STR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const FUNC_COLOR_IN_STR_RE = /\b(?:rgba?|hsla?)\(\s*\d/g;
const PX_IN_STR_RE = /(?<![\w#])-?\d+(?:\.\d+)?(?:px|rem|em)\b/g;
const TW_ARBITRARY_NUM_RE = /-\[-?\d+(?:\.\d+)?(?:px|rem|em|%)?\]/g;

// ── per-file analysis ─────────────────────────────────────────────────────────

function newFileMetrics() {
  return {
    lines: 0, loc: 0,
    machineNames: 0, rawNodeIds: 0, numericSuffixNames: 0,
    inlineColors: 0, fileLocalColorConsts: 0, materialColors: 0,
    magicNumbers: 0, figmaFractionals: 0,
    maxNesting: 0, nodesOverDepth: 0,
    noopHandlers: 0, stubHandlers: 0,
    unusedImports: 0, unknownImports: 0,
    positioned: 0, stacks: 0,
    handDrawn: 0, privateWidgets: 0, stubBody: 0,
    comments: { lines: 0, figmaLeak: 0, commentedOutCode: 0, todo: 0, pipelineMarker: 0, decorative: 0, noise: 0 },
    codeTokens: 0,
  };
}

function isThemeLike(cat) { return cat === 'theme'; }

function analyzeFile(root, rel, framework, ctx) {
  const abs = path.join(root, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const lang = rel.endsWith('.dart') ? 'dart' : 'ts';
  const category = categorize(rel, framework);
  const { toks, elements } = lang === 'dart' ? tokenizeDart(src) : tokenizeTs(src);
  const m = newFileMetrics();
  const details = { machineNames: [], rawNodeIds: [], numericSuffixNames: [], inlineColors: [], magicNumbers: [], noopHandlers: [], unusedImports: [], noiseComments: [] };
  const note = (key, line, text) => { if (ctx.details && details[key].length < 200) details[key].push(`${line}: ${String(text).slice(0, 100)}`); };

  m.lines = src.split('\n').length;
  const codeLines = new Set();
  for (const t of toks) {
    if (t.k === 'comment') continue;
    m.codeTokens++;
    const endLine = t.line + (src.slice(t.s, t.e).match(/\n/g) || []).length;
    for (let l = t.line; l <= endLine; l++) codeLines.add(l);
  }
  m.loc = codeLines.size;

  const exemptLiterals = isThemeLike(category);
  const seenIds = new Set();

  // ---- identifiers / strings: machine names, node ids, counters -------------
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (t.k === 'id') {
      const v = t.v;
      if (MACHINE_ID_RE.test(v) || PRESET_ID_RE.test(v) || /^cmp_/.test(v)) { m.machineNames++; note('machineNames', t.line, v); }
      else if (NODE_ID_IDENT_RE.test(v)) { m.rawNodeIds++; note('rawNodeIds', t.line, v); }
      else if (!seenIds.has(v) && isNumericSuffixName(v)) { m.numericSuffixNames++; note('numericSuffixNames', t.line, v); seenIds.add(v); }
      continue;
    }
    if (t.k === 'str' || t.k === 'jsxtext') {
      const v = t.v;
      const mt = (v.match(MACHINE_TEXT_RE) || []).length + (v.match(PRESET_TEXT_RE) || []).length;
      if (mt) { m.machineNames += mt; note('machineNames', t.line, v); }
      const nt = (v.match(NODE_ID_TEXT_RE) || []).length + (NODE_ID_ROUTE_RE.test(v.replace(/^['"`]|['"`]$/g, '')) ? 1 : 0);
      // import paths like 'screen_290_3657.dart' are node ids in a file name
      const fileNode = /(?:^|[/'"_])\d{2,6}_\d{3,7}(?:[_.]|$)/.test(v) ? 1 : 0;
      if (nt + fileNode) { m.rawNodeIds += nt + fileNode; note('rawNodeIds', t.line, v); }
    }
  }
  // the file name itself
  const base = path.basename(rel).replace(/\.\w+$/, '');
  if (NODE_ID_IDENT_RE.test(base) || /\d{2,6}[_-]\d{3,7}/.test(base)) { m.rawNodeIds++; note('rawNodeIds', 0, `file:${rel}`); }
  else if (/^cmp_/.test(base) || /_\d{1,3}$/.test(base) || PRESET_ID_RE.test(base.replace(/[_-]/g, '')) || MACHINE_ID_RE.test(base)
    || new RegExp(MACHINE_TEXT_RE.source, 'i').test(base)) { m.machineNames++; note('machineNames', 0, `file:${rel}`); }

  // ---- colours ------------------------------------------------------------
  if (!exemptLiterals) {
    if (lang === 'dart') {
      for (let ti = 0; ti < toks.length; ti++) {
        const t = toks[ti];
        if (t.k !== 'id') continue;
        const next = toks[ti + 1], next2 = toks[ti + 2], next3 = toks[ti + 3];
        let isColorLit = false;
        if (t.v === 'Color' && next && next.v === '(' && next2 && next2.k === 'num' && /^0x/i.test(next2.v)) isColorLit = true;
        if (t.v === 'Color' && next && next.v === '.' && next2 && /^from(ARGB|RGBO)$/.test(next2.v)) isColorLit = true;
        if (isColorLit) {
          // hoisted to a file-local const?  `static const Color _x = Color(…)` / `const _x = Color(…)`
          const prev = [toks[ti - 1], toks[ti - 2], toks[ti - 3]].filter(Boolean);
          const hoisted = prev.length >= 2 && prev[0].v === '=' && prev[1].k === 'id' && !/^(color|backgroundColor|foregroundColor)$/.test(prev[1].v)
            && toks.slice(Math.max(0, ti - 6), ti).some((p) => p.v === 'const' || p.v === 'final' || p.v === 'static');
          if (hoisted) m.fileLocalColorConsts++;
          else { m.inlineColors++; note('inlineColors', t.line, src.slice(t.s, (next3 || next2 || next).e + 1)); }
          continue;
        }
        if (t.v === 'Colors' && next && next.v === '.' && next2 && next2.k === 'id' && next2.v !== 'transparent') { m.materialColors++; }
      }
    } else {
      for (let ti = 0; ti < toks.length; ti++) {
        const t = toks[ti];
        if (t.k !== 'str') continue;
        const hex = (t.v.match(HEX_COLOR_IN_STR_RE) || []).filter((h) => !/^#\d{3,4}$/.test(h) || /[a-f]/i.test(h));
        const fn = t.v.match(FUNC_COLOR_IN_STR_RE) || [];
        const n = hex.length + fn.length;
        if (!n) continue;
        // `const BRAND = '#12ae89'` at module/file scope → file-local palette
        const p1 = toks[ti - 1], p2 = toks[ti - 2], p3 = toks[ti - 3];
        const hoisted = p1 && p1.v === '=' && p2 && p2.k === 'id' && p3 && (p3.v === 'const' || p3.v === 'let' || p3.v === 'var');
        // (an object-literal palette inside a screen, `{ brand: '#12ae89' }`, is
        //  still a per-screen literal → counted inline, not hoisted)
        if (hoisted) m.fileLocalColorConsts += n;
        else { m.inlineColors += n; note('inlineColors', t.line, t.v); }
      }
    }
  }

  // ---- magic numbers + figma fractionals ------------------------------------
  const callStack = []; // callee name per open paren (dart)
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (lang === 'dart') {
      if (t.v === '(') { const p = toks[ti - 1]; callStack.push(p && p.k === 'id' ? p.v : ''); continue; }
      if (t.v === ')') { callStack.pop(); continue; }
    }
    if (t.k === 'num') {
      if (/^0x/i.test(t.v)) continue;
      const val = Number(t.v.replace(/_/g, ''));
      const decimals = (t.v.split('.')[1] || '').length;
      // ≥2 decimals on a value ≥1.5 (21.94, 15.85, 278.51) = raw Figma geometry;
      // 0.32-style ratios are painter/alpha fractions, not a design leak.
      if (decimals >= 2 && Math.abs(val) >= 1.5 && !exemptLiterals) { m.figmaFractionals++; }
      if (exemptLiterals || val === 0 || val === 1) continue;
      const p1 = toks[ti - 1], p2 = toks[ti - 2];
      // unary minus
      const q1 = p1 && p1.v === '-' ? toks[ti - 2] : p1;
      const q2 = p1 && p1.v === '-' ? toks[ti - 3] : p2;
      let magic = false;
      if (q1 && q1.v === ':' && q2 && q2.k === 'id') {
        magic = lang === 'dart' ? FLUTTER_LAYOUT_KEYS.has(q2.v) : WEB_LAYOUT_KEYS.has(q2.v);
      }
      if (!magic && lang === 'dart' && q1 && (q1.v === '(' || q1.v === ',')) {
        const callee = callStack[callStack.length - 1] || '';
        if (FLUTTER_NUMERIC_CALLEES.has(callee)) magic = true;
      }
      if (magic) { m.magicNumbers++; note('magicNumbers', t.line, `${q2 ? q2.v : ''}${q1 ? q1.v : ''} ${t.v}`); }
      continue;
    }
    if (lang === 'ts' && t.k === 'str' && !exemptLiterals) {
      const px = (t.v.match(PX_IN_STR_RE) || []).filter((x) => !/^-?[01](px|rem|em)$/.test(x));
      const tw = (t.v.match(TW_ARBITRARY_NUM_RE) || []).filter((x) => !/^-\[-?[01](px|rem|em|%)?\]$/.test(x));
      // a px value inside a tailwind arbitrary is counted once (tw), not twice
      const pxOutsideTw = px.length - (t.v.match(/-\[-?\d+(?:\.\d+)?(?:px|rem|em)\]/g) || []).length;
      const n = Math.max(0, pxOutsideTw) + tw.length;
      if (n) { m.magicNumbers += n; note('magicNumbers', t.line, t.v); }
      const frac = (t.v.match(/(?<![\d.])(?:[2-9]|\d{2,})\.\d{2,}/g) || []).length;
      m.figmaFractionals += frac;
    }
  }

  // ---- nesting depth -------------------------------------------------------
  if (lang === 'dart') {
    const stack = [];
    let depth = 0;
    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti];
      if (t.k !== 'punct') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') {
        let widget = false;
        if (t.v === '(') {
          const p = toks[ti - 1];
          let callee = p && p.k === 'id' ? p.v : '';
          // Name.named(  → check the type before the dot
          if (p && p.k === 'id' && toks[ti - 2] && toks[ti - 2].v === '.' && toks[ti - 3] && toks[ti - 3].k === 'id') callee = toks[ti - 3].v;
          widget = /^[A-Z]/.test(callee) && !FLUTTER_VALUE_TYPES.has(callee) && !/^_?[A-Z][A-Z0-9_]*$/.test(callee);
        }
        stack.push(widget);
        if (widget) {
          depth++;
          if (depth > m.maxNesting) m.maxNesting = depth;
          if (depth > ctx.deep) m.nodesOverDepth++;
        }
      } else if (t.v === ')' || t.v === ']' || t.v === '}') {
        const w = stack.pop();
        if (w) depth--;
      }
    }
  } else {
    for (const el of elements) {
      const d = el.depth + 1;
      if (d > m.maxNesting) m.maxNesting = d;
      if (d > ctx.deep) m.nodesOverDepth++;
    }
  }

  // ---- handlers ------------------------------------------------------------
  const EMPTY_BODY = String.raw`\{\s*(?:(?:\/\/[^\n]*\n\s*)|(?:\/\*[\s\S]*?\*\/\s*))*\}`;
  const noopRe = lang === 'dart'
    ? new RegExp(String.raw`\bon[A-Z]\w*\s*:\s*(?:\(\s*[\w\s,]*\)\s*(?:async\s*)?(?:${EMPTY_BODY}|=>\s*(?:null|\{\s*\}))|null\s*,\s*\/\/\s*TODO)`, 'g')
    : new RegExp(String.raw`\bon[A-Z]\w*\s*(?:=\s*\{|:)\s*(?:async\s*)?(?:\(\s*[^()]*\)|\w+)\s*=>\s*(?:${EMPTY_BODY}|undefined|null|void 0)`, 'g');
  const stubRe = lang === 'dart'
    ? /\bon[A-Z]\w*\s*:\s*\(\s*[\w\s,]*\)\s*(?:\{\s*(?:debugPrint|print|log)\([^;]*\);\s*\}|=>\s*(?:debugPrint|print|log)\()/g
    : /\bon[A-Z]\w*\s*(?:=\s*\{|:)\s*(?:async\s*)?(?:\(\s*[^()]*\)|\w+)\s*=>\s*(?:\{\s*console\.\w+\([^;]*\);?\s*\}|console\.\w+\(|alert\()/g;
  const lineOfSrc = lineIndex(src);
  let hm;
  while ((hm = noopRe.exec(src))) { m.noopHandlers++; note('noopHandlers', lineOfSrc(hm.index), hm[0]); }
  while ((hm = stubRe.exec(src))) { m.stubHandlers++; note('noopHandlers', lineOfSrc(hm.index), hm[0]); }

  // ---- imports ---------------------------------------------------------------
  const usedIds = new Set();
  const importTokenRanges = [];
  if (lang === 'dart') {
    const re = /^\s*import\s+(['"])([^'"]+)\1([^;]*);/gm;
    let im;
    const imports = [];
    while ((im = re.exec(src))) {
      imports.push({ uri: im[2], rest: im[3], s: im.index, e: im.index + im[0].length, line: lineOfSrc(im.index) });
      importTokenRanges.push([im.index, im.index + im[0].length]);
    }
    for (const t of toks) if (t.k === 'id' && !importTokenRanges.some(([s, e]) => t.s >= s && t.e <= e)) usedIds.add(t.v);
    // Interpolated identifiers inside strings ('$foo', '${foo.bar}') count as uses.
    for (const t of toks) if (t.k === 'str') for (const x of t.v.matchAll(/\$\{?([A-Za-z_]\w*)/g)) usedIds.add(x[1]);
    for (const imp of imports) {
      const asM = /\bas\s+([A-Za-z_]\w*)/.exec(imp.rest);
      const showM = /\bshow\s+([\w\s,]+)/.exec(imp.rest);
      if (asM) { if (!usedIds.has(asM[1])) { m.unusedImports++; note('unusedImports', imp.line, imp.uri); } continue; }
      let names = null;
      if (showM) names = showM[1].split(',').map((s) => s.trim()).filter(Boolean);
      else names = dartExportedNames(root, rel, imp.uri, ctx);
      if (names === null) { m.unknownImports++; continue; }
      if (!names.length) { m.unknownImports++; continue; }
      if (!names.some((n) => usedIds.has(n))) { m.unusedImports++; note('unusedImports', imp.line, imp.uri); }
    }
  } else {
    const re = /^\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\3\s*;?/gm;
    let im;
    const imports = [];
    while ((im = re.exec(src))) {
      imports.push({ clause: im[2], typeOnly: !!im[1], uri: im[4], s: im.index, e: im.index + im[0].length, line: lineOfSrc(im.index) });
      importTokenRanges.push([im.index, im.index + im[0].length]);
    }
    for (const t of toks) if (t.k === 'id' && !importTokenRanges.some(([s, e]) => t.s >= s && t.e <= e)) usedIds.add(t.v.split('.')[0]);
    for (const imp of imports) {
      const names = [];
      let clause = imp.clause.trim();
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) names.push(ns[1]);
      const braces = /\{([\s\S]*)\}/.exec(clause);
      if (braces) {
        for (const part of braces[1].split(',')) {
          const p = part.trim().replace(/^type\s+/, '');
          if (!p) continue;
          const asP = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(p);
          names.push(asP ? asP[1] : p);
        }
        clause = clause.replace(braces[0], '');
      }
      const def = /^([A-Za-z_$][\w$]*)/.exec(clause.replace(/^\s*,/, '').trim());
      if (def && !ns) names.push(def[1]);
      for (const n of names) if (!usedIds.has(n)) { m.unusedImports++; note('unusedImports', imp.line, `${n} from ${imp.uri}`); }
    }
  }

  // ---- positioning -----------------------------------------------------------
  if (lang === 'dart') {
    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti];
      if (t.k !== 'id') continue;
      const n = toks[ti + 1];
      if (t.v === 'Positioned' && n && (n.v === '(' || n.v === '.')) m.positioned++;
      if ((t.v === 'Stack' || t.v === 'IndexedStack') && n && n.v === '(') { if (t.v === 'Stack') m.stacks++; }
    }
  } else {
    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti];
      if (t.k === 'str') {
        const v = t.v.slice(1, -1);
        if (/(^|\s)absolute(\s|$)/.test(v) && !/^absolute$/.test(v)) m.positioned++;
        if (/(^|\s)relative(\s|$)/.test(v)) m.stacks++;
        if (/^absolute$/.test(v) && toks[ti - 2] && toks[ti - 2].v === 'position') m.positioned++;
        if (/^relative$/.test(v) && toks[ti - 2] && toks[ti - 2].v === 'position') m.stacks++;
      }
    }
  }

  // ---- comments ----------------------------------------------------------------
  for (const t of toks) {
    if (t.k !== 'comment') continue;
    const lines = t.v.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/^\s*(\/\/\/?|\/\*+|\*\/?)\s?/, '').replace(/\*\/\s*$/, '');
      if (!line.trim()) continue;
      m.comments.lines++;
      if (/GENERATED|write-locked|DO NOT EDIT|^\s*(canonicalId|componentId|states|modals|tabCluster):/i.test(line)) { m.comments.pipelineMarker++; continue; }
      if (/^[\s─━═=\-–—#*~_]*$/.test(line) || /^[─━═=\-–—]{2,}.*[─━═=\-–—]{2,}\s*$/.test(line.trim())) { m.comments.decorative++; continue; }
      let noisy = false;
      if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) { m.comments.todo++; noisy = true; }
      else if ((/(?:^|\s)(?:final|var|const|return|import|await|setState|Navigator\.|if\s*\(|for\s*\(|child:|children:|<\/?[A-Za-z][\w.]*[\s>/])/.test(line) && /[;{}(),]\s*$/.test(line))
        || /^\s*<\/?[A-Za-z][\w.]*(?:\s[^<>]*)?\/?>\s*$/.test(line)) { m.comments.commentedOutCode++; noisy = true; }
      else if (
        NODE_ID_TEXT_RE.test(line) || /\b(?:frame|ref|node)\s*#?\s?\d{2,}\b/i.test(line) || /\bIR\b/.test(line)
        || /\bFigma\b/i.test(line) || SIZE_LEAK_RE.test(line)
        || /\badded by \//i.test(line) || /\b(?:matches?|per) the (?:reference|design|ref)\b/i.test(line)
        || new RegExp(`\\b(?:${LAYER_WORDS}) \\d+\\b`).test(line)
      ) { m.comments.figmaLeak++; noisy = true; }
      NODE_ID_TEXT_RE.lastIndex = 0;
      if (noisy) { m.comments.noise++; note('noiseComments', t.line, line.trim()); }
    }
  }

  // ---- hand-drawn vectors, private widgets, stub bodies ---------------------------
  const privateNames = [];
  if (lang === 'dart') {
    m.handDrawn = (src.match(/\bextends\s+CustomPainter\b/g) || []).length;
    for (const cm of src.matchAll(/^class\s+(_[A-Za-z]\w*)\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/gm)) privateNames.push(cm[1]);
    // a public widget whose build is an empty placeholder (skeleton stub shipped as-is)
    if (/Widget\s+build\s*\([^)]*\)\s*(?:=>\s*const\s+SizedBox\.shrink\(\)|\{\s*return\s+const\s+SizedBox\.shrink\(\);\s*\})/.test(src)
      && !/^class\s+[A-Z]\w*\s+extends\s+State</m.test(src)) m.stubBody = 1;
  } else {
    m.handDrawn = elements.filter((el) => el.name === 'svg').length;
    for (const cm of src.matchAll(/^(?!export)\s*(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>)/gm)) privateNames.push(cm[1] || cm[2]);
    if (/return\s+null\s*;?\s*\}\s*$/.test(src.trim()) && m.loc < 12) m.stubBody = 1;
  }
  m.privateWidgets = privateNames.length;

  // ---- resolved project imports (for reachability) --------------------------------
  const resolvedImports = [];
  {
    const re = lang === 'dart'
      ? /^\s*(?:import|export|part)\s+(['"])([^'"]+)\1/gm
      : /(?:^\s*import\s+(?:[\s\S]*?\s+from\s+)?|^\s*export\s+[\s\S]*?\s+from\s+|\bimport\s*\(\s*)(['"])([^'"]+)\1/gm;
    for (const im of src.matchAll(re)) {
      const r = resolveImport(root, rel, im[2], lang, ctx);
      if (r) resolvedImports.push(r);
    }
  }

  // ---- duplication candidates (collected; grouped project-wide later) ----------
  const cands = [];
  if (lang === 'dart') {
    const open = [];
    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti];
      if (t.k !== 'punct') continue;
      if (t.v === '(') {
        const p = toks[ti - 1];
        let start = -1;
        if (p && p.k === 'id' && /^[A-Z]/.test(p.v)) start = ti - 1;
        if (p && p.k === 'id' && toks[ti - 2] && toks[ti - 2].v === '.' && toks[ti - 3] && toks[ti - 3].k === 'id' && /^[A-Z]/.test(toks[ti - 3].v)) start = ti - 3;
        if (start >= 0 && toks[start - 1] && toks[start - 1].v === 'const') start -= 1;
        open.push(start);
      } else if (t.v === ')') {
        const start = open.pop();
        if (start !== undefined && start >= 0) cands.push([start, ti]);
      }
    }
  } else {
    for (const el of elements) cands.push([el.startTok, el.endTok]);
  }
  const fileDup = [];
  for (const [s, e] of cands) {
    const norm = [];
    for (let k = s; k <= e; k++) {
      const t = toks[k];
      if (t.k === 'comment') continue;
      if (t.v === 'const') continue; // const-ness is not structure
      norm.push(t.k === 'str' || t.k === 'jsxtext' ? 'S' : t.k === 'num' ? 'N' : t.v);
    }
    if (norm.length < ctx.minDupTokens) continue;
    const hash = crypto.createHash('sha1').update(norm.join('\u0001')).digest('hex').slice(0, 16);
    fileDup.push({ hash, size: norm.length, s: toks[s].s, e: toks[e].e, line: toks[s].line, file: rel });
  }

  return { path: rel, category, metrics: m, details: ctx.details ? details : undefined, dupCandidates: fileDup, privateNames, resolvedImports };
}

/** Resolve an import specifier to a project-relative file (or null if external). */
function resolveImport(root, fromRel, spec, lang, ctx) {
  let base = null;
  if (lang === 'dart') {
    if (spec.startsWith('package:')) {
      if (!ctx.dartPackage || !spec.startsWith(`package:${ctx.dartPackage}/`)) return null;
      base = path.join('lib', spec.slice(`package:${ctx.dartPackage}/`.length));
    } else if (spec.startsWith('dart:')) return null;
    else base = path.join(path.dirname(fromRel), spec);
    base = path.normalize(base).split(path.sep).join('/');
    return fs.existsSync(path.join(root, base)) ? base : null;
  }
  if (spec.startsWith('.')) base = path.join(path.dirname(fromRel), spec);
  else if (spec.startsWith('@/')) base = fs.existsSync(path.join(root, 'src')) && !fs.existsSync(path.join(root, spec.slice(2).split('/')[0])) ? path.join('src', spec.slice(2)) : spec.slice(2);
  else if (spec.startsWith('src/') || spec.startsWith('~/')) base = spec.replace(/^~\//, 'src/');
  else return null;
  base = path.normalize(base).split(path.sep).join('/');
  const tries = [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, `${base}/index.tsx`, `${base}/index.ts`, `${base}/index.jsx`, `${base}/index.js`];
  for (const t of tries) { try { if (fs.statSync(path.join(root, t)).isFile()) return t; } catch { /* next */ } }
  return null;
}

function entryRoots(rels, framework) {
  if (framework === 'flutter') return rels.filter((r) => r === 'lib/main.dart' || r.startsWith('lib/_preview/'));
  return rels.filter((r) => /^(src\/)?(main|index)\.[jt]sx?$/.test(r)
    || /^(src\/)?app\/(.*\/)?(page|layout|loading|error|not-found|template|default)\.[jt]sx?$/.test(r)
    || /^(src\/)?pages\//.test(r) || /^(src\/)?middleware\.[jt]s$/.test(r));
}

// Dart: public top-level names an import brings in (resolving project-relative
// and own-package imports, following `export` one level deep). null = unknowable.
function dartExportedNames(root, fromRel, uri, ctx, depth = 0) {
  let target = null;
  if (uri.startsWith('package:')) {
    const own = ctx.dartPackage;
    if (!own || !uri.startsWith(`package:${own}/`)) return null;
    target = path.join(root, 'lib', uri.slice(`package:${own}/`.length));
  } else if (uri.startsWith('dart:')) return null;
  else target = path.resolve(path.join(root, path.dirname(fromRel)), uri);
  const key = `${target}`;
  if (ctx.dartNameCache.has(key)) return ctx.dartNameCache.get(key);
  let src;
  try { src = fs.readFileSync(target, 'utf8'); } catch { ctx.dartNameCache.set(key, null); return null; }
  const names = new Set();
  const declRe = /^(?:abstract\s+|sealed\s+|final\s+|base\s+|interface\s+|mixin\s+)*(?:class|enum|mixin|extension|typedef)\s+([A-Za-z]\w*)/gm;
  let d;
  while ((d = declRe.exec(src))) names.add(d[1]);
  // top-level functions / variables / getters at column 0 (public only)
  const topRe = /^(?!import|export|part|library|class|enum|mixin|extension|typedef|abstract|sealed|\/\/|\s)(?:const\s+|final\s+|var\s+|late\s+)?(?:[A-Za-z_][\w<>?,\s]*\s+)?(?:get\s+)?([a-zA-Z]\w*)\s*(?:=|\(|=>|;)/gm;
  while ((d = topRe.exec(src))) if (!/^(if|for|while|return|switch)$/.test(d[1])) names.add(d[1]);
  if (depth < 3) {
    const exRe = /^\s*export\s+(['"])([^'"]+)\1([^;]*);/gm;
    while ((d = exRe.exec(src))) {
      const sub = dartExportedNames(root, path.relative(root, target), d[2], ctx, depth + 1);
      if (sub) for (const n of sub) names.add(n);
    }
  }
  const out = [...names].filter((n) => !n.startsWith('_'));
  ctx.dartNameCache.set(key, out);
  return out;
}

// ── theme sprawl ──────────────────────────────────────────────────────────────
// "0 inline colours" is hollow if every literal was just renamed into the theme
// under a screen-scoped name (txnInk, adDark, histBg). Measure the vocabulary:
// how many colour tokens, how many are used once or never, how many are
// near-duplicates of another token (RGB distance < 16).
function themeSprawl(root, files) {
  const themeFiles = files.filter((f) => f.category === 'theme').map((f) => f.path);
  const tokens = [];
  for (const rel of themeFiles) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const mm of src.matchAll(/static\s+const\s+Color\s+(\w+)\s*=\s*(?:const\s+)?Color\(0x([0-9A-Fa-f]{8})\)/g)) tokens.push({ name: mm[1], hex: mm[2].slice(2).toLowerCase() });
    for (const mm of src.matchAll(/['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*['"]#([0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?['"]/g)) tokens.push({ name: mm[1], hex: mm[2].toLowerCase() });
  }
  if (!themeFiles.length) return { themeFiles: 0, colorTokens: 0, reason: 'no theme file found' };
  let body = '';
  for (const f of files) if (f.category !== 'theme' && f.category !== 'preview') body += fs.readFileSync(path.join(root, f.path), 'utf8');
  const uses = (n) => (body.match(new RegExp(`\\.${n.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const dist = (a, b) => Math.sqrt(rgb(a).reduce((acc, v, i) => acc + (v - rgb(b)[i]) ** 2, 0));
  let nearDuplicatePairs = 0;
  for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) if (dist(tokens[i].hex, tokens[j].hex) < 16) nearDuplicatePairs++;
  const useCounts = tokens.map((t) => ({ name: t.name, uses: uses(t.name) }));
  return {
    themeFiles: themeFiles.length,
    colorTokens: tokens.length,
    unusedColorTokens: useCounts.filter((u) => u.uses === 0).length,
    singleUseColorTokens: useCounts.filter((u) => u.uses === 1).length,
    nearDuplicatePairs,
    numericSuffixTokens: tokens.filter((t) => isNumericSuffixName(t.name)).length,
  };
}

// ── duplication grouping ──────────────────────────────────────────────────────

function groupDuplicates(allCands) {
  const byHash = new Map();
  for (const c of allCands) {
    const arr = byHash.get(c.hash) || [];
    arr.push(c);
    byHash.set(c.hash, arr);
  }
  // Largest first; an occurrence nested inside an already-counted duplicate is
  // not counted again (report MAXIMAL clones only).
  const groups = [...byHash.values()].filter((g) => g.length >= 2).sort((a, b) => b[0].size - a[0].size);
  const covered = new Map(); // file → [[s,e]]
  const inside = (c) => (covered.get(c.file) || []).some(([s, e]) => c.s >= s && c.e <= e);
  const out = [];
  for (const g of groups) {
    const occ = g.filter((c) => !inside(c));
    if (occ.length < 2) continue;
    for (const c of occ) { const arr = covered.get(c.file) || []; arr.push([c.s, c.e]); covered.set(c.file, arr); }
    out.push({ hash: g[0].hash, tokens: g[0].size, occurrences: occ.map((c) => ({ file: c.file, line: c.line })), redundantTokens: (occ.length - 1) * g[0].size });
  }
  return out;
}

// ── external diagnostics ────────────────────────────────────────────────────────

function which(bin) {
  try { return cp.execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; }
}

function runDiagnostics(root, framework, mode) {
  if (mode === 'off') return { ran: false, reason: 'disabled (--no-tools)' };
  if (framework === 'flutter') {
    const dart = which('dart') || which('flutter');
    if (!dart) return { ran: false, reason: 'no dart/flutter SDK on PATH' };
    if (!fs.existsSync(path.join(root, '.dart_tool', 'package_config.json'))) {
      return { ran: false, reason: 'dependencies not resolved (.dart_tool/package_config.json missing) — run `flutter pub get` first; analyzing unresolved packages reports only uri_does_not_exist noise' };
    }
    try {
      const out = cp.spawnSync(dart.endsWith('flutter') ? dart : dart, dart.endsWith('flutter') ? ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings'] : ['analyze', '--format=machine'], { cwd: root, encoding: 'utf8', timeout: 180000 });
      const text = `${out.stdout || ''}\n${out.stderr || ''}`;
      const lines = text.split('\n').filter((l) => /^(ERROR|WARNING|INFO)\|/.test(l) || /^\s*(error|warning|info) •/.test(l));
      const sev = { error: 0, warning: 0, info: 0 };
      const codes = {};
      for (const l of lines) {
        const mm = /^(ERROR|WARNING|INFO)\|\w+\|(\w+)\|/.exec(l) || /^\s*(error|warning|info) •.*• (\w+)\s*$/.exec(l);
        if (!mm) continue;
        sev[mm[1].toLowerCase()]++;
        codes[mm[2].toLowerCase()] = (codes[mm[2].toLowerCase()] || 0) + 1;
      }
      return { ran: true, tool: 'dart analyze', ...sev, byCode: codes };
    } catch (e) { return { ran: false, reason: `dart analyze failed: ${e.message}` }; }
  }
  if (framework === 'react' || framework === 'next') {
    const localTsc = path.join(root, 'node_modules', '.bin', 'tsc');
    if (!fs.existsSync(localTsc)) return { ran: false, reason: 'project node_modules/.bin/tsc missing — install deps first; tsc without @types/react reports only missing-module noise' };
    if (!fs.existsSync(path.join(root, 'tsconfig.json'))) return { ran: false, reason: 'no tsconfig.json' };
    const out = cp.spawnSync(localTsc, ['--noEmit', '-p', '.'], { cwd: root, encoding: 'utf8', timeout: 180000 });
    const lines = (out.stdout || '').split('\n').filter((l) => /error TS\d+/.test(l));
    const codes = {};
    for (const l of lines) { const c = /error (TS\d+)/.exec(l)[1]; codes[c] = (codes[c] || 0) + 1; }
    return { ran: true, tool: 'tsc --noEmit', error: lines.length, byCode: codes };
  }
  return { ran: false, reason: `no analyzer for framework ${framework}` };
}

// ── aggregation ─────────────────────────────────────────────────────────────────

const SUM_KEYS = ['lines', 'loc', 'machineNames', 'rawNodeIds', 'numericSuffixNames', 'inlineColors', 'fileLocalColorConsts',
  'materialColors', 'magicNumbers', 'figmaFractionals', 'nodesOverDepth', 'noopHandlers', 'stubHandlers', 'unusedImports',
  'unknownImports', 'positioned', 'stacks', 'codeTokens', 'handDrawn', 'privateWidgets', 'stubBody'];
const RATE_KEYS = ['machineNames', 'rawNodeIds', 'numericSuffixNames', 'inlineColors', 'fileLocalColorConsts', 'materialColors',
  'magicNumbers', 'figmaFractionals', 'noopHandlers', 'positioned'];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function aggregate(files, dupGroups) {
  const t = { files: files.length };
  for (const k of SUM_KEYS) t[k] = 0;
  t.comments = { lines: 0, figmaLeak: 0, commentedOutCode: 0, todo: 0, pipelineMarker: 0, decorative: 0, noise: 0 };
  let maxNesting = 0;
  const nestings = [];
  for (const f of files) {
    for (const k of SUM_KEYS) t[k] += f.metrics[k];
    for (const k of Object.keys(t.comments)) t.comments[k] += f.metrics.comments[k];
    maxNesting = Math.max(maxNesting, f.metrics.maxNesting);
    nestings.push(f.metrics.maxNesting);
  }
  const locs = files.map((f) => f.metrics.loc).sort((a, b) => a - b);
  nestings.sort((a, b) => a - b);
  t.maxNesting = maxNesting;
  t.nestingP90 = pct(nestings, 90);
  t.locDistribution = {
    p50: pct(locs, 50), p90: pct(locs, 90), max: locs[locs.length - 1] || 0,
    over300: locs.filter((x) => x > 300).length, over500: locs.filter((x) => x > 500).length,
  };
  const kloc = t.loc / 1000 || 1;
  t.perKloc = {};
  for (const k of RATE_KEYS) t.perKloc[k] = Math.round((t[k] / kloc) * 10) / 10;
  t.perKloc.noiseComments = Math.round((t.comments.noise / kloc) * 10) / 10;
  if (dupGroups) {
    t.duplication = {
      groups: dupGroups.length,
      occurrences: dupGroups.reduce((a, g) => a + g.occurrences.length, 0),
      redundantTokens: dupGroups.reduce((a, g) => a + g.redundantTokens, 0),
    };
    t.duplication.redundantRatio = t.codeTokens ? Math.round((t.duplication.redundantTokens / t.codeTokens) * 1000) / 1000 : 0;
  }
  return t;
}

// ── main entry ────────────────────────────────────────────────────────────────

function analyzeProject(root, opts = {}) {
  root = path.resolve(root);
  const framework = opts.framework || detectFramework(root);
  const ctx = {
    details: !!opts.details,
    deep: opts.deep || 10,
    minDupTokens: opts.minDupTokens || 40,
    dartNameCache: new Map(),
    dartPackage: null,
  };
  if (framework === 'flutter') {
    try { ctx.dartPackage = (/^name:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8')) || [])[1] || null; } catch { /* no pubspec */ }
  }
  const rels = collectFiles(root, framework);
  const results = rels.map((rel) => analyzeFile(root, rel, framework, ctx));
  const allCands = [];
  for (const r of results) {
    // preview scaffolding is copy-by-design; never let it inflate duplication
    if (r.category === 'preview') continue;
    allCands.push(...r.dupCandidates);
  }
  const dupGroups = groupDuplicates(allCands);

  // Reachability from the app entrypoints: a file nothing imports is dead weight a
  // reader still has to open (skeleton stubs, orphaned screens, unused helpers).
  const roots = entryRoots(rels, framework);
  const graph = new Map(results.map((r) => [r.path, r.resolvedImports]));
  const reachable = new Set();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const n of graph.get(f) || []) if (!reachable.has(n)) stack.push(n);
  }
  const unreachable = roots.length ? rels.filter((r) => !reachable.has(r)) : [];

  // The same private widget / local component name defined in ≥2 files = the same
  // UI re-implemented per screen (a shared component that was never extracted).
  const privByName = new Map();
  for (const r of results) {
    if (r.category === 'preview') continue;
    for (const n of new Set(r.privateNames)) privByName.set(n, [...(privByName.get(n) || []), r.path]);
  }
  const repeatedPrivate = [...privByName.entries()].filter(([, fsx]) => fsx.length >= 2)
    .map(([name, fsx]) => ({ name, files: fsx.length })).sort((a, b) => b.files - a.files);
  const dupByFile = new Map();
  for (const g of dupGroups) for (const o of g.occurrences) dupByFile.set(o.file, (dupByFile.get(o.file) || 0) + 1);
  const files = results.map((r) => ({
    path: r.path, category: r.category,
    metrics: { ...r.metrics, duplicateSubtrees: dupByFile.get(r.path) || 0, unreachable: roots.length ? (reachable.has(r.path) ? 0 : 1) : 0 },
    ...(r.details ? { details: r.details } : {}),
  }));
  const byCategory = {};
  for (const cat of [...new Set(files.map((f) => f.category))].sort()) {
    byCategory[cat] = aggregate(files.filter((f) => f.category === cat), null);
  }
  const totals = aggregate(files, dupGroups);
  totals.reachability = roots.length
    ? { entryRoots: roots.length, unreachableFiles: unreachable.length, unreachableLoc: files.filter((f) => f.metrics.unreachable).reduce((a, f) => a + f.metrics.loc, 0), sample: unreachable.slice(0, 30) }
    : { entryRoots: 0, unreachableFiles: null, reason: 'no entrypoint found (lib/main.dart, src/main.*, app/**/page.*)' };
  totals.theme = themeSprawl(root, files);
  totals.repeatedPrivateWidgets = {
    names: repeatedPrivate.length,
    redundantDefinitions: repeatedPrivate.reduce((a, x) => a + x.files - 1, 0),
    top: repeatedPrivate.slice(0, 20),
  };
  // "deliverable" = everything a frontend team would read (no verify scaffolding)
  const deliverable = aggregate(files.filter((f) => f.category !== 'preview'), null);
  const toolsMode = opts.tools === false ? 'off' : 'auto';
  return {
    tool: 'readability-report', version: VERSION,
    root, framework, generatedAt: new Date().toISOString(),
    options: { deep: ctx.deep, minDupTokens: ctx.minDupTokens },
    totals, deliverable, byCategory,
    duplicates: dupGroups.slice(0, 50),
    diagnostics: runDiagnostics(root, framework, toolsMode),
    files,
  };
}

function summarize(report) {
  const t = report.totals;
  const rows = [
    ['framework', report.framework], ['files', t.files], ['loc', t.loc],
    ['loc p50/p90/max', `${t.locDistribution.p50}/${t.locDistribution.p90}/${t.locDistribution.max}`],
    ['files >300 / >500 loc', `${t.locDistribution.over300} / ${t.locDistribution.over500}`],
    ['machineNames', `${t.machineNames} (${t.perKloc.machineNames}/kloc)`],
    ['rawNodeIds', `${t.rawNodeIds} (${t.perKloc.rawNodeIds}/kloc)`],
    ['numericSuffixNames', `${t.numericSuffixNames}`],
    ['inlineColors', `${t.inlineColors} (${t.perKloc.inlineColors}/kloc)`],
    ['fileLocalColorConsts', `${t.fileLocalColorConsts}`],
    ['materialColors', `${t.materialColors}`],
    ['magicNumbers', `${t.magicNumbers} (${t.perKloc.magicNumbers}/kloc)`],
    ['figmaFractionals', `${t.figmaFractionals}`],
    ['maxNesting / p90', `${t.maxNesting} / ${t.nestingP90}`],
    ['nodesOverDepth', `${t.nodesOverDepth}`],
    ['dup groups / redundant tok', `${t.duplication.groups} / ${t.duplication.redundantTokens} (${(t.duplication.redundantRatio * 100).toFixed(1)}%)`],
    ['noop / stub handlers', `${t.noopHandlers} / ${t.stubHandlers}`],
    ['unusedImports (unknown)', `${t.unusedImports} (${t.unknownImports})`],
    ['positioned / stacks', `${t.positioned} / ${t.stacks}`],
    ['hand-drawn painters/svg', `${t.handDrawn}`],
    ['private widgets / repeated names', `${t.privateWidgets} / ${t.repeatedPrivateWidgets.names} (+${t.repeatedPrivateWidgets.redundantDefinitions} redundant defs)`],
    ['stub bodies / unreachable files', `${t.stubBody} / ${t.reachability.unreachableFiles ?? 'n/a'}${t.reachability.unreachableLoc != null ? ` (${t.reachability.unreachableLoc} loc)` : ''}`],
    ['theme colours (unused/1-use/near-dup pairs)', t.theme.themeFiles ? `${t.theme.colorTokens} (${t.theme.unusedColorTokens}/${t.theme.singleUseColorTokens}/${t.theme.nearDuplicatePairs})` : 'no theme file'],
    ['comments noise (leak/code/todo)', `${t.comments.noise} (${t.comments.figmaLeak}/${t.comments.commentedOutCode}/${t.comments.todo})`],
    ['diagnostics', report.diagnostics.ran ? JSON.stringify(report.diagnostics) : `skipped: ${report.diagnostics.reason}`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n');
}

function compare(base, cur) {
  const lines = [];
  const walkObj = (a, b, prefix) => {
    for (const k of Object.keys(b)) {
      const av = a ? a[k] : undefined; const bv = b[k];
      if (bv && typeof bv === 'object') walkObj(av, bv, `${prefix}${k}.`);
      else if (typeof bv === 'number') {
        const d = typeof av === 'number' ? bv - av : null;
        if (d !== 0) lines.push(`${(prefix + k).padEnd(36)} ${String(av ?? '-').padStart(8)} → ${String(bv).padStart(8)}  ${d === null ? '' : (d > 0 ? '+' : '') + Math.round(d * 1000) / 1000}`);
      }
    }
  };
  walkObj(base.totals, cur.totals, '');
  return lines.join('\n') || '(no change in totals)';
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--framework') o.framework = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--summary') o.summary = true;
    else if (a === '--details') o.details = true;
    else if (a === '--compare') o.compare = argv[++i];
    else if (a === '--min-dup-tokens') o.minDupTokens = Number(argv[++i]);
    else if (a === '--deep') o.deep = Number(argv[++i]);
    else if (a === '--tools') o.tools = true;
    else if (a === '--no-tools') o.tools = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else o._.push(a);
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._[0]) {
    console.error('usage: node scripts/readability-report.cjs <projectDir> [--framework flutter|react|next] [--out f.json] [--summary] [--details] [--compare base.json] [--min-dup-tokens N] [--deep N] [--no-tools]');
    process.exit(args.help ? 0 : 2);
  }
  const dir = args._[0];
  if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2); }
  const report = analyzeProject(dir, args);
  const json = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(args.out, json);
  else process.stdout.write(`${json}\n`);
  if (args.summary) console.error(summarize(report));
  if (args.compare) console.error(compare(JSON.parse(fs.readFileSync(args.compare, 'utf8')), report));
}

module.exports = {
  analyzeProject, analyzeFile, detectFramework, tokenizeDart, tokenizeTs, groupDuplicates, summarize, compare,
  isNumericSuffixName,
};
