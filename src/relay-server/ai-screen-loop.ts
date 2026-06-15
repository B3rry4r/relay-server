// =============================================================================
// File: src/relay-server/ai-screen-loop.ts
//
// Closed-loop, headless screen builder: implement → verify → fix → verify, until
// the built screen visually matches its reference render (or max iterations).
//
//   1. IMPLEMENT — spawn the coding agent with the client-built packet. It writes
//      the screen into the real project AND a per-screen *preview entrypoint*
//      that runs just this screen inside the app's real theme/router.
//   2. VERIFY    — build that preview entrypoint, screenshot it, and have a
//      SEPARATE (independent) agent compare it to the reference render, emitting
//      a strict JSON verdict {match, score, discrepancies}.
//   3. FIX       — if it doesn't match, resume the coding session with the
//      concrete discrepancies + both images and revise. Re-verify.
//
// Runs in the BACKGROUND: the route returns a jobId immediately and the loop
// survives the client tab closing. Progress streams to the shared job log;
// every iteration (verdict + candidate screenshot) is journaled under
// .uix/screens/<frameId>/ and a final result.json is written for the client.
// =============================================================================

import { type Express } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveProjectRoot, resolveWorkspace, createTerminalEnv, getFlutterRoot, resolveProjectRelativePath } from './runtime';
import { runModel } from './ai-routes';
import { startJobLog, appendJobLog, finishJobLog, subscribeJobLog } from './ai-job-log';
import { captureUrlScreenshot, serveDir } from './visual-routes';
import { isAIModel, type AIModel } from './ai-adapters';
import {
  createRun, getRun, listRuns, updateRunScreen, setRunStatus, setRunSession,
  saveRun, restartRun, appendRunLog, readRunLog,
  markRunCancelled, isRunCancelled, clearRunCancelled,
  isRunActive, markRunActive, clearRunActive,
  clampParallel,
  gateIsActive, pauseAtCheckpoint, approveCheckpoint, setRunResumable,
  addAmendment, resolveAmendment, writeFrameMap,
  type ScreenSpec, type CheckpointGate, type BuildRun, type AmendmentKind,
} from './build-run-store';
import { getProjectsRoot } from './runtime';
import {
  canonicalizeRun, writeCanonical, readCanonical, generateFlutterSkeleton,
  type Canonical, type CanonicalScreen,
} from './canonicalize';
import { computePreflight } from './preflight';

const execFile = promisify(execFileCb);

interface BuildScreenReq {
  projectId: string;
  model: AIModel;
  modelId?: string;
  sessionId?: string;
  framework: string;
  frameId: string;
  frameName: string;
  width?: number;
  height?: number;
  referenceImagePath: string; // project-relative path to the reference render
  implementPrompt: string;    // the client-built agent packet
  tree?: string;              // IR tree notation — snapshotted for cross-session context
  maxIterations?: number;
  jobId?: string;
  runId?: string;             // durable multi-screen run this screen belongs to
  userNotes?: string;         // the human's design rules — shared with verify/fix
  verify?: boolean;           // when false, implement only (no verify↔fix loop)
  // P2 (RFC §4.5): build this screen in a FRESH/stateless session — do NOT seed the
  // implement call with a cross-screen --resume sessionId. Coherence then rides on
  // the server-injected written contract (already baked into implementPrompt), not
  // the shared CLI session. The within-screen fix loop still resumes the session
  // started by THIS screen's implement call (full local context for the fixes).
  freshSession?: boolean;
}

interface Discrepancy { area?: string; issue: string; severity?: string }
// `recommendation` lets the verify agent — not a fixed counter — drive whether
// another fix pass is worthwhile: 'accept' (done / only trivial cosmetic diffs),
// 'fix' (real fixable discrepancies remain), 'stop' (broken or not converging —
// another auto-pass won't help; defer to a human).
type Recommendation = 'accept' | 'fix' | 'stop';
interface Verdict { match: boolean; score?: number; discrepancies: Discrepancy[]; recommendation: Recommendation }

// ── manifest the implement/fix agent writes (.uix/last-gen.json) ──────────────
interface LastGen {
  entry?: string;        // the screen source file
  previewEntry?: string; // a runnable entrypoint that shows JUST this screen
  framework?: string;
  files?: string[];
}

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, '_');

// P2: per-project BUILD mutex. With parallel workers the expensive LLM agent calls
// (implement/verify/fix) run concurrently, but the build+screenshot step writes to
// SHARED, per-project locations (build/web, dist/, .uix/last-gen.json), so two
// builds at once would clobber each other. We serialize ONLY that step per project:
// agents think in parallel, the bundle builds one at a time. (RFC §4.6's build-once/
// hot-swap would remove even this serialization; deferred — see renderPreview TODO.)
// Audit A.2 (FIXED): per-screen previewEntry isolation. The implement agent still
// writes a single shared .uix/last-gen.json, but runScreenLoop now SNAPSHOTS this
// screen's previewEntry right after its own agent call (snapshotLastGen) and feeds
// that snapshot into the build — it no longer re-reads the shared file inside the
// lock, so a sibling worker overwriting last-gen can't make worker A screenshot
// worker B's screen. With that, parallel>1 verifies the right screen. (The mutex
// still dominates wall-time on build-heavy frameworks until RFC §4.6 build-once.)
const buildLocks = new Map<string, Promise<void>>();
async function withBuildLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = buildLocks.get(projectRoot) ?? Promise.resolve();
  // The tail every later caller will chain on: prev finishing AND fn finishing.
  let release!: () => void;
  const done = new Promise<void>(r => { release = r; });
  const tail = prev.then(() => done);
  buildLocks.set(projectRoot, tail);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (buildLocks.get(projectRoot) === tail) buildLocks.delete(projectRoot);
  }
}

// References are exported @2× by the renderer (a 393px frame → 786px PNG). To make
// "match" verdicts trustworthy (RFC §4.6) the candidate MUST be captured at the
// SAME scale and at FULL height (not clipped to the device viewport).
const REF_DEVICE_SCALE = 2;
const CAPTURE_SHOT_OPTS = { deviceScale: REF_DEVICE_SCALE, fullPage: true } as const;

const routeNameFor = (name: string): string =>
  '/' + ((name || 'screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen');

/**
 * The GLOBAL app plan the server injects into EVERY screen's prompt: the complete,
 * fixed screen inventory + route table + navigation graph, plus a hard rule that
 * the agent must wire only to these screens and NEVER invent new ones. This is the
 * fix for "the AI builds its own screens" — each screen is built with the whole
 * app in view, so it registers routes to known screens instead of improvising.
 */
// ── P4 (RFC §4.4): DIGEST PLANNER ────────────────────────────────────────────
// Instead of feeding the planner full IR (≈150K tok for Ping), derive a COMPACT
// structural digest from each screen's already-on-disk IR/packet text — dominant
// colors, fonts, and which shared components recur — and fold that into the app
// plan as a DESIGN-SYSTEM SUMMARY + SHARED-COMPONENT INVENTORY. This is the
// planning signal that was missing (the agent had routes but no shared visual
// vocabulary), produced deterministically (no LLM pass) from cheap digests.
const HEX = /#[0-9a-fA-F]{6}\b/g;
// font hints appear as `font: Inter`, `fontFamily: SF Pro`, `"Inter"` etc.
const FONT_HINT = /(?:font(?:-?family|Family)?\s*[:=]\s*|typeface\s*[:=]\s*)["']?([A-Za-z][A-Za-z0-9 _-]{1,30})/g;
// component-ish node names: capitalized PascalCase tokens / `[component: X]` / Card/Button/etc.
const COMPONENT_HINT = /\b(?:component\s*[:=]\s*)?([A-Z][a-zA-Z]{2,}(?:Button|Card|Bar|Item|Tile|Field|Input|Header|Footer|Nav|List|Row|Avatar|Chip|Badge|Modal|Sheet|Tab|Cell|Icon))\b/g;

function topN<T>(counts: Map<T, number>, n: number): T[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}
function tally(re: RegExp, text: string, into: Map<string, number>, group = 0): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = (group ? m[group] : m[0])?.trim();
    if (key) into.set(key, (into.get(key) ?? 0) + 1);
  }
}

interface DesignDigest { colors: string[]; fonts: string[]; components: Array<{ name: string; screens: number }> }
function buildDesignDigest(run: import('./build-run-store').BuildRun): DesignDigest {
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  // Component recurrence: count DISTINCT screens a component name shows up in (a
  // name in many screens = a real shared component, not a one-off).
  const compScreenCounts = new Map<string, number>();
  for (const s of run.screens) {
    const text = `${s.spec?.tree ?? ''}\n${s.spec?.packet ?? ''}`;
    if (!text.trim()) continue;
    tally(HEX, text, colorCounts);
    tally(FONT_HINT, text, fontCounts, 1);
    const seenHere = new Set<string>();
    COMPONENT_HINT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPONENT_HINT.exec(text))) { const k = m[1]; if (k) seenHere.add(k); }
    for (const k of seenHere) compScreenCounts.set(k, (compScreenCounts.get(k) ?? 0) + 1);
  }
  const components = [...compScreenCounts.entries()]
    .filter(([, n]) => n >= 2)                  // shared = recurs across ≥2 screens
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, screens]) => ({ name, screens }));
  return { colors: topN(colorCounts, 8), fonts: topN(fontCounts, 4), components };
}

/**
 * Build a frameId → canonical route resolver. In canonical mode (RFC §4.2) routes
 * MUST derive from canonical.screens / canonicalId (the single identity axis), NOT
 * the mutable frameName — otherwise the skeleton (canonical routes) and the injected
 * app plan / API surface (frameName routes) disagree and the agent is handed two
 * route schemes (audit A.3). Every member frame (states/modals folded into a lead)
 * resolves to its canonical screen's route. Returns null when not canonical so the
 * legacy frameName scheme is used unchanged.
 */
