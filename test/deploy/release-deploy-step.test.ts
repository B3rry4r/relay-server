// Runs the EXACT `run:` script of the release.yml deploy step (extracted from
// the workflow file, not a copy) against a scripted fake of the relay host API.
//
// Regression: the step used to stop polling at the first ACTIVE. The host
// sets ROLLED_BACK later, when a release crash-loops after activation, so CI
// went green for a release the host then rolled back and marked bad.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WORKFLOW = path.resolve(process.cwd(), '.github/workflows/release.yml');
const STEP_NAME = /^\s*- name: Deploy to the relay host/;
const RELEASE_ID = 'rs-test-2';
const PREVIOUS_ID = 'rs-good-1';
const TOKEN = 't'.repeat(48);

/** The step's `run: |` block, de-indented, exactly as Actions would run it. */
function extractDeployScript(): string {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const stepAt = lines.findIndex((l) => STEP_NAME.test(l));
  expect(stepAt, 'deploy step not found in release.yml').toBeGreaterThanOrEqual(0);
  const runAt = lines.findIndex((l, i) => i > stepAt && /^\s+run: \|\s*$/.test(l));
  expect(runAt).toBeGreaterThan(stepAt);
  const keyIndent = lines[runAt].indexOf('run:');
  const body: string[] = [];
  let indent = -1;
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const lead = l.length - l.trimStart().length;
    if (lead <= keyIndent) break;
    if (indent < 0) indent = lead;
    body.push(l.slice(indent));
  }
  return `${body.join('\n').trimEnd()}\n`;
}

type Record_ = { id: string; state: string; error?: string; log: string[]; transitions: Array<{ state: string; at: string }> };
type Status = {
  current: string | null;
  previous: string | null;
  bad: string[];
  active: { id: string; mode: string; crashes: number } | null;
  down: { since: number; reason: string } | null;
  history: unknown[];
};

type Scenario = {
  /** Called on every GET /__host/deploys/:id with the 1-based poll count after the upload. */
  onDeployPoll: (n: number, record: Record_, status: Status) => void;
  /** Return true to make this status poll fail with 502. */
  failStatus?: (n: number) => boolean;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function transition(record: Record_, state: string, error?: string): void {
  record.state = state;
  if (error) record.error = error;
  record.transitions.push({ state, at: new Date().toISOString() });
  record.log.push(`-> ${state}${error ? ` (${error})` : ''}`);
}

async function fakeHost(scenario: Scenario): Promise<{ url: string; statusPolls: () => number }> {
  const record: Record_ = { id: 'd_test_1', state: 'QUEUED', log: ['queued'], transitions: [{ state: 'QUEUED', at: new Date().toISOString() }] };
  const status: Status = {
    current: PREVIOUS_ID, previous: null, bad: [],
    active: { id: PREVIOUS_ID, mode: 'active', crashes: 0 }, down: null, history: [],
  };
  let deployPolls = 0;
  let statusPolls = 0;
  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { json(401, { error: 'unauthorized' }); return; }
    if (req.method === 'POST' && req.url?.startsWith('/__host/releases')) {
      req.resume();
      req.on('end', () => json(202, { deployId: record.id }));
      return;
    }
    if (req.method === 'GET' && req.url === `/__host/deploys/${record.id}`) {
      deployPolls += 1;
      scenario.onDeployPoll(deployPolls, record, status);
      json(200, record);
      return;
    }
    if (req.method === 'GET' && req.url === '/__host/status') {
      statusPolls += 1;
      if (scenario.failStatus?.(statusPolls)) { json(502, { error: 'bad gateway' }); return; }
      json(200, status);
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, statusPolls: () => statusPolls };
}

/** Deploy goes ACTIVE on the first poll with RELEASE_ID running. */
function activate(n: number, record: Record_, status: Status): void {
  if (n === 1) {
    transition(record, 'ACTIVE');
    status.previous = status.current;
    status.current = RELEASE_ID;
    status.active = { id: RELEASE_ID, mode: 'active', crashes: 0 };
  }
}

async function runStep(hostUrl: string, stableSecs = 3): Promise<{ code: number; out: string; elapsedMs: number; summary: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-deploy-step-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tgz = crypto.randomBytes(256);
  fs.writeFileSync(path.join(dir, 'release.tgz'), tgz);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: RELEASE_ID }));
  fs.writeFileSync(path.join(dir, 'release.sha256'), `${crypto.createHash('sha256').update(tgz).digest('hex')}\n`);
  fs.writeFileSync(path.join(dir, 'step.sh'), extractDeployScript());
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    RELAY_HOST_URL: `${hostUrl}/`,
    RELAY_DEPLOY_TOKEN: TOKEN,
    WAIT_IDLE: '',
    FORCE: '',
    BUSY_WAIT_SECS: '5',
    DEPLOY_TIMEOUT_SECS: '20',
    POLL_SECS: '0.2',
    STABLE_SECS: String(stableSecs),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
  };
  const started = Date.now();
  // Actions runs `bash --noprofile --norc -eo pipefail {0}`.
  const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'step.sh'], { cwd: dir, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  const summaryFile = path.join(dir, 'summary.md');
  return { code, out, elapsedMs: Date.now() - started, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '' };
}

