// =============================================================================
// P2 — app shell for tab clusters + step-modal/replace prompt plumbing.
//
//   1. computeTabCluster: hub = the tab-edge source that is not itself a tab
//      destination; members = hub + the hub's own tab destinations (hub-first,
//      edge order). Tab edges from a NON-hub screen never enlarge the shell.
//   2. generateFlutterSkeleton emits a write-locked lib/screens/app_shell.dart
//      (IndexedStack over all tab classes + ONE shared bottom nav) and the router
//      returns AppShell(initialIndex: i) for each tab route (route names intact).
//   3. buildAppPlan renders viaModal provenance + the preserved 'replace' kind
//      from the canonical flow.
//   4. aiModelToCanonical carries viaModalId across the adapter.
//   5. buildCanonicalContext tells a TAB screen it is hosted (no own bottom nav).
// =============================================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  computeTabCluster, generateFlutterSkeleton, type Canonical, type CanonicalScreen,
} from '../src/relay-server/canonicalize';
import { buildAppPlan, buildCanonicalContext } from '../src/relay-server/ai-screen-loop';
import { aiModelToCanonical } from '../src/relay-server/canonicalize-ai/to-canonical';
import type { CanonicalModel } from '../src/relay-server/canonicalize-ai/reduce';

function screen(canonicalId: string, frameId: string, name: string): CanonicalScreen {
  return {
    canonicalId, frameIds: [frameId], name,
    states: [{ id: 'default', frameId }], modals: [], role: 'screen', route: '',
  };
}

/** 4-tab fixture: home (hub) + scan/history/settings; scan has its own tab edge
 *  to a deeper mode (must NOT enter the shell); splash replaces into home. */
function tabCanonical(): Canonical {
  const screens = [
    screen('c_1', '1:1', 'homeDashboard'),
    screen('c_2', '1:2', 'scanAndPayScreen'),
    screen('c_3', '1:3', 'transactionHistoryScreen'),
    screen('c_4', '1:4', 'settingsScreen'),
    screen('c_5', '1:5', 'selectBankScreen'),
    screen('c_6', '1:6', 'splashScreen'),
  ];
  return {
    version: 1,
    screens,
    components: [],
    templates: [],
    flow: {
      entryCanonicalId: 'c_6',
      edges: [
        { fromCanonicalId: 'c_1', toCanonicalId: 'c_2', kind: 'tab', label: 'Scan tab' },
        { fromCanonicalId: 'c_1', toCanonicalId: 'c_3', kind: 'tab', label: 'History tab' },
        { fromCanonicalId: 'c_1', toCanonicalId: 'c_4', kind: 'tab', label: 'Settings tab' },
        { fromCanonicalId: 'c_2', toCanonicalId: 'c_5', kind: 'tab', label: 'Scan QR' },
        { fromCanonicalId: 'c_6', toCanonicalId: 'c_1', kind: 'replace', label: 'Boot' },
      ],
    },
    frameMap: { '1:1': 'c_1', '1:2': 'c_2', '1:3': 'c_3', '1:4': 'c_4', '1:5': 'c_5', '1:6': 'c_6' },
    warnings: [],
  };
}

describe('P2 computeTabCluster', () => {
  it('picks the non-destination source as hub and only the hub tab edges as members', () => {
    const cluster = computeTabCluster(tabCanonical())!;
    expect(cluster).toBeTruthy();
    expect(cluster.hubId).toBe('c_1');
    expect(cluster.memberIds).toEqual(['c_1', 'c_2', 'c_3', 'c_4']);   // hub-first, edge order; c_5 excluded
  });

  it('returns null when there are no tab edges', () => {
    const c = tabCanonical();
    c.flow.edges = c.flow.edges.filter(e => e.kind !== 'tab');
    expect(computeTabCluster(c)).toBeNull();
  });
});

