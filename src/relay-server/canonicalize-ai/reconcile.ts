// =============================================================================
// File: src/relay-server/canonicalize-ai/reconcile.ts
//
// RECONCILE-LEXICON (Phase 1b) — the SINGLE-WRITER step that runs ONCE, after the
// Phase-1a "Describe" fan-out has finished, and BEFORE Phase-1c "Reduce" clusters
// frames. 1a is parallel + per-frame: each frame is classified against the BASE
// lexicon, and any genuinely novel widget is parked in `proposals[]` (never
// silently added to the vocabulary). 1b collects every proposal across every frame
// and FREEZES a per-project lexicon = base + learned, so 1c can cluster against a
// single, stable vocabulary.
//
// THE CORE PROBLEM 1b SOLVES — SYNONYM DESYNC:
//   The SAME novel widget is described with DIFFERENT words on different frames
//   ("submitBtn" on login, "primaryCta" on signup). Phase-1a fingerprints are
//   CONTENT-ADDRESSED by the lexicon term (fingerprint.ts: hash(kind|proposedName)),
//   so two synonyms get DIFFERENT proposal fingerprints — merging by exact name OR by
//   fingerprint both MISS them. If 1b doesn't merge synonyms, 1c sees two "different"
//   widgets and cross-frame identity desyncs.
//
// So 1b merges proposals into canonical entries by TWO signals, in order:
//   1. DETERMINISTIC structural evidence — proposals whose `fingerprint` collides
//      (the AI happened to reuse the same proposedName, so 1a gave them the same
//      content-addressed fingerprint) are trivially the same widget. Also: a proposal
//      whose normalized name IS a base-lexicon term was a base widget mis-proposed;
//      it collapses back to base (never re-learned).
//   2. A SINGLE bounded `runModel('claude','sonnet')` synonym-merge call over the
//      remaining DISTINCT proposed names + their examples, which groups synonyms and
//      assigns ONE canonical camelCase name per cluster. Deterministic fallback
//      (group by normalized name) if the AI call fails or returns garbage.
//
// SINGLE-WRITER + IDEMPOTENT: re-running with the same descriptors yields the same
// lexicon — stable ordering (sorted), deterministic hashing, and the AI step is only
// consulted for synonym GROUPING; the final canonical names are re-derived
// deterministically from each cluster's members so a flaky model can't reshuffle
// committed names.
//
// Output: the FROZEN lexicon (base + learned) written to
// `<projectRoot>/.uix/lexicon.json`, plus a `proposalMap` (every original
// proposedName → its canonical name) so 1c can normalize descriptors before
// clustering. Imports the read-only 1a modules; never mutates them.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot, createTerminalEnv, resolveWorkspace } from '../runtime';
import { requireModel } from '../ai-observability';
import { LEXICON_VERSION, WIDGET_KINDS, WIDGET_KIND_SET } from './lexicon';
import type { FrameDescriptor, DescriptorProposal } from './descriptor-schema';

// ── public types ──────────────────────────────────────────────────────────────

/** A single entry in the frozen per-project lexicon. */
export interface LexiconEntry {
  /** the one canonical camelCase name (collision-free vs base + other learned). */
  canonicalName: string;
  /** every original proposedName (+ the canonical itself) that maps here, sorted. */
  aliases: string[];
  /** 'base' = a curated base-lexicon term; 'learned' = promoted from proposals. */
  origin: 'base' | 'learned';
  /** representative example clause (learned only) — for human review / 1c context. */
  example?: string;
  /** the deterministic fingerprints of the proposals that formed the cluster. */
  fingerprints?: string[];
}

/** The frozen, persisted per-project lexicon. */
export interface FrozenLexicon {
  lexiconVersion: string;     // base LEXICON_VERSION (cache-invalidation anchor)
  projectId: string;
  /** content hash of the learned set — stable across re-runs, changes only on drift. */
  contentHash: string;
  base: string[];             // the base widgetKinds, frozen for the record
  /** learned entries only (base entries are implied by `base`); sorted by name. */
  learned: LexiconEntry[];
}

