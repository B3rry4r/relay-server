# Framework parity — a phase is not shipped until every framework runs it

**Status: BINDING.** This governs every pass in `src/relay-server/passes/` and every
phase in `GEN_PHASES` (`ai-screen-loop.ts`).

## The rule

> A pipeline phase is **not done** when it works on one framework. It is done when
> it runs end to end on **every framework the pipeline can build** — today
> `flutter`, `react`, `next` — or when it explicitly and loudly declares that the
> phase is *meaningless* for that framework, with the reason.

"Ships flutter only" is not a status. It is an unfinished phase wearing a status.

## Why this exists

Phase 7 (Finalize) shipped six passes. All six had a `reactStrategy` seam, and all
six seams returned a stub:

```
applyModalOverlays  : react strategy not implemented (7b ships flutter only)
repointAssetUsage   : react strategy not implemented (7c ships flutter)
verifyFlowWiring    : 18/18 edges unmapped — 7d ships flutter only
renameSemantic      : 7e ships flutter only
```

The run reported `complete — 20/20 accepted` and `[finalize] complete — 6 applied`.
Nothing failed. Nothing warned loudly. **Six passes no-opped and the report called
them `applied`.** A React app shipped with `<PlaceholderScreen>` still wired to a
route that a canonical flow edge pointed at, and no one knew, because the pass that
checks flow wiring had never looked at a React file in its life.

A stub that reports `applied` is worse than a stub that throws. It launders an
unimplemented phase into a green build.

## What a pass MUST do

1. **Detect the framework precisely.** `react` and `next` are different targets:
   Next App Router has no central `<Routes>` table, its route *is* the directory.
   Do not collapse them and hope. `detectFramework()` must be able to return
   `'next'` distinctly from `'react'`.

2. **Implement the Strategy seam for every framework.** Same interface, same
   result shape, same counts. The orchestrator must not know or care which
   framework it is driving.

3. **If a pass is genuinely inapplicable, say so with a reason and a status of
   `skipped` — never `applied`.** Example: a Dart-specific `const` constructor
   cleanup has no React analogue. `status: 'skipped'`, `warnings: ['no analogue on
   react: <why>']`. `applied` with zero counts is a lie the report tells forever.

4. **Never let a pass's counts imply work it did not do.** `{transformed: 0,
   skipped: 4}` on a stub reads identically to a clean idempotent re-run.

5. **Resolve screen files from data the pipeline owns**, not from a convention it
   hopes holds. The `// canonicalId: <id> route: <route>` header is stamped on
   generated screens for *every* framework — Dart, TSX, and Next page files alike.
   Anything that resolves a canonical id to a file goes through the shared
   resolver, never a bespoke regex.

## What "runnable end to end" means

Phase 7 must be invocable against **any** project that reached Phase 5, whether or
not Phases 6 and 7 ever ran in the original run, and whether or not that run is
still alive. Concretely:

- `POST /api/ai/runs/:runId/finalize` re-enters Phase 7 alone, on a run parked at
  any phase, with no screen rebuilds.
- Finalize is **idempotent**: every pass detects its own prior output and skips
  (`already applied`), so a second invocation is safe and cheap.
- Finalize is **invalidated by any rebuild**: `restart` and `requeue` both drop
  `.uix/finalize-report.json`. A report describes the build that produced it, or
  it describes nothing.
- A run that never reached Phase 6/7 (rate-limited, stopped, crashed) can be
  finalized later without replaying the agent.

## Checklist before calling a phase done

- [ ] `flutter` strategy implemented and exercised on a real project.
- [ ] `react` strategy implemented and exercised on a real project.
- [ ] `next` strategy implemented and exercised on a real project.
- [ ] Inapplicable combinations report `skipped` + reason, never `applied`.
- [ ] The pass is idempotent — running it twice changes nothing the second time.
- [ ] The pass can be driven standalone against an already-built project.
- [ ] Verified by **inspecting the produced files**, not by reading the pass's own
      report. (See the standing rule: verify outputs, not logs.)
