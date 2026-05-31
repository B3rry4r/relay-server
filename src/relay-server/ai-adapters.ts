// =============================================================================
// File: src/relay-server/ai-adapters.ts
//
// Structured adapter registry for the workspace AI CLIs (P4). Generalizes the
// three hardcoded adapters into a registry with capability flags + argument
// builders, and threads a session id for continuity (resume) — the orchestration
// gap where sessionId was previously accepted and ignored.
//
// Pure arg/capability logic (no process spawning here) → unit-testable; the
// route layer does the execFile.
// =============================================================================

export type AIModel = 'claude' | 'codex' | 'gemini';
export type AIFormat = 'text' | 'json';

export interface AICapabilities {
  resume: boolean;   // can continue a prior session by id
  json: boolean;     // can emit structured JSON output
  images: boolean;   // can accept image inputs (multimodal)
}

export interface AIRunOptions {
  sessionId?: string;
  format?: AIFormat;
}

export interface AIAdapter {
  id: AIModel;
  bin: string;
  capabilities: AICapabilities;
  /** Build the CLI argument vector for a non-interactive run. */
  buildArgs(prompt: string, opts?: AIRunOptions): string[];
}

const claude: AIAdapter = {
  id: 'claude',
  bin: 'claude',
  capabilities: { resume: true, json: true, images: true },
  buildArgs(prompt, opts = {}) {
    const args = ['-p', prompt, '--output-format', opts.format ?? 'text'];
    // Continue a prior conversation when a session id is supplied (continuity).
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    return args;
  },
};

const codex: AIAdapter = {
  id: 'codex',
  bin: 'codex',
  capabilities: { resume: false, json: false, images: false },
  buildArgs(prompt) {
    return ['--prompt', prompt, '--quiet', '--no-interactive'];
  },
};

const gemini: AIAdapter = {
  id: 'gemini',
  bin: 'gemini',
  capabilities: { resume: false, json: false, images: false },
  buildArgs(prompt) {
    return ['-p', prompt];
  },
};

export const AI_ADAPTERS: Record<AIModel, AIAdapter> = { claude, codex, gemini };

export function isAIModel(v: unknown): v is AIModel {
  return v === 'claude' || v === 'codex' || v === 'gemini';
}

export function getAdapter(model: AIModel): AIAdapter {
  return AI_ADAPTERS[model];
}
