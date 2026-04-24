import type { Server as SocketIOServer } from 'socket.io';
import type { PtyFactory, PtyLike, TerminalSession } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';
import {
  createShellTranscriptState,
  handleShellOutput,
  handleTerminalInput,
} from './transcript';
import {
  createTerminalEnv,
  exists,
  isValidToken,
  resolveProjectRoot,
  resolveShell,
  resolveWorkspace,
} from './runtime';

const activeShells = new Map<string, PtyLike>();
const terminalSessions = new Map<string, TerminalSession>();

export function getActiveTerminals(): TerminalSession[] {
  return Array.from(terminalSessions.values());
}

export function createTerminalSession(
  terminalId: string,
  ptyFactory: PtyFactory,
  workspace: string
): TerminalSession | null {
  let shell: PtyLike;
  try {
    shell = ptyFactory({
      command: resolveShell(),
      cols: DEFAULT_COLS,
      cwd: workspace,
      env: createTerminalEnv(workspace),
      rows: DEFAULT_ROWS,
    });
  } catch {
    return null;
  }

  const session: TerminalSession = {
    id: terminalId,
    createdAt: Date.now(),
    cwd: workspace,
    pid: shell.pid || 0,
  };

  activeShells.set(terminalId, shell);
  terminalSessions.set(terminalId, session);

  return session;
}

export function closeTerminalSession(terminalId: string): void {
  const shell = activeShells.get(terminalId);
  activeShells.delete(terminalId);
  terminalSessions.delete(terminalId);
  if (shell) {
    shell.kill();
  }
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
    const workspace = resolveWorkspace();
    const transcript = createShellTranscriptState(workspace);
    let selectedTerminalId: string | null = null;

    // Helper to get active shell for selected terminal
    const getShell = (): PtyLike | null => {
      if (!selectedTerminalId) return null;
      return activeShells.get(selectedTerminalId) || null;
    };

    // Callback when terminal exits - notify client
    const onTerminalExit = (terminalId: string) => {
      closeTerminalSession(terminalId);
      if (selectedTerminalId === terminalId) {
        selectedTerminalId = null;
      }
      socket.emit('terminal:closed', { id: terminalId });
      socket.emit('terminals:updated', { 
        terminals: getActiveTerminals() 
      });
    };

    const bindShellToSocket = (terminalId: string, shell: PtyLike): void => {
      shell.onData((data: string) => {
        socket.emit('output', data);
        handleShellOutput(socket, transcript, data);
      });

      if (typeof shell.onExit === 'function') {
        shell.onExit(() => onTerminalExit(terminalId));
      }
    };

    // Create first terminal automatically if none exist
    const existing = getActiveTerminals();
    if (existing.length > 0) {
      // Reuse first existing terminal
      selectedTerminalId = existing[0].id;
      const shell = activeShells.get(selectedTerminalId);
      if (shell) {
        bindShellToSocket(selectedTerminalId, shell);
      }
      socket.emit('terminals:ready', { terminals: existing });
      socket.emit('terminal:selected', { id: selectedTerminalId, cwd: existing[0].cwd });
    } else {
      // Create new terminal
      const terminalId = socket.id + '-' + Date.now();
      const session = createTerminalSession(terminalId, ptyFactory, workspace);
      
      if (session) {
        selectedTerminalId = terminalId;
        const shell = activeShells.get(terminalId);
        if (shell) {
          bindShellToSocket(terminalId, shell);
        }
        socket.emit('terminals:ready', { terminals: getActiveTerminals() });
        socket.emit('terminal:created', session);
        socket.emit('terminal:selected', { id: terminalId, cwd: session.cwd });
      } else {
        socket.emit('output', '\r\n[relay] Failed to start shell\r\n');
        socket.disconnect(true);
      }
    }

    socket.on('terminal:create', (_payload: { cwd?: string }) => {
      const terminalId = socket.id + '-' + Date.now();
      const targetCwd = _payload?.cwd || workspace;
      const session = createTerminalSession(terminalId, ptyFactory, targetCwd);
      
      if (session) {
        const shell = activeShells.get(terminalId);
        if (shell) {
          bindShellToSocket(terminalId, shell);
        }
        
        selectedTerminalId = terminalId;
        socket.emit('terminal:created', session);
        socket.emit('terminal:selected', { id: terminalId, cwd: session.cwd });
        socket.emit('terminals:updated', { terminals: getActiveTerminals() });
      }
    });

    socket.on('terminal:select', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId && terminalSessions.has(terminalId)) {
        selectedTerminalId = terminalId;
        const session = terminalSessions.get(terminalId);
        socket.emit('terminal:selected', { 
          id: terminalId, 
          cwd: session?.cwd 
        });
      }
    });

    socket.on('terminal:close', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId && terminalSessions.has(terminalId)) {
        onTerminalExit(terminalId);
        // Create new terminal if all closed
        if (terminalSessions.size === 0) {
          const newId = socket.id + '-' + Date.now();
          const session = createTerminalSession(newId, ptyFactory, workspace);
          if (session) {
            selectedTerminalId = newId;
            const shell = activeShells.get(newId);
            if (shell) {
              bindShellToSocket(newId, shell);
            }
            socket.emit('terminal:created', session);
            socket.emit('terminal:selected', { id: newId, cwd: session.cwd });
            socket.emit('terminals:updated', { terminals: getActiveTerminals() });
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
      } else {
        socket.emit('output', '\r\n[relay] No terminal selected\r\n');
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
        }
      }
    });

    socket.on('disconnect', () => {
      if (selectedTerminalId) {
        closeTerminalSession(selectedTerminalId);
        selectedTerminalId = null;
      }
    });
  });
}
