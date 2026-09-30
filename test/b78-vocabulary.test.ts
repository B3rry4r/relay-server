// =============================================================================
// B78 readability F4 + F5 — the token vocabulary comes from the design, and 7f
// widens its substitutions to the positions Ping's literals actually sat in.
//
// Ping (real run): 47 colour tokens / 19 single-use / 54 near-duplicate pairs /
// `neutral1..4` + `ink2..3` counters, and 317 layout literals — 270 of them
// width/height/size values no token covered, the rest pills and sheet corners.
// =============================================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planColorVocabulary, measureDesign, planDesignScales, rgbDistance, parseHexColor, NEAR_DUPLICATE_DISTANCE } from '../src/relay-server/design-vocabulary';
import { planThemeTokens, generateDesignSystem } from '../src/relay-server/design-system';
import { deepenTokensAndCleanup } from '../src/relay-server/passes/token-cleanup';
import { scanVocabSites } from '../src/relay-server/passes/token-vocabulary';
import { isConstExpr, promoteConst } from '../src/relay-server/passes/dart-const';

const COUNTER = /^(?:ink|neutral|accent|color|grey|gray|surface)\d+$/;

describe('F4 colour vocabulary', () => {
  // Ping's real design colours (a subset, with their IR use counts).
  const uses: Array<[string, number]> = [
    ['#12ae89', 60], ['#000000', 40], ['#ffffff', 38], ['#2a2a2a', 30], ['#161618', 12], ['#121212', 9],
    ['#a4a9ae', 8], ['#5e5e5e', 8], ['#d9d9d9', 7], ['#f8f8f8', 6], ['#f9f9f9', 3], ['#009717', 3],
    ['#80ff93', 2], ['#ff3b30', 2], ['#65bfcb', 1],
  ];
  const plan = planColorVocabulary(uses, { minUses: 2 });

  it('merges near-duplicates (RGB distance < 16) into the more-used colour, and says so', () => {
    const hexes = plan.colors.map((c) => c.hex);
    for (let i = 0; i < hexes.length; i++) for (let j = i + 1; j < hexes.length; j++) {
      expect(rgbDistance(parseHexColor(hexes[i])!, parseHexColor(hexes[j])!)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_DISTANCE);
    }
    expect(plan.merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ hex: '#121212' }),
      expect.objectContaining({ hex: '#f8f8f8', into: 'surface' }),
    ]));
  });

  it('names by role, never by counter; a one-off colour gets no token', () => {
    const names = plan.colors.map((c) => c.name);
    expect(names.filter((n) => COUNTER.test(n))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['brand', 'surface', 'textPrimary', 'textSecondary', 'danger']));
    expect(plan.colors.find((c) => c.hex === '#65bfcb')).toBeUndefined();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('F4 design scales from the IR', () => {
  const ir = [
    'container "Screen" [393×852] bg:#ffffff',
    '├── container "Frame 1" [338×47] bg:#12ae89 radius:23.5 flex:row justify:center align:center gap:10 pad:13,140,12,140',
    '├── container "Frame 2" [338×47] bg:#ffffff border:1px #12ae89 radius:23.5 flex:row justify:center align:center gap:10 pad:13,98,12,98',
    '├── container "Card" [349×120] bg:#f2f2f2 radius:14 gap:10 pad:16',
    '├── container "Card 2" [349×120] bg:#f2f2f2 radius:14 gap:10 pad:16',
    '├── icon "chevron" [24×24] → assets/icons/chevron.svg',
    '├── icon "bell" [24×24] → assets/icons/bell.svg',
    '├── icon "dot" [16×16] → assets/icons/dot.svg',
    '├── icon "dot2" [16×16] → assets/icons/dot.svg',
    '└── container "Avatar" [40×40] radius:20',
    'container "Avatar2" [40×40] radius:20',
  ];
  const scales = planDesignScales(measureDesign([ir.join('\n')]));

  it('spacing = standard scale + design values used ≥3×; radius = standard + design radii used ≥2×', () => {
    expect(scales.spacing).toEqual(expect.arrayContaining([4, 8, 10, 16]));
    expect(scales.radius).toEqual(expect.arrayContaining([14]));
    expect(scales.radius).not.toContain(23.5);
    expect(scales.pill).toBe(true);
  });

  it('role-named sizes: icons on a ladder, avatars, the dominant button height', () => {
    const byName = Object.fromEntries(scales.sizes.map((z) => [z.name, z.value]));
    expect(byName).toMatchObject({ buttonHeight: 47, avatar: 40 });
    expect(Object.keys(byName).filter((n) => n.startsWith('icon')).sort()).toEqual(['iconLg', 'iconMd']);
    expect(byName.iconMd).toBe(16); expect(byName.iconLg).toBe(24);
  });

  it('flutter + react + next themes render the same vocabulary', async () => {
    const t = planThemeTokens({ colors: [], fonts: ['Inter'], colorUses: [['#12ae89', 9], ['#ffffff', 6], ['#f2f2f2', 4]], irTexts: [ir.join('\n')] });
    expect(t.colors.map((c) => c.name)).toEqual(['brand', 'surface', 'surfaceMuted']);
    for (const fw of ['flutter', 'react', 'next'] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78-ds-${fw}-`));
      try {
        if (fw !== 'flutter') await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '18.0.0', ...(fw === 'next' ? { next: '14.0.0' } : {}) } }));
        if (fw === 'next') await fs.mkdir(path.join(root, 'app'), { recursive: true });
        const g = await generateDesignSystem(root, fw, { colors: [], fonts: ['Inter'], colorUses: [['#12ae89', 9], ['#ffffff', 6], ['#f2f2f2', 4]], irTexts: [ir.join('\n')] });
        const src = await fs.readFile(path.join(root, g.themeFile), 'utf8');
        if (fw === 'flutter') {
          expect(src).toMatch(/static const double s4 = 4, s8 = 8, s10 = 10/);
          expect(src).toMatch(/static const BorderRadius r14 = BorderRadius\.all\(Radius\.circular\(14\)\);/);
          expect(src).toMatch(/static const BorderRadius radiusPill = BorderRadius\.all\(Radius\.circular\(999\)\);/);
          expect(src).toMatch(/static const Radius corner14 = Radius\.circular\(14\);/);
          expect(src).toMatch(/static const double iconMd = 16, iconLg = 24, avatar = 40, buttonHeight = 47;/);
          expect(g.api).toMatch(/AppTheme\.radiusPill/);
        } else {
          expect(src).toMatch(/radius: \{ [^}]*r14: 14[^}]*pill: 9999 \}/);
          expect(src).toMatch(/size: \{ iconMd: 16, iconLg: 24, avatar: 40, buttonHeight: 47 \}/);
          const css = await fs.readFile(path.join(root, g.tokens.cssFile!), 'utf8');
          expect(css).toMatch(/--size-buttonHeight: 47px;/);
          expect(css).toMatch(/--radius-pill: 9999px;/);
          expect(g.api).toMatch(/AppTheme\.size\.buttonHeight/);
          expect(g.api).not.toMatch(/EdgeInsets|BorderRadius\(/);
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  });
});

// ── F5: 7f widened (flutter) ────────────────────────────────────────────────

const THEME = `import 'package:flutter/material.dart';

class AppTheme {
  AppTheme._();
  static const Color ink = Color(0xFF000000);
  static const Color surface = Color(0xFFffffff);
  static const Color ink2 = Color(0xFF121212);
  static const Color neutral3 = Color(0xFF5e5e5e);
  static const double s4 = 4, s8 = 8, s16 = 16;
  static const BorderRadius r8 = BorderRadius.all(Radius.circular(8));
  static ThemeData themeData() => ThemeData(useMaterial3: true);
}
`;
const SCREEN = (n: number): string => `import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class S${n}Screen extends StatelessWidget {
  const S${n}Screen({super.key});
  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Icon(Icons.add, size: 24, color: AppTheme.ink2),
      const SizedBox(height: 10),
      SizedBox(width: 20, height: 20, child: Text('x', style: TextStyle(color: AppTheme.neutral3))),
      Container(
        height: 56,
        decoration: BoxDecoration(color: AppTheme.ink, borderRadius: BorderRadius.circular(28)),
        child: const Text('Go'),
      ),
      Container(
        padding: const EdgeInsets.only(left: 10, top: 4),
        decoration: BoxDecoration(borderRadius: BorderRadius.only(topLeft: Radius.circular(24), topRight: Radius.circular(24))),
        child: const Text('Sheet'),
      ),
    ]);
  }
}
`;

async function flutterApp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78-tok-'));
  await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await fs.mkdir(path.join(root, 'lib', 'theme'), { recursive: true });
  await fs.mkdir(path.join(root, 'lib', 'screens'), { recursive: true });
  await fs.writeFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), THEME);
  for (const n of [1, 2]) await fs.writeFile(path.join(root, 'lib', 'screens', `s${n}_screen.dart`), SCREEN(n));
  return root;
}

describe('F5 token cleanup — sizes, corners, pills, EdgeInsets.only, counter renames (flutter)', () => {
  it('finds each literal in its role', () => {
    const fams = scanVocabSites(SCREEN(1)).map((s) => `${s.family}:${s.value}`).sort();
    expect(fams).toEqual(['button:56', 'corner:24', 'corner:24', 'icon:20', 'icon:20', 'icon:24', 'pill:28', 'spacing:10', 'spacing:10', 'spacing:4'].sort());
  });

  it('adds the recurring vocabulary to the theme, renames counters, substitutes, and a second run is a no-op', async () => {
    const root = await flutterApp();
    try {
      const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
      const theme = await fs.readFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), 'utf8');
      expect(r.report.vocabulary?.added).toEqual(expect.arrayContaining(['s10', 'radiusPill', 'corner24', 'buttonHeight=56']));
      expect(theme).toMatch(/static const double s10 = 10;/);
      expect(theme).toMatch(/static const Radius corner24 = Radius\.circular\(24\);/);
      expect(r.report.vocabulary?.renamed).toEqual(expect.arrayContaining([{ from: 'ink2', to: 'textPrimary' }, { from: 'neutral3', to: 'textSecondary' }]));
      expect(theme).not.toMatch(/\bink2\b|\bneutral3\b/);
      const s1 = await fs.readFile(path.join(root, 'lib', 'screens', 's1_screen.dart'), 'utf8');
      expect(s1).toMatch(/Icon\(Icons\.add, size: AppTheme\.iconLg/);
      expect(s1).toMatch(/SizedBox\(width: AppTheme\.iconMd, height: AppTheme\.iconMd/);
      expect(s1).toMatch(/height: AppTheme\.buttonHeight/);
      expect(s1).toMatch(/borderRadius: AppTheme\.radiusPill/);
      expect(s1).toMatch(/topLeft: AppTheme\.corner24/);
      expect(s1).toMatch(/EdgeInsets\.only\(left: AppTheme\.s10, top: AppTheme\.s4\)/);
      expect(s1).toMatch(/AppTheme\.textSecondary/);
      // a now-constant BoxDecoration is written const (prefer_const_constructors)
      expect(s1).toMatch(/decoration: const BoxDecoration\(color: AppTheme\.ink, borderRadius: AppTheme\.radiusPill\)/);
      expect(s1).not.toMatch(/\b(24|56|28)\b(?!\))/);
      const again = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
      expect(again.report.vocabulary).toBeUndefined();
      expect(again.report.changes).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('a radius is a pill only when the literal box proves it (N ≥ short side / 2)', () => {
    const src = "Container(height: 100, decoration: BoxDecoration(borderRadius: BorderRadius.circular(28)))";
    expect(scanVocabSites(src).find((s) => s.value === 28)?.family).toBe('radius');
  });

  it('const promotion: only whitelisted ctors, only theme members declared const', () => {
    const ctx = { themeClass: 'AppTheme', themeConsts: new Set(['brand', 'r8']) };
    expect(isConstExpr('BoxDecoration(color: AppTheme.brand, borderRadius: AppTheme.r8)', ctx)).toBe(true);
    expect(isConstExpr('BoxDecoration(color: AppTheme.dynamicBrand)', ctx)).toBe(false);
    expect(isConstExpr('BoxDecoration(borderRadius: BorderRadius.circular(8))', ctx)).toBe(false);
    expect(isConstExpr('Container(color: AppTheme.brand)', ctx)).toBe(false);
    expect(promoteConst('x(decoration: BoxDecoration(color: AppTheme.brand, border: const Border()))', ctx).src)
      .toBe('x(decoration: const BoxDecoration(color: AppTheme.brand, border: Border()))');
    expect(promoteConst('const Padding(padding: EdgeInsets.all(AppTheme.r8))', ctx).promoted).toBe(0);
  });
});

// ── F5: web ──────────────────────────────────────────────────────────────────

describe('F5 token cleanup (react + next): size tokens and pills', () => {
  for (const fw of ['react', 'next'] as const) {
    it(`${fw}: recurring square sizes become size tokens in the theme and the screens`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78-web-${fw}-`));
      await fs.cp(path.join(__dirname, 'fixtures', 'parity', fw), root, { recursive: true });
      try {
        const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        expect(r.report.skippedReason).toBeUndefined();
        const themeRel = r.report.themeFile!;
        const theme = await fs.readFile(path.join(root, themeRel), 'utf8');
        expect(theme).toMatch(/size: \{[^}]*icon\w+: 18/);
        expect(r.report.substitutions.sizes ?? 0).toBeGreaterThan(0);
        const changed = r.report.changes.filter((c) => c.kind === 'size');
        expect(changed.every((c) => /^AppTheme\.size\.icon\w+$/.test(c.to))).toBe(true);
        const f = r.report.changes.find((c) => c.kind === 'size')!.file;
        expect(await fs.readFile(path.join(root, f), 'utf8')).toMatch(/width=\{AppTheme\.size\.icon\w+\} height=\{AppTheme\.size\.icon\w+\}/);
        const again = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        expect(again.report.vocabulary).toBeUndefined();
        expect(again.report.substitutions.sizes ?? 0).toBe(0);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('F4 web: counter-named colour keys get role names (react + next)', () => {
  for (const fw of ['react', 'next'] as const) {
    it(`${fw}: theme key, CSS custom property and every reference move together; a second run is a no-op`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78-webren-${fw}-`));
      await fs.cp(path.join(__dirname, 'fixtures', 'parity', fw), root, { recursive: true });
      try {
        const first = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true, dryRun: true });
        const themeRel = first.report.themeFile!;
        const themeAbs = path.join(root, themeRel);
        // the pre-F4 design system's names: a counter-named grey + a counter-named accent
        const theme0 = await fs.readFile(themeAbs, 'utf8');
        await fs.writeFile(themeAbs, theme0.replace(/(surface: '#ffffff',)/, "$1\n    neutral1: '#6c7278',\n    accent2: '#becaea',"));
        await fs.writeFile(themeAbs.replace(/\.ts$/, '.css'), ':root {\n  --color-neutral1: #6c7278;\n  --color-accent2: #becaea;\n}\n.muted { color: var(--color-neutral1); }\n');
        const screen = path.join(root, first.report.changes.find(() => true)?.file ?? '');
        const target = fsSync.existsSync(screen) && /\.tsx$/.test(screen) ? screen : (await fs.readdir(path.join(root, fw === 'react' ? 'src/screens' : 'app'), { recursive: true }))
          .map((f) => path.join(root, fw === 'react' ? 'src/screens' : 'app', String(f))).find((f) => f.endsWith('.tsx'))!;
        const src0 = await fs.readFile(target, 'utf8');
        const spec = path.relative(path.dirname(target), themeAbs).replace(/\.ts$/, '').split(path.sep).join('/');
        await fs.writeFile(target, `import { AppTheme as T0 } from '${spec.startsWith('.') ? spec : `./${spec}`}';\nexport const muted = [T0.color.neutral1, T0.color.neutral1, T0.color.accent2];\n${src0}`.replace(/T0/g, 'AppTheme'));
        const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        const renamed = r.report.vocabulary?.renamed ?? [];
        expect(renamed.map((x) => x.from).sort()).toEqual(['accent2', 'neutral1']);
        expect(renamed.every((x) => !COUNTER.test(x.to) && !/\d/.test(x.to))).toBe(true);
        const to = Object.fromEntries(renamed.map((x) => [x.from, x.to]));
        const theme1 = await fs.readFile(themeAbs, 'utf8');
        expect(theme1).toContain(`${to.neutral1}: '#6c7278'`);
        expect(theme1).not.toMatch(/neutral1|accent2/);
        const css1 = await fs.readFile(themeAbs.replace(/\.ts$/, '.css'), 'utf8');
        expect(css1).toContain(`--color-${to.neutral1}: #6c7278`);
        expect(css1).toContain(`var(--color-${to.neutral1})`);
        const src1 = await fs.readFile(target, 'utf8');
        expect(src1).toContain(`AppTheme.color.${to.neutral1}, AppTheme.color.${to.neutral1}, AppTheme.color.${to.accent2}`);
        expect(r.report.substitutions.renamed).toBe(3);
        const again = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        expect(again.report.vocabulary?.renamed ?? []).toEqual([]);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});

it('fixtures are untouched by these tests', () => {
  expect(fsSync.readFileSync(path.join(__dirname, 'fixtures', 'parity', 'react', 'src', 'theme', 'theme.ts'), 'utf8')).not.toMatch(/size:/);
});
