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

export function getProjectsRoot(): string {
  return path.join(resolveWorkspace(), 'projects');
}

export function getFlutterRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'flutter');
}

export function getRelayBrowserPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayBinRoot(workspace), 'relay-browser');
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
    npm_config_cache: path.join(relayCache, 'npm'),
    PIP_CACHE_DIR: path.join(relayCache, 'pip'),
    CARGO_HOME: path.join(relayCache, 'cargo'),
    RUSTUP_HOME: path.join(relayTools, 'rustup'),
    GOPATH: path.join(relayCache, 'go'),
    GOMODCACHE: path.join(relayCache, 'go', 'pkg', 'mod'),
    GRADLE_USER_HOME: path.join(relayCache, 'gradle'),
    ANDROID_SDK_ROOT: path.join(relayTools, 'android-sdk'),
    CHROME_EXECUTABLE: process.env.CHROME_EXECUTABLE || process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome',
    NIX_CONFIG: `${process.env.NIX_CONFIG ? `${process.env.NIX_CONFIG}\n` : ''}experimental-features = nix-command flakes`,
    BROWSER: getRelayBrowserPath(workspace),
    RELAY_BROWSER: '1',
    RELAY_BROWSER_STATE_PATH: path.join(getRelayStateRoot(workspace), 'browser-url.txt'),
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
    res.cookie('relay_auth_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  }

  next();
}

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  return PROJECT_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

export function resolveProjectRoot(projectId: string): string | null {
  const validName = validateProjectName(projectId);
  return validName ? path.join(getProjectsRoot(), validName) : null;
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
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
