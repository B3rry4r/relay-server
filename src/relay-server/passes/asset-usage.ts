// =============================================================================
// File: src/relay-server/passes/asset-usage.ts
//
// Phase 7c — Asset-usage re-point (production-readiness pass).
//
// During the per-screen build the agent frequently (a) SUBSTITUTES a Material
// icon (`Icon(Icons.lock)`, `Icons.visibility_off`…) for what should be a real
// exported brand/SVG asset, and (b) references OPAQUE/RAW asset path string
// literals (`'assets/icons/vector_290_4399.svg'`) instead of the generated
// resources symbols (Flutter: `AppAssets.<name>`). This pass RE-POINTS those
// usages to the correct exported resource.
//
// FRAMEWORK-AGNOSTIC. detectFramework() (same contract as 7a/7b) dispatches to a
// per-framework `AssetUsageStrategy`. Flutter ships a full implementation; react
// is a stubbed seam so the contract is visible.
//
// DETERMINISTIC where possible: rewriting a raw path literal that appears
// verbatim in the asset-map → its resources symbol, and inserting the import,
// are pure source transforms and NEVER depend on AI. AI (runModel) is used ONLY
// for the genuinely-hard SEMANTIC match: deciding WHICH exported asset a given
// `Icon(Icons.X)` substitution should become, using the asset's semantic name
// (and, where available, its rendered reference image). Even there, the pass is
// CONSERVATIVE: a generic UI icon (chevron / back-arrow) with no exported asset
// counterpart is LEFT ALONE, and a low-confidence match is skipped + logged
// rather than guessed.
//
// IDEMPOTENT: a second run is a no-op — an already-`SvgPicture.asset(AppAssets.x)`
// / `Image.asset(AppAssets.x)` usage is recognised and skipped, never re-wrapped.
//
// Input: <projectRoot>/.uix/asset-map.json (runAssetPass() output). Shape:
//   { framework, resourcesPath, assets: [
//       { nodeId?, name, oldPath, newPath, format: 'svg'|'png', kind: 'icon'|'image' } ] }
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AIModel } from '../ai-adapters';

// ── Public contract ──────────────────────────────────────────────────────────

export type Framework = 'flutter' | 'react' | 'unknown';

export interface RepointOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used for the hard semantic icon→asset match. */
  model?: AIModel;
  /** Skip AI entirely (deterministic path-rewrites only). Default false. */
  noAi?: boolean;
  /** Only report what WOULD change; do not write. Default false. */
  dryRun?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Restrict to these source file basenames (testing). */
  onlyFiles?: string[];
  /** Override the project root used to read asset-map.json (testing). */
  mapRoot?: string;
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

/** A single applied (or would-be) re-point. */
export interface Repoint {
  /** Source file (relative to project root). */
  file: string;
  /** What was matched: a Material-icon substitution or a raw path literal. */
  from: 'material-icon' | 'raw-path';
  /** The original text fragment that triggered the rewrite (icon name / path). */
  original: string;
  /** The resources symbol it now points to, e.g. `AppAssets.visibility_off`. */
  symbol: string;
  /** The widget it was rewritten to. */
  widget: 'SvgPicture.asset' | 'Image.asset';
  /** How the asset was chosen. */
  how: 'deterministic' | 'ai';
}

export interface RepointSkip {
  file: string;
  /** The fragment we looked at (icon name / path). */
  what: string;
  reason: string;
}

export interface RepointResult {
  framework: Framework;
  /** Re-points successfully applied (or, in dryRun, that would be applied). */
  repointed: Repoint[];
  /** Usages deliberately left untouched (generic icon / low confidence) with reasons. */
  skipped: RepointSkip[];
  /** Warnings surfaced for the caller (e.g. missing flutter_svg, missing symbol). */
  warnings: string[];
  resourcesPath: string | null;
  dryRun: boolean;
}

// ── asset-map model ──────────────────────────────────────────────────────────

interface AssetMapEntry {
  nodeId?: string;
  name: string;
  oldPath: string;
  newPath: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
}
interface AssetMap {
  framework?: string;
  resourcesPath?: string | null;
  assets?: AssetMapEntry[];
}

async function readAssetMap(root: string): Promise<AssetMap | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.uix', 'asset-map.json'), 'utf8');
    return JSON.parse(raw) as AssetMap;
  } catch {
    return null;
  }
}

