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
    expect(home).toMatch(/import \{ AppTheme \} from '\.\.\/\.\.\/\.\.\/lib\/theme\/theme';/);
    expect(home).toMatch(/fill=\{AppTheme\.color\.brand\}/);
    expect(home).toMatch(/^\/\/ canonicalId: c_10_2 route: \/10-2\n'use client';/);
    const again = await deepenWebTokens(root, {});
    expect(again.changes).toEqual([]);
  });
});
