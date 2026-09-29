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
 *   3. Next's file-system router — the App Router (`app/` or `src/app/`, route
 *      groups, private folders, `%5F` escapes, dynamic segments) and the Pages
 *      Router (`pages/` or `src/pages/`).
 *
 * Every source root that exists is walked (`src/`, `app/`, `components/`, `lib/`,
 * `pages/`), and imports resolve through tsconfig/jsconfig `paths` + `baseUrl`
 * (Next's default `@/…` alias), so a pipeline-written file such as the asset
 * pass's `src/resources/assets.ts` can never hide a Next `app/` directory.
 *
 * Nothing here guesses from a file name.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { detectWebKindFromPackage, type WebKind } from './framework';

// ── Framework ────────────────────────────────────────────────────────────────

export type { WebKind };

/** `next` is NOT a flavour of `react` for our purposes: App Router has no central
 *  `<Routes>` table — the route IS the directory — so route resolution, dead-route
 *  removal and semantic rename all differ. Detect it distinctly. Delegates to the
 *  one shared detector (./framework) so no pass can disagree about the framework. */
export async function detectWebKind(projectRoot: string): Promise<WebKind | null> {
  return detectWebKindFromPackage(projectRoot);
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
  /** The primary screen root: react → `src/`; next → the App Router dir (`app/` or
   *  `src/app/`), else the Pages Router dir. Walk `sourceRoots` (listWebSources) for
   *  "every file of the app" — this is ONE root, not all of them. */
  srcDir: string;
  /** Every existing source root of the app, outermost only (a root nested inside
   *  another is not repeated): some of `src/`, `app/`, `pages/`, `components/`, `lib/`. */
  sourceRoots: string[];
  /** Next App Router dir (`app/` wins over `src/app/`, as in Next), else null. */
  appDir: string | null;
  /** Next Pages Router dir (`pages/` wins over `src/pages/`), else null. */
  pagesDir: string | null;
  /** Where pipeline-owned files live (CONTRACTS §5): next → the app dir's parent
   *  (`.` or `src`); react (Vite) → `src/`. */
  pipelineRoot: string;
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
      // Verify-harness previews are never shipped UI: `_preview` (react + flutter) and
      // Next's routable escape `%5Fpreview` (a bare `_preview` is a private folder).
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next' || e.name === '.git'
        || e.name === '_preview' || /^%5Fpreview$/i.test(e.name)) continue;
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

/** A screen/modal file that is still the skeleton's stub — the web skeleton
 *  (web-skeleton.ts) writes `TODO(build)` and renders `<PlaceholderScreen>` until the
 *  per-screen build replaces the body. A header-stamped stub is NOT a built screen:
 *  it is indexed `placeholder`, so 7d grades an edge to it `missing`, 7e skips it. */
export function isSkeletonStub(src: string): boolean {
  return /\bTODO\(build\)/.test(src) || /<PlaceholderScreen\b/.test(src);
}

/** A page/route module whose only JSX element is `<PlaceholderScreen …/>` (imports,
 *  comments and fragments aside) — a slot nothing was ever built into. */
export function isPlaceholderOnlyPage(src: string): boolean {
  const code = src.replace(/^import\s.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tags = [...code.matchAll(/<([A-Za-z][A-Za-z0-9_.$]*)/g)].map((m) => m[1]);
  return tags.length > 0 && tags.every((t) => t === 'PlaceholderScreen');
}

/** Does `src` navigate/link to `route` (as a string literal) or its ROUTES constant? */
export function sourceLinksTo(src: string, route: string, routeConst: string | null): boolean {
  const lit = new RegExp(`['"\`]${escapeRe(route)}['"\`]`);
  return lit.test(src) || (!!routeConst && new RegExp(`\\bROUTES\\s*\\.\\s*${escapeRe(routeConst)}\\b`).test(src));
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

/** Map an imported symbol to the file that exports it: `import { X } from './a/b'`,
 *  and — through the nearest tsconfig/jsconfig `paths` + `baseUrl` — aliased
 *  specifiers such as Next's default `import { X } from '@/components/X'`. Bare
 *  package specifiers (`react`, `next/navigation`) resolve to nothing and are skipped. */
export function parseImports(src: string, fromFile: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[3];
    const names: string[] = [];
    if (m[1]) names.push(m[1]);
    if (m[2]) for (const raw of m[2].split(',')) {
      const n = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.push(n);
    }
    if (!names.length) continue;
    const resolved = resolveSpecifier(fromFile, spec);
    if (!resolved) continue;
    for (const n of names) out.set(n, resolved);
  }
  return out;
}

/** Resolve an import specifier from `fromFile` to a source file on disk: relative
 *  paths directly; anything else through the tsconfig/jsconfig that governs
 *  `fromFile` (`paths` patterns, then `baseUrl`). Null when it is a package or does
 *  not exist. */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    return resolveImport(fromFile, spec);
  }
  const cfg = pathConfigFor(fromFile);
  if (!cfg) return null;
  for (const a of cfg.aliases) {
    let star: string | null = null;
    if (a.hasStar) {
      if (spec.length < a.prefix.length + a.suffix.length || !spec.startsWith(a.prefix) || !spec.endsWith(a.suffix)) continue;
      star = spec.slice(a.prefix.length, spec.length - a.suffix.length);
    } else if (spec !== a.prefix) continue;
    for (const t of a.targets) {
      const hit = fileCandidate(star == null ? t : t.replace('*', star));
      if (hit) return hit;
    }
  }
  // TS resolves a non-relative name against baseUrl too (`components/X` with baseUrl '.').
  if (cfg.baseUrl) return fileCandidate(path.join(cfg.baseUrl, spec));
  return null;
}

