/**
 * web-box-model.ts — when is `borderRadius: r` ALREADY a full stadium in the browser?
 *
 * Phase 7f (web) may swap a radius for the theme's pill token (9999) only when that
 * paints the same pixels. CSS clamps a uniform radius to min(W, H) / 2 of the BORDER
 * box, so the swap is exact iff 2r ≥ min(W, H) — and that needs an UPPER bound on the
 * rendered border box. Every input that can grow the box must be bounded:
 *
 *   - the style object itself: width/height, padding, border, min-size, flex growth;
 *   - the element: which element it is (its UA box-sizing, UA padding and border —
 *     `<input>`/`<textarea>` are content-box with engine-specific padding and border,
 *     `<button>`/`<select>` are border-box), whether width/height apply at all
 *     (`<span>`), and whether it is a component that may do anything with `style`;
 *   - author CSS that can reach it: a `className` (or a spread of props that may carry
 *     one) brings rules we do not resolve — never provable, whatever the box-sizing
 *     (a class's `min-height` or `padding: 30px 0` grows even a border-box button) —
 *     and the app's global stylesheets, whose rules are checked selector by selector
 *     for any declaration that could grow the element (type / universal / id /
 *     attribute selectors, nested CSS and `@media` included);
 *   - a style object outside JSX: its element is whatever uses it, so every use in
 *     the file must be a `style={name}` on an element that proves the box, and the
 *     object must not escape (exported, spread, passed around).
 *
 * Anything we cannot bound → not a stadium (the radius keeps its literal).
 */

/** Everything the box check needs beyond the style object's own source. */
export interface WebBoxContext {
  /** token expression → px (a padding 7f already turned into `AppTheme.spacing.s10` still counts as 10 on run 2). */
  resolve?: (expr: string) => number | null;
  /** the app's global CSS resets every element to `box-sizing: border-box`. */
  borderBox?: boolean;
  /** does some global stylesheet rule that could grow the box reach this element? (absent = no global CSS known) */
  cssMayGrow?: (el: ElementFacts) => boolean;
}

/** What a selector can see of a JSX element: its tag and its `id` (undefined = no id attribute, null = dynamic). */
export interface ElementFacts { tag: string; id?: string | null }

// ── style-object parsing ────────────────────────────────────────────────────

/** A flat object-literal body → key → raw value text (top-level commas only). A
 *  spread (`...base`) is recorded as the key `...` — its keys are unknown. */
export function objectEntries(body: string): Map<string, string> {
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
export function cssLengths(raw: string, resolve?: (expr: string) => number | null): number[] | null {
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

// ── elements ────────────────────────────────────────────────────────────────

/** Inline-level: width/height do not apply unless the style sets a display. No UA padding/border. */
const INLINE_TAGS = new Set(['span', 'a', 'em', 'strong', 'b', 'i', 'small', 'label', 'code', 'abbr', 'cite', 'q', 's', 'u', 'sub', 'sup', 'time', 'mark', 'kbd', 'var', 'bdi', 'bdo', 'data', 'dfn']);
/** Block-level elements with no UA padding or border in any engine: content box = the style's box. */
const PLAIN_TAGS = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'form', 'img', 'canvas', 'video', 'li', 'pre', 'blockquote', 'address']);
/** Form controls: UA padding and border differ by engine, so each side the style does
 *  not set is bounded from above (Chromium: input 1px 2px + 2px, textarea 2px + 1px,
 *  button 1px 6px + 2px; Firefox's button padding-inline is 8px). */
const FORM_TAGS: Record<string, { borderBox: boolean }> = {
  button: { borderBox: true }, select: { borderBox: true },   // border-box in every UA sheet
  input: { borderBox: false }, textarea: { borderBox: false }, // content-box in standards mode
};
/** display values whose box is exactly the width/height it is given (plus padding/border). */
const STADIUM_SAFE_DISPLAY = /^(block|flex|grid|inline-block|inline-flex|inline-grid|flow-root)$/;
const UA_PAD_MAX = 8;
const UA_BORDER_MAX = 3;

/** The JSX element whose `style={…}` expression spans [open, close] (close = the
 *  expression's last character): its tag, and whether its attributes also take a
 *  className or a spread (`{...props}` may carry one). null = not a JSX style prop. */
