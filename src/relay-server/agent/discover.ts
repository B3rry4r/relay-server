/*
 * Fallback transcript discovery without hooks (agent-display-spec §5.3 step 3):
 * given a CLI process's cwd and start time, list the transcripts it may be
 * writing. The tracker binds only on a UNIQUE match (step 4).
 *
 * opencode keeps its history in SQLite; its backfill is phase 2 (§14.7), so an
 * opencode process without the plugin gets screen-only permission detection.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCli, SessionCandidate } from './types';

const SLACK_MS = 2000;

function firstLine(file: string): string | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function jsonl(dir: string, filter: (name: string) => boolean): Array<{ file: string; mtimeMs: number }> {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !filter(name)) continue;
    const file = path.join(dir, name);
    try { out.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* raced */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const iso = (ms: number) => new Date(ms).toISOString();

export function claudeProjectDir(home: string, cwd: string): string {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function findClaudeTranscripts(home: string, cwd: string, startMs: number): SessionCandidate[] {
  let dir = claudeProjectDir(home, cwd);
  const base = path.basename(dir);
  if (base.length > 200) {
    // Claude cuts long names at 200 chars and appends a hash: match the prefix.
    const parent = path.dirname(dir);
    try {
      const hit = fs.readdirSync(parent).find((n) => n.startsWith(base.slice(0, 200)));
      if (hit) dir = path.join(parent, hit);
    } catch { /* none */ }
  }
  const files = jsonl(dir, () => true).filter((f) => f.mtimeMs >= startMs - SLACK_MS);
  const scored = files.map((f) => {
    let sameCwd = false;
    let title: string | undefined;
    const lines = (() => { try { return fs.readFileSync(f.file, 'utf8').split('\n', 50); } catch { return []; } })();
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.cwd === cwd) sameCwd = true;
        if (!title && o.type === 'ai-title' && typeof o.title === 'string') title = o.title;
        if (!title && o.type === 'user' && typeof o.message?.content === 'string') title = o.message.content.slice(0, 80);
      } catch { /* partial */ }
    }
    return { f, sameCwd, title };
  });
  const preferred = scored.some((s) => s.sameCwd) ? scored.filter((s) => s.sameCwd) : scored;
  return preferred.map(({ f, title }) => ({ sessionId: path.basename(f.file, '.jsonl'), title, transcriptPath: f.file, mtime: iso(f.mtimeMs) }));
}

function dayDirs(root: string, nowMs: number): string[] {
  const dirs: string[] = [];
  for (const back of [0, 1]) {
    const d = new Date(nowMs - back * 86_400_000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(path.join(root, y, m, day));
  }
  return dirs;
}

export function findCodexTranscripts(home: string, cwd: string, startMs: number, nowMs = Date.now()): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  for (const dir of dayDirs(path.join(home, '.codex', 'sessions'), nowMs)) {
    for (const f of jsonl(dir, (n) => n.startsWith('rollout-'))) {
      const line = firstLine(f.file);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        const p = o.payload || {};
        if (o.type !== 'session_meta' || p.cwd !== cwd) continue;
        if (p.source && p.source !== 'cli') continue;
        if (p.thread_source && p.thread_source !== 'user') continue;
        const ts = Date.parse(o.timestamp || p.timestamp || '');
        if (Number.isFinite(ts) && ts < startMs - SLACK_MS) continue;
        out.push({ sessionId: String(p.id || path.basename(f.file, '.jsonl')), transcriptPath: f.file, mtime: iso(f.mtimeMs) });
      } catch { /* not a rollout */ }
    }
  }
  return out;
}

export function findGeminiTranscripts(home: string, cwd: string, startMs: number): SessionCandidate[] {
  let projectId = '';
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'projects.json'), 'utf8'));
    projectId = String(projects?.projects?.[cwd] ?? '');
  } catch { /* none */ }
  if (!projectId || projectId.includes('/') || projectId.includes('..')) return [];
  const dir = path.join(home, '.gemini', 'tmp', projectId, 'chats');
  return jsonl(dir, (n) => n.startsWith('session-'))
    .filter((f) => f.mtimeMs >= startMs - SLACK_MS)
    .map((f) => {
      let sessionId = path.basename(f.file, '.jsonl');
      const line = firstLine(f.file);
      try { const o = line ? JSON.parse(line) : null; if (o?.sessionId) sessionId = String(o.sessionId); } catch { /* keep */ }
      return { sessionId, transcriptPath: f.file, mtime: iso(f.mtimeMs) };
    });
}

export function findTranscripts(cli: AgentCli, home: string, cwd: string, startMs: number): SessionCandidate[] {
  if (cli === 'claude') return findClaudeTranscripts(home, cwd, startMs);
  if (cli === 'codex') return findCodexTranscripts(home, cwd, startMs);
  if (cli === 'gemini') return findGeminiTranscripts(home, cwd, startMs);
  return [];
}
