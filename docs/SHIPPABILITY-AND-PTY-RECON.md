# Recon: making Relay shippable + surviving redeploys (relay-pty)

Status: **recon + options**. No code changed by this document.
Date: 2026-07-24.

---

## Part 1 — relay-pty: why the split failed, and what actually fixes it

### What exists today

- `relay-pty/` is a complete standalone service (Dockerfile, `railway.toml`,
  socket protocol, `transcript.ts` with cwd tracking). One commit, builds clean.
- **The relay-server client for it was never deleted.** `src/relay-server/remote-pty.ts`
  is still wired and env-toggled: `RELAY_PTY_MODE=remote` + `RELAY_PTY_URL`
  (default `embedded`). Nothing has to be rebuilt to turn it back on.

So the code is fine. The *deployment shape* is what was wrong.

### The actual blocker (verified, not assumed)

`relay-pty/src/pty-factory.ts` spawns every shell with `cwd: options.cwd` — a path
on the **project filesystem** (`$WORKSPACE/projects/...`). But `relay-pty/railway.toml`
declares **no volume**, and on Railway a volume attaches to **exactly one service**.
The projects volume is on relay-server.

> A standalone relay-pty on Railway boots with an empty `/workspace`. Terminals
> would open into a directory with no repos, no `node_modules`, no git.

**A terminal is only useful where the files are.** Moving the PTY *away* from the
filesystem can never work. That is the mistake: the split was built before the
volume constraint was resolved, so it shipped a service that structurally could
not do its job.

### Why redeploys cut terminals

relay-server owns the PTY child processes in-process. A Railway deploy **replaces
the container**, so every child dies with it. This is also why the obvious
workaround does not work:

> ❌ **tmux/screen/abduco inside relay-server does NOT survive a redeploy.**
> It survives a *node process* restart, not a *container replacement*. Worth
> stating explicitly because it is the first idea everyone has.

### Options

**A. Invert the split — a `relay-workspace` service owns the volume, the PTYs, and
all execution; relay-server becomes a stateless control plane.**

This is the only version of the split that works on Railway. But scope is bigger
than "PTYs": **20+ relay-server modules touch the filesystem** (`git.ts`,
`projects.ts`, `tooling*.ts`, `visual-routes.ts`, `ai-routes.ts`, `project-graph.ts`,
`tunnel-manager.ts`, `reference-render.ts`, …). Agent CLI runs, git ops, builds,
reference renders and previews all need the volume too.

Real end state: relay-server (33.8k lines) splits into
- **control plane** — run state, API, orchestration decisions, UI serving (deploys freely), and
- **execution plane** — everything touching `/workspace` (deploys rarely).

Correct, but a large refactor.

**B. Decouple by HOST, not by service (pragmatic path to A).**

Run the workspace + PTYs + agents on a box whose lifecycle you control — a Fly
machine with a volume, a small VPS, or simply a Railway service you pin and never
redeploy. relay-server stays the control plane and deploys freely.

The incremental trick: the workspace service is *relay-server running in execution
mode*, not a rewrite. You get A's benefit before doing A's refactor.

**C. Make the cut invisible instead of impossible (cheapest real win — do this regardless).**

Persist per terminal: **cwd, scrollback, and the running command**. On reconnect,
respawn in the same cwd and replay the scrollback. `relay-pty/src/transcript.ts`
already tracks cwd and emits `cwd_changed` — that is the seed of this.

Shell sessions then feel continuous across a deploy. Long-running processes still
die (only A/B fix that), but the pipeline is already resumable
(`resumeInterruptedRuns`), so the damage is mostly cosmetic.

**D. Shrink the blast radius.** relay-web already deploys from its own repo — the
mobile-keyboard fix shipped with no relay-server deploy. Push more of the
fast-changing surface out of relay-server so the cut is rarer.

### Recommendation

1. **C now** — immediate relief, small, no architecture change.
2. **B next** — pin the workspace, let the control plane deploy freely.
3. **A when the split is worth paying for** (it is also a hard prerequisite for
   multi-tenant — see Part 2, so the work compounds).

---

## Part 2 — What "shippable" actually requires

### Finding 1 — There is no multi-tenancy. At all.

`grep -r "userId|tenant|orgId|accountId" src/` over 33.8k lines returns **nothing**.
Auth is a single shared static token:

```ts
export function isValidToken(token: string): boolean {
  const expected = resolveAuthToken();          // process.env.AUTH_TOKEN
  return expected.length > 0 && token === expected;
}
```

One token, no users, no sessions, no rotation, no expiry, non-constant-time compare.
Whoever holds it gets a **root shell**, the whole filesystem, git credentials, and
your logged-in agent CLIs. The token is also accepted via **query string**
(`req.query.token`), which leaks into logs, proxies and referrers.

### Finding 2 — The product *is* a remote shell

Terminals, arbitrary command execution, git, and agent CLIs authenticated as
`oauth-personal` (i.e. **your** accounts). "Multi-tenant" here cannot mean an auth
check in front of a shared box — it means **one isolated container/VM per tenant**,
plus per-tenant credentials. That is Part 1 Option A plus an orchestrator.

### Finding 3 — Live secret exposure

The relay-web git remote embeds a **plaintext GitHub PAT** (`ghp_OI1HGZ…`).
This is the second occurrence of a leaked PAT in this workspace. **Rotate it**, and
move git auth to a credential helper / env injection so tokens never land in
`.git/config`.

### Finding 4 — Single service, single volume, single region

`railway.toml` pins one service, one volume, `eu-west4`. The volume *is* the
architecture: there is no horizontal scale path without Part 1 Option A.

### Finding 5 — Deploys cut user sessions

Part 1 is not just an annoyance; for a paying user it is a product defect.

### Two honest shipping paths

**Path 1 — Self-hosted / single-tenant appliance (recommended first).**
Each customer runs their own Relay with their own token and their own agent logins.
This matches the current architecture almost exactly. Required work:

- Replace the static env token with real auth: login, sessions, rotation, expiry,
  constant-time compare; **drop `?token=` query auth**.
- Secret hygiene: purge PATs from git remotes, rotate the two leaked tokens.
- Terminal survivability (Part 1 option C).
- One-command deploy (Docker/Railway template) + first-run setup (agent CLI login,
  project import).
- Document plainly that the shell has full box access — acceptable when the box is
  the customer's, *not* acceptable shared.

**Path 2 — Multi-tenant SaaS.** Needs per-tenant isolation (container/VM per user),
real identity, credential vaulting, quotas/billing, and the control/execution split.
Months-scale, and it *requires* Part 1 Option A. Do not attempt before Path 1.

### Suggested order

1. Rotate leaked PATs; kill query-string auth. *(hours)*
2. Terminal reattach/replay — Part 1 option C. *(days)*
3. Real auth + sessions. *(days)*
4. Pin the workspace host — Part 1 option B. *(days)*
5. Packaging, onboarding, docs → **Path 1 shippable**.
6. Only then evaluate Path 2 / Option A.
