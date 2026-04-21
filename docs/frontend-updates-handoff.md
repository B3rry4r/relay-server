# Relay Frontend Updates Handoff

This document is a pure backend API update contract for the separate frontend project.

It documents the additional backend capabilities implemented after the original handoff.

Use this together with:

- [frontend-handoff.md](/home/user/relay/docs/frontend-handoff.md:1)

This file contains:

- auth requirements
- endpoint definitions
- socket event definitions
- request payloads
- success payloads
- error payloads
- implementation notes where behavior is not obvious from the schema

It does not contain UI instructions.

## Base URL

Current deployed backend:

`https://relay-server-production-5d2f.up.railway.app`

## Auth

All endpoints in this document require backend auth.

Accepted auth methods:

### Header option 1

```http
x-auth-token: <token>
```

### Header option 2

```http
Authorization: Bearer <token>
```

## Standard Auth Failure

Unless stated otherwise, protected endpoints return:

Status:

```http
401 Unauthorized
```

Body:

```json
{
  "error": "unauthorized",
  "message": "A valid auth token is required."
}
```

## Standard Project Not Found Failure

Project-scoped endpoints return:

Status:

```http
404 Not Found
```

Body:

```json
{
  "error": "project_not_found",
  "message": "Project not found."
}
```

## Socket Additions

The backend still emits the existing raw terminal socket stream:

- event: `output`
- payload: raw PTY bytes as a string

The backend now also emits structured shell transcript events on the same socket:

- event: `shell_event`
- payload: one of the event shapes documented below

### Socket Auth

Socket auth remains:

```json
{
  "auth": {
    "token": "<token>"
  }
}
```

### `shell_event` Payloads

#### `command_started`

```json
{
  "type": "command_started",
  "commandId": "cmd-1",
  "command": "npm test",
  "cwd": "/workspace/projects/my-app",
  "source": "terminal",
  "startedAt": "2026-04-21T01:23:45.000Z"
}
```

#### `command_output`

```json
{
  "type": "command_output",
  "commandId": "cmd-1",
  "stream": "stdout",
  "chunk": " RUN  v3.2.4 /workspace/projects/my-app\n"
}
```

#### `command_finished`

```json
{
  "type": "command_finished",
  "commandId": "cmd-1",
  "exitCode": 0,
  "finishedAt": "2026-04-21T01:23:48.000Z",
  "durationMs": 3000
}
```

#### `cwd_changed`

```json
{
  "type": "cwd_changed",
  "cwd": "/workspace/projects/my-app/src"
}
```

#### `prompt`

```json
{
  "type": "prompt",
  "cwd": "/workspace/projects/my-app/src",
  "prompt": ""
}
```

### Structured Shell Event Notes

- `output` remains the source of truth for terminal rendering
- `shell_event` exists for chat transcript semantics
- current `command_started.source` is always `terminal`
- current `command_output.stream` is always `stdout`
- events are generated for the same live shell session as the raw PTY stream
- prompt detection currently relies on the Bash prompt marker added by the backend
- if the runtime shell is not Bash, prompt/cwd lifecycle events may be reduced

## Updated Existing Endpoint

## `POST /api/projects`

Creates a project under `/workspace/projects/:name`.

### Request

```json
{
  "name": "my-app",
  "template": "blank",
  "initializeGit": true
}
```

## New Endpoint

## `POST /api/projects/clone`

Clones a repository into `/workspace/projects/:name`.

### Request

```json
{
  "url": "https://github.com/example/repo.git",
  "name": "repo",
  "branch": "main",
  "provider": "url",
  "auth": {
    "username": "git",
    "token": "ghp_example"
  }
}
```

### Request Notes

- `url` required
- `name` optional
  - if omitted, backend infers it from repository name
- `branch` optional
- `provider` currently supports only `url`
- `auth` optional
  - for HTTPS Git auth
  - current implementation supports direct credentials only

### Success

Status:

```http
201 Created
```

Body:

```json
{
  "project": {
    "id": "repo",
    "name": "repo",
    "path": "/workspace/projects/repo"
  }
}
```

### Unsupported Provider Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "unsupported_provider",
  "message": "Only provider=url is currently supported."
}
```

### Clone Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "git_clone_failed",
  "message": "Clone failed."
}
```

### Supported `template` values

- `blank`
- `node-api`
- `next-app`
- `python-api`
- `static-site`
- `cli-tool`

### Success

Status:

```http
201 Created
```

Body:

```json
{
  "project": {
    "id": "my-app",
    "name": "my-app",
    "path": "/workspace/projects/my-app",
    "gitInitialized": true
  }
}
```

### Invalid Name Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "invalid_project_name",
  "message": "Project names may only contain letters, numbers, hyphens, underscores, and periods."
}
```

### Project Exists Failure

Status:

```http
409 Conflict
```

Body:

```json
{
  "error": "project_exists",
  "message": "A project with this name already exists."
}
```

### Git Initialization Failure

Status:

```http
500 Internal Server Error
```

Body:

```json
{
  "error": "git_init_failed",
  "message": "Git initialization failed."
}
```

## Updated Existing Endpoint

## `GET /api/previews`

Returns detected listening ports from the runtime environment.

### Request

No query/body required.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "previews": [
    {
      "port": 3000,
      "label": "Port 3000",
      "url": "/preview/3000",
      "status": "active"
    }
  ]
}
```

