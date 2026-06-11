// =============================================================================
// File: src/relay-server/ai-job-log.ts
//
// In-memory live-progress log for AI generation jobs. The generate route seeds
// an entry SYNCHRONOUSLY when a request arrives (before the CLI is spawned) so
// the very first GET /api/ai/progress poll already sees a running job, then
// appends human-readable lines as the run proceeds. Capped + auto-expired.
// =============================================================================

export interface JobLog {
  lines: string[];
  done: boolean;
  ts: number;
  projectId?: string;
}

const jobLogs = new Map<string, JobLog>();
const MAX_LOG_LINES = 400;
// Drop finished logs older than 10 min so the map can't grow unbounded.
const LOG_TTL_MS = 600_000;

function pruneJobLogs(): void {
  const cutoff = Date.now() - LOG_TTL_MS;
  for (const [k, v] of jobLogs) if (v.done && v.ts < cutoff) jobLogs.delete(k);
}

/** Create (or reset) the log for a job and seed its first line. */
export function startJobLog(jobKey: string, opts: { projectId?: string; firstLine?: string } = {}): void {
  pruneJobLogs();
  const entry: JobLog = { lines: [], done: false, ts: Date.now(), projectId: opts.projectId };
  if (opts.firstLine) entry.lines.push(opts.firstLine);
  jobLogs.set(jobKey, entry);
}

/** Append raw output to a job's log: ANSI is stripped, blank lines dropped. */
export function appendJobLog(jobKey: string, chunk: string): void {
  const entry = jobLogs.get(jobKey);
  if (!entry) return;
  for (const raw of chunk.split('\n')) {
    const line = raw.replace(/\x1b?\[[0-9;]*m/g, '').trimEnd();   // strip ANSI colour
    if (line) entry.lines.push(line);
  }
  if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
  entry.ts = Date.now();
}

/** Mark a job's log finished, optionally appending a final line. */
export function finishJobLog(jobKey: string, lastLine?: string): void {
  const entry = jobLogs.get(jobKey);
  if (!entry) return;
  if (lastLine) appendJobLog(jobKey, lastLine);
  entry.done = true;
  entry.ts = Date.now();
}

export function getJobLog(jobKey: string): JobLog | undefined {
  return jobLogs.get(jobKey);
}

/** Most recent log (running first, else newest) for a project — lets the
 *  progress endpoint resolve by projectId even after the job finished. */
export function findJobLogByProject(projectId: string): JobLog | undefined {
  let best: JobLog | undefined;
  for (const log of jobLogs.values()) {
    if (log.projectId !== projectId) continue;
    if (!best || (!log.done && best.done) || (log.done === best.done && log.ts > best.ts)) best = log;
  }
  return best;
}
