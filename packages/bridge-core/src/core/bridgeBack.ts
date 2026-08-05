// Return funds: the inverse of the return-CCTP burn (returnIn.ts). ONE atomic,
// proof-authorized pool tx on the Starknet side — the FOLDED single-tx claim:
//
//   claimToPool(): ONE signed, PROVEN pool apply_actions that ATOMICALLY (a) MINTS the
//   returned CCTP USDC to the InboundAnonymizer and (b) hands it back into the privacy
//   pool as a fresh open note owned by the submitter, via the pool's `ComputeAndInvoke`
//   (privacy-compute, no sub-accounts): the pool calls
//   InboundAnonymizer.privacy_compute(identity_key, dapp_name, source_domain, nonce) —
//   identity_key supplied by the pool from the AUTHENTICATED signer's proven private
//   inputs, dapp_name/source_domain/nonce from our `compute_additional_data` — to recompute the SAME
//   commitment the burn bound in the CCTP message's hookData, then
//   InboundAnonymizer.privacy_invoke_with_computation(commitment, note_id, message,
//   attestation): it asserts the message's hookData commitment == the proven commitment
//   (COMMITMENT_MISMATCH) BEFORE minting, runs `receive_message` (Circle attestation
//   verify + mint, consuming the CCTP nonce), measures the minted delta, and hands that
//   delta to the pool as the open note. The CCTP `message` + `attestation` ride in
//   `invoke_additional_data` (after note_id); the minted amount comes from the on-chain
//   delta, NOT the caller (no claim_secret/H/amount on this leg). The note_id MUST be
//   the id of the open note created in this build.
//
// Because the mint is folded IN, the whole return is one proof-authorized tx submitted
// by the AVNU relayer (or manager) — the user's derived Starknet account is NEVER the
// on-chain sender (closes the A↔deposit-wallet identity leak; docs/threat-model.md).
// The proof COMMITS the message, so it can only be built AFTER attestation (no more
// build-concurrently-with-attestation overlap). A reverted claim consumes NO CCTP nonce
// (the mint reverts atomically with it), so the Circle-attested message stays replayable
// and every retry is idempotent.
//
// Mirrors bridgeOut.ts patterns (createPrivateTransfers, waitForProvingBlock aging,
// createProofInvocation -> executeWithInvocation -> manager-paid submitProvenCall,
// STRK-fee seeding, invalidateProofNonceCache single-retry).
//
// In-memory only — never log/persist the viewing key, account_nonce, SN private key,
// or the raw signature. (The old H/claim_secret module — claim-commitment.ts — is
// UNUSED by this flow now; it stays for the record but nothing here imports it.)

import type { Account, Call, constants } from 'starknet';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  Open,
} from '@starkware-libs/starknet-privacy-sdk';
import {
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
  RETURN_DAPP_NAME,
} from '../derivation/index';
import { config } from './config';
import { encodeCctpBytes } from './cctpBytes';
import { assertReturnCctpMessage } from './snMint';
import { getRpcProvider, makeAccount } from './provider';
import {
  isRevertedOrRejected,
  isTrackedTerminalStatus,
  sanitizeErrorMessage,
  submitAndTrack,
} from './tx';
import { humanizeFinality } from './errorMessages';
import { fetchPoolFeeAmount, approvePoolFee } from './poolFee';
import {
  paymasterBuildLeg,
  paymasterExecuteLeg,
  submitProvenCall,
  type PaymasterBuildCtx,
} from './proven-submit';
import {
  waitForProvingBlock,
  getCurrentBlock,
  isProofExpiredError,
  isNodeLagError,
  IMMEDIATE_PROVING_BLOCK_DEPTH,
} from './proving';
import { submitReusingProofOnNodeLag } from './nodeLagRetry';
import { checkProveEarlyQuiescence, proveWithImmediateFallback } from './proveEarly';

export interface ClaimToPoolArgs {
  // EVM wallet signature of the app's identity sign-message — the only secret input;
  // re-derives the SN account + viewing key (in-memory only, never logged).
  signature: string;
  // Non-secret per-account index (kept for signature symmetry with bridgeOut/returnIn).
  // The claim does NOT need the per-account Polygon EOA, so this is intentionally
  // unused in the body — the claim is a pure Starknet-side operation.
  accountIndex: number;
  // Per-account nonce (deriveAccountNonce) fed as the `nonce` compute_additional_data
  // arg — the SAME nonce returnIn.ts used to derive the commitment carried in the burn's
  // hookData, so the pool's on-chain recompute lands on the SAME commitment the message
  // binds to (COMMITMENT_MISMATCH otherwise).
  accountNonce: bigint;
  // The CCTP message + attestation (from waitForAttestation on the burn tx). Folded into
  // the proven claim's `invoke_additional_data` so InboundAnonymizer.
  // privacy_invoke_with_computation can mint (receive_message) + claim atomically. The
  // proof COMMITS these, so they must be known before proving (i.e. AFTER attestation).
  message: `0x${string}`;
  attestation: `0x${string}`;
  // CCTP domain of the chain the return burn happened on (the EVM source domain) — for
  // the pre-flight assertReturnCctpMessage gate (source/dest/recipient/destinationCaller).
  sourceDomain: number;
  // The InboundAnonymizer to target (ComputeAndInvoke contractAddress). OPTIONAL: a
  // resume/recover threads the BURN-TIME address from its cursor so the claim survives a
  // config `inboundAnonymizerAddress` change (redeploy) — the on-chain recompute uses this
  // contract's address, so it MUST match the one the burn was built against
  // (COMMITMENT_MISMATCH otherwise). Omitted on the FRESH path ⇒ current config (consistent
  // by construction: the same burn just used it).
  inbound?: string;
  onStatus?: (s: string) => void;
}

