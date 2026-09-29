/*
 * The owner secret: the password accepted ONLY at POST /api/auth/login (plus the
 * legacy raw-token window, see legacy.ts).
 *
 *   AUTH_TOKEN_HASH  preferred. `scrypt$N$r$p$saltB64$hashB64` (generate with
 *                    `relay-auth hash-secret`).
 *   AUTH_TOKEN       plaintext, still supported (deprecation warning).
 *
 * Changing the secret bumps the owner epoch at the next boot, which invalidates
 * every session (the session files carry the epoch they were minted under).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveWorkspace } from '../runtime';
import { getSecret } from './secrets';
import {
  authStatePaths,
  ensurePrivateDir,
  readOwnerEpoch,
  readTextFile,
  safeEqual,
  sha256hex,
  writeFileAtomic,
  writeOwnerEpoch,
} from './state';

/** The value the old Dockerfile / .env.example baked in. Never a valid secret. */
export const PLACEHOLDER_SECRETS = ['change_this_to_a_strong_random_string'];
export const MIN_SECRET_LENGTH = 16;

export type ScryptParams = { N: number; r: number; p: number; salt: Buffer; hash: Buffer };

export type OwnerSecretConfig =
  | { kind: 'hash'; params: ScryptParams; raw: string }
  | { kind: 'plain'; secret: string }
  | { kind: 'none' };

export function parseScryptHash(value: string): ScryptParams | null {
  const parts = value.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map((x) => Number.parseInt(x, 10));
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0)) return null;
  if ((N & (N - 1)) !== 0 || N < 2 ** 10 || N > 2 ** 22 || r > 64 || p > 16) return null;
  try {
    const salt = Buffer.from(parts[4], 'base64');
    const hash = Buffer.from(parts[5], 'base64');
    if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

function scryptSync(secret: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Buffer {
  return crypto.scryptSync(secret, salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** Produce an `AUTH_TOKEN_HASH` value for a secret. */
export function hashOwnerSecret(secret: string, N = 2 ** 15, r = 8, p = 1): string {
  const salt = crypto.randomBytes(16);
  const hash = scryptSync(secret, salt, 32, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function readOwnerSecretConfig(): OwnerSecretConfig {
  const hashValue = getSecret('AUTH_TOKEN_HASH').trim();
  if (hashValue) {
    const params = parseScryptHash(hashValue);
    // A malformed hash must not silently fall back to a plaintext secret.
    if (!params) return { kind: 'none' };
    return { kind: 'hash', params, raw: hashValue };
  }
  const plain = getSecret('AUTH_TOKEN');
  if (plain) return { kind: 'plain', secret: plain };
  return { kind: 'none' };
}

/** Plaintext AUTH_TOKEN, only when it is a usable (non-placeholder) value. */
export function readPlainOwnerToken(): string {
  const plain = getSecret('AUTH_TOKEN');
  if (!plain || PLACEHOLDER_SECRETS.includes(plain)) return '';
  return plain;
}

/**
 * Boot validation (src/index.ts refuses to start on any error): at least one of
 * AUTH_TOKEN / AUTH_TOKEN_HASH, never the placeholder, never shorter than 16,
 * and a hash that parses.
 */
export function validateOwnerSecretEnv(): { ok: true; warnings: string[] } | { ok: false; error: string } {
  const hashValue = getSecret('AUTH_TOKEN_HASH').trim();
  const plain = getSecret('AUTH_TOKEN');
  const warnings: string[] = [];
  if (!hashValue && !plain) {
    return {
      ok: false,
      error: 'Neither AUTH_TOKEN_HASH nor AUTH_TOKEN is set. Set AUTH_TOKEN_HASH (generate it with '
        + '`node scripts/relay-auth hash-secret`) or AUTH_TOKEN (at least 16 characters) and restart.',
    };
  }
  if (hashValue && !parseScryptHash(hashValue)) {
    return {
      ok: false,
      error: 'AUTH_TOKEN_HASH is malformed. Expected scrypt$N$r$p$saltB64$hashB64 '
        + '(generate it with `node scripts/relay-auth hash-secret`).',
    };
  }
  if (plain) {
    if (PLACEHOLDER_SECRETS.includes(plain)) {
      return { ok: false, error: 'AUTH_TOKEN is the published placeholder value. Set a real secret and restart.' };
    }
    if (plain.length < MIN_SECRET_LENGTH) {
      return { ok: false, error: `AUTH_TOKEN is shorter than ${MIN_SECRET_LENGTH} characters. Set a longer secret and restart.` };
    }
    if (!hashValue) {
      warnings.push('AUTH_TOKEN (plaintext) is deprecated as the owner secret; prefer AUTH_TOKEN_HASH.');
    }
  }
  return { ok: true, warnings };
}

// Positive-result cache for hash verification (scrypt is deliberately slow).
const verifiedCache = new Map<string, number>();

/** Constant-time check of a login attempt against the configured owner secret. */
export function verifyOwnerSecret(candidate: string, config = readOwnerSecretConfig()): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 1024) return false;
  if (config.kind === 'none') return false;
  if (config.kind === 'plain') {
    if (PLACEHOLDER_SECRETS.includes(config.secret)) return false;
    return safeEqual(candidate, config.secret);
  }
  const cacheKey = `${sha256hex(config.raw)}:${sha256hex(candidate)}`;
  if (verifiedCache.has(cacheKey)) return true;
  const { N, r, p, salt, hash } = config.params;
  let derived: Buffer;
  try {
    derived = scryptSync(candidate, salt, hash.length, N, r, p);
  } catch {
    return false;
  }
  const ok = crypto.timingSafeEqual(derived, hash);
  if (ok) {
    if (verifiedCache.size > 16) verifiedCache.clear();
    verifiedCache.set(cacheKey, Date.now());
  }
  return ok;
}

const FP_SALT = Buffer.from('relay-owner-epoch-v1');

/** A non-reversible fingerprint of the configured secret (slow hash for plaintext). */
export function ownerSecretFingerprint(config = readOwnerSecretConfig()): string | null {
  if (config.kind === 'none') return null;
  if (config.kind === 'hash') return `h:${sha256hex(config.raw)}`;
  const derived = scryptSync(config.secret, FP_SALT, 32, 2 ** 14, 8, 1);
  return `p:${derived.toString('hex')}`;
}

/**
 * Called at server creation: if the configured owner secret differs from the one
 * recorded last boot, bump owner-epoch so every existing session dies. Returns the
 * epoch now in force. No secret configured → nothing recorded, nothing bumped.
 */
export function reconcileOwnerEpoch(workspace = resolveWorkspace()): { epoch: number; bumped: boolean } {
  const fp = ownerSecretFingerprint();
  const paths = authStatePaths(workspace);
  const current = readOwnerEpoch(workspace);
  if (!fp) return { epoch: current, bumped: false };
  const recorded = readTextFile(paths.ownerFingerprint)?.trim() ?? '';
  if (recorded === fp) return { epoch: current, bumped: false };
  ensurePrivateDir(paths.state);
  let epoch = current;
  let bumped = false;
  if (recorded) {
    epoch = current + 1;
    writeOwnerEpoch(epoch, workspace);
    bumped = true;
  } else if (!fs.existsSync(paths.ownerEpoch)) {
    writeOwnerEpoch(epoch, workspace);
  }
  writeFileAtomic(paths.ownerFingerprint, `${fp}\n`, 0o600);
  return { epoch, bumped };
}
