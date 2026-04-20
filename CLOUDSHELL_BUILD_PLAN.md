# CloudShell — AI Orchestration Terminal
## Codex Build Plan & Project Spec

> **How to use this document:**  
> Feed this to Codex phase by phase. Complete and verify each phase before moving to the next.  
> Each phase has a **Goal**, **Tasks**, **Acceptance Criteria**, and **Codex Prompt** you can use verbatim.  
> Do NOT let Codex skip ahead — each phase builds on the last.

---

## Project Overview

**What we're building:**  
A self-hosted, browser-accessible cloud shell. A Node.js server hosted on Railway that:
- Spawns a real bash shell and relays it to a mobile browser via WebSockets
- Persists everything (installs, repos, config) on a Railway Volume
- Lets you run AI CLI tools (Codex, Aider, etc.) from anywhere
- Proxies running app ports so you can preview what you build
- Has a clean, mobile-first terminal UI

**Tech Stack:**
- **Backend:** Node.js (Express + Socket.io + node-pty)
- **Frontend:** Vanilla HTML/CSS/JS with xterm.js (no framework — keeps it fast and lean)
- **Host:** Railway
- **Storage:** Railway Persistent Volume mounted at `/workspace`
- **Auth:** Token-based (env var), expandable later

---

## Project File Structure (Target)

```
cloudshell/
├── server.js              # Main server — shell relay, proxy, socket handling
├── setup-workspace.sh     # First-boot script — sets up volume environment
├── public/
│   ├── index.html         # Terminal UI
│   ├── terminal.js        # xterm.js logic, socket wiring, resize, keyboard
│   └── style.css          # Mobile-first terminal styles
├── package.json
├── railway.toml           # Railway build config
├── .env.example           # Env var template
└── README.md
```

---

## Environment Variables (set in Railway dashboard)

```
AUTH_TOKEN=<generate a strong random string — this is your password>
PORT=3000                  # Railway sets this automatically
WORKSPACE=/workspace       # Mount path of your Railway volume
```

---

---

# PHASE 1 — Bare Terminal Relay

**Goal:** A working terminal in the browser. Type a command, get output. Nothing more.

**What Codex should build:**
- `package.json` with dependencies: `express`, `socket.io`, `node-pty`, `cors`
- `server.js` that:
  - Serves static files from `/public`
  - On socket connection, spawns a bash shell using `node-pty`
  - Relays shell stdout → socket (`output` event)
  - Relays socket input → shell stdin (`input` event)
  - Handles terminal resize (`resize` event) — **do not skip this**
  - Sets `cwd` to `process.env.WORKSPACE || '/workspace'`
- `public/index.html` with xterm.js loaded from CDN
- `public/terminal.js` that:
  - Initialises xterm.js Terminal instance
  - Connects socket.io
  - Wires terminal keystrokes to `socket.emit('input', data)`
  - Wires `socket.on('output')` to `terminal.write(data)`
  - Emits `resize` event with `{ cols, rows }` whenever terminal dimensions change (use `ResizeObserver` on the terminal container)
- `public/style.css` — terminal fills full viewport, black background, no margins

**Acceptance Criteria:**
- [ ] `node server.js` starts without errors
- [ ] Open browser → terminal appears
- [ ] Type `ls`, `pwd`, `echo hello` — output renders correctly
- [ ] Resize browser window → terminal columns re-wrap properly (test with `htop`)
- [ ] `cwd` starts in `/workspace` (or fallback)

**Codex Prompt for Phase 1:**
```
Build Phase 1 of a cloud shell project called CloudShell.

Create a Node.js server (server.js) using express, socket.io, and node-pty that:
1. Serves static files from a /public directory
2. On every socket.io connection, spawns a bash shell with node-pty
3. Pipes node-pty output to the socket as an 'output' event
4. Listens for 'input' events from the socket and writes them to the pty
5. Listens for 'resize' events { cols, rows } and calls shell.resize(cols, rows)
6. Spawns the shell with cwd set to process.env.WORKSPACE or '/workspace'
7. Sets env HOME to WORKSPACE path so .bashrc loads from the volume

Create public/index.html that loads xterm.js and xterm's FitAddon from CDN (unpkg).
Create public/terminal.js that:
1. Initialises a Terminal instance with xterm.js
2. Loads and applies FitAddon so terminal fits its container
3. Connects to socket.io
4. On terminal.onData, emits 'input' to socket
5. On socket 'output', calls terminal.write(data)
6. Uses ResizeObserver on the terminal container div to call fitAddon.fit() and emit 'resize' with { cols, rows } on dimension changes

Create public/style.css: terminal container fills 100vw x 100vh, body margin 0, background #000.

Create package.json with all dependencies.

Do not add authentication yet. Do not add anything beyond what is described.
```

---

---

