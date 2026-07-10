/**
 * interaction-audit.ts — Phase 7g: find controls that render but do nothing.
 *
 * Verify is a static screenshot diff, so a button wired to `onClick={() => {}}`
 * is pixel-identical to one that works — it scores 95 and ships dead. This pass is
 * the deterministic check verify structurally cannot make: the design marks this as
 * a button; does its handler have a body?
 *
 * It never guesses what a handler should do — wiring "Resolve Dispute" is business
 * logic the build agent must write. It DETECTS and reports; the loop requeues the
 * offending screens to needs-review (see planInteractionRequeue), exactly like a
 * flow-wiring REAL gap.
 *
 * Framework-agnostic: flutter (`onPressed: () {}` / `: null`) and react/next
 * (`onClick={() => {}}` / `={undefined}`).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { detectFramework, type Framework } from './component-extraction';
import {
  loadWebApp, listSourceFiles, findDeadHandlers, enclosingMentions, readHeader, idCore,
} from './web-app';

export interface InteractionFinding {
  file: string;
  /** Canonical id of the screen this file belongs to, when resolvable. */
  screenCanonicalId: string | null;
  /** Visible label of the dead control, when one is nearby. */
  element: string | null;
  handler: string;
  kind: 'empty-block' | 'null-handler' | 'todo-body';
  /** high = a labelled action (a user will click it and nothing happens); med = an
   *  unlabelled/icon control or one in a shared component. */
  severity: 'high' | 'med';
  line: number;
}

export interface InteractionAuditReport {
  version: 1;
  projectId: string;
  framework: Framework;
  generatedAt: string;
  summary: { total: number; high: number; med: number; screensAffected: number };
  findings: InteractionFinding[];
}

export interface InteractionAuditOptions {
  projectRoot: string;
  reportPath?: string;
  noReport?: boolean;
  onlyFiles?: string[];
  generatedAt?: string;
}

export interface InteractionAuditResult {
  report: InteractionAuditReport;
  reportPath: string | null;
}

