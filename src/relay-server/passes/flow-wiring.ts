// =============================================================================
// File: src/relay-server/passes/flow-wiring.ts
//
// Phase 7d — Flow-wiring verification + safe auto-fix (production-readiness pass).
//
// A canonical FLOW (canonical.json `flow.edges[]`) is the AUTHORITATIVE nav graph
// of the design: each edge `{from, to, kind, label}` says "from screen FROM, the
// element LABEL navigates to screen TO". The per-screen build phase wires its own
// `Navigator.push*` calls per screen, but those frequently DRIFT from the design
// flow: a button points at an intermediate/wrong route, a target is never reached,
// or a trigger element exists with a dead/empty handler.
//
// This pass VERIFIES — it is NOT a rebuild. For every canonical flow edge it:
//   - resolves the FROM and TO canonical screens → their built Dart files + the
//     route name each screen is registered under (router/route-table);
//   - scans the FROM screen's code (AND any 7a-extracted shared components it uses)
//     for a navigation call (`Navigator.push/pushNamed/pushReplacementNamed/…`,
//     `context.go`, GoRouter, etc.) that lands on the TO screen's route;
//   - classifies the edge: `wired` | `wrong-target` | `missing` | `dead-trigger`
//     (element exists but its handler is empty/TODO) | `unmapped` (a screen has no
//     built file — design/build drift).
//
// SAFE AUTO-FIX (conservative): ONLY when an edge is `dead-trigger` (the element
// exists but its onTap/onPressed handler is empty / `() {}` / `null` / `// TODO`)
// AND the TO route UNAMBIGUOUSLY exists, the empty handler is wired to push that
// route. We NEVER invent UI elements, NEVER guess a target when ambiguous, NEVER
// touch an already-wired edge, and NEVER rewrite a `wrong-target` (the design may
// be the stale side — that is a human call). Everything else stays a finding.
//
// FRAMEWORK-AGNOSTIC. detectFramework() (same contract as 7a/7b/7c) dispatches to
// a per-framework `FlowStrategy`. Flutter ships a full implementation; react is a
// stubbed seam so the contract is visible.
//
// DETERMINISTIC core: route resolution, the AST/text scan for nav calls, the
// classification, and the report are all pure source analysis. AI (runModel) is
// used ONLY for fuzzy element matching — mapping a canonical `element` LABEL onto
// the actual widget in code when it is not literal, and disambiguating which of
// several candidate buttons is the trigger. The report + every status is computed
// deterministically; AI never changes a status, only helps LOCATE an element for a
// dead-trigger auto-fix.
//
// IDEMPOTENT: a second run produces the SAME report and applies 0 new fixes — an
// edge wired by a prior run reads as `wired` and is skipped.
//
// Input: <projectRoot>/.uix/canonical.json (the canonicalize() output).
// Output: <projectRoot>/.uix/flow-wiring-report.json (the primary deliverable).
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AIModel } from '../ai-adapters';

// ── Public contract ──────────────────────────────────────────────────────────

export type Framework = 'flutter' | 'react' | 'unknown';

export type EdgeStatus =
  | 'wired'         // a nav call from FROM lands on TO's route
  | 'wrong-target'  // a nav call exists on FROM but lands on a DIFFERENT route
  | 'missing'       // no nav call on FROM reaches TO and no matching dead trigger
  | 'dead-trigger'  // the element exists on FROM but its handler is empty/TODO
  | 'unmapped';     // FROM or TO has no built screen file (design/build drift)

export interface FlowWiringOptions {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** AI model used ONLY for fuzzy element→widget matching / trigger disambiguation. */
  model?: AIModel;
  /** Skip AI entirely (deterministic-only). Default false. */
  noAi?: boolean;
  /** Only report; never auto-fix dead triggers. Default false. */
  dryRun?: boolean;
  /** Disable the safe auto-fix entirely (report-only run). Default false. */
  noAutoFix?: boolean;
  /** Optional injected model runner (defaults to relay's runModel via the route). */
  runModel?: RunModelFn;
  /** Env for the model runner. */
  env?: NodeJS.ProcessEnv;
  /** Restrict to edges whose FROM canonicalId is in this set (testing). */
  onlyFrom?: string[];
  /** Override the root used to read canonical.json (testing). */
  canonicalRoot?: string;
  /** Where to write the report (default <projectRoot>/.uix/flow-wiring-report.json). */
  reportPath?: string;
  /** Skip writing the report file (testing). Default false. */
  noReport?: boolean;
}

export type RunModelFn = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { format?: 'text' | 'json' | 'stream-json' },
) => Promise<{ text: string }>;

