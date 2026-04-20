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

  it('skips optional tool installs instead of crashing when prerequisites are missing', () => {
    expect(script).toContain('skipping nvm install because git is unavailable');
    expect(script).toContain('skipping Homebrew install because curl and git are required at runtime');
  });
});
