// =============================================================================
// P3 — deterministic prompt blocks: NAV STACK POLICY + DEMO DATA rule.
//
// Root causes (Ping audit): the ONLY nav-stack guidance anywhere was one packet
// mapping line, so the built app pushed Home onto the login form (back-gesture
// returned to auth) and push-looped add-card; and the packet's "use exact
// values" + text-fidelity verify pushed agents to bake mock identities
// ("3554", "Jameswaller@gmail.com") inline across every screen.
//
// These snapshot tests pin the two blocks into the emitted contract/packet text:
//   • buildAppPlan (injected into EVERY screen's written contract) carries the
//     NAV STACK POLICY block — canonical AND legacy runs;
//   • buildAgentPacket carries the DEMO DATA rule next to the exact-values line.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildAppPlan } from '../src/relay-server/ai-screen-loop';
import { buildAgentPacket, type AgentPacketInput } from '../src/relay-server/agent-packet';

const run = {
  screens: [
    { frameId: '1:1', frameName: 'Login', status: 'pending', spec: { tree: '', packet: '' } },
    { frameId: '1:2', frameName: 'Home', status: 'pending', spec: { tree: '', packet: '' } },
  ],
  flow: {
    entryFrameId: '1:1',
    connections: [{ from: '1:1', to: '1:2', type: 'push', label: 'Sign in' }],
  },
} as any;

const NAV_POLICY_LINES = [
  'NAV STACK POLICY',
  'pushNamedAndRemoveUntil(route, (r) => false)',
  'must NEVER return to login/onboarding',
  'REPLACES the current route (pushReplacementNamed)',
  'POPS back to it (popUntil / pop)',
  'NEVER push its base screen again',
  'switched by tab index',
];

describe('P3 NAV STACK POLICY in the app plan (written contract)', () => {
  it('appears for legacy (non-canonical) runs', () => {
    const plan = buildAppPlan(run);
    for (const line of NAV_POLICY_LINES) expect(plan).toContain(line);
  });

  it('appears for canonical runs too (before the register-all-routes rule)', () => {
    const canonical = {
      version: 1,
      screens: [
        { canonicalId: 'c_1', frameIds: ['1:1'], name: 'loginScreen', states: [], modals: [], role: 'screen', route: '/login' },
        { canonicalId: 'c_2', frameIds: ['1:2'], name: 'homeScreen', states: [], modals: [], role: 'screen', route: '/home' },
      ],
      components: [], templates: [],
      flow: { entryCanonicalId: 'c_1', edges: [{ fromCanonicalId: 'c_1', toCanonicalId: 'c_2', kind: 'replace' }] },
      frameMap: { '1:1': 'c_1', '1:2': 'c_2' }, warnings: [],
    } as any;
    const plan = buildAppPlan(run, canonical);
    for (const line of NAV_POLICY_LINES) expect(plan).toContain(line);
    expect(plan.indexOf('NAV STACK POLICY')).toBeLessThan(plan.indexOf('Register ALL these routes'));
  });
});

describe('P3 DEMO DATA rule in the agent packet', () => {
  const input: AgentPacketInput = {
    frame: { id: '1:1', name: 'Login', width: 393, height: 852 },
    tree: 'container "root" [393×852]',
    framework: 'flutter',
    frameworkLabel: 'Flutter',
    refImagePath: '.uix/refs/Login.png',
    flowGraph: { entryFrameId: '1:1', connections: [] },
    frames: [{ id: '1:1', name: 'Login', x: 0, y: 0, width: 393, height: 852, pageId: 'p', pageName: 'Page 1' }],
    bootstrapped: false,
    assetCount: 0,
  };

  it('hoists user-identifying mock content to params/fixture with reference defaults', () => {
    const packet = buildAgentPacket(input);
    expect(packet).toContain('DEMO DATA');
    expect(packet).toContain('must NOT be scattered as inline literals');
    expect(packet).toContain('constructor parameters or one shared demo fixture');
    expect(packet).toContain('DEFAULTS are the reference values');
    expect(packet).toContain('ONE consistent demo identity app-wide');
    // Sits next to the exact-values instruction (visual ground truth block).
    expect(packet.indexOf('exact values')).toBeGreaterThan(-1);
    expect(packet.indexOf('DEMO DATA')).toBeGreaterThan(packet.indexOf('exact values'));
  });

  it('is present even without a reference render (values still must not scatter)', () => {
    const packet = buildAgentPacket({ ...input, refImagePath: null });
    expect(packet).toContain('DEMO DATA');
  });
});