export interface EdgeFinding {
  /** FROM canonical screen id (verbatim from the edge). */
  from: string;
  /** TO canonical id (screen or modal). */
  to: string;
  /** Edge kind from canonical flow (push|overlay|tab|…). */
  kind: string;
  /** The canonical element/label that should trigger this nav, if any. */
  element?: string;
  status: EdgeStatus;
  /** Built file for FROM (relative to root), if mapped. */
  fromFile?: string;
  /** Built file for TO (relative to root), if mapped. */
  toFile?: string;
  /** The route TO is registered under (resolved from its header / route table). */
  toRoute?: string;
  /** The route const name TO resolves to (e.g. `c2904060`), if found. */
  toRouteConst?: string;
  /** For wrong-target: the route the FROM screen actually navigates to. */
  actualTargetRoute?: string;
  /** For wrong-target: that route's canonical id, if resolvable. */
  actualTargetCanonicalId?: string;
  /** Human-readable detail of the finding. */
  detail: string;
  /** True when this edge was auto-fixed in this run. */
  autoFixed?: boolean;
  /** How the trigger element was located (for dead-trigger handling). */
  elementHow?: 'deterministic' | 'ai' | 'none';
}

export interface FlowWiringReport {
  version: 1;
  projectId: string;
  framework: Framework;
  generatedAt: string;
  /** canonical.json contentHash this report was computed against (drift signal). */
  canonicalHash?: string;
  summary: {
    totalEdges: number;
    wired: number;
    wrongTarget: number;
    missing: number;
    deadTrigger: number;
    unmapped: number;
    autoFixesApplied: number;
    /** screens in canonical flow that mapped to a built file / total referenced. */
    screensMapped: number;
    screensReferenced: number;
  };
  findings: EdgeFinding[];
}

export interface FlowWiringResult {
  report: FlowWiringReport;
  /** Count of dead-trigger edges safely auto-wired this run. */
  autoFixesApplied: number;
  /** Path the report was written to (null if noReport). */
  reportPath: string | null;
  dryRun: boolean;
}

// ── Canonical model (subset we read) ─────────────────────────────────────────

interface CanonFlowEdge { from: string; to: string; kind: string; label?: string }
interface CanonFlow { entryCanonicalId: string | null; edges: CanonFlowEdge[] }
interface CanonScreen { canonicalId: string; name: string; route: string; frameIds: string[] }
interface CanonModalTrigger { fromScreen: string; element?: string; edgeType: string }
interface CanonModal { canonicalId: string; name: string; frameId: string; baseCanonicalId: string; trigger: CanonModalTrigger }
interface CanonModel {
  projectId?: string;
  contentHash?: string;
  screens?: CanonScreen[];
  modals?: CanonModal[];
  flow?: CanonFlow;
}

async function readCanonical(root: string): Promise<CanonModel | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.uix', 'canonical.json'), 'utf8');
    return JSON.parse(raw) as CanonModel;
  } catch {
    return null;
  }
}

// ── Framework detection (same contract as 7a/7b/7c) ──────────────────────────

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

