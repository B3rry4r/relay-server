// =============================================================================
// File: src/relay-server/component-contract.ts
//
// ONE authoritative answer to "where does shared component X live, and what is it
// called" — for the skeleton, both prompt blocks (API surface + canonical context),
// the reconciliation gate and the packet-level reuse block (readability F1).
//
// Before this, three places disagreed: the skeleton wrote write-locked
// `lib/components/cmp_<name>_<i>.dart` stubs (class `<Name>Widget`, body
// `SizedBox.shrink()`), the API surface told the agent the FIRST screen creates
// `lib/components/<name>.dart`, and the canonical context offered the stubs as
// "available". Nothing was reusable, so every screen re-implemented the UI
// privately (Ping: 135 private widgets, 0 importers of lib/components, 25 dead
// stubs shipped). Now: no stub is emitted; the contract names the path + class;
// the first screen that renders the component creates it there; every later
// screen is told — from what is ON DISK — that it exists and how to call it.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Canonical } from './canonicalize';
import { shadowsSdkName } from './passes/sdk-names';
import { webPipelineRootRel } from './passes/framework';

export interface ComponentSlot {
  /** canonical component id (`cmp_primary_button`). */
  id: string;
  /** design name (`primaryButton`). */
  name: string;
  /** the public class / component name every screen uses (`PrimaryButton`). */
  className: string;
  /** project-relative POSIX path the component lives at. */
  file: string;
}

const isWeb = (fw: string): boolean => fw === 'react' || fw === 'next';

/** `primary button` / `primaryButton` / `primary_button` → `PrimaryButton`. */
export function pascalName(s: string): string {
  return String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** `PrimaryButton` → `primary_button`. */
export function snakeName(s: string): string {
  return String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '');
}

/** The class name a shared component gets: Pascal(name), prefixed with `App` when it
 *  would shadow an SDK / platform symbol (`BackButton` → `AppBackButton`). A name
 *  with no letters (a frame id) falls back to `SharedComponent`. */
export function componentClassName(name: string, framework = 'flutter'): string {
  let cls = pascalName(name).replace(/^\d+/, '');
  if (!/^[A-Z]/.test(cls)) cls = 'SharedComponent';
  if (shadowsSdkName(cls, framework)) cls = `App${cls}`;
  return cls;
}

/** Where shared components live for this framework (CONTRACTS §5). */
export function componentsDirRel(projectRoot: string | undefined, framework: string): string {
  const fw = (framework || 'flutter').toLowerCase();
  if (fw === 'next') {
    const pr = projectRoot ? webPipelineRootRel(projectRoot, 'next') : '.';
    return pr === '.' ? 'components' : `${pr}/components`;
  }
  if (fw === 'react') return 'src/components';
  return 'lib/components';
}

export function componentFileRel(className: string, framework: string, projectRoot?: string): string {
  const dir = componentsDirRel(projectRoot, framework);
  return isWeb((framework || '').toLowerCase()) ? `${dir}/${className}.tsx` : `${dir}/${snakeName(className)}.dart`;
}

/** The contract for every canonical component — unique class names (a second
 *  component with the same design name IS the same component and is folded). */
export function componentContract(canonical: Pick<Canonical, 'components'> | undefined, framework: string, projectRoot?: string): ComponentSlot[] {
  const out: ComponentSlot[] = [];
  const seen = new Set<string>();
  for (const c of canonical?.components ?? []) {
    const className = componentClassName(c.name, framework);
    if (seen.has(className)) continue;
    seen.add(className);
    out.push({ id: c.id, name: c.name, className, file: componentFileRel(className, framework, projectRoot) });
  }
  return out;
}

// ── On-disk reuse (packet-level, readability "instead of F3") ─────────────────

export interface BuiltComponent {
  className: string;
  /** project-relative POSIX path. */
  file: string;
  /** how to construct it, as written (`PrimaryButton({required String label, required VoidCallback onTap})`). */
  signature: string;
}

const SKELETON_STUB_RE = /GENERATED SKELETON|=>\s*const\s+SizedBox\.shrink\(\)\s*;|\{\s*return\s+const\s+SizedBox\.shrink\(\);\s*\}/;

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(node_modules|_preview|%5Fpreview|modals)$/.test(e.name)) walk(p, exts, out); } else if (exts.test(e.name)) out.push(p);
  }
  return out;
}

/** Collapse a constructor/props text to one readable line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/,\s*([})])/g, '$1').trim();

/** Dart: the `const Foo({...});` / `Foo(...)` constructor of a public widget class. */
function dartCtor(src: string, cls: string): string {
  const m = new RegExp(`(?:const\\s+)?${cls}\\s*\\(`).exec(src.slice(src.indexOf(`class ${cls}`)));
  if (!m) return `${cls}()`;
  const start = src.indexOf(`class ${cls}`) + m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) {
        // `this.label` → `String label`: an agent reading the packet needs the TYPE.
        const body = classBody(src, cls);
        const typed = src.slice(start, i + 1).replace(/\bthis\.([A-Za-z_]\w*)/g, (m, f: string) => {
          const t = new RegExp(`\\bfinal\\s+([A-Za-z_][\\w<>?, .]*?)\\s+${f}\\s*;`).exec(body)?.[1];
          return t ? `${t.replace(/\s+/g, ' ').trim()} ${f}` : m;
        });
        return tidySignature(`${cls}${typed}`.replace(/\bsuper\.key\s*,?/, ''));
      }
    }
  }
  return `${cls}()`;
}

