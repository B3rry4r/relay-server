#!/usr/bin/env node
// REAL end-to-end: relay-server releases packed from THIS tree, deployed through
// the relay host (relay-pty) — no fake releases. Runs on any Linux box with node,
// no Docker.
//
//   node scripts/e2e-host-real.mjs [--host-dir ../relay-pty] [--keep]
//
// Proves, against the real host and the real relay-server:
//   - three real releases deploy through /__host/releases (install → npm ci into
//     the node store → standby → readiness probe with the local token → drain the
//     old release → activate over IPC); /api/version flips each time
//   - an Option B terminal (/pty/socket.io, relay session token from a REAL
//     /api/auth/login through the front door) keeps the SAME shell pid across
//     two relay-server deploys, and every keystroke typed during a swap arrives
//   - the Option A bridge (/socket.io through relay-server) reaches the same
//     terminals; terminal:input acks; a noTerminals socket gets no terminals
//   - the shell env has RELAY_TERMINAL_ID and none of the stripped secrets
//   - a run interrupted by a deploy is left resumable by the old release's
//     graceful SIGTERM and RESUMED by the new one; the old release's agent
//     process group is gone: no process carries the old RELAY_RELEASE_ID
//   - bad releases are rejected: sha mismatch (400, nothing installed), a
//     release that crashes at boot (FAILED, current unchanged, terminal intact)
//   - teardown leaves no process with this WORKSPACE behind
//
// --keep: after the checks, leave the host running (for the relay-web Option B
// browser check) and write <workspace>/e2e-keep.json {base, token, ...}; stop
// with SIGINT/SIGTERM.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packRelease } from './pack-release.mjs';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };
const HOST_DIR = path.resolve(argValue('--host-dir', process.env.RELAY_HOST_DIR || path.join(ROOT, '..', 'relay-pty')));
const KEEP = argv.includes('--keep');
const EXTRA_ORIGINS = argValue('--origins', process.env.E2E_ALLOWED_ORIGINS || '');
const HOST_ENTRY = path.join(HOST_DIR, 'dist', 'src', 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let hostProc = null;
let hostLog = '';
const sockets = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}
async function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`FAIL ${name} — ${detail}`);
  console.log('---- host log tail ----');
  try { console.log(fs.readFileSync(hostLog, 'utf8').split('\n').slice(-80).join('\n')); } catch { /* none */ }
  await teardown();
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(REL, { recursive: true, force: true });
  process.exit(1);
}
async function check(name, cond, detail = '') {
  const [onPass, onFail] = Array.isArray(detail) ? detail : [detail, detail];
  if (cond) pass(name, typeof onPass === 'string' ? onPass : JSON.stringify(onPass));
  else await fail(name, typeof onFail === 'string' ? onFail : JSON.stringify(onFail));
}
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
async function waitFor(fn, ms = 8000, step = 100) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

if (!fs.existsSync(HOST_ENTRY)) {
  console.log(`building the host in ${HOST_DIR} …`);
  execFileSync('npm', ['run', 'build'], { cwd: HOST_DIR, stdio: 'inherit' });
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-real-'));
const REL = `${WS}-rel`;
fs.mkdirSync(REL, { recursive: true });
const DEPLOY_TOKEN = `dep_${crypto.randomBytes(24).toString('hex')}`;
const OWNER = `own_${crypto.randomBytes(24).toString('hex')}`;
const [F, PTY, P1, P2] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
const BASE = `http://127.0.0.1:${F}`;
const WEB_ORIGIN = 'http://relay-web.test';

function hostEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RELAY_') || k === 'AUTH_TOKEN' || k === 'AUTH_TOKEN_HASH' || k === 'PORT') delete env[k];
  return {
    ...env,
    WORKSPACE: WS,
    HOME: WS,
    PORT: String(F),
    RELAY_PTY_PORT: String(PTY),
    RELAY_RELEASE_PORTS: `${P1},${P2}`,
    RELAY_DEPLOY_TOKEN: DEPLOY_TOKEN,
    AUTH_TOKEN: OWNER,
    // The REAL workspace setup runs (the release's setup-workspace.sh) — but never
    // against this box's /etc/machine-id or hostname.
    RELAY_SETUP_SYSTEM_IDENTITY: '0',
    RELAY_MIN_FREE_BYTES: '1',
    RELAY_HEALTH_TIMEOUT_MS: '60000',
    RELAY_DRAIN_MS: '10000',
    RELAY_SHUTDOWN_MS: '8000',
    RELAY_RESTART_BACKOFF_MS: '300',
    RELAY_CRASH_WINDOW_MS: '60000',
    RELAY_KEEP_RELEASES: '10',
    RELAY_ALLOWED_ORIGINS: [WEB_ORIGIN, ...EXTRA_ORIGINS.split(',').filter(Boolean)].join(','),
    RELAY_SEED_RELEASE: path.join(WS, 'no-seed.tgz'),
    RELAY_RUN_LEASE_HEARTBEAT_MS: '2000',
    SHELL: 'bash',
    ...extra,
  };
}

