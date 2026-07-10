/**
 * semantic-rename-web.ts — Phase 7e for react + next.
 *
 * The web skeleton already emits semantic FILES (`EscrowScreen.tsx`) and semantic
 * route CONSTANTS (`ROUTES.escrow`). What it does not emit is a semantic route
 * PATH: every screen is mounted at its Figma frame id, `/88-4361`. That is the URL
 * a user sees and bookmarks.
 *
 * So the web rename is narrower than Flutter's and correspondingly safer: rewrite
 * the route path VALUE in the route table, rewrite any literal use of the old path,
 * and stamp the `// canonicalId: … route: …` header on the screen so every later
 * pass can resolve it without inferring anything.
 *
 * Idempotent: a screen already on a semantic path is skipped, not renamed twice.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { deriveSemanticIdentifiers } from '../semantic-names';
import {
  loadWebApp, resolveScreen, listSourceFiles, stampHeader, readHeader, escapeRe, idCore,
} from './web-app';

export interface WebRename {
  canonicalId: string;
  canonicalName: string;
  file: string;
  routeConst: string | null;
  oldRoutePath: string;
  newRoutePath: string;
  headerStamped: boolean;
}
export interface WebRenameSkip { canonicalId: string; reason: string }

export interface WebRenameCanonScreen { canonicalId: string; name: string; route: string; frameIds: string[] }
export interface WebRenameOptions { dryRun?: boolean; only?: string[] }

/** A route the skeleton minted from a frame id: `/88-4361`, `/132-643`. */
const isFrameRoute = (route: string): boolean => /^\/\d+-\d+$/.test(route);

export async function renameWeb(
  projectRoot: string,
  screens: WebRenameCanonScreen[],
  opts: WebRenameOptions,
): Promise<{ renames: WebRename[]; skipped: WebRenameSkip[]; builtScreens: number; filesTouched: number }> {
  const renames: WebRename[] = [];
  const skipped: WebRenameSkip[] = [];

  const ix = await loadWebApp(projectRoot);
  if (!ix) {
    for (const s of screens) skipped.push({ canonicalId: s.canonicalId, reason: 'no react/next app index' });
    return { renames, skipped, builtScreens: 0, filesTouched: 0 };
  }
  if (!ix.routesFile) {
    for (const s of screens) skipped.push({ canonicalId: s.canonicalId, reason: 'no route table (src/router/routes.ts) to rewrite' });
    return { renames, skipped, builtScreens: 0, filesTouched: 0 };
  }

  const targets = opts.only?.length ? screens.filter((s) => opts.only!.includes(s.canonicalId)) : screens;

  // Plan every rename first so collisions are computed against the FULL target set,
  // not just the ones already applied.
  const claimed = new Set<string>([...ix.constToRoute.values()].filter((r) => !isFrameRoute(r)));
  const planned: WebRename[] = [];
  let builtScreens = 0;

  for (const screen of targets) {
    const built = resolveScreen(ix, screen.canonicalId, screen.frameIds);
    if (!built || built.placeholder) {
      skipped.push({ canonicalId: screen.canonicalId, reason: 'no built screen file (unmapped, or the router mounts a placeholder)' });
      continue;
    }
    builtScreens++;
    if (!built.route || !built.routeConst) {
      skipped.push({ canonicalId: screen.canonicalId, reason: 'screen has no entry in the route table' });
      continue;
    }
    if (!isFrameRoute(built.route)) {
      skipped.push({ canonicalId: screen.canonicalId, reason: `already semantic (${built.route})` });
      continue;
    }

    const ids = deriveSemanticIdentifiers(screen.name);
    let newPath = ids.routePath;
    if (claimed.has(newPath)) {
      let n = 2;
      while (claimed.has(`${ids.routePath}-${n}`)) n++;
      newPath = `${ids.routePath}-${n}`;
    }
    claimed.add(newPath);

    planned.push({
      canonicalId: screen.canonicalId,
      canonicalName: screen.name,
      file: rel(projectRoot, built.file),
      routeConst: built.routeConst,
      oldRoutePath: built.route,
      newRoutePath: newPath,
      headerStamped: false,
    });
  }

  if (opts.dryRun) return { renames: planned, skipped, builtScreens, filesTouched: 0 };

  // Apply. Load every source once so multiple rewrites compose, then write the delta.
  const files = await listSourceFiles(ix.srcDir);
  const contents = new Map<string, string>();
  for (const f of files) contents.set(f, await fs.readFile(f, 'utf-8').catch(() => ''));

  for (const r of planned) {
    for (const [f, src] of contents) {
      if (!src) continue;
      // The route-table VALUE, and any literal use of the old path anywhere.
      const next = src.replace(new RegExp(`(['"\`])${escapeRe(r.oldRoutePath)}\\1`, 'g'), `$1${r.newRoutePath}$1`);
      if (next !== src) contents.set(f, next);
    }

    // Stamp the header so later passes resolve by data, not by convention.
    const abs = path.join(projectRoot, r.file);
    const src = contents.get(abs);
    if (src != null && src && !readHeader(src)) {
      contents.set(abs, stampHeader(src, r.canonicalId, r.newRoutePath));
      r.headerStamped = true;
    }
    renames.push(r);
  }

  let filesTouched = 0;
  for (const f of files) {
    const next = contents.get(f);
    if (next == null) continue;
    const before = await fs.readFile(f, 'utf-8').catch(() => null);
    if (before == null || before === next) continue;
    await fs.writeFile(f, next, 'utf-8');
    filesTouched++;
  }

  return { renames, skipped, builtScreens, filesTouched };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { isFrameRoute, idCore };
