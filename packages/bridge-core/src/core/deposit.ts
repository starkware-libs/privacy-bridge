// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import type { Account, Call } from 'starknet';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';
import { makePoolTransfers } from './poolClient.js';
import { config } from './config.js';
import { formatUsdcCents } from './discover.js';
import { getRpcProvider, makeAccount } from './provider.js';
import {
  READ_BLOCK,
  isRevertedOrRejected,
  isTrackedTerminalStatus,
  sanitizeErrorMessage,
  submitAndTrack,
  waitForBlockNumber,
} from './tx.js';
import { humanizeFinality } from './errorMessages.js';
import {
  submitProvenCall,
  paymasterBuildLeg,
  paymasterExecuteLeg,
  invalidateManagerNonce,
  type PaymasterBuildCtx,
  type PaymasterFeeAction,
} from './proven-submit.js';
import {
  waitForProvingBlock,
  isProofExpiredError,
  isNodeLagError,
  PROVING_BLOCK_DEPTH,
  IMMEDIATE_PROVING_BLOCK_DEPTH,
} from './proving.js';
import { submitReusingProofOnNodeLag } from './nodeLagRetry.js';
import { isAlreadyRegisteredError } from './register.js';
import { buildReceiveMessageCall } from './snMint.js';

// Deposits the configured `depositToken` into the starknet-privacy pool from a
// derived (in-browser) account. Mirrors the demo's deposit path
// (`starknet-privacy/demo/src/hooks/useTransactions.ts`): fund the account with
// the deposit token, approve the pool, then build → prove → submit a `deposit`
// action through the SDK without a paymaster (the account pays its own gas).

// Reads the deposit token's balance (u256 low/high → bigint) at the read block.
export async function getDepositTokenBalance(address: string): Promise<bigint> {
  const result = await getRpcProvider().callContract(
    {
      contractAddress: config.depositToken.address,
      entrypoint: 'balance_of',
      calldata: [address],
    },
    READ_BLOCK,
  );
  const [low, high] = result;
  if (low === undefined || high === undefined) {
    throw new Error('getDepositTokenBalance: unexpected balance_of result shape');
  }
  return BigInt(low) + (BigInt(high) << 128n);
}

// Public alias for the post-deploy balance read: when the account pays its own
// deploy fee in USDC ('default' deploy-fee mode), the deposit step must deposit the
// ACTUAL remaining balance (deposit − deploy fee), not the originally-funded amount.
export async function readDepositTokenBalance(address: string): Promise<bigint> {
  return getDepositTokenBalance(address);
}

// u256 amount → [low, high] felt calldata. Exported: bridgeOut.ts shares this
// exact implementation for its Buy-calldata u256 fields.
export function u256Calldata(amount: bigint): [string, string] {
  return [(amount & ((1n << 128n) - 1n)).toString(), (amount >> 128n).toString()];
}

export interface EnsureFundedArgs {
  account: Account;
  address: string;
  amountWei: bigint;
  onStatus?: (s: string) => void;
}

// Human-readable amount string for a raw u256 in the deposit token's decimals,
// rounded to the nearest cent (2 dp) for display (e.g. 10_000000n @ 6 dp → "10.00").
// Used ONLY for user-facing error/status text (the admin-treasury-shortfall
// message) — a balance/total, so it follows the display-to-cents rule. DISPLAY-ONLY;
// never feed the result back into parsing/math. Delegates to the shared
// formatUsdcCents (which handles the sign edge case, #160).
// Exported for testing.
export function formatDepositAmount(raw: bigint): string {
  return formatUsdcCents(raw, config.depositToken.decimals);
}

// Ensures `address` holds at least `amountWei` of the deposit token.
//
// Strategy (testnet-only — both paths use the dev admin account):
//   1. If the balance already covers it → no-op.
//   2. If the token exposes a mint entrypoint (config.depositToken.mintEntrypoint)
//      → admin mints the SHORTFALL directly to `address` (mintable test token).
//   3. Otherwise (native USDC — NOT mintable) → admin acts as the TREASURY and
//      transfers the shortfall from its own faucet-funded balance. We balance-
//      check the admin first and surface a clear, actionable error if it's low,
//      pointing at Circle's faucet.
// Funding is tracked to ACCEPTED_ON_L2 so the deposit (which proves against
// committed state) sees the new balance.
export async function ensureDepositTokenFunded(args: EnsureFundedArgs): Promise<void> {
  const { address, amountWei, onStatus } = args;
  const provider = getRpcProvider();

  onStatus?.('Checking deposit-token balance…');
  const balance = await getDepositTokenBalance(address);
  if (balance >= amountWei) return;
  const shortfall = amountWei - balance;

  const admin = config.admin;
  if (!admin?.privateKey) {
    throw new Error(
      'No admin account configured — cannot fund the deposit token on testnet ' +
        '(set ADMIN_* in dev; production must use a real on-ramp).',
    );
  }
  const adminAccount = makeAccount(admin.address, admin.privateKey, provider);

  const mintEntrypoint = config.depositToken.mintEntrypoint;
  const symbol = config.depositToken.symbol;

  // Treasury-transfer path (no mint entrypoint, e.g. native USDC): the admin can
  // only move tokens it already holds, so confirm its balance covers the
  // shortfall before attempting the transfer — otherwise the on-chain transfer
  // reverts with an opaque error. Surface a faucet-actionable message instead.
  if (!mintEntrypoint) {
    const adminBalance = await getDepositTokenBalance(admin.address);
    if (adminBalance < shortfall) {
      throw new Error(
        `Admin treasury is low on ${symbol} ` +
          `(has ${formatDepositAmount(adminBalance)}, needs ${formatDepositAmount(shortfall)}) — ` +
          `top it up at https://faucet.circle.com (Starknet Sepolia) for admin ${admin.address}.`,
      );
    }
  }

  const fundingCall: Call = mintEntrypoint
    ? {
        // mint(recipient, amount: u256) — admin is the permissioned minter on a
        // mintable test token.
        contractAddress: config.depositToken.address,
        entrypoint: mintEntrypoint,
        calldata: [address, ...u256Calldata(shortfall)],
      }
    : {
        // transfer(recipient, amount: u256) from the admin treasury's balance.
        contractAddress: config.depositToken.address,
        entrypoint: 'transfer',
        calldata: [address, ...u256Calldata(shortfall)],
      };

  onStatus?.(mintEntrypoint ? 'Minting deposit token…' : 'Transferring deposit token…');
  await submitAndTrack(provider, () => adminAccount.execute(fundingCall, { tip: 0n }), {
    until: 'ACCEPTED_ON_L2',
    onStatus: ({ finality }) =>
      onStatus?.(
        `${mintEntrypoint ? 'Minting' : 'Transferring'} deposit token (${humanizeFinality(finality)})…`,
      ),
  });
  // #103: this direct adminAccount.execute is invisible to proven-submit.ts's shared
  // localNonce (it never goes through managerExecute) — if adminAccount shares the
  // manager's on-chain address, the next managerExecute would read a stale local
  // counter and collide (code-52) before recovering in-call. Invalidate so the next
  // managerExecute re-seeds from a settled chain read instead of trusting a stale value.
  invalidateManagerNonce();
}