async function startHost() {
  hostLog = path.join(REL, `host-${Date.now()}.log`);
  const fd = fs.openSync(hostLog, 'w');
  hostProc = spawn(process.execPath, [HOST_ENTRY], { env: hostEnv(), stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const ok = await waitFor(async () => { try { return (await fetch(`${BASE}/__host/health`)).ok; } catch { return false; } }, 20000, 150);
  if (!ok) await fail('host boot', 'no /__host/health within 20 s');
}
async function stopHost() {
  if (!hostProc || hostProc.exitCode !== null) return;
  const exited = new Promise((r) => hostProc.once('exit', r));
  hostProc.kill('SIGTERM');
  await Promise.race([exited, sleep(30000)]);
  if (hostProc.exitCode === null) hostProc.kill('SIGKILL');
}
async function teardown() {
  for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
  await stopHost();
  saveEvidence();
}
// E2E_EVIDENCE_DIR: keep the host log and every release log after the temp
// workspace is deleted.
function saveEvidence() {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (hostLog && fs.existsSync(hostLog)) fs.copyFileSync(hostLog, path.join(dir, 'host.log'));
    const rels = path.join(WS, '.relay/releases');
    for (const id of fs.existsSync(rels) ? fs.readdirSync(rels) : []) {
      const log = path.join(rels, id, 'logs/release.log');
      if (fs.existsSync(log)) fs.copyFileSync(log, path.join(dir, `release-${id}.log`));
    }
    for (const f of [`projects/p1/.uix/runs/${'run_1700000000000_e2e'}.log`, `projects/p1/.uix/runs/${'run_1700000000000_e2e'}.json`]) {
      if (fs.existsSync(path.join(WS, f))) fs.copyFileSync(path.join(WS, f), path.join(dir, path.basename(f)));
    }
  } catch (error) { console.log(`evidence copy failed: ${error.message}`); }
}

const deployAuth = { authorization: `Bearer ${DEPLOY_TOKEN}` };
async function api(method, route, body, headers = {}) {
  const r = await fetch(`${BASE}${route}`, { method, headers: { ...deployAuth, ...headers }, body });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}
async function deploy(rel, id = rel.id, sha = rel.sha256) {
  return api('POST', '/__host/releases', fs.readFileSync(rel.tgz), {
    'content-type': 'application/gzip', 'x-release-id': id, 'x-release-sha256': sha,
  });
}
async function waitDeploy(deployId, timeoutMs = 600000) {
  let last;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = (await api('GET', `/__host/deploys/${deployId}`)).json;
    if (['ACTIVE', 'FAILED', 'ROLLED_BACK'].includes(last.state)) return last;
    await sleep(300);
  }
  return last;
}
async function version() {
  try { const r = await fetch(`${BASE}/api/version`); return r.ok ? (await r.json()).releaseId : `HTTP ${r.status}`; } catch (e) { return e.message; }
}
function procEnv(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'); } catch { return null; }
}
function procState(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2)[0]; } catch { return null; }
}
const alive = (pid) => { const s = procState(pid); return s !== null && s !== 'Z'; };
function pidsWithEnv(entry) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const env = procEnv(name);
    if (env && env.includes(entry) && alive(Number(name))) out.push(Number(name));
  }
  return out;
}