// ── Framework detection (same contract as 7a/7b) ─────────────────────────────

export async function detectFramework(projectRoot: string): Promise<Framework> {
  const has = async (p: string) => {
    try { await fs.access(path.join(projectRoot, p)); return true; } catch { return false; }
  };
  if (await has('pubspec.yaml')) return 'flutter';
  if (await has('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.react || deps.next) return 'react';
    } catch { /* fall through */ }
  }
  return 'unknown';
}

// ── Per-framework strategy seam ──────────────────────────────────────────────

export interface AssetUsageStrategy {
  framework: Framework;
  /**
   * Re-point asset usages across the project's source for one asset index.
   * Rewrites raw path literals (deterministic) and Material-icon substitutions
   * (AI-assisted where ambiguous), inserts the needed imports, and returns the
   * applied re-points + deliberate skips + warnings.
   */
  repoint(
    projectRoot: string,
    index: AssetIndex,
    opts: RepointOptions,
  ): Promise<{ repointed: Repoint[]; skipped: RepointSkip[]; warnings: string[] }>;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function repointAssetUsage(projectId: string, opts: RepointOptions): Promise<RepointResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  const map = await readAssetMap(opts.mapRoot ?? projectRoot);

  if (!map || !Array.isArray(map.assets) || map.assets.length === 0) {
    return {
      framework, repointed: [], skipped: [],
      warnings: ['no .uix/asset-map.json (or empty) — nothing to re-point. Run the Phase-2 asset pass (runAssetPass) first.'],
      resourcesPath: map?.resourcesPath ?? null, dryRun: !!opts.dryRun,
    };
  }
  if (!strategy) {
    return {
      framework, repointed: [], skipped: [],
      warnings: [`no strategy for framework '${framework}'`],
      resourcesPath: map.resourcesPath ?? null, dryRun: !!opts.dryRun,
    };
  }

  const index = buildAssetIndex(map);
  const out = await strategy.repoint(projectRoot, index, opts);
  return {
    framework,
    repointed: out.repointed,
    skipped: out.skipped,
    warnings: out.warnings,
    resourcesPath: map.resourcesPath ?? null,
    dryRun: !!opts.dryRun,
  };
}

function getStrategy(fw: Framework): AssetUsageStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react') return reactStrategy;
  return null;
}

// =============================================================================
// Asset index (framework-agnostic)
// =============================================================================

export interface IndexedAsset {
  /** semantic snake_case name from the asset-map. */
  name: string;
  /** original/pre-rename path (what opaque literals in source may reference). */
  oldPath: string;
  /** post-rename path (what the resources symbol resolves to). */
  newPath: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
  nodeId?: string;
  /** The resources-file key (lowerCamel) — must match resources-emit.ts. */
  symbolKey: string;
}

export interface AssetIndex {
  assets: IndexedAsset[];
  /** path (old OR new, posix-normalized) → asset, for deterministic literal rewrites. */
  byPath: Map<string, IndexedAsset>;
  /** symbolKey → asset. */
  bySymbol: Map<string, IndexedAsset>;
}

// Identifier helpers — MUST match resources-emit.ts toLowerCamel so the symbol we
// emit here resolves to the same `AppAssets.<key>` the resources file declares.
function toSnake(s: string): string {
  return (s || 'asset')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1') || 'asset';
}
function toLowerCamel(s: string): string {
  const snake = toSnake(s);
  const camel = snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return /^[0-9]/.test(camel) ? `a${camel}` : (camel || 'asset');
}

export function buildAssetIndex(map: AssetMap): AssetIndex {
  const assets: IndexedAsset[] = [];
  // resources-emit dedupes colliding keys by suffixing _2, _3… in emit order
  // (icons first then images, alphabetical within). Mirror that EXACTLY so our
  // symbol keys line up with what app_assets.dart actually declares.
  const sorted = [...(map.assets ?? [])].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'icon' ? -1 : 1);
  const used = new Map<string, number>();
  for (const e of sorted) {
    let key = toLowerCamel(e.name);
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    if (n > 0) key = `${key}_${n + 1}`;
    assets.push({
      name: e.name, oldPath: e.oldPath, newPath: e.newPath,
      format: e.format, kind: e.kind, nodeId: e.nodeId, symbolKey: key,
    });
  }

  const byPath = new Map<string, IndexedAsset>();
  const bySymbol = new Map<string, IndexedAsset>();
  for (const a of assets) {
    bySymbol.set(a.symbolKey, a);
    for (const p of [a.oldPath, a.newPath]) {
      const norm = normPath(p);
      // First writer wins for a colliding path; never silently overwrite (a path
      // colliding between two assets is an ambiguity we must not resolve blindly).
      if (norm && !byPath.has(norm)) byPath.set(norm, a);
    }
  }
  return { assets, byPath, bySymbol };
}

