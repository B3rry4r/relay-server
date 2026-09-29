/**
 * PG-01 — finalize can record `skipped` + reason, and never `applied` with all-zero
 *         counts on a stub or a no-input run.
 * PG-37 — the web build gate uses the project's OWN typescript (never `npx tsc`,
 *         which installs the bogus `tsc@2` package), checks solution-style
 *         tsconfigs through their references, and a checker/build that cannot run
 *         is REPORTED as skipped with a reason — never read as a clean pass.
 *
 * The typecheck tests run the real TypeScript compiler (relay-server's own devDep,
 * linked into a scratch project as its node_modules/typescript) over planted errors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  finalizeApp, parseTscOutput, resolveLocalTypescript, tscProjectsFor, webTypecheck, __test,
} from '../src/relay-server/passes/finalize';

const FIXTURES = path.resolve(__dirname, 'fixtures', 'parity');
const REAL_TS = path.dirname(require.resolve('typescript/package.json'));

// finalize's git harness only operates on managed projects under $WORKSPACE/projects.
let ws = '';
let dir = '';
const prevWorkspace = process.env.WORKSPACE;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-gate-'));
  process.env.WORKSPACE = ws;
  dir = path.join(ws, 'projects', 'p');
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  if (prevWorkspace === undefined) delete process.env.WORKSPACE; else process.env.WORKSPACE = prevWorkspace;
  await fs.rm(ws, { recursive: true, force: true });
});

async function write(rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
}
async function linkRealTypescript(): Promise<void> {
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(REAL_TS, path.join(dir, 'node_modules', 'typescript'), 'dir');
}

// The exact banner `npx tsc` prints when it resolves to the unrelated tsc@2 package.
const TSC2_BANNER = [
  'npm warn exec The following package was not found and will be installed: tsc@2.0.4',
  'npm warn deprecated tsc@2.0.4: Package no longer supported.',
  '',
  '                This is not the tsc command you are looking for                ',
  '',
  'To get access to the TypeScript compiler, tsc, from the command line either:',
  '- Use npm install typescript to first add TypeScript to your project before using npx',
].join('\n');

describe('parseTscOutput', () => {
  it('the tsc@2 banner (exit 1, zero TS diagnostics) is NOT a typecheck → null', () => {
    expect(parseTscOutput(TSC2_BANNER, 1)).toBeNull();
  });
  it('a crash / killed checker with no diagnostics → null', () => {
    expect(parseTscOutput('', null)).toBeNull();
    expect(parseTscOutput('FATAL ERROR: Reached heap limit', 134)).toBeNull();
  });
  it('real diagnostics are counted; exit 0 is a clean run', () => {
    const out = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(3,1): error TS2304: Cannot find name 'x'.\n";
    expect(parseTscOutput(out, 2)).toEqual({ errors: 2, lines: expect.any(Array) });
    expect(parseTscOutput('', 0)).toEqual({ errors: 0, lines: [] });
  });
});

describe('resolveLocalTypescript — never npx, never the bogus package', () => {
  it('no node_modules → null', () => {
    expect(resolveLocalTypescript(dir)).toBeNull();
  });
  it('a stray `tsc` package is refused (only a package named typescript counts)', async () => {
    await write('node_modules/tsc/package.json', JSON.stringify({ name: 'tsc', version: '2.0.4' }));
    await write('node_modules/.bin/tsc', '#!/usr/bin/env node\nconsole.log("This is not the tsc command you are looking for")\n');
    await write('node_modules/typescript/package.json', JSON.stringify({ name: 'not-typescript', version: '1.0.0' }));
    expect(resolveLocalTypescript(dir)).toBeNull();
  });
  it('the project’s own typescript resolves', async () => {
    await linkRealTypescript();
    const r = resolveLocalTypescript(dir);
    expect(r?.tscJs).toBe(path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'));
    expect(r?.version).toMatch(/^\d+\.\d+/);
  });
});

describe('webTypecheck (real tsc)', () => {
  it('no typescript installed → skipped with that reason, never 0 errors', async () => {
    await write('package.json', JSON.stringify({ dependencies: { react: '^18' } }));
    await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
    await write('src/a.ts', 'export const x: number = "planted";\n');
    const r = await webTypecheck(dir, 'react');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no typescript installed/);
  });

  it('reports a planted type error with the project’s own compiler', async () => {
    await linkRealTypescript();
    await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ['es2020'] }, include: ['src'] }));
    await write('src/a.ts', 'export const x: number = "planted";\n');
    const r = await webTypecheck(dir, 'react');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.errors).toBe(1);
      expect(r.lines[0]).toMatch(/src\/a\.ts\(1,14\): error TS2322/);
      expect(r.tool).toMatch(/^typescript@/);
    }
    await write('src/a.ts', 'export const x: number = 1;\n');
    const clean = await webTypecheck(dir, 'react');
    expect(clean).toMatchObject({ ok: true, errors: 0 });
    // --incremental false: the gate never leaves a tsbuildinfo in the app.
    expect(fsSync.existsSync(path.join(dir, 'tsconfig.tsbuildinfo'))).toBe(false);
  });

  it('a Vite-style solution tsconfig (files: [] + references) is checked through its references', async () => {
    await linkRealTypescript();
    await write('tsconfig.json', `{
      // solution file — a bare \`tsc --noEmit\` here checks NOTHING
      "files": [],
      "references": [{ "path": "./tsconfig.app.json" }],
    }`);
    await write('tsconfig.app.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ['es2020'] }, include: ['src'] }));
    await write('src/a.ts', 'export const x: number = "planted";\n');
    expect(tscProjectsFor(dir).map((p) => path.basename(p.config))).toEqual(['tsconfig.app.json']);
    const r = await webTypecheck(dir, 'react');
    expect(r).toMatchObject({ ok: true, errors: 1 });
  });
});

describe('webBuildOk', () => {
  it('node_modules missing → did NOT run (ok:null + reason), never ok:true', async () => {
    await write('package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
    const r = await __test.webBuildOk(dir);
    expect(r.ok).toBeNull();
    expect(r.reason).toMatch(/node_modules missing/);
  });
  it('no build script → did NOT run (ok:null + reason)', async () => {
    await write('package.json', JSON.stringify({ scripts: {} }));
    const r = await __test.webBuildOk(dir);
    expect(r.ok).toBeNull();
    expect(r.reason).toMatch(/no "build" script/);
  });
});

describe('finalize records skipped + reason (PG-01)', () => {
  it('a project no strategy supports: every pass is skipped WITH a reason, none applied', async () => {
    await write('.uix/canonical.json', JSON.stringify({ screens: [{ canonicalId: 'c_1_1', name: 'Home', route: '/1-1', frameIds: ['1:1'] }], flow: { entryCanonicalId: 'c_1_1', edges: [] } }));
    const r = await finalizeApp('p', { projectRoot: dir, skipBuildCheck: true, noReport: true });
    expect(r.framework).toBe('unknown');
    expect(r.passes).toHaveLength(8);
    for (const p of r.passes) {
      expect(p.status, p.name).toBe('skipped');
      expect(p.reason, p.name).toBeTruthy();
    }
  });

  it('next fixture: stubs report skipped + reason; nothing is applied with all-zero counts', async () => {
    await fs.cp(path.join(FIXTURES, 'next'), dir, { recursive: true });
    const r = await finalizeApp('p', { projectRoot: dir, skipBuildCheck: true, noReport: true });
    const zeroApplied = r.passes.filter((p) => p.status === 'applied' && Object.values(p.counts).every((v) => !v));
    expect(zeroApplied).toEqual([]);
    const rename = r.passes.find((p) => p.name === 'renameSemantic')!;
    expect(rename.status).toBe('skipped');
    expect(rename.reason).toMatch(/Next App Router/);
    for (const p of r.passes.filter((x) => x.status === 'skipped')) expect(p.reason, p.name).toBeTruthy();
    // skipBuildCheck is itself reported, not dressed up as a passing gate.
    expect(r.gate.typecheck).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/skipBuildCheck/) });
  });

  it('a dry run records the same skip reasons and writes nothing', async () => {
    await fs.cp(path.join(FIXTURES, 'next'), dir, { recursive: true });
    const r = await finalizeApp('p', { projectRoot: dir, dryRun: true });
    expect(r.passes.find((p) => p.name === 'renameSemantic')).toMatchObject({ status: 'skipped', reason: expect.any(String) });
    expect(fsSync.existsSync(path.join(dir, '.uix', 'finalize-report.json'))).toBe(false);
    expect(fsSync.existsSync(path.join(dir, '.uix', 'flow-wiring-report.json'))).toBe(false);
  });
});

describe('finalize gate on a web project with no dependencies installed (PG-37)', () => {
  it('reports typecheck + build as skipped with reasons — never a clean gate', async () => {
    await fs.cp(path.join(FIXTURES, 'react'), dir, { recursive: true });
    const r = await finalizeApp('p', { projectRoot: dir, onlyPasses: ['verifyFlowWiring'], noReport: true });
    expect(r.gate.typecheck.status).toBe('skipped');
    expect(r.gate.typecheck.reason).toMatch(/no typescript installed/);
    expect(r.gate.build.status).toBe('skipped');
    expect(r.gate.build.reason).toMatch(/node_modules missing/);
    expect(r.baselineErrors).toBeNull();
  }, 60_000);

  it('a build that already fails before any pass is reported, and does not revert passes it cannot judge', async () => {
    await fs.cp(path.join(FIXTURES, 'react'), dir, { recursive: true });
    await linkRealTypescript();
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    pkg.scripts.build = 'node -e "console.error(\'baseline is broken\'); process.exit(3)"';
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const r = await finalizeApp('p', { projectRoot: dir, onlyPasses: ['verifyFlowWiring'], noReport: true });
    expect(r.gate.typecheck).toMatchObject({ status: 'ran', tool: expect.stringMatching(/^typescript@/) });
    expect(r.gate.build.status).toBe('skipped');
    expect(r.gate.build.reason).toMatch(/already fails before any pass/);
    expect(r.passes.find((p) => p.name === 'verifyFlowWiring')?.status).toBe('applied');
  }, 120_000);
});
