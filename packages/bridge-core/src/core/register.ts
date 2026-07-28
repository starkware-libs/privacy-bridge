// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import type { Account, Call, constants } from 'starknet';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  type PrivateTransfersInterface,
} from '@starkware-libs/starknet-privacy-sdk';
import { config } from './config';
import { getRpcProvider } from './provider';
import { sanitizeErrorMessage, submitAndTrack } from './tx';
import { humanizeFinality } from './errorMessages';
import { submitProvenCall } from './proven-submit';
import { waitForProvingBlock, isNodeLagError } from './proving';
import { submitReusingProofOnNodeLag } from './nodeLagRetry';
import { fetchPoolFeeAmount, approvePoolFee } from './poolFee';

export interface RegisterArgs {
  account: Account;
  viewingKey: bigint;
  // Block of the account's most recent committed tx (e.g. the deploy). When
  // provided, the proving block waits until it's buried deep enough. Optional:
  // the pool-fee approve we submit here is also tracked and used as a fallback.
  lastTxBlockNumber?: number;
  onStatus?: (s: string) => void;
  // Fires with the register tx hash once it lands (for a block-explorer link).
  // NOT called on the paymaster path (register is folded into the deposit's
  // apply_actions — no standalone tx) or when already registered (no submit).
  onTx?: (hash: string) => void;
}

// The pool stores each user's viewing public key WRITE-ONCE: the `register`
// action runs a `WriteOnce` server-action that reverts with `NON_ZERO_VALUE`
// once the key is set. We recognise that revert so a redundant register is
// treated as a no-op success rather than a hard failure (see isAlreadyRegisteredError).
const ALREADY_REGISTERED_REVERT = 'NON_ZERO_VALUE';

// Reads the pool's `get_public_key(address)` view — a felt252 that is non-zero
// once the account has registered its viewing key, zero/empty otherwise. This
// mirrors the SDK's own discovery path, which falls back to
// `pool.get_public_key(recipient)` to look up a registrant's key
// (see contract-discovery's getPublicKey). Used to make the register step
// idempotent: skip it when the key is already on-chain.
//
// Any throw (e.g. view unavailable, transient RPC error) is treated as
// "not registered" so the caller falls through to a real register attempt
// (which is itself guarded against the write-once revert).
export async function isRegistered(address: string): Promise<boolean> {
  try {
    const result = await getRpcProvider().callContract({
      contractAddress: config.poolAddress,
      entrypoint: 'get_public_key',
      calldata: [address],
    });
    const publicKey = result[0];
    return publicKey !== undefined && BigInt(publicKey) !== 0n;
  } catch {
    return false;
  }
}

// True when `err` is the pool's write-once "viewing key already set" revert
// (`NON_ZERO_VALUE`). We DON'T match generic errors — only this specific revert
// — so unrelated failures still propagate. Exported for unit testing.
export function isAlreadyRegisteredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(ALREADY_REGISTERED_REVERT);
}

// Registers the account's viewing key with the starknet-privacy pool.
//
// Mirrors the demo's register path (`demo/src/hooks/useTransactions.ts`):
//   1. approve the pool's STRK protocol fee from the MANAGER (manager-paid; no
//      paymaster yet),
//   2. build a `register()` action + proof invocation,
//   3. prove it against a recent block via the proving service,
//   4. submit the resulting call (with proof/proofFacts) from the MANAGER, which
//      pays the on-chain gas + protocol fee (the derived account stays STRK-free).
//
// The prover/indexer read COMMITTED state, so the account must already be
// deployed and ACCEPTED_ON_L2 before calling this (gated by the caller).
export async function registerWithPool(args: RegisterArgs): Promise<void> {
  const { account, viewingKey, onStatus, onTx } = args;
  const provider = getRpcProvider();

  // PAYMASTER path: a standalone register can't pay its pool fee — a fresh account has
  // no private balance for the fee withdraw AVNU requires (165 MISSING_FEE_TRANSFER_TO).
  // So defer: the deposit's `autoRegister` folds register() into the deposit's single
  // apply_actions, where the deposited USDC funds the combined fee (deposit.ts;
  // open-questions.md #13). No-op here.
  if (config.paymaster) {
    onStatus?.('Registration will be bundled with the deposit (paymaster).');
    return;
  }

  onStatus?.('Checking pool fee…');
  const feeAmount = await fetchPoolFeeAmount();
  // The account's last committed tx — the caller's hint (the deploy) and/or the
  // approve we submit below — seeds waitForProvingBlock so the prover proves
  // against a block where this account's state is already visible.
  let lastTxBlockNumber = args.lastTxBlockNumber;
  if (feeAmount > 0n) {
    onStatus?.('Approving pool fee…');
    const approveBlock = await approvePoolFee(feeAmount);
    if (approveBlock !== undefined) lastTxBlockNumber = approveBlock;
  }

  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  await proveAndSubmitRegister(transfers, account, provider, lastTxBlockNumber, onStatus, onTx);

  onStatus?.('Registered with pool.');
}

