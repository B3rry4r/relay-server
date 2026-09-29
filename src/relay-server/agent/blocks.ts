/*
 * relay-* display blocks (agent-display-spec §4.5, grammar §9.1).
 *
 * extractRawBlocks  — the prototype's loose extractor, kept byte-compatible so the
 *                     adapters reproduce the golden *.normalized.json fixtures.
 * parseDisplayBlocks — the normative parser the Agent view uses: well-formed
 *                     blocks are lifted out of the markdown into DisplayBlock[];
 *                     a malformed block stays in the text as a plain fenced code
 *                     block (never dropped).
 */
import type { DisplayBlock } from './types';

const BLOCK_RE = /```(relay-(?:status|choices|summary|files|link))[^\n]*\n([\s\S]*?)```/g;

export interface RawBlock {
  kind: string;
  fields: Record<string, string>;
  items: Array<{ n?: number; text: string }>;
  raw: string;
}

/** Prototype-compatible extraction (adapters.prototype.mjs extractDisplayBlocks). */
export function extractRawBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const m of String(text).matchAll(BLOCK_RE)) {
    const kind = m[1].slice(6);
    const body = m[2].replace(/\n$/, '');
    const fields: Record<string, string> = {};
    const items: Array<{ n?: number; text: string }> = [];
    for (const line of body.split('\n')) {
      const kv = /^([a-z][a-z0-9_-]*):\s*(.*)$/i.exec(line);
      const li = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) items.push({ n: li[1] ? Number(li[1]) : undefined, text: li[2] });
      else if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
    blocks.push({ kind, fields, items, raw: body });
  }
  return blocks;
}

const STATUS_STATES = new Set(['working', 'blocked', 'done', 'failed']);
const SUMMARY_RESULTS = new Set(['success', 'partial', 'failed']);

interface ParsedBody {
  fields: Record<string, string>;
  items: Array<{ n?: number; text: string }>;
  files: Array<{ status: 'A' | 'M' | 'D' | 'R'; path: string }>;
  /** A non-blank line that fits no production of the grammar. */
  stray: number;
}

function parseBody(body: string, name: string): ParsedBody {
  const out: ParsedBody = { fields: {}, items: [], files: [], stray: 0 };
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (name === 'files') {
      const f = /^\s*([AMDR])\s+(\S.*)$/.exec(line);
      if (f) { out.files.push({ status: f[1] as 'A' | 'M' | 'D' | 'R', path: f[2].trim() }); continue; }
    }
    const item = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) { out.items.push({ n: item[2] ? Number(item[2]) : undefined, text: item[3].trim() }); continue; }
    const kv = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) { out.fields[kv[1]] = kv[2].trim(); continue; }
    out.stray += 1;
  }
  return out;
}

function httpUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** One block → a DisplayBlock, or null when it is malformed (§9.1). */
export function parseBlock(name: string, body: string): DisplayBlock | null {
  const kind = name.replace(/^relay-/, '');
  const p = parseBody(body, kind);
  switch (kind) {
    case 'status': {
      const title = p.fields.title;
      if (!title) return null;
      const state = STATUS_STATES.has(p.fields.state) ? p.fields.state as 'working' : 'working';
      return {
        kind: 'status', state, title,
        ...(p.fields.progress ? { progress: p.fields.progress } : {}),
        ...(p.fields.detail ? { detail: p.fields.detail } : {}),
      };
    }
    case 'choices': {
      const question = p.fields.question;
      const numbered = p.items.filter((i) => i.n !== undefined && i.text);
      if (!question || numbered.length < 2) return null;
      const options = numbered.slice(0, 4).map((i) => ({ n: i.n as number, label: i.text }));
      const block: DisplayBlock = { kind: 'choices', question, options, allowOther: p.fields.allow_other === 'true' };
      if (numbered.length > 4) block.more = numbered.length - 4;
      return block;
    }
    case 'summary': {
      const title = p.fields.title;
      if (!title || p.items.length > 5) return null;
      return {
        kind: 'summary', title,
        ...(SUMMARY_RESULTS.has(p.fields.result) ? { result: p.fields.result as 'success' } : {}),
        bullets: p.items.map((i) => i.text),
      };
    }
    case 'files': {
      if (p.files.length < 1 || p.files.length > 50) return null;
      return { kind: 'files', files: p.files };
    }
    case 'link': {
      const url = p.fields.url ? httpUrl(p.fields.url) : null;
      if (!url) return null;
      return { kind: 'link', title: p.fields.title || url, url };
    }
    default:
      return null;
  }
}

/**
 * Lift well-formed relay-* blocks out of assistant markdown. Runs on complete
 * messages only. Malformed blocks are left in place (they render as code).
 */
export function parseDisplayBlocks(text: string): { text: string; blocks: DisplayBlock[] } {
  const blocks: DisplayBlock[] = [];
  const stripped = String(text).replace(BLOCK_RE, (whole: string, name: string, body: string) => {
    const block = parseBlock(name, body.replace(/\n$/, ''));
    if (!block) return whole;
    blocks.push(block);
    return '';
  });
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}