function normPath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// =============================================================================
// Flutter strategy
// =============================================================================

const flutterStrategy: AssetUsageStrategy = {
  framework: 'flutter',
  async repoint(projectRoot, index, opts) {
    return repointFlutter(projectRoot, index, opts);
  },
};

/** Where the generated resources file lives + its class name (resources-emit.ts). */
const FLUTTER_RESOURCES_REL = 'lib/resources/app_assets.dart';
const FLUTTER_RESOURCES_CLASS = 'AppAssets';

async function repointFlutter(
  projectRoot: string,
  index: AssetIndex,
  opts: RepointOptions,
): Promise<{ repointed: Repoint[]; skipped: RepointSkip[]; warnings: string[] }> {
  const repointed: Repoint[] = [];
  const skipped: RepointSkip[] = [];
  const warnings: string[] = [];

  // Guard: flutter_svg must be available or SvgPicture rewrites would break the
  // build. We do NOT add it silently — note it and SKIP svg rewrites if missing.
  const hasSvgDep = await pubspecHasFlutterSvg(projectRoot);
  if (!hasSvgDep) {
    warnings.push('flutter_svg is NOT in pubspec.yaml — SVG asset re-points are SKIPPED to avoid breaking the build. Add `flutter_svg` then re-run.');
  }

  // Confirm the resources file exists; without it AppAssets.<x> would not resolve.
  const resourcesAbs = path.join(projectRoot, FLUTTER_RESOURCES_REL);
  const resourcesSrc = await readFileOrNull(resourcesAbs);
  if (!resourcesSrc) {
    warnings.push(`resources file ${FLUTTER_RESOURCES_REL} not found — cannot reference ${FLUTTER_RESOURCES_CLASS} symbols. Run the asset pass first.`);
    return { repointed, skipped, warnings };
  }
  const declaredSymbols = parseDeclaredSymbols(resourcesSrc);

  const files = await collectDartFiles(projectRoot, opts.onlyFiles);

  for (const abs of files) {
    let src = await fs.readFile(abs, 'utf8');
    const rel = path.relative(projectRoot, abs);
    let changed = false;
    let usedSvg = false;
    let usedImage = false;

    // ── (b) DETERMINISTIC: raw asset path string literals → AppAssets symbol ──
    const pathLiterals = findPathLiterals(src);
    for (const lit of pathLiterals) {
      const asset = index.byPath.get(normPath(lit.value));
      if (!asset) continue;
      // Verify the symbol is actually declared in app_assets.dart (correctness).
      if (!declaredSymbols.has(asset.symbolKey)) {
        skipped.push({ file: rel, what: lit.value, reason: `asset-map symbol '${asset.symbolKey}' not declared in ${FLUTTER_RESOURCES_REL}` });
        continue;
      }
      if (asset.format === 'svg' && !hasSvgDep) {
        skipped.push({ file: rel, what: lit.value, reason: 'svg asset but flutter_svg missing — left as raw path' });
        continue;
      }
      const symbol = `${FLUTTER_RESOURCES_CLASS}.${asset.symbolKey}`;
      // Replace the literal (incl. quotes) with the symbol. The widget around it
      // (SvgPicture.asset / Image.asset / a param like iconAsset:) is preserved —
      // we only swap the opaque string for the semantic symbol, which is always
      // safe: same value, named reference.
      const replaced = replaceFirstLiteral(src, lit, symbol);
      if (replaced.changed) {
        src = replaced.src;
        changed = true;
        if (asset.format === 'svg') usedSvg = true; else usedImage = true;
        repointed.push({
          file: rel, from: 'raw-path', original: lit.value,
          symbol, widget: asset.format === 'svg' ? 'SvgPicture.asset' : 'Image.asset',
          how: 'deterministic',
        });
      }
    }

    // ── (a) Material-icon substitutions → exported asset (AI-assisted match) ──
    const iconUses = findMaterialIconUses(src);
    for (const use of iconUses) {
      // Idempotence / safety: only consider real `Icon(Icons.X)` widget uses we
      // can confidently rewrite. A bare `Icons.X` passed as a param to a custom
      // widget (e.g. `icon: Icons.person`) is NOT rewritten — its consumer expects
      // an IconData, and swapping in a widget would not type-check. Left alone.
      if (!use.isIconWidget) {
        continue;
      }
      const match = await matchIconToAsset(use.iconName, index, opts, projectRoot);
      if (!match) {
        // No exported asset counterpart → a genuine generic UI icon. LEAVE ALONE.
        continue;
      }
      if (!declaredSymbols.has(match.asset.symbolKey)) {
        skipped.push({ file: rel, what: `Icons.${use.iconName}`, reason: `matched asset symbol '${match.asset.symbolKey}' not declared in resources — skipped` });
        continue;
      }
      if (match.asset.format === 'svg' && !hasSvgDep) {
        skipped.push({ file: rel, what: `Icons.${use.iconName}`, reason: 'svg asset but flutter_svg missing — Material icon left in place' });
        continue;
      }
      const rewrite = rewriteIconWidget(src, use, match.asset);
      if (rewrite.changed) {
        src = rewrite.src;
        changed = true;
        if (match.asset.format === 'svg') usedSvg = true; else usedImage = true;
        repointed.push({
          file: rel, from: 'material-icon', original: `Icons.${use.iconName}`,
          symbol: `${FLUTTER_RESOURCES_CLASS}.${match.asset.symbolKey}`,
          widget: match.asset.format === 'svg' ? 'SvgPicture.asset' : 'Image.asset',
          how: match.how,
        });
      } else {
        skipped.push({ file: rel, what: `Icons.${use.iconName}`, reason: 'icon-widget rewrite could not be applied safely (unparsable args)' });
      }
    }

    if (changed && !opts.dryRun) {
      // Ensure the resources import + flutter_svg import are present.
      src = ensureImport(src, importPathFor(rel, FLUTTER_RESOURCES_REL));
      if (usedSvg) src = ensureImport(src, 'package:flutter_svg/flutter_svg.dart');
      void usedImage; // Image.asset is in material.dart (already imported on screens).
      await fs.writeFile(abs, src, 'utf8');
    }
  }

  return { repointed, skipped, warnings };
}

