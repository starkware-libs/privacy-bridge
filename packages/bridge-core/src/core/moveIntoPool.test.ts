// Core orchestration tests for moveIntoPool (Slice E, docs/bridge-sdk-refactor.md
// §1 frozen fund-then-deploy state-transition table + §5 test-migration gate).
//
// These are the black-box behavioral proofs of the fund-safety invariants the app's
// white-box makePrivate tests used to cover (now that runMakePrivate collapses to a
// single moveIntoPool call, those app mocks intercept nothing — §5). We mock the
// composed step modules (deploy/register/deposit/depositIn) + key derivation and
// drive the orchestrator directly, asserting:
//   - Row 1  fresh, undeployed, deploy-fee OFF → deploy→register→fund→deposit(net)
//   - Row 2  fresh, undeployed, deploy-fee ON  → fund BEFORE deploy, deposit reads
//            the POST-deploy balance, never double-funds; sourceChainId threaded
//   - Row 3  already deployed (retry mid-run)  → skip deploy + register, fund once
//   - Row 3′ already deployed + deploy-fee ON  → cross-run RESUME: NO re-fund (no
//            double-burn), deposit the live POST-deploy balance (fundedNetWei is
//            recomputed from chain, never reused from a prior run)
//   - Row 4  retried mid-deploy (committed by retry) → skip, NO second deploy
//   - Row 4′ retried mid-deploy (NOT committed on retry) → re-enters the idempotent
//            ensureAccountDeployed (deploy.ts owns the no-second-tx guarantee)
// plus transient-retry (no re-fund) + treasury-vs-metamask net math, and
// spyOnSecretSinks() proving the signature / derived private key never leak.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spyOnSecretSinks, type SecretSinkSpy } from './__testkit__/secretSinks';

// Fixed derived-identity fixtures (derivation is mocked → deterministic).
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;
const MOCK_PRIV = '0xPRIVATEKEYMOCKdeadbeef';
const MOCK_VK = 987654321n;
const ACCOUNT = '0xACCOUNT';
const PUBKEY = '0xPUBKEY';
const SEPOLIA = 11155111;

// Mutable config the orchestrator reads for deployFeeMode / paymaster (drives
// DEPLOY_FEE_CHARGED_TO_USER). Reset per test in beforeEach.
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
  // makeAccount is only passed through to the (mocked) step fns; a light stub is fine.
  makeAccount: vi.fn((address: string) => ({ address })),
  getRpcProvider: vi.fn(() => ({})),
}));

vi.mock('./proving', () => ({
  getCurrentBlock: vi.fn(async () => 100),
}));

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

vi.mock('./depositIn', () => ({
  fundFromMetaMask: vi.fn(),
}));

// The cross-run pool-deposit resume cursor is a localStorage-backed store; mock it as a
// test double so we can simulate a prior run's state (Row 1 double-burn guard).
vi.mock('./poolDepositCursor', () => ({
  readPendingPoolDeposit: vi.fn(() => null),
  recordPendingPoolDeposit: vi.fn(),
  clearPendingPoolDeposit: vi.fn(),
}));

import { moveIntoPool, type MoveStep, type StepStatus } from './moveIntoPool';
import { isDeployedOnL2, ensureAccountDeployed } from './deploy';
import { isRegistered, registerWithPool } from './register';
import { depositToPool, ensureDepositTokenFunded, readDepositTokenBalance } from './deposit';
import { fundFromMetaMask } from './depositIn';
import {
  readPendingPoolDeposit,
  recordPendingPoolDeposit,
  clearPendingPoolDeposit,
} from './poolDepositCursor';

const mIsDeployed = vi.mocked(isDeployedOnL2);
const mEnsureDeployed = vi.mocked(ensureAccountDeployed);
const mIsRegistered = vi.mocked(isRegistered);
const mRegister = vi.mocked(registerWithPool);
const mDeposit = vi.mocked(depositToPool);
const mEnsureFunded = vi.mocked(ensureDepositTokenFunded);
const mReadBalance = vi.mocked(readDepositTokenBalance);
const mFundMM = vi.mocked(fundFromMetaMask);
const mReadPending = vi.mocked(readPendingPoolDeposit);
const mRecordPending = vi.mocked(recordPendingPoolDeposit);
const mClearPending = vi.mocked(clearPendingPoolDeposit);

const AMOUNT = 1_000_000n; // 1 USDC @ 6dp

// A provider stub whose eth_accounts resolves the funder (metamask funding).
function fakeProvider() {
  return { request: vi.fn(async () => ['0xFUNDER']) } as unknown as Parameters<
    typeof moveIntoPool
  >[0]['provider'];
}

