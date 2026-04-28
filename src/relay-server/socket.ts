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

const activeShells = new Map<string, PtyLike>();
const terminalSessions = new Map<string, TerminalSession>();
const MAX_SCROLLBACK_BYTES = 1024 * 1024;
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
    sessions: getActiveTerminals().map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      cwd: session.cwd,
      scrollback: session.scrollback.slice(-MAX_SCROLLBACK_BYTES),
    })),
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
        session.scrollback = (persisted.scrollback || '').slice(-MAX_SCROLLBACK_BYTES);
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
  schedulePersistTerminalState();

  return session;
}

export function closeTerminalSession(terminalId: string, skipPersist = false): void {
  const shell = activeShells.get(terminalId);
  activeShells.delete(terminalId);
  terminalSessions.delete(terminalId);
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
      const session = terminalSessions.get(terminalId);
      if (session?.scrollback) {
        socket.emit('terminal:replay', { id: terminalId, data: session.scrollback });
      }
    };

    const bindShellToSocket = (terminalId: string, shell: PtyLike): void => {
      if (boundTerminalIds.has(terminalId)) return;
      boundTerminalIds.add(terminalId);

      const dataDisposable = shell.onData((data: string) => {
        const session = terminalSessions.get(terminalId);
        if (session) {
          session.scrollback = `${session.scrollback}${data}`.slice(-MAX_SCROLLBACK_BYTES);
          schedulePersistTerminalState();
        }
        if (selectedTerminalId === terminalId) {
          socket.emit('output', data);
          handleShellOutput(socket, transcript, data);
        }
      });
      if (dataDisposable) disposables.push(dataDisposable);

      if (typeof shell.onExit === 'function') {
        const exitDisposable = shell.onExit(() => onTerminalExit(terminalId));
        if (exitDisposable) disposables.push(exitDisposable);
      }
    };

    const onTerminalExit = (terminalId: string) => {
      closeTerminalSession(terminalId, suppressTerminalPersistence);
      if (selectedTerminalId === terminalId) {
        selectedTerminalId = null;
      }
      if (lastSelectedTerminalId === terminalId) {
        lastSelectedTerminalId = getActiveTerminals()
          .sort((left, right) => right.createdAt - left.createdAt)[0]?.id ?? null;
      }
      socket.emit('terminal:closed', { id: terminalId });
      socket.emit('terminals:updated', {
        terminals: getTerminalSummaries(),
      });
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
      replayTerminal(selectedTerminalId);
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
      if (terminalId && terminalSessions.has(terminalId)) {
        onTerminalExit(terminalId);
        if (terminalSessions.size === 0) {
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
        }
      }
    });

    socket.on('input', (data: string) => {
      if (typeof data !== 'string' || data.length === 0) return;
      const shell = getShell();
      if (shell) {
        handleTerminalInput(socket, transcript, data);
        shell.write(data);
      }
    });

    socket.on('resize', (payload: { cols?: number; rows?: number } = {}) => {
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      const shell = getShell();
      if (shell) {
        shell.resize(cols, rows);
      }
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
    });
  });
}
