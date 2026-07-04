// =============================================================================
// P2 — flow-wiring verb/tab/step-modal conformance over a real on-disk fixture.
//
//   1. kind 'replace': the matched nav call must be a REPLACEMENT verb —
//      a plain pushNamed grades `wrong-verb` (med, not auto-fixed);
//      pushReplacementNamed / pushNamedAndRemoveUntil grade `wired`.
//   2. kind 'tab': wired ONLY when app_shell.dart hosts the destination class;
//      a pushNamed to the tab route grades `tab-as-push` (high).
//   3. viaModal edges: wired requires the P1-core presenter call-site
//      (showModal_<idCore>) in the base's file AND the nav call; navigating
//      directly with no presenter grades `missing-step-presenter`.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { verifyFlowWiring } from '../src/relay-server/passes/flow-wiring';

let root: string;

const screenFile = (id: string, route: string, cls: string, body: string) => `// canonicalId: ${id}  route: ${route}
import 'package:flutter/material.dart';
import '../app_routes.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});
  @override
  Widget build(BuildContext context) {
${body}
    return const Scaffold(body: SizedBox());
  }
}
`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-fw-'));
  await fs.mkdir(path.join(root, 'lib', 'screens'), { recursive: true });
  await fs.mkdir(path.join(root, '.uix'), { recursive: true });
  await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: fixture\n');

  await fs.writeFile(path.join(root, 'lib', 'app_routes.dart'), `class AppRoutes {
  static const String splash = '/splash';
  static const String home = '/home';
  static const String scan = '/scan';
  static const String history = '/history';
  static const String welcome = '/welcome';
  static const String qr = '/qr';
  static const String selectBank = '/select-bank';
}
`);

  // splash: 'replace' edge to home implemented with a PLAIN pushNamed → wrong-verb.
  await fs.writeFile(path.join(root, 'lib', 'screens', 'splash_screen.dart'),
    screenFile('c_splash', '/splash', 'SplashScreen',
      `    Navigator.pushNamed(context, AppRoutes.home);`));
  // welcome: 'replace' edge to home with pushReplacementNamed → wired.
  await fs.writeFile(path.join(root, 'lib', 'screens', 'welcome_screen.dart'),
    screenFile('c_welcome', '/welcome', 'WelcomeScreen',
      `    Navigator.pushReplacementNamed(context, AppRoutes.home);`));
  // home: hub. Pushes the scan tab route (tab-as-push) — history is shell-hosted.
  await fs.writeFile(path.join(root, 'lib', 'screens', 'home_screen.dart'),
    screenFile('c_home', '/home', 'HomeScreen',
      `    Navigator.pushNamed(context, AppRoutes.scan);`));
  await fs.writeFile(path.join(root, 'lib', 'screens', 'scan_screen.dart'),
    screenFile('c_scan', '/scan', 'ScanScreen',
      `    // Selected-Bank sheet presenter (P1-core contract) + its confirm nav.
    Navigator.pushNamed(context, AppRoutes.qr);
    showModal_9_9(context);`));
  await fs.writeFile(path.join(root, 'lib', 'screens', 'history_screen.dart'),
    screenFile('c_history', '/history', 'HistoryScreen', `    // static`));
  // selectBank: viaModal edge to qr, navigates DIRECTLY, presenter absent.
  await fs.writeFile(path.join(root, 'lib', 'screens', 'select_bank_screen.dart'),
    screenFile('c_selectbank', '/select-bank', 'SelectBankScreen',
      `    Navigator.pushNamed(context, AppRoutes.qr);`));
  await fs.writeFile(path.join(root, 'lib', 'screens', 'qr_screen.dart'),
    screenFile('c_qr', '/qr', 'QrScreen', `    // leaf`));

  // App shell hosting HistoryScreen (but NOT ScanScreen — its tab edge is a push).
  await fs.writeFile(path.join(root, 'lib', 'screens', 'app_shell.dart'), `// GENERATED SKELETON — write-locked APP SHELL (tab cluster host).
import 'package:flutter/material.dart';
import 'home_screen.dart';
import 'history_screen.dart';

class AppShell extends StatefulWidget {
  const AppShell({super.key, this.initialIndex = 0});
  final int initialIndex;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  late int _index = widget.initialIndex;
  @override
  Widget build(BuildContext context) {
    return Scaffold(body: IndexedStack(index: _index, children: <Widget>[HomeScreen(), HistoryScreen()]));
  }
}
`);

  const canonical = {
    version: 1,
    projectId: 'p2-fixture',
    contentHash: 'p2hash',
    screens: [
      { canonicalId: 'c_splash', name: 'splashScreen', route: '/splash', frameIds: ['9:1'], states: [{ id: 'default', frameId: '9:1' }], modals: [], role: 'screen' },
      { canonicalId: 'c_welcome', name: 'welcomeScreen', route: '/welcome', frameIds: ['9:2'], states: [{ id: 'default', frameId: '9:2' }], modals: [], role: 'screen' },
      { canonicalId: 'c_home', name: 'homeScreen', route: '/home', frameIds: ['9:3'], states: [{ id: 'default', frameId: '9:3' }], modals: [], role: 'screen' },
      { canonicalId: 'c_scan', name: 'scanScreen', route: '/scan', frameIds: ['9:4'], states: [{ id: 'default', frameId: '9:4' }], modals: [{ id: 'm_9_9', frameId: '9:9', baseCanonicalId: 'c_scan' }], role: 'screen' },
      { canonicalId: 'c_history', name: 'historyScreen', route: '/history', frameIds: ['9:5'], states: [{ id: 'default', frameId: '9:5' }], modals: [], role: 'screen' },
      { canonicalId: 'c_selectbank', name: 'selectBankScreen', route: '/select-bank', frameIds: ['9:6'], states: [{ id: 'default', frameId: '9:6' }], modals: [{ id: 'm_9_10', frameId: '9:10', baseCanonicalId: 'c_selectbank' }], role: 'screen' },
      { canonicalId: 'c_qr', name: 'qrScreen', route: '/qr', frameIds: ['9:7'], states: [{ id: 'default', frameId: '9:7' }], modals: [], role: 'screen' },
    ],
    components: [],
    templates: [],
    flow: {
      entryCanonicalId: 'c_splash',
      edges: [
        { fromCanonicalId: 'c_splash', toCanonicalId: 'c_home', kind: 'replace', label: 'Boot' },
        { fromCanonicalId: 'c_welcome', toCanonicalId: 'c_home', kind: 'replace', label: 'Enter' },
        { fromCanonicalId: 'c_home', toCanonicalId: 'c_scan', kind: 'tab', label: 'Scan tab' },
        { fromCanonicalId: 'c_home', toCanonicalId: 'c_history', kind: 'tab', label: 'History tab' },
        { fromCanonicalId: 'c_scan', toCanonicalId: 'c_qr', kind: 'push', label: 'Confirm', viaModalId: 'm_9_9' },
        { fromCanonicalId: 'c_selectbank', toCanonicalId: 'c_qr', kind: 'push', label: 'Confirm', viaModalId: 'm_9_10' },
      ],
    },
    frameMap: {},
    warnings: [],
  };
  await fs.writeFile(path.join(root, '.uix', 'canonical.json'), JSON.stringify(canonical, null, 2));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('P2 flow-wiring conformance', () => {
  it('grades verb/tab/presenter conformance per edge', async () => {
    const { report } = await verifyFlowWiring('p2-fixture', {
      projectRoot: root, noAi: true, noAutoFix: true, noReport: true,
    });
    const by = (from: string, to: string) => report.findings.find(f => f.from === from && f.to === to)!;

    // 1. replace via plain pushNamed → wrong-verb (med, not auto-fixed).
    const wrongVerb = by('c_splash', 'c_home');
    expect(wrongVerb.status).toBe('wrong-verb');
    expect(wrongVerb.autoFixed).toBeUndefined();
    expect(wrongVerb.detail).toContain('pushNamed');

    // 1b. replace via pushReplacementNamed → wired (verb conforms).
    expect(by('c_welcome', 'c_home').status).toBe('wired');

    // 2. tab destination NOT hosted in the shell, pushed instead → tab-as-push (high).
    const tabPush = by('c_home', 'c_scan');
    expect(tabPush.status).toBe('tab-as-push');
    expect(tabPush.detail).toContain('HIGH');

    // 2b. tab destination hosted in app_shell.dart → wired (no nav call needed).
    const hosted = by('c_home', 'c_history');
    expect(hosted.status).toBe('wired');
    expect(hosted.detail).toContain('AppShell');

    // 3. viaModal edge with presenter call-site + nav → wired.
    const stepOk = by('c_scan', 'c_qr');
    expect(stepOk.status).toBe('wired');
    expect(stepOk.detail).toContain('showModal_9_9');

    // 3b. viaModal edge navigating directly with NO presenter → missing-step-presenter.
    const stepMissing = by('c_selectbank', 'c_qr');
    expect(stepMissing.status).toBe('missing-step-presenter');
    expect(stepMissing.detail).toContain('showModal_9_10');

    // summary counts the new statuses.
    expect(report.summary.wrongVerb).toBe(1);
    expect(report.summary.tabAsPush).toBe(1);
    expect(report.summary.missingStepPresenter).toBe(1);
  });
});
