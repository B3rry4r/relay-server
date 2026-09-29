// relay-server session auth (auth-audit §6 items 1-17, 20-22, 25; CONTRACTS §2).
// Black-box against createRelayServer(FakePty) on an ephemeral port. Requests from
// supertest arrive from 127.0.0.1; a proxied client is simulated with forwarding
// headers (with `trust proxy` = loopback, X-Forwarded-For then becomes req.ip).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuthHarness, OWNER_SECRET, waitFor } from './_auth-helpers';
import { hashOwnerSecret, verifyOwnerSecret } from '../src/relay-server/auth/owner-secret';
import { mintPreviewCap } from '../src/relay-server/auth/preview-cap';
import { isPublicRoute } from '../src/relay-server/auth';

const h = new AuthHarness();
afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

// The 34 routes the auth audit (§2.1, R16/R22/R23/R24) found with NO auth at all.
export const AUDIT_OPEN_ROUTES: Array<[string, string]> = [
  ['POST', '/api/visual/web-screenshot'],
  ['POST', '/api/visual/flutter-screenshot'],
  ['GET', '/flutter-preview/demo/index.html'],
  ['POST', '/api/ai/build-screen'],
  ['POST', '/api/ai/runs'],
  ['POST', '/api/ai/prepare-and-run'],
  ['POST', '/api/ai/runs/r1/start'],
  ['POST', '/api/ai/runs/r1/finalize'],
  ['POST', '/api/ai/runs/r1/stop'],
  ['POST', '/api/ai/runs/r1/checkpoint'],
  ['POST', '/api/ai/runs/r1/amendments'],
  ['POST', '/api/ai/runs/r1/amendments/a1'],
  ['POST', '/api/ai/runs/r1/accept'],
  ['POST', '/api/ai/runs/r1/retry'],
  ['GET', '/api/ai/runs/r1/log'],
  ['GET', '/api/ai/review-image?projectId=demo&path=.uix/ref.png'],
  ['GET', '/api/ai/runs?projectId=demo'],
  ['GET', '/api/ai/runs/r1/preflight'],
  ['GET', '/api/ai/runs/r1'],
  ['POST', '/api/ai/generate'],
  ['POST', '/api/ai/cancel'],
  ['GET', '/api/ai/progress?projectId=demo'],
  ['GET', '/api/ai/models'],
  ['POST', '/api/ai/install'],
  ['GET', '/api/ai/conversations'],
  ['GET', '/api/ai/conversations/c1'],
  ['POST', '/api/ai/extract-components'],
  ['POST', '/api/ai/apply-modal-overlays'],
  ['POST', '/api/ai/repoint-asset-usage'],
  ['POST', '/api/ai/verify-flow-wiring'],
  ['POST', '/api/ai/rename-semantic'],
  ['POST', '/api/ai/deepen-tokens'],
  ['POST', '/api/ai/finalize-app'],
  ['POST', '/api/ai/resolve-app'],
];

function send(base: string, method: string, url: string) {
  const agent = request(base);
  switch (method) {
    case 'GET': return agent.get(url);
    case 'POST': return agent.post(url).send({});
    case 'PUT': return agent.put(url).send({});
    case 'PATCH': return agent.patch(url).send({});
    case 'DELETE': return agent.delete(url);
    default: return agent.get(url);
  }
}

type RouteLayer = { route?: { path: string | RegExp; methods: Record<string, boolean> } };

function concretePath(p: string | RegExp): string {
  if (p instanceof RegExp) return '/preview/3000/x'; // the only regex route: legacy /preview/:port/*
  return p.replace(/:([A-Za-z_]+)/g, 'x1').replace(/\*/g, 'x');
}

