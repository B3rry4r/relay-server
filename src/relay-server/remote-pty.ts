/*
 * Remote PTY mode — env-toggled proxy to a standalone relay-pty service.
 *
 * When RELAY_PTY_MODE=remote (+ RELAY_PTY_URL), interactive terminal sessions
 * are OWNED by the relay-pty service instead of this process, so a relay-server
 * redeploy reconnects to the SAME live shells (process + scrollback intact).
 *
 * The relay-pty service speaks EXACTLY the terminal socket protocol this
 * server has always exposed to relay-web, so this module is a thin 1:1 event
 * bridge: one upstream socket.io-client connection per client socket, events
 * forwarded verbatim in both directions. relay-web needs zero changes.
 *
 * Default (no env / RELAY_PTY_MODE=embedded): none of this code runs — the
 * embedded in-process PTY path in socket.ts is untouched.
 *
 * Graceful degradation: if remote mode is configured but the service is
 * unreachable we log loudly and surface a clear error on the terminal —
 * we NEVER silently fall back to embedded PTYs, because that would fork
 * terminal state across two owners.
 */

import type { Socket as ServerSocket } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { getSecret } from './auth/secrets';

export function isRemotePtyEnabled(): boolean {
  return (process.env.RELAY_PTY_MODE || 'embedded').trim().toLowerCase() === 'remote';
}

export function getRemotePtyUrl(): string {
  return (process.env.RELAY_PTY_URL || '').trim().replace(/\/+$/, '');
}

let warnedPtyTokenFallback = false;
export function getRemotePtyToken(): string {
  // Secrets are sealed out of process.env at boot (auth/secrets.ts) — read them
  // through getSecret. RELAY_PTY_TOKEN should be set and DISTINCT from the owner
  // secret; the AUTH_TOKEN fallback is kept only so an existing remote-PTY
  // deployment keeps working, and it is loud about it.
  const token = getSecret('RELAY_PTY_TOKEN');
  if (token) return token;
  const fallback = getSecret('AUTH_TOKEN');
  if (fallback && !warnedPtyTokenFallback) {
    warnedPtyTokenFallback = true;
    console.warn('[relay] RELAY_PTY_TOKEN is not set — falling back to AUTH_TOKEN for the PTY service link. Set a distinct RELAY_PTY_TOKEN.');
  }
  return fallback;
}

// Client -> relay -> pty-service (terminal-scoped input events).
export const CLIENT_TO_PTY_EVENTS = [
  'terminal:create',
  'terminal:select',
  'terminal:close',
  'terminal:input',
  'input',
  'resize',
  'cd',
] as const;

// pty-service -> relay -> client (terminal-scoped output events).
export const PTY_TO_CLIENT_EVENTS = [
  'terminals:ready',
  'terminals:updated',
  'terminal:created',
  'terminal:selected',
  'terminal:output',
  'terminal:replay',
  'terminal:closed',
  'output',
  'shell_event',
] as const;

const CLIENT_TO_PTY = new Set<string>(CLIENT_TO_PTY_EVENTS);
const PTY_TO_CLIENT = new Set<string>(PTY_TO_CLIENT_EVENTS);

/**
 * After the PTY service has been unreachable this long, whatever the client
 * typed in the meantime is DISCARDED instead of being flushed into the shell as
 * stale keystrokes when the link comes back (audit a.2 #4).
 */
export function staleInputMs(): number {
  return Number(process.env.RELAY_PTY_STALE_INPUT_MS) || 2000;
}

type UpstreamSocket = ReturnType<typeof ioClient> & { sendBuffer?: unknown[] };

/**
 * Bridge one client socket to the remote PTY service. Returns a disposer that
 * tears down the upstream connection when the client disconnects. The PTY
 * service keeps the sessions alive across our disconnects — exactly like the
 * embedded engine keeps them alive across browser disconnects today.
 *
 * - Every allowlisted event is forwarded with ALL its arguments, and a trailing
 *   ack callback is relayed in both directions (audit a.2 #1).
 * - Each upstream (re)connect sends the CURRENTLY selected terminal, not the one
 *   captured when the browser first connected (a.2 #3).
 * - A PTY-service drop is told to the browser, and input typed during an outage
 *   longer than staleInputMs() is dropped rather than replayed late (a.2 #4).
 */
