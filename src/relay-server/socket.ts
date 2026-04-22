import type { Server as SocketIOServer } from 'socket.io';
import type { PtyFactory, PtyLike } from './types';
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

export function registerSocketHandlers(
  io: SocketIOServer,
  ptyFactory: PtyFactory
): void {
  const activeShells = new Map<string, PtyLike>();

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
    let shell: PtyLike;
    let currentCwd = workspace;

    try {
      shell = ptyFactory({
        command: resolveShell(),
        cols: DEFAULT_COLS,
        cwd: workspace,
        env: createTerminalEnv(workspace),
        rows: DEFAULT_ROWS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown PTY error';
      socket.emit('output', `\r\n[relay] Failed to start shell: ${escapeHtml(message)}\r\n`);
      socket.disconnect(true);
      return;
    }

    activeShells.set(socket.id, shell);
    let shellClosed = false;
    const closeShell = () => {
      if (shellClosed) {
        return;
      }
      shellClosed = true;
      activeShells.delete(socket.id);
      shell.kill();
    };

    shell.onData((data) => {
      socket.emit('output', data);
      handleShellOutput(socket, transcriptState, data);
    });

    if (typeof shell.onExit === 'function') {
      shell.onExit(() => {
        shellClosed = true;
        activeShells.delete(socket.id);
        if (socket.connected) {
          socket.disconnect(true);
        }
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

    socket.on('disconnect', closeShell);
    socket.on('disconnecting', closeShell);
    socket.conn.on('close', closeShell);
  });
}
