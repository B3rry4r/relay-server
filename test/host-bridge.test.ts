// =============================================================================
// Terminal plumbing for the relay host (CONTRACTS §3, pty-host-audit a.2).
//
//  remote-pty bridge (RELAY_PTY_MODE=remote) against a FAKE PTY service:
//    - terminal:input {id,data} forwarded with ALL args, acks relayed both ways
//    - every upstream (re)connect sends the CURRENT active terminal
//    - a PTY-service drop is told to the browser ('output' notice)
//    - input typed during a long outage is discarded, not flushed late
//    - resize sizes are re-sent after a PTY-service restart
//    - a socket with auth.noTerminals:true gets NO upstream bridge
//  embedded engine:
//    - terminal:input writes to that terminal regardless of selection
//    - the mouse-report filter applies to terminal:input too
//    - a noTerminals socket spawns no shell
//    - the shell env carries RELAY_TERMINAL_ID
// =============================================================================

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePty, type PtyFactory } from '../src/relay-server';
import { AuthHarness, OWNER_SECRET } from './_auth-helpers';

const PTY_TOKEN = 'fake-pty-service-token-0123456789abcdef';

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function until<T>(fn: () => T, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A stand-in for relay-pty's /socket.io endpoint that records everything. */
class FakePtyService {
  http: HttpServer | null = null;
  io: IOServer | null = null;
  port = 0;
  handshakes: Array<Record<string, unknown>> = [];
  events: Array<{ event: string; args: unknown[] }> = [];
  sockets: ServerSocket[] = [];

  async start(port = 0): Promise<void> {
    this.http = createServer();
    this.io = new IOServer(this.http);
    this.io.use((socket, next) => {
      const auth = socket.handshake.auth as Record<string, unknown>;
      if (auth.token !== PTY_TOKEN) { next(new Error('Unauthorized')); return; }
      next();
    });
    this.io.on('connection', (socket) => {
      this.sockets.push(socket);
      this.handshakes.push({ ...(socket.handshake.auth as Record<string, unknown>) });
      socket.emit('terminals:ready', { terminals: [{ id: 't1', cwd: '/', pid: 1, createdAt: 1 }, { id: 't2', cwd: '/', pid: 2, createdAt: 2 }] });
      socket.onAny((event: string, ...args: unknown[]) => {
        this.events.push({ event, args: args.filter((a) => typeof a !== 'function') });
        const ack = args[args.length - 1];
        if (event === 'terminal:input' && typeof ack === 'function') ack({ ok: true, echoed: (args[0] as { data?: string }).data });
        if (event === 'terminal:select') socket.emit('terminal:selected', { id: (args[0] as { id: string }).id, cwd: '/' });
      });
    });
    await new Promise<void>((resolve) => this.http!.listen(port, '127.0.0.1', () => resolve()));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.io || !this.http) return;
    for (const s of this.sockets.splice(0)) s.disconnect(true);
    this.io.close();
    this.http.closeAllConnections?.();
    await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.io = null;
    this.http = null;
  }

  received(event: string): unknown[][] {
    return this.events.filter((e) => e.event === event).map((e) => e.args);
  }
}

const harness = new AuthHarness();
let service: FakePtyService | null = null;

afterEach(async () => {
  await harness.cleanup();
  await service?.stop();
  service = null;
  delete process.env.RELAY_PTY_MODE;
  delete process.env.RELAY_PTY_URL;
  delete process.env.RELAY_PTY_STALE_INPUT_MS;
});

function record(client: Socket): { events: Array<{ event: string; args: unknown[] }>; text: () => string } {
  const events: Array<{ event: string; args: unknown[] }> = [];
  client.onAny((event: string, ...args: unknown[]) => events.push({ event, args }));
  return { events, text: () => events.filter((e) => e.event === 'output').map((e) => String(e.args[0])).join('') };
}

