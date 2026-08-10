// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared prove-and-submit machinery for a proof-carrying pool `apply_actions`: pick a
// proving block, bake the AVNU pool fee into the proof, prove, submit, and recover from
// the failure modes that a from-pool action can hit. Callers supply only the token
// operations (and an optional InvokeExternal leg); everything that makes a from-pool
// action fund-safe lives here, in one implementation, so a second flow cannot re-derive
// it slightly differently.
//
// Callers: bridgeOut (withdraw + CCTP burn), withdrawToStarknet (withdraw to a Starknet
// address), sendPrivateToStarknet (in-pool transfer).

import type { Account, Call, CallDetails, RpcProvider } from 'starknet';
import type {
  InvokeCalldataBuilderArgs,
  PrivateTransfersInterface,
  TokenOperationsBuilder,
} from '@starkware-libs/starknet-privacy-sdk';
import { config } from './config';
import { isRevertedOrRejected, sanitizeErrorMessage, submitAndTrack } from './tx';
import { humanizeFinality } from './errorMessages';
import {
  submitProvenCall,
  paymasterBuildLeg,
  paymasterExecuteLeg,
  type PaymasterBuildCtx,
} from './proven-submit';
import {
  waitForProvingBlock,
  getCurrentBlock,
  isNodeLagError,
  PROVING_BLOCK_DEPTH,
} from './proving';
import { submitReusingProofOnNodeLag } from './nodeLagRetry';
import { checkProveEarlyQuiescence, proveWithImmediateFallback } from './proveEarly';

export interface ProvenPoolActionArgs {
  transfers: PrivateTransfersInterface;
  account: Account;
  provider: RpcProvider;
  // Read-only capability used ONLY by the prove-early quiescence gate to discover the
  // account's note-id set at two blocks (never logged/persisted).
  viewingKey: bigint;
  // Names the action in status lines, e.g. 'withdraw + burn' / 'withdrawal'.
  label: string;
  // Token operations for the deposit token. Runs inside the SAME `.with()` block the
  // baked AVNU pool fee joins, so both draw from the user's notes and share surplus.
  tokenOps: (t: TokenOperationsBuilder) => void;
  // Optional InvokeExternal leg. The pool allows at most one per tx.
  invoke?: (args: InvokeCalldataBuilderArgs) => CallDetails;
  // Freshest block this account committed to, or undefined when it committed nothing
  // this run (the AVNU-paymaster path, where the pool fee rides in the proof).
  lastTxBlockNumber: number | undefined;
  onStatus?: (s: string) => void;
  // Fires as each phase BEGINS, for callers that render a step tracker rather than a
  // status line. A rebuild retry re-fires 'prove' — a tracker should read that as the
  // phase being live again, not as a new phase.
  onPhase?: (phase: ProvenPoolActionPhase) => void;
  // Fires with the pool fee that will be baked into the proof (0 when none is), before
  // anything is built. Throwing here aborts the action pre-prove — the seam for a caller
  // whose affordability check can only be settled once the fee is known.
  onPoolFee?: (poolFeeRaw: bigint) => void;
  // How far to track the submitted tx before reporting success.
  //
  // 'ACCEPTED_ON_L2' (the default) is required when something downstream reads the tx
  // from a COMMITTED view — the CCTP burn is the case that matters: Circle's attestation
  // service will not see it before then.
  //
  // 'PRE_CONFIRMED' is right for an action whose only consumer is the pool itself. Note
  // discovery, balances and deployment checks all read at `pre_confirmed` (READ_BLOCK),
  // so a pool action's effects are visible — and its notes spendable — as soon as it is
  // pre-confirmed. Waiting for L2 there buys nobody anything and is most of the
  // user-visible latency.
  until?: 'PRE_CONFIRMED' | 'ACCEPTED_ON_L2';
}

// The phases of a proven pool action a UI can meaningfully distinguish: building and
// proving it, handing it to the relay, and waiting for the chain to accept it. Split
// three ways because the relay and the chain fail — and take time — for different
// reasons, and a single "submitting" step hides which one a user is waiting on.
export type ProvenPoolActionPhase = 'prove' | 'submit' | 'confirm';

// A caller's pre-prove refusal, raised from `onPoolFee`. Deterministic local
// arithmetic: a rebuild re-runs it to the same answer, so the retry path rethrows this
// untouched instead of reporting a submit failure and burning another paymaster build.
export class PoolActionRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PoolActionRefused';
  }
}

