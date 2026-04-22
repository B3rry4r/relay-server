import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import express, { type Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

export type PtyLike = {
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit?(callback: (event: { exitCode: number; signal?: number }) => void): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
};

export type PtyFactory = (options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}) => PtyLike;

export type RelayServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  start(): Promise<number>;
  stop(): Promise<void>;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const RECENT_PROJECT_LIMIT = 10;
const execFile = promisify(execFileCallback);
const MANAGED_TOOL_IDS = ['php', 'python', 'go', 'rust', 'java', 'flutter'] as const;

type ManagedToolId = typeof MANAGED_TOOL_IDS[number];

type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
};

type PreviewRecord = {
  label: string;
  port: number;
  status: 'active' | 'inactive';
  url: string;
};

type GitFileEntry = {
  path: string;
  status: string;
};

type ActiveCommand = {
  command: string;
  commandId: string;
  startedAt: number;
};

type ShellTranscriptState = {
  activeCommand: ActiveCommand | null;
  currentCwd: string;
  inputBuffer: string;
  markerBuffer: string;
  nextCommandNumber: number;
};

const RELAY_PROMPT_MARKER_PREFIX = '\u001b]9;9;relay-prompt|';

function resolveAuthToken(): string {
  return process.env.AUTH_TOKEN || '';
}

function resolveWorkspace(): string {
  return process.env.WORKSPACE || '/workspace';
}

function resolveShell(): string {
  return process.env.SHELL || 'bash';
}

function getRelayRoot(workspace = resolveWorkspace()): string {
  return path.join(workspace, '.relay');
}

function getRelayToolsRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'tools');
}

function getRelayCacheRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'cache');
}

function getRelayBinRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'bin');
}

function getRelayStateRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayRoot(workspace), 'state');
}

function getFlutterRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'flutter');
}

function getRelayBrowserPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayBinRoot(workspace), 'relay-browser');
}

function getGeminiSettingsPath(workspace = resolveWorkspace()): string {
  return path.join(workspace, '.gemini', 'settings.json');
}

function getNixPackagesRegistryPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'nix-packages.json');
}

function getNixPackageProfilesRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'nix-profiles');
}

function getNixPackageProfilePath(workspace: string, packageId: string): string {
  return path.join(getNixPackageProfilesRoot(workspace), packageId);
}

function getSystemNixPlatform(): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createTerminalEnv(workspace: string): NodeJS.ProcessEnv {
  const relayRoot = getRelayRoot(workspace);
  const relayTools = getRelayToolsRoot(workspace);
  const relayCache = getRelayCacheRoot(workspace);
  const relayBin = getRelayBinRoot(workspace);
  const flutterRoot = getFlutterRoot(workspace);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace,
    RELAY_HOME: relayRoot,
    RELAY_TOOLS: relayTools,
    RELAY_CACHE: relayCache,
    RELAY_BIN: relayBin,
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
    NIX_CONFIG: `${process.env.NIX_CONFIG ? `${process.env.NIX_CONFIG}\n` : ''}experimental-features = nix-command flakes`,
    BROWSER: getRelayBrowserPath(workspace),
    RELAY_BROWSER: '1',
    RELAY_BROWSER_STATE_PATH: path.join(getRelayStateRoot(workspace), 'browser-url.txt'),
    PROMPT_COMMAND: '',
    TERM: process.env.TERM || 'xterm-256color',
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

  const shellName = path.basename(resolveShell()).toLowerCase();
  if (shellName.includes('bash')) {
    env.PS1 = '\\[\\e]9;9;relay-prompt|$PWD|$?\\a\\]\\u@\\h:\\w\\$ ';
  }

  return env;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createShellTranscriptState(workspace: string): ShellTranscriptState {
  return {
    activeCommand: null,
    currentCwd: workspace,
    inputBuffer: '',
    markerBuffer: '',
    nextCommandNumber: 1,
  };
}

function emitCommandOutput(
  socket: { emit(eventName: string, payload: Record<string, unknown>): void },
  state: ShellTranscriptState,
  chunk: string
): void {
  if (!state.activeCommand || chunk.length === 0) {
    return;
  }

  socket.emit('shell_event', {
    type: 'command_output',
    commandId: state.activeCommand.commandId,
    stream: 'stdout',
    chunk,
  });
}

function finishActiveCommand(
  socket: { emit(eventName: string, payload: Record<string, unknown>): void },
  state: ShellTranscriptState,
  exitCode: number
): void {
  if (!state.activeCommand) {
    return;
  }

  const finishedAt = Date.now();
  socket.emit('shell_event', {
    type: 'command_finished',
    commandId: state.activeCommand.commandId,
    exitCode,
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - state.activeCommand.startedAt,
  });
  state.activeCommand = null;
}

function handleTerminalInput(
  socket: { emit(eventName: string, payload: Record<string, unknown>): void },
  state: ShellTranscriptState,
  data: string
): void {
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      const command = state.inputBuffer.trim();
      state.inputBuffer = '';

      if (command.length > 0) {
        const commandId = `cmd-${state.nextCommandNumber++}`;
        state.activeCommand = {
          command,
          commandId,
          startedAt: Date.now(),
        };
        socket.emit('shell_event', {
          type: 'command_started',
          commandId,
          command,
          cwd: state.currentCwd,
          source: 'terminal',
          startedAt: new Date(state.activeCommand.startedAt).toISOString(),
        });
      }
      continue;
    }

    if (char === '\u0003') {
      state.inputBuffer = '';
      continue;
    }

    if (char === '\u007f' || char === '\b') {
      state.inputBuffer = state.inputBuffer.slice(0, -1);
      continue;
    }

    if (char >= ' ' && char !== '\u007f') {
      state.inputBuffer += char;
    }
  }
}

function handleShellOutput(
  socket: { emit(eventName: string, payload: Record<string, unknown>): void },
  state: ShellTranscriptState,
  data: string
): void {
  state.markerBuffer += data;

  while (state.markerBuffer.length > 0) {
    const markerIndex = state.markerBuffer.indexOf(RELAY_PROMPT_MARKER_PREFIX);
    if (markerIndex === -1) {
      const keepLength = Math.max(0, RELAY_PROMPT_MARKER_PREFIX.length - 1);
      const flushLength = Math.max(0, state.markerBuffer.length - keepLength);
      if (flushLength > 0) {
        emitCommandOutput(socket, state, state.markerBuffer.slice(0, flushLength));
        state.markerBuffer = state.markerBuffer.slice(flushLength);
      }
      break;
    }

    if (markerIndex > 0) {
      emitCommandOutput(socket, state, state.markerBuffer.slice(0, markerIndex));
      state.markerBuffer = state.markerBuffer.slice(markerIndex);
    }

    const markerEndIndex = state.markerBuffer.indexOf('\u0007');
    if (markerEndIndex === -1) {
      break;
    }

    const markerPayload = state.markerBuffer
      .slice(RELAY_PROMPT_MARKER_PREFIX.length, markerEndIndex);
    state.markerBuffer = state.markerBuffer.slice(markerEndIndex + 1);

    const separatorIndex = markerPayload.lastIndexOf('|');
    const cwd = separatorIndex >= 0
      ? markerPayload.slice(0, separatorIndex)
      : state.currentCwd;
    const exitCodeRaw = separatorIndex >= 0
      ? markerPayload.slice(separatorIndex + 1)
      : '0';
    const exitCode = Number.parseInt(exitCodeRaw, 10);

    finishActiveCommand(socket, state, Number.isNaN(exitCode) ? 0 : exitCode);

    if (cwd && cwd !== state.currentCwd) {
      state.currentCwd = cwd;
      socket.emit('shell_event', {
        type: 'cwd_changed',
        cwd,
      });
    }

    socket.emit('shell_event', {
      type: 'prompt',
      cwd: state.currentCwd,
      prompt: '',
    });
  }
}

function extractRequestToken(req: Request): string {
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const headerValue = req.header('x-auth-token');
  const authorization = req.header('authorization');
  const bearerToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  return tokenFromQuery || headerValue || bearerToken || '';
}

function isValidToken(token: string): boolean {
  const expected = resolveAuthToken();
  return expected.length > 0 && token === expected;
}

function readStringParam(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value;
  }

  return '';
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isValidToken(extractRequestToken(req))) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'A valid auth token is required.',
    });
    return;
  }

  next();
}

function getProjectsRoot(): string {
  return path.join(resolveWorkspace(), 'projects');
}