export interface FlowStrategy {
  framework: Framework;
  /**
   * Verify ALL flow edges against the built app, classify each, and apply the safe
   * dead-trigger auto-fix. Returns findings (in canonical edge order) + the count
   * of auto-fixes applied.
   */
  verify(
    projectRoot: string,
    flow: CanonFlow,
    screens: CanonScreen[],
    modals: CanonModal[],
    opts: FlowWiringOptions,
  ): Promise<{ findings: EdgeFinding[]; autoFixes: number; screensMapped: number; screensReferenced: number }>;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function verifyFlowWiring(projectId: string, opts: FlowWiringOptions): Promise<FlowWiringResult> {
  const { projectRoot } = opts;
  const framework = await detectFramework(projectRoot);
  const strategy = getStrategy(framework);
  const canonical = await readCanonical(opts.canonicalRoot ?? projectRoot);

  const emptyReport = (findings: EdgeFinding[], autoFixes: number, mapped: number, refd: number): FlowWiringReport => ({
    version: 1,
    projectId,
    framework,
    generatedAt: new Date().toISOString(),
    ...(canonical?.contentHash ? { canonicalHash: canonical.contentHash } : {}),
    summary: summarize(findings, autoFixes, mapped, refd),
    findings,
  });

  if (!canonical || !canonical.flow || !Array.isArray(canonical.flow.edges)) {
    const report = emptyReport([], 0, 0, 0);
    const reportPath = await maybeWriteReport(projectRoot, report, opts);
    return { report, autoFixesApplied: 0, reportPath, dryRun: !!opts.dryRun };
  }

  if (!strategy) {
    // No strategy: every edge is unverifiable → report it honestly, fix nothing.
    const findings: EdgeFinding[] = canonical.flow.edges.map((e) => ({
      from: e.from, to: e.to, kind: e.kind, ...(e.label ? { element: e.label } : {}),
      status: 'unmapped' as EdgeStatus,
      detail: `no strategy for framework '${framework}' — cannot verify`,
    }));
    const report = emptyReport(findings, 0, 0, 0);
    const reportPath = await maybeWriteReport(projectRoot, report, opts);
    return { report, autoFixesApplied: 0, reportPath, dryRun: !!opts.dryRun };
  }

  let flow = canonical.flow;
  if (opts.onlyFrom?.length) {
    flow = { ...flow, edges: flow.edges.filter((e) => opts.onlyFrom!.includes(e.from)) };
  }

  const { findings, autoFixes, screensMapped, screensReferenced } =
    await strategy.verify(projectRoot, flow, canonical.screens ?? [], canonical.modals ?? [], opts);

  const report = emptyReport(findings, autoFixes, screensMapped, screensReferenced);
  const reportPath = await maybeWriteReport(projectRoot, report, opts);
  return { report, autoFixesApplied: autoFixes, reportPath, dryRun: !!opts.dryRun };
}

function getStrategy(fw: Framework): FlowStrategy | null {
  if (fw === 'flutter') return flutterStrategy;
  if (fw === 'react') return reactStrategy;
  return null;
}

function summarize(findings: EdgeFinding[], autoFixes: number, mapped: number, refd: number): FlowWiringReport['summary'] {
  const count = (s: EdgeStatus) => findings.filter((f) => f.status === s).length;
  return {
    totalEdges: findings.length,
    wired: count('wired'),
    wrongTarget: count('wrong-target'),
    missing: count('missing'),
    deadTrigger: count('dead-trigger'),
    unmapped: count('unmapped'),
    autoFixesApplied: autoFixes,
    screensMapped: mapped,
    screensReferenced: refd,
  };
}

async function maybeWriteReport(projectRoot: string, report: FlowWiringReport, opts: FlowWiringOptions): Promise<string | null> {
  if (opts.noReport) return null;
  const abs = opts.reportPath ?? path.join(projectRoot, '.uix', 'flow-wiring-report.json');
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');
    return abs;
  } catch {
    return null;
  }
}

// =============================================================================
// Flutter strategy
// =============================================================================

interface ResolvedScreen {
  canonicalId: string;
  /** absolute screen file. */
  file: string;
  /** top-level Screen widget class. */
  widgetClass: string;
  /** route string the screen is registered under (from its header). */
  route: string | null;
}

const flutterStrategy: FlowStrategy = {
  framework: 'flutter',
  async verify(projectRoot, flow, screens, modals, opts) {
    return verifyFlutter(projectRoot, flow, screens, modals, opts);
  },
};

