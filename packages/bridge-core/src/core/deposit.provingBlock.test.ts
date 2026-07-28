// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// #105 regression: waitForProvingBlock treats lastTxBlockNumber === undefined as "an
// INDEPENDENT action — skip aging". But the non-paymaster deposit path's approve is a
// genuine DEPENDENCY (the deposit's proof must see the approve committed) — its block
// number can legitimately read as undefined (a pre_confirmed receipt momentarily
// lacking block_number), which is NOT the same as "no dependency". Conflating the two
// risks proving before the approve is indexer-visible.
//
// Fix: approvePoolSpend (deposit.ts) polls getTransactionReceipt (via tx.ts's
// waitForBlockNumber) until a real block number surfaces, instead of handing the
// ambiguous `undefined` upstream to waitForProvingBlock. This test drives the REAL
// deposit.ts + a REAL (mocked-provider) tx.ts, so the poll actually exercises
// waitForBlockNumber; only proving.ts's waitForProvingBlock is spied to assert what
// it was called with.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const { waitForProvingBlockMock } = vi.hoisted(() => ({
  waitForProvingBlockMock: vi.fn(async () => 0),
}));

vi.mock('./proving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proving')>();
  return {
    ...actual,
    waitForProvingBlock: waitForProvingBlockMock,
    getCurrentBlock: vi.fn(async () => 100),
  };
});
vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xdeposit' })),
  paymasterBuildLeg: vi.fn(),
  paymasterExecuteLeg: vi.fn(),
  invalidateManagerNonce: vi.fn(),
}));
vi.mock('./errorMessages', () => ({ humanizeFinality: (f: unknown) => String(f) }));
vi.mock('./register', () => ({ isAlreadyRegisteredError: () => false }));
vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(() => ({
    build: () => {
      const builder: Record<string, unknown> = {};
      builder.surplusTo = vi.fn(() => builder);
      builder.with = vi.fn((_addr: string, fn: (t: unknown) => void) => {
        fn({ deposit: vi.fn(), withdraw: vi.fn() });
        return builder;
      });
      builder.createProofInvocation = vi.fn(async () => ({}));
      return builder;
    },
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: { call: { contractAddress: '0xpool', calldata: [] }, proof: { data: '', proofFacts: [] } },
    })),
    invalidateProofNonceCache: vi.fn(),
  })),
  IndexerDiscoveryProvider: class {},
}));

// Real tx.ts (submitAndTrack + waitForBlockNumber) driven against a mocked RpcProvider
// whose getTransactionReceipt initially omits block_number, then reports one — so
// approvePoolSpend's poll fallback is genuinely exercised end-to-end.
let receiptCalls = 0;
const getTransactionReceipt = vi.fn(async () => {
  receiptCalls += 1;
  // First read (inside submitAndTrack, right after ACCEPTED_ON_L2): no block_number
  // yet. Second read (approvePoolSpend's poll fallback): a real block_number.
  return receiptCalls === 1 ? {} : { block_number: 42 };
});
const getTransactionStatus = vi.fn(async () => ({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ getTransactionReceipt, getTransactionStatus, callContract: vi.fn(async () => ['0x0', '0x0']) }),
  makeAccount: vi.fn(),
}));

import { depositToPool } from './deposit';

const account: Account = {
  address: '0xacct',
  execute: vi.fn(async () => ({ transaction_hash: '0xapprove' })),
} as unknown as Account;

beforeEach(() => {
  vi.clearAllMocks();
  receiptCalls = 0;
  getTransactionReceipt.mockImplementation(async () => {
    receiptCalls += 1;
    return receiptCalls === 1 ? {} : { block_number: 42 };
  });
  getTransactionStatus.mockResolvedValue({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' });
});

describe('#105 — approvePoolSpend never hands an ambiguous undefined to waitForProvingBlock', () => {
  it('polls the receipt for a real block number instead of treating a momentarily-missing block_number as "independent"', async () => {
    await depositToPool({ account, viewingKey: 1n, amountWei: 1_000_000n });

    expect(waitForProvingBlockMock).toHaveBeenCalledOnce();
    const lastTxBlockNumber = waitForProvingBlockMock.mock.calls[0]![1];
    // The critical assertion: NEVER undefined for this genuinely-dependent approve,
    // even though the first receipt read raced block_number.
    expect(lastTxBlockNumber).toBe(42);
  });
});
