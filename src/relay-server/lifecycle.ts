/*
 * Release lifecycle under the relay host (CONTRACTS §3, pty-host-audit d.3/d.4).
 *
 *   RELAY_START_MODE=standby  HTTP comes up, but nothing that mutates shared state
 *                             runs: no resumeInterruptedRuns, no auto-resume sweep,
 *                             no tunnels, and the run-mutating routes answer 503.
 *                             The host probes the standby, drains the old release,
 *                             then sends IPC {type:'activate'}; we activate ONCE and
 *                             reply {type:'activated'}.
 *   (unset)                   Today's behaviour: activate immediately at boot.
 *
 *   SIGTERM / SIGINT          Graceful shutdown within RELAY_SHUTDOWN_MS (default
 *                             8000): stop the sweep, mark every run this process
 *                             orchestrates `running`+`resumable` (the next release
 *                             resumes it), freeze run writes, kill every agent
 *                             process group, stop tunnels / Flutter screens /
 *                             preview servers, flush run writes, close listeners.
 */

import type { RelayServer } from './types';
import { killAllJobs, runningJobCount } from './ai-routes';
import {
  appendRunLog,
  drainRunWrites,
  freezeRunWrites,
  listActiveRunKeys,
  listLeasedRuns,
  mutateRun,
  stopLeaseHeartbeats,
} from './build-run-store';
import { resumeInterruptedRuns, startAutoResumeSweep, stopAutoResumeSweep } from './ai-screen-loop';
import { closeAllTunnels } from './tunnel-manager';
import { stopAllScreenSessions } from './flutter-screen';
import { stopAllFlutterPreviewServers } from './flutter-preview-server';
import { isRemotePtyEnabled } from './remote-pty';

export type RelayMode = 'standby' | 'active';

const bootAt = Date.now();
let mode: RelayMode = 'active';
let draining = false;
let activation: Promise<void> | null = null;
let activations = 0;
let ipcInstalled = false;
let shutdownPromise: Promise<void> | null = null;

/** RELAY_RELEASE_ID (the host's process tag), or 'dev' outside the host. */
export function getReleaseId(): string {
  return (process.env.RELAY_RELEASE_ID || '').trim() || 'dev';
}

/** The mode requested at boot: standby only when the host asks for it. */
export function requestedStartMode(): RelayMode {
  return (process.env.RELAY_START_MODE || '').trim().toLowerCase() === 'standby' ? 'standby' : 'active';
}

/** True when a host supervises this process (it always sets RELAY_START_MODE). */
export function isUnderHost(): boolean {
  return Boolean((process.env.RELAY_START_MODE || '').trim());
}

export function getRelayMode(): RelayMode {
  return mode;
}

export function isDraining(): boolean {
  return draining;
}

export function activationCount(): number {
  return activations;
}

export function uptimeMs(): number {
  return Date.now() - bootAt;
}

/** `/health` body (CONTRACTS §3). */
export function healthSnapshot(): {
  ok: true;
  releaseId: string;
  mode: RelayMode;
  ptyMode: 'remote' | 'embedded';
  uptimeMs: number;
  draining: boolean;
} {
  return {
    ok: true,
    releaseId: getReleaseId(),
    mode,
    ptyMode: isRemotePtyEnabled() ? 'remote' : 'embedded',
    uptimeMs: uptimeMs(),
    draining,
  };
}

/** `/__relay/busy` body: what an opt-in `waitIdle` deploy waits on. */
export function busySnapshot(): { runningJobs: number; activeRuns: number } {
  const keys = new Set<string>(listActiveRunKeys());
  for (const { runId } of listLeasedRuns()) keys.add(runId);
  return { runningJobs: runningJobCount(), activeRuns: keys.size };
}

/**
 * Should this request be refused because the process is not (or no longer) the
 * active release? Run-mutating routes (CONTRACTS §3), every other state-changing
 * /api/ai/* job (finalize-app, deepen-tokens, …: they spawn agents and write the
 * project), and preview tunnels / servers.
 *
 * Express routing is case-insensitive and ignores a trailing slash, so this
 * matches the same way (/i, optional '/'), on the percent-decoded path — a guard
 * that is stricter about spelling than the router is a guard with a bypass.
 */
