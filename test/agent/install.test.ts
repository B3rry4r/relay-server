// Installer (agent-display-spec §10.3/§10.5): idempotent marked blocks + hook
// merges against a temp HOME, and setup-workspace.sh really installing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const INSTALLER = path.join(ROOT, 'scripts/relay-agent-install.mjs');
const GUIDE = path.join(ROOT, 'agent/RELAY-AGENT-GUIDE.md');
const PLUGIN = path.join(ROOT, 'agent/opencode-relay-agent.js');
const HOOK = '/workspace/.relay/bin/relay-agent-hook';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-install-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function run(home: string, hook = HOOK, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [INSTALLER, '--home', home, '--guide', GUIDE, '--hook', hook, '--plugin', PLUGIN], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const read = (f: string) => fs.readFileSync(f, 'utf8');
const readJson = (f: string) => JSON.parse(read(f));

/** Every file under a dir → content (byte equality across runs). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = read(p);
    }
  };
  walk(dir);
  return out;
}

const relayCommands = (json: any, event: string) => (json.hooks?.[event] ?? []).flatMap((g: any) => g.hooks ?? []).filter((h: any) => String(h.command).includes('relay-agent-hook')).map((h: any) => h.command);

describe('relay-agent-install', () => {
  it('(a) empty HOME: installs the guide into 4 instruction files, hooks into 3 configs, the opencode plugin and the codex features', () => {
    const home = tmp();
    const r = run(home);
    expect(r.status, r.err).toBe(0);
    const guide = read(GUIDE).trim();
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md']) {
      const text = read(path.join(home, f));
      expect(text.startsWith('<!-- relay:agent-guide:begin')).toBe(true);
      expect(text).toContain(guide);
      expect(text.trimEnd().endsWith('<!-- relay:agent-guide:end -->')).toBe(true);
    }
    const claude = readJson(path.join(home, '.claude/settings.json'));
    expect(relayCommands(claude, 'PermissionRequest')).toEqual([`${HOOK} claude`]);
    expect(claude.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'command', async: true });
    expect(Object.keys(claude.hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
    expect(relayCommands(readJson(path.join(home, '.codex/hooks.json')), 'Interrupt')).toEqual([`${HOOK} codex`]);
    expect(relayCommands(readJson(path.join(home, '.gemini/settings.json')), 'Notification')).toEqual([`${HOOK} gemini`]);
    expect(read(path.join(home, '.codex/config.toml'))).toBe('[features]\ndaemon_auto_start = false\nhooks = true\n');
    expect(read(path.join(home, '.config/opencode/plugin/relay-agent.js'))).toBe(read(PLUGIN));
  });

  it('(b) keeps user content and user hooks byte-for-byte; a second run is a no-op', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), '# My own rules\n\nAlways use tabs.\n');
    const userHook = { type: 'command', command: '/usr/local/bin/my-audit' };
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }] } }, null, 2));
    expect(run(home).status).toBe(0);
    const md = read(path.join(home, '.claude/CLAUDE.md'));
    expect(md.startsWith('# My own rules\n\nAlways use tabs.\n\n<!-- relay:agent-guide:begin')).toBe(true);
    // a user addition BELOW the block survives a re-run
    fs.appendFileSync(path.join(home, '.claude/CLAUDE.md'), '\n## Added later\n');
    const settings = readJson(path.join(home, '.claude/settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [userHook] });
    expect(relayCommands(settings, 'PreToolUse')).toEqual([`${HOOK} claude`]);

    const before = snapshot(home);
    const second = run(home);
    expect(second.status).toBe(0);
    expect(second.out.split('\n').filter(Boolean).every((l) => l.startsWith('unchanged '))).toBe(true);
    expect(snapshot(home)).toEqual(before);
    expect(read(path.join(home, '.claude/CLAUDE.md')).endsWith('<!-- relay:agent-guide:end -->\n\n## Added later\n')).toBe(true);
  });

  it('(c) invalid JSON is left untouched and reported (exit 3 = partial)', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const broken = '{"security": {"auth": {"selectedType": "oauth-personal"}'; // truncated
    fs.writeFileSync(path.join(home, '.gemini/settings.json'), broken);
    const r = run(home);
    expect(r.status).toBe(3);
    expect(r.out).toContain(`SKIPPED ${path.join(home, '.gemini/settings.json')}: invalid JSON`);
    expect(read(path.join(home, '.gemini/settings.json'))).toBe(broken);
    // everything else still installed
    expect(fs.existsSync(path.join(home, '.claude/settings.json'))).toBe(true);
  });

  it('(d) an existing [features] table and other tables are preserved (no duplicate table)', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const toml = 'model = "gpt-5"\n\n[features] # mine\nweb_search = true\nhooks = false\n\n[model_providers.mock]\nbase_url = "http://x"\n';
    fs.writeFileSync(path.join(home, '.codex/config.toml'), toml);
    expect(run(home).status).toBe(0);
    const out = read(path.join(home, '.codex/config.toml'));
    expect(out).toBe('model = "gpt-5"\n\n[features] # mine\ndaemon_auto_start = false\nweb_search = true\nhooks = true\n\n[model_providers.mock]\nbase_url = "http://x"\n');
    expect(out.match(/\[features\]/g)).toHaveLength(1);
    // dotted keys are a form we must not touch
    fs.writeFileSync(path.join(home, '.codex/config.toml'), 'features.hooks = true\n');
    const r = run(home);
    expect(r.status).toBe(3);
    expect(read(path.join(home, '.codex/config.toml'))).toBe('features.hooks = true\n');
  });

  it('(e) a changed hook path replaces the stale Relay handlers instead of duplicating them', () => {
    const home = tmp();
    expect(run(home, '/old/bin/relay-agent-hook').status).toBe(0);
    expect(run(home, HOOK).status).toBe(0);
    for (const [file, event, cli] of [['.claude/settings.json', 'Stop', 'claude'], ['.codex/hooks.json', 'PermissionRequest', 'codex'], ['.gemini/settings.json', 'AfterTool', 'gemini']]) {
      const json = readJson(path.join(home, file));
      expect(relayCommands(json, event)).toEqual([`${HOOK} ${cli}`]);
      expect(JSON.stringify(json)).not.toContain('/old/bin');
    }
  });

  it('RELAY_AGENT_GUIDE=off removes the guide block but keeps the hooks and the user text', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), '# Mine\n');
    run(home);
    expect(run(home, HOOK, { RELAY_AGENT_GUIDE: 'off' }).status).toBe(0);
    expect(read(path.join(home, '.claude/CLAUDE.md'))).toBe('# Mine\n');
    expect(relayCommands(readJson(path.join(home, '.claude/settings.json')), 'Stop')).toEqual([`${HOOK} claude`]);
  });
});

describe('setup-workspace.sh installs the Agent view', () => {
  const scriptPath = path.join(ROOT, 'setup-workspace.sh');
  const script = read(scriptPath);

  it('runs the installer after the Gemini selectedType block and records its status', () => {
    expect(script).toContain('scripts/relay-agent-install.mjs');
    expect(script).toContain('record_status agent_display "ready"');
    expect(script).toContain('record_status agent_display "failed"');
    expect(script.indexOf('record_status gemini_auth')).toBeGreaterThan(0);
    expect(script.indexOf('relay-agent-install.mjs')).toBeGreaterThan(script.indexOf('record_status gemini_auth'));
  });

  it('offline boot with node on PATH: hooks + guide land in the workspace, Gemini keeps selectedType, a re-run rewrites nothing', () => {
    const ws = tmp();
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: ws, WORKSPACE: ws, RELAY_SETUP_SYSTEM_IDENTITY: '0',
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
    };
    const first = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60_000, env });
    expect(first.status, first.stderr).toBe(0);
    expect(read(path.join(ws, '.bootstrap-status'))).toContain('agent_display=ready');
    const hook = path.join(ws, '.relay/bin/relay-agent-hook');
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(ws, '.relay/state/agent-events')).isDirectory()).toBe(true);
    const gemini = readJson(path.join(ws, '.gemini/settings.json'));
    expect(gemini.security.auth.selectedType).toBe('oauth-personal');
    expect(relayCommands(gemini, 'BeforeTool')).toEqual([`${hook} gemini`]);
    expect(relayCommands(readJson(path.join(ws, '.claude/settings.json')), 'SessionStart')).toEqual([`${hook} claude`]);
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md', '.config/opencode/plugin/relay-agent.js', '.codex/config.toml', '.codex/hooks.json']) {
      expect(fs.existsSync(path.join(ws, f)), f).toBe(true);
    }
    const agentFiles = ['.claude/CLAUDE.md', '.claude/settings.json', '.gemini/settings.json', '.codex/config.toml', '.relay/bin/relay-agent-hook'].map((f) => path.join(ws, f));
    const past = new Date(Date.now() - 3_600_000);
    for (const f of agentFiles) fs.utimesSync(f, past, past);
    const before = agentFiles.map((f) => fs.statSync(f).mtimeMs);
    const second = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60_000, env });
    expect(second.status, second.stderr).toBe(0);
    expect(agentFiles.map((f) => fs.statSync(f).mtimeMs)).toEqual(before);
  });
});

describe('relay-agent-hook', () => {
  it('appends one record with lineage to the terminal spool, prints nothing, exits 0 — even under a "type":"module" package', () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const hook = path.join(bin, 'relay-agent-hook');
    fs.copyFileSync(path.join(ROOT, 'agent/relay-agent-hook'), hook);
    fs.chmodSync(hook, 0o755);
    const spool = path.join(dir, 'spool');
    const big = 'x'.repeat(40_000);
    const payload = JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_input: { content: big } });
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, RELAY_TERMINAL_ID: 'abc-123', RELAY_AGENT_SPOOL: spool };
    const r = spawnSync('/bin/sh', ['-c', `${hook} claude`], { input: payload, encoding: 'utf8', env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const recs = read(path.join(spool, 'abc-123.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ v: 1, cli: 'claude', terminalId: 'abc-123', payload: { session_id: 's1', hook_event_name: 'PreToolUse' } });
    expect(recs[0].payload.tool_input.content.length).toBeLessThan(17_000);
    expect(Array.isArray(recs[0].lineage) && recs[0].lineage.length).toBeGreaterThan(0);
    // outside Relay (no terminal id) → _unattributed
    const r2 = spawnSync(hook, ['gemini'], { input: '{"session_id":"x"}', encoding: 'utf8', env: { PATH: env.PATH, RELAY_AGENT_SPOOL: spool } });
    expect(r2.status).toBe(0);
    expect(fs.existsSync(path.join(spool, '_unattributed.jsonl'))).toBe(true);
    // garbage stdin still exits 0 silently
    const r3 = spawnSync(hook, ['codex'], { input: 'not json', encoding: 'utf8', env });
    expect([r3.status, r3.stdout]).toEqual([0, '']);
  });
});
