import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { PROJECT_NAME_PATTERN } from './types';

export function resolveAuthToken(): string {
  return process.env.AUTH_TOKEN || '';
}

export function resolveWorkspace(): string {
  return process.env.WORKSPACE || '/workspace';
}

export function resolveShell(): string {
  return process.env.SHELL || 'bash';
}

export function getRelayRoot(workspace = resolveWorkspace()): string {
  return path.join(workspace, '.relay');
}

export function getRelayToolsRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'tools');
}

export function getRelayCacheRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'cache');
}

export function getRelayBinRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'bin');
}

export function getRelayStateRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'state');
}

export function getRelayMachineIdPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'machine-id');
}

export function getRelayHostnamePath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'hostname');
}

export function getRelayTerminalSessionsPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'terminal-sessions.json');
}

export function getRelayGitAuthPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'git-auth.json');
}

export function getProjectsRoot(): string {
  return path.join(resolveWorkspace(), 'projects');
}

/**
 * Absolute path to the relay-server repo's OWN root — the one directory the
 * version-control harness must NEVER touch. Resolved by walking UP from this module
 * until a directory holding the repo's `package.json` is found (robust to both
 * `src/relay-server/…` under ts-node and the compiled `dist/src/relay-server/…`
 * layout, where the depth differs). Falls back to two-levels-up if no marker is
 * found. Resolved (no symlinks/`..`) so comparisons are exact.
 */
let relayServerRepoRootCache: string | null = null;
export function getRelayServerRepoRoot(): string {
  if (relayServerRepoRootCache) return relayServerRepoRootCache;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) {
      relayServerRepoRootCache = path.resolve(dir);
      return relayServerRepoRootCache;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  relayServerRepoRootCache = path.resolve(__dirname, '..', '..');
  return relayServerRepoRootCache;
}

/**
 * Resolve a path to its REAL location (following symlinks) for scope checks. A
 * lexical `path.resolve` does NOT collapse symlinks, so a symlink planted UNDER the
 * projects root that points OUTSIDE it would pass a prefix check while actually
 * touching files elsewhere (e.g. the relay-server repo / /workspace). `fs.realpathSync`
 * collapses the link — but it throws when the path (or a parent) does not yet exist
 * (a project root being created), so we realpath the deepest EXISTING ancestor and
 * re-append the non-existent tail. The result is symlink-free for every segment that
 * actually exists on disk, which is what the scope guard needs.
 */
function realpathGuarded(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  // Walk up until we hit a path that exists, collecting the non-existent tail.
  for (;;) {
    try {
      const real = fsSync.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // reached root, nothing existed
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * HARD SAFETY GATE (RFC §9 / T11): throws unless `projectRoot` is a legitimate
 * MANAGED-PROJECT root — i.e. it lives STRICTLY under the projects root AND is not
 * the projects root, the workspace, a parent dir, or the relay-server repo itself.
 * Any harness operation that mutates files / runs git MUST call this first so the
 * pipeline can never `git add -A`/commit/reset the relay-server repo or /workspace.
 *
 * The scope check uses the REAL (symlink-resolved) path of BOTH the candidate and
 * the projects root, so a symlink under the projects root that points outside it
 * cannot bypass the lexical prefix check (T15 symlink-escape fix).
 */
export function assertSafeProjectRoot(projectRoot: string): void {
  const resolved = realpathGuarded(projectRoot);
  const projects = realpathGuarded(getProjectsRoot());
  const repo = realpathGuarded(getRelayServerRepoRoot());
  if (resolved === projects || !resolved.startsWith(`${projects}${path.sep}`)) {
    throw new Error(
      `[vc] REFUSING to operate on '${resolved}': not strictly under the projects root (${projects}). ` +
      `The version-control harness only ever touches managed projects under ${projects}.`,
    );
  }
  if (resolved === repo) {
    throw new Error(
      `[vc] REFUSING to operate on the relay-server repo itself (${repo}). ` +
      `The version-control harness must NEVER touch relay-server.`,
    );
  }
}

export function getFlutterRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'flutter');
}

export function getRelayBrowserPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayBinRoot(workspace), 'relay-browser');
}

