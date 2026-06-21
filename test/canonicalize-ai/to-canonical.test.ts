// =============================================================================
// Adapter unit test: aiModelToCanonical (CanonicalModel → Canonical).
//
// PURE — no IO, no AI. Feeds a hand-crafted CanonicalModel (the heavy-AI chain's
// output) with top-level modals (one bound, one unbound), state siblings, a template,
// components, and a flow, then asserts the build-flow Canonical:
//   (a) modals FOLD into their base screen's nested modals[] by baseCanonicalId;
//   (b) an UNBOUND modal becomes a standalone built screen + a warning;
//   (c) frameMap covers EVERY frame (states → screen id, modal → modal/standalone id);
//   (d) states / templates / flow are preserved + field-mapped.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { aiModelToCanonical } from '../../src/relay-server/canonicalize-ai/to-canonical';
import type { CanonicalModel } from '../../src/relay-server/canonicalize-ai/reduce';

function sampleModel(): CanonicalModel {
  return {
    version: 1,
    projectId: 'Ping',
    figStorageKey: 'x.fig',
    contentHash: 'deadbeef',
    screens: [
      {
        canonicalId: 'c_settings',
        name: 'settingsScreen',
        route: '/settings',
        role: 'screen',
        frameIds: ['294:3343', '294:3400'],   // two states
        states: [
          { id: 'default', frameId: '294:3343', brief: 'settings hub' },
          { id: 'state2', frameId: '294:3400', brief: 'settings toggled' },
        ],
        templateRef: 't_abc',
      },
      {
        canonicalId: 'c_login',
        name: 'loginScreen',
        route: '/login',
        role: 'screen',
        frameIds: ['283:1967'],
        states: [{ id: 'default', frameId: '283:1967', brief: 'login' }],
        templateRef: 't_abc',
      },
    ],
    modals: [
      // bound modal → folds into c_settings
      {
        canonicalId: 'm_alert',
        name: 'alertSheet',
        frameId: '315:3794',
        baseCanonicalId: 'c_settings',
        trigger: { fromScreen: 'c_settings', edgeType: 'modal', element: 'Sign out' },
      },
      // UNBOUND modal (empty base) → standalone screen + warning
      {
        canonicalId: 'm_orphan',
        name: 'orphanSheet',
        frameId: '999:0001',
        baseCanonicalId: '',
        trigger: { fromScreen: '', edgeType: 'modal' },
      },
    ],
    templates: [
      { id: 't_abc', memberCanonicalIds: ['c_login', 'c_settings'], sharedSections: ['appbar', 'list'] },
    ],
    components: [
      { canonicalName: 'primaryButton', kind: 'button', usedIn: ['c_login', 'c_settings'], count: 4 },
    ],
    flow: {
      entryCanonicalId: 'c_login',
      edges: [
        { from: 'c_login', to: 'c_settings', kind: 'push', label: 'continue' },
        { from: 'c_settings', to: 'm_alert', kind: 'overlay' },
      ],
    },
    warnings: ['flow has 0 edges — sample warning'],
  };
}

