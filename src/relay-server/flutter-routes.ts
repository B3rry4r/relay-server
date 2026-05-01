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
import { getTunnelUrl, closeTunnel } from './tunnel-manager';

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
  closeTunnel(session.port);
}

function getRunningFlutterDevSession(projectId: string): FlutterDevSession | null {
  const session = flutterDevSessions.get(projectId);
  return session?.process.exitCode === null ? session : null;
}

export function hasRunningFlutterDevSessionOnPort(port: number): boolean {
  for (const session of flutterDevSessions.values()) {
    if (session.process.exitCode === null && session.port === port) return true;
  }
  return false;
}

function writeFlutterDevCommand(projectId: string, command: 'reload' | 'restart'): FlutterDevSession | null {
  const session = getRunningFlutterDevSession(projectId);
  if (!session) return null;
  session.process.stdin.write(command === 'restart' ? 'R' : 'r');
  return session;
}

async function waitForPort(port: number, timeoutMs = 90000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ports = await listListeningPorts();
    if (ports.includes(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function hasFlutterReadyOutput(output: string, port: number): boolean {
  return output.includes(`lib/main.dart is being served at http://0.0.0.0:${port}`)
    || output.includes(`lib/main.dart is being served at http://127.0.0.1:${port}`)
    || output.includes(`A Dart VM Service on Web Server is available at`)
    || output.includes(`Flutter run key commands.`);
}

function isPortBindError(output: string): boolean {
  return output.includes('Failed to bind web development server: SocketException: Failed to create server socket')
    || output.includes('Address already in use')
    || output.includes('port = 8080');
}

function readPreviewPort(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function findAvailablePreviewPort(preferredPort = 4173): Promise<number> {
  const activePorts = new Set(await listListeningPorts());
  for (let candidate = Math.max(1024, preferredPort); candidate <= 65535; candidate += 1) {
    if (!activePorts.has(candidate)) return candidate;
  }
  throw new Error('No preview ports are available.');
}

function sanitizeFlutterOutput(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('Woah! You appear to be trying to run flutter as root.'));

  if (isPortBindError(lines.join('\n'))) {
    return 'Flutter could not start the web preview because the selected port is already in use. Choose another preview port and try again.';
  }
  return lines.slice(-12).join('\n');
}

async function ensureFlutterInstalled(workspace: string): Promise<boolean> {
  const flutterPath = getFlutterRoot(workspace);
  if (await exists(path.join(flutterPath, 'bin', 'flutter'))) return true;
  try {
    await installManagedTool(workspace, 'flutter');
    return true;
  } catch {
    return false;
  }
}

async function isFlutterProject(projectRoot: string): Promise<boolean> {
  return exists(path.join(projectRoot, 'pubspec.yaml'));
}

async function getFlutterProjectInfo(projectRoot: string) {
  if (!await isFlutterProject(projectRoot)) return null;
  const buildDir = path.join(projectRoot, 'build', 'web');
  return { isFlutter: true, buildDir, hasBuild: await exists(buildDir) };
}

export function registerFlutterRoutes(app: Express): void {
  app.get('/api/flutter/status', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    const tools = await listManagedToolStatuses(workspace);
    const flutter = tools.find(t => t.id === 'flutter');
    res.json({ installed: flutter?.installed ?? false, version: flutter?.version, home: getFlutterRoot(workspace) });
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
    if (!flutterInfo) { res.json({ isFlutter: false }); return; }
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
        cwd: projectRoot, env, maxBuffer: 100 * 1024 * 1024,
      });
      const buildDir = path.join(projectRoot, 'build', 'web');
      res.json({ ok: true, buildDir, outputFiles: await fs.readdir(buildDir), message: stdout + stderr });
    } catch (error) {
      res.status(500).json({ error: 'build_failed', message: error instanceof Error ? error.message : 'Flutter build failed.' });
    }
  });

  app.post('/api/projects/:projectId/flutter/serve', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const requestedPort = readPreviewPort(req.body?.port);

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
      const existing = getRunningFlutterDevSession(projectId);

      // Already running — get or create the tunnel and return
      if (existing) {
        const tunnelUrl = await getTunnelUrl(existing.port);
        res.json({
          ok: true,
          url: tunnelUrl,
          port: existing.port,
          mode: 'tunnel',
          ready: true,
          message: `Flutter dev preview already running at ${tunnelUrl}`,
        });
        return;
      }

      const startPort = await findAvailablePreviewPort(requestedPort ?? 4173);
      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });

      for (let candidate = startPort; candidate <= Math.min(startPort + 6, 65535); candidate += 1) {
        const child = spawn(flutterBin, [
          'run', '-d', 'web-server',
          '--web-hostname', '0.0.0.0',
          '--web-port', String(candidate),
        ], { cwd: projectRoot, env, stdio: 'pipe' });

        const session: FlutterDevSession = {
          port: candidate,
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

        const ready = await waitForPort(candidate) || hasFlutterReadyOutput(session.output, candidate);

        if (ready) {
          try {
            const tunnelUrl = await getTunnelUrl(candidate);
            res.json({
              ok: true,
              url: tunnelUrl,
              port: candidate,
              mode: 'tunnel',
              ready: true,
              message: `Flutter dev preview running at ${tunnelUrl}`,
            });
          } catch (tunnelError) {
            res.status(500).json({
              error: 'tunnel_failed',
              message: tunnelError instanceof Error ? tunnelError.message : 'Tunnel failed to start.',
            });
          }
          return;
        }

        const output = sanitizeFlutterOutput(session.output.trim());
        stopFlutterDevSession(projectId);
        if (!isPortBindError(output)) {
          res.status(500).json({ error: 'serve_failed', message: output || 'Flutter dev server did not become ready in time.' });
          return;
        }
      }

      res.status(409).json({ error: 'port_in_use', message: 'Flutter could not find a free web preview port.' });
    } catch (error) {
      res.status(500).json({ error: 'serve_failed', message: error instanceof Error ? error.message : 'Failed to start preview server.' });
    }
  });

  app.post('/api/projects/:projectId/flutter/reload', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = writeFlutterDevCommand(projectId, 'reload');
    if (!session) {
      res.status(404).json({ error: 'flutter_preview_not_running', message: 'Start the Flutter dev preview before using hot reload.' });
      return;
    }
    res.json({ ok: true, port: session.port, mode: 'tunnel', message: 'Flutter hot reload requested.' });
  });

  app.post('/api/projects/:projectId/flutter/restart', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = writeFlutterDevCommand(projectId, 'restart');
    if (!session) {
      res.status(404).json({ error: 'flutter_preview_not_running', message: 'Start the Flutter dev preview before using hot restart.' });
      return;
    }
    res.json({ ok: true, port: session.port, mode: 'tunnel', message: 'Flutter hot restart requested.' });
  });

  app.post('/api/projects/:projectId/flutter/stop', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = getRunningFlutterDevSession(projectId);
    if (!session) {
      res.json({ ok: true, running: false, message: 'Flutter dev preview is not running.' });
      return;
    }
    stopFlutterDevSession(projectId);
    res.json({ ok: true, running: false, port: session.port, message: `Flutter dev preview on port ${session.port} stopped.` });
  });

  app.get('/api/projects/:projectId/flutter/preview', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    const session = getRunningFlutterDevSession(projectId);
    if (session) {
      // Return existing tunnel URL if tunnel already running, else create one
      try {
        const tunnelUrl = await getTunnelUrl(session.port);
        res.json({ ready: true, mode: 'tunnel', port: session.port, url: tunnelUrl, output: session.output });
      } catch {
        res.json({ ready: true, mode: 'tunnel', port: session.port, url: null, output: session.output });
      }
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
      indexUrl: `/api/projects/${projectId}/flutter/preview/index.html`,
    });
  });

  // Static build file serving (release build) — no proxy, direct disk streaming
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
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!await exists(requestedFile)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
      '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
    };
    const ext = path.extname(requestedFile).toLowerCase();
    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');

    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(requestedFile);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: 'read_error', message: err.message });
      else res.destroy();
    });
    stream.pipe(res);
  });
}
