// AgentTracker behaviours without a real PTY (agent-display-spec §5.3, §6.3, §6.4, §8):
// deterministic ids across a restart (new epoch, same ids), spool rotation,
// screen-only detection for hook-less sessions with the multi-key "Always"
// sequence (DECCKM-aware, retry-once), and detached sessions never answerable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessInspector, type ProcFs } from '../../src/relay-server/agent/process';
import { ptyHub, setEmbeddedPtyAccess } from '../../src/relay-server/agent/pty-hub';
import { SpoolWatcher } from '../../src/relay-server/agent/spool';
import { AgentTracker } from '../../src/relay-server/agent/tracker';
import type { AgentEvent } from '../../src/relay-server/agent/types';

const FX = path.resolve(__dirname, '../fixtures/agent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FakeProc = { pid: number; ppid: number; argv: string[]; cwd?: string };
function fakeProcFs(procs: FakeProc[]): ProcFs {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return {
    listPids: () => [...byPid.keys()],
    readStat: (pid) => { const p = byPid.get(pid); return p ? `${pid} (x) S ${p.ppid} ${Array(17).fill('0').join(' ')} 0` : null; },
    readCmdline: (pid) => { const p = byPid.get(pid); return p ? `${p.argv.join('\0')}\0` : null; },
    readEnviron: () => null,
    readCwd: (pid) => byPid.get(pid)?.cwd ?? null,
    readFd0: () => null,
    bootTime: () => Math.floor(Date.now() / 1000) - 60,
  };
}

const dirs: string[] = [];
const trackers: AgentTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  setEmbeddedPtyAccess(null);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tracker-')); dirs.push(d); return d; };

async function until<T>(fn: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(25);
  }
}

