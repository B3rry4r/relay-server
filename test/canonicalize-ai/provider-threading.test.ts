// =============================================================================
// T14.10 — PROVIDER THREADING proof. The canonicalization stages (1a describe,
// 1b reconcile, 1c reduce, 1d adjudicate) and asset-rename used to call
// `requireModel('claude', …)` HARDCODED, so a codex/gemini run silently
// hard-depended on claude. They now thread the run's selected provider.
//
// This test proves the LOW-LEVEL contract `requireModel(provider, …)` actually
// hands the runner the provider it was given (not a hardcoded 'claude'), AND
// asserts (by source inspection) that none of the canon stages pass a literal
// 'claude' to requireModel anymore — they pass the threaded `provider`/`opts.provider`.
// =============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import { setRunModel, requireModel, type RunModelLike } from '../../src/relay-server/ai-observability';
import type { AIModel } from '../../src/relay-server/ai-adapters';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('T14.10 provider threading', () => {
  afterAll(() => { setRunModel(null as unknown as RunModelLike); });

  it('requireModel forwards the GIVEN provider to the runner (not hardcoded claude)', async () => {
    const seen: AIModel[] = [];
    setRunModel(async (model) => { seen.push(model); return { text: '{"ok":true}' }; });

    for (const p of ['codex', 'gemini', 'claude'] as AIModel[]) {
      await requireModel(p, 'noop prompt', process.env, '/tmp');
    }
    expect(seen).toEqual(['codex', 'gemini', 'claude']);
  });

  it('canon stages no longer pass a literal "claude" to requireModel', () => {
    const dir = path.join(__dirname, '..', '..', 'src', 'relay-server', 'canonicalize-ai');
    const files = ['describe.ts', 'reduce.ts', 'reconcile.ts', 'adjudicate.ts'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // No `requireModel('claude'` / `requireModel("claude"` anywhere.
      expect(src).not.toMatch(/requireModel\(\s*['"]claude['"]/);
      // The provider IS threaded into requireModel (either `provider` directly or
      // `opts.provider ?? 'claude'`-derived).
      expect(src).toMatch(/requireModel\(\s*(?:provider\b|opts\.provider\b)/);
    }
  });

  it('the orchestrator + loop thread provider through to every stage', () => {
    const orch = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'relay-server', 'canonicalize-ai', 'orchestrate.ts'), 'utf8');
    // Each stage call carries `provider`.
    expect((orch.match(/\bprovider,/g) || []).length).toBeGreaterThanOrEqual(4);

    const loop = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'relay-server', 'ai-screen-loop.ts'), 'utf8');
    // The loop sets aiOpts.provider from the run's selected model (guarded by isAIModel).
    expect(loop).toMatch(/isAIModel\(run\.model\)\s*\?\s*\{\s*provider:\s*run\.model\s*\}/);
  });
});
