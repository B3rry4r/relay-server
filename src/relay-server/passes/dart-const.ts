// =============================================================================
// File: src/relay-server/passes/dart-const.ts
//
// Keep a Dart source lint-neutral after a readability rewrite. Replacing a
// non-constant expression with a constant token (`BorderRadius.circular(28)` →
// `AppTheme.r28`, a literal → `AppTheme.iconMd`) can make the enclosing constructor
// call constant-evaluable, and `prefer_const_constructors` then flags it: the Ping
// dry run turned 64 size swaps into 8 new analyzer infos. This module finds the
// OUTERMOST constructor call that is now entirely constant, writes `const` in front
// of it, and drops the now-redundant `const` inside it (`unnecessary_const`).
//
// Conservative by construction: only constructors known to have a const
// constructor are promoted, and an identifier counts as constant only when it is a
// literal, an enum-style `Type.member`, or a theme member declared `static const`.
// =============================================================================

/** Flutter/Dart constructors with a const constructor (the ones generated code uses). */
const CONST_CTORS = new Set([
  'BoxDecoration', 'ShapeDecoration', 'RoundedRectangleBorder', 'StadiumBorder', 'CircleBorder', 'BorderSide',
  'Border', 'BoxShadow', 'TextStyle', 'Icon', 'Text', 'SizedBox', 'SizedBox.square', 'SizedBox.shrink', 'SizedBox.expand',
  'Padding', 'Center', 'Align', 'Expanded', 'Flexible', 'Spacer', 'Divider', 'VerticalDivider', 'ColoredBox', 'DecoratedBox',
  'Opacity', 'ClipRRect', 'Positioned', 'Row', 'Column', 'Stack', 'Wrap', 'ColorFilter.mode', 'LinearGradient',
  'RadialGradient', 'Offset', 'Size', 'Size.square', 'Radius.circular', 'Radius.elliptical', 'BorderRadius.all',
  'BorderRadius.only', 'BorderRadius.vertical', 'BorderRadius.horizontal', 'EdgeInsets.all', 'EdgeInsets.only',
  'EdgeInsets.symmetric', 'EdgeInsets.fromLTRB', 'EdgeInsetsDirectional.only', 'EdgeInsetsDirectional.fromSTEB',
  'Duration', 'Color', 'IconThemeData', 'AspectRatio', 'FittedBox', 'ConstrainedBox', 'BoxConstraints',
  'BoxConstraints.tightFor', 'SafeArea', 'Visibility', 'CircularProgressIndicator', 'Tooltip', 'Chip',
]);

export interface ConstCtx {
  /** Theme member names declared `static const` (e.g. `AppTheme.brand`). */
  themeConsts: Set<string>;
  themeClass: string;
}

function matchClose(s: string, open: number): number {
  const pair: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const want = pair[s[open]];
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return c === want ? i : -1; }
  }
  return -1;
}

function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0; let inStr: string | null = null; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Is this Dart expression a compile-time constant (conservatively)? */
export function isConstExpr(expr: string, ctx: ConstCtx): boolean {
  let e = expr.trim().replace(/^const\s+/, '');
  if (!e) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(e) || /^0x[0-9A-Fa-f]+$/.test(e)) return true;
  if (/^(true|false|null)$/.test(e)) return true;
  if (/^'(?:[^'\\$]|\\.)*'$/.test(e) || /^"(?:[^"\\$]|\\.)*"$/.test(e)) return true;
  if (e === 'double.infinity') return true;
  // Type.member (enum-style / static const) — theme members must be declared const.
  const mm = /^([A-Z]\w*)\.([A-Za-z_]\w*)$/.exec(e);
  if (mm) return mm[1] === ctx.themeClass ? ctx.themeConsts.has(mm[2]) : true;
  // arithmetic of constants: a / 2, x * 2 + 1
  const arith = splitTop(e.replace(/\s*([+*/]|(?<=\S)\s-\s)\s*/g, '\u0001'), '\u0001');
  if (arith.length > 1) return arith.every((p) => isConstExpr(p, ctx));
  // list literal
  if (e.startsWith('[') && matchClose(e, 0) === e.length - 1) {
    const inner = e.slice(1, -1);
    if (/\b(for|if)\s*\(|\.\.\./.test(inner)) return false;
    return splitTop(inner).every((x) => !x.trim() || isConstExpr(x, ctx));
  }
  // constructor call
  const cm = /^([A-Z]\w*(?:\.[a-zA-Z]\w*)?)\s*\(/.exec(e);
  if (cm) {
    const open = cm[0].length - 1;
    if (matchClose(e, open) !== e.length - 1) return false;
    if (!CONST_CTORS.has(cm[1])) return false;
    return splitTop(e.slice(open + 1, -1)).every((a) => {
      const t = a.trim();
      if (!t) return true;
      const kv = /^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(t);
      return isConstExpr(kv ? kv[2] : t, ctx);
    });
  }
  return false;
}

/** True when `at` sits inside an enclosing `const X(...)` / `const [...]`. */
export function inConstContext(src: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ')' || c === ']' || c === '}') { depth++; continue; }
    if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) { depth--; continue; }
      const before = src.slice(Math.max(0, i - 120), i);
      if (/\bconst\s+[A-Za-z_][\w.]*(?:<[^>]*>)?\s*$/.test(before) || /\bconst\s*(?:<[^>]*>)?\s*$/.test(before)) return true;
      if (c === '{') return false;
    }
    if (c === ';' && depth === 0) return false;
  }
  return false;
}

/**
 * Write `const` before every OUTERMOST whitelisted constructor call that is now fully
 * constant and mentions the theme class (the calls a token swap can have affected),
 * removing the redundant inner `const`s. Returns the new source and the count.
 */
export function promoteConst(src: string, ctx: ConstCtx): { src: string; promoted: number } {
  const re = /(?<![\w.])([A-Z]\w*(?:\.[a-zA-Z]\w*)?)\s*\(/g;
  const cands: Array<{ start: number; end: number }> = [];
  for (const m of src.matchAll(re)) {
    if (!CONST_CTORS.has(m[1])) continue;
    const start = m.index!;
    if (/\bconst\s+$/.test(src.slice(Math.max(0, start - 12), start))) continue;
    const open = start + m[0].length - 1;
    const close = matchClose(src, open);
    if (close < 0) continue;
    const expr = src.slice(start, close + 1);
    if (!expr.includes(`${ctx.themeClass}.`)) continue;
    if (!isConstExpr(expr, ctx)) continue;
    if (inConstContext(src, start)) continue;
    cands.push({ start, end: close + 1 });
  }
  // outermost only
  const outer = cands.filter((c) => !cands.some((o) => o !== c && o.start <= c.start && o.end >= c.end));
  let out = src;
  for (const c of [...outer].sort((a, b) => b.start - a.start)) {
    const inner = out.slice(c.start, c.end).replace(/\bconst\s+(?=[A-Z[])/g, '');
    out = `${out.slice(0, c.start)}const ${inner}${out.slice(c.end)}`;
  }
  return { src: out, promoted: outer.length };
}

/** `static const <Type> <name>` members of a Dart theme class source. */
export function themeConstMembers(themeSrc: string): Set<string> {
  const out = new Set<string>();
  for (const m of themeSrc.matchAll(/static\s+const\s+[A-Za-z_][\w<>?]*\s+([^;]+);/g)) {
    for (const pm of m[1].matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*=/g)) out.add(pm[1]);
  }
  return out;
}
