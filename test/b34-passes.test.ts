/**
 * Lane B34 regression tests: passes 7a, 7b, 7d, 7e, 7f, 7g, 7h on flutter, react
 * and next. The parity ratchet (test/parity) grades the fixtures end to end; these
 * pin the individual mechanisms each fix relies on.
 */
import { describe, it, expect } from 'vitest';
import { __test as audit } from '../src/relay-server/passes/interaction-audit';

describe('7g labels name the control that owns the dead handler (PG-22, PG-23)', () => {
  it('jsx: the button text, not a neighbouring <Badge label=…>', () => {
    const src = `<section>\n  <Badge label="beta" />\n  <SearchGlyph />\n  <button onClick={() => {}}>Resolve</button>\n  <PillButton label="Save" />\n</section>`;
    expect(audit.jsxOwnerLabel(src, src.indexOf('onClick'))).toBe('Resolve');
  });
  it('jsx: own aria-label wins; nested text/expressions are flattened', () => {
    const a = `<button aria-label="Close" onClick={() => {}}><Icon /></button>`;
    expect(audit.jsxOwnerLabel(a, a.indexOf('onClick'))).toBe('Close');
    const b = `<button className={cx('a', {b: true})} onClick={() => {}}>\n  <Icon/> Resolve {count} dispute\n</button>`;
    expect(audit.jsxOwnerLabel(b, b.indexOf('onClick'))).toBe('Resolve dispute');
    const c = `<IconButton onClick={() => {}} />\n<Badge label="new" />`;
    expect(audit.jsxOwnerLabel(c, c.indexOf('onClick'))).toBeNull();
  });
  it('dart: the widget\'s own child Text / tooltip, never a sibling', () => {
    const src = `Column(children: [\n  const _SectionHeading(title: 'Settings'),\n  TextButton(onPressed: () {}, child: const Text('Resolve')),\n  const _PillButton(label: 'Save'),\n])`;
    expect(audit.dartOwnerLabel(src, src.indexOf('onPressed'))).toBe('Resolve');
    const icon = `IconButton(\n  icon: const Icon(Icons.close),\n  tooltip: 'Close',\n  onPressed: () {},\n)`;
    expect(audit.dartOwnerLabel(icon, icon.indexOf('onPressed'))).toBe('Close');
    const bare = `GestureDetector(onTap: () {}, child: const Icon(Icons.add)), Text('Other')`;
    expect(audit.dartOwnerLabel(bare, bare.indexOf('onTap'))).toBeNull();
  });
});

// ── 7h ────────────────────────────────────────────────────────────────────────
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProductionHygiene } from '../src/relay-server/passes/production-hygiene';

const FIX = path.resolve(__dirname, 'fixtures', 'parity');
async function fixture(fw: 'flutter' | 'react' | 'next'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `b34-${fw}-`));
  await fs.cp(path.join(FIX, fw), root, { recursive: true });
  return root;
}

