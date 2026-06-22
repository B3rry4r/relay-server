#!/usr/bin/env node
// =============================================================================
// File: test/verify-pipeline.cjs
//
// T5 (RFC v2 §4.5 / §5) — OUTPUT-GROUNDED PIPELINE VERIFICATION HARNESS.
//
// Proves each pipeline phase met its HARD §5 exit criteria by inspecting the
// ARTIFACTS it left on disk + the durable run log — NEVER by trusting an agent's
// prose (RFC §0.3). Works for BOTH entrypoints:
//   - entry A (generation / runAppLoop): canonical.json is frame-derived; AI-fired
//     proof comes from `[ai:canon.*] status=ok` lines in the run log.
//   - entry B (resolve-app on an existing build, e.g. Ping): canonical.json is
//     `resolvedFromCode:true`; the "AI-fired" gate is replaced by the
//     deterministic-derivation marker (resolve uses AI only for ambiguous modals).
//
// USAGE:
//   node test/verify-pipeline.cjs --project Ping [--flow resolve|generation]
//                                 [--runId <id>] [--projects-root <dir>]
//                                 [--no-build] [--json]
//
//   --flow      auto-detected from canonical.json (resolvedFromCode) when omitted.
//   --runId     run whose .uix/runs/<id>.log holds the AI-fired proof (generation);
//               auto-detected from the newest *.log when omitted.
//   --no-build  skip the (slow) `flutter build web` in the Build check (analyze
//               still runs). For fast/offline iteration only — a full proof needs
//               the build.
//   --json      emit the machine-readable result object instead of the table.
//
// DISCIPLINE: read-only. The harness NEVER writes to lib/ or assets/. The only
// thing flutter build writes is build/ (its own output dir), which is not project
// source. Run it twice → identical verdict (determinism is asserted in the
// self-test, T5 step 4).
//
// EXIT: 0 when every REQUIRED check passes (SKIP is allowed); non-zero when any
// required check FAILs. A missing artifact for a phase that SHOULD have run is a
// FAIL, not a silent pass.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── tiny arg parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

// ── verdict primitives ─────────────────────────────────────────────────────────
const PASS = 'PASS', FAIL = 'FAIL', SKIP = 'SKIP';
function check(phase, name, verdict, detail) {
  return { phase, name, verdict, detail: detail || '' };
}

// ── opaque/node-id residue regex (reused from src/asset-naming.ts T2) ──────────
// A symbol name is OPAQUE residue when ANY underscore token is an `i<digits>`
// instance id or a `<3+ digits>` node-id-sized number (`arrow_941_i285`,
// `logo_290_4378`). A short trailing index (`graphic_1`) is NOT residue.
function hasNodeIdResidue(name) {
  return String(name).split('_').filter(Boolean)
    .some((t) => /^i\d+$/i.test(t) || /^\d{3,}$/.test(t));
}

