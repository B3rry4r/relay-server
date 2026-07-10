---
name: framework-parity
description: Use when adding, changing, or reviewing any pipeline phase or pass in relay-server (src/relay-server/passes/, GEN_PHASES in ai-screen-loop.ts), or whenever you see a "not implemented for <framework>" stub. Enforces that a phase ships for flutter, react AND next before it counts as done, and that it can be run standalone against a build that stopped early.
---

# A phase is not shipped until every framework runs it

Read `docs/FRAMEWORK-PARITY.md` — it is the binding contract. This skill is how you
apply it.

## The rule

`flutter`, `react`, and `next` are all first-class build targets. A pass that
implements one and stubs the others is **unfinished**.

**"ships flutter only" is not a status. It is an unfinished phase wearing one.**

## The failure this prevents

Phase 7 shipped six passes. All six had a `reactStrategy` seam. All six seams
returned a stub, and the orchestrator recorded each one as `status: 'applied'` with
zero counts — indistinguishable from a clean idempotent re-run. A React app
finalized green while:

- a canonical flow edge pointed at a route mounting `<PlaceholderScreen>`;
- a modal was presented only by `SettingsPreview.tsx`, the verify harness, and so
  was unreachable in the shipped app;
- the build agent had never been told the design's real images existed, so it
  hand-drew street grids and avatars that shipped in the `.fig`.

Nothing failed. Nothing warned. Six passes no-opped, and the report called them
`applied`.

## What you must do

1. **Detect the framework precisely.** `next` is not a flavour of `react`: App
   Router has no central `<Routes>` table — the route *is* the directory.
   `detectFramework()` returns `'next'` distinctly. Never collapse them.

2. **Implement the Strategy seam for every framework.** Same interface, same
   result shape, same counts. The orchestrator must not know which framework it
   is driving.

3. **Inapplicable ≠ applied.** If a pass has no analogue on a framework, report
   `status: 'skipped'` **with a reason**. `applied` with zero counts is a lie the
   report tells forever.

4. **Resolve screens from data the pipeline owns.** Go through the shared
   resolver — `passes/web-app.ts` on web, the `// canonicalId: <id> route: <route>`
   header everywhere. Never a bespoke regex over file names.

5. **Never rewrite on a guess.** Where Flutter parameterizes differing literals,
   web extraction merges only byte-identical duplicates and *reports* the rest. A
   wrong merge silently changes a screen that already matched its reference. One
   shared filename token is not evidence: `DeliveryTrackingCard` shares "delivery"
   with `delivery_driver_avatar` while what it actually draws is a street grid.

6. **Gate the build for every framework you write files on.** flutter →
   `flutter analyze` + `flutter build web`. web → `tsc --noEmit` + `npm run build`.
   A pass that writes without a gate ships its own bugs. (This gate caught two of
   mine on the very first real run.)

7. **Make it runnable standalone.** A run that stopped at Phase 5 or 6 —
   rate-limited, cancelled, redeployed, parked on needs-review — has a fully built
   app that never saw the phase. It must be possible to run the phase against that
   app with no rebuild and no agent:

   ```
   POST /api/ai/runs/:runId/finalize   {projectId, dryRun?, force?, onlyPasses?}
   POST /api/ai/finalize-app           {projectId, dryRun?, onlyPasses?}   # no run
   ```

   Every pass is idempotent (it detects its own prior output and skips), and any
   rebuild invalidates it: `restart` and `requeue` both drop
   `.uix/finalize-report.json`. A report describes the build that produced it, or
   it describes nothing.

## Checklist before you call a phase done

- [ ] `flutter` strategy implemented and exercised on a real project.
- [ ] `react` strategy implemented and exercised on a real project.
- [ ] `next` strategy implemented and exercised on a real project.
- [ ] Inapplicable combinations report `skipped` + reason, never `applied`.
- [ ] Running it twice changes nothing the second time.
- [ ] It can be driven standalone against an already-built project.
- [ ] **Verified by opening the files it produced**, not by reading its own report.
      Build the app. Look at the diff. A pass reporting `applied` proves nothing.
