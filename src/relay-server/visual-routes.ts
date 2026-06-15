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
import { mainDartFor, pubspecFor, ScaffoldError } from './visual-flutter-scaffold';

const execFile = promisify(execFileCb);

// Resolve the headless-Chrome binary once and cache it: honor RELAY_CHROME_BIN
// when it actually exists on disk, otherwise search PATH for the usual names.
let _chromeBinCached: string | null = null;
async function chromeBin(): Promise<string> {
  if (_chromeBinCached) return _chromeBinCached;
  const envBin = process.env.RELAY_CHROME_BIN;
  if (envBin && fsSync.existsSync(envBin)) { _chromeBinCached = envBin; return envBin; }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const { stdout } = await execFile('which', [name], { timeout: 5000 });
      const p = stdout.trim();
      if (p && fsSync.existsSync(p)) { _chromeBinCached = p; return p; }
    } catch { /* not on PATH — try next */ }
  }
  throw new Error('Chrome not found — set RELAY_CHROME_BIN');
}

// Error carrying the failing step label plus the (long) captured output so the
// route can split a short reason from a detailed tail for the JSON response.
class StepError extends Error {
  label: string;
  detail: string;
  constructor(label: string, detail: string) {
    super(`${label} failed`);
    this.name = 'StepError';
    this.label = label;
    this.detail = detail;
  }
}

