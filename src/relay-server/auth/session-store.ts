/*
 * File-per-session store (CONTRACTS §2 — the format is shared with relay-pty).
 *
 *   $WORKSPACE/.relay/state/sessions/<sha256hex(token)>.json   (0600, tmp+rename)
 *   {"v":1,"id":"<uuid>","kind":"browser"|"api","label":string,"createdAt":ISO,
 *    "absExp":ISO|null,"idleSecs":number|null,"ownerEpoch":number,"ua"?:string,"ip"?:string}
 *
 * - last-used = file mtime (touched at most once per 60 s)
 * - valid iff file exists ∧ (absExp null ∨ now<absExp) ∧ (idleSecs null ∨ now−mtime<idleSecs)
 *   ∧ ownerEpoch == integer in owner-epoch (missing → 0)
 * - revoke = unlink (every instance sees it on its next read; nothing is cached,
 *   so a stale process can never resurrect a revoked session)
 *
 * Only the sha256 of a token ever touches disk.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspace } from '../runtime';
import {
  authStatePaths,
  ensurePrivateDir,
  randomToken,
  readOwnerEpoch,
  sha256hex,
  writeFileAtomic,
} from './state';

export type SessionKind = 'browser' | 'api';

export type SessionFile = {
  v: 1;
  id: string;
  kind: SessionKind;
  label: string;
  createdAt: string;
  absExp: string | null;
  idleSecs: number | null;
  ownerEpoch: number;
  ua?: string;
  ip?: string;
};

export type SessionRecord = SessionFile & {
  /** sha256hex(token) — the file name stem. Never the token itself. */
  hash: string;
  /** File mtime = last use. */
  lastUsedAt: string;
};

export type PublicSession = {
  id: string;
  kind: SessionKind;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  idleExpiresAt: string | null;
  ua?: string;
  ip?: string;
  current?: boolean;
};

export const TOKEN_PREFIX = 'rs_';
const TOKEN_PATTERN = /^rs_[A-Za-z0-9_-]{43}$/;
const HASH_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;
const TOUCH_INTERVAL_MS = 60_000;
const DAY_S = 24 * 60 * 60;

/** Lifetimes (CONTRACTS §2). */
export const SESSION_LIFETIMES: Record<SessionKind, { absDays: number; idleSecs: number | null }> = {
  browser: { absDays: 30, idleSecs: 7 * DAY_S },
  api: { absDays: 90, idleSecs: null },
};

export function isSessionTokenShape(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

function sessionsDir(workspace = resolveWorkspace()): string {
  return authStatePaths(workspace).sessionsDir;
}

function fileForHash(hash: string, workspace = resolveWorkspace()): string {
  return path.join(sessionsDir(workspace), `${hash}.json`);
}

function parseSessionFile(raw: string): SessionFile | null {
  try {
    const value = JSON.parse(raw) as Partial<SessionFile>;
    if (value?.v !== 1 || typeof value.id !== 'string') return null;
    if (value.kind !== 'browser' && value.kind !== 'api') return null;
    if (typeof value.createdAt !== 'string' || typeof value.ownerEpoch !== 'number') return null;
    return {
      v: 1,
      id: value.id,
      kind: value.kind,
      label: typeof value.label === 'string' ? value.label : '',
      createdAt: value.createdAt,
      absExp: typeof value.absExp === 'string' ? value.absExp : null,
      idleSecs: typeof value.idleSecs === 'number' ? value.idleSecs : null,
      ownerEpoch: value.ownerEpoch,
      ...(typeof value.ua === 'string' ? { ua: value.ua } : {}),
      ...(typeof value.ip === 'string' ? { ip: value.ip } : {}),
    };
  } catch {
    return null;
  }
}

export type InvalidReason = 'missing' | 'expired' | 'idle' | 'epoch' | 'corrupt';

/** Pure validity check (exported for tests and the socket sweep). */
export function checkSession(
  file: SessionFile,
  mtimeMs: number,
  epoch: number,
  now = Date.now(),
): InvalidReason | null {
  if (file.absExp !== null) {
    const exp = Date.parse(file.absExp);
    if (!Number.isFinite(exp) || now >= exp) return 'expired';
  }
  if (file.idleSecs !== null && now - mtimeMs >= file.idleSecs * 1000) return 'idle';
  if (file.ownerEpoch !== epoch) return 'epoch';
  return null;
}

function toRecord(file: SessionFile, hash: string, mtimeMs: number): SessionRecord {
  return { ...file, hash, lastUsedAt: new Date(mtimeMs).toISOString() };
}

export function toPublicSession(record: SessionRecord, currentId?: string): PublicSession {
  const idleExpiresAt = record.idleSecs === null
    ? null
    : new Date(Date.parse(record.lastUsedAt) + record.idleSecs * 1000).toISOString();
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.absExp,
    idleExpiresAt,
    ...(record.ua ? { ua: record.ua } : {}),
    ...(record.ip ? { ip: record.ip } : {}),
    ...(currentId !== undefined ? { current: record.id === currentId } : {}),
  };
}

export type CreateSessionInput = {
  kind: SessionKind;
  label?: string;
  ua?: string;
  ip?: string;
  /** Override the absolute lifetime (days); clamped to the kind's maximum. */
  ttlDays?: number;
  /** Reuse an existing id (rotate keeps the session identity). */
  id?: string;
  createdAt?: string;
};

