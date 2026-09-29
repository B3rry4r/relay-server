/*
 * Shared helpers for the per-CLI adapters (ported from the research prototype
 * cli-research/adapters.prototype.mjs). Adapters are PURE: one source record in,
 * zero or more RawAgentEvents out. The golden fixtures under
 * test/fixtures/agent/<cli>/*.normalized.json are exactly this raw output; the
 * reducer (../reducer.ts) turns it into typed AgentEvents with ids and seq.
 */
import type { RawBlock } from '../blocks';
import type { ToolKind } from '../types';

/** The adapters' intermediate output (the prototype's normalized shape). */
export interface RawAgentEvent {
  kind: string;
  at?: string;
  sessionId?: string;
  transcriptPath?: string;
  text?: string;
  blocks?: RawBlock[];
  final?: boolean;
  toolUseId?: string;
  tool?: string;
  toolKind?: ToolKind;
  title?: string;
  input?: unknown;
  ok?: boolean;
  denied?: boolean;
  exitCode?: number;
  summary?: string;
  output?: string;
  reason?: string;
  durationMs?: number;
  state?: string;
  cwd?: string;
  model?: string;
  source?: string;
  message?: string;
  requestId?: string;
  outcome?: string;
  partId?: string;
  messageId?: string;
  lastText?: string;
  turnId?: string;
  cliVersion?: string;
  cli?: string;
  [key: string]: unknown;
}

export const clip = (s: unknown, n = 280): string => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

export function toolKind(name: unknown): ToolKind {
  const n = String(name).toLowerCase();
  if (/^(bash|shell|run_shell_command|exec_command|local_shell)$/.test(n)) return 'shell';
  if (/^(edit|write|multiedit|replace|write_file|apply_patch|notebookedit)$/.test(n)) return 'edit';
  if (/^(read|read_file|view_image|read_many_files)$/.test(n)) return 'read';
  if (/^(grep|glob|ls|list_directory|grep_search|search_file_content)$/.test(n)) return 'search';
  if (/^(webfetch|websearch|web_fetch|google_web_search|web_search)$/.test(n)) return 'web';
  if (/^(task|agent)$/.test(n)) return 'task';
  if (n.startsWith('mcp__')) return 'mcp';
  return 'other';
}

export function toolTitle(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const k of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return clip(v, 160);
    if (Array.isArray(v)) return clip(v.join(' '), 160);
  }
  return '';
}

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
