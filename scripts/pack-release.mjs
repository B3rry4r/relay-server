#!/usr/bin/env node
// Pack a relay-server RELEASE for the relay host (CONTRACTS §3).
//
//   npm run pack:release [-- --out <dir>] [--id <release-id>] [--no-compile]
//
// Produces <out>/release.tgz + <out>/manifest.json (+ release.sha256) where
// manifest = {id, sha, dirty, lockHash, node, builtAt, entry, files}. The tarball
// holds package.json at its root (the host's installer requirement) plus every
// file the RUNTIME reads — and nothing else (no sources, tests or node_modules;
// the host installs dependencies from package-lock.json into its node store).
//
// Runtime-read files (keep in sync; test/pack-release.test.ts boots the result):
//   dist/src/**            compiled server (entry dist/src/index.js)
//   package.json           /api/version, getRelayServerRepoRoot(), npm ci
//   package-lock.json      npm ci (the host keys its node store by its sha256)
//   setup-workspace.sh     workspace-bootstrap.ts (cwd-relative) and the host's
//                          per-deploy workspace setup
//   scripts/relay-auth     installed into $RELAY_HOME/bin by setup-workspace.sh
//   mcp-server.mjs         `npm run mcp` / agent MCP config
//   native/pty-bridge.c    pty-bridge-factory.ts (optional native bridge build)
//   agent/**               agent display guide, relay-agent-hook, opencode plugin
//   scripts/relay-agent-install.mjs  run by setup-workspace.sh (agent hooks/guide)
//
// By default the server is compiled FRESH into a temp dir (never a stale dist/).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Files/dirs copied verbatim from the repo root (dist/src comes from the compile). */
export const RUNTIME_FILES = [
  'package.json',
  'package-lock.json',
  'setup-workspace.sh',
  'scripts/relay-auth',
  'scripts/relay-agent-install.mjs',
  'mcp-server.mjs',
  'native/pty-bridge.c',
];
/** Optional runtime directories: included when they exist. */
export const OPTIONAL_RUNTIME_DIRS = [];
/** Required runtime directories. */
export const RUNTIME_DIRS = ['agent'];
export const ENTRY = 'dist/src/index.js';

function parseArgs(argv) {
  const args = { out: path.join(ROOT, '.release'), id: '', compile: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--no-compile') args.compile = false;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, preserveTimestamps: false });
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

export function packRelease(options = {}) {
  const args = { out: path.join(ROOT, '.release'), id: '', compile: true, ...options };
  const sha = git(['rev-parse', 'HEAD']) || 'unknown';
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const id = args.id || process.env.RELAY_RELEASE_ID || `${sha.slice(0, 12)}${dirty ? '-dirty' : ''}-${stamp}`;
  if (!ID_PATTERN.test(id) || id === 'current') throw new Error(`invalid release id ${JSON.stringify(id)} (must match ${ID_PATTERN})`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pack-'));
  try {
    const stage = path.join(work, 'app');
    fs.mkdirSync(stage, { recursive: true });

    // 1. The compiled server.
    if (args.compile) {
      const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
      const buildDir = path.join(work, 'build');
      execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', buildDir, '--sourceMap', 'false'], { cwd: ROOT, stdio: 'inherit' });
      copy(path.join(buildDir, 'src'), path.join(stage, 'dist', 'src'));
    } else {
      if (!fs.existsSync(path.join(ROOT, ENTRY))) throw new Error(`${ENTRY} is missing — run npm run build or drop --no-compile`);
      copy(path.join(ROOT, 'dist', 'src'), path.join(stage, 'dist', 'src'));
    }
    if (!fs.existsSync(path.join(stage, ENTRY))) throw new Error(`compile produced no ${ENTRY}`);

    // 2. Every other runtime-read file.
    for (const rel of RUNTIME_FILES) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) throw new Error(`runtime file ${rel} is missing`);
      copy(src, path.join(stage, rel));
    }
    for (const rel of RUNTIME_DIRS) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) throw new Error(`runtime directory ${rel} is missing`);
      copy(src, path.join(stage, rel));
    }
    for (const rel of OPTIONAL_RUNTIME_DIRS) {
      const src = path.join(ROOT, rel);
      if (fs.existsSync(src)) copy(src, path.join(stage, rel));
    }
    for (const exe of ['setup-workspace.sh', 'scripts/relay-auth', 'scripts/relay-agent-install.mjs', 'agent/relay-agent-hook']) fs.chmodSync(path.join(stage, exe), 0o755);

    const files = listFiles(stage);
    const manifest = {
      id,
      sha,
      dirty,
      lockHash: sha256File(path.join(stage, 'package-lock.json')),
      node: process.version,
      builtAt: new Date().toISOString(),
      entry: ENTRY,
      files: files.length,
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // 3. Tarball (package.json at the root, reproducible ownership/order).
    fs.mkdirSync(args.out, { recursive: true });
    const tgz = path.join(args.out, 'release.tgz');
    execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tgz, '-C', stage, '.'], { stdio: 'inherit' });
    const tarSha = sha256File(tgz);
    fs.writeFileSync(path.join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(args.out, 'release.sha256'), `${tarSha}  release.tgz\n`);
    return { id, tgz, sha256: tarSha, manifest, files };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = packRelease(args);
  console.log(`release ${result.id}: ${result.tgz}`);
  console.log(`  sha256 ${result.sha256}`);
  console.log(`  ${result.files.length} files, entry ${result.manifest.entry}, lockHash ${result.manifest.lockHash.slice(0, 12)}, git ${result.manifest.sha.slice(0, 12)}${result.manifest.dirty ? ' (dirty)' : ''}`);
  console.log(`deploy: relay-host deploy ${result.tgz}   (or POST /__host/releases with X-Release-Id: ${result.id}, X-Release-Sha256: ${result.sha256})`);
}