// Records the onStep event stream so tests can assert the (step,status) sequence
// and the tx hash carried on each step's 'done' (undefined when the leg submitted
// nothing — an idempotent skip or the paymaster register no-op).
function stepRecorder() {
  const events: Array<[MoveStep, StepStatus]> = [];
  const txByStep: Partial<Record<MoveStep, string | undefined>> = {};
  return {
    events,
    onStep: (step: MoveStep, status: StepStatus, _detail?: string, txHash?: string): void => {
      events.push([step, status]);
      if (status === 'done') txByStep[step] = txHash;
    },
    statusesFor(step: MoveStep): StepStatus[] {
      return events.filter(([s]) => s === step).map(([, st]) => st);
    },
    txFor(step: MoveStep): string | undefined {
      return txByStep[step];
    },
  };
}

let sinks: SecretSinkSpy;

beforeEach(() => {
  vi.clearAllMocks();
  configMock.deployFeeMode = 'sponsored';
  configMock.paymaster = undefined;
  // Default happy-path stubs; individual tests override.
  mIsDeployed.mockResolvedValue(true);
  mEnsureDeployed.mockResolvedValue(100);
  mIsRegistered.mockResolvedValue(true);
  mRegister.mockResolvedValue(undefined);
  mDeposit.mockResolvedValue(undefined);
  mEnsureFunded.mockResolvedValue(undefined);
  // A FRESH account holds nothing on-chain (the chainResidual double-burn guard reads
  // this). Resume / deploy-fee tests set the balance explicitly, so they're unaffected.
  mReadBalance.mockResolvedValue(0n);
  mFundMM.mockResolvedValue(AMOUNT);
  // Default: no prior-run pool-deposit cursor (fresh run). Individual resume tests override.
  mReadPending.mockReturnValue(null);
  sinks = spyOnSecretSinks();
});

afterEach(() => {
  // Every path must be leak-free: the raw signature, derived private key and
  // viewing key must NEVER reach console / localStorage / sessionStorage.
  sinks.assertNeverLeaked(SIGNATURE, MOCK_PRIV, MOCK_VK.toString());
  sinks.restore();
});

