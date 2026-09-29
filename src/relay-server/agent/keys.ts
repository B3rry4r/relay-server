/*
 * Permission keystrokes (agent-display-spec §8.1) — FROZEN: every entry was
 * checked against the real TUI (claude 2.1.284, codex 0.159.0, gemini 0.61.0,
 * opencode 1.18.33). test/agent/keys.test.ts pins this table.
 *
 * Deny is ALWAYS Esc. Claude's "No" is option 3 or 4 depending on mode, so a
 * digit must never be used to deny.
 */
import type { AgentCli, PermissionChoice, PermissionOption } from './types';

/** Placeholder for "cursor right", resolved against the terminal's DECCKM mode at send time. */
export const KEY_RIGHT = '<RIGHT>';

export const PERMISSION_KEYS: Readonly<Record<AgentCli, Readonly<Record<PermissionChoice, readonly string[]>>>> = Object.freeze({
  claude: Object.freeze({ allow_once: ['1'], allow_always: ['2'], deny: ['\x1b'] }),
  codex: Object.freeze({ allow_once: ['y'], allow_always: ['p'], deny: ['\x1b'] }),
  gemini: Object.freeze({ allow_once: ['\r'], allow_always: ['2'], deny: ['\x1b'] }),
  opencode: Object.freeze({ allow_once: ['\r'], allow_always: [KEY_RIGHT, '\r', '\r'], deny: ['\x1b'] }),
});

/** Gap between keys of a multi-key sequence (§8.1: 250 ms, then assert through the ScreenGuard). */
export const KEY_GAP_MS = 250;
/** Retry the final key once if the prompt is unchanged this long after it (§8.1). */
export const KEY_RETRY_AFTER_MS = 1500;

export function resolveKey(key: string, applicationCursorKeys: boolean): string {
  if (key === KEY_RIGHT) return applicationCursorKeys ? '\x1bOC' : '\x1b[C';
  return key;
}

export function permissionOptions(cli: AgentCli): PermissionOption[] {
  const always: PermissionOption = { id: 'allow_always', label: 'Always', confirm: true };
  if (cli === 'codex') always.detail = 'Codex saves this as a rule: matching commands will run without asking in future sessions too.';
  if (cli === 'claude') always.detail = "Claude won't ask again for this in the project.";
  if (cli === 'gemini') always.detail = 'Gemini allows this for the rest of the session.';
  if (cli === 'opencode') always.detail = 'opencode allows matching commands from now on.';
  return [
    { id: 'allow_once', label: 'Allow' },
    always,
    { id: 'deny', label: 'Deny' },
  ];
}

/**
 * Stop / interrupt. Esc is VERIFIED only as "deny" at a permission prompt; as a
 * mid-turn interrupt it is UNVERIFIED for all four CLIs (§7.2). The tracker
 * therefore offers Stop only while the CLI's own interrupt hint is on screen
 * (screen.ts INTERRUPT_HINTS) and reports `verified:false`.
 */
export const INTERRUPT_KEYS: Readonly<Record<AgentCli, readonly string[]>> = Object.freeze({
  claude: ['\x1b'],
  codex: ['\x1b'],
  gemini: ['\x1b'],
  opencode: ['\x1b'],
});
