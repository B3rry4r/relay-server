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

// ── Public contract ──────────────────────────────────────────────────────────

export type Framework = 'flutter' | 'react' | 'unknown';

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
interface CanonScreen { canonicalId: string; name: string; route: string; frameIds: string[] }
interface CanonModel { screens?: CanonScreen[]; modals?: CanonModal[] }

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
      if (deps.react || deps.next) return 'react';
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
  ): Promise<{ transform: ModalTransform } | { skip: string }>;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function applyModalOverlays(projectId: string, opts: ModalOverlayOptions): Promise<ModalOverlayResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  const canonical = await readCanonical(opts.canonicalRoot ?? projectRoot);

  if (!canonical || !Array.isArray(canonical.modals)) {
    return { framework, transformed: [], skipped: [], dryRun: !!opts.dryRun };
  }
  if (!strategy) {
    return {
      framework,
      transformed: [],
      skipped: canonical.modals.map((m) => ({ canonicalId: m.canonicalId, name: m.name, reason: `no strategy for framework '${framework}'` })),
      dryRun: !!opts.dryRun,
    };
  }

  const screens = canonical.screens ?? [];
  const transformed: ModalTransform[] = [];
  const skipped: ModalOverlaySkip[] = [];

  let modals = canonical.modals;
  if (opts.onlyModals?.length) modals = modals.filter((m) => opts.onlyModals!.includes(m.canonicalId));

  for (const modal of modals) {
    // Orphan guard: a modal with no resolvable base / trigger is left alone with
    // a warning — we never guess-wire an overlay onto an arbitrary screen.
    if (!modal.baseCanonicalId || !modal.trigger?.fromScreen) {
      skipped.push({ canonicalId: modal.canonicalId, name: modal.name, reason: 'orphan modal — no base screen / trigger in canonical (left untouched)' });
      continue;
    }
    const out = await strategy.convert(projectRoot, modal, screens, opts);
    if ('transform' in out) transformed.push(out.transform);
    else skipped.push({ canonicalId: modal.canonicalId, name: modal.name, reason: out.skip });
  }

  return { framework, transformed, skipped, dryRun: !!opts.dryRun };
}

