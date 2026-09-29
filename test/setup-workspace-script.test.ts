import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('setup-workspace script', () => {
  const scriptPath = path.resolve(process.cwd(), 'setup-workspace.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('provides a downloader fallback when curl is unavailable', () => {
    expect(script).toContain('download_to_stdout()');
    expect(script).toContain('if has_command curl; then');
    expect(script).toContain('if has_command node; then');
  });

  it('records component-level bootstrap status and distinguishes partial completion', () => {
    expect(script).toContain('BOOTSTRAP_STATUS_PATH="$WORKSPACE/.bootstrap-status"');
    expect(script).toContain('RELAY_ROOT="$WORKSPACE/.relay"');
    expect(script).toContain('RELAY_ENV_PATH="$RELAY_STATE_DIR/tool-env.sh"');
    expect(script).toContain('record_status relay_browser "ready"');
    expect(script).toContain('record_status relay_chrome "ready"');
    expect(script).toContain('record_status gemini_auth "ready"');
    expect(script).toContain('record_status relay_machine_id "ready"');
    expect(script).toContain('record_status relay_hostname "ready"');
    expect(script).toContain('record_status()');
    expect(script).toContain('record_status bootstrap "complete"');
    expect(script).toContain('record_status bootstrap "partial"');
    expect(script).toContain('rm -f "$BOOTSTRAP_FLAG"');
  });

  it('retries missing components instead of treating a partial first boot as complete forever', () => {
    expect(script).toContain('skipping nvm install because git is unavailable');
    expect(script).toContain('export RELAY_HOME="$RELAY_ROOT"');
    expect(script).toContain('export RELAY_MACHINE_ID="$RELAY_MACHINE_ID"');
    expect(script).toContain('export RELAY_HOSTNAME="$RELAY_HOSTNAME"');
    expect(script).toContain('export FLUTTER_HOME="$FLUTTER_HOME_DIR"');
    expect(script).toContain('export BROWSER="$RELAY_BIN_DIR/relay-browser"');
    expect(script).toContain('export CHROME_EXECUTABLE="$RELAY_BIN_DIR/relay-chrome"');
    expect(script).not.toContain('workspace already initialized');
  });

  it('pins a persistent Relay machine identity onto the volume-backed state', () => {
    expect(script).toContain('RELAY_MACHINE_ID_PATH="$RELAY_STATE_DIR/machine-id"');
    expect(script).toContain('RELAY_HOSTNAME_PATH="$RELAY_STATE_DIR/hostname"');
    expect(script).toContain('ensure_relay_identity() {');
    // 46ab8e2: the container runs as the non-root `dev` user (Dockerfile USER dev),
    // so the root-owned system machine-id files are written through passwordless
    // sudo and are best-effort — the volume-backed identity above is authoritative.
    expect(script).toContain('printf \'%s\\n\' "$RELAY_MACHINE_ID" | sudo tee /etc/machine-id >/dev/null 2>&1 || true');
    expect(script).toContain('sudo mkdir -p /var/lib/dbus 2>/dev/null || true');
    expect(script).toContain('printf \'%s\\n\' "$RELAY_MACHINE_ID" | sudo tee /var/lib/dbus/machine-id >/dev/null 2>&1 || true');
    // Never a bare (non-sudo) redirect into a root-owned file — that crash-looped boot.
    expect(script).not.toMatch(/> \/etc\/machine-id/);
    expect(script).not.toMatch(/> \/var\/lib\/dbus\/machine-id/);
    expect(script).toContain('hostname "$RELAY_HOSTNAME" >/dev/null 2>&1 || true');
  });
});

// The host runs this script once per machine boot and once per deploy (audit
// d.4 #11): it must be idempotent, never fail the boot on a download, never
// re-download mise that is already on the volume, and never chown the volume.
describe('setup-workspace script — behaviour under the host', () => {
  const scriptPath = path.resolve(process.cwd(), 'setup-workspace.sh');

  function run(workspace: string) {
    return spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: workspace,
        WORKSPACE: workspace,
        // Never touch this box's /etc/machine-id or hostname.
        RELAY_SETUP_SYSTEM_IDENTITY: '0',
        // Every download fails fast (nothing listens on port 9).
        HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
      },
    });
  }
  const status = (ws: string) => fs.readFileSync(path.join(ws, '.bootstrap-status'), 'utf8');

  it('has no recursive chown and checks the volume mise path, not just PATH', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).not.toMatch(/^[^#\n]*chown\s+-R/m);
    expect(script).toContain('[[ -x "$MISE_BIN_DIR/mise" ]]');
    expect(script).not.toMatch(/^\s*curl https:\/\/mise\.run/m);
  });

  it('offline: exits 0, records the failed downloads, and a second run rewrites nothing', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'));
    try {
      const first = run(ws);
      expect(first.status, first.stderr).toBe(0);
      expect(status(ws)).toContain('mise=failed');
      expect(status(ws)).toContain('bootstrap=partial');
      const files = ['.bashrc', '.bash_profile', '.relay/state/tool-env.sh', '.relay/bin/relay-browser', '.relay/bin/relay-chrome']
        .map((rel) => path.join(ws, rel));
      const past = new Date(Date.now() - 3_600_000);
      for (const f of files) fs.utimesSync(f, past, past);
      const before = files.map((f) => fs.statSync(f).mtimeMs);
      const second = run(ws);
      expect(second.status, second.stderr).toBe(0);
      expect(files.map((f) => fs.statSync(f).mtimeMs)).toEqual(before);
      expect(fs.statSync(path.join(ws, '.relay/bin/relay-chrome')).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('mise already on the volume → not downloaded again', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'));
    try {
      const mise = path.join(ws, '.relay/tools/mise/bin/mise');
      fs.mkdirSync(path.dirname(mise), { recursive: true });
      fs.writeFileSync(mise, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = run(ws);
      expect(result.status, result.stderr).toBe(0);
      expect(status(ws)).toContain('mise=ready');
      expect(result.stderr).not.toContain('mise download failed');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
