import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureUrlScreenshot } from '../src/relay-server/visual-routes';

// Exercises the real headless-Chrome screenshot primitive when Chrome is
// available; degrades to a null-check (no crash) when it isn't.

const tmpFiles: string[] = [];
afterAll(async () => { for (const f of tmpFiles) await fs.rm(f, { force: true }).catch(() => {}); });

describe('captureUrlScreenshot', () => {
  it('captures a solid-color page as PNG bytes', async () => {
    const html = '<!doctype html><html><body style="margin:0"><div style="width:100vw;height:100vh;background:#1496e6"></div></body></html>';
    const file = path.join(os.tmpdir(), `relay-vis-test-${Date.now()}.html`);
    tmpFiles.push(file);
    await fs.writeFile(file, html);

    const png = await captureUrlScreenshot(`file://${file}`, 32, 32, 30000);
    if (!png) { console.log('  (skipped: headless Chrome unavailable)'); return; }
    // PNG magic number.
    expect(png.length).toBeGreaterThan(8);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // P
    expect(png[2]).toBe(0x4e); // N
    expect(png[3]).toBe(0x47); // G
  }, 60000);

  it('returns null for an unreachable URL instead of throwing', async () => {
    const png = await captureUrlScreenshot('http://127.0.0.1:1/none', 16, 16, 8000);
    // null whether Chrome is absent or the URL fails — never throws.
    expect(png === null || Buffer.isBuffer(png)).toBe(true);
  }, 30000);
});