export interface DepositArgs {
  account: Account;
  viewingKey: bigint;
  amountWei: bigint;
  // Block of the freshest COMMITTED dependency (the deploy, or the funding tx when
  // funded just before the deposit) that the deposit proof must age past. Used ONLY
  // on the paymaster path, which has no approve tx of its own to seed the proving-
  // block wait (the manager path derives the anchor from its approve tx). Undefined
  // for a standalone deposit into an already-aged account (prove at latest-8 now).
  lastTxBlockNumber?: number;
  // PART A — prove IMMEDIATELY (skip the aging wait) at the deeper IMMEDIATE depth.
  // Set ONLY when the caller has verified (live, this run) that BOTH the deploy and
  // register dependencies are already BURIED (committed in a PRIOR run) AND the deposit
  // amount is known a-priori (net = gross − maxFee, NOT read from a post-mint balance) —
  // so the money-INDEPENDENT deposit proof has no fresh on-chain dependency to age past
  // and the funding-reflection wait is unnecessary. Overrides lastTxBlockNumber to
  // undefined on the paymaster path (there is nothing to age against). Ignored on the
  // manager path — that path's own approve tx IS a fresh proof dependency (#105), so it
  // always ages on the approve at the normal depth.
  immediateProve?: boolean;
  onStatus?: (s: string) => void;
  // Fires with the deposit tx hash once it lands (for a block-explorer link). On
  // the paymaster path this is the AVNU-relayed invoke_and_apply_action; on the
  // manager path the proven apply_actions submit.
  onTx?: (hash: string) => void;
  // Fold register() into this deposit's apply_actions (default true — the common
  // case for a fresh account). A retry after a partially-committed autoRegister
  // deposit (the account IS already registered, so a second autoRegister:true
  // deposit fails) must set this false — the escape hatch the error messages
  // below promise but, pre-fix, had no actual parameter to reach (#95).
  autoRegister?: boolean;
  // PART B (single-tx deposit-in): when set, the CCTP mint is FOLDED into this
  // deposit's atomic paymaster invoke — `receive_message(message, attestation)` runs
  // at index 0 of the invoke `calls` array (before the `approve`), so the relayed tx
  // mints the USDC to the account → approves the pool → pool pulls → deposits, all in
  // ONE Starknet tx. Set ONLY on the AVNU paymaster path when the amount is a-priori
  // (the caller knows the net BEFORE the mint settles); the standalone submitStarknetMint
  // tx is then SKIPPED (moveIntoPool). Ignored on the manager path — a manager multicall
  // runs as the MANAGER, whose `approve` would approve the manager's USDC, not the
  // derived account's, so the manager path CANNOT fold (it stays 2-tx; plan edge-case #6).
  foldMint?: { message: `0x${string}`; attestation: `0x${string}` };
  // PROVE-AHEAD (paymaster path): a deposit proof built CONCURRENTLY with the CCTP
  // burn+attestation (moveIntoPool), via buildDepositProofAhead. The deposit proof is
  // money-INDEPENDENT and the amount is a-priori, so it needs nothing from the bridge —
  // it can be generated during the (minutes-long) attestation wait instead of after it.
  // On the FIRST submit attempt, if AVNU's real invoke_and_apply_action fee equals the
  // fee baked into this proof AND its autoRegister matches, the ready proof is submitted
  // as-is (the speedup). Any mismatch, or any retry/rebuild, falls back to building fresh
  // — so this is fail-closed: never wrong, at worst no speedup that once. Ignored on the
  // manager path and whenever undefined.
  prebuiltProof?: PrebuiltDepositProof;
  // GENERIC pre-call fold (single-tx deposit, paymaster path). Arbitrary calls prepended
  // at the FRONT of this deposit's atomic AVNU invoke `calls` array — BEFORE the folded
  // `receive_message` (if any) and the `approve` — so they execute FIRST, in the same
  // Starknet tx that pulls + deposits. The motivating use is folding a funding call whose
  // effect the deposit consumes (e.g. a GrantRegistry `claim` that credits the deposit
  // token to the account: claim → approve → pool pull → apply_action, one tx), replacing a
  // separate funding tx + its landing/aging wait. Money-safe by construction: the whole
  // invoke is atomic, so a revert moves nothing, and the folded calls are validated by the
  // #77 anti-substitution guard (they ride inside `userCalls`, which is compared index-by-
  // index against AVNU's echo). The deposit PROOF is unaffected — foldCalls are invoke user
  // calls, not part of the apply_actions proof — so a prebuiltProof stays reusable. The
  // caller owns the folded call's own idempotency (e.g. the claim's once-per-wallet slot
  // guard) since a post-relay-ambiguous retry re-includes them. Ignored on the manager path
  // (a manager multicall runs as the MANAGER, not the derived account) and when empty.
  foldCalls?: Call[];
}

