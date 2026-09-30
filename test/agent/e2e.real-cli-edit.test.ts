// =============================================================================
// Agent view × REAL CLIs: an EDIT prompt answered from the card (critic P1).
//
// The production relay server (embedded node-pty) with the real installer's hooks
// in the terminal HOME. The REAL claude / codex / gemini binary runs in a relay
// terminal against a scripted mock model (test/fixtures/agent/mock/*-edit.mjs),
// which asks for one edit of hello.txt. A socket.io client plays relay-web:
// it waits for the permission.request, answers it with agent:respond
// allow_once, and the file on disk must change. It is checked on disk, not
// from the ack.
//
// NEEDS_EXTERNAL: set RELAY_AGENT_CLI_BIN to a directory holding the `claude`,
// `codex` and `gemini` binaries (e.g. `npm i @anthropic-ai/claude-code@2.1.284
// @openai/codex@0.159.0 @google/gemini-cli@0.61.0` → node_modules/.bin). No
// real model is called: every CLI is pointed at the local mock.
// =============================================================================
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, defaultPtyFactory, type RelayServer } from '../../src/relay-server';
import { editPermissionOptions } from '../../src/relay-server/agent/keys';
import { reapTerminalSessions } from './reap';

const ROOT = path.resolve(__dirname, '../..');
const MOCKS = path.join(ROOT, 'test/fixtures/agent/mock');
const CLI_BIN = (process.env.RELAY_AGENT_CLI_BIN || '').trim();
const TIMEOUT_MS = 120_000;

function probe(): string | null {
  if (!CLI_BIN) return 'RELAY_AGENT_CLI_BIN is not set (a directory with the claude, codex and gemini binaries)';
  if (process.env.RELAY_PTY_MODE?.trim().toLowerCase() === 'remote') return 'RELAY_PTY_MODE=remote';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty') as { spawn(file: string, args: string[], opts: object): { pid: number; kill(): void } };
    const p = nodePty.spawn('/bin/bash', ['-c', 'exit 0'], { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env, name: 'xterm' });
    try { p.kill(); } catch { /* exited */ }
    return null;
  } catch (error) {
    return `node-pty cannot spawn a shell: ${error instanceof Error ? error.message : String(error)}`;
  }
}
const UNAVAILABLE = probe();
if (UNAVAILABLE) console.warn(`[skip] NEEDS_EXTERNAL real agent CLIs: ${UNAVAILABLE}`);
const hasCli = (name: string) => Boolean(CLI_BIN) && fs.existsSync(path.join(CLI_BIN, name));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

