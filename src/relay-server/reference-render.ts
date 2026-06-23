// =============================================================================
// File: src/relay-server/reference-render.ts
//
// SERVER-SIDE screen PREP. Everything the client used to do in the browser to
// stage a screen for an agent build — fetch the IR, render the pixel-accurate
// reference, localize the frame's assets, assemble the agent packet — now runs
// here, cached per-frame.
//
// The reference RENDER is produced by a separate headless harness page (built by
// relay-web) that we serve + screenshot. CONTRACT:
//   {harnessBaseUrl}/render-harness.html?fig={figStorageKey}&frame={frameId}
//     &scale=2&base={uixBaseUrl}
// renders the frame to a full-page canvas and is screenshot-ready once loaded.
// We serve relay-web's built `render-harness` dir (HARNESS_DIR) ONCE and capture
// it with the shared Chrome primitive in visual-routes.
// =============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot } from './runtime';
import { captureUrlScreenshot, serveDir } from './visual-routes';
import { buildAgentPacket, type FigFrame, type FlowGraph } from './agent-packet';
import type { ScreenSpec } from './build-run-store';
import { emitResources, canEmitResources } from './resources-emit';
import { renameAssetsSemantic } from './asset-naming';
import type { AIModel } from './ai-adapters';

// ── env knobs ─────────────────────────────────────────────────────────────────
// UIX base — where the IR / svg-assets / asset bytes live. Configurable so a
// staging UIX can be targeted; defaults to production.
export const UIX_BASE_URL = (process.env.UIX_BASE_URL || 'https://uix-production.up.railway.app').replace(/\/+$/, '');
// The built render-harness dir (relay-web's vite build output). Defaults to the
// relay-web dist; override when the harness builds elsewhere.
const HARNESS_DIR = process.env.HARNESS_DIR || '/workspace/projects/relay-web/dist';
// Bumped when the prep contract changes so a stale cache entry is invalidated.
const HARNESS_VERSION = process.env.HARNESS_VERSION || 'v1';

const FRAMEWORK_LABELS: Record<string, string> = {
  flutter: 'Flutter (Dart)',
  react: 'React (Vite + TS)',
  next: 'Next.js (App Router)',
};
export const frameworkLabel = (fw: string): string => FRAMEWORK_LABELS[fw] ?? fw;

// ── UIX fetch helpers (global fetch; mirror relay-web/src/lib/uixApi.ts) ───────

/** Normalize a UIX-emitted asset URL: the server may build it with a localhost
 *  API_BASE_URL when the env var is missing on Railway. Strip the origin and
 *  reattach UIX_BASE_URL so asset bytes always download. */
function toAbsoluteAssetUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const apiBase = new URL(UIX_BASE_URL);
    if (parsed.hostname !== apiBase.hostname) {
      parsed.hostname = apiBase.hostname;
      parsed.port = apiBase.port;
      parsed.protocol = apiBase.protocol;
    }
    return parsed.toString();
  } catch {
    return url.startsWith('/') ? `${UIX_BASE_URL}${url}` : url;
  }
}

export interface CompactNode { ih?: string; [k: string]: unknown }
export interface IrData {
  nodes: Record<string, CompactNode>;
  links: Record<string, string[]>;
  frames?: FigFrame[];
}
export interface SvgAsset { nodeId: string; fileName: string; url: string; format?: 'svg' | 'png' }
export interface ExtractedAsset { hash: string; storageKey: string; url: string; format: string; originalName: string; sizeBytes?: number }

/** GET /api/v1/figma/ir/data — the full compact IR (nodes/links/frames). */
export async function getIrData(figStorageKey: string): Promise<IrData | null> {
  try {
    const r = await fetch(`${UIX_BASE_URL}/api/v1/figma/ir/data?figStorageKey=${encodeURIComponent(figStorageKey)}`);
    if (!r.ok) return null;
    const d = await r.json() as IrData;
    return d && d.nodes ? d : null;
  } catch { return null; }
}

/** POST /api/v1/figma/ir { figStorageKey, nodeId } — one frame's IR tree notation. */
export async function getNodeTree(figStorageKey: string, nodeId: string): Promise<string> {
  try {
    const r = await fetch(`${UIX_BASE_URL}/api/v1/figma/ir`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figStorageKey, nodeId }),
    });
    if (!r.ok) return '';
    const d = await r.json() as { tree?: string };
    return d.tree ?? '';
  } catch { return ''; }
}

/** GET /api/v1/figma/svg-assets/:key?nodeId= — icon/illustration manifest for a frame. */
export async function getSvgAssets(figStorageKey: string, nodeId?: string): Promise<SvgAsset[]> {
  try {
    const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
    const r = await fetch(`${UIX_BASE_URL}/api/v1/figma/svg-assets/${encodeURIComponent(figStorageKey)}${q}`);
    if (!r.ok) return [];
    const d = await r.json() as { assets?: SvgAsset[] };
    return (d.assets ?? []).map(a => ({ ...a, url: toAbsoluteAssetUrl(a.url) }));
  } catch { return []; }
}

/** GET /api/v1/figma/uploads — find the upload record for a figStorageKey, returning
 *  its raster image-fill assets (the client gets these from the upload payload). */
export async function getUploadAssets(figStorageKey: string): Promise<ExtractedAsset[]> {
  try {
    const r = await fetch(`${UIX_BASE_URL}/api/v1/figma/uploads`);
    if (!r.ok) return [];
    const d = await r.json() as { uploads?: Array<{ figStorageKey?: string; assets?: ExtractedAsset[] }> };
    const rec = (d.uploads ?? []).find(u => u.figStorageKey === figStorageKey);
    return (rec?.assets ?? []).map(a => ({ ...a, url: toAbsoluteAssetUrl(a.url) }));
  } catch { return []; }
}

/** POST /api/v1/figma/ir/complete + poll status — fill external/library component
 *  gaps from the Figma design URL (REST file JSON). No-op when no URL is given. */
