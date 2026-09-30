// =============================================================================
// Release lifecycle under the relay host (CONTRACTS §3, pty-host-audit d.3/d.4).
//
//   unit     — run-mutating route matcher, lease liveness, IPC activate-once.
//   process  — the REAL server entrypoint (src/index.ts via vite-node) as a
//              forked child with an IPC channel, exactly how relay-host spawns a
//              release:
//                * standby: /health fields, NO resume of an interrupted run,
//                  run-mutating routes 503, /__relay/busy auth
//                * IPC activate (sent twice) → activated, resumes the run ONCE
//                * a second release activated while the first still holds the
//                  run's lease does NOT resume it (no double-run)
//                * SIGTERM: the agent CLI's whole process group dies, the run is
//                  left running + resumable with its lease released and its screen
//                  NOT marked failed, the process exits 0 inside RELAY_SHUTDOWN_MS
//                * the next release resumes the run from where it stopped
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  activationCount,
  getRelayMode,
  installActivateIpc,
  isRunMutatingRequest,
  resetLifecycleForTests,
} from '../src/relay-server/lifecycle';
import { stopAutoResumeSweep } from '../src/relay-server/ai-screen-loop';
import { currentBootId, isForeignLeaseLive, leaseHolderAlive, probeProcess, RUN_LEASE_STALE_MS } from '../src/relay-server/build-run-store';

describe('lifecycle — run-mutating routes (503 in standby / draining)', () => {
  it.each([
    ['POST', '/api/ai/runs', true],
    ['POST', '/api/ai/runs/run_1_x/start', true],
    ['POST', '/api/ai/runs/run_1_x/stop', true],
    ['DELETE', '/api/ai/runs/run_1_x', true],
    ['POST', '/api/ai/prepare-and-run', true],
    ['POST', '/api/ai/build-screen', true],
    ['POST', '/api/ai/generate', true],
    ['GET', '/api/previews/5173/tunnel', true],
    ['POST', '/api/previews/5173/serve', true],
    ['GET', '/api/ai/runs', false],
    ['GET', '/api/ai/runs/run_1_x/log', false],
    ['GET', '/health', false],
    ['POST', '/api/auth/login', false],
    ['POST', '/api/ai/cancel', false],
    // Express routing is case-insensitive and ignores a trailing slash: so is the guard.
    ['POST', '/API/AI/RUNS', true],
    ['POST', '/Api/Ai/Runs/run_1_x/Start', true],
    ['POST', '/api/ai/runs/', true],
    ['POST', '/api/ai/%72uns', true],
    ['GET', '/API/PREVIEWS/5173/TUNNEL', true],
    ['POST', '/API/PREVIEWS/5173/SERVE/', true],
    ['POST', '/API/AI/CANCEL', false],
    ['GET', '/API/AI/RUNS', false],
    // Every other state-changing AI job spawns agents / writes the project.
    ['POST', '/api/ai/finalize-app', true],
    ['POST', '/api/ai/deepen-tokens', true],
    ['POST', '/api/ai/runs/run_1_x/finalize', true],
    ['POST', '/api/previews/web/proj', true],
  ])('%s %s → %s', (method, route, expected) => {
    expect(isRunMutatingRequest(method, route)).toBe(expected);
  });
});

