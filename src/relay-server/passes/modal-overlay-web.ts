/**
 * modal-overlay-web.ts — Phase 7b for react + next.
 *
 * On Flutter this pass converts a routed modal Scaffold into a `showModalBottomSheet`
 * presenter and strips the dead route. On web the build agent already emits the
 * overlay form — `showModal_<core>()` + `modalController` — because the folded-modal
 * contract in the screen packet tells it to. So the web strategy's job is the part
 * the agent cannot do from inside one screen:
 *
 *   • confirm the modal really is presented from its base (not only from the
 *     verify harness's *Preview.tsx, which does not ship);
 *   • strip the dead `<Route>` the skeleton minted for the modal's own frame,
 *     which otherwise mounts a <PlaceholderScreen> at a real URL;
 *   • report an unpresented modal as a REAL gap rather than crediting it.
 *
 * It never invents a presenter. A modal with no presenter is a gap for the build
 * loop to close, not something to paper over here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadWebApp, resolveScreen, parseImports, countPresenterCalls,
  modalPresenterName, idCore, escapeRe, stillReferenced,
} from './web-app';

export interface WebModalTransform {
  canonicalId: string;
  name: string;
  frameId: string;
  baseCanonicalId: string;
  presenter: string;
  baseFile: string;
  modalFile: string | null;
  removedRoute: string | null;
  presenterCalls: number;
}

export interface WebModalSkip { canonicalId: string; name: string; reason: string }

export interface WebModalOpts { dryRun?: boolean }

export interface WebCanonModal {
  canonicalId: string; name: string; frameId: string; baseCanonicalId: string;
}
export interface WebCanonScreen {
  canonicalId: string; name: string; route: string; frameIds: string[];
}

const isPreviewFile = (f: string): boolean => /Preview\.(tsx|jsx)$/.test(f);

/** Presenter call-sites in the base screen and every local module it imports,
 *  excluding preview harness files. */
async function presenterCalls(baseFile: string, presenter: string): Promise<number> {
  const src = await fs.readFile(baseFile, 'utf-8').catch(() => '');
  if (!src) return 0;
  let n = countPresenterCalls(src, presenter);
  for (const [, target] of parseImports(src, baseFile)) {
    if (isPreviewFile(target)) continue;
    const dep = await fs.readFile(target, 'utf-8').catch(() => '');
    if (dep) n += countPresenterCalls(dep, presenter);
  }
  return n;
}

/** The module that exports `showModal_<core>` — the modal's real file. A folded modal
 *  has no route, so it never appears in the router index; without this the report
 *  named the base screen as the modal file. */
