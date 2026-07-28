// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Auto-retry the deposit WITHOUT autoRegister on a TRACKED-TERMINAL register
// collision (AVNU paymaster path).
//
// Root cause: `build({ autoRegister: true })` bundles register+deposit into ONE atomic
// apply_actions. When the account is ALREADY registered (e.g. a prior AMBIGUOUS AVNU
// relay landed the register on-chain despite reporting a JSON-RPC error), the register
// sub-call hits the pool's write-once slot → NON_ZERO_VALUE and the WHOLE multicall
// reverts atomically (deposit included, NO funds moved). Pre-fix, deposit.ts surfaced a
// manual-retry error, so the user had to rerun by hand.
//
// Fix: when the failure is BOTH the register collision AND a TRACKED-TERMINAL
// REVERTED/REJECTED (a confirmed atomic no-op — value did not move; AVNU lesson case
// (c)), auto-retry ONCE with autoRegister:false (deposit only — the register is already
// on-chain, never re-proved/re-relayed). An AMBIGUOUS outcome (no hash / unknown /
// timed-out status, or the relayer may have broadcast) must STILL fail closed.
//
// This wires the REAL deposit.ts + proven-submit.ts + tx.ts classification
// (isTrackedTerminalStatus / TxTerminalStatusError) together, faking only the chain
// (provider/account), the SDK proof builder, the AVNU client, proving, and — via
// importActual — submitAndTrack's tracking outcome. The live AVNU relay round-trip
// stays human/testnet-gated.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';

const USDC = '0x53b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080';
const FORWARDER = '0x123abc';
const FEE = 1_500n;
const AMOUNT_WEI = 1_000_000n;

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
  // Controllable tracking outcome per proven submit: shift a scripted result each call.
  // 'revert-nzv' → the tx was tracked to a terminal REVERT carrying NON_ZERO_VALUE
  // (typed TxTerminalStatusError); 'ok' → tracked to success.
  trackScript: [] as Array<'revert-nzv' | 'ok'>,
  submitAndTrackMock: vi.fn(),
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
// Keep the REAL tx module (TxTerminalStatusError, isTrackedTerminalStatus,
// sanitizeErrorMessage) — override ONLY submitAndTrack so we can script the tracking
// outcome. This proves the actual instanceof-based classification, end to end.
vi.mock('./tx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tx')>();
  return { ...actual, submitAndTrack: h.submitAndTrackMock };
});
vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(),
  IndexerDiscoveryProvider: vi.fn(),
}));

import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk';
import { fakeTransfers } from './__testkit__/fake-chain';
import { depositToPool } from './deposit';
import { TxTerminalStatusError } from './tx';

let transfers: ReturnType<typeof fakeTransfers>;

function fakeAccount() {
  return { address: '0xACCT', signMessage: vi.fn(async () => ['0xaa', '0xbb']) } as never;
}

const HONEST_TYPED_DATA = {
  domain: 'snip9',
  message: { calls: [{ to: USDC, selector: 'approve', calldata: ['0xPOOL', AMOUNT_WEI.toString(), '0'] }] },
};

// The on-chain revert reason a register-write-once collision produces (decoded felts).
const NZV_REASON = "argent/multicall-failed NON_ZERO_VALUE ENTRYPOINT_FAILED";

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' };
  h.trackScript = [];
  transfers = fakeTransfers();
  vi.mocked(createPrivateTransfers).mockReturnValue(transfers as unknown as PrivateTransfersInterface);
  h.buildTransaction.mockResolvedValue({
    type: 'invoke_and_apply_action',
    typed_data: HONEST_TYPED_DATA,
    fee_action: { type: 'withdraw', recipient: FORWARDER, token: USDC, amount: `0x${FEE.toString(16)}` },
  });
  h.executeTransaction.mockResolvedValue({ tracking_id: 'trk', transaction_hash: '0xHASH' });

  // submitAndTrack: run the submit closure (drives the AVNU relay), then apply the
  // scripted tracking outcome. A tracked-terminal REVERT throws the REAL typed error.
  h.submitAndTrackMock.mockImplementation(
    async (_p: unknown, fn: () => Promise<{ transaction_hash?: string }>) => {
      const res = await fn(); // relay ran (onRelayStart fired) — this is post-submission
      const outcome = h.trackScript.shift() ?? 'ok';
      if (outcome === 'revert-nzv') {
        throw new TxTerminalStatusError('REVERTED', res.transaction_hash ?? '0xdead', NZV_REASON);
      }
      return { transaction_hash: res.transaction_hash, blockNumber: 2 };
    },
  );
});

