/*
 * relay-server authentication (CONTRACTS §2, auth-audit §4).
 *
 *  - `authenticate`: DEFAULT-DENY Express middleware installed in
 *    createRelayServer BEFORE every route. Only the public allowlist passes
 *    without a credential. Carriers: `Authorization: Bearer <t>` and
 *    `x-auth-token: <t>`. NO query-string auth, NO cookie auth (the legacy
 *    `relay_auth_token` cookie is cleared on sight and never read).
 *  - credential order: session token → box-local token (loopback peer AND no
 *    forwarding headers) → raw AUTH_TOKEN during the legacy window.
 *  - `socketAuth`: the same rules for the Socket.IO handshake (`auth.token`);
 *    records `socket.data.auth` and indexes sockets by session id so a revoke
 *    disconnects them, plus a periodic sweep for expiry and cross-instance revokes.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { resolveWorkspace } from '../runtime';
import { buildOriginPolicy, type OriginPolicy } from './cors';
import { isLegacyWindowOpen, logLegacyUse, matchesLegacyToken, resolveLegacyWindow } from './legacy';
import { ensureLocalToken, matchesLocalToken } from './local-token';
import { reconcileOwnerEpoch } from './owner-secret';
import { forgetPreviewCapCache, verifyPreviewCap } from './preview-cap';
import { LoginRateLimiter } from './rate-limit';
import {
  listSessions,
  validateSessionToken,
  type SessionRecord,
} from './session-store';
import { authStatePaths, isLocalPeer } from './state';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type AuthContext =
  | { via: 'session'; session: SessionRecord }
  | { via: 'local' }
  | { via: 'legacy' }
  | { via: 'preview-cap'; projectId: string; binding: string };

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export const LEGACY_COOKIE = 'relay_auth_token';

/** Pull the credential from the two supported headers. Never the query string. */
export function extractCredential(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers.authorization;
  const auth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const x = headers['x-auth-token'];
  const xv = Array.isArray(x) ? x[0] : x;
  return typeof xv === 'string' ? xv.trim() : '';
}

export function isLocalRequest(req: Request): boolean {
  return isLocalPeer(req.socket?.remoteAddress, req.headers);
}

export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '';
}

/** Resolve a presented credential to an auth context (or null). */
export async function resolveCredential(
  token: string,
  opts: { local: boolean; ip: string; ua: string; carrier: 'http' | 'socket'; path?: string },
): Promise<AuthContext | null> {
  if (!token) return null;
  const workspace = resolveWorkspace();
  const session = await validateSessionToken(token, workspace);
  if (session) return { via: 'session', session };
  if (opts.local && matchesLocalToken(token, workspace)) return { via: 'local' };
  if (matchesLegacyToken(token, workspace)) {
    logLegacyUse({ ip: opts.ip, ua: opts.ua, carrier: opts.carrier, path: opts.path });
    return { via: 'legacy' };
  }
  return null;
}

const PUBLIC_EXACT: Record<string, Set<string>> = {
  GET: new Set(['/', '/health', '/api/version']),
  HEAD: new Set(['/', '/health', '/api/version']),
  POST: new Set(['/api/auth/login', '/api/auth/login-link/exchange']),
};
const PREVIEW_CAP_PATH = /^\/flutter-preview\/([^/]+)\/c\/([^/]+)(?:\/.*)?$/;

export function isPublicRoute(method: string, pathname: string): boolean {
  if (method === 'OPTIONS') return true;
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return PUBLIC_EXACT[method]?.has(normalized) ?? false;
}

function unauthorized(res: Response, message = 'A valid session token is required.'): void {
  res.status(401).json({ error: 'unauthorized', message });
}

/** Clear the legacy raw-secret cookie wherever a browser still sends it. */
export function clearLegacyCookie(req: Request, res: Response, next: NextFunction): void {
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string' && cookie.split(';').some((part) => part.trim().startsWith(`${LEGACY_COOKIE}=`))) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.append('Set-Cookie', `${LEGACY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }
  next();
}

export type AuthRuntime = {
  originPolicy: OriginPolicy;
  limiter: LoginRateLimiter;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
  installSocketAuth: (io: SocketIOServer) => void;
  /** Disconnect every socket authenticated by this session id. */
  disconnectSession: (sessionId: string, reason: string) => number;
  sweepSockets: () => Promise<void>;
  dispose: () => void;
};