function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (!PROJECT_NAME_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function resolveProjectRoot(projectId: string): string | null {
  const validName = validateProjectName(projectId);
  if (!validName) {
    return null;
  }

  return path.join(getProjectsRoot(), validName);
}

function resolveProjectRelativePath(projectRoot: string, relativePath: string): string | null {
  const normalized = relativePath.trim();
  const resolved = path.resolve(projectRoot, normalized || '.');

  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    return null;
  }

  return resolved;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectsRoot(): Promise<void> {
  await fs.mkdir(getProjectsRoot(), { recursive: true });
}

async function ensureRelayStateRoot(): Promise<void> {
  await fs.mkdir(getRelayStateRoot(), { recursive: true });
}

async function parseBootstrapStatus(): Promise<Record<string, string>> {
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

async function readJsonFile<T>(targetPath: string, fallback: T): Promise<T> {
  if (!await exists(targetPath)) {
    return fallback;
  }

  try {
    const content = await fs.readFile(targetPath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await ensureRelayStateRoot();
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getCustomToolsRegistryPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'custom-tools.json');
}

async function readCustomTools(workspace = resolveWorkspace()): Promise<CustomToolRecord[]> {
  return readJsonFile<CustomToolRecord[]>(getCustomToolsRegistryPath(workspace), []);
}

async function writeCustomTools(workspace: string, tools: CustomToolRecord[]): Promise<void> {
  await writeJsonFile(getCustomToolsRegistryPath(workspace), tools);
}

async function readPackageJson(projectRoot: string): Promise<Record<string, unknown> | null> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  return readJsonFile<Record<string, unknown> | null>(packageJsonPath, null);
}

async function getRecentProjects(): Promise<string[]> {
  return readJsonFile<string[]>(path.join(getRelayStateRoot(), 'recent-projects.json'), []);
}

async function setRecentProjects(projectIds: string[]): Promise<void> {
  await writeJsonFile(path.join(getRelayStateRoot(), 'recent-projects.json'), projectIds);
}

async function markProjectAsRecent(projectId: string): Promise<void> {
  const recent = await getRecentProjects();
  const next = [projectId, ...recent.filter((value) => value !== projectId)].slice(0, RECENT_PROJECT_LIMIT);
  await setRecentProjects(next);
}

async function getPinnedProjects(): Promise<string[]> {
  return readJsonFile<string[]>(path.join(getRelayStateRoot(), 'pinned-projects.json'), []);
}

async function setPinnedProjects(projectIds: string[]): Promise<void> {
  await writeJsonFile(path.join(getRelayStateRoot(), 'pinned-projects.json'), projectIds);
}

async function scaffoldTemplate(projectRoot: string, template: string): Promise<void> {
  switch (template) {
    case 'blank':
      return;
    case 'node-api':
      await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'console.log("Relay node api");\n');
      await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
        name: path.basename(projectRoot),
        private: true,
        scripts: {
          dev: 'node src/index.js',
          test: 'echo "No tests yet"',
        },
      }, null, 2)}\n`);
      return;
    case 'next-app':
      await fs.mkdir(path.join(projectRoot, 'app'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'app', 'page.tsx'), 'export default function Page() { return <main>Relay Next App</main>; }\n');
      await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
        name: path.basename(projectRoot),
        private: true,
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
        },
      }, null, 2)}\n`);
      return;
    case 'python-api':
      await fs.mkdir(path.join(projectRoot, 'app'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'app', 'main.py'), 'print("Relay python api")\n');
      await fs.writeFile(path.join(projectRoot, 'requirements.txt'), 'fastapi\nuvicorn\n');
      return;
    case 'static-site':
      await fs.writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><body><h1>Relay Static Site</h1></body></html>\n');
      return;
    case 'cli-tool':
      await fs.mkdir(path.join(projectRoot, 'bin'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\nconsole.log("Relay CLI");\n');
      await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
        name: path.basename(projectRoot),
        private: true,
        bin: {
          [path.basename(projectRoot)]: './bin/cli.js',
        },
      }, null, 2)}\n`);
      return;
    default:
      return;
  }
}

async function inferTasks(projectRoot: string): Promise<Array<{ id: string; label: string; command: string }>> {
  const tasks: Array<{ id: string; label: string; command: string }> = [];
  const packageJson = await readPackageJson(projectRoot);

  if (packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts !== null) {
    const scripts = packageJson.scripts as Record<string, unknown>;
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === 'string' && ['dev', 'test', 'lint', 'build', 'migrate', 'seed', 'start'].includes(key)) {
        tasks.push({
          id: key,
          label: key,
          command: `npm run ${key}`,
        });
      }
    }
  }

  if (await exists(path.join(projectRoot, 'requirements.txt'))) {
    tasks.push({
      id: 'pip-install',
      label: 'install',
      command: 'pip install -r requirements.txt',
    });
  }

  return tasks;
}

async function inferSuggestions(projectRoot: string): Promise<Array<{ id: string; label: string; command: string }>> {
  const suggestions: Array<{ id: string; label: string; command: string }> = [];

  if (await exists(path.join(projectRoot, 'package.json'))) {
    suggestions.push(
      { id: 'npm-install', label: 'Install dependencies', command: 'npm install' },
      { id: 'npm-dev', label: 'Run dev server', command: 'npm run dev' },
    );
  }

  if (await exists(path.join(projectRoot, 'requirements.txt'))) {
    suggestions.push({
      id: 'pip-install',
      label: 'Install Python dependencies',
      command: 'pip install -r requirements.txt',
    });
  }

  if (await exists(path.join(projectRoot, '.git'))) {
    suggestions.push({
      id: 'git-status',
      label: 'Git status',
      command: 'git status',
    });
  }

  return suggestions;
}

async function readProjectNotes(projectRoot: string): Promise<string> {
  const notesPath = path.join(projectRoot, '.relay-notes.md');
  if (!await exists(notesPath)) {
    return '';
  }

  return fs.readFile(notesPath, 'utf8');
}

async function writeProjectNotes(projectRoot: string, content: string): Promise<void> {
  await fs.writeFile(path.join(projectRoot, '.relay-notes.md'), content, 'utf8');
}

async function duplicateItem(projectRoot: string, sourcePath: string, newName?: string): Promise<{ sourcePath: string; duplicatedPath: string }> {
  const sourceAbsolutePath = resolveProjectRelativePath(projectRoot, sourcePath);
  if (!sourceAbsolutePath) {
    throw new Error('invalid_path');
  }

  const stat = await fs.stat(sourceAbsolutePath);
  const destinationName = newName || `${path.basename(sourceAbsolutePath)}-copy`;
  const destinationAbsolutePath = path.join(path.dirname(sourceAbsolutePath), destinationName);

  if (stat.isDirectory()) {
    await fs.cp(sourceAbsolutePath, destinationAbsolutePath, { recursive: true });
  } else {
    await fs.copyFile(sourceAbsolutePath, destinationAbsolutePath);
  }

  return {
    sourcePath: path.relative(projectRoot, sourceAbsolutePath),
    duplicatedPath: path.relative(projectRoot, destinationAbsolutePath),
  };
}

async function listListeningPorts(): Promise<number[]> {
  try {
    const { stdout } = await execFile('sh', ['-c', 'ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null'], {
      cwd: process.cwd(),
      env: process.env,
    });

    const ports = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const address = parts[parts.length - 2] || parts[parts.length - 1] || '';
        const port = Number(address.split(':').pop());
        return Number.isInteger(port) ? port : null;
      })
      .filter((value): value is number => value !== null)
      .filter((port) => port > 0 && port !== 22);

    return Array.from(new Set(ports)).sort((left, right) => left - right);
  } catch {
    return [];
  }
}

type ManagedToolDefinition = {
  binary: string;
  category: 'package-manager' | 'language' | 'sdk';
  description: string;
  id: ManagedToolId;
  installMethod: 'git' | 'nix';
  name: string;
  nixPackage?: string;
  pathResolver: (workspace: string) => string;
  supported: boolean;
  versionArgs: string[];
};

type ManagedToolStatus = {
  category: ManagedToolDefinition['category'];
  description: string;
  id: ManagedToolId;
  kind: 'managed';
  installMethod: ManagedToolDefinition['installMethod'];
  installPath: string;
  installed: boolean;
  name: string;
  source: 'relay' | 'system' | 'unavailable';
  supported: boolean;
  version: string | null;
};

type CustomToolRecord = {
  binLinks: string[];
  binaryPath: string;
  description: string;
  id: string;
  installCommand: string;
  installPath: string;
  name: string;
  uninstallCommand?: string;
  versionCommand?: string;
};

type CustomToolStatus = {
  description: string;
  id: string;
  kind: 'custom';
  installMethod: 'custom';
  installPath: string;
  installed: boolean;
  name: string;
  source: 'relay' | 'unavailable';
  supported: true;
  version: string | null;
};

type NixPackageRecord = {
  binary: string;
  id: string;
  name: string;
  packageRef: string;
  profilePath: string;
  versionArgs?: string[];
};

type NixPackageStatus = {
  binary: string;
  id: string;
  kind: 'nix-package';
  installMethod: 'nix';
  installPath: string;
  installed: boolean;
  name: string;
  packageRef: string;
  source: 'relay' | 'unavailable';
  version: string | null;
};

function getManagedToolProfilesRoot(workspace = resolveWorkspace()): string {
  return path.join(getRelayToolsRoot(workspace), 'profiles');
}

function getManagedToolProfilePath(workspace: string, toolId: ManagedToolId): string {
  return path.join(getManagedToolProfilesRoot(workspace), toolId);
}

function getManagedToolLinkedBinaryPath(workspace: string, binary: string): string {
  return path.join(getRelayBinRoot(workspace), binary);
}

const MANAGED_TOOLS: Record<ManagedToolId, ManagedToolDefinition> = {
  php: {
    id: 'php',
    name: 'PHP',
    description: 'PHP runtime installed from nixpkgs into persistent Relay-managed profiles.',
    category: 'language',
    installMethod: 'nix',
    nixPackage: 'nixpkgs#php',
    binary: 'php',
    versionArgs: ['-v'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'php'),
  },
  python: {
    id: 'python',
    name: 'Python',
    description: 'Python runtime installed from nixpkgs into persistent Relay-managed profiles.',
    category: 'language',
    installMethod: 'nix',
    nixPackage: 'nixpkgs#python3',
    binary: 'python3',
    versionArgs: ['--version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'python3'),
  },
  go: {
    id: 'go',
    name: 'Go',
    description: 'Go toolchain installed from nixpkgs into persistent Relay-managed profiles.',
    category: 'language',
    installMethod: 'nix',
    nixPackage: 'nixpkgs#go',
    binary: 'go',
    versionArgs: ['version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'go'),
  },
  rust: {
    id: 'rust',
    name: 'Rust',
    description: 'Rust toolchain installed from nixpkgs into persistent Relay-managed profiles.',
    category: 'language',
    installMethod: 'nix',
    nixPackage: 'nixpkgs#rustc',
    binary: 'rustc',
    versionArgs: ['--version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'rustc'),
  },
  java: {
    id: 'java',
    name: 'OpenJDK',
    description: 'Java runtime installed from nixpkgs into persistent Relay-managed profiles.',
    category: 'language',
    installMethod: 'nix',
    nixPackage: 'nixpkgs#jdk',
    binary: 'java',
    versionArgs: ['-version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'java'),
  },
  flutter: {
    id: 'flutter',
    name: 'Flutter',
    description: 'Flutter SDK installed into the persistent Relay tool volume for web and CLI workflows.',
    category: 'sdk',
    installMethod: 'git',
    binary: 'flutter',
    versionArgs: ['--version'],
    supported: true,
    pathResolver: (workspace) => path.join(getFlutterRoot(workspace), 'bin', 'flutter'),
  },
};

function getManagedToolCatalog(workspace = resolveWorkspace()): Array<ManagedToolDefinition & { installPath: string }> {
  return MANAGED_TOOL_IDS.map((toolId) => {
    const tool = MANAGED_TOOLS[toolId];
    return {
      ...tool,
      installPath: tool.pathResolver(workspace),
    };
  });
}

async function runShellCommand(workspace: string, command: string): Promise<{ stdout: string; stderr: string }> {
  const shell = resolveShell();
  const args = ['-c', command];

  try {
    return await execFile(shell, args, {
      cwd: workspace,
      env: createTerminalEnv(workspace),
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch (error: any) {
    let message = error.message || 'Command failed';
    if (error.signal === 'SIGKILL') {
      message = `${message}\nProcess was killed (likely OOM or timeout).`;
    } else if (error.code) {
      message = `${message}\nExit code: ${error.code}`;
    }
    throw new Error(message);
  }
}

async function findCommandPath(workspace: string, command: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      resolveShell(),
      ['-c', `command -v ${command}`],
      {
        cwd: workspace,
        env: createTerminalEnv(workspace),
      }
    );
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function ensureNixAvailable(workspace: string): Promise<string> {
  const nixPath = await findCommandPath(workspace, 'nix');
  if (!nixPath) {
    throw new Error('nix_unavailable');
  }

  return nixPath;
}

async function ensureToolDirectories(workspace: string): Promise<void> {
  await Promise.all([
    fs.mkdir(getRelayRoot(workspace), { recursive: true }),
    fs.mkdir(getRelayToolsRoot(workspace), { recursive: true }),
    fs.mkdir(getManagedToolProfilesRoot(workspace), { recursive: true }),
    fs.mkdir(getNixPackageProfilesRoot(workspace), { recursive: true }),
    fs.mkdir(getRelayCacheRoot(workspace), { recursive: true }),
    fs.mkdir(getRelayBinRoot(workspace), { recursive: true }),
    fs.mkdir(getRelayStateRoot(workspace), { recursive: true }),
  ]);
}

function sanitizeToolId(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

async function getCustomToolStatus(workspace: string, tool: CustomToolRecord): Promise<CustomToolStatus> {
  const binaryExists = await exists(tool.binaryPath);
  let version: string | null = null;
  if (binaryExists && tool.versionCommand) {
    try {
      const { stdout, stderr } = await runShellCommand(workspace, tool.versionCommand);
      version = `${stdout}${stderr}`.trim().split('\n')[0] || null;
    } catch {
      version = null;
    }
  }

  return {
    id: tool.id,
    kind: 'custom',
    name: tool.name,
    description: tool.description,
    installMethod: 'custom',
    installPath: tool.installPath,
    installed: binaryExists,
    source: binaryExists ? 'relay' : 'unavailable',
    supported: true,
    version,
  };
}

async function listCustomToolStatuses(workspace = resolveWorkspace()): Promise<CustomToolStatus[]> {
  await ensureToolDirectories(workspace);
  const tools = await readCustomTools(workspace);
  return Promise.all(tools.map((tool) => getCustomToolStatus(workspace, tool)));
}

async function ensureRelayBrowserScript(workspace: string): Promise<void> {
  const browserPath = getRelayBrowserPath(workspace);
  const script = `#!/usr/bin/env bash
