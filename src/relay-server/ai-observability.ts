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
import { appendRunLog, bumpRunAi } from './build-run-store';

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
) => Promise<{ text: string; sessionId?: string; tokens?: number }>;

// ── Typed result + errors ────────────────────────────────────────────────────

export type AiFailReason = 'empty' | 'error' | 'timeout' | 'no-runner' | 'rate-limit';

/** Classify a CLI error message as a rate-limit / quota rejection (vs a real error
 *  or a hang). These are recoverable by waiting, so callers back off + retry rather
 *  than treating the call as a hard failure. */
export function isRateLimitError(msg: string): boolean {
  return /rate[\s_-]?limit|usage limit|quota|too many requests|\b429\b|overloaded|capacity|please try again later|resets at/i.test(msg);
}

// Rate-limit backoff: a per-window (per-minute) limit self-heals if we wait, so a
// rate-limited call retries with exponential backoff before giving up. A longer
// (hourly/daily) limit will exhaust these retries → the caller then pauses the run
// resumably rather than failing the work. Env-overridable — read at CALL TIME (not
// module-load) so a deploy/env change (and tests) take effect without a restart.
const rateLimitRetries = (): number => Number(process.env.RELAY_RATELIMIT_RETRIES) || 4;
const rateLimitBaseMs = (): number => Number(process.env.RELAY_RATELIMIT_BASE_MS) || 20_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── T29: EMPTY-STREAK → soft rate-limit ──────────────────────────────────────
// When a quota is exhausted mid-build, the CLI can return EMPTY output (reason
// 'empty') instead of a classifiable rate-limit ERROR — so the T26 isRateLimitError
// backoff never fired and screens went to needs-review ("verify agent produced no
// output"). We track recent outcomes per run/loop: an empty that follows a STREAK of
// empties/rate-limits is a probable SOFT rate-limit → back off + retry (reuse T26's
// backoff), and if it persists, surface reason 'rate-limit' so the caller PAUSES the
// run resumably (T26's pause path) rather than dumping the screen to needs-review. A
// genuinely-isolated single empty (a real model no-op) is NOT a streak → behaves as
// today. Threshold env-overridable (RELAY_EMPTY_STREAK_THRESHOLD).
//
// DEFAULT 3 (not 2) deliberately: T25's transient-hang retry produces TWO empties on
// ONE screen (implement + its single retry) for a genuinely transient CLI hang — that
// must NOT be mistaken for a soft rate limit. A real quota exhaustion produces a
// SUSTAINED streak (every following call empties), which 3-in-a-row catches while a
// lone screen's hang-retry (2) does not. Set RELAY_EMPTY_STREAK_THRESHOLD=2 to be
// more aggressive.
const emptyStreakThreshold = (): number => Math.max(2, Number(process.env.RELAY_EMPTY_STREAK_THRESHOLD) || 3);
// How many recent outcomes to remember per key (enough to see a streak; bounded).
const STREAK_WINDOW = 8;

// Per-run/loop ring of recent outcomes. Keyed by the run/job/step the call belongs to
// so one screen's isolated empty doesn't poison an unrelated run's count. In-process
// (one process owns a run); a redeploy resets it, which is fine — a fresh process
// re-observes the streak from scratch.
// 'zero-fail' = a call that THREW (timeout / status=error) but produced ~0 output.
// T-hang-storm (BUG 2): the claude CLI hangs on many calls → each dies at the 300s
// timeout with 0 tokens (status=error/timeout, empty text). That is NOT a genuinely
// broken call — it's a "can't make progress / likely soft-throttle / agent stall"
// condition, indistinguishable in effect from an exhausted-quota empty. So a
// zero-output FAILURE counts toward the SAME soft streak as an ok-but-empty call (it
// does NOT break the streak the way a substantive error would). When the streak
// crosses the threshold we re-classify it as 'rate-limit' so the caller PAUSES the
// run resumably (mirroring the empty-streak path) instead of dumping every hung
// screen to needs-review.
type Outcome = 'ok' | 'empty' | 'rate-limit' | 'error' | 'zero-fail';
const streaks = new Map<string, Outcome[]>();

