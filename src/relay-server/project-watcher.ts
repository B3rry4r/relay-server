// =============================================================================
// File: src/relay-server/project-watcher.ts
//
// Watches a project directory and fires debounced callbacks when files change
// (onFs) or git state changes (onGit) — so the client file tree + git status can
// update LIVE over the socket instead of needing a manual refresh button.
// Heavy/noisy dirs (node_modules, build output, .uix screenshots) are ignored.
// =============================================================================

import chokidar, { type FSWatcher } from 'chokidar';
import * as path from 'path';

export interface ProjectWatcher { stop: () => void }

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

export function watchProject(root: string, onFs: () => void, onGit: () => void): ProjectWatcher {
  const fireFs = debounce(onFs, 300);
  const fireGit = debounce(onGit, 300);

  // File-tree watcher — ignore heavy/noisy paths. ignoreInitial so the initial
  // scan doesn't fire; awaitWriteFinish coalesces rapid saves.
  const fsW: FSWatcher = chokidar.watch(root, {
    ignored: [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
      '**/.next/**', '**/.dart_tool/**', '**/out/**', '**/.uix/screens/**',
    ],
    ignoreInitial: true,
    persistent: true,
    depth: 12,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  fsW.on('all', fireFs);
  fsW.on('error', () => { /* watcher errors must not crash the socket */ });

  // Git watcher — HEAD/index/refs change on commit, stage, checkout, branch.
  const gitDir = path.join(root, '.git');
  const gitW: FSWatcher = chokidar.watch(
    [path.join(gitDir, 'HEAD'), path.join(gitDir, 'index'), path.join(gitDir, 'refs')],
    { ignoreInitial: true, persistent: true },
  );
  gitW.on('all', fireGit);
  gitW.on('error', () => { /* ignore */ });

  return { stop: () => { void fsW.close(); void gitW.close(); } };
}
