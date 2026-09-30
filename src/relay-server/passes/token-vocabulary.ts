// =============================================================================
// File: src/relay-server/passes/token-vocabulary.ts
//
// Readability F4 + F5 inside Phase 7f (deepenTokensAndCleanup), Flutter side.
//
// The Ping audit: of 317 layout literals in the screens, 270 were width/height/size
// values no token covered, the remaining radii were pills (28/100/40) and sheet
// corners (`Radius.circular(24)` inside `BorderRadius.only`), and 7f made ZERO
// substitutions because it only did exact matches in EdgeInsets.all/symmetric,
// SizedBox and BorderRadius.circular. These were missing tokens, not missed swaps.
//
// So, deterministically and without changing a pixel:
//  1. VOCABULARY AMENDMENT — a value that recurs (≥2 uses across the app) in a
//     recognisable role and has no token gets ONE role-named token in the theme:
//       icon sizes (Icon size / square SvgPicture/Image ≤48)      → iconSm/iconMd/…
//       square boxes 28–120 (circle → avatar*)                     → tile*/avatar*
//       a control's height 36–64 (a Container/SizedBox with text)  → buttonHeight*
//       gaps (lone SizedBox width/height), EdgeInsets values, spacing: → s<N>
//       BorderRadius.circular(N) / Radius.circular(N)              → r<N> / corner<N>
//       a stadium radius (N ≥ half the box's literal short side)   → radiusPill
//     Counter-named colour tokens (ink2, neutral3, accent2) are RENAMED to role names
//     (textPrimaryDark, textMuted, info …) across the theme and every reference.
//  2. SUBSTITUTION — every literal in those positions whose value equals a token of
//     its family becomes `AppTheme.<token>` (exact value; a pill only where the
//     radius provably renders as a stadium, i.e. N ≥ short side / 2, where a larger
//     radius clamps to the same shape).
// =============================================================================

import * as path from 'path';
import { ladderNames, ICON_LADDER, AVATAR_LADDER, TILE_LADDER, BUTTON_LADDER, colorRole, colorLuminance, PILL_RADIUS } from '../design-vocabulary';

export interface VocabThemeModel {
  className: string;
  themeFileRel: string;
  colors: Array<{ name: string; argb: string }>;
  spacing: Array<{ name: string; value: number }>;
  radius: Array<{ name: string; value: number }>;
  /** `static const double <name> = N` that are not spacing (sizes). */
  sizes: Array<{ name: string; value: number }>;
  /** `static const Radius <name> = Radius.circular(N)`. */
  corners: Array<{ name: string; value: number }>;
}

export interface VocabChange { file: string; kind: string; from: string; to: string }

