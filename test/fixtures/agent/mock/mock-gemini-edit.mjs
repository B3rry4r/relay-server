// Minimal scripted Gemini API (generativelanguage v1beta) mock so the REAL
// gemini CLI can run a full interactive turn offline. Research only.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 18082);
const logPath = process.argv[3] || 'mock-gemini.log';
const CMD = process.env.MOCK_CMD || 'touch relay-demo.txt';
const log = (o) => fs.appendFileSync(logPath, JSON.stringify(o) + '\n');
const FINAL = 'Edited the file.\n\n```relay-summary\ntitle: Created demo file\n- ran `touch relay-demo.txt`\n```';

function plan(body) {
  let n = 0;
  for (const c of body.contents || []) {
    const parts = c.parts || [];
    if (c.role === 'user' && parts.some((p) => typeof p.text === 'string') && !parts.some((p) => p.functionResponse)) n = 0;
    n += parts.filter((p) => p.functionResponse).length;
  }
  const decls = (body.tools || []).flatMap((t) => t.functionDeclarations || []).map((d) => d.name);
  if (n === 0 && decls.includes('replace')) return { tool: true, decls };
  return { final: true, decls };
}

function candidate(parts, finishReason) {
  return { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    const p = plan(body);
    const json = body.generationConfig?.responseMimeType === 'application/json' || !!body.generationConfig?.responseJsonSchema || !!body.generationConfig?.responseSchema;
    log({ t: new Date().toISOString(), method: req.method, url: req.url, json, decls: p.decls.slice(0, 40), sysHasGuide: JSON.stringify(body.systemInstruction || '').includes('RELAY-GUIDE') || JSON.stringify(body.contents || '').includes('RELAY-GUIDE') });
    if (req.url.includes(':countTokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"totalTokens":100}'); }
    if (json) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(candidate([{ text: JSON.stringify({ reasoning: 'mock', next_speaker: 'user', complexity_reasoning: 'mock', complexity_score: 1, model_choice: 'flash', decision: 'user' }) }], 'STOP')));
    }
    const parts = p.tool
      ? [[{ text: 'I will create the demo file.', thought: true }], [{ text: "I'll make the edit." }], [{ functionCall: { name: 'replace', args: { file_path: process.env.MOCK_EDIT_FILE, old_string: 'hello world', new_string: 'hello relay', instruction: 'Change world to relay in the greeting.' } } }]]
      : [[{ text: FINAL }]];
    if (req.url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      parts.forEach((ps, i) => res.write(`data: ${JSON.stringify(candidate(ps, i === parts.length - 1 ? 'STOP' : undefined))}\r\n\r\n`));
      return res.end();
    }
    if (req.url.includes(':generateContent')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(candidate(parts.flat(), 'STOP')));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => log({ listening: port }));
