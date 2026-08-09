// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Fund-safety tests for the Starknet-native exits — withdrawToStarknet (pool → a
// Starknet address) and sendPrivateToStarknet (pool → another pool identity). Both
// build ONE proven apply_actions, so the assertions here are about what gets built and
// what is refused BEFORE anything irreversible happens:
//   1. recipient validation      (malformed / 0x0 / protocol addresses never reach a proof)
//   2. action shape              (withdraw vs transfer, and no InvokeExternal on either)
//   3. private-send gates        (unregistered recipient, unreadable registration, self)
//   4. public-withdraw to self   (ALLOWED — the caller warns, core does not block)
//   5. no wallet prompt on a doomed payout (resolveSignature is never called)
// plus spyOnSecretSinks() proving the raw signature is never logged or persisted.
//
// The REAL orchestrators and the REAL shared prover run; only the boundaries (pool SDK
// builder, provider/account, proving, tx, pool fee, registration read) are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

const SIGNATURE = `0x${'cd'.repeat(65)}`;
const SN_ACCOUNT = '0x0000000000000000000000000000000000000000000000000000000000000acc';
const RECIPIENT = `0x04c1a9${'0'.repeat(52)}7b32`;
const AMOUNT = 2_500_000n; // 2.5 USDC @ 6dp
const TX_HASH = '0xdeadbeef';

const {
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  createPrivateTransfers,
  transfers,
  account,
  execute,
} = vi.hoisted(() => {
  // Literals, not the consts above: this factory is hoisted above their declarations,
  // so referencing them hits the temporal dead zone. Keep them in sync.
  const execute = vi.fn(async () => ({ transaction_hash: '0xdeadbeef' }));
  const snAccount = '0x0000000000000000000000000000000000000000000000000000000000000acc';
  const transfers = {
    build: vi.fn(),
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: {
        call: { contractAddress: '0x1', calldata: [] },
        proof: { data: [], proofFacts: [] },
      },
    })),
    invalidateProofNonceCache: vi.fn(),
  };
  return {
    deriveStarknetPrivateKey: vi.fn((_signature: string): string => '0xsnpk'),
    deriveStarknetAccount: vi.fn((_privateKey: string, _classHash: string) => ({
      address: snAccount,
      publicKey: '0xpub',
    })),
    deriveViewingKey: vi.fn((_signature: string): bigint => 123456789n),
    createPrivateTransfers: vi.fn(() => transfers),
    transfers,
    account: { address: snAccount, execute, getNonce: vi.fn(async () => '0x0') },
    execute,
  };
});

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
}));

// Records the token operations the orchestrator asks for, so a test can assert the
// action shape (withdraw vs transfer) without reaching the chain.
interface RecordedOps {
  withdraws: { recipient?: string; amount?: bigint }[];
  transfers: { recipient?: string; amount?: bigint }[];
  invoked: boolean;
}
let ops: RecordedOps;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn((_token: string, fn?: (t: typeof builder) => unknown) => {
    if (fn) fn(builder);
    return builder;
  });
  builder.inputs = vi.fn(() => builder);
  builder.withdraw = vi.fn((...outputs: { recipient?: string; amount?: bigint }[]) => {
    ops.withdraws.push(...outputs);
    return builder;
  });
  builder.transfer = vi.fn((...outputs: { recipient?: string; amount?: bigint }[]) => {
    ops.transfers.push(...outputs);
    return builder;
  });
  builder.surplusTo = vi.fn(() => builder);
  builder.invoke = vi.fn(() => {
    ops.invoked = true;
    return builder;
  });
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
  getCurrentBlock: vi.fn(async () => 7),
  PROVING_BLOCK_DEPTH: 8,
  IMMEDIATE_PROVING_BLOCK_DEPTH: 12,
  isNodeLagError: () => false,
  sleep: () => Promise.resolve(),
}));

// Not quiescent ⇒ the aging path, which keeps the prove-early probe out of these
// tests (it has its own suite in bridgeOut.test.ts).
vi.mock('./discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./discover')>()),
  discoverNoteIdsAtBlock: vi.fn(async (args: { blockIdentifier: unknown }) =>
    typeof args.blockIdentifier === 'number' ? ['1'] : ['1', '2'],
  ),
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
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

// Manager path with nothing to approve: keeps the fee leg out of these assertions.
vi.mock('./poolFee', () => ({
  fetchPoolFeeAmount: vi.fn(async () => 0n),
  approvePoolFee: vi.fn(async () => 1),
}));

const { readPoolRegistration } = vi.hoisted(() => ({
  readPoolRegistration: vi.fn(async (_address: string) => 'registered' as const),
}));
vi.mock('./register', () => ({ readPoolRegistration }));

vi.mock('./config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return {
    ...actual,
    config: {
      ...actual.config,
      poolAddress: '0x1',
      anonymizerAddress: '0x4',
      inboundAnonymizerAddress: '0x5',
    },
  };
});

