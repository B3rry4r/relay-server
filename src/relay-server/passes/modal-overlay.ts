// =============================================================================
// File: src/relay-server/passes/modal-overlay.ts
//
// Phase 7b — Modal → overlay + trigger (production-readiness pass).
//
// A canonical MODAL is a Figma frame authored as its own full screen but
// semantically a sheet/dialog that appears ON TOP of a base screen
// (`baseCanonicalId`), invoked by a `trigger` element on `fromScreen`. The
// per-screen build phase almost always realizes such a modal as a STANDALONE
// full-screen route: a `Scaffold` that embeds the base screen as a dimmed
// backdrop + scrim + a sheet, registered in the router and reached via
// `Navigator.pushNamed`. That is wrong — it is a real route, not an overlay, so
// the base screen is rebuilt (losing its state) and the modal cannot be
// dismissed back onto a live base.
//
// This pass converts each canonical modal into a TRUE overlay presented over its
// base screen, wired to fire from the real trigger element:
//   - turn the routed modal `Scaffold` into a presentable SURFACE widget
//     (the sheet content) + a static `present(context)` that calls
//     showModalBottomSheet / showDialog / a barrier overlay depending on the
//     modal frame's geometry;
//   - replace the base screen's trigger (`Navigator.push*…ModalRoute`) with the
//     overlay call; if the trigger is a dead button, wire it up;
//   - remove the now-dead full-screen route registration + dead imports;
//   - preserve a dismiss affordance (barrier tap / drag handle / close button).
//   - behaviour & visuals of the sheet body are preserved exactly.
//
// FRAMEWORK-AGNOSTIC. detectFramework() (same contract as 7a) dispatches to a
// per-framework `ModalStrategy`. Flutter ships a full implementation; react is a
// stubbed seam so the contract is visible.
//
// DETERMINISTIC where possible: route removal, the sheet→surface wrapper, and
// the trigger rewrite are pure source transforms. AI (runModel) is used ONLY for
// the genuinely-ambiguous judgments: (a) picking the presentation KIND from the
// modal frame geometry when the structure is unclear, and (b) locating the
// trigger element/handler in the base screen when the canonical `trigger.element`
// is fuzzy and no deterministic match is found. The deterministic transforms
// never depend on AI.
//
// IDEMPOTENT: a second run is a no-op — once a modal is presented as an overlay
// (its route is gone and a `present(` exists), it is skipped, never double-wrapped.
//
// Input: <projectRoot>/.uix/canonical.json (the canonicalize() output). The
// `modals[]` array drives the pass; `screens[]` resolve base + trigger files.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AIModel } from '../ai-adapters';
import { convertWebModal, type WebCanonModal, type WebCanonScreen } from './modal-overlay-web';

// ── Public contract ──────────────────────────────────────────────────────────

export type Framework = 'flutter' | 'react' | 'next' | 'unknown';

export type PresentationKind = 'bottomSheet' | 'dialog' | 'fullOverlay';

export interface ModalOverlayOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used to disambiguate presentation kind / fuzzy trigger location. */
  model?: AIModel;
  /** Skip AI entirely (deterministic-only). Default false. */
  noAi?: boolean;
  /** Only report what WOULD change; do not write. Default false. */
  dryRun?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Restrict to these modal canonicalIds (testing). */
  onlyModals?: string[];
  /** Override the project root used to read canonical.json (testing). */
  canonicalRoot?: string;
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface ModalTransform {
  /** Modal canonicalId from canonical.json. */
  canonicalId: string;
  /** Modal display name. */
  name: string;
  /** Modal frame id. */
  frameId: string;
  /** Base screen canonicalId the overlay sits over. */
  baseCanonicalId: string;
  /** Chosen presentation kind. */
  presentation: PresentationKind;
  /** How the presentation kind was chosen. */
  presentationSource: 'geometry' | 'structure' | 'ai' | 'default';
  /** Modal implementation file (relative to project root). */
  modalFile: string;
  /** Base screen file (relative to project root). */
  baseFile: string;
  /** The trigger element/handler that was wired (label + how it was found). */
  trigger: { element?: string; wired: 'rewrote-push' | 'wired-dead' | 'none'; how: 'deterministic' | 'ai' | 'none' };
  /** Router route const that was removed (if any). */
  removedRoute?: string;
}

export interface ModalOverlaySkip {
  canonicalId: string;
  name: string;
  reason: string;
}

export interface ModalOverlayResult {
  framework: Framework;
  /** Modals successfully converted to overlays. */
  transformed: ModalTransform[];
  /** Modals left untouched (orphans / already-overlay / unmapped) with reasons. */
  skipped: ModalOverlaySkip[];
  dryRun: boolean;
}

// ── Canonical model (subset we read) ─────────────────────────────────────────

interface CanonModalTrigger { fromScreen: string; element?: string; edgeType: string }
interface CanonModal { canonicalId: string; name: string; frameId: string; baseCanonicalId: string; trigger: CanonModalTrigger }
/** A modal as it lives on disk in the AUTHORITATIVE schema: nested under its base
 *  screen's `modals[]` (canonicalize.ts CanonicalModal). */
interface CanonScreenModal { id: string; frameId: string; baseCanonicalId: string | null }
interface CanonScreen { canonicalId: string; name: string; route: string; frameIds: string[]; modals?: CanonScreenModal[] }
interface CanonModel { screens?: CanonScreen[]; modals?: CanonModal[] }

/**
 * P1-core (mirrors flow-wiring.ts collectModals): the pass used to read ONLY the
 * top-level `canonical.modals` — which the authoritative canonicalize.ts schema
 * DOESN'T emit (each modal nests under its base screen's `modals[]`) — so on every
 * real AI-canonical run 8b examined ZERO modals and was a structural no-op (Ping:
 * 13 folded modals, none inspected). Flatten BOTH sources into one list. A nested
 * modal carries no trigger; its presenting screen is BY DEFINITION its base, so we
 * synthesize `{ fromScreen: base, edgeType: 'overlay' }` (no element — the fuzzy
 * trigger search still applies) rather than dropping it as an orphan.
 */
export function collectModals(canonical: CanonModel): CanonModal[] {
  const out: CanonModal[] = [...(canonical.modals ?? [])];
  const seen = new Set(out.map((m) => m.canonicalId));
  for (const s of canonical.screens ?? []) {
    for (const m of s.modals ?? []) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const base = m.baseCanonicalId ?? s.canonicalId;
      out.push({
        canonicalId: m.id, name: m.id, frameId: m.frameId, baseCanonicalId: base,
        trigger: { fromScreen: base, edgeType: 'overlay' },
      });
    }
  }
  return out;
}

async function readCanonical(projectRoot: string): Promise<CanonModel | null> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'canonical.json'), 'utf8');
    return JSON.parse(raw) as CanonModel;
  } catch {
    return null;
  }
}

// ── Framework detection (same contract as 7a) ────────────────────────────────

export async function detectFramework(projectRoot: string): Promise<Framework> {
  const has = async (p: string) => {
    try { await fs.access(path.join(projectRoot, p)); return true; } catch { return false; }
  };
  if (await has('pubspec.yaml')) return 'flutter';
  if (await has('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return 'next';
      if (deps.react) return 'react';
    } catch { /* fall through */ }
  }
  return 'unknown';
}

