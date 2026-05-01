import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, resolveWorkspace } from './runtime';

const execFile = promisify(execFileCallback);

type TunnelEntry = {
  port: number;
  url: string;
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
};

// One tunnel per port, shared across all callers.
const tunnels = new Map<number, TunnelEntry>();
// Deduplicate in-flight tunnel starts: if two callers request a tunnel for the
// same port at the same time, they both await the same Promise.
const inFlight = new Map<number, Promise<string>>();

async function ensureCloudflared(): Promise<string> {
  const workspace = resolveWorkspace();
  const binDir = path.join(workspace, '.relay', 'bin');
  const bin = path.join(binDir, 'cloudflared');

  if (await exists(bin)) return bin;

  await fs.mkdir(binDir, { recursive: true });
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  await execFile('curl', ['-fsSL', '-o', bin, url]);
  await fs.chmod(bin, 0o755);
  return bin;
}

function spawnTunnel(bin: string, port: number): Promise<TunnelEntry> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      'tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate',
    ], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams;

    let output = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Tunnel for port ${port} did not start within 30s`));
      }
    }, 30_000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ port, url: match[0], process: child, startedAt: Date.now() });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited (code ${code}): ${output.slice(-300)}`));
      }
      // Tunnel died after resolving — clean up the map so the next request restarts it
      if (tunnels.get(port)?.process === child) {
        tunnels.delete(port);
      }
    });
  });
}

/**
 * Returns the public trycloudflare.com URL for a local port.
 * Creates a tunnel if none exists, reuses if already running.
 */
export async function getTunnelUrl(port: number): Promise<string> {
  const existing = tunnels.get(port);
  if (existing && existing.process.exitCode === null) {
    return existing.url;
  }

  const flying = inFlight.get(port);
  if (flying) return flying;

  const promise = (async () => {
    const bin = await ensureCloudflared();
    const entry = await spawnTunnel(bin, port);
    tunnels.set(port, entry);
    inFlight.delete(port);
    return entry.url;
  })();

  inFlight.set(port, promise);
  return promise;
}

/** Stop the tunnel for a port (call when the underlying server stops). */
export function closeTunnel(port: number): void {
  const entry = tunnels.get(port);
  if (entry) {
    entry.process.kill('SIGTERM');
    tunnels.delete(port);
  }
  inFlight.delete(port);
}

/** Returns all currently active tunnel entries (for status/debug). */
export function listTunnels(): Array<{ port: number; url: string; startedAt: number }> {
  return [...tunnels.values()]
    .filter(e => e.process.exitCode === null)
    .map(({ port, url, startedAt }) => ({ port, url, startedAt }));
}
