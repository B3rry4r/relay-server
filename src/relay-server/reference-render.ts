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

/**
 * Render ONE frame to a reference PNG via the headless harness. Serves nothing
 * here (the harness server is the module singleton); just screenshots the harness
 * page at the matched device-scale and full height. Returns the PNG + its actual
 * pixel dimensions (read from the IHDR), or null if the harness/Chrome is absent.
 */
export async function renderFrameReference(args: {
  harnessBaseUrl?: string;
  figStorageKey: string;
  frameId: string;
  scale: number;
  width: number;
  height: number;
}): Promise<{ png: Buffer; widthPx: number; heightPx: number } | null> {
  const base = args.harnessBaseUrl ?? await harnessOrigin();
  if (!base) return null;
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
  const png = await captureUrlScreenshot(url, dw, dh, 30000, { deviceScale: 1, fullPage: false, disableWebSecurity: true });
  if (!png) return null;
  const dims = pngDimensions(png);
  return {
    png,
    widthPx: dims?.width ?? Math.round(args.width * args.scale),
    heightPx: dims?.height ?? Math.round(args.height * args.scale),
  };
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
  const png = await captureUrlScreenshot(url, dw, dh, 30000, { deviceScale: 1, fullPage: false, disableWebSecurity: true });
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
  // 2. Icon + illustration assets under THIS frame. Flat vectors come back as SVG —
  //    KEEP THEM AS SVG (never rasterize). Anything UIX flagged format:'png' is a
  //    raster it produced with the broken @grida/refig renderer — re-rasterize via
  //    the harness instead.
  const svgAssets = await getSvgAssets(figStorageKey, frameId);
  for (const s of svgAssets) {
    if (s.format === 'png') {
      tasks.push(() => repairRaster(s.nodeId, 'assets/images', s.fileName, s.url));
    } else {
      tasks.push(() => upload(s.url, 'assets/icons', s.fileName, { nodeId: s.nodeId, format: 'svg', kind: 'icon' }));
    }
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
  // 1. Reference render via the harness (best-effort).
  let referenceImagePath = '';
  let refWidthPx = frame.width ? Math.round(frame.width * scale) : 0;
  let refHeightPx = frame.height ? Math.round(frame.height * scale) : 0;
  let rendered = false;
  const ref = await renderFrameReference({
    harnessBaseUrl: cfg.harnessBaseUrl,
    figStorageKey: cfg.figStorageKey, frameId: frame.id, scale,
    width: frame.width, height: frame.height,
  });
  if (ref) {
    await fs.mkdir(path.dirname(refAbs), { recursive: true });
    await fs.writeFile(refAbs, ref.png);
    referenceImagePath = refRel;
    refWidthPx = ref.widthPx; refHeightPx = ref.heightPx;
    rendered = true;
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

  return { spec, cacheHit: false, assetCount, rendered, assets };
}

/**
 * Whole-batch ASSET PASS: semantic-rename the localized assets, emit the
 * framework's resources/constants file, and write a re-point mapping so a later
 * pass can remap IR-path → semantic path. Run ONCE after all frames are prepped
 * (operates on the union of localized assets). Best-effort — never blocks a build.
 *
 * Returns a summary for logging, or null when there's nothing to do.
 */
export async function runAssetPass(
  projectId: string,
  framework: string,
  assets: LocalizedAsset[],
  model: AIModel,
  env: NodeJS.ProcessEnv,
): Promise<{ resourcesPath: string | null; renamed: number; repaired: number } | null> {
  const root = resolveProjectRoot(projectId);
  if (!root || assets.length === 0) return null;

  // Dedupe by relPath (frames share assets).
  const byPath = new Map<string, LocalizedAsset>();
  for (const a of assets) if (!byPath.has(a.relPath)) byPath.set(a.relPath, a);
  const uniq = [...byPath.values()];
  const repaired = uniq.filter(a => a.repaired).length;

  // 1. Semantic rename (bounded AI call; falls back to filename hints).
  const renamed = await renameAssetsSemantic(root, uniq, model, env, { projectId });

  // 2. Emit the framework-agnostic resources file from the renamed paths.
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

  // 3. Persist the re-point mapping (IR node / old path → semantic path) under
  //    .uix so a later re-point pass can swap opaque references for semantic ones.
  try {
    const mapDir = path.join(root, '.uix');
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(
      path.join(mapDir, 'asset-map.json'),
      JSON.stringify({
        framework, resourcesPath,
        assets: renamed.map(r => ({
          nodeId: r.nodeId, name: r.name,
          oldPath: r.oldRelPath, newPath: r.newRelPath,
          format: r.format, kind: r.kind,
        })),
      }, null, 2),
    );
  } catch { /* mapping is an optimization for the re-point pass */ }

  return { resourcesPath, renamed: renamed.length, repaired };
}
