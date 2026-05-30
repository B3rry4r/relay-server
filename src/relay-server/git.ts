import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { type GitFileEntry } from './types';
import { getRelayGitAuthPath, getRelayBinRoot, resolveWorkspace, readJsonFile, writeJsonFile } from './runtime';

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

export type SavedGitAuth = {
  username?: string;
  token?: string;
  password?: string;
  updatedAt?: string;
} | null

function normalizeGitAuth(auth?: {
  username?: string;
  token?: string;
  password?: string;
}): { username: string; secret: string } | null {
  if (!auth?.token && !auth?.password) {
    return null;
  }

  return {
    username: auth.username || 'git',
    secret: auth.token || auth.password || '',
  };
}

export async function readSavedGitAuth(workspace = resolveWorkspace()): Promise<SavedGitAuth> {
  return readJsonFile<SavedGitAuth>(getRelayGitAuthPath(workspace), null);
}

export async function saveGitAuth(workspace: string, auth?: {
  username?: string;
  token?: string;
  password?: string;
}): Promise<SavedGitAuth> {
  const normalized = normalizeGitAuth(auth);
  if (!normalized) {
    await fs.rm(getRelayGitAuthPath(workspace), { force: true });
    return null;
  }

  const record: Exclude<SavedGitAuth, null> = {
    username: normalized.username,
    token: auth?.token?.trim() || undefined,
    password: auth?.password?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  const authPath = getRelayGitAuthPath(workspace);
  await writeJsonFile(authPath, record);
  // Secrets store: restrict to owner read/write only (was world-readable).
  try { await fs.chmod(authPath, 0o600); } catch { /* best-effort */ }
  return record;
}

export async function clearSavedGitAuth(workspace = resolveWorkspace()): Promise<void> {
  await fs.rm(getRelayGitAuthPath(workspace), { force: true });
}

// Credentials from the environment (e.g. GITHUB_TOKEN injected by a secret
// manager / deployment platform). Preferred over the on-disk store.
function envGitAuth(): { username: string; secret: string } | null {
  const secret = (process.env.GITHUB_TOKEN || process.env.GIT_TOKEN || '').trim();
  if (!secret) return null;
  return { username: (process.env.GIT_USERNAME || 'x-access-token').trim(), secret };
}

export async function createGitHttpEnv(workspace: string, auth?: {
  username?: string;
  token?: string;
  password?: string;
}): Promise<NodeJS.ProcessEnv> {
  // Precedence: explicit request auth → environment → saved store.
  const currentAuth = normalizeGitAuth(auth) ?? envGitAuth() ?? normalizeGitAuth(await readSavedGitAuth(workspace) ?? undefined);
  if (!currentAuth) {
    return {};
  }

  const authHeader = Buffer.from(`${currentAuth.username}:${currentAuth.secret}`).toString('base64');

  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${authHeader}`,
  };
}

// ── Remote URL hygiene + credential helper ──────────────────────────────────────

// Strip embedded credentials from an https remote URL:
//   https://user:token@github.com/org/repo.git → https://github.com/org/repo.git
export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(?:[^/@]+@)/i, '$1');
}

// Rewrite any remote on a repo whose URL embeds credentials to the clean form.
// Auth is supplied at run time by the credential helper / extraHeader instead,
// so the token never sits in .git/config or shows up in `git remote -v`.
export async function sanitizeRepoRemotes(projectRoot: string): Promise<string[]> {
  const cleaned: string[] = [];
  try {
    const { stdout } = await runGit(projectRoot, ['remote']);
    for (const remote of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      try {
        const { stdout: raw } = await runGit(projectRoot, ['remote', 'get-url', remote]);
        const url = raw.trim();
        const clean = sanitizeRemoteUrl(url);
        if (clean !== url) {
          await runGit(projectRoot, ['remote', 'set-url', remote, clean]);
          cleaned.push(remote);
        }
      } catch { /* skip this remote */ }
    }
  } catch { /* not a repo / no remotes */ }
  return cleaned;
}

const GIT_CREDENTIAL_HELPER_NAME = 'git-credential-relay';

function buildCredentialHelperScript(authFilePath: string): string {
  // git invokes `<helper> get` with the request on stdin and expects
  // `username=…` / `password=…` on stdout. Secret is sourced from the
  // environment first (secret manager), then the relay auth store. The token
  // is never written to a URL, .git/config, or a process argument list.
  return `#!/usr/bin/env bash
# relay git credential helper — serves git credentials from env or the
# relay auth store. Installed via: git config --global credential.helper <this>
[ "$1" = "get" ] || exit 0
AUTH_FILE="\${RELAY_GIT_AUTH_FILE:-${authFilePath}}"
TOKEN="\${GITHUB_TOKEN:-\${GIT_TOKEN:-}}"
USERNAME="\${GIT_USERNAME:-}"
if [ -z "$TOKEN" ] && [ -f "$AUTH_FILE" ]; then
  TOKEN="$(node -e 'try{const a=require(process.argv[1]);process.stdout.write(String(a.token||a.password||""))}catch(e){}' "$AUTH_FILE" 2>/dev/null)"
  [ -z "$USERNAME" ] && USERNAME="$(node -e 'try{const a=require(process.argv[1]);process.stdout.write(String(a.username||""))}catch(e){}' "$AUTH_FILE" 2>/dev/null)"
fi
[ -n "$TOKEN" ] || exit 0
echo "username=\${USERNAME:-x-access-token}"
echo "password=$TOKEN"
`;
}

// Install a global git credential helper so BOTH relay-driven git operations
// and manual terminal git authenticate from the secure store/env — removing the
// need to ever embed a token in a clone URL (the source of the leaked PATs).
export async function installGitCredentialHelper(workspace = resolveWorkspace()): Promise<void> {
  try {
    const binRoot = getRelayBinRoot(workspace);
    await fs.mkdir(binRoot, { recursive: true });
    const helperPath = path.join(binRoot, GIT_CREDENTIAL_HELPER_NAME);
    await fs.writeFile(helperPath, buildCredentialHelperScript(getRelayGitAuthPath(workspace)), { mode: 0o755 });
    await fs.chmod(helperPath, 0o755);
    await runGit(workspace, ['config', '--global', 'credential.helper', helperPath]);
    await runGit(workspace, ['config', '--global', 'credential.useHttpPath', 'false']);
  } catch { /* best-effort; per-command extraHeader still authenticates relay ops */ }
}
