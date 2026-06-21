// =============================================================================
// File: src/relay-server/passes/resolve-canonical.ts
//
// CODE-BASED CANONICAL RESOLVE — derive .uix/canonical.json from the EMITTED
// CODE of an ALREADY-GENERATED app, instead of from the Figma frames.
//
// WHY THIS EXISTS (read carefully).
// The normal canonicalize() chain (src/relay-server/canonicalize-ai/) runs the
// heavy describe→reduce AI pass over the Figma FRAMES. That is the GENERATION
// path: it produces THE canonical model the generator then builds from. But for
// an app whose screens are ALREADY BUILT as code, re-running the frame path
// produces a canonical that DRIFTS from the actual build — the frame set the AI
// canonicalizes does not match the screen files that were actually emitted, so a
// chunk of the canonical's screens/modals point at frames the build never shipped
// (Ping: only 4/6 frame-derived canonical screens map to a real screen file).
// The six Phase-7 passes (component-extraction, modal-overlay, asset-usage,
// flow-wiring, semantic-rename, token-cleanup) all key off canonical.json, so a
// drifted canonical makes them silently no-op on the screens that didn't map.
//
// This module RESOLVES the canonical from the code itself, so it matches the build
// BY CONSTRUCTION: every canonical screen IS a real screen file, every flow edge
// IS a real Navigator call, every modal IS a real backdrop+scrim screen. It emits
// the EXACT SAME `CanonicalModel` shape (reduce.ts) the passes already consume.
//
// HOW (flutter): we read lib/ — never the frames.
//   • screens  — every lib/screens/*.dart with a top-level XScreen class. The
//     canonicalId comes from the file's `// canonicalId: c_<frame>` header marker
//     (the build stamps it; the same marker flow-wiring/semantic-rename resolve
//     by). Modal-shaped screens (backdrop+scrim) are split out as modals, not
//     screens. The route comes from the header `route:` and the route table.
//   • components — every lib/components/*.dart class (the 7a output), with usedIn
//     computed by scanning every screen's import + usage.
//   • flow edges — each screen/component's Navigator.push*/pushNamed/context.go/go
//     calls, mapped target-route → canonicalId via the route table. entry comes
//     from app_routes.dart `entry`/`initialRoute`.
//   • modals — screens built as a full-screen route with the embedded-base +
//     scrim + sheet shape (the same shape modal-overlay.ts detects); baseCanonicalId
//     is the embedded backdrop screen class resolved back to its canonicalId.
//
// FRAMEWORK-AGNOSTIC: detectFramework() (the 7a–7f contract) dispatches to a
// per-framework ResolveStrategy. Flutter ships a full implementation; react is a
// stubbed seam so the contract is visible (mirrors the six passes).
//
// IDEMPOTENT: identical lib/ → identical canonical (stable ordering + the same
// structure-only contentHash hashCanonical()-style derivation reduce.ts uses).
//
// TEMPORARY / REMOVABLE: this is the resolve seam for already-generated apps. The
// generation path canonicalizes from frames; this resolves from code to avoid the
// drift described above. It can be removed once generation and resolve converge.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIModel } from '../ai-adapters';
import { detectFramework, type Framework } from './component-extraction';
import {
  canonicalIdFor,
  modalIdFor,
  routeForCanonicalId,
  type CanonicalModel,
  type CanonicalScreen,
  type CanonicalModal,
  type CanonicalComponent,
  type CanonicalTemplate,
  type CanonicalFlowEdge,
} from '../canonicalize-ai/reduce';

// ── Public contract ──────────────────────────────────────────────────────────

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface ResolveCanonicalOptions {
  /** Resolved absolute project root (the built app, e.g. /workspace/projects/Ping). */
  projectRoot: string;
  /** AI model for the optional ambiguous-modal-base classification seam. */
  model?: AIModel;
  /** Skip AI entirely (deterministic-only). Default false. */
  noAi?: boolean;
  /** Compute the model but DO NOT write canonical.json / backup. Default false. */
  dryRun?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveStrategy {
  framework: Framework;
  /** Derive the canonical pieces (screens/modals/components/flow) from the code. */
  derive(
    projectId: string,
    opts: ResolveCanonicalOptions,
  ): Promise<DerivedCanonical>;
}

/** The framework-neutral payload a strategy returns; the orchestrator assembles
 *  it into the final CanonicalModel (hash, figStorageKey, version, persist). */
export interface DerivedCanonical {
  screens: CanonicalScreen[];
  modals: CanonicalModal[];
  templates: CanonicalTemplate[];
  components: CanonicalComponent[];
  entryCanonicalId: string | null;
  edges: CanonicalFlowEdge[];
  warnings: string[];
  /** screens that resolved to a real file / total screen ids (the mapping proof). */
  mappingRate: { mapped: number; total: number };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Resolve the canonical model from the emitted code of an already-generated app.
 * Writes <projectRoot>/.uix/canonical.json (backing up any existing — possibly
 * drifted, frame-derived — canonical to .uix/canonical.frames.json.bak first),
 * unless opts.dryRun. Returns the CanonicalModel.
 */
export async function resolveCanonicalFromCode(
  projectId: string,
  opts: ResolveCanonicalOptions,
): Promise<CanonicalModel> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);

  const figStorageKey = await readFigStorageKey(projectRoot);

  // No strategy (unknown framework) → an honest empty canonical + a warning, no crash.
  if (!strategy) {
    const empty = assemble(projectId, figStorageKey, {
      screens: [], modals: [], templates: [], components: [],
      entryCanonicalId: null, edges: [],
      warnings: [`no resolve strategy for framework '${framework}' — empty canonical`],
      mappingRate: { mapped: 0, total: 0 },
    });
    if (!opts.dryRun) await persist(projectRoot, empty);
    return empty;
  }

  const derived = await strategy.derive(projectId, opts);
  const canonical = assemble(projectId, figStorageKey, derived);
  if (!opts.dryRun) await persist(projectRoot, canonical);
  return canonical;
}

