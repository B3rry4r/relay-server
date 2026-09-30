// Research prototype of the Relay opencode plugin: append every bus event + tool hooks to the Relay spool.
import fs from "node:fs";
import path from "node:path";
const spoolDir = process.env.RELAY_AGENT_SPOOL || path.join(process.env.RELAY_HOME || path.join(process.env.HOME || "/tmp", ".relay"), "state", "agent-events");
const tid = (process.env.RELAY_TERMINAL_ID || "_unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
const write = (payload) => {
  try {
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.appendFileSync(path.join(spoolDir, `${tid}.jsonl`), JSON.stringify({ v: 1, cli: "opencode", terminalId: tid, pid: process.pid, ppid: process.ppid, at: new Date().toISOString(), payload }) + "\n");
  } catch {}
};
export const RelayAgentPlugin = async (ctx) => {
  write({ hook_event_name: "PluginLoaded", directory: ctx.directory, worktree: ctx.worktree });
  return {
    event: async ({ event }) => write({ hook_event_name: "event", event }),
    "tool.execute.before": async (input, output) => write({ hook_event_name: "tool.execute.before", input, args: output?.args }),
    "tool.execute.after": async (input, output) => write({ hook_event_name: "tool.execute.after", input, output: { title: output?.title, metadata: output?.metadata } }),
    "permission.ask": async (input, output) => write({ hook_event_name: "permission.ask", input, status: output?.status }),
  };
};
