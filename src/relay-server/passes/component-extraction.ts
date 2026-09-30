// =============================================================================
// File: src/relay-server/passes/component-extraction.ts
//
// Phase 7a — Component extraction (production-readiness pass).
//
// A pass that DE-DUPLICATES widgets in an ALREADY-BUILT app. The per-screen
// build phase happily re-implements the same widget under different private
// names on every screen (Ping ships `_PinField`×3, `_StrengthMeter`×3,
// `_PingLogo`×3, `_SectionHeading`×3, `_PillButton`×2…). This pass detects those
// groups STRUCTURALLY (NOT by name — `_PinField` and `_PasscodeInput` with the
// same subtree are ONE component), lifts a single shared widget into the
// framework's components dir, parameterizes the parts that differ across
// occurrences, rewrites every screen to import+use it, and deletes the dead
// private copies. It is a refactor: behaviour and visuals are preserved exactly.
//
// FRAMEWORK-AGNOSTIC. The orchestrator detects the project framework and
// dispatches to a per-framework `ExtractorStrategy` (flutter → Dart widget
// classes in lib/components/<Name>.dart; react → src/components/<Name>.tsx).
// Today only the flutter strategy ships a full implementation; the react seam is
// stubbed so the contract is visible.
//
// Detection is DETERMINISTIC for the obvious case (identical normalized
// structural signature) and uses an AI confirmation pass (runModel) only to
// adjudicate NEAR-matches (same shape, differing literals) before merging —
// guarding against merging two genuinely-different widgets.
//
// The naming guide is `.uix/canonical.json` (the canonicalize() output): when a
// detected group maps onto a canonical component, its `canonicalName` is used;
// otherwise a sensible semantic name is derived from the group's private names.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as fsSync from 'fs';
import type { AIModel } from '../ai-adapters';
import { collectWebWidgets, extractWebGroup, webComponentsDir, webScreenFiles } from './component-extraction-web';
import { detectFramework, type Framework } from './framework';
import { loadWebApp } from './web-app';
import { componentClassName } from '../component-contract';

// ── Public contract ──────────────────────────────────────────────────────────

/** One shared detector (./framework) — never a local copy that can drift. */
export { detectFramework };
export type { Framework };

export interface ExtractOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used to confirm semantic equivalence of near-matches. */
  model?: AIModel;
  /** Skip the AI confirmation step (deterministic-only). Default false. */
  noAiConfirm?: boolean;
  /** Only report what WOULD change; do not write. Default false. */
  dryRun?: boolean;
  /** Minimum occurrences for a group to be extracted. Default 2. */
  minOccurrences?: number;
  /** Optional injected model runner (defaults to relay's runModel). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Restrict to these screen file basenames (testing). */
  onlyFiles?: string[];
  /**
   * PER-GROUP build safety (T32). When provided, EACH extracted group is verified
   * independently: snapshot → write the group → buildOk() → keep if clean, else
   * restore JUST that group and record it rejected. This makes one code-gen-unsafe
   * merge skip in isolation instead of forcing the orchestrator to revert ALL
   * groups (the all-or-nothing 6→15 regression). Omitted (or in dryRun) → groups
   * apply without an inner build gate (legacy behaviour; the orchestrator's outer
   * gate still protects the whole pass).
   */
  perGroupGuard?: ExtractGroupGuard;
}

/**
 * Inner build-safety hooks for per-group extraction (T32). The pass owns the
 * extract/rollback LOOP; the orchestrator owns the snapshot/restore/build
 * mechanism (git + `flutter analyze`/`build web`) and injects it here so the pass
 * stays decoupled from version control. `snapshot()` returns an opaque token (a
 * git sha) for the current clean tree; `restore(token)` resets the tree to it
 * (un-writing the group just applied); `buildOk()` reports whether the tree still
 * builds at or below the running error budget.
 */
export interface ExtractGroupGuard {
  /** Capture the current (clean) tree; returns an opaque restore token. */
  snapshot: () => Promise<string>;
  /** Restore the tree to a previously-captured token (drops the last group). */
  restore: (token: string) => Promise<void>;
  /** True when the tree still builds within budget after the group was written. */
  buildOk: () => Promise<{ ok: boolean; reason?: string }>;
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface ExtractedComponent {
  /** Final shared component name (PascalCase / public). */
  name: string;
  kind: string;
  /** The private class names that were collapsed into this component. */
  fromPrivateNames: string[];
  /** Source files each occurrence came from. */
  usedIn: string[];
  /** Path of the new shared component file (relative to project root). */
  componentPath: string;
  /** Parameters introduced to absorb per-occurrence differences. */
  parameterizedFields: string[];
  occurrences: number;
}

export interface ExtractResult {
  framework: Framework;
  extracted: ExtractedComponent[];
  /** Groups that were detected but rejected (e.g. AI said not-equivalent). */
  rejected: Array<{ names: string[]; reason: string }>;
  componentsDir: string;
  dryRun: boolean;
  /** Local component/widget declarations collected and compared. 0 = examined nothing. */
  scanned: number;
  /** Set when the pass had no input / no support — finalize records `skipped` with it. */
  skippedReason?: string;
}

// ── Per-framework strategy seam ──────────────────────────────────────────────

export interface WidgetUnit {
  /** Private/local name as written in source. */
  localName: string;
  /** Absolute source file. */
  file: string;
  /** The full class/source text of the widget. */
  source: string;
  /** Normalized structural signature (identifiers/strings/literals stripped). */
  signature: string;
  /** Flutter StatefulWidget: the paired State class (its source is in `source`). */
  stateName?: string;
}

export interface ExtractorStrategy {
  framework: Framework;
  componentsDirName: string;
  /** Collect all candidate widget units across the project's screen files. */
  collectWidgets(projectRoot: string, onlyFiles?: string[]): Promise<WidgetUnit[]>;
  /**
   * Extract one shared component for a group of structurally-equivalent units.
   * Writes the component file, rewrites every occurrence, removes dead copies.
   * Returns the resulting ExtractedComponent, or null if it bailed safely.
   */
  extractGroup(
    projectRoot: string,
    group: WidgetUnit[],
    chosenName: string,
    kind: string,
    dryRun: boolean,
  ): Promise<ExtractedComponent | null | { bail: string }>;
  /** Absolute components dir when it depends on the app layout (web: the resolver's). */
  componentsDirFor?(projectRoot: string): Promise<string>;
}

// ── Canonical naming guide ───────────────────────────────────────────────────

interface CanonicalComponent { canonicalName: string; kind: string; usedIn?: string[]; count?: number }

/** Readability F2: `.uix/canonical.json` comes in TWO shapes — the canonicalize-ai
 *  reduce shape `{canonicalName, kind}` and the persisted build shape
 *  `{id, frameId, name}` (canonicalize.ts / to-canonical.ts). Reading only the first
 *  made every name '' on real runs, and `lower.includes('')` matched every group
 *  onto the first component (the Ping crash, then the silent mis-naming). Both are
 *  normalised here; an entry with no usable name is dropped. */
export function normalizeCanonicalComponents(raw: unknown): CanonicalComponent[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { components?: unknown }).components)
    ? (raw as { components: unknown[] }).components : [];
  const out: CanonicalComponent[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const name = [o.canonicalName, o.name].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    if (!name || !/[A-Za-z]{3,}/.test(name)) continue;
    out.push({ canonicalName: name.trim(), kind: typeof o.kind === 'string' ? o.kind : '' });
  }
  return out;
}

async function readCanonicalComponents(projectRoot: string): Promise<CanonicalComponent[]> {
  try {
    return normalizeCanonicalComponents(JSON.parse(await fs.readFile(path.join(projectRoot, '.uix', 'canonical.json'), 'utf8')));
  } catch {
    return [];
  }
}

/** Why a strategy collected nothing — worded from what is on disk, so a layout the
 *  strategy cannot read is never reported as an app with nothing to extract (B1
 *  verify #2: a Next app with locally-declared components under app/ was reported
 *  "no local component declarations found"). */
