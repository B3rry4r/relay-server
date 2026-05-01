/**
 * Flutter Screen Streaming
 *
 * Runs Flutter in a headless Chrome browser on a virtual X display (Xvfb),
 * captures it with x11vnc, bridges VNC → WebSocket via websockify, and serves
 * the noVNC HTML client so the browser can display it as a canvas — exactly
 * how Firebase Studio works.
 *
 * Stack per session:
 *   Xvfb :N  →  flutter run -d chrome  →  x11vnc  →  websockify :WS_PORT  →  browser
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { exists, resolveWorkspace, getFlutterRoot, createTerminalEnv } from './runtime';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScreenSession = {
  projectId: string;
  display: number;          // Xvfb display number e.g. 99
  vncPort: number;          // x11vnc TCP port
  wsPort: number;           // websockify WebSocket port
  xvfb: ChildProcess;
  x11vnc: ChildProcess;
  websockify: ChildProcess;
  flutter: ChildProcess;
  startedAt: number;
  output: string;
  ready: boolean;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, ScreenSession>();

// ---------------------------------------------------------------------------
// Port / display helpers
// ---------------------------------------------------------------------------

async function isTcpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 100; p++) {
    if (await isTcpFree(p)) return p;
  }
  throw new Error(`No free TCP port found starting from ${start}`);
}

async function findFreeDisplay(start = 99): Promise<number> {
  for (let d = start; d < start + 20; d++) {
    const lockFile = `/tmp/.X${d}-lock`;
    try {
      await fs.access(lockFile);
      // lock exists → display in use
    } catch {
      return d; // no lock → free
    }
  }
  throw new Error('No free X display number found');
}

// ---------------------------------------------------------------------------
// Tool installation
// ---------------------------------------------------------------------------

async function ensureTool(name: string): Promise<void> {
  try {
    await execFile('which', [name]);
  } catch {
    // Try apt-get
    await execFile('apt-get', ['install', '-y', '--no-install-recommends', name], {
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
  }
}

async function ensureNoVNC(workspace: string): Promise<string> {
  const novncDir = path.join(workspace, '.relay', 'novnc');
  const coreJs = path.join(novncDir, 'core', 'rfb.js');
  if (await exists(coreJs)) return novncDir;

  await fs.mkdir(novncDir, { recursive: true });

  // Download noVNC from GitHub
  const tarball = path.join(workspace, '.relay', 'novnc.tar.gz');
  await execFile('curl', [
    '-fsSL',
    '-o', tarball,
    'https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz',
  ]);
  await execFile('tar', ['-xzf', tarball, '-C', novncDir, '--strip-components=1']);
  await fs.unlink(tarball).catch(() => undefined);

  return novncDir;
}

async function ensureWebsockify(workspace: string): Promise<string> {
  const bin = path.join(workspace, '.relay', 'bin', 'websockify');
  if (await exists(bin)) return bin;

  // websockify is a Python package
  await execFile('pip3', ['install', 'websockify', '--break-system-packages', '-q']);

  // Find where pip installed it
  const { stdout } = await execFile('which', ['websockify']);
  const systemBin = stdout.trim();

  // Symlink into relay bin
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(systemBin, bin).catch(() => undefined);

  return systemBin;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function appendOutput(session: ScreenSession, chunk: string): void {
  session.output = (session.output + chunk).slice(-30000);
}

export async function startScreenSession(
  projectId: string,
  projectRoot: string,
  flutterBin: string,
  env: NodeJS.ProcessEnv,
): Promise<ScreenSession> {
  // Stop any existing session for this project
  await stopScreenSession(projectId);

  const workspace = resolveWorkspace();

  // Ensure tools are available
  await Promise.all([
    ensureTool('Xvfb'),
    ensureTool('x11vnc'),
    ensureWebsockify(workspace),
    ensureNoVNC(workspace),
  ]);

  const display = await findFreeDisplay();
  const vncPort = await findFreePort(5900 + display);
  const wsPort = await findFreePort(6900 + display);

  const displayEnv = { ...env, DISPLAY: `:${display}` };

  // 1. Start Xvfb
  const xvfb = spawn('Xvfb', [
    `:${display}`,
    '-screen', '0', '1280x800x24',
    '-ac',               // disable access control
    '+extension', 'GLX',
    '+render',
    '-noreset',
  ], { stdio: 'pipe' });

  // Wait for Xvfb to be ready (lock file appears)
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Xvfb did not start within 10s')), 10000);
    const poll = setInterval(async () => {
      try {
        await fs.access(`/tmp/.X${display}-lock`);
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      } catch { /* not ready yet */ }
    }, 200);
  });

  // 2. Start x11vnc
  const x11vnc = spawn('x11vnc', [
    '-display', `:${display}`,
    '-rfbport', String(vncPort),
    '-nopw',             // no password
    '-forever',          // keep running after client disconnects
    '-shared',           // allow multiple viewers
    '-quiet',
    '-nossl',
    '-noxdamage',
  ], { stdio: 'pipe' });

  // Wait briefly for x11vnc to bind
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Start websockify (bridges VNC TCP → WebSocket)
  const websockify = spawn('websockify', [
    '--web', '/dev/null',  // we serve noVNC ourselves
    String(wsPort),
    `127.0.0.1:${vncPort}`,
  ], { stdio: 'pipe' });

  await new Promise((r) => setTimeout(r, 800));

  // 4. Start Flutter in Chrome on this display
  // Detect chrome binary — Railway may have google-chrome or google-chrome-stable
  const chromeBin = process.env.RELAY_CHROME_BIN
    || await execFile('which', ['google-chrome']).then(r => r.stdout.trim()).catch(() => '')
    || await execFile('which', ['google-chrome-stable']).then(r => r.stdout.trim()).catch(() => '')
    || '/usr/bin/google-chrome';

  const flutter = spawn(flutterBin, [
    'run',
    '-d', 'chrome',
    '--web-browser-flag=--no-sandbox',
    '--web-browser-flag=--disable-dev-shm-usage',
    '--web-browser-flag=--disable-gpu',
  ], {
    cwd: projectRoot,
    env: {
      ...displayEnv,
      CHROME_EXECUTABLE: chromeBin,
      FLUTTER_SUPPRESS_ANALYTICS: '1',
    },
    stdio: 'pipe',
  });

  const session: ScreenSession = {
    projectId,
    display,
    vncPort,
    wsPort,
    xvfb,
    x11vnc,
    websockify,
    flutter,
    startedAt: Date.now(),
    output: '',
    ready: false,
  };

  sessions.set(projectId, session);

  // Output captured via onFlutterData above
  x11vnc.stderr?.on('data', (c: Buffer) => appendOutput(session, c.toString('utf8')));
  websockify.stderr?.on('data', (c: Buffer) => appendOutput(session, c.toString('utf8')));

  // Mark ready when Flutter signals the app is running
  const onFlutterData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (
      text.includes('Flutter run key commands') ||
      text.includes('To hot reload changes') ||
      text.includes('is being served at') ||
      text.includes('Syncing files to device')
    ) {
      session.ready = true;
    }
  };
  flutter.stdout?.on('data', onFlutterData);
  flutter.stderr?.on('data', onFlutterData);

  // Clean up map if Flutter exits
  flutter.on('exit', () => {
    if (sessions.get(projectId) === session) {
      sessions.delete(projectId);
    }
  });

  // Wait up to 90s for Flutter to be ready
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (!session.ready) {
        reject(new Error(`Flutter did not start within 90s. Output:\n${session.output.slice(-1000)}`));
      }
    }, 180_000);
    const poll = setInterval(() => {
      if (session.ready) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 500);
  });

  return session;
}

export async function stopScreenSession(projectId: string): Promise<void> {
  const session = sessions.get(projectId);
  if (!session) return;

  for (const proc of [session.flutter, session.websockify, session.x11vnc, session.xvfb]) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }

  sessions.delete(projectId);

  // Clean up X lock file if Xvfb left it
  await fs.unlink(`/tmp/.X${session.display}-lock`).catch(() => undefined);
}

export function getScreenSession(projectId: string): ScreenSession | null {
  const session = sessions.get(projectId);
  return session && session.flutter.exitCode === null ? session : null;
}

export function sendFlutterScreenCommand(projectId: string, command: 'r' | 'R'): boolean {
  const session = getScreenSession(projectId);
  if (!session) return false;
  (session.flutter.stdin as NodeJS.WritableStream).write(command);
  return true;
}

export async function getNoVNCDir(): Promise<string> {
  return ensureNoVNC(resolveWorkspace());
}
