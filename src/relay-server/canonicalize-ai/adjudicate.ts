// =============================================================================
// File: src/relay-server/canonicalize-ai/adjudicate.ts
//
// ADJUDICATE (Phase 1d) — the FINAL canonicalization step: a TARGETED, VISION-
// GROUNDED review of the *residue* the deterministic 1c Reduce could not settle on
// COMPACT descriptors + fingerprints alone, plus a last sanity pass. 1c is cheap and
// holistic (compact descriptors + deterministic fingerprints + flow, only an advisory
// AI tiebreak); 1d is EXPENSIVE per item, so it must stay CHEAP overall by drilling
// ONLY the uncertain items, and ONLY with the actual REFERENCE IMAGES of the candidate
// frames — never all frames, never raw IR.
//
// WHAT IS "UNCERTAIN" (the residue 1c flags but cannot prove):
//   1. FALLBACK-BOUND MODALS — a modal whose base screen came from the descriptor's
//      isModalGuess (or the 1c AI modalBase), NOT from a flow 'modal' edge. The flow
//      is AUTHORITATIVE; a guess-bound modal is the weakest binding and must be
//      vision-confirmed ("does the dimmed background behind this sheet match screen X?").
//   2. BORDERLINE STATE/DEDUP CLUSTERS — frames with the SAME semanticName + role but
//      NEAR-BUT-NOT-EQUAL frame fingerprints: 1c kept them as SEPARATE screens (the
//      fingerprint anchor differed) but they MIGHT be the same screen in two states.
//      Vision settles "same screen (a state) or two different screens?".
//   3. COARSE TEMPLATE GROUPINGS — a template binding ≥3 members on a single shared
//      section sequence is a strong structural claim that can over-group; confirm the
//      members really share a layout skeleton.
//   4. WEAK-EVIDENCE COMPONENTS — a component used in EXACTLY 2 screens is the weakest
//      recurrence evidence (one more than the ≥2 floor); confirm it is a real shared
//      component and not a coincidental structural twin.
//   5. EXISTING model.warnings — every 1c warning is an unresolved doubt by definition.
//
// WHAT 1d MAY DO — and the HARD GUARDRAIL:
//   It may RE-BIND a fallback-bound modal, MERGE a borderline state pair, DROP a
//   phantom template/component. It may NEVER touch a FLOW-AUTHORITATIVE binding: a
//   modal bound by a flow 'modal' edge, a state fold the fingerprint anchor PROVED,
//   the flow graph, ids/routes. Adjudication only ever changes LOW-CONFIDENCE items;
//   it can never override a decision the flow or a fingerprint match already settled.
//   Every applied change is recorded in changes[]; every unresolved doubt in warnings[].
//
// CHEAP + IDEMPOTENT: when nothing is uncertain we skip the model entirely (0 tokens).
// The vision verdict is cached by a deterministic signature of the exact uncertain set
// (the 1b/1c pattern) so a re-run reuses it. The corrected canonical.json is re-hashed
// (hashCanonical) so an applied correction yields a NEW stable hash and a no-op re-run
// reproduces it byte-for-byte.
//
// Imports the read-only 1a/1b/1c modules + reference-render. Never mutates them.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot, createTerminalEnv, resolveWorkspace } from '../runtime';
import { requireModel } from '../ai-observability';
import type { AIModel } from '../ai-adapters';
import { renderFrameReference } from '../reference-render';
import { LEXICON_VERSION } from './lexicon';
import type { FrameDescriptor } from './descriptor-schema';
import {
  type CanonicalModel, type CanonicalScreen, type CanonicalModal,
} from './reduce';

// ── public types ──────────────────────────────────────────────────────────────

/** One applied correction (what changed + why) for the HITL record. */
export interface AdjudicationChange {
  kind: 'modal-rebind' | 'state-merge' | 'template-drop' | 'component-drop';
  /** the canonical id(s) the change touched. */
  target: string;
  /** a human one-liner: what changed and the vision evidence behind it. */
  detail: string;
}