export async function ensureIrComplete(
  figStorageKey: string, figmaUrl: string, onStatus?: (s: string) => void, timeoutMs = 180_000,
): Promise<void> {
  try {
    await fetch(`${UIX_BASE_URL}/api/v1/figma/ir/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figStorageKey, figmaUrl }),
    });
  } catch { return; }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let status = 'running';
    try {
      const r = await fetch(`${UIX_BASE_URL}/api/v1/figma/ir/complete/status?figStorageKey=${encodeURIComponent(figStorageKey)}`);
      const d = r.ok ? await r.json() as { status?: string } : { status: 'absent' };
      status = d.status ?? 'absent';
    } catch { /* transient — keep polling */ }
    onStatus?.(status);
    if (status === 'done' || status === 'error' || status === 'absent') return;
    await new Promise(res => setTimeout(res, 2500));
  }
}

// ── harness server singleton ──────────────────────────────────────────────────
// serveDir the built render-harness ONCE and reuse the handle for every render.
let _harnessServer: Promise<{ url: string; close: () => void } | null> | null = null;
export function getHarnessServer(): Promise<{ url: string; close: () => void } | null> {
  if (_harnessServer) return _harnessServer;
  _harnessServer = (async () => {
    if (!fsSync.existsSync(HARNESS_DIR)) return null;
    try { return await serveDir(HARNESS_DIR); }
    catch { return null; }
  })();
  return _harnessServer;
}
/** The harness origin (served base, sans the trailing /index.html). */
async function harnessOrigin(): Promise<string | null> {
  const srv = await getHarnessServer();
  return srv ? srv.url.replace(/\/index\.html$/, '') : null;
}

// ── PNG IHDR dimensions (no native dep) ────────────────────────────────────────
// A PNG is 8-byte signature + IHDR chunk; width/height are the first two 32-bit
// big-endian ints of the IHDR data (bytes 16..23).
function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ── render reliability knobs (T16) ─────────────────────────────────────────────
// Per-render screenshot timeout. The harness fetches resolved IR + assets cross-
// origin from UIX inside the page and draws to CanvasKit; under load a cold-Chrome
// launch + that fetch can exceed the old 30s and return null (a transient miss the
// caller then treats as a silent "packet-only" degrade). 60s gives a slow-but-OK
// render room to finish.
const RENDER_SCREENSHOT_TIMEOUT_MS = Number(process.env.RELAY_RENDER_TIMEOUT_MS) > 0
  ? Number(process.env.RELAY_RENDER_TIMEOUT_MS) : 60_000;
// In-page time budget for the harness to fetch IR/assets + paint before the shot.
// Raised from 8s so a complex frame finishes drawing rather than being captured
// blank/partial.
const RENDER_VIRTUAL_TIME_BUDGET_MS = Number(process.env.RELAY_RENDER_VTB_MS) > 0
  ? Number(process.env.RELAY_RENDER_VTB_MS) : 15_000;
// How many ATTEMPTS a single frame render gets (1 try + N-1 retries). A transient
// timeout/contention should self-heal rather than degrade to packet-only.
const RENDER_MAX_ATTEMPTS = Number(process.env.RELAY_RENDER_ATTEMPTS) > 0
  ? Number(process.env.RELAY_RENDER_ATTEMPTS) : 3;
// Concurrency cap for the SCREENSHOT step only. The prep loop renders frames with
// POOL=3, and three cold-Chrome launches contending with cross-origin UIX fetches
// is exactly what pushed some renders over the timeout. A semaphore of 1 serializes
// the heavy headless-Chrome launch while leaving the rest of prep (asset
// localization etc.) parallel. Override via env if a render box has headroom.
const RENDER_CONCURRENCY = Number(process.env.RELAY_RENDER_CONCURRENCY) > 0
  ? Number(process.env.RELAY_RENDER_CONCURRENCY) : 1;

/** Minimal FIFO semaphore: at most N holders run concurrently; the rest queue. */
function makeSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally { release(); }
  };
}
// Module-singleton: every renderFrameReference / renderNodeReference screenshot in
// this process funnels through ONE semaphore so concurrent prep workers can't launch
// more than RENDER_CONCURRENCY cold Chromes at once.
const renderSem = makeSemaphore(RENDER_CONCURRENCY);
// Exposed for tests/tracing: the configured render concurrency cap.
export const renderConcurrencyLimit = RENDER_CONCURRENCY;
const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

/**
 * Render ONE frame to a reference PNG via the headless harness. Serves nothing
 * here (the harness server is the module singleton); just screenshots the harness
 * page at the matched device-scale and full height. Returns the PNG + its actual
 * pixel dimensions (read from the IHDR).
 *
 * `null` means the HARNESS IS ABSENT (no relay-web/dist, no Chrome) — that is the
 * "no harness" condition the caller reports as packet-only-by-design. A transient
 * render FAILURE (timeout/crash) does NOT return null silently: the screenshot is
 * retried RENDER_MAX_ATTEMPTS times behind the render semaphore, and only if EVERY
 * attempt fails does this return null with `failed:true` set on the result-less
 * path — distinguishable via the second overload below.
 */
export async function renderFrameReference(args: {
  harnessBaseUrl?: string;
  figStorageKey: string;
  frameId: string;
  scale: number;
  width: number;
  height: number;
}): Promise<{ png: Buffer; widthPx: number; heightPx: number } | null> {
  const r = await renderFrameReferenceEx(args);
  return r.png ? { png: r.png, widthPx: r.widthPx!, heightPx: r.heightPx! } : null;
}

/** Outcome of a frame render attempt, distinguishing the three states the caller
 *  must NOT collapse into one (RFC §0.1 — no silent degrade):
 *   - ok       → a PNG was produced.
 *   - no-harness → the harness/Chrome is absent (packet-only is expected here).
 *   - failed   → the harness exists but every render attempt failed (LOUD degrade). */
export type RenderOutcome =
  | { status: 'ok'; png: Buffer; widthPx: number; heightPx: number; attempts: number }
  | { status: 'no-harness'; png: null; attempts: 0 }
  | { status: 'failed'; png: null; attempts: number };

/** Internal wrapper carrying the explicit outcome; renderFrameReference adapts it to
 *  the legacy nullable shape so existing callers are unchanged. */
async function renderFrameReferenceEx(args: {
  harnessBaseUrl?: string;
  figStorageKey: string;
  frameId: string;
  scale: number;
  width: number;
  height: number;
}): Promise<{ png: Buffer | null; widthPx?: number; heightPx?: number; outcome: RenderOutcome }> {
  const base = args.harnessBaseUrl ?? await harnessOrigin();
  if (!base) return { png: null, outcome: { status: 'no-harness', png: null, attempts: 0 } };
  const url = `${base.replace(/\/+$/, '')}/render-harness.html`
    + `?fig=${encodeURIComponent(args.figStorageKey)}`
    + `&frame=${encodeURIComponent(args.frameId)}`
    + `&scale=${args.scale}`
    + `&base=${encodeURIComponent(UIX_BASE_URL)}`;
  // The harness draws the frame to a canvas whose backing size is ALREADY the device
  // pixels (fw*scale × fh*scale) and that canvas IS the page. So capture the window at
  // those device pixels at scale 1 (NOT scale=args.scale + fullPage, which forces a
  // ≥4000px window and yields an 8000px blank-below canvas). window = W×H, 1:1.
  const dw = Math.round(args.width * args.scale), dh = Math.round(args.height * args.scale);
  // RETRY behind the render semaphore: a transient timeout/contention self-heals
  // rather than degrading to a weaker packet-only reference.
  let png: Buffer | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= RENDER_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    png = await renderSem(() => captureUrlScreenshot(url, dw, dh, RENDER_SCREENSHOT_TIMEOUT_MS, {
      deviceScale: 1, fullPage: false, disableWebSecurity: true,
      virtualTimeBudgetMs: RENDER_VIRTUAL_TIME_BUDGET_MS,
    }));
    if (png) break;
    // short backoff between attempts to let transient contention clear.
    if (attempt < RENDER_MAX_ATTEMPTS) await sleep(500 * attempt);
  }
  if (!png) return { png: null, outcome: { status: 'failed', png: null, attempts } };
  const dims = pngDimensions(png);
  const widthPx = dims?.width ?? Math.round(args.width * args.scale);
  const heightPx = dims?.height ?? Math.round(args.height * args.scale);
  return { png, widthPx, heightPx, outcome: { status: 'ok', png, widthPx, heightPx, attempts } };
}

/** Render a frame returning the EXPLICIT outcome (ok / no-harness / failed) so the
 *  prep path can tell a transient render failure from an absent harness and surface
 *  it loudly (RFC §0.1). Wraps renderFrameReferenceEx. */
export async function renderFrameReferenceOutcome(args: {
  harnessBaseUrl?: string;
  figStorageKey: string;
  frameId: string;
  scale: number;
  width: number;
  height: number;
}): Promise<RenderOutcome> {
  return (await renderFrameReferenceEx(args)).outcome;
}

/**
 * Render ONE node's subtree to a cropped PNG via the headless harness's
 * node-scoped mode (`?node=<id>`). Used to re-rasterize a single asset node with
 * the AUTHORITATIVE CanvasKit renderer when UIX's @grida/refig raster is broken
 * (e.g. the netflix image-fill nodes that come back as a green fragment). The
 * harness clears TRANSPARENT and crops to the node's own bbox.
 *
 * `frameId` is the node's containing frame — still required so the harness loads
 * that frame's fonts/images/IR context before drawing the single node.
 */
export async function renderNodeReference(args: {
  harnessBaseUrl?: string;
  figStorageKey: string;
  frameId: string;
  nodeId: string;
  width: number;   // node bb width (logical px)
  height: number;  // node bb height (logical px)
  scale?: number;
}): Promise<{ png: Buffer; widthPx: number; heightPx: number } | null> {
  const base = args.harnessBaseUrl ?? await harnessOrigin();
  if (!base) return null;
  // Small assets get a higher scale so the rasterized icon stays crisp; clamp so a
  // large illustration node can't produce an enormous capture window.
  const scale = args.scale && args.scale > 0 ? args.scale : 4;
  const url = `${base.replace(/\/+$/, '')}/render-harness.html`
    + `?fig=${encodeURIComponent(args.figStorageKey)}`
    + `&frame=${encodeURIComponent(args.frameId)}`
    + `&node=${encodeURIComponent(args.nodeId)}`
    + `&scale=${scale}`
    + `&base=${encodeURIComponent(UIX_BASE_URL)}`;
  const dw = Math.max(1, Math.round(args.width * scale));
  const dh = Math.max(1, Math.round(args.height * scale));
  // Funnel through the SAME render semaphore as frame renders so node re-rasterizes
  // (raster-repair) can't add extra concurrent cold-Chrome launches alongside the
  // frame renders. Same bumped timeout + in-page budget.
  const png = await renderSem(() => captureUrlScreenshot(url, dw, dh, RENDER_SCREENSHOT_TIMEOUT_MS, {
    deviceScale: 1, fullPage: false, disableWebSecurity: true,
    virtualTimeBudgetMs: RENDER_VIRTUAL_TIME_BUDGET_MS,
  }));
  if (!png) return null;
  const dims = pngDimensions(png);
  return { png, widthPx: dims?.width ?? dw, heightPx: dims?.height ?? dh };
}

// ── asset localization (port of useGeneration.localizeAssetsOnce) ──────────────
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';

/**
 * Localize ONLY the assets the frame's subtree references — its raster image fills
 * (by `ih` hash) + its SVG icons/illustrations — into <projectRoot>/assets/icons
 * (svg) and assets/images (raster), so the IR notation's assets/... references
 * resolve. `seen` dedupes across a whole-app batch (screens share most assets).
 * Returns the number of assets written this call, and the dir-relative paths
 * written (so prepScreen can replay them on a cache hit).
 */
/** One localized asset, recorded so the resources file + semantic-rename pass can
 *  reference it. `kind` distinguishes valid SVG icons (kept as-is) from rasters,
 *  and `repaired` flags an asset re-rasterized via the harness (broken UIX raster). */
export interface LocalizedAsset {
  /** dir-relative project path, e.g. `assets/icons/vector_290_4399.svg`. */
  relPath: string;
  /** the asset's source IR node id (when known) — feeds semantic naming. */
  nodeId?: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
  /** true when the PNG was re-rasterized via the harness (UIX raster was broken). */
  repaired?: boolean;
}

/** A PNG smaller than this many bytes is treated as suspect (a broken @grida/refig
 *  raster like the netflix green-fragment is ~900 bytes; valid asset rasters are
 *  multi-KB). Combined with: any svg-asset flagged format:'png' is harness-rendered. */
const SUSPECT_PNG_BYTES = 1500;

// ── composite-illustration detection (T19) ─────────────────────────────────────
// The UIX SVG synthesizer flattens a multi-element illustration (e.g. the Ping
// `e_walletpana` welcome hero — a man, phone w/ bank-card UI, coins, cart…) into a
// BROKEN FRAGMENT. The CanvasKit harness renders the same node correctly, so a
// large/composite vector is routed to `renderNodeReference` (PNG) while small,
// simple icons stay SVG (the user is adamant SVGs stay SVG where they extract
// correctly). Conservative: only genuinely large illustrations rasterize.
//
// A vector is an ILLUSTRATION (→ rasterize) when its largest dimension is at least
// this many logical px. An app icon is ~16–48px; a hero illustration is hundreds.
// 160 sits well above the largest icons and well below any real illustration.
const ILLUSTRATION_MIN_DIM = 160;

/** Largest dimension (logical px) from an SVG's viewBox / width|height attrs, or 0
 *  when neither is parseable. Used as the fallback signal when IR bb is missing. */
function svgMaxDimension(svg: string): number {
  const head = svg.slice(0, 2000);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  if (vb) return Math.max(parseFloat(vb[1]), parseFloat(vb[2]));
  const w = /\bwidth\s*=\s*["']\s*([\d.]+)/i.exec(head);
  const h = /\bheight\s*=\s*["']\s*([\d.]+)/i.exec(head);
  if (w || h) return Math.max(w ? parseFloat(w[1]) : 0, h ? parseFloat(h[1]) : 0);
  return 0;
}

/** SVG features the UIX synth handles poorly — a vector using them is treated as a
 *  composite illustration even at moderate size (defensive, not the primary gate). */
function svgHasComplexPaint(svg: string): boolean {
  return /<(linearGradient|radialGradient|mask|filter|image|pattern)\b/i.test(svg);
}

// ── broken-SMALL-icon detection (T30) ──────────────────────────────────────────
// T19 only rasterizes LARGE (≥160px) illustrations. But the SMALL functional icons
// in the Ping app (biometric / NIN / scan — iconscan, fi_2, scan) ship BROKEN: they
// are external-component INSTANCES of COMPOSITE icons and the UIX SVG synthesizer
// drops / mis-positions sub-paths (e.g. iconscan's 24×24 viewBox holds a glyph whose
// coords run only 0–5.75 and dip to −0.75 — a tiny, partly-clipped fragment). The
// build AI then sees a broken glyph and improvises a substitute → asset defect.
//
// The CanvasKit harness renders these icons CORRECTLY, so a SMALL icon that LOOKS
// broken (or is an external-component instance with non-trivial geometry) is routed
// to renderNodeReference (PNG) too — NOT only ≥160px illustrations. We stay
// conservative: a genuinely-simple, well-formed single/two-path icon (a clean
// chevron / arrow / ellipse) is KEPT as SVG even when it is an instance.

/** An external-component INSTANCE node id carries Figma's instance notation
 *  `I<masterPath>;<masterId>` — an `I` prefix and at least one `;` (e.g.
 *  `I313:10170;3614:45`). These are the prime offenders for the broken composite
 *  icons, so an instance with non-trivial geometry is rasterized. */
function isComponentInstanceId(nodeId: string | undefined): boolean {
  return !!nodeId && nodeId.startsWith('I') && nodeId.includes(';');
}

/** Breakage signals for a synthesized icon SVG. Parses the viewBox and the union of
 *  all `<path d="…">` coordinates and flags the synth-failure patterns seen on the
 *  Ping icons:
 *   - pathCount      number of <path> elements (composite when many).
 *   - clean          parseable + has drawable coords (not an empty wrapper).
 *   - broken         a breakage pattern fired (see `reason`).
 *  Conservative thresholds (ratios are relative to the largest viewBox dimension):
 *   - neg-coords  : content dips > 20% below the box AND > 1px absolute  → mis-placed
 *                   (scan: min −6 on a 22px box; check_circle: −15 on 22px). A clean
 *                   chevron's −0.8px stroke bleed (ratio ~0.1) does NOT trip this.
 *   - over-coords : content overshoots the box by > 20%                  → mis-placed
 *   - composite   : ≥ 6 sub-paths whose union fills < 60% of the box     → fragment
 *                   (fi_2: 12 paths filling 49%; lock/id_card; …).
 *   - tiny        : ≥ 2 sub-paths whose union fills < 40% of the box     → clipped
 *                   fragment (iconscan: 4 paths filling 27%).
 *   - g-transform : ≥ 2 `<g transform=…>` groups                         → composite. */
interface IconSvgSignals { pathCount: number; clean: boolean; broken: boolean; reason: string }
function analyzeIconSvg(svg: string): IconSvgSignals {
  const head = svg.slice(0, 4000);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  const maxDim = vb ? Math.max(parseFloat(vb[1]), parseFloat(vb[2])) : 0;
  // All <path d="…"> bodies (cap the scan so a giant illustration can't blow up regex).
  const dBodies = [...svg.slice(0, 60000).matchAll(/\bd\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const pathCount = dBodies.length;
  const gTransforms = (svg.match(/<g[^>]*\btransform\s*=/gi) ?? []).length;
  // No parseable viewBox or no drawable path → not a coordinate-breakage candidate
  // (empty <circle>/<rect>/<ellipse> wrappers are clean and stay SVG).
  if (!(maxDim > 0) || pathCount === 0) {
    return { pathCount, clean: pathCount > 0, broken: false, reason: 'no-coords' };
  }
  let min = Infinity, max = -Infinity;
  for (const d of dBodies) {
    // T30: CONSUME scientific notation. A valid near-zero coord like `1.77636e-15`
    // is ONE number — without the exponent group the regex split it into mantissa
    // `1.77636` + a phantom `-15`, which tripped a FALSE `neg-coords` and wrongly
    // rasterized clean single-path icons (check_circle/scan/vector_290_4337). parseFloat
    // reads the whole `…e-15` and yields its real (≈0) magnitude.
    const nums = d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi);
    if (!nums) continue;
    for (const ns of nums) { const v = parseFloat(ns); if (!Number.isFinite(v)) continue; if (v < min) min = v; if (v > max) max = v; }
  }
  if (!isFinite(min) || !isFinite(max)) {
    return { pathCount, clean: true, broken: false, reason: 'no-coords' };
  }
  const negRatio = -min / maxDim;
  const overRatio = (max - maxDim) / maxDim;
  const extentRatio = (max - min) / maxDim;
  if (negRatio > 0.20 && min < -1) return { pathCount, clean: true, broken: true, reason: `neg-coords(${min.toFixed(1)})` };
  if (overRatio > 0.20 && max > maxDim + 1) return { pathCount, clean: true, broken: true, reason: `over-coords(${max.toFixed(1)})` };
  if (pathCount >= 6 && extentRatio < 0.60) return { pathCount, clean: true, broken: true, reason: `composite(${pathCount},${extentRatio.toFixed(2)})` };
  if (pathCount >= 2 && extentRatio < 0.40) return { pathCount, clean: true, broken: true, reason: `tiny-content(${pathCount},${extentRatio.toFixed(2)})` };
  if (gTransforms >= 2) return { pathCount, clean: true, broken: true, reason: `g-transforms(${gTransforms})` };
  return { pathCount, clean: true, broken: false, reason: `simple(${pathCount})` };
}

export async function localizeFrameAssets(
  projectId: string,
  figStorageKey: string,
  frameId: string,
  irData: IrData | null,
  seen: Set<string>,
  opts: { harnessBaseUrl?: string } = {},
): Promise<{ count: number; written: string[]; assets: LocalizedAsset[] }> {
  const root = resolveProjectRoot(projectId);
  if (!root) return { count: 0, written: [], assets: [] };
  const written: string[] = [];
  const assets: LocalizedAsset[] = [];

  const writeBytes = async (dir: string, name: string, bytes: Buffer): Promise<void> => {
    const abs = path.join(root, dir, name);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  };
  const upload = async (
    url: string, dir: string, name: string,
    meta: { nodeId?: string; format: 'svg' | 'png'; kind: 'icon' | 'image' },
  ): Promise<void> => {
    const key = `${dir}/${name}`;
    if (seen.has(key)) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeBytes(dir, name, bytes);
    seen.add(key);
    written.push(key);
    assets.push({ relPath: key, nodeId: meta.nodeId, format: meta.format, kind: meta.kind });
  };

  /**
   * RASTER REPAIR. A raster asset whose fetched bytes are suspect (tiny/broken) is
   * re-rasterized via the harness's node-scoped render — the authoritative
   * CanvasKit path — instead of trusting UIX's @grida/refig output. The png
   * svg-assets are ALWAYS harness-rendered (UIX rasterizes them with the broken
   * renderer); upload image-fills are only repaired when their bytes look broken.
   */
  const repairRaster = async (
    nodeId: string, dir: string, name: string, fallbackUrl: string,
  ): Promise<void> => {
    const key = `${dir}/${name}`;
    if (seen.has(key)) return;
    const n = irData?.nodes?.[nodeId];
    const bb = n?.bb as { w?: number; h?: number } | undefined;
    let bytes: Buffer | null = null;
    if (bb && (bb.w ?? 0) > 0 && (bb.h ?? 0) > 0) {
      const r = await renderNodeReference({
        harnessBaseUrl: opts.harnessBaseUrl, figStorageKey, frameId, nodeId,
        width: bb.w!, height: bb.h!,
      });
      // Trust ANY successful harness render: a valid PNG with real dimensions is
      // authoritative even when it's only a few hundred bytes (a simple icon).
      // Do NOT gate on byte size here — a correct small icon (e.g. the Netflix
      // logo at ~800B) is smaller than the broken UIX raster, so a size gate
      // would wrongly reject it and fall back to the garbage.
      if (r && r.png.length > 67 && r.widthPx > 0 && r.heightPx > 0) bytes = r.png;
    }
    let repaired = true;
    if (!bytes) {
      // Harness unavailable (no Chrome / no dist) — fall back to the UIX raster so
      // the asset is at least present; mark it not-repaired.
      const res = await fetch(fallbackUrl);
      if (!res.ok) throw new Error(`fetch ${fallbackUrl} ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
      repaired = false;
    }
    await writeBytes(dir, name, bytes);
    seen.add(key);
    written.push(key);
    assets.push({ relPath: key, nodeId, format: 'png', kind: dir.endsWith('icons') ? 'icon' : 'image', repaired });
  };

  // Walk the frame's subtree to collect the image-fill hashes it actually uses.
  const usedHashes = new Set<string>();
  if (irData?.nodes && irData?.links) {
    const stack = [frameId];
    const visited = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const n = irData.nodes[id];
      if (n?.ih) usedHashes.add(n.ih);
      for (const c of (irData.links[id] ?? [])) stack.push(c);
    }
  }

  const tasks: Array<() => Promise<void>> = [];
  // 1. Raster image fills referenced by THIS frame. Fetch first; repair via harness
  //    only when the bytes look broken (most photo fills are fine).
  const uploadAssets = await getUploadAssets(figStorageKey);
  for (const a of uploadAssets) {
    if (/svg/i.test(a.format)) continue;
    if (!usedHashes.has(a.hash)) continue;
    let name = safeName(a.originalName || `${a.hash}.${a.format || 'png'}`);
    if (!/\.[a-z0-9]+$/i.test(name)) name += `.${a.format || 'png'}`;
    const suspect = typeof a.sizeBytes === 'number' && a.sizeBytes > 0 && a.sizeBytes < SUSPECT_PNG_BYTES;
    if (suspect) {
      // Find a node carrying this hash so the harness can render it.
      const nodeId = Object.keys(irData?.nodes ?? {}).find(id => irData!.nodes[id]?.ih === a.hash);
      if (nodeId) { tasks.push(() => repairRaster(nodeId, 'assets/images', name, a.url)); continue; }
    }
    tasks.push(() => upload(a.url, 'assets/images', name, { format: 'png', kind: 'image' }));
  }
  // 2. Icon + illustration assets under THIS frame. SIMPLE flat icons come back as
  //    SVG and STAY SVG (they extract correctly — never rasterize). But a COMPOSITE
  //    ILLUSTRATION (large multi-element vector) is flattened into a broken fragment
  //    by the UIX SVG synth, so it's routed to the CanvasKit harness (PNG) instead
  //    (T19). Anything UIX already flagged format:'png' is a broken @grida/refig
  //    raster — also harness-rendered.
  const svgAssets = await getSvgAssets(figStorageKey, frameId);
  // Per-asset raster/SVG decision is logged so the split is auditable.
  const svgDecisions: Array<{ fileName: string; nodeId: string; route: 'raster' | 'svg'; dim: number; reason: string }> = [];
  for (const s of svgAssets) {
    if (s.format === 'png') {
      svgDecisions.push({ fileName: s.fileName, nodeId: s.nodeId, route: 'raster', dim: 0, reason: 'uix-flagged-png' });
      tasks.push(() => repairRaster(s.nodeId, 'assets/images', s.fileName, s.url));
      continue;
    }
    // Decide ILLUSTRATION (→ raster) vs ICON (→ keep SVG). Primary signal: the IR
    // node bbox (already in memory, authoritative). Fallback: the SVG's own
    // viewBox/width-height (fetched once). A vector using gradient/mask/image paint
    // is also treated as an illustration when it is not tiny.
    const bb = irData?.nodes?.[s.nodeId]?.bb as { w?: number; h?: number } | undefined;
    let dim = bb && (bb.w ?? 0) > 0 && (bb.h ?? 0) > 0 ? Math.max(bb.w!, bb.h!) : 0;
    let complexPaint = false;
    let dimSource = dim > 0 ? 'ir-bb' : 'none';
    // T30: a SMALL icon can also be broken (external-component instance of a composite
    // icon whose synthesized SVG is a clipped fragment). To decide that we must look at
    // the SVG bytes, so fetch them for any SMALL vector (below the illustration
    // threshold) too — not only mid-sized ones. A clearly-large illustration still
    // needs no byte check (the dimension gate alone routes it). The bytes are reused by
    // both the T19 complex-paint check and the T30 breakage analysis.
    const instance = isComponentInstanceId(s.nodeId);
    let iconSig: IconSvgSignals | null = null;
    const needBytes = dim === 0 || dim < ILLUSTRATION_MIN_DIM;
    if (needBytes) {
      try {
        const res = await fetch(s.url);
        if (res.ok) {
          const svgText = await res.text();
          complexPaint = svgHasComplexPaint(svgText);
          if (dim === 0) { dim = svgMaxDimension(svgText); dimSource = dim > 0 ? 'svg-viewbox' : 'none'; }
          if (dim < ILLUSTRATION_MIN_DIM) iconSig = analyzeIconSvg(svgText);
        }
      } catch { /* fall through with whatever dim we have */ }
    }
    const isIllustration = dim >= ILLUSTRATION_MIN_DIM || (complexPaint && dim >= ILLUSTRATION_MIN_DIM / 2);
    // T30: a SMALL (non-illustration) icon is BROKEN and must be rasterized when its
    // synthesized SVG shows a breakage signal, OR when it is an external-component
    // INSTANCE with non-trivial geometry (> 2 sub-paths). A genuinely-simple,
    // well-formed icon (a clean 1–2 path chevron / arrow / ellipse) is KEPT as SVG
    // even when it is an instance — we never over-rasterize a clean icon.
    const brokenIcon = !!iconSig && iconSig.broken;
    const instanceComposite = instance && !!iconSig && iconSig.clean && iconSig.pathCount > 2;
    if (isIllustration) {
      const reason = dim >= ILLUSTRATION_MIN_DIM ? `large(${dimSource})` : 'complex-paint';
      svgDecisions.push({ fileName: s.fileName, nodeId: s.nodeId, route: 'raster', dim, reason });
      // Rasterize the composite illustration via the harness; rename to .png so the
      // asset map/resources treat it as a raster image (mirrors repairRaster output).
      const pngName = s.fileName.replace(/\.svg$/i, '') + '.png';
      tasks.push(() => repairRaster(s.nodeId, 'assets/images', pngName, s.url));
    } else if (brokenIcon || instanceComposite) {
      const reason = brokenIcon ? `broken-icon:${iconSig!.reason}` : 'instance-composite';
      svgDecisions.push({ fileName: s.fileName, nodeId: s.nodeId, route: 'raster', dim, reason });
      // Route the broken/composite SMALL icon through the CanvasKit harness too. Keep
      // it under assets/icons (it IS an icon) but as a .png — the harness renders the
      // complete glyph the broken SVG synth dropped.
      const pngName = s.fileName.replace(/\.svg$/i, '') + '.png';
      tasks.push(() => repairRaster(s.nodeId, 'assets/icons', pngName, s.url));
    } else {
      svgDecisions.push({ fileName: s.fileName, nodeId: s.nodeId, route: 'svg', dim, reason: iconSig ? iconSig.reason : 'simple-icon' });
      tasks.push(() => upload(s.url, 'assets/icons', s.fileName, { nodeId: s.nodeId, format: 'svg', kind: 'icon' }));
    }
  }
  if (svgDecisions.length && process.env.RELAY_ASSET_DEBUG) {
    console.log(`[localizeFrameAssets] vector split for frame ${frameId}:`);
    for (const d of svgDecisions) console.log(`  ${d.route.toUpperCase().padEnd(6)} dim=${String(Math.round(d.dim)).padStart(4)} ${d.reason.padEnd(14)} ${d.fileName} (${d.nodeId})`);
  }

  // Bounded concurrency — a big .fig can have 100+ vectors; failures are swallowed
  // so a missing asset never blocks the build. Lower pool than before because
  // harness renders spawn Chrome (heavier than a plain fetch).
  let done = 0;
  const POOL = 4;
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < tasks.length) {
      const t = tasks[idx++];
      try { await t(); done++; } catch { /* skip this asset */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, tasks.length) }, worker));
  return { count: done, written, assets };
}

