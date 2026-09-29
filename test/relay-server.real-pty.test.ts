// =============================================================================
// Terminal durability against a REAL PTY (node-pty, via the production
// defaultPtyFactory) — no FakePty anywhere in this file.
//
// test/relay-server.test.ts drives the socket/session layer through the injected
// PtyFactory seam with a FakePty. That proves the protocol, but a FakePty has no
// pid, no process, no kernel tty: it cannot show that a shell actually spawns in
// the workspace, that input reaches it, that a resize reaches the tty, that the
// process outlives a socket disconnect, or that a restart brings a terminal back.
// These do, end to end, against a real shell process.
//
// Gated ONLY on node-pty being loadable and able to spawn a shell on this host;
// the skip carries the reason.
// =============================================================================

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, defaultPtyFactory, type RelayServer } from '../src/relay-server';

const SHELL = '/bin/bash';
const TIMEOUT_MS = 20_000;

function probeRealPty(): string | null {
  if (process.env.RELAY_PTY_MODE?.trim().toLowerCase() === 'remote') {
    return 'RELAY_PTY_MODE=remote routes terminals to the relay-pty service; unset it to test the embedded PTY';
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty') as { spawn(file: string, args: string[], opts: object): { pid: number; kill(): void } };
    const probe = nodePty.spawn(SHELL, ['-c', 'exit 0'], { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env, name: 'xterm' });
    if (!probe.pid) return 'node-pty spawned no process (no pid)';
    try { probe.kill(); } catch { /* already exited */ }
    return null;
  } catch (error) {
    return `node-pty cannot spawn ${SHELL} on this host: ${error instanceof Error ? error.message : String(error)}`;
  }
}
const PTY_UNAVAILABLE = probeRealPty();
if (PTY_UNAVAILABLE) console.warn(`[skip] NEEDS_EXTERNAL real PTY: ${PTY_UNAVAILABLE}`);

type Recorder = {
  client: Socket;
  events: Array<{ name: string; payload: any }>;
  /** Concatenated live 'terminal:output' data per terminal id. */
  output(id: string): string;
  waitFor<T = any>(name: string, predicate?: (payload: any) => boolean): Promise<T>;
  waitForOutput(id: string, predicate: (text: string) => boolean): Promise<string>;
};

/** Connect with EVERY event recorded from the first packet (no listener race). */
async function connect(port: number): Promise<Recorder> {
  const client = createClient(`http://127.0.0.1:${port}`, {
    auth: { token: 'test-token' }, reconnection: false, transports: ['websocket'], autoConnect: false,
  });
  const events: Array<{ name: string; payload: any }> = [];
  const waiters: Array<() => void> = [];
  client.onAny((name: string, payload: any) => {
    events.push({ name, payload });
    for (const w of waiters.splice(0)) w();
  });
  const until = <T>(check: () => T | undefined, what: string): Promise<T> => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS - 2_000);
    const tick = () => {
      const hit = check();
      if (hit !== undefined) { clearTimeout(deadline); resolve(hit); return; }
      waiters.push(tick);
    };
    tick();
  });
  const output = (id: string) => events
    .filter((e) => e.name === 'terminal:output' && e.payload?.id === id)
    .map((e) => String(e.payload.data)).join('');
  const rec: Recorder = {
    client,
    events,
    output,
    waitFor: (name, predicate = () => true) =>
      until(() => events.find((e) => e.name === name && predicate(e.payload))?.payload, `'${name}'`),
    waitForOutput: (id, predicate) =>
      until(() => { const text = output(id); return predicate(text) ? text : undefined; }, `output on ${id}`),
  };
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
    client.connect();
  });
  return rec;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function listTerminals(port: number): Promise<Array<{ id: string; pid: number; cwd: string }>> {
  const response = await request(`http://127.0.0.1:${port}`).get('/api/terminals').set('x-auth-token', 'test-token');
  expect(response.status).toBe(200);
  return response.body.terminals;
}