function canonicalRouteResolver(canonical?: Canonical): ((frameId: string) => string) | null {
  if (!canonical) return null;
  const routeByFrame = new Map<string, string>();
  for (const cs of canonical.screens) {
    for (const fid of cs.frameIds) routeByFrame.set(fid, cs.route);
    for (const st of cs.states) routeByFrame.set(st.frameId, cs.route);
    for (const m of cs.modals) routeByFrame.set(m.frameId, cs.route);
  }
  return (frameId: string) => routeByFrame.get(frameId) ?? routeNameFor(frameId);
}

function buildAppPlan(run: import('./build-run-store').BuildRun, canonical?: Canonical): string {
  const nameById = new Map(run.screens.map(s => [s.frameId, s.frameName]));
  // ONE route scheme: canonical (canonicalId-derived) when canonicalized, else the
  // legacy frameName slug. Keyed on frameId so canonical + legacy agree (audit A.3).
  const canonRoute = canonicalRouteResolver(canonical);
  const routeFor = (frameId: string, frameName: string): string =>
    canonRoute ? canonRoute(frameId) : routeNameFor(frameName);
  const out: string[] = [
    `APP PLAN — the COMPLETE, FIXED set of screens in this app. Wire navigation ONLY to these screens; NEVER create, invent, rename, or stub a screen that is not in this list. If a navigation target is not built yet, route to its route name below — a later step fills it in.`,
  ];
  // P4: design-system summary + shared-component inventory (from compact digests).
  const digest = buildDesignDigest(run);
  if (digest.colors.length || digest.fonts.length) {
    out.push(`DESIGN SYSTEM (derived from the design — REUSE these across every screen; define them ONCE in the theme/token file and import, do not hardcode per screen):`);
    if (digest.colors.length) out.push(`- Palette (most-used colors): ${digest.colors.join(', ')}`);
    if (digest.fonts.length) out.push(`- Typeface(s): ${digest.fonts.join(', ')}`);
  }
  if (digest.components.length) {
    out.push(`SHARED COMPONENT INVENTORY (these recur across multiple screens — build each ONCE as a reusable widget and reuse it; do NOT re-implement per screen):`);
    for (const c of digest.components) out.push(`- ${c.name} (used in ${c.screens} screens)`);
  }
  if (run.flow?.entryFrameId) {
    const en = nameById.get(run.flow.entryFrameId) || run.flow.entryFrameId;
    out.push(`Entry / start screen: "${en}" (route ${routeFor(run.flow.entryFrameId, en)}).`);
  }
  out.push(`Screens (name → route):`);
  for (const s of run.screens) out.push(`- "${s.frameName}" → ${routeFor(s.frameId, s.frameName)}`);
  if (run.flow?.connections?.length) {
    out.push(`Navigation graph (build these transitions, no dead ends):`);
    for (const c of run.flow.connections) {
      const f = nameById.get(c.from) || c.from, t = nameById.get(c.to) || c.to;
      out.push(`- "${f}" --(${c.type}${c.label ? ` "${c.label}"` : ''})--> "${t}"`);
    }
  }
  out.push(`Register ALL these routes in the central router by name (a placeholder/empty screen is fine for ones not built yet). Build ONLY the current screen below; do not implement, overwrite, or duplicate the others.`);
  return out.join('\n');
}

/**
 * P2 (RFC §4.5 — the coherence vehicle): the SERVER reads the agent's written
 * contract (.uix/context.md) and INJECTS it into every screen's prompt. Today the
 * packet only *tells* the agent to read context.md; that breaks the moment the CLI
 * is a cold/fresh session (codex & gemini ALWAYS are, claude is when freshSessions
 * is on) because the file may not be opened, and even when opened it competes with
 * the rest of the prompt for attention. Injecting it server-side guarantees the
 * established design system / routing / screens index is in-context for EVERY
 * screen, model-independently — which is what lets us drop the shared --resume
 * session and still keep visual coherence.
 *
 * Bounded so a runaway context.md can't blow the window (later screens append to it).
 */
const CONTEXT_SLICE_MAX = 12000;
async function readContextSlice(projectRoot: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'context.md'), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return '';
    // Keep the HEAD (design-system + routing live up top, written first) when the
    // file outgrows the budget; the tail is the per-screen index which the app plan
    // already covers.
    return trimmed.length > CONTEXT_SLICE_MAX
      ? trimmed.slice(0, CONTEXT_SLICE_MAX) + '\n…(context.md truncated — open .uix/context.md for the full contract)'
      : trimmed;
  } catch { return ''; }
}

/**
 * P2 (RFC §4.5): a canonical COMPONENT / ROUTE API surface derived deterministically
 * from the run — the signatures each screen must build against. Today this is the
 * route table (canonical names every screen wires to). Until canonicalization (P3)
 * produces real shared-component signatures, the surface is the stable route slugs
 * + the screens index from context.md. Kept as its own block so each screen builds
 * against a SHARED contract instead of re-inventing names per session.
 */
function buildComponentApiSurface(run: import('./build-run-store').BuildRun, canonical?: Canonical): string {
  const out: string[] = [
    `CANONICAL API SURFACE — the shared route/screen names every screen MUST build against (do NOT invent variants of these names; reuse them verbatim so cross-screen navigation resolves):`,
  ];
  // ONE route scheme — canonical routes when canonicalized (audit A.3), else legacy.
  if (canonical) {
    for (const cs of canonical.screens) out.push(`- route ${cs.route}  ⟶  screen "${cs.name}" (canonicalId ${cs.canonicalId})`);
    if (canonical.components.length) {
      for (const c of canonical.components) out.push(`- component ${c.name} (import from lib/components/)`);
    }
  } else {
    for (const s of run.screens) out.push(`- route ${routeNameFor(s.frameName)}  ⟶  screen "${s.frameName}"`);
  }
  // TODO(P2/P3): once canonicalization emits shared-component stubs with real
  // constructor signatures (RFC §4.2 deterministic skeleton), append each
  // component's API here (name + props) so screens import the exact signature
  // instead of re-deriving shared widgets per session.
  return out.join('\n');
}

/**
 * P2: assemble the full WRITTEN CONTRACT block the server injects ahead of a
 * screen's packet — app plan + canonical API surface + the injected context.md
 * slice. This is the model-independent coherence carrier (replaces leaning on the
 * CLI --resume session). `freshSessions` only changes a header note; the contract
 * body is identical so serial-shared-session and fresh-session builds converge on
 * the same design language.
 */
function buildWrittenContract(
  run: import('./build-run-store').BuildRun, appPlan: string, contextSlice: string, freshSession: boolean,
  canonical?: Canonical,
): string {
  const parts: string[] = [appPlan, buildComponentApiSurface(run, canonical)];
  if (contextSlice) {
    parts.push(
      [
        `ESTABLISHED PROJECT CONTRACT (.uix/context.md — written by earlier screens; AUTHORITATIVE for the design system, theme tokens, routing and shared components). REUSE what's here; do NOT redefine tokens/components that already exist, and EXTEND this file as you build:`,
        contextSlice,
      ].join('\n'),
    );
  } else if (freshSession) {
    parts.push(
      `No .uix/context.md exists yet — you are establishing the project contract. Create .uix/context.md (design system, routing, screens index) so every later screen builds against it.`,
    );
  }
  return parts.join('\n\n— — —\n');
}

/**
 * P3 (RFC §4.1/§4.2): the CANONICAL context the server injects when a run is built
 * canonically. For the lead frame of a canonical screen it spells out the screen's
 * states, modals (rendered as overlays over THIS reused base, not standalone
 * pages), template siblings, and its write-locked route slot — so the agent builds
 * one widget with a state param instead of N near-duplicate routes/files.
 */
function buildCanonicalContext(canonical: Canonical, cs: CanonicalScreen): string {
  const out: string[] = [
    `CANONICAL SCREEN — this is ONE screen (canonicalId ${cs.canonicalId}, route ${cs.route}); build a SINGLE widget, not one page per variant. Its write-locked route slot already exists in lib/app_router.dart; fill the widget body, keep the route.`,
  ];
  if (cs.states.length > 1) {
    out.push(`States (one widget + a state param — NOT separate routes; each state is verified individually against its own reference):`);
    for (const s of cs.states) out.push(`- state "${s.id}" (frame ${s.frameId})`);
  }
  if (cs.modals.length) {
    out.push(`Modals/sheets to present OVER this (reused) base screen via showModalBottomSheet / a dialog — do NOT rebuild the base or make these full standalone pages:`);
    for (const m of cs.modals) out.push(`- modal "${m.id}" (frame ${m.frameId})`);
  }
  if (cs.templateRef) {
    const sibs = canonical.templates.find(t => t.id === cs.templateRef)?.memberCanonicalIds.filter(id => id !== cs.canonicalId) ?? [];
    out.push(`This screen shares template "${cs.templateRef}" with ${sibs.length} sibling screen(s) — extract the shared layout into a reusable widget + thin per-screen config.`);
  }
  if (canonical.components.length) {
    out.push(`Shared components available (import from lib/components/ — reuse, don't re-invent): ${canonical.components.map(c => c.name).join(', ')}.`);
  }
  return out.join('\n');
}

// ── P4 (RFC §4.5): IR HYGIENE ────────────────────────────────────────────────
// The agent-facing IR carries dead weight: every asset line has a `[preview:<url>]`
// annotation (a CSS-renderer hint the coding agent never needs — measured as pure
// context cost in the failed Ping run), and lists/grids repeat near-identical
// sibling lines dozens of times. We (1) STRIP the preview annotations and (2)
// RUN-LENGTH-ENCODE consecutive identical sibling lines into `<line>  ×N`. This is
// applied to the IR `tree` and to the IR portion of the packet on the way INTO the
// agent prompt — the on-disk notation is untouched (renderer/UI still use it).
const PREVIEW_ANNOTATION = /\s*\[preview:[^\]]*\]/g;

