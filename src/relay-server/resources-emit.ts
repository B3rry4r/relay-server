// =============================================================================
// File: src/relay-server/resources-emit.ts
//
// FRAMEWORK-AGNOSTIC asset RESOURCES generation (Phase-2 asset pass).
//
// Given the target framework + a set of localized assets (each with a semantic
// name + a project-relative path), emit ONE resources/constants file the agent
// references so screens stop hard-coding string paths / substituting Material
// icons. Nothing here is Flutter-specific: each framework registers a small
// `Emitter` in EMITTERS, and adding a framework = adding one entry.
//
//   flutter        → lib/resources/app_assets.dart   (class AppAssets {...}) —
//                    values are bundle paths (`assets/icons/x.svg`)
//   react / vite / → src/resources/assets.ts          (export const assets {...})
//   web / ts
//   next           → <root>/lib/resources/assets.ts   (CONTRACTS §5; the caller
//                    passes the resolved path — `.` or `src` per the app dir)
//
// WEB VALUES ARE SERVED URLS (CONTRACTS §5, PG-29). Web assets live in
// `public/assets/…`; a web server serves `public/` at `/`, so the symbol's value is
// `/assets/icons/x.svg` and a screen writes `<img src={assets.x} />`. The value used
// to be the project-relative path (`public/assets/…` → a 404 under Vite and Next).
// =============================================================================

import { webServedUrl } from './passes/framework';

/** An asset to surface in the resources file. */
export interface ResourceAsset {
  /** semantic identifier, e.g. `add_circle` / `netflix_icon`. snake_case in. */
  name: string;
  /** project-relative asset path, e.g. `assets/icons/add_circle.svg`. */
  relPath: string;
  format: 'svg' | 'png';
  kind: 'icon' | 'image';
}

export interface EmittedResources {
  /** project-relative path of the file to write. */
  filePath: string;
  /** full file contents. */
  contents: string;
}

interface Emitter {
  filePath: string;
  emit(assets: ResourceAsset[]): string;
}

// ── name helpers ────────────────────────────────────────────────────────────
const toSnake = (s: string): string =>
  (s || 'asset')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1') || 'asset';

const toLowerCamel = (s: string): string => {
  const snake = toSnake(s);
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  // Re-guard a leading digit: a Dart/TS identifier can't start with one (the
  // camel step strips the `_` toSnake prepended), so re-prefix.
  return /^[0-9]/.test(camel) ? `a${camel}` : (camel || 'asset');
};

/**
 * The resources symbol for each asset, in order (readability F4/F5 fix round). Two
 * rules replace the old blind `_2` counter, so a key says WHICH asset it is:
 *  - a Figma counter on a name nothing else shares (`Netflix Icon 1`) is dropped:
 *    `netflixIcon`, not `netflixIcon1`;
 *  - a name two assets share gets the second one's kind: the icon keeps
 *    `avatarBackground`, the bitmap is `avatarBackgroundImage` (a name that already
 *    ends in its kind uses the format: `confettiIconPng`). Only a third collision
 *    falls back to a counter.
 * Asset-usage (7c) computes the SAME keys (buildAssetIndex) and renames a resources
 * file emitted with the old scheme to them.
 */
export function assetSymbolKeys(items: Array<{ name: string; kind: 'icon' | 'image'; format: 'svg' | 'png' }>): string[] {
  const bases = items.map((a) => toLowerCamel(a.name));
  const baseSet = new Set(bases);
  const stemOf = (name: string): string | null => {
    const m = /^(.*[a-z])_(\d{1,3})$/.exec(toSnake(name));
    return m ? toLowerCamel(m[1]) : null;
  };
  const stemCount = new Map<string, number>();
  for (const a of items) { const st = stemOf(a.name); if (st) stemCount.set(st, (stemCount.get(st) ?? 0) + 1); }
  const used = new Set<string>();
  return items.map((a, i) => {
    let key = bases[i];
    const st = stemOf(a.name);
    if (st && !baseSet.has(st) && stemCount.get(st) === 1 && !used.has(st)) key = st;
    if (!used.has(key)) { used.add(key); return key; }
    const kindNoun = a.kind === 'image' ? 'Image' : 'Icon';
    const noun = key.toLowerCase().endsWith(kindNoun.toLowerCase()) ? (a.format === 'svg' ? 'Svg' : 'Png') : kindNoun;
    let k = `${key}${noun}`;
    for (let n = 2; used.has(k) || baseSet.has(k); n++) k = `${key}_${n}`;
    used.add(k);
    return k;
  });
}

