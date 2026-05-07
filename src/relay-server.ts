import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import express, { type Express } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { registerCoreRoutes } from './relay-server/core-routes';
import { registerContextRoutes } from './relay-server/context-routes';
import { registerFlutterRoutes } from './relay-server/flutter-routes';
import { getScreenSession } from './relay-server/flutter-screen';
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
import {
  createPtyBridgeFactory,
  isPtyBridgeEnabled,
} from './relay-server/pty-bridge-factory';
import type { PtyFactory, PtyLike, RelayServer } from './relay-server/types';

export type { PtyFactory, PtyLike, RelayServer } from './relay-server/types';

// Memoise so we only resolve the bridge binary path and create the
// closure once. Lazy so unit tests that pass their own PtyFactory
// never load the bridge code.
let cachedBridgeFactory: PtyFactory | null = null;
function getBridgeFactory(): PtyFactory | null {
  if (cachedBridgeFactory) return cachedBridgeFactory;
  if (!isPtyBridgeEnabled()) return null;
  try {
    cachedBridgeFactory = createPtyBridgeFactory();
    console.log('[relay] pty bridge enabled — using native C bridge for PTYs');
    return cachedBridgeFactory;
  } catch (error) {
    console.warn('[relay] pty bridge requested but factory creation failed; falling back to node-pty', error);
    return null;
  }
}

export function defaultPtyFactory(options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}): PtyLike {
  const bridge = getBridgeFactory();
  if (bridge) {
    return bridge(options);
  }

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
    // Keep connections alive through Railway's proxy (60s idle timeout).
    // pingInterval must be well below the proxy idle timeout so the connection
    // never goes quiet long enough for the upstream to kill it.
    pingInterval: 10000,  // send a ping every 10 s
    pingTimeout: 20000,   // wait up to 20 s for a pong before disconnecting
    // Prefer the persistent WebSocket transport.  Falling back to polling
    // creates a new HTTP request per chunk which is both slow and breaks
    // streaming for long-running AI CLI tools.
    transports: ['websocket', 'polling'],
    // Increase the per-message buffer so large streaming chunks from AI CLI
    // tools (claude, gemini, etc.) are never silently dropped.
    maxHttpBufferSize: 1e7, // 10 MB
    // Disable per-message deflate — it adds CPU overhead and latency for the
    // high-frequency small messages that a terminal emits.
    perMessageDeflate: false,
    // Allow the client up to 30 s to complete the initial handshake.
    connectTimeout: 30000,
  });

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

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

        // Railway's upstream proxy has a 60 s idle timeout. Node's default
        // keepAliveTimeout is 5 s, which means the proxy kills keep-alive
        // connections before Node closes them — causing sporadic ECONNRESET
        // errors and the disconnect/reconnect loop seen in the terminal.
        // Setting keepAliveTimeout > proxy idle timeout prevents this.
        httpServer.keepAliveTimeout = 65000; // 65 s — just above Railway's 60 s
        httpServer.headersTimeout = 70000;   // must be > keepAliveTimeout

        // Proxy WebSocket upgrades for Flutter screen sessions.
        // noVNC connects to /api/projects/:id/flutter/screen/websocket
        // and we pipe it straight to the session's local websockify port.
        httpServer.on('upgrade', (req, socket, head) => {
          const match = req.url?.match(/^\/api\/projects\/([^/]+)\/flutter\/screen\/websocket/);
          if (!match) return; // let socket.io handle other upgrades
          const projectId = decodeURIComponent(match[1]);
          const session = getScreenSession(projectId);
          if (!session) { socket.destroy(); return; }
          import('node:net').then(({ createConnection }) => {
            const upstream = createConnection({ host: '127.0.0.1', port: session.wsPort }, () => {
              // Forward the raw HTTP upgrade request to websockify
              const CRLF = '\r\n';
              const reqLine = req.method + ' ' + req.url + ' HTTP/1.1' + CRLF;
              const headers = Object.entries(req.headers)
                .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
                .join(CRLF);
              upstream.write(reqLine + headers + CRLF + CRLF);
              if (head.length > 0) upstream.write(head);
              upstream.pipe(socket);
              socket.pipe(upstream);
            });
            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
          });
        });
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
