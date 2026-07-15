// Paymaster-path test for the combined register+deposit value path.
//
// Exercises the REAL deposit.ts + proven-submit.ts (paymasterBuildLeg /
// paymasterExecuteLeg) wired together; only the chain boundary (provider/account),
// the SDK proof builder, the AVNU client, proving and tx-tracking are faked. Asserts
// the build→inject→prove→execute ordering: the AVNU pool fee is baked into the proof
// as a withdraw to the forwarder (in the deposit token), and AVNU's relayer submits
// the proven invoke_and_apply_action. Also asserts register defers to the deposit.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';

// Real-shaped felt addresses (the deposit code normalizes token addresses via BigInt).
const USDC = '0x53b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080';
const STRK = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
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
  // Assertable so the deposit-aging test can inspect the lastTxBlockNumber arg.
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
  // submitAndTrack just runs the submit fn (no chain tracking in the unit test).
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
import { depositToPool } from './deposit';
import { registerWithPool } from './register';

let transfers: ReturnType<typeof fakeTransfers>;

function fakeAccount() {
  return { address: '0xACCT', signMessage: vi.fn(async () => ['0xaa', '0xbb']) } as never;
}

// The USDC approve(pool, amountWei) call depositToPool sends as `userCalls` on the
// paymaster path — in the mocked AVNU-wire shape (toAvnuCall passthrough above).
// #77's calls-substitution guard compares typed_data.message.calls against this, so
// every mocked typed_data below must echo it verbatim (an honest paymaster).
const AMOUNT_WEI = 1_000_000n;
const HONEST_TYPED_DATA = {
  domain: 'snip9',
  message: { calls: [{ to: USDC, selector: 'approve', calldata: ['0xPOOL', AMOUNT_WEI.toString(), '0'] }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' };
  transfers = fakeTransfers();
  vi.mocked(createPrivateTransfers).mockReturnValue(transfers as unknown as PrivateTransfersInterface);
  h.buildTransaction.mockResolvedValue({
    type: 'invoke_and_apply_action',
    typed_data: HONEST_TYPED_DATA,
    fee_action: { type: 'withdraw', recipient: FORWARDER, token: USDC, amount: `0x${FEE.toString(16)}` },
  });
  h.executeTransaction.mockResolvedValue({ tracking_id: 'trk', transaction_hash: '0xHASH' });
});

describe('depositToPool — AVNU paymaster path (combined register+deposit)', () => {
  it('bakes the pool fee into the proof as a withdraw to the forwarder, then AVNU submits', async () => {
    await depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: 1_000_000n });

    // buildTransaction ran BEFORE proving (to learn the fee).
    expect(h.buildTransaction).toHaveBeenCalledOnce();
    expect(h.buildTransaction.mock.calls[0]![0].transaction.type).toBe('invoke_and_apply_action');

    // The fee withdraw was injected into the deposit proof, to the forwarder, for FEE.
    expect(transfers.withdraws).toEqual([{ recipient: FORWARDER, amount: FEE }]);
    // CRITICAL: the deposit must NOT carry an explicit recipient on the fee path — else
    // a createNote consumes the whole deposit and the fee withdraw has 0 to net against
    // (SDK "Insufficient balance … available 0"). surplusTo handles the change note.
    expect(transfers.deposits).toEqual([{ amount: 1_000_000n, recipient: undefined }]);

    // AVNU's relayer executed the proven leg (proof forwarded).
    expect(h.executeTransaction).toHaveBeenCalledOnce();
    expect(h.executeTransaction.mock.calls[0]![0].transaction.apply_action.proof).toBe('0xdepositproof');
  });

  // Deposit-aging fix: the paymaster path has NO separate approve tx to seed the
  // proving-block wait, so depositToPool must FORWARD the caller's committed-dependency
  // anchor (the deploy/funding block) as waitForProvingBlock's lastTxBlockNumber.
  // OLD (buggy) behavior: the branch left it undefined → waitForProvingBlock treats the
  // deposit as an INDEPENDENT action and SKIPS aging, proving at latest-8 immediately;
  // when the deploy/funding is still within the last PROVING_BLOCK_DEPTH blocks (the
  // back-to-back make-private flow) the proof is built against committed state where the
  // account isn't deployed/funded yet → the pool apply_actions REVERTS on-chain, and
  // (since the paymaster path is non-retryable) surfaces as the generic "rejected, retry".
  it('ages the deposit proof past the caller-supplied dependency block (paymaster has no approve tx)', async () => {
    const onStatus = vi.fn();
    await depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: 1_000_000n, lastTxBlockNumber: 55, onStatus });

    expect(h.waitForProvingBlock).toHaveBeenCalledOnce();
    // The critical assertion: the anchor is FORWARDED, NOT the pre-fix `undefined`
    // (which let waitForProvingBlock skip the aging wait → on-chain revert).
    // 4th arg is the proving DEPTH (normal PROVING_BLOCK_DEPTH here — not the immediate path).
    expect(h.waitForProvingBlock).toHaveBeenCalledWith(
      expect.anything(),
      55,
      expect.anything(),
      expect.anything(),
    );
    expect(h.waitForProvingBlock.mock.calls[0]![1]).toBe(55);
  });

  it('skips the fee withdraw when fee_action is zero', async () => {
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: HONEST_TYPED_DATA,
      fee_action: { type: 'withdraw', recipient: FORWARDER, token: USDC, amount: '0x0' },
    });
    await depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: 1_000_000n });
    expect(transfers.withdraws).toEqual([]);
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });

  it('throws if the fee token is not the deposit token (e.g. sponsored → STRK)', async () => {
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: { domain: 'snip9' },
      fee_action: { type: 'withdraw', recipient: FORWARDER, token: STRK, amount: '0x3782dace9d900000' },
    });
    await expect(
      depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: 1_000_000n }),
    ).rejects.toThrow(/not the deposit token/i);
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });

  // B1: once AVNU's executeTransaction has been INVOKED, any error from it is
  // potentially ambiguous (the relayer may have already queued the proven invoke).
  // A blind retry rebuilds + re-signs a fresh SNIP-9 typed_data — relaying a SECOND
  // register+deposit. The fix is to refuse the retry on the paymaster path once
  // executeTransaction was called, propagating the original error verbatim.
  it('does NOT retry when AVNU paymaster_executeTransaction throws an ambiguous error (no double-submit)', async () => {
    const ambiguous = new Error('AVNU paymaster_executeTransaction: fetch timeout after relay');
    h.executeTransaction.mockRejectedValueOnce(ambiguous);

    await expect(
      depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: 1_000_000n }),
    ).rejects.toThrow(/fetch timeout after relay/);

    // RED on pre-fix code: buildTransaction is called TWICE (the retry rebuilds the
    // typed_data and asks for a fresh SNIP-9 signature). After the fix it is called
    // exactly once and the ambiguous error propagates verbatim.
    expect(h.buildTransaction).toHaveBeenCalledOnce();
    expect(h.executeTransaction).toHaveBeenCalledOnce();
  });

  // B2 (inverse of B1): a signMessage rejection happens BEFORE the AVNU relay starts,
  // so it relays NOTHING — it must stay retryable. The fix flips paymasterSubmissionStarted
  // only at onRelayStart (after signMessage), so this rejection rebuilds + re-proves once.
  it('DOES retry when signMessage rejects before the relay (no double-submit risk; rebuilds once)', async () => {
    // Spy the proof-nonce cache invalidation (fake-chain's stub is a no-op) so we can
    // assert the retry path ran.
    const invalidateSpy = vi.spyOn(transfers, 'invalidateProofNonceCache');
    // The wallet rejects the SNIP-9 signature on BOTH attempts → final outcome rejects,
    // but only AFTER a rebuild+re-prove (the rejection is pre-relay, hence retryable).
    const account = {
      address: '0xACCT',
      signMessage: vi.fn(async () => {
        throw new Error('user rejected signature');
      }),
    } as never;

    await expect(
      depositToPool({ account, viewingKey: 7n, amountWei: 1_000_000n }),
    ).rejects.toThrow(/user rejected signature/);

    // RED on pre-fix code: the flag was set TRUE before signMessage, so the rejection
    // landed on the non-retryable side — buildTransaction called ONCE, no invalidate.
    // GREEN after the fix: the rejection is retryable → rebuild + re-prove once.
    expect(h.buildTransaction).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledOnce();
    // The relay never started: executeTransaction was never reached on either attempt.
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });
});

describe('registerWithPool — AVNU paymaster path', () => {
  it('defers to the deposit (no proof, no paymaster call) since register has no balance for the fee', async () => {
    const onStatus = vi.fn();
    await registerWithPool({ account: fakeAccount(), viewingKey: 7n, onStatus });
    expect(h.buildTransaction).not.toHaveBeenCalled();
    expect(h.executeTransaction).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/bundled with the deposit/i));
  });
});