function streakKey(ctx: LogCtx): string {
  // Prefer the durable run, else the job, else the step label, else a global bucket.
  return ctx.runId ? `run:${ctx.runId}` : ctx.jobId ? `job:${ctx.jobId}` : ctx.step ? `step:${ctx.step}` : 'global';
}
function recordOutcome(ctx: LogCtx, o: Outcome): void {
  const key = streakKey(ctx);
  const ring = streaks.get(key) ?? [];
  ring.push(o);
  if (ring.length > STREAK_WINDOW) ring.shift();
  streaks.set(key, ring);
}
/** Count the trailing run of soft/zero-output outcomes (an 'ok' or substantive
 *  'error' breaks it). The soft bucket is: ok-but-empty, rate-limit, AND a
 *  zero-output FAILURE (timeout/status=error with no text — a likely throttle/agent
 *  stall, BUG 2). An 'ok' obviously clears it; a substantive 'error' (a call that
 *  produced output but errored — currently none, reserved) breaks it so a genuinely
 *  broken call isn't mistaken for a soft limit. */
function trailingSoftStreak(ctx: LogCtx): number {
  const ring = streaks.get(streakKey(ctx)) ?? [];
  let n = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i] === 'empty' || ring[i] === 'rate-limit' || ring[i] === 'zero-fail') n++;
    else break;
  }
  return n;
}
/** Test/trace hook: reset the streak ring (e.g. between simulated runs). */
export function _resetEmptyStreaks(key?: string): void {
  if (key) streaks.delete(key); else streaks.clear();
}
export const _emptyStreakConfig = {
  get EMPTY_STREAK_THRESHOLD() { return emptyStreakThreshold(); },
  STREAK_WINDOW,
};

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
  | ({ ok: false; reason: AiFailReason; error?: string;
       /** True when `reason==='rate-limit'` came from a SOFT signal — an empty/zero-output
        *  STREAK crossing the threshold (likely throttle / agent stall) — NOT a classifiable
        *  429. Lets the caller log a distinguishing pause reason while taking the same
        *  resumable-pause action as a real rate limit. */
       softStall?: boolean }
     & Omit<AiCallProof, 'tokens'> & { tokens: number });

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
    // T9 (RFC v2 §8.4): bump the run's AI-firing tally from the structured line so
    // the Runs UI can show "AI: N ok / M failed" without parsing the raw log. Only
    // `status=ok` counts as success; empty/error/timeout count as failed.
    bumpRunAi(ctx.projectId, ctx.runId, /\bstatus=ok\b/.test(line) ? 'ok' : 'failed');
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

  // Rate-limit-aware: a per-window (per-minute) quota rejection self-heals if we wait,
  // so a rate-limited call backs off + retries before giving up. A longer (hourly/daily)
  // limit exhausts the retries → reason 'rate-limit', and the caller pauses the run
  // resumably (never cascades the work to a spurious "broken" verdict).
  for (let attempt = 0; ; attempt++) {
    const aStart = Date.now();
    try {
      const { text, sessionId, tokens: usageTokens } = await runner(model, prompt, env, cwd, {
        sessionId: opts.sessionId,
        format: opts.format,
        agent: opts.agent,
        modelId: opts.modelId,
        jobId: ctx.jobId,
        projectId: ctx.projectId,
      });
      const durMs = Date.now() - aStart;
      const out = (text ?? '').trim();
      // RFC v2 §0.2 — prefer the model's REAL reported usage (input+output tokens
      // from the stream-json result) over the chars/4 estimate; fall back to the
      // estimate only when the CLI didn't expose usage.
      const tokens = (typeof usageTokens === 'number' && usageTokens > 0) ? usageTokens : estTokens(out);
      if (!out) {
        // T29: an empty output can be a real model no-op OR the SILENT face of an
        // exhausted quota (the CLI returns empty rather than a classifiable rate-limit
        // error). Record it; if recent calls in this run/loop were ALSO empty/rate-
        // limited (a streak ≥ threshold), treat THIS empty as a probable soft rate
        // limit: back off + retry like a rate-limit, and once the backoff retries are
        // exhausted surface reason 'rate-limit' so the caller PAUSES the run resumably
        // (not needs-review). A genuinely-isolated empty (no streak) returns 'empty' as
        // before. We count THIS empty before measuring so a 2-in-a-row trips threshold=2.
        recordOutcome(ctx, 'empty');
        const streak = trailingSoftStreak(ctx);
        if (streak >= emptyStreakThreshold() && attempt < rateLimitRetries()) {
          const wait = rateLimitBaseMs() * (attempt + 1);   // reuse T26's backoff
          logAiLine(ctx, `model=${model} call=${callId} status=empty dur=${durMs}ms — SUSPICIOUS empty streak (${streak}, soft rate-limit?) — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${rateLimitRetries()})`);
          await sleep(wait);
          continue;   // retry the SAME call after the window cools down
        }
        if (streak >= emptyStreakThreshold()) {
          // Persisted past the backoff retries → a longer (hourly/daily) limit. Surface
          // 'rate-limit' so the caller pauses the run RESUMABLY via T26's pause path.
          logAiLine(ctx, `model=${model} call=${callId} status=rate-limit dur=${durMs}ms — empty streak persisted past backoff (${streak}); treating as soft rate-limit → pause`);
          return { ok: false, reason: 'rate-limit', softStall: true, callId, durMs, model, tokens: 0 };
        }
        logAiLine(ctx, `model=${model} call=${callId} tokens≈0 status=empty dur=${durMs}ms`);
        return { ok: false, reason: 'empty', callId, durMs, model, tokens: 0 };
      }
      const preview = out.replace(/\s+/g, ' ').slice(0, 80);
      recordOutcome(ctx, 'ok');   // T29: a real output clears the empty streak
      logAiLine(ctx, `model=${model} call=${callId} tokens≈${tokens} status=ok dur=${durMs}ms :: ${preview}`);
      return { ok: true, text, sessionId, callId, durMs, model, tokens };
    } catch (err: any) {
      const durMs = Date.now() - aStart;
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
      const msg = (stderr || err?.message || 'unknown error').toString();
      const rateLimited = isRateLimitError(msg);
      if (rateLimited && attempt < rateLimitRetries()) {
        const wait = rateLimitBaseMs() * (attempt + 1);   // 20s, 40s, 60s, 80s
        logAiLine(ctx, `model=${model} call=${callId} status=rate-limit dur=${durMs}ms — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${rateLimitRetries()})`);
        await sleep(wait);
        continue;   // retry the SAME call after the window cools down
      }
      const timedOut = (err?.killed && /timed?\s*out|ETIMEDOUT/i.test(msg)) || err?.signal === 'SIGTERM';
      // T29 + BUG 2: feed the soft-streak. A classifiable rate-limit error CONTINUES the
      // soft-limit streak (a mix of empties + 429s still trips the pause). A throw that
      // produced ~0 output (timeout/error — and in the catch path there is, by
      // definition, no usable text) is a likely throttle / agent stall (the 300s-hang
      // storm), so it ALSO counts toward the SAME soft streak ('zero-fail') rather than
      // breaking it. Only a substantive error (output-bearing) would break the streak.
      recordOutcome(ctx, rateLimited ? 'rate-limit' : 'zero-fail');
      const streak = trailingSoftStreak(ctx);
      // When a STREAK of zero-output failures crosses the threshold, re-classify this
      // failure as a soft rate-limit so the caller PAUSES the run resumably (mirrors the
      // ok-but-empty streak path) instead of cascading every hung screen to needs-review.
      // An ISOLATED hang (streak < threshold) still returns its real reason → that one
      // screen parks as before. (A genuine 429 already returns 'rate-limit' directly.)
      const reason: AiFailReason =
        rateLimited ? 'rate-limit'
        : (streak >= emptyStreakThreshold() ? 'rate-limit' : (timedOut ? 'timeout' : 'error'));
      const softStall = !rateLimited && reason === 'rate-limit';
      if (softStall) {
        logAiLine(ctx, `model=${model} call=${callId} status=rate-limit dur=${durMs}ms — ${streak} consecutive zero-output/timeout agent call(s) (likely throttle/agent stall, not a 429); treating as soft rate-limit → pause`);
      } else {
        logAiLine(ctx, `model=${model} call=${callId} tokens≈0 status=${reason === 'rate-limit' ? 'rate-limit' : 'error'} dur=${durMs}ms :: ${msg.slice(0, 80)}`);
      }
      return { ok: false, reason, softStall, error: msg.slice(0, 600), callId, durMs, model, tokens: 0 };
    }
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
