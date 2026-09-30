/**
 * B56 — the non-pass phases on real files: PG-27 (resolve-app on web never destroys
 * canonical.json), PG-33 (Next static-export previews served + identity-checked by
 * document), PG-34 (restart clean slate on web), PG-35 (placeholder edges requeue on
 * every framework), PG-36 (framework-aware analyze gate that never parks forever).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { generateWebSkeleton, nukeGeneratedAppSurface, type Canonical } from '../src/relay-server/canonicalize';
import { resolveCanonicalFromCode } from '../src/relay-server/passes/resolve-canonical';
import { planFlowRequeue } from '../src/relay-server/passes/flow-requeue';
import { runAnalyzeGate } from '../src/relay-server/passes/finalize';
import { serveDir } from '../src/relay-server/visual-routes';

const FIXTURES = path.resolve(__dirname, 'fixtures', 'parity');
const canon = async (fw: string): Promise<Canonical> => JSON.parse(await fs.readFile(path.join(FIXTURES, fw, '.uix', 'canonical.json'), 'utf8'));

let root = '';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'b56-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
async function tree(dir: string, rel = '', out = new Map<string, string>()): Promise<Map<string, string>> {
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) await tree(dir, r, out);
    else out.set(r, crypto.createHash('sha1').update(fsSync.readFileSync(path.join(dir, r))).digest('hex'));
  }
  return out;
}

// ── PG-34 ────────────────────────────────────────────────────────────────────
describe('restart clean slate on web (PG-34)', () => {
  for (const fw of ['react', 'next'] as const) {
    it(`${fw}: nuke removes everything the skeleton generated (not its toolchain files); regenerating reproduces it byte-for-byte`, async () => {
      await generateWebSkeleton(root, await canon(fw), fw);
      const gen1 = await tree(root);
      // A hand-written module that imports a generated screen, and one that does not.
      await write(fw === 'react' ? 'src/lib/money.ts' : 'lib/money.ts', 'export const naira = (n: number) => `₦${n}`;\n');
      const importer = fw === 'react' ? 'src/extra/Uses.tsx' : 'components/Uses.tsx';
      const target = [...gen1.keys()].find((f) => /canonicalId|screens\/|page\.tsx$/.test(f) && !/%5Fpreview|_preview/.test(f) && f.endsWith('.tsx') && (fw === 'next' ? /app\/.+\/page\.tsx$/.test(f) : /src\/screens\//.test(f)))!;
      const spec = path.posix.relative(path.posix.dirname(importer), target).replace(/\.tsx$/, '');
      await write(importer, `import X from '${spec.startsWith('.') ? spec : `./${spec}`}';\nexport const Y = X;\n`);

      const r = await nukeGeneratedAppSurface(root, fw);
      const left = [...(await tree(root)).keys()].sort();
      // Only toolchain files the skeleton wrote for an EMPTY project + the hand-written files remain.
      const toolchain = fw === 'react' ? ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts'] : ['next-env.d.ts', 'next.config.mjs', 'package.json', 'tsconfig.json'];
      const hand = fw === 'react' ? ['src/extra/Uses.tsx', 'src/lib/money.ts'] : ['components/Uses.tsx', 'lib/money.ts'];
      expect(left).toEqual([...toolchain, ...hand].sort());
      expect(r.removedFiles.length).toBeGreaterThan(5);
      expect(r.warnings?.join('\n')).toMatch(new RegExp(`${importer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not pipeline-generated`));
      if (fw === 'next') expect(r.removedFiles.some((f) => f.includes('%5Fpreview'))).toBe(true);

      // The rebuild regenerates exactly the generated surface (clean slate, no leftovers).
      await fs.rm(path.join(root, importer));
      await generateWebSkeleton(root, await canon(fw), fw);
      const gen2 = await tree(root);
      for (const h of hand.filter((x) => x !== importer)) gen2.delete(h);
      expect([...gen2.entries()].sort()).toEqual([...gen1.entries()].sort());
    });
  }

  it('next: a 7a-extracted component is removed with what it imports; a hand-written file importing it through the `@/` alias is reported (B56 fix round)', async () => {
    // Repro of the skeptic finding: nuke removed lib/resources/assets.ts but KEPT
    // components/SearchGlyph.tsx (7a-extracted, `import { assets } from '@/…'`) and
    // warned about nothing, because it knew no 7a marker and only followed ./ imports.
    await generateWebSkeleton(root, await canon('next'), 'next');
    const tsconfig = JSON.parse(await fs.readFile(path.join(root, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions?.paths?.['@/*']).toBeTruthy();
    await write('lib/resources/assets.ts', "// GENERATED by relay-server asset pass — do not edit by hand.\nexport const assets = { searchIcon: '/assets/icons/search_icon.svg' } as const;\n");
    await write('components/SearchGlyph.tsx', [
      '// extracted by relay-server phase 7a — shared by 2 screens',
      "import { assets } from '@/lib/resources/assets';",
      '',
      'export function SearchGlyph() { return <img src={assets.searchIcon} alt="" width={18} height={18} />; }',
      '',
    ].join('\n'));
    await write('components/Toolbar.tsx', "import { SearchGlyph } from '@/components/SearchGlyph';\nexport function Toolbar() { return <SearchGlyph />; }\n");
    await write('lib/format.ts', "export const naira = (n: number) => `₦${n}`;\n");
    await write('components/Price.tsx', "import { naira } from '@/lib/format';\nexport const Price = ({ n }: { n: number }) => <b>{naira(n)}</b>;\n");

    const r = await nukeGeneratedAppSurface(root, 'next');
    expect(r.removedFiles).toEqual(expect.arrayContaining(['components/SearchGlyph.tsx', 'lib/resources/assets.ts']));
    expect(fsSync.existsSync(path.join(root, 'components/SearchGlyph.tsx'))).toBe(false);
    // Hand-written files are never removed; the one importing a removed module is named, with the import.
    for (const f of ['components/Toolbar.tsx', 'components/Price.tsx', 'lib/format.ts']) expect(fsSync.existsSync(path.join(root, f)), f).toBe(true);
    const warn = (r.warnings ?? []).join('\n');
    expect(warn).toMatch(/components\/Toolbar\.tsx is not pipeline-generated .*components\/SearchGlyph\.tsx/);
    expect(warn).not.toMatch(/Price\.tsx|format\.ts/);
  });

  it('react: a 7a-extracted component is removed; relative, re-export and dynamic imports of removed modules are reported', async () => {
    await generateWebSkeleton(root, await canon('react'), 'react');
    await write('src/components/Badge.tsx', "// extracted by relay-server phase 7a — shared by 2 screens\nexport function Badge({ label }: { label: string }) { return <span>{label}</span>; }\n");
    await write('src/extra/Barrel.ts', "export { Badge } from '../components/Badge';\n");
    await write('src/extra/Lazy.tsx', "export const load = () => import('../components/Badge');\n");
    const r = await nukeGeneratedAppSurface(root, 'react');
    expect(r.removedFiles).toContain('src/components/Badge.tsx');
    const warn = (r.warnings ?? []).join('\n');
    expect(warn).toMatch(/src\/extra\/Barrel\.ts is not pipeline-generated/);
    expect(warn).toMatch(/src\/extra\/Lazy\.tsx is not pipeline-generated/);
  });

  it('flutter keeps its contract (whole lib/ + stale reports); an unknown framework removes nothing', async () => {
    await write('lib/main.dart', 'void main() {}\n');
    await write('.uix/finalize-report.json', '{}');
    const f = await nukeGeneratedAppSurface(root, 'flutter');
    expect(f.removedDirs).toEqual(['lib']);
    expect(f.removedFiles).toEqual(['.uix/finalize-report.json']);
    await write('src/x.ts', 'export {}\n');
    const u = await nukeGeneratedAppSurface(root, 'svelte');
    expect(u.skipped).toMatch(/no generated-surface contract/);
    expect(fsSync.existsSync(path.join(root, 'src/x.ts'))).toBe(true);
  });
});

// ── PG-27 ────────────────────────────────────────────────────────────────────
describe('resolve-canonical on web (PG-27)', () => {
  for (const fw of ['react', 'next'] as const) {
    it(`${fw}: a skeleton-built app resolves every canonical screen + its modals; an app with no screens never overwrites canonical.json`, async () => {
      const c = await canon(fw);
      await generateWebSkeleton(root, c, fw);
      await write('.uix/canonical.json', JSON.stringify(c));
      const r = await resolveCanonicalFromCode('p', { projectRoot: root, noAi: true, dryRun: true });
      expect(r.framework).toBe(fw);
      expect(r.screens.map((s) => s.canonicalId).sort()).toEqual(c.screens.map((s) => s.canonicalId).sort());
      // The skeleton's modal presenters are declared but no BUILT screen calls them yet: base unknown, never guessed.
      expect(r.modals.map((m) => m.canonicalId).sort()).toEqual(['m_10_8', 'm_10_9']);
      expect(r.flow.entryCanonicalId).toBe(c.flow.entryCanonicalId);

      // Empty app: canonical.json is byte-identical afterwards, and the result says why.
      const before = await fs.readFile(path.join(root, '.uix/canonical.json'), 'utf8');
      for (const d of ['src', 'app', 'components', 'lib']) await fs.rm(path.join(root, d), { recursive: true, force: true });
      const e = await resolveCanonicalFromCode('p', { projectRoot: root, noAi: true });
      expect(e.screens).toEqual([]);
      expect(e.persisted).toBe(false);
      expect(e.skippedReason).toMatch(/0 screens.*left untouched/);
      expect(await fs.readFile(path.join(root, '.uix/canonical.json'), 'utf8')).toBe(before);
    });
  }
});

// ── PG-35 ────────────────────────────────────────────────────────────────────
describe('flow requeue (PG-35)', () => {
  const screens = [{ canonicalId: 'c_1', frameIds: ['1:1'] }, { canonicalId: 'c_2', frameIds: ['1:2'] }];
  const run = [{ frameId: '1:1', status: 'done' }, { frameId: '1:2', status: 'done' }];
  it('a HIGH missing (placeholder / stub / unserved target) requeues FROM; a plain missing does not', () => {
    const d = planFlowRequeue([
      { from: 'c_1', to: 'c_9', status: 'missing', detail: 'HIGH: TO route /9 mounts <PlaceholderScreen> — the screen was never wired into the router' },
      { from: 'c_2', to: 'c_9', status: 'missing', detail: 'no navigation on FROM reaches /9' },
    ], screens, run);
    expect(d.map((x) => x.frameId)).toEqual(['1:1']);
    expect(d[0].findings[0]).toMatch(/c_1→c_9/);
  });
});

// ── PG-36 ────────────────────────────────────────────────────────────────────
describe('analyze gate is framework-aware (PG-36)', () => {
  it('web prompt speaks tsc; a repair it cannot re-measure does not park the run on the stale count', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const g = await runAnalyzeGate({
      projectRoot: root, framework: 'next', model: 'claude' as never,
      analyze: async () => (calls++ === 0 ? { total: 3, errors: 3, errorLines: ['app/a.tsx(1,1): error TS2322: x'] } : null),
      runModel: async (_m, p) => { prompts.push(p); return { text: 'ok' }; },
    });
    expect(prompts[0]).toMatch(/Next\.js TypeScript project .* 3 TypeScript ERROR/);
    expect(prompts[0]).not.toMatch(/flutter/i);
    expect(prompts[0]).toMatch(/TS2322/);
    expect(g).toMatchObject({ initialErrors: 3, errors: null, ok: true, repairAttempted: true });
    expect(g.unmeasured).toMatch(/could not re-measure.*pre-repair count was 3/);
  });

  it('Next < 15.5 (no `next typegen`): stale .next/types for a deleted route are pruned, never counted; a real error still is (B56 fix round)', async () => {
    // `next build` adds `.next/types/**/*.ts` to tsconfig's include and writes one
    // route type file per page. Next 14 has no typegen, so after 7b deletes a route
    // the gate counted TS2307 in .next/types/app/<gone>/page.ts — errors no source edit
    // can fix — parked the run, and reverted every later pass on the Next 14 fixture.
    const tsDir = path.resolve(__dirname, '..', 'node_modules', 'typescript');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.symlink(tsDir, path.join(root, 'node_modules', 'typescript'), 'dir');
    await write('node_modules/next/package.json', JSON.stringify({ name: 'next', version: '14.2.5' }));
    await write('package.json', JSON.stringify({ dependencies: { next: '14.2.5', react: '18' } }));
    await write('tsconfig.json', JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'ES2020', skipLibCheck: true },
      include: ['**/*.ts', '.next/types/**/*.ts'], exclude: ['node_modules'],
    }));
    await write('app/live/page.ts', 'export default function Page() { return null; }\n');
    const typeFile = (route: string) => [
      `// File: ${path.join(root, 'app', route, 'page.tsx')}`,
      `import * as entry from '../../../../app/${route}/page.js'`,
      `type TEntry = typeof import('../../../../app/${route}/page.js')`,
      'export const check: TEntry = entry',
      '',
    ].join('\n');
    await write('.next/types/app/live/page.ts', typeFile('live'));
    await write('.next/types/app/gone/page.ts', typeFile('gone'));        // route deleted since the build
    await write('.next/types/package.json', '{"type":"module"}');

    const { webTypecheck, pruneStaleNextRouteTypes, nextHasTypegen } = await import('../src/relay-server/passes/finalize');
    expect(nextHasTypegen(root)).toBe(false);
    const t = await webTypecheck(root, 'next');
    expect(t).toMatchObject({ ok: true, errors: 0, pruned: ['.next/types/app/gone/page.ts'] });
    expect(fsSync.existsSync(path.join(root, '.next/types/app/live/page.ts'))).toBe(true);
    expect(fsSync.existsSync(path.join(root, '.next/types/package.json'))).toBe(true);
    expect(pruneStaleNextRouteTypes(root)).toEqual([]);                 // idempotent

    // The gate end to end: nothing to repair, no model call, not parked.
    await write('.next/types/app/gone/page.ts', typeFile('gone'));
    let called = 0;
    const g = await runAnalyzeGate({ projectRoot: root, framework: 'next', model: 'claude' as never, runModel: async () => { called++; return { text: '' }; } });
    expect(g).toMatchObject({ errors: 0, ok: true, repairAttempted: false });
    expect(called).toBe(0);

    // A real error in a route that exists is still counted.
    await write('app/live/page.ts', "const n: number = 'x';\nexport default function Page() { return n; }\n");
    const bad = await webTypecheck(root, 'next');
    expect(bad).toMatchObject({ ok: true, errors: 1 });
    expect((bad as { lines: string[] }).lines[0]).toMatch(/^app\/live\/page\.ts\(1,7\): error TS2322/);
  });

  it('flutter: an SDK that dies before analyzing (git "dubious ownership", exit 128) is "could not measure", never 0 issues', async () => {
    // Seen on the real resolve-app E2E: HOME=$WORKSPACE has no global gitconfig, the
    // root-owned SDK refuses to run, and the old parser read "no issue lines" as
    // {total:0, errors:0} — the gate said `ran` and would pass any broken tree.
    const { parseFlutterAnalyzeOutput } = await import('../src/relay-server/passes/flutter-analyze-output');
    const dubious = [
      "fatal: detected dubious ownership in repository at '/opt/sdk/flutter'",
      'To add an exception for this directory, call:',
      '',
      '\tgit config --global --add safe.directory /opt/sdk/flutter',
    ].join('\n');
    expect(parseFlutterAnalyzeOutput(dubious)).toBeNull();
    expect(parseFlutterAnalyzeOutput('')).toBeNull();
    expect(parseFlutterAnalyzeOutput('Analyzing app...\nNo issues found! (ran in 1.2s)\n')).toEqual({ total: 0, errors: 0, errorLines: [] });
    const two = "Analyzing app...\n\n  error • Undefined name 'x' • lib/a.dart:3:5 • undefined_identifier\n   info • Prefer const • lib/b.dart:1:1 • prefer_const_constructors\n\n2 issues found. (ran in 2.0s)\n";
    expect(parseFlutterAnalyzeOutput(two)).toMatchObject({ total: 2, errors: 1 });

    // Through the gate, with a real (fake) SDK binary that fails like the real one.
    const ws = path.join(root, 'ws');
    await write('ws/.relay/tools/flutter/bin/flutter', `#!/bin/sh\nprintf '%s\\n' "fatal: detected dubious ownership in repository at '/opt/sdk/flutter'" >&2\nexit 128\n`);
    await fs.chmod(path.join(ws, '.relay/tools/flutter/bin/flutter'), 0o755);
    await write('app/pubspec.yaml', 'name: app\n');
    const prev = process.env.WORKSPACE;
    process.env.WORKSPACE = ws;
    try {
      const g = await runAnalyzeGate({ projectRoot: path.join(root, 'app'), framework: 'flutter' });
      expect(g).toMatchObject({ errors: null, initialErrors: null, ok: true, repairAttempted: false });
      expect(g.unmeasured).toMatch(/printed no analysis .*dubious ownership/);
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE; else process.env.WORKSPACE = prev;
    }
  });

  it('nextHasTypegen: only Next >= 15.5', async () => {
    const { nextHasTypegen } = await import('../src/relay-server/passes/finalize');
    for (const [v, want] of [['14.2.5', false], ['15.4.9', false], ['15.5.0', true], ['16.3.7', true]] as const) {
      await write('node_modules/next/package.json', JSON.stringify({ name: 'next', version: v }));
      expect([v, nextHasTypegen(root)]).toEqual([v, want]);
    }
  });

  it('a web project with no installed typescript reports WHY it could not measure', async () => {
    await write('package.json', JSON.stringify({ dependencies: { react: '19' } }));
    await write('tsconfig.json', '{}');
    const g = await runAnalyzeGate({ projectRoot: root });
    expect(g).toMatchObject({ framework: 'react', errors: null, ok: true });
    expect(g.unmeasured).toMatch(/no typescript installed/);
  });
});

