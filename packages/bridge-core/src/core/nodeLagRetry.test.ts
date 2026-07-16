// Unit tests for the shared full-node-lag retry (submitReusingProofOnNodeLag), the single
// primitive every proven-submit leg (claim, deposit, withdraw+burn, register) delegates to.
// Covers: retry-the-same-submit-then-resolve, bounded exhaustion, non-node-lag passthrough,
// and that resetRelayState fires between (and only between) lag retries.

import { describe, expect, it, vi } from 'vitest';

// Keep the REAL isNodeLagError (the regex is the contract under test) but make sleep instant
// so the bounded retry loop runs without wall-clock delay.
vi.mock('./proving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proving')>();
  return { ...actual, sleep: () => Promise.resolve() };
});

import { submitReusingProofOnNodeLag, MAX_NODE_LAG_RETRIES } from './nodeLagRetry';

// A full-node-lag ValidationFailure: "block hash mismatch" + a ZERO "stored block hash"
// (matches proving.ts NODE_LAG_RE). No REVERTED/REJECTED/PROOF_EXPIRED words.
const NODE_LAG_MSG =
  'AVNU paymaster paymaster_executeTransaction error (code 156): ValidationFailure: ' +
  '"Invalid proof facts: Block hash mismatch for block 11830268. Proof block hash: 2599, ' +
  'stored block hash: 0."';

describe('submitReusingProofOnNodeLag', () => {
  it('runs submit once and never resets when it resolves first try', async () => {
    const submit = vi.fn(async () => {});
    const resetRelayState = vi.fn();

    await submitReusingProofOnNodeLag(submit, { resetRelayState });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(resetRelayState).not.toHaveBeenCalled();
  });

  it('rethrows a NON-node-lag error immediately — no retry, no reset', async () => {
    const submit = vi.fn(async () => {
      throw new Error('stale proof nonce');
    });
    const resetRelayState = vi.fn();

    await expect(submitReusingProofOnNodeLag(submit, { resetRelayState })).rejects.toThrow(
      /stale proof nonce/,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(resetRelayState).not.toHaveBeenCalled();
  });

  it('retries the SAME submit on node-lag, resetting between tries, then resolves', async () => {
    let calls = 0;
    const submit = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error(NODE_LAG_MSG); // node behind on the first two tries
      // node caught up
    });
    const resetRelayState = vi.fn();
    const onStatus = vi.fn();

    await submitReusingProofOnNodeLag(submit, { resetRelayState, onStatus });

    // 2 node-lag rejects + 1 success.
    expect(submit).toHaveBeenCalledTimes(3);
    // reset fires once per lag retry (before each resubmit), NOT after the success.
    expect(resetRelayState).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/node is briefly behind/i));
  });

  it('is bounded: a node-lag that never clears rethrows after 1 + MAX_NODE_LAG_RETRIES tries', async () => {
    const submit = vi.fn(async () => {
      throw new Error(NODE_LAG_MSG); // node never catches up
    });
    const resetRelayState = vi.fn();

    await expect(submitReusingProofOnNodeLag(submit, { resetRelayState })).rejects.toThrow(
      /block hash mismatch/i,
    );

    // 1 initial + MAX_NODE_LAG_RETRIES resubmits, and the node-lag error is rethrown (not
    // swallowed); reset fires before each resubmit but NOT before the final throw.
    expect(submit).toHaveBeenCalledTimes(MAX_NODE_LAG_RETRIES + 1);
    expect(resetRelayState).toHaveBeenCalledTimes(MAX_NODE_LAG_RETRIES);
  });
});
