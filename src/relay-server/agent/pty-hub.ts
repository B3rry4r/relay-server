/*
 * A tiny in-process hub between the embedded PTY engine (socket.ts) and the
 * agent tracker, so socket.ts does not import the tracker (and tests can tap it).
 *
 * Embedded mode: socket.ts reports every terminal's output (independent of any
 * browser socket), resizes, and closes; it registers a writer and a scrollback
 * reader. Remote mode: the tracker's own PTY-service link feeds the same hub.
 */
export type TerminalCloseReason = 'closed' | 'shutdown';

export interface PtyHubListener {
  output?(terminalId: string, data: string): void;
  replay?(terminalId: string, data: string): void;
  resized?(terminalId: string, cols: number, rows: number): void;
  closed?(terminalId: string, reason: TerminalCloseReason): void;
  changed?(): void;
}

const listeners = new Set<PtyHubListener>();

export const ptyHub = {
  subscribe(listener: PtyHubListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  output(terminalId: string, data: string): void {
    for (const l of listeners) { try { l.output?.(terminalId, data); } catch { /* a listener must never break the PTY path */ } }
  },
  replay(terminalId: string, data: string): void {
    for (const l of listeners) { try { l.replay?.(terminalId, data); } catch { /* ignore */ } }
  },
  resized(terminalId: string, cols: number, rows: number): void {
    for (const l of listeners) { try { l.resized?.(terminalId, cols, rows); } catch { /* ignore */ } }
  },
  closed(terminalId: string, reason: TerminalCloseReason): void {
    for (const l of listeners) { try { l.closed?.(terminalId, reason); } catch { /* ignore */ } }
  },
  changed(): void {
    for (const l of listeners) { try { l.changed?.(); } catch { /* ignore */ } }
  },
};

/** Embedded engine hooks (set by socket.ts). */
export interface EmbeddedPtyAccess {
  write(terminalId: string, data: string): boolean;
  scrollback(terminalId: string): string;
}

let embeddedAccess: EmbeddedPtyAccess | null = null;
export function setEmbeddedPtyAccess(access: EmbeddedPtyAccess | null): void {
  embeddedAccess = access;
}
export function getEmbeddedPtyAccess(): EmbeddedPtyAccess | null {
  return embeddedAccess;
}

/** Remote mode: per-client bridge writers (remote-pty.ts), keyed by browser socket id. */
export type BridgeWriter = (terminalId: string, data: string) => Promise<boolean>;
const bridgeWriters = new Map<string, BridgeWriter>();
export function registerBridgeWriter(socketId: string, writer: BridgeWriter): () => void {
  bridgeWriters.set(socketId, writer);
  return () => { if (bridgeWriters.get(socketId) === writer) bridgeWriters.delete(socketId); };
}
export function getBridgeWriter(socketId: string | undefined): BridgeWriter | null {
  return socketId ? bridgeWriters.get(socketId) ?? null : null;
}
