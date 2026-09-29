/*
 * Everything relay-server does with UIX (CONTRACTS §2 "UIX").
 *
 * UIX requires `x-uix-service-token: <UIX_SERVICE_TOKEN>` on everything except
 * GET /health. Three paths reach it:
 *
 *  1. relay-server's own server-side calls (reference-render.ts, …) → `uixFetch`,
 *     which attaches the service token to requests for the UIX origin only.
 *  2. The browser (relay-web) → `ALL /api/uix/*` on relay, session-authenticated
 *     by the default-deny middleware, streamed to `${UIX_URL}/*` with the relay
 *     credential headers removed and the service token added.
 *  3. The headless render harness (a page in Chrome, which must never see the
 *     token) → a LOOPBACK-ONLY proxy (`getHarnessUixBase()`) that adds the token.
 *     It refuses non-loopback peers and anything carrying a forwarding header, its
 *     port is protected from tunnelling, and it rewrites the UIX origin inside JSON
 *     bodies so absolute asset/font URLs route through it too. It is deliberately
 *     narrow, because it holds the service token and needs no credential:
 *       - every URL must start with a per-boot random capability path
 *         (`/h/<192-bit cap>/`), known only to the harness page relay loads (so
 *         other on-box processes and other pages in the same Chrome, e.g. a
 *         built app rendered by /api/visual/web-screenshot, cannot use it);
 *       - read-only: GET/HEAD (+ OPTIONS preflight) only;
 *       - only the UIX paths the harness reads (HARNESS_UIX_PATHS).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import httpProxy from 'http-proxy';
import { getSecret } from './auth/secrets';
import { hasForwardingHeaders, isLoopbackAddress } from './auth/state';
import { registerProtectedPort } from './protected-ports';

export const UIX_SERVICE_HEADER = 'x-uix-service-token';
const DEFAULT_UIX_URL = 'https://uix-production.up.railway.app';

/** The UIX origin (UIX_URL, else the older UIX_BASE_URL name, else production). */
export function uixBaseUrl(): string {
  return (process.env.UIX_URL || process.env.UIX_BASE_URL || DEFAULT_UIX_URL).trim().replace(/\/+$/, '');
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

let warnedMissingToken = false;
function serviceToken(): string {
  const token = getSecret('UIX_SERVICE_TOKEN');
  if (!token && !warnedMissingToken) {
    warnedMissingToken = true;
    console.warn('[uix] UIX_SERVICE_TOKEN is not set — calls to UIX carry no service credential and will be refused once UIX enforces it.');
  }
  return token;
}

/** Headers to add to a request for `url` (the token only ever goes to UIX). */
export function uixAuthHeaders(url: string): Record<string, string> {
  if (!sameOrigin(url, uixBaseUrl())) return {};
  const token = serviceToken();
  return token ? { [UIX_SERVICE_HEADER]: token } : {};
}

/**
 * fetch() for UIX. A leading-slash path is resolved against the UIX origin; an
 * absolute URL is fetched as-is and only gets the token when it IS the UIX origin.
 */
export function uixFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = pathOrUrl.startsWith('/') ? `${uixBaseUrl()}${pathOrUrl}` : pathOrUrl;
  const headers = new Headers(init.headers ?? {});
  for (const [k, v] of Object.entries(uixAuthHeaders(url))) headers.set(k, v);
  return fetch(url, { ...init, headers });
}

// Relay credentials must never be forwarded to UIX.
const STRIP_REQUEST_HEADERS = ['authorization', 'x-auth-token', 'cookie', UIX_SERVICE_HEADER];

function stripCorsHeaders(headers: http.IncomingHttpHeaders): void {
  for (const key of Object.keys(headers)) {
    if (key.startsWith('access-control-')) delete headers[key];
  }
}

let browserProxy: httpProxy | null = null;
function getBrowserProxy(): httpProxy {
  if (browserProxy) return browserProxy;
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    xfwd: false,
    proxyTimeout: 15 * 60_000,
    timeout: 15 * 60_000,
  });
  proxy.on('proxyReq', (proxyReq) => {
    for (const name of STRIP_REQUEST_HEADERS) proxyReq.removeHeader(name);

    const token = serviceToken();
    if (token) proxyReq.setHeader(UIX_SERVICE_HEADER, token);
  });
  // relay's CORS middleware already set the (allowlisted) CORS headers; UIX's own
  // reflecting CORS headers must not override them.
  proxy.on('proxyRes', (proxyRes) => stripCorsHeaders(proxyRes.headers));
  proxy.on('error', (error, _req, res) => {
    const out = res as http.ServerResponse;
    if (out && typeof out.headersSent === 'boolean' && !out.headersSent) {
      out.writeHead(502, { 'Content-Type': 'application/json' });
      out.end(JSON.stringify({ error: 'uix_unreachable', message: error.message }));
    } else {
      try { (res as http.ServerResponse).destroy(); } catch { /* gone */ }
    }
  });
  browserProxy = proxy;
  return proxy;
}

/**
 * `app.use('/api/uix', uixProxyMiddleware)` — mount AFTER the default-deny
 * authenticate middleware and BEFORE any body parser (bodies are streamed).
 */
export function uixProxyMiddleware(req: ExpressRequest, res: ExpressResponse, next: NextFunction): void {
  if (!req.auth) { next(); return; } // defensive: authenticate runs first and 401s
  // Express strips the mount path: req.url is now `/api/v1/…`.
  //
  // Scrub the incoming headers HERE, not only in the 'proxyReq' hook:
  // http-proxy never emits 'proxyReq' for a request carrying
  // `Expect: 100-continue` (curl sends it for any body > 1 MB), so such a
  // request used to reach UIX with the relay Bearer token and WITHOUT the
  // service token — UIX refused it and the upload died with EPIPE (found by the
  // A2 live .fig upload). Node already answered the 100-continue to our client,
  // so the header must not be forwarded either.
  delete req.headers.expect;
  for (const name of STRIP_REQUEST_HEADERS) delete req.headers[name];
  const token = serviceToken();
  getBrowserProxy().web(req, res, {
    target: uixBaseUrl(),
    ...(token ? { headers: { [UIX_SERVICE_HEADER]: token } } : {}),
  }, (error) => next(error));
}

