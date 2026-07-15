// Regression coverage for two value-path holes the adversarial review PROVED in the
// unified status/resume engine, now FIXED:
//   F-D: priority masked a RESUMABLE return-to-pool behind a DEFERRED from-pool burn.
//   F-A/F-B: the status dropped the return cursor's accountIndex, so a resume re-derived
//            the commitment for the WRONG account (silent no-op / wrong claim).
// These assertions were RED before the fix (they asserted the buggy reality / the missing
// field) and are GREEN after it. Keep as regression guards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./moveIntoPool', () => ({
  moveIntoPool: vi.fn(async () => ({ depositedNetWei: 980_000n, deposited: true })),
}));
// recoverBridgeIn lives in returnIn now (fold-only recovery is cursor-driven). Spread the
// REAL module so the status reader's cursor readers stay real; override ONLY recoverBridgeIn.
vi.mock('./returnIn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./returnIn')>();
  return {
    ...actual,
    recoverBridgeIn: vi.fn(async () => ({ stuck: 500_000n, claimTxHash: '0xfeed' })),
  };
});

import { getBridgeTransferStatus, resumeBridgeTransfer } from './bridgeTransferStatus';
import { recoverBridgeIn } from './returnIn';

const mRecover = vi.mocked(recoverBridgeIn);
const EVM = `0x${'ab'.repeat(20)}`;
const SN = '0x1234abcd';
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;

function put(key: string, addr: string, record: unknown): void {
  localStorage.setItem(key, JSON.stringify({ [addr.toLowerCase()]: record }));
}

const RETURN = {
  phase: 'claim',
  accountIndex: 3, // <-- the in-flight return is for account #3
  burnTx: '0xdead',
  sourceDomain: 0,
  amount: '500000',
  commitment: '123456',
  evmChainId: 1,
};
const BURN = {
  burnTxHash: '0xdead',
  eoaAddress: `0x${'cd'.repeat(20)}`,
  bidIndex: 2,
  amountHuman: '3',
  selection: {},
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => localStorage.clear());

describe('F-D — a WIRED return-to-pool outranks a DEFERRED burn (priority)', () => {
  it('return-to-pool (wired) + cctp-mint-out (deferred) coexist → the WIRED one is surfaced and resumes', async () => {
    put('pmp.inflightReturn', EVM, RETURN); // fully resumable via recoverBridgeIn
    put('pmp.inflightBurn', EVM, BURN); // deferred (NOT_YET_RESUMABLE)

    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    // FIXED: the wired return outranks the deferred burn, so the surfaced status is the
    // one the unified resume can actually complete.
    expect(s?.phase).toBe('return-to-pool');

    // And it DRIVES the resume (recoverBridgeIn) instead of throwing NOT_YET_RESUMABLE.
    const res = await resumeBridgeTransfer({ status: s!, signature: SIGNATURE });
    expect(res.completed).toBe(true);
    expect(mRecover).toHaveBeenCalledTimes(1);
  });
});

describe('F-A/F-B — status carries the return accountIndex and resume uses it', () => {
  it('the status for an in-flight return exposes the cursor accountIndex', () => {
    put('pmp.inflightReturn', EVM, RETURN); // in-flight return is for account #3

    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });
    expect(s?.phase).toBe('return-to-pool');
    // FIXED: the authoritative index rides on the status, so a caller driving resume off
    // the status alone recovers the RIGHT account.
    const exposed = JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(exposed).toContain('"accountIndex":3');
    expect(s?.accountIndex).toBe(3);
  });

  it('resume uses the CURSOR account (#3), ignoring a stale caller-supplied index (0)', async () => {
    put('pmp.inflightReturn', EVM, RETURN); // stuck return is for account #3
    const s = getBridgeTransferStatus({ snAddress: SN, evmAddress: EVM });

    // Even if the app passes the currently-selected account (0), the router uses the
    // cursor's authoritative index (3) so recoverBridgeIn re-derives the RIGHT commitment.
    await resumeBridgeTransfer({ status: s!, signature: SIGNATURE, accountIndex: 0 });
    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(mRecover.mock.calls[0][0]).toMatchObject({ accountIndex: 3 });
  });
});