describe('P2 generateFlutterSkeleton app shell', () => {
  it('emits app_shell.dart (IndexedStack over all 4 tab classes) and AppShell router cases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-shell-'));
    try {
      const canonical = tabCanonical();
      const sk = await generateFlutterSkeleton(root, canonical);
      expect(sk.tabCluster?.memberIds).toEqual(['c_1', 'c_2', 'c_3', 'c_4']);

      const shell = await fs.readFile(path.join(root, 'lib', 'screens', 'app_shell.dart'), 'utf8');
      expect(shell).toContain('class AppShell extends StatefulWidget');
      expect(shell).toContain('final int initialIndex;');
      expect(shell).toContain('IndexedStack(');
      for (const cls of ['HomeDashboardScreen', 'ScanAndPayScreen', 'TransactionHistoryScreen', 'SettingsScreen']) {
        expect(shell, `shell hosts ${cls}`).toContain(`${cls}()`);
      }
      // ONE shared bottom nav; taps only switch the IndexedStack index.
      expect(shell).toContain('class AppShellBottomNav extends StatelessWidget');
      expect(shell).toContain('BottomNavigationBar(');
      expect(shell).toContain('setState(() => _index = i)');
      expect(shell).toMatch(/GENERATED SKELETON — write-locked/);

      // Router: tab routes → AppShell(initialIndex: i); route names unchanged;
      // non-tab screens keep their own builders.
      const router = await fs.readFile(path.join(root, 'lib', 'app_router.dart'), 'utf8');
      const routeOf = (id: string) => sk.routes.find(r => r.canonicalId === id)!.route;
      expect(router).toContain(`case '${routeOf('c_1')}': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 0));`);
      expect(router).toContain(`case '${routeOf('c_2')}': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 1));`);
      expect(router).toContain(`case '${routeOf('c_3')}': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 2));`);
      expect(router).toContain(`case '${routeOf('c_4')}': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 3));`);
      expect(router).toContain(`import 'screens/app_shell.dart';`);
      // Non-tab screen (selectBank) still routes to its own widget.
      expect(router).toMatch(new RegExp(`case '${routeOf('c_5')}': return MaterialPageRoute\\(builder: \\(_\\) => const SelectBankScreen\\(\\)\\);`));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('emits no shell (and plain router cases) when the flow has no tab edges', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-noshell-'));
    try {
      const canonical = tabCanonical();
      canonical.flow.edges = canonical.flow.edges.filter(e => e.kind !== 'tab');
      const sk = await generateFlutterSkeleton(root, canonical);
      expect(sk.tabCluster).toBeUndefined();
      await expect(fs.access(path.join(root, 'lib', 'screens', 'app_shell.dart'))).rejects.toThrow();
      const router = await fs.readFile(path.join(root, 'lib', 'app_router.dart'), 'utf8');
      expect(router).not.toContain('AppShell');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('P2 buildAppPlan (canonical nav graph)', () => {
  it('renders viaModal provenance and the preserved replace kind', () => {
    const canonical: Canonical = {
      version: 1,
      screens: [
        { ...screen('c_a', '2:1', 'selectBankScreen'), modals: [{ id: 'm_2_9', frameId: '2:9', baseCanonicalId: 'c_a' }] },
        screen('c_b', '2:2', 'qrScreen'),
        screen('c_c', '2:3', 'splashScreen'),
      ],
      components: [],
      templates: [],
      flow: {
        entryCanonicalId: 'c_c',
        edges: [
          { fromCanonicalId: 'c_c', toCanonicalId: 'c_a', kind: 'replace', label: 'Boot' },
          { fromCanonicalId: 'c_a', toCanonicalId: 'c_b', kind: 'push', label: 'Confirm', viaModalId: 'm_2_9' },
        ],
      },
      frameMap: { '2:1': 'c_a', '2:2': 'c_b', '2:3': 'c_c', '2:9': 'm_2_9' },
      warnings: [],
    };
    const run = {
      screens: [
        { frameId: '2:1', frameName: 'selectBankScreen', status: 'pending', spec: { tree: '', packet: '' } },
        { frameId: '2:2', frameName: 'qrScreen', status: 'pending', spec: { tree: '', packet: '' } },
        { frameId: '2:3', frameName: 'splashScreen', status: 'pending', spec: { tree: '', packet: '' } },
        { frameId: '2:9', frameName: 'Selected Bank', status: 'pending', spec: { tree: '', packet: '' } },
      ],
      flow: {
        entryFrameId: '2:3',
        connections: [
          { from: '2:3', to: '2:1', type: 'replace', label: 'Boot' },
          { from: '2:9', to: '2:2', type: 'push', label: 'Confirm' },
        ],
      },
    } as any;
    const plan = buildAppPlan(run, canonical);
    expect(plan).toContain(`- "selectBankScreen" --(push "Confirm")--> "qrScreen"  [FROM INSIDE the 'Selected Bank' sheet — the sheet's confirm action navigates; the base screen must NOT skip the sheet]`);
    expect(plan).toContain(`- "splashScreen" --(replace "Boot")--> "selectBankScreen"`);
  });
});

describe('P2 aiModelToCanonical viaModalId pass-through', () => {
  it('carries viaModalId onto the build edge', () => {
    const model: CanonicalModel = {
      version: 1, projectId: 'p', figStorageKey: 'f.fig', contentHash: 'h',
      screens: [
        { canonicalId: 'c_a', name: 'a', route: '/a', role: 'screen', frameIds: ['3:1'], states: [{ id: 'default', frameId: '3:1', brief: 'a' }] },
        { canonicalId: 'c_b', name: 'b', route: '/b', role: 'screen', frameIds: ['3:2'], states: [{ id: 'default', frameId: '3:2', brief: 'b' }] },
      ],
      modals: [{ canonicalId: 'm_3_9', name: 'sheet', frameId: '3:9', baseCanonicalId: 'c_a', trigger: { fromScreen: 'c_a', edgeType: 'modal' } }],
      templates: [], components: [],
      flow: {
        entryCanonicalId: 'c_a',
        edges: [{ from: 'c_a', to: 'c_b', kind: 'push', viaModalId: 'm_3_9', label: 'Confirm' }],
      },
      warnings: [],
    };
    const built = aiModelToCanonical(model);
    expect(built.flow.edges).toHaveLength(1);
    expect(built.flow.edges[0].viaModalId).toBe('m_3_9');
    expect(built.flow.edges[0].kind).toBe('push');
  });
});

describe('P2 buildCanonicalContext tab hosting', () => {
  it('tells a tab-cluster screen it is hosted in AppShell (no own bottom nav, never push a tab route)', () => {
    const canonical = tabCanonical();
    const cs = canonical.screens.find(s => s.canonicalId === 'c_2')!;
    const ctx = buildCanonicalContext(canonical, cs);
    expect(ctx).toContain('hosted inside AppShell');
    expect(ctx).toContain('Do NOT render your own bottom navigation bar');
    expect(ctx).toContain('Never Navigator.push a tab route');
  });

  it('says nothing about the shell for a non-tab screen', () => {
    const canonical = tabCanonical();
    const cs = canonical.screens.find(s => s.canonicalId === 'c_5')!;
    const ctx = buildCanonicalContext(canonical, cs);
    expect(ctx).not.toContain('hosted inside AppShell');
  });
});
