/*
 * Spool tailing (agent-display-spec §5.2, §6.1, §6.3):
 * $RELAY_HOME/state/agent-events/<terminalId>.jsonl, one JSON line per hook /
 * plugin event. Directory watched (fs.watch hint + 250 ms poll), one byte-offset
 * tailer per file. A file is rotated to <id>.jsonl.1 once it passes 2 MB AND has
 * been fully consumed; both are deleted when the terminal closes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTailer } from './tail';
import type { SpoolRecord } from './adapters/spool';

export const SPOOL_ROTATE_BYTES = 2 * 1024 * 1024;

export function spoolFileName(terminalId: string): string {
  return `${terminalId.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`;
}

export interface SpoolLine {
  record: SpoolRecord;
  /** File key (sanitized terminal id) the record was read from. */
  fileKey: string;
  /** Deterministic id base `${terminalId}:spool:${inode}:${offset}`. */
  idBase: string;
}

export class SpoolWatcher {
  readonly dir: string;
  private tailers = new Map<string, JsonlTailer>();
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private onLine: (line: SpoolLine) => void;
  private rotateBytes: number;
  private pollMs: number;
  /** While set, lines are collected instead of dispatched (the startup backfill). */
  private collecting: SpoolLine[] | null = null;

  constructor(dir: string, onLine: (line: SpoolLine) => void, opts: { rotateBytes?: number; pollMs?: number } = {}) {
    this.dir = dir;
    this.onLine = onLine;
    this.rotateBytes = opts.rotateBytes ?? SPOOL_ROTATE_BYTES;
    this.pollMs = opts.pollMs ?? 250;
  }

  /**
   * Start tailing. Everything already in the spool is handed to `onBackfill` in
   * one batch (so the tracker can merge it with the transcripts by time) —
   * without it, lines go to the per-line callback like live ones.
   */
  start(onBackfill?: (lines: SpoolLine[]) => void): void {
    try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { /* reported by the scan */ }
    if (onBackfill) {
      this.collecting = [];
      try { this.scan(); } finally {
        const lines = this.collecting;
        this.collecting = null;
        onBackfill(lines);
      }
    } else {
      this.scan();
    }
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => this.scan());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* polling covers it */ }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  /** Discover new spool files; read every tailer; rotate consumed large files. */
  scan(): void {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    // A rotated leftover from before a restart is replayed first (older events).
    for (const name of names.filter((n) => n.endsWith('.jsonl.1')).sort()) {
      const key = `${name.slice(0, -'.jsonl.1'.length)}#1`;
      if (!this.tailers.has(key)) this.addTailer(key, path.join(this.dir, name), name.slice(0, -'.jsonl.1'.length));
    }
    for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
      const key = name.slice(0, -'.jsonl'.length);
      if (!this.tailers.has(key)) this.addTailer(key, path.join(this.dir, name), key);
    }
    for (const [key, tailer] of this.tailers) {
      tailer.poll();
      if (!key.endsWith('#1')) this.maybeRotate(key, tailer);
    }
  }

  private addTailer(key: string, file: string, fileKey: string): void {
    const tailer = new JsonlTailer(file, {
      startOffset: 0,
      pollMs: 60_000, // the watcher's scan drives polling
      onLine: (line, offset, inode) => {
        let record: SpoolRecord;
        try { record = JSON.parse(line) as SpoolRecord; } catch { return; }
        if (!record || typeof record !== 'object') return;
        const terminalId = typeof record.terminalId === 'string' && record.terminalId ? record.terminalId : fileKey;
        const spoolLine: SpoolLine = { record, fileKey, idBase: `${terminalId}:spool:${inode}:${offset}` };
        if (this.collecting) this.collecting.push(spoolLine); else this.onLine(spoolLine);
      },
    });
    this.tailers.set(key, tailer);
    tailer.start();
  }

  private maybeRotate(key: string, tailer: JsonlTailer): void {
    let st: fs.Stats;
    try { st = fs.statSync(tailer.file); } catch { return; }
    if (st.size < this.rotateBytes || tailer.offset < st.size) return;
    const rotated = `${tailer.file}.1`;
    const oldKey = `${key}#1`;
    this.tailers.get(oldKey)?.stop();
    this.tailers.delete(oldKey);
    try { fs.rmSync(rotated, { force: true }); fs.renameSync(tailer.file, rotated); } catch { return; }
    // A hook that appended between our last read and the rename landed in the
    // rotated file: keep draining it (same inode → same ids) as the `#1` tailer;
    // the next scan picks up the fresh <id>.jsonl.
    tailer.retarget(rotated);
    tailer.poll();
    this.tailers.delete(key);
    this.tailers.set(oldKey, tailer);
  }

  /** Terminal closed for good: delete its spool (and rotated) file. */
  remove(terminalId: string): void {
    const base = spoolFileName(terminalId).slice(0, -'.jsonl'.length);
    for (const key of [base, `${base}#1`]) { this.tailers.get(key)?.stop(); this.tailers.delete(key); }
    for (const f of [`${base}.jsonl`, `${base}.jsonl.1`]) { try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch { /* gone */ } }
  }
}