export interface ReconcileResult {
  lexicon: FrozenLexicon;
  /** every original proposedName → its canonical name (base term or learned name). */
  proposalMap: Record<string, string>;
  /** where the frozen lexicon was written (null if no projectRoot resolvable). */
  lexiconPath: string | null;
  /** whether the bounded AI synonym-merge ran (false = deterministic fallback used). */
  aiMerged: boolean;
}

// ── normalization helpers (deterministic) ───────────────────────────────────────

/** Lowercase, strip non-alphanumerics, collapse common UI suffixes/prefixes so
 *  "submit_btn", "submitButton", "SubmitBtn" all normalize to one key. This is the
 *  DETERMINISTIC synonym pre-pass + the AI-failure fallback grouping key. It is
 *  intentionally conservative — it only merges spelling/abbreviation variants, NOT
 *  true semantic synonyms ("submit" vs "cta"); the AI step handles those. */
export function normalizeName(name: string): string {
  // split camelCase / snake / kebab into words — BEFORE lowercasing, or the camelCase
  // boundary is gone (e.g. "submitBtn" → "submitbtn" → one word, btn never expands).
  const s = String(name || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = s.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(w => w.toLowerCase());
  // expand a few common abbreviations so abbr ≡ full word
  const EXP: Record<string, string> = {
    btn: 'button', cta: 'button', img: 'image', nav: 'nav', txt: 'text',
    pwd: 'password', pw: 'password', msg: 'message', avatar: 'avatar',
    notif: 'notification', notifs: 'notification',
  };
  const expanded = words.map(w => EXP[w] ?? w);
  // drop pure filler that doesn't change identity
  const STOP = new Set(['the', 'a', 'an', 'widget', 'component', 'ui', 'el', 'element']);
  const kept = expanded.filter(w => !STOP.has(w));
  return (kept.length ? kept : expanded).join('');
}

/** camelCase a free name into a lexicon-shaped token (^[a-z][a-zA-Z0-9]*$). */
export function toCamel(name: string): string {
  const words = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return 'widget';
  const head = words[0].toLowerCase();
  const tail = words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  let camel = [head, ...tail].join('');
  if (!/^[a-z]/.test(camel)) camel = `w${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  camel = camel.replace(/[^a-zA-Z0-9]/g, '');
  return camel.slice(0, 40) || 'widget';
}

// A normalized index of base terms so a mis-proposed base widget collapses back to
// base and is NEVER re-learned. Built once (base lexicon is read-only).
const BASE_BY_NORM: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const k of WIDGET_KINDS) {
    if (k === 'other') continue;
    m.set(normalizeName(k), k);
  }
  return m;
})();

// ── collected-proposal shape (deterministic gather) ─────────────────────────────

interface CollectedProposal {
  proposedName: string;
  norm: string;             // normalizeName(proposedName)
  fingerprint: string;      // content-addressed fingerprint from 1a
  example: string;
  /** how many frames raised this exact proposedName (for canonical tie-breaks). */
  frequency: number;
  /** sorted distinct fingerprints seen for this proposedName. */
  fingerprints: Set<string>;
}

/** Gather every proposal across all descriptors, deduped by proposedName (so the
 *  same name on N frames is one collected proposal with frequency N). Deterministic
 *  + order-independent: the result is keyed + later sorted, never report-order. */
function collectProposals(descriptors: FrameDescriptor[]): Map<string, CollectedProposal> {
  const byName = new Map<string, CollectedProposal>();
  for (const d of descriptors) {
    const proposals: DescriptorProposal[] = Array.isArray(d?.proposals) ? d.proposals : [];
    for (const p of proposals) {
      const proposedName = String(p?.proposedName || '').trim();
      if (!proposedName) continue;
      const norm = normalizeName(proposedName);
      if (!norm) continue;
      const ex = byName.get(proposedName);
      if (ex) {
        ex.frequency++;
        if (p.fingerprint) ex.fingerprints.add(p.fingerprint);
        if (!ex.example && p.example) ex.example = String(p.example).slice(0, 120);
      } else {
        byName.set(proposedName, {
          proposedName, norm,
          fingerprint: p.fingerprint || '',
          example: String(p.example || '').slice(0, 120),
          frequency: 1,
          fingerprints: new Set(p.fingerprint ? [p.fingerprint] : []),
        });
      }
    }
  }
  return byName;
}

// ── deterministic pre-clustering (structural + normalized name) ──────────────────
// Returns clusters of proposedNames that are CERTAINLY the same widget, plus the set
// of proposals that collapsed to a base term (so they are never re-learned).

interface PreCluster {
  /** the proposedNames in this cluster (sorted). */
  members: string[];
  /** union of fingerprints across members (sorted). */
  fingerprints: string[];
  /** best example among members. */
  example: string;
  /** total frequency. */
  frequency: number;
}

function preCluster(collected: Map<string, CollectedProposal>): {
  baseHits: Map<string, string>;        // proposedName → base term
  clusters: PreCluster[];               // remaining novel clusters (by deterministic signal)
} {
  const baseHits = new Map<string, string>();

  // 1. collapse mis-proposed base widgets back to base.
  const novel: CollectedProposal[] = [];
  for (const cp of collected.values()) {
    const baseTerm = BASE_BY_NORM.get(cp.norm);
    if (baseTerm) baseHits.set(cp.proposedName, baseTerm);
    else novel.push(cp);
  }

  // 2. union-find over novel proposals, joined by EITHER:
  //    (a) shared content-addressed fingerprint (1a gave them the same name), OR
  //    (b) identical normalized name (spelling/abbreviation variants).
  // Stable order: sort proposals by name first so union representatives are deterministic.
  novel.sort((a, b) => a.proposedName.localeCompare(b.proposedName));
  const idx = new Map<string, number>();
  novel.forEach((cp, i) => idx.set(cp.proposedName, i));
  const parent = novel.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  const byNorm = new Map<string, number>();   // norm → first proposal index
  const byFp = new Map<string, number>();     // fingerprint → first proposal index
  novel.forEach((cp, i) => {
    const seenNorm = byNorm.get(cp.norm);
    if (seenNorm !== undefined) union(seenNorm, i); else byNorm.set(cp.norm, i);
    for (const fp of cp.fingerprints) {
      const seenFp = byFp.get(fp);
      if (seenFp !== undefined) union(seenFp, i); else byFp.set(fp, i);
    }
  });

  // 3. materialize clusters keyed by root.
  const groups = new Map<number, CollectedProposal[]>();
  novel.forEach((cp, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(cp); groups.set(r, g);
  });

  const clusters: PreCluster[] = [...groups.values()].map(g => {
    const members = g.map(c => c.proposedName).sort((a, b) => a.localeCompare(b));
    const fps = new Set<string>();
    let example = '';
    let frequency = 0;
    // pick example from the highest-frequency member (tie → name order).
    const byFreq = [...g].sort((a, b) => (b.frequency - a.frequency) || a.proposedName.localeCompare(b.proposedName));
    for (const c of g) { for (const fp of c.fingerprints) fps.add(fp); frequency += c.frequency; }
    example = byFreq.find(c => c.example)?.example || '';
    return { members, fingerprints: [...fps].sort(), example, frequency };
  });
  // stable cluster ordering by first member name.
  clusters.sort((a, b) => a.members[0].localeCompare(b.members[0]));
  return { baseHits, clusters };
}

// ── bounded AI synonym-merge over the deterministic clusters ─────────────────────
// The deterministic pass merges spelling/abbreviation variants; the AI pass merges
// true SEMANTIC synonyms across the remaining DISTINCT clusters (e.g. "submitButton"
// vs "primaryCta"). It only GROUPS — final canonical names are re-derived
// deterministically below, so a flaky model can't reshuffle committed names.

interface AiMergeGroup { canonical: string; members: string[] }

function buildMergePrompt(clusters: PreCluster[]): string {
  const items = clusters.map((c, i) => {
    const name = c.members[0];
    const aliases = c.members.length > 1 ? ` (aka ${c.members.slice(1).join(', ')})` : '';
    const ex = c.example ? ` — ${c.example}` : '';
    return `${i}. ${name}${aliases}${ex}`;
  }).join('\n');
  const baseList = WIDGET_KINDS.filter(k => k !== 'other').join(', ');
  return [
    `You are merging a controlled UI design lexicon. Below is a list of PROPOSED novel`,
    `widget names (with examples) gathered from describing many frames of ONE app. The`,
    `SAME widget is often proposed under DIFFERENT names on different frames`,
    `(e.g. "submitButton" and "primaryCta" are the same thing).`,
    ``,
    `TASK: group the items that refer to the SAME widget, and give each group ONE`,
    `canonical camelCase name. Rules:`,
    `- A canonical name MUST NOT collide with any of these BASE terms: ${baseList}.`,
    `- If a proposed item is REALLY one of those base terms, do NOT output it (drop it).`,
    `- Merge only genuine synonyms — do NOT over-merge distinct widgets.`,
    `- Prefer the clearest existing proposed name as the canonical (or a clean blend).`,
    `- camelCase, starts lowercase, letters/digits only.`,
    ``,
    `PROPOSED ITEMS (index. name (aka …) — example):`,
    items,
    ``,
    `OUTPUT — a SINGLE JSON object, no prose, no code fences:`,
    `{ "groups": [ { "canonical": "<camelCase>", "members": [<indices of items in this group>] } ] }`,
    `Every index 0..${clusters.length - 1} must appear in exactly one group (unless it is a base term you dropped).`,
    `Do NOT write or edit any files.`,
  ].join('\n');
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Run the bounded synonym-merge. Returns merge groups over cluster INDICES, or null
 *  on any failure (caller falls back to one-group-per-cluster). */
async function aiSynonymMerge(
  clusters: PreCluster[], projectId: string, root: string, modelId: string, runId?: string,
): Promise<AiMergeGroup[] | null> {
  if (clusters.length < 2) return null;       // nothing to merge across
  // AI-PURPOSE (Phase 1b synonym merge). The model is REQUIRED to fire — a
  // no-fire / error must SURFACE (RFC §0.1), not be swallowed into a null that
  // looks like "AI ran, nothing to merge". A genuine fired-but-no-groups reply
  // legitimately returns null (the deterministic one-group-per-cluster stands).
  const env = createTerminalEnv(resolveWorkspace());
  const prompt = buildMergePrompt(clusters);
  {
    const { text } = await requireModel('claude', prompt, env, root, {
      agent: false, modelId,
      log: { projectId, runId, step: 'canon.reconcile' },
      validate: (t) => { const j = extractJson(t); return j && typeof j === 'object' ? j : undefined; },
    });
    const parsed = extractJson(text);
    const groupsRaw: any[] = Array.isArray(parsed?.groups) ? parsed.groups : [];
    if (!groupsRaw.length) return null;
    const groups: AiMergeGroup[] = [];
    for (const g of groupsRaw) {
      const idxs: number[] = Array.isArray(g?.members)
        ? g.members.map((n: any) => Math.floor(Number(n))).filter((n: number) => Number.isInteger(n) && n >= 0 && n < clusters.length)
        : [];
      if (!idxs.length) continue;
      const members = [...new Set(idxs)].map(i => clusters[i].members).flat();
      const canonical = typeof g?.canonical === 'string' && g.canonical.trim() ? toCamel(g.canonical) : toCamel(clusters[idxs[0]].members[0]);
      groups.push({ canonical, members });
    }
    return groups.length ? groups : null;
  }
}

// ── deterministic canonical-name derivation (single-writer authority) ────────────
// Given the final grouping (clusters, optionally further merged by the AI), derive a
// stable canonical name per group WITHOUT trusting the AI's exact string: pick the
// member whose normalized form is the mode (tie → shortest, then alpha), camelCase it,
// then guarantee it doesn't collide with base or another learned name. This makes the
// committed lexicon a deterministic function of the GROUPING alone → idempotent.

function deriveCanonical(memberNames: string[], used: Set<string>): string {
  // pick representative member: highest count of identical normalized form, then
  // shortest name, then lexicographic — fully deterministic.
  const normCounts = new Map<string, number>();
  for (const m of memberNames) normCounts.set(normalizeName(m), (normCounts.get(normalizeName(m)) || 0) + 1);
  const rep = [...memberNames].sort((a, b) => {
    const ca = normCounts.get(normalizeName(a)) || 0;
    const cb = normCounts.get(normalizeName(b)) || 0;
    if (cb !== ca) return cb - ca;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
  let canonical = toCamel(rep);
  // collision guard: never equal a base term (case-insensitive) or an already-used learned name.
  const lowerBase = new Set(WIDGET_KINDS.map(k => k.toLowerCase()));
  let candidate = canonical;
  let n = 2;
  while (lowerBase.has(candidate.toLowerCase()) || used.has(candidate)) {
    candidate = `${canonical}${n++}`;
  }
  return candidate;
}

// ── deterministic input signature + AI-grouping cache (idempotency guarantee) ────
// The AI synonym-merge is the ONLY nondeterministic step. To make re-running provably
// idempotent (the user's hard requirement) even if the model groups differently on a
// second call, we key the AI grouping by a DETERMINISTIC signature of the cluster set
// it was asked to merge, and persist that grouping next to the lexicon. A re-run with
// an identical cluster set REUSES the cached grouping instead of re-asking the model.

interface GroupingCache {
  signature: string;
  /** the committed groups (each = sorted list of proposedNames). */
  groups: string[][];
}

/** Stable signature of the cluster set fed to the AI (members + examples, sorted). */
function clusterSignature(clusters: PreCluster[]): string {
  const norm = clusters
    .map(c => ({ m: [...c.members].sort(), e: c.example }))
    .sort((a, b) => a.m[0].localeCompare(b.m[0]));
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

const groupingCachePath = (root: string): string => path.join(root, '.uix', 'lexicon-grouping.json');

async function readGroupingCache(root: string, signature: string): Promise<string[][] | null> {
  try {
    const raw = await fs.readFile(groupingCachePath(root), 'utf8');
    const c = JSON.parse(raw) as GroupingCache;
    if (c && c.signature === signature && Array.isArray(c.groups)) return c.groups;
  } catch { /* no cache / unreadable → recompute */ }
  return null;
}

async function writeGroupingCache(root: string, signature: string, groups: string[][]): Promise<void> {
  try {
    const stable = groups.map(g => [...g].sort((a, b) => a.localeCompare(b))).sort((a, b) => a[0].localeCompare(b[0]));
    const abs = groupingCachePath(root);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify({ signature, groups: stable } as GroupingCache, null, 2));
  } catch { /* best-effort cache */ }
}

// ── main entry ──────────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** override the merge model (default 'sonnet'). */
  modelId?: string;
  /** durable run id — threaded into the AI log ctx so firing proof lands in the run log. */
  runId?: string;
  /** skip the AI call (deterministic-only) — for tests / offline. */
  skipAi?: boolean;
  /** write the lexicon to disk (default true). */
  persist?: boolean;
  /** ignore the persisted AI-grouping cache + force a fresh model call. */
  forceRemerge?: boolean;
}

/**
 * Phase 1b. Turn all 1a proposals across `descriptors` into a FROZEN per-project
 * lexicon (base + learned) and a proposalMap (original proposedName → canonical).
 *
 * Single-writer + idempotent: identical descriptors → identical lexicon
 * (deterministic gather/sort/derive; the AI is consulted only for synonym GROUPING,
 * and even then the canonical names are re-derived deterministically).
 */
export async function reconcileLexicon(
  projectId: string,
  descriptors: FrameDescriptor[],
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const root = resolveProjectRoot(projectId);
  const proposalMap: Record<string, string> = {};

  // 1. seed with base (read-only) — recorded for the frozen record.
  const base = WIDGET_KINDS.filter(k => k !== 'other');

  // 2. collect all proposals.
  const collected = collectProposals(Array.isArray(descriptors) ? descriptors : []);

  // 3a. deterministic pre-clustering (base collapse + structural/spelling merge).
  const { baseHits, clusters } = preCluster(collected);
  for (const [name, baseTerm] of baseHits) proposalMap[name] = baseTerm;

  // 3b. bounded AI synonym-merge across the remaining clusters.
  // IDEMPOTENCY: key the (nondeterministic) AI grouping by a deterministic signature
  // of the cluster set; reuse a cached grouping on a re-run so identical descriptors
  // yield the identical lexicon without re-asking a flaky model.
  let aiMerged = false;
  let finalGroups: string[][];   // each = list of proposedNames forming one learned entry
  const detGroups = clusters.map(c => c.members);
  const canRunAi = !opts.skipAi && clusters.length >= 2 && !!root;
  if (canRunAi && root) {
    const signature = clusterSignature(clusters);
    let groups = opts.forceRemerge ? null : await readGroupingCache(root, signature);
    if (groups) {
      aiMerged = true;                          // grouping originally came from the AI
      // sanity: every cluster member must still be covered (in case the input drifted).
      const cached = new Set(groups.flat());
      const allMembers = new Set(detGroups.flat());
      const covered = [...allMembers].every(m => cached.has(m)) && [...cached].every(m => allMembers.has(m));
      if (!covered) groups = null;
    }
    if (!groups) {
      const ai = await aiSynonymMerge(clusters, projectId, root, opts.modelId ?? 'sonnet', opts.runId);
      if (ai && ai.length) {
        aiMerged = true;
        // The AI groups over cluster members. Rebuild groups, then fold in any cluster
        // member the AI dropped/omitted as its own group (never lose a proposal).
        const assigned = new Set<string>();
        const g0 = ai.map(g => {
          const members = [...new Set(g.members)];
          for (const m of members) assigned.add(m);
          return members;
        }).filter(g => g.length);
        for (const c of clusters) {
          const missing = c.members.filter(m => !assigned.has(m));
          if (missing.length) { g0.push(missing); missing.forEach(m => assigned.add(m)); }
        }
        groups = g0;
        if (opts.persist !== false) await writeGroupingCache(root, signature, groups);
      } else {
        groups = detGroups;                     // AI failed → deterministic fallback
      }
    }
    finalGroups = groups;
  } else {
    // deterministic-only: one learned entry per deterministic cluster.
    finalGroups = detGroups;
  }

  // 4. derive deterministic canonical names + build learned entries.
  // collect supporting data (fingerprints / example) by member name.
  const dataByName = new Map<string, { fingerprints: Set<string>; example: string; frequency: number }>();
  for (const cp of collected.values()) {
    dataByName.set(cp.proposedName, { fingerprints: cp.fingerprints, example: cp.example, frequency: cp.frequency });
  }

  // stable group ordering: sort groups by their (sorted) first member name.
  const normalizedGroups = finalGroups
    .map(g => [...new Set(g)].filter(Boolean).sort((a, b) => a.localeCompare(b)))
    .filter(g => g.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const used = new Set<string>();
  const learned: LexiconEntry[] = [];
  for (const members of normalizedGroups) {
    const canonical = deriveCanonical(members, used);
    used.add(canonical);
    const fps = new Set<string>();
    let example = '';
    let bestFreq = -1;
    for (const m of members) {
      const d = dataByName.get(m);
      if (!d) continue;
      for (const fp of d.fingerprints) fps.add(fp);
      if (d.frequency > bestFreq && d.example) { example = d.example; bestFreq = d.frequency; }
    }
    // aliases = canonical + every member (sorted, deduped).
    const aliases = [...new Set([canonical, ...members])].sort((a, b) => a.localeCompare(b));
    learned.push({
      canonicalName: canonical,
      aliases,
      origin: 'learned',
      ...(example ? { example } : {}),
      fingerprints: [...fps].sort(),
    });
    for (const m of members) proposalMap[m] = canonical;
  }
  // stable final ordering by canonicalName.
  learned.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  // 5. content hash over the learned set (stable across re-runs) for idempotency proof.
  const contentHash = crypto.createHash('sha256')
    .update(JSON.stringify(learned.map(e => ({ c: e.canonicalName, a: e.aliases, f: e.fingerprints }))))
    .digest('hex').slice(0, 16);

  const lexicon: FrozenLexicon = {
    lexiconVersion: LEXICON_VERSION,
    projectId,
    contentHash,
    base,
    learned,
  };

  // 6. persist to <projectRoot>/.uix/lexicon.json (single writer).
  let lexiconPath: string | null = null;
  const persist = opts.persist !== false;
  if (root && fsSync.existsSync(root) && persist) {
    const rel = path.join('.uix', 'lexicon.json');
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // sort proposalMap keys for stable on-disk bytes.
    const stableMap: Record<string, string> = {};
    for (const k of Object.keys(proposalMap).sort()) stableMap[k] = proposalMap[k];
    await fs.writeFile(abs, JSON.stringify({ ...lexicon, proposalMap: stableMap }, null, 2));
    lexiconPath = abs;
  }

  return { lexicon, proposalMap, lexiconPath, aiMerged };
}
