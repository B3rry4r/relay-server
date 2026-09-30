// Shared fixtures for the auth test files (auth-sessions / auth-env / auth-tools).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, FakePty, type PtyFactory, type RelayServer } from '../src/relay-server';

export const OWNER_SECRET = 'owner-secret-for-tests-0123456789';

/** Env keys any auth test may set; all cleared after each test. */
export const AUTH_ENV_KEYS = [
  'PORT', 'WORKSPACE', 'SHELL', 'AUTH_TOKEN', 'AUTH_TOKEN_HASH', 'RELAY_LEGACY_TOKEN_UNTIL',
  'RELAY_ALLOWED_ORIGINS', 'RELAY_WEB_ORIGIN_PATTERN', 'RELAY_AUTH_SWEEP_MS', 'RELAY_TRUST_PROXY',
  'UIX_URL', 'UIX_BASE_URL', 'UIX_SERVICE_TOKEN', 'RELAY_PTY_TOKEN', 'RELAY_DEPLOY_TOKEN', 'RELAY_TOKEN',
  'RELAY_RELEASE_ID', 'RELAY_START_MODE', 'RELAY_SKIP_BOOTSTRAP', 'RELAY_HOST_PORTS', 'FLY_APP_NAME',
  'FLY_MACHINE_ID', 'RELAY_WEB_URL', 'RELAY_PUBLIC_URL',
];

export type Booted = { relay: RelayServer; port: number; base: string; workspace: string };

export class AuthHarness {
  readonly servers: RelayServer[] = [];
  readonly clients: Socket[] = [];
  readonly dirs: string[] = [];

  async tempDir(prefix = 'relay-auth-'): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  async workspace(): Promise<string> {
    const ws = await this.tempDir('relay-auth-ws-');
    await fs.mkdir(path.join(ws, 'projects'), { recursive: true });
    return ws;
  }

  /** Boot a relay on an ephemeral port. `env` is applied BEFORE createRelayServer. */
  async boot(env: Record<string, string | undefined> = {}, opts: { workspace?: string; pty?: PtyFactory } = {}): Promise<Booted> {
    const workspace = opts.workspace ?? await this.workspace();
    process.env.WORKSPACE = workspace;
    process.env.PORT = '0';
    if (!('AUTH_TOKEN' in env) && !('AUTH_TOKEN_HASH' in env)) process.env.AUTH_TOKEN = OWNER_SECRET;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const relay = createRelayServer(opts.pty ?? (() => new FakePty()));
    this.servers.push(relay);
    const port = await relay.start();
    return { relay, port, base: `http://127.0.0.1:${port}`, workspace };
  }

  async login(base: string, secret = OWNER_SECRET, headers: Record<string, string> = {}): Promise<{ token: string; session: { id: string } }> {
    let req = request(base).post('/api/auth/login').send({ secret, label: 'test' });
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    const res = await req;
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** Connect a socket; resolves the socket or rejects with the connect_error. */
  async connect(base: string, token: string, extra: { extraHeaders?: Record<string, string> } = {}): Promise<Socket> {
    const client = createClient(base, {
      auth: { token },
      reconnection: false,
      transports: ['websocket'],
      ...(extra.extraHeaders ? { extraHeaders: extra.extraHeaders } : {}),
    });
    this.clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (error) => reject(error));
    });
    return client;
  }

  async cleanup(): Promise<void> {
    for (const client of this.clients.splice(0)) client.disconnect();
    for (const server of this.servers.splice(0)) await server.stop();
    for (const key of AUTH_ENV_KEYS) delete process.env[key];
    for (const dir of this.dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
}

export function waitFor<T>(emitter: { once(event: string, cb: (arg: T) => void): unknown }, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (arg: T) => { clearTimeout(timer); resolve(arg); });
  });
}
