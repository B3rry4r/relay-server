// Only the ACTIVE release runs the agent tracker (CONTRACTS §3 standby): a
// standby release must not serve agent:* or tail/rotate the shared spool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, type RelayServer } from '../../src/relay-server';
import { activate, resetLifecycleForTests } from '../../src/relay-server/lifecycle';
import type { PtyFactory } from '../../src/relay-server/types';

const fakePty: PtyFactory = () => ({ kill() {}, onData() { return { dispose() {} }; }, resize() {}, write() {} });

describe('agent tracker follows the release lifecycle', () => {
  let ws = '';
  let server: RelayServer | null = null;
  const clients: Socket[] = [];
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-standby-'));
    Object.assign(process.env, { PORT: '0', AUTH_TOKEN: 'test-token', WORKSPACE: ws, RELAY_START_MODE: 'standby', RELAY_LISTEN_HOST: '127.0.0.1' });
    resetLifecycleForTests();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await server?.stop();
    server = null;
    for (const k of ['PORT', 'AUTH_TOKEN', 'WORKSPACE', 'RELAY_START_MODE', 'RELAY_LISTEN_HOST']) delete process.env[k];
    resetLifecycleForTests();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const connect = async (port: number) => {
    const client = createClient(`http://127.0.0.1:${port}`, { auth: { token: 'test-token', noTerminals: true }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(client);
    const names: string[] = [];
    client.onAny((n: string) => names.push(n));
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
    await new Promise((r) => setTimeout(r, 200));
    return { client, names };
  };

  it('standby: no agent:* and no spool dir; after activate: agent:sessions on connect', async () => {
    server = createRelayServer(fakePty);
    const port = await server.start();
    const before = await connect(port);
    expect(before.names).not.toContain('agent:sessions');
    expect(fs.existsSync(path.join(ws, '.relay/state/agent-events'))).toBe(false);
    await activate('test');
    const after = await connect(port);
    expect(after.names).toContain('agent:sessions');
    expect(fs.existsSync(path.join(ws, '.relay/state/agent-events'))).toBe(true);
  });
});
