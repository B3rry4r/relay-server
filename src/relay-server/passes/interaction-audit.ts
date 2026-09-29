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
 * Framework-agnostic: flutter (`onPressed: () {}` / `: null`, every .dart file under
 * lib/) and react/next (`onClick={() => {}}` / `={undefined}`, every resolver source
 * root — src/, app/, components/, lib/, pages/). Verify-harness previews are never
 * audited.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { detectFramework, type Framework } from './framework';
import {
  loadWebApp, listWebSources, findDeadHandlers, readHeader, idCore,
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
  summary: { total: number; high: number; med: number; screensAffected: number; filesScanned: number };
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
  /** Set when the audit read no source at all — finalize records `skipped` with it. */
  skippedReason?: string;
}

interface AuditScan { findings: InteractionFinding[]; filesScanned: number; skippedReason?: string }

// ── Labels ───────────────────────────────────────────────────────────────────
//
// The label names the control a user will tap and see nothing happen — it is the
// requeue reason the build agent reads. It must be the text of the element that
// OWNS the dead handler, never a neighbour's prop: a ±200-char window read a
// sibling `<Badge label="beta">` as the name of the dead 'Resolve' button (PG-23).

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Index of the `<Tag` that opens the JSX element whose attribute list contains
 *  `pos`, or -1. Walks backwards skipping balanced `{…}` expressions, so the `=>`
 *  inside `onClick={() => {}}` is never read as the end of a tag. */
function jsxOpenerBefore(src: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth > 0) depth--; else return -1; }
    else if (depth === 0) {
      if (c === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) return i;
      if (c === '>') return -1;   // we left the attribute list: pos is in children text
    }
  }
  return -1;
}

/** End of an opening tag starting at `open` (index just past its `>`), skipping
 *  `{…}` expressions and quoted attribute values. `selfClosing` for `/>`. */
function jsxOpenerEnd(src: string, open: number): { end: number; selfClosing: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (depth === 0 && (c === '"' || c === "'")) { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>') return { end: i + 1, selfClosing: src[i - 1] === '/' };
  }
  return null;
}

/** The label of the JSX element owning the handler at `pos`: its own
 *  aria-label/title, else its visible text children (nested tags and `{…}`
 *  expressions stripped), else a nested element's aria-label/alt/title. */
export function jsxOwnerLabel(src: string, pos: number): string | null {
  const open = jsxOpenerBefore(src, pos);
  if (open < 0) return null;
  const tag = /^<([A-Za-z][A-Za-z0-9_.$]*)/.exec(src.slice(open))?.[1];
  const head = jsxOpenerEnd(src, open);
  if (!tag || !head) return null;
  const attrs = src.slice(open, head.end);
  const own = /\b(?:aria-label|title)\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*['"`]([^'"`]+)['"`]\s*\})/.exec(attrs);
  if (own) return collapse(own[1] ?? own[2] ?? own[3]);
  if (head.selfClosing) {
    const lab = /\blabel\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(attrs);   // <IconButton label="Close" onClick…/>
    return lab ? collapse(lab[1] ?? lab[2]) : null;
  }
  // Matching close tag, counting nested elements of the same name.
  const esc = tag.replace(/[.$]/g, '\\$&');
  const re = new RegExp(`<${esc}(?=[\\s>/])|</${esc}\\s*>`, 'g');
  re.lastIndex = head.end;
  let nest = 1;
  let close = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].startsWith('</')) { if (--nest === 0) { close = m.index; break; } }
    else {
      const inner = jsxOpenerEnd(src, m.index);
      if (inner && !inner.selfClosing) nest++;
    }
  }
  if (close < 0) return null;
  const body = src.slice(head.end, close);
  const text = collapse(body.replace(/\{[^{}]*\}/g, ' ').replace(/<[^>]*>/g, ' '));
  if (text) return text.slice(0, 60);
  const nested = /\b(?:aria-label|alt|title)\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(body);
  return nested ? collapse(nested[1] ?? nested[2]) : null;
}

/** Index of the `(` opening the Dart call whose argument list contains `pos`. */
function dartCallOpenBefore(src: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) { depth--; continue; }
      return c === '(' ? i : -1;
    }
  }
  return -1;
}

function matchingClose(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return i; }
  }
  return -1;
}

/** The label of the Dart widget whose argument list holds the dead handler:
 *  `tooltip:` / `semanticLabel:` / `label: Text('…')` / `child: Text('…')` — the
 *  widget's OWN arguments, never a sibling's. */
export function dartOwnerLabel(src: string, pos: number): string | null {
  const open = dartCallOpenBefore(src, pos);
  if (open < 0) return null;
  const close = matchingClose(src, open);
  if (close < 0) return null;
  const args = src.slice(open + 1, close);
  const str = `(?:'([^'\\n]+)'|"([^"\\n]+)")`;
  const pick = (m: RegExpExecArray | null): string | null => (m ? collapse(m[1] ?? m[2]) : null);
  return pick(new RegExp(`\\b(?:tooltip|semanticLabel|semanticsLabel)\\s*:\\s*${str}`).exec(args))
    ?? pick(new RegExp(`\\b(?:label|child|title|text)\\s*:\\s*(?:const\\s+)?Text\\s*\\(\\s*${str}`).exec(args))
    ?? pick(new RegExp(`\\bText\\s*\\(\\s*${str}`).exec(args));
}

const lineOf = (src: string, pos: number): number => src.slice(0, pos).split('\n').length;

// ── Web ──────────────────────────────────────────────────────────────────────

async function auditWeb(projectRoot: string, opts: InteractionAuditOptions): Promise<AuditScan> {
  const ix = await loadWebApp(projectRoot);
  if (!ix) return { findings: [], filesScanned: 0, skippedReason: 'no package.json with react/next — not a web app this audit can read' };

  // folder of each screen's file → its canonicalId, so a dead handler in a sibling
  // panel (DisputeDetailPanel.tsx) maps to the Disputes screen. Deepest folder wins
  // (a Next page at app/page.tsx must not swallow every page beneath it).
  const screenFolders: { dir: string; canonicalId: string }[] = [];
  for (const [, s] of ix.byId) {
    if (s.canonicalId && !s.placeholder) screenFolders.push({ dir: path.dirname(s.file), canonicalId: s.canonicalId });
  }
  screenFolders.sort((a, b) => b.dir.length - a.dir.length);
  const resolveScreenId = (file: string, src: string): string | null => {
    const own = readHeader(src);
    if (own) return own.canonicalId;
    const dir = path.dirname(file);
    const hit = screenFolders.find((f) => dir === f.dir || dir.startsWith(f.dir + path.sep));
    return hit ? hit.canonicalId : null;
  };

  // Every source root the resolver knows (src/, app/, components/, lib/, pages/) —
  // never one hardcoded directory (PG-24). listSourceFiles already drops the verify
  // harness dirs (`_preview`, `%5Fpreview`); `*Preview` modules are dropped here.
  const files = (await listWebSources(ix)).filter((f) => !/Preview\.(tsx|jsx|ts|js)$/.test(f));
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;
  if (targets.length === 0) {
    return { findings: [], filesScanned: 0, skippedReason: `no source files under ${ix.sourceRoots.map((r) => rel(projectRoot, r) || '.').join(', ')} to audit` };
  }

  const findings: InteractionFinding[] = [];
  for (const file of targets) {
    const src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const isShared = /[/\\]components[/\\]/.test(file);
    const screenId = resolveScreenId(file, src);
    for (const dead of findDeadHandlers(src)) {
      const label = jsxOwnerLabel(src, dead.start);
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
  return { findings, filesScanned: targets.length };
}

// ── Flutter ──────────────────────────────────────────────────────────────────

const DART_DEAD = /\b(onTap|onPressed|onLongPress|onChanged|onSubmitted)\s*:\s*(null\b|\(\s*\)\s*(?:=>\s*null\b|\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*\}))/g;

/** Every shipped .dart file under lib/: the verify harness (lib/_preview,
 *  *_preview.dart) and generated code (*.g.dart, *.freezed.dart) excluded. */
async function listDartFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: fsSync.Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '_preview' && !e.name.startsWith('.')) await listDartFiles(p, out); }
    else if (e.name.endsWith('.dart') && !/(_preview|\.g|\.freezed)\.dart$/.test(e.name)) out.push(p);
  }
  return out;
}

