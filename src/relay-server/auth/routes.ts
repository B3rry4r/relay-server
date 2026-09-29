/*
 * /api/auth/* endpoints (CONTRACTS §2).
 *
 *   POST   /api/auth/login                  {secret, label?} → {token, session}     PUBLIC, rate-limited
 *   POST   /api/auth/login-link/exchange    {code, label?}   → {token, session}     PUBLIC, NOT rate-limited
 *                                            (break-glass: 192-bit one-time codes; must work while
 *                                            the password path is backed off — audit §4.6)
 *   GET    /api/auth/session                → {authenticated, via, session?}
 *   GET    /api/auth/validate               (deprecated alias of /api/auth/session)
 *   POST   /api/auth/logout                 revoke the current session
 *   GET    /api/auth/sessions               list
 *   POST   /api/auth/sessions               {label, kind:'api', ttlDays?} → {token, session} (shown once)
 *   DELETE /api/auth/sessions/:id           revoke + disconnect its sockets
 *   POST   /api/auth/sessions/revoke-all    {keepCurrent?}
 *   POST   /api/auth/session/rotate         → {token, session} (old token dies)
 *   POST   /api/auth/login-link             {webUrl?, serverUrl?} → one-time break-glass code + URL
 *   POST   /api/auth/local-token/rotate     box-local callers only
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import { resolveWorkspace } from '../runtime';
import { clientIp, isLocalRequest, type AuthRuntime } from './index';
import { rotateLocalToken } from './local-token';
import {
  buildLoginLinkUrl,
  consumeLoginLinkCode,
  inferRelayPublicUrl,
  LOGIN_LINK_TTL_MS,
  mintLoginLinkCode,
} from './login-links';
import { readOwnerSecretConfig, verifyOwnerSecret } from './owner-secret';
import { hasForwardingHeaders } from './state';
import {
  createSession,
  listSessions,
  revokeAllSessions,
  revokeSessionByHash,
  revokeSessionById,
  rotateSession,
  toPublicSession,
} from './session-store';

let warnedPlainLogin = false;
let lastRefusedExchangeLog = 0;
let refusedExchanges = 0;

function deviceLabel(req: Request, fallback: string): string {
  const explicit = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  if (explicit) return explicit.slice(0, 120);
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ') || fallback;
}

let warnedSharedProxyKey = false;
/**
 * Behind a proxy that is not trusted (not on loopback, RELAY_TRUST_PROXY unset),
 * req.ip is the proxy's own address, so every remote client shares ONE backoff key
 * and an attacker's failures delay the owner's password login too (the login-link
 * exchange is unaffected). Say so once, loudly.
 */
function warnIfSharedProxyKey(req: Request, key: string): void {
  if (warnedSharedProxyKey) return;
  const peer = req.socket?.remoteAddress || '';
  if (!peer || key !== peer || !hasForwardingHeaders(req.headers)) return;
  warnedSharedProxyKey = true;
  console.warn(`[auth] login backoff is keyed on the proxy address ${peer} (its X-Forwarded-For is not trusted), so all remote clients share one key. Set RELAY_TRUST_PROXY (e.g. "1" or the proxy's address) so each client gets its own.`);
}

function rateLimited(runtime: AuthRuntime, req: Request, res: Response): string | null {
  if (isLocalRequest(req)) return null;
  const key = clientIp(req) || 'unknown';
  warnIfSharedProxyKey(req, key);
  const decision = runtime.limiter.check(key);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSec));
    res.status(429).json({
      error: 'rate_limited',
      message: `Too many failed attempts. Try again in ${decision.retryAfterSec}s.`,
      retryAfterSec: decision.retryAfterSec,
    });
    return '';
  }
  return key;
}

function issueBrowserSession(req: Request, res: Response, fallbackLabel: string): void {
  const { token, record } = createSession({
    kind: 'browser',
    label: deviceLabel(req, fallbackLabel),
    ua: String(req.headers['user-agent'] || ''),
    ip: clientIp(req),
  });
  res.json({ token, session: toPublicSession(record, record.id) });
}