/** Strip `[preview:<url>]` asset annotations from agent-facing IR text. */
export function stripPreviewAnnotations(ir: string): string {
  return ir ? ir.replace(PREVIEW_ANNOTATION, '') : ir;
}

// The tree uses box-drawing/indent prefixes (│ ├ └ etc.) before the node content.
// Two siblings are "the same" when the content AFTER the leading tree glyphs and
// whitespace is identical — RLE collapses a run of them so a 40-item list isn't 40
// lines. We keep the FIRST occurrence verbatim and append `  ×N`.
const TREE_PREFIX = /^[\s│├└─┬┴┼╰╯╭╮|`+\-]*/;
const stripTreePrefix = (line: string): string => line.replace(TREE_PREFIX, '').trim();

/** Collapse runs of consecutive identical sibling lines into `<line>  ×N`. */
export function rleRepeatedSiblings(ir: string): string {
  if (!ir) return ir;
  const lines = ir.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = stripTreePrefix(lines[i]);
    let n = 1;
    // Only collapse non-trivial content lines (skip blanks / 1-char glyphs).
    if (key.length > 2) {
      while (i + n < lines.length && stripTreePrefix(lines[i + n]) === key) n++;
    }
    out.push(n > 1 ? `${lines[i]}  ×${n}` : lines[i]);
    i += n;
  }
  return out.join('\n');
}

/** Full IR-hygiene pass for agent-facing IR: strip previews + RLE siblings. */
export function hygieneIR(ir: string | undefined): string | undefined {
  if (!ir) return ir;
  return rleRepeatedSiblings(stripPreviewAnnotations(ir));
}

async function readLastGen(projectRoot: string): Promise<LastGen> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'last-gen.json'), 'utf8');
    return JSON.parse(raw) as LastGen;
  } catch { return {}; }
}

// ── prompt builders ───────────────────────────────────────────────────────────

function verifyPrompt(refPath: string, candPath: string, frameName: string, prevScore: number | null, userNotes?: string): string {
  const notes = (userNotes ?? '').trim();
  return [
    `You are a STRICT visual-QA reviewer. Do not write or edit any files.`,
    `Open these two images with your file-reading tool:`,
    `  - REFERENCE (ground truth, the target design): ${refPath}`,
    `  - CANDIDATE (a screenshot of the current build of screen "${frameName}"): ${candPath}`,
    `Compare them carefully: layout & hierarchy, spacing/proportions, colours, typography, text content, icons/illustrations, and overall fidelity.`,
    notes ? `USER RULES / INTENT (authoritative) — respect these when judging; do NOT flag an INTENTIONAL omission as a discrepancy (e.g. if the user said no OS status bar / no default keyboard, then a missing status bar or keyboard is CORRECT, not a discrepancy):\n${notes}` : '',
    prevScore != null ? `The previous pass scored ${prevScore}/100 — judge whether this pass actually improved; if it's no better, another automated fix is unlikely to help (lean towards "stop").` : '',
    `If the reference shows a MODAL / OVERLAY / SHEET / POPUP over a base screen, the candidate should render that overlay ON TOP of the (reused) base screen — flag a discrepancy if the candidate rebuilt the whole screen or rendered the overlay as a standalone full page.`,
    `Respond with ONLY a single JSON object (no prose, no code fences):`,
    `{"match": <true|false>, "score": <0-100>, "recommendation": "accept|fix|stop", "discrepancies": [{"area":"<where>","issue":"<what's wrong vs the reference>","severity":"high|med|low"}]}`,
    `- "match": true ONLY if visually near-identical (no high/med discrepancies).`,
    `- "recommendation": "accept" = good enough, stop now (a match, or only trivial cosmetic diffs); "fix" = real fixable discrepancies remain and another pass is worthwhile; "stop" = broken / way off / clearly NOT converging, so another automated pass won't help — defer to a human.`,
    `List every concrete difference; be specific and actionable.`,
  ].filter(Boolean).join('\n');
}

function fixPrompt(frameName: string, refPath: string, candPath: string, v: Verdict, userNotes?: string): string {
  const items = v.discrepancies.map((d, i) => `  ${i + 1}. [${d.severity ?? 'med'}] ${d.area ? d.area + ': ' : ''}${d.issue}`).join('\n');
  const notes = (userNotes ?? '').trim();
  return [
    `The screen "${frameName}" you built does NOT yet match its reference design (visual score ${v.score ?? '?'} / 100).`,
    `Reference (ground truth): ${refPath}`,
    `Current build screenshot:  ${candPath}`,
    notes ? `USER RULES / INTENT (authoritative — DO NOT violate, even to satisfy a discrepancy below; e.g. do NOT add an OS status bar or default keyboard if the user excluded them):\n${notes}\n` : '',
    `Open BOTH images, then revise the EXISTING screen file(s) to fix these specific discrepancies — but skip any that contradict the user rules above:`,
    items || '  (general fidelity — bring it closer to the reference)',
    `Reuse the project's existing design system / theme / shared components — do not restyle inline.`,
    `Keep the preview entrypoint working and keep .uix/last-gen.json accurate (including "previewEntry"). Output a one-line summary.`,
  ].filter(Boolean).join('\n');
}

// ── parse the verify agent's JSON verdict (robust to fences / stray prose) ─────
function parseVerdict(text: string): Verdict {
  // A broken/unparseable verify result is itself a reason to stop (not to keep
  // burning fix passes blindly), so default recommendation 'stop'.
  const fail = (issue: string): Verdict => ({ match: false, discrepancies: [{ issue, severity: 'high' }], recommendation: 'stop' });
  if (!text) return fail('verify agent produced no output');
  // Grab the largest brace-balanced JSON object in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('verify output had no JSON object');
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const match = !!j.match;
    const discrepancies = Array.isArray(j.discrepancies)
      ? j.discrepancies.map((d: any) => ({ area: d?.area, issue: String(d?.issue ?? d ?? 'unspecified'), severity: d?.severity }))
      : [];
    const rec: Recommendation = j.recommendation === 'accept' || j.recommendation === 'fix' || j.recommendation === 'stop'
      ? j.recommendation
      : (match ? 'accept' : (discrepancies.length ? 'fix' : 'accept'));
    return { match, score: typeof j.score === 'number' ? j.score : undefined, discrepancies, recommendation: rec };
  } catch { return fail('verify output JSON was malformed'); }
}

