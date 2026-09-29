#!/usr/bin/env node
// Relay Agent view installer (agent-display-spec §10). Idempotently installs the
// Relay agent guide + event hooks into every CLI's GLOBAL config under --home:
//
//   node scripts/relay-agent-install.mjs --home <HOME> --guide <guide.md> \
//        --hook <abs path to relay-agent-hook> [--plugin <opencode plugin.js>]
//
// Rules (§10.3):
//  - Markdown instruction files get a MARKED block (replaced in place, else
//    appended); everything outside the markers is preserved byte-for-byte.
//  - JSON hook configs: user handlers are untouched; Relay handlers are the ones
//    whose command contains `relay-agent-hook` (stale ones are replaced, so a
//    changed hook path never duplicates). INVALID JSON IS LEFT UNTOUCHED.
//  - Codex config.toml: line-based upsert of [features] hooks = true and
//    daemon_auto_start = false (hooks must run inside the PTY's process tree).
//  - Every write is atomic (tmp + rename) and skipped when content is identical.
//  - RELAY_AGENT_GUIDE=off removes the guide block instead (hooks stay).
//
// Exit status: 0 = everything installed/unchanged, 3 = partial (a file was
// skipped, e.g. invalid JSON), 1 = failure. Never prints secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- relay:agent-guide:begin (managed by Relay — edits inside this block are overwritten) -->';
export const END = '<!-- relay:agent-guide:end -->';
const BEGIN_PREFIX = '<!-- relay:agent-guide:begin';

/** Replace the marked block, or append it after a blank line. */
export function upsertMarkedBlock(existing, body) {
  const block = `${BEGIN}\n${body}\n${END}`;
  const s = existing ?? '';
  const b = s.indexOf(BEGIN_PREFIX);
  const bEnd = b === -1 ? -1 : s.indexOf('-->', b);
  const e = s.indexOf(END, b === -1 ? 0 : b);
  if (b !== -1 && bEnd !== -1 && e !== -1 && e > b) return s.slice(0, b) + block + s.slice(e + END.length);
  if (!s.trim()) return `${block}\n`;
  return `${s.replace(/\n*$/, '\n\n')}${block}\n`;
}

/** Remove the marked block (RELAY_AGENT_GUIDE=off). */
export function removeMarkedBlock(existing) {
  const s = existing ?? '';
  const b = s.indexOf(BEGIN_PREFIX);
  const e = s.indexOf(END, b === -1 ? 0 : b);
  if (b === -1 || e === -1 || e < b) return s;
  const before = s.slice(0, b).replace(/\n+$/, '\n');
  const after = s.slice(e + END.length).replace(/^\n+/, '');
  const joined = `${before}${after}`;
  return joined.trim() ? joined : '';
}

const isRelay = (h) => typeof h?.command === 'string' && h.command.includes('relay-agent-hook');

/** Merge Relay's handlers into a Claude-style {hooks:{Event:[{matcher,hooks:[…]}]}} object. */
export function mergeHooks(json, events, command, extra = {}) {
  const out = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  out.hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? out.hooks : {};
  for (const [event, matcher] of Object.entries(events)) {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    // drop stale Relay handlers (old path/args), keep every user handler untouched
    const cleaned = groups
      .map((g) => (g && typeof g === 'object' && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isRelay(h)) } : g))
      .filter((g) => !(g && typeof g === 'object' && Array.isArray(g.hooks) && g.hooks.length === 0));
    const group = { hooks: [{ type: 'command', command, timeout: 10, ...extra }] };
    if (matcher !== null) group.matcher = matcher;
    cleaned.push(group);
    out.hooks[event] = cleaned;
  }
  return out;
}

/**
 * Minimal TOML key upsert inside a [table] — line-based, never rewrites other
 * lines. Returns null when the file uses a form we must not touch (dotted
 * `table.key =` keys or an inline table), so the caller skips instead of
 * producing a duplicate table (a hard config error in Codex).
 */
export function upsertTomlKey(src, table, key, value) {
  const text = src ?? '';
  const lines = text.split('\n');
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (lines.some((l) => new RegExp(`^\\s*${esc}\\s*(\\.|=)`).test(l))) return null;
  const headerRe = new RegExp(`^\\s*\\[\\s*${esc}\\s*\\]\\s*(#.*)?$`);
  const hdr = lines.findIndex((l) => headerRe.test(l));
  const kv = `${key} = ${value}`;
  if (hdr === -1) return `${text.replace(/\n*$/, text.trim() ? '\n\n' : '')}[${table}]\n${kv}\n`;
  let end = lines.length;
  for (let i = hdr + 1; i < lines.length; i += 1) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = hdr + 1; i < end; i += 1) {
    if (keyRe.test(lines[i])) {
      if (lines[i].trim() === kv) return text;
      lines[i] = kv;
      return lines.join('\n');
    }
  }
  lines.splice(hdr + 1, 0, kv);
  return lines.join('\n');
}

