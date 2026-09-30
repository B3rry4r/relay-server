// =============================================================================
// B78 fix round — regressions for the skeptic's findings on 9c76fd7.
//
//  F5  web pill: `borderRadius: 20` on `height: 40` is only a stadium when the
//      BORDER box is 40 high. CSS height is the content box, so padding/borders
//      make it a rounded rectangle and 9999 changed pixels (Chromium, Next 14).
//  F6  provenance strip: `{/* Frame 45 … */}` left a bare `{}` in JSX; `//` in JSX
//      text was treated as a comment (UI copy edited); `10:30` was read as a node
//      id and `3×3` as a pixel size.
// =============================================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanWebSizeSites, stadiumIsExact, detectGlobalBorderBox } from '../src/relay-server/passes/token-cleanup-web';
import { deepenTokensAndCleanup } from '../src/relay-server/passes/token-cleanup';
import { stripProvenance, stripProvenanceText, scanComments, renderedJsxText } from '../src/relay-server/passes/source-hygiene';

describe('F5 web pill: only a stadium the browser already paints', () => {
  const pills = (src: string, box = {}): number[] => scanWebSizeSites(src, undefined, box).filter((s) => s.family === 'pill').map((s) => s.value);

  it('the skeptic repro: padding on a content-box <div> — NOT a pill (220x60 box, radius 20)', () => {
    expect(pills('<div style={{ height: 40, borderRadius: 20, padding: 10, width: 200 }}>x</div>')).toEqual([]);
  });
  it('no padding / border: the 40-high div IS a stadium', () => {
    expect(pills('<div style={{ height: 40, borderRadius: 20, width: 200 }}>x</div>')).toEqual([20]);
  });
  it('<button> is border-box in every UA sheet: padding is inside the 48', () => {
    expect(pills('<button style={{ height: 48, borderRadius: 24, padding: 10 }}>Go</button>')).toEqual([24]);
    expect(pills('<button onClick={() => go()} style={{ height: 48, borderRadius: 24 }}>Go</button>')).toEqual([24]);
  });
  it('explicit boxSizing border-box, or a global border-box reset, makes padding irrelevant', () => {
    expect(pills("<div style={{ boxSizing: 'border-box', height: 40, borderRadius: 20, padding: 10 }} />")).toEqual([20]);
    expect(pills('<div style={{ height: 40, borderRadius: 20, padding: 10 }} />', { borderBox: true })).toEqual([20]);
    // …but border-box padding larger than the height grows the box
    expect(pills("<div style={{ boxSizing: 'border-box', height: 20, borderRadius: 10, padding: 14 }} />")).toEqual([]);
  });
  it('a border counts: 1px solid on a 40-high content box is 42 high', () => {
    expect(pills("<div style={{ height: 40, borderRadius: 20, border: '1px solid #eee' }} />")).toEqual([]);
    expect(pills("<div style={{ height: 40, borderRadius: 21, border: '1px solid #eee' }} />")).toEqual([21]);
    expect(pills("<div style={{ height: 40, borderRadius: 20, borderStyle: 'solid' }} />")).toEqual([]);
  });
  it('a className on a content-box element may add padding we cannot see', () => {
    expect(pills('<div className="chip" style={{ height: 40, borderRadius: 20 }} />')).toEqual([]);
    expect(pills('<div style={{ height: 40, borderRadius: 20 }} className="chip" />')).toEqual([]);
    expect(pills('<div className="chip" style={{ height: 40, borderRadius: 20 }} />', { borderBox: true })).toEqual([20]);
  });
  it('an inline <span> ignores width/height; a component may pad; min-height and flex growth can grow the box', () => {
    expect(pills('<span style={{ height: 40, borderRadius: 20 }}>x</span>')).toEqual([]);
    expect(pills("<span style={{ display: 'inline-block', height: 40, borderRadius: 20 }}>x</span>")).toEqual([20]);
    expect(pills('<Chip style={{ height: 40, borderRadius: 20 }} />')).toEqual([]);
    expect(pills('<div style={{ height: 40, borderRadius: 20, minHeight: 48 }} />')).toEqual([]);
    expect(pills('<div style={{ height: 40, width: 100, borderRadius: 20, flex: 1 }} />')).toEqual([]);
    expect(pills('<div style={{ height: 40, width: 100, borderRadius: 50, flex: 1 }} />')).toEqual([50]);
    expect(pills("<div style={{ height: 40, width: 100, borderRadius: 20, flex: '0 0 auto' }} />")).toEqual([20]);
  });
  it('a style object outside JSX (element unknown) is a pill only under a border-box reset', () => {
    expect(pills('const chip = { height: 40, borderRadius: 20 };')).toEqual([]);
    expect(pills('const chip = { height: 40, borderRadius: 20 };', { borderBox: true })).toEqual([20]);
    expect(pills('<div style={{ ...base, height: 40, borderRadius: 20 }} />')).toEqual([]);
  });
  it('token padding is resolved (run 2 sees AppTheme.spacing.s10 where run 1 saw 10)', () => {
    const resolve = (e: string): number | null => (e === 'AppTheme.spacing.s10' ? 10 : null);
    const src = '<div style={{ height: 40, borderRadius: 20, padding: AppTheme.spacing.s10 }} />';
    expect(pills(src, { resolve })).toEqual([]);
    expect(pills('<div style={{ height: 40, borderRadius: 20, padding: AppTheme.spacing.sX }} />', { resolve })).toEqual([]);
    expect(stadiumIsExact(src, src.indexOf('{ h'), src.slice(src.indexOf('{ h') + 1, src.indexOf(' }') + 1), 30, { resolve })).toBe(true);
  });
  it('detects Tailwind preflight and universal border-box resets', () => {
    expect(detectGlobalBorderBox(['@tailwind base;\n@tailwind components;'])).toBe(true);
    expect(detectGlobalBorderBox(['@import "tailwindcss";'])).toBe(true);
    expect(detectGlobalBorderBox(['*, *::before, *::after { box-sizing: border-box; }'])).toBe(true);
    expect(detectGlobalBorderBox(['body { margin: 0 }', '.x { box-sizing: border-box }'])).toBe(false);
    expect(detectGlobalBorderBox(['/* * { box-sizing: border-box } */ body{}'])).toBe(false);
  });

  for (const fw of ['react', 'next'] as const) {
    it(`${fw}: 7f leaves padded chips alone (radius stays 20) and still tokenises the border-box button`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78fx-pill-${fw}-`));
      await fs.cp(path.join(__dirname, 'fixtures', 'parity', fw), root, { recursive: true });
      try {
        const screens = fw === 'react'
          ? ['src/screens/Login/LoginScreen.tsx', 'src/screens/PlaceholderScreen.tsx']
          : ['app/10-1/page.tsx', 'app/10-3/page.tsx'];
        for (const [i, rel] of screens.entries()) {
          const f = path.join(root, rel);
          const src = await fs.readFile(f, 'utf8');
          await fs.writeFile(f, `${src}\nexport function Chip${i}() {\n  return (\n    <div>\n      <div style={{ height: 40, borderRadius: 20, padding: 10, width: 200 }}>Chip${i}</div>\n      <button style={{ height: 48, borderRadius: 24 }}>Go${i}</button>\n    </div>\n  );\n}\n`);
        }
        const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        for (const rel of screens) {
          const out = await fs.readFile(path.join(root, rel), 'utf8');
          expect(out).toMatch(/height: 40, borderRadius: (20|AppTheme\.radius\.\w+), padding/);
          expect(out).not.toMatch(/height: 40, borderRadius: AppTheme\.radius\.pill/);
          expect(out).toMatch(/<button style=\{\{ height: [^,]+, borderRadius: AppTheme\.radius\.pill \}\}>/);
        }
        const radiusChanges = r.report.changes.filter((c) => c.kind === 'radius' && /pill/.test(c.to));
        expect(radiusChanges.every((c) => c.from === '24')).toBe(true);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('F6 provenance strip: JSX-aware, no litter, no false provenance', () => {
  it('the skeptic repro: an all-provenance {/* … */} child goes with its braces and its line', () => {
    expect(stripProvenance('<div>\n  {/* Frame 45 hero, matches the reference */}\n  <p/>\n</div>\n', 'tsx').src).toBe('<div>\n  <p/>\n</div>\n');
    const page = "export default function Page() {\n  return (\n    <main>\n      {/* Frame 45 hero, matches the reference */}\n      <h1>Hi</h1>\n      {/* IR \"Rectangle 24\" */}\n    </main>\n  );\n}\n";
    expect(stripProvenance(page, 'tsx').src).toBe('export default function Page() {\n  return (\n    <main>\n      <h1>Hi</h1>\n    </main>\n  );\n}\n');
  });
  it('a container with a behavioural remainder keeps its comment; a mixed container keeps its code', () => {
    expect(stripProvenance('<div>\n  {/* Hero banner (frame 45) */}\n</div>\n', 'tsx').src).toBe('<div>\n  {/* Hero banner */}\n</div>\n');
    expect(stripProvenance('<div>\n  {x /* frame 45 */}\n</div>\n', 'tsx').src).toBe('<div>\n  {x}\n</div>\n');
  });
  it('removal never changes rendered text: between two text lines the empty braces stay', () => {
    const src = '<p>\n  Hello\n  {/* Frame 45 */}\n  world\n</p>\n';
    // React renders "Helloworld" (JSX joins lines only within one text run); dropping
    // the braces would merge the runs into "Hello world".
    expect(stripProvenance(src, 'tsx').src).toBe('<p>\n  Hello\n  {}\n  world\n</p>\n');
    expect(renderedJsxText('\n  Hello\n  ') + renderedJsxText('\n  world\n')).toBe('Helloworld');
    // same line, text on one side only: "Hi " + element — the space survives
    expect(stripProvenance('<p>Hi {/* Frame 4 */}<b/></p>\n', 'tsx').src).toBe('<p>Hi <b/></p>\n');
  });
  it('`//` and `/*` inside JSX text are user-visible copy, never comments', () => {
    const src = '<p>Go to http://ex.com/Rectangle 5 now</p>\n';
    expect(stripProvenance(src, 'tsx').src).toBe(src);
    const src2 = 'export const A = () => (\n  <div>\n    // Figma frame 12 is the source\n    /* Frame 9 */ text\n    <a href="http://x.io/Frame 7">x</a>\n  </div>\n);\n';
    expect(stripProvenance(src2, 'tsx').src).toBe(src2);
    expect(scanComments(src2, 'tsx').spans).toEqual([]);
  });
  it('the lexer still finds real comments around JSX: attributes, children expressions, regexes, templates', () => {
    const src = [
      'const re = /[/*]+/g; // Frame 12 source',
      'const t = `${a /* frame 44 */}//not a comment`;',
      'const el = a < b ? <X a={1 /* frame 5 */} /* IR "Icons" */ b="//x" /> : null;',
      'const gen = <T,>(x: T) => x; // node 283:1967',
      'const c = a / b; // Figma',
    ].join('\n');
    const texts = scanComments(src, 'tsx').spans.map(([a, b]) => src.slice(a, b));
    expect(texts).toEqual(['// Frame 12 source', '/* frame 44 */', '/* frame 5 */', '/* IR "Icons" */', '// node 283:1967', '// Figma']);
  });
  it('CSS has no line comments: a url(http://…) is not one', () => {
    const css = '.a { background: url(http://ex.com/Frame 12.png); } /* Frame 12 */\n';
    expect(stripProvenance(css, 'css').src).toBe('.a { background: url(http://ex.com/Frame 12.png); }\n');
  });
  it('clock times and ratios are not node ids', () => {
    expect(stripProvenanceText('Ratio 16:9 video; timeout 10:30')).toBe('Ratio 16:9 video; timeout 10:30');
    expect(stripProvenanceText('Status bar shows 9:41 like iOS.')).toBe('Status bar shows 9:41 like iOS.');
    expect(stripProvenanceText('Balance card (node 283:1967).')).toBe('Balance card.');
    expect(stripProvenanceText('Balance card (I313:10287;1:2).')).toBe('Balance card.');
  });
  it('a size that is a sentence predicate or a small grid count stays; a measured size goes', () => {
    expect(stripProvenanceText('Grid is 3×3 so the QR code fits')).toBe('Grid is 3×3 so the QR code fits');
    expect(stripProvenanceText('The avatar is 40×40 so it lines up with the row')).toBe('The avatar is 40×40 so it lines up with the row');
    expect(stripProvenanceText('Dots are 27×27 each.')).toBe('Dots are 27×27 each.');   // a predicate: the size IS the statement
    expect(stripProvenanceText('Back chevron in a 24×24 tap target.')).toBe('Back chevron in a tap target.');
    expect(stripProvenanceText('The icon is 24×24px so it aligns')).toBe('The icon is 24×24px so it aligns');
    expect(stripProvenanceText('Chevron, 24×24px, right aligned.')).toBe('Chevron, right aligned.');
  });
});