async function emptyCollectionReason(projectRoot: string, framework: string): Promise<string> {
  if (framework === 'react' || framework === 'next') {
    const files = await webScreenFiles(projectRoot);
    if (!files.length) return 'the resolver indexed no built screen file (no header-stamped screen, route table entry or page) — nothing was read';
    return `no JSX component declarations found in the ${files.length} screen file(s) the resolver indexed — nothing to compare`;
  }
  return `no local widget declarations found to compare (the ${framework} strategy collected 0 candidates)`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function extractComponents(projectId: string, opts: ExtractOptions): Promise<ExtractResult> {
  const { projectRoot } = opts;
  const minOcc = opts.minOccurrences ?? 2;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  if (!strategy) {
    return {
      framework, extracted: [], rejected: [], componentsDir: '', dryRun: !!opts.dryRun,
      scanned: 0, skippedReason: `no component-extraction strategy for framework '${framework}'`,
    };
  }

  const units = await strategy.collectWidgets(projectRoot, opts.onlyFiles);
  if (units.length === 0) {
    return {
      framework, extracted: [], rejected: [], componentsDir: path.join(projectRoot, strategy.componentsDirName),
      dryRun: !!opts.dryRun, scanned: 0,
      skippedReason: await emptyCollectionReason(projectRoot, framework),
    };
  }

  const canonical = await readCanonicalComponents(projectRoot);
  const extracted: ExtractedComponent[] = [];
  const rejected: ExtractResult['rejected'] = [];
  const componentsDir = strategy.componentsDirFor ? await strategy.componentsDirFor(projectRoot) : path.join(projectRoot, strategy.componentsDirName);
  // F2: every target is UNIQUE — two groups used to both write
  // lib/components/back_button.dart (the second overwrote the first, whose screens
  // then imported the other group's body). Names taken this run + names already
  // defined by a public class/component in the project are never reused.
  const definedAt = await existingPublicNames(projectRoot, framework);
  const takenThisRun = new Set<string>();
  /** A name is free unless this run used it or the project defines it OUTSIDE the
   *  group's own units (an exported duplicate being lifted is its own definition). */
  const nameFree = (n: string, group: WidgetUnit[]): boolean => {
    if (takenThisRun.has(n)) return false;
    const files = definedAt.get(n);
    if (!files) return true;
    return [...files].every((f) => group.some((u) => path.resolve(u.file) === path.resolve(f) && u.localName.replace(/^_+/, '') === n));
  };
  const attempted = new Set<string>();
  const groupKey = (g: WidgetUnit[]): string => g.map((u) => `${u.file}::${u.localName}::${u.source.length}:${hashText(u.source)}`).sort().join('|');
  let scanned = units.length;

  /** One group: name it, extract it (build-guarded on a real run), record the outcome. */
  const processGroup = async (group: WidgetUnit[]): Promise<boolean> => {
    // AI confirmation for near-matches: signatures match structurally, but the
    // SOURCE differs (different literals/styles). If sources are byte-identical
    // (modulo whitespace) we trust the deterministic match. Otherwise confirm.
    const needsConfirm = !sourcesTriviallyEqual(group) && !opts.noAiConfirm && opts.model && opts.runModel;
    if (needsConfirm) {
      const ok = await confirmEquivalent(group, opts);
      if (!ok.equivalent) {
        rejected.push({ names: group.map((g) => g.localName), reason: ok.reason || 'AI: not semantically equivalent' });
        return false;
      }
    }
    const kind = inferKind(group, canonical);
    const chosen = candidateNames(group, canonical, framework).find((n) => nameFree(n, group));
    if (!chosen) {
      rejected.push({ names: group.map((g) => g.localName), reason: `every candidate name (${candidateNames(group, canonical, framework).join(', ')}) is already a component/class in the project — not merged under a colliding name` });
      return false;
    }

    // PER-GROUP BUILD SAFETY (T32). With a guard injected (real run), snapshot the
    // clean tree, write THIS group, build-check it, and revert only this group if it
    // regressed — so a single code-gen-unsafe merge is skipped while the safe groups
    // still apply (no more all-or-nothing full revert). Without a guard (dryRun /
    // standalone), fall back to the plain extract.
    const guard = !opts.dryRun ? opts.perGroupGuard : undefined;
    if (guard) {
      let token: string;
      try {
        token = await guard.snapshot();
      } catch {
        rejected.push({ names: group.map((g) => g.localName), reason: 'per-group snapshot unavailable — skipped (no rollback point)' });
        return false;
      }
      const result = await strategy.extractGroup(projectRoot, group, chosen, kind, false);
      if (!result || 'bail' in result) {
        await guard.restore(token).catch(() => { /* best-effort */ });
        rejected.push({ names: group.map((g) => g.localName), reason: result && 'bail' in result ? result.bail : 'strategy bailed (unsafe to merge)' });
        return false;
      }
      const built = await guard.buildOk();
      if (built.ok) { extracted.push(result); takenThisRun.add(result.name); return true; }
      await guard.restore(token).catch(() => { /* best-effort */ });
      rejected.push({ names: group.map((g) => g.localName), reason: `extraction regressed the build (${built.reason ?? 'build check failed'}) — group reverted, others kept` });
      return false;
    }
    const result = await strategy.extractGroup(projectRoot, group, chosen, kind, !!opts.dryRun);
    if (result && !('bail' in result)) { extracted.push(result); takenThisRun.add(result.name); return true; }
    rejected.push({ names: group.map((g) => g.localName), reason: result && 'bail' in result ? result.bail : 'strategy bailed (unsafe to merge)' });
    return false;
  };

  // F2: on a real run the units are RE-COLLECTED after every extraction, so a group
  // whose body used a private sibling that has just been lifted (`_PasscodeDots`
  // → `_Dot`, now the shared `Dot`) is compared again on the rewritten source
  // instead of bailing forever on a stale copy. A dry run writes nothing, so one
  // pass over the collected units is the whole answer.
  let current = units;
  for (let round = 0; round < 64; round++) {
    const groups = groupUnits(current, minOcc).filter((g) => !attempted.has(groupKey(g)));
    if (!groups.length) break;
    let changed = false;
    for (const group of groups) {
      attempted.add(groupKey(group));
      const ok = await processGroup(group);
      if (ok && !opts.dryRun) { changed = true; break; }   // sources changed → re-collect
    }
    if (!changed || opts.dryRun) break;
    current = await strategy.collectWidgets(projectRoot, opts.onlyFiles);
    scanned = Math.max(scanned, current.length);
  }
  // A group that was retried after a re-collect and then succeeded is not "rejected".
  const extractedNames = new Set(extracted.flatMap((e) => e.fromPrivateNames.map((n) => `${n}`)));
  const finalRejected = rejected.filter((r, i) => !(r.reason.startsWith('references a private') && r.names.every((n) => extractedNames.has(n))) && rejected.findIndex((x) => x.reason === r.reason && x.names.join() === r.names.join()) === i);

  return {
    framework,
    extracted,
    rejected: finalRejected,
    componentsDir,
    dryRun: !!opts.dryRun,
    scanned,
  };
}

/** Group units by exact normalized structural signature (cross-file, name-agnostic);
 *  a group needs ≥ minOcc members in ≥ minOcc distinct files. */
function groupUnits(units: WidgetUnit[], minOcc: number): WidgetUnit[][] {
  const bySig = new Map<string, WidgetUnit[]>();
  for (const u of units) {
    const arr = bySig.get(u.signature) ?? [];
    arr.push(u);
    bySig.set(u.signature, arr);
  }
  return [...bySig.values()].filter((g) => g.length >= minOcc && new Set(g.map((u) => u.file)).size >= minOcc);
}

function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Public class / component names already defined in the project (never reused as
 *  an extraction target). Flutter: every public top-level class under lib/; web:
 *  every exported PascalCase function/const in the source tree. */
async function existingPublicNames(projectRoot: string, framework: string): Promise<Map<string, Set<string>>> {
  const web = framework === 'react' || framework === 'next';
  const roots = web ? ['src', 'app', 'components', 'lib'] : ['lib'];
  const names = new Map<string, Set<string>>();
  const walk = async (dir: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.next|_preview|%5Fpreview|\.dart_tool|build)$/.test(e.name)) await walk(abs); continue; }
      if (!(web ? /\.(tsx?|jsx?)$/ : /\.dart$/).test(e.name)) continue;
      let src = '';
      try { src = await fs.readFile(abs, 'utf8'); } catch { continue; }
      const re = web ? /^export\s+(?:default\s+)?(?:function|const|class)\s+([A-Z]\w*)/gm : /^(?:abstract\s+)?class\s+([A-Z]\w*)/gm;
      for (const m of src.matchAll(re)) names.set(m[1], (names.get(m[1]) ?? new Set()).add(abs));
    }
  };
  for (const r of roots) await walk(path.join(projectRoot, r));
  return names;
}

function getStrategy(fw: Framework): ExtractorStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react' || fw === 'next') return webStrategy(fw);
  return null;
}

// ── Naming ───────────────────────────────────────────────────────────────────

/** Pick the shared component name: prefer a canonical mapping, else derive from
 *  the most common private name (stripped of the leading underscore). */
/** Name affinity between a group's local name and a canonical component name.
 *  Never on an empty / too-short name (an empty string is contained in every name). */
function canonicalAffinity(local: string, canonicalName: string): boolean {
  const a = local.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a.length < 3 || b.length < 3) return false;
  // The canonical name wins only when it is at least as specific as the local one
  // (`_PinField` → canonical `pinField`); a generic canonical (`card`, `icon`,
  // `button`) never overrides a specific local name (`_TxnCard`, `_LinkBankButton`).
  return a === b || b.includes(a);
}

/** Candidate public names for a group, best first: the canonical mapping, then the
 *  group's own local names by frequency. Each is made SDK-safe (a name that would
 *  shadow a framework widget — Flutter's BackButton, React's Fragment — gets the
 *  `App` prefix, the same rule the component contract uses). */
export function candidateNames(group: Array<Pick<WidgetUnit, 'localName'>>, canonical: CanonicalComponent[], framework: string): string[] {
  const locals = group.map((g) => (g.localName ?? '').replace(/^_+/, '')).filter(Boolean);
  const counts = new Map<string, number>();
  for (const l of locals) counts.set(l, (counts.get(l) ?? 0) + 1);
  const byFreq = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const out: string[] = [];
  const base = byFreq[0] ?? 'Component';
  const hit = canonical.find((c) => canonicalAffinity(base, c.canonicalName));
  if (hit) out.push(hit.canonicalName);
  out.push(...byFreq);
  const names = out.map((n) => componentClassName(pascal(n) || 'Component', framework)).filter(Boolean);
  return [...new Set(names)];
}

function inferKind(group: WidgetUnit[], canonical: CanonicalComponent[]): string {
  const base = mostCommon(group.map((g) => (g.localName ?? '').replace(/^_+/, ''))).toLowerCase();
  const hit = canonical.find((c) => canonicalAffinity(base, c.canonicalName));
  if (hit?.kind) return hit.kind;
  if (/button|pill|cta/.test(base)) return 'button';
  if (/field|input|otp|pin/.test(base)) return 'input';
  if (/logo|badge|icon/.test(base)) return 'brand';
  if (/heading|title|label/.test(base)) return 'text';
  return 'widget';
}

function mostCommon(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const a of arr) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? arr[0] ?? 'Component';
}

