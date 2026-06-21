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
  /**
   * RFC v2 §0.1 — the terminal `result` event's `is_error` flag (and/or an error
   * subtype like `error_max_turns` / `error_during_execution`). A claude result
   * can carry NON-EMPTY text and still be an error (rate-limit, API failure,
   * max-turns); that text must NOT be treated as a clean success. `runModel`
   * reads this and signals failure for the turn so the observability layer logs
   * `status=error` and `requireModel` throws instead of accepting the error text.
   */
  isError?: boolean;
  /** The result subtype when present (e.g. 'success', 'error_max_turns'). */
  resultSubtype?: string;
  /**
   * RFC v2 §0.2 — real token usage from the result event when the CLI reports it
   * (`usage.input_tokens` + `usage.output_tokens`). Used for the `[ai:…] tokens≈N`
   * line instead of the chars/4 estimate; undefined when the CLI omits usage.
   */
  tokens?: number;
}

export interface ClaudeStreamParser {
  /** Feed a raw stdout chunk; complete NDJSON lines are parsed as they close. */
  feed(chunk: string): void;
  /** Parse any trailing partial line (call once after the process exits). */
  flush(): void;
  result: ClaudeStreamResult;
}

// Generous caps so the UI can show the FULL line on tap (the client clamps long
// lines to 3 rows and expands on click). These used to be 120/80, which threw
// away the rest server-side — so "expand" had nothing to reveal. Kept bounded so
// a pathological huge tool arg can't bloat the in-memory log / WS broadcast.
const SNIPPET_LEN = 6000;
const TOOL_SUMMARY_LEN = 2000;

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
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
};

/** Sum input+output tokens from a result event's usage block, if present. */
function usageTokens(usage: StreamEvent['usage']): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const inTok = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outTok = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const total = inTok + outTok;
  return total > 0 ? total : undefined;
}

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
        // RFC v2 §0.1: capture the error signal. `is_error:true` OR an error-flavoured
        // subtype (claude emits `error_max_turns`, `error_during_execution`) means the
        // turn FAILED even when `result` text is non-empty. Surface it so runModel can
        // reject it rather than returning the error string as a clean success.
        result.resultSubtype = event.subtype;
        result.isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'));
        const tk = usageTokens(event.usage);
        if (tk !== undefined) result.tokens = tk;
        onLine(result.isError ? '[claude] finished with an error' : '[claude] result received');
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
