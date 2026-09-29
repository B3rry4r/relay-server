// =============================================================================
// Agent view END TO END (agent-display-spec §12.2) on a REAL PTY: the production
// relay server (embedded node-pty), the real relay-agent-hook installed by the
// real installer into the temp workspace HOME, and the fake agent
// (test/fixtures/agent/fake-agent.mjs) running inside a real shell. A
// socket.io client plays relay-web.
//
// Asserts: agent:snapshot / agent:event kinds over the socket; a hook-sourced
// permission.request attributed by /proc lineage; agent:respond REFUSED while the
// prompt is not on the terminal screen (guard-mismatch, and the agent received
// no key), accepted once it is (the file is created — checked on disk, not the
// ack); resolution only from evidence; agent:choose typing "2\r"; deny → Esc →
// denied tool result + interrupted turn + NO file; reconnect delta/snapshot.
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, defaultPtyFactory, type RelayServer } from '../../src/relay-server';

const ROOT = path.resolve(__dirname, '../..');
const FAKE_AGENT = path.join(ROOT, 'test/fixtures/agent/fake-agent.mjs');
const TIMEOUT_MS = 45_000;

function probeRealPty(): string | null {
  if (process.env.RELAY_PTY_MODE?.trim().toLowerCase() === 'remote') return 'RELAY_PTY_MODE=remote routes terminals to the relay-pty service';
  if (!fs.existsSync('/proc/self/stat')) return 'no /proc on this host (lineage attribution needs it)';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty') as { spawn(file: string, args: string[], opts: object): { pid: number; kill(): void } };
    const probe = nodePty.spawn('/bin/bash', ['-c', 'exit 0'], { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env, name: 'xterm' });
    if (!probe.pid) return 'node-pty spawned no process';
    try { probe.kill(); } catch { /* exited */ }
    return null;
  } catch (error) {
    return `node-pty cannot spawn a shell: ${error instanceof Error ? error.message : String(error)}`;
  }
}
const PTY_UNAVAILABLE = probeRealPty();
if (PTY_UNAVAILABLE) console.warn(`[skip] NEEDS_EXTERNAL real PTY: ${PTY_UNAVAILABLE}`);

type Rec = { name: string; payload: any };

