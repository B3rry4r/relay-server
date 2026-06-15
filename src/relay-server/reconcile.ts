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
//
// Everything is grep/string-level (no AST dependency) so it stays cheap + has no
// new deps. It is GUARDED: it only runs when a canonical skeleton exists (so the
// route table + theme file are known); without canonical context it is a no-op so
// existing non-canonical runs are unaffected.
// =============================================================================

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { Canonical } from './canonicalize';

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

// Inline-literal detectors (Flutter). Color(0xFF…) / Colors.red / const Color.
const INLINE_COLOR_RE = /\bColor\s*\(\s*0x[0-9a-fA-F]{6,8}\s*\)|\bColors\.[a-zA-Z]/g;
// Inline TextStyle(...) and GoogleFonts.<family>(...) — both bypass the type scale.
const INLINE_TEXTSTYLE_RE = /\bTextStyle\s*\(|\bGoogleFonts\.[a-zA-Z]/g;
// A literal route path in the source: '/foo', "/bar-baz". Used to spot new
// top-level routes the screen registered outside the plan.
const ROUTE_LITERAL_RE = /['"](\/[a-z0-9][a-z0-9/_-]*)['"]/gi;
// A reference to an AppRoutes.<const> route constant.
const ROUTE_CONST_RE = /\bAppRoutes\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

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
 * (lib/screens/screen_<id>.dart from the skeleton) plus any preview entry. We grep
 * those rather than the whole project so one screen's drift doesn't blame another.
 */
function screenFilesFor(canonical: Canonical, canonicalId: string): string[] {
  const slug = `screen_${canonicalId.replace(/^c_/, '')}`.toLowerCase();
  return [path.join('lib', 'screens', `${slug}.dart`)];
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

  // The set of LEGAL routes: every canonical route slug + its constant name.
  const legalRouteSlugs = new Set(canonical.screens.map(s => s.route));
  // Constant names are derived the same way the skeleton derives them.
  const constName = (id: string): string => {
    const p = id.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Screen';
    return p.charAt(0).toLowerCase() + p.slice(1);
  };
  const legalRouteConsts = new Set(canonical.screens.map(s => constName(s.canonicalId)));
  legalRouteConsts.add('entry');

  const rel = [
    ...screenFilesFor(canonical, canonicalId),
    ...(opts.previewEntry ? [opts.previewEntry] : []),
  ];
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

  const ok = !flags.some(f => f.severity === 'high');
  return { ok, flags, inspected };
}

/** One-line human summary of a reconcile result for the run log. */
export function reconcileSummary(r: ReconcileResult): string {
  if (!r.flags.length) return 'reconciliation OK (no structural drift)';
  const by = (sev: string) => r.flags.filter(f => f.severity === sev).length;
  return `reconciliation: ${by('high')} high / ${by('med')} med / ${by('low')} low flag(s) — ${r.flags.map(f => f.code).join(', ')}`;
}
