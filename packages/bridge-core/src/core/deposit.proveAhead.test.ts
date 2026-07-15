// PROVE-AHEAD (deposit.ts, paymaster path) — the deposit proof generated CONCURRENTLY
// with the CCTP burn+attestation (moveIntoPool) and reused by depositToPool when AVNU's
// real fee still matches. Exercises the REAL deposit.ts + proven-submit.ts; only the
// chain boundary, the SDK proof builder, the AVNU client, proving and tx-tracking are
// faked (the deposit.paymaster.test harness).
//
// Verifies offline: (1) buildDepositProofAhead quotes the pool fee from a BARE
// apply_action — no receive_message, so nothing about the CCTP message/attestation is
// needed to build the proof (that is what lets it run during the attestation wait);
// (2) depositToPool REUSES a matching prebuilt proof (no re-prove); (3) it REBUILDS on a
// fee mismatch or (4) an autoRegister mismatch — fail-closed, so a stale prebuilt is
// never submitted. The LIVE assumption that AVNU's bare apply_action fee equals its
// invoke_and_apply_action fee is UNPROVEN offline — see the PR's live-verify checklist.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';

// Real-shaped felt addresses (the deposit code normalizes token addresses via BigInt).
const USDC = '0x53b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080';
const FORWARDER = '0x123abc';
const FEE = 1_500n; // pool fee in USDC (6dp), as AVNU's fee_action.amount

const h = vi.hoisted(() => ({
  cfg: {
    poolAddress: '0xPOOL',
    indexerUrl: 'https://indexer.test',
    proverUrl: 'https://prover.test',
    chainId: 'SN_SEPOLIA',
    depositToken: {
      address: '0x53b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080',
      decimals: 6,
      symbol: 'USDC',
    },
    paymaster: { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' },
    admin: undefined,
  },
  buildTransaction: vi.fn(),
  executeTransaction: vi.fn(),
  waitForProvingBlock: vi.fn(async () => 'latest-8'),
}));

vi.mock('./config', () => ({ config: h.cfg }));
vi.mock('./avnuPaymaster', () => ({
  buildTransaction: h.buildTransaction,
  executeTransaction: h.executeTransaction,
  toAvnuCall: (c: { contractAddress: string; entrypoint: string; calldata: string[] }) => ({
    to: c.contractAddress,
    selector: c.entrypoint,
    calldata: (c.calldata ?? []).map((x) => x.toString()),
  }),
}));
vi.mock('./provider', () => ({ getRpcProvider: vi.fn(() => ({})), makeAccount: vi.fn() }));
vi.mock('./proving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proving')>();
  return { ...actual, waitForProvingBlock: h.waitForProvingBlock };
});
vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => {
    await fn();
    return { blockNumber: undefined };
  }),
}));
vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(),
  IndexerDiscoveryProvider: vi.fn(),
}));

import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk';
import { fakeTransfers } from './__testkit__/fake-chain';
import { buildDepositProofAhead, depositToPool, type PrebuiltDepositProof } from './deposit';

let transfers: ReturnType<typeof fakeTransfers>;

function fakeAccount() {
  return { address: '0xACCT', signMessage: vi.fn(async () => ['0xaa', '0xbb']) } as never;
}

const AMOUNT_WEI = 1_000_000n;
// #77 calls-substitution guard compares typed_data.message.calls against the userCalls;
// depositToPool WITHOUT foldMint sends [approve], so an honest paymaster echoes it.
const HONEST_TYPED_DATA = {
  domain: 'snip9',
  message: { calls: [{ to: USDC, selector: 'approve', calldata: ['0xPOOL', AMOUNT_WEI.toString(), '0'] }] },
};

// A hand-built prebuilt proof, as buildDepositProofAhead would return — its `feeAmount`
// is what depositToPool matches against AVNU's real quote at submit time.
function prebuilt(overrides: Partial<PrebuiltDepositProof> = {}): PrebuiltDepositProof {
  return {
    call: { contractAddress: '0xPOOL', entrypoint: 'apply_actions', calldata: [] },
    proofDetails: { proof: '0xAHEADproof', proofFacts: ['0xAHEADfact'] },
    feeAmount: FEE,
    autoRegister: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' };
  transfers = fakeTransfers();
  vi.mocked(createPrivateTransfers).mockReturnValue(transfers as unknown as PrivateTransfersInterface);
  // Default submit-time quote: a non-zero pool fee == FEE (matches the prebuilt).
  h.buildTransaction.mockResolvedValue({
    type: 'invoke_and_apply_action',
    typed_data: HONEST_TYPED_DATA,
    fee_action: { type: 'withdraw', recipient: FORWARDER, token: USDC, amount: `0x${FEE.toString(16)}` },
  });
  h.executeTransaction.mockResolvedValue({ tracking_id: 'trk', transaction_hash: '0xHASH' });
});

