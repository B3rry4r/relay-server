/*
 * Node-side factory that spawns the native C PTY bridge as a child
 * process. The bridge's stdin/stdout become the input/output channels
 * (Node sees them as ordinary streams, no native callbacks), and a
 * separate pipe on fd 3 carries resize control frames.
 *
 * This factory is OPT-IN. It is selected at startup time when the
 * RELAY_PTY_BRIDGE environment variable is truthy AND the compiled
 * bridge binary exists at a discoverable path. Otherwise the relay
 * falls back to node-pty exactly as before. This keeps the change
 * reversible — flipping the env var back to off restores the previous
 * behaviour without redeploying.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { PtyLike } from './types';

/**
 * Resolve the path to the compiled pty-bridge binary. Honours the
 * RELAY_PTY_BRIDGE_PATH env var for explicit overrides; otherwise
 * looks in well-known locations.
 */
export function resolvePtyBridgePath(): string | null {
  const candidates: string[] = [];

  if (process.env.RELAY_PTY_BRIDGE_PATH) {
    candidates.push(process.env.RELAY_PTY_BRIDGE_PATH);
  }

  // Container layout (Dockerfile copies it here).
  candidates.push('/app/native/pty-bridge');
  // Local dev layout (`npm run build:native`).
  candidates.push(path.resolve(process.cwd(), 'build', 'pty-bridge'));
  candidates.push(path.resolve(process.cwd(), 'native', 'pty-bridge'));

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile()) {
        // X_OK check — confirm we can actually execute it.
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

/**
 * Returns true when the operator has opted into the C bridge AND the
 * binary is present. Falls back to node-pty silently otherwise.
 */
export function isPtyBridgeEnabled(): boolean {
  const flag = process.env.RELAY_PTY_BRIDGE;
  if (!flag || flag === '0' || flag.toLowerCase() === 'false') return false;
  return resolvePtyBridgePath() !== null;
}

type BridgeFactoryOptions = {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
};

/**
 * Build a PtyLike that drives the C bridge. The returned object is
 * structurally compatible with the node-pty PtyLike used by the rest
 * of the relay so socket.ts doesn't need to know which transport it's
 * using.
 */
export function createPtyBridgeFactory(): (options: BridgeFactoryOptions) => PtyLike {
  const bridgePath = resolvePtyBridgePath();
  if (!bridgePath) {
    throw new Error('pty-bridge binary not found; cannot create bridge factory');
  }

  return (options: BridgeFactoryOptions): PtyLike => {
    const proc: ChildProcessWithoutNullStreams = spawn(
      bridgePath,
      [options.command, String(options.cols), String(options.rows)],
      {
        cwd: options.cwd,
        env: options.env,
        // stdio[0]=stdin, [1]=stdout, [2]=stderr, [3]=control channel
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      }
    ) as ChildProcessWithoutNullStreams;

    // The control channel is the 4th stdio slot. It exists on `proc.stdio[3]`.
    // It's a Writable; we use it for resize messages.
    const ctrl = proc.stdio[3] as NodeJS.WritableStream | undefined;

    const emitter = new EventEmitter();
    let exited = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      // Match node-pty's behaviour: emit data as a string. xterm.js
      // and the relay both expect strings here. We use 'binary'
      // encoding (1 char = 1 byte) so escape bytes pass through
      // untouched — same as node-pty's default.
      emitter.emit('data', chunk.toString('binary'));
    });

    // Surface stderr to the host log stream — useful if the bridge
    // ever prints a forkpty/exec failure. Not forwarded to the
    // terminal since the bridge only writes there on errors.
    proc.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) console.error('[pty-bridge stderr]', message);
    });

    const cleanup = (exitCode: number, signal: number | undefined) => {
      if (exited) return;
      exited = true;
      emitter.emit('exit', { exitCode, signal });
    };

    proc.on('exit', (code, signal) => {
      const sig = signal != null
        ? (typeof signal === 'string' ? undefined : signal)
        : undefined;
      cleanup(code ?? 0, sig);
    });
    proc.on('error', (err) => {
      console.error('[pty-bridge spawn error]', err);
      cleanup(1, undefined);
    });

    // Swallow EPIPE on stdin: if the bridge exits while we're still
    // writing, we don't want an unhandled 'error' to crash the process.
    proc.stdin.on('error', () => undefined);
    if (ctrl) ctrl.on('error', () => undefined);

    return {
      pid: proc.pid,
      onData(callback: (data: string) => void) {
        emitter.on('data', callback);
        return { dispose: () => emitter.off('data', callback) };
      },
      onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
        emitter.on('exit', callback);
        return { dispose: () => emitter.off('exit', callback) };
      },
      write(data: string) {
        if (proc.stdin.destroyed || proc.stdin.writableEnded) return;
        // Use 'binary' encoding so each char maps to one byte — keeps
        // escape sequences intact across the pipe, same as node-pty.
        proc.stdin.write(data, 'binary');
      },
      resize(cols: number, rows: number) {
        if (!ctrl || (ctrl as { writableEnded?: boolean }).writableEnded) return;
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(Math.max(1, Math.min(1000, cols | 0)), 0);
        buf.writeUInt16LE(Math.max(1, Math.min(1000, rows | 0)), 2);
        ctrl.write(buf);
      },
      kill() {
        if (exited) return;
        try {
          proc.kill('SIGHUP');
        } catch {
          /* already gone */
        }
      },
    };
  };
}
