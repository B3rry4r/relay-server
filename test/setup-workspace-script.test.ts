import fs from 'node:fs';
import path from 'node:path';
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