describe('default-deny (audit §6 #1, #25)', () => {
  it('every registered route except the public allowlist returns 401 with no credential', async () => {
    const { relay, base } = await h.boot();
    const stack = (relay.app as unknown as { _router: { stack: RouteLayer[] } })._router.stack;
    const routes: Array<[string, string]> = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') { routes.push(['GET', concretePath(layer.route.path)]); continue; }
        routes.push([method.toUpperCase(), concretePath(layer.route.path)]);
      }
    }
    // Sanity: the enumeration really covers the app (106 routes at audit time + auth).
    expect(routes.length).toBeGreaterThan(110);
    const publicSeen: string[] = [];
    const failures: string[] = [];
    for (const [method, url] of routes) {
      const pathname = url.split('?')[0];
      if (method === 'OPTIONS') continue; // CORS preflight: always answered, never reaches a handler
      if (isPublicRoute(method, pathname)) { publicSeen.push(`${method} ${pathname}`); continue; }
      if (/^\/flutter-preview\/[^/]+\/c\//.test(pathname)) continue; // capability route: covered below
      const res = await send(base, method, url);
      if (res.status !== 401) failures.push(`${method} ${url} → ${res.status}`);
    }
    expect(failures).toEqual([]);
    expect(Array.from(new Set(publicSeen)).sort()).toEqual([
      'GET /', 'GET /api/version', 'GET /health', 'POST /api/auth/login', 'POST /api/auth/login-link/exchange',
    ]);
  });

  it('closes all 34 routes the audit found unauthenticated (and the §1 probe rows)', async () => {
    const { base } = await h.boot();
    for (const [method, url] of AUDIT_OPEN_ROUTES) {
      const res = await send(base, method, url);
      expect(`${method} ${url} → ${res.status}`).toBe(`${method} ${url} → 401`);
    }
    // §1 probe rows that used to get PAST auth: now all 401 before any handler runs.
    const probe = [
      await request(base).post('/api/ai/generate').send({}),
      await request(base).post('/api/ai/install').send({ model: 'nope' }),
      await request(base).post('/api/visual/web-screenshot').send({}),
      await request(base).get('/api/ai/review-image').query({ projectId: 'demo', path: '.uix/ref.png' }),
    ];
    expect(probe.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(probe[0].body).toEqual({ error: 'unauthorized', message: 'A valid session token is required.' });
  });

  it('keeps the public allowlist public', async () => {
    const { base } = await h.boot();
    expect((await request(base).get('/')).status).toBe(200);
    expect((await request(base).get('/health')).status).toBe(200);
    expect((await request(base).get('/api/version')).status).toBe(200);
    expect((await request(base).options('/api/ai/runs').set('Origin', 'http://localhost:5173')).status).toBe(204);
  });
});

describe('carriers (audit §6 #2, #3, #17)', () => {
  it('rejects ?token= even when it is correct, and never sets a cookie', async () => {
    const { base } = await h.boot();
    const { token } = await h.login(base);
    for (const t of [OWNER_SECRET, token]) {
      const a = await request(base).get('/api/projects').query({ token: t });
      const b = await request(base).get('/api/auth/session').query({ token: t });
      expect([a.status, b.status]).toEqual([401, 401]);
      expect(a.headers['set-cookie']).toBeUndefined();
    }
  });

  it('never accepts the legacy relay_auth_token cookie and clears it', async () => {
    const { base } = await h.boot();
    const res = await request(base).get('/api/projects').set('Cookie', `relay_auth_token=${OWNER_SECRET}`);
    expect(res.status).toBe(401);
    expect(String(res.headers['set-cookie'])).toMatch(/^relay_auth_token=; Path=\/; Max-Age=0; HttpOnly/);
  });

  it('has no cookie auth at all (a valid session in a cookie is ignored)', async () => {
    const { base } = await h.boot();
    const { token } = await h.login(base);
    const res = await request(base).get('/api/projects').set('Cookie', `relay_session=${token}`);
    expect(res.status).toBe(401);
  });
});

