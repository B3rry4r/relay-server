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
import zlib from 'node:zlib';
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

// ── small-window paint bug workaround ────────────────────────────────────────
// Headless Chrome ("new" mode) enforces a MINIMUM window size. When the requested
// --window-size height is below ~200px, the laid-out/painted viewport comes out
// ~80–140px SHORTER than requested (version-dependent window-chrome subtraction),
// while --screenshot still writes a PNG at the full requested size — so the bottom
// of the page is captured as unpainted white. This is exactly what truncated the
// node-scoped asset renders (composite avatars/banners/icons are small: e.g. a
// 36×35 avatar at 4× = a 144×141 window whose bottom ~half never painted → the
// "half-circle avatar" defect). Empirically ≥400px always paints fully across the
// Chrome builds we run, so: pad the capture window height up to this floor and
// crop the PNG back to the requested height afterwards. Width is unaffected
// (Chrome pads the layout viewport to its 500px minimum but crops the shot to the
// requested width, and the full width paints).
const MIN_CAPTURE_WINDOW_H = 400;

// CRC32 (PNG chunk checksums) — plain table implementation; zlib.crc32 only
// exists on Node ≥22.2, and this must run on whatever Node the deploy has.
let _crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Crop a PNG to its top `targetHeight` rows, pure Node (no native image dep —
 * sharp/jimp are unavailable per the deploy guard). Works because PNG scanlines
 * are stored top-to-bottom and row filters only reference the PREVIOUS row, so
 * keeping the first N unfiltered scanlines and re-deflating is lossless.
 * Returns null (caller keeps the original) when the PNG is interlaced, already
 * short enough, or anything fails to parse — never throws.
 */
