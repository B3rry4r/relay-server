/*
 * AgentTracker (agent-display-spec §2, §5.3, §6): terminals → agent sessions.
 *
 * Inputs:  the hook/plugin spool, the CLIs' own transcripts, /proc, and PTY
 *          output (ScreenGuard, only while a session is attached).
 * Outputs: typed AgentEvents per terminal (ring buffer, epoch/seq), session
 *          summaries, and guarded keystrokes to the terminal's PTY.
 *
 * Everything rebuilds from files after a restart: event ids are deterministic
 * (source file + byte offset), so a client merging a new-epoch snapshot by id
 * sees no duplicates (§6.4).
 */
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claudeLine, claudeTitle } from './adapters/claude';
import { codexLine } from './adapters/codex';
import type { Json, RawAgentEvent } from './adapters/common';
import { geminiLineKind, geminiMessageKeyed } from './adapters/gemini';
import { opencodeUserText, spoolRecord, spoolSessionId, type SpoolRecord } from './adapters/spool';
import { findTranscripts } from './discover';
import { INTERRUPT_KEYS, KEY_GAP_MS, KEY_RETRY_AFTER_MS, PERMISSION_KEYS, resolveKey } from './keys';
import { agentPidFromRecord, attributeRecord, ProcessInspector } from './process';
import { getBridgeWriter, getEmbeddedPtyAccess, ptyHub } from './pty-hub';
import { isAnswerable, TerminalTimeline, type SessionState } from './reducer';
import { CODEX_HOOK_REVIEW, commandUnderSignature, matchesPermission, SCREEN_SIGNATURES, ScreenGuard } from './screen';
import type { PtyServiceLink } from './service-link';
import { SpoolWatcher, type SpoolLine } from './spool';
import { JsonlTailer } from './tail';
import type {
  AgentAck, AgentCli, AgentEvent, AgentSessionSummary, PermissionChoice, SessionCandidate,
} from './types';

export interface TerminalInfo { id: string; pid: number; cwd: string }

export interface AgentTrackerOptions {
  workspace: string;
  /** HOME of the agents (their transcripts live under it). Default: workspace. */
  home?: string;
  spoolDir?: string;
  mode: 'embedded' | 'remote';
  listTerminals: () => Promise<TerminalInfo[]> | TerminalInfo[];
  inspector?: ProcessInspector;
  serviceLink?: PtyServiceLink | null;
  now?: () => number;
  /** Discovery / liveness tick (§5.3: 2 s). */
  tickMs?: number;
  /** Remote terminal-list refresh (§6.2: 5 s). */
  refreshMs?: number;
  /** Grace before a CLI without hook records is attached by process (lets hooks win). */
  hookGraceMs?: number;
  /** Probe PTY sizes with `stty -F` (the tracker cannot see Option-B resizes). */
  probeSizes?: boolean;
  keyGapMs?: number;
  keyRetryMs?: number;
  log?: (line: string) => void;
}

interface TranscriptBinding { tailer: JsonlTailer; sessionId: string; cli: AgentCli }

interface TermState {
  info: TerminalInfo;
  timeline: TerminalTimeline;
  guard: ScreenGuard | null;
  guardTimer: NodeJS.Timeout | null;
  lastScreen: string;
  size: { cols: number; rows: number } | null;
  transcripts: Map<string, TranscriptBinding>;
  lastSpoolAt: number;
  /** CLI processes seen by discovery: pid → first-seen ms */
  cliSeen: Map<number, number>;
  limited: boolean;
  screenCounter: number;
  writing: boolean;
}

const BUFFER_UNKNOWN_MS = 30_000;
const STOP_TAIL_AFTER_END_MS = 10 * 60_000;
const KNOWN_CLIS = new Set<AgentCli>(['claude', 'codex', 'gemini', 'opencode']);

function normalizeCli(value: unknown): AgentCli | null {
  const v = String(value ?? '').replace(/-notify$/, '');
  return KNOWN_CLIS.has(v as AgentCli) ? v as AgentCli : null;
}

export class AgentTracker extends EventEmitter {
  readonly epoch = randomUUID();
  private opts: AgentTrackerOptions;
  private home: string;
  private inspector: ProcessInspector;
  private terminals = new Map<string, TermState>();
  private unknown = new Map<string, Array<{ line: SpoolLine; at: number }>>();
  private spool: SpoolWatcher;
  private tickTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private unsubscribeHub: (() => void) | null = null;
  private started = false;
  private now: () => number;
  private refreshing: Promise<void> | null = null;