export function getRelayChromePath(workspace = resolveWorkspace()): string {
  return path.join(getRelayBinRoot(workspace), 'relay-chrome');
}

export function getGeminiSettingsPath(workspace = resolveWorkspace()): string {
  return path.join(workspace, '.gemini', 'settings.json');
}

export function getNixPackagesRegistryPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'nix-packages.json');
}

export function getNixPackageProfilesRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'nix-profiles');
}

export function getNixPackageProfilePath(workspace: string, packageId: string): string {
  return path.join(getNixPackageProfilesRoot(workspace), packageId);
}

export function getSystemNixPlatform(): string {
  const arch = process.arch === 'x64'
    ? 'x86_64'
    : process.arch === 'arm64'
      ? 'aarch64'
      : process.arch;
  const platform = process.platform === 'linux'
    ? 'linux'
    : process.platform === 'darwin'
      ? 'darwin'
      : process.platform;
  return `${arch}-${platform}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createTerminalEnv(workspace: string): NodeJS.ProcessEnv {
  const relayRoot = getRelayRoot(workspace);
  const relayTools = getRelayToolsRoot(workspace);
  const relayCache = getRelayCacheRoot(workspace);
  const relayBin = getRelayBinRoot(workspace);
  const flutterRoot = getFlutterRoot(workspace);

  const relayMachineId = fsSync.existsSync(getRelayMachineIdPath(workspace))
    ? fsSync.readFileSync(getRelayMachineIdPath(workspace), 'utf8').trim()
    : '';
  const relayHostname = fsSync.existsSync(getRelayHostnamePath(workspace))
    ? fsSync.readFileSync(getRelayHostnamePath(workspace), 'utf8').trim()
    : '';

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace,
    RELAY_HOME: relayRoot,
    RELAY_TOOLS: relayTools,
    RELAY_CACHE: relayCache,
    RELAY_BIN: relayBin,
    RELAY_MACHINE_ID: relayMachineId,
    RELAY_HOSTNAME: relayHostname,
    HOSTNAME: relayHostname || process.env.HOSTNAME || '',
    MISE_DATA_DIR: path.join(relayTools, 'mise-data'),
    MISE_CONFIG_DIR: path.join(getRelayStateRoot(workspace), 'mise'),
    FLUTTER_HOME: flutterRoot,
    PUB_CACHE: path.join(relayCache, 'dart-pub'),
    npm_config_prefix: path.join(relayTools, 'npm-global'),
    npm_config_cache: path.join(relayCache, 'npm'),
    PIP_CACHE_DIR: path.join(relayCache, 'pip'),
    CARGO_HOME: path.join(relayCache, 'cargo'),
    RUSTUP_HOME: path.join(relayTools, 'rustup'),
    GOPATH: path.join(relayCache, 'go'),
    GOMODCACHE: path.join(relayCache, 'go', 'pkg', 'mod'),
    GRADLE_USER_HOME: path.join(relayCache, 'gradle'),
    ANDROID_SDK_ROOT: path.join(relayTools, 'android-sdk'),
    CHROME_EXECUTABLE: getRelayChromePath(workspace),
    CHROME_EXECUTABLE_PATH: getRelayChromePath(workspace),
    BROWSER: getRelayBrowserPath(workspace),
    RELAY_BROWSER: '1',
    RELAY_BROWSER_STATE_PATH: path.join(getRelayStateRoot(workspace), 'browser-url.txt'),
    // Never let git block the terminal on an interactive credential/askpass
    // prompt. The relay credential helper supplies auth non-interactively; if
    // it has nothing, git must FAIL FAST instead of hanging on a prompt that
    // no one can answer (which previously wedged the whole command channel).
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    PROMPT_COMMAND: '',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PATH: [
      path.join(relayTools, 'mise', 'bin'),
      relayBin,
      path.join(relayCache, 'go', 'bin'),
      path.join(relayCache, 'cargo', 'bin'),
      path.join(flutterRoot, 'bin'),
      path.join(relayTools, 'python-userbase', 'bin'),
      path.join(relayTools, 'npm-global', 'bin'),
      process.env.PATH || '',
    ].filter(Boolean).join(':'),
  };

  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('BASH_FUNC__vsc_')) {
      delete env[key];
    }
    // Railway injects RAILWAY_* vars describing THIS container (the relay-server
    // service in the WAWUAfrica project). The Railway CLI prioritises these over
    // its per-directory config, so they pin every `railway` command to WAWUAfrica
    // no matter which project a terminal/agent is working in. Strip them so the
    // CLI falls back to config-file linking and `railway link` works per project.
    if (key.startsWith('RAILWAY_')) {
      delete env[key];
    }
  }

  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;

  if (path.basename(resolveShell()).toLowerCase().includes('bash')) {
    env.PS1 = '\\[\\e]9;9;relay-prompt|$PWD|$?\\a\\]\\u@\\h:\\w\\$ ';
  }

  return env;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function extractRequestToken(req: Request): string {
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const headerValue = req.header('x-auth-token');
  const authorization = req.header('authorization');
  const bearerToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const cookieToken = (req.header('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('relay_auth_token='))
    ?.slice('relay_auth_token='.length) || '';

  return tokenFromQuery || headerValue || bearerToken || decodeURIComponent(cookieToken);
}

export function isValidToken(token: string): boolean {
  const expected = resolveAuthToken();
  return expected.length > 0 && token === expected;
}

export function readStringParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractRequestToken(req);
  if (!isValidToken(token)) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'A valid auth token is required.',
    });
    return;
  }

  if (typeof req.query.token === 'string') {
    const isSecureRequest = req.secure || req.header('x-forwarded-proto') === 'https';
    res.cookie('relay_auth_token', token, {
      httpOnly: true,
      sameSite: isSecureRequest ? 'none' : 'lax',
      secure: isSecureRequest,
      path: '/',
    });
  }

  next();
}

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  // PROJECT_NAME_PATTERN (/^[A-Za-z0-9._-]+$/) admits the path-traversal segments
  // "." and ".." (both are valid char sets), which path.join would resolve to the
  // projects root itself / its parent. Reject any name that is purely traversal
  // segments so resolveProjectRoot can never escape the projects dir.
  if (trimmed === '.' || trimmed === '..') return null;
  return PROJECT_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

export function resolveProjectRoot(projectId: string): string | null {
  const validName = validateProjectName(projectId);
  if (!validName) return null;
  const root = getProjectsRoot();
  const resolved = path.resolve(root, validName);
  // HARD SCOPE GUARD (RFC §9 / T11): a managed project root must live STRICTLY
  // UNDER the projects root. Reject anything that resolves to the projects root
  // itself or above it (defense-in-depth on top of the name check) so the pipeline
  // can never operate on /workspace, /workspace/projects, or a parent dir.
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export function resolveProjectRelativePath(projectRoot: string, relativePath: string): string | null {
  const resolved = path.resolve(projectRoot, relativePath.trim() || '.');
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectsRoot(): Promise<void> {
  await fs.mkdir(getProjectsRoot(), { recursive: true });
}

export async function ensureRelayStateRoot(): Promise<void> {
  await fs.mkdir(getRelayStateRoot(), { recursive: true });
}

export async function parseBootstrapStatus(): Promise<Record<string, string>> {
  const statusPath = path.join(resolveWorkspace(), '.bootstrap-status');
  if (!await exists(statusPath)) {
    return {};
  }

  const content = await fs.readFile(statusPath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.includes('='))
    .reduce<Record<string, string>>((acc, line) => {
      const [key, ...rest] = line.split('=');
      acc[key] = rest.join('=');
      return acc;
    }, {});
}

export async function readJsonFile<T>(targetPath: string, fallback: T): Promise<T> {
  if (!await exists(targetPath)) {
    return fallback;
  }

  try {
    return JSON.parse(await fs.readFile(targetPath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await ensureRelayStateRoot();
  await fs.writeFile(targetPath, `${JSON.stringify(value)}\n`, 'utf8');
}
