// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { isTransientError } from './errors';

// Transient-vs-terminal classification (the orchestrator's resume safety net).
// TERMINAL_RE is evaluated FIRST, so a terminal marker (e.g. REVERTED) always
// wins even if a transient digit/keyword appears in the same message.

describe('isTransientError', () => {
  describe('attestation-poll deadline timeout is TRANSIENT (FIX 1)', () => {
    it('classifies waitForAttestation deadline timeout as transient (Iris merely slow → resumable)', () => {
      // Iris on Standard finality (or a backgrounded tab) can exceed the 30-min
      // poll window. The burn already landed and the attestation is replayable
      // forever by burnTxHash, so this MUST be transient — never strand funds.
      expect(isTransientError('waitForAttestation: timed out after 30 min for burn 0xabc')).toBe(
        true,
      );
    });

    it('keeps the genuinely-terminal Iris status error TERMINAL', () => {
      // A "failed"/"rejected" Iris status will never attest — surface it, never
      // resume-loop. Matched by the existing `attestation failed` terminal marker.
      expect(
        isTransientError('CCTP attestation failed (Iris status "failed") for burn 0xabc'),
      ).toBe(false);
    });
  });

  describe('proving-block aging-wait deadline timeout is TRANSIENT', () => {
    it('classifies the waitForProvingBlock deadline timeout as transient (stalled node → replayable)', () => {
      // The EXACT message proving.ts throws. It fires BEFORE anything is proven or
      // submitted — the chain head merely failed to advance the nine blocks the
      // anchor needs — so the step is a clean replay, not a terminal failure.
      expect(
        isTransientError(
          'waitForProvingBlock: timed out after 30 min waiting for the last tx (block 100) to ' +
            'age 8 blocks deep (chain head is still 105). The Starknet node may be stalled or lagging.',
        ),
      ).toBe(true);
    });
  });

  describe('anchored HTTP status codes (FIX 3)', () => {
    it('classifies a live Iris 5xx poll error as transient', () => {
      expect(isTransientError('Iris attestation poll failed: HTTP 503')).toBe(true);
    });

    it('does not let an embedded 50x/429 digit flip a terminal error transient', () => {
      // REVERTED is terminal and evaluated first; the `502` in the amount must
      // not match the anchored \b(429|50[234])\b transient code.
      expect(isTransientError('REVERTED: amount 502 too low')).toBe(false);
    });
  });

  describe('AVNU code-156 gateway error stays NON-transient (fail-closed, #305 Error B)', () => {
    it('does NOT classify the "pre-confirmed data unavailable: gateway error" dump as transient', () => {
      // SAFETY GATE: this error surfaces from paymaster_executeTransaction, i.e. AFTER the
      // onRelayStart boundary — the AVNU relayer MAY already have broadcast the proven
      // deposit (documented spurious code-156 double-burn risk). It must NOT be auto-retried
      // by the orchestrator: humanizeError only softens the DISPLAY; classification stays
      // terminal so moveIntoPool fails closed and the user retries explicitly (the pending
      // pool-deposit cursor then resumes without re-funding).
      expect(
        isTransientError(
          'AVNU paymaster paymaster_executeTransaction error (code 156): TRANSACTION_EXECUTION_ERROR: ' +
            'pre-confirmed data unavailable: gateway error',
        ),
      ).toBe(false);
    });
  });

  describe('node-lag block-hash-mismatch stays NON-transient (resumability is opt-in, not global)', () => {
    it('does NOT classify the full-node-lag ValidationFailure as transient', () => {
      // The claim node-lag auto-retry lives inside submitProvenClaim (bridgeBack), and the
      // return flow opts into RESUMABLE via an explicit `|| isNodeLagError` — NOT by making
      // this transient globally (which would leak into bridgeOut/deposit/moveIntoPool). The
      // message also contains "Invalid proof facts", so TERMINAL_RE keeps it non-transient.
      expect(
        isTransientError(
          'AVNU paymaster paymaster_executeTransaction error (code 156): TRANSACTION_EXECUTION_ERROR: ' +
            'Invalid proof facts: Block hash mismatch for block 11830268. stored block hash: 0.',
        ),
      ).toBe(false);
    });

    it('keeps a genuine proof-verification failure / invalid proof TERMINAL', () => {
      expect(isTransientError('proof verification failed')).toBe(false);
      expect(isTransientError('invalid proof')).toBe(false);
    });
  });

  describe('REJECTED finality is terminal (#94)', () => {
    it('classifies a bare REJECTED tx as terminal, not transient', () => {
      expect(isTransientError('submitAndTrack: 0xabc REJECTED')).toBe(false);
    });

    it('does not let an embedded transient keyword flip a REJECTED tx transient', () => {
      // TERMINAL_RE must be evaluated first so a REJECTED tx whose failure_reason
      // happens to say "temporarily unavailable" is still surfaced as terminal,
      // never resume-looped.
      expect(
        isTransientError('submitAndTrack: 0xabc REJECTED: temporarily unavailable'),
      ).toBe(false);
    });
  });
});
