import type { Express } from 'express';
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
      res.json({
        ok: true,
        buildDir,
        // Tell the frontend the direct preview URL — no token needed
        previewIndexUrl: `/flutter-preview/${projectId}/index.html`,
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
    res.json({
      ready: true,
      buildDir,
      // Plain public URL — no auth, no token
      previewIndexUrl: `/flutter-preview/${projectId}/index.html`,
    });
  });

  // ── Static file serving — NO AUTH ──────────────────────────────────────
  // These routes are intentionally public. The build output is static HTML/JS/CSS —
  // there is nothing sensitive in it, and adding auth causes every asset request
  // (dart_sdk.js, main.dart.js, etc.) to fail or stall. The project ID in the URL
  // is enough to namespace the files.

  app.get('/flutter-preview/:projectId/*', async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    const rawParam = (req.params as unknown as Record<string, string | string[]>)[0]; const filePath = Array.isArray(rawParam) ? rawParam.join('/') : (rawParam || 'index.html');

    if (!projectRoot) {
      res.status(404).send('Project not found'); return;
    }

    const buildDir = path.join(projectRoot, 'build', 'web');
    const requestedFile = path.resolve(path.join(buildDir, filePath));

    // Path traversal guard
    if (!requestedFile.startsWith(path.resolve(buildDir))) {
      res.status(403).send('Forbidden'); return;
    }

    if (!await exists(requestedFile)) {
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
    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');
    // Never set X-Frame-Options — we want iframe embedding to work
    res.removeHeader('X-Frame-Options');

    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(requestedFile);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).send(err.message);
      else res.destroy();
    });
    stream.pipe(res);
  });
}
