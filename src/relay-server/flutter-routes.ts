import express, { type Express } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
import {
  startScreenSession,
  stopScreenSession,
  getScreenSession,
  sendFlutterScreenCommand,
  getNoVNCDir,
} from './flutter-screen';

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// Web-server dev session (tunnel-based, kept for reference / fallback)
// ---------------------------------------------------------------------------

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

function writeFlutterDevCommand(projectId: string, command: 'reload' | 'restart'): boolean {
  // Screen session (Chrome mode) takes priority
  if (sendFlutterScreenCommand(projectId, command === 'restart' ? 'R' : 'r')) return true;
  // Fall back to web-server session
  const session = getRunningFlutterDevSession(projectId);
  if (!session) return false;
  session.process.stdin.write(command === 'restart' ? 'R' : 'r');
  return true;
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
  return output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('Woah! You appear to be trying to run flutter as root.'))
    .slice(-12)
    .join('\n');
}

async function ensureFlutterInstalled(workspace: string): Promise<boolean> {
  const flutterPath = getFlutterRoot(workspace);
  if (await exists(path.join(flutterPath, 'bin', 'flutter'))) return true;
  try {
    await installManagedTool(workspace, 'flutter');
    return true;
  } catch { return false; }
}

async function isFlutterProject(projectRoot: string): Promise<boolean> {
  return exists(path.join(projectRoot, 'pubspec.yaml'));
}