export function cropPngHeight(png: Buffer, targetHeight: number): Buffer | null {
  try {
    if (png.length < 45 || png.readUInt32BE(0) !== 0x89504e47) return null;
    // IHDR is always the first chunk at offset 8: len(4) type(4) data(13) crc(4).
    if (png.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const bitDepth = png[24];
    const colorType = png[25];
    const interlace = png[28];
    if (interlace !== 0 || targetHeight <= 0 || targetHeight >= height) return null;
    const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
    const scanlineBytes = 1 + Math.ceil((width * bitDepth * channels) / 8);

    // Walk the chunks: concatenate IDAT data, keep every other chunk verbatim.
    const before: Buffer[] = [];   // chunks before the first IDAT
    const after: Buffer[] = [];    // chunks after the last IDAT (IEND et al.)
    const idatParts: Buffer[] = [];
    let off = 8;
    let sawIdat = false;
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('latin1', off + 4, off + 8);
      const chunkEnd = off + 12 + len;
      if (chunkEnd > png.length) return null;
      if (type === 'IDAT') {
        sawIdat = true;
        idatParts.push(png.subarray(off + 8, off + 8 + len));
      } else {
        (sawIdat ? after : before).push(png.subarray(off, chunkEnd));
      }
      off = chunkEnd;
      if (type === 'IEND') break;
    }
    if (!sawIdat) return null;

    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    const keep = targetHeight * scanlineBytes;
    if (raw.length < keep) return null;
    const recompressed = zlib.deflateSync(raw.subarray(0, keep));

    // Rebuild: patch IHDR height + CRC, splice the single new IDAT back in.
    const out: Buffer[] = [];
    out.push(png.subarray(0, 8)); // signature
    for (const chunk of before) {
      if (chunk.toString('latin1', 4, 8) === 'IHDR') {
        const patched = Buffer.from(chunk);
        patched.writeUInt32BE(targetHeight, 12); // height field (data offset 4)
        patched.writeUInt32BE(crc32(patched.subarray(4, 8 + 13)), 8 + 13);
        out.push(patched);
      } else {
        out.push(chunk);
      }
    }
    const idat = Buffer.alloc(12 + recompressed.length);
    idat.writeUInt32BE(recompressed.length, 0);
    idat.write('IDAT', 4, 'latin1');
    recompressed.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, 8 + recompressed.length)), 8 + recompressed.length);
    out.push(idat);
    for (const chunk of after) out.push(chunk);
    return Buffer.concat(out);
  } catch {
    return null;
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
  opts: { deviceScale?: number; fullPage?: boolean; disableWebSecurity?: boolean; virtualTimeBudgetMs?: number } = {},
): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `relay-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const scale = opts.deviceScale && opts.deviceScale > 0 ? opts.deviceScale : 1;
  // For full-height capture, make the window very tall in CSS px so the whole
  // page lands in one shot (headless captures the window, and --hide-scrollbars
  // keeps the bar out of the frame). Cap it so a runaway-tall page can't OOM.
  //
  // SMALL windows: below ~200px height headless Chrome silently paints a viewport
  // shorter than the window (see MIN_CAPTURE_WINDOW_H) and the shot's bottom comes
  // out blank — the "half-circle avatar" asset bug. Pad the window up to the safe
  // floor and crop the PNG back to the requested height after capture.
  const reqH = Math.round(height);
  const padSmallWindow = !opts.fullPage && reqH < MIN_CAPTURE_WINDOW_H;
  const winH = opts.fullPage
    ? Math.min(Math.max(reqH, 4000), 20000)
    : (padSmallWindow ? MIN_CAPTURE_WINDOW_H : reqH);
  // In-page time budget before the shot is taken. The harness fetches resolved IR +
  // assets cross-origin and draws to CanvasKit, which can exceed the old 8s on a
  // complex frame (capturing a blank/partial canvas). Callers that draw heavy
  // content (the render harness) raise this; keep 8s as the cheap default.
  const virtualTimeBudget = opts.virtualTimeBudgetMs && opts.virtualTimeBudgetMs > 0
    ? Math.round(opts.virtualTimeBudgetMs) : 8000;
  const args = [
    '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${Math.round(width)},${winH}`,
    `--virtual-time-budget=${virtualTimeBudget}`,
    // The render harness fetches resolved IR + assets from the UIX origin (cross-
    // origin to the localhost harness), so harness renders need CORS disabled. Safe
    // on a headless render box (we only ever load our own harness/app). Requires a
    // throwaway --user-data-dir to take effect.
    ...(opts.disableWebSecurity ? [
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      `--user-data-dir=${path.join(os.tmpdir(), `relay-cdt-${Date.now()}-${Math.random().toString(36).slice(2)}`)}`,
    ] : []),
    `--screenshot=${out}`,
    url,
  ];
  try {
    await execFile(await chromeBin(), args, { timeout: timeoutMs });
    const buf = await fs.readFile(out);
    if (padSmallWindow) {
      // Drop the padding rows so callers get exactly the height they asked for
      // (device px = CSS px × scale). On any crop failure keep the padded shot —
      // extra white at the bottom beats a null capture.
      return cropPngHeight(buf, Math.round(reqH * scale)) ?? buf;
    }
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
  // `route`: the per-screen client route to tile (e.g. /_preview/133-1133). It is
  // passed THROUGH to the wrapper (which iframes it) — it must NOT be baked into
  // serverUrl, or `${base}/__tile.html` resolves to `/_preview/<id>/__tile.html`,
  // which is a .html path with no file on disk → 404 tiles. Tall screens were the
  // last place still capturing the app's default route.
  opts: { deviceScale?: number; viewportH?: number; overlap?: number; route?: string } = {},
): Promise<Buffer[] | null> {
  const viewportH = Math.max(opts.viewportH ?? 852, 200);
  const overlap = Math.max(opts.overlap ?? 120, 0);
  const step = Math.max(viewportH - overlap, 1);
  const nTiles = Math.max(1, Math.ceil((totalHeight - overlap) / step));
  const scale = opts.deviceScale && opts.deviceScale > 0 ? opts.deviceScale : 1;
  const base = serverUrl.replace(/\/index\.html$/, '');
  const W = Math.round(width), H = Math.round(viewportH);
  const routeQ = opts.route && opts.route.startsWith('/') ? `&route=${encodeURIComponent(opts.route)}` : '';

  const tiles: Buffer[] = [];
  for (let i = 0; i < nTiles; i++) {
    const top = Math.round(i * step);
    const tileUrl = `${base}/__tile.html?top=${top}&w=${W}&h=${H}${routeQ}`;
    // Viewport-clipped (NOT full-page) → exactly one band at full resolution.
    const png = await captureUrlScreenshot(tileUrl, width, viewportH, timeoutMs, { deviceScale: scale });
    if (png) tiles.push(png);
  }
  return tiles.length ? tiles : null;
}

