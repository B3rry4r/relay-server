// Minimal scripted Anthropic Messages API mock (SSE + JSON) so the REAL Claude
// Code CLI can run a full interactive turn offline. Used only for format research.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 18080);
const logPath = process.argv[3] || 'mock-anthropic.log';
const log = (o) => fs.appendFileSync(logPath, JSON.stringify(o) + '\n');

function countToolResults(messages) {
  // tool_results since the last human text turn (so each new prompt restarts the script)
  let n = 0;
  for (const m of messages || []) {
    const human = m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && !String(b.text).startsWith('<')) && !m.content.some((b) => b.type === 'tool_result')));
    if (human) n = 0;
    if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') n++;
  }
  return n;
}

function plan(body) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools) return { stop: 'end_turn', blocks: [{ type: 'text', text: 'Mock title' }] };
  const n = countToolResults(body.messages);
  const file = process.env.MOCK_EDIT_FILE;
  // EDIT script: Read the file (no prompt), then Edit it (the edit prompt), then summarise.
  if (n === 0) return { stop: 'tool_use', blocks: [
    { type: 'text', text: "I'll read the file first." },
    { type: 'tool_use', id: 'toolu_mock_e001', name: 'Read', input: { file_path: file } },
  ] };
  if (n === 1) return { stop: 'tool_use', blocks: [
    { type: 'text', text: "Now I'll make the edit." },
    { type: 'tool_use', id: 'toolu_mock_e002', name: 'Edit', input: { file_path: file, old_string: 'hello world', new_string: 'hello relay' } },
  ] };
  return { stop: 'end_turn', blocks: [{ type: 'text', text: 'Edited the file.' }] };
}

function sse(res, body, p) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': 'req_mock' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  p.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: p.stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  ev('message_stop', {});
  res.end();
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    const entry = { t: new Date().toISOString(), method: req.method, url: req.url, model: body.model, stream: body.stream, tools: Array.isArray(body.tools) ? body.tools.length : 0, toolResults: countToolResults(body.messages), hasGuide: raw.includes('Relay display guide') };
    log(entry);
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const p = plan(body);
      if (body.stream) return sse(res, body, p);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: p.blocks.filter((b) => b.type !== 'thinking'), stop_reason: p.stop, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 20 } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => log({ listening: port }));
