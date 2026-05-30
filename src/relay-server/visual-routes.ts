// =============================================================================
// File: src/relay-server/visual-routes.ts
//
// Visual-diff support for the UIX codegen validation loop. Provides the Flutter
// candidate render that UIX can't do itself: scaffold a scratch Flutter web app
// around the generated widget, build it, and screenshot it with headless Chrome.
// Returns raw PNG bytes (UIX decodes + diffs them against the design render).
//
// The Chrome screenshot primitive (captureUrlScreenshot) is reused and testable;
// the full Flutter build path is live-environment only (a cold build is slow).
// =============================================================================

import { type Express } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { resolveWorkspace, getFlutterRoot, createTerminalEnv } from './runtime';

const execFile = promisify(execFileCb);

function chromeBin(): string {
  return process.env.RELAY_CHROME_BIN || '/usr/bin/google-chrome';
}

/**
 * Screenshot a URL with headless Chrome at a fixed window size. Returns PNG
 * bytes, or null if Chrome isn't available / the capture fails.
 */
export async function captureUrlScreenshot(
  url: string,
  width: number,
  height: number,
  timeoutMs = 30000,
): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `relay-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const args = [
    '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    url,
  ];
  try {
    await execFile(chromeBin(), args, { timeout: timeoutMs });
    const buf = await fs.readFile(out);
    return buf;
  } catch {
    return null;
  } finally {
    try { await fs.rm(out, { force: true }); } catch { /* ignore */ }
  }
}

// Minimal Flutter web app wrapping the generated widget as the home screen.
function mainDartFor(widgetCode: string): string {
  return `import 'package:flutter/material.dart';

void main() => runApp(const _PreviewApp());

class _PreviewApp extends StatelessWidget {
  const _PreviewApp();
  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: _GeneratedRoot(),
    );
  }
}

${widgetCode}
`;
}

const PREVIEW_PUBSPEC = `name: relay_visual_preview
description: scratch app for visual diff
publish_to: "none"
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
flutter:
  uses-material-design: true
`;

// Serve a directory over an ephemeral localhost port; returns { url, close }.
async function serveDir(dir: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon',
  };
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(dir) || !fsSync.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => server.close() };
}

export function registerVisualRoutes(app: Express): void {
  /**
   * POST /api/visual/flutter-screenshot
   * Body: { code: string, width?: number, height?: number }
   * Returns: image/png bytes (or 503 when Flutter/Chrome can't run).
   */
  app.post('/api/visual/flutter-screenshot', async (req, res) => {
    const code = String(req.body?.code || '');
    const width = Number(req.body?.width) || 393;
    const height = Number(req.body?.height) || 852;
    if (!code.trim()) { res.status(400).json({ error: 'code is required' }); return; }

    const flutter = path.join(getFlutterRoot(), 'bin', 'flutter');
    if (!fsSync.existsSync(flutter)) { res.status(503).json({ error: 'Flutter SDK not available' }); return; }

    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-fvis-'));
    let serverHandle: { url: string; close: () => void } | null = null;
    try {
      // The generated root widget must be named `_GeneratedRoot`; the assembled
      // screen is appended and referenced as the home. If the code defines its
      // own screen class, alias it.
      await fs.mkdir(path.join(projDir, 'lib'), { recursive: true });
      await fs.writeFile(path.join(projDir, 'pubspec.yaml'), PREVIEW_PUBSPEC);
      await fs.writeFile(path.join(projDir, 'lib', 'main.dart'), mainDartFor(code));

      await execFile(flutter, ['create', '--platforms=web', '.'], { cwd: projDir, env, timeout: 180000 });
      // Rewrite main.dart again (flutter create overwrites it).
      await fs.writeFile(path.join(projDir, 'lib', 'main.dart'), mainDartFor(code));
      await execFile(flutter, ['build', 'web', '--release'], { cwd: projDir, env, timeout: 300000 });

      serverHandle = await serveDir(path.join(projDir, 'build', 'web'));
      const png = await captureUrlScreenshot(serverHandle.url, width, height, 60000);
      if (!png) { res.status(502).json({ error: 'screenshot failed' }); return; }
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'flutter screenshot failed' });
    } finally {
      if (serverHandle) serverHandle.close();
      try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}
