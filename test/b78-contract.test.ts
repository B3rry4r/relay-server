// =============================================================================
// B78 readability — the prompt/skeleton side (F1, F6, F8, packet-level reuse, F4
// contract wording).
//
// Ping shipped 25 write-locked `SizedBox.shrink()` stubs (`cmp_<name>_<i>.dart`,
// class `<Name>Widget`) that nothing imported, while two prompt blocks named two
// different component paths and every screen re-implemented the UI privately.
// These tests pin: no stub is written, ONE path + class per component in both
// prompt blocks, what earlier screens built is fed forward, the theme rules are in
// the target framework's idiom, and comments/assets rules are in the contract.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { aiModelToCanonical } from '../src/relay-server/canonicalize-ai/to-canonical';
import { generateFlutterSkeleton, ensureFlutterSvgDependency, type Canonical } from '../src/relay-server/canonicalize';
import {
  componentClassName, componentContract, componentReuseBlock, scanBuiltComponents,
} from '../src/relay-server/component-contract';
import { buildWrittenContract, buildCanonicalContext, themeTokenRules } from '../src/relay-server/ai-screen-loop';
import { buildAgentPacket } from '../src/relay-server/agent-packet';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78-contract-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = async (rel: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
};

const canonical = (): Canonical => ({
  version: 1,
  screens: [
    { canonicalId: 'c_1', frameIds: ['1:1'], name: 'loginScreen', states: [{ id: 'default', frameId: '1:1' }], modals: [], role: 'screen', route: '/login' },
    { canonicalId: 'c_2', frameIds: ['1:2'], name: 'homeScreen', states: [{ id: 'default', frameId: '1:2' }], modals: [], role: 'screen', route: '/home' },
  ],
  components: [
    { id: 'cmp_primaryButton', frameId: '', name: 'primaryButton' },
    { id: 'cmp_backButton', frameId: '', name: 'backButton' },
  ],
  templates: [],
  flow: { entryCanonicalId: 'c_1', edges: [] },
  frameMap: { '1:1': 'c_1', '1:2': 'c_2' },
  warnings: [],
} as unknown as Canonical);

const run = (framework: string) => ({
  projectId: 'p', id: 'r', framework,
  screens: [
    { frameId: '1:1', frameName: 'Login', status: 'pending', spec: { tree: '', packet: '' } },
    { frameId: '1:2', frameName: 'Home', status: 'pending', spec: { tree: '', packet: '' } },
  ],
  flow: { entryFrameId: '1:1', connections: [] },
}) as any;

describe('F1: component ids and names carry no counters and never shadow the SDK', () => {
  it('to-canonical ids come from the name alone; a suffix only on a real collision', () => {
    const c = aiModelToCanonical({
      version: 1, projectId: 'p', figStorageKey: 'k', contentHash: 'h',
      screens: [], modals: [], templates: [], flow: { entryCanonicalId: null, edges: [] },
      components: [
        { canonicalName: 'avatar', kind: 'avatar' }, { canonicalName: 'badge', kind: 'badge' },
        { canonicalName: 'avatar', kind: 'avatar' },
      ],
    } as any);
    expect(c.components.map((x) => x.id)).toEqual(['cmp_avatar', 'cmp_badge', 'cmp_avatar_2']);
  });

  it('class names are Pascal(name); an SDK name gets an App prefix; paths per framework', () => {
    expect(componentClassName('primaryButton')).toBe('PrimaryButton');
    expect(componentClassName('backButton')).toBe('AppBackButton');       // Flutter's BackButton
    expect(componentClassName('Image', 'react')).toBe('AppImage');         // DOM Image / next/image
    expect(componentClassName('Card', 'react')).toBe('Card');
    expect(componentClassName('283:1967')).toBe('SharedComponent');
    expect(componentContract(canonical(), 'flutter').map((s) => s.file)).toEqual(['lib/components/primary_button.dart', 'lib/components/app_back_button.dart']);
    expect(componentContract(canonical(), 'react').map((s) => s.file)).toEqual(['src/components/PrimaryButton.tsx', 'src/components/BackButton.tsx']);
  });

  it('next under src/app puts components in src/components (CONTRACTS §5)', async () => {
    await write('package.json', JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } }));
    await write('src/app/page.tsx', 'export default function P() { return null; }\n');
    expect(componentContract(canonical(), 'next', root)[0].file).toBe('src/components/PrimaryButton.tsx');
  });
});

describe('F1 + F8: the Flutter skeleton writes no component stubs and guarantees flutter_svg', () => {
  it('no lib/components file is written; pubspec gains flutter_svg once', async () => {
    await write('pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n');
    const r = await generateFlutterSkeleton(root, canonical());
    const comps = await fs.readdir(path.join(root, 'lib', 'components')).catch(() => [] as string[]);
    expect(comps).toEqual([]);
    expect(r.files.some((f) => /components/.test(f))).toBe(false);
    const pub = await fs.readFile(path.join(root, 'pubspec.yaml'), 'utf8');
    expect(pub).toMatch(/^dependencies:\n {2}flutter:\n {4}sdk: flutter\n {2}flutter_svg: \^2/m);
    expect(await ensureFlutterSvgDependency(root)).toBe(false);   // idempotent
  });
});