describe('moveIntoPool — fund-then-deploy state table', () => {
  it('Row 1: fresh, undeployed, deploy-fee OFF → admin-funded deploy, register, fund+deposit(net) in order', async () => {
    // Undeployed at the deploy gate, committed by the waitForL2Commit poll.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    const order: string[] = [];
    mEnsureDeployed.mockImplementation(async () => {
      order.push('deploy');
      return 100;
    });
    mRegister.mockImplementation(async () => {
      order.push('register');
    });
    mEnsureFunded.mockImplementation(async () => {
      order.push('fund');
    });
    mDeposit.mockImplementation(async () => {
      order.push('deposit');
    });

    const rec = stepRecorder();
    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      onStep: rec.onStep,
    });

    expect(mEnsureDeployed).toHaveBeenCalledTimes(1);
    expect(mRegister).toHaveBeenCalledTimes(1);
    expect(mEnsureFunded).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['deploy', 'register', 'fund', 'deposit']);
    // Treasury lands the full gross.
    expect(depositedNetWei).toBe(AMOUNT);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(AMOUNT);
    // onStep fires running→done for each step, in order.
    expect(rec.statusesFor('deploy')).toContain('done');
    expect(rec.statusesFor('register')).toContain('done');
    expect(rec.statusesFor('deposit')).toContain('done');
    expect(rec.events[0]).toEqual(['deploy', 'running']);
  });

  it("Row 1 (deploy-fee OFF, metamask, resume:true, deposit ALREADY landed): NO re-fund (no double-burn) — drained balance + pending cursor short-circuits", async () => {
    // A PRIOR run funded this account from the user's OWN USDC (fundFromMetaMask burned
    // + minted) AND its depositToPool landed, DRAINING the SN balance and clearing the
    // pmp.inflightDeposit cursor. This run RESUMES with funded=false (the in-memory flag
    // is gone). Without the pool-deposit cursor the deposit step would see a zero balance
    // + no inflight-deposit cursor and re-enter fundFromMetaMask's FRESH burn path →
    // DOUBLE-BURN. The persisted cursor + the drained live balance lock that out.
    const NET = AMOUNT - 20_000n; // what the prior run's CCTP funder landed + deposited
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    mReadPending.mockReturnValue({ netWei: NET }); // a prior run's pending-deposit cursor
    mReadBalance.mockResolvedValue(0n); // balance DRAINED → the deposit already landed

    // Explicit Continue: resume:true auto-consumes the pending cursor (a fresh press
    // would instead FAIL CLOSED with PENDING_POOL_DEPOSIT — see the C1 test below).
    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      resume: true,
    });

    // THE fund-safety assertion: neither funder is re-invoked → no second CCTP burn.
    expect(mFundMM).not.toHaveBeenCalled();
    expect(mEnsureFunded).not.toHaveBeenCalled();
    // Short-circuit: the pool already holds the funds, so no wasteful 0-deposit.
    expect(mDeposit).not.toHaveBeenCalled();
    expect(mReadBalance).toHaveBeenCalledTimes(1); // consulted the live (drained) balance
    // The operation is complete → the resume cursor is cleared, and we report the net
    // the prior run actually deposited (not the gross).
    expect(mClearPending).toHaveBeenCalledWith(ACCOUNT);
    expect(depositedNetWei).toBe(NET);
  });

  it("Row 1 (deploy-fee OFF, metamask, resume:true, funds MINTED but NOT yet deposited): NO re-fund, deposits the live balance", async () => {
    // Died between the prior run's mint and its depositToPool: the funds are on the SN
    // account (balance = NET) but the pool deposit never landed. Resume must deposit the
    // LIVE balance WITHOUT re-funding (no second burn), then clear the cursor.
    const NET = AMOUNT - 20_000n;
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue({ netWei: NET });
    mReadBalance.mockResolvedValue(NET); // funds sitting on the account, undeposited

    // Explicit Continue (resume:true): deposits the live balance without re-funding.
    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      resume: true,
    });

    expect(mFundMM).not.toHaveBeenCalled(); // no re-burn
    expect(mEnsureFunded).not.toHaveBeenCalled();
    // Deposits the ACTUAL live balance (re-read from chain), not the typed gross.
    expect(mReadBalance).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(NET);
    expect(mClearPending).toHaveBeenCalledWith(ACCOUNT); // cleared on completion
    expect(depositedNetWei).toBe(NET);
  });

  it('C1 (fresh press over a stale cursor): FAILS CLOSED with PENDING_POOL_DEPOSIT — never funds, never deposits the leftover', async () => {
    // The bug: a FRESH deposit (resume falsy) with a stale persisted cursor auto-resumed
    // the old interrupted deposit — depositing the tiny on-chain leftover, IGNORING the
    // user's freshly-typed amount, and SKIPPING the burn (no wallet signature). The C1
    // guard fails closed instead so the app can offer an explicit Continue.
    const NET = AMOUNT - 20_000n;
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    mReadPending.mockReturnValue({ netWei: NET }); // a prior run's pending-deposit cursor

    // resume is FALSY → must reject with the typed PENDING_POOL_DEPOSIT (carrying the
    // pending net) rather than silently consuming the cursor.
    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
      }),
    ).rejects.toMatchObject({ code: 'PENDING_POOL_DEPOSIT', pendingNetWei: NET });

    // Fail-closed proof: NO funder ran (no second burn) and NO deposit was made — the
    // interrupted transfer is left intact for an explicit Continue (resume:true).
    expect(mFundMM).not.toHaveBeenCalled();
    expect(mEnsureFunded).not.toHaveBeenCalled();
    expect(mDeposit).not.toHaveBeenCalled();
    expect(mClearPending).not.toHaveBeenCalled(); // cursor preserved
  });

  it('Row 1 (fresh run, deploy-fee OFF): records the pool-deposit cursor BEFORE depositToPool, clears it after', async () => {
    // The fresh happy path must persist the resume cursor the instant the funds land
    // (so a reload before/after depositToPool can resume without re-burning), then
    // clear it once the deposit completes.
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null); // fresh run, no prior cursor
    const NET = AMOUNT - 20_000n;
    mFundMM.mockResolvedValue(NET);
    const order: string[] = [];
    mRecordPending.mockImplementation(() => {
      order.push('record');
    });
    mDeposit.mockImplementation(async () => {
      order.push('deposit');
    });
    mClearPending.mockImplementation(() => {
      order.push('clear');
    });

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mRecordPending).toHaveBeenCalledWith(ACCOUNT, NET);
    // Cursor recorded BEFORE the deposit, cleared AFTER (the resume-window invariant).
    expect(order).toEqual(['record', 'deposit', 'clear']);
  });

  it('Row 2: fresh, undeployed, deploy-fee ON → funds BEFORE deploy, deposit reads POST-deploy balance, no double-fund; sourceChainId threaded', async () => {
    configMock.deployFeeMode = 'default';
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    // The funder lands 1 USDC; the deploy then consumes a fee, leaving 0.9 on-chain.
    mFundMM.mockResolvedValue(AMOUNT);
    const POST_DEPLOY = 900_000n;
    mReadBalance.mockResolvedValue(POST_DEPLOY);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      sourceChainId: SEPOLIA,
    });

    // Funded exactly ONCE, in the DEPLOY step (fund-then-deploy) — never re-funded
    // by the deposit step.
    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mEnsureFunded).not.toHaveBeenCalled();
    // The user's source-chain pick reaches the deploy-fee funding leg.
    expect(mFundMM.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sourceChainId: SEPOLIA }),
    );
    // The deposit reads the POST-deploy balance (deposit − deploy fee), not the gross.
    expect(mReadBalance).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(POST_DEPLOY);
    expect(depositedNetWei).toBe(POST_DEPLOY);
    expect(mEnsureDeployed).toHaveBeenCalledTimes(1);
  });

  it('Row 3: already deployed (retry mid-run) → skips deploy + register, funds once, deposits', async () => {
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
    });

    // Idempotent skips: no deploy tx, no re-register (write-once).
    expect(mEnsureDeployed).not.toHaveBeenCalled();
    expect(mRegister).not.toHaveBeenCalled();
    // Deposit still funds (idempotent shortfall top-up) + deposits, exactly once.
    expect(mEnsureFunded).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(depositedNetWei).toBe(AMOUNT);
  });

  it("Row 3′ (deploy-fee ON, cross-run resume): already deployed+registered → NO re-fund (no double-burn), deposits live POST-deploy balance", async () => {
    // A PRIOR run already deployed + registered this account and burned the user's
    // USDC to fund it; the one-time deploy fee was ALSO already spent, leaving the
    // post-deploy balance on-chain. This run RESUMES with funded=false — the in-memory
    // `funded` flag does NOT survive a reload/resume. The double-burn guard: an
    // already-deployed account under a user-paid deploy fee must NEVER re-fund the
    // gross (that second CCTP burn is the bug this test locks out), and must deposit
    // the ACTUAL live balance, not the originally-typed amountWei.
    configMock.deployFeeMode = 'default';
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    const POST_DEPLOY = 900_000n; // deposit − deploy fee already sitting on-chain
    mReadBalance.mockResolvedValue(POST_DEPLOY);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      sourceChainId: SEPOLIA,
    });

    // NO second burn: neither the metamask nor the treasury funder is re-invoked.
    expect(mFundMM).not.toHaveBeenCalled();
    expect(mEnsureFunded).not.toHaveBeenCalled();
    // Deposit the LIVE post-deploy balance (re-read from chain), never the gross.
    expect(mReadBalance).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(POST_DEPLOY);
    expect(depositedNetWei).toBe(POST_DEPLOY);
    // Deploy + register skipped (idempotent) on the resume.
    expect(mEnsureDeployed).not.toHaveBeenCalled();
    expect(mRegister).not.toHaveBeenCalled();
  });

  it("Row 3″ (deploy-fee ON, FRESH re-deposit into a DRAINED account, NO cursor): funds normally — deployment status alone is NOT 'resume' (Bugbot MEDIUM)", async () => {
    // Regression for the Bugbot MEDIUM (moveIntoPool L315-L332): a user-paid deploy fee
    // + an already-deployed account made EVERY subsequent run take the resume path
    // (skip funding, deposit the live balance) because the discriminator was
    // `deployFeeChargedToUser && accountDeployed`. After a PRIOR deposit fully drained
    // the account (balance 0) and cleared its cursor, a genuinely NEW deposit would then
    // skip funding and deposit ZERO — the user could never add funds again. Deployment
    // status alone must NOT imply "resume": with NO pending cursor and a DRAINED balance,
    // the run MUST fund normally and deposit the funded amount.
    configMock.deployFeeMode = 'default';
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    mReadPending.mockReturnValue(null); // NO prior-run cursor (the prior op completed)
    mReadBalance.mockResolvedValue(0n); // prior deposit DRAINED the account
    const NET = AMOUNT - 20_000n; // what the fresh CCTP burn lands
    mFundMM.mockResolvedValue(NET);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      sourceChainId: SEPOLIA,
    });

    // THE fix: a drained already-deployed account under a user-paid deploy fee with no
    // cursor is a FRESH deposit → it MUST fund (not deposit a useless 0).
    expect(mFundMM).toHaveBeenCalledTimes(1);
    expect(mEnsureFunded).not.toHaveBeenCalled();
    // The resume cursor is recorded BEFORE the deposit (crash-safety), like Row 1 fresh.
    expect(mRecordPending).toHaveBeenCalledWith(ACCOUNT, NET);
    // Deposits the freshly-funded amount, never zero.
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(NET);
    expect(depositedNetWei).toBe(NET);
    // Deploy + register still skipped (idempotent) — only the FUNDING gap is fixed.
    expect(mEnsureDeployed).not.toHaveBeenCalled();
    expect(mRegister).not.toHaveBeenCalled();
  });

  it('Row 4: retried mid-deploy (deploy sent, not confirmed) → polls to confirmation, does NOT re-send the deploy', async () => {
    // Undeployed at the first gate; the deploy submit reports a TRANSIENT error
    // (its tx may have landed). On the retry the account now reads deployed, so the
    // orchestrator must NOT call ensureAccountDeployed a second time.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mEnsureDeployed.mockRejectedValueOnce(
      new Error('submitAndTrack: timed out after 120000ms for 0xdeploy'),
    );

    const rec = stepRecorder();
    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      onStep: rec.onStep,
    });

    // The invariant: exactly ONE deploy tx despite the transient retry.
    expect(mEnsureDeployed).toHaveBeenCalledTimes(1);
    // Deploy still completes.
    expect(rec.statusesFor('deploy')).toContain('done');
    expect(mDeposit).toHaveBeenCalledTimes(1);
  });

  it("Row 4′: retried mid-deploy, STILL not committed on retry → re-enters the idempotent ensureAccountDeployed, no second on-chain deploy", async () => {
    // The deploy submit reports a TRANSIENT error and the account is STILL not
    // committed (isDeployedOnL2 stays false) at the retry gate — the genuine
    // "deploy sent, not yet confirmed" sub-case. moveIntoPool re-enters
    // ensureAccountDeployed, which is itself idempotent: its internal pre-confirmed
    // `isDeployed` check (deploy.ts) short-circuits an in-flight deploy, so the
    // second call waits on the in-flight deploy and submits NO second deploy tx.
    // We model that idempotency here — the retried ensureAccountDeployed resolves
    // WITHOUT re-deploying — and assert the run still completes and deposits once.
    // (The no-second-tx guarantee is owned + unit-tested at the ensureAccountDeployed
    // layer; the orchestrator's isDeployedOnL2 gate is only a fast-path skip.)
    // Gate #1 false, gate #2 (retry) false, then the waitForL2Commit poll observes it.
    mIsDeployed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    let deployCalls = 0;
    mEnsureDeployed.mockImplementation(async () => {
      deployCalls += 1;
      if (deployCalls === 1) {
        throw new Error('submitAndTrack: timed out after 120000ms for 0xdeploy');
      }
      // Idempotent re-entry: the in-flight deploy is pre-confirmed, so this returns
      // the committed block without sending a second deploy tx.
      return 100;
    });

    const rec = stepRecorder();
    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      onStep: rec.onStep,
    });

    // Re-entered on the not-yet-committed retry (relying on the callee's idempotency)
    // rather than blindly polling; the callee guarantees no second deploy tx.
    expect(deployCalls).toBe(2);
    expect(rec.statusesFor('deploy')).toContain('done');
    expect(mDeposit).toHaveBeenCalledTimes(1);
    // deploy-fee OFF + no cursor + not funded this attempt → the chainResidual guard
    // reads the (empty) SN balance once before funding (fresh-vs-resume detection).
    expect(mReadBalance).toHaveBeenCalledTimes(1);
  });
});

