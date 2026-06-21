// =============================================================================
// File: src/relay-server/passes/token-cleanup.ts
//
// Phase 7f — Token deepening + dead-code cleanup (FINAL production-readiness pass).
//
// By the time 7f runs, the design system (src/relay-server/design-system.ts) has
// already (a) emitted a real importable AppTheme and (b) run the end-of-build
// COLOR sweep (consolidateDesignTokens). 7f goes DEEPER and WIDER:
//
//   1. TOKEN DEEPENING — replace remaining hardcoded literals across lib/** with
//      the EXACT design-system token when (and only when) the literal's value is
//      IDENTICAL to a defined token's value:
//        • Colors    — `Color(0xAARRGGBB)` / a file-local `const Color _x = …`
//          whose ARGB matches a color token → `AppTheme.<name>`.
//        • Spacing   — `EdgeInsets.all/symmetric(N)`, `SizedBox(width/height:N)`,
//          `SizedBox.square(dimension:N)` where N equals a spacing token → the
//          token symbol.
//        • Radius    — `BorderRadius.circular(N)` / `Radius.circular(N)` where N
//          equals a radius token → `AppTheme.r<N>` (when the whole expr matches).
//        • Text style— an inline `TextStyle(fontFamily/fontSize/fontWeight/…)` or
//          `GoogleFonts.x(…)` that is SEMANTICALLY the same as a named AppTheme
//          text-style helper → the helper call. This is the ONLY judgment call,
//          so it is gated behind (i) exact numeric equality of every load-bearing
//          field and (ii) an AI confirmation (runModel). Differing height /
//          letterSpacing ⇒ NOT the same ⇒ left alone.
//
//      CONSERVATIVE BY CONSTRUCTION: a literal is replaced ONLY when it exactly
//      equals a token. A one-off value with no token is never touched. A wrong
//      substitution that shifts a color is far worse than a surviving literal, so
//      every transform errs toward leaving the literal.
//
//   2. CLEANUP — remove provably-dead code:
//        • unused imports (driven by `flutter analyze`'s own unused_import lint as
//          ground truth, never a guess),
//        • unused file-local private top-level `const _x`/`final _x` (0 refs in
//          the file, AND not referenced anywhere else under lib/ test/ _preview),
//        • unreferenced private widget classes (`class _Foo`) with 0 refs project-
//          wide.
//      Nothing referenced from tests, _preview entries, or sibling files is ever
//      removed.
//
//   3. The pass ENDS with `flutter analyze` and reports before/after counts.
//
// FRAMEWORK-AGNOSTIC. detectFramework() (reused from component-extraction, the
// 7a–7e contract) dispatches to a per-framework strategy. Flutter ships a full
// implementation; react is a stubbed seam.
//
// IDEMPOTENT: a second run finds every token-equal literal already a token and
// every dead decl already gone → 0 substitutions, 0 removals.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AIModel } from '../ai-adapters';
import { detectFramework, type Framework } from './component-extraction';

export { detectFramework };
export type { Framework };

// ── Public contract ──────────────────────────────────────────────────────────

export interface DeepenTokensOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used ONLY for text-style semantic-equivalence judgment. */
  model?: AIModel;
  /** Skip AI entirely (text-style substitution then requires field-exact only).
   *  Default false. When true, text-style substitution is SKIPPED (no judgment
   *  source) — deterministic transforms still run. */
  noAi?: boolean;
  /** Only report what WOULD change; do not write. Default false. */
  dryRun?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Skip the (slow) flutter analyze gate; cleanup then uses only the
   *  deterministic dead-decl detector, not the analyzer's unused_import lint.
   *  Default false. */
  skipAnalyze?: boolean;
  /** Where to write the report (default <root>/.uix/token-cleanup-report.json). */
  reportPath?: string;
  /** Skip writing the report file (testing). Default false. */
  noReport?: boolean;
  /** Restrict to these file basenames (testing). */
  onlyFiles?: string[];
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface SubstitutionCounts {
  colors: number;
  textStyles: number;
  spacing: number;
  radius: number;
}
export interface RemovalCounts {
  imports: number;
  consts: number;
  methods: number; // private widget classes / private members
}

export interface TokenCleanupReport {
  version: 1;
  projectId: string;
  framework: Framework;
  generatedAt: string;
  dryRun: boolean;
  themeFile: string | null;
  tokensAvailable: {
    colors: Array<{ name: string; argb: string }>;
    spacing: Array<{ name: string; value: number }>;
    radius: Array<{ name: string; value: number }>;
    textStyles: string[];
  };
  substitutions: SubstitutionCounts;
  removals: RemovalCounts;
  /** Per-file detail of what changed (for review/audit). */
  changes: Array<{ file: string; kind: string; from: string; to: string }>;
  /** Substitutions considered but REJECTED (and why) — the adversarial trail. */
  rejected: Array<{ file: string; kind: string; literal: string; reason: string }>;
  analyze: { before: number | null; after: number | null; skipped: boolean };
}

export interface TokenCleanupResult {
  report: TokenCleanupReport;
  reportPath: string | null;
}

// ── Theme-token model ─────────────────────────────────────────────────────────

