// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Core-level fund-safety tests for cashOut() — the composed Leg-B cash-out
// orchestrator (withdraw + CCTP burn toward a user address → attest → Forwarding-
// Service mint) that owns the pmp.inflightCashOut resume cursor. These are the
// assertions PORTED from the app's ReturnContext.test.tsx cash-out suite per the §5
// test-migration gate:
//   1. destination validation      (a malformed address is rejected BEFORE sign/burn)
//   2. no-double-burn on resume     (a valid cursor resumes from attest, NEVER re-burns)
//   3. cross-destination guard      (a cursor to a DIFFERENT address refuses — never
//                                    clobber an in-flight cash-out's cursor)
//   4. clear-on-terminal            (a demonstrably-terminal attest failure clears the
//                                    cursor; any other failure PRESERVES it)
//   5. net-amount (#140)            (the result reports gross − the forwarding fee)
// plus spyOnSecretSinks() proving the raw signature is never logged/persisted.
//
// REAL cashOut + REAL bridgeOutToWallet run; the low-level boundaries reuse
// bridgeOut.test.ts's fakes (SDK builder/factory, provider/account, proving/tx), and
// the attest/mint leg (waitForBridgedMint) + the CCTP fee quote (cctpFees) are mocked
// so no network is touched. The cross-chain legs are live-only (.claude/rules/verification.md).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

const SIGNATURE = `0x${'ab'.repeat(65)}`;
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const DESTINATION = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AMOUNT = 2_500_000n; // 2.5 USDC @ 6dp
const BURN_TX = '0xb017';
const FORWARD_TX = '0xfeedface' as `0x${string}`;
const INFLIGHT_CASHOUT_KEY = 'pmp.inflightCashOut';

const {
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  createPrivateTransfers,
  transfers,
  account,
  execute,
} = vi.hoisted(() => {
  const execute = vi.fn(async () => ({ transaction_hash: '0xburn' }));
  const transfers = {
    build: vi.fn(),
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: {
        call: { contractAddress: '0xANON', calldata: [] },
        proof: { data: [], proofFacts: [] },
      },
    })),
    invalidateProofNonceCache: vi.fn(),
  };
  return {
    deriveStarknetPrivateKey: vi.fn((_signature: string): string => '0xsnpk'),
    deriveStarknetAccount: vi.fn((_privateKey: string, _classHash: string) => ({
      address: '0xacct',
      publicKey: '0xpub',
    })),
    deriveViewingKey: vi.fn((_signature: string): bigint => 123456789n),
    createPrivateTransfers: vi.fn(() => transfers),
    transfers,
    account: { address: '0xacct', execute, getNonce: vi.fn(async () => '0x0') },
    execute,
  };
});

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
}));

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn((_token: string, fn?: (t: typeof builder) => unknown) => {
    if (fn) fn(builder);
    return builder;
  });
  builder.inputs = vi.fn(() => builder);
  builder.withdraw = vi.fn(() => builder);
  builder.surplusTo = vi.fn(() => builder);
  builder.invoke = vi.fn(() => builder);
  builder.done = vi.fn(() => builder);
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers,
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn() }),
  makeAccount: () => account,
}));

vi.mock('./proving', () => ({
  waitForProvingBlock: vi.fn(async () => 'block-1'),
  getCurrentBlock: vi.fn(async () => 1),
  // proveAndSubmitBridgeOut imports these to pick the proving depth (FIX 2).
  PROVING_BLOCK_DEPTH: 8,
  IMMEDIATE_PROVING_BLOCK_DEPTH: 12,
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: vi.fn(
    async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
      const r = await send();
      return { transactionHash: r.transaction_hash, blockNumber: 1 };
    },
  ),
  // Real regex (dedupe sweep moved this into tx.ts): proveAndSubmitBridgeOut's retry
  // guard classifies REVERTED/REJECTED via this predicate.
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

vi.mock('./config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return {
    ...actual,
    config: { ...actual.config, anonymizerAddress: '0xANON', poolAddress: '0x1' },
  };
});

const { avnuBuild, avnuExecute } = vi.hoisted(() => ({ avnuBuild: vi.fn(), avnuExecute: vi.fn() }));
vi.mock('./avnuPaymaster', () => ({
  buildTransaction: avnuBuild,
  executeTransaction: avnuExecute,
  toAvnuCall: (c: { contractAddress: string; entrypoint: string; calldata?: string[] }) => ({
    to: c.contractAddress,
    selector: c.entrypoint,
    calldata: (c.calldata ?? []).map(String),
  }),
}));

const { waitForBridgedMint } = vi.hoisted(() => ({ waitForBridgedMint: vi.fn() }));
vi.mock('./polygonMint', () => ({
  waitForBridgedMint,
  // Real regex (dedupe sweep moved this into polygonMint.ts): cashOut's
  // clear-on-terminal guard classifies a demonstrably-terminal attest failure via
  // this predicate.
  isTerminalAttestFailure: (err: unknown) =>
    /attestation failed|recipient\/domain mismatch/i.test(
      err instanceof Error ? err.message : String(err),
    ),
}));

