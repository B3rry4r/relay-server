// =============================================================================
// File: src/relay-server/agent-packet.ts
//
// PURE, server-side port of relay-web's buildAgentPacket (features/uix/agentPacket.ts).
// The packet gives the coding agent: a pixel-accurate reference render, the IR
// tree, the navigation graph, and one-time bootstrap steps (design system + nav +
// assets). Kept verbatim with the client so prep moves to the server without
// changing the prompt the agent receives. NO React/DOM — minimal local types only.
// =============================================================================

// ── minimal local types (mirror relay-web/src/lib/uixApi.ts) ──────────────────
export interface FigFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId: string;
  pageName: string;
  /** Semantic kind: frame|component|component_set (sections are excluded as screens). */
  kind?: string;
}

export interface FlowConnection {
  from: string;        // frameId
  to: string;          // frameId
  type: 'tab' | 'push' | 'modal' | 'replace';
  label?: string;
  tabIndex?: number;
}
export interface FlowGraph {
  entryFrameId: string | null;
  connections: FlowConnection[];
}

export interface AgentPacketInput {
  frame: { id: string; name: string; width: number; height: number };
  tree: string;
  framework: string;
  frameworkLabel: string;
  refImagePath: string | null;
  flowGraph: FlowGraph;
  frames: FigFrame[];
  /** Project already scaffolded for this framework (skip the heavy preamble). */
  bootstrapped: boolean;
  /** How many design assets were localized into the project (0 = none). */
  assetCount: number;
  /** When revising an already-generated screen. */
  changeNote?: string;
  /** BETA: build the screen section-by-section (separate components) vs one pass. */
  sectionBuild?: boolean;
  /** Ordered semantic section labels (from the sectioner) for section-build. */
  sections?: string[];
  /** Free-form extra instructions from the human (UI context / preferences). */
  userNotes?: string;
}

const navVerb = (t: string) =>
  t === 'push' ? 'navigates (push onto the nav stack) to'
  : t === 'replace' ? 'replaces the current route with'
  : t === 'modal' ? 'opens as a modal / sheet'
  : t === 'tab' ? 'switches tab to'
  : 'navigates to';

/** Per-screen navigation lines (the screen's outgoing routes + entry/tab role). */
function navLinesFor(frame: { id: string }, flow: FlowGraph, fname: (id: string) => string): string[] {
  if (!flow.connections.length) return [];
  const lines = [`Navigation — wire REAL navigation for this screen, do not build it as a dead end:`];
  if (flow.entryFrameId === frame.id) lines.push(`- This is the app's ENTRY / start screen.`);
  const incomingTab = flow.connections.find(c => c.to === frame.id && c.type === 'tab');
  if (incomingTab) lines.push(`- This screen is a TAB destination (tab index ${incomingTab.tabIndex ?? '?'}) of the app's bottom tab bar.`);
  // A frame that is ONLY ever reached as a modal/overlay is NOT a standalone
  // page — it's an overlay shown over its source screen. Building it as a full
  // route (and duplicating the underlying screen) is a classic codegen bug.
  const incomingModal = flow.connections.filter(c => c.to === frame.id && c.type === 'modal');
  const reachedOtherwise = flow.connections.some(c => c.to === frame.id && c.type !== 'modal');
  if (incomingModal.length && !reachedOtherwise) {
    const src = incomingModal[0].from;
    lines.push(`- ⚠️ This frame is a MODAL / OVERLAY opened from "${fname(src)}". Build it as a modal/bottom-sheet/dialog presented OVER "${fname(src)}" (reuse that screen as the backdrop). Do NOT create a new full-page route, and do NOT duplicate "${fname(src)}" — the modal is just an overlay layer on it.`);
  }
  for (const c of flow.connections.filter(c => c.from === frame.id)) {
    lines.push(`- ${c.label ? `"${c.label}" ` : ''}${navVerb(c.type)} "${fname(c.to)}".`);
  }
  lines.push(`Use the framework's idiomatic router. Map: push→push onto stack, replace→replace route, modal→present as sheet/dialog (overlay, not a page), tab→bottom tab bar destination.`);
  lines.push(``);
  return lines;
}