### Notes

- current implementation is runtime detection only
- named previews are not persisted
- ordering is ascending by port number

## New Endpoint

## `GET /api/projects/quick-switch`

Returns a project list enriched with recent/pinned state.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "my-app",
      "path": "/workspace/projects/my-app",
      "pinned": true,
      "recent": true
    }
  ]
}
```

### Notes

- `recent` is updated when `POST /api/session/project` is called
- `pinned` is updated via `POST /api/projects/:projectId/pin`

## New Endpoint

## `POST /api/projects/:projectId/pin`

Pins or unpins a project.

### Request

```json
{
  "pinned": true
}
```

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "projectId": "my-app",
  "pinned": true
}
```

## New Endpoint

## `POST /api/projects/:projectId/duplicate`

Duplicates a file or folder inside a project.

### Request

```json
{
  "path": "src/index.ts",
  "newName": "index-copy.ts"
}
```

### Success

Status:

```http
201 Created
```

Body:

```json
{
  "duplicated": {
    "sourcePath": "src/index.ts",
    "duplicatedPath": "src/index-copy.ts"
  }
}
```

### Invalid Path Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "invalid_path",
  "message": "Path is invalid."
}
```

## New Endpoint

## `GET /api/projects/:projectId/download`

Downloads a file from a project.

### Query Parameters

- `path` required

Example:

```text
/api/projects/my-app/download?path=src/index.ts
```

### Success

Status:

```http
200 OK
```

Body:

- raw file body

### File Not Found Failure

Status:

```http
404 Not Found
```

Body:

```json
{
  "error": "file_not_found",
  "message": "File not found."
}
```

## New Endpoint

## `POST /api/projects/:projectId/upload`

Uploads a file into a project using base64 content.

### Request

```json
{
  "parentPath": "src",
  "name": "upload.txt",
  "contentBase64": "aGVsbG8="
}
```

### Success

Status:

```http
201 Created
```

Body:

```json
{
  "uploaded": {
    "path": "src/upload.txt"
  }
}
```

### Invalid Request Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "invalid_request",
  "message": "parentPath and name are required."
}
```

## New Endpoint

## `GET /api/projects/:projectId/notes`

Reads plain project notes from `.relay-notes.md`.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "content": "remember to add auth"
}
```

### Notes

- missing notes file returns empty string content

## New Endpoint

## `PUT /api/projects/:projectId/notes`

Writes plain project notes to `.relay-notes.md`.

### Request

```json
{
  "content": "remember to add auth"
}
```

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "content": "remember to add auth"
}
```

## New Endpoint

## `GET /api/projects/:projectId/tasks`

Returns inferred task chips from project files.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "tasks": [
    {
      "id": "dev",
      "label": "dev",
      "command": "npm run dev"
    },
    {
      "id": "test",
      "label": "test",
      "command": "npm run test"
    }
  ]
}
```

### Notes

- current implementation infers tasks from `package.json` scripts
- recognized script ids include:
  - `dev`
  - `test`
  - `lint`
  - `build`
  - `migrate`
  - `seed`
  - `start`
- if `requirements.txt` exists, Python install task may be included

## New Endpoint

## `GET /api/projects/:projectId/suggestions`

Returns inferred command suggestions from project context.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "suggestions": [
    {
      "id": "npm-install",
      "label": "Install dependencies",
      "command": "npm install"
    },
    {
      "id": "npm-dev",
      "label": "Run dev server",
      "command": "npm run dev"
    },
    {
      "id": "git-status",
      "label": "Git status",
      "command": "git status"
    }
  ]
}
```

### Notes

- suggestions are inferred from presence of:
  - `package.json`
  - `requirements.txt`
  - `.git`

## New Endpoint

## `GET /api/workspace/health`

Returns expanded workspace health information.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "workspace": "/workspace",
  "bootstrapped": true,
  "status": {
    "bootstrap": "complete",
    "nvm": "installed",
    "homebrew": "installed"
  },
  "toolchains": {
    "git": "git version 2.39.5",
    "node": "v22.22.2"
  },
  "disk": {
    "available": 123456789,
    "total": 987654321
  },
  "activePorts": [3000]
}
```

### Notes

- `activePorts` uses runtime listening-port detection
- `toolchains` values may be `false` if unavailable
- `disk.available` and `disk.total` may be `null` if filesystem stats cannot be read

## New Endpoint

## `POST /api/command-results/parse`

Parses known command outputs into structured response cards.

### Request

```json
{
  "command": "git status",
  "output": "On branch main\nnothing to commit, working tree clean\n"
}
```

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "result": {
    "type": "git-status",
    "summary": "Working tree clean",
    "details": {
      "branch": "main",
      "clean": true
    }
  }
}
```

### Supported Result Types

Current parser supports:

- `git-status`
- `npm-install`
- `test-results`
- `raw`

