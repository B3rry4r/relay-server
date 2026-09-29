// Child-environment hygiene + boot validation (auth-audit §6 #18, #19; CONTRACTS §3 strip list).
import { execFile as execFileCb, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as createClient, type Socket } from 'socket.io-client';
import { AuthHarness, OWNER_SECRET } from './_auth-helpers';
import { defaultPtyFactory } from '../src/relay-server';
import { createTerminalEnv } from '../src/relay-server/runtime';
import {
  childProcessEnv,
  getSecret,
  resetSecretsVaultForTests,
  sanitizeChildEnv,
  sealProcessSecrets,
} from '../src/relay-server/auth/secrets';
import { hashOwnerSecret, validateOwnerSecretEnv } from '../src/relay-server/auth/owner-secret';

const execFile = promisify(execFileCb);
const h = new AuthHarness();
afterEach(async () => { resetSecretsVaultForTests(); await h.cleanup(); });

const SECRETS = {
  AUTH_TOKEN: OWNER_SECRET,
  AUTH_TOKEN_HASH: 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
  RELAY_PTY_TOKEN: 'pty-token-secret-value',
  RELAY_DEPLOY_TOKEN: 'deploy-token-secret-value',
  UIX_SERVICE_TOKEN: 'uix-service-secret-value',
  RELAY_TOKEN: 'relay-api-token-secret-value',
};
const PROCESS_VARS = {
  PORT: '4321',
  RELAY_RELEASE_ID: 'rel-123',
  RELAY_START_MODE: 'standby',
  RELAY_SKIP_BOOTSTRAP: '1',
  RELAY_HOST_PORTS: '8080',
  FLY_APP_NAME: 'relay-app',
  FLY_MACHINE_ID: 'm-1',
};
const SHELL_STRIPPED = [...Object.keys(SECRETS), ...Object.keys(PROCESS_VARS)];

