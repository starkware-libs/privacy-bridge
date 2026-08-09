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
  // How many token blocks (`.with(token, …)`) the action opened. The baked paymaster fee
  // must join the action's OWN block, not a second one.
  withBlocks: number;
}
let ops: RecordedOps;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn((_token: string, fn?: (t: typeof builder) => unknown) => {
    ops.withBlocks += 1;
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

const { getClassHashAt } = vi.hoisted(() => ({
  getClassHashAt: vi.fn(
    async (_address: string) => '0x2794ce20e5f2ff0d40e632cb53845b9f4e526ebd8471983f7dbd355b721d5a',
  ),
}));
vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn(), getClassHashAt }),
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
const { discoverPrivateBalance } = vi.hoisted(() => ({
  discoverPrivateBalance: vi.fn(async () => 10_000_000n), // 10 USDC
}));
vi.mock('./discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./discover')>()),
  discoverNoteIdsAtBlock: vi.fn(async (args: { blockIdentifier: unknown }) =>
    typeof args.blockIdentifier === 'number' ? ['1'] : ['1', '2'],
  ),
  discoverPrivateBalance,
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
const { fetchPoolFeeAmount, approvePoolFee } = vi.hoisted(() => ({
  fetchPoolFeeAmount: vi.fn(async () => 0n),
  approvePoolFee: vi.fn(async () => 1),
}));
vi.mock('./poolFee', () => ({ fetchPoolFeeAmount, approvePoolFee }));

const { readPoolRegistration } = vi.hoisted(() => ({
  readPoolRegistration: vi.fn(async (_address: string) => 'registered' as const),
}));
vi.mock('./register', () => ({ readPoolRegistration }));

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
import { config } from './config';

const mSubmitAndTrack = vi.mocked(submitAndTrack);
const resolveSignature = vi.fn(async () => SIGNATURE);

beforeEach(() => {
  vi.clearAllMocks();
  ops = { withdraws: [], transfers: [], invoked: false, withBlocks: 0 };
  transfers.build.mockImplementation(() => makeBuilder());
  execute.mockResolvedValue({ transaction_hash: TX_HASH });
  readPoolRegistration.mockResolvedValue('registered');
  resolveSignature.mockResolvedValue(SIGNATURE);
  getClassHashAt.mockResolvedValue(
    '0x2794ce20e5f2ff0d40e632cb53845b9f4e526ebd8471983f7dbd355b721d5a',
  );
  discoverPrivateBalance.mockResolvedValue(10_000_000n);
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
    [
      'a decimal felt, which is not hex',
      '3141592653589793238462643383279502884197169399375105820974944',
    ],
    ['a bare numeral with no 0x', '123'],
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
      confirmed: true,
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

  // A 20-byte EVM address is a perfectly well-formed felt, so no amount of format
  // checking catches it — only asking the chain whether an account lives there does.
  // This is the likeliest way to lose a withdrawal on this path.
  it('refuses an EVM address pasted into the Starknet field', async () => {
    getClassHashAt.mockRejectedValue(new Error('Contract not found'));

    await expect(
      withdrawToStarknet({
        resolveSignature,
        amount: AMOUNT,
        recipient: '0x5A997970C51812dc3A010C7d01b50e0d17dc79C8',
      }),
    ).rejects.toThrow(/No account is deployed/);
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('refuses rather than guesses when the deployment read fails', async () => {
    getClassHashAt.mockRejectedValue(new Error('fetch failed'));

    await expect(
      withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT }),
    ).rejects.toThrow(/Couldn't check that Starknet address/);
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  // The manager pays real gas for the fee approve, so an unaffordable amount must be
  // refused before it, not discovered at proof-build several seconds later.
  it('refuses an amount above the private balance before approving the pool fee', async () => {
    discoverPrivateBalance.mockResolvedValue(1_000_000n); // 1 USDC

    await expect(
      withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT }),
    ).rejects.toThrow(/not enough for this withdrawal/);
    expect(approvePoolFee).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('reports each phase to a step tracker, and submit only once tracked', async () => {
    const onStep = vi.fn();
    await withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT, onStep });

    expect(onStep.mock.calls).toEqual([
      ['prove', 'running'],
      ['prove', 'done'],
      ['submit', 'running'],
      ['submit', 'done'],
    ]);
  });

  it('does not report submit as done when tracking timed out', async () => {
    const onStep = vi.fn();
    mSubmitAndTrack.mockImplementationOnce(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        await send();
        throw new Error('timed out waiting for ACCEPTED_ON_L2');
      },
    );

    await withdrawToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT, onStep });
    expect(onStep).not.toHaveBeenCalledWith('submit', 'done');
  });

  it('reports a tracked submit as confirmed', async () => {
    const result = await withdrawToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });
    expect(result.confirmed).toBe(true);
  });

  // submitAndTrack throws AFTER send() succeeded (a tracking timeout): the hash is real
  // and the action is in flight, so the payout must be returned — but not as witnessed.
  it('returns an in-flight payout unconfirmed rather than throwing over it', async () => {
    mSubmitAndTrack.mockImplementationOnce(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        await send();
        throw new Error('timed out waiting for ACCEPTED_ON_L2');
      },
    );

    const result = await withdrawToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });
    expect(result.txHash).toBe(TX_HASH);
    expect(result.confirmed).toBe(false);
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

