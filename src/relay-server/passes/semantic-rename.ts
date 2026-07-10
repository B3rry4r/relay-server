// =============================================================================
// File: src/relay-server/passes/semantic-rename.ts
//
// Phase 7e — File/folder semantic rename + restructure (production-readiness pass).
//
// The per-screen build phase names everything by MACHINE identifiers: files like
// `lib/screens/screen_290_3657.dart`, widget classes like `IPhone1415Pro57Screen`
// (derived from the Figma frame label), route consts like `c2903657`. None of
// that is readable. The canonicalize() pass (.uix/canonical.json) carries the
// REAL human name for each screen (`linkBanksScreen`, `settingsScreen`, …). This
// pass renames the machine identifiers to those canonical semantic names —
// app-wide and consistently — so the shipped code reads like a hand-written app.
//
// For each canonical screen that MAPS to a built file (same convention 7d uses:
// built screens carry a `// canonicalId: c_<frame>` header; the file is
// `screen_<frame>.dart`; the route const is `c<frame>` in app_routes.dart) it:
//   - renames the FILE          screen_290_3657.dart → link_banks_screen.dart
//   - renames the widget CLASS  IPhone1415Pro57Screen → LinkBanksScreen
//     (and its private State class if StatefulWidget)
//   - renames the route CONST   c2903657 → linkBanks   (in app_routes.dart + refs)
//   - rewrites EVERY import, AppRoutes.<const> reference, router case /
//     instantiation, and cross-screen reference across lib/** to match.
//
// This is the RISKIEST pass (it moves files and rewrites imports/router), so it
// is maximally CONSERVATIVE: a screen that does NOT map to a canonical entry is
// LEFT with its machine name (a mixed state beats a guessed/broken rename); all
// matching is WORD-BOUNDARY / exact-identifier (never blind substring — so
// `c2903657` never clobbers `c29036570`, and `IPhone1415Pro57Screen` never
// matches `IPhone1415Pro570Screen`); collisions with an existing symbol are
// detected and skipped; comments are rewritten the same as code (a class name in
// a doc-comment must not be left dangling). The actual find/replace is
// DETERMINISTIC. AI (runModel) is used ONLY to derive/sanity-check a good
// identifier when a canonical name is ambiguous, multi-word, or collides.
//
// FRAMEWORK-AGNOSTIC. detectFramework() (same contract as 7a–7d) dispatches to a
// per-framework `RenameStrategy`. Flutter ships a full implementation; react is a
// stubbed seam so the contract is visible.
//
// IDEMPOTENT: a second run finds every screen already semantic (its file/class/
// route no longer match the machine shape) and applies 0 renames.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AIModel } from '../ai-adapters';
import { deriveSemanticIdentifiers } from '../semantic-names';
import { renameWeb } from './semantic-rename-web';

// ── Public contract ──────────────────────────────────────────────────────────

export type Framework = 'flutter' | 'react' | 'next' | 'unknown';

export interface RenameSemanticOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used ONLY to derive/sanity-check an identifier from a canonical name. */
  model?: AIModel;
  /** Skip AI entirely (deterministic-only). Default false. */
  noAi?: boolean;
  /** Only report what WOULD change; do not write/move anything. Default false. */
  dryRun?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Restrict to canonical screen ids in this set (testing). */
  only?: string[];
  /** Override the root used to read canonical.json (testing). */
  canonicalRoot?: string;
  /** Where to write the report (default <projectRoot>/.uix/semantic-rename-report.json). */
  reportPath?: string;
  /** Skip writing the report file (testing). Default false. */
  noReport?: boolean;
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

/** One screen's old→new rename triple (file/class/route). */
export interface ScreenRename {
  canonicalId: string;
  /** the human canonical name from canonical.json (e.g. `linkBanksScreen`). */
  canonicalName: string;
  oldFile: string;       // relative to root, e.g. lib/screens/screen_290_3657.dart
  newFile: string;       // relative to root, e.g. lib/screens/link_banks_screen.dart
  oldClass: string;      // e.g. IPhone1415Pro57Screen
  newClass: string;      // e.g. LinkBanksScreen
  oldStateClass?: string; // e.g. _IPhone1415Pro57ScreenState (StatefulWidget only)
  newStateClass?: string; // e.g. _LinkBanksScreenState
  oldRouteConst?: string; // e.g. c2903657
  newRouteConst?: string; // e.g. linkBanks
  oldRoutePath?: string;  // e.g. /283-1967   (the URL string the router switches on)
  newRoutePath?: string;  // e.g. /link-banks
  /** how the identifier was derived. */
  identifierHow: 'deterministic' | 'ai-disambiguated';
}