describe('aiModelToCanonical adapter', () => {
  it('folds top-level modals into their base screen by baseCanonicalId', () => {
    const c = aiModelToCanonical(sampleModel());
    const settings = c.screens.find(s => s.canonicalId === 'c_settings')!;
    expect(settings.modals.map(m => m.id)).toContain('m_alert');
    const folded = settings.modals.find(m => m.id === 'm_alert')!;
    expect(folded.frameId).toBe('315:3794');
    expect(folded.baseCanonicalId).toBe('c_settings');
    // The bound modal is NOT a standalone screen.
    expect(c.screens.find(s => s.canonicalId === 'm_alert')).toBeUndefined();
  });

  it('keeps an unbound modal as a standalone built screen + warns', () => {
    const c = aiModelToCanonical(sampleModel());
    // standalone screen synthesized from the orphan modal's frame id
    const standalone = c.screens.find(s => s.frameIds.includes('999:0001'));
    expect(standalone).toBeDefined();
    expect(standalone!.role).toBe('screen');
    expect(standalone!.modals).toHaveLength(0);
    // not folded onto any base screen
    expect(c.screens.flatMap(s => s.modals).find(m => m.id === 'm_orphan')).toBeUndefined();
    expect(c.warnings.some(w => /orphanSheet/.test(w) && /no base screen/.test(w))).toBe(true);
    // carries the model's own warnings through too
    expect(c.warnings).toContain('flow has 0 edges — sample warning');
  });

  it('builds a frameMap covering EVERY frame', () => {
    const c = aiModelToCanonical(sampleModel());
    // every state frame → its screen id
    expect(c.frameMap['294:3343']).toBe('c_settings');
    expect(c.frameMap['294:3400']).toBe('c_settings');
    expect(c.frameMap['283:1967']).toBe('c_login');
    // bound modal frame → its modal id
    expect(c.frameMap['315:3794']).toBe('m_alert');
    // unbound modal frame → its standalone screen id
    const standalone = c.screens.find(s => s.frameIds.includes('999:0001'))!;
    expect(c.frameMap['999:0001']).toBe(standalone.canonicalId);
    // EVERY frame in the model is mapped
    const allFrames = ['294:3343', '294:3400', '283:1967', '315:3794', '999:0001'];
    for (const f of allFrames) expect(c.frameMap[f]).toBeTruthy();
    expect(Object.keys(c.frameMap).sort()).toEqual(allFrames.sort());
  });

  it('preserves states, templates, components and flow', () => {
    const c = aiModelToCanonical(sampleModel());
    expect(c.version).toBe(1);
    const settings = c.screens.find(s => s.canonicalId === 'c_settings')!;
    expect(settings.states.map(s => s.id)).toEqual(['default', 'state2']);
    expect(settings.states.map(s => s.frameId)).toEqual(['294:3343', '294:3400']);
    expect(settings.templateRef).toBe('t_abc');

    expect(c.templates).toHaveLength(1);
    expect(c.templates[0].memberCanonicalIds.sort()).toEqual(['c_login', 'c_settings']);

    expect(c.components.map(cm => cm.name)).toContain('primaryButton');

    expect(c.flow.entryCanonicalId).toBe('c_login');
    const push = c.flow.edges.find(e => e.kind === 'push')!;
    expect(push.fromCanonicalId).toBe('c_login');
    expect(push.toCanonicalId).toBe('c_settings');
    expect(push.label).toBe('continue');
    const overlay = c.flow.edges.find(e => e.kind === 'overlay')!;
    expect(overlay.fromCanonicalId).toBe('c_settings');
    expect(overlay.toCanonicalId).toBe('m_alert');
  });

  // T14.9 — an unbound modal becomes a standalone screen with a NEW c_ id; flow
  // edges that referenced its OLD m_ id must be REMAPPED to the new id, never left
  // dangling (pointing at an id no screen/modal carries).
  it('remaps flow edges that referenced an unbound modal to its new standalone id', () => {
    const model = sampleModel();
    // Add a flow edge that targets the UNBOUND modal m_orphan by its old m_ id.
    model.flow.edges.push({ from: 'c_login', to: 'm_orphan', kind: 'push', label: 'see orphan' });
    const c = aiModelToCanonical(model);

    const standalone = c.screens.find(s => s.frameIds.includes('999:0001'))!;
    expect(standalone.canonicalId).not.toBe('m_orphan');   // got a fresh c_ id

    // The edge that pointed at m_orphan is now wired to the new standalone id.
    const edge = c.flow.edges.find(e => e.label === 'see orphan')!;
    expect(edge).toBeDefined();
    expect(edge.toCanonicalId).toBe(standalone.canonicalId);

    // NO edge dangles: every endpoint resolves to a real screen or a folded modal.
    const valid = new Set<string>(c.screens.map(s => s.canonicalId));
    for (const s of c.screens) for (const m of s.modals) valid.add(m.id);
    for (const e of c.flow.edges) {
      expect(valid.has(e.fromCanonicalId)).toBe(true);
      expect(valid.has(e.toCanonicalId)).toBe(true);
    }
    // Specifically: the old m_orphan id appears on NO edge anymore.
    expect(c.flow.edges.some(e => e.fromCanonicalId === 'm_orphan' || e.toCanonicalId === 'm_orphan')).toBe(false);
  });

  // A flow edge to a genuinely non-existent endpoint (typo / stale id) is DROPPED
  // with a warning rather than left as a dead wire.
  it('drops a flow edge whose endpoint resolves to nothing, with a warning', () => {
    const model = sampleModel();
    model.flow.edges.push({ from: 'c_login', to: 'c_does_not_exist', kind: 'push' });
    const c = aiModelToCanonical(model);
    expect(c.flow.edges.some(e => e.toCanonicalId === 'c_does_not_exist')).toBe(false);
    expect(c.warnings.some(w => /c_does_not_exist/.test(w) && /drops|dangling/i.test(w))).toBe(true);
  });
});