function pascal(s: string): string {
  return (s ?? '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

// ── Structural signature helpers (shared) ────────────────────────────────────

/** True when all sources are equal once whitespace/comments are collapsed. */
function sourcesTriviallyEqual(group: WidgetUnit[]): boolean {
  const norm = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const first = norm(group[0].source);
  return group.every((g) => norm(g.source) === first);
}

// ── AI confirmation of near-matches ──────────────────────────────────────────

async function confirmEquivalent(
  group: WidgetUnit[],
  opts: ExtractOptions,
): Promise<{ equivalent: boolean; reason?: string }> {
  if (!opts.model || !opts.runModel) return { equivalent: true };
  const blocks = group
    .map((g, i) => `--- Widget ${i + 1} (${g.localName} in ${path.basename(g.file)}) ---\n${g.source}`)
    .join('\n\n');
  const prompt = [
    'You are reviewing UI widgets to decide if they are the SAME reusable component',
    'rendered with different data/style values (i.e. they should be merged into one',
    'parameterized widget), or GENUINELY DIFFERENT widgets that must stay separate.',
    '',
    'They are the SAME component if they share layout/structure and differ only in',
    'data (labels, asset paths) or simple style values (colors, font, weight) that',
    'can be passed as parameters. They are DIFFERENT if one has structurally extra',
    'parts (a border, shadow, an extra child, different layout) the others lack.',
    '',
    blocks,
    '',
    'Reply with EXACTLY one JSON object, no prose:',
    '{"equivalent": true|false, "reason": "<short>"}',
  ].join('\n');
  // AI here is a CONFIRMATION GATE over a deterministic candidate (the pass's
  // primary work is structural dedup). It is NOT an AI-PURPOSE step, so an AI
  // failure does NOT throw — it falls back to the conservative SAFE no-op (do
  // not merge). But per RFC §0.1 the failure must NOT be silent: it is LOGGED
  // and recorded in the rejection `reason` (surfaced in the finalize report).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      // eslint-disable-next-line no-console
      console.log('[ai:extract-confirm] status=empty — AI returned no JSON; conservative no-merge');
      return { equivalent: false, reason: 'AI returned no JSON' };
    }
    const parsed = JSON.parse(m[0]) as { equivalent?: boolean; reason?: string };
    return { equivalent: !!parsed.equivalent, reason: parsed.reason };
  } catch (e) {
    // On AI failure, be conservative: do NOT merge ambiguous near-matches.
    // eslint-disable-next-line no-console
    console.log(`[ai:extract-confirm] status=error — ${(e as Error).message.slice(0, 80)}; conservative no-merge`);
    return { equivalent: false, reason: `AI confirm failed: ${(e as Error).message}` };
  }
}

// =============================================================================
// Flutter strategy
// =============================================================================

const flutterStrategy: ExtractorStrategy = {
  framework: 'flutter',
  componentsDirName: path.join('lib', 'components'),

  async collectWidgets(projectRoot, onlyFiles) {
    const screensDir = path.join(projectRoot, 'lib', 'screens');
    let files: string[];
    try {
      files = (await fs.readdir(screensDir)).filter((f) => f.endsWith('.dart'));
    } catch {
      return [];
    }
    if (onlyFiles?.length) files = files.filter((f) => onlyFiles.includes(f));
    const units: WidgetUnit[] = [];
    for (const f of files) {
      const abs = path.join(screensDir, f);
      const src = await fs.readFile(abs, 'utf8');
      // Inline file-local top-level consts (e.g. `const Color _fieldBg = …;`) into
      // each widget's source BEFORE signature/diffing. Two screens may reuse the
      // SAME private const NAME for DIFFERENT values (_fieldBg = #f5f5f5 vs
      // #efefef); without inlining the diff would miss it and the merged widget
      // would hardcode one screen's color → a silent visual regression. Inlining
      // also means the lifted component never dangles on a screen-local const.
      const consts = collectFileConsts(src);
      for (const cls of parseDartWidgetClasses(src)) {
        // F2: only PRIVATE widgets are per-screen copies. A public class in a screen
        // file is the screen itself (Ping: ReturningUserPasswordScreen +
        // WelcomeBackLoginScreen were lifted as a "component").
        if (!cls.name.startsWith('_')) continue;
        cls.source = inlineConsts(cls.source, consts);
        cls.buildBody = inlineConsts(cls.buildBody, consts);
        // Only StatelessWidgets carry their own build() body. StatefulWidgets
        // keep build() in a separate State class (out of scope for 7a) and would
        // yield an EMPTY body → spurious collisions. Skip empty signatures.
        const sig = dartStructuralSignature(cls.buildBody);
        if (!cls.buildBody.trim() || !sig.trim()) continue;
        units.push({ localName: cls.name, file: abs, source: cls.source, signature: cls.stateName ? `STATEFUL ${sig}` : sig, ...(cls.stateName ? { stateName: cls.stateName } : {}) });
      }
    }
    return units;
  },

  async extractGroup(projectRoot, group, chosenName, kind, dryRun) {
    return extractFlutterGroup(projectRoot, group, chosenName, kind, dryRun);
  },
};

interface DartClass { name: string; source: string; buildBody: string; /** StatefulWidget: its State class name. */ stateName?: string; }

/** Map of top-level `const TYPE _name = <literal>;` in a file. */
function collectFileConsts(src: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /^const\s+[A-Za-z0-9_<>?]+\s+(_[A-Za-z0-9_]+)\s*=\s*([^;]+);/gm;
  let g: RegExpExecArray | null;
  while ((g = re.exec(src)) !== null) m.set(g[1], g[2].trim());
  return m;
}

/** Replace whole-word references to file-local consts with their literal values
 *  (skipping the const declaration line itself, which is excluded by callers). */
function inlineConsts(text: string, consts: Map<string, string>): string {
  let out = text;
  for (const [name, value] of consts) {
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), value);
  }
  return out;
}

/** Parse top-level StatelessWidget/StatefulWidget classes with a build() method,
 *  using brace matching. Returns the full class source + its build() body. */
export function parseDartWidgetClasses(src: string): DartClass[] {
  const out: DartClass[] = [];
  // Phase 7a targets StatelessWidgets (their build() body lives in the class).
  // StatefulWidgets keep build() in a separate State class — out of scope.
  const classRe = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+(StatelessWidget|StatefulWidget)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(src)) !== null) {
    const name = m[1];
    const braceStart = src.indexOf('{', m.index);
    if (braceStart < 0) continue;
    const end = matchBrace(src, braceStart);
    if (end < 0) continue;
    const source = src.slice(m.index, end + 1);
    if (m[2] === 'StatelessWidget') {
      out.push({ name, source, buildBody: extractBuildBody(source) });
      continue;
    }
    // F2 StatefulWidget path: the build() lives in the `State<Name>` class. The unit
    // is the PAIR (widget + state), fingerprinted by the state's build body. Only a
    // pair that is identical across screens (modulo its own names) is lifted.
    const stRe = new RegExp(`^class\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+extends\\s+State<${escapeRe(name)}>`, 'm');
    const sm = stRe.exec(src);
    if (!sm) continue;
    const sOpen = src.indexOf('{', sm.index);
    const sEnd = sOpen >= 0 ? matchBrace(src, sOpen) : -1;
    if (sEnd < 0) continue;
    const stateSource = src.slice(sm.index, sEnd + 1);
    out.push({ name, source: `${source}\n\n${stateSource}`, buildBody: extractBuildBody(stateSource), stateName: sm[1] });
  }
  return out;
}

/** Index of the matching close brace for the open brace at `open`. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Pull the body of the `Widget build(...) { ... }` method. */
function extractBuildBody(classSource: string): string {
  const bm = /Widget\s+build\s*\([^)]*\)\s*\{/.exec(classSource);
  if (!bm) return '';
  const open = classSource.indexOf('{', bm.index + bm[0].length - 1);
  const end = matchBrace(classSource, open);
  if (end < 0) return '';
  return classSource.slice(open + 1, end);
}

/** Structural signature: a FAITHFUL fingerprint of the widget tree. It keeps the
 *  full token structure — every Capitalized constructor/type, all punctuation,
 *  and crucially the NAMED-ARGUMENT KEYS (`foo:`) — so layout and the set of
 *  configured properties are load-bearing. Only LEAF VALUES are normalized:
 *  string/number literals collapse, and a value-position lowercase identifier
 *  (theme getter, color getter, param, local const) collapses to `v`. So two
 *  widgets that share the SAME tree and SAME property keys but differ only in
 *  data/style values (grotesk vs montserrat, ink vs ink3, _fieldBg literal)
 *  match; anything with a different shape, extra child, extra property, or
 *  different layout does NOT. This deliberately errs toward NOT merging. */
export function dartStructuralSignature(buildBody: string): string {
  const toks = tokenizeDart(buildBody);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'str') { out.push('S'); continue; }
    if (t.kind === 'num') { out.push('N'); continue; }
    if (t.kind === 'punct') { out.push(t.text); continue; }
    // identifier
    if (/^[A-Z]/.test(t.text)) { out.push(t.text); continue; } // Capitalized → structural
    // lowercase identifier: KEY (followed by ':') is structural; otherwise value.
    const next = toks[i + 1];
    if (next && next.kind === 'punct' && next.text === ':') { out.push(`${t.text}:`); i++; continue; }
    out.push('v');
  }
  return out.join(' ');
}

// ── Flutter group extraction (write component, rewrite call sites) ────────────

interface DartCtorParam { name: string; type: string; required: boolean; positional: boolean; defaultValue?: string; }