async function auditFlutter(projectRoot: string, opts: InteractionAuditOptions): Promise<AuditScan> {
  const libDir = path.join(projectRoot, 'lib');
  if (!fsSync.existsSync(libDir)) return { findings: [], filesScanned: 0, skippedReason: 'no lib/ directory — nothing to audit' };
  const files = await listDartFiles(libDir);
  const targets = opts.onlyFiles?.length ? files.filter((f) => opts.onlyFiles!.includes(path.basename(f))) : files;
  if (targets.length === 0) return { findings: [], filesScanned: 0, skippedReason: 'no .dart files under lib/ to audit' };

  const findings: InteractionFinding[] = [];
  for (const file of targets) {
    const src = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!src) continue;
    const header = readHeader(src);
    const isShared = /[/\\](components|widgets)[/\\]/.test(file);
    let m: RegExpExecArray | null;
    DART_DEAD.lastIndex = 0;
    while ((m = DART_DEAD.exec(src)) !== null) {
      const label = dartOwnerLabel(src, m.index);
      const body = m[2];
      const kind: InteractionFinding['kind'] = /^null\b/.test(body) || /=>\s*null/.test(body) ? 'null-handler'
        : /\/\/|\/\*/.test(body) ? 'todo-body' : 'empty-block';
      findings.push({
        file: rel(projectRoot, file),
        screenCanonicalId: header?.canonicalId ?? null,
        element: label,
        handler: m[1],
        kind,
        severity: label && !isShared ? 'high' : 'med',
        line: lineOf(src, m.index),
      });
    }
  }
  return { findings, filesScanned: targets.length };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function auditInteractions(projectId: string, opts: InteractionAuditOptions): Promise<InteractionAuditResult> {
  const framework = await detectFramework(opts.projectRoot);
  const scan: AuditScan = framework === 'flutter'
    ? await auditFlutter(opts.projectRoot, opts)
    : (framework === 'react' || framework === 'next')
      ? await auditWeb(opts.projectRoot, opts)
      : { findings: [], filesScanned: 0, skippedReason: `no interaction-audit strategy for framework '${framework}'` };
  const findings = scan.findings;

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
      filesScanned: scan.filesScanned,
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
  return { report, reportPath, ...(scan.skippedReason ? { skippedReason: scan.skippedReason } : {}) };
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

export const __test = { jsxOwnerLabel, dartOwnerLabel, auditWeb, auditFlutter };