// A deposit apply_actions proof produced by buildDepositProofAhead WITHOUT submitting —
// carried into depositToPool via DepositArgs.prebuiltProof so the submit can reuse it
// (see the prebuiltProof doc above).
export interface PrebuiltDepositProof {
  call: Call;
  proofDetails:
    | { proof: string; proofFacts: string[] }
    | { proof?: undefined; proofFacts?: undefined };
  // Pool-fee amount (deposit-token base units) baked into the proof's fee withdraw (0n
  // when the paymaster quoted no fee). The submit compares AVNU's real
  // invoke_and_apply_action fee against this; a mismatch discards the proof and rebuilds.
  feeAmount: bigint;
  // The autoRegister value the proof was built with — a fresh vs already-registered
  // account bakes a DIFFERENT apply_actions (register folded in or not), so the submit
  // reuses the proof only when its own autoRegister matches.
  autoRegister: boolean;
}

// Approves the pool to spend `amountWei` of the deposit token from `account`.
// Tracked to ACCEPTED_ON_L2; returns the approve tx's block (when known) to seed
// the proving-block wait. Mirrors the demo's deposit approve step.
// The deposit-token `approve` letting the pool pull `amountWei`. On the manager
// path it's executed as a standalone derived-account tx (below); on the AVNU
// private-paymaster path it rides as the invoke_and_apply_action user call.
function depositApproveCall(amountWei: bigint): Call {
  return {
    contractAddress: config.depositToken.address,
    entrypoint: 'approve',
    calldata: [config.poolAddress, ...u256Calldata(amountWei)],
  };
}

// Manager path only: execute the approve as a separate derived-account tx and
// return its block (seeds the proving-block wait).
//
// #105: submitAndTrack's blockNumber is best-effort (readBlockNumber returns
// undefined if the receipt momentarily lacks block_number even once ACCEPTED_ON_L2
// is reached). waitForProvingBlock treats an undefined lastTxBlockNumber as "no
// dependency — skip aging entirely", but THIS approve genuinely IS a dependency the
// deposit's proof must see committed. An undefined read here must not be conflated
// with "independent action" — poll the receipt briefly for a real block number
// instead of handing the ambiguous undefined upstream.
async function approvePoolSpend(
  account: Account,
  approveCall: Call,
): Promise<number> {
  const provider = getRpcProvider();
  const { transaction_hash, blockNumber } = await submitAndTrack(
    provider,
    () => account.execute(approveCall, { tip: 0n }),
    { until: 'ACCEPTED_ON_L2' },
  );
  if (blockNumber !== undefined) return blockNumber;
  // Rare: receipt was ACCEPTED_ON_L2 but the read raced its block_number field.
  // Poll briefly rather than silently falling back to "no dependency".
  return waitForBlockNumber(provider, transaction_hash);
}

// Convert an AVNU paymaster `fee_action` into the deposit-token fee withdraw to bake into
// the proof, or undefined for a zero/absent fee. Shared by the inline submit (attempt)
// and the prove-ahead path. sponsored_private pays the fee in pool_fee_token (→ the
// deposit token) so the deposit itself covers it; a fee quoted in any OTHER token (e.g.
// sponsored → STRK) can't be paid from a USDC-only account, so fail loud.
function feeWithdrawFromAction(
  feeAction: PaymasterFeeAction | undefined,
): { recipient: string; amount: bigint } | undefined {
  if (!feeAction || BigInt(feeAction.amount || '0') === 0n) return undefined;
  if (BigInt(feeAction.token) !== BigInt(config.depositToken.address)) {
    throw new Error(
      `AVNU pool fee is in ${feeAction.token}, not the deposit token ${config.depositToken.address}. ` +
        'Use AVNU_FEE_MODE=sponsored_private with the deposit token as the pool fee token.',
    );
  }
  return { recipient: feeAction.recipient, amount: BigInt(feeAction.amount) };
}

