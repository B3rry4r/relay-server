/**
 * The shared canonicalId → file resolver (passes/web-app.ts) across every web
 * layout the pipeline has to drive (PG-04 / PG-05 / PG-06), plus the single shared
 * framework detector every pass now imports.
 *
 * Each case builds a real project on disk and asserts the FILE the resolver returns,
 * never a count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadWebApp, resolveScreen, parseImports, resolveSpecifier, nextAppRoute, nextPagesRoute,
  listWebSources, parseJsonc, countPresenterCalls, detectWebKind,
} from '../src/relay-server/passes/web-app';
import { detectFramework } from '../src/relay-server/passes/framework';
import * as extraction from '../src/relay-server/passes/component-extraction';
import * as modal from '../src/relay-server/passes/modal-overlay';
import * as assetUsage from '../src/relay-server/passes/asset-usage';
import * as flow from '../src/relay-server/passes/flow-wiring';
import * as rename from '../src/relay-server/passes/semantic-rename';
import * as tokens from '../src/relay-server/passes/token-cleanup';

let root = '';

async function write(rel: string, text: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
  return abs;
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'x', dependencies: deps });
const rel = (p: string | undefined | null) => (p ? path.relative(root, p).split(path.sep).join('/') : p);

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-resolver-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('detectFramework — one shared implementation', () => {
  it('every pass module re-exports the SAME function (no drifting copies)', () => {
    for (const mod of [extraction, modal, assetUsage, flow, rename, tokens]) {
      expect(mod.detectFramework).toBe(detectFramework);
    }
  });

  it('flutter wins over package.json; next is distinct from react; unknown otherwise', async () => {
    expect(await detectFramework(root)).toBe('unknown');
    await write('package.json', pkg({ react: '^18' }));
    expect(await detectFramework(root)).toBe('react');
    expect(await detectWebKind(root)).toBe('react');
    await write('package.json', pkg({ react: '^18', next: '14.2.5' }));
    expect(await detectFramework(root)).toBe('next');
    expect(await detectWebKind(root)).toBe('next');
    await write('pubspec.yaml', 'name: x\n');
    expect(await detectFramework(root)).toBe('flutter');
  });
});

describe('Next route model (App Router + Pages Router)', () => {
  it('strips route groups and slots, skips private + intercepting folders, decodes %5F, keeps dynamic segments', () => {
    const app = '/p/app';
    expect(nextAppRoute(app, '/p/app/page.tsx')).toBe('/');
    expect(nextAppRoute(app, '/p/app/(tabs)/10-2/page.tsx')).toBe('/10-2');
    expect(nextAppRoute(app, '/p/app/(shop)/(inner)/cart/page.tsx')).toBe('/cart');
    expect(nextAppRoute(app, '/p/app/@modal/login/page.tsx')).toBe('/login');
    expect(nextAppRoute(app, '/p/app/_components/x/page.tsx')).toBeNull();
    expect(nextAppRoute(app, '/p/app/%5Fpreview/10-3/page.tsx')).toBe('/_preview/10-3');
    expect(nextAppRoute(app, '/p/app/(.)photo/[id]/page.tsx')).toBeNull();
    expect(nextAppRoute(app, '/p/app/orders/[id]/page.tsx')).toBe('/orders/[id]');
    expect(nextAppRoute(app, '/p/app/docs/[...slug]/page.tsx')).toBe('/docs/[...slug]');
    expect(nextAppRoute(app, '/p/app/settings/layout.tsx')).toBeNull();
  });

  it('pages router: index, nested, and the non-route files', () => {
    const pages = '/p/pages';
    expect(nextPagesRoute(pages, '/p/pages/index.tsx')).toBe('/');
    expect(nextPagesRoute(pages, '/p/pages/settings/index.tsx')).toBe('/settings');
    expect(nextPagesRoute(pages, '/p/pages/10-3.tsx')).toBe('/10-3');
    expect(nextPagesRoute(pages, '/p/pages/_app.tsx')).toBeNull();
    expect(nextPagesRoute(pages, '/p/pages/api/hello.ts')).toBeNull();
  });
});

describe('loadWebApp / resolveScreen', () => {
  it('react (Vite): route table + App.tsx element map + headers', async () => {
    await write('package.json', pkg({ react: '^18', 'react-router-dom': '^6' }));
    await write('src/router/routes.ts', `export const ROUTES = { home: '/10-2', settings: '/10-3' } as const;\n`);
    await write('src/App.tsx', [
      `import { HomeScreen } from './screens/Home/HomeScreen';`,
      `import { SettingsScreen } from './screens/SettingsScreen';`,
      `import { ROUTES } from './router/routes';`,
      `export default function App() { return (<Routes>`,
      `  <Route path={ROUTES.home} element={<HomeScreen />} />`,
      `  <Route path={ROUTES.settings} element={<SettingsScreen />} />`,
      `</Routes>); }`,
    ].join('\n'));
    await write('src/screens/Home/HomeScreen.tsx', `// canonicalId: c_10_2 route: /10-2\nexport function HomeScreen() { return <div/>; }\n`);
    await write('src/screens/SettingsScreen.tsx', `export function SettingsScreen() { return <div/>; }\n`);
    const ix = (await loadWebApp(root))!;
    expect(ix.kind).toBe('react');
    expect(rel(ix.pipelineRoot)).toBe('src');
    expect(rel(resolveScreen(ix, 'c_10_2', ['10:2'])?.file)).toBe('src/screens/Home/HomeScreen.tsx');
    // No header: resolved through ROUTES + the <Route> element + its import.
    const s = resolveScreen(ix, 'c_10_3', ['10:3'])!;
    expect(rel(s.file)).toBe('src/screens/SettingsScreen.tsx');
    expect(s.routeConst).toBe('settings');
  });

  it('next app/ at the root: a pipeline-written src/resources/assets.ts must NOT hide app/ (PG-04)', async () => {
    await write('package.json', pkg({ next: '14.2.5', react: '^18' }));
    await write('src/resources/assets.ts', `export const assets = { searchIcon: '/assets/icons/search_icon.svg' } as const;\n`);
    await write('app/layout.tsx', `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n`);
    await write('app/10-1/page.tsx', `export default function LoginPage() { return <div/>; }\n`);
    await write('app/(tabs)/10-2/page.tsx', `export default function HomePage() { return <div/>; }\n`);
    await write('app/(tabs)/layout.tsx', `export default function TabsLayout({ children }: { children: React.ReactNode }) { return <>{children}</>; }\n`);
    await write('app/settings/page.tsx', `// canonicalId: c_10_3 route: /settings\nexport default function SettingsPage() { return <div/>; }\n`);
    await write('app/_preview/10-1/page.tsx', `export default function P() { return <div/>; }\n`);
    await write('app/%5Fpreview/10-2/page.tsx', `export default function P() { return <div/>; }\n`);
    const ix = (await loadWebApp(root))!;
    expect(ix.kind).toBe('next');
    expect(rel(ix.appDir)).toBe('app');
    expect(rel(ix.srcDir)).toBe('app');
    expect(rel(ix.pipelineRoot)).toBe('');
    expect(ix.sourceRoots.map(rel).sort()).toEqual(['app', 'src']);
    expect(rel(ix.resourcesFile)).toBe('src/resources/assets.ts');   // legacy location still found
    expect(rel(resolveScreen(ix, 'c_10_1', ['10:1'])?.file)).toBe('app/10-1/page.tsx');
    expect(rel(resolveScreen(ix, 'c_10_2', ['10:2'])?.file)).toBe('app/(tabs)/10-2/page.tsx');
    expect(resolveScreen(ix, 'c_10_2', ['10:2'])?.route).toBe('/10-2');
    // Semantic route indexed by route string, header id wins.
    expect(rel(ix.byRoute.get('/settings')?.file)).toBe('app/settings/page.tsx');
    expect(rel(resolveScreen(ix, 'c_10_3')?.file)).toBe('app/settings/page.tsx');
    // Verify-harness previews are never screens.
    expect([...ix.byRoute.keys()].some((r) => r.startsWith('/_preview'))).toBe(false);
    const all = (await listWebSources(ix)).map(rel);
    expect(all).toContain('src/resources/assets.ts');
    expect(all.some((f) => /preview/i.test(f!))).toBe(false);
  });

  it('next src/app (create-next-app --src-dir): pipeline root is src/, routes computed from src/app', async () => {
    await write('package.json', pkg({ next: '15.0.0', react: '^19' }));
    await write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    await write('src/app/page.tsx', `export default function Home() { return <div/>; }\n`);
    await write('src/app/10-3/page.tsx', `import { Header } from '@/components/Header';\nexport default function SettingsPage() { return <Header/>; }\n`);
    await write('src/app/(auth)/10-1/page.tsx', `export default function LoginPage() { return <div/>; }\n`);
    await write('src/components/Header.tsx', `export function Header() { return <h1/>; }\n`);
    await write('src/lib/theme.ts', `export const AppTheme = { color: {} };\n`);
    const ix = (await loadWebApp(root))!;
    expect(rel(ix.appDir)).toBe('src/app');
    expect(rel(ix.pipelineRoot)).toBe('src');
    expect(rel(ix.componentsDir)).toBe('src/components');
    expect(rel(ix.themeFile)).toBe('src/lib/theme.ts');
    expect(rel(ix.screensDir)).toBe('src/app');
    expect(rel(resolveScreen(ix, 'c_10_3', ['10:3'])?.file)).toBe('src/app/10-3/page.tsx');
    expect(rel(resolveScreen(ix, 'c_10_1', ['10:1'])?.file)).toBe('src/app/(auth)/10-1/page.tsx');
    expect(ix.byRoute.get('/')).toBeTruthy();
    // The screen's '@/components/Header' import resolves through tsconfig paths.
    const page = path.join(root, 'src/app/10-3/page.tsx');
    const imports = parseImports(await fs.readFile(page, 'utf8'), page);
    expect(rel(imports.get('Header'))).toBe('src/components/Header.tsx');
  });

  it('next: root app/ wins over src/app/, exactly as Next resolves it', async () => {
    await write('package.json', pkg({ next: '14.2.5' }));
    await write('app/10-1/page.tsx', `export default function A() { return null; }\n`);
    await write('src/app/10-1/page.tsx', `export default function B() { return null; }\n`);
    const ix = (await loadWebApp(root))!;
    expect(rel(ix.appDir)).toBe('app');
    expect(rel(resolveScreen(ix, 'c_10_1', ['10:1'])?.file)).toBe('app/10-1/page.tsx');
  });

  it('next pages router resolves too', async () => {
    await write('package.json', pkg({ next: '13.0.0' }));
    await write('pages/10-4.tsx', `export default function ProfilePage() { return null; }\n`);
    await write('pages/_app.tsx', `export default function App() { return null; }\n`);
    const ix = (await loadWebApp(root))!;
    expect(rel(ix.pagesDir)).toBe('pages');
    expect(rel(resolveScreen(ix, 'c_10_4', ['10:4'])?.file)).toBe('pages/10-4.tsx');
  });
});

describe('import resolution through tsconfig/jsconfig (PG-06)', () => {
  it('follows @/* paths, a baseUrl, extends chains and Vite-style references, and parses JSONC', async () => {
    await write('package.json', pkg({ react: '^18' }));
    // Vite react-ts: a solution tsconfig with comments + trailing commas, paths in the referenced file.
    await write('tsconfig.json', `{
      // solution file
      "files": [],
      "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" },],
    }`);
    await write('tsconfig.base.json', `{ "compilerOptions": { "baseUrl": ".", "paths": { "~ui/*": ["src/ui/*"] } } }`);
    await write('tsconfig.app.json', `{ "extends": "./tsconfig.base.json", /* app */ "compilerOptions": { "strict": true, }, "include": ["src"] }`);
    await write('tsconfig.node.json', `{ "compilerOptions": {} }`);
    await write('src/ui/Button.tsx', `export function Button() { return null; }\n`);
    await write('src/lib/util/index.ts', `export const x = 1;\n`);
    const from = await write('src/screens/A.tsx', `import { Button } from '~ui/Button';\nimport { x } from 'src/lib/util';\nimport React from 'react';\n`);
    const imports = parseImports(await fs.readFile(from, 'utf8'), from);
    expect(rel(imports.get('Button'))).toBe('src/ui/Button.tsx');
    expect(rel(imports.get('x'))).toBe('src/lib/util/index.ts');   // baseUrl-relative bare import
    expect(imports.has('React')).toBe(false);                      // a package, not a file
    expect(resolveSpecifier(from, 'react')).toBeNull();
  });

  it('jsconfig.json works the same way', async () => {
    await write('package.json', pkg({ next: '14.2.5' }));
    await write('jsconfig.json', `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`);
    await write('components/Nav.jsx', `export function Nav() { return null; }\n`);
    const from = await write('app/page.jsx', `import { Nav } from '@/components/Nav';\n`);
    expect(rel(parseImports(await fs.readFile(from, 'utf8'), from).get('Nav'))).toBe('components/Nav.jsx');
  });

  it('parseJsonc keeps comment-like text inside strings', () => {
    expect(parseJsonc(`{ "a": "http://x//y", /* c */ "b": [1,2,], }`)).toEqual({ a: 'http://x//y', b: [1, 2] });
  });
});

describe('presenter call-sites (PG-11, web half)', () => {
  it("a presenter's own declaration and the modalController.open inside it are NOT call sites", () => {
    const decl = `import { modalController } from './modalController';
export function LogoutDialog() { return <div role="dialog">Log out?</div>; }
export function showModal_10_8() {
  modalController.open('m_10_8', <LogoutDialog />);
}
export const showModal_10_9 = () => modalController.open('m_10_9', <X />);
`;
    expect(countPresenterCalls(decl, 'showModal_10_8', 'm_10_8')).toBe(0);
    expect(countPresenterCalls(decl, 'showModal_10_9', 'm_10_9')).toBe(0);
    const screen = `import { showModal_10_8 } from '@/components/LogoutDialog';
export default function S() { return <button onClick={() => showModal_10_8()}>Log out</button>; }
`;
    expect(countPresenterCalls(screen, 'showModal_10_8', 'm_10_8')).toBe(1);
    expect(countPresenterCalls(`<b onClick={() => modalController.open('m_10_8', <D/>)} />`, 'showModal_10_8', 'm_10_8')).toBe(1);
  });
});