describe('release.yml deploy step', () => {
  it('passes a release that stays ACTIVE, and only after the stability window', async () => {
    const host = await fakeHost({ onDeployPoll: activate });
    const r = await runStep(host.url, 3);
    expect(r.out).toContain(`Release ${RELEASE_ID} is ACTIVE and stayed up for 3s.`);
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1900); // bash SECONDS is whole seconds
    expect(host.statusPolls()).toBeGreaterThan(3);
  }, 30_000);

  it('fails when the host rolls the release back after ACTIVE (crash loop)', async () => {
    // The skeptic's live repro: ACTIVE first, ROLLED_BACK ~1 s later.
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        activate(n, record, status);
        if (n === 6) {
          status.bad = [RELEASE_ID];
          status.current = PREVIOUS_ID;
          status.previous = RELEASE_ID;
          status.active = { id: PREVIOUS_ID, mode: 'active', crashes: 0 };
          transition(record, 'ROLLED_BACK', `crash loop; rolled back to ${PREVIOUS_ID}`);
        }
      },
    });
    const r = await runStep(host.url, 10);
    expect(r.code).toBe(1);
    expect(r.out).toContain('deploy record moved to ROLLED_BACK: crash loop; rolled back to rs-good-1');
    expect(r.out).not.toContain('stayed up');
    expect(r.summary).toContain('UNSTABLE, ROLLED_BACK');
    // It fails as soon as it sees the rollback, not at the end of the window.
    expect(r.elapsedMs).toBeLessThan(8000);
  }, 30_000);

  it('fails when the host marks the release bad before the record moves', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        activate(n, record, status);
        if (n === 4) { status.bad = [RELEASE_ID]; status.active = null; status.down = { since: Date.now(), reason: 'crash loop' }; }
      },
    });
    const r = await runStep(host.url, 10);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`the host put ${RELEASE_ID} on its bad list`);
  }, 30_000);

  it('fails a first release that crashes and restarts (no previous, so never ROLLED_BACK)', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        activate(n, record, status);
        status.previous = null;
        if (n === 3) { status.active = null; status.down = { since: Date.now(), reason: `release ${RELEASE_ID} exited unexpectedly (code=3 signal=null)` }; }
        if (n === 5) { status.down = null; status.active = { id: RELEASE_ID, mode: 'active', crashes: 1 }; }
      },
    });
    const r = await runStep(host.url, 3);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/crashed 1 time\(s\) within 3s of activation|went down within 3s of activation/);
  }, 30_000);

  it('fails when the release is down at the end of the window', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        activate(n, record, status);
        if (n >= 2) { status.active = null; status.down = { since: Date.now(), reason: 'restart pending' }; }
      },
    });
    const r = await runStep(host.url, 2);
    expect(r.code).toBe(1);
    expect(r.out).toContain('went down within 2s of activation: restart pending');
  }, 30_000);

  it('tolerates a few failed status polls inside the window', async () => {
    const host = await fakeHost({ onDeployPoll: activate, failStatus: (n) => n === 2 || n === 3 });
    const r = await runStep(host.url, 2);
    expect(r.out).toContain('status poll failed');
    expect(r.code).toBe(0);
  }, 30_000);

  it('fails when the host stays unreachable through the window', async () => {
    const host = await fakeHost({ onDeployPoll: activate, failStatus: () => true });
    const r = await runStep(host.url, 2);
    expect(r.code).toBe(1);
    expect(r.out).toContain('host unreachable at the end of the 2s stability window');
  }, 30_000);

  it('a same-id upload the host ends FAILED "already current" is the no-op outcome, still watched', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        if (n === 1) {
          status.current = RELEASE_ID;
          status.active = { id: RELEASE_ID, mode: 'active', crashes: 1 }; // crashed before; host restarted it
          transition(record, 'FAILED', `release ${RELEASE_ID} is already current`);
        }
      },
    });
    const r = await runStep(host.url, 2);
    expect(r.out).toContain(`Release ${RELEASE_ID} is already current on the host (it was restarting it)`);
    expect(r.out).toContain('stayed up for 2s');
    expect(r.code).toBe(0);
  }, 30_000);

  it('the no-op outcome still fails if the release crashes while watched', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record, status) {
        if (n === 1) {
          status.current = RELEASE_ID;
          status.active = { id: RELEASE_ID, mode: 'active', crashes: 0 };
          transition(record, 'FAILED', `release ${RELEASE_ID} is already current`);
        }
        if (n === 4) status.active = { id: RELEASE_ID, mode: 'active', crashes: 1 };
      },
    });
    const r = await runStep(host.url, 3);
    expect(r.code).toBe(1);
    expect(r.out).toContain('crashed 1 time(s) within 3s of activation');
  }, 30_000);

  it('any other FAILED is still a failure', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record) {
        if (n === 1) transition(record, 'FAILED', 'release other-9 is already current');
      },
    });
    const r = await runStep(host.url, 2);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ended FAILED: release other-9 is already current');
  }, 30_000);

  it('still fails a deploy that ends FAILED, without a stability window', async () => {
    const host = await fakeHost({
      onDeployPoll(n, record) {
        if (n === 2) transition(record, 'FAILED', 'health check timed out');
      },
    });
    const r = await runStep(host.url, 30);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ended FAILED: health check timed out');
    expect(r.elapsedMs).toBeLessThan(10_000);
  }, 30_000);
});
