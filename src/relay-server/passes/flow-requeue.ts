// =============================================================================
// File: src/relay-server/passes/flow-requeue.ts
//
// P3 — REAL flow-wiring gaps requeue their FROM screen instead of warn-only.
//
// verifyFlowWiring (pass 7d) reports HIGH-class findings — `unmapped` REAL gaps
// ("no presenter wires it"), `tab-as-push`, `missing-step-presenter` — but until
// now nothing consumed them: the report was written, the warnings logged, and the
// run completed anyway (the Ping run shipped 4 known-missing modals this way).
//
// planFlowRequeue is the PURE mapper: given the flow-wiring report's findings,
// the canonical model, and the run's screens, it decides which run screens flip
// to `needs-review` (with the findings as the review reason).
//
// RULES (the idempotency contract — documented, load-bearing):
//   • Only HIGH-class findings requeue: status 'tab-as-push',
//     'missing-step-presenter', or 'unmapped' whose detail marks a REAL gap
//     (the pass's own "(REAL gap, not folded)" phrasing). `duplicate`, `wired`,
//     and every other benign/med status NEVER requeue.
//   • The finding maps to its FROM screen's LEAD frame: finding.from is a
//     canonical screen id (or a modal id, when the edge originates inside a
//     sheet — that resolves to the modal's base screen). Unresolvable → skipped.
//   • Only screens currently 'done' are flipped — a screen already parked
//     'needs-review'/'failed' keeps its existing review payload untouched.
//   • Each screen is requeued at most ONCE per finalize (findings for the same
//     screen are merged into one review reason).
//   • CALLER-LEVEL idempotency: the orchestrator invokes this ONLY in the same
//     execution where finalizeApp actually ran (a fresh flow-wiring report). A
//     resume that re-enters the finalize branch sees finalize-report.json on
//     disk, skips finalizeApp, and therefore never re-requeues — so a screen a
//     human has since Accepted (status 'done', review cleared) is never flipped
//     back by a replayed finalize.
// =============================================================================

/** The subset of an EdgeFinding the mapper reads (kept structural so fixture
 *  reports / old on-disk reports parse without the full pass types). */
export interface FlowFindingLike {
  from: string;
  to: string;
  kind?: string;
  status: string;
  detail?: string;
}

/** The subset of the canonical model the mapper needs to resolve FROM → frame. */
export interface CanonScreenLike {
  canonicalId: string;
  frameIds: string[];
  name?: string;
  modals?: Array<{ id: string; frameId: string }>;
}

export interface RunScreenLike {
  frameId: string;
  frameName?: string;
  status: string;
}

export interface FlowRequeueDecision {
  frameId: string;
  frameName?: string;
  /** the FROM canonical screen the findings mapped through. */
  canonicalId: string;
  /** one line per finding — becomes the review reason. */
  findings: string[];
}

/** HIGH-class statuses that always requeue. */
const HIGH_STATUSES = new Set(['tab-as-push', 'missing-step-presenter']);
/** An `unmapped` finding requeues only when the pass marked it a REAL gap. */
const REAL_GAP_RE = /REAL gap/i;

function isHighClass(f: FlowFindingLike): boolean {
  if (HIGH_STATUSES.has(f.status)) return true;
  if (f.status === 'unmapped' && REAL_GAP_RE.test(f.detail ?? '')) return true;
  return false;
}

/** Resolve a finding's FROM id to its canonical screen: a screen's canonicalId,
 *  a modal id (→ the modal's base screen), or a raw member frameId. */
function resolveFromScreen(from: string, screens: CanonScreenLike[]): CanonScreenLike | null {
  for (const s of screens) {
    if (s.canonicalId === from) return s;
  }
  for (const s of screens) {
    if ((s.modals ?? []).some((m) => m.id === from)) return s;
  }
  for (const s of screens) {
    if (s.frameIds.includes(from)) return s;
  }
  return null;
}

/**
 * Decide which run screens to requeue for the HIGH-class flow-wiring findings.
 * Pure — no I/O; the orchestrator applies the decisions via updateRunScreen.
 */
export function planFlowRequeue(
  findings: FlowFindingLike[],
  canonScreens: CanonScreenLike[],
  runScreens: RunScreenLike[],
): FlowRequeueDecision[] {
  const byFrame = new Map<string, FlowRequeueDecision>();
  const runByFrame = new Map(runScreens.map((s) => [s.frameId, s]));

  for (const f of findings) {
    if (!isHighClass(f)) continue;
    const cs = resolveFromScreen(f.from, canonScreens);
    if (!cs || !cs.frameIds.length) continue;         // design/build drift we can't map — warn-only stays
    const frameId = cs.frameIds[0];                    // the LEAD frame is the run.screens identity
    const rs = runByFrame.get(frameId);
    if (!rs || rs.status !== 'done') continue;         // only flip built screens; never clobber an existing park
    const line = `${f.status}: ${f.from}→${f.to}${f.detail ? ` — ${f.detail}` : ''}`;
    const existing = byFrame.get(frameId);
    if (existing) existing.findings.push(line);        // one requeue per screen, findings merged
    else byFrame.set(frameId, { frameId, frameName: rs.frameName, canonicalId: cs.canonicalId, findings: [line] });
  }

  return [...byFrame.values()];
}
