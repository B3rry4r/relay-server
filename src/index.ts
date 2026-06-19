import { ensureReaperOrReExec } from './pid1-reaper';
import { createRelayServer } from './relay-server';
import { runWorkspaceBootstrap } from './workspace-bootstrap';

async function main(): Promise<void> {
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
