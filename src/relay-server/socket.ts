import type { Server as SocketIOServer } from 'socket.io';
import type { PtyFactory, PtyLike, TerminalSession } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';
import {
  createTerminalEnv,
  exists,
  getRelayTerminalSessionsPath,
  isValidToken,
  readJsonFile,
  resolveProjectRoot,
  resolveShell,
  resolveWorkspace,
  writeJsonFile,
} from './runtime';
import {
  createShellTranscriptState,
  handleShellOutput,
  handleTerminalInput,
} from './transcript';
import { ScrollbackBuffer } from './scrollback';

const activeShells = new Map<string, PtyLike>();
const terminalSessions = new Map<string, TerminalSession>();
// Side map: active in-memory scrollback ring buffers keyed by terminal id.
// We keep TerminalSession.scrollback as the persisted-string snapshot but
// stop appending to it on every onData chunk — that O(n²) string concat was
// the main cause of "terminal freezes during AI streaming".
const scrollbackBuffers = new Map<string, ScrollbackBuffer>();
const MAX_SCROLLBACK_BYTES = 1024 * 1024;

// Persistent exit handlers keyed by terminalId — these are NOT cleaned up on
// socket disconnect so we can detect PTY process death even while no client
// is connected.  Without this, the handler is disposed on disconnect; when the
// process exits while disconnected the zombie session stays in terminalSessions;
// on the next reconnect a new listener is registered on the dying process and
// fires ~80ms later, producing the "terminal force-closed on reopen" bug.
const persistentExitHandlers = new Map<string, { dispose(): void }>();

// Check whether the underlying OS process is still running (signal 0 = no-op).
function isShellAlive(shell: PtyLike): boolean {
  const pid = shell.pid;
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
let lastSelectedTerminalId: string | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let restorePromise: Promise<void> | null = null;
let suppressTerminalPersistence = false;

type PersistedTerminalSession = Pick<TerminalSession, 'id' | 'createdAt' | 'cwd' | 'scrollback'>;
type PersistedTerminalState = {
  lastSelectedTerminalId: string | null;
  sessions: PersistedTerminalSession[];
};

function snapshotTerminalState(): PersistedTerminalState {
  return {
    lastSelectedTerminalId,
    sessions: getActiveTerminals().map((session) => {
      const buffer = scrollbackBuffers.get(session.id);
      const scrollback = buffer
        ? buffer.toString()
        : session.scrollback.slice(-MAX_SCROLLBACK_BYTES);
      return {
        id: session.id,
        createdAt: session.createdAt,
        cwd: session.cwd,
        scrollback,
      };
    }),
  };
}

export async function persistTerminalState(): Promise<void> {
  if (suppressTerminalPersistence) {
    return;
  }
  await writeJsonFile(getRelayTerminalSessionsPath(resolveWorkspace()), snapshotTerminalState());
}

export function setTerminalPersistenceSuppressed(value: boolean): void {
  suppressTerminalPersistence = value;
}

function schedulePersistTerminalState(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistTerminalState().catch(() => undefined);
  }, 250);
}

async function restorePersistedTerminalSessions(ptyFactory: PtyFactory): Promise<void> {
  if (restorePromise) {
    await restorePromise;
    return;
  }

  restorePromise = (async () => {
    const workspaceRoot = resolveWorkspace();
    const state = await readJsonFile<PersistedTerminalState | null>(
      getRelayTerminalSessionsPath(workspaceRoot),
      null,
    );

    if (!state?.sessions?.length) {
      lastSelectedTerminalId = state?.lastSelectedTerminalId ?? null;
      return;
    }

    for (const persisted of state.sessions) {
      const session = createTerminalSession(persisted.id, ptyFactory, persisted.cwd || workspaceRoot, workspaceRoot);
      if (session) {
        session.createdAt = persisted.createdAt || session.createdAt;
        const restored = (persisted.scrollback || '').slice(-MAX_SCROLLBACK_BYTES);
        session.scrollback = restored;
        scrollbackBuffers.get(persisted.id)?.reset(restored);
      }
    }

    lastSelectedTerminalId = state.lastSelectedTerminalId && terminalSessions.has(state.lastSelectedTerminalId)
      ? state.lastSelectedTerminalId
      : getActiveTerminals().sort((left, right) => right.createdAt - left.createdAt)[0]?.id ?? null;
  })();

  await restorePromise;
}

