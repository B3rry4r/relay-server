// =============================================================================
// File: src/pid1-reaper.ts
//
// Zombie-reaper safety net. The Docker image already runs under tini
// (ENTRYPOINT ["/usr/bin/tini","--",…]) which reaps orphaned grandchildren —
// headless-Chrome double-forks from the verify loop, dart build processes, etc.
// But when the server is launched as PID 1 WITHOUT that init (a dev container that
// overrode the entrypoint, or a bare `node dist/src/index.js`), Node does NOT reap
// orphaned grandchildren: they reparent to PID 1 (node) and pile up as <defunct>
// zombies until the cgroup pids limit is hit and fork() fails — at which point new
// builds can't spawn ("failed to fetch"). This module makes that impossible to
// regress: if we detect we're PID 1 without an init, we re-exec under `tini -s`
// (subreaper mode — tini reaps orphaned descendants even when it isn't PID 1 itself).
// =============================================================================

import { spawn } from 'child_process';
import * as fs from 'fs';

const TINI_PATHS = ['/usr/bin/tini', '/sbin/tini', '/usr/local/bin/tini', '/bin/tini'];

function findTini(): string | null {
  for (const p of TINI_PATHS) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* try next */ }
  }
  return null;
}

/**
 * If running as PID 1 without an init, re-exec under `tini -s` so orphaned
 * grandchildren are reaped. Returns true when it re-exec'd — the CALLER must then do
 * nothing else (this process is just the wrapper that waits on the tini child).
 * Returns false in the normal cases (already under tini, or not PID 1) so the caller
 * proceeds to boot the server.
 */
export function ensureReaperOrReExec(): boolean {
  // Not PID 1 → an init (tini) is already above us and reaping. Normal path.
  if (process.pid !== 1) return false;
  // Already re-exec'd by us → don't loop.
  if (process.env.RELAY_REEXEC === '1') return false;

  const tini = findTini();
  if (!tini) {
    console.warn(
      '[init] WARNING: running as PID 1 without tini. Orphaned child processes ' +
      '(headless Chrome, dart builds) will accumulate as zombies and eventually ' +
      'exhaust the pids limit, breaking new builds. Launch via the Docker ENTRYPOINT ' +
      '(tini) or install tini on PATH.',
    );
    return false;
  }

  console.log(`[init] PID 1 without an init — re-exec under "${tini} -s" (subreaper) so orphaned grandchildren are reaped.`);
  const child = spawn(tini, ['-s', '--', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, RELAY_REEXEC: '1', TINI_SUBREAPER: '1' },
  });
  // Forward termination signals so container stop / Ctrl-C shuts the server down cleanly.
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  (['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as NodeJS.Signals[]).forEach(sig => process.on(sig, forward(sig)));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (e) => { console.error('[init] failed to re-exec under tini:', e); process.exit(1); });
  return true;
}
