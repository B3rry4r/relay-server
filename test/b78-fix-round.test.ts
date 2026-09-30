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