export function attachRemoteTerminalProxy(socket: ServerSocket): { dispose(): void } {
  const url = getRemotePtyUrl();
  if (!url) {
    console.error('[relay] RELAY_PTY_MODE=remote but RELAY_PTY_URL is not set — terminals are unavailable.');
    socket.emit('output', '\r\n[relay] Remote PTY mode is misconfigured (RELAY_PTY_URL missing). Terminals are unavailable.\r\n');
    return { dispose: () => undefined };
  }

  let activeTerminalId = typeof socket.handshake.auth.activeTerminalId === 'string'
    ? socket.handshake.auth.activeTerminalId
    : '';

  // forceNew: socket.io-client caches managers per URL; without it every
  // browser tab would share ONE upstream socket and cross-route its events.
  const upstream = ioClient(url, {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    // A function: evaluated on EVERY (re)connect, so a PTY-service restart
    // re-selects the terminal the user is on now.
    auth: (cb: (data: object) => void) => cb({
      token: getRemotePtyToken(),
      ...(activeTerminalId ? { activeTerminalId } : {}),
    }),
  }) as UpstreamSocket;

  let disposed = false;
  let everConnected = false;
  let reportedUnreachable = false;
  let outageTimer: ReturnType<typeof setTimeout> | null = null;
  let discardInput = false;
  let discardedWhileDown = 0;
  const lastResize = new Map<string, unknown[]>();

  const notice = (text: string) => {
    if (!disposed && socket.connected) socket.emit('output', `\r\n[relay] ${text}\r\n`);
  };

  upstream.on('connect_error', (error: Error) => {
    console.error(`[relay] REMOTE PTY SERVICE UNREACHABLE at ${url}: ${error.message} — terminals will not work until it is back. NOT falling back to embedded PTYs.`);
    if (!reportedUnreachable) {
      reportedUnreachable = true;
      notice(`Remote PTY service unreachable at ${url} (${error.message}). Terminals are unavailable — retrying in the background.`);
    }
    armOutage();
  });

  upstream.on('disconnect', (reason: string) => {
    if (disposed) return;
    console.warn(`[relay] remote PTY service link dropped (${reason}) — reconnecting`);
    notice(`Terminal service connection lost (${reason}) — reconnecting…`);
    reportedUnreachable = true;
    armOutage();
    // socket.io-client does NOT auto-reconnect after a server-initiated
    // disconnect ('io server disconnect' — e.g. the PTY service shutting down
    // gracefully with io.close()); only transport-level drops are retried. Ask
    // for it explicitly; the manager's backoff handles a service still down.
    if (reason === 'io server disconnect') {
      const retry = setTimeout(() => { if (!disposed && !upstream.connected) upstream.connect(); }, 500);
      retry.unref?.();
    }
  });

  function armOutage(): void {
    if (outageTimer || discardInput) return;
    outageTimer = setTimeout(() => {
      outageTimer = null;
      if (upstream.connected) return;
      // Everything queued so far is stale: drop it, and drop further input
      // until the link is back.
      discardInput = true;
      const buffered = Array.isArray(upstream.sendBuffer) ? upstream.sendBuffer.length : 0;
      if (Array.isArray(upstream.sendBuffer)) upstream.sendBuffer.length = 0;
      discardedWhileDown += buffered;
    }, staleInputMs());
    outageTimer.unref?.();
  }

  upstream.on('connect', () => {
    if (outageTimer) { clearTimeout(outageTimer); outageTimer = null; }
    const wasDown = reportedUnreachable;
    discardInput = false;
    if (wasDown) {
      console.log(`[relay] remote PTY service reconnected at ${url}`);
      notice(discardedWhileDown > 0
        ? `Terminal service reconnected (${discardedWhileDown} input event(s) typed during the outage were discarded).`
        : 'Terminal service reconnected.');
      reportedUnreachable = false;
      discardedWhileDown = 0;
    }
    // A restarted PTY service has fresh per-socket resize state: re-send the
    // sizes this client last asked for so TUIs are not left at 80x24.
    if (everConnected) for (const args of lastResize.values()) upstream.emit('resize', ...args);
    everConnected = true;
  });

  upstream.onAny((event: string, ...args: unknown[]) => {
    if (!PTY_TO_CLIENT.has(event)) return;
    if (event === 'terminal:selected') {
      const id = (args[0] as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && id) activeTerminalId = id;
    }
    socket.emit(event, ...args);
  });

  socket.onAny((event: string, ...args: unknown[]) => {
    if (!CLIENT_TO_PTY.has(event)) return;
    if (event === 'terminal:select') {
      const id = (args[0] as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && id) activeTerminalId = id;
    }
    if (event === 'resize') {
      const payload = args[0] as { id?: unknown } | undefined;
      const key = typeof payload?.id === 'string' ? payload.id : '';
      lastResize.set(key, args.filter((a) => typeof a !== 'function'));
    }
    if (discardInput && !upstream.connected) {
      discardedWhileDown += 1;
      const ack = args[args.length - 1];
      if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, error: 'pty_unavailable' });
      return;
    }
    // socket.io-client buffers emits until connected, so events sent while the
    // upstream is briefly handshaking are delivered, not dropped. A trailing
    // function is socket.io's ack: pass it through as the upstream ack.
    upstream.emit(event, ...args);
  });

  return {
    dispose: () => {
      disposed = true;
      if (outageTimer) clearTimeout(outageTimer);
      try { upstream.close(); } catch { /* already closed */ }
    },
  };
}

export type RemoteTerminalSummary = {
  id: string;
  cwd: string;
  pid: number;
  createdAt: number;
};

/** Fetch the live terminal list from the remote PTY service (GET /api/terminals). */
export async function fetchRemoteTerminals(timeoutMs = 4000): Promise<RemoteTerminalSummary[]> {
  const url = getRemotePtyUrl();
  if (!url) throw new Error('RELAY_PTY_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/terminals`, {
      headers: { 'x-auth-token': getRemotePtyToken() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`PTY service responded ${response.status}`);
    }
    const body = await response.json() as { terminals?: RemoteTerminalSummary[] };
    return Array.isArray(body.terminals) ? body.terminals : [];
  } finally {
    clearTimeout(timer);
  }
}