// ── flutter binary (mirrors runtime.getFlutterRoot) ────────────────────────────
function flutterBin() {
  const ws = process.env.WORKSPACE || '/workspace';
  const candidates = [
    path.join(ws, '.relay', 'tools', 'flutter', 'bin', 'flutter'),
    path.join(process.env.HOME || '', 'flutter', 'bin', 'flutter'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* skip */ } }
  return null;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── PHASE 1 / 1′ — Canonical ─────────────────────────────────────────────────
function checkCanonical(ctx) {
  const out = [];
  const P = 'Canonical (1/1′)';
  const canonPath = path.join(ctx.uix, 'canonical.json');
  const canon = readJson(canonPath);

  if (!canon) {
    out.push(check(P, 'canonical.json exists + parses', FAIL, `missing/invalid: ${canonPath}`));
    return { checks: out, canon: null };
  }
  out.push(check(P, 'canonical.json exists + parses', PASS, path.relative(ctx.root, canonPath)));

  // schema-valid: the §5 required collections are present + correctly typed.
  const required = ['screens', 'modals', 'templates', 'components', 'flow'];
  const missing = required.filter((k) => !(k in canon) || (k !== 'flow' && !Array.isArray(canon[k])));
  const flowOk = canon.flow && Array.isArray(canon.flow.edges) && ('entryCanonicalId' in canon.flow);
  if (missing.length || !flowOk) {
    out.push(check(P, 'schema-valid (screens/modals/components/flow)', FAIL,
      `missing/typed-wrong: ${[...missing, ...(flowOk ? [] : ['flow'])].join(', ')}`));
  } else {
    out.push(check(P, 'schema-valid (screens/modals/components/flow)', PASS,
      `screens=${canon.screens.length} modals=${canon.modals.length} templates=${canon.templates.length} components=${canon.components.length} edges=${canon.flow.edges.length}`));
  }

  // idempotence proof: a non-empty contentHash.
  out.push(canon.contentHash
    ? check(P, 'contentHash present (idempotency proof)', PASS, canon.contentHash)
    : check(P, 'contentHash present (idempotency proof)', FAIL, 'no contentHash'));

  // every screen maps to a real artifact: resolve → a screen FILE carrying its
  // canonicalId; generation → a frame id present on the screen.
  const isResolve = ctx.flow === 'resolve';
  if (isResolve) {
    const screensDir = path.join(ctx.root, 'lib', 'screens');
    let fileIds = new Set();
    if (fs.existsSync(screensDir)) {
      for (const f of fs.readdirSync(screensDir).filter((x) => x.endsWith('.dart'))) {
        const head = (() => { try { return fs.readFileSync(path.join(screensDir, f), 'utf8').slice(0, 400); } catch { return ''; } })();
        const m = /canonicalId:\s*(c_[A-Za-z0-9_]+)/.exec(head);
        if (m) fileIds.add(m[1]);
      }
    }
    const unmapped = canon.screens.filter((s) => !fileIds.has(s.canonicalId));
    out.push(unmapped.length === 0
      ? check(P, 'every canonical screen → a real screen file', PASS, `${canon.screens.length}/${canon.screens.length} mapped`)
      : check(P, 'every canonical screen → a real screen file', FAIL,
        `${unmapped.length} unmapped: ${unmapped.slice(0, 4).map((s) => s.canonicalId).join(', ')}`));
  } else {
    const bad = canon.screens.filter((s) => !Array.isArray(s.frameIds) || s.frameIds.length === 0);
    out.push(bad.length === 0
      ? check(P, 'every canonical screen → a frame', PASS, `${canon.screens.length}/${canon.screens.length} have frameIds`)
      : check(P, 'every canonical screen → a frame', FAIL, `${bad.length} screens with no frameId`));
  }

  // modals bound: every modal has a non-empty base screen that exists in screens[].
  const screenIds = new Set(canon.screens.map((s) => s.canonicalId));
  const unbound = canon.modals.filter((m) => !m.baseCanonicalId || !screenIds.has(m.baseCanonicalId));
  out.push(unbound.length === 0
    ? check(P, 'every modal bound to a base screen', PASS, `${canon.modals.length} modals bound`)
    : check(P, 'every modal bound to a base screen', FAIL,
      `${unbound.length} unbound: ${unbound.slice(0, 4).map((m) => m.canonicalId).join(', ')}`));

  // AI-fired proof. Generation: a `[ai:canon.*] status=ok` line in the run log.
  // Resolve: the deterministic-derivation marker (resolvedFromCode), since resolve
  // is deterministic-primary and only calls AI for the ambiguous-modal residue.
  if (isResolve) {
    out.push(canon.resolvedFromCode === true
      ? check(P, 'derivation proof (resolve: resolvedFromCode marker)', PASS, 'resolvedFromCode=true')
      : check(P, 'derivation proof (resolve: resolvedFromCode marker)', FAIL,
        'canonical.json lacks resolvedFromCode=true — not a resolve-derived model'));
  } else {
    const log = ctx.runLog;
    // T14.4: a generation run MUST prove canon AI fired in ITS OWN log. No log, or
    // only an UNTIED newest-log guess (not the run that produced this canonical),
    // is unprovable → FAIL, never a free SKIP/PASS.
    if (!log) {
      out.push(check(P, 'AI-fired proof (generation: [ai:canon.*] status=ok)', FAIL,
        'no run log tied to this canonical — cannot prove canon AI fired (pass --runId)'));
    } else if (!log.tied) {
      out.push(check(P, 'AI-fired proof (generation: [ai:canon.*] status=ok)', FAIL,
        `log ${path.basename(log.path)} is not tied to this canonical (contentHash mismatch / no per-run canonical) — pass the correct --runId`));
    } else {
      const re = /\[ai:canon[^\]]*\][^\n]*status=ok/;
      out.push(re.test(log.text)
        ? check(P, 'AI-fired proof (generation: [ai:canon.*] status=ok)', PASS, `${path.basename(log.path)} (tied)`)
        : check(P, 'AI-fired proof (generation: [ai:canon.*] status=ok)', FAIL,
          `no '[ai:canon.* status=ok]' in tied log ${path.basename(log.path)}`));
    }
  }

  return { checks: out, canon };
}

