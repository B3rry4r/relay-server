# Relay Frontend Build Handoff

This document is for the frontend agent building the separate Relay frontend project.

This is not a product roadmap. It is the implementation brief.

## Product

Build a premium mobile-first frontend for the live Relay backend.

The frontend must support two views on the same shell session:

- `Chat view`
- `Terminal view`

The frontend connects to the backend over HTTP and Socket.IO.

## Core UX Rules

- Mobile-first
- Clean, premium, intentional UI
- No cluttered persistent button bars
- Use an action sheet / command palette pattern for most actions
- The action sheet still contains buttons; it is just the correct UI pattern for many actions
- Keep the main workspace visually clean
- The user must always know:
  - current project
  - current mode
  - connection status
  - current preview state

## What Must Be Built

## 1. Auth Entry

Frontend-only token entry screen.

Behavior:

- User enters backend URL
- User enters backend token
- Frontend calls `GET /api/auth/validate`
- On success, frontend stores:
  - backend base URL
  - auth token
- On failure, frontend shows clear error

This is not account auth. It is only backend token entry.

## 2. Workspace Shell UI

Build the main workspace screen with:

- Header
  - active project name
  - mode toggle
  - connection status
  - action palette trigger
- Main content
  - chat transcript OR terminal panel
- Bottom area
  - command composer in chat view

## 3. Chat View

Chat view is the default shell UI for normal commands.

Requirements:

- user command appears as an outgoing message block
- shell output appears as a response block
- preserve monospace formatting
- support multiline output
- support streaming updates into the current response block
- keep transcript readable on mobile

Do not build fake chat semantics. This is still a shell client.

## 4. Terminal View

Terminal view is used when the user needs raw terminal fidelity.

Requirements:

- full terminal renderer
- attaches to the same live backend session
- switching views must not create a new shell
- user can manually switch at any time

## 5. Project Switcher

Build a project switcher for folders under `/workspace/projects`.

Requirements:

- list projects
- switch active project
- show current active project in header
- after switching, frontend should send the user into that project context

Use backend APIs for project selection and file actions. Do not fake these by sending shell strings from the frontend.

## 6. Project Tree

Build a project tree panel for the active project.

Requirements:

- folders expandable/collapsible
- files visible
- mobile friendly
- tap item to show file actions
- must support refresh

## 7. File/Folder Creation

Build UI flows for:

- create project
- create file
- create folder
- rename item
- delete item

These must use backend APIs.

## 8. Action Palette

Implement an action palette, not a toolbar wall.

This is a sheet/modal/palette containing action buttons.

Required actions:

- Switch Project
- Create Project
- Refresh Project Tree
- New File
- New Folder
- Rename Item
- Delete Item
- Open Chat View
- Open Terminal View
- Git Status
- Install Dependencies
- Run Tests
- Open Preview
- View Workspace Health
- Reconnect Session
- Logout

This is the correct UI treatment for the buttons you asked for.

## 9. Preview Entry

Build preview opening UI.

Requirements:

- enter a port manually
- open a preview panel or external view using backend preview URL
- show active preview port

## 10. Workspace Health Surface

Build a lightweight workspace health panel.

Show:

- bootstrap status
- workspace path
- toolchain readiness if returned by backend

Do not turn this into an admin panel.

## Backend Base URL

Current deployed backend:

`https://relay-server-production-5d2f.up.railway.app`

## Existing Backend Endpoints

## `GET /`

Purpose:

- service metadata

Response:

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

## `GET /health`

Response:

```json
{
  "ok": true
}
```

## `GET /api/auth/validate`

Auth options:

- `x-auth-token: <token>`
- `Authorization: Bearer <token>`

Success:

```json
{
  "authenticated": true
}
```

Failure:

```json
{
  "error": "unauthorized",
  "message": "A valid auth token is required."
}
```

## Existing Socket Contract

Connect with:

```ts
io(baseUrl, {
  auth: {
    token: authToken
  }
})
```

### Client -> server

- `input`: `string`
- `resize`: `{ cols: number, rows: number }`

### Server -> client

- `output`: `string`

Backend emits raw terminal bytes only.

## Implemented Backend APIs For Frontend

These APIs now exist on the backend and are the current contract.

## `GET /api/bootstrap/status`

Auth:

- `x-auth-token: <token>` or `Authorization: Bearer <token>`

Response:

```json
{
  "workspace": "/workspace",
  "bootstrapped": true,
  "status": {
    "projects_dir": "ready",
    "npm_global": "ready",
    "python_userbase": "ready",
    "shell_config": "ready",
    "nvm": "installed",
    "homebrew": "installed",
    "bootstrap": "complete"
  }
}
```

## `GET /api/projects`

Auth:

- required