// ── Per-framework strategy seam ──────────────────────────────────────────────

export interface ModalStrategy {
  framework: Framework;
  /**
   * Convert ONE canonical modal into an overlay. Resolves the modal + base
   * files, wraps the modal as a presentable surface, rewrites the trigger,
   * removes the dead route, and returns the transform — or null with a reason if
   * it bailed safely (orphan / unmapped / already-overlay / unsafe).
   */
  convert(
    projectRoot: string,
    modal: CanonModal,
    screens: CanonScreen[],
    opts: ModalOverlayOptions,
  ): Promise<ConvertOutcome>;
}

/** The outcome of converting one modal. A `skip` may carry `folded` metadata (T32):
 *  the modal has no standalone file but its base screen renders in-place overlays.
 *  The orchestrator correlates folded modals to their base's presenter call-sites and
 *  only credits as many as the base actually presents — the rest are REAL gaps. */
type ConvertOutcome =
  | { transform: ModalTransform }
  | { skip: string; folded?: { baseFile: string; presenter: string; presenterCount: number } };

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function applyModalOverlays(projectId: string, opts: ModalOverlayOptions): Promise<ModalOverlayResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  const canonical = await readCanonical(opts.canonicalRoot ?? projectRoot);

  // P1-core: flatten nested screens[].modals + legacy top-level modals[] — the
  // authoritative canonical nests modals, so reading only the top level made this
  // pass a silent no-op on every AI-canonical run (zero modals examined).
  const allModals = canonical ? collectModals(canonical) : [];
  if (!canonical || allModals.length === 0) {
    return { framework, transformed: [], skipped: [], dryRun: !!opts.dryRun };
  }
  if (!strategy) {
    return {
      framework,
      transformed: [],
      skipped: allModals.map((m) => ({ canonicalId: m.canonicalId, name: m.name, reason: `no strategy for framework '${framework}'` })),
      dryRun: !!opts.dryRun,
    };
  }

  const screens = canonical.screens ?? [];
  const transformed: ModalTransform[] = [];
  const skipped: ModalOverlaySkip[] = [];

  let modals = allModals;
  if (opts.onlyModals?.length) modals = modals.filter((m) => opts.onlyModals!.includes(m.canonicalId));

  // T32: per-base-file tally of FOLDED modals so we can correlate them to the base's
  // presenter call-sites after the loop. baseFile → { presenterCount, the folded skips }.
  const foldedByBase = new Map<string, { presenterCount: number; entries: ModalOverlaySkip[] }>();

  for (const modal of modals) {
    // Orphan guard: a modal with no resolvable base / trigger is left alone with
    // a warning — we never guess-wire an overlay onto an arbitrary screen.
    if (!modal.baseCanonicalId || !modal.trigger?.fromScreen) {
      skipped.push({ canonicalId: modal.canonicalId, name: modal.name, reason: 'orphan modal — no base screen / trigger in canonical (left untouched)' });
      continue;
    }
    const out = await strategy.convert(projectRoot, modal, screens, opts);
    if ('transform' in out) { transformed.push(out.transform); continue; }
    const entry: ModalOverlaySkip = { canonicalId: modal.canonicalId, name: modal.name, reason: out.skip };
    skipped.push(entry);
    if (out.folded) {
      const g = foldedByBase.get(out.folded.baseFile) ?? { presenterCount: out.folded.presenterCount, entries: [] };
      g.presenterCount = out.folded.presenterCount; // identical for the same base
      g.entries.push(entry);
      foldedByBase.set(out.folded.baseFile, g);
    }
  }

  // T32 OVER-CREDIT CHECK: a base screen with N showModal*/showDialog call-sites can
  // only fold in N modals. When MORE modals claim to be folded into the same base than
  // it has presenters, the surplus are NOT actually presented — flag them as REAL gaps
  // instead of crediting all. We keep the FIRST `presenterCount` skips as folded (stable
  // order) and re-write the reason on the rest. Don't fabricate: a 1:1 (or under) base
  // is left exactly as-is.
  for (const [baseFile, g] of foldedByBase) {
    if (g.entries.length <= g.presenterCount) continue;
    const excess = g.entries.slice(g.presenterCount);
    for (const e of excess) {
      e.reason = `REAL gap — base screen ${path.basename(baseFile)} folds in ${g.presenterCount} modal(s) (showModal*/showDialog call-site count) but ${g.entries.length} modal(s) claim it as their base; this one is UNMATCHED (no presenter for it) and is NOT actually wired`;
    }
  }

  return { framework, transformed, skipped, dryRun: !!opts.dryRun };
}

function getStrategy(fw: Framework): ModalStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react' || fw === 'next') return webStrategy(fw);
  return null;
}

// =============================================================================
// Flutter strategy
// =============================================================================

const flutterStrategy: ModalStrategy = {
  framework: 'flutter',
  async convert(projectRoot, modal, screens, opts) {
    return convertFlutterModal(projectRoot, modal, screens, opts);
  },
};

interface ResolvedScreenFile { canonicalId: string; file: string; widgetClass: string; }

/** Resolve a canonical screen/modal id → its built Dart file + top-level Screen
 *  widget class. The build stamps `// canonicalId: c_… ` at the top of each
 *  screen file; that header is the authoritative map. Falls back to the
 *  frame-id-derived filename (`screen_<frame>.dart`). */
async function resolveScreenFile(projectRoot: string, canonicalId: string, frameIds: string[]): Promise<ResolvedScreenFile | null> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  let files: string[];
  try { files = (await fs.readdir(screensDir)).filter((f) => f.endsWith('.dart')); } catch { return null; }

  // 1) header match: `// canonicalId: <id>`. The build stamps screen files with a
  //    `c_<frame>` id; canonical MODALS use an `m_<frame>` id (modalIdFor) for the
  //    SAME frame. Compare by the frame core so a modal id matches its built file.
  for (const f of files) {
    const abs = path.join(screensDir, f);
    const src = await fs.readFile(abs, 'utf8');
    const hm = /^\/\/\s*canonicalId:\s*(\S+)/m.exec(src);
    if (hm && idCore(hm[1]) === idCore(canonicalId)) {
      const cls = topLevelScreenClass(src);
      if (cls) return { canonicalId, file: abs, widgetClass: cls };
    }
  }
  // 2) filename match on any frame id (screen_<frame>.dart).
  for (const fid of frameIds) {
    const fname = `screen_${String(fid).replace(/[^a-zA-Z0-9]+/g, '_')}.dart`;
    const abs = path.join(screensDir, fname);
    try {
      const src = await fs.readFile(abs, 'utf8');
      const cls = topLevelScreenClass(src);
      if (cls) return { canonicalId, file: abs, widgetClass: cls };
    } catch { /* next */ }
  }
  return null;
}

