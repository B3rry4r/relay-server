/*
 * Codex rollout adapter (§4.2):
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<threadId>.jsonl
 */
import { extractRawBlocks } from '../blocks';
import { clip, toolKind, toolTitle, type Json, type RawAgentEvent } from './common';

export function codexLine(o: Json): RawAgentEvent[] {
  const at = o.timestamp;
  const p: Json = o.payload || {};
  const out: RawAgentEvent[] = [];
  if (o.type === 'session_meta') out.push({ kind: 'session.start', at, sessionId: p.id || p.session_id, cwd: p.cwd, source: p.source, cliVersion: p.cli_version });
  else if (o.type === 'event_msg') {
    if (p.type === 'task_started') out.push({ kind: 'status', at, state: 'working', turnId: p.turn_id });
    else if (p.type === 'task_complete') out.push({ kind: 'turn.end', at, reason: 'done', durationMs: p.duration_ms, turnId: p.turn_id });
    else if (p.type === 'turn_aborted') out.push({ kind: 'turn.end', at, reason: 'interrupted', turnId: p.turn_id });
    else if (p.type === 'error') out.push({ kind: 'error', at, message: clip(p.message) });
    // item_completed duplicates response_item content in a structured form; the
    // adapter uses response_item as the single source to avoid double cards.
  } else if (o.type === 'response_item') {
    if (p.type === 'message' && p.role === 'user') {
      const txt = (p.content || []).map((c: Json) => c.text || '').join('');
      if (!txt.startsWith('<') && !txt.startsWith('# AGENTS.md')) out.push({ kind: 'user.message', at, text: txt });
    } else if (p.type === 'message' && p.role === 'assistant') {
      const txt = (p.content || []).map((c: Json) => c.text || '').join('');
      if (txt.trim()) out.push({ kind: 'assistant.text', at, text: txt, blocks: extractRawBlocks(txt) });
    } else if (p.type === 'reasoning') out.push({ kind: 'assistant.thinking', at, text: (p.summary || []).map((s: Json) => s.text).join('\n') });
    else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input: unknown = p.arguments ?? p.input ?? p.action;
      try { if (typeof input === 'string') input = JSON.parse(input); } catch { /* keep string */ }
      const tool = p.name === 'exec_command' || p.type === 'local_shell_call' ? 'shell' : p.name;
      out.push({ kind: 'tool.call', at, toolUseId: p.call_id, tool: p.name || p.type, toolKind: toolKind(tool), title: toolTitle(input), input });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const txt = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      const code = /Process exited with code (\d+)/.exec(txt);
      out.push({
        kind: 'tool.result', at, toolUseId: p.call_id,
        ok: code ? code[1] === '0' : !/rejected|denied|aborted/i.test(txt),
        exitCode: code ? Number(code[1]) : undefined,
        summary: clip(txt.split('\n').find((l: string) => l.startsWith('Output:')) || txt.split('\n')[0], 160),
        output: clip(txt, 2000),
      });
    }
  }
  return out;
}