  constructor(opts: AgentTrackerOptions) {
    super();
    this.setMaxListeners(0);
    this.opts = opts;
    this.home = opts.home ?? opts.workspace;
    this.inspector = opts.inspector ?? new ProcessInspector();
    this.now = opts.now ?? Date.now;
    const spoolDir = opts.spoolDir ?? path.join(opts.workspace, '.relay', 'state', 'agent-events');
    this.spool = new SpoolWatcher(spoolDir, (line) => this.onSpoolLine(line));
  }

  get spoolDir(): string {
    return this.spool.dir;
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(`[agent] ${line}`);
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeHub = ptyHub.subscribe({
      output: (id, data) => this.onPtyOutput(id, data),
      replay: (id, data) => this.onPtyReplay(id, data),
      resized: (id, cols, rows) => this.onResize(id, cols, rows),
      closed: (id, reason) => this.onTerminalClosed(id, reason === 'closed'),
      changed: () => { void this.refreshTerminals(); },
    });
    await this.refreshTerminals();
    this.spool.start();
    const tick = this.opts.tickMs ?? 2000;
    this.tickTimer = setInterval(() => { void this.tick(); }, tick);
    this.tickTimer.unref?.();
    if (this.opts.mode === 'remote') {
      this.refreshTimer = setInterval(() => { void this.refreshTerminals(); }, this.opts.refreshMs ?? 5000);
      this.refreshTimer.unref?.();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.tickTimer = null;
    this.refreshTimer = null;
    this.spool.stop();
    for (const t of this.terminals.values()) this.disposeTerminal(t);
    this.terminals.clear();
    this.opts.serviceLink?.close();
  }

  // ---------------------------------------------------------------------------
  // terminals
  // ---------------------------------------------------------------------------

  refreshTerminals(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let list: TerminalInfo[];
      try {
        list = await this.opts.listTerminals();
      } catch (error) {
        // never treat a failed fetch as "every terminal closed"
        this.log(`terminal list unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const seen = new Set<string>();
      for (const info of list) {
        if (!info?.id) continue;
        seen.add(info.id);
        const existing = this.terminals.get(info.id);
        if (existing) {
          if (info.pid && existing.info.pid !== info.pid) {
            existing.info = { ...info };
            existing.limited = this.computeLimited(info);
            existing.timeline.limited = existing.limited;
          }
          continue;
        }
        this.addTerminal(info);
      }
      for (const id of [...this.terminals.keys()]) {
        // embedded closes arrive through the hub (with a reason); remote ones only here
        if (!seen.has(id) && this.opts.mode === 'remote') this.onTerminalClosed(id, true);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private computeLimited(info: TerminalInfo): boolean {
    if (this.opts.mode === 'embedded') return false;
    return !this.inspector.sharesNamespaceWith(info.id, info.pid);
  }

  private addTerminal(info: TerminalInfo): void {
    const limited = this.computeLimited(info);
    const timeline = new TerminalTimeline(info.id, { now: this.now });
    timeline.limited = limited;
    const t: TermState = {
      info: { ...info }, timeline, guard: null, guardTimer: null, lastScreen: '', size: null,
      transcripts: new Map(), lastSpoolAt: 0, cliSeen: new Map(), limited, screenCounter: 0, writing: false,
    };
    this.terminals.set(info.id, t);
    if (limited) this.log(`terminal ${info.id}: /proc not shared with the PTY host — limited mode (no lineage checks, no fallback discovery)`);
    // replay spool records that arrived before the terminal list knew this id
    const buffered = this.unknown.get(info.id);
    this.unknown.delete(info.id);
    for (const b of buffered ?? []) this.onSpoolLine(b.line);
  }

  private onTerminalClosed(id: string, deleteSpool: boolean): void {
    const t = this.terminals.get(id);
    if (t) {
      const s = t.timeline.current;
      if (s && s.state !== 'ended') this.emitEvents(t, t.timeline.endSession(s, { reason: 'terminal-closed', idBase: `${s.sessionId}:tracker:terminal-closed` }));
      this.disposeTerminal(t);
      this.terminals.delete(id);
      this.emit('sessions');
    }
    if (deleteSpool) this.spool.remove(id);
    this.updateServiceLink();
  }

  private disposeTerminal(t: TermState): void {
    for (const b of t.transcripts.values()) b.tailer.stop();
    t.transcripts.clear();
    this.disposeGuard(t);
  }

  // ---------------------------------------------------------------------------
  // spool (hooks / plugin)
  // ---------------------------------------------------------------------------

  private onSpoolLine(line: SpoolLine): void {
    const { record, idBase } = line;
    const terminalId = typeof record.terminalId === 'string' && record.terminalId ? record.terminalId : line.fileKey;
    if (terminalId === '_unknown' || terminalId === '_unattributed') return;
    const t = this.terminals.get(terminalId);
    if (!t) {
      const list = this.unknown.get(terminalId) ?? [];
      const cutoff = this.now() - BUFFER_UNKNOWN_MS;
      const kept = list.filter((b) => b.at >= cutoff);
      kept.push({ line, at: this.now() });
      this.unknown.set(terminalId, kept.slice(-2000));
      void this.refreshTerminals();
      return;
    }
    const cli = normalizeCli(record.cli);
    if (!cli) return;
    const payload = (record.payload && typeof record.payload === 'object' ? record.payload : {}) as Json;
    const sid = spoolSessionId(record);
    if (!sid) return; // e.g. opencode PluginLoaded, catalog noise
    t.lastSpoolAt = this.now();

    // §5.3 lineage validation
    const verdict = t.limited ? 'hook' : attributeRecord(this.inspector, t.info.pid, record);
    let raws: RawAgentEvent[] = spoolRecord(record);
    const partKeys: string[] = raws.map((_, n) => String(n));
    const existing = t.timeline.session(sid);
    if (cli === 'opencode') {
      const ut = opencodeUserText(record, existing?.userMessageIds ?? new Set());
      if (ut) { raws = [...raws, { kind: 'user.message', at: record.at, sessionId: sid, text: ut.text }]; partKeys.push(`user:${ut.partId}`); }
    }
    // claude/codex transcripts carry the authoritative turn end; the hook copy races it
    if (existing?.transcriptBound && (cli === 'claude' || cli === 'codex')) {
      const keep = raws.map((r) => r.kind !== 'turn.end');
      raws = raws.filter((_, i) => keep[i]);
      const keys = partKeys.filter((_, i) => keep[i]);
      partKeys.length = 0;
      partKeys.push(...keys);
    }
    const attribution = verdict === 'detached' ? 'detached' : verdict === 'hook' ? 'hook' : (existing?.attribution ?? 'hook');
    const events = t.timeline.ingest(raws, { idBase, source: 'hook', cli, sessionId: sid, attribution, cwd: typeof payload.cwd === 'string' ? payload.cwd : t.info.cwd, partKeys });
    const s = t.timeline.session(sid);
    if (s) {
      const agentPid = agentPidFromRecord({ ...record, cli });
      if (agentPid && verdict === 'hook') s.agentPid = agentPid;
      if (verdict === 'hook' && s.attribution !== 'hook') t.timeline.setAttribution(sid, 'hook');
      if (verdict === 'detached' && s.attribution !== 'detached') {
        t.timeline.setAttribution(sid, 'detached');
        events.push(...t.timeline.notice(s, 'detached-process', cli === 'codex'
          ? "Codex's shared background server is answering for this terminal, so Relay cannot tell which terminal it belongs to. Run `pkill -f 'codex app-server'` or restart Codex to enable per-terminal events."
          : 'This agent runs outside the terminal\'s process tree (tmux, screen, setsid or nohup). Relay shows its activity but will not send keys to it.', 'detached'));
      }
    }
    this.emitEvents(t, events);
    // bind AFTER emitting: the transcript backfill emits synchronously (seq order = emit order)
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    if (s && transcriptPath && cli !== 'opencode') this.bindTranscript(t, s, transcriptPath);
    this.syncGuard(t);
  }

  // ---------------------------------------------------------------------------
  // transcripts
  // ---------------------------------------------------------------------------

  /** Only files inside the agents' HOME / workspace are ever read (hook payloads are user-writable). */
  private safeTranscriptPath(file: string): string | null {
    if (typeof file !== 'string' || !file.endsWith('.jsonl') || !path.isAbsolute(file)) return null;
    const resolved = path.resolve(file);
    const real = realOrSelf(resolved);
    const roots = [this.home, this.opts.workspace].map((r) => realOrSelf(path.resolve(r)));
    return roots.some((r) => real.startsWith(`${r}${path.sep}`)) ? real : null;
  }

  private bindTranscript(t: TermState, s: SessionState, file: string): void {
    const safe = this.safeTranscriptPath(file);
    if (!safe) return;
    if (t.transcripts.has(safe)) {
      const b = t.transcripts.get(safe)!;
      if (b.sessionId === s.sessionId) return;
      b.tailer.stop();
    }
    s.transcriptPath = safe;
    s.transcriptBound = true;
    const cli = s.cli;
    const sessionId = s.sessionId;
    const binding: TranscriptBinding = { cli, sessionId, tailer: null as unknown as JsonlTailer };
    binding.tailer = new JsonlTailer(safe, {
      onLine: (line, offset) => this.onTranscriptLine(t, binding, line, offset),
      onReset: (why) => this.log(`transcript ${safe} ${why} — re-reading from 0`),
    });
    t.transcripts.set(safe, binding);
    binding.tailer.start();
  }

  private onTranscriptLine(t: TermState, b: TranscriptBinding, line: string, offset: number): void {
    let o: Json;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o !== 'object') return;
    const sid = b.sessionId;
    const s = t.timeline.session(sid);
    let raws: RawAgentEvent[] = [];
    let idBase = `${sid}:transcript:${offset}`;
    let partKeys: string[] | undefined;
    if (b.cli === 'claude') {
      if (o.isSidechain) return;
      const title = claudeTitle(o);
      if (title && s) { s.title = title; this.emit('sessions'); }
      raws = claudeLine(o);
    } else if (b.cli === 'codex') {
      raws = codexLine(o).filter((r) => r.kind !== 'session.start' || !s);
    } else if (b.cli === 'gemini') {
      const kind = geminiLineKind(o);
      if (kind !== 'record') return;
      const keyed = geminiMessageKeyed(o);
      raws = keyed;
      partKeys = keyed.map((k) => k.partKey);
      idBase = `${sid}:transcript:${o.id}`;
    }
    if (!raws.length) return;
    const events = t.timeline.ingest(raws, { idBase, source: 'transcript', cli: b.cli, sessionId: sid, cwd: s?.cwd || t.info.cwd, partKeys });
    this.emitEvents(t, events);
    this.syncGuard(t);
  }

  // ---------------------------------------------------------------------------
  // PTY output → ScreenGuard
  // ---------------------------------------------------------------------------

  private needsGuard(t: TermState): boolean {
    const s = t.timeline.current;
    return Boolean(s && s.state !== 'ended');
  }

  private syncGuard(t: TermState): void {
    if (this.needsGuard(t)) {
      if (t.guardTimer) { clearTimeout(t.guardTimer); t.guardTimer = null; }
      if (!t.guard) this.createGuard(t);
    } else if (t.guard && !t.guardTimer) {
      t.guardTimer = setTimeout(() => { t.guardTimer = null; if (!this.needsGuard(t)) this.disposeGuard(t); }, 2000);
      t.guardTimer.unref?.();
    }
    this.updateServiceLink();
  }

  private createGuard(t: TermState): void {
    t.guard = new ScreenGuard({ cols: t.size?.cols, rows: t.size?.rows, onChange: (screen) => this.onScreen(t, screen) });
    if (this.opts.mode === 'embedded') {
      const scrollback = getEmbeddedPtyAccess()?.scrollback(t.info.id) ?? '';
      if (scrollback) t.guard.write(scrollback.slice(-128 * 1024));
    }
    if (this.opts.probeSizes !== false) void this.probeSize(t);
  }

  private disposeGuard(t: TermState): void {
    if (t.guardTimer) clearTimeout(t.guardTimer);
    t.guardTimer = null;
    t.guard?.dispose();
    t.guard = null;
    t.lastScreen = '';
  }

  private onPtyOutput(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (t?.guard) t.guard.write(data);
  }

  private onPtyReplay(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t?.guard) return;
    t.guard.reset();
    t.guard.write(data);
  }

  private onResize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id);
    if (!t) return;
    t.size = { cols, rows };
    t.guard?.resize(cols, rows);
  }

  private async probeSize(t: TermState): Promise<void> {
    if (t.limited) return;
    const ttyOf = (pid: number) => this.inspector.tty(pid);
    let tty = ttyOf(t.info.pid);
    if (!tty) for (const p of this.inspector.descendants(t.info.pid)) { tty = ttyOf(p); if (tty) break; }
    if (!tty) return;
    const out = await new Promise<string>((resolve) => {
      execFile('stty', ['-F', tty as string, 'size'], { timeout: 1000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    const m = /^(\d+)\s+(\d+)/.exec(out.trim());
    if (!m) return;
    const rows = Number(m[1]);
    const cols = Number(m[2]);
    if (rows > 0 && cols > 0 && (t.size?.cols !== cols || t.size?.rows !== rows)) this.onResize(t.info.id, cols, rows);
  }

  private onScreen(t: TermState, screen: string): void {
    t.lastScreen = screen;
    const s = t.timeline.current;
    if (!s || s.state === 'ended') return;
    const events: AgentEvent[] = [];
    const sig = SCREEN_SIGNATURES[s.cli];
    const canInterrupt = sig.interruptHint.test(screen);
    let changed = false;
    if (canInterrupt !== s.canInterrupt) { s.canInterrupt = canInterrupt; changed = true; }
    if (s.cli === 'codex' && CODEX_HOOK_REVIEW.test(screen)) {
      events.push(...t.timeline.notice(s, 'codex-hooks-untrusted', CODEX_TRUST_MESSAGE, 'screen'));
    }
    // §8.2 screen-only permission detection for sessions without trusted hooks
    if (s.attribution === 'process' || s.attribution === 'ambiguous') {
      const onScreen = matchesPermission(s.cli, screen);
      if (onScreen && !s.pending) {
        t.screenCounter += 1;
        events.push(...t.timeline.ingest([{
          kind: 'permission.request', at: new Date(this.now()).toISOString(), tool: s.cli === 'opencode' ? 'bash' : 'Bash',
          title: commandUnderSignature(s.cli, screen), input: { command: commandUnderSignature(s.cli, screen) },
        }], { idBase: `${t.info.id}:screen:${this.epoch}:${t.screenCounter}`, source: 'screen', cli: s.cli, sessionId: s.sessionId }));
      } else if (!onScreen && s.pending && t.timeline.pendingSource(s) === 'screen') {
        events.push(...t.timeline.resolvePending(s, 'unknown', `${t.info.id}:screen:${this.epoch}:${t.screenCounter}:resolved`, 'screen'));
      }
    }
    if (events.length) this.emitEvents(t, events);
    else if (changed) this.emit('sessions');
  }

  // ---------------------------------------------------------------------------
  // tick: fallback discovery (§5.3), agent exit, size probe
  // ---------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.opts.mode === 'embedded') await this.refreshTerminals();
    this.inspector.invalidate();
    const now = this.now();
    for (const [id, list] of this.unknown) {
      const kept = list.filter((b) => b.at >= now - BUFFER_UNKNOWN_MS);
      if (kept.length) this.unknown.set(id, kept); else this.unknown.delete(id);
    }
    const discoveries: Array<{ t: TermState; pid: number; cli: AgentCli; cwd: string; startMs: number }> = [];
    for (const t of this.terminals.values()) {
      // stop tailing ended sessions after 10 min
      for (const [file, b] of t.transcripts) {
        const s = t.timeline.session(b.sessionId);
        if (s?.endedAt && now - s.endedAt > STOP_TAIL_AFTER_END_MS) { b.tailer.stop(); t.transcripts.delete(file); }
      }
      if (t.limited) continue;
      const s = t.timeline.current;
      // the agent process exited without a SessionEnd (killed, crashed, codex without the hook)
      if (s && s.state !== 'ended' && s.agentPid && !this.inspector.isAlive(s.agentPid)) {
        this.emitEvents(t, t.timeline.endSession(s, { reason: 'process-exit', idBase: `${s.sessionId}:tracker:exit:${s.agentPid}` }));
        this.syncGuard(t);
      }
      const clis = this.inspector.findClis(t.info.pid);
      const live = new Set(clis.map((c) => c.pid));
      for (const pid of [...t.cliSeen.keys()]) if (!live.has(pid)) t.cliSeen.delete(pid);
      for (const c of clis) {
        if (!t.cliSeen.has(c.pid)) t.cliSeen.set(c.pid, now);
        const cur = t.timeline.current;
        if (cur && cur.state !== 'ended' && (cur.agentPid === c.pid || cur.attribution === 'hook')) continue;
        const firstSeen = t.cliSeen.get(c.pid) as number;
        const startMs = this.inspector.startTimeMs(c.pid) ?? firstSeen;
        if (t.lastSpoolAt >= startMs - 1000) continue; // hooks are reporting for this CLI
        if (now - firstSeen < (this.opts.hookGraceMs ?? 4000)) continue;
        discoveries.push({ t, pid: c.pid, cli: c.cli, cwd: this.inspector.cwd(c.pid) ?? t.info.cwd, startMs });
      }
      if (t.guard && this.opts.probeSizes !== false) void this.probeSize(t);
      // a provisional process session keeps looking for its transcript
      if (s && s.state !== 'ended' && s.attribution === 'process' && !s.transcriptBound && s.agentPid) {
        const cwd = this.inspector.cwd(s.agentPid) ?? s.cwd;
        const found = findTranscripts(s.cli, this.home, cwd, this.inspector.startTimeMs(s.agentPid) ?? now);
        if (found.length === 1 && !this.transcriptClaimed(found[0].transcriptPath)) this.adoptCandidate(t, s, found[0]);
      }
    }
    this.attachDiscovered(discoveries);
  }

  private transcriptClaimed(file: string): boolean {
    for (const t of this.terminals.values()) if (t.transcripts.has(file)) return true;
    return false;
  }

  private attachDiscovered(found: Array<{ t: TermState; pid: number; cli: AgentCli; cwd: string; startMs: number }>): void {
    // §5.3 step 4: bind only on a unique match — group by CLI + cwd across terminals
    const groups = new Map<string, typeof found>();
    for (const f of found) {
      const key = `${f.cli}\0${f.cwd}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const t of this.terminals.values()) {
      const cur = t.timeline.current;
      if (!cur || cur.state === 'ended' || cur.attribution === 'hook' || !cur.agentPid) continue;
      // a running process session in another terminal also competes for the same transcripts
      const key = `${cur.cli}\0${cur.cwd}`;
      if (groups.has(key) && !groups.get(key)!.some((f) => f.t === t)) groups.get(key)!.push({ t, pid: cur.agentPid, cli: cur.cli, cwd: cur.cwd, startMs: 0 });
    }
    for (const group of groups.values()) {
      for (const f of group) {
        const { t } = f;
        const cur = t.timeline.current;
        if (cur && cur.state !== 'ended' && cur.agentPid === f.pid && cur.attribution !== 'ambiguous' && group.length === 1) continue;
        const candidates = findTranscripts(f.cli, this.home, f.cwd, f.startMs).filter((c) => !this.transcriptClaimed(c.transcriptPath) || c.transcriptPath === cur?.transcriptPath);
        const ambiguous = group.length > 1;
        const events: AgentEvent[] = [];
        let s = cur && cur.state !== 'ended' && cur.agentPid === f.pid ? cur : null;
        if (!s) {
          const sid = !ambiguous && candidates.length === 1 ? candidates[0].sessionId : `proc-${f.cli}-${f.pid}`;
          const r = t.timeline.ensureSession(sid, f.cli, { cwd: f.cwd, attribution: ambiguous ? 'ambiguous' : 'process', idBase: `${sid}:tracker:start:${f.pid}` });
          s = r.session;
          s.agentPid = f.pid;
          events.push(...r.emitted);
          if (f.cli === 'codex') events.push(...t.timeline.notice(s, 'codex-hooks-untrusted', CODEX_TRUST_MESSAGE, `pid:${f.pid}`));
          else events.push(...t.timeline.notice(s, 'hooks-missing', HOOKS_MISSING_MESSAGE, `pid:${f.pid}`));
          if (!ambiguous && candidates.length === 1) {
            // emit what we have first: the transcript backfill below emits synchronously
            this.emitEvents(t, events.splice(0));
            this.bindTranscript(t, s, candidates[0].transcriptPath);
          }
        }
        if (ambiguous && s.attribution !== 'ambiguous') t.timeline.setAttribution(s.sessionId, 'ambiguous');
        if (ambiguous) {
          s.candidates = candidates;
          events.push(...t.timeline.notice(s, 'ambiguous-session',
            `More than one terminal runs ${cliLabel(f.cli)} in ${f.cwd}. Pick the session that belongs to this terminal.`, `pid:${f.pid}:${candidates.map((c) => c.sessionId).join(',')}`, candidates));
        }
        this.emitEvents(t, events);
        this.syncGuard(t);
      }
    }
  }

  private adoptCandidate(t: TermState, s: SessionState, c: SessionCandidate): void {
    if (s.sessionId !== c.sessionId) t.timeline.renameSession(s.sessionId, c.sessionId);
    this.bindTranscript(t, s, c.transcriptPath);
    this.emit('sessions');
  }

  /** The ambiguous-session picker (§5.3 step 4): the user says which transcript is theirs (memory only). */
  bind(terminalId: string, sessionId: string): AgentAck {
    const t = this.terminals.get(terminalId);
    const s = t?.timeline.current;
    if (!t || !s) return { ok: false, reason: 'no-terminal' };
    const c = s.candidates?.find((x) => x.sessionId === sessionId);
    if (!c) return { ok: false, reason: 'unknown-session' };
    t.timeline.setAttribution(s.sessionId, 'process');
    s.candidates = undefined;
    this.adoptCandidate(t, s, c);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // emit
  // ---------------------------------------------------------------------------

  private emitEvents(t: TermState, events: AgentEvent[]): void {
    if (!events.length) return;
    for (const ev of events) this.emit('event', t.info.id, ev);
    this.emit('sessions');
  }

  private updateServiceLink(): void {
    const link = this.opts.serviceLink;
    if (!link || this.opts.mode !== 'remote') return;
    const active = [...this.terminals.values()].some((t) => this.needsGuard(t));
    if (active) link.ensureOpen(); else link.releaseSoon();
  }

  // ---------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------

  sessions(): AgentSessionSummary[] {
    const out: AgentSessionSummary[] = [];
    for (const t of this.terminals.values()) {
      const summary = t.timeline.summary();
      if (summary) out.push(summary);
    }
    return out;
  }

  hasTerminal(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  snapshot(terminalId: string, limit = 200): { session: AgentSessionSummary | null; events: AgentEvent[]; hasMore: boolean } {
    const t = this.terminals.get(terminalId);
    if (!t) return { session: null, events: [], hasMore: false };
    const { events, hasMore } = t.timeline.tail(Math.min(200, Math.max(1, limit)));
    return { session: t.timeline.summary(), events, hasMore };
  }

  /** Delta for a reconnect in the same epoch (null → send a snapshot). §7.4: gap ≤ 500. */
  delta(terminalId: string, sinceSeq: number): AgentEvent[] | null {
    const t = this.terminals.get(terminalId);
    if (!t) return null;
    if (t.timeline.lastSeq - sinceSeq > 500) return null;
    return t.timeline.since(sinceSeq);
  }

  history(terminalId: string, beforeSeq: number, limit = 200): AgentEvent[] {
    const t = this.terminals.get(terminalId);
    if (!t) return [];
    return t.timeline.before(beforeSeq, Math.min(200, Math.max(1, limit)));
  }

  /** Current screen text (tests / diagnostics). */
  async screen(terminalId: string): Promise<string | null> {
    const t = this.terminals.get(terminalId);
    return t?.guard ? t.guard.screen() : null;
  }

  // ---------------------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------------------

  private async write(t: TermState, data: string, viaSocketId?: string): Promise<boolean> {
    if (this.opts.mode === 'embedded') return getEmbeddedPtyAccess()?.write(t.info.id, data) ?? false;
    const bridge = getBridgeWriter(viaSocketId);
    if (bridge) return bridge(t.info.id, data);
    if (this.opts.serviceLink) return this.opts.serviceLink.write(t.info.id, data);
    return false;
  }

  /** agent:respond with the §8.3 guard. Keys are written only when every check passes. */
  async respond(terminalId: string, requestId: string, choice: PermissionChoice, viaSocketId?: string): Promise<AgentAck> {
    const t = this.terminals.get(terminalId);
    if (!t) return { ok: false, reason: 'no-terminal' };
    const s = t.timeline.current;
    const pending = s?.pending;
    // 1. the request the user saw is still the one on screen
    if (!s || !pending || pending.event.requestId !== requestId || pending.answering) return { ok: false, reason: 'stale' };
    const keys = PERMISSION_KEYS[s.cli]?.[choice];
    if (!keys) return { ok: false, reason: 'invalid-choice' };
    // 2. attribution must allow keys (never for detached / ambiguous sessions)
    if (!isAnswerable(s.attribution)) return { ok: false, reason: 'not-answerable' };
    // 3. the CLI's prompt must be on THIS terminal's screen right now
    if (!t.guard) return { ok: false, reason: 'guard-mismatch' };
    const screen = await t.guard.screen();
    if (!matchesPermission(s.cli, screen)) return { ok: false, reason: 'guard-mismatch' };
    if (s.pending !== pending || t.writing) return { ok: false, reason: 'stale' };
    // 4. write, then wait for evidence (never resolve optimistically)
    t.writing = true;
    t.timeline.markAnswering(s);
    this.emit('sessions');
    try {
      const gap = this.opts.keyGapMs ?? KEY_GAP_MS;
      const resolved = keys.map((k) => resolveKey(k, t.guard?.applicationCursorKeys ?? false));
      let beforeLast = screen;
      for (let i = 0; i < resolved.length; i += 1) {
        if (i === resolved.length - 1 && resolved.length > 1) beforeLast = t.guard ? await t.guard.screen() : '';
        const ok = await this.write(t, resolved[i], viaSocketId);
        if (!ok) return { ok: false, reason: 'no-terminal' };
        if (i < resolved.length - 1) await sleep(gap);
      }
      if (resolved.length > 1) {
        // §8.1: retry the final key once if the SAME prompt is still showing
        const last = resolved[resolved.length - 1];
        const retryAfter = this.opts.keyRetryMs ?? KEY_RETRY_AFTER_MS;
        setTimeout(() => {
          void (async () => {
            if (!t.guard || s.pending !== pending) return;
            const now = await t.guard.screen();
            if (now === beforeLast && matchesPermission(s.cli, now)) await this.write(t, last, viaSocketId);
          })();
        }, retryAfter).unref?.();
      }
      return { ok: true };
    } finally {
      t.writing = false;
    }
  }

  /** agent:send — text, then Enter 60 ms later (newlines become spaces in v1). */
  async send(terminalId: string, text: string, viaSocketId?: string): Promise<AgentAck> {
    const t = this.terminals.get(terminalId);
    if (!t) return { ok: false, reason: 'no-terminal' };
    const s = t.timeline.current;
    if (!s || s.state === 'ended') return { ok: false, reason: 'no-session' };
    // typed text must never land in a permission prompt (Codex takes `y` as "yes")
    if (s.state === 'awaiting-permission') return { ok: false, reason: 'awaiting-permission' };
    const clean = String(text ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!clean.trim()) return { ok: false, reason: 'empty' };
    if (clean.length > 16_000) return { ok: false, reason: 'too-long' };
    if (!(await this.write(t, clean, viaSocketId))) return { ok: false, reason: 'no-terminal' };
    await sleep(60);
    if (!(await this.write(t, '\r', viaSocketId))) return { ok: false, reason: 'no-terminal' };
    return { ok: true };
  }

  /** agent:choose — tap a relay-choices option (sends its number). */
  async choose(terminalId: string, eventId: string, optionN: number, viaSocketId?: string): Promise<AgentAck> {
    const t = this.terminals.get(terminalId);
    if (!t) return { ok: false, reason: 'no-terminal' };
    const events = t.timeline.events();
    const idx = events.findIndex((e) => e.id === eventId);
    const ev = idx === -1 ? undefined : events[idx];
    if (!ev || ev.kind !== 'assistant.text') return { ok: false, reason: 'stale' };
    const block = ev.blocks.find((b) => b.kind === 'choices');
    if (!block || block.kind !== 'choices' || !block.options.some((o) => o.n === optionN)) return { ok: false, reason: 'invalid-choice' };
    if (events.slice(idx + 1).some((e) => e.kind === 'user.message' && e.sessionId === ev.sessionId)) return { ok: false, reason: 'stale' };
    if (t.timeline.current?.sessionId !== ev.sessionId) return { ok: false, reason: 'stale' };
    return this.send(terminalId, String(optionN), viaSocketId);
  }

  /** agent:interrupt — Esc (UNVERIFIED as a mid-turn interrupt; offered only while the CLI shows its hint). */
  async interrupt(terminalId: string, viaSocketId?: string): Promise<AgentAck & { verified?: boolean }> {
    const t = this.terminals.get(terminalId);
    if (!t) return { ok: false, reason: 'no-terminal' };
    const s = t.timeline.current;
    if (!s || s.state === 'ended') return { ok: false, reason: 'no-session' };
    for (const k of INTERRUPT_KEYS[s.cli]) if (!(await this.write(t, k, viaSocketId))) return { ok: false, reason: 'no-terminal' };
    return { ok: true, verified: false };
  }
}

export const CODEX_TRUST_MESSAGE = 'Codex asks once to trust Relay\'s event hooks. Choose "2. Trust all and continue" in the terminal. Until then the Agent view shows the transcript only.';
export const HOOKS_MISSING_MESSAGE = 'Relay\'s event hooks are not reporting for this agent, so permission prompts are read from the screen. Restart the workspace to reinstall them.';

function cliLabel(cli: AgentCli): string {
  return cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : cli === 'gemini' ? 'Gemini' : 'opencode';
}

/** realpath of a file, or of its directory + basename when the file does not exist yet. */
function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { /* not there yet */ }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}