describe('lifecycle — run lease liveness', () => {
  const now = 1_000_000;
  it('no lease / own lease / stale heartbeat / dead pid are not a live foreign lease', () => {
    expect(isForeignLeaseLive({}, now)).toBe(false);
    expect(isForeignLeaseLive({ lease: { releaseId: process.env.RELAY_RELEASE_ID || 'dev', pid: process.pid, heartbeatAt: now } }, now)).toBe(false);
    expect(isForeignLeaseLive({ lease: { releaseId: 'old', pid: 4242, heartbeatAt: now - RUN_LEASE_STALE_MS - 1 } }, now, () => true)).toBe(false);
    expect(isForeignLeaseLive({ lease: { releaseId: 'old', pid: 4242, heartbeatAt: now } }, now, () => false)).toBe(false);
  });
  it('a fresh lease held by another live pid is live', () => {
    expect(isForeignLeaseLive({ lease: { releaseId: 'old', pid: 4242, heartbeatAt: now - 1000 } }, now, () => true)).toBe(true);
  });
  // A machine restart inside the stale window: pid namespaces restart small and
  // deterministic, so the dead holder's pid is often some other live process.
  it('a lease from a previous boot is not live, even if its pid is alive now', () => {
    const lease = { releaseId: 'old', pid: 4242, heartbeatAt: now - 1000, bootId: 'boot-before', startTime: '100' };
    expect(isForeignLeaseLive({ lease }, now, () => ({ alive: true, startTime: '100' }), 'boot-now')).toBe(false);
    expect(isForeignLeaseLive({ lease }, now, () => ({ alive: true, startTime: '100' }), 'boot-before')).toBe(true);
  });
  it('a pid reused by a process that started at another time is not the holder', () => {
    const lease = { releaseId: 'old', pid: 4242, heartbeatAt: now - 1000, bootId: 'b', startTime: '100' };
    expect(isForeignLeaseLive({ lease }, now, () => ({ alive: true, startTime: '999' }), 'b')).toBe(false);
    // Unknown start time (no /proc) falls back to the pid check.
    expect(isForeignLeaseLive({ lease }, now, () => ({ alive: true, startTime: null }), 'b')).toBe(true);
    // Leases written before this field existed still work.
    expect(isForeignLeaseLive({ lease: { releaseId: 'old', pid: 4242, heartbeatAt: now - 1000 } }, now, () => ({ alive: true, startTime: '5' }), 'b')).toBe(true);
  });
  it.runIf(process.platform === 'linux')('probeProcess reads the real start time; an exited pid is dead', async () => {
    const me = probeProcess(process.pid);
    expect(me.alive).toBe(true);
    expect(me.startTime).toMatch(/^\d+$/);
    expect(currentBootId()).toMatch(/[0-9a-f-]{36}/);
    expect(leaseHolderAlive({ pid: process.pid, bootId: currentBootId() ?? undefined, startTime: me.startTime ?? undefined })).toBe(true);
    expect(leaseHolderAlive({ pid: process.pid, bootId: currentBootId() ?? undefined, startTime: String(Number(me.startTime) + 1) })).toBe(false);
    // A real other process: alive with its own start time; dead once it exits.
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    const pid = child.pid!;
    const other = probeProcess(pid);
    expect(other.alive).toBe(true);
    expect(other.startTime).toMatch(/^\d+$/);
    expect(leaseHolderAlive({ pid, startTime: other.startTime ?? undefined })).toBe(true);
    child.kill('SIGKILL');
    await exited;
    expect(probeProcess(pid).alive).toBe(false);
    expect(leaseHolderAlive({ pid, startTime: other.startTime ?? undefined })).toBe(false);
  });
});

describe('lifecycle — IPC activate', () => {
  let ws = '';
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lc-'));
    process.env.WORKSPACE = ws;
  });
  afterAll(() => {
    stopAutoResumeSweep();
    resetLifecycleForTests();
    delete process.env.WORKSPACE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('activates exactly once however many activate messages arrive, and acks each', async () => {
    resetLifecycleForTests();
    const proc = Object.assign(new EventEmitter(), { sent: [] as unknown[], connected: true }) as EventEmitter & { sent: unknown[]; connected: boolean; send: (m: unknown) => boolean };
    proc.send = (m: unknown) => { proc.sent.push(m); return true; };
    installActivateIpc(proc as unknown as Parameters<typeof installActivateIpc>[0]);
    proc.emit('message', { type: 'noise' });
    await new Promise((r) => setTimeout(r, 20));
    expect(proc.sent).toEqual([]);
    proc.emit('message', { type: 'activate' });
    proc.emit('message', { type: 'activate' });
    await new Promise((r) => setTimeout(r, 50));
    expect(activationCount()).toBe(1);
    expect(getRelayMode()).toBe('active');
    expect(proc.sent).toEqual([
      { type: 'activated', releaseId: expect.any(String) },
      { type: 'activated', releaseId: expect.any(String) },
    ]);
  });
});

