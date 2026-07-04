// =============================================================================
// File: src/relay-server/reconcile.ts
//
// RFC §4.5 — the DETERMINISTIC RECONCILIATION GATE (no LLM). The visual verify
// loop only judges *appearance*; it never catches STRUCTURAL drift — a screen
// that invented its own route, hardcoded colours/text-styles instead of importing
// the theme, or skipped the shared widgets still scores a visual "match" and ships
// as `done`. This gate runs after each screen build over the project's source on
// disk and flags that drift so the screen goes to `needs-review` (with a reason),
// NOT silently `done`.
//
// Checks (Flutter-first; web is a lighter best-effort subset):
//   1. ROUTE BACKING — every route *constant referenced* by a screen resolves to a
//      registered route in the canonical route table (a real builder or an explicit
//      stub). A reference to a route that isn't in the plan = drift.
//   2. NO NEW TOP-LEVEL ROUTE — the screen did not register a brand-new top-level
//      route outside the plan (e.g. a literal `'/something'` in onGenerateRoute /
//      routes:{} that isn't a canonical route).
//   3. THEME + SHARED WIDGETS — the screen imports the canonical theme/token file
//      and (when shared components exist) at least references the shared widgets,
//      rather than restyling inline.
//   4. INLINE STYLE LITERALS — flag inline `Color(0x…)` / `Colors.<x>` and inline
//      `TextStyle(...)` / `GoogleFonts.<x>` literals as a soft signal of bypassing
//      the design tokens (the Ping audit found ~56 hardcoded colours + ~38 inline
//      fonts across three screens that all passed visual verify).
//   5. PLACEHOLDER / DEFERRAL markers (P1-core, HIGH) — "placeholder", "real frames
//      come later", "filled in by a later build" in comments/strings. Agents were
//      self-issuing untracked IOUs; a deferral marker fails the gate.
//   6. DEAD HANDLERS (P1-core, HIGH) — empty `onTap: () {}` / `onPressed: () => {}`
//      handlers: wired-looking controls that do nothing (13/13 of Ping's folded
//      modals shipped exactly this way).
//
// Everything is grep/string-level (no AST dependency) so it stays cheap + has no
// new deps. It is GUARDED: it only runs when a canonical skeleton exists (so the
// route table + theme file are known); without canonical context it is a no-op so
// existing non-canonical runs are unaffected.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { planSemanticScreens, computeTabCluster, type Canonical } from './canonicalize';

export interface ReconcileFlag {
  /** machine code so the UI / logs can group: 'unbacked-route' | 'new-route' |
   *  'missing-theme-import' | 'inline-color' | 'inline-textstyle'. */
  code: string;
  severity: 'high' | 'med' | 'low';
  message: string;
}
export interface ReconcileResult {
  /** true when no HIGH-severity flag fired (med/low are advisory, don't block). */
  ok: boolean;
  flags: ReconcileFlag[];
  /** files the gate inspected (project-relative) — for traceability. */
  inspected: string[];
}

// P1-core: PLACEHOLDER / DEFERRAL markers. Agents were observed self-issuing
// untracked IOUs ("placeholder sheet — real frames come later") and shipping the
// stub as done. Any such marker in a COMMENT or STRING LITERAL of the built screen
// is a HIGH flag ('deferred-placeholder') — deferral is forbidden, not trackable.
const PLACEHOLDER_RE = /placeholder|come(?:s)? later|later build|filled in by a later/i;
// P1-core: DEAD interaction handlers — `onTap: () {}`, `onPressed: () {}`,
// `onTap: () => {}` (whitespace-tolerant, any on<Event> name). A wired-looking
// control that does nothing is a shipped defect the visual verify can't see.
const DEAD_HANDLER_RE = /\bon([A-Z][A-Za-z0-9]*)\s*:\s*\(\s*\)\s*(?:=>\s*)?\{\s*\}/g;
// Comments (`// …`, `/* … */`) and string literals ('…', "…") — the surfaces the
// placeholder lint scans, so `Placeholder()` the WIDGET (code) never false-fires.
const COMMENT_OR_STRING_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