/** A screen that was considered but NOT renamed (and why). */
export interface SkippedScreen {
  canonicalId: string;
  reason: string;
}

export interface RenameSemanticReport {
  version: 1;
  projectId: string;
  framework: Framework;
  generatedAt: string;
  canonicalHash?: string;
  summary: {
    /** canonical screens that mapped to a built file. */
    mappable: number;
    /** screens actually renamed this run. */
    renamed: number;
    /** screens skipped (already semantic, collision, unmapped, etc). */
    skipped: number;
    /** total built screen files in the app. */
    builtScreens: number;
    /** files touched (moved or rewritten). */
    filesTouched: number;
    dryRun: boolean;
  };
  renames: ScreenRename[];
  skipped: SkippedScreen[];
}

export interface RenameSemanticResult {
  report: RenameSemanticReport;
  reportPath: string | null;
  dryRun: boolean;
}

// ── Canonical model (subset we read) ─────────────────────────────────────────

interface CanonScreen { canonicalId: string; name: string; route: string; role?: string; frameIds: string[] }
interface CanonModel {
  projectId?: string;
  contentHash?: string;
  screens?: CanonScreen[];
}

async function readCanonical(root: string): Promise<CanonModel | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.uix', 'canonical.json'), 'utf8');
    return JSON.parse(raw) as CanonModel;
  } catch {
    return null;
  }
}

// ── Framework detection (same contract as 7a–7d) ─────────────────────────────

export async function detectFramework(projectRoot: string): Promise<Framework> {
  const has = async (p: string) => {
    try { await fs.access(path.join(projectRoot, p)); return true; } catch { return false; }
  };
  if (await has('pubspec.yaml')) return 'flutter';
  if (await has('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return 'next';
      if (deps.react) return 'react';
    } catch { /* fall through */ }
  }
  return 'unknown';
}

// ── Per-framework strategy seam ──────────────────────────────────────────────

export interface RenameStrategy {
  framework: Framework;
  rename(
    projectRoot: string,
    screens: CanonScreen[],
    opts: RenameSemanticOptions,
  ): Promise<{ renames: ScreenRename[]; skipped: SkippedScreen[]; builtScreens: number; filesTouched: number }>;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function renameSemantic(projectId: string, opts: RenameSemanticOptions): Promise<RenameSemanticResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  const canonical = await readCanonical(opts.canonicalRoot ?? projectRoot);

  const mkReport = (
    renames: ScreenRename[], skipped: SkippedScreen[], builtScreens: number, filesTouched: number, mappable: number,
  ): RenameSemanticReport => ({
    version: 1,
    projectId,
    framework,
    generatedAt: new Date().toISOString(),
    ...(canonical?.contentHash ? { canonicalHash: canonical.contentHash } : {}),
    summary: {
      mappable,
      renamed: renames.length,
      skipped: skipped.length,
      builtScreens,
      filesTouched,
      dryRun: !!opts.dryRun,
    },
    renames,
    skipped,
  });

  if (!canonical || !Array.isArray(canonical.screens)) {
    const report = mkReport([], [], 0, 0, 0);
    const reportPath = await maybeWriteReport(projectRoot, report, opts);
    return { report, reportPath, dryRun: !!opts.dryRun };
  }

  if (!strategy) {
    const report = mkReport([], canonical.screens.map((s) => ({
      canonicalId: s.canonicalId, reason: `no rename strategy for framework '${framework}'`,
    })), 0, 0, 0);
    const reportPath = await maybeWriteReport(projectRoot, report, opts);
    return { report, reportPath, dryRun: !!opts.dryRun };
  }

  let screens = canonical.screens;
  if (opts.only?.length) screens = screens.filter((s) => opts.only!.includes(s.canonicalId));

  const { renames, skipped, builtScreens, filesTouched } = await strategy.rename(projectRoot, screens, opts);
  // mappable = renames + skips-that-mapped-but-were-not-renamed-for-non-unmapped-reasons.
  const mappable = renames.length + skipped.filter((s) => !/no built|unmapped/i.test(s.reason)).length;

