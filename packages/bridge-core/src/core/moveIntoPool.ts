// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Move funds INTO the pool: sign-derived account → deploy → register → deposit,
// funded either from the dev treasury or the user's own EVM USDC (CCTP deposit-in).
// This is the composed orchestrator that replaces the
// hand-rolled sequencing in the app's IdentityContext.runMakePrivate — it owns the
// step order, the transient-vs-terminal retry, and the fund-then-deploy bookkeeping
// (frozen interface + state-transition table).
//
// Secret hygiene (Decision 5): the raw wallet `signature` is an IN-MEMORY argument;
// the SN private key + viewing key are derived internally and NEVER logged or
// persisted. Only non-secret status strings flow through `onStep`. No window /
// localStorage access here — the app owns its Step UI + persisted status mirror.

import type { Account } from 'starknet';
import type { EthereumProvider } from '../lib/ethereum';
import {
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
import { config } from './config';
import { getRpcProvider, makeAccount } from './provider';
import { getCurrentBlock } from './proving';
import { ensureAccountDeployed, isDeployedOnL2 } from './deploy';
import { isRegistered, registerWithPool } from './register';
import {
  buildDepositProofAhead,
  depositToPool,
  ensureDepositTokenFunded,
  readDepositTokenBalance,
  type PrebuiltDepositProof,
} from './deposit';
import { fundFromMetaMask, isCctpMessageNonceUsed } from './depositIn';
import type { EvmSender } from './depositIn';
import {
  clearPendingPoolDeposit,
  readPendingPoolDeposit,
  recordPendingPoolDeposit,
} from './poolDepositCursor';
import { RESIDUAL_DUST_THRESHOLD_WEI } from './residual';
import { isTransientError, markNonRetryable } from './errors';
import { humanizeFinality } from './errorMessages';
import { sanitizeErrorMessage } from './tx';

export type MoveStep = 'deploy' | 'register' | 'deposit';
export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface MoveIntoPoolArgs {
  // Raw wallet signature of the app's identity sign-message — the ONLY secret input; the SN
  // account, viewing key and private key are re-derived internally, never logged
  // or persisted.
  signature: `0x${string}`;
  // metamask ⇒ fund from the user's own EVM USDC (fundFromMetaMask / CCTP deposit-in);
  // treasury ⇒ the dev admin transfers it (ensureDepositTokenFunded).
  funding: 'metamask' | 'treasury';
  // Gross typed amount (deposit-token base units). Under metamask the CCTP forwarding
  // fee is deducted by the Forwarding Service, so what LANDS (and is deposited) is the
  // net the funder returns; under a user-paid deploy fee the deposit reads the actual
  // post-deploy balance. The returned `depositedNetWei` is what was handed to the pool.
  amountWei: bigint;
  // Connected wallet's EIP-1193 provider — REQUIRED when funding === 'metamask'
  // (used both to resolve the funder address and to sign/broadcast the burn).
  provider?: EthereumProvider;
  // Optional EIP-155 source chain for the metamask CCTP burn (threaded to fundFromMetaMask).
  sourceChainId?: number;
  // Optional atomic submitter for the metamask CCTP approve+burn (e.g. an ERC-4337
  // UserOp). Threaded to fundFromMetaMask; takes priority over the wallet's own
  // atomic-batch support and applies to a FRESH burn only.
  evmSender?: EvmSender;
  // Cross-run RESUME opt-in (C1 fail-closed). A persisted pool-deposit cursor means a
  // PRIOR run already funded this account for a deposit (funds minted to the SN account)
  // — the deposit is the only step left. `resume: true` auto-consumes that cursor (the
  // historical behavior: deposit the live balance, never re-fund). A FRESH request
  // (resume falsy) with a pending cursor FAILS CLOSED (throws PENDING_POOL_DEPOSIT) so the
  // app can offer Continue instead of silently depositing the leftover + skipping the
  // burn while ignoring the user's freshly-typed amount.
  resume?: boolean;
  // Fires (step,'running') before each leg and (step,'done'|'error') after. The app
  // maps these to its Step/StepStatus UI + localStorage status mirror (presentation).
  // `txHash` accompanies a 'done' when the leg submitted an on-chain tx (for a
  // block-explorer link); it's absent on 'running'/'error', on idempotent skips
  // (already deployed/registered, deposit resume), and on the paymaster register
  // no-op (folded into the deposit).
  onStep?: (step: MoveStep, status: StepStatus, detail?: string, txHash?: string) => void;
  // Fired AT MOST ONCE PER BURN once the metamask-funding CCTP burn is confirmed (fresh or
  // resumed), with the EVM burn tx hash + a source-chain explorer URL. The `deposit`/`deploy`
  // onStep txHash is the STARKNET-side leg only; this surfaces the EVM SOURCE leg so the app
  // can list both on the deposit receipt (mirrors the withdraw, which returns burnTxHash).
  // De-duped internally: fundFromMetaMask re-fires it on a resume of the same burn (e.g. after
  // a transient attest/mint retry), but moveIntoPool forwards only the first sighting per hash.
  // Never fires for treasury funding (no CCTP burn) or the already-funded no-op.
  onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
}

// Transparent-retry budget for a step whose submit reported a TRANSIENT error even
// though the tx may have landed (submit timeout, attestation pending). Terminal
// errors (revert / NON_ZERO_VALUE / balance / proof) fail fast, no retry.
const MAX_STEP_RETRIES = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// #432 / production first-attempt scare — bounded poll for the folded deposit's CCTP
// nonce to show CONSUMED after an ambiguous/erroring paymaster submit (the
// accepted≠reflected window). is_nonce_used is the AUTHORITATIVE, monotonic signal: on
// the atomic fold path (receive_message folded INTO the pool deposit) it flips to
// consumed ⟺ the whole mint→approve→pool pull→apply_action tx already committed. Sized
// generously over the typical few-second reflection lag; on timeout the convergence
// gives up and fails closed (never worse than the prior single read). The interval
// mirrors waitForL2Commit's L2-commit poll.
const FOLD_CONFIRM_TIMEOUT_MS = 10_000;
const FOLD_CONFIRM_POLL_MS = 2_000;

// Polls for COMMITTED (ACCEPTED_ON_L2) deployment. A self-deploy lands as
// pre-confirmed first; register/deposit prove against committed state, so the
// orchestrator waits here before continuing.
async function waitForL2Commit(address: string, onStatus: (m: string) => void): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (let waited = false; ; waited = true) {
    // isDeployedOnL2 is fail-closed: a not-yet-committed account reads as false
    // (CONTRACT_NOT_FOUND), but a TRANSIENT RPC error now RE-THROWS rather than
    // being swallowed as "not deployed" (so the deploy GATE can't misfire). This
    // is a BOUNDED poll, so it owns its own retry tolerance — a transient blip is
    // treated as "not visible yet" and retried until the deadline, never aborting.
    let committed = false;
    try {
      committed = await isDeployedOnL2(address);
    } catch {
      committed = false;
    }
    if (committed) return;
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the account to commit on L2.');
    }
    if (!waited) onStatus('Waiting for account to commit on L2…');
    await sleep(2500);
  }
}

