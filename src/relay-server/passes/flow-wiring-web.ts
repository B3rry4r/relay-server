/**
 * flow-wiring-web.ts — Phase 7d for react + next.
 *
 * Mirrors the flutter strategy edge-for-edge: resolve FROM/TO to built screens,
 * decide whether FROM actually navigates to TO, classify, and apply the one safe
 * auto-fix (a dead `onClick={() => {}}` on the named trigger, wired to the target
 * route when that route unambiguously exists).
 *
 * The web-specific facts:
 *   • Navigation is `navigate(ROUTES.x)`, `<Link to={ROUTES.x}>`, `router.push('/x')`.
 *   • A nav bar builds links from a data array, so the target never appears at the
 *     call site — only the route constant does. Both are collected.
 *   • Tabs are `<Route element={<AppShell/>}>` children, not a pushed route.
 *   • A modal is folded into its base and presented via `showModal_<core>()`.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  type WebAppIndex, type WebScreenFile,
  loadWebApp, resolveScreen, collectNavTargets, collectRouteConstRefs,
  countPresenterCalls, findDeadHandlers, enclosingMentions,
  modalPresenterName, parseImports, ensureNamedImport, importPathBetween, idCore,
} from './web-app';

// Structural types re-declared to keep this module free of a cycle back into
// flow-wiring.ts. They are the same shapes; the orchestrator owns them.
export interface WebFlowEdge { from: string; to: string; kind: string; label?: string; viaModalId?: string }
export interface WebFlow { entryCanonicalId: string | null; edges: WebFlowEdge[] }
export interface WebCanonScreen { canonicalId: string; name: string; route: string; frameIds: string[] }
export interface WebCanonModal { canonicalId: string; name: string; frameId: string; baseCanonicalId: string }

export type WebEdgeStatus =
  | 'wired' | 'wrong-target' | 'wrong-verb' | 'tab-as-push' | 'missing-step-presenter'
  | 'missing' | 'dead-trigger' | 'duplicate' | 'unmapped';

export interface WebEdgeFinding {
  from: string; to: string; kind: string; element?: string;
  status: WebEdgeStatus;
  fromFile?: string; toFile?: string; toRoute?: string; toRouteConst?: string;
  actualTargetRoute?: string; actualTargetCanonicalId?: string;
  detail: string; autoFixed?: boolean; elementHow?: 'deterministic' | 'ai' | 'none';
}

export interface WebVerifyOptions {
  dryRun?: boolean;
  noAutoFix?: boolean;
}

const REPLACE_VERBS = new Set(['router.replace', 'redirect', 'Navigate', 'navigate.replace']);

/** Every route a file can reach: literal targets plus route constants it mentions.
 *  `sources` are the files the surface was built from — presenter calls are counted
 *  over the same set, since a screen delegates both nav and modal presentation to
 *  the components it composes. */
interface NavSurface {
  routes: Set<string>;
  consts: Set<string>;
  verbsByRoute: Map<string, Set<string>>;
  sources: string[];
}

function navSurfaceOf(src: string, ix: WebAppIndex, file: string): NavSurface {
  const routes = new Set<string>();
  const consts = new Set<string>();
  const verbsByRoute = new Map<string, Set<string>>();
  for (const t of collectNavTargets(src, ix.constToRoute)) {
    if (t.route) {
      routes.add(t.route);
      const set = verbsByRoute.get(t.route) ?? new Set<string>();
      set.add(t.verb);
      verbsByRoute.set(t.route, set);
    }
    if (t.routeConst) consts.add(t.routeConst);
  }
  for (const c of collectRouteConstRefs(src)) {
    consts.add(c);
    const r = ix.constToRoute.get(c);
    if (r) routes.add(r);
  }
  return { routes, consts, verbsByRoute, sources: [file] };
}

function mergeSurface(a: NavSurface, b: NavSurface): NavSurface {
  for (const r of b.routes) a.routes.add(r);
  for (const c of b.consts) a.consts.add(c);
  for (const [r, verbs] of b.verbsByRoute) {
    const set = a.verbsByRoute.get(r) ?? new Set<string>();
    for (const v of verbs) set.add(v);
    a.verbsByRoute.set(r, set);
  }
  a.sources.push(...b.sources);
  return a;
}

/** A `*Preview.tsx` exists only to mount one screen for the verify harness. It is
 *  NOT part of the shipped app, and a modal that only the preview presents is
 *  unreachable in production — exactly the gap this pass exists to catch. */
