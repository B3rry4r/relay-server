/**
 * test/parity/run-parity.ts — the framework-parity audit harness.
 *
 * Copies each fixture under test/fixtures/parity/{flutter,react,next} into a temp
 * WORKSPACE, drives every Phase-7 pass (through finalizeApp, exactly as a run does)
 * plus the non-pass phases, and grades each pass × framework cell from the FILES the
 * pass produced — never from its own report. Rule 3 of CLAUDE.md: verify outputs,
 * not logs.
 *
 * Every cell carries:
 *   - `reported`: what finalize recorded (status, counts, warnings, error);
 *   - `files`:    the file-level diff the pass left on disk;
 *   - `checks`:   planted-work assertions, each ok/failed with the evidence;
 *   - `cell_status`: IMPLEMENTED | SKIPPED_WITH_REASON | STUB | LIES | ERROR.
 *
 * A failing check carries the class of failure it proves:
 *   stub  — the capability does not exist for this framework (nothing was attempted);
 *   lie   — the pass claimed work (counts, `wired`, `applied`) that the files do not
 *           back, or produced output that is broken while reporting success;
 *   error — the pass threw / was reverted.
 * The cell status is the worst failing class; IMPLEMENTED only when every check holds.
 *
 * External tools are never required: finalize runs with skipBuildCheck (the build
 * gate is probed separately — see `toolchain`) and no model (deterministic path),
 * so a missing flutter/dart/tsc can never be mistaken for, or hide, a pass result.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

export type Fw = 'flutter' | 'react' | 'next';
export const FRAMEWORKS: Fw[] = ['flutter', 'react', 'next'];
export const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'parity');

export type CellStatus = 'IMPLEMENTED' | 'SKIPPED_WITH_REASON' | 'STUB' | 'LIES' | 'ERROR';
export type FailClass = 'stub' | 'lie' | 'error';

export interface Check {
  id: string;
  ok: boolean;
  /** failure class when !ok. */
  cls: FailClass;
  what: string;
  evidence: string;
}

export interface FileDiff {
  file: string;
  change: 'added' | 'removed' | 'modified';
  /** compact line diff (modified text files) — `-`/`+` lines, capped. */
  diff?: string;
}

export interface Cell {
  pass: string;
  framework: Fw;
  reported: { status: string; reason?: string; counts: Record<string, number>; warnings: string[]; error?: string } | null;
  files: FileDiff[];
  checks: Check[];
  cell_status: CellStatus;
  notes: string[];
}

export interface ParityResult {
  generatedAt: string;
  workspace: string;
  toolchain: Record<string, string>;
  cells: Cell[];
}

// ── workspace / copies ──────────────────────────────────────────────────────

let WS = '';
let copySeq = 0;

async function initWorkspace(): Promise<string> {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-ws-'));
  await fs.mkdir(path.join(WS, 'projects'), { recursive: true });
  process.env.WORKSPACE = WS;          // resolveProjectRoot / getProjectsRoot read this at call time
  return WS;
}