// ── render the preview entrypoint of the REAL project to a PNG ────────────────
// Builds the screen's standalone entrypoint within the actual project (real
// theme/fonts/router) and screenshots it. Returns the PNG or a build-error tail.
// TODO(P1): build-once/hot-swap. RFC §4.6 wants ONE bundle build per run with the
// preview entrypoint hot-swapped per iteration, instead of a full release build
// every verify pass (up to 6×N builds at N=100). The trustworthy-verify half of
// §4.6 (same-scale + full-height capture) ships here now; the build-once half is
// deferred because it needs a persistent dev server / incremental compiler held
// across iterations (flutter run -d web-server / vite dev + entry swap), which is
// a larger, separate change. Each iteration still does a fresh release build.
async function renderPreview(
  projectRoot: string, framework: string, previewEntry: string | undefined,
  width: number, height: number, env: NodeJS.ProcessEnv,
  shot: { deviceScale?: number; fullPage?: boolean } = {},
): Promise<{ png?: Buffer; error?: string }> {
  const fw = framework.toLowerCase();
  try {
    if (fw === 'flutter') {
      const flutter = path.join(getFlutterRoot(), 'bin', 'flutter');
      if (!fsSync.existsSync(flutter)) return { error: 'Flutter SDK not available' };
      if (!fsSync.existsSync(path.join(projectRoot, 'web'))) {
        await execFile(flutter, ['create', '--platforms=web', '.'], { cwd: projectRoot, env, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      }
      const target = previewEntry && fsSync.existsSync(path.join(projectRoot, previewEntry)) ? previewEntry : 'lib/main.dart';
      const args = ['build', 'web', '--release', '-t', target];
      try {
        await execFile(flutter, args, { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
      } catch (e: any) {
        return { error: `flutter build web failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
      }
      const webDir = path.join(projectRoot, 'build', 'web');
      if (!fsSync.existsSync(path.join(webDir, 'index.html'))) return { error: 'flutter build produced no web output' };
      const srv = await serveDir(webDir);
      try {
        const png = await captureUrlScreenshot(srv.url, width, height, 60000, shot);
        return png ? { png } : { error: 'screenshot of built Flutter app failed' };
      } finally { srv.close(); }
    }

    // Web (Vite/React/Next static export). Best-effort: build, serve the output
    // dir, navigate to the preview route if one was provided.
    try {
      await execFile('npm', ['run', 'build'], { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
    } catch (e: any) {
      return { error: `web build (npm run build) failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
    }
    const outDir = ['dist', 'out', 'build'].map(d => path.join(projectRoot, d)).find(d => fsSync.existsSync(path.join(d, 'index.html')));
    if (!outDir) return { error: 'web build produced no servable output (dist/ out/ build/)' };
    const srv = await serveDir(outDir);
    try {
      const route = previewEntry && previewEntry.startsWith('/') ? previewEntry : '';
      const url = route ? `${srv.url.replace(/\/index\.html$/, '')}${route}` : srv.url;
      const png = await captureUrlScreenshot(url, width, height, 60000, shot);
      return png ? { png } : { error: 'screenshot of built web app failed' };
    } finally { srv.close(); }
  } catch (e: any) {
    return { error: e?.message || 'preview render failed' };
  }
}

// ── the loop ──────────────────────────────────────────────────────────────────
async function runScreenLoop(req: BuildScreenReq, projectRoot: string, jobId: string): Promise<string | undefined> {
  const { model, modelId, framework, frameId, frameName, referenceImagePath, implementPrompt } = req;
  const width = req.width || 393, height = req.height || 852;
  // maxIterations is a SAFETY BACKSTOP, not the policy: the verify agent's
  // recommendation + score-plateau detection decide when to actually stop, so a
  // screen that matches on pass 1 costs 1 pass, not N.
  const maxIterations = Math.min(Math.max(req.maxIterations ?? 4, 1), 6);
  // Build the env from the WORKSPACE root (like /api/ai/generate), NOT the
  // project: createTerminalEnv sets HOME to its arg, and the claude/gemini CLIs
  // read their login from $HOME/.claude (etc.). Rooting it at the project made
  // the spawned agent look for credentials in <project>/.claude → "claude error
  // login", and mis-rooted every tool path (Flutter/npm/mise). The project is
  // the cwd of each runModel/build call, passed separately.
  const env = createTerminalEnv(resolveWorkspace());
  const screenDir = path.join(projectRoot, '.uix', 'screens', sanitizeId(frameId));
  await fs.mkdir(screenDir, { recursive: true });
  const relScreenDir = path.join('.uix', 'screens', sanitizeId(frameId));
  // Snapshot the IR tree so a future session has this screen's design context
  // (exact colours/text/layout) without re-fetching from the design source.
  if (req.tree) { try { await fs.writeFile(path.join(screenDir, 'ir.txt'), req.tree); } catch { /* non-fatal */ } }
  if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'building' }); } catch { /* non-fatal */ } }

  // In freshSession mode the implement call starts COLD (no cross-screen resume);
  // the contract injected into the prompt carries coherence. The fix loop below
  // still resumes whatever session THIS implement call returns.
  let session = req.freshSession ? undefined : req.sessionId;
  let finalVerdict: Verdict | null = null;
  let matched = false;
  let accepted = false;
  let stopReason = 'reached iteration cap';
  let iterationsRun = 0;
  let prevScore: number | null = null;
  let lastCandRel: string | null = null;   // newest candidate screenshot (for review)

  // P2/P3 (audit A.2): PER-SCREEN previewEntry isolation. Parallel workers share one
  // .uix/last-gen.json; the build mutex serialized the build+screenshot but a sibling
  // worker could overwrite previewEntry between THIS screen's implement and its verify
  // build → worker A would screenshot worker B's screen. We snapshot THIS screen's
  // previewEntry/framework right after its OWN agent call returns (when last-gen still
  // reflects this screen) and pass that snapshot into the build — never re-reading the
  // shared file inside the lock. So parallel>1 verifies the right screen.
  let screenPreviewEntry: string | undefined;
  let screenFramework = framework;
  const snapshotLastGen = async (): Promise<void> => {
    const lastGen = await readLastGen(projectRoot);
    // Only adopt a previewEntry that exists on disk for THIS screen (a stale/sibling
    // entry is rejected so we don't capture the wrong screen). Falls back to the
    // previous snapshot (or main.dart in renderPreview) when absent.
    if (lastGen.previewEntry && fsSync.existsSync(path.join(projectRoot, lastGen.previewEntry))) {
      screenPreviewEntry = lastGen.previewEntry;
    }
    if (lastGen.framework) screenFramework = lastGen.framework;
  };

  // 1. IMPLEMENT
  appendJobLog(jobId, `[loop] implement: "${frameName}"`);
  const impl = await runModel(model, implementPrompt, env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
  if (impl.sessionId) session = impl.sessionId;
  await snapshotLastGen();   // capture this screen's previewEntry before any sibling can clobber it

  // verify:false (or no reference render to compare against) → implement-only.
  // Write a result and mark the screen done so the run still completes.
  if (req.verify === false || !referenceImagePath) {
    const result = {
      frameId, frameName, framework, matched: false, accepted: true,
      stopReason: 'verify disabled — implemented only', iterations: 1, maxIterations,
      finalVerdict: null, sessionId: session, referenceImage: referenceImagePath,
      ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined, at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
    if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched: false, sessionId: session }); } catch { /* non-fatal */ } }
    finishJobLog(jobId, `[loop] done: "${frameName}" implemented (verify off)`);
    return session;
  }

  // 2/3. VERIFY ↔ FIX — the verify agent's recommendation + score plateau drive
  // when to stop; maxIterations is only a runaway backstop.
  for (let iter = 1; iter <= maxIterations; iter++) {
    iterationsRun = iter;
    appendJobLog(jobId, `[loop] verify ${iter}/${maxIterations}: building & screenshotting`);
    // Build + screenshot under the per-project build lock so a sibling parallel
    // worker can't clobber build/web mid-build. (No-op for serial runs.) Audit A.2:
    // use THIS screen's snapshotted previewEntry/framework (captured right after its
    // own agent call) — NOT a fresh read of the shared last-gen.json, which a sibling
    // worker may have overwritten with a different screen between our agent + build.
    const shot = await withBuildLock(projectRoot, () =>
      renderPreview(projectRoot, screenFramework, screenPreviewEntry, width, height, env, CAPTURE_SHOT_OPTS),
    );

    let verdict: Verdict;
    let candRel: string | null = null;
    if (shot.error || !shot.png) {
      // A failed build IS a failure to fix — feed the compiler error back (and
      // keep fixing: a build error is exactly what another pass should repair).
      verdict = { match: false, score: 0, discrepancies: [{ area: 'build', issue: shot.error || 'the screen failed to build/screenshot', severity: 'high' }], recommendation: 'fix' };
      appendJobLog(jobId, `[loop] verify ${iter}: build/screenshot failed`);
    } else {
      const candAbs = path.join(screenDir, `cand-${iter}.png`);
      await fs.writeFile(candAbs, shot.png);
      candRel = path.join(relScreenDir, `cand-${iter}.png`);
      lastCandRel = candRel;
      appendJobLog(jobId, `[loop] verify ${iter}: comparing to reference`);
      const v = await runModel(model, verifyPrompt(referenceImagePath, candRel, frameName, prevScore, req.userNotes), env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
      verdict = parseVerdict(v.text);
    }
    finalVerdict = verdict;
    await fs.writeFile(path.join(screenDir, `iter-${iter}.json`), JSON.stringify({ iter, verdict, candidate: candRel, at: new Date().toISOString() }, null, 2));
    appendJobLog(jobId, `[loop] verify ${iter}: match=${verdict.match} score=${verdict.score ?? '?'} rec=${verdict.recommendation} issues=${verdict.discrepancies.length}`);

    // STOP CONDITIONS (verify-agent driven, not a fixed count):
    if (verdict.match || verdict.recommendation === 'accept') {
      matched = verdict.match; accepted = true; stopReason = verdict.match ? 'matched the reference' : 'verify agent accepted (good enough)';
      break;
    }
    if (verdict.recommendation === 'stop') { stopReason = 'verify agent said stop (broken / not converging)'; break; }
    // Plateau guard: after a real attempt, if the score didn't improve, more
    // automated passes are unlikely to help — stop rather than waste calls.
    const score = verdict.score ?? 0;
    if (iter >= 2 && prevScore != null && score <= prevScore) { stopReason = `score plateaued (${prevScore}→${score})`; break; }
    prevScore = score;
    if (iter === maxIterations) break;

    // FIX (resume the implementation session so the agent keeps full context).
    appendJobLog(jobId, `[loop] fix ${iter}: applying ${verdict.discrepancies.length} change(s)`);
    const fix = await runModel(model, fixPrompt(frameName, referenceImagePath, candRel ?? '(build failed — no screenshot)', verdict, req.userNotes), env, projectRoot, { agent: true, modelId, sessionId: session, jobId, projectId: req.projectId });
    if (fix.sessionId) session = fix.sessionId;
    await snapshotLastGen();   // re-capture in case the fix moved/renamed the previewEntry (audit A.2)
  }

  const result = {
    frameId, frameName, framework, matched, accepted, stopReason,
    iterations: iterationsRun, maxIterations,
    finalVerdict, sessionId: session,
    referenceImage: referenceImagePath,
    candidateImage: lastCandRel ?? undefined,
    ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined,
    at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
  // RFC §4.7: `done` requires a TRUSTWORTHY visual match. A screen that only the
  // automated verify "accepted" (not matched), plateaued, was stopped, or hit the
  // cap is NOT shipped silently — it goes to the needs-review queue for a human to
  // Accept as-is or Corrected-retry. Only matched:true is marked 'done' here.
  if (req.runId) {
    try {
      if (matched) {
        await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched: true, sessionId: session, review: undefined });
      } else {
        await updateRunScreen(req.projectId, req.runId, frameId, {
          status: 'needs-review', matched: false, sessionId: session,
          review: {
            candidateImagePath: lastCandRel ?? undefined,
            referenceImagePath,
            score: finalVerdict?.score,
            reason: stopReason,
            discrepancies: finalVerdict?.discrepancies,
          },
        });
      }
    } catch { /* non-fatal */ }
  }
  finishJobLog(jobId, `[loop] done: "${frameName}" ${matched ? 'MATCHED' : 'needs review'} after ${iterationsRun} iteration(s) — ${stopReason}`);
  return session;
}

// ── server-orchestrated full-app build ─────────────────────────────────────────
// Builds every screen in a durable run SERVER-SIDE. Survives the browser tab
// closing; resumable after Stop / rate-limit / redeploy (already-done screens are
// skipped). Every job-log line for the run's screens is teed to the durable run
// log so the client can replay the full history on reconnect.
//
// Two coherence vehicles (RFC §4.5):
//   • DEFAULT — one shared CLI --resume session threaded screen→screen (serial).
//   • freshSessions — each screen builds COLD against the server-injected WRITTEN
//     CONTRACT (app plan + canonical API surface + .uix/context.md slice). No
//     shared session → identical on claude/codex/gemini, bounded context, and
//     parallelizable: with `parallel>1` a bounded worker pool builds N screens at
//     once. (A shared --resume session can't be parallelized, so parallel implies
//     fresh sessions.)