const isPreviewFile = (f: string): boolean => /Preview\.(tsx|jsx)$/.test(f);

/** The FROM screen plus every local module it imports (one level): a screen that
 *  delegates its nav bar to `<SideNavBar/>` still navigates, and one that presents
 *  its modal from a sibling panel component still presents it. Scanning only the
 *  screen file reported both as missing. */
async function surfaceForScreen(
  file: string, src: string, ix: WebAppIndex,
  read: (f: string) => Promise<string>,
): Promise<NavSurface> {
  const surface = navSurfaceOf(src, ix, file);
  const seen = new Set([file]);
  for (const [, target] of parseImports(src, file)) {
    if (seen.has(target) || isPreviewFile(target)) continue;
    seen.add(target);
    const dep = await read(target);
    if (dep) mergeSurface(surface, navSurfaceOf(dep, ix, target));
  }
  return surface;
}

/** Presenter call-sites across every file in the surface. */
async function presenterCallsInSurface(
  surface: NavSurface, presenter: string, modalId: string, read: (f: string) => Promise<string>,
): Promise<number> {
  let n = 0;
  for (const f of surface.sources) n += countPresenterCalls(await read(f), presenter, modalId);
  return n;
}

/** Is the TO screen mounted as a child of a layout route (`<Route element={<AppShell/>}>`)?
 *  On web a tab destination is *hosted* by the shell rather than pushed onto it. */
function shellHosts(appSrc: string, componentName: string): boolean {
  const shell = /<Route\s+element=\{\s*<\s*(?:AppShell|Shell|Layout)\b[^>]*\/>\s*\}\s*>([\s\S]*?)<\/Route>/.exec(appSrc);
  if (!shell) return false;
  return new RegExp(`<\\s*${componentName}\\b`).test(shell[1]);
}

