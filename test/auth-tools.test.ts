// relay-auth CLI, its setup-workspace install, mcp-server.mjs credentials
// (auth-audit §6 #30-#32) and the UIX service-token proxies (CONTRACTS §2 "UIX").
import { execFile as execFileCb, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AuthHarness, OWNER_SECRET } from './_auth-helpers';
import { closeHarnessUixProxy, getHarnessUixBase, uixFetch } from '../src/relay-server/uix';

const execFile = promisify(execFileCb);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'relay-auth');
const h = new AuthHarness();
const mocks: http.Server[] = [];
afterEach(async () => {
  await closeHarnessUixProxy();
  for (const m of mocks.splice(0)) await new Promise((r) => m.close(r));
  await h.cleanup();
});

async function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile('node', [CLI, ...args], { env: { PATH: process.env.PATH!, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('relay-auth CLI (loopback + local token)', () => {
  it('whoami, mint, sessions, login-link → exchange (one use), revoke, local-token --rotate, hash-secret', async () => {
    const { base, workspace } = await h.boot({ RELAY_WEB_URL: 'https://relay-web.example.com', RELAY_PUBLIC_URL: 'https://relay.example.com' });
    const env = { RELAY_HOME: path.join(workspace, '.relay') }; // api-url + local-token come from $RELAY_HOME/state

    const who = await cli(['whoami', '--json'], env);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toEqual({ authenticated: true, via: 'local' });

    const minted = await cli(['mint', '--label', 'uix', '--json'], env);
    const { token: apiToken, session } = JSON.parse(minted.stdout);
    expect(session).toMatchObject({ kind: 'api', label: 'uix' });
    expect((await request(base).get('/api/projects').set('x-forwarded-for', '3.3.3.3').set('Authorization', `Bearer ${apiToken}`)).status).toBe(200);

    const listed = await cli(['sessions'], env);
    expect(listed.stdout).toContain(session.id);
    expect(listed.stdout).toContain('uix');

    const link = JSON.parse((await cli(['login-link', '--json'], env)).stdout);
    expect(link.url).toBe(`https://relay-web.example.com/#relay-login-link=${encodeURIComponent(link.code)}&relay-server=${encodeURIComponent('https://relay.example.com')}`);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // The browser (a remote client, no credential) exchanges the code once.
    const ex = await request(base).post('/api/auth/login-link/exchange').set('x-forwarded-for', '4.4.4.4').send({ code: link.code, label: 'phone' });
    expect(ex.status).toBe(200);
    expect(ex.body.session).toMatchObject({ kind: 'browser', label: 'phone' });
    expect((await request(base).get('/api/projects').set('x-forwarded-for', '4.4.4.4').set('Authorization', `Bearer ${ex.body.token}`)).status).toBe(200);
    const again = await request(base).post('/api/auth/login-link/exchange').set('x-forwarded-for', '5.5.5.5').send({ code: link.code });
    expect(again.status).toBe(401);
    expect(fsSync.readdirSync(path.join(workspace, '.relay', 'state', 'login-links'))).toEqual([]);

    const human = await cli(['login-link', '--web', 'https://w.example', '--server', 'https://s.example'], env);
    expect(human.stdout).toContain('https://w.example/#relay-login-link=');

    const revoke = await cli(['revoke', session.id], env);
    expect(revoke.code).toBe(0);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${apiToken}`)).status).toBe(401);

    const tokenFile = path.join(workspace, '.relay', 'state', 'local-token');
    const before = fsSync.readFileSync(tokenFile, 'utf8');
    expect((await cli(['local-token', '--rotate'], env)).code).toBe(0);
    expect(fsSync.readFileSync(tokenFile, 'utf8')).not.toBe(before);
    expect((await cli(['whoami'], env)).stdout).toContain('authenticated via local');

    const all = await cli(['revoke', '--all', '--json'], env);
    expect(JSON.parse(all.stdout).revoked).toBe(1); // the phone session
  }, 30_000);

  it('hash-secret output is accepted as AUTH_TOKEN_HASH', async () => {
    const hashed = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [CLI, 'hash-secret']);
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
      child.stdin.end(`${OWNER_SECRET}\n`);
    });
    expect(hashed).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const { base } = await h.boot({ AUTH_TOKEN: undefined, AUTH_TOKEN_HASH: hashed });
    expect((await request(base).post('/api/auth/login').send({ secret: OWNER_SECRET })).status).toBe(200);
  });

  it('fails clearly when the local token is unreadable or the credential is not local', async () => {
    const { workspace, base } = await h.boot();
    const missing = await cli(['whoami'], { RELAY_HOME: path.join(workspace, 'nope'), RELAY_API_URL: base });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read the local token');
  });
});

describe('setup-workspace.sh installs relay-auth into $RELAY_HOME/bin idempotently', () => {
  it('runs the install block twice: executable, identical, untouched the second time', async () => {
    const script = fsSync.readFileSync(path.join(ROOT, 'setup-workspace.sh'), 'utf8');
    const start = script.indexOf('# relay-auth: box-local session management');
    const end = script.indexOf('if [[ ! -f "$WORKSPACE/.gemini/settings.json" ]]');
    expect(start).toBeGreaterThan(0);
    const block = script.slice(start, end);
    const bin = await h.tempDir('relay-bin-');
    // Run the block as it appears, from a copy of the script placed next to scripts/.
    const harness = path.join(ROOT, `.setup-block-${process.pid}.sh`);
    await fs.writeFile(harness, `#!/usr/bin/env bash\nset -euo pipefail\nRELAY_BIN_DIR="$1"\nrecord_status() { :; }\n${block}\n`, { mode: 0o755 });
    try {
      await execFile('bash', [harness, bin]);
      const dest = path.join(bin, 'relay-auth');
      const st1 = fsSync.statSync(dest);
      expect(st1.mode & 0o111).not.toBe(0);
      expect(fsSync.readFileSync(dest, 'utf8')).toBe(fsSync.readFileSync(CLI, 'utf8'));
      await new Promise((r) => setTimeout(r, 20));
      await execFile('bash', [harness, bin]);
      expect(fsSync.statSync(dest).mtimeMs).toBe(st1.mtimeMs);
    } finally {
      await fs.rm(harness, { force: true });
    }
    expect(script).toContain('export RELAY_LOCAL_TOKEN_FILE="$RELAY_STATE_DIR/local-token"');
  });
});

// ── MCP (audit §6 #30-32) ───────────────────────────────────────────────────

async function mcpCall(env: Record<string, string>, tool: string): Promise<{ result: unknown; stderr: string }> {
  const child = spawn('node', [path.join(ROOT, 'mcp-server.mjs')], { env: { PATH: process.env.PATH!, ...env }, cwd: ROOT });
  let stderr = '';
  let buf = '';
  const pending = new Map<number, (msg: unknown) => void>();
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); } catch { /* not json */ }
    }
  });
  const rpc = (id: number, method: string, params: unknown) => new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out; stderr=${stderr}`)), 15_000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m as { result?: unknown }); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    if (init.error) throw new Error(JSON.stringify(init.error));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const call = await rpc(2, 'tools/call', { name: tool, arguments: {} });
    return { result: call.result ?? call.error, stderr };
  } finally {
    child.kill('SIGKILL');
  }
}

describe('mcp-server.mjs credential order (audit §6 #30-32)', () => {
  it('RELAY_TOKEN (api session) → HTTP + socket work', async () => {
    const { base } = await h.boot();
    const browser = await h.login(base);
    const minted = await request(base).post('/api/auth/sessions').set('Authorization', `Bearer ${browser.token}`).send({ label: 'mcp', kind: 'api' });
    const { relay } = h.servers.length ? { relay: h.servers[0] } : { relay: null };
    const env = { RELAY_TOKEN: minted.body.token, RELAY_BACKEND_URL: base, WORKSPACE: '/nonexistent' };
    const out = await mcpCall(env, 'relay_projects_list');
    expect(out.stderr).toContain('using RELAY_TOKEN');
    expect(JSON.stringify(out.result)).toContain('projects');
    expect(JSON.stringify(out.result)).not.toContain('isError":true');
    // relay_terminal_create goes over the Socket.IO bridge: proves the socket handshake
    // authenticated with the same api session.
    const term = await mcpCall(env, 'relay_terminal_create');
    expect(JSON.stringify(term.result)).not.toContain('isError":true');
    expect(JSON.stringify(term.result)).toMatch(/"id"/);
    void relay;
  }, 30_000);

  it('local-token file on loopback → works (no env credential at all)', async () => {
    const { base, workspace } = await h.boot();
    const out = await mcpCall({ WORKSPACE: workspace, RELAY_API_URL: base }, 'relay_projects_list');
    expect(out.stderr).toContain('using local-token');
    expect(JSON.stringify(out.result)).toContain('projects');
    expect(JSON.stringify(out.result)).not.toContain('isError":true');
  }, 30_000);

  it('only AUTH_TOKEN → works during the legacy window, with a deprecation warning; fails after it', async () => {
    const open = await h.boot();
    const ok = await mcpCall({ AUTH_TOKEN: OWNER_SECRET, RELAY_BACKEND_URL: open.base, WORKSPACE: '/nonexistent' }, 'relay_projects_list');
    expect(ok.stderr).toContain('WARNING: authenticating with the raw AUTH_TOKEN');
    expect(JSON.stringify(ok.result)).not.toContain('isError":true');
    await h.cleanup();
    const closed = await h.boot({ RELAY_LEGACY_TOKEN_UNTIL: 'off' });
    const denied = await mcpCall({ AUTH_TOKEN: OWNER_SECRET, RELAY_BACKEND_URL: closed.base, WORKSPACE: '/nonexistent' }, 'relay_projects_list');
    expect(JSON.stringify(denied.result)).toContain('unauthorized');
  }, 60_000);
});

// ── UIX service token ────────────────────────────────────────────────────────

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; bodyLength: number };
async function mockUix(respond?: (req: http.IncomingMessage, res: http.ServerResponse, self: string) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let self = '';
  const server = http.createServer((req, res) => {
    let len = 0;
    req.on('data', (c: Buffer) => { len += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, bodyLength: len });
      if (respond) { respond(req, res, self); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, path: req.url, received: len }));
    });
  });
  mocks.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  self = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: self, seen };
}

describe('UIX proxies and service token', () => {
  it('ALL /api/uix/* → UIX: session-authenticated, relay credentials stripped, token added, bodies streamed', async () => {
    const uix = await mockUix();
    const { base } = await h.boot({ UIX_URL: uix.url, UIX_SERVICE_TOKEN: 'uix-svc-secret', RELAY_ALLOWED_ORIGINS: 'https://relay-web.example.com' });
    expect((await request(base).get('/api/uix/api/v1/figma/uploads')).status).toBe(401);
    expect(uix.seen).toHaveLength(0);
    const { token } = await h.login(base);
    const res = await request(base).get('/api/uix/api/v1/figma/uploads?x=1')
      .set('Authorization', `Bearer ${token}`).set('Cookie', 'a=b').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, path: '/api/v1/figma/uploads?x=1' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined(); // UIX's '*' never reaches the browser
    const got = uix.seen[0];
    expect(got.headers['x-uix-service-token']).toBe('uix-svc-secret');
    expect(got.headers.authorization).toBeUndefined();
    expect(got.headers['x-auth-token']).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
    // 60 MB upload: larger than relay's 50 MB JSON limit, streamed untouched.
    const big = Buffer.alloc(60 * 1024 * 1024, 0x20); // 60 MB of JSON whitespace
    const up = await fetch(`${base}/api/uix/api/v1/figma/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-filename': 'a.fig' },
      body: big,
    });
    expect(up.status).toBe(200);
    expect((await up.json()).received).toBe(big.length);
    expect(uix.seen[1].headers['x-filename']).toBe('a.fig');
    expect(uix.seen[1].headers['x-uix-service-token']).toBe('uix-svc-secret');
  }, 30_000);

  it('uixFetch adds the token only for the UIX origin', async () => {
    const uix = await mockUix();
    const other = await mockUix();
    process.env.UIX_URL = uix.url;
    process.env.UIX_SERVICE_TOKEN = 'uix-svc-secret';
    await uixFetch('/api/v1/figma/uploads');
    await uixFetch(`${uix.url}/assets/a.png`);
    await uixFetch(`${other.url}/assets/b.png`);
    expect(uix.seen.map((s) => s.headers['x-uix-service-token'])).toEqual(['uix-svc-secret', 'uix-svc-secret']);
    expect(other.seen[0].headers['x-uix-service-token']).toBeUndefined();
  });

  it('harness loopback proxy: adds the token, rewrites UIX URLs in JSON to itself, loopback-only, not tunnellable', async () => {
    const uix = await mockUix((req, res, self) => {
      if (req.url?.startsWith('/api/v1/figma/uploads')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uploads: [{ assets: [{ url: `${self}/assets/img.png` }] }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([1, 2, 3]));
    });
    const { base } = await h.boot({ UIX_URL: uix.url, UIX_SERVICE_TOKEN: 'uix-svc-secret' });
    const proxyBase = await getHarnessUixBase();
    expect(proxyBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxyBase).not.toBe(uix.url);
    const list = await fetch(`${proxyBase}/api/v1/figma/uploads`).then((r) => r.json()) as { uploads: Array<{ assets: Array<{ url: string }> }> };
    const assetUrl = list.uploads[0].assets[0].url;
    expect(assetUrl).toBe(`${proxyBase}/assets/img.png`); // routed back through the proxy
    const bytes = Buffer.from(await (await fetch(assetUrl)).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(uix.seen.map((s) => s.headers['x-uix-service-token'])).toEqual(['uix-svc-secret', 'uix-svc-secret']);
    // The page never sees the token.
    expect(JSON.stringify(list)).not.toContain('uix-svc-secret');
    // Anything that came through a proxy/tunnel is refused.
    expect((await fetch(`${proxyBase}/api/v1/figma/uploads`, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(403);
    // …and relay refuses to tunnel it.
    const { token } = await h.login(base);
    const port = Number(new URL(proxyBase).port);
    const tunnel = await request(base).get(`/api/previews/${port}/tunnel`).set('Authorization', `Bearer ${token}`);
    expect(tunnel.status).toBe(403);
    expect(tunnel.body.message).toContain('UIX loopback proxy');
  });
});