function getStrategy(fw: Framework): ResolveStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react') return reactStrategy;
  return null;
}

/** Assemble the derived pieces into the canonical model + stable structure hash. */
function assemble(projectId: string, figStorageKey: string, d: DerivedCanonical): CanonicalModel {
  const canonical: CanonicalModel = {
    version: 1,
    projectId,
    figStorageKey,
    contentHash: '',
    screens: d.screens,
    modals: d.modals,
    templates: d.templates,
    components: d.components,
    flow: { entryCanonicalId: d.entryCanonicalId, edges: d.edges },
    warnings: [...d.warnings].sort(),
  };
  canonical.contentHash = hashCanonical(canonical);
  return canonical;
}

/**
 * Write canonical.json. If one already exists, back it up to
 * .uix/canonical.frames.json.bak FIRST (it may be the drifted frame-derived one —
 * preserve it, never silently destroy). The backup is only written once (we never
 * clobber an existing .bak with a code-derived canonical on a re-run).
 */
async function persist(projectRoot: string, canonical: CanonicalModel): Promise<void> {
  if (!fsSync.existsSync(projectRoot)) return;
  const dir = path.join(projectRoot, '.uix');
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, 'canonical.json');
  const bak = path.join(dir, 'canonical.frames.json.bak');
  try {
    const existing = await fs.readFile(abs, 'utf8');
    // Only back up if (a) a canonical exists and (b) no backup exists yet, AND the
    // existing canonical is NOT already a code-resolved one we wrote (avoid backing
    // up our own output over the real frame-derived original on a re-run).
    if (!fsSync.existsSync(bak)) {
      let isOwn = false;
      try { isOwn = (JSON.parse(existing) as { resolvedFromCode?: boolean }).resolvedFromCode === true; } catch { /* keep */ }
      if (!isOwn) await fs.writeFile(bak, existing, 'utf8');
    }
  } catch { /* no existing canonical — nothing to back up */ }
  // Tag our output so a future resolve run can tell its own canonical from the
  // frame-derived original (keeps the .bak pointing at the real original).
  const tagged = { ...canonical, resolvedFromCode: true } as CanonicalModel & { resolvedFromCode: boolean };
  await fs.writeFile(abs, JSON.stringify(tagged, null, 2), 'utf8');
}

// ── figStorageKey ──────────────────────────────────────────────────────────────

/** Read figStorageKey from the project's manifest if available, else ''. We check
 *  active-frame.json (carries it), then a pre-existing canonical.json. */
async function readFigStorageKey(projectRoot: string): Promise<string> {
  const candidates = ['active-frame.json', 'canonical.json'];
  for (const name of candidates) {
    try {
      const raw = await fs.readFile(path.join(projectRoot, '.uix', name), 'utf8');
      const v = (JSON.parse(raw) as { figStorageKey?: string }).figStorageKey;
      if (typeof v === 'string' && v) return v;
    } catch { /* next candidate */ }
  }
  return '';
}

// ── coarse component-kind hint (mirrors reduce.componentKind, kept local) ─────

function componentKind(name: string): string {
  const n = name.toLowerCase();
  if (/button|fab|cta|link|pill/.test(n)) return 'button';
  if (/nav|tab|appbar|toolbar/.test(n)) return 'nav';
  if (/list|row|item|card|grid/.test(n)) return 'list';
  if (/field|input|search|dropdown|checkbox|radio|toggle|slider|stepper|pin|segment|meter/.test(n)) return 'input';
  if (/avatar|image|icon|illustration|logo|badge|chip|tag|disc/.test(n)) return 'media';
  return 'other';
}