// Inline-literal detectors (Flutter). Color(0xFF…) / Colors.red / const Color.
const INLINE_COLOR_RE = /\bColor\s*\(\s*0x[0-9a-fA-F]{6,8}\s*\)|\bColors\.[a-zA-Z]/g;
// Inline TextStyle(...) and GoogleFonts.<family>(...) — both bypass the type scale.
const INLINE_TEXTSTYLE_RE = /\bTextStyle\s*\(|\bGoogleFonts\.[a-zA-Z]/g;
// A literal route path in the source: '/foo', "/bar-baz". Used to spot new
// top-level routes the screen registered outside the plan.
const ROUTE_LITERAL_RE = /['"](\/[a-z0-9][a-z0-9/_-]*)['"]/gi;
// A reference to an AppRoutes.<const> route constant.
const ROUTE_CONST_RE = /\bAppRoutes\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
// P3 nav-stack advisory: a plain `pushNamed(...)` call and its (first-line) args.
// \bpushNamed matches ONLY the plain verb: `pushReplacementNamed(` has no
// `pushNamed` word-boundary token and `pushNamedAndRemoveUntil(` continues with
// `A`, not `(` — so neither stack-correct verb fires the advisory.
const PUSH_NAMED_RE = /\bpushNamed\s*\(([^)]*)\)/g;

// How many inline literals before we flag (a couple is noise; many = real drift).
const INLINE_COLOR_THRESHOLD = 4;
const INLINE_TEXTSTYLE_THRESHOLD = 4;

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}
function collectGroup(re: RegExp, text: string, group = 1): Set<string> {
  re.lastIndex = 0;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { const v = m[group]; if (v) out.add(v); }
  return out;
}

/**
 * Resolve which files belong to a just-built canonical screen: the screen file
 * (legacy lib/screens/screen_<id>.dart, and — P1-core — the SEMANTIC file the
 * skeleton actually writes, `<fileBase>.dart` from planSemanticScreens) plus any
 * preview entry. We grep those rather than the whole project so one screen's
 * drift doesn't blame another.
 */
function screenFilesFor(canonical: Canonical, canonicalId: string, semanticFileBase?: string): string[] {
  const slug = `screen_${canonicalId.replace(/^c_/, '')}`.toLowerCase();
  const out = [path.join('lib', 'screens', `${slug}.dart`)];
  if (semanticFileBase) out.push(path.join('lib', 'screens', `${semanticFileBase}.dart`));
  return out;
}

/**
 * Run the deterministic reconciliation gate for ONE canonical screen.
 * GUARDED: returns ok=true with no flags when there is no canonical context
 * (non-canonical runs are unaffected) or the framework isn't Flutter.
 */
