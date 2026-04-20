import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSetupScriptPath, runWorkspaceBootstrap, type BootstrapLogger, type ExecFileFn } from '../src/workspace-bootstrap';

describe('workspace bootstrap', () => {
  afterEach(() => {
    delete process.env.WORKSPACE;
  });

  it('resolves the setup script from the repo root', () => {
    expect(resolveSetupScriptPath()).toBe(path.resolve(process.cwd(), 'setup-workspace.sh'));
  });

  it('runs the setup script with the workspace in the environment', async () => {
    process.env.WORKSPACE = '/tmp/relay-workspace';

    const execFile = vi.fn<ExecFileFn>().mockResolvedValue({
      stdout: '[bootstrap] ok\n',
      stderr: '',
    });
    const logger: BootstrapLogger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await runWorkspaceBootstrap(execFile, logger);

    expect(execFile).toHaveBeenCalledWith(
      path.resolve(process.cwd(), 'setup-workspace.sh'),
      [],
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          WORKSPACE: '/tmp/relay-workspace',
        }),
      })
    );
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('[bootstrap] starting workspace bootstrap'));
    expect(logger.log).toHaveBeenCalledWith('[bootstrap] ok');
    expect(logger.log).toHaveBeenCalledWith('[bootstrap] workspace bootstrap completed');
  });

  it('logs and rethrows bootstrap failures', async () => {
    const execFile = vi.fn<ExecFileFn>().mockRejectedValue(new Error('exec failed'));
    const logger: BootstrapLogger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(runWorkspaceBootstrap(execFile, logger)).rejects.toThrow('exec failed');
    expect(logger.error).toHaveBeenCalledWith('[bootstrap] workspace bootstrap failed');
  });
});
