// =============================================================================
// File: src/relay-server/canonicalize-ai/fingerprint.ts
//
// DETERMINISTIC FINGERPRINT (Phase 1a) — the language-independent matching anchor.
// Same idea as the skeleton-hash in canonicalize.ts (parseFrame/clusterFrames):
// reduce a node subtree to node-KINDS + bucketed bbox, with names / colours /
// asset-filenames STRIPPED, then hash. Two structurally-identical subtrees → the
// SAME fingerprint regardless of their labels, palette, or icon files. That is what
// lets the later Reduce step cluster cross-frame without the AI's wording desyncing
// matches.
//
// canonicalize.ts targets the `toTreeNotation` dialect ("├─ AppBar [ROW, h:56]").
// The UIX `/api/v1/figma/ir` endpoint emits a DIFFERENT dialect:
//   container "Name" [393×852] bg:#fff flex:col ...
//   ├── text "id" [188×22] "value" color:#161618 Inter/14px/...
// so we parse THIS dialect here (lowercase kinds, [W×H] dims, "├── "/"└── "
// connectors at 4-char indent units) rather than reusing parseFrame directly.
// The bucketing + multiset-hash STRATEGY is shared with canonicalize.ts; the
// surface parser differs because the input notation differs.
// =============================================================================

import crypto from 'node:crypto';

// ── tree parse ────────────────────────────────────────────────────────────────
export interface IrNode {
  depth: number;     // 0 = root; +1 per indent unit
  kind: string;      // bare node-kind (container/text/icon/illustration/group/image/…)
  wBucket: number;   // bucketed width  (0 when unknown)
  hBucket: number;   // bucketed height (0 when unknown)
  children: IrNode[];
}

// The UIX dialect uses "├── " / "└── " connectors; each ancestor level prepends
// "│   " or "    " (4 chars). So indentDepth = (chars before the connector)/4 + 1.
const CONNECTOR_RE = /[├└]──\s/;
const SIZE_RE = /\[(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)\]/;

/** Coarse size bands so minor layout jitter still matches (shared with canonicalize). */
export function bucketSize(n: number): number {
  if (!n || n <= 0) return 0;
  if (n < 24) return 1;
  if (n < 48) return 2;
  if (n < 96) return 3;
  if (n < 200) return 4;
  if (n < 400) return 5;
  if (n < 800) return 6;
  return 7;
}

/** The bare node-kind = the first whitespace-delimited token (already lowercase in
 *  this dialect: container/text/icon/illustration/image/group/vector/…). Names,
 *  colours, fonts and asset filenames are all stripped by only taking that token. */
