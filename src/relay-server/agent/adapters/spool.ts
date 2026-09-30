/*
 * Hook / plugin spool adapter ($RELAY_HOME/state/agent-events/<terminalId>.jsonl).
 * Covers Claude, Codex and Gemini hooks (§4.1-4.3) and the opencode plugin bus
 * events (§4.4). Record shape (§5.2):
 *   {v:1, cli, terminalId, pid, ppid, lineage?:[{pid,cmd}], at, payload:{…verbatim hook stdin…}}
 */
import { extractRawBlocks } from '../blocks';
import { clip, toolKind, toolTitle, type Json, type RawAgentEvent } from './common';

export interface SpoolRecord {
  v?: number;
  cli?: string;
  terminalId?: string;
  pid?: number;
  ppid?: number;
  lineage?: Array<{ pid: number; cmd?: string }>;
  at?: string;
  payload?: Json | string;
}

export function spoolRecord(r: SpoolRecord): RawAgentEvent[] {
  const p: Json = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Json;
  const at = r.at;
  const out: RawAgentEvent[] = [];
  const ev = p.hook_event_name || p.type;
  const sid = p.session_id || p['thread-id'];
  const base = { at, sessionId: sid, transcriptPath: p.transcript_path };
  switch (ev) {
    case 'SessionStart': out.push({ kind: 'session.start', ...base, cwd: p.cwd, model: p.model, source: p.source }); break;
    case 'UserPromptSubmit': case 'BeforeAgent': out.push({ kind: 'status', ...base, state: 'working' }); break;
    case 'PermissionRequest': out.push({ kind: 'permission.request', ...base, tool: p.tool_name, title: toolTitle(p.tool_input), input: p.tool_input }); break;
    case 'Notification':
      if (p.notification_type === 'permission_prompt' || p.notification_type === 'ToolPermission') {
        // Gemini's ToolPermission carries its confirmation details: {type:'exec', rootCommand,…}
        // or {type:'edit', fileName, filePath, fileDiff,…} (gemini 0.61.0, verified by a real run).
        const d = p.details;
        if (d?.type === 'edit') out.push({ kind: 'permission.request', ...base, tool: 'Edit', title: clip(`Edit ${d.fileName || d.filePath || ''}`.trim(), 160), input: { file_path: d.filePath, diff: typeof d.fileDiff === 'string' ? clip(d.fileDiff, 4000) : undefined } });
        else out.push({ kind: 'permission.request', ...base, tool: d?.rootCommand || '', title: clip(p.message, 160), input: d });
      }
      else if (p.notification_type === 'idle_prompt') out.push({ kind: 'status', ...base, state: 'idle' });
      break;
    case 'PostToolUse': case 'AfterTool': case 'PostToolUseFailure': out.push({ kind: 'permission.resolved', ...base, outcome: 'allowed-or-not-needed', toolUseId: p.tool_use_id }); break;
    case 'agent-turn-complete': break; // codex `notify`: fallback only — fires for aux model calls too, duplicates Stop
    case 'Stop': case 'AfterAgent': out.push({ kind: 'turn.end', ...base, reason: 'done', lastText: clip(p.last_assistant_message || p.prompt_response || p['last-assistant-message'], 400) }); break;
    case 'Interrupt': out.push({ kind: 'turn.end', ...base, reason: 'interrupted' }); break;
    case 'SessionEnd': out.push({ kind: 'session.end', ...base, reason: p.reason }); break;
    case 'event': { // opencode plugin bus event
      const e: Json = p.event || {};
      const pr: Json = e.properties || {};
      if (e.type === 'permission.asked') out.push({ kind: 'permission.request', at, sessionId: pr.sessionID, requestId: pr.id, toolUseId: pr.tool?.callID, tool: pr.permission, title: clip((pr.patterns || []).join(' '), 160), input: pr.metadata });
      else if (e.type === 'permission.replied') out.push({ kind: 'permission.resolved', at, sessionId: pr.sessionID, requestId: pr.requestID, outcome: pr.reply === 'reject' ? 'denied' : 'allowed' });
      else if (e.type === 'session.status') out.push({ kind: 'status', at, sessionId: pr.sessionID, state: pr.status?.type === 'busy' ? 'working' : pr.status?.type });
      else if (e.type === 'session.idle') out.push({ kind: 'turn.end', at, sessionId: pr.sessionID, reason: 'done' });
      else if (e.type === 'message.part.updated') {
        const part: Json = pr.part || {};
        if (part.type === 'tool' && part.state?.status === 'running') out.push({ kind: 'tool.call', at, sessionId: pr.sessionID, toolUseId: part.callID, tool: part.tool, toolKind: toolKind(part.tool), title: toolTitle(part.state.input), input: part.state.input });
        else if (part.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) out.push({ kind: 'tool.result', at, sessionId: pr.sessionID, toolUseId: part.callID, ok: part.state.status === 'completed', summary: clip(part.state.title || part.state.error, 160), output: clip(part.state.output || part.state.error, 2000) });
        else if (part.type === 'text' && part.time?.end && !part.synthetic) out.push({ kind: 'assistant.text', at, sessionId: pr.sessionID, partId: part.id, text: part.text, blocks: extractRawBlocks(part.text) });
        else if (part.type === 'reasoning' && part.time?.end) out.push({ kind: 'assistant.thinking', at, sessionId: pr.sessionID, text: part.text });
      } else if (e.type === 'message.updated' && pr.info?.role === 'user') out.push({ kind: 'user.message.meta', at, sessionId: pr.sessionID, messageId: pr.info.id });
      break;
    }
    default: break;
  }
  return out.map((e) => ({ ...e, source: 'hook', cli: r.cli === 'codex-notify' ? 'codex' : r.cli }));
}

/**
 * opencode user prompts: the text part of a USER message carries no `time.end`,
 * so spoolRecord (golden-compatible) does not surface it. The reducer calls this
 * with the user message ids it learned from `user.message.meta`.
 */
export function opencodeUserText(r: SpoolRecord, userMessageIds: Set<string>): { sessionId: string; messageId: string; partId: string; text: string } | null {
  const p = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Json;
  if (p.hook_event_name !== 'event' || p.event?.type !== 'message.part.updated') return null;
  const part: Json = p.event.properties?.part || {};
  if (part.type !== 'text' || part.synthetic || !userMessageIds.has(part.messageID)) return null;
  if (typeof part.text !== 'string' || !part.text.trim()) return null;
  return { sessionId: p.event.properties.sessionID, messageId: part.messageID, partId: part.id, text: part.text };
}

/** The session id a spool record belongs to (§5.3). */
export function spoolSessionId(r: SpoolRecord): string | undefined {
  const p = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Json;
  return p.session_id ?? p['thread-id'] ?? p.event?.properties?.sessionID ?? p.event?.properties?.info?.sessionID ?? p.event?.properties?.part?.sessionID;
}