// Build the deposit apply_actions and prove it at `provingBlockId` — the pure
// proof-generation body shared by the normal submit path (proveAndSubmitDeposit's
// attempt) and the prove-ahead path (buildDepositProofAhead). NO submit, so any throw is
// pre-relay and safe to retry / fall back from. The builder mirrors the demo's deposit:
// autoRegister + autoSetup register a fresh account inline; a fee withdraw (paymaster)
// nets against the deposit (deposit to balance, no explicit recipient — an explicit
// recipient consumes the whole deposit and leaves 0 for the fee).
async function proveDepositAt(
  transfers: PrivateTransfersInterface,
  opts: {
    depositorAddress: string;
    amountWei: bigint;
    useAutoRegister: boolean;
    feeWithdraw: { recipient: string; amount: bigint } | undefined;
    provingBlockId: number | string;
    onStatus?: (s: string) => void;
  },
): Promise<{ call: Call; proofDetails: PrebuiltDepositProof['proofDetails'] }> {
  const { depositorAddress, amountWei, useAutoRegister, feeWithdraw, provingBlockId, onStatus } = opts;
  onStatus?.('Building deposit…');
  const builder = transfers
    .build({
      autoRegister: useAutoRegister,
      autoSetup: true,
      autoDiscover: { notes: 'refresh', channels: 'refresh' },
      autoSelectNotes: 'naive',
    })
    .surplusTo(depositorAddress)
    .with(config.depositToken.address, (t) => {
      if (feeWithdraw) {
        t.deposit({ amount: amountWei });
        t.withdraw({ recipient: feeWithdraw.recipient, amount: feeWithdraw.amount });
      } else {
        t.deposit({ amount: amountWei, recipient: depositorAddress });
      }
    });
  const invocation = await builder.createProofInvocation({ provingBlockId });

  onStatus?.('Generating proof (this can take a few seconds)…');
  const { callAndProof } = await transfers.executeWithInvocation(invocation, provingBlockId);

  const proofDetails: PrebuiltDepositProof['proofDetails'] = callAndProof.proof.proofFacts?.length
    ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
    : {};
  return { call: callAndProof.call as unknown as Call, proofDetails };
}

// Build + prove a deposit apply_actions WITHOUT submitting, for moveIntoPool to run
// CONCURRENTLY with the CCTP burn + attestation. The deposit proof is money-INDEPENDENT
// (the pool reads the deposited amount on-chain at execution, not inside the proof) and
// the amount is a-priori (net = gross − maxFee), so nothing here depends on the bridge —
// it can run during the minutes-long attestation wait rather than after it.
//
// The pool fee is quoted from a BARE `apply_action` (NOT invoke_and_apply_action): the
// gasless AVNU paymaster charges only the fixed pool fee (`sponsored_private`
// sponsors gas, the fee is a server-fixed pool_fee_amount oracle-converted to the
// pool_fee_token), which does NOT depend on the folded `receive_message`.
// So no attestation is needed to learn the fee. The submit (depositToPool) re-quotes the
// REAL invoke_and_apply_action fee and only reuses this proof when they match — a drift
// (e.g. an oracle price move between quotes) discards it and rebuilds. Paymaster path only.
export async function buildDepositProofAhead(args: {
  account: Account;
  viewingKey: bigint;
  amountWei: bigint;
  // Freshest committed dependency the proof must age past (the deploy block on a fresh
  // account — register + mint are folded INTO the deposit tx, so they are NOT prior deps).
  // Ignored when immediateProve is set.
  lastTxBlockNumber?: number;
  // Prove NOW at the deeper IMMEDIATE depth (deploy + register already buried, amount
  // a-priori) — mirrors depositToPool's PART A.
  immediateProve?: boolean;
  autoRegister?: boolean;
  onStatus?: (s: string) => void;
}): Promise<PrebuiltDepositProof> {
  const {
    account,
    viewingKey,
    amountWei,
    lastTxBlockNumber,
    immediateProve = false,
    autoRegister = true,
    onStatus,
  } = args;
  if (!config.paymaster) {
    // The manager path has no AVNU fee and never folds a mint (it stays 2-tx), so there
    // is no attestation-blocked proof to hoist — the prove-ahead optimization is paymaster-only.
    throw new Error('buildDepositProofAhead is only valid on the AVNU paymaster path.');
  }
  const provider = getRpcProvider();

  // BARE apply_action fee quote — no receive_message ⇒ no attestation dependency.
  onStatus?.('Requesting pool fee from paymaster…');
  const feeCtx = await paymasterBuildLeg(account, { type: 'apply_action' });
  const feeWithdraw = feeWithdrawFromAction(feeCtx.feeAction);

  const provingDepth = immediateProve ? IMMEDIATE_PROVING_BLOCK_DEPTH : PROVING_BLOCK_DEPTH;
  const anchor = immediateProve ? undefined : lastTxBlockNumber;
  onStatus?.('Selecting proving block…');
  const provingBlockId = await waitForProvingBlock(provider, anchor, onStatus, provingDepth);

  const transfers = makePoolTransfers(account, viewingKey);

  const { call, proofDetails } = await proveDepositAt(transfers, {
    depositorAddress: account.address,
    amountWei,
    useAutoRegister: autoRegister,
    feeWithdraw,
    provingBlockId,
    onStatus,
  });
  return { call, proofDetails, feeAmount: feeWithdraw?.amount ?? 0n, autoRegister };
}

