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
// state) may not see it yet at the chosen proving block. Busy-wait ~1s/iter until
// the last tx is buried at least `depth` blocks deep, then return `latest - depth`.
// Mirrors the demo's `waitForProvingBlock`. Result is clamped to >= 0 for very
// young chains.
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
    while (lastTxBlockNumber >= latestBlock - depth) {
      const remaining = lastTxBlockNumber - (latestBlock - depth) + 1;
      onStatus?.(`Waiting for blocks to age before proving… (~${remaining} more)`);
      await sleep(1000);
      latestBlock = await getCurrentBlock(provider);
    }
  }
  return Math.max(latestBlock - depth, 0);
}
