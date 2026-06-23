// =============================================================================
// File: src/relay-server/semantic-names.ts
//
// SINGLE SOURCE OF TRUTH for deriving SEMANTIC, human-readable identifiers from a
// canonical screen's display name — used by BOTH the write-locked skeleton
// (canonicalize.ts → generateFlutterSkeleton) AND the safety-net semantic-rename
// pass (passes/semantic-rename.ts).
//
// The IDENTITY axis is always `canonicalId` (frame-map; RFC §4.2). These helpers
// only derive the COSMETIC, reader-facing identifiers:
//   - file base   e.g. login_screen          (no extension)
//   - class name  e.g. LoginScreen
//   - route const e.g. login                 (camelCase const in AppRoutes)
//   - route path  e.g. /login                (the URL the router switches on)
//
// A frame's display name is frequently a RAW MACHINE CODE — a Figma node id like
// "283:1967", "290-3657", or a device-frame label like "iPhone 14/15 Pro — 57".
// Those must NEVER leak into a file name, class, route const, or route path. When
// the name has no usable human token, we fall back to a generic `screen` base and
// let the caller's collision suffixer disambiguate (screen, screen_2, screen_3…).
// =============================================================================

/** Tokens we strip because they describe the DEVICE FRAME, not the screen. */
const FRAME_NOISE = new Set([
  'iphone', 'ipad', 'android', 'pixel', 'galaxy', 'pro', 'max', 'mini', 'plus',
  'frame', 'screen', 'default', 'copy', 'group', 'rectangle', 'component',
  'variant', 'instance', 'desktop', 'mobile', 'tablet', 'web', 'page',
]);

/** Split a human/camel/snake/kebab name into lowercase word tokens. */
export function tokenizeName(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase boundary
    .replace(/[_\-]+/g, ' ')                     // snake / kebab
    .replace(/[^A-Za-z0-9 ]+/g, ' ')             // strip punctuation (incl. ':')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Drop trailing/leading "screen" tokens so we re-append exactly one. */
function stripScreenToken(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length && out[out.length - 1] === 'screen') out.pop();
  while (out.length && out[0] === 'screen') out.shift();
  return out;
}

/**
 * Meaningful word tokens for a screen name: drop pure-numeric tokens and
 * device-frame noise. "283:1967" → [], "iPhone 14 Pro — Login" → ['login'],
 * "Link Banks" → ['link','banks'].
 */
export function meaningfulTokens(name: string): string[] {
  return stripScreenToken(tokenizeName(name))
    .filter((t) => !/^[0-9]+$/.test(t))   // drop pure numbers (frame ids / device sizes)
    .filter((t) => !FRAME_NOISE.has(t));
}

/**
 * True when a display name carries NO human-readable token — it is a raw frame
 * code ("283:1967", "290-3657") or device-frame chrome ("iPhone 14/15 Pro 57").
 * Such a name has no semantic content and must fall back to a generic base.
 */
export function isMachineName(name: string): boolean {
  return meaningfulTokens(name).length === 0;
}

function snake(tokens: string[]): string { return tokens.join('_'); }
function pascal(tokens: string[]): string {
  return tokens.map((t) => (t ? t[0].toUpperCase() + t.slice(1) : t)).join('');
}
function camel(tokens: string[]): string {
  return tokens.map((t, i) => (i === 0 ? t : (t ? t[0].toUpperCase() + t.slice(1) : t))).join('');
}

/** A semantic identifier set for one screen (no extension on fileBase). */
export interface SemanticIdentifiers {
  /** snake_case file base + `_screen`, e.g. `login_screen`. */
  fileBase: string;
  /** PascalCase widget class, e.g. `LoginScreen`. */
  className: string;
  /** camelCase route const name (in AppRoutes), e.g. `login`. */
  routeConst: string;
  /** kebab route PATH the router switches on, e.g. `/login`. */
  routePath: string;
  /** true when the source name was a raw frame code → generic fallback used. */
  fellBack: boolean;
}

/**
 * Derive SEMANTIC identifiers from a display name. Pure, deterministic, no IO.
 * A machine/frame-code name falls back to the generic `screen` base — the caller
 * MUST apply collision suffixing (it will, since many fallbacks collide).
 *
 * `suffixTokens` (optional) is appended for deterministic disambiguation when the
 * caller already knows the base collides (e.g. `['2']` → login_screen_2 /
 * LoginScreen2 / login2 / /login-2).
 */
export function deriveSemanticIdentifiers(
  name: string,
  suffixTokens: string[] = [],
): SemanticIdentifiers {
  const meaningful = meaningfulTokens(name);
  const fellBack = meaningful.length === 0;
  const base = fellBack ? ['screen'] : meaningful;
  const withSuffix = suffixTokens.length ? [...base, ...suffixTokens] : base;
  return {
    fileBase: `${snake(withSuffix)}_screen`,
    className: `${pascal(withSuffix)}Screen`,
    routeConst: camel(withSuffix),
    routePath: '/' + withSuffix.join('-'),
    fellBack,
  };
}