async function extractFlutterGroup(
  projectRoot: string,
  group: WidgetUnit[],
  chosenName: string,
  kind: string,
  dryRun: boolean,
): Promise<ExtractedComponent | { bail: string }> {
  // Build the shared component from the FIRST occurrence's source, made public:
  //  - rename class _Foo → ChosenName
  //  - add `super.key`
  //  - resolve any file-local `const _x` referenced in its build body into
  //    parameters (so per-screen color/style constants become props), unless
  //    every occurrence uses the identical literal value.
  const usedIn = group.map((g) => relPath(projectRoot, g.file));
  const fromPrivateNames = [...new Set(group.map((g) => g.localName))];
  const componentPath = path.join('lib', 'components', `${snake(chosenName)}.dart`);
  const absComponent = path.join(projectRoot, componentPath);
  // F2: never overwrite an existing file (an agent-built component or an earlier
  // group's output) — a second writer silently re-bodied the first group's screens.
  if (fsSync.existsSync(absComponent)) return { bail: `${componentPath} already exists — never overwritten (choose another name or merge by hand)` };

  if (group.some((g) => g.stateName)) return extractFlutterStatefulGroup(projectRoot, group, chosenName, kind, dryRun, componentPath);

  // Identify per-occurrence differing tokens to parameterize. We diff the
  // bodies token-wise; positions that differ across occurrences and are
  // data/style values (strings, colors, theme getters, file-local consts)
  // become parameters.
  const plan = planParameterization(projectRoot, group);
  if ('bail' in plan) return plan; // structures didn't actually align — bail safe, with the reason.

  // Resolve imports the lifted body needs for any PUBLIC symbol it references that
  // is NOT core flutter — sibling components (Disc), shared widgets (PingButton),
  // theme, etc. Without these the lifted file references undefined symbols (the
  // `Disc` undefined_method + invalid_constant regression). We index every class
  // DEFINED under lib/ and emit the relative import for each referenced one.
  const symbolIndex = await buildSymbolIndex(projectRoot);
  const componentSource = plan.componentSource(chosenName, (body) =>
    resolveBodyImports(body, absComponent, projectRoot, symbolIndex),
  );

  if (!dryRun) {
    await fs.mkdir(path.dirname(absComponent), { recursive: true });
    await fs.writeFile(absComponent, componentSource, 'utf8');
    // Rewrite each occurrence: remove the private class, rewrite call sites,
    // ensure the import, and remove now-dead file-local consts that were lifted.
    for (const g of group) {
      await rewriteOccurrenceFile(projectRoot, g, chosenName, componentPath, plan, symbolIndex);
    }
  }

  return {
    name: chosenName,
    kind,
    fromPrivateNames,
    usedIn,
    componentPath,
    parameterizedFields: plan.params.map((p) => p.name),
    occurrences: group.length,
  };
}

/** F2 StatefulWidget path: lift an IDENTICAL widget + State pair (modulo its own
 *  names). No parameterisation — state logic that differs per screen is not a
 *  shared component, and a structural diff inside a State is never merged. */
async function extractFlutterStatefulGroup(
  projectRoot: string, group: WidgetUnit[], chosenName: string, kind: string, dryRun: boolean, componentPath: string,
): Promise<ExtractedComponent | { bail: string }> {
  if (!group.every((g) => g.stateName)) return { bail: 'mixes a StatefulWidget with a StatelessWidget — not merged' };
  const norm = (g: WidgetUnit): string => g.source
    .replace(new RegExp(`\\b${escapeRe(g.stateName!)}\\b`, 'g'), '__STATE__')
    .replace(new RegExp(`\\b${escapeRe(g.localName)}\\b`, 'g'), '__SELF__')
    .replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  if (new Set(group.map(norm)).size > 1) return { bail: 'stateful copies are not identical (only identical StatefulWidget + State pairs are lifted)' };
  const own = new Set(group.flatMap((g) => [g.localName, g.stateName!]));
  const g0 = group[0];
  const declared = new Set([...g0.source.matchAll(/\b(_[A-Za-z0-9_]+)\s*(?:\(|=>|=|;|\{)/g)].map((m) => m[1]));
  const foreign = [...new Set((g0.source.match(/\b_[A-Za-z0-9_]+\b/g) || []).filter((p) => !own.has(p) && !declared.has(p)))];
  if (foreign.length) return { bail: `references a private sibling (${foreign.slice(0, 3).join(', ')}) that would not resolve in lib/components — retried once that sibling is lifted` };
  const stateName = `_${chosenName}State`;
  const body = g0.source
    .replace(new RegExp(`\\b${escapeRe(g0.stateName!)}\\b`, 'g'), stateName)
    .replace(new RegExp(`\\b${escapeRe(g0.localName)}\\b`, 'g'), chosenName);
  const absComponent = path.join(projectRoot, componentPath);
  const symbolIndex = await buildSymbolIndex(projectRoot);
  const imports = [
    "import 'package:flutter/material.dart';",
    ...(/\bSvgPicture\b/.test(body) ? ["import 'package:flutter_svg/flutter_svg.dart';"] : []),
    ...(/\bAppTheme\b/.test(body) ? ["import '../theme/app_theme.dart';"] : []),
    ...resolveBodyImports(body, absComponent, projectRoot, symbolIndex).filter((i) => !i.includes('app_theme.dart') && !i.includes('flutter_svg')),
  ];
  const source = [`// ${chosenName} — shared component (Phase 7a extraction), lifted from identical per-screen copies.`, ...imports, '', body, ''].join('\n');
  if (!dryRun) {
    await fs.mkdir(path.dirname(absComponent), { recursive: true });
    await fs.writeFile(absComponent, source, 'utf8');
    for (const g of group) {
      let src = await fs.readFile(g.file, 'utf8');
      src = removeClass(src, g.stateName!);
      src = removeClass(src, g.localName);
      src = src.replace(new RegExp(`\\b${escapeRe(g.localName)}\\s*\\(`, 'g'), `${chosenName}(`);
      src = ensureImport(src, importPathFromScreen(componentPath));
      src = pruneDeadDeclarations(src, projectRoot, symbolIndex);
      await fs.writeFile(g.file, src, 'utf8');
    }
  }
  return {
    name: chosenName, kind, fromPrivateNames: [...new Set(group.map((g) => g.localName))],
    usedIn: group.map((g) => relPath(projectRoot, g.file)), componentPath, parameterizedFields: [], occurrences: group.length,
  };
}

// ── Symbol → defining-file index (for resolving lifted-body imports) ──────────

/** Build an index of every PUBLIC top-level Dart class/enum/mixin/typedef defined
 *  under lib/ → its absolute defining file. Used to import any symbol a lifted
 *  component body references (sibling components, shared widgets, theme types).
 *  Skips lib/screens (screen classes are never imported by a shared component). */
async function buildSymbolIndex(projectRoot: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const libDir = path.join(projectRoot, 'lib');
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (abs !== screensDir) await walk(abs); continue; }
      if (!e.name.endsWith('.dart')) continue;
      const src = await fs.readFile(abs, 'utf8');
      const declRe = /^(?:abstract\s+|sealed\s+|base\s+|final\s+|interface\s+|mixin\s+)*(?:class|enum|mixin|extension|typedef)\s+([A-Z][A-Za-z0-9_]*)\b/gm;
      let m: RegExpExecArray | null;
      while ((m = declRe.exec(src)) !== null) {
        // First definition wins (stable); a symbol defined twice is ambiguous —
        // keep the first so the resolver is deterministic.
        if (!index.has(m[1])) index.set(m[1], abs);
      }
    }
  };
  await walk(libDir);
  return index;
}

/** Identifiers that are core Dart/Flutter (always available via material.dart) and
 *  must NOT be import-resolved. A conservative allow-list of the common ones the
 *  lifted bodies use; anything else Capitalized is looked up in the symbol index. */
const CORE_FLUTTER_SYMBOLS = new Set<string>([
  'SizedBox', 'Container', 'Stack', 'Positioned', 'Row', 'Column', 'Center', 'Align',
  'Padding', 'Expanded', 'Flexible', 'Spacer', 'Text', 'Icon', 'Image', 'Color',
  'Colors', 'Widget', 'BuildContext', 'EdgeInsets', 'BoxDecoration', 'BorderRadius',
  'Border', 'BorderSide', 'BoxShape', 'BoxShadow', 'Offset', 'Alignment', 'Radius',
  'TextStyle', 'FontWeight', 'TextAlign', 'TextOverflow', 'MainAxisAlignment',
  'CrossAxisAlignment', 'MainAxisSize', 'Flex', 'Wrap', 'Opacity', 'ClipRRect',
  'ClipOval', 'DecoratedBox', 'ColoredBox', 'FittedBox', 'AspectRatio', 'Transform',
  'GestureDetector', 'InkWell', 'Material', 'IconData', 'Icons', 'LinearGradient',
  'RadialGradient', 'Gradient', 'Theme', 'ThemeData', 'MediaQuery', 'Scaffold',
  'AppBar', 'Card', 'Divider', 'CircleAvatar', 'ConstrainedBox', 'BoxConstraints',
  'SingleChildScrollView', 'ListView', 'Flexible', 'IntrinsicHeight', 'IntrinsicWidth',
  'Visibility', 'AnimatedContainer', 'Duration', 'Curves', 'TextSpan', 'RichText',
  'Key', 'ValueKey', 'GlobalKey', 'Navigator', 'StatelessWidget', 'StatefulWidget',
  'State', 'CircularProgressIndicator', 'TextDecoration', 'FontStyle', 'Matrix4',
  'LayoutBuilder', 'Builder', 'SafeArea', 'Positioned', 'Shadow', 'StackFit',
  'Clip', 'OverflowBox', 'Stack', 'TextDirection', 'VerticalDirection', 'Axis',
]);

/** Resolve the relative-import lines a lifted body needs for PUBLIC symbols it
 *  references (constructor calls `Foo(` and static refs `Foo.`) that are defined
 *  under lib/ but outside core flutter. Returns dedup'd `import '...';` lines. */
function resolveBodyImports(
  body: string,
  componentAbsFile: string,
  _projectRoot: string,
  symbolIndex: Map<string, string>,
): string[] {
  const refs = new Set<string>();
  const re = /\b([A-Z][A-Za-z0-9_]*)\s*[(.]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) refs.add(m[1]);
  const lines = new Set<string>();
  for (const sym of refs) {
    if (CORE_FLUTTER_SYMBOLS.has(sym)) continue;
    const def = symbolIndex.get(sym);
    if (!def) continue;                         // unknown → can't resolve; leave it
    if (def === componentAbsFile) continue;     // self
    let rel = path.relative(path.dirname(componentAbsFile), def).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    lines.add(`import '${rel}';`);
  }
  return [...lines].sort();
}

interface ParamPlan {
  params: DartCtorParam[];
  /** Build the component file. `extraImports(body)` resolves imports for any
   *  PUBLIC symbol the lifted body references beyond core flutter. */
  componentSource: (name: string, extraImports: (body: string) => string[]) => string;
  /** Map: for each occurrence file, the call-site arg expression per param. */
  callArgs: Map<string, Record<string, string>>;
  /** File-local const identifiers that were lifted into params (per file). */
  liftedConsts: Map<string, string[]>;
  /** The lifted constructor is `const` (mirrors the private original). */
  constCtor: boolean;
}

