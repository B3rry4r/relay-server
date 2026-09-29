/*
 * ProcessInspector (agent-display-spec §5.3): /proc descendants, environ, cwd,
 * start time, and cmdline → CLI detection. The procfs root is injectable so the
 * correlation rules are unit-tested against a fake tree (test/agent/process.test.ts).
 *
 * It validates hook records by LINEAGE captured at write time: Claude runs hooks
 * through a transient `sh -c` that is gone before we read the record, so a check
 * of the hook's ppid alone would reject every Claude hook.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCli } from './types';

export interface ProcInfo {
  pid: number;
  ppid: number;
  argv: string[];
  /** Start time in clock ticks since boot (/proc/<pid>/stat field 22). */
  startTicks: number;
}

export interface ProcFs {
  listPids(): number[];
  readStat(pid: number): string | null;
  readCmdline(pid: number): string | null;
  readEnviron(pid: number): string | null;
  readCwd(pid: number): string | null;
  readFd0(pid: number): string | null;
  /** btime from /proc/stat (seconds since epoch) */
  bootTime(): number | null;
}

export function realProcFs(root = '/proc'): ProcFs {
  const read = (p: string): string | null => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
  const link = (p: string): string | null => { try { return fs.readlinkSync(path.join(root, p)); } catch { return null; } };
  return {
    listPids: () => { try { return fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).map(Number); } catch { return []; } },
    readStat: (pid) => read(`${pid}/stat`),
    readCmdline: (pid) => read(`${pid}/cmdline`),
    readEnviron: (pid) => read(`${pid}/environ`),
    readCwd: (pid) => link(`${pid}/cwd`),
    readFd0: (pid) => link(`${pid}/fd/0`),
    bootTime: () => {
      const s = read('stat');
      const m = s ? /^btime\s+(\d+)/m.exec(s) : null;
      return m ? Number(m[1]) : null;
    },
  };
}

/** Parse /proc/<pid>/stat (the comm field may contain spaces and parens). */
export function parseStat(stat: string): { ppid: number; startTicks: number } | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const rest = stat.slice(close + 2).split(' ');
  // rest[0]=state(3) rest[1]=ppid(4) … starttime is field 22 → rest[19]
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(ppid)) return null;
  return { ppid, startTicks: Number.isFinite(startTicks) ? startTicks : 0 };
}