// Run a build step capturing stdout+stderr into the thrown error (execFile's
// default "Command failed: <cmd>" loses the actual reason). 10MB buffer —
// flutter and vite builds are chatty. We keep ~1500 chars of the tail so the
// real compiler diagnostic survives to the client (was truncated to 500).
async function runStep(
  label: string,
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(bin, args, { ...opts, maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    const full = `${err?.stdout || ''}\n${err?.stderr || err?.message || ''}`.trim();
    throw new StepError(label, full.slice(-1500) || 'unknown error');
  }
}

/**
 * Screenshot a URL with headless Chrome. Returns PNG bytes, or null if Chrome
 * isn't available / the capture fails.
 *
 * P1 (RFC §4.6): the candidate MUST be captured at the SAME device-scale as the
 * reference render (refs are exported @2× → 786px wide for a 393px frame) and at
 * FULL height, not clipped to the device viewport — otherwise long screens are
 * judged at the wrong resolution and their lower portion is never seen, making
 * "match" verdicts unreliable on exactly the big screens that matter.
 *
 * - `deviceScale` maps to --force-device-scale-factor (default 1; pass 2 to match
 *   a 2× reference). The output PNG is then width·scale × height·scale px.
 * - `fullPage` sizes the window tall enough to capture the whole document, so a
 *   frame taller than the viewport is captured in full (no 852px clip).
 */
export async function captureUrlScreenshot(
  url: string,
  width: number,
  height: number,
  timeoutMs = 30000,
  opts: { deviceScale?: number; fullPage?: boolean } = {},
): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `relay-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const scale = opts.deviceScale && opts.deviceScale > 0 ? opts.deviceScale : 1;
  // For full-height capture, make the window very tall in CSS px so the whole
  // page lands in one shot (headless captures the window, and --hide-scrollbars
  // keeps the bar out of the frame). Cap it so a runaway-tall page can't OOM.
  const winH = opts.fullPage ? Math.min(Math.max(Math.round(height), 4000), 20000) : Math.round(height);
  const args = [
    '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${Math.round(width)},${winH}`,
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    url,
  ];
  try {
    await execFile(await chromeBin(), args, { timeout: timeoutMs });
    const buf = await fs.readFile(out);
    return buf;
  } catch {
    return null;
  } finally {
    try { await fs.rm(out, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * P1 (RFC §4.6): TALL-FRAME TILING. A reference taller than ~1500 logical px is
 * downsampled below the model's vision long-edge cap when judged as one image,
 * losing fidelity exactly on the big screens that matter. Instead of one
 * downsampled full-page shot we capture the page in ~viewport-tall vertical TILES
 * (with overlap so no element is split across a boundary), each at the matched
 * device-scale and full resolution. Each tile is verified independently.
 *
 * No image-decode dependency (sharp/jimp aren't installed and adding a native dep
 * is unsafe per the deploy guard): we tile in the BROWSER. The served origin
 * exposes a virtual `/__tile.html?top=&w=&h=` wrapper that iframes the app and
 * scrolls it to each tile offset; a viewport-clipped screenshot (NOT full-page)
 * then captures exactly that band at full resolution. Same-origin with the app, so
 * the iframe scroll isn't blocked.
 *
 * `serverUrl` is the served base (the `.url` serveDir returns, ending /index.html).
 * Returns the vertical tiles top→bottom, or null on failure.
 */
export async function captureUrlTiles(
  serverUrl: string,
  width: number,
  totalHeight: number,
  timeoutMs = 60000,
  opts: { deviceScale?: number; viewportH?: number; overlap?: number } = {},
): Promise<Buffer[] | null> {
  const viewportH = Math.max(opts.viewportH ?? 852, 200);
  const overlap = Math.max(opts.overlap ?? 120, 0);
  const step = Math.max(viewportH - overlap, 1);
  const nTiles = Math.max(1, Math.ceil((totalHeight - overlap) / step));
  const scale = opts.deviceScale && opts.deviceScale > 0 ? opts.deviceScale : 1;
  const base = serverUrl.replace(/\/index\.html$/, '');
  const W = Math.round(width), H = Math.round(viewportH);

  const tiles: Buffer[] = [];
  for (let i = 0; i < nTiles; i++) {
    const top = Math.round(i * step);
    const tileUrl = `${base}/__tile.html?top=${top}&w=${W}&h=${H}`;
    // Viewport-clipped (NOT full-page) → exactly one band at full resolution.
    const png = await captureUrlScreenshot(tileUrl, width, viewportH, timeoutMs, { deviceScale: scale });
    if (png) tiles.push(png);
  }
  return tiles.length ? tiles : null;
}

// Serve a directory over an ephemeral localhost port; returns { url, close }.
// Exported for the screen-build loop, which serves a real project's build/web
// output to screenshot a generated screen against its reference render.
export async function serveDir(dir: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon',
  };
  const server = createServer(async (req, res) => {
    try {
      const rawPath = (req.url || '/').split('?')[0];
      const rel = decodeURIComponent(rawPath);
      // Virtual SAME-ORIGIN tiling wrapper (RFC §4.6): iframes /index.html and is
      // scrolled to a query offset (?top=<logicalPx>&w=&h=) so a viewport-clipped
      // screenshot captures exactly one vertical band of a tall screen. Same-origin
      // with the app → the iframe scroll isn't blocked.
      if (rel === '/__tile.html') {
        const q = new URLSearchParams((req.url || '').split('?')[1] || '');
        const top = Math.max(0, parseInt(q.get('top') || '0', 10) || 0);
        const w = Math.max(1, parseInt(q.get('w') || '393', 10) || 393);
        const h = Math.max(1, parseInt(q.get('h') || '852', 10) || 852);
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"/>` +
          `<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}iframe{border:0;width:${w}px;height:${h}px;display:block}</style>` +
          `</head><body><iframe id="f" src="/index.html"></iframe>` +
          `<script>var f=document.getElementById('f');` +
          `f.addEventListener('load',function(){setTimeout(function(){try{f.contentWindow.scrollTo(0,${top});}catch(e){}},400);});` +
          `</script></body></html>`,
        );
        return;
      }
      const file = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(dir) || !fsSync.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 500; res.end(); }
  });
  // Reject on bind failures instead of hanging forever waiting for 'listening'.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
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
    try { await chromeBin(); } catch (err: any) {
      res.status(503).json({ error: err?.message || 'Chrome not found — set RELAY_CHROME_BIN' });
      return;
    }

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

      await runStep('vite build', path.join(template, 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'error'], { cwd: proj, env, timeout: 180000 });

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
    // Fail fast with an actionable message before spending minutes on a build
    // that could never be screenshotted.
    try { await chromeBin(); } catch (err: any) {
      res.status(503).json({ error: err?.message || 'Chrome not found — set RELAY_CHROME_BIN' });
      return;
    }

    // Derive the harness + pubspec from the generated code BEFORE any build, so
    // unrunnable code (no widget class / no main) is rejected as a 422 instead
    // of starting a doomed multi-minute build.
    let mainDart: string;
    let pubspec: string;
    try {
      mainDart = mainDartFor(code);
      pubspec = pubspecFor(code);
    } catch (err: any) {
      if (err instanceof ScaffoldError) {
        res.status(422).json({ error: err.message, detail: '' });
        return;
      }
      throw err;
    }

    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-fvis-'));
    let serverHandle: { url: string; close: () => void } | null = null;
    try {
      // Scaffold a runnable web app: harness main.dart references the generated
      // widget class (or runs its own main()), and the pubspec declares every
      // non-flutter package the code imports so `pub get` resolves.
      await fs.mkdir(path.join(projDir, 'lib'), { recursive: true });
      await fs.writeFile(path.join(projDir, 'pubspec.yaml'), pubspec);
      await fs.writeFile(path.join(projDir, 'lib', 'main.dart'), mainDart);

      // `flutter create` overwrites pubspec.yaml + lib/main.dart, so rewrite
      // both afterward, then resolve packages and build.
      await runStep('flutter create', flutter, ['create', '--platforms=web', '.'], { cwd: projDir, env, timeout: 180000 });
      await fs.writeFile(path.join(projDir, 'pubspec.yaml'), pubspec);
      await fs.writeFile(path.join(projDir, 'lib', 'main.dart'), mainDart);
      await runStep('flutter pub get', flutter, ['pub', 'get'], { cwd: projDir, env, timeout: 180000 });
      const build = await runStep('flutter build web', flutter, ['build', 'web', '--release'], { cwd: projDir, env, timeout: 300000 });

      // A zero-exit build can still produce nothing usable (plugin/tool quirks)
      // — validate the output before serving it.
      const webDir = path.join(projDir, 'build', 'web');
      if (!fsSync.existsSync(path.join(webDir, 'index.html'))) {
        const tail = `${build.stdout || ''}\n${build.stderr || ''}`.trim().slice(-1500);
        res.status(422).json({ error: 'flutter build web produced no output', detail: tail });
        return;
      }

      serverHandle = await serveDir(webDir);
      const png = await captureUrlScreenshot(serverHandle.url, width, height, 60000);
      if (!png) { res.status(502).json({ error: 'Chrome screenshot of the built app failed' }); return; }
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    } catch (err: any) {
      // Map build-step failures to a precise status: SDK/web-not-enabled is an
      // environment problem (503); pub-get / compile failures are the code's
      // fault (422 with the dart diagnostic); anything else is 500.
      if (err instanceof StepError) {
        const detail = err.detail;
        const sdkBroken = /web (?:is )?not enabled|run "flutter config|No web devices|Unable to find git in your PATH|requires the Flutter SDK/i.test(detail);
        if (sdkBroken) {
          res.status(503).json({ error: 'Flutter web build environment is not ready', detail });
          return;
        }
        const reason = err.label === 'flutter pub get'
          ? 'dependency resolution failed (flutter pub get)'
          : 'generated Flutter code failed to compile for web';
        res.status(422).json({ error: reason, detail });
        return;
      }
      res.status(500).json({ error: err?.message || 'flutter screenshot failed' });
    } finally {
      if (serverHandle) serverHandle.close();
      try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}