describe('buildDepositProofAhead — attestation-independent proof', () => {
  it('quotes the pool fee from a BARE apply_action (no receive_message ⇒ no attestation dependency)', async () => {
    const proof = await buildDepositProofAhead({
      account: fakeAccount(),
      viewingKey: 7n,
      amountWei: AMOUNT_WEI,
      immediateProve: true,
    });

    // The fee was quoted from a bare apply_action — NO `invoke` (no receive_message), so
    // the CCTP message/attestation are irrelevant to building this proof. This is exactly
    // what lets moveIntoPool run it concurrently with the attestation wait.
    expect(h.buildTransaction).toHaveBeenCalledOnce();
    const built = h.buildTransaction.mock.calls[0]![0] as {
      transaction: { type: string; invoke?: unknown };
    };
    expect(built.transaction.type).toBe('apply_action');
    expect(built.transaction.invoke).toBeUndefined();

    // The proof carries the quoted fee (for the submit-time match) + autoRegister, and the
    // deposit + fee withdraw were baked in (deposit WITHOUT explicit recipient so the fee
    // nets against it — same shape as the inline path).
    expect(proof.feeAmount).toBe(FEE);
    expect(proof.autoRegister).toBe(true);
    expect(proof.proofDetails).toEqual({ proof: '0xdepositproof', proofFacts: ['0x0fact'] });
    expect(transfers.deposits).toEqual([{ amount: AMOUNT_WEI, recipient: undefined }]);
    expect(transfers.withdraws).toEqual([{ recipient: FORWARDER, amount: FEE }]);
  });

  it('throws off the paymaster path (nothing to hoist — manager path stays 2-tx)', async () => {
    h.cfg.paymaster = undefined as never;
    await expect(
      buildDepositProofAhead({ account: fakeAccount(), viewingKey: 7n, amountWei: AMOUNT_WEI }),
    ).rejects.toThrow(/only valid on the AVNU paymaster path/i);
  });
});

describe('depositToPool — prove-ahead reuse vs rebuild', () => {
  it('REUSES a matching prebuilt proof — no re-prove (transfers untouched), and submits', async () => {
    await depositToPool({
      account: fakeAccount(),
      viewingKey: 7n,
      amountWei: AMOUNT_WEI,
      immediateProve: true,
      prebuiltProof: prebuilt(),
    });

    // AVNU's real fee (FEE) == the prebuilt's baked fee → the ready proof is submitted
    // as-is: NO fresh build/prove happened, so the fake proof builder recorded nothing.
    expect(transfers.deposits).toEqual([]);
    expect(transfers.withdraws).toEqual([]);
    // A submit still happened (the prebuilt proof was relayed).
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });

  it('REBUILDS when AVNU’s real fee differs from the prebuilt (fail-closed)', async () => {
    // Submit-time quote returns a DIFFERENT (drifted) fee than the prebuilt baked.
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: HONEST_TYPED_DATA,
      fee_action: { type: 'withdraw', recipient: FORWARDER, token: USDC, amount: `0x${(FEE + 1n).toString(16)}` },
    });

    await depositToPool({
      account: fakeAccount(),
      viewingKey: 7n,
      amountWei: AMOUNT_WEI,
      immediateProve: true,
      prebuiltProof: prebuilt(),
    });

    // Fee mismatch → the prebuilt is discarded and a FRESH proof is built with the REAL
    // (drifted) fee — never submitting a proof whose baked fee AVNU would reject (165).
    expect(transfers.deposits).toEqual([{ amount: AMOUNT_WEI, recipient: undefined }]);
    expect(transfers.withdraws).toEqual([{ recipient: FORWARDER, amount: FEE + 1n }]);
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });

  it('REBUILDS when the prebuilt autoRegister does not match this attempt', async () => {
    await depositToPool({
      account: fakeAccount(),
      viewingKey: 7n,
      amountWei: AMOUNT_WEI,
      immediateProve: true,
      // depositToPool defaults autoRegister to true; the prebuilt was built for false.
      prebuiltProof: prebuilt({ autoRegister: false }),
    });

    // autoRegister mismatch (a fresh vs already-registered account bakes a DIFFERENT
    // apply_actions) → discard the prebuilt and prove fresh.
    expect(transfers.deposits).toEqual([{ amount: AMOUNT_WEI, recipient: undefined }]);
  });
});
