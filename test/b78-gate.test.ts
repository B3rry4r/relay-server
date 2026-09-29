// =============================================================================
// B78 readability F7 — the WARN-ONLY per-screen gate in the build loop.
//
// The loop measures the files a screen's manifest names, records the findings on
// the run screen + result.json, and hands them to the fix prompt. It never parks or
// demotes a screen. These pin the three pieces the loop composes, for flutter,
// react and next.
// =============================================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readabilityScreenFiles, fixPrompt } from '../src/relay-server/ai-screen-loop';
import { screenReadabilityFindings, readabilityFixBlock } from '../src/relay-server/readability';

const FIX = path.join(__dirname, 'fixtures', 'readability');

function copy(fw: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b78-gate-${fw}-`));
  fs.cpSync(path.join(FIX, fw), dir, { recursive: true });
  return dir;
}

const SCREEN: Record<string, { entry: string; extra: string[] }> = {
  flutter: { entry: 'lib/screens/frame_12_screen.dart', extra: ['lib/_preview/frame_12_screen_preview.dart', 'lib/theme/app_theme.dart', 'lib/main.dart'] },
  react: { entry: 'src/screens/Frame12Screen.tsx', extra: ['src/theme/theme.js', 'src/App.tsx'] },
  next: { entry: 'app/settings/page.tsx', extra: ['app/layout.tsx'] },
};

describe('F7 per-screen readability gate (warn-only)', () => {
  for (const fw of ['flutter', 'react', 'next'] as const) {
    it(`${fw}: measures the manifest's screen files, not the scaffolding`, () => {
      const root = copy(fw);
      try {
        const s = SCREEN[fw];
        const files = readabilityScreenFiles(root, { entry: s.entry, files: [s.entry, ...s.extra, '../outside.dart', '/abs/x.dart', 'missing/Nope.tsx'] });
        expect(files).toEqual([s.entry]);
        const r = screenReadabilityFindings(root, fw, files);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.files).toEqual([s.entry]);
        // each fixture screen carries at least one real readability smell
        expect(r.findings.length).toBeGreaterThan(0);
        for (const f of r.findings) expect(f.file).toBe(s.entry);
        const block = readabilityFixBlock(r);
        expect(block).toMatch(/^READABILITY \(advisory/);
        expect(block).toContain(s.entry);
        const prompt = fixPrompt('1:2', 'Screen', 'ref.png', 'cand.png', { match: false, score: 70, discrepancies: [{ issue: 'x', severity: 'med' }], recommendation: 'fix' }, undefined, block);
        expect(prompt).toContain(block);
        // the visual discrepancies stay first: readability is advisory
        expect(prompt.indexOf('1. [med] x')).toBeLessThan(prompt.indexOf('READABILITY'));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('flutter: names the provenance comment, the do-nothing handler and the inline colour with their lines', () => {
    const root = copy('flutter');
    try {
      const r = screenReadabilityFindings(root, 'flutter', ['lib/screens/frame_12_screen.dart']);
      if (!r.ok) throw new Error(r.reason);
      const codes = r.findings.map((f) => f.code).sort();
      expect(codes).toEqual(expect.arrayContaining(['figma-leak-comment', 'inline-colors', 'noop-handler']));
      expect(r.findings.find((f) => f.code === 'figma-leak-comment')!.lines.join('\n')).toMatch(/frame 64/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a clean screen adds nothing to the fix prompt', () => {
    expect(readabilityFixBlock({ ok: true, findings: [], files: ['a.dart'] })).toBe('');
    expect(readabilityFixBlock({ ok: false, reason: 'tool missing' })).toBe('');
    const p = fixPrompt('1:2', 'S', 'r.png', 'c.png', { match: false, discrepancies: [], recommendation: 'fix' }, undefined, '');
    expect(p).not.toContain('READABILITY');
  });
});
