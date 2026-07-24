# RFC: Relay → multi-tenant platform (control/execution split + admin + flags)

Status: **plan, pending Phase 0 decisions**. Method mirrors `contract-driven-backend`
and `admin-surface-extension`: frozen artifacts over agent judgment, one agent one
scope, mechanical triage, halt-on-conflict, **done = evidence**.

---

## 0. Ground truth (measured, not assumed)

| Fact | Value | Consequence |
|---|---|---|
| Auth | ONE static `AUTH_TOKEN`, `===` compare, also accepted via `?token=` | No identity to build tenancy on |
| Tenancy primitives | `userId`/`tenant`/`orgId` — **zero occurrences** in 33.8k lines | Greenfield tenancy |
| Persistence | **No database.** All state is JSON on one shared volume (`.uix/runs/*.json`, `.relay/`) | Control plane needs a real DB |
| HTTP surface | **105 endpoints** across 8 route modules | Every one needs a plane assignment |
| Socket | Socket.IO, same shared token, terminal + run streams | Needs per-tenant routing |
| Execution coupling | **20+ modules** call `resolveWorkspace()`/`getProjectsRoot()` | Execution plane is large, not just PTYs |
| In-memory state | Many module-level `Map`s (previews, tunnels, jobs, renders) | Single-tenant by construction |
| relay-web features | `auth, chat, devtools, files, git, projects, terminal, uix, workspace` | `uix` is a clean flag boundary |
| Product shape | Terminals + arbitrary exec + agent CLIs on `oauth-personal` | **Isolation must be a container per tenant, not a WHERE clause** |

**The load-bearing conclusion:** Relay is a remote shell. Multi-tenancy therefore
cannot be row-level scoping — it requires **one isolated execution environment per
tenant**. That is why Option A (control/execution split) is a *prerequisite* for
multi-tenancy, not a parallel workstream. Doing A and doing multi-tenant are the
same project.

---

## 1. Target architecture

```
relay-web ── tenant app  +  admin app (separate identity, flag-gated)
     │ HTTPS / WSS
     ▼
relay-control  (CONTROL PLANE — deploys freely, stateless + Postgres)
  identity: tenants, users, AdminUsers (separate token domain)
  projects & runs INDEX, feature flags, runner registry, routing/proxy,
  admin API, audit log, quotas
     │  provisions + routes + issues short-lived runner tokens
     ▼
relay-runner  (EXECUTION PLANE — ONE PER TENANT, long-lived, rarely deployed)
  owns THAT tenant's volume: projects, git, .uix state
  PTYs (relay-pty folded back in), agent CLIs, builds, reference render,
  previews, tunnels
```

Why this fixes the redeploy cut: the thing that changes constantly (control plane)
is no longer the thing holding your PTYs. relay-pty stops being a service that
*can't see files* and becomes the terminal subsystem *inside* the runner, which is
exactly where the files are.

**Framework is inherited, never chosen** (skill law): TypeScript + Express +
Socket.IO, matching the live codebase. No second stack enters.

---

## 2. Protected surfaces (this is a brownfield job)

You are actively using relay every day. Two surfaces are READ-ONLY territory:

1. **The live single-tenant behaviour** — all 105 endpoints, the socket protocol,
   and your existing projects/runs on the current volume.
2. **The agent-run pipeline semantics** — GEN_PHASES, finalize passes, run store
   shapes. Tenancy must not perturb build correctness.

**Law: single-tenant mode keeps working the entire time.** Multi-tenant ships behind
a flag and becomes default only at an explicit cutover. Nothing in this plan is a
big-bang rewrite.

---

## 3. Pipeline artifacts (`.platform/` at relay-server root)

```
.platform/
├── platform-decisions.json   # Phase 0 — isolation substrate, DB, creds, roles. FROZEN.
├── protected-registry.json   # Phase 1 — 105 endpoints + socket events + shapes. FROZEN.
├── state-inventory.json      # Phase 1 — every state item → control | execution | tenant-data
├── tenancy-audit.json        # Phase 1 — every single-tenant assumption, file:line
├── plane-map.json            # Phase 3 — each endpoint → CONTROL | EXECUTION | SPLIT | ADMIN
├── flag-registry.json        # Phase 6 — flag taxonomy + default values per tier
├── admin-registry.json       # Phase 7 — admin endpoints + role matrix. FROZEN.
├── conflicts.json            # must be empty to proceed
└── status.json               # dispatcher state (resume-safe)
```

---

## 4. Phases

**Phase 0 — Decisions (with you, once).** Blocking questions in §6. Output
`platform-decisions.json`, frozen.