// Deposits `amountWei` of the deposit token into the privacy pool.
//
// Wiring mirrors register.ts (same provingProvider {url, chainId} + indexer
// discovery). The build options mirror the demo's deposit: autoRegister +
// autoSetup so a fresh account is registered/has its channel opened inline, and
// autoDiscover/autoSelectNotes so existing notes are folded in. Surplus (if the
// selected notes overpay) returns to the depositor.
export async function depositToPool(args: DepositArgs): Promise<void> {
  const {
    account,
    viewingKey,
    amountWei,
    lastTxBlockNumber: provingAnchor,
    immediateProve = false,
    onStatus,
    onTx,
    autoRegister = true,
    foldMint,
    prebuiltProof,
    foldCalls,
  } = args;
  const provider = getRpcProvider();
  const depositorAddress = account.address;

  // foldCalls ride the AVNU invoke `userCalls`, which the manager path never builds (it
  // submits a bare apply_actions). Silently dropping them would run the deposit WITHOUT
  // its folded funding call → the pool pull reverts (or worse, moves the wrong funds), so
  // fail CLOSED rather than drop them. Mirrors buildDepositProofAhead's paymaster-only guard.
  if (foldCalls?.length && !config.paymaster) {
    throw new Error('depositToPool foldCalls require the AVNU paymaster path.');
  }

  const approveCall = depositApproveCall(amountWei);
  let lastTxBlockNumber: number | undefined;
  // Proving depth: the normal PROVING_BLOCK_DEPTH (aging path — blocks pass during the
  // wait so the base is >=10 deep by execution), or the deeper IMMEDIATE depth on the
  // prove-early path (no aging wait → the base must be pre-aged past the sequencer's
  // ~10-block get_block_hash floor).
  let provingDepth = PROVING_BLOCK_DEPTH;
  if (config.paymaster) {
    // AVNU private-paymaster path: the USDC approve rides as the
    // invoke_and_apply_action user call (signed via SNIP-9, submitted by AVNU's
    // relayer) — NOT a separate derived-account tx, so the account needs no STRK
    // and is never the on-chain sender. No approve tx to seed the proving block,
    // so anchor the proof on the caller's freshest committed dependency (the
    // deploy/funding) instead — otherwise the deposit proves at latest-8 with no
    // aging and reverts on-chain when that dependency is still within the last
    // PROVING_BLOCK_DEPTH blocks (the back-to-back make-private flow).
    onStatus?.('Preparing deposit…');
    if (immediateProve) {
      // PART A: deploy + register are already buried and the amount is a-priori, so
      // there is nothing to age against — prove NOW at the deeper IMMEDIATE depth.
      lastTxBlockNumber = undefined;
      provingDepth = IMMEDIATE_PROVING_BLOCK_DEPTH;
    } else {
      lastTxBlockNumber = provingAnchor;
    }
  } else {
    onStatus?.('Approving pool to spend deposit token…');
    lastTxBlockNumber = await approvePoolSpend(account, approveCall);
  }

  const transfers = makePoolTransfers(account, viewingKey);

  await proveAndSubmitDeposit(
    transfers,
    account,
    provider,
    depositorAddress,
    amountWei,
    approveCall,
    lastTxBlockNumber,
    onStatus,
    autoRegister,
    onTx,
    provingDepth,
    foldMint,
    prebuiltProof,
    foldCalls,
  );

  onStatus?.('Deposited into pool.');
}

// A REVERTED/REJECTED submit is an atomic no-op (the register+deposit apply_actions
// rolled back — nothing committed), so it is safely re-provable. A tracking timeout
// AFTER a landed submit is NOT (the apply_actions is in-flight). isRevertedOrRejected
// (core/tx.ts) matches submitAndTrack's literal REVERTED/REJECTED words — shared with
// bridgeOut.ts's + bridgeBack.ts's identical guards.