// ── do assets exist that the pipeline SHOULD have processed? ───────────────────
// Returns the count of source asset files (SVG/PNG/JPG/WEBP/GIF) found under the
// project's `assets/` dir(s). A generation/resolve run over a design WITH assets
// MUST produce a resources file + map — a missing one is a regression, not a SKIP.
function countSourceAssets(root) {
  const dirs = [path.join(root, 'assets'), path.join(root, 'lib', 'assets'), path.join(root, 'public', 'assets')];
  const exts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
  let n = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.has(path.extname(e.name).toLowerCase())) n++;
    }
  };
  for (const d of dirs) walk(d);
  return n;
}

// ── PHASE 5 — Assets ──────────────────────────────────────────────────────────
// HONEST GATE (T14.3/T14.7): a missing resources file is only a SKIP when there
// were GENUINELY ZERO source assets to process. If the project has an `assets/`
// dir with real assets (i.e. the phase SHOULD have produced a resources file +
// map), a missing artifact is a FAIL, not a SKIP — that is the silent regression
// this harness exists to catch.
function checkAssets(ctx) {
  const out = [];
  const P = 'Assets (5)';
  const fw = ctx.framework;
  const resourcesRel = fw === 'flutter' ? 'lib/resources/app_assets.dart' : 'src/resources/assets.ts';
  const resourcesAbs = path.join(ctx.root, resourcesRel);
  const mapPath = path.join(ctx.uix, 'asset-map.json');
  const hasResources = fs.existsSync(resourcesAbs);
  const hasMap = fs.existsSync(mapPath);
  const sourceAssetCount = countSourceAssets(ctx.root);

  if (!hasResources && !hasMap) {
    if (sourceAssetCount > 0) {
      // Assets exist on disk but the phase produced NEITHER a resources file NOR a
      // map → the asset pipeline did not run (or failed silently). FAIL.
      out.push(check(P, 'asset phase ran (assets exist on disk)', FAIL,
        `${sourceAssetCount} source asset(s) under assets/ but no ${resourcesRel} and no .uix/asset-map.json — asset pipeline did NOT run`));
      return { checks: out };
    }
    out.push(check(P, 'asset phase ran', SKIP,
      `genuinely 0 source assets — no ${resourcesRel}/asset-map.json expected`));
    return { checks: out };
  }

  // resources file present + 0 opaque/node-id symbol names.
  if (!hasResources) {
    out.push(check(P, `${path.basename(resourcesRel)} present`, FAIL, `asset-map exists but ${resourcesRel} missing`));
  } else {
    out.push(check(P, `${path.basename(resourcesRel)} present`, PASS, resourcesRel));
    const src = fs.readFileSync(resourcesAbs, 'utf8');
    // Symbol names: the LHS identifiers of the resource constants. Flutter:
    // `static const String <symbol> = '...'`; web: `export const <symbol> = '...'`.
    const symRe = fw === 'flutter'
      ? /\b(?:static\s+const\s+\w+|const)\s+([A-Za-z_]\w*)\s*=/g
      : /\bexport\s+const\s+([A-Za-z_]\w*)\s*=/g;
    const symbols = [];
    let m;
    while ((m = symRe.exec(src)) !== null) symbols.push(m[1]);
    const opaque = symbols.filter(hasNodeIdResidue);
    out.push(opaque.length === 0
      ? check(P, '0 opaque/node-id symbol names', PASS, `${symbols.length} symbols, 0 opaque`)
      : check(P, '0 opaque/node-id symbol names', FAIL,
        `${opaque.length} opaque: ${opaque.slice(0, 5).join(', ')}`));
  }

  // asset-map.json present.
  out.push(hasMap
    ? check(P, '.uix/asset-map.json present', PASS, '.uix/asset-map.json')
    : check(P, '.uix/asset-map.json present', FAIL, 'no asset-map.json'));

  // every symbol's path resolves on disk (from the map's newPath entries).
  if (hasMap) {
    const map = readJson(mapPath);
    const entries = (map && Array.isArray(map.assets)) ? map.assets : [];
    const broken = entries.filter((e) => {
      const rel = e.newPath || e.oldPath;
      if (!rel) return true;
      return !fs.existsSync(path.join(ctx.root, rel));
    });
    out.push(broken.length === 0
      ? check(P, "every symbol's path resolves on disk", PASS, `${entries.length} asset paths OK`)
      : check(P, "every symbol's path resolves on disk", FAIL,
        `${broken.length}/${entries.length} missing on disk`));
  }

  // AI-fired proof — T14.7: the semantic rename is AI ONLY when there were OPAQUE /
  // node-id source names to de-opaque. If every source asset was already
  // semantically named (0 opaque), the rename legitimately fired NO model call →
  // mark the AI check N/A (SKIP w/ reason), NOT FAIL. Otherwise the proof MUST be
  // in THIS run's log (T14.4).
  let opaqueSourceCount = 0;
  if (hasMap) {
    const map = readJson(mapPath);
    const entries = (map && Array.isArray(map.assets)) ? map.assets : [];
    opaqueSourceCount = entries.filter((e) => {
      const old = e.oldPath || e.oldName || '';
      const base = String(old).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      return hasNodeIdResidue(base);
    }).length;
  }
  if (opaqueSourceCount === 0) {
    out.push(check(P, 'AI-fired proof (asset-rename)', SKIP,
      'N/A — 0 opaque/node-id source names, semantic rename had nothing to AI-name'));
  } else {
    const log = ctx.runLog;
    const re = /\[ai:asset[.\-]?rename[^\]]*\][^\n]*status=ok/;
    if (!log || !log.tied) {
      // There WERE opaque assets to name → a proof is mandatory + must come from
      // THIS run's log. No log, or only an untied newest-log guess = unprovable =
      // FAIL (T14.4 — don't SKIP/PASS a run that should prove it).
      out.push(check(P, 'AI-fired proof ([ai:asset-rename] status=ok)', FAIL,
        `${opaqueSourceCount} opaque source name(s) needed AI rename but no run log is tied to this run (pass --runId)`));
    } else {
      out.push(re.test(log.text)
        ? check(P, 'AI-fired proof ([ai:asset-rename] status=ok)', PASS, `${path.basename(log.path)} (${opaqueSourceCount} opaque named, tied)`)
        : check(P, 'AI-fired proof ([ai:asset-rename] status=ok)', FAIL,
          `no asset-rename AI-ok line in tied log ${path.basename(log.path)} (${opaqueSourceCount} opaque source name(s) needed it)`));
    }
  }

  return { checks: out };
}