/** Keys for a list (see assetSymbolKeys). */
function dedupeKeys<T extends { name: string; kind: 'icon' | 'image'; format: 'svg' | 'png' }>(items: T[]): Array<{ key: string; item: T }> {
  const keys = assetSymbolKeys(items);
  return items.map((item, i) => ({ key: keys[i], item }));
}

// ── per-framework emitters ────────────────────────────────────────────────────

const flutterEmitter: Emitter = {
  filePath: 'lib/resources/app_assets.dart',
  emit(assets) {
    const entries = dedupeKeys(assets);
    const lines = entries.map(({ key, item }) =>
      `  static const String ${key} = '${item.relPath}';`);
    return [
      '// GENERATED by relay-server asset pass — do not edit by hand.',
      '// Semantic names → bundled asset paths. Reference these instead of',
      '// hard-coding strings or substituting Material icons.',
      '//',
      '// Declare the asset dirs in pubspec.yaml under flutter > assets.',
      '',
      'class AppAssets {',
      '  AppAssets._();',
      '',
      ...lines,
      '}',
      '',
    ].join('\n');
  },
};

const tsEmitter = (filePath: string): Emitter => ({
  filePath,
  emit(assets) {
    const entries = dedupeKeys(assets);
    const body = entries.map(({ key, item }) =>
      `  ${key}: '${webServedUrl(item.relPath)}',`);
    return [
      '// GENERATED by relay-server asset pass — do not edit by hand.',
      '// Semantic names → the URL each design asset is SERVED at (public/assets/…',
      '// is served at /assets/…). Import `assets` and use the value directly —',
      '// `<img src={assets.x} />` — never a hard-coded path or a redrawn glyph.',
      '',
      'export const assets = {',
      ...body,
      '} as const;',
      '',
      'export type AssetName = keyof typeof assets;',
      '',
    ].join('\n');
  },
});

/** Per-framework emitter registry. Extend by adding an entry. */
const EMITTERS: Record<string, Emitter> = {
  flutter: flutterEmitter,
  react: tsEmitter('src/resources/assets.ts'),
  // next: the default only — runAssetPass passes webResourcesRel(root) (lib/resources
  // beside the app dir's parent, CONTRACTS §5).
  next: tsEmitter('lib/resources/assets.ts'),
  vite: tsEmitter('src/resources/assets.ts'),
  web: tsEmitter('src/resources/assets.ts'),
  ts: tsEmitter('src/resources/assets.ts'),
};

/** Frameworks we can emit a resources file for. */
export function canEmitResources(framework: string): boolean {
  return !!EMITTERS[(framework || '').toLowerCase()];
}

/**
 * Emit the resources/constants file for `framework` from `assets`. Returns the
 * project-relative path + the file contents (the caller writes it), or null when
 * the framework has no emitter or there are no assets.
 */
export function emitResources(framework: string, assets: ResourceAsset[], opts: { filePath?: string } = {}): EmittedResources | null {
  const emitter = EMITTERS[(framework || '').toLowerCase()];
  if (!emitter || assets.length === 0) return null;
  // Stable order: icons first, then images; alphabetical within each.
  const sorted = [...assets].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'icon' ? -1 : 1);
  return { filePath: opts.filePath ?? emitter.filePath, contents: emitter.emit(sorted) };
}
