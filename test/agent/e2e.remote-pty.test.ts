// =============================================================================
// Agent view E2E in REMOTE PTY mode (agent-display-spec §12.2 "Remote mode"):
// the terminals live in a real relay-pty service on loopback; relay-server runs
// with RELAY_PTY_MODE=remote. Two browser shapes:
//   - bridge: the classic socket (relay-server proxies terminals) → the answer
//     keys go through THAT socket's bridge as terminal:input {id,data};
//   - Option B: the browser's terminal socket goes straight to the PTY service
//     and its relay-server socket is auth.noTerminals:true → the tracker answers
//     through its own single PTY-service link (CONTRACTS §4).
// The ScreenGuard is fed by that link in both cases.
//
// Needs a built relay-pty: RELAY_PTY_ENTRY=<relay-pty>/dist/src/pty/main.js
// (skipped with the reason otherwise — relay-pty is a separate repository).
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, defaultPtyFactory, type RelayServer } from '../../src/relay-server';

const ROOT = path.resolve(__dirname, '../..');
const FAKE_AGENT = path.join(ROOT, 'test/fixtures/agent/fake-agent.mjs');
const ENTRY = (process.env.RELAY_PTY_ENTRY || '').trim();
const SKIP = !ENTRY ? 'RELAY_PTY_ENTRY is not set (path to a built relay-pty dist/src/pty/main.js)' : !fs.existsSync(ENTRY) ? `RELAY_PTY_ENTRY ${ENTRY} does not exist` : null;
if (SKIP) console.warn(`[skip] NEEDS_EXTERNAL relay-pty service: ${SKIP}`);
const PTY_TOKEN = 'pty-internal-token-0123456789abcdef0123456789';
const TIMEOUT_MS = 60_000;