/** Parse the extra vocabulary (sizes, corners) the base ThemeModel does not carry. */
export function parseVocabExtras(src: string): { sizes: Array<{ name: string; value: number }>; corners: Array<{ name: string; value: number }> } {
  const sizes: Array<{ name: string; value: number }> = [];
  for (const block of src.matchAll(/static\s+const\s+double\s+((?:[A-Za-z_]\w*\s*=\s*-?\d+(?:\.\d+)?\s*,?\s*)+);/g)) {
    for (const pm of block[1].matchAll(/([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)/g)) {
      if (!/^s\d/.test(pm[1])) sizes.push({ name: pm[1], value: Number(pm[2]) });
    }
  }
  const corners: Array<{ name: string; value: number }> = [];
  for (const m of src.matchAll(/static\s+const\s+Radius\s+([A-Za-z_]\w*)\s*=\s*Radius\.circular\((\d+(?:\.\d+)?)\)\s*;/g)) corners.push({ name: m[1], value: Number(m[2]) });
  return { sizes, corners };
}

// ── call-site scanning ───────────────────────────────────────────────────────

function matchParen(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Top-level named args of a call: key → {value text, absolute offset of the value}. */
function namedArgs(src: string, open: number, close: number): Map<string, { text: string; at: number }> {
  const out = new Map<string, { text: string; at: number }>();
  let depth = 0; let inStr: string | null = null; let segStart = open + 1;
  const flush = (end: number): void => {
    const seg = src.slice(segStart, end);
    const m = /^\s*([A-Za-z_]\w*)\s*:\s*/.exec(seg);
    if (m) out.set(m[1], { text: seg.slice(m[0].length).trim(), at: segStart + m[0].length });
  };
  for (let i = open + 1; i < close; i++) {
    const c = src[i];
    if (inStr) { if (c === inStr && src[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { flush(i); segStart = i + 1; }
  }
  flush(close);
  return out;
}

const NUM = /^-?\d+(?:\.\d+)?$/;

/** One literal occurrence the vocabulary can name: family + value + where it is. */
export interface VocabSite { family: 'icon' | 'avatar' | 'tile' | 'button' | 'spacing' | 'radius' | 'corner' | 'pill'; value: number; start: number; end: number; /** the element the literal belongs to (a square's width + height are ONE use). */ el?: number }

/** Find every literal in a recognisable role in one Dart source. */
export function scanVocabSites(src: string, resolve?: (expr: string) => number | null): VocabSite[] {
  const sites: VocabSite[] = [];
  // `resolve` (planning only) also counts a position already holding a token
  // (`size: AppTheme.iconMd`) as a use of its value, so the ladder a second run
  // plans is the same one the first run planned — 7f converges.
  const numAt = (a: { text: string; at: number } | undefined): { value: number; start: number; end: number } | null => {
    if (!a) return null;
    if (NUM.test(a.text)) return { value: Number(a.text), start: a.at, end: a.at + a.text.length };
    const v = resolve ? resolve(a.text) : null;
    return v != null ? { value: v, start: a.at, end: a.at + a.text.length } : null;
  };
  const pillSafe = new Set<number>();   // offsets of BorderRadius.circular( calls proven stadium

  const callRe = /\b(Icon|SvgPicture\.(?:asset|network|string|memory)|Image\.(?:asset|network|file|memory)|Container|AnimatedContainer|SizedBox|Ink|DecoratedBox|Row|Column|Wrap|EdgeInsets\.(?:all|symmetric|only|fromLTRB))\s*\(/g;
  for (const m of src.matchAll(callRe)) {
    const callee = m[1];
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = namedArgs(src, open, close);
    const w = numAt(args.get('width'));
    const h = numAt(args.get('height'));
    if (callee === 'Icon') {
      const sz = numAt(args.get('size'));
      if (sz && sz.value <= 48) sites.push({ family: 'icon', ...sz });
      continue;
    }
    if (/^(SvgPicture|Image)\./.test(callee)) {
      if (w && h && w.value === h.value && w.value <= 48) { sites.push({ family: 'icon', ...w, el: open }); sites.push({ family: 'icon', ...h, el: open }); }
      continue;
    }
    if (callee === 'Row' || callee === 'Column' || callee === 'Wrap') {
      const sp = numAt(args.get('spacing'));
      if (sp) sites.push({ family: 'spacing', ...sp });
      continue;
    }
    if (callee.startsWith('EdgeInsets.')) {
      const inner = src.slice(open + 1, close);
      if (callee === 'EdgeInsets.all' || callee === 'EdgeInsets.fromLTRB') {
        // positional numbers
        let off = open + 1;
        for (const part of inner.split(',')) {
          const t = part.trim();
          const lead = part.length - part.trimStart().length;
          if (NUM.test(t) && Number(t) > 0) sites.push({ family: 'spacing', value: Number(t), start: off + lead, end: off + lead + t.length });
          off += part.length + 1;
        }
      } else {
        for (const [k, a] of args) if (/^(horizontal|vertical|left|top|right|bottom)$/.test(k)) { const n = numAt(a); if (n && n.value > 0) sites.push({ family: 'spacing', ...n }); }
      }
      continue;
    }
    // Container / AnimatedContainer / SizedBox / Ink / DecoratedBox
    const hasChild = args.has('child');
    const argText = src.slice(open + 1, close);
    if (callee === 'SizedBox' && !hasChild && ((w && !args.has('height')) || (h && !args.has('width')))) {
      const g = (w ?? h)!;
      if (g.value > 0 && g.value <= 64) sites.push({ family: 'spacing', ...g });
      continue;
    }
    if (w && h && w.value === h.value && w.value > 0 && w.value < 28) {
      // a small square slot (an icon's box: SizedBox(20×20, child: icon/painter))
      sites.push({ family: 'icon', ...w, el: open }); sites.push({ family: 'icon', ...h, el: open });
    } else if (w && h && w.value === h.value && w.value >= 28 && w.value <= 120) {
      // a circle: BoxShape.circle, a clipped oval child, or a corner radius ≥ half the side
      const decText = args.get('decoration')?.text ?? '';
      const rr = /BorderRadius\.circular\(\s*(\d+(?:\.\d+)?)\s*\)/.exec(decText);
      const circle = /BoxShape\.circle|\bradiusPill\b/.test(decText) || (!!rr && Number(rr[1]) * 2 >= w.value) || /^(?:const\s+)?(?:ClipOval|CircleAvatar)\b/.test(args.get('child')?.text ?? '');
      const fam = circle ? 'avatar' : 'tile';
      sites.push({ family: fam, ...w, el: open }); sites.push({ family: fam, ...h, el: open });
    } else if (h && (!w || args.get('width')?.text === 'double.infinity') && h.value >= 36 && h.value <= 64 && hasChild && /\b(Text|TextField|TextFormField|ElevatedButton|TextButton|OutlinedButton)\s*\(/.test(argText)) {
      sites.push({ family: 'button', ...h });
    }
    // a stadium radius: BorderRadius.circular(N) in this box's decoration with a
    // literal short side ≤ 2N renders exactly like any larger radius.
    const dec = args.get('decoration');
    const dims = [w?.value, h?.value].filter((v): v is number => typeof v === 'number');
    if (dec && dims.length) {
      const short = Math.min(...dims);
      for (const r of dec.text.matchAll(/BorderRadius\.circular\(\s*(\d+(?:\.\d+)?)\s*\)/g)) {
        if (Number(r[1]) * 2 >= short) pillSafe.add(dec.at + r.index!);
      }
    }
  }
  // radii (after the box scan so the pill proof is known)
  for (const r of src.matchAll(/\b(Border)?Radius\.circular\(\s*(\d+(?:\.\d+)?)\s*\)/g)) {
    const whole = !!r[1];
    const value = Number(r[2]);
    if (!(value > 0)) continue;
    const start = r.index!;
    if (whole) sites.push({ family: pillSafe.has(start) ? 'pill' : 'radius', value, start, end: start + r[0].length });
    else sites.push({ family: 'corner', value, start, end: start + r[0].length });
  }
  return sites;
}

// ── amendment ────────────────────────────────────────────────────────────────

export interface AmendPlan {
  /** new declarations to add to the theme class. */
  add: { spacing: number[]; radius: number[]; corners: number[]; pill: boolean; sizes: Array<{ name: string; value: number }> };
  /** counter-named colour tokens → role names. */
  renames: Array<{ from: string; to: string }>;
}

const COUNTER_COLOR = /^(?:ink|neutral|accent|color|colour|grey|gray|surface|primary|secondary|text)\d+$/;

/** Decide the vocabulary to add (≥2 uses) and the colour renames. Pure. */
export function planVocabularyAmendment(theme: VocabThemeModel, sitesByFile: VocabSite[][], colorRefs: Map<string, number>): AmendPlan {
  const all = sitesByFile.flatMap((sites, fi) => sites.map((s) => ({ ...s, key: `${fi}:${s.el ?? s.start}` })));
  /** uses per value = distinct ELEMENTS (a square's width and height count once). */
  const count = (fam: VocabSite['family']): Map<number, number> => {
    const seen = new Map<number, Set<string>>();
    for (const s of all) if (s.family === fam) seen.set(s.value, (seen.get(s.value) ?? new Set()).add(s.key));
    return new Map([...seen].map(([v, set]) => [v, set.size]));
  };
  const hasSpacing = new Set(theme.spacing.map((s) => s.value));
  const hasRadius = new Set(theme.radius.map((r) => r.value));
  const hasCorner = new Set(theme.corners.map((c) => c.value));
  const recurring = (m: Map<number, number>, ok: (v: number) => boolean): number[] => [...m.entries()].filter(([v, n]) => n >= 2 && ok(v)).map(([v]) => v).sort((a, b) => a - b);
  const spacing = recurring(count('spacing'), (v) => Number.isInteger(v) && v > 0 && v <= 64 && !hasSpacing.has(v));
  // Token names carry the value, so only whole-pixel values get one (a 2.5 radius
  // stays a literal: `corner2_5` would read as a counter).
  const radius = recurring(count('radius'), (v) => v > 0 && v <= 64 && Number.isInteger(v) && !hasRadius.has(v));
  const corners = recurring(count('corner'), (v) => v > 0 && v <= 64 && Number.isInteger(v)).filter((v) => !hasCorner.has(v));
  const pillSites = new Set(all.filter((s) => s.family === 'pill').map((s) => s.key)).size;
  const pill = pillSites >= 2 && !theme.radius.some((r) => r.value >= PILL_RADIUS);

  // Size families — named on a ladder around the most-used value; a family name
  // that already exists in the theme is never re-declared.
  const taken = new Set([...theme.sizes.map((z) => z.name), ...theme.spacing.map((z) => z.name), ...theme.radius.map((z) => z.name), ...theme.colors.map((c) => c.name)]);
  const existingSize = (fam: string, v: number): boolean => theme.sizes.some((z) => z.value === v && z.name.toLowerCase().startsWith(fam));
  const sizes: Array<{ name: string; value: number }> = [];
  const fams: Array<[VocabSite['family'], string[], number]> = [['icon', ICON_LADDER, 2], ['avatar', AVATAR_LADDER, 1], ['tile', TILE_LADDER, 2], ['button', BUTTON_LADDER, 1]];
  for (const [fam, ladder, md] of fams) {
    const famPrefix = fam === 'button' ? 'buttonheight' : fam;
    // Values already tokened in this family stay on the ladder (their positions were
    // counted through `resolve`) and are skipped here, so the ladder is stable.
    const counts = count(fam);
    for (const t of ladderNames(counts, ladder, md, 2)) {
      if (existingSize(famPrefix, t.value)) continue;
      if (taken.has(t.name) || !Number.isInteger(t.value)) continue;
      taken.add(t.name);
      sizes.push({ name: t.name, value: t.value });
    }
  }

  // Colour renames: counter-named tokens get their role name when it is free.
  const renames: Array<{ from: string; to: string }> = [];
  const colorNames = new Set(theme.colors.map((c) => c.name));
  const brand = theme.colors.find((c) => c.name === 'brand')?.argb.slice(2) ?? null;
  const holders = new Map<string, string>(); // role → hex of the colour holding it
  for (const c of theme.colors) holders.set(c.name, c.argb.slice(2));
  const counters = theme.colors.filter((c) => COUNTER_COLOR.test(c.name)).sort((a, b) => (colorRefs.get(b.name) ?? 0) - (colorRefs.get(a.name) ?? 0));
  for (const c of counters) {
    const hex = `#${c.argb.slice(2)}`;
    const role = colorRole(hex, brand ? `#${brand}` : null);
    const candidates = [role];
    const holderHex = holders.get(role);
    if (holderHex) {
      const lighter = colorLuminance(hex) >= colorLuminance(`#${holderHex}`);
      candidates.push(...(lighter ? ['Light', 'Lighter', 'Lightest'] : ['Dark', 'Darker', 'Darkest']).map((q) => `${role}${q}`), `${role}Alt`, `${role}Muted`);
    }
    const to = candidates.find((n) => !colorNames.has(n) && !taken.has(n) && n !== c.name);
    if (!to) continue;
    colorNames.add(to); taken.add(to); holders.set(to, c.argb.slice(2));
    renames.push({ from: c.name, to });
  }
  return { add: { spacing, radius, corners, pill, sizes }, renames };
}

/** Insert the planned declarations into the theme source (inside the class). */
export function applyAmendmentToTheme(src: string, className: string, plan: AmendPlan): string {
  let out = src;
  for (const r of plan.renames) {
    out = out.replace(new RegExp(`\\b${r.from}\\b`, 'g'), r.to);
  }
  const lines: string[] = [];
  const a = plan.add;
  if (a.spacing.length) lines.push(`  static const double ${a.spacing.map((n) => `s${fmt(n)} = ${fmt(n)}`).join(', ')};`);
  for (const n of a.radius) lines.push(`  static const BorderRadius r${fmt(n)} = BorderRadius.all(Radius.circular(${fmt(n)}));`);
  if (a.pill) lines.push(`  static const BorderRadius radiusPill = BorderRadius.all(Radius.circular(${PILL_RADIUS}));`);
  for (const n of a.corners) lines.push(`  static const Radius corner${fmt(n)} = Radius.circular(${fmt(n)});`);
  if (a.sizes.length) lines.push(`  static const double ${a.sizes.map((z) => `${z.name} = ${fmt(z.value)}`).join(', ')};`);
  if (!lines.length) return out;
  const cls = new RegExp(`class\\s+${className}\\s*\\{`).exec(out);
  if (!cls) return out;
  const open = out.indexOf('{', cls.index);
  const close = matchParen(out, open);
  if (close < 0) return out;
  // before the first method (ThemeData / text-style helpers), else before the closing brace
  const body = out.slice(open, close);
  const firstMethod = /\n(\s*)static\s+(?:ThemeData|TextStyle|EdgeInsets)\b[^;=]*\(/.exec(body);
  const at = firstMethod ? open + firstMethod.index + 1 : close;
  const block = `  // ── Vocabulary: recurring values across the screens, role-named (finalize 7f) ──\n${lines.join('\n')}\n\n`;
  return out.slice(0, at) + block + out.slice(at);
}

const fmt = (n: number): string => String(n);

// ── substitution ─────────────────────────────────────────────────────────────

export interface VocabIndex {
  className: string;
  spacing: Map<number, string>;
  radius: Map<number, string>;
  corners: Map<number, string>;
  pill: string | null;
  sizes: { icon: Map<number, string>; avatar: Map<number, string>; tile: Map<number, string>; button: Map<number, string> };
}

export function vocabIndex(theme: VocabThemeModel): VocabIndex {
  const first = (xs: Array<{ name: string; value: number }>, filter: (n: string) => boolean = () => true): Map<number, string> => {
    const m = new Map<number, string>();
    for (const x of xs) if (filter(x.name) && !m.has(x.value)) m.set(x.value, x.name);
    return m;
  };
  const pill = theme.radius.find((r) => r.value >= PILL_RADIUS)?.name ?? null;
  return {
    className: theme.className,
    spacing: first(theme.spacing),
    radius: first(theme.radius.filter((r) => r.value < PILL_RADIUS)),
    corners: first(theme.corners),
    pill,
    sizes: {
      icon: first(theme.sizes, (n) => /^icon/.test(n)),
      avatar: first(theme.sizes, (n) => /^avatar/.test(n)),
      tile: first(theme.sizes, (n) => /^tile/.test(n)),
      button: first(theme.sizes, (n) => /^buttonHeight/.test(n)),
    },
  };
}

/** Replace every site whose value has a token of its family. Returns the new source. */
export function substituteVocabulary(src: string, rel: string, ix: VocabIndex): { src: string; count: { spacing: number; radius: number; sizes: number }; changes: VocabChange[] } {
  const count = { spacing: 0, radius: 0, sizes: 0 };
  const changes: VocabChange[] = [];
  const sites = scanVocabSites(src);
  const edits: Array<{ start: number; end: number; to: string; kind: string; from: string }> = [];
  const T = ix.className;
  for (const s of sites) {
    let tok: string | undefined;
    let kind = s.family;
    switch (s.family) {
      case 'spacing': { const n = ix.spacing.get(s.value); if (n) tok = `${T}.${n}`; break; }
      case 'corner': { const n = ix.corners.get(s.value); if (n) tok = `${T}.${n}`; break; }
      case 'radius': { const n = ix.radius.get(s.value); if (n) tok = `${T}.${n}`; break; }
      case 'pill': {
        if (ix.pill) { tok = `${T}.${ix.pill}`; break; }
        const n = ix.radius.get(s.value); if (n) { tok = `${T}.${n}`; kind = 'radius'; }
        break;
      }
      default: { const n = ix.sizes[s.family].get(s.value); if (n) tok = `${T}.${n}`; }
    }
    if (tok) edits.push({ start: s.start, end: s.end, to: tok, kind, from: src.slice(s.start, s.end) });
  }
  // de-overlap (a site inside another's span is dropped), apply right-to-left
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof edits = [];
  for (const e of edits) if (!kept.length || e.start >= kept[kept.length - 1].end) kept.push(e);
  let out = src;
  for (const e of [...kept].reverse()) out = out.slice(0, e.start) + e.to + out.slice(e.end);
  for (const e of kept) {
    if (e.kind === 'spacing') count.spacing++;
    else if (e.kind === 'radius' || e.kind === 'corner' || e.kind === 'pill') count.radius++;
    else count.sizes++;
    changes.push({ file: rel, kind: e.kind === 'spacing' || e.kind === 'radius' || e.kind === 'corner' || e.kind === 'pill' ? e.kind : `size:${e.kind}`, from: e.from, to: e.to });
  }
  return { src: out, count, changes };
}

/** Rename `AppTheme.<from>` references in a non-theme source. */
export function applyColorRenames(src: string, className: string, renames: Array<{ from: string; to: string }>): { src: string; count: number } {
  let count = 0;
  let out = src;
  for (const r of renames) {
    out = out.replace(new RegExp(`\\b${className}\\.${r.from}\\b`, 'g'), () => { count++; return `${className}.${r.to}`; });
  }
  return { src: out, count };
}

export const themeRelOf = (rel: string): string => rel.split(path.sep).join('/');

// ── Text-style names (F4 fix round) ──────────────────────────────────────────

/** Stems that say nothing about a text style's role — the readability metric's
 *  generic stems (a `section16` reads like Figma's "Section 16"). */
const GENERIC_TEXT_STEMS = new Set(['section', 'text', 'style', 'item', 'content', 'block', 'part', 'element', 'group', 'frame', 'container', 'box', 'view', 'value', 'data', 'wrapper', 'component', 'widget', 'variant', 'other']);

/** One text style as the theme declares it: its name, font size and weight (100–900). */
export interface TextStyleDecl { name: string; size?: number; weight?: number }

/**
 * `section15` / `section16` are the theme's type-scale convention (`title24`,
 * `body14` — role + size) with a stem that names no role. Keep the convention and
 * add the role the weight shows: ≥600 → `Heading`, else `Body` — `section16` (w600)
 * → `sectionHeading16`. Only when the number IS the style's font size (a real
 * counter is not renamed — its number means nothing we can keep) and the new name is
 * free. Pure: names only, no rendered change.
 */
export function planTextStyleRenames(styles: TextStyleDecl[], taken: Iterable<string> = []): Array<{ from: string; to: string }> {
  const used = new Set([...taken, ...styles.map((s) => s.name)]);
  const out: Array<{ from: string; to: string }> = [];
  for (const s of styles) {
    const m = /^([a-z]+)(\d{1,3})$/.exec(s.name);
    if (!m || !GENERIC_TEXT_STEMS.has(m[1]) || s.size == null || Number(m[2]) !== s.size) continue;
    const role = (s.weight ?? 400) >= 600 ? 'Heading' : 'Body';
    const to = `${m[1]}${role}${m[2]}`;
    if (used.has(to)) continue;
    used.add(to);
    out.push({ from: s.name, to });
  }
  return out;
}

/** A Dart text-style helper's size + weight: `fontSize: 15` / `fontWeight: FontWeight.w700`,
 *  or the positional form a `_m(15, FontWeight.w700, …)` factory uses. */
export function dartTextStyleDecls(themeSrc: string): TextStyleDecl[] {
  const out: TextStyleDecl[] = [];
  for (const m of themeSrc.matchAll(/static\s+TextStyle\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:=>\s*([^;]*);|\{([\s\S]*?)\})/g)) {
    const body = m[3] ?? m[4] ?? '';
    const size = /fontSize\s*:\s*(\d+(?:\.\d+)?)/.exec(body)?.[1] ?? /^\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\s*\(\s*(\d+(?:\.\d+)?)\s*,/.exec(body)?.[1];
    const weight = /FontWeight\.w(\d00)/.exec(body)?.[1] ?? (/FontWeight\.bold/.test(body) ? '700' : undefined);
    out.push({ name: m[1], ...(size ? { size: Number(size) } : {}), ...(weight ? { weight: Number(weight) } : {}) });
  }
  return out;
}

/** Rename a Dart text-style helper's declaration (`static TextStyle x(`). */
export function renameDartTextStyleDecl(themeSrc: string, from: string, to: string): string {
  return themeSrc.replace(new RegExp(`(static\\s+TextStyle\\s+)${from}(\\s*\\()`), `$1${to}$2`);
}