describe('7h productionHygiene (PG-25, PG-26)', () => {
  it('next: strips preview route dirs and header-less placeholder pages, keeps a stamped skeleton stub and the module it renders', async () => {
    const root = await fixture('next');
    await fs.mkdir(path.join(root, 'app', '%5Fpreview', '10-2'), { recursive: true });
    await fs.writeFile(path.join(root, 'app', '%5Fpreview', '10-2', 'page.tsx'), "export default function P() { return null; }\n");
    await fs.mkdir(path.join(root, 'app', 'details'), { recursive: true });
    const stub = "// canonicalId: c_10_7 route: /details\nimport { PlaceholderScreen } from '@/components/PlaceholderScreen';\n// TODO(build): implement\nexport default function DetailsPage() { return <PlaceholderScreen title=\"Details\" />; }\n";
    await fs.writeFile(path.join(root, 'app', 'details', 'page.tsx'), stub);
    const r = await runProductionHygiene({ projectRoot: root });
    expect(r.skippedReason).toBeUndefined();
    for (const gone of ['app/_preview', 'app/%5Fpreview', 'app/10-5', 'app/10-8', 'app/10-9']) expect(fsSync.existsSync(path.join(root, gone)), gone).toBe(false);
    expect(await fs.readFile(path.join(root, 'app', 'details', 'page.tsx'), 'utf8')).toBe(stub);
    expect(fsSync.existsSync(path.join(root, 'components', 'PlaceholderScreen.tsx'))).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/still linked from app\/\(tabs\)\/10-2\/page\.tsx/);
    expect(r.warnings.join('\n')).toMatch(/computed key/);
    const again = await runProductionHygiene({ projectRoot: root });
    expect([again.previewRoutesRemoved, again.previewFilesRemoved, again.placeholderRemoved]).toEqual([0, 0, false]);
  });

  it('react: PlaceholderScreen.tsx survives while an un-built stub still renders it', async () => {
    const root = await fixture('react');
    await fs.writeFile(path.join(root, 'src', 'screens', 'DetailsScreen.tsx'), "// canonicalId: c_10_5 route: /10-5\nimport { PlaceholderScreen } from './PlaceholderScreen';\nexport function DetailsScreen() { return <PlaceholderScreen title=\"Details\" />; }\n");
    const r = await runProductionHygiene({ projectRoot: root });
    expect(fsSync.existsSync(path.join(root, 'src', 'screens', 'PlaceholderScreen.tsx'))).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/kept src\/screens\/PlaceholderScreen\.tsx/);
  });

  it('flutter: reports unreferenced AppAssets symbols and flags the computed-key loader, deletes nothing', async () => {
    const root = await fixture('flutter');
    const r = await runProductionHygiene({ projectRoot: root });
    expect(r.unreferencedAssets).toBe(2);   // searchIcon, userAvatar — promoBanner/mapDark are referenced
    expect(r.warnings.join('\n')).toMatch(/computed key \(Image\.asset\(banners\[bannerKey\]!\) in lib\/screens\/home_screen\.dart\)/);
    expect(fsSync.existsSync(path.join(root, 'assets', 'images', 'promo_banner.png'))).toBe(true);
    expect(fsSync.existsSync(path.join(root, 'lib', '_preview'))).toBe(false);
  });
});

// ── 7f ────────────────────────────────────────────────────────────────────────
import { deepenWebTokens, locateWebTheme } from '../src/relay-server/passes/token-cleanup-web';

describe('7f web tokens find the theme the design-system contract recorded (PG-18)', () => {
  it('next: .uix/design-system.json themeFile wins; app/ pages are rewritten; run 2 is a no-op', async () => {
    const root = await fixture('next');
    await fs.mkdir(path.join(root, 'lib', 'theme'), { recursive: true });
    await fs.rename(path.join(root, 'lib', 'theme.ts'), path.join(root, 'lib', 'theme', 'theme.ts'));
    await fs.writeFile(path.join(root, '.uix', 'design-system.json'), JSON.stringify({ framework: 'next', themeFile: 'lib/theme/theme.ts' }));
    expect(locateWebTheme(root)).toBe(path.join(root, 'lib', 'theme', 'theme.ts'));
    const r = await deepenWebTokens(root, {});
    expect(r.themeFile).toBe('lib/theme/theme.ts');
    const home = await fs.readFile(path.join(root, 'app', '(tabs)', '10-2', 'page.tsx'), 'utf8');
    expect(home).toMatch(/import \{ AppTheme \} from '@\/lib\/theme\/theme';/);   // the page already imports via @/ — the alias is reused
    expect(home).toMatch(/fill=\{AppTheme\.color\.brand\}/);
    expect(home).toMatch(/^\/\/ canonicalId: c_10_2 route: \/10-2\n'use client';/);
    const again = await deepenWebTokens(root, {});
    expect(again.changes).toEqual([]);
  });
});

// ── 7a ────────────────────────────────────────────────────────────────────────
import { extractComponents } from '../src/relay-server/passes/component-extraction';
import { __test as xweb } from '../src/relay-server/passes/component-extraction-web';

