/*
 * CORS allowlist (CONTRACTS §2). Bearer tokens are the gate; CORS is defence in
 * depth — but a wrong allowlist is the one realistic owner lockout, so the
 * configuration is explicit and loud:
 *
 *   RELAY_ALLOWED_ORIGINS      comma list of exact origins (https://relay.example.com)
 *   RELAY_WEB_ORIGIN_PATTERN   optional glob, `*` = one DNS label, e.g. https://*.fly.dev
 *
 * When RELAY_ALLOWED_ORIGINS is unset the defaults below apply and a warning is
 * logged at boot. An arbitrary Origin is NEVER reflected, and credentials (cookies)
 * are never allowed cross-origin.
 */
import type cors from 'cors';

/** Origins referenced by code/env defaults today, plus the Vite dev server. */
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // relay-web's DEFAULT_BACKEND_URL (src/lib/constants.ts) — relay's own public
  // origin on Railway; harmless to allow and keeps same-origin tooling working.
  'https://relay-server-production-afc7.up.railway.app',
];

export type OriginPolicy = {
  explicit: boolean;
  origins: string[];
  pattern: RegExp | null;
  patternSource: string | null;
  isAllowed(origin: string | undefined | null): boolean;
};

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function globToOriginRegex(glob: string): RegExp | null {
  const trimmed = glob.trim().toLowerCase().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) return null;
  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
  return new RegExp(`^${escaped}$`);
}

export function buildOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const raw = (env.RELAY_ALLOWED_ORIGINS || '').trim();
  const explicit = raw.length > 0;
  const list = explicit ? raw.split(',') : DEFAULT_ALLOWED_ORIGINS;
  const origins = Array.from(new Set(list.map(normalizeOrigin).filter((v): v is string => Boolean(v))));
  const patternSource = (env.RELAY_WEB_ORIGIN_PATTERN || '').trim() || null;
  const pattern = patternSource ? globToOriginRegex(patternSource) : null;
  return {
    explicit,
    origins,
    pattern,
    patternSource,
    isAllowed(origin) {
      if (!origin) return false;
      const normalized = normalizeOrigin(origin);
      if (!normalized) return false;
      if (origins.includes(normalized)) return true;
      return Boolean(pattern && pattern.test(normalized));
    },
  };
}

let warnedDefaults = false;
const warnedRejected = new Set<string>();

export function logOriginPolicy(policy: OriginPolicy): void {
  if (policy.explicit || warnedDefaults) return;
  warnedDefaults = true;
  console.warn(
    '[auth] ********************************************************************\n'
    + '[auth] RELAY_ALLOWED_ORIGINS is NOT set. Browsers may only call this relay from:\n'
    + policy.origins.map((o) => `[auth]   ${o}`).join('\n')
    + (policy.patternSource ? `\n[auth]   + origins matching RELAY_WEB_ORIGIN_PATTERN=${policy.patternSource}` : '')
    + '\n[auth] Set RELAY_ALLOWED_ORIGINS=https://<your relay-web origin> or relay-web will be blocked by CORS.\n'
    + '[auth] ********************************************************************',
  );
}

export function noteRejectedOrigin(origin: string): void {
  if (warnedRejected.has(origin) || warnedRejected.size > 100) return;
  warnedRejected.add(origin);
  console.warn(`[auth] CORS: rejected Origin ${origin} (not in RELAY_ALLOWED_ORIGINS / RELAY_WEB_ORIGIN_PATTERN).`);
}

export function buildCorsOptions(policy: OriginPolicy): cors.CorsOptions {
  return {
    origin(origin, callback) {
      // No Origin: curl, server-to-server, same-origin navigations → nothing to allow.
      if (!origin) { callback(null, false); return; }
      if (policy.isAllowed(origin)) { callback(null, origin); return; }
      noteRejectedOrigin(origin);
      callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // allowedHeaders omitted → the preflight's requested headers are echoed, but
    // ONLY for allowlisted origins (a rejected origin gets no CORS headers at all).
    exposedHeaders: ['Content-Disposition', 'Retry-After', 'Content-Length'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}