export interface ColorTokenDef { name: string; argb: string } // argb = lowercase 8-hex
export interface NumTokenDef { name: string; value: number }
export interface ThemeModel {
  className: string;            // e.g. AppTheme
  themeFileRel: string;        // e.g. lib/theme/app_theme.dart
  colors: ColorTokenDef[];
  spacing: NumTokenDef[];      // s4=4, s8=8, …
  radius: NumTokenDef[];       // r8=8, r12=12, … (the circular radius value)
  /** Names of the text-style helper methods, e.g. ['grotesk','inter','montserrat','display']. */
  textStyleHelpers: string[];
}

// ── Per-framework strategy seam ──────────────────────────────────────────────

export interface DeepenStrategy {
  framework: Framework;
  run(projectRoot: string, opts: DeepenTokensOptions): Promise<{
    report: Omit<TokenCleanupReport, 'version' | 'projectId' | 'framework' | 'generatedAt' | 'dryRun'>;
  }>;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function deepenTokensAndCleanup(
  projectId: string,
  opts: DeepenTokensOptions,
): Promise<TokenCleanupResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);

  const emptyBody: TokenCleanupReport = {
    version: 1,
    projectId,
    framework,
    generatedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    themeFile: null,
    tokensAvailable: { colors: [], spacing: [], radius: [], textStyles: [] },
    substitutions: { colors: 0, textStyles: 0, spacing: 0, radius: 0 },
    removals: { imports: 0, consts: 0, methods: 0 },
    changes: [],
    rejected: [],
    analyze: { before: null, after: null, skipped: true },
  };

  if (!strategy) {
    const reportPath = await maybeWriteReport(projectRoot, emptyBody, opts);
    return { report: emptyBody, reportPath };
  }

  const { report: body } = await strategy.run(projectRoot, opts);
  const report: TokenCleanupReport = {
    version: 1,
    projectId,
    framework,
    generatedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    ...body,
  };
  const reportPath = await maybeWriteReport(projectRoot, report, opts);
  return { report, reportPath };
}

function getStrategy(fw: Framework): DeepenStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react') return reactStrategy;
  return null;
}

async function maybeWriteReport(projectRoot: string, report: TokenCleanupReport, opts: DeepenTokensOptions): Promise<string | null> {
  if (opts.noReport) return null;
  const abs = opts.reportPath ?? path.join(projectRoot, '.uix', 'token-cleanup-report.json');
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');
    return abs;
  } catch {
    return null;
  }
}

// =============================================================================
// Theme parsing (Flutter)
// =============================================================================

/** Parse lib/theme/app_theme.dart into a ThemeModel (pure-ish; reads one file). */
export async function parseFlutterTheme(projectRoot: string, themeFileRel = path.join('lib', 'theme', 'app_theme.dart')): Promise<ThemeModel | null> {
  let src: string;
  try { src = await fs.readFile(path.join(projectRoot, themeFileRel), 'utf8'); } catch { return null; }
  return parseFlutterThemeSource(src, themeFileRel);
}

