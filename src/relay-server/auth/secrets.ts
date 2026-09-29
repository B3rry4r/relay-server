/*
 * Process secrets + child-environment hygiene.
 *
 * Two layers, because relay-server spawns children in ~40 places (agents, PTYs,
 * git, Chrome, npm, flutter, python, cloudflared, …) and many of them inherit or
 * spread `process.env`:
 *
 *  1. `sealProcessSecrets()` (called once by the production entrypoint) MOVES the
 *     secret variables out of `process.env` into an in-memory vault. After that
 *     nothing that copies `process.env` can leak them. Readers go through
 *     `getSecret()`, which prefers a live `process.env` value (tests set them per
 *     case) and falls back to the vault.
 *  2. `sanitizeChildEnv()` strips the CONTRACTS §3 list from an explicit env
 *     (secrets + process-identity vars like PORT and every FLY_*). Used by
 *     `createTerminalEnv` (PTY shells and agent CLIs) and every spawn site that
 *     builds its own env.
 *
 * `/proc/1/environ` still holds the boot environment (the kernel keeps the
 * original block); that is why `AUTH_TOKEN_HASH` is the recommended form.
 */

/** Secret-bearing variables: never visible to any child process. */
export const SECRET_ENV_KEYS = [
  'AUTH_TOKEN',
  'AUTH_TOKEN_HASH',
  'RELAY_PTY_TOKEN',
  'RELAY_DEPLOY_TOKEN',
  'UIX_SERVICE_TOKEN',
  'RELAY_TOKEN',
] as const;
export type SecretEnvKey = typeof SECRET_ENV_KEYS[number];

/**
 * Relay-process identity variables. A shell or a user dev server that inherits
 * `PORT` binds relay's own port; the release/mode vars would make a child look
 * like a relay release to the host's process sweep.
 */
const PROCESS_ENV_KEYS = [
  'PORT',
  'RELAY_RELEASE_ID',
  'RELAY_START_MODE',
  'RELAY_SKIP_BOOTSTRAP',
  'RELAY_HOST_PORTS',
] as const;

export type ChildEnvProfile =
  /** Interactive PTY shells: the full CONTRACTS §3 strip list. */
  | 'shell'
  /** Agent CLIs and other relay-spawned tools: same, but RELAY_RELEASE_ID is
   *  kept so the host can sweep a dead release's descendants by tag. */
  | 'agent';

const vault = new Map<SecretEnvKey, string>();
let sealed = false;

/** Move every secret out of `process.env` into the in-memory vault. Idempotent. */
export function sealProcessSecrets(env: NodeJS.ProcessEnv = process.env): SecretEnvKey[] {
  const moved: SecretEnvKey[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string') {
      vault.set(key, value);
      delete env[key];
      moved.push(key);
    }
  }
  sealed = true;
  return moved;
}

export function areProcessSecretsSealed(): boolean {
  return sealed;
}

/** Read a secret: a live process.env value wins (tests), else the sealed vault. */
export function getSecret(key: SecretEnvKey): string {
  const live = process.env[key];
  if (typeof live === 'string' && live.length > 0) return live;
  return vault.get(key) ?? '';
}

/** Test helper: forget everything sealed. */
export function resetSecretsVaultForTests(): void {
  vault.clear();
  sealed = false;
}

/** Keys a child environment must never contain for the given profile. */
export function isStrippedChildEnvKey(key: string, profile: ChildEnvProfile = 'agent'): boolean {
  if ((SECRET_ENV_KEYS as readonly string[]).includes(key)) return true;
  if (key.startsWith('FLY_')) return true;
  if ((PROCESS_ENV_KEYS as readonly string[]).includes(key)) {
    return !(profile === 'agent' && key === 'RELAY_RELEASE_ID');
  }
  return false;
}

/** Return a COPY of `env` with every stripped key removed. */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  profile: ChildEnvProfile = 'agent',
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isStrippedChildEnvKey(key, profile)) continue;
    out[key] = value;
  }
  return out;
}

/** Sanitized copy of the current process env (+ overrides) for a spawn site. */
export function childProcessEnv(
  extra: NodeJS.ProcessEnv = {},
  profile: ChildEnvProfile = 'agent',
): NodeJS.ProcessEnv {
  return sanitizeChildEnv({ ...process.env, ...extra }, profile);
}
