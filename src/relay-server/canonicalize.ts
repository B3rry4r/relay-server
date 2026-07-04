// =============================================================================
// File: src/relay-server/canonicalize.ts
//
// RFC §4.1 / §4.2 (P3): Canonicalization pre-pass + flow rewrite + deterministic
// write-locked skeleton.
//
// A *frame is not a screen*. Ping's 40 frames are ~24 canonical screens + states
// + a couple of modals + a couple of components. One-route-per-frame explodes
// duplicates / states / modals into bogus routes and rebuilds modal-over-base
// frames as standalone pages. This module collapses frames → canonical screens:
//
//   1. CLUSTER frames by a *skeleton hash* — node-kind + bucketed bbox per depth,
//      with names / colours / assets stripped — via union-find at ~0.85 Jaccard.
//   2. SPLIT each cluster by text/asset diff: a value-only diff (typed digits, an
//      icon swap) → a *state* of one screen; a semantic diff (Change Password vs
//      Change PIN) → distinct screens that share a *template*.
//   3. CLASSIFY role: screen | modal/sheet | component (scrim+sheet detector;
//      small bbox / no device chrome → component).
//   4. BIND each modal to its base screen (flow `modal` edge → bbox containment →
//      else flag for human).
//   5. REWRITE the flow graph onto canonical ids: intra-canonical edges become
//      in-screen state transitions, modal edges become overlay presentations,
//      parallel edges are deduped.
//
// Everything here is DETERMINISTIC and works off data already on the run: each
// screen's IR *tree notation* string (`spec.tree`), its `width`/`height`, its
// reference PNG path, plus the run's flow graph. The ambiguous-residue agent
// adjudicator (RFC §4.1) is intentionally NOT wired here — see TODO(P3) — so the
// pre-pass never depends on an LLM call. The output is `canonical.json` (schema
// in RFC §4.1) plus a write-locked skeleton the per-screen builds fill in.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { RunFlow, RunScreen } from './build-run-store';
import { deriveSemanticIdentifiers, tokenizeName } from './semantic-names';

// ── canonical.json schema (RFC §4.1) ─────────────────────────────────────────
export interface CanonicalState { id: string; frameId: string }
export interface CanonicalModal { id: string; frameId: string; baseCanonicalId: string | null }
export interface CanonicalScreen {
  canonicalId: string;
  frameIds: string[];
  /** display name (the lead frame's name) — cosmetic alias; routes key on id. */
  name: string;
  states: CanonicalState[];
  modals: CanonicalModal[];
  role: 'screen';
  /** stable route slug derived from the canonicalId (NOT the mutable name). */
  route: string;
  templateRef?: string;
}
export interface CanonicalComponent { id: string; frameId: string; name: string }
export interface CanonicalTemplate { id: string; memberCanonicalIds: string[] }
/** A flow edge rewritten onto canonical ids. */
export interface CanonicalFlowEdge {
  fromCanonicalId: string;
  toCanonicalId: string;
  /** 'overlay' when the target is a modal/sheet, else the original edge type
   *  ('push' | 'replace' | 'tab' | …). 'replace' is preserved end-to-end so
   *  flow-wiring can demand a replacement nav verb. */
  kind: 'push' | 'replace' | 'tab' | 'overlay' | string;
  label?: string;
  /** Step-modal provenance: the modal the raw edge originated FROM before it was
   *  re-parented onto the modal's base screen. The base must present this modal —
   *  the nav is triggered from inside it (see canonicalize-ai/reduce.ts). */
  viaModalId?: string;
}
export interface CanonicalFlow {
  entryCanonicalId: string | null;
  edges: CanonicalFlowEdge[];
}
export interface Canonical {
  version: 1;
  screens: CanonicalScreen[];
  components: CanonicalComponent[];
  templates: CanonicalTemplate[];
  flow: CanonicalFlow;
  /** frame → canonical id (the single identity axis; RFC §4.2). */
  frameMap: Record<string, string>;
  /** non-fatal diagnostics for HITL Checkpoint 0 (unbound modals, lone frames…). */
  warnings: string[];
  /**
   * T15: the heavy-AI model's structural contentHash, carried through the adapter so
   * the per-run `<runId>.canonical.json` sidecar matches the live `.uix/canonical.json`
   * hash. This is what lets test/verify-pipeline.cjs AUTO-TIE the AI-fired proof log to
   * the run that produced the current canonical WITHOUT requiring --runId. Absent on the
   * deterministic clusterer path (it doesn't hash) — verify then requires --runId.
   */
  contentHash?: string;
}

/** The per-frame input the pre-pass needs (a slice of RunScreen + its spec). */
export interface FrameInput {
  frameId: string;
  frameName: string;
  width?: number;
  height?: number;
  /** IR tree notation string (`toTreeNotation` output) — may be empty. */
  tree?: string;
}

// ── skeleton parse: from IR tree notation → structure + content ──────────────
// We only have the human-readable tree notation on the server (the structured
// MinimalIR lives in the UIX pipeline). One line per node:
//   "├─ AppBar [ROW, h:56, bg:#FFFFFF, padH:16]"
//   "│   ├─ Text "Wallet" — 20px bold #1A1A1A"
// Depth = count of the 4-char indent units in the leading prefix.

interface SkelNode {
  depth: number;
  kind: string;     // node-kind, names/colours/assets stripped (ROW/COL/Text/Icon/Image/<Widget>)
  hBucket: number;  // bucketed height (0 when unknown)
}
export interface ParsedFrame {
  /** node-kind + bucketed-bbox tokens (the skeleton) — order-independent multiset. */
  skeleton: string[];
  /** visible text strings (lowercased, trimmed) — for value-vs-semantic diff. */
  texts: string[];
  /** asset filenames referenced (icons/images) — for asset diff. */
  assets: string[];
  /** distinct colours seen (hex) — for the scrim detector + diffing. */
  colors: string[];
  /** the root/first child line, if any — used by the scrim+sheet role detector. */
  rootLine?: SkelNode & { line: string };
  /** number of top-level (depth-1) children. */
  topChildren: number;
}

