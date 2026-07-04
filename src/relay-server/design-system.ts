// =============================================================================
// File: src/relay-server/design-system.ts
//
// EXTRACT-FIRST design system (RFC §4.4, the fix for "tokens hardcoded in every
// screen"). The build used to ship an EMPTY lib/theme/app_theme.dart stub and only
// *describe* the palette as prose in context.md — so each screen agent inlined the
// raw hex it saw (Color(0xFF12ae89) duplicated across 8 screens) because there was
// no named token to import. This module turns the deterministic design digest
// (dominant colors + fonts, already extracted with NO LLM) into a REAL, importable
// theme file BEFORE screen 1 builds, plus an importable-API description that the
// per-screen prompt injects. The means now exist, so "import the token, don't
// hardcode" becomes actionable (and the verify loop can treat raw literals as a
// defect).
//
// Deterministic + idempotent: re-running on resume detects the already-written
// AppTheme file and skips (never clobbers agent edits).
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export interface DesignDigestInput {
  colors: string[];   // dominant hex colors, most-used first (e.g. "#12ae89")
  fonts: string[];    // dominant font families, most-used first
}

export interface ColorToken { name: string; hex: string; comment: string }
export interface ThemeTokens {
  colors: ColorToken[];
  fontFamily?: string;
  /** marker so generate is idempotent + the prompt can name the file. */
  themeFile: string;          // project-relative, e.g. lib/theme/app_theme.dart
  className: string;          // e.g. "AppTheme"
}

// ── Color role classification (deterministic, no LLM) ─────────────────────────
// Name tokens by ROLE so the agent reaches for the right one. Grayscale by
// lightness → surface/ink/neutralN; saturated → brand/accentN (usage-ordered).
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function isGrayscale(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min <= 12;   // near-equal channels = neutral
}
function lightness(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;   // 0..1
}

/** Turn the digest into named, role-classified tokens (pure, testable). */
export function planThemeTokens(digest: DesignDigestInput, opts?: { className?: string; themeFile?: string }): ThemeTokens {
  const className = opts?.className ?? 'AppTheme';
  const themeFile = opts?.themeFile ?? path.join('lib', 'theme', 'app_theme.dart');
  const used = new Set<string>();
  const uniq = (base: string): string => {
    let n = base, i = 2;
    while (used.has(n)) n = `${base}${i++}`;
    used.add(n);
    return n;
  };
  const colors: ColorToken[] = [];
  let accentIdx = 0, neutralIdx = 0;
  for (const raw of digest.colors) {
    const c = parseHex(raw);
    if (!c) continue;
    const hex = `#${raw.replace('#', '').toLowerCase()}`;
    let name: string;
    if (isGrayscale(c.r, c.g, c.b)) {
      const L = lightness(c.r, c.g, c.b);
      if (L >= 0.93) name = uniq('surface');         // near-white backgrounds
      else if (L <= 0.10) name = uniq('ink');        // near-black text
      else name = uniq(`neutral${++neutralIdx}`);
    } else {
      name = accentIdx === 0 ? uniq('brand') : uniq(`accent${accentIdx + 1}`);
      accentIdx++;
    }
    colors.push({ name, hex, comment: `${hex}${isGrayscale(c.r, c.g, c.b) ? ' (neutral)' : ''}` });
  }
  const fontFamily = digest.fonts[0];
  return { colors, fontFamily, themeFile, className };
}

const argb = (hex: string): string => `0xFF${hex.replace('#', '').toLowerCase()}`;

/** The importable-API description injected into the prompt + written to context.md.
 *  Lists the EXACT Dart symbols the agent must import (not raw hex). */
export function themeApiDescription(tokens: ThemeTokens): string {
  const out: string[] = [
    `DESIGN SYSTEM — already generated at \`${tokens.themeFile}\` as class \`${tokens.className}\`. IMPORT and USE these tokens; do NOT hardcode raw Color(0x..)/fontSize/EdgeInsets literals that duplicate them — inline literals that match a token are a defect the review will flag.`,
    `Color tokens (\`${tokens.className}.<name>\`):`,
  ];
  for (const c of tokens.colors) out.push(`- ${tokens.className}.${c.name}  = ${c.hex}`);
  if (tokens.fontFamily) out.push(`Typeface: ${tokens.fontFamily} — use ${tokens.className}.textTheme / the family constant, do not re-declare per screen.`);
  out.push(`Spacing: ${tokens.className}.s4/s8/s12/s16/s20/s24 (EdgeInsets/SizedBox). Radius: ${tokens.className}.r8/r12/r16/r24 (BorderRadius).`);
  return out.join('\n');
}