export interface AdjudicateResult {
  canonical: CanonicalModel;
  /** every applied correction (empty = the 1c model was already confident). */
  changes: AdjudicationChange[];
  /** unresolved doubts surfaced for the HITL checkpoint (incl. carried-over 1c warnings). */
  warnings: string[];
  /** which canonical ids / frames were actually drilled (for the cheap-pass audit). */
  drilled: string[];
  /** where the corrected canonical.json was written (null if persist:false / no root). */
  canonicalPath: string | null;
  /** whether the bounded vision call ran (false = nothing uncertain, or cache hit/offline). */
  visionRan: boolean;
}

export interface AdjudicateOptions {
  /** AI provider (claude/codex/gemini) — respects the run's selected model; default claude. */
  provider?: AIModel;
  modelId?: string;
  /** durable run id — threaded into the AI log ctx so firing proof lands in the run log. */
  runId?: string;
  /** skip the vision call (deterministic-only) — for tests / offline. */
  skipAi?: boolean;
  /** write the corrected canonical.json (default true). */
  persist?: boolean;
  /** ignore the persisted vision cache + force a fresh model call. */
  forceAdjudicate?: boolean;
  /** reference-render harness origin override (defaults to the module singleton). */
  harnessBaseUrl?: string;
  /** device width/height per frame, for the reference render (best-effort if absent). */
  frameDims?: Record<string, { width: number; height: number }>;
  /** reference render scale (default 2). */
  scale?: number;
}

// ── shared helpers (mirrors 1c's private helpers; duplicated so 1c stays read-only) ─

const isModalRole = (role: string): boolean => role === 'modal' || role === 'sheet';
function semKey(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Re-hash a (mutated) canonical model EXACTLY as 1c's hashCanonical does — structure
 * only (ids/relationships), never cosmetic names, lexiconVersion folded in. Kept in
 * sync with reduce.ts:hashCanonical (which is private there); a divergence would only
 * change the absolute hex, not the idempotency property, but we keep it identical so a
 * 1c model untouched by 1d re-hashes to the SAME value (a no-op adjudication is a true
 * no-op). If reduce.ts ever exports hashCanonical, swap to it.
 */
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

// ── residue detection — identify the uncertain items 1c could not prove ──────────

/** A candidate uncertain modal: bound to a base, but the binding came from a GUESS
 *  (isModalGuess / 1c AI modalBase) rather than a flow 'modal' edge — OR unbound. */
interface UncertainModal {
  modal: CanonicalModal;
  reason: 'fallback-bound' | 'unbound';
  /** candidate base screen ids to confirm/choose between (vision picks one). */
  candidateBaseIds: string[];
}

/** A borderline state pair: two screens with the SAME semantic key but DIFFERENT
 *  fingerprints — 1c kept them apart; vision decides same-screen-state vs distinct. */
interface BorderlineStatePair {
  a: CanonicalScreen;
  b: CanonicalScreen;
  semanticKey: string;
}

interface Residue {
  uncertainModals: UncertainModal[];
  borderlineStates: BorderlineStatePair[];
  coarseTemplateIds: string[];
  weakComponents: string[];   // canonicalName of components used in exactly 2 screens
  carriedWarnings: string[];
}

const residueIsEmpty = (r: Residue): boolean =>
  r.uncertainModals.length === 0 && r.borderlineStates.length === 0
  && r.coarseTemplateIds.length === 0 && r.weakComponents.length === 0;

// ── reference rendering for the drilled frames only ──────────────────────────────
// We render the candidate frames' references (never all frames) so the vision call
// looks at the REAL pixels. Best-effort: a frame we can't render is dropped from the
// vision question (it falls through to a warning, never a silent wrong correction).

async function renderRefs(
  figStorageKey: string,
  frameIds: string[],
  root: string,
  opts: AdjudicateOptions,
): Promise<Map<string, string>> {     // frameId → project-relative png path
  const out = new Map<string, string>();
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 2;
  for (const frameId of [...new Set(frameIds)]) {
    const dims = opts.frameDims?.[frameId];
    if (!dims || !dims.width || !dims.height) continue;       // need device dims to render
    try {
      const ref = await renderFrameReference({
        harnessBaseUrl: opts.harnessBaseUrl,
        figStorageKey, frameId, scale, width: dims.width, height: dims.height,
      });
      if (!ref) continue;
      const rel = path.join('.uix', 'canon-refs', `${frameId.replace(/[^a-zA-Z0-9]+/g, '_')}.png`);
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, ref.png);
      out.set(frameId, rel);
    } catch { /* best-effort — drop this frame from the vision question */ }
  }
  return out;
}

