// =============================================================================
// File: src/relay-server/canonicalize-ai/reduce.ts
//
// REDUCE (Phase 1c) — the HOLISTIC step that turns the per-frame 1a descriptors +
// the 1b frozen lexicon + the flow graph into THE canonical model the whole
// production pipeline (Phase 7) keys off. 1a is parallel/per-frame; 1b is the
// single-writer lexicon freeze; 1c reads ALL the COMPACT descriptors at once (they
// fit context) plus the flow and discovers the CROSS-FRAME relationships:
//
//   1. NORMALIZE  — rewrite every descriptor's widget vocabulary through the 1b
//      proposalMap (canonical names), so the same widget reads identically on every
//      frame. An entry's MULTIPLE fingerprints are treated as equivalent anchors
//      (the 1b hand-off: synonyms collapsed to one canonical name carry all their
//      content-addressed fingerprints).
//   2. STATE GROUPING + DEDUP — cluster frames that are the SAME screen in different
//      states (same/near frame fingerprint + same semanticName/role) into ONE
//      canonical screen with states[]; drop exact dups. The DETERMINISTIC frame
//      fingerprint is the anchor (immune to wording); an optional bounded AI tiebreak
//      only ever splits/merges AMBIGUOUS clusters the deterministic pass flagged.
//   3. MODAL BINDING — a frame whose role is modal/sheet, OR that is the target of a
//      flow edge of type 'modal', is a MODAL: bound to its BASE screen + a TRIGGER.
//      The flow's modal edges are AUTHORITATIVE for base+trigger; the descriptor's
//      isModalGuess is the FALLBACK. Modals are NOT standalone screens.
//   4. TEMPLATES — screens sharing a layout skeleton (matching section sequence /
//      structural fingerprint) become a template + members.
//   5. COMPONENTS — lexicon entries (base + learned) whose widgets recur across ≥2
//      canonical screens become shared components (canonicalName, kind, usedIn[],
//      count).
//   6. FLOW REWRITE — rewrite the flow onto canonical ids (push/tab stay; modal →
//      overlay; intra-screen edges fold into state transitions and drop out).
//
// THE AI'S ROLE — bounded + advisory. We compute dedup/template/component CANDIDATES
// DETERMINISTICALLY from fingerprints FIRST; the single holistic runModel('claude',
// 'sonnet') call over the COMPACT normalized descriptors + flow only CONFIRMS/REFINES
// the judgment calls (ambiguous clustering, template/component grouping, modal
// base/trigger where the flow is silent). We NEVER feed raw IR for all frames — only
// the compact descriptors — and the final ids/routes/hashes are re-derived
// deterministically so a flaky model can't reshuffle a committed canonical model.
//
// FRAMEWORK-AGNOSTIC: the output is about the DESIGN (screens/modals/templates/
// components/flow), not any Flutter/React artifact. Target-framework mapping is 1d+.
//
// IDEMPOTENT: identical (descriptors + lexicon + flow) → identical canonical.json —
// stable ordering, deterministic hashing, and the AI judgment is cached by a
// deterministic signature (the 1b pattern) so a re-run reuses it instead of re-asking.
//
// Output: <projectRoot>/.uix/canonical.json. Imports the read-only 1a/1b modules.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot, createTerminalEnv, resolveWorkspace } from '../runtime';
import { runModel } from '../ai-routes';
import { LEXICON_VERSION, WIDGET_KIND_SET } from './lexicon';
import type { FrameDescriptor, DescriptorWidget } from './descriptor-schema';
import type { FrozenLexicon } from './reconcile';

// ── flow input (the authoritative nav/modal graph) ───────────────────────────
// Mirrors build-run-store.RunFlow so callers can pass a run's flow verbatim, but is
// declared locally so this module has NO dependency on the build-run machinery.
export interface ReduceFlowEdge {
  from: string;
  to: string;
  /** raw flow edge type: 'push' | 'replace' | 'tab' | 'modal' | … (free-form). */
  type: string;
  label?: string;
}
export interface ReduceFlow {
  entryFrameId: string | null;
  connections: ReduceFlowEdge[];
}

// ── CANONICAL MODEL SCHEMA (the Phase-7 hand-off contract) ───────────────────
// This is THE schema the production pipeline keys off. Routes derive from the
// (stable) canonicalId, never the mutable name. Ids are content-addressed off the
// lead frame id so a rename never moves a route.

