import { type Express } from 'express';
import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createTerminalEnv, resolveWorkspace, resolveProjectRoot } from './runtime';
import { AI_ADAPTERS, getAdapter, isAIModel, type AIModel, type AIFormat } from './ai-adapters';
import { appendJobLog, finishJobLog, findJobLogByProject, getJobLog, startJobLog } from './ai-job-log';
import { createClaudeStreamParser } from './ai-stream';
import { appendTurn, getConversation, listConversations } from './conversation-store';
import { extractComponents } from './passes/component-extraction';
import { applyModalOverlays } from './passes/modal-overlay';
import { repointAssetUsage } from './passes/asset-usage';
import { verifyFlowWiring } from './passes/flow-wiring';
import { renameSemantic } from './passes/semantic-rename';
import { deepenTokensAndCleanup } from './passes/token-cleanup';
import { finalizeApp } from './passes/finalize';
import { resolveCanonicalFromCode } from './passes/resolve-canonical';
import { runAssetPhaseOnBuild } from './passes/asset-phase';

const execFileAsync = promisify(execFile);

// Resolve a CLI's ABSOLUTE path. execFile only searches the env PATH, but a CLI
// the user installed may live on a PATH that only their shell PROFILE adds
// (nvm/fnm/mise shims, custom exports). So: try the env PATH, then a login shell
// (`bash -lc`) which sources the profile. Returns null if genuinely not found.
// `bin` comes from our adapter registry (never user input) → safe to interpolate.
const binPathCache = new Map<string, string>();
async function resolveBin(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  if (binPathCache.has(bin)) return binPathCache.get(bin)!;
  // Fall back to the workspace root if the requested cwd doesn't exist yet
  // (e.g. first agent run before the project dir is created).  An absent cwd
  // causes `sh` itself to fail with ENOENT, which was misidentified as the
  // binary being missing.
  const candidates = [cwd, resolveWorkspace()];
  for (const cmd of [`command -v ${bin}`, `command -v ${bin} || bash -lc 'command -v ${bin}'`]) {
    for (const dir of candidates) {
      try {
        const { stdout } = await execFileAsync('sh', ['-c', cmd], { env, cwd: dir, timeout: 6000 });
        const p = stdout.trim().split('\n').filter(Boolean).pop()?.trim();
        if (p) { binPathCache.set(bin, p); return p; }
      } catch { /* try next */ }
    }
  }
  return null;
}

// ── In-flight generation registry (for cancellation / Stop button) ───────────
// Each agent/codegen run registers its child process so POST /api/ai/cancel can
// kill it (and its whole process group — npm/build children included).
interface RunningJob { child: ChildProcess; projectId?: string; startedAt: number }
const runningJobs = new Map<string, RunningJob>();

// Live progress lines per job live in ai-job-log.ts (seeded by the route
// BEFORE the CLI spawns so the first poll already sees a running job).

function killJob(job: RunningJob): void {
  const pid = job.child.pid;
  if (!pid) return;
  // The CLI is its own process-group leader (spawned detached), so a negative
  // pid signals the whole group — kills npm/install/build descendants too.
  try { process.kill(-pid, 'SIGTERM'); } catch { try { job.child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ } }, 2500);
}

// Timeout for AI generation calls (2 minutes for plain text; agentic runs that
// scaffold + install + build need much longer).
const AI_TIMEOUT_MS = 120_000;
const AI_AGENT_TIMEOUT_MS = 600_000;

interface GenerateRequest {
  prompt: string;
  model?: AIModel;
  /** Specific model for the chosen CLI (--model), e.g. opus/sonnet/haiku. */
  modelId?: string;
  sessionId?: string;
  format?: AIFormat;
  conversationId?: string;  // when set, the turn is recorded for durable context
  projectId?: string;
  /** Client-supplied id for this run so it can be cancelled via /api/ai/cancel. */
  jobId?: string;
  /** Agentic mode: the CLI writes files / installs deps directly into the
   *  project (projectId) using its native tools, no permission prompts. */
  agent?: boolean;
}

