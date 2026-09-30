// =============================================================================
// File: src/relay-server/design-vocabulary.ts
//
// Readability F4 — the token VOCABULARY comes from the design, not a fixed table.
//
// The Ping build shipped a theme of 47 colour tokens (19 used once, 54
// near-duplicate pairs, `neutral1..4` / `ink2..3` counters) and 317 layout literals,
// 270 of them width/height/size values no token covered. Two causes: the design
// digest kept only the top-8 colours and named them by counter, and the spacing /
// radius scale was a fixed s4..s32 / r8..r24 that ignored the design. Agents then
// minted a screen-named token per literal.
//
// This module reads the IR the pipeline already has (the per-screen `spec.tree`
// text: `container "…" [338×47] bg:#12ae89 radius:23.5 gap:10 pad:13,140,12,140`,
// `icon "…" [24×24] → assets/…`) and derives, deterministically:
//   - colours: usage-counted, near-duplicates (RGB distance < 16) merged into the
//     more-used one, ROLE names without counters (textPrimary, textMuted, border,
//     surfaceMuted, brand, brandSoft, success, danger …);
//   - spacing: the standard scale plus every gap/padding value the design uses ≥3×;
//   - radius: the standard scale plus every corner radius used ≥2×, and `pill`
//     when the design has stadium shapes (radius ≥ half the short side);
//   - sizes: role-named icon sizes (iconSm/iconMd/iconLg …), avatar sizes and the
//     dominant button height.
// Pure and framework-neutral: the Flutter and web theme renderers both consume it.
// =============================================================================

export interface RGB { r: number; g: number; b: number }