// The only place in the codebase where a pool `transfer` and a fee `withdraw` share one
// token block: bridgeOut's paymaster suite only ever exercises withdraw + withdraw, so
// the note-selection deficit for this combination is otherwise unpinned.
describe('sendPrivateToStarknet — AVNU paymaster path (fee baked into the proof)', () => {
  const FORWARDER = '0xFEEFWD';
  const FEE = 148056n; // ~0.148 USDC pool fee, in the deposit token
  const realPaymaster = config.paymaster;

  beforeEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    };
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: {
        type: 'withdraw',
        recipient: FORWARDER,
        token: config.depositToken.address,
        amount: `0x${FEE.toString(16)}`,
      },
    });
    avnuExecute.mockResolvedValue({ tracking_id: 'trk', transaction_hash: TX_HASH });
  });
  afterEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = realPaymaster;
  });

  it('bakes the fee in as a withdraw beside the transfer, in ONE token block, via AVNU', async () => {
    const result = await sendPrivateToStarknet({
      resolveSignature,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });

    expect(avnuBuild).toHaveBeenCalledOnce();
    expect(ops.transfers).toEqual([
      { recipient: normalizeStarknetRecipient(RECIPIENT), amount: AMOUNT },
    ]);
    expect(ops.withdraws).toEqual([{ recipient: FORWARDER, amount: FEE }]);
    // Both draw from the same notes and share the surplus — a second block would split
    // the deficit and mis-select.
    expect(ops.withBlocks).toBe(1);
    // AVNU's relayer submitted the proven leg; the manager was not used.
    expect(avnuExecute).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(result.txHash).toBe(TX_HASH);
  });

  // The baked fee is a withdraw from the SAME notes, so a send of the whole balance
  // clears an amount-only pre-flight and then fails at proof-build. The affordability
  // check re-runs once the real fee is known, still before anything is proven.
  it('refuses a whole-balance send once the baked fee is known, before proving', async () => {
    discoverPrivateBalance.mockResolvedValue(10_000_000n); // 10 USDC

    await expect(
      sendPrivateToStarknet({
        resolveSignature,
        amount: 10_000_000n, // the entire balance — leaves nothing for the fee
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/not enough for this transfer plus the .* privacy fee/);
    expect(transfers.executeWithInvocation).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    // Settled arithmetic — the rebuild retry must not re-run the paymaster build or
    // invalidate the proof-nonce cache behind a misleading "submit failed" line.
    expect(avnuBuild).toHaveBeenCalledOnce();
    expect(transfers.invalidateProofNonceCache).not.toHaveBeenCalled();
  });

  it('allows a send that leaves room for the baked fee', async () => {
    discoverPrivateBalance.mockResolvedValue(10_000_000n);

    const result = await sendPrivateToStarknet({
      resolveSignature,
      amount: 9_000_000n,
      recipient: RECIPIENT,
    });
    expect(result.txHash).toBe(TX_HASH);
  });

  it('skips the pool-fee read entirely — the fee rides in the proof', async () => {
    await sendPrivateToStarknet({ resolveSignature, amount: AMOUNT, recipient: RECIPIENT });
    expect(fetchPoolFeeAmount).not.toHaveBeenCalled();
    expect(approvePoolFee).not.toHaveBeenCalled();
  });
});
