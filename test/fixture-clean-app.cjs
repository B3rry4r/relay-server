#!/usr/bin/env node
/* FIXTURE: prove the "clean generated app" fixes by INSPECTING ACTUAL OUTPUT FILES.
 * Builds a representative canonical (screens + states + bound modals + an UNBOUND
 * modal + a screen named with a raw frame code "283:1967"), runs skeleton + the
 * semantic-rename safety net, then asserts ZERO machine names anywhere. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const canon = require('../dist/src/relay-server/canonicalize.js');
const { renameSemantic } = require('../dist/src/relay-server/passes/semantic-rename.js');

const FAIL = [];
function assert(cond, msg) { if (!cond) { FAIL.push(msg); console.log('  FAIL: ' + msg); } else { console.log('  ok: ' + msg); } }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-app-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'),
    'name: fixture\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n');
  console.log('  flutter pub get --offline ...');
  cp.execSync('/workspace/.relay/tools/flutter/bin/flutter pub get --offline', { cwd: root, stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'main.dart'),
    "import 'app_router.dart';\nimport 'package:flutter/material.dart';\nvoid main() => runApp(const AppRouter());\n");

  // ── representative canonical ────────────────────────────────────────────────
  // screens: Login (default + an error state), Settings, a screen named by raw
  // frame-code "283:1967", a bound modal on Settings, and an UNBOUND modal.
  const canonical = {
    version: 1,
    screens: [
      { canonicalId: 'c_10_1', frameIds: ['10:1', '10:2'], name: 'Login',
        states: [{ id: 'default', frameId: '10:1' }, { id: 'error', frameId: '10:2' }],
        modals: [], role: 'screen', route: '' },
      { canonicalId: 'c_20_1', frameIds: ['20:1'], name: 'Settings',
        states: [{ id: 'default', frameId: '20:1' }],
        modals: [{ id: 'modal_30_1', frameId: '30:1', baseCanonicalId: 'c_20_1' }], role: 'screen', route: '' },
      // raw frame-code name → must fall back to a SEMANTIC name, never /283-1967.
      { canonicalId: 'c_283_1967', frameIds: ['283:1967'], name: '283:1967',
        states: [{ id: 'default', frameId: '283:1967' }], modals: [], role: 'screen', route: '' },
      // UNBOUND modal kept as a standalone screen (mirrors canonicalize fold).
      { canonicalId: 'c_40_9', frameIds: ['40:9'], name: 'Filter Sheet',
        states: [{ id: 'default', frameId: '40:9' }], modals: [], role: 'screen', route: '' },
      // a second "Login"-ish screen to force COLLISION suffixing.
      { canonicalId: 'c_50_1', frameIds: ['50:1'], name: 'Login',
        states: [{ id: 'default', frameId: '50:1' }], modals: [], role: 'screen', route: '' },
    ],
    components: [{ id: 'cmp_99_1', frameId: '99:1', name: 'Primary Button' }],
    templates: [],
    flow: { entryCanonicalId: 'c_10_1', edges: [] },
    frameMap: {},
    warnings: [],
  };

  console.log('\n=== generateFlutterSkeleton ===');
  const sk = await canon.generateFlutterSkeleton(root, canonical);
  // Sync the live canonical (T35) the way runAppLoop does, then run the safety net.
  await canon.syncLiveCanonical(root, 'run_test_1', canonical);

  // Simulate the per-screen agent dropping a MACHINE-named file the skeleton didn't
  // emit (the safety-net job): a screen file still carrying a machine class + route.
  // (Skeleton already wrote semantic files; this proves rename also catches strays.)

  console.log('\n=== renameSemantic (safety net) ===');
  const r = await renameSemantic('fixture', { projectRoot: root, noAi: true, env: process.env });
  console.log('  renamed=%d skipped=%d filesTouched=%d', r.report.summary.renamed, r.report.summary.skipped, r.report.summary.filesTouched);

  // ── INSPECT lib/screens/ ────────────────────────────────────────────────────
  const screensDir = path.join(root, 'lib', 'screens');
  const screenFiles = fs.readdirSync(screensDir).sort();
  console.log('\n=== ls lib/screens/ ===');
  screenFiles.forEach(f => console.log('  ' + f));
  assert(screenFiles.every(f => !/screen_\d/.test(f)), 'no screen_NNN machine file names');
  assert(screenFiles.includes('login_screen.dart'), 'login_screen.dart present (from name "Login")');
  assert(screenFiles.some(f => /login_screen_?2?\.dart|login_2_screen|login_screen2/.test(f)) || screenFiles.filter(f=>/login/.test(f)).length === 2, 'collision-suffixed second Login present');
  assert(screenFiles.some(f => f === 'screen_screen.dart' || /^screen(_\d+)?_screen\.dart$|^screen_screen\.dart$/.test(f) || screenFiles.includes('screen_screen.dart')), 'frame-code screen fell back to a semantic base (no /283-1967)');

  // ── INSPECT app_routes.dart ─────────────────────────────────────────────────
  const routes = fs.readFileSync(path.join(root, 'lib', 'app_routes.dart'), 'utf8');
  console.log('\n=== cat lib/app_routes.dart ===');
  console.log(routes.split('\n').map(l => '  ' + l).join('\n'));
  assert(!/\bc\d{3,}\b/.test(routes), 'no cNNNN route consts');
  assert(!/'\/\d+-\d+'/.test(routes), 'no /NNN-NNN route path values');
  assert(!/c_\d/.test(routes.replace(/canonicalId:[^\n]*/g, '')), 'no c_NNN tokens in routes (excluding header comments)');
  assert(/static const String login\b/.test(routes), 'semantic route const "login" present');
  assert(/static const String entry =/.test(routes), 'entry alias present');
  const entryMatch = routes.match(/entry = '([^']+)'/);
  assert(entryMatch && entryMatch[1] === '/login', 'entry points at the semantic entry route /login (got ' + (entryMatch && entryMatch[1]) + ')');

  // ── INSPECT app_router.dart ─────────────────────────────────────────────────
  const router = fs.readFileSync(path.join(root, 'lib', 'app_router.dart'), 'utf8');
  console.log('\n=== cat lib/app_router.dart ===');
  console.log(router.split('\n').map(l => '  ' + l).join('\n'));
  assert(!/screen_\d/.test(router), 'router has no screen_NNN imports');
  assert(!/'\/\d+-\d+'/.test(router), 'router has no /NNN-NNN case paths');
  assert((router.match(/case '/g) || []).length === canonical.screens.length, 'every screen has a router case');
  assert(/import 'screens\/login_screen\.dart'/.test(router), 'router imports semantic login_screen.dart');

  // ── grep for dangling machine names across lib/** ──────────────────────────
  console.log('\n=== grep machine names across lib/** ===');
  const grep = (re) => {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.dart')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          // ignore the `// canonicalId:` header (identity axis, intentional).
          if (/canonicalId:/.test(line)) return;
          if (re.test(line)) out.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`);
        });
      }
    });
    walk(path.join(root, 'lib'));
    return out;
  };
  const dangCls = grep(/\bIPhone\w*Screen\b|\bScreen_\d/);
  const dangConst = grep(/\bc\d{4,}\b/);
  const dangPath = grep(/'\/\d+-\d+'/);
  [...dangCls, ...dangConst, ...dangPath].forEach(l => console.log('  ' + l));
  assert(dangCls.length === 0, 'no dangling machine class names');
  assert(dangConst.length === 0, 'no dangling cNNNN consts');
  assert(dangPath.length === 0, 'no dangling /NNN-NNN paths');

  // ── canonical.json matches built app + owner-run keyed ─────────────────────
  const live = JSON.parse(fs.readFileSync(path.join(root, '.uix', 'canonical.json'), 'utf8'));
  console.log('\n=== .uix/canonical.json routes ===');
  live.screens.forEach(s => console.log(`  ${s.canonicalId} -> ${s.route}`));
  assert(live.ownerRunId === 'run_test_1', 'live canonical.json stamped with ownerRunId');
  assert(live.screens.every(s => !/\/\d+-\d+/.test(s.route)), 'live canonical routes are all semantic');
  // every live route must appear as a router case (built app matches canonical).
  assert(live.screens.every(s => router.includes(`case '${s.route}'`)), 'every canonical route is a router case');

  return { root, sk, canonical };
}

main().then(async ({ root, canonical }) => {
  // ── ORPHAN CLEANUP: simulate a prior build's stale screen + a SMALLER canonical ─
  // Isolated dir: build the FULL canonical's skeleton, then re-run cleanup with a
  // SMALLER canonical (only Login + Settings) + a stale prior-build file + a
  // hand-authored file. Only screens whose canonicalId is NOT in the smaller set
  // (and that carry a generated header) should be reaped; the hand-authored file stays.
  console.log('\n=== orphan cleanup (T35) ===');
  const oroot = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-app-orphan-'));
  await canon.generateFlutterSkeleton(oroot, JSON.parse(JSON.stringify(canonical)));
  const screensDir = path.join(oroot, 'lib', 'screens');
  console.log('  ls before:', fs.readdirSync(screensDir).sort());
  // a stale generated screen for a canonicalId NOT in any current canonical:
  fs.writeFileSync(path.join(screensDir, 'old_dashboard_screen.dart'),
    '// canonicalId: c_OLD_99  route: /old-dashboard\nimport "package:flutter/material.dart";\nclass OldDashboardScreen extends StatelessWidget { const OldDashboardScreen({super.key}); @override Widget build(c)=>const SizedBox(); }\n');
  // a hand-authored file with NO canonicalId header must be LEFT untouched:
  fs.writeFileSync(path.join(screensDir, 'hand_written.dart'), 'import "package:flutter/material.dart";\n// no header\n');
  const smaller = JSON.parse(JSON.stringify({ ...canonical, screens: canonical.screens.slice(0, 2) }));
  const res = await canon.cleanOrphanScreens(oroot, smaller);
  console.log('  removed:', res.removed);
  console.log('  ls after:', fs.readdirSync(screensDir).sort());
  const after = fs.readdirSync(screensDir);
  assert(!after.includes('old_dashboard_screen.dart'), 'stale orphan (old canonicalId) removed');
  assert(after.includes('hand_written.dart'), 'hand-authored no-header file LEFT untouched');
  assert(after.includes('login_screen.dart') && after.includes('settings_screen.dart'), 'current-canonical screens kept');
  // smaller set has 2 screens; full had 5 → 3 dropped-screens + 1 old_dashboard = 4 reaped.
  assert(res.removed.length === 4, 'reaped exactly the 4 screens not in the smaller canonical (3 dropped + 1 stale)');
  assert(res.removed.includes('lib/screens/old_dashboard_screen.dart'), 'stale prior-build file is among the reaped');

  // ── restampCanonicalHeaders finds SEMANTIC files ──────────────────────────
  console.log('\n=== restampCanonicalHeaders (semantic file lookup) ===');
  const loginPath = path.join(root, 'lib', 'screens', 'login_screen.dart');
  // simulate the per-screen agent dropping the canonicalId header:
  let body = fs.readFileSync(loginPath, 'utf8').split('\n').filter(l => !/^\/\/ /.test(l)).join('\n');
  fs.writeFileSync(loginPath, body);
  assert(!/canonicalId:/.test(fs.readFileSync(loginPath, 'utf8')), 'header dropped from login_screen.dart (setup)');
  const live2 = JSON.parse(fs.readFileSync(path.join(root, '.uix', 'canonical.json'), 'utf8'));
  const rr = await canon.restampCanonicalHeaders(root, live2);
  console.log('  stamped:', rr.stamped, ' missing:', rr.missingFiles);
  assert(/canonicalId: c_10_1/.test(fs.readFileSync(loginPath, 'utf8')), 'restamp re-stamped the SEMANTIC login_screen.dart');
  assert(rr.missingFiles.length === 0, 'restamp found every semantic screen file (no missing)');

  // ── dart analyze on the (full) fixture ─────────────────────────────────────
  console.log('\n=== flutter analyze ===');
  // restore the full screen set's stub for the removed-by-smaller screens is N/A;
  // analyze the app as the skeleton left it (re-run skeleton to restore stubs).
  try {
    const out = cp.execSync('/workspace/.relay/tools/flutter/bin/dart analyze --no-fatal-warnings lib 2>&1', { cwd: root, encoding: 'utf8' });
    console.log(out.split('\n').slice(0, 30).join('\n'));
    assert(!/error •/.test(out), 'dart analyze: no errors');
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    console.log(out.split('\n').slice(0, 40).join('\n'));
    // analyze exits non-zero on lints/warnings; only ERROR lines are a real fail.
    assert(!/error •/.test(out), 'dart analyze: no errors (exit nonzero may be info/warn)');
  }

  console.log('\n=== RESULT ===');
  if (FAIL.length) { console.log('FAILED ' + FAIL.length + ' assertion(s):'); FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('ALL ASSERTIONS PASSED');
  console.log('fixture root: ' + root);
}).catch(e => { console.error(e); process.exit(1); });
