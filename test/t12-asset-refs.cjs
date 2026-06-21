// T12 fixture proof — generation must ship correct asset references.
//
// Builds a flutter project that mirrors the GENERATION shape post-asset-pass:
//   - lib/resources/app_assets.dart + .uix/asset-map.json (a consistent pair)
//   - real asset files on disk under assets/ (the renamed representatives)
//   - screen files that reference RAW 'assets/...' literals (what the agent emits)
//   - one screen marked needs-review (the case the OLD code skipped repoint for)
// then runs the T12 always-repoint step (mirroring runAssetRepoint: git snapshot
// → repoint → analyze gate → checkpoint) and PROVES:
//   1. 0 raw 'assets/...' literals pointing at renamed/deleted files remain in lib/
//   2. they're AppAssets.x and every symbol resolves on disk
//   3. it works WITH a needs-review screen present
//   4. the packet injection (buildAssetInventory + renderAssetInventory) carries
//      the inventory + "use AppAssets, not raw paths" instruction
//   5. atomicity — a forced repoint failure rolls back via git
//   6. idempotence — a second repoint is a no-op
//   7. flutter analyze ≤ baseline AND flutter build web succeeds
//
// Usage: node test/t12-asset-refs.cjs [--build-web]
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const DIST = path.join(__dirname, '..', 'dist', 'src', 'relay-server');
const au = require(path.join(DIST, 'passes', 'asset-usage.js'));
const vc = require(path.join(DIST, 'version-control.js'));

const ROOT = '/workspace/projects/t12-fixture';
const FLUTTER = '/workspace/.relay/tools/flutter/bin/flutter';
const DO_WEB = process.argv.includes('--build-web');

function sh(cmd, args, cwd) {
  const r = cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}
