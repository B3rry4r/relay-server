// Relay opencode plugin (agent-display-spec §4.4). Installed by
// scripts/relay-agent-install.mjs into ~/.config/opencode/plugin/relay-agent.js.
// Runs INSIDE the opencode process, so process.env.RELAY_TERMINAL_ID identifies
// the terminal and the tracker validates the record by this process's pid.
// Appends bus events to $RELAY_AGENT_SPOOL/<terminalId>.jsonl; noise events are
// dropped here so the spool stays small. Never throws into opencode.
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const spoolDir = env.RELAY_AGENT_SPOOL || path.join(env.RELAY_HOME || path.join(env.HOME || "/tmp", ".relay"), "state", "agent-events");
const rawTid = env.RELAY_TERMINAL_ID || "";
const file = path.join(spoolDir, rawTid ? `${rawTid.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl` : "_unattributed.jsonl");
const NOISE = /^(plugin\.added|catalog\.|reference\.|integration\.|message\.part\.delta|lsp\.|installation\.|file\.watcher)/;
const MAX_STRING = 16 * 1024;

const truncate = (value, depth = 0) => {
  if (depth > 32) return "[depth]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : value;
  if (Array.isArray(value)) return value.map((v) => truncate(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v, depth + 1);
    return out;
  }
  return value;
};

const write = (payload) => {
  try {
    fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ v: 1, cli: "opencode", terminalId: rawTid || "_unattributed", pid: process.pid, ppid: process.ppid, at: new Date().toISOString(), payload: truncate(payload) }) + "\n", { mode: 0o600 });
  } catch { /* never break opencode */ }
};

export const RelayAgentPlugin = async (ctx) => {
  write({ hook_event_name: "PluginLoaded", directory: ctx?.directory, worktree: ctx?.worktree });
  return {
    event: async ({ event }) => {
      if (!event || typeof event.type !== "string" || NOISE.test(event.type)) return;
      write({ hook_event_name: "event", event });
    },
  };
};
