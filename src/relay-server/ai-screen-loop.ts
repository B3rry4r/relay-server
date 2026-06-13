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
import { resolveProjectRoot, createTerminalEnv, getFlutterRoot } from './runtime';
import { runModel } from './ai-routes';
import { startJobLog, appendJobLog, finishJobLog } from './ai-job-log';
import { captureUrlScreenshot, serveDir } from './visual-routes';
import { isAIModel, type AIModel } from './ai-adapters';

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
}

interface Discrepancy { area?: string; issue: string; severity?: string }
interface Verdict { match: boolean; score?: number; discrepancies: Discrepancy[] }

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

function verifyPrompt(refPath: string, candPath: string, frameName: string): string {
  return [
    `You are a STRICT visual-QA reviewer. Do not write or edit any files.`,
    `Open these two images with your file-reading tool:`,
    `  - REFERENCE (ground truth, the target design): ${refPath}`,
    `  - CANDIDATE (a screenshot of the current build of screen "${frameName}"): ${candPath}`,
    `Compare them carefully: layout & hierarchy, spacing/proportions, colours, typography, text content, icons/illustrations, and overall fidelity.`,
    `Respond with ONLY a single JSON object (no prose, no code fences):`,
    `{"match": <true|false>, "score": <0-100>, "discrepancies": [{"area":"<where>","issue":"<what's wrong vs the reference>","severity":"high|med|low"}]}`,
    `Set "match" true ONLY if the candidate is visually near-identical to the reference (no high/med discrepancies). List every concrete difference you see; be specific and actionable.`,
  ].join('\n');
}

function fixPrompt(frameName: string, refPath: string, candPath: string, v: Verdict): string {
  const items = v.discrepancies.map((d, i) => `  ${i + 1}. [${d.severity ?? 'med'}] ${d.area ? d.area + ': ' : ''}${d.issue}`).join('\n');
  return [
    `The screen "${frameName}" you built does NOT yet match its reference design (visual score ${v.score ?? '?'} / 100).`,
    `Reference (ground truth): ${refPath}`,
    `Current build screenshot:  ${candPath}`,
    `Open BOTH images, then revise the EXISTING screen file(s) to fix these specific discrepancies:`,
    items || '  (general fidelity — bring it closer to the reference)',
    `Reuse the project's existing design system / theme / shared components — do not restyle inline.`,
    `Keep the preview entrypoint working and keep .uix/last-gen.json accurate (including "previewEntry"). Output a one-line summary.`,
  ].join('\n');
}

// ── parse the verify agent's JSON verdict (robust to fences / stray prose) ─────
function parseVerdict(text: string): Verdict {
  const fail = (issue: string): Verdict => ({ match: false, discrepancies: [{ issue, severity: 'high' }] });
  if (!text) return fail('verify agent produced no output');
  // Grab the largest brace-balanced JSON object in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('verify output had no JSON object');
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    return {
      match: !!j.match,
      score: typeof j.score === 'number' ? j.score : undefined,
      discrepancies: Array.isArray(j.discrepancies)
        ? j.discrepancies.map((d: any) => ({ area: d?.area, issue: String(d?.issue ?? d ?? 'unspecified'), severity: d?.severity }))
        : [],
    };
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
async function runScreenLoop(req: BuildScreenReq, projectRoot: string, jobId: string): Promise<void> {
  const { model, modelId, framework, frameId, frameName, referenceImagePath, implementPrompt } = req;
  const width = req.width || 393, height = req.height || 852;
  const maxIterations = Math.min(Math.max(req.maxIterations ?? 3, 1), 5);
  const env = createTerminalEnv(projectRoot);
  const screenDir = path.join(projectRoot, '.uix', 'screens', sanitizeId(frameId));
  await fs.mkdir(screenDir, { recursive: true });
  const relScreenDir = path.join('.uix', 'screens', sanitizeId(frameId));
  // Snapshot the IR tree so a future session has this screen's design context
  // (exact colours/text/layout) without re-fetching from the design source.
  if (req.tree) { try { await fs.writeFile(path.join(screenDir, 'ir.txt'), req.tree); } catch { /* non-fatal */ } }

  let session = req.sessionId;
  let finalVerdict: Verdict | null = null;
  let matched = false;
  let iterationsRun = 0;

  // 1. IMPLEMENT
  appendJobLog(jobId, `[loop] implement: "${frameName}"`);
  const impl = await runModel(model, implementPrompt, env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
  if (impl.sessionId) session = impl.sessionId;

  // 2/3. VERIFY ↔ FIX
  for (let iter = 1; iter <= maxIterations; iter++) {
    iterationsRun = iter;
    const lastGen = await readLastGen(projectRoot);
    appendJobLog(jobId, `[loop] verify ${iter}/${maxIterations}: building & screenshotting`);
    const shot = await renderPreview(projectRoot, lastGen.framework || framework, lastGen.previewEntry, width, height, env);

    let verdict: Verdict;
    let candRel: string | null = null;
    if (shot.error || !shot.png) {
      // A failed build IS a failure to fix — feed the compiler error back.
      verdict = { match: false, score: 0, discrepancies: [{ area: 'build', issue: shot.error || 'the screen failed to build/screenshot', severity: 'high' }] };
      appendJobLog(jobId, `[loop] verify ${iter}: build/screenshot failed`);
    } else {
      const candAbs = path.join(screenDir, `cand-${iter}.png`);
      await fs.writeFile(candAbs, shot.png);
      candRel = path.join(relScreenDir, `cand-${iter}.png`);
      appendJobLog(jobId, `[loop] verify ${iter}: comparing to reference`);
      const v = await runModel(model, verifyPrompt(referenceImagePath, candRel, frameName), env, projectRoot, { agent: true, modelId, jobId, projectId: req.projectId });
      verdict = parseVerdict(v.text);
    }
    finalVerdict = verdict;
    await fs.writeFile(path.join(screenDir, `iter-${iter}.json`), JSON.stringify({ iter, verdict, candidate: candRel, at: new Date().toISOString() }, null, 2));
    appendJobLog(jobId, `[loop] verify ${iter}: match=${verdict.match} score=${verdict.score ?? '?'} issues=${verdict.discrepancies.length}`);

    if (verdict.match) { matched = true; break; }
    if (iter === maxIterations) break;

    // FIX (resume the implementation session so the agent keeps full context).
    appendJobLog(jobId, `[loop] fix ${iter}: applying ${verdict.discrepancies.length} change(s)`);
    const fix = await runModel(model, fixPrompt(frameName, referenceImagePath, candRel ?? '(build failed — no screenshot)', verdict), env, projectRoot, { agent: true, modelId, sessionId: session, jobId, projectId: req.projectId });
    if (fix.sessionId) session = fix.sessionId;
  }

  const result = {
    frameId, frameName, framework, matched,
    iterations: iterationsRun, maxIterations,
    finalVerdict, sessionId: session,
    referenceImage: referenceImagePath,
    ir: req.tree ? path.join(relScreenDir, 'ir.txt') : undefined,
    at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(screenDir, 'result.json'), JSON.stringify(result, null, 2));
  finishJobLog(jobId, `[loop] done: "${frameName}" matched=${matched} after ${iterationsRun} iteration(s)`);
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
    });
  });
}