// ── per-frame PREP cache ───────────────────────────────────────────────────────
const UIX_REFS_DIR = '.uix/refs';
const prepCacheDir = (root: string, hash: string) => path.join(root, '.uix', 'prep-cache', hash);

/** Turn a Figma frame name into a safe file base (mirrors relay-web screenFileBase). */
export function screenFileBase(name: string): string {
  const cleaned = (name || 'Screen')
    .replace(/✏|️/gu, '') // strip pencil glyph + variation selector
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .replace(/\s+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/\s+/g, '');
  const base = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return base || 'Screen';
}

export interface PrepConfig {
  figStorageKey: string;
  framework: string;
  flow: FlowGraph;
  frames: FigFrame[];
  /** All frames already built into this project (forces bootstrapped after #1). */
  bootstrapped: boolean;
  userNotes?: string;
  changeNote?: string;
  scale?: number;
  harnessBaseUrl?: string;
}
export interface PrepResult {
  spec: ScreenSpec;
  /** cache HIT vs a fresh render. */
  cacheHit: boolean;
  assetCount: number;
  rendered: boolean;
  /** When NOT rendered, WHY (RFC §0.1 — distinguish an absent harness from a real
   *  render failure so the latter is surfaced loudly, never as a quiet packet-only):
   *   - 'no-harness' → relay-web/dist or Chrome absent (packet-only is by design).
   *   - 'failed'     → harness exists but every render attempt failed (LOUD degrade).
   *  undefined on a cache HIT (the cached render already proved out) or when rendered. */
  renderFailure?: 'no-harness' | 'failed';
  /** attempts spent on the (failed) render, for logging. */
  renderAttempts?: number;
  /** assets localized for this frame (raster-repaired + svg), for the resources/
   *  semantic-rename pass run once over the whole batch. */
  assets: LocalizedAsset[];
}