export interface ClaimToPoolResult {
  // Starknet tx hash of the proven claim apply_actions.
  claimTxHash: string;
}

// Claim the returned USDC back into the privacy pool as a fresh open note owned
// by the submitter, in ONE signed proven pool tx (mint + claim folded).
//
// Steps (RETURN claim, privacy-compute — no claim_secret/H/amount on this leg):
//   1. Recover SN account + viewing key from the signature (in-memory only).
//   2. Manager approves the STRK protocol fee up front (manager-paid submit).
//   3. Build apply_actions: surplusTo(account) + transfer({recipient: account,
//      amount: Open}) on the deposit token (creates the destination open note) +
//      ONE ComputeAndInvoke -> InboundAnonymizer.privacy_compute(identity_key,
//      RETURN_DAPP_NAME, sourceDomain, accountNonce) -> privacy_invoke_with_computation(commitment,
//      note_id, message, attestation), where note_id is the id of the open note created
//      in THIS build and message/attestation are the CCTP receive inputs. The pool
//      supplies identity_key from the authenticated signer's proven private inputs; the
//      minted amount is the on-chain balance delta of receive_message (not caller-set).
//   4. Prove against an aged block, submit from the MANAGER (manager pays gas + fee) or
//      the AVNU relayer — the proof commits the message, so this runs AFTER attestation.
export async function claimToPool(args: ClaimToPoolArgs): Promise<ClaimToPoolResult> {
  // A thin SEQUENTIAL wrapper over the two halves below (used by the RESUME/recovery
  // paths): build+prove then submit back-to-back. buildAndProveClaim needs the CCTP
  // message/attestation (which it folds into the proof), so it must be called only AFTER
  // attestation — there is no build-concurrently-with-attestation overlap anymore.
  const proven = await buildAndProveClaim(args);
  const claimTxHash = await submitProvenClaim(proven);
  args.onStatus?.('Claim submitted; funds returning to the pool.');
  return { claimTxHash };
}

// The proven, ready-to-submit RETURN claim produced by buildAndProveClaim (key recovery
// + manager STRK fee-approve + build + prove — with the CCTP message/attestation folded
// into the proof). The proof COMMITS the message, so buildAndProveClaim must run AFTER
// attestation (no overlap with the attestation wait). A submit that reverts consumes NO
// CCTP nonce (the folded mint reverts atomically), so it is fully replayable/idempotent.
// Carries everything the submit needs plus `rebuild` — the single re-prove (invalidating
// the SDK proof-nonce cache) the submit uses on a stale-nonce failure, reusing the SAME
// already-aged proving anchor.
export interface ProvenClaim {
  provider: ReturnType<typeof getRpcProvider>;
  account: Account;
  call: Call;
  proofDetails:
    | { proof: string; proofFacts: string[] }
    | { proof?: undefined; proofFacts?: undefined };
  paymasterCtx: PaymasterBuildCtx | undefined;
  onStatus?: (s: string) => void;
  // Same-anchor re-prove (invalidates the SDK proof-nonce cache) for a stale cached pool
  // nonce — the failed submit committed no new block, so it reuses the ORIGINAL aged anchor.
  rebuild: () => Promise<ProvenClaim>;
  // FRESH-anchor re-prove for a proof-FRESHNESS revert (PROOF_EXPIRED /
  // INVALID_BASE_BLOCK_NUMBER): re-picks a new base block from the CURRENT head at the
  // IMMEDIATE depth. A slow submit (or a re-prove) can land past the pool's proof-
  // validity window; a same-anchor rebuild would just re-expire. Mirrors deposit.ts PART C.
  rebuildFresh: () => Promise<ProvenClaim>;
}

