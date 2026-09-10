// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { isTransientError, markNonRetryable, markTransient } from './errors';

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

  describe('the transient BRAND, for a refusal whose retryability is structural', () => {
    it('classifies a branded error transient even though its wording matches nothing', () => {
      // A refusal that preserves state and asks for a later retry is transient by
      // construction. Pinning it to TRANSIENT_RE would make a copy-edit a behavior change.
      const err = markTransient(new Error('please try this again in a few minutes'));

      expect(isTransientError(new Error('please try this again in a few minutes'))).toBe(false);
      expect(isTransientError(err)).toBe(true);
    });

    it('never lets the brand override an unambiguously TERMINAL message', () => {
      expect(isTransientError(markTransient(new Error('REVERTED: insufficient balance')))).toBe(
        false,
      );
    });

    it('never lets the brand override NON_RETRYABLE', () => {
      expect(isTransientError(markNonRetryable(markTransient(new Error('try again'))))).toBe(false);
    });
  });

  describe('AbortSignal.timeout() fetch abort is TRANSIENT; a caller abort is NOT (2026-09-09 incident)', () => {
    it('classifies the DOMException TimeoutError OBJECT as transient (Chrome wording)', () => {
      // avnuPaymaster.ts rpc() bounds the fetch with AbortSignal.timeout(30s); a hung
      // same-origin proxy made the browser reject with exactly this DOMException.
      expect(isTransientError(new DOMException('signal timed out', 'TimeoutError'))).toBe(true);
    });

    it('classifies a TimeoutError by NAME even when its message matches no wording (Firefox / viem)', () => {
      // Firefox's TimeoutError is worded like an abort; viem's says "took too long". The
      // name is the reliable signal, so the object path must not depend on the message.
      expect(isTransientError(new DOMException('The operation was aborted.', 'TimeoutError'))).toBe(true);
      expect(isTransientError({ name: 'TimeoutError', message: 'The request took too long to respond.' })).toBe(
        true,
      );
    });

    it('classifies the STRING forms as transient (Chrome / Safari / Node wording, stringified DOMException)', () => {
      expect(isTransientError('signal timed out')).toBe(true);
      expect(isTransientError('The operation timed out.')).toBe(true);
      expect(isTransientError('The operation was aborted due to timeout')).toBe(true);
      expect(isTransientError(String(new DOMException('signal timed out', 'TimeoutError')))).toBe(true);
    });

    it('does NOT classify a caller-initiated AbortError as transient (cancelling is a decision)', () => {
      // controller.abort() → name AbortError. Nothing in bridge-core lets one reach the
      // classifier, so it is a consumer cancel (unmount / account switch / user) — never retry.
      expect(isTransientError(new DOMException('The user aborted a request.', 'AbortError'))).toBe(false);
      expect(isTransientError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false);
      expect(isTransientError(new DOMException('signal is aborted without reason', 'AbortError'))).toBe(false);
    });

    it('does NOT classify the STRING form of an abort as transient (kind unknown → fail closed)', () => {
      // Without the object we cannot tell a Firefox TimeoutError from an AbortError by
      // wording, so a bare abort message stays terminal rather than risk retrying a cancel.
      expect(isTransientError('The operation was aborted.')).toBe(false);
      expect(isTransientError('The user aborted a request.')).toBe(false);
    });

    it('keeps NON_RETRYABLE and TERMINAL_RE ahead of the timeout classification', () => {
      // moveIntoPool brands a post-relay paymaster throw NON_RETRYABLE — the brand must win
      // over the TimeoutError name, or the double-submit guard would be bypassed.
      expect(isTransientError(markNonRetryable(new DOMException('signal timed out', 'TimeoutError')))).toBe(
        false,
      );
      expect(isTransientError({ name: 'TimeoutError', message: 'REVERTED after signal timed out' })).toBe(false);
    });

    it('still keeps the wallet signature timeout out of the fetch-timeout wording', () => {
      // walletErrors.ts throws "Signature request timed out" — a dead extension port, not a
      // network hiccup. It must not ride the new `operation timed out` wording into transient.
      expect(isTransientError(new Error('Signature request timed out'))).toBe(false);
    });
  });
});
