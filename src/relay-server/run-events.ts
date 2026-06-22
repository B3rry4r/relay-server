// =============================================================================
// File: src/relay-server/run-events.ts
//
// T18: live run-level pub/sub so the socket layer can PUSH whole-app build
// activity over WebSocket instead of the client polling .uix/runs/<id>.log every
// 4-8s. The durable run store (build-run-store.ts) emits here:
//   • `run:log`   — one human-readable run-log line ([prep], [canon], [assets],
//                   [screen X] ACCEPTED, [ai:…], warnings) the instant it is written.
//   • `run:state` — the run's phase / status / AI tally / screen-count summary the
//                   instant any of them change.
// socket.ts subscribes ONCE and broadcasts to connected clients (single-user
// relay); the client filters by projectId/runId. Best-effort: a listener throwing
// must NEVER break a run — emits are wrapped + swallowed.
// =============================================================================

import type { RunPhase, RunStatus } from './build-run-store';

/** A single run-log line, pushed the instant build-run-store appends it. */
export interface RunLogEvent {
  type: 'run:log';
  projectId: string;
  runId: string;
  line: string;
}

/** A snapshot of the run's live state (phase / status / AI tally / counts),
 *  pushed the instant any of them change. */
export interface RunStateEvent {
  type: 'run:state';
  projectId: string;
  runId: string;
  phase?: RunPhase;
  status?: RunStatus;
  ai?: { ok: number; failed: number };
  built: number;        // screens done
  total: number;        // total screens in the run
  needsReview: number;  // screens needs-review
  failed: number;       // screens failed
}

export type RunEvent = RunLogEvent | RunStateEvent;

const listeners = new Set<(e: RunEvent) => void>();

/** Subscribe to live run events (socket.ts subscribes once). Returns an unsub. */
export function subscribeRunEvents(cb: (e: RunEvent) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Emit a run event to all subscribers. Best-effort: never throws. */
export function emitRunEvent(e: RunEvent): void {
  for (const l of listeners) {
    try { l(e); } catch { /* a bad listener must never break a run */ }
  }
}
