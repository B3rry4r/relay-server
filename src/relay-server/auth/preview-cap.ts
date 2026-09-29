/*
 * /flutter-preview path capabilities (CONTRACTS §2 "Previews", audit §4.5).
 *
 * An iframe cannot send a header, and a Flutter web preview is 50+ requests plus
 * DDC-injected scripts, so a one-time ticket does not fit. Instead the preview is
 * served under a MULTI-USE, project-scoped, 12 h capability placed in the PATH:
 *
 *   /flutter-preview/<projectId>/c/<cap>/index.html
 *
 * The rewritten `<base href>` includes `/c/<cap>/`, so every static and dynamic
 * asset carries it automatically. `cap = <exp36>.<binding>.<mac>` where
 * mac = HMAC-SHA256(key, projectId‖exp‖binding) truncated to 128 bits and the
 * binding is the minting session's id ("local"/"legacy" for those carriers).
 * Revoking the minting session (or closing the legacy window) kills its caps.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveWorkspace } from '../runtime';
import { isLegacyWindowOpen } from './legacy';
import { findSessionById } from './session-store';
import { authStatePaths, ensurePrivateDir, writeFileAtomic } from './state';

export const PREVIEW_CAP_TTL_MS = 12 * 60 * 60 * 1000;
const BINDING_PATTERN = /^(?:local|legacy|[0-9a-f-]{36})$/;

function previewKey(workspace = resolveWorkspace()): Buffer {
  const file = authStatePaths(workspace).previewKey;
  try {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return raw;
  } catch { /* create below */ }
  ensurePrivateDir(authStatePaths(workspace).state);
  const key = crypto.randomBytes(32);
  try {
    // 'wx' semantics via writeFileAtomic + re-read so two racing processes agree.
    if (!fs.existsSync(file)) writeFileAtomic(file, key, 0o600);
  } catch { /* another process won */ }
  try { return fs.readFileSync(file); } catch { return key; }
}

function mac(key: Buffer, projectId: string, exp: string, binding: string): string {
  return crypto.createHmac('sha256', key).update(`${projectId}\n${exp}\n${binding}`).digest().subarray(0, 16).toString('base64url');
}

export function mintPreviewCap(
  projectId: string,
  binding: string,
  workspace = resolveWorkspace(),
  now = Date.now(),
): { cap: string; expiresAt: string } {
  const exp = Math.floor((now + PREVIEW_CAP_TTL_MS) / 1000).toString(36);
  const cap = `${exp}.${binding}.${mac(previewKey(workspace), projectId, exp, binding)}`;
  return { cap, expiresAt: new Date(Number.parseInt(exp, 36) * 1000).toISOString() };
}

export type PreviewCapCheck = { ok: true; binding: string } | { ok: false; reason: 'malformed' | 'bad-mac' | 'expired' | 'revoked' };

export async function verifyPreviewCap(
  projectId: string,
  cap: string,
  workspace = resolveWorkspace(),
  now = Date.now(),
): Promise<PreviewCapCheck> {
  const parts = typeof cap === 'string' ? cap.split('.') : [];
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [exp, binding, given] = parts;
  if (!/^[0-9a-z]{1,12}$/.test(exp) || !BINDING_PATTERN.test(binding)) return { ok: false, reason: 'malformed' };
  const expected = mac(previewKey(workspace), projectId, exp, binding);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-mac' };
  if (now >= Number.parseInt(exp, 36) * 1000) return { ok: false, reason: 'expired' };
  if (binding === 'local') return { ok: true, binding };
  if (binding === 'legacy') {
    return isLegacyWindowOpen(workspace, now) ? { ok: true, binding } : { ok: false, reason: 'revoked' };
  }
  const alive = await sessionAliveCached(binding, workspace, now);
  return alive ? { ok: true, binding } : { ok: false, reason: 'revoked' };
}

// A preview page fetches dozens of assets; re-listing the sessions dir for each is
// wasteful. Cache the "is this session id alive" answer for 5 s (the same bound
// the socket sweep uses for cross-instance revocation).
const aliveCache = new Map<string, { at: number; alive: boolean }>();
async function sessionAliveCached(id: string, workspace: string, now: number): Promise<boolean> {
  const key = `${workspace}|${id}`;
  const hit = aliveCache.get(key);
  if (hit && now - hit.at < 5000) return hit.alive;
  const alive = Boolean(await findSessionById(id, workspace));
  if (aliveCache.size > 200) aliveCache.clear();
  aliveCache.set(key, { at: now, alive });
  return alive;
}

export function forgetPreviewCapCache(): void {
  aliveCache.clear();
}
