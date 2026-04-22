import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MANAGED_TOOL_IDS,
  type CustomToolRecord,
  type CustomToolStatus,
  type ManagedToolDefinition,
  type ManagedToolId,
  type ManagedToolStatus,
  type NixPackageRecord,
  type NixPackageStatus,
} from './types';
import {
  createTerminalEnv,
  exists,
  getFlutterRoot,
  getGeminiSettingsPath,
  getNixPackageProfilePath,
  getNixPackageProfilesRoot,
  getNixPackagesRegistryPath,
  getRelayBinRoot,
  getRelayBrowserPath,
  getRelayCacheRoot,
  getRelayRoot,
  getRelayStateRoot,
  getRelayToolsRoot,
  getSystemNixPlatform,
  isRecord,
  readJsonFile,
  resolveShell,
  resolveWorkspace,
  writeJsonFile,
} from './runtime';

const execFile = promisify(execFileCallback);

function getCustomToolsRegistryPath(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'custom-tools.json');
}

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
    description: 'PHP runtime pre-installed in the Relay runtime.',
    category: 'language',
    installMethod: 'system',
    binary: 'php',
    versionArgs: ['-v'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'php'),
  },
  python: {
    id: 'python',
    name: 'Python',
    description: 'Python runtime pre-installed in the Relay runtime.',
    category: 'language',
    installMethod: 'system',
    binary: 'python3',
    versionArgs: ['--version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'python3'),
  },
  go: {
    id: 'go',
    name: 'Go',
    description: 'Go toolchain pre-installed in the Relay runtime.',
    category: 'language',
    installMethod: 'system',
    binary: 'go',
    versionArgs: ['version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'go'),
  },
  rust: {
    id: 'rust',
    name: 'Rust',
    description: 'Rust toolchain pre-installed in the Relay runtime.',
    category: 'language',
    installMethod: 'system',
    binary: 'rustc',
    versionArgs: ['--version'],
    supported: true,
    pathResolver: (workspace) => getManagedToolLinkedBinaryPath(workspace, 'rustc'),
  },
  java: {
    id: 'java',
    name: 'OpenJDK',
    description: 'Java runtime pre-installed in the Relay runtime.',
    category: 'language',
    installMethod: 'system',
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

export function getManagedToolCatalog(
  workspace = resolveWorkspace()
): Array<ManagedToolDefinition & { installPath: string }> {
  return MANAGED_TOOL_IDS.map((toolId) => {
    const tool = MANAGED_TOOLS[toolId];
    return { ...tool, installPath: tool.pathResolver(workspace) };
  });
}

export async function runShellCommand(
  workspace: string,
  command: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(resolveShell(), ['-c', command], {
      cwd: workspace,
      env: createTerminalEnv(workspace),
      maxBuffer: 10 * 1024 * 1024,
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

export async function findCommandPath(workspace: string, command: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(resolveShell(), ['-c', `command -v ${command}`], {
      cwd: workspace,
      env: createTerminalEnv(workspace),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function ensureNixAvailable(workspace: string): Promise<string> {
  const nixPath = await findCommandPath(workspace, 'nix');
  if (!nixPath) {
    throw new Error('nix_unavailable');
  }
  return nixPath;
}

export async function ensureToolDirectories(workspace: string): Promise<void> {
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

export function sanitizeToolId(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

export async function readCustomTools(
  workspace = resolveWorkspace()
): Promise<CustomToolRecord[]> {
  return readJsonFile(getCustomToolsRegistryPath(workspace), []);
}

async function writeCustomTools(
  workspace: string,
  tools: CustomToolRecord[]
): Promise<void> {
  await writeJsonFile(getCustomToolsRegistryPath(workspace), tools);
}

async function getCustomToolStatus(
  workspace: string,
  tool: CustomToolRecord
): Promise<CustomToolStatus> {
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

export async function listCustomToolStatuses(
  workspace = resolveWorkspace()
): Promise<CustomToolStatus[]> {
  await ensureToolDirectories(workspace);
  const tools = await readCustomTools(workspace);
  return Promise.all(tools.map((tool) => getCustomToolStatus(workspace, tool)));
}

async function ensureRelayBrowserScript(workspace: string): Promise<void> {
  await fs.writeFile(getRelayBrowserPath(workspace), `#!/usr/bin/env bash
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
`, { mode: 0o755 });
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
      auth: { ...auth, selectedType: 'oauth-personal' },
    },
  });
}

export async function ensureRelayRuntimeAssets(workspace: string): Promise<void> {
  await ensureToolDirectories(workspace);
  await Promise.all([
    ensureRelayBrowserScript(workspace),
    ensureGeminiAuthSettings(workspace),
  ]);
}