set -euo pipefail

URL="\${1:-}"
STATE_PATH="\${RELAY_BROWSER_STATE_PATH:-${path.join(getRelayStateRoot(workspace), 'browser-url.txt')}}"
mkdir -p "$(dirname "$STATE_PATH")"
printf '%s\n' "$URL" > "$STATE_PATH"
printf '[relay] Browser auth URL: %s\n' "$URL" >&2

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
fi
`;

  await fs.writeFile(browserPath, script, { mode: 0o755 });
}

async function ensureGeminiAuthSettings(workspace: string): Promise<void> {
  const settingsPath = getGeminiSettingsPath(workspace);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const current = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  const security = isRecord(current.security) ? current.security : {};
  const auth = isRecord(security.auth) ? security.auth : {};

  if (typeof auth.selectedType === 'string' && auth.selectedType.length > 0) {
    return;
  }

  await writeJsonFile(settingsPath, {
    ...current,
    security: {
      ...security,
      auth: {
        ...auth,
        selectedType: 'oauth-personal',
      },
    },
  });
}

async function ensureRelayRuntimeAssets(workspace: string): Promise<void> {
  await ensureToolDirectories(workspace);
  await Promise.all([
    ensureRelayBrowserScript(workspace),
    ensureGeminiAuthSettings(workspace),
  ]);
}

async function listManagedToolStatuses(workspace = resolveWorkspace()): Promise<ManagedToolStatus[]> {
  await ensureRelayRuntimeAssets(workspace);
  return Promise.all(getManagedToolCatalog(workspace).map(async (tool) => {
    const installPath = tool.pathResolver(workspace);
    const env = createTerminalEnv(workspace);
    const relayBinaryExists = await exists(installPath);
    const commandPath = relayBinaryExists ? installPath : tool.binary;

    try {
      const { stdout, stderr } = await execFile(commandPath, tool.versionArgs, {
        cwd: workspace,
        env,
      });
      const version = `${stdout}${stderr}`.trim().split('\n')[0] || null;
      const resolvedPath = relayBinaryExists
        ? installPath
        : await execFile('sh', ['-c', `command -v ${tool.binary}`], { cwd: workspace, env })
          .then((result) => result.stdout.trim())
          .catch(() => '');

      return {
        id: tool.id,
        kind: 'managed' as const,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        installMethod: tool.installMethod,
        installPath,
        installed: true,
        source: resolvedPath.startsWith(getRelayRoot(workspace)) ? 'relay' as const : 'system' as const,
        supported: tool.supported,
        version,
      };
    } catch {
      return {
        id: tool.id,
        kind: 'managed' as const,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        installMethod: tool.installMethod,
        installPath,
        installed: false,
        source: 'unavailable' as const,
        supported: tool.supported,
        version: null,
      };
    }
  }));
}

async function installManagedTool(workspace: string, toolId: ManagedToolId): Promise<ManagedToolStatus> {
  await ensureRelayRuntimeAssets(workspace);
  const tool = MANAGED_TOOLS[toolId];
  if (!tool || !tool.supported) {
    throw new Error('unsupported_tool');
  }

  if (tool.installMethod === 'git') {
    const flutterRoot = getFlutterRoot(workspace);
    if (await exists(flutterRoot)) {
      await runShellCommand(workspace, `git -C '${flutterRoot}' pull --ff-only`);
    } else {
      await runShellCommand(workspace, `git clone https://github.com/flutter/flutter.git -b stable '${flutterRoot}'`);
    }
    await runShellCommand(workspace, `'${path.join(flutterRoot, 'bin', 'flutter')}' config --enable-web`);
  } else if (tool.installMethod === 'nix') {
    await ensureNixAvailable(workspace);
    const profilePath = getManagedToolProfilePath(workspace, tool.id);
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await runShellCommand(workspace, `nix profile install --accept-flake-config --profile '${profilePath}' '${tool.nixPackage}'`);
    const sourceBinary = path.join(profilePath, 'bin', tool.binary);
    const targetBinary = getManagedToolLinkedBinaryPath(workspace, tool.binary);
    await fs.rm(targetBinary, { force: true });
    await fs.symlink(sourceBinary, targetBinary);
  }

  const statuses = await listManagedToolStatuses(workspace);
  return statuses.find((status) => status.id === toolId) ?? {
    id: tool.id,
    kind: 'managed',
    name: tool.name,
    description: tool.description,
    category: tool.category,
    installMethod: tool.installMethod,
    installPath: tool.pathResolver(workspace),
    installed: false,
    source: 'unavailable',
    supported: tool.supported,
    version: null,
  };
}