async function connect(port: number) {
  const client = createClient(`http://127.0.0.1:${port}`, { auth: { token: 'test-token' }, reconnection: false, transports: ['websocket'], autoConnect: false });
  const events: Array<{ name: string; payload: any }> = [];
  client.onAny((name: string, payload: any) => { events.push({ name, payload }); });
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); client.connect(); });
  // The rendered screen per terminal (what a user sees), as the ScreenGuard renders it:
  // raw PTY output interleaves cursor moves, so text is matched on the screen instead.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
  const terms = new Map<string, InstanceType<typeof Terminal>>();
  client.on('terminal:output', (p: { id: string; data: string }) => {
    let t = terms.get(p.id);
    if (!t) { t = new Terminal({ cols: 100, rows: 34, allowProposedApi: true }); terms.set(p.id, t); }
    t.write(p.data);
  });
  const screen = (id: string) => {
    const t = terms.get(id);
    if (!t) return '';
    const b = t.buffer.active; const lines: string[] = [];
    for (let i = 0; i < t.rows; i += 1) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  const output = (id: string) => events.filter((e) => e.name === 'terminal:output' && e.payload?.id === id).map((e) => String(e.payload.data)).join('');
  const agentEvents = (id: string) => events.filter((e) => e.name === 'agent:event' && e.payload.terminalId === id).map((e) => e.payload.event);
  const until = async <T>(fn: () => T | undefined, what: string, ms = 60_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = fn();
      if (hit !== undefined && hit !== false) return hit as T;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  return {
    client, events, output, screen, agentEvents, until,
    emitAck: <T = any>(name: string, payload: unknown) => new Promise<T>((resolve) => client.emit(name, payload, resolve)),
  };
}

type CliCase = {
  cli: 'claude' | 'codex' | 'gemini';
  mock: string;
  /** Writes the CLI's own config into HOME (before the relay installer merges its hooks). */
  configure(home: string, proj: string, mockPort: number): void;
  command(mockPort: number): string;
  /** Text the CLI prints while its edit prompt is up. */
  promptText: string;
};

const CASES: CliCase[] = [
  {
    cli: 'claude',
    mock: 'mock-anthropic-edit.mjs',
    configure(home, proj) {
      const key = 'sk-ant-api03-mockmockmockmockmockmockmockmockmockmockmockmock-AAAAAAAA';
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true, theme: 'dark', numStartups: 3,
        customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
        projects: { [proj]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
      }));
    },
    command: (p) => `ANTHROPIC_BASE_URL=http://127.0.0.1:${p} ANTHROPIC_API_KEY=sk-ant-api03-mockmockmockmockmockmockmockmockmockmockmockmock-AAAAAAAA CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 claude --permission-mode default "edit hello.txt"`,
    promptText: 'Do you want to make this edit to',
  },
  {
    cli: 'codex',
    mock: 'mock-openai-edit.mjs',
    configure(home, proj, p) {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex/config.toml'), [
        'model = "gpt-5-codex"', 'model_provider = "mock"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', '',
        '[model_providers.mock]', 'name = "mock"', `base_url = "http://127.0.0.1:${p}/v1"`, 'wire_api = "responses"', 'env_key = "MOCK_OPENAI_KEY"', '',
        `[projects."${proj}"]`, 'trust_level = "trusted"', '',
        '[features]', 'daemon_auto_start = false', '',
      ].join('\n'));
    },
    command: () => 'MOCK_OPENAI_KEY=sk-mock codex "edit hello.txt"',
    promptText: 'Would you like to make the following edits?',
  },
  {
    cli: 'gemini',
    mock: 'mock-gemini-edit.mjs',
    configure(home) {
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini/settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
        general: { disableAutoUpdate: true, disableUpdateNag: true }, privacy: { usageStatisticsEnabled: false },
      }));
    },
    command: (p) => `GEMINI_API_KEY=mock-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${p} gemini -i "edit hello.txt"`,
    promptText: 'Apply this change?',
  },
];