function kindOf(content: string): string {
  const tok = content.trim().split(/[\s"[]/)[0];
  return tok || 'node';
}

/**
 * Parse one UIX IR tree-notation string into a node TREE. Robust to the optional
 * "  [preview: …]  (N vectors bundled)" suffix (it sits after the content we read).
 */
export function parseIrTree(tree: string | undefined): IrNode | null {
  if (!tree || !tree.trim()) return null;
  const lines = tree.split('\n').filter(l => l.trim().length > 0);
  if (!lines.length) return null;

  const mkNode = (depth: number, content: string): IrNode => {
    const sm = content.match(SIZE_RE);
    return {
      depth,
      kind: kindOf(content),
      wBucket: sm ? bucketSize(Number(sm[1])) : 0,
      hBucket: sm ? bucketSize(Number(sm[2])) : 0,
      children: [],
    };
  };

  // The first line is the root (no connector).
  const root = mkNode(0, lines[0]);
  // A stack of (node, depth) — we attach each line to the nearest shallower node.
  const stack: IrNode[] = [root];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(CONNECTOR_RE);
    if (!m || m.index === undefined) continue;          // not a node line — skip
    const depth = Math.floor(raw.slice(0, m.index).length / 4) + 1;
    const content = raw.slice(m.index + m[0].length);
    const node = mkNode(depth, content);
    // Pop back to this node's parent (depth-1).
    while (stack.length > depth) stack.pop();
    const parent = stack[stack.length - 1] ?? root;
    parent.children.push(node);
    stack.push(node);
  }
  return root;
}

// ── skeleton serialization → stable hash ─────────────────────────────────────
// A subtree's skeleton is a DETERMINISTIC pre-order string of (kind:wBucket:hBucket)
// tokens with explicit nesting markers, so two trees hash identically iff they have
// the same shape + bucketed sizes. Children are kept in document order (the design's
// own order is part of its identity); we do NOT sort siblings — a reordered layout
// is a different design. (Order-independence would over-merge distinct screens.)
export function skeletonString(node: IrNode | null): string {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (n: IrNode): void => {
    parts.push(`${n.kind}:${n.wBucket}:${n.hBucket}(`);
    for (const c of n.children) walk(c);
    parts.push(')');
  };
  walk(node);
  return parts.join('');
}

/** sha256 of a skeleton string → short stable hex (the fingerprint value). */
export function hashSkeleton(skeleton: string): string {
  return crypto.createHash('sha256').update(skeleton).digest('hex').slice(0, 16);
}

/** Whole-frame fingerprint from its IR tree notation. Stable: same tree → same id. */
export function frameFingerprint(tree: string | undefined): string {
  return hashSkeleton(skeletonString(parseIrTree(tree)));
}

/** Fingerprint of an already-parsed subtree (used for per-widget fingerprints). */
export function subtreeFingerprint(node: IrNode | null): string {
  return hashSkeleton(skeletonString(node));
}

// ── widget-level fingerprints ────────────────────────────────────────────────
// DESYNC GUARD (the central correctness property). A widget fingerprint is the
// language-independent anchor the Reduce step matches ON; if the SAME widget can get
// DIFFERENT fingerprints, cross-frame clustering desyncs. So a widget's fingerprint
// must be a deterministic function of its IDENTITY ALONE — never of report order,
// sibling widgets, or which model worded the classification.
//
// In Phase 1a we do NOT have a per-IR-node → widgetKind classifier (the IR is
// container/text/icon/…, not primaryButton/…), so we cannot reliably bind an AI
// widget to one specific IR subtree without a fragile heuristic (count-proximity,
// consume-once) that is exactly the desync source. Instead the widget fingerprint
// is CONTENT-ADDRESSED by the controlled lexicon term: hash(kind | proposedName).
// Two widgets classified into the same lexicon kind get the SAME fingerprint on
// EVERY frame — provably desync-free — and a proposed-name widget is keyed by its
// proposed name, so two frames proposing the same novel widget match too.
//
// The IR's structural repetition is still valuable to the Reduce step, so we expose
// it SEPARATELY as a frame-level structural inventory (widgetGroups) rather than
// fragilely zipping it onto AI widgets.

/** The desync-safe per-widget fingerprint: content-addressed by the lexicon term. */
export function widgetFingerprint(kind: string, proposedName?: string): string {
  const key = kind === 'other' && proposedName ? `other:${proposedName}` : kind;
  return hashSkeleton(`widget|${key}`);
}

// A frame's deterministic structural inventory: every distinct repeated subtree
// shape under the root, grouped + counted. Independent of the AI entirely — a stable
// structural signal the Reduce step can use ALONGSIDE the controlled descriptor.
export interface WidgetGroup {
  fingerprint: string;
  count: number;
  /** the bare kind of the group's roots (a coarse type hint). */
  rootKind: string;
  /** representative node depth (shallowest occurrence). */
  minDepth: number;
}

/**
 * Enumerate fingerprints of EVERY subtree under the frame (excluding the root),
 * grouped + counted. Two byte-identical subtrees collapse to one group with count≥2.
 * Deterministic + AI-independent. (Phase 1a uses this as supporting structural
 * evidence; the authoritative per-widget anchor is widgetFingerprint above.)
 */
export function widgetGroups(tree: string | undefined): WidgetGroup[] {
  const root = parseIrTree(tree);
  if (!root) return [];
  const groups = new Map<string, WidgetGroup>();
  const visit = (n: IrNode, isRoot: boolean): void => {
    if (!isRoot) {
      const fp = subtreeFingerprint(n);
      const g = groups.get(fp);
      if (g) { g.count++; g.minDepth = Math.min(g.minDepth, n.depth); }
      else groups.set(fp, { fingerprint: fp, count: 1, rootKind: n.kind, minDepth: n.depth });
    }
    for (const c of n.children) visit(c, false);
  };
  visit(root, true);
  return [...groups.values()];
}
