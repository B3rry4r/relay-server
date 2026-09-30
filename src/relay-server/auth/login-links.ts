/*
 * Break-glass login links (`relay-auth login-link`).
 *
 * An authenticated caller (normally the box-local CLI) mints a one-time code with
 * a short TTL. The browser exchanges it at the PUBLIC endpoint
 * `POST /api/auth/login-link/exchange {code, label?}` for a normal browser
 * session — no owner password needed. Codes live on disk (hashed) so a restart
 * inside the TTL does not lose them, and single use is enforced with an atomic
 * rename (only one claimant can win, even across two relay processes).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from '../runtime';
import { authStatePaths, ensurePrivateDir, randomToken, sha256hex, writeFileAtomic } from './state';

export const LOGIN_LINK_TTL_MS = 5 * 60_000;
const CODE_PATTERN = /^ll_[A-Za-z0-9_-]{32}$/;

export function mintLoginLinkCode(
  meta: { createdBy: string },
  workspace = resolveWorkspace(),
  now = Date.now(),
): { code: string; expiresAt: string } {
  const dir = authStatePaths(workspace).loginLinksDir;
  ensurePrivateDir(dir);
  pruneExpired(dir, now);
  const code = randomToken('ll_', 24);
  const expiresAt = new Date(now + LOGIN_LINK_TTL_MS).toISOString();
  writeFileAtomic(path.join(dir, `${sha256hex(code)}.json`), `${JSON.stringify({ expiresAt, createdBy: meta.createdBy })}\n`, 0o600);
  return { code, expiresAt };
}

/** Consume a code. True exactly once per valid, unexpired code. */
export function consumeLoginLinkCode(code: string, workspace = resolveWorkspace(), now = Date.now()): boolean {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return false;
  const dir = authStatePaths(workspace).loginLinksDir;
  const file = path.join(dir, `${sha256hex(code)}.json`);
  const claimed = `${file}.claimed-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return false; // unknown code, or someone else already claimed it
  }
  try {
    const { expiresAt } = JSON.parse(fs.readFileSync(claimed, 'utf8')) as { expiresAt?: string };
    const exp = Date.parse(expiresAt ?? '');
    return Number.isFinite(exp) && now < exp;
  } catch {
    return false;
  } finally {
    fs.rmSync(claimed, { force: true });
  }
}

function pruneExpired(dir: string, now: number): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (name.includes('.claimed-')) { fs.rmSync(file, { force: true }); continue; }
      const { expiresAt } = JSON.parse(fs.readFileSync(file, 'utf8')) as { expiresAt?: string };
      if (!(Date.parse(expiresAt ?? '') > now)) fs.rmSync(file, { force: true });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}

/** Public URL of this relay (for the link), when it can be inferred. */
export function inferRelayPublicUrl(): string | null {
  const explicit = (process.env.RELAY_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return `https://${railway}`;
  const fly = (process.env.FLY_APP_NAME || '').trim();
  if (fly) return `https://${fly}.fly.dev`;
  return null;
}

/**
 * The relay-web URL that completes the sign-in. The code and server travel in the
 * FRAGMENT so they never reach any server log:
 *   <web>/#relay-login-link=<code>&relay-server=<urlencoded relay base URL>
 */
export function buildLoginLinkUrl(webUrl: string | null, serverUrl: string | null, code: string): string | null {
  if (!webUrl || !serverUrl) return null;
  const base = webUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  return `${base}/#relay-login-link=${encodeURIComponent(code)}&relay-server=${encodeURIComponent(serverUrl)}`;
}
