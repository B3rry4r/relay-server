// Edit / patch prompts (agent-display-spec §8.1), pinned against screens the REAL
// CLIs drew (claude 2.1.284, codex 0.159.0, gemini 0.61.0, each driven by a
// scripted mock model — test/fixtures/agent/mock/*-edit.mjs, README "Edit
// prompts"). Every key in EDIT_KEYS was pressed at that prompt and the file on
// disk checked: 1/y → edited, 2/a → edited + "always", Esc → unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDIT_KEYS, PERMISSION_KEYS, editPermissionOptions, permissionOptions } from '../../src/relay-server/agent/keys';
import { editUnderSignature, matchesEdit, matchesPermission, promptOnScreen } from '../../src/relay-server/agent/screen';
import { isEditRequest } from '../../src/relay-server/agent/reducer';
import { promptFitsRequest } from '../../src/relay-server/agent/tracker';
import type { AgentCli } from '../../src/relay-server/agent/types';

const FIX = path.resolve(__dirname, '../fixtures/agent');
const screen = (cli: string, file: string) => fs.readFileSync(path.join(FIX, cli, file), 'utf8');
const REAL: Array<[AgentCli, string]> = [['claude', 'claude-2.1.284'], ['codex', 'codex-0.159.0'], ['gemini', 'gemini-0.61.0']];

describe('edit prompts: the real screens', () => {
  for (const [cli, ver] of REAL) {
    it(`${cli}: the edit prompt is an EDIT prompt, never a command prompt`, () => {
      const s = screen(cli, `${ver}.screen-edit-prompt.txt`);
      expect(matchesEdit(cli, s)).toBe(true);
      expect(matchesPermission(cli, s)).toBe(false);
      expect(promptOnScreen(cli, s)).toBe('edit');
      expect(editUnderSignature(cli, s)).toBe('Edit hello.txt');
    });
    it(`${cli}: after allow-once / always / Esc the prompt is gone`, () => {
      for (const after of ['allow-once', 'always', 'esc-deny']) {
        expect([after, promptOnScreen(cli, screen(cli, `${ver}.screen-edit-after-${after}.txt`))]).toEqual([after, null]);
      }
    });
  }

  it('the recorded COMMAND prompts stay command prompts', () => {
    expect(promptOnScreen('claude', screen('claude', 'claude-2.1.284.screen-permission-prompt.txt'))).toBe('command');
    expect(promptOnScreen('codex', screen('codex', 'codex-0.159.0.screen-approval-prompt.txt'))).toBe('command');
    expect(promptOnScreen('gemini', screen('gemini', 'gemini-0.61.0.screen-permission-prompt.txt'))).toBe('command');
  });

  it('a claude edit prompt whose cursor moved off "1. Yes" is not answerable (the digit would not mean Yes)', () => {
    const moved = screen('claude', 'claude-2.1.284.screen-edit-prompt.txt').replace('❯ 1. Yes', '  1. Yes');
    expect(promptOnScreen('claude', moved)).toBeNull();
  });
});

describe('edit prompts: keys and card options', () => {
  it('EDIT_KEYS is the verified table (deny is Esc everywhere; opencode has no edit prompt)', () => {
    expect(EDIT_KEYS).toEqual({
      claude: { allow_once: ['1'], allow_always: ['2'], deny: ['\x1b'] },
      codex: { allow_once: ['y'], allow_always: ['a'], deny: ['\x1b'] },
      gemini: { allow_once: ['1'], allow_always: ['2'], deny: ['\x1b'] },
    });
    // Codex's command "always" is `p`; its edit "always" is `a` — the kinds must never be mixed up.
    expect(PERMISSION_KEYS.codex.allow_always).toEqual(['p']);
  });

  it('the edit card says what "Always" does for that CLI, and still needs a second tap', () => {
    for (const cli of ['claude', 'codex', 'gemini'] as const) {
      const opts = editPermissionOptions(cli);
      expect(opts.map((o) => o.id)).toEqual(['allow_once', 'allow_always', 'deny']);
      expect(opts[1].confirm).toBe(true);
      expect(opts[1].detail).not.toEqual(permissionOptions(cli)[1].detail);
    }
    expect(editPermissionOptions('claude')[1].detail).toMatch(/accept-edits/);
    expect(editPermissionOptions('gemini')[1].detail).toMatch(/auto-accept edits/);
    expect(editPermissionOptions('codex')[1].detail).toMatch(/these files/);
    expect(editPermissionOptions('opencode')).toEqual(permissionOptions('opencode'));
  });

  it('isEditRequest: edit tools, and Codex apply_patch sent through its shell tool', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'replace', 'write_file', 'apply_patch']) expect([tool, isEditRequest(tool, {})]).toEqual([tool, true]);
    expect(isEditRequest('exec_command', { cmd: "apply_patch <<'EOF'\n*** Begin Patch\nEOF" })).toBe(true);
    expect(isEditRequest('shell', { command: ['bash', '-lc', "apply_patch <<'EOF'\nx\nEOF"] })).toBe(true);
    expect(isEditRequest('Bash', { command: 'touch relay-demo.txt' })).toBe(false);
    expect(isEditRequest('Bash', { command: 'echo apply_patching' })).toBe(false);
    expect(isEditRequest('Read', { file_path: 'x' })).toBe(false);
  });

  it('promptFitsRequest: an edit card never answers a command prompt, nor a command card an edit prompt', () => {
    expect(promptFitsRequest('edit', 'Edit', {})).toBe(true);
    expect(promptFitsRequest('command', 'Edit', {})).toBe(false);
    expect(promptFitsRequest('command', 'Bash', { command: 'ls' })).toBe(true);
    expect(promptFitsRequest('edit', 'Bash', { command: 'ls' })).toBe(false);
    expect(promptFitsRequest('edit', 'exec_command', { cmd: "apply_patch <<'EOF'\nx\nEOF" })).toBe(true);
    expect(promptFitsRequest('command', 'exec_command', { cmd: "apply_patch <<'EOF'\nx\nEOF" })).toBe(false);
    // unknown tool kind (e.g. an MCP tool): whatever the CLI shows
    expect(promptFitsRequest('edit', 'mcp__fs__write', {})).toBe(true);
  });
});
