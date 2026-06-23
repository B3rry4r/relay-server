// =============================================================================
// File: src/relay-server/canonicalize-ai/describe.ts
//
// DESCRIBE orchestration (Phase 1a) — per frame, emit a SCHEMA'D descriptor so a
// later Reduce step can cluster reliably. One bounded AI call per frame (the whole
// bounded context = ONE frame, so frames are trivially parallelizable later).
//
//   1. PREP   — render the frame's resolved reference image (renderFrameReference
//      from reference-render.ts — imported, never modified) + fetch its IR tree
//      (UIX /figma/ir via getNodeTree).
//   2. ASK    — one bounded runModel('claude','sonnet') call given the BASE LEXICON
//      + the reference image (by path; the agent opens it) + the IR tree, told to
//      classify into the lexicon enums and propose names ONLY for novel widgets.
//   3. NORMALIZE + VALIDATE — the AI never supplies fingerprints; the SERVER fills
//      every fingerprint deterministically from the IR (frame-level + per-widget),
//      then validates the result against the descriptor JSON schema. This split is
//      the desync guard: identical structures always get identical fingerprints
//      regardless of how the model worded its classification.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { resolveProjectRoot, createTerminalEnv, resolveWorkspace } from '../runtime';
import { requireModel } from '../ai-observability';
import type { AIModel } from '../ai-adapters';
import { getNodeTree, renderFrameReference } from '../reference-render';
import { isWidgetKind, lexiconForPrompt } from './lexicon';
import {
  FRAME_DESCRIPTOR_SCHEMA, schemaForPrompt,
  type FrameDescriptor, type DescriptorWidget, type DescriptorProposal,
} from './descriptor-schema';
import {
  frameFingerprint, widgetFingerprint, widgetGroups, type WidgetGroup,
} from './fingerprint';
import { readDescriptorCache, lookupDescriptor, putDescriptor } from './descriptor-cache';

export interface DescribeFrameInput {
  frameId: string;
  /** optional cosmetic name — only used in the prompt for human readability. */
  frameName?: string;
  width?: number;
  height?: number;
}

export interface DescribeResult {
  descriptor: FrameDescriptor;
  /** the deterministic frame fingerprint (also on descriptor.fingerprint). */
  fingerprint: string;
  /** whether a reference image was rendered + handed to the model. */
  rendered: boolean;
  /** the raw model text (for debugging a validation failure). */
  raw: string;
  /** T28: this descriptor came from the persisted cache (describe AI call SKIPPED). */
  cached: boolean;
}

const _validator = new Validator(FRAME_DESCRIPTOR_SCHEMA as unknown as Record<string, unknown>);

