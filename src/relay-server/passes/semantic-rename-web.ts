/**
 * semantic-rename-web.ts — Phase 7e for react + next.
 *
 * Mirrors the flutter rename (file + class + route const + route path, every
 * reference rewritten, collision-checked, word-boundary only) on the web's shapes:
 *
 *   react  — the screen COMPONENT (`IPhone1415Pro57Screen` → `SettingsScreen`) and
 *            its FILE when named after it, a machine ROUTES key (`c103` →
 *            `settings`), and the route PATH value (`/10-3` → `/settings`) in the
 *            route table and every literal use (PG-19);
 *   next   — the route IS the directory: `app/10-3/` moves to `app/settings/`
 *            inside the same route group, every `router.push` / `redirect` /
 *            `<Link href>` / nav-item literal follows, and the page component is
 *            renamed (`IPhone1415Pro57Page` → `SettingsPage`) (PG-20).
 *
 * In the same transaction the `// canonicalId: <id> route: <route>` header of every
 * renamed screen is rewritten to the route the app now serves (stamped when absent)
 * — every later pass resolves a screen by that header, so a stale one made the next
 * finalize re-rename or re-grade the screen (PG-21).
 *
 * Verify-harness previews are rewritten like any other importer (they must keep
 * compiling) but never renamed: `/_preview/<frame>` is keyed by frame id by contract.
 *
 * Idempotent: a screen already on a semantic path/name is skipped, not renamed twice.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { deriveSemanticIdentifiers, type SemanticIdentifiers } from '../semantic-names';
import {
  loadWebApp, resolveScreen, readHeader, escapeRe, idCore, nextAppRoute, nextPagesRoute,
  resolveSpecifier, importPathBetween, parseImports, type WebAppIndex,
} from './web-app';

export interface WebRename {
  canonicalId: string;
  canonicalName: string;
  /** Project-relative screen file before / after the move (equal when not moved). */
  file: string;
  newFile: string;
  oldComponent: string;
  newComponent: string;
  routeConst: string | null;
  newRouteConst: string | null;
  oldRoutePath: string | null;
  newRoutePath: string | null;
  /** Next App Router: the route directory moved (project-relative). */
  movedDir?: { from: string; to: string };
  headerStamped: boolean;
}
export interface WebRenameSkip { canonicalId: string; reason: string }

export interface WebRenameCanonScreen { canonicalId: string; name: string; route: string; frameIds: string[] }
export interface WebRenameOptions { dryRun?: boolean; only?: string[] }

/** A route the skeleton minted from a frame id: `/88-4361`, `/132-643`. */
const isFrameRoute = (route: string): boolean => /^\/\d+-\d+$/.test(route);
/** A route-table key minted from a frame id: `c103`, `c2903657`, `c_10_3`. */
const isMachineKey = (key: string): boolean => /^[a-z]?_?\d[\d_]*$/i.test(key);
/** A component name carrying a Figma frame label's digits (`IPhone1415Pro57Screen`, `Frame123Page`). */
const hasFrameDigits = (name: string): boolean => /\d/.test(name);

const HEADER_LINE = /^(\/\/\s*canonicalId:\s*)(\S+)((?:\s+route:\s*)(\S+))?[^\n]*$/m;

/** Rewrite (or stamp) the canonical header so it names the route the app serves. */
export function syncHeader(src: string, canonicalId: string, route: string | null): { src: string; stamped: boolean } {
  const m = HEADER_LINE.exec(src);
  const line = route ? `// canonicalId: ${m?.[2] ?? canonicalId} route: ${route}` : `// canonicalId: ${m?.[2] ?? canonicalId}`;
  if (!m) return { src: `${line}\n${src}`, stamped: true };
  if (m[0] === line) return { src, stamped: false };
  return { src: src.slice(0, m.index) + line + src.slice(m.index + m[0].length), stamped: false };
}

/** Every code file under the app's source roots INCLUDING verify-harness previews
 *  (they import screens and must keep compiling after a rename). */
async function listAllCode(roots: string[]): Promise<string[]> {
  const out = new Set<string>();
  const walk = async (d: string): Promise<void> => {
    let entries: fsSync.Dirent[] = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', '.next', '.git', 'out'].includes(e.name)) await walk(p); }
      else if (/\.(tsx|jsx|ts|js)$/.test(e.name)) out.add(p);
    }
  };
  for (const r of roots) await walk(r);
  return [...out];
}

