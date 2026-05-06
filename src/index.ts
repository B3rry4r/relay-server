import { createRelayServer } from './relay-server';
import { runWorkspaceBootstrap } from './workspace-bootstrap';

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function main(): Promise<void> {
  await runWorkspaceBootstrap();
  const relay = createRelayServer();
  const port = await relay.start();
  console.log(`Relay listening on port ${port}`);
}

main().catch((error) => {
  console.error('Relay failed to start', error);
  process.exit(1);
});