/** Render the Flutter theme source from tokens. */
function renderFlutterTheme(tokens: ThemeTokens): string {
  const colorLines = tokens.colors.map(c => `  static const Color ${c.name} = Color(${argb(c.hex)}); // ${c.comment}`).join('\n');
  const fam = tokens.fontFamily ? `\n  static const String fontFamily = '${tokens.fontFamily.replace(/'/g, '')}';` : '';
  const surface = tokens.colors.find(c => c.name.startsWith('surface'))?.name ?? null;
  const brand = tokens.colors.find(c => c.name === 'brand')?.name ?? null;
  return `// GENERATED (extract-first design system). Single source of truth for the
// palette + type scale + spacing/radius. Screens MUST import these tokens instead
// of hardcoding raw literals. Safe to extend; do not duplicate tokens per screen.
import 'package:flutter/material.dart';

class ${tokens.className} {
  ${tokens.className}._();

  // ── Colors (role-classified, usage-ordered) ──
${colorLines || '  // (no dominant colors detected)'}${fam}

  // ── Spacing scale ──
  static const double s4 = 4, s8 = 8, s12 = 12, s16 = 16, s20 = 20, s24 = 24, s32 = 32;
  static EdgeInsets pad(double v) => EdgeInsets.all(v);
  static EdgeInsets padX(double v) => EdgeInsets.symmetric(horizontal: v);
  static EdgeInsets padY(double v) => EdgeInsets.symmetric(vertical: v);

  // ── Radius scale ──
  static const BorderRadius r8 = BorderRadius.all(Radius.circular(8));
  static const BorderRadius r12 = BorderRadius.all(Radius.circular(12));
  static const BorderRadius r16 = BorderRadius.all(Radius.circular(16));
  static const BorderRadius r24 = BorderRadius.all(Radius.circular(24));

  static ThemeData themeData() => ThemeData(
        useMaterial3: true,${fam ? `\n        fontFamily: fontFamily,` : ''}${brand ? `\n        colorSchemeSeed: ${brand},` : ''}${surface ? `\n        scaffoldBackgroundColor: ${surface},` : ''}
      );
}

// Back-compat alias: the generated router (lib/app_router.dart) calls appTheme().
ThemeData appTheme() => ${tokens.className}.themeData();
`;
}

export interface GenerateResult { themeFile: string; wrote: boolean; tokenCount: number; api: string; tokens: ThemeTokens }

/**
 * Write the design-system theme file (currently Flutter) if it isn't already a real
 * (non-stub) file. Returns the importable-API description for the prompt regardless,
 * so resume still injects the contract even when the file already exists.
 */
export async function generateDesignSystem(
  projectRoot: string, framework: string, digest: DesignDigestInput,
): Promise<GenerateResult> {
  const tokens = planThemeTokens(digest);
  const api = themeApiDescription(tokens);
  // Flutter is the only target with a concrete renderer today; others get the API
  // description only (the agent still imports a shared theme in that framework).
  if ((framework || 'flutter').toLowerCase() !== 'flutter') {
    return { themeFile: tokens.themeFile, wrote: false, tokenCount: tokens.colors.length, api, tokens };
  }
  const abs = path.join(projectRoot, tokens.themeFile);
  // Idempotent: only (over)write the STUB. A file that already defines our class is
  // either ours from a prior pass or agent-extended — never clobber it.
  let existing = '';
  try { existing = await fs.readFile(abs, 'utf8'); } catch { /* fresh */ }
  const isStub = !existing.trim() || /GENERATED SKELETON|ThemeData\(useMaterial3:\s*true\)\s*;?\s*$/.test(existing.trim());
  const alreadyOurs = existing.includes(`class ${tokens.className} {`);
  if (alreadyOurs && !isStub) {
    return { themeFile: tokens.themeFile, wrote: false, tokenCount: tokens.colors.length, api, tokens };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, renderFlutterTheme(tokens), 'utf8');
  // Best-effort: keep main.dart's theme wired if it exists and is the boilerplate.
  return { themeFile: tokens.themeFile, wrote: true, tokenCount: tokens.colors.length, api, tokens };
}

