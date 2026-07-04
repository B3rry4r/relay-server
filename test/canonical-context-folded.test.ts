// =============================================================================
// P1-core — the LEAD screen's canonical context must carry the FOLDED payloads.
//
// The old context gave the lead's agent one line per folded frame (`- modal "m_x"
// (frame N)`) — no reference image, no IR — although prep had ALREADY rendered
// every folded frame's reference and its run.screens[] spec carries the tree.
// Result on Ping: 13/13 folded modals shipped as invented placeholders. These
// tests prove buildCanonicalContext now emits, per folded state/modal:
//   • its reference image path + an explicit OPEN-the-image instruction,
//   • its (hygiene'd, bounded) IR tree,
//   • a deterministic presentation-kind hint from geometry,
//   • the fixed presenter contract the variant preview calls,
//   • the placeholder/deferral prohibition.
// Plus units over modalPresentationHint and variantsForCanonicalScreen.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildCanonicalContext, modalPresentationHint, variantsForCanonicalScreen,
} from '../src/relay-server/ai-screen-loop';
import type { Canonical, CanonicalScreen } from '../src/relay-server/canonicalize';
import type { RunScreen } from '../src/relay-server/build-run-store';

const cs: CanonicalScreen = {
  canonicalId: 'c_286_3158',
  frameIds: ['286:3158', '313:9999'],
  name: 'userRegistrationScreen',
  states: [
    { id: 'default', frameId: '286:3158' },
    { id: 'success', frameId: '313:9999' },
  ],
  modals: [{ id: 'm_313_9543', frameId: '313:9543', baseCanonicalId: 'c_286_3158' }],
  role: 'screen',
  route: '/user-registration',
};

const canonical: Canonical = {
  version: 1,
  screens: [cs],
  components: [],
  templates: [],
  flow: { entryCanonicalId: 'c_286_3158', edges: [] },
  frameMap: { '286:3158': 'c_286_3158', '313:9999': 'c_286_3158', '313:9543': 'm_313_9543' },
  warnings: [],
};

const MODAL_TREE = [
  `container "iPhone 14 & 15 Pro - 79" [393×852] bg:#ffffff clip`,
  `├── container "Content" [375×734] flex:col justify:center align:center`,
  `│   └── container "Modal" [375×627] flex:col align:center gap:57`,
  `│       └── text "Verify your identity" [342×25] color:#121212 Poppins/18px`,
].join('\n');

const runScreens: RunScreen[] = [
  { frameId: '286:3158', frameName: 'iPhone - 46', status: 'pending', spec: {
    packet: 'x', referenceImagePath: '.uix/refs/IPhone46.png', tree: 'container "root" [393×852]', width: 393, height: 852,
  } as any },
  { frameId: '313:9999', frameName: 'iPhone - 99', status: 'pending', spec: {
    packet: 'x', referenceImagePath: '.uix/refs/IPhone99.png', tree: 'container "root" [393×852]\n├── text "Success!" [100×20]', width: 393, height: 852,
  } as any },
  { frameId: '313:9543', frameName: 'iPhone - 79', status: 'pending', spec: {
    packet: 'x', referenceImagePath: '.uix/refs/IPhone79.png', tree: MODAL_TREE, width: 393, height: 852,
  } as any },
];

describe('modalPresentationHint (deterministic geometry)', () => {
  it('near-full-width + tall centered content → full-screen scrim overlay (not a spinner dialog)', () => {
    const p = modalPresentationHint(MODAL_TREE, 393, 852, 393, 852);
    expect(p.kind).toBe('fullOverlay');
    expect(p.hint).toContain('SCRIM OVERLAY');
    expect(p.hint).toContain('Do NOT use a Material spinner dialog');
  });
  it('near-full-width + short content → bottom sheet', () => {
    const tree = `container "f" [393×852]\n├── container "Bottom Sheet" [393×320]`;
    expect(modalPresentationHint(tree, 393, 852).kind).toBe('bottomSheet');
  });
  it('narrow content → dialog', () => {
    const tree = `container "f" [393×852]\n├── container "Delete dialog" [280×180]`;
    expect(modalPresentationHint(tree, 393, 852).kind).toBe('dialog');
  });
  it('a frame much smaller than the base IS the dialog card', () => {
    expect(modalPresentationHint('container "x" [300×200]', 300, 200, 393, 852).kind).toBe('dialog');
  });
  it('no geometry signal → bottom-sheet default, flagged as such', () => {
    const p = modalPresentationHint(undefined);
    expect(p.kind).toBe('bottomSheet');
    expect(p.hint).toContain('default');
  });
});

describe('buildCanonicalContext with folded payloads', () => {
  const ctx = buildCanonicalContext(canonical, cs, runScreens);

  it('emits the modal reference path + an explicit open-the-image instruction', () => {
    expect(ctx).toContain('.uix/refs/IPhone79.png');
    expect(ctx).toContain('OPEN this image with your file-reading tool');
  });

  it('emits the modal IR tree + geometry-derived presentation hint', () => {
    expect(ctx).toContain('Verify your identity');           // IR content, not just the frame id
    expect(ctx).toContain('PRESENTATION (derived from the frame\'s geometry)');
    expect(ctx).toContain('SCRIM OVERLAY');                   // this modal's geometry → fullOverlay
  });

  it('emits the fixed presenter contract the variant preview calls', () => {
    expect(ctx).toContain('showModal_313_9543(BuildContext context)');
  });

  it('emits the non-default state payload with its own reference + Screen(state:) shape', () => {
    expect(ctx).toContain('FOLDED STATE "success"');
    expect(ctx).toContain('.uix/refs/IPhone99.png');
    expect(ctx).toContain(`(state: 'success')`);
    expect(ctx).toContain('Success!');                        // the state frame's IR content
  });

  it('states the placeholder prohibition', () => {
    expect(ctx).toContain('FORBIDDEN');
    expect(ctx).toMatch(/placeholder/i);
  });

  it('degrades to the one-line form when no run screens / spec are available', () => {
    const bare = buildCanonicalContext(canonical, cs);
    expect(bare).toContain('- modal "m_313_9543" (frame 313:9543)');
    expect(bare).not.toContain('.uix/refs/IPhone79.png');
  });
});

describe('variantsForCanonicalScreen', () => {
  it('lists each non-default state + each modal with its own spec payload (lead excluded)', () => {
    const v = variantsForCanonicalScreen(cs, runScreens);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ kind: 'state', id: 'success', frameId: '313:9999', referenceImagePath: '.uix/refs/IPhone99.png', width: 393, height: 852 });
    expect(v[1]).toMatchObject({ kind: 'modal', id: 'm_313_9543', frameId: '313:9543', referenceImagePath: '.uix/refs/IPhone79.png' });
  });
});
