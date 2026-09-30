/*
 * Legacy raw-AUTH_TOKEN window (CONTRACTS §2).
 *
 * Until `legacyUntil`, the raw AUTH_TOKEN is still accepted as Bearer /
 * x-auth-token / socket auth.token from ANY address, so open tabs, the phone, MCP
 * configs and scripts keep working across the deploy. `legacyUntil` = first boot
 * of this code + 14 days, persisted in `.relay/state/legacy-token-until` (ISO).
 * `RELAY_LEGACY_TOKEN_UNTIL` overrides it (ISO date, or `off`).
 *
 * Only the PLAINTEXT AUTH_TOKEN form participates: a deployment that configured
 * only AUTH_TOKEN_HASH never had raw-token clients (and verifying a hash per
 * request would be an scrypt-per-request DoS vector).
 *
 * Every use is logged as `legacy-token-use` (UA, IP); repeats from the same
 * client are folded into one line per minute with a count.
 */
import fs from 'node:fs';
import { resolveWorkspace } from '../runtime';
import { readPlainOwnerToken } from './owner-secret';
import { authStatePaths, ensurePrivateDir, readTextFile, safeEqual, writeFileAtomic } from './state';

export const LEGACY_WINDOW_DAYS = 14;

export type LegacyWindow = { until: Date | null; source: 'env' | 'file' | 'off' | 'invalid-env' };

let warnedInvalidEnv = false;

/** Resolve the window (creating the persisted file on first call). */
export function resolveLegacyWindow(workspace = resolveWorkspace(), now = Date.now()): LegacyWindow {
  const env = (process.env.RELAY_LEGACY_TOKEN_UNTIL || '').trim();
  if (env) {
    if (env.toLowerCase() === 'off') return { until: null, source: 'off' };
    const parsed = Date.parse(env);
    if (Number.isFinite(parsed)) return { until: new Date(parsed), source: 'env' };
    if (!warnedInvalidEnv) {
      warnedInvalidEnv = true;
      console.warn(`[auth] RELAY_LEGACY_TOKEN_UNTIL=${JSON.stringify(env)} is not an ISO date or "off" — legacy raw-token auth is DISABLED.`);
    }
    return { until: null, source: 'invalid-env' };
  }
  const file = authStatePaths(workspace).legacyUntil;
  const raw = readTextFile(file)?.trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return { until: new Date(parsed), source: 'file' };
  }
  const until = new Date(now + LEGACY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  try {
    ensurePrivateDir(authStatePaths(workspace).state);
    if (!fs.existsSync(file) || !raw) writeFileAtomic(file, `${until.toISOString()}\n`, 0o600);
  } catch (error) {
    console.warn('[auth] could not persist legacy-token-until:', error instanceof Error ? error.message : error);
  }
  return { until, source: 'file' };
}

export function isLegacyWindowOpen(workspace = resolveWorkspace(), now = Date.now()): boolean {
  const window = resolveLegacyWindow(workspace, now);
  return window.until !== null && now < window.until.getTime();
}

/** True iff `candidate` is the raw AUTH_TOKEN and the window is open. */
export function matchesLegacyToken(candidate: string, workspace = resolveWorkspace(), now = Date.now()): boolean {
  if (!candidate || candidate.startsWith('rs_')) return false;
  const plain = readPlainOwnerToken();
  if (!plain) return false;
  if (!safeEqual(candidate, plain)) return false;
  return isLegacyWindowOpen(workspace, now);
}

const lastLogged = new Map<string, { at: number; suppressed: number }>();
let legacyUseCount = 0;

export function getLegacyUseCount(): number {
  return legacyUseCount;
}

export function logLegacyUse(details: { ip: string; ua: string; carrier: 'http' | 'socket'; path?: string }): void {
  legacyUseCount += 1;
  const key = `${details.ip}|${details.ua}|${details.carrier}`;
  const now = Date.now();
  const prev = lastLogged.get(key);
  if (prev && now - prev.at < 60_000) {
    prev.suppressed += 1;
    return;
  }
  const folded = prev?.suppressed ? ` (+${prev.suppressed} more since last line)` : '';
  lastLogged.set(key, { at: now, suppressed: 0 });
  if (lastLogged.size > 500) lastLogged.clear();
  console.warn(
    `[auth] legacy-token-use carrier=${details.carrier} ip=${details.ip || '-'} ua=${JSON.stringify(details.ua || '-')}`
    + `${details.path ? ` path=${details.path}` : ''}${folded} — this client still sends the raw AUTH_TOKEN; `
    + 'sign in to get a session token before the legacy window closes.',
  );
}
