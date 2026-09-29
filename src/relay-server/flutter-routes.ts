import type { Express, Request } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
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
import { rewritePreviewHtml } from './preview-html';
import { startFlutterPreviewServer, stopFlutterPreviewServer, getFlutterPreviewPort } from './flutter-preview-server';
import { getTunnelUrl } from './tunnel-manager';
import { previewBindingFor } from './auth';
import { mintPreviewCap } from './auth/preview-cap';

/**
 * The relay-served preview URL for the CALLER: `/flutter-preview/<id>/c/<cap>/index.html`
 * where <cap> is a 12 h path capability bound to the caller's session (revoking the
 * session kills it). The iframe needs no header; every asset inherits the cap via
 * the rewritten <base href>.
 */
function previewIndexUrlFor(req: Request, projectId: string): string {
  const binding = previewBindingFor(req.auth);
  if (!binding) return '';
  const { cap } = mintPreviewCap(projectId, binding);
  return `/flutter-preview/${encodeURIComponent(projectId)}/c/${cap}/index.html`;
}

const execFile = promisify(execFileCallback);

async function isFlutterProject(projectRoot: string): Promise<boolean> {
  return exists(path.join(projectRoot, 'pubspec.yaml'));
}

async function ensureFlutterInstalled(workspace: string): Promise<boolean> {
  const flutterPath = getFlutterRoot(workspace);
  if (await exists(path.join(flutterPath, 'bin', 'flutter'))) return true;
  try {
    await installManagedTool(workspace, 'flutter');
    return true;
  } catch { return false; }
}

// No longer used — kept so hasRunningFlutterDevSessionOnPort callers don't break
export function hasRunningFlutterDevSessionOnPort(_port: number): boolean {
  return false;
}

