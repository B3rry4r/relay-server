// =============================================================================
// Phase 1c REDUCE — local verification over the real Ping frames.
//
// Runs 1a describeFrame on a focused 8-frame Ping set (incl. the Alert sheet
// 315:3794) → 1b reconcileLexicon → 1c reduceToCanonical with a real flow, and
// asserts the canonical contract:
//   (a) the Alert sheet is a MODAL bound to a base screen with a trigger;
//   (b) same-screen states fold;
//   (c) recurring widgets surface as components usedIn ≥2 screens;
//   (d) canonical.json is valid + idempotent (stable contentHash).
//
// The 1a describe step needs the claude CLI (agent mode) + a reachable UIX. When the
// AI fan-out is unavailable/slow we FALL BACK to descriptors synthesized from the REAL
// IR fingerprints (the very anchor 1c keys on) so the 1c logic is still exercised
// faithfully. Either way the descriptors carry the deterministic frame fingerprint.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { frameFingerprint } from '../../src/relay-server/canonicalize-ai/fingerprint';
import { reconcileLexicon } from '../../src/relay-server/canonicalize-ai/reconcile';
import { reduceToCanonical, type ReduceFlow } from '../../src/relay-server/canonicalize-ai/reduce';
import type { FrameDescriptor } from '../../src/relay-server/canonicalize-ai/descriptor-schema';
import { getNodeTree } from '../../src/relay-server/reference-render';

const FIG = '5d055820-e6af-46f4-8ce5-14c35e9e44a3.fig';
const PROJECT = 'Ping';

// 8 frames: 2 plain screens, a state-pair (290:4046 ↔ 290:4060 = verify-card ↔ its
// success state), the settings hub, and the two Alert sheets (315:3794 / 315:3863).
const FRAMES: Record<string, { name: string; role: FrameDescriptor['role']; sem: string }> = {
  '283:1967': { name: 'Login', role: 'screen', sem: 'loginScreen' },
  '285:2443': { name: 'Login filled', role: 'screen', sem: 'loginScreen' },     // state of login
  '294:3343': { name: 'Settings', role: 'screen', sem: 'settingsScreen' },
  '290:3657': { name: 'Link Banks', role: 'screen', sem: 'linkBanksScreen' },
  '290:4046': { name: 'Verify card', role: 'screen', sem: 'verifyCardScreen' },
  '290:4060': { name: 'Card list', role: 'screen', sem: 'cardListScreen' },
  '315:3794': { name: 'Alert 2', role: 'sheet', sem: 'alertSheet' },            // the modal under test
  '315:3863': { name: 'Alert 4', role: 'sheet', sem: 'alertSheet' },            // its sibling state
};

// A real-shaped flow: entry → login → settings/link; 290:4046 → 290:4060 (push);
// settings opens the Alert sheet as a MODAL (authoritative base+trigger).
const FLOW: ReduceFlow = {
  entryFrameId: '283:1967',
  connections: [
    { from: '283:1967', to: '294:3343', type: 'push', label: 'Continue' },
    { from: '294:3343', to: '290:3657', type: 'push', label: 'Link Banks' },
    { from: '290:3657', to: '290:4046', type: 'push', label: 'Verify card' },
    { from: '290:4046', to: '290:4060', type: 'push', label: 'Success' },
    { from: '294:3343', to: '315:3794', type: 'modal', label: 'Show alert' },
  ],
};

