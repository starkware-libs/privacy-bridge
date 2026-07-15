// PART B — moveIntoPool single-tx deposit fold control flow.
//
// The fold applies by default whenever the fold precondition holds (AVNU paymaster
// path + metamask funding + an a-priori amount). When eligible, moveIntoPool asks
// fundFromMetaMask to DEFER the standalone mint (deferMint:true) and threads the
// returned attested bytes into depositToPool as `foldMint`, then clears the deferred
// burn cursor only after the deposit lands. Ineligible (manager path / not-a-priori /
// treasury funding) → today's proven 2-tx flow (no defer, no foldMint).
//
// LIVE boundary: the real AVNU-server acceptance of the folded invoke multicall is
// UNPROVEN offline — these mocked tests pin only the client-side control flow.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '0xACCOUNT';
const PUBKEY = '0xPUBKEY';
const MOCK_PRIV = '0xPRIV';
const MOCK_VK = 5n;
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;
const AMOUNT = 1_000_000n;
const MESSAGE = '0xabcdef01' as `0x${string}`;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;

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
  ensureDepositTokenFunded: vi.fn(),
  readDepositTokenBalance: vi.fn(),
}));

vi.mock('./depositIn', async (importOriginal) => {
  // Bind to the REAL isNonceAlreadyUsedError (not a copied regex) so the convergence gate
  // is exercised through the production classifier — a mis-worded revert or a later
  // narrowing of the match is caught here, not hidden behind a stale stub. Only
  // fundFromMetaMask is mocked (it drives live CCTP/network on the real path).
  const actual = await importOriginal<typeof import('./depositIn')>();
  return { ...actual, fundFromMetaMask: vi.fn() };
});

vi.mock('./poolDepositCursor', () => ({
  readPendingPoolDeposit: vi.fn(() => null),
  recordPendingPoolDeposit: vi.fn(),
  clearPendingPoolDeposit: vi.fn(),
}));

import { moveIntoPool } from './moveIntoPool';
import { getCurrentBlock } from './proving';
import { isDeployedOnL2, ensureAccountDeployed } from './deploy';
import { isRegistered, registerWithPool } from './register';
import { depositToPool, readDepositTokenBalance } from './deposit';
import { fundFromMetaMask } from './depositIn';
import {
  readPendingPoolDeposit,
  recordPendingPoolDeposit,
  clearPendingPoolDeposit,
} from './poolDepositCursor';

const mGetCurrentBlock = vi.mocked(getCurrentBlock);
const mIsDeployed = vi.mocked(isDeployedOnL2);
const mEnsureDeployed = vi.mocked(ensureAccountDeployed);
const mIsRegistered = vi.mocked(isRegistered);
const mRegister = vi.mocked(registerWithPool);
const mDeposit = vi.mocked(depositToPool);
const mReadBalance = vi.mocked(readDepositTokenBalance);
const mFundMM = vi.mocked(fundFromMetaMask);
const mReadPending = vi.mocked(readPendingPoolDeposit);
const mRecordPending = vi.mocked(recordPendingPoolDeposit);
const mClearPending = vi.mocked(clearPendingPoolDeposit);

function fakeProvider() {
  return { request: vi.fn(async () => ['0xFUNDER']) } as unknown as Parameters<
    typeof moveIntoPool
  >[0]['provider'];
}

// A shared spy the fold's clearMintCursor resolves to, so tests assert it fired only
// AFTER the deposit landed.
let clearMintCursorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  configMock.deployFeeMode = 'sponsored';
  configMock.paymaster = undefined;
  // Ideal fold case default: already deployed + registered (a-priori amount possible).
  mIsDeployed.mockResolvedValue(true);
  mEnsureDeployed.mockResolvedValue(100);
  mIsRegistered.mockResolvedValue(true);
  mRegister.mockResolvedValue(undefined);
  mDeposit.mockResolvedValue(undefined);
  // A fresh account holds nothing on-chain; the standalone-mint paths' chainResidual guard
  // (#433) reads this. Fold + convergence tests set an explicit balance where it matters.
  mReadBalance.mockResolvedValue(0n);
  clearMintCursorSpy = vi.fn();
  // fundFromMetaMask double: when asked to DEFER, hand back the attested bytes via
  // onMintFold (as the real one does on the fold path); otherwise a plain net return.
  mFundMM.mockImplementation(async (args) => {
    if (args.deferMint) {
      args.onMintFold?.({
        message: MESSAGE,
        attestation: ATTESTATION,
        clearMintCursor: clearMintCursorSpy,
      });
    }
    return AMOUNT;
  });
});