// ── pubspec / resources introspection ────────────────────────────────────────

async function pubspecHasFlutterSvg(projectRoot: string): Promise<boolean> {
  const src = await readFileOrNull(path.join(projectRoot, 'pubspec.yaml'));
  if (!src) return false;
  return /^\s*flutter_svg\s*:/m.test(src);
}

/** Parse the `static const String <key> = '...';` declarations from app_assets.dart. */
function parseDeclaredSymbols(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/static\s+const\s+String\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    out.add(m[1]);
  }
  return out;
}

// ── source scanning ──────────────────────────────────────────────────────────

async function collectDartFiles(projectRoot: string, onlyFiles?: string[]): Promise<string[]> {
  const libDir = path.join(projectRoot, 'lib');
  const out: string[] = [];
  await walk(libDir, out);
  let files = out.filter((f) => f.endsWith('.dart'));
  // Skip generated resources + _preview scaffolding (preview files are throwaway
  // harness wrappers, not shipped UI — re-pointing them adds noise and risk).
  files = files.filter((f) => {
    const rel = path.relative(projectRoot, f).replace(/\\/g, '/');
    if (rel === FLUTTER_RESOURCES_REL) return false;
    if (rel.startsWith('lib/_preview/')) return false;
    return true;
  });
  if (onlyFiles?.length) {
    const want = new Set(onlyFiles.map((f) => path.basename(f)));
    files = files.filter((f) => want.has(path.basename(f)));
  }
  return files.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, out);
    else out.push(abs);
  }
}

interface PathLiteral { value: string; start: number; end: number; quote: string }

/** Find raw `'assets/...'` / `"assets/..."` string literals. Interpolated strings
 *  (`'assets/icons/$x'`) are EXCLUDED — they are dynamic and not 1:1 mappable. */
