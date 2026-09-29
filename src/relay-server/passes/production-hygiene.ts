/**
 * production-hygiene.ts — Phase 7h: make the finalized build a clean deliverable.
 *
 * The pipeline emits verify scaffolding into the shipped source: a `/_preview/<id>`
 * route per screen and a `*Preview.tsx` beside each screen, plus a `PlaceholderScreen`
 * mounted at any route a real screen never claimed. Verify needs them — it serves the
 * production `vite build` and screenshots `/_preview/<id>`. But a frontend team handed
 * this repo should not find internal QA routes live in their bundle.
 *
 * Finalize runs AFTER verification, and it is safe to strip here: a later requeue
 * rebuilds a screen through `ensureScreenPreviewEntry`, which re-creates exactly the
 * preview that screen needs, and finalize strips again. The operation is idempotent —
 * a clean app yields zero removals.
 *
 * Per framework:
 *   - react: the `/_preview` `<Route>` lines + `*Preview` modules + src/_preview, and
 *     `<Route element={<PlaceholderScreen/>}>` lines;
 *   - next: the `app/%5Fpreview` (and private `app/_preview`) route dirs, and
 *     header-less pages that only mount `<PlaceholderScreen>` (the route IS the dir);
 *   - flutter: lib/_preview.
 * Every strategy then REPORTS unreferenced asset symbols (resources module / AppAssets),
 * flagging computed-key access.
 *
 * Scope is deliberately narrow and reversible-by-regeneration: preview routes,
 * preview imports, preview files, and PlaceholderScreen. It does NOT delete asset
 * files — an asset reached only through `assets[computedKey]` looks unreferenced to
 * a static scan, and deleting it would break an image verify already approved. Those
 * are reported, not removed.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { detectFramework, type Framework } from './framework';
import {
  loadWebApp, listSourceFiles, listWebSources, stillReferenced, readHeader, nextAppRoute,
  isPlaceholderOnlyPage, sourceLinksTo, type WebAppIndex,
} from './web-app';

export interface HygieneResult {
  framework: Framework;
  previewRoutesRemoved: number;
  previewFilesRemoved: number;
  placeholderRemoved: boolean;
  unreferencedAssets: number;
  warnings: string[];
  dryRun: boolean;
  /** Source files / scaffolding entries examined. 0 = examined nothing. */
  filesScanned: number;
  /** Set when the pass had no input / no support — finalize records `skipped` with it. */
  skippedReason?: string;
}

export interface HygieneOptions { projectRoot: string; dryRun?: boolean }

/** Drop `import … from '…Preview'` and `import { PlaceholderScreen } …` lines. */
function stripImports(src: string, predicate: (spec: string, names: string) => boolean): string {
  return src.replace(/^import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"];?\s*$\n?/gm,
    (full, _def: string, names: string, spec: string) => (predicate(spec, names ?? '') ? '' : full));
}

/** Remove every `<Route path="/_preview/…" … />` line. The skeleton emits one
 *  preview route per line, so a line-based strip is robust where a span regex trips
 *  on the nested `<XPreview />` inside `element={…}`. */
function stripPreviewRoutes(src: string): { src: string; count: number } {
  let count = 0;
  const out = src
    .split('\n')
    .filter((line) => {
      const isPreview = /<Route\s+path=["'`]\/_preview\//.test(line);
      if (isPreview) count++;
      return !isPreview;
    })
    .join('\n');
  return { src: out, count };
}

/** Remove `<Route … element={<PlaceholderScreen … />} … />` lines. */
function stripPlaceholderRouteLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/<Route\b[^\n]*PlaceholderScreen/.test(line))
    .join('\n');
}

