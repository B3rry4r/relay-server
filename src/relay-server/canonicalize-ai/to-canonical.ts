// =============================================================================
// File: src/relay-server/canonicalize-ai/to-canonical.ts
//
// ADAPTER: CanonicalModel (the heavy-AI chain's output, RFC §4.1) → Canonical (the
// build-flow's consumed shape, canonicalize.ts). RFC v2 §4.2 — the AI chain
// (`canonicalize()` in orchestrate.ts) is THE canonicalization; runAppLoop consumes
// the deterministic `Canonical` shape, so this PURE function folds one into the other
// with zero IO:
//
//   - the AI model carries modals at the TOP LEVEL (`modals[]`, each with a
//     `baseCanonicalId`); the build shape nests `modals[]` INSIDE each screen — so we
//     FOLD every modal into its base screen by `baseCanonicalId` (an unbound modal —
//     empty base — is surfaced as a warning + kept as a standalone built screen, the
//     same contract the deterministic pre-pass uses);
//   - `frameMap` (every frameId → canonicalId — the single identity axis) is rebuilt
//     from the model: each screen's state frames → its canonicalId, each modal's frame
//     → its modal id (or, when unbound, its standalone screen id), each component frame
//     → its component id;
//   - states / templates / components / flow are mapped field-for-field;
//   - warnings carry through (1c/1d doubts → HITL Checkpoint 0).
//
// Deterministic + side-effect-free so it is trivially unit-testable; the caller
// persists the result via writeCanonical / writeFrameMap.
// =============================================================================

import type {
  Canonical,
  CanonicalScreen as BuildScreen,
  CanonicalState as BuildState,
  CanonicalModal as BuildModal,
  CanonicalComponent as BuildComponent,
  CanonicalTemplate as BuildTemplate,
  CanonicalFlow as BuildFlow,
  CanonicalFlowEdge as BuildFlowEdge,
} from '../canonicalize';
import type { CanonicalModel, CanonicalScreen as AiScreen } from './reduce';
import { canonicalIdFor, routeForCanonicalId } from './reduce';

/**
 * Fold the heavy-AI `CanonicalModel` into the build flow's `Canonical`. PURE — no IO,
 * no model calls. The AI chain has already done the reasoning; this is a structural
 * re-shape so `runAppLoop`'s existing writeCanonical / writeFrameMap / skeleton / fold
 * code consumes it unchanged.
 */