/** T32: does the modal's BASE screen render the modal FOLDED IN as an in-place
 *  overlay? A generated app renders a sheet/dialog modal directly inside its base
 *  screen via `showModalBottomSheet` / `showDialog` / `showGeneralDialog` rather
 *  than as a standalone routed screen. When the base file resolves AND contains
 *  such a presenter, the modal is already an overlay — 8b's goal — so this is a
 *  not-applicable (folded) case, NOT a failure. Returns the base file + the
 *  presenter we matched, or null when no in-place overlay is present. */
async function baseRendersFoldedOverlay(
  projectRoot: string,
  baseScreen: CanonScreen,
): Promise<{ baseFile: string; presenter: string; presenterCount: number } | null> {
  const resolvedBase = await resolveScreenFile(projectRoot, baseScreen.canonicalId, baseScreen.frameIds);
  if (!resolvedBase) return null;
  let src: string;
  try { src = await fs.readFile(resolvedBase.file, 'utf8'); } catch { return null; }
  // T32: COUNT distinct presenter CALL-SITES, not just "has one". A base that hosts
  // several folded modals must present each — one showModal*/showDialog call can only
  // fold ONE modal in. The count gates the per-base over-credit check in
  // applyModalOverlays so an UNPRESENTED sibling modal isn't credited as handled.
  const calls = src.match(/\b(?:showModalBottomSheet|showDialog|showGeneralDialog)\s*[<(]/g);
  if (!calls || calls.length === 0) return null;
  const presenter = /\b(showModalBottomSheet|showDialog|showGeneralDialog)\b/.exec(calls[0])?.[1] ?? 'showModalBottomSheet';
  return { baseFile: resolvedBase.file, presenter, presenterCount: calls.length };
}

/** The frame-id core of a canonical id: strip the `c_`/`m_` namespace prefix so a
 *  modal id (`m_300_3600`) and a built screen header (`c_300_3600`) for the SAME
 *  frame compare equal. */
function idCore(id: string): string {
  return String(id).replace(/^[cm]_/, '');
}

/** First top-level `class XScreen extends State{less,ful}Widget`. */
function topLevelScreenClass(src: string): string | null {
  const m = /^class\s+([A-Za-z_][A-Za-z0-9_]*Screen)\s+extends\s+State(?:less|ful)Widget\b/m.exec(src);
  return m ? m[1] : null;
}

// ── modal-as-route detection + geometry ──────────────────────────────────────

interface ModalRouteShape {
  /** The base screen widget embedded as the dimmed backdrop, e.g. `IPhone…Screen`. */
  backdropClass: string | null;
  /** The sheet/content widget rendered on top, e.g. `_SuccessSheet`. */
  sheetClass: string | null;
  /** Alignment of the sheet inside the Stack: bottom | center | fill. */
  align: 'bottom' | 'center' | 'fill' | 'unknown';
  /** Whether a scrim/barrier ColoredBox is present. */
  hasScrim: boolean;
}

/** Inspect a modal screen's `build()` for the standard modal-as-route shape:
 *  a Stack with a `Positioned.fill` backdrop screen + a scrim + an aligned sheet. */
function inspectModalRoute(modalSrc: string, modalClass: string): ModalRouteShape {
  const body = classBuild(modalSrc, modalClass) ?? '';
  // backdrop: the embedded base screen widget inside a Positioned.fill / IgnorePointer.
  const backdropM = /(?:Positioned\.fill|IgnorePointer)[\s\S]{0,120}?\b([A-Z][A-Za-z0-9_]*Screen)\s*\(/.exec(body)
    ?? /\b([A-Z][A-Za-z0-9_]*Screen)\s*\(\)/.exec(body);
  const backdropClass = backdropM ? backdropM[1] : null;
  const hasScrim = /ColoredBox\([^)]*scrim|scrim|barrierColor|Color\(0x[0-9A-Fa-f]{2}0{6}\)/i.test(body) || /Opacity|withOpacity/.test(body);
  // sheet: a private content widget rendered as a child of an Align/Positioned.
  let align: ModalRouteShape['align'] = 'unknown';
  if (/alignment:\s*Alignment\.bottomCenter|Alignment\.bottomLeft|Alignment\.bottomRight/.test(body)) align = 'bottom';
  else if (/alignment:\s*Alignment\.center\b/.test(body)) align = 'center';
  else if (/\bCenter\s*\(\s*child\s*:/.test(body)) align = 'center'; // centered foreground (loaders) → dialog
  else if (/Positioned\.fill/.test(body) && !backdropClass) align = 'fill';
  // sheet class: a `_Foo(` that is NOT a Screen and appears after an Align/bottom.
  const sheetM = [...body.matchAll(/\b(_[A-Z][A-Za-z0-9_]*)\s*\(/g)]
    .map((x) => x[1])
    .find((n) => /sheet|dialog|modal|panel|card/i.test(n));
  const sheetClass = sheetM ?? null;
  return { backdropClass, sheetClass, align, hasScrim };
}

/** Choose a presentation kind from the modal-route structure. Bottom-aligned →
 *  bottomSheet; centered → dialog; full-bleed → fullOverlay. */
function presentationFromShape(shape: ModalRouteShape): { kind: PresentationKind; source: ModalTransform['presentationSource'] } {
  if (shape.align === 'bottom') return { kind: 'bottomSheet', source: 'structure' };
  if (shape.align === 'center') return { kind: 'dialog', source: 'structure' };
  if (shape.align === 'fill') return { kind: 'fullOverlay', source: 'structure' };
  return { kind: 'bottomSheet', source: 'default' };
}

// ── conversion ───────────────────────────────────────────────────────────────

async function convertFlutterModal(
  projectRoot: string,
  modal: CanonModal,
  screens: CanonScreen[],
  opts: ModalOverlayOptions,
): Promise<ConvertOutcome> {
  const baseScreen = screens.find((s) => s.canonicalId === modal.baseCanonicalId);
  if (!baseScreen) return { skip: `base screen ${modal.baseCanonicalId} not in canonical screens` };

  const modalFrames = [modal.frameId];
  const resolvedModal = await resolveScreenFile(projectRoot, modal.canonicalId, modalFrames);
  if (!resolvedModal) {
    // T32 FOLDED-MODAL RECONCILIATION: a GENERATED app frequently FOLDS a modal into
    // its base screen — the build agent renders it as an in-base overlay
    // (showModalBottomSheet/showDialog/showGeneralDialog) rather than a standalone
    // routed screen. There is therefore NO standalone modal file to convert: this is
    // the DESIRED end state (8b's whole purpose), not a failure. Detect it by
    // checking the base screen for an in-place overlay presenter and report it
    // honestly as already-overlay/not-applicable, instead of "no built screen file".
    const folded = await baseRendersFoldedOverlay(projectRoot, baseScreen);
    if (folded) {
      // T32: report folded but CARRY the base file + presenter count so the orchestrator
      // can verify the base actually presents enough overlays for every folded modal it
      // hosts. A base with 1 showModal* but 2 folded modals presents only one — the other
      // is a real gap, not "handled".
      return {
        skip: `already an in-base overlay (folded into base screen ${path.basename(folded.baseFile)} via ${folded.presenter}) — not-applicable (generated apps render modals as in-place overlays)`,
        folded: { baseFile: folded.baseFile, presenter: folded.presenter, presenterCount: folded.presenterCount },
      };
    }
    return { skip: `modal ${modal.canonicalId} (frame ${modal.frameId}) has no built screen file and its base screen renders no in-place overlay — REAL gap (modal not built)` };
  }

  const resolvedBase = await resolveScreenFile(projectRoot, baseScreen.canonicalId, baseScreen.frameIds);
  if (!resolvedBase) return { skip: `base screen ${baseScreen.canonicalId} has no built screen file` };

  const modalSrc = await fs.readFile(resolvedModal.file, 'utf8');

  // IDEMPOTENCE: if this modal already exposes a `present` presenter (or carries
  // the 7b marker), it was already converted — skip (never double-wrap).
  if (hasPresenter(modalSrc) || /\/\/\s*7b:\s*overlay/.test(modalSrc)) {
    return { skip: `already an overlay (present() exists) — idempotent skip` };
  }

  const shape = inspectModalRoute(modalSrc, resolvedModal.widgetClass);

  // Decide presentation. Structure is authoritative; AI only when structure is
  // ambiguous (no clear alignment AND a model is available).
  let presentation = presentationFromShape(shape);
  if (presentation.source === 'default' && opts.model && opts.runModel && !opts.noAi) {
    const aiKind = await aiPickPresentation(modal, modalSrc, opts);
    if (aiKind) presentation = { kind: aiKind, source: 'ai' };
  }

  // Locate the trigger. Deterministic: SOME screen/modal pushes the modal's route.
  // The push is usually on the base screen, but in real apps it can live on a
  // DIFFERENT screen (the modal's visual backdrop ≠ the screen carrying the
  // button — Ping's loading modal sits over the result screen but is launched from
  // the prior step) or inside a SIBLING modal that chains to it via
  // pushReplacementNamed. So we scan ALL screen files for the route push, not just
  // the base. Resolve the modal's route const from app_routes.dart first.
  const route = await resolveRouteConst(projectRoot, modal.canonicalId);
  let triggerHow: ModalTransform['trigger']['how'] = 'none';
  let triggerWired: ModalTransform['trigger']['wired'] = 'none';

  // Build the presenter call we will inject at the trigger site.
  const presenterCall = `${resolvedModal.widgetClass}.present(context)`;

  // The file we actually rewrite the trigger in (may be the base, or another
  // screen/modal that pushes this route). Written separately from the modal file.
  let triggerFile: string | null = null;
  let triggerSrcNew: string | null = null;

  if (route) {
    // Find every file under lib/ whose source pushes this route const, and rewrite
    // the push there. (Reads fresh from disk so earlier conversions in THIS pass
    // — e.g. a sibling modal we already turned into a presenter — are respected.)
    const hit = await findRoutePushAcrossLib(projectRoot, route.constName, presenterCall, resolvedModal.file, presentation.kind);
    if (hit) {
      triggerFile = hit.file;
      triggerSrcNew = hit.src;
      triggerHow = 'deterministic';
      triggerWired = 'rewrote-push';
    }
  }
  if (triggerWired === 'none' && opts.model && opts.runModel && !opts.noAi) {
    // Fuzzy trigger: ask the AI to locate the element/handler by label on the base
    // screen, then apply a deterministic rewrite around the returned snippet.
    const baseSrc = await fs.readFile(resolvedBase.file, 'utf8');
    const located = await aiLocateTrigger(modal, baseSrc, opts);
    if (located) {
      const rewritten = rewriteSnippetToPresent(baseSrc, located, presenterCall, resolvedModal.file, resolvedBase.file);
      if (rewritten.changed) {
        triggerFile = resolvedBase.file;
        triggerSrcNew = rewritten.src;
        triggerHow = 'ai';
        triggerWired = 'rewrote-push';
      }
    }
  }
  if (triggerWired === 'none' || !triggerFile || triggerSrcNew == null) {
    return { skip: `could not locate trigger '${modal.trigger.element ?? '?'}' for modal ${modal.canonicalId} (no push to modal route '${route?.routeString ?? '?'}' anywhere in lib/, AI unavailable/failed) — left untouched` };
  }

  // Build the converted modal source: surface widget + present() presenter.
  // Re-read the modal file FRESH here: a SIBLING modal's conversion earlier in
  // this same pass may have rewritten a chained push INSIDE this modal (e.g. a
  // loader's initState `pushReplacementNamed` → `SuccessModal.present(context)`)
  // AND added the corresponding import. Transforming the stale top-of-function
  // read would clobber those edits (the undefined-name + missing-import class of
  // regression). If the trigger file we just rewrote IS this modal file, fold its
  // rewritten content in too so both edits compose.
  let freshModalSrc = await fs.readFile(resolvedModal.file, 'utf8');
  if (triggerFile === resolvedModal.file && triggerSrcNew != null) freshModalSrc = triggerSrcNew;
  const newModalSrc = buildOverlayModalSource(freshModalSrc, resolvedModal.widgetClass, shape, presentation.kind);
  if (!newModalSrc) return { skip: `could not rewrite modal ${resolvedModal.widgetClass} into a presentable surface (unexpected shape)` };

  // Remove the dead route from the router + routes table.
  const removedRoute = route?.constName;

  if (!opts.dryRun) {
    // Write the trigger file FIRST (unless it's the modal file — then the modal
    // write below carries both edits), then the modal file.
    if (triggerFile !== resolvedModal.file) await fs.writeFile(triggerFile, triggerSrcNew, 'utf8');
    await fs.writeFile(resolvedModal.file, newModalSrc, 'utf8');
    if (route) await removeRouteFromRouter(projectRoot, route, resolvedModal);
  }

  return {
    transform: {
      canonicalId: modal.canonicalId,
      name: modal.name,
      frameId: modal.frameId,
      baseCanonicalId: modal.baseCanonicalId,
      presentation: presentation.kind,
      presentationSource: presentation.source,
      modalFile: path.relative(projectRoot, resolvedModal.file),
      baseFile: path.relative(projectRoot, triggerFile),
      trigger: { element: modal.trigger.element, wired: triggerWired, how: triggerHow },
      ...(removedRoute ? { removedRoute } : {}),
    },
  };
}

/**
 * Scan every lib/ Dart file for a push to `routeConstName` and rewrite the FIRST
 * file that pushes it (push → presenter call). Returns the file + rewritten src,
 * or null if no file pushes the route. Reads fresh from disk so conversions made
 * earlier in the same pass are honoured. Screen files are scanned first (a real
 * button trigger is preferred over a chained pushReplacement inside a sibling
 * modal), then the rest of lib/.
 */
async function findRoutePushAcrossLib(
  projectRoot: string,
  routeConstName: string,
  presenterCall: string,
  modalFile: string,
  kind: PresentationKind,
): Promise<{ file: string; src: string } | null> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  const constRe = new RegExp(`AppRoutes\\.${escapeRe(routeConstName)}\\b`);

  // Gather candidate files: screens first, then any other lib/ dart file.
  const candidates: string[] = [];
  try {
    for (const f of (await fs.readdir(screensDir)).filter((x) => x.endsWith('.dart')).sort()) {
      candidates.push(path.join(screensDir, f));
    }
  } catch { /* no screens dir */ }

  // Collect every file that references the route const, with its source.
  const pushers: Array<{ abs: string; src: string }> = [];
  for (const abs of candidates) {
    let src: string;
    try { src = await fs.readFile(abs, 'utf8'); } catch { continue; }
    if (constRe.test(src)) pushers.push({ abs, src });
  }
  if (!pushers.length) return null;

  // Rank: a real forward push (pushNamed / push) ranks above a chained
  // pushReplacement, so a button trigger wins over an auto-advance; the modal's
  // own file ranks last (a self-advancing loader).
  const score = (abs: string, src: string): number => {
    if (abs === modalFile) return -10;
    let s = 0;
    if (/\.pushNamed\s*\([^;]*?AppRoutes\.|Navigator\.pushNamed\s*\(\s*context\s*,\s*AppRoutes\.|\.push\s*\([^;]*?AppRoutes\./.test(src)) s += 2;
    if (/pushReplacement/.test(src)) s += 1;
    return s;
  };
  pushers.sort((a, b) => score(b.abs, b.src) - score(a.abs, a.src));

  for (const { abs, src } of pushers) {
    const rewritten = rewritePushToPresent(src, routeConstName, presenterCall, modalFile, abs, kind);
    if (rewritten.changed) return { file: abs, src: rewritten.src };
  }
  return null;
}

// ── modal source rewrite (Scaffold route → surface + present()) ──────────────

/**
 * Rewrite the modal screen file so its top-level Screen widget exposes a static
 * `present(context)` presenter and a `build()` that returns ONLY the sheet
 * surface (no embedded backdrop/scrim — the framework presenter supplies the
 * barrier). The original sheet content widget is preserved verbatim.
 *
 * Strategy (deterministic):
 *  - keep the whole file (imports, sheet widget, helpers) intact;
 *  - replace the top-level Screen widget's `build()` body so it returns the
 *    sheet surface directly (the same `_Sheet(...)` it used inside the Stack,
 *    with navigator-pop callbacks rewired to pop the sheet);
 *  - inject a `static Future<void> present(BuildContext context)` that calls the
 *    chosen presenter with the Screen widget as content.
 *  - drop the now-unused backdrop import (the embedded base screen) if dead.
 */
function buildOverlayModalSource(
  src: string,
  screenClass: string,
  shape: ModalRouteShape,
  kind: PresentationKind,
): string | null {
  const cls = findClass(src, screenClass);
  if (!cls) return null;
  const buildBody = classBuild(src, screenClass);
  if (!buildBody) return null;

  // The sheet child expression as written inside the Stack (e.g.
  // `_SuccessSheet(onLogin: …, onAccountSetup: …)`). Pull the whole call.
  const sheetExpr = shape.sheetClass ? extractCallExpr(buildBody, shape.sheetClass) : null;
  // Surface returned by build(): prefer the named sheet expr; else the FOREGROUND
  // Stack child (the non-backdrop, non-scrim widget — e.g. the loading modals'
  // `Center(child: PingBadgeLoader(...))`), so the converted build() returns ONLY
  // the modal content (the presenter supplies the barrier; embedding the backdrop
  // again would double-render the base). Only if neither resolves do we keep the
  // body as-is (still valid as an overlay surface).
  const surface = sheetExpr ?? extractForegroundSurface(buildBody, shape.backdropClass);

  let newBuildBody: string;
  if (surface) {
    // Rewrite Navigator pop callbacks already present in the sheet expr — they
    // still pop the route the presenter pushes, which is correct for a sheet.
    newBuildBody = `\n    return ${surface};\n  `;
  } else {
    // Couldn't isolate a surface — leave the original body (returns the Stack). The
    // presenter still presents it as an overlay surface; visuals preserved.
    newBuildBody = buildBody;
  }

  const presenter = presenterMethod(screenClass, kind);

  // Splice: replace the class's build() body and insert the presenter + a marker.
  let out = src;
  out = replaceClassBuildBody(out, screenClass, newBuildBody);
  out = injectPresenter(out, screenClass, presenter);
  // Idempotence marker.
  if (!/\/\/\s*7b:\s*overlay/.test(out)) {
    out = out.replace(new RegExp(`(class\\s+${escapeRe(screenClass)}\\s+extends\\s+State(?:less|ful)Widget)`), `// 7b: overlay — presented via ${screenClass}.present(context)\n$1`);
  }
  // Prune the backdrop import: de-backdropping dropped the embedded base screen,
  // so the relative `screen_*.dart` import that provided the backdrop widget
  // (`shape.backdropClass`) may now be dead. Remove it only if that exact class
  // is no longer referenced anywhere in the file. Reference-checked + idempotent.
  if (shape.backdropClass) out = pruneDeadImportFor(out, shape.backdropClass);
  return out;
}

/** Remove the relative import line that provided `className` (the backdrop screen
 *  class) iff that class no longer appears anywhere in the file after
 *  de-backdropping. Reference-checked + idempotent; only the SPECIFIC import that
 *  provides the dead backdrop class is dropped (resolved by the file's basename,
 *  which the build names as the class's snake_case — `CreateAccountScreen` →
 *  `create_account_screen.dart`, `IPhone…63Screen` → `screen_290_4323.dart`), so
 *  other still-used screen imports (e.g. a chained present target) are preserved. */
function pruneDeadImportFor(src: string, className: string): string {
  const refs = (src.match(new RegExp(`\\b${escapeRe(className)}\\b`, 'g')) || []).length;
  if (refs > 0) return src; // backdrop class still referenced → keep the import.
  // Backdrop class fully gone. Match the relative import whose basename matches
  // this class. Two naming conventions: semantic (create_account_screen.dart) and
  // machine (screen_<frame>.dart). We can resolve the semantic one from the class
  // name; the machine one we fall back to single-screen-import heuristic.
  const snakeName = className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  // a) semantic: an import ending in `<snake>.dart` (e.g. create_account_screen.dart).
  const semRe = new RegExp(`^import\\s+'[^']*\\b${escapeRe(snakeName)}\\.dart';\\n`, 'm');
  if (semRe.test(src)) return src.replace(semRe, '');
  // b) machine: exactly one `screen_<frame>.dart` relative import → that's it.
  const screenImports = [...src.matchAll(/^import\s+'(?:\.\/)?screen_[A-Za-z0-9_]+\.dart';\n/gm)];
  if (screenImports.length === 1) return src.replace(screenImports[0][0], '');
  return src;
}

/** Emit the static presenter for the chosen kind. */
function presenterMethod(screenClass: string, kind: PresentationKind): string {
  const content = `const ${screenClass}()`;
  if (kind === 'dialog') {
    return [
      `  /// 7b: present this modal as a centered dialog over the current screen.`,
      `  static Future<T?> present<T>(BuildContext context) {`,
      `    return showDialog<T>(`,
      `      context: context,`,
      `      barrierDismissible: true,`,
      `      builder: (_) => Dialog(`,
      `        backgroundColor: Colors.transparent,`,
      `        insetPadding: const EdgeInsets.all(24),`,
      `        child: ${content},`,
      `      ),`,
      `    );`,
      `  }`,
    ].join('\n');
  }
  if (kind === 'fullOverlay') {
    return [
      `  /// 7b: present this modal as a full-bleed barrier overlay over the screen.`,
      `  static Future<T?> present<T>(BuildContext context) {`,
      `    return showGeneralDialog<T>(`,
      `      context: context,`,
      `      barrierDismissible: true,`,
      `      barrierLabel: 'dismiss',`,
      `      barrierColor: Colors.black54,`,
      `      pageBuilder: (_, __, ___) => ${content},`,
      `    );`,
      `  }`,
    ].join('\n');
  }
  // bottomSheet (default)
  return [
    `  /// 7b: present this modal as a bottom sheet over the current screen.`,
    `  static Future<T?> present<T>(BuildContext context) {`,
    `    return showModalBottomSheet<T>(`,
    `      context: context,`,
    `      isScrollControlled: true,`,
    `      backgroundColor: Colors.transparent,`,
    `      builder: (_) => ${content},`,
    `    );`,
    `  }`,
  ].join('\n');
}

// ── trigger rewrite on the base screen ───────────────────────────────────────

/** Replace a `Navigator.…push{,Named,Replacement…}(… <routeConst> …)` whose
 *  target is the modal's route with `<presenterCall>`. Adds the modal import.
 *  Returns {changed} so the caller knows whether the deterministic match hit. */
function rewritePushToPresent(
  src: string,
  routeConstName: string,
  presenterCall: string,
  modalFile: string,
  baseFile: string,
  _kind: PresentationKind,
): { src: string; changed: boolean } {
  // Find any push invocation whose argument list references AppRoutes.<const>.
  // We match the smallest `Navigator…(…)` call that contains the route const.
  const constRe = new RegExp(`AppRoutes\\.${escapeRe(routeConstName)}\\b`);
  if (!constRe.test(src)) return { src, changed: false };

  let changed = false;
  let out = src;
  // Scan for Navigator push calls and replace whole call if it references the route.
  const navRe = /Navigator\s*\.\s*(?:of\s*\(\s*context\s*\)\s*\.\s*)?push(?:Named|ReplacementNamed|Replacement|AndRemoveUntil)?\s*\(/g;
  let m: RegExpExecArray | null;
  const edits: Array<[number, number]> = [];
  while ((m = navRe.exec(out)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const close = matchParen(out, openIdx);
    if (close < 0) continue;
    const call = out.slice(m.index, close + 1);
    if (constRe.test(call)) edits.push([m.index, close + 1]);
  }
  // Apply right-to-left.
  for (const [lo, hi] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, lo) + presenterCall + out.slice(hi);
    changed = true;
  }
  if (changed) {
    out = ensureImport(out, importPathBetween(baseFile, modalFile));
    out = pruneDeadRoutesImport(out);
  }
  return { src: out, changed };
}

/** If the base screen no longer references `AppRoutes.` after the trigger rewrite,
 *  drop the now-dead `app_routes.dart` import. Reference-checked + idempotent. */
function pruneDeadRoutesImport(src: string): string {
  const importM = /^import\s+'[^']*app_routes\.dart';\n/m.exec(src);
  if (!importM) return src;
  const body = src.replace(importM[0], '');
  if (/\bAppRoutes\./.test(body)) return src; // still used → keep.
  return src.replace(importM[0], '');
}

/** AI-located trigger snippet → deterministic rewrite. The snippet is the
 *  existing handler body (possibly a dead/empty one); we replace its push (or its
 *  whole onTap body if empty) with the presenter call. */
function rewriteSnippetToPresent(
  src: string,
  snippet: string,
  presenterCall: string,
  modalFile: string,
  baseFile: string,
): { src: string; changed: boolean } {
  const idx = src.indexOf(snippet);
  if (idx < 0) return { src, changed: false };
  // If the snippet contains a Navigator push, rewrite just that; else replace the
  // snippet's handler arrow body with the presenter.
  let replacement = snippet;
  if (/Navigator\s*\./.test(snippet)) {
    replacement = snippet.replace(/Navigator\s*\.[\s\S]*?\)\s*\)?/, presenterCall);
  } else if (/onTap\s*:\s*\(\s*\)\s*\{?\s*\}?/.test(snippet)) {
    // dead handler: `onTap: () {}` or `onTap: null`
    replacement = snippet.replace(/onTap\s*:\s*(?:\(\s*\)\s*(?:\{\s*\}|=>\s*[^,)]*)|null)/, `onTap: () => ${presenterCall}`);
  } else {
    return { src, changed: false };
  }
  if (replacement === snippet) return { src, changed: false };
  let out = src.slice(0, idx) + replacement + src.slice(idx + snippet.length);
  out = ensureImport(out, importPathBetween(baseFile, modalFile));
  out = pruneDeadRoutesImport(out);
  return { src: out, changed: true };
}

// ── router cleanup ───────────────────────────────────────────────────────────

interface RouteRef { constName: string; routeString: string }

/** Find the modal's route in app_routes.dart by matching the route-string slug
 *  back to the screen's `// route:` header (most reliable), else by the canonical
 *  id transform. Returns the const name + literal route string. */
async function resolveRouteConst(projectRoot: string, canonicalId: string): Promise<RouteRef | null> {
  const routesFile = path.join(projectRoot, 'lib', 'app_routes.dart');
  let routesSrc: string;
  try { routesSrc = await fs.readFile(routesFile, 'utf8'); } catch { return null; }

  // Get the modal screen file to read its `// route:` header (authoritative).
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  let routeString: string | null = null;
  try {
    for (const f of (await fs.readdir(screensDir)).filter((x) => x.endsWith('.dart'))) {
      const src = await fs.readFile(path.join(screensDir, f), 'utf8');
      const hm = /^\/\/\s*canonicalId:\s*(\S+)\s+route:\s*(\S+)/m.exec(src);
      if (hm && idCore(hm[1]) === idCore(canonicalId)) { routeString = hm[2]; break; }
    }
  } catch { /* fall through */ }

  // Match the route STRING literal to a const declaration.
  if (routeString) {
    const cre = new RegExp(`static\\s+const\\s+String\\s+([A-Za-z0-9_]+)\\s*=\\s*'${escapeRe(routeString)}'`, 'm');
    const cm = cre.exec(routesSrc);
    if (cm) return { constName: cm[1], routeString };
  }
  return null;
}

/** Remove the modal route: drop the `case '<route>':` block from app_router.dart,
 *  drop the screen import from the router IF now unused, and remove the route
 *  const from app_routes.dart. All idempotent + reference-checked. */
async function removeRouteFromRouter(projectRoot: string, route: RouteRef, modal: ResolvedScreenFile): Promise<void> {
  const routerFile = path.join(projectRoot, 'lib', 'app_router.dart');
  const routesFile = path.join(projectRoot, 'lib', 'app_routes.dart');

  // 1) router: remove the `case '<routeString>': return MaterialPageRoute(builder: (_) => const XScreen());`
  try {
    let router = await fs.readFile(routerFile, 'utf8');
    const caseRe = new RegExp(`\\n\\s*case\\s+'${escapeRe(route.routeString)}'\\s*:[\\s\\S]*?MaterialPageRoute\\([\\s\\S]*?\\)\\s*;`, 'm');
    router = router.replace(caseRe, '');
    // remove the modal screen import if no longer referenced in the router.
    const importName = `screens/${path.basename(modal.file)}`;
    const widgetRe = new RegExp(`\\b${escapeRe(modal.widgetClass)}\\b`);
    if (!widgetRe.test(router)) {
      router = router.replace(new RegExp(`^import\\s+'${escapeRe(importName)}';\\n`, 'm'), '');
    }
    await fs.writeFile(routerFile, router, 'utf8');
  } catch { /* router optional */ }

  // 2) routes table: remove the const line IF the const is no longer referenced
  //    anywhere in lib/ (we just removed the router case + base push).
  try {
    let routes = await fs.readFile(routesFile, 'utf8');
    const stillUsed = await constStillReferenced(projectRoot, route.constName, routesFile);
    if (!stillUsed) {
      routes = routes.replace(new RegExp(`^\\s*static\\s+const\\s+String\\s+${escapeRe(route.constName)}\\s*=\\s*'[^']*'\\s*;\\s*\\n`, 'm'), '');
    }
    await fs.writeFile(routesFile, routes, 'utf8');
  } catch { /* routes optional */ }
}

async function constStillReferenced(projectRoot: string, constName: string, excludeFile: string): Promise<boolean> {
  const re = new RegExp(`AppRoutes\\.${escapeRe(constName)}\\b`);
  const walk = async (dir: string): Promise<boolean> => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (await walk(abs)) return true; continue; }
      if (!e.name.endsWith('.dart')) continue;
      if (abs === excludeFile) continue;
      const src = await fs.readFile(abs, 'utf8');
      if (re.test(src)) return true;
    }
    return false;
  };
  return walk(path.join(projectRoot, 'lib'));
}