export function registerFlutterRoutes(app: Express): void {

  // ── SDK status ─────────────────────────────────────────────────────────
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

  // ── SDK install ────────────────────────────────────────────────────────
  app.post('/api/flutter/install', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    try {
      await installManagedTool(workspace, 'flutter');
      const tools = await listManagedToolStatuses(workspace);
      res.json({ ok: true, flutter: tools.find(t => t.id === 'flutter') });
    } catch (error) {
      res.status(500).json({
        error: 'flutter_install_failed',
        message: error instanceof Error ? error.message : 'Failed to install Flutter',
      });
    }
  });

  // ── Project info ───────────────────────────────────────────────────────
  app.get('/api/projects/:projectId/flutter', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found' }); return;
    }
    if (!await isFlutterProject(projectRoot)) {
      res.json({ isFlutter: false }); return;
    }
    const buildDir = path.join(projectRoot, 'build', 'web');
    res.json({
      isFlutter: true,
      buildDir,
      hasBuild: await exists(buildDir),
    });
  });

  // ── Release build ──────────────────────────────────────────────────────
  app.post('/api/projects/:projectId/flutter/build', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found' }); return;
    }
    if (!await isFlutterProject(projectRoot)) {
      res.status(400).json({ error: 'not_flutter_project' }); return;
    }
    const workspace = resolveWorkspace();
    if (!await ensureFlutterInstalled(workspace)) {
      res.status(503).json({ error: 'flutter_not_installed' }); return;
    }
    const flutterBin = path.join(getFlutterRoot(workspace), 'bin', 'flutter');
    const env = createTerminalEnv(workspace);
    try {
      await execFile(flutterBin, ['pub', 'get'], { cwd: projectRoot, env });
      const { stdout, stderr } = await execFile(
        flutterBin, ['build', 'web', '--release'],
        { cwd: projectRoot, env, maxBuffer: 100 * 1024 * 1024 }
      );
      const buildDir = path.join(projectRoot, 'build', 'web');

      // Restart preview server so it picks up the fresh build.
      await stopFlutterPreviewServer(projectId);
      let tunnelUrl: string | null = null;
      try {
        const port = await startFlutterPreviewServer(projectId, buildDir);
        tunnelUrl = await getTunnelUrl(port);
      } catch (tunnelErr) {
        // Don't fail the build response if tunnel setup fails — frontend can
        // still fall back to the relay-served previewIndexUrl below.
        // eslint-disable-next-line no-console
        console.warn('[flutter] tunnel setup failed:', tunnelErr instanceof Error ? tunnelErr.message : tunnelErr);
      }

      res.json({
        ok: true,
        buildDir,
        // Direct iframe URL — bypasses relay-server's HTTP origin entirely
        previewTunnelUrl: tunnelUrl,
        // Relay-served fallback, under a session-bound path capability.
        previewIndexUrl: previewIndexUrlFor(req, projectId),
        outputFiles: await fs.readdir(buildDir),
        message: stdout + stderr,
      });
    } catch (error) {
      res.status(500).json({
        error: 'build_failed',
        message: error instanceof Error ? error.message : 'Flutter build failed.',
      });
    }
  });

  // ── Preview status ─────────────────────────────────────────────────────
  app.get('/api/projects/:projectId/flutter/preview', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found' }); return;
    }
    const buildDir = path.join(projectRoot, 'build', 'web');
    if (!await exists(buildDir)) {
      res.status(404).json({ error: 'no_build', message: 'Run a release build first.' }); return;
    }

    // Ensure the static preview server is running and tunneled.
    let tunnelUrl: string | null = null;
    try {
      let port = getFlutterPreviewPort(projectId);
      if (!port) port = await startFlutterPreviewServer(projectId, buildDir);
      tunnelUrl = await getTunnelUrl(port);
    } catch (tunnelErr) {
      // eslint-disable-next-line no-console
      console.warn('[flutter] preview tunnel setup failed:', tunnelErr instanceof Error ? tunnelErr.message : tunnelErr);
    }

    res.json({
      ready: true,
      buildDir,
      previewTunnelUrl: tunnelUrl,
      previewIndexUrl: previewIndexUrlFor(req, projectId),
    });
  });

  // ── Stop a project's preview server (for project switch / cleanup) ───
  app.post('/api/projects/:projectId/flutter/preview/stop', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    await stopFlutterPreviewServer(projectId);
    res.json({ ok: true });
  });

  // ── Static file serving — PATH CAPABILITY ─────────────────────────────
  // An iframe cannot send a header and a Flutter web build is dozens of requests
  // (plus DDC-injected scripts), so the preview is served under a multi-use,
  // project-scoped, 12 h capability in the PATH. The default-deny middleware
  // verifies <cap> for <projectId> BEFORE this handler runs (auth/index.ts) and
  // sets req.auth = { via: 'preview-cap', projectId }.
  app.get('/flutter-preview/:projectId/c/:cap/*', async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const cap = readStringParam(req.params.cap);
    if (req.auth?.via !== 'preview-cap' || req.auth.projectId !== projectId) {
      res.status(403).send('Forbidden'); return;
    }
    const projectRoot = resolveProjectRoot(projectId);
    const rawParam = (req.params as unknown as Record<string, string | string[]>)[0];
    const filePath = Array.isArray(rawParam) ? rawParam.join('/') : (rawParam || 'index.html');

    if (!projectRoot) {
      res.status(404).send('Project not found'); return;
    }

    const buildDir = path.resolve(path.join(projectRoot, 'build', 'web'));
    const requestedFile = path.resolve(path.join(buildDir, filePath));

    // Path traversal guard (with the separator: `build/web2` must not pass).
    if (requestedFile !== buildDir && !requestedFile.startsWith(`${buildDir}${path.sep}`)) {
      res.status(403).send('Forbidden'); return;
    }

    if (!await exists(requestedFile) || (await fs.stat(requestedFile)).isDirectory()) {
      res.status(404).send('Not found'); return;
    }

    const mimeTypes: Record<string, string> = {
      '.html':  'text/html; charset=utf-8',
      '.js':    'application/javascript',
      '.mjs':   'application/javascript',
      '.css':   'text/css',
      '.json':  'application/json',
      '.png':   'image/png',
      '.jpg':   'image/jpeg',
      '.jpeg':  'image/jpeg',
      '.gif':   'image/gif',
      '.svg':   'image/svg+xml',
      '.ico':   'image/x-icon',
      '.woff':  'font/woff',
      '.woff2': 'font/woff2',
      '.ttf':   'font/ttf',
      '.wasm':  'application/wasm',
      '.map':   'application/json',
    };

    const ext = path.extname(requestedFile).toLowerCase();
    res.set('Cache-Control', 'no-cache');
    // Never set X-Frame-Options — we want iframe embedding to work
    res.removeHeader('X-Frame-Options');
    // The capability is in the URL: never leak it to third parties via Referer.
    res.set('Referrer-Policy', 'no-referrer');

    // For HTML files, rewrite the <base href> so that all asset paths
    // (dart_sdk.js, main.dart.js, flutter.js, etc.) resolve relative to
    // this route's prefix instead of the server root "/".
    // Flutter's web build always bakes in <base href="/"> which makes every
    // asset request go to /{asset} → 404, because the files are actually
    // served under /flutter-preview/:projectId/{asset}.
    if (ext === '.html') {
      const baseHref = `/flutter-preview/${encodeURIComponent(projectId)}/c/${cap}/`;
      const raw = await fs.readFile(requestedFile, 'utf-8');
      const rewritten = rewritePreviewHtml(raw, baseHref);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(rewritten);
      return;
    }

    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(requestedFile);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).send(err.message);
      else res.destroy();
    });
    stream.pipe(res);
  });
}