// Resolves the EVM funder address from the injected provider (the connected wallet
// that burns USDC + pays gas). The frozen MoveIntoPoolArgs deliberately omits an
// explicit evmAddress — the provider is the single source of truth for the selected
// account (matches the EIP-6963-pinned provider useWallet exposes). Prefers the
// already-connected accounts (no prompt); falls back to a request if none — EXCEPT
// under resume-only, where an unattended connect popup is the same defect class as an
// unattended burn: the caller fails with "Connect a wallet…" instead.
async function resolveFunder(
  provider: EthereumProvider,
  resumeOnly: boolean,
): Promise<string | null> {
  const pick = (result: unknown): string | null =>
    Array.isArray(result) && typeof result[0] === 'string' ? result[0] : null;
  try {
    const connected = pick(await provider.request({ method: 'eth_accounts' }));
    if (connected) return connected;
  } catch {
    // fall through to an explicit request
  }
  if (resumeOnly) return null;
  try {
    return pick(await provider.request({ method: 'eth_requestAccounts' }));
  } catch {
    return null;
  }
}

interface FundDepositTokenArgs {
  funding: 'metamask' | 'treasury';
  account: Account;
  snAddress: string;
  amountWei: bigint;
  provider?: EthereumProvider;
  sourceChainId?: number;
  // REQUIRED (not optional) so the compiler forces every call site to decide: a
  // continuation must never start a burn.
  resumeOnly: boolean;
  onStatus?: (s: string) => void;
  // Forwarded to fundFromMetaMask: routes the fresh CCTP approve+burn through the
  // caller's own atomic submitter.
  evmSender?: EvmSender;
  // Forwarded to fundFromMetaMask: surface the confirmed EVM burn (hash + explorer URL).
  onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
  // PART B fold (metamask funding only): defer the Starknet mint and hand its attested
  // bytes to onMintFold so the caller folds it into the deposit tx. Ignored for
  // treasury funding (no CCTP mint to fold).
  deferMint?: boolean;
  onMintFold?: (fold: {
    message: `0x${string}`;
    attestation: `0x${string}`;
    clearMintCursor: () => void;
  }) => void;
  // Fired on RESUME when the CCTP nonce is already consumed: on a fold burn ⟺ the prior
  // atomic deposit already committed; on a standalone burn only the mint landed. The
  // deposit step converges on completion, or deposits what settled on the account.
  onMintAlreadyConsumed?: (info: { foldBurn: boolean }) => void;
}

// Funds the derived account with the pool-deposit USDC per `funding`. Returns the
// amount that actually LANDED on the SN account for depositToPool to consume:
//   - treasury → the full amount (admin transfer, no fee);
//   - metamask → amountWei − the CCTP forwarding fee (Fast) or the full amount
//     (Standard, fee 0) — whatever fundFromMetaMask reports as the net minted.
async function fundDepositToken(args: FundDepositTokenArgs): Promise<bigint> {
  if (args.funding === 'metamask') {
    if (!args.provider) {
      throw new Error('No wallet connected — cannot fund the deposit from your own USDC.');
    }
    const evmAddress = await resolveFunder(args.provider, args.resumeOnly);
    if (!evmAddress) {
      throw new Error('Connect a wallet to fund the deposit from your own USDC.');
    }
    return await fundFromMetaMask({
      evmAddress,
      snRecipient: args.snAddress,
      account: args.account,
      provider: args.provider,
      amountWei: args.amountWei,
      onStatus: args.onStatus,
      sourceChainId: args.sourceChainId,
      resumeOnly: args.resumeOnly,
      evmSender: args.evmSender,
      onBurned: args.onBurned,
      deferMint: args.deferMint,
      onMintFold: args.onMintFold,
      onMintAlreadyConsumed: args.onMintAlreadyConsumed,
    });
  }
  await ensureDepositTokenFunded({
    account: args.account,
    address: args.snAddress,
    amountWei: args.amountWei,
    onStatus: args.onStatus,
  });
  return args.amountWei;
}

