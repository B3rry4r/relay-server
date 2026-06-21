// =============================================================================
// File: src/relay-server/ai-observability.ts
//
// AI-firing OBSERVABILITY + LOUD-FAIL contract (RFC v2 §0.1/§0.2, §4.1).
//
// The pipeline's AI-reliant steps used to swallow model failures and silently
// fall back to deterministic stubs, then report success (the 368-asset
// `941_i285` garbage-rename incident). This module makes that impossible.
//
// It wraps `runModel` (the CLI adapter seam in ai-routes.ts) with:
//   1. A single structured log line per call:
//        [ai] model=<m> call=<id> tokens≈<n> status=<ok|empty|error> dur=<ms>
//      routed through the durable run log (when projectId+runId given), the
//      live job log (when a projectId/jobId is given), else console.
//   2. A TYPED result the caller can branch on:
//        { ok: true,  text, callId, tokens, ... }
//        { ok: false, reason, callId, ... }   // empty | error | timeout
//      `runModelObserved` NEVER throws on a model failure — it returns
//      { ok:false } so a caller that is LEGITIMATELY allowed to degrade can
//      branch explicitly (and is forced to log it as `degraded`).
//   3. `requireModel(...)`: the variant AI-PURPOSE steps call. It invokes the
//      model and THROWS a typed error (`AiNotFiredError` / `AiUnusableError`)
//      when the model did not fire, returned empty, or returned output that
//      fails the caller's validator. It returns PROOF the model fired (call id
//      + token estimate) so callers can assert it.
//
// Discipline this enforces (RFC §0.1): a fail is a fail. Distinguish in code:
//   - EXPLICIT no-AI mode (model/runner intentionally absent): caller should
//     not invoke the model at all → log `degraded`, never throw.
//   - AI ATTEMPTED but failed (empty / error / unusable): MUST surface — either
//     `runModelObserved` → caller logs `degraded`+reason and surfaces it, or
//     `requireModel` → THROW. Never silently keep a deterministic seed.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { AIModel, AIFormat } from './ai-adapters';
import { appendJobLog } from './ai-job-log';
import { appendRunLog } from './build-run-store';

// ── The underlying runner seam ───────────────────────────────────────────────
// runModel lives in ai-routes.ts. To avoid an eval-time circular import
// (ai-routes pulls in the whole route surface), callers inject the runner OR we
// import it lazily inside the wrapper. We import it lazily via a setter the
// app registers once, falling back to a dynamic import.
export type RunModelLike = (
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: { sessionId?: string; format?: AIFormat; agent?: boolean; jobId?: string; projectId?: string; modelId?: string },
) => Promise<{ text: string; sessionId?: string }>;

// ── Typed result + errors ────────────────────────────────────────────────────

export type AiFailReason = 'empty' | 'error' | 'timeout' | 'no-runner';

export interface AiCallProof {
  /** Unique id for THIS model invocation (proof of firing, appears in the log). */
  callId: string;
  /** Rough token estimate of the raw output (≈ chars/4). */
  tokens: number;
  /** Wall-clock duration of the call in ms. */
  durMs: number;
  /** The model that was invoked. */
  model: AIModel;
}

export type ObservedResult =
  | ({ ok: true; text: string; sessionId?: string } & AiCallProof)
  | ({ ok: false; reason: AiFailReason; error?: string } & Omit<AiCallProof, 'tokens'> & { tokens: number });

/** Base class for loud AI failures — distinct from ordinary Errors so callers /
 *  the orchestrator can recognise "the AI step failed" specifically. */
export class AiStepError extends Error {
  readonly callId: string;
  readonly model: AIModel;
  constructor(message: string, model: AIModel, callId: string) {
    super(message);
    this.name = this.constructor.name;
    this.model = model;
    this.callId = callId;
  }
}

/** The model did NOT fire / returned nothing / errored / timed out. */
export class AiNotFiredError extends AiStepError {
  readonly reason: AiFailReason;
  constructor(model: AIModel, callId: string, reason: AiFailReason, detail?: string) {
    super(
      `AI step did not fire: model=${model} call=${callId} reason=${reason}` +
        (detail ? ` — ${detail.slice(0, 240)}` : ''),
      model,
      callId,
    );
    this.reason = reason;
  }
}

/** The model fired and returned text, but it failed the caller's validator
 *  (e.g. unparseable JSON, no real names produced). */
