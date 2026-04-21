# Relay Future Tools Backlog

This file is separate from the frontend build handoff on purpose.

These items are deferred ideas and are not the current frontend implementation contract.

## 1. Project Launcher

Guided project creation flow:

- blank project
- Node API
- Next app
- Python API
- static site
- CLI tool

Status:

- implemented on backend for `blank`, `node-api`, `next-app`, `python-api`, `static-site`, and `cli-tool`
- frontend launcher UI not implemented in this repo

## 2. Command Palette

Mobile-first action sheet / palette containing buttons for workspace actions.

Status:

- specified in the frontend handoff
- backend support for many palette actions is now implemented
- frontend UI not implemented in this repo

## 3. Port Detection and Smart Previews

- detect active listening ports
- surface preview suggestions
- remember recent ports
- support named previews

Status:

- partially implemented on backend
- backend `GET /api/previews` now returns detected listening ports
- named previews and user-managed preview memory are not implemented

## 4. Task Chips

Per-project quick actions:

- dev
- test
- lint
- build
- migrate
- seed

Status:

- partially implemented on backend
- backend `GET /api/projects/:projectId/tasks` infers common tasks from project files and package scripts
- frontend chips UI and custom saved tasks are not implemented

## 5. Project Notes / Scratchpad

Per-project notes:

- TODOs
- setup reminders
- useful commands
- env notes

Status:

- implemented on backend
- `GET /api/projects/:projectId/notes`
- `PUT /api/projects/:projectId/notes`
- frontend notes UI not implemented

## 6. Inline Command Suggestions

Suggestions based on project files and context.

Status:

- implemented on backend
- `GET /api/projects/:projectId/suggestions`
- frontend suggestion UI not implemented

## 7. Workspace Health Panel

Show:

- bootstrap status
- available toolchains
- node version
- git available
- disk usage
- active ports

Status:

- implemented on backend
- `GET /api/bootstrap/status` exists
- `GET /api/workspace/health` exists
- full frontend panel not implemented

## 8. Safe File Actions

- copy path
- rename
- duplicate
- delete with confirm
- download file
- upload file

Status:

- implemented on backend
- rename
- delete
- duplicate
- download
- upload
- frontend UI not implemented

## 9. Command Result Cards

Structured output cards for:

- git status
- npm install summaries
- test result summaries
- collapsible errors

Status:

- partially implemented on backend
- backend `POST /api/command-results/parse` supports basic parsing for:
  - git status
  - npm install
  - test output
- frontend result cards UI not implemented

## 10. Multi-project Quick Switch

- pinned projects
- recent projects
- running preview context
- last command status

Status:

- partially implemented on backend
- backend `GET /api/projects/quick-switch` exists
- backend `POST /api/projects/:projectId/pin` exists
- recent project tracking exists via `POST /api/session/project`
- frontend quick-switch UI not implemented