/** Fresh copy of a fixture as a managed project. Returns { projectId, root }. */
export async function copyFixture(fw: Fw, label: string): Promise<{ projectId: string; root: string }> {
  const projectId = `parity-${fw}-${label}-${++copySeq}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const root = path.join(WS, 'projects', projectId);
  await fs.cp(path.join(FIXTURES, fw), root, { recursive: true });
  return { projectId, root };
}

// ── snapshots + diffs ───────────────────────────────────────────────────────

type Snap = Map<string, { hash: string; text: string | null }>;

const TEXT_RE = /\.(dart|tsx?|jsx?|json|ya?ml|md|mjs|cjs|html|css|svg)$/;

async function snapshot(root: string): Promise<Snap> {
  const out: Snap = new Map();
  const walk = async (dir: string): Promise<void> => {
    let entries: fsSync.Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        await walk(abs);
      } else if (e.isFile()) {
        const buf = await fs.readFile(abs);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.set(rel, { hash: crypto.createHash('sha1').update(buf).digest('hex'), text: TEXT_RE.test(e.name) ? buf.toString('utf8') : null });
      }
    }
  };
  await walk(root);
  return out;
}

function lineDiff(a: string, b: string, cap = 40): string {
  const A = a.split('\n');
  const B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length - 1;
  let eb = B.length - 1;
  while (ea >= s && eb >= s && A[ea] === B[eb]) { ea--; eb--; }
  const lines = [`@@ line ${s + 1}`, ...A.slice(s, ea + 1).map((l) => `-${l}`), ...B.slice(s, eb + 1).map((l) => `+${l}`)];
  return (lines.length > cap ? [...lines.slice(0, cap), `… (${lines.length - cap} more lines)`] : lines).join('\n');
}

function diffSnaps(before: Snap, after: Snap, ignore: RegExp = /^\.uix\/(runs|screens)\//): FileDiff[] {
  const out: FileDiff[] = [];
  for (const [f, v] of after) {
    if (ignore.test(f)) continue;
    const b = before.get(f);
    if (!b) out.push({ file: f, change: 'added', ...(v.text != null ? { diff: lineDiff('', v.text, 20) } : {}) });
    else if (b.hash !== v.hash) out.push({ file: f, change: 'modified', ...(b.text != null && v.text != null ? { diff: lineDiff(b.text, v.text) } : {}) });
  }
  for (const f of before.keys()) if (!after.has(f) && !ignore.test(f)) out.push({ file: f, change: 'removed' });
  return out.sort((x, y) => x.file.localeCompare(y.file));
}

// ── helpers for checks ──────────────────────────────────────────────────────

const read = (root: string, rel: string): string => {
  try { return fsSync.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
};
const exists = (root: string, rel: string): boolean => fsSync.existsSync(path.join(root, rel));

async function listFiles(root: string, sub = '', re: RegExp = /./): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fsSync.Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(abs); }
      else if (re.test(e.name)) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  await walk(path.join(root, sub));
  return out.sort();
}

/** TS/TSX syntax + GRAMMAR diagnostics (TS1xxx) for a set of files. Grammar errors
 *  such as `export export function` (TS1030) are reported by the checker, not the
 *  parser, so a parse-only check passes them — this builds a lib-less, resolve-less
 *  program so only codes < 2000 (never "cannot find name/module") are reported. No
 *  project toolchain is needed. */
function tsSyntaxErrors(files: Record<string, string>): string[] {
  const kindOf = (f: string) => (f.endsWith('.tsx') ? ts.ScriptKind.TSX : f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JSX);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (f, lang) => (files[f] != null ? ts.createSourceFile(f, files[f], lang, true, kindOf(f)) : undefined);
  host.fileExists = (f) => files[f] != null;
  host.readFile = (f) => files[f];
  const program = ts.createProgram(Object.keys(files), { noResolve: true, noLib: true, types: [], noEmit: true, jsx: ts.JsxEmit.Preserve, allowJs: true }, host);
  const out: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].filter((d) => d.code < 2000);
    for (const d of diags) {
      const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      out.push(`${sf.fileName}:${line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  return out;
}

/** Syntax/grammar errors across every changed/added web source in a diff. */
function syntaxErrorsIn(root: string, files: FileDiff[]): string[] {
  const map: Record<string, string> = {};
  for (const f of files) {
    if (f.change === 'removed' || !/\.(tsx?|jsx?)$/.test(f.file)) continue;
    map[f.file] = read(root, f.file);
  }
  return Object.keys(map).length ? tsSyntaxErrors(map) : [];
}

function chk(id: string, ok: boolean, cls: FailClass, what: string, evidence: string): Check {
  return { id, ok, cls, what, evidence: evidence.slice(0, 1200) };
}

function classify(reported: Cell['reported'], checks: Check[]): CellStatus {
  if (reported?.status === 'reverted') return 'ERROR';
  // `skipped` only earns SKIPPED_WITH_REASON when it carries the reason (PG-01) and
  // nothing it left behind is a lie.
  if (reported?.status === 'skipped' && !!reported.reason?.trim() && checks.every((c) => c.ok || c.cls === 'stub')) return 'SKIPPED_WITH_REASON';
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return 'IMPLEMENTED';
  if (failed.some((c) => c.cls === 'error')) return 'ERROR';
  if (failed.some((c) => c.cls === 'lie')) return 'LIES';
  return 'STUB';
}

// Per-framework locations of the planted work.
const SCREEN = {
  flutter: { login: 'lib/screens/login_screen.dart', home: 'lib/screens/home_screen.dart', settings: 'lib/screens/screen_10_3.dart', profile: 'lib/screens/screen_10_4.dart' },
  react: { login: 'src/screens/Login/LoginScreen.tsx', home: 'src/screens/Home/HomeScreen.tsx', settings: 'src/screens/IPhone1415Pro57Screen.tsx', profile: 'src/screens/Frame123Screen.tsx' },
  next: { login: 'app/10-1/page.tsx', home: 'app/(tabs)/10-2/page.tsx', settings: 'app/10-3/page.tsx', profile: 'app/(tabs)/10-4/page.tsx' },
} as const;

/** Where each framework's localized design assets live (CONTRACTS §5: a web server
 *  serves only public/, so web assets are public/assets/…, served at /assets/…). */
const ASSET_DIR: Record<Fw, string> = { flutter: 'assets', react: 'public/assets', next: 'public/assets' };
/** The generated resources module (next: beside the app dir's parent, CONTRACTS §5). */
const RES_FILE: Record<Fw, string> = { flutter: 'lib/resources/app_assets.dart', react: 'src/resources/assets.ts', next: 'lib/resources/assets.ts' };

/** All source files a framework's app is made of (for "anywhere in source" checks). */
async function appSources(root: string, fw: Fw): Promise<string[]> {
  if (fw === 'flutter') return listFiles(root, 'lib', /\.dart$/);
  const dirs = fw === 'react' ? ['src'] : ['app', 'components', 'lib', 'src'];
  const out: string[] = [];
  for (const d of dirs) out.push(...await listFiles(root, d, /\.(tsx?|jsx?)$/));
  return out;
}

async function grepSources(root: string, fw: Fw, re: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const f of await appSources(root, fw)) {
    const lines = read(root, f).split('\n');
    lines.forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`); });
  }
  return hits;
}

// ── pass drivers ────────────────────────────────────────────────────────────

export const PASS_NAMES = [
  'extractComponents', 'applyModalOverlays', 'repointAssetUsage', 'verifyFlowWiring',
  'renameSemantic', 'deepenTokensAndCleanup', 'auditInteractions', 'productionHygiene',
] as const;
type PassName = typeof PASS_NAMES[number];

interface PassRun {
  root: string;
  projectId: string;
  reported: Cell['reported'];
  files: FileDiff[];
  logs: string[];
  mutate?: (root: string) => Promise<void>;
}

async function runOnePass(fw: Fw, pass: PassName, mutate?: (root: string) => Promise<void>): Promise<PassRun> {
  const { finalizeApp } = await import('../../src/relay-server/passes/finalize');
  const { projectId, root } = await copyFixture(fw, pass);
  if (mutate) await mutate(root);
  const before = await snapshot(root);
  const logs: string[] = [];
  const report = await finalizeApp(projectId, {
    projectRoot: root, onlyPasses: [pass], skipBuildCheck: true, noReport: true, log: (m) => logs.push(m),
  });
  const after = await snapshot(root);
  const p = report.passes.find((x) => x.name === pass) ?? null;
  return {
    root, projectId, logs, mutate,
    reported: p ? { status: p.status, ...(p.reason ? { reason: p.reason } : {}), counts: p.counts, warnings: p.warnings, ...(p.error ? { error: p.error } : {}) } : null,
    files: diffSnaps(before, after),
  };
}

type CheckFn = (fw: Fw, r: PassRun) => Promise<Check[]>;

/** A pass whose input (the fixture's screens) EXISTS may skip only by naming what it
 *  does not support — never by claiming the input is absent ("no local component
 *  declarations found", "0 files matched"): an operator reading that concludes the
 *  app has nothing to extract/audit (B1 verify #2). Vacuous unless the pass skipped. */
export function honestSkipReason(reason: string): boolean {
  return /not implemented|not supported|unsupported|were not read|was not read|not audited|PG-\d+/i.test(reason);
}
function honestSkip(id: string, r: PassRun, inputFact: string): Check {
  const reason = r.reported?.status === 'skipped' ? r.reported.reason ?? '' : null;
  return chk(id, reason === null || honestSkipReason(reason), 'lie', `a skip names the unsupported layout/scope instead of claiming absent input (${inputFact})`,
    reason === null ? 'not skipped' : `reason: ${reason}`);
}

const flowReport = (root: string): { findings: Array<{ from: string; to: string; status: string; detail: string; autoFixed?: boolean }> } | null => {
  try { return JSON.parse(read(root, '.uix/flow-wiring-report.json')); } catch { return null; }
};

const CHECKS: Record<PassName, CheckFn> = {
  // ── 7a ────────────────────────────────────────────────────────────────────
  async extractComponents(fw, r) {
    const s = SCREEN[fw];
    const added = r.files.filter((f) => f.change === 'added').map((f) => f.file);
    const shared = added.find((f) => /section_?heading/i.test(f));
    const localRe = fw === 'flutter' ? /class\s+_SectionHeading\b/ : /^function\s+SectionHeading\b/m;
    const stillLocal = [s.home, s.settings].filter((f) => localRe.test(read(r.root, f)));
    const importRe = fw === 'flutter' ? /import\s+'[^']*section_heading\.dart'/ : /import\s*\{[^}]*\bSectionHeading\b[^}]*\}\s*from/;
    const notImporting = [s.home, s.settings].filter((f) => !importRe.test(read(r.root, f)));
    const pillMerged = added.some((f) => /pill/i.test(f));
    // Flutter PARAMETERIZES differing literals by design; a merge is only correct if
    // both call sites still pass their own colour. Web merges byte-identical only.
    const pillValuesKept = /0xFF12AE89/i.test(read(r.root, s.login)) && /0xFF1A1A1A/i.test(read(r.root, s.settings));
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(r.root, r.files);
    const extracted = r.reported?.counts?.extracted ?? 0;
    const depsMissing: string[] = [];
    if (fw !== 'flutter') {
      for (const f of added.filter((x) => /\.(tsx?|jsx?)$/.test(x))) {
        const src = read(r.root, f);
        for (const sym of ['assets', 'AppTheme', 'ROUTES', 'modalController']) {
          const used = new RegExp(`\\b${sym}\\s*[.[]`).test(src.replace(/^import\s.*$/gm, ''));
          const imported = new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from`).test(src);
          if (used && !imported) depsMissing.push(`${f} uses \`${sym}\` without importing it`);
        }
      }
    }
    return [
      chk('x.shared', !!shared, 'stub', 'byte-identical SectionHeading lifted into one shared component file',
        shared ? `created ${shared}` : `no shared SectionHeading file created (added: ${added.join(', ') || 'none'}); reported extracted=${extracted}`),
      chk('x.no-local', stillLocal.length === 0, 'stub', 'no screen still declares its own SectionHeading',
        stillLocal.length ? `still declared locally in ${stillLocal.join(', ')}` : 'local copies removed'),
      chk('x.imports', !shared || notImporting.length === 0, 'lie', 'every rewritten screen imports the shared component',
        notImporting.length ? `not importing: ${notImporting.join(', ')}` : 'both screens import it'),
      fw === 'flutter'
        ? chk('x.near-dup-param', !pillMerged || pillValuesKept, 'lie', 'near-duplicate PillButton merged only with each call site keeping its own colour', pillMerged ? `merged; call-site colours kept: ${pillValuesKept}` : 'not merged')
        : chk('x.near-dup-kept', !pillMerged, 'lie', 'near-duplicate PillButton (differing colour literal) is NOT merged blind', pillMerged ? 'a PillButton component was extracted' : 'PillButton left in place'),
      chk('x.syntax', syn.length === 0, 'lie', 'every file the pass wrote parses', syn.length ? syn.join(' | ') : 'all written TS/TSX files parse'),
      ...(fw === 'flutter' ? [(() => {
        // CONTRACTS §5: a parameterized field is named after the named argument it feeds, never `p0`.
        const machine = added.filter((f) => f.endsWith('.dart')).flatMap((f) => [...read(r.root, f).matchAll(/\bthis\.(p\d+)\b/g)].map((m) => `${f}: ${m[1]}`));
        return chk('x.param-names', machine.length === 0, 'lie', 'a lifted parameter is named after its named-argument key (color, fontSize), never p0', machine.join(' | ') || 'no pN parameters');
      })()] : []),
      chk('x.deps-carried', depsMissing.length === 0, 'lie', 'a hoisted component carries the imports its body uses (SearchGlyph uses `assets`)', depsMissing.join(' | ') || 'every hoisted component imports what it uses'),
      honestSkip('x.skip-reason-honest', r, 'SectionHeading is declared locally in two screens'),
    ];
  },

  // ── 7b ────────────────────────────────────────────────────────────────────
  async applyModalOverlays(fw, r) {
    const { applyModalOverlays } = await import('../../src/relay-server/passes/modal-overlay');
    // Detailed claims come from a DRY run on a second copy (finalize only keeps counts).
    const dry = await copyFixture(fw, 'modal-dry');
    if (r.mutate) await r.mutate(dry.root);
    const beforeDry = await snapshot(dry.root);
    const d = await applyModalOverlays(dry.projectId, { projectRoot: dry.root, noAi: true, dryRun: true });
    const dryWrote = diffSnaps(beforeDry, await snapshot(dry.root));
    const t9 = d.transformed.find((t) => t.canonicalId === 'm_10_9');
    const t8 = d.transformed.find((t) => t.canonicalId === 'm_10_8');
    const s8 = d.skipped.find((s) => s.canonicalId === 'm_10_8');
    let routeGone = false; let routeEvidence = '';
    if (fw === 'react') {
      const app = read(r.root, 'src/App.tsx');
      routeGone = !/ROUTES\.filterSheet/.test(app);
      routeEvidence = routeGone ? 'App.tsx no longer mounts ROUTES.filterSheet' : 'App.tsx still mounts <Route path={ROUTES.filterSheet} …PlaceholderScreen>';
    } else if (fw === 'next') {
      routeGone = !exists(r.root, 'app/10-9/page.tsx');
      routeEvidence = routeGone ? 'app/10-9/page.tsx removed' : 'app/10-9/page.tsx (mounts <PlaceholderScreen title="Filter"/>) still routable at /10-9';
    } else {
      const routes = read(r.root, 'lib/app_routes.dart');
      routeGone = !/static const String filter\b/.test(routes);
      routeEvidence = routeGone ? 'AppRoutes.filter removed' : 'AppRoutes.filter still in app_routes.dart';
    }
    const claimRewrote = t9?.trigger?.wired === 'rewrote-push';
    const homeChanged = r.files.some((f) => f.file === SCREEN[fw].home);
    return [
      chk('m.presented', !!t9, 'stub', 'bound + presented modal m_10_9 is converted/credited', t9 ? `transformed (${t9.presentation}, modalFile=${t9.modalFile})` : `skipped: ${d.skipped.find((s) => s.canonicalId === 'm_10_9')?.reason ?? 'no outcome'}`),
      chk('m.modal-file', !t9 || (!!t9.modalFile && exists(dry.root, t9.modalFile) && (fw === 'flutter' ? /class FilterSheetScreen\b/ : /function showModal_10_9\b/).test(read(dry.root, t9.modalFile))), 'lie', 'the transform names the real modal file (flutter: the routed modal screen; web: the module declaring showModal_10_9)', t9 ? `modalFile=${t9.modalFile}` : 'n/a'),
      chk('m.dead-route', routeGone, 'stub', "the modal's own dead route (frame /10-9) is stripped", routeEvidence),
      chk('m.unpresented-gap', !t8 && !!s8 && /REAL gap/i.test(s8.reason), 'lie', 'm_10_8 (presented ONLY by the verify preview) is reported as a REAL gap, never credited',
        t8 ? 'm_10_8 was TRANSFORMED' : `m_10_8 skip reason: ${s8?.reason ?? '(none)'}`),
      chk('m.trigger-claim', !claimRewrote || homeChanged, 'lie', "a transform claiming trigger.wired='rewrote-push' actually rewrote the base screen",
        claimRewrote ? `claims rewrote-push; base screen ${homeChanged ? 'changed' : 'UNCHANGED on disk'}` : `trigger claim: ${t9?.trigger?.wired ?? 'n/a'}`),
      chk('m.dry-run-writes-nothing', dryWrote.length === 0, 'lie', 'dryRun writes nothing', dryWrote.length ? `dry run wrote: ${dryWrote.map((f) => f.file).join(', ')}` : 'no writes'),
      chk('m.syntax', fw === 'flutter' || syntaxErrorsIn(r.root, r.files).length === 0, 'lie', 'every file the pass wrote parses', syntaxErrorsIn(r.root, r.files).join(' | ') || 'ok'),
    ];
  },

  // ── 7c ────────────────────────────────────────────────────────────────────
  async repointAssetUsage(fw, r) {
    const s = SCREEN[fw];
    const home = read(r.root, s.home);
    const login = read(r.root, s.login);
    const sym = fw === 'flutter' ? 'AppAssets' : 'assets';
    const oldPathGone = !/vector_10_20\.svg/.test(home);
    const oldToSym = new RegExp(`${sym}\\.searchIcon`).test(home);
    const avatarLit = fw === 'flutter' ? /user_avatar_10_31\.png/.test(login) : /["']assets\/images\/user_avatar\.png["']/.test(login);
    const avatarSym = new RegExp(`${sym}\\.userAvatar`).test(login);
    const jsxBare = fw !== 'flutter' && /src=assets\./.test(login);
    const importOk = fw === 'flutter'
      ? (!avatarSym || /app_assets\.dart/.test(login))
      : (!avatarSym || /import\s*\{[^}]*\bassets\b[^}]*\}\s*from/.test(login));
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(r.root, r.files);
    const warn = (r.reported?.warnings ?? []).join('\n');
    const artReported = fw === 'flutter' ? true : /inline <svg> artwork/.test(warn);
    // The fixture's screens were built under the pre-B56 packet (`/${assets.x}`, values
    // were paths). The resources values are served URLs now (`/assets/…`), so a prefix
    // left behind requests `//assets/…` — a protocol-relative URL to host "assets".
    // Every spelling the old packet produced, not only the whole template: the settings
    // screen also carries `url(/${assets.mapDark})` and `'/' + assets.userAvatar`.
    const prefixLeft = fw === 'flutter' ? [] : await grepSources(r.root, fw, /(?<!\/)\/\$\{\s*assets\b|['"`]\/['"`]\s*\+\s*assets\b/);
    return [
      chk('a.old-path', oldPathGone && oldToSym, 'stub', "the IR's OPAQUE pre-rename path 'assets/icons/vector_10_20.svg' (asset-map oldPath) is re-pointed to the searchIcon symbol",
        oldPathGone ? `home now: ${home.split('\n').find((l) => /searchIcon/.test(l))?.trim() ?? '?'}` : `still a raw literal in ${s.home}: ${home.split('\n').find((l) => /vector_10_20/.test(l))?.trim()}`),
      chk('a.jsx-attr', !avatarLit && avatarSym && !jsxBare, fw === 'flutter' ? 'stub' : 'lie', 'raw avatar path literal becomes the userAvatar symbol, valid in its position',
        jsxBare ? `emitted a bare JSX attribute: ${login.split('\n').find((l) => /src=assets\./.test(l))?.trim()}`
          : avatarLit ? `avatar literal untouched in ${s.login}` : `→ ${login.split('\n').find((l) => /userAvatar/.test(l))?.trim() ?? '?'}`),
      chk('a.import', importOk, 'lie', 'a file that now uses the symbol imports the resources module', importOk ? 'import present' : `${s.login} uses ${sym}.userAvatar with no import`),
      chk('a.art-reported', artReported, 'stub', 'the art-sized hand-drawn <svg> (DeliveryMapCard) is reported against the real image assets', artReported ? 'reported' : `no inline-svg finding in warnings (${(r.reported?.warnings ?? []).length} warning(s))`),
      chk('a.syntax', syn.length === 0, 'lie', 'every file the pass wrote parses', syn.join(' | ') || 'ok'),
      ...(fw === 'flutter' ? [] : [chk('a.served-url', prefixLeft.length === 0, 'lie', 'no `/`-prefixed served URL is left (`/${assets.x}`, `url(/${assets.x})`, `\'/\' + assets.x`) now that every symbol value is a served URL (it would request //assets/…)', prefixLeft.slice(0, 4).join(' | ') || 'none left')]),
    ];
  },

  // ── 7d ────────────────────────────────────────────────────────────────────
  async verifyFlowWiring(fw, r) {
    const rep = flowReport(r.root);
    const f = (to: string, from?: string) => rep?.findings.find((x) => x.to === to && (!from || x.from === from));
    const E = {
      E1: f('c_10_2', 'c_10_1'), E2: f('c_10_3', 'c_10_2'), E3: f('c_10_5'), E4: f('m_10_9'),
      E5: f('m_10_8'), E6: f('c_10_4'), E7: f('c_10_1', 'c_10_3'),
    };
    const show = (x?: { status: string; detail: string; autoFixed?: boolean }) => x ? `${x.status}${x.autoFixed ? ' (autoFixed)' : ''} — ${x.detail}` : 'no finding';
    const home = read(r.root, SCREEN[fw].home);
    const autofixed = !!E.E2?.autoFixed;
    const autofixInFile = fw === 'flutter' ? /pushNamed\(AppRoutes\.c1003\)/.test(home) : fw === 'react' ? /navigate\(ROUTES\.c103\)/.test(home) : /router\.push\(['"]\/10-3['"]\)/.test(home);
    return [
      chk('f.report', !!rep, 'stub', 'flow-wiring report written', rep ? `${rep.findings.length} finding(s)` : 'no .uix/flow-wiring-report.json'),
      chk('f.E1-wired', E.E1?.status === 'wired', 'stub', 'E1 login→home (navigate) is wired', show(E.E1)),
      chk('f.E2-dead', E.E2?.status === 'dead-trigger' || (E.E2?.status === 'wired' && autofixed), 'stub', "E2 home→settings: dead 'Settings' handler is found (dead-trigger or auto-wired)", show(E.E2)),
      chk('f.E2-autofix', autofixed && autofixInFile, 'stub', 'E2 dead trigger auto-wired to the settings route (navigation already in scope)', `${show(E.E2)}; file has fix: ${autofixInFile}`),
      chk('f.E3-placeholder', !!E.E3 && E.E3.status !== 'wired', 'lie', 'E3 home→details: target is a placeholder / un-built skeleton stub → never `wired`', show(E.E3)),
      chk('f.E4-modal', E.E4?.status === 'wired', 'stub', 'E4 home→m_10_9: bound modal presented from its base → wired', show(E.E4)),
      chk('f.E5-preview-only', !!E.E5 && E.E5.status !== 'wired' && /REAL gap/i.test(E.E5.detail), 'lie', 'E5 settings→m_10_8: presented ONLY by the verify preview → REAL gap', show(E.E5)),
      chk('f.E6-tab', E.E6?.status === 'wired', 'stub', 'E6 home→profile tab: shell hosts the tab and links to it → wired', show(E.E6)),
      chk('f.E7-verb', E.E7?.status === 'wrong-verb', 'stub', "E7 'replace' edge implemented with a push → wrong-verb", show(E.E7)),
    ];
  },

  // ── 7e ────────────────────────────────────────────────────────────────────
  async renameSemantic(fw, r) {
    const machineClass = await grepSources(r.root, fw, /IPhone1415Pro57(Screen|Page)|Frame123(Screen|Page)/);
    // Verify-harness previews are addressed by FRAME id by contract (`/_preview/<frame>`,
    // lib/_preview/screen_<frame>_…): their paths are not the app's names and must
    // not be renamed — but they must keep compiling (r.preview-intact).
    const isPreviewPath = (f: string) => /(^|\/)(_preview|%5Fpreview)\//i.test(f);
    const machineFiles = (await appSources(r.root, fw)).filter((f) => !isPreviewPath(f) && /screen_10_[34]\.dart|IPhone1415Pro57|Frame123|(^|\/)10-3(\/|$)/.test(f));
    const brokenPreviewImports: string[] = [];
    for (const f of (await appSources(r.root, fw)).filter(isPreviewPath)) {
      for (const m of read(r.root, f).matchAll(/(?:from\s*|import\s+)['"](\.[^'"]+)['"]/g)) {
        const base = path.resolve(r.root, path.dirname(f), m[1]);
        if (![base, `${base}.tsx`, `${base}.ts`, `${base}.dart`].some((c) => fsSync.existsSync(c) && fsSync.statSync(c).isFile())) brokenPreviewImports.push(`${f} → ${m[1]}`);
      }
    }
    const frameCode = await grepSources(r.root, fw, /283[_:-]?1967|2831967/);
    let routeTable = '';
    let settingsRoute: string | null = null;
    if (fw === 'flutter') {
      routeTable = read(r.root, 'lib/app_routes.dart');
      settingsRoute = /static const String \w+ = '([^']+)';\s*$/m.test(routeTable) ? (routeTable.match(/'(\/settings[^']*)'/)?.[1] ?? null) : null;
    } else if (fw === 'react') {
      routeTable = read(r.root, 'src/router/routes.ts');
      settingsRoute = routeTable.match(/'(\/settings[^']*)'/)?.[1] ?? null;
    } else {
      settingsRoute = exists(r.root, 'app/settings/page.tsx') ? '/settings' : null;
    }
    // Every stamped header's route must match the route the router actually serves.
    const stale: string[] = [];
    for (const f of await appSources(r.root, fw)) {
      const src = read(r.root, f);
      const h = /^\/\/\s*canonicalId:\s*(\S+)\s+route:\s*(\S+)/m.exec(src);
      if (!h) continue;
      const route = h[2];
      const served = fw === 'flutter' ? new RegExp(`'${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(read(r.root, 'lib/app_routes.dart'))
        : fw === 'react' ? new RegExp(`'${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(read(r.root, 'src/router/routes.ts'))
          : exists(r.root, path.join('app', route.replace(/^\//, ''), 'page.tsx')) || exists(r.root, path.join('app', '(tabs)', route.replace(/^\//, ''), 'page.tsx'));
      if (!served) stale.push(`${f} header route ${route} (${h[1]}) is not served`);
    }
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(r.root, r.files);
    const renamed = r.reported?.counts?.renamed ?? 0;
    return [
      chk('r.route-path', !!settingsRoute, 'stub', "settings' machine route /10-3 becomes a semantic path (/settings)", settingsRoute ? `served at ${settingsRoute}` : `no /settings route (reported renamed=${renamed}); warnings: ${(r.reported?.warnings ?? []).slice(0, 3).join(' | ')}`),
      chk('r.class', machineClass.length === 0, 'stub', 'machine component/class names (IPhone1415Pro57*, Frame123*) are renamed', machineClass.length ? machineClass.slice(0, 6).join(' | ') : 'none left'),
      chk('r.file', machineFiles.length === 0, 'stub', 'machine file/dir names (screen_10_3.dart / IPhone1415Pro57Screen.tsx / app/10-3/) are renamed', machineFiles.length ? machineFiles.join(', ') : 'none left'),
      chk('r.preview-intact', brokenPreviewImports.length === 0, 'lie', 'verify-harness previews still import the (renamed) screens they mount', brokenPreviewImports.join(' | ') || 'every preview import resolves'),
      chk('r.frame-code', frameCode.length === 0, 'lie', 'the raw frame-code name "283:1967" never becomes an identifier', frameCode.slice(0, 4).join(' | ') || 'none'),
      chk('r.headers-consistent', stale.length === 0, 'lie', 'every `// canonicalId: … route:` header names the route the app actually serves (later passes resolve by it)', stale.slice(0, 6).join(' | ') || 'all headers match'),
      chk('r.syntax', syn.length === 0, 'lie', 'every file the pass wrote parses', syn.join(' | ') || 'ok'),
    ];
  },

  // ── 7f ────────────────────────────────────────────────────────────────────
  async deepenTokensAndCleanup(fw, r) {
    const home = read(r.root, SCREEN[fw].home);
    const colorOk = fw === 'flutter' ? /AppTheme\.brand/.test(home) && !/Color\(0xFF12AE89\)/.test(home) : /AppTheme\.color\.brand/.test(home) && !/'#12ae89'/.test(home);
    const attrOk = fw === 'flutter' ? true : /fill=\{AppTheme\.color\.brand\}/.test(home) && !/fill="#12ae89"/.test(home);
    const spacingOk = fw === 'flutter' ? /AppTheme\.s16|AppTheme\.pad\(AppTheme\.s16\)|EdgeInsets\.all\(AppTheme\.s16\)/.test(home) : /padding:\s*AppTheme\.spacing\.s16/.test(home);
    const radiusOk = fw === 'flutter' ? /AppTheme\.r12/.test(home) : /borderRadius:\s*AppTheme\.radius\.r12/.test(home);
    const importOk = fw === 'flutter' ? /app_theme\.dart/.test(home) : /import\s*\{[^}]*\bAppTheme\b[^}]*\}\s*from/.test(home);
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(r.root, r.files);
    const line = (re: RegExp) => home.split('\n').find((l) => re.test(l))?.trim() ?? '(no line)';
    return [
      chk('t.color', colorOk, 'stub', 'brand colour literal #12ae89 → the brand token', colorOk ? line(/brand/) : line(/12ae89|12AE89/)),
      chk('t.jsx-attr', attrOk, 'stub', 'colour literal in a JSX attribute becomes {token}', attrOk ? 'ok' : line(/fill=/)),
      chk('t.spacing', spacingOk, 'stub', 'padding 16 → the s16 spacing token', spacingOk ? 'ok' : line(/padding/)),
      chk('t.radius', radiusOk, 'stub', 'borderRadius 12 → the r12 radius token', radiusOk ? 'ok' : line(/[Rr]adius/)),
      chk('t.import', !colorOk || importOk, 'lie', 'a file that now uses the theme imports it', importOk ? 'import present' : 'token used without import'),
      chk('t.syntax', syn.length === 0, 'lie', 'every file the pass wrote parses', syn.join(' | ') || 'ok'),
      // The fixture HAS a theme module (flutter lib/theme/app_theme.dart, react
      // src/theme/theme.ts, next <root>/lib/theme/theme.ts per CONTRACTS §5): a 7f skip
      // claiming "no web theme module" is the B12 lie (the Next theme was never read).
      honestSkip('t.skip-reason-honest', r, 'the fixture ships a theme module with an exported token object'),
    ];
  },

  // ── 7g ────────────────────────────────────────────────────────────────────
  async auditInteractions(fw, r) {
    const { auditInteractions } = await import('../../src/relay-server/passes/interaction-audit');
    const a = await auditInteractions(r.projectId, { projectRoot: r.root, noReport: true });
    const fs_ = a.report.findings;
    // Locate each planted dead control by FILE + LINE in the source, then grade the
    // finding the audit produced for it (found? mapped to the right screen? labelled
    // with the control's real text? severity high so it requeues?).
    const lineOf = (file: string, re: RegExp) => read(r.root, file).split('\n').findIndex((l) => re.test(l)) + 1;
    const deadRe = fw === 'flutter' ? /onPressed:\s*\(\)\s*\{\}/ : /onClick=\{\(\) => \{\}\}/;
    const planted = [
      { id: 'resolve', file: SCREEN[fw].settings, label: 'Resolve', screen: 'c_10_3', line: lineOf(SCREEN[fw].settings, new RegExp(`${deadRe.source}.*Resolve`)) },
      { id: 'settings', file: SCREEN[fw].home, label: 'Settings', screen: 'c_10_2', line: lineOf(SCREEN[fw].home, new RegExp(`${deadRe.source}.*Settings`)) },
    ];
    const out: Check[] = [];
    for (const p of planted) {
      const f = fs_.find((x) => x.file === p.file && x.line === p.line);
      out.push(chk(`i.${p.id}-found`, !!f && f.screenCanonicalId === p.screen, 'stub', `dead '${p.label}' control (${p.file}:${p.line}) is found and mapped to ${p.screen}`,
        f ? `${f.file}:${f.line} → ${f.screenCanonicalId} (${f.severity})` : `no finding at ${p.file}:${p.line}; ${fs_.length} finding(s) total`));
      out.push(chk(`i.${p.id}-label`, !f || (f.element === p.label && f.severity === 'high'), 'lie', `the finding names the control's real label '${p.label}' and is HIGH (so the screen requeues)`,
        f ? `element=${JSON.stringify(f.element)} severity=${f.severity}` : 'n/a'));
    }
    const inPreview = fs_.filter((x) => /preview/i.test(x.file));
    out.push(chk('i.no-preview', inPreview.length === 0, 'lie', 'verify-harness preview files are never audited as shipped UI', inPreview.map((x) => x.file).join(', ') || 'none'));
    out.push(honestSkip('i.skip-reason-honest', r, 'the screens hold planted dead controls'));
    return out;
  },

  // ── 7h ────────────────────────────────────────────────────────────────────
  async productionHygiene(fw, r) {
    const checks: Check[] = [];
    if (fw === 'flutter') {
      checks.push(chk('h.preview', !exists(r.root, 'lib/_preview'), 'stub', 'lib/_preview verify entries removed', exists(r.root, 'lib/_preview') ? 'lib/_preview still present' : 'removed'));
    } else if (fw === 'react') {
      const app = read(r.root, 'src/App.tsx');
      const previews = (await listFiles(r.root, 'src', /Preview\.tsx$/));
      checks.push(chk('h.preview', !/\/_preview\//.test(app) && previews.length === 0, 'stub', '/_preview routes + *Preview files removed', `routes left: ${(app.match(/\/_preview\/[\w-]+/g) ?? []).join(', ') || 'none'}; files left: ${previews.join(', ') || 'none'}`));
      checks.push(chk('h.placeholder', !/PlaceholderScreen/.test(app) && !exists(r.root, 'src/screens/PlaceholderScreen.tsx'), 'stub', 'PlaceholderScreen routes + file removed', /PlaceholderScreen/.test(app) ? 'App.tsx still mounts PlaceholderScreen' : 'removed'));
    } else {
      const previewPages = await listFiles(r.root, 'app/_preview', /page\.tsx$/);
      const placeholderPages: string[] = [];
      for (const p of await listFiles(r.root, 'app', /page\.tsx$/)) if (/PlaceholderScreen/.test(read(r.root, p))) placeholderPages.push(p);
      checks.push(chk('h.preview', previewPages.length === 0, 'stub', 'app/_preview preview pages removed', previewPages.join(', ') || 'removed'));
      checks.push(chk('h.placeholder', placeholderPages.length === 0, 'stub', 'pages that only mount PlaceholderScreen removed', placeholderPages.join(', ') || 'removed'));
    }
    const kept = exists(r.root, `${ASSET_DIR[fw]}/images/promo_banner.png`);
    checks.push(chk('h.computed-asset-kept', kept, 'lie', 'asset reached only via a computed key (promoBanner) is NOT deleted', kept ? 'kept' : 'DELETED'));
    const warn = (r.reported?.warnings ?? []).join('\n');
    checks.push(chk('h.computed-asset-reported', /computed key|assets\[/.test(warn), 'stub', 'unreferenced-looking asset symbols are REPORTED, flagging the computed-key access', warn.slice(0, 300) || 'no warning'));
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(r.root, r.files);
    checks.push(chk('h.syntax', syn.length === 0, 'lie', 'every file the pass wrote parses', syn.join(' | ') || 'ok'));
    return checks;
  },
};

// ── non-pass phases ─────────────────────────────────────────────────────────

async function phaseDetectFramework(): Promise<Cell[]> {
  const mods = {
    'component-extraction': (await import('../../src/relay-server/passes/component-extraction')).detectFramework,
    'modal-overlay': (await import('../../src/relay-server/passes/modal-overlay')).detectFramework,
    'asset-usage': (await import('../../src/relay-server/passes/asset-usage')).detectFramework,
    'flow-wiring': (await import('../../src/relay-server/passes/flow-wiring')).detectFramework,
    'semantic-rename': (await import('../../src/relay-server/passes/semantic-rename')).detectFramework,
    'token-cleanup': (await import('../../src/relay-server/passes/token-cleanup')).detectFramework,
  };
  const { detectWebKind } = await import('../../src/relay-server/passes/web-app');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { root } = await copyFixture(fw, 'detect');
    const checks: Check[] = [];
    for (const [name, fn] of Object.entries(mods)) {
      const got = await fn(root);
      checks.push(chk(`d.${name}`, got === fw, 'lie', `${name}.detectFramework → '${fw}'`, `got '${got}'`));
    }
    if (fw !== 'flutter') {
      const k = await detectWebKind(root);
      checks.push(chk('d.web-app', k === fw, 'lie', `web-app.detectWebKind → '${fw}'`, `got '${k}'`));
    }
    cells.push({ pass: 'detectFramework', framework: fw, reported: null, files: [], checks, cell_status: classify(null, checks), notes: [`${Object.keys(mods).length} duplicated detectFramework implementations (one per pass module)`] });
  }
  return cells;
}

/** The shared canonicalId→file resolver (web-app.loadWebApp) against each web fixture,
 *  plus the two layouts that break it. */
async function phaseResolver(): Promise<Cell[]> {
  const { loadWebApp, resolveScreen } = await import('../../src/relay-server/passes/web-app');
  const ids = [['c_10_1', '10:1'], ['c_10_2', '10:2'], ['c_10_3', '10:3'], ['c_10_4', '10:4']] as const;
  const cells: Cell[] = [];
  for (const fw of ['react', 'next'] as const) {
    const checks: Check[] = [];
    const notes: string[] = [];
    const resolveAll = async (root: string) => {
      const ix = await loadWebApp(root);
      return ids.map(([id, fid]) => ({ id, hit: ix ? resolveScreen(ix, id, [fid]) : null, ix }));
    };
    const { root } = await copyFixture(fw, 'resolver');
    const res = await resolveAll(root);
    const miss = res.filter((x) => !x.hit).map((x) => x.id);
    checks.push(chk('rs.headers', miss.length === 0, 'stub', 'every stamped screen resolves by its `// canonicalId:` header', miss.length ? `unresolved: ${miss.join(', ')} (srcDir=${res[0].ix?.srcDir})` : res.map((x) => `${x.id}→${x.hit!.file.replace(root + '/', '')}`).join(', ')));
    // Without headers (an agent that rewrote a screen may drop the header before the pre-finalize re-stamp).
    const bare = await copyFixture(fw, 'resolver-noheader');
    for (const f of await appSources(bare.root, fw)) {
      const p = path.join(bare.root, f);
      await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace(/^\/\/\s*canonicalId:.*\n/m, ''));
    }
    const res2 = await resolveAll(bare.root);
    const miss2 = res2.filter((x) => !x.hit).map((x) => x.id);
    checks.push(chk('rs.no-headers', miss2.length === 0, 'stub', 'screens still resolve with no headers (the web pipeline never stamps them)', miss2.length ? `unresolved without headers: ${miss2.join(', ')}` : 'all resolve'));
    if (fw === 'next') {
      // Pristine app/ layout WITHOUT the pipeline-emitted src/resources/assets.ts.
      const clean = await copyFixture(fw, 'resolver-nosrc');
      await fs.rm(path.join(clean.root, 'src'), { recursive: true, force: true });
      const res3 = await resolveAll(clean.root);
      const miss3 = res3.filter((x) => !x.hit).map((x) => x.id);
      notes.push(`without src/: srcDir=${res3[0].ix?.srcDir}, unresolved=${miss3.join(', ') || 'none'}`);
      checks.push(chk('rs.next-src-shadow', miss.length === 0 || miss3.length < miss.length, 'lie', "the asset pass's src/resources/assets.ts must not hide app/ from the index", `with src/: ${miss.length} unresolved (srcDir=${res[0].ix?.srcDir}); without src/: ${miss3.length} unresolved (srcDir=${res3[0].ix?.srcDir})`));
    }
    cells.push({ pass: 'shared-resolver(web-app)', framework: fw, reported: null, files: [], checks, cell_status: classify(null, checks), notes });
  }
  return cells;
}

async function phaseHeaderRestamp(): Promise<Cell[]> {
  const { restampCanonicalHeaders } = await import('../../src/relay-server/canonicalize');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { root } = await copyFixture(fw, 'restamp');
    const files = await appSources(root, fw);
    for (const f of files) {
      const p = path.join(root, f);
      await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace(/^\/\/\s*canonicalId:.*\n/m, ''));
    }
    const canonical = JSON.parse(read(root, '.uix/canonical.json'));
    const before = await snapshot(root);
    const r = await restampCanonicalHeaders(root, canonical);
    const after = await snapshot(root);
    const diff = diffSnaps(before, after);
    const stamped = diff.filter((d) => d.change === 'modified').map((d) => d.file);
    const ok = fw === 'flutter' ? stamped.length >= 2 : stamped.length >= 3;
    const checks: Check[] = [chk('hdr.restamp', ok, 'stub', 'header re-stamp (run before finalize) restores `// canonicalId:` on built screens', `stamped=${JSON.stringify(r.stamped)} missingFiles=${JSON.stringify(r.missingFiles)}`)];
    if (fw !== 'flutter' && ok) {
      // The stamp must be the one the resolver reads (layer 1), and on Next it must
      // sit ABOVE 'use client' without displacing the directive.
      const web = await import('../../src/relay-server/passes/web-app');
      const bad: string[] = [];
      for (const f of stamped) {
        const src = read(root, f);
        const h = web.readHeader(src);
        const firstCode = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'));
        if (!h || !h.route) bad.push(`${f}: no header`);
        else if (fw === 'next' && /^['"]use client['"]/m.test(src) && !/^['"]use client['"]/.test(firstCode?.trim() ?? '')) bad.push(`${f}: 'use client' is no longer the first statement`);
      }
      checks.push(chk('hdr.web-header', bad.length === 0, 'lie', "the stamped header is `// canonicalId: <id> route: <route>` (above 'use client' on Next)", bad.join(' | ') || `${stamped.length} header(s) ok`));
    }
    await restampCanonicalHeaders(root, canonical);
    const d2 = diffSnaps(after, await snapshot(root));
    checks.push(chk('hdr.idempotent', d2.length === 0, 'lie', 'a second re-stamp changes nothing', d2.map((d) => `${d.change}:${d.file}`).join(', ') || 'no change'));
    cells.push({
      pass: 'restampCanonicalHeaders', framework: fw, reported: null, files: diff,
      checks, cell_status: classify(null, checks), notes: fw === 'flutter' ? ['flutter resolves only semantic/legacy lib/screens names; machine files like screen_10_3.dart resolve via the legacy slug'] : [],
    });
  }
  return cells;
}

async function phaseDesignSystem(): Promise<Cell[]> {
  const { generateDesignSystem, ensureScreenPreviewEntry } = await import('../../src/relay-server/design-system');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { root } = await copyFixture(fw, 'ds');
    // Fresh project: remove the fixture's theme so generation has to produce one.
    for (const t of ['lib/theme/app_theme.dart', 'src/theme/theme.ts', 'lib/theme.ts']) await fs.rm(path.join(root, t), { force: true });
    const before = await snapshot(root);
    const g = await generateDesignSystem(root, fw, { colors: ['#12ae89', '#1a1a1a', '#ffffff'], fonts: ['Inter'] });
    const diff = diffSnaps(before, await snapshot(root));
    const apiMentionsDart = /Color\(0x|EdgeInsets|BorderRadius/.test(g.api);
    const checks: Check[] = [
      chk('ds.theme-file', g.wrote && diff.some((d) => d.change === 'added'), 'stub', 'an importable theme/token file is generated before screen 1', `wrote=${g.wrote} themeFile=${g.themeFile} added=${diff.map((d) => d.file).join(', ') || 'none'}`),
      chk('ds.api-idiom', fw === 'flutter' || !apiMentionsDart, 'lie', "the design-system API injected into the agent's prompt is in this framework's idiom", `api excerpt: ${g.api.split('\n').slice(0, 1).join(' ')} … mentions Dart types: ${apiMentionsDart}; themeFile=${g.themeFile}`),
    ];
    if (fw !== 'flutter' && g.wrote) {
      // PG-31: the web theme is a typed token module + CSS custom properties at the
      // CONTRACTS §5 location, found by the SAME resolver the passes use, and its
      // `AppTheme = { color, spacing, radius }` parses with token-cleanup-web's parser.
      const web = await import('../../src/relay-server/passes/web-app');
      const tcw = await import('../../src/relay-server/passes/token-cleanup-web');
      const want = fw === 'react' ? 'src/theme/theme.ts' : 'lib/theme/theme.ts';
      const ix = await web.loadWebApp(root);
      const ts = exists(root, want) ? read(root, want) : '';
      const css = g.tokens.cssFile && exists(root, g.tokens.cssFile) ? read(root, g.tokens.cssFile) : '';
      const model = ts ? tcw.parseWebThemeSource(ts, path.join(root, want)) : null;
      const brand = model?.colors.find((c) => c.value.toLowerCase() === '#12ae89');
      const syn = tsSyntaxErrors({ [want]: ts });
      const problems = [
        ...(g.themeFile !== want ? [`themeFile=${g.themeFile}, want ${want}`] : []),
        ...(ix?.themeFile !== path.join(root, want) ? [`resolver themeFile=${ix?.themeFile ? path.relative(root, ix.themeFile) : 'null'}`] : []),
        ...(!model || model.themeSymbol !== 'AppTheme' || !brand || !model.spacing.length || !model.radius.length ? [`token object not parseable (symbol=${model?.themeSymbol}, colors=${model?.colors.length ?? 0}, spacing=${model?.spacing.length ?? 0}, radius=${model?.radius.length ?? 0})`] : []),
        ...(brand && !new RegExp(`--color-${brand.name}:\\s*#12ae89`, 'i').test(css) ? [`${g.tokens.cssFile ?? 'css'} lacks --color-${brand.name}`] : []),
        ...syn,
      ];
      checks.push(chk('ds.web-theme', problems.length === 0, 'lie', 'the web theme is a typed AppTheme {color, spacing, radius} module + matching CSS variables, at the resolver-found CONTRACTS §5 path', problems.join(' | ') || `${want}: AppTheme.color.${brand?.name}=#12ae89, ${model?.spacing.length} spacing, ${model?.radius.length} radius; ${g.tokens.cssFile} declares --color-${brand?.name}`));
    }
    const v = await ensureScreenPreviewEntry(root, fw, '10:3', { canonicalId: 'c_10_3', variant: { kind: 'modal', id: 'm_10_8', frameId: '10:8' } });
    checks.push(chk('ds.preview-variant', !!v, 'stub', 'a modal variant preview entry is produced (file on flutter, route on web)', `entry=${v ?? 'undefined'}${fw === 'flutter' && v ? `; presenter call present: ${/showModal_10_8\(context\)/.test(read(root, v))}` : ''}`));
    if (fw === 'next') {
      // Next App Router: a folder whose name starts with `_` is a PRIVATE folder and is
      // opted out of routing; `/_preview/…` needs `app/%5Fpreview/…`. The packet tells
      // the agent to register `/_preview/<id>` with no Next-specific instruction.
      const { buildAgentPacket } = await import('../../src/relay-server/agent-packet');
      const packet = buildAgentPacket({
        frame: { id: '10:3', name: 'Settings', width: 390, height: 844 }, tree: '', framework: 'next', frameworkLabel: 'Next.js',
        refImagePath: null, flowGraph: { entryFrameId: null, connections: [] }, frames: [], bootstrapped: true, assetCount: 0,
      } as unknown as Parameters<typeof buildAgentPacket>[0]);
      const tellsPrivateFolder = /%5F|private folder/i.test(packet);
      checks.push(chk('ds.next-preview-route', tellsPrivateFolder, 'stub', 'the Next packet explains how to mount /_preview/<id> (app/_preview is a private, unroutable folder)', `packet preview line: ${packet.split('\n').find((l) => /PREVIEW ROUTE/.test(l))?.slice(0, 200) ?? '(none)'}`));
    }
    cells.push({ pass: 'design-system(Pre-flight)', framework: fw, reported: null, files: diff, checks, cell_status: classify(null, checks), notes: [] });
  }
  return cells;
}

async function phaseSkeletonAndRestart(): Promise<Cell[]> {
  const { nukeGeneratedAppSurface } = await import('../../src/relay-server/canonicalize');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { root } = await copyFixture(fw, 'nuke');
    const before = await snapshot(root);
    const r = await nukeGeneratedAppSurface(root, fw);
    const diff = diffSnaps(before, await snapshot(root));
    const removedScreens = diff.filter((d) => d.change === 'removed').length;
    const ok = removedScreens > 0;
    const rstChecks = [chk('rst.clean-slate', ok, 'stub', 'restart removes the previously generated surface so the rebuild does not mix old+new files', `removed ${removedScreens} file(s); skipped=${(r as { skipped?: string }).skipped ?? 'no'}`)];
    if (fw !== 'flutter') {
      // Web has no single generated dir to drop: the clean slate is by marker. The
      // stamped screens must go; an unmarked hand-written module must stay.
      const s = SCREEN[fw];
      const stampedLeft = [s.login, s.home, s.settings, s.profile].filter((f) => exists(root, f));
      const hand = fw === 'react' ? 'src/modal/modalController.ts' : 'components/modalController.ts';
      rstChecks.push(chk('rst.stamped-removed', stampedLeft.length === 0, 'stub', 'every header-stamped generated screen is removed', stampedLeft.join(', ') || 'all removed'));
      rstChecks.push(chk('rst.hand-kept', exists(root, hand), 'lie', 'an unmarked (hand-authored) module is never deleted', exists(root, hand) ? `${hand} kept` : `${hand} DELETED`));
      if (fw === 'next') rstChecks.push(chk('rst.previews', !exists(root, 'app/_preview') && !exists(root, 'app/%5Fpreview'), 'stub', 'verify preview routes are removed', exists(root, 'app/_preview') ? 'app/_preview left' : 'removed'));
    }
    // A restart after a FINALIZED build: the shared components 7a itself wrote carry
    // no canonical header, but they are pipeline output and import generated modules
    // the nuke removes (B56 fix round: components/SearchGlyph.tsx survived, importing
    // the removed '@/…/assets', and tsc broke with no warning). Real 7a output, then
    // a hand-written importer of it (Next through the `@/` alias), then the nuke.
    {
      const x = await runOnePass(fw, 'extractComponents');
      const extracted = x.files.filter((d) => d.change === 'added' && /\.(tsx?|dart)$/.test(d.file)).map((d) => d.file);
      const comp = extracted.find((f) => fw === 'flutter' || /^(src\/)?components\//.test(f));
      let importer: string | null = null;
      if (comp && fw !== 'flutter') {
        const name = path.basename(comp).replace(/\.tsx?$/, '');
        const exported = /export\s+(?:function|const)\s+([A-Za-z0-9_]+)/.exec(read(x.root, comp))?.[1] ?? name;
        importer = fw === 'next' ? 'components/HandToolbar.tsx' : 'src/extra/HandToolbar.tsx';
        const spec = fw === 'next' ? `@/${comp.replace(/\.tsx?$/, '')}` : path.posix.relative('src/extra', comp.replace(/\.tsx?$/, ''));
        await fs.mkdir(path.dirname(path.join(x.root, importer)), { recursive: true });
        await fs.writeFile(path.join(x.root, importer), `import { ${exported} } from '${spec}';\nexport const HandToolbar = ${exported};\n`);
      }
      const n = await nukeGeneratedAppSurface(x.root, fw);
      const survivors = extracted.filter((f) => exists(x.root, f));
      rstChecks.push(chk('rst.extracted-removed', !!comp && survivors.length === 0, 'stub', "a restart after finalize removes the shared components 7a wrote (pipeline output with no canonical header)",
        !comp ? `7a extracted nothing on the fixture (added: ${extracted.join(', ') || 'none'}) — nothing to grade` : survivors.length ? `kept: ${survivors.join(', ')}` : `removed ${extracted.join(', ')}`));
      if (importer) {
        const warned = (n.warnings ?? []).some((w) => w.startsWith(importer!) && w.includes(comp!));
        rstChecks.push(chk('rst.kept-importer-warned', exists(x.root, importer) && warned, 'lie', 'a hand-written file importing a removed module (through the `@/` alias on Next) is kept AND named in the restart warnings',
          `${importer} ${exists(x.root, importer) ? 'kept' : 'DELETED'}; warnings: ${(n.warnings ?? []).join(' | ').slice(0, 300) || 'none'}`));
      }
    }
    cells.push({
      pass: 'restart clean-slate (nukeGeneratedAppSurface)', framework: fw, reported: null, files: diff.slice(0, 40),
      checks: rstChecks, cell_status: classify(null, rstChecks), notes: [],
    });
    // Run the skeleton generator for this framework on an EMPTY project + the fixture
    // canonical, then grade what it wrote: one header-stamped stub per canonical screen
    // and a route registry the passes can parse. Web contract (PG-02): canonicalize
    // exports `generateWebSkeleton(projectRoot, canonical, framework)`; its output is
    // graded through the SAME resolver the passes use (web-app.ts), never its report.
    const canon = await import('../../src/relay-server/canonicalize');
    const skRoot = path.join(WS, 'projects', `skeleton-${fw}-${++copySeq}`);
    await fs.mkdir(path.join(skRoot, '.uix'), { recursive: true });
    const canonical = JSON.parse(read(path.join(FIXTURES, fw), '.uix/canonical.json'));
    const gen = fw === 'flutter'
      ? (c: unknown) => canon.generateFlutterSkeleton(skRoot, c as never)
      : (canon as Record<string, unknown>).generateWebSkeleton as undefined | ((root: string, c: unknown, f: string) => Promise<unknown>);
    let skChecks: Check[];
    if (!gen) {
      skChecks = [chk('sk.generator', false, 'stub', 'a skeleton generator exists for this framework',
        'canonicalize.ts exports no generateWebSkeleton; ai-screen-loop.ts only calls generateFlutterSkeleton and logs "[canon] skeleton SKIPPED — <fw> not yet supported by this phase; flutter-only"')];
    } else {
      const runGen = () => (fw === 'flutter' ? (gen as (c: unknown) => Promise<unknown>)(canonical) : (gen as (r: string, c: unknown, f: string) => Promise<unknown>)(skRoot, canonical, fw));
      await runGen();
      const files = await listFiles(skRoot, '', /\.(dart|tsx?|jsx?)$/);
      const stamped = new Set<string>();
      for (const f of files) { const h = /^\/\/\s*canonicalId:\s*(\S+)\s+route:/m.exec(read(skRoot, f)); if (h) stamped.add(h[1]); }
      const missing = canonical.screens.map((x: { canonicalId: string }) => x.canonicalId).filter((id: string) => !stamped.has(id));
      skChecks = [
        chk('sk.generator', true, 'stub', 'a skeleton generator exists for this framework', `${files.length} file(s) written`),
        chk('sk.stamped-stubs', missing.length === 0, 'stub', 'one `// canonicalId: <id> route: <route>` stamped stub per canonical screen', missing.length ? `missing: ${missing.join(', ')}` : 'all stamped'),
      ];
      if (fw !== 'flutter') skChecks.push(...await gradeWebSkeleton(skRoot, fw, canonical, files));
      // Additive + idempotent: a second run over its own output changes nothing.
      const snap1 = await snapshot(skRoot);
      await runGen();
      const d2 = diffSnaps(snap1, await snapshot(skRoot));
      skChecks.push(chk('sk.idempotent', d2.length === 0, 'lie', 'a second skeleton run over its own output changes nothing', d2.length ? d2.map((d) => `${d.change}:${d.file}`).join(', ') : 'no change'));
    }
    cells.push({ pass: 'Skeleton (GEN_PHASE 3)', framework: fw, reported: null, files: [], checks: skChecks, cell_status: classify(null, skChecks), notes: [] });
  }
  return cells;
}

/** The web skeleton's contract, graded from the files through the passes' own
 *  resolver: a parseable route table + router (react) / file-system routes (next)
 *  for every canonical screen, a `/_preview/<frame>` route for every verified frame
 *  (lead, state, modal) — on Next at the routable `%5Fpreview` escape — every stub
 *  indexed as a PLACEHOLDER (so 7d grades an edge to it `missing`), and sources that
 *  parse. */
async function gradeWebSkeleton(root: string, fw: 'react' | 'next', canonical: {
  screens: Array<{ canonicalId: string; route: string; frameIds: string[]; states: Array<{ id: string; frameId: string }>; modals: Array<{ id: string; frameId: string }> }>;
}, files: string[]): Promise<Check[]> {
  const web = await import('../../src/relay-server/passes/web-app');
  const { webPreviewRoute } = await import('../../src/relay-server/agent-packet');
  const checks: Check[] = [];
  const routesRel = fw === 'react' ? 'src/router/routes.ts' : 'lib/routes.ts';
  const table = exists(root, routesRel) ? web.parseRouteTable(read(root, routesRel)) : null;
  const noConst = canonical.screens.filter((c) => !table?.routeToConst.has(c.route)).map((c) => `${c.canonicalId}(${c.route})`);
  checks.push(chk('sk.route-table', !!table && noConst.length === 0, 'stub', `${routesRel} declares a ROUTES constant for every canonical route`, table ? (noConst.length ? `no constant for ${noConst.join(', ')}` : `${table.constToRoute.size} route constant(s)`) : `${routesRel} missing`));

  const ix = await web.loadWebApp(root);
  const unrouted: string[] = [];
  const notPlaceholder: string[] = [];
  for (const c of canonical.screens) {
    const hit = ix ? web.resolveScreen(ix, c.canonicalId, c.frameIds) : null;
    const served = !!hit && (fw === 'react'
      ? [...web.parseRouteElements(read(root, 'src/App.tsx')).entries()].some(([k, comp]) => k === `ROUTES.${hit.routeConst}` && comp === hit.componentName)
      : !!ix?.appDir && web.nextAppRoute(ix.appDir, hit.file) === c.route);
    if (!served) unrouted.push(`${c.canonicalId}${hit ? ` (${path.relative(root, hit.file)})` : ' (unresolved)'}`);
    if (!hit?.placeholder) notPlaceholder.push(c.canonicalId);
  }
  checks.push(chk('sk.router', !!ix && unrouted.length === 0, 'stub', fw === 'react' ? 'src/App.tsx <Routes> mounts each canonical screen at its ROUTES constant' : 'each canonical screen is an app-dir page served at its canonical route', unrouted.length ? `not routed: ${unrouted.join(', ')}` : `${canonical.screens.length} screen(s) routed`));
  checks.push(chk('sk.placeholders', !!ix && notPlaceholder.length === 0, 'lie', 'every unbuilt stub is indexed as a placeholder by the shared resolver (never as a built screen)', notPlaceholder.length ? `indexed as built: ${notPlaceholder.join(', ')}` : 'all stubs are placeholders'));

  const frames = canonical.screens.flatMap((c) => [c.states[0]?.frameId ?? c.frameIds[0], ...c.states.slice(1).map((s) => s.frameId), ...c.modals.map((m) => m.frameId)]).filter(Boolean) as string[];
  const noPreview: string[] = [];
  for (const f of frames) {
    const route = webPreviewRoute(f);
    if (fw === 'react') {
      if (!new RegExp(`<Route\\s+path=["']${route}["']`).test(read(root, 'src/App.tsx'))) noPreview.push(route);
    } else {
      const page = path.join(root, 'app', '%5Fpreview', route.split('/').pop()!, 'page.tsx');
      if (!fsSync.existsSync(page) || !ix?.appDir || web.nextAppRoute(ix.appDir, page) !== route) noPreview.push(route);
    }
  }
  checks.push(chk('sk.previews', noPreview.length === 0, 'stub', `a /_preview/<frame> verify route for every lead/state/modal frame${fw === 'next' ? ' (app/%5Fpreview/<frame>/page.tsx — `_preview` is a private folder)' : ''}`, noPreview.length ? `missing: ${noPreview.join(', ')}` : `${frames.length} preview route(s)`));

  const src: Record<string, string> = {};
  for (const f of files) if (/\.(tsx?|jsx?)$/.test(f)) src[f] = read(root, f);
  const syn = tsSyntaxErrors(src);
  checks.push(chk('sk.syntax', syn.length === 0, 'lie', 'every generated source parses', syn.join(' | ') || `${Object.keys(src).length} file(s) ok`));
  return checks;
}

/** Put a fixture copy back into the RESOLVE-path state: opaque on-disk names under
 *  `into`, no asset-map, no resources module (the legacy re-export stub included). */
async function unApplyAssets(root: string, fw: Fw, into: string): Promise<void> {
  await fs.rm(path.join(root, '.uix', 'asset-map.json'), { force: true });
  await fs.rm(path.join(root, RES_FILE[fw]), { force: true });
  if (fw !== 'flutter') await fs.rm(path.join(root, 'src', 'resources', 'assets.ts'), { force: true });
  const from = ASSET_DIR[fw];
  const moves: Array<[string, string]> = [
    [`${from}/icons/search_icon.svg`, `${into}/icons/vector_10_20.svg`],
    [`${from}/images/map_dark.png`, `${into}/images/image_10_40.png`],
    [`${from}/images/promo_banner.png`, `${into}/images/image_10_41.png`],
    [`${from}/images/user_avatar.png`, `${into}/images/user_avatar_10_31.png`],
  ];
  for (const [a, b] of moves) {
    await fs.mkdir(path.dirname(path.join(root, b)), { recursive: true });
    await fs.rename(path.join(root, a), path.join(root, b));
  }
  if (into !== from) await fs.rm(path.join(root, from), { recursive: true, force: true });
}

async function phaseAssetPhase(): Promise<Cell[]> {
  const { runAssetPhaseOnBuild } = await import('../../src/relay-server/passes/asset-phase');
  const { gatherExistingAssets } = await import('../../src/relay-server/reference-render');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    // Web: root `assets/` is where EVERY framework localized before B56 (a web server
    // never serves it) — the phase must migrate it; public/assets is the contract.
    const variants: Array<{ label: string; into: string }> = [{ label: 'assets/ (where localize writes)', into: 'assets' }];
    if (fw !== 'flutter') variants.push({ label: 'public/assets (where the web server serves)', into: 'public/assets' });
    for (const v of variants) {
      const { projectId, root } = await copyFixture(fw, 'assetphase');
      await unApplyAssets(root, fw, v.into);
      const gathered = await gatherExistingAssets(root, fw);
      const before = await snapshot(root);
      const r1 = await runAssetPhaseOnBuild(projectId, { projectRoot: root, skipBuildCheck: true });
      const mid = await snapshot(root);
      const r2 = await runAssetPhaseOnBuild(projectId, { projectRoot: root, skipBuildCheck: true });
      const after = await snapshot(root);
      const d1 = diffSnaps(before, mid);
      const d2 = diffSnaps(mid, after);
      const resFile = RES_FILE[fw];
      const res = read(root, resFile);
      // After run 1, every asset path literal left in app code must still point at a
      // file that exists (the pass RENAMED the files; anything it did not re-point is
      // now a broken image). A web literal resolves the way the server serves it.
      const dangling: string[] = [];
      for (const f of await appSources(root, fw)) {
        if (f === resFile) continue;
        for (const m of read(root, f).matchAll(/['"]\/?((?:public\/)?assets\/[^'"$]+)['"]/g)) {
          const p = m[1];
          const ok = fw === 'flutter' ? exists(root, p) : exists(root, path.join('public', p.replace(/^public\//, '')));
          if (!ok) dangling.push(`${f}: '${p}'`);
        }
      }
      const checks: Check[] = [
        chk('ap.gather', gathered.length === 4, 'stub', 'the 4 on-disk assets are gathered', `gathered ${gathered.length}: ${gathered.map((g) => g.relPath).join(', ')}`),
        chk('ap.applied', r1.status === 'applied' && !!res, 'stub', 'run 1 renames + emits the resources file + asset-map', `status=${r1.status}${r1.reason ? ` (${r1.reason})` : ''}${r1.error ? ` error=${r1.error}` : ''}; resources=${res ? resFile : 'none'}; renamed=${r1.renamed}; repointed=${r1.repointed}`),
        chk('ap.refs-resolve', r1.status !== 'applied' || dangling.length === 0, 'lie', 'no code reference is left pointing at a file the pass renamed away', dangling.join(' | ') || 'all asset literals resolve'),
        chk('ap.idempotent', d2.length === 0, 'lie', 'run 2 is a no-op (already applied)', `run2 status=${r2.status}${r2.reason ? ` (${r2.reason})` : ''}; run2 changed ${d2.length} file(s): ${d2.map((d) => `${d.change}:${d.file}`).slice(0, 8).join(', ')}`),
      ];
      if (fw !== 'flutter' && res) {
        const values = [...res.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
        const served = values.length > 0 && values.every((x) => /^\/assets\//.test(x));
        checks.push(chk('ap.web-urls', served, 'lie', 'emitted symbol values are URLs the web server serves (`/assets/…`, no `public/` prefix)', res.split('\n').filter((l) => /:\s*'/.test(l)).slice(0, 3).join(' | ')));
        // Every served URL is backed by a file the server will actually serve.
        const unbacked = values.filter((x) => !exists(root, path.join('public', x)));
        checks.push(chk('ap.served-files', values.length > 0 && unbacked.length === 0, 'lie', 'every emitted URL is a file under public/ (so it is in the build output)', unbacked.join(', ') || `${values.length} URL(s) backed by public/`));
        const rootLeft = await listFiles(root, 'assets', /\.(svg|png)$/);
        checks.push(chk('ap.no-root-assets', rootLeft.length === 0, 'stub', 'no design asset is left in the unserved root assets/', rootLeft.join(', ') || 'none'));
      }
      cells.push({ pass: `asset-phase [${v.label}]`, framework: fw, reported: { status: r1.status, ...(r1.reason ? { reason: r1.reason } : {}), counts: { gathered: r1.gathered, renamed: r1.renamed, repointed: r1.repointed }, warnings: r1.warnings, ...(r1.error ? { error: r1.error } : {}) }, files: d1.slice(0, 30), checks, cell_status: classify(null, checks), notes: fw !== 'flutter' && v.into === 'assets' ? ['web: root assets/ is the pre-B56 localize location; the phase migrates it into public/assets'] : [] });
    }
  }
  return cells;
}

async function phaseResolveCanonical(): Promise<Cell[]> {
  const { resolveCanonicalFromCode } = await import('../../src/relay-server/passes/resolve-canonical');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'resolve');
    const beforeScreens = JSON.parse(read(root, '.uix/canonical.json')).screens.length;
    const c = await resolveCanonicalFromCode(projectId, { projectRoot: root, noAi: true });
    const afterScreens = JSON.parse(read(root, '.uix/canonical.json')).screens?.length ?? 0;
    // The design has exactly c_10_1..c_10_5; a verify preview or a redirect-only root
    // page derived as a "screen" would put a harness page into the app's canonical.
    const want = new Set(['c_10_1', 'c_10_2', 'c_10_3', 'c_10_4', 'c_10_5']);
    const foreign = c.screens.map((x) => x.canonicalId).filter((id) => !want.has(id));
    const m9 = c.modals.find((m) => m.canonicalId === 'm_10_9');
    // An app with NO screens left (every source root gone): the empty derivation must
    // not be written over the real canonical.json.
    const bare = await copyFixture(fw, 'resolve-empty');
    for (const d of fw === 'flutter' ? ['lib/screens'] : ['src', 'app', 'components']) await fs.rm(path.join(bare.root, d), { recursive: true, force: true });
    const canonBefore = read(bare.root, '.uix/canonical.json');
    const ce = await resolveCanonicalFromCode(bare.projectId, { projectRoot: bare.root, noAi: true }) as typeof c & { persisted?: boolean; skippedReason?: string };
    const canonAfter = read(bare.root, '.uix/canonical.json');
    const checks = [
      chk('rc.screens', c.screens.length >= 4, 'stub', 'screens derived from the emitted code (≥4 built screens)', `derived ${c.screens.length} screen(s): ${c.screens.map((s) => s.canonicalId).join(', ')}; warnings: ${c.warnings.join(' | ')}`),
      chk('rc.edges', c.flow.edges.length > 0, 'stub', 'flow edges derived from navigation calls', `${c.flow.edges.length} edge(s)`),
      chk('rc.no-clobber', afterScreens >= Math.min(beforeScreens, c.screens.length) && !(c.screens.length === 0 && beforeScreens > 0 && afterScreens === 0), 'lie', 'an unimplemented strategy never overwrites a real canonical.json with an empty one',
        `canonical.json screens before=${beforeScreens} after=${afterScreens}; backup=${exists(root, '.uix/canonical.frames.json.bak')}`),
      chk('rc.only-design-screens', foreign.length === 0, 'lie', 'no verify preview / redirect-only root page is derived as a screen of the app', foreign.join(', ') || 'only c_10_1..c_10_5'),
      chk('rc.modal-bound', m9?.baseCanonicalId === 'c_10_2', 'stub', 'the modal home presents (m_10_9) is derived with its base screen c_10_2', m9 ? `m_10_9 base=${m9.baseCanonicalId || '(none)'}` : `no m_10_9 (modals: ${c.modals.map((m) => m.canonicalId).join(', ') || 'none'})`),
      chk('rc.empty-not-persisted', ce.screens.length > 0 || (canonAfter === canonBefore && ce.persisted === false && !!ce.skippedReason), 'lie', 'an app with no screens left derives an empty canonical that is NOT written over canonical.json (skipped + reason)',
        `derived ${ce.screens.length} screen(s); canonical.json ${canonAfter === canonBefore ? 'unchanged' : 'OVERWRITTEN'}; persisted=${ce.persisted}; reason=${ce.skippedReason ?? '(none)'}`),
    ];
    cells.push({ pass: 'resolve-canonical', framework: fw, reported: null, files: [], checks, cell_status: classify(null, checks), notes: [] });
  }
  return cells;
}

async function phaseFlowRequeue(flowCells: Map<Fw, PassRun>): Promise<Cell[]> {
  const { planFlowRequeue } = await import('../../src/relay-server/passes/flow-requeue');
  const { planInteractionRequeue, auditInteractions } = await import('../../src/relay-server/passes/interaction-audit');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const r = flowCells.get(fw)!;
    const rep = flowReport(r.root);
    const canon = JSON.parse(read(r.root, '.uix/canonical.json'));
    const runScreens = ['10:1', '10:2', '10:3', '10:4', '10:5'].map((f) => ({ frameId: f, status: 'done' }));
    const dec = planFlowRequeue(rep?.findings ?? [], canon.screens, runScreens);
    const byFrame = new Map(dec.map((d) => [d.frameId, d]));
    const audit = await auditInteractions(r.projectId, { projectRoot: r.root, noReport: true });
    const idec = planInteractionRequeue(audit.report.findings, canon.screens, runScreens);
    const checks = [
      chk('q.placeholder-edge', !!byFrame.get('10:2')?.findings.some((l) => /c_10_5/.test(l)), 'stub', 'home (10:2) is requeued for E3 → a placeholder / un-built target', byFrame.get('10:2')?.findings.join(' | ') ?? `home not requeued; E3 finding: ${rep?.findings.find((x) => x.to === 'c_10_5')?.status ?? 'none'}`),
      chk('q.preview-only-modal', !!byFrame.get('10:3')?.findings.some((l) => /m_10_8/.test(l)), 'lie', 'settings (10:3) is requeued for E5 → modal only the preview presents', byFrame.get('10:3')?.findings.join(' | ') ?? `settings not requeued; E5 finding: ${rep?.findings.find((x) => x.to === 'm_10_8')?.status ?? 'none'}`),
      chk('q.dead-control', idec.some((d) => d.frameId === '10:3'), 'stub', "settings (10:3) is requeued for its dead 'Resolve' control", JSON.stringify(idec.map((d) => ({ f: d.frameId, n: d.findings.length })))),
    ];
    cells.push({ pass: 'flow-requeue + interaction-requeue', framework: fw, reported: null, files: [], checks, cell_status: classify(null, checks), notes: [] });
  }
  return cells;
}

async function phaseAnalyzeGate(): Promise<Cell[]> {
  const { runAnalyzeGate } = await import('../../src/relay-server/passes/finalize');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { root } = await copyFixture(fw, 'gate');
    const prompts: string[] = [];
    // The live analyzer is the production default (flutterAnalyze). No flutter SDK here,
    // so it returns null and the gate falls back to the persisted finalErrors.
    const g = await runAnalyzeGate({
      projectRoot: root, initialErrors: 2, model: 'claude' as never,
      runModel: async (_m, p) => { prompts.push(p); return { text: 'fixed' }; },
    });
    const prompt = prompts[0] ?? '';
    const wrongIdiom = fw !== 'flutter' && /flutter analyze|Flutter project/.test(prompt);
    let live: Check | null = null;
    if (fw !== 'flutter') {
      // A minimal real TS project (relay-server's own typescript linked in as the
      // project's compiler) with 2 planted type errors; the "repair" fixes the file.
      // The gate must measure 2 with tsc, then RE-MEASURE 0 after the repair.
      const tp = await fs.mkdtemp(path.join(os.tmpdir(), `parity-gate-${fw}-`));
      await fs.mkdir(path.join(tp, 'node_modules'), { recursive: true });
      await fs.symlink(path.dirname(require.resolve('typescript/package.json')), path.join(tp, 'node_modules', 'typescript'));
      await fs.writeFile(path.join(tp, 'package.json'), JSON.stringify({ name: 'gate', private: true, dependencies: fw === 'next' ? { next: '16', react: '19' } : { react: '19' } }));
      await fs.writeFile(path.join(tp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, lib: ['es2020'], types: [] }, include: ['src/**/*.ts'] }));
      await fs.mkdir(path.join(tp, 'src'), { recursive: true });
      await fs.writeFile(path.join(tp, 'src', 'a.ts'), "export const n: number = 'x';\nexport const s: string = 1;\n");
      const lp: string[] = [];
      const lg = await runAnalyzeGate({
        projectRoot: tp, model: 'claude' as never,
        runModel: async (_m, p) => { lp.push(p); await fs.writeFile(path.join(tp, 'src', 'a.ts'), "export const n: number = 1;\nexport const s: string = 'x';\n"); return { text: 'fixed' }; },
      });
      live = chk('g.tsc-live', lg.initialErrors === 2 && lg.errors === 0 && lg.ok && lg.repairAttempted && /TS2322/.test(lp[0] ?? ''), 'lie', "the gate measures with the project's own tsc (2 planted errors, listed in the prompt) and re-measures 0 after the repair",
        `initial=${lg.initialErrors} after=${lg.errors} ok=${lg.ok} tool=${lg.tool ?? '?'} prompt lists TS2322: ${/TS2322/.test(lp[0] ?? '')}`);
      await fs.rm(tp, { recursive: true, force: true });
    }
    const checks = [
      chk('g.measures', fw === 'flutter' || g.errors !== 2 || !g.repairAttempted, 'lie', 'after a repair the gate RE-MEASURES with this framework\'s checker (tsc for web) instead of keeping the stale count', `errors=${g.errors} initial=${g.initialErrors} repairAttempted=${g.repairAttempted} ok=${g.ok}`),
      chk('g.prompt-idiom', !wrongIdiom, 'lie', "the repair prompt names this framework's checker", prompt.split('\n')[0]?.slice(0, 160) ?? '(no prompt)'),
      ...(live ? [live] : []),
    ];
    cells.push({ pass: 'analyze-gate (P3 completion gate)', framework: fw, reported: null, files: [], checks, cell_status: classify(null, checks), notes: fw === 'flutter' ? ['flutter SDK absent here: live analyze → null, fallback path exercised'] : [] });
  }
  return cells;
}

/** Verify/preview serving: the web verify harness screenshots `/_preview/<id>` out of the
 *  static build via serveDir's SPA fallback. A Next static export writes one HTML file
 *  PER route (`out/_preview/10-3.html`), so the fallback serves the ROOT page instead. */
async function phaseVerifyServing(): Promise<Cell[]> {
  const { serveDir } = await import('../../src/relay-server/visual-routes');
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-out-'));
  await fs.mkdir(path.join(out, '_preview'), { recursive: true });
  await fs.writeFile(path.join(out, 'index.html'), '<html><body>ROOT PAGE</body></html>');
  await fs.writeFile(path.join(out, '_preview', '10-3.html'), '<html><body>SETTINGS PREVIEW</body></html>');
  // trailingSlash: true writes out/_preview/10-4/index.html; a real export also has
  // _next/ + 404.html — a route with no document must never render the ROOT page.
  await fs.mkdir(path.join(out, '_preview', '10-4'), { recursive: true });
  await fs.writeFile(path.join(out, '_preview', '10-4', 'index.html'), '<html><body>PROFILE PREVIEW</body></html>');
  await fs.mkdir(path.join(out, '_next'), { recursive: true });
  await fs.writeFile(path.join(out, '404.html'), '<html><body>NOT FOUND</body></html>');
  const srv = await serveDir(out);
  let body = ''; let body4 = ''; let bodyMissing = ''; let missingStatus = 0; let doc = '';
  try {
    const base = srv.url.replace(/\/index\.html$/, '').replace(/\/$/, '');
    body = await (await fetch(`${base}/_preview/10-3`)).text();
    body4 = await (await fetch(`${base}/_preview/10-4`)).text();
    const m = await fetch(`${base}/_preview/10-9`);
    missingStatus = m.status; bodyMissing = await m.text();
    doc = srv.servedDocument('/_preview/10-9') ?? '(none)';
  } finally { srv.close(); }
  const strip = (b: string) => b.replace(/<[^>]+>/g, '').trim();
  const vChecks = [
    chk('v.next-export-route', /SETTINGS PREVIEW/.test(body), 'lie', 'GET /_preview/10-3 on a Next `output:"export"` build serves out/_preview/10-3.html (the screen under test)', `served: ${strip(body)}`),
    chk('v.next-trailing-slash', /PROFILE PREVIEW/.test(body4), 'lie', 'GET /_preview/10-4 serves out/_preview/10-4/index.html (trailingSlash export)', `served: ${strip(body4)}`),
    chk('v.next-missing-route', missingStatus === 404 && !/ROOT PAGE/.test(bodyMissing) && doc === '404', 'lie', 'a preview route with no exported document is a 404 (identity: servedDocument=404), never the ROOT page', `HTTP ${missingStatus} served: ${strip(bodyMissing)}; servedDocument=${doc}`),
  ];
  return [{
    pass: 'verify serving (/_preview/<id> on a static export)', framework: 'next', reported: null, files: [],
    checks: vChecks,
    cell_status: classify(null, vChecks),
    notes: ['the identity assertion compares location.pathname only; the URL stays /_preview/10-3 while the ROOT page renders, so the wrong screen is scored silently'],
  }];
}

/** Do the design's assets reach the served web build? The asset phase runs for real
 *  on a react copy in the RESOLVE state with the assets where every build localized
 *  them before B56 (root `assets/`); then a real `vite build` bundles a page that
 *  renders every `assets.<symbol>` exactly as the packet tells the agent
 *  (`<img src={assets.x}>`), and each URL is fetched from the served build. */
async function phaseWebAssetServing(): Promise<Cell[]> {
  let viteBin = '';
  try { viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'); } catch { /* absent */ }
  if (!viteBin || !fsSync.existsSync(viteBin)) {
    return [{ pass: 'web asset serving (vite build)', framework: 'react', reported: null, files: [], checks: [chk('va.vite', false, 'stub', 'vite available to probe', 'vite not resolvable')], cell_status: 'SKIPPED_WITH_REASON', notes: ['vite absent'] }];
  }
  const { runAssetPhaseOnBuild } = await import('../../src/relay-server/passes/asset-phase');
  const { serveDir } = await import('../../src/relay-server/visual-routes');
  const { projectId, root } = await copyFixture('react', 'vite-assets');
  await unApplyAssets(root, 'react', 'assets');
  const ap = await runAssetPhaseOnBuild(projectId, { projectRoot: root, skipBuildCheck: true });
  const res = read(root, RES_FILE.react);
  const symbols = [...res.matchAll(/^\s*([A-Za-z0-9_$]+):\s*'([^']+)'/gm)].map((m) => ({ sym: m[1], url: m[2] }));
  // The app's own vite config needs @vitejs/plugin-react (not installed here): build
  // the probe page with an empty config — the public/ → dist/ copy is vite's own.
  await fs.writeFile(path.join(root, 'probe.config.mjs'), 'export default {};\n');
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/probe-main.ts"></script></body></html>');
  await fs.writeFile(path.join(root, 'probe-main.ts'), `import { assets } from './src/resources/assets';\ndocument.getElementById('root')!.innerHTML = Object.values(assets).map((u) => \`<img src="\${u}">\`).join('');\n`);
  const r = spawnSync(process.execPath, [viteBin, 'build', '--config', 'probe.config.mjs', '--logLevel', 'error'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const bundled = (await listFiles(root, 'dist/assets', /\.js$/)).map((f) => read(root, f)).join('\n');
  const results: string[] = [];
  let ok200 = 0;
  const srv = await serveDir(path.join(root, 'dist'));
  try {
    const base = srv.url.replace(/\/index\.html$/, '');
    for (const { sym, url } of symbols) {
      const resp = await fetch(`${base}${url}`);
      const body = Buffer.from(await resp.arrayBuffer());
      const want = fsSync.existsSync(path.join(root, 'public', url)) ? fsSync.readFileSync(path.join(root, 'public', url)) : null;
      const same = !!want && Buffer.compare(body, want) === 0;
      if (resp.status === 200 && same && bundled.includes(url)) ok200++;
      results.push(`${sym} ${url} → HTTP ${resp.status}${same ? '' : ' (bytes differ)'}${bundled.includes(url) ? '' : ' (not in bundle)'}`);
    }
  } finally { srv.close(); }
  const shipped = ap.status === 'applied' && symbols.length === 4 && ok200 === symbols.length;
  return [{
    pass: 'web asset serving (vite build)', framework: 'react', reported: null, files: [],
    checks: [chk('va.shipped', shipped, 'lie', 'after the asset phase, every `assets.<symbol>` URL the bundle renders is served by the real vite build (HTTP 200, the design bytes)', `asset phase ${ap.status}; vite exit=${r.status}${r.stderr ? ` ${r.stderr.slice(0, 200)}` : ''}; ${results.join(' | ') || 'no symbols emitted'}`)],
    cell_status: shipped ? 'IMPLEMENTED' : 'LIES',
    notes: ['next: `next build` serves public/ the same way — proven with the real next binary in scratchpad/web-real/B56 (not required by this harness)'],
  }];
}

/** POST /api/ai/runs/:runId/finalize against a run of each framework (standalone P7). */
async function phaseStandaloneFinalize(): Promise<Cell[]> {
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { registerScreenLoopRoutes } = await import('../../src/relay-server/ai-screen-loop');
  const cells: Cell[] = [];
  const app = express();
  app.use(express.json());
  registerScreenLoopRoutes(app);
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'endpoint');
    const runId = `run_parity_${fw}`;
    const now = new Date().toISOString();
    const run = {
      id: runId, projectId, kind: 'whole-app', framework: fw, model: 'human', verify: true, status: 'done',
      screens: ['10:1', '10:2', '10:3', '10:4'].map((f) => ({ frameId: f, frameName: f, status: 'done', matched: true, spec: { width: 390, height: 844 } })),
      createdAt: now, updatedAt: now,
    };
    await fs.mkdir(path.join(root, '.uix', 'runs'), { recursive: true });
    await fs.writeFile(path.join(root, '.uix', 'runs', `${runId}.json`), JSON.stringify(run, null, 2));
    await fs.writeFile(path.join(root, '.uix', 'finalize-report.json'), JSON.stringify({ stale: true }));
    const before = await snapshot(root);
    const res = await request(app).post(`/api/ai/runs/${runId}/finalize`).send({ projectId });
    const diff = diffSnaps(before, await snapshot(root));
    const report = res.body?.report;
    const rep = read(root, '.uix/finalize-report.json');
    const checks = [
      chk('ep.200', res.status === 200, 'error', 'endpoint runs Phase 7 standalone on a done run', `HTTP ${res.status} ${res.status !== 200 ? JSON.stringify(res.body).slice(0, 300) : ''}`),
      chk('ep.framework', report?.framework === fw, 'lie', `report.framework = '${fw}'`, `report.framework=${report?.framework}`),
      chk('ep.fresh-report', !!rep && !/"stale"/.test(rep), 'lie', 'the stale finalize-report.json is replaced by this build\'s report', rep.slice(0, 120)),
      chk('ep.did-work', diff.some((d) => !d.file.startsWith('.uix/')), 'stub', 'standalone finalize changed app source (it did real work on this framework)', `${diff.filter((d) => !d.file.startsWith('.uix/')).length} source file(s) changed`),
    ];
    const statuses = (report?.passes ?? []).map((p: { name: string; status: string }) => `${p.name}:${p.status}`).join(', ');
    cells.push({ pass: 'POST /api/ai/runs/:runId/finalize', framework: fw, reported: { status: `${res.status}`, counts: {}, warnings: [statuses] }, files: diff.slice(0, 40), checks, cell_status: classify(null, checks), notes: [] });
  }
  return cells;
}

/** finalize({dryRun:true}) must leave the project byte-identical — no source, no reports. */
async function phaseFinalizeDryRun(): Promise<Cell[]> {
  const { finalizeApp } = await import('../../src/relay-server/passes/finalize');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'dryrun');
    const before = await snapshot(root);
    await finalizeApp(projectId, { projectRoot: root, dryRun: true });
    const diff = diffSnaps(before, await snapshot(root), /^$/);
    const checks = [chk('dry.no-writes', diff.length === 0, 'lie', 'a dry-run finalize writes nothing (no source, no .uix reports)', diff.map((d) => `${d.change}:${d.file}`).join(', ') || 'no writes')];
    cells.push({ pass: 'finalize dryRun', framework: fw, reported: null, files: diff, checks, cell_status: classify(null, checks), notes: [] });
  }
  return cells;
}

/** Passes that claim `applied` without having examined anything: recorded `applied`
 *  with every count zero, or `guarded` — the pass returned an all-zero `applied` and
 *  only finalize's safety net recorded it `skipped`. Exported so the check itself is
 *  tested (it must be able to fail). */
export function zeroAppliedViolations(passes: Array<{ name: string; status: string; counts: Record<string, number>; guarded?: boolean }>): string[] {
  return passes
    .filter((p) => (p.status === 'applied' && Object.values(p.counts).every((v) => !v)) || (p.status === 'skipped' && p.guarded))
    .map((p) => (p.guarded ? `${p.name} (all-zero applied, skipped only by the safety net)` : p.name));
}

/** Full finalize twice (standalone, no agent): run 2 must change nothing, and the
 *  report must not claim `applied` for passes that are stubs. */
async function phaseFinalizeTwice(): Promise<Cell[]> {
  const { finalizeApp } = await import('../../src/relay-server/passes/finalize');
  const cells: Cell[] = [];
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'finalize2x');
    const s0 = await snapshot(root);
    const r1 = await finalizeApp(projectId, { projectRoot: root, skipBuildCheck: true });
    const s1 = await snapshot(root);
    const flow1 = flowReport(root);
    const audit1 = (() => { try { return JSON.parse(read(root, '.uix/interaction-audit-report.json')) as { findings: Array<{ file: string; line: number }> }; } catch { return null; } })();
    const r2 = await finalizeApp(projectId, { projectRoot: root, skipBuildCheck: true });
    const s2 = await snapshot(root);
    const flow2 = flowReport(root);
    const ignoreReports = /^\.uix\/(runs|screens)\/|^\.uix\/.*report\.json$/;
    const d1 = diffSnaps(s0, s1, ignoreReports);
    const d2 = diffSnaps(s1, s2, ignoreReports);
    const flowDelta: string[] = [];
    for (const f of flow1?.findings ?? []) {
      const g = flow2?.findings.find((x) => x.from === f.from && x.to === f.to);
      if (g && g.status !== f.status) flowDelta.push(`${f.from}→${f.to}: ${f.status} → ${g.status} (${g.detail.slice(0, 120)})`);
    }
    const zeroApplied = zeroAppliedViolations(r1.passes);
    // `applied` must be grounded in the pass's OUTPUT, not its counts (a padded count —
    // filesScanned=1 on src/resources/assets.ts — passes any count-based check): an
    // applied interaction audit must have found the dead 'Resolve' control planted in
    // the settings screen (B1 verify #3).
    const auditApplied = r1.passes.find((p) => p.name === 'auditInteractions')?.status === 'applied';
    // 7e renames the settings screen's file (screen_10_3.dart → settings_screen.dart,
    // app/10-3/ → app/settings/) BEFORE 7g runs, so the planted control is located in
    // whichever file carries the settings screen's canonical header after run 1 — the
    // same identity every pass resolves by — falling back to the fixture path.
    const settingsFile = (await appSources(root, fw)).find((f) => /^\/\/\s*canonicalId:\s*c_10_3\b/m.test(read(root, f))) ?? SCREEN[fw].settings;
    const plantedLine = read(root, settingsFile).split('\n').findIndex((l) => (fw === 'flutter' ? /onPressed:\s*\(\)\s*\{\}.*Resolve/ : /onClick=\{\(\) => \{\}\}.*Resolve/).test(l)) + 1;
    const auditHit = plantedLine > 0 && (audit1?.findings.some((f) => f.file === settingsFile && f.line === plantedLine) ?? false);
    const reasonless = r1.passes.filter((p) => p.status === 'skipped' && !p.reason?.trim()).map((p) => p.name);
    const skippedWithReason = r1.passes.filter((p) => p.status === 'skipped' && p.reason).map((p) => `${p.name}: ${p.reason}`);
    const checks = [
      chk('fz.idempotent-files', d2.length === 0, 'lie', 'finalize run 2 changes no source file', d2.map((d) => `${d.change}:${d.file}`).slice(0, 10).join(', ') || 'no changes'),
      chk('fz.idempotent-verdicts', flowDelta.length === 0, 'lie', 'finalize run 2 grades every flow edge the same as run 1', flowDelta.join(' | ') || 'identical'),
      chk('fz.no-zero-applied', zeroApplied.length === 0, 'lie', "no pass is recorded `applied` with all-zero counts, and no pass leaves it to finalize's safety net to turn its all-zero `applied` into a skip (a stub or a no-input run must say `skipped` + its own reason)", zeroApplied.join(', ') || 'none'),
      chk('fz.applied-grounded', !auditApplied || auditHit, 'lie', "an `applied` interaction audit's report contains the dead 'Resolve' control planted in the settings screen (applied means it read the screens)", auditApplied ? (auditHit ? `found at ${settingsFile}:${plantedLine}` : `applied, but .uix/interaction-audit-report.json has no finding at ${settingsFile}:${plantedLine} (${audit1?.findings.length ?? 'no'} finding(s))`) : 'auditInteractions not applied'),
      // In a FULL finalize 7b runs before 7d: the bound modal m_10_9 it converts/credits
      // must still grade `wired` (its trigger now calls the overlay presenter, not the
      // removed route) — the single-pass 7d cell never sees 7b's output.
      chk('fz.modal-after-7b', flow1?.findings.find((x) => x.from === 'c_10_2' && x.to === 'm_10_9')?.status === 'wired', 'lie', 'after 7b converts the bound modal, 7d still grades home→m_10_9 wired', (() => { const e = flow1?.findings.find((x) => x.from === 'c_10_2' && x.to === 'm_10_9'); return e ? `${e.status} — ${e.detail}` : 'no finding'; })()),
      chk('fz.skip-reasons', reasonless.length === 0, 'lie', 'every `skipped` pass carries its reason', reasonless.join(', ') || skippedWithReason.join(' | ') || 'no pass skipped'),
    ];
    const summary = (r: typeof r1) => r.passes.map((p) => `${p.name}:${p.status}`).join(', ');
    cells.push({
      pass: 'finalize (standalone ×2)', framework: fw,
      reported: { status: summary(r1), counts: {}, warnings: [`run2: ${summary(r2)}`] },
      files: d1.slice(0, 60), checks, cell_status: classify(null, checks), notes: [],
    });
  }
  return cells;
}

// ── readability (lane B78) ──────────────────────────────────────────────────

/** Where each framework keeps shared components (CONTRACTS §5). */
const COMPONENTS_DIR: Record<Fw, string> = { flutter: 'lib/components', react: 'src/components', next: 'components' };

/** 7h readability hygiene (F1 + F6): a skeleton stub component nothing imports is
 *  deleted, one something imports is kept; Figma/IR provenance leaves every comment
 *  while the behaviour text, the canonicalId header and string literals stay. */
async function phaseReadabilityHygiene(): Promise<Cell[]> {
  const { finalizeApp } = await import('../../src/relay-server/passes/finalize');
  const cells: Cell[] = [];
  const LEAK = /IR "Rectangle 24"|frame 61|Frame 83|m_313_9543|added by \/login|27×27/;
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'readability-hygiene');
    const s = SCREEN[fw];
    const dir = COMPONENTS_DIR[fw];
    const login = read(root, s.login);
    const header = login.split('\n')[0];
    const provenance = [
      '// Login form (IR "Rectangle 24", frame 61) — submits the credentials.',
      '// Frame 83 shows the biometric shortcut.',
      '// Loading sheet (modal m_313_9543) that resolves into the dashboard',
      '// (added by /login). Dots are 27×27 each.',
    ].join('\n');
    const literal = fw === 'flutter' ? `\nconst kProvenanceLiteral = 'frame 61 (IR "Rectangle 24")';\n` : `\nexport const PROVENANCE_LITERAL = 'frame 61 (IR "Rectangle 24")';\n`;
    const lines = login.split('\n');
    // after the header (and after 'use client' on next, which must stay first-statement)
    const at = lines.findIndex((l, i) => i > 0 && !/^\/\/|^'use client'/.test(l));
    lines.splice(at, 0, provenance);
    await fs.writeFile(path.join(root, s.login), lines.join('\n') + (fw === 'next' ? '' : literal));
    if (fw === 'next') await fs.appendFile(path.join(root, 'components/FilterSheet.tsx'), literal);
    const literalFile = fw === 'next' ? 'components/FilterSheet.tsx' : s.login;
    let unused: string; let used: string;
    if (fw === 'flutter') {
      unused = `${dir}/cmp_other_17.dart`; used = `${dir}/cmp_used_3.dart`;
      const stub = (c: string) => `// GENERATED SKELETON — shared component stub (write-locked API surface).\nimport 'package:flutter/material.dart';\n\nclass ${c} extends StatelessWidget {\n  const ${c}({super.key});\n  @override\n  Widget build(BuildContext context) => const SizedBox.shrink();\n}\n`;
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(path.join(root, unused), stub('OtherWidget'));
      await fs.writeFile(path.join(root, used), stub('UsedWidget'));
      const home = read(root, s.home);
      await fs.writeFile(path.join(root, s.home), home.replace(/^(import 'package:flutter\/material\.dart';)$/m, "$1\nimport '../components/cmp_used_3.dart';"));
    } else {
      unused = `${dir}/Other.tsx`; used = `${dir}/UsedStub.tsx`;
      const stub = (c: string) => `// GENERATED SKELETON — shared component stub (write-locked API surface).\nexport function ${c}() {\n  return null;\n}\n`;
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(path.join(root, unused), stub('Other'));
      await fs.writeFile(path.join(root, used), stub('UsedStub'));
      const homeRel = s.home;
      const spec = fw === 'react' ? '../../components/UsedStub' : '@/components/UsedStub';
      const home = read(root, homeRel);
      const lines2 = home.split('\n');
      const lastImport = lines2.reduce((acc, l, i) => (/^import\s/.test(l) ? i : acc), 0);
      lines2.splice(lastImport + 1, 0, `import { UsedStub } from '${spec}';`, 'void UsedStub;');
      await fs.writeFile(path.join(root, homeRel), lines2.join('\n'));
    }
    const before = await snapshot(root);
    const r1 = await finalizeApp(projectId, { projectRoot: root, onlyPasses: ['productionHygiene'], skipBuildCheck: true, noReport: true });
    const mid = await snapshot(root);
    const r2 = await finalizeApp(projectId, { projectRoot: root, onlyPasses: ['productionHygiene'], skipBuildCheck: true, noReport: true });
    const after = await snapshot(root);
    const files = diffSnaps(before, mid);
    const p = r1.passes.find((x) => x.name === 'productionHygiene');
    const leftLogin = read(root, s.login);
    const commentLeaks = (await appSources(root, fw)).flatMap((f) => read(root, f).split('\n').map((l, i) => ({ f, i, l })))
      .filter(({ l }) => /^\s*\/\//.test(l) && LEAK.test(l)).map(({ f, i, l }) => `${f}:${i + 1}: ${l.trim()}`);
    const syn = fw === 'flutter' ? [] : syntaxErrorsIn(root, files);
    const d2 = diffSnaps(mid, after);
    const checks = [
      chk('rh.stub-removed', !exists(root, unused), 'stub', `the stub component nothing imports (${unused}) is deleted`, exists(root, unused) ? 'still present' : 'deleted'),
      chk('rh.stub-kept', exists(root, used), 'lie', `a stub something still imports (${used}) is kept (deleting it would break the build)`, exists(root, used) ? 'kept' : 'DELETED'),
      chk('rh.leak-stripped', commentLeaks.length === 0, 'stub', 'no comment carries Figma/IR provenance (frame numbers, IR layer names, node/modal ids, "added by /route", design pixel sizes)', commentLeaks.join(' | ') || 'none'),
      chk('rh.behaviour-kept', /Login form/.test(leftLogin) && /submits the credentials/.test(leftLogin) && /Loading sheet/.test(leftLogin) && /resolves into the dashboard/.test(leftLogin), 'lie', 'the behavioural text of a stripped comment survives', leftLogin.split('\n').filter((l) => /Login form|Loading sheet|resolves into|Dots are/.test(l)).join(' | ') || 'behaviour text gone'),
      chk('rh.header', leftLogin.split('\n')[0] === header, 'lie', 'the `// canonicalId:` header line is untouched', leftLogin.split('\n')[0]),
      chk('rh.string-untouched', read(root, literalFile).includes(`'frame 61 (IR "Rectangle 24")'`), 'lie', 'a string literal that happens to contain provenance words is never edited (comments only)', read(root, literalFile).split('\n').find((l) => /frame 61/.test(l)) ?? 'literal gone'),
      chk('rh.counts', (p?.counts?.stubComponentsRemoved ?? -1) === 1 && (p?.counts?.commentsStripped ?? 0) >= 1, 'lie', 'the report counts exactly the one removed stub and the stripped comment(s)', JSON.stringify(p?.counts ?? {})),
      chk('rh.syntax', syn.length === 0, 'lie', 'every file the pass rewrote parses', syn.join(' | ') || 'ok'),
      chk('rh.idempotent', d2.length === 0, 'lie', 'a second run changes nothing', d2.map((d) => `${d.change}:${d.file}`).join(', ') || 'no changes'),
    ];
    cells.push({
      pass: 'readability hygiene: stub components + provenance comments (F1/F6)', framework: fw,
      reported: p ? { status: p.status, ...(p.reason ? { reason: p.reason } : {}), counts: p.counts, warnings: p.warnings } : null,
      files, checks, cell_status: classify(p ? { status: p.status, reason: p.reason, counts: p.counts, warnings: p.warnings } : null, checks),
      notes: [`run 2: ${r2.passes.find((x) => x.name === 'productionHygiene')?.status}`],
    });
  }
  return cells;
}

