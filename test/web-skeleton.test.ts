/**
 * PG-02 / PG-03 / PG-31 — the web skeleton, the web header re-stamp and the web
 * design system, on real files. The parity harness grades the skeleton on an empty
 * project through the passes' resolver; these cover what an EXISTING project brings:
 * a built screen is never clobbered, a hand-written router is kept (and reported),
 * framework boilerplate is replaced, the src/app Next layout, the Next static export,
 * and the header staying above 'use client'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateWebSkeleton, restampCanonicalHeaders, type Canonical } from '../src/relay-server/canonicalize';
import { generateDesignSystem } from '../src/relay-server/design-system';
import { loadWebApp, resolveScreen, readHeader } from '../src/relay-server/passes/web-app';

const FIXTURE_CANON = path.resolve(__dirname, 'fixtures', 'parity', 'next', '.uix', 'canonical.json');
const canon = async (): Promise<Canonical> => JSON.parse(await fs.readFile(FIXTURE_CANON, 'utf8'));

let root = '';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-skel-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);

describe('generateWebSkeleton — react', () => {
  it('replaces create-vite boilerplate, never clobbers a built screen, and is idempotent', async () => {
    await write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'vite build' }, dependencies: { react: '^19.0.0' } }));
    await write('src/App.tsx', "import viteLogo from '/vite.svg';\nexport default function App() { return <p>count is 0 — Vite + React</p>; }\n");
    await write('src/main.tsx', "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n");
    const built = '// canonicalId: c_10_1 route: /login\nexport function LoginScreen() { return <form>real</form>; }\n';
    await write('src/screens/LoginScreen.tsx', built);

    const c = await canon();
    const r1 = await generateWebSkeleton(root, c, 'react');
    expect(await read('src/screens/LoginScreen.tsx')).toBe(built);            // built screen untouched
    const app = await read('src/App.tsx');
    expect(app).toMatch(/GENERATED SKELETON/);                                 // boilerplate replaced
    expect(app).toMatch(/<Route path=\{ROUTES\.login\} element=\{<LoginScreen \/>\} \/>/);
    expect(app).toMatch(/<Route path="\/_preview\/10-8"/);
    expect(JSON.parse(await read('package.json')).dependencies['react-router-dom']).toBeTruthy();
    expect(r1.warnings.join('\n')).toMatch(/react-router-dom/);

    const ix = await loadWebApp(root);
    const login = resolveScreen(ix!, 'c_10_1', ['10:1']);
    expect(login?.placeholder).toBe(false);                                     // built
    expect(resolveScreen(ix!, 'c_10_3', ['10:3'])?.placeholder).toBe(true);    // still a stub

    const r2 = await generateWebSkeleton(root, await canon(), 'react');
    expect(r2.files).toEqual([]);                                               // second run writes nothing
  });

  it('keeps a hand-written App.tsx and says the routes were not generated', async () => {
    const own = "import { BrowserRouter } from 'react-router-dom';\nexport default function App() { return <BrowserRouter>{null}</BrowserRouter>; }\n";
    await write('src/App.tsx', own);
    const r = await generateWebSkeleton(root, await canon(), 'react');
    expect(await read('src/App.tsx')).toBe(own);
    expect(r.kept).toContain('src/App.tsx');
    expect(r.warnings.join('\n')).toMatch(/hand-written — the canonical <Routes> table was NOT generated/);
  });
});

describe('generateWebSkeleton — next', () => {
  it('root app/: header above use client, previews at app/%5Fpreview, static export added to an existing config', async () => {
    await write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'next build' }, dependencies: { next: '16.0.0' } }));
    await write('next.config.ts', "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {\n  /* config options here */\n};\n\nexport default nextConfig;\n");
    await write('app/globals.css', 'body { margin: 0; }\n');
    await write('app/layout.tsx', "import { Geist } from 'next/font/google';\nexport const metadata = { title: 'Create Next App' };\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
    const r = await generateWebSkeleton(root, await canon(), 'next');
    expect(r.pipelineRoot).toBe('.');
    const page = await read('app/settings/page.tsx');
    const lines = page.split('\n');
    expect(lines[0]).toBe('// canonicalId: c_10_3 route: /settings');
    expect(lines.find((l) => l.trim() && !l.startsWith('//'))).toBe("'use client';");
    expect(await exists('app/%5Fpreview/10-3/page.tsx')).toBe(true);
    expect(await exists('app/_preview')).toBe(false);
    expect(await read('next.config.ts')).toMatch(/output: 'export'/);
    const layout = await read('app/layout.tsx');
    expect(layout).toMatch(/GENERATED SKELETON/);
    expect(layout).toMatch(/import '\.\/globals\.css';\nimport '\.\.\/lib\/theme\/theme\.css';/);
    expect(await exists('lib/routes.ts')).toBe(true);
    const ix = await loadWebApp(root);
    expect(ix?.routesFile).toBe(path.join(root, 'lib', 'routes.ts'));
    expect(resolveScreen(ix!, 'c_10_3', ['10:3'])?.file).toBe(path.join(root, 'app', 'settings', 'page.tsx'));
  });

  it('src/app layout: every pipeline file lives under src/ (CONTRACTS §5)', async () => {
    await write('src/app/page.tsx', "export default function Home() { return <main>Get started by editing</main>; }\n");
    const r = await generateWebSkeleton(root, await canon(), 'next');
    expect(r.pipelineRoot).toBe('src');
    expect(await exists('src/lib/routes.ts')).toBe(true);
    expect(await exists('src/components/PlaceholderScreen.tsx')).toBe(true);
    expect(await exists('src/app/%5Fpreview/10-8/page.tsx')).toBe(true);
    expect(await exists('app')).toBe(false);
    expect(JSON.parse(await read('tsconfig.json')).compilerOptions.paths['@/*']).toEqual(['./src/*']);
    const g = await generateDesignSystem(root, 'next', { colors: ['#12ae89'], fonts: ['Inter'] });
    expect(g.themeFile).toBe('src/lib/theme/theme.ts');
    expect(await read('src/lib/theme/theme.ts')).toMatch(/export const AppTheme = \{/);
  });
});