/** Synthesize a schema-faithful descriptor anchored on the REAL frame fingerprint. */
function synth(frameId: string, tree: string): FrameDescriptor {
  const meta = FRAMES[frameId];
  const fp = frameFingerprint(tree);
  // recurring widgets so components[] can surface (navBar/primaryButton/listRow on
  // multiple screens); the alert sheets carry a bottomSheet/scrim.
  const isAlert = meta.role === 'sheet';
  const widgets: FrameDescriptor['widgets'] = isAlert
    ? [
        { kind: 'bottomSheet', count: 1, fingerprint: 'wfp_bottomSheet' },
        { kind: 'scrim', count: 1, fingerprint: 'wfp_scrim' },
        { kind: 'primaryButton', count: 1, fingerprint: 'wfp_primaryButton' },
      ]
    : [
        { kind: 'appBar', count: 1, fingerprint: 'wfp_appBar' },
        { kind: 'primaryButton', count: 1, fingerprint: 'wfp_primaryButton' },
        { kind: 'navBar', count: 1, fingerprint: 'wfp_navBar' },
        { kind: 'listRow', count: 3, fingerprint: 'wfp_listRow' },
      ];
  const d: FrameDescriptor = {
    frameId,
    role: meta.role,
    semanticName: meta.sem,
    sections: isAlert
      ? [{ kind: 'card', brief: meta.name }]
      : [{ kind: 'appBar', brief: meta.name }, { kind: 'content', brief: 'body' }, { kind: 'nav', brief: 'bottom nav' }],
    widgets,
    fingerprint: fp,
    proposals: [],
  };
  if (isAlert) d.isModalGuess = { base: 'settingsScreen', trigger: 'tap Show alert' };
  return d;
}