// Build + prove the FOLDED RETURN claim WITHOUT submitting it. Recovers the SN account +
// viewing key (in-memory only), has the MANAGER approve the STRK protocol fee up front
// (seeds the proving anchor), builds the open-note + ComputeAndInvoke(claim)
// apply_actions with the CCTP message/attestation folded into invoke_additional_data,
// and proves it against an aged block. Returns a ProvenClaim ready for submitProvenClaim.
// The proof commits the message, so this must be called AFTER attestation.
export async function buildAndProveClaim(args: ClaimToPoolArgs): Promise<ProvenClaim> {
  const { signature, accountNonce, message, attestation, sourceDomain, onStatus } = args;
  // accountIndex is intentionally unused — the claim is Starknet-side only and does
  // not derive the per-account Polygon EOA. Kept in the args for symmetry with bridgeOut.
  const provider = getRpcProvider();

  // FAIL CLOSED (mirrors returnIn.ts's orchestrator guard): the default placeholder
  // is the STRING '0x0' (config.ts), not empty — a plain falsy check would pass on
  // it and build a doomed ComputeAndInvoke against a non-existent contract. A resume/
  // recover overrides this with the BURN-TIME address from its cursor (args.inbound) so a
  // mid-return config redeploy still claims against the contract that holds the CCTP funds.
  const inbound = args.inbound ?? config.inboundAnonymizerAddress;
  if (!inbound || inbound === '0x0') {
    throw new Error(
      'claimToPool: inboundAnonymizerAddress not configured — the return leg is not deployed yet.',
    );
  }

  // PRE-FLIGHT (fail-closed, before any proving): validate the attested message binds to
  // the InboundAnonymizer (source/dest/recipient) AND carries destinationCaller = inbound
  // (bypass-proof). Iris is a TRUSTED oblivious service (threat-model.md) — a tampered
  // attestation would revert the folded receive_message on-chain anyway (COMMITMENT_
  // MISMATCH / destination_caller), but catching it here avoids proving a doomed claim.
  // Throws the terminal "recipient/domain mismatch" error (never resume-looped).
  assertReturnCctpMessage(message, sourceDomain, inbound);

  // 1. Recover keys from the single signature (in-memory only).
  onStatus?.('Recovering keys…');
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const account = makeAccount(snAddress, snPrivateKey, provider);

  // 2. STRK protocol fee: the MANAGER approves it up front so collect_fee() can pull it
  // from the manager during apply_actions. Seeds the proving-block wait. Kept in the
  // build half so the anchor stays fresh relative to the prove.
  //
  // MANAGER PATH ONLY. Under the AVNU paymaster the pool's STRK fee is fronted by the
  // relayer/forwarder and repaid out of the proof's fee withdraw, so approvePoolFee()
  // returns undefined immediately (`poolFee.ts`: `if (config.paymaster) return undefined`)
  // — reading get_fee_amount() first would be a round trip on the claim's critical path
  // whose result can only ever be discarded. Skip the read, not just the approve.
  let feeApproveBlock: number | undefined;
  if (!config.paymaster) {
    onStatus?.('Checking pool fee…');
    const feeAmount = await fetchPoolFeeAmount();
    if (feeAmount > 0n) {
      onStatus?.('Approving pool fee…');
      feeApproveBlock = await approvePoolFee(feeAmount);
    }
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

  // Proving anchor — parity with proveAndSubmitBridgeOut (bridgeOut.ts). MANAGER path
  // with a non-zero fee: the fee-approve block is a FRESH tx the claim's proof must
  // read (the fee pull), so it always ages past it (currentAnchor = feeApproveBlock).
  //
  // Otherwise (feeApproveBlock undefined — either the AVNU-PAYMASTER path, where
  // approvePoolFee no-ops, OR a zero-fee manager claim) there is no fee-approve tx to
  // age past, so — mirroring bridgeOut.ts's withdraw QUIESCENCE GATE — check whether the
  // claiming account is provably quiescent: its spendable note-id set is IDENTICAL at
  // `latest − IMMEDIATE_PROVING_BLOCK_DEPTH` and at head. If so, prove immediately at
  // that base (no aging wait). Any addition OR removal (a deposit to fund the fee, a
  // channel/note, back-to-back returns) within the window means the proof could miss
  // committed state → the pool would revert NON_ZERO_VALUE ("...already exists"), so we
  // fall back to today's aged path, seeded from the CURRENT HEAD (the age-wait starts
  // from now and the proving block includes all committed setup). FAIL-SAFE: any
  // discovery failure (indexer down, historical block_ref unsupported) also degrades to
  // aging — never aborts the claim (this is a pre-relay read; failure is safe/retryable).
  //
  // Captured ONCE — a failed submit commits no new block, so the one-shot rebuild reuses
  // the SAME anchor. MUTABLE proving anchor + depth so a PART-C rebuild-on-EXPIRY
  // (rebuildFresh) can re-pick a FRESH base from the current head (undefined →
  // waitForProvingBlock reads latest now) at the safe IMMEDIATE depth. The initial build
  // (and the same-anchor stale-nonce rebuild) leave these UNCHANGED — a failed submit
  // commits no new block, so re-waiting the aging window would stall for nothing.
  // `undefined` depth uses waitForProvingBlock's default aging depth
  // (PROVING_BLOCK_DEPTH). Mirrors deposit.ts / bridgeOut.ts.
  let currentAnchor: number | undefined;
  let currentDepth: number | undefined;
  // True ONLY when the quiescence gate below decided the immediate path — distinct
  // from `currentAnchor === undefined && currentDepth === IMMEDIATE_PROVING_BLOCK_DEPTH`,
  // which rebuildFresh's PART-C re-anchor ALSO produces (a fresh, ungated immediate
  // base after a proof-EXPIRY revert). buildOnce uses this flag (not just the
  // anchor/depth pair) to route ONLY the gate-eligible path through
  // proveWithImmediateFallback's race-safety net — rebuildFresh keeps its original
  // plain single-build behavior (no note-id race to guard against: it re-anchors
  // because the OLD proof's base aged out, not because of a quiescence decision).
  let usedQuiescenceGate = false;
  // The gate's own immediateBase — reused directly by buildOnce's gate-eligible path
  // (below) instead of re-deriving it via a second getCurrentBlock() read.
  let gateImmediateBase: number | undefined;

  // CONCURRENT FEE QUOTE. AVNU's buildTransaction request for this leg is CONSTANT —
  // {type:'apply_action', pool_address} plus the configured fee mode (paymasterBuildLeg) —
  // so it depends on nothing the quiescence gate produces, yet it runs strictly AFTER the
  // gate today (inside buildOnce). Start it here instead, so the AVNU round trip overlaps
  // the gate's discovery reads rather than queueing behind them. Mirrors the deposit
  // preflight's concurrent reads.
  //
  // Deliberately NOT prefetched across a long wait: the quote is a live STRK→pool-fee-token
  // conversion the proof must bake in exactly, so it is dropped (and re-quoted inside
  // buildOnce) on every path that adds real delay before the build — the aging wait below,
  // a manager fee-approve tx, and every rebuild. Its age therefore stays bounded by the
  // gate itself, roughly one discovery round trip.
  let pendingFeeQuote: Promise<PaymasterBuildCtx> | undefined;
  if (config.paymaster && feeApproveBlock === undefined) {
    onStatus?.('Requesting pool fee from paymaster…');
    pendingFeeQuote = paymasterBuildLeg(account, { type: 'apply_action' });
    // Park a catch so an early rejection cannot surface as an unhandled rejection while
    // the gate is still running; the rejection is still delivered at buildOnce's await.
    pendingFeeQuote.catch(() => {});
  }

  if (feeApproveBlock !== undefined) {
    currentAnchor = feeApproveBlock;
  } else {
    const tokens = [BigInt(config.depositToken.address)];
    const { eligible, immediateBase } = await checkProveEarlyQuiescence({
      provider,
      snAddress,
      viewingKey,
      tokens,
      onStatus,
    });
    if (eligible) {
      currentAnchor = undefined;
      currentDepth = IMMEDIATE_PROVING_BLOCK_DEPTH;
      usedQuiescenceGate = true;
      gateImmediateBase = immediateBase;
    } else {
      // Not eligible ⇒ the aging wait (up to PROVING_BLOCK_DEPTH blocks) stands between
      // here and the build, so the in-flight quote would be stale by the time the proof
      // bakes it in. Drop it and let buildOnce re-quote after the wait — today's ordering.
      pendingFeeQuote = undefined;
      currentAnchor = await getCurrentBlock(provider);
    }
  }

  // Pinned once the gate-eligible path resolves a proving block (immediate OR its
  // aged fallback) so a stale-nonce rebuild() reuses the SAME block instead of
  // re-running the immediate/fallback dance from scratch (which could land on a
  // DIFFERENT block than the first successful proof — mirrors bridgeOut.ts's
  // resolvedProvingBlock). The non-gate aging path deliberately leaves this
  // undefined: every attempt there re-selects via waitForProvingBlock, unchanged
  // pre-existing behavior. rebuildFresh resets this to undefined (new anchor, PART-C).
  let resolvedProvingBlock: number | string | undefined;

  // Build + prove ONCE — the pure proof-generation body (no submit). Called initially,
  // by rebuild() on the stale-nonce retry (SAME anchor), and by rebuildFresh() on a
  // proof-expiry re-anchor (FRESH anchor — currentAnchor/currentDepth mutated first).
  const buildOnce = async (): Promise<Omit<ProvenClaim, 'rebuild' | 'rebuildFresh'>> => {
    // PAYMASTER path: the AVNU pool fee must be baked into the proof as a withdraw to
    // the forwarder (AVNU 165 MISSING_FEE_TRANSFER_TO otherwise). buildTransaction
    // FIRST to learn the fee, inject the withdraw into the claim's USDC `.with()` block,
    // prove, then execute via the relayer. Mirrors deposit.ts. NOTE (value flow): the
    // returned USDC lands in the open note via InboundAnonymizer's OpenNoteDeposit
    // (fixed to note_id, sized by the on-chain minted delta), so — UNLIKE the deposit,
    // where the fee nets against the deposited amount — the claim fee CANNOT net
    // against the claimed funds. It is drawn from the submitter's EXISTING pool
    // balance (autoSelectNotes), so the account needs >= fee in spendable notes.
    // Zero-fee (sponsored / no paymaster) skips all this. LIVE-VERIFY
    // (.claude/rules/verification.md): the exact balance accounting + AVNU's
    // acceptance of this leg need a live run.
    let paymasterCtx: PaymasterBuildCtx | undefined;
    let feeWithdraw: { recipient: string; amount: bigint } | undefined;
    if (config.paymaster) {
      // Consume the quote started beside the quiescence gate, ONCE. A rebuild /
      // rebuildFresh finds it spent and re-quotes fresh: a retry can be a minute or more
      // after the first attempt, and the fee is a live conversion the proof commits to.
      const startedFeeQuote = pendingFeeQuote;
      pendingFeeQuote = undefined;
      if (!startedFeeQuote) onStatus?.('Requesting pool fee from paymaster…');
      paymasterCtx = await (startedFeeQuote ?? paymasterBuildLeg(account, { type: 'apply_action' }));
      const fa = paymasterCtx.feeAction;
      if (fa && BigInt(fa.amount || '0') !== 0n) {
        // sponsored_private pays the fee in pool_fee_token (→ the deposit token). The
        // withdraw must be in that token; a mismatch (e.g. sponsored → STRK) can't be
        // paid from a USDC-only pool balance.
        if (BigInt(fa.token) !== BigInt(config.depositToken.address)) {
          throw new Error(
            `AVNU pool fee is in ${fa.token}, not the claim token ${config.depositToken.address}. ` +
              'Use AVNU_FEE_MODE=sponsored_private with the deposit token as the pool fee token.',
          );
        }
        feeWithdraw = { recipient: fa.recipient, amount: BigInt(fa.amount) };
      }
    }

    // Build + prove at an explicit proving block. PROVE-ONLY (createProofInvocation +
    // executeWithInvocation both precede submit), so any throw here is pre-relay and
    // safe to retry / fall back from.
    const buildAndProveAt = async (
      provingBlockId: number | string,
    ): Promise<{ call: Call; proofDetails: ProvenClaim['proofDetails'] }> => {
      onStatus?.('Building claim…');
      // transfer({recipient: account, amount: Open}) creates the destination open
      // note. This is the ONLY builder action that compiles to a CreateOpenNote
      // (builders.js: isOpenNote(amount) => CreateOpenNote); a numeric deposit would
      // compile to a CreateEncNote, which the SDK FILTERS OUT of `openNotes`
      // (compiler.js: `if (note.type !== 'CreateOpenNote') return []`) — so its
      // noteId would never reach the dataBuilder callback below. InboundAnonymizer's
      // `privacy_invoke_with_computation` deposits the freshly-minted USDC INTO this
      // open note, so its note_id must be bound into `invoke_additional_data`. Mirrors
      // the SDK's own SwapAnonymizer (simple-private-transfers.js: transfer(Open) +
      // invoke), just with `.computeAndInvoke` in place of `.invoke`.
      const builder = transfers
        .build({
          autoSetup: true,
          autoDiscover: { notes: 'refresh', channels: 'refresh' },
          autoSelectNotes: 'naive',
        })
        .surplusTo(account.address)
        .with(config.depositToken.address, (t) => {
          t.transfer({ recipient: account.address, amount: Open });
          if (feeWithdraw) {
            // PAYMASTER: the AVNU pool fee, withdrawn to the forwarder (drawn from the
            // account's existing pool balance — see the note above). Omitting it →
            // AVNU 165 MISSING_FEE_TRANSFER_TO.
            t.withdraw({ recipient: feeWithdraw.recipient, amount: feeWithdraw.amount });
          }
        })
        .computeAndInvoke(({ openNotes }) => {
          // openNotes[0] is the CreateOpenNote created just above. Defensive guard:
          // without it the proof would bind `undefined` as note_id.
          if (!openNotes[0]) {
            throw new Error('claimToPool: no open note created — cannot bind claim note_id.');
          }
          // The pool calls InboundAnonymizer.privacy_compute(identity_key,
          // ...compute_additional_data) — identity_key supplied by the pool from the
          // AUTHENTICATED signer's proven private inputs, so ONLY the true owner
          // reproduces the SAME commitment the burn carried in the message's hookData
          // (deriveInboundCommitment uses the SAME dapp_name/nonce pair) — then
          // privacy_invoke_with_computation(commitment, note_id, message, attestation)
          // asserts that binding (COMMITMENT_MISMATCH), MINTS via receive_message, and
          // deposits the minted delta into note_id. No claim_secret, no H, no caller-
          // supplied amount on this leg at all.
          //
          // invoke_additional_data = [note_id, <message ByteArray>, <attestation
          // ByteArray>]. Each ByteArray is serialized with encodeCctpBytes — the SAME
          // Cairo `ByteArray` layout ([num_full_words, ...31-byte words, pending_word,
          // pending_word_len]) snMint's buildReceiveMessageCall feeds receive_message —
          // mapped to bigint felts to match the note_id felt (CallDetails["calldata"]).
          return {
            contractAddress: inbound,
            // The pool prepends identity_key, so the order here must equal
            // privacy_compute's (dapp_name, source_domain, nonce) — source_domain is the
            // CCTP source domain the return burned FROM (must match the burn's hookData
            // commitment, COMMITMENT_MISMATCH otherwise).
            computeAdditionalData: [RETURN_DAPP_NAME, BigInt(sourceDomain), accountNonce],
            invokeAdditionalData: [
              BigInt(openNotes[0].noteId),
              ...encodeCctpBytes(message).map((felt) => BigInt(felt)),
              ...encodeCctpBytes(attestation).map((felt) => BigInt(felt)),
            ],
          };
        });

      const invocation = await builder.createProofInvocation({ provingBlockId });

      onStatus?.('Generating proof (this can take a few seconds)…');
      const { callAndProof } = await transfers.executeWithInvocation(invocation, provingBlockId);

      // Bridge the SDK's Call through the app's Call type (separate starknet copies).
      const proofDetails: ProvenClaim['proofDetails'] = callAndProof.proof.proofFacts?.length
        ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
        : {};
      const call = callAndProof.call as unknown as Call;
      return { call, proofDetails };
    };

    let call: Call;
    let proofDetails: ProvenClaim['proofDetails'];
    if (resolvedProvingBlock !== undefined) {
      // Submit-phase stale-nonce retry (rebuild()) on the gate-eligible path: reuse
      // the SAME resolved block — never re-run the gate/immediate-fallback dance,
      // which could otherwise land on a DIFFERENT block than the first proof.
      ({ call, proofDetails } = await buildAndProveAt(resolvedProvingBlock));
    } else if (usedQuiescenceGate && gateImmediateBase !== undefined) {
      // Quiescence-gate-eligible path (first attempt): reuse the gate's OWN
      // immediateBase (no second getCurrentBlock() read — mirrors bridgeOut.ts, which
      // reuses its captured immediateBase the same way). Between the gate's read and
      // THIS build, a note could still land/spend (a race, not a gate bug) — the
      // stale base would then reuse an already-consumed write-once slot and revert.
      // Mirrors bridgeOut.ts's withdraw: try the immediate build/prove first; on ANY
      // failure (catch-all — an indexer "latest tagged N" snapshot can surface the
      // shortfall at the prove step, not compile), fall back ONCE to today's aged
      // path so the claim still lands instead of hard-failing.
      const { result, provingBlockId } = await proveWithImmediateFallback({
        provider,
        immediateBase: gateImmediateBase,
        resolveAgingAnchor: () => getCurrentBlock(provider),
        onStatus,
        buildAndProveAt,
      });
      ({ call, proofDetails } = result);
      resolvedProvingBlock = provingBlockId;
    } else {
      // Not gate-eligible: today's aging path, unchanged — resolvedProvingBlock stays
      // undefined here so every attempt (including retries) re-selects via
      // waitForProvingBlock, exactly as before this PR.
      onStatus?.('Selecting proving block…');
      const provingBlockId = await waitForProvingBlock(provider, currentAnchor, onStatus, currentDepth);
      ({ call, proofDetails } = await buildAndProveAt(provingBlockId));
    }

    return { provider, account, call, proofDetails, paymasterCtx, onStatus };
  };

  // Wrap a built proof with `rebuild` (SAME-anchor stale-nonce re-prove) and
  // `rebuildFresh` (FRESH-anchor proof-expiry re-anchor). Both invalidate the SDK
  // proof-nonce cache; rebuildFresh additionally re-picks a new base from the current
  // head at the IMMEDIATE depth (via the mutable currentAnchor/currentDepth above).
  function withRebuild(base: Omit<ProvenClaim, 'rebuild' | 'rebuildFresh'>): ProvenClaim {
    return {
      ...base,
      rebuild: async () => {
        transfers.invalidateProofNonceCache();
        return withRebuild(await buildOnce());
      },
      rebuildFresh: async () => {
        transfers.invalidateProofNonceCache();
        // undefined anchor → waitForProvingBlock reads the CURRENT latest (a fresh base);
        // IMMEDIATE depth keeps it clear of the sequencer's ~10-block get_block_hash floor.
        // usedQuiescenceGate = false: this is an EXPIRY re-anchor (the OLD proof's base
        // aged out of the pool's validity window), not a quiescence-gate decision — it
        // must NOT route through proveWithImmediateFallback's race-safety net (that net
        // exists for the note-id race the gate itself can miss, which doesn't apply
        // here) and just builds once at the fresh base, matching this path's original
        // single-attempt behavior. resolvedProvingBlock = undefined: a PRIOR gate-eligible
        // build may have pinned it (e.g. the proof that just EXPIRED), and reusing that
        // stale block here would defeat the entire point of re-anchoring to a fresh one.
        currentAnchor = undefined;
        currentDepth = IMMEDIATE_PROVING_BLOCK_DEPTH;
        usedQuiescenceGate = false;
        resolvedProvingBlock = undefined;
        return withRebuild(await buildOnce());
      },
    };
  }

  return withRebuild(await buildOnce());
}

// Finality-poll grid for the claim, tighter than submitAndTrack's 1s→8s default. This is
// the LAST leg of a return: the moment the claim is accepted the run is over, so every
// second between acceptance and the poll that observes it is time the user spends waiting
// on a finished transfer. The default grid was tuned for attestation-scale waits, where
// backing off to 8s costs nothing; against Starknet block times an 8s step can sit seconds
// past an acceptance that already happened. A 2.5s ceiling keeps that tail short while
// staying well off a per-second poll (the run's hard timeoutMs is unchanged).
const CLAIM_TRACK_INTERVAL_MS = 700;
const CLAIM_TRACK_MAX_INTERVAL_MS = 2_500;

// Submit an ALREADY-PROVEN, FOLDED return claim from the MANAGER (or, on the paymaster
// path, via AVNU's relayer). The proof carries the CCTP message/attestation, so the mint
// happens INSIDE this tx — there is no prior on-chain bind to wait for. On a submit
// failure (commonly a stale cached pool nonce) it rebuilds/re-proves once (proven.rebuild)
// and retries. Returns the claim tx hash.
//
// A post-send throw from submitAndTrack means send() already put the claim tx on
// Starknet, so it is genuinely IN-FLIGHT — UNLESS the throw is a DEFINITIVE on-chain
// failure: an execution REVERT or a REJECTED finality. InboundAnonymizer's
// `privacy_invoke_with_computation` mints (receive_message) + deposits into the open note
// in the SAME atomic apply_actions as the open-note creation — a revert rolls back the
// WHOLE tx, so the CCTP nonce is NOT consumed (the message stays replayable) and no open
// note was created. Returning that dead hash as "submitted" would make the caller
// (returnIn.ts) report the claim done and clear the only resume cursor
// (pmp.inflightReturn) for a claim that never happened. isRevertedOrRejected (core/tx.ts)
// matches submitAndTrack's literal REVERTED/REJECTED words — shared with bridgeOut.ts's +
// deposit.ts's identical guards.
export async function submitProvenClaim(proven: ProvenClaim): Promise<string> {
  const { provider, account, onStatus } = proven;

  // AVNU-relay-in-flight flag (mirrors deposit.ts / proveAndSubmitBridgeOut). Set by
  // paymasterExecuteLeg's onRelayStart, right before executeTransaction. Once set, the
  // relayer may already have broadcast the proven claim, so a throw from that point on is
  // AMBIGUOUS — a blind retry would re-submit over the SAME notes and request a SECOND
  // claim (double submission, saved only by pool nullifiers). Fail closed instead. A throw
  // BEFORE it fires (submit/nonce) submitted nothing and stays safe to retry.
  let paymasterSubmissionStarted = false;
  // Hoisted so the retry guard can inspect the FIRST submit's hash: if submitAndTrack
  // throws AFTER send() succeeded (tracking timeout), the first hash is preserved.
  let claimTxHash = '';

  const submit = async (p: ProvenClaim): Promise<void> => {
    onStatus?.('Submitting claim…');
    await submitAndTrack(
      provider,
      async () => {
        // PAYMASTER path: AVNU's relayer submits the proven apply_action (the fee
        // withdraw is already baked into the proof). Otherwise the MANAGER submits.
        const res = p.paymasterCtx
          ? await paymasterExecuteLeg(account, p.call, p.proofDetails, p.paymasterCtx, {
              // Flip only when the AVNU relay actually starts — a pre-relay throw relays
              // nothing and stays safely retryable.
              onRelayStart: () => {
                paymasterSubmissionStarted = true;
              },
            })
          : await submitProvenCall(provider, account, p.call, p.proofDetails);
        claimTxHash = res.transaction_hash;
        return res;
      },
      {
        until: 'ACCEPTED_ON_L2',
        intervalMs: CLAIM_TRACK_INTERVAL_MS,
        maxIntervalMs: CLAIM_TRACK_MAX_INTERVAL_MS,
        onStatus: ({ finality }) => onStatus?.(`Submitting claim (${humanizeFinality(finality)})…`),
      },
    );
  };

  // Submit `p`, retrying the IDENTICAL proof on full-node lag (resetRelayState clears this
  // leg's relay/hash state between lag retries). A non-lag error or an exhausted budget
  // rethrows at the identical point, leaving every existing guard untouched. See nodeLagRetry.ts.
  const submitClaimReusingProofOnNodeLag = (p: ProvenClaim): Promise<void> =>
    submitReusingProofOnNodeLag(() => submit(p), {
      resetRelayState: () => {
        paymasterSubmissionStarted = false;
        claimTxHash = '';
      },
      onStatus,
    });

  // PART C bound (mirrors deposit.ts): at most this many FRESH-anchor re-proves. With the
  // 450-block validity window this essentially never fires now that the proof is built
  // right after attestation and submitted immediately; it stays as defense in depth
  // against a base block that aged out (a slow re-prove / retry) before a submit landed.
  const MAX_EXPIRY_REANCHORS = 2;

  // PART C — re-anchor on a proof-FRESHNESS revert (PROOF_EXPIRED / INVALID_BASE_BLOCK_
  // NUMBER), DISTINCT from the same-anchor stale-nonce rebuild. The SAME-anchor retry
  // would just re-expire, so re-pick a FRESH base at the IMMEDIATE depth and re-prove.
  // Gated on isTrackedTerminalStatus: only a DEFINITIVE on-chain revert (an atomic no-op,
  // notes UNSPENT) re-anchors — an AMBIGUOUS expiry (no hash / relay-in-flight timeout)
  // is not this type, so it falls through to the fail-closed guard. Returns the re-proven
  // claim to retry, or throws the original error once the bounded budget is spent.
  let working = proven;
  const reanchorForExpiry = async (e: unknown, expiryAttempt: number): Promise<boolean> => {
    if (!(isProofExpiredError(e) && isTrackedTerminalStatus(e))) return false;
    if (expiryAttempt >= MAX_EXPIRY_REANCHORS) throw e;
    // A tracked-terminal revert is a confirmed atomic no-op (notes unspent) — clear the
    // dead relay/hash state so the re-anchored submit classifies its OWN outcome and
    // can't resurrect the dead tx, then re-prove against a FRESH head.
    paymasterSubmissionStarted = false;
    claimTxHash = '';
    onStatus?.('Proof expired; re-anchoring to a fresh block and re-proving…');
    working = await proven.rebuildFresh();
    return true;
  };

  for (let expiryAttempt = 0; ; expiryAttempt++) {
    try {
      await submitClaimReusingProofOnNodeLag(working);
    } catch (err) {
      // PART C first: a proof-freshness revert re-anchors to a fresh head, NOT the
      // same-anchor stale-nonce path below.
      if (await reanchorForExpiry(err, expiryAttempt)) continue;
      // If claimTxHash was already set the submit SUCCEEDED but submitAndTrack timed out
      // waiting for ACCEPTED_ON_L2. The claim IS in-flight — return its hash. But a
      // REVERTED/REJECTED throw is NOT an in-flight claim (the mint + open-note-create +
      // claim reverted atomically, CCTP nonce unconsumed) — let it propagate so NO
      // resume cursor is written for a claim that never happened.
      if (claimTxHash && !isRevertedOrRejected(err)) return claimTxHash;
      // EXHAUSTED node-lag → propagate on BOTH paths, never rebuild. submitReusingProofOnNodeLag
      // only rethrows a node-lag error once its bounded budget is spent; the node is still
      // behind, so rebuild() would re-prove against the SAME anchor and just node-lag again —
      // wasted work, and on the MANAGER path (where the fail-closed guard below is false) it
      // would re-prove after exhaustion, contrary to the same-proof-only invariant. Propagating
      // here makes both paths consistent (→ resumable in the UI). Placed BEFORE the fail-closed
      // guard so it also covers the manager path (the paymaster path would fail-closed anyway).
      if (isNodeLagError(err)) throw err;
      // AMBIGUITY GUARD (paymaster path), same rule as proveAndSubmitBridgeOut: fail
      // closed ONLY when the AVNU relay is in-flight AND no tx hash was obtained
      // (executeTransaction threw) — the relayer may have broadcast the claim anyway and
      // re-submitting over the same notes would DOUBLE-submit it. A KNOWN hash is
      // observable, not ambiguous: a tracking timeout returned it above; reaching here
      // with a hash means the claim was tracked to terminal REVERTED/REJECTED — an atomic
      // no-op (notes unspent), safe to rebuild + retry exactly like the manager path.
      if (paymasterSubmissionStarted && !claimTxHash) throw err;
      // Falling through to the rebuild retry: a hash reaching here is definitively dead
      // (REVERTED/REJECTED) — clear it so a retry that fails WITHOUT its own hash can't
      // resurrect the dead one as a live claim via the retry guard below.
      claimTxHash = '';
      onStatus?.(`Submit failed (${sanitizeErrorMessage(err)}); retrying…`);
      // rebuild() invalidates the SDK proof-nonce cache and re-proves against the SAME
      // (already-aged) anchor — the failed submit committed no new block.
      working = await working.rebuild();
      try {
        await submitClaimReusingProofOnNodeLag(working);
      } catch (retryErr) {
        // The same-anchor retry can ALSO hit an expiry (its base finally aged out) —
        // re-anchor via the outer loop rather than failing (bounded).
        if (await reanchorForExpiry(retryErr, expiryAttempt)) continue;
        // Same guard as the first attempt: a timed-out-but-landed retry returns its hash;
        // a REVERTED/REJECTED retry propagates so no cursor is written.
        if (claimTxHash && !isRevertedOrRejected(retryErr)) return claimTxHash;
        throw retryErr;
      }
    }
    // Reached only on a clean success (first submit or same-anchor retry landed + tracked).
    return claimTxHash;
  }
}
