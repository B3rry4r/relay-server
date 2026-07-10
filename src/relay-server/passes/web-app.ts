/**
 * web-app.ts — the shared React / Next.js app index used by every Phase 7 pass.
 *
 * The Flutter strategies resolve a canonical screen to a file through one
 * convention (`lib/screens/*.dart` + a `// canonicalId:` header) and then each
 * pass re-implements its own regexes on top. On web we do it ONCE, here, so the
 * six passes agree about what a screen is, where its route lives, and which
 * component renders it.
 *
 * Resolution is layered, most-authoritative first:
 *   1. the `// canonicalId: <id> route: <route>` header stamped on generated
 *      screens (the same marker Dart carries);
 *   2. the route table (`src/router/routes.ts`) + the router element map parsed
 *      out of `App.tsx` — data the pipeline itself emitted;
 *   3. Next's file-system router (`app/<segment>/page.tsx`).
 *
 * Nothing here guesses from a file name.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ── Framework ────────────────────────────────────────────────────────────────

export type WebKind = 'react' | 'next';

/** `next` is NOT a flavour of `react` for our purposes: App Router has no central
 *  `<Routes>` table — the route IS the directory — so route resolution, dead-route
 *  removal and semantic rename all differ. Detect it distinctly. */
export async function detectWebKind(projectRoot: string): Promise<WebKind | null> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fsSync.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) return 'next';
    if (deps.react) return 'react';
  } catch { /* unreadable package.json → not a web app we can index */ }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface WebScreenFile {
  /** Canonical id exactly as written in the header (`c_88_4361`), when present. */
  canonicalId: string | null;
  /** Route path this screen is mounted at (`/88-4361`), when resolvable. */
  route: string | null;
  /** Route-table key (`escrow`) for `ROUTES.escrow`, when resolvable. */
  routeConst: string | null;
  /** Absolute path of the file exporting the screen component. */
  file: string;
  /** Exported component name (`EscrowScreen`). */
  componentName: string;
  /** True when the router mounts a `<PlaceholderScreen …>` here rather than a real screen. */
  placeholder: boolean;
}

export interface WebAppIndex {
  kind: WebKind;
  projectRoot: string;
  srcDir: string;
  screensDir: string;
  componentsDir: string;
  /** `src/router/routes.ts` (react) — null on next, whose routes are directories. */
  routesFile: string | null;
  /** `src/App.tsx` (react) — the `<Routes>` table. Null on next. */
  routerFile: string | null;
  themeFile: string | null;
  resourcesFile: string | null;
  modalControllerFile: string | null;
  constToRoute: Map<string, string>;
  routeToConst: Map<string, string>;
  /** idCore (`88_4361`) → screen file. */
  byId: Map<string, WebScreenFile>;
  /** route path → screen file. */
  byRoute: Map<string, WebScreenFile>;
}

/** `c_88_4361` / `m_88_6412` → `88_4361` / `88_6412`. Mirrors the Dart passes so a
 *  modal id matches the `c_`-prefixed header its built file carries. */
export const idCore = (id: string): string => String(id).replace(/^[cm]_/, '');

/** `88:6412` → `88_6412`. */
export const frameCore = (frameId: string): string => String(frameId).replace(/[^a-zA-Z0-9]+/g, '_');

/** The route the skeleton mints for a frame: `88:4361` → `/88-4361`. */
export const frameRoute = (frameId: string): string => `/${String(frameId).replace(/[^a-zA-Z0-9]+/g, '-')}`;

/** The presenter a folded modal exposes: `m_88_6412` → `showModal_88_6412`. Must
 *  match design-system.ts, which is what the build agent was told to emit. */
export const modalPresenterName = (modalId: string): string => `showModal_${idCore(modalId)}`;

// ── File walking ─────────────────────────────────────────────────────────────

const CODE_RE = /\.(tsx|jsx|ts|js)$/;

