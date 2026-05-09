import { type Express } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTerminalEnv, resolveWorkspace } from './runtime';

const execFileAsync = promisify(execFile);

// Timeout for AI generation calls (2 minutes)
const AI_TIMEOUT_MS = 120_000;

type AIModel = 'claude' | 'codex' | 'gemini';

interface GenerateRequest {
  prompt: string;
  model?: AIModel;
  sessionId?: string;
}

interface GenerateResponse {
  code: string;
  model: AIModel;
}

// ── Adapters ──────────────────────────────────────────────────────────────────

async function runClaude(prompt: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  // Claude Code CLI uses OAuth login (claude auth login), not ANTHROPIC_API_KEY.
  // `claude -p "prompt" --output-format text` runs non-interactively and
  // uses the session established by `claude auth login` in the workspace.
  const { stdout, stderr } = await execFileAsync(
    'claude',
    ['-p', prompt, '--output-format', 'text'],
    { env, cwd, timeout: AI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  const out = stdout.trim();
  if (!out && stderr.trim()) throw new Error(`Claude error: ${stderr.trim().slice(0, 300)}`);
  return out;
}

async function runCodex(prompt: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  // OpenAI Codex CLI: `codex --prompt "..." --quiet`
  const { stdout, stderr } = await execFileAsync(
    'codex',
    ['--prompt', prompt, '--quiet', '--no-interactive'],
    { env, cwd, timeout: AI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  const out = stdout.trim();
  if (!out && stderr.trim()) throw new Error(`Codex error: ${stderr.trim().slice(0, 300)}`);
  return out;
}

async function runGemini(prompt: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  // Gemini CLI: `gemini --prompt "..."` or `gemini -p "..."`
  const { stdout, stderr } = await execFileAsync(
    'gemini',
    ['-p', prompt],
    { env, cwd, timeout: AI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  const out = stdout.trim();
  if (!out && stderr.trim()) throw new Error(`Gemini error: ${stderr.trim().slice(0, 300)}`);
  return out;
}

const adapters: Record<AIModel, (prompt: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<string>> = {
  claude: runClaude,
  codex: runCodex,
  gemini: runGemini,
};

// ── Route registration ────────────────────────────────────────────────────────

export function registerAIRoutes(app: Express): void {

  /**
   * POST /api/ai/generate
   * Body: { prompt: string, model?: 'claude' | 'codex' | 'gemini' }
   * Returns: { code: string, model: string }
   */
  app.post('/api/ai/generate', async (req, res) => {
    const { prompt, model = 'claude' } = req.body as GenerateRequest;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    if (!['claude', 'codex', 'gemini'].includes(model)) {
      res.status(400).json({ error: 'model must be claude, codex, or gemini' });
      return;
    }

    const workspace = resolveWorkspace();
    const env = createTerminalEnv(workspace);
    const adapter = adapters[model as AIModel];

    try {
      const code = await adapter(prompt.trim(), env, workspace);
      const response: GenerateResponse = { code, model: model as AIModel };
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
      (['claude', 'codex', 'gemini'] as AIModel[]).map(async model => {
        try {
          await execFileAsync('sh', ['-c', `command -v ${model}`], { env, cwd: workspace, timeout: 3000 });
          return { model, available: true };
        } catch {
          return { model, available: false };
        }
      }),
    );

    res.json({ models: checks });
  });
}