const { fetchForwardMaxFee, assertAboveForwardFloor } = vi.hoisted(() => ({
  fetchForwardMaxFee: vi.fn(),
  assertAboveForwardFloor: vi.fn(),
}));
vi.mock('./cctpFees', () => ({
  fetchForwardMaxFee,
  assertAboveForwardFloor,
  FAST_FINALITY_THRESHOLD: 1000,
  STANDARD_FINALITY_THRESHOLD: 2000,
}));

import { cashOut, isValidInflightCashOut } from './bridgeOut';
import { submitAndTrack } from './tx';

const mSubmitAndTrack = vi.mocked(submitAndTrack);
const FEE_QUOTE = { maxFee: 14_000n, forwardFee: 10_000n, protocolFee: 4_000n, finalityThreshold: 2000 };

const resolveSignature = vi.fn(async () => SIGNATURE);

function seedCashOutCursor(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem(
    INFLIGHT_CASHOUT_KEY,
    JSON.stringify({
      [EVM_ADDRESS.toLowerCase()]: {
        burnTxHash: BURN_TX,
        destination: DESTINATION,
        amount: AMOUNT.toString(),
        evmChainId: 80002,
        ...overrides,
      },
    }),
  );
}

function cash(overrides: Partial<Parameters<typeof cashOut>[0]> = {}) {
  return cashOut({
    resolveSignature,
    amount: AMOUNT,
    destination: DESTINATION,
    evmAddress: EVM_ADDRESS,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  transfers.build.mockImplementation(() => makeBuilder());
  execute.mockResolvedValue({ transaction_hash: BURN_TX });
  resolveSignature.mockResolvedValue(SIGNATURE);
  fetchForwardMaxFee.mockResolvedValue(FEE_QUOTE);
  assertAboveForwardFloor.mockReturnValue(undefined);
  waitForBridgedMint.mockResolvedValue({
    forwardTxHash: FORWARD_TX,
    message: '0xmsg',
    attestation: '0xatt',
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('cashOut — happy path (fresh burn → attest → forwarded mint)', () => {
  it('quotes + burns, mints to the destination, reports the NET amount, clears the cursor', async () => {
    const result = await cash();

    expect(resolveSignature).toHaveBeenCalledTimes(1);
    expect(fetchForwardMaxFee).toHaveBeenCalledTimes(1);
    expect(fetchForwardMaxFee.mock.calls[0][0]).toBe(AMOUNT);
    expect(assertAboveForwardFloor).toHaveBeenCalledWith(AMOUNT, FEE_QUOTE);
    // Exactly one burn submit (fee=0 → no fee-approve; one proven withdraw+burn).
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
    // Forwarded mint gated on the destination as the A1 expected recipient.
    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][0]).toBe(BURN_TX);
    expect(waitForBridgedMint.mock.calls[0][1].expectedMintRecipient).toBe(DESTINATION);

    // #140: NET = gross − maxFee (2_500_000 − 14_000 = 2_486_000).
    expect(result).toMatchObject({
      burnTxHash: BURN_TX,
      destination: DESTINATION,
      forwardTxHash: FORWARD_TX,
      amountNet: AMOUNT - FEE_QUOTE.maxFee,
    });
    expect(localStorage.getItem(INFLIGHT_CASHOUT_KEY)).toBe('{}');
  });

  it('rejects an invalid destination BEFORE signing or burning', async () => {
    await expect(cash({ destination: '0xdeadbeef' })).rejects.toThrow(/valid polygon address/i);
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    expect(waitForBridgedMint).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount BEFORE signing or burning', async () => {
    await expect(cash({ amount: 0n })).rejects.toThrow(/greater than zero/i);
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('fails BEFORE burning when below the forwarding-fee floor', async () => {
    assertAboveForwardFloor.mockImplementationOnce(() => {
      throw new Error('Amount is below the CCTP forwarding-fee floor.');
    });
    await expect(cash()).rejects.toThrow(/forwarding-fee floor/i);
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });
});

describe('cashOut — FUND-SAFETY (ported from ReturnContext.test.tsx)', () => {
  it('[no-double-burn on resume] a valid cursor for the destination resumes from attest and NEVER re-burns', async () => {
    seedCashOutCursor();

    const result = await cash();

    // Resume: no re-sign, no fee quote, no burn submit.
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(fetchForwardMaxFee).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    // …but attest + forwarded mint still run off the persisted burn tx.
    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][0]).toBe(BURN_TX);
    expect(result.forwardTxHash).toBe(FORWARD_TX);
    // Resume falls back to gross (the fee quote isn't persisted in the cursor).
    expect(result.amountNet).toBe(AMOUNT);
    expect(localStorage.getItem(INFLIGHT_CASHOUT_KEY)).toBe('{}');
  });

  it('[persisted dest chain] a resume gates the mint-watch on the burn\'s PERSISTED chain, not a conflicting arg', async () => {
    // Finding 3: the cursor burned toward Base (evmChainId 84532, CCTP domain 6). A
    // resume passes a CONFLICTING destChainId arg (Polygon Amoy 80002, domain 7). The
    // mint-watch MUST use the burn's PERSISTED domain (6) — the arg's domain (7) would
    // gate on the wrong domain, throw "recipient/domain mismatch", and CLEAR the cursor.
    seedCashOutCursor({ evmChainId: 84532 });

    await cash({ destChainId: 80002 });

    expect(mSubmitAndTrack).not.toHaveBeenCalled(); // resumed — never re-burned
    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][1].destinationDomain).toBe(6); // Base, persisted
    expect(waitForBridgedMint.mock.calls[0][1].destinationDomain).not.toBe(7); // NOT Polygon (arg)
  });

  it('[fresh burn] records the destination chain on the cursor for an authoritative resume', async () => {
    // The fresh path must persist evmChainId (the chain the burn targeted) so a later
    // resume resolves the mint-watch domain from it. Burn to Base; the cursor must
    // carry evmChainId 84532. waitForBridgedMint hangs so the cursor is observable
    // before the success-clear.
    let release!: () => void;
    waitForBridgedMint.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ forwardTxHash: FORWARD_TX, message: '0x', attestation: '0x' }); }),
    );
    const p = cash({ destChainId: 84532 });
    await vi.waitFor(() => {
      const map = JSON.parse(localStorage.getItem(INFLIGHT_CASHOUT_KEY) ?? '{}') as Record<string, { evmChainId?: number }>;
      expect(map[EVM_ADDRESS.toLowerCase()]?.evmChainId).toBe(84532);
    });
    release();
    await p;
  });

  it('[cross-destination guard] a cursor to a DIFFERENT address refuses — no sign, no burn, cursor preserved', async () => {
    seedCashOutCursor(); // cursor to DESTINATION
    await expect(
      cash({ destination: '0x9999999999999999999999999999999999999999' }),
    ).rejects.toThrow(/already in progress/i);
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    expect(waitForBridgedMint).not.toHaveBeenCalled();
    // Cursor preserved — the in-flight cash-out to DESTINATION is still resumable.
    expect(localStorage.getItem(INFLIGHT_CASHOUT_KEY)).not.toBe('{}');
  });

  it('[corrupt-cursor drop] a corrupt cursor is discarded → fresh burn', async () => {
    localStorage.setItem(
      INFLIGHT_CASHOUT_KEY,
      JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: { burnTxHash: 123, destination: 'nope' } }),
    );
    await cash();
    expect(resolveSignature).toHaveBeenCalledTimes(1);
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INFLIGHT_CASHOUT_KEY)).toBe('{}');
  });

  it('[clear-on-terminal] a demonstrably-terminal attest failure CLEARS the cursor', async () => {
    seedCashOutCursor();
    waitForBridgedMint.mockRejectedValue(
      new Error('CCTP attestation failed (Iris status "failed") for burn 0xb017.'),
    );
    await expect(cash()).rejects.toThrow(/attestation failed/i);
    expect(localStorage.getItem(INFLIGHT_CASHOUT_KEY)).toBe('{}');
  });

  it('[clear-on-terminal] a NON-terminal mint error PRESERVES the resume cursor', async () => {
    seedCashOutCursor();
    waitForBridgedMint.mockRejectedValue(new Error('waitForForwardedMint: timed out'));
    await expect(cash()).rejects.toThrow(/timed out/i);
    const map = JSON.parse(localStorage.getItem(INFLIGHT_CASHOUT_KEY)!) as Record<string, unknown>;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeDefined();
  });

  it('[storage guard] refuses to burn when localStorage cannot persist the resume cursor', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      await expect(cash()).rejects.toThrow(/storage is unavailable/i);
    } finally {
      spy.mockRestore();
    }
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });
});

describe('cashOut — cursor validator', () => {
  it('isValidInflightCashOut rejects malformed records and accepts a well-formed one', () => {
    expect(isValidInflightCashOut(null)).toBe(false);
    expect(isValidInflightCashOut({ burnTxHash: 123 })).toBe(false);
    expect(isValidInflightCashOut({ burnTxHash: BURN_TX, destination: 'nope', amount: '1', evmChainId: 1 })).toBe(
      false,
    );
    expect(
      isValidInflightCashOut({ burnTxHash: BURN_TX, destination: DESTINATION, amount: '1', evmChainId: 1 }),
    ).toBe(true);
  });
});

describe('cashOut — secret hygiene (spyOnSecretSinks)', () => {
  it('never logs or persists the raw signature', async () => {
    const sinks = spyOnSecretSinks();
    try {
      await cash();
    } finally {
      sinks.restore();
    }
    sinks.assertNeverLeaked(SIGNATURE);
  });
});