function terminalClient(token, opts = {}) {
  const state = { ready: [], replay: {}, output: {}, connects: 0, disconnects: 0, errors: [], events: [] };
  const socket = io(BASE, {
    path: opts.path ?? '/pty/socket.io',
    transports: ['websocket'],
    forceNew: true,
    reconnection: opts.reconnection ?? true,
    reconnectionDelay: 300,
    auth: { token, ...(opts.auth ?? {}) },
  });
  socket.on('connect', () => { state.connects += 1; });
  socket.on('disconnect', () => { state.disconnects += 1; });
  socket.on('connect_error', (e) => { state.errors.push(e.message); });
  socket.onAny((event, payload) => {
    state.events.push(event);
    if (event === 'terminals:ready') state.ready.push(payload.terminals);
    if (event === 'terminal:replay') state.replay[payload.id] = payload.data;
    if (event === 'terminal:output') state.output[payload.id] = (state.output[payload.id] || '') + payload.data;
  });
  sockets.push(socket);
  return { socket, state };
}

// --------------------------------------------------------------- fixtures
console.log(`workspace ${WS}\nhost ${HOST_DIR}\nports front=${F} pty=${PTY} releases=${P1},${P2}`);
const packDir = (id) => path.join(REL, id);
console.log('packing real releases from', ROOT);
const real1 = packRelease({ out: packDir('real-1'), id: 'real-1' });
const real2 = packRelease({ out: packDir('real-2'), id: 'real-2' });
const real3 = packRelease({ out: packDir('real-3'), id: 'real-3' });
// A release that crashes at boot: the real tarball with its entry replaced.
function brokenRelease(id) {
  const dir = path.join(REL, `${id}-stage`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', real1.tgz, '-C', dir]);
  fs.writeFileSync(path.join(dir, 'dist/src/index.js'), "console.error('boom: broken release'); process.exit(3);\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id }, null, 2));
  const tgz = path.join(REL, `${id}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
  return { id, tgz, sha256: crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex') };
}
const broken = brokenRelease('broken-1');
// A release that boots, LISTENS in standby and then fails the host's readiness
// probe (it reports ptyMode 'embedded', not 'remote'). A standby that published
// itself as the shared api-url at listen time left relay-auth / mcp-server /
// the CLAUDE.md recipe pointed at its dead port (critic P1).
function unreadyRelease(id) {
  const dir = path.join(REL, `${id}-stage`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', real1.tgz, '-C', dir]);
  const entry = path.join(dir, 'dist/src/index.js');
  fs.writeFileSync(entry, `process.env.RELAY_PTY_MODE = 'embedded';\n${fs.readFileSync(entry, 'utf8')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id }, null, 2));
  const tgz = path.join(REL, `${id}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
  return { id, tgz, sha256: crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex') };
}
const unready = unreadyRelease('unready-1');
// relay-auth exactly as a relay-pty shell runs it: no RELAY_API_URL, no PORT.
function relayAuth(...args) {
  const env = { PATH: process.env.PATH, HOME: WS, WORKSPACE: WS, RELAY_LOCAL_TOKEN_FILE: path.join(WS, '.relay/state/local-token') };
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(WS, '.relay/bin/relay-auth'), ...args], { env, encoding: 'utf8', timeout: 15000 }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}
const apiUrlFile = () => { try { return fs.readFileSync(path.join(WS, '.relay/state/api-url'), 'utf8').trim(); } catch { return ''; } };

// No network downloads during the real workspace setup: mise + nvm already "installed".
fs.mkdirSync(path.join(WS, '.relay/tools/mise/bin'), { recursive: true });
fs.writeFileSync(path.join(WS, '.relay/tools/mise/bin/mise'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.mkdirSync(path.join(WS, '.relay/tools/nvm'), { recursive: true });
fs.writeFileSync(path.join(WS, '.relay/tools/nvm/nvm.sh'), '# stub\n');
// A fake agent CLI: records its pid (+ the child it forks into its process
// group) with the RELAY_RELEASE_ID it inherited, then blocks.
fs.mkdirSync(path.join(WS, '.relay/bin'), { recursive: true });
fs.writeFileSync(path.join(WS, '.relay/bin/claude'), `#!/usr/bin/env bash\nsleep 900 &\necho "$$ $! \${RELAY_RELEASE_ID:-none}" >> "${WS}/agent-pids"\nwait\n`, { mode: 0o755 });
const agents = () => { try { return fs.readFileSync(path.join(WS, 'agent-pids'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [pid, child, rel] = l.split(' '); return { pid: Number(pid), child: Number(child), rel }; }); } catch { return []; } };
// A run interrupted by "the previous release": running + resumable.
const RUN_ID = 'run_1700000000000_e2e';
const runDir = path.join(WS, 'projects/p1/.uix/runs');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(WS, 'projects/p1/ref.png'), '');
const now = new Date().toISOString();
fs.writeFileSync(path.join(runDir, `${RUN_ID}.json`), JSON.stringify({
  id: RUN_ID, projectId: 'p1', kind: 'selected', framework: 'flutter', model: 'claude', verify: false, maxIterations: 1, finalize: false,
  screens: [{ frameId: 'f1', frameName: 'Home', status: 'pending', spec: { packet: 'Build the Home screen.', referenceImagePath: 'ref.png', width: 390, height: 844 } }],
  status: 'running', resumable: true, createdAt: now, updatedAt: now,
}, null, 2));
const readRun = () => JSON.parse(fs.readFileSync(path.join(runDir, `${RUN_ID}.json`), 'utf8'));
const runLog = () => { try { return fs.readFileSync(path.join(runDir, `${RUN_ID}.log`), 'utf8'); } catch { return ''; } };
const releaseLog = (id) => { try { return fs.readFileSync(path.join(WS, `.relay/releases/${id}/logs/release.log`), 'utf8'); } catch { return ''; } };

// ------------------------------------------------------------------- boot
await startHost();
pass('host boots', `pid ${hostProc.pid}`);

// ---------------------------------------------------------- deploy real-1
let r = await deploy(real1);
await check('deploy real-1 accepted', r.status === 202, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
let d = await waitDeploy(r.json.deployId);
await check('deploy real-1 ACTIVE (npm ci into the node store, real setup-workspace.sh, readiness probe)', d.state === 'ACTIVE', `state ${d.state} ${d.error || ''}\n${(d.log || []).slice(-25).join('\n')}`);
await check('install ran the release\'s setup-workspace.sh', fs.readFileSync(path.join(WS, '.bootstrap-status'), 'utf8').includes('relay_auth=ready') && fs.existsSync(path.join(WS, '.relay/bin/relay-auth')), 'relay-auth installed from the release');
await check('/api/version through the front door = real-1', (await version()) === 'real-1', await version());
{
  const h = await (await fetch(`${BASE}/health`)).json();
  await check('/health: real release, active, remote PTY', h.ok === true && h.releaseId === 'real-1' && h.mode === 'active' && h.ptyMode === 'remote', JSON.stringify(h));
}

// A real session through the front door.
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: OWNER, label: 'e2e' }) });
const loginBody = await login.json();
await check('POST /api/auth/login through the front door → session token', login.status === 200 && /^rs_/.test(loginBody.token || ''), `HTTP ${login.status}`);
const SESSION = loginBody.token;
{
  const unauth = await fetch(`${BASE}/api/projects`);
  await check('front door → release is default-deny', unauth.status === 401, `HTTP ${unauth.status}`);
}

