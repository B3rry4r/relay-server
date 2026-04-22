import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type CustomToolRecord,
  type CustomToolStatus,
  type NixPackageRecord,
  type NixPackageStatus,
} from './types';
import {
  exists,
  getNixPackageProfilePath,
  getNixPackagesRegistryPath,
  getRelayBinRoot,
  getRelayToolsRoot,
  readJsonFile,
  resolveWorkspace,
  writeJsonFile,
} from './runtime';
import {
  ensureNixAvailable,
  ensureRelayRuntimeAssets,
  readCustomTools,
  runShellCommand,
  sanitizeToolId,
} from './tooling';
import { getNixPackageStatus } from './tooling-management';

async function writeCustomTools(workspace: string, tools: CustomToolRecord[]): Promise<void> {
  await writeJsonFile(path.join(resolveWorkspace(), '.relay', 'state', 'custom-tools.json'), tools);
}

async function getCustomToolStatus(workspace: string, tool: CustomToolRecord): Promise<CustomToolStatus> {
  const installed = await exists(tool.binaryPath);
  let version: string | null = null;

  if (installed && tool.versionCommand) {
    try {
      const result = await runShellCommand(workspace, tool.versionCommand);
      version = `${result.stdout}${result.stderr}`.trim().split('\n')[0] || null;
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
    installed,
    source: installed ? 'relay' : 'unavailable',
    supported: true,
    version,
  };
}

export async function listCustomToolStatuses(workspace = resolveWorkspace()): Promise<CustomToolStatus[]> {
  await ensureRelayRuntimeAssets(workspace);
  return Promise.all((await readCustomTools(workspace)).map((tool) => getCustomToolStatus(workspace, tool)));
}

export async function installCustomTool(
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
  await ensureRelayRuntimeAssets(workspace);
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

  const resolvedBinaryPath = path.resolve(input.binaryPath.trim() || path.join(resolvedInstallPath, 'bin', toolId));
  if (resolvedBinaryPath !== resolvedInstallPath && !resolvedBinaryPath.startsWith(`${resolvedInstallPath}${path.sep}`)) {
    throw new Error('invalid_binary_path');
  }

  const binLinks = Array.isArray((input as { binLinks?: unknown }).binLinks)
    ? ((input as { binLinks?: unknown[] }).binLinks || []).filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    )
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

export async function uninstallCustomTool(workspace: string, toolId: string): Promise<CustomToolStatus> {
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

async function readNixPackages(workspace = resolveWorkspace()): Promise<NixPackageRecord[]> {
  return readJsonFile(getNixPackagesRegistryPath(workspace), []);
}

async function writeNixPackages(workspace: string, packages: NixPackageRecord[]): Promise<void> {
  await writeJsonFile(getNixPackagesRegistryPath(workspace), packages);
}

function sanitizePackageRef(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._+/#:-]+$/.test(trimmed) ? trimmed : null;
}

export async function listNixPackageStatuses(workspace = resolveWorkspace()): Promise<NixPackageStatus[]> {
  await ensureRelayRuntimeAssets(workspace);
  return Promise.all((await readNixPackages(workspace)).map((pkg) => getNixPackageStatus(workspace, pkg)));
}

export async function installNixPackage(
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
  await writeNixPackages(workspace, [...packages.filter((pkg) => pkg.id !== packageId), nextRecord]);
  return getNixPackageStatus(workspace, nextRecord);
}

export async function uninstallNixPackage(workspace: string, toolId: string): Promise<NixPackageStatus> {
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
