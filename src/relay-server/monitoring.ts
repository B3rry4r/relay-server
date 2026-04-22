import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  exists,
  getRelayBinRoot,
  getRelayCacheRoot,
  getRelayRoot,
  getRelayStateRoot,
  getRelayToolsRoot,
  parseBootstrapStatus,
  resolveWorkspace,
} from './runtime';
import { listListeningPorts } from './projects';
import { listCustomToolStatuses, listNixPackageStatuses } from './tooling-custom';
import { ensureRelayRuntimeAssets } from './tooling';
import { listManagedToolStatuses } from './tooling-management';

const execFile = promisify(execFileCallback);

export async function getWorkspaceHealth(): Promise<{
  workspace: string;
  bootstrapped: boolean;
  relay: {
    bin: string;
    cache: string;
    root: string;
    state: string;
    tools: string;
  };
  managedTools: Awaited<ReturnType<typeof listManagedToolStatuses>>;
  customTools: Awaited<ReturnType<typeof listCustomToolStatuses>>;
  nixPackages: Awaited<ReturnType<typeof listNixPackageStatuses>>;
  status: Record<string, string>;
  toolchains: Record<string, string | boolean>;
  disk: { available: number | null; total: number | null };
  activePorts: number[];
}> {
  const workspace = resolveWorkspace();
  await ensureRelayRuntimeAssets(workspace);
  const [status, activePorts, managedTools, customTools, nixPackages] = await Promise.all([
    parseBootstrapStatus(),
    listListeningPorts(),
    listManagedToolStatuses(workspace),
    listCustomToolStatuses(workspace),
    listNixPackageStatuses(workspace),
  ]);

  const toolchains: Record<string, string | boolean> = { git: false, node: false };
  try {
    toolchains.git = (await execFile('git', ['--version'], { cwd: process.cwd(), env: process.env })).stdout.trim();
  } catch {
    toolchains.git = false;
  }
  try {
    toolchains.node = (await execFile('node', ['-v'], { cwd: process.cwd(), env: process.env })).stdout.trim();
  } catch {
    toolchains.node = false;
  }

  let disk = { available: null as number | null, total: null as number | null };
  try {
    const { stdout } = await execFile('sh', ['-c', `df -k "${workspace}" | tail -n 1`], {
      cwd: process.cwd(),
      env: process.env,
    });
    const parts = stdout.trim().split(/\s+/);
    disk = { total: Number(parts[1]) * 1024 || null, available: Number(parts[3]) * 1024 || null };
  } catch {
    disk = { available: null, total: null };
  }

  return {
    workspace,
    bootstrapped: await exists(`${workspace}/.bootstrapped`),
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

export function parseCommandResult(command: string, output: string): {
  type: string;
  summary: string;
  details?: Record<string, unknown>;
} {
  if (command.startsWith('git status')) {
    const branchLine = output.split('\n').find((line) => line.startsWith('On branch '));
    const clean = output.includes('working tree clean');
    return {
      type: 'git-status',
      summary: clean ? 'Working tree clean' : 'Working tree has changes',
      details: { branch: branchLine?.replace('On branch ', '') || null, clean },
    };
  }

  if (command.startsWith('npm install')) {
    const addedMatch = output.match(/added (\d+) packages?/);
    return {
      type: 'npm-install',
      summary: addedMatch ? `Added ${addedMatch[1]} packages` : 'npm install completed',
      details: { addedPackages: addedMatch ? Number(addedMatch[1]) : null },
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

  return { type: 'raw', summary: 'No structured parser available' };
}
