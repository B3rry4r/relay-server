// =============================================================================
// File: src/relay-server/version-control.ts
//
// VERSION-CONTROL HARNESS for MANAGED PROJECTS (RFC v2 §9 — "Version control &
// data safety"). This is a PIPELINE COMPONENT, not manual git.
//
// WHY THIS EXISTS (real incident, 2026-06-21): an agent `rm -rf`'d a managed
// project's lib/ trusting a /tmp byte-snapshot that a redeploy had WIPED (/tmp is
// ephemeral; the container restarts on deploy). The generated source was lost
// because the project had no version control. This harness makes that failure mode
// impossible BY DESIGN:
//
//   - .git lives UNDER the project in /workspace (persistent) — NOT /tmp. It
//     survives redeploys; recovery is a `git reflog` / `git reset` away.
//   - Mutating passes snapshot via a real commit (`snapshotBeforeMutation`) and
//     roll back with `git reset --hard <sha>` + `git clean -fd` — which un-deletes
//     deleted tracked files, reverts modifications, AND removes files the failed
//     pass CREATED. This restores files a pass deleted/moved (the exact failure).
//   - Checkpoint commits at every phase boundary give a durable, inspectable
//     history (RFC §9.2/§9.5).
//
// DISCIPLINE: this harness is for MANAGED PROJECTS under /workspace/projects/<app>
// ONLY — never relay-server itself. It sets git identity LOCALLY (per-repo), never
// global. It NEVER throws fatally: git being unavailable degrades data-safety but
// must not break a build — so every public fn logs a LOUD warning and continues
// (data safety is OFF) rather than crashing the pipeline.
// =============================================================================

import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { assertSafeProjectRoot } from './runtime';

const execFile = promisify(execFileCb);

// ── per-repo async mutex (T11 fix #3) ────────────────────────────────────────────
// Parallel screen workers call commitCheckpoint / snapshotBeforeMutation / rollbackTo
// concurrently on the SAME repo. Each does `git add -A` + commit, which take the
// repo's index.lock — concurrent writers collide and most commits are DROPPED
// ("Another git process seems to be running"). Serialize all git WRITE ops per repo
// so concurrent checkpoints QUEUE instead of failing. Keyed by resolved projectRoot.
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  // Chain fn after whatever is currently queued; swallow the predecessor's result so
  // one failing op never rejects a later queued op's gate.
  const next = prev.then(() => fn(), () => fn());
  // Keep the chain alive even if `next` rejects (callers handle their own errors).
  repoLocks.set(key, next.catch(() => undefined));
  return next;
}

/**
 * HARD SCOPE GUARD (T11 fix #1). Returns true when it is SAFE to operate on
 * `projectRoot` (a managed project strictly under the projects root, not relay-server
 * itself / the projects root / a parent). On an unsafe root it logs a LOUD refusal
 * and returns false — the harness then no-ops there, NEVER running git. `..`, `.`,
 * and `relay-server` are all refused here even if a caller bypassed resolveProjectRoot.
 */
function isSafeProjectRoot(projectRoot: string, log: Logger): boolean {
  try {
    assertSafeProjectRoot(projectRoot);
    return true;
  } catch (e) {
    log(`[vc] REFUSED: ${(e as Error).message}`);
    return false;
  }
}

// Local-only git identity for harness commits. Applied per-command with `-c` (and
// committed to .git/config as a local-only value by ensureProjectGit) so the GLOBAL
// git identity is never touched.
const HARNESS_USER_NAME = 'relay-pipeline';
const HARNESS_USER_EMAIL = 'pipeline@relay.local';

type Logger = (msg: string) => void;
const noopLog: Logger = () => { /* no-op */ };