export interface CanonicalStateRef {
  /** stable state id: 'default' for the lead, then 'state2','state3',… */
  id: string;
  frameId: string;
  /** one short clause describing this state (from the descriptor's lead section). */
  brief: string;
}
export interface CanonicalScreen {
  canonicalId: string;
  /** display name (cosmetic alias; routes key on id, not this). */
  name: string;
  /** stable route slug derived from the canonicalId. */
  route: string;
  role: 'screen';
  /** every frame folded into this screen (lead first, then state siblings). */
  frameIds: string[];
  states: CanonicalStateRef[];
  /** the template this screen is a member of, if any. */
  templateRef?: string;
}
export interface CanonicalModalTrigger {
  /** the canonical screen this modal is presented FROM. */
  fromScreen: string;
  /** the element/label that opens it (flow edge label or trigger guess), if known. */
  element?: string;
  /** the originating flow edge type ('modal' authoritative; else inferred). */
  edgeType: string;
}
export interface CanonicalModal {
  canonicalId: string;
  name: string;
  frameId: string;
  /** the base screen this overlay sits over. */
  baseCanonicalId: string;
  trigger: CanonicalModalTrigger;
}
export interface CanonicalTemplate {
  id: string;
  memberCanonicalIds: string[];
  /** the shared section-kind sequence (the layout skeleton) members agree on. */
  sharedSections: string[];
}
export interface CanonicalComponent {
  /** the lexicon canonical name (base term or learned name). */
  canonicalName: string;
  /** a coarse kind hint ('button' | 'nav' | 'list' | 'input' | 'media' | 'other'). */
  kind: string;
  /** the canonical screen ids this component appears on (≥2). */
  usedIn: string[];
  /** total instance count across usedIn. */
  count: number;
}
export interface CanonicalFlowEdge {
  from: string;
  to: string;
  /** 'push' | 'tab' | 'overlay' (modal→overlay) | the original type. */
  kind: string;
  label?: string;
}
export interface CanonicalFlow {
  entryCanonicalId: string | null;
  edges: CanonicalFlowEdge[];
}
export interface CanonicalModel {
  version: 1;
  projectId: string;
  figStorageKey: string;
  /** stable content hash of the whole canonical model (idempotency proof). */
  contentHash: string;
  screens: CanonicalScreen[];
  modals: CanonicalModal[];
  templates: CanonicalTemplate[];
  components: CanonicalComponent[];
  flow: CanonicalFlow;
  warnings: string[];
}

export interface ReduceResult {
  canonical: CanonicalModel;
  /** frame id → canonical id (screen or modal) — the single identity axis for 1d. */
  frameMap: Record<string, string>;
  /** where canonical.json was written (null if no projectRoot / persist:false). */
  canonicalPath: string | null;
  /** whether the bounded AI confirm/refine ran (false = deterministic-only). */
  aiRefined: boolean;
}

