// =============================================================================
// B78 readability F2 — component extraction (7a) is correct.
//
// On the real Ping output 7a crashed (schema mismatch), then — once null-safe —
// matched every group onto the first canonical component (empty-name match), wrote
// two different groups to lib/components/back_button.dart, shadowed Flutter's
// BackButton, lifted two public SCREENS as a "component", named parameters p0/p1,
// and bailed on _BottomNav (a helper method) and _PasscodeDots (a private sibling).
// =============================================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractComponents, normalizeCanonicalComponents, candidateNames, classExtraMembers } from '../src/relay-server/passes/component-extraction';

describe('F2 naming', () => {
  it('reads both canonical shapes and drops nameless entries', () => {
    expect(normalizeCanonicalComponents({ components: [
      { canonicalName: 'pinField', kind: 'input' },
      { id: 'cmp_primaryButton', frameId: '1:2', name: 'primaryButton' },
      { id: 'cmp_x', frameId: '1:3', name: '' },
      { canonicalName: '' },
    ] })).toEqual([{ canonicalName: 'pinField', kind: 'input' }, { canonicalName: 'primaryButton', kind: '' }]);
  });

  it('never matches on an empty name; a generic canonical never overrides a specific local name; SDK names get App', () => {
    const canonical = [{ canonicalName: 'button', kind: 'button' }, { canonicalName: 'pinField', kind: 'input' }];
    expect(candidateNames([{ localName: '_LinkBankButton' }, { localName: '_LinkBankButton' }], canonical, 'flutter')[0]).toBe('LinkBankButton');
    expect(candidateNames([{ localName: '_Pin' }, { localName: '_Pin' }], canonical, 'flutter')[0]).toBe('PinField');
    expect(candidateNames([{ localName: '_BackButton' }], [], 'flutter')[0]).toBe('AppBackButton');
    expect(candidateNames([{ localName: 'Fragment' }], [], 'react')[0]).toBe('AppFragment');
    expect(candidateNames([{ localName: '_X' }], [{ canonicalName: '', kind: '' }], 'flutter')[0]).toBe('X');
  });

  it('classExtraMembers keeps helpers, drops ctor/fields/build', () => {
    const src = `class _Nav extends StatelessWidget {\n  const _Nav({required this.onTap});\n  final VoidCallback onTap;\n\n  @override\n  Widget build(BuildContext context) {\n    return _tap(onTap);\n  }\n\n  Widget _tap(VoidCallback f) => GestureDetector(onTap: f);\n}`;
    expect(classExtraMembers(src, '_Nav')).toEqual(['Widget _tap(VoidCallback f) => GestureDetector(onTap: f);']);
  });
});

const PUB = 'name: t\ndependencies:\n  flutter:\n    sdk: flutter\n';
const THEME = `import 'package:flutter/material.dart';\nclass AppTheme {\n  AppTheme._();\n  static const Color ink = Color(0xFF000000);\n  static const Color surface = Color(0xFFFFFFFF);\n  static TextStyle title(Color c) => TextStyle(color: c);\n  static TextStyle body(Color c) => TextStyle(color: c, fontSize: 12);\n}\n`;

function screen(n: number, body: string): string {
  return `import 'package:flutter/material.dart';\nimport '../theme/app_theme.dart';\n\nclass Screen${n} extends StatelessWidget {\n  const Screen${n}({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return Column(children: [const _BackButton(), _Nav(onTap: () {}), const _PasscodeDots(count: 4), _Label(style: AppTheme.${n === 1 ? 'title' : 'body'}(AppTheme.ink)), const _Blink()]);\n  }\n}\n\n${body}`;
}

