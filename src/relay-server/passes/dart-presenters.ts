/**
 * dart-presenters.ts — what counts as PRESENTING a folded modal in a Dart screen.
 *
 * A folded modal is reachable only if a control of its base screen calls its
 * presenter. The P1-core contract makes every base DECLARE `showModal_<core>(context)`
 * — and the verify preview (lib/_preview) calls it to screenshot the modal. So the
 * declaration, and the `showDialog(` inside its body, prove nothing: counting them
 * credited a modal no user can open as "presented" (PG-11, the SettingsPreview
 * defect on flutter). Shared by 7b (modal-overlay.ts) and 7d (flow-wiring.ts) so the
 * two passes cannot disagree.
 */

/** Presenter name for a modal id: `m_10_8` → `showModal_10_8`. */
export const dartPresenterName = (modalId: string): string => `showModal_${String(modalId).replace(/^[cm]_/, '')}`;

/** Remove every presenter DECLARATION (`void showModal_10_8(BuildContext c) {…}`,
 *  `Future<void> showModal_…(…) async {…}`, `… => showDialog(…);`, and a converted
 *  overlay's `static Future<void> present(BuildContext context) {…}`), body included,
 *  so neither its name nor the dialog call inside it counts as a presentation. */
export function stripDartPresenterDeclarations(src: string): string {
  const decl = /(?:^|\n)[ \t]*(?:static\s+)?(?:(?:Future<[^>\n]*>|void|dynamic|Future)\s+)?(showModal_[0-9_]+|present)\s*\(/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    // A call site (`showModal_10_8(context);` inside a handler) is not a declaration:
    // a declaration's param list is followed by a body (`{`, `=>`, `async`).
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    const rest = src.slice(i);
    const head = /^\s*(?:async\s*)?(\{|=>)/.exec(rest);
    if (!head) continue;
    // Require a return type or `static` for `present` (a bare `present(` call site
    // followed by `{` does not occur in Dart, but be strict anyway).
    if (m[1] === 'present' && !/(?:static|void|Future|dynamic)/.test(m[0])) continue;
    let end: number;
    if (head[1] === '{') {
      let j = i + head[0].length;
      let d = 1;
      while (j < src.length && d > 0) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
      end = j;
    } else {
      const semi = rest.indexOf(';', head[0].length);
      end = semi < 0 ? src.length : i + semi + 1;
    }
    out += src.slice(last, m.index);
    last = end;
    decl.lastIndex = end;
  }
  return out + src.slice(last);
}

export interface DartPresentation {
  /** Calls of this modal's own presenter (`showModal_10_8(context)`) outside its declaration. */
  presenterCalls: number;
  /** In-place `showModalBottomSheet/showDialog/showGeneralDialog(` calls outside any
   *  presenter declaration (an inline overlay the build wrote without the presenter). */
  inlineCalls: number;
  /** The first inline presenter API seen, for the report. */
  inlineApi: string | null;
  /** True when the base DECLARES the modal's presenter (so a zero-call result means
   *  "declared, never called" — the preview-only defect). */
  declared: boolean;
}

/** How a Dart source presents folded modal `modalId` (or any folded modal when absent). */
export function dartPresentation(src: string, modalId?: string): DartPresentation {
  const code = stripDartPresenterDeclarations(src.replace(/\/\/[^\n]*/g, ''));
  const presenter = modalId ? dartPresenterName(modalId) : null;
  const presenterCalls = presenter
    ? (code.match(new RegExp(`\\b${presenter}\\s*\\(`, 'g')) ?? []).length
    : (code.match(/\bshowModal_[0-9_]+\s*\(/g) ?? []).length;
  const inline = code.match(/\b(?:showModalBottomSheet|showDialog|showGeneralDialog)\s*[<(]/g) ?? [];
  const inlineApi = inline.length ? (/\b(showModalBottomSheet|showDialog|showGeneralDialog)\b/.exec(inline[0] ?? "")?.[1] ?? null) : null;
  const declared = !!presenter && new RegExp(`\\b${presenter}\\s*\\([^)]*\\)\\s*(?:async\\s*)?(?:\\{|=>)`).test(src);
  return { presenterCalls, inlineCalls: inline.length, inlineApi, declared };
}