// Build the register action, prove it against a settled block, and submit. On a
// submit failure (commonly a stale cached pool nonce), invalidate the SDK's
// proof-nonce cache and rebuild/re-prove once with a fresh proving block.
// Mirrors the demo's non-paymaster register chain.
async function proveAndSubmitRegister(
  transfers: PrivateTransfersInterface,
  account: Account,
  provider: ReturnType<typeof getRpcProvider>,
  lastTxBlockNumber: number | undefined,
  onStatus?: (s: string) => void,
  onTx?: (hash: string) => void,
): Promise<void> {
  const attempt = async (): Promise<void> => {
    // Prove a few blocks back so the proof stays within the sequencer's
    // acceptance window when the tx arrives, and so this account's last tx is
    // already committed at the proving block.
    onStatus?.('Selecting proving block…');
    const provingBlockId = await waitForProvingBlock(provider, lastTxBlockNumber, onStatus);

    onStatus?.('Building registration…');
    const builder = transfers.build().register();
    const invocation = await builder.createProofInvocation({ provingBlockId });

    onStatus?.('Generating proof (this can take a few seconds)…');
    const { callAndProof } = await transfers.executeWithInvocation(invocation, provingBlockId);

    // Manager-paid submit: submitProvenCall sends the proven call from the MANAGER
    // (not the derived account), forwarding the proof + proof facts the prover
    // returned. The derived account's identity rides in the call's calldata, so a
    // different sender is sound (see proven-submit.ts). The SDK and app share a Call
    // shape but come from separate starknet copies, so bridge through the app type.
    const proofDetails = callAndProof.proof.proofFacts?.length
      ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
      : {};
    const call = callAndProof.call as unknown as Call;

    onStatus?.('Submitting registration…');
    // submitProvenCall passes EXPLICIT resourceBounds so the manager's execute skips
    // its implicit fee estimate — that estimate drops the proof and would revert in
    // the pool's proof verification before the proven invoke is ever submitted.
    //
    // Retry the SAME proof on full-node lag (the manager's RPC node briefly behind the
    // proof's base block); a non-lag error rethrows into the outer catch. See nodeLagRetry.ts.
    let registerTxHash = '';
    await submitReusingProofOnNodeLag(
      async () => {
        const { transaction_hash } = await submitAndTrack(
          provider,
          () => submitProvenCall(provider, account, call, proofDetails),
          {
            until: 'PRE_CONFIRMED',
            onStatus: ({ finality }) =>
              onStatus?.(`Submitting registration (${humanizeFinality(finality)})…`),
          },
        );
        registerTxHash = transaction_hash;
      },
      {
        resetRelayState: () => {
          registerTxHash = '';
        },
        onStatus,
      },
    );
    onTx?.(registerTxHash);
  };

  try {
    await attempt();
  } catch (err) {
    // Belt-and-suspenders: a concurrent register (or an isRegistered race) may
    // have already set the write-once viewing key — the pool reverts with
    // NON_ZERO_VALUE. That's the desired end state, so treat it as a no-op
    // success rather than retrying (a retry would just revert the same way).
    if (isAlreadyRegisteredError(err)) {
      onStatus?.('Already registered with pool.');
      return;
    }
    // Exhausted node-lag: propagate, never rebuild — the node is still behind, so a
    // same-anchor re-prove would just node-lag again (mirrors bridgeBack).
    if (isNodeLagError(err)) throw err;
    // Drop the cached pool nonce so the retry fetches a fresh one, then rebuild
    // + re-prove against the SAME (already-aged) proving anchor.
    transfers.invalidateProofNonceCache();
    onStatus?.(`Submit failed (${sanitizeErrorMessage(err)}); retrying…`);
    // Do NOT re-anchor to head: the failed submit committed no new block, so the
    // original lastTxBlockNumber is still correct. Re-waiting the full
    // PROVING_BLOCK_DEPTH window here would needlessly stall the retry (and a code-52
    // already recovers in-call in managerExecute).
    try {
      await attempt();
    } catch (retryErr) {
      // Same write-once tolerance on the retry path.
      if (isAlreadyRegisteredError(retryErr)) {
        onStatus?.('Already registered with pool.');
        return;
      }
      throw retryErr;
    }
  }
}