describe('7a web extraction writes self-sufficient modules (PG-07, PG-08)', () => {
  it('react: an exported duplicate is re-exported once; carried imports are re-pathed; unused screen imports dropped; importers repointed', async () => {
    const root = await fixture('react');
    // Another module imports the screen's exported Badge — it must follow the hoist.
    await fs.writeFile(path.join(root, 'src', 'screens', 'Extra.tsx'), "import { Badge } from './IPhone1415Pro57Screen';\nexport const X = () => <Badge label=\"x\" />;\n");
    const r = await extractComponents('p', { projectRoot: root, noAiConfirm: true });
    expect(r.extracted.map((e) => e.name).sort()).toEqual(['Badge', 'SearchGlyph', 'SectionHeading']);
    const badge = await fs.readFile(path.join(root, 'src', 'components', 'Badge.tsx'), 'utf8');
    expect(badge).toMatch(/^export function Badge\(/m);
    expect(badge).not.toMatch(/export\s+export/);
    expect(badge).not.toMatch(/import React/);   // react-jsx + noUnusedLocals: an unused React import fails tsc
    expect(await fs.readFile(path.join(root, 'src', 'components', 'SearchGlyph.tsx'), 'utf8')).toMatch(/import \{ assets \} from '\.\.\/resources\/assets';/);
    const settings = await fs.readFile(path.join(root, 'src', 'screens', 'IPhone1415Pro57Screen.tsx'), 'utf8');
    expect(settings).not.toMatch(/resources\/assets/);          // only SearchGlyph used it
    expect(await fs.readFile(path.join(root, 'src', 'screens', 'Home', 'HomeScreen.tsx'), 'utf8')).toMatch(/resources\/assets/);   // still used (bannerKey)
    expect(await fs.readFile(path.join(root, 'src', 'screens', 'Extra.tsx'), 'utf8')).toMatch(/import \{ Badge \} from '\.\.\/components\/Badge';/);
    expect(r.rejected[0].reason).toMatch(/near-duplicate/);
    const again = await extractComponents('p', { projectRoot: root, noAiConfirm: true });
    expect(again.extracted).toEqual([]);
  });

  it('next: pages are read, the component lands in components/ with use client, a helper-dependent body bails with a reason', async () => {
    const root = await fixture('next');
    const r = await extractComponents('p', { projectRoot: root, noAiConfirm: true });
    expect(r.componentsDir).toBe(path.join(root, 'components'));
    const heading = await fs.readFile(path.join(root, 'components', 'SectionHeading.tsx'), 'utf8');
    expect(heading.startsWith("'use client';\n")).toBe(true);
    const settings = await fs.readFile(path.join(root, 'app', '10-3', 'page.tsx'), 'utf8');
    expect(settings).toMatch(/^\/\/ canonicalId: c_10_3 route: \/10-3\n'use client';/);
    expect(settings).not.toMatch(/^function SectionHeading/m);

    const root2 = await fixture('next');
    for (const f of ['app/(tabs)/10-2/page.tsx', 'app/10-3/page.tsx']) {
      const p = path.join(root2, f);
      await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace('function SectionHeading', 'const GAP = 8;\nfunction SectionHeading').replace('marginBottom: 8', 'marginBottom: GAP'));
    }
    const r2 = await extractComponents('p', { projectRoot: root2, noAiConfirm: true });
    expect(r2.rejected.find((x) => x.names.includes('SectionHeading'))?.reason).toMatch(/uses `GAP` declared in/);
    expect(fsSync.existsSync(path.join(root2, 'components', 'SectionHeading.tsx'))).toBe(false);
  });

  it('import bindings round-trip (default, named, aliased, namespace, type)', () => {
    const b = xweb.parseImportBindings("import React, { useState as uS, type FC } from 'react';\nimport * as z from './z';\nimport type { T } from '@/t';\n");
    expect(b.map((x) => `${x.local}<${x.imported}${x.typeOnly ? ':t' : ''}`)).toEqual(['React<default', 'uS<useState', 'FC<FC:t', 'z<*', 'T<T:t']);
    expect(xweb.dropImportBindings("import React, { useState as uS } from \"react\";\nconst a = 1;\n", new Set(['uS']))).toBe("import React from \"react\";\nconst a = 1;\n");
  });
});

