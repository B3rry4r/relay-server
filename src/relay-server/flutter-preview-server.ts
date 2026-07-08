// =============================================================================
// flutter-preview-server.ts
// =============================================================================
// Spawns a tiny per-project static HTTP server bound to a random localhost port,
// serving the project's `build/web` directory. The server is then exposed via
// the existing cloudflared tunnel manager so the iframe loads
// `https://xxx.trycloudflare.com/` directly — bypassing relay-server's hosting
// layer entirely. This avoids the "20 minutes streaming dart_sdk.js" symptom
// that happens when a multi-MB Flutter web build is funnelled through
// relay-server's HTTP origin (and any proxies in front of it).
//
// One server per projectId. If the buildDir changes (rebuild) we tear down and
// restart so the cache is fresh. Servers stay alive across requests; the
// cloudflared tunnel for the bound port is reused.

import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { rewritePreviewHtml } from './preview-html';
import { closeTunnel } from './tunnel-manager';

interface FlutterPreviewEntry {
  port:      number;
  server:    Server;
  buildDir:  string;
  startedAt: number;
}

const servers = new Map<string, FlutterPreviewEntry>();

const MIME_TYPES: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.htm':   'text/html; charset=utf-8',
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
  '.otf':   'font/otf',
  '.wasm':  'application/wasm',
  '.map':   'application/json',
  '.txt':   'text/plain; charset=utf-8',
  '.xml':   'application/xml',
  '.bin':   'application/octet-stream',
  '.mp3':   'audio/mpeg',
  '.mp4':   'video/mp4',
  '.webp':  'image/webp',
};

function mimeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function makeStaticHandler(buildDir: string) {
  const root = path.resolve(buildDir);
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    try {
      // Strip query/hash; default to index.html for /
      const rawUrl = req.url || '/';
      const urlPath = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]) || '/';
      const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      let filePath = path.resolve(path.join(root, relPath));

      // Path-traversal guard: must remain within buildDir
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      let stat;
      try { stat = await fs.stat(filePath); }
      catch {
        // SPA fallback: serve index.html so client-side routing works
        const indexPath = path.join(root, 'index.html');
        if (await pathExists(indexPath)) {
          filePath = indexPath;
          stat = await fs.stat(indexPath);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
      }

      if (stat.isDirectory()) {
        const indexInside = path.join(filePath, 'index.html');
        if (await pathExists(indexInside)) {
          filePath = indexInside;
          stat = await fs.stat(filePath);
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Directory listing disabled');
          return;
        }
      }

      const ext = path.extname(filePath).toLowerCase();
      const isHtml = ext === '.html' || ext === '.htm';

      // Iframe-friendly headers — never set X-Frame-Options here
      res.setHeader('Cache-Control', isHtml ? 'no-cache' : 'public, max-age=31536000, immutable');
      // Cloudflared+browser may need explicit CORP for iframe
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (isHtml) {
        // baseHref="/" because we serve from the tunnel root; preview bridge
        // (console capture, error capture) is still injected by the rewriter.
        const raw = await fs.readFile(filePath, 'utf-8');
        const rewritten = rewritePreviewHtml(raw, '/');
        const buf = Buffer.from(rewritten, 'utf-8');
        res.writeHead(200, {
          'Content-Type':  'text/html; charset=utf-8',
          'Content-Length': String(buf.byteLength),
        });
        res.end(buf);
        return;
      }

      res.writeHead(200, {
        'Content-Type':   mimeFor(filePath),
        'Content-Length': String(stat.size),
      });
      const stream = createReadStream(filePath);
      stream.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end((err as Error).message);
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end((err as Error).message);
      } else {
        res.destroy();
      }
    }
  };
}

/**
 * Start (or reuse) a static preview server for a project's build/web folder.
 * Returns the bound localhost port — pass this to getTunnelUrl() to expose it
 * publicly.
 */
export async function startFlutterPreviewServer(projectId: string, buildDir: string): Promise<number> {
  const existing = servers.get(projectId);
  if (existing && existing.buildDir === buildDir && existing.server.listening) {
    return existing.port;
  }
  if (existing) {
    await stopFlutterPreviewServer(projectId);
  }

  const handler = makeStaticHandler(buildDir);
  const server = createServer((req, res) => { void handler(req, res); });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error('Failed to bind preview server'));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  servers.set(projectId, { port, server, buildDir, startedAt: Date.now() });
  return port;
}

/** Stop the per-project preview server (called on project switch / rebuild). */
export async function stopFlutterPreviewServer(projectId: string): Promise<void> {
  const entry = servers.get(projectId);
  if (!entry) return;
  servers.delete(projectId);
  closeTunnel(entry.port);
  await new Promise<void>(resolve => entry.server.close(() => resolve()));
}

export function getFlutterPreviewPort(projectId: string): number | null {
  return servers.get(projectId)?.port ?? null;
}

export function listFlutterPreviewServers(): Array<{ projectId: string; port: number; buildDir: string; startedAt: number }> {
  return [...servers.entries()].map(([projectId, e]) => ({
    projectId, port: e.port, buildDir: e.buildDir, startedAt: e.startedAt,
  }));
}

// ── Generic aliases ──────────────────────────────────────────────────────────
// This server was born for Flutter's build/web but it is a plain static-dir
// server (SPA fallback, full MIME table, iframe headers) — a Vite dist/ or a
// Next static export serve identically. Web live-preview code uses these names;
// the Flutter callers keep the original exports.
export const startStaticPreviewServer = startFlutterPreviewServer;
export const stopStaticPreviewServer  = stopFlutterPreviewServer;
export const listStaticPreviewServers = listFlutterPreviewServers;