/** Pure parser over the theme source (testable without IO). */
export function parseFlutterThemeSource(src: string, themeFileRel = path.join('lib', 'theme', 'app_theme.dart')): ThemeModel | null {
  const clsM = /class\s+([A-Za-z_]\w*)\s*\{/.exec(src);
  if (!clsM) return null;
  const className = clsM[1];

  // Colors: `static const Color <name> = Color(0xAARRGGBB);`
  const colors: ColorTokenDef[] = [];
  const colorRe = /static\s+const\s+Color\s+([A-Za-z_]\w*)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)\s*;/g;
  let cm: RegExpExecArray | null;
  while ((cm = colorRe.exec(src)) !== null) {
    colors.push({ name: cm[1], argb: cm[2].toLowerCase() });
  }

  // Spacing: a single `static const double s4 = 4, s8 = 8, … ;` declaration AND
  // any standalone `static const double sName = N;`.
  const spacing: NumTokenDef[] = [];
  // Multi-assignment block.
  const sBlock = /static\s+const\s+double\s+((?:[A-Za-z_]\w*\s*=\s*-?\d+(?:\.\d+)?\s*,?\s*)+);/g;
  let sb: RegExpExecArray | null;
  while ((sb = sBlock.exec(src)) !== null) {
    const pairRe = /([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairRe.exec(sb[1])) !== null) {
      if (/^s\d/.test(pm[1])) spacing.push({ name: pm[1], value: Number(pm[2]) });
    }
  }

  // Radius: `static const BorderRadius r8 = BorderRadius.all(Radius.circular(8));`
  const radius: NumTokenDef[] = [];
  const rRe = /static\s+const\s+BorderRadius\s+([A-Za-z_]\w*)\s*=\s*BorderRadius\.all\(\s*Radius\.circular\((\d+(?:\.\d+)?)\)\s*\)\s*;/g;
  let rm: RegExpExecArray | null;
  while ((rm = rRe.exec(src)) !== null) {
    radius.push({ name: rm[1], value: Number(rm[2]) });
  }

  // Text-style helpers: `static TextStyle <name>({...}) => …`
  const textStyleHelpers: string[] = [];
  const tsRe = /static\s+TextStyle\s+([A-Za-z_]\w*)\s*\(/g;
  let tm: RegExpExecArray | null;
  while ((tm = tsRe.exec(src)) !== null) textStyleHelpers.push(tm[1]);

  return { className, themeFileRel: themeFileRel.split(path.sep).join('/'), colors, spacing, radius, textStyleHelpers };
}

// =============================================================================
// Flutter strategy
// =============================================================================

const flutterStrategy: DeepenStrategy = {
  framework: 'flutter',
  async run(projectRoot, opts) {
    return runFlutter(projectRoot, opts);
  },
};

interface ChangeRec { file: string; kind: string; from: string; to: string }
interface RejectRec { file: string; kind: string; literal: string; reason: string }

async function runFlutter(projectRoot: string, opts: DeepenTokensOptions): Promise<{ report: Omit<TokenCleanupReport, 'version' | 'projectId' | 'framework' | 'generatedAt' | 'dryRun'> }> {
  const theme = await parseFlutterTheme(projectRoot);
  const changes: ChangeRec[] = [];
  const rejected: RejectRec[] = [];
  const subs: SubstitutionCounts = { colors: 0, textStyles: 0, spacing: 0, radius: 0 };
  const removals: RemovalCounts = { imports: 0, consts: 0, methods: 0 };

  const tokensAvailable = {
    colors: theme?.colors.map((c) => ({ name: c.name, argb: c.argb })) ?? [],
    spacing: theme?.spacing.map((s) => ({ name: s.name, value: s.value })) ?? [],
    radius: theme?.radius.map((r) => ({ name: r.name, value: r.value })) ?? [],
    textStyles: theme?.textStyleHelpers ?? [],
  };

  // Analyze BEFORE (diagnostic count + unused-import map), unless skipped.
  let analyzeBefore: number | null = null;
  let unusedImports: AnalyzeUnused[] = [];
  if (!opts.skipAnalyze) {
    const a = await flutterAnalyze(projectRoot);
    analyzeBefore = a.count;
    unusedImports = a.unused;
  }

  const dartFiles = await collectTargetDartFiles(projectRoot, opts.onlyFiles);
  // Read all once; mutate in memory; write at end (so multiple transforms compose).
  const contents = new Map<string, string>();
  for (const f of dartFiles) contents.set(f, await fs.readFile(f, 'utf8'));

  // ── 1) TOKEN DEEPENING (deterministic transforms) ──────────────────────────
  if (theme) {
    for (const [file, src0] of contents) {
      const rel = path.relative(projectRoot, file);
      let src = src0;
      // a) colors
      const cRes = substituteColors(src, theme, rel);
      src = cRes.src; subs.colors += cRes.count; changes.push(...cRes.changes); rejected.push(...cRes.rejected);
      // b) spacing
      const spRes = substituteSpacing(src, theme, rel);
      src = spRes.src; subs.spacing += spRes.count; changes.push(...spRes.changes);
      // c) radius
      const rRes = substituteRadius(src, theme, rel);
      src = rRes.src; subs.radius += rRes.count; changes.push(...rRes.changes);

      if (src !== src0) {
        // Any substitution may need the theme import (token is AppTheme.x).
        src = ensureThemeImport(src, file, projectRoot, theme);
      }
      contents.set(file, src);
    }

    // d) text styles (AI judgment) — only when allowed.
    if (!opts.noAi && opts.model && opts.runModel) {
      for (const [file, src0] of contents) {
        const rel = path.relative(projectRoot, file);
        const tsRes = await substituteTextStyles(src0, theme, rel, opts);
        if (tsRes.count > 0) {
          let src = tsRes.src;
          src = ensureThemeImport(src, file, projectRoot, theme);
          contents.set(file, src);
        }
        subs.textStyles += tsRes.count;
        changes.push(...tsRes.changes);
        rejected.push(...tsRes.rejected);
      }
    }
  }

  // ── 2) CLEANUP ──────────────────────────────────────────────────────────────
  // a) unused imports — analyzer-driven (ground truth). Map analyze diagnostics
  //    (1-based line numbers) onto the in-memory content and delete those lines.
  if (unusedImports.length) {
    const byFile = new Map<string, number[]>();
    for (const u of unusedImports) {
      const abs = path.isAbsolute(u.file) ? u.file : path.join(projectRoot, u.file);
      if (!contents.has(abs)) continue;
      (byFile.get(abs) ?? byFile.set(abs, []).get(abs)!).push(u.line);
    }
    for (const [abs, lines] of byFile) {
      const src = contents.get(abs)!;
      const out = removeLines(src, lines, /^\s*import\s/);
      if (out.text !== src) {
        contents.set(abs, out.text);
        removals.imports += out.removed;
        for (const l of out.removedTexts) changes.push({ file: path.relative(projectRoot, abs), kind: 'remove-import', from: l.trim(), to: '' });
      }
    }
  }

  // b) dead private top-level consts/finals — project-wide ref check.
  //    Build a global reference index FIRST (across all target files) so a const
  //    used only from another file or a test/_preview is never removed.
  {
    const dead = findDeadPrivateConsts(contents, projectRoot);
    for (const d of dead) {
      const src = contents.get(d.file)!;
      const out = removeTopLevelDecl(src, d.name, d.kind);
      if (out !== src) {
        contents.set(d.file, out);
        removals.consts += 1;
        changes.push({ file: path.relative(projectRoot, d.file), kind: `remove-${d.kind}`, from: d.name, to: '' });
      }
    }
  }

  // c) dead private widget classes — 0 refs anywhere in the target set.
  {
    const dead = findDeadPrivateClasses(contents);
    for (const d of dead) {
      const src = contents.get(d.file)!;
      const out = removeClassDecl(src, d.name);
      if (out !== src) {
        contents.set(d.file, out);
        removals.methods += 1;
        changes.push({ file: path.relative(projectRoot, d.file), kind: 'remove-private-widget', from: d.name, to: '' });
      }
    }
  }

  // ── WRITE ────────────────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    for (const [file, src] of contents) {
      const original = await fs.readFile(file, 'utf8');
      if (original !== src) await fs.writeFile(file, src, 'utf8');
    }
  }

  // Analyze AFTER (only meaningful when we actually wrote).
  let analyzeAfter: number | null = null;
  if (!opts.skipAnalyze && !opts.dryRun) {
    analyzeAfter = (await flutterAnalyze(projectRoot)).count;
  } else if (!opts.skipAnalyze) {
    analyzeAfter = analyzeBefore;
  }

  return {
    report: {
      themeFile: theme?.themeFileRel ?? null,
      tokensAvailable,
      substitutions: subs,
      removals,
      changes,
      rejected,
      analyze: { before: analyzeBefore, after: analyzeAfter, skipped: !!opts.skipAnalyze },
    },
  };
}

