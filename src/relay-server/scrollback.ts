// A scrollback buffer that stores PTY output as a list of chunks and only
// materializes the full string when needed (persist + replay).
//
// Why:  the previous implementation did `session.scrollback = `${session.scrollback}${data}`.slice(-N)`
// on every `onData` chunk. That allocates a new ~N-byte string and copies
// every byte each time — O(n) per chunk, O(n²) per stream. Under heavy AI CLI
// streaming (claude, gemini, opencode) this triggers GC pauses on the event
// loop, which is exactly what makes the terminal "freeze" mid-keystroke.
//
// Append is O(chunk.length) — we just push and trim from the head when the
// running byte count exceeds MAX_BYTES. Materialization is O(total) but
// happens only on persist (debounced) and replay (rare).

export class ScrollbackBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private cachedString: string | null = null;

  constructor(private readonly maxBytes: number) {}

  append(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.bytes += data.length;
    this.cachedString = null;

    // Trim from the head until we're back under the cap. Drop whole
    // chunks where possible — they tend to be small and dropping is
    // cheaper than splitting. If the head chunk is larger than the
    // overage, slice it in place rather than discarding too much.
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0];
      const overshoot = this.bytes - this.maxBytes;
      if (head.length <= overshoot) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        // Slice the head to remove exactly `overshoot` bytes.
        this.chunks[0] = head.slice(overshoot);
        this.bytes -= overshoot;
      }
    }
  }

  /**
   * Replace the buffer contents with a previously-persisted string. Used on
   * relay restart when restoring terminal sessions from disk.
   */
  reset(initial: string): void {
    const trimmed = initial.length > this.maxBytes
      ? initial.slice(initial.length - this.maxBytes)
      : initial;
    this.chunks = trimmed.length > 0 ? [trimmed] : [];
    this.bytes = trimmed.length;
    this.cachedString = trimmed;
  }

  toString(): string {
    if (this.cachedString !== null) return this.cachedString;
    if (this.chunks.length === 0) {
      this.cachedString = '';
      return '';
    }
    if (this.chunks.length === 1) {
      this.cachedString = this.chunks[0];
      return this.cachedString;
    }
    // Compact into a single chunk while we materialize so subsequent reads
    // are O(1) until the next append.
    const joined = this.chunks.join('');
    this.chunks = [joined];
    this.bytes = joined.length;
    this.cachedString = joined;
    return joined;
  }

  get length(): number {
    return this.bytes;
  }
}
