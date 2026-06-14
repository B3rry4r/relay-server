// =============================================================================
// File: src/relay-server/ai-screen-loop.ts
//
// Closed-loop, headless screen builder: implement → verify → fix → verify, until
// the built screen visually matches its reference render (or max iterations).
//
//   1. IMPLEMENT — spawn the coding agent with the client-built packet. It writes
//      the screen into the real project AND a per-screen *preview entrypoint*
//      that runs just this screen inside the app's real theme/router.
//   2. VERIFY    — build that preview entrypoint, screenshot it, and have a
//      SEPARATE (independent) agent compare it to the reference render, emitting
//      a strict JSON verdict {match, score, discrepancies}.
//   3. FIX       — if it doesn't match, resume the coding session with the
//      concrete discrepancies + both images and revise. Re-verify.
//
// Runs in the BACKGROUND: the route returns a jobId immediately and the loop
// survives the client tab closing. Progress streams to the shared job log;
// every iteration (verdict + candidate screenshot) is journaled under
// .uix/screens/<frameId>/ and a final result.json is written for the client.
// =============================================================================

import { type Express } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveProjectRoot, resolveWorkspace, createTerminalEnv, getFlutterRoot } from './runtime';
import { runModel } from './ai-routes';
import { startJobLog, appendJobLog, finishJobLog, subscribeJobLog } from './ai-job-log';
import { captureUrlScreenshot, serveDir } from './visual-routes';
import { isAIModel, type AIModel } from './ai-adapters';
import {
  createRun, getRun, listRuns, updateRunScreen, setRunStatus, setRunSession,
  saveRun, restartRun, appendRunLog, readRunLog,
  markRunCancelled, isRunCancelled, clearRunCancelled,
  isRunActive, markRunActive, clearRunActive,
  type ScreenSpec,
} from './build-run-store';
import { getProjectsRoot } from './runtime';

const execFile = promisify(execFileCb);

interface BuildScreenReq {
  projectId: string;
  model: AIModel;
  modelId?: string;
  sessionId?: string;
  framework: string;
  frameId: string;
  frameName: string;
  width?: number;
  height?: number;
  referenceImagePath: string; // project-relative path to the reference render
  implementPrompt: string;    // the client-built agent packet
  tree?: string;              // IR tree notation — snapshotted for cross-session context
  maxIterations?: number;
  jobId?: string;
  runId?: string;             // durable multi-screen run this screen belongs to
  userNotes?: string;         // the human's design rules — shared with verify/fix
  verify?: boolean;           // when false, implement only (no verify↔fix loop)
}

interface Discrepancy { area?: string; issue: string; severity?: string }
// `recommendation` lets the verify agent — not a fixed counter — drive whether
// another fix pass is worthwhile: 'accept' (done / only trivial cosmetic diffs),
// 'fix' (real fixable discrepancies remain), 'stop' (broken or not converging —
// another auto-pass won't help; defer to a human).
type Recommendation = 'accept' | 'fix' | 'stop';
interface Verdict { match: boolean; score?: number; discrepancies: Discrepancy[]; recommendation: Recommendation }

// ── manifest the implement/fix agent writes (.uix/last-gen.json) ──────────────
interface LastGen {
  entry?: string;        // the screen source file
  previewEntry?: string; // a runnable entrypoint that shows JUST this screen
  framework?: string;
  files?: string[];
}

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, '_');

async function readLastGen(projectRoot: string): Promise<LastGen> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.uix', 'last-gen.json'), 'utf8');
    return JSON.parse(raw) as LastGen;
  } catch { return {}; }
}

// ── prompt builders ───────────────────────────────────────────────────────────

