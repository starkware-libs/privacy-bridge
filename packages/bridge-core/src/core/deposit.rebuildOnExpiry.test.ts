// PART C — rebuild-on-EXPIRY (deposit.ts, manager path).
//
// A pool proof-freshness revert (PROOF_EXPIRED / INVALID_BASE_BLOCK_NUMBER) means the
// proof's BASE BLOCK is stale — the SAME-anchor stale-nonce rebuild would just re-expire.
// proveAndSubmitDeposit must instead re-pick a FRESH anchor from the current head (undefined
// last-tx → waitForProvingBlock reads latest now) at the safe IMMEDIATE depth, re-prove, and
// resubmit — bounded. These prove: (1) a fresh re-anchor on expiry, (2) the bound, and
// (3) that it is DISTINCT from the stale-nonce rebuild (which keeps the ORIGINAL anchor).
//
// Manager path (config.paymaster off) so the flow is: approve → prove → manager submit.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const { waitForProvingBlockMock, invalidateProofNonceCacheMock } = vi.hoisted(() => ({
  waitForProvingBlockMock: vi.fn(async () => 0),
  invalidateProofNonceCacheMock: vi.fn(),
}));

vi.mock('./config', () => ({
  config: {
    poolAddress: '0xPOOL',
    indexerUrl: 'https://indexer.test',
    proverUrl: 'https://prover.test',
    chainId: 'SN_SEPOLIA',
    depositToken: { address: '0xUSDC', decimals: 6, symbol: 'USDC' },
    paymaster: undefined, // manager path
    admin: undefined,
  },
}));

// Partial mock: keep the real IMMEDIATE_PROVING_BLOCK_DEPTH / PROVING_BLOCK_DEPTH /
// isProofExpiredError, override only waitForProvingBlock so we can inspect its args.
vi.mock('./proving', async (orig) => {
  const actual = await orig<typeof import('./proving')>();
  return { ...actual, waitForProvingBlock: waitForProvingBlockMock };
});

vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xdeposit' })),
  paymasterBuildLeg: vi.fn(),
  paymasterExecuteLeg: vi.fn(),
  invalidateManagerNonce: vi.fn(),
}));

vi.mock('./errorMessages', () => ({ humanizeFinality: (f: unknown) => String(f) }));
vi.mock('./register', () => ({ isAlreadyRegisteredError: () => false }));

// Real tx.ts EXCEPT submitAndTrack — so TxTerminalStatusError / isTrackedTerminalStatus /
// isRevertedOrRejected are the genuine classifiers the re-anchor gate relies on.
const { submitAndTrackMock } = vi.hoisted(() => ({ submitAndTrackMock: vi.fn() }));
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
    invalidateProofNonceCache: invalidateProofNonceCacheMock,
  })),
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./provider', () => ({ getRpcProvider: () => ({}), makeAccount: vi.fn() }));

import { depositToPool } from './deposit';
import { IMMEDIATE_PROVING_BLOCK_DEPTH, PROVING_BLOCK_DEPTH } from './proving';
import { TxTerminalStatusError } from './tx';

const account = {
  address: '0xacct',
  execute: vi.fn(async () => ({ transaction_hash: '0xapprove' })),
} as unknown as Account;

// The APPROVE submitAndTrack (manager path, call #1) → seeds the anchor at block 42.
const approveResult = { transaction_hash: '0xapprove', blockNumber: 42 };
// A depositToPool deposit submit that LANDS: run the inner submit fn (captures the
// manager hash) then report success.
const depositOk = async (
  _p: unknown,
  fn: () => Promise<{ transaction_hash: string }>,
): Promise<{ transaction_hash: string; blockNumber: number }> => {
  const r = await fn();
  return { transaction_hash: r.transaction_hash, blockNumber: 2 };
};

beforeEach(() => {
  vi.clearAllMocks();
  waitForProvingBlockMock.mockResolvedValue(0);
});

