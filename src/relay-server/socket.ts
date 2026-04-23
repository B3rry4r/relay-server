import type { Server as SocketIOServer } from 'socket.io';
import type { PtyFactory, PtyLike, TerminalSession } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';
import { createShellTranscriptState, handleShellOutput, handleTerminalInput } from './transcript';
import {
  createTerminalEnv,
  escapeHtml,
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
  socketId: string,
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
    id: socketId,
    createdAt: Date.now(),
    cwd: workspace,
    pid: shell.pid || 0,
  };

  activeShells.set(socketId, shell);
  terminalSessions.set(socketId, session);

  return session;
}

export function closeTerminalSession(socketId: string): void {
  const shell = activeShells.get(socketId);
  if (shell) {
    shell.kill();
  }
  activeShells.delete(socketId);
  terminalSessions.delete(socketId);
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
    const transcriptState = createShellTranscriptState(workspace);
    const session = createTerminalSession(socket.id, ptyFactory, workspace);
    const shell = session ? activeShells.get(socket.id) : null;
    let currentCwd = workspace;

    if (!session || !shell) {
      socket.emit('output', `\r\n[relay] Failed to start shell\r\n`);
      socket.disconnect(true);
      return;
    }

    let shellClosed = false;
    const closeShell = () => {
      if (shellClosed) {
        return;
      }
      shellClosed = true;
      closeTerminalSession(socket.id);
    };

    shell.onData((data) => {
      socket.emit('output', data);
      handleShellOutput(socket, transcriptState, data);
    });

    if (typeof shell.onExit === 'function') {
      shell.onExit(() => {
        shellClosed = true;
        closeTerminalSession(socket.id);
        // Don't disconnect socket - other terminals may still be active
        socket.emit('terminal:closed', { id: session.id });
      });
    }

    socket.on('input', (data: string) => {
      if (typeof data !== 'string' || data.length === 0) {
        return;
      }
      handleTerminalInput(socket, transcriptState, data);
      shell.write(data);
    });

    socket.on('resize', (payload: { cols?: number; rows?: number } = {}) => {
      const cols = Number(payload.cols);
      const rows = Number(payload.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return;
      }
      shell.resize(cols, rows);
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

      currentCwd = targetPath;
      shell.write(`cd '${targetPath}'\n`);
    });

    socket.on('terminal:create', (_payload: { cwd?: string }) => {
      const targetCwd = _payload?.cwd || workspace;
      const newSession = createTerminalSession(socket.id + '-' + Date.now(), ptyFactory, targetCwd);
      socket.emit('terminal:created', newSession);
    });

    socket.on('terminal:close', (_payload: { id: string }) => {
      const terminalId = _payload?.id;
      if (terminalId) {
        closeTerminalSession(terminalId);
      }
    });

    socket.on('disconnect', closeShell);
    socket.on('disconnecting', closeShell);
    socket.conn.on('close', closeShell);
  });
}
