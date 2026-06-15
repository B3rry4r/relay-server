import { describe, it, expect } from 'vitest';
import {
  parseFrame, multisetJaccard, clusterFrames, classifyRole,
  isSameScreenState, buildCanonical, rewriteFlow, canonicalIdFor,
  type FrameInput,
} from '../src/relay-server/canonicalize';
import type { RunFlow } from '../src/relay-server/build-run-store';

// A small login screen, two states (default + "code sent"), a structural twin
// (Change PIN vs Change Password = semantic split = template), a bottom-sheet
// modal over a scrim, and a tiny component.
const loginDefault = `Screen: Login (393×852)
├─ AppBar [ROW, h:56, bg:#FFFFFF]
│   └─ Text "Sign in" — 20px bold #1A1A1A
├─ COL [COL, h:200]
│   ├─ Text "Email" — 14px #888888
│   └─ Text "Password" — 14px #888888
└─ Button [ROW, h:48, bg:#1496E6]
    └─ Text "Continue" — 16px bold #FFFFFF`;

const loginCodeSent = `Screen: Login (393×852)
├─ AppBar [ROW, h:56, bg:#FFFFFF]
│   └─ Text "Sign in" — 20px bold #1A1A1A
├─ COL [COL, h:200]
│   ├─ Text "Email" — 14px #888888
│   └─ Text "Password" — 14px #888888
└─ Button [ROW, h:48, bg:#1496E6]
    └─ Text "Continue" — 16px bold #FFFFFF`;

const changePin = `Screen: Change PIN (393×852)
├─ AppBar [ROW, h:56, bg:#FFFFFF]
│   └─ Text "Change PIN" — 20px bold #1A1A1A
├─ COL [COL, h:200]
│   ├─ Text "Current PIN" — 14px #888888
│   └─ Text "New PIN" — 14px #888888
└─ Button [ROW, h:48, bg:#1496E6]
    └─ Text "Save PIN" — 16px bold #FFFFFF`;

const sheetModal = `Screen: Reset Sheet (393×852)
├─ Scrim [STACK, h:852, bg:#000000CC]
│   └─ Sheet [COL, h:300, bg:#FFFFFF, r:24]
│       ├─ Text "Reset password" — 18px bold #1A1A1A
│       └─ Button [ROW, h:48, bg:#1496E6]`;

const tinyComponent = `Card [COL, h:120, bg:#FFFFFF, r:12] (280×120)
├─ Text "Balance" — 12px #888888
└─ Text "$1,200" — 24px bold #1A1A1A`;

describe('parseFrame', () => {
  it('extracts skeleton tokens, texts, colours and top-child count', () => {
    const p = parseFrame(loginDefault);
    expect(p.skeleton.length).toBeGreaterThan(3);
    expect(p.texts).toContain('sign in');
    expect(p.colors).toContain('#1496E6');
    expect(p.topChildren).toBe(3);
  });
  it('handles empty tree', () => {
    expect(parseFrame(undefined).skeleton).toEqual([]);
  });
});

describe('multisetJaccard', () => {
  it('is 1 for identical skeletons', () => {
    const a = parseFrame(loginDefault).skeleton;
    const b = parseFrame(loginCodeSent).skeleton;
    expect(multisetJaccard(a, b)).toBe(1);
  });
  it('is high for structural twins', () => {
    const a = parseFrame(loginDefault).skeleton;
    const b = parseFrame(changePin).skeleton;
    expect(multisetJaccard(a, b)).toBeGreaterThanOrEqual(0.85);
  });
});

describe('clusterFrames', () => {
  it('clusters structural twins together, leaves the modal/component apart', () => {
    const parsed = [loginDefault, loginCodeSent, changePin, sheetModal, tinyComponent].map(parseFrame);
    const clusters = clusterFrames(parsed);
    // login default + codeSent + changePin form one cluster (indices 0,1,2).
    const big = clusters.find(c => c.includes(0))!;
    expect(big).toContain(1);
    expect(big).toContain(2);
    expect(big).not.toContain(3);
  });
});

describe('classifyRole', () => {
  it('detects a scrim+sheet modal', () => {
    expect(classifyRole(parseFrame(sheetModal), 393, 852)).toBe('modal');
  });
  it('detects a small component', () => {
    expect(classifyRole(parseFrame(tinyComponent), 280, 120)).toBe('component');
  });
  it('treats a full-device frame as a screen', () => {
    expect(classifyRole(parseFrame(loginDefault), 393, 852)).toBe('screen');
  });
});