describe('restampCanonicalHeaders — web (PG-03)', () => {
  it('stamps a Next page that lost its header ABOVE use client, and a second run changes nothing', async () => {
    const c = await canon();
    await generateWebSkeleton(root, c, 'next');
    // The agent rewrote the page and dropped the header.
    await write('app/settings/page.tsx', "'use client';\n\nexport default function SettingsScreen() { return <main>Settings</main>; }\n");
    const r = await restampCanonicalHeaders(root, c, 'next');
    expect(r.stamped).toEqual(['app/settings/page.tsx']);
    const src = await read('app/settings/page.tsx');
    expect(readHeader(src)).toEqual({ canonicalId: 'c_10_3', route: '/settings' });
    expect(src.split('\n')[1]).toBe("'use client';");
    const again = await restampCanonicalHeaders(root, c, 'next');
    expect(again.stamped).toEqual([]);
  });
});

describe('generateDesignSystem — web (PG-31)', () => {
  it('writes a typed AppTheme + CSS variables, speaks TS, and never clobbers an extended theme', async () => {
    await generateWebSkeleton(root, await canon(), 'react');
    const g = await generateDesignSystem(root, 'react', { colors: ['#12ae89', '#1a1a1a', '#ffffff'], fonts: ['Inter'] });
    expect(g.wrote).toBe(true);
    const ts = await read('src/theme/theme.ts');
    expect(ts).toMatch(/export const AppTheme = \{\n  color: \{\n    brand: '#12ae89'/);
    expect(await read('src/theme/theme.css')).toMatch(/--color-brand: #12ae89;/);
    expect(g.api).not.toMatch(/Color\(0x|EdgeInsets|BorderRadius|\.dart/);
    expect(g.api).toMatch(/AppTheme\.color\.brand/);
    const rec = JSON.parse(await read('.uix/design-system.json'));
    expect(rec).toMatchObject({ framework: 'react', themeFile: 'src/theme/theme.ts', cssFile: 'src/theme/theme.css', symbol: 'AppTheme' });

    const extended = `${ts}\nexport const extra = 1;\n`;
    await write('src/theme/theme.ts', extended);
    const g2 = await generateDesignSystem(root, 'react', { colors: ['#000000'], fonts: [] });
    expect(g2.wrote).toBe(false);
    expect(await read('src/theme/theme.ts')).toBe(extended);
  });
});