describe('packet-level reuse: components earlier screens built are fed forward', () => {
  it('lists real on-disk components with their constructor, skips stubs, and the remaining slots', async () => {
    await write('lib/components/app_back_button.dart', `import 'package:flutter/material.dart';
class AppBackButton extends StatelessWidget {
  const AppBackButton({super.key, required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(onTap: onTap, child: const Icon(Icons.chevron_left));
}
`);
    await write('lib/components/cmp_other_17.dart', `// GENERATED SKELETON — shared component stub (write-locked API surface).
import 'package:flutter/material.dart';
class OtherWidget extends StatelessWidget {
  const OtherWidget({super.key});
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
`);
    const built = scanBuiltComponents(root, 'flutter');
    expect(built).toEqual([{ className: 'AppBackButton', file: 'lib/components/app_back_button.dart', signature: 'AppBackButton({required VoidCallback onTap})' }]);
    const block = componentReuseBlock(root, 'flutter', canonical());
    expect(block).toContain('ALREADY BUILT');
    expect(block).toContain('AppBackButton({required VoidCallback onTap})  — lib/components/app_back_button.dart');
    expect(block).toContain('PrimaryButton → lib/components/primary_button.dart');
    expect(block).not.toContain('AppBackButton → ');        // built → not "still to build"
    expect(block).not.toContain('OtherWidget');
  });

  it('web: exported components of the components dir, with their props', async () => {
    await write('src/components/PrimaryButton.tsx', "export function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {\n  return <button onClick={onClick}>{label}</button>;\n}\n");
    const block = componentReuseBlock(root, 'react', canonical());
    expect(block).toContain('PrimaryButton({ label, onClick }: { label: string; onClick: () => void })  — src/components/PrimaryButton.tsx');
    expect(block).toContain('BackButton → src/components/BackButton.tsx');
  });
});

describe('ONE authoritative component path in both prompt blocks', () => {
  for (const fw of ['flutter', 'react', 'next'] as const) {
    it(`${fw}: canonical context and written contract name the same file for every component`, () => {
      const c = canonical();
      const ctx = buildCanonicalContext(c, c.screens[0], undefined, fw, root);
      const contract = buildWrittenContract(run(fw), 'PLAN', '', true, c, root);
      for (const slot of componentContract(c, fw, root)) {
        expect(ctx).toContain(`${slot.className} (${slot.file})`);
        expect(contract).toContain(`${slot.className} → ${slot.file}`);
      }
      expect(ctx).not.toMatch(/Widget\b.*cmp_|cmp_\w+\.dart/);
      expect(contract).not.toMatch(/the FIRST screen that renders one CREATES it as a public widget in lib\/components\/<name>\.dart/);
    });
  }
});

describe('F4 wording + F6/F8 rules in the written contract', () => {
  it('web agents get web theme wording (never Dart), with the role/≥2-uses amendment rule', () => {
    for (const fw of ['react', 'next']) {
      const t = themeTokenRules(fw);
      expect(t).toContain('AppTheme.color.<role>');
      expect(t).toContain('Tailwind arbitrary value');
      expect(t).not.toMatch(/Color\(0x|TextStyle\(|lib\/theme\/app_theme\.dart/);
      expect(t).toContain('≥2 uses');
    }
    const fl = themeTokenRules('flutter');
    expect(fl).toContain('lib/theme/app_theme.dart');
    expect(fl).toContain('never with a counter');
  });

  it('every framework is told comments are behaviour-only and assets are never hand-drawn', () => {
    for (const fw of ['flutter', 'react', 'next']) {
      const contract = buildWrittenContract(run(fw), 'PLAN', '', true, canonical(), root);
      expect(contract).toContain('NEVER provenance');
      expect(contract).toContain('no frame numbers');
      expect(contract).toContain('canonicalId:');
      expect(contract).toMatch(fw === 'flutter' ? /CustomPainter/ : /inline <svg>/);
    }
  });

  it('the packet frames "exact values" through tokens and forbids copying IR names; flutter packet names flutter_svg', () => {
    const packet = buildAgentPacket({
      frame: { id: '1:1', name: 'Login', width: 375, height: 812 }, frames: [{ id: '1:1', name: 'Login', width: 375, height: 812 }],
      framework: 'flutter', frameworkLabel: 'Flutter', flowGraph: { entryFrameId: '1:1', connections: [] }, tree: 'frame "Login"', refImagePath: '.uix/refs/1.png', assetCount: 3, bootstrapped: false,
    } as any);
    expect(packet).toContain('expressed through the generated theme tokens');
    expect(packet).toContain('never copy them into identifiers or comments');
    expect(packet).toContain('flutter_svg is already in pubspec.yaml');
  });
});