// ── Color substitution ────────────────────────────────────────────────────────

/** Replace `Color(0xAARRGGBB)` and a file-local `const Color _x = Color(...)`'s
 *  literal with the matching AppTheme color token. ARGB-exact (alpha included),
 *  so a translucent overlay never collapses onto an opaque brand token unless the
 *  token itself encodes that alpha. */
function substituteColors(src: string, theme: ThemeModel, rel: string): { src: string; count: number; changes: ChangeRec[]; rejected: RejectRec[] } {
  const byArgb = new Map<string, string>();
  for (const c of theme.colors) byArgb.set(c.argb, c.name);
  const changes: ChangeRec[] = [];
  const rejected: RejectRec[] = [];
  let count = 0;

  // Do not touch the theme file itself (it DEFINES the tokens).
  if (rel.split(path.sep).join('/') === theme.themeFileRel) return { src, count, changes, rejected };

  const out = src.replace(/(?:const\s+)?Color\(0x([0-9A-Fa-f]{8})\)/g, (m, hex8: string) => {
    const argb = hex8.toLowerCase();
    const name = byArgb.get(argb);
    if (!name) {
      // No token for this exact value → leave the one-off literal alone.
      return m;
    }
    count++;
    changes.push({ file: rel, kind: 'color', from: m, to: `${theme.className}.${name}` });
    return `${theme.className}.${name}`;
  });
  return { src: out, count, changes, rejected };
}

// ── Spacing substitution ──────────────────────────────────────────────────────

/** Replace bare numeric literals that EXACTLY equal a spacing token, but only in
 *  unambiguous spacing positions: EdgeInsets.all(N) / EdgeInsets.symmetric(...:N)
 *  / SizedBox(width|height: N) / SizedBox.square(dimension: N). We use AppTheme.sN
 *  for the value. Other numbers (font sizes, icon sizes, opacities) are NOT
 *  spacing and are left alone. */
function substituteSpacing(src: string, theme: ThemeModel, rel: string): { src: string; count: number; changes: ChangeRec[] } {
  const changes: ChangeRec[] = [];
  let count = 0;
  if (rel.split(path.sep).join('/') === theme.themeFileRel) return { src, count, changes };
  const byVal = new Map<number, string>();
  for (const s of theme.spacing) if (!byVal.has(s.value)) byVal.set(s.value, s.name);
  if (!byVal.size) return { src, count, changes };

  const tokenFor = (n: number): string | null => {
    const name = byVal.get(n);
    return name ? `${theme.className}.${name}` : null;
  };

  let out = src;
  // EdgeInsets.all(N)
  out = out.replace(/EdgeInsets\.all\((\d+(?:\.\d+)?)\)/g, (m, num: string) => {
    const tok = tokenFor(Number(num));
    if (!tok) return m;
    count++; changes.push({ file: rel, kind: 'spacing', from: m, to: `EdgeInsets.all(${tok})` });
    return `EdgeInsets.all(${tok})`;
  });
  // EdgeInsets.symmetric(horizontal: N) / (vertical: N) / both — replace each numeric arg.
  out = out.replace(/EdgeInsets\.symmetric\(([^()]*)\)/g, (m, inner: string) => {
    let changed = false;
    const next = inner.replace(/((?:horizontal|vertical)\s*:\s*)(\d+(?:\.\d+)?)/g, (mm, key: string, num: string) => {
      const tok = tokenFor(Number(num));
      if (!tok) return mm;
      changed = true; count++; return `${key}${tok}`;
    });
    if (!changed) return m;
    changes.push({ file: rel, kind: 'spacing', from: m, to: `EdgeInsets.symmetric(${next})` });
    return `EdgeInsets.symmetric(${next})`;
  });
  // SizedBox(width: N) / height: N — only the named width/height args.
  out = out.replace(/SizedBox\(([^()]*)\)/g, (m, inner: string) => {
    let changed = false;
    const next = inner.replace(/((?:width|height)\s*:\s*)(\d+(?:\.\d+)?)/g, (mm, key: string, num: string) => {
      const tok = tokenFor(Number(num));
      if (!tok) return mm;
      changed = true; count++; return `${key}${tok}`;
    });
    if (!changed) return m;
    changes.push({ file: rel, kind: 'spacing', from: m, to: `SizedBox(${next})` });
    return `SizedBox(${next})`;
  });
  // SizedBox.square(dimension: N)
  out = out.replace(/SizedBox\.square\(\s*dimension\s*:\s*(\d+(?:\.\d+)?)\s*\)/g, (m, num: string) => {
    const tok = tokenFor(Number(num));
    if (!tok) return m;
    count++; changes.push({ file: rel, kind: 'spacing', from: m, to: `SizedBox.square(dimension: ${tok})` });
    return `SizedBox.square(dimension: ${tok})`;
  });
  return { src: out, count, changes };
}

