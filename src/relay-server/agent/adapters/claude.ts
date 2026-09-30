/*
 * Claude Code transcript adapter (§4.1):
 * ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl, one content block per line.
 */
import { extractRawBlocks } from '../blocks';
import { clip, toolKind, toolTitle, type Json, type RawAgentEvent } from './common';

export function claudeLine(o: Json): RawAgentEvent[] {
  const at = o.timestamp;
  const out: RawAgentEvent[] = [];
  const content = o.message?.content;
  if (o.type === 'user' && !o.isMeta) {
    if (typeof content === 'string') out.push({ kind: 'user.message', at, text: content });
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_result') {
          const txt = typeof b.content === 'string' ? b.content : (b.content || []).map((c: Json) => c.text || '').join('');
          const rejected = /doesn't want to proceed|rejected/.test(txt) && b.is_error;
          out.push({ kind: 'tool.result', at, toolUseId: b.tool_use_id, ok: !b.is_error, denied: rejected || undefined, summary: clip(txt.split('\n')[0], 160), output: clip(txt, 2000) });
        } else if (b.type === 'text' && /^\[Request interrupted/.test(b.text)) out.push({ kind: 'turn.end', at, reason: 'interrupted' });
        else if (b.type === 'text' && !b.text.startsWith('<')) out.push({ kind: 'user.message', at, text: b.text });
      }
    }
  } else if (o.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push({ kind: 'assistant.thinking', at, text: b.thinking || '' });
      else if (b.type === 'text' && b.text.trim()) out.push({ kind: 'assistant.text', at, text: b.text, blocks: extractRawBlocks(b.text), final: o.message.stop_reason === 'end_turn' });
      else if (b.type === 'tool_use') out.push({ kind: 'tool.call', at, toolUseId: b.id, tool: b.name, toolKind: toolKind(b.name), title: toolTitle(b.input), input: b.input });
    }
  } else if (o.type === 'system' && o.subtype === 'turn_duration') out.push({ kind: 'turn.end', at, reason: 'done', durationMs: o.durationMs });
  else if (o.type === 'system' && o.level === 'error') out.push({ kind: 'error', at, message: clip(o.content || o.subtype) });
  return out;
}


/** Title for the session summary (`ai-title` line). */
export function claudeTitle(o: Json): string | undefined {
  if (o.type === 'ai-title' && typeof o.title === 'string') return o.title;
  if (o.type === 'summary' && typeof o.summary === 'string') return o.summary;
  return undefined;
}
