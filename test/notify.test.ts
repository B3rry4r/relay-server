// =============================================================================
// FEATURE 2 — env-gated, pluggable notifications.
//
// notify() must be INERT (no fetch) when no sink env is set, and build the correct
// request for each sink when its env IS set. fetch is mocked — the test NEVER hits
// the network. A sink failure must never throw out of notify().
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { notify, _setNotifyFetch, type NotifyEvent } from '../src/relay-server/notify';

const EV: NotifyEvent = {
  kind: 'rate-limit-paused', projectId: 'Ping-Mobile', runId: 'run_42',
  detail: 'Build paused — rate limit, auto-resume ~18:00 UTC', resumeAt: 1,
};

// Snapshot + clear the sink env vars around every test so cases don't bleed.
const ENV_KEYS = ['RELAY_NOTIFY_WEBHOOK', 'RELAY_RESEND_API_KEY', 'RELAY_NOTIFY_EMAIL', 'RELAY_NOTIFY_FROM'];
let saved: Record<string, string | undefined> = {};
let restoreFetch: typeof fetch;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (restoreFetch) _setNotifyFetch(restoreFetch);
});

function mockFetch(impl?: (url: string, init: any) => any) {
  const fn = vi.fn(async (url: string, init: any) => (impl ? impl(url, init) : { ok: true, status: 200 }));
  restoreFetch = _setNotifyFetch(fn as unknown as typeof fetch);
  return fn;
}

describe('FEATURE 2 — notify()', () => {
  it('no env set → NO-OP (no fetch call), never throws', async () => {
    const fetchMock = mockFetch();
    await expect(notify(EV)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('webhook sink: POSTs the flat JSON body to RELAY_NOTIFY_WEBHOOK', async () => {
    process.env.RELAY_NOTIFY_WEBHOOK = 'https://ntfy.sh/relay-builds';
    const fetchMock = mockFetch();
    await notify(EV);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/relay-builds');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      title: 'Build paused — rate limit',
      message: EV.detail,
      kind: 'rate-limit-paused',
      projectId: 'Ping-Mobile',
      runId: 'run_42',
    });
  });

  it('resend sink: POSTs to the Resend API with bearer auth + to/from/subject/text', async () => {
    process.env.RELAY_RESEND_API_KEY = 'rk_test_123';
    process.env.RELAY_NOTIFY_EMAIL = 'me@example.com';
    process.env.RELAY_NOTIFY_FROM = 'relay@build.example.com';
    const fetchMock = mockFetch();
    await notify({ ...EV, kind: 'done', detail: 'Build finished: 14/14 screens built' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer rk_test_123');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      from: 'relay@build.example.com',
      to: ['me@example.com'],
      subject: 'Build finished',
      text: 'Build finished: 14/14 screens built',
    });
  });

  it('resend is a no-op when only SOME of its 3 env vars are set', async () => {
    process.env.RELAY_RESEND_API_KEY = 'rk_test_123';   // missing EMAIL + FROM
    const fetchMock = mockFetch();
    await notify(EV);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('both sinks configured → both fire', async () => {
    process.env.RELAY_NOTIFY_WEBHOOK = 'https://hooks.example/x';
    process.env.RELAY_RESEND_API_KEY = 'rk';
    process.env.RELAY_NOTIFY_EMAIL = 'a@b.c';
    process.env.RELAY_NOTIFY_FROM = 'd@e.f';
    const fetchMock = mockFetch();
    await notify(EV);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(c => c[0]).sort();
    expect(urls).toEqual(['https://api.resend.com/emails', 'https://hooks.example/x']);
  });

  it('a sink that throws / returns !ok never throws out of notify()', async () => {
    process.env.RELAY_NOTIFY_WEBHOOK = 'https://hooks.example/x';
    mockFetch(() => { throw new Error('network down'); });
    await expect(notify(EV)).resolves.toBeUndefined();

    process.env.RELAY_NOTIFY_WEBHOOK = 'https://hooks.example/y';
    mockFetch(() => ({ ok: false, status: 500 }));
    await expect(notify(EV)).resolves.toBeUndefined();
  });
});