// ── stable structure-only content hash (idempotency proof) ───────────────────
// Mirrors reduce.hashCanonical's contract: hash the canonical RELATIONSHIPS (ids,
// frame membership, modal bindings, flow edges, component usage) — never cosmetic
// names — so identical code → identical hash across re-runs. NOTE: this is a
// CODE-derived hash; it is deliberately NOT folded with LEXICON_VERSION (a code
// resolve has no lexicon dependency), so it is independent of the frame-path hash.
function hashCanonical(c: CanonicalModel): string {
  const shape = {
    v: c.version,
    src: 'code-resolve',
    screens: [...c.screens].map(s => ({
      id: s.canonicalId, route: s.route,
      frames: [...s.frameIds].sort(),
      states: [...s.states].map(st => ({ id: st.id, f: st.frameId })).sort((a, b) => a.id.localeCompare(b.id)),
      tpl: s.templateRef || '',
    })).sort((a, b) => a.id.localeCompare(b.id)),
    modals: [...c.modals].map(m => ({ id: m.canonicalId, f: m.frameId, base: m.baseCanonicalId, e: m.trigger.edgeType, from: m.trigger.fromScreen }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    templates: [...c.templates].map(t => ({ id: t.id, m: [...t.memberCanonicalIds].sort(), s: t.sharedSections })).sort((a, b) => a.id.localeCompare(b.id)),
    components: [...c.components].map(cm => ({ n: cm.canonicalName, k: cm.kind, u: [...cm.usedIn].sort(), c: cm.count })).sort((a, b) => a.n.localeCompare(b.n)),
    flow: { entry: c.flow.entryCanonicalId, edges: [...c.flow.edges].map(e => `${e.from}>${e.to}:${e.kind}`).sort() },
  };
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

// =============================================================================
// Flutter strategy — derive the canonical from lib/.
// =============================================================================

/** A built screen file as read from lib/screens/. */
interface BuiltScreen {
  /** absolute file path. */
  file: string;
  /** basename. */
  base: string;
  /** the canonicalId from the header marker (`// canonicalId: c_<frame>`), or a
   *  derived id when there's no marker. */
  canonicalId: string;
  /** the frame core (`290_3657`) the id maps onto. */
  frameCore: string;
  /** the frame id in `:`-form (`290:3657`) for frameIds[]. */
  frameId: string;
  /** top-level Screen widget class. */
  widgetClass: string;
  /** the route string from the header `route:` (authoritative for this screen). */
  route: string | null;
  /** raw source. */
  src: string;
  /** true when this screen is built as a modal-as-route (backdrop+scrim+sheet). */
  isModal: boolean;
  /** the embedded backdrop screen widget class (the base), when isModal. */
  backdropClass: string | null;
  /** the modal presentation alignment hint (for the trigger edgeType). */
  modalAlign: 'bottom' | 'center' | 'fill' | 'unknown';
}

const flutterStrategy: ResolveStrategy = {
  framework: 'flutter',
  async derive(_projectId, opts) {
    return deriveFlutter(opts);
  },
};

async function deriveFlutter(opts: ResolveCanonicalOptions): Promise<DerivedCanonical> {
  const { projectRoot } = opts;
  const warnings: string[] = [];
  const screensDir = path.join(projectRoot, 'lib', 'screens');

  // No router → empty canonical + warning (no crash). The router/route-table is
  // how we resolve nav targets and the entry; without it there's no flow to derive.
  const { constToRoute, routeToConst, entryRoute, hasRouter } = await readRouting(projectRoot);
  if (!hasRouter) {
    warnings.push('no router / route table found (lib/app_router.dart, lib/app_routes.dart) — cannot resolve routes/flow; returning empty canonical');
  }

  // 1) Read every built screen file.
  let files: string[] = [];
  try { files = (await fs.readdir(screensDir)).filter(f => f.endsWith('.dart')); } catch { /* none */ }
  files.sort();

  const built: BuiltScreen[] = [];
  for (const f of files) {
    const abs = path.join(screensDir, f);
    const src = await fs.readFile(abs, 'utf8');
    const cls = topLevelScreenClass(src);
    if (!cls) continue;                          // not a screen file — skip safely
    const header = parseHeader(src);
    // canonicalId: prefer the header marker; else derive safely from the frame
    // implied by the filename (screen_<frame>.dart) or, failing that, the class.
    const { canonicalId, frameCore, frameId } = resolveScreenIdentity(f, cls, header.canonicalId);
    const modalShape = inspectModalShape(src, cls);
    built.push({
      file: abs, base: f, canonicalId, frameCore, frameId, widgetClass: cls,
      route: header.route, src,
      isModal: modalShape.isModal, backdropClass: modalShape.backdropClass, modalAlign: modalShape.align,
    });
  }

  if (!built.length) {
    warnings.push('no built screen files under lib/screens — empty canonical');
    return { screens: [], modals: [], templates: [], components: [], entryCanonicalId: null, edges: [], warnings, mappingRate: { mapped: 0, total: 0 } };
  }

  // Index by frame core (for modal-base resolution) + by widget class + by route.
  const byClass = new Map<string, BuiltScreen>();
  const byRoute = new Map<string, BuiltScreen>();
  const byFrameCore = new Map<string, BuiltScreen>();
  for (const b of built) {
    byClass.set(b.widgetClass, b);
    if (b.route) byRoute.set(b.route, b);
    byFrameCore.set(b.frameCore, b);
  }

  const screenFiles = built.filter(b => !b.isModal);
  const modalFiles = built.filter(b => b.isModal);

  // 2) Canonical screens (one per non-modal screen file). canonicalId for a screen
  //    uses the `c_` namespace (canonicalIdFor on the frame), matching reduce.
  const screens: CanonicalScreen[] = [];
  const canonByClass = new Map<string, string>();   // widget class → screen canonicalId
  for (const b of screenFiles) {
    const canonicalId = b.canonicalId.startsWith('c_') ? b.canonicalId : canonicalIdFor(b.frameCore);
    const route = b.route ?? routeForCanonicalId(canonicalId);
    screens.push({
      canonicalId,
      name: deriveScreenName(b),
      route,
      role: 'screen',
      frameIds: [b.frameId],
      states: [{ id: 'default', frameId: b.frameId, brief: deriveBrief(b) }],
    });
    canonByClass.set(b.widgetClass, canonicalId);
  }
  screens.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  // 3) Modals. Each modal-shaped screen → a canonical modal whose base is the
  //    embedded backdrop screen class (resolved to its canonical id). The trigger
  //    fromScreen is the base (the modal is presented FROM the screen it overlays).
  const modals: CanonicalModal[] = [];
  const modalCanonByFrameCore = new Map<string, string>();   // frame core → modal canonicalId
  for (const b of modalFiles) {
    const canonicalId = modalIdFor(b.frameCore);
    modalCanonByFrameCore.set(b.frameCore, canonicalId);
    // Resolve the base: the embedded backdrop screen class → a canonical screen id.
    let baseCanonicalId = '';
    if (b.backdropClass && canonByClass.has(b.backdropClass)) {
      baseCanonicalId = canonByClass.get(b.backdropClass)!;
    }
    // AI fallback (optional, ambiguous-only): when no backdrop class resolved, ask
    // the model which screen this modal overlays. Deterministic scan is primary.
    if (!baseCanonicalId && !opts.noAi && opts.model && opts.runModel) {
      const aiBase = await aiClassifyModalBase(b, screens, opts);
      if (aiBase && screens.some(s => s.canonicalId === aiBase)) baseCanonicalId = aiBase;
    }
    const edgeType = b.modalAlign === 'center' ? 'dialog' : b.modalAlign === 'fill' ? 'overlay' : 'modal';
    if (!baseCanonicalId) {
      warnings.push(`modal "${deriveScreenName(b)}" (${b.base}) has no detectable base screen (no embedded backdrop) — base left empty (HITL checkpoint)`);
      modals.push({ canonicalId, name: deriveScreenName(b), frameId: b.frameId, baseCanonicalId: '', trigger: { fromScreen: '', edgeType } });
      continue;
    }
    modals.push({
      canonicalId, name: deriveScreenName(b), frameId: b.frameId, baseCanonicalId,
      trigger: { fromScreen: baseCanonicalId, edgeType },
    });
  }
  modals.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  // Helper: a route string → the canonical id (screen OR modal) it targets.
  const canonForRoute = (route: string): string | null => {
    const b = byRoute.get(route);
    if (!b) return null;
    if (b.isModal) return modalCanonByFrameCore.get(b.frameCore) ?? null;
    return canonByClass.get(b.widgetClass) ?? null;
  };
  // A route CONST name → canonical id (nav scans capture AppRoutes.<const>).
  const canonForConst = (constName: string): string | null => {
    const route = constToRoute.get(constName);
    return route ? canonForRoute(route) : null;
  };

  // 4) Components — every lib/components/*.dart class (the 7a output). usedIn is
  //    every screen/modal that imports + uses the component.
  const components = await deriveComponents(projectRoot, built);

  // 5) Flow edges — scan each screen's (and components') forward-nav calls. The
  //    SOURCE of an edge is the file's canonical id; a modal file's source resolves
  //    to its BASE (you trigger the next thing from the screen the modal sits over).
  const componentNav = await indexComponentNav(projectRoot);
  const edges: CanonicalFlowEdge[] = [];
  const seenEdge = new Set<string>();
  const sourceCanonFor = (b: BuiltScreen): string | null => {
    if (b.isModal) {
      const m = modals.find(x => x.canonicalId === modalCanonByFrameCore.get(b.frameCore));
      return m?.baseCanonicalId || null;
    }
    return canonByClass.get(b.widgetClass) ?? null;
  };
  for (const b of built) {
    const from = sourceCanonFor(b);
    if (!from) continue;
    // nav targets in the file + any component it imports.
    const targets = collectNavTargets(b.src, constToRoute);
    for (const imp of importedComponents(b.src)) {
      for (const t of (componentNav.get(imp) ?? [])) targets.push(t);
    }
    for (const t of targets) {
      const to = t.constName ? canonForConst(t.constName) : (t.route ? canonForRoute(t.route) : null);
      if (!to || to === from) continue;
      const isOverlay = modals.some(m => m.canonicalId === to);
      const kind = isOverlay ? 'overlay' : (t.kind === 'replace' ? 'push' : t.kind);
      const key = `${from}|${to}|${kind}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from, to, kind, ...(t.label ? { label: t.label } : {}) });
    }
  }
  // Edges where the base screen presents its OWN modal (a screen file that IS a
  // modal-as-route, reached via a push) are added explicitly so the modal appears
  // in the flow even if the base never names the modal route directly.
  for (const m of modals) {
    if (!m.baseCanonicalId) continue;
    const key = `${m.baseCanonicalId}|${m.canonicalId}|overlay`;
    if (seenEdge.has(key)) continue;
    // only add if the base actually pushes the modal's route (verified above) OR
    // there is a clear backdrop binding — the backdrop binding is authoritative.
    seenEdge.add(key);
    edges.push({ from: m.baseCanonicalId, to: m.canonicalId, kind: 'overlay', ...(m.trigger.element ? { label: m.trigger.element } : {}) });
  }
  edges.sort((a, b) => (a.from.localeCompare(b.from)) || (a.to.localeCompare(b.to)) || a.kind.localeCompare(b.kind));

  // entry: the app's initial route → its canonical id. app_routes.entry / the
  // router initialRoute drives this. Falls back to the first screen by id.
  let entryCanonicalId: string | null = entryRoute ? canonForRoute(entryRoute) : null;
  if (!entryCanonicalId && screens.length) {
    entryCanonicalId = screens[0].canonicalId;
    warnings.push('no entry route resolved from the router — defaulted entry to the first screen by id');
  }

  // 6) Templates — OPTIONAL/coarse. Group screens with an identical structural
  //    signature (their top-level Screen build skeleton). Low-confidence groups
  //    are left out rather than guessed. A template needs ≥2 members.
  const templates = deriveTemplates(screenFiles, screens, canonByClass, warnings);

  // mapping rate: every canonical screen id maps to a real screen file by
  // construction here (we built them FROM the files), so this is the proof number.
  const totalIds = screens.length + modals.length;
  const mappedIds = screens.length + modals.filter(m => m.baseCanonicalId).length;

  if (!edges.length && hasRouter) {
    warnings.push('0 flow edges derived from code — screens declare no forward Navigator calls reaching a known route');
  }

  return {
    screens, modals, templates, components,
    entryCanonicalId, edges, warnings,
    mappingRate: { mapped: mappedIds, total: totalIds },
  };
}

// ── screen identity / header parsing ─────────────────────────────────────────

interface ScreenHeader { canonicalId: string | null; route: string | null }

/** Parse the build's `// canonicalId: c_<frame>  route: <route>` header marker. */
function parseHeader(src: string): ScreenHeader {
  const m = /^\/\/\s*canonicalId:\s*(\S+)(?:\s+route:\s*(\S+))?/m.exec(src);
  return { canonicalId: m?.[1] ?? null, route: m?.[2] ?? null };
}

/**
 * Resolve a screen file's canonical identity. Order of trust (mirrors how
 * flow-wiring/semantic-rename resolve identity):
 *   1. the header `// canonicalId:` marker (authoritative);
 *   2. the filename `screen_<frame>.dart` → frame core;
 *   3. the class name (last resort, so a marker-less, non-screen_-named file still
 *      gets a SAFE, stable id rather than crashing).
 */
function resolveScreenIdentity(
  base: string, widgetClass: string, headerId: string | null,
): { canonicalId: string; frameCore: string; frameId: string } {
  if (headerId) {
    const core = idCore(headerId);
    return { canonicalId: headerId, frameCore: core, frameId: frameIdFromCore(core) };
  }
  const fnMatch = /^screen_([0-9]+_[0-9]+)\.dart$/.exec(base);
  if (fnMatch) {
    const core = fnMatch[1];
    return { canonicalId: canonicalIdFor(core), frameCore: core, frameId: frameIdFromCore(core) };
  }
  // No marker, no screen_<frame> name (e.g. link_banks_screen.dart with no header)
  // → derive a stable id from the class name. Safe + deterministic; never throws.
  const core = widgetClass.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return { canonicalId: canonicalIdFor(core), frameCore: core, frameId: core };
}

/** `290:3657` from a frame core `290_3657`; non-numeric cores pass through. */
function frameIdFromCore(core: string): string {
  const m = /^([0-9]+)_([0-9]+)$/.exec(core);
  return m ? `${m[1]}:${m[2]}` : core;
}

function idCore(id: string): string {
  return String(id).replace(/^[cm]_/, '');
}

/** First top-level `class XScreen extends State{less,ful}Widget` (same as passes). */
function topLevelScreenClass(src: string): string | null {
  const m = /^class\s+([A-Za-z_][A-Za-z0-9_]*Screen)\s+extends\s+State(?:less|ful)Widget\b/m.exec(src);
  return m ? m[1] : null;
}

/** A human screen name from the header's quoted descriptor, else the class name.
 *  Cosmetic only — routes key on the id, not this. */
function deriveScreenName(b: BuiltScreen): string {
  // header line 2 often reads: `// "iPhone…" — <Human Title> ...` — pull the title.
  const titleM = /^\/\/\s*"[^"]*"\s*[—-]\s*([^.(/\n]+)/m.exec(b.src);
  if (titleM) {
    // Take the leading noun phrase: trim filler words ("modal presented OVER…",
    // "Full-screen page…") and keep a short, readable title. Cosmetic only.
    let t = titleM[1].trim().replace(/\s+/g, ' ');
    t = t.replace(/\b(modal|overlay|presented|reached|full[- ]screen|page|state)\b.*$/i, '').trim();
    t = t.replace(/[.,;:].*$/, '').trim();
    const tokens = t.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
    if (tokens.length) return camelScreenName(tokens.join(' '));
  }
  // else derive from the class: LinkBanksScreen → linkBanksScreen. For a machine
  // class (IPhone1415Pro69Screen) there's no readable name → fall back to the id.
  const stripped = b.widgetClass.replace(/^IPhone\d+(?:Pro|Plus|Max)?\d*/, '');
  if (stripped && /^[A-Z]/.test(stripped) && !/^Pro\d/.test(stripped)) {
    return stripped[0].toLowerCase() + stripped.slice(1);
  }
  if (!/^IPhone\d/.test(b.widgetClass)) {
    return b.widgetClass[0].toLowerCase() + b.widgetClass.slice(1);
  }
  // pure machine class with no header title → a stable id-derived name.
  return camelScreenName(b.frameCore.replace(/_/g, ' ')) ;
}

function camelScreenName(title: string): string {
  const tokens = title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'screen';
  const camel = tokens.map((t, i) => i === 0 ? t.toLowerCase() : t[0].toUpperCase() + t.slice(1).toLowerCase()).join('');
  return /screen$/i.test(camel) ? camel : camel + 'Screen';
}

/** A short brief for the default state (the header title, else the name). */
function deriveBrief(b: BuiltScreen): string {
  const titleM = /^\/\/\s*"[^"]*"\s*[—-]\s*([^.(/\n]+)/m.exec(b.src);
  if (titleM) return titleM[1].trim().replace(/\s+/g, ' ').slice(0, 48);
  return deriveScreenName(b);
}

// ── modal-as-route shape detection (mirrors modal-overlay.inspectModalRoute) ──

interface ModalShape { isModal: boolean; backdropClass: string | null; align: 'bottom' | 'center' | 'fill' | 'unknown' }

/**
 * Detect the modal-as-route shape: a Stack with an embedded base Screen as a
 * dimmed backdrop (Positioned.fill / IgnorePointer wrapping an XScreen()) + a
 * scrim + an aligned sheet. This is the SAME shape modal-overlay.ts converts. We
 * also accept a header that explicitly calls itself a modal/overlay presented OVER
 * a base. A plain screen (no embedded backdrop screen) is NOT a modal.
 */
function inspectModalShape(src: string, ownClass: string): ModalShape {
  const body = classBuild(src, ownClass) ?? src;
  // backdrop: an embedded OTHER screen widget inside a Positioned.fill/IgnorePointer.
  const backdropM =
    /(?:Positioned\.fill|IgnorePointer)[\s\S]{0,160}?\b([A-Z][A-Za-z0-9_]*Screen)\s*\(/.exec(body) ??
    /\b([A-Z][A-Za-z0-9_]*Screen)\s*\(\s*\)/.exec(body);
  let backdropClass = backdropM ? backdropM[1] : null;
  if (backdropClass === ownClass) backdropClass = null;   // a screen embedding ITSELF isn't a backdrop
  const hasScrim = /scrim|barrierColor|Color\(0x[0-9A-Fa-f]{2}0{6}\)|withOpacity|Opacity\b/i.test(body);
  const headerSaysModal = /\bmodal\b|\boverlay\b|presented OVER|loading state/i.test(src.slice(0, 600));
  // A modal requires an embedded backdrop screen (the base it overlays). The scrim
  // / header signal alone is not enough (avoids classifying a normal screen as modal).
  const isModal = !!backdropClass && (hasScrim || headerSaysModal);
  let align: ModalShape['align'] = 'unknown';
  if (/Alignment\.bottom(Center|Left|Right)/.test(body)) align = 'bottom';
  else if (/alignment:\s*Alignment\.center\b/.test(body)) align = 'center';
  else if (/Positioned\.fill/.test(body) && !backdropClass) align = 'fill';
  return { isModal, backdropClass, align };
}

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

/** The build() body of `name`'s class (stateless), or its State class (stateful). */
function classBuild(src: string, name: string): string | null {
  const cls = findClass(src, name);
  if (cls) { const b = buildBodyOf(cls); if (b) return b; }
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

// ── route table + routing (mirrors flow-wiring.readRouteTable) ────────────────

interface Routing {
  constToRoute: Map<string, string>;
  routeToConst: Map<string, string>;
  entryRoute: string | null;
  hasRouter: boolean;
}

async function readRouting(projectRoot: string): Promise<Routing> {
  const constToRoute = new Map<string, string>();
  const routeToConst = new Map<string, string>();
  let entryRoute: string | null = null;
  let hasRouter = false;

  // app_routes.dart — the route table (const → route string), incl. `entry`.
  try {
    const src = await fs.readFile(path.join(projectRoot, 'lib', 'app_routes.dart'), 'utf8');
    hasRouter = true;
    const re = /static\s+const\s+String\s+([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      constToRoute.set(m[1], m[2]);
      // First const for a route string wins (keep the specific one, not the `entry` alias).
      if (!routeToConst.has(m[2]) || m[1] !== 'entry') {
        if (m[1] !== 'entry') routeToConst.set(m[2], m[1]);
        else if (!routeToConst.has(m[2])) routeToConst.set(m[2], m[1]);
      }
    }
    if (constToRoute.has('entry')) entryRoute = constToRoute.get('entry')!;
  } catch { /* no routes table */ }

  // app_router.dart — confirm a router exists and pick up initialRoute if present.
  try {
    const src = await fs.readFile(path.join(projectRoot, 'lib', 'app_router.dart'), 'utf8');
    hasRouter = true;
    // initialRoute: AppRoutes.<const> → its route string.
    const irConst = /initialRoute:\s*AppRoutes\.([A-Za-z0-9_]+)/.exec(src);
    if (irConst && constToRoute.has(irConst[1])) entryRoute = constToRoute.get(irConst[1])!;
    else {
      const irLit = /initialRoute:\s*'([^']+)'/.exec(src);
      if (irLit) entryRoute = irLit[1];
    }
  } catch { /* no router file */ }

  return { constToRoute, routeToConst, entryRoute, hasRouter };
}

// ── nav-call scanning (mirrors flow-wiring.collectNavTargets) ─────────────────

interface NavTarget {
  /** route string if resolvable. */
  route: string | null;
  /** the route const name captured (AppRoutes.<const>), if any. */
  constName: string | null;
  /** edge kind inferred from the call: push | replace | tab. */
  kind: string;
  /** a label for the edge if a nearby text/label is found (best-effort). */
  label?: string;
}

/**
 * Collect every FORWARD navigation target a Dart source reaches. Handles
 * Navigator.push/pushNamed/pushReplacementNamed/pushAndRemoveUntil(AppRoutes.X or
 * '<literal>'), Navigator.of(context).push*, and context.go/push/pushNamed/goNamed.
 * A pop/maybePop is NOT forward nav and is ignored (we only scan named/route nav).
 */
function collectNavTargets(src: string, constToRoute: Map<string, string>): NavTarget[] {
  const out: NavTarget[] = [];
  const seen = new Set<string>();
  const add = (route: string | null, constName: string | null, kind: string) => {
    const key = `${constName ?? ''}|${route ?? ''}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ route, constName, kind });
  };

  // a) AppRoutes.<const> in a push call. We capture the const + classify the kind
  //    by the push variant immediately preceding it on the same call.
  const constRe = /\.(push|pushNamed|pushReplacementNamed|pushReplacement|pushAndRemoveUntil)\s*\([^;]*?AppRoutes\.([A-Za-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(src)) !== null) {
    const kind = /Replacement/.test(m[1]) ? 'replace' : 'push';
    add(constToRoute.get(m[2]) ?? null, m[2], kind);
  }
  // a2) bare AppRoutes.<const> not caught above (defensive) — treat as push.
  const bareConstRe = /AppRoutes\.([A-Za-z0-9_]+)\b/g;
  while ((m = bareConstRe.exec(src)) !== null) {
    if (m[1] === 'entry') continue;
    add(constToRoute.get(m[1]) ?? null, m[1], 'push');
  }
  // b) named nav with a string literal route.
  const litRe = /push(Named|ReplacementNamed)?\s*\(\s*(?:context\s*,\s*)?'([^']+)'/g;
  while ((m = litRe.exec(src)) !== null) {
    const kind = m[1] && /Replacement/.test(m[1]) ? 'replace' : 'push';
    add(m[2], null, kind);
  }
  // c) GoRouter.
  const goRe = /\bcontext\s*\.\s*(go|push|pushNamed|goNamed)\s*\(\s*'([^']+)'/g;
  while ((m = goRe.exec(src)) !== null) {
    add(m[2], null, /^go/.test(m[1]) ? 'replace' : 'push');
  }
  return out;
}

// ── components ────────────────────────────────────────────────────────────────

/** Enumerate lib/components/*.dart top-level public classes → canonical components,
 *  with usedIn = the canonical screens that import + reference the component. */
async function deriveComponents(projectRoot: string, built: BuiltScreen[]): Promise<CanonicalComponent[]> {
  const compDir = path.join(projectRoot, 'lib', 'components');
  let files: string[] = [];
  try { files = (await fs.readdir(compDir)).filter(f => f.endsWith('.dart')); } catch { return []; }
  files.sort();

  // Map each screen file's canonical id (screens use c_, modals' file → base id is
  // resolved separately; for usage we credit the FILE's own id where it's a screen).
  const screenIdByFile = new Map<string, string>();
  for (const b of built) {
    // Components are "used in" the screen/modal FILE; credit a screen id (c_) for a
    // screen, and the modal's own id is not a screen — use the file's resolved id.
    screenIdByFile.set(b.base, b.canonicalId.startsWith('c_') || b.canonicalId.startsWith('m_') ? b.canonicalId : canonicalIdFor(b.frameCore));
  }

  const components: CanonicalComponent[] = [];
  for (const f of files) {
    const abs = path.join(compDir, f);
    const src = await fs.readFile(abs, 'utf8');
    const cls = topLevelPublicClass(src);
    if (!cls) continue;
    const importToken = `components/${f}`;
    const usedIn = new Set<string>();
    let count = 0;
    for (const b of built) {
      // a screen uses the component when it imports the component file AND
      // references the class (a call `Cls(`).
      const importsIt = b.src.includes(`/${importToken}'`) || b.src.includes(`${importToken}'`);
      if (!importsIt) continue;
      const uses = (b.src.match(new RegExp(`\\b${escapeRe(cls)}\\s*\\(`, 'g')) || []).length;
      if (uses > 0) {
        usedIn.add(screenIdByFile.get(b.base) ?? b.canonicalId);
        count += uses;
      }
    }
    components.push({
      canonicalName: cls[0].toLowerCase() + cls.slice(1),
      kind: componentKind(cls),
      usedIn: [...usedIn].sort(),
      count: count || usedIn.size,
    });
  }
  components.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return components;
}

/** First top-level public (non-underscore) class in a component file. */
function topLevelPublicClass(src: string): string | null {
  const m = /^class\s+([A-Z][A-Za-z0-9_]*)\b/m.exec(src);
  return m ? m[1] : null;
}

/** The component import tokens a screen source references (`components/foo.dart`). */
function importedComponents(src: string): string[] {
  const out: string[] = [];
  const re = /import\s+'[^']*?(components\/[A-Za-z0-9_]+\.dart)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Index lib/components/*.dart for hardcoded Navigator targets (a component may
 *  itself navigate). Keyed by `components/<file>.dart`. */
async function indexComponentNav(projectRoot: string): Promise<Map<string, NavTarget[]>> {
  const out = new Map<string, NavTarget[]>();
  const compDir = path.join(projectRoot, 'lib', 'components');
  // Need the route table for const resolution; re-read (cheap, idempotent).
  const { constToRoute } = await readRouting(projectRoot);
  let files: string[] = [];
  try { files = (await fs.readdir(compDir)).filter(f => f.endsWith('.dart')); } catch { return out; }
  for (const f of files) {
    const src = await fs.readFile(path.join(compDir, f), 'utf8');
    const targets = collectNavTargets(src, constToRoute);
    if (targets.length) out.set(`components/${f}`, targets);
  }
  return out;
}

// ── templates (coarse structural grouping) ────────────────────────────────────

/** Group screens with an identical coarse structural signature into a template.
 *  Low-confidence (singletons) are not templates. The signature is a structural
 *  fingerprint of the screen's build skeleton (Capitalized constructors + named-arg
 *  keys, leaf values normalized) — divergent layouts won't collide. */
function deriveTemplates(
  screenFiles: BuiltScreen[],
  screens: CanonicalScreen[],
  canonByClass: Map<string, string>,
  warnings: string[],
): CanonicalTemplate[] {
  const sigByCanon = new Map<string, string>();
  for (const b of screenFiles) {
    const canon = canonByClass.get(b.widgetClass);
    if (!canon) continue;
    const body = classBuild(b.src, b.widgetClass);
    if (!body) continue;
    sigByCanon.set(canon, structuralSignature(body));
  }
  const groups = new Map<string, string[]>();
  for (const [canon, sig] of sigByCanon) {
    if (!sig) continue;
    (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(canon);
  }
  const templates: CanonicalTemplate[] = [];
  for (const [sig, members] of groups) {
    if (members.length < 2) continue;
    const sortedMembers = [...members].sort();
    const id = 't_' + crypto.createHash('sha256').update(sig).digest('hex').slice(0, 10);
    // sharedSections: a coarse, readable hint (the top-level widget kinds in order).
    const sharedSections = sig.split(' ').filter(t => /^[A-Z]/.test(t)).slice(0, 8);
    templates.push({ id, memberCanonicalIds: sortedMembers, sharedSections });
    for (const cid of sortedMembers) {
      const s = screens.find(x => x.canonicalId === cid);
      if (s) s.templateRef = id;
    }
  }
  templates.sort((a, b) => a.id.localeCompare(b.id));
  if (!templates.length && screenFiles.length >= 2) {
    warnings.push('no templates derived (screens have distinct structures) — templates left empty (low-confidence, not guessed)');
  }
  return templates;
}

/** Coarse structural signature of a build body: Capitalized constructors + named-
 *  arg keys kept; leaf values collapsed. (A trimmed version of the 7a signature.) */
function structuralSignature(body: string): string {
  const toks = body.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|0x[0-9A-Fa-f]+|\b\d+(?:\.\d+)?\b|[A-Za-z_$][A-Za-z0-9_$]*|[{}()\[\],.:?;<>]/g) || [];
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^['"]/.test(t)) { out.push('S'); continue; }
    if (/^(0x|\d)/.test(t)) { out.push('N'); continue; }
    if (/^[A-Za-z_$]/.test(t)) {
      if (/^[A-Z]/.test(t)) { out.push(t); continue; }
      const next = toks[i + 1];
      if (next === ':') { out.push(`${t}:`); i++; continue; }
      out.push('v'); continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

// ── AI seam (ambiguous modal-base classification only) ───────────────────────

async function aiClassifyModalBase(
  modal: BuiltScreen, screens: CanonicalScreen[], opts: ResolveCanonicalOptions,
): Promise<string | null> {
  if (!opts.model || !opts.runModel) return null;
  const list = screens.map(s => `- ${s.canonicalId}: ${s.name}`).join('\n');
  const prompt = [
    `You are classifying which screen a MODAL overlays in a Flutter app.`,
    `Modal: "${deriveScreenName(modal)}" (file ${modal.base}).`,
    `It is presented as an overlay over ONE of these base screens:`,
    list,
    ``,
    `Modal source (first 4000 chars):`,
    modal.src.slice(0, 4000),
    ``,
    `Reply with EXACTLY one JSON object, no prose:`,
    `{"baseCanonicalId":"<one of the canonicalIds above, or empty string>"}`,
  ].join('\n');
  // AI classifies an AMBIGUOUS modal→base binding over a deterministic primary
  // (per RFC Phase 1′: AI only for genuinely ambiguous classification). On
  // failure: conservative no-op (leave the modal unbound → surfaced, not
  // guess-wired), but LOGGED (RFC §0.1 — not silent).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.log('[ai:resolve-modal] status=empty — no JSON; modal left unbound'); return null; } // eslint-disable-line no-console
    const id = (JSON.parse(m[0]) as { baseCanonicalId?: string }).baseCanonicalId;
    return id && id.trim() ? id.trim() : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[ai:resolve-modal] status=error — ${(e as Error).message.slice(0, 80)}; modal left unbound`);
    return null;
  }
}

// ── shared low-level utils ────────────────────────────────────────────────────

/** Balanced `{}` matcher that is STRING- AND COMMENT-aware. Skipping comments
 *  matters: an apostrophe inside a `//` comment (`don't`) would otherwise corrupt
 *  string tracking and make brace matching fail (the modal-shape mis-detection /
 *  "unexpected shape" class of bug). */
function matchBrace(s: string, open: number): number {
  let depth = 0; let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]; const prev = s[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================================
// React strategy (seam only — flutter ships; react contract is stubbed)
// =============================================================================

const reactStrategy: ResolveStrategy = {
  framework: 'react',
  async derive(_projectId, _opts) {
    // TODO(react-resolve): enumerate src/pages|screens route components (file-based
    // router or a <Routes>/createBrowserRouter table) → canonical screens by their
    // route + a header/marker id; src/components/* → canonical components by import
    // usage; scan useNavigate()/navigate('/x')/<Link to>/router.push for flow edges;
    // detect portal/dialog modals (Radix Dialog / a barrier overlay) for modals.
    // Mirrors the flutter strategy. For now: empty + a warning.
    return {
      screens: [], modals: [], templates: [], components: [],
      entryCanonicalId: null, edges: [],
      warnings: ['react resolve strategy not implemented (flutter ships first)'],
      mappingRate: { mapped: 0, total: 0 },
    };
  },
};