interface GenerateResponse {
  /** Plain assistant text (NEVER a JSON envelope) — clients depend on this. */
  code: string;
  model: AIModel;
  sessionId?: string;
  conversationId?: string;
  /** Id for /api/ai/progress + /api/ai/cancel (server-generated if absent). */
  jobId: string;
}

// opencode controls tool permissions via its CONFIG, not a CLI flag (unlike
// claude/gemini/codex). In headless `run` mode it can't answer permission
// prompts, so without this it stalls when the agent tries to edit/bash → no
// files written (it just sits until cancelled). HOME = the project cwd in agent
// runs, so opencode reads $cwd/.config/opencode/opencode.jsonc. Grant edit/bash/
// webfetch up front (the run is already scoped to the project folder).
async function ensureOpencodeAgentConfig(cwd: string): Promise<void> {
  const dir = path.join(cwd, '.config', 'opencode');
  const file = path.join(dir, 'opencode.jsonc');
  let config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    // Tolerate JSONC: strip /* */ and // comments before parsing.
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') config = parsed;
  } catch { /* missing/invalid — start fresh */ }
  config.permission = { ...(config.permission as object ?? {}), edit: 'allow', bash: 'allow', webfetch: 'allow' };
  // Default to a FREE opencode-zen model so generation never burns paid tokens.
  // Override with OPENCODE_MODEL (e.g. "opencode/kimi-k2.5-free",
  // "opencode/qwen3.6-plus-free", "opencode/deepseek-v4-flash-free", or any
  // provider/model you've authed). Only set if the user hasn't pinned one.
  if (!config.model) config.model = process.env.OPENCODE_MODEL || 'opencode/minimax-m2.1-free';
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(config, null, 2), 'utf-8');
}