describe.skipIf(PTY_UNAVAILABLE !== null)('Relay terminals on a REAL PTY (node-pty)', () => {
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];
  const pids: number[] = [];
  let workspace = '';

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-real-pty-'));
    await fs.mkdir(path.join(workspace, 'projects'), { recursive: true });
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = workspace;
    process.env.SHELL = SHELL;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    for (const server of servers.splice(0)) await server.stop();
    // Never leak a real shell past the test, whatever it asserted.
    for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const key of ['PORT', 'AUTH_TOKEN', 'WORKSPACE', 'SHELL']) delete process.env[key];
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function startRelay(): Promise<{ relay: RelayServer; port: number }> {
    const relay = createRelayServer(defaultPtyFactory);
    servers.push(relay);
    return { relay, port: await relay.start() };
  }

  it('spawns a real shell in the workspace, relays its output, and forwards input + resize', async () => {
    const { port } = await startRelay();
    const rec = await connect(port);
    clients.push(rec.client);

    const created = await rec.waitFor<{ id: string; pid: number; cwd: string }>('terminal:created');
    expect(created.cwd).toBe(workspace);
    expect(created.pid).toBeGreaterThan(0);
    pids.push(created.pid);
    expect(isAlive(created.pid)).toBe(true);

    // Input reaches the real shell; its output comes back tagged with the id. The
    // marker is assembled by the shell so the echoed command line cannot match.
    rec.client.emit('input', `printf 'PWD=%s\\n' "$(pwd)"; printf 'M%s\\n' ARK_1\n`);
    const text = await rec.waitForOutput(created.id, (t) => t.includes('MARK_1'));
    expect(text).toContain(`PWD=${workspace}`);

    // A resize reaches the kernel tty (stty reads it back).
    rec.client.emit('resize', { cols: 123, rows: 45 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    rec.client.emit('input', `printf 'SIZE=%s\\n' "$(stty size)"\n`);
    await rec.waitForOutput(created.id, (t) => t.includes('SIZE=45 123'));
  }, TIMEOUT_MS);

  it('keeps the real shell process alive across a socket disconnect and reattaches to it', async () => {
    const { port } = await startRelay();
    const first = await connect(port);
    clients.push(first.client);
    const created = await first.waitFor<{ id: string; pid: number }>('terminal:created');
    pids.push(created.pid);

    // Shell state that only survives if it is the SAME process: a variable.
    first.client.emit('input', `RELAY_KEEP=alive_$((40+2)); printf 'SET_%s\\n' done\n`);
    await first.waitForOutput(created.id, (t) => t.includes('SET_done'));

    first.client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(created.pid)).toBe(true);
    expect((await listTerminals(port)).map((t) => t.id)).toEqual([created.id]);

    const second = await connect(port);
    clients.push(second.client);
    const ready = await second.waitFor<{ terminals: Array<{ id: string; pid: number }> }>('terminals:ready');
    expect(ready.terminals).toEqual([expect.objectContaining({ id: created.id, pid: created.pid })]);
    // The reattached client is seeded with the scrollback written while it was away…
    const replay = await second.waitFor<{ id: string; data: string }>('terminal:replay', (p) => p.id === created.id);
    expect(replay.data).toContain('SET_done');
    // …and drives the very same process (the variable is still set).
    second.client.emit('input', `printf 'GOT_%s\\n' "$RELAY_KEEP"\n`);
    await second.waitForOutput(created.id, (t) => t.includes('GOT_alive_42'));
  }, TIMEOUT_MS);

  it('restores a terminal (same id + scrollback, fresh live shell) after a relay restart', async () => {
    const one = await startRelay();
    const rec1 = await connect(one.port);
    clients.push(rec1.client);
    const created = await rec1.waitFor<{ id: string; pid: number }>('terminal:created');
    pids.push(created.pid);
    rec1.client.emit('input', `printf 'BEFORE_%s\\n' RESTART\n`);
    await rec1.waitForOutput(created.id, (t) => t.includes('BEFORE_RESTART'));

    rec1.client.disconnect();
    clients.splice(clients.indexOf(rec1.client), 1);
    await one.relay.stop();
    servers.splice(servers.indexOf(one.relay), 1);
    // An embedded-mode stop ends the old shell (it cannot outlive its process owner).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(created.pid)).toBe(false);

    const two = await startRelay();
    const restored = await listTerminals(two.port);
    expect(restored.map((t) => t.id)).toEqual([created.id]);
    expect(restored[0].pid).toBeGreaterThan(0);
    expect(restored[0].pid).not.toBe(created.pid);
    pids.push(restored[0].pid);
    expect(isAlive(restored[0].pid)).toBe(true);

    const rec2 = await connect(two.port);
    clients.push(rec2.client);
    const replay = await rec2.waitFor<{ id: string; data: string }>('terminal:replay', (p) => p.id === created.id);
    expect(replay.data).toContain('BEFORE_RESTART');
    rec2.client.emit('input', `printf 'AFTER_%s\\n' RESTART\n`);
    await rec2.waitForOutput(created.id, (t) => t.includes('AFTER_RESTART'));
  }, TIMEOUT_MS);

  it('replaces a shell that exits on its own with a fresh live one', async () => {
    const { port } = await startRelay();
    const rec = await connect(port);
    clients.push(rec.client);
    const created = await rec.waitFor<{ id: string; pid: number }>('terminal:created');
    pids.push(created.pid);

    rec.client.emit('input', 'exit\n');
    await rec.waitFor('terminal:closed', (p) => p.id === created.id);
    const respawned = await rec.waitFor<{ id: string; pid: number }>('terminal:created', (p) => p.id !== created.id);
    pids.push(respawned.pid);
    expect(respawned.pid).not.toBe(created.pid);
    expect(isAlive(respawned.pid)).toBe(true);
    expect((await listTerminals(port)).map((t) => t.id)).toEqual([respawned.id]);

    rec.client.emit('input', `printf 'NEW_%s\\n' SHELL\n`);
    await rec.waitForOutput(respawned.id, (t) => t.includes('NEW_SHELL'));
  }, TIMEOUT_MS);
});