type Rec = { name: string; payload: any };
function recorder(client: Socket) {
  const events: Rec[] = [];
  const waiters: Array<() => void> = [];
  client.onAny((name: string, payload: any) => { events.push({ name, payload }); for (const w of waiters.splice(0)) w(); });
  const until = <T>(check: () => T | undefined, what: string, ms = 25_000): Promise<T> => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const tick = () => { const hit = check(); if (hit !== undefined) { clearTimeout(deadline); resolve(hit); return; } waiters.push(tick); };
    tick();
  });
  const agentEvents = (tid: string) => events.filter((e) => e.name === 'agent:event' && e.payload.terminalId === tid).map((e) => e.payload.event);
  const output = (id: string) => events.filter((e) => e.name === 'terminal:output' && e.payload?.id === id).map((e) => String(e.payload.data)).join('');
  return {
    events, agentEvents, output,
    emitAck: <T = any>(name: string, payload: unknown) => new Promise<T>((resolve) => client.emit(name, payload, resolve)),
    waitFor: (name: string, pred: (p: any) => boolean = () => true) => until(() => events.find((e) => e.name === name && pred(e.payload))?.payload, name),
    waitForAgent: (tid: string, pred: (ev: any) => boolean, what: string) => until(() => agentEvents(tid).find(pred), what),
    waitForOutput: (id: string, text: string) => until(() => (output(id).includes(text) ? true : undefined), `output ${JSON.stringify(text)}`),
  };
}
async function open(url: string, auth: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const client = createClient(url, { auth, reconnection: false, transports: ['websocket'], autoConnect: false, forceNew: true, ...extra });
  const rec = recorder(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); client.connect(); });
  return { client, ...rec };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keylog = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe.skipIf(SKIP !== null)('Agent view E2E: remote PTY (relay-pty on loopback)', () => {
  let workspace = '';
  let pty: ChildProcess | null = null;
  let ptyUrl = '';
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-remote-'));
    fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
    const hook = path.join(workspace, '.relay/bin/relay-agent-hook');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'agent/relay-agent-hook'), hook);
    fs.chmodSync(hook, 0o755);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/relay-agent-install.mjs'), '--home', workspace, '--guide', path.join(ROOT, 'agent/RELAY-AGENT-GUIDE.md'), '--hook', hook], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`installer failed: ${r.stderr}`);

    pty = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH, HOME: workspace, WORKSPACE: workspace, SHELL: '/bin/bash', RELAY_PTY_TOKEN: PTY_TOKEN, RELAY_PTY_PORT: '0', RELAY_PTY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ptyUrl = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`relay-pty did not start: ${out}`)), 15_000);
      const onData = (d: Buffer) => {
        out += d.toString();
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
      };
      pty!.stdout!.on('data', onData);
      pty!.stderr!.on('data', onData);
      pty!.once('exit', (code) => reject(new Error(`relay-pty exited ${code}: ${out}`)));
    });

    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = workspace;
    process.env.SHELL = '/bin/bash';
    process.env.RELAY_PTY_MODE = 'remote';
    process.env.RELAY_PTY_URL = ptyUrl;
    process.env.RELAY_PTY_TOKEN = PTY_TOKEN;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const s of servers.splice(0)) await s.stop();
    for (const key of ['PORT', 'AUTH_TOKEN', 'WORKSPACE', 'SHELL', 'RELAY_PTY_MODE', 'RELAY_PTY_URL', 'RELAY_PTY_TOKEN']) delete process.env[key];
    if (pty && pty.exitCode === null) {
      pty.kill('SIGTERM');
      await new Promise((r) => { const t = setTimeout(r, 3000); pty!.once('exit', () => { clearTimeout(t); r(undefined); }); });
      if (pty.exitCode === null) pty.kill('SIGKILL');
    }
    pty = null;
    // the killed shell may still be writing (.bash_history on SIGHUP): retry ENOTEMPTY
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function relay() {
    const server = createRelayServer(defaultPtyFactory);
    servers.push(server);
    return `http://127.0.0.1:${await server.start()}`;
  }

  async function allowFlow(app: Awaited<ReturnType<typeof open>>, term: Awaited<ReturnType<typeof open>>, terminalId: string, dir: string) {
    const log = path.join(dir, 'keys.log');
    term.client.emit('terminal:input', { id: terminalId, data: `cd ${dir} && FAKE_AGENT_KEYLOG=${log} FAKE_AGENT_DIALOG_DELAY_MS=2500 node ${FAKE_AGENT} "create the demo file"\n` });
    const req = await app.waitForAgent(terminalId, (e) => e.kind === 'permission.request', 'permission.request');
    expect(req).toMatchObject({ source: 'hook', answerable: true, title: 'touch relay-demo.txt' });
    expect(await app.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' })).toEqual({ ok: false, reason: 'guard-mismatch' });
    expect(keylog(log)).toEqual([]);
    await term.waitForOutput(terminalId, 'Do you want to proceed?');
    // the tracker's ScreenGuard is fed through the PTY-service link; give it a beat
    let ack: any = null;
    for (let i = 0; i < 20; i += 1) {
      ack = await app.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' });
      if (ack.ok || ack.reason !== 'guard-mismatch') break;
      await sleep(250);
    }
    expect(ack).toEqual({ ok: true });
    expect(await app.waitForAgent(terminalId, (e) => e.kind === 'permission.resolved', 'resolved')).toMatchObject({ outcome: 'allowed', by: 'relay' });
    expect(fs.existsSync(path.join(dir, 'relay-demo.txt'))).toBe(true);
    expect(keylog(log)).toEqual(['1']);
    const text = await app.waitForAgent(terminalId, (e) => e.kind === 'assistant.text' && e.blocks.length > 0, 'blocks');
    await app.waitForAgent(terminalId, (e) => e.kind === 'turn.end', 'turn.end');
    expect(await app.emitAck('agent:choose', { terminalId, eventId: text.id, optionN: 2 })).toEqual({ ok: true });
    await term.waitForOutput(terminalId, 'CHOSE:2');
    await app.waitForAgent(terminalId, (e) => e.kind === 'session.end', 'session.end');
    const session = (await app.waitFor('agent:sessions', (p) => p.sessions.some((s: any) => s.terminalId === terminalId && s.state === 'ended'))).sessions.find((s: any) => s.terminalId === terminalId);
    expect(session).toMatchObject({ cli: 'claude', attribution: 'hook' });
    expect(session.limited).toBeUndefined();
  }

  it('bridge mode: answers go through the requesting socket\'s bridge', async () => {
    const url = await relay();
    const app = await open(url, { token: 'test-token' });
    clients.push(app.client);
    const created = await app.waitFor('terminal:created');
    const env = fs.readFileSync(`/proc/${created.pid}/environ`, 'utf8').split('\0');
    expect(env).toContain(`RELAY_TERMINAL_ID=${created.id}`);
    expect(await app.emitAck('agent:subscribe', { terminalId: created.id })).toEqual({ ok: true });
    const dir = path.join(workspace, 'bridge');
    fs.mkdirSync(dir);
    await allowFlow(app, app, created.id, dir);
  }, TIMEOUT_MS);

  it('Option B: the browser types on the PTY service directly; relay-server answers through its own service link', async () => {
    const url = await relay();
    const term = await open(ptyUrl, { token: PTY_TOKEN });
    clients.push(term.client);
    const created = await term.waitFor('terminal:created');
    const app = await open(url, { token: 'test-token', noTerminals: true });
    clients.push(app.client);
    // the Option-B app socket gets agent events but no terminal plumbing
    await app.waitFor('agent:sessions');
    expect(await app.emitAck('agent:subscribe', { terminalId: created.id })).toEqual({ ok: true });
    await sleep(200);
    expect(app.events.some((e) => e.name.startsWith('terminal'))).toBe(false);
    const dir = path.join(workspace, 'optionb');
    fs.mkdirSync(dir);
    await allowFlow(app, term, created.id, dir);
  }, TIMEOUT_MS);
});