function jsxStyleOwner(src: string, open: number, close: number): (ElementFacts & { className: boolean }) | null {
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
  const idm = /\bid=(?:(["'])([^"']*)\1|\{)/.exec(attrs);
  return {
    tag: t[1],
    className: /\bclass(?:Name)?=/.test(attrs) || /\{\s*\.\.\./.test(attrs),
    id: idm ? (idm[2] ?? null) : undefined,
  };
}

const IDENT = '[A-Za-z_$][\\w$]*';
const esc = (s: string): string => s.replace(/[$.]/g, '\\$&');

/** The elements a style object is used on. A JSX `style={{ … }}` → that element. A
 *  non-exported `const chip = { … }` (or `const styles = { chip: { … } }`) → every
 *  `style={chip}` / `style={styles.chip}` in the file; any other use (a spread, an
 *  argument, an export) makes the element unknowable → null. */
export function styleObjectOwners(src: string, open: number, close: number): Array<ElementFacts & { className: boolean }> | null {
  const direct = jsxStyleOwner(src, open, close);
  if (direct) return [direct];
  const before = src.slice(0, open);
  const DECL = new RegExp(`(?:^|[^\\w$.])(export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*$`);
  let root: string; let key: string | null = null;
  const d = DECL.exec(before);
  if (d) { if (d[1]) return null; root = d[2]; }
  else {
    const k = new RegExp(`(?:^|[{,\\s])(${IDENT})\\s*:\\s*$`).exec(before);
    if (!k) return null;
    // the enclosing object literal's `{`
    let depth = 0; let i = before.length - k[0].length + k[0].indexOf(k[1]) - 1;
    for (; i >= 0; i--) {
      if (src[i] === '}' || src[i] === ')' || src[i] === ']') depth++;
      else if (src[i] === '{' || src[i] === '(' || src[i] === '[') { if (depth === 0) break; depth--; }
    }
    if (i < 0 || src[i] !== '{') return null;
    const p = DECL.exec(src.slice(0, i));
    if (!p || p[1]) return null;
    root = p[2]; key = k[1];
  }
  if (new RegExp(`\\bexport\\s*(?:default\\s+${esc(root)}\\b|\\{[^}]*\\b${esc(root)}\\b)`).test(src)) return null;
  const owners: Array<ElementFacts & { className: boolean }> = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc(root)}(?![\\w$])`, 'g'))) {
    const at = m.index!;
    if (/(?:const|let|var)\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue; // the declaration itself
    let end = at + root.length;
    if (key) {
      const mem = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(src.slice(end));
      if (!mem) return null;                                                     // `styles` passed around whole
      if (mem[1] !== key) continue;                                              // another entry
      end += mem[0].length;
    }
    if (/^\s*[.[(]/.test(src.slice(end))) return null;                           // chip.x, chip[…], chip(…)
    if (!/^\s*\}/.test(src.slice(end))) return null;                             // not the whole style expression
    const o = jsxStyleOwner(src, at, end - 1);
    if (!o) return null;
    owners.push(o);
  }
  return owners.length ? owners : null;
}

// ── global stylesheets ──────────────────────────────────────────────────────

/** Does the app's global CSS reset every element to border-box? (Tailwind's preflight
 *  does, as do most resets: `*, ::before, ::after { box-sizing: border-box }`.) */
export function detectGlobalBorderBox(cssSources: string[]): boolean {
  return cssSources.some((css) => /@tailwind\s+base\b|@import\s+["']tailwindcss(?:\/preflight)?(?:\.css)?["']/.test(css)
    || /(?:^|[}\s,])\*\s*(?:,[^{}]*)?\{[^{}]*box-sizing\s*:\s*border-box/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
}

const ZERO_LEN = /^(?:0(?:px|em|rem|%)?\s*)+$/;
/** Could this rule's declarations make an element's border box bigger than its
 *  inline style says? (Shrinking never breaks a stadium: 2r ≥ a smaller side still holds.) */
function blockMayGrow(decls: Array<[string, string]>): boolean {
  const zeroBorder = decls.some(([p, v]) => (p === 'border' || p === 'border-width') && (ZERO_LEN.test(v) || /^(none|hidden)$/.test(v)));
  for (const [p, raw] of decls) {
    if (p.startsWith('--')) continue;
    const important = /!\s*important/.test(raw);
    const v = raw.replace(/!\s*important/, '').trim().toLowerCase();
    if (p === 'all') return true;
    if (/^padding/.test(p)) { if (!ZERO_LEN.test(v)) return true; continue; }
    if (/^border/.test(p)) {
      if (/radius|color|image/.test(p)) continue;
      if (/style$/.test(p)) { if (!/^(none|hidden)(\s+(none|hidden))*$/.test(v) && !zeroBorder) return true; continue; }
      if (!ZERO_LEN.test(v) && !/^(none|hidden)$/.test(v) && !/^0(px)?\s+(none|hidden)/.test(v)) return true;
      continue;
    }
    if (/^min-(width|height|block-size|inline-size)$/.test(p)) { if (!ZERO_LEN.test(v) && v !== 'auto' && v !== 'initial') return true; continue; }
    if (p === 'box-sizing') { if (v !== 'border-box') return true; continue; }
    if (p === 'display') { if (v !== 'none' && !STADIUM_SAFE_DISPLAY.test(v)) return true; continue; }
    if (p === 'flex' || p === 'flex-grow') { if (!/^(none|0|0(\.0+)?\s+[\d.]+\s+auto|initial)$/.test(v)) return true; continue; }
    if (p === 'flex-basis') { if (v !== 'auto') return true; continue; }
    if (important && /^(width|height|block-size|inline-size)$/.test(p)) return true;
  }
  return false;
}

/** Split a selector list on top-level commas. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The compound selector that must match the element itself (after the last
 *  combinator), with `&` replaced by each parent compound. null = a pseudo-element. */
function subjectCompounds(sel: string, parents: string[] | null): string[] | null {
  let depth = 0; let last = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === '>' || c === '+' || c === '~' || /\s/.test(c))) last = i + 1;
  }
  const comp = sel.slice(last).trim();
  if (!comp) return null;
  if (/::|:(?:before|after|first-line|first-letter|placeholder|selection|marker|backdrop)\b/i.test(comp)) return null;
  if (!comp.includes('&')) return [comp];
  return (parents ?? ['*']).map((p) => comp.replace(/&/g, p));
}

/** Could a compound selector match a class-less JSX element with these facts? */
function compoundMayMatch(comp: string, el: ElementFacts): boolean {
  if (/:(?:is|where|not|has|matches|-webkit-any|-moz-any)\(/i.test(comp)) return true;
  const flat = comp.replace(/\[[^\]]*\]/g, '[]').replace(/\([^)]*\)/g, '()');
  const type = /^(?:[\w-]*\|)?([A-Za-z][\w-]*|\*)/.exec(flat)?.[1];
  if (type && type !== '*' && type.toLowerCase() !== el.tag.toLowerCase()) return false;
  if (/\.[A-Za-z_\\-]/.test(flat)) return false;                                 // the element has no class
  const ids = [...flat.matchAll(/#([\w-]+)/g)].map((x) => x[1]);
  if (ids.length) {
    if (el.id === undefined) return false;
    if (typeof el.id === 'string' && ids.some((x) => x !== el.id)) return false;
  }
  return true;
}

/** The subject compounds of every global rule that could grow a box. Handles
 *  comments, strings, `@media`/`@supports`/`@layer` (transparent), `@keyframes` /
 *  `@font-face` (skipped) and native / SCSS nesting (`&`, descendant nesting). */
export function growingRuleSubjects(cssSources: string[]): string[] {
  const out = new Set<string>();
  for (const raw of cssSources) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    type Ctx = { subjects: string[] | null; skip: boolean; decls: Array<[string, string]> };
    const stack: Ctx[] = [{ subjects: null, skip: false, decls: [] }];
    let buf = ''; let q: string | null = null; let paren = 0;
    const flushDecl = (): void => {
      const t = buf.trim(); buf = '';
      const m = /^([-\w]+)\s*:\s*([\s\S]*)$/.exec(t);
      if (m) stack[stack.length - 1].decls.push([m[1].toLowerCase(), m[2].trim()]);
    };
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (q) { buf += c; if (c === '\\') { buf += css[++i] ?? ''; } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; buf += c; continue; }
      if (c === '(') paren++;
      if (c === ')') paren--;
      if (paren > 0) { buf += c; continue; }
      if (c === ';') { flushDecl(); continue; }
      if (c === '{') {
        const prelude = buf.trim(); buf = '';
        const parent = stack[stack.length - 1];
        if (parent.skip) { stack.push({ subjects: null, skip: true, decls: [] }); continue; }
        if (prelude.startsWith('@')) {
          const transparent = /^@(media|supports|layer|container|document|scope|-moz-document)\b/i.test(prelude);
          stack.push({ subjects: transparent ? parent.subjects : null, skip: !transparent, decls: [] });
          continue;
        }
        // a nested rule's decl-looking prelude (`a:hover`) is a selector here: it ends in `{`
        const subjects = splitTop(prelude, ',').flatMap((s) => subjectCompounds(s, parent.subjects) ?? []);
        stack.push({ subjects, skip: false, decls: [] });
        continue;
      }
      if (c === '}') {
        flushDecl();
        const ctx = stack.length > 1 ? stack.pop()! : stack[0];
        // declarations directly inside a transparent at-rule belong to the enclosing rule
        if (!ctx.skip && ctx.subjects && blockMayGrow(ctx.decls)) for (const s of ctx.subjects) out.add(s);
        continue;
      }
      buf += c;
    }
  }
  return [...out];
}

/** A predicate over elements: could some global rule grow this element's box? */
export function cssMayGrowFrom(cssSources: string[]): (el: ElementFacts) => boolean {
  const subjects = growingRuleSubjects(cssSources);
  return (el) => subjects.some((s) => compoundMayMatch(s, el));
}

// ── the check ───────────────────────────────────────────────────────────────

/**
 * Is `borderRadius: r` on this style object ALREADY a full stadium in the browser, so
 * the pill token (9999) paints the same pixels? See the file header for what must be
 * bounded; every element the object styles must prove it.
 */
export function stadiumIsExact(src: string, open: number, body: string, r: number, box: WebBoxContext = {}): boolean {
  const e = objectEntries(body);
  if (e.has('...') || e.has('?')) return false;
  const res = box.resolve;
  const owners = styleObjectOwners(src, open, open + body.length + 1);
  if (!owners) return false;
  const bs = e.get('boxSizing')?.replace(/['"`\s]/g, '');
  if (bs != null && bs !== 'border-box' && bs !== 'content-box') return false;
  // ALLOW-list, not a deny-list: only display values whose box honours
  // width/height as set. `table` / `inline-table` / `table-cell` / `table-row`
  // grow to fit their content (Chromium: a `display: table` 200x40 box with an
  // 80-high child paints 200x80, so 9999 turns its r=20 corners into a stadium),
  // `inline` / `contents` / `none` ignore width/height or draw no box, and
  // `list-item`, `ruby`, a ternary or a variable are not provable.
  const display = e.get('display')?.replace(/['"`\s]/g, '');
  if (display != null && !STADIUM_SAFE_DISPLAY.test(display)) return false;
  // padding + border per side [top, right, bottom, left]; null = the style does not set that side
  const pad: Array<number | null> = [null, null, null, null];
  const brd: Array<number | null> = [null, null, null, null];
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
  const dim = (key: string): number | null => {
    const raw = e.get(key);
    if (raw == null) return null;
    const v = cssLengths(raw, res);
    return v && v.length === 1 ? v[0] : null;
  };
  const minOf = (key: string): number | null | 'bad' => {
    if (!e.has(key)) return null;
    const mv = cssLengths(e.get(key)!, res);
    return mv && mv.length === 1 ? mv[0] : 'bad';
  };
  const flex = e.get('flex') ?? e.get('flexGrow');
  const grows = (flex != null && !/^(['"`]?)(?:0(?:\.0+)?(?:\s[^'"`]*)?|none)\1$/.test(flex.trim())) || e.has('flexBasis');

  for (const owner of owners) {
    if (owner.className) return false;                                  // a class's CSS is unresolved: padding / min-height may grow ANY box
    const tag = owner.tag;
    if (/^[A-Z]|\./.test(tag)) return false;                            // a component decides what `style` reaches, and adds its own CSS
    const form = FORM_TAGS[tag];
    if (!form && !PLAIN_TAGS.has(tag) && !INLINE_TAGS.has(tag)) return false; // UA padding/border/sizing unknown (ul, fieldset, iframe, table …)
    if (!display && INLINE_TAGS.has(tag)) return false;                 // width/height do not apply
    if (box.cssMayGrow?.({ tag, id: owner.id })) return false;          // a global rule reaches it and may grow it
    const borderBox = bs === 'border-box' ? true : bs === 'content-box' ? false : form ? (form.borderBox || !!box.borderBox) : !!box.borderBox;
    // sides the style leaves to the UA: form controls get an upper bound, others have none
    const p = pad.map((x) => x ?? (form ? UA_PAD_MAX : 0));
    const b = brd.map((x) => x ?? (form ? UA_BORDER_MAX : 0));
    const bound = (key: 'width' | 'height', s1: number, s2: number): number | null | 'bad' => {
      const d = dim(key);
      if (d == null) return null;
      const extra = p[s1] + p[s2] + b[s1] + b[s2];
      const used = borderBox ? Math.max(d, extra) : d + extra;
      const mn = minOf(key === 'width' ? 'minWidth' : 'minHeight');
      if (mn === 'bad') return 'bad';
      return mn == null ? used : Math.max(used, mn);
    };
    const W = bound('width', 3, 1);
    const H = bound('height', 0, 2);
    const ok = (x: number | null | 'bad'): x is number => typeof x === 'number' && 2 * r >= x;
    const exact = grows ? ok(W) && ok(H) : ok(W) || ok(H);
    if (!exact) return false;
  }
  return true;
}
