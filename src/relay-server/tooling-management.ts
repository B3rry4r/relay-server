import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MANAGED_TOOL_IDS,
  type CustomToolRecord,
  type CustomToolStatus,
  type ManagedToolStatus,
  type NixPackageRecord,
  type NixPackageStatus,
} from './types';
import {
  createTerminalEnv,
  exists,
  getNixPackageProfilePath,
  getNixPackagesRegistryPath,
  getRelayBinRoot,
  getRelayCacheRoot,
  getRelayRoot,
  getRelayStateRoot,
  getRelayToolsRoot,
  getSystemNixPlatform,
  readJsonFile,
  resolveWorkspace,
  writeJsonFile,
} from './runtime';
import {
  ensureNixAvailable,
  ensureRelayRuntimeAssets,
  findCommandPath,
  getManagedToolCatalog,
  readCustomTools,
  runShellCommand,
  sanitizeToolId,
} from './tooling';

const execFile = promisify(execFileCallback);
const managedInstallLocks = new Map<string, Promise<ManagedToolStatus>>();

async function writeNixPackages(workspace: string, packages: NixPackageRecord[]): Promise<void> {
  await writeJsonFile(getNixPackagesRegistryPath(workspace), packages);
}

async function readNixPackages(workspace = resolveWorkspace()): Promise<NixPackageRecord[]> {
  return readJsonFile(getNixPackagesRegistryPath(workspace), []);
}

