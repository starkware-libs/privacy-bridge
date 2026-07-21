// Cooperative cancellation for the pre-burn phases of a deposit.
//
// Orchestrators (moveIntoPool / fundFromMetaMask) accept an optional AbortSignal
// and check it at safe boundaries — BEFORE each wallet write and BEFORE each
// long external wait. The point of no return is the CCTP burn broadcast: after
// that funds are committed to CCTP and recovery must resume, so no abort check
// runs past `writeContract(depositForBurn)` / `sendCalls([approve, burn])`.
//
// Anything that gets stuck EARLIER (chain switch, sign, approve prompt, storage
// probe, gas preflight) is safe to abort — nothing has moved on-chain. The
// caller signals cancellation by calling `controller.abort()`; the next check
// throws `BridgeCancelledError` which the orchestrator lets propagate.

import { markNonRetryable } from './errors';

export class BridgeCancelledError extends Error {
  readonly cancelled = true;
  constructor(message = 'Deposit cancelled.') {
    super(message);
    this.name = 'BridgeCancelledError';
    // Cancellation is USER intent, not a retryable submit hiccup: the
    // orchestrator's transparent-retry loop must NEVER re-fire a step
    // that was aborted (else "Cancel" would loop through the retry budget).
    markNonRetryable(this);
  }
}

export function isBridgeCancelledError(err: unknown): err is BridgeCancelledError {
  return err instanceof BridgeCancelledError;
}

// Throws BridgeCancelledError if `signal` was aborted; otherwise a no-op.
// `phase` is folded into the message so a UI reader can point at which safe
// boundary the abort hit (purely informational — the app catches on `cancelled`).
export function assertNotAborted(signal: AbortSignal | undefined, phase?: string): void {
  if (signal?.aborted) {
    throw new BridgeCancelledError(phase ? `Deposit cancelled (${phase}).` : undefined);
  }
}
