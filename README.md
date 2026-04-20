# Relay Backend

Relay is a backend service for browser-based terminal access. This repository owns the server-side PTY relay, auth validation, and persistent workspace bootstrap for Railway-mounted volumes.

The frontend should live in a separate codebase and connect to this service over HTTP and Socket.IO. See [docs/frontend-contract.md](/home/user/relay/docs/frontend-contract.md:1).

## Features

- Token-based backend auth validation
- Socket.IO terminal transport
- One PTY per client connection
- Workspace-scoped shell environment
- First-boot workspace bootstrap for persistent Railway volumes

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

Run tests:

```sh
npm test
```

## Railway deployment

1. Create a Railway project for the backend.
2. Add a persistent volume and mount it at `/workspace`.
3. Set the required environment variables:
   - `AUTH_TOKEN`
   - `WORKSPACE=/workspace`
4. Ensure `railway.toml` is present in the repo root.
5. Deploy and watch the startup logs for workspace bootstrap output.

On first boot, Relay runs `setup-workspace.sh` before the HTTP server starts. That script initializes the mounted workspace with:

- `/workspace/.bashrc`
- `/workspace/.bash_profile`
- `/workspace/.nvm`
- `/workspace/homebrew`
- `/workspace/.npm-global`
- `/workspace/.local`
- `/workspace/projects`

The `.bootstrapped` flag prevents repeated initialization on later restarts.

## Security

- Never share `AUTH_TOKEN`.
- This backend exposes shell access to anyone who can present the valid token.
- Do not deploy without setting a strong token value.
