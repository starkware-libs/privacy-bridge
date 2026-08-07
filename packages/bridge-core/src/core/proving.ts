// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import type { RpcProvider } from 'starknet';

// PROVING BLOCK CHOICE. The pool accepts a proof while
//   base_block_number < current <= base_block_number + proof_validity_blocks
// (starknet-privacy `privacy.cairo`, errors PROOF_EXPIRED / INVALID_BASE_BLOCK_NUMBER).
// `proof_validity_blocks` is a LIVE on-chain value — 450 on our Sepolia pool
// (~15 min at 2s/block), a WIDE window, NOT a tight ~10-block ceiling. So a proof
// does not "expire in a couple blocks"; it has ample shelf life (a Fast-CCTP wait
// fits with huge margin).
//
// We prove at `latest - PROVING_BLOCK_DEPTH` so the base block is already a few
// blocks old — it must be strictly < current, and settled enough that its on-chain
// block hash is retrievable by the time the tx executes (this ~10-block floor is the
// *youngest* a base block may be, NOT an expiry ceiling — an earlier note here had
// that backwards). Mirrors the demo's PROVING_BLOCK_DEPTH.
//
// WHERE THE FLOOR ACTUALLY LIVES (source-of-truth check, starknet-privacy repo):
// the pool contract does NOT enforce a minimum age — `privacy.cairo` validate_proof
// (lines 827-832) IGNORES the base block hash (`base_block_hash: _`) and only asserts
//   base_block_number < current_block_number            (INVALID_BASE_BLOCK_NUMBER)
//   current_block_number <= base + proof_validity_blocks (PROOF_EXPIRED, =450 on Sepolia).
// The ≥10 floor is a Starknet SEQUENCER/OS `get_block_hash` constraint (the syscall
// only serves blocks at least ~10 old), documented as authoritative in the pool SDK
// (sdk/README.md:129 "at least 10 blocks older than the submission block"; the demo
// proves at latest-9, the SDK recommends latest-10). It binds at EXECUTION time:
// `base <= execution_block - 10`.
export const PROVING_BLOCK_DEPTH = 8;

// IMMEDIATE-prove depth: used ONLY on the prove-early path (Part A / Part C), where the
// aging wait is SKIPPED so blocks do NOT pass between proving and execution. In the
// normal aging path `latest - 8` is safe because ~2+ blocks elapse during the wait, so
// the base ages to >=10 deep by execution; removing that wait shrinks the gap, so a
// base at `latest - 8` could still be <10 deep at execution and the tx would revert
// (the sequencer can't serve the base block hash yet). Anchor deeper: at `latest - 12`
// the base is >=13 deep even if execution lands just 1 block after proving — a >=3-block
// cushion above the 10-block sequencer floor (SDK recommends latest-10; we add margin
// for slower inclusion under a fast-submit path). The 450-block PROOF_EXPIRED ceiling
// leaves enormous headroom above, so going deeper costs nothing on the validity side.
// Dedicated (not a bump to PROVING_BLOCK_DEPTH) so the return-leg / aging paths keep
// their tuned behavior untouched.
export const IMMEDIATE_PROVING_BLOCK_DEPTH = 12;

// Exported so callers that resubmit on a transient node condition (bridgeBack's claim
// node-lag retry) share one delay primitive AND can stub it in tests (vi.mock('./proving')).
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// AGING-WAIT CADENCE (waitForProvingBlock). The wait ends only when the chain
// produces blocks, so the loop asks a question whose answer changes on the order of
// the block time while polling far faster than that — most reads are pure waste.
//
// Backing off is RISK-FREE here because the exit condition is MONOTONIC: once the
// head passes `lastTxBlockNumber + depth` it stays past it, so a slower poll can
// never miss the transition, only observe it slightly later. Keep the first couple
// of polls tight (the common case is a tx that is all but buried already, settled in
// one or two reads), then back off to roughly the chain's own block cadence.
const INITIAL_POLL_INTERVAL_MS = 1_000;
const BACKOFF_POLL_INTERVAL_MS = 5_000;
// Polls served at INITIAL_POLL_INTERVAL_MS before the backoff engages.
const INITIAL_POLLS_BEFORE_BACKOFF = 2;

// Deadline for the aging wait. BOUNDED, so a stalled sequencer or a misconfigured
// provider surfaces a named error instead of hanging the flow forever behind a spinner
// (the loop previously had neither an attempt cap nor a deadline) — but sized so it can
// only fire on a chain that is genuinely stuck, never on one that is merely congested.
// The worst case is a `lastTxBlockNumber` at the head: the loop exits once the head
// reaches `lastTxBlockNumber + depth + 1`, i.e. NINE blocks at the default depth of 8.
// Thirty minutes leaves a ~200s per-block tolerance, two orders of magnitude above
// Starknet's ~2s block time. Fifteen minutes allowed only ~100s per block, which
// sustained Starknet congestion has historically exceeded — that would hard-fail a flow
// the previous unbounded loop would eventually have completed. Matches the Iris
// attestation poll deadline (DEFAULT_POLL_TIMEOUT_MS, polygonMint.ts), so the two long
// waits in a bridge give up on the same clock.
const PROVING_WAIT_TIMEOUT_MS = 30 * 60_000;