  const report = mkReport(renames, skipped, builtScreens, filesTouched, mappable);
  const reportPath = await maybeWriteReport(projectRoot, report, opts);
  return { report, reportPath, dryRun: !!opts.dryRun };
}

function getStrategy(fw: Framework): RenameStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react' || fw === 'next') return webStrategy(fw);
  return null;
}

async function maybeWriteReport(projectRoot: string, report: RenameSemanticReport, opts: RenameSemanticOptions): Promise<string | null> {
  if (opts.noReport) return null;
  const abs = opts.reportPath ?? path.join(projectRoot, '.uix', 'semantic-rename-report.json');
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');
    return abs;
  } catch {
    return null;
  }
}

// ── Identifier derivation (shared, framework-neutral naming math) ─────────────
// The naming MATH lives in ../semantic-names (the single source of truth shared
// with the skeleton). `deriveIdentifiers` (below) delegates to it; the only thing
// kept local is the exported `tokenizeName` (used by tests + the AI seam).

/** Split a human/camel/snake name into lowercase word tokens. */
export function tokenizeName(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase boundary
    .replace(/[_\-]+/g, ' ')                     // snake / kebab
    .replace(/[^A-Za-z0-9 ]+/g, ' ')             // strip punctuation
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Derived semantic identifiers for one screen from its canonical name. */
export interface DerivedIdentifiers {
  fileBase: string;   // link_banks_screen        (no extension)
  className: string;  // LinkBanksScreen
  routeConst: string; // linkBanks
  routePath: string;  // /link-banks
}

/** Deterministically derive identifiers from the canonical name. Pure — no IO.
 *  Delegates to the SHARED semantic-name math so the safety-net pass derives the
 *  EXACT SAME names the skeleton does (machine/frame-code names fall back to
 *  `screen`, with the caller's collision suffixing). */
export function deriveIdentifiers(canonicalName: string, suffixTokens: string[] = []): DerivedIdentifiers {
  const ids = deriveSemanticIdentifiers(canonicalName, suffixTokens);
  return { fileBase: ids.fileBase, className: ids.className, routeConst: ids.routeConst, routePath: ids.routePath };
}

// =============================================================================
// Flutter strategy
// =============================================================================

interface BuiltScreen {
  canonicalId: string;          // from header (c_<frame>)
  file: string;                 // absolute
  rel: string;                  // relative to root
  base: string;                 // basename, e.g. screen_290_3657.dart
  widgetClass: string;          // top-level Screen class, e.g. IPhone1415Pro57Screen
  stateClass: string | null;    // _IPhone...ScreenState if StatefulWidget
  route: string | null;         // header route string
}

const flutterStrategy: RenameStrategy = {
  framework: 'flutter',
  async rename(projectRoot, screens, opts) {
    return renameFlutter(projectRoot, screens, opts);
  },
};

async function renameFlutter(
  projectRoot: string,
  screens: CanonScreen[],
  opts: RenameSemanticOptions,
): Promise<{ renames: ScreenRename[]; skipped: SkippedScreen[]; builtScreens: number; filesTouched: number }> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');

  // Index every built screen file by header canonicalId core.
  const builtById = new Map<string, BuiltScreen>();
  let files: string[] = [];
  try { files = (await fs.readdir(screensDir)).filter((f) => f.endsWith('.dart')); } catch { /* none */ }
  for (const f of files) {
    const abs = path.join(screensDir, f);
    const src = await fs.readFile(abs, 'utf8');
    const hm = /^\/\/\s*canonicalId:\s*(\S+)(?:\s+route:\s*(\S+))?/m.exec(src);
    const cls = topLevelScreenClass(src);
    if (!cls) continue;
    const headerId = hm?.[1] ?? '';
    const route = hm?.[2] ?? null;
    const stateClass = stateClassFor(src, cls);
    if (headerId) {
      builtById.set(idCore(headerId), {
        canonicalId: headerId, file: abs, rel: rel(projectRoot, abs), base: f,
        widgetClass: cls, stateClass, route,
      });
    }
  }

  // Route table: const → route + reverse, to find each screen's route const.
  const { constToRoute, routeToConst } = await readRouteTable(projectRoot);

  // The complete set of identifiers that ALREADY exist (for collision checks):
  // every built widget/state class name + every route const name.
  const existingClasses = new Set<string>();
  for (const b of builtById.values()) {
    existingClasses.add(b.widgetClass);
    if (b.stateClass) existingClasses.add(b.stateClass);
  }
  const existingRouteConsts = new Set<string>(constToRoute.keys());

  // Plan a rename for each mappable canonical screen. We PLAN ALL renames first
  // (so collisions are computed against the full target set), then APPLY.
  const renames: ScreenRename[] = [];
  const skipped: SkippedScreen[] = [];

  // Reserve target identifiers as we plan, so two canonical screens that derive
  // the same name (e.g. two "Settings") don't both grab it.
  const claimedClasses = new Set<string>();
  const claimedFiles = new Set<string>();
  const claimedConsts = new Set<string>();

  for (const screen of screens) {
    const built = builtById.get(idCore(screen.canonicalId));
    if (!built) {
      skipped.push({ canonicalId: screen.canonicalId, reason: 'no built screen file (unmapped — canonical refers to a frame the build does not contain)' });
      continue;
    }

    // Derive deterministic identifiers from the canonical name.
    let ids = deriveIdentifiers(screen.name);
    let identifierHow: ScreenRename['identifierHow'] = 'deterministic';

    // Detect a derivation collision: the target class/const/file already exists
    // on a DIFFERENT screen, or was already claimed by an earlier plan. If so,
    // try to disambiguate (AI when available; deterministic suffix otherwise).
    const collides = (i: DerivedIdentifiers): string | null => {
      const newBase = `${i.fileBase}.dart`;
      // Allow the screen to keep its OWN already-semantic identifiers (idempotence):
      const isOwnClass = i.className === built.widgetClass;
      const isOwnFile = newBase === built.base;
      if (!isOwnClass && (existingClasses.has(i.className) || claimedClasses.has(i.className))) return `class ${i.className}`;
      if (!isOwnFile && (claimedFiles.has(newBase) || files.includes(newBase))) return `file ${newBase}`;
      if (existingRouteConsts.has(i.routeConst) || claimedConsts.has(i.routeConst)) {
        // The route const may legitimately be this screen's own const if already renamed.
        const ownConst = built.route ? routeToConst.get(built.route) : undefined;
        if (i.routeConst !== ownConst) return `route const ${i.routeConst}`;
      }
      return null;
    };

    const collision = collides(ids);
    if (collision) {
      // The screen's OWN current identifiers are NOT "taken" against itself — the
      // skeleton may have already given it a valid collision-suffixed semantic name
      // (LoginScreen → Login2Screen); the deterministic fallback should REUSE that
      // suffix, not bump past it to Login3Screen. Exclude its own class/state class.
      const taken = [...existingClasses, ...claimedClasses].filter(
        (c) => c !== built.widgetClass && c !== built.stateClass,
      );
      const disamb = await disambiguate(screen, ids, collision, taken, opts);
      if (disamb && !collides(disamb)) {
        ids = disamb;
        identifierHow = 'ai-disambiguated';
      } else {
        skipped.push({ canonicalId: screen.canonicalId, reason: `identifier collision (${collision}) could not be safely disambiguated — left machine name` });
        continue;
      }
    }

    // IDEMPOTENCE: if the screen ALREADY carries the semantic file + class + route
    // const + route PATH, skip. The old route PATH is the screen's header route (or
    // the const's mapped path); the new one is the derived semantic path.
    const newBase = `${ids.fileBase}.dart`;
    const oldRouteConst = built.route ? routeToConst.get(built.route) ?? undefined : undefined;
    const oldRoutePath = built.route ?? (oldRouteConst ? constToRoute.get(oldRouteConst) : undefined);
    const pathNeedsRewrite = !!oldRoutePath && oldRoutePath !== ids.routePath;
    const alreadySemantic =
      built.base === newBase &&
      built.widgetClass === ids.className &&
      (!oldRouteConst || oldRouteConst === ids.routeConst) &&
      !pathNeedsRewrite;
    if (alreadySemantic) {
      skipped.push({ canonicalId: screen.canonicalId, reason: 'already semantic (file/class/route/path match canonical) — nothing to rename' });
      continue;
    }

    const plan: ScreenRename = {
      canonicalId: screen.canonicalId,
      canonicalName: screen.name,
      oldFile: built.rel,
      newFile: path.join('lib', 'screens', newBase),
      oldClass: built.widgetClass,
      newClass: ids.className,
      ...(built.stateClass ? { oldStateClass: built.stateClass, newStateClass: stateClassFromWidget(ids.className) } : {}),
      ...(oldRouteConst ? { oldRouteConst, newRouteConst: ids.routeConst } : {}),
      ...(pathNeedsRewrite ? { oldRoutePath, newRoutePath: ids.routePath } : {}),
      identifierHow,
    };
    renames.push(plan);
    claimedClasses.add(ids.className);
    claimedFiles.add(newBase);
    claimedConsts.add(ids.routeConst);
  }

  if (opts.dryRun) {
    return { renames, skipped, builtScreens: builtById.size, filesTouched: 0 };
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  // Gather EVERY .dart file under lib/** (screens, components, _preview, router,
  // routes, widgets, theme) AND test/** — both are part of the app source the
  // analyzer checks, so a renamed screen referenced from a test (e.g. the 7a
  // render-tree test) must be rewritten too or we'd leave a NEW analyze break.
  const allDart = [
    ...(await listDartFiles(path.join(projectRoot, 'lib'))),
    ...(await listDartFiles(path.join(projectRoot, 'test'))),
  ];
  // In-memory content cache so multiple renames compose on the same file.
  const contents = new Map<string, string>();
  for (const f of allDart) contents.set(f, await fs.readFile(f, 'utf8'));

  // Track file moves: oldAbs → newAbs (applied at the very end after rewrites).
  const moves: Array<{ from: string; to: string }> = [];

  for (const r of renames) {
    const oldAbs = path.join(projectRoot, r.oldFile);
    const newAbs = path.join(projectRoot, r.newFile);

    // 1) Identifier replacements applied to every file's content (word-boundary).
    for (const [file, src] of contents) {
      let next = src;
      next = replaceIdentifier(next, r.oldClass, r.newClass);
      if (r.oldStateClass && r.newStateClass) next = replaceIdentifier(next, r.oldStateClass, r.newStateClass);
      if (r.oldRouteConst && r.newRouteConst) next = replaceIdentifier(next, r.oldRouteConst, r.newRouteConst);
      // 1b) Rewrite the route PATH string LITERAL ('/283-1967' → '/link-banks') —
      // the const NAME rewrite above does not touch the VALUE. Whole-quoted-literal
      // only (route paths are unique), so it never clobbers a substring elsewhere.
      if (r.oldRoutePath && r.newRoutePath) next = replaceQuotedLiteral(next, r.oldRoutePath, r.newRoutePath);
      // 2) Rewrite import/path references to the moved file (basename-level).
      next = rewriteImportPath(next, path.basename(r.oldFile), path.basename(r.newFile));
      if (next !== src) contents.set(file, next);
    }

    moves.push({ from: oldAbs, to: newAbs });
  }

  // Write the (possibly rewritten) content back to its CURRENT path first.
  let filesTouched = 0;
  const dirty = new Set<string>();
  for (const r of renames) dirty.add(path.join(projectRoot, r.oldFile));
  for (const [file, src] of contents) {
    const original = await fs.readFile(file, 'utf8');
    if (original !== src) { await fs.writeFile(file, src, 'utf8'); filesTouched++; }
  }

  // Now move the renamed files to their new basenames.
  for (const m of moves) {
    // Guard: don't clobber a different existing file.
    if (m.from !== m.to) {
      try { await fs.rename(m.from, m.to); filesTouched++; } catch {
        // If rename failed (e.g. target exists), copy+unlink as a fallback only
        // when target does not already exist.
      }
    }
  }
  // dirty set retained for clarity; filesTouched is the authoritative count.
  void dirty;

  return { renames, skipped, builtScreens: builtById.size, filesTouched };
}

// ── route table parsing ──────────────────────────────────────────────────────

async function readRouteTable(projectRoot: string): Promise<{ constToRoute: Map<string, string>; routeToConst: Map<string, string> }> {
  const constToRoute = new Map<string, string>();
  const routeToConst = new Map<string, string>();
  try {
    const src = await fs.readFile(path.join(projectRoot, 'lib', 'app_routes.dart'), 'utf8');
    const re = /static\s+const\s+String\s+([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      constToRoute.set(m[1], m[2]);
      // The `entry` alias points at another route's string; keep the specific one.
      if (!routeToConst.has(m[2]) || m[1] !== 'entry') {
        if (m[1] !== 'entry') routeToConst.set(m[2], m[1]);
        else if (!routeToConst.has(m[2])) routeToConst.set(m[2], m[1]);
      }
    }
  } catch { /* no route table */ }
  return { constToRoute, routeToConst };
}

// ── identifier / import rewriting (word-boundary, never blind substring) ──────

/**
 * Replace EXACT identifier `oldId` with `newId` everywhere in `src`, honouring
 * Dart identifier boundaries: a match must not be preceded or followed by an
 * identifier char (so `c2903657` never matches inside `c29036570`, and
 * `IPhone1415Pro57Screen` never matches `IPhone1415Pro570Screen`). This rewrites
 * code AND comments uniformly (a class name in a doc-comment must move too).
 */
export function replaceIdentifier(src: string, oldId: string, newId: string): string {
  if (!oldId || oldId === newId) return src;
  const re = new RegExp(`(^|[^A-Za-z0-9_$])(${escapeRe(oldId)})(?![A-Za-z0-9_$])`, 'g');
  return src.replace(re, (_m, pre: string) => `${pre}${newId}`);
}

/**
 * Rewrite import/path references from `oldBase` to `newBase`. We match the file
 * basename inside a quoted path segment (preceded by `/` or quote, ending the
 * quoted path), covering `import '../screens/screen_290_3657.dart';`,
 * `import 'screens/screen_290_3657.dart';`, and `-t lib/_preview/...` mentions
 * inside comments. Basename-exact (won't touch a longer basename).
 */
export function rewriteImportPath(src: string, oldBase: string, newBase: string): string {
  if (!oldBase || oldBase === newBase) return src;
  // Preceded by a path separator or quote; followed by a quote, whitespace, or EOL.
  const re = new RegExp(`([/'"\`])(${escapeRe(oldBase)})(?=['"\`\\s]|$)`, 'g');
  return src.replace(re, (_m, pre: string) => `${pre}${newBase}`);
}

/**
 * Replace a WHOLE quoted string literal `oldVal` → `newVal` (single OR double
 * quote), matching only when the ENTIRE quoted contents equal `oldVal` — so a
 * route path `/283-1967` is rewritten in `'/283-1967'` but never inside a longer
 * string. Used for route-PATH literals in app_routes.dart + Navigator calls.
 */
export function replaceQuotedLiteral(src: string, oldVal: string, newVal: string): string {
  if (!oldVal || oldVal === newVal) return src;
  const re = new RegExp(`(['"])(${escapeRe(oldVal)})\\1`, 'g');
  return src.replace(re, (_m, q: string) => `${q}${newVal}${q}`);
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── AI disambiguation seam (identifier derivation ONLY) ───────────────────────

/**
 * Ask the model for an alternative identifier base when the deterministic name
 * collides. AI ONLY proposes a name (e.g. "accountSettings" for a second
 * "Settings" screen); the actual rename stays deterministic. Falls back to a
 * deterministic numbered suffix when AI is unavailable or its proposal is unsafe.
 */
async function disambiguate(
  screen: CanonScreen,
  base: DerivedIdentifiers,
  collision: string,
  taken: string[],
  opts: RenameSemanticOptions,
): Promise<DerivedIdentifiers | null> {
  // Try AI first (only when allowed and available).
  if (opts.model && opts.runModel && !opts.noAi) {
    const proposal = await aiProposeName(screen, collision, taken, opts);
    if (proposal) {
      const ids = deriveIdentifiers(proposal);
      // Trust AI only if the proposed identifiers are valid Dart and distinct.
      if (isValidDartClassBase(ids.className) && !taken.includes(ids.className)) return ids;
    }
  }
  // Deterministic fallback: append an incrementing NUMBER (NOT the frame core —
  // that would reintroduce a machine name). Try -2, -3, … until the class is free.
  // Uses the SHARED derivation so file/class/const/path stay in sync + semantic.
  const takenSet = new Set(taken);
  for (let n = 2; n < 1000; n++) {
    const ids = deriveIdentifiers(screen.name, [String(n)]);
    if (!takenSet.has(ids.className)) return ids;
  }
  return deriveIdentifiers(screen.name, ['x']);
}

async function aiProposeName(
  screen: CanonScreen,
  collision: string,
  taken: string[],
  opts: RenameSemanticOptions,
): Promise<string | null> {
  if (!opts.model || !opts.runModel) return null;
  const prompt = [
    `A Flutter screen needs a unique, human-readable name. Its canonical name is`,
    `"${screen.name}" but the derived identifier collides with an existing one (${collision}).`,
    `Propose a SHORT, distinct, descriptive name (2-4 words, e.g. "Account Settings",`,
    `"Link Bank") that disambiguates THIS screen. It must NOT collide with any of:`,
    taken.slice(0, 60).join(', ') || '(none)',
    ``,
    `Reply with EXACTLY one JSON object, no prose:`,
    `{"name":"<short human name>"}`,
  ].join('\n');
  // AI is a COLLISION DISAMBIGUATOR over a deterministic name (canonical name →
  // identifier). Not an AI-PURPOSE step. On failure: conservative no-op (fall
  // back to deterministic numeric disambiguation by the caller), but LOGGED
  // (RFC §0.1 — not silent).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.log('[ai:rename-disambig] status=empty — no JSON; using deterministic name'); return null; } // eslint-disable-line no-console
    const name = (JSON.parse(m[0]) as { name?: string }).name;
    return name && name.trim() ? name.trim() : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[ai:rename-disambig] status=error — ${(e as Error).message.slice(0, 80)}; using deterministic name`);
    return null;
  }
}

function isValidDartClassBase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

// ── Dart utilities ────────────────────────────────────────────────────────────

function idCore(id: string): string {
  return String(id).replace(/^[cm]_/, '');
}

/** The top-level Screen widget class (Stateless OR Stateful). */
function topLevelScreenClass(src: string): string | null {
  const m = /^class\s+([A-Za-z_][A-Za-z0-9_]*Screen)\s+extends\s+State(?:less|ful)Widget\b/m.exec(src);
  return m ? m[1] : null;
}

/** The private State class for a StatefulWidget Screen, if present. */
function stateClassFor(src: string, widgetClass: string): string | null {
  // class _FooScreenState extends State<FooScreen>
  const re = new RegExp(`class\\s+(_[A-Za-z0-9_]+)\\s+extends\\s+State<${escapeRe(widgetClass)}>`, 'm');
  const m = re.exec(src);
  if (m) return m[1];
  // Also accept `createState() => _FooScreenState()` shape.
  const cs = new RegExp(`createState\\(\\)\\s*=>\\s*(_[A-Za-z0-9_]+)\\(\\)`, 'm').exec(src);
  return cs ? cs[1] : null;
}

/** Derive the State class name for a new widget class: `LinkBanksScreen` →
 *  `_LinkBanksScreenState` (the standard Flutter convention). */
function stateClassFromWidget(widgetClass: string): string {
  return `_${widgetClass}State`;
}

async function listDartFiles(dir: string): Promise<string[]> {
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
  await walk(dir);
  return out;
}

function rel(root: string, abs: string): string { return path.relative(root, abs); }

// =============================================================================
// React strategy (seam only — Phase 7e ships flutter; react contract is stubbed)
// =============================================================================

const webStrategy = (framework: Framework): RenameStrategy => ({
  framework,
  async rename(projectRoot, screens, opts) {
    const r = await renameWeb(
      projectRoot,
      screens.map((s) => ({ canonicalId: s.canonicalId, name: s.name, route: s.route, frameIds: s.frameIds })),
      { dryRun: opts.dryRun, only: opts.only },
    );
    return {
      renames: r.renames.map((x) => ({
        canonicalId: x.canonicalId,
        canonicalName: x.canonicalName,
        oldFile: x.file,
        newFile: x.file,
        oldClass: '',
        newClass: '',
        ...(x.routeConst ? { oldRouteConst: x.routeConst, newRouteConst: x.routeConst } : {}),
        oldRoutePath: x.oldRoutePath,
        newRoutePath: x.newRoutePath,
        identifierHow: 'deterministic' as const,
      })),
      skipped: r.skipped,
      builtScreens: r.builtScreens,
      filesTouched: r.filesTouched,
    };
  },
});

