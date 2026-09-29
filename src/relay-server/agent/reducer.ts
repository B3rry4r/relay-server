/*
 * Per-terminal timeline reducer (agent-display-spec §3 reducer rules, §6.3, §6.4).
 *
 * Pure (no I/O): the tracker feeds it RawAgentEvents from the adapters, tagged
 * with a deterministic id base; it assigns seq, dedupes, keeps the session state
 * machine and the pending permission, and returns the typed events to emit.
 *
 * Rules:
 *  - state: session.start → starting; prompt/busy → working; permission.request →
 *    awaiting-permission; permission.resolved → working; turn.end → idle, or
 *    awaiting-input when the turn's last assistant.text holds a choices block;
 *    session.end → ended.
 *  - consecutive turn.end events collapse (Claude writes turn_duration after an
 *    interrupted turn; Codex's Stop hook duplicates task_complete).
 *  - every tool.call left open at turn.end[interrupted] gets a synthetic
 *    tool.result{ok:false, denied:true}.
 *  - permission.request ↔ tool: Claude/Codex/Gemini give no id → the latest
 *    unresolved tool.call of the session with an equal input; opencode gives it.
 *  - permission.resolved is emitted ONLY from evidence (§8.3.4): PostToolUse /
 *    AfterTool / permission.replied, a transcript tool.result, Interrupt,
 *    turn_aborted, or the screen prompt disappearing (screen-sourced requests).
 */
import { parseDisplayBlocks } from './blocks';
import type { RawAgentEvent } from './adapters/common';
import { permissionOptions } from './keys';
import type {
  AgentCli, AgentEvent, AgentEventBody, AgentSessionSummary, AgentSource, AgentState, Attribution,
  PermissionRequestEvent, SessionCandidate,
} from './types';

export const RING_SIZE = 500;
export const MAX_OUTPUT_BYTES = 2048;
export const MAX_INPUT_BYTES = 4096;

export interface IngestMeta {
  /** Deterministic id base; the n-th event derived from this record gets `${idBase}:${n}` unless `partKey` is given. */
  idBase: string;
  source: AgentSource;
  cli: AgentCli;
  /** Session the record belongs to (falls back to raw.sessionId, then the current session). */
  sessionId?: string;
  attribution?: Attribution;
  cwd?: string;
  /** Stable per-event keys (gemini upserts): event i gets `${idBase}:${partKeys[i]}`. */
  partKeys?: string[];
}

interface PendingState {
  event: PermissionRequestEvent;
  input: unknown;
  answering: boolean;
  source: AgentSource;
}

export interface SessionState {
  cli: AgentCli;
  sessionId: string;
  cwd: string;
  title?: string;
  model?: string;
  transcriptPath?: string;
  state: AgentState;
  attribution: Attribution;
  pending: PendingState | null;
  startedAt: string;
  lastEventAt: string;
  endedAt?: number;
  /** toolUseId → {input, resolved} */
  toolCalls: Map<string, { input: unknown; resolved: boolean; order: number }>;
  toolResults: Set<string>;
  textParts: Set<string>;
  userMessageIds: Set<string>;
  lastWasTurnEnd: boolean;
  turnHasChoices: boolean;
  callOrder: number;
  firstUserText?: string;
  sessionStartEmitted: boolean;
  sessionEndEmitted: boolean;
  noticesEmitted: Set<string>;
  canInterrupt: boolean;
  /** The agent CLI process (from hook lineage or /proc discovery), for exit detection. */
  agentPid?: number;
  /** A transcript tailer is bound: hook-sourced turn.end is then redundant (claude/codex). */
  transcriptBound: boolean;
  /** Candidate transcripts when attribution is 'ambiguous'. */
  candidates?: SessionCandidate[];
}

export class TerminalTimeline {
  readonly terminalId: string;
  private ring: AgentEvent[] = [];
  private emittedIds = new Set<string>();
  private idOrder: string[] = [];
  private nextSeq = 1;
  readonly sessions = new Map<string, SessionState>();
  current: SessionState | null = null;
  limited = false;
  private ringSize: number;
  private now: () => number;