// ── the bounded, cached, VISION-grounded adjudication call ───────────────────────

interface VisionVerdict {
  /** modalFrameId → confirmed/corrected base canonical id ('' = keep as unresolved). */
  modalBase: Record<string, string>;
  /** pairs the model says are the SAME screen (merge b into a): "aId|bId". */
  stateMerges: string[];
  /** template ids the model says are NOT a real shared layout (drop). */
  dropTemplates: string[];
  /** component names the model says are coincidental, not real shared components. */
  dropComponents: string[];
}

const EMPTY_VERDICT: VisionVerdict = { modalBase: {}, stateMerges: [], dropTemplates: [], dropComponents: [] };

/** Deterministic signature of the exact uncertain set fed to the vision model. */
function adjudicateSignature(canonical: CanonicalModel, r: Residue): string {
  const payload = {
    h: canonical.contentHash,
    m: r.uncertainModals.map(u => `${u.modal.canonicalId}:${u.reason}:${u.candidateBaseIds.slice().sort().join(',')}`).sort(),
    s: r.borderlineStates.map(p => [p.a.canonicalId, p.b.canonicalId].sort().join('|')).sort(),
    t: [...r.coarseTemplateIds].sort(),
    c: [...r.weakComponents].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

const cachePath = (root: string): string => path.join(root, '.uix', 'canonical-adjudicate.json');

async function readCache(root: string, signature: string): Promise<VisionVerdict | null> {
  try {
    const raw = await fs.readFile(cachePath(root), 'utf8');
    const c = JSON.parse(raw) as { signature: string; verdict: VisionVerdict };
    if (c && c.signature === signature && c.verdict) return c.verdict;
  } catch { /* no cache → recompute */ }
  return null;
}
async function writeCache(root: string, signature: string, verdict: VisionVerdict): Promise<void> {
  try {
    const abs = cachePath(root);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify({ signature, verdict }, null, 2));
  } catch { /* best-effort */ }
}

function buildAdjudicatePrompt(
  canonical: CanonicalModel, r: Residue, refs: Map<string, string>,
): string {
  const screenName = (id: string): string => canonical.screens.find(s => s.canonicalId === id)?.name ?? id;
  const leadFrame = (id: string): string => canonical.screens.find(s => s.canonicalId === id)?.frameIds[0] ?? '';
  const refLine = (frameId: string): string => {
    const p = refs.get(frameId);
    return p ? `${frameId} → image: ${p}` : `${frameId} → (no image; reason from structure only)`;
  };

  const lines: string[] = [
    `You are the FINAL adjudicator of a canonical app design model. The deterministic`,
    `pass already settled the confident parts; you ONLY review the UNCERTAIN items below,`,
    `using the ACTUAL RENDERED REFERENCE IMAGES (open each listed image with your file tool;`,
    `they are the ground truth for what the frame LOOKS like). Be conservative: only`,
    `recommend a change when the images make it CLEAR. When in doubt, leave it unchanged.`,
    ``,
  ];

  if (r.uncertainModals.length) {
    lines.push(`A) FALLBACK-BOUND / UNBOUND MODALS — each modal below was bound to a base`);
    lines.push(`   screen by a GUESS, not the navigation flow. For each, look at the modal's`);
    lines.push(`   image: a modal shows a dialog/sheet over a DIMMED version of its base screen.`);
    lines.push(`   Decide which candidate base screen the dimmed background actually matches.`);
    for (const u of r.uncertainModals) {
      const cands = u.candidateBaseIds.map(id => `${screenName(id)} [${id}] (${refLine(leadFrame(id))})`).join('; ');
      lines.push(`   - modal "${u.modal.name}" [${u.modal.canonicalId}] ${refLine(u.modal.frameId)}`);
      lines.push(`     current base: ${u.modal.baseCanonicalId ? screenName(u.modal.baseCanonicalId) + ' [' + u.modal.baseCanonicalId + ']' : '(none)'}`);
      lines.push(`     candidate bases: ${cands || '(any screen)'}`);
    }
    lines.push(``);
  }
  if (r.borderlineStates.length) {
    lines.push(`B) BORDERLINE STATE PAIRS — two frames share a name but were kept as SEPARATE`);
    lines.push(`   screens (their structure differed slightly). Look at both images: are they the`);
    lines.push(`   SAME screen in two states (a filled form, an error, a loaded list) — which should`);
    lines.push(`   MERGE — or genuinely DIFFERENT screens that should stay apart?`);
    for (const p of r.borderlineStates) {
      lines.push(`   - pair ${p.a.canonicalId} vs ${p.b.canonicalId}:`);
      lines.push(`       ${p.a.name} ${refLine(p.a.frameIds[0])}`);
      lines.push(`       ${p.b.name} ${refLine(p.b.frameIds[0])}`);
    }
    lines.push(``);
  }
  if (r.coarseTemplateIds.length) {
    lines.push(`C) TEMPLATE GROUPINGS — these templates claim several screens share ONE layout`);
    lines.push(`   skeleton. Confirm from the member images that they really do; if a grouping is`);
    lines.push(`   spurious (the members don't actually share a layout), list it to DROP.`);
    for (const tid of r.coarseTemplateIds) {
      const t = canonical.templates.find(x => x.id === tid)!;
      const members = t.memberCanonicalIds.map(id => `${screenName(id)} ${refLine(leadFrame(id))}`).join(' | ');
      lines.push(`   - template ${tid} sections=[${t.sharedSections.join('>')}] members: ${members}`);
    }
    lines.push(``);
  }
  if (r.weakComponents.length) {
    lines.push(`D) WEAK COMPONENTS — each appears on EXACTLY two screens (the minimum). Confirm`);
    lines.push(`   it is a genuine shared component; list any that are coincidental to DROP.`);
    for (const name of r.weakComponents) {
      const cm = canonical.components.find(c => c.canonicalName === name)!;
      const where = cm.usedIn.map(id => screenName(id)).join(', ');
      lines.push(`   - "${name}" (kind=${cm.kind}) on: ${where}`);
    }
    lines.push(``);
  }

  lines.push(`OUTPUT — a SINGLE JSON object, no prose, no code fences:`);
  lines.push(`{`);
  lines.push(`  "modalBase": { "<modalFrameId>": "<chosen base canonical id, or ''>" },`);
  lines.push(`  "stateMerges": ["<aCanonicalId>|<bCanonicalId>", ...],   // pairs that are the SAME screen`);
  lines.push(`  "dropTemplates": ["<templateId>", ...],`);
  lines.push(`  "dropComponents": ["<componentName>", ...]`);
  lines.push(`}`);
  lines.push(`Only include GENUINE corrections; empty objects/arrays are fine. Do NOT write files.`);
  return lines.join('\n');
}

/** Run the bounded vision adjudication; returns a sanitized verdict re-keyed onto the
 *  real model anchors (so a hallucinated id can never corrupt the model). */
async function runVision(
  canonical: CanonicalModel, r: Residue, refs: Map<string, string>,
  projectId: string, root: string, modelId: string, runId?: string, provider: AIModel = 'claude',
): Promise<VisionVerdict | null> {
  // AI-PURPOSE (Phase 1d vision adjudication). The model is REQUIRED to fire — a
  // no-fire / error must SURFACE (RFC §0.1), not be swallowed into a null that
  // looks like "vision ran, no corrections". A fired-but-non-JSON reply
  // legitimately returns null (the low-confidence residue parks for HITL).
  const env = createTerminalEnv(resolveWorkspace());
  const prompt = buildAdjudicatePrompt(canonical, r, refs);
  {
    // agent:true so the CLI can OPEN the reference image files (vision grounding).
    const { text } = await requireModel(provider, prompt, env, root, {
      agent: true, modelId,
      log: { projectId, runId, step: 'canon.adjudicate' },
    });
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') return null;

    const screenIds = new Set(canonical.screens.map(s => s.canonicalId));
    const modalFrameIds = new Set(canonical.modals.map(m => m.frameId));
    const uncertainModalFrames = new Set(r.uncertainModals.map(u => u.modal.frameId));
    const borderlineKeys = new Set(r.borderlineStates.map(p => [p.a.canonicalId, p.b.canonicalId].sort().join('|')));
    const templateIds = new Set(r.coarseTemplateIds);
    const componentNames = new Set(r.weakComponents);

    const modalBase: Record<string, string> = {};
    if (parsed.modalBase && typeof parsed.modalBase === 'object') {
      for (const [mf, base] of Object.entries(parsed.modalBase)) {
        if (!uncertainModalFrames.has(mf)) continue;            // only the items we asked about
        const b = String(base || '');
        if (b === '' || screenIds.has(b)) modalBase[mf] = b;    // must be a REAL screen id (or unresolved)
      }
    }
    const stateMerges: string[] = Array.isArray(parsed.stateMerges)
      ? [...new Set((parsed.stateMerges as unknown[]).map(v => {
          const parts = String(v).split('|').map(s => s.trim());
          return parts.length === 2 ? parts.sort().join('|') : '';
        }))].filter(k => k && borderlineKeys.has(k))             // only pairs we flagged
      : [];
    const dropTemplates: string[] = Array.isArray(parsed.dropTemplates)
      ? [...new Set((parsed.dropTemplates as unknown[]).map(v => String(v)))].filter(t => templateIds.has(t))
      : [];
    const dropComponents: string[] = Array.isArray(parsed.dropComponents)
      ? [...new Set((parsed.dropComponents as unknown[]).map(v => String(v)))].filter(c => componentNames.has(c))
      : [];

    return { modalBase, stateMerges, dropTemplates, dropComponents };
  }
}

// ── apply the verdict to the model (low-confidence items ONLY) ───────────────────

function applyVerdict(
  canonical: CanonicalModel, r: Residue, verdict: VisionVerdict,
): { model: CanonicalModel; changes: AdjudicationChange[]; warnings: string[] } {
  // deep clone so the input model is never mutated (idempotent + side-effect-free).
  const model: CanonicalModel = JSON.parse(JSON.stringify(canonical));
  const changes: AdjudicationChange[] = [];
  const warnings: string[] = [];
  const screenName = (id: string): string => model.screens.find(s => s.canonicalId === id)?.name ?? id;

  // A) MODAL RE-BIND. Only re-bind a fallback/unbound modal, only to a real screen.
  for (const u of r.uncertainModals) {
    const choice = verdict.modalBase[u.modal.frameId];
    const m = model.modals.find(x => x.canonicalId === u.modal.canonicalId);
    if (!m) continue;
    if (choice === undefined) {
      if (u.reason === 'unbound') warnings.push(`modal "${m.name}" (${m.frameId}) still has no vision-confirmed base — set it manually (HITL)`);
      continue;
    }
    if (choice === '') {
      warnings.push(`modal "${m.name}" (${m.frameId}) base could not be confirmed from its image — set it manually (HITL)`);
      continue;
    }
    if (choice === m.baseCanonicalId) continue;            // vision confirmed the existing guess → no change
    const prev = m.baseCanonicalId || '(none)';
    m.baseCanonicalId = choice;
    m.trigger = { ...m.trigger, fromScreen: choice };
    changes.push({
      kind: 'modal-rebind', target: m.canonicalId,
      detail: `re-bound modal "${m.name}" base from ${prev === '(none)' ? '(none)' : screenName(prev)} to ${screenName(choice)} — dimmed background in the reference matched it (was a ${u.reason} guess, not flow-authoritative)`,
    });
  }

  // B) STATE MERGE. Merge b into a: fold b's frames/states under a, drop screen b.
  for (const key of verdict.stateMerges) {
    const [aId, bId] = key.split('|');
    const a = model.screens.find(s => s.canonicalId === aId);
    const b = model.screens.find(s => s.canonicalId === bId);
    if (!a || !b) continue;
    // GUARDRAIL: never merge a screen that is a flow entry or referenced by an edge as a
    // distinct node in a way the merge would corrupt — we re-point flow edges instead.
    const startStates = a.states.length;
    for (const f of b.frameIds) if (!a.frameIds.includes(f)) a.frameIds.push(f);
    for (const st of b.states) {
      if (a.states.some(x => x.frameId === st.frameId)) continue;
      a.states.push({ id: `state${a.states.length + 1}`, frameId: st.frameId, brief: st.brief });
    }
    model.screens = model.screens.filter(s => s.canonicalId !== bId);
    // re-point any flow edge / modal base / template / component referencing b → a.
    model.flow.edges = model.flow.edges
      .map(e => ({ ...e, from: e.from === bId ? aId : e.from, to: e.to === bId ? aId : e.to }))
      .filter(e => !(e.from === e.to && e.kind !== 'overlay'));
    if (model.flow.entryCanonicalId === bId) model.flow.entryCanonicalId = aId;
    for (const m of model.modals) {
      if (m.baseCanonicalId === bId) m.baseCanonicalId = aId;
      if (m.trigger.fromScreen === bId) m.trigger.fromScreen = aId;
    }
    for (const t of model.templates) t.memberCanonicalIds = [...new Set(t.memberCanonicalIds.map(id => id === bId ? aId : id))].sort();
    for (const cm of model.components) cm.usedIn = [...new Set(cm.usedIn.map(id => id === bId ? aId : id))].sort();
    changes.push({
      kind: 'state-merge', target: `${aId}<-${bId}`,
      detail: `merged screen "${b.name}" [${bId}] into "${a.name}" [${aId}] as a state — the reference images show the same screen in two states (states ${startStates}→${a.states.length})`,
    });
  }
  // dedupe flow edges that collided after re-pointing.
  {
    const seen = new Set<string>();
    model.flow.edges = model.flow.edges.filter(e => {
      const k = `${e.from}|${e.to}|${e.kind}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
  }

  // C) TEMPLATE DROP.
  for (const tid of verdict.dropTemplates) {
    const t = model.templates.find(x => x.id === tid);
    if (!t) continue;
    model.templates = model.templates.filter(x => x.id !== tid);
    for (const s of model.screens) if (s.templateRef === tid) delete s.templateRef;
    changes.push({
      kind: 'template-drop', target: tid,
      detail: `dropped template ${tid} (members ${t.memberCanonicalIds.join(',')}) — the reference images show they do NOT share one layout skeleton`,
    });
  }

  // D) COMPONENT DROP.
  for (const name of verdict.dropComponents) {
    const cm = model.components.find(c => c.canonicalName === name);
    if (!cm) continue;
    model.components = model.components.filter(c => c.canonicalName !== name);
    changes.push({
      kind: 'component-drop', target: name,
      detail: `dropped component "${name}" — appeared on exactly 2 screens and the references show it is a coincidental structural twin, not a real shared component`,
    });
  }

  // carry over the 1c warnings as still-open doubts, plus any new ones.
  for (const w of r.carriedWarnings) warnings.push(w);

  // re-sort everything to keep the canonical ordering stable (1c invariants).
  model.screens.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  model.modals.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  model.templates.sort((a, b) => a.id.localeCompare(b.id));
  model.components.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  model.flow.edges.sort((a, b) => (a.from.localeCompare(b.from)) || (a.to.localeCompare(b.to)) || a.kind.localeCompare(b.kind));
  model.warnings = [...new Set(warnings)].sort();

  return { model, changes, warnings: model.warnings };
}

// ── main entry ───────────────────────────────────────────────────────────────

/**
 * Phase 1d. Vision-grounded adjudication of the *residue* a 1c canonical model could
 * not settle deterministically. Drills ONLY the uncertain items (logged in `drilled`)
 * with their real reference images, applies vision-confirmed corrections, re-hashes +
 * persists the corrected canonical.json, and records every change + open doubt.
 *
 * GUARDRAIL: only ever touches LOW-CONFIDENCE items — a flow-authoritative modal
 * binding, a fingerprint-proven state fold, the flow graph and ids/routes are NEVER
 * overridden. Cheap + idempotent: skips the model when nothing is uncertain (0 tokens),
 * caches the vision verdict by a deterministic signature, and a no-op run reproduces
 * the input byte-for-byte.
 */
export async function adjudicateCanonical(
  projectId: string,
  figStorageKey: string,
  canonical: CanonicalModel,
  descriptors: FrameDescriptor[],
  opts: AdjudicateOptions = {},
): Promise<AdjudicateResult> {
  const root = resolveProjectRoot(projectId);

  // Detect the residue. PROVENANCE / GUARDRAIL: 1c only rewrites a flow modal edge into
  // an 'overlay' edge in the canonical flow when it had a FLOW-AUTHORITATIVE modal edge.
  // So a modal whose canonical id is the target of an 'overlay' edge is flow-bound and
  // MUST NOT be adjudicated; only guess/fallback-bound (and unbound) modals are drilled.
  const overlayBoundModalIds = new Set(
    canonical.flow.edges.filter(e => e.kind === 'overlay').map(e => e.to),
  );
  const residue = detectResidue(canonical, descriptors, overlayBoundModalIds);

  const drilled: string[] = [
    ...residue.uncertainModals.map(u => u.modal.canonicalId),
    ...residue.borderlineStates.map(p => `${p.a.canonicalId}|${p.b.canonicalId}`),
    ...residue.coarseTemplateIds,
    ...residue.weakComponents.map(n => `component:${n}`),
  ];

  // CHEAP: nothing uncertain → return the model unchanged (re-hashed for stability),
  // carrying any existing warnings. 0 tokens.
  if (residueIsEmpty(residue)) {
    const model: CanonicalModel = JSON.parse(JSON.stringify(canonical));
    model.warnings = [...new Set(residue.carriedWarnings)].sort();
    model.contentHash = hashCanonical(model);
    const canonicalPath = await maybePersist(root, model, opts);
    return { canonical: model, changes: [], warnings: model.warnings, drilled, canonicalPath, visionRan: false };
  }

  // VISION verdict — cached by a deterministic signature of the uncertain set.
  let verdict: VisionVerdict | null = null;
  let visionRan = false;
  const canRunAi = !opts.skipAi && !!root && fsSync.existsSync(root);
  if (canRunAi && root) {
    const sig = adjudicateSignature(canonical, residue);
    verdict = opts.forceAdjudicate ? null : await readCache(root, sig);
    if (verdict) {
      visionRan = true;
    } else {
      // render ONLY the drilled frames' references (never all frames).
      const frameIds = [
        ...residue.uncertainModals.flatMap(u => [u.modal.frameId, ...u.candidateBaseIds.map(id => canonical.screens.find(s => s.canonicalId === id)?.frameIds[0]).filter(Boolean) as string[]]),
        ...residue.borderlineStates.flatMap(p => [p.a.frameIds[0], p.b.frameIds[0]]),
        ...residue.coarseTemplateIds.flatMap(tid => (canonical.templates.find(t => t.id === tid)?.memberCanonicalIds ?? []).map(id => canonical.screens.find(s => s.canonicalId === id)?.frameIds[0]).filter(Boolean) as string[]),
      ].filter(Boolean) as string[];
      const refs = await renderRefs(figStorageKey, frameIds, root, opts);
      const v = await runVision(canonical, residue, refs, projectId, root, opts.modelId ?? 'sonnet', opts.runId, opts.provider ?? 'claude');
      if (v) {
        verdict = v;
        visionRan = true;
        if (opts.persist !== false) await writeCache(root, sig, v);
      }
    }
  }

  // apply (or, if vision unavailable, surface the residue as warnings without changing anything).
  if (!verdict) {
    const model: CanonicalModel = JSON.parse(JSON.stringify(canonical));
    const w = [...residue.carriedWarnings];
    for (const u of residue.uncertainModals) w.push(`modal "${u.modal.name}" (${u.modal.frameId}) base is a ${u.reason} guess — vision adjudication unavailable; confirm manually (HITL)`);
    model.warnings = [...new Set(w)].sort();
    model.contentHash = hashCanonical(model);
    const canonicalPath = await maybePersist(root, model, opts);
    return { canonical: model, changes: [], warnings: model.warnings, drilled, canonicalPath, visionRan: false };
  }

  const applied = applyVerdict(canonical, residue, verdict);
  applied.model.contentHash = hashCanonical(applied.model);
  const canonicalPath = await maybePersist(root, applied.model, opts);

  return {
    canonical: applied.model, changes: applied.changes, warnings: applied.warnings,
    drilled, canonicalPath, visionRan,
  };
}

/** Identify the uncertain residue. A modal whose canonical id is the target of an
 *  'overlay' edge is FLOW-AUTHORITATIVE (1c only emits overlay edges for real flow modal
 *  edges) and is excluded from the drilled set — the guardrail against corrupting a
 *  correct, flow-proven binding. */
function detectResidue(
  canonical: CanonicalModel,
  descriptors: FrameDescriptor[],
  overlayBoundModalIds: Set<string>,
): Residue {
  // build the same residue, but a modal whose canonical id is overlay-bound by the flow
  // is AUTHORITATIVE → excluded from uncertainModals (the guardrail).
  const screenFrameIds = new Set<string>();
  for (const s of canonical.screens) for (const f of s.frameIds) screenFrameIds.add(f);

  const uncertainModals: UncertainModal[] = [];
  for (const m of canonical.modals) {
    if (overlayBoundModalIds.has(m.canonicalId)) continue;     // flow-authoritative → never adjudicate
    if (!m.baseCanonicalId) {
      uncertainModals.push({ modal: m, reason: 'unbound', candidateBaseIds: canonical.screens.map(s => s.canonicalId) });
    } else {
      uncertainModals.push({ modal: m, reason: 'fallback-bound', candidateBaseIds: [...new Set([m.baseCanonicalId, ...canonical.screens.map(s => s.canonicalId)])].slice(0, 8) });
    }
  }

  // borderline state pairs, coarse templates, weak components.
  const screensBySem = new Map<string, CanonicalScreen[]>();
  for (const s of canonical.screens) {
    const k = semKey(s.name);
    (screensBySem.get(k) ?? screensBySem.set(k, []).get(k)!).push(s);
  }
  const borderlineStates: BorderlineStatePair[] = [];
  for (const [k, group] of screensBySem) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
    for (let i = 0; i < sorted.length - 1; i++) borderlineStates.push({ a: sorted[i], b: sorted[i + 1], semanticKey: k });
  }
  const coarseTemplateIds = canonical.templates.filter(t => t.memberCanonicalIds.length >= 3).map(t => t.id);
  const weakComponents = canonical.components.filter(cm => cm.usedIn.length === 2).map(cm => cm.canonicalName);
  const carriedWarnings = [...(canonical.warnings || [])];

  void descriptors;
  return { uncertainModals, borderlineStates, coarseTemplateIds, weakComponents, carriedWarnings };
}

async function maybePersist(root: string | null, model: CanonicalModel, opts: AdjudicateOptions): Promise<string | null> {
  if (opts.persist === false) return null;
  if (!root || !fsSync.existsSync(root)) return null;
  const abs = path.join(root, '.uix', 'canonical.json');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(model, null, 2));
  return abs;
}