// The interrupted run is resumed by the activated release, which reaches the agent.
await check('real-1 resumed the interrupted run and started its agent', Boolean(await waitFor(() => agents().some((a) => a.rel === 'real-1'), 60000)), runLog().slice(-800));
const agent1 = agents().find((a) => a.rel === 'real-1');
await check('real-1 holds the run lease', readRun().lease?.releaseId === 'real-1', JSON.stringify(readRun().lease));

// ------------------------------------------------------ Option B terminal
const tB = terminalClient(SESSION);
await check('Option B socket (/pty/socket.io, session token) gets terminals:ready', await waitFor(() => tB.state.ready.length > 0), tB.state.errors.join(','));
let term = tB.state.ready[0][0];
if (!term) {
  tB.socket.emit('terminal:create', {});
  term = (await waitFor(() => tB.state.ready.flat()[0] || null)) || null;
}
await check('a terminal exists', Boolean(term?.id), JSON.stringify(tB.state.ready));
tB.socket.emit('terminal:select', { id: term.id });
await sleep(300);
tB.socket.emit('input', 'echo BEFORE-$$\n');
await check('command runs in the Option B terminal', await waitFor(() => (tB.state.output[term.id] || '').includes(`BEFORE-${term.pid}`)), (tB.state.output[term.id] || '').slice(-300));
tB.socket.emit('terminal:input', { id: term.id, data: 'echo "TID=$RELAY_TERMINAL_ID AT=${AUTH_TOKEN:-none} PT=${RELAY_PTY_TOKEN:-none} DT=${RELAY_DEPLOY_TOKEN:-none} P=${PORT:-none} RID=${RELAY_RELEASE_ID:-none}"\n' });
const envLine = await waitFor(() => /TID=\S+ AT=\S+ PT=\S+ DT=\S+ P=\S+ RID=\S+/.exec((tB.state.output[term.id] || '').replace(/\r/g, '').split('\n').filter((l) => !l.includes('echo')).join('\n'))?.[0]);
await check('shell env: RELAY_TERMINAL_ID set, secrets / PORT / release tag stripped', envLine === `TID=${term.id} AT=none PT=none DT=none P=none RID=none`, envLine || 'no env line');