describe('moveIntoPool — chain-sourced fresh-vs-resume residual guard (#433)', () => {
  // The cross-browser double-burn: a prior deposit interrupted AFTER the CCTP mint left
  // an "undeposited residual" on the derived SN account, but the resume cursor lives only
  // in the ORIGINATING browser's localStorage. A fresh browser / cleared storage has NO
  // cursor, so the old code treated the next press as fresh and RE-MINTED (double CCTP
  // burn). moveIntoPool now reads the SN balance directly on the uncovered path and FAILS
  // CLOSED on a residual > dust so the app offers Continue — even without a cursor.
  const NET = AMOUNT - 20_000n; // an undeposited residual > the 0.05 USDC dust floor

  it('inv.2: fresh press, NO cursor, on-chain residual > dust, resume falsy → FAILS CLOSED (PENDING_POOL_DEPOSIT), never funds/deposits', async () => {
    // The heart of #433. No cursor (fresh browser), but the SN account holds an
    // interrupted prior deposit's minted funds. A fresh press must NOT re-mint.
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // already registered → register skipped
    mReadPending.mockReturnValue(null); // NO cursor — the cross-browser case
    mReadBalance.mockResolvedValue(NET); // undeposited residual detected on-chain

    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'metamask',
        amountWei: AMOUNT,
        provider: fakeProvider(),
      }),
    ).rejects.toMatchObject({ code: 'PENDING_POOL_DEPOSIT', pendingNetWei: NET });

    // Fail-closed proof: NO second burn, NO deposit of the leftover.
    expect(mFundMM).not.toHaveBeenCalled();
    expect(mEnsureFunded).not.toHaveBeenCalled();
    expect(mDeposit).not.toHaveBeenCalled();
  });

  it('inv.3: chain residual + NO cursor + resume:true → deposits the residual, NEVER re-funds', async () => {
    // An explicit Continue on the same cross-browser residual: deposit the live balance
    // (deposit-only branch), never a second burn.
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null); // still no cursor
    mReadBalance.mockResolvedValue(NET); // residual on-chain

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      resume: true,
    });

    expect(mFundMM).not.toHaveBeenCalled(); // no re-burn
    expect(mEnsureFunded).not.toHaveBeenCalled();
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(NET); // deposits the residual
    expect(depositedNetWei).toBe(NET);
  });

  it('inv.4: deployed + registered, NO cursor, balance 0 (drained), resume falsy → funds normally (balance-based, not deployment-based)', async () => {
    // A genuinely fresh deposit into a drained already-deployed/registered account: no
    // residual, so no fail-closed — it MUST fund (deployment status alone is not "resume").
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null);
    mReadBalance.mockResolvedValue(0n); // drained
    const FUNDED = AMOUNT - 20_000n;
    mFundMM.mockResolvedValue(FUNDED);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mFundMM).toHaveBeenCalledTimes(1); // funds normally
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(FUNDED);
    expect(depositedNetWei).toBe(FUNDED);
  });

  it('dust: sub-threshold residual (40_000n < 50_000n), NO cursor, resume falsy → no throw, funds normally', async () => {
    // Fee-change / surplus-note dust must NOT nag Continue or fail-close a fresh deposit.
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null);
    mReadBalance.mockResolvedValue(40_000n); // < RESIDUAL_DUST_THRESHOLD_WEI
    const FUNDED = AMOUNT - 20_000n;
    mFundMM.mockResolvedValue(FUNDED);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mFundMM).toHaveBeenCalledTimes(1); // dust is ignored → fresh deposit funds
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(FUNDED);
    expect(depositedNetWei).toBe(FUNDED);
  });
});

