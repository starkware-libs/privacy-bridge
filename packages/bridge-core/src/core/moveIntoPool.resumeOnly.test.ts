// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Resume-only continue: `resume: true` derives `resumeOnly` for BOTH fundDepositToken
// call sites (deploy step + deposit step), skips the eth_requestAccounts prompt, and
// converges a standalone burn whose CCTP nonce is already consumed instead of stranding
// it. fundFromMetaMask is mocked here — depositIn.test.ts owns the guard itself.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '0xACCOUNT';
const PUBKEY = '0xPUBKEY';
const MOCK_PRIV = '0xPRIV';
const MOCK_VK = 5n;
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;
const AMOUNT = 1_000_000n;
// Live-observed dust a fully-successful deposit leaves behind (< RESIDUAL_DUST_THRESHOLD_WEI).
const DUST = 300n;

const configMock = vi.hoisted(() => ({
  ozClassHash: '0xoz',
  deployFeeMode: 'sponsored' as 'sponsored' | 'default',
  paymaster: undefined as undefined | { feeMode: string },
  depositToken: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
  cctp: {},
}));

vi.mock('./config', () => ({ config: configMock }));

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey: vi.fn(() => MOCK_PRIV),
  deriveViewingKey: vi.fn(() => MOCK_VK),
  deriveStarknetAccount: vi.fn(() => ({ address: ACCOUNT, publicKey: PUBKEY })),
}));

vi.mock('./provider', () => ({
  makeAccount: vi.fn((address: string) => ({ address })),
  getRpcProvider: vi.fn(() => ({})),
}));

vi.mock('./proving', () => ({ getCurrentBlock: vi.fn(async () => 100) }));

vi.mock('./deploy', () => ({
  isDeployedOnL2: vi.fn(),
  ensureAccountDeployed: vi.fn(),
}));

vi.mock('./register', () => ({
  isRegistered: vi.fn(),
  registerWithPool: vi.fn(),
}));

vi.mock('./deposit', () => ({
  depositToPool: vi.fn(),
  buildDepositProofAhead: vi.fn(async () => undefined),
  ensureDepositTokenFunded: vi.fn(),
  readDepositTokenBalance: vi.fn(),
}));

vi.mock('./depositIn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./depositIn')>();
  return { ...actual, fundFromMetaMask: vi.fn(), isCctpMessageNonceUsed: vi.fn() };
});

vi.mock('./poolDepositCursor', () => ({
  readPendingPoolDeposit: vi.fn(() => null),
  recordPendingPoolDeposit: vi.fn(),
  clearPendingPoolDeposit: vi.fn(),
}));

import { moveIntoPool } from './moveIntoPool';
import { isDeployedOnL2, ensureAccountDeployed } from './deploy';
import { isRegistered, registerWithPool } from './register';
import { depositToPool, readDepositTokenBalance } from './deposit';
import { fundFromMetaMask, isCctpMessageNonceUsed } from './depositIn';
import { markNonRetryable } from './errors';
import { recordPendingPoolDeposit, clearPendingPoolDeposit } from './poolDepositCursor';

const mIsDeployed = vi.mocked(isDeployedOnL2);
const mEnsureDeployed = vi.mocked(ensureAccountDeployed);
const mIsRegistered = vi.mocked(isRegistered);
const mRegister = vi.mocked(registerWithPool);
const mDeposit = vi.mocked(depositToPool);
const mReadBalance = vi.mocked(readDepositTokenBalance);
const mFundMM = vi.mocked(fundFromMetaMask);
const mIsNonceUsed = vi.mocked(isCctpMessageNonceUsed);
const mRecordPending = vi.mocked(recordPendingPoolDeposit);
const mClearPending = vi.mocked(clearPendingPoolDeposit);

// A connected wallet by default; a test overrides `accounts` to exercise resolveFunder.
function fakeProvider(accounts: string[] = ['0xFUNDER']) {
  const request = vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_accounts' || method === 'eth_requestAccounts' ? accounts : null,
  );
  return {
    request,
    provider: { request } as unknown as Parameters<typeof moveIntoPool>[0]['provider'],
  };
}

