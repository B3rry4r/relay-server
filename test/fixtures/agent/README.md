# Agent-view fixtures

Labels in file names:
- `REAL-CLI-MOCK-MODEL`: written by the **real, shipping CLI binary** (claude 2.1.284, codex 0.159.0,
  gemini 0.61.0, opencode 1.18.33) running interactively in a real PTY. Only the model was replaced by
  a local scripted mock server (`../mock-*.mjs`). File formats, hook payloads, TUI screens and
  keystroke behaviour are therefore genuine. Model text is scripted ("I'll create the file." …).
  Strings over 600 chars are truncated with a `…[+N chars]` marker (`../trunc-jsonl.js`).
- `SYNTHESIZED`: written by `../fake-agent.mjs`, a Relay test double that imitates the Claude format.
  Do not treat it as a source of truth for the CLI format.
- `*.normalized.json`: golden output of `../adapters.prototype.mjs` for the sibling `.jsonl`.
- `*.screen-*.txt`: the rendered 100x34 terminal screen (@xterm/headless) at that moment.
- `*hooks-spool*`: lines the prototype hook `../bin/relay-agent-hook` appended (payload = verbatim hook stdin).
  The `-with-lineage` variants include the write-time process ancestry.

Regenerate: `../run-{claude,codex,gemini,opencode}.sh` (each starts its mock and drives the TUI via `../drive.mjs`).

## Edit prompts (recorded for the critic's P1, 2026-09-30)

`<cli>-<ver>.screen-edit-{prompt,after-allow-once,after-always,after-esc-deny}.txt` for
claude 2.1.284, codex 0.159.0 and gemini 0.61.0 are **REAL-CLI-MOCK-MODEL** screens:
the shipping binary in a real PTY (100x34, `@xterm/headless`) with a fake `$HOME`, pointed
at `mock/mock-{anthropic,openai,gemini}-edit.mjs`. That mock asks for exactly one edit of
`hello.txt` (`hello world` → `hello relay`): Claude `Read` then `Edit`, Codex `apply_patch`
through its `exec_command` shell tool (this model family has no apply_patch tool), and Gemini
`replace`. Launch settings: `claude --permission-mode default` (2.1.284 defaults to *auto
mode*, which runs edits without a prompt); Codex `approval_policy = "on-request"` +
`sandbox_mode = "read-only"`; Gemini defaults.

Every key in `EDIT_KEYS` (src/relay-server/agent/keys.ts) was pressed at that prompt, and
the file on disk was checked afterwards:

| cli | prompt | `allow_once` | `allow_always` | `deny` |
|---|---|---|---|---|
| claude | `Do you want to make this edit to hello.txt?` / `❯ 1. Yes` | `1` → edited | `2` → edited, "accept edits on" for the session | Esc → unchanged (`3` too) |
| codex | `Would you like to make the following edits?` / `1. Yes, proceed (y)` | `y` → edited | `a` → edited, no more asking for these files | Esc → unchanged, turn interrupted |
| gemini | `Apply this change?` / `1. Allow once` | `1` (or Enter) → edited | `2` → edited, "auto-accept edits" for the session | Esc → unchanged |

opencode has no separate edit prompt (one "Permission required" dialog for every tool).

**Esc as a mid-turn interrupt (Stop) stays UNVERIFIED, and the Stop button stays hidden
unless the CLI's own interrupt hint is on screen (decision, 2026-09-30).** Verifying it
needs a mock that streams a long turn, and a check that each CLI really cancels the
in-flight tool rather than only redrawing. That was not done in this round. Until it is,
`agent:interrupt` reports `verified:false`, and relay-web offers Stop only while the CLI
itself prints its hint (`esc to interrupt` / `esc to cancel`). This is the same key the
user would press in the terminal.