/** F9 + F7: finalize-report.json carries a before/after readability block and the
 *  warn-only screen gate, and a mutating pass that changed nothing on run 2 says
 *  `skipped: no-op` instead of `applied` (the Ping finalize: "5 applied", empty diff). */
async function phaseReadabilityReport(): Promise<Cell[]> {
  const { finalizeApp } = await import('../../src/relay-server/passes/finalize');
  const cells: Cell[] = [];
  const MUTATING = ['extractComponents', 'applyModalOverlays', 'repointAssetUsage', 'renameSemantic', 'deepenTokensAndCleanup', 'productionHygiene'];
  for (const fw of FRAMEWORKS) {
    const { projectId, root } = await copyFixture(fw, 'readability-report');
    const r1 = await finalizeApp(projectId, { projectRoot: root, skipBuildCheck: true });
    const s1 = await snapshot(root);
    const r2 = await finalizeApp(projectId, { projectRoot: root, skipBuildCheck: true });
    const s2 = await snapshot(root);
    const d2 = diffSnaps(s1, s2, /^\.uix\//);
    let persisted: { readability?: { before?: unknown; after?: unknown; gate?: { status?: string } } } | null = null;
    try { persisted = JSON.parse(read(root, '.uix/finalize-report.json')); } catch { /* none */ }
    const rd1 = r1.readability;
    const rd2 = r2.readability;
    const fakeApplied = r2.passes.filter((p) => MUTATING.includes(p.name) && p.status === 'applied');
    const noops = r2.passes.filter((p) => p.noop);
    const badNoop = noops.filter((p) => p.status !== 'skipped' || !/^no-op/.test(p.reason ?? ''));
    const checks = [
      chk('rr.measured', !!rd1?.before && !!rd1?.after && !rd1?.unmeasured, 'stub', 'finalize measures readability before and after the passes', rd1 ? (rd1.unmeasured ?? `before.loc=${rd1.before?.loc} after.loc=${rd1.after?.loc}`) : 'no readability block'),
      chk('rr.delta', !!rd1 && !rd1.unchanged && Object.keys(rd1.delta).length > 0, 'lie', 'run 1 changed the app, and the delta says what moved', rd1 ? JSON.stringify(rd1.delta) : 'n/a'),
      chk('rr.unchanged-visible', !!rd2 && rd2.unchanged === true && Object.keys(rd2.delta).length === 0, 'lie', 'run 2 changed nothing, and the report says readability is UNCHANGED', rd2 ? JSON.stringify({ unchanged: rd2.unchanged, delta: rd2.delta }) : 'n/a'),
      chk('rr.run2-no-files', d2.length === 0, 'lie', 'run 2 changes no source file', d2.map((d) => `${d.change}:${d.file}`).join(', ') || 'none'),
      chk('rr.no-op-honest', fakeApplied.length === 0, 'lie', 'no mutating pass is recorded `applied` on a run that changed nothing', fakeApplied.map((p) => `${p.name} ${JSON.stringify(p.counts)}`).join(' | ') || `none; no-op: ${noops.map((p) => p.name).join(', ')}`),
      chk('rr.no-op-reason', noops.length > 0 && badNoop.length === 0, 'lie', 'each no-op is `skipped` with a "no-op: … examined …" reason', noops.map((p) => `${p.name}: ${p.reason}`).join(' | ') || 'no no-op recorded'),
      chk('rr.gate', rd1?.gate?.status === 'ran', 'stub', 'the warn-only readability gate ran over the screens and is recorded', JSON.stringify(rd1?.gate ?? null).slice(0, 400)),
      chk('rr.persisted', !!persisted?.readability?.before && persisted?.readability?.gate?.status === 'ran', 'lie', '.uix/finalize-report.json carries the readability block', persisted?.readability ? 'present' : 'absent'),
    ];
    cells.push({
      pass: 'finalize readability delta + honest no-op (F7/F9)', framework: fw,
      reported: { status: r2.passes.map((p) => `${p.name}:${p.status}${p.noop ? '(no-op)' : ''}`).join(', '), counts: {}, warnings: [] },
      files: [], checks, cell_status: classify(null, checks), notes: [],
    });
  }
  return cells;
}

// ── toolchain probe (what the passes / gates would spawn) ──────────────────

function probeTools(): Record<string, string> {
  const which = (bin: string): string => {
    const r = spawnSync('bash', ['-lc', `command -v ${bin} || true`], { encoding: 'utf8' });
    return r.stdout.trim() || 'ABSENT';
  };
  let flutterRoot = '';
  try { flutterRoot = path.join(process.env.WORKSPACE || '/workspace', '.relay', 'tools', 'flutter', 'bin', 'flutter'); } catch { /* */ }
  return {
    'flutter (SDK path finalize/asset-phase use)': fsSync.existsSync(flutterRoot) ? flutterRoot : `ABSENT (${flutterRoot})`,
    'flutter (PATH — token-cleanup spawns bare `flutter`)': which('flutter'),
    dart: which('dart'),
    'tsc (global — `npx tsc` resolves this, else installs the bogus `tsc@2` package)': which('tsc'),
    npx: which('npx'),
    npm: which('npm'),
    eslint: which('eslint'),
    git: which('git'),
    node: process.version,
  };
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function runParity(opts: { log?: (m: string) => void; /** debug: run only the passes/phases whose name contains this */ only?: string } = {}): Promise<ParityResult> {
  const log = opts.log ?? (() => { /* quiet */ });
  await initWorkspace();
  const toolchain = probeTools();
  const cells: Cell[] = [];
  const flowRuns = new Map<Fw, PassRun>();

  // The Next fixture's resources module lives at lib/resources/assets.ts (CONTRACTS
  // §5); its src/ holds only the legacy re-export the asset pass leaves at the pre-B56
  // location. A second Next column without src/ proves nothing depends on src/ and
  // that src/ never hides app/ from the resolver.
  const NO_SRC = ' [next variant: app/ only, no src/]';
  const runs: Array<{ fw: Fw; suffix: string; mutate?: (root: string) => Promise<void> }> = [
    ...FRAMEWORKS.map((fw) => ({ fw, suffix: '' })),
    { fw: 'next' as Fw, suffix: NO_SRC, mutate: async (root: string) => { await fs.rm(path.join(root, 'src'), { recursive: true, force: true }); } },
  ];
  for (const { fw, suffix, mutate } of runs) {
    for (const passName of PASS_NAMES) {
      const pass = passName;
      if (opts.only && !pass.includes(opts.only)) continue;
      log(`[parity] ${fw}${suffix} × ${pass}`);
      let r: PassRun;
      try {
        r = await runOnePass(fw, pass, mutate);
      } catch (e) {
        cells.push({ pass: pass + suffix, framework: fw, reported: null, files: [], checks: [chk('run', false, 'error', 'pass ran', String((e as Error).stack ?? e))], cell_status: 'ERROR', notes: [] });
        continue;
      }
      if (pass === 'verifyFlowWiring' && !suffix) flowRuns.set(fw, r);
      let checks: Check[];
      try { checks = await CHECKS[pass](fw, r); } catch (e) { checks = [chk('checks', false, 'error', 'checks ran', String((e as Error).stack ?? e))]; }
      const notes: string[] = [];
      const counts = r.reported?.counts ?? {};
      if (r.reported?.status === 'applied' && Object.values(counts).every((v) => !v) && r.files.filter((f) => !f.file.startsWith('.uix/')).length === 0) {
        notes.push('recorded `applied` with all-zero counts and no source change');
      }
      cells.push({ pass: pass + suffix, framework: fw, reported: r.reported, files: r.files, checks, cell_status: classify(r.reported, checks), notes });
    }
  }

  const phases: Array<[string, () => Promise<Cell[]>]> = [
    ['detectFramework', phaseDetectFramework],
    ['resolver', phaseResolver],
    ['restamp', phaseHeaderRestamp],
    ['design-system', phaseDesignSystem],
    ['skeleton/restart', phaseSkeletonAndRestart],
    ['asset-phase', phaseAssetPhase],
    ['resolve-canonical', phaseResolveCanonical],
    ['flow-requeue', () => phaseFlowRequeue(flowRuns)],
    ['analyze-gate', phaseAnalyzeGate],
    ['verify-serving', phaseVerifyServing],
    ['web-asset-serving', phaseWebAssetServing],
    ['standalone-finalize', phaseStandaloneFinalize],
    ['finalize×2', phaseFinalizeTwice],
    ['finalize-dryrun', phaseFinalizeDryRun],
    ['readability-hygiene', phaseReadabilityHygiene],
    ['readability-report', phaseReadabilityReport],
  ];
  for (const [name, fn] of phases) {
    if (opts.only && !name.includes(opts.only)) continue;
    log(`[parity] phase ${name}`);
    try { cells.push(...await fn()); } catch (e) {
      cells.push({ pass: name, framework: 'flutter', reported: null, files: [], checks: [chk('run', false, 'error', `${name} ran`, String((e as Error).stack ?? e))], cell_status: 'ERROR', notes: ['phase harness threw'] });
    }
  }

  return { generatedAt: new Date().toISOString(), workspace: WS, toolchain, cells };
}

/** Render the pass × framework matrix as plain text. */
export function renderMatrix(res: ParityResult): string {
  const rows = new Map<string, Partial<Record<Fw, Cell>>>();
  for (const c of res.cells) {
    const row = rows.get(c.pass) ?? {};
    row[c.framework] = c;
    rows.set(c.pass, row);
  }
  const cellTxt = (c?: Cell) => c ? `${c.cell_status} ${c.checks.filter((k) => k.ok).length}/${c.checks.length}` : '—';
  const w = Math.max(...[...rows.keys()].map((k) => k.length), 10);
  const lines = [`${'pass / phase'.padEnd(w)} | ${FRAMEWORKS.map((f) => f.padEnd(18)).join(' | ')}`, '-'.repeat(w + 66)];
  for (const [k, row] of rows) lines.push(`${k.padEnd(w)} | ${FRAMEWORKS.map((f) => cellTxt(row[f]).padEnd(18)).join(' | ')}`);
  return lines.join('\n');
}
