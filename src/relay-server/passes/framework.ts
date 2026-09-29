/**
 * framework.ts — the ONE framework detector every pass shares.
 *
 * Seven modules used to carry byte-identical copies of `detectFramework` (7a–7e,
 * token-cleanup, and web-app's `detectWebKind`). They agreed today; a copy that
 * drifted would have one pass drive `react` strategies over a Next app while the
 * next pass drove `next` ones — the exact mismatch FRAMEWORK-PARITY.md forbids.
 *
 * `next` is NOT a flavour of `react`: the App Router has no central `<Routes>`
 * table — the route IS the directory — so it is detected distinctly and first.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export type Framework = 'flutter' | 'react' | 'next' | 'unknown';
export type WebKind = 'react' | 'next';

/** The web kind declared by `package.json` dependencies, or null when there is no
 *  readable package.json or it declares neither `next` nor `react`. */
export async function detectWebKindFromPackage(projectRoot: string): Promise<WebKind | null> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fsSync.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) return 'next';
    if (deps.react) return 'react';
  } catch { /* unreadable package.json → not a web app we can drive */ }
  return null;
}

/** flutter (pubspec.yaml) wins over a package.json; then next, then react. */
export async function detectFramework(projectRoot: string): Promise<Framework> {
  if (fsSync.existsSync(path.join(projectRoot, 'pubspec.yaml'))) return 'flutter';
  return (await detectWebKindFromPackage(projectRoot)) ?? 'unknown';
}

// ── web layout contract (CONTRACTS §5) ────────────────────────────────────────

const isDirSync = (p: string): boolean => { try { return fsSync.statSync(p).isDirectory(); } catch { return false; } };

/** Where pipeline-owned web files live, relative to the project: react (Vite) →
 *  `src`; next → the app dir's parent (`src` when the app dir is `src/app` and
 *  there is no root `app/`, else `.`). Mirrors web-app.loadWebApp's pipelineRoot. */
export function webPipelineRootRel(projectRoot: string, framework: string): string {
  if ((framework || '').toLowerCase() !== 'next') return 'src';
  if (isDirSync(path.join(projectRoot, 'app'))) return '.';
  if (isDirSync(path.join(projectRoot, 'src', 'app'))) return 'src';
  return '.';
}

/** The generated resources module for a web framework (project-relative, POSIX):
 *  react → `src/resources/assets.ts`; next → `<root>/lib/resources/assets.ts`. */
export function webResourcesRel(projectRoot: string, framework: string): string {
  if ((framework || '').toLowerCase() === 'next') {
    const pr = webPipelineRootRel(projectRoot, 'next');
    return pr === '.' ? 'lib/resources/assets.ts' : `${pr}/lib/resources/assets.ts`;
  }
  return 'src/resources/assets.ts';
}

const WEB_FRAMEWORKS = new Set(['react', 'next', 'vite', 'web', 'ts']);
export const isWebFramework = (framework: string): boolean => WEB_FRAMEWORKS.has((framework || '').toLowerCase());

/** Where localized design assets live (project-relative): a web server serves only
 *  `public/`, so react/next assets live in `public/assets/{icons,images}` (served at
 *  `/assets/…`); flutter bundles `assets/` (declared in pubspec). */
export function assetBaseDir(framework: string): string {
  return isWebFramework(framework) ? 'public/assets' : 'assets';
}

/** A web asset's served URL from its project-relative path:
 *  `public/assets/icons/x.svg` → `/assets/icons/x.svg`. */
export function webServedUrl(relPath: string): string {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/^public\//, '');
  return `/${p}`;
}

/** The one key every spelling of a web asset path shares — the IR's opaque
 *  `assets/icons/x.svg`, the served `/assets/icons/x.svg` and the on-disk
 *  `public/assets/icons/x.svg` all reach the same file. */
export function webAssetKey(p: string): string {
  return webServedUrl(p).slice(1);
}
