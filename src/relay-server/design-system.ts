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
  const ink = tokens.colors.find(c => c.name.startsWith('ink'))?.name ?? null;
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
`;
}

export interface GenerateResult { themeFile: string; wrote: boolean; tokenCount: number; api: string }

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
    return { themeFile: tokens.themeFile, wrote: false, tokenCount: tokens.colors.length, api };
  }
  const abs = path.join(projectRoot, tokens.themeFile);
  // Idempotent: only (over)write the STUB. A file that already defines our class is
  // either ours from a prior pass or agent-extended — never clobber it.
  let existing = '';
  try { existing = await fs.readFile(abs, 'utf8'); } catch { /* fresh */ }
  const isStub = !existing.trim() || /GENERATED SKELETON|ThemeData\(useMaterial3:\s*true\)\s*;?\s*$/.test(existing.trim());
  const alreadyOurs = existing.includes(`class ${tokens.className} {`);
  if (alreadyOurs && !isStub) {
    return { themeFile: tokens.themeFile, wrote: false, tokenCount: tokens.colors.length, api };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, renderFlutterTheme(tokens), 'utf8');
  // Best-effort: keep main.dart's theme wired if it exists and is the boilerplate.
  return { themeFile: tokens.themeFile, wrote: true, tokenCount: tokens.colors.length, api };
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