// Build the deposit action, prove it against a settled block, and submit. On a
// submit failure (commonly a stale cached pool nonce), invalidate the SDK's
// proof-nonce cache and rebuild/re-prove once. Mirrors register.ts's retry.
async function proveAndSubmitDeposit(
  transfers: PrivateTransfersInterface,
  account: Account,
  provider: ReturnType<typeof getRpcProvider>,
  depositorAddress: string,
  amountWei: bigint,
  approveCall: Call,
  lastTxBlockNumber: number | undefined,
  onStatus?: (s: string) => void,
  autoRegister = true,
  onTx?: (hash: string) => void,
  provingDepth: number = PROVING_BLOCK_DEPTH,
  foldMint?: { message: `0x${string}`; attestation: `0x${string}` },
  prebuiltProof?: PrebuiltDepositProof,
  foldCalls?: Call[],
): Promise<void> {
  // MUTABLE proving anchor + depth so the PART-C rebuild-on-expiry can re-pick a FRESH
  // anchor from the current head (undefined → waitForProvingBlock reads latest now) at the
  // safe IMMEDIATE depth. The same-anchor stale-nonce rebuild leaves these UNCHANGED — a
  // failed submit commits no new block, so re-waiting the aging window would stall for
  // nothing. Only a proof-FRESHNESS revert (PROOF_EXPIRED / INVALID_BASE_BLOCK_NUMBER)
  // needs a new base block; that is a DISTINCT failure from a stale proof nonce.
  let currentAnchor = lastTxBlockNumber;
  let currentDepth = provingDepth;
  // PART C bound: at most this many fresh-anchor re-proves. With the 450-block validity
  // window + a Fast-CCTP submit this essentially never fires; it exists so prove-early
  // (Part A) is provably safe against a base that aged out before the tx landed.
  const MAX_EXPIRY_REANCHORS = 2;
  // Flipped TRUE the instant the AVNU RELAY starts (paymasterExecuteLeg's
  // onRelayStart, fired AFTER signMessage, right before executeTransaction). Any
  // error from that point on is potentially ambiguous — AVNU's relayer may have
  // already queued/submitted the proven invoke, so a blind retry would request a
  // FRESH SNIP-9 signature + relay a SECOND register+deposit. Errors before the
  // relay (paymasterBuildLeg, prove, signMessage rejection) relay nothing and are
  // safe to retry.
  let paymasterSubmissionStarted = false;
  // Manager path: the submit tx hash, captured inside the submit callback the instant
  // submitProvenCall returns. If submitAndTrack then throws a TRACKING timeout (the
  // apply_actions already landed but pre-confirmation tracking timed out), the catch
  // below returns instead of re-proving + re-invoking apply_actions — which would
  // DOUBLE-submit the deposit. Mirrors bridgeBack.ts:proveAndSubmitClaim's hoist.
  let managerDepositTxHash = '';
  // The deposit tx hash from a submitAndTrack that FULLY resolved (landed +
  // tracked) — the only definitive-success signal, so onTx fires exactly once at
  // the end. A submitAndTrack that throws never sets this; a REVERTED/REJECTED
  // manager retry re-runs attempt() and overwrites it with the live hash.
  let submittedTxHash = '';
  // PROVE-AHEAD: the caller's prebuiltProof (built concurrently with the CCTP attestation)
  // is reusable ONLY on the FIRST attempt. Any retry/rebuild (stale-nonce, expiry re-anchor,
  // register-collision recovery, node-lag) may have invalidated the proof-nonce or aged the
  // base, so a retry always builds fresh. Gating on `firstAttempt` (not on whether the
  // prebuilt was consumed) also means an attempt-1 fee/autoRegister MISMATCH can't let a
  // later retry resurrect the now-stale prebuilt.
  let firstAttempt = true;
  const attempt = async (useAutoRegister: boolean): Promise<void> => {
    const isFirstAttempt = firstAttempt;
    firstAttempt = false;
    // PAYMASTER path: the pool fee must be baked into the proof as a withdraw to the
    // AVNU forwarder (AVNU 165 MISSING_FEE_TRANSFER_TO otherwise). So we buildTransaction
    // FIRST to learn the fee, inject the withdraw into the SAME USDC `.with()` block as
    // the deposit (so the deposit funds the fee — no separate STRK), prove, then execute.
    // autoRegister folds a fresh account's register() into this one apply_actions, so
    // register + deposit + fee ride a single AVNU-submitted tx.
    let paymasterCtx: PaymasterBuildCtx | undefined;
    let feeWithdraw: { recipient: string; amount: bigint } | undefined;
    if (config.paymaster) {
      onStatus?.('Requesting pool fee from paymaster…');
      // PART B fold: when a CCTP mint is folded in, `receive_message` MUST be index 0
      // and `approve` index 1 — invoke calls run BEFORE apply_action, so the atomic
      // ordering is mint → approve → pool pull → deposit. The #77 anti-substitution
      // guard compares this list index-by-index against AVNU's echo, so the order is
      // enforced end-to-end. The same list rides into paymasterExecuteLeg via
      // paymasterCtx.userCalls — no second edit at the execute site.
      //
      // GENERIC foldCalls ride at the FRONT — before the mint (if any) and the approve —
      // so a folded funding call (e.g. a grant `claim` that credits the deposit token)
      // executes FIRST and its effect is available to the approve + pool pull that follow,
      // all atomic. Same #77 coverage (they are part of userCalls). Ordering:
      // [...foldCalls, receive_message?, approve].
      const userCalls: Call[] = [
        ...(foldCalls ?? []),
        ...(foldMint
          ? [buildReceiveMessageCall(config, foldMint.message, foldMint.attestation)]
          : []),
        approveCall,
      ];
      paymasterCtx = await paymasterBuildLeg(account, {
        type: 'invoke_and_apply_action',
        userCalls,
      });
      feeWithdraw = feeWithdrawFromAction(paymasterCtx.feeAction);
    }

    // PROVE-AHEAD reuse: the caller may have generated this exact proof CONCURRENTLY with
    // the CCTP attestation (moveIntoPool → buildDepositProofAhead). Reuse it — skipping the
    // proving-block wait + build + prove — only on the FIRST attempt and only when it is a
    // faithful substitute for what we'd build now: AVNU's real invoke_and_apply_action fee
    // (just quoted above) equals the bare-quoted fee baked into the proof, AND its
    // autoRegister matches (a fresh vs already-registered account bakes a DIFFERENT
    // apply_actions). Any mismatch — or any retry, since only the FIRST attempt is eligible
    // — builds fresh below (fail-closed: never a wrong proof, at worst no speedup that once).
    // The proof binds TransferFromInput.from_addr to the derived account, so the DEPOSIT
    // token moves from it regardless of who submits.
    let call: Call;
    let proofDetails: PrebuiltDepositProof['proofDetails'];
    if (
      prebuiltProof &&
      isFirstAttempt &&
      prebuiltProof.autoRegister === useAutoRegister &&
      prebuiltProof.feeAmount === (feeWithdraw?.amount ?? 0n)
    ) {
      onStatus?.('Using pre-generated proof…');
      call = prebuiltProof.call;
      proofDetails = prebuiltProof.proofDetails;
    } else {
      onStatus?.('Selecting proving block…');
      const provingBlockId = await waitForProvingBlock(
        provider,
        currentAnchor,
        onStatus,
        currentDepth,
      );
      ({ call, proofDetails } = await proveDepositAt(transfers, {
        depositorAddress,
        amountWei,
        useAutoRegister,
        feeWithdraw,
        provingBlockId,
        onStatus,
      }));
    }

    onStatus?.('Submitting deposit…');
    // Retry the SAME built proof on full-node lag, no re-prove (resetRelayState clears this
    // attempt's relay/hash state between lag retries). A non-lag error rethrows into the
    // outer catch below unchanged. See nodeLagRetry.ts.
    const runSubmit = async (): Promise<void> => {
      if (paymasterCtx) {
        // AVNU's relayer submits the proven invoke_and_apply_action (the USDC approve is
        // the signed user call); the fee withdraw is already in the proof.
        const { transaction_hash } = await submitAndTrack(
          provider,
          () =>
            paymasterExecuteLeg(account, call, proofDetails, paymasterCtx, {
              // Flip only when the AVNU relay actually starts (after signMessage) — a
              // wallet-rejected SNIP-9 signature relays nothing and stays retryable.
              onRelayStart: () => {
                paymasterSubmissionStarted = true;
              },
            }),
          {
            until: 'PRE_CONFIRMED',
            onStatus: ({ finality }) => onStatus?.(`Submitting deposit (${humanizeFinality(finality)})…`),
          },
        );
        submittedTxHash = transaction_hash;
      } else {
        // Manager path: a bare apply_actions (the approve already ran above) with explicit
        // resourceBounds so the manager's execute skips the proof-less fee estimate that
        // would revert — see proven-submit.ts.
        await submitAndTrack(
          provider,
          async () => {
            const res = await submitProvenCall(provider, account, call, proofDetails, {});
            // Capture the hash the moment the submit lands so a tracking-timeout that
            // throws AFTER this does NOT re-prove + re-submit (double deposit) — see
            // the retry guard below.
            managerDepositTxHash = res.transaction_hash;
            return res;
          },
          {
            until: 'PRE_CONFIRMED',
            onStatus: ({ finality }) => onStatus?.(`Submitting deposit (${humanizeFinality(finality)})…`),
          },
        );
        submittedTxHash = managerDepositTxHash;
      }
    };
    await submitReusingProofOnNodeLag(runSubmit, {
      resetRelayState: () => {
        paymasterSubmissionStarted = false;
        managerDepositTxHash = '';
        submittedTxHash = '';
      },
      onStatus,
    });
  };

  // TRACKED-TERMINAL register collision → deposit-only recovery. `build({ autoRegister:
  // true })` bundles register+deposit into ONE atomic apply_actions. When the account
  // is ALREADY registered (e.g. a prior AMBIGUOUS AVNU relay landed the register
  // on-chain even though its JSON-RPC call reported an error — AVNU lesson), the
  // register sub-call hits the pool's write-once slot → NON_ZERO_VALUE and the WHOLE
  // multicall reverts ATOMICALLY (deposit included, NO funds moved). If that revert was
  // TRACKED to a terminal REVERTED/REJECTED (isTrackedTerminalStatus: we HAVE the tx
  // hash and observed the on-chain terminal state), it is a DEFINITIVE atomic no-op
  // (case (c)), so rebuilding the DEPOSIT ALONE — autoRegister:false, so the register
  // is NEVER re-proved/re-relayed (it is already on-chain) — is safe. One retry only.
  const recoverDepositOnly = async (): Promise<void> => {
    // The reverted tx is a confirmed no-op. Clear this attempt's relay/submission
    // state (its dead tx hash lives only inside the caught error, never persisted) so
    // the deposit-only retry classifies its OWN outcome from scratch and can never
    // resurrect the reverted tx as a live submit (AVNU lesson: clear the dead hash
    // before a retry). A further failure from attempt(false) surfaces — one retry max.
    paymasterSubmissionStarted = false;
    transfers.invalidateProofNonceCache();
    onStatus?.('Account already registered; retrying deposit only (no re-register)…');
    await attempt(false);
    // The deposit-only retry landed + tracked (attempt set submittedTxHash). Its
    // callers `return` right after us, short-circuiting the end-of-function onTx fire,
    // so surface the hash HERE — the tx-link path must see the recovered deposit too.
    if (submittedTxHash) onTx?.(submittedTxHash);
  };
  // Only auto-recover when we still had autoRegister ON (a deposit-only attempt can't
  // hit a register write-once) AND the failure is BOTH the register collision AND a
  // tracked-terminal outcome. Everything else with NON_ZERO_VALUE is AMBIGUOUS (no
  // hash / timeout / relayer-may-have-broadcast) → fail closed with the actionable msg.
  const isTerminalRegisterCollision = (e: unknown): boolean =>
    autoRegister && isAlreadyRegisteredError(e) && isTrackedTerminalStatus(e);

  // PART C — rebuild-on-EXPIRY (DISTINCT from the same-anchor stale-nonce rebuild below).
  // A proof-freshness revert (PROOF_EXPIRED / INVALID_BASE_BLOCK_NUMBER) means the proof's
  // BASE BLOCK is stale — the SAME-anchor retry would just re-expire, so re-pick a FRESH
  // anchor from the CURRENT head at the safe IMMEDIATE depth and re-prove. Gated on
  // isTrackedTerminalStatus: only a DEFINITIVE on-chain revert (an atomic no-op, value did
  // NOT move) re-anchors — an AMBIGUOUS expiry (no hash / relay-in-flight timeout) is not
  // this type, so it falls through to the paymaster fail-closed guard. Returns true when it
  // re-anchored (caller `continue`s the expiry loop); throws the original error once the
  // bounded budget is spent; returns false for any non-expiry error (normal handling).
  const reanchorForExpiry = (e: unknown, expiryAttempt: number): boolean => {
    if (!(isProofExpiredError(e) && isTrackedTerminalStatus(e))) return false;
    if (expiryAttempt >= MAX_EXPIRY_REANCHORS) throw e;
    transfers.invalidateProofNonceCache();
    // undefined anchor → waitForProvingBlock reads the CURRENT latest (a fresh base);
    // IMMEDIATE depth keeps it clear of the sequencer's ~10-block get_block_hash floor.
    currentAnchor = undefined;
    currentDepth = IMMEDIATE_PROVING_BLOCK_DEPTH;
    // The reverted tx is a confirmed atomic no-op — clear the dead relay/hash state so the
    // re-anchored submit classifies its OWN outcome and can't resurrect the dead tx.
    paymasterSubmissionStarted = false;
    managerDepositTxHash = '';
    submittedTxHash = '';
    onStatus?.('Proof expired; re-anchoring to a fresh block and re-proving…');
    return true;
  };

  for (let expiryAttempt = 0; ; expiryAttempt++) {
    try {
      await attempt(autoRegister);
    } catch (err) {
      // PART C first: a proof-freshness revert re-anchors to a fresh head, NOT the
      // same-anchor stale-nonce path below.
      if (reanchorForExpiry(err, expiryAttempt)) continue;
      if (isTerminalRegisterCollision(err)) {
        await recoverDepositOnly();
        return;
      }
      if (isAlreadyRegisteredError(err)) {
        // AMBIGUOUS already-registered (no hash / unknown status), or autoRegister was
        // already false: FAIL CLOSED. Never blind-resubmit a proven leg that might have
        // landed. Surface the actionable manual-retry message.
        throw new Error(
          'Pool register+deposit reverted: account is already registered but the deposit ' +
            'was not committed. Retry the deposit without autoRegister.',
        );
      }
      // Exhausted node-lag: propagate, never rebuild — the node is still behind, so a
      // same-anchor re-prove would just node-lag again. Before the fail-closed guard so it
      // also covers the manager path (mirrors bridgeBack).
      if (isNodeLagError(err)) throw err;
      // Paymaster path is NOT retryable once paymasterExecuteLeg has been invoked:
      // the AVNU relayer may have already queued/submitted the proven invoke, so
      // a rebuild + fresh SNIP-9 signature would relay a SECOND register+deposit
      // (silent double-submit). Rethrow verbatim and let the caller surface the
      // ambiguity — the manager-paid path keeps its in-call code-52 recovery and
      // outer retry, since rejected nonces are guaranteed reusable.
      if (paymasterSubmissionStarted) {
        throw err;
      }
      // Manager path in-flight guard (mirrors proveAndSubmitClaim): if the submit
      // already landed (hash captured) but submitAndTrack timed out TRACKING it, the
      // apply_actions IS in-flight — do NOT re-prove + re-submit (double deposit).
      // Return as success (the deposit will confirm). A REVERTED/REJECTED throw is an
      // atomic no-op (nothing committed) and stays retryable below.
      if (managerDepositTxHash && !isRevertedOrRejected(err)) {
        onTx?.(managerDepositTxHash);
        return;
      }
      transfers.invalidateProofNonceCache();
      onStatus?.(`Submit failed (${sanitizeErrorMessage(err)}); retrying…`);
      // A hash reaching here is definitively dead (REVERTED/REJECTED) — clear it so a
      // retry that fails WITHOUT its own hash can't resurrect the dead one as in-flight.
      managerDepositTxHash = '';
      // Do NOT re-anchor to head: the failed submit committed no new block, so the
      // original (already-aged) currentAnchor is still the correct proving anchor.
      // Re-waiting the full PROVING_BLOCK_DEPTH window here would needlessly stall the
      // retry (and a code-52 already recovers in-call in managerExecute).
      try {
        await attempt(autoRegister);
      } catch (retryErr) {
        // The same-anchor retry can ALSO hit an expiry (e.g. its base finally aged out) —
        // re-anchor via the outer loop rather than failing (bounded).
        if (reanchorForExpiry(retryErr, expiryAttempt)) continue;
        // The generic (manager-path) retry re-ran with the SAME autoRegister and can hit
        // the collision too — apply the same tracked-terminal deposit-only recovery.
        if (isTerminalRegisterCollision(retryErr)) {
          await recoverDepositOnly();
          return;
        }
        // Ambiguous already-registered on the retry: fail closed, same as above.
        if (isAlreadyRegisteredError(retryErr)) {
          throw new Error(
            'Pool register+deposit reverted (retry): account is already registered but ' +
              'the deposit was not committed. Retry the deposit without autoRegister.',
          );
        }
        // Same in-flight guard as the first attempt: if the RETRY's submit landed
        // (hash captured) but tracking timed out, the deposit IS in-flight — return
        // instead of letting the throw escape (a caller-level retry would double-submit).
        if (managerDepositTxHash && !isRevertedOrRejected(retryErr)) {
          onTx?.(managerDepositTxHash);
          return;
        }
        throw retryErr;
      }
    }
    // Reached only on a clean success (first attempt or retry landed + tracked). The
    // in-flight-guard returns above already fired onTx with the landed manager hash.
    if (submittedTxHash) onTx?.(submittedTxHash);
    return;
  }
}
