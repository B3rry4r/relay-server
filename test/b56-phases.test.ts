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