# PHASE 2 — Authentication

**Goal:** Lock the terminal behind a token. Nobody else can access your shell.

**What Codex should build:**
- Middleware in `server.js` that checks for `AUTH_TOKEN` before serving the terminal page
- Token passed as a URL query param on first load: `/?token=YOUR_TOKEN`
- Token stored in `sessionStorage` on the frontend so you don't re-enter it on refresh
- If token is wrong or missing → serve a simple login page (just a password input, no frameworks)
- Socket.io handshake also validates token (pass token in socket `auth` object)

**Acceptance Criteria:**
- [ ] Visiting `/` without a token → login page shown
- [ ] Wrong token → login page shown with error
- [ ] Correct token → terminal loads
- [ ] Socket connection without valid token → server disconnects it immediately
- [ ] `AUTH_TOKEN` is only read from `process.env` — never hardcoded

**Codex Prompt for Phase 2:**
```
Add authentication to the existing CloudShell server.js and frontend.

Server changes:
1. Add express middleware that checks req.query.token or req.headers['x-auth-token'] against process.env.AUTH_TOKEN
2. If token is invalid, serve a login HTML page (inline in the response) with a single password input and submit button. On submit, redirect to /?token=<value>
3. Protect the socket.io connection — in the 'connection' handler, check socket.handshake.auth.token against AUTH_TOKEN. If wrong, call socket.disconnect() immediately.

Frontend changes:
1. On page load, read token from URL query param and store in sessionStorage
2. When initialising socket.io connection, pass { auth: { token } } in the options
3. If no token in sessionStorage, redirect to login page

Do not change any terminal relay logic from Phase 1.
```

---

---

# PHASE 3 — Workspace Bootstrap Script

**Goal:** On first boot (empty volume), automatically set up the persistent environment so CLI tools survive restarts.

**What Codex should build:**
- `setup-workspace.sh` shell script that runs if `/workspace/.bootstrapped` does not exist, then creates that file as a flag
- Script should:
  - Create `/workspace/.bashrc` with PATH exports for npm global, python user, homebrew, nvm
  - Install nvm to `/workspace/.nvm`
  - Install Homebrew (linuxbrew) to `/workspace/homebrew` — non-interactive
  - Write a `.bash_profile` that sources `.bashrc`
  - Create `/workspace/projects` directory
  - Touch `/workspace/.bootstrapped`
- `server.js` should call this script with `child_process.execFile` before starting the HTTP server (async, log output to console)
- Add `railway.toml` with:
  - `startCommand = "node server.js"`
  - `restartPolicyType = "on-failure"`
  - apt packages: `git`, `curl`, `build-essential`, `python3`, `python3-pip`

**Acceptance Criteria:**
- [ ] On first deploy with empty volume, script runs and sets up environment
- [ ] On subsequent restarts, script detects `.bootstrapped` and skips
- [ ] In the terminal: `which nvm`, `echo $PATH` show correct volume paths
- [ ] `npm install -g some-package` installs to `/workspace/.npm-global/` and persists

**Codex Prompt for Phase 3:**
```
Add a workspace bootstrap system to CloudShell.

Create setup-workspace.sh that:
1. Checks if /workspace/.bootstrapped exists. If yes, exit 0 immediately.
2. Creates /workspace/.bashrc with these PATH exports:
   - export NVM_DIR="/workspace/.nvm"
   - export npm_config_prefix="/workspace/.npm-global"
   - export PYTHONUSERBASE="/workspace/.local"
   - export PATH="/workspace/.npm-global/bin:/workspace/.local/bin:/workspace/homebrew/bin:/workspace/.nvm/versions/node/$(node -v 2>/dev/null || echo 'current')/bin:$PATH"
   - [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
3. Installs nvm to /workspace/.nvm using the official curl install script
4. Installs Homebrew to /workspace/homebrew using NONINTERACTIVE=1 CI=1 with the official install script
5. Creates /workspace/projects directory
6. Creates /workspace/.bash_profile that sources /workspace/.bashrc
7. Touches /workspace/.bootstrapped

In server.js, before app.listen():
1. Import child_process
2. Run setup-workspace.sh with execFile, pipe stdout/stderr to console
3. Only start listening after the script completes (await or callback)

Create railway.toml:
[build]
aptPackages = ["git", "curl", "build-essential", "python3", "python3-pip", "python3-venv"]

[deploy]
startCommand = "node server.js"
restartPolicyType = "on-failure"

Create .env.example:
AUTH_TOKEN=change_this_to_a_strong_random_string
PORT=3000
WORKSPACE=/workspace
```

---

---

# PHASE 4 — Port Preview Proxy

**Goal:** When you run an app on a port inside the terminal (e.g. `npm run dev` on port 3000), you can preview it in the browser at `/preview/3000`.

