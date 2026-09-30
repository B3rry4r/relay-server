// Test helper: make a torn-down terminal's processes GONE before its workspace is
// removed. A PTY shell is a session leader (setsid), so the shell, the fake agent
// it ran and every relay-agent-hook that agent spawned share its session id. When
// the server stops, the shell only gets SIGHUP and exits on its own schedule —
// bash then writes .bash_history and the agent may still append to its key log,
// so an rmSync that races them fails with ENOTEMPTY. Instead of retrying the
// delete, kill the whole session and wait until /proc shows no live member.
import fs from 'node:fs';

/** Live (non-zombie) pids whose session id is one of `sids`. */
export function liveSessionMembers(sids: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; } // exited meanwhile
    // "pid (comm) state ppid pgrp session …" — comm may contain spaces/parens
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (f[0] !== 'Z' && f[0] !== 'X' && sids.has(Number(f[3]))) out.push(Number(d));
  }
  return out;
}

/** SIGKILL every live member of the given shells' sessions and resolve once none
 *  is left (a zombie can no longer write, so it counts as gone). */
export async function reapTerminalSessions(shellPids: Iterable<number>): Promise<void> {
  const sids = new Set(Array.from(shellPids).filter((p) => Number.isInteger(p) && p > 0));
  if (sids.size === 0) return;
  for (;;) {
    const live = liveSessionMembers(sids);
    if (live.length === 0) return;
    for (const pid of live) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await new Promise((r) => setTimeout(r, 10));
  }
}