// ── id + route derivation (stable, content-addressed) ────────────────────────
/** Content-addressed canonical id from the lead frame id (stable across rename). */
export function canonicalIdFor(frameId: string): string {
  return 'c_' + String(frameId).replace(/[^a-zA-Z0-9]+/g, '_');
}
/** Modal canonical id (kept distinct from screen ids so the two namespaces never collide). */
export function modalIdFor(frameId: string): string {
  return 'm_' + String(frameId).replace(/[^a-zA-Z0-9]+/g, '_');
}
/** Stable route slug derived from the canonicalId — NOT the mutable name. */
export function routeForCanonicalId(canonicalId: string): string {
  const slug = canonicalId.replace(/^c_/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '/' + (slug || canonicalId.toLowerCase());
}

// ── coarse component-kind hint from a lexicon widget name ─────────────────────
// Framework-agnostic bucketing used only as a hint on the components[] entries.
function componentKind(name: string): string {
  const n = name.toLowerCase();
  if (/button|fab|cta|link/.test(n)) return 'button';
  if (/nav|tab|appbar|toolbar/.test(n)) return 'nav';
  if (/list|row|item|card|grid/.test(n)) return 'list';
  if (/field|input|search|dropdown|checkbox|radio|toggle|slider|stepper|pin|segment/.test(n)) return 'input';
  if (/avatar|image|icon|illustration|logo|badge|chip|tag/.test(n)) return 'media';
  return 'other';
}

// ── descriptor normalization (1b hand-off) ───────────────────────────────────
// Rewrite each widget's vocabulary through the proposalMap so the SAME widget reads
// identically on every frame. A widget kind:'other' with a proposedName is remapped
// to its 1b canonical name; a base kind stays as-is. We carry the proposalMap's
// canonical→fingerprints from the lexicon so an entry's multiple fingerprints are all
// treated as equivalent anchors (synonyms collapsed in 1b share one canonical name).

interface NormalizedWidget {
  /** the canonical vocabulary term (base kind or learned canonicalName). */
  canonicalName: string;
  count: number;
}
interface NormalizedDescriptor {
  frameId: string;
  role: FrameDescriptor['role'];
  semanticName: string;
  /** ordered section-kind sequence (the layout skeleton signal for templates). */
  sectionSeq: string[];
  /** lead section brief (state label). */
  brief: string;
  fingerprint: string;
  widgets: NormalizedWidget[];
  isModalGuess?: FrameDescriptor['isModalGuess'];
}

/** Map one widget through the 1b proposalMap → its canonical vocabulary term. */
function canonicalWidgetName(w: DescriptorWidget, proposalMap: Record<string, string>): string {
  if (w.kind !== 'other') return w.kind;                 // base term — already canonical
  const proposed = w.proposedName;
  if (proposed && proposalMap[proposed]) return proposalMap[proposed];
  return proposed || 'other';                            // unmapped proposal → keep its name
}

function normalizeDescriptors(
  descriptors: FrameDescriptor[], proposalMap: Record<string, string>,
): NormalizedDescriptor[] {
  return (Array.isArray(descriptors) ? descriptors : []).map((d): NormalizedDescriptor => {
    // collapse widgets by canonical name (sum counts) so e.g. submitBtn+primaryCta merge.
    const byName = new Map<string, number>();
    for (const w of (Array.isArray(d.widgets) ? d.widgets : [])) {
      const name = canonicalWidgetName(w, proposalMap);
      byName.set(name, (byName.get(name) || 0) + (Number.isFinite(w.count) && w.count >= 1 ? Math.floor(w.count) : 1));
    }
    const widgets = [...byName.entries()]
      .map(([canonicalName, count]) => ({ canonicalName, count }))
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
    const sections = Array.isArray(d.sections) ? d.sections : [];
    return {
      frameId: d.frameId,
      role: d.role,
      semanticName: d.semanticName,
      sectionSeq: sections.map(s => s.kind),
      brief: sections[0]?.brief || d.semanticName,
      fingerprint: d.fingerprint,
      widgets,
      ...(d.isModalGuess ? { isModalGuess: d.isModalGuess } : {}),
    };
  });
}

// ── deterministic clustering anchors ─────────────────────────────────────────
// The frame fingerprint is the language-independent anchor (immune to wording). Two
// frames are the SAME screen (state siblings) when their fingerprints match AND they
// agree on semanticName + role — fingerprint guards STRUCTURE, the name/role guard
// stops two structurally-identical-but-semantically-different screens (a template
// pair) from over-folding into one screen with bogus "states".

const isModalRole = (role: string): boolean => role === 'modal' || role === 'sheet';

/** A normalized semantic key: lowercased, non-alnum stripped (rename-tolerant-ish). */
function semKey(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface ScreenCluster {
  /** lead frame id (lowest in stable order). */
  leadFrameId: string;
  frameIds: string[];           // all frames in this screen (states), stable order
  fingerprint: string;
  semanticName: string;
  sectionSeq: string[];
  briefByFrame: Map<string, string>;
}

// ── the bounded, cached AI confirm/refine call ───────────────────────────────
// Advisory only: confirms/refines the deterministic candidates. We feed COMPACT
// descriptors (never raw IR) + the deterministic candidates + the flow, and accept
// only REFINEMENTS that re-key onto deterministic anchors. Cached by a deterministic
// signature (1b pattern) so a re-run is idempotent without re-asking the model.

interface AiRefinement {
  /** clusters the AI says should SPLIT: frameId → its own screen (over-folded). */
  splitOut?: string[];
  /** modal base/trigger overrides where the flow was silent: frameId → base semKey. */
  modalBase?: Record<string, string>;
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Deterministic signature of the exact judgment problem fed to the AI. */
function refineSignature(
  norm: NormalizedDescriptor[], flow: ReduceFlow, ambiguousFrames: string[], unboundModals: string[],
): string {
  const payload = {
    d: norm.map(n => ({ f: n.frameId, fp: n.fingerprint, s: semKey(n.semanticName), r: n.role }))
      .sort((a, b) => a.f.localeCompare(b.f)),
    e: (flow.connections || []).map(c => `${c.from}>${c.to}:${c.type}`).sort(),
    amb: [...ambiguousFrames].sort(),
    um: [...unboundModals].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

const refineCachePath = (root: string): string => path.join(root, '.uix', 'canonical-refine.json');

async function readRefineCache(root: string, signature: string): Promise<AiRefinement | null> {
  try {
    const raw = await fs.readFile(refineCachePath(root), 'utf8');
    const c = JSON.parse(raw) as { signature: string; refinement: AiRefinement };
    if (c && c.signature === signature && c.refinement) return c.refinement;
  } catch { /* no cache → recompute */ }
  return null;
}
async function writeRefineCache(root: string, signature: string, refinement: AiRefinement): Promise<void> {
  try {
    const abs = refineCachePath(root);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify({ signature, refinement }, null, 2));
  } catch { /* best-effort */ }
}

function buildRefinePrompt(
  norm: NormalizedDescriptor[], flow: ReduceFlow, ambiguousFrames: string[], unboundModals: string[],
): string {
  // COMPACT descriptors only — never raw IR. One line per frame.
  const frameLines = norm.map(n => {
    const w = n.widgets.slice(0, 12).map(x => `${x.canonicalName}×${x.count}`).join(',');
    return `- ${n.frameId} | role=${n.role} | name=${n.semanticName} | fp=${n.fingerprint} | sections=[${n.sectionSeq.join('>')}] | widgets={${w}}`;
  }).join('\n');
  const flowLines = (flow.connections || [])
    .map(c => `  ${c.from} --${c.type}--> ${c.to}${c.label ? ` (${c.label})` : ''}`).join('\n');
  return [
    `You are adjudicating a CANONICAL design model. Below are COMPACT descriptors for`,
    `every frame of ONE app (no raw layout — just role, name, a structural fingerprint,`,
    `the section sequence, and the canonical widget counts) plus the navigation flow.`,
    ``,
    `Deterministic anchors are ALREADY computed: frames with the SAME fingerprint AND the`,
    `same name+role were folded into one screen (states), and flow 'modal' edges bound`,
    `modals to a base screen. Your job is ONLY to catch mistakes the anchors can't:`,
    ``,
    `1. OVER-FOLDING: among the AMBIGUOUS frames listed, are any two REALLY different`,
    `   screens that share a skeleton (a template pair, e.g. "Change PIN" vs "Reset PIN")`,
    `   and must be SPLIT apart? List the frameIds that should each be their OWN screen.`,
    `2. UNBOUND MODALS: for each modal frame with no flow 'modal' edge, which screen does`,
    `   it overlay? Give the base screen's NAME (from the list).`,
    ``,
    `FRAMES:`,
    frameLines,
    ``,
    `FLOW:`,
    flowLines || '  (none)',
    ``,
    ambiguousFrames.length ? `AMBIGUOUS (structurally-identical clusters to re-check): ${ambiguousFrames.join(', ')}` : `AMBIGUOUS: (none)`,
    unboundModals.length ? `UNBOUND MODALS (need a base screen): ${unboundModals.join(', ')}` : `UNBOUND MODALS: (none)`,
    ``,
    `OUTPUT — a SINGLE JSON object, no prose, no code fences:`,
    `{ "splitOut": [<frameIds that must each be their own screen>],`,
    `  "modalBase": { "<modalFrameId>": "<base screen name>" } }`,
    `Only include genuine corrections; empty arrays/objects are fine. Do NOT write files.`,
  ].filter(Boolean).join('\n');
}

async function aiRefine(
  norm: NormalizedDescriptor[], flow: ReduceFlow, ambiguousFrames: string[], unboundModals: string[],
  projectId: string, root: string, modelId: string,
): Promise<AiRefinement | null> {
  if (!ambiguousFrames.length && !unboundModals.length) return null;   // nothing to adjudicate
  try {
    const env = createTerminalEnv(resolveWorkspace());
    const prompt = buildRefinePrompt(norm, flow, ambiguousFrames, unboundModals);
    const { text } = await runModel('claude', prompt, env, root, { agent: false, modelId, projectId });
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const knownFrames = new Set(norm.map(n => n.frameId));
    const splitOut: string[] = Array.isArray(parsed.splitOut)
      ? [...new Set((parsed.splitOut as unknown[]).map(v => String(v)))].filter(f => knownFrames.has(f) && ambiguousFrames.includes(f))
      : [];
    const modalBase: Record<string, string> = {};
    if (parsed.modalBase && typeof parsed.modalBase === 'object') {
      // map AI's base NAME back onto a deterministic anchor: a frame semKey.
      const nameToFrame = new Map<string, string>();
      for (const n of norm) if (!isModalRole(n.role)) nameToFrame.set(semKey(n.semanticName), n.frameId);
      for (const [mf, baseName] of Object.entries(parsed.modalBase)) {
        if (!unboundModals.includes(mf)) continue;
        const baseFrame = nameToFrame.get(semKey(String(baseName)));
        if (baseFrame) modalBase[mf] = baseFrame;          // re-keyed onto a real frame anchor
      }
    }
    return { splitOut, modalBase };
  } catch {
    return null;
  }
}

// ── main entry ───────────────────────────────────────────────────────────────

export interface ReduceOptions {
  modelId?: string;
  /** skip the AI confirm/refine (deterministic-only) — for tests / offline. */
  skipAi?: boolean;
  /** write canonical.json (default true). */
  persist?: boolean;
  /** ignore the persisted AI-refinement cache + force a fresh model call. */
  forceRefine?: boolean;
}

/**
 * Phase 1c. Reduce all 1a descriptors + the 1b lexicon + the flow into the canonical
 * model and persist <projectRoot>/.uix/canonical.json.
 *
 * Deterministic + idempotent: identical (descriptors + lexicon + flow) → identical
 * canonical.json. The frame fingerprint anchors clustering; the flow is authoritative
 * for nav + modal binding; the single bounded AI call is advisory + cached.
 */
export async function reduceToCanonical(
  projectId: string,
  figStorageKey: string,
  descriptors: FrameDescriptor[],
  lexicon: FrozenLexicon,
  proposalMap: Record<string, string>,
  flow: ReduceFlow | undefined,
  opts: ReduceOptions = {},
): Promise<ReduceResult> {
  const root = resolveProjectRoot(projectId);
  const warnings: string[] = [];
  const safeFlow: ReduceFlow = {
    entryFrameId: flow?.entryFrameId ?? null,
    connections: Array.isArray(flow?.connections) ? flow!.connections : [],
  };

  // 1. NORMALIZE descriptors through the 1b proposalMap. A frame described more than
  // once (an exact dup) collapses to a single descriptor here (first wins, stable).
  const normRaw = normalizeDescriptors(descriptors, proposalMap);
  const byFrame = new Map<string, NormalizedDescriptor>();
  for (const n of normRaw) if (n.frameId && !byFrame.has(n.frameId)) byFrame.set(n.frameId, n);
  const norm = [...byFrame.values()];

  // Which frames are modals? A frame is a modal if its role is modal/sheet OR it is
  // the target of a flow 'modal' edge (flow is authoritative). Everything else that
  // isn't a sub-screen component is a screen. (1a has no 'component' detection beyond
  // role; the descriptor role 'component' is honoured too.)
  const modalByFlow = new Set<string>();
  for (const c of safeFlow.connections) if (/modal|sheet|overlay/i.test(c.type)) modalByFlow.add(c.to);
  const isModalFrame = (n: NormalizedDescriptor): boolean => isModalRole(n.role) || modalByFlow.has(n.frameId);

  const componentFrames = norm.filter(n => n.role === 'component').map(n => n.frameId);
  const componentSet = new Set(componentFrames);
  const modalFrames = norm.filter(n => isModalFrame(n) && !componentSet.has(n.frameId));
  const modalFrameSet = new Set(modalFrames.map(n => n.frameId));
  const screenFrames = norm.filter(n => !modalFrameSet.has(n.frameId) && !componentSet.has(n.frameId));

  // 2. STATE GROUPING + DEDUP — cluster screen frames by (fingerprint + sem + role).
  // Exact-dup frames (same fingerprint AND same brief AND same widgets signature) are
  // folded as ONE state (the duplicate is dropped — same frameId list, no extra state).
  const clusterKey = (n: NormalizedDescriptor): string => `${n.fingerprint}|${semKey(n.semanticName)}|${n.role}`;
  const clusters = new Map<string, NormalizedDescriptor[]>();
  // stable order: sort screen frames by frame id first.
  const sortedScreens = [...screenFrames].sort((a, b) => a.frameId.localeCompare(b.frameId));
  for (const n of sortedScreens) {
    const k = clusterKey(n);
    (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(n);
  }

  // AMBIGUOUS clusters: same FINGERPRINT but spanning >1 semanticName (template pair
  // risk). These (and singleton screens that share a fingerprint with a different name)
  // are the only cases the AI is asked to re-check.
  const byFp = new Map<string, NormalizedDescriptor[]>();
  for (const n of sortedScreens) (byFp.get(n.fingerprint) ?? byFp.set(n.fingerprint, []).get(n.fingerprint)!).push(n);
  const ambiguousFrames: string[] = [];
  for (const group of byFp.values()) {
    const sems = new Set(group.map(g => semKey(g.semanticName)));
    if (group.length > 1 && sems.size > 1) for (const g of group) ambiguousFrames.push(g.frameId);
  }
  ambiguousFrames.sort();

  // Unbound modals: a modal frame with no incoming flow 'modal' edge from a known screen.
  const screenFrameIds = new Set(sortedScreens.map(n => n.frameId));
  const flowModalEdgeFor = (modalFrameId: string): ReduceFlowEdge | undefined => {
    const incoming = safeFlow.connections.filter(c => c.to === modalFrameId);
    return incoming.find(c => /modal|sheet|overlay/i.test(c.type)) ?? incoming[0];
  };
  const unboundModals: string[] = modalFrames
    .filter(m => { const e = flowModalEdgeFor(m.frameId); return !e || !screenFrameIds.has(e.from); })
    .map(m => m.frameId).sort();

  // 3b. bounded AI confirm/refine (advisory, cached). Only adjudicates ambiguous
  // clusters + unbound modals; everything else is deterministic.
  let aiRefined = false;
  let refinement: AiRefinement | null = null;
  const canRunAi = !opts.skipAi && !!root && (ambiguousFrames.length > 0 || unboundModals.length > 0);
  if (canRunAi && root) {
    const sig = refineSignature(norm, safeFlow, ambiguousFrames, unboundModals);
    refinement = opts.forceRefine ? null : await readRefineCache(root, sig);
    if (refinement) {
      aiRefined = true;
    } else {
      const ai = await aiRefine(norm, safeFlow, ambiguousFrames, unboundModals, projectId, root, opts.modelId ?? 'sonnet');
      if (ai) {
        refinement = ai;
        aiRefined = true;
        if (opts.persist !== false) await writeRefineCache(root, sig, ai);
      }
    }
  }

  // Apply a SPLIT refinement: a frame the AI says is really its own screen leaves its
  // cluster. (We never let the AI MERGE distinct fingerprints — that would defeat the
  // structural anchor; it may only split an over-fold.)
  const splitSet = new Set(refinement?.splitOut ?? []);

  // materialize canonical screens (lead = lowest frame id in the cluster).
  const screens: CanonicalScreen[] = [];
  const frameMap: Record<string, string> = {};
  const screenByFrame = new Map<string, string>();   // frameId → canonicalId
  const semKeyToScreenId = new Map<string, string>(); // sem → first canonical screen id (modal fallback)

  const emitScreen = (group: NormalizedDescriptor[]): void => {
    const sorted = [...group].sort((a, b) => a.frameId.localeCompare(b.frameId));
    const lead = sorted[0];
    const canonicalId = canonicalIdFor(lead.frameId);
    const states: CanonicalStateRef[] = sorted.map((g, i) => ({
      id: i === 0 ? 'default' : `state${i + 1}`,
      frameId: g.frameId,
      brief: g.brief,
    }));
    const screen: CanonicalScreen = {
      canonicalId,
      name: lead.semanticName,
      route: routeForCanonicalId(canonicalId),
      role: 'screen',
      frameIds: sorted.map(g => g.frameId),
      states,
    };
    screens.push(screen);
    for (const g of sorted) { frameMap[g.frameId] = canonicalId; screenByFrame.set(g.frameId, canonicalId); }
    const sk = semKey(lead.semanticName);
    if (!semKeyToScreenId.has(sk)) semKeyToScreenId.set(sk, canonicalId);
  };

  for (const group of clusters.values()) {
    const split = group.filter(g => splitSet.has(g.frameId));
    const keep = group.filter(g => !splitSet.has(g.frameId));
    if (keep.length) emitScreen(keep);
    for (const g of split) emitScreen([g]);   // each split frame → its own screen
  }
  // stable screen ordering by canonicalId.
  screens.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  // 3. MODAL BINDING — flow modal edge AUTHORITATIVE for base+trigger; isModalGuess
  // (then AI modalBase) is the fallback. Modals are NOT screens.
  //
  // First CLUSTER + DEDUP modal frames the same way screens are: modal frames with the
  // same (fingerprint + sem + role) are the SAME modal in different states (e.g. an
  // "Alert" sheet's success/error variants) — they fold to ONE canonical modal (lead =
  // lowest frame id) instead of becoming phantom duplicate modals. All sibling frames
  // map to the one modal id in frameMap.
  const modalClusters = new Map<string, NormalizedDescriptor[]>();
  for (const m of [...modalFrames].sort((a, b) => a.frameId.localeCompare(b.frameId))) {
    const k = clusterKey(m);
    (modalClusters.get(k) ?? modalClusters.set(k, []).get(k)!).push(m);
  }
  const modals: CanonicalModal[] = [];
  for (const group of modalClusters.values()) {
    const siblings = [...group].sort((a, b) => a.frameId.localeCompare(b.frameId));
    const lead = siblings[0];
    const canonicalId = modalIdFor(lead.frameId);
    let baseCanonicalId: string | null = null;
    let trigger: CanonicalModalTrigger | null = null;
    let edgeType = 'modal';
    // (a) authoritative: a flow modal edge into ANY sibling frame of this modal.
    for (const s of siblings) {
      const edge = flowModalEdgeFor(s.frameId);
      if (edge && screenByFrame.has(edge.from)) {
        baseCanonicalId = screenByFrame.get(edge.from)!;
        edgeType = edge.type;
        trigger = { fromScreen: baseCanonicalId, edgeType: edge.type, ...(edge.label ? { element: edge.label } : {}) };
        break;
      }
      if (edge) edgeType = edge.type;
    }
    // (b) fallback: the lead descriptor's isModalGuess.base (a semanticName).
    if (!baseCanonicalId && lead.isModalGuess?.base) {
      const sid = semKeyToScreenId.get(semKey(lead.isModalGuess.base));
      if (sid) {
        baseCanonicalId = sid;
        trigger = { fromScreen: sid, edgeType: 'modal', ...(lead.isModalGuess.trigger ? { element: lead.isModalGuess.trigger } : {}) };
      }
    }
    // (c) fallback: the AI's modalBase for any sibling (re-keyed onto a base FRAME id).
    if (!baseCanonicalId) {
      for (const s of siblings) {
        const baseFrame = refinement?.modalBase?.[s.frameId];
        const sid = baseFrame ? screenByFrame.get(baseFrame) : undefined;
        if (sid) { baseCanonicalId = sid; trigger = { fromScreen: sid, edgeType: 'modal' }; break; }
      }
    }
    // map every sibling frame onto the one modal id (dups dropped: one canonical modal).
    for (const s of siblings) frameMap[s.frameId] = canonicalId;
    if (!baseCanonicalId) {
      warnings.push(`modal "${lead.semanticName}" (${lead.frameId}) has no resolvable base screen — present it as an overlay by adding a flow 'modal' edge (HITL checkpoint)`);
      modals.push({
        canonicalId, name: lead.semanticName, frameId: lead.frameId,
        baseCanonicalId: '', trigger: { fromScreen: '', edgeType },
      });
      continue;
    }
    modals.push({
      canonicalId, name: lead.semanticName, frameId: lead.frameId, baseCanonicalId,
      trigger: trigger!,
    });
  }
  modals.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  // 4. TEMPLATES — screens whose section sequence matches → a template + members.
  // Deterministic: group screens by their lead frame's sectionSeq signature; a group
  // of ≥2 distinct screens forms a template. (A single screen is not a template.)
  const sectionSigOf = (canonicalId: string): string => {
    const lead = screens.find(s => s.canonicalId === canonicalId);
    const fid = lead?.frameIds[0];
    const nd = fid ? byFrame.get(fid) : undefined;
    return (nd?.sectionSeq ?? []).join('>');
  };
  const templateGroups = new Map<string, string[]>();   // sectionSig → screen canonicalIds
  for (const s of screens) {
    const sig = sectionSigOf(s.canonicalId);
    if (!sig) continue;     // no sections → not a template candidate
    (templateGroups.get(sig) ?? templateGroups.set(sig, []).get(sig)!).push(s.canonicalId);
  }
  const templates: CanonicalTemplate[] = [];
  for (const [sig, members] of templateGroups) {
    if (members.length < 2) continue;
    const sortedMembers = [...members].sort();
    const id = 't_' + crypto.createHash('sha256').update(sig).digest('hex').slice(0, 10);
    templates.push({ id, memberCanonicalIds: sortedMembers, sharedSections: sig.split('>') });
    for (const cid of sortedMembers) {
      const s = screens.find(x => x.canonicalId === cid);
      if (s) s.templateRef = id;
    }
  }
  templates.sort((a, b) => a.id.localeCompare(b.id));

  // 5. COMPONENTS — lexicon entries (base + learned) whose widget recurs on ≥2
  // canonical screens. Deterministic: tally each canonical widget name's screens.
  // A widget present on a screen counts once for that screen (count = total instances).
  const learnedNames = new Set((lexicon?.learned ?? []).map(e => e.canonicalName));
  const isLexiconTerm = (name: string): boolean => WIDGET_KIND_SET.has(name) || learnedNames.has(name);
  const usedInByName = new Map<string, Set<string>>();
  const countByName = new Map<string, number>();
  for (const s of screens) {
    const seen = new Set<string>();
    for (const fid of s.frameIds) {
      const nd = byFrame.get(fid);
      if (!nd) continue;
      for (const w of nd.widgets) {
        if (!isLexiconTerm(w.canonicalName)) continue;
        countByName.set(w.canonicalName, (countByName.get(w.canonicalName) || 0) + w.count);
        if (!seen.has(w.canonicalName)) {
          (usedInByName.get(w.canonicalName) ?? usedInByName.set(w.canonicalName, new Set()).get(w.canonicalName)!).add(s.canonicalId);
          seen.add(w.canonicalName);
        }
      }
    }
  }
  const components: CanonicalComponent[] = [];
  for (const [name, screenSet] of usedInByName) {
    if (screenSet.size < 2) continue;          // a component must recur across ≥2 screens
    components.push({
      canonicalName: name,
      kind: componentKind(name),
      usedIn: [...screenSet].sort(),
      count: countByName.get(name) || screenSet.size,
    });
  }
  components.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  // 6. FLOW REWRITE onto canonical ids. A modal edge becomes an 'overlay' edge whose
  // TARGET is the MODAL's canonical id (so the graph reads "from base screen, present
  // modal X" — a real presentation, never a screen→itself self-loop). An edge FROM a
  // modal resolves the modal's source to its base screen. Intra-canonical edges (both
  // ends the same screen) fold into in-screen state transitions and drop out; parallel
  // duplicates dedupe.
  // resolve a frame to its modal via the frameMap (covers folded sibling state frames,
  // not just the modal's lead frame).
  const modalById = new Map(modals.map(m => [m.canonicalId, m]));
  const modalForFrame = (frameId: string): CanonicalModal | undefined => {
    const cid = frameMap[frameId];
    return cid ? modalById.get(cid) : undefined;
  };
  // The SOURCE side of an edge: a modal frame resolves to its base screen (you trigger
  // the next thing from the screen the modal sits over).
  const resolveSource = (frameId: string): string | null => {
    const m = modalForFrame(frameId);
    if (m) return m.baseCanonicalId || null;
    return screenByFrame.get(frameId) ?? null;
  };
  // The TARGET side: a modal frame stays as the modal (overlay presentation); a screen
  // frame resolves to its screen id.
  const resolveTarget = (frameId: string): { id: string; overlay: boolean } | null => {
    const m = modalForFrame(frameId);
    if (m) return { id: m.canonicalId, overlay: true };       // present the MODAL
    const sid = screenByFrame.get(frameId);
    if (sid) return { id: sid, overlay: false };
    return null;
  };
  // Entry: a modal entry falls back to its base screen so the app boots a real route.
  const entryCanonicalId = safeFlow.entryFrameId ? resolveSource(safeFlow.entryFrameId) : null;
  const seen = new Set<string>();
  const edges: CanonicalFlowEdge[] = [];
  for (const c of safeFlow.connections) {
    const from = resolveSource(c.from);
    const toR = resolveTarget(c.to);
    if (!from || !toR) continue;
    const to = toR.id;
    if (!from || !to) continue;
    if (from === to && !toR.overlay) continue;     // intra-screen → state transition (dropped)
    const kind = toR.overlay ? 'overlay' : (c.type === 'replace' ? 'push' : c.type);
    const key = `${from}|${to}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind, ...(c.label ? { label: c.label } : {}) });
  }
  // stable edge ordering.
  edges.sort((a, b) => (a.from.localeCompare(b.from)) || (a.to.localeCompare(b.to)) || a.kind.localeCompare(b.kind));

  if (!safeFlow.connections.length) {
    warnings.push('flow has 0 edges — no navigation graph; nav + modal binding must be set manually (HITL checkpoint)');
  }
  if (!entryCanonicalId) {
    warnings.push('no entry screen resolved from the flow — set the app entry manually');
  }

  // assemble + hash. contentHash is over the canonical STRUCTURE (ids/relationships),
  // NOT the cosmetic names, so a rename leaves the hash stable (idempotency proof).
  const canonical: CanonicalModel = {
    version: 1,
    projectId,
    figStorageKey,
    contentHash: '',
    screens,
    modals,
    templates,
    components,
    flow: { entryCanonicalId, edges },
    warnings: [...warnings].sort(),
  };
  canonical.contentHash = hashCanonical(canonical);

  // persist.
  let canonicalPath: string | null = null;
  const persist = opts.persist !== false;
  if (root && fsSync.existsSync(root) && persist) {
    const abs = path.join(root, '.uix', 'canonical.json');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(canonical, null, 2));
    canonicalPath = abs;
  }

  return { canonical, frameMap, canonicalPath, aiRefined };
}

// ── stable content hash (structure-only, idempotency proof) ──────────────────
// Hash the canonical RELATIONSHIPS (ids, frame membership, bindings, flow edges,
// component usage) — never cosmetic names — so identical structure → identical hash
// across re-runs and renames. lexiconVersion is folded in so a lexicon bump
// invalidates a cached canonical.
function hashCanonical(c: CanonicalModel): string {
  const shape = {
    v: c.version,
    lex: LEXICON_VERSION,
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