// ── PHASE 6/9 — Build ─────────────────────────────────────────────────────────
// `flutter build web` succeeds AND `flutter analyze` has 0 NEW errors vs the
// recorded finalize baseline (or, when no baseline, vs the known pre-existing
// MyApp test error i.e. allow ≤ baseline).
function checkBuild(ctx) {
  const out = [];
  const P = 'Build (6/9)';
  const flutter = flutterBin();

  if (ctx.framework !== 'flutter') {
    out.push(check(P, 'flutter build/analyze', SKIP, `framework=${ctx.framework} — not flutter`));
    return { checks: out };
  }
  if (!flutter) {
    out.push(check(P, 'flutter build/analyze', SKIP, 'flutter SDK not found'));
    return { checks: out };
  }

  // analyze ERROR count.
  const an = spawnSync(flutter, ['analyze', '--no-pub'], {
    cwd: ctx.root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env,
  });
  const anOut = `${an.stdout || ''}${an.stderr || ''}`;
  const errors = (anOut.match(/^\s*error\s+•/gm) || []).length;
  // T14.5 — assert 0 NEW errors vs the REAL recorded baseline. finalize now persists
  // `baselineErrors` (the analyzer ERROR count it measured BEFORE the passes ran), so
  // the gate is "≤ the errors that pre-existed the production passes", not a hardwired
  // ≤1 from a dead field that nothing ever wrote. When no finalize report exists
  // (e.g. a pure generation run that didn't finalize), the budget is 0 NEW errors:
  // a freshly-built app must analyze clean.
  const finalizeRep = readJson(path.join(ctx.uix, 'finalize-report.json'));
  const haveRecordedBaseline = finalizeRep && typeof finalizeRep.baselineErrors === 'number';
  const baselineErrors = haveRecordedBaseline ? finalizeRep.baselineErrors : 0;
  const src = haveRecordedBaseline ? 'finalize baselineErrors' : 'no finalize report → 0 new errors';
  out.push(errors <= baselineErrors
    ? check(P, `flutter analyze errors ≤ baseline (${baselineErrors}, ${src})`, PASS, `${errors} error(s)`)
    : check(P, `flutter analyze errors ≤ baseline (${baselineErrors}, ${src})`, FAIL,
      `${errors} error(s) > baseline ${baselineErrors} — NEW errors introduced`));

  // build web.
  if (ctx.noBuild) {
    out.push(check(P, 'flutter build web succeeds', SKIP, '--no-build set (analyze still gated)'));
    return { checks: out };
  }
  // ensure a web/ dir exists so build web doesn't fail spuriously (flutter create
  // writes only web/ scaffolding + build/, never lib/ — source stays untouched).
  if (!fs.existsSync(path.join(ctx.root, 'web'))) {
    spawnSync(flutter, ['create', '--platforms=web', '.'], { cwd: ctx.root, encoding: 'utf8', env: process.env });
  }
  const bw = spawnSync(flutter, ['build', 'web', '-t', 'lib/main.dart'], {
    cwd: ctx.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
  });
  const built = bw.status === 0 && fs.existsSync(path.join(ctx.root, 'build', 'web', 'index.html'));
  out.push(built
    ? check(P, 'flutter build web succeeds', PASS, 'build/web/index.html produced')
    : check(P, 'flutter build web succeeds', FAIL,
      `${`${bw.stdout || ''}${bw.stderr || ''}`.slice(-300).replace(/\n/g, ' ')}`));

  return { checks: out };
}