export function getActiveTerminals(): TerminalSession[] {
  return Array.from(terminalSessions.values());
}

function getTerminalSummaries(): Array<Omit<TerminalSession, 'scrollback'>> {
  return getActiveTerminals().map(({ scrollback: _scrollback, ...session }) => session);
}

export function createTerminalSession(
  terminalId: string,
  ptyFactory: PtyFactory,
  cwd: string,
  workspaceRoot: string
): TerminalSession | null {
  let shell: PtyLike;
  try {
    shell = ptyFactory({
      command: resolveShell(),
      cols: DEFAULT_COLS,
      cwd,
      env: createTerminalEnv(workspaceRoot),
      rows: DEFAULT_ROWS,
    });
  } catch {
    return null;
  }

  const session: TerminalSession = {
    id: terminalId,
    createdAt: Date.now(),
    cwd,
    pid: shell.pid || 0,
    scrollback: '',
  };

  activeShells.set(terminalId, shell);
  terminalSessions.set(terminalId, session);
  scrollbackBuffers.set(terminalId, new ScrollbackBuffer(MAX_SCROLLBACK_BYTES));
  schedulePersistTerminalState();

  return session;
}

export function closeTerminalSession(terminalId: string, skipPersist = false): void {
  // Dispose the persistent exit handler FIRST so that shell.kill() below
  // does not re-trigger onTerminalExit through the still-registered listener.
  const exitHandler = persistentExitHandlers.get(terminalId);
  persistentExitHandlers.delete(terminalId);
  exitHandler?.dispose();

  const shell = activeShells.get(terminalId);
  activeShells.delete(terminalId);
  terminalSessions.delete(terminalId);
  scrollbackBuffers.delete(terminalId);
  if (shell) {
    shell.kill();
  }
  if (!skipPersist) {
    schedulePersistTerminalState();
  }
}

export function closeAllTerminalSessions(skipPersist = false): void {
  for (const terminalId of Array.from(terminalSessions.keys())) {
    closeTerminalSession(terminalId, skipPersist);
  }
}

export async function restoreTerminalSessions(ptyFactory: PtyFactory): Promise<void> {
  await restorePersistedTerminalSessions(ptyFactory);
}

export function resetTerminalPersistenceRuntime(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  restorePromise = null;
  lastSelectedTerminalId = null;
  suppressTerminalPersistence = false;
}