async function connect(port: number) {
  const client = createClient(`http://127.0.0.1:${port}`, { auth: { token: 'test-token' }, reconnection: false, transports: ['websocket'], autoConnect: false });
  const events: Rec[] = [];
  const waiters: Array<() => void> = [];
  client.onAny((name: string, payload: any) => { events.push({ name, payload }); for (const w of waiters.splice(0)) w(); });
  const until = <T>(check: () => T | undefined, what: string, ms = 20_000): Promise<T> => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const tick = () => { const hit = check(); if (hit !== undefined) { clearTimeout(deadline); resolve(hit); return; } waiters.push(tick); };
    tick();
  });
  const agentEvents = (terminalId: string) => events.filter((e) => e.name === 'agent:event' && e.payload.terminalId === terminalId).map((e) => e.payload.event);
  const output = (id: string) => events.filter((e) => e.name === 'terminal:output' && e.payload?.id === id).map((e) => String(e.payload.data)).join('');
  const emitAck = <T = any>(name: string, payload: unknown) => new Promise<T>((resolve) => client.emit(name, payload, resolve));
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); client.connect(); });
  return {
    client, events, emitAck, agentEvents, output,
    waitFor: (name: string, pred: (p: any) => boolean = () => true, ms?: number) => until(() => events.find((e) => e.name === name && pred(e.payload))?.payload, name, ms),
    waitForAgent: (terminalId: string, pred: (ev: any) => boolean, what: string, ms?: number) => until(() => agentEvents(terminalId).find(pred), what, ms),
    waitForOutput: (id: string, text: string, ms?: number) => until(() => (output(id).includes(text) ? true : undefined), `output ${JSON.stringify(text)}`, ms),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keylog = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe.skipIf(PTY_UNAVAILABLE !== null)('Agent view E2E: fake agent in a real PTY', () => {
  let workspace = '';
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-e2e-'));
    fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = workspace;
    process.env.SHELL = '/bin/bash';
    // what setup-workspace.sh does at boot: hook binary + installer into the workspace HOME
    const hook = path.join(workspace, '.relay/bin/relay-agent-hook');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'agent/relay-agent-hook'), hook);
    fs.chmodSync(hook, 0o755);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/relay-agent-install.mjs'), '--home', workspace, '--guide', path.join(ROOT, 'agent/RELAY-AGENT-GUIDE.md'), '--hook', hook], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`installer failed: ${r.stderr}`);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const s of servers.splice(0)) await s.stop();
    for (const key of ['PORT', 'AUTH_TOKEN', 'WORKSPACE', 'SHELL']) delete process.env[key];
    // the killed shell may still be writing (.bash_history on SIGHUP): retry ENOTEMPTY
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function start() {
    const relay = createRelayServer(defaultPtyFactory);
    servers.push(relay);
    const port = await relay.start();
    const rec = await connect(port);
    clients.push(rec.client);
    const created = await rec.waitFor('terminal:created');
    const terminalId: string = created.id;
    // the shell env carries the terminal id (spec §5.1) — read it back from the kernel
    const env = fs.readFileSync(`/proc/${created.pid}/environ`, 'utf8').split('\0');
    expect(env).toContain(`RELAY_TERMINAL_ID=${terminalId}`);
    expect(env).toContain(`RELAY_AGENT_SPOOL=${path.join(workspace, '.relay/state/agent-events')}`);
    const sessions = await rec.waitFor('agent:sessions');
    expect(typeof sessions.epoch).toBe('string');
    expect(await rec.emitAck('agent:subscribe', { terminalId })).toEqual({ ok: true });
    const snap = await rec.waitFor('agent:snapshot', (p) => p.terminalId === terminalId);
    expect(snap).toMatchObject({ epoch: sessions.epoch, session: null, events: [], hasMore: false });
    return { port, rec, terminalId, epoch: sessions.epoch as string };
  }

  it('allow: guard refuses keys until the prompt is on screen, then Allow creates the file; resolution from evidence; choose; reconnect', async () => {
    const { port, rec, terminalId, epoch } = await start();
    const log = path.join(workspace, 'keys.log');
    rec.client.emit('input', `cd ${workspace} && FAKE_AGENT_KEYLOG=${log} FAKE_AGENT_DIALOG_DELAY_MS=2500 node ${FAKE_AGENT} "create the demo file"\n`);

    const req = await rec.waitForAgent(terminalId, (e) => e.kind === 'permission.request', 'permission.request');
    expect(req).toMatchObject({ source: 'hook', cli: 'claude', tool: 'Bash', title: 'touch relay-demo.txt', detail: 'Create a demo file', answerable: true });
    expect(req.options.map((o: any) => o.id)).toEqual(['allow_once', 'allow_always', 'deny']);
    const call = rec.agentEvents(terminalId).find((e) => e.kind === 'tool.call');
    if (call) expect(req.toolUseId).toBe(call.toolUseId);

    // the hook fired but the dialog is not drawn yet → no key may be written
    expect(await rec.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' })).toEqual({ ok: false, reason: 'guard-mismatch' });
    expect(await rec.emitAck('agent:respond', { terminalId, requestId: 'not-the-pending-one', choice: 'allow_once' })).toEqual({ ok: false, reason: 'stale' });
    expect(await rec.emitAck('agent:send', { terminalId, text: 'y' })).toEqual({ ok: false, reason: 'awaiting-permission' });
    await sleep(300);
    expect(keylog(log)).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'relay-demo.txt'))).toBe(false);

    // the prompt is on screen now → the guard lets the key through
    await rec.waitForOutput(terminalId, 'Do you want to proceed?');
    await sleep(400); // PTY → ScreenGuard parse
    const summary = (await rec.waitFor('agent:sessions', (p) => p.sessions.some((s: any) => s.terminalId === terminalId && s.state === 'awaiting-permission'))).sessions.find((s: any) => s.terminalId === terminalId);
    expect(summary).toMatchObject({ attribution: 'hook', pending: { requestId: req.requestId } });
    expect(await rec.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' })).toEqual({ ok: true });

    const resolved = await rec.waitForAgent(terminalId, (e) => e.kind === 'permission.resolved', 'permission.resolved');
    expect(resolved).toMatchObject({ requestId: req.requestId, outcome: 'allowed', by: 'relay' });
    expect(fs.existsSync(path.join(workspace, 'relay-demo.txt'))).toBe(true);
    expect(keylog(log)).toEqual(['1']);
    // a second answer to the same request is stale (never a double key)
    expect(await rec.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' })).toEqual({ ok: false, reason: 'stale' });

    const text = await rec.waitForAgent(terminalId, (e) => e.kind === 'assistant.text' && e.blocks.length > 0, 'assistant.text with blocks');
    expect(text.blocks.map((b: any) => b.kind)).toEqual(['summary', 'choices']);
    await rec.waitForAgent(terminalId, (e) => e.kind === 'turn.end', 'turn.end');
    await rec.waitFor('agent:sessions', (p) => p.sessions.some((s: any) => s.terminalId === terminalId && s.state === 'awaiting-input'));

    // tap choice 2 → the agent reads "2\r"
    expect(await rec.emitAck('agent:choose', { terminalId, eventId: text.id, optionN: 2 })).toEqual({ ok: true });
    await rec.waitForOutput(terminalId, 'CHOSE:2');
    expect(keylog(log)).toEqual(['1', '2', '\r']);
    await rec.waitForAgent(terminalId, (e) => e.kind === 'user.message' && e.text === '2', 'user.message 2');
    await rec.waitForAgent(terminalId, (e) => e.kind === 'session.end', 'session.end');
    // a stale choice (a newer user message exists) is refused
    expect(await rec.emitAck('agent:choose', { terminalId, eventId: text.id, optionN: 1 })).toEqual({ ok: false, reason: 'stale' });

    const live = rec.agentEvents(terminalId);
    const kinds = live.map((e: any) => e.kind);
    for (const k of ['session.start', 'status', 'user.message', 'assistant.thinking', 'assistant.text', 'tool.call', 'permission.request', 'tool.result', 'permission.resolved', 'turn.end', 'session.end']) expect(kinds, k).toContain(k);
    expect(kinds.indexOf('permission.resolved')).toBeGreaterThan(kinds.indexOf('permission.request'));
    expect(live.map((e: any) => e.seq)).toEqual([...live.map((e: any) => e.seq)].sort((a, b) => a - b));
    expect(new Set(live.map((e: any) => e.id)).size).toBe(live.length);

    // reconnect: same epoch + sinceSeq → delta; no epoch → full snapshot with the SAME ids
    const again = await connect(port);
    clients.push(again.client);
    const mid = live[4].seq;
    expect(await again.emitAck('agent:subscribe', { terminalId, epoch, sinceSeq: mid })).toEqual({ ok: true });
    const delta = await again.waitFor('agent:events', (p) => p.terminalId === terminalId);
    expect(delta.events.map((e: any) => e.id)).toEqual(live.filter((e: any) => e.seq > mid).map((e: any) => e.id));
    expect(await again.emitAck('agent:subscribe', { terminalId })).toEqual({ ok: true });
    const snap = await again.waitFor('agent:snapshot', (p) => p.terminalId === terminalId);
    expect(snap.events.map((e: any) => e.id)).toEqual(live.map((e: any) => e.id));
    expect(snap.session).toMatchObject({ terminalId, cli: 'claude', state: 'ended', attribution: 'hook' });
  }, TIMEOUT_MS);

  it('deny: Esc → denied tool result + interrupted turn, and NO file', async () => {
    const { rec, terminalId } = await start();
    const dir = path.join(workspace, 'deny');
    fs.mkdirSync(dir);
    const log = path.join(workspace, 'keys-deny.log');
    rec.client.emit('input', `cd ${dir} && FAKE_AGENT_KEYLOG=${log} node ${FAKE_AGENT} "create the demo file"\n`);
    const req = await rec.waitForAgent(terminalId, (e) => e.kind === 'permission.request', 'permission.request');
    await rec.waitForOutput(terminalId, 'Do you want to proceed?');
    await sleep(400);
    expect(await rec.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'deny' })).toEqual({ ok: true });
    const result = await rec.waitForAgent(terminalId, (e) => e.kind === 'tool.result', 'tool.result');
    expect(result).toMatchObject({ ok: false, denied: true });
    expect(await rec.waitForAgent(terminalId, (e) => e.kind === 'permission.resolved', 'permission.resolved')).toMatchObject({ outcome: 'denied', by: 'relay' });
    expect(await rec.waitForAgent(terminalId, (e) => e.kind === 'turn.end', 'turn.end')).toMatchObject({ reason: 'interrupted' });
    await rec.waitForOutput(terminalId, 'FAKE_AGENT_EXIT');
    expect(keylog(log)).toEqual(['\x1b']);
    expect(fs.existsSync(path.join(dir, 'relay-demo.txt'))).toBe(false);
  }, TIMEOUT_MS);
});
