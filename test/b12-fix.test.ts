/**
 * B12 fix round — two skeptic findings, each pinned on real files:
 *
 *  1. 7f's skip reason on Next claimed "no web theme module" beside the theme B12's
 *     own design system wrote at <root>/lib/theme/theme.ts. The theme must be read
 *     (PG-18, B34) and a skip may only say "no theme module" when there is none; a
 *     theme the parser cannot read is named and called "not read".
 *  2. The Next design-system contract handed the agent `@/lib/theme/theme` without
 *     reading tsconfig paths — TS2307 on `create-next-app --no-import-alias`. The
 *     alias is used only when the project maps it onto the theme module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateWebSkeleton, type Canonical } from '../src/relay-server/canonicalize';
import { generateDesignSystem } from '../src/relay-server/design-system';
import { webThemePaths } from '../src/relay-server/web-skeleton';
import { aliasSpecifierFor, resolveSpecifier } from '../src/relay-server/passes/web-app';
import { deepenWebTokens, webThemeSkipReason } from '../src/relay-server/passes/token-cleanup-web';
import { honestSkipReason } from './parity/run-parity';

const FIXTURE_CANON = path.resolve(__dirname, 'fixtures', 'parity', 'next', '.uix', 'canonical.json');
const canon = async (): Promise<Canonical> => JSON.parse(await fs.readFile(FIXTURE_CANON, 'utf8'));

let root = '';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'b12-fix-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

/** The files create-next-app 16 writes that matter here; `paths` null = --no-import-alias. */
async function createNextApp(appDir: 'app' | 'src/app', paths: Record<string, string[]> | null): Promise<void> {
  await write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'next build' }, dependencies: { next: '16.3.7', react: '19.2.0' } }));
  await write('next.config.ts', "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n");
  await write(`${appDir}/globals.css`, 'body { margin: 0; }\n');
  await write(`${appDir}/layout.tsx`, "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await write(`${appDir}/page.tsx`, 'export default function Home() { return <main>Get started by editing</main>; }\n');
  const compilerOptions: Record<string, unknown> = { strict: true, jsx: 'react-jsx', moduleResolution: 'bundler', module: 'esnext' };
  if (paths) compilerOptions.paths = paths;
  // create-next-app's tsconfig carries comments-free JSON; keep a trailing comma out.
  await write('tsconfig.json', JSON.stringify({ compilerOptions, include: ['**/*.ts', '**/*.tsx'] }, null, 2));
}

describe('B12 fix — the Next theme import names only an alias the project maps', () => {
  it('create-next-app default (`@/*` → ./*): the contract keeps `@/lib/theme/theme`, and it resolves', async () => {
    await createNextApp('app', { '@/*': ['./*'] });
    await generateWebSkeleton(root, await canon(), 'next');
    const g = await generateDesignSystem(root, 'next', { colors: ['#12ae89'], fonts: ['Inter'] });
    expect(g.tokens.importSpecifier).toBe('@/lib/theme/theme');
    expect(g.api).toMatch(/import \{ AppTheme \} from '@\/lib\/theme\/theme'\)/);
    expect(resolveSpecifier(path.join(root, 'app', 'settings', 'page.tsx'), '@/lib/theme/theme')).toBe(path.join(root, 'lib', 'theme', 'theme.ts'));
  });

  it('--no-import-alias (no `paths`): the contract gives a relative specifier that resolves from app/<route>/page.tsx', async () => {
    await createNextApp('app', null);
    await generateWebSkeleton(root, await canon(), 'next');
    expect(JSON.parse(await read('tsconfig.json')).compilerOptions.paths).toBeUndefined();   // the skeleton did not invent one
    const g = await generateDesignSystem(root, 'next', { colors: ['#12ae89'], fonts: ['Inter'] });
    expect(g.tokens.importSpecifier).toBe('../../lib/theme/theme');
    expect(g.api).not.toMatch(/@\//);
    expect(g.api).toMatch(/from '\.\.\/\.\.\/lib\/theme\/theme' in `app\/<route>\/page\.tsx` — a relative path/);
    // Exactly what the contract says, from a real skeleton page, lands on the theme.
    expect(resolveSpecifier(path.join(root, 'app', 'settings', 'page.tsx'), g.tokens.importSpecifier!)).toBe(path.join(root, 'lib', 'theme', 'theme.ts'));
    const rec = JSON.parse(await read('.uix/design-system.json'));
    expect(rec).toMatchObject({ themeFile: 'lib/theme/theme.ts', importSpecifier: '../../lib/theme/theme', importFrom: 'app/<route>/page.tsx' });
  });

  it('src/app without an alias: relative from src/app/<route>/page.tsx', async () => {
    await createNextApp('src/app', null);
    const w = webThemePaths(root, 'next');
    expect(w).toMatchObject({ themeFile: 'src/lib/theme/theme.ts', importSpecifier: '../../lib/theme/theme', importFrom: 'src/app/<route>/page.tsx' });
  });

  it('src/app with `@/*` → ./src/*: the alias', async () => {
    await createNextApp('src/app', { '@/*': ['./src/*'] });
    expect(webThemePaths(root, 'next').importSpecifier).toBe('@/lib/theme/theme');
  });

  it('an alias whose target is NOT the theme dir (`@/*` → ./src/* on a root app/) is not used', async () => {
    await createNextApp('app', { '@/*': ['./src/*'] });
    expect(webThemePaths(root, 'next').importSpecifier).toBe('../../lib/theme/theme');
  });

  it('a more specific pattern that shadows the spec (`@/lib/*` → ./vendor/*) wins, as in tsc — relative instead', async () => {
    await createNextApp('app', { '@/*': ['./*'], '@/lib/*': ['./vendor/*'] });
    expect(aliasSpecifierFor(path.join(root, 'app', 'route', 'page.tsx'), path.join(root, 'lib', 'theme', 'theme.ts'))).toBeNull();
    expect(webThemePaths(root, 'next').importSpecifier).toBe('../../lib/theme/theme');
  });

  it('react keeps its relative contract', () => {
    expect(webThemePaths(root, 'react')).toMatchObject({ themeFile: 'src/theme/theme.ts', importSpecifier: '../theme/theme' });
  });
});