// Run a model through its adapter (structured args + session continuity).
// Exported so the screen-build loop (ai-screen-loop.ts) can spawn implement /
// verify / fix agents through the exact same path (job streaming, session
// resume, cancellation registry) the /api/ai/generate route uses.
export async function runModel(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { sessionId?: string; format?: AIFormat; agent?: boolean; jobId?: string; projectId?: string; modelId?: string } = {},
): Promise<{ text: string; sessionId?: string }> {
  const adapter = getAdapter(model);
  // In agent mode for claude (resume + json capable), use stream-json output:
  // it emits NDJSON events DURING the run (assistant text, tool uses) so the
  // progress endpoint shows live activity, and the terminal "result" event
  // carries the final text + session_id (resumable build session). Plain
  // --output-format json prints nothing until completion — that was the
  // "starting..." forever bug.
  const format: AIFormat | undefined =
    opts.agent && adapter.capabilities.resume
      ? (adapter.capabilities.json ? 'stream-json' : 'json')
      : (adapter.capabilities.json ? opts.format : undefined);
  const args = adapter.buildArgs(prompt, {
    sessionId: adapter.capabilities.resume ? opts.sessionId : undefined,
    format,
    agent: opts.agent,
    modelId: opts.modelId,
  });
  // Resolve the absolute binary path (login-shell aware) so installs on a
  // profile-only PATH are found — otherwise execFile ENOENTs → false "not installed".
  const binPath = (await resolveBin(adapter.bin, env, cwd)) ?? adapter.bin;
  // `detached: true` makes the CLI a process-group leader so cancellation can
  // kill the whole tree (the CLI + any npm/build children it spawns).
  const promise = execFileAsync(binPath, args, {
    env, cwd, timeout: opts.agent ? AI_AGENT_TIMEOUT_MS : AI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    // `detached` is honoured by execFile at runtime (forwarded to spawn) but is
    // absent from its options type — cast so we can group-kill on cancel.
    detached: true,
  } as Parameters<typeof execFileAsync>[2]);
  // Close the child's stdin immediately. The prompt is passed via argv, so the
  // CLIs (claude -p, gemini -p, …) have nothing to read from stdin — but if the
  // pipe is left open they BLOCK on it: claude warns "no stdin data received in
  // 3s" and that warning was surfacing to the user as an error. EOF → proceed now.
  try { promise.child?.stdin?.end(); } catch { /* no stdin pipe */ }
  const jobKey = opts.jobId || opts.projectId;
  if (jobKey && promise.child) {
    runningJobs.set(jobKey, { child: promise.child, projectId: opts.projectId, startedAt: Date.now() });
  }
  // Live progress. The job log entry was seeded by the route BEFORE spawning.
  // stream-json stdout is NDJSON — parse it incrementally into SHORT readable
  // lines (and capture the terminal result event); other formats tee raw
  // stdout. stderr is always teed raw. Listening on the child's streams
  // doesn't disturb execFile's own buffered capture.
  const streamParser = format === 'stream-json'
    ? createClaudeStreamParser((line) => { if (jobKey) appendJobLog(jobKey, line); })
    : null;
  if (promise.child) {
    promise.child.stdout?.on('data', (d: Buffer) => {
      if (streamParser) streamParser.feed(d.toString());
      else if (jobKey) appendJobLog(jobKey, d.toString());
    });
    if (jobKey) promise.child.stderr?.on('data', (d: Buffer) => appendJobLog(jobKey, d.toString()));
  }
  let result;
  try {
    result = await promise;
  } finally {
    if (jobKey) runningJobs.delete(jobKey);
  }
  const { stdout, stderr } = result as { stdout: string; stderr: string };
  const out = stdout.trim();
  // We only reach here on exit code 0 (execFile rejects non-zero). So treat a
  // non-empty stderr as a HARD error only when it isn't just warnings — CLIs emit
  // advisory warnings (deprecations, "no stdin", telemetry notes) on stderr while
  // still succeeding, and those must not fail an otherwise-valid run.
  const stderrTrim = stderr.trim();
  const stderrIsOnlyWarnings = stderrTrim
    .split('\n')
    .every((line) => !line.trim() || /^\s*(warning|warn|note|info|deprecat)/i.test(line));
  if (!out && stderrTrim && !stderrIsOnlyWarnings) {
    throw new Error(`${model} error: ${stderrTrim.slice(0, 300)}`);
  }
  // stream-json: the parser assembled the final text + session_id from the
  // terminal "result" event as the stream arrived.
  if (streamParser) {
    streamParser.flush();
    if (streamParser.result.text !== undefined) {
      return { text: streamParser.result.text, sessionId: streamParser.result.sessionId };
    }
    // Fallback: scan the buffered NDJSON for a result event the live parser
    // missed (shouldn't happen, but the buffered copy is authoritative).
    for (const line of out.split('\n').reverse()) {
      try {
        const j = JSON.parse(line);
        if (j?.type === 'result') return { text: String(j.result ?? ''), sessionId: j.session_id };
      } catch { /* not a JSON line */ }
    }
    // Last resort: a single buffered JSON envelope (older CLI behaviour).
  }
  // claude --output-format json → { result, session_id, ... }. Unwrap so the
  // caller gets clean text + the resumable session id.
  if (format === 'json' || streamParser) {
    try {
      const j = JSON.parse(out);
      return { text: String(j.result ?? j.text ?? out), sessionId: j.session_id ?? j.sessionId };
    } catch { /* not JSON — fall through */ }
  }
  return { text: out };
}

// Bind runModel into the AI observability layer so requireModel/runModelObserved
// use this exact adapter path (job streaming, session resume, cancellation)
// WITHOUT an eval-time circular import. Done once at module load.
import('./ai-observability').then((m) => m.setRunModel(runModel)).catch(() => { /* observability binds lazily on first use */ });

// ── Route registration ────────────────────────────────────────────────────────

