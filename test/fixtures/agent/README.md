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
