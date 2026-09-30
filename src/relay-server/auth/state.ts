/*
 * On-disk auth state under `$WORKSPACE/.relay/state/`.
 *
 * The session-store layout is SHARED with relay-pty (CONTRACTS §2) — both
 * processes read and write these files, so the format here is a contract:
 *
 *   sessions/                 0700, one file per session
 *   sessions/<sha256hex(token)>.json   0600, written tmp+rename
 *   owner-epoch               integer (missing → 0)
 *   local-token               0600, box-local credential
 *   legacy-token-until        ISO timestamp (raw-AUTH_TOKEN migration window)
 *
 * Relay-server-only files (not part of the shared contract):
 *   owner-secret.fp           fingerprint of the configured owner secret; a change
 *                             bumps owner-epoch (logs every session out)
 *   preview-cap.key           HMAC key for /flutter-preview path capabilities
 *   login-links/<sha256>.json one-time break-glass login codes
 *   api-url                   loopback URL of the running relay API (relay-auth CLI)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRelayStateRoot, resolveWorkspace } from '../runtime';

export function authStatePaths(workspace = resolveWorkspace()) {
  const state = getRelayStateRoot(workspace);
  return {
    state,
    sessionsDir: path.join(state, 'sessions'),
    ownerEpoch: path.join(state, 'owner-epoch'),
    localToken: path.join(state, 'local-token'),
    legacyUntil: path.join(state, 'legacy-token-until'),
    ownerFingerprint: path.join(state, 'owner-secret.fp'),
    previewKey: path.join(state, 'preview-cap.key'),
    loginLinksDir: path.join(state, 'login-links'),
    apiUrl: path.join(state, 'api-url'),
  };
}

export function sha256hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string equality that does not leak length (hash both first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

/** mkdir -p with a mode, and tighten the mode if the dir already existed. */
export function ensurePrivateDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* not ours to chmod — best effort */ }
}

/** Atomic write: tmp file (created with `mode`) in the same dir, then rename. */
export function writeFileAtomic(target: string, content: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The owner epoch: an integer in `owner-epoch`; missing or garbage → 0. */
export function readOwnerEpoch(workspace = resolveWorkspace()): number {
  const raw = readTextFile(authStatePaths(workspace).ownerEpoch);
  if (raw === null) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function writeOwnerEpoch(epoch: number, workspace = resolveWorkspace()): void {
  const paths = authStatePaths(workspace);
  ensurePrivateDir(paths.state);
  writeFileAtomic(paths.ownerEpoch, `${epoch}\n`, 0o600);
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('::ffff:')) return LOOPBACK_V4.test(a.slice('::ffff:'.length));
  return LOOPBACK_V4.test(a);
}

/** Headers whose presence marks a request as having come through a proxy. */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'fly-client-ip',
  'cf-connecting-ip',
] as const;

export function hasForwardingHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * "Local" = the TCP peer is loopback AND no proxy header is present. A request
 * that came through the front door, a cloudflared tunnel (cf-connecting-ip) or
 * any forwarding proxy is never local, even though it arrives from 127.0.0.1.
 */
export function isLocalPeer(
  remoteAddress: string | undefined | null,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return isLoopbackAddress(remoteAddress) && !hasForwardingHeaders(headers);
}
