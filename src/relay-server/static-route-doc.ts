/**
 * static-route-doc.ts — which document a static server serves for a ROUTE path.
 *
 * One rule for both servers that serve a built web app: the verify server
 * (visual-routes.serveDir) and the live preview server (flutter-preview-server).
 *
 * A Next.js static export is not a SPA. It writes one HTML document per route
 * (`out/settings.html`, or `out/settings/index.html` with `trailingSlash`), and a
 * route that also has nested routes gets BOTH `out/10-3.html` and a directory
 * `out/10-3/`. So the lookup is keyed on "is there a regular FILE at this path",
 * never on "does the path exist": a directory at `/10-3` must not win over
 * `10-3.html` (it used to be answered with 403 "Directory listing disabled" by the
 * live preview server — B56 fix round, PG-33).
 */
import fsSync from 'node:fs';
import path from 'node:path';

export type RouteDocument =
  /** Serve this document for the route. `rel` is root-relative, posix. */
  | { kind: 'doc'; file: string; rel: string }
  /** A Next export with no document for this route: answer 404 (with `file`, the
   *  export's 404.html, when it has one) — never the root page. */
  | { kind: 'not-found'; file: string | null }
  /** Not a route lookup (a real file, an extension, or `/`): the caller's normal
   *  handling applies (serve the file / the SPA fallback). */
  | { kind: 'none' };

const isFile = (p: string): boolean => { try { return fsSync.statSync(p).isFile(); } catch { return false; } };

/** True when `root` is a Next static export (it ships the `_next/` runtime dir). */
export function isNextExportDir(root: string): boolean {
  try { return fsSync.statSync(path.join(root, '_next')).isDirectory(); } catch { return false; }
}

/**
 * Resolve an extension-less URL path (`/10-3`, `/10-3/`, `/_preview/10-3`) to the
 * document to serve. `urlPath` is the decoded path with a leading `/`.
 */
export function resolveRouteDocument(root: string, urlPath: string, nextExport = isNextExportDir(root)): RouteDocument {
  const absRoot = path.resolve(root);
  const clean = urlPath.split('?')[0].split('#')[0];
  if (clean === '/' || clean === '' || clean === '/index.html') return { kind: 'none' };
  const trimmed = clean.replace(/\/+$/, '');
  if (path.extname(trimmed)) return { kind: 'none' };
  const disk = path.resolve(path.join(absRoot, trimmed));
  if (!disk.startsWith(absRoot + path.sep)) return { kind: 'none' };
  // A regular file with no extension (rare, but real) is served as itself.
  if (isFile(disk)) return { kind: 'none' };
  for (const cand of [`${disk}.html`, path.join(disk, 'index.html')]) {
    if (isFile(cand)) return { kind: 'doc', file: cand, rel: path.relative(absRoot, cand).split(path.sep).join('/') };
  }
  if (nextExport) {
    const nf = path.join(absRoot, '404.html');
    return { kind: 'not-found', file: isFile(nf) ? nf : null };
  }
  return { kind: 'none' };
}