/** Build ONE screen of a run server-side, injecting the written contract. Shared
 *  by the serial and parallel paths. `sharedSession` is the threaded session for
 *  serial/non-fresh runs (undefined in fresh-session mode). Returns the session
 *  the screen ended on (so serial mode can thread it forward). */
async function buildRunScreen(
  run: import('./build-run-store').BuildRun, screen: import('./build-run-store').RunScreen,
  projectRoot: string, appPlan: string, sharedSession: string | undefined,
  canonicalCtx?: { canonical: Canonical; screen: CanonicalScreen },
): Promise<string | undefined> {
  // ONE route scheme: when canonicalized, the API surface in the written contract
  // derives from canonical.screens (audit A.3) — same as the appPlan caller built.
  const canonical = canonicalCtx?.canonical;
  const { projectId, id: runId } = run;
  const fresh = run.freshSessions === true;
  if (!screen.spec) {
    await appendRunLog(projectId, runId, `[run] skip "${screen.frameName}" — no build spec`);
    // A failed screen must NOT let the run report 'done' (audit A.1). Attach a
    // review payload so it surfaces in the needs-review queue (Accept / restart).
    await updateRunScreen(projectId, runId, screen.frameId, {
      status: 'failed', review: { reason: 'no build spec — screen was not built' },
    });
    return sharedSession;
  }
  const jobId = `${runId}:${screen.frameId}`;
  startJobLog(jobId, { projectId, firstLine: `[loop] queued "${screen.frameName}"` });
  // Read the written contract FRESH per screen — earlier screens append to
  // .uix/context.md, so each screen sees the latest established tokens/components.
  const contextSlice = await readContextSlice(projectRoot);
  let contract = buildWrittenContract(run, appPlan, contextSlice, fresh, canonical);
  // P3: when this is a canonical lead frame, prepend its states/modals/template +
  // route-slot context so the agent builds ONE widget instead of per-variant pages.
  if (canonicalCtx) contract = `${buildCanonicalContext(canonicalCtx.canonical, canonicalCtx.screen)}\n\n— — —\n${contract}`;
  // P4: strip [preview:…] + RLE repeated siblings from the agent-facing IR.
  const cleanPacket = hygieneIR(screen.spec.packet) ?? screen.spec.packet;
  const sreq: BuildScreenReq = {
    projectId, model: run.model as AIModel, modelId: run.modelId, sessionId: sharedSession,
    framework: run.framework || 'flutter', frameId: screen.frameId, frameName: screen.frameName,
    width: screen.spec.width, height: screen.spec.height,
    referenceImagePath: screen.spec.referenceImagePath,
    implementPrompt: `${contract}\n\n— — —\nNOW BUILD THIS SCREEN:\n${cleanPacket}`,
    tree: hygieneIR(screen.spec.tree), maxIterations: run.maxIterations, jobId, runId,
    userNotes: run.userNotes, verify: run.verify, freshSession: fresh,
  };
  try {
    return await runScreenLoop(sreq, projectRoot, jobId);
  } catch (e: any) {
    appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
    finishJobLog(jobId, '[loop] failed');
    // Surface the failure in the needs-review queue so the run can't report 'done'
    // around an errored screen (audit A.1) and a human can Corrected-retry / restart.
    await updateRunScreen(projectId, runId, screen.frameId, {
      status: 'failed', review: { reason: `build error: ${e?.message || 'unknown'}` },
    });
    return sharedSession;
  }
}

// P5 (RFC §5): pause the run at a HITL gate if it's enabled + not yet cleared.
// Returns true when the orchestrator should STOP (the run is now parked awaiting a
// human approval); false to proceed. No-op (returns false) when the gate is off.
async function gate(run: BuildRun, gateName: CheckpointGate, message: string): Promise<boolean> {
  if (!gateIsActive(run, gateName)) return false;
  await appendRunLog(run.projectId, run.id, `[hitl] checkpoint "${gateName}" — paused for approval: ${message}`);
  await pauseAtCheckpoint(run.projectId, run.id, gateName, message);
  return true;
}

