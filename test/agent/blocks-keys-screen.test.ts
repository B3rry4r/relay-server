// Display-block grammar (§9.1), the frozen key table (§8.1) and the ScreenGuard
// signatures checked against the REAL TUI screens captured from each CLI.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDisplayBlocks } from '../../src/relay-server/agent/blocks';
import { INTERRUPT_KEYS, KEY_RIGHT, PERMISSION_KEYS, permissionOptions, resolveKey } from '../../src/relay-server/agent/keys';
import { CODEX_HOOK_REVIEW, commandUnderSignature, matchesPermission, ScreenGuard } from '../../src/relay-server/agent/screen';

const FX = path.resolve(__dirname, '../fixtures/agent');
const screen = (rel: string) => fs.readFileSync(path.join(FX, rel), 'utf8');

describe('relay-* display blocks', () => {
  it('lifts every well-formed block out of the markdown, in source order', () => {
    const text = [
      'Done.', '',
      '```relay-status', 'state: working', 'title: Migrating API routes', 'progress: 3/7', 'detail: auth done', '```',
      '```relay-summary', 'title: Added password reset', 'result: success', '- New route', '- 3 tests', '```',
      '```relay-files', 'M src/routes/auth.ts', 'A src/emails/reset.html', 'D src/legacy/reset.js', '```',
      '```relay-link', 'title: Preview', 'url: http://localhost:5173', '```',
      '```relay-choices', 'question: Which database?', '1. SQLite (zero setup)', '2. Postgres', 'allow_other: true', '```',
    ].join('\n');
    const { text: rest, blocks } = parseDisplayBlocks(text);
    expect(rest).toBe('Done.');
    expect(blocks).toEqual([
      { kind: 'status', state: 'working', title: 'Migrating API routes', progress: '3/7', detail: 'auth done' },
      { kind: 'summary', title: 'Added password reset', result: 'success', bullets: ['New route', '3 tests'] },
      { kind: 'files', files: [{ status: 'M', path: 'src/routes/auth.ts' }, { status: 'A', path: 'src/emails/reset.html' }, { status: 'D', path: 'src/legacy/reset.js' }] },
      { kind: 'link', title: 'Preview', url: 'http://localhost:5173/' },
      { kind: 'choices', question: 'Which database?', options: [{ n: 1, label: 'SQLite (zero setup)' }, { n: 2, label: 'Postgres' }], allowOther: true },
    ]);
  });

  it('keeps malformed blocks in the text as code (nothing is dropped)', () => {
    const cases = [
      '```relay-status\nstate: working\n```', // no title
      '```relay-choices\nquestion: Pick\n1. only one\n```', // < 2 options
      '```relay-summary\ntitle: t\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n```', // > 5 bullets
      '```relay-files\nnot a file line\n```', // no files
      '```relay-link\ntitle: x\nurl: javascript:alert(1)\n```', // non-http link
      '```relay-link\nurl: file:///etc/passwd\n```',
    ];
    for (const c of cases) {
      const { text, blocks } = parseDisplayBlocks(`before\n${c}\nafter`);
      expect(blocks, c).toEqual([]);
      expect(text, c).toContain(c);
    }
  });

  it('caps choices at 4 and reports how many were cut', () => {
    const { blocks } = parseDisplayBlocks('```relay-choices\nquestion: Q\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n```');
    expect(blocks[0]).toMatchObject({ kind: 'choices', options: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], more: 2, allowOther: false });
  });

  it('defaults an unknown status state to working and ignores an unknown summary result', () => {
    const { blocks } = parseDisplayBlocks('```relay-status\nstate: exploding\ntitle: T\n```\n```relay-summary\ntitle: S\nresult: maybe\n```');
    expect(blocks).toEqual([{ kind: 'status', state: 'working', title: 'T' }, { kind: 'summary', title: 'S', bullets: [] }]);
  });
});