export const CLAUDE_EVENTS = { SessionStart: null, UserPromptSubmit: null, PreToolUse: '', PermissionRequest: '', PostToolUse: '', PostToolUseFailure: '', Notification: null, Stop: null, SubagentStop: null, SessionEnd: null };
export const CODEX_EVENTS = { SessionStart: null, UserPromptSubmit: null, PreToolUse: null, PermissionRequest: null, PostToolUse: null, Stop: null, Interrupt: null, SessionEnd: null };
export const GEMINI_EVENTS = { SessionStart: null, BeforeAgent: null, BeforeTool: '*', AfterTool: '*', AfterAgent: null, Notification: null, SessionEnd: null };

export function install({ home, guide, hook, plugin, guideOff = false }) {
  const report = [];
  let skipped = 0;

  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  const writeIfChanged = (file, content, mode) => {
    const prev = read(file);
    if (prev === content) { report.push(`unchanged ${file}`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.relay-tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
    report.push(`${prev === null ? 'created' : 'updated'} ${file}`);
  };
  const installGuide = (file) => {
    const prev = read(file);
    if (guideOff) {
      if (prev === null) { report.push(`absent ${file}`); return; }
      writeIfChanged(file, removeMarkedBlock(prev));
      return;
    }
    writeIfChanged(file, upsertMarkedBlock(prev, guide));
  };
  const installJsonHooks = (file, events, command, extra) => {
    const prev = read(file);
    let json = {};
    if (prev !== null && prev.trim()) {
      try { json = JSON.parse(prev); } catch { report.push(`SKIPPED ${file}: invalid JSON (left untouched)`); skipped += 1; return; }
      if (!json || typeof json !== 'object' || Array.isArray(json)) { report.push(`SKIPPED ${file}: not a JSON object (left untouched)`); skipped += 1; return; }
    }
    writeIfChanged(file, `${JSON.stringify(mergeHooks(json, events, command, extra), null, 2)}\n`);
  };

  const C = path.join(home, '.claude');
  installGuide(path.join(C, 'CLAUDE.md'));
  installJsonHooks(path.join(C, 'settings.json'), CLAUDE_EVENTS, `${hook} claude`, { async: true });

  const X = path.join(home, '.codex');
  installGuide(path.join(X, 'AGENTS.md'));
  // keep this definition STABLE across releases: Codex's hook trust hash covers the command + timeout
  installJsonHooks(path.join(X, 'hooks.json'), CODEX_EVENTS, `${hook} codex`);
  {
    const f = path.join(X, 'config.toml');
    const prev = read(f);
    let t = upsertTomlKey(prev, 'features', 'hooks', 'true');
    if (t !== null) t = upsertTomlKey(t, 'features', 'daemon_auto_start', 'false');
    if (t === null) { report.push(`SKIPPED ${f}: [features] uses dotted or inline keys (left untouched)`); skipped += 1; }
    else writeIfChanged(f, t.endsWith('\n') ? t : `${t}\n`);
  }

  const G = path.join(home, '.gemini');
  installGuide(path.join(G, 'GEMINI.md'));
  installJsonHooks(path.join(G, 'settings.json'), GEMINI_EVENTS, `${hook} gemini`, { timeout: 10000 });

  const O = path.join(home, '.config', 'opencode');
  installGuide(path.join(O, 'AGENTS.md'));
  if (plugin) writeIfChanged(path.join(O, 'plugin', 'relay-agent.js'), fs.readFileSync(plugin, 'utf8'));

  return { report, skipped };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const home = args.home || process.env.HOME;
    if (!home || !args.guide || !args.hook) throw new Error('usage: relay-agent-install.mjs --home <HOME> --guide <guide.md> --hook <relay-agent-hook> [--plugin <plugin.js>]');
    if (!path.isAbsolute(args.hook)) throw new Error('--hook must be an absolute path');
    const guide = fs.readFileSync(args.guide, 'utf8').trim();
    const guideOff = (process.env.RELAY_AGENT_GUIDE || '').trim().toLowerCase() === 'off';
    const { report, skipped } = install({ home, guide, hook: args.hook, plugin: args.plugin, guideOff });
    console.log(report.join('\n'));
    process.exit(skipped ? 3 : 0);
  } catch (error) {
    console.error(`[relay-agent-install] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
