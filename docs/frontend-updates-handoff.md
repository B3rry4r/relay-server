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
  "relay": {
    "root": "/workspace/.relay",
    "tools": "/workspace/.relay/tools",
    "cache": "/workspace/.relay/cache",
    "bin": "/workspace/.relay/bin",
    "state": "/workspace/.relay/state"
  },
  "status": {
    "bootstrap": "complete",
    "nvm": "installed",
    "nix": "available",
    "gemini_auth": "ready"
  },
  "toolchains": {
    "git": "git version 2.39.5",
    "node": "v22.22.2"
  },
  "disk": {
    "available": 123456789,
    "total": 987654321
  },
  "managedTools": [
    {
      "id": "python",
      "name": "Python",
      "description": "Python runtime installed from nixpkgs into persistent Relay-managed profiles.",
      "category": "language",
      "installMethod": "nix",
      "installPath": "/workspace/.relay/bin/python3",
      "installed": false,
      "source": "unavailable",
      "supported": true,
      "version": null
    }
  ],
  "nixPackages": [],
  "activePorts": [3000]
}
```

### Notes

- `relay` exposes the persistent volume-backed tool roots used by shell sessions and managed installs
- `managedTools` reports curated Relay-managed toolchains and whether they are currently available
- `activePorts` uses runtime listening-port detection
- `toolchains` values may be `false` if unavailable
- `disk.available` and `disk.total` may be `null` if filesystem stats cannot be read

## New Endpoint

## `GET /api/tools/catalog`

Returns the curated managed-tool catalog for the frontend install surfaces.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "tools": [
    {
      "id": "rust",
      "name": "Rust",
      "description": "Rust toolchain installed from nixpkgs into persistent Relay-managed profiles.",
      "category": "language",
      "installMethod": "nix",
      "installPath": "/workspace/.relay/bin/rustc",
      "supported": true
    },
    {
      "id": "flutter",
      "name": "Flutter",
      "description": "Flutter SDK installed into the persistent tool volume for web builds and port-based previews.",
      "category": "sdk",
      "installMethod": "git",
      "installPath": "/workspace/.relay/tools/flutter/bin/flutter",
      "supported": true
    }
  ],
  "customToolSupport": {
    "installRoot": "/workspace/.relay/tools",
    "binRoot": "/workspace/.relay/bin",
    "statePath": "/workspace/.relay/state/custom-tools.json"
  },
  "nixSupport": {
    "installRoot": "/workspace/.relay/tools/nix-profiles",
    "statePath": "/workspace/.relay/state/nix-packages.json",
    "searchEndpoint": "/api/tools/nix/search",
    "installEndpoint": "/api/tools/nix/install"
  }
}
```

## New Endpoint

## `GET /api/tools`

Returns current installation state for the managed-tool catalog.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "managedTools": [
    {
      "id": "flutter",
      "kind": "managed",
      "name": "Flutter",
      "description": "Flutter SDK installed into the persistent tool volume for web builds and port-based previews.",
      "category": "sdk",
      "installMethod": "git",
      "installPath": "/workspace/.relay/tools/flutter/bin/flutter",
      "installed": true,
      "source": "relay",
      "supported": true,
      "version": "Flutter 3.22.0"
    }
  ],
  "nixPackages": [
    {
      "id": "zig",
      "kind": "nix-package",
      "name": "Zig",
      "binary": "zig",
      "packageRef": "nixpkgs#zig",
      "installMethod": "nix",
      "installPath": "/workspace/.relay/bin/zig",
      "installed": true,
      "source": "relay",
      "version": "zig 0.13.0"
    }
  ],
  "customTools": [
    {
      "id": "hello-tool",
      "kind": "custom",
      "name": "Hello Tool",
      "description": "Custom tool installed into persistent Relay-managed paths.",
      "installMethod": "custom",
      "installPath": "/workspace/.relay/tools/hello-tool",
      "installed": true,
      "source": "relay",
      "supported": true,
      "version": "hello-tool 1.0.0"
    }
  ]
}
```

## New Endpoint

## `POST /api/tools/install`

Installs a managed tool into the persistent Relay volume paths.

### Request

```json
{
  "tool": "flutter"
}
```

### Supported Tool Values

- `php`
- `python`
- `go`
- `rust`
- `java`
- `flutter`

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "ok": true,
  "tool": {
    "id": "flutter",
    "name": "Flutter",
    "description": "Flutter SDK installed into the persistent tool volume for web builds and port-based previews.",
    "category": "sdk",
    "installMethod": "git",
    "installPath": "/workspace/.relay/tools/flutter/bin/flutter",
    "installed": true,
    "source": "relay",
    "supported": true,
    "version": "Flutter 3.22.0"
  }
}
```

### Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "unsupported_tool",
  "message": "The requested tool is not supported."
}
```

### Failure

Status:

```http
500 Internal Server Error
```

Body:

```json
{
  "error": "tool_install_failed",
  "message": "Tool installation failed."
}
```

## New Endpoint

## `GET /api/tools/nix/search`

Searches nix packages for command-palette install flows.

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "query": "zig",
  "results": [
    {
      "attr": "legacyPackages.x86_64-linux.zig",
      "name": "zig",
      "description": "Zig compiler",
      "version": "0.13.0",
      "packageRef": "nixpkgs#zig"
    }
  ]
}
```

## New Endpoint

## `POST /api/tools/nix/install`

Installs a nix package into a persistent Relay-managed profile and links the requested binary into `/workspace/.relay/bin`.

### Request

```json
{
  "id": "zig",
  "name": "Zig",
  "packageRef": "nixpkgs#zig",
  "binary": "zig"
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
  "ok": true,
  "tool": {
    "id": "zig",
    "kind": "nix-package",
    "name": "Zig",
    "binary": "zig",
    "packageRef": "nixpkgs#zig",
    "installMethod": "nix",
    "installPath": "/workspace/.relay/bin/zig",
    "installed": true,
    "source": "relay",
    "version": "zig 0.13.0"
  }
}
```

## New Endpoint

## `POST /api/tools/nix/uninstall`

Uninstalls a previously installed nix package and removes its linked binary.

### Request

```json
{
  "tool": "zig"
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
  "ok": true,
  "tool": {
    "id": "zig",
    "kind": "nix-package",
    "name": "Zig",
    "binary": "zig",
    "packageRef": "nixpkgs#zig",
    "installMethod": "nix",
    "installPath": "/workspace/.relay/bin/zig",
    "installed": false,
    "source": "unavailable",
    "version": null
  }
}
```

## New Endpoint

## `POST /api/tools/uninstall`

Removes a managed tool from the persistent Relay volume paths.

### Request

```json
{
  "tool": "flutter"
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
  "ok": true,
  "tool": {
    "id": "flutter",
    "name": "Flutter",
    "description": "Flutter SDK installed into the persistent tool volume for web builds and port-based previews.",
    "category": "sdk",
    "installMethod": "git",
    "installPath": "/workspace/.relay/tools/flutter/bin/flutter",
    "installed": false,
    "source": "unavailable",
    "supported": true,
    "version": null
  }
}
```

### Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "unsupported_tool",
  "message": "The requested tool is not supported."
}
```

### Failure

Status:

```http
500 Internal Server Error
```

Body:

```json
{
  "error": "tool_uninstall_failed",
  "message": "Tool removal failed."
}
```

## New Endpoint

## `POST /api/tools/custom/install`

Installs a custom tool into the persistent Relay volume paths and records it in the custom tool registry.

### Request

```json
{
  "id": "hello-tool",
  "name": "Hello Tool",
  "description": "Example custom tool",
  "installPath": "/workspace/.relay/tools/hello-tool",
  "binaryPath": "/workspace/.relay/tools/hello-tool/bin/hello-tool",
  "installCommand": "mkdir -p bin && printf '#!/bin/sh\\necho \"hello-tool 1.0.0\"\\n' > bin/hello-tool && chmod +x bin/hello-tool",
  "versionCommand": "/workspace/.relay/tools/hello-tool/bin/hello-tool --version",
  "binLinks": ["hello-tool"]
}
```

### Request Notes

- `id`, `name`, `installCommand`, and `binaryPath` are required
- `id` must match `^[a-z0-9._-]+$`
- `installPath` must stay inside `/workspace/.relay/tools`
- `binaryPath` must stay inside the chosen install path
- `binLinks` are optional symlink names created inside `/workspace/.relay/bin`
- `uninstallCommand` is optional and runs before Relay removes the install path

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "ok": true,
  "tool": {
    "id": "hello-tool",
    "kind": "custom",
    "name": "Hello Tool",
    "description": "Example custom tool",
    "installMethod": "custom",
    "installPath": "/workspace/.relay/tools/hello-tool",
    "installed": true,
    "source": "relay",
    "supported": true,
    "version": "hello-tool 1.0.0"
  }
}
```

### Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "invalid_custom_tool",
  "message": "Custom tool request is invalid."
}
```

### Failure

Status:

```http
500 Internal Server Error
```

Body:

```json
{
  "error": "custom_tool_install_failed",
  "message": "Custom tool installation failed."
}
```

## New Endpoint

## `POST /api/tools/custom/uninstall`

Uninstalls a custom tool and removes its registry entry.

### Request

```json
{
  "tool": "hello-tool"
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
  "ok": true,
  "tool": {
    "id": "hello-tool",
    "kind": "custom",
    "name": "Hello Tool",
    "description": "Example custom tool",
    "installMethod": "custom",
    "installPath": "/workspace/.relay/tools/hello-tool",
    "installed": false,
    "source": "unavailable",
    "supported": true,
    "version": null
  }
}
```

### Failure

Status:

```http
400 Bad Request
```

Body:

```json
{
  "error": "custom_tool_not_found",
  "message": "Custom tool not found."
}
```

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

## `POST /api/projects/:projectId/git/init`

Initializes a Git repository inside an existing project root.

### Request

```json
{}
```

### Success

Status:

```http
200 OK
```

Body:

```json
{
  "ok": true,
  "project": {
    "id": "my-app",
    "path": "/workspace/projects/my-app",
    "gitInitialized": true
  },
  "git": {
    "branch": "main",
    "ahead": 0,
    "behind": 0,
    "clean": true,
    "staged": [],
    "unstaged": [],
    "untracked": [],
    "conflicts": []
  }
}
```

### Failure

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
- **Now includes `cdEvent` for socket-based directory change**

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
    "cdCommand": "cd '/workspace/projects/my-app'",
    "cdEvent": {
      "projectId": "my-app"
    }
  }
}
```

### Frontend Implementation

```typescript
async function selectProject(projectId: string) {
  const response = await fetch('/api/session/project', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ projectId })
  });
  const { project, shell } = await response.json();

  // Emit cd event to change terminal directory
  socket.emit('cd', shell.cdEvent);

  // Update UI state
  setCurrentProject(project);
}
```

### Terminal State After Selection

The terminal will automatically `cd` into the project directory. The shell prompt should show:
```
user@workspace:~/projects/my-app$
```

## Current Limitations

- preview discovery is runtime-detected only, not persisted
- task chips are inferred, not user-managed
- notes are plain text only
- command result parsing supports a limited set of command families
- upload uses base64 JSON payloads, not multipart form uploads

---

# Flutter Integration

This section documents the Flutter build and preview system.

## Flutter SDK Status

## `GET /api/flutter/status`

Check if Flutter is installed in the runtime.

### Success

```json
{
  "installed": true,
  "version": "Flutter 3.24.0",
  "home": "/workspace/.relay/tools/flutter"
}
```

## `POST /api/flutter/install`

Installs the Flutter SDK into the persistent tool volume.

### Success

```json
{
  "ok": true,
  "flutter": {
    "id": "flutter",
    "installed": true,
    "version": "Flutter 3.24.0"
  }
}
```