describe('remote-pty bridge', () => {
  async function bootRemote() {
    service = new FakePtyService();
    await service.start();
    const booted = await harness.boot({
      RELAY_PTY_MODE: 'remote',
      RELAY_PTY_URL: `http://127.0.0.1:${service.port}`,
      RELAY_PTY_TOKEN: PTY_TOKEN,
      RELAY_PTY_STALE_INPUT_MS: '300',
    });
    return booted;
  }

  it('forwards terminal:input with its payload and relays the ack', async () => {
    const { base } = await bootRemote();
    const client = await harness.connect(base, OWNER_SECRET);
    await until(() => service!.handshakes.length === 1, 5000, 'upstream connect');
    const ack = await new Promise<unknown>((resolve) => client.emit('terminal:input', { id: 't2', data: 'echo hi\n' }, resolve));
    expect(ack).toEqual({ ok: true, echoed: 'echo hi\n' });
    expect(service!.received('terminal:input')).toEqual([[{ id: 't2', data: 'echo hi\n' }]]);
    // multi-arg events keep every argument
    client.emit('resize', { id: 't1', cols: 100, rows: 30 }, 'extra');
    await until(() => service!.received('resize').length === 1);
    expect(service!.received('resize')[0]).toEqual([{ id: 't1', cols: 100, rows: 30 }, 'extra']);
  });

  it('reconnects with the CURRENT active terminal, tells the browser about the drop, drops stale input, re-sends sizes', async () => {
    const { base } = await bootRemote();
    const client = await harness.connect(base, OWNER_SECRET);
    const rec = record(client);
    await until(() => service!.handshakes.length === 1, 5000, 'upstream connect');
    expect(service!.handshakes[0].activeTerminalId).toBeUndefined();
    client.emit('terminal:select', { id: 't2' });
    client.emit('resize', { id: 't2', cols: 120, rows: 40 });
    await until(() => rec.events.some((e) => e.event === 'terminal:selected'));

    const port = service!.port;
    await service!.stop();
    await until(() => rec.text().includes('Terminal service connection lost'), 5000, 'drop notice');
    // Typed well after the stale window: must never reach the shell.
    await sleep(600);
    client.emit('input', 'rm -rf stale-keystrokes\n');
    await sleep(100);

    const restarted = new FakePtyService();
    service = restarted;
    await restarted.start(port);
    await until(() => restarted.handshakes.length === 1, 10_000, 'upstream reconnect');
    expect(restarted.handshakes[0]).toMatchObject({ token: PTY_TOKEN, activeTerminalId: 't2' });
    await until(() => rec.text().includes('Terminal service reconnected'), 5000, 'reconnect notice');
    expect(rec.text()).toMatch(/discarded/);
    await until(() => restarted.received('resize').length > 0, 3000, 'resize replay');
    expect(restarted.received('resize')[0]).toEqual([{ id: 't2', cols: 120, rows: 40 }]);
    await sleep(200);
    expect(restarted.received('input')).toEqual([]);
    // Input after the reconnect flows again.
    client.emit('input', 'ls\n');
    await until(() => restarted.received('input').length === 1);
    expect(restarted.received('input')[0]).toEqual(['ls\n']);
  }, 30_000);

  it('input typed during a SHORT blip is delivered (buffered), not dropped', async () => {
    const { base } = await bootRemote();
    process.env.RELAY_PTY_STALE_INPUT_MS = '5000';
    const client = await harness.connect(base, OWNER_SECRET);
    await until(() => service!.handshakes.length === 1);
    const port = service!.port;
    await service!.stop();
    client.emit('input', 'typed-during-blip\n');
    const restarted = new FakePtyService();
    service = restarted;
    await restarted.start(port);
    await until(() => restarted.received('input').length === 1, 10_000, 'buffered input');
    expect(restarted.received('input')[0]).toEqual(['typed-during-blip\n']);
  }, 30_000);

  it('a noTerminals socket gets no upstream bridge (Option B main socket)', async () => {
    const { base } = await bootRemote();
    const { io } = await import('socket.io-client');
    const client = io(base, { auth: { token: OWNER_SECRET, noTerminals: true }, transports: ['websocket'], reconnection: false });
    harness.clients.push(client);
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
    const rec = record(client);
    client.emit('terminal:input', { id: 't1', data: 'x' });
    await sleep(500);
    expect(service!.handshakes).toEqual([]);
    expect(rec.events.filter((e) => e.event.startsWith('terminal'))).toEqual([]);
  });
});

describe('embedded engine', () => {
  function recordingFactory(): { factory: PtyFactory; ptys: Array<{ pty: FakePty; env: NodeJS.ProcessEnv }> } {
    const ptys: Array<{ pty: FakePty; env: NodeJS.ProcessEnv }> = [];
    return {
      ptys,
      factory: (options) => {
        const pty = new FakePty();
        ptys.push({ pty, env: options.env });
        return pty;
      },
    };
  }

  it('terminal:input writes to the addressed terminal regardless of selection; mouse reports are filtered', async () => {
    const { factory, ptys } = recordingFactory();
    const { base } = await harness.boot({}, { pty: factory });
    const client = await harness.connect(base, OWNER_SECRET);
    const rec = record(client);
    await until(() => rec.events.some((e) => e.event === 'terminal:selected'), 5000, 'first terminal');
    const firstId = (rec.events.find((e) => e.event === 'terminal:selected')!.args[0] as { id: string }).id;
    client.emit('terminal:create', {});
    await until(() => ptys.length === 2, 5000, 'second terminal');
    const selected = rec.events.filter((e) => e.event === 'terminal:selected').map((e) => (e.args[0] as { id: string }).id);
    const secondId = selected[selected.length - 1];
    expect(secondId).not.toBe(firstId);

    // The SECOND terminal is selected; address the FIRST by id.
    const ack = await new Promise<unknown>((resolve) => client.emit('terminal:input', { id: firstId, data: 'echo one\n' }, resolve));
    expect(ack).toEqual({ ok: true });
    expect(ptys[0].pty.writes).toEqual(['echo one\n']);
    expect(ptys[1].pty.writes).toEqual([]);

    await new Promise((resolve) => client.emit('terminal:input', { id: firstId, data: '\x1b[<0;10;5M' }, resolve));
    expect(ptys[0].pty.writes).toEqual(['echo one\n']);
    expect(await new Promise((resolve) => client.emit('terminal:input', { id: 'nope', data: 'x' }, resolve))).toEqual({ ok: false, error: 'unknown_terminal' });

    // RELAY_TERMINAL_ID is each shell's own id.
    expect(ptys[0].env.RELAY_TERMINAL_ID).toBe(firstId);
    expect(ptys[1].env.RELAY_TERMINAL_ID).toBe(secondId);
  });

  it('a noTerminals socket spawns no shell and gets no terminal events', async () => {
    const { factory, ptys } = recordingFactory();
    const { base } = await harness.boot({}, { pty: factory });
    const { io } = await import('socket.io-client');
    const client = io(base, { auth: { token: OWNER_SECRET, noTerminals: true }, transports: ['websocket'], reconnection: false });
    harness.clients.push(client);
    const rec = record(client);
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
    client.emit('terminal:create', {});
    await sleep(400);
    expect(ptys.length).toBe(0);
    expect(rec.events.filter((e) => e.event.startsWith('terminal'))).toEqual([]);
  });
});