interface SpanParam {
  name: string;
  type: string;
  /** [start,end) char offset in the FIRST occurrence's build body. */
  baseSpan: [number, number];
  /** Per-file value expression text for this param's span. */
  perFile: Map<string, string>;
}

/**
 * Compare the group's class sources and produce a parameterization plan that
 * preserves visuals EXACTLY. Strategy:
 *   - tokenize each build body (offsets into original text);
 *   - require identical token COUNT (same shape) — else refuse to merge;
 *   - find positions whose token text differs across occurrences. Only VALUE
 *     tokens may differ; a differing STRUCTURAL token (Capitalized type, named-
 *     arg key, punctuation) means genuinely-different widgets → refuse;
 *   - expand each differing run to its enclosing ARGUMENT EXPRESSION (whole
 *     `AppTheme.grotesk(...)`, `FontWeight.w600`, `_fieldBg`, a string) so we
 *     never parameterize a dotted-name fragment;
 *   - merge overlapping/adjacent spans into one param;
 *   - the component body = first occurrence's ORIGINAL text with each span
 *     replaced by `pN` (formatting preserved); each call site passes its own
 *     span text (file-local consts inlined).
 * Returns null (refuse) on any structural divergence.
 */
function planParameterization(projectRoot: string, group: WidgetUnit[]): ParamPlan | { bail: string } {
  const bodies = group.map((g) => extractBuildBody(g.source));
  const ctors = group.map((g) => parseExistingCtorParams(g.source));
  // F2: members besides the constructor, the fields and build() (a `_tap(...)`
  // helper, a getter, a static const) travel with the widget — they must be the
  // same in every copy, and the private names they declare are the widget's own.
  const extras = group.map((g) => classExtraMembers(g.source, g.localName));
  const norm = (xs: string[], own: string): string => xs.map((x) => x.replace(new RegExp(`\\b${escapeRe(own)}\\b`, 'g'), '__SELF__').replace(/\s+/g, ' ').trim()).join('\n');
  const extraNorm = extras.map((x, i) => norm(x, group[i].localName));
  if (new Set(extraNorm).size > 1) return { bail: 'the copies differ outside build() (helper methods/getters are not identical) — not merged' };
  const memberPrivates = new Set(extras[0].flatMap((x) => [...x.matchAll(/\b(_[A-Za-z0-9_]+)\s*(?:\(|=>|=|;|\{)/g)].map((m) => m[1])));

  // GUARD: refuse to lift a widget whose build body references file-local PRIVATE
  // identifiers (other `_Widget`s / helpers / consts that survived inlining) —
  // those won't resolve in lib/components/. Lifting it would dangle. The group's
  // OWN class names are allowed (they're being lifted together is not the case
  // here — each group is one widget kind). This keeps the refactor safe rather
  // than producing a component that references an undefined sibling.
  const ownNames = new Set(group.map((g) => g.localName));
  for (let i = 0; i < bodies.length; i++) {
    const privs = [...(bodies[i].match(/\b_[A-Za-z0-9_]+\b/g) || []), ...extras[i].flatMap((x) => x.match(/\b_[A-Za-z0-9_]+\b/g) || [])];
    const foreign = [...new Set(privs.filter((p) => !ownNames.has(p) && !memberPrivates.has(p)))];
    if (foreign.length) return { bail: `references a private sibling (${foreign.slice(0, 3).join(', ')}) that would not resolve in lib/components — retried once that sibling is lifted` };
  }

  const themeTypes = themeMemberTypes(projectRoot);
  const streams = bodies.map(tokenizeDart);
  const len = streams[0].length;
  if (!streams.every((s) => s.length === len)) return { bail: 'build() bodies differ in length after normalisation — not the same widget' };

  const base = streams[0];
  const existingParamNames = new Set(ctors[0].flatMap((c) => c.name));

  // 1) differing token indices (value-only; structural diff ⇒ refuse).
  const diffIdx: number[] = [];
  for (let i = 0; i < len; i++) {
    const texts = streams.map((s) => s[i].text);
    if (new Set(texts).size > 1) {
      if (!streams.every((s) => isValueToken(s[i]))) return { bail: `the copies differ structurally at '${streams.map((s) => s[i].text).join("' / '")}' — not merged` };
      diffIdx.push(i);
    }
  }
  if (diffIdx.length === 0) {
    // Byte-identical structure & values: pure duplicate, no params.
    return makePlan(group, base, bodies[0], ctors[0], [], extras[0]);
  }

  // 2) expand each diff token to its enclosing argument-expression span (token
  //    index range), then merge overlapping ranges.
  let ranges: Array<[number, number]> = diffIdx.map((i) => widenToValueWrapper(base, enclosingArgRange(base, i)));
  ranges = mergeRanges(ranges);

  // 3) Skip ranges that are exactly an existing ctor param reference (already a
  //    parameter — the value is driven by the call site through that param).
  const spanParams: SpanParam[] = [];
  let pidx = 0;
  for (const [lo, hi] of ranges) {
    const baseText = bodies[0].slice(base[lo].start, base[hi].end);
    if (existingParamNames.has(baseText.trim())) continue;
    // Collect the span's value PER OCCURRENCE, keyed by (file::localName). A
    // single file may contain MULTIPLE distinct group members (e.g. _VerifiedBadge
    // AND _ExpandChevron both render an Icon) with DIFFERENT values — keying by
    // file alone would let one overwrite the other and assign the wrong value to
    // both call sites. The unit key keeps each occurrence's value distinct.
    const perFile = new Map<string, string>();
    for (let gi = 0; gi < group.length; gi++) {
      const s = streams[gi];
      const txt = bodies[gi].slice(s[lo].start, s[hi].end).trim();
      perFile.set(unitKey(group[gi]), txt);
    }
    const ptype = dartTypeForSpan([...perFile.values()], themeTypes, argKeyFor(base, lo));
    // CONTRACTS §5: the parameter is named after the named argument it feeds
    // (`color:` → `color`), never `p0`. Collisions get a numeric suffix.
    const taken = new Set([...existingParamNames, ...spanParams.map((x) => x.name)]);
    const stem = paramNameFor(base, lo, ptype);
    let pname = stem;
    for (let k = 2; taken.has(pname) || DART_RESERVED.has(pname); k++) pname = `${stem}${k}`;
    pidx++;
    spanParams.push({ name: pname, type: ptype, baseSpan: [base[lo].start, base[hi].end], perFile });
  }

  return makePlan(group, base, bodies[0], ctors[0], spanParams, extras[0]);
}

function makePlan(
  group: WidgetUnit[],
  base: Tok[],
  baseBody: string,
  existing: DartCtorParam[],
  spanParams: SpanParam[],
  extraMembers: string[] = [],
): ParamPlan {
  // Mirror the original constructor: an explicit non-const `_Foo(...)` stays
  // non-const; otherwise the lifted constructor is const.
  const src0 = group[0].source;
  const ctorRe = new RegExp(`^\\s*(const\\s+)?${escapeRe(group[0].localName)}\\s*\\(`, 'm');
  const ctorM = ctorRe.exec(src0);
  const hadCtor = !!ctorM;
  const constCtor = hadCtor ? !!ctorM![1] : true;
  // A public widget needs a key parameter (use_key_in_widget_constructors), so a
  // constructor is always emitted; when that makes a caller const-able the per-group
  // guard sees the new lint and reverts the group rather than ship it.
  const omitCtor = false;
  // Keyed by unit (file::localName) so co-located distinct members stay distinct.
  const callArgs = new Map<string, Record<string, string>>();
  const liftedConsts = new Map<string, string[]>();
  for (const g of group) { callArgs.set(unitKey(g), {}); liftedConsts.set(unitKey(g), []); }

  for (const sp of spanParams) {
    for (const g of group) {
      const raw = sp.perFile.get(unitKey(g))!;
      callArgs.get(unitKey(g))![sp.name] = raw;
      if (/^_[A-Za-z0-9_]+$/.test(raw)) liftedConsts.get(unitKey(g))!.push(raw);
    }
  }

  const params: DartCtorParam[] = spanParams.map((s) => ({ name: s.name, type: s.type, required: true, positional: false }));

  const componentSource = (name: string, extraImports: (body: string) => string[]): string =>
    buildFlutterComponentFromSpans(name, baseBody, existing, spanParams, extraImports, extraMembers.map((x) => x.replace(new RegExp(`\\b${escapeRe(group[0].localName)}\\b`, 'g'), name)), { omitCtor, constCtor });

  return { params, componentSource, callArgs, liftedConsts, constCtor: omitCtor ? false : constCtor };
}

/** Token-index range [lo,hi] of the argument expression enclosing token i, at i's
 *  own bracket depth: walk left/right until a depth-0 `,`, an opening bracket, a
 *  named-arg `key :`, or the matching close bracket. */
function enclosingArgRange(toks: Tok[], i: number): [number, number] {
  // walk left
  let lo = i;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const t = toks[j].text;
    if (t === ')' || t === ']' || t === '}' || t === '>') depth++;
    else if (t === '(' || t === '[' || t === '{' || t === '<') { if (depth === 0) { lo = j + 1; break; } depth--; }
    else if (depth === 0 && t === ',') { lo = j + 1; break; }
    else if (depth === 0 && t === ':') { lo = j + 1; break; } // after a named-arg key
    if (j === 0) lo = 0;
  }
  // walk right
  let hi = i;
  depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j].text;
    if (t === '(' || t === '[' || t === '{' || t === '<') depth++;
    else if (t === ')' || t === ']' || t === '}' || t === '>') { if (depth === 0) { hi = j - 1; break; } depth--; }
    else if (depth === 0 && t === ',') { hi = j - 1; break; }
    if (j === toks.length - 1) hi = j;
  }
  // trim leading/trailing whitespace-only handled by offsets; ensure lo<=hi
  if (lo > hi) { lo = i; hi = i; }
  return [lo, hi];
}

/** A differing value that is the sole argument of a value wrapper
 *  (`const Color(0xFF12AE89)`, `BorderRadius.circular(12)`, `EdgeInsets.all(16)`,
 *  `Radius.circular(8)`) is parameterized as the WHOLE wrapper expression, so the
 *  parameter is a typed `Color` / `BorderRadius` / `EdgeInsets` rather than an `int`
 *  the body re-wraps. Identical token shape across the group guarantees every
 *  occurrence has the same wrapper. */