describe('moveIntoPool — deposit autoRegister gating (#305 re-register collision)', () => {
  // The bug: the deposit step always defaulted autoRegister:true, so an ALREADY-registered
  // account folded a second register() into the deposit's atomic apply_actions → the pool's
  // write-once viewing-key slot reverts NON_ZERO_VALUE, reverting the whole deposit; on the
  // AVNU paymaster path that lands in the AMBIGUOUS fail-closed branch ("account is already
  // registered but the deposit was not committed"). Fix: thread the account's registration
  // status → pass autoRegister:false whenever it's already registered.
  it('passes autoRegister:false to depositToPool when the account is ALREADY registered (paymaster)', async () => {
    // RED pre-fix: moveIntoPool never passed autoRegister → undefined (defaults true in
    // depositToPool). GREEN after: explicit false, so no second register is folded in.
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(true); // ALREADY registered on-chain ← the bug trigger
    mReadPending.mockReturnValue(null);
    mFundMM.mockResolvedValue(AMOUNT);

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].autoRegister).toBe(false);
  });

  it('keeps autoRegister:true for a FRESH account on the paymaster path (register deferred to the deposit fold)', async () => {
    // A fresh paymaster account: isRegistered false AND registerWithPool is a deliberate
    // no-op (defers to the deposit's autoRegister), so the deposit MUST fold the register in.
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true); // fresh → deploys
    mIsRegistered.mockResolvedValue(false); // NOT registered → paymaster register no-ops
    mReadPending.mockReturnValue(null);
    mFundMM.mockResolvedValue(AMOUNT);

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].autoRegister).toBe(true);
  });

  // BUG 3 (#305 recurring on the AUTO-continue path): the register step can read
  // isRegistered EARLY — before a prior run's register (e.g. an AVNU-ambiguous relay that
  // landed on-chain but reported an error) has REFLECTED — so it reads `false`, leaves the
  // register fold ON, and the deposit's atomic apply_actions folds a SECOND register() →
  // the pool's write-once viewing-key slot reverts NON_ZERO_VALUE (whole deposit rolls
  // back). The later manual Continue read isRegistered fresh (registered) and passed
  // autoRegister:false, so it succeeded — the auto-vs-manual asymmetry the trace showed.
  // Fix: re-read isRegistered LIVE right before the deposit; a fresher read showing the
  // account registered drops the fold. RED pre-fix (autoRegister:true from the stale
  // register-step read); GREEN after (autoRegister:false).
  it('AUTO-continue re-deposit: re-reads isRegistered LIVE before the deposit → autoRegister:false (no second register fold)', async () => {
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    // Register-step read is a STALE false (the prior register has not reflected yet) → a
    // fresh paymaster account defers; the LIVE pre-deposit re-read then sees it registered.
    mIsRegistered.mockResolvedValueOnce(false).mockResolvedValue(true);
    mReadPending.mockReturnValue(null);
    mFundMM.mockResolvedValue(AMOUNT);

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
      resume: true, // the auto-continue path
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    // No second register folded in → the #305 NON_ZERO_VALUE revert can't recur.
    expect(mDeposit.mock.calls[0][0].autoRegister).toBe(false);
  });

  it('passes autoRegister:false after a MANAGER-path registration completes this run (avoids a wasted collide+recover)', async () => {
    // Non-paymaster (manager) path: registerWithPool truly registers a fresh account, so the
    // deposit can skip the register fold. (Leaving it true would still self-heal via the
    // tracked-terminal deposit-only recovery, but skipping the fold avoids the round-trip.)
    configMock.paymaster = undefined;
    mIsDeployed.mockResolvedValue(true); // already on L2 → deploy skipped
    mIsRegistered.mockResolvedValue(false); // fresh → registerWithPool actually registers

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    expect(mRegister).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].autoRegister).toBe(false);
  });
});

