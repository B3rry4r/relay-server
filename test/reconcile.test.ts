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
  void go() => Navigator.pushNamed(context, AppRoutes.c12);
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
});
