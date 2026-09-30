/**
 * flutter-analyze-output.ts — read `flutter analyze` output, or refuse to.
 *
 * The flutter half of PG-37 (the web half is finalize.parseTscOutput): a checker
 * that did not analyze must never read as "0 issues". `flutter analyze` run from a
 * relay terminal env (HOME=$WORKSPACE, no global gitconfig) against a root-owned SDK
 * dies with git's "detected dubious ownership" and exit 128 — no summary line and no
 * issue line — and the old parser counted the issue lines it found (none) and
 * reported `{ total: 0, errors: 0 }`: a gate that said `ran` and passed everything.
 */

export interface FlutterAnalysis { total: number; errors: number; errorLines: string[] }

/** Null when the output is not an analysis: neither the "No issues found!" /
 *  "N issues found." summary nor a single `severity • message` issue line. */
export function parseFlutterAnalyzeOutput(raw: string): FlutterAnalysis | null {
  const errorLines = (raw.match(/^\s*error\s+•.*$/gm) || []).map((l) => l.trim());
  if (/no issues found/i.test(raw)) return { total: 0, errors: 0, errorLines: [] };
  const summ = /(\d+)\s+issues?\s+found/.exec(raw);
  if (summ) return { total: Number(summ[1]), errors: errorLines.length, errorLines };
  const total = (raw.match(/^\s*(error|warning|info)\s+•/gm) || []).length;
  if (total === 0) return null;
  return { total, errors: errorLines.length, errorLines };
}

/** First meaningful line of a failed run, for the gate's skip reason. */
export function flutterAnalyzeFailure(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l) || /Error:|Exception/.test(l));
  return (fatal ?? lines[0] ?? '(no output)').slice(0, 200);
}