/** Heuristic hint when this frame looks like a near-duplicate / state-variant of
 *  another (same base name modulo "copy"/"– 2"/state words). The agent should
 *  reuse the existing screen and build only the difference, not a 2nd screen. */
function duplicateHint(frame: { id: string; name: string }, frames: Array<{ id: string; name: string }>): string[] {
  const norm = (s: string) => s.toLowerCase()
    .replace(/\b(copy|duplicate|\d+|v\d+|modal|overlay|sheet|popup|dialog|open|opened|active|selected|filled|empty|state|default|hover|pressed|error|success|fil: )\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const me = norm(frame.name);
  if (!me) return [];
  const twin = frames.find(f => f.id !== frame.id && norm(f.name) === me);
  if (!twin) return [];
  return [
    `⚠️ This frame ("${frame.name}") looks like a STATE/VARIANT of "${twin.name}" (same base name). If the only difference is an open sheet/popup/menu, a toggled state, or minor content, do NOT build a second near-identical screen — read .uix/context.md, find "${twin.name}", and implement ONLY the difference as a state/variant/overlay of it, reusing its widgets.`,
    ``,
  ];
}

/** One-time bootstrap steps run only on the first build into a project. */
function bootstrapSteps(fwLabel: string, flow: FlowGraph, assetCount: number, fname: (id: string) => string): string[] {
  const hasNav = flow.connections.length > 0;
  const tabDests = flow.connections.filter(c => c.type === 'tab')
    .sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0)).map(c => fname(c.to));
  const navStep = hasNav ? [
    `4. Set up the app's NAVIGATION architecture now (so later screens just register into it): `
      + `${flow.entryFrameId ? `entry screen "${fname(flow.entryFrameId)}"; ` : ''}`
      + `${tabDests.length ? `a bottom tab bar with tabs [${tabDests.join(', ')}]; ` : ''}`
      + `a navigation stack for push/replace/modal routes. Create a central route table / router and register screens by name.`,
  ] : [];
  const assetStep = assetCount > 0 ? [
    `${hasNav ? 5 : 4}. The design's real assets (${assetCount} files) are already in assets/icons/ (SVG) and assets/images/ (raster). Reference these actual files for icons/images — the IR tree's "assets/..." paths point at them; do NOT invent placeholder icons.`,
  ] : [];
  return [
    `1. Inspect the project. If it is empty or a bare scaffold, set it up idiomatically for ${fwLabel} (initialise, add dependencies, entry point).`,
    `2. Establish a real DESIGN SYSTEM you'll reuse for every later screen: derive the colour palette, typography scale (families/sizes/weights) and spacing from this screen's IR and centralise them as theme tokens; factor recurring UI (buttons, inputs, cards, nav/app bars) into shared components. Later screens MUST reuse these, not re-style inline.`,
    `3. Create .uix/context.md — a durable hand-off for future build sessions: record where the design-system tokens & shared components live, the routing/navigation structure, and a screens index (screen name → source file). You will read and extend this on every later screen.`,
    ...navStep,
    ...assetStep,
  ];
}

