/*
 * Generic JSONL tailer (agent-display-spec §6.1 tail.ts): byte offsets, a
 * partial-line buffer that is safe across UTF-8 boundaries, and truncation /
 * rotation detection (size < offset, or a new inode → restart from 0).
 *
 * The CLIs do not keep their transcripts open (they open-append-close), so we
 * poll (fs.watch is used as a hint to poll sooner, never trusted alone).
 */
import fs from 'node:fs';

/** Splits a byte stream into complete lines, reporting each line's start offset. */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  private base: number;

  constructor(startOffset = 0) {
    this.base = startOffset;
  }

  /** Byte offset of the first unconsumed byte (start of the pending partial line). */
  get offset(): number {
    return this.base;
  }

  /** Bytes held for an unterminated line. */
  get buffered(): number {
    return this.pending.length;
  }

  push(chunk: Buffer): Array<{ line: string; offset: number }> {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Array<{ line: string; offset: number }> = [];
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && buf[end - 1] === 0x0d) end -= 1;
      const line = buf.subarray(start, end).toString('utf8');
      if (line.trim()) out.push({ line, offset: this.base + start });
      start = nl + 1;
    }
    this.base += start;
    this.pending = Buffer.from(buf.subarray(start));
    return out;
  }

  /** Flush a final unterminated line (only for whole-file parsing; live tails wait for the newline). */
  end(): Array<{ line: string; offset: number }> {
    if (!this.pending.length) return [];
    const line = this.pending.toString('utf8');
    const offset = this.base;
    this.base += this.pending.length;
    this.pending = Buffer.alloc(0);
    return line.trim() ? [{ line, offset }] : [];
  }
}

export interface TailerOptions {
  /** Explicit start offset. Default: backfill at most `maxBackfill` bytes from the end. */
  startOffset?: number;
  maxBackfill?: number;
  pollMs?: number;
  onLine: (line: string, offset: number, inode: number) => void;
  /** File truncated or replaced; tailing restarts at 0. */
  onReset?: (reason: 'truncated' | 'replaced') => void;
  onError?: (error: unknown) => void;
}

export const DEFAULT_MAX_BACKFILL = 8 * 1024 * 1024;
const READ_CHUNK = 256 * 1024;

export class JsonlTailer {
  file: string;
  private opts: TailerOptions;
  private splitter: LineSplitter | null = null;
  private inode = 0;
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private stopped = false;
  private reading = false;

  constructor(file: string, opts: TailerOptions) {
    this.file = file;
    this.opts = opts;
  }

  get offset(): number {
    return this.splitter?.offset ?? 0;
  }

  get currentInode(): number {
    return this.inode;
  }

  /**
   * The file was renamed (rotation): keep reading it under its new path from the
   * current offset. The inode is unchanged, so ids stay the same.
   */
  retarget(file: string): void {
    this.watcher?.close();
    this.watcher = null;
    this.file = file;
  }

  start(): void {
    this.poll();
    const ms = this.opts.pollMs ?? 250;
    this.timer = setInterval(() => this.poll(), ms);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, () => this.poll());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* polling covers it */ }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Synchronously read everything available now (also used by tests). */
  poll(): void {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      let st: fs.Stats;
      try { st = fs.statSync(this.file); } catch { return; }
      if (!this.splitter) {
        this.inode = st.ino;
        let start = this.opts.startOffset;
        if (start === undefined) {
          const max = this.opts.maxBackfill ?? DEFAULT_MAX_BACKFILL;
          start = Math.max(0, st.size - max);
          if (start > 0) start = this.alignToLine(start);
        }
        this.splitter = new LineSplitter(start);
      } else if (st.ino !== this.inode) {
        this.inode = st.ino;
        this.splitter = new LineSplitter(0);
        this.opts.onReset?.('replaced');
      } else if (st.size < this.splitter.offset) {
        this.splitter = new LineSplitter(0);
        this.opts.onReset?.('truncated');
      }
      this.drain(st.size);
    } catch (error) {
      this.opts.onError?.(error);
    } finally {
      this.reading = false;
    }
  }

  /** Read [offset, size) of the CURRENT file through the splitter. */
  private drain(size: number): void {
    if (!this.splitter) return;
    let fd: number;
    try { fd = fs.openSync(this.file, 'r'); } catch { return; }
    try {
      // read from the splitter's consumed offset + whatever it already buffers
      let pos = this.splitter.offset + this.splitter.buffered;
      const buf = Buffer.alloc(READ_CHUNK);
      while (pos < size && !this.stopped) {
        const n = fs.readSync(fd, buf, 0, Math.min(READ_CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        for (const { line, offset } of this.splitter.push(Buffer.from(buf.subarray(0, n)))) {
          this.opts.onLine(line, offset, this.inode);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Move a mid-file start to the byte after the next newline. */
  private alignToLine(start: number): number {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pos = start;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) return pos;
        const nl = buf.subarray(0, n).indexOf(0x0a);
        if (nl !== -1) return pos + nl + 1;
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