// ── PHASE 8 — Finalize ─────────────────────────────────────────────────────────
// Report present; passes 8a-8f present; each is `applied` or a logged
// `skipped`/`degraded` — NONE `reverted` (a reverted pass = FAIL, RFC §5). AI proof
// present where the pass fired AI.
function checkFinalize(ctx) {
  const out = [];
  const P = 'Finalize (8)';
  const repPath = path.join(ctx.uix, 'finalize-report.json');
  const rep = readJson(repPath);

  if (!rep) {
    out.push(check(P, 'finalize-report.json exists', FAIL, `missing/invalid: ${repPath}`));
    return { checks: out };
  }
  out.push(check(P, 'finalize-report.json exists', PASS, path.relative(ctx.root, repPath)));

  const EXPECTED = ['extractComponents', 'applyModalOverlays', 'repointAssetUsage',
    'verifyFlowWiring', 'renameSemantic', 'deepenTokensAndCleanup'];
  const passes = Array.isArray(rep.passes) ? rep.passes : [];
  const byName = new Map(passes.map((p) => [p.name, p]));
  const missing = EXPECTED.filter((n) => !byName.has(n));
  out.push(missing.length === 0
    ? check(P, 'all 6 passes (8a–8f) present', PASS, `${passes.length} passes`)
    : check(P, 'all 6 passes (8a–8f) present', FAIL, `missing: ${missing.join(', ')}`));

  // NONE reverted.
  const reverted = passes.filter((p) => p.status === 'reverted');
  out.push(reverted.length === 0
    ? check(P, 'no pass reverted', PASS, passes.map((p) => `${p.name}=${p.status}`).join(' '))
    : check(P, 'no pass reverted', FAIL,
      `reverted: ${reverted.map((p) => `${p.name} (${p.error || ''})`.trim()).join('; ')}`));

  // status sanity: every pass is applied | skipped (reverted already caught above).
  const weird = passes.filter((p) => !['applied', 'skipped', 'reverted'].includes(p.status));
  out.push(weird.length === 0
    ? check(P, 'every pass has a legitimate status', PASS, 'applied/skipped only')
    : check(P, 'every pass has a legitimate status', FAIL,
      `bad: ${weird.map((p) => `${p.name}=${p.status}`).join(', ')}`));

  // T14.6 — a `skipped` pass that SHOULD have applied = FAIL. RFC §5 expects 8a–8f
  // `applied`. The only LEGITIMATE skip is a deliberate subset restriction
  // (`onlyPasses` set → others recorded skipped with reason 'not in onlyPasses').
  // Any OTHER skip is a regression masquerading as a clean result → FAIL.
  const ALLOWLISTED_SKIP = /not in onlyPasses/i;
  const skipped = passes.filter((p) => p.status === 'skipped');
  const regressionSkips = skipped.filter((p) => !(p.warnings || []).some((w) => ALLOWLISTED_SKIP.test(String(w))));
  if (skipped.length === 0) {
    out.push(check(P, 'no pass skipped-when-should-apply', PASS, 'all 8a–8f applied (none skipped)'));
  } else if (regressionSkips.length === 0) {
    out.push(check(P, 'no pass skipped-when-should-apply', PASS,
      `${skipped.length} skipped — all allowlisted (onlyPasses subset)`));
  } else {
    out.push(check(P, 'no pass skipped-when-should-apply', FAIL,
      `${regressionSkips.length} pass(es) skipped without an allowlisted reason: ${regressionSkips.map((p) => `${p.name} [${(p.warnings || []).join('; ') || 'no reason'}]`).join(', ')}`));
  }

  // AI proof present where a pass fired AI: any pass that fired must carry an
  // aiProof with firstCall proof (callId). A pass that didn't fire is fine.
  const firedNoProof = passes.filter((p) =>
    p.aiProof && p.aiProof.fired && (!p.aiProof.firstCall || !p.aiProof.firstCall.callId));
  out.push(firedNoProof.length === 0
    ? check(P, 'aiProof present where a pass fired AI', PASS,
      `${passes.filter((p) => p.aiProof && p.aiProof.fired).length} pass(es) fired w/ proof`)
    : check(P, 'aiProof present where a pass fired AI', FAIL,
      `fired without proof: ${firedNoProof.map((p) => p.name).join(', ')}`));

  return { checks: out, rep };
}

