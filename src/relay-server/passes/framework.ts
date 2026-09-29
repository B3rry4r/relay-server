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