// ------------------------------------------------ Option A bridge (real)
{
  const tA = terminalClient(SESSION, { path: '/socket.io', reconnection: false });
  await check('Option A: relay-server bridge delivers terminals:ready with the same terminal', await waitFor(() => tA.state.ready.length > 0 && tA.state.ready[0].some((t) => t.id === term.id && t.pid === term.pid)), JSON.stringify(tA.state.ready));
  const ack = await Promise.race([new Promise((resolve) => tA.socket.emit('terminal:input', { id: term.id, data: 'echo VIA-BRIDGE-$$\n' }, resolve)), sleep(5000).then(() => 'no-ack')]);
  await check('Option A: terminal:input through the bridge is acked and runs in the same shell', ack && ack.ok === true && await waitFor(() => (tB.state.output[term.id] || '').includes(`VIA-BRIDGE-${term.pid}`)), JSON.stringify(ack));
  tA.socket.close();
  const main = terminalClient(SESSION, { path: '/socket.io', reconnection: false, auth: { noTerminals: true } });
  await waitFor(() => main.state.connects > 0);
  main.socket.emit('terminal:create', {});
  await sleep(800);
  await check('noTerminals main socket: connected, no terminal events, no terminal created', main.state.connects === 1 && !main.state.events.some((e) => e.startsWith('terminal')), JSON.stringify(main.state.events));
  main.socket.close();
}