export async function listManagedToolStatuses(
  workspace = resolveWorkspace()
): Promise<ManagedToolStatus[]> {
  await ensureRelayRuntimeAssets(workspace);
  return Promise.all(getManagedToolCatalog(workspace).map(async (tool) => {
    const installPath = tool.pathResolver(workspace);
    const env = createTerminalEnv(workspace);
    const relayBinaryExists = await exists(installPath);

    if (tool.installMethod === 'system') {
      try {
        const { stdout, stderr } = await execFile('sh', ['-c', `command -v ${tool.binary}`], { cwd: workspace, env });
        const resolvedPath = stdout.trim();
        if (!resolvedPath) {
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
        const { stdout: versionOut, stderr: versionErr } = await execFile(resolvedPath, tool.versionArgs, { cwd: workspace, env });
        const version = `${versionOut}${versionErr}`.trim().split('\n')[0] || null;
        return {
          id: tool.id,
          kind: 'managed' as const,
          name: tool.name,
          description: tool.description,
          category: tool.category,
          installMethod: tool.installMethod,
          installPath,
          installed: true,
          source: resolvedPath.startsWith(getRelayRoot(workspace)) ? 'relay' : 'system',
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
    }

    const commandPath = relayBinaryExists ? installPath : tool.binary;
    const gitInstallRoot = tool.installMethod === 'git' ? path.dirname(path.dirname(installPath)) : '';

    try {
      const { stdout, stderr } = await execFile(commandPath, tool.versionArgs, { cwd: workspace, env });
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
        source: resolvedPath.startsWith(getRelayRoot(workspace)) ? 'relay' : 'system',
        supported: tool.supported,
        version,
      };
    } catch {
      if (tool.installMethod === 'git' && (relayBinaryExists || (gitInstallRoot && await exists(gitInstallRoot)))) {
        return {
          id: tool.id,
          kind: 'managed' as const,
          name: tool.name,
          description: tool.description,
          category: tool.category,
          installMethod: tool.installMethod,
          installPath,
          installed: true,
          source: 'relay',
          supported: tool.supported,
          version: null,
        };
      }

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

export async function installManagedTool(
  workspace: string,
  toolId: typeof MANAGED_TOOL_IDS[number]
): Promise<ManagedToolStatus> {
  const existing = managedInstallLocks.get(toolId);
  if (existing) {
    return existing;
  }

  const task = (async () => {
  await ensureRelayRuntimeAssets(workspace);
  const tool = getManagedToolCatalog(workspace).find((entry) => entry.id === toolId);
  if (!tool || !tool.supported) {
    throw new Error('unsupported_tool');
  }

  if (tool.installMethod === 'git') {
    const flutterRoot = path.join(getRelayToolsRoot(workspace), 'flutter');
    await fs.rm(path.join(flutterRoot, '.git', 'index.lock'), { force: true });
    if (await exists(flutterRoot)) {
      await runShellCommand(workspace, `git -C '${flutterRoot}' pull --ff-only`);
    } else {
      await runShellCommand(workspace, `git clone https://github.com/flutter/flutter.git -b stable '${flutterRoot}'`);
    }
    await runShellCommand(workspace, `'${path.join(flutterRoot, 'bin', 'flutter')}' config --enable-web`);
  } else if (tool.installMethod === 'system') {
    const systemBinaryPath = await findCommandPath(workspace, tool.binary);
    if (systemBinaryPath) {
      await fs.rm(path.join(getRelayBinRoot(workspace), tool.binary), { force: true });
      await fs.symlink(systemBinaryPath, path.join(getRelayBinRoot(workspace), tool.binary));
    } else {
      if (!tool.nixPackage) {
        throw new Error('system_tools_must_be_preinstalled');
      }
      await ensureNixAvailable(workspace);
      const profilePath = path.join(getRelayToolsRoot(workspace), 'profiles', tool.id);
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await runShellCommand(workspace, `nix profile install --accept-flake-config --profile '${profilePath}' '${tool.nixPackage}'`);
      const sourceBinary = path.join(profilePath, 'bin', tool.binary);
      await fs.rm(path.join(getRelayBinRoot(workspace), tool.binary), { force: true });
      await fs.symlink(sourceBinary, path.join(getRelayBinRoot(workspace), tool.binary));
    }
  } else {
    await ensureNixAvailable(workspace);
    const profilePath = path.join(getRelayToolsRoot(workspace), 'profiles', tool.id);
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await runShellCommand(workspace, `nix profile install --accept-flake-config --profile '${profilePath}' '${tool.nixPackage}'`);
    const sourceBinary = path.join(profilePath, 'bin', tool.binary);
    await fs.rm(path.join(getRelayBinRoot(workspace), tool.binary), { force: true });
    await fs.symlink(sourceBinary, path.join(getRelayBinRoot(workspace), tool.binary));
  }

  return (await listManagedToolStatuses(workspace)).find((status) => status.id === toolId)!;
  })();

  managedInstallLocks.set(toolId, task);
  try {
    return await task;
  } finally {
    managedInstallLocks.delete(toolId);
  }
}

export async function uninstallManagedTool(
  workspace: string,
  toolId: typeof MANAGED_TOOL_IDS[number]
): Promise<ManagedToolStatus> {
  const tool = getManagedToolCatalog(workspace).find((entry) => entry.id === toolId);
  if (!tool || !tool.supported) {
    throw new Error('unsupported_tool');
  }

  if (tool.installMethod === 'git') {
    await fs.rm(path.join(getRelayToolsRoot(workspace), 'flutter'), { recursive: true, force: true });
  } else {
    await fs.rm(path.join(getRelayToolsRoot(workspace), 'profiles', tool.id), { recursive: true, force: true });
    await fs.rm(path.join(getRelayBinRoot(workspace), tool.binary), { force: true });
  }

  return (await listManagedToolStatuses(workspace)).find((status) => status.id === toolId)!;
}

function sanitizePackageRef(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._+/#:-]+$/.test(trimmed) ? trimmed : null;
}

function nixAttrToPackageRef(attr: string): string {
  const system = getSystemNixPlatform();
  for (const prefix of [`legacyPackages.${system}.`, `packages.${system}.`]) {
    if (attr.startsWith(prefix)) {
      return `nixpkgs#${attr.slice(prefix.length)}`;
    }
  }
  return `nixpkgs#${attr}`;
}

export async function searchNixPackages(workspace: string, query: string): Promise<Array<{
  attr: string;
  description: string | null;
  name: string;
  packageRef: string;
  version: string | null;
}>> {
  await ensureRelayRuntimeAssets(workspace);
  if (query.trim().length < 2) {
    throw new Error('invalid_search_query');
  }

  const nixPath = await ensureNixAvailable(workspace);
  const { stdout } = await execFile(nixPath, ['search', 'nixpkgs', query.trim(), '--json'], {
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

export async function getNixPackageStatus(
  workspace: string,
  pkg: NixPackageRecord
): Promise<NixPackageStatus> {
  const installPath = path.join(getRelayBinRoot(workspace), pkg.binary);
  const installed = await exists(installPath);
  let version: string | null = null;

  if (installed) {
    try {
      const result = await execFile(installPath, pkg.versionArgs || ['--version'], {
        cwd: workspace,
        env: createTerminalEnv(workspace),
      });
      version = `${result.stdout}${result.stderr}`.trim().split('\n')[0] || null;
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