// Moves `amountWei` INTO the pool from the signature-derived account, deploying +
// registering it first if needed. Resolves with the NET deposited into the pool
// (`depositedNetWei` — net of the CCTP forwarding fee and any user-paid deploy fee,
// the value handed to depositToPool) plus `deposited`: TRUE when depositToPool ran
// THIS invocation, FALSE on the resume short-circuit (a prior run's deposit already
// landed). The UI gates its success/no-op copy on `deposited`, never on a racy
// balance-delta read. The step order + fund-then-deploy invariants are the frozen
// state-transition table:
//   - deploy is funded-and-executed AT MOST ONCE per run;
//   - the deposit step reads a POST-deploy balance and never double-funds on retry
//     (an already-deployed account under a user-paid deploy fee has ALREADY spent
//     that fee — this run OR a prior/resumed one — so re-funding the gross would
//     double-burn the user's USDC; the deposit reads the live balance instead);
//   - a retry mid-deploy waits on the in-flight deploy, never re-sends it — the
//     no-second-deploy guarantee is enforced by ensureAccountDeployed's own
//     pre-confirmed idempotency check (deploy.ts), so a re-entry on a not-yet-
//     committed deploy short-circuits rather than submitting a second deploy tx.
export async function moveIntoPool(
  args: MoveIntoPoolArgs,
): Promise<{ depositedNetWei: bigint; deposited: boolean }> {
  const {
    signature,
    funding,
    amountWei,
    provider,
    sourceChainId,
    resume,
    onStep,
    onBurned,
    evmSender,
  } = args;
  if (amountWei <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  // `resume` already means "this is a continuation" (the Continue button / the
  // unattended watcher pass it; the Deposit button doesn't), so it is also the
  // never-start-a-burn signal — `resume: false, resumeOnly: true` is not expressible.
  const resumeOnly = resume === true;

  // De-dupe onBurned to at most once per burn hash (its documented once-per-burn contract).
  // fundFromMetaMask fires it on BOTH a fresh burn and a later RESUME of that same burn; a
  // transient attest/mint failure inside fundDepositToken leaves `funded` false, so runStep
  // re-enters the deposit (or deploy) body → fundFromMetaMask resume path → a SECOND onBurned
  // for the identical hash. Both fund call sites go through this wrapper so any burn surfaces
  // exactly once regardless of which step funded or how many transient retries it took.
  const seenBurns = new Set<string>();
  const onBurnedOnce = onBurned
    ? (info: { burnTxHash: string; explorerUrl?: string }) => {
        if (seenBurns.has(info.burnTxHash)) return;
        seenBurns.add(info.burnTxHash);
        onBurned(info);
      }
    : undefined;

  // Derive keys from the raw signature — IN-MEMORY ONLY, never logged/persisted.
  const privateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address, publicKey } = deriveStarknetAccount(privateKey, config.ozClassHash);

  // The one-time account-DEPLOY fee is borne by the user (paid in USDC from the
  // account inside the deploy tx) ONLY under 'default' deploy-fee mode WITH a
  // paymaster. When on, the account MUST hold USDC BEFORE the deploy, so the deploy
  // step funds first (fund-then-deploy) and the deposit step reads the post-deploy
  // balance instead of re-funding.
  const deployFeeChargedToUser = config.deployFeeMode === 'default' && !!config.paymaster;

  const emit = (step: MoveStep, status: StepStatus, detail?: string, txHash?: string): void =>
    onStep?.(step, status, detail, txHash);

  // Transparent-retry wrapper. Fires (step,'error') and rethrows on a terminal
  // failure (or after the transient budget is exhausted); the caller humanizes +
  // surfaces the thrown error and maps the fired step to its UI.
  const runStep = async (step: MoveStep, body: () => Promise<void>): Promise<void> => {
    emit(step, 'running');
    for (let attempt = 0; ; attempt++) {
      try {
        await body();
        return;
      } catch (err) {
        if (isTransientError(err) && attempt < MAX_STEP_RETRIES) {
          emit(step, 'running', `Submit hiccup — retrying (${attempt + 1}/${MAX_STEP_RETRIES})…`);
          continue;
        }
        emit(step, 'error', sanitizeErrorMessage(err));
        throw err;
      }
    }
  };

  // Shared across the deploy + deposit steps (see the fund-then-deploy table):
  //   funded          — true once the account has been funded THIS run (so a deposit-
  //                      step retry, or the deposit after a deploy-fee fund, never re-funds);
  //   fundedNetWei     — what the funder landed when the DEPOSIT step funds;
  //   depositFundingBlock — the head right after the DEPOSIT step funded (its committed
  //                      block ≤ this); the deposit's proving anchor on the paymaster
  //                      path. Hoisted here (not a deposit-step local) so it SURVIVES a
  //                      transient deposit retry: on retry the funding branch is skipped
  //                      (`funded` already true), so a per-attempt local would reset to
  //                      the older/undefined deployBlock and let the deposit prove with
  //                      no aging again — reproducing the on-chain revert (Bugbot MEDIUM).
  //   deployBlock      — the deploy tx block, seeds register's proving-block wait;
  //   accountDeployed  — true once the account is known to be on L2 — whether it was
  //                      ALREADY deployed (this run OR a prior/resumed run) or we
  //                      deployed it now. Under a user-paid deploy fee it means the
  //                      deposit step re-reads the live post-deploy balance (fundedNetWei
  //                      recomputed from chain, never reused). It does NOT by itself
  //                      imply "resume": an already-deployed account with a DRAINED
  //                      balance and no pending cursor is a FRESH deposit that MUST
  //                      re-fund — deployment status alone must never skip funding
  //                      (Bugbot MEDIUM). The resume-vs-fresh split is the live balance
  //                      + the pool-deposit cursor, never the deploy status alone.
  let funded = false;
  let fundedNetWei: bigint | undefined;
  // Fold state, HOISTED to the same scope as `funded` so it survives a TRANSIENT retry
  // of the deposit step (Bugbot MEDIUM "Fold lost on deposit retry"). `funded` is hoisted,
  // so a transient error in the deposit body AFTER funding deferred the mint (e.g. a
  // getCurrentBlock RPC hiccup before the depositToPool try/catch) re-runs the body WITHOUT
  // re-funding — a body-LOCAL mintFold/mintAlreadyConsumed would be lost, and depositToPool
  // would run without foldMint even though the USDC was never standalone-minted (the mint
  // rides inside the fold). Paired with `funded` they stay consistent across retries;
  // re-initialized per moveIntoPool invocation, so a genuine cross-run resume starts fresh
  // (never a stale PERSISTED flag). Only the funding branch (guarded by !haveFundsAvailable,
  // which is false once funded) writes them, so they're set at most once per invocation.
  // Captured when fundDepositToken defers the mint (fold path); undefined when nothing was
  // folded (ineligible, treasury, or the resume/already-funded no-op) → normal deposit.
  let mintFold:
    | { message: `0x${string}`; attestation: `0x${string}`; clearMintCursor: () => void }
    | undefined;
  // Set when fundFromMetaMask's resume detects the CCTP nonce already consumed. Drives
  // the completion convergence below (no re-fold; balance cross-check); `…WasFold` carries
  // the resumed burn's shape, which decides how much confirmation that check needs.
  let mintAlreadyConsumed = false;
  let consumedBurnWasFold = false;
  let depositFundingBlock: number | undefined;
  let deployBlock: number | undefined;
  let accountDeployed = false;
  // True once the account's viewing key is KNOWN to be on-chain by the time the
  // deposit runs — either it was ALREADY registered (isRegistered), or a non-paymaster
  // registerWithPool actually registered it THIS run. Gates the deposit's `autoRegister`
  // (see the deposit step): an already-registered account MUST deposit with
  // autoRegister:false, because folding a second register() into the deposit's atomic
  // apply_actions hits the pool's write-once viewing-key slot → NON_ZERO_VALUE reverts the
  // WHOLE multicall (deposit never commits), and on the AVNU paymaster path that lands in
  // the AMBIGUOUS already-registered fail-closed branch (#305). It stays FALSE for a fresh
  // account on the paymaster path — there registerWithPool is a deliberate no-op that
  // DEFERS registration to the deposit's autoRegister, so the deposit MUST keep it true.
  let alreadyRegistered = false;
  // PART A immediate-prove gate inputs — the deploy/register dependencies were ALREADY
  // BURIED (committed in a PRIOR run) at this run's start, distinct from `accountDeployed`/
  // `alreadyRegistered` which are ALSO true when we deploy/register THIS run (a FRESH
  // dependency the proof must age past). Set ONLY on the idempotent-skip branches below
  // (isDeployedOnL2 / isRegistered were already true). Recomputed LIVE every run — the
  // deploy/register steps always re-read chain — so a resume never trusts a stale flag
  // (#305 recompute-on-resume). When both hold AND the amount is a-priori, the deposit's
  // money-INDEPENDENT proof has no fresh on-chain dependency → prove immediately.
  let deployedAtStart = false;
  let registeredAtStart = false;

  // 1. Deploy — skip if already on L2 (idempotent). Under a user-paid deploy fee,
  //    fund the account FIRST so it can pay the fee from its own USDC inside the
  //    deploy tx; mark `funded` so the deposit step doesn't double-fund.
  await runStep('deploy', async () => {
    if (await isDeployedOnL2(address)) {
      // Already on L2 (this run OR a prior/resumed run). Record it so the deposit
      // step reads the POST-deploy balance under a user-paid deploy fee and never
      // re-funds — an already-deployed account has ALREADY spent the deploy fee, so
      // re-funding the gross would double-burn on a cross-run resume (frozen Row 3).
      accountDeployed = true;
      // The deploy dependency is BURIED (committed before this run) → a Part-A input.
      deployedAtStart = true;
      emit('deploy', 'done', 'Account already deployed.');
      return;
    }
    if (deployFeeChargedToUser && !funded) {
      emit('deploy', 'running', 'Funding account…');
      fundedNetWei = await fundDepositToken({
        funding,
        account: makeAccount(address, privateKey),
        snAddress: address,
        amountWei,
        provider,
        sourceChainId,
        resumeOnly,
        evmSender,
        onBurned: onBurnedOnce,
        onStatus: (m) => emit('deploy', 'running', m),
      });
      funded = true;
    }
    emit('deploy', 'running', 'Preparing deployment…');
    let deployTxHash: string | undefined;
    deployBlock = await ensureAccountDeployed({
      address,
      publicKey,
      privateKey,
      onTx: (hash) => {
        deployTxHash = hash;
      },
      onStatus: ({ phase, finality }) => {
        const detail = finality ? ` (${humanizeFinality(finality)})` : '';
        emit('deploy', 'running', `${phase}${detail}…`);
      },
    });
    await waitForL2Commit(address, (m) => emit('deploy', 'running', m));
    // The deploy tracks to PRE_CONFIRMED so its own block is usually unknown; fall
    // back to the block at which it committed on L2 (seeds register's proof age).
    if (deployBlock === undefined) {
      deployBlock = await getCurrentBlock(getRpcProvider());
    }
    accountDeployed = true;
    emit('deploy', 'done', 'Account deployed.', deployTxHash);
  });

  // 2. Register — skip if the pool already holds the viewing key (write-once; a
  //    re-register reverts NON_ZERO_VALUE). Re-checked per attempt so a transient
  //    retry after the tx actually landed short-circuits instead of re-submitting.
  await runStep('register', async () => {
    if (await isRegistered(address)) {
      // Already on-chain (this run OR a prior/resumed run) → the deposit must NOT fold a
      // second register() into its apply_actions (write-once slot → NON_ZERO_VALUE #305).
      alreadyRegistered = true;
      // The register dependency is BURIED (committed before this run) → a Part-A input.
      registeredAtStart = true;
      emit('register', 'done', 'Already registered.');
      return;
    }
    emit('register', 'running', 'Registering with pool…');
    let registerTxHash: string | undefined;
    await registerWithPool({
      account: makeAccount(address, privateKey),
      viewingKey,
      // Seed the proving-block wait with the deploy's block so the register proof
      // ages past PROVING_BLOCK_DEPTH blocks after the deploy.
      lastTxBlockNumber: deployBlock,
      onTx: (hash) => {
        registerTxHash = hash;
      },
      onStatus: (m) => emit('register', 'running', m),
    });
    // On the MANAGER path registerWithPool truly registered the account, so the deposit
    // can skip the register fold (avoids a wasted collide+recover round-trip). On the
    // PAYMASTER path registerWithPool is a NO-OP that defers registration to the deposit's
    // autoRegister (register.ts) — registration has NOT happened yet, so leave the flag
    // FALSE and let the deposit fold it in.
    if (!config.paymaster) alreadyRegistered = true;
    emit('register', 'done', 'Registered with pool.', registerTxHash);
  });

  // 3. Deposit. On a transient retry do NOT re-fund (funding already landed) — the
  //    `funded` flag survives across attempts and carries over from the deploy step
  //    when it funded for a user-paid deploy fee.
  let depositWei: bigint | undefined;
  // TRUE only when depositToPool actually executed THIS run — the ONLY reliable
  // signal to the UI that a fresh deposit landed (vs the resume short-circuit no-op).
  // A balance-delta read races the indexer and fails open, so it must never be the
  // discriminator between "deposited" and "already-deposited" (Bugbot HIGH #239).
  let deposited = false;
  await runStep('deposit', async () => {
    const account = makeAccount(address, privateKey);
    let depositTxHash: string | undefined;

    // Cross-run resume signal (frozen Row 1 / metamask). A persisted pool-deposit cursor
    // means a PRIOR run already funded this account (funds minted to the SN account) for
    // a pool deposit — the in-memory `funded` flag does NOT survive a reload, and once
    // the prior run's depositToPool drained the balance both fundFromMetaMask's balance
    // no-op AND its pmp.inflightDeposit cursor stop guarding, so re-entering
    // fundFromMetaMask here would re-burn. The cursor + the live on-chain balance are the
    // durable signal that funding already landed. Consult it only when we did not fund
    // THIS run.
    const pending = funded ? null : readPendingPoolDeposit(address);

    // C1 FAIL-CLOSED (fresh press over a stale cursor): a pending cursor is an
    // INTERRUPTED prior deposit, not a fresh one. Auto-consume it ONLY on an explicit
    // resume — a FRESH request (resume falsy) must NOT silently deposit the drained
    // leftover + skip the burn (which would ignore the user's freshly-typed amount and
    // move the wrong value). Throw a typed PENDING_POOL_DEPOSIT (carrying the pending net
    // so the UI can offer Continue); resume === true falls through to the historical
    // resume logic below (deposit the live balance, never re-fund).
    if (pending !== null && !resume) {
      const err = new Error(
        'A previous pool deposit is still in progress — continue it before starting a new deposit.',
      ) as Error & { code: 'PENDING_POOL_DEPOSIT'; pendingNetWei: bigint };
      err.code = 'PENDING_POOL_DEPOSIT';
      err.pendingNetWei = pending.netWei;
      throw err;
    }

    // Read the live on-chain balance whenever funds MAY already sit on the account —
    // funded this run under a user-paid deploy fee (live = funded − fee), a resume
    // cursor, or an already-deployed account under a user-paid deploy fee (which may
    // still hold undeposited funds from an interrupted prior run). The live read is ALSO
    // what tells a genuine cross-run resume (funds PRESENT) from a FRESH re-deposit into
    // a DRAINED account: deployment status alone must NEVER imply "resume" (Bugbot
    // MEDIUM) — a drained already-deployed account under a deploy fee is a new deposit
    // that MUST re-fund, not a no-op 0-deposit.
    // Existing coverage: the paths where the live balance is ALREADY read (cursor, or deploy-fee +
    // deployed). They deposit a live balance without re-funding, so they cannot double-burn and need
    // no extra RPC.
    const coveredByLiveRead = pending !== null || (deployFeeChargedToUser && accountDeployed);

    // The single-tx fold (paymaster + metamask + a-priori) mints the CCTP funds INSIDE the
    // deposit tx, so a fold-eligible account never holds undeposited funds pre-deposit
    // (balance 0 in reality) and its resume is guarded by fundFromMetaMask's OWN inflight
    // burn cursor — a stray chain read here would be a pointless RPC and, worse, a residual
    // or an RPC error would derail the atomic fold + its #432 nonce-consumed convergence.
    // So skip the guard on the fold path; it targets the standalone-mint paths (manager /
    // treasury) where a prior CCTP mint CAN leave funds sitting on the SN account. `wouldFold`
    // mirrors foldEligible on the uncovered branch: liveBalance stays undefined there, so
    // aPrioriAmount reduces to `!deployFeeChargedToUser` (the immediate/fold precondition).
    const wouldFold = !!config.paymaster && funding === 'metamask' && !deployFeeChargedToUser;

    // Chain-sourced residual — the cross-browser double-burn guard. The cursor throw above only fires
    // when THIS browser holds the cursor; a fresh browser / cleared storage has none. So on the path
    // the live read does NOT cover (and it can't fold), read the SN balance directly: an undeposited
    // residual (> dust) is an interrupted prior deposit even with no cursor.
    const chainResidual =
      !coveredByLiveRead && !funded && !wouldFold ? await readDepositTokenBalance(address) : 0n;

    // C1 FAIL-CLOSED extended to a chain-detected residual (not just a cursor). A residual with no
    // cursor + resume falsy is an interrupted prior deposit; re-minting would double-burn. Fail closed
    // so the app offers Continue.
    if (chainResidual > RESIDUAL_DUST_THRESHOLD_WEI && !resume) {
      const err = new Error(
        'Undeposited funds from a previous deposit are on your account — continue that deposit before starting a new one.',
      ) as Error & { code: 'PENDING_POOL_DEPOSIT'; pendingNetWei: bigint };
      err.code = 'PENDING_POOL_DEPOSIT';
      err.pendingNetWei = chainResidual;
      throw err;
    }

    const mayHoldPriorFunds = coveredByLiveRead || (resume && chainResidual > 0n);
    const liveBalance = mayHoldPriorFunds
      ? coveredByLiveRead
        ? await readDepositTokenBalance(address)
        : chainResidual
      : undefined;

    // Resume short-circuit (Row 1 double-burn fix): a pending cursor with a DRAINED
    // balance means the prior run's depositToPool already landed — the pool holds the
    // funds. Skip a wasteful/failing 0-deposit, clear the cursor, and report the net
    // the prior run deposited.
    if (pending !== null && (liveBalance ?? 0n) <= 0n) {
      clearPendingPoolDeposit(address);
      depositWei = pending.netWei;
      emit('deposit', 'done', 'Already deposited into pool.');
      return;
    }

    // PART B — single-tx deposit fold precondition. Fold whenever on the AVNU paymaster
    // path, funding from the user's own USDC (metamask — the only path with a CCTP mint
    // to fold), AND the amount is known a-priori (net = gross − maxFee, NOT sized from a
    // post-mint/live balance). The a-priori check mirrors the immediateProve gate below
    // (`!deployFeeChargedToUser && liveBalance === undefined`) — a user-paid deploy fee or
    // a pending-cursor resume both size from chain (the mint must settle first), so they
    // CANNOT fold. Ineligible → today's proven 2-tx flow (standalone mint + separate
    // deposit). The manager path never folds (it stays 2-tx by design — a manager
    // multicall's approve would approve the MANAGER's USDC, not the account's).
    const aPrioriAmount = !deployFeeChargedToUser && liveBalance === undefined;
    const foldEligible = !!config.paymaster && funding === 'metamask' && aPrioriAmount;
    // PART A immediate-prove gate — used by BOTH the prove-ahead (below) and the inline
    // depositToPool anchor. The deposit proof is money-INDEPENDENT (the pool reads the
    // deposited amount on-chain at execution, not inside the proof), so its only on-chain
    // dependencies are the account's deploy + register. When BOTH were already BURIED before
    // this run (deployedAtStart / registeredAtStart — recomputed live by the deploy/register
    // steps, never a stale persisted flag) AND the amount is a-priori (liveBalance undefined
    // ⇒ not sized from chain; deploy-fee-OFF ⇒ the funder's reported net IS the deposit),
    // there is nothing fresh to age past → prove at the IMMEDIATE depth. Excludes a user-paid
    // deploy fee and a pending-cursor resume (both size from chain, so keep aging).
    const immediateProve = deployedAtStart && registeredAtStart && aPrioriAmount;
    // mintFold / mintAlreadyConsumed are declared in the OUTER scope (next to `funded`) so
    // they survive a transient retry of this step — see the note there. Do NOT re-declare
    // or reset them here: the funding branch below is the sole writer and only runs while
    // !haveFundsAvailable (false once funded), so a retry after a deferred mint must keep
    // the captured fold state, exactly as it keeps `funded`.

    // FUND when nothing is already available to deposit: not funded this run, no pending
    // cursor, and no live balance sitting on the account. A DRAINED already-deployed
    // account under a user-paid deploy fee lands here — a FRESH deposit that MUST
    // re-fund (the Bugbot MEDIUM: an already-deployed account is not, by itself, a
    // resume). On a transient retry the `funded` flag survives, so we never re-fund.
    // PROVE-AHEAD (fold path): a deposit proof generated CONCURRENTLY with the CCTP
    // burn+attestation, reused by depositToPool below iff it is still a faithful
    // substitute. Undefined on every other path / attempt → depositToPool proves inline.
    let prebuiltProof: PrebuiltDepositProof | undefined;
    const haveFundsAvailable = funded || (liveBalance !== undefined && liveBalance > 0n);
    if (!haveFundsAvailable) {
      emit('deposit', 'running', 'Funding deposit token…');

      // Fire the deposit proof NOW, in parallel with the burn+attestation fundDepositToken
      // is about to run. The deposit proof is money-INDEPENDENT (the pool reads the amount
      // on-chain at execution, not inside the proof) and the amount is a-priori, so it needs
      // nothing from the bridge — proving it during the (minutes-long) attestation wait
      // instead of after it removes the proof time from the critical path. The gasless AVNU
      // paymaster charges only the fixed pool fee (independent of the folded
      // receive_message), so buildDepositProofAhead quotes it from a bare
      // apply_action with no attestation dependency; depositToPool re-quotes the real fee and
      // reuses this proof only if it still matches (else rebuilds — fail-closed, never wrong,
      // at worst no speedup that once). Only on the FOLD path (paymaster + metamask + fresh
      // burn) — that is the only deposit with an attestation wait to hide behind. The anchor
      // mirrors the immediateProve / depositAnchorBlock choices below: a fresh account's only
      // prior Starknet dep is the deploy (register + mint fold INTO the deposit tx), so age
      // past deployBlock; a fully-buried account proves immediately. onStatus is intentionally
      // omitted so the bridge's attestation progress owns the status line (no interleaving).
      const proofAheadPromise: Promise<PrebuiltDepositProof | undefined> = foldEligible
        ? buildDepositProofAhead({
            account,
            viewingKey,
            amountWei,
            lastTxBlockNumber: immediateProve ? undefined : deployBlock,
            immediateProve,
            autoRegister: !alreadyRegistered,
          }).catch(() => undefined)
        : Promise.resolve(undefined);

      fundedNetWei = await fundDepositToken({
        funding,
        account,
        snAddress: address,
        amountWei,
        provider,
        sourceChainId,
        resumeOnly,
        evmSender,
        onBurned: onBurnedOnce,
        onStatus: (m) => emit('deposit', 'running', m),
        // On the fold path defer the mint: fundFromMetaMask returns the attested bytes
        // via onMintFold instead of submitting the standalone mint tx. The mint then
        // rides inside the deposit tx below.
        deferMint: foldEligible,
        onMintFold: (fold) => {
          mintFold = fold;
        },
        // FIX 1: fold-path resume where the CCTP nonce is already consumed (the prior
        // atomic fold deposit committed). fundFromMetaMask does NOT re-burn; we converge
        // on completion below via a balance cross-check instead of re-folding.
        onMintAlreadyConsumed: (info) => {
          mintAlreadyConsumed = true;
          consumedBurnWasFold = info.foldBurn;
        },
      });
      funded = true;

      // Await the concurrent proof (running/done by now) so it can never dangle, and adopt
      // it ONLY when a mint was actually folded (the proof was built for the fold's
      // autoRegister) AND the net it proved (amountWei, a-priori) still equals what we
      // deposit. A fold-resume that found the mint already consumed, or any future
      // non-a-priori net, fails this guard → depositToPool proves fresh.
      const proofAhead = await proofAheadPromise;
      if (mintFold && fundedNetWei === amountWei) prebuiltProof = proofAhead;
      // Funding just committed — it's the fresher proving dependency than the deploy.
      // Recorded in the CROSS-ATTEMPT scope so a transient deposit retry (which skips
      // this branch, `funded` already true) still ages the proof past the funding.
      depositFundingBlock = await getCurrentBlock(getRpcProvider());
      // Persist the resume cursor BEFORE depositToPool: from here the funds are on the
      // SN account and recovery must RESUME the deposit, never re-fund/re-burn.
      //
      // EXCEPT the PART B fold path (mintFold set): the CCTP mint is folded INTO the
      // deposit tx below, so the funds are NOT minted yet. The pending-pool-deposit
      // cursor's invariant is "funds ALREADY minted on the SN account, only the pool
      // deposit is pending" — recording it here would BREAK that invariant. A folded
      // deposit that REVERTS leaves the EVM funds burned-but-unminted (liveBalance 0);
      // on resume a recorded cursor + a zero balance would hit the short-circuit above
      // and FALSELY report "Already deposited into pool." while the burned funds are
      // stranded (never minted, never deposited), and clearMintCursor would never run.
      // On the fold path the durable resume signal is fundFromMetaMask's OWN inflight
      // BURN cursor (cleared via clearMintCursor only AFTER the deposit lands): a resume
      // re-enters fundFromMetaMask, which re-attests and re-folds the mint (deferMint /
      // foldEligible are recomputed live every run), ending in a real deposit or a
      // retryable error — never a false success. So record the pool-deposit cursor ONLY
      // when nothing was folded (funds are truly minted on the account).
      // FIX 1: also skip when the fold-path resume detected the mint already consumed —
      // the prior atomic deposit already moved the funds into the pool, so recording a
      // pool-deposit cursor (whose invariant is "funds minted, deposit pending") would be
      // wrong; the convergence block below finishes the operation.
      if (!mintFold && !mintAlreadyConsumed) recordPendingPoolDeposit(address, fundedNetWei);
      // A fresh fund on an already-deployed account spends no NEW deploy fee, so what
      // just landed IS the deposit amount.
      depositWei = fundedNetWei;
    } else {
      // Funds are already on the account: the live post-deploy balance (a deploy-fee
      // spend this run, or an undeposited prior/interrupted run), re-read from chain —
      // never the originally-typed gross. Fall back to fundedNetWei/amountWei only when
      // no live balance was read (a deploy-fee-OFF funded-this-run transient retry).
      depositWei = liveBalance ?? fundedNetWei ?? amountWei;
    }

    // FIX 1 — resume convergence. fundFromMetaMask fired onMintAlreadyConsumed because its
    // resume detected the CCTP nonce already used on the SN MessageTransmitterV2. On the
    // single-tx fold path the mint is folded INTO the atomic deposit tx, so a consumed
    // nonce ⟺ that whole atomic deposit already committed (receive_message + approve +
    // pool pull + apply_action succeed or revert together). Re-folding would re-submit
    // receive_message with the spent nonce → the atomic multicall reverts ("Nonce already
    // used") on every retry — the live-observed stuck resume with no Continue. A
    // resume-only continue lands here on a STANDALONE burn too (it may never re-burn), so
    // the balance cross-check below has to carry that weaker case as well:
    if (mintAlreadyConsumed) {
      // A consumed nonce proves the MINT landed; only fold ATOMICITY makes that proof of a
      // completed DEPOSIT, so a standalone burn's swept-balance check gets the bounded
      // re-poll (a mint that just landed can still read as swept, and converging then would
      // report a false success on funds resting on the account). Fold keeps its single read
      // (zero window). A residual exits at once; a read that throws never counts as swept,
      // and a window with no successful read rethrows rather than claiming completion.
      let settled: bigint | undefined;
      let lastReadErr: unknown;
      const settleDeadline = Date.now() + (consumedBurnWasFold ? 0 : FOLD_CONFIRM_TIMEOUT_MS);
      for (let firstPoll = true; ; firstPoll = false) {
        try {
          settled = await readDepositTokenBalance(address);
          if (settled > RESIDUAL_DUST_THRESHOLD_WEI) break;
          if (consumedBurnWasFold) break;
        } catch (err) {
          lastReadErr = err;
          settled = undefined;
        }
        if (Date.now() >= settleDeadline) break;
        if (firstPoll) emit('deposit', 'running', 'Confirming your deposit landed…');
        await sleep(FOLD_CONFIRM_POLL_MS);
      }
      if (settled === undefined) throw lastReadErr;
      if (settled <= RESIDUAL_DUST_THRESHOLD_WEI) {
        // Funds already pulled into the pool → COMPLETE. The inflight BURN cursor was
        // cleared inside fundFromMetaMask; drop any pool-deposit cursor too and emit the
        // normal done terminal so the UI shows completion, not a doomed retry. A fully
        // successful deposit can leave dust behind, hence the threshold over a bare 0.
        clearPendingPoolDeposit(address);
        depositWei = fundedNetWei ?? amountWei;
        emit('deposit', 'done', 'Already deposited into pool.');
        return;
      }
      // Funds still rest on the account (the standalone half-state; an atomic fold never
      // leaves them). Deposit ONLY that balance, with no receive_message re-fold (mintFold
      // stays undefined). The cursor skipped above was justified by fold atomicity, which
      // does not hold here — record it, else a depositToPool failure strands the funds
      // with no cursor at all.
      recordPendingPoolDeposit(address, settled);
      depositWei = settled;
    }

    // `immediateProve` (the PART A gate) was computed above, next to `foldEligible`, since
    // the prove-ahead needs it too.

    // BUG 3 (#305 recurring on the AUTO-continue path) — recompute `alreadyRegistered`
    // LIVE right before the fold. The register step already re-reads isRegistered, but on
    // the auto-continue path it can fire EARLY, before a prior run's register (e.g. an
    // AVNU-ambiguous relay that landed the register but reported an error) has REFLECTED —
    // so it read `false`, left autoRegister true, and the deposit folded a SECOND
    // register() into the atomic apply_actions → the pool's write-once viewing-key slot
    // reverted NON_ZERO_VALUE (the whole deposit rolled back). The manual Continue happened
    // to read isRegistered fresh (registered) and passed autoRegister:false, so it
    // succeeded — the asymmetry the trace showed (auto reverted 11:53:34, manual succeeded
    // 11:53:43). Close it by re-reading isRegistered live HERE, right before the deposit,
    // on EVERY path: if a fresher read now shows the account registered, drop the register
    // fold. Only when the register step did NOT already confirm registration (else this is
    // a redundant RPC), and never a stale persisted flag — always a live chain read.
    if (!alreadyRegistered && (await isRegistered(address))) {
      alreadyRegistered = true;
    }

    // Proving anchor for depositToPool: the freshest COMMITTED dependency the deposit
    // proof must age past. On the paymaster path the deposit has no approve tx to seed
    // the proving-block wait; without this anchor it proves at latest-8 with NO aging
    // and reverts on-chain when the deploy/funding is still within the last
    // PROVING_BLOCK_DEPTH blocks (the back-to-back make-private flow). The deposit-step
    // funding head (if this run funded here, incl. on a survived retry) is freshest;
    // else the deploy block. When immediateProve holds, pass undefined so depositToPool
    // proves NOW at the safe IMMEDIATE depth (skips aging entirely).
    const depositAnchorBlock = immediateProve ? undefined : (depositFundingBlock ?? deployBlock);

    try {
      await depositToPool({
        account,
        viewingKey,
        amountWei: depositWei,
        lastTxBlockNumber: depositAnchorBlock,
        immediateProve,
        // Fold register() into the deposit's atomic apply_actions ONLY when the account is
        // not yet registered (the paymaster fresh-account case, where registerWithPool
        // no-opped and deferred here). An already-registered account MUST pass false — a
        // second register hits the write-once slot and reverts the whole deposit (#305).
        autoRegister: !alreadyRegistered,
        // PART B: when the mint was deferred (fold path), fold receive_message into this
        // deposit's atomic paymaster tx (mint → approve → pool pull → deposit, one tx).
        // Undefined on every other path → today's separate-mint 2-tx flow. Atomic: a
        // revert moves nothing and leaves the CCTP nonce unconsumed, so the persisted
        // cursors make the retry a clean re-run (no mint-done/deposit-pending half-state).
        foldMint: mintFold
          ? { message: mintFold.message, attestation: mintFold.attestation }
          : undefined,
        // PROVE-AHEAD: the proof generated in parallel with the attestation above (fold
        // path only). depositToPool reuses it on the first attempt iff AVNU's real fee and
        // its autoRegister still match — otherwise (or on any retry) it proves fresh.
        prebuiltProof,
        onTx: (hash) => {
          depositTxHash = hash;
        },
        onStatus: (m) => emit('deposit', 'running', m),
      });
    } catch (err) {
      // FOLD-RESUME RACE / AMBIGUOUS POST-RELAY ERROR (issue #432 + a production
      // first-attempt scare) — authoritative backstop for the accepted≠reflected window the
      // pre-submit is_nonce_used probe (depositIn.ts) can't cover. That probe converges when a
      // prior fold deposit is already REFLECTED at `pre_confirmed`; in the window between a
      // prior fold's broadcast and its reflection a quick retry (or the client just receiving
      // an ambiguous post-broadcast throw, e.g. a bare AVNU code-156 dump that does NOT even
      // say "Nonce already used") can surface a scary error even though the fold actually
      // landed on-chain. is_nonce_used is the AUTHORITATIVE, MONOTONIC signal — once
      // receive_message lands it reads consumed forever, and on the atomic fold path
      // (receive_message folded INTO the pool deposit) consumed ⟺ the whole
      // mint → approve → pool pull → apply_action tx committed (they succeed or revert
      // together). So poll it for ANY paymaster error while a mint was folded into THIS tx —
      // not just the literal "Nonce already used" revert text — and converge on completion
      // instead of surfacing a scary failure + stuck retry. Gated on `mintFold` (a
      // receive_message WAS folded into this tx) so it can never fire for a non-fold deposit.
      // Emits the same done terminal as the onMintAlreadyConsumed convergence above, but —
      // UNLIKE that sibling — MUST also clear the deferred burn cursor here (it is still live;
      // the sibling's was already cleared inside fundFromMetaMask). READ-ONLY: this never
      // resubmits/re-folds/re-burns/re-proves anything — it only observes chain state.
      if (mintFold && config.paymaster) {
        const convergeDeadline = Date.now() + FOLD_CONFIRM_TIMEOUT_MS;
        for (let firstPoll = true; ; firstPoll = false) {
          // A read error counts as "not reflected yet" and is retried within the window — it
          // must NEVER escape to drive runStep's transient-retry loop (a re-fold would just
          // revert again, or worse, double-submit against an ambiguous prior state).
          let used = false;
          try {
            used = await isCctpMessageNonceUsed(mintFold.message);
          } catch {
            used = false;
          }
          if (used) {
            // The CCTP nonce is authoritative for "the mint definitively happened" — but on
            // its own it is NOT sufficient proof the funds reached the POOL: a PRIOR run could
            // have minted this same CCTP message via the STANDALONE (non-fold) path, leaving
            // the funds sitting undeposited on the account, and a later fold-eligible retry
            // would then read the nonce as used while the deposit never actually folded them
            // in. Confirm with a balance cross-check as defense-in-depth: on the pure atomic
            // fold, receive_message + pool-pull are ONE tx, so the funds never rest on the
            // account — a swept (≤ dust) balance is ALWAYS true in the good case and only
            // fails for that anomalous standalone-residual half-state. Live production shows a
            // fully-successful fold deposit still leaves ~300 base units of dust on the
            // account, so the threshold is RESIDUAL_DUST_THRESHOLD_WEI, never a bare `<= 0n`
            // (that would never converge on a dust-carrying account). A read failure is
            // "not confirmed yet" — swallow it and keep polling, never let it escape.
            let settled: bigint | undefined;
            try {
              settled = await readDepositTokenBalance(address);
            } catch {
              settled = undefined;
            }
            if (settled !== undefined && settled <= RESIDUAL_DUST_THRESHOLD_WEI) {
              // Both signals agree: the nonce is consumed AND the funds are (near-)swept →
              // the atomic fold committed. Converge exactly like the normal success path:
              // clear cursors, report the a-priori net, emit the calm completion terminal —
              // no resubmission, ever.
              mintFold.clearMintCursor();
              clearPendingPoolDeposit(address);
              depositWei = fundedNetWei ?? amountWei;
              emit('deposit', 'done', 'Already deposited into pool.');
              return;
            }
            // Nonce used but the balance hasn't confirmed swept yet (still settling, OR the
            // anomalous standalone-residual half-state, OR the read itself failed) — do NOT
            // converge. Keep polling until the deadline; never claim done on an unconfirmed
            // half-state.
          }
          if (Date.now() > convergeDeadline) break;
          if (firstPoll) emit('deposit', 'running', 'Confirming your deposit landed…');
          await sleep(FOLD_CONFIRM_POLL_MS);
        }
        // Timed out without ever observing BOTH the nonce consumed AND the balance swept: log
        // the FULL technical error for support/debugging (the user only ever sees the
        // humanized copy), then fall through to the EXISTING fail-closed paymaster rethrow
        // below — never worse than today (fail closed, funds safe, user can Continue).
        console.error(
          '[moveIntoPool] deposit fold did not confirm within window; underlying error:',
          err,
        );
      }
      // Bug-hunt E2: under an AVNU paymaster we CANNOT distinguish a pre-relay
      // throw from a post-broadcast ambiguous throw at this layer — depositToPool's
      // own `paymasterSubmissionStarted` guard rethrows the AVNU error verbatim,
      // and that message can be `fetch failed` / `HTTP 503` / `ECONNRESET` (all
      // matching TRANSIENT_RE). A retry would re-prove over DIFFERENT notes and
      // submit a SECOND `apply_actions` if the first relay actually landed →
      // double-deposit. Mark the error non-retryable so runStep's transient loop
      // fails closed — the doctrine's case (a): post-relay ambiguous → never
      // re-submit. Pre-relay throws are also caught here, but the ambiguity is
      // unresolvable from outside deposit.ts's own on-relay boundary, so the
      // safe policy under a paymaster is: never auto-retry the deposit step.
      if (config.paymaster && err instanceof Error) throw markNonRetryable(err);
      throw err;
    }
    // Deposit landed → the operation is complete; drop the resume cursor so a genuinely
    // new deposit into this account later starts fresh (the cursor is operation-scoped).
    clearPendingPoolDeposit(address);
    // PART B: the folded mint committed INSIDE the deposit tx that just landed — only now
    // is it safe to clear the in-flight CCTP burn cursor (deferred from fundFromMetaMask).
    // No-op when nothing was folded.
    mintFold?.clearMintCursor();
    deposited = true;
    emit('deposit', 'done', 'Deposited into pool.', depositTxHash);
  });

  // `deposited` is true iff depositToPool ran THIS invocation; false on the resume
  // short-circuit (a prior run's deposit already landed — depositedNetWei>0 but no
  // new deposit was made this run).
  return { depositedNetWei: depositWei ?? amountWei, deposited };
}