async function verifyFlutter(
  projectRoot: string,
  flow: CanonFlow,
  screens: CanonScreen[],
  modals: CanonModal[],
  opts: FlowWiringOptions,
): Promise<{ findings: EdgeFinding[]; autoFixes: number; screensMapped: number; screensReferenced: number }> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');

  // Index every built screen file: canonicalId (header) → {file, class, route}.
  const builtById = new Map<string, ResolvedScreen>();      // by header id core
  const builtByRoute = new Map<string, ResolvedScreen>();   // route string → screen
  let files: string[] = [];
  try { files = (await fs.readdir(screensDir)).filter((f) => f.endsWith('.dart')); } catch { /* none */ }
  for (const f of files) {
    const abs = path.join(screensDir, f);
    const src = await fs.readFile(abs, 'utf8');
    const hm = /^\/\/\s*canonicalId:\s*(\S+)(?:\s+route:\s*(\S+))?/m.exec(src);
    const cls = topLevelScreenClass(src);
    if (!cls) continue;
    const headerId = hm?.[1];
    const route = hm?.[2] ?? null;
    const resolved: ResolvedScreen = { canonicalId: headerId ?? '', file: abs, widgetClass: cls, route };
    if (headerId) builtById.set(idCore(headerId), resolved);
    if (route) builtByRoute.set(route, resolved);
  }

  // Route table: const name → route string (and reverse) from app_routes.dart.
  const { constToRoute, routeToConst } = await readRouteTable(projectRoot);

  // Resolve a canonical id (screen OR modal) → built screen, by header id core,
  // then by frame-id filename fallback. Modals (`m_<frame>`) share the frame core
  // with a built `c_<frame>` file when one exists.
  const resolveCanon = (canonicalId: string, frameIds: string[]): ResolvedScreen | null => {
    const hit = builtById.get(idCore(canonicalId));
    if (hit) return hit;
    for (const fid of frameIds) {
      const fname = `screen_${String(fid).replace(/[^a-zA-Z0-9]+/g, '_')}.dart`;
      const byFile = [...builtById.values()].find((r) => path.basename(r.file) === fname);
      if (byFile) return byFile;
    }
    // last resort: frame core matches a built header core.
    for (const fid of frameIds) {
      const byCore = builtById.get(idCore('c_' + String(fid).replace(/[^a-zA-Z0-9]+/g, '_')));
      if (byCore) return byCore;
    }
    return null;
  };

  // frameIds lookup for screens + modals (modals carry a single frameId).
  const framesFor = (id: string): string[] => {
    const s = screens.find((x) => x.canonicalId === id);
    if (s) return s.frameIds;
    const m = modals.find((x) => x.canonicalId === id);
    if (m) return [m.frameId];
    return [];
  };

  // Map a TO canonical screen → its route const + route string. The route is the
  // one the screen is registered under in the route table. Prefer the screen's
  // header route; cross-check against the route table so we have the const name.
  const routeForCanon = (resolved: ResolvedScreen | null): { route: string | null; constName: string | null } => {
    if (!resolved) return { route: null, constName: null };
    const route = resolved.route;
    if (route && routeToConst.has(route)) return { route, constName: routeToConst.get(route)! };
    return { route, constName: null };
  };

  // Track which referenced screens mapped (for the honest mapping rate).
  const referenced = new Set<string>();
  const mapped = new Set<string>();

  const findings: EdgeFinding[] = [];
  let autoFixes = 0;

  // Cache file sources so multiple edges from the same FROM screen reuse the scan
  // AND see prior auto-fixes within this run (idempotent same-run mutation).
  const srcCache = new Map<string, string>();
  const readSrc = async (file: string): Promise<string> => {
    if (srcCache.has(file)) return srcCache.get(file)!;
    const s = await fs.readFile(file, 'utf8');
    srcCache.set(file, s);
    return s;
  };

  // Pre-collect 7a-extracted shared component files (a FROM screen's nav call may
  // live inside an imported component — look there too to avoid false `missing`).
  const componentNavIndex = await indexComponentNav(projectRoot, constToRoute, builtByRoute, builtById);

  for (const edge of flow.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);

    const fromFrames = framesFor(edge.from);
    const toFrames = framesFor(edge.to);
    const fromScreen = resolveCanon(edge.from, fromFrames);
    const toScreen = resolveCanon(edge.to, toFrames);
    if (fromScreen) mapped.add(edge.from);
    if (toScreen) mapped.add(edge.to);

    const base: EdgeFinding = {
      from: edge.from, to: edge.to, kind: edge.kind,
      ...(edge.label ? { element: edge.label } : {}),
      status: 'unmapped',
      ...(fromScreen ? { fromFile: rel(projectRoot, fromScreen.file) } : {}),
      ...(toScreen ? { toFile: rel(projectRoot, toScreen.file) } : {}),
      detail: '',
    };

    // UNMAPPED: a screen has no built file (true design/build drift).
    if (!fromScreen || !toScreen) {
      const which = !fromScreen && !toScreen ? 'both FROM and TO have' : !fromScreen ? 'FROM has' : 'TO has';
      base.status = 'unmapped';
      base.detail = `${which} no built screen file (canonical refers to a frame the built app does not contain)`;
      findings.push(base);
      continue;
    }

    const { route: toRoute, constName: toConst } = routeForCanon(toScreen);
    if (toRoute) base.toRoute = toRoute;
    if (toConst) base.toRouteConst = toConst;

    const fromSrc = await readSrc(fromScreen.file);

    // Collect all nav targets the FROM screen reaches (its own code + components
    // it uses). A nav target = a route string (resolved from a route const or a
    // literal). We map each back to a canonical id where possible.
    const navTargets = collectNavTargets(fromSrc, constToRoute);
    // Augment with nav targets from imported 7a components used by this screen.
    for (const ct of componentNavIndex.targetsForScreenSrc(fromSrc)) navTargets.push(ct);

    const landsOnTo = navTargets.some((t) => routeMatches(t.route, toRoute, toConst));

    if (landsOnTo) {
      base.status = 'wired';
      base.detail = `FROM navigates to TO's route (${toRoute ?? toConst})`;
      findings.push(base);
      continue;
    }

    // Not wired to TO. Is there a DEAD trigger we can safely fix? Locate an empty
    // handler that the canonical element points at.
    const dead = findDeadTrigger(fromSrc, edge.label);
    let triggerLoc = dead;
    let elementHow: EdgeFinding['elementHow'] = dead ? 'deterministic' : 'none';

    // AI fuzzy element matching: only if there is NO deterministic dead trigger,
    // a label exists, and AI is available. AI returns a verbatim snippet of an
    // EMPTY handler; we still verify it is genuinely empty before treating it as
    // a dead trigger (AI never changes status — only helps locate).
    if (!triggerLoc && edge.label && opts.model && opts.runModel && !opts.noAi) {
      const aiSnippet = await aiLocateDeadTrigger(edge, fromSrc, opts);
      if (aiSnippet) {
        const loc = deadTriggerFromSnippet(fromSrc, aiSnippet);
        if (loc) { triggerLoc = loc; elementHow = 'ai'; }
      }
    }

    if (triggerLoc) {
      base.status = 'dead-trigger';
      base.elementHow = elementHow;
      base.detail = `element '${edge.label ?? '?'}' exists but its handler is empty/TODO (${triggerLoc.kind})`;

      // SAFE AUTO-FIX: only when the TO route UNAMBIGUOUSLY exists (a known route
      // const) AND we are not in dry-run / no-fix mode. Wire the empty handler to
      // push that route. Never touch wired edges; never guess targets.
      const canFix = !opts.dryRun && !opts.noAutoFix && !!toConst;
      if (canFix) {
        const newSrc = wireDeadTrigger(fromSrc, triggerLoc, toConst!);
        if (newSrc && newSrc !== fromSrc) {
          const withImport = ensureRoutesImport(newSrc, fromScreen.file, projectRoot);
          await fs.writeFile(fromScreen.file, withImport, 'utf8');
          srcCache.set(fromScreen.file, withImport);
          base.status = 'wired';
          base.autoFixed = true;
          base.detail = `dead trigger '${edge.label ?? '?'}' auto-wired to push ${toConst} (${toRoute})`;
          autoFixes++;
        } else {
          base.detail += ` — auto-fix skipped (handler shape not safely rewritable)`;
        }
      } else if (!toConst) {
        base.detail += ` — not auto-fixed (TO route const not found in route table; ambiguous)`;
      }
      findings.push(base);
      continue;
    }

    // No dead trigger. Does the FROM screen navigate SOMEWHERE (just not TO)?
    // → wrong-target. Else → missing.
    if (navTargets.length > 0) {
      // Pick the most representative actual target for the report (first one whose
      // route is resolvable; else the first raw).
      const actual = navTargets.find((t) => t.route) ?? navTargets[0];
      const actualCanon = actual.route ? canonForRoute(actual.route, builtByRoute, builtById) : null;
      base.status = 'wrong-target';
      if (actual.route) base.actualTargetRoute = actual.route;
      if (actualCanon) base.actualTargetCanonicalId = actualCanon;
      base.detail = `FROM navigates, but to ${actual.route ?? actual.raw}${actualCanon ? ` (${actualCanon})` : ''}, not TO (${toRoute ?? toConst}) — NOT auto-fixed (the design or the build may be the stale side; human decision)`;
      findings.push(base);
      continue;
    }

    base.status = 'missing';
    base.detail = `no navigation call on FROM reaches TO (${toRoute ?? toConst}); no matching trigger element found — NOT auto-fixed (would require inventing a UI element)`;
    findings.push(base);
  }

  return {
    findings,
    autoFixes,
    screensMapped: mapped.size,
    screensReferenced: referenced.size,
  };
}

