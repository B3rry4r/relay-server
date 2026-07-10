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
 * Scope is deliberately narrow and reversible-by-regeneration: preview routes,
 * preview imports, preview files, and PlaceholderScreen. It does NOT delete asset
 * files — an asset reached only through `assets[computedKey]` looks unreferenced to
 * a static scan, and deleting it would break an image verify already approved. Those
 * are reported, not removed.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { detectFramework, type Framework } from './component-extraction';
import { loadWebApp, listSourceFiles, stillReferenced, escapeRe } from './web-app';

export interface HygieneResult {
  framework: Framework;
  previewRoutesRemoved: number;
  previewFilesRemoved: number;
  placeholderRemoved: boolean;
  unreferencedAssets: number;
  warnings: string[];
  dryRun: boolean;
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
    placeholderRemoved: false, unreferencedAssets: 0, warnings, dryRun,
  };
  if (!ix || !ix.routerFile) { warnings.push('no react/next router to clean'); return result; }

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
  for (const f of files) {
    if (/Preview\.(tsx|jsx)$/.test(f) || /PlaceholderScreen\.(tsx|jsx)$/.test(f)) {
      result.previewFilesRemoved++;
      if (!dryRun) await fs.rm(f, { force: true }).catch(() => {});
    }
  }

  // ── Report (never delete) unreferenced asset symbols ────────────────────────
  result.unreferencedAssets = await countUnreferencedAssets(projectRoot, ix.srcDir, ix.resourcesFile, warnings);

  return result;
}

/** Count declared asset symbols with no static reference. Reported only: a symbol
 *  reached via `assets[computedKey]` is invisible to this scan, so deleting on its
 *  say-so would break a runtime image. When any dynamic access exists we say so and
 *  do not even imply the count is prunable. */
async function countUnreferencedAssets(
  projectRoot: string, srcDir: string, resourcesFile: string | null, warnings: string[],
): Promise<number> {
  if (!resourcesFile || !fsSync.existsSync(resourcesFile)) return 0;
  const decl = [...fsSync.readFileSync(resourcesFile, 'utf-8').matchAll(/^\s*([A-Za-z0-9_$]+)\s*:/gm)].map((m) => m[1]);
  if (decl.length === 0) return 0;

  let code = '';
  let dynamic = false;
  for (const f of await listSourceFiles(srcDir)) {
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
    placeholderRemoved: false, unreferencedAssets: 0, warnings, dryRun,
  };
  const previewDir = path.join(projectRoot, 'lib', '_preview');
  if (fsSync.existsSync(previewDir)) {
    const entries = await fs.readdir(previewDir).catch(() => []);
    result.previewFilesRemoved = entries.length;
    if (!dryRun) await fs.rm(previewDir, { recursive: true, force: true }).catch(() => {});
  }
  return result;
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
  };
}

export const __test = { stripPreviewRoutes, stripImports };
