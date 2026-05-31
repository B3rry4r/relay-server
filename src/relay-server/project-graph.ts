// =============================================================================
// File: src/relay-server/project-graph.ts
//
// The machine-readable connective tissue (RFC P4/P5 keystone): a graph linking
// products ↔ repos ↔ figma source ↔ IR/generation state ↔ routes.
//
// Source of truth = a committed `product.json` in each product (or repo). When
// absent, the graph is INFERRED from directory layout + manifests so existing
// scattered repos still appear. The aggregated graph is cached to
// .relay/state/projects.graph.json.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { getProjectsRoot, getRelayStateRoot } from './runtime';

export type RepoRole = 'backend' | 'web' | 'admin' | 'mobile' | 'marketing' | 'app' | 'unknown';

export interface RepoNode {
  role: RepoRole;
  path: string;          // relative to projects root
  stack: string;         // 'flutter' | 'laravel' | 'next' | 'react' | 'nest' | 'node' | 'unknown'
  remote?: string;       // sanitized (no embedded creds)
}

export interface ProductNode {
  id: string;
  displayName: string;
  source: 'manifest' | 'inferred';
  repos: RepoNode[];
  figma?: { source?: string; lastImport?: string };
  generation?: { engine?: string; ir?: string; report?: string };
  shared?: string[];
}

export interface ProjectGraph {
  generatedAt: string;
  products: ProductNode[];
  /** Repos that couldn't be grouped into a product. */
  ungrouped: RepoNode[];
}

/** Shape of a committed product.json (all fields optional except product). */
export interface ProductManifest {
  product: string;
  displayName?: string;
  repos?: Array<{ role?: RepoRole; path?: string; stack?: string; remote?: string }>;
  figma?: { source?: string; lastImport?: string };
  generation?: { engine?: string; ir?: string; report?: string };
  shared?: string[];
}

function stripCreds(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^(https?:\/\/)(?:[^/@]+@)/i, '$1');
}

function detectStack(dir: string): string {
  const has = (f: string) => fsSync.existsSync(path.join(dir, f));
  if (has('pubspec.yaml')) return 'flutter';
  if (has('composer.json')) return 'laravel';
  const pkgPath = path.join(dir, 'package.json');
  if (fsSync.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return 'next';
      if (deps['@nestjs/core']) return 'nest';
      if (deps.react) return 'react';
      return 'node';
    } catch { return 'node'; }
  }
  return 'unknown';
}

function detectRole(name: string): RepoRole {
  const n = name.toLowerCase();
  if (/-?(api|server|backend)$/.test(n) || /\bapi\b/.test(n)) return 'backend';
  if (/(admin|dashboard)/.test(n)) return 'admin';
  if (/mobile/.test(n)) return 'mobile';
  if (/(landing|marketing)/.test(n)) return 'marketing';
  if (/web|frontend/.test(n)) return 'web';
  return 'app';
}

// Heuristic product key from a scattered repo name, e.g. "Kudimata-API" →
// "kudimata", "Oja-Ewa-Web" → "oja-ewa", "WAWUAfrica-Dashboard" → "wawuafrica".
function inferProductKey(name: string): string {
  let n = name.replace(/[_\s]+/g, '-');
  n = n.replace(/-?(API|Server|Backend|Admin|Admin-Dashboard|Dashboard|Mobile|Web|Frontend|Landing|Marketing|Capital-web|App)$/i, '');
  n = n.replace(/(Africa|Basket|Capital)$/i, ''); // sub-brands fold into the parent
  return (n || name).toLowerCase().replace(/-+$/g, '') || name.toLowerCase();
}

function prettyName(key: string): string {
  return key.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

async function readManifest(dir: string): Promise<ProductManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'product.json'), 'utf-8');
    const m = JSON.parse(raw) as ProductManifest;
    return m && typeof m.product === 'string' ? m : null;
  } catch { return null; }
}

// Platform/tooling repos that are not generated products.
const PLATFORM = new Set(['uix', 'relay-server', 'relay-web', 'refig', 'my-app']);

/** Build the project graph: manifests where present, inference otherwise. */
export async function buildProjectGraph(projectsRoot = getProjectsRoot()): Promise<ProjectGraph> {
  const products = new Map<string, ProductNode>();
  const ungrouped: RepoNode[] = [];

  let entries: fsSync.Dirent[] = [];
  try { entries = await fs.readdir(projectsRoot, { withFileTypes: true }); } catch { /* none */ }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(projectsRoot, e.name);

    // 1) A committed product.json is authoritative for that product.
    const manifest = await readManifest(dir);
    if (manifest) {
      const id = manifest.product.toLowerCase();
      products.set(id, {
        id,
        displayName: manifest.displayName ?? prettyName(id),
        source: 'manifest',
        repos: (manifest.repos ?? []).map(r => ({
          role: (r.role ?? 'unknown') as RepoRole,
          path: r.path ?? '.',
          stack: r.stack ?? 'unknown',
          remote: stripCreds(r.remote),
        })),
        figma: manifest.figma,
        generation: manifest.generation,
        shared: manifest.shared,
      });
      continue;
    }

    if (PLATFORM.has(e.name.toLowerCase())) continue; // skip tooling repos in inference

    // 2) Infer a repo node and group it under a product key.
    const repo: RepoNode = { role: detectRole(e.name), path: e.name, stack: detectStack(dir) };
    if (repo.stack === 'unknown' && !fsSync.existsSync(path.join(dir, '.git'))) { continue; }
    const key = inferProductKey(e.name);
    if (!key) { ungrouped.push(repo); continue; }
    const existing = products.get(key);
    if (existing && existing.source === 'manifest') continue; // don't override a manifest
    if (existing) existing.repos.push(repo);
    else products.set(key, { id: key, displayName: prettyName(key), source: 'inferred', repos: [repo] });
  }

  return {
    generatedAt: new Date().toISOString(),
    products: [...products.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ungrouped,
  };
}

/** Build the graph and cache it to .relay/state/projects.graph.json. */
export async function buildAndCacheProjectGraph(projectsRoot = getProjectsRoot()): Promise<ProjectGraph> {
  const graph = await buildProjectGraph(projectsRoot);
  try {
    await fs.mkdir(getRelayStateRoot(), { recursive: true });
    await fs.writeFile(path.join(getRelayStateRoot(), 'projects.graph.json'), JSON.stringify(graph, null, 2));
  } catch { /* cache is best-effort */ }
  return graph;
}
