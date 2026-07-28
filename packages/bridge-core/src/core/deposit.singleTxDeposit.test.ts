// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// PART B — single-tx deposit fold shape (deposit.ts, paymaster path).
//
// When depositToPool is given `foldMint`, the AVNU invoke `calls` array it hands to
// paymasterBuildLeg MUST be [receive_message, approve] IN THAT ORDER — receive_message
// at index 0 (invoke calls run before apply_action, so mint → approve → pool pull →
// deposit is atomic), approve at index 1. Without foldMint the array is [approve] (the
// unchanged 2-tx flow). Either way there is exactly ONE tracked submit (the deposit
// tx). We spy paymasterBuildLeg + submitAndTrack to inspect the call shape; the live
// AVNU-server acceptance of the folded multicall is UNPROVEN offline (needs a Sepolia
// round-trip).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const h = vi.hoisted(() => ({
  cfg: {
    poolAddress: '0xPOOL',
    indexerUrl: 'https://indexer.test',
    proverUrl: 'https://prover.test',
    chainId: 'SN_SEPOLIA',
    depositToken: { address: '0xUSDC', decimals: 6, symbol: 'USDC' },
    paymaster: {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    },
    admin: undefined,
    cctp: { snMessageTransmitter: '0xTRANSMITTER' },
  },
}));

vi.mock('./config', () => ({ config: h.cfg }));

const { paymasterBuildLegMock, submitAndTrackMock } = vi.hoisted(() => ({
  paymasterBuildLegMock: vi.fn(async () => ({ feeAction: undefined })),
  submitAndTrackMock: vi.fn(
    async (_p: unknown, fn: () => Promise<{ transaction_hash: string }>) => {
      await fn();
      return { transaction_hash: '0xt', blockNumber: undefined };
    },
  ),
}));

vi.mock('./proving', async (orig) => {
  const actual = await orig<typeof import('./proving')>();
  return { ...actual, waitForProvingBlock: vi.fn(async () => 42) };
});

vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xdeposit' })),
  paymasterBuildLeg: paymasterBuildLegMock,
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
  return { ...actual, submitAndTrack: submitAndTrackMock };
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
import { buildReceiveMessageCall } from './snMint';

const account = {
  address: '0xacct',
  signMessage: vi.fn(async () => ['0xa', '0xb']),
} as unknown as Account;

const MESSAGE = '0xabcdef01' as const;
const ATTESTATION = '0x1234' as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('depositToPool — Part B single-tx fold (paymaster invoke shape)', () => {
  it('foldMint set → userCalls === [receive_message, approve], mint at index 0; ONE submit', async () => {
    await depositToPool({
      account,
      viewingKey: 7n,
      amountWei: 1_000_000n,
      immediateProve: true,
      foldMint: { message: MESSAGE, attestation: ATTESTATION },
    });

    expect(paymasterBuildLegMock).toHaveBeenCalledOnce();
    const leg = paymasterBuildLegMock.mock.calls[0]![1] as {
      type: string;
      userCalls: { contractAddress: string; entrypoint: string; calldata: string[] }[];
    };
    expect(leg.type).toBe('invoke_and_apply_action');
    expect(leg.userCalls).toHaveLength(2);

    // Index 0 MUST be receive_message (the fold's exact call construction).
    const expectedMint = buildReceiveMessageCall(h.cfg as never, MESSAGE, ATTESTATION);
    expect(leg.userCalls[0]).toEqual(expectedMint);
    expect(leg.userCalls[0]!.contractAddress).toBe('0xTRANSMITTER');
    expect(leg.userCalls[0]!.entrypoint).toBe('receive_message');

    // Index 1 MUST be the pool approve.
    expect(leg.userCalls[1]!.contractAddress).toBe('0xUSDC');
    expect(leg.userCalls[1]!.entrypoint).toBe('approve');

    // Exactly ONE tracked submit (the deposit tx) — the mint is not a separate submit.
    expect(submitAndTrackMock).toHaveBeenCalledOnce();
  });

  it('no foldMint (default) → userCalls === [approve] only (unchanged 2-tx flow)', async () => {
    await depositToPool({
      account,
      viewingKey: 7n,
      amountWei: 1_000_000n,
      immediateProve: true,
    });

    expect(paymasterBuildLegMock).toHaveBeenCalledOnce();
    const leg = paymasterBuildLegMock.mock.calls[0]![1] as {
      userCalls: { entrypoint: string }[];
    };
    expect(leg.userCalls).toHaveLength(1);
    expect(leg.userCalls[0]!.entrypoint).toBe('approve');
    expect(submitAndTrackMock).toHaveBeenCalledOnce();
  });
});