/** Append the importable theme API to .uix/context.md once (so later screens that
 *  read the contract slice see the EXACT symbols, not just prose hex). */
export async function seedContextWithThemeApi(projectRoot: string, api: string): Promise<void> {
  try {
    const file = path.join(projectRoot, '.uix', 'context.md');
    let cur = '';
    try { cur = await fs.readFile(file, 'utf8'); } catch { /* fresh */ }
    if (cur.includes('<!-- design-system-api -->')) return;   // already seeded
    await fs.mkdir(path.dirname(file), { recursive: true });
    const block = `\n<!-- design-system-api -->\n## Design system (importable)\n${api}\n`;
    await fs.writeFile(file, cur ? `${cur.trimEnd()}\n${block}` : block.trimStart(), 'utf8');
  } catch { /* non-fatal */ }
}

export function hasGeneratedTheme(projectRoot: string, themeFile = path.join('lib', 'theme', 'app_theme.dart')): boolean {
  try { return fsSync.readFileSync(path.join(projectRoot, themeFile), 'utf8').includes('class AppTheme {'); }
  catch { return false; }
}

// ── Per-screen preview entry (verify renders the RIGHT screen) ────────────────
// The verify loop screenshots a runnable entrypoint. With no per-screen entry it
// fell back to lib/main.dart → AppRouter(initialRoute: entry) → it rendered the
// app's ENTRY screen (a different, still-stub screen) at an unbounded blank canvas,
// so the verify agent compared the WRONG screen to the reference and dumped good
// screens to needs-review with score ~2. This deterministically writes
// lib/_preview/<screen>_preview.dart that renders ONLY the just-built screen, so
// the screenshot is the target screen at the screenshot viewport's device size.
// Returns the project-relative entry path (or undefined for non-flutter / no file).
//
// P1-core (folded modal/state verification): the entry can now render a VARIANT of
// the screen instead of the bare default constructor —
//   • { kind: 'state', id } → `home: <Screen>(state: '<id>')` so each canonical
//     state is screenshot/verified against ITS OWN reference;
//   • { kind: 'modal', id } → the base screen is rendered and the modal is
//     AUTO-PRESENTED after the first frame by calling the deterministic presenter
//     `modalPresenterName(id)` the build contract requires the screen to expose.
//     (A missing presenter is a COMPILE error whose message names the exact
//     function — precise, actionable feedback for the fix loop.)
// Screen-file resolution: the legacy `screen_<frameId>.dart` name first; when a
// `canonicalId` is supplied, fall back to scanning lib/screens/ for the
// `// canonicalId:` header the skeleton stamps (semantic-named runs).

export interface PreviewVariant { kind: 'state' | 'modal'; id: string }

/** identifier-safe token from a canonical/frame id (`m_313_9543` → `313_9543`). */
const idToken = (id: string): string =>
  String(id).replace(/^[cm]_/, '').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();

/** The DETERMINISTIC presenter the build contract requires for each folded modal:
 *  `showModal_<id-core>` (e.g. modal `m_313_9543` → `showModal_313_9543`). The
 *  variant preview calls exactly this, so prompt + preview agree by construction. */
export function modalPresenterName(modalId: string): string {
  return `showModal_${idToken(modalId)}`;
}

/** Find a built screen file by the `// canonicalId: <id>` header the skeleton
 *  stamps (semantic file names don't encode the frame id). Compares by the id core
 *  so `c_290_3657` matches a `m_290_3657` header and vice versa. */