interface PrepMeta {
  referenceImagePath: string;
  width: number;
  height: number;
  refWidthPx: number;
  refHeightPx: number;
  assetCount: number;
}

/**
 * Prepare ONE screen's build spec, cached per-frame. The cache key is a sha256 of
 * the inputs that determine the artifacts (tree notation, dims, scale, a packet
 * fingerprint, and the harness version). On HIT we skip render/packet/localize and
 * restore the reference + replay assets from the cache; on MISS we render the
 * reference, build the packet, localize the frame's assets, and persist all of it.
 */
export async function prepScreen(
  projectId: string,
  frame: FigFrame,
  cfg: PrepConfig,
  seen: Set<string>,
): Promise<PrepResult | null> {
  const root = resolveProjectRoot(projectId);
  if (!root || !fsSync.existsSync(root)) return null;
  const scale = cfg.scale && cfg.scale > 0 ? cfg.scale : 2;
  const fwLabel = frameworkLabel(cfg.framework);

  // Fetch IR up-front: the tree feeds both the packet AND the cache key; nodes/
  // links drive asset localization. Done before hashing (the tree is the key input).
  const irData = await getIrData(cfg.figStorageKey);
  const tree = await getNodeTree(cfg.figStorageKey, frame.id);

  // Packet fingerprint: the parts of the packet that are NOT the tree (so the key
  // changes when nav/notes/bootstrap/framework change without re-deriving the
  // whole packet first). Keeps the cache correct across config edits.
  const packetFingerprint = JSON.stringify({
    framework: cfg.framework,
    bootstrapped: cfg.bootstrapped,
    userNotes: cfg.userNotes ?? '',
    changeNote: cfg.changeNote ?? '',
    flow: cfg.flow,
    frameName: frame.name,
  });
  const prepHash = crypto.createHash('sha256').update(JSON.stringify({
    treeNotation: tree, width: frame.width, height: frame.height, scale,
    packetFingerprint, harnessVersion: HARNESS_VERSION,
  })).digest('hex').slice(0, 32);

  const cacheDir = prepCacheDir(root, prepHash);
  const refName = `${screenFileBase(frame.name)}.png`;
  const refRel = path.join(UIX_REFS_DIR, refName);
  const refAbs = path.join(root, refRel);

  // ── CACHE HIT ────────────────────────────────────────────────────────────────
  if (fsSync.existsSync(path.join(cacheDir, 'meta.json'))) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf8')) as PrepMeta;
      const packet = await fs.readFile(path.join(cacheDir, 'packet.txt'), 'utf8');
      const cachedTree = await fs.readFile(path.join(cacheDir, 'tree.txt'), 'utf8').catch(() => tree);
      // Restore the reference render into .uix/refs.
      const cachedRef = path.join(cacheDir, 'ref.png');
      if (fsSync.existsSync(cachedRef)) {
        await fs.mkdir(path.dirname(refAbs), { recursive: true });
        await fs.copyFile(cachedRef, refAbs);
      }
      // Replay assets (dedup-aware): re-fetch + write only assets not already seen
      // this batch. Cheap when the batch shares assets; correct on a fresh project.
      const { count: assetCount, assets } = await localizeFrameAssets(projectId, cfg.figStorageKey, frame.id, irData, seen, { harnessBaseUrl: cfg.harnessBaseUrl });
      const spec: ScreenSpec = {
        packet,
        referenceImagePath: fsSync.existsSync(refAbs) ? refRel : (meta.referenceImagePath || ''),
        tree: cachedTree,
        width: meta.width, height: meta.height,
        refWidthPx: meta.refWidthPx, refHeightPx: meta.refHeightPx,
      };
      return { spec, cacheHit: true, assetCount, rendered: false, assets };
    } catch { /* fall through to a fresh prep on any cache read error */ }
  }

  // ── CACHE MISS ─────────────────────────────────────────────────────────────────
  // 1. Reference render via the harness (retried; outcome is explicit). A failed
  //    render after all retries is NOT silently treated as "no harness" — the caller
  //    surfaces it loudly (RFC §0.1).
  let referenceImagePath = '';
  let refWidthPx = frame.width ? Math.round(frame.width * scale) : 0;
  let refHeightPx = frame.height ? Math.round(frame.height * scale) : 0;
  let rendered = false;
  let renderFailure: 'no-harness' | 'failed' | undefined;
  let renderAttempts: number | undefined;
  const outcome = await renderFrameReferenceOutcome({
    harnessBaseUrl: cfg.harnessBaseUrl,
    figStorageKey: cfg.figStorageKey, frameId: frame.id, scale,
    width: frame.width, height: frame.height,
  });
  const ref = outcome.status === 'ok' ? outcome : null;
  if (ref) {
    await fs.mkdir(path.dirname(refAbs), { recursive: true });
    await fs.writeFile(refAbs, ref.png);
    referenceImagePath = refRel;
    refWidthPx = ref.widthPx; refHeightPx = ref.heightPx;
    rendered = true;
  } else if (outcome.status !== 'ok') {
    renderFailure = outcome.status; // 'no-harness' | 'failed'
    renderAttempts = outcome.attempts;
  }

  // 2. Localize the frame's assets (broken rasters re-rasterized via the harness).
  const { count: assetCount, assets } = await localizeFrameAssets(projectId, cfg.figStorageKey, frame.id, irData, seen, { harnessBaseUrl: cfg.harnessBaseUrl });

  // 3. Assemble the agent packet.
  const packet = buildAgentPacket({
    frame, tree, framework: cfg.framework, frameworkLabel: fwLabel,
    refImagePath: referenceImagePath || null,
    flowGraph: cfg.flow, frames: cfg.frames,
    bootstrapped: cfg.bootstrapped, assetCount, changeNote: cfg.changeNote,
    userNotes: cfg.userNotes,
  });

  const spec: ScreenSpec = {
    packet, referenceImagePath, tree,
    width: frame.width, height: frame.height,
    refWidthPx, refHeightPx,
  };

  // 4. Persist cache artifacts (best-effort — prep still works without the cache).
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    if (ref) await fs.writeFile(path.join(cacheDir, 'ref.png'), ref.png);
    await fs.writeFile(path.join(cacheDir, 'packet.txt'), packet);
    await fs.writeFile(path.join(cacheDir, 'tree.txt'), tree);
    const meta: PrepMeta = { referenceImagePath, width: frame.width, height: frame.height, refWidthPx, refHeightPx, assetCount };
    await fs.writeFile(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(cacheDir, 'assets.json'), JSON.stringify({ figStorageKey: cfg.figStorageKey, frameId: frame.id, count: assetCount }, null, 2));
  } catch { /* cache is an optimization */ }

  return { spec, cacheHit: false, assetCount, rendered, renderFailure, renderAttempts, assets };
}

