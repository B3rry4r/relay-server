// scripts/readability-report.cjs — pinned against small synthetic generated apps
// (test/fixtures/readability/{flutter,react,next}). Every expected number below was
// derived by hand from the fixture source, then confirmed against the script, so a
// heuristic change that shifts a count fails here instead of silently moving a
// baseline.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';
import { spawnSync } from 'child_process';

const req = createRequire(__filename);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rr = req('../scripts/readability-report.cjs');

const FIX = path.join(__dirname, 'fixtures', 'readability');
const run = (fw: string) => rr.analyzeProject(path.join(FIX, fw), { minDupTokens: 20, tools: false });

describe('readability-report — flutter fixture', () => {
  const r = run('flutter');
  const t = r.totals;

  it('detects the framework from pubspec.yaml', () => {
    expect(r.framework).toBe('flutter');
    expect(t.files).toBe(7);
  });

  it('counts machine names in identifiers, strings, import paths and file names', () => {
    // main.dart: Frame12Screen + 'screens/frame_12_screen.dart'            = 2
    // frame_12_screen.dart: class + ctor + 'Group 4' + its own file name  = 4
    // _preview entry: ident + import path + file name                    = 3
    // components/cmp_other_17.dart (skeleton stub file name)             = 1
    expect(t.machineNames).toBe(10);
    expect(r.deliverable.machineNames).toBe(7); // preview scaffolding excluded
    expect(t.rawNodeIds).toBe(0); // the `// canonicalId:` header is a pipeline marker, not code
    expect(t.numericSuffixNames).toBe(1); // ink2
  });

  it('separates use-site colour literals, file-local palettes and theme tokens', () => {
    expect(t.inlineColors).toBe(1); // color: const Color(0xFF12AE89)
    expect(t.fileLocalColorConsts).toBe(1); // static const Color _accent = Color(…)
    expect(t.materialColors).toBe(4); // Colors.black ×2 per screen
    // app_theme.dart defines two Color literals — exempt, that is where they belong
    expect(r.byCategory.theme.inlineColors).toBe(0);
  });

  it('counts layout magic numbers and Figma fractionals', () => {
    // frame_12: left 24, top 103.25, width 45, height 45, all(12), size 24, width 8, fontSize 14
    // profile:  all(12), size 24, width 8, fontSize 14
    expect(t.magicNumbers).toBe(12);
    expect(t.figmaFractionals).toBe(1); // 103.25
  });

  it('measures widget nesting (value types like EdgeInsets/TextStyle excluded)', () => {
    const f = r.files.find((x: any) => x.path === 'lib/screens/frame_12_screen.dart');
    expect(f.metrics.maxNesting).toBe(5); // Scaffold > Stack > Positioned > Container > Text
    expect(t.maxNesting).toBe(5);
  });

  it('finds the duplicated _BackButton subtree once (maximal clone only)', () => {
    expect(t.duplication.groups).toBe(1);
    expect(t.duplication.occurrences).toBe(2);
    expect(r.duplicates[0].occurrences.map((o: any) => o.file).sort())
      .toEqual(['lib/screens/frame_12_screen.dart', 'lib/screens/profile_screen.dart']);
    expect(t.repeatedPrivateWidgets.names).toBe(1);
    expect(t.repeatedPrivateWidgets.top[0]).toEqual({ name: '_BackButton', files: 2 });
  });

  it('flags no-op handlers, unused project imports, positioning and noise comments', () => {
    expect(t.noopHandlers).toBe(2); // onPressed: () {}, onTap: () {}
    expect(t.unusedImports).toBe(1); // ../widgets/unused_helper.dart
    expect(t.positioned).toBe(1);
    expect(t.stacks).toBe(1);
    expect(t.comments.figmaLeak).toBe(1); // "(frame 64, IR "Rectangle 7")"
    expect(t.comments.commentedOutCode).toBe(1); // // final old = OldWidget();
    expect(t.comments.pipelineMarker).toBe(3); // canonicalId header + GENERATED + componentId
  });

  it('reports skeleton stubs and files unreachable from main.dart', () => {
    expect(t.stubBody).toBe(2); // unused_helper + cmp_other_17 both build SizedBox.shrink()
    expect(t.reachability.unreachableFiles).toBe(1);
    expect(t.reachability.sample).toEqual(['lib/components/cmp_other_17.dart']);
  });

  it('never runs external tools when told not to', () => {
    expect(r.diagnostics.ran).toBe(false);
  });
});