export function isRunMutatingRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch { /* malformed: match the raw path */ }
  if (m === 'GET' && /^\/api\/previews\/\d+\/tunnel\/?$/i.test(p)) return true;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  // Cancelling is always allowed: it only stops work this process owns.
  if (/^\/api\/ai\/cancel\/?$/i.test(p)) return false;
  return /^\/api\/ai(\/|$)/i.test(p)
    || /^\/api\/previews\/\d+\/serve\/?$/i.test(p)
    || /^\/api\/previews\/web(\/|$)/i.test(p);
}

/** Express middleware: 503 for run-mutating routes in standby or while draining. */
export function lifecycleGuard(
  req: { method: string; path: string },
  res: { status(code: number): { json(body: unknown): unknown }; setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  if ((mode === 'standby' || draining) && isRunMutatingRequest(req.method, req.path)) {
    res.setHeader('Retry-After', '2');
    res.status(503).json({
      error: draining ? 'release_draining' : 'release_standby',
      message: draining
        ? 'This relay-server release is shutting down; retry in a moment.'
        : 'This relay-server release is on standby (not yet activated by the host); retry in a moment.',
    });
    return;
  }
  next();
}

/** The work that only the ACTIVE release does. */
function runActivationWork(): void {
  // Resume any full-app build run that was interrupted by the last restart (a
  // redeploy / release swap) so it keeps building server-side. Best-effort.
  void resumeInterruptedRuns();
  // Periodic auto-resume sweep for rate-limit-paused runs.
  startAutoResumeSweep();
}

/** Activate exactly once (idempotent: later calls return the same promise). */
export function activate(reason: string): Promise<void> {
  if (activation) return activation;
  activation = (async () => {
    mode = 'active';
    activations += 1;
    console.log(`[lifecycle] release ${getReleaseId()} ACTIVE (${reason})`);
    runActivationWork();
  })();
  return activation;
}

type IpcProcess = Pick<NodeJS.Process, 'on' | 'send' | 'connected'>;

/** Standby: wait for the host's IPC {type:'activate'} and acknowledge it. */
export function installActivateIpc(proc: IpcProcess = process): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  proc.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'activate') return;
    void activate('host IPC activate').then(() => {
      try {
        if (proc.send && proc.connected !== false) proc.send({ type: 'activated', releaseId: getReleaseId() });
      } catch (error) {
        console.error('[lifecycle] could not acknowledge activate:', error);
      }
    });
  });
}

/**
 * Boot the lifecycle for a freshly listening server: standby waits for the host,
 * anything else activates now.
 */
export function startLifecycle(proc: IpcProcess = process): RelayMode {
  if (requestedStartMode() === 'standby') {
    mode = 'standby';
    console.log(`[lifecycle] release ${getReleaseId()} on STANDBY — waiting for the host to activate it`);
    installActivateIpc(proc);
    return 'standby';
  }
  void activate(isUnderHost() ? `RELAY_START_MODE=${process.env.RELAY_START_MODE}` : 'boot');
  return 'active';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { const t = setTimeout(() => resolve(undefined), Math.max(0, ms)); t.unref?.(); }),
  ]);
}

export type ShutdownReport = {
  reason: string;
  interruptedRuns: string[];
  killedJobs: number;
  tunnels: number;
  screens: number;
  previews: number;
  elapsedMs: number;
};

/**
 * Graceful shutdown. Never throws; every step is bounded by what is left of
 * `budgetMs` so the whole thing ends well inside the host's drain window.
 */
