// =============================================================================
// File: src/relay-server/conversation-store.ts
//
// Durable conversation store (P4): persists AI turns to disk so context survives
// reconnects/restarts — replacing the previously ephemeral, terminal-scrollback-
// only context. Keyed by conversation id; optionally scoped to a project.
// Persisted under .relay/state/conversations/<id>.json.
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRelayStateRoot } from './runtime';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  at: string;
}

export interface Conversation {
  id: string;
  projectId?: string;
  model?: string;
  turns: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
}

function dir(): string {
  return path.join(getRelayStateRoot(), 'conversations');
}
function file(id: string): string {
  // id is validated before use; keep only safe chars.
  return path.join(dir(), `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

async function read(id: string): Promise<Conversation | null> {
  try { return JSON.parse(await fs.readFile(file(id), 'utf-8')) as Conversation; }
  catch { return null; }
}

async function write(c: Conversation): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(file(c.id), JSON.stringify(c, null, 2));
}

export async function createConversation(input: { projectId?: string; model?: string } = {}): Promise<Conversation> {
  const now = new Date().toISOString();
  const c: Conversation = { id: randomUUID(), projectId: input.projectId, model: input.model, turns: [], createdAt: now, updatedAt: now };
  await write(c);
  return c;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return read(id);
}

/** Append a turn, creating the conversation if it doesn't exist yet. Returns the
 *  conversation (so callers get the id even when they passed none). */
export async function appendTurn(
  id: string | undefined,
  turn: { role: 'user' | 'assistant'; content: string; model?: string },
  meta: { projectId?: string } = {},
): Promise<Conversation> {
  let c = id ? await read(id) : null;
  if (!c) c = await createConversation({ projectId: meta.projectId, model: turn.model });
  c.turns.push({ ...turn, at: new Date().toISOString() });
  c.updatedAt = new Date().toISOString();
  if (turn.model) c.model = turn.model;
  await write(c);
  return c;
}

export async function listConversations(projectId?: string): Promise<Array<Pick<Conversation, 'id' | 'projectId' | 'model' | 'createdAt' | 'updatedAt'> & { turnCount: number }>> {
  let names: string[] = [];
  try { names = (await fs.readdir(dir())).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const c = await read(n.replace(/\.json$/, ''));
    if (!c) continue;
    if (projectId && c.projectId !== projectId) continue;
    out.push({ id: c.id, projectId: c.projectId, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt, turnCount: c.turns.length });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
