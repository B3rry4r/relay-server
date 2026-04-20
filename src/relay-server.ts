import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import express, { type Express } from 'express';
import type { Request } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

export type PtyLike = {
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit?(callback: (event: { exitCode: number; signal?: number }) => void): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
};

export type PtyFactory = (options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}) => PtyLike;

export type RelayServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  start(): Promise<number>;
  stop(): Promise<void>;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function resolveAuthToken(): string {
  return process.env.AUTH_TOKEN || '';
}

function resolveWorkspace(): string {
  return process.env.WORKSPACE || '/workspace';
}

function resolveShell(): string {
  return process.env.SHELL || 'bash';
}

function createTerminalEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace,
    PROMPT_COMMAND: '',
    TERM: process.env.TERM || 'xterm-256color',
  };

  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('BASH_FUNC__vsc_')) {
      delete env[key];
    }
  }

  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;

  return env;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractRequestToken(req: Request): string {
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const headerValue = req.header('x-auth-token');
  const authorization = req.header('authorization');
  const bearerToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  return tokenFromQuery || headerValue || bearerToken || '';
}

function isValidToken(token: string): boolean {
  const expected = resolveAuthToken();
  return expected.length > 0 && token === expected;
}

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
    name: 'xterm-color',
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
  const activeShells = new Map<string, PtyLike>();

  app.use(cors());
  app.get('/', (req, res) => {
    res.json({
      name: 'Relay',
      service: 'terminal-backend',
      status: 'ok',
      transport: {
        httpAuthHeader: 'x-auth-token',
        socketAuthField: 'auth.token',
        socketPath: '/socket.io',
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/auth/validate', (req, res) => {
    if (!isValidToken(extractRequestToken(req))) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'A valid auth token is required.',
      });
      return;
    }

    res.json({ authenticated: true });
  });

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
    let shell: PtyLike;

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

    shell.onData((data) => {
      socket.emit('output', data);
    });

    if (typeof shell.onExit === 'function') {
      shell.onExit(() => {
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

    socket.on('disconnect', () => {
      activeShells.delete(socket.id);
      shell.kill();
    });
  });

  return {
    app,
    httpServer,
    io,
    async start() {
      const port = Number.parseInt(process.env.PORT || '3000', 10);

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
      if (address && typeof address === 'object') {
        return address.port;
      }

      return port;
    },
    async stop() {
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

  onData(callback: (data: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.on('exit', callback);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  pushOutput(data: string): void {
    this.emit('data', data);
  }
}
