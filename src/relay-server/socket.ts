import type { Server as SocketIOServer } from 'socket.io';
import type { PtyFactory, PtyLike, TerminalSession } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';
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
  if (shell) {
    shell.kill();
  }
  activeShells.delete(terminalId);
  terminalSessions.delete(terminalId);
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
    let selectedTerminalId: string | null = null;
    let shellClosed = false;

    // Emit existing terminals and wait for user to create one
    socket.emit('terminals:ready', { 
      terminals: getActiveTerminals() 
    });

    const attachToTerminal = (terminalId: string): PtyLike | null => {
      const term = activeShells.get(terminalId);
      if (term) {
        selectedTerminalId = terminalId;
        return term;
      }
      return null;
    };

    const closeShell = () => {
      if (shellClosed) {
        return;
      }
      shellClosed = true;
      if (selectedTerminalId) {
        closeTerminalSession(selectedTerminalId);
      }
    };

    // Output from selected terminal
    const handleOutput = (data: string) => {
      socket.emit('output', data);
    };

    socket.on('terminal:create', (_payload: { cwd?: string }) => {
      const terminalId = socket.id + '-' + Date.now();
      const targetCwd = _payload?.cwd || workspace;
      const newSession = createTerminalSession(terminalId, ptyFactory, targetCwd);
      
      if (newSession) {
        const shell = activeShells.get(terminalId);
        if (shell) {
          shell.onData(handleOutput);
          if (typeof shell.onExit === 'function') {
            shell.onExit(() => {
              // This terminal closed - remove it and notify client
              closeTerminalSession(terminalId);
              if (selectedTerminalId === terminalId) {
                selectedTerminalId = null;
              }
              socket.emit('terminal:closed', { id: terminalId });
              socket.emit('terminals:updated', { 
                terminals: getActiveTerminals() 
              });
            });
          }
        }
        
        selectedTerminalId = terminalId;
        socket.emit('terminal:created', newSession);
        socket.emit('terminal:selected', { id: terminalId });
        socket.emit('terminals:updated', { 
          terminals: getActiveTerminals() 
        });
      }
    });

    socket.on('terminal:select', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId && terminalSessions.has(terminalId)) {
        selectedTerminalId = terminalId;
        socket.emit('terminal:selected', { id: terminalId });
      }
    });

    socket.on('terminal:close', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId && terminalSessions.has(terminalId)) {
        closeTerminalSession(terminalId);
        if (selectedTerminalId === terminalId) {
          selectedTerminalId = null;
        }
        socket.emit('terminal:closed', { id: terminalId });
        socket.emit('terminals:updated', { 
          terminals: getActiveTerminals() 
        });
      }
    });

    socket.on('input', (data: string) => {
      if (typeof data !== 'string' || data.length === 0) {
        return;
      }
      if (!selectedTerminalId) {
        socket.emit('output', '\r\n[relay] No terminal selected. Create or select a terminal first.\r\n');
        return;
      }
      const shell = activeShells.get(selectedTerminalId);
      if (shell) {
        shell.write(data);
      }
    });

    socket.on('resize', (payload: { cols?: number; rows?: number } = {}) => {
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return;
      }
      if (selectedTerminalId) {
        const shell = activeShells.get(selectedTerminalId);
        if (shell) {
          shell.resize(cols, rows);
        }
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

      if (selectedTerminalId) {
        const shell = activeShells.get(selectedTerminalId);
        if (shell) {
          shell.write(`cd '${targetPath}'\n`);
        }
        // Update session cwd
        const session = terminalSessions.get(selectedTerminalId);
        if (session) {
          session.cwd = targetPath;
        }
      }
    });

    socket.on('disconnect', closeShell);
    socket.on('disconnecting', closeShell);
    socket.conn.on('close', closeShell);
  });
}