// ── AI seams (ambiguous-only) ────────────────────────────────────────────────

async function aiPickPresentation(modal: CanonModal, modalSrc: string, opts: ModalOverlayOptions): Promise<PresentationKind | null> {
  if (!opts.model || !opts.runModel) return null;
  const prompt = [
    'You are choosing how a modal is presented over its base screen in a Flutter app.',
    `Modal: "${modal.name}". Pick EXACTLY one presentation kind from its source below:`,
    '- "bottomSheet": the modal hugs the bottom edge (a sheet that slides up).',
    '- "dialog": the modal is centered and inset (an alert / confirmation card).',
    '- "fullOverlay": the modal covers the whole screen with a barrier behind it.',
    '',
    'Modal source:',
    modalSrc.slice(0, 4000),
    '',
    'Reply with EXACTLY one JSON object, no prose:',
    '{"kind":"bottomSheet"|"dialog"|"fullOverlay"}',
  ].join('\n');
  // AI picks the presentation kind ONLY when structure is ambiguous (the
  // deterministic shape inspector is primary). Not an AI-PURPOSE step. On
  // failure: conservative no-op (keep the structural default), but LOGGED
  // (RFC §0.1 — not silent).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.log('[ai:modal-present] status=empty — no JSON; keeping structural default'); return null; } // eslint-disable-line no-console
    const k = (JSON.parse(m[0]) as { kind?: string }).kind;
    if (k === 'bottomSheet' || k === 'dialog' || k === 'fullOverlay') return k;
    return null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[ai:modal-present] status=error — ${(e as Error).message.slice(0, 80)}; keeping structural default`);
    return null;
  }
}

async function aiLocateTrigger(modal: CanonModal, baseSrc: string, opts: ModalOverlayOptions): Promise<string | null> {
  if (!opts.model || !opts.runModel) return null;
  const prompt = [
    `You are locating the trigger element that should open the modal "${modal.name}"`,
    `(canonical trigger label: "${modal.trigger.element ?? '(unknown)'}") in the base`,
    'screen Dart source below. Return the EXACT, verbatim source SNIPPET of the widget',
    'handler that should open the modal (e.g. the `onTap: …` or `onPressed: …` of the',
    'matching button/row). It must be copy-paste exact (a contiguous substring).',
    '',
    'Base screen source:',
    baseSrc.slice(0, 8000),
    '',
    'Reply with EXACTLY one JSON object, no prose:',
    '{"snippet":"<verbatim contiguous source substring>"}',
  ].join('\n');
  // AI fuzzily LOCATES the trigger when the deterministic route-push rewrite
  // didn't find it. Not an AI-PURPOSE step. On failure: conservative no-op
  // (trigger stays unwired → reported), but LOGGED (RFC §0.1 — not silent).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.log('[ai:modal-locate] status=empty — no JSON; trigger left unwired'); return null; } // eslint-disable-line no-console
    const s = (JSON.parse(m[0]) as { snippet?: string }).snippet;
    return s && baseSrc.includes(s) ? s : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[ai:modal-locate] status=error — ${(e as Error).message.slice(0, 80)}; trigger left unwired`);
    return null;
  }
}

