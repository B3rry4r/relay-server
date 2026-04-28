import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import express, { type Express } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { registerCoreRoutes } from './relay-server/core-routes';
import { registerContextRoutes } from './relay-server/context-routes';
import { registerFlutterRoutes } from './relay-server/flutter-routes';
import { registerGitRoutes } from './relay-server/git-routes';
import { registerProjectRoutes } from './relay-server/project-routes';
import {
  closeAllTerminalSessions,
  persistTerminalState,
  registerSocketHandlers,
  restoreTerminalSessions,
  resetTerminalPersistenceRuntime,
  setTerminalPersistenceSuppressed,
} from './relay-server/socket';
import { registerToolRoutes } from './relay-server/tool-routes';
import { ensureRelayRuntimeAssets } from './relay-server/tooling';
import { resolveWorkspace } from './relay-server/runtime';
import type { PtyFactory, PtyLike, RelayServer } from './relay-server/types';

export type { PtyFactory, PtyLike, RelayServer } from './relay-server/types';

export function defaultPtyFactory(options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}): PtyLike {
  // Delayed require keeps tests free from loading the native module when mocked.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePty = require('node-pty') as {
    spawn(
      file: string,
      args: string[],
      options: {
        cols: number;
        cwd: string;
        env: NodeJS.ProcessEnv;
        name: string;
        rows: number;
      }
    ): PtyLike;
  };

  return nodePty.spawn(options.command, [], {
    cols: options.cols,
    cwd: options.cwd,
    env: options.env,
    name: 'xterm-256color',
    rows: options.rows,
  });
}

export function createRelayServer(ptyFactory: PtyFactory = defaultPtyFactory): RelayServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  registerCoreRoutes(app);
  registerContextRoutes(app);
  registerFlutterRoutes(app);
  registerProjectRoutes(app);
  registerToolRoutes(app);
  registerGitRoutes(app);
  registerSocketHandlers(io, ptyFactory);

  return {
    app,
    httpServer,
    io,
    async start() {
      const port = Number.parseInt(process.env.PORT || '3000', 10);
      await ensureRelayRuntimeAssets(resolveWorkspace());
      await restoreTerminalSessions(ptyFactory);

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };

        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port);
      });

      const address = httpServer.address();
      return address && typeof address === 'object' ? address.port : port;
    },
    async stop() {
      await persistTerminalState();
      setTerminalPersistenceSuppressed(true);
      closeAllTerminalSessions(true);
      setTerminalPersistenceSuppressed(false);
      resetTerminalPersistenceRuntime();

      if (!httpServer.listening) {
        io.close();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        io.close();
        httpServer.close((serverError) => {
          if (serverError && serverError.message !== 'Server is not running.') {
            reject(serverError);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export class FakePty extends EventEmitter implements PtyLike {
  public killed = false;
  public resizeCalls: Array<{ cols: number; rows: number }> = [];
  public writes: string[] = [];

  onData(callback: (data: string) => void): { dispose(): void } {
    this.on('data', callback);
    return { dispose: () => this.off('data', callback) };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.on('exit', callback);
    return { dispose: () => this.off('exit', callback) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', { exitCode: 0 });
  }

  pushOutput(data: string): void {
    this.emit('data', data);
  }
}