export function parseHexColor(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Euclidean RGB distance — the same measure the readability metrics use for
 *  "near-duplicate colour tokens" (< 16). */
export function rgbDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
export const NEAR_DUPLICATE_DISTANCE = 16;

function luminance(c: RGB): number { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
function isNeutral(c: RGB): boolean { return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 12; }
function hue(c: RGB): number {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// ── IR measurement ────────────────────────────────────────────────────────────

export interface DesignMeasurements {
  /** lowercase #rrggbb → uses across the design. */
  colorUses: Map<string, number>;
  /** gap / padding values → uses. */
  spacing: Map<number, number>;
  /** non-pill corner radii → uses. */
  radius: Map<number, number>;
  /** stadium shapes (radius ≥ half the short side). */
  pills: number;
  /** square icon sizes → uses. */
  icons: Map<number, number>;
  /** circular avatar / photo sizes → uses. */
  avatars: Map<number, number>;
  /** heights of button-shaped containers (a centred row with a fill/border and a radius). */
  buttonHeights: Map<number, number>;
}

const inc = <K>(m: Map<K, number>, k: K, n = 1): void => { m.set(k, (m.get(k) ?? 0) + n); };
const round = (v: number): number => Math.round(v * 2) / 2;   // half-pixel precision

/** Measure the IR texts (one per screen). Unknown lines are ignored. */
export function measureDesign(irTexts: string[]): DesignMeasurements {
  const out: DesignMeasurements = {
    colorUses: new Map(), spacing: new Map(), radius: new Map(), pills: 0,
    icons: new Map(), avatars: new Map(), buttonHeights: new Map(),
  };
  for (const text of irTexts) {
    for (const raw of (text ?? '').split('\n')) {
      const line = raw.replace(/^[\s│├└─]+/, '');
      if (!line) continue;
      for (const h of line.match(/#[0-9a-fA-F]{6}\b/g) ?? []) inc(out.colorUses, h.toLowerCase());
      const kind = /^([a-z]+)\b/.exec(line)?.[1] ?? '';
      const dim = /\[(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)\]/.exec(line);
      const w = dim ? Number(dim[1]) : NaN;
      const h = dim ? Number(dim[2]) : NaN;
      const gap = /\bgap:(\d+(?:\.\d+)?)/.exec(line);
      if (gap && Number(gap[1]) > 0 && Number(gap[1]) <= 64) inc(out.spacing, round(Number(gap[1])));
      const pad = /\bpad:([\d.,]+)/.exec(line);
      if (pad) {
        // pad:t,r,b,l / pad:v,h / pad:all — count each distinct side value once per node
        for (const v of new Set(pad[1].split(',').map(Number))) if (v > 0 && v <= 64) inc(out.spacing, round(v));
      }
      const rad = /\bradius:(\d+(?:\.\d+)?)(?![\d,])/.exec(line);
      if (rad) {
        const r = Number(rad[1]);
        const short = Math.min(w, h);
        if (Number.isFinite(short) && short > 0 && r >= short / 2 - 0.5) {
          if (Math.abs(w - h) <= 1 && kind !== 'text' && w >= 24) inc(out.avatars, round(w));
          else out.pills++;
        } else if (r > 0) inc(out.radius, round(r));
      }
      if (kind === 'icon' && Number.isFinite(w) && Number.isFinite(h) && Math.max(w, h) <= 48) {
        inc(out.icons, round(Math.max(w, h)));
      }
      if ((kind === 'container' || kind === 'frame' || kind === 'instance') && Number.isFinite(h) && h >= 32 && h <= 64
        && /\bradius:/.test(line) && /(bg:|border:)/.test(line) && /\bflex:row\b/.test(line) && /\bjustify:center\b/.test(line)) {
        inc(out.buttonHeights, round(h));
      }
    }
  }
  return out;
}

// ── colour vocabulary ─────────────────────────────────────────────────────────

export interface VocabColor { name: string; hex: string; uses: number; comment: string }
export interface MergedColor { hex: string; into: string; distance: number }

const NEUTRAL_LADDER: Array<[number, string]> = [
  // [min luminance, role] — light to dark
  [0.97, 'surface'], [0.93, 'surfaceMuted'], [0.86, 'divider'], [0.78, 'border'], [0.66, 'borderStrong'],
  [0.52, 'textDisabled'], [0.38, 'textMuted'], [0.22, 'textSecondary'], [0.06, 'textPrimary'], [0, 'ink'],
];

/** The ROLE name a single colour gets (no uniqueness applied): neutral ladder by
 *  luminance, `brand*` for the brand hue, else a hue role (danger, success …). */
export function colorRole(hex: string, brandHex?: string | null): string {
  const c = parseHexColor(hex);
  if (!c) return 'color';
  if (isNeutral(c)) { const L = luminance(c); return NEUTRAL_LADDER.find(([min]) => L >= min)![1]; }
  const b = brandHex ? parseHexColor(brandHex) : null;
  if (b && rgbDistance(b, c) < 1) return 'brand';
  return chromaticRole(c, b);
}
export function colorLuminance(hex: string): number { const c = parseHexColor(hex); return c ? luminance(c) : 0; }

function chromaticRole(c: RGB, brand: RGB | null): string {
  const L = luminance(c);
  const tone = L >= 0.82 ? 'Soft' : L <= 0.22 ? 'Strong' : '';
  if (brand && Math.min(Math.abs(hue(c) - hue(brand)), 360 - Math.abs(hue(c) - hue(brand))) <= 18) return `brand${tone}`;
  const h = hue(c);
  const base = h < 15 || h >= 340 ? 'danger'
    : h < 48 ? 'warning'
      : h < 70 ? 'highlight'
        : h < 170 ? 'success'
          : h < 250 ? 'info'
            : h < 300 ? 'accent' : 'accentPink';
  return `${base}${tone}`;
}

/**
 * Plan the colour tokens: usage-ordered, near-duplicates merged into the more-used
 * colour, role-named without counters. `minUses` drops one-off colours (they stay a
 * local value in the one file that uses them); `max` caps the palette.
 */
export function planColorVocabulary(uses: Map<string, number> | Array<[string, number]>, opts?: { minUses?: number; max?: number }): { colors: VocabColor[]; merged: MergedColor[] } {
  const minUses = opts?.minUses ?? 1;
  const max = opts?.max ?? 20;
  const entries = [...(uses instanceof Map ? uses.entries() : uses)]
    .map(([hex, n]) => [hex.toLowerCase(), n] as [string, number])
    .filter(([hex]) => parseHexColor(hex))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept: Array<{ hex: string; rgb: RGB; uses: number }> = [];
  const merged: Array<{ hex: string; into: RGB & { hex: string }; distance: number }> = [];
  for (const [hex, n] of entries) {
    const rgb = parseHexColor(hex)!;
    const near = kept.map((k) => ({ k, d: rgbDistance(k.rgb, rgb) })).filter((x) => x.d < NEAR_DUPLICATE_DISTANCE).sort((a, b) => a.d - b.d)[0];
    if (near) { near.k.uses += n; merged.push({ hex, into: { ...near.k.rgb, hex: near.k.hex }, distance: Math.round(near.d * 10) / 10 }); continue; }
    kept.push({ hex, rgb, uses: n });
  }
  const chosen = kept.filter((k) => k.uses >= minUses).slice(0, max);
  const brand = chosen.find((k) => !isNeutral(k.rgb)) ?? null;
  // A second colour in the same role is named RELATIVE to the holder of the bare
  // role name (textPrimaryLight / borderDark) — meaningful, never a counter.
  const holder = new Map<string, RGB>();
  const used = new Set<string>();
  const unique = (base: string, rgb: RGB): string => {
    const h = holder.get(base);
    if (!h) { holder.set(base, rgb); used.add(base); return base; }
    const lighter = luminance(rgb) >= luminance(h);
    const ladder = lighter ? ['Light', 'Lighter', 'Lightest'] : ['Dark', 'Darker', 'Darkest'];
    for (const q of ladder) if (!used.has(`${base}${q}`)) { used.add(`${base}${q}`); return `${base}${q}`; }
    for (const q of ['Alt', 'Muted', 'Vivid']) if (!used.has(`${base}${q}`)) { used.add(`${base}${q}`); return `${base}${q}`; }
    let n = `${base}Alt`; while (used.has(n)) n += 'X';
    used.add(n); return n;
  };
  const colors: VocabColor[] = [];
  // brand first so it wins its bare name; then by usage.
  const order = brand ? [brand, ...chosen.filter((k) => k !== brand)] : chosen;
  for (const k of order) {
    let role: string;
    if (k === brand) role = 'brand';
    else if (isNeutral(k.rgb)) {
      const L = luminance(k.rgb);
      role = NEUTRAL_LADDER.find(([min]) => L >= min)![1];
    } else role = chromaticRole(k.rgb, brand?.rgb ?? null);
    const name = unique(role, k.rgb);
    const mergedHere = merged.filter((m) => m.into.hex === k.hex).map((m) => m.hex);
    colors.push({ name, hex: k.hex, uses: k.uses, comment: `${k.hex}${isNeutral(k.rgb) ? ' (neutral)' : ''}${mergedHere.length ? ` — also covers ${mergedHere.join(', ')}` : ''}` });
  }
  const nameByHex = new Map(colors.map((c) => [c.hex, c.name]));
  return {
    colors,
    merged: merged.filter((m) => nameByHex.has(m.into.hex)).map((m) => ({ hex: m.hex, into: nameByHex.get(m.into.hex)!, distance: m.distance })),
  };
}

// ── spacing / radius / size vocabulary ────────────────────────────────────────

export const STANDARD_SPACING = [4, 8, 12, 16, 20, 24, 32];
export const STANDARD_RADIUS = [8, 12, 16, 24];
export const PILL_RADIUS = 999;

export interface SizeToken { name: string; value: number; uses: number }
export interface DesignScales {
  spacing: number[];
  radius: number[];
  pill: boolean;
  sizes: SizeToken[];
}

export const ICON_LADDER = ['iconXs', 'iconSm', 'iconMd', 'iconLg', 'iconXl'];
export const AVATAR_LADDER = ['avatarSm', 'avatar', 'avatarLg'];
export const TILE_LADDER = ['tileXs', 'tileSm', 'tile', 'tileLg', 'tileXl'];
export const BUTTON_LADDER = ['buttonHeightSm', 'buttonHeight', 'buttonHeightLg'];

/** Name up to `ladder.length` recurring values by rank around the most-used one. */
export function ladderNames(values: Map<number, number>, ladder: string[], mdIndex: number, minUses: number): SizeToken[] {
  const rec = [...values.entries()].filter(([, n]) => n >= minUses);
  if (!rec.length) return [];
  const top = [...rec].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, ladder.length).sort((a, b) => a[0] - b[0]);
  const mdValue = [...top].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const mdPos = top.findIndex(([v]) => v === mdValue);
  const out: SizeToken[] = [];
  top.forEach(([value, uses], i) => {
    const li = mdIndex + (i - mdPos);
    if (li >= 0 && li < ladder.length) out.push({ name: ladder[li], value, uses });
  });
  return out;
}

export function planDesignScales(m: DesignMeasurements): DesignScales {
  const recurring = (map: Map<number, number>, min: number): number[] => [...map.entries()].filter(([v, n]) => n >= min && Number.isInteger(v)).map(([v]) => v);
  const spacing = [...new Set([...STANDARD_SPACING, ...recurring(m.spacing, 3).filter((v) => v >= 2 && v <= 64)])].sort((a, b) => a - b);
  const radius = [...new Set([...STANDARD_RADIUS, ...recurring(m.radius, 2).filter((v) => v >= 2 && v <= 64)])].sort((a, b) => a - b);
  const sizes: SizeToken[] = [
    ...ladderNames(m.icons, ICON_LADDER, 2, 2),
    ...ladderNames(m.avatars, AVATAR_LADDER, 1, 2),
  ];
  const btn = [...m.buttonHeights.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (btn && btn[1] >= 2) sizes.push({ name: 'buttonHeight', value: btn[0], uses: btn[1] });
  return { spacing, radius, pill: m.pills > 0, sizes };
}

/** The default scales when there is no IR to measure (a digest without trees). */
export function defaultDesignScales(): DesignScales {
  return { spacing: [...STANDARD_SPACING], radius: [...STANDARD_RADIUS], pill: false, sizes: [] };
}