async function runAppLoop(projectId: string, runId: string): Promise<void> {
  if (isRunActive(runId)) return;          // already orchestrating in this process
  markRunActive(runId);
  clearRunCancelled(runId);
  // Audit A.4 (RFC §4.9): an ACTIVELY-orchestrating run must survive a redeploy —
  // a container restart mid-build (the common interruption) leaves the run 'running',
  // and resumeInterruptedRuns picks it back up at boot. So mark it resumable WHILE it
  // orchestrates (a live build is, by definition, resumable). It is flipped back to
  // NOT-resumable only on terminal completion, and a user Stop moves it to 'stopped'
  // (which the boot scan excludes), so the only thing auto-resumed is a build that was
  // genuinely interrupted while running — never a user-stopped or completed run.
  void setRunResumable(projectId, runId, true);
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { clearRunActive(runId); return; }

  // Tee every screen job's log line to the run's durable, replayable log.
  const unsub = subscribeJobLog((e) => {
    if (e.kind !== 'line' || !e.line || !e.jobKey.startsWith(`${runId}:`)) return;
    void appendRunLog(projectId, runId, e.line);
  });

  try {
    const run = await getRun(projectId, runId);
    if (!run) return;
    // The global app plan (screen inventory + routes + nav graph + "never invent
    // screens" rule) — prepended to every screen's prompt so the flow shapes the
    // whole build, not just per-screen nav lines. In canonical mode the route scheme
    // derives from canonical.screens (audit A.3), so the plan is rebuilt below once
    // the pre-pass has produced `canonical` — one route scheme, never two.
    let appPlan = buildAppPlan(run);

    // ── P3: canonicalization pre-pass (RFC §4.1/§4.2) ────────────────────────
    // Cluster frames → canonical screens, rewrite the flow, write canonical.json,
    // and generate the write-locked skeleton. The build then iterates ONLY the
    // canonical LEAD frames (states/modals fold into their lead screen); the
    // non-lead frames are marked done so the run can complete. Behind run.canonical
    // → existing one-frame-per-screen behavior is untouched when the flag is off.
    let canonical: Canonical | undefined;
    const canonByLeadFrame = new Map<string, CanonicalScreen>();   // leadFrameId → canonical screen
    const leadFrameIds = new Set<string>();
    if (run.canonical) {
      try {
        canonical = canonicalizeRun(run.screens, run.flow);
        await writeCanonical(projectRoot, runId, canonical);
        // P5 (RFC §4.2/§4.9): persist frame-map.json — the SINGLE identity axis
        // (frameId → canonicalId). All durability + route derivation key on this.
        await writeFrameMap(projectId, runId, canonical.frameMap);
        // Generate the deterministic skeleton (Flutter only for now; other
        // frameworks still get canonical.json + the manifest, no router file).
        if ((run.framework || 'flutter').toLowerCase() === 'flutter') {
          try {
            const sk = await generateFlutterSkeleton(projectRoot, canonical);
            await appendRunLog(projectId, runId, `[canon] skeleton: ${sk.files.length} file(s), ${sk.routes.length} route(s)`);
          } catch (e: any) {
            await appendRunLog(projectId, runId, `[canon] skeleton generation failed (continuing): ${e?.message || 'unknown'}`);
          }
        }
        // A canonical screen's LEAD frame = its first state's frame. Only leads are
        // built; their states/modals are handled within that single build.
        const memberToLead = new Map<string, string>();   // any member frameId → lead frameId
        for (const cs of canonical.screens) {
          const lead = cs.states[0]?.frameId ?? cs.frameIds[0];
          if (!lead) continue;
          leadFrameIds.add(lead);
          canonByLeadFrame.set(lead, cs);
          for (const fid of cs.frameIds) memberToLead.set(fid, lead);
          for (const m of cs.modals) memberToLead.set(m.frameId, lead);
        }
        // Mark every NON-lead member (extra states, bound modals, components) done
        // up-front so the run completes — they're built inside their lead screen.
        let folded = 0;
        for (const s of run.screens) {
          if (memberToLead.has(s.frameId) && !leadFrameIds.has(s.frameId) && s.status !== 'done') {
            await updateRunScreen(projectId, runId, s.frameId, { status: 'done', matched: true });
            folded++;
          }
        }
        await appendRunLog(projectId, runId, `[canon] ${run.screens.length} frame(s) → ${canonical.screens.length} canonical screen(s), ${canonical.components.length} component(s)${folded ? `, ${folded} folded state/modal frame(s)` : ''}${canonical.warnings.length ? ` — ${canonical.warnings.length} warning(s)` : ''}`);
        for (const w of canonical.warnings) await appendRunLog(projectId, runId, `[canon] WARNING: ${w}`);
      } catch (e: any) {
        canonical = undefined;
        await appendRunLog(projectId, runId, `[canon] canonicalization failed (falling back to per-frame build): ${e?.message || 'unknown'}`);
      }
    }
    // Audit A.3: once canonicalized, rebuild the app plan so its route scheme derives
    // from canonical.screens / canonicalId — matching the generated skeleton + the
    // injected API surface. Without this the agent sees frameName routes in the plan
    // but canonical routes in the skeleton (two divergent schemes).
    if (canonical) appPlan = buildAppPlan(run, canonical);

    // When canonicalized, only the lead frames are buildable targets.
    const isBuildTarget = (frameId: string): boolean => !canonical || leadFrameIds.has(frameId);
    const canonCtxFor = (frameId: string) => {
      const cs = canonByLeadFrame.get(frameId);
      return canonical && cs ? { canonical, screen: cs } : undefined;
    };

    // ── HITL Checkpoint 0 (RFC §5): after canonicalization/flow ──────────────────
    // Re-read the run so the gate sees the latest approvedGates (set by an approve
    // that resumed this loop). If a gate fires the loop returns; approve resumes it.
    {
      const live = await getRun(projectId, runId) ?? run;
      const flowMsg = `${canonical ? `${canonical.screens.length} canonical screen(s)` : `${run.screens.length} frame(s)`}, ${run.flow?.connections?.length ?? 0} nav link(s)${run.flow?.connections?.length ? '' : ' — NO navigation graph; set entry + nav'}`;
      if (await gate(live, 'flow', flowMsg)) return;
    }
    // ── HITL Checkpoint 1 (RFC §5): after plan + pre-flight ──────────────────────
    {
      const live = await getRun(projectId, runId) ?? run;
      if (await gate(live, 'plan', `approve ${run.screens.length} route(s)/screen(s) + token/cost pre-flight`)) return;
    }

    // P2: a parallel pool only makes sense with fresh sessions (a shared --resume
    // session can't be used by two workers at once), so it forces freshSessions.
    const workers = run.freshSessions ? clampParallel(run.parallel ?? 1) : 1;
    await appendRunLog(projectId, runId, `[run] start — ${run.screens.length} screen(s)${canonical ? ` (${leadFrameIds.size} canonical)` : ''}, model=${run.model}, verify=${run.verify !== false}, flow=${run.flow?.connections?.length ?? 0} link(s), sessions=${run.freshSessions ? 'fresh-per-screen' : 'shared'}, workers=${workers}`);

    const stillNeeded = async (frameId: string): Promise<boolean> => {
      const live = await getRun(projectId, runId);
      const cur = live?.screens.find(s => s.frameId === frameId);
      return cur?.status !== 'done';   // skip already-built (resume)
    };

    if (workers > 1) {
      // ── Bounded parallel worker pool (fresh sessions only) ──────────────────
      // A shared work queue drained by `workers` concurrent builders. No session
      // threading (each screen is cold against the written contract), so order
      // only affects which screens see the most-extended context.md, not output.
      const queue = run.screens.filter(s => isBuildTarget(s.frameId));   // P3: leads only when canonical
      let cancelled = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (isRunCancelled(runId)) { cancelled = true; return; }
          const screen = queue.shift();
          if (!screen) return;
          if (!(await stillNeeded(screen.frameId))) continue;
          await buildRunScreen(run, screen, projectRoot, appPlan, undefined, canonCtxFor(screen.frameId));
        }
      };
      await Promise.all(Array.from({ length: workers }, () => worker()));
      if (cancelled || isRunCancelled(runId)) {
        await appendRunLog(projectId, runId, '[run] stopped by user');
        await setRunStatus(projectId, runId, 'stopped');
        return;
      }
    } else {
      // ── Serial (shared session by default, or fresh-serial) ─────────────────
      let session = run.freshSessions ? undefined : run.sessionId;
      // P5: rolling-review cadence (RFC §5 Checkpoint 3) — pause every N built screens.
      const ROLLING_EVERY = 5;
      let builtSinceGate = 0;
      let screensBuilt = 0;
      for (const screen of run.screens) {
        if (isRunCancelled(runId)) {
          await appendRunLog(projectId, runId, '[run] stopped by user');
          await setRunStatus(projectId, runId, 'stopped');
          return;
        }
        if (!isBuildTarget(screen.frameId)) continue;   // P3: non-lead frame folded into its canonical lead
        // Skip screens already built (resume): re-read live status each time.
        const live = await getRun(projectId, runId);
        const cur = live?.screens.find(s => s.frameId === screen.frameId);
        if (cur?.status === 'done') { session = run.freshSessions ? undefined : (cur.sessionId || session); continue; }
        const sess = await buildRunScreen(run, screen, projectRoot, appPlan, session, canonCtxFor(screen.frameId));
        // In fresh-session mode there is no cross-screen thread to carry forward.
        if (sess && !run.freshSessions) { session = sess; await setRunSession(projectId, runId, session); }
        screensBuilt++; builtSinceGate++;

        // ── HITL Checkpoint 2 (RFC §5): after the FIRST screen — freeze the visual
        // language (design system + screen-1 reference build) before scaling.
        if (screensBuilt === 1) {
          const l2 = await getRun(projectId, runId) ?? run;
          if (await gate(l2, 'design-system', 'review the design system + screen-1 reference build before scaling')) return;
        }
        // ── HITL Checkpoint 3 (RFC §5): rolling review every N screens. ──────────
        if (builtSinceGate >= ROLLING_EVERY) {
          builtSinceGate = 0;
          const l3 = await getRun(projectId, runId) ?? run;
          if (await gate(l3, 'rolling', `rolling review — ${screensBuilt} screen(s) built so far`)) return;
        }
      }
    }

    if (isRunCancelled(runId)) {
      await appendRunLog(projectId, runId, '[run] stopped by user');
      await setRunStatus(projectId, runId, 'stopped');
      return;
    }
    const done = await getRun(projectId, runId);
    const total = done?.screens.length ?? 0;
    const built = done?.screens.filter(s => s.status === 'done').length ?? 0;
    const needsReview = done?.screens.filter(s => s.status === 'needs-review').length ?? 0;
    // Audit A.1: a 'failed' screen ALSO blocks completion (never silently ship a run
    // with an errored screen). Both needs-review and failed hold the run open.
    const failed = done?.screens.filter(s => s.status === 'failed').length ?? 0;
    const blocking = needsReview + failed;
    // ── HITL Checkpoint 4 (RFC §5): before global wiring / full build / deploy ────
    // Only gate here when the queue is clear (a blocking screen parks the run for
    // review below — the pre-global gate is the human sign-off once it's clean).
    if (blocking === 0 && done) {
      if (await gate(done, 'pre-global', `pre-global sign-off — ${built}/${total} built, needs-review 0`)) return;
    }
    // RFC §4.7 + audit A.1: a run does NOT report complete while any screen is
    // needs-review OR failed — it parks in 'needs-review' until a human Accepts /
    // Corrected-retries / restarts every queued or errored screen.
    if (blocking > 0) {
      await setRunStatus(projectId, runId, 'needs-review');
      await appendRunLog(projectId, runId, `[run] paused for review — ${built}/${total} matched, ${needsReview} need review${failed ? `, ${failed} failed` : ''}`);
    } else {
      // Terminal completion: clear the resumable flag so a finished run is never
      // re-launched on a later boot (audit A.4).
      await setRunResumable(projectId, runId, false);
      await setRunStatus(projectId, runId, 'done');
      await appendRunLog(projectId, runId, `[run] complete — ${built}/${total} built`);
    }
  } catch (e: any) {
    await appendRunLog(projectId, runId, `[run] error: ${e?.message || 'unknown'}`);
  } finally {
    unsub();
    clearRunActive(runId);
    clearRunCancelled(runId);
  }
}

// ── Needs-review: human Corrected-retry (RFC §4.7) ─────────────────────────────
// Re-build ONE needs-review screen with a concrete human correction note injected
// into a fresh fix pass (the automated 3-pass loop already failed, so the human's
// input is what's new). Runs server-side like the main loop; survives tab close.
async function retryScreenLoop(projectId: string, runId: string, frameId: string, note: string): Promise<void> {
  const jobKey = `${runId}:${frameId}`;
  if (isRunActive(jobKey)) return;
  markRunActive(jobKey);
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { clearRunActive(jobKey); return; }
  const unsub = subscribeJobLog((e) => {
    if (e.kind !== 'line' || !e.line || !e.jobKey.startsWith(`${runId}:`)) return;
    void appendRunLog(projectId, runId, e.line);
  });
  try {
    const run = await getRun(projectId, runId);
    const screen = run?.screens.find(s => s.frameId === frameId);
    if (!run || !screen || !screen.spec) {
      await appendRunLog(projectId, runId, `[review] retry skipped "${frameId}" — no build spec`);
      return;
    }
    await updateRunScreen(projectId, runId, frameId, { status: 'building' });
    // Audit A.3: reuse the canonical route scheme on a corrected-retry too (one
    // scheme), reading the persisted canonical.json when the run was canonicalized.
    const canonical = run.canonical ? (await readCanonical(projectRoot, runId)) ?? undefined : undefined;
    const appPlan = buildAppPlan(run, canonical);
    // P2: inject the same written contract (app plan + API surface + context.md) so a
    // corrected-retry builds against the established design system, not in a vacuum.
    const contextSlice = await readContextSlice(projectRoot);
    const contract = buildWrittenContract(run, appPlan, contextSlice, run.freshSessions === true, canonical);
    // The human correction is authoritative and injected up-front so the fresh pass
    // acts on it (the previous automated discrepancies didn't converge).
    const correction = `HUMAN CORRECTION (authoritative — the automated loop did NOT converge; apply this specific guidance):\n${note}`;
    const startJobId = jobKey;
    startJobLog(startJobId, { projectId, firstLine: `[loop] corrected-retry "${screen.frameName}"` });
    await appendRunLog(projectId, runId, `[review] corrected-retry "${screen.frameName}": ${note.replace(/\s+/g, ' ').trim()}`);
    const sreq: BuildScreenReq = {
      projectId, model: run.model as AIModel, modelId: run.modelId, sessionId: screen.sessionId || run.sessionId,
      framework: run.framework || 'flutter', frameId, frameName: screen.frameName,
      width: screen.spec.width, height: screen.spec.height,
      referenceImagePath: screen.spec.referenceImagePath,
      implementPrompt: `${contract}\n\n— — —\n${correction}\n\n— — —\nNOW REVISE THIS SCREEN:\n${hygieneIR(screen.spec.packet) ?? screen.spec.packet}`,
      tree: hygieneIR(screen.spec.tree), maxIterations: run.maxIterations, jobId: startJobId, runId,
      userNotes: [run.userNotes?.trim(), note.trim()].filter(Boolean).join('\n\n'), verify: run.verify,
    };
    try {
      const sess = await runScreenLoop(sreq, projectRoot, startJobId);
      if (sess) await setRunSession(projectId, runId, sess);
    } catch (e: any) {
      appendJobLog(startJobId, `[loop] error: ${e?.message || 'unknown'}`);
      finishJobLog(startJobId, '[loop] failed');
      await updateRunScreen(projectId, runId, frameId, { status: 'needs-review' });
    }
    // Re-derive the run status: if this was the last needs-review screen and it now
    // matched, deriveStatus (via updateRunScreen) already flipped the run to 'done'.
  } finally {
    unsub();
    clearRunActive(jobKey);
  }
}

