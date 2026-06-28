// =============================================================================
// File: src/relay-server/notify.ts
//
// Pluggable, env-gated build notifications. `notify()` fans an event out to every
// configured sink (a generic webhook + Resend email). Each sink is a no-op when its
// env is unset, so the whole thing is INERT until the operator adds a secret. It is
// best-effort by construction: a sink NEVER throws (a notify failure must not break
// a build); failures are logged and swallowed.
//
// To enable push-to-phone, set ONE env var:
//   RELAY_NOTIFY_WEBHOOK  — a URL that accepts a JSON POST. Works zero-SDK with
//                           ntfy.sh, Discord/Slack incoming webhooks, Make, etc.
// To enable email (via Resend, no SDK — plain fetch):
//   RELAY_RESEND_API_KEY  — Resend API key (bearer)
//   RELAY_NOTIFY_EMAIL    — the "to" address
//   RELAY_NOTIFY_FROM     — the "from" address (a Resend-verified sender)
// =============================================================================

export type NotifyKind = 'rate-limit-paused' | 'needs-review' | 'done' | 'auto-resumed';

export interface NotifyEvent {
  kind: NotifyKind;
  projectId: string;
  runId: string;
  /** A short human sentence already composed by the caller (the message body). */
  detail: string;
  /** For a rate-limit pause, the parsed auto-resume time (epoch ms) if known. */
  resumeAt?: number;
}

/** A stable, human title per event kind (subject line / push title). */
function titleFor(kind: NotifyKind): string {
  switch (kind) {
    case 'rate-limit-paused': return 'Build paused — rate limit';
    case 'needs-review':      return 'Build parked — needs review';
    case 'done':              return 'Build finished';
    case 'auto-resumed':      return 'Build auto-resumed';
  }
}

/** The fetch implementation — overridable in tests so we never hit the network. */
let fetchImpl: typeof fetch = (globalThis as any).fetch;
/** Test seam: swap in a mock fetch. Returns the previous impl for restore. */
export function _setNotifyFetch(f: typeof fetch): typeof fetch {
  const prev = fetchImpl;
  fetchImpl = f;
  return prev;
}

// ── Sink 1: generic webhook ──────────────────────────────────────────────────
// POST a flat JSON body that works with the common no-config receivers (ntfy.sh
// reads `title`/`message`; Discord/Slack read `content`/`text`; Make/Zapier take
// the whole object). Including all of them keeps it zero-config across services.
async function sendWebhook(ev: NotifyEvent, title: string): Promise<void> {
  const url = (process.env.RELAY_NOTIFY_WEBHOOK || '').trim();
  if (!url) return;
  const body = {
    title,
    message: ev.detail,
    kind: ev.kind,
    projectId: ev.projectId,
    runId: ev.runId,
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

// ── Sink 2: email via Resend (no SDK — plain fetch) ──────────────────────────
async function sendResendEmail(ev: NotifyEvent, title: string): Promise<void> {
  const apiKey = (process.env.RELAY_RESEND_API_KEY || '').trim();
  const to = (process.env.RELAY_NOTIFY_EMAIL || '').trim();
  const from = (process.env.RELAY_NOTIFY_FROM || '').trim();
  // All three are required; any missing → this sink is unconfigured (no-op).
  if (!apiKey || !to || !from) return;
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: title,
      text: ev.detail,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}

/**
 * Fan an event out to every configured sink. Best-effort: each sink runs
 * independently, a no-op when its env is unset, and a thrown sink is caught +
 * logged so a notification failure can NEVER break a build. Never throws.
 */
export async function notify(ev: NotifyEvent): Promise<void> {
  const title = titleFor(ev.kind);
  const sinks: Array<[name: string, run: Promise<void>]> = [
    ['webhook', sendWebhook(ev, title)],
    ['resend', sendResendEmail(ev, title)],
  ];
  const results = await Promise.allSettled(sinks.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.warn(`[notify] ${sinks[i][0]} sink failed (non-fatal): ${(r.reason as Error)?.message || r.reason}`);
    }
  });
}
