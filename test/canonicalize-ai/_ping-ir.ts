// =============================================================================
// Availability gate for the "Ping, real IR" verification suites.
//
// Those suites fingerprint the REAL IR of the Ping Figma file, fetched from the UIX
// service (`POST ${UIX_BASE_URL}/api/v1/figma/ir`). When UIX is down, unreachable,
// or does not hold the Ping upload, every tree comes back empty and there is nothing
// to verify — so the suite is SKIPPED WITH THIS REASON instead of failing red or
// passing vacuously. Point UIX_BASE_URL at a UIX instance that has the Ping .fig
// uploaded to run them.
//
// (Not a *.test.ts file — vitest does not collect it.) The probe runs inside the test
// (ctx.skip) rather than at collection time: tsconfig is CommonJS, so no top-level await.
// =============================================================================

import { getNodeTree, UIX_BASE_URL } from '../../src/relay-server/reference-render';

export const PING_FIG = '5d055820-e6af-46f4-8ce5-14c35e9e44a3.fig';
/** A frame every Ping suite uses (Login). */
const PROBE_FRAME = '283:1967';
const PROBE_TIMEOUT_MS = 15_000;

let probed: Promise<boolean> | null = null;
/** Memoized probe: does UIX return a non-empty IR tree for a Ping frame? */
export function pingIrAvailable(): Promise<boolean> {
  probed ??= (async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), PROBE_TIMEOUT_MS); });
    try {
      const tree = await Promise.race([getNodeTree(PING_FIG, PROBE_FRAME), timeout]);
      return tree.trim().length > 0;
    } finally { clearTimeout(timer); }
  })();
  return probed;
}

export const PING_IR_SKIP_REASON =
  `NEEDS_EXTERNAL: UIX IR service at UIX_BASE_URL=${UIX_BASE_URL} returned no IR tree for the Ping fig ` +
  `${PING_FIG} (frame ${PROBE_FRAME}). Set UIX_BASE_URL to a reachable UIX instance with the Ping upload to run this suite.`;

/** Call first inside a test: skips it (with the reason) when the Ping IR is unavailable. */
export async function requirePingIr(ctx: { skip: (condition: boolean, note?: string) => void }): Promise<void> {
  const ok = await pingIrAvailable();
  if (!ok) console.warn(`[skip] ${PING_IR_SKIP_REASON}`);
  ctx.skip(!ok, PING_IR_SKIP_REASON);
}