describe('permission keys (§8.1, frozen)', () => {
  it('matches the verified table exactly', () => {
    expect(PERMISSION_KEYS).toEqual({
      claude: { allow_once: ['1'], allow_always: ['2'], deny: ['\x1b'] },
      codex: { allow_once: ['y'], allow_always: ['p'], deny: ['\x1b'] },
      gemini: { allow_once: ['\r'], allow_always: ['2'], deny: ['\x1b'] },
      opencode: { allow_once: ['\r'], allow_always: [KEY_RIGHT, '\r', '\r'], deny: ['\x1b'] },
    });
    expect(Object.isFrozen(PERMISSION_KEYS)).toBe(true);
    expect(Object.isFrozen(PERMISSION_KEYS.claude)).toBe(true);
  });

  it('never denies with a digit (Claude\'s "No" moves between 3 and 4)', () => {
    for (const cli of Object.keys(PERMISSION_KEYS) as Array<keyof typeof PERMISSION_KEYS>) {
      expect(PERMISSION_KEYS[cli].deny).toEqual(['\x1b']);
      expect(PERMISSION_KEYS[cli].deny.join('')).not.toMatch(/\d/);
    }
    expect(INTERRUPT_KEYS.claude).toEqual(['\x1b']);
  });

  it('resolves cursor-right against DECCKM', () => {
    expect(resolveKey(KEY_RIGHT, false)).toBe('\x1b[C');
    expect(resolveKey(KEY_RIGHT, true)).toBe('\x1bOC');
    expect(resolveKey('y', true)).toBe('y');
  });

  it('"Always" needs a confirm tap; the Codex copy says it applies to future sessions', () => {
    const codex = permissionOptions('codex');
    expect(codex.map((o) => o.id)).toEqual(['allow_once', 'allow_always', 'deny']);
    expect(codex[1]).toMatchObject({ confirm: true });
    expect(codex[1].detail).toMatch(/future sessions/);
  });
});

describe('ScreenGuard signatures on the real TUI screens', () => {
  it('matches each CLI\'s permission prompt and nothing after the answer', () => {
    expect(matchesPermission('claude', screen('claude/claude-2.1.284.screen-permission-prompt.txt'))).toBe(true);
    expect(matchesPermission('claude', screen('claude/claude-2.1.284.screen-after-esc-deny.txt'))).toBe(false);
    expect(matchesPermission('claude', screen('claude/claude-2.1.284.screen-turn-done.txt'))).toBe(false);
    expect(matchesPermission('codex', screen('codex/codex-0.159.0.screen-approval-prompt.txt'))).toBe(true);
    expect(matchesPermission('codex', screen('codex/codex-0.159.0.screen-after-esc-deny.txt'))).toBe(false);
    expect(matchesPermission('gemini', screen('gemini/gemini-0.61.0.screen-permission-prompt.txt'))).toBe(true);
    expect(matchesPermission('gemini', screen('gemini/gemini-0.61.0.screen-after-esc-deny.txt'))).toBe(false);
    expect(matchesPermission('opencode', screen('opencode/opencode-1.18.33.screen-permission-prompt.txt'))).toBe(true);
    expect(matchesPermission('opencode', screen('opencode/opencode-1.18.33.screen-after-esc-deny.txt'))).toBe(false);
    // a signature from another CLI never counts
    expect(matchesPermission('claude', screen('codex/codex-0.159.0.screen-approval-prompt.txt'))).toBe(false);
    expect(CODEX_HOOK_REVIEW.test(screen('codex/codex-0.159.0.screen-hooks-need-review.txt'))).toBe(true);
  });

  it('reads the command under the signature', () => {
    expect(commandUnderSignature('claude', screen('claude/claude-2.1.284.screen-permission-prompt.txt'))).toBe('touch relay-demo.txt');
    expect(commandUnderSignature('codex', screen('codex/codex-0.159.0.screen-approval-prompt.txt'))).toBe('touch relay-demo.txt');
    expect(commandUnderSignature('gemini', screen('gemini/gemini-0.61.0.screen-permission-prompt.txt'))).toBe('touch relay-demo.txt');
    expect(commandUnderSignature('opencode', screen('opencode/opencode-1.18.33.screen-permission-prompt.txt'))).toBe('touch relay-demo.txt');
  });

  it('renders PTY bytes (alt screen, cursor moves) and forgets a prompt once it is cleared', async () => {
    const g = new ScreenGuard({ cols: 80, rows: 12 });
    g.write('\x1b[?1049h\x1b[2J\x1b[H Do you want to proceed?\r\n \x1b[36m❯ 1. Yes\x1b[0m\r\n   3. No\r\n');
    expect(matchesPermission('claude', await g.screen())).toBe(true);
    g.write('\x1b[2J\x1b[H● Created the file.\r\n');
    expect(matchesPermission('claude', await g.screen())).toBe(false);
    g.write('\x1b[?1049l');
    g.write('\x1b[?1h'); // DECCKM on
    await g.flush();
    expect(g.applicationCursorKeys).toBe(true);
    g.resize(120, 40);
    expect([g.cols, g.rows]).toEqual([120, 40]);
    g.dispose();
  });
});
