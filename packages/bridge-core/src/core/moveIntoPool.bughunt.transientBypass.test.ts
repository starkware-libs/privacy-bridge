// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// BUGHUNT E2 — moveIntoPool.runStep's TRANSIENT-retry BYPASSES depositToPool's
// paymaster ambiguity fail-closed guard.
//
// Failure mode:
//   • deposit.ts:proveAndSubmitDeposit tracks a `paymasterSubmissionStarted` flag
//     (flipped TRUE in `onRelayStart`, right before AVNU `executeTransaction`).
//   • When set, it re-throws the AVNU relay error VERBATIM (deposit.ts:500-508) —
//     the doctrine's case (a): post-relay throw with hash unknown → fail closed,
//     never re-submit (the relayer may have already broadcast the proven invoke).
//   • But an AVNU relay error CAN be `new Error('fetch failed')` or `HTTP 503` /
//     `ECONNRESET` / `network error` — all matched by errors.ts's TRANSIENT_RE
//     (`fetch failed|network error|ECONNRESET|\b(429|50[234])\b`).
//   • moveIntoPool.runStep (moveIntoPool.ts:214-229) then classifies that verbatim
//     error as TRANSIENT via `isTransientError(err)` → RETRIES depositToPool → a
//     FRESH proveAndSubmitDeposit with FRESH discovery over DIFFERENT notes.
//   • Two proven `apply_actions` land on-chain → DOUBLE DEPOSIT.
//
// This test PROVES the bug via the observable seam: any TRANSIENT_RE-matching
// throw from depositToPool → moveIntoPool retries. That's enough to double-submit
// the ambiguous paymaster case — from moveIntoPool's vantage point the paymaster
// and manager paths are indistinguishable by message text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fixtures / mocks mirror moveIntoPool.test.ts. Derivation is mocked → deterministic.
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;
const MOCK_PRIV = '0xPRIVATEKEYMOCKdeadbeef';
const MOCK_VK = 987654321n;
const ACCOUNT = '0xACCOUNT';
const PUBKEY = '0xPUBKEY';

// Config with paymaster ON so a real paymaster-ambiguous error can occur.
const configMock = vi.hoisted(() => ({
  ozClassHash: '0xoz',
  // paymaster ON + deployFeeMode 'sponsored' so the deploy path doesn't need a
  // funder before deposit (the deposit step drives the failing path).
  deployFeeMode: 'sponsored' as 'sponsored' | 'default',
  paymaster: { feeMode: 'sponsored' } as undefined | { feeMode: string },
  depositToken: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
  cctp: {},
}));

vi.mock('./config', () => ({ config: configMock }));

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey: vi.fn(() => MOCK_PRIV),
  deriveViewingKey: vi.fn(() => MOCK_VK),
  deriveStarknetAccount: vi.fn(() => ({ address: ACCOUNT, publicKey: PUBKEY })),
}));

vi.mock('./provider', () => ({
  makeAccount: vi.fn((address: string) => ({ address })),
  getRpcProvider: vi.fn(() => ({})),
}));

vi.mock('./proving', () => ({
  getCurrentBlock: vi.fn(async () => 100),
}));

vi.mock('./deploy', () => ({
  isDeployedOnL2: vi.fn(),
  ensureAccountDeployed: vi.fn(),
}));

vi.mock('./register', () => ({
  isRegistered: vi.fn(),
  registerWithPool: vi.fn(),
}));

vi.mock('./deposit', () => ({
  depositToPool: vi.fn(),
  buildDepositProofAhead: vi.fn(async () => undefined),
  ensureDepositTokenFunded: vi.fn(),
  readDepositTokenBalance: vi.fn(),
}));

vi.mock('./depositIn', () => ({
  fundFromMetaMask: vi.fn(),
}));

vi.mock('./poolDepositCursor', () => ({
  readPendingPoolDeposit: vi.fn(() => null),
  recordPendingPoolDeposit: vi.fn(),
  clearPendingPoolDeposit: vi.fn(),
}));

import { moveIntoPool } from './moveIntoPool';
import { isDeployedOnL2 } from './deploy';
import { isRegistered } from './register';
import { depositToPool, ensureDepositTokenFunded, readDepositTokenBalance } from './deposit';

const mIsDeployed = vi.mocked(isDeployedOnL2);
const mIsRegistered = vi.mocked(isRegistered);
const mDeposit = vi.mocked(depositToPool);
const mEnsureFunded = vi.mocked(ensureDepositTokenFunded);
const mReadBalance = vi.mocked(readDepositTokenBalance);

const AMOUNT = 1_000_000n;

beforeEach(() => {
  vi.clearAllMocks();
  configMock.deployFeeMode = 'sponsored';
  configMock.paymaster = { feeMode: 'sponsored' };
  // Baseline: account already deployed + registered, so the failing step is the deposit.
  mIsDeployed.mockResolvedValue(true);
  mIsRegistered.mockResolvedValue(true);
  mEnsureFunded.mockResolvedValue(undefined);
  // A fresh account holds nothing on-chain; the chainResidual guard (#433) reads this on
  // the standalone-mint/treasury path (it was a no-op default before — never consulted).
  mReadBalance.mockResolvedValue(0n);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E2: moveIntoPool.runStep TRANSIENT-retries an AMBIGUOUS paymaster throw → double-deposit window', () => {
  it('depositToPool that throws a TRANSIENT_RE-matching error (e.g. "fetch failed") must NOT be retried — but current code retries', async () => {
    // A verbatim AVNU relay throw AFTER paymasterSubmissionStarted. The relayer
    // may already have broadcast the proven invoke → the proven leg may have
    // landed. The fail-closed rule (deposit.ts:500-508 + code-style.md AVNU
    // lesson) is: no re-submit on a post-relay ambiguous throw.
    //
    // Simulate: depositToPool throws `fetch failed` on the first call, then
    // succeeds if invoked again (proving the retry gate opened).
    mDeposit
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(undefined);

    // The desired outcome under a paymaster is FAIL-CLOSED: moveIntoPool must
    // reject and MUST NOT re-invoke depositToPool (a fresh proveAndSubmitDeposit
    // would re-prove over disjoint notes and double-deposit if the first relay
    // actually landed).
    const promise = moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
    });

    // Under a paymaster this SHOULD reject (the ambiguity is unresolvable from
    // outside deposit.ts's own on-relay boundary). Current code retries and
    // succeeds → this expectation is RED under current main.
    await expect(promise).rejects.toThrow(/fetch failed/);
    // The definitive fail-closed assertion: at most ONE depositToPool call.
    // Current code calls it twice (transient retry) → RED.
    expect(mDeposit).toHaveBeenCalledTimes(1);
  });

  it('classifies "HTTP 503" / "ECONNRESET" / "network error" the same way — all match TRANSIENT_RE and slip through', async () => {
    // Any of these error-string shapes can leak out of a POST-relay AVNU throw
    // (a 503 mid-broadcast, an ECONNRESET after the tx was queued, a generic
    // network error). All match TRANSIENT_RE → moveIntoPool retries → same
    // double-deposit window as `fetch failed`.
    const AMBIGUOUS_SHAPES = ['HTTP 503 Bad Gateway', 'ECONNRESET', 'network error'];
    for (const shape of AMBIGUOUS_SHAPES) {
      mDeposit.mockReset();
      mDeposit.mockRejectedValueOnce(new Error(shape)).mockResolvedValue(undefined);
      await expect(
        moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT }),
      ).rejects.toThrow(shape);
      expect(mDeposit).toHaveBeenCalledTimes(1);
    }
  });
});