export interface ProvenPoolActionResult {
  txHash: string;
  // False when the tx was submitted but submitAndTrack timed out before
  // ACCEPTED_ON_L2. The hash is real and the action is in flight, but nothing has
  // witnessed it — a caller that reports success unconditionally would announce a
  // withdrawal that might still revert.
  confirmed: boolean;
}

// Build the action, prove it against a suitable block, and submit it. On a submit
// failure (commonly a stale cached pool nonce) invalidate the SDK's proof-nonce cache
// and rebuild/re-prove once.
export async function proveAndSubmitPoolAction(
  opts: ProvenPoolActionArgs,
): Promise<ProvenPoolActionResult> {
  const {
    transfers,
    account,
    provider,
    viewingKey,
    label,
    tokenOps,
    invoke,
    onStatus,
    onPhase,
    onPoolFee,
    until = 'ACCEPTED_ON_L2',
  } = opts;

  // Proving anchor — a from-pool action PROVES BY SPENDING A PRE-EXISTING POOL NOTE, so the
  // proof MUST age past whatever committed that note. Crucially, that note can be from THIS
  // session: a user who deposits and then withdraws within ~PROVING_BLOCK_DEPTH blocks has a
  // freshly-deposited note not yet buried in the tree. Proving at `latest − depth` WITHOUT
  // aging can pick a base block that predates that note's commitment → the pool
  // `apply_actions` reverts on-chain. So we ALWAYS seed an anchor and age
  // PROVING_BLOCK_DEPTH past it, on BOTH paths.
  //
  // MANAGER path: lastTxBlockNumber is the manager's STRK fee-approve block committed THIS
  // run — which is ≥ any earlier same-session deposit, so aging past it buries the deposit
  // too. Seed from it.
  //
  // AVNU-PAYMASTER path: lastTxBlockNumber is undefined (approvePoolFee is a NO-OP under a
  // paymaster — the pool fee is BAKED INTO THE PROOF as a withdraw to the AVNU forwarder,
  // not a separate on-chain approve). With no fee-approve tx to seed from, seed the anchor
  // from the CURRENT HEAD: aging PROVING_BLOCK_DEPTH past the live head guarantees the base
  // includes everything committed before the action started, including a same-session
  // deposit.
  //
  // Captured ONCE — a failed submit commits no new block. The anchor is reused verbatim by
  // the one-shot rebuild retry (never re-anchored to a newer head, which would force a fresh
  // full aging wait for nothing).
  const anchor = opts.lastTxBlockNumber ?? (await getCurrentBlock(provider));

  // AVNU-relay-in-flight flag. Set by paymasterExecuteLeg's onRelayStart, fired AFTER any
  // signMessage, right before executeTransaction. Once set, the AVNU relayer may already
  // have broadcast the proven action, so a throw from that point on is AMBIGUOUS — a blind
  // retry would re-prove over the SAME notes and request a SECOND withdrawal (saved only by
  // pool nullifiers). We fail closed instead of retrying. A throw BEFORE it fires
  // (build/prove/nonce) submitted nothing and stays safe to retry.
  let paymasterSubmissionStarted = false;

  // Prove-early: an action that spends only OLD, already-buried notes needn't wait the
  // aging window. Prove at `latest − IMMEDIATE_PROVING_BLOCK_DEPTH` with NO aging wait. The
  // SDK compiler pins note discovery+selection to provingBlockId, so a fresh (not-yet-
  // buried) note is INVISIBLE at that base → the build/prove FAILS CLOSED pre-submit. On ANY
  // such failure we fall back ONCE to the aging path. build+prove PRECEDES submit, so that
  // fallback is always pre-`onRelayStart` — it can NEVER re-fire after a relay has broadcast.
  //
  // The quiescence gate (proveEarly.ts) decides eligibility: a stale immediate base can
  // otherwise reuse an already-consumed write-once slot and produce a VALID proof that
  // reverts ON-CHAIN, escaping the pre-submit catch. The action draws from the deposit
  // token, and so does the baked paymaster fee, so one token covers both legs.
  const tokens = [BigInt(config.depositToken.address)];
  const { eligible: immediateEligible, immediateBase } = await checkProveEarlyQuiescence({
    provider,
    snAddress: account.address,
    viewingKey,
    tokens,
    onStatus,
  });
  // Pinned once the proving block is decided (immediate OR aged) so the submit-phase
  // stale-nonce retry rebuilds+re-proves at the SAME block — never re-aging, never re-running
  // the immediate probe (which would risk a post-relay re-fire).
  let resolvedProvingBlock: number | string | undefined;

  // Build + prove at an explicit proving block. PROVE-ONLY (createProofInvocation +
  // executeWithInvocation both precede submit), so any throw here is pre-relay and safe to
  // retry / fall back from.
  const buildAndProve = async (
    provingBlockId: number | string,
    feeWithdraw: { recipient: string; amount: bigint } | undefined,
  ) => {
    onPhase?.('prove');
    onStatus?.(`Building ${label}…`);
    const builder = transfers
      .build({
        autoSetup: true,
        autoDiscover: { notes: 'refresh', channels: 'refresh' },
        autoSelectNotes: 'naive',
      })
      .surplusTo(account.address)
      .with(config.depositToken.address, (t) => {
        tokenOps(t);
        // Bake the AVNU pool fee in as a withdraw to the forwarder (paymaster path).
        // Drawn from the user's notes alongside the action; surplusTo returns change.
        if (feeWithdraw)
          t.withdraw({ recipient: feeWithdraw.recipient, amount: feeWithdraw.amount });
      });
    if (invoke) builder.invoke(invoke);

    const invocation = await builder.createProofInvocation({ provingBlockId });

    onStatus?.('Generating proof (this can take a few seconds)…');
    const { callAndProof } = await transfers.executeWithInvocation(invocation, provingBlockId);

    const proofDetails = callAndProof.proof.proofFacts?.length
      ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
      : {};
    // Bridge the SDK's Call through this package's Call type (separate starknet copies).
    const call = callAndProof.call as unknown as Call;
    return { call, proofDetails };
  };

  // Returns void: the tx hash is captured into the function-scoped `txHash` below so the
  // retry guard can inspect it after a throw.
  const attempt = async (): Promise<void> => {
    // PAYMASTER path: the pool fee must be baked into the proof as a withdraw to the AVNU
    // forwarder. buildTransaction FIRST to learn the fee, then inject it into the SAME
    // `.with()` block as the action — both draw from the user's private notes.
    let paymasterCtx: PaymasterBuildCtx | undefined;
    let feeWithdraw: { recipient: string; amount: bigint } | undefined;
    if (config.paymaster) {
      onStatus?.('Requesting pool fee from paymaster…');
      paymasterCtx = await paymasterBuildLeg(account); // apply_action (no user call)
      const fa = paymasterCtx.feeAction;
      if (fa && BigInt(fa.amount || '0') !== 0n) {
        if (BigInt(fa.token) !== BigInt(config.depositToken.address)) {
          throw new Error(
            `AVNU pool fee is in ${fa.token}, not the deposit token ${config.depositToken.address}. ` +
              'Use AVNU_FEE_MODE=sponsored_private with the deposit token as the pool fee token.',
          );
        }
        feeWithdraw = { recipient: fa.recipient, amount: BigInt(fa.amount) };
      }
    }
    if (onPoolFee) {
      try {
        onPoolFee(feeWithdraw?.amount ?? 0n);
      } catch (err) {
        throw new PoolActionRefused(err instanceof Error ? err.message : String(err), {
          cause: err,
        });
      }
    }

    // Resolve the proving block + build+prove. The stale-nonce submit retry re-enters here;
    // once resolvedProvingBlock is pinned it rebuilds at the SAME block (no re-age).
    let built: Awaited<ReturnType<typeof buildAndProve>>;
    if (immediateEligible && resolvedProvingBlock === undefined) {
      // Quiescent + first attempt: prove immediately; on ANY failure age ONCE.
      // proveWithImmediateFallback's catch is catch-ALL (not a string match): a "latest
      // tagged N" indexer surfaces the shortfall at the prove step, not compile — a narrow
      // catch would hard-fail the action.
      const { result, provingBlockId } = await proveWithImmediateFallback({
        provider,
        immediateBase,
        resolveAgingAnchor: () => anchor,
        onStatus,
        buildAndProveAt: (blockId) => buildAndProve(blockId, feeWithdraw),
      });
      built = result;
      resolvedProvingBlock = provingBlockId;
    } else if (resolvedProvingBlock !== undefined) {
      // Submit-phase retry: reuse the SAME proving block (no re-age).
      built = await buildAndProve(resolvedProvingBlock, feeWithdraw);
    } else {
      // Not quiescent (recent in-window activity / discovery failed): the aging path.
      // resolvedProvingBlock stays undefined so every attempt re-selects via
      // waitForProvingBlock.
      onStatus?.('Selecting proving block…');
      const provingBlockId = await waitForProvingBlock(
        provider,
        anchor,
        onStatus,
        PROVING_BLOCK_DEPTH,
      );
      built = await buildAndProve(provingBlockId, feeWithdraw);
    }

    onPhase?.('submit');
    onStatus?.(`Submitting ${label}…`);
    // Retry the SAME built proof on full-node lag, no re-prove (resetRelayState clears this
    // attempt's relay/hash state between lag retries). A non-lag error rethrows into the
    // outer catch below unchanged.
    const runSubmit = async (): Promise<void> => {
      await submitAndTrack(
        provider,
        async () => {
          // Paymaster path: AVNU's relayer submits the proven apply_action (the fee withdraw
          // is already baked into the proof). Manager path: submitProvenCall passes explicit
          // resourceBounds so account.execute skips the proof-less fee estimate that would
          // revert the proven apply_actions.
          const res = paymasterCtx
            ? await paymasterExecuteLeg(account, built.call, built.proofDetails, paymasterCtx, {
                // Flip only when the AVNU relay actually starts (after any signMessage) —
                // a pre-relay throw relays nothing and stays safely retryable.
                onRelayStart: () => {
                  paymasterSubmissionStarted = true;
                },
              })
            : await submitProvenCall(provider, account, built.call, built.proofDetails);
          txHash = res.transaction_hash;
          // The relay has the tx and handed back its hash; everything after this is the
          // chain reaching `until`.
          onPhase?.('confirm');
          return res;
        },
        {
          until,
          onStatus: ({ finality }) =>
            onStatus?.(`Submitting ${label} (${humanizeFinality(finality)})…`),
        },
      );
    };
    await submitReusingProofOnNodeLag(runSubmit, {
      resetRelayState: () => {
        paymasterSubmissionStarted = false;
        txHash = '';
      },
      onStatus,
    });
  };

  // Hoisted here so the retry guard can inspect it.
  let txHash = '';
  try {
    await attempt();
  } catch (err) {
    // If txHash was already set the submit SUCCEEDED but submitAndTrack timed out waiting
    // for ACCEPTED_ON_L2. The action IS in-flight on Starknet — return its hash. Do NOT
    // re-submit (would double-spend the notes). But a REVERTED/REJECTED throw is NOT an
    // in-flight action (it reverted atomically) — let it propagate so the caller writes no
    // resume state for something that never happened.
    if (txHash && !isRevertedOrRejected(err)) return { txHash, confirmed: false };
    // A caller's refusal is settled arithmetic, not a transient — retrying would re-run
    // the paymaster build only to reach the same answer, behind a misleading
    // "Submit failed … retrying" line.
    if (err instanceof PoolActionRefused) throw err;
    // Exhausted node-lag: propagate, never rebuild — the node is still behind, so a
    // same-anchor re-prove would just node-lag again.
    if (isNodeLagError(err)) throw err;
    // AMBIGUITY GUARD (paymaster path): fail closed ONLY when the AVNU relay is in-flight
    // AND no tx hash was obtained (executeTransaction threw) — the relayer may have
    // broadcast anyway, we cannot find it (AVNU's error carries no hash; the SDK has no
    // nullifier/tx lookup), and re-proving over the same notes would DOUBLE the withdrawal.
    // A KNOWN hash is observable, not ambiguous: a tracking timeout returned it above;
    // reaching here with a hash means it was tracked to terminal REVERTED/REJECTED — an
    // atomic no-op (notes unspent), safe to rebuild + retry exactly like the manager path.
    if (paymasterSubmissionStarted && !txHash) throw err;
    // Falling through to the rebuild retry: a hash reaching here is definitively dead
    // (REVERTED/REJECTED) — clear it so a retry that fails WITHOUT its own hash can't
    // resurrect the dead one as a live tx via the retry guard below.
    txHash = '';
    transfers.invalidateProofNonceCache();
    onStatus?.(`Submit failed (${sanitizeErrorMessage(err)}); retrying…`);
    // Do NOT re-anchor to head: the failed submit committed no new block, so the original
    // anchor is still correct. Re-waiting the full window here would needlessly stall.
    try {
      await attempt();
    } catch (retryErr) {
      // Same guard as the first attempt: a retry whose send() succeeded before
      // submitAndTrack timed out IS in-flight — return its hash rather than throwing after
      // the action landed. A REVERTED/REJECTED retry is not in-flight — propagate it.
      if (txHash && !isRevertedOrRejected(retryErr)) return { txHash, confirmed: false };
      throw retryErr;
    }
  }
  return { txHash, confirmed: true };
}