// fundFromMetaMask double for the standalone-convergence cases: the CCTP nonce is
// already consumed, so it signals completion instead of re-burning.
function fundReportsConsumed(foldBurn: boolean): void {
  mFundMM.mockImplementation(async (args) => {
    args.onMintAlreadyConsumed?.({ foldBurn });
    return AMOUNT;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.deployFeeMode = 'sponsored';
  configMock.paymaster = { feeMode: 'sponsored' };
  mIsDeployed.mockResolvedValue(true);
  mEnsureDeployed.mockResolvedValue(100);
  mIsRegistered.mockResolvedValue(true);
  mRegister.mockResolvedValue(undefined);
  mDeposit.mockResolvedValue(undefined);
  mReadBalance.mockResolvedValue(0n);
  mIsNonceUsed.mockResolvedValue(false);
  mFundMM.mockResolvedValue(AMOUNT);
});

describe('moveIntoPool — resumeOnly is derived from `resume` at both fund sites', () => {
  it('deposit step: resume true ⇒ resumeOnly true; a fresh press ⇒ false', async () => {
    for (const resume of [true, false]) {
      vi.clearAllMocks();
      await moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider().provider,
        resume,
      });
      expect(mFundMM).toHaveBeenCalledTimes(1);
      expect(mFundMM.mock.calls[0]![0].resumeOnly).toBe(resume);
    }
  });

  // The deploy step funds under a user-paid deploy fee and passes NONE of the fold
  // callbacks — the site a "thread it like onMintAlreadyConsumed" recipe misses.
  it('deploy step (user-paid deploy fee) also funds with resumeOnly', async () => {
    configMock.deployFeeMode = 'default';
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mReadBalance.mockResolvedValue(AMOUNT); // post-deploy balance the deposit step reads

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
    });

    // Exactly one fund, and it is the DEPLOY-step one (no fold on this path).
    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mFundMM.mock.calls[0]![0].resumeOnly).toBe(true);
    expect(mFundMM.mock.calls[0]![0].deferMint).toBeFalsy();
  });

  it('resume-only never prompts for accounts: no eth_requestAccounts fallback', async () => {
    const wallet = fakeProvider([]); // wallet connected to nothing

    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: wallet.provider,
        resume: true,
      }),
    ).rejects.toThrow(/Connect a wallet/i);

    expect(wallet.request.mock.calls.some(([{ method }]) => method === 'eth_requestAccounts')).toBe(
      false,
    );
    expect(mFundMM).not.toHaveBeenCalled();
  });

  it('a fresh press still prompts (the fallback is only skipped under resume-only)', async () => {
    const wallet = fakeProvider([]);

    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: wallet.provider,
      }),
    ).rejects.toThrow(/Connect a wallet/i);

    expect(wallet.request.mock.calls.some(([{ method }]) => method === 'eth_requestAccounts')).toBe(
      true,
    );
  });

  // NOTHING_TO_RESUME is non-retryable, so runStep must surface it after ONE attempt —
  // a spinning retry loop would re-enter the fund leg for a deposit that isn't there.
  it('NOTHING_TO_RESUME from the fund leg is not retried', async () => {
    const err = markNonRetryable(
      Object.assign(new Error('There is no in-flight deposit to continue for this wallet.'), {
        code: 'NOTHING_TO_RESUME' as const,
      }),
    );
    mFundMM.mockRejectedValue(err);

    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider().provider,
        resume: true,
      }),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_RESUME' });

    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mDeposit).not.toHaveBeenCalled();
  });
});