describe('proveAndSubmitDeposit — Part C rebuild-on-expiry (manager path)', () => {
  it('PROOF_EXPIRED → re-anchors to a FRESH head at the IMMEDIATE depth, re-proves, resubmits', async () => {
    submitAndTrackMock
      .mockResolvedValueOnce(approveResult) // #1 approve → anchor 42
      .mockImplementationOnce(async (_p, fn: () => Promise<{ transaction_hash: string }>) => {
        await fn(); // tx submitted…
        throw new TxTerminalStatusError('REVERTED', '0xdeadbase', 'PROOF_EXPIRED'); // …then reverted
      })
      .mockImplementationOnce(depositOk); // #3 re-anchored deposit lands

    await depositToPool({ account, viewingKey: 1n, amountWei: 1_000_000n });

    // Two proving rounds: the original anchor, then a FRESH re-anchor.
    expect(waitForProvingBlockMock).toHaveBeenCalledTimes(2);
    const [, anchor0, , depth0] = waitForProvingBlockMock.mock.calls[0]!;
    const [, anchor1, , depth1] = waitForProvingBlockMock.mock.calls[1]!;
    // Original: the approve-seeded anchor at the normal depth.
    expect(anchor0).toBe(42);
    expect(depth0).toBe(PROVING_BLOCK_DEPTH);
    // Re-anchor: undefined (→ waitForProvingBlock reads the current head) at IMMEDIATE depth.
    expect(anchor1).toBeUndefined();
    expect(depth1).toBe(IMMEDIATE_PROVING_BLOCK_DEPTH);
    // The proof cache is invalidated before the re-prove.
    expect(invalidateProofNonceCacheMock).toHaveBeenCalled();
  });

  it('is BOUNDED: repeated PROOF_EXPIRED gives up after the re-anchor budget (does not loop forever)', async () => {
    submitAndTrackMock.mockImplementation(
      async (_p, fn: () => Promise<{ transaction_hash: string }>, opts?: { until?: string }) => {
        // The approve tracks to ACCEPTED_ON_L2; every DEPOSIT submit reverts PROOF_EXPIRED.
        if (opts?.until === 'ACCEPTED_ON_L2') return approveResult;
        await fn();
        throw new TxTerminalStatusError('REVERTED', '0xdeadbase', 'PROOF_EXPIRED');
      },
    );

    await expect(depositToPool({ account, viewingKey: 1n, amountWei: 1_000_000n })).rejects.toThrow(
      /PROOF_EXPIRED/,
    );

    // Initial deposit attempt + 2 bounded re-anchors = 3 proving rounds, then it throws.
    expect(waitForProvingBlockMock).toHaveBeenCalledTimes(3);
  });

  it('DISTINCT from the stale-nonce rebuild: a non-expiry revert re-proves against the SAME anchor', async () => {
    submitAndTrackMock
      .mockResolvedValueOnce(approveResult) // #1 approve → anchor 42
      .mockImplementationOnce(async (_p, fn: () => Promise<{ transaction_hash: string }>) => {
        await fn();
        // A generic (non-freshness) revert → the SAME-anchor stale-nonce retry, NOT a re-anchor.
        throw new TxTerminalStatusError('REVERTED', '0xstale', 'INVALID_NONCE');
      })
      .mockImplementationOnce(depositOk); // #3 same-anchor retry lands

    await depositToPool({ account, viewingKey: 1n, amountWei: 1_000_000n });

    expect(waitForProvingBlockMock).toHaveBeenCalledTimes(2);
    const [, anchor0, , depth0] = waitForProvingBlockMock.mock.calls[0]!;
    const [, anchor1, , depth1] = waitForProvingBlockMock.mock.calls[1]!;
    // The stale-nonce rebuild keeps the ORIGINAL anchor + depth (a failed submit commits no
    // new block) — it must NOT re-anchor to a fresh head like the expiry path does.
    expect(anchor0).toBe(42);
    expect(anchor1).toBe(42);
    expect(depth0).toBe(PROVING_BLOCK_DEPTH);
    expect(depth1).toBe(PROVING_BLOCK_DEPTH);
  });
});