async function uninstallManagedTool(workspace: string, toolId: ManagedToolId): Promise<ManagedToolStatus> {
  await ensureRelayRuntimeAssets(workspace);
  const tool = MANAGED_TOOLS[toolId];
  if (!tool || !tool.supported) {
    throw new Error('unsupported_tool');
  }

  if (tool.installMethod === 'git') {
    await fs.rm(getFlutterRoot(workspace), { recursive: true, force: true });
  } else if (tool.installMethod === 'nix') {
    await fs.rm(getManagedToolProfilePath(workspace, tool.id), { recursive: true, force: true });
    await fs.rm(getManagedToolLinkedBinaryPath(workspace, tool.binary), { force: true });
  }

  const statuses = await listManagedToolStatuses(workspace);
  return statuses.find((status) => status.id === toolId) ?? {
    id: tool.id,
    kind: 'managed',
    name: tool.name,
    description: tool.description,
    category: tool.category,
    installMethod: tool.installMethod,
    installPath: tool.pathResolver(workspace),
    installed: false,
    source: 'unavailable',
    supported: tool.supported,
    version: null,
  };
}

async function readNixPackages(workspace = resolveWorkspace()): Promise<NixPackageRecord[]> {
  return readJsonFile<NixPackageRecord[]>(getNixPackagesRegistryPath(workspace), []);
}

async function writeNixPackages(workspace: string, packages: NixPackageRecord[]): Promise<void> {
  await writeJsonFile(getNixPackagesRegistryPath(workspace), packages);
}

async function getNixPackageStatus(workspace: string, pkg: NixPackageRecord): Promise<NixPackageStatus> {
  const installPath = path.join(getRelayBinRoot(workspace), pkg.binary);
  const installed = await exists(installPath);
  let version: string | null = null;

  if (installed) {
    try {
      const { stdout, stderr } = await execFile(installPath, pkg.versionArgs || ['--version'], {
        cwd: workspace,
        env: createTerminalEnv(workspace),
      });
      version = `${stdout}${stderr}`.trim().split('\n')[0] || null;
    } catch {
      version = null;
    }
  }

  return {
    id: pkg.id,
    kind: 'nix-package',
    name: pkg.name,
    binary: pkg.binary,
    packageRef: pkg.packageRef,
    installMethod: 'nix',
    installPath,
    installed,
    source: installed ? 'relay' : 'unavailable',
    version,
  };
}

async function listNixPackageStatuses(workspace = resolveWorkspace()): Promise<NixPackageStatus[]> {
  await ensureRelayRuntimeAssets(workspace);
  const packages = await readNixPackages(workspace);
  return Promise.all(packages.map((pkg) => getNixPackageStatus(workspace, pkg)));
}

function sanitizePackageRef(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._+/#:-]+$/.test(trimmed) ? trimmed : null;
}

function nixAttrToPackageRef(attr: string): string {
  const system = getSystemNixPlatform();
  const prefixes = [
    `legacyPackages.${system}.`,
    `packages.${system}.`,
  ];

  for (const prefix of prefixes) {
    if (attr.startsWith(prefix)) {
      return `nixpkgs#${attr.slice(prefix.length)}`;
    }
  }

  return `nixpkgs#${attr}`;
}