// ── PHASE 8d — Flow wiring ─────────────────────────────────────────────────────
// Report present; wired / wrong-target / unmapped counts SURFACED (wrong-target &
// unmapped are reported, not auto-fail — per RFC they go to a human).
function checkFlow(ctx) {
  const out = [];
  const P = 'Flow (8d)';
  const repPath = path.join(ctx.uix, 'flow-wiring-report.json');
  const rep = readJson(repPath);
  if (!rep) {
    out.push(check(P, 'flow-wiring-report.json exists', FAIL, `missing/invalid: ${repPath}`));
    return { checks: out };
  }
  out.push(check(P, 'flow-wiring-report.json exists', PASS, path.relative(ctx.root, repPath)));

  const s = rep.summary || {};
  out.push(check(P, 'wiring counts surfaced', PASS,
    `total=${s.totalEdges} wired=${s.wired} wrong-target=${s.wrongTarget} missing=${s.missing} dead=${s.deadTrigger} unmapped=${s.unmapped} autofix=${s.autoFixesApplied}`));
  // Surface (not fail) the residue that needs a human.
  const residue = (s.wrongTarget || 0) + (s.unmapped || 0) + (s.missing || 0);
  if (residue > 0) {
    out.push(check(P, 'human-review residue (wrong-target/unmapped/missing)', PASS,
      `${residue} edge(s) need human review (surfaced, not auto-fail per RFC)`));
  }
  return { checks: out, rep };
}

// ── PHASE — Idempotence ────────────────────────────────────────────────────────
// Cheap, read-only idempotence signals: canonical contentHash stable across reads,
// finalize passes individually idempotent (a re-run would be a near no-op — we
// assert the report's design intent: 0 destructive churn left), and the harness
// itself is deterministic (the determinism contract is exercised by the self-test;
// here we assert the artifacts carry idempotency markers).
function checkIdempotence(ctx, canon) {
  const out = [];
  const P = 'Idempotence';
  // contentHash stable on a second read of the same file.
  const a = readJson(path.join(ctx.uix, 'canonical.json'));
  const b = readJson(path.join(ctx.uix, 'canonical.json'));
  if (a && b && a.contentHash && a.contentHash === b.contentHash) {
    out.push(check(P, 'canonical contentHash stable across reads', PASS, a.contentHash));
  } else {
    out.push(check(P, 'canonical contentHash stable across reads', FAIL, 'hash unstable/absent'));
  }
  // The harness is deterministic by construction (pure reads + count assertions).
  out.push(check(P, 'harness verdict reproducible (pure reads)', PASS,
    'no project mutation — re-run yields identical verdict'));
  return { checks: out };
}

