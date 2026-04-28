import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitRepo, runGit, getGitStatus } from './git';
import {
  RECENT_PROJECT_LIMIT,
  type TreeNode,
} from './types';
import {
  ensureProjectsRoot,
  exists,
  getProjectsRoot,
  getRelayStateRoot,
  readJsonFile,
  resolveProjectRelativePath,
  writeJsonFile,
} from './runtime';

const execFile = promisify(execFileCallback);

async function getGitStatusMap(projectRoot: string): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>();
  if (!await ensureGitRepo(projectRoot)) {
    return statusMap;
  }
  try {
    const status = await getGitStatus(projectRoot);
    for (const file of status.staged ?? []) {
      statusMap.set(file.path, file.status ?? 'staged');
    }
    for (const file of status.unstaged ?? []) {
      statusMap.set(file.path, file.status ?? 'modified');
    }
    for (const file of status.untracked ?? []) {
      statusMap.set(file.path, 'untracked');
    }
    for (const file of status.conflicts ?? []) {
      statusMap.set(file.path, 'conflicted');
    }
  } catch { /* ignore */ }
  return statusMap;
}

export async function readPackageJson(
  projectRoot: string
): Promise<Record<string, unknown> | null> {
  return readJsonFile(path.join(projectRoot, 'package.json'), null);
}

export async function getRecentProjects(): Promise<string[]> {
  return readJsonFile(path.join(getRelayStateRoot(), 'recent-projects.json'), []);
}

export async function setRecentProjects(projectIds: string[]): Promise<void> {
  await writeJsonFile(path.join(getRelayStateRoot(), 'recent-projects.json'), projectIds);
}

export async function markProjectAsRecent(projectId: string): Promise<void> {
  const recent = await getRecentProjects();
  const next = [projectId, ...recent.filter((value) => value !== projectId)];
  await setRecentProjects(next.slice(0, RECENT_PROJECT_LIMIT));
}

export async function getPinnedProjects(): Promise<string[]> {
  return readJsonFile(path.join(getRelayStateRoot(), 'pinned-projects.json'), []);
}

export async function setPinnedProjects(projectIds: string[]): Promise<void> {
  await writeJsonFile(path.join(getRelayStateRoot(), 'pinned-projects.json'), projectIds);
}

export async function scaffoldTemplate(projectRoot: string, template: string): Promise<void> {
  switch (template) {
    case 'blank':
      return;
    case 'node-api':
      await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'console.log("Relay node api");\n');
      await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
        name: path.basename(projectRoot),
        private: true,
        scripts: { dev: 'node src/index.js', test: 'echo "No tests yet"' },
      }, null, 2)}\n`);
      return;
    case 'next-app':
      await fs.mkdir(path.join(projectRoot, 'app'), { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'app', 'page.tsx'), 'export default function Page() { return <main>Relay Next App</main>; }\n');
      await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
        name: path.basename(projectRoot),
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
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
        bin: { [path.basename(projectRoot)]: './bin/cli.js' },
      }, null, 2)}\n`);
      return;
    default:
      return;
  }
}

export async function inferTasks(projectRoot: string): Promise<Array<{ id: string; label: string; command: string }>> {
  const tasks: Array<{ id: string; label: string; command: string }> = [];
  const packageJson = await readPackageJson(projectRoot);

  if (packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts !== null) {
    for (const [key, value] of Object.entries(packageJson.scripts as Record<string, unknown>)) {
      if (typeof value === 'string' && ['dev', 'test', 'lint', 'build', 'migrate', 'seed', 'start'].includes(key)) {
        tasks.push({ id: key, label: key, command: `npm run ${key}` });
      }
    }
  }

  if (await exists(path.join(projectRoot, 'requirements.txt'))) {
    tasks.push({ id: 'pip-install', label: 'install', command: 'pip install -r requirements.txt' });
  }

  return tasks;
}

export async function inferSuggestions(projectRoot: string): Promise<Array<{ id: string; label: string; command: string }>> {
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
    suggestions.push({ id: 'git-status', label: 'Git status', command: 'git status' });
  }
  return suggestions;
}

export async function readProjectNotes(projectRoot: string): Promise<string> {
  const notesPath = path.join(projectRoot, '.relay-notes.md');
  return await exists(notesPath) ? fs.readFile(notesPath, 'utf8') : '';
}

export async function writeProjectNotes(projectRoot: string, content: string): Promise<void> {
  await fs.writeFile(path.join(projectRoot, '.relay-notes.md'), content, 'utf8');
}

export async function duplicateItem(
  projectRoot: string,
  sourcePath: string,
  newName?: string
): Promise<{ sourcePath: string; duplicatedPath: string }> {
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

export async function listListeningPorts(): Promise<number[]> {
  const excludedPorts: number[] = [22, 80, 443, 8080, 8443, 3000, 3001];

  function isNotExcluded(p: number): boolean {
    return p > 0 && !excludedPorts.includes(p);
  }

  try {
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
        .filter((v): v is number => v !== null && isNotExcluded(v));

      if (ports.length > 0) {
        return [...new Set(ports)].sort((a, b) => a - b);
      }
    } catch {
      // fall through
    }

    const tcpPorts: number[] = [];
    try {
      const tcpData = await fs.readFile('/proc/net/tcp', 'utf8');
      const lines = tcpData.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts[3] === '0A') {
          const hex = parts[1]?.split(':')[1];
          if (hex) {
            const port = parseInt(hex, 16);
            if (isNotExcluded(port)) tcpPorts.push(port);
          }
        }
      }
    } catch {}

    try {
      const tcp6Data = await fs.readFile('/proc/net/tcp6', 'utf8');
      const lines = tcp6Data.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts[3] === '0A') {
          const hex = parts[1]?.split(':')[1];
          if (hex) {
            const port = parseInt(hex, 16);
            if (isNotExcluded(port)) tcpPorts.push(port);
          }
        }
      }
    } catch {}

    return [...new Set(tcpPorts)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function listProjects(): Promise<Array<{
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

export async function buildQuickSwitchProjects(): Promise<Array<{
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

  return projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      pinned: pinnedSet.has(project.id),
      recent: recentSet.has(project.id),
    }))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      if (left.recent !== right.recent) {
        return left.recent ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export async function buildTree(
  projectRoot: string,
  relativePath = '',
  depth = 2
): Promise<TreeNode[]> {
  const targetPath = resolveProjectRelativePath(projectRoot, relativePath);
  if (!targetPath) {
    return [];
  }

  const statusMap = await getGitStatusMap(projectRoot);
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const nodes = await Promise.all(entries.map(async (entry) => {
    const entryAbsolutePath = path.join(targetPath, entry.name);
    const entryRelativePath = path.relative(projectRoot, entryAbsolutePath) || entry.name;

    if (entry.isDirectory()) {
      const node: TreeNode = { name: entry.name, path: entryRelativePath, type: 'directory' };
      if (depth > 1) {
        return [node, ...(await buildTree(projectRoot, entryRelativePath, depth - 1))];
      }
      return [node];
    }

    const stat = await fs.stat(entryAbsolutePath);
    const gitStatus = statusMap.get(entryRelativePath);
    return [{
      name: entry.name,
      path: entryRelativePath,
      type: 'file' as const,
      size: stat.size,
      status: gitStatus as TreeNode['status'],
    }];
  }));

  return nodes.flat().sort((left, right) => left.path.localeCompare(right.path));
}
