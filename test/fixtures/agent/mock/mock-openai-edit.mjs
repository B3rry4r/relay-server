// Minimal scripted OpenAI Responses API (+ chat/completions) mock so the REAL
// codex / opencode CLIs can run a full interactive turn offline. Research only.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 18081);
const logPath = process.argv[3] || 'mock-openai.log';
const CMD = process.env.MOCK_CMD || 'touch relay-demo.txt';
const log = (o) => fs.appendFileSync(logPath, JSON.stringify(o) + '\n');
let seq = 0;
const FINAL = 'Edited the file.\n\n```relay-summary\ntitle: Created demo file\n- ran `touch relay-demo.txt`\n```';

function shellArgs(tools) {
  for (const t of tools || []) {
    const name = t.name || t.function?.name;
    const props = (t.parameters || t.function?.parameters || {}).properties || {};
    if (!name) continue;
    if (/^(shell|shell_command|exec_command|local_shell|bash)$/.test(name)) {
      if (props.command?.type === 'array') return { name, args: { command: ['bash', '-lc', CMD], ...(props.sandbox_permissions ? { sandbox_permissions: 'require_escalated', justification: 'Create the demo file?' } : {}) } };
      const esc = props.sandbox_permissions ? { sandbox_permissions: 'require_escalated', justification: 'Create the demo file?' } : {};
      if (props.cmd) return { name, args: { cmd: CMD, ...esc } };
      if (props.command) return { name, args: { command: CMD, ...esc, ...(props.description ? { description: 'Create a demo file' } : {}) } };
    }
  }
  return null;
}

// Responses API: count function_call_output since the last user message.
function responsesPlan(body) {
  let n = 0;
  for (const it of body.input || []) {
    if (it.type === 'message' && it.role === 'user') {
      const txt = (it.content || []).map((c) => c.text || '').join('');
      if (!txt.startsWith('<')) n = 0; // skip injected <environment_context>/<user_instructions>
    }
    if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') n++;
  }
  // EDIT script: one apply_patch call, then the final message.
  const PATCH = '*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello world\n+hello relay\n*** End Patch\n';
  const ap = (body.tools || []).find((t) => (t.name || t.function?.name) === 'apply_patch');
  if (n === 0 && ap) return ap.type === 'custom' ? { custom: { name: 'apply_patch', input: PATCH } } : { tool: { name: 'apply_patch', args: { input: PATCH } } };
  // No apply_patch tool for this model family: codex intercepts apply_patch sent
  // through its shell tool and turns it into a patch approval.
  const ex = (body.tools || []).find((t) => /^(exec_command|shell|shell_command)$/.test(t.name || t.function?.name || ''));
  if (n === 0 && ex) {
    const name = ex.name || ex.function?.name;
    const props = (ex.parameters || ex.function?.parameters || {}).properties || {};
    const script = "apply_patch <<'EOF'\n" + PATCH + "EOF\n";
    if (props.cmd) return { tool: { name, args: { cmd: script } } };
    return { tool: { name, args: { command: props.command?.type === 'array' ? ['bash', '-lc', script] : script } } };
  }
  return { final: true };
}

function sseResponses(res, body, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = 'resp_mock_' + (++seq);
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('response.created', { response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] } });
  const out = [];
  let idx = 0;
  const item = (it) => {
    ev('response.output_item.added', { output_index: idx, item: { ...it, ...(it.type === 'message' ? { content: [] } : {}) } });
    if (it.type === 'message') {
      ev('response.content_part.added', { item_id: it.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '' } });
      ev('response.output_text.delta', { item_id: it.id, output_index: idx, content_index: 0, delta: it.content[0].text });
      ev('response.output_text.done', { item_id: it.id, output_index: idx, content_index: 0, text: it.content[0].text });
    }
    if (it.type === 'reasoning') {
      ev('response.reasoning_summary_text.delta', { item_id: it.id, output_index: idx, summary_index: 0, delta: it.summary[0].text });
    }
    ev('response.output_item.done', { output_index: idx, item: it });
    out.push(it); idx++;
  };
  if (plan.custom) {
    item({ type: 'message', id: 'msg_a_' + seq, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I'll make the edit.", annotations: [] }] });
    item({ type: 'custom_tool_call', id: 'ctc_' + seq, call_id: 'call_mock_' + seq, name: plan.custom.name, input: plan.custom.input, status: 'completed' });
  } else if (plan.tool) {
    item({ type: 'reasoning', id: 'rs_' + seq, summary: [{ type: 'summary_text', text: '**Planning file creation**\n\nI will create the demo file.' }] });
    item({ type: 'message', id: 'msg_a_' + seq, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I'll create the file.", annotations: [] }] });
    item({ type: 'function_call', id: 'fc_' + seq, call_id: 'call_mock_' + seq, name: plan.tool.name, arguments: JSON.stringify(plan.tool.args), status: 'completed' });
  } else {
    item({ type: 'message', id: 'msg_b_' + seq, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FINAL, annotations: [] }] });
  }
  ev('response.completed', { response: { id, object: 'response', status: 'completed', model: body.model, output: out, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 } } });
  res.end();
}

// Chat Completions (used by opencode's openai-compatible provider).
function chatPlan(body) {
  let n = 0;
  for (const m of body.messages || []) {
    if (m.role === 'user') n = 0;
    if (m.role === 'tool') n++;
  }
  const tools = (body.tools || []).map((t) => ({ name: t.function?.name, parameters: t.function?.parameters }));
  const sh = shellArgs(tools);
  if (n === 0 && sh) return { tool: sh };
  return { final: true };
}
function sseChat(res, body, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = 'chatcmpl_' + (++seq);
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' });
  if (plan.tool) {
    chunk({ reasoning_content: 'I will create the demo file.' });
    chunk({ content: "I'll create the file." });
    chunk({ tool_calls: [{ index: 0, id: 'call_mock_' + seq, type: 'function', function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) } }] });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: FINAL });
    chunk({}, 'stop');
  }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    const toolNames = (body.tools || []).map((t) => t.name || t.function?.name || t.type);
    log({ t: new Date().toISOString(), method: req.method, url: req.url, model: body.model, stream: body.stream, toolNames, shellTool: (body.tools||[]).filter((t)=>/shell|exec|bash/.test(t.name||t.function?.name||'')).map((t)=>({name:t.name||t.function?.name, props:Object.keys((t.parameters||t.function?.parameters||{}).properties||{})})), instr: typeof body.instructions==='string'? body.instructions.slice(0,80):undefined, inputHasGuide: JSON.stringify(body.input||body.messages||'').includes('RELAY-GUIDE') });
    if (req.url.includes('/responses') && req.method === 'POST') return sseResponses(res, body, responsesPlan(body));
    if (req.url.includes('/chat/completions') && req.method === 'POST') return sseChat(res, body, chatPlan(body));
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }], models: [] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => log({ listening: port }));
