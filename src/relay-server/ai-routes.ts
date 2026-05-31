import { type Express } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTerminalEnv, resolveWorkspace } from './runtime';
import { AI_ADAPTERS, getAdapter, isAIModel, type AIModel, type AIFormat } from './ai-adapters';

const execFileAsync = promisify(execFile);

// Timeout for AI generation calls (2 minutes)
const AI_TIMEOUT_MS = 120_000;

interface GenerateRequest {
  prompt: string;
  model?: AIModel;
  sessionId?: string;
  format?: AIFormat;
}

interface GenerateResponse {
  code: string;
  model: AIModel;
  sessionId?: string;
}

// Run a model through its adapter (structured args + session continuity).
async function runModel(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { sessionId?: string; format?: AIFormat } = {},
): Promise<string> {
  const adapter = getAdapter(model);
  const args = adapter.buildArgs(prompt, {
    // honor continuity / json only when the adapter supports it
    sessionId: adapter.capabilities.resume ? opts.sessionId : undefined,
    format: adapter.capabilities.json ? opts.format : undefined,
  });
  const { stdout, stderr } = await execFileAsync(adapter.bin, args, {
    env, cwd, timeout: AI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
  });
  const out = stdout.trim();
  if (!out && stderr.trim()) throw new Error(`${model} error: ${stderr.trim().slice(0, 300)}`);
  return out;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAIRoutes(app: Express): void {

  /**
   * POST /api/ai/generate
   * Body: { prompt: string, model?: 'claude' | 'codex' | 'gemini' }
   * Returns: { code: string, model: string }
   */
  app.post('/api/ai/generate', async (req, res) => {
    const { prompt, model = 'claude', sessionId, format } = req.body as GenerateRequest;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    if (!isAIModel(model)) {
      res.status(400).json({ error: 'model must be claude, codex, or gemini' });
      return;
    }

    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);

    try {
      const code = await runModel(model, prompt.trim(), env, workspace, { sessionId, format });
      // Echo the sessionId back when the adapter can resume, so the caller can
      // continue the conversation on the next turn.
      const response: GenerateResponse = {
        code, model,
        ...(getAdapter(model).capabilities.resume && sessionId ? { sessionId } : {}),
      };
      res.json(response);
    } catch (err: any) {
      const msg = err?.message ?? 'AI generation failed';
      // Distinguish "binary not found" from other errors
      if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('command not found')) {
        res.status(503).json({ error: `${model} is not installed in this workspace`, model });
      } else if (err?.code === 'ETIMEDOUT' || msg.includes('timeout')) {
        res.status(504).json({ error: `${model} timed out after ${AI_TIMEOUT_MS / 1000}s`, model });
      } else {
        res.status(500).json({ error: msg, model });
      }
    }
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
}
