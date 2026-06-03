import { type Express } from 'express';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createTerminalEnv, resolveWorkspace, resolveProjectRoot } from './runtime';
import { AI_ADAPTERS, getAdapter, isAIModel, type AIModel, type AIFormat } from './ai-adapters';
import { appendTurn, getConversation, listConversations } from './conversation-store';

const execFileAsync = promisify(execFile);

// ── In-flight generation registry (for cancellation / Stop button) ───────────
// Each agent/codegen run registers its child process so POST /api/ai/cancel can
// kill it (and its whole process group — npm/build children included).
interface RunningJob { child: ChildProcess; projectId?: string; startedAt: number }
const runningJobs = new Map<string, RunningJob>();

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

// Run a model through its adapter (structured args + session continuity).
async function runModel(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { sessionId?: string; format?: AIFormat; agent?: boolean; jobId?: string; projectId?: string } = {},
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
  });
  // `detached: true` makes the CLI a process-group leader so cancellation can
  // kill the whole tree (the CLI + any npm/build children it spawns).
  const promise = execFileAsync(adapter.bin, args, {
    env, cwd, timeout: opts.agent ? AI_AGENT_TIMEOUT_MS : AI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    // `detached` is honoured by execFile at runtime (forwarded to spawn) but is
    // absent from its options type — cast so we can group-kill on cancel.
    detached: true,
  } as Parameters<typeof execFileAsync>[2]);
  const jobKey = opts.jobId || opts.projectId;
  if (jobKey && promise.child) runningJobs.set(jobKey, { child: promise.child, projectId: opts.projectId, startedAt: Date.now() });
  let result;
  try {
    result = await promise;
  } finally {
    if (jobKey) runningJobs.delete(jobKey);
  }
  const { stdout, stderr } = result as { stdout: string; stderr: string };
  const out = stdout.trim();
  if (!out && stderr.trim()) throw new Error(`${model} error: ${stderr.trim().slice(0, 300)}`);
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
    const { prompt, model = 'claude', sessionId, format, conversationId, projectId, agent, jobId } = req.body as GenerateRequest;

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
    }
    const env = createTerminalEnv(cwd);

    try {
      const { text: code, sessionId: newSessionId } = await runModel(model, prompt.trim(), env, cwd, { sessionId, format, agent, jobId, projectId });
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
      const msg = err?.message ?? 'AI generation failed';
      // A cancelled run was killed with SIGTERM/SIGKILL — report it as such.
      if (err?.killed || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL') {
        res.status(499).json({ error: 'generation cancelled', cancelled: true, model });
      } else if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('command not found')) {
        res.status(503).json({ error: `${model} is not installed in this workspace`, model });
      } else if (err?.code === 'ETIMEDOUT' || msg.includes('timeout')) {
        res.status(504).json({ error: `${model} timed out after ${AI_TIMEOUT_MS / 1000}s`, model });
      } else {
        res.status(500).json({ error: msg, model });
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
   * GET /api/ai/models
   * Returns which AI models are available in the current workspace.
   */
  app.get('/api/ai/models', async (_req, res) => {
    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);

    const checks = await Promise.all(
      (Object.keys(AI_ADAPTERS) as AIModel[]).map(async model => {
        const adapter = getAdapter(model);
        try {
          await execFileAsync('sh', ['-c', `command -v ${adapter.bin}`], { env, cwd: workspace, timeout: 3000 });
          return { model, available: true, capabilities: adapter.capabilities };
        } catch {
          return { model, available: false, capabilities: adapter.capabilities };
        }
      }),
    );

    res.json({ models: checks });
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