/**
 * Whole-batch ASSET PASS: semantic-rename the localized assets, emit the
 * framework's resources/constants file, and write a re-point mapping so a later
 * pass can remap IR-path → semantic path. Run ONCE after all frames are prepped
 * (operates on the union of localized assets). Best-effort — never blocks a build.
 *
 * Returns a summary for logging, or null when there's nothing to do.
 *
 * The semantic rename is AI-REQUIRED and FAILS LOUD: if the model doesn't fire
 * or returns no usable names for the opaque batch, renameAssetsSemantic THROWS
 * and this propagates it (no garbage resources file is written). Pass
 * `opts.noAi` to take the EXPLICIT, logged `degraded` (hint-only) path instead.
 */
export async function runAssetPass(
  projectId: string,
  framework: string,
  assets: LocalizedAsset[],
  model: AIModel,
  env: NodeJS.ProcessEnv,
  opts: { runId?: string; noAi?: boolean } = {},
): Promise<{ resourcesPath: string | null; renamed: number; repaired: number; gathered: number; unique: number; duplicatesDeleted: number } | null> {
  const root = resolveProjectRoot(projectId);
  if (!root || assets.length === 0) return null;

  // Dedupe by relPath (frames share assets) — first list-level dedup.
  const byPath = new Map<string, LocalizedAsset>();
  for (const a of assets) if (!byPath.has(a.relPath)) byPath.set(a.relPath, a);
  const distinctPaths = [...byPath.values()];

  // ── CONTENT-HASH DEDUP (RFC v2 §3 Phase 5) ─────────────────────────────────
  // Ping has 368 asset FILES but only ~77 unique by CONTENT (the same icon was
  // exported once per component-instance). Dedup-by-path keeps all 368 and would
  // AI-name the same icon 32× — wasteful and the cause of rate-limit failures.
  // We group every distinct-path asset by the sha256 of its BYTES (scoped by
  // format+kind so an svg icon never merges with a png image), pick ONE
  // deterministic representative per group, AI-name ONLY the representatives,
  // map EVERY original path → the representative's symbol, and delete the
  // redundant duplicate files. The deletes are reversible: asset-phase takes a git
  // snapshot before this pass and a git rollback (reset --hard + clean -fd)
  // recreates pass-deleted/renamed files (see version-control.ts / asset-phase.ts).
  const dedup = await dedupAssetsByContent(root, distinctPaths);
  const representatives = dedup.representatives;       // ~77 (one per content group)
  const repaired = representatives.filter(a => a.repaired).length;

  // 1. Semantic rename — AI-REQUIRED, fails loud (propagated to the caller).
  //    ONLY the representatives are named → ~77 AI calls, not 368.
  const renamed = await renameAssetsSemantic(root, representatives, model, env, {
    projectId, runId: opts.runId, noAi: opts.noAi,
  });

  // Index the renamed representatives by their ORIGINAL (pre-rename) relPath so we
  // can resolve every duplicate's representative → its final symbol/newPath.
  const renamedByOldPath = new Map<string, typeof renamed[number]>();
  for (const r of renamed) renamedByOldPath.set(r.oldRelPath, r);

  // 2. Emit the framework-agnostic resources file from the renamed REPRESENTATIVES
  //    (one symbol per unique content — NOT one per duplicate file).
  let resourcesPath: string | null = null;
  if (canEmitResources(framework)) {
    const emitted = emitResources(framework, renamed.map(r => ({
      name: r.name, relPath: r.newRelPath, format: r.format, kind: r.kind,
    })));
    if (emitted) {
      const abs = path.join(root, emitted.filePath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, emitted.contents);
      resourcesPath = emitted.filePath;
    }
  }

  // 3. DELETE the redundant duplicate files (every non-representative original).
  //    The representative was renamed in place by renameAssetsSemantic; the
  //    duplicates pointed at the same bytes and are now redundant. After this,
  //    assets/ holds only the ~77 representatives.
  let duplicatesDeleted = 0;
  for (const dupRel of dedup.duplicatePaths) {
    try {
      const abs = path.join(root, dupRel);
      if (fsSync.existsSync(abs)) { await fs.rm(abs, { force: true }); duplicatesDeleted++; }
    } catch { /* best-effort; the map below still repoints it to the representative */ }
  }

  // 4. Persist the re-point mapping covering ALL ORIGINALS. Every one of the
  //    original paths (representatives AND deleted duplicates) maps to the single
  //    representative's symbol/newPath, so a screen referencing ANY old duplicate
  //    path repoints to the one symbol. A representative may carry several source
  //    nodeIds (one per duplicate instance) under `nodeIds`.
  try {
    const mapDir = path.join(root, '.uix');
    await fs.mkdir(mapDir, { recursive: true });
    const mapEntries: Array<Record<string, unknown>> = [];
    for (const a of distinctPaths) {
      const repRel = dedup.repByOriginal.get(a.relPath);
      if (!repRel) continue; // should not happen — every original belongs to a group
      const r = renamedByOldPath.get(repRel);
      if (!r) continue;
      const group = dedup.groupNodeIds.get(repRel) ?? [];
      mapEntries.push({
        nodeId: a.nodeId,                 // THIS original's node id
        name: r.name,
        oldPath: a.relPath,               // THIS original's old path (all 368 covered)
        newPath: r.newRelPath,            // the single representative's new path
        format: r.format, kind: r.kind,
        nodeIds: group,                   // all source nodeIds collapsed into this symbol
      });
    }
    await fs.writeFile(
      path.join(mapDir, 'asset-map.json'),
      JSON.stringify({ framework, resourcesPath, assets: mapEntries }, null, 2),
    );
  } catch { /* mapping is an optimization for the re-point pass */ }

  return {
    resourcesPath,
    renamed: renamed.length,
    repaired,
    gathered: distinctPaths.length,
    unique: representatives.length,
    duplicatesDeleted,
  };
}