async function searchNixPackages(workspace: string, query: string): Promise<Array<{
  attr: string;
  description: string | null;
  name: string;
  packageRef: string;
  version: string | null;
}>> {
  await ensureRelayRuntimeAssets(workspace);
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    throw new Error('invalid_search_query');
  }

  const nixPath = await ensureNixAvailable(workspace);
  const { stdout } = await execFile(nixPath, ['search', 'nixpkgs', trimmed, '--json'], {
    cwd: workspace,
    env: createTerminalEnv(workspace),
    maxBuffer: 20 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
  return Object.entries(parsed)
    .map(([attr, meta]) => ({
      attr,
      name: typeof meta?.pname === 'string'
        ? meta.pname
        : typeof meta?.name === 'string'
          ? meta.name
          : attr.split('.').pop() || attr,
      description: typeof meta?.description === 'string' ? meta.description : null,
      version: typeof meta?.version === 'string' ? meta.version : null,
      packageRef: nixAttrToPackageRef(attr),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 25);
}

async function installNixPackage(
  workspace: string,
  input: { binary: string; id?: string; name?: string; packageRef: string; versionArgs?: string[] }
): Promise<NixPackageStatus> {
  await ensureRelayRuntimeAssets(workspace);
  const packageRef = sanitizePackageRef(input.packageRef);
  const binary = sanitizeToolId(input.binary);
  const packageId = sanitizeToolId(input.id || binary || input.packageRef.split('#').pop() || '');

  if (!packageRef || !binary || !packageId) {
    throw new Error('invalid_nix_package');
  }

  await ensureNixAvailable(workspace);
  const profilePath = getNixPackageProfilePath(workspace, packageId);
  const binPath = path.join(getRelayBinRoot(workspace), binary);

  await runShellCommand(
    workspace,
    `nix profile install --accept-flake-config --profile '${profilePath}' '${packageRef}'`
  );

  const sourceBinary = path.join(profilePath, 'bin', binary);
  if (!await exists(sourceBinary)) {
    throw new Error('nix_binary_not_found');
  }

  await fs.rm(binPath, { force: true });
  await fs.symlink(sourceBinary, binPath);

  const packages = await readNixPackages(workspace);
  const nextRecord: NixPackageRecord = {
    id: packageId,
    name: input.name?.trim() || binary,
    packageRef,
    binary,
    profilePath,
    ...(input.versionArgs?.length ? { versionArgs: input.versionArgs } : {}),
  };
  await writeNixPackages(workspace, [
    ...packages.filter((pkg) => pkg.id !== packageId),
    nextRecord,
  ]);

  return getNixPackageStatus(workspace, nextRecord);
}

async function uninstallNixPackage(workspace: string, toolId: string): Promise<NixPackageStatus> {
  await ensureRelayRuntimeAssets(workspace);
  const sanitizedId = sanitizeToolId(toolId);
  if (!sanitizedId) {
    throw new Error('invalid_nix_package');
  }

  const packages = await readNixPackages(workspace);
  const existing = packages.find((pkg) => pkg.id === sanitizedId);
  if (!existing) {
    throw new Error('nix_package_not_found');
  }

  await fs.rm(existing.profilePath, { recursive: true, force: true });
  await fs.rm(path.join(getRelayBinRoot(workspace), existing.binary), { force: true });
  await writeNixPackages(workspace, packages.filter((pkg) => pkg.id !== sanitizedId));

  return {
    id: existing.id,
    kind: 'nix-package',
    name: existing.name,
    binary: existing.binary,
    packageRef: existing.packageRef,
    installMethod: 'nix',
    installPath: path.join(getRelayBinRoot(workspace), existing.binary),
    installed: false,
    source: 'unavailable',
    version: null,
  };
}

async function installCustomTool(
  workspace: string,
  input: {
    binaryPath: string;
    description?: string;
    id: string;
    installCommand: string;
    installPath?: string;
    name: string;
    uninstallCommand?: string;
    versionCommand?: string;
  }
): Promise<CustomToolStatus> {
  await ensureToolDirectories(workspace);

  const toolId = sanitizeToolId(input.id);
  const name = input.name.trim();
  const installCommand = input.installCommand.trim();
  if (!toolId || !name || !installCommand) {
    throw new Error('invalid_custom_tool');
  }

  const installPath = input.installPath?.trim() || path.join(getRelayToolsRoot(workspace), toolId);
  const resolvedInstallPath = path.resolve(installPath);
  const resolvedToolsRoot = path.resolve(getRelayToolsRoot(workspace));
  if (resolvedInstallPath !== resolvedToolsRoot && !resolvedInstallPath.startsWith(`${resolvedToolsRoot}${path.sep}`)) {
    throw new Error('invalid_install_path');
  }

  const resolvedBinaryPath = path.resolve(
    input.binaryPath.trim() ? input.binaryPath : path.join(resolvedInstallPath, 'bin', toolId)
  );
  if (resolvedBinaryPath !== resolvedInstallPath && !resolvedBinaryPath.startsWith(`${resolvedInstallPath}${path.sep}`)) {
    throw new Error('invalid_binary_path');
  }

  const binLinks = Array.isArray((input as { binLinks?: unknown }).binLinks)
    ? ((input as { binLinks?: unknown[] }).binLinks || []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  await fs.mkdir(resolvedInstallPath, { recursive: true });
  await runShellCommand(workspace, `mkdir -p '${resolvedInstallPath}' && cd '${resolvedInstallPath}' && ${installCommand}`);

  for (const linkName of binLinks) {
    const sanitizedLink = sanitizeToolId(linkName);
    if (!sanitizedLink) {
      throw new Error('invalid_link_name');
    }
    const linkPath = path.join(getRelayBinRoot(workspace), sanitizedLink);
    await fs.rm(linkPath, { force: true });
    await fs.symlink(resolvedBinaryPath, linkPath);
  }

  const tools = await readCustomTools(workspace);
  const nextRecord: CustomToolRecord = {
    id: toolId,
    name,
    description: input.description?.trim() || 'Custom tool installed into persistent Relay-managed paths.',
    installCommand,
    installPath: resolvedInstallPath,
    binaryPath: resolvedBinaryPath,
    binLinks: binLinks.map((link) => sanitizeToolId(link)!).filter(Boolean),
    uninstallCommand: input.uninstallCommand?.trim() || undefined,
    versionCommand: input.versionCommand?.trim() || undefined,
  };
  await writeCustomTools(workspace, [...tools.filter((tool) => tool.id !== toolId), nextRecord]);
  return getCustomToolStatus(workspace, nextRecord);
}

async function uninstallCustomTool(workspace: string, toolId: string): Promise<CustomToolStatus> {
  const sanitizedId = sanitizeToolId(toolId);
  if (!sanitizedId) {
    throw new Error('invalid_custom_tool');
  }

  const tools = await readCustomTools(workspace);
  const existing = tools.find((tool) => tool.id === sanitizedId);
  if (!existing) {
    throw new Error('custom_tool_not_found');
  }

  if (existing.uninstallCommand) {
    await runShellCommand(workspace, existing.uninstallCommand);
  }

  await fs.rm(existing.installPath, { recursive: true, force: true });
  await Promise.all(existing.binLinks.map((linkName) => fs.rm(path.join(getRelayBinRoot(workspace), linkName), { force: true })));
  await writeCustomTools(workspace, tools.filter((tool) => tool.id !== sanitizedId));

  return {
    id: existing.id,
    kind: 'custom',
    name: existing.name,
    description: existing.description,
    installMethod: 'custom',
    installPath: existing.installPath,
    installed: false,
    source: 'unavailable',
    supported: true,
    version: null,
  };
}

async function getWorkspaceHealth(): Promise<{
  workspace: string;
  bootstrapped: boolean;
  relay: {
    bin: string;
    cache: string;
    root: string;
    state: string;
    tools: string;
  };
  managedTools: ManagedToolStatus[];
  customTools: CustomToolStatus[];
  nixPackages: NixPackageStatus[];
  status: Record<string, string>;
  toolchains: Record<string, string | boolean>;
  disk: { available: number | null; total: number | null };
  activePorts: number[];
}> {
  const workspace = resolveWorkspace();
  await ensureRelayRuntimeAssets(workspace);
  const status = await parseBootstrapStatus();
  const bootstrapped = await exists(path.join(workspace, '.bootstrapped'));
  const activePorts = await listListeningPorts();
  const [managedTools, customTools, nixPackages] = await Promise.all([
    listManagedToolStatuses(workspace),
    listCustomToolStatuses(workspace),
    listNixPackageStatuses(workspace),
  ]);

  const toolchains: Record<string, string | boolean> = {
    git: false,
    node: false,
  };

  try {
    const { stdout } = await execFile('git', ['--version'], { cwd: process.cwd(), env: process.env });
    toolchains.git = stdout.trim();
  } catch {
    toolchains.git = false;
  }

  try {
    const { stdout } = await execFile('node', ['-v'], { cwd: process.cwd(), env: process.env });
    toolchains.node = stdout.trim();
  } catch {
    toolchains.node = false;
  }

  let disk = { available: null as number | null, total: null as number | null };
  try {
    const { stdout } = await execFile('sh', ['-c', `df -k "${workspace}" | tail -n 1`], { cwd: process.cwd(), env: process.env });
    const parts = stdout.trim().split(/\s+/);
    disk = {
      total: Number(parts[1]) * 1024 || null,
      available: Number(parts[3]) * 1024 || null,
    };
  } catch {
    disk = { available: null, total: null };
  }

  return {
    workspace,
    bootstrapped,
    relay: {
      root: getRelayRoot(workspace),
      tools: getRelayToolsRoot(workspace),
      cache: getRelayCacheRoot(workspace),
      bin: getRelayBinRoot(workspace),
      state: getRelayStateRoot(workspace),
    },
    managedTools,
    customTools,
    nixPackages,
    status,
    toolchains,
    disk,
    activePorts,
  };
}

function parseCommandResult(command: string, output: string): {
  type: string;
  summary: string;
  details?: Record<string, unknown>;
} {
  if (command.startsWith('git status')) {
    const lines = output.split('\n');
    const branchLine = lines.find((line) => line.startsWith('On branch '));
    const clean = output.includes('working tree clean');
    return {
      type: 'git-status',
      summary: clean ? 'Working tree clean' : 'Working tree has changes',
      details: {
        branch: branchLine?.replace('On branch ', '') || null,
        clean,
      },
    };
  }

  if (command.startsWith('npm install')) {
    const addedMatch = output.match(/added (\d+) packages?/);
    return {
      type: 'npm-install',
      summary: addedMatch ? `Added ${addedMatch[1]} packages` : 'npm install completed',
      details: {
        addedPackages: addedMatch ? Number(addedMatch[1]) : null,
      },
    };
  }

  if (command.includes('test')) {
    const passed = output.match(/(\d+)\s+passed/);
    const failed = output.match(/(\d+)\s+failed/);
    return {
      type: 'test-results',
      summary: failed ? 'Tests failed' : 'Tests passed',
      details: {
        passed: passed ? Number(passed[1]) : 0,
        failed: failed ? Number(failed[1]) : 0,
      },
    };
  }

  return {
    type: 'raw',
    summary: 'No structured parser available',
  };
}

async function buildQuickSwitchProjects(): Promise<Array<{
  id: string;
  name: string;
  path: string;
  pinned: boolean;
  recent: boolean;
}>> {
  const [projects, recentProjects, pinnedProjects] = await Promise.all([
    listProjects(),
    getRecentProjects(),
    getPinnedProjects(),
  ]);

  const recentSet = new Set(recentProjects);
  const pinnedSet = new Set(pinnedProjects);

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    pinned: pinnedSet.has(project.id),
    recent: recentSet.has(project.id),
  })).sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    if (left.recent !== right.recent) {
      return left.recent ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

async function runGit(projectRoot: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

async function ensureGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function initializeGitRepository(projectRoot: string): Promise<void> {
  try {
    await runGit(projectRoot, ['init', '-b', 'main']);
    return;
  } catch {
    await runGit(projectRoot, ['init']);
  }
}

function normalizeGitStatus(code: string): string {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'updated';
    default:
      return 'unknown';
  }
}

async function getGitStatus(projectRoot: string): Promise<{
  branch: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: Array<{ path: string }>;
  conflicts: GitFileEntry[];
}> {
  const { stdout } = await runGit(projectRoot, ['status', '--porcelain=v1', '--branch']);
  const lines = stdout.split('\n').filter(Boolean);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];
  const untracked: Array<{ path: string }> = [];
  const conflicts: GitFileEntry[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const branchInfo = line.slice(3);
      const noCommitsMatch = branchInfo.match(/^No commits yet on (.+)$/);
      const initialCommitMatch = branchInfo.match(/^Initial commit on (.+)$/);
      const branchMatch = branchInfo.match(/^([^.\s]+)(?:\.\.\.)?/);
      branch = noCommitsMatch
        ? noCommitsMatch[1]
        : initialCommitMatch
          ? initialCommitMatch[1]
          : branchMatch
            ? branchMatch[1]
            : branchInfo;
      const aheadMatch = branchInfo.match(/ahead (\d+)/);
      const behindMatch = branchInfo.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }

    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3).split(' -> ').pop() || line.slice(3);

    if (x === '?' && y === '?') {
      untracked.push({ path: filePath });
      continue;
    }

    if ('UAD'.includes(x) && 'UAD'.includes(y) && x === y || x === 'U' || y === 'U') {
      conflicts.push({
        path: filePath,
        status: 'conflict',
      });
      continue;
    }

    if (x !== ' ' && x !== '?') {
      staged.push({
        path: filePath,
        status: normalizeGitStatus(x),
      });
    }

    if (y !== ' ' && y !== '?') {
      unstaged.push({
        path: filePath,
        status: normalizeGitStatus(y),
      });
    }
  }

  return {
    branch,
    ahead,
    behind,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicts.length === 0,
    staged,
    unstaged,
    untracked,
    conflicts,
  };
}