// Counts build({ autoRegister: <flag> }) invocations — the register only ever folds
// into the proof when autoRegister:true, so this pins "register proved at most once".
function autoRegisterCalls(buildSpy: ReturnType<typeof vi.spyOn>): boolean[] {
  return buildSpy.mock.calls.map((c) => Boolean((c[0] as { autoRegister?: boolean })?.autoRegister));
}

describe('depositToPool — tracked-terminal register collision auto-recovery (paymaster)', () => {
  it('auto-retries with autoRegister:false and completes; register proved/relayed at most once', async () => {
    const buildSpy = vi.spyOn(transfers, 'build');
    const onStatus = vi.fn();
    // First proven submit is TRACKED to a terminal NON_ZERO_VALUE revert; the recovery
    // (deposit-only) submit tracks to success.
    h.trackScript = ['revert-nzv'];

    await expect(
      depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: AMOUNT_WEI, onStatus }),
    ).resolves.toBeUndefined();

    // (1) It rebuilt deposit-only and completed: exactly one build with autoRegister:true
    // (the first, collided attempt) and exactly one with autoRegister:false (the retry).
    const flags = autoRegisterCalls(buildSpy);
    expect(flags.filter((f) => f === true)).toHaveLength(1);
    expect(flags.filter((f) => f === false)).toHaveLength(1);

    // (2) The register was folded into the proof AT MOST ONCE — it is never re-proved
    // or re-relayed on the recovery (autoRegister:false carries no register action).
    expect(flags.filter((f) => f === true)).toHaveLength(1);

    // Two proven submits were tracked (the collided one + the deposit-only retry).
    expect(h.submitAndTrackMock).toHaveBeenCalledTimes(2);
    expect(h.executeTransaction).toHaveBeenCalledTimes(2);
    // The user was told the recovery is deposit-only (no re-register).
    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/deposit only.*no re-register/i));
  });

  it('does NOT auto-retry an AMBIGUOUS NON_ZERO_VALUE (relay threw, no hash) — fails closed', async () => {
    const buildSpy = vi.spyOn(transfers, 'build');
    // AVNU relay throws a JSON-RPC error carrying NON_ZERO_VALUE but NO tx hash — the
    // relayer may have broadcast anyway (ambiguous). It is a plain Error, NOT a tracked
    // terminal status, so isTrackedTerminalStatus() is false → must fail closed.
    const ambiguous = new Error(
      'AVNU paymaster_executeTransaction error (code 156): TRANSACTION_EXECUTION_ERROR ' +
        "(argent/multicall-failed, NON_ZERO_VALUE, ENTRYPOINT_FAILED)",
    );
    h.executeTransaction.mockRejectedValueOnce(ambiguous);

    await expect(
      depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: AMOUNT_WEI }),
    ).rejects.toThrow(/already registered but the deposit was not committed.*without autoRegister/i);

    // No auto-retry: build was invoked exactly once (autoRegister:true), never with false.
    const flags = autoRegisterCalls(buildSpy);
    expect(flags).toEqual([true]);
    // The relay was attempted exactly once — no second (double-submit) relay.
    expect(h.executeTransaction).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error if the deposit-only retry ALSO fails (one retry max)', async () => {
    // First submit collides (terminal NZV); the recovery relay then throws an ambiguous
    // error — it must propagate (no infinite retry).
    h.trackScript = ['revert-nzv'];
    h.executeTransaction
      .mockResolvedValueOnce({ transaction_hash: '0xHASH' }) // first attempt relays
      .mockRejectedValueOnce(new Error('relay exploded on the deposit-only retry')); // recovery relay

    await expect(
      depositToPool({ account: fakeAccount(), viewingKey: 7n, amountWei: AMOUNT_WEI }),
    ).rejects.toThrow(/relay exploded on the deposit-only retry/);
  });
});
