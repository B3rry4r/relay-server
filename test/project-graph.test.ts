import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProjectGraph } from '../src/relay-server/project-graph';

const tmpRoots: string[] = [];
async function makeRoot(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-graph-'));
  tmpRoots.push(d);
  return d;
}
afterAll(async () => { for (const d of tmpRoots) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); });

async function repo(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(dir, f), c);
  return dir;
}

describe('project-graph', () => {
  it('infers products by grouping scattered repos and detecting stack/role', async () => {
    const root = await makeRoot();
    await repo(root, 'Kudimata-API', { 'composer.json': '{}' });
    await repo(root, 'Kudimata-Web', { 'package.json': JSON.stringify({ dependencies: { next: '14' } }) });
    await repo(root, 'Oja-Ewa-Mobile', { 'pubspec.yaml': 'name: x' });
    await repo(root, 'relay-web', { 'package.json': '{}' }); // platform → skipped

    const g = await buildProjectGraph(root);
    const kudimata = g.products.find(p => p.id === 'kudimata');
    expect(kudimata).toBeTruthy();
    expect(kudimata!.source).toBe('inferred');
    const roles = kudimata!.repos.map(r => `${r.role}:${r.stack}`).sort();
    expect(roles).toContain('backend:laravel');
    expect(roles).toContain('web:next');

    const oja = g.products.find(p => p.id === 'oja-ewa');
    expect(oja!.repos[0].stack).toBe('flutter');
    expect(oja!.repos[0].role).toBe('mobile');

    // platform repo excluded from products
    expect(g.products.find(p => p.id === 'relay-web')).toBeFalsy();
  });

  it('a committed product.json is authoritative and strips remote creds', async () => {
    const root = await makeRoot();
    await repo(root, 'acme', {
      'product.json': JSON.stringify({
        product: 'acme', displayName: 'Acme',
        repos: [{ role: 'backend', path: 'backend', stack: 'nest', remote: 'https://user:ghp_secret@github.com/o/acme.git' }],
        figma: { source: 'fig://acme/main' },
      }),
    });
    const g = await buildProjectGraph(root);
    const acme = g.products.find(p => p.id === 'acme');
    expect(acme!.source).toBe('manifest');
    expect(acme!.displayName).toBe('Acme');
    expect(acme!.figma!.source).toBe('fig://acme/main');
    expect(acme!.repos[0].remote).toBe('https://github.com/o/acme.git'); // creds stripped
  });
});