const VALUE_WRAPPERS = new Set(['Color', 'Color.fromARGB', 'BorderRadius.circular', 'Radius.circular', 'EdgeInsets.all', 'EdgeInsets.symmetric', 'EdgeInsets.only', 'EdgeInsets.fromLTRB']);
function widenToValueWrapper(toks: Tok[], [lo, hi]: [number, number]): [number, number] {
  if (toks[lo - 1]?.text !== '(') return [lo, hi];
  // the matching close must sit right after the span
  let depth = 0;
  let close = -1;
  for (let j = lo - 1; j < toks.length; j++) {
    const t = toks[j].text;
    if (t === '(') depth++;
    else if (t === ')') { depth--; if (depth === 0) { close = j; break; } }
  }
  if (close !== hi + 1) return [lo, hi];
  let start = lo - 2;
  let callee = toks[start]?.text ?? '';
  if (toks[start - 1]?.text === '.' && toks[start - 2]?.kind === 'id') { callee = `${toks[start - 2].text}.${callee}`; start -= 2; }
  if (!VALUE_WRAPPERS.has(callee)) return [lo, hi];
  if (toks[start - 1]?.text === 'const') start--;
  return [start, close];
}

const DART_RESERVED = new Set(['key', 'default', 'class', 'const', 'final', 'new', 'this', 'super', 'switch', 'case', 'if', 'else', 'for', 'in', 'is', 'return', 'var', 'void', 'null', 'true', 'false', 'with', 'extends', 'build', 'context']);

/** Name a parameter after the named argument its span feeds: walk out from the span
 *  through enclosing brackets until a `key:` at that level (`color: Color(p)` →
 *  `color`, `style: TextStyle(fontSize: p)` → `fontSize`). No named key anywhere
 *  (a positional `Text('…')`) → the callee (`text`) or the type (`value`). */