/**
 * CONTENT-HASH DEDUP. Group `assets` (distinct by path already) by the sha256 of
 * their on-disk BYTES, scoped by `format:kind` so a vector icon and a raster image
 * never merge even on an (impossible) byte collision. For each group pick ONE
 * deterministic REPRESENTATIVE — the lexicographically smallest relPath — so the
 * result is idempotent across runs. Returns the representatives (to be AI-named),
 * the duplicate paths (to be deleted), a map original→representative path (so the
 * asset-map can point every original at the representative's symbol), and the
 * collapsed source nodeIds per representative.
 *
 * Pure/deterministic apart from the file reads. An asset whose file can't be read
 * is treated as its OWN unique group (never silently merged with another).
 */
async function dedupAssetsByContent(
  root: string,
  assets: LocalizedAsset[],
): Promise<{
  representatives: LocalizedAsset[];
  duplicatePaths: string[];
  repByOriginal: Map<string, string>;      // original relPath → representative relPath
  groupNodeIds: Map<string, string[]>;     // representative relPath → all source nodeIds
}> {
  // group key → members (sorted later by relPath for determinism).
  const groups = new Map<string, LocalizedAsset[]>();
  let missingSeq = 0;
  for (const a of assets) {
    let key: string;
    try {
      const bytes = await fs.readFile(path.join(root, a.relPath));
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      key = `${a.format}:${a.kind}:${hash}`;
    } catch {
      // Unreadable → its own group (a missing file is not a duplicate of anything).
      key = `unreadable:${a.relPath}:${missingSeq++}`;
    }
    const arr = groups.get(key);
    if (arr) arr.push(a); else groups.set(key, [a]);
  }

  const representatives: LocalizedAsset[] = [];
  const duplicatePaths: string[] = [];
  const repByOriginal = new Map<string, string>();
  const groupNodeIds = new Map<string, string[]>();

  for (const members of groups.values()) {
    // Deterministic representative: lexicographically smallest relPath.
    const sorted = [...members].sort((x, y) => x.relPath.localeCompare(y.relPath));
    const rep = sorted[0];
    representatives.push(rep);
    const nodeIds: string[] = [];
    for (const m of sorted) {
      repByOriginal.set(m.relPath, rep.relPath);
      if (m.nodeId) nodeIds.push(m.nodeId);
      if (m.relPath !== rep.relPath) duplicatePaths.push(m.relPath);
    }
    groupNodeIds.set(rep.relPath, nodeIds);
  }
  // Stable representative order (mirrors gatherExistingAssets' sort) for idempotence.
  representatives.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { representatives, duplicatePaths, repByOriginal, groupNodeIds };
}