// ── route table parsing ──────────────────────────────────────────────────────

async function readRouteTable(projectRoot: string): Promise<{ constToRoute: Map<string, string>; routeToConst: Map<string, string> }> {
  const constToRoute = new Map<string, string>();
  const routeToConst = new Map<string, string>();
  try {
    const src = await fs.readFile(path.join(projectRoot, 'lib', 'app_routes.dart'), 'utf8');
    const re = /static\s+const\s+String\s+([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      constToRoute.set(m[1], m[2]);
      // First const for a route string wins as the canonical const (e.g. `entry`
      // aliases another route — keep the specific one, not the alias).
      if (!routeToConst.has(m[2]) || m[1] !== 'entry') routeToConst.set(m[2], m[1]);
    }
  } catch { /* no route table */ }
  return { constToRoute, routeToConst };
}

// ── nav-call scanning ────────────────────────────────────────────────────────

interface NavTarget {
  /** route string if resolvable (via a route const or a literal). */
  route: string | null;
  /** the raw token we found (route const name or literal). */
  raw: string;
}

/**
 * Collect every navigation target a Dart source reaches. Handles:
 *  - Navigator.push/pushNamed/pushReplacementNamed/pushAndRemoveUntil(... AppRoutes.X)
 *  - Navigator.of(context).pushNamed(AppRoutes.X) / .push*(...)
 *  - context.go / context.push / context.pushNamed (GoRouter)
 *  - Navigator.*Named(context, '<literal route>')
 * A pop / maybePop is NOT a forward nav and is ignored.
 */
function collectNavTargets(src: string, constToRoute: Map<string, string>): NavTarget[] {
  const out: NavTarget[] = [];
  const seen = new Set<string>();
  const add = (raw: string, route: string | null) => {
    const key = `${raw}|${route ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, route });
  };

  // a) AppRoutes.<const> references inside a forward-nav call context. We accept
  //    any AppRoutes.<const> that is NOT immediately a pop. Practically every
  //    AppRoutes.<const> in a screen is a forward nav target.
  const constRe = /AppRoutes\.([A-Za-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(src)) !== null) {
    const c = m[1];
    add(c, constToRoute.get(c) ?? null);
  }

  // b) Named nav with a string literal route: pushNamed(context, '/foo') or
  //    .pushNamed('/foo'). Capture the literal.
  const litRe = /push(?:Named|ReplacementNamed)?\s*\(\s*(?:context\s*,\s*)?'([^']+)'/g;
  while ((m = litRe.exec(src)) !== null) {
    add(m[1], m[1]);
  }

  // c) GoRouter: context.go('/foo') / context.push('/foo') / context.pushNamed('foo').
  const goRe = /\bcontext\s*\.\s*(?:go|push|pushNamed|goNamed)\s*\(\s*'([^']+)'/g;
  while ((m = goRe.exec(src)) !== null) {
    add(m[1], m[1]);
  }

  return out;
}

/** Does a found nav target match the TO screen's route? Matches on route string
 *  OR on the const name (when the target was captured as a const). */
function routeMatches(found: string | null, toRoute: string | null, toConst: string | null): boolean {
  if (!found) return false;
  if (toRoute && found === toRoute) return true;
  if (toConst && found === toConst) return true;
  return false;
}

/** Resolve a route string back to a canonical id by finding the built screen
 *  registered under it (header route), then its header id core → screen id. */
function canonForRoute(route: string, byRoute: Map<string, ResolvedScreen>, byId: Map<string, ResolvedScreen>): string | null {
  const r = byRoute.get(route);
  if (r?.canonicalId) return r.canonicalId;
  // fall back: scan byId for a screen whose route equals this route.
  for (const s of byId.values()) if (s.route === route && s.canonicalId) return s.canonicalId;
  return null;
}

// ── 7a-extracted component nav indexing (avoid false `missing`) ───────────────

interface ComponentNavIndex {
  /** Nav targets reachable through any 7a component a given screen src imports. */
  targetsForScreenSrc(screenSrc: string): NavTarget[];
}

/**
 * A FROM screen's forward nav may be delegated to a shared 7a component (e.g. a
 * PillButton whose onTap is passed in — OR a component that itself contains a
 * Navigator call). We index lib/components/*.dart for nav calls and expose, per
 * screen source, the union of nav targets from the components that screen imports.
 *
 * NOTE: most 7a components take an `onTap`/`onPressed` CALLBACK (the nav stays on
 * the screen — already captured by collectNavTargets). This index only adds value
 * when a component HARDCODES a Navigator call internally; we include it for
 * completeness so a screen delegating nav to such a component is not a false
 * `missing`.
 */
async function indexComponentNav(
  projectRoot: string,
  constToRoute: Map<string, string>,
  _byRoute: Map<string, ResolvedScreen>,
  _byId: Map<string, ResolvedScreen>,
): Promise<ComponentNavIndex> {
  const compDir = path.join(projectRoot, 'lib', 'components');
  const byImportName = new Map<string, NavTarget[]>(); // 'components/foo.dart' → targets
  try {
    const files = (await fs.readdir(compDir)).filter((f) => f.endsWith('.dart'));
    for (const f of files) {
      const src = await fs.readFile(path.join(compDir, f), 'utf8');
      const targets = collectNavTargets(src, constToRoute);
      if (targets.length) byImportName.set(`components/${f}`, targets);
    }
  } catch { /* no components dir */ }

  return {
    targetsForScreenSrc(screenSrc: string): NavTarget[] {
      const out: NavTarget[] = [];
      for (const [imp, targets] of byImportName) {
        // screen imports a component as `import '../components/foo.dart';`
        if (screenSrc.includes(`/${imp}'`) || screenSrc.includes(`${imp}'`)) out.push(...targets);
      }
      return out;
    },
  };
}

// ── dead-trigger detection ────────────────────────────────────────────────────

interface TriggerLoc {
  /** char offset of the handler keyword (`onTap`/`onPressed`) in src. */
  start: number;
  /** char offset just past the handler value (the empty body / null). */
  end: number;
  /** what we matched: empty arrow `() {}`, null, or a TODO-only body. */
  kind: 'empty-block' | 'null-handler' | 'todo-body';
  /** the matched handler text (verbatim). */
  text: string;
  /** the handler keyword (`onTap` | `onPressed`). */
  handler: string;
}

/**
 * Find a DEAD trigger handler on the FROM screen near the canonical element label.
 * A dead handler is `onTap: () {}`, `onTap: null`, `onPressed: () {}`, an arrow
 * whose body is empty / only a `// TODO`, or `onTap: () => null`. When a label is
 * given we prefer a dead handler whose enclosing widget call mentions that label
 * (e.g. `label: 'Continue'`), and we REFUSE to pick one if TWO distinct dead
 * handlers both match the label (ambiguous → no auto-fix; report stays dead-trigger
 * but un-fixed via the caller's toConst gate only fixing unambiguous handlers).
 */
function findDeadTrigger(src: string, label?: string): TriggerLoc | null {
  const all = findAllDeadHandlers(src);
  if (all.length === 0) return null;
  if (!label) {
    // No label to disambiguate: only safe if there is EXACTLY ONE dead handler.
    return all.length === 1 ? all[0] : null;
  }
  // Prefer dead handlers whose enclosing widget call references the label text.
  const labelLc = label.toLowerCase();
  const near = all.filter((h) => enclosingCallMentions(src, h, labelLc));
  if (near.length === 1) return near[0];
  if (near.length > 1) return null; // ambiguous → refuse to guess
  // No label match: fall back to a SINGLE dead handler only.
  return all.length === 1 ? all[0] : null;
}

/** All dead handler sites in src. */
function findAllDeadHandlers(src: string): TriggerLoc[] {
  const out: TriggerLoc[] = [];
  // onTap/onPressed: () {} | () {  } | null | () => null | () { // TODO }
  const re = /\b(onTap|onPressed)\s*:\s*(null|\(\s*\)\s*(?:=>\s*null|\{\s*(?:\/\/[^\n]*\s*)*\}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const handler = m[1];
    const value = m[2];
    let kind: TriggerLoc['kind'];
    if (value === 'null' || /=>\s*null/.test(value)) kind = 'null-handler';
    else if (/\/\//.test(value)) kind = 'todo-body';
    else kind = 'empty-block';
    out.push({ start: m.index, end: m.index + m[0].length, kind, text: m[0], handler });
  }
  return out;
}

/** True when the widget call enclosing a handler site references `labelLc`
 *  (e.g. a `label: 'Continue'` or a child `Text('Continue')`). We look in a
 *  bounded window around the handler (its enclosing balanced call). */
function enclosingCallMentions(src: string, loc: TriggerLoc, labelLc: string): boolean {
  // Expand to the enclosing parenthesised call around the handler.
  const open = findEnclosingOpenParen(src, loc.start);
  if (open < 0) return false;
  const close = matchParen(src, open);
  if (close < 0) return false;
  const call = src.slice(open, close + 1).toLowerCase();
  // direct mention of the label text in a string literal within the call.
  return call.includes(`'${labelLc}'`) || call.includes(`"${labelLc}"`) || call.includes(labelLc);
}

/** Find the `(` of the call that encloses position `pos` (depth-aware). */
function findEnclosingOpenParen(src: string, pos: number): number {
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const c = src[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Build a TriggerLoc from an AI-returned verbatim snippet, verifying it is a
 *  genuinely-empty handler before accepting (AI never changes status). */
function deadTriggerFromSnippet(src: string, snippet: string): TriggerLoc | null {
  const idx = src.indexOf(snippet);
  if (idx < 0) return null;
  const all = findAllDeadHandlers(snippet);
  if (all.length !== 1) return null; // the snippet must isolate exactly one dead handler
  const loc = all[0];
  return { ...loc, start: idx + loc.start, end: idx + loc.end };
}

/** Rewrite an empty handler to push the TO route. Preserves the handler keyword.
 *  `onTap: () {}` / `onTap: null` / `onTap: () => null` →
 *  `onTap: () => Navigator.of(context).pushNamed(AppRoutes.<const>)`. */
function wireDeadTrigger(src: string, loc: TriggerLoc, toConst: string): string | null {
  const replacement = `${loc.handler}: () => Navigator.of(context).pushNamed(AppRoutes.${toConst})`;
  // Replace the exact matched span.
  const before = src.slice(0, loc.start);
  const after = src.slice(loc.end);
  // Safety: the span we replace must equal the recorded text (no drift).
  if (src.slice(loc.start, loc.end) !== loc.text) return null;
  return before + replacement + after;
}

/** Ensure the screen imports app_routes.dart (so AppRoutes resolves after a fix). */
function ensureRoutesImport(src: string, screenFile: string, projectRoot: string): string {
  if (/\bimport\s+'[^']*app_routes\.dart';/.test(src)) return src;
  // screens live in lib/screens/ → ../app_routes.dart
  const line = `import '../app_routes.dart';`;
  const imports = [...src.matchAll(/^import .*$/gm)];
  if (imports.length === 0) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const insertAt = last.index! + last[0].length;
  return src.slice(0, insertAt) + `\n${line}` + src.slice(insertAt);
}

// ── AI seam (fuzzy element location only) ─────────────────────────────────────

async function aiLocateDeadTrigger(edge: CanonFlowEdge, baseSrc: string, opts: FlowWiringOptions): Promise<string | null> {
  if (!opts.model || !opts.runModel) return null;
  const prompt = [
    `You are locating a DEAD trigger element in a Flutter screen. The design flow says`,
    `the element labelled "${edge.label ?? '(unknown)'}" should navigate forward, but its`,
    `handler appears empty. Find the widget whose tap/press handler is EMPTY (an`,
    `\`onTap: () {}\`, \`onTap: null\`, \`onPressed: () {}\`, or an empty/TODO arrow body)`,
    `and that semantically matches the label "${edge.label ?? ''}".`,
    ``,
    `Return the EXACT, verbatim, contiguous source SNIPPET of just that empty handler`,
    `(e.g. \`onTap: () {}\`). It must be a copy-paste-exact substring of the source.`,
    `If no element clearly matches, return an empty snippet.`,
    ``,
    `Screen source:`,
    baseSrc.slice(0, 8000),
    ``,
    `Reply with EXACTLY one JSON object, no prose:`,
    `{"snippet":"<verbatim empty-handler substring, or empty string>"}`,
  ].join('\n');
  // AI is a FUZZY trigger LOCATOR over a deterministic primary (route-push
  // detection). Not an AI-PURPOSE step. On failure: conservative no-op (leave
  // the trigger unwired → reported as deadTrigger for the human), but LOGGED
  // (RFC §0.1 — not silent).
  try {
    const { text } = await opts.runModel(opts.model, prompt, opts.env ?? process.env, opts.projectRoot, { format: 'text' });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.log('[ai:flow-locate] status=empty — no JSON; trigger left unwired'); return null; } // eslint-disable-line no-console
    const s = (JSON.parse(m[0]) as { snippet?: string }).snippet;
    return s && s.trim() && baseSrc.includes(s) ? s : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[ai:flow-locate] status=error — ${(e as Error).message.slice(0, 80)}; trigger left unwired`);
    return null;
  }
}

// ── Dart utilities ────────────────────────────────────────────────────────────

function idCore(id: string): string {
  return String(id).replace(/^[cm]_/, '');
}

function topLevelScreenClass(src: string): string | null {
  const m = /^class\s+([A-Za-z_][A-Za-z0-9_]*Screen)\s+extends\s+State(?:less|ful)Widget\b/m.exec(src);
  return m ? m[1] : null;
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

function rel(root: string, abs: string): string { return path.relative(root, abs); }

// =============================================================================
// React strategy (seam only — Phase 7d ships flutter; react contract is stubbed)
// =============================================================================

const reactStrategy: FlowStrategy = {
  framework: 'react',
  async verify(_projectRoot, flow, _screens, _modals, _opts) {
    // TODO(7d-react): resolve each canonical screen → its built page/route
    // component (file-based router or a <Routes> table), scan the FROM page (and
    // imported components) for navigation (useNavigate()/navigate('/x'),
    // <Link to>, router.push) landing on the TO route, classify each edge, and
    // auto-wire dead onClick handlers (`onClick={() => {}}`) to navigate(toRoute)
    // when the target route unambiguously exists. Mirrors the flutter strategy.
    const findings: EdgeFinding[] = flow.edges.map((e) => ({
      from: e.from, to: e.to, kind: e.kind, ...(e.label ? { element: e.label } : {}),
      status: 'unmapped' as EdgeStatus,
      detail: 'react flow-wiring strategy not implemented (7d ships flutter only)',
    }));
    return { findings, autoFixes: 0, screensMapped: 0, screensReferenced: new Set(flow.edges.flatMap((e) => [e.from, e.to])).size };
  },
};
