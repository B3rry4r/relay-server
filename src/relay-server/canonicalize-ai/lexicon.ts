// =============================================================================
// File: src/relay-server/canonicalize-ai/lexicon.ts
//
// BASE LEXICON (Phase 1a) — a shared, curated, read-only taxonomy that the
// "Describe" stage classifies every frame against. A CONTROLLED LEXICON is the
// whole point of canonicalization-by-AI: if Stage 1a emits free prose, the later
// Reduce/cluster step has nothing stable to match on and cross-frame identity
// desyncs (the same card on two screens gets two different words). So Stage 1a is
// forced to pick from THESE enums; only a genuinely novel widget is allowed to
// PROPOSE a new name (carried separately so a human/Reduce step can promote it
// into the lexicon deliberately, never silently).
//
// FRAMEWORK-AGNOSTIC: these terms describe the DESIGN (a "primaryButton", a
// "list"), not a Flutter/React widget. Target-framework mapping happens far later.
//
// Read-only at runtime. Extend by EDITING this file (and bumping LEXICON_VERSION)
// so a lexicon change invalidates cached descriptors.
// =============================================================================

/** Bump when any enum below changes — feeds the descriptor fingerprint/cache key. */
export const LEXICON_VERSION = 'lex-v1';

// ── role: what KIND of artifact the frame is ─────────────────────────────────
// (mirrors canonicalize.ts FrameRole but adds the finer modal/sheet + variant
// distinctions the AI can actually see in a rendered reference.)
export const ROLES = [
  'screen',          // a full, routable destination
  'state-variant',   // the same screen in a different state (filled form, error, loading…)
  'modal',           // a dialog/alert presented over a dimmed base
  'sheet',           // a bottom/side sheet presented over a dimmed base
  'component',       // a sub-screen artboard: a single reusable piece, not a destination
] as const;
export type Role = (typeof ROLES)[number];

// ── sectionKinds: the major horizontal bands / regions of a screen ───────────
export const SECTION_KINDS = [
  'statusBar',   // OS status bar band (usually stripped, but describable)
  'appBar',      // top app/navigation bar (back button, title, actions)
  'header',      // a content header region (not the app bar)
  'hero',        // a large lead visual / headline block
  'list',        // a vertical collection of rows/items
  'grid',        // a 2D collection of cards/tiles
  'form',        // a group of input fields
  'field',       // a single labelled input region
  'cta',         // a call-to-action region (a prominent button area)
  'nav',         // a navigation region (tab bar / nav rail)
  'card',        // a self-contained card region
  'banner',      // a promotional / informational strip
  'toolbar',     // a secondary action bar (filters, segmented controls)
  'tabs',        // a tab strip selecting between views
  'footer',      // a bottom region (links, legal, secondary actions)
  'content',     // generic scrollable body when nothing more specific fits
  'other',       // an explicit escape hatch (NOT free text — keeps it enumerable)
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

// ── widgetKinds: the atomic / molecular UI pieces ────────────────────────────
export const WIDGET_KINDS = [
  'primaryButton',
  'secondaryButton',
  'tertiaryButton',
  'iconButton',
  'textButton',
  'fab',             // floating action button
  'textField',
  'pinField',        // OTP / PIN segmented input
  'searchBar',
  'dropdown',
  'checkbox',
  'radio',
  'toggle',          // switch
  'slider',
  'stepper',
  'segmentedControl',
  'avatar',
  'image',
  'icon',
  'illustration',
  'logo',
  'badge',
  'chip',
  'tag',
  'card',
  'listRow',         // a single row in a list
  'listItem',        // a richer list cell (leading icon + title + trailing)
  'navBar',          // bottom navigation bar
  'navItem',         // a single bottom-nav destination
  'tab',             // a single tab in a tab strip
  'appBar',          // the top bar as a widget reference
  'progressBar',
  'spinner',
  'divider',
  'label',           // a static text label
  'heading',         // a prominent title text
  'paragraph',       // a block of body copy
  'link',
  'tooltip',
  'snackbar',
  'dialog',          // the dialog container of a modal
  'bottomSheet',     // the sheet container of a sheet
  'scrim',           // the dimmed overlay backdrop
  'other',           // explicit escape hatch
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

// ── frozen Set views for O(1) membership checks (read-only) ───────────────────
export const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
export const SECTION_KIND_SET: ReadonlySet<string> = new Set(SECTION_KINDS);
export const WIDGET_KIND_SET: ReadonlySet<string> = new Set(WIDGET_KINDS);

export const isRole = (v: unknown): v is Role => typeof v === 'string' && ROLE_SET.has(v);
export const isSectionKind = (v: unknown): v is SectionKind => typeof v === 'string' && SECTION_KIND_SET.has(v);
export const isWidgetKind = (v: unknown): v is WidgetKind => typeof v === 'string' && WIDGET_KIND_SET.has(v);

/** A compact, prompt-ready rendering of the whole lexicon for the Describe call. */
export function lexiconForPrompt(): string {
  return [
    `BASE LEXICON ${LEXICON_VERSION} — classify ONLY into these enums (do not invent variants of an existing term; reuse the exact spelling):`,
    `role: ${ROLES.join(', ')}`,
    `sectionKinds: ${SECTION_KINDS.join(', ')}`,
    `widgetKinds: ${WIDGET_KINDS.join(', ')}`,
  ].join('\n');
}