describe('child env strip list (audit §6 #18)', () => {
  it('createTerminalEnv (PTY shell profile) contains none of the stripped vars', () => {
    Object.assign(process.env, SECRETS, PROCESS_VARS);
    const env = createTerminalEnv('/tmp/ws', { profile: 'shell' });
    for (const key of SHELL_STRIPPED) expect(env[key], key).toBeUndefined();
    expect(env.RELAY_LOCAL_TOKEN_FILE).toBe('/tmp/ws/.relay/state/local-token');
    expect(env.HOME).toBe('/tmp/ws');
  });

  it('agent profile strips the same list but keeps RELAY_RELEASE_ID (process tag)', () => {
    Object.assign(process.env, SECRETS, PROCESS_VARS);
    const env = createTerminalEnv('/tmp/ws');
    for (const key of SHELL_STRIPPED.filter((k) => k !== 'RELAY_RELEASE_ID')) expect(env[key], key).toBeUndefined();
    expect(env.RELAY_RELEASE_ID).toBe('rel-123');
    const generic = childProcessEnv({ EXTRA: '1' });
    expect(generic.EXTRA).toBe('1');
    for (const key of Object.keys(SECRETS)) expect(generic[key], key).toBeUndefined();
    expect(sanitizeChildEnv({ FLY_REGION: 'ams', OK: 'x' }, 'shell')).toEqual({ OK: 'x' });
  });

  it('sealProcessSecrets moves secrets out of process.env; getSecret still reads them; spawned children see none', async () => {
    Object.assign(process.env, SECRETS);
    const moved = sealProcessSecrets();
    expect(moved.sort()).toEqual(Object.keys(SECRETS).sort());
    for (const key of Object.keys(SECRETS)) {
      expect(process.env[key], key).toBeUndefined();
      expect(getSecret(key as keyof typeof SECRETS)).toBe(SECRETS[key as keyof typeof SECRETS]);
    }
    // A child that inherits process.env (no explicit env) — the case for git, chrome,
    // npm, flutter, python … across the codebase.
    const { stdout } = await execFile('env', []);
    for (const value of Object.values(SECRETS)) expect(stdout).not.toContain(value);
  });

  it('a REAL terminal (node-pty) spawned by relay runs `env` with none of the stripped vars', async () => {
    Object.assign(process.env, SECRETS, PROCESS_VARS);
    const realHash = hashOwnerSecret(OWNER_SECRET, 2 ** 12); // a hash that verifies, so login works
    process.env.AUTH_TOKEN_HASH = realHash;
    // Build the relay while the vars are present, exactly like production before sealing
    // is considered: the strip happens in createTerminalEnv regardless.
    const { base } = await h.boot({ SHELL: '/bin/bash', PORT: '0' }, { pty: defaultPtyFactory });
    const { body } = await request(base).post('/api/auth/login').send({ secret: OWNER_SECRET });
    const client: Socket = createClient(base, { auth: { token: body.token }, reconnection: false, transports: ['websocket'] });
    h.clients.push(client);
    const output: string[] = [];
    client.on('terminal:output', (p: { data: string }) => output.push(p.data));
    await new Promise<void>((resolve, reject) => { client.once('terminals:ready', () => resolve()); client.once('connect_error', reject); });
    client.emit('input', 'env | sort > /dev/stdout; echo __ENV_DONE__\r');
    const deadline = Date.now() + 15_000;
    while (!output.join('').includes('__ENV_DONE__\r\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const text = output.join('');
    expect(text).toContain('__ENV_DONE__');
    expect(text).toContain('RELAY_LOCAL_TOKEN_FILE=');
    expect(text).toMatch(/RELAY_API_URL=http:\/\/127\.0\.0\.1:\d+/);
    for (const key of SHELL_STRIPPED) expect(text, key).not.toMatch(new RegExp(`^${key}=`, 'm'));
    for (const value of [...Object.values(SECRETS), realHash]) expect(text).not.toContain(value);
    const shellPid = (await request(base).get('/api/terminals').set('Authorization', `Bearer ${body.token}`)).body.terminals[0]?.pid;
    if (shellPid) { try { process.kill(shellPid, 'SIGKILL'); } catch { /* gone */ } }
  }, 30_000);
});

describe('boot validation (audit §6 #19)', () => {
  it('validateOwnerSecretEnv', () => {
    expect(validateOwnerSecretEnv()).toMatchObject({ ok: false, error: expect.stringContaining('Neither AUTH_TOKEN_HASH nor AUTH_TOKEN') });
    process.env.AUTH_TOKEN = 'change_this_to_a_strong_random_string';
    expect(validateOwnerSecretEnv()).toMatchObject({ ok: false, error: expect.stringContaining('placeholder') });
    process.env.AUTH_TOKEN = 'short-secret';
    expect(validateOwnerSecretEnv()).toMatchObject({ ok: false, error: expect.stringContaining('shorter than 16') });
    process.env.AUTH_TOKEN = OWNER_SECRET;
    expect(validateOwnerSecretEnv()).toMatchObject({ ok: true, warnings: [expect.stringContaining('deprecated')] });
    delete process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN_HASH = 'scrypt$nope';
    expect(validateOwnerSecretEnv()).toMatchObject({ ok: false, error: expect.stringContaining('malformed') });
    process.env.AUTH_TOKEN_HASH = hashOwnerSecret(OWNER_SECRET, 2 ** 12);
    expect(validateOwnerSecretEnv()).toEqual({ ok: true, warnings: [] });
  });

  it('the real entrypoint (src/index.ts) exits 1 with a clear error before bootstrapping', async () => {
    const cwd = await h.tempDir('relay-boot-'); // no setup-workspace.sh here: bootstrap could never run anyway
    const viteNode = path.resolve(__dirname, '..', 'node_modules', '.bin', 'vite-node');
    const entry = path.resolve(__dirname, '..', 'src', 'index.ts');
    const run = (env: Record<string, string>) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, WORKSPACE: cwd, PORT: '0' };
      // cwd = a scratch dir: even if validation wrongly passed, process.cwd()/setup-workspace.sh
      // does not exist there, so the real bootstrap can never run on this box.
      const child = spawn(viteNode, [entry], { cwd, env: { ...base, ...env } });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdout.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
    const none = await run({});
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('FATAL: Neither AUTH_TOKEN_HASH nor AUTH_TOKEN is set');
    expect(none.stderr).not.toContain('[bootstrap] starting');
    const placeholder = await run({ AUTH_TOKEN: 'change_this_to_a_strong_random_string' });
    expect(placeholder.code).toBe(1);
    expect(placeholder.stderr).toContain('placeholder');
    const short = await run({ AUTH_TOKEN: 'too-short' });
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('shorter than 16');
  }, 60_000);
});