describe('moveIntoPool — Part B single-tx deposit fold', () => {
  it('paymaster + metamask + a-priori → deferMint:true and foldMint threaded to deposit (folds by default)', async () => {
    configMock.paymaster = { feeMode: 'sponsored' };

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    // fundFromMetaMask asked to defer the standalone mint.
    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mFundMM.mock.calls[0]![0].deferMint).toBe(true);

    // depositToPool received the folded mint bytes.
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0]![0].foldMint).toEqual({
      message: MESSAGE,
      attestation: ATTESTATION,
    });

    // The burn cursor is cleared only AFTER the deposit landed.
    expect(clearMintCursorSpy).toHaveBeenCalledTimes(1);
  });

  it('treasury funding → no fold (proven 2-tx flow)', async () => {
    configMock.paymaster = { feeMode: 'sponsored' };

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    // Treasury funding has no CCTP mint to fold — fundFromMetaMask is never invoked.
    expect(mFundMM).not.toHaveBeenCalled();
    expect(mDeposit.mock.calls[0]![0].foldMint).toBeUndefined();
    expect(clearMintCursorSpy).not.toHaveBeenCalled();
  });

  it('manager path (no paymaster) never folds', async () => {
    configMock.paymaster = undefined;

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mFundMM.mock.calls[0]![0].deferMint).toBe(false);
    expect(mDeposit.mock.calls[0]![0].foldMint).toBeUndefined();
  });

  it('not a-priori (user-paid deploy fee) → no fold even with paymaster', async () => {
    // deployFeeMode 'default' + paymaster ⇒ the deposit amount is sized from the
    // post-deploy balance (NOT a-priori), so the mint cannot be folded.
    configMock.paymaster = { feeMode: 'sponsored' };
    configMock.deployFeeMode = 'default';
    // Fresh account so the deploy step funds (user-paid fee), then the deposit reads
    // the live post-deploy balance.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mReadBalance.mockResolvedValue(AMOUNT);

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    // The only fund (in the deploy step) did NOT defer, and the deposit got no foldMint.
    expect(mFundMM.mock.calls.every((c) => !c[0].deferMint)).toBe(true);
    expect(mDeposit.mock.calls[0]![0].foldMint).toBeUndefined();
    expect(clearMintCursorSpy).not.toHaveBeenCalled();
  });

  // Finding 1 (HIGH): on the fold path the CCTP mint is folded INTO the deposit tx, so
  // funds are NOT minted until it lands. Recording the pending-pool-deposit cursor
  // BEFORE the deposit (as the non-fold 2-tx path does) breaks that cursor's invariant
  // ("funds already minted, only the deposit is pending"): a folded deposit that REVERTS
  // leaves the burn unminted (liveBalance 0), and on resume the recorded cursor + zero
  // balance would hit the zero-balance short-circuit → a FALSE "Already deposited into
  // pool." success while the burned funds are stranded. The fold path must instead lean
  // on fundFromMetaMask's own inflight burn cursor, which re-attests + re-folds on resume.
  it('folded deposit REVERTS → resume re-folds; never a false "Already deposited"', async () => {
    configMock.paymaster = { feeMode: 'sponsored' };

    // Stateful pending-pool-deposit cursor so a resume run reads whatever run 1 wrote.
    let pendingCursor: { netWei: bigint } | null = null;
    mRecordPending.mockImplementation((_addr: string, net: bigint) => {
      pendingCursor = { netWei: net };
    });
    mReadPending.mockImplementation(() => pendingCursor);
    mClearPending.mockImplementation(() => {
      pendingCursor = null;
    });

    // Run 1: the folded mint+deposit tx REVERTS (nothing minted; EVM funds burned).
    mDeposit.mockRejectedValueOnce(new Error('apply_actions reverted on-chain'));
    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
      }),
    ).rejects.toThrow(/reverted/i);

    // The mint never landed → on resume the derived account holds ZERO deposit token.
    mReadBalance.mockResolvedValue(0n);

    const steps: Array<[string, string, string | undefined]> = [];
    // Run 2 (Continue / resume): must re-attempt the fold, not short-circuit to success.
    const result = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      resume: true,
      onStep: (step, status, detail) => steps.push([step, status, detail]),
    });

    // Never emitted the false "Already deposited into pool." success.
    expect(steps.some(([, , detail]) => detail === 'Already deposited into pool.')).toBe(false);

    // depositToPool was re-attempted (run 1 threw + run 2 landed = 2 calls) and run 2
    // re-folded the mint bytes (a real re-mint, not a drained-balance no-op).
    expect(mDeposit).toHaveBeenCalledTimes(2);
    expect(mDeposit.mock.calls.at(-1)![0].foldMint).toEqual({
      message: MESSAGE,
      attestation: ATTESTATION,
    });
    // fundFromMetaMask was asked to defer again on the resume run.
    expect(mFundMM.mock.calls.at(-1)![0].deferMint).toBe(true);
    // A real deposit landed this run — and the burn cursor is cleared only now.
    expect(result.deposited).toBe(true);
    expect(clearMintCursorSpy).toHaveBeenCalledTimes(1);
  });

  // Bugbot MEDIUM "Fold lost on deposit retry". `funded` is hoisted (survives a transient
  // retry), but mintFold was body-local: a transient error in the deposit step AFTER
  // funding deferred the mint (here a getCurrentBlock RPC hiccup, BEFORE the depositToPool
  // try/catch) re-runs the body without re-funding, so a body-local mintFold would be lost
  // and depositToPool would run WITHOUT foldMint even though the USDC was never
  // standalone-minted. Fix: mintFold is hoisted alongside `funded`, so the retry keeps it.
  it('a TRANSIENT error after funding retries WITHOUT losing foldMint', async () => {
    configMock.paymaster = { feeMode: 'sponsored' };

    // getCurrentBlock (read right after funding, before the depositToPool try/catch)
    // throws a transient RPC error ONCE, then succeeds — forcing runStep to retry the
    // deposit body. Funding already deferred the mint on attempt 0 (funded=true), so the
    // retry must NOT re-fund but must still carry the captured fold bytes.
    mGetCurrentBlock.mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(100);

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    // Funding ran exactly ONCE (attempt 0); the transient retry did not re-fund.
    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mFundMM.mock.calls[0]![0].deferMint).toBe(true);
    // THE fix: the retried deposit still received the folded mint bytes (pre-fix: undefined).
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls.at(-1)![0].foldMint).toEqual({
      message: MESSAGE,
      attestation: ATTESTATION,
    });
    // The deposit landed → burn cursor cleared exactly once.
    expect(clearMintCursorSpy).toHaveBeenCalledTimes(1);
  });

  // FIX 1 (HIGH) — fold resume must not re-consume an already-spent CCTP nonce.
  // On the fold path the CCTP mint is folded INTO the atomic deposit, so a consumed
  // nonce ⟺ that whole deposit already committed. fundFromMetaMask's resume detects the
  // used nonce and fires onMintAlreadyConsumed (returning the landed net, no re-burn);
  // moveIntoPool then converges on completion via a live balance cross-check, instead of
  // re-folding receive_message with the spent nonce (which reverted "Nonce already used"
  // on every retry — the live stuck resume with no Continue).
  describe('fold resume + CCTP nonce already consumed', () => {
    beforeEach(() => {
      configMock.paymaster = { feeMode: 'sponsored' };
      // Resume detects the nonce already used: fire onMintAlreadyConsumed, do NOT fold,
      // return the already-landed net (mirrors the real fundFromMetaMask fold resume).
      mFundMM.mockImplementation(async (args) => {
        if (args.deferMint) args.onMintAlreadyConsumed?.();
        return AMOUNT;
      });
    });

    it('balance 0 → COMPLETE: no deposit re-submission, cursor cleared, done terminal', async () => {
      mReadBalance.mockResolvedValue(0n); // funds already pulled into the pool

      const steps: Array<[string, string, string | undefined]> = [];
      const result = await moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
        resume: true,
        onStep: (step, status, detail) => steps.push([step, status, detail]),
      });

      // No re-submission of the folded receive_message / apply_action.
      expect(mDeposit).not.toHaveBeenCalled();
      // Converged on the normal completion terminal.
      expect(
        steps.some(
          ([s, st, d]) => s === 'deposit' && st === 'done' && d === 'Already deposited into pool.',
        ),
      ).toBe(true);
      // Pool-deposit cursor cleared; none was ever recorded for the complete deposit.
      expect(mClearPending).toHaveBeenCalledWith(ACCOUNT);
      expect(mRecordPending).not.toHaveBeenCalled();
      // Resume completion → deposited false, net = the prior deposit's net.
      expect(result.deposited).toBe(false);
      expect(result.depositedNetWei).toBe(AMOUNT);
    });

    it('residual balance > 0 → deposit-ONLY that balance, NO receive_message re-fold', async () => {
      mReadBalance.mockResolvedValue(AMOUNT); // funds still sit on the account

      const result = await moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
        resume: true,
      });

      // A single non-fold deposit of the settled balance — never a re-fold of the mint.
      expect(mDeposit).toHaveBeenCalledTimes(1);
      expect(mDeposit.mock.calls[0]![0].foldMint).toBeUndefined();
      expect(mDeposit.mock.calls[0]![0].amountWei).toBe(AMOUNT);
      // Nothing was folded, so the burn-cursor clearer is never invoked here.
      expect(clearMintCursorSpy).not.toHaveBeenCalled();
      expect(result.deposited).toBe(true);
    });
  });

  // ISSUE #432 — the accepted≠reflected window the pre-submit is_nonce_used probe CANNOT
  // cover. A prior fold deposit was broadcast (AVNU code-156 ambiguous) but not yet
  // reflected; a quick retry re-folds because is_nonce_used still reads false, and the
  // atomic multicall reverts "Nonce already used" (AVNU code-156 / argent multicall). By
  // the atomic-fold invariant that revert PROVES the prior fold committed, so moveIntoPool
  // must converge on completion — never surface the raw revert as a stuck failure.
  describe('fold submit reverts "Nonce already used" (accepted≠reflected retry)', () => {
    beforeEach(() => {
      configMock.paymaster = { feeMode: 'sponsored' };
      // The fold IS attempted (default mock defers + fires onMintFold), but the atomic
      // deposit reverts with the transmitter's already-consumed-nonce revert (AVNU shape).
      mDeposit.mockRejectedValue(
        new Error(
          "AVNU paymaster paymaster_executeTransaction error (code 156): 'argent/multicall-failed', 'Nonce already used', 'ENTRYPOINT_FAILED'",
        ),
      );
    });

    it('balance swept to 0 → CONVERGE to done: no throw, burn cursor + pool cursor cleared', async () => {
      mReadBalance.mockResolvedValue(0n); // prior fold pulled the funds into the pool

      const steps: Array<[string, string, string | undefined]> = [];
      const result = await moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
        onStep: (step, status, detail) => steps.push([step, status, detail]),
      });

      // The fold WAS attempted (and reverted), but the run converged instead of failing.
      expect(mDeposit).toHaveBeenCalledTimes(1);
      expect(mDeposit.mock.calls[0]![0].foldMint).toEqual({
        message: MESSAGE,
        attestation: ATTESTATION,
      });
      expect(
        steps.some(
          ([s, st, d]) => s === 'deposit' && st === 'done' && d === 'Already deposited into pool.',
        ),
      ).toBe(true);
      // No error terminal was emitted for the deposit step.
      expect(steps.some(([s, st]) => s === 'deposit' && st === 'error')).toBe(false);
      // Deferred burn cursor cleared (mint definitively consumed) + pool cursor cleared.
      expect(clearMintCursorSpy).toHaveBeenCalledTimes(1);
      expect(mClearPending).toHaveBeenCalledWith(ACCOUNT);
      // A prior run committed the deposit → deposited false, net = the a-priori amount.
      expect(result.deposited).toBe(false);
      expect(result.depositedNetWei).toBe(AMOUNT);
    });

    it('residual balance > 0 → fail closed (never claim done on an anomalous half-state)', async () => {
      mReadBalance.mockResolvedValue(AMOUNT); // impossible for a pure atomic fold → guard

      await expect(
        moveIntoPool({
          signature: SIGNATURE,
          funding: 'metamask',
          amountWei: AMOUNT,
          provider: fakeProvider(),
        }),
      ).rejects.toThrow(/nonce already used/i);

      // No false completion: the burn/pool cursors are NOT cleared on the anomalous path.
      expect(clearMintCursorSpy).not.toHaveBeenCalled();
      // Fail closed, do NOT loop: the paymaster path marks the error non-retryable, so the
      // deposit is attempted exactly once (a regression that retried would call it twice).
      expect(mDeposit).toHaveBeenCalledTimes(1);
    });

    it('balance read FAILS during convergence → fail closed (no false done, no retry loop)', async () => {
      // The post-revert balance read throws (RPC hiccup). It must NOT escape to drive the
      // transient-retry loop; the run fails closed on the original AVNU error instead.
      mReadBalance.mockRejectedValue(new Error('rpc: fetch failed'));

      await expect(
        moveIntoPool({
          signature: SIGNATURE,
          funding: 'metamask',
          amountWei: AMOUNT,
          provider: fakeProvider(),
        }),
      ).rejects.toThrow(/nonce already used/i);

      expect(clearMintCursorSpy).not.toHaveBeenCalled();
      expect(mDeposit).toHaveBeenCalledTimes(1);
    });

    it('non-fold deposit that surfaces "nonce already used" does NOT converge (mintFold gate)', async () => {
      // Treasury funding → no CCTP mint folded (mintFold undefined). Even if the deposit
      // reverts with the same string, the `mintFold &&` gate must BLOCK convergence — only
      // a folded receive_message revert proves the atomic-fold deposit landed.
      mReadBalance.mockResolvedValue(0n);

      const steps: Array<[string, string, string | undefined]> = [];
      await expect(
        moveIntoPool({
          signature: SIGNATURE,
          funding: 'treasury',
          amountWei: AMOUNT,
          provider: fakeProvider(),
          onStep: (step, status, detail) => steps.push([step, status, detail]),
        }),
      ).rejects.toThrow(/nonce already used/i);

      // Never emitted the false completion terminal.
      expect(steps.some(([, , d]) => d === 'Already deposited into pool.')).toBe(false);
      expect(clearMintCursorSpy).not.toHaveBeenCalled();
    });
  });
});