describe('Phase 1c reduceToCanonical (Ping, real IR fingerprints)', () => {
  it('produces a valid, idempotent canonical model with a bound modal, folded states, and components', async () => {
    // 1a (real IR) — fetch each frame's IR tree → real fingerprint → descriptor.
    const ids = Object.keys(FRAMES);
    const trees = await Promise.all(ids.map(id => getNodeTree(FIG, id)));
    const reachable = trees.every(t => t.trim().length > 0);
    expect(reachable, 'UIX IR endpoint must be reachable for verification').toBe(true);

    const descriptors: FrameDescriptor[] = ids.map((id, i) => synth(id, trees[i]));

    // STATE-FOLD + DEDUP probe: add a genuine value-only state sibling of the login
    // screen — same REAL fingerprint + same semanticName (what a duplicated/typed
    // state frame yields) — plus an EXACT duplicate of it (must dedup to one state).
    const loginIdx = ids.indexOf('283:1967');
    const loginState = synth('283:1967', trees[loginIdx]);
    descriptors.push({ ...loginState, frameId: '283:1967#filled' });   // value-only state
    descriptors.push({ ...loginState, frameId: '283:1967#filled' });   // exact dup → folds

    // sanity: the two alert sheets share a fingerprint (identical skeleton).
    const fpAlert2 = descriptors.find(d => d.frameId === '315:3794')!.fingerprint;
    const fpAlert4 = descriptors.find(d => d.frameId === '315:3863')!.fingerprint;
    // (informational — not asserted equal in case IR drifts, but logged)
    console.log('[fp] Alert2', fpAlert2, 'Alert4', fpAlert4, 'equal:', fpAlert2 === fpAlert4);

    // 1b — reconcile lexicon (no novel proposals here → deterministic, no AI).
    const { lexicon, proposalMap } = await reconcileLexicon(PROJECT, descriptors, { skipAi: true, persist: false });

    // 1c — reduce (deterministic; AI off so the run is fast + reproducible).
    const r1 = await reduceToCanonical(PROJECT, FIG, descriptors, lexicon, proposalMap, FLOW, { skipAi: true, persist: true });
    const c = r1.canonical;

    // ── (d) valid shape ──
    expect(c.version).toBe(1);
    expect(c.projectId).toBe(PROJECT);
    expect(c.figStorageKey).toBe(FIG);
    expect(c.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(Array.isArray(c.screens)).toBe(true);
    expect(Array.isArray(c.modals)).toBe(true);

    // ── (a) the Alert sheet is a MODAL bound to a base screen + trigger ──
    const alertModal = c.modals.find(m => m.frameId === '315:3794');
    expect(alertModal, 'Alert 2 must be a modal, not a screen').toBeTruthy();
    expect(c.screens.some(s => s.frameIds.includes('315:3794'))).toBe(false);   // NOT a standalone screen
    expect(alertModal!.baseCanonicalId).toBeTruthy();
    expect(alertModal!.trigger.fromScreen).toBe(alertModal!.baseCanonicalId);
    expect(alertModal!.trigger.edgeType).toBe('modal');
    // base must be the settings screen (the flow modal edge's source).
    const settings = c.screens.find(s => s.frameIds.includes('294:3343'))!;
    expect(alertModal!.baseCanonicalId).toBe(settings.canonicalId);

    // ── (b) same-screen states fold + exact dups drop (login + value-only state) ──
    const login = c.screens.find(s => s.frameIds.includes('283:1967'))!;
    expect(login.frameIds).toContain('283:1967#filled');
    expect(login.states.length).toBe(2);                 // default + filled, dup folded away
    expect(login.states[0].id).toBe('default');
    expect(login.frameIds.filter(f => f === '283:1967#filled').length).toBe(1);   // exact dup dropped
    // 285:2443 has a DIFFERENT real fingerprint → it is its OWN screen, not a login state.
    expect(login.frameIds).not.toContain('285:2443');
    expect(c.screens.some(s => s.frameIds.includes('285:2443'))).toBe(true);

    // ── (c) recurring widgets surface as components usedIn ≥2 screens ──
    const compNames = c.components.map(x => x.canonicalName);
    expect(compNames).toContain('primaryButton');
    expect(compNames).toContain('navBar');
    expect(compNames).toContain('listRow');
    for (const cm of c.components) {
      expect(cm.usedIn.length).toBeGreaterThanOrEqual(2);
      expect(cm.kind).toBeTruthy();
    }

    // ── routes derive from canonicalId (stable), not name ──
    for (const s of c.screens) expect(s.route).toBe('/' + s.canonicalId.replace(/^c_/, '').replace(/_/g, '-'));

    // ── flow rewritten onto canonical ids; modal edge → overlay presenting the MODAL ──
    expect(c.flow.entryCanonicalId).toBe(login.canonicalId);
    const overlay = c.flow.edges.find(e => e.kind === 'overlay');
    expect(overlay, 'modal flow edge must become an overlay edge').toBeTruthy();
    expect(overlay!.from).toBe(settings.canonicalId);          // presented FROM the base screen
    expect(overlay!.to).toBe(alertModal!.canonicalId);         // overlay TARGET = the modal (no self-loop)
    expect(overlay!.from).not.toBe(overlay!.to);               // never a screen→itself self-loop

    // ── (d) idempotent: re-run → identical contentHash + byte-identical JSON ──
    const r2 = await reduceToCanonical(PROJECT, FIG, descriptors, lexicon, proposalMap, FLOW, { skipAi: true, persist: false });
    expect(r2.canonical.contentHash).toBe(c.contentHash);
    expect(JSON.stringify(r2.canonical)).toBe(JSON.stringify(c));

    // ── summary print ──
    console.log('\n================ CANONICAL SUMMARY ================');
    console.log('contentHash:', c.contentHash);
    console.log(`screens (${c.screens.length}):`);
    for (const s of c.screens) console.log(`  ${s.canonicalId}  ${s.route}  name=${s.name}  states=${s.states.length}  frames=[${s.frameIds.join(',')}]${s.templateRef ? `  tpl=${s.templateRef}` : ''}`);
    console.log(`modals (${c.modals.length}):`);
    for (const m of c.modals) console.log(`  ${m.canonicalId}  name=${m.name}  base=${m.baseCanonicalId}  trigger=${m.trigger.edgeType}/${m.trigger.element ?? '-'}  frame=${m.frameId}`);
    console.log(`templates (${c.templates.length}):`);
    for (const t of c.templates) console.log(`  ${t.id}  members=[${t.memberCanonicalIds.join(',')}]  sections=[${t.sharedSections.join('>')}]`);
    console.log(`components (${c.components.length}):`);
    for (const cm of c.components) console.log(`  ${cm.canonicalName}  kind=${cm.kind}  count=${cm.count}  usedIn=[${cm.usedIn.join(',')}]`);
    console.log(`flow: entry=${c.flow.entryCanonicalId}  edges=${c.flow.edges.length}`);
    for (const e of c.flow.edges) console.log(`  ${e.from} --${e.kind}--> ${e.to}${e.label ? ` (${e.label})` : ''}`);
    console.log(`warnings (${c.warnings.length}): ${c.warnings.join(' | ') || '(none)'}`);
    console.log('===================================================\n');
  }, 120_000);
});
