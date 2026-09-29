import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureUrlScreenshot } from '../src/relay-server/visual-routes';

// Exercises the REAL headless-Chrome screenshot primitive. When no Chrome can be
// found the capture test is skipped through ctx.skip with a reason (it must never
// pass without having run). When Chrome IS found, a null capture is a failure.
//
// Chrome resolution for the test mirrors chromeBin() in visual-routes.ts
// (RELAY_CHROME_BIN, then PATH) and additionally looks in the puppeteer browser
// cache, where dev containers usually have Chrome without it being on PATH. The
// binary found is exported as RELAY_CHROME_BIN so the production resolver uses
// exactly that binary (chromeBin() honours RELAY_CHROME_BIN first).

function findChrome(): string | null {
  const envBin = process.env.RELAY_CHROME_BIN;
  if (envBin && fsSync.existsSync(envBin)) return envBin;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && fsSync.existsSync(p)) return p;
    } catch { /* not on PATH */ }
  }
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ].filter((d): d is string => !!d);
  for (const root of cacheRoots) {
    const chromeDir = path.join(root, 'chrome');
    let versions: string[] = [];
    try { versions = fsSync.readdirSync(chromeDir).sort().reverse(); } catch { continue; }
    for (const v of versions) {
      const bin = path.join(chromeDir, v, 'chrome-linux64', 'chrome');
      if (fsSync.existsSync(bin)) return bin;
    }
  }
  return null;
}

const CHROME = findChrome();
if (CHROME) process.env.RELAY_CHROME_BIN = CHROME;
const CHROME_SKIP_REASON =
  'NEEDS_EXTERNAL: headless Chrome not found (checked RELAY_CHROME_BIN, google-chrome/chromium on PATH, ' +
  'and $PUPPETEER_CACHE_DIR or ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome). ' +
  'Set RELAY_CHROME_BIN to a Chrome binary to run it.';

const tmpFiles: string[] = [];
afterAll(async () => { for (const f of tmpFiles) await fs.rm(f, { force: true }).catch(() => {}); });

describe('captureUrlScreenshot', () => {
  it('captures a solid-color page as PNG bytes', async (ctx) => {
    ctx.skip(!CHROME, CHROME_SKIP_REASON);
    const html = '<!doctype html><html><body style="margin:0"><div style="width:100vw;height:100vh;background:#1496e6"></div></body></html>';
    const file = path.join(os.tmpdir(), `relay-vis-test-${Date.now()}.html`);
    tmpFiles.push(file);
    await fs.writeFile(file, html);

    const png = await captureUrlScreenshot(`file://${file}`, 32, 32, 30000);
    // Chrome is present, so a null here is a real failure of the primitive.
    expect(png).not.toBeNull();
    expect(Buffer.isBuffer(png)).toBe(true);
    // PNG magic number.
    expect(png!.length).toBeGreaterThan(8);
    expect(png![0]).toBe(0x89);
    expect(png![1]).toBe(0x50); // P
    expect(png![2]).toBe(0x4e); // N
    expect(png![3]).toBe(0x47); // G
    // IHDR dimensions (bytes 16..23, big-endian) are the requested 32x32.
    expect(png!.readUInt32BE(16)).toBe(32);
    expect(png!.readUInt32BE(20)).toBe(32);
  }, 60000);

  it('never throws for an unreachable URL (null, or Chrome\'s error-page PNG)', async () => {
    // Without Chrome: null. With Chrome: Chrome screenshots its own error page.
    // Either way the promise resolves; it must not reject.
    const png = await captureUrlScreenshot('http://127.0.0.1:1/none', 16, 16, 8000);
    expect(png === null || Buffer.isBuffer(png)).toBe(true);
  }, 30000);
});