/** Word-boundary identifier replace (never inside a longer identifier). */
function replaceIdent(src: string, oldId: string, newId: string): string {
  if (!oldId || oldId === newId) return src;
  return src.replace(new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(oldId)}(?![A-Za-z0-9_$])`, 'g'), newId);
}

/** Replace a whole quoted route literal, and a literal that starts with it plus `/`
 *  (a nested route under a moved directory). */
function replaceRouteLiteral(src: string, oldRoute: string, newRoute: string): string {
  if (oldRoute === newRoute) return src;
  return src.replace(new RegExp(`(['"\`])${escapeRe(oldRoute)}(/[^'"\`]*)?\\1`, 'g'), (_m, q: string, tail: string | undefined) => `${q}${newRoute}${tail ?? ''}${q}`);
}

interface Plan extends WebRename {
  abs: string;
  newAbs: string;
  dirFrom?: string;
  dirTo?: string;
}

export async function renameWeb(
  projectRoot: string,
  screens: WebRenameCanonScreen[],
  opts: WebRenameOptions,
): Promise<{ renames: WebRename[]; skipped: WebRenameSkip[]; builtScreens: number; filesTouched: number; unsupported?: string }> {
  const skipped: WebRenameSkip[] = [];
  const ix = await loadWebApp(projectRoot);
  if (!ix) {
    for (const s of screens) skipped.push({ canonicalId: s.canonicalId, reason: 'no react/next app index' });
    return { renames: [], skipped, builtScreens: 0, filesTouched: 0, unsupported: 'no react/next app index (package.json declares neither)' };
  }
  if (ix.kind === 'react' && !ix.routesFile) {
    for (const s of screens) skipped.push({ canonicalId: s.canonicalId, reason: 'no route table (src/router/routes.ts) to rewrite' });
    return { renames: [], skipped, builtScreens: 0, filesTouched: 0, unsupported: 'no route table (src/router/routes.ts) to rewrite' };
  }

  const targets = opts.only?.length ? screens.filter((s) => opts.only!.includes(s.canonicalId)) : screens;
  const allFiles = await listAllCode(ix.sourceRoots);
  const contents = new Map<string, string>();
  for (const f of allFiles) contents.set(f, await fs.readFile(f, 'utf-8').catch(() => ''));

  // Identifiers that exist already (collision checks) and routes already served.
  const declared = new Set<string>();
  for (const src of contents.values()) {
    for (const m of src.matchAll(/(?:function|const|class|let|var)\s+([A-Z][A-Za-z0-9_$]*)/g)) declared.add(m[1]);
  }
  const served = new Set<string>([...ix.byRoute.keys()].filter((r) => !isFrameRoute(r)));
  const claimedKeys = new Set<string>([...ix.constToRoute.keys()]);

  const plans: Plan[] = [];
  let builtScreens = 0;
  const seen = new Set<string>();

  for (const screen of targets) {
    const built = resolveScreen(ix, screen.canonicalId, screen.frameIds);
    if (!built || built.placeholder) {
      skipped.push({ canonicalId: screen.canonicalId, reason: 'no built screen file (unmapped, or its route still mounts a placeholder / skeleton stub)' });
      continue;
    }
    if (seen.has(built.file)) { skipped.push({ canonicalId: screen.canonicalId, reason: `shares ${rel(projectRoot, built.file)} with another canonical screen` }); continue; }
    seen.add(built.file);
    builtScreens++;

    // The URL the screen is actually served at: react → its route-table entry;
    // next → the file-system route (the directory), never the header's claim.
    const routeNow = servedRoute(ix, built.file) ?? built.route;
    const routeConst = built.routeConst ?? (routeNow ? ix.routeToConst.get(routeNow) ?? null : null);

    // A frame-code canonical name has no semantic content; a semantic route-table
    // key (`profile`) the pipeline itself wrote is better evidence than `screen`.
    let ids: SemanticIdentifiers = deriveSemanticIdentifiers(screen.name);
    if (ids.fellBack && routeConst && !isMachineKey(routeConst)) ids = deriveSemanticIdentifiers(routeConst);
    const suffix = ix.kind === 'next' && isPageFile(built.file) ? 'Page' : 'Screen';
    const wantComponent = ids.className.replace(/Screen$/, suffix);

    // Route path.
    let newRoute: string | null = null;
    if (routeNow && isFrameRoute(routeNow)) {
      newRoute = ids.routePath;
      for (let n = 2; served.has(newRoute) || plans.some((p) => p.newRoutePath === newRoute); n++) newRoute = `${ids.routePath}-${n}`;
      served.add(newRoute);
    }
    // Component.
    let newComponent = built.componentName;
    if (built.componentName !== wantComponent && (hasFrameDigits(built.componentName) || !ids.fellBack)) {
      newComponent = wantComponent;
      for (let n = 2; declared.has(newComponent) || plans.some((p) => p.newComponent === newComponent); n++) {
        newComponent = wantComponent.replace(new RegExp(`${suffix}$`), `${n}${suffix}`);
      }
    }
    // Route-table key.
    let newKey: string | null = routeConst;
    if (routeConst && isMachineKey(routeConst)) {
      newKey = ids.routeConst;
      for (let n = 2; claimedKeys.has(newKey); n++) newKey = `${ids.routeConst}${n}`;
      claimedKeys.add(newKey);
    }

    const header = readHeader(contents.get(built.file) ?? '');
    const headerStale = !header || (header.route ?? null) !== (newRoute ?? routeNow ?? null);
    if (!newRoute && newComponent === built.componentName && newKey === routeConst && !headerStale) {
      skipped.push({ canonicalId: screen.canonicalId, reason: `already semantic (${routeNow ?? 'no route'}, <${built.componentName}>) — nothing to rename` });
      continue;
    }

    // File / directory move.
    let newAbs = built.file;
    let dirFrom: string | undefined;
    let dirTo: string | undefined;
    if (ix.kind === 'next' && newRoute && ix.appDir && isPageFile(built.file) && built.file.startsWith(ix.appDir + path.sep)) {
      const dir = path.dirname(built.file);
      if (path.basename(dir) === routeNow!.slice(1)) {
        let to = path.join(path.dirname(dir), newRoute.slice(1));
        for (let n = 2; fsSync.existsSync(to) || plans.some((p) => p.dirTo === to); n++) to = path.join(path.dirname(dir), `${newRoute.slice(1)}-${n}`);
        dirFrom = dir; dirTo = to;
        newAbs = path.join(to, path.basename(built.file));
      }
    } else if (ix.kind === 'next' && newRoute && ix.pagesDir && built.file.startsWith(ix.pagesDir + path.sep)) {
      const ext = path.extname(built.file);
      if (path.basename(built.file, ext) === routeNow!.slice(1)) newAbs = path.join(path.dirname(built.file), `${newRoute.slice(1)}${ext}`);
    } else if (newComponent !== built.componentName) {
      const ext = path.extname(built.file);
      if (path.basename(built.file, ext) === built.componentName) {
        const cand = path.join(path.dirname(built.file), `${newComponent}${ext}`);
        if (!fsSync.existsSync(cand)) newAbs = cand;
      }
    }

    plans.push({
      canonicalId: screen.canonicalId,
      canonicalName: screen.name,
      abs: built.file,
      newAbs,
      file: rel(projectRoot, built.file),
      newFile: rel(projectRoot, newAbs),
      oldComponent: built.componentName,
      newComponent,
      routeConst,
      newRouteConst: newKey,
      oldRoutePath: routeNow ?? null,
      newRoutePath: newRoute ?? routeNow ?? null,
      ...(dirFrom && dirTo ? { movedDir: { from: rel(projectRoot, dirFrom), to: rel(projectRoot, dirTo) }, dirFrom, dirTo } : {}),
      headerStamped: false,
    });
  }

  const report = (): WebRename[] => plans.map(({ abs: _a, newAbs: _n, dirFrom: _f, dirTo: _t, ...r }) => r);
  if (opts.dryRun) return { renames: report(), skipped, builtScreens, filesTouched: 0 };

  // ── Apply: identifiers, keys, literals, headers — all in memory first ──────
  // The component identifier is renamed ONLY where it denotes this screen: its own
  // file and the modules importing it by that name from it. A generic name (`Page`,
  // `Home`) must never be rewritten in an unrelated file that declares its own.
  const importersOf = new Map<string, Set<string>>();
  for (const p of plans) {
    const set = new Set<string>([p.abs]);
    for (const [f, src] of contents) {
      if (f === p.abs || !src) continue;
      const imp = parseImports(src, f);
      if (imp.get(p.oldComponent) === p.abs) set.add(f);
    }
    importersOf.set(p.abs, set);
  }
  for (const p of plans) {
    const scope = importersOf.get(p.abs)!;
    for (const [f, src] of contents) {
      if (!src) continue;
      let next = scope.has(f) ? replaceIdent(src, p.oldComponent, p.newComponent) : src;
      if (p.routeConst && p.newRouteConst && p.routeConst !== p.newRouteConst) {
        next = next.replace(new RegExp(`\\bROUTES(\\s*\\.\\s*)${escapeRe(p.routeConst)}(?![A-Za-z0-9_$])`, 'g'), `ROUTES$1${p.newRouteConst}`);
        if (f === ix.routesFile) next = next.replace(new RegExp(`^(\\s*)${escapeRe(p.routeConst)}(\\s*:)`, 'm'), `$1${p.newRouteConst}$2`);
      }
      if (p.oldRoutePath && p.newRoutePath && p.oldRoutePath !== p.newRoutePath) next = replaceRouteLiteral(next, p.oldRoutePath, p.newRoutePath);
      if (next !== src) contents.set(f, next);
    }
    const synced = syncHeader(contents.get(p.abs) ?? '', p.canonicalId, p.newRoutePath);
    contents.set(p.abs, synced.src);
    p.headerStamped = synced.stamped;
  }

  // ── Moves: where every file will live afterwards ────────────────────────────
  const whereAfter = (f: string): string => {
    for (const p of plans) {
      if (p.dirFrom && p.dirTo && (f === p.dirFrom || f.startsWith(p.dirFrom + path.sep))) return p.dirTo + f.slice(p.dirFrom.length);
      if (!p.dirFrom && f === p.abs) return p.newAbs;
    }
    return f;
  };
  const anyMove = plans.some((p) => p.newAbs !== p.abs || p.dirFrom);
  if (anyMove) {
    for (const [f, src] of contents) {
      if (!src) continue;
      const next = rewriteSpecifiers(src, f, whereAfter);
      if (next !== src) contents.set(f, next);
    }
  }

  // ── Write, then move ────────────────────────────────────────────────────────
  let filesTouched = 0;
  for (const [f, next] of contents) {
    const before = await fs.readFile(f, 'utf-8').catch(() => null);
    if (before == null || before === next) continue;
    await fs.writeFile(f, next, 'utf-8');
    filesTouched++;
  }
  for (const p of plans) {
    if (p.dirFrom && p.dirTo) {
      await fs.mkdir(path.dirname(p.dirTo), { recursive: true });
      await fs.rename(p.dirFrom, p.dirTo);
      filesTouched++;
    } else if (p.newAbs !== p.abs) {
      await fs.rename(p.abs, p.newAbs);
      filesTouched++;
    }
  }

  return { renames: report(), skipped, builtScreens, filesTouched };
}

const isPageFile = (f: string): boolean => /^page\.(tsx|jsx|ts|js)$/.test(path.basename(f));

function servedRoute(ix: WebAppIndex, file: string): string | null {
  if (ix.kind !== 'next') return null;
  if (ix.appDir && file.startsWith(ix.appDir + path.sep)) return nextAppRoute(ix.appDir, file);
  if (ix.pagesDir && file.startsWith(ix.pagesDir + path.sep)) return nextPagesRoute(ix.pagesDir, file);
  return null;
}

/** Re-point every import/export/dynamic-import specifier of `src` (living at `file`)
 *  whose target moves, or whose own file moves. Relative specifiers are recomputed;
 *  an alias specifier (`@/app/10-3/page`) has its trailing path segments swapped. */
function rewriteSpecifiers(src: string, file: string, whereAfter: (f: string) => string): string {
  const selfAfter = whereAfter(file);
  return src.replace(/(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\2/gm, (full, pre: string, q: string, spec: string) => {
    const target = resolveSpecifier(file, spec);
    if (!target) return full;
    const targetAfter = whereAfter(target);
    if (targetAfter === target && selfAfter === file) return full;
    let next: string;
    if (spec.startsWith('.')) {
      next = importPathBetween(selfAfter, targetAfter);
      // Keep an explicit `/index` or extension off, exactly as importPathBetween does.
    } else {
      const oldSegs = target.replace(/\.(tsx|ts|jsx|js)$/, '').split(path.sep);
      const newSegs = targetAfter.replace(/\.(tsx|ts|jsx|js)$/, '').split(path.sep);
      const specSegs = spec.split('/');
      let k = 0;
      while (k < specSegs.length && k < oldSegs.length && specSegs[specSegs.length - 1 - k] === oldSegs[oldSegs.length - 1 - k]) k++;
      if (k === 0 || oldSegs.length !== newSegs.length) return full;
      next = [...specSegs.slice(0, specSegs.length - k), ...newSegs.slice(newSegs.length - k)].join('/');
    }
    return next === spec ? full : `${pre}${q}${next}${q}`;
  });
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { isFrameRoute, isMachineKey, idCore, syncHeader, replaceRouteLiteral, rewriteSpecifiers };
