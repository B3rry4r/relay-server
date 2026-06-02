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
  /** Agentic mode: let the CLI use its native file/bash tools WITHOUT
   *  interactive permission prompts. The caller MUST run with cwd set to the
   *  target project so writes are scoped to that folder. */
  agent?: boolean;
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
    // Agent mode: headless autonomous. `acceptEdits` auto-approves file edits
    // AND bash in -p mode and (unlike --dangerously-skip-permissions) is
    // allowed to run as root, which the relay host is. Scope = the cwd.
    if (opts.agent) args.push('--permission-mode', 'acceptEdits');
    return args;
  },
};

const codex: AIAdapter = {
  id: 'codex',
  bin: 'codex',
  // Multimodal: codex reads images referenced by path from the workspace.
  capabilities: { resume: false, json: false, images: true },
  buildArgs(prompt, opts = {}) {
    // Agent mode uses `codex exec` (non-interactive — approval is implicitly
    // "never"). `--sandbox workspace-write` confines writes to the cwd workspace;
    // --skip-git-repo-check lets it run in a not-yet-git project.
    if (opts.agent) {
      return ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt];
    }
    // Non-agent: plain non-interactive print (read-only sandbox).
    return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt];
  },
};

const gemini: AIAdapter = {
  id: 'gemini',
  bin: 'gemini',
  // Multimodal: gemini reads images referenced by path from the workspace.
  capabilities: { resume: false, json: false, images: true },
  buildArgs(prompt, opts = {}) {
    const args = ['-p', prompt];
    // Agent mode: auto-approve all tool calls (yolo). Scope is the cwd.
    if (opts.agent) args.push('--approval-mode', 'yolo');
    return args;
  },
};

export const AI_ADAPTERS: Record<AIModel, AIAdapter> = { claude, codex, gemini };

export function isAIModel(v: unknown): v is AIModel {
  return v === 'claude' || v === 'codex' || v === 'gemini';
}

export function getAdapter(model: AIModel): AIAdapter {
  return AI_ADAPTERS[model];
}
