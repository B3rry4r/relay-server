import type { Express } from 'express';
import fs from 'node:fs';
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
import { rewritePreviewHtmlWithAuth, rewritePreviewTextWithAuth } from './preview-html';
import { hasRunningFlutterDevSessionOnPort } from './flutter-routes';


async function probePortTarget(port: number): Promise<string | null> {
  const { Socket } = await import('node:net');

  const tryConnect = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = new Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) { settled = true; socket.destroy(); resolve(ok); }
      };
      socket.setTimeout(1500);
      socket.on('connect', () => done(true));
      socket.on('error',   () => done(false));
      socket.on('timeout', () => done(false));
      socket.connect(port, host);
    });

  if (await tryConnect('127.0.0.1')) return 'http://127.0.0.1';
  if (await tryConnect('::1'))       return 'http://[::1]';
  return null;
}

export function shouldBypassPreviewTextRewrite(targetPath: string): boolean {
  return /^\/(?:dart_sdk|ddc_module_loader|stack_trace_mapper|main_module\.bootstrap|on_load_end_bootstrap)\.js(?:$|\?)/.test(targetPath)
    || /^\/dwds\//.test(targetPath)
    || /^\/(?:main\.dart|flutter_bootstrap|flutter|flutter_service_worker|firebase-messaging-sw)\.js(?:$|\?)/.test(targetPath)
    || /^\/canvaskit\//.test(targetPath)
    || /^\/assets\//.test(targetPath);
}

export function shouldRewritePreviewResponse(
  contentType: string,
  targetPath: string,
  isFlutterDebugPreview: boolean
): boolean {
  if (contentType.includes('text/html')) return true;

  // Flutter debug web-server emits many generated DDC modules under /packages.
  // Rewriting JavaScript string literals in those files corrupts the module graph
  // and leaves the app stuck after dart_sdk.js loads. The bridge injected into
  // the HTML shell already adds auth to dynamically inserted script URLs.
  if (isFlutterDebugPreview) return false;

  return !shouldBypassPreviewTextRewrite(targetPath) && (
    contentType.includes('javascript')
    || contentType.includes('text/css')
  );
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
    } catch {
      // keep default
    }
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

  app.all(/^\/preview\/(\d+)(\/.*)?$/, requireAuth, async (req, res) => {
    const port = Number(req.params[0]);
    const targetPath = req.params[1] || '/';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port', message: 'Port must be between 1 and 65535.' });
      return;
    }

    // Probe actual TCP connectivity on both IPv4 and IPv6 loopback.
    // listListeningPorts() only checks whether a port appears in /proc/net — it cannot
    // tell us which address family the server is bound to. Dev servers like Vite bind to
    // :: (IPv6 wildcard) and may refuse connections on 127.0.0.1 (IPv4), causing the
    // proxy to throw ECONNREFUSED even though the server is running.
    const targetBase = await probePortTarget(port);

    if (!targetBase) {
      res.status(502).json({
        error: 'preview_not_available',
        message: `No server is responding on port ${port}. Make sure the dev server is running.`,
      });
      return;
    }

    const httpProxy = require('http-proxy') as {
      createProxyServer(options: { target: string; changeOrigin: boolean; selfHandleResponse?: boolean }): {
        on(event: 'error', callback: (err: Error) => void): void;
        on(event: 'proxyRes', callback: (proxyRes: NodeJS.ReadableStream & { headers?: Record<string, string | string[] | undefined>; statusCode?: number }) => void): void;
        web(req: Express.Request, res: Express.Response): void;
      };
    };

    const proxy = httpProxy.createProxyServer({
      target: `${targetBase}:${port}`,
      changeOrigin: true,
      selfHandleResponse: true,
    });

    proxy.on('error', (err: Error) => {
      console.error('Preview proxy error for port', port, ':', err.message);
      res.status(502).json({ error: 'proxy_error', message: `Preview on port ${port} is not responding. Make sure the dev server is running.` });
    });

    proxy.on('proxyRes', (proxyRes: NodeJS.ReadableStream & { headers?: Record<string, string | string[] | undefined>; statusCode?: number }) => {
      const headers = { ...(proxyRes.headers || {}) };
      const contentType = String(headers['content-type'] || '');
      const statusCode = proxyRes.statusCode || 200;

      const shouldRewriteText = shouldRewritePreviewResponse(
        contentType,
        targetPath,
        hasRunningFlutterDevSessionOnPort(port)
      );

      if (!shouldRewriteText) {
        res.writeHead(statusCode, headers);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const baseHref = `/preview/${port}/`;
        const authQuery = typeof req.query.token === 'string'
          ? `token=${encodeURIComponent(req.query.token)}`
          : '';
        const rewritten = contentType.includes('text/html')
          ? rewritePreviewHtmlWithAuth(body, baseHref, authQuery)
          : rewritePreviewTextWithAuth(body, baseHref, authQuery);
        delete headers['content-length'];
        delete headers['content-encoding'];
        res.writeHead(statusCode, headers);
        res.end(rewritten);
      });
    });

    const originalUrl = new URL(req.originalUrl, 'http://relay.local');
    originalUrl.searchParams.delete('token');
    const query = originalUrl.searchParams.toString();
    req.url = `${targetPath}${query ? `?${query}` : ''}`;
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