export interface VcOptions {
  /** Streaming log callback (one line, no trailing newline). Defaults to no-op. */
  log?: Logger;
  /** Env for the git child process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

// ── low-level git runner ───────────────────────────────────────────────────────

/**
 * Run a git command in the project root with the harness identity injected via
 * `-c user.*` (so neither the global nor a missing local identity blocks a commit,
 * and the global identity is never mutated). Resolves stdout/stderr; rejects on a
 * non-zero exit (the caller decides whether that is fatal — here, never).
 */
async function git(
  projectRoot: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const identity = [
    '-c', `user.name=${HARNESS_USER_NAME}`,
    '-c', `user.email=${HARNESS_USER_EMAIL}`,
    // Never let a global/system commit.gpgsign or hooks interfere with a checkpoint.
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
  ];
  return execFile('git', [...identity, ...args], {
    cwd: projectRoot,
    env: env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** True when `git` is on PATH and runnable. Cached per-process. */
let gitAvailable: boolean | null = null;
async function isGitAvailable(env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (gitAvailable != null) return gitAvailable;
  try {
    await execFile('git', ['--version'], { env: env ?? process.env });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** True when `<projectRoot>/.git` exists (a repo is initialized here). */
function hasGitDir(projectRoot: string): boolean {
  return fsSync.existsSync(path.join(projectRoot, '.git'));
}

// ── .gitignore synthesis ────────────────────────────────────────────────────────

/** Detect which framework ignore rules apply (best-effort; include both when
 *  ambiguous so build artifacts are never committed). */
function detectIgnoreFlavors(projectRoot: string): { flutter: boolean; node: boolean } {
  const flutter = fsSync.existsSync(path.join(projectRoot, 'pubspec.yaml'));
  const node = fsSync.existsSync(path.join(projectRoot, 'package.json'));
  // When neither marker is present (a fresh/empty project), include BOTH so no
  // future build artifact is ever tracked.
  if (!flutter && !node) return { flutter: true, node: true };
  return { flutter, node };
}

const FLUTTER_IGNORE = [
  '# Flutter / Dart',
  '/build/',
  '.dart_tool/',
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  '*.iml',
  '.idea/',
];

const NODE_IGNORE = [
  '# Node',
  'node_modules/',
  'dist/',
  'out/',
  '*.log',
];

const COMMON_IGNORE = [
  '# OS / editor',
  '.DS_Store',
  '*.swp',
];

/** Write a sane `.gitignore` if one does not already exist (never clobber a
 *  project's own ignore file). */
async function ensureGitignore(projectRoot: string, log: Logger): Promise<void> {
  const abs = path.join(projectRoot, '.gitignore');
  if (fsSync.existsSync(abs)) return;
  const { flutter, node } = detectIgnoreFlavors(projectRoot);
  const lines: string[] = ['# Auto-generated by the relay pipeline version-control harness'];
  if (flutter) lines.push('', ...FLUTTER_IGNORE);
  if (node) lines.push('', ...NODE_IGNORE);
  lines.push('', ...COMMON_IGNORE, '');
  try {
    await fs.writeFile(abs, lines.join('\n'), 'utf8');
    log(`[vc] wrote .gitignore (${flutter ? 'flutter' : ''}${flutter && node ? '+' : ''}${node ? 'node' : ''})`);
  } catch (e) {
    log(`[vc] WARNING: could not write .gitignore: ${(e as Error).message}`);
  }
}

// ── 1. ensureProjectGit ──────────────────────────────────────────────────────────

/**
 * Ensure the managed project at `projectRoot` is a git repo (RFC §9.1 — no managed
 * project is ever un-tracked). Idempotent:
 *   - if `.git` already exists → no-op (just verifies identity is set locally),
 *   - else → `git init` (default branch `main`), write a sane `.gitignore`, set the
 *     LOCAL user.name/user.email (never global), and make an initial commit so a
 *     baseline exists to roll back to.
 *
 * NEVER throws fatally: if git is unavailable or init fails, it logs a LOUD warning
 * (data safety is OFF for this project) and returns — the pipeline continues.
 */
export async function ensureProjectGit(projectRoot: string, opts: VcOptions = {}): Promise<void> {
  const log = opts.log ?? noopLog;
  const env = opts.env;
  // HARD SCOPE GUARD (T11 #1): never init/operate git on relay-server itself, the
  // projects root, /workspace, or a parent. A loud refusal — not a silent return.
  if (!isSafeProjectRoot(projectRoot, log)) return;
  if (!fsSync.existsSync(projectRoot)) {
    log(`[vc] WARNING: project root does not exist, cannot init git: ${projectRoot} — DATA SAFETY OFF`);
    return;
  }
  if (!(await isGitAvailable(env))) {
    log(`[vc] WARNING: git is not available on PATH — DATA SAFETY OFF for ${projectRoot} (no checkpoints, no rollback)`);
    return;
  }

  // Serialize the whole init under the per-repo lock so a parallel caller can't race
  // `git init` / the baseline commit (T11 #3).
  await withRepoLock(projectRoot, async () => {
    try {
      if (hasGitDir(projectRoot)) {
        // Already a repo. Make sure the LOCAL identity is set so harness commits work
        // even on a repo created elsewhere (idempotent; never touches global).
        try {
          await git(projectRoot, ['config', '--local', 'user.name', HARNESS_USER_NAME], env);
          await git(projectRoot, ['config', '--local', 'user.email', HARNESS_USER_EMAIL], env);
        } catch { /* identity is also injected per-command via -c; this is belt+braces */ }
        await warnIfSourceDirsIgnored(projectRoot, log, env);
        return; // no-op
      }

      log(`[vc] initializing git repo for managed project: ${projectRoot}`);
      try {
        await git(projectRoot, ['init', '-b', 'main'], env);
      } catch {
        // Older git without `-b`: init then rename the branch best-effort.
        await git(projectRoot, ['init'], env);
        try { await git(projectRoot, ['checkout', '-b', 'main'], env); } catch { /* ignore */ }
      }
      // LOCAL identity only (RFC §9 — don't touch global).
      await git(projectRoot, ['config', '--local', 'user.name', HARNESS_USER_NAME], env);
      await git(projectRoot, ['config', '--local', 'user.email', HARNESS_USER_EMAIL], env);

      await ensureGitignore(projectRoot, log);

      // Initial baseline commit so there is always a sha to roll back to. If the tree
      // is empty this is an empty commit (still a valid rollback target).
      try {
        await git(projectRoot, ['add', '-A'], env);
        await git(projectRoot, ['commit', '--allow-empty', '-m', '[ckpt] init — version-control harness baseline'], env);
        log('[vc] initial baseline commit created');
      } catch (e) {
        log(`[vc] WARNING: initial commit failed (continuing): ${(e as Error).message}`);
      }

      // ROLLBACK-SAFETY CHECK (T11 #5): rollbackTo (reset --hard + clean -fd) can only
      // restore a dir git TRACKS. If a wired source dir (lib/test/src) is covered by
      // .gitignore, a pass that deletes files there could NOT be rolled back — the
      // guarantee would silently depend on ignore contents. Warn LOUDLY.
      await warnIfSourceDirsIgnored(projectRoot, log, env);
    } catch (e) {
      log(`[vc] WARNING: ensureProjectGit failed (DATA SAFETY OFF for this project): ${(e as Error).message}`);
    }
  });
}

// ── source-dir ignore safety (T11 #5) ────────────────────────────────────────────

/** Candidate source dirs a mutating pass may delete from; rollback depends on these
 *  being TRACKED (not gitignored). */
const WIRED_SOURCE_DIRS = ['lib', 'test', 'src'];

/**
 * Warn loudly when a wired source dir exists but is IGNORED by .gitignore. A
 * gitignored source dir means `reset --hard` + `clean -fd` cannot restore files a
 * pass deletes there — so the data-safety guarantee would silently depend on ignore
 * contents. Best-effort (git failure / missing dir → no warning). Returns the list of
 * offending dirs (for tests).
 */
async function warnIfSourceDirsIgnored(
  projectRoot: string, log: Logger, env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const offending: string[] = [];
  for (const d of WIRED_SOURCE_DIRS) {
    const abs = path.join(projectRoot, d);
    if (!fsSync.existsSync(abs)) continue;
    try {
      // `git check-ignore -q <dir>` exits 0 when the path IS ignored.
      await git(projectRoot, ['check-ignore', '-q', d], env);
      offending.push(d);
    } catch {
      // non-zero exit = NOT ignored (the safe case) — or git failed; either way no warn.
    }
  }
  if (offending.length) {
    log(`[vc] CRITICAL: wired source dir(s) [${offending.join(', ')}] are covered by .gitignore — ` +
        `rollback CANNOT restore deletions there. Remove these from .gitignore before any destructive pass; ` +
        `rollback-dependent mutation is UNSAFE here.`);
  }
  return offending;
}

// ── helpers: working-tree state ──────────────────────────────────────────────────

/** True when the working tree has uncommitted changes (staged, unstaged, or
 *  untracked). Best-effort: a git failure returns false (treat as clean). */
async function isDirty(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await git(projectRoot, ['status', '--porcelain'], env);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Resolve HEAD to a sha, or null when there are no commits yet / git fails. */
async function headSha(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await git(projectRoot, ['rev-parse', 'HEAD'], env);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── 2. commitCheckpoint ──────────────────────────────────────────────────────────

/**
 * Stage everything and commit a labeled checkpoint (RFC §9.2). Message is
 * `[ckpt] <label>` with `detail` as the body. Returns the new commit sha, or null
 * when there was nothing to commit (a clean no-op — idempotent re-runs don't churn
 * the history). NEVER throws fatally: a git hiccup logs a warning and returns null.
 */
export async function commitCheckpoint(
  projectRoot: string,
  label: string,
  detail?: string,
  opts: VcOptions = {},
): Promise<string | null> {
  const log = opts.log ?? noopLog;
  const env = opts.env;
  if (!isSafeProjectRoot(projectRoot, log)) return null;
  if (!hasGitDir(projectRoot)) {
    // Not initialized — don't silently swallow: the caller expected a repo.
    log(`[vc] WARNING: commitCheckpoint('${label}') skipped — no .git at ${projectRoot} (call ensureProjectGit first)`);
    return null;
  }
  // Serialize the add+commit per repo so parallel checkpoints queue instead of
  // colliding on index.lock (T11 #3).
  return withRepoLock(projectRoot, async () => {
    try {
      if (!(await isDirty(projectRoot, env))) {
        log(`[vc] checkpoint '${label}': nothing to commit (no-op)`);
        return null;
      }
      await git(projectRoot, ['add', '-A'], env);
      const args = ['commit', '-m', `[ckpt] ${label}`];
      if (detail && detail.trim()) args.push('-m', detail.trim());
      await git(projectRoot, args, env);
      const sha = await headSha(projectRoot, env);
      log(`[vc] checkpoint '${label}' committed${sha ? ` (${sha.slice(0, 8)})` : ''}`);
      return sha;
    } catch (e) {
      log(`[vc] WARNING: commitCheckpoint('${label}') failed (non-fatal): ${(e as Error).message}`);
      return null;
    }
  });
}

// ── 3. snapshotBeforeMutation ────────────────────────────────────────────────────

/**
 * Ensure a CLEAN, COMMITTED baseline exists before a mutating/destructive pass
 * (RFC §9.2/§9.4 — never hard-delete without a commit first), and return the sha to
 * roll back to. If the tree is dirty, commits the pending state as
 * `[ckpt] pre <label>`. The returned sha is the state the pass mutates FROM; pass
 * it to `rollbackTo` on regression to restore EXACTLY this tree (including any
 * files the pass deletes/moves, plus removing files the pass creates).
 *
 * NEVER throws fatally. If git is unavailable / no .git, returns '' (the caller
 * treats an empty sha as "no rollback available" and must surface that — but the
 * build is not crashed). This is the only public fn that returns a string always,
 * to keep the call sites simple.
 */
export async function snapshotBeforeMutation(
  projectRoot: string,
  label: string,
  opts: VcOptions = {},
): Promise<string> {
  const log = opts.log ?? noopLog;
  const env = opts.env;
  if (!isSafeProjectRoot(projectRoot, log)) return '';
  if (!hasGitDir(projectRoot)) {
    log(`[vc] WARNING: snapshotBeforeMutation('${label}') — no .git at ${projectRoot}; rollback UNAVAILABLE (call ensureProjectGit first)`);
    return '';
  }
  // Serialize per repo so a concurrent checkpoint can't interleave with the baseline
  // commit and drop it (T11 #3).
  return withRepoLock(projectRoot, async () => {
    try {
      if (await isDirty(projectRoot, env)) {
        await git(projectRoot, ['add', '-A'], env);
        await git(projectRoot, ['commit', '-m', `[ckpt] pre ${label}`], env);
        log(`[vc] snapshot baseline committed: pre ${label}`);
      }
      const sha = await headSha(projectRoot, env);
      if (!sha) {
        // No commits yet (e.g. empty repo, commit failed) — make an empty baseline so
        // there is always a concrete rollback target.
        try {
          await git(projectRoot, ['commit', '--allow-empty', '-m', `[ckpt] pre ${label} (empty baseline)`], env);
        } catch { /* ignore */ }
        const sha2 = await headSha(projectRoot, env);
        return sha2 ?? '';
      }
      return sha;
    } catch (e) {
      log(`[vc] WARNING: snapshotBeforeMutation('${label}') failed (rollback UNAVAILABLE): ${(e as Error).message}`);
      return '';
    }
  });
}

// ── 4. rollbackTo ────────────────────────────────────────────────────────────────

/**
 * Restore the working tree EXACTLY to `sha` (RFC §9.3 — the critical recovery
 * primitive). This is `git reset --hard <sha>` (un-deletes deleted tracked files,
 * reverts modifications) PLUS `git clean -fd` (removes files the failed pass
 * CREATED — safe because the pre-state was committed, so anything untracked now was
 * created by the pass). After this the tree is byte-identical to the snapshot:
 * files a pass DELETED or MOVED are back, modified files are reverted, created files
 * are gone.
 *
 * NEVER throws fatally — but on failure it logs CRITICAL (a rollback that fails is
 * the dangerous case the human must see). An empty/blank `sha` is a no-op with a
 * loud warning (there was no snapshot to restore — surfaced, never silent).
 */
export async function rollbackTo(
  projectRoot: string,
  sha: string,
  opts: VcOptions = {},
): Promise<void> {
  const log = opts.log ?? noopLog;
  const env = opts.env;
  if (!isSafeProjectRoot(projectRoot, log)) return;
  if (!sha || !sha.trim()) {
    log(`[vc] WARNING: rollbackTo called with no sha — NOTHING RESTORED (no snapshot was taken)`);
    return;
  }
  if (!hasGitDir(projectRoot)) {
    log(`[vc] CRITICAL: rollbackTo('${sha.slice(0, 8)}') — no .git at ${projectRoot}; CANNOT RESTORE`);
    return;
  }
  // Serialize per repo so a rollback never collides with a concurrent commit (T11 #3).
  await withRepoLock(projectRoot, async () => {
    try {
      await git(projectRoot, ['reset', '--hard', sha], env);
      // Remove untracked files/dirs the failed pass created. -d for directories; we do
      // NOT pass -x so .gitignore'd build artifacts (e.g. build/) are preserved (they
      // are not pass output and re-deleting them just forces a slow rebuild).
      await git(projectRoot, ['clean', '-fd'], env);
      log(`[vc] rolled back to ${sha.slice(0, 8)} (reset --hard + clean -fd) — deleted/moved files restored, pass-created files removed`);
    } catch (e) {
      log(`[vc] CRITICAL: rollbackTo('${sha.slice(0, 8)}') FAILED — working tree may be inconsistent: ${(e as Error).message}`);
    }
  });
}

// Test-only surface: reset the cached git-availability probe between unit tests.
export const __test = {
  resetGitAvailableCache(): void { gitAvailable = null; },
  detectIgnoreFlavors,
  warnIfSourceDirsIgnored,
  isSafeProjectRoot,
};
