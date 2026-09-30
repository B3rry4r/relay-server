# Relay Backend

Relay is a backend service for browser-based terminal access. This repository owns the server-side PTY relay, auth validation, and persistent workspace bootstrap for Railway-mounted volumes.

The frontend should live in a separate codebase and connect to this service over HTTP and Socket.IO. See [docs/frontend-handoff.md](/home/user/relay/docs/frontend-handoff.md:1).

## Features

- Session auth: owner password → revocable session tokens, default-deny API (see **Auth** below)
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
AUTH_TOKEN='a-long-local-dev-secret' WORKSPACE=/tmp/relay-workspace PORT=3012 npm start
```

Useful checks:

```sh
curl http://localhost:3012/health
TOKEN=$(curl -s -H 'content-type: application/json' -d '{"secret":"a-long-local-dev-secret"}' \
  http://localhost:3012/api/auth/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -H "Authorization: Bearer $TOKEN" http://localhost:3012/api/auth/session
```

The live context bridge is available at `POST /api/context/snapshot` (authenticated like every other API route). The web client uses it to render the current workspace, terminal, Git, preview, and Flutter state as one JSON snapshot.

## Auth

Every route is **default-deny** (the middleware runs before all routes in
`createRelayServer`); the only public routes are `GET /`, `GET /health`,
`GET /api/version`, `POST /api/auth/login`, `POST /api/auth/login-link/exchange`,
CORS preflights, and `/flutter-preview/:projectId/c/:cap/*` (a path capability).

| Credential | Where | Accepted |
|---|---|---|
| Owner secret | env `AUTH_TOKEN_HASH` (scrypt, `relay-auth hash-secret`) or `AUTH_TOKEN` (≥ 16 chars, deprecated) | only at `POST /api/auth/login`. Relay refuses to boot without one. Changing it logs every session out. |
| Session token `rs_…` | browser: localStorage `relay.session.v2`; tools: `RELAY_TOKEN` | `Authorization: Bearer` or `x-auth-token`, socket `auth.token`. Browser sessions: 30 d / 7 d idle. API sessions: 90 d. |
| Local token | `$WORKSPACE/.relay/state/local-token` (0600) | only from loopback with no forwarding headers; never at login |
| Legacy raw `AUTH_TOKEN` | old clients | as a Bearer/`x-auth-token`/socket token until first boot + 14 days (`RELAY_LEGACY_TOKEN_UNTIL` overrides; `off` closes it). Logged as `legacy-token-use`. |

There is no query-string (`?token=`) and no cookie auth. The old `relay_auth_token`
cookie is cleared on sight.

Endpoints: `POST /api/auth/login {secret, label?}` → `{token, session}` ·
`GET /api/auth/session` (alias `/api/auth/validate`) · `POST /api/auth/logout` ·
`GET /api/auth/sessions` · `POST /api/auth/sessions {label, kind:'api', ttlDays?}` ·
`DELETE /api/auth/sessions/:id` · `POST /api/auth/sessions/revoke-all {keepCurrent?}` ·
`POST /api/auth/session/rotate` · `POST /api/auth/login-link` →
`POST /api/auth/login-link/exchange {code}`. Failed password logins back off per
client IP (1 s doubling to 60 s; other clients' failures never block you; loopback
exempt). The login-link exchange is not rate-limited, so break-glass always works.
Behind a proxy that is not on loopback (e.g. Railway's edge) set `RELAY_TRUST_PROXY`
(e.g. `1`) so the backoff is per client rather than shared.

On the box, `relay-auth` (installed into `$RELAY_HOME/bin`) uses the local token:

```sh
relay-auth login-link          # one-time sign-in link for relay-web (break-glass, 5 min)
relay-auth sessions            # list
relay-auth revoke <id>|--all   # revoke + disconnect sockets
relay-auth mint --label mcp    # api session token for MCP / UIX (shown once)
relay-auth local-token --rotate
printf '%s' "$SECRET" | relay-auth hash-secret   # → AUTH_TOKEN_HASH value
```

Browsers: set `RELAY_ALLOWED_ORIGINS` to the relay-web origin(s) (comma list;
`RELAY_WEB_ORIGIN_PATTERN=https://*.fly.dev` also matches one-label hosts). If it is
unset only `http://localhost:5173` is allowed and a warning is logged at boot.
Behind a proxy, `trust proxy` is `loopback` (override with `RELAY_TRUST_PROXY`).

Secrets (`AUTH_TOKEN`, `AUTH_TOKEN_HASH`, `RELAY_PTY_TOKEN`, `RELAY_DEPLOY_TOKEN`,
`UIX_SERVICE_TOKEN`, `RELAY_TOKEN`) are moved out of `process.env` at boot and are
never passed to terminals, agents or any other child process (`PORT`, `FLY_*` and
the release variables are stripped too). UIX is called with `UIX_SERVICE_TOKEN`;
the browser reaches UIX only through `ALL /api/uix/*`.

## Agent view

The Agent view renders a CLI agent (Claude Code, Codex, Gemini CLI, opencode)
that runs **interactively in a terminal** as phone-sized cards. The agent keeps
running in the PTY; nothing about the terminal changes.

- **Install (every boot)**: `setup-workspace.sh` copies `agent/relay-agent-hook`
  into `$RELAY_HOME/bin` and runs `scripts/relay-agent-install.mjs`, which adds a
  marked guide block (`agent/RELAY-AGENT-GUIDE.md`) to each CLI's global
  instructions and Relay's hook entries to its global settings (user content is
  never touched; invalid JSON is skipped). Codex gets `[features] hooks = true`
  and `daemon_auto_start = false`, and asks once in its TUI to trust the hooks.
- **Tracker** (`src/relay-server/agent/`): reads the hook spool
  (`$RELAY_HOME/state/agent-events/<terminalId>.jsonl`) and the CLI transcripts,
  validates each hook record by its process lineage against the terminal's
  `/proc` tree, and emits `agent:*` socket events. Answers to permission prompts
  (`agent:respond`) are written as keystrokes **only** when the prompt is on that
  terminal's screen (headless xterm ScreenGuard).
- **Protocol**: server → client `agent:sessions`, `agent:snapshot`,
  `agent:event`, `agent:events`; client → server `agent:subscribe`,
  `agent:unsubscribe`, `agent:history`, `agent:respond`, `agent:send`,
  `agent:choose`, `agent:interrupt`, `agent:bind`. Types:
  `src/relay-server/agent/types.ts`.
- **Switches**: `RELAY_AGENT_VIEW=off` disables the tracker;
  `RELAY_AGENT_GUIDE=off` removes the guide blocks at the next boot (hooks stay).

## MCP bridge

Relay also ships a standalone MCP server for local clients and agents.

Run it with:

```sh
# on the relay box: the local-token file is used automatically
npm run mcp
# anywhere else: an api session minted with `relay-auth mint --label mcp`
RELAY_BACKEND_URL=https://relay.example.com RELAY_TOKEN=rs_… npm run mcp
```

Credential order: `RELAY_TOKEN` → the local-token file → `AUTH_TOKEN` (legacy window
only, with a warning). UIX tools go through relay's `/api/uix` proxy.

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
  and follows the deploy until `ACTIVE`, then keeps watching it for `STABLE_SECS`
  (120 s). It fails with the host's deploy log on `FAILED`, on `ROLLED_BACK` (the host
  rolls back a release that crash-loops after activation) and on any crash or down
  period inside that window. A crash loop slower than the window is still rolled back
  by the host, after the job has finished. The step's own script is tested against a
  fake host in `test/deploy/release-deploy-step.test.ts`. The deploy job is
  **skipped** until the repo secrets `RELAY_HOST_URL` and `RELAY_DEPLOY_TOKEN` exist.
- By hand: `relay-host deploy release.tgz --id <id>`; roll back with `relay-host rollback`.
- Runbook (setup, secrets, the Railway→Fly migration, and the CLAUDE.md rule-2 text for
  after the cutover): relay-pty `docs/DEPLOY-FLY.md`.

Until the cutover, production still runs on Railway as described below.

## Railway deployment (until the Fly cutover)

1. Create a Railway project for the backend.
2. Add a persistent volume and mount it at `/workspace`.
3. Set the required environment variables:
   - `AUTH_TOKEN_HASH` (preferred; `relay-auth hash-secret`) or `AUTH_TOKEN` (≥ 16 chars)
   - `RELAY_ALLOWED_ORIGINS` (the relay-web origin)
   - `UIX_URL` + `UIX_SERVICE_TOKEN`
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