function getStrategy(fw: Framework): ModalStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react') return reactStrategy;
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
): Promise<{ transform: ModalTransform } | { skip: string }> {
  const baseScreen = screens.find((s) => s.canonicalId === modal.baseCanonicalId);
  if (!baseScreen) return { skip: `base screen ${modal.baseCanonicalId} not in canonical screens` };

  const modalFrames = [modal.frameId];
  const resolvedModal = await resolveScreenFile(projectRoot, modal.canonicalId, modalFrames);
  if (!resolvedModal) return { skip: `modal ${modal.canonicalId} (frame ${modal.frameId}) has no built screen file — not mapped to this app` };

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

  // Locate the trigger in the base screen. Deterministic: the base pushes the
  // modal's route. Resolve the modal's route const from app_routes.dart, then
  // find the push call on the base. Fuzzy fallback → AI.
  const route = await resolveRouteConst(projectRoot, modal.canonicalId);
  const baseSrc = await fs.readFile(resolvedBase.file, 'utf8');
  let triggerHow: ModalTransform['trigger']['how'] = 'none';
  let triggerWired: ModalTransform['trigger']['wired'] = 'none';

  // Build the presenter call we will inject at the trigger site.
  const presenterCall = `${resolvedModal.widgetClass}.present(context)`;

  let newBaseSrc = baseSrc;
  if (route) {
    const rewritten = rewritePushToPresent(baseSrc, route.constName, presenterCall, resolvedModal.file, resolvedBase.file, presentation.kind);
    if (rewritten.changed) {
      newBaseSrc = rewritten.src;
      triggerHow = 'deterministic';
      triggerWired = 'rewrote-push';
    }
  }
  if (triggerWired === 'none' && opts.model && opts.runModel && !opts.noAi) {
    // Fuzzy trigger: ask the AI to locate the element/handler by label, then we
    // still apply a deterministic rewrite around the returned snippet.
    const located = await aiLocateTrigger(modal, baseSrc, opts);
    if (located) {
      const rewritten = rewriteSnippetToPresent(baseSrc, located, presenterCall, resolvedModal.file, resolvedBase.file);
      if (rewritten.changed) {
        newBaseSrc = rewritten.src;
        triggerHow = 'ai';
        triggerWired = 'rewrote-push';
      }
    }
  }
  if (triggerWired === 'none') {
    return { skip: `could not locate trigger '${modal.trigger.element ?? '?'}' on base ${baseScreen.canonicalId} (no push to modal route, AI unavailable/failed) — left untouched` };
  }

  // Build the converted modal source: surface widget + present() presenter.
  const newModalSrc = buildOverlayModalSource(modalSrc, resolvedModal.widgetClass, shape, presentation.kind);
  if (!newModalSrc) return { skip: `could not rewrite modal ${resolvedModal.widgetClass} into a presentable surface (unexpected shape)` };

  // Remove the dead route from the router + routes table.
  const removedRoute = route?.constName;

  if (!opts.dryRun) {
    await fs.writeFile(resolvedModal.file, newModalSrc, 'utf8');
    await fs.writeFile(resolvedBase.file, newBaseSrc, 'utf8');
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
      baseFile: path.relative(projectRoot, resolvedBase.file),
      trigger: { element: modal.trigger.element, wired: triggerWired, how: triggerHow },
      ...(removedRoute ? { removedRoute } : {}),
    },
  };
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
  // Surface returned by build(): prefer the sheet expr; else the whole prior body
  // minus the backdrop/scrim (fallback: keep body as-is — still valid, just not
  // de-backdropped). We keep it simple + safe: if we found a sheet expr, return it.
  const surface = sheetExpr ?? null;

  let newBuildBody: string;
  if (surface) {
    // Rewrite Navigator pop callbacks already present in the sheet expr — they
    // still pop the route the presenter pushes, which is correct for a sheet.
    newBuildBody = `\n    return ${surface};\n  `;
  } else {
    // Couldn't isolate a sheet — leave the original body (returns the Stack). The
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

/** Remove a relative `'screen_*.dart'` import line iff `className` (the symbol the
 *  import provided, e.g. the backdrop screen) no longer appears anywhere in the
 *  file. A still-used import is left intact. */
function pruneDeadImportFor(src: string, className: string): string {
  const refs = (src.match(new RegExp(`\\b${escapeRe(className)}\\b`, 'g')) || []).length;
  if (refs > 0) return src; // backdrop class still referenced → keep the import.
  // Backdrop class fully gone. Drop the relative screen import that provided it.
  // Only act when there is EXACTLY ONE relative screen import (the backdrop's) —
  // if a modal happens to import several screens, leave them rather than guess.
  const screenImports = [...src.matchAll(/^import\s+'(?:\.\/)?screen_[A-Za-z0-9_]+\.dart';\n/gm)];
  if (screenImports.length !== 1) return src;
  return src.replace(screenImports[0][0], '');
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
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const k = (JSON.parse(m[0]) as { kind?: string }).kind;
    if (k === 'bottomSheet' || k === 'dialog' || k === 'fullOverlay') return k;
    return null;
  } catch {
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
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const s = (JSON.parse(m[0]) as { snippet?: string }).snippet;
    return s && baseSrc.includes(s) ? s : null;
  } catch {
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
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
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
// React strategy (seam only — Phase 7b ships flutter; react contract is stubbed)
// =============================================================================

const reactStrategy: ModalStrategy = {
  framework: 'react',
  async convert(_projectRoot, _modal, _screens, _opts) {
    // TODO(7c): map a routed modal (a <Route> rendering a full-page modal) to a
    // portal/overlay (Radix Dialog / a barrier <div> + content), rewrite the
    // trigger's onClick from navigate(route) to setOpen(true)/<Dialog open>, and
    // drop the dead route. React shape detection mirrors the flutter strategy.
    return { skip: 'react strategy not implemented (7b ships flutter only)' };
  },
};