describe('7a flutter parameters are named after their named-argument key (CONTRACTS §5)', () => {
  it('colour inside BoxDecoration(color: const Color(…)) → a typed `Color color`, call sites pass the whole value', async () => {
    const root = await fixture('flutter');
    await extractComponents('p', { projectRoot: root, noAiConfirm: true });
    const pill = await fs.readFile(path.join(root, 'lib', 'components', 'pill_button.dart'), 'utf8');
    expect(pill).toMatch(/final Color color;/);
    expect(pill).toMatch(/BoxDecoration\(color: color,/);
    expect(pill).not.toMatch(/\bp\d+\b/);
    expect(await fs.readFile(path.join(root, 'lib', 'screens', 'login_screen.dart'), 'utf8')).toMatch(/PillButton\(label: 'Sign in', color: const Color\(0xFF12AE89\)\)/);
  });
  it('a differing fontSize → `fontSize`; a positional Text value → `text`', async () => {
    const root = await fixture('flutter');
    const tile = (size: number, t: string) => `\nclass _Tile extends StatelessWidget {\n  const _Tile();\n  @override\n  Widget build(BuildContext context) {\n    return Padding(padding: const EdgeInsets.all(4), child: Text('${t}', style: TextStyle(fontSize: ${size})));\n  }\n}\n`;
    await fs.appendFile(path.join(root, 'lib', 'screens', 'login_screen.dart'), tile(14, 'A'));
    await fs.appendFile(path.join(root, 'lib', 'screens', 'screen_10_4.dart'), tile(18, 'B'));
    await extractComponents('p', { projectRoot: root, noAiConfirm: true });
    const src = await fs.readFile(path.join(root, 'lib', 'components', 'tile.dart'), 'utf8');
    expect(src).toMatch(/final String text;/);
    expect(src).toMatch(/final double fontSize;/);
    expect(src).not.toMatch(/\bp\d+\b/);
  });
});

// ── 7b / 7d ───────────────────────────────────────────────────────────────────
import { dartPresentation, stripDartPresenterDeclarations } from '../src/relay-server/passes/dart-presenters';
import { detectWebPresentation } from '../src/relay-server/passes/modal-overlay-web';
import { applyModalOverlays } from '../src/relay-server/passes/modal-overlay';
import { verifyFlowWiring } from '../src/relay-server/passes/flow-wiring';

describe('7b/7d: a presenter DECLARATION is not a presentation (PG-11)', () => {
  it('dart: the showDialog inside `void showModal_10_8(ctx) {…}` does not count; a call from a control does', () => {
    const decl = "void showModal_10_8(BuildContext context) {\n  showDialog<void>(context: context, builder: (_) => const AlertDialog());\n}\n";
    expect(dartPresentation(decl, 'm_10_8')).toMatchObject({ presenterCalls: 0, inlineCalls: 0, declared: true });
    const called = `${decl}Widget b(BuildContext context) => TextButton(onPressed: () => showModal_10_8(context), child: const Text('Log out'));\n`;
    expect(dartPresentation(called, 'm_10_8')).toMatchObject({ presenterCalls: 1, inlineCalls: 0 });
    const arrow = "Future<void> showModal_1_2(BuildContext c) async => showModalBottomSheet(context: c, builder: (_) => const SizedBox());\n";
    expect(stripDartPresenterDeclarations(arrow).trim()).toBe('');
    const inline = "onPressed: () => showModalBottomSheet(context: context, builder: (_) => const Sheet()),";
    expect(dartPresentation(inline, 'm_9_9')).toMatchObject({ presenterCalls: 0, inlineCalls: 1, inlineApi: 'showModalBottomSheet' });
  });

  it('flutter 7b reports the preview-only modal as a REAL gap naming the declaration', async () => {
    const root = await fixture('flutter');
    const r = await applyModalOverlays('p', { projectRoot: root, noAi: true, dryRun: true });
    expect(r.transformed.find((t) => t.canonicalId === 'm_10_8')).toBeUndefined();
    expect(r.skipped.find((s) => s.canonicalId === 'm_10_8')?.reason).toMatch(/REAL gap — base screen screen_10_3\.dart declares showModal_10_8\(\) but no control on it calls it/);
  });
});

describe('7b web: presentation is read from the markup; Next strips the modal frame dir (PG-09, PG-10)', () => {
  it('detects bottomSheet / fullOverlay / dialog / unknown', () => {
    const mk = (style: string) => `export function Sheet() { return <div ${style}>x</div>; }\nexport function showModal_1_2() {\n  modalController.open('m_1_2', <Sheet />);\n}\n`;
    expect(detectWebPresentation(mk("style={{ position: 'absolute', bottom: 0 }}"), 'showModal_1_2')).toBe('bottomSheet');
    expect(detectWebPresentation(mk("style={{ position: 'fixed', inset: 0 }}"), 'showModal_1_2')).toBe('fullOverlay');
    expect(detectWebPresentation(mk('role="dialog"'), 'showModal_1_2')).toBe('dialog');
    expect(detectWebPresentation(mk('className="x"'), 'showModal_1_2')).toBe('unknown');
  });
  it('next: app/10-9 (placeholder-only, unlinked) is removed; a linked one is kept; run 2 is a no-op', async () => {
    const root = await fixture('next');
    const r = await applyModalOverlays('p', { projectRoot: root, noAi: true });
    const t = r.transformed.find((x) => x.canonicalId === 'm_10_9');
    expect(t).toMatchObject({ presentation: 'dialog', removedRoute: '/10-9', trigger: { wired: 'none' } });
    expect(fsSync.existsSync(path.join(root, 'app', '10-9'))).toBe(false);
    const again = await applyModalOverlays('p', { projectRoot: root, noAi: true });
    expect(again.transformed.find((x) => x.canonicalId === 'm_10_9')?.removedRoute).toBeUndefined();

    const root2 = await fixture('next');
    await fs.appendFile(path.join(root2, 'app', '10-1', 'page.tsx'), "\nexport const LINK = '/10-9';\n");
    await applyModalOverlays('p', { projectRoot: root2, noAi: true });
    expect(fsSync.existsSync(path.join(root2, 'app', '10-9', 'page.tsx'))).toBe(true);
  });
});

describe('7d next: layout-hosted tabs and the useRouter auto-fix (PG-13, PG-14); flutter stubs (PG-12)', () => {
  it('next: the (tabs) layout hosts the tab; the dead Settings button is wired with router.push', async () => {
    const root = await fixture('next');
    const r = await verifyFlowWiring('p', { projectRoot: root, noAi: true });
    const f = (to: string) => r.report.findings.find((x) => x.to === to)!;
    expect(f('c_10_4')).toMatchObject({ status: 'wired' });
    expect(f('c_10_4').detail).toMatch(/app\/\(tabs\)\/layout\.tsx hosts/);
    expect(f('c_10_3')).toMatchObject({ status: 'wired', autoFixed: true });
    expect(await fs.readFile(path.join(root, 'app', '(tabs)', '10-2', 'page.tsx'), 'utf8')).toMatch(/<button onClick=\{\(\) => router\.push\('\/10-3'\)\}>Settings<\/button>/);
  });
  it('next: no useRouter in scope → reported, not wired', async () => {
    const root = await fixture('next');
    const p = path.join(root, 'app', '(tabs)', '10-2', 'page.tsx');
    await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace('const router = useRouter();', '').replace("router.push('/10-5')", "location.assign('/10-5')"));
    const r = await verifyFlowWiring('p', { projectRoot: root, noAi: true });
    expect(r.report.findings.find((x) => x.to === 'c_10_3')?.detail).toMatch(/no `const router = useRouter\(\)`/);
  });
  it('flutter: an edge to a skeleton stub is missing (HIGH), not wired', async () => {
    const root = await fixture('flutter');
    const r = await verifyFlowWiring('p', { projectRoot: root, noAi: true, dryRun: true });
    const e3 = r.report.findings.find((x) => x.to === 'c_10_5')!;
    expect(e3.status).toBe('missing');
    expect(e3.detail).toMatch(/^HIGH: .*still the skeleton stub/);
  });
});