describe('B12 fix — 7f reads the Next theme, and a skip never claims an absent theme that exists', () => {
  it('skeleton + design system on create-next-app: 7f runs on lib/theme/theme.ts (no skip)', async () => {
    await createNextApp('app', { '@/*': ['./*'] });
    await generateWebSkeleton(root, await canon(), 'next');
    await generateDesignSystem(root, 'next', { colors: ['#12ae89', '#1a1a1a'], fonts: ['Inter'] });
    await write('app/settings/page.tsx', "// canonicalId: c_10_3 route: /settings\n'use client';\n\nexport default function SettingsScreen() { return <div style={{ color: '#12ae89' }}>Settings</div>; }\n");
    const r = await deepenWebTokens(root, {});
    expect(r.skippedReason).toBeUndefined();
    expect(r.themeFile).toBe('lib/theme/theme.ts');
    expect(r.substitutions.colors).toBeGreaterThan(0);
    expect(await read('app/settings/page.tsx')).toMatch(/color: AppTheme\.color\.\w+/);
  });

  it('...also with NO design-system record (the resolver finds lib/theme/theme.ts)', async () => {
    await createNextApp('app', null);
    await generateWebSkeleton(root, await canon(), 'next');
    await generateDesignSystem(root, 'next', { colors: ['#12ae89'], fonts: ['Inter'] });
    await fs.rm(path.join(root, '.uix', 'design-system.json'));
    const r = await deepenWebTokens(root, {});
    expect(r.skippedReason).toBeUndefined();
    expect(r.themeFile).toBe('lib/theme/theme.ts');
  });

  it('a theme module the parser cannot read is named and "not read" — never "no web theme module"', async () => {
    await createNextApp('app', null);
    await write('lib/theme/theme.ts', "const theme = { brand: '#12ae89' };\nexport default theme;\n");
    const r = await deepenWebTokens(root, {});
    expect(r.skippedReason).toMatch(/lib\/theme\/theme\.ts was not read/);
    expect(r.skippedReason).not.toMatch(/no web theme module/);
    expect(honestSkipReason(r.skippedReason!)).toBe(true);
  });

  it('only a project with no theme anywhere says "no web theme module", listing the Next locations', async () => {
    await createNextApp('app', null);
    const r = await deepenWebTokens(root, {});
    expect(r.skippedReason).toMatch(/^no web theme module in this app/);
    expect(r.skippedReason).toMatch(/lib\/theme\/theme\.ts and src\/lib\/theme\/theme\.ts on Next/);
    // The absent-input wording is NOT an honest skip where a theme exists — the
    // parity check t.skip-reason-honest rejects it.
    expect(honestSkipReason(webThemeSkipReason(root, null))).toBe(false);
  });
});