export function buildAgentPacket(input: AgentPacketInput): string {
  const { frame, tree, framework, frameworkLabel, refImagePath, flowGraph, frames, bootstrapped, assetCount, changeNote, sectionBuild, sections, userNotes } = input;
  const notes = (userNotes ?? '').trim();
  // Human-authored extra instructions — apply across the build (high priority,
  // but never override the reference render's visual ground truth).
  const noteLines = notes ? [
    `ADDITIONAL INSTRUCTIONS FROM THE USER (apply these; they reflect context/preferences the user added in the UI):`,
    ...notes.split('\n').map(l => `- ${l.trim()}`).filter(l => l !== '- '),
    ``,
  ] : [];
  const fname = (id: string) => frames.find(f => f.id === id)?.name ?? id;
  // BETA section-by-section build: decompose the screen into its top-level
  // sections and build each as its own component before composing.
  const sectionLines = sectionBuild ? [
    `BUILD MODE — SECTION BY SECTION:`,
    (sections && sections.length
      ? `- This screen's sections (top-to-bottom, from the design): ${sections.map((s, i) => `${i + 1}. ${s}`).join('  ')}. Build each as its OWN well-named, reusable component.`
      : `- Decompose this screen into its top-level SECTIONS (the frame's direct children in the IR tree — status bar, app bar / header, hero, content lists/cards, footer / bottom nav) and build each as its own component.`),
    `- For EACH section, in order: implement it and get its layout, spacing, colours and text right against the reference BEFORE moving to the next.`,
    `- Then compose the section components into the screen widget in order. Prefer several small focused components over one large widget.`,
    ``,
  ] : [];
  const setupSteps = bootstrapped
    ? [`The project is already set up for ${frameworkLabel} (including its navigation/router and assets/). READ .uix/context.md first for the established design system, routing and screens already built; reuse its theme, router, assets and shared components. Only add this screen and register it into the existing navigation.`]
    : bootstrapSteps(frameworkLabel, flowGraph, assetCount, fname);

  return [
    `You are an autonomous coding agent working in the CURRENT project directory. Build ONE screen from a Figma design into this project — you own file creation, naming, and project setup.`,
    `Target framework: ${frameworkLabel}.`,
    `Screen: "${frame.name}" (${frame.width}×${frame.height}px).`,
    ``,
    ...(refImagePath ? [
      `Reference render (pixel-accurate image of the target screen): ${refImagePath}`,
      `OPEN this image first with your file-reading tool and treat it as the visual ground truth — match its layout, proportions, spacing and colours. Use the IR tree below for exact values (hex colours, text, sizes).`,
      ``,
    ] : []),
    // DEMO DATA rule — sits next to the exact-values instruction on purpose: "use
    // exact values" + text-fidelity grading otherwise pushes agents to bake mock
    // identities ("3554", "Jameswaller@gmail.com") inline across every screen.
    `DEMO DATA — user-identifying mock content in the design (person names, emails, phone numbers, OTP codes, account/card numbers, dates of birth) must render EXACTLY as the reference shows, but must NOT be scattered as inline literals: hoist it to constructor parameters or one shared demo fixture (e.g. a \`DemoUser\` constant) whose DEFAULTS are the reference values, and reference that. Pixel output stays identical. Use ONE consistent demo identity app-wide — never mix two different mock users across screens.`,
    ``,
    `Design — IR tree notation (readable form of the Figma IR; complete: layout, text, colours, typography, effects, clip/mask):`,
    '```',
    tree,
    '```',
    ``,
    ...navLinesFor(frame, flowGraph, fname),
    ...duplicateHint(frame, frames),
    ...noteLines,
    ...sectionLines,
    `Steps:`,
    ...setupSteps,
    `- Create this screen as a well-named, idiomatic file — YOU choose the path/name per the framework's conventions. Reuse shared components/theme where sensible.`,
    `- Install any packages you need; ensure it builds / analyzes cleanly.`,
    `- Create a PREVIEW ENTRYPOINT that renders JUST this screen inside the app's real theme/providers (so it can be screenshot in isolation and compared to the reference). For Flutter, a small entrypoint file with its own main() that runs the screen widget wrapped in the app's MaterialApp/theme (e.g. lib/_preview/<screen>.dart). For web, a dedicated preview route (e.g. /_preview/<screen>) that mounts only this screen. Keep it in sync on every revision.`,
    `- Update .uix/context.md: add this screen to its index (screen name → source file) and note any new shared components/tokens/decisions, so the next session can resume with full context.`,
    `- Write a JSON manifest to .uix/last-gen.json: {"screen":"${frame.name}","framework":"${framework}","entry":"<relative path to the screen file>","previewEntry":"<flutter: relative path to the preview entrypoint .dart file | web: the preview route path starting with />","files":["<relative paths created/edited>"],"commands":["<cmds you ran>"],"notes":"<short>"}.`,
    ...(changeNote ? ['', `This screen was generated before — REVISE the existing file(s), applying: ${changeNote}`] : []),
    ``,
    `Output a brief summary (a few lines) of what you created/changed. Do not paste the full code.`,
  ].join('\n');
}