const SHARED = (variant: number): string => `class _BackButton extends StatelessWidget {
  const _BackButton();
  @override
  Widget build(BuildContext context) {
    return SizedBox(width: 24, height: 24, child: Icon(Icons.arrow_back, color: AppTheme.ink));
  }
}

class _Nav extends StatelessWidget {
  const _Nav({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    return Row(children: [_tap(onTap), _tap(onTap)]);
  }

  Widget _tap(VoidCallback f) => GestureDetector(onTap: f, child: const SizedBox(width: 10));
}

class _PasscodeDots extends StatelessWidget {
  const _PasscodeDots({required this.count});
  final int count;
  @override
  Widget build(BuildContext context) {
    return Row(children: [for (int i = 0; i < count; i++) const _Dot()]);
  }
}

class _Dot extends StatelessWidget {
  const _Dot();
  @override
  Widget build(BuildContext context) {
    return Container(width: 12, height: 12, color: AppTheme.ink);
  }
}

class _Label extends StatelessWidget {
  const _Label({required this.style});
  final TextStyle style;
  @override
  Widget build(BuildContext context) {
    return Text('Hi', style: TextStyle(color: AppTheme.${variant === 1 ? 'ink' : 'surface'}));
  }
}

class _Blink extends StatefulWidget {
  const _Blink();
  @override
  State<_Blink> createState() => _BlinkState();
}

class _BlinkState extends State<_Blink> {
  bool on = false;
  @override
  Widget build(BuildContext context) {
    return GestureDetector(onTap: () => setState(() => on = !on), child: Text(on ? 'on' : 'off'));
  }
}
`;

async function app(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78-x-'));
  await fs.writeFile(path.join(root, 'pubspec.yaml'), PUB);
  await fs.mkdir(path.join(root, 'lib', 'theme'), { recursive: true });
  await fs.mkdir(path.join(root, 'lib', 'screens'), { recursive: true });
  await fs.writeFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), THEME);
  await fs.writeFile(path.join(root, 'lib', 'screens', 'screen1.dart'), screen(1, SHARED(1)));
  await fs.writeFile(path.join(root, 'lib', 'screens', 'screen2.dart'), screen(2, SHARED(2)));
  // a public screen class duplicated across two files is NOT a component
  const pub = (n: number) => `import 'package:flutter/material.dart';\nclass WelcomeScreen extends StatelessWidget {\n  const WelcomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return const Text('Welcome ${n}');\n  }\n}\n`;
  await fs.writeFile(path.join(root, 'lib', 'screens', 'welcome_a.dart'), pub(1));
  await fs.writeFile(path.join(root, 'lib', 'screens', 'welcome_b.dart'), pub(2));
  // an agent-built component occupies the natural name of one group
  await fs.mkdir(path.join(root, 'lib', 'components'), { recursive: true });
  await fs.writeFile(path.join(root, 'lib', 'components', 'label.dart'), "import 'package:flutter/material.dart';\nclass Label extends StatelessWidget {\n  const Label({super.key});\n  @override\n  Widget build(BuildContext context) => const Text('agent-built');\n}\n");
  return root;
}