export function createAuthRuntime(): AuthRuntime {
  const workspace = resolveWorkspace();
  // Boot-time state: local token, legacy window file, owner-epoch reconciliation.
  try {
    ensureLocalToken(workspace);
  } catch (error) {
    console.error('[auth] could not create the local token:', error instanceof Error ? error.message : error);
  }
  try {
    const { epoch, bumped } = reconcileOwnerEpoch(workspace);
    if (bumped) console.warn(`[auth] owner secret changed — owner epoch is now ${epoch}; every existing session is invalid.`);
  } catch (error) {
    console.error('[auth] owner-epoch reconciliation failed:', error instanceof Error ? error.message : error);
  }
  const legacy = resolveLegacyWindow(workspace);
  if (legacy.until && Date.now() < legacy.until.getTime()) {
    console.warn(`[auth] legacy raw-AUTH_TOKEN auth is OPEN until ${legacy.until.toISOString()} (${legacy.source}).`);
  }

  const originPolicy = buildOriginPolicy();
  const limiter = new LoginRateLimiter();
  const socketsBySession = new Map<string, Set<Socket>>();
  const legacySockets = new Set<Socket>();

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (isPublicRoute(method, req.path)) { next(); return; }

    const preview = (method === 'GET' || method === 'HEAD') ? PREVIEW_CAP_PATH.exec(req.path) : null;
    if (preview) {
      let projectId: string;
      let cap: string;
      try {
        projectId = decodeURIComponent(preview[1]);
        cap = decodeURIComponent(preview[2]);
      } catch {
        res.status(400).send('Bad request');
        return;
      }
      verifyPreviewCap(projectId, cap).then((check) => {
        if (!check.ok) {
          res.status(403).type('text/plain').send(`Preview link ${check.reason === 'expired' ? 'expired' : 'is not valid'} — reopen the preview.`);
          return;
        }
        req.auth = { via: 'preview-cap', projectId, binding: check.binding };
        next();
      }).catch(next);
      return;
    }

    const token = extractCredential(req.headers);
    if (!token) { unauthorized(res); return; }
    resolveCredential(token, {
      local: isLocalRequest(req),
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || ''),
      carrier: 'http',
      path: req.path,
    }).then((ctx) => {
      if (!ctx) { unauthorized(res); return; }
      req.auth = ctx;
      next();
    }).catch(next);
  };

  const track = (socket: Socket, ctx: AuthContext): void => {
    if (ctx.via === 'session') {
      const id = ctx.session.id;
      const set = socketsBySession.get(id) ?? new Set<Socket>();
      set.add(socket);
      socketsBySession.set(id, set);
      socket.on('disconnect', () => {
        set.delete(socket);
        if (set.size === 0 && socketsBySession.get(id) === set) socketsBySession.delete(id);
      });
    } else if (ctx.via === 'legacy') {
      legacySockets.add(socket);
      socket.on('disconnect', () => legacySockets.delete(socket));
    }
  };

  const kick = (socket: Socket, reason: string): void => {
    try { socket.emit('auth:revoked', { reason }); } catch { /* closing anyway */ }
    socket.disconnect(true);
  };

  const disconnectSession = (sessionId: string, reason: string): number => {
    forgetPreviewCapCache();
    const set = socketsBySession.get(sessionId);
    if (!set) return 0;
    const sockets = Array.from(set);
    socketsBySession.delete(sessionId);
    for (const socket of sockets) kick(socket, reason);
    return sockets.length;
  };

  const sweepSockets = async (): Promise<void> => {
    if (socketsBySession.size > 0) {
      const live = new Map((await listSessions()).map((s) => [s.id, s] as const));
      const now = new Date();
      for (const id of Array.from(socketsBySession.keys())) {
        const record = live.get(id);
        if (!record) {
          disconnectSession(id, 'session_revoked');
          continue;
        }
        // A connected socket IS use: keep the idle clock fresh (≤ once per minute).
        if (now.getTime() - Date.parse(record.lastUsedAt) >= 60_000) {
          await fsp.utimes(path.join(authStatePaths().sessionsDir, `${record.hash}.json`), now, now).catch(() => undefined);
        }
      }
    }
    if (legacySockets.size > 0 && !isLegacyWindowOpen()) {
      for (const socket of Array.from(legacySockets)) kick(socket, 'legacy_window_closed');
      legacySockets.clear();
    }
  };

  const sweepMs = Number(process.env.RELAY_AUTH_SWEEP_MS) > 0 ? Number(process.env.RELAY_AUTH_SWEEP_MS) : 60_000;
  const sweepTimer = setInterval(() => { void sweepSockets().catch(() => undefined); }, sweepMs);
  sweepTimer.unref?.();

  const installSocketAuth = (server: SocketIOServer): void => {
    server.use((socket, next) => {
      const raw = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
      const token = typeof raw === 'string' ? raw.trim() : '';
      const fail = (): void => {
        const error = new Error('Unauthorized') as Error & { data?: unknown };
        error.data = { reason: 'unauthorized' };
        next(error);
      };
      if (!token) { fail(); return; }
      const peer = socket.request?.socket?.remoteAddress;
      resolveCredential(token, {
        local: isLocalPeer(peer, socket.handshake.headers),
        ip: socket.handshake.address || peer || '',
        ua: String(socket.handshake.headers['user-agent'] || ''),
        carrier: 'socket',
      }).then((ctx) => {
        if (!ctx || ctx.via === 'preview-cap') { fail(); return; }
        socket.data.auth = ctx.via === 'session'
          ? { via: 'session', sessionId: ctx.session.id }
          : { via: ctx.via };
        socket.data.sessionId = ctx.via === 'session' ? ctx.session.id : null;
        track(socket, ctx);
        next();
      }).catch(() => fail());
    });
  };

  return {
    originPolicy,
    limiter,
    authenticate,
    installSocketAuth,
    disconnectSession,
    sweepSockets,
    dispose() {
      clearInterval(sweepTimer);
      socketsBySession.clear();
      legacySockets.clear();
    },
  };
}

/** Binding a preview capability minted for this caller is tied to. */
export function previewBindingFor(auth: AuthContext | undefined): string | null {
  if (!auth) return null;
  if (auth.via === 'session') return auth.session.id;
  if (auth.via === 'local') return 'local';
  if (auth.via === 'legacy') return 'legacy';
  return null;
}
