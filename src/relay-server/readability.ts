// =============================================================================
// File: src/relay-server/readability.ts
//
// Readability MEASUREMENT for the pipeline (lane B78, F7 + F9). The metrics live in
// ONE place — src/relay-server/readability-report.cjs (zero-dep, flutter + react +
// next; CLI: scripts/readability-report.cjs) —
// and this module is the runtime's door to it:
//
//  - F9: `measureReadability` + `readabilityDelta` give finalize a before/after
//    block in `.uix/finalize-report.json`. Phase 7 used to count its own
//    operations, so a pass that changed nothing read exactly like one that fixed
//    everything (Ping: "5 applied", `git diff -- lib` empty).
//  - F7: `screenReadabilityFindings` is the WARN-ONLY per-screen gate the build loop
//    runs next to the reconciliation gate: its findings are recorded on the run and
//    handed to the fix prompt, and it never parks a run.
//
// The script is resolved at runtime (it is copied into dist/scripts by
// `npm run build`). When it cannot be found the caller gets `{ok:false, reason}` —
// a missing measurement is reported, never read as "clean".
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { scanBuiltComponents } from './component-contract';

interface ReadabilityTool {
  analyzeProject: (root: string, opts?: { framework?: string; tools?: boolean; details?: boolean }) => any;
  analyzeFile: (root: string, rel: string, framework: string, ctx: Record<string, unknown>) => any;
  VERSION?: number;
}

let cached: { tool: ReadabilityTool | null; reason?: string; file?: string } | null = null;

/** Locate + load the readability metric. It sits next to this module in src/ and —
 *  tsc allowJs — in dist/src, so a release that ships dist/src only still has it.
 *  The repo CLI wrapper is the fallback for an unusual layout. */
export function loadReadabilityTool(): { tool: ReadabilityTool | null; reason?: string; file?: string } {
  if (cached) return cached;
  const candidates = [
    path.resolve(__dirname, 'readability-report.cjs'),
    path.resolve(__dirname, '..', '..', 'scripts', 'readability-report.cjs'),
  ];
  const file = candidates.find((c) => fs.existsSync(c));
  if (!file) {
    cached = { tool: null, reason: `readability-report.cjs not found (looked in ${candidates.join(', ')})` };
    return cached;
  }
  try {
    const req = createRequire(__filename);
    cached = { tool: req(file) as ReadabilityTool, file };
  } catch (e) {
    cached = { tool: null, reason: `readability-report.cjs failed to load: ${(e as Error).message}` };
  }
  return cached;
}

/** The totals a finalize report records — the audit's headline metrics. */
export interface ReadabilityMetrics {
  files: number;
  loc: number;
  screenLocP50: number;
  screenLocMax: number;
  filesOver300: number;
  machineNames: number;
  numericSuffixNames: number;
  inlineColors: number;
  fileLocalColorConsts: number;
  magicNumbers: number;
  magicPerKloc: number;
  figmaLeakComments: number;
  noiseComments: number;
  noopHandlers: number;
  handDrawn: number;
  privateWidgets: number;
  repeatedPrivateNames: number;
  redundantPrivateDefinitions: number;
  duplicateGroups: number;
  duplicateRedundantTokens: number;
  stubBodies: number;
  unreachableFiles: number | null;
  themeColorTokens: number | null;
  themeSingleUseColors: number | null;
  themeNearDuplicatePairs: number | null;
  componentImporters: number;
}

export type Measured = { ok: true; tool: string; metrics: ReadabilityMetrics } | { ok: false; reason: string };