/**
 * Re-start runs that were GRACEFULLY PAUSED when the process died (e.g. a redeploy).
 * Called once on server boot so a full-app build survives a container restart.
 *
 * P5 (RFC §4.9): no auto-resurrect of crashed / stopped runs. Only a run with the
 * explicit `resumable:true` graceful-pause flag is restarted — a run that was
 * 'running' (mid-screen) when the box died is left alone (its in-flight state is
 * untrustworthy) and a human restarts it from the Runs UI. This kills the old
 * behavior where any 'running' run was blindly re-launched on every redeploy.
 */
export async function resumeInterruptedRuns(): Promise<void> {
  try {
    const root = getProjectsRoot();
    if (!fsSync.existsSync(root)) return;
    const projectIds = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    for (const projectId of projectIds) {
      const runs = await listRuns(projectId, 50);
      for (const r of runs) {
        // Audit A.4 (RFC §4.9): auto-resume ONLY a run that was actively orchestrating
        // (status 'running') and is flagged resumable — i.e. a build interrupted by a
        // redeploy/restart. This restores the "survives redeploy" guarantee for the
        // common case. A 'stopped' run (user-stopped or stopped after a crash) and an
        // 'awaiting-approval' run (parked at a HITL gate) are NOT auto-resurrected — a
        // human restarts / approves those from the Runs UI. 'done'/'needs-review' runs
        // are terminal-for-orchestration and likewise left alone.
        const resumable = r.resumable === true && r.status === 'running';
        if (resumable && !isRunActive(r.id)) {
          void appendRunLog(projectId, r.id, '[run] resuming interrupted run after server restart (redeploy)');
          void runAppLoop(projectId, r.id);
        }
      }
    }
  } catch { /* boot resume is best-effort */ }
}

/**
 * P5 (RFC §4.8): regenerate the write-locked skeleton after an approved amendment
 * bumps the plan version. Reuses the persisted canonical.json (the skeleton
 * generator is additive — it never clobbers a built screen file, only fills in the
 * router/route-table + missing stubs), so downstream screens see plan v+1. Flutter
 * only for now (matches generateFlutterSkeleton's scope). Best-effort + logged.
 */
async function regenSkeletonForRun(projectId: string, run: BuildRun): Promise<void> {
  if (!run.canonical || (run.framework || 'flutter').toLowerCase() !== 'flutter') return;
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) return;
  try {
    const canonical = (await readCanonical(projectRoot, run.id)) ?? canonicalizeRun(run.screens, run.flow);
    const sk = await generateFlutterSkeleton(projectRoot, canonical);
    await appendRunLog(projectId, run.id, `[amend] skeleton regenerated for plan v${run.planVersion ?? 1}: ${sk.files.length} file(s), ${sk.routes.length} route(s)`);
  } catch (e: any) {
    await appendRunLog(projectId, run.id, `[amend] skeleton regen failed (continuing): ${e?.message || 'unknown'}`);
  }
}

