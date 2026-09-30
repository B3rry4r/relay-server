// =============================================================================
// npm run pack:release (CONTRACTS §3): the tarball the relay host installs.
//
//  - holds package.json at its root, the compiled entry and EVERY runtime-read
//    file — and no sources, tests or node_modules
//  - every repo-root-relative path the compiled server reads (process.cwd()-
//    relative joins, found by scanning dist) is in the tarball or is a documented
//    optional binary
//  - manifest.json {id, sha, lockHash, node, builtAt, entry}; release.sha256
//    matches the tarball
//  - UNPACKED, it boots: standby /health with its release id, IPC activate →
//    activated, SIGTERM → exit 0; its own setup-workspace.sh installs relay-auth
// =============================================================================

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRelease, RUNTIME_FILES, ENTRY } from '../scripts/pack-release.mjs';

const ROOT = path.resolve(__dirname, '..');
// Paths the server reads relative to its cwd that are deliberately NOT shipped.
const OPTIONAL_CWD_READS: Record<string, string> = {
  build: 'build/pty-bridge — optional native bridge binary, compiled on the machine (off unless RELAY_PTY_BRIDGE)',
  native: 'native/pty-bridge — the compiled bridge binary (only native/pty-bridge.c ships)',
};

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

describe('pack:release', () => {
  let work = '';
  let result: { id: string; tgz: string; sha256: string; manifest: Record<string, unknown>; files: string[] };
  let app = '';

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-packtest-'));
    result = packRelease({ out: path.join(work, 'out'), id: 'pack-test-1' });
    app = path.join(work, 'app');
    fs.mkdirSync(app);
    const x = spawnSync('tar', ['-xzf', result.tgz, '-C', app], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(x.stderr);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('writes release.tgz + manifest.json + a matching sha256', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'out', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ id: 'pack-test-1', entry: ENTRY, node: process.version });
    expect(manifest.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.lockHash).toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex'));
    expect(Number.isNaN(Date.parse(manifest.builtAt))).toBe(false);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(result.tgz)).digest('hex');
    expect(fs.readFileSync(path.join(work, 'out', 'release.sha256'), 'utf8')).toBe(`${actual}  release.tgz\n`);
    // The copy inside the tarball is the same manifest (the host reads that one).
    expect(JSON.parse(fs.readFileSync(path.join(app, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  it('ships the entry and every runtime file, nothing else', () => {
    expect(fs.existsSync(path.join(app, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(app, ENTRY))).toBe(true);
    for (const rel of RUNTIME_FILES as string[]) expect(fs.existsSync(path.join(app, rel)), rel).toBe(true);
    expect(fs.statSync(path.join(app, 'setup-workspace.sh')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(app, 'scripts', 'relay-auth')).mode & 0o111).not.toBe(0);
    const bad = result.files.filter((f: string) => f.startsWith('node_modules/') || f.startsWith('test/') || f.startsWith('src/') || f.startsWith('dist/test/') || f.endsWith('.ts') || f.endsWith('.map'));
    expect(bad).toEqual([]);
  });

  it('the finalize readability metric loads from the unpacked release (dist/src only)', () => {
    const tool = path.join(app, 'dist', 'src', 'relay-server', 'readability-report.cjs');
    expect(fs.existsSync(tool)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(tool);
    expect(typeof loaded.main).toBe('function');
  });

  it('every cwd-relative path the compiled server reads is shipped (or a documented optional binary)', () => {
    const js: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) js.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(path.join(app, 'dist', 'src'));
    const reads = new Set<string>();
    const re = /path(?:_1\.default|\.default)?\.(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*['"]([^'"]+)['"]/g;
    for (const source of js) for (const m of source.matchAll(re)) reads.add(m[1]);
    expect(reads.size).toBeGreaterThan(0);
    const missing = [...reads].filter((rel) => !fs.existsSync(path.join(app, rel)) && !(rel in OPTIONAL_CWD_READS));
    expect(missing, `found: ${[...reads].join(', ')}`).toEqual([]);
    expect([...reads]).toEqual(expect.arrayContaining(['package.json', 'setup-workspace.sh']));
  });

  it('the unpacked release boots in standby, activates over IPC and exits cleanly on SIGTERM', async () => {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'));
    const ws = path.join(work, 'ws');
    fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });

    // The release's own setup script installs ITS relay-auth (offline, no /etc).
    const setup = spawnSync('bash', [path.join(app, 'setup-workspace.sh')], {
      encoding: 'utf8', cwd: app, timeout: 60_000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ws, WORKSPACE: ws, RELAY_SETUP_SYSTEM_IDENTITY: '0', https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
    });
    expect(setup.status, setup.stderr).toBe(0);
    expect(fs.readFileSync(path.join(ws, '.relay', 'bin', 'relay-auth'))).toEqual(fs.readFileSync(path.join(app, 'scripts', 'relay-auth')));

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('RELAY_') || k.startsWith('VITEST') || k === 'AUTH_TOKEN' || k === 'AUTH_TOKEN_HASH') delete env[k];
    Object.assign(env, {
      WORKSPACE: ws, HOME: ws, PORT: '0', AUTH_TOKEN: 'owner-secret-for-pack-tests-0123456789',
      RELAY_SKIP_BOOTSTRAP: '1', RELAY_START_MODE: 'standby', RELAY_RELEASE_ID: result.id, NODE_ENV: 'production',
    });
    const child = spawn(process.execPath, [ENTRY], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    const messages: unknown[] = [];
    child.on('message', (m) => messages.push(m));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      let port = 0;
      for (let i = 0; i < 200 && !port; i += 1) {
        port = Number(/Relay listening on port (\d+)/.exec(out)?.[1] ?? 0);
        if (!port) await sleep(100);
      }
      expect(port, out).toBeGreaterThan(0);
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health).toMatchObject({ ok: true, releaseId: 'pack-test-1', mode: 'standby', ptyMode: 'embedded' });
      expect(await (await fetch(`http://127.0.0.1:${port}/api/version`)).json()).toEqual({ version: '1.0.0', releaseId: 'pack-test-1' });
      child.send({ type: 'activate' });
      for (let i = 0; i < 50 && messages.length === 0; i += 1) await sleep(100);
      expect(messages).toEqual([{ type: 'activated', releaseId: 'pack-test-1' }]);
      expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).mode).toBe('active');
      child.kill('SIGTERM');
      expect(await Promise.race([exited, sleep(10_000).then(() => 'timeout')])).toBe(0);
      expect(out).toContain('shutdown complete');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});