async function hygieneWeb(projectRoot: string, dryRun: boolean): Promise<HygieneResult> {
  const warnings: string[] = [];
  const ix = await loadWebApp(projectRoot);
  const result: HygieneResult = {
    framework: 'react', previewRoutesRemoved: 0, previewFilesRemoved: 0,
    placeholderRemoved: false, unreferencedAssets: 0, warnings, dryRun, filesScanned: 0,
  };
  if (ix?.kind === 'next') return hygieneNext(ix, dryRun, result);
  if (!ix || !ix.routerFile) {
    warnings.push('no react-router App.tsx to clean');
    result.skippedReason = 'no react-router App.tsx to clean';
    return result;
  }

  // ── App.tsx: strip preview routes, preview imports, PlaceholderScreen ────────
  let app = await fs.readFile(ix.routerFile, 'utf-8');
  const before = app;

  const stripped = stripPreviewRoutes(app);
  app = stripped.src;
  result.previewRoutesRemoved = stripped.count;

  // PlaceholderScreen: its route(s), then its import once unreferenced.
  const hadPlaceholder = /\bPlaceholderScreen\b/.test(app);
  app = stripPlaceholderRouteLines(app);

  // Drop imports of any *Preview module and of PlaceholderScreen once unused.
  app = stripImports(app, (spec, names) => {
    if (/Preview$/.test(spec)) return true;
    if (/\bPlaceholderScreen\b/.test(names) && !stillReferenced(app, 'PlaceholderScreen')) return true;
    return false;
  });
  result.placeholderRemoved = hadPlaceholder && !/\bPlaceholderScreen\b/.test(app);
  app = app.replace(/\n{3,}/g, '\n\n');

  if (app !== before && !dryRun) await fs.writeFile(ix.routerFile, app, 'utf-8');

  // ── Delete the preview + placeholder source files ───────────────────────────
  const files = await listSourceFiles(ix.srcDir);
  result.filesScanned = files.length;
  const deleted = new Set<string>();
  for (const f of files) {
    if (/Preview\.(tsx|jsx)$/.test(f)) {
      result.previewFilesRemoved++;
      deleted.add(f);
      if (!dryRun) await fs.rm(f, { force: true }).catch(() => {});
    }
  }
  // The web skeleton's modal verify harness lives in src/_preview/ (never walked by
  // listSourceFiles, like lib/_preview on Flutter). Its routes + imports were just
  // stripped from App.tsx, so the directory is dead code: remove it whole.
  const harnessDir = path.join(ix.pipelineRoot, '_preview');
  if (fsSync.existsSync(harnessDir)) {
    const harness = await fs.readdir(harnessDir).catch(() => [] as string[]);
    result.previewFilesRemoved += harness.length;
    result.filesScanned += harness.length;
    if (!dryRun) await fs.rm(harnessDir, { recursive: true, force: true }).catch(() => {});
  }
  // The PlaceholderScreen module goes only when nothing still imports it: a screen
  // the build never replaced is still the skeleton's stub, which renders it — deleting
  // the module under it breaks the build (the gate would revert the whole pass).
  result.previewFilesRemoved += await removeUnusedPlaceholderModule(ix, files, deleted, { [ix.routerFile]: app }, dryRun, warnings);

  // ── Report (never delete) unreferenced asset symbols ────────────────────────
  result.unreferencedAssets = await countUnreferencedAssets(ix, ix.resourcesFile, warnings);

  return result;
}

/** Next App Router strategy (PG-25). There is no route table: a route IS a directory,
 *  so hygiene removes directories.
 *   - verify routes: `app/%5Fpreview/**` (served at `/_preview/<frame>`) and any
 *     `app/_preview/**` (a private folder Next never routes — still verify-only code);
 *   - placeholder-only pages: a `page.tsx` whose only element is `<PlaceholderScreen>`
 *     and that carries no canonical header (the react analogue is a
 *     `<Route element={<PlaceholderScreen/>}>` line, which the react strategy strips).
 *     A header-stamped skeleton stub is a canonical screen's slot the build has not
 *     filled yet — it stays, exactly like react keeps the stub component it routes to.
 *     A removed page that source still links to is REPORTED (the link now 404s; 7d
 *     already grades that edge `missing` and requeues its FROM screen).
 *  Then unreferenced assets are reported exactly as on react. */
