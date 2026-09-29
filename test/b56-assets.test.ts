/**
 * B56 — Pass 7c + the Assets phase on web (PG-15, PG-16, PG-17, PG-28, PG-29, PG-30),
 * on real files: localization writes where the web server serves, resources values
 * are served URLs, the re-point understands every spelling of a path, a legacy
 * (pre-B56) web build migrates, and the destructive rename is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __test as webAssets, isJsxAttrValue, repointWeb } from '../src/relay-server/passes/asset-usage-web';
import { emitResources } from '../src/relay-server/resources-emit';
import { webResourcesRel, webServedUrl, webAssetKey, assetBaseDir } from '../src/relay-server/passes/framework';
import { renderAssetInventory, buildAssetInventory } from '../src/relay-server/passes/asset-usage';

let ws = '';
let root = '';
const PID = 'b56-assets';
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'b56a-'));
  process.env.WORKSPACE = ws;
  root = path.join(ws, 'projects', PID);
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(ws, { recursive: true, force: true }); });

const write = async (rel: string, text: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const exists = (rel: string) => fsSync.existsSync(path.join(root, rel));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M1 1h16v16H1z"/></svg>';

describe('web layout contract helpers (CONTRACTS §5)', () => {
  it('served URL / asset key / resources location', async () => {
    expect(webServedUrl('public/assets/icons/a.svg')).toBe('/assets/icons/a.svg');
    expect(webServedUrl('assets/icons/a.svg')).toBe('/assets/icons/a.svg');
    for (const p of ['assets/icons/a.svg', '/assets/icons/a.svg', 'public/assets/icons/a.svg', './public/assets/icons/a.svg']) expect(webAssetKey(p)).toBe('assets/icons/a.svg');
    expect(assetBaseDir('react')).toBe('public/assets');
    expect(assetBaseDir('flutter')).toBe('assets');
    expect(webResourcesRel(root, 'react')).toBe('src/resources/assets.ts');
    await fs.mkdir(path.join(root, 'src', 'app'), { recursive: true });
    expect(webResourcesRel(root, 'next')).toBe('src/lib/resources/assets.ts');
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    expect(webResourcesRel(root, 'next')).toBe('lib/resources/assets.ts');
  });

  it('web resources values are served URLs; flutter keeps bundle paths', () => {
    const a = [{ name: 'search_icon', relPath: 'public/assets/icons/search_icon.svg', format: 'svg' as const, kind: 'icon' as const }];
    expect(emitResources('react', a)!.contents).toMatch(/searchIcon: '\/assets\/icons\/search_icon\.svg'/);
    expect(emitResources('next', a, { filePath: 'lib/resources/assets.ts' })!.filePath).toBe('lib/resources/assets.ts');
    const f = emitResources('flutter', [{ ...a[0], relPath: 'assets/icons/search_icon.svg' }])!;
    expect(f.contents).toMatch(/static const String searchIcon = 'assets\/icons\/search_icon\.svg';/);
  });
});

describe('7c web re-point (PG-15 / PG-16 / PG-17)', () => {
  it('JSX attribute position is recognised; object values and assignments are not', () => {
    const cases: Array<[string, boolean]> = [
      ['<img src="assets/a.png" />', true],
      ['<img alt="" onClick={() => go()} src="assets/a.png" />', true],
      ["const ICONS = { search: 'assets/a.png' };", false],
      ["const x = 'assets/a.png';", false],
      ['<div>{"assets/a.png"}</div>', false],
    ];
    for (const [src, want] of cases) {
      const at = src.search(/['"]assets/);
      expect([src, isJsxAttrValue(src, at)]).toEqual([src, want]);
    }
    expect(webAssets.findServedPrefixTemplates('<img src={`/${assets.a}`} /><img src={`/${ assets[k] }`} />').map((t) => t.expr)).toEqual(['assets.a', 'assets[k]']);
  });

  it('every spelling (opaque IR path, served URL, public/ path, legacy `/${…}`) → the symbol; Next sources outside src/; idempotent', async () => {
    await write('package.json', JSON.stringify({ dependencies: { next: '16', react: '19' } }));
    await write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
    await write('lib/resources/assets.ts', "export const assets = {\n  searchIcon: '/assets/icons/search_icon.svg',\n  avatar: '/assets/images/avatar.png',\n} as const;\n");
    await write('app/page.tsx', [
      "'use client';",
      "import { useState } from 'react';",
      "const ICONS = { search: 'assets/icons/vector_10_20.svg' };",
      'export default function P() {',
      '  return (<main>',
      '    <img src="assets/images/avatar.png" alt="" />',
      "    <img src={'/assets/icons/search_icon.svg'} alt=\"\" />",
      '    <img src="public/assets/images/avatar.png" alt="" />',
      '    <img src={ICONS.search} />',
      '  </main>);',
      '}',
      '',
    ].join('\n'));
    await write('components/Card.tsx', "import { assets } from '@/lib/resources/assets';\nexport function Card() { return <img src={`/${assets.avatar}`} />; }\n");
    const byPath = new Map([['assets/icons/vector_10_20.svg', 'searchIcon'], ['public/assets/icons/search_icon.svg', 'searchIcon']]);
    const r = await repointWeb(root, [], { byPath });
    const page = await read('app/page.tsx');
    expect(page).toContain("const ICONS = { search: assets.searchIcon };");
    expect(page).toContain('<img src={assets.avatar} alt="" />');
    expect(page).toContain('<img src={assets.searchIcon} alt="" />');
    expect(page.split('\n')[0]).toBe("'use client';");                          // directive stays first
    // No @/ import in this module → a relative specifier (a module that already uses
    // the alias gets the alias — importSpecFor, B34).
    expect(page).toMatch(/import \{ assets \} from '\.\.\/lib\/resources\/assets';/);
    expect(page).not.toMatch(/['"](?:\/|public\/)?assets\//);
    expect(await read('components/Card.tsx')).toContain('<img src={assets.avatar} />');
    expect(r.repointed.length).toBe(5);
    expect(r.filesScanned).toBe(2);
    const again = await repointWeb(root, [], { byPath });
    expect(again.repointed).toEqual([]);
  });

  it('an unknown path is reported, never guessed; a module with no symbols is a skip with its reason', async () => {
    await write('package.json', JSON.stringify({ dependencies: { react: '19' } }));
    await write('src/resources/assets.ts', "export const assets = { a: '/assets/icons/a.svg' } as const;\n");
    await write('src/App.tsx', "export function App() { return <img src=\"assets/icons/nope.svg\" />; }\n");
    const r = await repointWeb(root, [], {});
    expect(r.repointed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ what: 'assets/icons/nope.svg' });
    await write('src/resources/assets.ts', 'export {};\n');
    const s = await repointWeb(root, [], {});
    expect(s.skippedReason).toMatch(/no web resources module declaring asset symbols/);
  });
});

describe('asset localization + resources for web (PG-28 / PG-29)', () => {
  it('react localizes into public/assets and emits served URLs; flutter stays in assets/', async () => {
    const { localizeFrameAssets, runAssetPass } = await import('../src/relay-server/reference-render');
    vi.stubGlobal('fetch', async (u: string | URL) => {
      const url = String(u);
      if (url.includes('/api/v1/figma/uploads')) return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
      if (url.includes('/api/v1/figma/svg-assets/')) return new Response(JSON.stringify({ assets: [{ nodeId: '10:20', fileName: 'search_icon_10_20.svg', url: 'https://uix.test/a/search.svg', format: 'svg' }] }), { status: 200 });
      if (url.endsWith('/a/search.svg')) return new Response(SVG, { status: 200 });
      return new Response('nf', { status: 404 });
    });
    await write('package.json', JSON.stringify({ dependencies: { react: '19' } }));
    const l = await localizeFrameAssets(PID, 'key', '10:1', null, new Set(), { framework: 'react' });
    expect(l.written).toEqual(['public/assets/icons/search_icon_10_20.svg']);
    expect(await read('public/assets/icons/search_icon_10_20.svg')).toBe(SVG);
    expect(exists('assets')).toBe(false);
    const pass = await runAssetPass(PID, 'react', l.assets, 'claude' as never, process.env, { noAi: true });
    expect(pass?.resourcesPath).toBe('src/resources/assets.ts');
    const res = await read('src/resources/assets.ts');
    const url = /: '([^']+)'/.exec(res)![1];
    expect(url).toMatch(/^\/assets\/icons\/.+\.svg$/);
    expect(exists(path.join('public', url))).toBe(true);           // the URL is a served file

    const f = await localizeFrameAssets(PID, 'key', '10:1', null, new Set(), { framework: 'flutter' });
    expect(f.written).toEqual(['assets/icons/search_icon_10_20.svg']);
  });

  it('next: the resources module goes beside the app dir; a legacy generated src/resources/assets.ts becomes a re-export', async () => {
    const { runAssetPass } = await import('../src/relay-server/reference-render');
    await write('package.json', JSON.stringify({ dependencies: { next: '16' } }));
    await write('app/page.tsx', 'export default function P() { return null; }\n');
    await write('src/resources/assets.ts', "// GENERATED by relay-server asset pass — do not edit by hand.\nexport const assets = { searchIcon: 'assets/icons/search_icon.svg' } as const;\n");
    await write('public/assets/icons/search_icon.svg', SVG);
    const pass = await runAssetPass(PID, 'next', [{ relPath: 'public/assets/icons/search_icon.svg', format: 'svg', kind: 'icon' }], 'claude' as never, process.env, { noAi: true });
    expect(pass?.resourcesPath).toBe('lib/resources/assets.ts');
    expect(await read('lib/resources/assets.ts')).toMatch(/searchIcon: '\/assets\/icons\/search_icon\.svg'/);
    expect(await read('src/resources/assets.ts')).toMatch(/export \* from '\.\.\/\.\.\/lib\/resources\/assets';/);
  });
});

describe('asset phase on an already-built web app (PG-28 / PG-30)', () => {
  it('a LEGACY applied react build (root assets/, path values, opaque + prefixed refs) migrates, re-points and is then idempotent', async () => {
    const { runAssetPhaseOnBuild } = await import('../src/relay-server/passes/asset-phase');
    await write('package.json', JSON.stringify({ dependencies: { react: '19' } }));
    await write('assets/icons/search_icon.svg', SVG);
    await write('.uix/asset-map.json', JSON.stringify({ framework: 'react', resourcesPath: 'src/resources/assets.ts', assets: [
      { nodeId: '10:20', name: 'search_icon', oldPath: 'assets/icons/vector_10_20.svg', newPath: 'assets/icons/search_icon.svg', format: 'svg', kind: 'icon' },
    ] }));
    await write('src/resources/assets.ts', "// GENERATED by relay-server asset pass — do not edit by hand.\nexport const assets = {\n  searchIcon: 'assets/icons/search_icon.svg',\n} as const;\n");
    await write('src/Home.tsx', "import { assets } from './resources/assets';\nexport function Home() { return (<div><img src={`/${assets.searchIcon}`} /><img src=\"assets/icons/vector_10_20.svg\" /></div>); }\n");

    const r1 = await runAssetPhaseOnBuild(PID, { projectRoot: root, skipBuildCheck: true });
    expect(r1.status).toBe('applied');
    expect(r1.migrated).toBe(1);
    expect(exists('assets')).toBe(false);
    expect(await read('public/assets/icons/search_icon.svg')).toBe(SVG);
    expect(await read('src/resources/assets.ts')).toMatch(/searchIcon: '\/assets\/icons\/search_icon\.svg'/);
    const home = await read('src/Home.tsx');
    expect(home).toContain('<img src={assets.searchIcon} /><img src={assets.searchIcon} />');
    const map = JSON.parse(await read('.uix/asset-map.json'));
    // The opaque IR name the legacy map knew is carried forward as an alias.
    expect(map.assets.map((a: { oldPath: string }) => a.oldPath).sort()).toEqual(['assets/icons/vector_10_20.svg', 'public/assets/icons/search_icon.svg']);

    const snap = async () => JSON.stringify(await Promise.all(['src/Home.tsx', 'src/resources/assets.ts', '.uix/asset-map.json'].map(read)));
    const before = await snap();
    const r2 = await runAssetPhaseOnBuild(PID, { projectRoot: root, skipBuildCheck: true });
    expect(r2).toMatchObject({ status: 'skipped', reason: 'already applied (idempotent no-op)' });
    expect(await snap()).toBe(before);
  });

  it('the web gate says when it could not run (no node_modules) — never a silent pass', async () => {
    const { runAssetPhaseOnBuild } = await import('../src/relay-server/passes/asset-phase');
    await write('package.json', JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19' } }));
    await write('tsconfig.json', '{}');
    await write('public/assets/icons/vector_10_20.svg', SVG);
    await write('src/Home.tsx', "export function Home() { return <img src=\"assets/icons/vector_10_20.svg\" />; }\n");
    const r = await runAssetPhaseOnBuild(PID, { projectRoot: root });
    expect(r.status).toBe('applied');
    expect(r.warnings.join('\n')).toMatch(/web typecheck gate did not run: no typescript installed/);
    expect(r.warnings.join('\n')).toMatch(/web build gate did not run: node_modules missing/);
  });
});

describe('the packet tells a web agent the served-URL contract', () => {
  it('renderAssetInventory: use the value as-is, never prefix it', async () => {
    await write('package.json', JSON.stringify({ dependencies: { react: '19' } }));
    await write('src/resources/assets.ts', "export const assets = { searchIcon: '/assets/icons/search_icon.svg' } as const;\n");
    await write('.uix/asset-map.json', JSON.stringify({ assets: [{ name: 'search_icon', oldPath: 'public/assets/icons/v.svg', newPath: 'public/assets/icons/search_icon.svg', format: 'svg', kind: 'icon' }] }));
    const inv = await buildAssetInventory(root);
    expect(inv?.resourcesRel).toBe('src/resources/assets.ts');
    const txt = renderAssetInventory(inv!);
    expect(txt).toMatch(/<img src=\{assets\.x\} alt="" \/>/);
    expect(txt).toMatch(/Never prefix it/);
    expect(txt).not.toMatch(/src=\{`\/\$\{assets/);
  });
});
