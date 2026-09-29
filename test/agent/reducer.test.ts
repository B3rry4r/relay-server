// Reducer rules (agent-display-spec §3, §12.1) over the REAL-CLI fixtures:
// approve, deny, interrupt, Claude's double turn.end, Gemini upsert re-emits and
// the post-cancel restore burst (0 events), opencode request/reply pairing.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeLine } from '../../src/relay-server/agent/adapters/claude';
import { codexLine } from '../../src/relay-server/agent/adapters/codex';
import { geminiLineKind, geminiMessageKeyed } from '../../src/relay-server/agent/adapters/gemini';
import { opencodeUserText, spoolRecord, spoolSessionId } from '../../src/relay-server/agent/adapters/spool';
import { TerminalTimeline, sameInput, truncateInput } from '../../src/relay-server/agent/reducer';
import type { AgentCli, AgentEvent } from '../../src/relay-server/agent/types';

const FX = path.resolve(__dirname, '../fixtures/agent');
const lines = (rel: string) => fs.readFileSync(path.join(FX, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const kinds = (evs: AgentEvent[]) => evs.map((e) => e.kind);

type Src = { kind: 'transcript' | 'spool'; at: number; o: any; offset: number };

/** Merge a transcript and a hook spool by timestamp, the way they arrive live. */
function merged(transcript: string, spool: string): Src[] {
  const t = lines(transcript).map((o, i) => ({ kind: 'transcript' as const, at: Date.parse(o.timestamp ?? '') || 0, o, offset: i }));
  const s = lines(spool).map((o, i) => ({ kind: 'spool' as const, at: Date.parse(o.at ?? '') || 0, o, offset: i }));
  return [...t, ...s].sort((a, b) => a.at - b.at || (a.kind === 'transcript' ? -1 : 1));
}

/** Feed like the tracker does (transcript-bound claude/codex sessions drop the hook turn.end). */
function feed(tl: TerminalTimeline, cli: AgentCli, sid: string, srcs: Src[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const src of srcs) {
    if (src.kind === 'transcript') {
      const raws = cli === 'claude' ? claudeLine(src.o) : codexLine(src.o);
      out.push(...tl.ingest(raws, { idBase: `${sid}:transcript:${src.offset}`, source: 'transcript', cli, sessionId: sid }));
    } else {
      const raws = spoolRecord(src.o).filter((r) => r.kind !== 'turn.end');
      out.push(...tl.ingest(raws, { idBase: `t1:spool:1:${src.offset}`, source: 'hook', cli, sessionId: spoolSessionId(src.o) ?? sid, attribution: 'hook' }));
    }
  }
  return out;
}

describe('TerminalTimeline reducer', () => {
  it('claude transcript: turn states, choices → awaiting-input, synthetic-free deny, consecutive turn.end collapsed', () => {
    const tl = new TerminalTimeline('t1');
    const sid = '17db8f8c';
    const states: string[] = [];
    const evs: AgentEvent[] = [];
    lines('claude/claude-2.1.284.session.REAL-CLI-MOCK-MODEL.jsonl').forEach((o, i) => {
      evs.push(...tl.ingest(claudeLine(o), { idBase: `${sid}:transcript:${i}`, source: 'transcript', cli: 'claude', sessionId: sid }));
      if (tl.current && states[states.length - 1] !== tl.current.state) states.push(tl.current.state);
    });
    expect(kinds(evs)).toEqual([
      'session.start', 'user.message', 'assistant.thinking', 'assistant.text', 'tool.call', 'tool.result', 'assistant.text', 'turn.end',
      'user.message', 'assistant.thinking', 'assistant.text', 'tool.call', 'tool.result', 'turn.end',
    ]);
    const summaryText = evs[6] as Extract<AgentEvent, { kind: 'assistant.text' }>;
    expect(summaryText.blocks.map((b) => b.kind)).toEqual(['summary', 'choices']);
    expect(summaryText.text).not.toContain('relay-summary');
    const denied = evs[12] as Extract<AgentEvent, { kind: 'tool.result' }>;
    expect(denied).toMatchObject({ ok: false, denied: true });
    expect(evs.filter((e) => e.kind === 'turn.end').map((e: any) => e.reason)).toEqual(['done', 'interrupted']);
    // (session.start and the first prompt arrive in one transcript line: 'starting' is transient)
    expect(states).toEqual(['working', 'awaiting-input', 'working', 'idle']);
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
  });

  it('claude hooks + transcript: approve pairs the request with its tool.call and resolves only on evidence; deny resolves denied', () => {
    const tl = new TerminalTimeline('t1');
    const sid = '17db8f8c-edf5-4a5b-8c57-3c2bdaf58c0c';
    const realSid = lines('claude/claude-2.1.284.session.REAL-CLI-MOCK-MODEL.jsonl')[0].sessionId as string;
    const evs = feed(tl, 'claude', realSid ?? sid, merged('claude/claude-2.1.284.session.REAL-CLI-MOCK-MODEL.jsonl', 'claude/claude-2.1.284.hooks-spool.REAL-CLI-MOCK-MODEL.jsonl'));
    const reqs = evs.filter((e) => e.kind === 'permission.request') as Array<Extract<AgentEvent, { kind: 'permission.request' }>>;
    const res = evs.filter((e) => e.kind === 'permission.resolved') as Array<Extract<AgentEvent, { kind: 'permission.resolved' }>>;
    expect(reqs).toHaveLength(2);
    const calls = evs.filter((e) => e.kind === 'tool.call') as Array<Extract<AgentEvent, { kind: 'tool.call' }>>;
    expect(reqs[0].toolUseId).toBe(calls[0].toolUseId);
    expect(reqs[1].toolUseId).toBe(calls[1].toolUseId);
    expect(reqs[0]).toMatchObject({ title: 'touch relay-demo.txt', detail: 'Create a demo file', answerable: true });
    expect(reqs[0].options.map((o) => o.id)).toEqual(['allow_once', 'allow_always', 'deny']);
    expect(res.map((r) => [r.requestId === reqs[res.indexOf(r)].requestId, r.outcome, r.by])).toEqual([[true, 'allowed', 'terminal'], [true, 'denied', 'terminal']]);
    // every resolution comes AFTER its request
    for (let i = 0; i < 2; i += 1) expect(res[i].seq).toBeGreaterThan(reqs[i].seq);
    expect(tl.current?.pending).toBeNull();
  });

  it('codex rollout + hooks: approve → allowed, deny (Esc) → denied + turn.end[interrupted]', () => {
    const tl = new TerminalTimeline('t1');
    const sid = lines('codex/codex-0.159.0.rollout-approve-then-deny-embedded.REAL-CLI-MOCK-MODEL.jsonl')[0].payload.id as string;
    const evs = feed(tl, 'codex', sid, merged('codex/codex-0.159.0.rollout-approve-then-deny-embedded.REAL-CLI-MOCK-MODEL.jsonl', 'codex/codex-0.159.0.hooks+notify-spool.REAL-CLI-MOCK-MODEL.jsonl'));
    const res = evs.filter((e) => e.kind === 'permission.resolved') as any[];
    expect(evs.filter((e) => e.kind === 'permission.request')).toHaveLength(2);
    expect(res.map((r) => r.outcome)).toEqual(['allowed', 'denied']);
    const results = evs.filter((e) => e.kind === 'tool.result') as any[];
    expect(results.map((r) => [r.ok, Boolean(r.denied)])).toEqual([[true, false], [false, true]]);
    expect(evs.filter((e) => e.kind === 'turn.end').map((e: any) => e.reason)).toEqual(['done', 'interrupted']);
    expect(kinds(evs).filter((k) => k === 'session.start')).toHaveLength(1);
    // the codex `notify` records of auxiliary threads (other thread ids) create no sessions
    expect([...tl.sessions.keys()]).toEqual([sid]);
    expect(kinds(evs).slice(-1)).toEqual(['session.end']);
    expect(tl.current?.state).toBe('ended');
  });

  it('interrupt with an open tool.call synthesizes tool.result{denied}', () => {
    const tl = new TerminalTimeline('t1');
    const at = '2026-09-29T12:00:00.000Z';
    const evs = tl.ingest([
      { kind: 'tool.call', at, toolUseId: 'c1', tool: 'Bash', toolKind: 'shell', title: 'x', input: { command: 'sleep 9' } },
      { kind: 'turn.end', at, reason: 'interrupted' },
      { kind: 'turn.end', at, reason: 'done' },
    ], { idBase: 's:transcript:0', source: 'transcript', cli: 'claude', sessionId: 's' });
    expect(kinds(evs)).toEqual(['session.start', 'tool.call', 'tool.result', 'turn.end']);
    expect(evs[2]).toMatchObject({ toolUseId: 'c1', ok: false, denied: true, source: 'tracker' });
  });

  it('gemini: upsert re-emits add only the new parts; the post-cancel restore burst adds 0 events', () => {
    const tl = new TerminalTimeline('t1');
    const all = lines('gemini/gemini-0.61.0.chat-session.REAL-CLI-MOCK-MODEL.jsonl');
    const sid = all[0].sessionId as string;
    const counts: number[] = [];
    const evs: AgentEvent[] = [];
    all.forEach((o) => {
      if (geminiLineKind(o) === 'record') {
        const keyed = geminiMessageKeyed(o);
        evs.push(...tl.ingest(keyed, { idBase: `${sid}:transcript:${o.id}`, source: 'transcript', cli: 'gemini', sessionId: sid, partKeys: keyed.map((k) => k.partKey) }));
      }
      counts.push(evs.length);
    });
    // line 4 = first sight of 4d4ce499 (text), line 6 = the SAME id re-emitted with its tool call
    expect(counts[6] - counts[5]).toBe(2); // tool.call + tool.result, not the text again
    expect(evs.filter((e) => e.kind === 'assistant.text' && e.id.includes('4d4ce499'))).toHaveLength(1);
    // lines 18-26: restore burst (new ids, Part[] content, $set.messages)
    expect(counts[26]).toBe(counts[17]);
    expect(kinds(evs).filter((k) => k === 'user.message')).toHaveLength(2);
    expect(evs.filter((e) => e.kind === 'tool.result').map((e: any) => e.denied ?? false)).toEqual([false, true]);
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'turn.end', reason: 'interrupted' });
  });

  it('gemini Notification(ToolPermission) pairs with the tool call by command, AfterTool resolves it', () => {
    const tl = new TerminalTimeline('t1');
    const evs: AgentEvent[] = [];
    const spool = lines('gemini/gemini-0.61.0.hooks-spool.REAL-CLI-MOCK-MODEL.jsonl');
    const sid = spoolSessionId(spool[0]) as string;
    evs.push(...tl.ingest([{ kind: 'tool.call', at: spool[0].at, toolUseId: 'g1', tool: 'run_shell_command', toolKind: 'shell', title: 't', input: { command: 'touch relay-demo.txt', description: 'Create a demo file' } }],
      { idBase: `${sid}:transcript:x`, source: 'transcript', cli: 'gemini', sessionId: sid }));
    spool.forEach((r, i) => evs.push(...tl.ingest(spoolRecord(r), { idBase: `t1:spool:1:${i}`, source: 'hook', cli: 'gemini', sessionId: spoolSessionId(r) ?? sid, attribution: 'hook' })));
    const req = evs.find((e) => e.kind === 'permission.request') as any;
    expect(req).toMatchObject({ toolUseId: 'g1', title: 'touch relay-demo.txt' });
    const res = evs.filter((e) => e.kind === 'permission.resolved') as any[];
    expect(res[0]).toMatchObject({ requestId: req.requestId, outcome: 'allowed' });
    // Gemini fires SessionEnd 3×: one session.end
    expect(kinds(evs).filter((k) => k === 'session.end')).toHaveLength(1);
    expect(tl.current?.state).toBe('ended');
  });

  it('opencode plugin spool: user text, one tool.call per callID, request/reply by id, reject → denied', () => {
    const tl = new TerminalTimeline('t1');
    const evs: AgentEvent[] = [];
    lines('opencode/opencode-1.18.33.plugin-events-spool.REAL-CLI-MOCK-MODEL.jsonl').forEach((r, i) => {
      const sid = spoolSessionId(r);
      if (!sid) return;
      const raws = spoolRecord(r);
      const keys = raws.map((_, n) => String(n));
      const ut = opencodeUserText(r, tl.session(sid)?.userMessageIds ?? new Set());
      if (ut) { raws.push({ kind: 'user.message', at: r.at, sessionId: sid, text: ut.text }); keys.push(`user:${ut.partId}`); }
      evs.push(...tl.ingest(raws, { idBase: `t1:spool:1:${i}`, source: 'hook', cli: 'opencode', sessionId: sid, attribution: 'hook', partKeys: keys }));
    });
    expect(evs.filter((e) => e.kind === 'user.message').map((e: any) => e.text)).toEqual(['create the demo file', 'do it again']);
    expect(evs.filter((e) => e.kind === 'tool.call')).toHaveLength(2);
    const reqs = evs.filter((e) => e.kind === 'permission.request') as any[];
    expect(reqs.map((r) => r.requestId.startsWith('per_'))).toEqual([true, true]);
    expect(reqs.every((r) => typeof r.toolUseId === 'string' && r.toolUseId.startsWith('call_'))).toBe(true);
    expect((evs.filter((e) => e.kind === 'permission.resolved') as any[]).map((r) => r.outcome)).toEqual(['allowed', 'denied']);
    const results = evs.filter((e) => e.kind === 'tool.result') as any[];
    expect(results.map((r) => [r.ok, Boolean(r.denied)])).toEqual([[true, false], [false, true]]);
    expect(evs.filter((e) => e.kind === 'assistant.text').some((e: any) => e.blocks.some((b: any) => b.kind === 'summary'))).toBe(true);
  });

  it('a detached session is never answerable; attribution changes update the pending card', () => {
    const tl = new TerminalTimeline('t1');
    tl.ingest([{ kind: 'permission.request', tool: 'Bash', input: { command: 'rm x' } }], { idBase: 'h:0', source: 'hook', cli: 'codex', sessionId: 's', attribution: 'detached' });
    expect(tl.current?.pending?.event.answerable).toBe(false);
    tl.setAttribution('s', 'hook');
    expect(tl.current?.pending?.event.answerable).toBe(true);
    expect(tl.summary()?.pending?.answerable).toBe(true);
  });

  it('ring keeps 500 events; since()/before()/tail() serve deltas and history; replayed ids are deduped', () => {
    const tl = new TerminalTimeline('t1');
    for (let i = 0; i < 620; i += 1) tl.ingest([{ kind: 'assistant.thinking', text: `t${i}` }], { idBase: `s:transcript:${i}`, source: 'transcript', cli: 'claude', sessionId: 's' });
    const evs = tl.events();
    expect(evs).toHaveLength(500);
    expect(tl.lastSeq).toBe(621);
    expect(tl.since(600)?.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => 601 + i));
    expect(tl.since(10)).toBeNull(); // fell out of the ring → client needs a snapshot
    expect(tl.before(200, 5).map((e) => e.seq)).toEqual([195, 196, 197, 198, 199]);
    expect(tl.tail(200)).toMatchObject({ hasMore: true });
    // the same source record again (tailer restart) emits nothing
    expect(tl.ingest([{ kind: 'assistant.thinking', text: 't619' }], { idBase: 's:transcript:619', source: 'transcript', cli: 'claude', sessionId: 's' })).toEqual([]);
  });

  it('truncates tool input to 4 KB and output to 2 KB', () => {
    const big = { command: 'x'.repeat(10_000), description: 'd' };
    expect(Buffer.byteLength(JSON.stringify(truncateInput(big)))).toBeLessThanOrEqual(4096);
    const tl = new TerminalTimeline('t1');
    const evs = tl.ingest([
      { kind: 'tool.call', toolUseId: 'a', tool: 'Bash', input: big },
      { kind: 'tool.result', toolUseId: 'a', ok: true, summary: 's', output: 'y'.repeat(9000) },
    ], { idBase: 'x', source: 'transcript', cli: 'claude', sessionId: 's' });
    expect(Buffer.byteLength((evs[2] as any).output)).toBeLessThanOrEqual(2048);
    expect(sameInput({ command: 'a' }, { cmd: 'a', justification: 'j' })).toBe(true);
    expect(sameInput({ command: 'a' }, { command: 'b' })).toBe(false);
  });
});