// ── PG-33 ────────────────────────────────────────────────────────────────────
describe('serveDir on a Next static export (PG-33)', () => {
  it('serves each route its own document; a route with no document is a 404, never the root page; a SPA keeps its fallback', async () => {
    const out = path.join(root, 'out');
    await fs.mkdir(path.join(out, '_preview', '10-4'), { recursive: true });
    await fs.mkdir(path.join(out, '_next'), { recursive: true });
    await fs.mkdir(path.join(out, 'assets', 'icons'), { recursive: true });
    await fs.writeFile(path.join(out, 'index.html'), '<html><head></head><body>ROOT</body></html>');
    await fs.writeFile(path.join(out, '404.html'), '<html><head></head><body>NF</body></html>');
    await fs.writeFile(path.join(out, '_preview', '10-3.html'), '<html><head></head><body>S103</body></html>');
    await fs.writeFile(path.join(out, '_preview', '10-4', 'index.html'), '<html><head></head><body>S104</body></html>');
    await fs.writeFile(path.join(out, 'assets', 'icons', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const srv = await serveDir(out);
    const base = srv.url.replace(/\/index\.html$/, '');
    try {
      const a = await fetch(`${base}/_preview/10-3`);
      expect(await a.text()).toMatch(/S103/);
      expect(srv.servedDocument('/_preview/10-3')).toBe('_preview/10-3.html');
      const b = await (await fetch(`${base}/_preview/10-4/`)).text();
      expect(b).toMatch(/S104/);
      // The readiness gate still rides on per-route documents of an app with assets.
      expect(b).toMatch(/__hold/);
      const c = await fetch(`${base}/_preview/10-9`);
      expect(c.status).toBe(404);
      expect(await c.text()).toMatch(/NF/);
      expect(srv.servedDocument('/_preview/10-9')).toBe('404');
      const svg = await fetch(`${base}/assets/icons/a.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    } finally { srv.close(); }

    // A Vite SPA (no _next/): client routes still fall back to index.html.
    await fs.rm(path.join(out, '_next'), { recursive: true });
    const spa = await serveDir(out);
    try {
      const r = await fetch(`${spa.url.replace(/\/index\.html$/, '')}/users/7`);
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/ROOT/);
      expect(spa.servedDocument('/users/7')).toBe('index.html');
    } finally { spa.close(); }
  });
});

describe('live web preview server on a Next static export (PG-33, same defect)', () => {
  it('/settings serves settings.html, an unknown route is the 404 page, a Vite SPA keeps its fallback', async () => {
    const { startStaticPreviewServer, stopFlutterPreviewServer } = await import('../src/relay-server/flutter-preview-server');
    const out = path.join(root, 'out');
    await fs.mkdir(path.join(out, '_next'), { recursive: true });
    await fs.writeFile(path.join(out, 'index.html'), '<html><head></head><body>ROOT</body></html>');
    await fs.writeFile(path.join(out, 'settings.html'), '<html><head></head><body>SETTINGS</body></html>');
    await fs.writeFile(path.join(out, '404.html'), '<html><head></head><body>NF</body></html>');
    const port = await startStaticPreviewServer('b56-live', out);
    try {
      const s = await fetch(`http://127.0.0.1:${port}/settings`);
      expect(s.status).toBe(200);
      expect(await s.text()).toMatch(/SETTINGS/);
      const n = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(n.status).toBe(404);
      expect(await n.text()).toMatch(/NF/);
    } finally { await stopFlutterPreviewServer('b56-live'); }
    await fs.rm(path.join(out, '_next'), { recursive: true });
    const p2 = await startStaticPreviewServer('b56-live2', out);
    try {
      const r = await fetch(`http://127.0.0.1:${p2}/users/7`);
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/ROOT/);
    } finally { await stopFlutterPreviewServer('b56-live2'); }
  });
});

describe('a Next route that also has nested routes (B56 fix round, PG-33)', () => {
  // `next build` (output: export) of app/10-3/page.tsx + app/10-3/about/page.tsx writes
  // out/10-3.html AND a directory out/10-3/ (holding about.html). The live preview
  // server answered /10-3 with 403 "Directory listing disabled" because its lookup
  // asked "does the path exist" before trying `<path>.html`.
  async function nestedExport(): Promise<string> {
    const out = path.join(root, 'out-nested');
    await fs.mkdir(path.join(out, '_next'), { recursive: true });
    await fs.mkdir(path.join(out, '10-3'), { recursive: true });
    await fs.writeFile(path.join(out, 'index.html'), '<html><head></head><body>ROOT</body></html>');
    await fs.writeFile(path.join(out, '404.html'), '<html><head></head><body>NF</body></html>');
    await fs.writeFile(path.join(out, '10-3.html'), '<html><head></head><body>S103</body></html>');
    await fs.writeFile(path.join(out, '10-3', 'about.html'), '<html><head></head><body>ABOUT</body></html>');
    return out;
  }

  it('live preview server: /10-3 and /10-3/ serve 10-3.html (not 403), /10-3/about serves its own document', async () => {
    const { startStaticPreviewServer, stopFlutterPreviewServer } = await import('../src/relay-server/flutter-preview-server');
    const out = await nestedExport();
    const port = await startStaticPreviewServer('b56-nested', out);
    try {
      for (const p of ['/10-3', '/10-3/']) {
        const r = await fetch(`http://127.0.0.1:${port}${p}`);
        expect(r.status, p).toBe(200);
        expect(await r.text()).toMatch(/S103/);
      }
      const a = await fetch(`http://127.0.0.1:${port}/10-3/about`);
      expect(a.status).toBe(200);
      expect(await a.text()).toMatch(/ABOUT/);
      const n = await fetch(`http://127.0.0.1:${port}/10-3/nope`);
      expect(n.status).toBe(404);
      expect(await n.text()).toMatch(/NF/);
    } finally { await stopFlutterPreviewServer('b56-nested'); }
  });

  it('verify server: the same export gives the same answers and records the document served', async () => {
    const out = await nestedExport();
    const srv = await serveDir(out);
    const base = srv.url.replace(/\/index\.html$/, '');
    try {
      for (const p of ['/10-3', '/10-3/']) {
        const r = await fetch(`${base}${p}`);
        expect(r.status, p).toBe(200);
        expect(await r.text()).toMatch(/S103/);
        expect(srv.servedDocument(p)).toBe('10-3.html');
      }
      expect(await (await fetch(`${base}/10-3/about`)).text()).toMatch(/ABOUT/);
      expect(srv.servedDocument('/10-3/about')).toBe('10-3/about.html');
    } finally { srv.close(); }
  });

  it('resolveRouteDocument: a regular file wins, a directory never does; a SPA falls through', async () => {
    const { resolveRouteDocument } = await import('../src/relay-server/static-route-doc');
    const out = await nestedExport();
    expect(resolveRouteDocument(out, '/10-3')).toMatchObject({ kind: 'doc', rel: '10-3.html' });
    expect(resolveRouteDocument(out, '/10-3/about')).toMatchObject({ kind: 'doc', rel: '10-3/about.html' });
    expect(resolveRouteDocument(out, '/missing')).toMatchObject({ kind: 'not-found' });
    expect(resolveRouteDocument(out, '/10-3.html')).toEqual({ kind: 'none' });
    expect(resolveRouteDocument(out, '/')).toEqual({ kind: 'none' });
    expect(resolveRouteDocument(out, '/../etc/passwd')).toEqual({ kind: 'none' });
    await fs.rm(path.join(out, '_next'), { recursive: true });
    expect(resolveRouteDocument(out, '/missing')).toEqual({ kind: 'none' });
  });
});

describe('POST /api/ai/resolve-app on web (PG-27, through the route)', () => {
  it('next: resolves from code, records framework next on its run; an app with no screens is `skipped` and canonical.json survives', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { registerAIRoutes } = await import('../src/relay-server/ai-routes');
    const { listRuns } = await import('../src/relay-server/build-run-store');
    const ws = root;
    process.env.WORKSPACE = ws;
    const proj = path.join(ws, 'projects', 'webres');
    await fs.cp(path.join(FIXTURES, 'next'), proj, { recursive: true });
    const app = express();
    app.use(express.json());
    registerAIRoutes(app);

    const ok = await request(app).post('/api/ai/resolve-app').send({ projectId: 'webres', noAi: true, assets: false, finalize: false });
    expect(ok.status).toBe(200);
    expect(ok.body.canonical.screens).toBe(5);
    expect(ok.body.canonical.modalsWithBase).toBeGreaterThanOrEqual(1);
    const runs = await listRuns('webres');
    expect(runs.find((r) => r.id === ok.body.runId)?.framework).toBe('next');

    const before = await fs.readFile(path.join(proj, '.uix', 'canonical.json'), 'utf8');
    for (const d of ['app', 'components', 'src']) await fs.rm(path.join(proj, d), { recursive: true, force: true });
    const sk = await request(app).post('/api/ai/resolve-app').send({ projectId: 'webres', noAi: true });
    expect(sk.status).toBe(200);
    expect(sk.body.status).toBe('skipped');
    expect(sk.body.reason).toMatch(/0 screens/);
    expect(sk.body.finalizeReport).toBeUndefined();              // never finalized against nothing
    expect(await fs.readFile(path.join(proj, '.uix', 'canonical.json'), 'utf8')).toBe(before);
  }, 60000);
});