// ── loopback proxy for the headless render harness ──────────────────────────

let harnessProxy: Promise<{ url: string; close: () => void } | null> | null = null;

/** The UIX reads the render harness makes (relay-web src/render-harness/main.ts). */
const HARNESS_UIX_EXACT = new Set(['/api/v1/figma/ir/data', '/api/v1/figma/uploads', '/api/v1/figma/fonts/list']);
const HARNESS_UIX_PREFIXES = ['/api/v1/figma/fonts/file/', '/assets/'];

/**
 * Map a harness-proxy request URL to the UIX path+query it may fetch, or a refusal.
 * Exported for tests.
 */
export function resolveHarnessRequest(
  method: string | undefined,
  rawUrl: string | undefined,
  cap: string,
): { ok: true; target: string } | { ok: false; status: number; message: string } {
  const url = rawUrl || '/';
  const prefix = `/h/${cap}/`;
  const head = Buffer.from(url.slice(0, prefix.length));
  const want = Buffer.from(prefix);
  if (head.length !== want.length || !crypto.timingSafeEqual(head, want)) {
    return { ok: false, status: 404, message: 'not found' };
  }
  const m = (method || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return { ok: false, status: 405, message: 'read-only proxy (GET/HEAD)' };
  const rest = url.slice(prefix.length - 1); // keep the leading '/'
  if (/%2f|%5c|\\/i.test(rest.split('?')[0])) return { ok: false, status: 400, message: 'encoded separators refused' };
  let parsed: URL;
  try {
    parsed = new URL(rest, 'http://harness.invalid'); // normalises '.', '..' and %2e segments
  } catch {
    return { ok: false, status: 400, message: 'bad url' };
  }
  const pathname = parsed.pathname;
  const allowed = HARNESS_UIX_EXACT.has(pathname) || HARNESS_UIX_PREFIXES.some((p) => pathname.startsWith(p) && pathname.length > p.length);
  if (!allowed) return { ok: false, status: 403, message: 'path not available to the render harness' };
  return { ok: true, target: `${pathname}${parsed.search}` };
}

async function forwardForHarness(req: http.IncomingMessage, res: http.ServerResponse, selfBase: string, uixPath: string): Promise<void> {
  const target = `${uixBaseUrl()}${uixPath}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (['host', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer', ...STRIP_REQUEST_HEADERS].includes(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const token = serviceToken();
  if (token) headers.set(UIX_SERVICE_HEADER, token);
  // resolveHarnessRequest admitted only GET/HEAD: there is never a body to forward.
  const method = (req.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
  const upstream = await fetch(target, { method, headers, redirect: 'manual' });
  const contentType = upstream.headers.get('content-type') || '';
  const outHeaders: Record<string, string> = {
    // The harness page is on another loopback origin and fetches cross-origin.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': upstream.headers.get('cache-control') || 'no-store',
  };
  if (contentType) outHeaders['Content-Type'] = contentType;
  if (contentType.includes('json')) {
    // Route absolute UIX URLs (asset bytes, fonts, renders) back through this proxy.
    const text = (await upstream.text()).split(uixBaseUrl()).join(selfBase);
    res.writeHead(upstream.status, outHeaders);
    res.end(text);
    return;
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, outHeaders);
  res.end(bytes);
}

/**
 * Base URL the harness should use as `?base=` (a 127.0.0.1 ephemeral port). Falls
 * back to the direct UIX origin if the proxy cannot start.
 */
export async function getHarnessUixBase(): Promise<string> {
  if (!harnessProxy) {
    harnessProxy = new Promise((resolve) => {
      let selfBase = '';
      const cap = crypto.randomBytes(24).toString('base64url');
      const server = http.createServer((req, res) => {
        if (!isLoopbackAddress(req.socket.remoteAddress) || hasForwardingHeaders(req.headers)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('loopback only');
          return;
        }
        if (req.method === 'OPTIONS') {
          // Preflight: answered without touching UIX; only the read methods.
          const pre = resolveHarnessRequest('GET', req.url, cap);
          if (!pre.ok) { res.writeHead(pre.status, { 'Content-Type': 'text/plain' }); res.end(pre.message); return; }
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type, accept',
          });
          res.end();
          return;
        }
        const decision = resolveHarnessRequest(req.method, req.url, cap);
        if (!decision.ok) {
          // No CORS header on refusals: a page probing the port learns nothing.
          res.writeHead(decision.status, { 'Content-Type': 'text/plain' });
          res.end(decision.message);
          return;
        }
        forwardForHarness(req, res, selfBase, decision.target).catch((error: unknown) => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'uix_unreachable', message: error instanceof Error ? error.message : String(error) }));
        });
      });
      server.on('error', () => resolve(null));
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        registerProtectedPort(port, 'the relay UIX loopback proxy');
        server.unref();
        selfBase = `http://127.0.0.1:${port}/h/${cap}`;
        resolve({ url: selfBase, close: () => server.close() });
      });
    });
  }
  const handle = await harnessProxy;
  return handle ? handle.url : uixBaseUrl();
}

/** Test helper. */
export async function closeHarnessUixProxy(): Promise<void> {
  const handle = harnessProxy ? await harnessProxy : null;
  harnessProxy = null;
  handle?.close();
}
