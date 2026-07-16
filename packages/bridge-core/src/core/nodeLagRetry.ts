import { isNodeLagError, sleep } from './proving';

// FULL-NODE-LAG retry budget, shared by every proven-submit leg (claim, deposit,
// withdraw+burn, register). The validating node (AVNU's paymaster simulation node, or
// the manager's RPC node) is briefly behind the proof's base block (isNodeLagError). A
// few-block lag catches up in seconds; ~6×5s ≈ 30s stays FAR under the pool's 450-block
// (~15 min) proof-validity window, and never hangs the UI (each caller's onStatus
// heartbeat keeps it alive). Exhaustion is NOT a hard failure — it propagates (→ each
// caller re-attempts / surfaces resumable in the UI).
export const MAX_NODE_LAG_RETRIES = 6;
const NODE_LAG_RETRY_DELAY_MS = 5_000;

// Run `submit`, and on a full-node-lag ValidationFailure (isNodeLagError) wait and
// resubmit the IDENTICAL proof, bounded — NO rebuild / NO re-prove. Safe because:
//  - node lag is a PRE-BROADCAST validation reject (get_block_hash for the base block
//    still reads 0), so the submit threw with no tx hash — nothing was relayed;
//  - resubmitting an IDENTICAL proof is inherently double-spend-safe (its pool nullifiers
//    can be consumed on-chain at most once, and the proven action is idempotent).
// This is why the retry is safe to run BEFORE each caller's fail-closed ambiguity guard,
// UNLIKE the post-broadcast code-156 gateway error (which stays fail-closed).
//
// `resetRelayState` clears the caller's per-attempt relay/hash bookkeeping between lag
// retries so each resubmit classifies its OWN outcome — a pre-broadcast reject can flip
// an onRelayStart flag (the flag fires just before executeTransaction, which then threw)
// even though nothing was broadcast, and it may have captured a now-dead tx hash.
//
// A NON-node-lag error, or an exhausted budget, rethrows at the identical point — so
// every caller-side guard (expiry re-anchor, timed-out-landed, fail-closed, stale-nonce
// rebuild) is left untouched. Callers that must NOT rebuild an exhausted node-lag
// (a re-prove against the still-lagging anchor would just node-lag again) additionally
// re-check isNodeLagError in their outer catch and propagate before the rebuild path.
export async function submitReusingProofOnNodeLag(
  submit: () => Promise<void>,
  opts: { resetRelayState: () => void; onStatus?: (s: string) => void },
): Promise<void> {
  for (let lagAttempt = 0; ; lagAttempt++) {
    try {
      await submit();
      return;
    } catch (err) {
      if (!isNodeLagError(err) || lagAttempt >= MAX_NODE_LAG_RETRIES) throw err;
      opts.resetRelayState();
      opts.onStatus?.(
        `Starknet node is briefly behind; retrying the same proof ` +
          `(${lagAttempt + 1}/${MAX_NODE_LAG_RETRIES})…`,
      );
      await sleep(NODE_LAG_RETRY_DELAY_MS);
    }
  }
}