function findPathLiterals(src: string): PathLiteral[] {
  const out: PathLiteral[] = [];
  const re = /(['"])(assets\/[^'"]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const value = m[2];
    if (value.includes('$')) continue; // interpolated → skip
    out.push({ value, start: m.index, end: m.index + m[0].length, quote: m[1] });
  }
  return out;
}

function replaceFirstLiteral(src: string, lit: PathLiteral, symbol: string): { src: string; changed: boolean } {
  // Re-locate by exact bytes (offsets are valid for the snapshot we scanned, but
  // earlier replacements in the same file shift them — so match the literal text).
  const needle = `${lit.quote}${lit.value}${lit.quote}`;
  const idx = src.indexOf(needle);
  if (idx < 0) return { src, changed: false };
  return { src: src.slice(0, idx) + symbol + src.slice(idx + needle.length), changed: true };
}

interface IconUse {
  /** the Material icon identifier, e.g. `lock_outline`. */
  iconName: string;
  /** true when this is a real `Icon(Icons.X ...)` widget (vs a bare IconData arg). */
  isIconWidget: boolean;
  /** full matched `Icon( ... )` text (widget case only). */
  fullText: string;
  /** named args parsed off the Icon( ... ) (size/color/semanticLabel). */
  args: { size?: string; color?: string; semanticLabel?: string };
}

/**
 * Find Material icon usages. Two forms:
 *  - `Icon(Icons.X, size: .., color: ..)`         → isIconWidget = true
 *  - bare `Icons.X` passed somewhere (param/IconData) → isIconWidget = false
 * Already-rewritten `SvgPicture.asset(...)` / `Image.asset(...)` are not matched
 * (idempotent: this scanner only sees Material `Icon`/`Icons.`).
 */
function findMaterialIconUses(src: string): IconUse[] {
  const out: IconUse[] = [];
  // (1) Icon( ... Icons.X ... ) widgets — balanced to the matching paren. An
  // optional leading `const ` is captured INTO fullText so the rewrite drops it:
  // SvgPicture.asset / Image.asset are NOT const constructors, so leaving a `const`
  // in front would break the build.
  const widgetRe = /(\bconst\s+)?\bIcon\s*\(/g;
  const widgetSpans: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = widgetRe.exec(src))) {
    // The `(\bconst\s+)?` is non-anchored; ensure the `Icon(` is a real widget and
    // not the tail of `IconButton(` / `CupertinoIcon(`. \bIcon\( with the word
    // boundary already excludes `IconButton(`'s outer call; its INNER `Icon(` is
    // matched independently, which is what we want.
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const inner = src.slice(open + 1, close);
    // Span of the FULL Icon(...) call (without the optional leading const), used
    // to suppress form-2 bare matches that live inside this widget.
    widgetSpans.push({ start: open, end: close });
    const iconM = /\bIcons\.([A-Za-z_][A-Za-z0-9_]*)/.exec(inner);
    if (!iconM) continue;
    out.push({
      iconName: iconM[1],
      isIconWidget: true,
      fullText: src.slice(m.index, close + 1),
      args: parseIconArgs(inner),
    });
  }
  // (2) bare Icons.X NOT inside any Icon(...) widget span captured above. These
  // are IconData args (e.g. `icon: Icons.person`) — recorded but never rewritten.
  const bareRe = /\bIcons\.([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = bareRe.exec(src))) {
    const at = m.index;
    const insideWidget = widgetSpans.some((s) => at >= s.start && at <= s.end);
    if (insideWidget) continue;
    out.push({ iconName: m[1], isIconWidget: false, fullText: m[0], args: {} });
  }
  return out;
}

/** Given the index of an opening `(`, return the index of the matching `)`. */
function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '\'' || c === '"') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Pull size/color/semanticLabel off an `Icon(...)` arg list (best-effort, top-level). */
function parseIconArgs(inner: string): IconUse['args'] {
  const args: IconUse['args'] = {};
  const size = /\bsize\s*:\s*([^,)\n]+)/.exec(inner);
  const color = /\bcolor\s*:\s*([^,)\n]+)/.exec(inner);
  const label = /\bsemanticLabel\s*:\s*([^,)\n]+)/.exec(inner);
  if (size) args.size = size[1].trim();
  if (color) args.color = color[1].trim();
  if (label) args.semanticLabel = label[1].trim();
  return args;
}

/** Rewrite a captured `Icon(Icons.X, ...)` widget to SvgPicture.asset / Image.asset,
 *  preserving size (→ width/height), color, and semanticLabel where present. */