function paramNameFor(toks: Tok[], lo: number, ptype: string): string {
  let depth = 0;
  let positional = false;
  let firstCallee: string | null = null;
  for (let j = lo - 1; j >= 0; j--) {
    const t = toks[j].text;
    if (t === ')' || t === ']' || t === '}') { depth++; continue; }
    if (t === '(' || t === '[' || t === '{') {
      if (depth > 0) { depth--; continue; }
      if (t === '(' && toks[j - 1]?.kind === 'id' && !firstCallee) firstCallee = toks[j - 1].text;
      positional = false;   // leaving this level; look for the key one level up
      continue;
    }
    if (depth !== 0) continue;
    if (t === ',') { positional = true; continue; }
    if (t === ':' && !positional && toks[j - 1]?.kind === 'id' && toks[j - 2]?.text !== '?') {
      const key = toks[j - 1].text;
      if (key !== 'child' && key !== 'children') return key;
      break;
    }
    if (t === ';' || t === '=>') break;
  }
  if (firstCallee && /^[A-Z]/.test(firstCallee)) return firstCallee.charAt(0).toLowerCase() + firstCallee.slice(1);
  if (ptype !== 'dynamic') return ptype.charAt(0).toLowerCase() + ptype.slice(1).replace(/Geometry$/, '');
  return 'value';
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The declared type of every static member of the project theme class
 *  (`static const Color brand` → Color, `static TextStyle button18(...)` → TextStyle). */
function themeMemberTypes(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  let src = '';
  try { src = fsSync.readFileSync(path.join(projectRoot, 'lib', 'theme', 'app_theme.dart'), 'utf8'); } catch { return out; }
  const cls = /class\s+([A-Za-z_]\w*)\s*\{/.exec(src)?.[1] ?? 'AppTheme';
  for (const m of src.matchAll(/static\s+(?:const\s+|final\s+)?([A-Z][A-Za-z0-9_<>?]*)\s+(?:get\s+)?([A-Za-z_]\w*)\s*(?=[=(;,])/g)) out.set(`${cls}.${m[2]}`, m[1]);
  // multi-assign `static const double s4 = 4, s8 = 8;`
  for (const m of src.matchAll(/static\s+const\s+(double|int)\s+((?:[A-Za-z_]\w*\s*=\s*[^,;]+,?\s*)+);/g)) {
    for (const pm of m[2].matchAll(/([A-Za-z_]\w*)\s*=/g)) out.set(`${cls}.${pm[1]}`, m[1]);
  }
  return out;
}

/** The named argument a span feeds (`style: <span>` → 'style'), or null. */
function argKeyFor(toks: Tok[], lo: number): string | null {
  const t1 = toks[lo - 1]; const t2 = toks[lo - 2];
  return t1?.text === ':' && t2?.kind === 'id' ? t2.text : null;
}

const KEY_TYPES: Array<[RegExp, string]> = [
  [/^(style|textStyle|labelStyle|hintStyle)$/, 'TextStyle'],
  [/^(color|backgroundColor|foregroundColor|borderColor|fillColor|iconColor|shadowColor|surfaceTintColor|activeColor|inactiveColor|thumbColor|trackColor)$/, 'Color'],
  [/^(width|height|size|radius|elevation|spacing|thickness|strokeWidth|fontSize|letterSpacing|opacity|dimension)$/, 'double'],
  [/^(padding|margin)$/, 'EdgeInsetsGeometry'],
  [/^(borderRadius)$/, 'BorderRadiusGeometry'],
  [/^(icon)$/, 'IconData'],
  [/^(label|text|title|subtitle|semanticLabel|hintText|labelText)$/, 'String'],
  [/^(onTap|onPressed|onChanged|onSubmitted|onLongPress)$/, 'VoidCallback'],
];

function dartTypeForSpan(values: string[], themeTypes: Map<string, string> = new Map(), key: string | null = null): string {
  const v0 = values.map((v) => v.trim().replace(/^const\s+/, ''));
  // 1) the theme knows its own members' types (AppTheme.button18(..) is a TextStyle
  //    even though its argument mentions a colour token).
  const themed = v0.map((v) => /^([A-Z]\w*\.[A-Za-z_]\w*)\s*(\(|$)/.exec(v)).map((m) => (m ? themeTypes.get(m[1]) : undefined));
  if (themed.every(Boolean) && new Set(themed).size === 1) return themed[0]!;
  if (v0.every((v) => /^['"]/.test(v))) return 'String';
  // Bare hex literal (e.g. `0xFFf5f5f5` inside an outer `Color(...)`): the call
  // site supplies the int and the body wraps it (`Color(p0)`).
  if (v0.every((v) => /^0x[0-9A-Fa-f]+$/.test(v))) return 'int';
  // Bare decimal literal: type as `double`. Flutter sizing/spacing APIs take
  // doubles; an int param would be rejected where a double is required, and an
  // int LITERAL is implicitly assignable to a double param at the call site.
  if (v0.every((v) => /^-?\d+(?:\.\d+)?$/.test(v))) return 'double';
  const joined = v0.join(' ');
  // Order matters: a whole style call (montserrat(...)) CONTAINS `FontWeight.` —
  // check the call shape first so the span isn't mistyped as FontWeight.
  if (v0.every((v) => /^(AppTheme|Theme)?\.?(grotesk|montserrat|inter)\s*\(/.test(v)) || /TextStyle\(/.test(joined)) return 'TextStyle';
  if (v0.every((v) => /^FontWeight\./.test(v))) return 'FontWeight';
  if (v0.every((v) => /^Icons\./.test(v))) return 'IconData';
  if (v0.every((v) => /^EdgeInsets/.test(v))) return 'EdgeInsetsGeometry';
  if (v0.every((v) => /^BorderRadius\./.test(v))) return 'BorderRadius';
  if (v0.every((v) => /^Radius\./.test(v))) return 'Radius';
  // 2) the argument the span feeds says what it is (`style:` is a TextStyle).
  const byKey = key ? KEY_TYPES.find(([re]) => re.test(key))?.[1] : undefined;
  if (byKey) return byKey;
  if (/^Color\(/.test(v0[0]) || v0.every((v) => /^[A-Z]\w*\.(brand|ink\d?|surface|hint|muted|neutral\d?|helper|success|error|warning)$/.test(v)) || /Fill\b|fill\b/.test(joined)) return 'Color';
  return 'dynamic';
}

interface Tok { text: string; kind: 'id' | 'str' | 'num' | 'punct' | 'ws'; start: number; end: number; }

/** Tokenize Dart, carrying char offsets INTO THE ORIGINAL string. Comments are
 *  blanked (replaced with spaces, length-preserving) so offsets stay valid. */
function tokenizeDart(s: string): Tok[] {
  const clean = s
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const toks: Tok[] = [];
  const re = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|0x[0-9A-Fa-f]+|\b\d+(?:\.\d+)?\b|[A-Za-z_$][A-Za-z0-9_$]*|[{}()\[\],.:?;<>=!+\-*/%&|]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const t = m[0];
    let kind: Tok['kind'];
    if (t[0] === "'" || t[0] === '"') kind = 'str';
    else if (/^(0x|\d)/.test(t)) kind = 'num';
    else if (/^[A-Za-z_$]/.test(t)) kind = 'id';
    else kind = 'punct';
    toks.push({ text: t, kind, start: m.index, end: m.index + t.length });
  }
  return toks;
}

/** A value token = leaf that may differ between occurrences without changing
 *  structure: strings, numbers, and lowercase-leading identifiers (theme
 *  getters, params, local consts). Capitalized identifiers and punctuation are
 *  STRUCTURAL and may NOT differ. */
function isValueToken(t: Tok): boolean {
  if (t.kind === 'str' || t.kind === 'num') return true;
  if (t.kind === 'id') {
    // method names on theme (grotesk/montserrat/inter), color getters (ink/ink3),
    // local consts (_fieldBg/_meterFill), bool/keywords used as values.
    return /^[_a-z]/.test(t.text);
  }
  return false;
}

function parseExistingCtorParams(classSource: string): DartCtorParam[] {
  // Match `const _Foo({...});` or `const _Foo(this.x, this.y);`
  const cm = /const\s+_?[A-Za-z0-9_]+\s*\(([\s\S]*?)\)\s*;/.exec(classSource);
  if (!cm) return [];
  const inner = cm[1].trim();
  if (!inner) return [];
  const params: DartCtorParam[] = [];
  // Determine declared field types from the class body for `this.x` params.
  const fieldTypes = new Map<string, string>();
  const fieldRe = /final\s+([A-Za-z0-9_<>?,. ]+?)\s+([A-Za-z0-9_]+)\s*;/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(classSource)) !== null) fieldTypes.set(fm[2], fm[1].trim());

  const braced = inner.startsWith('{');
  const body = braced ? inner.replace(/^\{|\}$/g, '') : inner;
  for (const rawSeg of splitTopLevel(body)) {
    const seg = rawSeg.trim().replace(/,$/, '');
    if (!seg) continue;
    const req = /\brequired\b/.test(seg);
    const thisM = /this\.([A-Za-z0-9_]+)/.exec(seg);
    if (thisM) {
      const nm = thisM[1];
      // Preserve any default value (`this.active = false`) so the lifted ctor
      // keeps it — otherwise a non-nullable field with no default + no `required`
      // is a compile error.
      const defM = /=\s*([\s\S]+)$/.exec(seg.slice(thisM.index + thisM[0].length));
      params.push({
        name: nm,
        type: fieldTypes.get(nm) ?? 'Object',
        required: req,
        positional: !braced,
        defaultValue: defM ? defM[1].trim() : undefined,
      });
    }
  }
  return params;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = ''; let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Remove `const` from any constructor invocation whose `(...)` span contains a
 *  param reference (making it non-constant). Scans `const` keywords; for each,
 *  finds the following `(...)` span and drops `const` if a param appears inside. */
function stripNonConstConst(body: string, params: Set<string>): string {
  const toks = tokenizeDart(body);
  const dropAt: number[] = []; // char offsets of `const` keywords to remove
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind !== 'id' || toks[i].text !== 'const') continue;
    // Find the next `(` after this const (skipping the type name tokens).
    let openTok = -1;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].text === '(') { openTok = j; break; }
      if (toks[j].text === '{' || toks[j].text === ';') break; // not a ctor call
    }
    if (openTok < 0) continue;
    // Compute char span of the matching paren in the body.
    const openChar = toks[openTok].start;
    const closeChar = matchParen(body, openChar);
    if (closeChar < 0) continue;
    const span = body.slice(openChar, closeChar);
    if ([...params].some((p) => new RegExp(`\\b${p}\\b`).test(span))) dropAt.push(toks[i].start);
  }
  // Remove right-to-left.
  for (const off of dropAt.sort((a, b) => b - a)) {
    body = body.slice(0, off) + body.slice(off + 'const'.length).replace(/^\s/, '');
  }
  return body;
}

/** Build the shared component file. The build body is the FIRST occurrence's
 *  ORIGINAL text (formatting preserved) with each parameterized span replaced by
 *  its param name. Existing positional/named ctor params are carried through;
 *  new span params are appended as named+required. */
function buildFlutterComponentFromSpans(
  name: string,
  baseBody: string,
  existing: DartCtorParam[],
  spanParams: SpanParam[],
  extraImports: (body: string) => string[],
  extraMembers: string[] = [],
  ctorOpts: { omitCtor?: boolean; constCtor?: boolean } = {},
): string {
  // Replace spans right-to-left so offsets stay valid.
  let body = baseBody;
  const sorted = [...spanParams].sort((a, b) => b.baseSpan[0] - a.baseSpan[0]);
  for (const sp of sorted) {
    body = body.slice(0, sp.baseSpan[0]) + sp.name + body.slice(sp.baseSpan[1]);
  }
  body = body.trim();
  // A `const Foo(...)` whose arg list now contains a runtime param is no longer
  // a constant expression. Drop `const` on every constructor invocation whose
  // bracket span contains a param name (the innermost still-constant subtrees
  // remain const). Without this Dart errors `const_with_non_constant_argument`.
  const paramNames = new Set(spanParams.map((s) => s.name));
  if (paramNames.size) body = stripNonConstConst(body, paramNames);

  const positional = existing.filter((e) => e.positional);
  const namedExisting = existing.filter((e) => !e.positional);
  const namedNew: DartCtorParam[] = spanParams.map((s) => ({ name: s.name, type: s.type, required: true, positional: false }));

  // A named param's declaration: keep `required` / preserve any default value.
  const declNamed = (p: DartCtorParam): string => {
    if (p.required) return `required this.${p.name}`;
    if (p.defaultValue !== undefined) return `this.${p.name} = ${p.defaultValue}`;
    return `this.${p.name}`;
  };
  const named = ['super.key', ...[...namedExisting, ...namedNew].map(declNamed)];

  // Positional params first, then a `{ }` named block (Dart syntax).
  let ctorSig: string;
  const kw = ctorOpts.constCtor === false ? '' : 'const ';
  if (ctorOpts.omitCtor) {
    ctorSig = '';
  } else if (positional.length > 0) {
    const pos = positional.map((p) => `this.${p.name}`).join(', ');
    ctorSig = `  ${kw}${name}(${pos}, {\n${named.map((n) => `    ${n},`).join('\n')}\n  });`;
  } else {
    ctorSig = `  ${kw}${name}({\n${named.map((n) => `    ${n},`).join('\n')}\n  });`;
  }

  const fieldLines = [...positional, ...namedExisting, ...namedNew]
    .map((p) => `  final ${p.type} ${p.name};`)
    .join('\n');

  // Emit only the imports the component actually uses (the body — call-site
  // values stay on the screen, so they don't count here). flutter/material is
  // always needed (StatelessWidget/Widget/BuildContext).
  const usesSvg = /\bSvgPicture\b/.test(body) || extraMembers.some((x) => /\bSvgPicture\b/.test(x));
  const usesTheme = /\bAppTheme\b/.test(body) || extraMembers.some((x) => /\bAppTheme\b/.test(x));
  // Any OTHER public symbol the body references (sibling components like Disc,
  // shared widgets like PingButton) is resolved to its lib/ defining file and
  // imported — otherwise the lifted file references undefined symbols.
  const resolved = extraImports([body, ...extraMembers].join('\n')).filter(
    (imp) => !imp.includes('app_theme.dart') && !imp.includes('flutter_svg'),
  );
  const imports = [
    "import 'package:flutter/material.dart';",
    ...(usesSvg ? ["import 'package:flutter_svg/flutter_svg.dart';"] : []),
    ...(usesTheme ? ["import '../theme/app_theme.dart';"] : []),
    ...resolved,
  ];

  return [
    `// ${name} — shared component (Phase 7a extraction). De-duplicated from`,
    `// per-screen private copies; per-occurrence values are parameters.`,
    ...imports,
    '',
    `class ${name} extends StatelessWidget {`,
    ...(ctorSig ? [ctorSig, ''] : []),
    ...(fieldLines ? [fieldLines, ''] : []),
    '  @override',
    '  Widget build(BuildContext context) {',
    `    ${body}`,
    '  }',
    ...extraMembers.flatMap((x) => ['', `  ${x.trim()}`]),
    '}',
    '',
  ].join('\n');
}

/** Members of a widget class other than its constructor, its `final` fields and
 *  build() — returned verbatim (helper methods, getters, static consts). */
export function classExtraMembers(classSource: string, className: string): string[] {
  const open = classSource.indexOf('{');
  const close = open >= 0 ? matchBrace(classSource, open) : -1;
  if (close < 0) return [];
  const body = classSource.slice(open + 1, close);
  // Split into top-level members: a member ends at a depth-0 `;` or at the `}`
  // closing its own depth-1 block (a method body), strings respected.
  const members: string[] = [];
  let depth = 0; let cur = ''; let inStr: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    cur += c;
    if (inStr) { if (c === inStr && body[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === '}') {
        // `=> {...};` or a method body; a trailing `;` belongs to it only for arrow/collection bodies
        const rest = body.slice(i + 1);
        const semi = /^\s*;/.exec(rest);
        if (semi) { cur += semi[0]; i += semi[0].length; }
        members.push(cur); cur = '';
      }
    } else if (c === ';' && depth === 0) { members.push(cur); cur = ''; }
  }
  const ctorRe = new RegExp(`^(?:const\\s+)?${escapeRe(className)}\\s*\\(`);
  return members
    .map((m) => m.trim())
    .filter((m) => {
      const code = m.replace(/^(?:\s*\/\/[^\n]*\n)+/, '').replace(/^\s*@override\s*/, '').trim();
      if (!code) return false;
      if (ctorRe.test(code)) return false;
      if (/^Widget\s+build\s*\(/.test(code)) return false;
      if (/^(?:late\s+)?final\s+[^=;(]+;$/.test(code)) return false;   // a plain field
      return true;
    });
}

// ── Per-file rewrite: drop private class, rewrite call sites, add import ──────

async function rewriteOccurrenceFile(
  projectRoot: string,
  unit: WidgetUnit,
  componentName: string,
  componentPath: string,
  plan: ParamPlan,
  symbolIndex: Map<string, string>,
): Promise<void> {
  let src = await fs.readFile(unit.file, 'utf8');

  // 1) Remove the private class declaration entirely.
  src = removeClass(src, unit.localName);

  // 2) Rewrite call sites: `_Foo(` → `ComponentName(` and append new args.
  src = rewriteCallSites(src, unit.localName, componentName, unitKey(unit), plan);

  // 3) Ensure the import.
  src = ensureImport(src, importPathFromScreen(componentPath));

  // 4) Prune declarations the lift left dead — but ONLY when they now have ZERO
  //    references in the file (provably safe; a still-used const is left alone).
  src = pruneDeadDeclarations(src, projectRoot, symbolIndex);

  await fs.writeFile(unit.file, src, 'utf8');
}

/** Remove file-local declarations that are now unreferenced anywhere else in the
 *  file: top-level `const _x = …;`, private top-level getters/vars, and unused
 *  package imports (flutter_svg / theme). Each is removed only if its name has
 *  no other occurrence — so anything still in use is preserved. Idempotent. */
function pruneDeadDeclarations(src: string, projectRoot?: string, symbolIndex?: Map<string, string>): string {
  let out = src;
  // a) Unused file-local `const TYPE _name = …;`
  for (const [name] of collectFileConsts(out)) {
    const refs = (out.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) || []).length;
    if (refs <= 1) {
      out = out.replace(new RegExp(`^const\\s+[A-Za-z0-9_<>?]+\\s+${escapeRe(name)}\\s*=\\s*[^;]+;[^\\n]*\\n`, 'm'), '');
    }
  }
  // b) Unused private top-level `final/var/const TYPE? _name = …;` (e.g. _toggleOn)
  const varRe = /^(?:final|var|const)\s+[A-Za-z0-9_<>?]*\s*(_[A-Za-z0-9_]+)\s*=\s*[^;]+;[^\n]*\n/gm;
  let vm: RegExpExecArray | null;
  const varNames = new Set<string>();
  while ((vm = varRe.exec(out)) !== null) varNames.add(vm[1]);
  for (const name of varNames) {
    const refs = (out.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) || []).length;
    if (refs <= 1) out = out.replace(new RegExp(`^(?:final|var|const)\\s+[A-Za-z0-9_<>?]*\\s*${escapeRe(name)}\\s*=\\s*[^;]+;[^\\n]*\\n`, 'm'), '');
  }
  // c) Unused imports for symbols no longer referenced.
  const importChecks: Array<[RegExp, RegExp]> = [
    [/^import 'package:flutter_svg\/flutter_svg\.dart';\n/m, /\bSvgPicture\b/],
    [/^import '\.\.\/theme\/app_theme\.dart';\n/m, /\bAppTheme\b/],
  ];
  for (const [imp, used] of importChecks) {
    if (imp.test(out) && !used.test(out.replace(imp, ''))) out = out.replace(imp, '');
  }
  // d) Generalized: prune relative imports (`../components/x.dart`, `../widgets/x.
  //    dart`, `./x.dart`) whose provided class(es) are no longer referenced after
  //    the lift removed the only usage (the `disc.dart` unused_import regression).
  //    Resolve each relative import to its file via the symbol index reverse map;
  //    drop the import only when NONE of the classes that file defines appear in
  //    the remaining source. Reference-checked + idempotent + safe (skipped when
  //    we cannot resolve the file → never guesses).
  if (projectRoot && symbolIndex) {
    const fileToClasses = new Map<string, string[]>();
    for (const [sym, file] of symbolIndex) {
      const arr = fileToClasses.get(file) ?? [];
      arr.push(sym);
      fileToClasses.set(file, arr);
    }
    const relImportRe = /^import\s+'((?:\.{1,2}\/)[^']+\.dart)';\n/gm;
    const lines = [...out.matchAll(relImportRe)].map((m) => ({ full: m[0], rel: m[1] }));
    for (const { full, rel } of lines) {
      // resolve the import path against lib/screens (occurrence files live there).
      const abs = path.resolve(path.join(projectRoot, 'lib', 'screens'), rel);
      const classes = fileToClasses.get(abs);
      if (!classes || !classes.length) continue;        // unknown file → keep (safe)
      const body = out.replace(full, '');
      const stillUsed = classes.some((c) => new RegExp(`\\b${escapeRe(c)}\\b`).test(body));
      if (!stillUsed) out = out.replace(full, '');
    }
  }
  return out;
}

function removeClass(src: string, className: string): string {
  const re = new RegExp(`^class\\s+${escapeRe(className)}\\b`, 'm');
  const m = re.exec(src);
  if (!m) return src;
  const braceStart = src.indexOf('{', m.index);
  const end = matchBrace(src, braceStart);
  if (end < 0) return src;
  // Also remove a leading `// ──` comment block immediately above the class.
  let start = m.index;
  const before = src.slice(0, start);
  const commentBlock = /(?:^[ \t]*\/\/[^\n]*\n)+\s*$/m.exec(before);
  if (commentBlock) start = commentBlock.index;
  // Trim trailing blank lines after the class.
  let after = end + 1;
  while (src[after] === '\n') after++;
  return src.slice(0, start).replace(/\n*$/, '\n\n') + src.slice(after);
}

function rewriteCallSites(
  src: string,
  localName: string,
  componentName: string,
  unitId: string,
  plan: ParamPlan,
): string {
  // callArgs are keyed by unit (file::localName) and hold value expressions with
  // file-local consts already INLINED, so each call site gets the right literal.
  const args = plan.callArgs.get(unitId) || {};
  const extra = Object.entries(args).map(([k, v]) => `${k}: ${v}`);

  // Match `_Foo(` possibly preceded by `const `. Append extra args before `)`.
  const callRe = new RegExp(`(const\\s+)?\\b${escapeRe(localName)}\\s*\\(`, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const close = matchParen(src, openIdx);
    if (close < 0) continue;
    // Strip a trailing comma so we don't emit `...,, p0:` (a parse error).
    const inner = src.slice(openIdx + 1, close).trim().replace(/,\s*$/, '');
    // New args go BEFORE a trailing child:/children: (sort_child_properties_last).
    const parts = splitTopLevelArgs(inner);
    const childAt = parts.findIndex((a) => /^(child|children)\s*:/.test(a.trim()));
    const mergedParts = childAt >= 0 ? [...parts.slice(0, childAt), ...extra, ...parts.slice(childAt)] : [...parts, ...extra];
    const mergedInner = mergedParts.map((a) => a.trim()).filter(Boolean).join(', ');
    // Preserve `const` when the original call was const AND we added no runtime
    // params (params/theme getters are non-const) AND the existing args are all
    // const-safe. Dropping const where it was valid regresses prefer_const_
    // constructors (an analyze info bump); keeping it where it's now invalid
    // would be an error. A param-free lift (e.g. const MastercardLogo()) stays
    // const; a parameterized one drops it.
    // The lifted component has a const constructor: a call whose arguments are all
    // constant expressions is written `const` (prefer_const_constructors), unless it
    // already sits in a const context (unnecessary_const).
    const keepConst = plan.constCtor && constSafeArgs(mergedInner) && (!!m[1] || !inConstContext(src, m.index));
    const prefix = keepConst ? 'const ' : '';
    out += src.slice(last, m.index) + `${prefix}${componentName}(${mergedInner})`;
    last = close + 1;
    callRe.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

/** True when an arg list contains only const-evaluable expressions (no method
 *  calls on lowercase receivers, no `context`, no lower-case identifiers that
 *  would be runtime values). Conservative: any lowercase identifier followed by
 *  `(` or `.` (a getter/method call) or a bare `context` makes it non-const. */
function constSafeArgs(inner: string): boolean {
  if (!inner.trim()) return true;
  if (/\bcontext\b/.test(inner)) return false;
  // A lowercase identifier used as a call/getter (theme.grotesk(), foo.bar) is
  // runtime. Capitalized ctors and Type.staticConst are const-safe.
  if (/\b[a-z][A-Za-z0-9_]*\s*[(.]/.test(inner)) return false;
  // A bare lowercase / private identifier in VALUE position (`child: glyph`,
  // `onTap: _submit`) is a runtime value; named-arg keys (`label:`), members after
  // a dot (`AppTheme.brand`) and true/false/null are not.
  const code = inner.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  for (const m of code.matchAll(/(?<![.\w$])([a-z_][A-Za-z0-9_]*)\b(?!\s*:)/g)) {
    if (!/^(true|false|null|const)$/.test(m[1])) return false;
  }
  if (/=>|\{/.test(code)) return false;   // closures are never const
  return true;
}

/** True when the position sits inside an enclosing `const X(...)` / `const [...]`
 *  expression (so a nested constructor is implicitly const). Walks outward through
 *  unmatched brackets; a block `{` that is not a const literal ends the search. */
function inConstContext(src: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ')' || c === ']' || c === '}') { depth++; continue; }
    if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) { depth--; continue; }
      const before = src.slice(Math.max(0, i - 120), i);
      if (/\bconst\s+[A-Za-z_][\w.]*(?:<[^>]*>)?\s*$/.test(before) || /\bconst\s*(?:<[^>]*>)?\s*$/.test(before)) return true;
      if (c === '{') return false;
    }
    if (c === ';' && depth === 0) return false;
  }
  return false;
}

/** Split an argument list on its top-level commas (brackets and strings respected). */
function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let inStr: string | null = null; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function ensureImport(src: string, importPath: string): string {
  const line = `import '${importPath}';`;
  if (src.includes(line)) return src;
  // Insert after the last existing import.
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (imports.length === 0) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const insertAt = last.index! + last[0].length;
  return src.slice(0, insertAt) + `\n${line}` + src.slice(insertAt);
}

function importPathFromScreen(componentPath: string): string {
  // screen lives in lib/screens/, component in lib/components/ → ../components/x.dart
  return `../${componentPath.split(path.sep).slice(1).join('/')}`;
}

// ── small utils ──────────────────────────────────────────────────────────────

/** Stable per-occurrence key: a file may hold multiple distinct group members. */
function unitKey(u: WidgetUnit): string { return `${u.file}::${u.localName}`; }
function relPath(root: string, abs: string): string { return path.relative(root, abs); }
function snake(s: string): string { return (s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, ''); }
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================================
// Web strategy (react + next) — component-extraction-web.ts
// =============================================================================

const webStrategy = (framework: Framework): ExtractorStrategy => ({
  framework,
  componentsDirName: path.join('src', 'components'),
  collectWidgets: (projectRoot, onlyFiles) => collectWebWidgets(projectRoot, onlyFiles),
  componentsDirFor: (projectRoot) => webComponentsDir(projectRoot),
  extractGroup: async (projectRoot, group, chosenName, kind, dryRun) => {
    const r = await extractWebGroup(projectRoot, group, chosenName, kind, dryRun);
    if ('bail' in r) return r;
    return {
      name: r.name,
      kind: r.kind,
      fromPrivateNames: r.fromLocalNames,
      usedIn: r.usedIn,
      componentPath: r.componentPath,
      parameterizedFields: [],
      occurrences: r.occurrences,
    };
  },
});