export function aiModelToCanonical(model: CanonicalModel): Canonical {
  const warnings: string[] = Array.isArray(model.warnings) ? [...model.warnings] : [];
  const frameMap: Record<string, string> = {};

  // ── screens (states map field-for-field; modals folded in below) ───────────
  const screens: BuildScreen[] = (model.screens ?? []).map((s: AiScreen): BuildScreen => {
    const states: BuildState[] = (s.states ?? []).map(st => ({ id: st.id, frameId: st.frameId }));
    // Every state frame of this screen maps onto the screen's canonical id.
    for (const fid of s.frameIds ?? []) frameMap[fid] = s.canonicalId;
    return {
      canonicalId: s.canonicalId,
      frameIds: [...(s.frameIds ?? [])],
      name: s.name,
      states: states.length ? states : [{ id: 'default', frameId: (s.frameIds ?? [])[0] }],
      modals: [],
      role: 'screen',
      route: s.route || routeForCanonicalId(s.canonicalId),
      ...(s.templateRef ? { templateRef: s.templateRef } : {}),
    };
  });
  const screenById = new Map<string, BuildScreen>(screens.map(s => [s.canonicalId, s]));

  // ── FOLD modals into their base screen by baseCanonicalId ──────────────────
  // The AI model lists modals at the top level; the build shape nests them under
  // their base screen. An unbound modal (empty/unresolved base) cannot be presented
  // as an overlay, so — mirroring the deterministic pre-pass — it is surfaced as a
  // warning AND kept as a standalone built screen so it is still reachable + built.
  // When an unbound modal is converted to a standalone screen it gets a BRAND-NEW
  // `c_` canonicalId (canonicalIdFor(frameId)) ≠ its old `m_` modal id. Flow edges
  // still reference the old id, so we record old→new here and REMAP edge endpoints
  // below — otherwise those edges dangle (point at an id no screen/modal carries).
  const modalIdRemap = new Map<string, string>();
  for (const m of model.modals ?? []) {
    const base = m.baseCanonicalId ? screenById.get(m.baseCanonicalId) : undefined;
    if (base) {
      const modal: BuildModal = { id: m.canonicalId, frameId: m.frameId, baseCanonicalId: m.baseCanonicalId };
      base.modals.push(modal);
      frameMap[m.frameId] = m.canonicalId;
    } else {
      warnings.push(`modal "${m.name}" (${m.frameId}) has no base screen — built as a standalone reachable route; bind it via the flow checkpoint to present it as an overlay`);
      const canonicalId = canonicalIdFor(m.frameId);
      const standalone: BuildScreen = {
        canonicalId,
        frameIds: [m.frameId],
        name: m.name,
        states: [{ id: 'default', frameId: m.frameId }],
        modals: [],
        role: 'screen',
        route: routeForCanonicalId(canonicalId),
      };
      screens.push(standalone);
      screenById.set(canonicalId, standalone);
      frameMap[m.frameId] = canonicalId;
      if (m.canonicalId && m.canonicalId !== canonicalId) modalIdRemap.set(m.canonicalId, canonicalId);
    }
  }

  // ── components → build component entries (their own canonical ids, no route) ─
  const components: BuildComponent[] = (model.components ?? []).map((c, i) => {
    // The AI model's components are keyed by canonicalName (a recurring widget), not a
    // frame — they have no frameId. Synthesize a stable id; they don't enter frameMap.
    const id = 'cmp_' + String(c.canonicalName).replace(/[^a-zA-Z0-9]+/g, '_') + (i ? `_${i}` : '');
    return { id, frameId: '', name: c.canonicalName };
  });

  // ── templates map field-for-field (members only; sharedSections is AI-only meta) ─
  const templates: BuildTemplate[] = (model.templates ?? []).map((t): BuildTemplate => ({
    id: t.id,
    memberCanonicalIds: [...(t.memberCanonicalIds ?? [])],
  }));

  // ── flow: AI edges use {from,to,kind}; build edges use {fromCanonicalId,toCanonicalId,kind} ─
  // Remap any endpoint that pointed at an unbound modal's OLD id to its new
  // standalone screen id; an edge that still references a non-existent endpoint
  // after remap is DEAD (dangling) → drop it with a warning rather than leave a
  // wire to nowhere (RFC §0.1 — no silent dangling state).
  const remap = (id: string): string => modalIdRemap.get(id) ?? id;
  // Valid endpoints = every screen (incl. folded-in standalone modals) + every
  // modal id still presented as an overlay under its base screen.
  const validEndpoints = new Set<string>(screens.map(s => s.canonicalId));
  for (const s of screens) for (const md of s.modals) validEndpoints.add(md.id);
  const edges: BuildFlowEdge[] = [];
  for (const e of model.flow?.edges ?? []) {
    const from = remap(e.from);
    const to = remap(e.to);
    if (!validEndpoints.has(from) || !validEndpoints.has(to)) {
      warnings.push(`flow edge ${e.from}→${e.to} (${e.kind}) drops: endpoint not a known screen/modal after remap — removed to avoid a dangling wire`);
      continue;
    }
    edges.push({
      fromCanonicalId: from,
      toCanonicalId: to,
      kind: e.kind,
      // Step-modal provenance carries through verbatim (a viaModal edge only exists
      // when the modal was BOUND to a base, so its m_ id is never in modalIdRemap).
      ...(e.viaModalId ? { viaModalId: e.viaModalId } : {}),
      ...(e.label ? { label: e.label } : {}),
    });
  }
  const flow: BuildFlow = {
    entryCanonicalId: model.flow?.entryCanonicalId ? remap(model.flow.entryCanonicalId) : null,
    edges,
  };

  return {
    version: 1,
    screens,
    components,
    templates,
    flow,
    frameMap,
    warnings,
    // T15: carry the AI model's structural contentHash onto the build Canonical so the
    // per-run sidecar matches the live .uix/canonical.json — enabling verify-pipeline's
    // auto-tie of the AI-fired proof log without an explicit --runId.
    ...(model.contentHash ? { contentHash: model.contentHash } : {}),
  };
}