Response:

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "my-app",
      "path": "/workspace/projects/my-app",
      "lastModifiedAt": "2026-04-20T22:00:00.000Z",
      "gitInitialized": true
    }
  ]
}
```

## `POST /api/projects`

Auth:

- required

Request:

```json
{
  "name": "my-app",
  "template": "blank",
  "initializeGit": true
}
```

Success:

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

Failure:

```json
{
  "error": "project_exists",
  "message": "A project with this name already exists."
}
```

Validation failure:

```json
{
  "error": "invalid_project_name",
  "message": "Project names may only contain letters, numbers, hyphens, underscores, and periods."
}
```

Git initialization failure:

```json
{
  "error": "git_init_failed",
  "message": "Git initialization failed."
}
```

## `POST /api/projects/:projectId/git/init`

Auth:

- required

Request:

```json
{}
```

Success:

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

Failure:

```json
{
  "error": "git_init_failed",
  "message": "Git initialization failed."
}
```

## `GET /api/projects/:projectId/tree`

Auth:

- required

Failure:

```json
{
  "error": "project_not_found",
  "message": "Project not found."
}
```

## `GET /api/projects/quick-switch`

Response:

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

## `POST /api/projects/:projectId/pin`

Request:

```json
{
  "pinned": true
}
```

Response:

```json
{
  "projectId": "my-app",
  "pinned": true
}
```

Response:

```json
{
  "project": {
    "id": "my-app",
    "path": "/workspace/projects/my-app"
  },
  "tree": [
    {
      "name": "src",
      "path": "src",
      "type": "directory"
    },
    {
      "name": "package.json",
      "path": "package.json",
      "type": "file",
      "size": 812
    }
  ]
}
```

## `POST /api/projects/:projectId/files`

Auth:

- required

Request:

```json
{
  "parentPath": "src",
  "name": "index.ts",
  "contents": ""
}
```

Response:

```json
{
  "created": {
    "type": "file",
    "path": "src/index.ts"
  }
}
```

Errors:

```json
{
  "error": "invalid_name",
  "message": "File name is required."
}
```

```json
{
  "error": "invalid_path",
  "message": "Parent path is invalid."
}
```

## `POST /api/projects/:projectId/folders`

Auth:

- required

Request:

```json
{
  "parentPath": "src",
  "name": "components"
}
```

Response:

```json
{
  "created": {
    "type": "directory",
    "path": "src/components"
  }
}
```

Errors:

```json
{
  "error": "folder_exists",
  "message": "Folder already exists."
}
```

## `PATCH /api/projects/:projectId/rename`

Auth:

- required

Request:

```json
{
  "path": "src/old-name.ts",
  "newName": "new-name.ts"
}
```

Response:

```json
{
  "updated": {
    "oldPath": "src/old-name.ts",
    "newPath": "src/new-name.ts"
  }
}
```

Failure:

```json
{
  "error": "invalid_request",
  "message": "Path and newName are required."
}
```

## `DELETE /api/projects/:projectId/items`

Auth:

- required

Request:

```json
{
  "path": "src/old-name.ts",
  "recursive": false
}
```

## `POST /api/projects/:projectId/duplicate`

Request:

```json
{
  "path": "src/index.ts",
  "newName": "index-copy.ts"
}
```

Response:

```json
{
  "duplicated": {
    "sourcePath": "src/index.ts",
    "duplicatedPath": "src/index-copy.ts"
  }
}
```

## `GET /api/projects/:projectId/download`

Query:

- `path=<relative path>`

Response:

- file download body

## `POST /api/projects/:projectId/upload`

Request:

```json
{
  "parentPath": "src",
  "name": "upload.txt",
  "contentBase64": "aGVsbG8="
}
```

Response:

```json
{
  "uploaded": {
    "path": "src/upload.txt"
  }
}
```

## `GET /api/projects/:projectId/notes`

Response:

```json
{
  "content": "project notes"
}
```

## `PUT /api/projects/:projectId/notes`

Request:

```json
{
  "content": "project notes"
}
```

Response:

```json
{
  "content": "project notes"
}
```

## `GET /api/projects/:projectId/tasks`

Response:

```json
{
  "tasks": [
    {
      "id": "dev",
      "label": "dev",
      "command": "npm run dev"
    }
  ]
}
```

## `GET /api/projects/:projectId/suggestions`

Response:

```json
{
  "suggestions": [
    {
      "id": "npm-install",
      "label": "Install dependencies",
      "command": "npm install"
    }
  ]
}
```

Response:

```json
{
  "deleted": {
    "path": "src/old-name.ts"
  }
}
```

## `POST /api/session/project`

Auth:

- required

Request:

```json
{
  "projectId": "my-app"
}
```

Response:

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

## `GET /api/previews`

Auth:

- required

Response:

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

Current implementation note:

- backend returns detected listening ports from the server environment

## `GET /api/workspace/health`

Response:

```json
{
  "workspace": "/workspace",
  "bootstrapped": true,
  "status": {
    "bootstrap": "complete"
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

## `POST /api/command-results/parse`

Request:

```json
{
  "command": "git status",
  "output": "On branch main\nnothing to commit, working tree clean\n"
}
```

Response:

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

## Frontend Implementation Notes

- Treat the action palette as the main action launcher
- Keep the screen clean
- Use dedicated backend APIs for workspace operations
- Use the live socket only for shell IO
- Do not build admin or analytics screens
- Do not document roadmaps inside the frontend repo handoff

## What The Frontend Agent Should Deliver

- token entry screen
- workspace shell screen
- chat view
- terminal view
- action palette
- project switcher
- project tree
- create project flow
- create file flow
- create folder flow
- rename/delete item flows
- preview entry
- workspace health panel
- backend integration against the contracts above