export async function verifyWeb(
  projectRoot: string,
  flow: WebFlow,
  screens: WebCanonScreen[],
  modals: WebCanonModal[],
  opts: WebVerifyOptions,
): Promise<{ findings: WebEdgeFinding[]; autoFixes: number; screensMapped: number; screensReferenced: number }> {
  const ix = await loadWebApp(projectRoot);
  const referenced = new Set(flow.edges.flatMap((e) => [e.from, e.to]));
  if (!ix) {
    return {
      findings: flow.edges.map((e) => ({
        from: e.from, to: e.to, kind: e.kind, ...(e.label ? { element: e.label } : {}),
        status: 'unmapped' as WebEdgeStatus,
        detail: 'no react/next app index — src/ has no router or route table to verify against',
      })),
      autoFixes: 0, screensMapped: 0, screensReferenced: referenced.size,
    };
  }

  const byCanonId = new Map(screens.map((s) => [idCore(s.canonicalId), s]));
  const modalById = new Map(modals.map((m) => [idCore(m.canonicalId), m]));

  // In-memory source cache so an auto-fix in one edge is visible to the next.
  const srcCache = new Map<string, string>();
  const readSrc = async (f: string): Promise<string> => {
    if (!srcCache.has(f)) srcCache.set(f, await fs.readFile(f, 'utf-8').catch(() => ''));
    return srcCache.get(f)!;
  };

  const appSrc = ix.routerFile ? await readSrc(ix.routerFile) : '';
  // The shell owns the tab bar. Its nav surface — the shell plus the nav component
  // it composes — is what makes a tab destination reachable, not anything the
  // FROM screen does.
  const shellFile = ix.byId.size ? findShellFile(ix) : null;
  const shellSurface = shellFile
    ? await surfaceForScreen(shellFile, await readSrc(shellFile), ix, readSrc)
    : null;

  const findings: WebEdgeFinding[] = [];
  let autoFixes = 0;
  const mapped = new Set<string>();
  // A base screen only gets credit for as many folded modals as it actually presents.
  const presenterBudget = new Map<string, number>();

  for (const edge of flow.edges) {
    const fromCanon = byCanonId.get(idCore(edge.from));
    const toCanon = byCanonId.get(idCore(edge.to));
    const toModal = modalById.get(idCore(edge.to));

    const fromScreen = fromCanon ? resolveScreen(ix, fromCanon.canonicalId, fromCanon.frameIds) : null;
    const toScreen = toCanon ? resolveScreen(ix, toCanon.canonicalId, toCanon.frameIds) : null;

    const base: WebEdgeFinding = {
      from: edge.from, to: edge.to, kind: edge.kind,
      ...(edge.label ? { element: edge.label } : {}),
      status: 'unmapped',
      detail: '',
    };
    if (fromScreen) { base.fromFile = rel(projectRoot, fromScreen.file); mapped.add(edge.from); }
    if (toScreen) {
      base.toFile = rel(projectRoot, toScreen.file);
      base.toRoute = toScreen.route ?? undefined;
      base.toRouteConst = toScreen.routeConst ?? undefined;
      mapped.add(edge.to);
    }

    // ── FROM must exist to say anything about the edge ────────────────────────
    if (!fromScreen) {
      findings.push({ ...base, detail: `FROM ${edge.from} has no built screen file — cannot verify` });
      continue;
    }
    const fromSrc = await readSrc(fromScreen.file);
    const surface = await surfaceForScreen(fromScreen.file, fromSrc, ix, readSrc);

    // ── Folded modal: TO has no standalone route, presented from its base ─────
    if (toModal && (!toScreen || toScreen.placeholder)) {
      const presenter = modalPresenterName(toModal.canonicalId);
      const calls = await presenterCallsInSurface(surface, presenter, toModal.canonicalId, readSrc);
      const key = `${fromScreen.file}::${presenter}`;
      const used = presenterBudget.get(key) ?? 0;
      if (calls > used) {
        presenterBudget.set(key, used + 1);
        mapped.add(edge.to);
        findings.push({
          ...base, status: 'wired',
          detail: `folded modal — FROM calls ${presenter}() (${calls} call-site(s))`,
        });
        continue;
      }
      findings.push({
        ...base, status: 'unmapped',
        detail: `REAL gap, not folded: modal ${edge.to} has no built screen, and neither ${rel(projectRoot, fromScreen.file)} `
          + `nor anything it imports calls ${presenter}() or modalController.open('${toModal.canonicalId}', …) `
          + '(preview harness files are not counted — a modal only the preview presents is unreachable in the app)',
      });
      continue;
    }

    if (!toScreen) {
      findings.push({ ...base, detail: `TO ${edge.to} has no built screen file — cannot verify` });
      continue;
    }

    // A route that mounts <PlaceholderScreen> is not a built screen, whatever the
    // router says. This is the defect that shipped: a canonical edge pointing at a
    // placeholder, with every screen reporting "matched the reference".
    if (toScreen.placeholder) {
      findings.push({
        ...base, status: 'missing',
        detail: `HIGH: TO route ${toScreen.route} mounts <${toScreen.componentName}> — the screen was never wired into the router`,
      });
      continue;
    }

    const toRoute = toScreen.route;
    const landsOnTo = !!toRoute && (surface.routes.has(toRoute)
      || (!!toScreen.routeConst && surface.consts.has(toScreen.routeConst)));

    // ── Tab conformance ──────────────────────────────────────────────────────
    // A tab destination is reached from the persistent shell, not from the FROM
    // screen. So the question is never "does Disputes navigate to Finance" — it is
    // "does the shell host Finance, and does the shell's nav link to it".
    if (edge.kind === 'tab') {
      const hosted = shellHosts(appSrc, toScreen.componentName);
      const shellLinks = !!toRoute && !!shellSurface
        && (shellSurface.routes.has(toRoute)
          || (!!toScreen.routeConst && shellSurface.consts.has(toScreen.routeConst)));
      if (hosted && shellLinks) {
        findings.push({ ...base, status: 'wired', detail: `tab edge — the shell hosts <${toScreen.componentName}> and its nav links to ${toRoute}` });
        continue;
      }
      if (!hosted && landsOnTo) {
        findings.push({
          ...base, status: 'tab-as-push',
          detail: `HIGH: tab edge navigates to ${toRoute} but <${toScreen.componentName}> is not hosted inside the shell — it replaces the shell instead of switching tabs`,
        });
        continue;
      }
      if (hosted && !shellLinks) {
        findings.push({
          ...base, status: 'missing',
          detail: `tab edge — the shell hosts <${toScreen.componentName}> but its nav never links to ${toRoute}: the tab is unreachable`,
        });
        continue;
      }
      findings.push({
        ...base, status: 'missing',
        detail: `tab edge — <${toScreen.componentName}> is neither hosted by the shell nor navigated to`,
      });
      continue;
    }

    // ── Step modal: the edge passes through a modal that must be presented ────
    if (edge.viaModalId) {
      const presenter = modalPresenterName(edge.viaModalId);
      if (landsOnTo && countPresenterCalls(fromSrc, presenter, edge.viaModalId) === 0) {
        findings.push({
          ...base, status: 'missing-step-presenter',
          detail: `FROM navigates to ${toRoute} but never calls ${presenter}() — the intermediate modal is skipped`,
        });
        continue;
      }
    }

    if (landsOnTo) {
      const verbs = toRoute ? [...(surface.verbsByRoute.get(toRoute) ?? [])] : [];
      if (edge.kind === 'replace' && verbs.length > 0 && !verbs.some((v) => REPLACE_VERBS.has(v))) {
        findings.push({
          ...base, status: 'wrong-verb',
          detail: `MED: 'replace' edge implemented with ${verbs.join('/')} — history keeps the FROM screen`,
        });
        continue;
      }
      findings.push({ ...base, status: 'wired', detail: `FROM navigates to ${toRoute}${verbs.length ? ` via ${verbs.join('/')}` : ''}` });
      continue;
    }

    // ── Dead trigger, with the one safe auto-fix ─────────────────────────────
    const dead = findDeadHandlers(fromSrc);
    const named = edge.label
      ? dead.find((d) => enclosingMentions(fromSrc, d.start, edge.label!))
      : undefined;
    if (named) {
      const toConst = toScreen.routeConst;
      // SAFE-BY-CONSTRUCTION: only wire when `navigate` is already in scope. Adding
      // the import alone would emit a call to an undefined binding — a compile error
      // dressed up as an auto-fix. Hoisting a `useNavigate()` into an unknown
      // component body is not a transformation we can make blind.
      const navInScope = /\bconst\s+navigate\s*=\s*useNavigate\s*\(\s*\)/.test(fromSrc);
      if (!opts.dryRun && !opts.noAutoFix && toConst && ix.routesFile && navInScope) {
        const wired = wireDeadHandler(fromSrc, named, toConst);
        if (wired) {
          const next = ensureNamedImport(wired, 'ROUTES', importPathBetween(fromScreen.file, ix.routesFile));
          srcCache.set(fromScreen.file, next);
          await fs.writeFile(fromScreen.file, next, 'utf-8');
          autoFixes++;
          findings.push({
            ...base, status: 'wired', autoFixed: true, elementHow: 'deterministic',
            detail: `dead trigger '${edge.label}' auto-wired to navigate(ROUTES.${toConst}) (${toRoute})`,
          });
          continue;
        }
      }
      const why = !toConst ? ' — TO has no route constant to wire it to'
        : !navInScope ? ' — not auto-wired: no `const navigate = useNavigate()` in scope'
          : '';
      findings.push({
        ...base, status: 'dead-trigger', elementHow: 'deterministic',
        detail: `element '${edge.label}' exists but its ${named.handler} handler is empty (${named.kind})${why}`,
      });
      continue;
    }

    // ── Navigates somewhere, but not to TO ────────────────────────────────────
    if (surface.routes.size > 0) {
      const actual = [...surface.routes][0];
      const actualScreen = ix.byRoute.get(actual);
      findings.push({
        ...base, status: 'wrong-target',
        actualTargetRoute: actual,
        ...(actualScreen?.canonicalId ? { actualTargetCanonicalId: actualScreen.canonicalId } : {}),
        detail: `FROM navigates, but to ${[...surface.routes].join(', ')} — never to ${toRoute}`,
      });
      continue;
    }

    findings.push({
      ...base, status: 'missing',
      detail: `no navigation on FROM reaches ${toRoute}${edge.label ? ` (trigger '${edge.label}' not found)` : ''}`,
    });
  }

  return { findings, autoFixes, screensMapped: mapped.size, screensReferenced: referenced.size };
}

/** Replace `onClick={() => {}}` with a real navigate call. Drift-guarded: the exact
 *  matched text must still be at the recorded offset. */
function wireDeadHandler(src: string, dead: ReturnType<typeof findDeadHandlers>[number], toConst: string): string | null {
  if (src.slice(dead.start, dead.end) !== dead.text) return null;
  const replacement = `${dead.handler}={() => navigate(ROUTES.${toConst})}`;
  return src.slice(0, dead.start) + replacement + src.slice(dead.end);
}

/** The layout component the router wraps tab destinations in. */
function findShellFile(ix: WebAppIndex): string | null {
  if (!ix.routerFile) return null;
  const src = fsSync.readFileSync(ix.routerFile, 'utf-8');
  const m = /<Route\s+element=\{\s*<\s*([A-Z][A-Za-z0-9_$]*)\b[^>]*\/>\s*\}\s*>/.exec(src);
  if (!m) return null;
  return parseImports(src, ix.routerFile).get(m[1]) ?? null;
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');