### Example `npm-install`

```json
{
  "result": {
    "type": "npm-install",
    "summary": "Added 42 packages",
    "details": {
      "addedPackages": 42
    }
  }
}
```

### Example `test-results`

```json
{
  "result": {
    "type": "test-results",
    "summary": "Tests passed",
    "details": {
      "passed": 12,
      "failed": 0
    }
  }
}
```

### Raw Fallback

```json
{
  "result": {
    "type": "raw",
    "summary": "No structured parser available"
  }
}
```

## New Git Endpoints

All endpoints below operate inside the selected project root.

## `GET /api/projects/:projectId/git/status`

Returns structured Git status.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "branch": "main",
  "ahead": 1,
  "behind": 0,
  "clean": false,
  "staged": [
    {
      "path": "src/App.tsx",
      "status": "modified"
    }
  ],
  "unstaged": [
    {
      "path": "src/index.css",
      "status": "modified"
    }
  ],
  "untracked": [
    {
      "path": "src/new-file.ts"
    }
  ],
  "conflicts": []
}
```

### Not a Git Repo Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "not_a_git_repo",
  "message": "Git repository not detected for this project. Project setup may not have initialized Git successfully."
}
```

## `GET /api/projects/:projectId/git/diff`

Returns unified diff text.

### Query Parameters

- `path` optional
- `staged` optional, `true` or `false`

### Success

```json
{
  "diff": "diff --git a/file b/file\n..."
}
```

## `GET /api/projects/:projectId/git/branches`

Returns branch list and current branch.

### Success

```json
{
  "current": "main",
  "branches": [
    "main",
    "feature/test"
  ]
}
```

## `POST /api/projects/:projectId/git/stage`

Stages one or more paths.

### Request

```json
{
  "paths": ["src/App.tsx", "src/index.css"]
}
```

### Success

```json
{
  "ok": true
}
```

## `POST /api/projects/:projectId/git/unstage`

Unstages one or more paths.

### Request

```json
{
  "paths": ["src/App.tsx"]
}
```

### Success

```json
{
  "ok": true
}
```

## `POST /api/projects/:projectId/git/discard`

Discards working tree changes for one or more paths.

### Request

```json
{
  "paths": ["src/App.tsx"]
}
```

### Success

```json
{
  "ok": true
}
```

## `POST /api/projects/:projectId/git/commit`

Creates a commit from staged changes.

### Request

```json
{
  "message": "feat: update app"
}
```

### Success

```json
{
  "ok": true,
  "commit": {
    "message": "feat: update app",
    "hash": "abc1234"
  }
}
```

### Invalid Message Failure

```json
{
  "error": "invalid_commit_message",
  "message": "Commit message is required."
}
```

### Commit Failure

```json
{
  "error": "git_commit_failed",
  "message": "Commit failed."
}
```

## `POST /api/projects/:projectId/git/branch/checkout`

Checks out an existing branch or creates a new branch.

### Request

```json
{
  "branch": "feature/test",
  "create": true
}
```

### Success

```json
{
  "ok": true,
  "branch": "feature/test"
}
```

### Failure

```json
{
  "error": "git_checkout_failed",
  "message": "Checkout failed."
}
```

## `POST /api/projects/:projectId/git/pull`

Performs:

- `git pull --ff-only`

### Request

```json
{
  "auth": {
    "username": "git",
    "token": "ghp_example"
  }
}
```

### Success

```json
{
  "ok": true,
  "output": "Already up to date."
}
```

### Failure

```json
{
  "error": "git_pull_failed",
  "message": "Pull failed."
}
```

## `POST /api/projects/:projectId/git/push`

Performs:

- `git push`

### Request

```json
{
  "auth": {
    "username": "git",
    "token": "ghp_example"
  }
}
```

### Success

```json
{
  "ok": true,
  "output": "..."
}
```

### Failure

```json
{
  "error": "git_push_failed",
  "message": "Push failed."
}
```

## Git Auth Notes

Current backend support:

- direct HTTPS auth via request body
- fields:
  - `auth.username`
  - `auth.token`
  - `auth.password`

Current backend does not implement:

- GitHub OAuth
- GitLab OAuth
- saved connected Git providers
- SSH key management

Frontend should therefore support two clone/push/pull modes:

1. direct URL + direct credentials
2. future connected-provider flow when backend adds provider integration

## Existing Endpoint With Important Runtime Behavior

## `POST /api/session/project`

Behavior update:

- marks the project as recent for `GET /api/projects/quick-switch`

### Request

```json
{
  "projectId": "my-app"
}
```

### Success

```json
{
  "project": {
    "id": "my-app",
    "path": "/workspace/projects/my-app"
  },
  "shell": {
    "cwd": "/workspace/projects/my-app",
    "suggestedCommand": "cd /workspace/projects/my-app"
  }
}
```

## Current Limitations

- preview discovery is runtime-detected only, not persisted
- task chips are inferred, not user-managed
- notes are plain text only
- command result parsing supports a limited set of command families
- upload uses base64 JSON payloads, not multipart form uploads
