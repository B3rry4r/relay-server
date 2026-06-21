// =============================================================================
// File: src/relay-server/canonicalize-ai/descriptor-schema.ts
//
// DESCRIPTOR SCHEMA (Phase 1a output) — the controlled, schema'd descriptor the
// Describe stage emits per frame. NOT free prose: a later Reduce step clusters on
// these fields, so they must be enumerable + stable. The schema is both a JSON
// Schema (validated at runtime with @cfworker/json-schema) and a TS type.
//
// Two name channels, deliberately separated:
//   - widgets[].kind: MUST be a base-lexicon WidgetKind ('other' as escape hatch).
//   - proposals[]:    where the AI parks a GENUINELY novel widget name. A proposal
//     never silently enters the lexicon — a human / Reduce step promotes it. This
//     is what stops the controlled vocabulary from drifting.
// =============================================================================

import { ROLES, SECTION_KINDS, WIDGET_KINDS } from './lexicon';

// ── TS type ──────────────────────────────────────────────────────────────────
export interface DescriptorSection {
  kind: (typeof SECTION_KINDS)[number];
  /** one short clause (≤120 chars) — context for the Reduce step, NOT prose. */
  brief: string;
}
export interface DescriptorWidget {
  /** a base-lexicon WidgetKind, or 'other' when it must be a proposal instead. */
  kind: (typeof WIDGET_KINDS)[number];
  /** how many of this widget appear on the frame (≥1). */
  count: number;
  /** deterministic subtree fingerprint of one representative instance. */
  fingerprint: string;
  /** set ONLY when kind === 'other': the proposed name parked in proposals[]. */
  proposedName?: string;
}
export interface DescriptorProposal {
  /** a novel widget name in the SAME shape as a WidgetKind (camelCase). */
  proposedName: string;
  /** the fingerprint of the instance that motivated the proposal. */
  fingerprint: string;
  /** one short clause describing what it is (for human promotion review). */
  example: string;
}
export interface ModalGuess {
  /** the AI's guess at the base screen this overlay sits over (a semanticName), if any. */
  base?: string;
  /** what triggers the overlay (e.g. "tap Confirm"), if inferable. */
  trigger?: string;
}
export interface FrameDescriptor {
  frameId: string;
  role: (typeof ROLES)[number];
  /** a stable, human-meaningful name for the DESIGN (e.g. "loginScreen"), camelCase. */
  semanticName: string;
  sections: DescriptorSection[];
  widgets: DescriptorWidget[];
  /** present (possibly empty) when role is modal/sheet; the base/trigger guess. */
  isModalGuess?: ModalGuess;
  /** deterministic whole-frame fingerprint (the language-independent match anchor). */
  fingerprint: string;
  /** novel widgets the AI could not map to a lexicon kind. */
  proposals: DescriptorProposal[];
}

// ── JSON Schema (draft 2020-12; consumed by @cfworker/json-schema Validator) ───
export const FRAME_DESCRIPTOR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['frameId', 'role', 'semanticName', 'sections', 'widgets', 'fingerprint', 'proposals'],
  properties: {
    frameId: { type: 'string', minLength: 1 },
    role: { type: 'string', enum: [...ROLES] },
    semanticName: { type: 'string', minLength: 1, maxLength: 80 },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'brief'],
        properties: {
          kind: { type: 'string', enum: [...SECTION_KINDS] },
          brief: { type: 'string', maxLength: 120 },
        },
      },
    },
    widgets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'count', 'fingerprint'],
        properties: {
          kind: { type: 'string', enum: [...WIDGET_KINDS] },
          count: { type: 'integer', minimum: 1 },
          fingerprint: { type: 'string', minLength: 1 },
          proposedName: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]*$', maxLength: 40 },
        },
      },
    },
    isModalGuess: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base: { type: 'string', maxLength: 80 },
        trigger: { type: 'string', maxLength: 120 },
      },
    },
    fingerprint: { type: 'string', minLength: 1 },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['proposedName', 'fingerprint', 'example'],
        properties: {
          proposedName: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]*$', maxLength: 40 },
          fingerprint: { type: 'string', minLength: 1 },
          example: { type: 'string', maxLength: 120 },
        },
      },
    },
  },
} as const;

// A compact, prompt-ready description of the required output shape.
export function schemaForPrompt(): string {
  return [
    `OUTPUT — a SINGLE JSON object (no prose, no code fences) matching this shape exactly:`,
    `{`,
    `  "frameId": "<the frame id given below, verbatim>",`,
    `  "role": "<one role enum>",`,
    `  "semanticName": "<camelCase name for the DESIGN, e.g. loginScreen>",`,
    `  "sections": [ { "kind": "<sectionKind enum>", "brief": "<≤120 chars>" } ],`,
    `  "widgets": [ { "kind": "<widgetKind enum or 'other'>", "count": <int ≥1>, "fingerprint": "<leave as empty string ''>", "proposedName": "<camelCase, ONLY when kind is 'other'>" } ],`,
    `  "isModalGuess": { "base": "<base screen semanticName>", "trigger": "<what opens it>" },   // omit unless role is modal/sheet`,
    `  "fingerprint": "",   // leave as empty string; the server fills the deterministic value`,
    `  "proposals": [ { "proposedName": "<camelCase novel widget>", "fingerprint": "", "example": "<≤120 chars>" } ]`,
    `}`,
    `RULES:`,
    `- Classify every widget into a widgetKind enum. Use kind:"other" + a proposedName + a matching proposals[] entry ONLY for a widget that genuinely has no lexicon term.`,
    `- Leave every "fingerprint" field as "" — the server computes deterministic fingerprints from the IR; do NOT invent them.`,
    `- Describe the DESIGN, independent of any UI framework.`,
  ].join('\n');
}