**What Codex should build:**
- Add `http-proxy` package
- In `server.js`, add an Express route `/preview/:port/*` that:
  - Proxies the request to `http://localhost:<port>`
  - Strips the `/preview/:port` prefix from the URL before forwarding
  - Also handles WebSocket upgrade for proxy routes (for HMR/hot reload)
- In `public/index.html`, add a Preview panel:
  - A text input to enter a port number
  - An "Open Preview" button
  - An `<iframe>` that loads `/preview/<port>` when button is clicked
  - A toggle button to show/hide the preview panel
- The layout: terminal takes full height by default; when preview is open, split view (terminal left/top, preview right/bottom depending on screen orientation)

**Acceptance Criteria:**
- [ ] Run `python3 -m http.server 8080` in terminal → enter 8080 in preview → iframe shows directory listing
- [ ] Preview panel can be dismissed and re-opened
- [ ] WebSocket proxy works (test with a Vite dev server if possible)

**Codex Prompt for Phase 4:**
```
Add a port preview proxy to CloudShell.

Server changes (server.js):
1. Install and import http-proxy. Create a proxy server instance.
2. Add express route: app.use('/preview/:port', (req, res) => { ... })
   - Extract port from req.params.port
   - Rewrite req.url to strip /preview/:port prefix (use req.url.replace('/preview/' + port, '') || '/')
   - Call proxy.web(req, res, { target: 'http://localhost:' + port }) with error handling
3. On the http server's 'upgrade' event, check if req.url starts with /preview/:port, extract port, and call proxy.ws(req, socket, head, { target: 'ws://localhost:' + port })

Frontend changes:
1. Add a preview panel to index.html: a collapsible side/bottom panel containing a port input field, "Open Preview" button, and an <iframe id="preview-frame">
2. Clicking "Open Preview" sets iframe src to /preview/<port>?token=<token>
3. Add a toggle button fixed to the UI to show/hide the preview panel
4. On mobile portrait: preview panel slides up from bottom (50% height). On desktop/landscape: panel appears on the right (50% width). Use CSS and a 'preview-open' class on body to control layout.
5. The iframe src must include the auth token as a query param.

Keep terminal relay and auth logic unchanged.
```

---

---

# PHASE 5 — Mobile Keyboard Overlay

**Goal:** A custom on-screen keyboard row for keys that don't exist on mobile keyboards but are critical in a terminal: `Ctrl`, `Alt`, `Esc`, `Tab`, `↑`, `↓`, `←`, `→`, `|`, `` ` ``.