export class AiUnusableError extends AiStepError {
  constructor(model: AIModel, callId: string, detail: string) {
    super(`AI step returned UNUSABLE output: model=${model} call=${callId} — ${detail.slice(0, 240)}`, model, callId);
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

const estTokens = (s: string): number => Math.max(0, Math.round((s || '').length / 4));

interface LogCtx {
  projectId?: string;
  /** Durable run log id (.uix/runs/<runId>.log) — preferred when present. */
  runId?: string;
  /** Live job-log key (in-memory progress) — used when no runId. */
  jobId?: string;
  /** Short label of the calling step, e.g. 'asset-rename', 'canon.describe'. */
  step?: string;
}

/** Emit the one structured AI line through the best available channel. */
function logAiLine(ctx: LogCtx, line: string): void {
  const tagged = ctx.step ? `[ai:${ctx.step}] ${line}` : `[ai] ${line}`;
  // Durable run log (survives restart/redeploy) wins when we have a runId.
  if (ctx.projectId && ctx.runId) {
    void appendRunLog(ctx.projectId, ctx.runId, tagged);
    return;
  }
  // Otherwise the in-memory job log (live progress) if we have a key.
  const jobKey = ctx.jobId || ctx.projectId;
  if (jobKey) {
    appendJobLog(jobKey, tagged);
    return;
  }
  // Last resort: console (still observable in relay-server stdout).
  // eslint-disable-next-line no-console
  console.log(tagged);
}

// ── The lazily-bound runner ──────────────────────────────────────────────────

let boundRunner: RunModelLike | null = null;
/** Registered once at app startup (ai-routes) to avoid an eval-time cycle. */
export function setRunModel(fn: RunModelLike): void { boundRunner = fn; }

async function getRunner(): Promise<RunModelLike | null> {
  if (boundRunner) return boundRunner;
  // Fallback: dynamic import (the cycle is safe at call-time, not eval-time).
  try {
    const mod = await import('./ai-routes');
    if (typeof mod.runModel === 'function') { boundRunner = mod.runModel as RunModelLike; return boundRunner; }
  } catch { /* fall through to null */ }
  return null;
}

// ── runModelObserved: never-throws, typed, logged ─────────────────────────────

export interface ObserveOptions {
  sessionId?: string;
  format?: AIFormat;
  agent?: boolean;
  modelId?: string;
  /** Observability routing context (run/job log + step label). */
  log?: LogCtx;
  /** Inject a runner directly (tests / custom seam). Defaults to bound runModel. */
  runner?: RunModelLike;
}

/**
 * Invoke the model through the adapter, log a single structured line, and return
 * a TYPED result. This NEVER throws on a model failure — it returns
 * `{ ok:false, reason }`. Use this when the caller is LEGITIMATELY allowed to
 * degrade (and must then log `degraded` + surface the reason). For AI-PURPOSE
 * steps that must fail loud, use `requireModel`.
 */
export async function runModelObserved(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: ObserveOptions = {},
): Promise<ObservedResult> {
  const callId = randomUUID().slice(0, 8);
  const ctx = opts.log ?? {};
  const runner = opts.runner ?? (await getRunner());
  const t0 = Date.now();

  if (!runner) {
    const durMs = Date.now() - t0;
    logAiLine(ctx, `model=${model} call=${callId} tokens≈0 status=error dur=${durMs}ms (no runner bound)`);
    return { ok: false, reason: 'no-runner', error: 'no runModel runner bound', callId, durMs, model, tokens: 0 };
  }

  try {
    const { text, sessionId } = await runner(model, prompt, env, cwd, {
      sessionId: opts.sessionId,
      format: opts.format,
      agent: opts.agent,
      modelId: opts.modelId,
      jobId: ctx.jobId,
      projectId: ctx.projectId,
    });
    const durMs = Date.now() - t0;
    const out = (text ?? '').trim();
    const tokens = estTokens(out);
    if (!out) {
      logAiLine(ctx, `model=${model} call=${callId} tokens≈0 status=empty dur=${durMs}ms`);
      return { ok: false, reason: 'empty', callId, durMs, model, tokens: 0 };
    }
    const preview = out.replace(/\s+/g, ' ').slice(0, 80);
    logAiLine(ctx, `model=${model} call=${callId} tokens≈${tokens} status=ok dur=${durMs}ms :: ${preview}`);
    return { ok: true, text, sessionId, callId, durMs, model, tokens };
  } catch (err: any) {
    const durMs = Date.now() - t0;
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const msg = (stderr || err?.message || 'unknown error').toString();
    const timedOut = err?.killed && /timed?\s*out|ETIMEDOUT/i.test(msg) || err?.signal === 'SIGTERM';
    const reason: AiFailReason = timedOut ? 'timeout' : 'error';
    logAiLine(ctx, `model=${model} call=${callId} tokens≈0 status=error dur=${durMs}ms :: ${msg.slice(0, 80)}`);
    return { ok: false, reason, error: msg.slice(0, 600), callId, durMs, model, tokens: 0 };
  }
}

// ── requireModel: AI-PURPOSE variant, THROWS on no-fire / unusable ────────────

export interface RequireOptions extends ObserveOptions {
  /**
   * Validate/parse the model's text. Return a value on success; throw or return
   * `undefined`/`null` if the output is unusable (e.g. unparseable JSON, no real
   * names). On unusable output `requireModel` throws `AiUnusableError`.
   */
  validate?: (text: string) => unknown;
}

export interface RequireResult<T = string> extends AiCallProof {
  /** The raw model text (always present on success). */
  text: string;
  sessionId?: string;
  /** The validator's parsed value, when a validator was supplied. */
  value: T;
}

/**
 * Invoke the model for an AI-PURPOSE step. THROWS loudly when the model did not
 * fire (empty / error / timeout / no runner) or when the supplied validator
 * rejects the output. Returns the raw text + the validated value + PROOF of
 * firing (callId / token estimate) so the caller can assert AI actually ran.
 *
 * Use this anywhere the model IS the point of the step (semantic asset naming,
 * canonical describe/reduce/adjudicate). Do NOT wrap it in a try/catch that
 * degrades to a deterministic stub — that is exactly the silent-swallow this
 * module exists to forbid.
 */
export async function requireModel<T = string>(
  model: AIModel,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: RequireOptions = {},
): Promise<RequireResult<T>> {
  const r = await runModelObserved(model, prompt, env, cwd, opts);
  if (!r.ok) {
    throw new AiNotFiredError(model, r.callId, r.reason, r.error);
  }
  let value: unknown = r.text;
  if (opts.validate) {
    try {
      value = opts.validate(r.text);
    } catch (e) {
      throw new AiUnusableError(model, r.callId, (e as Error).message);
    }
    if (value === undefined || value === null) {
      throw new AiUnusableError(model, r.callId, 'validator returned no usable value');
    }
  }
  return {
    text: r.text,
    sessionId: r.sessionId,
    value: value as T,
    callId: r.callId,
    tokens: r.tokens,
    durMs: r.durMs,
    model: r.model,
  };
}