/** Files (outside the components dir) that import a shared component. */
function countComponentImporters(root: string, framework: string): number {
  const fw = (framework || 'flutter').toLowerCase();
  const web = fw === 'react' || fw === 'next';
  const dirs = web ? ['src', 'app', 'components', 'lib', 'pages'] : ['lib'];
  let n = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|_preview|%5Fpreview|components|\.next)$/.test(e.name)) walk(p); continue; }
      if (!(web ? /\.(tsx?|jsx?)$/ : /\.dart$/).test(e.name)) continue;
      let src = '';
      try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (web ? /from\s*['"][^'"]*\/components\/[^'"]+['"]/.test(src) : /^import\s+['"][^'"]*components\/[^'"]+\.dart['"]/m.test(src)) n++;
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return n;
}

export function measureReadability(projectRoot: string, framework: string): Measured {
  const { tool, reason, file } = loadReadabilityTool();
  if (!tool) return { ok: false, reason: reason ?? 'readability tool unavailable' };
  try {
    const r = tool.analyzeProject(projectRoot, { framework, tools: false });
    const t = r.deliverable ?? r.totals;
    const all = r.totals;
    const screens = r.byCategory?.screen;
    const theme = all.theme ?? {};
    const metrics: ReadabilityMetrics = {
      files: t.files,
      loc: t.loc,
      screenLocP50: screens?.locDistribution?.p50 ?? 0,
      screenLocMax: screens?.locDistribution?.max ?? 0,
      filesOver300: t.locDistribution?.over300 ?? 0,
      machineNames: t.machineNames,
      numericSuffixNames: t.numericSuffixNames,
      inlineColors: t.inlineColors,
      fileLocalColorConsts: t.fileLocalColorConsts,
      magicNumbers: t.magicNumbers,
      magicPerKloc: t.perKloc?.magicNumbers ?? 0,
      figmaLeakComments: t.comments?.figmaLeak ?? 0,
      noiseComments: t.comments?.noise ?? 0,
      noopHandlers: t.noopHandlers,
      handDrawn: t.handDrawn,
      privateWidgets: t.privateWidgets,
      repeatedPrivateNames: all.repeatedPrivateWidgets?.names ?? 0,
      redundantPrivateDefinitions: all.repeatedPrivateWidgets?.redundantDefinitions ?? 0,
      duplicateGroups: all.duplication?.groups ?? 0,
      duplicateRedundantTokens: all.duplication?.redundantTokens ?? 0,
      stubBodies: t.stubBody,
      unreachableFiles: all.reachability?.unreachableFiles ?? null,
      themeColorTokens: theme.themeFiles ? theme.colorTokens ?? null : null,
      themeSingleUseColors: theme.themeFiles ? theme.singleUseColorTokens ?? null : null,
      themeNearDuplicatePairs: theme.themeFiles ? theme.nearDuplicatePairs ?? null : null,
      componentImporters: countComponentImporters(projectRoot, framework),
    };
    return { ok: true, tool: `readability-report v${r.version ?? '?'} (${path.basename(file ?? '')})`, metrics };
  } catch (e) {
    return { ok: false, reason: `readability-report threw: ${(e as Error).message}` };
  }
}

export interface ReadabilityDeltaBlock {
  tool?: string;
  before: ReadabilityMetrics | null;
  after: ReadabilityMetrics | null;
  /** after − before, per metric (only metrics that changed). */
  delta: Record<string, number>;
  /** true when every metric is unchanged — the run did not move readability. */
  unchanged: boolean;
  /** set when a side could not be measured. */
  unmeasured?: string;
}

export function readabilityDelta(before: Measured, after: Measured): ReadabilityDeltaBlock {
  if (!before.ok || !after.ok) {
    return {
      before: before.ok ? before.metrics : null, after: after.ok ? after.metrics : null, delta: {}, unchanged: false,
      unmeasured: !before.ok ? `before: ${before.reason}` : `after: ${(after as { reason: string }).reason}`,
    };
  }
  const delta: Record<string, number> = {};
  for (const k of Object.keys(after.metrics) as Array<keyof ReadabilityMetrics>) {
    const a = before.metrics[k]; const b = after.metrics[k];
    if (typeof a === 'number' && typeof b === 'number' && a !== b) delta[k] = Math.round((b - a) * 10) / 10;
  }
  return { tool: after.tool, before: before.metrics, after: after.metrics, delta, unchanged: Object.keys(delta).length === 0 };
}

// ── F7: the per-screen readability gate (WARN-ONLY) ──────────────────────────

export const READABILITY_BUDGET = {
  /** a screen file longer than this should be split into components. */
  screenLoc: 400,
  /** layout literals per 1000 LOC of a screen. */
  magicPerKloc: 60,
};

export interface ReadabilityFinding {
  code: 'screen-too-long' | 'figma-leak-comment' | 'noop-handler' | 'magic-numbers' | 'duplicates-component' | 'hand-drawn' | 'inline-colors' | 'machine-name';
  file: string;
  message: string;
  /** offending lines (`<line>: <text>`), capped. */
  lines: string[];
}

export interface ScreenReadability { ok: true; findings: ReadabilityFinding[]; files: string[] }

/**
 * Measure the files of ONE just-built screen against the readability budget. Never
 * throws; never blocks (the caller records + feeds the findings to the fix prompt).
 * `files` are project-relative. Returns `{ok:false}` when the tool is unavailable.
 */
export function screenReadabilityFindings(projectRoot: string, framework: string, files: string[]): ScreenReadability | { ok: false; reason: string } {
  const { tool, reason } = loadReadabilityTool();
  if (!tool) return { ok: false, reason: reason ?? 'readability tool unavailable' };
  const fw = (framework || 'flutter').toLowerCase();
  const built = scanBuiltComponents(projectRoot, fw).map((b) => b.className);
  const findings: ReadabilityFinding[] = [];
  const measured: string[] = [];
  let pkg: string | null = null;
  try { pkg = /^name:\s*(\S+)/m.exec(fs.readFileSync(path.join(projectRoot, 'pubspec.yaml'), 'utf8'))?.[1] ?? null; } catch { /* web */ }
  for (const rel of [...new Set(files)]) {
    if (!fs.existsSync(path.join(projectRoot, rel))) continue;
    let r: any;
    try {
      r = tool.analyzeFile(projectRoot, rel, fw, { details: true, deep: 10, minDupTokens: 40, dartNameCache: new Map(), dartPackage: pkg });
    } catch { continue; }
    measured.push(rel);
    const m = r.metrics;
    const d = r.details ?? {};
    const cap = (xs: string[] | undefined): string[] => (xs ?? []).slice(0, 8);
    if (m.loc > READABILITY_BUDGET.screenLoc) findings.push({ code: 'screen-too-long', file: rel, message: `${m.loc} lines of code (budget ${READABILITY_BUDGET.screenLoc}) — lift self-contained sections into components`, lines: [] });
    if (m.comments?.figmaLeak) findings.push({ code: 'figma-leak-comment', file: rel, message: `${m.comments.figmaLeak} comment line(s) cite the design file (frame numbers, IR/layer names, node ids, pixel sizes) — describe behaviour instead`, lines: cap((d.noiseComments ?? []).filter((x: string) => !/\b(TODO|FIXME)\b/.test(x))) });
    if (m.noopHandlers) findings.push({ code: 'noop-handler', file: rel, message: `${m.noopHandlers} do-nothing handler(s)`, lines: cap(d.noopHandlers) });
    const kloc = Math.max(m.loc, 1) / 1000;
    if (m.loc >= 40 && m.magicNumbers / kloc > READABILITY_BUDGET.magicPerKloc) findings.push({ code: 'magic-numbers', file: rel, message: `${m.magicNumbers} layout literals (${Math.round(m.magicNumbers / kloc)}/kLOC, budget ${READABILITY_BUDGET.magicPerKloc}) — use the theme's spacing/size/radius tokens`, lines: cap(d.magicNumbers) });
    if (m.inlineColors) findings.push({ code: 'inline-colors', file: rel, message: `${m.inlineColors} inline colour literal(s) — use the theme's colour tokens`, lines: cap(d.inlineColors) });
    if (m.handDrawn) findings.push({ code: 'hand-drawn', file: rel, message: `${m.handDrawn} hand-drawn painter(s)/inline <svg> — use the exported icon/illustration asset`, lines: [] });
    if (m.machineNames) findings.push({ code: 'machine-name', file: rel, message: `${m.machineNames} machine-shaped name(s) (Frame12, cmp_x_3, IPhone1415Pro57…)`, lines: cap(d.machineNames) });
    // A private widget / local component that duplicates a shared component already built.
    const privates: string[] = r.privateNames ?? [];
    const dup = privates.filter((p) => built.some((b) => b === p.replace(/^_+/, '') || b === `App${p.replace(/^_+/, '')}`));
    if (dup.length) findings.push({ code: 'duplicates-component', file: rel, message: `re-implements shared component(s) privately: ${dup.map((p) => `${p} (use ${built.find((b) => b === p.replace(/^_+/, '') || b === `App${p.replace(/^_+/, '')}`)})`).join(', ')}`, lines: [] });
  }
  return { ok: true, findings, files: measured };
}

/** The block the fix prompt carries (empty when there is nothing to say). */
export function readabilityFixBlock(r: ScreenReadability | { ok: false; reason: string } | null | undefined): string {
  if (!r || !r.ok || !r.findings.length) return '';
  const out = [`READABILITY (advisory — never trade visual fidelity for it, but fix these while you are in the file):`];
  for (const f of r.findings.slice(0, 12)) {
    out.push(`- ${f.file}: ${f.message}`);
    for (const l of f.lines.slice(0, 4)) out.push(`    ${l}`);
  }
  return out.join('\n');
}

/** F7 at PROJECT level (finalize): run the per-screen gate over every file the
 *  metrics classify as a screen. Warn-only — recorded in the finalize report. */
export function projectReadabilityGate(projectRoot: string, framework: string): { ok: true; screens: number; findings: ReadabilityFinding[] } | { ok: false; reason: string } {
  const { tool, reason } = loadReadabilityTool();
  if (!tool) return { ok: false, reason: reason ?? 'readability tool unavailable' };
  let screens: string[] = [];
  try {
    const r = tool.analyzeProject(projectRoot, { framework, tools: false });
    screens = (r.files ?? []).filter((f: any) => f.category === 'screen').map((f: any) => f.path);
  } catch (e) { return { ok: false, reason: `readability-report threw: ${(e as Error).message}` }; }
  const g = screenReadabilityFindings(projectRoot, framework, screens);
  if (!g.ok) return g;
  return { ok: true, screens: g.files.length, findings: g.findings };
}