function resolveImport(fromFile: string, spec: string): string | null {
  return fileCandidate(path.resolve(path.dirname(fromFile), spec));
}

function fileCandidate(base: string): string | null {
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`,
    path.join(base, 'index.tsx'), path.join(base, 'index.ts'), path.join(base, 'index.jsx'), path.join(base, 'index.js')]) {
    if (fsSync.existsSync(cand) && fsSync.statSync(cand).isFile()) return cand;
  }
  return null;
}

// ── tsconfig / jsconfig path aliases ─────────────────────────────────────────

export interface PathAlias {
  /** Pattern text before `*` (or the whole pattern when there is no `*`). */
  prefix: string;
  suffix: string;
  hasStar: boolean;
  /** Absolute target patterns (may contain one `*`). */
  targets: string[];
}

export interface PathConfig {
  /** The config file the aliases came from (tsconfig.json / jsconfig.json). */
  configFile: string;
  baseUrl: string | null;
  aliases: PathAlias[];
}

/** Parse JSON-with-comments the way tsc accepts it: `//` and `/* *\/` comments and
 *  trailing commas (the Vite react-ts template ships all three). Strings are kept
 *  intact. Returns null when it still does not parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(out); } catch { return null; }
}

interface RawTsconfig {
  extends?: string | string[];
  references?: Array<{ path?: string }>;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

function readTsconfig(file: string): RawTsconfig | null {
  try { return parseJsonc(fsSync.readFileSync(file, 'utf8')) as RawTsconfig | null; } catch { return null; }
}

/** baseUrl + paths for one config file, following relative `extends` chains (the
 *  child wins, and `paths` resolve against the config that declared them / its
 *  baseUrl, exactly as tsc does). */
function effectivePaths(file: string, depth = 0): { baseUrl: string | null; paths: Record<string, string[]>; pathsBase: string } | null {
  if (depth > 8) return null;
  const cfg = readTsconfig(file);
  if (!cfg) return null;
  const dir = path.dirname(file);
  let res: { baseUrl: string | null; paths: Record<string, string[]>; pathsBase: string } = { baseUrl: null, paths: {}, pathsBase: dir };
  for (const ext of Array.isArray(cfg.extends) ? cfg.extends : cfg.extends ? [cfg.extends] : []) {
    if (!ext.startsWith('.')) continue;   // package-published bases (@tsconfig/…) carry no app paths
    const extFile = ext.endsWith('.json') ? path.resolve(dir, ext) : path.resolve(dir, `${ext}.json`);
    const parent = effectivePaths(extFile, depth + 1);
    if (parent) res = parent;
  }
  const co = cfg.compilerOptions ?? {};
  if (typeof co.baseUrl === 'string') res = { ...res, baseUrl: path.resolve(dir, co.baseUrl), pathsBase: path.resolve(dir, co.baseUrl) };
  if (co.paths && typeof co.paths === 'object') res = { ...res, paths: co.paths, pathsBase: res.baseUrl ?? dir };
  return res;
}

function toAliases(paths: Record<string, string[]>, base: string): PathAlias[] {
  const out: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    out.push({
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      hasStar: star >= 0,
      targets: targets.filter((t) => typeof t === 'string').map((t) => path.resolve(base, t)),
    });
  }
  // Longest prefix first — tsc picks the most specific pattern.
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** The path config of the project rooted at `configDir`: its tsconfig.json (or
 *  jsconfig.json), and — when that is a solution file with `references` (the Vite
 *  react-ts template: `files: []` + tsconfig.app.json) — the referenced configs. */
export function loadPathConfig(configDir: string): PathConfig | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(configDir, name);
    if (!fsSync.existsSync(file)) continue;
    const own = effectivePaths(file);
    const aliases: PathAlias[] = own ? toAliases(own.paths, own.pathsBase) : [];
    let baseUrl = own?.baseUrl ?? null;
    for (const ref of readTsconfig(file)?.references ?? []) {
      if (!ref?.path) continue;
      let refFile = path.resolve(configDir, ref.path);
      if (fsSync.existsSync(refFile) && fsSync.statSync(refFile).isDirectory()) refFile = path.join(refFile, 'tsconfig.json');
      const r = effectivePaths(refFile);
      if (!r) continue;
      aliases.push(...toAliases(r.paths, r.pathsBase));
      baseUrl ??= r.baseUrl;
    }
    aliases.sort((a, b) => b.prefix.length - a.prefix.length);
    return { configFile: file, baseUrl, aliases };
  }
  return null;
}

