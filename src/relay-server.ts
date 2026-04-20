import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
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

type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
};

function resolveAuthToken(): string {
  return process.env.AUTH_TOKEN || '';
}

function resolveWorkspace(): string {
  return process.env.WORKSPACE || '/workspace';
}

function resolveShell(): string {
  return process.env.SHELL || 'bash';
}

function createTerminalEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace,
    PROMPT_COMMAND: '',
    TERM: process.env.TERM || 'xterm-256color',
  };

  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('BASH_FUNC__vsc_')) {
      delete env[key];
    }
  }

  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;

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

async function listProjects(): Promise<Array<{
  id: string;
  name: string;
  path: string;
  lastModifiedAt: string;
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
    const workspace = resolveWorkspace();
    const status = await parseBootstrapStatus();
    const bootstrapped = await exists(path.join(workspace, '.bootstrapped'));

    res.json({
      workspace,
      bootstrapped,
      status,
    });
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

    if (req.body?.initializeGit === true) {
      await fs.mkdir(path.join(projectPath, '.git'), { recursive: true });
    }

    res.status(201).json({
      project: {
        id: projectName,
        name: projectName,
        path: projectPath,
      },
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

  app.post('/api/session/project', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(String(req.body?.projectId || ''));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

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

  app.get('/api/previews', requireAuth, (_req, res) => {
    res.json({
      previews: [],
    });
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

    shell.onData((data) => {
      socket.emit('output', data);
    });

    if (typeof shell.onExit === 'function') {
      shell.onExit(() => {
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

    socket.on('disconnect', () => {
      activeShells.delete(socket.id);
      shell.kill();
    });
  });

  return {
    app,
    httpServer,
    io,
    async start() {
      const port = Number.parseInt(process.env.PORT || '3000', 10);

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
