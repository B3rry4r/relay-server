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
import { resolveWorkspace, getFlutterRoot, getRelayCacheRoot, createTerminalEnv } from './runtime';

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

// ── Web (React + Vite) scratch-build screenshot ──────────────────────────────

const WEB_TEMPLATE_PKG = JSON.stringify({
  name: 'relay-visual-web-template', private: true, type: 'module', version: '0.0.0',
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'lucide-react': '^0.452.0' },
  devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.1', tailwindcss: '^3.4.0', postcss: '^8.4.0', autoprefixer: '^10.4.0' },
}, null, 2);

// Lazily create + `npm install` a shared template once; per-request builds reuse
// its node_modules (symlinked) so only `vite build` runs per check. Returns the
// template dir, or null if npm/install isn't available.
let _webTemplateReady: Promise<string | null> | null = null;
function ensureWebTemplate(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (_webTemplateReady) return _webTemplateReady;
  _webTemplateReady = (async () => {
    try {
      const dir = path.join(getRelayCacheRoot(), 'visual-web-template');
      await fs.mkdir(dir, { recursive: true });
      if (!fsSync.existsSync(path.join(dir, 'node_modules', 'vite'))) {
        await fs.writeFile(path.join(dir, 'package.json'), WEB_TEMPLATE_PKG);
        await execFile('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env, timeout: 600000 });
      }
      return dir;
    } catch { return null; }
  })();
  return _webTemplateReady;
}

// Collect the icon names a piece of code imports from lucide-react so the build
// can shim exactly those (avoids resolving the real icon set / missing names).
function lucideImportNames(code: string): string[] {
  const names = new Set<string>();
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return [...names];
}

export function registerVisualRoutes(app: Express): void {
  /**
   * POST /api/visual/web-screenshot
   * Body: { code: string, width?, height? }
   * Builds the assembled React component in a scratch Vite project (reusing a
   * pre-installed template) and screenshots it. Returns image/png (or 503).
   */
  app.post('/api/visual/web-screenshot', async (req, res) => {
    const code = String(req.body?.code || '');
    const width = Number(req.body?.width) || 393;
    const height = Number(req.body?.height) || 852;
    if (!code.trim()) { res.status(400).json({ error: 'code is required' }); return; }

    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);
    const template = await ensureWebTemplate(env);
    if (!template) { res.status(503).json({ error: 'web build toolchain unavailable' }); return; }

    const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-wvis-'));
    let serverHandle: { url: string; close: () => void } | null = null;
    try {
      await fs.mkdir(path.join(proj, 'src'), { recursive: true });
      // Reuse the template's installed deps without copying them.
      await fs.symlink(path.join(template, 'node_modules'), path.join(proj, 'node_modules'), 'dir').catch(() => {});

      const icons = lucideImportNames(code);
      const lucideShim = `import React from 'react';
const P = (props) => React.createElement('span', { 'data-icon': '', style: { display: 'inline-block', width: 16, height: 16 }, ...props });
${icons.map((n) => `export const ${n} = P;`).join('\n')}
export default P;
`;
      await fs.writeFile(path.join(proj, 'src', 'lucide-shim.tsx'), lucideShim);
      await fs.writeFile(path.join(proj, 'src', 'App.tsx'), code);
      await fs.writeFile(path.join(proj, 'src', 'index.css'), '@tailwind base;@tailwind components;@tailwind utilities;');
      await fs.writeFile(path.join(proj, 'src', 'main.tsx'),
        `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\ncreateRoot(document.getElementById('root')).render(React.createElement(App));\n`);
      await fs.writeFile(path.join(proj, 'index.html'),
        `<!doctype html><html><head><meta charset="utf-8"/><style>html,body,#root{margin:0;background:#fff}</style></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);
      await fs.writeFile(path.join(proj, 'tailwind.config.js'),
        `export default { content: ['./index.html','./src/**/*.{ts,tsx}'], theme:{extend:{}}, plugins:[] };`);
      await fs.writeFile(path.join(proj, 'postcss.config.js'), 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } };');
      await fs.writeFile(path.join(proj, 'vite.config.ts'),
        `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport path from 'node:path';\nexport default defineConfig({ plugins:[react()], resolve:{ alias:{ 'lucide-react': path.resolve(__dirname,'src/lucide-shim.tsx') } } });\n`);

      await execFile(path.join(template, 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'error'], { cwd: proj, env, timeout: 180000 });

      serverHandle = await serveDir(path.join(proj, 'dist'));
      const png = await captureUrlScreenshot(serverHandle.url, width, height, 45000);
      if (!png) { res.status(502).json({ error: 'screenshot failed' }); return; }
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'web screenshot failed' });
    } finally {
      if (serverHandle) serverHandle.close();
      try { await fs.rm(proj, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });


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
