// =============================================================================
// File: src/relay-server/visual-flutter-scaffold.ts
//
// Pure helpers for scaffolding a scratch Flutter web app around UIX-generated
// Dart so it can be built + screenshotted. Kept separate from the Express route
// glue so the wrapping logic (which historically broke Compare) is unit-testable
// without spinning up the server or the Flutter SDK.
//
// Two historical bugs lived here:
//   1. The harness hard-coded `home: _GeneratedRoot()`, but UIX codegen emits a
//      PascalCase `<Name>Screen` class (or a full app with its own `main()`),
//      never `_GeneratedRoot` — so `flutter build web` died with undefined-name.
//   2. The scaffold pubspec only declared `flutter`, so generated code importing
//      `google_fonts`/`flutter_svg`/etc. failed `pub get`.
// Both are fixed below by deriving the home widget and the dependency list from
// the generated code itself.
// =============================================================================

/** Thrown when the generated code can't be turned into a runnable app. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

// Strip line + block comments so we don't match a `class Foo` or `main(` that
// only appears inside a comment. Crude but adequate for harness detection.
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** True when the generated code already defines its own `void main()` entry. */
export function hasMainEntry(code: string): boolean {
  return /(^|\s)void\s+main\s*\(/.test(stripComments(code));
}

/**
 * Extract the first top-level widget class — `class <Name> extends
 * StatelessWidget|StatefulWidget` — and whether it offers a const constructor
 * (so the harness can prefer `const <Name>()`). Returns null if none is found.
 */
export function firstWidgetClass(
  code: string,
): { name: string; hasConstCtor: boolean } | null {
  const src = stripComments(code);
  const re = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+(?:State(?:less|ful)Widget)\b/g;
  const m = re.exec(src);
  if (!m) return null;
  const name = m[1];
  // A const constructor looks like `const HomeScreen(` somewhere in the file.
  const hasConstCtor = new RegExp(`const\\s+${name}\\s*\\(`).test(src);
  return { name, hasConstCtor };
}

// Split the generated code into its leading import/export directives and the
// rest. Dart requires every directive to precede all declarations, so when we
// inject our own imports + harness classes we must HOIST the generated code's
// imports to the top — otherwise an `import ...` that trailed a class in the
// original snippet ends up after our harness declarations and fails to compile
// ("Directives must appear before any declarations.").
function splitDirectives(code: string): { imports: string[]; body: string } {
  const src = stripComments(code);
  const re = /^[ \t]*(?:import|export)\s+['"][^'"]+['"][^;]*;/gm;
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) imports.push(m[0].trim());
  // Remove directive lines from the body (operate on the original so we keep
  // the real source, including comments, intact).
  const body = code.replace(/^[ \t]*(?:import|export)\s+['"][^'"]+['"][^;]*;[ \t]*\n?/gm, '').trim();
  return { imports, body };
}

// Dedupe imports while preserving first-seen order, guaranteeing the flutter
// material import is present exactly once.
function mergeImports(extra: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (line: string) => {
    const key = line.replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) { seen.add(key); out.push(line); }
  };
  add(`import 'package:flutter/material.dart';`);
  for (const line of extra) add(line);
  return out.join('\n');
}

/**
 * Build the `main.dart` that wraps the generated Dart in a runnable web app.
 *
 * - If the generated code already declares `void main(`, it is used AS-IS (the
 *   agent emitted a full app); we never double-wrap. Imports are hoisted and the
 *   flutter material import is ensured present.
 * - Otherwise the first widget class is found and used as the MaterialApp home,
 *   preferring a const constructor when one exists.
 * - If neither a main() nor a widget class is present, throws ScaffoldError so
 *   the caller can return a clear 422 instead of starting a doomed build.
 */
export function mainDartFor(widgetCode: string): string {
  const { imports, body } = splitDirectives(widgetCode);

  if (hasMainEntry(widgetCode)) {
    // Already a complete app: keep its own main(), just normalize directives.
    return `${mergeImports(imports)}\n\n${body}\n`;
  }

  const widget = firstWidgetClass(widgetCode);
  if (!widget) {
    throw new ScaffoldError('generated code has no top-level widget or main()');
  }

  const home = widget.hasConstCtor ? `const ${widget.name}()` : `${widget.name}()`;
  // When the home is non-const we can't make the MaterialApp const either.
  const appCtor = widget.hasConstCtor ? 'const MaterialApp' : 'MaterialApp';

  return `${mergeImports(imports)}

void main() => runApp(const _PreviewApp());

class _PreviewApp extends StatelessWidget {
  const _PreviewApp();
  @override
  Widget build(BuildContext context) {
    return ${appCtor}(
      debugShowCheckedModeBanner: false,
      home: ${home},
    );
  }
}

${body}
`;
}

/**
 * Derive the non-flutter pub packages the generated code imports. Scans every
 * `import 'package:<pkg>/...'` and returns the distinct package names, dropping
 * `flutter` itself (provided by the SDK). Order-stable for deterministic output.
 */
export function importedPackages(code: string): string[] {
  const src = stripComments(code);
  const re = /import\s+['"]package:([A-Za-z_][\w]*)\//g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const pkg = m[1];
    if (pkg === 'flutter' || seen.has(pkg)) continue;
    seen.add(pkg);
    out.push(pkg);
  }
  return out;
}

/**
 * Build the scaffold pubspec.yaml. The flutter SDK dep is always present;
 * every other imported package is added with a permissive `any` constraint so
 * `pub get` can resolve the latest compatible version. If resolution still
 * fails, the build step surfaces it (the caller maps that to a 422).
 */
export function pubspecFor(code: string): string {
  const extras = importedPackages(code);
  const extraLines = extras.map((p) => `  ${p}: any`).join('\n');
  return `name: relay_visual_preview
description: scratch app for visual diff
publish_to: "none"
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter${extras.length ? `\n${extraLines}` : ''}
flutter:
  uses-material-design: true
`;
}
