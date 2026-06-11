// =============================================================================
// File: src/relay-server/ai-stream.ts
//
// Incremental parser for `claude --output-format stream-json` (NDJSON). Feeds
// SHORT human-readable progress lines to a callback as events arrive (assistant
// text snippets, tool uses) and captures the terminal "result" event (final
// text + session_id) for the route's response. Pure logic — no process I/O.
// =============================================================================

export interface ClaudeStreamResult {
  /** Final assistant text from the terminal `result` event (undefined until seen). */
  text?: string;
  /** Resumable session id from the stream (init or result event). */
  sessionId?: string;
}

export interface ClaudeStreamParser {
  /** Feed a raw stdout chunk; complete NDJSON lines are parsed as they close. */
  feed(chunk: string): void;
  /** Parse any trailing partial line (call once after the process exits). */
  flush(): void;
  result: ClaudeStreamResult;
}

const SNIPPET_LEN = 120;
const TOOL_SUMMARY_LEN = 80;

function snippet(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** One-line summary of a tool_use input: the most identifying field. */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return snippet(v, TOOL_SUMMARY_LEN);
  }
  return '';
}

type StreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
};

export function createClaudeStreamParser(onLine: (line: string) => void): ClaudeStreamParser {
  const result: ClaudeStreamResult = {};
  let buffer = '';

  function handleEvent(event: StreamEvent): void {
    if (event.session_id && !result.sessionId) result.sessionId = event.session_id;
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') onLine('[claude] agent session started');
        break;
      case 'assistant': {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            onLine(snippet(block.text, SNIPPET_LEN));
          } else if (block.type === 'tool_use' && block.name) {
            const summary = summarizeToolInput(block.input);
            onLine(summary ? `→ ${block.name} ${summary}` : `→ ${block.name}`);
          }
        }
        break;
      }
      case 'result': {
        result.text = typeof event.result === 'string' ? event.result : String(event.result ?? '');
        if (event.session_id) result.sessionId = event.session_id;
        onLine(event.is_error ? '[claude] finished with an error' : '[claude] result received');
        break;
      }
      default:
        break;   // tool results / other event types are too noisy for progress
    }
  }

  function parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { handleEvent(JSON.parse(trimmed) as StreamEvent); } catch { /* non-JSON noise — skip */ }
  }

  return {
    feed(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        parseLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer.trim()) parseLine(buffer);
      buffer = '';
    },
    result,
  };
}