export async function listSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: fsSync.Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next' || e.name === '_preview') continue;
      await listSourceFiles(p, out);
    } else if (CODE_RE.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// ── Header ───────────────────────────────────────────────────────────────────

const HEADER_RE = /^\/\/\s*canonicalId:\s*(\S+)(?:\s+route:\s*(\S+))?/m;

export function readHeader(src: string): { canonicalId: string; route: string | null } | null {
  const m = HEADER_RE.exec(src);
  return m ? { canonicalId: m[1], route: m[2] ?? null } : null;
}

/** Stamp the canonical header onto a generated screen, idempotently. The Dart
 *  screens carry it; the web screens never did, which is why every pass that
 *  resolves a screen by id had nothing to resolve against. */
export function stampHeader(src: string, canonicalId: string, route: string | null): string {
  if (HEADER_RE.test(src)) return src;
  const header = route
    ? `// canonicalId: ${canonicalId} route: ${route}\n`
    : `// canonicalId: ${canonicalId}\n`;
  return header + src;
}

// ── Route table (react) ──────────────────────────────────────────────────────

/** Parse `export const ROUTES = { escrow: '/88-4361', … }`. */
export function parseRouteTable(src: string): { constToRoute: Map<string, string>; routeToConst: Map<string, string> } {
  const constToRoute = new Map<string, string>();
  const routeToConst = new Map<string, string>();
  const block = /export\s+const\s+ROUTES\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/.exec(src)
    ?? /export\s+const\s+ROUTES\s*=\s*\{([\s\S]*?)\}\s*;/.exec(src);
  if (!block) return { constToRoute, routeToConst };
  const entry = /([A-Za-z0-9_$]+)\s*:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) {
    constToRoute.set(m[1], m[2]);
    if (!routeToConst.has(m[2])) routeToConst.set(m[2], m[1]);
  }
  return { constToRoute, routeToConst };
}

/** Parse the `<Route path={ROUTES.x} element={<Y … />} />` table out of App.tsx.
 *  Also handles `path="/literal"`. Returns route-path → element component name. */