/** The `{ … }` body of `class Cls`. */
function classBody(src: string, cls: string): string {
  const at = src.search(new RegExp(`class\\s+${cls}\\b`));
  const open = at < 0 ? -1 : src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

/** One readable line, no stray separators: `Disc(this.color, {})` → `Disc(Color color)`,
 *  `Foo({ required …, })` → `Foo({required …})`. */
function tidySignature(s: string): string {
  return oneLine(s)
    .replace(/,?\s*\{\s*,?\s*\}/g, '')      // an emptied `{}` (only super.key was in it)
    .replace(/\{\s+/g, '{').replace(/\s+\}/g, '}')
    .replace(/\[\s+/g, '[').replace(/\s+\]/g, ']')
    .replace(/,\s*([)}\]])/g, '$1')
    .replace(/\(\s*,\s*/g, '(').replace(/\{\s*,\s*/g, '{');
}

/** Web: `export function Foo(props: {...})` / `export const Foo = ({...}: P) =>`. */
function webSignature(src: string, cls: string): string {
  const m = new RegExp(`export\\s+(?:default\\s+)?(?:function\\s+${cls}\\s*\\(|const\\s+${cls}\\s*(?::[^=]+)?=\\s*\\()`).exec(src);
  if (!m) return `<${cls} />`;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return oneLine(`${cls}${src.slice(open, i + 1)}`); }
  }
  return `<${cls} />`;
}

/** Public components that already exist on disk and are real (not a skeleton stub):
 *  what earlier screens built. Deterministic order (path). */
export function scanBuiltComponents(projectRoot: string, framework: string): BuiltComponent[] {
  const fw = (framework || 'flutter').toLowerCase();
  const dirRel = componentsDirRel(projectRoot, fw);
  const files = walk(path.join(projectRoot, dirRel), isWeb(fw) ? /\.(tsx|jsx)$/ : /\.dart$/).sort();
  const out: BuiltComponent[] = [];
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (SKELETON_STUB_RE.test(src) || /PlaceholderScreen|ModalHost|screenState|AppShell/.test(path.basename(f))) continue;
    const rel = path.relative(projectRoot, f).split(path.sep).join('/');
    if (isWeb(fw)) {
      for (const m of src.matchAll(/^export\s+(?:default\s+)?(?:function\s+([A-Z][A-Za-z0-9_]*)\s*\(|const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*\()/gm)) {
        const cls = m[1] ?? m[2];
        if (!/^[A-Z][a-z]/.test(cls) || /(?:Screen|Page|Preview)$/.test(cls)) continue;
        out.push({ className: cls, file: rel, signature: webSignature(src, cls) });
      }
    } else {
      for (const m of src.matchAll(/^class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/gm)) {
        out.push({ className: m[1], file: rel, signature: dartCtor(src, m[1]) });
      }
    }
  }
  return out;
}

/** The prompt block every screen gets: the components earlier screens already built
 *  (import them — do not re-implement), then the contract slots still to be built. */
export function componentReuseBlock(projectRoot: string | undefined, framework: string, canonical?: Pick<Canonical, 'components'>): string {
  const fw = (framework || 'flutter').toLowerCase();
  const built = projectRoot ? scanBuiltComponents(projectRoot, fw) : [];
  const slots = componentContract(canonical, fw, projectRoot);
  const builtNames = new Set(built.map((b) => b.className));
  const todo = slots.filter((s) => !builtNames.has(s.className));
  if (!built.length && !todo.length) return '';
  const dir = componentsDirRel(projectRoot, fw);
  const out: string[] = [
    `SHARED COMPONENTS — ONE location: \`${dir}/\` (${isWeb(fw) ? 'one exported component per file, `<ComponentName>.tsx`' : 'one public widget per file, `<snake_name>.dart`'}). A private per-screen copy of UI that already exists there is a DEFECT the review flags.`,
  ];
  if (built.length) {
    out.push(`ALREADY BUILT by earlier screens — IMPORT these; never re-implement them privately (extend one with a new optional parameter if you need a variant):`);
    for (const b of built.slice(0, 40)) out.push(`- ${b.signature}  — ${b.file}`);
    if (built.length > 40) out.push(`- …and ${built.length - 40} more in ${dir}/`);
  }
  if (todo.length) {
    out.push(`STILL TO BUILD — the FIRST screen that renders one CREATES it at exactly this path + name (public, parameterized by what differs between screens); every later screen imports it:`);
    for (const s of todo) out.push(`- ${s.className} → ${s.file}`);
  }
  return out.join('\n');
}
