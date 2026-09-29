#!/usr/bin/env node
/* Emits .uix/canonical.json for each parity fixture from ONE shared model, so the
 * three frameworks are graded against the same screens, modals and flow edges.
 * Flutter routes are the skeleton's (semantic for built-by-skeleton screens,
 * machine for the two planted machine-named screens); web routes are
 * routeForCanonicalId() — the frame-derived slug a web run keeps (no skeleton). */
const fs = require('fs');
const path = require('path');

const ROUTES = {
  flutter: { c_10_1: '/login', c_10_2: '/home', c_10_3: '/10-3', c_10_4: '/10-4', c_10_5: '/details' },
  web: { c_10_1: '/10-1', c_10_2: '/10-2', c_10_3: '/10-3', c_10_4: '/10-4', c_10_5: '/10-5' },
};

function canonical(fw) {
  const r = ROUTES[fw === 'flutter' ? 'flutter' : 'web'];
  const scr = (id, name, frame, modals = []) => ({
    canonicalId: id, name, route: r[id], role: 'screen', frameIds: [frame],
    states: [{ id: 'default', frameId: frame }], modals,
  });
  return {
    version: 1,
    projectId: `parity-${fw}`,
    contentHash: `parity-${fw}-v1`,
    screens: [
      scr('c_10_1', 'loginScreen', '10:1'),
      scr('c_10_2', 'homeScreen', '10:2', [{ id: 'm_10_9', frameId: '10:9', baseCanonicalId: 'c_10_2' }]),
      scr('c_10_3', 'settingsScreen', '10:3', [{ id: 'm_10_8', frameId: '10:8', baseCanonicalId: 'c_10_3' }]),
      // A screen whose canonical NAME is a raw frame code — must never survive as a name.
      scr('c_10_4', '283:1967', '10:4'),
      // Referenced by a flow edge but never built (placeholder / skeleton stub).
      scr('c_10_5', 'detailsScreen', '10:5'),
    ],
    components: [
      { id: 'cmp_section_heading', name: 'SectionHeading', canonicalName: 'SectionHeading', kind: 'text', usedIn: ['c_10_2', 'c_10_3'], count: 2 },
    ],
    templates: [],
    flow: {
      entryCanonicalId: 'c_10_1',
      edges: [
        { fromCanonicalId: 'c_10_1', toCanonicalId: 'c_10_2', kind: 'push', label: 'Sign in' },       // E1 wired
        { fromCanonicalId: 'c_10_2', toCanonicalId: 'c_10_3', kind: 'push', label: 'Settings' },      // E2 dead trigger
        { fromCanonicalId: 'c_10_2', toCanonicalId: 'c_10_5', kind: 'push', label: 'View details' },  // E3 -> placeholder / stub
        { fromCanonicalId: 'c_10_2', toCanonicalId: 'm_10_9', kind: 'modal', label: 'Filter' },       // E4 bound modal, presented
        { fromCanonicalId: 'c_10_3', toCanonicalId: 'm_10_8', kind: 'modal', label: 'Log out' },      // E5 modal only the preview presents
        { fromCanonicalId: 'c_10_2', toCanonicalId: 'c_10_4', kind: 'tab', label: 'Profile' },        // E6 tab hosted by the shell
        { fromCanonicalId: 'c_10_3', toCanonicalId: 'c_10_1', kind: 'replace', label: 'Sign out' },   // E7 replace edge done with a push
      ],
    },
    frameMap: {},
    warnings: [],
  };
}

for (const fw of ['flutter', 'react', 'next']) {
  const out = path.join(__dirname, fw, '.uix', 'canonical.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(canonical(fw), null, 2) + '\n');
}
