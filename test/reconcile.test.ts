import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reconcileScreen, reconcileSummary } from '../src/relay-server/reconcile';
import type { Canonical } from '../src/relay-server/canonicalize';

// A minimal canonical with two screens + one shared component, mirroring what
// generateFlutterSkeleton emits (canonicalId → route + screen_<id>.dart file).
const canonical: Canonical = {
  version: 1,
  screens: [
    { canonicalId: 'c_1_1', frameIds: ['1:1'], name: 'Login', states: [{ id: 'default', frameId: '1:1' }], modals: [], role: 'screen', route: '/login' },
    { canonicalId: 'c_1_2', frameIds: ['1:2'], name: 'Home', states: [{ id: 'default', frameId: '1:2' }], modals: [], role: 'screen', route: '/home' },
  ],
  components: [{ id: 'cmp_2_1', frameId: '2:1', name: 'Balance Card' }],
  templates: [],
  flow: { entryCanonicalId: 'c_1_1', edges: [] },
  frameMap: { '1:1': 'c_1_1', '1:2': 'c_1_2', '2:1': 'cmp_2_1' },
  warnings: [],
};

let root: string;
const screenFile = (id: string) => path.join('lib', 'screens', `screen_${id.replace(/^c_/, '')}.dart`);

async function writeScreen(canonicalId: string, body: string): Promise<void> {
  const rel = screenFile(canonicalId);
  await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'recon-')); });