// Serve a directory over an ephemeral localhost port; returns { url, close }.
// Exported for the screen-build loop, which serves a real project's build/web
// output to screenshot a generated screen against its reference render.
export async function serveDir(dir: string): Promise<{ url: string; close: () => void; observedPath: () => string | null }> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon',
    // SVG icons are painted via CSS mask-image; served as octet-stream (the old
    // default here) the browser can refuse them as a mask source. This omission
    // was part of why generated icons came out blank in candidate screenshots.
    '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  };
  // CAPTURE READINESS GATE. A React SPA applies CSS mask-image / background-image
  // styles AFTER hydration, which kicks off LATE asset fetches that headless
  // Chrome's --virtual-time-budget screenshot races past → every mask-based icon
  // (nav, section headers, KYC cards …) renders BLANK in the candidate, tanking
  // verify and making screens "not converge" on a non-bug. Fix: the gate script
  // injected into the app HTML opens a pending image request to /__hold — which
  // keeps Chrome's virtual clock paused while in-flight — and only releases it
  // once document.fonts.ready AND every CSS-referenced image has decoded, so the
  // shot is taken with icons painted. Hard-capped on BOTH sides (9s server, 8s
  // client) so a missing release can never hang a capture — it then behaves
  // exactly as before this change.
  const TINY_GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
  let holdRes: import('node:http').ServerResponse | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  // IDENTITY ASSERTION. The gate beacons the path the app ACTUALLY rendered (after
  // any client-side redirect) just before it releases the shot. Callers compare it
  // to the route they requested: if a catch-all/`<Navigate>` bounced us to another
  // screen, the screenshot is of the WRONG screen and must fail LOUD rather than be
  // scored — a plausible-but-wrong capture makes the harness blame the model's code.
  let observedPath: string | null = null;
  const releaseHold = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdRes) { try { holdRes.setHeader('Content-Type', 'image/gif'); holdRes.end(TINY_GIF); } catch { /* ignore */ } holdRes = null; }
  };
  const READY_GATE = `<script>(function(){try{`
    + `var g=new Image();g.src='/__hold';`
    + `function rel(){try{var l=new Image();l.src='/__loc?p='+encodeURIComponent(location.pathname);}catch(e){}try{var r=new Image();r.src='/__release?t='+Date.now();}catch(e){}}`
    + `function grab(v,bag){if(!v||v==='none')return;var i=0;while(true){var s=v.indexOf('url(',i);if(s<0)break;var e=v.indexOf(')',s);if(e<0)break;var u=v.substring(s+4,e).trim();var c=u.charAt(0);if(c==='"'||c===String.fromCharCode(39))u=u.substring(1,u.length-1);if(u&&u.substring(0,5)!=='data:')bag[u]=1;i=e+1;}}`
    + `function settle(){var proms=[];try{if(document.fonts&&document.fonts.ready)proms.push(document.fonts.ready);}catch(e){}`
    + `try{var bag={};var els=document.querySelectorAll('*');for(var i=0;i<els.length;i++){var cs=getComputedStyle(els[i]);grab(cs.webkitMaskImage,bag);grab(cs.maskImage,bag);grab(cs.backgroundImage,bag);}`
    + `Object.keys(bag).forEach(function(u){var im=new Image();im.src=u;if(im.decode)proms.push(im.decode().catch(function(){}));});}catch(e){}`
    + `Promise.all(proms).then(function(){requestAnimationFrame(function(){requestAnimationFrame(rel);});});}`
    + `function kick(){setTimeout(settle,250);}`
    + `if(document.readyState==='complete')kick();else window.addEventListener('load',kick);`
    + `setTimeout(rel,8000);`
    + `}catch(e){try{var r2=new Image();r2.src='/__release';}catch(_){}}})();</script>`;
  const server = createServer(async (req, res) => {
    try {
      const rawPath = (req.url || '/').split('?')[0];
      const rel = decodeURIComponent(rawPath);
      // Readiness-gate endpoints (see READY_GATE above). /__hold stays pending
      // (pausing Chrome's virtual time) until the page hits /__release.
      if (rel === '/__hold') { releaseHold(); holdRes = res; holdTimer = setTimeout(releaseHold, 9000); return; }
      if (rel === '/__loc') {
        const q = new URLSearchParams((req.url || '').split('?')[1] || '');
        observedPath = q.get('p');
        res.setHeader('Content-Type', 'image/gif'); res.end(TINY_GIF); return;
      }
      if (rel === '/__release') { releaseHold(); res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return; }
      // Virtual SAME-ORIGIN tiling wrapper (RFC §4.6): iframes /index.html and is
      // scrolled to a query offset (?top=<logicalPx>&w=&h=) so a viewport-clipped
      // screenshot captures exactly one vertical band of a tall screen. Same-origin
      // with the app → the iframe scroll isn't blocked.
      if (rel === '/__tile.html') {
        const q = new URLSearchParams((req.url || '').split('?')[1] || '');
        const top = Math.max(0, parseInt(q.get('top') || '0', 10) || 0);
        const w = Math.max(1, parseInt(q.get('w') || '393', 10) || 393);
        const h = Math.max(1, parseInt(q.get('h') || '852', 10) || 852);
        // Tile the SCREEN UNDER TEST, not the app's default route. `route` is the
        // per-screen client route; it hits the SPA fallback above (serving index.html
        // + the readiness gate) so the app's router renders that screen inside the
        // iframe. Same-origin, and only ever a local path.
        const qRoute = q.get('route') || '';
        const frameSrc = qRoute.startsWith('/') && !qRoute.startsWith('//') ? qRoute : '/index.html';
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"/>` +
          `<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}iframe{border:0;width:${w}px;height:${h}px;display:block}</style>` +
          `</head><body><iframe id="f" src="${frameSrc.replace(/"/g, '&quot;')}"></iframe>` +
          `<script>var f=document.getElementById('f');` +
          `f.addEventListener('load',function(){setTimeout(function(){try{f.contentWindow.scrollTo(0,${top});}catch(e){}},400);});` +
          `</script></body></html>`,
        );
        return;
      }
      // SPA FALLBACK. A client-side route (no file on disk AND no extension —
      // e.g. /_preview/<id>, /users) must serve index.html so the app's router can
      // render that screen. Without this, per-screen verify deep-links 404'd, the
      // SPA never reached the target screen, and its catch-all route (`* → default`)
      // captured EVERY non-default screen AS the default one — so every screen but
      // the entry scored ~0 against its own reference and churned to needs-review.
      const diskFile = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!diskFile.startsWith(dir)) { res.statusCode = 404; res.end(); return; }
      const isClientRoute = rel !== '/' && rel !== '/index.html' && !path.extname(rel);
      const serveIndex = rel === '/' || rel === '/index.html' || (isClientRoute && !fsSync.existsSync(diskFile));
      if (serveIndex) {
        const indexFile = path.join(dir, 'index.html');
        if (!fsSync.existsSync(indexFile)) { res.statusCode = 404; res.end(); return; }
        let html = await fs.readFile(indexFile, 'utf8');
        // Inject the readiness gate only for generated apps that ship localized
        // assets; the reference-render harness has none and is left untouched.
        if (fsSync.existsSync(path.join(dir, 'assets', 'icons')) || fsSync.existsSync(path.join(dir, 'assets', 'images'))) {
          html = html.includes('</head>') ? html.replace('</head>', `${READY_GATE}</head>`) : READY_GATE + html;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
      }
      if (!fsSync.existsSync(diskFile)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', types[path.extname(diskFile)] || 'application/octet-stream');
      res.end(await fs.readFile(diskFile));
    } catch { res.statusCode = 500; res.end(); }
  });
  // Reject on bind failures instead of hanging forever waiting for 'listening'.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => server.close(), observedPath: () => observedPath };
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