async function hygieneNext(ix: WebAppIndex, dryRun: boolean, result: HygieneResult): Promise<HygieneResult> {
  const warnings = result.warnings;
  const routerDir = ix.appDir ?? ix.pagesDir;
  if (!routerDir) {
    result.skippedReason = 'no Next app/ or pages/ directory — nothing routable to clean';
    return result;
  }
  const rel = (p: string): string => path.relative(ix.projectRoot, p).split(path.sep).join('/');
  const all = await listWebSources(ix);   // previews are never listed here
  result.filesScanned = all.length;
  const deleted = new Set<string>();

  // 1. Verify-harness route dirs.
  const previewDirs = (await fs.readdir(routerDir, { withFileTypes: true }).catch(() => [] as fsSync.Dirent[]))
    .filter((e) => e.isDirectory() && /^(_preview|%5Fpreview)$/i.test(e.name))
    .map((e) => path.join(routerDir, e.name));
  for (const d of previewDirs) {
    const files = await listAllFiles(d);
    result.previewFilesRemoved += files.length;
    result.previewRoutesRemoved += files.filter((f) => /^page\.(tsx|jsx|ts|js)$/.test(path.basename(f))).length;
    result.filesScanned += files.length;
    if (!dryRun) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }

  // 2. Placeholder-only pages (no canonical header).
  const sources = new Map<string, string>();
  for (const f of all) sources.set(f, await fs.readFile(f, 'utf-8').catch(() => ''));
  const pageRe = /^page\.(tsx|jsx|ts|js)$/;
  for (const [f, src] of sources) {
    if (!pageRe.test(path.basename(f)) || !isInside(routerDir, f)) continue;
    if (readHeader(src) || !isPlaceholderOnlyPage(src)) continue;
    const route = ix.appDir && isInside(ix.appDir, f) ? nextAppRoute(ix.appDir, f) : null;
    const linkers = route ? [...sources].filter(([g, s]) => g !== f && sourceLinksTo(s, route, ix.routeToConst.get(route) ?? null)).map(([g]) => rel(g)) : [];
    if (linkers.length) warnings.push(`removed placeholder-only page ${rel(f)} (${route}) — still linked from ${linkers.join(', ')}; that link now 404s until the screen is built (7d reports the edge)`);
    result.previewRoutesRemoved++;
    result.placeholderRemoved = true;
    deleted.add(f);
    if (!dryRun) {
      // Remove the page and its route dir when nothing else lives there (a layout,
      // loading.tsx or nested routes keep the dir).
      await fs.rm(f, { force: true }).catch(() => {});
      await removeEmptyDirsUpTo(path.dirname(f), routerDir);
    }
  }

  result.previewFilesRemoved += await removeUnusedPlaceholderModule(ix, all, deleted, {}, dryRun, warnings);
  result.unreferencedAssets = await countUnreferencedAssets(ix, ix.resourcesFile, warnings);
  return result;
}

const isInside = (dir: string, f: string): boolean => f === dir || f.startsWith(dir + path.sep);

async function listAllFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as fsSync.Dirent[])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listAllFiles(p, out); else out.push(p);
  }
  return out;
}

async function removeEmptyDirsUpTo(dir: string, stop: string): Promise<void> {
  let d = dir;
  while (d !== stop && isInside(stop, d)) {
    const left = await fs.readdir(d).catch(() => ['?']);
    if (left.length) return;
    await fs.rmdir(d).catch(() => {});
    d = path.dirname(d);
  }
}

/** Delete `PlaceholderScreen.(tsx|jsx)` when no surviving source file imports it.
 *  `overrides` carries files rewritten in this pass (react's App.tsx) whose on-disk
 *  copy is stale during a dry run. Returns the number of files removed. */