afterEach(async () => { try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('reconcileScreen', () => {
  it('is a no-op without canonical context (existing per-frame runs unaffected)', async () => {
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter' });
    expect(r.ok).toBe(true);
    expect(r.flags).toHaveLength(0);
  });

  it('passes a clean screen that imports the theme + uses only legal routes', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../app_routes.dart';
import '../components/cmp_2_1.dart';
class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(body: BalanceCardWidget());
  }
  void go() => Navigator.pushNamed(context, AppRoutes.home);
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(true);
    expect(r.flags.filter(f => f.severity === 'high')).toHaveLength(0);
  });

  it('flags an invented top-level route as HIGH (blocks done)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    Navigator.pushNamed(context, '/totally-invented-route');
    return const Scaffold();
  }
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(false);
    expect(r.flags.some(f => f.code === 'new-route' && f.severity === 'high')).toBe(true);
  });

  it('flags a reference to a route constant not in the plan as HIGH', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: TextButton(onPressed: () => Navigator.pushNamed(context, AppRoutes.settingsPage), child: const Text('x')));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(false);
    expect(r.flags.some(f => f.code === 'unbacked-route')).toBe(true);
  });

  it('flags missing theme import + many inline colour/text literals (med, non-blocking)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Container(
    color: Color(0xFF112233),
    child: Column(children: [
      Text('a', style: TextStyle(color: Colors.red)),
      Text('b', style: TextStyle(color: Color(0xFF445566))),
      Text('c', style: TextStyle(color: Colors.blue)),
      Text('d', style: TextStyle(color: Color(0xFF778899))),
    ]),
  );
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    // No invented routes → not blocked, but the drift is flagged.
    expect(r.ok).toBe(true);
    expect(r.flags.some(f => f.code === 'missing-theme-import')).toBe(true);
    expect(r.flags.some(f => f.code === 'inline-color')).toBe(true);
    expect(r.flags.some(f => f.code === 'inline-textstyle')).toBe(true);
    expect(reconcileSummary(r)).toContain('reconciliation');
  });

  it('is a no-op for non-flutter frameworks', async () => {
    const r = await reconcileScreen({ projectRoot: root, framework: 'web', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(true);
    expect(r.flags).toHaveLength(0);
  });

  // ── P1-core lints: placeholder/deferral markers + dead handlers ─────────────
  // Agents were observed self-issuing untracked IOUs ("placeholder sheet — real
  // frames come later") and shipping `onTap: () {}` — 13/13 of Ping's folded modals.
  // Both are HIGH flags, so the existing gate demotes the screen to needs-review.

  it('flags a deferral comment ("real frames come later") as HIGH deferred-placeholder', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    // Placeholder sheet — the real frames come later in a later build.
    return const Scaffold();
  }
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(false);
    expect(r.flags.some(f => f.code === 'deferred-placeholder' && f.severity === 'high')).toBe(true);
  });

  it('flags a placeholder STRING literal as HIGH deferred-placeholder', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Text('This sheet is a placeholder, filled in by a later pass'));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(false);
    expect(r.flags.some(f => f.code === 'deferred-placeholder')).toBe(true);
  });

  it('flags all three empty-handler forms as HIGH dead-handler (each listed)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: Column(children: [
    GestureDetector(onTap: () {}, child: const Text('a')),
    TextButton(onPressed: ()  {  }, child: const Text('b')),
    InkWell(onTap: () => {}, child: const Text('c')),
  ]));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.ok).toBe(false);
    const flag = r.flags.find(f => f.code === 'dead-handler');
    expect(flag).toBeTruthy();
    expect(flag!.severity).toBe('high');
    expect(flag!.message).toContain('3 empty interaction handler(s)');
    expect(flag!.message).toContain('onTap');
    expect(flag!.message).toContain('onPressed');
  });

  it('does NOT flag real handlers or the Placeholder WIDGET in code (negative case)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: Column(children: [
    // Real, wired handlers below — nothing deferred here.
    GestureDetector(onTap: () => Navigator.pushNamed(context, AppRoutes.home), child: const Text('go')),
    TextButton(onPressed: () { debugPrint('hi'); }, child: const Text('log')),
    const Placeholder(),
  ]));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.flags.some(f => f.code === 'dead-handler')).toBe(false);
    expect(r.flags.some(f => f.code === 'deferred-placeholder')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('inspects the SEMANTIC screen file (planSemanticScreens fileBase), not just screen_<id>.dart', async () => {
    // Write the screen under its semantic name (what the skeleton actually emits).
    const rel = path.join('lib', 'screens', 'login_screen.dart');
    await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), `
// canonicalId: c_1_1  route: /login
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    // real frames come later
    return GestureDetector(onTap: () {}, child: const Scaffold());
  }
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.inspected).toContain(rel);
    expect(r.flags.some(f => f.code === 'deferred-placeholder')).toBe(true);
    expect(r.flags.some(f => f.code === 'dead-handler')).toBe(true);
  });
});

// ── P3: nav-stack advisory — push-into-hub ────────────────────────────────────
// When a shell/hub exists (P2 tab cluster), entering it with a plain pushNamed
// leaves auth/onboarding on the back stack (the Ping app's back-gesture returned
// to the login form). MED advisory — never blocks done on its own.
describe('reconcileScreen push-into-hub advisory (P3)', () => {
  // Home is the hub (tab edges out to Settings + Profile); Login is outside it.
  const tabCanonical: Canonical = {
    version: 1,
    screens: [
      { canonicalId: 'c_1_1', frameIds: ['1:1'], name: 'Login', states: [{ id: 'default', frameId: '1:1' }], modals: [], role: 'screen', route: '/login' },
      { canonicalId: 'c_1_2', frameIds: ['1:2'], name: 'Home', states: [{ id: 'default', frameId: '1:2' }], modals: [], role: 'screen', route: '/home' },
      { canonicalId: 'c_1_3', frameIds: ['1:3'], name: 'Settings', states: [{ id: 'default', frameId: '1:3' }], modals: [], role: 'screen', route: '/settings' },
    ],
    components: [],
    templates: [],
    flow: {
      entryCanonicalId: 'c_1_1',
      edges: [
        { fromCanonicalId: 'c_1_2', toCanonicalId: 'c_1_3', kind: 'tab' },
      ],
    },
    frameMap: { '1:1': 'c_1_1', '1:2': 'c_1_2', '1:3': 'c_1_3' },
    warnings: [],
  };

  it('flags a plain pushNamed into a hub/shell route (MED, advisory — ok stays true)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: TextButton(
    onPressed: () => Navigator.pushNamed(context, AppRoutes.home),
    child: const Text('Sign in')));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical: tabCanonical, canonicalId: 'c_1_1' });
    const flag = r.flags.find(f => f.code === 'push-into-hub');
    expect(flag).toBeTruthy();
    expect(flag!.severity).toBe('med');
    expect(flag!.message).toContain('pushNamedAndRemoveUntil');
    expect(r.ok).toBe(true);                                   // advisory, never blocks
  });

  it('does NOT flag stack-clearing verbs or non-hub pushes', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: Column(children: [
    TextButton(onPressed: () => Navigator.pushNamedAndRemoveUntil(context, AppRoutes.home, (r) => false), child: const Text('a')),
    TextButton(onPressed: () => Navigator.pushReplacementNamed(context, AppRoutes.home), child: const Text('b')),
    TextButton(onPressed: () => Navigator.pushNamed(context, AppRoutes.login), child: const Text('c')),
  ]));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical: tabCanonical, canonicalId: 'c_1_1' });
    expect(r.flags.some(f => f.code === 'push-into-hub')).toBe(false);
  });

  it('skips silently when the app has no shell (no tab edges)', async () => {
    await writeScreen('c_1_1', `
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold(body: TextButton(
    onPressed: () => Navigator.pushNamed(context, AppRoutes.home),
    child: const Text('Sign in')));
}`);
    const r = await reconcileScreen({ projectRoot: root, framework: 'flutter', canonical, canonicalId: 'c_1_1' });
    expect(r.flags.some(f => f.code === 'push-into-hub')).toBe(false);
  });
});