describe('moveIntoPool — deposit proving anchor (paymaster deposit-aging)', () => {
  // The deposit step must thread the freshest COMMITTED dependency block into
  // depositToPool as its proving anchor: on the paymaster path the deposit has no
  // approve tx to seed the proving-block wait, so without this it proves at latest-8
  // with NO aging and reverts on-chain when the deploy/funding is still fresh. These
  // assert the anchor picks the right dependency in each branch (deployBlock=50,
  // post-funding head = getCurrentBlock mock = 100).
  it('anchors on the POST-funding head when the deposit step funds (fresher than the deploy)', async () => {
    // Fresh deploy at block 50; the deposit step funds (treasury) — the funding tx is
    // the fresher committed dependency, so the anchor is the head (100), not 50.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    mEnsureDeployed.mockResolvedValue(50);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBe(100);
  });

  it('anchors on the deploy block when funding happened in the deploy step (deploy-fee ON)', async () => {
    // Deploy-fee ON funds BEFORE the deploy, so the deposit step doesn't re-fund/re-
    // anchor — the deploy block (50) is the freshest committed dependency.
    configMock.deployFeeMode = 'default';
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mEnsureDeployed.mockResolvedValue(50);
    mFundMM.mockResolvedValue(AMOUNT);
    mReadBalance.mockResolvedValue(900_000n); // post-deploy balance (deposit − fee)

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBe(50);
  });

  it('keeps the funding anchor on a transient deposit RETRY (does not reset to the stale deploy block)', async () => {
    // Bugbot MEDIUM: the funding anchor lived in a per-attempt local, so a transient
    // retry (funding branch skipped, `funded` already true) reset it to the older
    // deployBlock (50) — letting the deposit prove with no aging past the funding again
    // and reproducing the on-chain revert. Fresh deploy at 50; the deposit step funds
    // (head=100); the first deposit throws transient, the retry must STILL anchor on 100.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    mEnsureDeployed.mockResolvedValue(50);
    mDeposit
      .mockRejectedValueOnce(new Error('submitAndTrack: timed out after 120000ms for 0xabc'))
      .mockResolvedValue(undefined);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    // Funding ran once (head=100); BOTH deposit attempts carry the funding anchor.
    expect(mEnsureFunded).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(2);
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBe(100);
    // RED pre-fix: the retry reset to deployBlock (50). GREEN after: still 100.
    expect(mDeposit.mock.calls[1][0].lastTxBlockNumber).toBe(100);
  });
});

