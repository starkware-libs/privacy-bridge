// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// C3 BUG PROBE for deposit.ts:264
//
// When build({ autoRegister: true }) bundles register+deposit and the tx reverts
// with NON_ZERO_VALUE (account already registered), the entire tx reverts
// (deposit ALSO failed). But the catch block at line 264 returns void (success),
// silently swallowing the deposit failure. A correct implementation would throw.
//
// Test: mock submitAndTrack to throw an isAlreadyRegisteredError on the deposit
// attempt; assert that depositToPool THROWS rather than silently returning void.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

// Hoist the mocks so factories can close over them.
const { submitAndTrackMock, createPrivateTransfersMock, transfers } = vi.hoisted(() => {
  const transfers = {
    build: vi.fn(),
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: {
        call: { contractAddress: '0xpool', calldata: [] },
        proof: { data: [], proofFacts: [] },
      },
    })),
    invalidateProofNonceCache: vi.fn(),
  };

  const submitAndTrackMock = vi.fn(
    async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
      const r = await send();
      return { transactionHash: r.transaction_hash, blockNumber: 1 };
    },
  );

  const createPrivateTransfersMock = vi.fn(() => transfers);

  return { submitAndTrackMock, createPrivateTransfersMock, transfers };
});

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: createPrivateTransfersMock,
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: submitAndTrackMock,
}));

vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xhash' })),
  managerExecute: vi.fn(async () => ({ transaction_hash: '0xhash' })),
  invalidateManagerNonce: vi.fn(),
}));

vi.mock('./proving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proving')>();
  return {
    ...actual,
    waitForProvingBlock: vi.fn(async () => 'block-1'),
    getCurrentBlock: vi.fn(async () => 1),
  };
});

vi.mock('./errorMessages', () => ({
  humanizeFinality: (f: unknown) => String(f),
}));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn(async () => ['0x100', '0x0']) }),
  makeAccount: vi.fn(),
}));

import { depositToPool, formatDepositAmount } from './deposit.js';

// An error that isAlreadyRegisteredError() classifies as already-registered.
// This mimics the on-chain NON_ZERO_VALUE revert from the pool's write-once
// viewing key check.
const ALREADY_REGISTERED_ERROR = new Error('submitAndTrack: 0xabc REVERTED: NON_ZERO_VALUE');

const account: Account = {
  address: '0xacct',
  execute: vi.fn(async () => ({ transaction_hash: '0xapprove' })),
  getNonce: vi.fn(async () => '0x0'),
} as unknown as Account;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn(() => builder);
  builder.inputs = vi.fn(() => builder);
  builder.surplusTo = vi.fn(() => builder);
  builder.deposit = vi.fn(() => builder);
  builder.done = vi.fn(() => builder);
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  transfers.build.mockImplementation(() => makeBuilder());
});

describe('C3 — depositToPool: autoRegister revert swallows deposit failure', () => {
  it('C3: throws when the autoRegister+deposit tx reverts with NON_ZERO_VALUE (deposit never committed)', async () => {
    // First submitAndTrack call: the approve (succeeds).
    // Second submitAndTrack call: the proven deposit (throws NON_ZERO_VALUE).
    submitAndTrackMock
      .mockResolvedValueOnce({ transactionHash: '0xapprove', blockNumber: 1 }) // approve
      .mockRejectedValueOnce(ALREADY_REGISTERED_ERROR); // deposit attempt 1

    // On current code: depositToPool swallows the error and returns void.
    // Correct behaviour: depositToPool throws (the deposit was not committed).
    await expect(
      depositToPool({ account, viewingKey: 123n, amountWei: 1_000_000n }),
    ).rejects.toThrow(); // RED on current code — returns void instead
  });
});

// #95: depositToPool hardcoded `autoRegister: true` with no way to pass
// `autoRegister: false` on a deposit-only retry (an already-registered account
// re-hitting build({ autoRegister: true }) fails, per C3 above) — despite
// deposit.ts's own error messages telling the caller to "retry without
// autoRegister". Pre-fix: DepositArgs has no `autoRegister` field, so this call
// TypeErrors/ignores the option and `transfers.build` is always invoked with
// `autoRegister: true` regardless of what the caller asks for.
describe('#95 — depositToPool accepts an autoRegister:false escape hatch', () => {
  it('threads autoRegister:false through to transfers.build', async () => {
    submitAndTrackMock
      .mockResolvedValueOnce({ transactionHash: '0xapprove', blockNumber: 1 }) // approve
      .mockResolvedValueOnce({ transactionHash: '0xdeposit', blockNumber: 2 }); // deposit

    await depositToPool({
      account,
      viewingKey: 123n,
      amountWei: 1_000_000n,
      autoRegister: false,
    });

    expect(transfers.build).toHaveBeenCalledWith(
      expect.objectContaining({ autoRegister: false }),
    );
  });

  it('still defaults to autoRegister:true when omitted (unchanged behavior)', async () => {
    submitAndTrackMock
      .mockResolvedValueOnce({ transactionHash: '0xapprove', blockNumber: 1 })
      .mockResolvedValueOnce({ transactionHash: '0xdeposit', blockNumber: 2 });

    await depositToPool({ account, viewingKey: 123n, amountWei: 1_000_000n });

    expect(transfers.build).toHaveBeenCalledWith(
      expect.objectContaining({ autoRegister: true }),
    );
  });
});

// #160: bigint '%'/'/ ' truncate toward zero, so formatting a negative value
// without normalising the sign up front mixes a negative `whole` with a
// negative `fraction` STRING, mangling the output (e.g. '-1.-5' instead of
// '-1.50'). formatDepositAmount now rounds a balance/total to the nearest cent
// (2 dp) for display; it uses the real config's depositToken.decimals (6 on
// testnet, unmocked in this file).
describe('formatDepositAmount', () => {
  it('formats a positive raw amount to the nearest cent (2 dp)', () => {
    expect(formatDepositAmount(1_500_000n)).toBe('1.50');
    expect(formatDepositAmount(1_000_000n)).toBe('1.00');
  });

  it('#160: formats a negative raw amount correctly (not mangled like "-1.-5")', () => {
    expect(formatDepositAmount(-1_500_000n)).toBe('-1.50');
    expect(formatDepositAmount(-1_000_000n)).toBe('-1.00');
  });
});