// A standalone (non-fold) burn whose nonce is consumed proves only that the MINT landed:
// the funds may still rest on the account. The convergence must confirm before claiming
// completion, and must never claim it off an unreadable balance.
describe('moveIntoPool — standalone resume convergence', () => {
  it('settled above dust: deposits ONLY that balance and records the resume cursor first', async () => {
    fundReportsConsumed(false);
    mReadBalance.mockResolvedValue(AMOUNT);

    const result = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0]![0].amountWei).toBe(AMOUNT);
    expect(mDeposit.mock.calls[0]![0].foldMint).toBeUndefined();
    // Fold atomicity justified skipping the cursor; the half-state here needs it, or a
    // depositToPool failure strands the funds with nothing to resume from.
    expect(mRecordPending).toHaveBeenCalledWith(ACCOUNT, AMOUNT);
    expect(result.deposited).toBe(true);
  });

  // The cursor is only worth anything if it is recorded BEFORE the deposit — assert the
  // property (a failed deposit leaves something resumable), not the call order.
  it('settled above dust + the deposit-only FAILS: the resume cursor is still recorded', async () => {
    fundReportsConsumed(false);
    mReadBalance.mockResolvedValue(AMOUNT);
    mDeposit.mockRejectedValue(new Error('apply_actions reverted on-chain'));

    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider().provider,
        resume: true,
      }),
    ).rejects.toThrow(/reverted/i);

    expect(mRecordPending).toHaveBeenCalledWith(ACCOUNT, AMOUNT);
  });

  // The live cursor population is FOLD, so pin the widened threshold there too: dust left
  // by a fully-successful fold deposit must converge, not provoke a dust deposit. Fold
  // reads once (atomicity), so no timer advance is needed.
  it('fold resume + dust on the account: converges without a dust deposit', async () => {
    fundReportsConsumed(true);
    mReadBalance.mockResolvedValue(DUST);

    const steps: Array<[string, string, string | undefined]> = [];
    const result = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
      onStep: (step, status, detail) => steps.push([step, status, detail]),
    });

    expect(mDeposit).not.toHaveBeenCalled();
    expect(
      steps.some(
        ([s, st, d]) => s === 'deposit' && st === 'done' && d === 'Already deposited into pool.',
      ),
    ).toBe(true);
    expect(result.deposited).toBe(false);
  });

  it('settled at dust: converges to done and submits no dust deposit', async () => {
    fundReportsConsumed(false);
    mReadBalance.mockResolvedValue(DUST);

    const steps: Array<[string, string, string | undefined]> = [];
    vi.useFakeTimers();
    const run = moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
      onStep: (step, status, detail) => steps.push([step, status, detail]),
    });
    await vi.runAllTimersAsync();
    const result = await run;
    vi.useRealTimers();

    expect(mDeposit).not.toHaveBeenCalled();
    expect(
      steps.some(
        ([s, st, d]) => s === 'deposit' && st === 'done' && d === 'Already deposited into pool.',
      ),
    ).toBe(true);
    expect(mClearPending).toHaveBeenCalledWith(ACCOUNT);
    expect(result.deposited).toBe(false);
  });

  // A read failure must CLEAR any earlier successful read — the last read's outcome
  // governs convergence, never a stale earlier success. Without this, a dust read that
  // later goes unreadable would still converge on the STALE dust reading.
  it('a later read failure clears an earlier dust read: rethrows, never converges to done', async () => {
    fundReportsConsumed(false);
    mReadBalance.mockResolvedValueOnce(0n).mockRejectedValue(new Error('rpc unavailable 503'));

    const steps: Array<[string, string, string | undefined]> = [];
    vi.useFakeTimers();
    const run = moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
      onStep: (step, status, detail) => steps.push([step, status, detail]),
    }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await run;
    vi.useRealTimers();

    expect(String(err)).toMatch(/rpc unavailable/i);
    expect(steps.some(([, st, d]) => st === 'done' && d === 'Already deposited into pool.')).toBe(
      false,
    );
    expect(mDeposit).not.toHaveBeenCalled();
  });

  it('balance unreadable for the whole window: rethrows, never converges to done', async () => {
    fundReportsConsumed(false);
    mReadBalance.mockRejectedValue(new Error('rpc unavailable 503'));

    const steps: Array<[string, string, string | undefined]> = [];
    vi.useFakeTimers();
    const run = moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider().provider,
      resume: true,
      onStep: (step, status, detail) => steps.push([step, status, detail]),
    }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await run;
    vi.useRealTimers();

    expect(String(err)).toMatch(/rpc unavailable/i);
    // An unreadable balance is not a swept one: no completion, and nothing deposited
    // against a balance we never read.
    expect(steps.some(([, st, d]) => st === 'done' && d === 'Already deposited into pool.')).toBe(
      false,
    );
    expect(mDeposit).not.toHaveBeenCalled();
    // The transient-looking read error re-runs the deposit body, but never re-funds.
    expect(mFundMM).toHaveBeenCalledTimes(1);
  });
});