async function removeUnusedPlaceholderModule(
  ix: Pick<WebAppIndex, 'sourceRoots' | 'projectRoot'>, scanned: string[], deleted: Set<string>,
  overrides: Record<string, string>, dryRun: boolean, warnings: string[],
): Promise<number> {
  const all = await listWebSources(ix);
  const mods = [...new Set([...scanned, ...all])].filter((f) => /(^|[/\\])PlaceholderScreen\.(tsx|jsx)$/.test(f));
  let removed = 0;
  for (const mod of mods) {
    const users: string[] = [];
    for (const f of all) {
      if (f === mod || deleted.has(f)) continue;
      const src = overrides[f] ?? await fs.readFile(f, 'utf-8').catch(() => '');
      if (/\bPlaceholderScreen\b/.test(src.replace(/^import\s.*$/gm, ''))) users.push(path.relative(ix.projectRoot, f).split(path.sep).join('/'));
    }
    if (users.length) {
      warnings.push(`kept ${path.relative(ix.projectRoot, mod).split(path.sep).join('/')}: still rendered by ${users.length} un-built screen stub(s) (${users.slice(0, 4).join(', ')})`);
      continue;
    }
    removed++;
    if (!dryRun) await fs.rm(mod, { force: true }).catch(() => {});
  }
  return removed;
}

/** Count declared asset symbols with no static reference. Reported only: a symbol
 *  reached via `assets[computedKey]` is invisible to this scan, so deleting on its
 *  say-so would break a runtime image. When any dynamic access exists we say so and
 *  do not even imply the count is prunable. */