describe('AgentTracker', () => {
  it('rebuilds the same timeline with the SAME ids after a restart (new epoch)', async () => {
    const ws = tmp();
    const spoolDir = path.join(ws, '.relay/state/agent-events');
    fs.mkdirSync(spoolDir, { recursive: true });
    // the fake agent's real-format transcript + hook spool, re-homed into this workspace
    const sid = '512b5692-ceb6-4e15-b4b7-6f8e7d0f0c11';
    const transcriptSrc = fs.readFileSync(path.join(FX, 'claude/fake-agent.session.SYNTHESIZED.jsonl'), 'utf8');
    const realSid = JSON.parse(transcriptSrc.split('\n')[0]).sessionId as string;
    const transcript = path.join(ws, '.claude/projects/-w', `${realSid}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, transcriptSrc);
    const spool = fs.readFileSync(path.join(FX, 'claude/fake-agent.hooks-spool.SYNTHESIZED.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { const r = JSON.parse(l); r.terminalId = 't1'; r.payload.transcript_path = transcript; return JSON.stringify(r); });
    fs.writeFileSync(path.join(spoolDir, 't1.jsonl'), `${spool.join('\n')}\n`);
    expect(sid).toBeTruthy();

    const make = () => {
      const t = new AgentTracker({ workspace: ws, spoolDir, mode: 'embedded', listTerminals: () => [{ id: 't1', pid: 999_999, cwd: ws }], inspector: new ProcessInspector({ procfs: fakeProcFs([]) }), probeSizes: false, tickMs: 3_600_000, log: () => undefined });
      trackers.push(t);
      return t;
    };
    const a = make();
    await a.start();
    const snapA = await until(() => { const s = a.snapshot('t1'); return s.events.some((e) => e.kind === 'session.end') && s; }, 'first timeline');
    a.stop();
    const b = make();
    await b.start();
    const snapB = await until(() => { const s = b.snapshot('t1'); return s.events.length === snapA.events.length && s; }, 'rebuilt timeline');
    expect(b.epoch).not.toBe(a.epoch);
    expect(snapB.events.map((e) => e.id)).toEqual(snapA.events.map((e) => e.id));
    expect(snapA.events.map((e) => e.kind)).toEqual([
      'session.start', 'status', 'user.message', 'assistant.thinking', 'assistant.text', 'tool.call', 'permission.request',
      'tool.result', 'permission.resolved', 'assistant.text', 'turn.end', 'session.end',
    ]);
    // replayed records whose processes are gone keep attribution 'hook' (not a false 'detached')
    expect(snapA.session).toMatchObject({ attribution: 'hook', state: 'ended', title: 'create the demo file' });
  });

  it('after a restart, a request the user denied in the terminal (Esc: no PostToolUse, no Stop) is NOT left pending', async () => {
    const ws = tmp();
    const spoolDir = path.join(ws, 'spool');
    fs.mkdirSync(spoolDir, { recursive: true });
    const transcriptSrc = fs.readFileSync(path.join(FX, 'claude/claude-2.1.284.session.REAL-CLI-MOCK-MODEL.jsonl'), 'utf8');
    const realSid = JSON.parse(transcriptSrc.split('\n')[0]).sessionId as string;
    const transcript = path.join(ws, '.claude/projects/-p', `${realSid}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, transcriptSrc);
    const spool = fs.readFileSync(path.join(FX, 'claude/claude-2.1.284.hooks-spool.REAL-CLI-MOCK-MODEL.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { const r = JSON.parse(l); r.terminalId = 't1'; if (r.payload.transcript_path) r.payload.transcript_path = transcript; return JSON.stringify(r); });
    fs.writeFileSync(path.join(spoolDir, 't1.jsonl'), `${spool.join('\n')}\n`);
    const tracker = new AgentTracker({ workspace: ws, spoolDir, mode: 'embedded', listTerminals: () => [{ id: 't1', pid: 999_999, cwd: ws }], inspector: new ProcessInspector({ procfs: fakeProcFs([]) }), probeSizes: false, tickMs: 3_600_000, log: () => undefined });
    trackers.push(tracker);
    await tracker.start();
    const snap = await until(() => { const s = tracker.snapshot('t1'); return s.events.some((e) => e.kind === 'session.end') && s; }, 'timeline');
    const kinds = snap.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'permission.request')).toHaveLength(2);
    expect((snap.events.filter((e) => e.kind === 'permission.resolved') as any[]).map((e) => e.outcome)).toEqual(['allowed', 'denied']);
    // every request precedes its resolution and its tool.result
    const idx = (pred: (e: AgentEvent) => boolean) => snap.events.findIndex(pred);
    expect(idx((e) => e.kind === 'permission.request')).toBeLessThan(idx((e) => e.kind === 'tool.result'));
    expect(snap.session?.pending).toBeUndefined();
    expect(snap.session?.state).toBe('ended');
  });

  it('sweeps spools of terminals that closed while the server was down (old + absent from a fresh list only)', async () => {
    const ws = tmp();
    const spoolDir = path.join(ws, 'spool');
    fs.mkdirSync(spoolDir, { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const name of ['gone.jsonl', 'gone.jsonl.1', 't1.jsonl', 'fresh.jsonl']) fs.writeFileSync(path.join(spoolDir, name), '');
    for (const name of ['gone.jsonl', 'gone.jsonl.1', 't1.jsonl']) fs.utimesSync(path.join(spoolDir, name), old, old);
    const tracker = new AgentTracker({ workspace: ws, spoolDir, mode: 'embedded', listTerminals: () => [{ id: 't1', pid: 999_999, cwd: ws }], inspector: new ProcessInspector({ procfs: fakeProcFs([]) }), probeSizes: false, tickMs: 3_600_000, log: () => undefined });
    trackers.push(tracker);
    await tracker.start();
    await tracker.tick();
    expect(fs.readdirSync(spoolDir).sort()).toEqual(['fresh.jsonl', 't1.jsonl']);
  });

  it('rotates a consumed spool past the size limit, keeps reading, and deletes both files on close', async () => {
    const dir = tmp();
    const seen: string[] = [];
    const w = new SpoolWatcher(dir, (l) => seen.push(`${l.idBase}|${(l.record.payload as any).n}`), { rotateBytes: 300, pollMs: 3_600_000 });
    w.start();
    const file = path.join(dir, 't9.jsonl');
    const rec = (n: number) => `${JSON.stringify({ v: 1, cli: 'claude', terminalId: 't9', payload: { n, pad: 'x'.repeat(60) } })}\n`;
    for (let i = 0; i < 4; i += 1) fs.appendFileSync(file, rec(i));
    w.scan(); // reads 4 records (> 300 bytes, fully consumed) → rotates
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    fs.appendFileSync(file, rec(4));
    w.scan();
    w.scan();
    expect(seen.map((s) => s.split('|')[1])).toEqual(['0', '1', '2', '3', '4']);
    expect(new Set(seen.map((s) => s.split('|')[0])).size).toBe(5); // inode in the id base keeps ids unique across rotation
    w.remove('t9');
    expect(fs.existsSync(file) || fs.existsSync(`${file}.1`)).toBe(false);
    w.stop();
  });

  it('hook-less CLI: screen-detected prompt, "Always" as a DECCKM-aware multi-key sequence with one guarded retry, resolved when the prompt goes', async () => {
    const ws = tmp();
    const writes: string[] = [];
    setEmbeddedPtyAccess({ write: (id, data) => { if (id === 't1') writes.push(data); return id === 't1'; }, scrollback: () => '' });
    const tracker = new AgentTracker({
      workspace: ws, spoolDir: path.join(ws, 'spool'), mode: 'embedded',
      listTerminals: () => [{ id: 't1', pid: 100, cwd: '/proj' }],
      inspector: new ProcessInspector({ procfs: fakeProcFs([{ pid: 100, ppid: 1, argv: ['bash'] }, { pid: 110, ppid: 100, argv: ['opencode'], cwd: '/proj' }]), ttlMs: 0 }),
      hookGraceMs: 0, probeSizes: false, tickMs: 3_600_000, keyGapMs: 20, keyRetryMs: 150, log: () => undefined,
    });
    trackers.push(tracker);
    const live: AgentEvent[] = [];
    tracker.on('event', (_id: string, ev: AgentEvent) => live.push(ev));
    await tracker.start();
    await tracker.tick();
    expect(tracker.sessions()[0]).toMatchObject({ cli: 'opencode', attribution: 'process', state: 'starting' });
    expect(live.find((e) => e.kind === 'notice')).toMatchObject({ code: 'hooks-missing' });
    expect(await tracker.respond('t1', 'x', 'allow_once')).toEqual({ ok: false, reason: 'stale' });

    const prompt = fs.readFileSync(path.join(FX, 'opencode/opencode-1.18.33.screen-permission-prompt.txt'), 'utf8');
    ptyHub.output('t1', `\x1b[?1h\x1b[2J\x1b[H${prompt.replace(/\n/g, '\r\n')}`);
    const req = await until(() => live.find((e) => e.kind === 'permission.request') as any, 'screen permission.request');
    expect(req).toMatchObject({ source: 'screen', title: 'touch relay-demo.txt', answerable: true });
    expect(req.options[1]).toMatchObject({ id: 'allow_always', confirm: true });

    expect(await tracker.respond('t1', req.requestId, 'allow_always')).toEqual({ ok: true });
    expect(writes).toEqual(['\x1bOC', '\r', '\r']);
    // the prompt is still identical 150 ms later → the final key is retried ONCE
    await until(() => writes.length === 4, 'retry');
    expect(writes[3]).toBe('\r');
    await sleep(300);
    expect(writes).toHaveLength(4);
    // the prompt disappears → resolved (by relay: we wrote the keys), no optimistic resolution before
    expect(live.some((e) => e.kind === 'permission.resolved')).toBe(false);
    ptyHub.output('t1', '\x1b[2J\x1b[H  Created the file.\r\n');
    const resolved = await until(() => live.find((e) => e.kind === 'permission.resolved') as any, 'resolved');
    expect(resolved).toMatchObject({ requestId: req.requestId, outcome: 'unknown', by: 'relay' });
    expect(tracker.sessions()[0].state).toBe('working');
  });

  it('a hook record from outside the terminal tree (codex daemon) is detached: notice, never answerable', async () => {
    const ws = tmp();
    const spoolDir = path.join(ws, 'spool');
    fs.mkdirSync(spoolDir, { recursive: true });
    const writes: string[] = [];
    setEmbeddedPtyAccess({ write: (_id, data) => { writes.push(data); return true; }, scrollback: () => '' });
    const tracker = new AgentTracker({
      workspace: ws, spoolDir, mode: 'embedded', listTerminals: () => [{ id: 't2', pid: 200, cwd: '/proj' }],
      inspector: new ProcessInspector({ procfs: fakeProcFs([{ pid: 200, ppid: 1, argv: ['bash'] }, { pid: 300, ppid: 1, argv: ['codex', 'app-server', '--managed-daemon'] }]), ttlMs: 0 }),
      probeSizes: false, tickMs: 3_600_000, log: () => undefined,
    });
    trackers.push(tracker);
    await tracker.start();
    const rec = (payload: object) => `${JSON.stringify({ v: 1, cli: 'codex', terminalId: 't2', pid: 9100, ppid: 300, lineage: [{ pid: 300, cmd: 'codex app-server' }], at: new Date().toISOString(), payload })}\n`;
    fs.appendFileSync(path.join(spoolDir, 't2.jsonl'), rec({ session_id: 'th1', hook_event_name: 'SessionStart', cwd: '/proj' }) + rec({ session_id: 'th1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }));
    const snap = await until(() => { const s = tracker.snapshot('t2'); return s.events.some((e) => e.kind === 'permission.request') && s; }, 'events');
    expect(snap.session).toMatchObject({ attribution: 'detached' });
    const notice = snap.events.find((e) => e.kind === 'notice') as any;
    expect(notice).toMatchObject({ code: 'detached-process' });
    expect(notice.message).toContain("pkill -f 'codex app-server'");
    const req = snap.events.find((e) => e.kind === 'permission.request') as any;
    expect(req.answerable).toBe(false);
    expect(await tracker.respond('t2', req.requestId, 'allow_once')).toEqual({ ok: false, reason: 'not-answerable' });
    expect(writes).toEqual([]);
  });
});