async function findScreenByCanonicalHeader(
  projectRoot: string, canonicalId: string,
): Promise<{ base: string; src: string } | null> {
  const dir = path.join(projectRoot, 'lib', 'screens');
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.dart')).sort(); } catch { return null; }
  const core = String(canonicalId).replace(/^[cm]_/, '');
  for (const f of files) {
    let src: string;
    try { src = await fs.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const hm = /^\/\/\s*canonicalId:\s*(\S+)/m.exec(src);
    if (hm && hm[1].replace(/^[cm]_/, '') === core) return { base: f.replace(/\.dart$/, ''), src };
  }
  return null;
}

export async function ensureScreenPreviewEntry(
  projectRoot: string, framework: string, frameId: string,
  opts?: { canonicalId?: string; variant?: PreviewVariant },
): Promise<string | undefined> {
  if ((framework || 'flutter').toLowerCase() !== 'flutter') return undefined;
  let base = `screen_${frameId.replace(/[^a-zA-Z0-9]+/g, '_')}`.toLowerCase();
  let src: string | undefined;
  try { src = await fs.readFile(path.join(projectRoot, 'lib', 'screens', `${base}.dart`), 'utf8'); }
  catch { /* legacy name absent — try the canonicalId header below */ }
  if (src === undefined && opts?.canonicalId) {
    const hit = await findScreenByCanonicalHeader(projectRoot, opts.canonicalId);
    if (hit) { base = hit.base; src = hit.src; }
  }
  if (src === undefined) return undefined;
  // First PUBLIC widget class = the screen widget (skip private _Helper widgets).
  const m = src.match(/class\s+([A-Z]\w*)\s+extends\s+(?:StatelessWidget|StatefulWidget)/);
  if (!m) return undefined;
  const cls = m[1];
  const v = opts?.variant;
  const suffix = v ? `_${v.kind}_${idToken(v.id)}` : '';
  const previewRel = path.join('lib', '_preview', `${base}${suffix}_preview.dart`);
  const previewAbs = path.join(projectRoot, previewRel);
  let code: string;
  if (!v) {
    code = `// GENERATED — device-framed preview entry: renders ONLY this screen for verify
// (instead of falling back to main.dart, which renders the app entry → wrong screen).
import 'package:flutter/material.dart';
import '../screens/${base}.dart';

void main() => runApp(MaterialApp(
      debugShowCheckedModeBanner: false,
      home: ${cls}(),
    ));
`;
  } else if (v.kind === 'state') {
    const stateId = v.id.replace(/'/g, "\\'");
    code = `// GENERATED — variant preview entry: renders this screen in state '${stateId}'
// so the state is verified against ITS OWN reference (not just the default state).
import 'package:flutter/material.dart';
import '../screens/${base}.dart';

void main() => runApp(MaterialApp(
      debugShowCheckedModeBanner: false,
      home: ${cls}(state: '${stateId}'),
    ));
`;
  } else {
    const presenter = modalPresenterName(v.id);
    code = `// GENERATED — variant preview entry: renders the base screen and AUTO-PRESENTS
// modal '${v.id}' after the first frame via the contract presenter ${presenter}(),
// so the modal is screenshot/verified over its (reused) base against its reference.
import 'package:flutter/material.dart';
import '../screens/${base}.dart';

void main() => runApp(const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: _AutoPresentHost(),
    ));

class _AutoPresentHost extends StatefulWidget {
  const _AutoPresentHost();
  @override
  State<_AutoPresentHost> createState() => _AutoPresentHostState();
}

class _AutoPresentHostState extends State<_AutoPresentHost> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // The build contract REQUIRES the screen file to expose this presenter.
      ${presenter}(context);
    });
  }

  @override
  Widget build(BuildContext context) => ${cls}();
}
`;
  }
  await fs.mkdir(path.dirname(previewAbs), { recursive: true });
  await fs.writeFile(previewAbs, code, 'utf8');
  return previewRel.split(path.sep).join('/');
}

// ── App wiring: connect main.dart to the generated router ─────────────────────
// THE disconnection fix. The canonical skeleton builds AppRouter (a MaterialApp
// with every route) but never rewires main.dart, and per-screen agents are barred
// from touching shared files — so main.dart stayed the broken Flutter counter
// boilerplate and the whole generated app was dead code. Write a main.dart that
// runs AppRouter, but ONLY when main.dart is missing or is the default boilerplate
// (never clobber a hand-written entrypoint). Idempotent — safe every run/resume.
const MAIN_BOILERPLATE = /Flutter Demo|MyHomePage|_MyHomePageState|counter/i;
export interface WireResult { wrote: boolean; reason: string }
export async function ensureMainWired(
  projectRoot: string, framework: string, opts?: { routerClass?: string; routerFile?: string },
): Promise<WireResult> {
  if ((framework || 'flutter').toLowerCase() !== 'flutter') return { wrote: false, reason: 'non-flutter' };
  const routerClass = opts?.routerClass ?? 'AppRouter';
  const routerFile = opts?.routerFile ?? 'app_router.dart';
  const mainAbs = path.join(projectRoot, 'lib', 'main.dart');
  const routerAbs = path.join(projectRoot, 'lib', routerFile);
  // Only wire if the router the skeleton generated actually exists.
  if (!fsSync.existsSync(routerAbs)) return { wrote: false, reason: 'no router yet' };
  let cur = '';
  try { cur = await fsSync.promises.readFile(mainAbs, 'utf8'); } catch { /* missing */ }
  const alreadyWired = cur.includes(routerFile) && cur.includes(routerClass);
  if (alreadyWired) return { wrote: false, reason: 'already wired' };
  // Refuse to overwrite a real, hand-written main.dart (not boilerplate, not empty).
  if (cur.trim() && !MAIN_BOILERPLATE.test(cur)) return { wrote: false, reason: 'custom main.dart — left as-is' };
  const src = `// GENERATED — app entrypoint wired to the central router.
import 'package:flutter/material.dart';
import '${routerFile}';

void main() => runApp(const ${routerClass}());
`;
  await fs.mkdir(path.dirname(mainAbs), { recursive: true });
  await fs.writeFile(mainAbs, src, 'utf8');
  return { wrote: true, reason: cur.trim() ? 'replaced boilerplate' : 'created' };
}

// ── Consolidation pass: replace token-matching literals with AppTheme.* ───────
// End-of-run sweep (option 3, the safe part). Screens that hardcoded a raw color
// that EXACTLY equals a generated token get the literal swapped for the token
// symbol + the theme import added. Pure textual substitution of `Color(0xAARRGGBB)`
// → `AppTheme.<name>` (the token is a `static const Color`, so it's valid even in
// const contexts) — reversible, no AST risk. Only colors (the dominant duplication);
// spacing/radius are noisier and left to the agent + contract.
export interface ConsolidateResult { filesChanged: number; replacements: number }
export async function consolidateDesignTokens(
  projectRoot: string, tokens: ThemeTokens, dirs = ['lib/screens', 'lib/components'],
): Promise<ConsolidateResult> {
  // hex (no #) → token name, e.g. "12ae89" → "brand"
  const byHex = new Map<string, string>();
  for (const c of tokens.colors) byHex.set(c.hex.replace('#', '').toLowerCase(), c.name);
  if (!byHex.size) return { filesChanged: 0, replacements: 0 };
  let filesChanged = 0, replacements = 0;
  for (const dir of dirs) {
    const abs = path.join(projectRoot, dir);
    let entries: string[] = [];
    try { entries = (await fs.readdir(abs)).filter(f => f.endsWith('.dart')); } catch { continue; }
    for (const f of entries) {
      const fileAbs = path.join(abs, f);
      let text: string;
      try { text = await fs.readFile(fileAbs, 'utf8'); } catch { continue; }
      let n = 0;
      // Match [const ]Color(0xFF12AE89) — 8 hex digits (AARRGGBB). Only swap when the
      // RRGGBB maps to a token AND alpha is FF (fully opaque), so a translucent overlay
      // is never changed. We CONSUME an optional leading `const ` because the token is
      // itself a `static const`, and `const AppTheme.brand` is invalid Dart — the
      // replacement (a const value) is valid in const contexts WITHOUT the keyword.
      const next = text.replace(/(?:const\s+)?Color\(0x([0-9a-fA-F]{8})\)/g, (m, hex8: string) => {
        const a = hex8.slice(0, 2).toLowerCase(), rgb = hex8.slice(2).toLowerCase();
        const name = a === 'ff' ? byHex.get(rgb) : undefined;
        if (!name) return m;
        n++;
        return `${tokens.className}.${name}`;
      });
      if (n > 0) {
        // Ensure the theme import is present (screens are one dir deep under lib/).
        const importLine = `import '${path.relative(path.dirname(fileAbs), path.join(projectRoot, tokens.themeFile)).split(path.sep).join('/')}';`;
        let out = next;
        if (!out.includes(tokens.themeFile.split(path.sep).join('/')) && !out.includes("/app_theme.dart")) {
          out = out.replace(/(import\s+'package:flutter\/material\.dart';\s*\n)/, `$1${importLine}\n`);
          if (out === next) out = `${importLine}\n${next}`;   // no material import found — prepend
        }
        await fs.writeFile(fileAbs, out, 'utf8');
        filesChanged++; replacements += n;
      }
    }
  }
  return { filesChanged, replacements };
}