// ── 7e ────────────────────────────────────────────────────────────────────────
import { renameSemantic } from '../src/relay-server/passes/semantic-rename';
import { __test as rweb } from '../src/relay-server/passes/semantic-rename-web';

describe('7e rename: react components/files/keys, Next directories, headers in the same transaction (PG-19..21)', () => {
  it('flutter: the renamed screen header names the served route; run 2 renames nothing', async () => {
    const root = await fixture('flutter');
    await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    expect((await fs.readFile(path.join(root, 'lib', 'screens', 'settings_screen.dart'), 'utf8')).split('\n')[0]).toBe('// canonicalId: c_10_3  route: /settings');
    const again = await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    expect(again.report.renames).toEqual([]);
    expect(fsSync.existsSync(path.join(root, 'lib', 'screens', 'settings_2_screen.dart'))).toBe(false);
  });

  it('react: machine component + file + ROUTES key renamed; importers (App.tsx, the preview) follow; run 2 is a no-op', async () => {
    const root = await fixture('react');
    const r = await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    const s = r.report.renames.find((x) => x.canonicalId === 'c_10_3')!;
    expect(s).toMatchObject({ newFile: 'src/screens/SettingsScreen.tsx', newClass: 'SettingsScreen', oldRouteConst: 'c103', newRouteConst: 'settings', newRoutePath: '/settings' });
    const app = await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/import \{ SettingsScreen \} from '\.\/screens\/SettingsScreen';/);
    expect(app).toMatch(/<Route path=\{ROUTES\.settings\} element=\{<SettingsScreen \/>\} \/>/);
    // A frame-code canonical name ('283:1967') uses the pipeline's own semantic ROUTES key.
    expect(r.report.renames.find((x) => x.canonicalId === 'c_10_4')).toMatchObject({ newClass: 'ProfileScreen', newRoutePath: '/profile' });
    expect(await fs.readFile(path.join(root, 'src', 'screens', 'SettingsPreview.tsx'), 'utf8')).toMatch(/from '\.\/SettingsScreen'/);
    const again = await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    expect(again.report.renames).toEqual([]);
  });

  it('next: app/10-3 moves to app/settings in place, literals + header follow, the preview import is re-pointed, a generic `Page` elsewhere is untouched', async () => {
    const root = await fixture('next');
    const other = "export default function Page() { return null; }\n";
    await fs.mkdir(path.join(root, 'app', 'about'), { recursive: true });
    await fs.writeFile(path.join(root, 'app', 'about', 'page.tsx'), other);
    await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    expect(fsSync.existsSync(path.join(root, 'app', '10-3'))).toBe(false);
    const settings = await fs.readFile(path.join(root, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(settings.split('\n')[0]).toBe('// canonicalId: c_10_3 route: /settings');
    expect(settings).toMatch(/export default function SettingsPage\(\)/);
    expect(settings).toMatch(/router\.push\('\/login'\)/);
    expect(fsSync.existsSync(path.join(root, 'app', '(tabs)', 'home', 'page.tsx'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'app', '_preview', '10-3', 'page.tsx'), 'utf8')).toMatch(/from '\.\.\/\.\.\/settings\/page'/);
    expect(await fs.readFile(path.join(root, 'app', 'about', 'page.tsx'), 'utf8')).toBe(other);
    const again = await renameSemantic('p', { projectRoot: root, noAi: true, noReport: true });
    expect(again.report.renames).toEqual([]);
  });

  it('header sync + alias specifier rewrite', () => {
    expect(rweb.syncHeader("// canonicalId: c_1_2 route: /1-2\n'use client';\n", 'c_1_2', '/x').src).toBe("// canonicalId: c_1_2 route: /x\n'use client';\n");
    expect(rweb.syncHeader("'use client';\n", 'c_1_2', '/x')).toEqual({ src: "// canonicalId: c_1_2 route: /x\n'use client';\n", stamped: true });
    expect(rweb.replaceRouteLiteral("push('/10-3'); push('/10-3/edit'); push('/10-30')", '/10-3', '/settings')).toBe("push('/settings'); push('/settings/edit'); push('/10-30')");
  });
});

describe('ensureNamedImport keeps a directive prologue first (found by the real next build gate)', () => {
  it("inserts after 'use client' when the module has no imports yet", async () => {
    const { ensureNamedImport } = await import('../src/relay-server/passes/web-app');
    const src = "'use client';\n// extracted by relay-server phase 7a\n\nexport function A() { return null; }\n";
    const out = ensureNamedImport(src, 'AppTheme', '../lib/theme');
    expect(out.startsWith("'use client';\nimport { AppTheme } from '../lib/theme';\n")).toBe(true);
    const hdr = "// canonicalId: c_1 route: /x\n'use client';\nexport default function P() { return null; }\n";
    expect(ensureNamedImport(hdr, 'X', './x').split('\n').slice(0, 3)).toEqual(['// canonicalId: c_1 route: /x', "'use client';", "import { X } from './x';"]);
    expect(ensureNamedImport('const a = 1;\n', 'X', './x')).toBe("import { X } from './x';\nconst a = 1;\n");
  });
});
