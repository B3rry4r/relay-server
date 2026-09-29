/*
 * Ports that must never be exposed through a public cloudflared tunnel or served
 * as a "preview": relay's own API port, the host's ports, and relay-internal
 * loopback helpers (the UIX loopback proxy for the render harness).
 *
 * A tunnel to relay's own port would make public internet traffic arrive at relay
 * from 127.0.0.1 — cloudflared adds cf-connecting-ip so the local-token check
 * still refuses it, but there is no reason to publish the API a second time, and
 * the internal helpers inject service credentials.
 */
const registered = new Map<number, string>();

export function registerProtectedPort(port: number, label: string): void {
  if (Number.isInteger(port) && port > 0) registered.set(port, label);
}

export function unregisterProtectedPort(port: number): void {
  registered.delete(port);
}

function envPorts(): Map<number, string> {
  const out = new Map<number, string>();
  const port = Number.parseInt(process.env.PORT || '', 10);
  if (Number.isInteger(port) && port > 0) out.set(port, 'relay API (PORT)');
  for (const raw of (process.env.RELAY_HOST_PORTS || '').split(',')) {
    const p = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(p) && p > 0) out.set(p, 'relay host (RELAY_HOST_PORTS)');
  }
  return out;
}

/** Why this port is protected, or null when it may be tunnelled/served. */
export function protectedPortReason(port: number): string | null {
  return registered.get(port) ?? envPorts().get(port) ?? null;
}

export function isProtectedPort(port: number): boolean {
  return protectedPortReason(port) !== null;
}

export class ProtectedPortError extends Error {
  constructor(public readonly port: number, public readonly reason: string) {
    super(`Port ${port} is ${reason} and cannot be tunnelled or served as a preview.`);
    this.name = 'ProtectedPortError';
  }
}