export function createSession(
  input: CreateSessionInput,
  workspace = resolveWorkspace(),
  now = Date.now(),
): { token: string; record: SessionRecord } {
  const lifetime = SESSION_LIFETIMES[input.kind];
  const days = input.ttlDays && input.ttlDays > 0
    ? Math.min(input.ttlDays, lifetime.absDays)
    : lifetime.absDays;
  const token = randomToken(TOKEN_PREFIX, 32);
  const hash = sha256hex(token);
  const file: SessionFile = {
    v: 1,
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    label: (input.label ?? '').slice(0, 120),
    createdAt: input.createdAt ?? new Date(now).toISOString(),
    absExp: new Date(now + days * DAY_S * 1000).toISOString(),
    idleSecs: lifetime.idleSecs,
    ownerEpoch: readOwnerEpoch(workspace),
    ...(input.ua ? { ua: input.ua.slice(0, 300) } : {}),
    ...(input.ip ? { ip: input.ip.slice(0, 64) } : {}),
  };
  ensurePrivateDir(sessionsDir(workspace));
  writeFileAtomic(fileForHash(hash, workspace), `${JSON.stringify(file)}\n`, 0o600);
  return { token, record: toRecord(file, hash, now) };
}

async function readByHash(hash: string, workspace: string): Promise<{ file: SessionFile; mtimeMs: number } | null> {
  const target = fileForHash(hash, workspace);
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(target, 'utf8'), fsp.stat(target)]);
    const file = parseSessionFile(raw);
    return file ? { file, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function maybeTouch(hash: string, mtimeMs: number, workspace: string, now: number): void {
  if (now - mtimeMs < TOUCH_INTERVAL_MS) return;
  const when = new Date(now);
  fsp.utimes(fileForHash(hash, workspace), when, when).catch(() => undefined);
}

/**
 * Resolve a bearer token to a live session, or null. Expired / idle / wrong-epoch
 * files are unlinked on sight. A hit refreshes the idle clock (throttled).
 */
export async function validateSessionToken(
  token: string,
  workspace = resolveWorkspace(),
  now = Date.now(),
): Promise<SessionRecord | null> {
  if (!isSessionTokenShape(token)) return null;
  const hash = sha256hex(token);
  const found = await readByHash(hash, workspace);
  if (!found) return null;
  const reason = checkSession(found.file, found.mtimeMs, readOwnerEpoch(workspace), now);
  if (reason) {
    await fsp.rm(fileForHash(hash, workspace), { force: true }).catch(() => undefined);
    return null;
  }
  maybeTouch(hash, found.mtimeMs, workspace, now);
  const lastUsed = now - found.mtimeMs >= TOUCH_INTERVAL_MS ? now : found.mtimeMs;
  return toRecord(found.file, hash, lastUsed);
}

/** Every live session (invalid ones are pruned as a side effect). */
export async function listSessions(workspace = resolveWorkspace(), now = Date.now()): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await fsp.readdir(sessionsDir(workspace));
  } catch {
    return [];
  }
  const epoch = readOwnerEpoch(workspace);
  const out: SessionRecord[] = [];
  for (const name of names) {
    if (!HASH_FILE_PATTERN.test(name)) continue;
    const hash = name.slice(0, -'.json'.length);
    const found = await readByHash(hash, workspace);
    if (!found) continue;
    if (checkSession(found.file, found.mtimeMs, epoch, now)) {
      await fsp.rm(fileForHash(hash, workspace), { force: true }).catch(() => undefined);
      continue;
    }
    out.push(toRecord(found.file, hash, found.mtimeMs));
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function findSessionById(id: string, workspace = resolveWorkspace()): Promise<SessionRecord | null> {
  const all = await listSessions(workspace);
  return all.find((s) => s.id === id) ?? null;
}

export async function revokeSessionByHash(hash: string, workspace = resolveWorkspace()): Promise<boolean> {
  try {
    await fsp.unlink(fileForHash(hash, workspace));
    return true;
  } catch {
    return false;
  }
}

/** Revoke by public id. Returns the revoked record, or null if no such session. */
export async function revokeSessionById(id: string, workspace = resolveWorkspace()): Promise<SessionRecord | null> {
  const record = await findSessionById(id, workspace);
  if (!record) return null;
  await revokeSessionByHash(record.hash, workspace);
  return record;
}

/** Revoke every session, optionally keeping one id. Returns the revoked ids. */
export async function revokeAllSessions(keepId: string | null, workspace = resolveWorkspace()): Promise<string[]> {
  const all = await listSessions(workspace);
  const revoked: string[] = [];
  for (const record of all) {
    if (keepId && record.id === keepId) continue;
    if (await revokeSessionByHash(record.hash, workspace)) revoked.push(record.id);
  }
  return revoked;
}

/**
 * Re-key a session: same id/kind/label/createdAt/absExp, new token. The new file
 * is written BEFORE the old one is unlinked, so the session never disappears.
 */
export async function rotateSession(
  record: SessionRecord,
  workspace = resolveWorkspace(),
): Promise<{ token: string; record: SessionRecord }> {
  const token = randomToken(TOKEN_PREFIX, 32);
  const hash = sha256hex(token);
  const file: SessionFile = {
    v: 1,
    id: record.id,
    kind: record.kind,
    label: record.label,
    createdAt: record.createdAt,
    absExp: record.absExp,
    idleSecs: record.idleSecs,
    ownerEpoch: readOwnerEpoch(workspace),
    ...(record.ua ? { ua: record.ua } : {}),
    ...(record.ip ? { ip: record.ip } : {}),
  };
  ensurePrivateDir(sessionsDir(workspace));
  writeFileAtomic(fileForHash(hash, workspace), `${JSON.stringify(file)}\n`, 0o600);
  await revokeSessionByHash(record.hash, workspace);
  return { token, record: toRecord(file, hash, Date.now()) };
}

/** Test/diagnostic helper: the raw file names in the sessions dir. */
export function sessionFileNames(workspace = resolveWorkspace()): string[] {
  try {
    return fs.readdirSync(sessionsDir(workspace));
  } catch {
    return [];
  }
}