export function registerAIRoutes(app: Express): void {

  /**
   * POST /api/ai/generate
   * Body: { prompt: string, model?: 'claude' | 'codex' | 'gemini' | 'opencode', jobId?, ... }
   * Returns: { code, model, sessionId?, conversationId?, jobId } — `code` is
   * ALWAYS plain assistant text. `jobId` (client-supplied or server-generated)
   * keys /api/ai/progress and /api/ai/cancel.
   */
  app.post('/api/ai/generate', async (req, res) => {
    const { prompt, model = 'claude', modelId, sessionId, format, conversationId, projectId, agent, jobId } = req.body as GenerateRequest;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    if (!isAIModel(model)) {
      res.status(400).json({ error: 'model must be claude, codex, or gemini' });
      return;
    }

    // Agent mode writes into the project — it MUST run with cwd = that project
    // so the CLI's auto-approved file/bash tools are scoped to that folder.
    const workspace = resolveWorkspace();
    let cwd = workspace;
    if (agent) {
      if (!projectId) { res.status(400).json({ error: 'projectId is required for agent mode' }); return; }
      const root = resolveProjectRoot(projectId);
      if (!root) { res.status(404).json({ error: 'project not found' }); return; }
      cwd = root;
      // opencode needs its permission config written before it can edit/bash headlessly.
      if (model === 'opencode') { try { await ensureOpencodeAgentConfig(cwd); } catch { /* non-fatal */ } }
    }
    // Always base the env on the WORKSPACE root so the relay PATH (npm-global,
    // mise, etc.) is correct regardless of where cwd points.  The project root
    // (cwd) is passed separately as the working directory for the child process.
    const env = createTerminalEnv(workspace);

    // Register the job SYNCHRONOUSLY, before the CLI spawns, so the very first
    // progress poll already sees a running job (no "no entry yet" race).
    const effectiveJobId = (typeof jobId === 'string' && jobId.trim()) ? jobId.trim() : `job-${randomUUID()}`;
    startJobLog(effectiveJobId, {
      projectId,
      firstLine: `[relay] starting ${model}${agent ? ' agent' : ''}...`,
    });

    try {
      const { text: code, sessionId: newSessionId } = await runModel(model, prompt.trim(), env, cwd, { sessionId, format, agent, jobId: effectiveJobId, projectId, modelId });
      finishJobLog(effectiveJobId, `[relay] ${model} finished`);
      // Durable context: record the user prompt + assistant output when a
      // conversation is in play (survives reconnect/restart).
      let convId = conversationId;
      if (conversationId !== undefined) {
        // First append may create the conversation; chain the assistant turn onto
        // the SAME id so we don't spawn two conversations.
        const c1 = await appendTurn(conversationId || undefined, { role: 'user', content: prompt.trim(), model }, { projectId });
        const c2 = await appendTurn(c1.id, { role: 'assistant', content: code, model }, { projectId });
        convId = c2.id;
      }
      // Prefer the FRESH session id from this run (resumable continuity); fall
      // back to the one the caller sent.
      const outSessionId = newSessionId ?? (getAdapter(model).capabilities.resume ? sessionId : undefined);
      const response: GenerateResponse = {
        code, model,
        ...(outSessionId ? { sessionId: outSessionId } : {}),
        ...(convId ? { conversationId: convId } : {}),
        jobId: effectiveJobId,
      };
      res.json(response);
    } catch (err: any) {
      // execFile rejections carry the REAL reason on .stderr (auth errors, rate
      // limits, etc.) — surface it instead of the bare "Command failed: <cmd>".
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
      const msg = err?.message ?? 'AI generation failed';
      const detail = (stderr || msg).slice(0, 600);
      finishJobLog(effectiveJobId, `[relay] error: ${detail}`);
      // A cancelled run was killed with SIGTERM/SIGKILL — report it as such.
      if (err?.killed || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL') {
        res.status(499).json({ error: 'generation cancelled', cancelled: true, model });
      } else if (msg.includes('ENOENT') || /not found|command not found/.test(detail)) {
        res.status(503).json({ error: `${model} is not installed in this workspace`, model });
      } else if (/not (logged in|authenticated)|auth|API key|GEMINI_API_KEY|login|credential|unauthor/i.test(detail)) {
        res.status(401).json({ error: `${model} needs auth — log in / set its API key in a relay terminal. Detail: ${detail}`, model, detail });
      } else if (err?.code === 'ETIMEDOUT' || /timeout/i.test(detail)) {
        res.status(504).json({ error: `${model} timed out after ${AI_AGENT_TIMEOUT_MS / 1000}s`, model });
      } else {
        res.status(500).json({ error: `${model}: ${detail}`, model, detail });
      }
    }
  });

  /**
   * POST /api/ai/cancel
   * Body: { jobId?: string, projectId?: string }
   * Kills the in-flight generation (and its process group) matching jobId or
   * projectId. Safe to call when nothing is running (returns cancelled: 0).
   */
  app.post('/api/ai/cancel', (req, res) => {
    const { jobId, projectId } = req.body as { jobId?: string; projectId?: string };
    if (!jobId && !projectId) { res.status(400).json({ error: 'jobId or projectId is required' }); return; }
    let cancelled = 0;
    for (const [key, job] of runningJobs) {
      if ((jobId && key === jobId) || (projectId && job.projectId === projectId)) {
        killJob(job);
        runningJobs.delete(key);
        cancelled++;
      }
    }
    res.json({ cancelled });
  });

  /**
   * GET /api/ai/progress?jobId=...  (or ?projectId=...)
   * Live tail of the agent CLI's output for the canvas Generate progress view.
   * Returns { lines, done, running }. `?since=N` returns only lines after index N.
   */
  app.get('/api/ai/progress', (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const key = jobId || projectId;
    if (!key) { res.status(400).json({ error: 'jobId or projectId is required' }); return; }
    // Match by exact jobId, else by projectId (running job first, else the
    // most recent finished log — so the final lines survive job completion).
    // The fallback only applies when NO jobId was supplied: a fresh jobId the
    // server hasn't registered yet must return empty lines, not replay the
    // previous run's finished log.
    let entry = getJobLog(key);
    if (!entry && !jobId && projectId) {
      for (const [k, j] of runningJobs) if (j.projectId === projectId) { entry = getJobLog(k); break; }
      if (!entry) entry = findJobLogByProject(projectId);
    }
    const since = Number(req.query.since) || 0;
    const running = [...runningJobs].some(([k, j]) => k === key || j.projectId === projectId);
    if (!entry) { res.json({ lines: [], total: 0, done: !running, running }); return; }
    res.json({ lines: entry.lines.slice(since), total: entry.lines.length, done: entry.done, running });
  });

  /**
   * GET /api/ai/models
   * Returns which AI models are available in the current workspace.
   */
  app.get('/api/ai/models', async (_req, res) => {
    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);

    const checks = await Promise.all(
      (Object.keys(AI_ADAPTERS) as AIModel[]).map(async model => {
        const adapter = getAdapter(model);
        const resolved = await resolveBin(adapter.bin, env, workspace);
        return { model, available: !!resolved, capabilities: adapter.capabilities };
      }),
    );

    res.json({ models: checks });
  });

  /**
   * POST /api/ai/install  { model }
   * Install a missing AI CLI into the workspace npm-global prefix. Lets the user
   * enable gemini/opencode/etc. without a manual terminal step.
   */
  app.post('/api/ai/install', async (req, res) => {
    const model = (req.body?.model ?? '') as string;
    if (!isAIModel(model)) { res.status(400).json({ error: `Unknown model: ${model}` }); return; }
    const PKG: Record<AIModel, string> = {
      claude: '@anthropic-ai/claude-code',
      codex: '@openai/codex',
      gemini: '@google/gemini-cli',
      opencode: 'opencode-ai',
    };
    const pkg = PKG[model];
    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);
    try {
      const { stdout, stderr } = await execFileAsync('npm', ['install', '-g', pkg], {
        env, cwd: workspace, timeout: 300_000, maxBuffer: 1024 * 1024 * 16,
      });
      // Confirm it's now on PATH.
      let available = false;
      try { await execFileAsync('sh', ['-c', `command -v ${getAdapter(model).bin}`], { env, cwd: workspace, timeout: 3000 }); available = true; } catch { /* not found */ }
      res.json({ model, pkg, available, log: (stdout || '') + (stderr || '') });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to install ${pkg}: ${err?.message ?? err}`, model, pkg });
    }
  });

  /** GET /api/ai/conversations?projectId=… — durable conversation list. */
  app.get('/api/ai/conversations', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ conversations: await listConversations(projectId) });
  });

  /** GET /api/ai/conversations/:id — full conversation with turns. */
  app.get('/api/ai/conversations/:id', async (req, res) => {
    const c = await getConversation(req.params.id);
    if (!c) { res.status(404).json({ error: 'conversation not found' }); return; }
    res.json(c);
  });

  /**
   * POST /api/ai/extract-components — Phase 7a production-readiness pass.
   * De-duplicates structurally-equivalent widgets across an already-built app's
   * screens into shared components (framework-agnostic). Injects the real
   * `runModel` for the AI near-match confirmation step.
   */
  app.post('/api/ai/extract-components', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await extractComponents(projectId, {
        projectRoot,
        model,
        noAiConfirm: req.body?.noAiConfirm === true || !model,
        dryRun: req.body?.dryRun === true,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `extract-components failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/apply-modal-overlays — Phase 7b production-readiness pass.
   * Converts canonical modals (built as standalone full-screen routes) into true
   * overlays presented over their base screen (bottom sheet / dialog / barrier
   * overlay), wired to fire from the real trigger element, and removes the dead
   * route. Framework-agnostic; flutter is implemented. Injects the real
   * `runModel` for the ambiguous-only AI seams (presentation kind / fuzzy trigger).
   */
  app.post('/api/ai/apply-modal-overlays', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await applyModalOverlays(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun: req.body?.dryRun === true,
        onlyModals: Array.isArray(req.body?.onlyModals) ? req.body.onlyModals : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `apply-modal-overlays failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/repoint-asset-usage — Phase 7c production-readiness pass.
   * Re-points asset usages in an already-built app: Material-icon substitutions
   * and opaque/raw asset path string literals → the generated resources symbols
   * (Flutter: `AppAssets.<name>` via SvgPicture.asset / Image.asset).
   * Framework-agnostic; flutter is implemented. The DETERMINISTIC path-literal
   * rewrites + import insertion never use AI; `runModel` is injected ONLY for the
   * hard semantic icon→asset match.
   */
  app.post('/api/ai/repoint-asset-usage', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await repointAssetUsage(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun: req.body?.dryRun === true,
        onlyFiles: Array.isArray(req.body?.onlyFiles) ? req.body.onlyFiles : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `repoint-asset-usage failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/verify-flow-wiring — Phase 7d production-readiness pass.
   * Verifies that the built app realizes the canonical flow graph: for every
   * canonical flow edge {from → to via element}, checks the FROM screen actually
   * navigates to the TO screen's route, and classifies each edge (wired /
   * wrong-target / missing / dead-trigger / unmapped). Conservatively auto-wires
   * ONLY dead-trigger edges (empty handler) whose target route unambiguously
   * exists. Writes the report to .uix/flow-wiring-report.json. Framework-agnostic;
   * flutter is implemented. The route lookup, nav scan, classification and report
   * are deterministic; `runModel` is injected ONLY for fuzzy element location
   * (matching a canonical element label to the actual empty handler in code).
   */
  app.post('/api/ai/verify-flow-wiring', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await verifyFlowWiring(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun: req.body?.dryRun === true,
        noAutoFix: req.body?.noAutoFix === true,
        onlyFrom: Array.isArray(req.body?.onlyFrom) ? req.body.onlyFrom : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `verify-flow-wiring failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/rename-semantic — Phase 7e production-readiness pass.
   * Renames machine-named built screens to their canonical SEMANTIC names
   * (file `screen_290_3657.dart` → `link_banks_screen.dart`, class
   * `IPhone1415Pro57Screen` → `LinkBanksScreen`, route const `c2903657` →
   * `linkBanks`), rewriting every import / AppRoutes reference / router case /
   * cross-screen instantiation across lib/**. Only screens that map to a
   * canonical entry are renamed; unmapped screens keep their machine name.
   * Writes the rename report to .uix/semantic-rename-report.json. Framework-
   * agnostic; flutter is implemented. The find/replace, file moves and import
   * rewrites are deterministic; `runModel` is injected ONLY to derive/sanity-
   * check an identifier when a canonical name is ambiguous/collides.
   */
  app.post('/api/ai/rename-semantic', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await renameSemantic(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun: req.body?.dryRun === true,
        only: Array.isArray(req.body?.only) ? req.body.only : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `rename-semantic failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/deepen-tokens — Phase 7f production-readiness pass (FINAL).
   * Token deepening + dead-code cleanup. Replaces remaining hardcoded literals
   * across lib/** with the EXACT design-system token when the literal's value is
   * identical to a defined token (colors / spacing / radius deterministically;
   * inline text styles only when the AI confirms semantic equivalence to a named
   * AppTheme helper). Removes provably-dead code (unused imports driven by
   * `flutter analyze`, unused private top-level consts, unreferenced private
   * widget classes). Ends with `flutter analyze` and reports before/after counts.
   * Writes the report to .uix/token-cleanup-report.json. Framework-agnostic;
   * flutter is implemented, react is stubbed. All value matching is deterministic;
   * `runModel` is injected ONLY for the inline-text-style judgment call.
   */
  app.post('/api/ai/deepen-tokens', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const result = await deepenTokensAndCleanup(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun: req.body?.dryRun === true,
        skipAnalyze: req.body?.skipAnalyze === true,
        onlyFiles: Array.isArray(req.body?.onlyFiles) ? req.body.onlyFiles : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the pass's seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: `deepen-tokens failed: ${err?.message ?? err}` });
    }
  });

  /**
   * POST /api/ai/finalize-app — Phase 7 FINALIZE (all six passes, build-safe).
   * Runs extractComponents → applyModalOverlays → repointAssetUsage →
   * verifyFlowWiring → renameSemantic → deepenTokensAndCleanup IN ORDER over an
   * ALREADY-BUILT app, framework-agnostic. Build-safe: it snapshots lib/ (+ test/)
   * before the sequence and, after each pass, re-checks `flutter analyze` ≤ baseline
   * AND `flutter build web` — a pass that breaks the build (or throws) is rolled
   * back from the pre-pass snapshot and recorded `reverted`; the sequence never
   * aborts and never leaves the app broken. This is how an existing built app (e.g.
   * Ping) gets finalized WITHOUT a rebuild. Injects the real `runModel` for the
   * passes' AI seams, exactly like the six standalone pass-routes.
   * Body: { projectId, model?, dryRun?, onlyPasses? }. Returns the FinalizeReport.
   */
  app.post('/api/ai/finalize-app', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const env = createTerminalEnv(resolveWorkspace());
    try {
      const report = await finalizeApp(projectId, {
        projectRoot,
        model,
        dryRun: req.body?.dryRun === true,
        onlyPasses: Array.isArray(req.body?.onlyPasses) ? req.body.onlyPasses : undefined,
        env,
        // Adapt relay's runModel (returns {text, sessionId}) to the passes' seam.
        runModel: async (m, prompt, e, cwd, opts) => {
          const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
          return { text };
        },
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: `finalize-app failed: ${err?.message ?? err}` });
    }
  });

  // TEMPORARY (removable): code-based resolve for already-generated apps (e.g. Ping).
  // The generation path canonicalizes from frames; this resolves from emitted code
  // to avoid drift.
  /**
   * POST /api/ai/resolve-app — derive .uix/canonical.json from the EMITTED CODE of
   * an already-generated app, then (by default) run the six Phase-7 passes against
   * the now-matching canonical. For an existing built app, re-canonicalizing from
   * frames drifts from the build (different frame set → screens/modals don't map);
   * resolving from code matches by construction (every canonical screen IS a real
   * screen file). Backs up any existing (possibly drifted, frame-derived) canonical
   * to .uix/canonical.frames.json.bak first. Framework-agnostic; flutter ships.
   * Body: { projectId, model?, dryRun?, finalize? }. Returns
   * { canonical: <summary>, finalizeReport? }.
   */
  app.post('/api/ai/resolve-app', async (req, res) => {
    const projectId = (req.body?.projectId ?? '') as string;
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot) { res.status(400).json({ error: `Invalid projectId: ${projectId}` }); return; }
    const model = isAIModel(req.body?.model) ? (req.body.model as AIModel) : undefined;
    const dryRun = req.body?.dryRun === true;
    const env = createTerminalEnv(resolveWorkspace());
    // Adapt relay's runModel (returns {text, sessionId}) to the pass/resolve seam.
    const runModelSeam = async (m: AIModel, prompt: string, e: NodeJS.ProcessEnv, cwd: string, opts?: { format?: AIFormat }) => {
      const { text } = await runModel(m, prompt, e, cwd, { format: opts?.format, projectId });
      return { text };
    };
    try {
      const canonical = await resolveCanonicalFromCode(projectId, {
        projectRoot,
        model,
        noAi: req.body?.noAi === true || !model,
        dryRun,
        env,
        runModel: runModelSeam,
      });
      const mappedScreens = canonical.screens.length;
      const mappedModals = canonical.modals.filter((m) => m.baseCanonicalId).length;
      const totalIds = canonical.screens.length + canonical.modals.length;
      const mappedIds = mappedScreens + mappedModals;
      const summary = {
        contentHash: canonical.contentHash,
        screens: canonical.screens.length,
        modals: canonical.modals.length,
        modalsWithBase: mappedModals,
        components: canonical.components.length,
        templates: canonical.templates.length,
        edges: canonical.flow.edges.length,
        entryCanonicalId: canonical.flow.entryCanonicalId,
        mappingRate: totalIds ? Number((mappedIds / totalIds).toFixed(3)) : 1,
        warnings: canonical.warnings,
      };

      // PHASE 2 — asset phase. BETWEEN canonical-resolve and finalize: semantic-rename
      // the existing on-disk assets, emit the resources file + asset-map, and re-point
      // code references to AppAssets — as ONE atomic, build-safe unit (rename + repoint
      // share a single build check + rollback; see asset-phase.ts). Skipped when the
      // caller passes `assets: false`. finalize's own repoint pass then runs idempotently
      // (the refs already point at AppAssets, so it's a no-op).
      let assetPhase: unknown = undefined;
      if (req.body?.assets !== false) {
        assetPhase = await runAssetPhaseOnBuild(projectId, {
          projectRoot,
          model,
          dryRun: req.body?.assetsDryRun === true || dryRun,
          env,
          runModel: runModelSeam,
        });
      }

      // Run the six passes against the now-matching canonical (unless opted out or
      // dry-run for resolve itself — finalize's own dryRun is honoured separately).
      let finalizeReport: unknown = undefined;
      if (req.body?.finalize !== false) {
        finalizeReport = await finalizeApp(projectId, {
          projectRoot,
          model,
          dryRun: req.body?.finalizeDryRun === true || dryRun,
          env,
          runModel: runModelSeam,
        });
      }

      res.json({
        canonical: summary,
        ...(assetPhase !== undefined ? { assetPhase } : {}),
        ...(finalizeReport !== undefined ? { finalizeReport } : {}),
      });
    } catch (err: any) {
      res.status(500).json({ error: `resolve-app failed: ${err?.message ?? err}` });
    }
  });
}
