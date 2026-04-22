import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { type GitFileEntry } from './types';

const execFile = promisify(execFileCallback);

export async function runGit(
  projectRoot: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
  });
}

export async function ensureGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function initializeGitRepository(projectRoot: string): Promise<void> {
  try {
    await runGit(projectRoot, ['init', '-b', 'main']);
  } catch {
    await runGit(projectRoot, ['init']);
  }
}

function normalizeGitStatus(code: string): string {
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'updated';
    default: return 'unknown';
  }
}

export async function getGitStatus(projectRoot: string): Promise<{
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
      ahead = Number(branchInfo.match(/ahead (\d+)/)?.[1] || 0);
      behind = Number(branchInfo.match(/behind (\d+)/)?.[1] || 0);
      continue;
    }

    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3).split(' -> ').pop() || line.slice(3);

    if (x === '?' && y === '?') {
      untracked.push({ path: filePath });
      continue;
    }

    if (('UAD'.includes(x) && 'UAD'.includes(y) && x === y) || x === 'U' || y === 'U') {
      conflicts.push({ path: filePath, status: 'conflict' });
      continue;
    }

    if (x !== ' ' && x !== '?') {
      staged.push({ path: filePath, status: normalizeGitStatus(x) });
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path: filePath, status: normalizeGitStatus(y) });
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

export async function getGitBranches(projectRoot: string): Promise<{ current: string | null; branches: string[] }> {
  const [currentBranch, branchList] = await Promise.all([
    runGit(projectRoot, ['branch', '--show-current']),
    runGit(projectRoot, ['branch', '--format=%(refname:short)']),
  ]);

  return {
    current: currentBranch.stdout.trim() || null,
    branches: branchList.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

export function createGitHttpEnv(auth?: {
  username?: string;
  token?: string;
  password?: string;
}): NodeJS.ProcessEnv {
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