  constructor(terminalId: string, opts: { ringSize?: number; now?: () => number } = {}) {
    this.terminalId = terminalId;
    this.ringSize = opts.ringSize ?? RING_SIZE;
    this.now = opts.now ?? Date.now;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  events(): AgentEvent[] {
    return this.ring.slice();
  }

  /** Oldest seq still in the ring (0 when empty). */
  get firstSeq(): number {
    return this.ring[0]?.seq ?? 0;
  }

  session(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  summary(session: SessionState | null = this.current): AgentSessionSummary | null {
    if (!session) return null;
    return {
      terminalId: this.terminalId,
      cli: session.cli,
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(session.title || session.firstUserText ? { title: session.title || session.firstUserText } : {}),
      ...(session.model ? { model: session.model } : {}),
      state: session.state,
      attribution: session.attribution,
      ...(session.pending ? { pending: session.pending.event } : {}),
      startedAt: session.startedAt,
      lastEventAt: session.lastEventAt,
      canInterrupt: session.canInterrupt && session.state === 'working',
      ...(this.limited ? { limited: true } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // session management
  // ---------------------------------------------------------------------------

  /** Create (or return) a session; emits session.start once. */
  ensureSession(
    sessionId: string,
    cli: AgentCli,
    meta: { at?: string; cwd?: string; model?: string; transcriptPath?: string; origin?: string; attribution?: Attribution; source?: AgentSource; idBase?: string },
  ): { session: SessionState; emitted: AgentEvent[] } {
    const emitted: AgentEvent[] = [];
    let s = this.sessions.get(sessionId);
    const at = meta.at || new Date(this.now()).toISOString();
    if (!s) {
      // A new session replaces the current one in this terminal: close the old one.
      if (this.current && this.current.state !== 'ended' && this.current.sessionId !== sessionId) {
        emitted.push(...this.endSession(this.current, { at, reason: 'replaced', idBase: `${this.current.sessionId}:tracker:replaced` }));
      }
      s = {
        cli, sessionId, cwd: meta.cwd || '', state: 'starting', attribution: meta.attribution ?? 'hook', pending: null,
        startedAt: at, lastEventAt: at, toolCalls: new Map(), toolResults: new Set(), textParts: new Set(),
        userMessageIds: new Set(), lastWasTurnEnd: false, turnHasChoices: false, callOrder: 0,
        sessionStartEmitted: false, sessionEndEmitted: false, noticesEmitted: new Set(), canInterrupt: false, transcriptBound: false,
      };
      this.sessions.set(sessionId, s);
      this.current = s;
    }
    if (meta.cwd && !s.cwd) s.cwd = meta.cwd;
    if (meta.model) s.model = meta.model;
    if (meta.transcriptPath) s.transcriptPath = meta.transcriptPath;
    if (!s.sessionStartEmitted) {
      s.sessionStartEmitted = true;
      const origin = ['startup', 'resume', 'clear', 'compact', 'fork'].includes(String(meta.origin)) ? meta.origin as 'startup' : undefined;
      emitted.push(this.push(s, `${meta.idBase ?? `${sessionId}:tracker:start`}`, meta.source ?? 'tracker', at, {
        kind: 'session.start', cwd: s.cwd, ...(s.model ? { model: s.model } : {}),
        ...(s.transcriptPath ? { transcriptPath: s.transcriptPath } : {}), ...(origin ? { origin } : {}),
      }));
    }
    return { session: s, emitted };
  }

  setAttribution(sessionId: string, attribution: Attribution): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.attribution === attribution) return false;
    s.attribution = attribution;
    if (s.pending) s.pending.event = { ...s.pending.event, answerable: isAnswerable(attribution) };
    return true;
  }

  /** Rename a provisional session id (fallback discovery found the real transcript). */
  renameSession(from: string, to: string): boolean {
    const s = this.sessions.get(from);
    if (!s || this.sessions.has(to)) return false;
    this.sessions.delete(from);
    s.sessionId = to;
    this.sessions.set(to, s);
    return true;
  }

  endSession(s: SessionState, meta: { at?: string; reason?: string; idBase: string; source?: AgentSource }): AgentEvent[] {
    if (s.sessionEndEmitted) return [];
    const at = meta.at || new Date(this.now()).toISOString();
    const out: AgentEvent[] = [];
    if (s.pending) out.push(...this.resolvePending(s, 'unknown', `${meta.idBase}:resolve`, meta.source ?? 'tracker', at));
    s.sessionEndEmitted = true;
    s.state = 'ended';
    s.endedAt = this.now();
    s.canInterrupt = false;
    out.push(this.push(s, `${meta.idBase}`, meta.source ?? 'tracker', at, { kind: 'session.end', ...(meta.reason ? { reason: meta.reason } : {}) }));
    return out;
  }

  notice(s: SessionState, code: 'codex-hooks-untrusted' | 'hooks-missing' | 'detached-process' | 'ambiguous-session', message: string, key: string, candidates?: SessionCandidate[]): AgentEvent[] {
    const dedupe = `${code}:${key}`;
    if (s.noticesEmitted.has(dedupe)) return [];
    s.noticesEmitted.add(dedupe);
    return [this.push(s, `${s.sessionId}:tracker:notice:${dedupe}`, 'tracker', new Date(this.now()).toISOString(), {
      kind: 'notice', code, message, ...(candidates ? { candidates } : {}),
    })];
  }

  // ---------------------------------------------------------------------------
  // ingest
  // ---------------------------------------------------------------------------

  ingest(raws: RawAgentEvent[], meta: IngestMeta): AgentEvent[] {
    const out: AgentEvent[] = [];
    raws.forEach((raw, n) => {
      const key = meta.partKeys?.[n] ?? String(n);
      out.push(...this.ingestOne(raw, `${meta.idBase}:${key}`, meta));
    });
    return out;
  }

  private ingestOne(raw: RawAgentEvent, id: string, meta: IngestMeta): AgentEvent[] {
    if (this.emittedIds.has(id)) return [];
    const out: AgentEvent[] = [];
    const at = typeof raw.at === 'string' && raw.at ? raw.at : new Date(this.now()).toISOString();
    const sid = meta.sessionId || raw.sessionId || this.current?.sessionId;
    if (!sid) return [];

    if (raw.kind === 'session.start') {
      const r = this.ensureSession(sid, meta.cli, {
        at, cwd: raw.cwd || meta.cwd, model: raw.model, transcriptPath: raw.transcriptPath,
        origin: typeof raw.source === 'string' ? raw.source : undefined, attribution: meta.attribution, source: meta.source, idBase: id,
      });
      if (!r.emitted.length) this.markSeen(id);
      return r.emitted;
    }

    const started = this.ensureSession(sid, meta.cli, { at, cwd: meta.cwd, attribution: meta.attribution, idBase: `${sid}:tracker:start` });
    out.push(...started.emitted);
    const s = started.session;
    if (raw.transcriptPath && !s.transcriptPath) s.transcriptPath = raw.transcriptPath;
    s.lastEventAt = at;

    switch (raw.kind) {
      case 'session.end':
        out.push(...this.endSession(s, { at, reason: raw.reason, idBase: id, source: meta.source }));
        break;

      case 'status': {
        const state = raw.state === 'working' ? 'working' : raw.state === 'idle' ? 'idle' : null;
        if (!state || s.state === 'ended') { this.markSeen(id); break; }
        if (state === 'working') s.lastWasTurnEnd = false;
        if (s.state === state || (state === 'working' && s.state === 'awaiting-permission')) { this.markSeen(id); break; }
        s.state = state;
        out.push(this.push(s, id, meta.source, at, { kind: 'status', state }));
        break;
      }

      case 'user.message': {
        const text = String(raw.text ?? '');
        if (!text.trim()) { this.markSeen(id); break; }
        if (!s.firstUserText) s.firstUserText = text.slice(0, 120);
        s.lastWasTurnEnd = false;
        s.turnHasChoices = false;
        if (s.state !== 'ended') s.state = 'working';
        out.push(this.push(s, id, meta.source, at, { kind: 'user.message', text }));
        break;
      }

      case 'user.message.meta':
        if (raw.messageId) s.userMessageIds.add(String(raw.messageId));
        this.markSeen(id);
        break;

      case 'assistant.thinking':
        s.lastWasTurnEnd = false;
        out.push(this.push(s, id, meta.source, at, { kind: 'assistant.thinking', text: String(raw.text ?? '') }));
        break;

      case 'assistant.text': {
        const partId = typeof raw.partId === 'string' ? raw.partId : '';
        if (partId && s.textParts.has(partId)) { this.markSeen(id); break; }
        if (partId) s.textParts.add(partId);
        const parsed = parseDisplayBlocks(String(raw.text ?? ''));
        s.lastWasTurnEnd = false;
        s.turnHasChoices = parsed.blocks.some((b) => b.kind === 'choices');
        out.push(this.push(s, id, meta.source, at, {
          kind: 'assistant.text', text: parsed.text, blocks: parsed.blocks, ...(raw.final !== undefined ? { final: Boolean(raw.final) } : {}),
        }));
        break;
      }

      case 'tool.call': {
        const toolUseId = String(raw.toolUseId ?? '');
        if (!toolUseId || s.toolCalls.has(toolUseId)) { this.markSeen(id); break; }
        s.toolCalls.set(toolUseId, { input: raw.input, resolved: s.toolResults.has(toolUseId), order: s.callOrder++ });
        s.lastWasTurnEnd = false;
        out.push(this.push(s, id, meta.source, at, {
          kind: 'tool.call', toolUseId, tool: String(raw.tool ?? ''), toolKind: raw.toolKind ?? 'other',
          title: String(raw.title ?? ''), input: truncateInput(raw.input),
        }));
        // a permission request that arrived before its tool.call (hook raced the transcript)
        if (s.pending && !s.pending.event.toolUseId && sameInput(s.pending.input, raw.input)) {
          s.pending.event = { ...s.pending.event, toolUseId };
        }
        break;
      }

      case 'tool.result': {
        const toolUseId = String(raw.toolUseId ?? '');
        if (!toolUseId || s.toolResults.has(toolUseId)) { this.markSeen(id); break; }
        s.toolResults.add(toolUseId);
        const call = s.toolCalls.get(toolUseId);
        if (call) call.resolved = true;
        const outputText = typeof raw.output === 'string' ? raw.output : undefined;
        const denied = Boolean(raw.denied) || (!raw.ok && /rejected permission|user rejected|doesn't want to proceed|aborted by user/i.test(`${raw.summary ?? ''}\n${outputText ?? ''}`));
        s.lastWasTurnEnd = false;
        out.push(this.push(s, id, meta.source, at, {
          kind: 'tool.result', toolUseId, ok: Boolean(raw.ok), ...(denied ? { denied: true } : {}),
          ...(Number.isInteger(raw.exitCode) ? { exitCode: raw.exitCode as number } : {}),
          summary: String(raw.summary ?? ''), ...(outputText !== undefined ? { output: truncateBytes(outputText, MAX_OUTPUT_BYTES) } : {}),
        }));
        if (s.pending && (s.pending.event.toolUseId === toolUseId || (!s.pending.event.toolUseId && call && sameInput(s.pending.input, call.input)))) {
          out.push(...this.resolvePending(s, denied ? 'denied' : 'allowed', `${id}:resolve`, meta.source, at));
        }
        break;
      }

      case 'permission.request': {
        if (s.state === 'ended') { this.markSeen(id); break; }
        // one prompt at a time: a new request means the previous one was answered somewhere
        if (s.pending) {
          if (meta.source === 'screen' || (s.pending.source === meta.source && sameInput(s.pending.input, raw.input) && !raw.requestId)) { this.markSeen(id); break; }
          out.push(...this.resolvePending(s, 'unknown', `${id}:supersede`, meta.source, at));
        }
        const input = raw.input;
        let toolUseId = typeof raw.toolUseId === 'string' && raw.toolUseId ? raw.toolUseId : undefined;
        if (!toolUseId) toolUseId = this.matchToolCall(s, input);
        const requestId = typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : `${id}`;
        const { title, detail } = permissionText(raw, input);
        const answerable = isAnswerable(s.attribution);
        s.state = 'awaiting-permission';
        s.lastWasTurnEnd = false;
        const ev = this.push(s, id, meta.source, at, {
          kind: 'permission.request', requestId, ...(toolUseId ? { toolUseId } : {}), tool: String(raw.tool ?? ''),
          title, ...(detail ? { detail } : {}), options: permissionOptions(s.cli), answerable,
        }) as PermissionRequestEvent;
        s.pending = { event: ev, input, answering: false, source: meta.source };
        out.push(ev);
        break;
      }

      case 'permission.resolved': {
        if (!s.pending) { this.markSeen(id); break; }
        const p = s.pending.event;
        let matches = false;
        let outcome: 'allowed' | 'denied' | 'unknown' = 'allowed';
        if (typeof raw.requestId === 'string' && raw.requestId) {
          matches = raw.requestId === p.requestId;
          outcome = raw.outcome === 'denied' ? 'denied' : raw.outcome === 'unknown' ? 'unknown' : 'allowed';
        } else {
          // PostToolUse / AfterTool: the tool ran, so the request was allowed
          const tu = typeof raw.toolUseId === 'string' ? raw.toolUseId : '';
          matches = !p.toolUseId || !tu || p.toolUseId === tu;
          outcome = raw.outcome === 'unknown' ? 'unknown' : 'allowed';
        }
        if (!matches) { this.markSeen(id); break; }
        out.push(...this.resolvePending(s, outcome, id, meta.source, at));
        break;
      }

      case 'turn.end': {
        const reason = raw.reason === 'interrupted' ? 'interrupted' : raw.reason === 'error' ? 'error' : 'done';
        if (reason === 'interrupted') {
          if (s.pending) out.push(...this.resolvePending(s, 'denied', `${id}:resolve`, meta.source, at));
          for (const [toolUseId, call] of [...s.toolCalls.entries()].sort((a, b) => a[1].order - b[1].order)) {
            if (call.resolved || s.toolResults.has(toolUseId)) continue;
            call.resolved = true;
            s.toolResults.add(toolUseId);
            out.push(this.push(s, `${id}:synth:${toolUseId}`, 'tracker', at, { kind: 'tool.result', toolUseId, ok: false, denied: true, summary: 'Interrupted' }));
          }
        } else if (s.pending) {
          out.push(...this.resolvePending(s, 'unknown', `${id}:resolve`, meta.source, at));
        }
        if (s.state !== 'ended') s.state = s.turnHasChoices && reason === 'done' ? 'awaiting-input' : 'idle';
        s.canInterrupt = false;
        if (s.lastWasTurnEnd) { this.markSeen(id); break; }
        s.lastWasTurnEnd = true;
        out.push(this.push(s, id, meta.source, at, { kind: 'turn.end', reason, ...(Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs as number } : {}) }));
        break;
      }

      case 'error':
        out.push(this.push(s, id, meta.source, at, { kind: 'error', message: String(raw.message ?? 'error') }));
        break;

      default:
        this.markSeen(id);
        break;
    }
    return out;
  }

  /** Resolve the pending request. `by` is 'relay' when Relay wrote the answer keys. */
  resolvePending(s: SessionState, outcome: 'allowed' | 'denied' | 'unknown', id: string, source: AgentSource, at?: string): AgentEvent[] {
    if (!s.pending) return [];
    const p = s.pending;
    s.pending = null;
    if (s.state === 'awaiting-permission') s.state = 'working';
    return [this.push(s, id, source, at || new Date(this.now()).toISOString(), {
      kind: 'permission.resolved', requestId: p.event.requestId, outcome, by: p.answering ? 'relay' : outcome === 'unknown' && p.source === 'screen' ? 'unknown' : 'terminal',
    })];
  }

  markAnswering(s: SessionState): void {
    if (s.pending) s.pending.answering = true;
  }

  pendingSource(s: SessionState): AgentSource | null {
    return s.pending?.source ?? null;
  }

  private matchToolCall(s: SessionState, input: unknown): string | undefined {
    let best: { id: string; order: number } | null = null;
    for (const [toolUseId, call] of s.toolCalls) {
      if (call.resolved || s.toolResults.has(toolUseId)) continue;
      if (!sameInput(input, call.input)) continue;
      if (!best || call.order > best.order) best = { id: toolUseId, order: call.order };
    }
    return best?.id;
  }

  // ---------------------------------------------------------------------------
  // ring buffer
  // ---------------------------------------------------------------------------

  private markSeen(id: string): void {
    if (this.emittedIds.has(id)) return;
    this.emittedIds.add(id);
    this.idOrder.push(id);
    // bound the dedupe memory (ids of long-gone events can be forgotten)
    const cap = this.ringSize * 20;
    if (this.idOrder.length > cap) for (const old of this.idOrder.splice(0, this.idOrder.length - cap)) this.emittedIds.delete(old);
  }

  private push(s: SessionState, id: string, source: AgentSource, at: string, body: AgentEventBody): AgentEvent {
    this.markSeen(id);
    const ev = { id, seq: this.nextSeq++, terminalId: this.terminalId, sessionId: s.sessionId, cli: s.cli, at, source, ...body } as AgentEvent;
    this.ring.push(ev);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    return ev;
  }

  /** Events with seq > sinceSeq, or null when the ring no longer covers the gap. */
  since(sinceSeq: number): AgentEvent[] | null {
    if (sinceSeq >= this.lastSeq) return [];
    if (this.ring.length === 0) return sinceSeq === 0 ? [] : null;
    if (sinceSeq < this.firstSeq - 1) return null;
    return this.ring.filter((e) => e.seq > sinceSeq);
  }

  before(beforeSeq: number, limit: number): AgentEvent[] {
    const older = this.ring.filter((e) => e.seq < beforeSeq);
    return older.slice(Math.max(0, older.length - limit));
  }

  tail(limit: number): { events: AgentEvent[]; hasMore: boolean } {
    const events = this.ring.slice(Math.max(0, this.ring.length - limit));
    return { events, hasMore: this.ring.length > events.length || this.firstSeq > 1 };
  }
}

export function isAnswerable(attribution: Attribution): boolean {
  return attribution === 'hook' || attribution === 'process';
}

function permissionText(raw: RawAgentEvent, input: unknown): { title: string; detail?: string } {
  const rec = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length) return v.join(' ');
    }
    return '';
  };
  const command = pick('command', 'cmd');
  const target = pick('file_path', 'path', 'url', 'pattern');
  const detail = pick('description', 'justification', 'reason');
  const title = (command || target || String(raw.title ?? '') || String(raw.tool ?? '') || 'Permission requested').slice(0, 400);
  return { title, ...(detail && detail !== title ? { detail: detail.slice(0, 400) } : {}) };
}