**Phase 1 — Ground truth (3 agents, parallel).**
- *Registry agent* → `protected-registry.json`: all 105 endpoints (method, path, auth,
  request/response shape) + every socket event. This is the regression tripwire.
- *State agent* → `state-inventory.json`: every JSON file, directory, and module-level
  `Map`, classified control / execution / tenant-data.
- *Tenancy-audit agent* → `tenancy-audit.json`: every `resolveWorkspace()`,
  `getProjectsRoot()`, shared `Map`, and `isValidToken` call site.

**Phase 2 — Regression baseline (1 agent). GATE.** Contract tests generated *from*
`protected-registry.json`, run against current relay-server. **All green before a
single line changes.** Re-run after every wave. Red at any point = halt.

**Phase 3 — Plane assignment (mechanical). HALT-ON-CONFLICT.** Each endpoint and
state item → CONTROL / EXECUTION / SPLIT / ADMIN. Classification, never invention.
Anything unclassifiable goes to `conflicts.json` for your ruling. Output `plane-map.json`.

**Phase 4 — Control plane foundation (waves).**
- Postgres schema: `tenants, users, admin_users, memberships, projects_index,
  runs_index, feature_flags, flag_overrides, runners, audit_log`.
- **Identity replaces the static token**: sessions, rotation, expiry, constant-time
  compare, **`?token=` query auth deleted**.
- **Admin identity is a separate model** (skill law): own table, own secret, own
  `iss`/`aud`. Gate: contract tests assert **cross-rejection** — an admin token fails
  tenant guards and a tenant token fails admin guards.

**Phase 5 — Runner extraction (waves, one agent per execution module group).**
relay-runner = the EXECUTION-classified modules + **relay-pty folded back in** as the
terminal subsystem. Control plane issues short-lived per-runner tokens; a runner only
ever serves its own tenant. Socket traffic (terminal/run streams) proxied or
direct-with-token per Phase 0. Per-tenant `Map`s replace module-level globals.

**Phase 6 — Feature flags.** `flag-registry.json` + evaluation in API *and* UI, one
helper each. `uix` is flag #1 (`feature.uix`), then `feature.terminal`,
`feature.git`, `feature.agent_builds`. Flags resolve tenant-override → tier default →
global default. Admin toggles them (Phase 7).

**Phase 7 — Admin dashboard.** Built into relay-web behind admin identity:
tenant CRUD + assignment, runner health/restart, live run monitoring, flag toggles
per tenant, audit log, quotas. Typed client generated from frozen `admin-registry.json`
— **wiring agents never hand-write a response shape** (skill law).

**Phase 8 — Cutover.** Migrate your current workspace into tenant #1 with zero data
loss; single-tenant compat mode retained behind a flag until you say otherwise.

**Phase 9 — Triple smoke.** (1) control + admin contracts per role incl. cross-rejection;
(2) full regression suite; (3) rendered headless pass over every tenant + admin route —
fail on any console error, any placeholder literal, any unwired surface. Screenshots
to a review folder.

---

## 5. Sequencing & parallelism

Waves 1–3 are the honest critical path; the rest parallelizes.

| Wave | Content | Parallel agents |
|---|---|---|
| 1 | Phase 1 ground truth | 3 |
| 2 | Phase 2 baseline (GATE) | 1 |
| 3 | Phase 3 plane map (GATE) | mechanical |
| 4 | DB schema + identity + admin identity | 3 |
| 5 | Runner extraction | 1 per module group (~5–7) |
| 6 | Flags + UIX gating | 2 |
| 7 | Admin dashboard | 1 per admin screen |
| 8 | Cutover + smoke | 2 |

---

## 6. Blocking decisions (Phase 0)

1. **Isolation substrate** — the biggest fork. Railway attaches a volume to one
   service, so it cannot host per-tenant runners well. Candidates: **Fly Machines**
   (per-tenant machine + volume, API-provisioned, scale-to-zero — best fit),
   Docker on a VPS you control (cheapest, manual ops), Kubernetes (heaviest).
2. **Agent credentials** — BYO (each tenant logs in their own Claude/Codex/Gemini)
   vs platform-provided pooled keys. Drives cost model *and* legal exposure.
3. **v1 scope** — is billing/quota enforcement in v1, or invite-only with quotas
   logged but not enforced?
4. **Runner lifecycle** — always-on per tenant (simple, costly) vs sleep-on-idle +
   wake-on-request (cheaper, adds cold-start to terminals).

---

## 7. Halt conditions

Baseline red at any point; `conflicts.json` non-empty; an agent asking to edit a
protected surface; cross-rejection tests failing; a destructive migration required;
an agent filing an empty anomaly report over a defective surface; rendered smoke
failing twice.