const HEIGHT_RE = /\bh:(\d+)/;
const SIZE_RE = /\b(\d+)×(\d+)/;
const HEX_RE = /#[0-9A-Fa-f]{6,8}/g;
const ASSET_RE = /assets\/(?:icons|images)\/([^\s\]]+)/g;
const ICON_FILE_RE = /Icon\s+"([^"]+)"/;
const IMAGE_FILE_RE = /Image\s+"([^"]+)"/;
const TEXT_RE = /Text\s+"([^"]*)"/;

/** Bucket a pixel height into coarse bands so minor layout jitter still matches. */
function bucketHeight(h: number): number {
  if (!h || h <= 0) return 0;
  if (h < 40) return 1;
  if (h < 80) return 2;
  if (h < 160) return 3;
  if (h < 320) return 4;
  if (h < 640) return 5;
  return 6;
}

/** The bare node-kind for a line, with names / colours / asset files stripped. */
function kindOf(content: string): string {
  if (TEXT_RE.test(content)) return 'Text';
  if (ICON_FILE_RE.test(content)) return 'Icon';
  if (IMAGE_FILE_RE.test(content)) return 'Image';
  const layout = content.match(/\[(ROW|COL|STACK|GRID[^,\]]*)/);
  if (layout) return layout[1].startsWith('GRID') ? 'GRID' : layout[1];
  // First whitespace-delimited token is the widget name (AppBar/Container/…).
  const tok = content.trim().split(/[\s([]/)[0];
  return tok || 'Node';
}

/** Parse one IR tree-notation string into a structure + content summary. */
export function parseFrame(tree: string | undefined): ParsedFrame {
  const out: ParsedFrame = { skeleton: [], texts: [], assets: [], colors: [], topChildren: 0 };
  if (!tree) return out;
  const lines = tree.split('\n');
  const colorSet = new Set<string>();
  for (const raw of lines) {
    if (!raw.trim()) continue;
    // Strip the tree connectors to find depth + content.
    const connIdx = raw.search(/[├└]─\s/);
    let depth: number;
    let content: string;
    let isHeader = false;
    if (connIdx < 0) {
      // Header line ("Screen: Name (393×852)") or section header — depth 0. The
      // NAME is stripped (skeleton hash is name-independent); only its dimensions
      // matter, so we emit a fixed `Screen` kind for it.
      depth = 0;
      isHeader = true;
      content = raw.replace(/^Screen:\s*/, '').trim();
      if (/^Responsive:/.test(content)) continue;
    } else {
      const prefix = raw.slice(0, connIdx);
      depth = Math.floor(prefix.length / 4) + 1;
      content = raw.slice(connIdx + 2).trim();
    }
    if (depth === 1) out.topChildren++;

    const kind = isHeader ? 'Screen' : kindOf(content);
    const hm = content.match(HEIGHT_RE);
    const sm = content.match(SIZE_RE);
    const h = hm ? Number(hm[1]) : sm ? Number(sm[2]) : 0;
    const node: SkelNode = { depth, kind, hBucket: bucketHeight(h) };
    if (!out.rootLine && depth <= 1) out.rootLine = { ...node, line: content };
    // Skeleton token: depth + kind + height bucket (names/colours/text stripped).
    out.skeleton.push(`${node.depth}:${node.kind}:${node.hBucket}`);

    const tm = content.match(TEXT_RE);
    if (tm && tm[1].trim()) out.texts.push(tm[1].trim().toLowerCase());
    let am: RegExpExecArray | null;
    ASSET_RE.lastIndex = 0;
    while ((am = ASSET_RE.exec(content)) !== null) out.assets.push(am[1]);
    for (const c of content.match(HEX_RE) ?? []) colorSet.add(c.toUpperCase());
  }
  out.colors = [...colorSet];
  return out;
}

// ── clustering: union-find over skeleton-multiset Jaccard ────────────────────
const CLUSTER_THRESHOLD = 0.85;

/** Jaccard similarity of two multisets (string token lists). */
export function multisetJaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const countA = new Map<string, number>();
  for (const t of a) countA.set(t, (countA.get(t) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const t of b) countB.set(t, (countB.get(t) ?? 0) + 1);
  let inter = 0;
  let union = 0;
  const keys = new Set([...countA.keys(), ...countB.keys()]);
  for (const k of keys) {
    const ca = countA.get(k) ?? 0;
    const cb = countB.get(k) ?? 0;
    inter += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union === 0 ? 0 : inter / union;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number { return this.parent[i] === i ? i : (this.parent[i] = this.find(this.parent[i])); }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

/** Cluster frame indices by skeleton-hash similarity (≥0.85 Jaccard). */
export function clusterFrames(parsed: ParsedFrame[]): number[][] {
  const uf = new UnionFind(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (multisetJaccard(parsed[i].skeleton, parsed[j].skeleton) >= CLUSTER_THRESHOLD) uf.union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < parsed.length; i++) {
    const r = uf.find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }
  return [...groups.values()];
}

// ── role classification (RFC §4.1) ───────────────────────────────────────────
export type FrameRole = 'screen' | 'modal' | 'component';

/**
 * Scrim+sheet detector + component heuristic.
 *  - modal/sheet: root `bg:#000000@α<1` (a scrim) with ≤2 top-level children, OR a
 *    top child pinned to the bottom with a top-only corner radius (a bottom sheet).
 *  - component: small bbox / no device chrome (markedly smaller than the device).
 *  - screen: everything else.
 */
export function classifyRole(p: ParsedFrame, width?: number, height?: number): FrameRole {
  // Scrim: a translucent black root fill is the hallmark of a modal overlay.
  const hasScrim = p.colors.some(c => /^#000000/i.test(c)) && p.topChildren <= 2;
  const rl = p.rootLine?.line ?? '';
  // Bottom sheet: a top-only corner radius on a child pinned to the bottom edge.
  // The notation carries `r:` (radius) on layout nodes; a sheet is wide + short
  // relative to the device and sits over a scrim. We approximate with: a scrim is
  // present (the only reliable signal in the text notation).
  const looksSheet = /\br:\d/.test(rl) && hasScrim;
  if (hasScrim || looksSheet) return 'modal';

  // Component: clearly smaller than a full device frame (no device chrome). Use a
  // generous margin so partial-height screens aren't misread as components.
  const W = width ?? 393, H = height ?? 852;
  if (W > 0 && H > 0 && W <= 320 && H <= 480) return 'component';
  return 'screen';
}

// ── intra-cluster split: value-only (state) vs semantic (template) ───────────
const STATE_TEXT_THRESHOLD = 0.6;  // ≥60% shared text → same screen, different state

/** Are two frames in a cluster the same screen (a state) or template siblings? */
export function isSameScreenState(a: ParsedFrame, b: ParsedFrame): boolean {
  // Value-only diff: typed digits / a swapped icon. Semantic diff: different
  // labels (Change Password vs Change PIN). We measure shared *text* tokens — a
  // value-only state keeps almost all labels, a semantic sibling changes them.
  if (!a.texts.length && !b.texts.length) return true;          // both chromeless
  const setA = new Set(a.texts);
  const setB = new Set(b.texts);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const denom = Math.max(setA.size, setB.size) || 1;
  return shared / denom >= STATE_TEXT_THRESHOLD;
}

// ── canonical id + route slug (the single identity axis, RFC §4.2) ───────────
/** Content-addressed canonical id from the lead frame id (stable across rename). */
export function canonicalIdFor(frameId: string): string {
  return 'c_' + frameId.replace(/[^a-zA-Z0-9]+/g, '_');
}
/** Semantic route path from the screen's human name (machine/frame-code names fall
 *  back to `/screen`). The skeleton's planSemanticScreens later re-derives this WITH
 *  cross-screen collision suffixing and rewrites `c.route`; this is the initial value
 *  (and the value used by non-flutter runs that skip the skeleton). */
export function routeForCanonical(c: CanonicalScreen): string {
  return deriveSemanticIdentifiers(c.name).routePath;
}

// ── the pre-pass ─────────────────────────────────────────────────────────────
/**
 * Run the full deterministic canonicalization pre-pass over a run's frames + flow.
 * Pure (no IO) so it is unit-testable; `writeCanonical` persists the result.
 */
export function buildCanonical(frames: FrameInput[], flow?: RunFlow): Canonical {
  const warnings: string[] = [];
  const parsed = frames.map(f => parseFrame(f.tree));
  const roles = parsed.map((p, i) => classifyRole(p, frames[i].width, frames[i].height));

  // Frames that are modals / components are pulled out before clustering screens.
  const screenIdx = frames.map((_, i) => i).filter(i => roles[i] === 'screen');
  const modalIdx = frames.map((_, i) => i).filter(i => roles[i] === 'modal');
  const componentIdx = frames.map((_, i) => i).filter(i => roles[i] === 'component');

  // 1. cluster the SCREEN frames by skeleton hash.
  const screenParsed = screenIdx.map(i => parsed[i]);
  const clustersLocal = clusterFrames(screenParsed);   // indices into screenIdx
  const clusters = clustersLocal.map(group => group.map(local => screenIdx[local]));

  // 2. split each cluster into one-or-more canonical screens (states vs template).
  const canonicalScreens: CanonicalScreen[] = [];
  const templates: CanonicalTemplate[] = [];
  const frameMap: Record<string, string> = {};

  for (const cluster of clusters) {
    // Greedily group cluster members that are the SAME screen (state siblings).
    const remaining = [...cluster];
    const subGroups: number[][] = [];
    while (remaining.length) {
      const seed = remaining.shift()!;
      const group = [seed];
      for (let k = remaining.length - 1; k >= 0; k--) {
        if (isSameScreenState(parsed[seed], parsed[remaining[k]])) {
          group.push(remaining[k]);
          remaining.splice(k, 1);
        }
      }
      subGroups.push(group);
    }

    // A cluster that split into >1 distinct screen → those screens share a template.
    const templateId = subGroups.length > 1 ? `t_${canonicalIdFor(frames[cluster[0]].frameId).slice(2)}` : undefined;
    const memberIds: string[] = [];

    for (const group of subGroups) {
      // Lead frame = the one whose name looks most like a "default" (shortest, or
      // first in the original order) — deterministic: pick the lowest frame index.
      group.sort((a, b) => a - b);
      const lead = group[0];
      const canonicalId = canonicalIdFor(frames[lead].frameId);
      const states: CanonicalState[] = group.map((idx, n) => ({
        id: n === 0 ? 'default' : `state${n}`,
        frameId: frames[idx].frameId,
      }));
      const screen: CanonicalScreen = {
        canonicalId,
        frameIds: group.map(idx => frames[idx].frameId),
        name: frames[lead].frameName,
        states,
        modals: [],
        role: 'screen',
        route: '',
        templateRef: templateId,
      };
      screen.route = routeForCanonical(screen);
      canonicalScreens.push(screen);
      memberIds.push(canonicalId);
      for (const idx of group) frameMap[frames[idx].frameId] = canonicalId;
    }
    if (templateId) templates.push({ id: templateId, memberCanonicalIds: memberIds });
  }

  // 3. components → their own canonical entries (built as shared widgets, no route).
  const components: CanonicalComponent[] = componentIdx.map(i => {
    const id = 'cmp_' + frames[i].frameId.replace(/[^a-zA-Z0-9]+/g, '_');
    frameMap[frames[i].frameId] = id;
    return { id, frameId: frames[i].frameId, name: frames[i].frameName };
  });

  // 4. bind each modal to its base screen: incoming `modal` flow edge → else flag.
  const screenByFrame = new Map<string, string>();
  for (const s of canonicalScreens) for (const fid of s.frameIds) screenByFrame.set(fid, s.canonicalId);
  // Name-token overlap (lowercased words ≥3 chars), for the no-flow-edge fallback.
  const nameTokens = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(w => !/iphone|pro|android|frame|screen|default|copy/.test(w)));
  for (const i of modalIdx) {
    const modalFrameId = frames[i].frameId;
    const modalId = 'modal_' + modalFrameId.replace(/[^a-zA-Z0-9]+/g, '_');
    // Find an incoming edge whose type is modal/overlay/sheet, else any incoming edge.
    // KNOWN LIMITATION: this deterministic path has NO vision data, so the edge-from
    // screen is trusted as the base unconditionally. The AI path (canonicalize-ai/
    // reduce.ts) prefers the describe descriptor's VISUAL backdrop (isModalGuess)
    // when it names a different existing screen — the rendered backdrop, not the
    // prototype edge topology, is what the modal is composited over.
    let baseCanonicalId: string | null = null;
    const incoming = (flow?.connections ?? []).filter(c => c.to === modalFrameId);
    const modalEdge = incoming.find(c => /modal|sheet|overlay/i.test(c.type)) ?? incoming[0];
    if (modalEdge) baseCanonicalId = screenByFrame.get(modalEdge.from) ?? null;
    // Fallback (no flow edge): bind to the screen whose NAME shares the most
    // meaningful tokens (e.g. "Notification settings sheet" → "Settings"). Needs ≥1
    // shared token, so generic/identical device-frame names (Ping) never mis-bind.
    if (!baseCanonicalId) {
      const mt = nameTokens(frames[i].frameName);
      if (mt.size) {
        let best: { id: string; overlap: number } | null = null;
        for (const s of canonicalScreens) {
          if (s.role !== 'screen') continue;
          let overlap = 0; const st = nameTokens(s.name);
          for (const w of mt) if (st.has(w)) overlap++;
          if (overlap > (best?.overlap ?? 0)) best = { id: s.canonicalId, overlap };
        }
        if (best && best.overlap > 0) baseCanonicalId = best.id;
      }
    }
    if (!baseCanonicalId) warnings.push(`modal "${frames[i].frameName}" (${modalFrameId}) has no base screen — built as a standalone reachable route; bind it via the flow checkpoint to present it as an overlay`);
    const base = baseCanonicalId ? canonicalScreens.find(s => s.canonicalId === baseCanonicalId) : undefined;
    const modal: CanonicalModal = { id: modalId, frameId: modalFrameId, baseCanonicalId };
    if (base) base.modals.push(modal);
    else {
      // Unbound modal: keep it as a standalone screen entry so it is still built.
      const canonicalId = canonicalIdFor(modalFrameId);
      const screen: CanonicalScreen = {
        canonicalId, frameIds: [modalFrameId], name: frames[i].frameName,
        states: [{ id: 'default', frameId: modalFrameId }], modals: [], role: 'screen', route: '',
      };
      screen.route = routeForCanonical(screen);
      canonicalScreens.push(screen);
    }
    frameMap[modalFrameId] = baseCanonicalId ? modalId : canonicalIdFor(modalFrameId);
  }

  if (!flow?.connections?.length) warnings.push('flow.connections == 0 — no navigation graph; nav must be set manually (HITL Checkpoint 0)');

  // 5. rewrite the flow graph onto canonical ids.
  const canonFlow = rewriteFlow(flow, frameMap, modalIdx.map(i => frames[i].frameId), canonicalScreens);

  return {
    version: 1,
    screens: canonicalScreens,
    components,
    templates,
    flow: canonFlow,
    frameMap,
    warnings,
  };
}

/**
 * Rewrite a frame-level flow onto canonical ids (RFC §4.1):
 *  - intra-canonical edges (both ends map to the SAME canonical screen) become
 *    in-screen state transitions and are dropped from the route-level graph;
 *  - edges into a modal frame become `overlay` presentations;
 *  - parallel duplicate edges are deduped.
 */
export function rewriteFlow(
  flow: RunFlow | undefined,
  frameMap: Record<string, string>,
  modalFrameIds: string[],
  screens: CanonicalScreen[],
): CanonicalFlow {
  const validScreenIds = new Set(screens.map(s => s.canonicalId));
  const modalSet = new Set(modalFrameIds);
  // Entry maps onto its canonical id; if it resolved to a modal (overlay) id,
  // fall back to that modal's base screen so the app boots a real route.
  const rawEntry = flow?.entryFrameId ? (frameMap[flow.entryFrameId] ?? null) : null;
  const entryCanonicalId = rawEntry && !validScreenIds.has(rawEntry)
    ? (screens.find(s => s.modals.some(m => m.id === rawEntry))?.canonicalId ?? null)
    : rawEntry;
  const seen = new Set<string>();
  const edges: CanonicalFlowEdge[] = [];
  for (const c of flow?.connections ?? []) {
    const from = frameMap[c.from];
    const to = frameMap[c.to];
    if (!from || !to) continue;
    if (from === to) continue;                    // intra-canonical → state transition (dropped here)
    const kind = modalSet.has(c.to) ? 'overlay' : c.type;
    // For an overlay edge, the canonical target is the base screen, not the modal.
    const target = kind === 'overlay' && !validScreenIds.has(to)
      ? (screens.find(s => s.modals.some(m => m.id === to))?.canonicalId ?? to)
      : to;
    const key = `${from}|${target}|${kind}`;
    if (seen.has(key)) continue;                  // dedup parallels
    seen.add(key);
    edges.push({ fromCanonicalId: from, toCanonicalId: target, kind, label: c.label });
  }
  return { entryCanonicalId, edges };
}

// ── persistence ──────────────────────────────────────────────────────────────
const canonicalFile = (root: string, runId: string) => path.join(root, '.uix', 'runs', `${runId}.canonical.json`);

export async function writeCanonical(projectRoot: string, runId: string, canonical: Canonical): Promise<string> {
  const file = canonicalFile(projectRoot, runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(canonical, null, 2), 'utf-8');
  return file;
}

export async function readCanonical(projectRoot: string, runId: string): Promise<Canonical | null> {
  try { return JSON.parse(await fs.readFile(canonicalFile(projectRoot, runId), 'utf-8')) as Canonical; }
  catch { return null; }
}

// ── T35: live `.uix/canonical.json` ↔ run sync ───────────────────────────────
// The finalize passes (semantic-rename / flow-wiring / component-extraction) read
// `<root>/.uix/canonical.json`, NOT the per-run sidecar. On a deterministic run
// that file was never written; on any run it could be left over from a DIFFERENT,
// earlier build — so finalize renamed against the wrong model. This writes the
// LIVE `.uix/canonical.json` from THIS run's canonical and stamps an `ownerRunId`
// so a stale file from another run is detectable. Call it after the skeleton has
// finalized the semantic routes so the live file matches the built app.
const liveCanonicalFile = (root: string) => path.join(root, '.uix', 'canonical.json');
export async function syncLiveCanonical(projectRoot: string, runId: string, canonical: Canonical): Promise<string> {
  const file = liveCanonicalFile(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...canonical, ownerRunId: runId }, null, 2), 'utf-8');
  return file;
}

// ── header re-stamp (RFC v2 §3 Phase 8 — header preservation) ────────────────
// The per-screen build REWRITES each screen file and can DROP the
// `// canonicalId: c_<frame>  route: <route>` header that the skeleton stamped —
// the marker 8b (modal→overlay), 8d (flow-wiring) and 8e (semantic-rename) rely on
// to map a file back to its canonical screen. After the screens are built/accepted
// (just before finalize), RE-STAMP the header from the canonical model onto any
// screen file that is missing it, deterministically. Idempotent: a file that
// already carries a canonicalId header is left untouched.
//
// The screen→file mapping is the SAME deterministic convention the skeleton uses
// (`lib/screens/screen_<canonicalId-without-c_>.dart`), so this needs no on-disk
// header to FIND the file — it can recover the header even when the agent dropped it.
export interface RestampResult {
  /** files that were missing the header and got it re-stamped. */
  stamped: string[];
  /** canonical screens whose expected file did not exist on disk. */
  missingFiles: string[];
}
export async function restampCanonicalHeaders(
  projectRoot: string,
  canonical: Canonical,
): Promise<RestampResult> {
  const stamped: string[] = [];
  const missingFiles: string[] = [];
  // The skeleton names files SEMANTICALLY (login_screen.dart), so locate each
  // screen's file via the SAME semantic plan. Keep the legacy machine slug
  // (screen_<id>.dart) as a fallback for files from an older skeleton convention.
  const semantics = planSemanticScreens(canonical);
  const legacySlug = (canonicalId: string) => `screen_${canonicalId.replace(/^c_/, '')}`.toLowerCase();
  const headerRe = /^\/\/\s*canonicalId:\s*\S+/m;
  for (const c of canonical.screens) {
    const sem = semantics.get(c.canonicalId);
    const semRel = path.join('lib', 'screens', `${(sem?.fileBase) ?? legacySlug(c.canonicalId)}.dart`);
    const legacyRel = path.join('lib', 'screens', `${legacySlug(c.canonicalId)}.dart`);
    let rel = semRel;
    let abs = path.join(projectRoot, semRel);
    let src: string;
    try { src = await fs.readFile(abs, 'utf-8'); }
    catch {
      // Fall back to the legacy machine-named file if the semantic one is absent.
      rel = legacyRel; abs = path.join(projectRoot, legacyRel);
      try { src = await fs.readFile(abs, 'utf-8'); }
      catch { missingFiles.push(c.canonicalId); continue; }
    }
    if (headerRe.test(src)) continue;            // already present → idempotent no-op
    const route = c.route || routeForCanonical(c);
    const header =
      `// canonicalId: ${c.canonicalId}  route: ${route}\n` +
      `// states: ${c.states.map(s => s.id).join(', ') || 'default'}` +
      (c.modals.length ? `\n// modals: ${c.modals.map(m => m.id).join(', ')}` : '') +
      '\n';
    await fs.writeFile(abs, header + src, 'utf-8');
    stamped.push(rel);
  }
  return { stamped, missingFiles };
}

// ── T35: orphan-screen cleanup ───────────────────────────────────────────────
// A re-build with a SMALLER/different canonical leaves stale screen files in
// lib/screens/ from a prior build (different frame set, different names). They
// pollute the app (dead routes, broken imports, AI/human confusion). This removes
// every generated screen file whose `// canonicalId:` header is NOT in the CURRENT
// canonical. Conservative: a file with NO canonicalId header (hand-authored, not a
// generated screen) is LEFT untouched; we only reap files we recognise as generated
// screens for OTHER canonical ids. Returns the removed (project-relative) files.
export interface OrphanCleanResult { removed: string[]; kept: number }
export async function cleanOrphanScreens(projectRoot: string, canonical: Canonical): Promise<OrphanCleanResult> {
  const screensDir = path.join(projectRoot, 'lib', 'screens');
  const removed: string[] = [];
  let kept = 0;
  const liveIds = new Set(canonical.screens.map(s => s.canonicalId));
  const headerRe = /^\/\/\s*canonicalId:\s*(\S+)/m;
  let files: string[] = [];
  try { files = (await fs.readdir(screensDir)).filter(f => f.endsWith('.dart')); }
  catch { return { removed, kept }; }
  for (const f of files) {
    const abs = path.join(screensDir, f);
    let src: string;
    try { src = await fs.readFile(abs, 'utf-8'); } catch { continue; }
    const m = headerRe.exec(src);
    if (!m) { kept++; continue; }              // no header → not a generated screen; leave it
    const id = m[1];
    if (liveIds.has(id)) { kept++; continue; } // belongs to the current canonical → keep
    // Orphan: a generated screen for a canonicalId not in the current build.
    try { await fs.rm(abs, { force: true }); removed.push(path.join('lib', 'screens', f)); }
    catch { /* best-effort */ }
  }
  return { removed, kept };
}

// ── RESTART: nuke the generated app surface (clean-slate rebuild) ─────────────
// A RESTART of a whole-app build must regenerate from scratch — NOT on top of the
// prior build. The skeleton is additive ("a built screen file is never clobbered")
// and cleanOrphanScreens only drops screens absent from the NEW canonical, so a
// same-.fig restart would otherwise keep every old file (stale components/previews,
// scrambled assets, dead routes). This removes the PIPELINE-OWNED generated surface
// so the existing flow rebuilds it fresh.
//
// REMOVES (flutter):
//   - the entire `lib/` directory — it is FULLY generated for these apps (main.dart,
//     app_router.dart, app_routes.dart, screens/, components/, theme/, resources/,
//     _preview/). Any hand-authored file under lib/ is recoverable from the git
//     checkpoint the caller commits BEFORE invoking this (data-safety contract).
//   - stale per-build code reports under `.uix/`: finalize-report.json,
//     flow-wiring-report.json, semantic-rename-report.json, token-cleanup-report.json,
//     component-extraction-report.json, last-gen.json (any that exist).
//
// PRESERVES (never deleted): pubspec.yaml + other project-root config, assets/
// (localized assets are expensive; a regenerated app_assets.dart only references
// current ones, stale files are harmless), .uix/prep-cache, .uix/canon-refs,
// .uix/refs, .uix/asset-map.json, the .fig/inputs, and .uix/canonical.json (canon
// rewrites it anyway).
//
// Non-flutter: NO-OP — the skeleton is flutter-only; we never guess another
// framework's surface.
//
// Idempotent + robust: a missing dir/file is fine and never throws.
export interface NukeResult { removedDirs: string[]; removedFiles: string[]; skipped?: string }

/** The per-build code reports under .uix/ a restart must drop so a stale report
 *  doesn't make a gated pass (e.g. finalize) skip on the rebuild. */
const NUKE_UIX_REPORTS = [
  'finalize-report.json',
  'flow-wiring-report.json',
  'semantic-rename-report.json',
  'token-cleanup-report.json',
  'component-extraction-report.json',
  'last-gen.json',
] as const;

export async function nukeGeneratedAppSurface(
  projectRoot: string, framework: string,
): Promise<NukeResult> {
  const removedDirs: string[] = [];
  const removedFiles: string[] = [];
  if ((framework || 'flutter').toLowerCase() !== 'flutter') {
    // Skeleton is flutter-only — don't guess any other framework's generated surface.
    return { removedDirs, removedFiles, skipped: `non-flutter (${framework}) — skeleton is flutter-only; nothing removed` };
  }
  // 1. The entire generated lib/ tree.
  const libDir = path.join(projectRoot, 'lib');
  try {
    const before = await fs.stat(libDir).then(() => true, () => false);
    if (before) {
      await fs.rm(libDir, { recursive: true, force: true });
      removedDirs.push('lib');
    }
  } catch { /* best-effort: a missing/locked lib never fails the restart */ }
  // 2. Stale per-build code reports under .uix/.
  for (const name of NUKE_UIX_REPORTS) {
    const rel = path.join('.uix', name);
    const abs = path.join(projectRoot, rel);
    try {
      const existed = await fs.stat(abs).then(() => true, () => false);
      if (existed) { await fs.rm(abs, { force: true }); removedFiles.push(rel); }
    } catch { /* best-effort */ }
  }
  return { removedDirs, removedFiles };
}

// ── deterministic write-locked skeleton (RFC §4.2) ───────────────────────────
// The server generates and WRITE-LOCKS: the router (every canonical route, real
// builder or explicit stub), the theme/token file, and empty shared-component
// stubs. Per-screen builds import these and only ADD their own screen file + fill
// their pre-existing route slot. Today this targets Flutter (the primary
// framework); other frameworks get the canonical.json + a manifest only.
// TODO(P3): emit React/Next + other-framework skeletons; until then non-flutter
// runs still get canonical screens + the manifest, just no generated router file.

const pascal = (s: string): string =>
  (s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Screen');

/** The reader-facing semantic identifiers for one canonical screen (identity stays on canonicalId). */
export interface ScreenSemantics {
  canonicalId: string;
  fileBase: string;    // login_screen          (no extension)
  className: string;   // LoginScreen
  routeConst: string;  // login                 (camelCase const in AppRoutes)
  routePath: string;   // /login                (router switch key)
}

/**
 * Plan SEMANTIC identifiers for every canonical screen — file base, class name,
 * route const, AND route path — all derived from the human display name with a
 * `screen` fallback for raw frame-code names, collision-suffixed (`-2`/`2`/`_2`)
 * so two screens never grab the same identifier. Identity stays on `canonicalId`
 * (frame-map). Side effect: rewrites each screen's `c.route` to the semantic path
 * so the persisted canonical.json + skeleton + downstream passes all agree on the
 * SAME human route (no `/283-1967` machine paths survive). Pure aside from that.
 */
export function planSemanticScreens(canonical: Canonical): Map<string, ScreenSemantics> {
  const plan = new Map<string, ScreenSemantics>();
  const usedFiles = new Set<string>();
  const usedClasses = new Set<string>();
  const usedConsts = new Set<string>();
  const usedPaths = new Set<string>();
  // Stable order = canonical.screens order (deterministic across runs).
  for (const c of canonical.screens) {
    let n = 1;
    let ids = deriveSemanticIdentifiers(c.name);
    // Suffix until ALL four identifiers are free (one suffix token keeps them in sync).
    while (
      usedFiles.has(`${ids.fileBase}.dart`) ||
      usedClasses.has(ids.className) ||
      usedConsts.has(ids.routeConst) ||
      usedPaths.has(ids.routePath)
    ) {
      n += 1;
      ids = deriveSemanticIdentifiers(c.name, [String(n)]);
    }
    usedFiles.add(`${ids.fileBase}.dart`);
    usedClasses.add(ids.className);
    usedConsts.add(ids.routeConst);
    usedPaths.add(ids.routePath);
    const s: ScreenSemantics = {
      canonicalId: c.canonicalId,
      fileBase: ids.fileBase,
      className: ids.className,
      routeConst: ids.routeConst,
      routePath: ids.routePath,
    };
    plan.set(c.canonicalId, s);
    // Rewrite the canonical route to the semantic path so canonical.json matches.
    c.route = ids.routePath;
  }
  return plan;
}

export interface SkeletonResult {
  files: string[];           // project-relative files written
  routes: Array<{ canonicalId: string; route: string; className: string; routeConst: string; file: string }>;
  /** The tab cluster hosted by lib/screens/app_shell.dart (absent when no tabs). */
  tabCluster?: { hubId: string; memberIds: string[] };
}

// ── P2: the app-shell tab cluster ─────────────────────────────────────────────
// `kind:'tab'` edges describe ONE persistent bottom-nav shell, not N pushes: the
// destinations live side-by-side in an IndexedStack behind a single shared bottom
// nav. Without a shell every tab screen improvises its own raster navbar and
// pushNamed's its siblings (Ping audit). The cluster = the HUB (the tab-edge
// source that is not itself a tab destination — e.g. home) + the destinations of
// the hub's own tab edges, hub-first then edge order. Tab edges that originate
// from a non-hub screen (e.g. scan → a deeper scan mode) do NOT enlarge the shell.
export function computeTabCluster(canonical: Canonical): { hubId: string; memberIds: string[] } | null {
  const tabEdges = (canonical.flow?.edges ?? []).filter(e => e.kind === 'tab');
  if (!tabEdges.length) return null;
  const screenIds = new Set(canonical.screens.map(s => s.canonicalId));
  const tabTargets = new Set(tabEdges.map(e => e.toCanonicalId));
  const sources = [...new Set(tabEdges.map(e => e.fromCanonicalId))].filter(id => screenIds.has(id));
  if (!sources.length) return null;
  const outCount = (id: string) => tabEdges.filter(e => e.fromCanonicalId === id).length;
  const hubCandidates = sources.filter(id => !tabTargets.has(id));
  const hubId = (hubCandidates.length ? hubCandidates : sources)
    .sort((a, b) => outCount(b) - outCount(a) || a.localeCompare(b))[0];
  const memberIds = [hubId];
  for (const e of tabEdges) {
    if (e.fromCanonicalId !== hubId) continue;
    if (screenIds.has(e.toCanonicalId) && !memberIds.includes(e.toCanonicalId)) memberIds.push(e.toCanonicalId);
  }
  return memberIds.length >= 2 ? { hubId, memberIds } : null;
}

/** A generic Material icon for a tab, keyed off the screen name (placeholder
 *  visuals — per-screen builds refine them; taps only ever switch the index). */
function tabIconFor(name: string): string {
  const n = name.toLowerCase();
  if (/home|dash/.test(n)) return 'Icons.home_outlined';
  if (/scan|qr|camera/.test(n)) return 'Icons.qr_code_scanner';
  if (/histor|transaction|activity/.test(n)) return 'Icons.receipt_long_outlined';
  if (/setting|preference/.test(n)) return 'Icons.settings_outlined';
  if (/profile|account|user|me\b/.test(n)) return 'Icons.person_outline';
  if (/card|wallet|pay/.test(n)) return 'Icons.credit_card_outlined';
  if (/chat|message|inbox|mail/.test(n)) return 'Icons.chat_bubble_outline';
  if (/search|explore|discover/.test(n)) return 'Icons.search';
  return 'Icons.circle_outlined';
}

/** Human tab label from a canonical screen name ("scanAndPayScreen" → "Scan And Pay"). */
function tabLabelFor(name: string): string {
  const words = tokenizeName(name).filter(w => w !== 'screen');
  const label = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return label || name;
}

/**
 * Generate the write-locked Flutter skeleton for a canonical app:
 *  - lib/app_routes.dart : the central route table (every canonical route → slug)
 *  - lib/app_router.dart : MaterialApp with onGenerateRoute over the table
 *  - lib/theme/app_theme.dart : a theme/token stub (filled by the digest planner)
 *  - lib/screens/<slug>.dart : a write-locked stub per canonical screen
 *  - lib/components/<id>.dart : an empty shared-component stub per component
 * Stubs are intentionally minimal + clearly marked so per-screen builds replace
 * the screen body while keeping the route slot + imports stable.
 */
export async function generateFlutterSkeleton(projectRoot: string, canonical: Canonical): Promise<SkeletonResult> {
  const libDir = path.join(projectRoot, 'lib');
  const screensDir = path.join(libDir, 'screens');
  const componentsDir = path.join(libDir, 'components');
  const themeDir = path.join(libDir, 'theme');
  await fs.mkdir(screensDir, { recursive: true });
  await fs.mkdir(componentsDir, { recursive: true });
  await fs.mkdir(themeDir, { recursive: true });

  const files: string[] = [];
  const routes: SkeletonResult['routes'] = [];
  // SEMANTIC plan: file base / class / route const / route PATH for every screen,
  // derived from the human name (machine/frame-code names fall back to `screen`),
  // collision-suffixed. This ALSO rewrites each screen's `c.route` to the semantic
  // path so the persisted canonical.json + router agree (no machine paths survive).
  const semantics = planSemanticScreens(canonical);

  // Per-screen write-locked stubs.
  for (const c of canonical.screens) {
    const sem = semantics.get(c.canonicalId)!;
    const className = sem.className;
    const fileBase = sem.fileBase;
    const rel = path.join('lib', 'screens', `${fileBase}.dart`);
    const stub = `// GENERATED SKELETON — write-locked route slot for canonical screen.
// canonicalId: ${c.canonicalId}  route: ${c.route}
// states: ${c.states.map(s => s.id).join(', ') || 'default'}${c.modals.length ? `\n// modals: ${c.modals.map(m => m.id).join(', ')}` : ''}
// The per-screen build REPLACES the body of ${className} with the real UI.
import 'package:flutter/material.dart';

class ${className} extends StatelessWidget {
  const ${className}({super.key, this.state = 'default'});
  /// One of: ${c.states.map(s => `'${s.id}'`).join(', ') || `'default'`}
  final String state;

  @override
  Widget build(BuildContext context) {
    // TODO(build): implement this screen against its reference. Each state is
    // verified individually via ${className}(state: '<id>').
    return const Scaffold(body: Center(child: Text('${c.name.replace(/'/g, "\\'")}')));
  }
}
`;
    // Only write the stub if no real screen file is already present (additive +
    // resumable — never clobber a built screen).
    try { await fs.access(path.join(projectRoot, rel)); }
    catch { await fs.writeFile(path.join(projectRoot, rel), stub, 'utf-8'); files.push(rel); }
    routes.push({ canonicalId: c.canonicalId, route: c.route, className, routeConst: sem.routeConst, file: rel });
  }

  // Shared-component stubs.
  for (const cmp of canonical.components) {
    const className = pascal(cmp.name) + 'Widget';
    const rel = path.join('lib', 'components', `${cmp.id}.dart`);
    const stub = `// GENERATED SKELETON — shared component stub (write-locked API surface).
// componentId: ${cmp.id}
import 'package:flutter/material.dart';

class ${className} extends StatelessWidget {
  const ${className}({super.key});
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
`;
    try { await fs.access(path.join(projectRoot, rel)); }
    catch { await fs.writeFile(path.join(projectRoot, rel), stub, 'utf-8'); files.push(rel); }
  }

  // P2: APP SHELL for the tab cluster. `kind:'tab'` edges are ONE persistent
  // bottom-nav shell: the tab screens live side-by-side in an IndexedStack behind
  // a single shared bottom nav (taps only setState the index). Route names are
  // UNCHANGED — the router returns AppShell(initialIndex: i) for each tab route,
  // so non-tab screens still push those routes by name and land in the shell.
  // Always regenerated + write-locked, like the router.
  const tabCluster = computeTabCluster(canonical) ?? undefined;
  const shellByCanonicalId = new Map<string, number>();   // tab canonicalId → index
  if (tabCluster) {
    const members = tabCluster.memberIds
      .map(id => ({ id, sem: semantics.get(id)!, screen: canonical.screens.find(s => s.canonicalId === id)! }))
      .filter(m => m.sem && m.screen);
    members.forEach((m, i) => shellByCanonicalId.set(m.id, i));
    const shellRel = path.join('lib', 'screens', 'app_shell.dart');
    const shellImports = members.map(m => `import '${m.sem.fileBase}.dart';`).join('\n');
    const navItems = members
      .map(m => `          BottomNavigationBarItem(icon: Icon(${tabIconFor(m.screen.name)}), label: '${tabLabelFor(m.screen.name).replace(/'/g, "\\'")}'),`)
      .join('\n');
    const stackChildren = members.map(m => `          ${m.sem.className}(),`).join('\n');
    await fs.writeFile(path.join(projectRoot, shellRel), `// GENERATED SKELETON — write-locked APP SHELL (tab cluster host).
// Write-locked like the router: per-screen builds refine the hosted screens,
// NOT this file. Tab screens are hosted in an IndexedStack behind ONE shared
// bottom nav — a hosted screen must NOT render its own bottom navigation bar
// and must NEVER Navigator.push a tab route; tab switching is this shell's job.
// tabCluster: ${members.map(m => m.id).join(', ')}
import 'package:flutter/material.dart';
${shellImports}

class AppShell extends StatefulWidget {
  const AppShell({super.key, this.initialIndex = 0});
  final int initialIndex;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  late int _index = widget.initialIndex;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: <Widget>[
${stackChildren}
        ],
      ),
      bottomNavigationBar: AppShellBottomNav(
        currentIndex: _index,
        onTap: (i) => setState(() => _index = i),   // taps ONLY switch the index
      ),
    );
  }
}

/// The ONE shared bottom nav for the whole tab cluster (themed via the app
/// theme; generic icons + screen-name labels — per-screen builds refine visuals
/// by restyling the app theme, never by adding their own navbars).
class AppShellBottomNav extends StatelessWidget {
  const AppShellBottomNav({super.key, required this.currentIndex, required this.onTap});
  final int currentIndex;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return BottomNavigationBar(
      currentIndex: currentIndex,
      onTap: onTap,
      type: BottomNavigationBarType.fixed,
      backgroundColor: theme.colorScheme.surface,
      selectedItemColor: theme.colorScheme.primary,
      unselectedItemColor: theme.colorScheme.onSurface.withValues(alpha: 0.55),
      items: const <BottomNavigationBarItem>[
${navItems}
      ],
    );
  }
}
`, 'utf-8');
    files.push(shellRel);
  }

  // Theme/token stub (the digest planner / first screen fills tokens in).
  const themeRel = path.join('lib', 'theme', 'app_theme.dart');
  try { await fs.access(path.join(projectRoot, themeRel)); }
  catch {
    await fs.writeFile(path.join(projectRoot, themeRel), `// GENERATED SKELETON — theme/token stub.
// The design-system planner / first screen fills the real palette + type scale.
import 'package:flutter/material.dart';

ThemeData appTheme() => ThemeData(useMaterial3: true);
`, 'utf-8');
    files.push(themeRel);
  }

  // Central route table + router (always regenerated — it's the contract).
  // Route CONST names are SEMANTIC (login, not c2831967) and route PATHS are
  // SEMANTIC (/login, not /283-1967) — both come from the plan above.
  const routesRel = path.join('lib', 'app_routes.dart');
  const routeConsts = routes.map(r => `  static const String ${r.routeConst} = '${r.route}';`).join('\n');
  await fs.writeFile(path.join(projectRoot, routesRel), `// GENERATED SKELETON — central route table (canonical routes; write-locked).
// Per-screen builds wire navigation to these constants; do NOT add routes here.
class AppRoutes {
${routeConsts || '  // (no routes)'}
  static const String entry = '${(canonical.flow.entryCanonicalId && canonical.screens.find(s => s.canonicalId === canonical.flow.entryCanonicalId)?.route) || (routes[0]?.route ?? '/')}';
}
`, 'utf-8');
  files.push(routesRel);

  const routerRel = path.join('lib', 'app_router.dart');
  // Tab-cluster routes return AppShell(initialIndex: i) — the SAME route names, so
  // non-tab screens still push them by name and land inside the shell. Their screen
  // imports move into app_shell.dart (the router would hold unused imports).
  const isTab = (r: SkeletonResult['routes'][number]) => shellByCanonicalId.has(r.canonicalId);
  const imports = [
    ...(tabCluster ? [`import 'screens/app_shell.dart';`] : []),
    ...routes.filter(r => !isTab(r)).map(r => `import 'screens/${path.basename(r.file, '.dart')}.dart';`),
  ].join('\n');
  const cases = routes.map(r => isTab(r)
    ? `      case '${r.route}': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: ${shellByCanonicalId.get(r.canonicalId)!}));`
    : `      case '${r.route}': return MaterialPageRoute(builder: (_) => const ${r.className}());`).join('\n');
  await fs.writeFile(path.join(projectRoot, routerRel), `// GENERATED SKELETON — central router (every canonical route registered).
// Write-locked: per-screen builds fill the screen widgets, not this table.
import 'package:flutter/material.dart';
import 'app_routes.dart';
import 'theme/app_theme.dart';
${imports}

class AppRouter extends StatelessWidget {
  const AppRouter({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: appTheme(),
      initialRoute: AppRoutes.entry,
      onGenerateRoute: (settings) {
        switch (settings.name) {
${cases || '          // (no routes)'}
        }
        return null;
      },
    );
  }
}
`, 'utf-8');
  files.push(routerRel);

  return { files, routes, ...(tabCluster ? { tabCluster } : {}) };
}

/** Convenience: run the pre-pass over a run's screens + flow. */
export function canonicalizeRun(screens: RunScreen[], flow?: RunFlow): Canonical {
  const frames: FrameInput[] = screens.map(s => ({
    frameId: s.frameId,
    frameName: s.frameName,
    width: s.spec?.width,
    height: s.spec?.height,
    tree: s.spec?.tree,
  }));
  return buildCanonical(frames, flow);
}