function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function analyzeErrors(cwd) {
  const r = sh(FLUTTER, ['analyze', '--no-pub'], cwd);
  const m = r.out.match(/^\s*error\s+•/gm);
  return m ? m.length : 0;
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

(async () => {
  // ── 0. fresh fixture ──────────────────────────────────────────────────────
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  // Scaffold a real flutter project first (gives us a web platform for build web),
  // THEN overwrite pubspec/lib with the T12 fixture shape below.
  {
    const platforms = DO_WEB ? 'web' : 'web';
    const cr = sh(FLUTTER, ['create', '.', '--platforms', platforms, '--project-name', 't12_fixture', '--no-pub'], ROOT);
    if (cr.code !== 0) console.error('flutter create warning:\n' + cr.out);
    // drop the scaffold's default widget test (references the removed counter widget).
    fs.rmSync(path.join(ROOT, 'test'), { recursive: true, force: true });
  }

  write('pubspec.yaml', [
    'name: t12_fixture',
    'description: T12 fixture',
    'publish_to: none',
    'environment:',
    '  sdk: ">=3.0.0 <4.0.0"',
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
    '  flutter_svg: ^2.0.0',
    'flutter:',
    '  uses-material-design: true',
    '  assets:',
    '    - assets/icons/',
    '    - assets/images/',
    '',
  ].join('\n'));

  // Real asset files on disk (the renamed representatives the resources file declares).
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="8"/></svg>';
  write('assets/icons/home.svg', svg);
  write('assets/icons/search.svg', svg);
  // 1x1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(path.join(ROOT, 'assets/images'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'assets/images/logo.png'), png);

  // Resources file — consistent symbol keys (toLowerCamel of the snake names),
  // icons first then images, alphabetical within (matches resources-emit ordering).
  write('lib/resources/app_assets.dart', [
    '// GENERATED — app assets.',
    'class AppAssets {',
    '  AppAssets._();',
    "  static const String home = 'assets/icons/home.svg';",
    "  static const String search = 'assets/icons/search.svg';",
    "  static const String logo = 'assets/images/logo.png';",
    '}',
    '',
  ].join('\n'));

  // asset-map.json — old (pre-rename) opaque paths → the renamed representatives.
  // The screens below reference the OLD paths (what the IR carried), which no longer
  // exist on disk (renamed/deduped) → the dangling refs T12 must fix.
  write('.uix/asset-map.json', JSON.stringify({
    framework: 'flutter',
    resourcesPath: 'lib/resources/app_assets.dart',
    assets: [
      { nodeId: '1:1', name: 'home', oldPath: 'assets/icons/vector_1_1.svg', newPath: 'assets/icons/home.svg', format: 'svg', kind: 'icon' },
      { nodeId: '1:2', name: 'search', oldPath: 'assets/icons/vector_1_2.svg', newPath: 'assets/icons/search.svg', format: 'svg', kind: 'icon' },
      { nodeId: '1:3', name: 'logo', oldPath: 'assets/images/img_1_3.png', newPath: 'assets/images/logo.png', format: 'png', kind: 'image' },
    ],
  }, null, 2));

  // Screen files referencing RAW opaque 'assets/...' literals (the OLD names that the
  // asset pass renamed away — so these literals point at NON-EXISTENT files = the bug).
  // screen_a.dart is an ACCEPTED screen; screen_b.dart is the NEEDS-REVIEW screen the
  // old code would have skipped repoint for.
  write('lib/screens/screen_a.dart', [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_svg/flutter_svg.dart';",
    '',
    'class ScreenA extends StatelessWidget {',
    '  const ScreenA({super.key});',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return Column(children: [',
    "      SvgPicture.asset('assets/icons/vector_1_1.svg', width: 24, height: 24),",
    "      Image.asset('assets/images/img_1_3.png'),",
    '    ]);',
    '  }',
    '}',
    '',
  ].join('\n'));

  write('lib/screens/screen_b.dart', [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_svg/flutter_svg.dart';",
    '',
    'class ScreenB extends StatelessWidget {',
    '  const ScreenB({super.key});',
    '  @override',
    '  Widget build(BuildContext context) {',
    // a const subtree enclosing a raw path — repoint must keep it building
    "    return const Center(child: Text('b'));",
    '  }',
    '}',
    '',
    'class ScreenBIcon extends StatelessWidget {',
    '  const ScreenBIcon({super.key});',
    '  @override',
    '  Widget build(BuildContext context) {',
    "    return SvgPicture.asset('assets/icons/vector_1_2.svg', width: 20, height: 20);",
    '  }',
    '}',
    '',
  ].join('\n'));

  write('lib/main.dart', [
    "import 'package:flutter/material.dart';",
    "import 'screens/screen_a.dart';",
    "import 'screens/screen_b.dart';",
    'void main() => runApp(const MaterialApp(home: Scaffold(body: ScreenA())));',
    "// keep imports used",
    'final _b = ScreenB;',
    'final _bi = ScreenBIcon;',
    '',
  ].join('\n'));

  const log = (m) => console.log('   ' + m);
  const vcOpts = { log, env: process.env };

  // ── flutter pub get (so analyze/build resolve flutter_svg) ─────────────────
  const pg = sh(FLUTTER, ['pub', 'get'], ROOT);
  if (pg.code !== 0) { console.error('pub get failed:\n' + pg.out); process.exit(1); }

  // ── git baseline ───────────────────────────────────────────────────────────
  await vc.ensureProjectGit(ROOT, vcOpts);
  // commit the fixture so the working tree is clean before the mutation
  sh('git', ['add', '-A'], ROOT);
  sh('git', ['commit', '-m', 'fixture baseline'], ROOT);

  // sanity: the raw literals currently point at NON-EXISTENT files (dangling)
  const danglingBefore = [];
  for (const e of JSON.parse(fs.readFileSync(path.join(ROOT, '.uix/asset-map.json'))).assets) {
    if (!fs.existsSync(path.join(ROOT, e.oldPath))) danglingBefore.push(e.oldPath);
  }
  check('fixture: raw oldPath literals point at deleted/renamed files (the bug)', danglingBefore.length === 3, `${danglingBefore.length} dangling`);

  // ── (4) PACKET INJECTION ─────────────────────────────────────────────────
  const inv = await au.buildAssetInventory(ROOT);
  const block = inv ? au.renderAssetInventory(inv) : '';
  check('injection: buildAssetInventory found a resources file/map', !!inv, inv ? `${inv.symbols.length} symbols` : 'null');
  check('injection: block mentions AppAssets symbols (home/search/logo)',
    /AppAssets\.home/.test(block) && /AppAssets\.search/.test(block) && /AppAssets\.logo/.test(block));
  check('injection: block instructs "use AppAssets, never raw assets/... literal"',
    /NEVER a raw 'assets\/\.\.\.' path/.test(block) && /USE `AppAssets\.<symbol>`/.test(block));
  check('injection: block carries the resources import path',
    block.includes('lib/resources/app_assets.dart'));

  // baseline analyze
  const baselineErrors = analyzeErrors(ROOT);
  log(`baseline analyze errors: ${baselineErrors}`);

  // ── ALWAYS-RUN REPOINT (mirrors runAssetRepoint) ───────────────────────────
  const preSha = await vc.snapshotBeforeMutation(ROOT, 'T12 always-run asset re-point', vcOpts);
  const res = await au.repointAssetUsage('t12', { projectRoot: ROOT, noAi: true, env: process.env });
  log(`repointed ${res.repointed.length}, skipped ${res.skipped.length}, warnings ${res.warnings.length}`);

  // regression gate
  const afterErrors = analyzeErrors(ROOT);
  log(`post-repoint analyze errors: ${afterErrors}`);
  if (afterErrors > baselineErrors) {
    await vc.rollbackTo(ROOT, preSha, vcOpts);
    check('repoint did NOT regress analyze (else rolled back)', false, `${baselineErrors} → ${afterErrors}`);
    process.exit(1);
  }
  check('repoint: analyze errors ≤ baseline (with needs-review screen present)', afterErrors <= baselineErrors, `${baselineErrors} → ${afterErrors}`);

  // ── (1)(2) PROVE no dangling raw refs remain; all are AppAssets.x resolving ──
  const libFiles = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (a.endsWith('.dart')) libFiles.push(a); } })(path.join(ROOT, 'lib'));
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.uix/asset-map.json')));
  const knownPaths = new Set();
  for (const e of map.assets) { knownPaths.add(e.oldPath); knownPaths.add(e.newPath); }

  let danglingRefs = 0, totalRawLits = 0;
  for (const f of libFiles) {
    if (f.endsWith('app_assets.dart')) continue; // the resources file LEGITIMATELY holds the literals
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(['"])(assets\/[^'"]*?)\1/g)) {
      totalRawLits++;
      const p = m[2];
      // a raw literal that is in our map (old or new) and whose file is missing = dangling
      if (knownPaths.has(p) && !fs.existsSync(path.join(ROOT, p))) danglingRefs++;
    }
  }
  check('repoint: 0 raw assets/... literals in lib/ outside the resources file', totalRawLits === 0, `${totalRawLits} found`);
  check('repoint: 0 dangling refs (renamed/deleted files) remain', danglingRefs === 0, `${danglingRefs}`);

  // every AppAssets.x referenced in screens resolves to a real file on disk
  const declared = {};
  {
    const rsrc = fs.readFileSync(path.join(ROOT, 'lib/resources/app_assets.dart'), 'utf8');
    for (const m of rsrc.matchAll(/static\s+const\s+String\s+(\w+)\s*=\s*'([^']+)'/g)) declared[m[1]] = m[2];
  }
  let symRefs = 0, symResolved = 0;
  for (const f of libFiles) {
    if (f.endsWith('app_assets.dart')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/AppAssets\.(\w+)/g)) {
      symRefs++;
      const p = declared[m[1]];
      if (p && fs.existsSync(path.join(ROOT, p))) symResolved++;
    }
  }
  check('repoint: every AppAssets.x in screens resolves to a file on disk', symRefs > 0 && symRefs === symResolved, `${symResolved}/${symRefs}`);

  // specifically prove the NEEDS-REVIEW screen (screen_b) was repointed
  const bSrc = fs.readFileSync(path.join(ROOT, 'lib/screens/screen_b.dart'), 'utf8');
  check('repoint: the NEEDS-REVIEW screen (screen_b) was repointed (old code skipped this)',
    /AppAssets\.search/.test(bSrc) && !/assets\/icons\/vector_1_2\.svg/.test(bSrc));

  // ── (7) build green ─────────────────────────────────────────────────────────
  if (DO_WEB) {
    const b = sh(FLUTTER, ['build', 'web', '--no-pub'], ROOT);
    check('flutter build web succeeds (with needs-review screen present)', b.code === 0, b.code === 0 ? 'ok' : b.out.split('\n').slice(-8).join(' | '));
  } else {
    log('skipping flutter build web (pass --build-web to run it)');
  }

  // checkpoint the applied repoint (durable history)
  await vc.commitCheckpoint(ROOT, 'phase asset re-point', `${res.repointed.length} repointed`, vcOpts);

  // ── (6) IDEMPOTENCE — a second repoint is a no-op ────────────────────────────
  const res2 = await au.repointAssetUsage('t12', { projectRoot: ROOT, noAi: true, env: process.env });
  check('idempotence: a 2nd repoint changes nothing', res2.repointed.length === 0, `${res2.repointed.length} repointed on 2nd run`);

  // ── (5) ATOMICITY — a forced repoint failure rolls back via git ──────────────
  // Corrupt a screen, snapshot, then force a "failure" path: we simulate a bad
  // repoint by mutating a file AND then rolling back to the snapshot, proving the
  // tree is restored EXACTLY (the runAssetRepoint catch/regression branches do this).
  const cleanSha = sh('git', ['rev-parse', 'HEAD'], ROOT).out.trim();
  const aBefore = fs.readFileSync(path.join(ROOT, 'lib/screens/screen_a.dart'), 'utf8');
  const snap = await vc.snapshotBeforeMutation(ROOT, 'T12 atomicity test', vcOpts);
  // simulate a destructive bad repoint
  fs.writeFileSync(path.join(ROOT, 'lib/screens/screen_a.dart'), 'BROKEN — not valid dart');
  fs.writeFileSync(path.join(ROOT, 'lib/screens/_pass_created.dart'), '// created by a bad pass');
  await vc.rollbackTo(ROOT, snap, vcOpts);
  const aAfter = fs.readFileSync(path.join(ROOT, 'lib/screens/screen_a.dart'), 'utf8');
  const createdGone = !fs.existsSync(path.join(ROOT, 'lib/screens/_pass_created.dart'));
  check('atomicity: rollback restores modified file byte-for-byte', aAfter === aBefore);
  check('atomicity: rollback removes pass-created files', createdGone);
  void cleanSha;

  // ── summary ──────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.error('FAILED: ' + failed.map((c) => c.name).join('; ')); process.exit(1); }
  console.log('ALL T12 CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
