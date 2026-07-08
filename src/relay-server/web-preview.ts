// =============================================================================
// web-preview.ts
// =============================================================================
// Build + locate a web (Vite/React/Next static-export) project's static output
// so it can be served for a live preview. Shared by:
//   - ai-screen-loop renderPreview (verify screenshots of the built app)
//   - POST /api/previews/web/:projectId (one-tap "Preview live" after codegen)
//
// Build-once semantics: a cheap mtime+size fingerprint of the project's source
// decides whether the existing dist/out/build output is still valid — an
// unchanged re-request returns the cached outDir instantly (no rebuild).
// Concurrent calls for the same project coalesce onto ONE in-flight build so a
// double-tap on "Preview live" can't run two npm builds at once.

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const execFile = promisify(execFileCallback);

export type WebBuildResult =
  | { outDir: string; error?: undefined }
  | { outDir?: undefined; error: string };

// Source dirs/files that determine a web build's output (mtime+size only — we
// never read file bodies, so this stays cheap on large projects).
const FINGERPRINT_ROOTS = [
  'src', 'app', 'pages', 'components', 'public',
  'package.json', 'index.html',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
];

/** Cheap (mtime+size) hash of everything that feeds a web build. */
export function webSourceFingerprint(projectRoot: string): string {
  const parts: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(projectRoot, rel);
    let st: fsSync.Stats;
    try { st = fsSync.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      // Never descend into dependency/output dirs — they don't determine the
      // build (and node_modules would make the walk expensive).
      const base = path.basename(rel);
      if (base === 'node_modules' || base === 'dist' || base === 'out' || base === 'build' || base === '.next') return;
      let entries: string[] = [];
      try { entries = fsSync.readdirSync(abs); } catch { return; }
      for (const e of entries.sort()) walk(path.join(rel, e));
    } else {
      parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  for (const r of FINGERPRINT_ROOTS) walk(r);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

// Per-project last successful build: source fingerprint + the located output
// dir. A matching fingerprint (with the outDir's index.html still on disk)
// means the existing output is valid → reuse, no rebuild.
const lastWebBuild = new Map<string, { fingerprint: string; outDir: string }>();
// Coalesce concurrent build requests per project.
const inFlight = new Map<string, Promise<WebBuildResult>>();

/**
 * Build the web project (npm run build) unless the existing output is still
 * fresh, then locate the servable static dir (dist/ out/ build/ with an
 * index.html). Returns { outDir } or { error: <tail of the build log> }.
 */
export function buildWebOutput(projectRoot: string, env: NodeJS.ProcessEnv): Promise<WebBuildResult> {
  const existing = inFlight.get(projectRoot);
  if (existing) return existing;
  const run = doBuild(projectRoot, env).finally(() => inFlight.delete(projectRoot));
  inFlight.set(projectRoot, run);
  return run;
}

async function doBuild(projectRoot: string, env: NodeJS.ProcessEnv): Promise<WebBuildResult> {
  const fingerprint = webSourceFingerprint(projectRoot);
  const cached = lastWebBuild.get(projectRoot);
  if (cached && cached.fingerprint === fingerprint
      && fsSync.existsSync(path.join(cached.outDir, 'index.html'))) {
    return { outDir: cached.outDir };
  }

  // One-tap ergonomics: a project whose deps were never installed (agent was
  // interrupted, fresh clone, …) gets an npm install first instead of a cryptic
  // "vite: not found" build failure.
  if (!fsSync.existsSync(path.join(projectRoot, 'node_modules'))) {
    try {
      await execFile('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e: any) {
      return { error: `npm install failed:\n${tail(e)}` };
    }
  }

  try {
    await execFile('npm', ['run', 'build'], {
      cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    lastWebBuild.delete(projectRoot);
    return { error: `web build (npm run build) failed:\n${tail(e)}` };
  }

  const found = ['dist', 'out', 'build']
    .map(d => path.join(projectRoot, d))
    .find(d => fsSync.existsSync(path.join(d, 'index.html')));
  if (!found) {
    lastWebBuild.delete(projectRoot);
    return { error: 'web build produced no servable output (dist/ out/ build/ with an index.html). Next.js projects need a static export (output: "export").' };
  }
  lastWebBuild.set(projectRoot, { fingerprint, outDir: found });
  return { outDir: found };
}

function tail(e: any): string {
  return `${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500);
}

/** Classify a project dir for the preview endpoint. */
export async function detectProjectKind(projectRoot: string): Promise<'flutter' | 'web' | 'unknown'> {
  if (fsSync.existsSync(path.join(projectRoot, 'pubspec.yaml'))) return 'flutter';
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg?.scripts?.build) return 'web';
  } catch { /* fall through */ }
  return 'unknown';
}

/** The run manifest's previewEntry (a client route like /_preview/<screen>) —
 *  used as the initial route for the live preview. Web manifests store a route
 *  path; anything not starting with '/' (e.g. a Flutter .dart path) is ignored. */
export async function readWebPreviewRoute(projectRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'last-gen.json'), 'utf8');
    const manifest = JSON.parse(raw) as { previewEntry?: string };
    const entry = manifest?.previewEntry;
    return typeof entry === 'string' && entry.startsWith('/') ? entry : null;
  } catch { return null; }
}