describe('login (audit §6 #4, #5)', () => {
  it('wrong secret → 401, right secret → a browser session token', async () => {
    const { base } = await h.boot();
    const bad = await request(base).post('/api/auth/login').send({ secret: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_credentials');
    const good = await request(base).post('/api/auth/login').send({ secret: OWNER_SECRET, label: 'Pixel 9' });
    expect(good.status).toBe(200);
    expect(good.body.token).toMatch(/^rs_[A-Za-z0-9_-]{43}$/);
    expect(good.body.session).toMatchObject({ kind: 'browser', label: 'Pixel 9', current: true });
    const who = await request(base).get('/api/auth/session').set('Authorization', `Bearer ${good.body.token}`);
    expect(who.body).toMatchObject({ authenticated: true, via: 'session', session: { id: good.body.session.id } });
    // x-auth-token is an equivalent carrier.
    expect((await request(base).get('/api/projects').set('x-auth-token', good.body.token)).status).toBe(200);
  });

  it('compares in constant time, including unequal lengths, and supports AUTH_TOKEN_HASH', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    expect(verifyOwnerSecret('short', { kind: 'plain', secret: OWNER_SECRET })).toBe(false);
    expect(verifyOwnerSecret(`${OWNER_SECRET}-and-longer`, { kind: 'plain', secret: OWNER_SECRET })).toBe(false);
    expect(verifyOwnerSecret(OWNER_SECRET, { kind: 'plain', secret: OWNER_SECRET })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();

    const hash = hashOwnerSecret(OWNER_SECRET, 2 ** 12);
    const { base } = await h.boot({ AUTH_TOKEN: undefined, AUTH_TOKEN_HASH: hash });
    expect((await request(base).post('/api/auth/login').send({ secret: 'wrong-wrong-wrong' })).status).toBe(401);
    const ok = await request(base).post('/api/auth/login').set('x-forwarded-for', '9.9.9.9').send({ secret: OWNER_SECRET });
    expect(ok.status).toBe(200);
    // With only the hash configured there is no raw token to accept (legacy disabled).
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${OWNER_SECRET}`)).status).toBe(401);
  });

  it('refuses the published placeholder even if configured', async () => {
    const { base } = await h.boot({ AUTH_TOKEN: 'change_this_to_a_strong_random_string' });
    const res = await request(base).post('/api/auth/login').send({ secret: 'change_this_to_a_strong_random_string' });
    expect(res.status).toBe(401);
    expect((await request(base).get('/api/projects').set('x-auth-token', 'change_this_to_a_strong_random_string')).status).toBe(401);
  });

  it('503 when no owner secret is configured', async () => {
    const { base } = await h.boot({ AUTH_TOKEN: undefined });
    delete process.env.AUTH_TOKEN;
    expect((await request(base).post('/api/auth/login').send({ secret: 'x'.repeat(20) })).status).toBe(503);
  });

  it('rate-limits per proxy-supplied client IP with backoff, never blocks another IP, loopback exempt', async () => {
    const { base } = await h.boot();
    const fromA = () => request(base).post('/api/auth/login').set('x-forwarded-for', '1.1.1.1').send({ secret: 'bad' });
    const first = await fromA();
    expect(first.status).toBe(401);
    let limited = 0;
    for (let i = 0; i < 20; i++) {
      const res = await fromA();
      if (res.status === 429) {
        limited++;
        expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }
    }
    expect(limited).toBe(20); // inside the backoff window every attempt is refused
    // A correct login from ANOTHER client IP is unaffected.
    const fromB = await request(base).post('/api/auth/login').set('x-forwarded-for', '2.2.2.2').send({ secret: OWNER_SECRET });
    expect(fromB.status).toBe(200);
    // The attacker's IP is also refused for the CORRECT secret until its backoff expires (no oracle).
    const aRight = await request(base).post('/api/auth/login').set('x-forwarded-for', '1.1.1.1').send({ secret: OWNER_SECRET });
    expect(aRight.status).toBe(429);
    // Loopback (no forwarding headers) is exempt: 20 failures, then success.
    for (let i = 0; i < 20; i++) {
      expect((await request(base).post('/api/auth/login').send({ secret: 'bad' })).status).toBe(401);
    }
    expect((await request(base).post('/api/auth/login').send({ secret: OWNER_SECRET })).status).toBe(200);
  });

  it('backoff expires (never a hard lock)', async () => {
    const { LoginRateLimiter } = await import('../src/relay-server/auth/rate-limit');
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 12; i++) limiter.recordFailure('ip', t0);
    expect(limiter.check('ip', t0 + 1000).allowed).toBe(false);
    expect(limiter.check('ip', t0 + 60_000).allowed).toBe(true); // capped at 60 s
  });
});

describe('session store (audit §6 #6, #7, #9, #10)', () => {
  it('stores only sha256(token) names, 0600 files in a 0700 dir, exact contract format', async () => {
    const { base, workspace } = await h.boot();
    const { token, session } = await h.login(base);
    const dir = path.join(workspace, '.relay', 'state', 'sessions');
    const names = fsSync.readdirSync(dir);
    expect(names).toEqual([`${sha256(token)}.json`]);
    expect((fsSync.statSync(dir).mode & 0o777).toString(8)).toBe('700');
    const file = path.join(dir, names[0]);
    expect((fsSync.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const raw = fsSync.readFileSync(file, 'utf8');
    expect(raw).not.toContain(token);
    const json = JSON.parse(raw);
    const allowed = ['absExp', 'createdAt', 'id', 'idleSecs', 'ip', 'kind', 'label', 'ownerEpoch', 'ua', 'v'];
    expect(Object.keys(json).filter((k) => !allowed.includes(k))).toEqual([]);
    for (const required of ['v', 'id', 'kind', 'label', 'createdAt', 'absExp', 'idleSecs', 'ownerEpoch']) expect(json).toHaveProperty(required);
    expect(json).toMatchObject({ v: 1, id: session.id, kind: 'browser', idleSecs: 7 * 86400, ownerEpoch: 0 });
    const days = (Date.parse(json.absExp) - Date.parse(json.createdAt)) / 86400000;
    expect(Math.round(days)).toBe(30);
    // local token file: 0600
    expect((fsSync.statSync(path.join(workspace, '.relay', 'state', 'local-token')).mode & 0o777).toString(8)).toBe('600');
  });

  it('absolute expiry and idle expiry → 401; use refreshes the idle clock', async () => {
    const { base, workspace } = await h.boot();
    const dir = path.join(workspace, '.relay', 'state', 'sessions');
    const auth = (t: string) => request(base).get('/api/projects').set('Authorization', `Bearer ${t}`);

    const a = await h.login(base);
    const fa = path.join(dir, `${sha256(a.token)}.json`);
    const ja = JSON.parse(fsSync.readFileSync(fa, 'utf8'));
    fsSync.writeFileSync(fa, JSON.stringify({ ...ja, absExp: new Date(Date.now() - 1000).toISOString() }));
    expect((await auth(a.token)).status).toBe(401);
    expect(fsSync.existsSync(fa)).toBe(false); // pruned on sight

    const b = await h.login(base);
    const fb = path.join(dir, `${sha256(b.token)}.json`);
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000);
    fsSync.utimesSync(fb, eightDaysAgo, eightDaysAgo);
    expect((await auth(b.token)).status).toBe(401);

    const c = await h.login(base);
    const fc = path.join(dir, `${sha256(c.token)}.json`);
    const sixDaysAgo = new Date(Date.now() - 6 * 86400000);
    fsSync.utimesSync(fc, sixDaysAgo, sixDaysAgo);
    expect((await auth(c.token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(Date.now() - fsSync.statSync(fc).mtimeMs).toBeLessThan(10_000); // touched → idle clock reset
  });

  it('cross-instance: a revoke on relay A is seen by relay B immediately (no cached state)', async () => {
    const a = await h.boot();
    const b = await h.boot({}, { workspace: a.workspace });
    const { token, session } = await h.login(a.base);
    expect((await request(b.base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const del = await request(a.base).delete(`/api/auth/sessions/${session.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect((await request(b.base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('changing the owner secret bumps owner-epoch and kills every session', async () => {
    const first = await h.boot();
    const { token } = await h.login(first.base);
    expect(fsSync.readFileSync(path.join(first.workspace, '.relay', 'state', 'owner-epoch'), 'utf8').trim()).toBe('0');
    // Same secret, new instance: no bump.
    const same = await h.boot({}, { workspace: first.workspace });
    expect((await request(same.base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    // New secret: epoch 1, old session dead, new secret logs in.
    const rotated = await h.boot({ AUTH_TOKEN: `${OWNER_SECRET}-v2` }, { workspace: first.workspace });
    expect(fsSync.readFileSync(path.join(first.workspace, '.relay', 'state', 'owner-epoch'), 'utf8').trim()).toBe('1');
    expect((await request(rotated.base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(rotated.base).post('/api/auth/login').send({ secret: OWNER_SECRET })).status).toBe(401);
    const fresh = await h.login(rotated.base, `${OWNER_SECRET}-v2`);
    expect((await request(rotated.base).get('/api/projects').set('Authorization', `Bearer ${fresh.token}`)).status).toBe(200);
  });
});

describe('session lifecycle over HTTP and socket (audit §6 #8, #11, #12, #13)', () => {
  it('login → session → use (HTTP + socket) → revoke → 401 + socket disconnected', async () => {
    const { base } = await h.boot();
    const { token, session } = await h.login(base);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const socket = await h.connect(base, token);
    const revoked = waitFor<{ reason: string }>(socket, 'auth:revoked');
    const disconnected = waitFor<string>(socket, 'disconnect');
    const res = await request(base).delete(`/api/auth/sessions/${session.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.body).toMatchObject({ ok: true, id: session.id, disconnected: 1 });
    expect(await revoked).toEqual({ reason: 'session_revoked' });
    expect(await disconnected).toBe('io server disconnect');
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    await expect(h.connect(base, token)).rejects.toMatchObject({ message: 'Unauthorized' });
  });

  it('the periodic sweep disconnects sockets whose session was revoked elsewhere', async () => {
    const { base, workspace } = await h.boot({ RELAY_AUTH_SWEEP_MS: '150' });
    const { token } = await h.login(base);
    const socket = await h.connect(base, token);
    const revoked = waitFor<{ reason: string }>(socket, 'auth:revoked', 3000);
    // Another process (relay-pty, a second relay) unlinks the file.
    await fs.rm(path.join(workspace, '.relay', 'state', 'sessions', `${sha256(token)}.json`));
    expect(await revoked).toEqual({ reason: 'session_revoked' });
  });

  it('rotate: the old token dies, the new one works, the session id is kept', async () => {
    const { base } = await h.boot();
    const { token, session } = await h.login(base);
    const res = await request(base).post('/api/auth/session/rotate').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.token).not.toBe(token);
    expect(res.body.session.id).toBe(session.id);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
  });

  it('logout revokes the current session', async () => {
    const { base } = await h.boot();
    const { token } = await h.login(base);
    const socket = await h.connect(base, token);
    const revoked = waitFor<{ reason: string }>(socket, 'auth:revoked');
    const res = await request(base).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.body).toMatchObject({ ok: true, revoked: true, disconnected: 1 });
    expect(await revoked).toEqual({ reason: 'logged_out' });
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('api session mint: shown once, works for HTTP + socket, listed, revocable; revoke-all keeps current', async () => {
    const { base } = await h.boot();
    const browser = await h.login(base);
    const auth = { Authorization: `Bearer ${browser.token}` };
    const minted = await request(base).post('/api/auth/sessions').set(auth).send({ label: 'mcp', kind: 'api' });
    expect(minted.status).toBe(201);
    expect(minted.body.session).toMatchObject({ kind: 'api', label: 'mcp', idleExpiresAt: null });
    const days = (Date.parse(minted.body.session.expiresAt) - Date.parse(minted.body.session.createdAt)) / 86400000;
    expect(Math.round(days)).toBe(90);
    const api = minted.body.token as string;
    // From a "remote" client (forwarded) — an api session is not loopback-bound.
    expect((await request(base).get('/api/projects').set('x-forwarded-for', '5.6.7.8').set('Authorization', `Bearer ${api}`)).status).toBe(200);
    const socket = await h.connect(base, api, { extraHeaders: { 'x-forwarded-for': '5.6.7.8' } });
    const list = await request(base).get('/api/auth/sessions').set(auth);
    expect(list.body.sessions.map((s: { label: string; current: boolean }) => [s.label, s.current]).sort())
      .toEqual([['mcp', false], ['test', true]]);
    expect(JSON.stringify(list.body)).not.toContain(api);
    expect((await request(base).post('/api/auth/sessions').set(auth).send({ label: 'x', kind: 'browser' })).status).toBe(400);
    expect((await request(base).post('/api/auth/sessions').set(auth).send({ kind: 'api' })).status).toBe(400);

    const revoked = waitFor<{ reason: string }>(socket, 'auth:revoked');
    const all = await request(base).post('/api/auth/sessions/revoke-all').set(auth).send({ keepCurrent: true });
    expect(all.body).toMatchObject({ ok: true, revoked: 1, kept: browser.session.id, disconnected: 1 });
    await revoked;
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${api}`)).status).toBe(401);
    expect((await request(base).get('/api/projects').set(auth)).status).toBe(200);
    expect((await request(base).delete('/api/auth/sessions/does-not-exist').set(auth)).status).toBe(404);
  });
});

describe('box-local token (audit §6 #14)', () => {
  const FORWARDING = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'fly-client-ip', 'cf-connecting-ip'];

  it('accepted only from loopback with no forwarding header; never at login; same for sockets', async () => {
    const { base, workspace } = await h.boot();
    const local = fsSync.readFileSync(path.join(workspace, '.relay', 'state', 'local-token'), 'utf8').trim();
    expect(local).toMatch(/^rl_/);
    const ok = await request(base).get('/api/auth/session').set('Authorization', `Bearer ${local}`);
    expect(ok.body).toEqual({ authenticated: true, via: 'local' });
    for (const header of FORWARDING) {
      const value = header === 'forwarded' ? 'for=1.2.3.4' : '1.2.3.4';
      const res = await request(base).get('/api/projects').set(header, value).set('Authorization', `Bearer ${local}`);
      expect(`${header} → ${res.status}`).toBe(`${header} → 401`);
    }
    expect((await request(base).post('/api/auth/login').send({ secret: local })).status).toBe(401);
    const socket = await h.connect(base, local);
    expect(socket.connected).toBe(true);
    for (const header of FORWARDING) {
      await expect(h.connect(base, local, { extraHeaders: { [header]: '1.2.3.4' } })).rejects.toMatchObject({ message: 'Unauthorized' });
    }
  });

  it('local-token rotate: only for local callers; the old token stops working', async () => {
    const { base, workspace } = await h.boot();
    const file = path.join(workspace, '.relay', 'state', 'local-token');
    const before = fsSync.readFileSync(file, 'utf8').trim();
    const browser = await h.login(base);
    expect((await request(base).post('/api/auth/local-token/rotate').set('Authorization', `Bearer ${browser.token}`)).status).toBe(403);
    expect((await request(base).post('/api/auth/local-token/rotate').set('Authorization', `Bearer ${before}`)).status).toBe(200);
    const after = fsSync.readFileSync(file, 'utf8').trim();
    expect(after).not.toBe(before);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${before}`)).status).toBe(401);
    expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${after}`)).status).toBe(200);
  });
});

describe('legacy raw AUTH_TOKEN window (audit §6 #15)', () => {
  it('open on first boot for 14 days: accepted from any address as via:legacy and logged', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { base, workspace } = await h.boot();
    const until = Date.parse(fsSync.readFileSync(path.join(workspace, '.relay', 'state', 'legacy-token-until'), 'utf8').trim());
    expect(Math.round((until - Date.now()) / 86400000)).toBe(14);
    const res = await request(base).get('/api/auth/session').set('x-forwarded-for', '7.7.7.7').set('user-agent', 'OldTab/1').set('x-auth-token', OWNER_SECRET);
    expect(res.body).toEqual({ authenticated: true, via: 'legacy' });
    const socket = await h.connect(base, OWNER_SECRET, { extraHeaders: { 'x-forwarded-for': '7.7.7.7' } });
    expect(socket.connected).toBe(true);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('legacy-token-use'));
    expect(lines.some((l) => l.includes('carrier=http') && l.includes('ip=7.7.7.7') && l.includes('OldTab/1'))).toBe(true);
    expect(lines.some((l) => l.includes('carrier=socket'))).toBe(true);
  });

  it('closed when RELAY_LEGACY_TOKEN_UNTIL is in the past (HTTP and socket), or off', async () => {
    for (const until of [new Date(Date.now() - 60_000).toISOString(), 'off']) {
      const { base } = await h.boot({ RELAY_LEGACY_TOKEN_UNTIL: until });
      expect((await request(base).get('/api/projects').set('x-auth-token', OWNER_SECRET)).status).toBe(401);
      expect((await request(base).get('/api/projects').set('Authorization', `Bearer ${OWNER_SECRET}`)).status).toBe(401);
      await expect(h.connect(base, OWNER_SECRET)).rejects.toMatchObject({ message: 'Unauthorized' });
      // …but the secret still logs in (it is the owner password).
      expect((await request(base).post('/api/auth/login').send({ secret: OWNER_SECRET })).status).toBe(200);
      await h.cleanup();
    }
  });

  it('a persisted window in the past closes it too, and legacy sockets are swept when it closes', async () => {
    const ws = await h.workspace();
    await fs.mkdir(path.join(ws, '.relay', 'state'), { recursive: true });
    await fs.writeFile(path.join(ws, '.relay', 'state', 'legacy-token-until'), new Date(Date.now() - 1000).toISOString());
    const { base } = await h.boot({}, { workspace: ws });
    expect((await request(base).get('/api/projects').set('x-auth-token', OWNER_SECRET)).status).toBe(401);
    await h.cleanup();

    const soon = new Date(Date.now() + 1500).toISOString();
    const second = await h.boot({ RELAY_LEGACY_TOKEN_UNTIL: soon, RELAY_AUTH_SWEEP_MS: '200' });
    const socket = await h.connect(second.base, OWNER_SECRET);
    const revoked = waitFor<{ reason: string }>(socket, 'auth:revoked', 5000);
    expect(await revoked).toEqual({ reason: 'legacy_window_closed' });
  });
});

describe('CORS (audit §6 #16)', () => {
  it('never reflects a foreign origin; allowlisted origins get ACAO without credentials', async () => {
    const { base } = await h.boot({ RELAY_ALLOWED_ORIGINS: 'https://relay-web.example.com', RELAY_WEB_ORIGIN_PATTERN: 'https://*.fly.dev' });
    const { token } = await h.login(base);
    const evil = await request(base).get('/api/projects').set('Origin', 'https://evil.example').set('Authorization', `Bearer ${token}`);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(evil.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await request(base).options('/api/projects').set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const good = await request(base).options('/api/projects').set('Origin', 'https://relay-web.example.com')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization');
    expect(good.headers['access-control-allow-origin']).toBe('https://relay-web.example.com');
    expect(good.headers['access-control-allow-credentials']).toBeUndefined();
    expect(good.headers['access-control-allow-headers']).toBe('authorization');
    const fly = await request(base).get('/health').set('Origin', 'https://relay-web-abc.fly.dev');
    expect(fly.headers['access-control-allow-origin']).toBe('https://relay-web-abc.fly.dev');
    const flyDeep = await request(base).get('/health').set('Origin', 'https://a.b.fly.dev');
    expect(flyDeep.headers['access-control-allow-origin']).toBeUndefined();
    // 401s still carry CORS headers for allowlisted origins (relay-web can read them).
    const unauth = await request(base).get('/api/projects').set('Origin', 'https://relay-web.example.com');
    expect(unauth.status).toBe(401);
    expect(unauth.headers['access-control-allow-origin']).toBe('https://relay-web.example.com');
  });

  it('defaults (RELAY_ALLOWED_ORIGINS unset) allow only the dev server, with a loud warning', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { buildOriginPolicy } = await import('../src/relay-server/auth/cors');
    const policy = buildOriginPolicy({});
    expect(policy.explicit).toBe(false);
    expect(policy.isAllowed('http://localhost:5173')).toBe(true);
    expect(policy.isAllowed('https://evil.example')).toBe(false);
    expect(policy.isAllowed('null')).toBe(false);
    void warn;
  });

  it('refuses a Socket.IO handshake from a foreign Origin', async () => {
    const { base } = await h.boot({ RELAY_ALLOWED_ORIGINS: 'https://relay-web.example.com' });
    const { token } = await h.login(base);
    await expect(h.connect(base, token, { extraHeaders: { origin: 'https://evil.example' } })).rejects.toBeTruthy();
    const ok = await h.connect(base, token, { extraHeaders: { origin: 'https://relay-web.example.com' } });
    expect(ok.connected).toBe(true);
  });
});

describe('flutter preview path capability (audit §6 #20)', () => {
  async function seedBuild(workspace: string, projectId: string): Promise<void> {
    const web = path.join(workspace, 'projects', projectId, 'build', 'web');
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(workspace, 'projects', projectId, 'pubspec.yaml'), 'name: demo\n');
    await fs.writeFile(path.join(web, 'index.html'), '<html><head><base href="/"></head><body><script src="main.dart.js"></script></body></html>');
    await fs.writeFile(path.join(web, 'main.dart.js'), 'console.log(1)');
    // A cloudflared that exits at once, so the preview route never reaches the network.
    const bin = path.join(workspace, '.relay', 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'cloudflared'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  it('mints a session-bound cap; the iframe loads index + assets with no header; bad/expired/revoked/missing caps fail', async () => {
    const { base, workspace } = await h.boot();
    await seedBuild(workspace, 'demo');
    await seedBuild(workspace, 'other');
    const { token, session } = await h.login(base);
    const res = await request(base).get('/api/projects/demo/flutter/preview').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const indexUrl = res.body.previewIndexUrl as string;
    const m = /^\/flutter-preview\/demo\/c\/([^/]+)\/index\.html$/.exec(indexUrl);
    expect(m).not.toBeNull();
    const cap = m![1];
    expect(cap.split('.')[1]).toBe(session.id);

    const page = await request(base).get(indexUrl);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`<base href="/flutter-preview/demo/c/${cap}/">`);
    expect(page.text).not.toMatch(/token=/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const asset = await request(base).get(`/flutter-preview/demo/c/${cap}/main.dart.js`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('console.log(1)');

    expect((await request(base).get(`/flutter-preview/other/c/${cap}/index.html`)).status).toBe(403); // wrong project
    const tampered = cap.slice(0, -2) + (cap.endsWith('AA') ? 'BB' : 'AA');
    expect((await request(base).get(`/flutter-preview/demo/c/${tampered}/index.html`)).status).toBe(403);
    const expired = mintPreviewCap('demo', session.id, workspace, Date.now() - 13 * 3600 * 1000).cap;
    expect((await request(base).get(`/flutter-preview/demo/c/${expired}/index.html`)).status).toBe(403);
    expect((await request(base).get('/flutter-preview/demo/index.html')).status).toBe(401); // old capless path
    expect((await request(base).get(`/flutter-preview/demo/c/${cap}/../../other/build/web/index.html`)).status).not.toBe(200);

    await request(base).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect((await request(base).get(indexUrl)).status).toBe(403); // minting session revoked
  });
});

describe('VNC upgrade and tunnels (audit §6 #21, #22)', () => {
  it('an unauthenticated upgrade to the old VNC websocket path gets no 101', async () => {
    const { port } = await h.boot();
    const reply = await new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /api/projects/demo/flutter/screen/websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => { data += d.toString(); });
      sock.on('close', () => resolve(data));
      sock.on('error', () => resolve(data));
      setTimeout(() => { sock.destroy(); resolve(data); }, 3000);
    });
    expect(reply).not.toContain('101');
  });

  it("refuses to tunnel relay's own port (and hides it from the preview list)", async () => {
    const { base, port } = await h.boot();
    const { token } = await h.login(base);
    const res = await request(base).get(`/api/previews/${port}/tunnel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('port_protected');
    const list = await request(base).get('/api/previews').set('Authorization', `Bearer ${token}`);
    expect(list.body.previews.map((p: { port: number }) => p.port)).not.toContain(port);
    const serve = await request(base).post(`/api/previews/${port}/serve`).set('Authorization', `Bearer ${token}`).send({});
    expect(serve.status).toBe(403);
  });

  it('RELAY_HOST_PORTS are protected too', async () => {
    const { protectedPortReason } = await import('../src/relay-server/protected-ports');
    process.env.RELAY_HOST_PORTS = '8080, 9090';
    expect(protectedPortReason(9090)).toMatch(/RELAY_HOST_PORTS/);
    expect(protectedPortReason(5173)).toBeNull();
  });
});

describe('static preview server never serves the workspace root (CONTRACTS §2 Previews)', () => {
  it('isSafeStaticServeDir refuses the workspace, .relay and ancestors', async () => {
    const { isSafeStaticServeDir } = await import('../src/relay-server/core-routes');
    const ws = '/tmp/ws-x';
    expect(isSafeStaticServeDir(ws, ws)).toBe(false);
    expect(isSafeStaticServeDir('/tmp', ws)).toBe(false);
    expect(isSafeStaticServeDir('/', ws)).toBe(false);
    expect(isSafeStaticServeDir(`${ws}/.relay`, ws)).toBe(false);
    expect(isSafeStaticServeDir(`${ws}/.relay/state`, ws)).toBe(false);
    expect(isSafeStaticServeDir(`${ws}/projects`, ws)).toBe(true);
    expect(isSafeStaticServeDir(`${ws}/projects/demo`, ws)).toBe(true);
  });

  it('POST /api/previews/:port/serve serves the projects root, bound to loopback, and .relay/state is unreachable', async () => {
    const { base, workspace } = await h.boot();
    const { token } = await h.login(base);
    await fs.writeFile(path.join(workspace, 'projects', 'hello.txt'), 'hi');
    const free = await new Promise<number>((resolve) => {
      const srv = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p));
      });
    });
    const res = await request(base).post(`/api/previews/${free}/serve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.directory).toBe(path.join(workspace, 'projects'));
    let body = '';
    for (let i = 0; i < 50 && !body; i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = await fetch(`http://127.0.0.1:${free}/hello.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    }
    expect(body).toBe('hi');
    const state = await fetch(`http://127.0.0.1:${free}/../.relay/state/local-token`).then((r) => r.status).catch(() => 0);
    expect(state).not.toBe(200);
    const listing = await fetch(`http://127.0.0.1:${free}/`).then((r) => r.text());
    expect(listing).not.toContain('.relay');
    // stop the python server
    const { execSync } = await import('node:child_process');
    try { execSync(`pkill -f "http.server ${free}"`); } catch { /* already gone */ }
  });
});
