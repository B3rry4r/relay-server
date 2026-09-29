/*
 * Agent view — normalized event model (agent-display-spec §3).
 *
 * relay-web mirrors this file in src/types/agent.ts. Additions beyond the spec
 * text are all OPTIONAL fields and are marked "(ext)":
 *   - PermissionOption.detail       per-CLI copy for the confirm step (Codex
 *                                   "Always" applies to future sessions too)
 *   - notice.candidates             the ambiguous-session picker's choices
 *   - choices.more                  how many options past the 4th were cut
 *   - AgentSessionSummary.canInterrupt / limited
 *   - permission.request.source is the event's `source` ('hook' | 'screen')
 */

export type AgentCli = 'claude' | 'codex' | 'gemini' | 'opencode';
export type AgentSource = 'transcript' | 'hook' | 'screen' | 'tracker';

export interface AgentEventBase {
  /** Deterministic replay-safe dedupe key (§6.4): transcript `${sessionId}:transcript:${offset}:${n}`,
   *  hook `${terminalId}:spool:${inode}:${offset}:${n}`, gemini `${sessionId}:transcript:${recordId}:${part}`. */
  id: string;
  /** Monotonic per terminal within one tracker epoch (§6.4). */
  seq: number;
  terminalId: string;
  sessionId: string;
  cli: AgentCli;
  /** ISO timestamp from the source record. */
  at: string;
  source: AgentSource;
}

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'web' | 'task' | 'mcp' | 'other';

export type DisplayBlock =
  | { kind: 'status'; state: 'working' | 'blocked' | 'done' | 'failed'; title: string; progress?: string; detail?: string }
  | { kind: 'choices'; question: string; options: { n: number; label: string }[]; allowOther: boolean; /** (ext) */ more?: number }
  | { kind: 'summary'; title: string; result?: 'success' | 'partial' | 'failed'; bullets: string[] }
  | { kind: 'files'; files: { status: 'A' | 'M' | 'D' | 'R'; path: string }[] }
  | { kind: 'link'; title: string; url: string };

export type AgentState = 'starting' | 'idle' | 'working' | 'awaiting-permission' | 'awaiting-input' | 'ended';

export type PermissionChoice = 'allow_once' | 'allow_always' | 'deny';

export interface PermissionOption {
  id: PermissionChoice;
  label: string;
  confirm?: boolean;
  /** (ext) extra copy for the confirm step. */
  detail?: string;
}

export type NoticeCode = 'codex-hooks-untrusted' | 'hooks-missing' | 'detached-process' | 'ambiguous-session';

export interface SessionCandidate {
  sessionId: string;
  title?: string;
  transcriptPath: string;
  mtime: string;
}

export type AgentEventBody =
  | { kind: 'session.start'; cwd: string; model?: string; transcriptPath?: string; origin?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' }
  | { kind: 'session.end'; reason?: string }
  | { kind: 'user.message'; text: string }
  | { kind: 'assistant.thinking'; text: string }
  | { kind: 'assistant.text'; text: string; blocks: DisplayBlock[]; final?: boolean }
  | { kind: 'tool.call'; toolUseId: string; tool: string; toolKind: ToolKind; title: string; input: unknown }
  | { kind: 'tool.result'; toolUseId: string; ok: boolean; denied?: boolean; exitCode?: number; summary: string; output?: string }
  | { kind: 'permission.request'; requestId: string; toolUseId?: string; tool: string; title: string; detail?: string; options: PermissionOption[]; answerable: boolean }
  | { kind: 'permission.resolved'; requestId: string; outcome: 'allowed' | 'denied' | 'unknown'; by: 'relay' | 'terminal' | 'unknown' }
  | { kind: 'status'; state: AgentState; label?: string }
  | { kind: 'turn.end'; reason: 'done' | 'interrupted' | 'error'; durationMs?: number }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; code: NoticeCode; message: string; /** (ext) */ candidates?: SessionCandidate[] };

export type AgentEvent = AgentEventBase & AgentEventBody;
export type AgentEventKind = AgentEventBody['kind'];
export type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission.request' }>;

export type Attribution = 'hook' | 'process' | 'ambiguous' | 'detached';

export interface AgentSessionSummary {
  terminalId: string;
  cli: AgentCli;
  sessionId: string;
  cwd: string;
  title?: string;
  model?: string;
  state: AgentState;
  attribution: Attribution;
  pending?: PermissionRequestEvent;
  startedAt: string;
  lastEventAt: string;
  /** (ext) the CLI's own "esc to interrupt" hint is on screen right now. */
  canInterrupt?: boolean;
  /** (ext) /proc is not shared with the PTY host: no lineage checks, no fallback discovery (§5.4). */
  limited?: boolean;
}

// ---- socket payloads (§7) ---------------------------------------------------
export interface AgentSessionsPayload { epoch: string; sessions: AgentSessionSummary[] }
export interface AgentSnapshotPayload { epoch: string; terminalId: string; session: AgentSessionSummary | null; events: AgentEvent[]; hasMore: boolean }
export interface AgentEventPayload { epoch: string; terminalId: string; event: AgentEvent }
export interface AgentEventsPayload { epoch: string; terminalId: string; events: AgentEvent[] }

export type RespondFailure = 'stale' | 'not-answerable' | 'guard-mismatch' | 'no-terminal';
export type AgentAck = { ok: true } | { ok: false; reason: string };
