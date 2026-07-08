import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createTerminalEnv, requireAuth, extractRequestToken, isValidToken, readStringParam, resolveWorkspace } from './runtime';
import { getWorkspaceHealth } from './monitoring';
import {
  buildQuickSwitchProjects,
  getPinnedProjects,
  listListeningPorts,
  listProjects,
  markProjectAsRecent,
  setPinnedProjects,
} from './projects';
import { exists, resolveProjectRoot } from './runtime';
import { getActiveTerminals } from './socket';
import { fetchRemoteTerminals, isRemotePtyEnabled } from './remote-pty';
import { getTunnelUrl, closeTunnel, listTunnels } from './tunnel-manager';
import { listFlutterPreviewServers, stopFlutterPreviewServer, startStaticPreviewServer } from './flutter-preview-server';
import { buildWebOutput, detectProjectKind, readWebPreviewRoute } from './web-preview';

// Kept for flutter-routes compatibility — now delegates to closeTunnel.
export function invalidatePortTargetCache(port: number): void {
  closeTunnel(port);
}

export function registerCoreRoutes(app: Express): void {
  app.get('/', (_req, res) => {
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

  app.get('/api/version', (_req, res) => {
    const packagePath = path.join(process.cwd(), 'package.json');
    let version = 'unknown';
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      version = packageJson.version || 'unknown';
    } catch { /* keep default */ }
    res.json({ version });
  });

  app.get('/api/auth/validate', (req, res) => {
    if (!isValidToken(extractRequestToken(req))) {
      res.status(401).json({ error: 'unauthorized', message: 'A valid auth token is required.' });
      return;
    }
    res.json({ authenticated: true });
  });

  app.get('/api/bootstrap/status', requireAuth, async (_req, res) => {
    res.json(await getWorkspaceHealth());
  });

  app.get('/api/projects', requireAuth, async (_req, res) => {
    res.json({ projects: await listProjects() });
  });

  app.get('/api/projects/quick-switch', requireAuth, async (_req, res) => {
    res.json({ projects: await buildQuickSwitchProjects() });
  });

  app.post('/api/projects/:projectId/pin', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    const pinned = Boolean(req.body?.pinned);
    const current = await getPinnedProjects();
    const next = pinned
      ? Array.from(new Set([...current, projectId]))
      : current.filter((v) => v !== projectId);
    await setPinnedProjects(next);
    res.json({ projectId, pinned });
  });

  app.post('/api/session/project', requireAuth, async (req, res) => {
    const projectId = String(req.body?.projectId || '');
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    await markProjectAsRecent(projectId);
    res.json({
      project: { id: path.basename(projectRoot), path: projectRoot },
      shell: {
        cwd: projectRoot,
        cdCommand: `cd '${projectRoot}'`,
        cdEvent: { projectId },
      },
    });
  });

  // List all active ports, including any already-running tunnel URLs.
  app.get('/api/previews', requireAuth, async (_req, res) => {
    const ports = await listListeningPorts();
    const tunnelByPort = new Map(listTunnels().map(t => [t.port, t.url]));
    res.json({
      previews: ports.map((port) => ({
        port,
        label: `Port ${port}`,
        url: tunnelByPort.get(port) ?? null,
        status: 'active',
      })),
    });
  });

  app.get('/api/previews/:port', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }
    const ports = await listListeningPorts();
    const tunnel = listTunnels().find(t => t.port === port);
    res.json({ port, active: ports.includes(port), url: tunnel?.url ?? null, label: `Port ${port}` });
  });

  // Close a preview "port card". When the port is a relay-managed preview server
  // (a served Flutter release build), the server is actually STOPPED (tunnel too).
  // A user's own dev server (started in a terminal) is never killed from here —
  // the client just hides the card locally until the next rescan.
  app.delete('/api/previews/:port', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }
    const managed = listFlutterPreviewServers().find((s) => s.port === port);
    if (managed) {
      await stopFlutterPreviewServer(managed.projectId);
      res.json({ ok: true, port, managed: true, message: 'Preview server stopped.' });
      return;
    }
    res.json({ ok: true, port, managed: false, message: 'Not a relay-managed preview; hide the card client-side.' });
  });

  // ── Web live preview ─────────────────────────────────────────────────────
  // One-tap live preview for GENERATED WEB (Vite/React, Next static-export)
  // projects — the web counterpart of Flutter's "Build release → Release
  // preview". Builds the project if the output is missing/stale (build-once
  // fingerprint cache; concurrent calls coalesce), serves the static output on
  // a relay-managed preview server (same map as Flutter previews, so the port
  // card + DELETE /api/previews/:port close behavior work for free) and exposes
  // it via a cloudflared tunnel.
  app.post('/api/previews/web/:projectId', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    const kind = await detectProjectKind(projectRoot);
    if (kind === 'flutter') {
      res.status(400).json({
        error: 'flutter_project',
        message: 'This is a Flutter project — use the Flutter Release preview (POST /api/projects/:projectId/flutter/build).',
      });
      return;
    }
    if (kind !== 'web') {
      res.status(400).json({
        error: 'not_web_project',
        message: 'Not a web project: package.json with a "build" script is required.',
      });
      return;
    }
    const env = createTerminalEnv(resolveWorkspace());
    const built = await buildWebOutput(projectRoot, env);
    if (built.error !== undefined) {
      res.status(502).json({ error: 'build_failed', message: built.error });
      return;
    }
    try {
      const port = await startStaticPreviewServer(projectId, built.outDir);
      // Tunnel exposure is best-effort — the localhost port alone is enough for
      // the client (openPreview re-resolves a tunnel via /api/previews/:port/tunnel).
      let url: string | null = null;
      try { url = await getTunnelUrl(port); }
      catch (tunnelErr) {
        console.warn('[web-preview] tunnel setup failed:', tunnelErr instanceof Error ? tunnelErr.message : tunnelErr);
      }
      const route = await readWebPreviewRoute(projectRoot);
      res.json({ ok: true, projectId, port, url, route, outDir: built.outDir });
    } catch (error) {
      res.status(500).json({
        error: 'preview_start_failed',
        message: error instanceof Error ? error.message : 'Failed to start the preview server.',
      });
    }
  });

  // Returns (or creates) a Cloudflare quick tunnel for a local port.
  // The frontend should load the returned tunnelUrl directly in an iframe — no proxy.
  app.get('/api/previews/:port/tunnel', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }
    const ports = await listListeningPorts();
    if (!ports.includes(port)) {
      res.status(502).json({
        error: 'port_not_active',
        message: `No server is running on port ${port}. Start your dev server first.`,
      });
      return;
    }
    try {
      const tunnelUrl = await getTunnelUrl(port);
      res.json({ ok: true, port, tunnelUrl });
    } catch (error) {
      res.status(500).json({
        error: 'tunnel_failed',
        message: error instanceof Error ? error.message : 'Failed to start tunnel.',
      });
    }
  });

  // Legacy proxy route — replaced by tunnel. Returns a clear error so the frontend
  // knows to use /api/previews/:port/tunnel instead.
  app.all(/^\/preview\/(\d+)(\/.*)?$/, requireAuth, (_req, res) => {
    res.status(410).json({
      error: 'proxy_removed',
      message: 'The /preview proxy has been replaced by Cloudflare tunnels. Use GET /api/previews/:port/tunnel to get a direct URL.',
    });
  });

  app.post('/api/previews/:port/serve', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }
    const ports = await listListeningPorts();
    if (ports.includes(port)) {
      res.json({ ok: true, port, message: 'Port already in use.' });
      return;
    }
    const workspace = resolveWorkspace();
    const { spawn } = await import('node:child_process');
    spawn('python3', ['-m', 'http.server', String(port)], {
      cwd: workspace, detached: true, stdio: 'ignore',
    });
    res.json({ ok: true, port, message: `Preview server starting on port ${port}` });
  });

  app.get('/api/workspace/health', requireAuth, async (_req, res) => {
    res.json(await getWorkspaceHealth());
  });

  app.get('/api/terminals', requireAuth, async (_req, res) => {
    // Remote PTY mode: the standalone relay-pty service owns the sessions —
    // report ITS list. No silent fallback to the (empty) embedded map: an
    // unreachable service is surfaced as an explicit 502.
    if (isRemotePtyEnabled()) {
      try {
        res.json({ terminals: await fetchRemoteTerminals() });
      } catch (error) {
        console.error('[relay] /api/terminals: remote PTY service unreachable:', error);
        res.status(502).json({
          error: 'pty_service_unreachable',
          message: `Remote PTY service unreachable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    const terminals = getActiveTerminals();
    res.json({
      terminals: terminals.map((t) => ({ id: t.id, cwd: t.cwd, pid: t.pid, createdAt: t.createdAt })),
    });
  });
}