async function countUnreferencedAssets(
  ix: Pick<WebAppIndex, 'sourceRoots'>, resourcesFile: string | null, warnings: string[],
): Promise<number> {
  if (!resourcesFile || !fsSync.existsSync(resourcesFile)) {
    // No resources module on disk — but a screen that still reads `assets[key]` from
    // one is exactly what an operator must hear about (its import cannot resolve).
    const dyn: string[] = [];
    for (const f of await listWebSources(ix)) {
      const s = await fs.readFile(f, 'utf-8').catch(() => '');
      if (/\bassets\s*\[\s*[^'"\]]/.test(s)) dyn.push(path.basename(path.dirname(f)) + '/' + path.basename(f));
    }
    if (dyn.length) {
      warnings.push(`no resources module found, yet ${dyn.length} file(s) read assets by computed key (assets[…]: ${dyn.slice(0, 4).join(', ')}) — asset usage could not be reviewed and those imports do not resolve; review before shipping.`);
    }
    return 0;
  }
  const decl = [...fsSync.readFileSync(resourcesFile, 'utf-8').matchAll(/^\s*([A-Za-z0-9_$]+)\s*:/gm)].map((m) => m[1]);
  if (decl.length === 0) return 0;

  let code = '';
  let dynamic = false;
  for (const f of await listWebSources(ix)) {
    if (f === resourcesFile) continue;
    const s = await fs.readFile(f, 'utf-8').catch(() => '');
    code += s + '\n';
    if (/\bassets\s*\[\s*[^'"\]]/.test(s)) dynamic = true;   // assets[<non-literal>]
  }
  const used = new Set<string>();
  for (const m of code.matchAll(/\bassets\s*\.\s*([A-Za-z0-9_$]+)/g)) used.add(m[1]);
  for (const m of code.matchAll(/\bname\s*=\s*\{?["']([A-Za-z0-9_$]+)["']/g)) if (decl.includes(m[1])) used.add(m[1]);

  const unref = decl.filter((d) => !used.has(d));
  if (unref.length) {
    warnings.push(
      `${unref.length}/${decl.length} exported asset symbols are not statically referenced`
      + (dynamic
        ? ' — but the app reads assets by computed key (assets[…]), so these are NOT safe to prune automatically; review before removing.'
        : ' — no dynamic assets[…] access found, so these are safe to prune (kept anyway; deletion is out of scope for this pass).'),
    );
  }
  return unref.length;
}

async function hygieneFlutter(projectRoot: string, dryRun: boolean): Promise<HygieneResult> {
  const warnings: string[] = [];
  const result: HygieneResult = {
    framework: 'flutter', previewRoutesRemoved: 0, previewFilesRemoved: 0,
    placeholderRemoved: false, unreferencedAssets: 0, warnings, dryRun, filesScanned: 0,
  };
  const previewDir = path.join(projectRoot, 'lib', '_preview');
  const hadPreview = fsSync.existsSync(previewDir);
  if (hadPreview) {
    const entries = await fs.readdir(previewDir).catch(() => []);
    result.previewFilesRemoved = entries.length;
    result.filesScanned = entries.length;
    if (!dryRun) await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
  }
  // Report (never delete) AppAssets symbols with no static reference (PG-26) — the
  // same review the web strategy gives its resources module.
  const assets = await countUnreferencedDartAssets(projectRoot, warnings);
  result.unreferencedAssets = assets.unreferenced;
  result.filesScanned += assets.filesScanned;
  if (!hadPreview && assets.filesScanned === 0) {
    result.skippedReason = 'no verify scaffolding (lib/_preview absent) and no AppAssets class under lib/ — nothing to strip or review';
  }
  return result;
}

/** Flutter analogue of countUnreferencedAssets: `static const String x = …` symbols
 *  of the generated AppAssets class that no .dart file under lib/ references as
 *  `AppAssets.x`. A symbol reached through a computed key (`banners[bannerKey]`) or an
 *  asset loader fed a non-literal (`Image.asset(path)`) is invisible to this scan, so
 *  when either shape exists the count is flagged as NOT safe to prune. */
async function countUnreferencedDartAssets(projectRoot: string, warnings: string[]): Promise<{ unreferenced: number; filesScanned: number }> {
  const lib = path.join(projectRoot, 'lib');
  const dart = (await listAllFiles(lib)).filter((f) => f.endsWith('.dart') && !isInside(path.join(lib, '_preview'), f));
  const resFile = dart.find((f) => /class\s+AppAssets\b/.test(fsSync.readFileSync(f, 'utf-8')));
  if (!resFile) return { unreferenced: 0, filesScanned: 0 };
  const decl = [...fsSync.readFileSync(resFile, 'utf-8').matchAll(/static\s+const\s+(?:String\s+)?([A-Za-z0-9_$]+)\s*=/g)].map((m) => m[1]);
  const used = new Set<string>();
  const dynamic: string[] = [];
  for (const f of dart) {
    if (f === resFile) continue;
    const src = await fs.readFile(f, 'utf-8').catch(() => '');
    for (const m of src.matchAll(/\bAppAssets\s*\.\s*([A-Za-z0-9_$]+)/g)) used.add(m[1]);
    // An asset loader whose path argument is neither a literal nor AppAssets.x.
    for (const m of src.matchAll(/\b(Image\.asset|SvgPicture\.asset|AssetImage|rootBundle\.load(?:String)?)\s*\(\s*([^,)\s][^,)]*)/g)) {
      const arg = m[2].trim();
      if (/^['"]/.test(arg) || /^AppAssets\s*\./.test(arg)) continue;
      dynamic.push(`${m[1]}(${arg}) in ${path.relative(projectRoot, f).split(path.sep).join('/')}`);
    }
  }
  const unref = decl.filter((d) => !used.has(d));
  if (unref.length) {
    warnings.push(
      `${unref.length}/${decl.length} AppAssets symbols are not statically referenced (${unref.join(', ')})`
      + (dynamic.length
        ? ` — but the app loads assets by computed key (${dynamic.slice(0, 3).join('; ')}), so these are NOT safe to prune automatically; review before removing.`
        : ' — no computed-key asset access found, so these are safe to prune (kept anyway; deletion is out of scope for this pass).'),
    );
  }
  return { unreferenced: unref.length, filesScanned: dart.length };
}

export async function runProductionHygiene(opts: HygieneOptions): Promise<HygieneResult> {
  const framework = await detectFramework(opts.projectRoot);
  if (framework === 'flutter') return hygieneFlutter(opts.projectRoot, !!opts.dryRun);
  if (framework === 'react' || framework === 'next') {
    const r = await hygieneWeb(opts.projectRoot, !!opts.dryRun);
    r.framework = framework;
    return r;
  }
  return {
    framework, previewRoutesRemoved: 0, previewFilesRemoved: 0, placeholderRemoved: false,
    unreferencedAssets: 0, warnings: [`no hygiene strategy for framework '${framework}'`], dryRun: !!opts.dryRun,
    filesScanned: 0, skippedReason: `no hygiene strategy for framework '${framework}'`,
  };
}

export const __test = { stripPreviewRoutes, stripImports };