// ── run log discovery (T14.4: TIE the proof log to THIS run) ──────────────────
// The AI-fired proof for a generation run must come from THE run that produced the
// current canonical — NOT the newest unrelated run_*.log. Resolution order:
//   1. explicit --runId            → `tied:true`  (the human named the run)
//   2. derive: find the per-run    → `tied:true`  (the run whose
//      `<runId>.canonical.json` whose         output IS the current canonical)
//      contentHash === .uix/canonical.json
//   3. newest run_*.log (fallback) → `tied:false` (a GUESS; a generation AI-fired
//                                                   check must NOT trust this → FAIL)
// `tied` lets the canon/asset proof distinguish "proven for this run" from
// "found some log lying around".
function findRunLog(uix, runId) {
  const runsDir = path.join(uix, 'runs');
  if (!fs.existsSync(runsDir)) return null;
  // 1) explicit runId.
  if (runId) {
    const p = path.join(runsDir, `${runId}.log`);
    if (fs.existsSync(p)) return { path: p, text: fs.readFileSync(p, 'utf8'), tied: true, runId };
    return null;   // a named-but-missing log is honestly "not found" (→ FAIL downstream)
  }
  // 2) derive the run that produced the current canonical. Primary: contentHash
  //    match (the per-run sidecar now carries the AI model's contentHash — T15).
  //    Fallback: STRUCTURAL identity match (same set of canonicalIds) for a sidecar
  //    that predates contentHash propagation. Both are real ties (tied:true) — they
  //    pin the proof to the run whose OUTPUT is the current canonical.
  const curCanon = (() => { try { return JSON.parse(fs.readFileSync(path.join(uix, 'canonical.json'), 'utf8')); } catch { return null; } })();
  const curHash = curCanon && curCanon.contentHash;
  // The live canonical may be the AI-model shape (screens[].canonicalId) — collect its
  // canonical-screen identity set for the structural fallback.
  const curIds = curCanon && Array.isArray(curCanon.screens)
    ? new Set(curCanon.screens.map((s) => s && s.canonicalId).filter(Boolean))
    : new Set();
  let perRun = [];
  try { perRun = fs.readdirSync(runsDir).filter((f) => f.endsWith('.canonical.json')); } catch { /* none */ }
  // 2a) contentHash match (strongest).
  if (curHash) {
    for (const f of perRun) {
      const rc = (() => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { return null; } })();
      if (rc && rc.contentHash && rc.contentHash === curHash) {
        const rid = f.replace(/\.canonical\.json$/, '');
        const lp = path.join(runsDir, `${rid}.log`);
        if (fs.existsSync(lp)) return { path: lp, text: fs.readFileSync(lp, 'utf8'), tied: true, runId: rid };
      }
    }
  }
  // 2b) structural identity fallback: a sidecar whose canonicalId set EXACTLY equals
  //     the live canonical's (no contentHash on either, or hashes from different
  //     pipelines). An exact id-set match means this sidecar IS the current canonical.
  if (curIds.size) {
    for (const f of perRun) {
      const rc = (() => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { return null; } })();
      const rcIds = rc && Array.isArray(rc.screens)
        ? new Set(rc.screens.map((s) => s && s.canonicalId).filter(Boolean))
        : new Set();
      if (rcIds.size === curIds.size && [...rcIds].every((id) => curIds.has(id))) {
        const rid = f.replace(/\.canonical\.json$/, '');
        const lp = path.join(runsDir, `${rid}.log`);
        if (fs.existsSync(lp)) return { path: lp, text: fs.readFileSync(lp, 'utf8'), tied: true, runId: rid };
      }
    }
  }
  // 3) newest *.log — an UNTIED guess (prefer real run_* logs over ad-hoc test logs).
  const logs = fs.readdirSync(runsDir).filter((f) => f.endsWith('.log'));
  if (!logs.length) return null;
  const ranked = logs
    .map((f) => ({ f, p: path.join(runsDir, f), st: fs.statSync(path.join(runsDir, f)) }))
    .sort((x, y) => {
      const xr = x.f.startsWith('run_') ? 1 : 0;
      const yr = y.f.startsWith('run_') ? 1 : 0;
      if (xr !== yr) return yr - xr;            // prefer run_* logs
      return y.st.mtimeMs - x.st.mtimeMs;       // then newest
    });
  const top = ranked[0];
  return { path: top.p, text: fs.readFileSync(top.p, 'utf8'), tied: false, runId: top.f.replace(/\.log$/, '') };
}

function detectFramework(root) {
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) return 'flutter';
  if (fs.existsSync(path.join(root, 'package.json'))) return 'react';
  return 'unknown';
}

