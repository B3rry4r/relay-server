import { ensureReaperOrReExec } from './pid1-reaper';
import { createRelayServer } from './relay-server';
import { runWorkspaceBootstrap } from './workspace-bootstrap';
import { sealProcessSecrets } from './relay-server/auth/secrets';
import { validateOwnerSecretEnv } from './relay-server/auth/owner-secret';

async function main(): Promise<void> {
  // 1. Move every secret out of process.env BEFORE anything is spawned, so no
  //    child (bootstrap script, PTY, agent, git, Chrome, npm, …) can inherit it.
  //    Readers use getSecret() (auth/secrets.ts).
  sealProcessSecrets();
  // 2. Refuse to boot without a usable owner secret (no silent "the password is
  //    the published placeholder").
  const secretCheck = validateOwnerSecretEnv();
  if (!secretCheck.ok) {
    console.error(`[relay] FATAL: ${secretCheck.error}`);
    process.exit(1);
  }
  for (const warning of secretCheck.warnings) console.warn(`[relay] ${warning}`);

  await runWorkspaceBootstrap();
  const relay = createRelayServer();
  const port = await relay.start();
  console.log(`Relay listening on port ${port}`);
}

// Zombie-reaper safety net: if we're PID 1 without an init (tini bypassed), re-exec
// under `tini -s` so orphaned grandchildren (headless Chrome) get reaped. When this
// returns true the process is just the tini wrapper — do NOT boot the server here.
if (!ensureReaperOrReExec()) {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  main().catch((error) => {
    console.error('Relay failed to start', error);
    process.exit(1);
  });
}