const pathConfigCache = new Map<string, { key: string; cfg: PathConfig | null }>();

/** The path config governing `file`: the nearest tsconfig/jsconfig walking up from
 *  it, stopping at the first directory that has a package.json (the app root).
 *  Cached per config dir, invalidated when the config file changes. */
export function pathConfigFor(file: string): PathConfig | null {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    const ts = path.join(dir, 'tsconfig.json');
    const js = path.join(dir, 'jsconfig.json');
    const cfgFile = fsSync.existsSync(ts) ? ts : fsSync.existsSync(js) ? js : null;
    if (cfgFile) {
      let key = '';
      try { key = String(fsSync.statSync(cfgFile).mtimeMs); } catch { /* raced */ }
      const hit = pathConfigCache.get(dir);
      if (hit && hit.key === key) return hit.cfg;
      const cfg = loadPathConfig(dir);
      pathConfigCache.set(dir, { key, cfg });
      return cfg;
    }
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ── Next.js file-system routes ───────────────────────────────────────────────

/** The URL route an App Router file serves, or null when it serves none.
 *  `app/(tabs)/10-2/page.tsx` → `/10-2` (route groups are not URL segments),
 *  `app/@modal/x/page.tsx` → `/x` (parallel-route slots neither), `app/_lib/…` →
 *  null (a `_` folder is PRIVATE — opted out of routing), `app/%5Fpreview/10-3/…` →
 *  `/_preview/10-3` (`%5F` is the escape for a literal `_`), intercepting routes
 *  (`(.)x`, `(..)x`) → null, `[id]` / `[...slug]` kept verbatim. */
export function nextAppRoute(appDir: string, file: string): string | null {
  if (!/^page\.(tsx|jsx|ts|js)$/.test(path.basename(file))) return null;
  const rel = path.relative(appDir, path.dirname(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segs: string[] = [];
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    if (/^\(\.+\)/.test(seg)) return null;                         // intercepting route
    if (/^\(.*\)$/.test(seg)) continue;                          // route group
    if (seg.startsWith('@')) continue;                            // parallel-route slot
    if (seg.startsWith('_')) return null;                         // private folder
    segs.push(seg.replace(/%5F/gi, '_'));
  }
  return `/${segs.join('/')}`;
}

/** The URL route a Pages Router file serves, or null (`_app`, `_document`, `api/`). */
export function nextPagesRoute(pagesDir: string, file: string): string | null {
  if (!/\.(tsx|jsx|ts|js)$/.test(file)) return null;
  const rel = path.relative(pagesDir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.replace(/\.(tsx|jsx|ts|js)$/, '').split(path.sep);
  if (parts[0] === 'api' || parts.some((p) => /^_(app|document|error)$/.test(p))) return null;
  if (parts[parts.length - 1] === 'index') parts.pop();
  return `/${parts.join('/')}`;
}

// ── Index construction ───────────────────────────────────────────────────────

const firstExisting = (root: string, ...rels: string[]): string | null => {
  for (const r of rels) {
    const p = path.join(root, r);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
};

const isDir = (p: string): boolean => { try { return fsSync.statSync(p).isDirectory(); } catch { return false; } };

/** Every existing source root, outermost only. */
function sourceRootsOf(projectRoot: string): string[] {
  const cands = ['src', 'app', 'pages', 'components', 'lib'].map((d) => path.join(projectRoot, d)).filter(isDir);
  return cands.filter((d) => !cands.some((o) => o !== d && d.startsWith(o + path.sep)));
}

/** Every source file of the app across all its roots (deduped, stable order).
 *  Passes that need "the whole app" walk this, never one hardcoded directory. */
export async function listWebSources(ix: Pick<WebAppIndex, 'sourceRoots'>): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of ix.sourceRoots) for (const f of await listSourceFiles(r)) if (!seen.has(f)) { seen.add(f); out.push(f); }
  return out;
}

export async function loadWebApp(projectRoot: string): Promise<WebAppIndex | null> {
  const kind = await detectWebKind(projectRoot);
  if (!kind) return null;

  // Next: `app/` wins over `src/app/` (and `pages/` over `src/pages/`) — Next itself
  // ignores the src/ copy when the root one exists.
  const appDir = kind === 'next' ? [path.join(projectRoot, 'app'), path.join(projectRoot, 'src', 'app')].find(isDir) ?? null : null;
  const pagesDir = kind === 'next' ? [path.join(projectRoot, 'pages'), path.join(projectRoot, 'src', 'pages')].find(isDir) ?? null : null;
  const routerDir = appDir ?? pagesDir;
  // CONTRACTS §5: pipeline-owned files live beside the app dir's parent.
  const pipelineRoot = kind === 'next'
    ? (routerDir ? path.dirname(routerDir) : projectRoot)
    : path.join(projectRoot, 'src');
  const pr = path.relative(projectRoot, pipelineRoot) || '.';
  const under = (...rels: string[]) => rels.map((r) => path.join(pr, r));

  const srcDir = kind === 'next'
    ? routerDir ?? firstExisting(projectRoot, 'src') ?? path.join(projectRoot, 'src')
    : firstExisting(projectRoot, 'src', 'app') ?? path.join(projectRoot, 'src');
  const index: WebAppIndex = {
    kind,
    projectRoot,
    srcDir,
    sourceRoots: sourceRootsOf(projectRoot),
    appDir,
    pagesDir,
    pipelineRoot,
    screensDir: kind === 'next'
      ? routerDir ?? path.join(srcDir, 'screens')
      : firstExisting(projectRoot, 'src/screens', 'src/pages') ?? path.join(srcDir, 'screens'),
    componentsDir: firstExisting(projectRoot, ...under('components'), 'src/components', 'components') ?? path.join(pipelineRoot, 'components'),
    // react: src/router/routes.ts (the skeleton's table); next: <pipelineRoot>/lib/routes.ts
    // — navigation constants only, the directories remain the routes.
    routesFile: firstExisting(projectRoot, 'src/router/routes.ts', 'src/routes.ts', ...(kind === 'next' ? under('lib/routes.ts') : [])),
    routerFile: kind === 'react' ? firstExisting(projectRoot, 'src/App.tsx', 'src/app.tsx') : null,
    themeFile: firstExisting(projectRoot,
      ...under('lib/theme.ts', 'lib/theme/index.ts', 'lib/theme/theme.ts'),
      'src/theme/theme.ts', 'src/theme/index.ts', 'src/theme.ts'),
    resourcesFile: firstExisting(projectRoot,
      ...under('lib/resources.ts', 'lib/resources/index.ts', 'lib/resources/assets.ts'),
      'src/resources/assets.ts', 'src/assets.ts'),
    modalControllerFile: firstExisting(projectRoot,
      'src/modal/modalController.ts',
      ...under('lib/modal/modalController.ts', 'lib/modalController.ts', 'components/modalController.ts')),
    constToRoute: new Map(),
    routeToConst: new Map(),
    byId: new Map(),
    byRoute: new Map(),
  };
  if (index.sourceRoots.length === 0) index.sourceRoots = [srcDir];

  if (index.routesFile) {
    const t = parseRouteTable(await fs.readFile(index.routesFile, 'utf-8'));
    index.constToRoute = t.constToRoute;
    index.routeToConst = t.routeToConst;
  }

  // Layer 1 — headers, across EVERY source root. Authoritative when present.
  const files = await listWebSources(index);
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
      placeholder: isSkeletonStub(src),
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
      // A semantic route (`/login`, the skeleton's shape) has no frame core: it joins
      // the index by route only. A header already indexed it when present.
      const existing = core ? index.byId.get(core) : index.byRoute.get(route);
      if (existing) { existing.placeholder = existing.placeholder || placeholder; existing.routeConst ??= routeConst; continue; }
      if (!file && !placeholder) continue;
      const entry: WebScreenFile = {
        canonicalId: null, route, routeConst,
        file: file ?? index.routerFile,
        componentName: component,
        placeholder,
      };
      if (core) index.byId.set(core, entry);
      index.byRoute.set(route, entry);
    }
  }

  // Layer 3 — Next's file-system router. The route is computed with Next's own
  // rules (route groups, private folders, %5F, slots), indexed by route string for
  // semantic routes (`/settings`) and additionally by id core for frame routes.
  if (kind === 'next') {
    const pages: Array<{ f: string; route: string }> = [];
    for (const f of files) {
      const route = appDir && isInside(appDir, f) ? nextAppRoute(appDir, f)
        : pagesDir && isInside(pagesDir, f) ? nextPagesRoute(pagesDir, f) : null;
      if (route) pages.push({ f, route });
    }
    for (const { f, route } of pages) {
      if (route.startsWith('/_preview')) continue;   // verify harness, not the app
      const src = byFile.get(f) ?? '';
      const placeholder = /\bPlaceholder[A-Za-z]*\b/.test(src.replace(/^import\s.*$/gm, '')) && !readHeader(src);
      const headerEntry = [...index.byId.values()].find((e) => e.file === f);
      if (headerEntry) {
        // A stamped page: its header id wins, but the URL it is actually served at
        // is the file-system route — index that too so `/settings` resolves.
        if (!index.byRoute.has(route)) index.byRoute.set(route, headerEntry);
        continue;
      }
      const entry: WebScreenFile = {
        canonicalId: null, route, routeConst: null, file: f,
        componentName: topLevelComponent(src) ?? 'Page',
        placeholder,
      };
      if (!index.byRoute.has(route)) index.byRoute.set(route, entry);
      const core = routeCore(route) ?? routeCore(`/${route.split('/').pop() ?? ''}`);
      if (core && !index.byId.has(core)) index.byId.set(core, entry);
    }
  }

  return index;
}