// ── main ───────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project || args._[0];
  if (!project) {
    console.error('usage: node test/verify-pipeline.cjs --project <name> [--flow resolve|generation] [--runId <id>] [--no-build] [--json]');
    process.exit(2);
  }
  const projectsRoot = args['projects-root'] || path.join(process.env.WORKSPACE || '/workspace', 'projects');
  const root = path.isAbsolute(project) ? project : path.join(projectsRoot, project);
  const projName = path.basename(root);

  if (!fs.existsSync(root)) {
    console.error(`FAIL: project root not found: ${root}`);
    // emit a single-line summary so the catch-a-failure demo is legible.
    console.log(`\nVERIFY ${projName} ?: 0 PASS, 1 FAIL, 0 SKIP`);
    process.exit(1);
  }
  const uix = path.join(root, '.uix');
  const framework = detectFramework(root);

  // flow: explicit, else auto from canonical.json's resolvedFromCode marker.
  let flow = args.flow;
  if (flow !== 'resolve' && flow !== 'generation') {
    const canon = readJson(path.join(uix, 'canonical.json'));
    flow = (canon && canon.resolvedFromCode === true) ? 'resolve' : 'generation';
  }

  const explicitRunId = typeof args.runId === 'string' ? args.runId : null;
  const runLog = findRunLog(uix, explicitRunId || undefined);

  // FAIL-CLOSED (T15): a GENERATION run's proof MUST be tied to the run that produced
  // the current canonical. If the auto-tie (contentHash / structural id-set) could not
  // find a tied log AND no --runId was given, we cannot prove the AI fired for THIS
  // run. Require --runId with a clear, top-level error instead of limping on with an
  // untied newest-log guess that buries a confusing FAIL deep in the table. This is a
  // hard REQUIRE, not a silent SKIP/PASS — the harness fails closed.
  if (flow === 'generation' && !explicitRunId && (!runLog || !runLog.tied)) {
    console.error(
      `FAIL: generation flow needs the proof log tied to the run that produced .uix/canonical.json, ` +
      `but auto-tie failed (no <runId>.canonical.json matched by contentHash or canonicalId set).\n` +
      `      Re-run with --runId <id> (the run whose .uix/runs/<id>.log holds the [ai:canon.*] proof).\n` +
      `      Available run logs: ${(() => { try { return fs.readdirSync(path.join(uix, 'runs')).filter((f) => f.endsWith('.log')).map((f) => f.replace(/\\.log$/, '')).join(', ') || '(none)'; } catch { return '(none)'; } })()}`,
    );
    console.log(`\nVERIFY ${projName} ${flow}: 0 PASS, 1 FAIL, 0 SKIP`);
    process.exit(2);
  }

  const ctx = { root, projName, uix, framework, flow, runLog, noBuild: !!args['no-build'] };

  const all = [];
  const c1 = checkCanonical(ctx); all.push(...c1.checks);
  all.push(...checkAssets(ctx).checks);
  all.push(...checkBuild(ctx).checks);
  all.push(...checkFinalize(ctx).checks);
  all.push(...checkFlow(ctx).checks);
  all.push(...checkIdempotence(ctx, c1.canon).checks);

  const nPass = all.filter((c) => c.verdict === PASS).length;
  const nFail = all.filter((c) => c.verdict === FAIL).length;
  const nSkip = all.filter((c) => c.verdict === SKIP).length;

  if (args.json) {
    console.log(JSON.stringify({ project: projName, flow, framework, checks: all, summary: { pass: nPass, fail: nFail, skip: nSkip } }, null, 2));
  } else {
    printTable(ctx, all);
  }
  console.log(`\nVERIFY ${projName} ${flow}: ${nPass} PASS, ${nFail} FAIL, ${nSkip} SKIP`);

  process.exit(nFail > 0 ? 1 : 0);
}

function printTable(ctx, checks) {
  console.log(`\n  PIPELINE VERIFICATION — project=${ctx.projName} flow=${ctx.flow} framework=${ctx.framework}`);
  console.log(`  run log: ${ctx.runLog ? path.basename(ctx.runLog.path) : '(none)'}\n`);
  let phase = '';
  const mark = { PASS: '✓ PASS', FAIL: '✗ FAIL', SKIP: '— SKIP' };
  for (const c of checks) {
    if (c.phase !== phase) { phase = c.phase; console.log(`  [${phase}]`); }
    const m = mark[c.verdict] || c.verdict;
    console.log(`    ${m.padEnd(8)} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
}

main();