// ---------------------------------------------------------------- process level

const ROOT = path.resolve(__dirname, '..');
const VITE_NODE = path.join(ROOT, 'node_modules', '.bin', 'vite-node');
const OWNER = 'owner-secret-for-lifecycle-tests-0123456789';
const PTY_TOKEN = 'pty-internal-token-for-lifecycle-tests-0123456789';
const RUN_ID = 'run_1700000000000_lcy';
const PROJECT = 'lcproj';

type Release = { child: ChildProcess; port: number; out: () => string; messages: unknown[]; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function procState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0];
  } catch { return null; }
}
const aliveNotZombie = (pid: number) => { const s = procState(pid); return s !== null && s !== 'Z'; };

describe('lifecycle — the real entrypoint under a host-style parent', () => {
  let ws = '';
  const releases: Release[] = [];
  const projectRoot = () => path.join(ws, 'projects', PROJECT);
  const runPath = () => path.join(projectRoot(), '.uix', 'runs', `${RUN_ID}.json`);
  const logPath = () => path.join(projectRoot(), '.uix', 'runs', `${RUN_ID}.log`);
  const readRun = () => JSON.parse(fs.readFileSync(runPath(), 'utf8'));
  const readLog = () => { try { return fs.readFileSync(logPath(), 'utf8'); } catch { return ''; } };
  const agentPids = () => { try { return fs.readFileSync(path.join(ws, 'agent-pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
  const localToken = () => fs.readFileSync(path.join(ws, '.relay', 'state', 'local-token'), 'utf8').trim();

  function startRelease(id: string, extra: Record<string, string> = {}): Promise<Release> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('RELAY_') || k === 'AUTH_TOKEN' || k === 'AUTH_TOKEN_HASH' || k === 'VITEST' || k.startsWith('VITEST_')) delete env[k];
    Object.assign(env, {
      WORKSPACE: ws,
      HOME: ws,
      PORT: '0',
      AUTH_TOKEN: OWNER,
      RELAY_PTY_TOKEN: PTY_TOKEN,
      RELAY_SKIP_BOOTSTRAP: '1',
      RELAY_START_MODE: 'standby',
      RELAY_RELEASE_ID: id,
      RELAY_SHUTDOWN_MS: '6000',
      RELAY_RUN_LEASE_HEARTBEAT_MS: '1000',
      RELAY_RUN_LEASE_RECHECK_MS: '500',
      ...extra,
    });
    const child = spawn(VITE_NODE, ['src/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    const messages: unknown[] = [];
    child.on('message', (m) => messages.push(m));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    return waitFor(() => /Relay listening on port (\d+)/.exec(out)?.[1], 45_000, `release ${id} to listen\n${out}`).then((port) => {
      const rel = { child, port: Number(port), out: () => out, messages, exited };
      releases.push(rel);
      return rel;
    });
  }

  const get = async (rel: Release, route: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${rel.port}${route}`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };

  async function activate(rel: Release): Promise<void> {
    rel.child.send({ type: 'activate' });
    rel.child.send({ type: 'activate' });
    await waitFor(() => rel.messages.some((m: any) => m?.type === 'activated'), 10_000, 'activated ack');
  }

  async function terminate(rel: Release): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
    const t0 = Date.now();
    rel.child.kill('SIGTERM');
    const result = await Promise.race([rel.exited, sleep(15_000).then(() => ({ code: -1, signal: null }))]);
    return { ...result, ms: Date.now() - t0 };
  }

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lc-proc-'));
    // A fake agent CLI (claude) on the relay bin PATH: records its pid and the pid
    // of a child it forks into the SAME process group, then blocks forever.
    const bin = path.join(ws, '.relay', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash\necho $$ >> "${ws}/agent-pids"\nsleep 600 &\necho $! >> "${ws}/agent-pids"\nwait\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(projectRoot(), '.uix', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot(), 'ref.png'), '');
    const now = new Date().toISOString();
    fs.writeFileSync(runPath(), JSON.stringify({
      id: RUN_ID,
      projectId: PROJECT,
      kind: 'selected',
      framework: 'flutter',
      model: 'claude',
      verify: false,
      maxIterations: 1,
      finalize: false,
      screens: [{ frameId: 'f1', frameName: 'Home', status: 'pending', spec: { packet: 'Build the Home screen.', referenceImagePath: 'ref.png', width: 390, height: 844 } }],
      // Interrupted by the previous release: running + resumable.
      status: 'running',
      resumable: true,
      createdAt: now,
      updatedAt: now,
    }, null, 2));
  });

  afterEach(() => { /* releases are torn down in afterAll */ });

  afterAll(async () => {
    for (const rel of releases) {
      if (rel.child.exitCode === null && rel.child.signalCode === null) {
        rel.child.kill('SIGKILL');
        await Promise.race([rel.exited, sleep(3000)]);
      }
    }
    for (const pid of agentPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('standby → activate once → lease blocks a second release → SIGTERM leaves the run resumable → the next release resumes it', async () => {
    // ── A: standby ────────────────────────────────────────────────────────────
    const a = await startRelease('rel-A');
    const health = await get(a, '/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, releaseId: 'rel-A', mode: 'standby', ptyMode: 'embedded', draining: false });
    expect(typeof health.body.uptimeMs).toBe('number');
    expect((await get(a, '/api/version')).body).toMatchObject({ releaseId: 'rel-A' });

    await sleep(1500);
    expect(readLog()).not.toContain('resuming interrupted run');
    expect(agentPids()).toEqual([]);

    const auth = { authorization: `Bearer ${localToken()}`, 'content-type': 'application/json' };
    const start = await fetch(`http://127.0.0.1:${a.port}/api/ai/runs/${RUN_ID}/start`, { method: 'POST', headers: auth, body: '{}' });
    expect(start.status).toBe(503);
    expect((await start.json()).error).toBe('release_standby');
    // Express routes case-insensitively: an upper-case spelling must not slip past the guard.
    for (const route of ['/API/AI/RUNS', `/Api/Ai/Runs/${RUN_ID}/START/`, '/api/ai/finalize-app']) {
      const r = await fetch(`http://127.0.0.1:${a.port}${route}`, { method: 'POST', headers: auth, body: '{}' });
      expect([route, r.status]).toEqual([route, 503]);
    }

    expect((await get(a, '/__relay/busy')).status).toBe(401);
    expect((await get(a, '/__relay/busy', { authorization: `Bearer ${localToken()}` })).status).toBe(401);
    expect((await get(a, '/__relay/busy', { authorization: `Bearer ${PTY_TOKEN}`, 'x-forwarded-for': '1.2.3.4' })).status).toBe(401);
    expect((await get(a, '/__relay/busy', { authorization: `Bearer ${PTY_TOKEN}` })).body).toEqual({ runningJobs: 0, activeRuns: 0 });

    // ── A: activate (twice) → resumes the run exactly once ───────────────────
    await activate(a);
    expect((await get(a, '/health')).body.mode).toBe('active');
    await waitFor(() => agentPids().length >= 2, 30_000, `the resumed run to reach its agent call\n${a.out()}\n${readLog()}`);
    const [agentPid, agentChildPid] = agentPids();
    expect(aliveNotZombie(agentPid) && aliveNotZombie(agentChildPid)).toBe(true);
    expect(readLog().match(/resuming interrupted run/g)?.length).toBe(1);
    expect((a.out().match(/ACTIVE \(host IPC activate\)/g) ?? []).length).toBe(1);
    const leased = readRun();
    expect(leased.lease).toMatchObject({ releaseId: 'rel-A', pid: a.child.pid });
    expect((await get(a, '/__relay/busy', { authorization: `Bearer ${PTY_TOKEN}` })).body).toEqual({ runningJobs: 1, activeRuns: 1 });

    // ── B: activated while A still holds a fresh lease → does NOT resume ─────
    const b = await startRelease('rel-B');
    await activate(b);
    await waitFor(() => b.out().includes('not resuming — leased by live pid'), 10_000, `B to skip the leased run\n${b.out()}`);
    expect(b.out()).toContain(`leased by live pid ${a.child.pid} (release rel-A)`);
    await sleep(1000);
    expect(agentPids().length).toBe(2);
    expect(readLog().match(/resuming interrupted run/g)?.length).toBe(1);

    // ── A: SIGTERM while B stays ACTIVE ────────────────────────────────────────
    const stopped = await terminate(a);
    expect(stopped.code).toBe(0);
    expect(stopped.ms).toBeLessThan(6000 + 1500);
    expect(a.out()).toContain('graceful shutdown of release rel-A');
    expect(a.out()).toMatch(/shutdown complete in \d+ ms — runs left resumable: run_1700000000000_lcy; agent groups killed: 1/);
    // The agent CLI AND the child it forked into its process group are gone.
    await waitFor(() => !aliveNotZombie(agentPid) && !aliveNotZombie(agentChildPid), 5000, `agent process group to die (${agentPid}:${procState(agentPid)} ${agentChildPid}:${procState(agentChildPid)} pgid ${fs.existsSync(`/proc/${agentPid}/stat`) ? fs.readFileSync(`/proc/${agentPid}/stat`, 'utf8') : '-'})\n${a.out()}`);
    expect(readLog()).toContain('[run] interrupted by release swap (SIGTERM) — will resume');
    // Nothing written after the freeze: no agent-failure lines from the kill.
    const tail = (readLog().split('[run] interrupted by release swap')[1] ?? '').split('[run] resuming interrupted run')[0];
    expect(tail).not.toMatch(/failed|error/i);

    // ── B (still the active release) resumes the run it had to skip ──────────
    // Regression (skeptic sk25): resumeInterruptedRuns runs once, at activation,
    // so a run skipped for a live foreign lease used to stay stranded until the
    // next deploy. B re-checks it and resumes it once A is gone — well inside
    // the lease's stale window, since A exited.
    await waitFor(() => agentPids().length >= 4, 15_000, `B to resume the run after A exited\n${b.out()}\n${readLog()}`);
    expect(readLog()).toContain(`[run] resuming interrupted run — the release that held it (pid ${a.child.pid}) is gone`);
    expect(readLog().match(/resuming interrupted run/g)?.length).toBe(2);
    const bLease = readRun().lease;
    expect(bLease).toMatchObject({ releaseId: 'rel-B', pid: b.child.pid });
    if (process.platform === 'linux') expect(bLease).toMatchObject({ bootId: expect.any(String), startTime: expect.stringMatching(/^\d+$/) });
    const [bAgent, bAgentChild] = agentPids().slice(2);
    expect(aliveNotZombie(bAgent) && aliveNotZombie(bAgentChild)).toBe(true);

    // ── B: SIGTERM ────────────────────────────────────────────────────────────
    const bStop = await terminate(b);
    expect(bStop.code).toBe(0);
    await waitFor(() => !aliveNotZombie(bAgent) && !aliveNotZombie(bAgentChild), 5000, 'B agent group to die');
    const after = readRun();
    expect(after.status).toBe('running');
    expect(after.resumable).toBe(true);
    expect(after.lease).toBeUndefined();
    expect(after.screens[0].status).not.toBe('failed');

    // ── C: the next release resumes the run from where it stopped ─────────────
    const c = await startRelease('rel-C');
    await activate(c);
    await waitFor(() => agentPids().length >= 6, 30_000, `C to resume the run\n${c.out()}`);
    expect(readLog().match(/resuming interrupted run/g)?.length).toBe(3);
    expect(readRun().lease).toMatchObject({ releaseId: 'rel-C', pid: c.child.pid });
    const cStop = await terminate(c);
    expect(cStop.code).toBe(0);
    const [p3, p4] = agentPids().slice(4);
    await waitFor(() => !aliveNotZombie(p3) && !aliveNotZombie(p4), 5000, 'second agent group to die');
    expect(readRun()).toMatchObject({ status: 'running', resumable: true });
  }, 180_000);
});
