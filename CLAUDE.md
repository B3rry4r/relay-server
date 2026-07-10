# relay-server

The backend for the Figma→code pipeline. Runs the build phases, drives the CLI
coding agents, renders references, and serves the run API.

## Binding rules

### 1. A phase is not shipped until every framework runs it

Read `docs/FRAMEWORK-PARITY.md`. It is binding, not advisory.

`flutter`, `react`, and `next` are all first-class build targets. A pass that
implements one and stubs the others is **unfinished**, and a stub that reports
`status: 'applied'` with zero counts is a bug — it launders an unimplemented phase
into a green build. If a pass is genuinely inapplicable to a framework, it reports
`status: 'skipped'` **with a reason**.

Every phase must also be runnable **standalone** against a project that stopped at
an earlier phase, without replaying the agent.

### 2. Never `git push` this repo without explicit authorization

Every push auto-deploys on Railway and restarts the container, which cuts the
user's embedded terminals. Commit locally and hand the user the trigger. For
run-state fixes, use the local API against the running server instead:

```
eval "$(tr '\0' '\n' < /proc/1/environ | grep -E '^(PORT|AUTH_TOKEN)=' | sed 's/^/export /')"
curl -s -H "Authorization: Bearer $AUTH_TOKEN" "127.0.0.1:$PORT/api/ai/runs?projectId=<id>"
```

A redeploy **resumes** running runs (`resumeInterruptedRuns`), so mark a run
stopped before triggering one.

### 3. Verify outputs, not logs

A pass reporting `applied` proves nothing. Open the file it claims to have
written. Look at the image it claims to have rendered. A verdict, a score, and a
log line are all downstream of the artifact — inspect the artifact.

This rule has caught, among others: reference PNGs keyed by frame *name* so nine
screens were graded against another screen's image; image fills matched against
the wrong hash so 0 of 20 shipped on every build ever; and reference renders
drawing `NO GLYPH` boxes where `₦` belonged, which a verify agent then
"reproduced" as a hallucinated strikethrough bug.

### 4. New dependencies must be safe for a clean install

A deploy-breaking push crash-loops Railway and cuts the agent off. Any new dep
goes in `package.json` **and** the lockfile, and must match the installed major.

## Layout

- `src/relay-server/ai-screen-loop.ts` — the run loop, `GEN_PHASES`, run endpoints.
- `src/relay-server/passes/` — the Phase 7 (Finalize) passes. Each has a
  framework-agnostic orchestrator plus one Strategy per framework.
- `src/relay-server/canonicalize-ai/` — the heavy-AI canonicalization chain.
- `src/relay-server/reference-render.ts` — headless reference PNGs. The harness is
  served from `HARNESS_DIR` (defaults to `relay-web/dist`), so a relay-web rebuild
  takes effect with **no relay-server deploy**.
