/*
 * agent:* socket protocol (agent-display-spec §7). Emitted by relay-server's OWN
 * io — never through the remote-PTY bridge — and registered for every
 * authenticated socket, including Option-B sockets (auth.noTerminals:true).
 *
 * server → client: agent:sessions, agent:snapshot, agent:event, agent:events
 * client → server: agent:subscribe, agent:unsubscribe, agent:history,
 *                  agent:respond (guarded), agent:choose, agent:send,
 *                  agent:interrupt, agent:bind (ambiguous-session picker)
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AgentTracker } from './tracker';
import type { AgentAck, AgentEvent, PermissionChoice } from './types';

const room = (terminalId: string) => `agent:${terminalId}`;
const CHOICES = new Set<PermissionChoice>(['allow_once', 'allow_always', 'deny']);

type Ack = (result: unknown) => void;
const ackOf = (args: unknown[]): Ack => {
  const last = args[args.length - 1];
  return typeof last === 'function' ? last as Ack : () => undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function registerAgentSocketHandlers(io: SocketIOServer, tracker: AgentTracker): () => void {
  // live events → subscribers of that terminal only
  const onEvent = (terminalId: string, event: AgentEvent) => {
    io.to(room(terminalId)).emit('agent:event', { epoch: tracker.epoch, terminalId, event });
  };
  // session list → everyone, debounced 100 ms, only when it changed
  let sessionsTimer: NodeJS.Timeout | null = null;
  let lastSessions = '';
  const onSessions = () => {
    if (sessionsTimer) return;
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null;
      const sessions = tracker.sessions();
      const json = JSON.stringify(sessions);
      if (json === lastSessions) return;
      lastSessions = json;
      io.emit('agent:sessions', { epoch: tracker.epoch, sessions });
    }, 100);
    sessionsTimer.unref?.();
  };
  tracker.on('event', onEvent);
  tracker.on('sessions', onSessions);

  const onConnection = (socket: Socket) => {
    socket.emit('agent:sessions', { epoch: tracker.epoch, sessions: tracker.sessions() });

    socket.on('agent:subscribe', async (payload: { terminalId?: unknown; epoch?: unknown; sinceSeq?: unknown } = {}, ...rest: unknown[]) => {
      const ack = ackOf([payload, ...rest]);
      const terminalId = str(payload?.terminalId);
      if (!terminalId) { ack({ ok: false, reason: 'invalid' }); return; }
      if (!tracker.hasTerminal(terminalId)) await tracker.refreshTerminals();
      await socket.join(room(terminalId));
      ack({ ok: true });
      const sinceSeq = Number(payload?.sinceSeq);
      if (payload?.epoch === tracker.epoch && Number.isInteger(sinceSeq) && sinceSeq >= 0) {
        const delta = tracker.delta(terminalId, sinceSeq);
        if (delta) { socket.emit('agent:events', { epoch: tracker.epoch, terminalId, events: delta }); return; }
      }
      socket.emit('agent:snapshot', { epoch: tracker.epoch, terminalId, ...tracker.snapshot(terminalId) });
    });

    socket.on('agent:unsubscribe', (payload: { terminalId?: unknown } = {}) => {
      const terminalId = str(payload?.terminalId);
      if (terminalId) void socket.leave(room(terminalId));
    });

    socket.on('agent:history', (payload: { terminalId?: unknown; beforeSeq?: unknown; limit?: unknown } = {}, ...rest: unknown[]) => {
      const ack = ackOf([payload, ...rest]);
      const terminalId = str(payload?.terminalId);
      const beforeSeq = Number(payload?.beforeSeq);
      if (!terminalId || !Number.isFinite(beforeSeq)) { ack({ ok: false, reason: 'invalid' }); return; }
      const events = tracker.history(terminalId, beforeSeq, Number(payload?.limit) || 200);
      socket.emit('agent:events', { epoch: tracker.epoch, terminalId, events });
      ack({ ok: true });
    });

    const action = (name: string, run: (p: Record<string, unknown>) => Promise<AgentAck>) => {
      socket.on(name, async (payload: Record<string, unknown> = {}, ...rest: unknown[]) => {
        const ack = ackOf([payload, ...rest]);
        try {
          ack(await run(payload && typeof payload === 'object' ? payload : {}));
        } catch (error) {
          console.error(`[agent] ${name} failed:`, error);
          ack({ ok: false, reason: 'error' });
        }
      });
    };

    action('agent:respond', async (p) => {
      const choice = str(p.choice) as PermissionChoice;
      if (!str(p.terminalId) || !str(p.requestId) || !CHOICES.has(choice)) return { ok: false, reason: 'invalid' };
      return tracker.respond(str(p.terminalId), str(p.requestId), choice, socket.id);
    });
    action('agent:send', async (p) => tracker.send(str(p.terminalId), str(p.text), socket.id));
    action('agent:choose', async (p) => {
      const n = Number(p.optionN);
      if (!Number.isInteger(n)) return { ok: false, reason: 'invalid' };
      return tracker.choose(str(p.terminalId), str(p.eventId), n, socket.id);
    });
    action('agent:interrupt', async (p) => tracker.interrupt(str(p.terminalId), socket.id));
    action('agent:bind', async (p) => tracker.bind(str(p.terminalId), str(p.sessionId)));
  };
  io.on('connection', onConnection);

  return () => {
    tracker.off('event', onEvent);
    tracker.off('sessions', onSessions);
    io.off('connection', onConnection);
    if (sessionsTimer) clearTimeout(sessionsTimer);
  };
}
