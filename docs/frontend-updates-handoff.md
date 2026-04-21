# Relay Frontend Updates Handoff

This document lists the backend additions made after the original frontend handoff.

Frontend agent should use this together with:

- [frontend-handoff.md](/home/user/relay/docs/frontend-handoff.md:1)

## New Implemented Backend Support

The backend now supports the following additional frontend-facing features:

- project templates at creation time
- quick switch project data
- pinning projects
- project notes
- inferred task chips
- inferred inline command suggestions
- duplicate file/folder action
- file download
- file upload via base64 payload
- preview discovery from detected listening ports
- expanded workspace health endpoint
- structured command result parsing

## Added Endpoints

- `GET /api/projects/quick-switch`
- `POST /api/projects/:projectId/pin`
- `POST /api/projects/:projectId/duplicate`
- `GET /api/projects/:projectId/download`
- `POST /api/projects/:projectId/upload`
- `GET /api/projects/:projectId/notes`
- `PUT /api/projects/:projectId/notes`
- `GET /api/projects/:projectId/tasks`
- `GET /api/projects/:projectId/suggestions`
- `GET /api/workspace/health`
- `POST /api/command-results/parse`

## Updated Endpoint Behavior

### `POST /api/projects`

`template` now supports:

- `blank`
- `node-api`
- `next-app`
- `python-api`
- `static-site`
- `cli-tool`

### `GET /api/previews`

No longer returns an empty placeholder by default.

Current behavior:

- returns detected listening ports from the runtime environment

## Frontend Usage Notes

- Use `GET /api/projects/:projectId/tasks` to populate task chips
- Use `GET /api/projects/:projectId/suggestions` to populate context suggestions
- Use `GET /api/projects/:projectId/notes` and `PUT /api/projects/:projectId/notes` for project scratchpad
- Use `GET /api/projects/quick-switch` for recent/pinned project switch surfaces
- Use `POST /api/projects/:projectId/pin` to pin/unpin projects
- Use `POST /api/command-results/parse` if chat view wants structured cards for known command outputs
- Use `GET /api/workspace/health` for the richer workspace health surface

## Current Limitations

- preview endpoint detects active ports but does not yet persist named previews
- task chips are inferred, not user-managed
- notes are plain content storage, not rich documents
- command result parsing is basic and covers only a few command families