const CLI_PACKAGE_HINTS: Array<[RegExp, AgentCli]> = [
  [/\/@anthropic-ai\/claude-code\//, 'claude'],
  [/\/@openai\/codex\//, 'codex'],
  [/\/@google\/gemini-cli\//, 'gemini'],
  [/\/opencode-ai\//, 'opencode'],
];

/**
 * Which agent CLI (if any) a process is (§5.3 step 1). Node-wrapped CLIs are
 * recognised by their script argument (the first non-flag arg after `node`).
 * Deliberately strict: `grep codex`, `vim gemini.md`, `less claude.log` are not agents.
 */
export function detectCli(argv: string[]): AgentCli | null {
  if (!argv.length) return null;
  const exe = path.basename(argv[0]);
  const byName = (name: string): AgentCli | null => {
    const m = /^(claude|codex|gemini|opencode)(\.(?:js|mjs|cjs|exe))?$/.exec(name);
    return m ? m[1] as AgentCli : null;
  };
  const direct = byName(exe);
  if (direct) return direct;
  if (/^(node|nodejs|bun|deno)$/.test(exe) || /^node\d*$/.test(exe)) {
    const script = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!script) return null;
    for (const [re, cli] of CLI_PACKAGE_HINTS) if (re.test(script)) return cli;
    return byName(path.basename(script));
  }
  for (const [re, cli] of CLI_PACKAGE_HINTS) if (re.test(argv[0])) return cli;
  return null;
}

export class ProcessInspector {
  private procfs: ProcFs;
  private cache: { at: number; procs: Map<number, ProcInfo>; children: Map<number, number[]> } | null = null;
  private ttlMs: number;
  private now: () => number;
  private clkTck: number;

  constructor(opts: { procfs?: ProcFs; ttlMs?: number; now?: () => number; clkTck?: number } = {}) {
    this.procfs = opts.procfs ?? realProcFs();
    this.ttlMs = opts.ttlMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.clkTck = opts.clkTck ?? 100;
  }

  invalidate(): void {
    this.cache = null;
  }

  private snapshot(): { procs: Map<number, ProcInfo>; children: Map<number, number[]> } {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache;
    const procs = new Map<number, ProcInfo>();
    const children = new Map<number, number[]>();
    for (const pid of this.procfs.listPids()) {
      const stat = this.procfs.readStat(pid);
      const parsed = stat ? parseStat(stat) : null;
      if (!parsed) continue;
      const cmd = this.procfs.readCmdline(pid) ?? '';
      const info: ProcInfo = { pid, ppid: parsed.ppid, argv: cmd.split('\0').filter(Boolean), startTicks: parsed.startTicks };
      procs.set(pid, info);
      const list = children.get(parsed.ppid);
      if (list) list.push(pid); else children.set(parsed.ppid, [pid]);
    }
    this.cache = { at: t, procs, children };
    return this.cache;
  }

  info(pid: number): ProcInfo | null {
    return this.snapshot().procs.get(pid) ?? null;
  }

  isAlive(pid: number): boolean {
    return this.snapshot().procs.has(pid);
  }

  /** The root and every descendant (BFS). */
  descendants(root: number): Set<number> {
    const { children } = this.snapshot();
    const out = new Set<number>();
    if (!root) return out;
    const queue = [root];
    while (queue.length) {
      const p = queue.shift() as number;
      if (out.has(p)) continue;
      out.add(p);
      for (const c of children.get(p) ?? []) queue.push(c);
    }
    return out;
  }

  /** Agent CLI processes under `root`, outermost first (a node wrapper and its child count once). */
  findClis(root: number): Array<{ pid: number; cli: AgentCli; argv: string[] }> {
    const { procs } = this.snapshot();
    const found: Array<{ pid: number; cli: AgentCli; argv: string[] }> = [];
    for (const pid of this.descendants(root)) {
      const info = procs.get(pid);
      if (!info) continue;
      const cli = detectCli(info.argv);
      if (!cli) continue;
      // skip a CLI whose parent is the same CLI (node wrapper → native binary)
      const parent = procs.get(info.ppid);
      if (parent && detectCli(parent.argv) === cli) continue;
      found.push({ pid, cli, argv: info.argv });
    }
    return found;
  }

  environ(pid: number): Record<string, string> | null {
    const raw = this.procfs.readEnviron(pid);
    if (raw === null) return null;
    const env: Record<string, string> = {};
    for (const kv of raw.split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
  }

  cwd(pid: number): string | null {
    return this.procfs.readCwd(pid);
  }

  tty(pid: number): string | null {
    const t = this.procfs.readFd0(pid);
    return t && t.startsWith('/dev/pts/') ? t : null;
  }

  /** Process start time as epoch ms (stat field 22 / CLK_TCK + btime), or null. */
  startTimeMs(pid: number): number | null {
    const info = this.info(pid);
    const btime = this.procfs.bootTime();
    if (!info || btime === null) return null;
    return (btime + info.startTicks / this.clkTck) * 1000;
  }

  /**
   * Is /proc shared with the PTY host? True when the terminal's root process (or
   * one of its children — a bridge's shell) carries RELAY_TERMINAL_ID=<id>. When
   * false the tracker runs "limited" (§5.4): no lineage checks, no fallback discovery.
   */
  sharesNamespaceWith(terminalId: string, pid: number): boolean {
    if (!pid) return false;
    for (const p of [pid, ...(this.snapshot().children.get(pid) ?? [])]) {
      const env = this.environ(p);
      if (env && env.RELAY_TERMINAL_ID === terminalId) return true;
    }
    return false;
  }
}

export interface LineageEntry { pid: number; cmd?: string }

/**
 * §5.3 attribution of one hook record: 'hook' when any ancestor recorded at write
 * time (or the writer itself, for the in-process opencode plugin) is inside the
 * terminal's process tree; 'detached' when the recorded ancestry is alive but
 * outside the tree (codex daemon, tmux, setsid, nohup); 'unknown' when every
 * recorded process is gone (a record read after the CLI exited — replay).
 */
export function attributeRecord(
  inspector: ProcessInspector,
  terminalPid: number,
  record: { pid?: number; ppid?: number; lineage?: LineageEntry[] },
): 'hook' | 'detached' | 'unknown' {
  const tree = inspector.descendants(terminalPid);
  const candidates: number[] = [];
  if (Array.isArray(record.lineage)) for (const l of record.lineage) if (Number.isInteger(l?.pid) && l.pid > 1) candidates.push(l.pid);
  if (Number.isInteger(record.pid)) candidates.push(record.pid as number);
  if (Number.isInteger(record.ppid) && (record.ppid as number) > 1) candidates.push(record.ppid as number);
  if (candidates.some((p) => tree.has(p))) return 'hook';
  if (candidates.some((p) => inspector.isAlive(p))) return 'detached';
  return 'unknown';
}

/** The agent process of a hook record: the nearest recorded ancestor that is not a `sh -c` wrapper. */
export function agentPidFromRecord(record: { pid?: number; ppid?: number; cli?: string; lineage?: LineageEntry[] }): number | null {
  if (record.cli === 'opencode' && Number.isInteger(record.pid)) return record.pid as number;
  for (const l of record.lineage ?? []) {
    if (!Number.isInteger(l?.pid) || l.pid <= 1) continue;
    const cmd = String(l.cmd ?? '');
    if (/^(\/bin\/)?(ba|da|z)?sh -c\b/.test(cmd)) continue;
    return l.pid;
  }
  return Number.isInteger(record.ppid) && (record.ppid as number) > 1 ? record.ppid as number : null;
}