export async function reconcileScreen(opts: {
  projectRoot: string;
  framework: string;
  canonical?: Canonical;
  canonicalId?: string;
  /** the previewEntry the build used (also grepped, it's part of this screen). */
  previewEntry?: string;
}): Promise<ReconcileResult> {
  const { projectRoot, framework, canonical, canonicalId } = opts;
  const empty: ReconcileResult = { ok: true, flags: [], inspected: [] };
  // Only meaningful with a canonical skeleton (known route table + theme file).
  if (!canonical || !canonicalId) return empty;
  if ((framework || 'flutter').toLowerCase() !== 'flutter') return empty;

  const cs = canonical.screens.find(s => s.canonicalId === canonicalId);
  if (!cs) return empty;

  // The set of LEGAL routes/consts — derived from the SAME source the skeleton uses
  // (planSemanticScreens), so reconcile and the generated AppRoutes agree BY
  // CONSTRUCTION. Previously this re-derived consts from canonicalId (c_290_3657 →
  // c2903657), which stopped matching once the skeleton began emitting SEMANTIC
  // consts (addCard, cardListSuccessState, …): every valid `AppRoutes.<const>`
  // reference then false-flagged 'unbacked-route' and good screens (90+ visual,
  // routes fully registered) were demoted to needs-review en masse.
  const plan = planSemanticScreens(canonical);
  const legalRouteSlugs = new Set([...plan.values()].map(p => p.routePath));
  const legalRouteConsts = new Set([...plan.values()].map(p => p.routeConst));
  legalRouteConsts.add('entry');

  const rel = [...new Set([
    ...screenFilesFor(canonical, canonicalId, plan.get(canonicalId)?.fileBase),
    ...(opts.previewEntry ? [opts.previewEntry] : []),
  ])];
  const flags: ReconcileFlag[] = [];
  const inspected: string[] = [];
  let text = '';
  for (const r of rel) {
    const abs = path.join(projectRoot, r);
    if (!fsSync.existsSync(abs)) continue;
    try { text += '\n' + (await fs.readFile(abs, 'utf8')); inspected.push(r); } catch { /* skip */ }
  }
  // The screen file may not exist yet (build wrote elsewhere) — nothing to check.
  if (!inspected.length) return { ok: true, flags: [], inspected };

  // 1 + 2. ROUTES. Any AppRoutes.<const> referenced must be a legal constant; any
  // literal route path used (outside an AppRoutes const) that isn't a canonical
  // route slug is a new top-level route outside the plan.
  for (const c of collectGroup(ROUTE_CONST_RE, text)) {
    if (!legalRouteConsts.has(c)) {
      flags.push({ code: 'unbacked-route', severity: 'high',
        message: `references AppRoutes.${c}, which is not a route in the plan (no backing screen/stub).` });
    }
  }
  for (const slug of collectGroup(ROUTE_LITERAL_RE, text)) {
    // Skip asset-ish paths (have a file extension) and the legal route slugs.
    if (/\.[a-z0-9]{2,4}$/i.test(slug)) continue;
    if (legalRouteSlugs.has(slug)) continue;
    flags.push({ code: 'new-route', severity: 'high',
      message: `registers/navigates to literal route "${slug}", which is not in the canonical plan.` });
  }

  // 3. THEME IMPORT. The screen must import the canonical theme/token file.
  const importsTheme = /import\s+['"][^'"]*theme\/app_theme\.dart['"]/.test(text)
    || /\bappTheme\s*\(/.test(text) || /\bTheme\.of\(/.test(text);
  if (!importsTheme) {
    flags.push({ code: 'missing-theme-import', severity: 'med',
      message: `does not import the canonical theme (lib/theme/app_theme.dart) or read Theme.of(context) — likely styling inline instead of the design tokens.` });
  }
  // Shared widgets: when components exist, at least one should be referenced (a
  // soft signal — some screens legitimately use none, so it's low severity).
  if (canonical.components.length) {
    const usesAny = canonical.components.some(c => {
      const cls = (c.name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Screen') + 'Widget';
      return text.includes(cls);
    });
    if (!usesAny) {
      flags.push({ code: 'no-shared-widgets', severity: 'low',
        message: `references none of the shared components — confirm it isn't re-implementing a shared widget inline.` });
    }
  }

  // 4. INLINE STYLE LITERALS (soft — many = bypassing tokens).
  const nColor = countMatches(INLINE_COLOR_RE, text);
  if (nColor >= INLINE_COLOR_THRESHOLD) {
    flags.push({ code: 'inline-color', severity: 'med',
      message: `${nColor} inline colour literal(s) (Color(0x…)/Colors.*) — define colours in the theme and reference them instead of hardcoding per screen.` });
  }
  const nStyle = countMatches(INLINE_TEXTSTYLE_RE, text);
  if (nStyle >= INLINE_TEXTSTYLE_THRESHOLD) {
    flags.push({ code: 'inline-textstyle', severity: 'med',
      message: `${nStyle} inline text-style literal(s) (TextStyle(…)/GoogleFonts.*) — use the theme's text styles instead of inlining the type scale.` });
  }

  // 5. P1-core: PLACEHOLDER / DEFERRAL markers (HIGH — demotes to needs-review).
  // Only comments + string literals are scanned, so `Placeholder()` the widget or a
  // `placeholder:` named argument in CODE never false-fires; a comment/string that
  // says "placeholder" / "real frames come later" is a self-issued, untracked IOU.
  {
    COMMENT_OR_STRING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hit: string | null = null;
    while ((m = COMMENT_OR_STRING_RE.exec(text))) {
      if (PLACEHOLDER_RE.test(m[0])) { hit = m[0]; break; }
    }
    if (hit) {
      const sample = hit.replace(/\s+/g, ' ').trim().slice(0, 120);
      flags.push({ code: 'deferred-placeholder', severity: 'high',
        message: `placeholder/deferral marker in the built screen (${JSON.stringify(sample)}) — deferred/placeholder implementations are forbidden; build the real content now.` });
    }
  }

  // 6. P1-core: DEAD interaction handlers (HIGH). An `onTap: () {}` /
  // `onPressed: () => {}` looks wired in the screenshot but does nothing at runtime
  // — list each so the fix pass targets them precisely.
  {
    DEAD_HANDLER_RE.lastIndex = 0;
    const dead: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = DEAD_HANDLER_RE.exec(text))) dead.push(`on${m[1]}`);
    if (dead.length) {
      flags.push({ code: 'dead-handler', severity: 'high',
        message: `${dead.length} empty interaction handler(s) (${dead.join(', ')}) — every visible control must do something real (navigate via AppRoutes, present its modal, or mutate state).` });
    }
  }

  // 7. P3: NAV-STACK advisory — 'push-into-hub' (MED, never blocks). When the app
  // has a shell/hub (P2's tab cluster), entering it from auth/onboarding/anywhere
  // must CLEAR the stack (pushNamedAndRemoveUntil / pushReplacementNamed) — the
  // Ping app plain-pushed Home onto the login form, so back-gesture returned to
  // auth. Flag a plain `pushNamed` whose target is a tab-cluster route. Skipped
  // silently when no shell exists (computeTabCluster null) — no cluster, no hub.
  {
    const cluster = computeTabCluster(canonical);
    if (cluster) {
      const hubConsts = new Set<string>();
      const hubSlugs = new Set<string>();
      for (const id of cluster.memberIds) {
        const sem = plan.get(id);
        if (sem) { hubConsts.add(sem.routeConst); hubSlugs.add(sem.routePath); }
      }
      const flagged = new Set<string>();
      PUSH_NAMED_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PUSH_NAMED_RE.exec(text))) {
        const args = m[1] ?? '';
        const constRef = /\bAppRoutes\.([a-zA-Z_][a-zA-Z0-9_]*)/.exec(args)?.[1];
        const litRef = /['"](\/[a-z0-9][a-z0-9/_-]*)['"]/i.exec(args)?.[1];
        const target = (constRef && hubConsts.has(constRef)) ? `AppRoutes.${constRef}`
          : (litRef && hubSlugs.has(litRef)) ? `"${litRef}"` : null;
        if (target && !flagged.has(target)) {
          flagged.add(target);
          flags.push({ code: 'push-into-hub', severity: 'med',
            message: `pushes the app shell/hub route ${target} with a plain pushNamed — entering the hub must clear the stack (pushNamedAndRemoveUntil(route, (r) => false) or pushReplacementNamed) so the back gesture cannot return to auth/onboarding.` });
        }
      }
    }
  }

  const ok = !flags.some(f => f.severity === 'high');
  return { ok, flags, inspected };
}

/** One-line human summary of a reconcile result for the run log. */
export function reconcileSummary(r: ReconcileResult): string {
  if (!r.flags.length) return 'reconciliation OK (no structural drift)';
  const by = (sev: string) => r.flags.filter(f => f.severity === sev).length;
  return `reconciliation: ${by('high')} high / ${by('med')} med / ${by('low')} low flag(s) — ${r.flags.map(f => f.code).join(', ')}`;
}
