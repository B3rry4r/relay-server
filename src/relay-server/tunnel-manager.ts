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
 * Wait until a freshly-created quick tunnel actually routes to the origin.
 * cloudflared prints the public URL the moment it registers, but the Cloudflare
 * edge needs a few seconds before requests reach the local port — until then it
 * serves its own 502/503/530 error pages. Without this probe the first preview
 * load lands on a blank/error page and only works after a manual close+reopen
 * (once the tunnel is warm). Best-effort: resolves early on the first good
 * response, gives up after the deadline so we never block forever.
 */
async function waitForTunnelReady(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Cloudflare edge cold-start / origin-not-yet-reachable status codes.
  const edgeColdStart = new Set([502, 503, 530, 504]);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000) });
      if (!edgeColdStart.has(res.status)) return; // a real response came back from the app
    } catch {
      // Network hiccup / DNS not propagated yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 700));
  }
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
    try {
      const bin = await ensureCloudflared();
      const entry = await spawnTunnel(bin, port);
      tunnels.set(port, entry);
      // Block until the edge actually routes, so the iframe's first load works.
      await waitForTunnelReady(entry.url);
      return entry.url;
    } finally {
      inFlight.delete(port);
    }
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