import {
  normalizeStarknetRecipient,
  sendPrivateToStarknet,
  withdrawToStarknet,
} from './withdrawToStarknet';
import { submitAndTrack } from './tx';

const mSubmitAndTrack = vi.mocked(submitAndTrack);
const resolveSignature = vi.fn(async () => SIGNATURE);

beforeEach(() => {
  vi.clearAllMocks();
  ops = { withdraws: [], transfers: [], invoked: false };
  transfers.build.mockImplementation(() => makeBuilder());
  execute.mockResolvedValue({ transaction_hash: TX_HASH });
  readPoolRegistration.mockResolvedValue('registered');
  resolveSignature.mockResolvedValue(SIGNATURE);
});

afterEach(() => {
  localStorage.clear();
});

describe('normalizeStarknetRecipient', () => {
  it('pads a valid address to a full felt', () => {
    expect(normalizeStarknetRecipient('0xacc')).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000acc',
    );
  });

  it.each([
    ['an empty string', '   '],
    ['a non-hex string', 'not-an-address'],
    ['an EVM address pasted into the Starknet field', '0xzz997970C51812dc3A010C7d01b50e0d17dc79C8'],
    ['an over-long felt', `0x${'f'.repeat(65)}`],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeStarknetRecipient(value)).toThrow(/Starknet address/);
  });

  it('rejects the zero address', () => {
    expect(() => normalizeStarknetRecipient('0x0')).toThrow(/cannot receive funds/);
  });

  it.each([
    ['the pool', '0x1'],
    ['the outbound anonymizer', '0x4'],
    ['the inbound anonymizer', '0x5'],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeStarknetRecipient(value)).toThrow(/belongs to the protocol/);
  });
});

describe('withdrawToStarknet', () => {
  it('builds a plain pool withdraw to the recipient, with no InvokeExternal', async () => {
    const result = await withdrawToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });

    expect(ops.withdraws).toEqual([
      { recipient: normalizeStarknetRecipient(RECIPIENT), amount: AMOUNT },
    ]);
    expect(ops.transfers).toEqual([]);
    // A CCTP burn needs the Anonymizer call; a Starknet-native withdraw must not carry one.
    expect(ops.invoked).toBe(false);
    expect(result).toEqual({
      txHash: TX_HASH,
      recipient: normalizeStarknetRecipient(RECIPIENT),
      amount: AMOUNT,
    });
  });

  it('allows withdrawing to the caller’s own account (the caller warns, core does not block)', async () => {
    const result = await withdrawToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: SN_ACCOUNT,
    });
    expect(result.txHash).toBe(TX_HASH);
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
  });

  it('never checks pool registration — any Starknet address can receive a public withdrawal', async () => {
    await withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT });
    expect(readPoolRegistration).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed recipient', { recipient: 'nope', amount: AMOUNT }],
    ['a zero amount', { recipient: RECIPIENT, amount: 0n }],
    ['a negative amount', { recipient: RECIPIENT, amount: -1n }],
  ])('refuses %s without prompting the wallet', async (_label, overrides) => {
    await expect(withdrawToStarknet({ resolveSignature, ...overrides })).rejects.toThrow();
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('never logs or persists the signature', async () => {
    const sinks = spyOnSecretSinks();
    await withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT });
    sinks.assertNeverLeaked(SIGNATURE, '0xsnpk');
    sinks.restore();
  });
});

describe('sendPrivateToStarknet', () => {
  it('builds an in-pool transfer to the recipient, with no withdraw and no InvokeExternal', async () => {
    const result = await sendPrivateToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });

    expect(ops.transfers).toEqual([
      { recipient: normalizeStarknetRecipient(RECIPIENT), amount: AMOUNT },
    ]);
    // A withdraw would take the value OUT of the pool — the whole point of this path is
    // that it does not.
    expect(ops.withdraws).toEqual([]);
    expect(ops.invoked).toBe(false);
    expect(result.txHash).toBe(TX_HASH);
  });

  it('refuses an unregistered recipient before prompting the wallet', async () => {
    readPoolRegistration.mockResolvedValue('unregistered');

    await expect(
      sendPrivateToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT }),
    ).rejects.toThrow(/not on the privacy pool yet/);
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('distinguishes an unreadable registration from an unregistered recipient', async () => {
    readPoolRegistration.mockResolvedValue('unknown');

    await expect(
      sendPrivateToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT }),
    ).rejects.toThrow(/Couldn't check/);
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('refuses a transfer to the caller’s own account', async () => {
    await expect(
      sendPrivateToStarknet({ resolveSignature, amount: AMOUNT, recipient: SN_ACCOUNT }),
    ).rejects.toThrow(/your own account/);
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('never logs or persists the signature', async () => {
    const sinks = spyOnSecretSinks();
    await sendPrivateToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT });
    sinks.assertNeverLeaked(SIGNATURE, '0xsnpk');
    sinks.restore();
  });
});
