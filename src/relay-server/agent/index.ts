/*
 * Agent view (agent-display-spec) — wiring for createRelayServer.
 */
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import { fetchRemoteTerminals, isRemotePtyEnabled } from '../remote-pty';
import { getRelayStateRoot, resolveWorkspace } from '../runtime';
import { getActiveTerminals } from '../socket';
import { PtyServiceLink } from './service-link';
import { registerAgentSocketHandlers } from './socket';
import { AgentTracker, type TerminalInfo } from './tracker';

export { AgentTracker } from './tracker';
export type * from './types';

export function agentSpoolDir(workspace = resolveWorkspace()): string {
  return path.join(getRelayStateRoot(workspace), 'agent-events');
}

export interface AgentRuntime {
  tracker: AgentTracker;
  start(): Promise<void>;
  stop(): void;
}

/** RELAY_AGENT_VIEW=off disables the tracker (the socket events then never fire). */
export function isAgentViewEnabled(): boolean {
  return (process.env.RELAY_AGENT_VIEW || '').trim().toLowerCase() !== 'off';
}

export function createAgentRuntime(io: SocketIOServer): AgentRuntime {
  const workspace = resolveWorkspace();
  const remote = isRemotePtyEnabled();
  const listTerminals = async (): Promise<TerminalInfo[]> => {
    if (remote) return (await fetchRemoteTerminals()).map((t) => ({ id: t.id, pid: t.pid, cwd: t.cwd }));
    return getActiveTerminals().map((t) => ({ id: t.id, pid: t.pid, cwd: t.cwd }));
  };
  const tracker = new AgentTracker({
    workspace,
    spoolDir: agentSpoolDir(workspace),
    mode: remote ? 'remote' : 'embedded',
    listTerminals,
    serviceLink: remote ? new PtyServiceLink() : null,
  });
  let unregister: (() => void) | null = null;
  return {
    tracker,
    async start() {
      if (!isAgentViewEnabled()) return;
      unregister = registerAgentSocketHandlers(io, tracker);
      await tracker.start();
    },
    stop() {
      unregister?.();
      unregister = null;
      tracker.stop();
    },
  };
}