describe('F2 flutter extraction on a real run', () => {
  it('lifts private widgets only, SDK-safe + unique names, helpers carried, siblings retried, stateful pairs, typed params', async () => {
    const root = await app();
    try {
      const r = await extractComponents('t', { projectRoot: root, noAiConfirm: true });
      const byName = Object.fromEntries(r.extracted.map((e) => [e.name, e]));
      expect(Object.keys(byName).sort()).toEqual(['AppBackButton', 'Blink', 'Dot', 'Nav', 'PasscodeDots'].sort());
      // no public class lifted
      expect(r.extracted.some((e) => e.fromPrivateNames.includes('WelcomeScreen'))).toBe(false);
      // unique targets
      const paths = r.extracted.map((e) => e.componentPath);
      expect(new Set(paths).size).toBe(paths.length);
      // _Label: its natural name `Label` is taken by an agent-built component → rejected with a reason, never overwritten
      expect(await fs.readFile(path.join(root, 'lib', 'components', 'label.dart'), 'utf8')).toMatch(/agent-built/);
      expect(r.rejected.find((x) => x.names.includes('_Label'))?.reason).toMatch(/already a component\/class/);
      // helper method travels with the widget
      const nav = await fs.readFile(path.join(root, byName.Nav.componentPath), 'utf8');
      expect(nav).toMatch(/Widget _tap\(VoidCallback f\) => GestureDetector/);
      // _PasscodeDots was retried after _Dot was lifted: it uses the shared Dot
      const dots = await fs.readFile(path.join(root, byName.PasscodeDots.componentPath), 'utf8');
      expect(dots).toMatch(/const Dot\(\)/);
      expect(dots).toMatch(/import 'dot\.dart';|import '\.\.\/components\/dot\.dart';|import '\.\/dot\.dart';/);
      // the identical stateful pair is lifted with its State class
      const blink = await fs.readFile(path.join(root, byName.Blink.componentPath), 'utf8');
      expect(blink).toMatch(/class Blink extends StatefulWidget/);
      expect(blink).toMatch(/class _BlinkState extends State<Blink>/);
      // screens import and use them; no private copies left
      for (const f of ['screen1.dart', 'screen2.dart']) {
        const s = await fs.readFile(path.join(root, 'lib', 'screens', f), 'utf8');
        expect(s).not.toMatch(/class _(BackButton|Nav|PasscodeDots|Dot|Blink)\b/);
        expect(s).toMatch(/const AppBackButton\(\)/);
        expect(s).toMatch(/import '\.\.\/components\/app_back_button\.dart';/);
      }
      // no p0-style parameter anywhere
      for (const e of r.extracted) expect(e.parameterizedFields.filter((p) => /^p\d+$/.test(p))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('a parameter fed by a theme text-style call is typed TextStyle, not Color', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78-x2-'));
    try {
      await fs.writeFile(path.join(root, 'pubspec.yaml'), PUB);
      await fs.mkdir(path.join(root, 'lib', 'theme'), { recursive: true });
      await fs.mkdir(path.join(root, 'lib', 'screens'), { recursive: true });
      await fs.writeFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), THEME);
      const btn = (style: string) => `import 'package:flutter/material.dart';\nimport '../theme/app_theme.dart';\nclass S extends StatelessWidget {\n  const S({super.key});\n  @override\n  Widget build(BuildContext context) => const _Cta();\n}\nclass _Cta extends StatelessWidget {\n  const _Cta();\n  @override\n  Widget build(BuildContext context) {\n    return Text('Go', style: ${style});\n  }\n}\n`;
      await fs.writeFile(path.join(root, 'lib', 'screens', 'a.dart'), btn('AppTheme.title(AppTheme.surface)'));
      await fs.writeFile(path.join(root, 'lib', 'screens', 'b.dart'), btn('AppTheme.body(AppTheme.surface)'));
      const r = await extractComponents('t', { projectRoot: root, noAiConfirm: true });
      expect(r.extracted.map((e) => e.name)).toEqual(['Cta']);
      const cta = await fs.readFile(path.join(root, r.extracted[0].componentPath), 'utf8');
      expect(cta).toMatch(/final TextStyle style;/);
      expect(fsSync.readFileSync(path.join(root, 'lib', 'screens', 'a.dart'), 'utf8')).toMatch(/Cta\(style: AppTheme\.title\(AppTheme\.surface\)\)/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('F2 web: a hoisted component takes its own leading comment along', () => {
  it('the comment moves into the component file and no orphan is left in the screens', async () => {
    const { leadingLineComments } = await import('../src/relay-server/passes/component-extraction-web');
    const src = "// canonicalId: c_1\nimport x from 'y';\n\n// Avatar row — shows the signed-in user.\n// Second line.\nfunction UserChip() {\n  return <div />;\n}\n";
    const at = src.indexOf('function UserChip');
    expect(leadingLineComments(src, at)).toBe('// Avatar row — shows the signed-in user.\n// Second line.\n');
    const hdr = "// canonicalId: c_1\nfunction A() {}\n";
    expect(leadingLineComments(hdr, hdr.indexOf('function A'))).toBe('');
    const blank = "// unrelated\n\nfunction B() {}\n";
    expect(leadingLineComments(blank, blank.indexOf('function B'))).toBe('');
  });
});
