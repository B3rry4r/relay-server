/*
 * Box-local token: `$WORKSPACE/.relay/state/local-token` (0600, created at boot).
 *
 * Accepted ONLY when the TCP peer is loopback and no forwarding header is present
 * (so nothing that came through the front door, a cloudflared tunnel or any proxy
 * can use it), and NEVER at /api/auth/login. It is a convenience for tools on the
 * box (relay-auth, mcp-server.mjs, the host's readiness probe, the CLAUDE.md curl
 * recipe) — not a security boundary: anyone who can read it is already on the box.
 */
import fs from 'node:fs';
import { resolveWorkspace } from '../runtime';
import { authStatePaths, ensurePrivateDir, randomToken, safeEqual, writeFileAtomic } from './state';

export const LOCAL_TOKEN_PREFIX = 'rl_';

let cache: { path: string; mtimeMs: number; value: string } | null = null;

/** Create the local token if missing (and tighten its mode). Returns its value. */
export function ensureLocalToken(workspace = resolveWorkspace()): string {
  const paths = authStatePaths(workspace);
  ensurePrivateDir(paths.state);
  const existing = readLocalToken(workspace);
  if (existing) {
    try { fs.chmodSync(paths.localToken, 0o600); } catch { /* best effort */ }
    return existing;
  }
  const token = randomToken(LOCAL_TOKEN_PREFIX, 32);
  writeFileAtomic(paths.localToken, `${token}\n`, 0o600);
  cache = null;
  return token;
}

export function rotateLocalToken(workspace = resolveWorkspace()): string {
  const paths = authStatePaths(workspace);
  ensurePrivateDir(paths.state);
  const token = randomToken(LOCAL_TOKEN_PREFIX, 32);
  writeFileAtomic(paths.localToken, `${token}\n`, 0o600);
  cache = null;
  return token;
}

export function readLocalToken(workspace = resolveWorkspace()): string {
  const file = authStatePaths(workspace).localToken;
  try {
    const stat = fs.statSync(file);
    if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs) return cache.value;
    const value = fs.readFileSync(file, 'utf8').trim();
    cache = { path: file, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return '';
  }
}

export function matchesLocalToken(candidate: string, workspace = resolveWorkspace()): boolean {
  if (!candidate) return false;
  const expected = readLocalToken(workspace);
  return expected.length > 0 && safeEqual(candidate, expected);
}