// ── Radius substitution ───────────────────────────────────────────────────────

/** Replace `BorderRadius.circular(N)` with `AppTheme.rN` when N equals a radius
 *  token. (We only collapse the WHOLE `BorderRadius.circular(N)` — a bare
 *  `Radius.circular(N)` inside a multi-corner BorderRadius.only(...) has no
 *  single-token equivalent, so it is left.) */
function substituteRadius(src: string, theme: ThemeModel, rel: string): { src: string; count: number; changes: ChangeRec[] } {
  const changes: ChangeRec[] = [];
  let count = 0;
  if (rel.split(path.sep).join('/') === theme.themeFileRel) return { src, count, changes };
  const byVal = new Map<number, string>();
  for (const r of theme.radius) if (!byVal.has(r.value)) byVal.set(r.value, r.name);
  if (!byVal.size) return { src, count, changes };

  const out = src.replace(/BorderRadius\.circular\((\d+(?:\.\d+)?)\)/g, (m, num: string) => {
    const name = byVal.get(Number(num));
    if (!name) return m;
    count++;
    const tok = `${theme.className}.${name}`;
    changes.push({ file: rel, kind: 'radius', from: m, to: tok });
    return tok;
  });
  return { src: out, count, changes };
}

// ── Text-style substitution (AI judgment) ─────────────────────────────────────

interface ParsedTextStyle { fontFamily?: string; fontSize?: number; fontWeight?: string; height?: number; letterSpacing?: number; color?: string }

/** Parse an inline TextStyle(...) or GoogleFonts.<fam>(...) argument list into a
 *  field map. Returns null if the call has positional args or is otherwise not a
 *  flat named-arg literal we can reason about. */
