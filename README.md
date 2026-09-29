# Relay Backend

Relay is a backend service for browser-based terminal access. This repository owns the server-side PTY relay, auth validation, and persistent workspace bootstrap for Railway-mounted volumes.

The frontend should live in a separate codebase and connect to this service over HTTP and Socket.IO. See [docs/frontend-handoff.md](/home/user/relay/docs/frontend-handoff.md:1).

## Features

- Token-based backend auth validation
- Socket.IO terminal transport
- One PTY per client connection
- Workspace-scoped shell environment
- First-boot workspace bootstrap for persistent Railway volumes
- Authenticated live context snapshot API for Relay-aware tooling and UI inspection

## Local development

Install dependencies:

```sh
npm install
```

Run the backend:

```sh
mkdir -p /tmp/relay-workspace
AUTH_TOKEN=change-this-token WORKSPACE=/tmp/relay-workspace PORT=3012 npm start
```

Useful checks:

```sh
curl http://localhost:3012/
curl http://localhost:3012/health
curl -H 'x-auth-token: change-this-token' http://localhost:3012/api/auth/validate
```

The live context bridge is available at `POST /api/context/snapshot` with the Relay auth token. The web client uses it to render the current workspace, terminal, Git, preview, and Flutter state as one JSON snapshot.

## MCP bridge

Relay also ships a standalone MCP server for local clients and agents.

Run it with:

```sh
RELAY_BACKEND_URL=http://127.0.0.1:8080 AUTH_TOKEN=change-this-token npm run mcp
```

It exposes tools for:

- workspace snapshots and health
- project listing and selection
- project trees and file reads
- terminal creation, selection, close, and command dispatch
- preview port serving
- Flutter status, build, serve, reload, restart, and stop

The MCP server talks to the live Relay backend over HTTP and Socket.IO, so it can inspect logs and drive the same workspace state the UI sees.

Run tests:

```sh
npm test
```

## Deploy (Fly.io)

On Fly, relay-server is not an app of its own. It is a **release** that the relay host
(relay-pty repo, Fly app `relay-host`) installs on its volume and hot-swaps.
Terminals live in the host and survive every relay-server deploy.

- `npm run pack:release` → `release.tgz` + `manifest.json`: the release contract
  (relay-pty README, "Release contract").
- CI: `.github/workflows/release.yml` runs `tsc`, vitest (with the parity
  ratchet), `npm run build`, `pack:release` and uploads the artifact on every push/PR. On `main`
  (or a manual run) it `POST`s the tarball to `$RELAY_HOST_URL/__host/releases`
  and follows the deploy until `ACTIVE`, failing with the host's deploy log. It is
  **skipped** until the repo secrets `RELAY_HOST_URL` and `RELAY_DEPLOY_TOKEN` exist.
- By hand: `relay-host deploy release.tgz --id <id>`; roll back with `relay-host rollback`.
- Runbook (setup, secrets, the Railway→Fly migration, and the CLAUDE.md rule-2 text for
  after the cutover): relay-pty `docs/DEPLOY-FLY.md`.

Until the cutover, production still runs on Railway as described below.

## Railway deployment (until the Fly cutover)

1. Create a Railway project for the backend.
2. Add a persistent volume and mount it at `/workspace`.
3. Set the required environment variables:
   - `AUTH_TOKEN`
   - `WORKSPACE=/workspace`
4. Ensure `railway.toml` is present in the repo root.
5. Deploy and watch the startup logs for workspace bootstrap output.

On startup, Relay runs `setup-workspace.sh` before the HTTP server starts. That script initializes the mounted workspace with:

- `/workspace/.bashrc`
- `/workspace/.bash_profile`
- `/workspace/.gemini/settings.json`
- `/workspace/.relay/bin/relay-browser`
- `/workspace/.relay/tools`
- `/workspace/.relay/cache`
- `/workspace/.relay/state`
- `/workspace/projects`
- `/workspace/.bootstrap-status`

If every managed component is present, the script writes `/workspace/.bootstrapped`.
If optional toolchain pieces such as `nvm` or `mise` are skipped or fail, Relay still starts, but `/workspace/.bootstrapped` is removed and `/workspace/.bootstrap-status` records the partial state so later restarts can retry the missing pieces.

## Security

- Never share `AUTH_TOKEN`.
- This backend exposes shell access to anyone who can present the valid token.
- Do not deploy without setting a strong token value.
