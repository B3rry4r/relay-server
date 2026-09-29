import { describe, it, expect } from 'vitest';
import { getAdapter, isAIModel, AI_ADAPTERS } from '../src/relay-server/ai-adapters';

describe('ai-adapters', () => {
  it('claude builds resume + json args when supported', () => {
    const a = getAdapter('claude');
    expect(a.capabilities.resume).toBe(true);
    const args = a.buildArgs('hello', { sessionId: 'sess-1', format: 'json' });
    expect(args).toContain('-p');
    expect(args).toContain('hello');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
  });

  it('claude omits resume when no sessionId', () => {
    const args = getAdapter('claude').buildArgs('hi');
    expect(args).not.toContain('--resume');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'text']));
  });

  it('codex/gemini do not support resume and ignore sessionId', () => {
    expect(getAdapter('codex').capabilities.resume).toBe(false);
    expect(getAdapter('gemini').capabilities.resume).toBe(false);
    // 2e0d984 moved codex off the removed `--prompt/--quiet/--no-interactive`
    // flags onto `codex exec` (non-interactive; approval implicitly "never"):
    // read-only sandbox by default, workspace-write only in agent mode.
    const codexArgs = getAdapter('codex').buildArgs('x', { sessionId: 's' });
    expect(codexArgs).not.toContain('--resume');
    expect(codexArgs).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', 'x']);
    expect(getAdapter('codex').buildArgs('x', { sessionId: 's', agent: true }))
      .toEqual(['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', 'x']);
    const geminiArgs = getAdapter('gemini').buildArgs('x', { sessionId: 's' });
    expect(geminiArgs).toEqual(['-p', 'x']);
  });

  it('opencode resumes via --session (d653243)', () => {
    const a = getAdapter('opencode');
    expect(a.capabilities.resume).toBe(true);
    expect(a.buildArgs('x', { sessionId: 's' })).toEqual(['run', '--session', 's', 'x']);
    expect(a.buildArgs('x')).toEqual(['run', 'x']);
  });

  it('isAIModel guards the registry keys', () => {
    expect(isAIModel('claude')).toBe(true);
    expect(isAIModel('svelte')).toBe(false);
    expect(isAIModel('opencode')).toBe(true);
    // d653243 registered opencode alongside claude/codex/gemini.
    expect(Object.keys(AI_ADAPTERS).sort()).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });
});