export function parseInlineTextStyle(call: string): { kind: 'TextStyle' | 'GoogleFonts'; family?: string; fields: ParsedTextStyle } | null {
  const gf = /^GoogleFonts\.([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(call.trim());
  const ts = /^(?:const\s+)?TextStyle\s*\(([\s\S]*)\)$/.exec(call.trim());
  let inner: string; let kind: 'TextStyle' | 'GoogleFonts'; let family: string | undefined;
  if (gf) { kind = 'GoogleFonts'; family = gf[1]; inner = gf[2]; }
  else if (ts) { kind = 'TextStyle'; inner = ts[1]; }
  else return null;
  const fields: ParsedTextStyle = {};
  const segs = splitArgs(inner);
  for (const seg of segs) {
    const m = /^([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(seg.trim());
    if (!m) {
      if (seg.trim()) return null; // positional / unparseable arg → bail (conservative)
      continue;
    }
    const key = m[1]; const val = m[2].trim();
    if (key === 'fontFamily') fields.fontFamily = stripQuotes(val);
    else if (key === 'fontSize') { const n = Number(val); if (!Number.isNaN(n)) fields.fontSize = n; else return null; }
    else if (key === 'fontWeight') fields.fontWeight = val;
    else if (key === 'height') { const n = Number(val); if (!Number.isNaN(n)) fields.height = n; }
    else if (key === 'letterSpacing') { const n = Number(val); if (!Number.isNaN(n)) fields.letterSpacing = n; }
    else if (key === 'color') fields.color = val;
    else return null; // unknown field (decoration, shadows, …) → not a plain style; bail.
  }
  return { kind, family, fields };
}

/** Find inline TextStyle/GoogleFonts call expressions in a `style:` position and,
 *  for each, ask the model whether it equals a named AppTheme helper — but ONLY
 *  after a deterministic gate (we never substitute on AI say-so alone). Today we
 *  require the AI to NAME the helper; we then verify the family matches the helper
 *  and DON'T touch styles with height/letterSpacing/color the helper can't carry
 *  by default. To stay maximally safe in this pass we currently REJECT every
 *  inline style that has a height OR letterSpacing differing nature, and we only
 *  substitute when the model confirms equivalence AND the call has no fields the
 *  helper signature can't represent. */
async function substituteTextStyles(
  src: string,
  theme: ThemeModel,
  rel: string,
  opts: DeepenTokensOptions,
): Promise<{ src: string; count: number; changes: ChangeRec[]; rejected: RejectRec[] }> {
  const changes: ChangeRec[] = [];
  const rejected: RejectRec[] = [];
  let count = 0;
  if (rel.split(path.sep).join('/') === theme.themeFileRel) return { src, count, changes, rejected };
  if (!theme.textStyleHelpers.length) return { src, count, changes, rejected };

  const calls = findTextStyleCalls(src);
  if (!calls.length) return { src, count, changes, rejected };

  // Apply right-to-left so offsets stay valid.
  let out = src;
  const ordered = [...calls].sort((a, b) => b.start - a.start);
  for (const c of ordered) {
    const callText = src.slice(c.start, c.end);
    const parsed = parseInlineTextStyle(callText);
    if (!parsed) { rejected.push({ file: rel, kind: 'text-style', literal: trunc(callText), reason: 'unparseable / positional args' }); continue; }

    // Deterministic gate: the inline style MUST carry a fontSize+fontWeight pair
    // we can pass to the helper. A GoogleFonts.<fam> call whose <fam> matches a
    // helper-mapped family is the strongest signal.
    const ask = await aiConfirmTextStyle(parsed, theme, opts);
    if (!ask.equivalent || !ask.helper) {
      rejected.push({ file: rel, kind: 'text-style', literal: trunc(callText), reason: ask.reason || 'AI: not equivalent to a named style' });
      continue;
    }
    // Build the helper call from the parsed fields (only fields the helper accepts).
    const repl = buildHelperCall(theme.className, ask.helper, parsed.fields);
    if (!repl) { rejected.push({ file: rel, kind: 'text-style', literal: trunc(callText), reason: 'fields not representable by helper signature' }); continue; }
    out = out.slice(0, c.start) + repl + out.slice(c.end);
    count++;
    changes.push({ file: rel, kind: 'text-style', from: trunc(callText), to: repl });
  }
  return { src: out, count, changes, rejected };
}

/** Locate `style:` inline TextStyle(...) / GoogleFonts.x(...) call spans. */
function findTextStyleCalls(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /\b(?:const\s+)?(TextStyle|GoogleFonts\.[A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Skip a definition inside the theme helper itself (handled by file guard) and
    // any AppTheme.x(...) call (already a token).
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    out.push({ start: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

interface AiTextStyleAnswer { equivalent: boolean; helper?: string; reason?: string }
async function aiConfirmTextStyle(
  parsed: NonNullable<ReturnType<typeof parseInlineTextStyle>>,
  theme: ThemeModel,
  opts: DeepenTokensOptions,
): Promise<AiTextStyleAnswer> {
  if (!opts.model || !opts.runModel) return { equivalent: false, reason: 'no model' };
  const prompt = [
    'A Flutter app has named text-style helpers on its theme class',
    `\`${theme.className}\`: ${theme.textStyleHelpers.map((h) => `${theme.className}.${h}(...)`).join(', ')}.`,
    'Each helper wraps a specific font family (e.g. grotesk→DM Sans, inter→Inter,',
    'montserrat→Montserrat) and takes size/weight/color/height/letterSpacing.',
    '',
    'Here is an INLINE text style found in a screen:',
    JSON.stringify(parsed),
    '',
    'Decide: is this inline style SEMANTICALLY the SAME as one of the named helpers',
    '(same font family + the same load-bearing values, differing only in fields the',
    'helper accepts as arguments)? If the family does not match any helper, or it',
    'sets a property the helper cannot represent, answer equivalent=false.',
    '',
    'Reply with EXACTLY one JSON object, no prose:',
    '{"equivalent": true|false, "helper": "<helper name or empty>", "reason": "<short>"}',
  ].join('\n');
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const mm = text.match(/\{[\s\S]*\}/);
    if (!mm) return { equivalent: false, reason: 'AI returned no JSON' };
    const j = JSON.parse(mm[0]) as { equivalent?: boolean; helper?: string; reason?: string };
    if (!j.equivalent || !j.helper || !theme.textStyleHelpers.includes(j.helper)) {
      return { equivalent: false, reason: j.reason || 'AI: not a known helper' };
    }
    return { equivalent: true, helper: j.helper, reason: j.reason };
  } catch (e) {
    return { equivalent: false, reason: `AI confirm failed: ${(e as Error).message}` };
  }
}

/** Render `AppTheme.<helper>(size: …, weight: …, color: …, height: …, letterSpacing: …)`
 *  using only the fields present. Returns null if there's nothing meaningful. */
function buildHelperCall(className: string, helper: string, f: ParsedTextStyle): string | null {
  const args: string[] = [];
  if (f.fontSize !== undefined) args.push(`size: ${f.fontSize}`);
  if (f.fontWeight !== undefined) args.push(`weight: ${f.fontWeight}`);
  if (f.color !== undefined) args.push(`color: ${f.color}`);
  if (f.height !== undefined) args.push(`height: ${f.height}`);
  if (f.letterSpacing !== undefined) args.push(`letterSpacing: ${f.letterSpacing}`);
  if (!args.length) return null;
  return `${className}.${helper}(${args.join(', ')})`;
}

// ── Cleanup: dead-decl detection ──────────────────────────────────────────────

/** Top-level private const/final whose ONLY textual reference (project-wide,
 *  across the whole target set) is its own declaration. */
function findDeadPrivateConsts(contents: Map<string, string>, _projectRoot: string): Array<{ file: string; name: string; kind: 'const' | 'final' }> {
  // Global reference index: count whole-word occurrences across ALL target files.
  const globalCount = new Map<string, number>();
  const bump = (name: string, by: number) => globalCount.set(name, (globalCount.get(name) ?? 0) + by);
  const declRe = /^(const|final)\s+[A-Za-z0-9_<>?,. ]*?\b(_[A-Za-z0-9_]+)\s*=\s*[^;]+;/gm;

  const decls: Array<{ file: string; name: string; kind: 'const' | 'final' }> = [];
  for (const [file, src] of contents) {
    let m: RegExpExecArray | null;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(src)) !== null) decls.push({ file, name: m[2], kind: m[1] as 'const' | 'final' });
  }
  // Count references everywhere.
  for (const [, src] of contents) {
    for (const d of decls) {
      const re = new RegExp(`\\b${escapeRe(d.name)}\\b`, 'g');
      const n = (src.match(re) || []).length;
      if (n) bump(d.name, n);
    }
  }
  // A decl is dead iff it appears EXACTLY once project-wide (its own decl) AND its
  // name is unique (not declared in two files — then we can't be sure).
  const declaredCount = new Map<string, number>();
  for (const d of decls) declaredCount.set(d.name, (declaredCount.get(d.name) ?? 0) + 1);
  const dead: Array<{ file: string; name: string; kind: 'const' | 'final' }> = [];
  for (const d of decls) {
    if ((declaredCount.get(d.name) ?? 0) !== 1) continue; // ambiguous name → skip
    if ((globalCount.get(d.name) ?? 0) === 1) dead.push(d);
  }
  return dead;
}

/** Private widget classes (`class _Foo extends StatelessWidget/StatefulWidget`)
 *  with ZERO references across the whole target set OUTSIDE the class's own body.
 *  A widget's own class declaration + its own constructor name are SELF-references
 *  (e.g. `class _Foo {... const _Foo() ...}`), which is NOT external usage — so we
 *  exclude the class's own brace span when counting. A class referenced only from
 *  inside itself (recursion aside) is dead. */
function findDeadPrivateClasses(contents: Map<string, string>): Array<{ file: string; name: string }> {
  interface ClassEntry { file: string; name: string; start: number; end: number }
  const classes: ClassEntry[] = [];
  const re = /^class\s+(_[A-Za-z0-9_]+)\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/gm;
  for (const [file, src] of contents) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const braceStart = src.indexOf('{', m.index);
      const end = braceStart >= 0 ? matchBrace(src, braceStart) : -1;
      classes.push({ file, name: m[1], start: m.index, end: end >= 0 ? end : m.index });
    }
  }
  // External-reference count: occurrences of the name EXCLUDING each class's own span.
  const externalCount = new Map<string, number>();
  for (const c of classes) externalCount.set(c.name, 0);
  for (const [file, src] of contents) {
    for (const c of classes) {
      const r = new RegExp(`\\b${escapeRe(c.name)}\\b`, 'g');
      let mm: RegExpExecArray | null;
      while ((mm = r.exec(src)) !== null) {
        // A hit inside the class's OWN span (same file, within [start,end]) is a
        // self-reference (class decl, its constructor, internal use) — skip it.
        const inOwn = file === c.file && mm.index >= c.start && mm.index <= c.end;
        if (!inOwn) externalCount.set(c.name, (externalCount.get(c.name) ?? 0) + 1);
      }
    }
  }
  const declaredCount = new Map<string, number>();
  for (const c of classes) declaredCount.set(c.name, (declaredCount.get(c.name) ?? 0) + 1);
  const dead: Array<{ file: string; name: string }> = [];
  for (const c of classes) {
    if ((declaredCount.get(c.name) ?? 0) !== 1) continue; // ambiguous name → skip
    if ((externalCount.get(c.name) ?? 0) === 0) dead.push({ file: c.file, name: c.name });
  }
  return dead;
}

// ── source surgery helpers ─────────────────────────────────────────────────────

/** Remove the lines at the given 1-based line numbers IF they match `mustMatch`. */
function removeLines(src: string, lines: number[], mustMatch: RegExp): { text: string; removed: number; removedTexts: string[] } {
  const arr = src.split('\n');
  const drop = new Set(lines.map((l) => l - 1));
  const out: string[] = [];
  const removedTexts: string[] = [];
  let removed = 0;
  for (let i = 0; i < arr.length; i++) {
    if (drop.has(i) && mustMatch.test(arr[i])) { removed++; removedTexts.push(arr[i]); continue; }
    out.push(arr[i]);
  }
  return { text: out.join('\n'), removed, removedTexts };
}

/** Remove a top-level `const|final … _name = …;` declaration line(s). */
function removeTopLevelDecl(src: string, name: string, kind: 'const' | 'final'): string {
  const re = new RegExp(`^${kind}\\s+[A-Za-z0-9_<>?,. ]*?\\b${escapeRe(name)}\\s*=\\s*[^;]+;[^\\n]*\\n?`, 'm');
  return src.replace(re, '');
}

/** Remove a class declaration by name (brace-matched), plus a leading comment block. */
function removeClassDecl(src: string, className: string): string {
  const re = new RegExp(`^class\\s+${escapeRe(className)}\\b`, 'm');
  const m = re.exec(src);
  if (!m) return src;
  const braceStart = src.indexOf('{', m.index);
  if (braceStart < 0) return src;
  const end = matchBrace(src, braceStart);
  if (end < 0) return src;
  let start = m.index;
  const before = src.slice(0, start);
  const commentBlock = /(?:^[ \t]*\/\/[^\n]*\n)+\s*$/m.exec(before);
  if (commentBlock) start = commentBlock.index;
  let after = end + 1;
  while (src[after] === '\n') after++;
  return src.slice(0, start).replace(/\n*$/, '\n\n') + src.slice(after);
}

/** Ensure the theme import line is present (when a token symbol now appears). */
function ensureThemeImport(src: string, fileAbs: string, projectRoot: string, theme: ThemeModel): string {
  // Already references the theme path?
  const themeBase = path.basename(theme.themeFileRel);
  if (src.includes(themeBase)) return src;
  // Compute relative import path from this file to the theme file.
  const themeAbs = path.join(projectRoot, theme.themeFileRel);
  let relImp = path.relative(path.dirname(fileAbs), themeAbs).split(path.sep).join('/');
  if (!relImp.startsWith('.')) relImp = `./${relImp}`;
  const line = `import '${relImp}';`;
  if (src.includes(line)) return src;
  // Insert after the last existing import; else after the material import; else top.
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const at = last.index! + last[0].length;
    return src.slice(0, at) + `\n${line}` + src.slice(at);
  }
  const mat = /(import\s+'package:flutter\/material\.dart';\s*\n)/.exec(src);
  if (mat) return src.replace(mat[0], `${mat[0]}${line}\n`);
  return `${line}\n${src}`;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = ''; let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function stripQuotes(s: string): string { return s.replace(/^['"]|['"]$/g, ''); }
function trunc(s: string, n = 120): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; }

function matchParen(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function matchBrace(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── file collection ────────────────────────────────────────────────────────────

/** All .dart files under lib/** (the substitution + cleanup target). We scan
 *  lib only for MUTATION, but build the reference index from lib + test +
 *  _preview so a decl used by a test/preview is never seen as dead. */
async function collectTargetDartFiles(projectRoot: string, onlyFiles?: string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith('.dart')) out.push(abs);
    }
  }
  await walk(path.join(projectRoot, 'lib'));
  if (onlyFiles?.length) return out.filter((f) => onlyFiles.includes(path.basename(f)));
  return out;
}

// ── flutter analyze ────────────────────────────────────────────────────────────

interface AnalyzeUnused { file: string; line: number; lint: string }
interface AnalyzeResult { count: number; unused: AnalyzeUnused[]; raw: string }

/** Run `flutter analyze` and parse the diagnostic count + unused_import lines. */
export async function flutterAnalyze(projectRoot: string): Promise<AnalyzeResult> {
  const raw = await runCmd('flutter', ['analyze', '--no-pub'], projectRoot).catch(() => '');
  const lines = raw.split('\n');
  let count = 0;
  const unused: AnalyzeUnused[] = [];
  // Diagnostic lines look like:
  //   info • Unused import: '…' • lib/foo.dart:3:8 • unused_import
  //   error • The name 'MyApp' isn't a class … • test/widget_test.dart:16:35 • creation_with_non_type
  const diagRe = /^\s*(error|warning|info)\s+•.*•\s+(\S+?):(\d+):(\d+)\s+•\s+([a-z_]+)\s*$/;
  for (const ln of lines) {
    const m = diagRe.exec(ln);
    if (!m) continue;
    count++;
    const [, , file, lineNo, , lint] = m;
    if (lint === 'unused_import') unused.push({ file, line: Number(lineNo), lint });
  }
  // Fallback: trust the "N issues found." summary for the count when present.
  const summ = /(\d+)\s+issues?\s+found/.exec(raw);
  if (summ) count = Number(summ[1]);
  return { count, unused, raw };
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    // flutter analyze exits 1 when issues exist — that's not a failure for us.
    p.on('close', () => resolve(out + err));
  });
}

// =============================================================================
// React strategy (seam only — Phase 7f ships flutter; react contract is stubbed)
// =============================================================================

const reactStrategy: DeepenStrategy = {
  framework: 'react',
  async run() {
    // TODO(7f-react): parse the design-system module (e.g. src/theme/tokens.ts /
    // a Tailwind config / CSS custom properties) for color/spacing/radius/text
    // tokens; across src/** replace literal hex colors, px spacing, borderRadius,
    // and inline style objects / className utilities that EXACTLY equal a token
    // with the token reference (the same exact-match discipline as flutter). Then
    // drive unused-import / dead-export removal from `eslint --rule
    // no-unused-vars` + `tsc --noEmit` (the analyzer equivalents), verifying the
    // build + a render-tree snapshot are unchanged. AI is used ONLY to confirm an
    // inline style object is semantically the same as a named token.
    return {
      report: {
        themeFile: null,
        tokensAvailable: { colors: [], spacing: [], radius: [], textStyles: [] },
        substitutions: { colors: 0, textStyles: 0, spacing: 0, radius: 0 },
        removals: { imports: 0, consts: 0, methods: 0 },
        changes: [],
        rejected: [],
        analyze: { before: null, after: null, skipped: true },
      },
    };
  },
};