// ------------------------------------------------- swap 1: real-1 → real-2
async function swap(fromRel, toRel, label) {
  const before = tB.state.disconnects;
  let n = 0;
  const typer = setInterval(() => { n += 1; tB.socket.emit('input', `echo ${label}-${n}\n`); }, 50);
  const res = await deploy(toRel);
  const dep = res.status === 202 ? await waitDeploy(res.json.deployId) : { state: `HTTP ${res.status}`, error: JSON.stringify(res.json) };
  clearInterval(typer);
  await check(`deploy ${toRel.id} ACTIVE`, dep.state === 'ACTIVE', `state ${dep.state} ${dep.error || ''}`);
  await check(`${label}: state machine drain-first order`, dep.transitions.map((t) => t.state).join('>') === 'QUEUED>INSTALLING>STARTING>READY>DRAINING_OLD>SWITCHING>ACTIVATING>ACTIVE', dep.transitions.map((t) => t.state).join('>'));
  await check(`${label}: /api/version = ${toRel.id}`, (await version()) === toRel.id, await version());
  // The last lines may still be in flight when the deploy call returns.
  await waitFor(() => new RegExp(`${label}-${n}\\r?\\n`).test((tB.state.output[term.id] || '').replace(/echo [^\r\n]*/g, '')), 5000);
  const out = tB.state.output[term.id] || '';
  const missing = [];
  for (let i = 1; i <= n; i += 1) if (!new RegExp(`${label}-${i}\\r?\\n`).test(out.replace(/echo [^\r\n]*/g, ''))) missing.push(i);
  await check(`${label}: all ${n} lines typed during the swap were delivered, no terminal disconnect`, missing.length === 0 && tB.state.disconnects === before, `missing ${missing.join(',')} disconnects ${tB.state.disconnects - before}`);
  tB.socket.emit('input', `echo AFTER-${label}-$$\n`);
  await check(`${label}: the SAME shell pid answers after the deploy`, Boolean(await waitFor(() => (tB.state.output[term.id] || '').includes(`AFTER-${label}-${term.pid}`))), `pid ${term.pid}`);
  const oldLog = releaseLog(fromRel.id);
  await check(`${label}: ${fromRel.id} shut down gracefully (SIGTERM handler ran, runs left resumable)`, /shutdown complete in \d+ ms — runs left resumable: [^;]*run_1700000000000_e2e/.test(oldLog), oldLog.split('\n').filter((l) => l.includes('lifecycle')).slice(-4).join(' | '));
  await check(`${label}: no process carries RELAY_RELEASE_ID=${fromRel.id} (agent group killed, release swept)`, (await waitFor(() => pidsWithEnv(`RELAY_RELEASE_ID=${fromRel.id}`).length === 0, 8000)) !== null, JSON.stringify(pidsWithEnv(`RELAY_RELEASE_ID=${fromRel.id}`)));
  return dep;
}

await swap(real1, real2, 'SWAP1');
await check('the old agent (and the child in its group) are dead', !alive(agent1.pid) && !alive(agent1.child), `${agent1.pid}/${agent1.child}`);
await check('run log: interrupted by release swap, then resumed by the next release', /interrupted by release swap \(SIGTERM\) — will resume[\s\S]*resuming interrupted run/.test(runLog()), runLog().split('\n').filter((l) => /interrupted|resuming/.test(l)).join(' | '));
await check('real-2 resumed the run: new agent tagged real-2, lease now real-2', Boolean(await waitFor(() => agents().some((a) => a.rel === 'real-2') && readRun().lease?.releaseId === 'real-2', 60000)), JSON.stringify({ agents: agents(), lease: readRun().lease }));

// ------------------------------------------------------------- bad releases
r = await deploy(real3, 'real-3', '0'.repeat(64));
{
  const dep = r.status === 202 ? await waitDeploy(r.json.deployId) : null;
  await check('sha mismatch → deploy FAILED at install, nothing installed', r.status >= 400 || (dep?.state === 'FAILED' && /sha256 mismatch/.test(dep.error || '')), `HTTP ${r.status} → ${dep ? `${dep.state}: ${dep.error}` : JSON.stringify(r.json)}`);
}
await check('…and real-3 is not installed', !fs.existsSync(path.join(WS, '.relay/releases/real-3/app/package.json')) || (await api('GET', '/__host/status')).json.current === 'real-2', 'ok');
r = await deploy(broken);
d = r.status === 202 ? await waitDeploy(r.json.deployId) : { state: `HTTP ${r.status}` };
await check('a release that crashes at boot → FAILED at the health step', d.state === 'FAILED' && /health/.test(d.error || ''), `${d.state} ${d.error || ''}`);
await check('current is still real-2 and serving', (await version()) === 'real-2' && (await api('GET', '/__host/status')).json.current === 'real-2', await version());
await check('no process of the broken release survives', pidsWithEnv('RELAY_RELEASE_ID=broken-1').length === 0, JSON.stringify(pidsWithEnv('RELAY_RELEASE_ID=broken-1')));
r = await deploy(unready);
d = r.status === 202 ? await waitDeploy(r.json.deployId) : { state: `HTTP ${r.status}` };
await check('a release that boots and listens but fails readiness → FAILED', d.state === 'FAILED' && /ptyMode|remote|embedded|readiness|health/i.test(d.error || ''), `${d.state} ${d.error || ''}`);
await check('current is still real-2', (await api('GET', '/__host/status')).json.current === 'real-2', 'ok');
{
  const url = apiUrlFile();
  let h = null;
  try { h = await (await fetch(`${url}/health`)).json(); } catch { /* dead port */ }
  await check('the shared api-url still points at the ACTIVE release (real-2), not the rejected standby', h?.releaseId === 'real-2' && h?.mode === 'active', `${url} → ${JSON.stringify(h)}`);
  const sessions = relayAuth('sessions', '--json');
  let list = null;
  try { list = JSON.parse(sessions.out).sessions; } catch { /* not JSON */ }
  await check('`relay-auth sessions` (shell env: no RELAY_API_URL, no PORT) still works after the rejected releases', sessions.code === 0 && Array.isArray(list) && list.length > 0, `exit ${sessions.code}: ${sessions.out.slice(0, 300)}`);
}
{
  const t = (await (await fetch(`${BASE}/api/terminals`, { headers: { authorization: `Bearer ${SESSION}` } })).json()).terminals.find((x) => x.id === term.id);
  await check('terminal pid unchanged after the bad deploys', t && t.pid === term.pid, JSON.stringify(t));
}