// ── gather EXISTING on-disk assets (for the resolve / already-built-app path) ────

/** The on-disk asset root(s) a framework bundles its assets under. Flutter is the
 *  one that must work; the others are reasonable defaults for the shared seam. */
function assetDirsFor(framework: string): string[] {
  switch ((framework || '').toLowerCase()) {
    case 'flutter': return ['assets'];
    case 'react': case 'vite': case 'ts': return ['src/assets', 'public'];
    case 'next': case 'web': return ['public', 'src/assets'];
    default: return ['assets'];
  }
}

/** Parse a trailing Figma node id baked into an opaque asset filename. UIX names
 *  assets like `visibility_off_313_10937.svg` / `vector_290_4399.svg` — the last
 *  two underscore-separated numeric groups are the node id. Returns it in `:`-form
 *  (`313:10937`), or undefined when no trailing id is present. */
export function nodeIdFromAssetName(fileName: string): string | undefined {
  const base = path.basename(fileName).replace(/\.[a-z0-9]+$/i, '');
  const m = /(\d+)[_:](\d+)$/.exec(base);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/** Classify an asset's kind from its containing dir then its format: a path under
 *  `.../icons/...` is an icon, `.../images/...` an image; otherwise svg→icon,
 *  png→image (matches localizeFrameAssets' icons/=svg, images/=raster layout). */
function kindForAsset(relPosix: string, format: 'svg' | 'png'): 'icon' | 'image' {
  const lower = relPosix.toLowerCase();
  if (/(^|\/)icons?(\/|$)/.test(lower)) return 'icon';
  if (/(^|\/)images?(\/|$)/.test(lower)) return 'image';
  return format === 'svg' ? 'icon' : 'image';
}

/**
 * Recursively scan an ALREADY-BUILT project's on-disk asset dir(s) and return a
 * `LocalizedAsset[]` describing every `.svg`/`.png` found — the INPUT the Phase-2
 * asset pass (runAssetPass) expects. Used by the resolve path for apps whose assets
 * were localized at build time but never semantic-renamed / surfaced in a resources
 * file. Framework-agnostic seam (flutter → `assets/**`). Returns [] when there is no
 * asset dir or no asset files. relPath is project-relative POSIX.
 */
export async function gatherExistingAssets(
  projectRoot: string,
  framework: string,
): Promise<LocalizedAsset[]> {
  if (!projectRoot || !fsSync.existsSync(projectRoot)) return [];
  const out: LocalizedAsset[] = [];
  const seen = new Set<string>();

  const walk = async (absDir: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      const format: 'svg' | 'png' | null = ext === '.svg' ? 'svg' : ext === '.png' ? 'png' : null;
      if (!format) continue;
      const relPath = path.relative(projectRoot, abs).split(path.sep).join('/');
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      out.push({
        relPath,
        nodeId: nodeIdFromAssetName(e.name),
        format,
        kind: kindForAsset(relPath, format),
      });
    }
  };

  for (const dir of assetDirsFor(framework)) {
    const abs = path.join(projectRoot, dir);
    if (fsSync.existsSync(abs)) await walk(abs);
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
