#!/usr/bin/env node
// fake-claude: a deterministic stand-in for `claude` used by the Agent-view E2E
// (test/agent/e2e.real-pty.test.ts). Derived from the research prototype
// cli-research/fake-agent.mjs. Behaves like Claude Code 2.1.x from the tracker's
// point of view:
//   * writes a real-format transcript to ~/.claude/projects/<sanitized cwd>/<sid>.jsonl (append, live)
//   * runs the hook commands configured in ~/.claude/settings.json with real-shape stdin JSON
//     (through `/bin/sh -c`, like Claude, so the hook's parent is a transient wrapper)
//   * draws a TUI-ish screen (alt-screen, box drawing, "Do you want to proceed?" dialog)
//   * waits for the real permission keys: "1"/"2"/Enter (allow) or Esc (deny)
// Test-only additions:
//   FAKE_AGENT_KEYLOG=<file>          append every key chunk it reads (JSON line) — proves what was typed
//   FAKE_AGENT_DIALOG_DELAY_MS=<ms>   fire the PermissionRequest hook, then wait before drawing the dialog
//   after an allowed turn it reads one line (a relay-choices answer) and prints CHOSE:<line>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const prompt = process.argv[2] || 'create the demo file';
const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const cwd = process.cwd();
const sid = randomUUID();
const projDir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const transcript = path.join(projDir, `${sid}.jsonl`);
const keylog = process.env.FAKE_AGENT_KEYLOG || '';
const dialogDelay = Number(process.env.FAKE_AGENT_DIALOG_DELAY_MS) || 0;
fs.mkdirSync(projDir, { recursive: true });
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); } catch { /* none */ }

const now = () => new Date().toISOString();
let parent = null;
const line = (o) => { const u = randomUUID(); fs.appendFileSync(transcript, JSON.stringify({ parentUuid: parent, isSidechain: false, ...o, uuid: u, timestamp: now(), cwd, sessionId: sid, version: 'fake-2.1.284' }) + '\n'); parent = u; };
const hook = (event, extra = {}) => {
  for (const group of settings.hooks?.[event] || []) for (const h of group.hooks || []) {
    if (h.type !== 'command') continue;
    spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd, permission_mode: 'default', hook_event_name: event, ...extra }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
  }
};
const w = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one queue of typed characters (a chunk may carry several keys, e.g. "2\r")
const queue = [];
let wake = null;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (keylog) fs.appendFileSync(keylog, JSON.stringify(s) + '\n');
  if (s === '\x1b') queue.push('\x1b'); else queue.push(...s);
  if (wake) { const f = wake; wake = null; f(); }
});
const key = async () => { while (!queue.length) await new Promise((r) => { wake = r; }); return queue.shift(); };
const readLine = async () => { let out = ''; for (;;) { const k = await key(); if (k === '\r' || k === '\n') return out; out += k; } };

w('\x1b[?1049h\x1b[2J\x1b[H\x1b[38;5;174m ▐▛███▜▌\x1b[0m  \x1b[1mClaude Code\x1b[0m (fake) \r\n\r\n');
hook('SessionStart', { source: 'startup', model: 'fake-model' });
w(`\x1b[2m❯\x1b[0m ${prompt}\r\n\r\n`);
hook('UserPromptSubmit', { prompt });
line({ type: 'user', message: { role: 'user', content: prompt }, permissionMode: 'default' });
await sleep(300);
w('  \x1b[2m✻ Thinking… (esc to interrupt)\x1b[0m\r\n'); line({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'thinking', thinking: 'Plan: create the file with touch.', signature: 'x' }], stop_reason: 'tool_use' } });
await sleep(300);
w("\x1b[38;5;255m●\x1b[0m I'll create the file.\r\n\r\n"); line({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'text', text: "I'll create the file." }], stop_reason: 'tool_use' } });
const toolUseId = 'toolu_fake_' + Date.now();
const input = { command: 'touch relay-demo.txt', description: 'Create a demo file' };
line({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }], stop_reason: 'tool_use' } });
hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId });
hook('PermissionRequest', { tool_name: 'Bash', tool_input: input });
if (dialogDelay) await sleep(dialogDelay);
w('\x1b[38;5;244m' + '─'.repeat(60) + '\x1b[0m\r\n Bash command\r\n\r\n   touch relay-demo.txt\r\n   Create a demo file\r\n\r\n Do you want to proceed?\r\n \x1b[36m❯ 1. Yes\x1b[0m\r\n   2. Yes, and don\'t ask again for touch commands\r\n   3. No\r\n\r\n Esc to cancel\r\n');
let k = '';
while (!['1', '2', '3', '\r', '\x1b'].includes(k)) k = await key();
const allowed = k === '1' || k === '2' || k === '\r';
// the dialog goes away (a real TUI redraws the region)
w('\x1b[2J\x1b[H');
if (allowed) {
  fs.writeFileSync(path.join(cwd, 'relay-demo.txt'), '');
  line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: '(Bash completed with no output)', is_error: false }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false } });
  hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: { stdout: '', stderr: '' }, tool_use_id: toolUseId });
  const text = 'Created the file.\n\n```relay-summary\ntitle: Created demo file\n- ran `touch relay-demo.txt`\n```\n\n```relay-choices\nquestion: What next?\n1. Run the tests\n2. Commit the change\n```';
  w('● Created the file.\r\n\r\n  relay-summary\r\n  title: Created demo file\r\n\r\n  What next?\r\n  1. Run the tests\r\n  2. Commit the change\r\n\r\n❯ ');
  line({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  hook('Stop', { stop_hook_active: false, last_assistant_message: text });
  line({ type: 'system', subtype: 'turn_duration', durationMs: 1200 });
  const answer = await readLine();
  w(`\r\nCHOSE:${answer}\r\n`);
  line({ type: 'user', message: { role: 'user', content: answer }, permissionMode: 'default' });
} else {
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: "The user doesn't want to proceed with this tool use. The tool use was rejected", is_error: true, tool_use_id: toolUseId }] }, toolUseResult: 'User rejected tool use' });
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  w('\r\n  \x1b[2mInterrupted · What should Claude do instead?\x1b[0m\r\n');
}
await sleep(200);
hook('SessionEnd', { reason: 'prompt_input_exit' });
w('\x1b[?1049l');
w('\r\nFAKE_AGENT_EXIT\r\n');
process.exit(0);
