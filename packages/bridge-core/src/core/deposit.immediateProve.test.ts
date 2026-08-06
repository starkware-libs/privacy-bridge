// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// PART A — immediate-prove threading (deposit.ts, paymaster path).
//
// depositToPool must, when immediateProve:true, prove NOW (undefined anchor → no aging
// wait) at the deeper IMMEDIATE_PROVING_BLOCK_DEPTH so the base clears the sequencer's
// ~10-block get_block_hash floor even though no blocks pass between prove and execute.
// When immediateProve is false/omitted it forwards the caller's dependency anchor at the
// normal PROVING_BLOCK_DEPTH (unchanged behavior). We spy waitForProvingBlock and assert
// the (anchor, depth) it was called with; proving.test.ts proves the resolved-block math
// (latest − depth) against the REAL waitForProvingBlock.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const { waitForProvingBlockMock } = vi.hoisted(() => ({
  waitForProvingBlockMock: vi.fn(async () => 42),
}));

const h = vi.hoisted(() => ({
  cfg: {
    poolAddress: '0xPOOL',
    indexerUrl: 'https://indexer.test',
    proverUrl: 'https://prover.test',
    chainId: 'SN_SEPOLIA',
    depositToken: { address: '0xUSDC', decimals: 6, symbol: 'USDC' },
    paymaster: { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' },
    admin: undefined,
  },
}));

vi.mock('./config', () => ({ config: h.cfg }));

// Partial mock: keep the real IMMEDIATE_PROVING_BLOCK_DEPTH / PROVING_BLOCK_DEPTH /
// isProofExpiredError, override only waitForProvingBlock so we can inspect its args.
vi.mock('./proving', async (orig) => {
  const actual = await orig<typeof import('./proving')>();
  return { ...actual, waitForProvingBlock: waitForProvingBlockMock };
});

vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xdeposit' })),
  paymasterBuildLeg: vi.fn(async () => ({ feeAction: undefined })),
  paymasterExecuteLeg: vi.fn(
    async (
      _a: unknown,
      _c: unknown,
      _p: unknown,
      _ctx: unknown,
      opts?: { onRelayStart?: () => void },
    ) => {
      opts?.onRelayStart?.();
      return { transaction_hash: '0xrelay' };
    },
  ),
  invalidateManagerNonce: vi.fn(),
}));

vi.mock('./errorMessages', () => ({ humanizeFinality: (f: unknown) => String(f) }));
vi.mock('./register', () => ({ isAlreadyRegisteredError: () => false }));

vi.mock('./tx', async (orig) => {
  const actual = await orig<typeof import('./tx')>();
  return {
    ...actual,
    submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<{ transaction_hash: string }>) => {
      await fn();
      return { transaction_hash: '0xt', blockNumber: undefined };
    }),
  };
});

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(() => ({
    build: () => {
      const b: Record<string, unknown> = {};
      b.surplusTo = () => b;
      b.with = (_a: string, fn: (t: unknown) => void) => {
        fn({ deposit: () => {}, withdraw: () => {} });
        return b;
      };
      b.createProofInvocation = async () => ({});
      return b;
    },
    executeWithInvocation: async () => ({
      callAndProof: {
        call: { contractAddress: '0xpool', calldata: [] },
        proof: { data: '', proofFacts: [] },
      },
    }),
    invalidateProofNonceCache: () => {},
  })),
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./provider', () => ({ getRpcProvider: () => ({}), makeAccount: vi.fn() }));

import { depositToPool } from './deposit';
import { IMMEDIATE_PROVING_BLOCK_DEPTH, PROVING_BLOCK_DEPTH } from './proving';

const account = {
  address: '0xacct',
  signMessage: vi.fn(async () => ['0xa', '0xb']),
} as unknown as Account;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('depositToPool — Part A immediate-prove (paymaster path)', () => {
  it('immediateProve:true → proves NOW with an undefined anchor at the IMMEDIATE depth', async () => {
    await depositToPool({
      account,
      viewingKey: 7n,
      amountWei: 1_000_000n,
      // A caller-supplied anchor is IGNORED under immediateProve (nothing to age past).
      lastTxBlockNumber: 55,
      immediateProve: true,
    });

    expect(waitForProvingBlockMock).toHaveBeenCalledOnce();
    const [, anchor, , depth] = waitForProvingBlockMock.mock.calls[0]!;
    expect(anchor).toBeUndefined();
    expect(depth).toBe(IMMEDIATE_PROVING_BLOCK_DEPTH);
  });

  it('immediateProve:false (default) → forwards the caller anchor at the normal depth', async () => {
    await depositToPool({
      account,
      viewingKey: 7n,
      amountWei: 1_000_000n,
      lastTxBlockNumber: 55,
    });

    expect(waitForProvingBlockMock).toHaveBeenCalledOnce();
    const [, anchor, , depth] = waitForProvingBlockMock.mock.calls[0]!;
    expect(anchor).toBe(55);
    expect(depth).toBe(PROVING_BLOCK_DEPTH);
  });
});