export function parseRouteElements(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<Route\s+[^>]*?path=(?:\{ROUTES\.([A-Za-z0-9_$]+)\}|["']([^"']+)["'])[^>]*?element=\{\s*<\s*([A-Za-z0-9_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const key = m[1] ? `ROUTES.${m[1]}` : m[2];
    out.set(key, m[3]);
  }
  return out;
}

/** Map an imported symbol to the file that exports it: `import { X } from './a/b'`. */
export function parseImports(src: string, fromFile: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[3];
    if (!spec.startsWith('.')) continue;
    const names: string[] = [];
    if (m[1]) names.push(m[1]);
    if (m[2]) for (const raw of m[2].split(',')) {
      const n = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.push(n);
    }
    const resolved = resolveImport(fromFile, spec);
    if (!resolved) continue;
    for (const n of names) out.set(n, resolved);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`,
    path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fsSync.existsSync(cand) && fsSync.statSync(cand).isFile()) return cand;
  }
  return null;
}

// ── Index construction ───────────────────────────────────────────────────────

const firstExisting = (root: string, ...rels: string[]): string | null => {
  for (const r of rels) {
    const p = path.join(root, r);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
};

export async function loadWebApp(projectRoot: string): Promise<WebAppIndex | null> {
  const kind = await detectWebKind(projectRoot);
  if (!kind) return null;

  const srcDir = firstExisting(projectRoot, 'src', 'app') ?? path.join(projectRoot, 'src');
  const index: WebAppIndex = {
    kind,
    projectRoot,
    srcDir,
    screensDir: firstExisting(projectRoot, 'src/screens', 'src/pages', 'app') ?? path.join(srcDir, 'screens'),
    componentsDir: firstExisting(projectRoot, 'src/components', 'components') ?? path.join(srcDir, 'components'),
    routesFile: firstExisting(projectRoot, 'src/router/routes.ts', 'src/routes.ts'),
    routerFile: firstExisting(projectRoot, 'src/App.tsx', 'src/app.tsx'),
    themeFile: firstExisting(projectRoot, 'src/theme/theme.ts', 'src/theme/index.ts', 'src/theme.ts'),
    resourcesFile: firstExisting(projectRoot, 'src/resources/assets.ts', 'src/assets.ts'),
    modalControllerFile: firstExisting(projectRoot, 'src/modal/modalController.ts'),
    constToRoute: new Map(),
    routeToConst: new Map(),
    byId: new Map(),
    byRoute: new Map(),
  };

  if (index.routesFile) {
    const t = parseRouteTable(await fs.readFile(index.routesFile, 'utf-8'));
    index.constToRoute = t.constToRoute;
    index.routeToConst = t.routeToConst;
  }

  // Layer 1 — headers. Authoritative when present.
  const files = await listSourceFiles(index.srcDir);
  const byFile = new Map<string, string>();
  for (const f of files) {
    const src = await fs.readFile(f, 'utf-8').catch(() => '');
    if (!src) continue;
    byFile.set(f, src);
    const h = readHeader(src);
    if (!h) continue;
    const comp = topLevelComponent(src);
    if (!comp) continue;
    const route = h.route ?? null;
    const entry: WebScreenFile = {
      canonicalId: h.canonicalId,
      route,
      routeConst: route ? index.routeToConst.get(route) ?? null : null,
      file: f,
      componentName: comp,
      placeholder: false,
    };
    index.byId.set(idCore(h.canonicalId), entry);
    if (route) index.byRoute.set(route, entry);
  }

  // Layer 2 — the router element table (react).
  if (kind === 'react' && index.routerFile) {
    const appSrc = byFile.get(index.routerFile) ?? await fs.readFile(index.routerFile, 'utf-8').catch(() => '');
    const elements = parseRouteElements(appSrc);
    const imports = parseImports(appSrc, index.routerFile);
    for (const [key, component] of elements) {
      const routeConst = key.startsWith('ROUTES.') ? key.slice(7) : null;
      const route = routeConst ? index.constToRoute.get(routeConst) ?? null : key;
      if (!route || route.startsWith('/_preview')) continue;
      const placeholder = /^Placeholder/.test(component);
      const file = imports.get(component) ?? null;
      const core = routeCore(route);
      if (!core) continue;
      const existing = index.byId.get(core);
      if (existing) { existing.placeholder = placeholder; existing.routeConst ??= routeConst; continue; }
      if (!file && !placeholder) continue;
      const entry: WebScreenFile = {
        canonicalId: null, route, routeConst,
        file: file ?? index.routerFile,
        componentName: component,
        placeholder,
      };
      index.byId.set(core, entry);
      index.byRoute.set(route, entry);
    }
  }

  // Layer 3 — Next's file-system router: app/<segment>/page.tsx.
  if (kind === 'next') {
    for (const f of files) {
      if (!/[/\\]page\.(tsx|jsx)$/.test(f)) continue;
      const segment = path.relative(index.screensDir, path.dirname(f)).split(path.sep).join('/');
      const route = `/${segment}`;
      const core = routeCore(route);
      if (!core || index.byId.has(core)) continue;
      const src = byFile.get(f) ?? '';
      const comp = topLevelComponent(src) ?? 'Page';
      const entry: WebScreenFile = {
        canonicalId: null, route, routeConst: null, file: f, componentName: comp,
        placeholder: /Placeholder/.test(src),
      };
      index.byId.set(core, entry);
      index.byRoute.set(route, entry);
    }
  }

  return index;
}

/** `/88-4361` → `88_4361`, so a frame-derived route joins the same keyspace as a
 *  canonical id core. Returns null for semantic routes like `/escrow`. */
export function routeCore(route: string): string | null {
  const m = /^\/(\d+)-(\d+)$/.exec(route);
  return m ? `${m[1]}_${m[2]}` : null;
}

/** The exported screen/page component. Prefers a `*Screen`/`*Page` export, else the
 *  default export, else the first exported function component. */
export function topLevelComponent(src: string): string | null {
  const named = /export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_$]*(?:Screen|Page))\b/.exec(src)
    ?? /export\s+const\s+([A-Z][A-Za-z0-9_$]*(?:Screen|Page))\s*[:=]/.exec(src);
  if (named) return named[1];
  const def = /export\s+default\s+function\s+([A-Z][A-Za-z0-9_$]*)/.exec(src);
  if (def) return def[1];
  const anyFn = /export\s+(?:const|function)\s+([A-Z][A-Za-z0-9_$]*)/.exec(src);
  return anyFn ? anyFn[1] : null;
}

/** Resolve a canonical screen (or modal) id to its built file. `frameIds` lets a
 *  screen whose header is missing fall back to its frame-derived route. */
export function resolveScreen(index: WebAppIndex, canonicalId: string, frameIds: string[] = []): WebScreenFile | null {
  const direct = index.byId.get(idCore(canonicalId));
  if (direct) return direct;
  for (const fid of frameIds) {
    const byFrame = index.byId.get(frameCore(fid));
    if (byFrame) return byFrame;
    const byRoute = index.byRoute.get(frameRoute(fid));
    if (byRoute) return byRoute;
  }
  return null;
}

// ── Navigation ───────────────────────────────────────────────────────────────

export interface NavTarget {
  /** Route path when known (`/88-4361`), else null. */
  route: string | null;
  /** Route-table key when the call went through `ROUTES.x`. */
  routeConst: string | null;
  /** `navigate` | `Link` | `Navigate` | `router.push` | `router.replace` | `redirect`. */
  verb: string;
  /** True when the verb replaces history rather than pushing. */
  replaces: boolean;
}

const REPLACE_VERBS = new Set(['router.replace', 'redirect', 'Navigate', 'navigate.replace']);

/** Every navigation site in a React/Next source file. Deliberately syntactic: we
 *  match the shapes the skeleton and the build agent actually emit. */
export function collectNavTargets(src: string, constToRoute: Map<string, string>): NavTarget[] {
  const out: NavTarget[] = [];
  const push = (routeConst: string | null, literal: string | null, verb: string) => {
    const route = routeConst ? constToRoute.get(routeConst) ?? null : literal;
    // `navigate(-1)` and friends carry no target.
    if (!route && !routeConst) return;
    out.push({ route, routeConst, verb, replaces: REPLACE_VERBS.has(verb) });
  };

  // navigate(ROUTES.x) / navigate('/x') — react-router useNavigate().
  // `navigate(x, { replace: true })` IS a replace: read the options argument, or a
  // screen that correctly replaces history gets reported as pushing.
  const nav = /\bnavigate\s*\(\s*(?:ROUTES\.([A-Za-z0-9_$]+)|['"]([^'"]+)['"])([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = nav.exec(src)) !== null) {
    const replaces = /replace\s*:\s*true/.test(m[3] ?? '');
    push(m[1] ?? null, m[2] ?? null, replaces ? 'navigate.replace' : 'navigate');
  }

  // <Link to={ROUTES.x}> / <Link to="/x"> / <Navigate to=…>
  const link = /<(Link|Navigate)\s+[^>]*?to=(?:\{ROUTES\.([A-Za-z0-9_$]+)\}|["']([^"']+)["'])/g;
  while ((m = link.exec(src)) !== null) push(m[2] ?? null, m[3] ?? null, m[1]);

  // next/navigation + next/router: router.push('/x') / router.replace(…) / redirect(…)
  const next = /\b(?:router\s*\.\s*(push|replace)|(redirect))\s*\(\s*(?:ROUTES\.([A-Za-z0-9_$]+)|['"]([^'"]+)['"])/g;
  while ((m = next.exec(src)) !== null) {
    const verb = m[2] ? 'redirect' : `router.${m[1]}`;
    push(m[3] ?? null, m[4] ?? null, verb);
  }
  return out;
}

/** Every `ROUTES.<key>` mentioned anywhere in a file. A nav bar builds its links
 *  from a data array (`<Link to={item.to}>`), so the literal target never appears
 *  at the call site — but the route constant does. Mirrors the Dart pass's
 *  `AppRoutes.<const>` scan. */
export function collectRouteConstRefs(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\bROUTES\s*\.\s*([A-Za-z0-9_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** Presenter call-sites for a folded modal: `showModal_88_6412(` . */
export function countPresenterCalls(src: string, presenter: string): number {
  const re = new RegExp(`\\b${escapeRe(presenter)}\\s*\\(`, 'g');
  return (src.match(re) ?? []).length;
}

/** Any modal presenter at all — the React analogue of `showModalBottomSheet|showDialog`. */
export function countAnyPresenterCalls(src: string): number {
  return (src.match(/\bshowModal_[0-9_]+\s*\(|\bmodalController\s*\.\s*open\s*\(/g) ?? []).length;
}

// ── Dead triggers ────────────────────────────────────────────────────────────

export interface DeadHandler {
  /** `onClick` | `onPress` | … */
  handler: string;
  /** Full matched text, so a rewrite can drift-guard on it. */
  text: string;
  start: number;
  end: number;
  kind: 'empty-block' | 'null-handler' | 'todo-body';
}

/** `onClick={() => {}}`, `onClick={undefined}`, `onClick={() => { /* TODO *​/ }}` */
export function findDeadHandlers(src: string): DeadHandler[] {
  const out: DeadHandler[] = [];
  const re = /\b(onClick|onSelect|onPress|onActivate)\s*=\s*\{\s*(undefined|null|\(\s*\)\s*=>\s*(?:undefined|\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*\}))\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = m[2];
    const kind: DeadHandler['kind'] =
      body === 'undefined' || body === 'null' ? 'null-handler'
        : /TODO|\/\//.test(body) ? 'todo-body'
          : 'empty-block';
    out.push({ handler: m[1], text: m[0], start: m.index, end: m.index + m[0].length, kind });
  }
  return out;
}

/** Does the JSX element enclosing `pos` mention `label` (its visible text)? Used to
 *  pin a dead handler to the flow edge's named trigger element. */
export function enclosingMentions(src: string, pos: number, label: string): boolean {
  const from = Math.max(0, pos - 600);
  const to = Math.min(src.length, pos + 600);
  return src.slice(from, to).toLowerCase().includes(label.toLowerCase());
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Import specifier from one file to another, POSIX, extension-less, `./`-prefixed. */
export function importPathBetween(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  rel = rel.replace(/\.(tsx|ts|jsx|js)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** Add `import { name } from 'spec'` when absent; merge into an existing brace import. */
export function ensureNamedImport(src: string, name: string, spec: string): string {
  const existing = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRe(spec)}['"]`).exec(src);
  if (existing) {
    const names = existing[1].split(',').map(s => s.trim()).filter(Boolean);
    if (names.includes(name)) return src;
    const merged = `import { ${[...names, name].join(', ')} } from '${spec}'`;
    return src.slice(0, existing.index) + merged + src.slice(existing.index + existing[0].length);
  }
  if (new RegExp(`from\\s*['"]${escapeRe(spec)}['"]`).test(src)) return src;
  const lastImport = [...src.matchAll(/^import\s.*$/gm)].pop();
  const line = `import { ${name} } from '${spec}';`;
  if (!lastImport) return `${line}\n${src}`;
  const at = lastImport.index! + lastImport[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}

/** True when `symbol` still appears outside its own import statement. */
export function stillReferenced(src: string, symbol: string): boolean {
  const withoutImports = src.replace(/^import\s.*$/gm, '');
  return new RegExp(`\\b${escapeRe(symbol)}\\b`).test(withoutImports);
}
