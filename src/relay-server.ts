import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import express, { type Express } from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { registerCoreRoutes } from './relay-server/core-routes';
import { registerAIRoutes } from './relay-server/ai-routes';
import { registerContextRoutes } from './relay-server/context-routes';
import { registerFlutterRoutes } from './relay-server/flutter-routes';
import { registerGitRoutes } from './relay-server/git-routes';
import { registerVisualRoutes } from './relay-server/visual-routes';
import { registerScreenLoopRoutes, stopAutoResumeSweep } from './relay-server/ai-screen-loop';
import { createAgentRuntime } from './relay-server/agent';
import { busySnapshot, isUnderHost, lifecycleGuard, startLifecycle } from './relay-server/lifecycle';
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
import { resolveWorkspace, setRelayApiUrl } from './relay-server/runtime';
import { clearLegacyCookie, createAuthRuntime, extractCredential, isLocalRequest } from './relay-server/auth';
import { getSecret } from './relay-server/auth/secrets';
import { timingSafeEqual, createHash } from 'node:crypto';
import { buildCorsOptions, logOriginPolicy } from './relay-server/auth/cors';
import { registerAuthRoutes } from './relay-server/auth/routes';
import { authStatePaths, writeFileAtomic } from './relay-server/auth/state';
import { registerProtectedPort, unregisterProtectedPort } from './relay-server/protected-ports';
import { uixProxyMiddleware } from './relay-server/uix';
import {
  createPtyBridgeFactory,
  isPtyBridgeEnabled,
} from './relay-server/pty-bridge-factory';
import { getRemotePtyUrl, isRemotePtyEnabled } from './relay-server/remote-pty';
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

