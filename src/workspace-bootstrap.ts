import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

export type ExecFileFn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
) => Promise<{
  stderr: string;
  stdout: string;
}>;

export type BootstrapLogger = Pick<Console, 'error' | 'log'>;

export function resolveSetupScriptPath(): string {
  return path.resolve(process.cwd(), 'setup-workspace.sh');
}

export function createExecFile(): ExecFileFn {
  return promisify(execFileCallback);
}

export async function runWorkspaceBootstrap(
  execFile: ExecFileFn = createExecFile(),
  logger: BootstrapLogger = console
): Promise<void> {
  const scriptPath = resolveSetupScriptPath();
  const workspace = process.env.WORKSPACE || '/workspace';

  logger.log(`[bootstrap] starting workspace bootstrap using ${scriptPath}`);

  try {
    const { stdout, stderr } = await execFile(scriptPath, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKSPACE: workspace,
      },
    });

    if (stdout.trim().length > 0) {
      logger.log(stdout.trimEnd());
    }

    if (stderr.trim().length > 0) {
      logger.error(stderr.trimEnd());
    }

    logger.log('[bootstrap] workspace bootstrap completed');
  } catch (error) {
    logger.error('[bootstrap] workspace bootstrap failed');
    throw error;
  }
}