function rewriteIconWidget(src: string, use: IconUse, asset: IndexedAsset): { src: string; changed: boolean } {
  const idx = src.indexOf(use.fullText);
  if (idx < 0) return { src, changed: false };

  const symbol = `${FLUTTER_RESOURCES_CLASS}.${asset.symbolKey}`;
  const parts: string[] = [symbol];
  if (asset.format === 'svg') {
    if (use.args.size) { parts.push(`width: ${use.args.size}`); parts.push(`height: ${use.args.size}`); }
    if (use.args.color) parts.push(`colorFilter: ColorFilter.mode(${use.args.color}, BlendMode.srcIn)`);
    if (use.args.semanticLabel) parts.push(`semanticsLabel: ${use.args.semanticLabel}`);
    const replacement = `SvgPicture.asset(${parts.join(', ')})`;
    return { src: src.slice(0, idx) + replacement + src.slice(idx + use.fullText.length), changed: true };
  } else {
    if (use.args.size) { parts.push(`width: ${use.args.size}`); parts.push(`height: ${use.args.size}`); }
    if (use.args.color) parts.push(`color: ${use.args.color}`);
    if (use.args.semanticLabel) parts.push(`semanticLabel: ${use.args.semanticLabel}`);
    const replacement = `Image.asset(${parts.join(', ')})`;
    return { src: src.slice(0, idx) + replacement + src.slice(idx + use.fullText.length), changed: true };
  }
}

// ── icon → asset semantic matching ───────────────────────────────────────────

/**
 * Map a Material icon name to a normalized SEMANTIC token, stripping Material's
 * style suffixes/prefixes (_outline, _rounded, _outlined, _sharp, _new, ios_).
 * `lock_outline` → `lock`, `arrow_back_ios_new` → `arrow_back`.
 */
function iconSemanticTokens(iconName: string): string[] {
  let s = iconName.toLowerCase();
  s = s.replace(/_(outline|outlined|rounded|sharp|new|alt)\b/g, '');
  s = s.replace(/^ios_/, '').replace(/_ios\b/g, '');
  const collapsed = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const tokens = collapsed.split('_').filter(Boolean);
  return tokens;
}

/**
 * Generic UI icons that almost NEVER have an exported brand asset and must be
 * LEFT ALONE — re-pointing a back-chevron to some random ellipse asset is the
 * exact mistake this pass must avoid. (Conservative deny-list.)
 */
const GENERIC_UI_ICONS = new Set([
  'arrow_back', 'arrow_forward', 'arrow_back_ios', 'arrow_forward_ios',
  'chevron_left', 'chevron_right', 'keyboard_arrow_down', 'keyboard_arrow_up',
  'keyboard_arrow_left', 'keyboard_arrow_right', 'expand_more', 'expand_less',
  'close', 'menu', 'more_vert', 'more_horiz', 'add', 'remove', 'check', 'done',
]);

/** Deterministic strong match: does an exported asset's semantic name clearly
 *  correspond to this icon's tokens? Requires the asset name to contain the icon
 *  token(s) (or vice-versa) and the icon to NOT be in the generic deny-list. */
function deterministicIconMatch(iconName: string, index: AssetIndex): IndexedAsset | null {
  const tokens = iconSemanticTokens(iconName);
  if (tokens.length === 0) return null;
  const joined = tokens.join('_');
  if (GENERIC_UI_ICONS.has(joined) || tokens.every((t) => GENERIC_UI_ICONS.has(t))) return null;

  // Only icon-kind assets are valid substitutes for an Icon().
  const candidates = index.assets.filter((a) => a.kind === 'icon');
  const exact = candidates.find((a) => a.name === joined);
  if (exact) return exact;
  // Token-subset match: asset name contains the full icon token sequence.
  const contains = candidates.filter((a) => {
    const an = a.name.toLowerCase();
    return tokens.every((t) => an.split(/_/).includes(t)) && tokens.length > 0;
  });
  // Require an UNAMBIGUOUS single candidate; multiple → defer to AI / skip.
  if (contains.length === 1) return contains[0];
  return null;
}

interface IconMatch { asset: IndexedAsset; how: 'deterministic' | 'ai' }

/** Resolve which exported asset (if any) a Material-icon substitution should
 *  become. Deterministic strong match first; AI only for the ambiguous middle. */