function verifyPrompt(refPath: string, candPath: string, frameName: string, prevScore: number | null, userNotes?: string): string {
  const notes = (userNotes ?? '').trim();
  return [
    `You are a STRICT visual-QA reviewer. Do not write or edit any files.`,
    `Open these two images with your file-reading tool:`,
    `  - REFERENCE (ground truth, the target design): ${refPath}`,
    `  - CANDIDATE (a screenshot of the current build of screen "${frameName}"): ${candPath}`,
    `Compare them carefully: layout & hierarchy, spacing/proportions, colours, typography, text content, icons/illustrations, and overall fidelity.`,
    notes ? `USER RULES / INTENT (authoritative) — respect these when judging; do NOT flag an INTENTIONAL omission as a discrepancy (e.g. if the user said no OS status bar / no default keyboard, then a missing status bar or keyboard is CORRECT, not a discrepancy):\n${notes}` : '',
    prevScore != null ? `The previous pass scored ${prevScore}/100 — judge whether this pass actually improved; if it's no better, another automated fix is unlikely to help (lean towards "stop").` : '',
    `If the reference shows a MODAL / OVERLAY / SHEET / POPUP over a base screen, the candidate should render that overlay ON TOP of the (reused) base screen — flag a discrepancy if the candidate rebuilt the whole screen or rendered the overlay as a standalone full page.`,
    `Respond with ONLY a single JSON object (no prose, no code fences):`,
    `{"match": <true|false>, "score": <0-100>, "recommendation": "accept|fix|stop", "discrepancies": [{"area":"<where>","issue":"<what's wrong vs the reference>","severity":"high|med|low"}]}`,
    `- "match": true ONLY if visually near-identical (no high/med discrepancies).`,
    `- "recommendation": "accept" = good enough, stop now (a match, or only trivial cosmetic diffs); "fix" = real fixable discrepancies remain and another pass is worthwhile; "stop" = broken / way off / clearly NOT converging, so another automated pass won't help — defer to a human.`,
    `List every concrete difference; be specific and actionable.`,
  ].filter(Boolean).join('\n');
}

function fixPrompt(frameName: string, refPath: string, candPath: string, v: Verdict, userNotes?: string): string {
  const items = v.discrepancies.map((d, i) => `  ${i + 1}. [${d.severity ?? 'med'}] ${d.area ? d.area + ': ' : ''}${d.issue}`).join('\n');
  const notes = (userNotes ?? '').trim();
  return [
    `The screen "${frameName}" you built does NOT yet match its reference design (visual score ${v.score ?? '?'} / 100).`,
    `Reference (ground truth): ${refPath}`,
    `Current build screenshot:  ${candPath}`,
    notes ? `USER RULES / INTENT (authoritative — DO NOT violate, even to satisfy a discrepancy below; e.g. do NOT add an OS status bar or default keyboard if the user excluded them):\n${notes}\n` : '',
    `Open BOTH images, then revise the EXISTING screen file(s) to fix these specific discrepancies — but skip any that contradict the user rules above:`,
    items || '  (general fidelity — bring it closer to the reference)',
    `Reuse the project's existing design system / theme / shared components — do not restyle inline.`,
    `Keep the preview entrypoint working and keep .uix/last-gen.json accurate (including "previewEntry"). Output a one-line summary.`,
  ].filter(Boolean).join('\n');
}

// ── parse the verify agent's JSON verdict (robust to fences / stray prose) ─────
function parseVerdict(text: string): Verdict {
  // A broken/unparseable verify result is itself a reason to stop (not to keep
  // burning fix passes blindly), so default recommendation 'stop'.
  const fail = (issue: string): Verdict => ({ match: false, discrepancies: [{ issue, severity: 'high' }], recommendation: 'stop' });
  if (!text) return fail('verify agent produced no output');
  // Grab the largest brace-balanced JSON object in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('verify output had no JSON object');
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const match = !!j.match;
    const discrepancies = Array.isArray(j.discrepancies)
      ? j.discrepancies.map((d: any) => ({ area: d?.area, issue: String(d?.issue ?? d ?? 'unspecified'), severity: d?.severity }))
      : [];
    const rec: Recommendation = j.recommendation === 'accept' || j.recommendation === 'fix' || j.recommendation === 'stop'
      ? j.recommendation
      : (match ? 'accept' : (discrepancies.length ? 'fix' : 'accept'));
    return { match, score: typeof j.score === 'number' ? j.score : undefined, discrepancies, recommendation: rec };
  } catch { return fail('verify output JSON was malformed'); }
}