// ------------------------------------------------- swap 2: real-2 → real-3
await swap(real2, real3, 'SWAP2');
{
  let h = null;
  try { h = await (await fetch(`${apiUrlFile()}/health`)).json(); } catch { /* dead port */ }
  await check('after activating real-3 the shared api-url points at real-3', h?.releaseId === 'real-3', `${apiUrlFile()} → ${JSON.stringify(h)}`);
}
await check('real-3 resumed the run (lease real-3)', Boolean(await waitFor(() => agents().some((a) => a.rel === 'real-3') && readRun().lease?.releaseId === 'real-3', 60000)), JSON.stringify(readRun().lease));
{
  const fresh = terminalClient(SESSION, { reconnection: false });
  await waitFor(() => fresh.state.ready.length > 0 && fresh.state.replay[term.id]);
  const t2 = (fresh.state.ready[0] || []).find((t) => t.id === term.id);
  await check('after TWO real deploys: same terminal id + shell pid, replay holds pre-deploy output', t2 && t2.pid === term.pid && (fresh.state.replay[term.id] || '').includes(`BEFORE-${term.pid}`), JSON.stringify(t2));
  fresh.socket.close();
}
await check('only real-3 (and its children) carry a release tag', pidsWithEnv('RELAY_RELEASE_ID=real-1').length + pidsWithEnv('RELAY_RELEASE_ID=real-2').length === 0, JSON.stringify({ r1: pidsWithEnv('RELAY_RELEASE_ID=real-1'), r2: pidsWithEnv('RELAY_RELEASE_ID=real-2') }));

if (KEEP) {
  const keep = { base: BASE, token: SESSION, workspace: WS, hostLog, terminal: term, pid: hostProc.pid, releases: [real1.id, real2.id, real3.id], owner: OWNER, deployToken: DEPLOY_TOKEN };
  fs.writeFileSync(path.join(WS, 'e2e-keep.json'), JSON.stringify(keep, null, 2), { mode: 0o600 });
  console.log(`\nE2E checks OK (${results.length}); host kept running at ${BASE}; details in ${path.join(WS, 'e2e-keep.json')}`);
  for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
  const stop = async () => {
    await teardown();
    await sleep(2500);
    const leftovers = pidsWithEnv(`WORKSPACE=${WS}`);
    console.log(leftovers.length ? `LEFTOVER processes: ${JSON.stringify(leftovers)}` : 'teardown: no process left with this WORKSPACE');
    fs.rmSync(WS, { recursive: true, force: true });
    fs.rmSync(REL, { recursive: true, force: true });
    process.exit(leftovers.length ? 1 : 0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

// ---------------------------------------------------------------- teardown
await teardown();
await sleep(2500);
const leftovers = pidsWithEnv(`WORKSPACE=${WS}`);
await check('teardown: no process left with this WORKSPACE', leftovers.length === 0, JSON.stringify(leftovers));
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(REL, { recursive: true, force: true });
console.log(`\nE2E REAL OK: ${results.length} checks passed`);
process.exit(0);