describe('moveIntoPool — Part A immediate-prove gate', () => {
  // The deposit proof is money-INDEPENDENT, so when the deploy + register dependencies
  // were ALREADY buried (committed before this run) AND the amount is known a-priori
  // (net = gross − maxFee, NOT read from a post-mint balance), there is nothing fresh to
  // age past → moveIntoPool passes immediateProve:true + lastTxBlockNumber:undefined so
  // depositToPool proves NOW at the safe IMMEDIATE depth (deposit.ts / proving.ts own the
  // actual depth resolution). These assert the GATE decision in each branch.
  it('deployed + registered + a-priori (deploy-fee OFF) → immediateProve:true, undefined anchor', async () => {
    // Already deployed AND registered at start; treasury a-priori amount, no cursor.
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].immediateProve).toBe(true);
    // Prove-early passes an undefined anchor (nothing to age past).
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBeUndefined();
  });

  it('FRESH account (deployed + registered THIS run) → immediateProve:false, ages on the funding head', async () => {
    // Undeployed + unregistered at start → both are FRESH dependencies this run.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    mEnsureDeployed.mockResolvedValue(50);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].immediateProve).toBe(false);
    // Funding head (getCurrentBlock mock = 100) is the freshest committed dependency.
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBe(100);
  });

  it('balance-sized (user-paid deploy fee) → immediateProve:false even when already deployed+registered', async () => {
    // A user-paid deploy fee means the deposit amount is read from the POST-mint balance,
    // NOT a-priori → the funding-reflection wait can't be skipped → gate OFF.
    configMock.deployFeeMode = 'default';
    configMock.paymaster = { feeMode: 'sponsored' };
    mIsDeployed.mockResolvedValue(true); // already deployed at start
    mIsRegistered.mockResolvedValue(true); // already registered at start
    mReadBalance.mockResolvedValue(900_000n); // post-deploy live balance (balance-sized)

    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].immediateProve).toBe(false);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(900_000n);
  });

  it('RESUME recomputes the gate LIVE — a run that finds deployed+registered picks immediateProve:true (no stale flag)', async () => {
    // Invocation 1: a FRESH account (deploys + registers this run) → immediateProve:false.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValueOnce(false).mockResolvedValue(true);
    mEnsureDeployed.mockResolvedValue(50);
    mReadPending.mockReturnValue(null);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });
    expect(mDeposit.mock.calls[0][0].immediateProve).toBe(false);

    // Invocation 2 (simulated resume, e.g. after a reload): the SAME account now reads
    // deployed + registered LIVE. The gate is recomputed from chain, NOT a persisted false
    // from run 1 → immediateProve flips to true (mirrors #305 recompute-on-resume).
    vi.clearAllMocks();
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue(null);

    await moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: AMOUNT });

    expect(mDeposit).toHaveBeenCalledTimes(1);
    expect(mDeposit.mock.calls[0][0].immediateProve).toBe(true);
    expect(mDeposit.mock.calls[0][0].lastTxBlockNumber).toBeUndefined();
    // Deploy + register skipped on the resume (idempotent), proving the gate read live state.
    expect(mEnsureDeployed).not.toHaveBeenCalled();
    expect(mRegister).not.toHaveBeenCalled();
  });
});