// ── render the preview entrypoint of the REAL project to a PNG ────────────────
// Builds the screen's standalone entrypoint within the actual project (real
// theme/fonts/router) and screenshots it. Returns the PNG or a build-error tail.
async function renderPreview(
  projectRoot: string, framework: string, previewEntry: string | undefined,
  width: number, height: number, env: NodeJS.ProcessEnv,
): Promise<{ png?: Buffer; error?: string }> {
  const fw = framework.toLowerCase();
  try {
    if (fw === 'flutter') {
      const flutter = path.join(getFlutterRoot(), 'bin', 'flutter');
      if (!fsSync.existsSync(flutter)) return { error: 'Flutter SDK not available' };
      if (!fsSync.existsSync(path.join(projectRoot, 'web'))) {
        await execFile(flutter, ['create', '--platforms=web', '.'], { cwd: projectRoot, env, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      }
      const target = previewEntry && fsSync.existsSync(path.join(projectRoot, previewEntry)) ? previewEntry : 'lib/main.dart';
      const args = ['build', 'web', '--release', '-t', target];
      try {
        await execFile(flutter, args, { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
      } catch (e: any) {
        return { error: `flutter build web failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
      }
      const webDir = path.join(projectRoot, 'build', 'web');
      if (!fsSync.existsSync(path.join(webDir, 'index.html'))) return { error: 'flutter build produced no web output' };
      const srv = await serveDir(webDir);
      try {
        const png = await captureUrlScreenshot(srv.url, width, height, 60000);
        return png ? { png } : { error: 'screenshot of built Flutter app failed' };
      } finally { srv.close(); }
    }

    // Web (Vite/React/Next static export). Best-effort: build, serve the output
    // dir, navigate to the preview route if one was provided.
    try {
      await execFile('npm', ['run', 'build'], { cwd: projectRoot, env, timeout: 360000, maxBuffer: 10 * 1024 * 1024 });
    } catch (e: any) {
      return { error: `web build (npm run build) failed:\n${`${e?.stdout || ''}\n${e?.stderr || e?.message || ''}`.trim().slice(-1500)}` };
    }
    const outDir = ['dist', 'out', 'build'].map(d => path.join(projectRoot, d)).find(d => fsSync.existsSync(path.join(d, 'index.html')));
    if (!outDir) return { error: 'web build produced no servable output (dist/ out/ build/)' };
    const srv = await serveDir(outDir);
    try {
      const route = previewEntry && previewEntry.startsWith('/') ? previewEntry : '';
      const url = route ? `${srv.url.replace(/\/index\.html$/, '')}${route}` : srv.url;
      const png = await captureUrlScreenshot(url, width, height, 60000);
      return png ? { png } : { error: 'screenshot of built web app failed' };
    } finally { srv.close(); }
  } catch (e: any) {
    return { error: e?.message || 'preview render failed' };
  }
}

// ── the loop ──────────────────────────────────────────────────────────────────
async function runScreenLoop(req: BuildScreenReq, projectRoot: string, jobId: string): Promise<string | undefined> {
  const { model, modelId, framework, frameId, frameName, referenceImagePath, implementPrompt } = req;
  const width = req.width || 393, height = req.height || 852;
  // maxIterations is a SAFETY BACKSTOP, not the policy: the verify agent's
  // recommendation + score-plateau detection decide when to actually stop, so a
  // screen that matches on pass 1 costs 1 pass, not N.
  const maxIterations = Math.min(Math.max(req.maxIterations ?? 4, 1), 6);
  // Build the env from the WORKSPACE root (like /api/ai/generate), NOT the
  // project: createTerminalEnv sets HOME to its arg, and the claude/gemini CLIs
  // read their login from $HOME/.claude (etc.). Rooting it at the project made
  // the spawned agent look for credentials in <project>/.claude → "claude error
  // login", and mis-rooted every tool path (Flutter/npm/mise). The project is
  // the cwd of each runModel/build call, passed separately.
  const env = createTerminalEnv(resolveWorkspace());
  const screenDir = path.join(projectRoot, '.uix', 'screens', sanitizeId(frameId));
  await fs.mkdir(screenDir, { recursive: true });
  const relScreenDir = path.join('.uix', 'screens', sanitizeId(frameId));
  // Snapshot the IR tree so a future session has this screen's design context
  // (exact colours/text/layout) without re-fetching from the design source.
  if (req.tree) { try { await fs.writeFile(path.join(screenDir, 'ir.txt'), req.tree); } catch { /* non-fatal */ } }
  if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'building' }); } catch { /* non-fatal */ } }

  let session = req.sessionId;
  let finalVerdict: Verdict | null = null;
  let matched = false;
  let accepted = false;
  let stopReason = 'reached iteration cap';
  let iterationsRun = 0;
  let prevScore: number | null = null;

  // 1. IMPLEMENT
  appendJobLog(jobId, `[loop] implement: "${frameName}"`);
  const impl = await runModel(model, implementPrompt, env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
  if (impl.sessionId) session = impl.sessionId;

  // verify:false (or no reference render to compare against) → implement-only.
  // Write a result and mark the screen done so the run still completes.
  if (req.verify === false || !referenceImagePath) {
    const result = {
      frameId, frameName, framework, matched: false, accepted: true,
      stopReason: 'verify disabled — implemented only', iterations: 1, maxIterations,
      finalVerdict: null, sessionId: session, referenceImage: referenceImagePath,
      ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined, at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
    if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched: false, sessionId: session }); } catch { /* non-fatal */ } }
    finishJobLog(jobId, `[loop] done: "${frameName}" implemented (verify off)`);
    return session;
  }

  // 2/3. VERIFY ↔ FIX — the verify agent's recommendation + score plateau drive
  // when to stop; maxIterations is only a runaway backstop.
  for (let iter = 1; iter <= maxIterations; iter++) {
    iterationsRun = iter;
    const lastGen = await readLastGen(projectRoot);
    appendJobLog(jobId, `[loop] verify ${iter}/${maxIterations}: building & screenshotting`);
    const shot = await renderPreview(projectRoot, lastGen.framework || framework, lastGen.previewEntry, width, height, env);

    let verdict: Verdict;
    let candRel: string | null = null;
    if (shot.error || !shot.png) {
      // A failed build IS a failure to fix — feed the compiler error back (and
      // keep fixing: a build error is exactly what another pass should repair).
      verdict = { match: false, score: 0, discrepancies: [{ area: 'build', issue: shot.error || 'the screen failed to build/screenshot', severity: 'high' }], recommendation: 'fix' };
      appendJobLog(jobId, `[loop] verify ${iter}: build/screenshot failed`);
    } else {
      const candAbs = path.join(screenDir, `cand-${iter}.png`);
      await fs.writeFile(candAbs, shot.png);
      candRel = path.join(relScreenDir, `cand-${iter}.png`);
      appendJobLog(jobId, `[loop] verify ${iter}: comparing to reference`);
      const v = await runModel(model, verifyPrompt(referenceImagePath, candRel, frameName, prevScore, req.userNotes), env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
      verdict = parseVerdict(v.text);
    }
    finalVerdict = verdict;
    await fs.writeFile(path.join(screenDir, `iter-${iter}.json`), JSON.stringify({ iter, verdict, candidate: candRel, at: new Date().toISOString() }, null, 2));
    appendJobLog(jobId, `[loop] verify ${iter}: match=${verdict.match} score=${verdict.score ?? '?'} rec=${verdict.recommendation} issues=${verdict.discrepancies.length}`);

    // STOP CONDITIONS (verify-agent driven, not a fixed count):
    if (verdict.match || verdict.recommendation === 'accept') {
      matched = verdict.match; accepted = true; stopReason = verdict.match ? 'matched the reference' : 'verify agent accepted (good enough)';
      break;
    }
    if (verdict.recommendation === 'stop') { stopReason = 'verify agent said stop (broken / not converging)'; break; }
    // Plateau guard: after a real attempt, if the score didn't improve, more
    // automated passes are unlikely to help — stop rather than waste calls.
    const score = verdict.score ?? 0;
    if (iter >= 2 && prevScore != null && score <= prevScore) { stopReason = `score plateaued (${prevScore}→${score})`; break; }
    prevScore = score;
    if (iter === maxIterations) break;

    // FIX (resume the implementation session so the agent keeps full context).
    appendJobLog(jobId, `[loop] fix ${iter}: applying ${verdict.discrepancies.length} change(s)`);
    const fix = await runModel(model, fixPrompt(frameName, referenceImagePath, candRel ?? '(build failed — no screenshot)', verdict, req.userNotes), env, projectRoot, { agent: true, modelId, sessionId: session, jobId, projectId: req.projectId });
    if (fix.sessionId) session = fix.sessionId;
  }

  const result = {
    frameId, frameName, framework, matched, accepted, stopReason,
    iterations: iterationsRun, maxIterations,
    finalVerdict, sessionId: session,
    referenceImage: referenceImagePath,
    ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined,
    at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
  // Mark this screen DONE in its durable run (the screen built; matched is a
  // quality flag, not a completion flag).
  if (req.runId) { try { await updateRunScreen(req.projectId, req.runId, frameId, { status: 'done', matched, sessionId: session }); } catch { /* non-fatal */ } }
  finishJobLog(jobId, `[loop] done: "${frameName}" ${matched ? 'MATCHED' : accepted ? 'accepted' : 'needs review'} after ${iterationsRun} iteration(s) — ${stopReason}`);
  return session;
}

// ── server-orchestrated full-app build ─────────────────────────────────────────
// Builds every screen in a durable run SERVER-SIDE, one after another, threading
// the CLI session for cross-screen context. Survives the browser tab closing;
// resumable after Stop / rate-limit / redeploy (already-done screens are skipped).
// Every job-log line for the run's screens is teed to the durable run log so the
// client can replay the full history on reconnect.
async function runAppLoop(projectId: string, runId: string): Promise<void> {
  if (isRunActive(runId)) return;          // already orchestrating in this process
  markRunActive(runId);
  clearRunCancelled(runId);
  const projectRoot = resolveProjectRoot(projectId);
  if (!projectRoot || !fsSync.existsSync(projectRoot)) { clearRunActive(runId); return; }

  // Tee every screen job's log line to the run's durable, replayable log.
  const unsub = subscribeJobLog((e) => {
    if (e.kind !== 'line' || !e.line || !e.jobKey.startsWith(`${runId}:`)) return;
    void appendRunLog(projectId, runId, e.line);
  });

  try {
    const run = await getRun(projectId, runId);
    if (!run) return;
    await appendRunLog(projectId, runId, `[run] start — ${run.screens.length} screen(s), model=${run.model}, verify=${run.verify !== false}`);
    let session = run.sessionId;

    for (const screen of run.screens) {
      if (isRunCancelled(runId)) {
        await appendRunLog(projectId, runId, '[run] stopped by user');
        await setRunStatus(projectId, runId, 'stopped');
        return;
      }
      // Skip screens already built (resume): re-read live status each time.
      const fresh = await getRun(projectId, runId);
      const cur = fresh?.screens.find(s => s.frameId === screen.frameId);
      if (cur?.status === 'done') { session = cur.sessionId || session; continue; }
      if (!screen.spec) {
        await appendRunLog(projectId, runId, `[run] skip "${screen.frameName}" — no build spec`);
        await updateRunScreen(projectId, runId, screen.frameId, { status: 'failed' });
        continue;
      }
      const jobId = `${runId}:${screen.frameId}`;
      startJobLog(jobId, { projectId, firstLine: `[loop] queued "${screen.frameName}"` });
      const sreq: BuildScreenReq = {
        projectId, model: run.model as AIModel, modelId: run.modelId, sessionId: session,
        framework: run.framework || 'flutter', frameId: screen.frameId, frameName: screen.frameName,
        width: screen.spec.width, height: screen.spec.height,
        referenceImagePath: screen.spec.referenceImagePath, implementPrompt: screen.spec.packet,
        tree: screen.spec.tree, maxIterations: run.maxIterations, jobId, runId,
        userNotes: run.userNotes, verify: run.verify,
      };
      try {
        const sess = await runScreenLoop(sreq, projectRoot, jobId);
        if (sess) { session = sess; await setRunSession(projectId, runId, session); }
      } catch (e: any) {
        appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
        finishJobLog(jobId, '[loop] failed');
        await updateRunScreen(projectId, runId, screen.frameId, { status: 'failed' });
      }
    }

    if (isRunCancelled(runId)) {
      await appendRunLog(projectId, runId, '[run] stopped by user');
      await setRunStatus(projectId, runId, 'stopped');
      return;
    }
    const done = await getRun(projectId, runId);
    const built = done?.screens.filter(s => s.status === 'done').length ?? 0;
    await setRunStatus(projectId, runId, 'done');
    await appendRunLog(projectId, runId, `[run] complete — ${built}/${done?.screens.length ?? 0} built`);
  } catch (e: any) {
    await appendRunLog(projectId, runId, `[run] error: ${e?.message || 'unknown'}`);
  } finally {
    unsub();
    clearRunActive(runId);
    clearRunCancelled(runId);
  }
}

/**
 * Re-start any run that was 'running' when the process died (e.g. a redeploy).
 * Called once on server boot so a full-app build survives a container restart.
 */
export async function resumeInterruptedRuns(): Promise<void> {
  try {
    const root = getProjectsRoot();
    if (!fsSync.existsSync(root)) return;
    const projectIds = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    for (const projectId of projectIds) {
      const runs = await listRuns(projectId, 50);
      for (const r of runs) {
        if (r.status === 'running' && !isRunActive(r.id)) {
          void appendRunLog(projectId, r.id, '[run] resuming after server restart');
          void runAppLoop(projectId, r.id);
        }
      }
    }
  } catch { /* boot resume is best-effort */ }
}

export function registerScreenLoopRoutes(app: Express): void {
  /**
   * POST /api/ai/build-screen — start the headless implement→verify→fix loop.
   * Returns { jobId } immediately; poll /api/ai/progress and read the per-screen
   * .uix/screens/<frameId>/result.json when the job is done.
   */
  app.post('/api/ai/build-screen', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !isAIModel(b.model) || !b.frameId || !b.implementPrompt || !b.referenceImagePath) {
      res.status(400).json({ error: 'projectId, valid model, frameId, referenceImagePath and implementPrompt are required' });
      return;
    }
    const projectRoot = resolveProjectRoot(b.projectId);
    if (!projectRoot || !fsSync.existsSync(projectRoot)) {
      res.status(404).json({ error: `project not found: ${b.projectId}` });
      return;
    }
    const jobId = b.jobId || `${b.projectId}:${b.frameId}:loop:${Date.now()}`;
    startJobLog(jobId, { projectId: b.projectId, firstLine: `[loop] queued "${b.frameName ?? b.frameId}"` });
    res.json({ jobId, started: true });
    // Fire-and-forget: the loop owns its own logging + error handling so the
    // client tab can close while it runs.
    void runScreenLoop(b as BuildScreenReq, projectRoot, jobId).catch((e: any) => {
      appendJobLog(jobId, `[loop] error: ${e?.message || 'unknown'}`);
      finishJobLog(jobId, '[loop] failed');
      // Mark the screen FAILED in its run so resume re-attempts it.
      if (b.runId) void updateRunScreen(b.projectId, b.runId, b.frameId, { status: 'failed' }).catch(() => {});
    });
  });

  // ── Durable build runs (resumable after Stop / error / rate limit / redeploy) ──
  // POST /api/ai/runs — create a run for a set of screens. Returns the run.
  app.post('/api/ai/runs', async (req, res) => {
    const b = req.body ?? {};
    if (!b.projectId || !Array.isArray(b.screens) || b.screens.length === 0) {
      res.status(400).json({ error: 'projectId and a non-empty screens[] are required' });
      return;
    }
    if (!isAIModel(b.model)) { res.status(400).json({ error: 'a valid model is required' }); return; }
    const run = await createRun(b.projectId, {
      kind: b.kind === 'selected' || b.kind === 'single' ? b.kind : 'whole-app',
      framework: b.framework, figStorageKey: b.figStorageKey,
      model: b.model, modelId: b.modelId,
      maxIterations: typeof b.maxIterations === 'number' ? b.maxIterations : undefined,
      verify: b.verify !== false,
      userNotes: typeof b.userNotes === 'string' ? b.userNotes : undefined,
      screens: b.screens.map((s: any): { frameId: string; frameName: string; spec?: ScreenSpec } => ({
        frameId: String(s.frameId),
        frameName: String(s.frameName ?? s.frameId),
        spec: s.spec && s.spec.packet ? {
          packet: String(s.spec.packet),
          referenceImagePath: String(s.spec.referenceImagePath ?? ''),
          tree: typeof s.spec.tree === 'string' ? s.spec.tree : undefined,
          width: typeof s.spec.width === 'number' ? s.spec.width : undefined,
          height: typeof s.spec.height === 'number' ? s.spec.height : undefined,
        } : undefined,
      })),
    });
    if (!run) { res.status(404).json({ error: `project not found: ${b.projectId}` }); return; }
    res.json({ run });
  });

  // POST /api/ai/runs/:runId/start { projectId, steerNotes?, restart? } — kick off
  // (or resume) the SERVER-SIDE orchestration of the whole run. Returns immediately.
  app.post('/api/ai/runs/:runId/start', async (req, res) => {
    const b = req.body ?? {};
    const projectId = b.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    let run = await getRun(projectId, runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    if (isRunActive(runId)) { res.json({ run, started: false, alreadyRunning: true }); return; }
    clearRunCancelled(runId);
    if (b.restart) run = await restartRun(projectId, runId) ?? run;
    const steer = typeof b.steerNotes === 'string' ? b.steerNotes.trim() : '';
    if (steer) {
      run.userNotes = [run.userNotes?.trim(), steer].filter(Boolean).join('\n\n');
      if (run.status !== 'running') run.status = 'running';
      await saveRun(projectId, run);
    } else if (run.status === 'stopped') {
      run.status = 'running';
      await saveRun(projectId, run);
    }
    void runAppLoop(projectId, runId).catch(() => {});
    res.json({ run, started: true });
  });

  // POST /api/ai/runs/:runId/stop { projectId } — request a graceful stop after
  // the in-flight screen finishes. Marks the run 'stopped' (resumable later).
  app.post('/api/ai/runs/:runId/stop', async (req, res) => {
    const projectId = (req.body?.projectId ?? req.query.projectId) as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const runId = req.params.runId;
    markRunCancelled(runId);
    await appendRunLog(projectId, runId, '[run] stop requested');
    if (!isRunActive(runId)) await setRunStatus(projectId, runId, 'stopped');
    res.json({ stopped: true });
  });

  // GET /api/ai/runs/:runId/log?projectId= — the durable, replayable run log.
  app.get('/api/ai/runs/:runId/log', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const log = await readRunLog(projectId, req.params.runId);
    res.json({ log, active: isRunActive(req.params.runId) });
  });

  // GET /api/ai/runs?projectId= — list recent runs (newest first).
  app.get('/api/ai/runs', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    res.json({ runs: await listRuns(projectId) });
  });

  // GET /api/ai/runs/:runId?projectId= — one run.
  app.get('/api/ai/runs/:runId', async (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const run = await getRun(projectId, req.params.runId);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    res.json({ run });
  });
}
