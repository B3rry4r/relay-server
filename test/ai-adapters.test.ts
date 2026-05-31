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
    const codexArgs = getAdapter('codex').buildArgs('x', { sessionId: 's' });
    expect(codexArgs).not.toContain('--resume');
    expect(codexArgs).toContain('--no-interactive');
  });

  it('isAIModel guards the registry keys', () => {
    expect(isAIModel('claude')).toBe(true);
    expect(isAIModel('svelte')).toBe(false);
    expect(Object.keys(AI_ADAPTERS).sort()).toEqual(['claude', 'codex', 'gemini']);
  });
});