export async function gracefulShutdown(
  relay: Pick<RelayServer, 'stop'> | null,
  reason: string,
  budgetMs = Number(process.env.RELAY_SHUTDOWN_MS) > 0 ? Number(process.env.RELAY_SHUTDOWN_MS) : 8000,
): Promise<ShutdownReport> {
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const report: ShutdownReport = { reason, interruptedRuns: [], killedJobs: 0, tunnels: 0, screens: 0, previews: 0, elapsedMs: 0 };
  draining = true;
  console.log(`[lifecycle] ${reason}: graceful shutdown of release ${getReleaseId()} (budget ${budgetMs} ms)`);

  // 1. No new background work.
  stopAutoResumeSweep();
  stopLeaseHeartbeats();

  // 2. Every run this process orchestrates stays `running` + `resumable` with its
  //    lease released, so the next (activated) release resumes it at once.
  const leased = listLeasedRuns();
  await withTimeout(Promise.all(leased.map(async ({ projectId, runId }) => {
    try {
      await appendRunLog(projectId, runId, `[run] interrupted by release swap (${reason}) — will resume`);
      await mutateRun(projectId, runId, (run) => {
        if (run.status === 'running') run.resumable = true;
        if (run.lease && run.lease.pid === process.pid) run.lease = undefined;
      });
      report.interruptedRuns.push(runId);
    } catch (error) {
      console.error(`[lifecycle] could not mark run ${runId} resumable:`, error);
    }
  })), Math.min(2000, left()));

  // 3. From here on the orchestrators' error paths (fired by the kills below)
  //    must not rewrite those runs as failed / parked.
  freezeRunWrites();

  // 4. Agent CLIs are detached group leaders: kill every group.
  try {
    report.killedJobs = await killAllJobs(Math.max(200, Math.min(2500, left() / 3)));
  } catch (error) {
    console.error('[lifecycle] killAllJobs failed:', error);
  }

  // 5. Processes that would otherwise be orphaned.
  try { report.tunnels = closeAllTunnels(); } catch { /* best-effort */ }
  const [screens, previews] = await Promise.all([
    withTimeout(stopAllScreenSessions().catch(() => 0), Math.min(2000, left())),
    withTimeout(stopAllFlutterPreviewServers().catch(() => 0), Math.min(2000, left())),
  ]);
  report.screens = screens ?? 0;
  report.previews = previews ?? 0;

  // 6. Flush every run write that was already in flight.
  await withTimeout(drainRunWrites(), Math.max(100, Math.min(3000, left())));

  // 7. Close the listeners (sockets, HTTP).
  if (relay) {
    await withTimeout(relay.stop().catch((error) => {
      console.error('[lifecycle] relay.stop failed:', error);
    }), Math.max(100, left()));
  }

  report.elapsedMs = Date.now() - started;
  console.log(`[lifecycle] shutdown complete in ${report.elapsedMs} ms — runs left resumable: ${report.interruptedRuns.join(',') || 'none'}; agent groups killed: ${report.killedJobs}; tunnels ${report.tunnels}, screens ${report.screens}, previews ${report.previews}`);
  return report;
}

/**
 * SIGTERM / SIGINT → gracefulShutdown → exit(0). A second signal, or the budget
 * running out, exits immediately. Returns a disposer (tests).
 */
export function installShutdownHandlers(
  relay: Pick<RelayServer, 'stop'>,
  options: { exit?: (code: number) => void; budgetMs?: number } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const budgetMs = options.budgetMs ?? (Number(process.env.RELAY_SHUTDOWN_MS) > 0 ? Number(process.env.RELAY_SHUTDOWN_MS) : 8000);
  const onSignal = (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      console.warn(`[lifecycle] second ${signal} — exiting now`);
      exit(1);
      return;
    }
    // Hard stop slightly after the budget, whatever is still pending.
    const hard = setTimeout(() => {
      console.error(`[lifecycle] shutdown exceeded ${budgetMs} ms — exiting`);
      exit(0);
    }, budgetMs + 500);
    hard.unref?.();
    shutdownPromise = gracefulShutdown(relay, signal, budgetMs)
      .then(() => undefined, (error) => { console.error('[lifecycle] shutdown error:', error); })
      .finally(() => { clearTimeout(hard); exit(0); });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}

/** Test helper: back to a fresh process's state. */
export function resetLifecycleForTests(): void {
  mode = 'active';
  draining = false;
  activation = null;
  activations = 0;
  ipcInstalled = false;
  shutdownPromise = null;
}