// The visible-label extractor: the text a user reads on the control. `>Resolve<`,
// `label="Filter"`, `aria-label="Close"`, or a nearby JSX text node.
function labelNear(src: string, pos: number): string | null {
  const win = src.slice(Math.max(0, pos - 200), Math.min(src.length, pos + 200));
  const attr = /(?:aria-label|label|title|placeholder)\s*=\s*["'{`]([^"'}`]+)/.exec(win);
  if (attr) return attr[1].trim();
  // `>Resolve Dispute<` after the handler.
  const after = src.slice(pos, Math.min(src.length, pos + 240));
  const text = />\s*([A-Z][A-Za-z0-9 &./-]{1,40}?)\s*</.exec(after);
  return text ? text[1].trim() : null;
}

const lineOf = (src: string, pos: number): number => src.slice(0, pos).split('\n').length;

// ── Web ──────────────────────────────────────────────────────────────────────

async function auditWeb(projectRoot: string, opts: InteractionAuditOptions): Promise<InteractionFinding[]> {
  const ix = await loadWebApp(projectRoot);
  const srcDir = path.join(projectRoot, 'src');
  if (!fsSync.existsSync(srcDir)) return [];

  // folder of each screen's *Screen file → its canonicalId, so a dead handler in a
  // sibling panel (DisputeDetailPanel.tsx) maps to the Disputes screen.
  const screenFolders: { dir: string; canonicalId: string }[] = [];
  if (ix) {
    for (const [, s] of ix.byId) {
      if (s.canonicalId && !s.placeholder) screenFolders.push({ dir: path.dirname(s.file), canonicalId: s.canonicalId });
    }
  }
  const resolveScreenId = (file: string): string | null => {
    // header on the file itself wins
    const own = fsSync.existsSync(file) ? readHeader(fsSync.readFileSync(file, 'utf-8')) : null;
    if (own) return own.canonicalId;
    const dir = path.dirname(file);
    const hit = screenFolders.find((f) => dir === f.dir || dir.startsWith(f.dir + path.sep));
    return hit ? hit.canonicalId : null;
  };

  const files = (await listSourceFiles(srcDir)).filter((f) => !/Preview\.(tsx|jsx)$/.test(f));
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;

  const findings: InteractionFinding[] = [];
  for (const file of targets) {
    const src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const isShared = /[/\\]components[/\\]/.test(file);
    const screenId = resolveScreenId(file);
    for (const dead of findDeadHandlers(src)) {
      const label = labelNear(src, dead.start);
      findings.push({
        file: rel(projectRoot, file),
        screenCanonicalId: screenId,
        element: label,
        handler: dead.handler,
        kind: dead.kind,
        // A labelled control on a real screen is HIGH — a user clicks it and nothing
        // happens. An unlabelled/icon control or one in a shared component is MED.
        severity: label && !isShared ? 'high' : 'med',
        line: lineOf(src, dead.start),
      });
    }
  }
  return findings;
}

// ── Flutter ──────────────────────────────────────────────────────────────────

const DART_DEAD = /\b(onTap|onPressed|onChanged|onSubmitted)\s*:\s*(null|\(\s*\)\s*(?:=>\s*null|\{\s*(?:\/\/[^\n]*\s*)*\}))/g;

async function auditFlutter(projectRoot: string, opts: InteractionAuditOptions): Promise<InteractionFinding[]> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  if (!fsSync.existsSync(screensDir)) return [];
  const files = (await listSourceFiles(screensDir)).filter((f) => f.endsWith('.dart') && !/_preview\.dart$/.test(f));
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;

  const findings: InteractionFinding[] = [];
  for (const file of targets) {
    const src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const header = readHeader(src);
    let m: RegExpExecArray | null;
    DART_DEAD.lastIndex = 0;
    while ((m = DART_DEAD.exec(src)) !== null) {
      const label = labelNear(src, m.index);
      const kind: InteractionFinding['kind'] = /null/.test(m[2]) && !m[2].includes('{') ? 'null-handler'
        : /\/\//.test(m[2]) ? 'todo-body' : 'empty-block';
      findings.push({
        file: rel(projectRoot, file),
        screenCanonicalId: header?.canonicalId ?? null,
        element: label,
        handler: m[1],
        kind,
        severity: label ? 'high' : 'med',
        line: lineOf(src, m.index),
      });
    }
  }
  return findings;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function auditInteractions(projectId: string, opts: InteractionAuditOptions): Promise<InteractionAuditResult> {
  const framework = await detectFramework(opts.projectRoot);
  const findings = framework === 'flutter'
    ? await auditFlutter(opts.projectRoot, opts)
    : (framework === 'react' || framework === 'next')
      ? await auditWeb(opts.projectRoot, opts)
      : [];

  const high = findings.filter((f) => f.severity === 'high').length;
  const report: InteractionAuditReport = {
    version: 1,
    projectId,
    framework,
    generatedAt: opts.generatedAt ?? '1970-01-01T00:00:00.000Z',
    summary: {
      total: findings.length,
      high,
      med: findings.length - high,
      screensAffected: new Set(findings.map((f) => f.screenCanonicalId).filter(Boolean)).size,
    },
    findings,
  };

  let reportPath: string | null = null;
  if (!opts.noReport) {
    try {
      const abs = opts.reportPath ?? path.join(opts.projectRoot, '.uix', 'interaction-audit-report.json');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');
      reportPath = abs;
    } catch { /* best-effort */ }
  }
  return { report, reportPath };
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

// ── Requeue planner (mirrors flow-requeue) ───────────────────────────────────

export interface InteractionRequeueDecision {
  frameId: string;
  canonicalId: string;
  frameName?: string;
  findings: string[];
}

/** Group HIGH findings by their screen and map to the run's frame to requeue.
 *  Only HIGH (labelled, on-screen) findings requeue — an unlabelled icon or a
 *  shared-component handler is reported but not worth a full screen rebuild. */
export function planInteractionRequeue(
  findings: InteractionFinding[],
  canonicalScreens: Array<{ canonicalId: string; name?: string; frameIds?: string[] }>,
  runScreens: Array<{ frameId: string; status?: string }>,
): InteractionRequeueDecision[] {
  const byCanon = new Map(canonicalScreens.map((s) => [idCore(s.canonicalId), s]));
  const runFrames = new Set(runScreens.map((s) => s.frameId));
  const grouped = new Map<string, string[]>();

  for (const f of findings) {
    if (f.severity !== 'high' || !f.screenCanonicalId) continue;
    const arr = grouped.get(f.screenCanonicalId) ?? [];
    arr.push(`${f.element ?? f.handler} (${f.file}:${f.line}, ${f.kind})`);
    grouped.set(f.screenCanonicalId, arr);
  }

  const decisions: InteractionRequeueDecision[] = [];
  for (const [canonicalId, notes] of grouped) {
    const canon = byCanon.get(idCore(canonicalId));
    const frameId = (canon?.frameIds ?? []).find((f) => runFrames.has(f));
    if (!frameId) continue;                       // its lead isn't a build target in this run
    decisions.push({ frameId, canonicalId, frameName: canon?.name, findings: notes });
  }
  return decisions;
}

export const __test = { labelNear, auditWeb, auditFlutter };
