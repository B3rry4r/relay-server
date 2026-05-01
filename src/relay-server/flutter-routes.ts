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
import { rewritePreviewHtmlWithAuth } from './preview-html';
import { invalidatePortTargetCache } from './core-routes';

const execFile = promisify(execFileCallback);

type FlutterDevSession = {
  port: number;
  process: ChildProcessWithoutNullStreams;
  tunnelProcess: ChildProcessWithoutNullStreams | null;
  tunnelUrl: string | null;
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
  if (session.tunnelProcess) {
    session.tunnelProcess.kill('SIGTERM');
  }
  flutterDevSessions.delete(projectId);
  invalidatePortTargetCache(session.port);
}

function getRunningFlutterDevSession(projectId: string): FlutterDevSession | null {
  const session = flutterDevSessions.get(projectId);
  return session?.process.exitCode === null ? session : null;
}

export function hasRunningFlutterDevSessionOnPort(port: number): boolean {
  for (const session of flutterDevSessions.values()) {
    if (session.process.exitCode === null && session.port === port) {
      return true;
    }
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
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function findAvailablePreviewPort(preferredPort = 4173): Promise<number> {
  const activePorts = new Set(await listListeningPorts());
  for (let candidate = Math.max(1024, preferredPort); candidate <= 65535; candidate += 1) {
    if (!activePorts.has(candidate)) {
      return candidate;
    }
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

// Downloads cloudflared binary if not already present and returns its path.
async function ensureCloudflared(workspace: string): Promise<string> {
  const binDir = path.join(workspace, '.relay', 'bin');
  const cloudflaredBin = path.join(binDir, 'cloudflared');

  if (await exists(cloudflaredBin)) {
    return cloudflaredBin;
  }

  await fs.mkdir(binDir, { recursive: true });

  // Download the correct binary for linux amd64 (Railway runs linux/amd64)
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  await execFile('curl', ['-fsSL', '-o', cloudflaredBin, url]);
  await fs.chmod(cloudflaredBin, 0o755);

  return cloudflaredBin;
}

// Starts a cloudflared quick tunnel for the given local port.
// Resolves with the public https URL once the tunnel is ready (up to 30s).
// The returned process must be killed when the session ends.
async function startTunnel(
  cloudflaredBin: string,
  port: number,
): Promise<{ tunnelUrl: string; tunnelProcess: ChildProcessWithoutNullStreams }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cloudflaredBin, [
      'tunnel',
      '--url',
      `http://localhost:${port}`,
      '--no-autoupdate',
    ], {
      stdio: 'pipe',
    }) as ChildProcessWithoutNullStreams;

    let output = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('Cloudflare tunnel did not start within 30 seconds.'));
      }
    }, 30000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // cloudflared prints the public URL in a line like:
      //   https://xxxx.trycloudflare.com
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ tunnelUrl: match[0], tunnelProcess: child });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}. Output: ${output.slice(-500)}`));
      }
    });
  });
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

      // If already running and has a tunnel, return immediately
      if (existing && existing.tunnelUrl) {
        res.json({
          ok: true,
          url: existing.tunnelUrl,
          port: existing.port,
          mode: 'tunnel',
          ready: true,
          message: `Flutter dev preview already running at ${existing.tunnelUrl}`,
        });
        return;
      }

      if (existing) {
        stopFlutterDevSession(projectId);
      }

      const preferredPort = requestedPort ?? 4173;
      const startPort = await findAvailablePreviewPort(preferredPort);

      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });

      for (let candidate = startPort; candidate <= Math.min(startPort + 6, 65535); candidate += 1) {
        const child = spawn(flutterBin, [
          'run',
          '-d',
          'web-server',
          '--web-hostname',
          '0.0.0.0',
          '--web-port',
          String(candidate),
        ], {
          cwd: projectRoot,
          env,
          stdio: 'pipe',
        });

        const session: FlutterDevSession = {
          port: candidate,
          process: child,
          tunnelProcess: null,
          tunnelUrl: null,
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
          // Flutter is up — now start the tunnel so the browser can reach it directly
          try {
            const cloudflaredBin = await ensureCloudflared(workspace);
            const { tunnelUrl, tunnelProcess } = await startTunnel(cloudflaredBin, candidate);

            session.tunnelUrl = tunnelUrl;
            session.tunnelProcess = tunnelProcess;

            tunnelProcess.on('exit', () => {
              // If the tunnel dies but Flutter is still running, clear the URL
              // so the next status check knows it needs a new tunnel
              if (flutterDevSessions.get(projectId)?.process === child) {
                session.tunnelUrl = null;
                session.tunnelProcess = null;
              }
            });

            res.json({
              ok: true,
              url: tunnelUrl,
              port: candidate,
              mode: 'tunnel',
              ready: true,
              message: `Flutter dev preview running at ${tunnelUrl}`,
            });
          } catch (tunnelError) {
            // Tunnel failed — fall back to the relay proxy URL so something works
            res.json({
              ok: true,
              url: `/preview/${candidate}/`,
              port: candidate,
              mode: 'proxy',
              ready: true,
              tunnelError: tunnelError instanceof Error ? tunnelError.message : 'Tunnel failed',
              message: `Flutter dev preview running on port ${candidate} (tunnel unavailable, using proxy).`,
            });
          }
          return;
        }

        const output = sanitizeFlutterOutput(session.output.trim());
        stopFlutterDevSession(projectId);
        if (!isPortBindError(output)) {
          res.status(500).json({
            error: 'serve_failed',
            message: output || 'Flutter dev server did not become ready in time.',
          });
          return;
        }
      }

      res.status(409).json({
        error: 'port_in_use',
        message: 'Flutter could not find a free web preview port. Choose another preview port and try again.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'serve_failed',
        message: error instanceof Error ? error.message : 'Failed to start preview server.',
      });
    }
  });

  app.post('/api/projects/:projectId/flutter/reload', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = writeFlutterDevCommand(projectId, 'reload');

    if (!session) {
      res.status(404).json({
        error: 'flutter_preview_not_running',
        message: 'Start the Flutter dev preview before using hot reload.',
      });
      return;
    }

    res.json({
      ok: true,
      port: session.port,
      mode: 'tunnel',
      message: 'Flutter hot reload requested.',
    });
  });

  app.post('/api/projects/:projectId/flutter/restart', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = writeFlutterDevCommand(projectId, 'restart');

    if (!session) {
      res.status(404).json({
        error: 'flutter_preview_not_running',
        message: 'Start the Flutter dev preview before using hot restart.',
      });
      return;
    }

    res.json({
      ok: true,
      port: session.port,
      mode: 'tunnel',
      message: 'Flutter hot restart requested.',
    });
  });

  app.post('/api/projects/:projectId/flutter/stop', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = getRunningFlutterDevSession(projectId);

    if (!session) {
      res.json({
        ok: true,
        running: false,
        message: 'Flutter dev preview is not running.',
      });
      return;
    }

    stopFlutterDevSession(projectId);
    res.json({
      ok: true,
      running: false,
      port: session.port,
      message: `Flutter dev preview on port ${session.port} stopped.`,
    });
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
      res.json({
        ready: true,
        mode: session.tunnelUrl ? 'tunnel' : 'proxy',
        port: session.port,
        url: session.tunnelUrl ?? `/preview/${session.port}/`,
        tunnelUrl: session.tunnelUrl,
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

    const ext = path.extname(requestedFile).toLowerCase();

    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
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
      '.wasm': 'application/wasm',
      '.dart': 'application/dart',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    if (ext === '.html') {
      const html = await fs.readFile(requestedFile, 'utf8');
      const authQuery = typeof req.query.token === 'string'
        ? `token=${encodeURIComponent(req.query.token)}`
        : '';
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(rewritePreviewHtmlWithAuth(
        html,
        `/api/projects/${projectId}/flutter/preview/`,
        authQuery,
      ));
      return;
    }

    // Stream directly from disk — no rewriting, no proxy, no auth per-asset
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache');

    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(requestedFile);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'read_error', message: err.message });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}