/** `trust proxy` setting: RELAY_TRUST_PROXY overrides the 'loopback' default. */
function trustProxySetting(): boolean | number | string {
  const raw = (process.env.RELAY_TRUST_PROXY || '').trim();
  if (!raw) return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function createRelayServer(ptyFactory: PtyFactory = defaultPtyFactory): RelayServer {
  const app = express();
  const httpServer = createServer(app);
  // Only a proxy on loopback (the front door) may supply the client IP via
  // X-Forwarded-For; used by the login rate limiter (req.ip).
  app.set('trust proxy', trustProxySetting());

  const auth = createAuthRuntime();
  logOriginPolicy(auth.originPolicy);
  const corsOptions = buildCorsOptions(auth.originPolicy);

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOptions.origin,
      credentials: false,
    },
    // Browsers always send Origin on a WebSocket/polling handshake: refuse one
    // that is not allowlisted (cross-site WebSocket hijacking). Non-browser
    // clients (mcp-server.mjs, relay-pty bridge, tests) send none.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin || auth.originPolicy.isAllowed(origin)) { callback(null, true); return; }
      callback('origin not allowed', false);
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
    // Compress frames only above 4 KB. Small messages (keystrokes, resize
    // events, short command output) are sent raw to avoid zlib overhead and
    // latency. Large frames (AI streaming chunks, scrollback replays) are
    // text-heavy and compress 60-80%, which meaningfully cuts bandwidth on
    // slow connections — exactly the "needs fast internet" symptom.
    perMessageDeflate: { threshold: 4096 },
    // Allow the client up to 30 s to complete the initial handshake.
    connectTimeout: 30000,
  });

  // Order matters:
  //  1. CORS (allowlist) — also answers every preflight, so a 401 below still
  //     carries CORS headers for an allowlisted origin.
  //  2. Clear the legacy raw-secret cookie (never read).
  //  3. DEFAULT-DENY authentication: nothing below runs without a credential
  //     unless the route is on the public allowlist (auth/index.ts).
  //  4. /api/uix/* streaming proxy (before any body parser).
  //  5. Body parsers (a tiny limit for the public login endpoints).
  // Host-internal (CONTRACTS §3): GET /__relay/busy → {runningJobs, activeRuns}
  // for an opt-in `waitIdle` deploy. Loopback only, no forwarding headers, and
  // `Authorization: Bearer <RELAY_PTY_TOKEN>` (the host's internal token). It is
  // registered BEFORE the session middleware because the host holds no session.
  app.get('/__relay/busy', (req, res) => {
    const expected = getSecret('RELAY_PTY_TOKEN');
    const presented = extractCredential(req.headers);
    const digest = (v: string) => createHash('sha256').update(v).digest();
    if (!expected || !presented || !isLocalRequest(req) || !timingSafeEqual(digest(presented), digest(expected))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(busySnapshot());
  });

  app.options('*', cors(corsOptions));
  app.use(cors(corsOptions));
  app.use(clearLegacyCookie);
  app.use(auth.authenticate);
  // Standby / draining release: run-mutating routes answer 503 (lifecycle.ts).
  app.use(lifecycleGuard);
  app.use('/api/uix', uixProxyMiddleware);
  app.use(['/api/auth/login', '/api/auth/login-link/exchange'], express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '50mb' }));

  registerAuthRoutes(app, auth);
  registerCoreRoutes(app);
  registerAIRoutes(app);
  registerContextRoutes(app);
  registerFlutterRoutes(app);
  registerProjectRoutes(app);
  registerToolRoutes(app);
  registerGitRoutes(app);
  registerVisualRoutes(app);
  registerScreenLoopRoutes(app);
  auth.installSocketAuth(io);
  registerSocketHandlers(io, ptyFactory);
  // Agent view (agent-display-spec): agent:* events on this io for every
  // authenticated socket, including Option-B (noTerminals) sockets.
  const agents = createAgentRuntime(io);

  let listeningPort = 0;

  return {
    app,
    httpServer,
    io,
    async start() {
      const port = Number.parseInt(process.env.PORT || '3000', 10);
      await ensureRelayRuntimeAssets(resolveWorkspace());
      if (isRemotePtyEnabled()) {
        // Remote PTY mode: sessions are owned by the relay-pty service and
        // survive this process's restarts — nothing to restore locally.
        console.log(`[relay] remote PTY mode — terminal sessions owned by ${getRemotePtyUrl() || '(RELAY_PTY_URL NOT SET!)'}`);
      } else {
        await restoreTerminalSessions(ptyFactory);
      }
      try {
        await agents.start();
      } catch (error) {
        // the Agent view is an overlay: it must never keep the server from booting
        console.error('[agent] tracker failed to start:', error);
      }

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
        // Under the host (RELAY_START_MODE set) only the front door is public:
        // a release listens on loopback. RELAY_LISTEN_HOST overrides.
        const listenHost = (process.env.RELAY_LISTEN_HOST || '').trim() || (isUnderHost() ? '127.0.0.1' : '');
        if (listenHost) httpServer.listen(port, listenHost);
        else httpServer.listen(port);

        // Railway's upstream proxy has a 60 s idle timeout. Node's default
        // keepAliveTimeout is 5 s, which means the proxy kills keep-alive
        // connections before Node closes them — causing sporadic ECONNRESET
        // errors and the disconnect/reconnect loop seen in the terminal.
        // Setting keepAliveTimeout > proxy idle timeout prevents this.
        httpServer.keepAliveTimeout = 65000; // 65 s — just above Railway's 60 s
        httpServer.headersTimeout = 70000;   // must be > keepAliveTimeout

        // (The unauthenticated raw `upgrade` proxy to the Flutter-screen VNC
        // websockify was removed: nothing starts a screen session —
        // startScreenSession has no caller in relay-server, relay-web or
        // mcp-server.mjs — so the only upgrades served are socket.io's, which
        // are authenticated by io.use.)
      });

      const address = httpServer.address();
      listeningPort = address && typeof address === 'object' ? address.port : port;
      registerProtectedPort(listeningPort, "relay's own API port");
      setRelayApiUrl(`http://127.0.0.1:${listeningPort}`);
      try {
        writeFileAtomic(authStatePaths().apiUrl, `http://127.0.0.1:${listeningPort}\n`, 0o644);
      } catch { /* the relay-auth CLI falls back to RELAY_API_URL / PORT */ }

      // Activate now, or (RELAY_START_MODE=standby, under the host) wait for the
      // host's IPC {type:'activate'}. Activation resumes interrupted runs and
      // starts the rate-limit auto-resume sweep — work only the ACTIVE release may
      // do (lifecycle.ts).
      startLifecycle();

      return listeningPort;
    },
    async stop() {
      agents.stop();
      auth.dispose();
      stopAutoResumeSweep();
      if (listeningPort) unregisterProtectedPort(listeningPort);
      if (!isRemotePtyEnabled()) {
        // Embedded mode only — in remote mode the relay-pty service owns the
        // sessions and MUST NOT have them persisted/closed from here.
        await persistTerminalState();
        setTerminalPersistenceSuppressed(true);
        closeAllTerminalSessions(true);
        setTerminalPersistenceSuppressed(false);
        resetTerminalPersistenceRuntime();
      }

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
        // Keep-alive connections (65 s) would otherwise hold close() open.
        httpServer.closeIdleConnections?.();
        const closeAll = setTimeout(() => httpServer.closeAllConnections?.(), 1000);
        closeAll.unref?.();
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
