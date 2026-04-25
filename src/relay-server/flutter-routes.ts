import express, { type Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createTerminalEnv,
  exists,
  getFlutterRoot,
  readStringParam,
  requireAuth,
  resolveProjectRoot,
  resolveWorkspace,
} from './runtime';
import { installManagedTool, listManagedToolStatuses } from './tooling-management';
import { listListeningPorts } from './projects';

const execFile = promisify(execFileCallback);

type FlutterDevSession = {
  port: number;
  process: ChildProcessWithoutNullStreams;
  projectId: string;
  projectRoot: string;
  startedAt: number;
  output: string;
};

const flutterDevSessions = new Map<string, FlutterDevSession>();

function appendSessionOutput(session: FlutterDevSession, chunk: Buffer): void {
  session.output = `${session.output}${chunk.toString('utf8')}`.slice(-20000);
}

function stopFlutterDevSession(projectId: string): void {
  const session = flutterDevSessions.get(projectId);
  if (!session) return;
  session.process.kill('SIGTERM');
  flutterDevSessions.delete(projectId);
}

async function waitForPort(port: number, timeoutMs = 25000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ports = await listListeningPorts();
    if (ports.includes(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function readPreviewPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080;
}

async function ensureFlutterInstalled(workspace: string): Promise<boolean> {
  const flutterPath = getFlutterRoot(workspace);
  if (await exists(path.join(flutterPath, 'bin', 'flutter'))) {
    return true;
  }
  try {
    await installManagedTool(workspace, 'flutter');
    return true;
  } catch {
    return false;
  }
}

async function isFlutterProject(projectRoot: string): Promise<boolean> {
  const pubspecPath = path.join(projectRoot, 'pubspec.yaml');
  return exists(pubspecPath);
}

async function getFlutterProjectInfo(projectRoot: string) {
  const hasPubspec = await isFlutterProject(projectRoot);
  if (!hasPubspec) {
    return null;
  }

  const buildDir = path.join(projectRoot, 'build', 'web');
  const hasBuild = await exists(buildDir);

  return {
    isFlutter: true,
    buildDir,
    hasBuild,
  };
}

export function registerFlutterRoutes(app: Express): void {
  app.get('/api/flutter/status', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    const tools = await listManagedToolStatuses(workspace);
    const flutter = tools.find(t => t.id === 'flutter');

    res.json({
      installed: flutter?.installed ?? false,
      version: flutter?.version,
      home: getFlutterRoot(workspace),
    });
  });

  app.post('/api/flutter/install', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    try {
      await installManagedTool(workspace, 'flutter');
      const tools = await listManagedToolStatuses(workspace);
      const flutter = tools.find(t => t.id === 'flutter');

      res.json({ ok: true, flutter });
    } catch (error) {
      res.status(500).json({
        error: 'flutter_install_failed',
        message: error instanceof Error ? error.message : 'Failed to install Flutter',
      });
    }
  });

  app.get('/api/projects/:projectId/flutter', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const flutterInfo = await getFlutterProjectInfo(projectRoot);

    if (!flutterInfo) {
      res.json({ isFlutter: false });
      return;
    }

    res.json(flutterInfo);
  });

  app.post('/api/projects/:projectId/flutter/build', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await isFlutterProject(projectRoot)) {
      res.status(400).json({ error: 'not_flutter_project', message: 'This project is not a Flutter project.' });
      return;
    }

    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) {
      res.status(503).json({ error: 'flutter_not_installed', message: 'Flutter SDK is not installed.' });
      return;
    }

    const flutterBin = path.join(getFlutterRoot(workspace), 'bin', 'flutter');
    const env = createTerminalEnv(workspace);

    try {
      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });

      const { stdout, stderr } = await execFile(flutterBin, ['build', 'web', '--release'], {
        cwd: projectRoot,
        env,
        maxBuffer: 100 * 1024 * 1024,
      });

      const buildDir = path.join(projectRoot, 'build', 'web');
      const files = await fs.readdir(buildDir);

      res.json({
        ok: true,
        buildDir,
        outputFiles: files,
        message: stdout + stderr,
      });
    } catch (error) {
      res.status(500).json({
        error: 'build_failed',
        message: error instanceof Error ? error.message : 'Flutter build failed.',
      });
    }
  });

  app.post('/api/projects/:projectId/flutter/serve', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const port = readPreviewPort(req.body?.port);

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    if (!await isFlutterProject(projectRoot)) {
      res.status(400).json({ error: 'not_flutter_project', message: 'This project is not a Flutter project.' });
      return;
    }

    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) {
      res.status(503).json({ error: 'flutter_not_installed', message: 'Flutter SDK is not installed.' });
      return;
    }

    const flutterBin = path.join(getFlutterRoot(workspace), 'bin', 'flutter');
    const env = createTerminalEnv(workspace);
    const existing = flutterDevSessions.get(projectId);

    if (existing?.port === port && existing.process.exitCode === null) {
      res.json({
        ok: true,
        url: `/preview/${port}/`,
        port,
        mode: 'dev-server',
        ready: true,
        message: `Flutter dev preview is already running on port ${port}.`,
      });
      return;
    }

    if (existing) {
      stopFlutterDevSession(projectId);
    }

    try {
      const activePorts = await listListeningPorts();
      if (activePorts.includes(port)) {
        res.status(409).json({
          error: 'port_in_use',
          message: `Port ${port} is already in use. Choose another preview port.`,
        });
        return;
      }

      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });

      const child = spawn(flutterBin, [
        'run',
        '-d',
        'web-server',
        '--web-hostname',
        '0.0.0.0',
        '--web-port',
        String(port),
      ], {
        cwd: projectRoot,
        env,
        stdio: 'pipe',
      });

      const session: FlutterDevSession = {
        port,
        process: child,
        projectId,
        projectRoot,
        startedAt: Date.now(),
        output: '',
      };
      flutterDevSessions.set(projectId, session);
      child.stdout.on('data', (chunk: Buffer) => appendSessionOutput(session, chunk));
      child.stderr.on('data', (chunk: Buffer) => appendSessionOutput(session, chunk));
      child.on('exit', () => {
        if (flutterDevSessions.get(projectId)?.process === child) {
          flutterDevSessions.delete(projectId);
        }
      });

      const ready = await waitForPort(port);
      if (!ready) {
        const output = session.output.trim();
        stopFlutterDevSession(projectId);
        res.status(500).json({
          error: 'serve_failed',
          message: output || 'Flutter dev server did not become ready in time.',
        });
        return;
      }

      res.json({
        ok: true,
        url: `/preview/${port}/`,
        port,
        mode: 'dev-server',
        ready,
        message: `Flutter dev preview running on port ${port}.`,
      });
    } catch (error) {
      res.status(500).json({
        error: 'serve_failed',
        message: error instanceof Error ? error.message : 'Failed to start preview server.',
      });
    }
  });

  app.get('/api/projects/:projectId/flutter/preview', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const session = flutterDevSessions.get(projectId);
    if (session?.process.exitCode === null) {
      res.json({
        ready: true,
        mode: 'dev-server',
        port: session.port,
        url: `/preview/${session.port}/`,
        output: session.output,
      });
      return;
    }

    const buildDir = path.join(projectRoot, 'build', 'web');
    if (!await exists(buildDir)) {
      res.status(404).json({ error: 'no_build', message: 'No build found. Call /flutter/build first.' });
      return;
    }

    res.json({
      ready: true,
      buildDir,
      indexUrl: '/api/projects/:projectId/flutter/preview/index.html'.replace(':projectId', projectId),
    });
  });

  app.get('/api/projects/:projectId/flutter/preview/*', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const filePath = req.params[0] || 'index.html';

    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const buildDir = path.join(projectRoot, 'build', 'web');
    const requestedFile = path.join(buildDir, filePath);

    if (!requestedFile.startsWith(buildDir)) {
      res.status(403).json({ error: 'forbidden', message: 'Path traversal detected.' });
      return;
    }

    if (!await exists(requestedFile)) {
      res.status(404).json({ error: 'not_found', message: 'File not found.' });
      return;
    }

    const ext = path.extname(requestedFile);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.dart': 'application/dart',
    };

    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.sendFile(requestedFile);
  });
}
