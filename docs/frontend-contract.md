# Relay Frontend Contract

This repository is the Relay backend only. It does not render the product UI.

## Purpose

The frontend should live in a separate codebase and connect to this server over HTTP and Socket.IO.

## HTTP endpoints

### `GET /`

Returns service metadata:

```json
{
  "name": "Relay",
  "service": "terminal-backend",
  "status": "ok",
  "transport": {
    "httpAuthHeader": "x-auth-token",
    "socketAuthField": "auth.token",
    "socketPath": "/socket.io"
  }
}
```

### `GET /health`

Returns:

```json
{
  "ok": true
}
```

### `GET /api/auth/validate`

Validates an auth token before the frontend opens a terminal session.

Accepted token inputs:
- `x-auth-token: <token>`
- `authorization: Bearer <token>`
- `?token=<token>` for non-production convenience only

Success response:

```json
{
  "authenticated": true
}
```

Failure response:

```json
{
  "error": "unauthorized",
  "message": "A valid auth token is required."
}
```

## Socket.IO contract

Connect with:

```ts
io(serverUrl, {
  auth: {
    token: authToken
  }
})
```

If the token is invalid, the socket connection is rejected with `Unauthorized`.

## Socket events

### Client -> server

- `input`: `string`
- `resize`: `{ cols: number, rows: number }`

### Server -> client

- `output`: `string`

The backend always emits raw terminal bytes. Rendering mode selection is a frontend concern.

## Shell behavior

- One PTY per socket connection
- Shell starts in `WORKSPACE`
- Shell `HOME` is set to `WORKSPACE`
- VS Code / Cloud Workstations shell prompt contamination is stripped before spawn