### Flutter Install Failure

```json
{
  "error": "flutter_install_failed",
  "message": "Failed to install Flutter"
}
```

---

## Project Flutter Detection

## `GET /api/projects/:projectId/flutter`

Detects if a project is a Flutter project and returns build status.

### Success (Flutter Project)

```json
{
  "isFlutter": true,
  "buildDir": "/workspace/projects/my-flutter-app/build/web",
  "hasBuild": true
}
```

### Success (Not Flutter Project)

```json
{
  "isFlutter": false
}
```

---

## Flutter Build

## `POST /api/projects/:projectId/flutter/build`

Builds the Flutter project for web platform.

### Request

```json
{}
```

### Success

```json
{
  "ok": true,
  "buildDir": "/workspace/projects/my-flutter-app/build/web",
  "outputFiles": ["index.html", "main.dart.js", "flutter.js", ...],
  "message": "Compiling... Done."
}
```

### Not a Flutter Project

```json
{
  "error": "not_flutter_project",
  "message": "This project is not a Flutter project."
}
```

### Flutter Not Installed

```json
{
  "error": "flutter_not_installed",
  "message": "Flutter SDK is not installed."
}
```

### Build Failure

```json
{
  "error": "build_failed",
  "message": "Error: Target platform(s) not found."
}
```

---

## Flutter Serve (Preview Server)

## `POST /api/projects/:projectId/flutter/serve`

Starts a Python HTTP server to serve the built Flutter web app.

### Request

```json
{
  "port": 8081
}
```

`port` is optional, defaults to `8080`.

### Success

```json
{
  "ok": true,
  "url": "http://localhost:8081",
  "port": 8081,
  "message": "Flutter web preview running on port 8081"
}
```

### Notes

- This starts a background HTTP server on the specified port
- The server serves files from `build/web/`
- If no build exists, it automatically builds first
- The server runs in the background and persists until container restart

---

## Flutter Preview

## `GET /api/projects/:projectId/flutter/preview`

Check if a Flutter project is ready for preview.

### Success

```json
{
  "ready": true,
  "buildDir": "/workspace/projects/my-flutter-app/build/web",
  "indexUrl": "/api/projects/my-flutter-app/flutter/preview/index.html"
}
```

### No Build Found

```json
{
  "error": "no_build",
  "message": "No build found. Call /flutter/build first."
}
```

---

## Flutter Preview Files

## `GET /api/projects/:projectId/flutter/preview/*`

Serves static files from the Flutter build directory.

Example: `/api/projects/my-flutter-app/flutter/preview/index.html`

Returns the built Flutter web files with correct MIME types:
- `.html` → `text/html`
- `.js` → `application/javascript`
- `.css` → `text/css`
- `.png` / `.jpg` / `.svg` → image types
- etc.

---

# Flutter UI/UX Implementation Guide

## Detection Flow

1. When user opens/selects a project, call `GET /api/projects/:projectId/flutter`
2. If `isFlutter: true`, show Flutter-specific UI elements
3. Store Flutter state in component state

## UI Components to Add

### 1. Flutter Badge (Project Card)

On project cards/lists, show a Flutter badge if `isFlutter: true`:

```
┌─────────────────────┐
│ 🏠 My Flutter App    │  ← Badge: "Flutter" with Flutter logo
│ Flutter · Last edited│
└─────────────────────┘
```

### 2. Flutter Toolbar (Project View)

When viewing a Flutter project, add a toolbar above the editor:

```
┌──────────────────────────────────────────────────────────┐
│ [▶ Run] [📦 Build] [🌐 Preview ▼] [🔄 Refresh]          │
│                    Build Status: Ready                   │
└──────────────────────────────────────────────────────────┘
```

### 3. Build & Preview Panel

When user clicks "Preview", show a panel:

```
┌──────────────────────────────────────────────────────────┐
│ Flutter Web Preview                              [×]     │
├──────────────────────────────────────────────────────────┤
│ [Build] [Serve] [Stop Server]                            │
├──────────────────────────────────────────────────────────┤
│ Status: Ready to preview                                  │
│                                                          │
│ ┌──────────────────────────────────────────────────────┐│
│ │                                                      ││
│ │              <iframe src="..." />                   ││
│ │                                                      ││
│ └──────────────────────────────────────────────────────┘│
│                                                          │
│ Port: [8080 ▼]  URL: http://localhost:8080               │
└──────────────────────────────────────────────────────────┘
```

## User Flows

### Flow 1: First-time Flutter Project

1. User opens Flutter project
2. UI detects `isFlutter: true` but `hasBuild: false`
3. Show prompt: "Flutter project detected. Install Flutter SDK to build."
4. User clicks "Install Flutter"
5. Call `POST /api/flutter/install`
6. Show progress (Flutter download takes time)
7. Once installed, show "Build" button

### Flow 2: Build and Preview

1. User clicks "Build"
2. Call `POST /api/projects/:id/flutter/build`
3. Show loading state with output stream
4. On success, enable "Preview" button
5. User clicks "Preview"
6. Call `POST /api/projects/:id/flutter/serve`
7. Show iframe with the preview URL

### Flow 3: Existing Build Preview

1. User opens project with `hasBuild: true`
2. Show "Preview" as primary action
3. Click → serve → show iframe

---

## Socket Events Update

### New Event: `cd`

Send this event when user selects a project to change terminal directory.

```typescript
socket.emit('cd', { projectId: 'my-project' });
```

Or with explicit path:

```typescript
socket.emit('cd', { path: '/workspace/projects/my-project' });
```

### Response on Socket

The terminal will output the cd command result. The backend emits:
- Success: terminal shows the cd result
- Failure: terminal shows error message like `[relay] cd: /path: No such directory`

### Best Practice

After calling `POST /api/session/project`, emit the `cd` event:

```typescript
const response = await fetch('/api/session/project', { ... });
const { shell } = await response.json();

// Emit cd event to change terminal directory
socket.emit('cd', { projectId: projectId });

// Or use the path directly
socket.emit('cd', { path: shell.cwd });
```

---

## Preview Endpoints Update

## `GET /api/previews`

Returns all listening ports.

### Success

```json
{
  "previews": [
    { "port": 3000, "label": "Port 3000", "url": "/preview/3000", "status": "active" },
    { "port": 8080, "label": "Port 8080", "url": "/preview/8080", "status": "active" }
  ]
}
```

## `GET /api/previews/:port`

Check status of a specific port.

### Success

```json
{
  "port": 3000,
  "active": true,
  "url": "/preview/3000",
  "label": "Port 3000"
}
```

## `POST /api/previews/:port/serve`

Start a preview server on a specific port.

### Request

```json
{}
```

### Success

```json
{
  "ok": true,
  "port": 3000,
  "message": "Preview server starting on port 3000"
}
```

### Port Already in Use

```json
{
  "ok": true,
  "port": 3000,
  "message": "Port already in use."
}
```

---

## State Management

```typescript
interface FlutterState {
  isInstalled: boolean;
  isProject: boolean;
  hasBuild: boolean;
  isBuilding: boolean;
  isServing: boolean;
  previewPort: number;
  previewUrl: string | null;
  buildOutput: string;
  error: string | null;
}
```

## Error Handling

| Scenario | UI Response |
|----------|-------------|
| Flutter not installed | Show "Install Flutter" button |
| Build in progress | Disable buttons, show spinner |
| Build failed | Show error message, allow retry |
| Serve failed | Show error with port conflict suggestion |
| No build found | Prompt to build first |

## Responsive Design

The preview panel should:
- Fill available width
- Maintain 16:9 aspect ratio for the iframe
- Allow full-screen mode
- Show status bar at bottom

## Accessibility

- All buttons have keyboard shortcuts
- Build output is readable for screen readers
- Preview has alt text describing the rendered app
- Progress states use aria-labels