/** Parse the largest brace-balanced JSON object out of the model's text. */
function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Server-fill every fingerprint deterministically + coerce the AI's classification
 * into schema-valid shapes. The model is told to leave fingerprints empty; we assign
 * them here so identical things always match (the desync guard).
 *
 * Per-widget fingerprints are CONTENT-ADDRESSED by the controlled lexicon term
 * (widgetFingerprint = hash(kind | proposedName)), NOT by a fragile IR-group match.
 * This is the desync-safe property: the same widget kind gets the SAME fingerprint
 * on every frame, regardless of report order, sibling widgets, or wording — which is
 * exactly what the later Reduce step needs to cluster cross-frame. (See fingerprint.ts.)
 *
 * `groups` (the IR's deterministic structural inventory) is intentionally NOT zipped
 * onto widgets here — it is supporting structural evidence for the Reduce step.
 */
function normalizeDescriptor(
  raw: any, frameId: string, frameFp: string, _groups: WidgetGroup[],
): FrameDescriptor {
  const obj = (raw && typeof raw === 'object') ? raw : {};

  const widgetsRaw: any[] = Array.isArray(obj.widgets) ? obj.widgets : [];
  const widgets: DescriptorWidget[] = widgetsRaw.map((w): DescriptorWidget => {
    const kind = isWidgetKind(w?.kind) ? w.kind : 'other';
    const count = Number.isFinite(w?.count) && w.count >= 1 ? Math.floor(w.count) : 1;
    const proposedName = (kind === 'other' && typeof w?.proposedName === 'string'
      && /^[a-z][a-zA-Z0-9]*$/.test(w.proposedName)) ? w.proposedName.slice(0, 40) : undefined;
    const out: DescriptorWidget = { kind, count, fingerprint: widgetFingerprint(kind, proposedName) };
    // proposedName only valid (per schema) when kind is 'other'.
    if (proposedName) out.proposedName = proposedName;
    return out;
  });

  const proposalsRaw: any[] = Array.isArray(obj.proposals) ? obj.proposals : [];
  const proposals: DescriptorProposal[] = proposalsRaw
    .filter(p => typeof p?.proposedName === 'string' && /^[a-z][a-zA-Z0-9]*$/.test(p.proposedName))
    .map((p): DescriptorProposal => {
      // A proposal's fingerprint anchors to the widget that motivated it (same
      // proposedName) so the Reduce step can match proposals cross-frame.
      const match = widgets.find(w => w.proposedName === p.proposedName);
      return {
        proposedName: String(p.proposedName).slice(0, 40),
        fingerprint: match?.fingerprint || frameFp,
        example: String(p.example ?? '').slice(0, 120),
      };
    });

  const sectionsRaw: any[] = Array.isArray(obj.sections) ? obj.sections : [];
  const sections = sectionsRaw
    .map(s => ({ kind: s?.kind, brief: String(s?.brief ?? '').slice(0, 120) }))
    .filter(s => typeof s.kind === 'string');

  const role = typeof obj.role === 'string' ? obj.role : 'screen';
  const semanticName = (typeof obj.semanticName === 'string' && obj.semanticName.trim())
    ? obj.semanticName.trim().slice(0, 80) : 'screen';

  const descriptor: FrameDescriptor = {
    frameId,                              // always the real frame id (never trust the model's)
    role: role as FrameDescriptor['role'],
    semanticName,
    sections: sections as FrameDescriptor['sections'],
    widgets,
    fingerprint: frameFp,                 // server-authoritative
    proposals,
  };
  if (role === 'modal' || role === 'sheet') {
    const g = obj.isModalGuess;
    descriptor.isModalGuess = {
      ...(typeof g?.base === 'string' ? { base: g.base.slice(0, 80) } : {}),
      ...(typeof g?.trigger === 'string' ? { trigger: g.trigger.slice(0, 120) } : {}),
    };
  }
  return descriptor;
}

function buildPrompt(input: DescribeFrameInput, tree: string, refRelPath: string | null): string {
  const dims = (input.width && input.height) ? ` (${input.width}×${input.height})` : '';
  return [
    `You are a UI design ANALYST. Classify ONE app frame into a controlled descriptor.`,
    `Describe the DESIGN itself — independent of any UI framework (Flutter/React/etc.).`,
    ``,
    lexiconForPrompt(),
    ``,
    refRelPath
      ? `REFERENCE IMAGE (the rendered frame — open it with your file-reading tool; this is the ground truth for what the frame LOOKS like): ${refRelPath}`
      : `(No reference image available — classify from the IR tree alone.)`,
    ``,
    `FRAME: id="${input.frameId}"${input.frameName ? ` name="${input.frameName}"` : ''}${dims}`,
    `IR TREE (structure + content; node kinds are container/text/icon/illustration/image/group/…):`,
    '```',
    tree.slice(0, 24000),     // bounded: one frame per call
    '```',
    ``,
    `Classify the frame's role, give it a camelCase semanticName, list its major sections`,
    `(top→bottom) by sectionKind, and list its distinct widgets by widgetKind with a count.`,
    `If the reference shows a dimmed/translucent backdrop with a dialog or sheet on top,`,
    `the role is "modal" or "sheet" and you should fill isModalGuess.`,
    `Do NOT write or edit any files.`,
    ``,
    schemaForPrompt(),
  ].filter(Boolean).join('\n');
}

/**
 * Describe ONE frame → a schema-valid FrameDescriptor. The bounded context is this
 * single frame, so callers can parallelize across frames later.
 *
 * Throws if the project can't be resolved or the IR tree is empty (no structure to
 * fingerprint or describe). A model that returns an invalid descriptor is NOT fatal
 * here — we still server-fill + coerce to a schema-valid descriptor and re-validate;
 * a hard validation failure after coercion throws with the raw text for debugging.
 */
export async function describeFrame(
  projectId: string,
  figStorageKey: string,
  frame: DescribeFrameInput,
  opts: {
    provider?: AIModel; modelId?: string; harnessBaseUrl?: string; scale?: number; runId?: string;
    /** T28: skip the cache (force a fresh describe + overwrite the entry). */
    force?: boolean;
    /** T28: pre-loaded cache file (the orchestrator loads it ONCE for the whole fan-out
     *  so each frame doesn't re-read the JSON). Omit → describeFrame loads it itself. */
    cache?: Awaited<ReturnType<typeof readDescriptorCache>>;
  } = {},
): Promise<DescribeResult> {
  const root = resolveProjectRoot(projectId);
  if (!root || !fsSync.existsSync(root)) throw new Error(`describeFrame: project not found: ${projectId}`);

  // 1. PREP — IR tree (the fingerprint + description source) + a reference render.
  const tree = await getNodeTree(figStorageKey, frame.frameId);
  if (!tree.trim()) throw new Error(`describeFrame: empty IR tree for frame ${frame.frameId}`);

  const frameFp = frameFingerprint(tree);
  const groups = widgetGroups(tree);

  // T28 CACHE LOOKUP — if this frame was already described AND its structure is
  // unchanged (fingerprint match), REUSE the persisted descriptor and SKIP the AI
  // call. This is the resume-cost fix: a re-run/resume re-describes only new/changed
  // frames instead of all of them from scratch. `force` bypasses the cache.
  if (!opts.force) {
    const cache = opts.cache ?? (await readDescriptorCache(root));
    const hit = lookupDescriptor(cache, frame.frameId, frameFp);
    if (hit) {
      return { descriptor: hit, fingerprint: frameFp, rendered: false, raw: '', cached: true };
    }
  }

  // Reference render (best-effort): write into .uix/canon-refs so the agent can open
  // it by a project-relative path (same convention the verify loop uses).
  let refRelPath: string | null = null;
  let rendered = false;
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 2;
  if (frame.width && frame.height) {
    try {
      const ref = await renderFrameReference({
        harnessBaseUrl: opts.harnessBaseUrl,
        figStorageKey, frameId: frame.frameId, scale,
        width: frame.width, height: frame.height,
      });
      if (ref) {
        const rel = path.join('.uix', 'canon-refs', `${frame.frameId.replace(/[^a-zA-Z0-9]+/g, '_')}.png`);
        const abs = path.join(root, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, ref.png);
        refRelPath = rel;
        rendered = true;
      }
    } catch { /* reference is best-effort — fall back to IR-only classification */ }
  }

  // 2. ASK — one bounded agent call. agent:true so the CLI can open the image file.
  // AI-PURPOSE (Phase 1a describe): the model IS the step. requireModel logs the
  // call + THROWS AiNotFiredError on no-fire/empty (RFC §0.1/§0.2) so a frame
  // that fails to describe aborts loud rather than emitting a stub descriptor.
  const env = createTerminalEnv(resolveWorkspace());
  const prompt = buildPrompt(frame, tree, refRelPath);
  // Provider respects the RUN's selected model (claude/codex/gemini) — a codex/gemini
  // run must NOT silently hard-depend on claude (RFC §0.1). Default 'claude' when
  // unset so existing callers are unchanged.
  const { text } = await requireModel(opts.provider ?? 'claude', prompt, env, root, {
    agent: true, modelId: opts.modelId ?? 'sonnet',
    log: { projectId, runId: opts.runId, step: 'canon.describe' },
  });

  // 3. NORMALIZE (server-fill fingerprints) + VALIDATE.
  const parsed = extractJson(text);
  const descriptor = normalizeDescriptor(parsed, frame.frameId, frameFp, groups);
  const result = _validator.validate(descriptor as unknown as Record<string, unknown>);
  if (!result.valid) {
    const errs = result.errors.map(e => `${e.instanceLocation}: ${e.error}`).join('; ');
    throw new Error(`describeFrame: descriptor failed schema validation for ${frame.frameId}: ${errs}\nraw: ${text.slice(0, 800)}`);
  }
  // T28 CACHE WRITE — persist the validated descriptor keyed by frameId + fingerprint
  // so a later run/resume reuses it. Best-effort (never breaks the build).
  await putDescriptor(root, frame.frameId, frameFp, descriptor);
  return { descriptor, fingerprint: frameFp, rendered, raw: text, cached: false };
}
