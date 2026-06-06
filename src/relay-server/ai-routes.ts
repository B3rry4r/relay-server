import { type Express } from 'express';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createTerminalEnv, resolveWorkspace, resolveProjectRoot } from './runtime';
import { AI_ADAPTERS, getAdapter, isAIModel, type AIModel, type AIFormat } from './ai-adapters';
import { appendTurn, getConversation, listConversations } from './conversation-store';

const execFileAsync = promisify(execFile);

// Resolve a CLI's ABSOLUTE path. execFile only searches the env PATH, but a CLI
// the user installed may live on a PATH that only their shell PROFILE adds
// (nvm/fnm/mise shims, custom exports). So: try the env PATH, then a login shell
// (`bash -lc`) which sources the profile. Returns null if genuinely not found.
// `bin` comes from our adapter registry (never user input) → safe to interpolate.
const binPathCache = new Map<string, string>();
async function resolveBin(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  if (binPathCache.has(bin)) return binPathCache.get(bin)!;
  for (const cmd of [`command -v ${bin}`, `command -v ${bin} || bash -lc 'command -v ${bin}'`]) {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', cmd], { env, cwd, timeout: 6000 });
      const p = stdout.trim().split('\n').filter(Boolean).pop()?.trim();
      if (p) { binPathCache.set(bin, p); return p; }
    } catch { /* try the next resolution strategy */ }
  }
  return null;
}

// ── In-flight generation registry (for cancellation / Stop button) ───────────
// Each agent/codegen run registers its child process so POST /api/ai/cancel can
// kill it (and its whole process group — npm/build children included).
interface RunningJob { child: ChildProcess; projectId?: string; startedAt: number }
const runningJobs = new Map<string, RunningJob>();

// Live progress: the agent CLI's stdout/stderr lines, per job, so the canvas
// Generate tab can show "what the agent is doing". Capped + auto-expired.
interface JobLog { lines: string[]; done: boolean; ts: number }
const jobLogs = new Map<string, JobLog>();
const MAX_LOG_LINES = 400;
function appendJobLog(jobKey: string, chunk: string): void {
  const entry = jobLogs.get(jobKey);
  if (!entry) return;
  for (const raw of chunk.split('\n')) {
    const line = raw.replace(/\[[0-9;]*m/g, '').trimEnd();   // strip ANSI colour
    if (line) entry.lines.push(line);
  }
  if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
  entry.ts = Date.now();
}
// Drop logs older than 10 min so the map can't grow unbounded.
function pruneJobLogs(): void {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of jobLogs) if (v.done && v.ts < cutoff) jobLogs.delete(k);
}

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
  code: string;
  model: AIModel;
  sessionId?: string;
  conversationId?: string;
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
async function runModel(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { sessionId?: string; format?: AIFormat; agent?: boolean; jobId?: string; projectId?: string; modelId?: string } = {},
): Promise<{ text: string; sessionId?: string }> {
  const adapter = getAdapter(model);
  // In agent mode for a resume-capable model (claude), use JSON output so we
  // can capture the CLI's own session_id — that's what makes the agent
  // remember prior screens across calls (true resumable build session).
  const format: AIFormat | undefined =
    opts.agent && adapter.capabilities.resume ? 'json' : (adapter.capabilities.json ? opts.format : undefined);
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
    // Tee live output into the job log for the canvas progress view. Listening
    // on the child's streams doesn't disturb execFile's own buffered capture.
    pruneJobLogs();
    jobLogs.set(jobKey, { lines: [], done: false, ts: Date.now() });
    promise.child.stdout?.on('data', (d: Buffer) => appendJobLog(jobKey, d.toString()));
    promise.child.stderr?.on('data', (d: Buffer) => appendJobLog(jobKey, d.toString()));
  }
  let result;
  try {
    result = await promise;
  } finally {
    if (jobKey) {
      runningJobs.delete(jobKey);
      const entry = jobLogs.get(jobKey);
      if (entry) { entry.done = true; entry.ts = Date.now(); }
    }
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
  // claude --output-format json → { result, session_id, ... }. Unwrap so the
  // caller gets clean text + the resumable session id.
  if (format === 'json') {
    try {
      const j = JSON.parse(out);
      return { text: String(j.result ?? j.text ?? out), sessionId: j.session_id ?? j.sessionId };
    } catch { /* not JSON — fall through */ }
  }
  return { text: out };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAIRoutes(app: Express): void {

  /**
   * POST /api/ai/generate
   * Body: { prompt: string, model?: 'claude' | 'codex' | 'gemini' }
   * Returns: { code: string, model: string }
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
    const env = createTerminalEnv(cwd);

    try {
      const { text: code, sessionId: newSessionId } = await runModel(model, prompt.trim(), env, cwd, { sessionId, format, agent, jobId, projectId, modelId });
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
      };
      res.json(response);
    } catch (err: any) {
      // execFile rejections carry the REAL reason on .stderr (auth errors, rate
      // limits, etc.) — surface it instead of the bare "Command failed: <cmd>".
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
      const msg = err?.message ?? 'AI generation failed';
      const detail = (stderr || msg).slice(0, 600);
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
    // Match by exact jobId, else by a running job's projectId.
    let entry = jobLogs.get(key);
    if (!entry && projectId) {
      for (const [k, j] of runningJobs) if (j.projectId === projectId) { entry = jobLogs.get(k); break; }
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
}