// ── Dart source utilities ────────────────────────────────────────────────────

/** Whole class source `class Name … { … }`. */
function findClass(src: string, name: string): string | null {
  const re = new RegExp(`^class\\s+${escapeRe(name)}\\b`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  const end = matchBrace(src, open);
  if (end < 0) return null;
  return src.slice(m.index, end + 1);
}

/** The body text of `Widget build(...) { … }` inside class `name` (StatelessWidget),
 *  or the State class's build for a StatefulWidget screen. */
function classBuild(src: string, name: string): string | null {
  // Stateless: build is in the class itself.
  const cls = findClass(src, name);
  if (cls) {
    const b = buildBodyOf(cls);
    if (b) return b;
  }
  // Stateful: build is in `_NameState extends State<Name>`.
  const stateRe = new RegExp(`class\\s+[A-Za-z0-9_]+\\s+extends\\s+State<${escapeRe(name)}>`, 'm');
  const sm = stateRe.exec(src);
  if (sm) {
    const open = src.indexOf('{', sm.index);
    const end = matchBrace(src, open);
    if (end >= 0) return buildBodyOf(src.slice(sm.index, end + 1));
  }
  return null;
}

function buildBodyOf(classSource: string): string | null {
  const bm = /Widget\s+build\s*\([^)]*\)\s*\{/.exec(classSource);
  if (!bm) return null;
  const open = classSource.indexOf('{', bm.index + bm[0].length - 1);
  const end = matchBrace(classSource, open);
  if (end < 0) return null;
  return classSource.slice(open + 1, end);
}

/** Replace the build() body of `name`'s class (stateless or stateful state). */
function replaceClassBuildBody(src: string, name: string, newBody: string): string {
  // Prefer the class itself (stateless).
  const cls = findClass(src, name);
  if (cls && /Widget\s+build\s*\(/.test(cls)) {
    return spliceBuildBody(src, name, false, newBody);
  }
  return spliceBuildBody(src, name, true, newBody);
}

function spliceBuildBody(src: string, name: string, stateful: boolean, newBody: string): string {
  let classStart = -1;
  if (!stateful) {
    const m = new RegExp(`^class\\s+${escapeRe(name)}\\b`, 'm').exec(src);
    if (!m) return src;
    classStart = m.index;
  } else {
    const m = new RegExp(`class\\s+[A-Za-z0-9_]+\\s+extends\\s+State<${escapeRe(name)}>`, 'm').exec(src);
    if (!m) return src;
    classStart = m.index;
  }
  const bm = /Widget\s+build\s*\([^)]*\)\s*\{/.exec(src.slice(classStart));
  if (!bm) return src;
  const openAbs = src.indexOf('{', classStart + bm.index + bm[0].length - 1);
  const endAbs = matchBrace(src, openAbs);
  if (endAbs < 0) return src;
  return src.slice(0, openAbs + 1) + newBody + src.slice(endAbs);
}

/** True when the file already declares a static `present` presenter. The presenter
 *  is generic (`static Future<T?> present<T>(BuildContext…)`), so the optional
 *  `<T>` type-parameter list between the name and `(` must be allowed for. */
function hasPresenter(src: string): boolean {
  return /static\s+Future<[^>]*>\s+present\s*(?:<[^>]*>)?\s*\(/.test(src);
}

/** Insert a static method as the FIRST member of class `name` (after `{`). */
function injectPresenter(src: string, name: string, method: string): string {
  if (hasPresenter(src)) return src; // already present
  const m = new RegExp(`^class\\s+${escapeRe(name)}\\s+extends\\s+State(?:less|ful)Widget[^{]*\\{`, 'm').exec(src);
  if (!m) return src;
  const insertAt = m.index + m[0].length;
  return src.slice(0, insertAt) + `\n${method}\n` + src.slice(insertAt);
}

/**
 * Extract the FOREGROUND surface widget from a modal-as-route build body: the
 * single Stack child that is neither the embedded backdrop screen (a
 * `Positioned.fill` wrapping an `XScreen()`) nor the scrim (a `Positioned.fill`
 * wrapping a `ColoredBox`/scrim). For the loading modals this is the
 * `Center(child: PingBadgeLoader(...))`; for a success modal without a *named*
 * sheet it's whatever aligned content sits over the base. Returns the verbatim
 * child expression, or null when the shape isn't a recognizable single-foreground
 * Stack (then the caller keeps the body as-is — safe).
 */
function extractForegroundSurface(buildBody: string, backdropClass: string | null): string | null {
  // Find the Stack(...) call and its children: [ ... ] list.
  const stackM = /\bStack\s*\(/.exec(buildBody);
  if (!stackM) return null;
  const stackOpen = buildBody.indexOf('(', stackM.index);
  const stackClose = matchParen(buildBody, stackOpen);
  if (stackClose < 0) return null;
  const stackArgs = buildBody.slice(stackOpen + 1, stackClose);
  const childrenM = /\bchildren\s*:\s*(?:const\s*)?\[/.exec(stackArgs);
  if (!childrenM) return null;
  const listOpen = stackArgs.indexOf('[', childrenM.index);
  const listClose = matchBracket(stackArgs, listOpen);
  if (listClose < 0) return null;
  const listInner = stackArgs.slice(listOpen + 1, listClose);

  const children = splitTopLevelList(listInner).map((c) => c.trim()).filter(Boolean);
  if (!children.length) return null;

  const isBackdrop = (c: string): boolean => {
    if (backdropClass && new RegExp(`\\b${escapeRe(backdropClass)}\\b`).test(c)) return true;
    // a Positioned.fill wrapping any *Screen() is a backdrop.
    return /Positioned\.fill/.test(c) && /\b[A-Z][A-Za-z0-9_]*Screen\s*\(/.test(c);
  };
  const isScrim = (c: string): boolean =>
    /ColoredBox/.test(c) || /scrim/i.test(c) || /barrierColor/.test(c) ||
    (/Positioned\.fill/.test(c) && /Color\(0x[0-9A-Fa-f]{2}0{6}\)|withOpacity|Opacity\b/.test(c));

  const foreground = children.filter((c) => !isBackdrop(c) && !isScrim(c));
  // Exactly one foreground child → that's the surface. Strip a leading `const`
  // (the presenter's builder is a runtime closure context; const is preserved
  // inside the expression where valid anyway).
  if (foreground.length === 1) return foreground[0].replace(/^const\s+/, '');
  // Multiple foreground children → wrap them back in a Stack so nothing is lost.
  if (foreground.length > 1) return `Stack(children: [${foreground.join(', ')}])`;
  return null;
}

/** Split a top-level comma-separated list, respecting nested brackets/strings/
 *  comments. Used for Stack children. */
function splitTopLevelList(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = ''; let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { cur += c; if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { if (cur.trim()) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Balanced `[]` matcher (string/comment aware) for child lists. */
function matchBracket(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Extract the full call expression `Name( … )` (balanced parens) from text. */
function extractCallExpr(text: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRe(name)}\\s*\\(`);
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('(', m.index);
  const close = matchParen(text, open);
  if (close < 0) return null;
  return text.slice(m.index, close + 1);
}

function matchBrace(s: string, open: number): number {
  return matchDelimiter(s, open, '{', '}');
}

function matchParen(s: string, open: number): number {
  return matchDelimiter(s, open, '(', ')');
}

/**
 * Balanced-delimiter matcher that is STRING- AND COMMENT-aware. A `//` line
 * comment or `/* … *​/` block comment is skipped so an apostrophe inside a
 * comment (`don't`, `it's`) does NOT corrupt string tracking — that was the
 * "unexpected shape" bug: a State class build body whose comment contained
 * `don't reach` made matchBrace mis-track and return -1, so classBuild() failed
 * and the modal was rejected. Strings still toggle, escapes still honoured.
 */
function matchDelimiter(s: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    // line comment — skip to end of line.
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    // block comment — skip to closing */.
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function ensureImport(src: string, importPath: string): string {
  const line = `import '${importPath}';`;
  if (src.includes(line)) return src;
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (imports.length === 0) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const insertAt = last.index! + last[0].length;
  return src.slice(0, insertAt) + `\n${line}` + src.slice(insertAt);
}

/** Relative import path from one lib/ file to another (both under lib/). */
function importPathBetween(fromFile: string, toFile: string): string {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================================
// React / Next strategy — Phase 7b. See modal-overlay-web.ts.
// =============================================================================

const webStrategy = (framework: Framework): ModalStrategy => ({
  framework,
  async convert(projectRoot, modal, screens, opts) {
    const out = await convertWebModal(
      projectRoot,
      modal as WebCanonModal,
      screens as WebCanonScreen[],
      { dryRun: opts.dryRun },
    );
    if ('skip' in out) return { skip: out.skip };
    const t = out.transform;
    return {
      transform: {
        canonicalId: t.canonicalId,
        name: t.name,
        frameId: t.frameId,
        baseCanonicalId: t.baseCanonicalId,
        presentation: 'dialog',
        presentationSource: 'structure',
        modalFile: t.modalFile ?? '(folded — presenter not located)',
        baseFile: t.baseFile,
        trigger: { wired: 'rewrote-push', how: 'deterministic' },
        ...(t.removedRoute ? { removedRoute: t.removedRoute } : {}),
      },
    };
  },
});
