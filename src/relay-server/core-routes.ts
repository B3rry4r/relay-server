import type { Express } from 'express';
import path from 'node:path';
import { requireAuth, extractRequestToken, isValidToken, readStringParam, resolveWorkspace } from './runtime';
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
      : current.filter((value) => value !== projectId);
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

  app.get('/api/previews', requireAuth, async (_req, res) => {
    const ports = await listListeningPorts();
    res.json({
      previews: ports.map((port) => ({
        port,
        label: `Port ${port}`,
        url: `/preview/${port}`,
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
    const isActive = ports.includes(port);

    res.json({
      port,
      active: isActive,
      url: `/preview/${port}`,
      label: `Port ${port}`,
    });
  });

  app.post('/api/previews/:port/serve', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const ports = await listListeningPorts();
    if (ports.includes(port)) {
      res.json({ ok: true, port, message: 'Port already in use.' });
      return;
    }

    const workspace = resolveWorkspace();
    const { spawn } = await import('node:child_process');
    spawn('python3', ['-m', 'http.server', String(port)], {
      cwd: workspace,
      detached: true,
      stdio: 'ignore',
    });

    setTimeout(async () => {
      const updatedPorts = await listListeningPorts();
      if (updatedPorts.includes(port)) {
        console.log(`Preview server started on port ${port}`);
      }
    }, 1000);

    res.json({ ok: true, port, message: `Preview server starting on port ${port}` });
  });

  app.all('/preview/:port(*)', requireAuth, async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }

    const ports = await listListeningPorts();
    if (!ports.includes(port)) {
      res.status(502).json({ error: 'preview_not_available', message: `No server running on port ${port}` });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpProxy = require('http-proxy') as {
      createProxyServer(options: { target: string; changeOrigin: boolean }): {
        on(event: 'error', callback: (err: Error) => void): void;
        web(req: Express.Request, res: Express.Response): void;
      };
    };

    const proxy = httpProxy.createProxyServer({
      target: `http://127.0.0.1:${port}`,
      changeOrigin: true,
    });

    proxy.on('error', (err: Error) => {
      console.error('Preview proxy error:', err.message);
      res.status(502).json({ error: 'proxy_error', message: 'Failed to proxy request' });
    });

    proxy.web(req, res);
  });

  app.get('/api/workspace/health', requireAuth, async (_req, res) => {
    res.json(await getWorkspaceHealth());
  });

  app.get('/api/terminals', requireAuth, (_req, res) => {
    const terminals = getActiveTerminals();
    res.json({
      terminals: terminals.map((t) => ({
        id: t.id,
        cwd: t.cwd,
        pid: t.pid,
        createdAt: t.createdAt,
      })),
    });
  });
}