async function getGitBranches(projectRoot: string): Promise<{ current: string | null; branches: string[] }> {
  const [currentBranch, branchList] = await Promise.all([
    runGit(projectRoot, ['branch', '--show-current']),
    runGit(projectRoot, ['branch', '--format=%(refname:short)']),
  ]);

  return {
    current: currentBranch.stdout.trim() || null,
    branches: branchList.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

function createGitHttpEnv(auth?: { username?: string; token?: string; password?: string }): NodeJS.ProcessEnv {
  if (!auth?.token && !auth?.password) {
    return {};
  }

  const username = auth.username || 'git';
  const secret = auth.token || auth.password || '';
  const authHeader = Buffer.from(`${username}:${secret}`).toString('base64');

  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${authHeader}`,
  };
}

async function listProjects(): Promise<Array<{
  id: string;
  name: string;
  path: string;
  lastModifiedAt: string;
  gitInitialized: boolean;
}>> {
  await ensureProjectsRoot();
  const entries = await fs.readdir(getProjectsRoot(), { withFileTypes: true });

  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const projectPath = path.join(getProjectsRoot(), entry.name);
      const stat = await fs.stat(projectPath);
      return {
        id: entry.name,
        name: entry.name,
        path: projectPath,
        lastModifiedAt: stat.mtime.toISOString(),
        gitInitialized: await ensureGitRepo(projectPath),
      };
    }));

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function buildTree(projectRoot: string, relativePath = '', depth = 2): Promise<TreeNode[]> {
  const targetPath = resolveProjectRelativePath(projectRoot, relativePath);
  if (!targetPath) {
    return [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const nodes = await Promise.all(entries.map(async (entry) => {
    const entryAbsolutePath = path.join(targetPath, entry.name);
    const entryRelativePath = path.relative(projectRoot, entryAbsolutePath) || entry.name;
    if (entry.isDirectory()) {
      const node: TreeNode = {
        name: entry.name,
        path: entryRelativePath,
        type: 'directory',
      };

      if (depth > 1) {
        const children = await buildTree(projectRoot, entryRelativePath, depth - 1);
        return [node, ...children];
      }

      return [node];
    }

    const stat = await fs.stat(entryAbsolutePath);
    return [{
      name: entry.name,
      path: entryRelativePath,
      type: 'file' as const,
      size: stat.size,
    }];
  }));

  return nodes.flat().sort((left, right) => left.path.localeCompare(right.path));
}

export function defaultPtyFactory(options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}): PtyLike {
  // Delayed require keeps tests free from loading the native module when mocked.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePty = require('node-pty') as {
    spawn(
      file: string,
      args: string[],
      options: {
        cols: number;
        cwd: string;
        env: NodeJS.ProcessEnv;
        name: string;
        rows: number;
      }
    ): PtyLike;
  };
  return nodePty.spawn(options.command, [], {
    cols: options.cols,
    cwd: options.cwd,
    env: options.env,
    name: 'xterm-color',
    rows: options.rows,
  });
}

export function createRelayServer(ptyFactory: PtyFactory = defaultPtyFactory): RelayServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });
  const activeShells = new Map<string, PtyLike>();

  app.use(cors());
  app.use(express.json());
  app.get('/', (req, res) => {
    res.json({
      name: 'Relay',
      service: 'terminal-backend',
      status: 'ok',
      transport: {
        httpAuthHeader: 'x-auth-token',
        socketAuthField: 'auth.token',
        socketPath: '/socket.io',
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/auth/validate', (req, res) => {
    if (!isValidToken(extractRequestToken(req))) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'A valid auth token is required.',
      });
      return;
    }

    res.json({ authenticated: true });
  });

  app.get('/api/bootstrap/status', requireAuth, async (_req, res) => {
    const health = await getWorkspaceHealth();
    res.json(health);
  });

  app.get('/api/projects', requireAuth, async (_req, res) => {
    res.json({
      projects: await listProjects(),
    });
  });

  app.post('/api/projects', requireAuth, async (req, res) => {
    const projectName = validateProjectName(String(req.body?.name || ''));
    if (!projectName) {
      res.status(400).json({
        error: 'invalid_project_name',
        message: 'Project names may only contain letters, numbers, hyphens, underscores, and periods.',
      });
      return;
    }

    const projectPath = path.join(getProjectsRoot(), projectName);
    if (await exists(projectPath)) {
      res.status(409).json({
        error: 'project_exists',
        message: 'A project with this name already exists.',
      });
      return;
    }

    await fs.mkdir(projectPath, { recursive: true });
    await scaffoldTemplate(projectPath, String(req.body?.template || 'blank'));

    if (req.body?.initializeGit === true) {
      try {
        await initializeGitRepository(projectPath);
      } catch (error) {
        await fs.rm(projectPath, { recursive: true, force: true });
        res.status(500).json({
          error: 'git_init_failed',
          message: error instanceof Error ? error.message : 'Git initialization failed.',
        });
        return;
      }
    }

    res.status(201).json({
      project: {
        id: projectName,
        name: projectName,
        path: projectPath,
        gitInitialized: req.body?.initializeGit === true,
      },
    });
  });

  app.get('/api/projects/quick-switch', requireAuth, async (_req, res) => {
    res.json({
      projects: await buildQuickSwitchProjects(),
    });
  });

  app.post('/api/projects/:projectId/pin', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const pinned = Boolean(req.body?.pinned);
    const current = await getPinnedProjects();
    const next = pinned
      ? Array.from(new Set([...current, projectId]))
      : current.filter((value) => value !== projectId);
    await setPinnedProjects(next);

    res.json({
      projectId,
      pinned,
    });
  });

  app.get('/api/projects/:projectId/tree', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({
        error: 'project_not_found',
        message: 'Project not found.',
      });
      return;
    }

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    const depth = Number.isInteger(Number(req.query.depth)) ? Number(req.query.depth) : 2;

    res.json({
      project: {
        id: projectId,
        path: projectRoot,
      },
      tree: await buildTree(projectRoot, requestedPath, Math.max(depth, 1)),
    });
  });

  app.post('/api/projects/:projectId/files', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'File name is required.' });
      return;
    }

    const parentPath = String(req.body?.parentPath || '');
    const parentAbsolutePath = resolveProjectRelativePath(projectRoot, parentPath);
    if (!parentAbsolutePath) {
      res.status(400).json({ error: 'invalid_path', message: 'Parent path is invalid.' });
      return;
    }

    await fs.mkdir(parentAbsolutePath, { recursive: true });
    const targetPath = path.join(parentAbsolutePath, name);
    await fs.writeFile(targetPath, String(req.body?.contents || ''), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('File already exists.'), { statusCode: 409, code: 'file_exists' });
      }

      throw error;
    });

    res.status(201).json({
      created: {
        type: 'file',
        path: path.relative(projectRoot, targetPath),
      },
    });
  });

  app.post('/api/projects/:projectId/folders', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'Folder name is required.' });
      return;
    }

    const parentPath = String(req.body?.parentPath || '');
    const parentAbsolutePath = resolveProjectRelativePath(projectRoot, parentPath);
    if (!parentAbsolutePath) {
      res.status(400).json({ error: 'invalid_path', message: 'Parent path is invalid.' });
      return;
    }

    const targetPath = path.join(parentAbsolutePath, name);
    if (await exists(targetPath)) {
      res.status(409).json({ error: 'folder_exists', message: 'Folder already exists.' });
      return;
    }

    await fs.mkdir(targetPath, { recursive: true });
    res.status(201).json({
      created: {
        type: 'directory',
        path: path.relative(projectRoot, targetPath),
      },
    });
  });

  app.post('/api/projects/:projectId/duplicate', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const sourcePath = String(req.body?.path || '');
    if (!sourcePath) {
      res.status(400).json({ error: 'invalid_path', message: 'Path is required.' });
      return;
    }

    try {
      const duplicated = await duplicateItem(projectRoot, sourcePath, typeof req.body?.newName === 'string' ? req.body.newName : undefined);
      res.status(201).json({ duplicated });
    } catch {
      res.status(400).json({ error: 'invalid_path', message: 'Path is invalid.' });
    }
  });

  app.patch('/api/projects/:projectId/rename', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const currentPath = resolveProjectRelativePath(projectRoot, String(req.body?.path || ''));
    const newName = String(req.body?.newName || '').trim();
    if (!currentPath || !newName) {
      res.status(400).json({ error: 'invalid_request', message: 'Path and newName are required.' });
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), newName);
    await fs.rename(currentPath, nextPath);

    res.json({
      updated: {
        oldPath: path.relative(projectRoot, currentPath),
        newPath: path.relative(projectRoot, nextPath),
      },
    });
  });

  app.delete('/api/projects/:projectId/items', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const itemPath = resolveProjectRelativePath(projectRoot, String(req.body?.path || ''));
    if (!itemPath) {
      res.status(400).json({ error: 'invalid_path', message: 'Path is invalid.' });
      return;
    }

    await fs.rm(itemPath, { recursive: Boolean(req.body?.recursive), force: false });
    res.json({
      deleted: {
        path: path.relative(projectRoot, itemPath),
      },
    });
  });

  app.get('/api/projects/:projectId/download', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const itemPath = resolveProjectRelativePath(projectRoot, String(req.query.path || ''));
    if (!itemPath || !await exists(itemPath)) {
      res.status(404).json({ error: 'file_not_found', message: 'File not found.' });
      return;
    }

    res.download(itemPath);
  });

  app.post('/api/projects/:projectId/upload', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const parentPath = resolveProjectRelativePath(projectRoot, String(req.body?.parentPath || ''));
    const name = String(req.body?.name || '').trim();
    const contentBase64 = String(req.body?.contentBase64 || '');

    if (!parentPath || !name) {
      res.status(400).json({ error: 'invalid_request', message: 'parentPath and name are required.' });
      return;
    }

    const targetPath = path.join(parentPath, name);
    await fs.mkdir(parentPath, { recursive: true });
    await fs.writeFile(targetPath, Buffer.from(contentBase64, 'base64'));

    res.status(201).json({
      uploaded: {
        path: path.relative(projectRoot, targetPath),
      },
    });
  });

  app.get('/api/projects/:projectId/notes', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    res.json({
      content: await readProjectNotes(projectRoot),
    });
  });

  app.put('/api/projects/:projectId/notes', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const content = String(req.body?.content || '');
    await writeProjectNotes(projectRoot, content);
    res.json({ content });
  });

  app.get('/api/projects/:projectId/tasks', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    res.json({
      tasks: await inferTasks(projectRoot),
    });
  });

  app.get('/api/projects/:projectId/suggestions', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    res.json({
      suggestions: await inferSuggestions(projectRoot),
    });
  });

  app.post('/api/projects/clone', requireAuth, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    const requestedName = String(req.body?.name || '').trim();
    const branch = String(req.body?.branch || '').trim();
    const provider = String(req.body?.provider || 'url');

    if (!url) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'url is required.',
      });
      return;
    }

    if (provider !== 'url') {
      res.status(400).json({
        error: 'unsupported_provider',
        message: 'Only provider=url is currently supported.',
      });
      return;
    }

    const inferredName = requestedName || path.basename(url, '.git');
    const projectName = validateProjectName(inferredName);
    if (!projectName) {
      res.status(400).json({
        error: 'invalid_project_name',
        message: 'Project names may only contain letters, numbers, hyphens, underscores, and periods.',
      });
      return;
    }

    await ensureProjectsRoot();
    const projectPath = path.join(getProjectsRoot(), projectName);
    if (await exists(projectPath)) {
      res.status(409).json({
        error: 'project_exists',
        message: 'A project with this name already exists.',
      });
      return;
    }

    const authEnv = createGitHttpEnv(req.body?.auth);
    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push(url, projectPath);

    try {
      await runGit(process.cwd(), args, authEnv);
      res.status(201).json({
        project: {
          id: projectName,
          name: projectName,
          path: projectPath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clone failed.';
      res.status(400).json({
        error: 'git_clone_failed',
        message,
      });
    }
  });

  app.post('/api/projects/:projectId/git/init', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    try {
      await initializeGitRepository(projectRoot);
      const status = await getGitStatus(projectRoot);
      res.status(200).json({
        ok: true,
        project: {
          id: projectId,
          path: projectRoot,
          gitInitialized: true,
        },
        git: status,
      });
    } catch (error) {
      res.status(500).json({
        error: 'git_init_failed',
        message: error instanceof Error ? error.message : 'Git initialization failed.',
      });
    }
  });

  app.post('/api/session/project', requireAuth, async (req, res) => {
    const projectId = String(req.body?.projectId || '');
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    await markProjectAsRecent(projectId);

    res.json({
      project: {
        id: path.basename(projectRoot),
        path: projectRoot,
      },
      shell: {
        cwd: projectRoot,
        suggestedCommand: `cd ${projectRoot}`,
      },
    });
  });

  app.get('/api/previews', requireAuth, async (_req, res) => {
    const ports = await listListeningPorts();
    res.json({
      previews: ports.map((port) => ({
        port,
        label: `Port ${port}`,
        url: `/preview/${port}`,
        status: 'active',
      })),
    });
  });

  app.get('/api/workspace/health', requireAuth, async (_req, res) => {
    res.json(await getWorkspaceHealth());
  });

  app.get('/api/tools/catalog', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    await ensureRelayRuntimeAssets(workspace);
    res.json({
      tools: getManagedToolCatalog(workspace).map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        installMethod: tool.installMethod,
        installPath: tool.installPath,
        supported: tool.supported,
      })),
      customToolSupport: {
        installRoot: getRelayToolsRoot(workspace),
        binRoot: getRelayBinRoot(workspace),
        statePath: getCustomToolsRegistryPath(workspace),
      },
      nixSupport: {
        installRoot: getNixPackageProfilesRoot(workspace),
        statePath: getNixPackagesRegistryPath(workspace),
        searchEndpoint: '/api/tools/nix/search',
        installEndpoint: '/api/tools/nix/install',
      },
    });
  });

  app.get('/api/tools', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    res.json({
      managedTools: await listManagedToolStatuses(workspace),
      customTools: await listCustomToolStatuses(workspace),
      nixPackages: await listNixPackageStatuses(workspace),
    });
  });

  app.get('/api/tools/nix/search', requireAuth, async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';

    try {
      const results = await searchNixPackages(resolveWorkspace(), query);
      res.json({
        query,
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix search failed.';
      const statusCode = message === 'invalid_search_query'
        ? 400
        : message === 'nix_unavailable'
          ? 503
          : 500;
      res.status(statusCode).json({
        error: statusCode === 400
          ? 'invalid_search_query'
          : statusCode === 503
            ? 'nix_unavailable'
            : 'nix_search_failed',
        message: statusCode === 400
          ? 'Search query must be at least 2 characters.'
          : statusCode === 503
            ? 'Nix is not installed in the Relay runtime.'
            : message,
      });
    }
  });

  app.post('/api/tools/nix/install', requireAuth, async (req, res) => {
    try {
      const tool = await installNixPackage(resolveWorkspace(), {
        id: typeof req.body?.id === 'string' ? req.body.id : undefined,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        packageRef: String(req.body?.packageRef || ''),
        binary: String(req.body?.binary || ''),
        versionArgs: Array.isArray(req.body?.versionArgs)
          ? req.body.versionArgs.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          : undefined,
      });
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix install failed.';
      const statusCode = ['invalid_nix_package', 'nix_binary_not_found'].includes(message)
        ? 400
        : message === 'nix_unavailable'
          ? 503
          : 500;
      res.status(statusCode).json({
        error: statusCode === 400
          ? message
          : statusCode === 503
            ? 'nix_unavailable'
            : 'nix_install_failed',
        message: statusCode === 400
          ? message === 'nix_binary_not_found'
            ? 'Installed package does not provide the requested binary.'
            : 'Nix package request is invalid.'
          : statusCode === 503
            ? 'Nix is not installed in the Relay runtime.'
          : message,
      });
    }
  });

  app.post('/api/tools/nix/uninstall', requireAuth, async (req, res) => {
    try {
      const tool = await uninstallNixPackage(resolveWorkspace(), String(req.body?.tool || ''));
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix uninstall failed.';
      const statusCode = ['invalid_nix_package', 'nix_package_not_found'].includes(message) ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : 'nix_uninstall_failed',
        message: statusCode === 400
          ? message === 'nix_package_not_found'
            ? 'Installed nix package not found.'
            : 'Nix package request is invalid.'
          : message,
      });
    }
  });

  app.post('/api/tools/install', requireAuth, async (req, res) => {
    const toolId = String(req.body?.tool || '') as ManagedToolId;
    if (!MANAGED_TOOL_IDS.includes(toolId)) {
      res.status(400).json({
        error: 'unsupported_tool',
        message: 'The requested tool is not supported.',
      });
      return;
    }

    try {
      const tool = await installManagedTool(resolveWorkspace(), toolId);
      res.status(200).json({
        ok: true,
        tool,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool installation failed.';
      const statusCode = message === 'unsupported_tool' ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? 'unsupported_tool' : 'tool_install_failed',
        message: statusCode === 400 ? 'The requested tool is not supported.' : message,
      });
    }
  });

  app.post('/api/tools/uninstall', requireAuth, async (req, res) => {
    const toolId = String(req.body?.tool || '') as ManagedToolId;
    if (!MANAGED_TOOL_IDS.includes(toolId)) {
      res.status(400).json({
        error: 'unsupported_tool',
        message: 'The requested tool is not supported.',
      });
      return;
    }

    try {
      const tool = await uninstallManagedTool(resolveWorkspace(), toolId);
      res.status(200).json({
        ok: true,
        tool,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool removal failed.';
      const statusCode = message === 'unsupported_tool' ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? 'unsupported_tool' : 'tool_uninstall_failed',
        message: statusCode === 400 ? 'The requested tool is not supported.' : message,
      });
    }
  });

  app.post('/api/tools/custom/install', requireAuth, async (req, res) => {
    try {
      const tool = await installCustomTool(resolveWorkspace(), {
        id: String(req.body?.id || ''),
        name: String(req.body?.name || ''),
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
        installCommand: String(req.body?.installCommand || ''),
        installPath: typeof req.body?.installPath === 'string' ? req.body.installPath : undefined,
        binaryPath: String(req.body?.binaryPath || ''),
        uninstallCommand: typeof req.body?.uninstallCommand === 'string' ? req.body.uninstallCommand : undefined,
        versionCommand: typeof req.body?.versionCommand === 'string' ? req.body.versionCommand : undefined,
        ...(Array.isArray(req.body?.binLinks) ? { binLinks: req.body.binLinks } : {}),
      });
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Custom tool installation failed.';
      const statusCode = ['invalid_custom_tool', 'invalid_install_path', 'invalid_binary_path', 'invalid_link_name'].includes(message) ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : 'custom_tool_install_failed',
        message: statusCode === 400
          ? 'Custom tool request is invalid.'
          : message,
      });
    }
  });

  app.post('/api/tools/custom/uninstall', requireAuth, async (req, res) => {
    try {
      const tool = await uninstallCustomTool(resolveWorkspace(), String(req.body?.tool || ''));
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Custom tool removal failed.';
      const statusCode = ['invalid_custom_tool', 'custom_tool_not_found'].includes(message) ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : 'custom_tool_uninstall_failed',
        message: statusCode === 400
          ? message === 'custom_tool_not_found'
            ? 'Custom tool not found.'
            : 'Custom tool request is invalid.'
          : message,
      });
    }
  });

  app.post('/api/command-results/parse', requireAuth, async (req, res) => {
    const command = String(req.body?.command || '');
    const output = String(req.body?.output || '');

    res.json({
      result: parseCommandResult(command, output),
    });
  });

  app.get('/api/projects/:projectId/git/status', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    res.json(await getGitStatus(projectRoot));
  });

  app.get('/api/projects/:projectId/git/diff', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    const staged = String(req.query.staged || 'false') === 'true';
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    const args = ['diff'];
    if (staged) {
      args.push('--cached');
    }
    if (filePath) {
      args.push('--', filePath);
    }

    const { stdout } = await runGit(projectRoot, args);
    res.json({ diff: stdout });
  });

  app.get('/api/projects/:projectId/git/branches', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    res.json(await getGitBranches(projectRoot));
  });

  app.post('/api/projects/:projectId/git/stage', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    await runGit(projectRoot, ['add', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/unstage', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    await runGit(projectRoot, ['restore', '--staged', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/discard', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    await runGit(projectRoot, ['restore', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/commit', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const message = String(req.body?.message || '').trim();

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    if (!message) {
      res.status(400).json({ error: 'invalid_commit_message', message: 'Commit message is required.' });
      return;
    }

    try {
      await runGit(projectRoot, ['commit', '-m', message]);
      const { stdout } = await runGit(projectRoot, ['rev-parse', '--short', 'HEAD']);
      res.json({
        ok: true,
        commit: {
          message,
          hash: stdout.trim(),
        },
      });
    } catch (error) {
      res.status(400).json({
        error: 'git_commit_failed',
        message: error instanceof Error ? error.message : 'Commit failed.',
      });
    }
  });

  app.post('/api/projects/:projectId/git/branch/checkout', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const branch = String(req.body?.branch || '').trim();
    const create = Boolean(req.body?.create);

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    if (!branch) {
      res.status(400).json({ error: 'invalid_branch', message: 'Branch is required.' });
      return;
    }

    try {
      await runGit(projectRoot, create ? ['checkout', '-b', branch] : ['checkout', branch]);
      res.json({ ok: true, branch });
    } catch (error) {
      res.status(400).json({
        error: 'git_checkout_failed',
        message: error instanceof Error ? error.message : 'Checkout failed.',
      });
    }
  });

  app.post('/api/projects/:projectId/git/pull', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({
        error: 'not_a_git_repo',
        message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
      });
      return;
    }

    try {
      const authEnv = createGitHttpEnv(req.body?.auth);
      const { stdout, stderr } = await runGit(projectRoot, ['pull', '--ff-only'], authEnv);
      res.json({ ok: true, output: `${stdout}${stderr}`.trim() });
    } catch (error) {
      res.status(400).json({
        error: 'git_pull_failed',
        message: error instanceof Error ? error.message : 'Pull failed.',
      });
    }
  });

  app.post('/api/projects/:projectId/git/push', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({ error: 'not_a_git_repo', message: 'This project is not a git repository.' });
      return;
    }

    try {
      const authEnv = createGitHttpEnv(req.body?.auth);
      const { stdout, stderr } = await runGit(projectRoot, ['push'], authEnv);
      res.json({ ok: true, output: `${stdout}${stderr}`.trim() });
    } catch (error) {
      res.status(400).json({
        error: 'git_push_failed',
        message: error instanceof Error ? error.message : 'Push failed.',
      });
    }
  });

  io.use((socket, next) => {
    const authToken = typeof socket.handshake.auth.token === 'string'
      ? socket.handshake.auth.token
      : '';

    if (!isValidToken(authToken)) {
      next(new Error('Unauthorized'));
      return;
    }

    next();
  });

  io.on('connection', (socket) => {
    const workspace = resolveWorkspace();
    const transcriptState = createShellTranscriptState(workspace);
    let shell: PtyLike;

    try {
      shell = ptyFactory({
        command: resolveShell(),
        cols: DEFAULT_COLS,
        cwd: workspace,
        env: createTerminalEnv(workspace),
        rows: DEFAULT_ROWS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown PTY error';
      socket.emit('output', `\r\n[relay] Failed to start shell: ${escapeHtml(message)}\r\n`);
      socket.disconnect(true);
      return;
    }

    activeShells.set(socket.id, shell);
    let shellClosed = false;

    const closeShell = () => {
      if (shellClosed) {
        return;
      }

      shellClosed = true;
      activeShells.delete(socket.id);
      shell.kill();
    };

    shell.onData((data) => {
      socket.emit('output', data);
      handleShellOutput(socket, transcriptState, data);
    });

    if (typeof shell.onExit === 'function') {
      shell.onExit(() => {
        shellClosed = true;
        activeShells.delete(socket.id);
        if (socket.connected) {
          socket.disconnect(true);
        }
      });
    }

    socket.on('input', (data: string) => {
      if (typeof data !== 'string' || data.length === 0) {
        return;
      }

      handleTerminalInput(socket, transcriptState, data);
      shell.write(data);
    });

    socket.on('resize', (payload: { cols?: number; rows?: number } = {}) => {
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);

      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return;
      }

      shell.resize(cols, rows);
    });

    socket.on('disconnect', closeShell);
    socket.on('disconnecting', closeShell);
    socket.conn.on('close', closeShell);
  });

  return {
    app,
    httpServer,
    io,
    async start() {
      const port = Number.parseInt(process.env.PORT || '3000', 10);
      await ensureRelayRuntimeAssets(resolveWorkspace());

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };

        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port);
      });

      const address = httpServer.address();
      if (address && typeof address === 'object') {
        return address.port;
      }

      return port;
    },
    async stop() {
      if (!httpServer.listening) {
        io.close();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        io.close();
        httpServer.close((serverError) => {
          if (serverError && serverError.message !== 'Server is not running.') {
            reject(serverError);
            return;
          }

          resolve();
        });
      });
    },
  };
}

export class FakePty extends EventEmitter implements PtyLike {
  public killed = false;
  public resizeCalls: Array<{ cols: number; rows: number }> = [];
  public writes: string[] = [];

  onData(callback: (data: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.on('exit', callback);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  pushOutput(data: string): void {
    this.emit('data', data);
  }
}