async function matchIconToAsset(
  iconName: string,
  index: AssetIndex,
  opts: RepointOptions,
  projectRoot: string,
): Promise<IconMatch | null> {
  const det = deterministicIconMatch(iconName, index);
  if (det) return { asset: det, how: 'deterministic' };

  // Generic deny-list icons are never AI-matched — they have no asset counterpart.
  const tokens = iconSemanticTokens(iconName);
  const joined = tokens.join('_');
  if (!joined || GENERIC_UI_ICONS.has(joined) || tokens.every((t) => GENERIC_UI_ICONS.has(t))) return null;

  if (opts.noAi || !opts.model || !opts.runModel) return null;

  // AI semantic match: present the icon + the candidate ICON assets (name + a
  // render path the multimodal CLI can open) and ask for the best match index, or
  // "none". Bounded: one JSON call, conservative ("none" when unsure).
  const candidates = index.assets.filter((a) => a.kind === 'icon');
  if (candidates.length === 0) return null;
  const ans = await aiPickAsset(iconName, candidates, opts, projectRoot);
  if (ans == null) return null;
  return { asset: candidates[ans], how: 'ai' };
}

function buildIconMatchPrompt(iconName: string, candidates: IndexedAsset[], projectRoot: string): string {
  const list = candidates.map((a, i) =>
    `  ${i}: name "${a.name}" — file: ${path.join(projectRoot, a.newPath)}`).join('\n');
  return [
    `A Flutter screen uses the Material icon \`Icons.${iconName}\` where it should`,
    'instead use a real EXPORTED brand/SVG asset. Below are the available exported',
    'icon assets (semantic name + the rendered image file — open it to see what it',
    'depicts). Decide which ONE asset this Material icon was a substitution for.',
    '',
    'Be CONSERVATIVE: if NONE of the assets clearly depicts the same thing as the',
    `\`${iconName}\` icon, answer none. A wrong match is worse than no match. A`,
    'generic chevron / back-arrow / close with no brand asset counterpart = none.',
    '',
    'Assets:',
    list,
    '',
    'Reply with STRICT JSON only: {"index": <number>} for a confident match, or',
    '{"index": null} when unsure. No prose, no code fences.',
  ].join('\n');
}

async function aiPickAsset(
  iconName: string,
  candidates: IndexedAsset[],
  opts: RepointOptions,
  projectRoot: string,
): Promise<number | null> {
  try {
    const prompt = buildIconMatchPrompt(iconName, candidates, projectRoot);
    const { text } = await opts.runModel!(opts.model!, prompt, opts.env ?? process.env, projectRoot, { format: 'json' });
    const parsed = parseIndexReply(text);
    if (parsed == null) return null;
    if (parsed < 0 || parsed >= candidates.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseIndexReply(text: string): number | null {
  const tryParse = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(text.trim());
  if (!obj) { const m = text.match(/\{[\s\S]*\}/); if (m) obj = tryParse(m[0]); }
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as any).index;
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// ── imports / fs utils ───────────────────────────────────────────────────────

function ensureImport(src: string, importPath: string): string {
  const line = `import '${importPath}';`;
  if (src.includes(line)) return src;
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (imports.length === 0) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const insertAt = last.index! + last[0].length;
  return src.slice(0, insertAt) + `\n${line}` + src.slice(insertAt);
}

/** Import path for the resources file as seen from a source file. Same-package
 *  files use a relative path (matches 7a's convention for in-lib imports). */
function importPathFor(fromRel: string, targetRel: string): string {
  const fromDir = path.posix.dirname(fromRel.replace(/\\/g, '/'));
  let rel = path.posix.relative(fromDir, targetRel.replace(/\\/g, '/'));
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

async function readFileOrNull(abs: string): Promise<string | null> {
  try { return await fs.readFile(abs, 'utf8'); } catch { return null; }
}

// =============================================================================
// React strategy (seam only — Phase 7c ships flutter; react contract is stubbed)
// =============================================================================

const reactStrategy: AssetUsageStrategy = {
  framework: 'react',
  // TODO(7c-react): scan src/screens|pages for (a) icon-font/lucide/heroicon
  // substitutions that have an exported asset counterpart and (b) raw string
  // asset paths; rewrite to `import { assets } from '../resources/assets'` +
  // <img src={assets.x}/> / an <Svg> component, AI-matching ambiguous icons.
  async repoint() {
    return { repointed: [], skipped: [], warnings: ['react strategy not implemented (7c ships flutter)'] };
  },
};