export function registerScreenLoopRoutes(app: Express): void {
  /**
   * POST /api/ai/build-screen — start the headless implement→verify→fix loop.
   * Returns { jobId } immediately; poll /api/ai/progress and read the per-screen
   * .uix/screens/<frameId>/result.json when the job is done.
   */
  app.post('/api/ai/build-screen', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !isAIModel(b.model) || !b.frameId || !b.implementPrompt || !b.referenceImagePath) {
      res.status(400).json({ error: 'projectId, valid model, frameId, referenceImagePath and implementPrompt are required' });
      return;
    }
    const projectRoot = resolveProjectRoot(b.projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) {
      res.status(404).json({ error: `project not found: ${b.projectId}` });
      return;
    }
    const jobId = b.jobId || `${b.projectId}:${b.frameId}:loop:${Date.now()}`;
    startJobLog(jobId, { projectId: b.projectId, firstLine: `[loop] queued "${b.frameName ?? b.frameId}"` });
    res.json({ jobId, started: true });
    // Fire-and-forget: the loop owns its own logging + error handling so the
    // client tab can close while it runs.
    void runScreenLoop(b as BuildScreenReq, projectRoot, jobId).catch((e: any) => {
      appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
      finishJobLog(jobId, '[loop] failed');
      // Mark the screen FAILED in its run so resume re-attempts it.
      if (b.runId) void updateRunScreen(b.projectId, b.runId, b.frameId, { status: 'failed' }).catch(() => {});
    });
  });

  // ── Durable build runs (resumable after Stop / error / rate limit / redeploy) ──
  // POST /api/ai/runs — create a run for a set of screens. Returns the run.
  app.post('/api/ai/runs', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !Array.isArray(b.screens) || b.screens.length === 0) {
      res.status(400).json({ error: 'projectId and a non-empty screens[] are required' });
      return;
    }
    if (!isAIModel(b.model)) { res.status(400).json({ error: 'a valid model is required' }); return; }
    const run = await createRun(b.projectId, {
      kind: b.kind === 'selected' || b.kind === 'single' ? b.kind : 'whole-app',
      framework: b.framework, figStorageKey: b.figStorageKey,
      model: b.model, modelId: b.modelId,
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : undefined,
      verify: b.verify !== false,
      userNotes: typeof b.userNotes === 'string' ? b.userNotes : undefined,
      // P2: opt into fresh-per-screen sessions (model-independent written contract)
      // and an optional bounded parallel worker pool. parallel>1 implies fresh.
      freshSessions: b.freshSessions === true || (typeof b.parallel === 'number' && b.parallel > 1),
      parallel: typeof b.parallel === 'number' ? b.parallel : undefined,
      // P3: opt into the canonicalization pre-pass + write-locked skeleton.
      canonical: b.canonical === true,
      // P5: enable HITL checkpoint gates (RFC §5). Pass a subset of gate names
      // ('flow','plan','design-system','rolling','pre-global') to pause the run for
      // human approval at those milestones. Omitted/empty → no gating (old behavior).
      checkpoints: Array.isArray(b.checkpoints) ? b.checkpoints.map((g: any) => String(g)) as CheckpointGate[] : undefined,
      flow: b.flow && (Array.isArray(b.flow.connections) || b.flow.entryFrameId !== undefined) ? {
        entryFrameId: b.flow.entryFrameId ?? null,
        connections: Array.isArray(b.flow.connections) ? b.flow.connections.map((c: any) => ({
          from: String(c.from), to: String(c.to), type: String(c.type ?? 'push'), label: c.label ? String(c.label) : undefined,
        })) : [],
      } : undefined,
      screens: b.screens.map((s: any): { frameId: string; frameName: string; spec?: ScreenSpec } => ({
        frameId: String(s.frameId),
        frameName: String(s.frameName ?? s.frameId),
        spec: s.spec && s.spec.packet ? {
          packet: String(s.spec.packet),
          referenceImagePath: String(s.spec.referenceImagePath ?? ''),
          tree: typeof s.spec.tree === 'string' ? s.spec.tree : undefined,
          width: typeof s.spec.width === 'number' ? s.spec.width : undefined,
          height: typeof s.spec.height === 'number' ? s.spec.height : undefined,
          // P4: actual reference-render pixel size (refs are @2×) — drives the
          // pre-flight vision-token estimate. Stored at creation per RFC §4.3.
          refWidthPx: typeof s.spec.refWidthPx === 'number' ? s.spec.refWidthPx : undefined,
          refHeightPx: typeof s.spec.refHeightPx === 'number' ? s.spec.refHeightPx : undefined,
        } : undefined,
      })),
    });
    if (!run) { res.status(404).json({ error: `project not found: ${b.projectId}` }); return; }
    res.json({ run });
  });

  // POST /api/ai/runs/:runId/start { projectId, steerNotes?, restart? } — kick off
  // (or resume) the SERVER-SIDE orchestration of the whole run. Returns immediately.
  app.post('/api/ai/runs/:runId/start', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    let run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (isRunActive(runId)) { res.json({ run, started: false, alreadyRunning: true }); return; }
    clearRunCancelled(runId);
    if (b.restart) run = await restartRun(projectId, runId) ?? run;
    const steer = typeof b.steerNotes === 'string' ? b.steerNotes.trim() : '';
    if (steer) {
      run.userNotes = [run.userNotes?.trim(), steer].filter(Boolean).join('\n\n');
      if (run.status !== 'running') run.status = 'running';
      await saveRun(projectId, run);
    } else if (run.status === 'stopped') {
      run.status = 'running';
      await saveRun(projectId, run);
    }
    void runAppLoop(projectId, runId).catch(() => {});
    res.json({ run, started: true });
  });

  // POST /api/ai/runs/:runId/stop { projectId } — request a graceful stop after
  // the in-flight screen finishes. Marks the run 'stopped' (resumable later).
  app.post('/api/ai/runs/:runId/stop', async (req, res) => {
    const projectId = (req.body?.projectId ?? req.query.projectId) as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    markRunCancelled(runId);
    await appendRunLog(projectId, runId, '[run] stop requested');
    // P5 (RFC §4.9): a user Stop is a GRACEFUL pause → mark resumable so a later
    // /start (or, if the user opts in, boot-resume) can pick it back up. (A crash
    // leaves resumable:false, so only intentional stops are resumable.)
    await setRunResumable(projectId, runId, true);
    if (!isRunActive(runId)) await setRunStatus(projectId, runId, 'stopped');
    res.json({ stopped: true });
  });

  // ── P5: HITL checkpoint gates (RFC §5) ───────────────────────────────────────
  // POST /api/ai/runs/:runId/checkpoint { projectId, action: 'approve'|'edit',
  //   gate?, edits? } — clear the parked checkpoint and resume the build. 'edit'
  //   applies optional edits to the run (entryFrameId / steerNotes) before resuming
  //   — the minimal "edit" affordance the RFC's checkpoint UI needs.
  app.post('/api/ai/runs/:runId/checkpoint', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    let run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (run.status !== 'awaiting-approval' || !run.checkpoint) {
      res.status(409).json({ error: `run is not awaiting approval (status: ${run.status})` }); return;
    }
    const gateName = (b.gate as CheckpointGate) ?? run.checkpoint.gate;
    // Optional edits applied at the gate (RFC §5: edit clustering/entry/nav, steer).
    const edits = b.edits ?? {};
    if (run.flow && typeof edits.entryFrameId === 'string') { run.flow.entryFrameId = edits.entryFrameId; await saveRun(projectId, run); }
    if (typeof edits.steerNotes === 'string' && edits.steerNotes.trim()) {
      run.userNotes = [run.userNotes?.trim(), edits.steerNotes.trim()].filter(Boolean).join('\n\n');
      await saveRun(projectId, run);
      await appendRunLog(projectId, runId, `[hitl] checkpoint "${gateName}" steered: ${edits.steerNotes.trim().replace(/\s+/g, ' ')}`);
    }
    run = (await approveCheckpoint(projectId, runId, gateName)) ?? run;
    await appendRunLog(projectId, runId, `[hitl] checkpoint "${gateName}" approved — resuming`);
    if (b.action === 'reject') {
      // Reject = stop the run here (resumable so it can be restarted later).
      await setRunResumable(projectId, runId, true);
      await setRunStatus(projectId, runId, 'stopped');
      res.json({ run: await getRun(projectId, runId), resumed: false }); return;
    }
    res.json({ run, resumed: true });
    // Resume orchestration: the cleared gate is recorded in approvedGates so it
    // won't re-fire; the loop continues from where it parked (already-done screens
    // are skipped). Fire-and-forget — survives the request returning.
    void runAppLoop(projectId, runId).catch(() => {});
  });

  // ── P5: plan amendment protocol (RFC §4.8) ───────────────────────────────────
  // POST /api/ai/runs/:runId/amendments { projectId, kind, rationale, proposedApi,
  //   fromFrameId? } — a screen requests a missing route/component. Whitelisted
  //   classes auto-approve (planVersion++ + skeleton regen); else it's queued for
  //   approval at the rolling gate. Returns the created amendment.
  app.post('/api/ai/runs/:runId/amendments', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const kind = b.kind as AmendmentKind;
    const rationale = typeof b.rationale === 'string' ? b.rationale.trim() : '';
    const proposedApi = typeof b.proposedApi === 'string' ? b.proposedApi.trim() : '';
    if (!projectId || (kind !== 'add-route' && kind !== 'add-component') || !proposedApi) {
      res.status(400).json({ error: "projectId, kind ('add-route'|'add-component') and proposedApi are required" }); return;
    }
    const runId = req.params.runId;
    const result = await addAmendment(projectId, runId, { kind, rationale, proposedApi, fromFrameId: b.fromFrameId });
    if (!result) { res.status(404).json({ error: 'run not found' }); return; }
    const { run, amendment } = result;
    await appendRunLog(projectId, runId, `[amend] ${amendment.kind} "${amendment.proposedApi}" — ${amendment.status}${amendment.auto ? ' (auto, whitelisted)' : ' (queued for rolling-gate approval)'}`);
    if (amendment.status === 'approved') await regenSkeletonForRun(projectId, run);
    res.json({ amendment, planVersion: run.planVersion });
  });

  // POST /api/ai/runs/:runId/amendments/:amendmentId { projectId, decision } —
  //   human resolves a pending amendment at the rolling gate. approved → planVersion++
  //   + skeleton regen.
  app.post('/api/ai/runs/:runId/amendments/:amendmentId', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const decision = b.decision === 'approved' ? 'approved' : b.decision === 'rejected' ? 'rejected' : null;
    if (!projectId || !decision) { res.status(400).json({ error: "projectId and decision ('approved'|'rejected') are required" }); return; }
    const runId = req.params.runId;
    const result = await resolveAmendment(projectId, runId, req.params.amendmentId, decision);
    if (!result) { res.status(404).json({ error: 'run or amendment not found' }); return; }
    const { run, amendment } = result;
    await appendRunLog(projectId, runId, `[amend] ${amendment.kind} "${amendment.proposedApi}" — ${decision} (human)`);
    if (decision === 'approved') await regenSkeletonForRun(projectId, run);
    res.json({ amendment, planVersion: run.planVersion });
  });

  // ── Needs-review workflow (RFC §4.7) ─────────────────────────────────────────
  // POST /api/ai/runs/:runId/accept { projectId, frameId } — human accepts a
  // needs-review screen AS-IS. Marks it 'done' (matched stays false; accepted by a
  // human). If it was the last needs-review screen the run flips to 'done'.
  app.post('/api/ai/runs/:runId/accept', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const frameId = b.frameId as string;
    if (!projectId || !frameId) { res.status(400).json({ error: 'projectId and frameId are required' }); return; }
    const runId = req.params.runId;
    const run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const screen = run.screens.find(s => s.frameId === frameId);
    if (!screen) { res.status(404).json({ error: 'screen not found in run' }); return; }
    // Audit A.1: a 'failed' screen is also surfaced in the review queue (with a
    // review payload) and may be human-accepted as-is, so the run can clear it.
    if (screen.status !== 'needs-review' && screen.status !== 'failed') { res.status(409).json({ error: `screen is not reviewable (status: ${screen.status})` }); return; }
    const updated = await updateRunScreen(projectId, runId, frameId, { status: 'done', review: undefined });
    await appendRunLog(projectId, runId, `[review] accepted "${screen.frameName}" as-is (human)`);
    res.json({ run: updated });
  });

  // POST /api/ai/runs/:runId/retry { projectId, frameId, note } — human Corrected-
  // retry: rebuild this needs-review screen with the human's correction injected
  // into a fresh fix pass. Returns immediately; the rebuild runs server-side.
  app.post('/api/ai/runs/:runId/retry', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    const frameId = b.frameId as string;
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    if (!projectId || !frameId) { res.status(400).json({ error: 'projectId and frameId are required' }); return; }
    if (!note) { res.status(400).json({ error: 'a correction note is required for a corrected-retry' }); return; }
    const runId = req.params.runId;
    const run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const screen = run.screens.find(s => s.frameId === frameId);
    if (!screen) { res.status(404).json({ error: 'screen not found in run' }); return; }
    if (isRunActive(`${runId}:${frameId}`)) { res.json({ started: false, alreadyRunning: true }); return; }
    res.json({ started: true });
    void retryScreenLoop(projectId, runId, frameId, note).catch((e: any) => {
      void appendRunLog(projectId, runId, `[review] retry error: ${e?.message || 'unknown'}`);
    });
  });

  // GET /api/ai/runs/:runId/log?projectId= — the durable, replayable run log.
  app.get('/api/ai/runs/:runId/log', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const log = await readRunLog(projectId, req.params.runId);
    res.json({ log, active: isRunActive(req.params.runId) });
  });

  // GET /api/ai/review-image?projectId=&path= — serve a needs-review screenshot
  // (candidate or reference PNG) as raw bytes. Path is sandboxed to the project's
  // .uix dir so the Runs UI can show candidate-vs-reference inline.
  app.get('/api/ai/review-image', async (req, res) => {
    const projectId = req.query.projectId as string;
    const rel = String(req.query.path || '');
    if (!projectId || !rel) { res.status(400).json({ error: 'projectId and path are required' }); return; }
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) { res.status(404).json({ error: 'project not found' }); return; }
    const abs = resolveProjectRelativePath(projectRoot, rel);
    // Only ever serve images out of .uix/ (refs + per-screen candidates live there).
    if (!abs || !abs.startsWith(path.join(projectRoot, '.uix') + path.sep) || !fsSync.existsSync(abs)) {
      res.status(404).json({ error: 'image not found' }); return;
    }
    try {
      const ext = path.extname(abs).toLowerCase();
      res.setHeader('Content-Type', ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png');
      res.end(await fs.readFile(abs));
    } catch { res.status(500).json({ error: 'failed to read image' }); }
  });

  // GET /api/ai/runs?projectId= — list recent runs (newest first).
  app.get('/api/ai/runs', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    res.json({ runs: await listRuns(projectId) });
  });

  // GET /api/ai/runs/:runId/preflight?projectId= — P4 (RFC §4.3): the deterministic
  // token/cost pre-flight gate (NO LLM). Resolve the concrete model + real window,
  // estimate text+vision tokens per screen, project the cumulative shared-session
  // transcript, best/expected/worst cost, and a block/warn/ok verdict. Shown at
  // HITL Checkpoint 1 BEFORE the run is started.
  app.get('/api/ai/runs/:runId/preflight', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const run = await getRun(projectId, req.params.runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    try {
      res.json({ preflight: computePreflight(run) });
    } catch (e: any) {
      res.status(500).json({ error: `preflight failed: ${e?.message || 'unknown'}` });
    }
  });

  // GET /api/ai/runs/:runId?projectId= — one run.
  app.get('/api/ai/runs/:runId', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const run = await getRun(projectId, req.params.runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({ run });
  });
}
