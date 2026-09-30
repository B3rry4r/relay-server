/*
 * Gemini CLI chat adapter (§4.3): ~/.gemini/tmp/<projectId>/chats/session-*.jsonl.
 * Records are UPSERTS keyed by id (a gemini message is re-emitted when its
 * toolCalls change) plus {$set:{…}} patches; {$set:{messages}} is a history
 * rewrite. The Agent view is append-only: rewrites are ignored, records upsert.
 */
import { extractRawBlocks } from '../blocks';
import { clip, toolKind, toolTitle, type Json, type RawAgentEvent } from './common';

export function geminiReduce(lines: Json[]): { meta: Json | null; messages: Json[] } {
  const byId = new Map<string, Json>();
  let meta: Json | null = null;
  for (const o of lines) {
    if (o.$set) continue;
    if (!o.type && o.sessionId) { meta = o; continue; }
    if (o.id) byId.set(o.id, o);
  }
  return { meta, messages: [...byId.values()] };
}

/** Classify one line of the chat file for the live tailer. */
export function geminiLineKind(o: Json): 'meta' | 'patch' | 'record' | 'other' {
  if (o && o.$set) return 'patch';
  if (o && !o.type && o.sessionId) return 'meta';
  if (o && o.id) return 'record';
  return 'other';
}

/**
 * One message record → raw events. Each event also carries `partKey`, a stable
 * key within the record (thinking:<i> | text | call:<id> | result:<id> | user |
 * end | error) so a re-emitted record maps to the SAME event ids and only the new
 * parts surface.
 */
export function geminiMessage(m: Json): RawAgentEvent[] {
  return geminiMessageKeyed(m).map(({ partKey: _k, ...e }) => e);
}

export function geminiMessageKeyed(m: Json): Array<RawAgentEvent & { partKey: string }> {
  const at = m.timestamp;
  const out: Array<RawAgentEvent & { partKey: string }> = [];
  const text = typeof m.content === 'string' ? m.content : (m.content || []).map((c: Json) => c.text || '').join('');
  if (m.type === 'user') {
    if (text && !text.startsWith('<')) out.push({ partKey: 'user', kind: 'user.message', at, text });
  } else if (m.type === 'gemini' && Array.isArray(m.content)) {
    // live gemini records carry STRING content; Part[] content only appears in the
    // history-restore burst written after a cancelled turn (observed 0.61.0) — skip.
  } else if (m.type === 'gemini') {
    (m.thoughts || []).forEach((t: Json, i: number) => {
      out.push({ partKey: `thinking:${i}`, kind: 'assistant.thinking', at: t.timestamp || at, text: [t.subject, t.description].filter(Boolean).join(': ') });
    });
    if (text.trim()) out.push({ partKey: 'text', kind: 'assistant.text', at, text, blocks: extractRawBlocks(text) });
    for (const tc of m.toolCalls || []) {
      out.push({ partKey: `call:${tc.id}`, kind: 'tool.call', at, toolUseId: tc.id, tool: tc.name, toolKind: toolKind(tc.name), title: toolTitle(tc.args), input: tc.args });
      if (['success', 'error', 'cancelled'].includes(tc.status)) {
        out.push({ partKey: `result:${tc.id}`, kind: 'tool.result', at: tc.timestamp || at, toolUseId: tc.id, ok: tc.status === 'success', denied: tc.status === 'cancelled' || undefined, summary: tc.status });
      }
    }
  } else if (m.type === 'info' && /cancelled/i.test(text)) out.push({ partKey: 'end', kind: 'turn.end', at, reason: 'interrupted' });
  else if (m.type === 'error') out.push({ partKey: 'error', kind: 'error', at, message: clip(text) });
  return out;
}