async function getFlutterProjectInfo(projectRoot: string) {
  if (!await isFlutterProject(projectRoot)) return null;
  const buildDir = path.join(projectRoot, 'build', 'web');
  return { isFlutter: true, buildDir, hasBuild: await exists(buildDir) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerFlutterRoutes(app: Express): void {

  // ── SDK status / install ────────────────────────────────────────────────

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
      res.json({ ok: true, flutter: tools.find(t => t.id === 'flutter') });
    } catch (error) {
      res.status(500).json({ error: 'flutter_install_failed', message: error instanceof Error ? error.message : 'Failed to install Flutter' });
    }
  });

  // ── Project info ────────────────────────────────────────────────────────

  app.get('/api/projects/:projectId/flutter', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }
    const info = await getFlutterProjectInfo(projectRoot);
    if (!info) { res.json({ isFlutter: false }); return; }
    res.json(info);
  });

  // ── Build ───────────────────────────────────────────────────────────────

  app.post('/api/projects/:projectId/flutter/build', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }
    if (!await isFlutterProject(projectRoot)) { res.status(400).json({ error: 'not_flutter_project' }); return; }
    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) { res.status(503).json({ error: 'flutter_not_installed' }); return; }
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
      res.status(500).json({ error: 'build_failed', message: error instanceof Error ? error.message : 'Build failed.' });
    }
  });

  // ── Screen stream: serve noVNC static files ─────────────────────────────
  // GET /api/flutter/novnc/*  →  serves noVNC HTML/JS/CSS from disk

  app.get('/api/flutter/novnc/*', requireAuth, async (req, res) => {
    try {
      const novncDir = await getNoVNCDir();
      const filePath = req.params[0] || 'vnc.html';
      const fullPath = path.join(novncDir, filePath);

      // Path traversal guard
      if (!fullPath.startsWith(novncDir)) { res.status(403).end(); return; }
      if (!await exists(fullPath)) { res.status(404).end(); return; }

      const mimeMap: Record<string, string> = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css',   '.ico': 'image/x-icon',
        '.png': 'image/png',  '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
      };
      res.set('Content-Type', mimeMap[path.extname(fullPath)] || 'application/octet-stream');
      res.set('Cache-Control', 'no-cache');
      const { createReadStream } = await import('node:fs');
      createReadStream(fullPath).pipe(res);
    } catch (error) {
      res.status(500).json({ error: 'novnc_error', message: error instanceof Error ? error.message : 'noVNC serve error' });
    }
  });

  // ── Screen stream: WebSocket proxy to websockify ─────────────────────────
  // The noVNC client connects to wss://.../api/flutter/screen/:projectId/ws
  // We upgrade the HTTP request to a raw TCP tunnel into websockify's port.

  app.get('/api/projects/:projectId/flutter/screen/ws', requireAuth, (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = getScreenSession(projectId);
    if (!session) {
      res.status(404).json({ error: 'screen_not_running', message: 'No screen session running for this project.' });
      return;
    }
    // The actual WebSocket upgrade is handled by the HTTP server upgrade event
    // registered in relay-server.ts. We just need the session wsPort to be known.
    // Respond with the wsPort so the frontend can construct the correct WS URL.
    res.json({ wsPort: session.wsPort, ready: session.ready });
  });

  // ── Screen stream: start ────────────────────────────────────────────────

  app.post('/api/projects/:projectId/flutter/screen/start', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }
    if (!await isFlutterProject(projectRoot)) { res.status(400).json({ error: 'not_flutter_project' }); return; }

    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) { res.status(503).json({ error: 'flutter_not_installed' }); return; }

    // If already running, return current session info
    const existing = getScreenSession(projectId);
    if (existing) {
      res.json({
        ok: true,
        mode: 'screen',
        wsPort: existing.wsPort,
        display: existing.display,
        novncPath: `/api/flutter/novnc/vnc.html`,
        message: 'Screen session already running.',
      });
      return;
    }

    const flutterBin = path.join(getFlutterRoot(workspace), 'bin', 'flutter');
    const env = createTerminalEnv(workspace);

    try {
      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });
      const session = await startScreenSession(projectId, projectRoot, flutterBin, env);
      res.json({
        ok: true,
        mode: 'screen',
        wsPort: session.wsPort,
        display: session.display,
        novncPath: `/api/flutter/novnc/vnc.html`,
        message: 'Flutter screen session started.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'screen_start_failed',
        message: error instanceof Error ? error.message : 'Failed to start screen session.',
      });
    }
  });

  // ── Screen stream: stop ─────────────────────────────────────────────────

  app.post('/api/projects/:projectId/flutter/screen/stop', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = getScreenSession(projectId);
    if (!session) { res.json({ ok: true, running: false }); return; }
    await stopScreenSession(projectId);
    res.json({ ok: true, running: false, message: 'Screen session stopped.' });
  });

  // ── Screen stream: status ───────────────────────────────────────────────

  app.get('/api/projects/:projectId/flutter/screen/status', requireAuth, (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const session = getScreenSession(projectId);
    if (!session) { res.json({ running: false }); return; }
    res.json({
      running: true,
      ready: session.ready,
      wsPort: session.wsPort,
      display: session.display,
      novncPath: `/api/flutter/novnc/vnc.html`,
      output: session.output.slice(-3000),
    });
  });

  // ── Hot reload / restart ────────────────────────────────────────────────

  app.post('/api/projects/:projectId/flutter/reload', requireAuth, (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    if (!writeFlutterDevCommand(projectId, 'reload')) {
      res.status(404).json({ error: 'flutter_preview_not_running' }); return;
    }
    res.json({ ok: true, message: 'Flutter hot reload requested.' });
  });

  app.post('/api/projects/:projectId/flutter/restart', requireAuth, (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    if (!writeFlutterDevCommand(projectId, 'restart')) {
      res.status(404).json({ error: 'flutter_preview_not_running' }); return;
    }
    res.json({ ok: true, message: 'Flutter hot restart requested.' });
  });

  // ── Stop all (unified) ──────────────────────────────────────────────────

  app.post('/api/projects/:projectId/flutter/stop', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const screenSession = getScreenSession(projectId);
    const devSession = getRunningFlutterDevSession(projectId);
    if (!screenSession && !devSession) { res.json({ ok: true, running: false }); return; }
    if (screenSession) await stopScreenSession(projectId);
    if (devSession) stopFlutterDevSession(projectId);
    res.json({ ok: true, running: false, message: 'Flutter preview stopped.' });
  });

  // ── Serve (web-server / tunnel fallback) ───────────────────────────────

  app.post('/api/projects/:projectId/flutter/serve', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const requestedPort = readPreviewPort(req.body?.port);
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }
    if (!await isFlutterProject(projectRoot)) { res.status(400).json({ error: 'not_flutter_project' }); return; }
    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) { res.status(503).json({ error: 'flutter_not_installed' }); return; }
    const flutterBin = path.join(getFlutterRoot(workspace), 'bin', 'flutter');
    const env = createTerminalEnv(workspace);
    try {
      const existing = getRunningFlutterDevSession(projectId);
      if (existing) {
        const tunnelUrl = await getTunnelUrl(existing.port);
        res.json({ ok: true, url: tunnelUrl, port: existing.port, mode: 'tunnel', ready: true, message: `Already running at ${tunnelUrl}` });
        return;
      }
      const startPort = await findAvailablePreviewPort(requestedPort ?? 4173);
      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });
      for (let candidate = startPort; candidate <= Math.min(startPort + 6, 65535); candidate += 1) {
        const child = spawn(flutterBin, ['run', '-d', 'web-server', '--web-hostname', '0.0.0.0', '--web-port', String(candidate)], {
          cwd: projectRoot, env, stdio: 'pipe',
        });
        const session: FlutterDevSession = { port: candidate, process: child, projectId, projectRoot, startedAt: Date.now(), output: '' };
        flutterDevSessions.set(projectId, session);
        child.stdout.on('data', (c: Buffer) => appendSessionOutput(session, c));
        child.stderr.on('data', (c: Buffer) => appendSessionOutput(session, c));
        child.on('exit', () => { if (flutterDevSessions.get(projectId)?.process === child) flutterDevSessions.delete(projectId); });
        const ready = await waitForPort(candidate);
        if (ready) {
          const tunnelUrl = await getTunnelUrl(candidate);
          res.json({ ok: true, url: tunnelUrl, port: candidate, mode: 'tunnel', ready: true, message: `Flutter dev preview running at ${tunnelUrl}` });
          return;
        }
        const output = sanitizeFlutterOutput(session.output.trim());
        stopFlutterDevSession(projectId);
        if (!isPortBindError(output)) { res.status(500).json({ error: 'serve_failed', message: output || 'Flutter dev server did not become ready.' }); return; }
      }
      res.status(409).json({ error: 'port_in_use', message: 'Flutter could not find a free web preview port.' });
    } catch (error) {
      res.status(500).json({ error: 'serve_failed', message: error instanceof Error ? error.message : 'Failed to start preview.' });
    }
  });

  // ── Preview status ──────────────────────────────────────────────────────

  app.get('/api/projects/:projectId/flutter/preview', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }

    const screenSession = getScreenSession(projectId);
    if (screenSession) {
      res.json({ ready: screenSession.ready, mode: 'screen', wsPort: screenSession.wsPort, novncPath: '/api/flutter/novnc/vnc.html', output: screenSession.output.slice(-3000) });
      return;
    }
    const devSession = getRunningFlutterDevSession(projectId);
    if (devSession) {
      try {
        const tunnelUrl = await getTunnelUrl(devSession.port);
        res.json({ ready: true, mode: 'tunnel', port: devSession.port, url: tunnelUrl, output: devSession.output });
      } catch {
        res.json({ ready: true, mode: 'tunnel', port: devSession.port, url: null, output: devSession.output });
      }
      return;
    }
    const buildDir = path.join(projectRoot, 'build', 'web');
    if (!await exists(buildDir)) { res.status(404).json({ error: 'no_build' }); return; }
    res.json({ ready: true, buildDir, indexUrl: `/api/projects/${projectId}/flutter/preview/index.html` });
  });

  // ── Static build file serving ───────────────────────────────────────────

  app.get('/api/projects/:projectId/flutter/preview/*', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const filePath = req.params[0] || 'index.html';
    if (!projectRoot || !await exists(projectRoot)) { res.status(404).json({ error: 'project_not_found' }); return; }
    const buildDir = path.join(projectRoot, 'build', 'web');
    const requestedFile = path.join(buildDir, filePath);
    if (!requestedFile.startsWith(buildDir)) { res.status(403).json({ error: 'forbidden' }); return; }
    if (!await exists(requestedFile)) { res.status(404).json({ error: 'not_found' }); return; }
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
    };
    res.set('Content-Type', mimeTypes[path.extname(requestedFile)] || 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');
    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(requestedFile);
    stream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.destroy(); });
    stream.pipe(res);
  });
}
