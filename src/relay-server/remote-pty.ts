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

export function isRemotePtyEnabled(): boolean {
  return (process.env.RELAY_PTY_MODE || 'embedded').trim().toLowerCase() === 'remote';
}

export function getRemotePtyUrl(): string {
  return (process.env.RELAY_PTY_URL || '').trim().replace(/\/+$/, '');
}

export function getRemotePtyToken(): string {
  return process.env.RELAY_PTY_TOKEN || process.env.AUTH_TOKEN || '';
}

// Client -> relay -> pty-service (terminal-scoped input events).
const CLIENT_TO_PTY_EVENTS = [
  'terminal:create',
  'terminal:select',
  'terminal:close',
  'input',
  'resize',
  'cd',
] as const;

// pty-service -> relay -> client (terminal-scoped output events).
const PTY_TO_CLIENT_EVENTS = [
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

/**
 * Bridge one client socket to the remote PTY service. Returns a disposer that
 * tears down the upstream connection when the client disconnects. The PTY
 * service keeps the sessions alive across our disconnects — exactly like the
 * embedded engine keeps them alive across browser disconnects today.
 */
export function attachRemoteTerminalProxy(socket: ServerSocket): { dispose(): void } {
  const url = getRemotePtyUrl();
  if (!url) {
    console.error('[relay] RELAY_PTY_MODE=remote but RELAY_PTY_URL is not set — terminals are unavailable.');
    socket.emit('output', '\r\n[relay] Remote PTY mode is misconfigured (RELAY_PTY_URL missing). Terminals are unavailable.\r\n');
    return { dispose: () => undefined };
  }

  const activeTerminalId = typeof socket.handshake.auth.activeTerminalId === 'string'
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
    auth: {
      token: getRemotePtyToken(),
      ...(activeTerminalId ? { activeTerminalId } : {}),
    },
  });

  let reportedUnreachable = false;
  upstream.on('connect_error', (error: Error) => {
    console.error(`[relay] REMOTE PTY SERVICE UNREACHABLE at ${url}: ${error.message} — terminals will not work until it is back. NOT falling back to embedded PTYs.`);
    if (!reportedUnreachable) {
      reportedUnreachable = true;
      socket.emit('output', `\r\n[relay] Remote PTY service unreachable at ${url} (${error.message}). Terminals are unavailable — retrying in the background.\r\n`);
    }
  });
  upstream.on('connect', () => {
    if (reportedUnreachable) {
      console.log(`[relay] remote PTY service reconnected at ${url}`);
      reportedUnreachable = false;
    }
  });

  for (const event of PTY_TO_CLIENT_EVENTS) {
    upstream.on(event, (payload: unknown) => socket.emit(event, payload));
  }
  for (const event of CLIENT_TO_PTY_EVENTS) {
    // socket.io-client buffers emits until connected, so events sent while the
    // upstream is still handshaking are delivered, not dropped.
    socket.on(event, (payload: unknown) => upstream.emit(event, payload));
  }

  return {
    dispose: () => {
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