const isInside = (dir: string, f: string): boolean => f === dir || f.startsWith(dir + path.sep);

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

  // <Link to={ROUTES.x}> / <Link to="/x"> / <Navigate to=…> — and Next's
  // <Link href="/x"> / <Link href={ROUTES.x}> (also a plain <a href="/x">).
  const link = /<(Link|Navigate|a)\s+[^>]*?(?:to|href)=(?:\{\s*ROUTES\.([A-Za-z0-9_$]+)\s*\}|["'](\/[^"']*)["']|\{\s*['"`](\/[^'"`]*)['"`]\s*\})/g;
  while ((m = link.exec(src)) !== null) push(m[2] ?? null, m[3] ?? m[4] ?? null, m[1] === 'a' ? 'Link' : m[1]);

  // A nav bar built from a data array (`{ href: '/10-4', label: 'Profile' }` mapped
  // into <Link href={t.href}>): the literal lives in the item, not at the call site.
  // Counted only in a file that renders a Link/anchor/navigate at all.
  if (/<(?:Link|a)\b|\bnavigate\s*\(|router\s*\.\s*push/.test(src)) {
    const item = /\b(?:href|to|path)\s*:\s*['"`](\/[^'"`]*)['"`]/g;
    while ((m = item.exec(src)) !== null) push(null, m[1], 'Link');
  }

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

/** Presenter call-sites for a folded modal.
 *
 *  Two shapes are equally valid, and counting only the first reports a working modal
 *  as unreachable:
 *    1. `showModal_88_6412()` — the presenter the packet contract asks for;
 *    2. `modalController.open('m_135_2685', <Content onSubmit={…}/>)` — opened
 *       directly, which is what a screen does when the modal needs a prefill or a
 *       submit callback the fixed-signature presenter cannot carry.
 *
 *  The modal id in (2) is a literal, so it identifies the modal exactly.
 *
 *  A presenter's own DECLARATION is not a call site: `function showModal_10_8() {
 *  modalController.open('m_10_8', …) }` matched both shapes, so a screen that merely
 *  imported the presenter module — and left its "Log out" button dead — was credited
 *  twice (PG-11). Declarations are stripped before counting. */
export function countPresenterCalls(src: string, presenter: string, modalId?: string): number {
  const code = stripPresenterDeclarations(src);
  const byPresenter = (code.match(new RegExp(`\\b${escapeRe(presenter)}\\s*\\(`, 'g')) ?? []).length;
  if (!modalId) return byPresenter;
  const direct = (code.match(
    new RegExp(`\\bmodalController\\s*\\.\\s*open\\s*\\(\\s*['"\`]${escapeRe(modalId)}['"\`]`, 'g'),
  ) ?? []).length;
  return byPresenter + direct;
}

/** Any modal presenter at all — the React analogue of `showModalBottomSheet|showDialog`. */
export function countAnyPresenterCalls(src: string): number {
  return (stripPresenterDeclarations(src).match(/\bshowModal_[0-9_]+\s*\(|\bmodalController\s*\.\s*open\s*\(/g) ?? []).length;
}

/** Remove every `showModal_<id>` declaration (function or arrow const) INCLUDING its
 *  body, so neither its name nor the `modalController.open(…)` inside it counts as a
 *  presentation. Brace-matched; an expression-bodied arrow is cut at its `;`/EOL. */
export function stripPresenterDeclarations(src: string): string {
  const decl = /(?:export\s+)?(?:(?:async\s+)?function\s+showModal_[0-9_]+\s*\(|(?:const|let|var)\s+showModal_[0-9_]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\s*)?\()/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    const start = m.index;
    // Skip the parameter list (balanced parens), then find the body.
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    const rest = src.slice(i);
    const bodyOpen = /^\s*(?::[^{=]+)?(?:=>)?\s*\{/.exec(rest);
    let end: number;
    if (bodyOpen) {
      let j = i + bodyOpen[0].length;
      let d = 1;
      while (j < src.length && d > 0) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
      end = j;
    } else {
      const eol = rest.search(/;|\n/);
      end = eol < 0 ? src.length : i + eol + 1;
    }
    out += src.slice(last, start);
    last = end;
    decl.lastIndex = end;
  }
  return out + src.slice(last);
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

/** The specifier a module should use to import `toFile`: the tsconfig alias the
 *  module ALREADY uses (`@/components/X` in a file that imports `@/…`), else the
 *  relative path. The alias is only chosen when it resolves back to `toFile`. */
export function importSpecFor(fromFile: string, toFile: string, src: string): string {
  const relative = importPathBetween(fromFile, toFile);
  const cfg = pathConfigFor(fromFile);
  if (!cfg) return relative;
  const used = [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((x) => !x.startsWith('.'));
  for (const a of cfg.aliases) {
    if (!a.hasStar || !used.some((u) => u.startsWith(a.prefix))) continue;
    for (const t of a.targets) {
      const [head, tail] = t.split('*');
      const bare = toFile.replace(/\.(tsx|ts|jsx|js)$/, '');
      if (!bare.startsWith(head) || !bare.endsWith(tail ?? '')) continue;
      const star = bare.slice(head.length, bare.length - (tail ?? '').length).split(path.sep).join('/');
      const spec = `${a.prefix}${star}${a.suffix}`;
      if (resolveSpecifier(fromFile, spec) === toFile) return spec;
    }
  }
  return relative;
}

/** The tsconfig/jsconfig alias specifier that reaches `toFile` from a module at
 *  `fromFile` — WITHOUT requiring `toFile` to exist yet (the design-system contract
 *  names the theme import before the module is written). Resolution mirrors tsc: the
 *  longest matching pattern wins and its first target is taken. Null when the project
 *  maps no alias onto `toFile` (create-next-app --no-import-alias, a hand-made app):
 *  callers then use a relative specifier, never an unmapped `@/…` (B12 fix round). */
export function aliasSpecifierFor(fromFile: string, toFile: string): string | null {
  const cfg = pathConfigFor(fromFile);
  if (!cfg) return null;
  const bare = toFile.replace(/\.(tsx|ts|jsx|js)$/, '');
  const target = (a: PathAlias, spec: string): string | null => {
    const t = a.targets[0];
    if (!t) return null;
    if (!a.hasStar) return spec === a.prefix ? t : null;
    if (spec.length < a.prefix.length + a.suffix.length || !spec.startsWith(a.prefix) || !spec.endsWith(a.suffix)) return null;
    return t.replace('*', spec.slice(a.prefix.length, spec.length - a.suffix.length));
  };
  for (const a of cfg.aliases) {
    if (!a.hasStar) continue;
    const t = a.targets[0];
    if (!t) continue;
    const [head, tail = ''] = t.split('*');
    if (!bare.startsWith(head) || !bare.endsWith(tail) || bare.length < head.length + tail.length) continue;
    const star = bare.slice(head.length, bare.length - tail.length).split(path.sep).join('/');
    const spec = `${a.prefix}${star}${a.suffix}`;
    // tsc resolves `spec` with the most specific pattern that matches it — which may
    // be another alias; the spec is ours only if that pattern lands on `toFile`.
    const winner = cfg.aliases.find((b) => target(b, spec) !== null);
    const landed = winner ? target(winner, spec) : null;
    if (landed && path.resolve(landed).replace(/\.(tsx|ts|jsx|js)$/, '') === path.resolve(bare)) return spec;
  }
  return null;
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
  if (!lastImport) {
    // Never above a directive prologue: `'use client'` must stay the first statement
    // or Next rejects the module (comments before it are fine).
    const prologue = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*(?:(['"])use (?:client|server|strict)\1;?[ \t]*(?:\n|$))+/.exec(src);
    if (prologue) return `${src.slice(0, prologue[0].length).replace(/\n?$/, '\n')}${line}\n${src.slice(prologue[0].length)}`;
    return `${line}\n${src}`;
  }
  const at = lastImport.index! + lastImport[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}

/** True when `symbol` still appears outside its own import statement. */
export function stillReferenced(src: string, symbol: string): boolean {
  const withoutImports = src.replace(/^import\s.*$/gm, '');
  return new RegExp(`\\b${escapeRe(symbol)}\\b`).test(withoutImports);
}