describe('readability metric ships in dist/src (release tarballs hold dist/src only)', () => {
  it('tsc compiles src/relay-server/readability-report.cjs next to readability.js, and the loader looks there first', async () => {
    const ts = await import('typescript');
    const root = path.join(__dirname, '..');
    const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
    expect(cfg.options.allowJs).toBe(true);
    expect(cfg.fileNames.map((f) => path.relative(root, f))).toContain(path.join('src', 'relay-server', 'readability-report.cjs'));
    const { loadReadabilityTool } = await import('../src/relay-server/readability');
    const t = loadReadabilityTool();
    expect(t.tool).not.toBeNull();
    expect(path.relative(root, t.file!)).toBe(path.join('src', 'relay-server', 'readability-report.cjs'));
    // the CLI wrapper is the same module
    const { createRequire } = await import('node:module');
    const req = createRequire(__filename);
    expect(req('../scripts/readability-report.cjs')).toBe(req('../src/relay-server/readability-report.cjs'));
  });
});

describe('F2 parameter quality: a positional asset argument is `String asset`, not `dynamic value`', () => {
  it('Image.asset(AppAssets.x) in two copies lifts with a typed, named parameter; the reuse block shows types', async () => {
    const { extractComponents } = await import('../src/relay-server/passes/component-extraction');
    const { scanBuiltComponents } = await import('../src/relay-server/component-contract');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78fx-f2-'));
    try {
      await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n');
      for (const d of ['theme', 'screens', 'resources']) await fs.mkdir(path.join(root, 'lib', d), { recursive: true });
      await fs.writeFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), "import 'package:flutter/material.dart';\n\nclass AppTheme {\n  static const Color brand = Color(0xFF12AE89);\n  static const Color ink = Color(0xFF000000);\n}\n");
      await fs.writeFile(path.join(root, 'lib', 'resources', 'app_assets.dart'), "class AppAssets {\n  AppAssets._();\n  static const String homeIcon = 'assets/icons/home.png';\n  static const String scanIcon = 'assets/icons/scan.png';\n}\n");
      const screen = (n: string, asset: string, color: string) => `import 'package:flutter/material.dart';\nimport '../theme/app_theme.dart';\nimport '../resources/app_assets.dart';\n\nclass ${n}Screen extends StatelessWidget {\n  const ${n}Screen({super.key});\n  @override\n  Widget build(BuildContext context) => const _NavItem();\n}\n\nclass _NavItem extends StatelessWidget {\n  const _NavItem();\n  @override\n  Widget build(BuildContext context) {\n    return Column(children: [\n      Image.asset(${asset}, width: 24, height: 24),\n      Container(width: 8, height: 8, color: ${color}),\n    ]);\n  }\n}\n`;
      await fs.writeFile(path.join(root, 'lib', 'screens', 'a_screen.dart'), screen('A', 'AppAssets.homeIcon', 'AppTheme.brand'));
      await fs.writeFile(path.join(root, 'lib', 'screens', 'b_screen.dart'), screen('B', 'AppAssets.scanIcon', 'AppTheme.ink'));
      const r = await extractComponents('t', { projectRoot: root, noAiConfirm: true });
      expect(r.extracted.map((e) => e.name)).toEqual(['NavItem']);
      const nav = await fs.readFile(path.join(root, r.extracted[0].componentPath), 'utf8');
      expect(nav).toMatch(/final String asset;/);
      expect(nav).not.toMatch(/\bdynamic\b|\bvalue\b/);
      expect(nav).toMatch(/Image\.asset\(\s*asset,/);
      expect(await fs.readFile(path.join(root, 'lib', 'screens', 'a_screen.dart'), 'utf8')).toMatch(/NavItem\([^)]*asset: AppAssets\.homeIcon/);
      const built = scanBuiltComponents(root, 'flutter');
      const sig = built.find((b) => b.className === 'NavItem')!.signature;
      expect(sig).toMatch(/^NavItem\(\{required String asset, required Color color\}\)$/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('reuse signatures render cleanly: no `(this.x, )`, no `({ required`', async () => {
    const { scanBuiltComponents } = await import('../src/relay-server/component-contract');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78fx-sig-'));
    try {
      await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\n');
      await fs.mkdir(path.join(root, 'lib', 'components'), { recursive: true });
      await fs.writeFile(path.join(root, 'lib', 'components', 'disc.dart'), "import 'package:flutter/material.dart';\n\nclass Disc extends StatelessWidget {\n  const Disc(this.color, {super.key});\n  final Color color;\n  @override\n  Widget build(BuildContext context) => Container(color: color);\n}\n");
      await fs.writeFile(path.join(root, 'lib', 'components', 'pill.dart'), "import 'package:flutter/material.dart';\n\nclass Pill extends StatelessWidget {\n  const Pill({\n    super.key,\n    required this.label,\n    this.onTap,\n  });\n  final String label;\n  final VoidCallback? onTap;\n  @override\n  Widget build(BuildContext context) => Text(label);\n}\n");
      const sigs = Object.fromEntries(scanBuiltComponents(root, 'flutter').map((b) => [b.className, b.signature]));
      expect(sigs.Disc).toBe('Disc(Color color)');
      expect(sigs.Pill).toBe('Pill({required String label, VoidCallback? onTap})');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('numeric-suffix leftovers: asset symbols and text styles get names, not counters', () => {
  it('assetSymbolKeys: a lone Figma counter is dropped; a shared name gets the second asset\'s kind', async () => {
    const { assetSymbolKeys } = await import('../src/relay-server/resources-emit');
    const I = (name: string, kind: 'icon' | 'image' = 'icon'): { name: string; kind: 'icon' | 'image'; format: 'svg' | 'png' } => ({ name, kind, format: kind === 'icon' ? 'svg' : 'png' });
    const keys = assetSymbolKeys([
      I('avatar_background'), I('divider'), I('divider_2'), I('ping_logo'), I('chevron_down'), I('chevron_down_2'),
      I('avatar_background', 'image'), I('card_background', 'image'), I('card_background_2', 'image'), I('confetti_icon', 'image'), I('confetti_icon', 'image'), I('search_icon'), I('search_icon'),
      I('divider', 'image'), I('divider_2', 'image'), I('netflix_icon_1', 'image'), I('ping_logo', 'image'), I('time_9_41_2'),
    ]);
    expect(keys).toEqual([
      'avatarBackground', 'divider', 'divider2', 'pingLogo', 'chevronDown', 'chevronDown2',
      'avatarBackgroundImage', 'cardBackground', 'cardBackground2', 'confettiIcon', 'confettiIconImage',
      'searchIcon', 'searchIconSvg', 'dividerImage', 'divider2Image', 'netflixIcon', 'pingLogoImage', 'time9412',
    ]);
  });

  it('flutter 7c renames old-scheme AppAssets keys (declaration + references); a second run is a no-op', async () => {
    const { repointAssetUsage } = await import('../src/relay-server/passes/asset-usage');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78fx-assets-fl-'));
    try {
      await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_svg: ^2.0.0\n');
      for (const d of ['lib/resources', 'lib/screens', '.uix']) await fs.mkdir(path.join(root, d), { recursive: true });
      const entries = [
        ['avatar_background', 'assets/icons/avatar_background.svg', 'svg', 'icon'],
        ['avatar_background', 'assets/images/avatar_background.png', 'png', 'image'],
        ['netflix_icon_1', 'assets/images/netflix_icon_1.png', 'png', 'image'],
      ];
      await fs.writeFile(path.join(root, '.uix', 'asset-map.json'), JSON.stringify({ framework: 'flutter', resourcesPath: 'lib/resources/app_assets.dart', assets: entries.map(([name, p, format, kind], i) => ({ nodeId: `1:${i}`, name, oldPath: p, newPath: p, format, kind })) }));
      await fs.writeFile(path.join(root, 'lib', 'resources', 'app_assets.dart'), "class AppAssets {\n  AppAssets._();\n\n  static const String avatarBackground = 'assets/icons/avatar_background.svg';\n  static const String avatarBackground_2 = 'assets/images/avatar_background.png';\n  static const String netflixIcon1 = 'assets/images/netflix_icon_1.png';\n}\n");
      await fs.writeFile(path.join(root, 'lib', 'screens', 'home_screen.dart'), "import 'package:flutter/material.dart';\nimport '../resources/app_assets.dart';\n\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) => Column(children: [Image.asset(AppAssets.netflixIcon1), Image.asset(AppAssets.avatarBackground_2)]);\n}\n");
      const r = await repointAssetUsage('t', { projectRoot: root, noAi: true });
      expect(r.renamedSymbols.map((x) => `${x.from}->${x.to}:${x.refs}`).sort()).toEqual(['avatarBackground_2->avatarBackgroundImage:1', 'netflixIcon1->netflixIcon:1']);
      const res = await fs.readFile(path.join(root, 'lib', 'resources', 'app_assets.dart'), 'utf8');
      expect(res).toContain("static const String avatarBackgroundImage = 'assets/images/avatar_background.png';");
      expect(res).toContain("static const String netflixIcon = 'assets/images/netflix_icon_1.png';");
      expect(res).toContain("static const String avatarBackground = 'assets/icons/avatar_background.svg';");
      const home = await fs.readFile(path.join(root, 'lib', 'screens', 'home_screen.dart'), 'utf8');
      expect(home).toContain('Image.asset(AppAssets.netflixIcon), Image.asset(AppAssets.avatarBackgroundImage)');
      const again = await repointAssetUsage('t', { projectRoot: root, noAi: true });
      expect(again.renamedSymbols).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  for (const fw of ['react', 'next'] as const) {
    it(`${fw} 7c renames old-scheme asset keys in the resources module and every assets.x reference`, async () => {
      const { repointAssetUsage } = await import('../src/relay-server/passes/asset-usage');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78fx-assets-${fw}-`));
      await fs.cp(path.join(__dirname, 'fixtures', 'parity', fw), root, { recursive: true });
      try {
        const mapFile = path.join(root, '.uix', 'asset-map.json');
        await fs.mkdir(path.dirname(mapFile), { recursive: true });
        const map = await fs.readFile(mapFile, 'utf8').then((t) => JSON.parse(t)).catch(() => ({ framework: fw, assets: [] }));
        map.assets.push(
          { nodeId: '9:1', name: 'avatar_background', oldPath: 'public/assets/icons/avatar_background.svg', newPath: 'public/assets/icons/avatar_background.svg', format: 'svg', kind: 'icon' },
          { nodeId: '9:2', name: 'avatar_background', oldPath: 'public/assets/images/avatar_background.png', newPath: 'public/assets/images/avatar_background.png', format: 'png', kind: 'image' },
          { nodeId: '9:3', name: 'netflix_icon_1', oldPath: 'public/assets/images/netflix_icon_1.png', newPath: 'public/assets/images/netflix_icon_1.png', format: 'png', kind: 'image' },
        );
        await fs.writeFile(mapFile, JSON.stringify(map));
        const resRel = fw === 'next' ? 'lib/resources/assets.ts' : 'src/resources/assets.ts';
        const res0 = await fs.readFile(path.join(root, resRel), 'utf8');
        await fs.writeFile(path.join(root, resRel), res0.replace('} as const;', "  avatarBackground: '/assets/icons/avatar_background.svg',\n  avatarBackground_2: '/assets/images/avatar_background.png',\n  netflixIcon1: '/assets/images/netflix_icon_1.png',\n} as const;"));
        const screenRel = fw === 'next' ? 'app/10-1/page.tsx' : 'src/screens/Login/LoginScreen.tsx';
        const s0 = await fs.readFile(path.join(root, screenRel), 'utf8');
        const spec = fw === 'next' ? '@/lib/resources/assets' : '../../resources/assets';
        await fs.writeFile(path.join(root, screenRel), `${s0}\nimport { assets as A9 } from '${spec}';\nexport const promo = [A9.netflixIcon1, A9.avatarBackground_2];\n`.replace(/A9/g, 'assets'));
        const r = await repointAssetUsage('t', { projectRoot: root, noAi: true });
        expect(r.renamedSymbols.map((x) => `${x.from}->${x.to}:${x.refs}`).sort()).toEqual(['avatarBackground_2->avatarBackgroundImage:1', 'netflixIcon1->netflixIcon:1']);
        const res = await fs.readFile(path.join(root, resRel), 'utf8');
        expect(res).toContain("avatarBackgroundImage: '/assets/images/avatar_background.png',");
        expect(res).toContain("netflixIcon: '/assets/images/netflix_icon_1.png',");
        expect(await fs.readFile(path.join(root, screenRel), 'utf8')).toContain('export const promo = [assets.netflixIcon, assets.avatarBackgroundImage];');
        expect((await repointAssetUsage('t', { projectRoot: root, noAi: true })).renamedSymbols).toEqual([]);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }

  it('text styles: `section16` (size 16, w600) → `sectionHeading16`; the size convention and real counters are kept', async () => {
    const { planTextStyleRenames, dartTextStyleDecls } = await import('../src/relay-server/passes/token-vocabulary');
    const theme = 'class AppTheme {\n  static TextStyle _m(double size, FontWeight weight, Color color, double lh) => TextStyle(fontSize: size);\n  static TextStyle title24(Color color) => _m(24, FontWeight.w600, color, 28);\n  static TextStyle section15(Color color) => _m(15, FontWeight.w700, color, 24);\n  static TextStyle section16(Color color) => _m(16, FontWeight.w600, color, 24);\n  static TextStyle text14(Color c) => TextStyle(fontSize: 14, color: c);\n  static TextStyle section3(Color c) => TextStyle(fontSize: 12, color: c);\n}\n';
    const decls = dartTextStyleDecls(theme);
    expect(decls.find((d) => d.name === 'section15')).toEqual({ name: 'section15', size: 15, weight: 700 });
    expect(planTextStyleRenames(decls)).toEqual([
      { from: 'section15', to: 'sectionHeading15' }, { from: 'section16', to: 'sectionHeading16' }, { from: 'text14', to: 'textBody14' },
    ]);
  });

  it('flutter 7f renames the helpers and every AppTheme.x( reference; run 2 is a no-op', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b78fx-ts-fl-'));
    try {
      await fs.writeFile(path.join(root, 'pubspec.yaml'), 'name: t\ndependencies:\n  flutter:\n    sdk: flutter\n');
      for (const d of ['lib/theme', 'lib/screens']) await fs.mkdir(path.join(root, d), { recursive: true });
      await fs.writeFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), "import 'package:flutter/material.dart';\n\nclass AppTheme {\n  AppTheme._();\n  static const Color ink = Color(0xFF000000);\n  static TextStyle _m(double size, FontWeight weight, Color color, double lh) => TextStyle(fontSize: size, fontWeight: weight, color: color, height: lh / size);\n  /// 16 / w600 — section headings.\n  static TextStyle section16(Color color) => _m(16, FontWeight.w600, color, 24);\n  static TextStyle title24(Color color) => _m(24, FontWeight.w600, color, 28);\n}\n");
      const scr = (n: string) => `import 'package:flutter/material.dart';\nimport '../theme/app_theme.dart';\n\nclass ${n}Screen extends StatelessWidget {\n  const ${n}Screen({super.key});\n  @override\n  Widget build(BuildContext context) => Text('${n}', style: AppTheme.section16(AppTheme.ink));\n}\n`;
      await fs.writeFile(path.join(root, 'lib', 'screens', 'a_screen.dart'), scr('A'));
      await fs.writeFile(path.join(root, 'lib', 'screens', 'b_screen.dart'), scr('B'));
      const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
      expect(r.report.vocabulary?.renamed).toContainEqual({ from: 'section16', to: 'sectionHeading16' });
      const theme = await fs.readFile(path.join(root, 'lib', 'theme', 'app_theme.dart'), 'utf8');
      expect(theme).toContain('static TextStyle sectionHeading16(Color color) => _m(16, FontWeight.w600, color, 24);');
      expect(theme).toContain('static TextStyle title24(');
      for (const f of ['a_screen.dart', 'b_screen.dart']) expect(await fs.readFile(path.join(root, 'lib', 'screens', f), 'utf8')).toContain('AppTheme.sectionHeading16(AppTheme.ink)');
      const again = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
      expect(again.report.vocabulary?.renamed ?? []).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  for (const fw of ['react', 'next'] as const) {
    it(`${fw} 7f renames a text group's section16 and every AppTheme.text.x reference`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `b78fx-ts-${fw}-`));
      await fs.cp(path.join(__dirname, 'fixtures', 'parity', fw), root, { recursive: true });
      try {
        const themeRel = fw === 'next' ? 'lib/theme.ts' : 'src/theme/theme.ts';
        const t0 = await fs.readFile(path.join(root, themeRel), 'utf8');
        await fs.writeFile(path.join(root, themeRel), t0.replace(/(export const AppTheme = \{\n)/, "$1  text: {\n    section16: { fontSize: 16, fontWeight: 600, lineHeight: 24 },\n    title24: { fontSize: 24, fontWeight: 600 },\n  },\n"));
        const screenRel = fw === 'next' ? 'app/10-1/page.tsx' : 'src/screens/Login/LoginScreen.tsx';
        const s0 = await fs.readFile(path.join(root, screenRel), 'utf8');
        const spec = fw === 'next' ? '@/lib/theme' : '../../theme/theme';
        const withImport = /\bAppTheme\b/.test(s0) ? s0 : `import { AppTheme } from '${spec}';\n${s0}`;
        await fs.writeFile(path.join(root, screenRel), `${withImport}\nexport const headingStyle = AppTheme.text.section16;\n`);
        const r = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        expect(r.report.vocabulary?.renamed).toContainEqual({ from: 'section16', to: 'sectionHeading16' });
        const theme = await fs.readFile(path.join(root, themeRel), 'utf8');
        expect(theme).toContain('sectionHeading16: { fontSize: 16, fontWeight: 600, lineHeight: 24 }');
        expect(theme).toContain('title24: {');
        expect(await fs.readFile(path.join(root, screenRel), 'utf8')).toContain('AppTheme.text.sectionHeading16');
        const again = await deepenTokensAndCleanup('t', { projectRoot: root, noAi: true, skipAnalyze: true, noReport: true });
        expect(again.report.vocabulary?.renamed ?? []).toEqual([]);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
});