async function findPresenterFile(baseFile: string, presenter: string): Promise<string | null> {
  const decl = new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRe(presenter)}\\b`);
  const seen = new Set<string>();
  const queue: string[] = [baseFile];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f) || isPreviewFile(f)) continue;
    seen.add(f);
    const src = await fs.readFile(f, 'utf-8').catch(() => '');
    if (!src) continue;
    if (decl.test(src)) return f;
    for (const [, target] of parseImports(src, f)) if (!seen.has(target)) queue.push(target);
  }
  return null;
}

/** Remove `<Route path={ROUTES.x} element={<Y … />} />` from the router, plus the
 *  now-dead import and route-table entry. Returns the new sources, or null when the
 *  route isn't there (already clean → idempotent). */
function removeRoute(appSrc: string, routeConst: string): { src: string; component: string } | null {
  const re = new RegExp(
    `\\s*<Route\\s+path=\\{ROUTES\\.${escapeRe(routeConst)}\\}\\s+element=\\{\\s*<\\s*([A-Za-z0-9_$]+)[^>]*?/>\\s*\\}\\s*/>`,
  );
  const m = re.exec(appSrc);
  if (!m) return null;
  return { src: appSrc.slice(0, m.index) + appSrc.slice(m.index + m[0].length), component: m[1] };
}

/** Drop `import { X } from '…'` (or the whole statement) once X is unreferenced. */
function pruneImport(src: string, symbol: string): string {
  if (stillReferenced(src, symbol)) return src;
  const whole = new RegExp(`^import\\s*\\{\\s*${escapeRe(symbol)}\\s*\\}\\s*from\\s*['"][^'"]+['"];?\\s*$`, 'm');
  if (whole.test(src)) return src.replace(whole, '').replace(/\n{3,}/g, '\n\n');
  const inList = new RegExp(`(import\\s*\\{[^}]*?)\\b${escapeRe(symbol)}\\b\\s*,?\\s*([^}]*\\}\\s*from)`);
  return src.replace(inList, (_full, a: string, b: string) => `${a}${b}`.replace(/,\s*\}/, ' }'));
}

/** Remove `key: '/x',` from the ROUTES table once nothing references ROUTES.key. */
function removeRouteConst(routesSrc: string, routeConst: string): string {
  const re = new RegExp(`^\\s*${escapeRe(routeConst)}\\s*:\\s*['"][^'"]+['"],?\\s*$\\n?`, 'm');
  return routesSrc.replace(re, '');
}

/** Convert ONE canonical modal. The orchestrator drives modals one at a time, so
 *  App.tsx / routes.ts are read fresh and written per modal — each removal is
 *  independent and idempotent, so a partial run leaves a consistent router. */
export async function convertWebModal(
  projectRoot: string,
  modal: WebCanonModal,
  screens: WebCanonScreen[],
  opts: WebModalOpts,
): Promise<{ transform: WebModalTransform } | { skip: string }> {
  const ix = await loadWebApp(projectRoot);
  if (!ix) return { skip: 'no react/next app index — src/ has no router to rewrite' };

  const byId = new Map(screens.map((s) => [idCore(s.canonicalId), s]));
  const baseCanon = byId.get(idCore(modal.baseCanonicalId));
  if (!baseCanon) return { skip: `base screen ${modal.baseCanonicalId} not in canonical screens` };

  const baseScreen = resolveScreen(ix, baseCanon.canonicalId, baseCanon.frameIds);
  if (!baseScreen) return { skip: `base screen ${modal.baseCanonicalId} has no built file — REAL gap` };

  const presenter = modalPresenterName(modal.canonicalId);
  const calls = await presenterCalls(baseScreen.file, presenter);
  if (calls === 0) {
    // The modal file may exist and still be unreachable. Never credit that.
    return {
      skip: `REAL gap — ${rel(projectRoot, baseScreen.file)} (and everything it imports) never calls `
        + `${presenter}(); preview harness files are excluded, so a modal only *Preview.tsx opens is `
        + 'unreachable in the shipped app',
    };
  }

  // The modal IS presented. Strip the dead route the skeleton minted for its frame:
  // left in place it mounts a <PlaceholderScreen> at a real, linkable URL.
  const modalScreen = resolveScreen(ix, modal.canonicalId, [modal.frameId]);
  const presenterFile = await findPresenterFile(baseScreen.file, presenter);
  let removedRoute: string | null = null;

  if (modalScreen?.routeConst && ix.routerFile) {
    const appSrc = await fs.readFile(ix.routerFile, 'utf-8');
    const removal = removeRoute(appSrc, modalScreen.routeConst);
    if (removal) {
      const nextApp = pruneImport(removal.src, removal.component);
      removedRoute = modalScreen.route;
      if (!opts.dryRun) {
        await fs.writeFile(ix.routerFile, nextApp, 'utf-8');
        if (ix.routesFile && !stillReferenced(nextApp, `ROUTES.${modalScreen.routeConst}`)) {
          const routesSrc = await fs.readFile(ix.routesFile, 'utf-8');
          await fs.writeFile(ix.routesFile, removeRouteConst(routesSrc, modalScreen.routeConst), 'utf-8');
        }
      }
    }
  }

  return {
    transform: {
      canonicalId: modal.canonicalId,
      name: modal.name,
      frameId: modal.frameId,
      baseCanonicalId: modal.baseCanonicalId,
      presenter,
      baseFile: rel(projectRoot, baseScreen.file),
      modalFile: presenterFile ? rel(projectRoot, presenterFile) : null,
      removedRoute,
      presenterCalls: calls,
    },
  };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

export const __test = { removeRoute, pruneImport, removeRouteConst };
