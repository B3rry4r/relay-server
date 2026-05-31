import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point the relay state root at a temp dir before importing the store (it reads
// getRelayStateRoot() via WORKSPACE → .relay/state).
let work: string;
beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-conv-'));
  process.env.WORKSPACE = work;
});
afterAll(async () => { await fs.rm(work, { recursive: true, force: true }).catch(() => {}); });

describe('conversation-store', () => {
  it('persists turns and survives a fresh read (durable context)', async () => {
    const store = await import('../src/relay-server/conversation-store');
    const c = await store.createConversation({ projectId: 'demo', model: 'claude' });
    await store.appendTurn(c.id, { role: 'user', content: 'build a login screen', model: 'claude' });
    await store.appendTurn(c.id, { role: 'assistant', content: '<code>', model: 'claude' });

    const reloaded = await store.getConversation(c.id);
    expect(reloaded).toBeTruthy();
    expect(reloaded!.turns.length).toBe(2);
    expect(reloaded!.turns[0].role).toBe('user');
    expect(reloaded!.turns[1].content).toBe('<code>');
    expect(reloaded!.projectId).toBe('demo');
  });

  it('appendTurn with no id creates a conversation; chaining keeps one', async () => {
    const store = await import('../src/relay-server/conversation-store');
    const c1 = await store.appendTurn(undefined, { role: 'user', content: 'hi' }, { projectId: 'p2' });
    const c2 = await store.appendTurn(c1.id, { role: 'assistant', content: 'yo' });
    expect(c2.id).toBe(c1.id);             // same conversation, not a new one
    expect(c2.turns.length).toBe(2);

    const list = await store.listConversations('p2');
    expect(list.find(x => x.id === c1.id)).toBeTruthy();
  });
});