describe.skipIf(UNAVAILABLE !== null)('Agent view × REAL CLIs: an edit prompt answered from the card', () => {
  let workspace = '';
  let mock: ChildProcess | null = null;
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];
  const shellPids: number[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-cli-'));
    fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = workspace;
    process.env.SHELL = '/bin/bash';
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const s of servers.splice(0)) await s.stop();
    for (const key of ['PORT', 'AUTH_TOKEN', 'WORKSPACE', 'SHELL']) delete process.env[key];
    if (mock && mock.exitCode === null) mock.kill('SIGKILL');
    mock = null;
    await reapTerminalSessions(shellPids.splice(0));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it.skipIf(!hasCli(c.cli))(`${c.cli}: agent:respond allow_once at the real edit prompt edits the file on disk`, async () => {
      const proj = path.join(workspace, 'proj');
      fs.mkdirSync(proj);
      const file = path.join(proj, 'hello.txt');
      fs.writeFileSync(file, 'hello world\n');
      const mockPort = await freePort();
      c.configure(workspace, proj, mockPort);
      // what setup-workspace.sh does at boot: the hook binary + the installer, into the workspace HOME
      const hook = path.join(workspace, '.relay/bin/relay-agent-hook');
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'agent/relay-agent-hook'), hook);
      fs.chmodSync(hook, 0o755);
      const inst = spawnSync(process.execPath, [path.join(ROOT, 'scripts/relay-agent-install.mjs'), '--home', workspace, '--guide', path.join(ROOT, 'agent/RELAY-AGENT-GUIDE.md'), '--hook', hook], { encoding: 'utf8' });
      expect(inst.status, inst.stderr).toBe(0);

      const mockLog = path.join(workspace, 'mock.log');
      mock = spawn(process.execPath, [path.join(MOCKS, c.mock), String(mockPort), mockLog], { env: { ...process.env, MOCK_EDIT_FILE: file }, stdio: 'ignore' });
      for (let i = 0; i < 50 && !(fs.existsSync(mockLog) && fs.readFileSync(mockLog, 'utf8').includes('listening')); i += 1) await sleep(100);

      const relay = createRelayServer(defaultPtyFactory);
      servers.push(relay);
      const port = await relay.start();
      const rec = await connect(port);
      clients.push(rec.client);
      const created = await rec.until(() => rec.events.find((e) => e.name === 'terminal:created')?.payload, 'terminal:created');
      const terminalId: string = created.id;
      shellPids.push(created.pid);
      expect(await rec.emitAck('agent:subscribe', { terminalId })).toEqual({ ok: true });

      rec.client.emit('input', `cd ${proj} && PATH=${CLI_BIN}:$PATH ${c.command(mockPort)}\n`);
      if (c.cli === 'codex') {
        // Codex asks once to trust new hooks (spec §10.4: the user taps "Trust all" in the terminal).
        const trust = await rec.until(() => (/Hooks need review/.test(rec.screen(terminalId)) ? 'review' : (rec.screen(terminalId).includes(c.promptText) ? 'prompt' : undefined)), `codex start\n${rec.screen(terminalId)}`, 60_000);
        if (trust === 'review') {
          rec.client.emit('input', '2');
          await sleep(1000);
          if (/Hooks need review/.test(rec.screen(terminalId))) rec.client.emit('input', '\r');
        }
      }

      const req = await rec.until(() => rec.agentEvents(terminalId).find((e: any) => e.kind === 'permission.request'), `${c.cli} permission.request`, 90_000)
        .catch((error) => { throw new Error(`${error.message}\n--- screen:\n${rec.screen(terminalId)}`); });
      expect(req.answerable).toBe(true);
      expect(req.options.map((o: any) => o.id)).toEqual(['allow_once', 'allow_always', 'deny']);
      expect(req.options[1].detail).toBe(editPermissionOptions(c.cli)[1].detail);
      await rec.until(() => rec.screen(terminalId).includes(c.promptText), `${c.cli} edit prompt on screen`, 60_000)
        .catch((error) => { throw new Error(`${error.message}\n--- screen:\n${rec.screen(terminalId)}`); });
      await sleep(600); // PTY → ScreenGuard parse
      expect(fs.readFileSync(file, 'utf8')).toBe('hello world\n'); // nothing happens before the answer

      const ack = await rec.emitAck('agent:respond', { terminalId, requestId: req.requestId, choice: 'allow_once' });
      expect(ack).toEqual({ ok: true });
      await rec.until(() => fs.readFileSync(file, 'utf8') === 'hello relay\n', `${c.cli}: hello.txt edited on disk`, 30_000);
      expect(fs.readFileSync(file, 'utf8')).toBe('hello relay\n');
      const resolved = await rec.until(() => rec.agentEvents(terminalId).find((e: any) => e.kind === 'permission.resolved' && e.requestId === req.requestId), 'permission.resolved', 30_000);
      expect(resolved.outcome).not.toBe('denied');

      rec.client.emit('input', '\x03');
      await sleep(300);
      rec.client.emit('input', '\x03');
    }, TIMEOUT_MS);
  }
});