/**
 * Equal tool inputs for pairing a permission request with its tool.call. Exact
 * JSON equality first; otherwise the shell command (Gemini's Notification carries
 * `details.command`, Codex's PermissionRequest `{command}` vs exec_command `{cmd}`).
 */
export function sameInput(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  if (stableJson(a) === stableJson(b)) return true;
  const cmd = (v: unknown): string => {
    if (!v || typeof v !== 'object') return '';
    const r = v as Record<string, unknown>;
    const c = r.command ?? r.cmd;
    return typeof c === 'string' ? c.trim() : Array.isArray(c) ? c.join(' ').trim() : '';
  };
  const ca = cmd(a);
  return Boolean(ca) && ca === cmd(b);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? '';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

export function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let cut = text.slice(0, max);
  while (Buffer.byteLength(cut) > max - 3) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Tool input capped at 4 KB serialized (§6.3): long strings are clipped first, then the whole value. */
export function truncateInput(input: unknown): unknown {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? '');
  if (input === undefined || size(input) <= MAX_INPUT_BYTES) return input;
  const clipStrings = (v: unknown, n: number): unknown => {
    if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…` : v;
    if (Array.isArray(v)) return v.map((x) => clipStrings(x, n));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipStrings(x, n)]));
    return v;
  };
  for (const n of [1024, 256]) {
    const clipped = clipStrings(input, n);
    if (size(clipped) <= MAX_INPUT_BYTES) return clipped;
  }
  return { truncated: true, preview: truncateBytes(JSON.stringify(input), MAX_INPUT_BYTES - 64) };
}
