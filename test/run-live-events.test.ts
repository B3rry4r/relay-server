// T18: prove whole-app run activity is PUSHED live over the WebSocket (no poll).
//  1. A connected socket.io client receives `run:log` + `run:state` the instant
//     emitRunEvent fires (server → socket.ts subscribeRunEvents → io.emit).
//  2. summarizeRunScreens rolls screen statuses into the {built,total,...} the
//     live header/counter use.
//  3. The phase-based header reads "Phase 1/7: Assets — naming 197 assets",
//     NOT "Built 0/20", and falls back to "Building 3/20: <frame>" on build-screens.

import { afterEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, FakePty, type RelayServer } from '../src/relay-server';
import { emitRunEvent } from '../src/relay-server/run-events';
import { summarizeRunScreens, type RunPhase, type RunScreen } from '../src/relay-server/build-run-store';

// Mirror of relay-web's phaseHeader (useGeneration.ts) — kept in the test so the
// header contract is asserted server-side too (the two must stay in lock-step).
function phaseHeader(
  phase: RunPhase | undefined,
  counts: { built: number; total: number; review: number; buildingName?: string },
): string | null {
  if (!phase || !phase.total) return null;
  const { built, total, review, buildingName } = counts;
  const reviewTail = review ? ` · ${review} to review` : '';
  if (/build\s*screens?/i.test(phase.name) && buildingName) {
    return `Building ${Math.min(built + 1, total)}/${total}: ${buildingName}${reviewTail}`;
  }
  const detail = phase.detail ? ` — ${phase.detail}` : '';
  return `Phase ${phase.index}/${phase.total}: ${phase.name}${detail}`;
}

function once<T>(client: Socket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    client.once(event, (payload: T) => { clearTimeout(t); resolve(payload); });
  });
}

describe('T18 — live run events', () => {
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];

  afterEach(async () => {
    while (clients.length) clients.pop()?.disconnect();
    while (servers.length) await servers.pop()?.stop();
    delete process.env.PORT;
    delete process.env.AUTH_TOKEN;
  });

  async function bootClient(): Promise<Socket> {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const client = createClient(`http://127.0.0.1:${port}`, {
      auth: { token: 'test-token' }, reconnection: false, transports: ['websocket'],
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    return client;
  }

  it('pushes run:log to a connected client the instant appendRunLog emits', async () => {
    const client = await bootClient();
    const got = once<{ projectId: string; runId: string; line: string }>(client, 'run:log');
    // This is exactly what appendRunLog emits before the file write.
    emitRunEvent({ type: 'run:log', projectId: 'proj-1', runId: 'run-1', line: '[assets] naming 197 asset(s)' });
    const payload = await got;
    expect(payload).toEqual({ projectId: 'proj-1', runId: 'run-1', line: '[assets] naming 197 asset(s)' });
  });

  it('pushes run:state (phase / status / ai / counts) live', async () => {
    const client = await bootClient();
    const got = once<{
      projectId: string; runId: string; phase?: RunPhase; status?: string;
      ai?: { ok: number; failed: number }; built: number; total: number; needsReview: number; failed: number;
    }>(client, 'run:state');
    emitRunEvent({
      type: 'run:state', projectId: 'proj-1', runId: 'run-1',
      phase: { index: 1, total: 7, name: 'Assets', detail: 'naming 197 assets' },
      status: 'running', ai: { ok: 3, failed: 0 },
      built: 0, total: 20, needsReview: 0, failed: 0,
    });
    const payload = await got;
    expect(payload.phase).toEqual({ index: 1, total: 7, name: 'Assets', detail: 'naming 197 assets' });
    expect(payload.status).toBe('running');
    expect(payload.ai).toEqual({ ok: 3, failed: 0 });
    expect(payload.total).toBe(20);
    expect(payload.built).toBe(0);
  });

  it('summarizeRunScreens rolls statuses into built/total/needsReview/failed', () => {
    const screens: RunScreen[] = [
      { frameId: 'a', frameName: 'A', status: 'done' },
      { frameId: 'b', frameName: 'B', status: 'done' },
      { frameId: 'c', frameName: 'C', status: 'needs-review' },
      { frameId: 'd', frameName: 'D', status: 'failed' },
      { frameId: 'e', frameName: 'E', status: 'building' },
      { frameId: 'f', frameName: 'F', status: 'pending' },
    ];
    expect(summarizeRunScreens(screens)).toEqual({ built: 2, total: 6, needsReview: 1, failed: 1 });
  });

  it('header shows the PHASE during prep/assets, not "Built 0/20"', () => {
    const phase: RunPhase = { index: 1, total: 7, name: 'Assets', detail: 'naming 197 assets' };
    const header = phaseHeader(phase, { built: 0, total: 20, review: 0 });
    expect(header).toBe('Phase 1/7: Assets — naming 197 assets');
    expect(header).not.toContain('Built 0');
  });

  it('header falls back to "Building k/total: <frame>" on the build-screens phase', () => {
    const phase: RunPhase = { index: 5, total: 7, name: 'Build screens', detail: 'screen 3/20' };
    const header = phaseHeader(phase, { built: 2, total: 20, review: 0, buildingName: 'Checkout' });
    expect(header).toBe('Building 3/20: Checkout');
  });
});