describe('readability-report — react fixture', () => {
  const r = run('react');
  const t = r.totals;

  it('detects react from package.json', () => {
    expect(r.framework).toBe('react');
  });

  it('survives apostrophes in JSX text (tokenizer does not open a string)', () => {
    const f = r.files.find((x: any) => x.path === 'src/screens/ProfileScreen.tsx');
    expect(f.metrics.maxNesting).toBe(2);
    expect(f.metrics.unusedImports).toBe(1); // AppTheme
  });

  it('counts machine names in JSX text, asset paths, identifiers and file names', () => {
    // App.tsx Frame12Screen ×2; Frame12Screen.tsx: ident + 'Group 4' + vector_10_20.svg + file name
    expect(t.machineNames).toBe(6);
  });

  it('counts hex/rgba literals incl. tailwind arbitrary values; hoisted consts separately', () => {
    expect(t.inlineColors).toBe(3); // text-[#1a1a1a] ×2, rgba(…)
    expect(t.fileLocalColorConsts).toBe(1); // const BRAND = '#12ae89'
    expect(r.byCategory.theme.inlineColors).toBe(0);
  });

  it('counts px/arbitrary tailwind values and numeric style props', () => {
    expect(t.magicNumbers).toBe(11);
    expect(t.figmaFractionals).toBe(1); // fontSize: 21.94
  });

  it('flags no-op and console-only handlers, unused imports, absolute layers', () => {
    expect(t.noopHandlers).toBe(1);
    expect(t.stubHandlers).toBe(1);
    expect(t.unusedImports).toBe(2); // useState, AppTheme
    expect(t.positioned).toBe(1);
    expect(t.comments.commentedOutCode).toBe(1); // {/* <OldWidget /> */}
    expect(t.comments.figmaLeak).toBe(1);
  });

  it('finds the duplicated JSX subtree and the repeated local component', () => {
    expect(t.duplication.groups).toBe(1);
    expect(t.repeatedPrivateWidgets.top[0]).toEqual({ name: 'BackButton', files: 2 });
  });

  it('reports files unreachable from src/main.tsx', () => {
    expect(t.reachability.sample).toEqual(['src/components/Unused.tsx']);
  });
});

describe('readability-report — next fixture', () => {
  const r = run('next');
  const t = r.totals;

  it('detects next distinctly from react', () => {
    expect(r.framework).toBe('next');
  });

  it('treats app/**/page.tsx and layout.tsx as entry roots', () => {
    expect(t.reachability.entryRoots).toBe(3);
    expect(t.reachability.unreachableFiles).toBe(0);
  });

  it('measures nesting through expression containers ({items.map(…)})', () => {
    const f = r.files.find((x: any) => x.path === 'app/page.tsx');
    expect(f.metrics.maxNesting).toBe(3); // div > div > Card
  });

  it('counts the page-level machine name, literals and handlers', () => {
    expect(t.machineNames).toBe(1); // IPhone1415Pro57Page
    expect(t.inlineColors).toBe(2); // bg-[#f4f4f4], border-[#e7e7e7]
    expect(t.magicNumbers).toBe(3); // p-[13px] ×2, rounded-[12px]
    expect(t.noopHandlers).toBe(1); // onClick={() => undefined}
    expect(t.unusedImports).toBe(1); // Link
  });
});

describe('readability-report — helpers + CLI', () => {
  it('only treats counters on generic stems as meaningless', () => {
    expect(rr.isNumericSuffixName('ink2')).toBe(true);
    expect(rr.isNumericSuffixName('neutral3')).toBe(true);
    expect(rr.isNumericSuffixName('divider_2')).toBe(true);
    expect(rr.isNumericSuffixName('s16')).toBe(false); // value-encoded scale token
    expect(rr.isNumericSuffixName('title24')).toBe(false);
    expect(rr.isNumericSuffixName('w600')).toBe(false);
  });

  it('CLI emits parseable JSON whose totals equal the API result', () => {
    const script = path.join(__dirname, '..', 'scripts', 'readability-report.cjs');
    const out = spawnSync(process.execPath, [script, path.join(FIX, 'flutter'), '--min-dup-tokens', '20', '--no-tools'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const j = JSON.parse(out.stdout);
    expect(j.totals.machineNames).toBe(10);
    expect(j.totals.magicNumbers).toBe(12);
    expect(j.files.length).toBe(7);
  });

  it('compare() reports only changed totals', () => {
    const a = run('flutter');
    const b = JSON.parse(JSON.stringify(a));
    b.totals.inlineColors = 0;
    const diff: string = rr.compare(a, b);
    expect(diff).toMatch(/inlineColors\s+1 →\s+0\s+-1/);
    expect(diff.split('\n').length).toBe(1);
  });
});
