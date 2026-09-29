/*
 * Remote PTY mode: the tracker's OWN single connection to the PTY service
 * (CONTRACTS §4: in Option B the browser's terminal socket goes straight to the
 * PTY service, so relay-server has no per-client bridge to tap or write through).
 *
 * It is opened only while at least one agent session is attached (relay-pty
 * creates a shell for a connecting socket when it has none, so an idle link is
 * never held), feeds terminal output/replays into the hub for the ScreenGuards,
 * and writes answer keys with `terminal:input {id,data}` (acked).
 */
import { io as ioClient } from 'socket.io-client';
import { getRemotePtyToken, getRemotePtyUrl } from '../remote-pty';
import { ptyHub } from './pty-hub';

type Upstream = ReturnType<typeof ioClient>;

export class PtyServiceLink {
  private upstream: Upstream | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleMs: number;

  constructor(opts: { idleMs?: number } = {}) {
    this.idleMs = opts.idleMs ?? 30_000;
  }

  get connected(): boolean {
    return Boolean(this.upstream?.connected);
  }

  /** Keep the link open (called while sessions are attached). */
  ensureOpen(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.upstream) return;
    const url = getRemotePtyUrl();
    if (!url) return;
    const upstream = ioClient(url, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      auth: (cb: (data: object) => void) => cb({ token: getRemotePtyToken(), client: 'relay-agent-tracker' }),
    });
    upstream.on('terminal:output', (p: { id?: unknown; data?: unknown }) => {
      if (typeof p?.id === 'string' && typeof p.data === 'string') ptyHub.output(p.id, p.data);
    });
    upstream.on('terminal:replay', (p: { id?: unknown; data?: unknown }) => {
      if (typeof p?.id === 'string' && typeof p.data === 'string') ptyHub.replay(p.id, p.data);
    });
    for (const ev of ['terminals:updated', 'terminals:ready', 'terminal:created', 'terminal:closed']) upstream.on(ev, () => ptyHub.changed());
    upstream.on('connect_error', (error: Error) => {
      console.warn(`[agent] PTY service link: ${error.message}`);
    });
    this.upstream = upstream;
  }

  /** Close after `idleMs` unless ensureOpen() is called again. */
  releaseSoon(): void {
    if (!this.upstream || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; this.close(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { this.upstream?.close(); } catch { /* closed */ }
    this.upstream = null;
  }

  write(terminalId: string, data: string, timeoutMs = 3000): Promise<boolean> {
    this.ensureOpen();
    const upstream = this.upstream;
    if (!upstream) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      upstream.emit('terminal:input', { id: terminalId, data }, (ack: { ok?: boolean } | undefined) => {
        clearTimeout(timer);
        resolve(Boolean(ack?.ok));
      });
    });
  }
}