describe('isSameScreenState', () => {
  it('value-only diff → same screen (a state)', () => {
    expect(isSameScreenState(parseFrame(loginDefault), parseFrame(loginCodeSent))).toBe(true);
  });
  it('semantic diff → distinct screens (template siblings)', () => {
    expect(isSameScreenState(parseFrame(loginDefault), parseFrame(changePin))).toBe(false);
  });
});

describe('buildCanonical (end to end)', () => {
  const frames: FrameInput[] = [
    { frameId: '1:1', frameName: 'Login', width: 393, height: 852, tree: loginDefault },
    { frameId: '1:2', frameName: 'Login Code Sent', width: 393, height: 852, tree: loginCodeSent },
    { frameId: '1:3', frameName: 'Change PIN', width: 393, height: 852, tree: changePin },
    { frameId: '2:1', frameName: 'Reset Sheet', width: 393, height: 852, tree: sheetModal },
    { frameId: '3:1', frameName: 'Balance Card', width: 280, height: 120, tree: tinyComponent },
  ];
  const flow: RunFlow = {
    entryFrameId: '1:1',
    connections: [
      { from: '1:1', to: '1:2', type: 'push' },          // intra-canonical → state transition (dropped)
      { from: '1:1', to: '1:3', type: 'push' },          // Login → Change PIN (template sibling): real edge
      { from: '1:3', to: '2:1', type: 'modal' },         // Change PIN → Reset Sheet: overlay
      { from: '1:1', to: '1:3', type: 'push' },          // duplicate parallel → deduped
    ],
  };

  it('collapses 5 frames into 2 canonical screens (+1 template) +1 component, modal bound', () => {
    const canon = buildCanonical(frames, flow);
    // Login(default+codeSent) and Change PIN are two screens sharing a template.
    expect(canon.screens.length).toBe(2);
    const login = canon.screens.find(s => s.frameIds.includes('1:1'))!;
    expect(login.states.length).toBe(2);
    expect(login.states[0].id).toBe('default');
    const pin = canon.screens.find(s => s.frameIds.includes('1:3'))!;
    expect(login.templateRef).toBeDefined();
    expect(login.templateRef).toBe(pin.templateRef);
    expect(canon.templates.length).toBe(1);
    // The component is pulled out (no route).
    expect(canon.components.length).toBe(1);
    expect(canon.components[0].frameId).toBe('3:1');
    // The modal is bound to the Change PIN base screen (its incoming modal edge).
    expect(pin.modals.length).toBe(1);
    expect(pin.modals[0].frameId).toBe('2:1');
  });

  it('rewrites the flow onto canonical ids (state-transition dropped, overlay kept, dedup)', () => {
    const canon = buildCanonical(frames, flow);
    const loginId = canon.frameMap['1:1'];
    const pinId = canon.frameMap['1:3'];
    // 1:1→1:2 is intra-canonical (both Login) → dropped. 1:1→1:3 deduped to one edge.
    const loginToPin = canon.flow.edges.filter(e => e.fromCanonicalId === loginId && e.toCanonicalId === pinId);
    expect(loginToPin.length).toBe(1);
    expect(loginToPin[0].kind).toBe('push');
    // The modal edge 1:3→2:1 becomes an overlay targeting the base (Change PIN).
    const overlay = canon.flow.edges.find(e => e.kind === 'overlay');
    expect(overlay).toBeDefined();
    expect(overlay!.toCanonicalId).toBe(pinId);
    expect(canon.flow.entryCanonicalId).toBe(loginId);
  });

  it('warns when there is no flow', () => {
    const canon = buildCanonical(frames, undefined);
    expect(canon.warnings.some(w => /flow.connections == 0/.test(w))).toBe(true);
  });
});

describe('canonicalIdFor / rewriteFlow guards', () => {
  it('produces a stable id from a frame id', () => {
    expect(canonicalIdFor('313:10816')).toBe('c_313_10816');
  });
  it('rewriteFlow with no flow yields empty edges', () => {
    const f = rewriteFlow(undefined, {}, [], []);
    expect(f.edges).toEqual([]);
    expect(f.entryCanonicalId).toBeNull();
  });
});