**What Codex should build:**
- A fixed bottom bar in the UI (above the system keyboard when it's open)
- Buttons for: `Esc`, `Tab`, `Ctrl`, `Alt`, `↑`, `↓`, `←`, `→`, `|`, `` ` ``, `~`, `:`  
- `Ctrl` is a **modifier** — tap it, it activates (highlights), then tap a letter key (from the real keyboard) to send `Ctrl+<key>`. Deactivates after one combo.
- Arrow keys should be holdable (repeat on long press)
- Styling: minimal, dark, same aesthetic as terminal — not chunky or toy-like

**Acceptance Criteria:**
- [ ] `Esc` closes vim insert mode
- [ ] `Tab` autocompletes in bash
- [ ] `Ctrl` + typing `c` in terminal cancels a running process
- [ ] Arrow keys navigate command history
- [ ] Bar doesn't cover the terminal input line when mobile keyboard is open

**Codex Prompt for Phase 5:**
```
Add a mobile keyboard overlay to CloudShell.

In public/terminal.js and public/index.html:

1. Create a fixed-position keyboard toolbar div with id="mobile-keys". It sits above the virtual keyboard on mobile using position:fixed; bottom:0.
2. Add these buttons: Esc, Tab, Ctrl, Alt, |, `, ~, :, ↑, ↓, ←, →
3. Implement Ctrl as a sticky modifier: clicking it toggles a 'ctrl-active' class. The next character typed or button pressed on the real keyboard will have its charCode modified to produce the correct Ctrl+key sequence (e.g. Ctrl+C = \x03, Ctrl+D = \x04, Ctrl+L = \x0c, Ctrl+Z = \x1a). After one combo, Ctrl deactivates.
4. Map arrow keys: ↑=\x1b[A, ↓=\x1b[B, →=\x1b[C, ←=\x1b[D
5. Implement long-press repeat for arrow keys: send the sequence every 80ms while held, starting after 400ms initial delay. Use touchstart/touchend events.
6. Map Esc=\x1b, Tab=\t
7. All button presses emit 'input' to socket.io (same as keyboard input)
8. Style: background #111, buttons are 36px tall, monospace font, subtle border, no border-radius, fits full width. Active Ctrl button highlights in amber/orange.
9. On desktop (hover media query available), hide the toolbar.
```

---

---

# PHASE 6 — QR Code for Expo / Mobile App Preview

**Goal:** When you're building a React Native / Expo app in the terminal, generate a QR code in the UI to scan with Expo Go on your phone.

**What Codex should build:**
- A "QR" button in the UI toolbar
- Clicking it opens a small modal with an input for a URL or local IP:port
- Generates and displays a QR code using `qrcode` (npm) served via an endpoint, or `qrcode.js` from CDN on the frontend
- Also: a `/ip` endpoint on the server that returns the container's detected outbound IP (useful for Expo tunnel URLs)

**Codex Prompt for Phase 6:**
```
Add QR code generation to CloudShell for Expo Go previews.

Frontend (no new backend dependency needed):
1. Add a "QR" button to the UI toolbar.
2. Clicking it opens a modal overlay with a text input (placeholder: "exp://your-tunnel-url or IP:port") and a "Generate QR" button.
3. Load qrcode.js from CDN (davidshimjs/qrcodejs on cdnjs).
4. On generate, render the QR code into a canvas/div inside the modal.
5. Add a close button to dismiss the modal.

Server:
1. Add GET /ip route that returns JSON { ip: <server public IP> }. Use a fetch to https://api.ipify.org?format=json to get the public IP, return it.

Style the modal consistently with the terminal aesthetic (dark background, monospace, minimal).
```

---

---

# PHASE 7 — Polish & Railway Deploy Readiness

**Goal:** Production-ready. Handles edge cases, doesn't leak, deploys cleanly.

**What Codex should do:**

1. **Shell cleanup** — on socket disconnect, kill the pty process so it doesn't hang
2. **Single shell per connection** — ensure each socket gets its own pty instance (not shared)
3. **Error boundaries** — if pty spawn fails (e.g. bash not found), emit an error message to the terminal instead of crashing the server
4. **Graceful shutdown** — on `SIGTERM`, close all pty processes before exiting
5. **README.md** — clear deploy instructions:
   - How to create a Railway volume and mount it to `/workspace`
   - Required env vars
   - How to set `AUTH_TOKEN`
6. **Security headers** — add `helmet` middleware
7. **Logging** — log connections/disconnections with timestamp and socket ID (no personal data)

**Codex Prompt for Phase 7:**
```
Harden and finalise CloudShell for production deployment on Railway.

1. Shell cleanup: in socket 'disconnect' handler, check if the shell process is still alive and call shell.kill() if so.
2. Track all active pty processes in a Map (socketId → shell). On server SIGTERM, iterate and kill all.
3. Wrap pty.spawn in a try/catch. If it throws, emit an 'output' event to the socket with an error message and disconnect.
4. Install and apply helmet() middleware for security headers.
5. Add connection logging: log '[CONNECT] <socketId> <timestamp>' and '[DISCONNECT] <socketId> <timestamp>' to console.
6. Create README.md with:
   - Project description
   - Railway setup steps: create project, add volume, mount to /workspace, set env vars AUTH_TOKEN and WORKSPACE
   - Local dev instructions (npm install, cp .env.example .env, node server.js)
   - Security warning: never share AUTH_TOKEN

Do not change any feature logic.
```

---

---

## Cheat Sheet: Codex Workflow Tips

**Starting each phase:**
```
"We are building CloudShell. Here is the project plan: [paste this doc].
We have completed Phases 1–N. Now build Phase N+1 exactly as described.
Do not modify any code outside the scope of this phase."
```

**When Codex drifts or over-engineers:**
```
"Stop. You are adding things not in the spec. Revert to only what Phase N describes.
Keep existing phase code untouched."
```

**When verifying before moving on:**
```
"Before we move to Phase N+1, review Phase N's acceptance criteria and confirm
each item is satisfied in the current code. List any gaps."
```

**After all phases — asking for a full code review:**
```
"All 7 phases of CloudShell are complete. Do a full code review of server.js,
terminal.js, and style.css. Look for: memory leaks, unhandled promise rejections,
missing error handling, mobile UX issues, and security gaps. List findings with
file and line references."
```

---

## Railway Deployment Checklist

- [ ] Push code to GitHub repo
- [ ] Create Railway project, connect GitHub repo
- [ ] Add Railway Volume, mount path: `/workspace`
- [ ] Set env vars: `AUTH_TOKEN`, `WORKSPACE=/workspace`
- [ ] Verify `railway.toml` is in repo root
- [ ] Deploy — check build logs for apt package installs
- [ ] First boot — watch logs for bootstrap script output
- [ ] Visit app URL with `?token=<AUTH_TOKEN>` — terminal should load
- [ ] Type `echo $PATH` — confirm `/workspace` paths are present
- [ ] Type `npm install -g cowsay` — confirm it persists after redeploy
