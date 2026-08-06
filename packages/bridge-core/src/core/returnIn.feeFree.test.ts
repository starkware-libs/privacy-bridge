// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// returnToPool / returnBurnToPool must enforce the fee-free-return invariant. The
// proven claim (claimToPool) drains ledger[commitment], which receive_and_bind credits
// with the GROSS burned amount, so a per-call CCTP fee would leave the NET mint
// (amount − fee) short of that target and the claim would revert INSUFFICIENT_CLAIMABLE.
// A fee-bearing config must therefore fail loud at the return entry points rather than
// stranding funds.
//
// Harness style mirrors returnToPool.test.ts: the REAL returnToPool + returnBurnToPool
// run; only the outermost edges are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { waitForAttestation, managerExecute, callContract, claimToPool, buildAndProveClaim, submitProvenClaim } =
  vi.hoisted(() => ({
    waitForAttestation: vi.fn<
      (
        burnTx: string,
        opts: { sourceDomain?: number; onStatus?: (s: string) => void },
      ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
    >(),
    managerExecute: vi.fn(async () => ({ transaction_hash: '0xsnmint' })),
    callContract: vi.fn(async () => ['0', '0'] as string[]),
    claimToPool: vi.fn(async () => ({ claimTxHash: '0xc1a1m', commitmentH: 0n })),
    // FRESH path splits the claim so the proof build overlaps attestation.
    buildAndProveClaim: vi.fn(async () => ({ __proven: true })),
    submitProvenClaim: vi.fn(async () => '0xc1a1m'),
  }));

// A well-formed CCTP-v2 message minting to the InboundAnonymizer, so BOTH of snMint's
// real validation gates pass on the happy path: assertCctpMessageMatches (recipient +
// domain, mintRecipient at body offset 36) AND assertDestinationCallerMatches (the
// bypass-proof gate reading destinationCaller from the header). Both fields carry the
// inbound felt, mirroring returnIn.test.ts's validAttestedMessage.
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 3) + // nonce + sender + (header) recipient — unused by the gates
    opts.recipientField64.toLowerCase() + // destinationCaller = the inbound (bypass-proof)
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + opts.recipientField64.toLowerCase() + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./proven-submit', () => ({ managerExecute }));
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
  makeAccount: vi.fn(() => ({ address: '0xsnacct' })),
}));
vi.mock('./bridgeBack', () => ({ claimToPool, buildAndProveClaim, submitProvenClaim }));
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import { returnToPool, INFLIGHT_RETURN_KEY, type FreshReturnPlan } from './returnIn';

const ACCOUNT_INDEX = 3;
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const FRESH_AMOUNT = 1_787_670n;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const INBOUND_FIELD64 = config.inboundAnonymizerAddress
  .replace(/^0x/i, '')
  .toLowerCase()
  .padStart(64, '0');
const VALID_MESSAGE = buildCctpMessage({
  sourceDomain: config.polygon.domain,
  destinationDomain: config.cctp.starknetDomain,
  recipientField64: INBOUND_FIELD64,
});

let submitGaslessBatch: ReturnType<typeof vi.fn<(calls: unknown[]) => Promise<string>>>;
let prepareFreshReturn: ReturnType<typeof vi.fn<() => Promise<FreshReturnPlan>>>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // receive_and_bind mints + credits atomically (no credit-settle poll), so the guard
  // is the only reason a fee-bearing return would reject (a missing guard would let it
  // clear and succeed). Any incidental contract read resolves to a benign value.
  callContract.mockReset();
  callContract.mockResolvedValue(['0', '0']);
  waitForAttestation.mockImplementation(async () => ({ message: VALID_MESSAGE, attestation: ATTESTATION }));
  submitGaslessBatch = vi.fn(async () => '0xbeefcafe');
  prepareFreshReturn = vi.fn(async () => ({
    amount: FRESH_AMOUNT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch,
  }));
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function run(overrides: Partial<Parameters<typeof returnToPool>[0]> = {}) {
  return returnToPool({
    signature: SIGNATURE,
    accountIndex: ACCOUNT_INDEX,
    evmAddress: EVM_ADDRESS,
    prepareFreshReturn,
    readReturnableBalance: vi.fn(async () => 0n),
    ...overrides,
  });
}

describe('returnToPool — enforces the fee-free-return invariant', () => {
  it('rejects a fresh return with maxFee > 0 before any value moves', async () => {
    await expect(run({ maxFee: 500n })).rejects.toThrow(/fee-?free|maxFee|per-call fee/i);

    // Never burned — the guard fired before any value moved.
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(claimToPool).not.toHaveBeenCalled();
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBeNull();
  });

  it('still accepts the default fee-free config (maxFee 0 / Standard finality)', async () => {
    await expect(run()).resolves.toMatchObject({ amountReturned: FRESH_AMOUNT });
  });
});
