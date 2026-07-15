// proveAndSubmitDeposit's manager branch must not re-submit an already-landed deposit
// on a tracking timeout. The submit tx hash is captured inside the submit callback, so
// when submitAndTrack times out waiting for PRE_CONFIRMED after the apply_actions has
// landed (in-flight, NOT a terminal REVERTED/REJECTED), the catch returns instead of
// re-proving and re-invoking submitProvenCall — which would submit a second deposit.
// Mirrors bridgeBack.ts:proveAndSubmitClaim.
//
// Harness mirrors deposit.test.ts. config is NOT mocked (config.paymaster is undefined
// in the test env → the manager branch runs).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const { submitAndTrackMock, submitProvenCallMock, createPrivateTransfersMock, transfers } =
  vi.hoisted(() => {
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
    // Default: run send() and resolve (used for the approve, and for any retry submit).
    const submitAndTrackMock = vi.fn(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );
    const submitProvenCallMock = vi.fn(async () => ({ transaction_hash: '0xdeposit' }));
    const createPrivateTransfersMock = vi.fn(() => transfers);
    return { submitAndTrackMock, submitProvenCallMock, createPrivateTransfersMock, transfers };
  });

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: createPrivateTransfersMock,
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: submitAndTrackMock,
  waitForBlockNumber: vi.fn(async () => 1),
  // Real regex (dedupe sweep moved this into tx.ts): proveAndSubmitDeposit's retry
  // guard classifies REVERTED/REJECTED via this predicate.
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

vi.mock('./proven-submit', () => ({
  submitProvenCall: submitProvenCallMock,
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

import { depositToPool } from './deposit.js';

const account: Account = {
  address: '0xacct',
  execute: vi.fn(async () => ({ transaction_hash: '0xapprove' })),
  getNonce: vi.fn(async () => '0x0'),
} as unknown as Account;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn(() => builder);
  builder.surplusTo = vi.fn(() => builder);
  builder.deposit = vi.fn(() => builder);
  builder.withdraw = vi.fn(() => builder);
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  transfers.build.mockImplementation(() => makeBuilder());
  // Restore the default submitAndTrack behavior (cleared above).
  submitAndTrackMock.mockImplementation(
    async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
      const r = await send();
      return { transactionHash: r.transaction_hash, blockNumber: 1 };
    },
  );
  submitProvenCallMock.mockImplementation(async () => ({ transaction_hash: '0xdeposit' }));
});

describe('proveAndSubmitDeposit — a tracking timeout of a landed submit must not re-submit', () => {
  it('invokes submitProvenCall exactly once when the deposit lands but tracking times out', async () => {
    // Call 1 = the approve (default: run send + resolve).
    // Call 2 = the proven deposit submit: run send() (records the submit → hash
    //          captured) THEN throw a tracking timeout (NOT a REVERTED/REJECTED).
    submitAndTrackMock
      .mockImplementationOnce(async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      })
      .mockImplementationOnce(async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        await send(); // the submit lands (submitProvenCall runs, hash captured)
        throw new Error('submitAndTrack: timed out waiting for PRE_CONFIRMED');
      });

    // The in-flight guard returns without re-submitting, so the deposit resolves and
    // submitProvenCall is not invoked a second time.
    await expect(
      depositToPool({ account, viewingKey: 123n, amountWei: 1_000_000n, autoRegister: false }),
    ).resolves.toBeUndefined();

    expect(submitProvenCallMock).toHaveBeenCalledTimes(1);
  });
});