export function registerAuthRoutes(app: Express, runtime: AuthRuntime): void {
  const smallJson = express.json({ limit: '16kb' });

  app.post('/api/auth/login', smallJson, (req, res) => {
    const key = rateLimited(runtime, req, res);
    if (key === '') return;
    const config = readOwnerSecretConfig();
    if (config.kind === 'none') {
      res.status(503).json({ error: 'login_disabled', message: 'No owner secret is configured on this relay (AUTH_TOKEN_HASH / AUTH_TOKEN).' });
      return;
    }
    const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
    if (!verifyOwnerSecret(secret, config)) {
      const delay = key ? runtime.limiter.recordFailure(key) : 0;
      console.warn(`[auth] login-failed ip=${clientIp(req) || '-'} ua=${JSON.stringify(String(req.headers['user-agent'] || '-'))}${delay ? ` backoff=${delay}ms` : ''}`);
      res.status(401).json({ error: 'invalid_credentials', message: 'Wrong owner password.' });
      return;
    }
    if (key) runtime.limiter.recordSuccess(key);
    if (config.kind === 'plain' && !warnedPlainLogin) {
      warnedPlainLogin = true;
      console.warn('[auth] login used the plaintext AUTH_TOKEN; set AUTH_TOKEN_HASH instead (relay-auth hash-secret).');
    }
    issueBrowserSession(req, res, 'Browser');
  });

  // Break-glass: deliberately NOT behind the login limiter, and a bad code never
  // feeds it. The codes are 192-bit, one-time and short-lived (nothing to guess),
  // and this path must keep working while password login is backed off.
  app.post('/api/auth/login-link/exchange', smallJson, (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!consumeLoginLinkCode(code)) {
      const now = Date.now();
      refusedExchanges++;
      if (now - lastRefusedExchangeLog >= 10_000) { // log, but never let a flood flood the log
        console.warn(`[auth] login-link exchange refused ip=${clientIp(req) || '-'} (refused since last log: ${refusedExchanges})`);
        lastRefusedExchangeLog = now;
        refusedExchanges = 0;
      }
      res.status(401).json({ error: 'invalid_code', message: 'This sign-in link is invalid, expired, or was already used.' });
      return;
    }
    console.warn(`[auth] login-link exchanged ip=${clientIp(req) || '-'}`);
    issueBrowserSession(req, res, 'Login link');
  });

  const describe = (req: Request, res: Response): void => {
    const auth = req.auth;
    if (!auth || auth.via === 'preview-cap') {
      res.status(401).json({ error: 'unauthorized', message: 'A valid session token is required.' });
      return;
    }
    res.json({
      authenticated: true,
      via: auth.via,
      ...(auth.via === 'session' ? { session: toPublicSession(auth.session, auth.session.id) } : {}),
    });
  };
  app.get('/api/auth/session', describe);
  app.get('/api/auth/validate', (req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/auth/session>; rel="successor-version"');
    describe(req, res);
  });

  app.post('/api/auth/logout', async (req, res) => {
    const auth = req.auth;
    if (auth?.via !== 'session') {
      res.json({ ok: true, revoked: false, via: auth?.via ?? null });
      return;
    }
    await revokeSessionByHash(auth.session.hash);
    const disconnected = runtime.disconnectSession(auth.session.id, 'logged_out');
    res.json({ ok: true, revoked: true, disconnected });
  });

  app.get('/api/auth/sessions', async (req, res) => {
    const currentId = req.auth?.via === 'session' ? req.auth.session.id : '';
    const sessions = await listSessions();
    res.json({ sessions: sessions.map((s) => toPublicSession(s, currentId)) });
  });

  app.post('/api/auth/sessions', async (req, res) => {
    const kind = req.body?.kind ?? 'api';
    if (kind !== 'api') {
      res.status(400).json({ error: 'invalid_kind', message: "Only kind:'api' sessions can be minted; browser sessions come from /api/auth/login." });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) {
      res.status(400).json({ error: 'label_required', message: 'A label is required (e.g. "mcp", "uix").' });
      return;
    }
    const ttlDays = Number(req.body?.ttlDays);
    const { token, record } = createSession({
      kind: 'api',
      label,
      ttlDays: Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : undefined,
      ua: String(req.headers['user-agent'] || ''),
      ip: clientIp(req),
    });
    console.warn(`[auth] api session minted id=${record.id} label=${JSON.stringify(record.label)} by=${req.auth?.via}`);
    res.status(201).json({ token, session: toPublicSession(record) });
  });

  app.delete('/api/auth/sessions/:id', async (req, res) => {
    const id = String(req.params.id || '');
    const revoked = await revokeSessionById(id);
    if (!revoked) {
      res.status(404).json({ error: 'session_not_found', message: 'No such session.' });
      return;
    }
    const disconnected = runtime.disconnectSession(id, 'session_revoked');
    res.json({ ok: true, id, disconnected });
  });

  app.post('/api/auth/sessions/revoke-all', async (req, res) => {
    const keepCurrent = req.body?.keepCurrent === true;
    const keepId = keepCurrent && req.auth?.via === 'session' ? req.auth.session.id : null;
    const revoked = await revokeAllSessions(keepId);
    let disconnected = 0;
    for (const id of revoked) disconnected += runtime.disconnectSession(id, 'session_revoked');
    res.json({ ok: true, revoked: revoked.length, kept: keepId, disconnected });
  });

  app.post('/api/auth/session/rotate', async (req, res) => {
    const auth = req.auth;
    if (auth?.via !== 'session') {
      res.status(400).json({ error: 'not_a_session', message: 'Only a session token can be rotated.' });
      return;
    }
    const { token, record } = await rotateSession(auth.session);
    res.json({ token, session: toPublicSession(record, record.id) });
  });

  app.post('/api/auth/login-link', (req, res) => {
    const by = req.auth?.via === 'session' ? `session:${req.auth.session.id}` : String(req.auth?.via);
    const { code, expiresAt } = mintLoginLinkCode({ createdBy: by });
    const bodyWeb = typeof req.body?.webUrl === 'string' ? req.body.webUrl.trim() : '';
    const bodyServer = typeof req.body?.serverUrl === 'string' ? req.body.serverUrl.trim() : '';
    const webUrl = bodyWeb || (process.env.RELAY_WEB_URL || '').trim()
      || (runtime.originPolicy.explicit ? runtime.originPolicy.origins.find((o) => o.startsWith('https://')) ?? '' : '')
      || null;
    const serverUrl = bodyServer || inferRelayPublicUrl();
    console.warn(`[auth] login-link minted by=${by} expires=${expiresAt}`);
    res.json({
      code,
      expiresAt,
      ttlSeconds: Math.round(LOGIN_LINK_TTL_MS / 1000),
      webUrl,
      serverUrl,
      url: buildLoginLinkUrl(webUrl, serverUrl, code),
      exchange: { method: 'POST', path: '/api/auth/login-link/exchange', body: { code: '<code>', label: '<optional device name>' } },
    });
  });

  app.post('/api/auth/local-token/rotate', (req, res) => {
    if (req.auth?.via !== 'local' || !isLocalRequest(req)) {
      res.status(403).json({ error: 'local_only', message: 'Only box-local callers holding the current local token can rotate it.' });
      return;
    }
    rotateLocalToken(resolveWorkspace());
    res.json({ ok: true, message: 'Local token rotated; read the new value from the local-token file.' });
  });
}