describe('moveIntoPool — retry + net math + secret hygiene', () => {
  it('a transient deposit error retries WITHOUT re-funding, then succeeds', async () => {
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mDeposit
      .mockRejectedValueOnce(new Error('submitAndTrack: timed out after 120000ms for 0xabc'))
      .mockResolvedValue(undefined);

    const { depositedNetWei } = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
    });

    // Funding ran ONCE despite the deposit retry (the `funded` guard survives attempts).
    expect(mEnsureFunded).toHaveBeenCalledTimes(1);
    expect(mDeposit).toHaveBeenCalledTimes(2);
    expect(depositedNetWei).toBe(AMOUNT);
  });

  it('a terminal deposit error fires onStep(deposit,error), rejects, and does NOT retry', async () => {
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mDeposit.mockRejectedValue(new Error('submitAndTrack: 0xdef REVERTED: insufficient balance'));

    const rec = stepRecorder();
    await expect(
      moveIntoPool({
        signature: SIGNATURE,
        funding: 'treasury',
        amountWei: AMOUNT,
        onStep: rec.onStep,
      }),
    ).rejects.toThrow(/REVERTED/);

    expect(mDeposit).toHaveBeenCalledTimes(1); // terminal → no retry
    expect(rec.statusesFor('deposit')).toContain('error');
  });

  it('TREASURY net = gross; METAMASK net = what the CCTP funder landed (gross − fee)', async () => {
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);

    // Treasury: no fee, full gross deposited.
    const treasury = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
    });
    expect(treasury.depositedNetWei).toBe(AMOUNT);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(AMOUNT);
    expect(mFundMM).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mDeposit.mockResolvedValue(undefined);
    // Metamask Fast: the Forwarding Service deducts a 20k fee, so 0.98 USDC lands.
    const NET = AMOUNT - 20_000n;
    mFundMM.mockResolvedValue(NET);

    const metamask = await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });
    expect(metamask.depositedNetWei).toBe(NET);
    expect(mDeposit.mock.calls[0][0].amountWei).toBe(NET);
    expect(mEnsureFunded).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount before touching any chain step', async () => {
    await expect(
      moveIntoPool({ signature: SIGNATURE, funding: 'treasury', amountWei: 0n }),
    ).rejects.toThrow(/greater than zero/i);
    expect(mIsDeployed).not.toHaveBeenCalled();
    expect(mDeposit).not.toHaveBeenCalled();
  });

  it('never logs or persists the signature / private key / viewing key (spyOnSecretSinks)', async () => {
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'metamask',
      amountWei: AMOUNT,
      provider: fakeProvider(),
    });
    // Explicit here (afterEach also asserts): the full deploy→register→deposit run
    // captured zero secret material in any sink.
    sinks.assertNeverLeaked(SIGNATURE, MOCK_PRIV, MOCK_VK.toString());
  });
});

describe('moveIntoPool — tx hash threading (block-explorer links)', () => {
  it('carries each submitting leg\'s tx hash on its done event (deploy/register/deposit)', async () => {
    // Fresh, undeployed, unregistered → all three legs submit a tx and report it.
    mIsDeployed.mockResolvedValueOnce(false).mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(false);
    mEnsureDeployed.mockImplementation(async (args) => {
      args.onTx?.('0xDEPLOYHASH');
      return 100;
    });
    mRegister.mockImplementation(async (args) => {
      args.onTx?.('0xREGISTERHASH');
    });
    mDeposit.mockImplementation(async (args) => {
      args.onTx?.('0xDEPOSITHASH');
    });

    const rec = stepRecorder();
    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      onStep: rec.onStep,
    });

    expect(rec.txFor('deploy')).toBe('0xDEPLOYHASH');
    expect(rec.txFor('register')).toBe('0xREGISTERHASH');
    expect(rec.txFor('deposit')).toBe('0xDEPOSITHASH');
  });

  it('omits the tx hash when a leg submits nothing (already deployed/registered, deposit resume)', async () => {
    // Already deployed + registered (idempotent skips), and a prior-run cursor with a
    // drained balance → the deposit resume short-circuit. No leg submits, so none reports.
    // resume:true is required to auto-consume the pending cursor — a fresh press over a
    // stale cursor now FAILS CLOSED (PENDING_POOL_DEPOSIT), so the short-circuit only
    // fires on an explicit Continue.
    mIsDeployed.mockResolvedValue(true);
    mIsRegistered.mockResolvedValue(true);
    mReadPending.mockReturnValue({ netWei: AMOUNT });
    mReadBalance.mockResolvedValue(0n);

    const rec = stepRecorder();
    await moveIntoPool({
      signature: SIGNATURE,
      funding: 'treasury',
      amountWei: AMOUNT,
      resume: true,
      onStep: rec.onStep,
    });

    // Every step still reaches 'done'…
    expect(rec.statusesFor('deploy')).toContain('done');
    expect(rec.statusesFor('register')).toContain('done');
    expect(rec.statusesFor('deposit')).toContain('done');
    // …but with no tx hash, so the UI renders no explorer link for them.
    expect(rec.txFor('deploy')).toBeUndefined();
    expect(rec.txFor('register')).toBeUndefined();
    expect(rec.txFor('deposit')).toBeUndefined();
  });
});