// The pool's on-chain proof-freshness reverts (privacy.cairo errors, surfaced through
// submitAndTrack's REVERTED failure_reason). PROOF_EXPIRED = base aged past the 450-block
// validity window; INVALID_BASE_BLOCK_NUMBER = base not strictly older than the execution
// block. Both mean the proof's ANCHOR is stale — distinct from a stale proof NONCE (which
// re-proves against the SAME anchor). The Part-C rebuild-on-expiry re-picks a FRESH anchor.
const PROOF_EXPIRED_RE = /PROOF_EXPIRED|INVALID_BASE_BLOCK_NUMBER/;

// True when `err` carries a pool proof-freshness revert reason. Callers additionally
// gate on isTrackedTerminalStatus (tx.ts) so only a DEFINITIVE atomic no-op re-anchors —
// an ambiguous submit failure must still fail closed.
export function isProofExpiredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return PROOF_EXPIRED_RE.test(message);
}

// FULL-NODE LAG on the proof's base block. The validating node (e.g. AVNU's paymaster
// simulation node) hasn't synced the proof's base block yet, so its get_block_hash for
// that block still reads 0 and proof-fact validation fails UP FRONT (a pre-broadcast
// AVNU code-156 ValidationFailure: "Invalid proof facts: Block hash mismatch for block N.
// Proof block hash: X, stored block hash: 0"). The proof itself is VALID — once the node
// catches up, resubmitting the SAME proof lands. Callers wait + resubmit the identical
// proof (bridgeBack.ts), which is inherently double-spend-safe (a proof's nullifiers can
// be consumed on-chain at most once) — do NOT re-prove.
//
// NARROW BY DESIGN: the `stored block hash: 0` is the retryable tell. A NON-zero stored
// hash is a genuine reorg/anchor mismatch that waiting cannot fix, so it must NOT match.
// This is also distinct from the post-broadcast code-156 "gateway error" / "pre-confirmed
// data unavailable" (errorMessages.ts), which stays fail-closed and is never auto-retried.
const NODE_LAG_RE = /block hash mismatch[\s\S]*?stored block hash:\s*(?:0x)?0+\b/i;

export function isNodeLagError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NODE_LAG_RE.test(message);
}

/** Reads the current latest block number. */
export async function getCurrentBlock(provider: RpcProvider): Promise<number> {
  return provider.getBlockNumber();
}

// Picks the block id to prove against: `latest - depth`.
//
// If the account's last tx (e.g. the deploy/approve) is too recent — i.e. it
// sits within the last `depth` blocks — the prover/indexer (which read COMMITTED
// state) may not see it yet at the chosen proving block. Poll until the last tx is
// buried at least `depth` blocks deep, then return `latest - depth`. The poll starts
// tight and backs off to roughly the chain's block cadence (see
// INITIAL_POLL_INTERVAL_MS), and is bounded by PROVING_WAIT_TIMEOUT_MS — a stalled
// chain throws a named error rather than looping forever. Mirrors the demo's
// `waitForProvingBlock`. Result is clamped to >= 0 for very young chains.
//
// This is the ONLY place the aging wait happens, and it only fires BETWEEN
// DEPENDENT actions (a recent `lastTxBlockNumber` whose committed state the next
// proof must read). When `lastTxBlockNumber` is undefined (an independent action),
// it skips the wait loop entirely and proves at `latest - depth` immediately.
// Submit retries MUST preserve the original anchor (a failed submit commits no new
// block) — re-anchoring to head would re-trigger this full wait for nothing (see
// bridgeOut.ts / deposit.ts / register.ts catch blocks). EXCEPTION: the Part-C
// rebuild-on-EXPIRY deliberately re-anchors to a fresh head (the old base aged out of
// the validity window), which is a different failure than a stale nonce.
//
// `depth` defaults to PROVING_BLOCK_DEPTH (the aging path, where ~2+ blocks pass
// during the wait so the base is >=10 deep by execution). The prove-early path
// (no aging wait → no blocks pass) MUST pass IMMEDIATE_PROVING_BLOCK_DEPTH so the
// base clears the sequencer's ~10-block get_block_hash floor at execution.
//
// `onStatus` (optional) is invoked while blocking so the multi-block wait
// (~10 blocks ≈ minutes) doesn't look stuck in the UI.
export async function waitForProvingBlock(
  provider: RpcProvider,
  lastTxBlockNumber: number | undefined,
  onStatus?: (s: string) => void,
  depth: number = PROVING_BLOCK_DEPTH,
): Promise<number> {
  let latestBlock = await getCurrentBlock(provider);
  if (lastTxBlockNumber !== undefined && lastTxBlockNumber >= latestBlock - depth) {
    const deadline = Date.now() + PROVING_WAIT_TIMEOUT_MS;
    let polls = 0;
    while (lastTxBlockNumber >= latestBlock - depth) {
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForProvingBlock: timed out after ${Math.round(PROVING_WAIT_TIMEOUT_MS / 60_000)} min ` +
            `waiting for the last tx (block ${lastTxBlockNumber}) to age ${depth} blocks deep ` +
            `(chain head is still ${latestBlock}). The Starknet node may be stalled or lagging.`,
        );
      }
      const remaining = lastTxBlockNumber - (latestBlock - depth) + 1;
      onStatus?.(`Waiting for blocks to age before proving… (~${remaining} more)`);
      polls += 1;
      await sleep(
        polls <= INITIAL_POLLS_BEFORE_BACKOFF ? INITIAL_POLL_INTERVAL_MS : BACKOFF_POLL_INTERVAL_MS,
      );
      latestBlock = await getCurrentBlock(provider);
    }
  }
  return Math.max(latestBlock - depth, 0);
}