export function registerSocketHandlers(
  io: SocketIOServer,
  ptyFactory: PtyFactory
): void {
  io.use((socket, next) => {
    const authToken = typeof socket.handshake.auth.token === 'string'
      ? socket.handshake.auth.token
      : '';
    if (!isValidToken(authToken)) {
      next(new Error('Unauthorized'));
      return;
    }
    next();
  });

  io.on('connection', (socket) => {
    const workspaceRoot = resolveWorkspace();
    const transcript = createShellTranscriptState(workspaceRoot);
    let selectedTerminalId: string | null = null;
    const disposables: Array<{ dispose(): void }> = [];
    const boundTerminalIds = new Set<string>();

    const getShell = (): PtyLike | null => {
      const fallbackId =
        selectedTerminalId
        ?? lastSelectedTerminalId
        ?? getActiveTerminals().sort((left, right) => right.createdAt - left.createdAt)[0]?.id
        ?? null;
      if (!fallbackId) return null;
      selectedTerminalId = fallbackId;
      lastSelectedTerminalId = fallbackId;
      return activeShells.get(fallbackId) || null;
    };

    const replayTerminal = (terminalId: string): void => {
      const buffer = scrollbackBuffers.get(terminalId);
      const raw = buffer ? buffer.toString() : terminalSessions.get(terminalId)?.scrollback ?? '';
      if (!raw) return;
      // Cap replay at 128 KB. The in-memory scrollback is up to 1 MB but
      // sending the full buffer on every reconnect wastes bandwidth and
      // slows the initial paint. 128 KB covers ~1500 typical lines —
      // far more than the viewport needs to show a useful history.
      const MAX_REPLAY_BYTES = 128 * 1024;
      const data = raw.length > MAX_REPLAY_BYTES ? raw.slice(raw.length - MAX_REPLAY_BYTES) : raw;
      socket.emit('terminal:replay', { id: terminalId, data });
    };

    const bindShellToSocket = (terminalId: string, shell: PtyLike): void => {
      if (boundTerminalIds.has(terminalId)) return;

      // Liveness guard: if the underlying PTY process has already exited while
      // disconnected, trigger cleanup now instead of binding listeners to a corpse
      // and watching the terminal close ~80ms after it appears.
      if (!isShellAlive(shell)) {
        setTimeout(() => onTerminalExit(terminalId), 0);
        return;
      }

      boundTerminalIds.add(terminalId);

      // Coalesce rapid successive data events into a single socket emit.
      // node-pty fires onData many times per second when AI CLI tools stream
      // output (claude, gemini, etc.).  Emitting one WebSocket frame per PTY
      // chunk causes head-of-line blocking on the socket and makes the output
      // appear slow and choppy — exactly like "broken internet".  Batching
      // within a 8 ms window keeps latency imperceptible while drastically
      // reducing the number of frames in flight.
      //
      // Hard cap: if the accumulated chunk exceeds 64 KB we flush immediately
      // rather than waiting for the timer. Without this cap, commands that dump
      // megabytes of output (e.g. `history` on a large bash history file) send
      // a single multi-MB WebSocket frame, causing xterm.js to block the
      // browser's main thread and freeze the entire tab.
      const MAX_PENDING_BYTES = 64 * 1024;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingChunk = '';
      // Track bytes accumulated since last disk persist to avoid hammering the
      // filesystem on every chunk during heavy AI streaming (opencode, claude,
      // gemini, etc.).  Scheduling a persist on every chunk means hundreds of
      // 250ms-debounced writeFile calls per second, which competes with the PTY
      // and is the primary cause of the "stuck / can't type" freeze.
      let bytesSinceLastPersist = 0;
      const PERSIST_AFTER_BYTES = 8192; // ~8 KB of new output between persists

      const flushPending = (): void => {
        flushTimer = null;
        if (!pendingChunk) return;
        const chunk = pendingChunk;
        pendingChunk = '';
        // MULTIPLEX: stream EVERY terminal's output tagged by id, so split /
        // background terminals stay live (not just the focused one). The client
        // routes by id. Shell-event parsing (cwd tracking) only for the focused
        // terminal, where input is routed.
        socket.emit('terminal:output', { id: terminalId, data: chunk });
        if (selectedTerminalId === terminalId) {
          handleShellOutput(socket, transcript, chunk);
        }
      };

      const dataDisposable = shell.onData((data: string) => {
        const buffer = scrollbackBuffers.get(terminalId);
        if (buffer) {
          // O(chunk.length) ring-buffer append — replaces the previous
          // `session.scrollback = ${session.scrollback}${data}.slice(-N)`
          // pattern which allocated and copied the full buffer on every
          // chunk and was the main cause of GC-induced terminal freezes
          // during AI tool streaming.
          buffer.append(data);
          bytesSinceLastPersist += data.length;
          if (bytesSinceLastPersist >= PERSIST_AFTER_BYTES) {
            bytesSinceLastPersist = 0;
            schedulePersistTerminalState();
          }
        }
        // Batch + emit for EVERY terminal (multiplex), not just the focused one.
        pendingChunk += data;
        if (pendingChunk.length >= MAX_PENDING_BYTES) {
          // Flush immediately to avoid a single huge WS frame.
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flushPending();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flushPending, 8);
        }
      });
      if (dataDisposable) disposables.push(dataDisposable);

      // Flush pending output and do a final scrollback persist on dispose.
      const flushDisposable = {
        dispose: () => {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flushPending();
          if (bytesSinceLastPersist > 0) {
            bytesSinceLastPersist = 0;
            schedulePersistTerminalState();
          }
        },
      };
      disposables.push(flushDisposable);

      // Register the exit handler persistently (module-level, NOT in socket
      // disposables).  This ensures that if the PTY exits while the socket is
      // disconnected, onTerminalExit still runs and cleans up the zombie session.
      // We guard with persistentExitHandlers.has() so we only register once even
      // if multiple sockets reconnect before the terminal exits.
      if (typeof shell.onExit === 'function' && !persistentExitHandlers.has(terminalId)) {
        const exitDisposable = shell.onExit(() => {
          persistentExitHandlers.delete(terminalId);
          onTerminalExit(terminalId);
        });
        if (exitDisposable) persistentExitHandlers.set(terminalId, exitDisposable);
        // Intentionally NOT pushed to socket-scoped disposables.
      }
    };

    const onTerminalExit = (terminalId: string) => {
      closeTerminalSession(terminalId, suppressTerminalPersistence);
      if (selectedTerminalId === terminalId) selectedTerminalId = null;
      if (lastSelectedTerminalId === terminalId) {
        lastSelectedTerminalId = getActiveTerminals()
          .sort((left, right) => right.createdAt - left.createdAt)[0]?.id ?? null;
      }
      socket.emit('terminal:closed', { id: terminalId });

      // Auto-respawn: if all terminals are gone (process crashed / exited on its
      // own), immediately create a fresh shell so the user is never left without
      // a terminal.  Explicit user-initiated closes (terminal:close event) already
      // handle this case themselves; here we cover unexpected exits.
      if (terminalSessions.size === 0 && socket.connected) {
        const newId = socket.id + '-' + Date.now();
        const session = createTerminalSession(newId, ptyFactory, workspaceRoot, workspaceRoot);
        if (session) {
          selectedTerminalId = newId;
          lastSelectedTerminalId = newId;
          const newShell = activeShells.get(newId);
          if (newShell) bindShellToSocket(newId, newShell);
          socket.emit('terminal:created', session);
          socket.emit('terminal:selected', { id: newId, cwd: session.cwd });
          socket.emit('terminals:updated', { terminals: getTerminalSummaries() });
          schedulePersistTerminalState();
          return; // terminals:updated already sent above
        }
      }

      socket.emit('terminals:updated', { terminals: getTerminalSummaries() });
      schedulePersistTerminalState();
    };

    const existing = getActiveTerminals();
    if (existing.length > 0) {
      for (const session of existing) {
        const shell = activeShells.get(session.id);
        if (shell) {
          bindShellToSocket(session.id, shell);
        }
      }
      const requestedTerminalId = typeof socket.handshake.auth.activeTerminalId === 'string'
        ? socket.handshake.auth.activeTerminalId
        : '';
      const selectedSession =
        existing.find((session) => session.id === requestedTerminalId) ??
        existing.find((session) => session.id === lastSelectedTerminalId) ??
        existing.sort((left, right) => right.createdAt - left.createdAt)[0];
      selectedTerminalId = selectedSession.id;
      lastSelectedTerminalId = selectedTerminalId;
      socket.emit('terminals:ready', { terminals: getTerminalSummaries() });
      socket.emit('terminal:selected', { id: selectedTerminalId, cwd: selectedSession.cwd });
      // MULTIPLEX: seed EVERY terminal's host with its scrollback (each replay
      // does clear+reseed on the client), since all of them now stream live.
      for (const session of existing) replayTerminal(session.id);
    } else {
      const terminalId = socket.id + '-' + Date.now();
      const session = createTerminalSession(terminalId, ptyFactory, workspaceRoot, workspaceRoot);

      if (session) {
        selectedTerminalId = terminalId;
        lastSelectedTerminalId = terminalId;
        const shell = activeShells.get(terminalId);
        if (shell) {
          bindShellToSocket(terminalId, shell);
        }
        socket.emit('terminals:ready', { terminals: getTerminalSummaries() });
        socket.emit('terminal:created', session);
        socket.emit('terminal:selected', { id: terminalId, cwd: session.cwd });
      } else {
        socket.emit('output', '\r\n[relay] Failed to start shell\r\n');
        socket.disconnect(true);
      }
    }

    socket.on('terminal:create', (_payload: { cwd?: string }) => {
      const terminalId = socket.id + '-' + Date.now();
      const targetCwd = _payload?.cwd || workspaceRoot;
      const session = createTerminalSession(terminalId, ptyFactory, targetCwd, workspaceRoot);

      if (session) {
        const shell = activeShells.get(terminalId);
        if (shell) {
          bindShellToSocket(terminalId, shell);
        }

        selectedTerminalId = terminalId;
        lastSelectedTerminalId = terminalId;
        socket.emit('terminal:created', session);
        socket.emit('terminal:selected', { id: terminalId, cwd: session.cwd });
        socket.emit('terminals:updated', { terminals: getTerminalSummaries() });
      } else {
        socket.emit('output', '\r\n[relay] Failed to start shell\r\n');
      }
    });

    socket.on('terminal:select', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId && terminalSessions.has(terminalId)) {
        selectedTerminalId = terminalId;
        lastSelectedTerminalId = terminalId;
        const session = terminalSessions.get(terminalId);
        socket.emit('terminal:selected', {
          id: terminalId,
          cwd: session?.cwd,
        });
        replayTerminal(terminalId);
        schedulePersistTerminalState();
      }
    });

    socket.on('terminal:close', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (!terminalId || !terminalSessions.has(terminalId)) return;

      const wasSelected = selectedTerminalId === terminalId;
      onTerminalExit(terminalId);

      if (terminalSessions.size === 0) {
        // No terminals left — spawn a fresh one so the user always has a shell.
        const newId = socket.id + '-' + Date.now();
        const session = createTerminalSession(newId, ptyFactory, workspaceRoot, workspaceRoot);
        if (session) {
          selectedTerminalId = newId;
          lastSelectedTerminalId = newId;
          const shell = activeShells.get(newId);
          if (shell) {
            bindShellToSocket(newId, shell);
          }
          socket.emit('terminal:created', session);
          socket.emit('terminal:selected', { id: newId, cwd: session.cwd });
          socket.emit('terminals:updated', { terminals: getTerminalSummaries() });
          schedulePersistTerminalState();
        }
      } else if (wasSelected) {
        // The active terminal was closed — switch to the most recent remaining one
        // so the client gets a `terminal:selected` event and re-binds its input.
        const next = getActiveTerminals()
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (next) {
          selectedTerminalId = next.id;
          lastSelectedTerminalId = next.id;
          socket.emit('terminal:selected', { id: next.id, cwd: next.cwd });
          replayTerminal(next.id);
        }
      }
    });

    socket.on('input', (data: string) => {
      if (typeof data !== 'string' || data.length === 0) return;
      // Drop mouse reporting sequences that xterm.js emits via onData when a
      // TUI app (opencode, vim, htop …) has enabled mouse mode.  These are NOT
      // keyboard input — forwarding them to the PTY clogs its write buffer and
      // makes the terminal completely unresponsive.
      // SGR mouse: ESC [ < … M/m
      if (data.startsWith('\x1b[<') && (data.endsWith('M') || data.endsWith('m'))) return;
      // X10/normal mouse: ESC [ M Cb X Y (6 bytes)
      if (data.startsWith('\x1b[M') && data.length === 6) return;
      const shell = getShell();
      if (shell) {
        handleTerminalInput(socket, transcript, data);
        shell.write(data);
      }
    });

    // Debounce resize to avoid sending SIGWINCH on every rapid layout reflow.
    // Per-terminal resize: every visible terminal sizes its OWN PTY (multiplex),
    // so a TUI in a split/background pane isn't left at the wrong dimensions (the
    // "scattered until you resize" bug). Dedup identical sizes PER id — xterm's
    // FitAddon fires many identical resizes during mount.
    const lastResize = new Map<string, string>();
    socket.on('resize', (payload: { id?: string; cols?: number; rows?: number } = {}) => {
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      const id = typeof payload.id === 'string' && payload.id ? payload.id : (selectedTerminalId ?? '');
      if (!id) return;
      const key = `${cols}x${rows}`;
      if (lastResize.get(id) === key) return; // identical for this terminal — skip
      lastResize.set(id, key);
      const shell = activeShells.get(id);
      if (shell) shell.resize(cols, rows);
    });

    socket.on('cd', async (payload: { path: string; projectId?: string }) => {
      let targetPath = payload.path;

      if (payload.projectId) {
        const projectRoot = resolveProjectRoot(payload.projectId);
        if (projectRoot && await exists(projectRoot)) {
          targetPath = projectRoot;
        }
      }

      if (!targetPath) {
        socket.emit('output', '\r\n[relay] cd: path required\r\n');
        return;
      }

      if (!await exists(targetPath)) {
        socket.emit('output', `\r\n[relay] cd: ${targetPath}: No such directory\r\n`);
        return;
      }

      const shell = getShell();
      if (shell) {
        shell.write(`cd '${targetPath}'\n`);
        const session = selectedTerminalId ? terminalSessions.get(selectedTerminalId) : null;
        if (session) {
          session.cwd = targetPath;
          schedulePersistTerminalState();
        }
      }
    });

    socket.on('disconnect', () => {
      while (disposables.length > 0) {
        disposables.pop()?.dispose();
      }
      boundTerminalIds.clear();
      selectedTerminalId = null;
      // Persistent exit handlers intentionally NOT cleared here —
      // they must survive disconnects to catch PTY exits between sessions.
    });
  });
}
