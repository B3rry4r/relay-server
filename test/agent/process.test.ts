// Correlation (agent-display-spec §5.3, §12.1): an injected fake /proc tree for
// the lineage rules (descendant, detached, tmux, codex daemon, Claude's `sh -c`
// wrapper), CLI detection, and the ambiguous-match rule of fallback discovery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentPidFromRecord, attributeRecord, detectCli, parseStat, ProcessInspector, type ProcFs } from '../../src/relay-server/agent/process';
import { AgentTracker } from '../../src/relay-server/agent/tracker';

type FakeProc = { pid: number; ppid: number; argv: string[]; cwd?: string; env?: Record<string, string>; startTicks?: number };

function fakeProcFs(procs: FakeProc[], btime = 1_790_000_000): ProcFs {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return {
    listPids: () => [...byPid.keys()],
    readStat: (pid) => {
      const p = byPid.get(pid);
      if (!p) return null;
      const fields = ['S', String(p.ppid), ...Array(17).fill('0'), String(p.startTicks ?? 0)];
      return `${pid} (${path.basename(p.argv[0] ?? '?')} x) ${fields.join(' ')}`;
    },
    readCmdline: (pid) => { const p = byPid.get(pid); return p ? `${p.argv.join('\0')}\0` : null; },
    readEnviron: (pid) => { const p = byPid.get(pid); return p ? Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\0') : null; },
    readCwd: (pid) => byPid.get(pid)?.cwd ?? null,
    readFd0: () => null,
    bootTime: () => btime,
  };
}

describe('ProcessInspector + lineage attribution', () => {
  const tree: FakeProc[] = [
    { pid: 1, ppid: 0, argv: ['/sbin/init'] },
    { pid: 50, ppid: 1, argv: ['node', 'dist/src/index.js'] }, // relay-server
    { pid: 100, ppid: 50, argv: ['/bin/bash'], env: { RELAY_TERMINAL_ID: 't1' } }, // terminal t1 shell
    { pid: 110, ppid: 100, argv: ['claude', '--permission-mode', 'default'], cwd: '/proj' },
    { pid: 200, ppid: 50, argv: ['/bin/bash'], env: { RELAY_TERMINAL_ID: 't2' } }, // terminal t2 shell
    { pid: 300, ppid: 1, argv: ['/usr/bin/codex', 'app-server', '--listen', 'unix://', '--managed-daemon'] }, // shared codex daemon
    { pid: 400, ppid: 1, argv: ['tmux', 'new-session'] }, // tmux server (left the tree)
    { pid: 410, ppid: 400, argv: ['bash'] },
    { pid: 420, ppid: 410, argv: ['node', '--max-old-space-size=4096', '/x/node_modules/@google/gemini-cli/dist/index.js'] },
  ];
  const insp = new ProcessInspector({ procfs: fakeProcFs(tree) });

  it('walks descendants and parses stat with spaces/parens in comm', () => {
    expect([...insp.descendants(100)].sort()).toEqual([100, 110]);
    expect(parseStat('42 (my (odd) name) S 7 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1234 rest')).toEqual({ ppid: 7, startTicks: 1234 });
  });

  it('a Claude hook via a vanished `sh -c` wrapper is attributed to the terminal by its lineage', () => {
    const rec = { pid: 9001, ppid: 9000, lineage: [{ pid: 9000, cmd: '/bin/sh -c /w/.relay/bin/relay-agent-hook claude' }, { pid: 110, cmd: 'claude --permission-mode default' }, { pid: 100, cmd: 'bash' }] };
    expect(attributeRecord(insp, 100, rec)).toBe('hook');
    expect(agentPidFromRecord({ ...rec, cli: 'claude' })).toBe(110);
    // …but it is NOT terminal t2's
    expect(attributeRecord(insp, 200, rec)).toBe('detached');
  });

  it('the shared Codex daemon and tmux sessions are detached (alive, outside the tree)', () => {
    expect(attributeRecord(insp, 200, { pid: 9100, ppid: 300, lineage: [{ pid: 300, cmd: 'codex app-server' }] })).toBe('detached');
    expect(attributeRecord(insp, 100, { pid: 9200, ppid: 420, lineage: [{ pid: 420, cmd: 'node gemini' }, { pid: 410, cmd: 'bash' }, { pid: 400, cmd: 'tmux' }] })).toBe('detached');
  });

  it('a replayed record whose processes are all gone is "unknown" (not detached)', () => {
    expect(attributeRecord(insp, 100, { pid: 7777, ppid: 7776, lineage: [{ pid: 7776, cmd: 'sh -c' }, { pid: 7775, cmd: 'claude' }] })).toBe('unknown');
  });

  it('opencode plugin records are validated by the writer pid itself', () => {
    expect(attributeRecord(insp, 100, { pid: 110, ppid: 100 })).toBe('hook');
    expect(agentPidFromRecord({ pid: 110, ppid: 100, cli: 'opencode' })).toBe(110);
  });

  it('detects agent CLIs strictly (node wrappers by script, never by an argument)', () => {
    expect(detectCli(['claude'])).toBe('claude');
    expect(detectCli(['/usr/local/bin/codex', 'resume'])).toBe('codex');
    expect(detectCli(['node', '--max-old-space-size=4096', '/x/node_modules/@google/gemini-cli/dist/index.js'])).toBe('gemini');
    expect(detectCli(['node', '/w/.relay/tools/npm-global/bin/opencode'])).toBe('opencode');
    expect(detectCli(['grep', 'codex'])).toBeNull();
    expect(detectCli(['vim', 'gemini.md'])).toBeNull();
    expect(detectCli(['less', 'claude.log'])).toBeNull();
    expect(detectCli(['node', 'server.js', 'claude'])).toBeNull();
  });

  it('finds CLIs under a terminal and knows whether /proc is shared with it', () => {
    expect(insp.findClis(100).map((c) => [c.pid, c.cli])).toEqual([[110, 'claude']]);
    expect(insp.findClis(400).map((c) => c.cli)).toEqual(['gemini']);
    expect(insp.sharesNamespaceWith('t1', 100)).toBe(true);
    expect(insp.sharesNamespaceWith('t2', 100)).toBe(false);
  });
});

describe('fallback discovery (no hooks)', () => {
  const dirs: string[] = [];
  const trackers: AgentTracker[] = [];
  afterEach(() => {
    for (const t of trackers.splice(0)) t.stop();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(terminals: Array<{ id: string; pid: number }>, procs: FakeProc[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-disc-'));
    dirs.push(home);
    const projDir = path.join(home, '.claude', 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const tracker = new AgentTracker({
      workspace: home, home, spoolDir: path.join(home, 'spool'), mode: 'embedded',
      listTerminals: () => terminals.map((t) => ({ ...t, cwd: '/proj' })),
      inspector: new ProcessInspector({ procfs: fakeProcFs(procs, nowSec - 100), ttlMs: 0 }),
      hookGraceMs: 0, probeSizes: false, tickMs: 3_600_000, log: () => undefined,
    });
    trackers.push(tracker);
    const writeTranscript = (sid: string, prompt: string) => fs.writeFileSync(path.join(projDir, `${sid}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, cwd: '/proj', sessionId: sid, timestamp: new Date().toISOString() })}\n`);
    return { tracker, writeTranscript };
  }

  const claudeIn = (shell: number, pid: number): FakeProc[] => [
    { pid: shell, ppid: 1, argv: ['bash'] },
    { pid, ppid: shell, argv: ['claude'], cwd: '/proj', startTicks: 9000 }, // started 90 s after boot → 10 s ago
  ];

  it('binds a unique match by process: attribution "process", transcript events flow, hooks-missing notice', async () => {
    const { tracker, writeTranscript } = setup([{ id: 't1', pid: 100 }], claudeIn(100, 110));
    writeTranscript('sess-one', 'fix the build');
    await tracker.start();
    await tracker.tick();
    await new Promise((r) => setTimeout(r, 50));
    const [s] = tracker.sessions();
    expect(s).toMatchObject({ terminalId: 't1', cli: 'claude', sessionId: 'sess-one', attribution: 'process', title: 'fix the build' });
    const snap = tracker.snapshot('t1');
    expect(snap.events.map((e) => e.kind)).toEqual(['session.start', 'notice', 'user.message']);
    expect(snap.events[1]).toMatchObject({ code: 'hooks-missing' });
  });

  it('two terminals running the same CLI in the same cwd are ambiguous: notice with candidates, no keys, the picker binds', async () => {
    const { tracker, writeTranscript } = setup([{ id: 't1', pid: 100 }, { id: 't2', pid: 200 }], [...claudeIn(100, 110), ...claudeIn(200, 210)]);
    writeTranscript('sess-a', 'first');
    writeTranscript('sess-b', 'second');
    await tracker.start();
    await tracker.tick();
    const sessions = tracker.sessions();
    expect(sessions.map((s) => [s.terminalId, s.attribution]).sort()).toEqual([['t1', 'ambiguous'], ['t2', 'ambiguous']]);
    const notice = tracker.snapshot('t1').events.find((e) => e.kind === 'notice' && e.code === 'ambiguous-session') as any;
    expect(notice.candidates.map((c: any) => c.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
    // no transcript is bound while ambiguous
    expect(tracker.snapshot('t1').events.some((e) => e.kind === 'user.message')).toBe(false);
    expect(await tracker.respond('t1', 'nope', 'allow_once')).toEqual({ ok: false, reason: 'stale' });
    // the user picks
    expect(tracker.bind('t1', 'sess-b')).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    const t1 = tracker.sessions().find((s) => s.terminalId === 't1');
    expect(t1).toMatchObject({ sessionId: 'sess-b', attribution: 'process' });
    expect(tracker.snapshot('t1').events.filter((e) => e.kind === 'user.message').map((e: any) => e.text)).toEqual(['second']);
  });
});
