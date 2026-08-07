// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Transient-vs-terminal error classification for the orchestrators.
//
// The starknet-core layer (proven-submit's manager nonce, the proving-block
// wait, submitAndTrack) already recovers most hiccups in-call and surfaces
// SUCCESS. This predicate is the orchestrator's safety net for the RESIDUAL
// transient class — a submit that *reported* an error but whose tx may have
// landed (or that simply needs one more try): submit timeouts, an in-flight
// nonce re-seed, an attestation still pending. The orchestrator retries those
// transparently (bounded) so a transiently-reported error never surfaces as a
// terminal "Deposit failed" / "Funding failed" when the operation actually
// succeeds (USER DECISION Q1).
//
// Everything NOT matched here is treated as terminal: reverts, NON_ZERO_VALUE
// (write-once register), balance shortfalls, proof-verification failures, a
// rejected signature, a terminal CCTP attestation. Those are surfaced as an
// error without retrying.

// `waitForAttestation: timed out` / `waitForForwardedMint: timed out` are the
// Iris poll DEADLINE timeouts (polygonMint.ts): Iris / Circle's Forwarding Service
// is merely SLOW (Standard finality or a backgrounded tab can exceed the 30-min
// poll window), but the burn already landed and the attestation / forward is
// replayable forever by burnTxHash — so these are RESUMABLE, never terminal. (The
// genuinely-terminal Iris "failed"/"rejected" status throws a distinct
// `attestation failed` message that TERMINAL_RE catches first.)
// The HTTP status codes are word-boundary-anchored (`\b(429|50[234])\b`) so they
// match a real "HTTP 503" but NOT the same digits embedded in a hash/amount.
// `empty body (expected JSON)` / `was not valid JSON` are the safeJsonParse
// failures polygonMint's Iris poll can throw on an OK-but-blank/partial 200 body:
// Circle serves those mid-attestation, so they are RESUMABLE (the burn is
// replayable by burnTxHash), never terminal (defense-in-depth for auto-resume —
// pollIris already retries them in-loop).
// `waitForProvingBlock: timed out` is the aging-wait DEADLINE (proving.ts): the chain
// head failed to advance the nine blocks the proof anchor needs within the window —
// a STALLED OR LAGGING NODE, not a rejected operation. It throws BEFORE anything is
// proven or submitted, so no funds have moved and a retry is a clean replay of the
// same step (by which time the head has usually advanced). That is exactly the
// pre-submit replayable class the orchestrator's step-retry loop exists for.
const TRANSIENT_RE =
  /submitAndTrack: timed out|mint confirmation timed out|waitForAttestation: timed out|waitForForwardedMint: timed out|waitForProvingBlock: timed out|invalid transaction nonce|\bcode:?\s*52\b|nonce too (old|low|big)|attestation \w+…?|pending_confirmations|re-?seed|ECONNRESET|ETIMEDOUT|network error|fetch failed|failed to fetch|empty body \(expected JSON\)|was not valid JSON|\b(429|50[234])\b|temporarily unavailable|rate limit/i;

// A handful of unambiguously TERMINAL markers that must NEVER be retried even
// if some transient keyword happens to appear in the same message.
// `recipient/domain mismatch` is the CCTP attested-message validation gate
// (polygonMint.ts): a redirected/tampered attestation must fail safely,
// never resume-loop — even though its message text contains the word
// "attestation" (which would otherwise match the transient `attestation \w+`).
const TERMINAL_RE =
  /REVERTED|REJECTED|NON_ZERO_VALUE|insufficient (balance|funds)|proof (verification|invalid)|invalid proof|user (rejected|denied)|attestation failed|recipient\/domain mismatch/i;

// Object-brand for "this error MUST NOT be retried, whatever its message says."
// Callers set this on an error before rethrowing when a normally-transient shape
// carries hidden ambiguity — the classic case is an AVNU paymaster relay throw
// that lands AFTER broadcast (bug-hunt E2): `fetch failed` / `HTTP 503` /
// `ECONNRESET` all match TRANSIENT_RE, but a retry would re-prove over disjoint
// notes and double-submit an already-broadcast leg. Preferred over string tags in
// the message because sanitization / wrapping strips text but not properties.
export const NON_RETRYABLE = Symbol.for('bridge-core.NON_RETRYABLE');

export function markNonRetryable<E extends Error>(err: E): E {
  (err as unknown as Record<PropertyKey, unknown>)[NON_RETRYABLE] = true;
  return err;
}

export function isNonRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[NON_RETRYABLE] === true
  );
}

export function isTransientError(err: unknown): boolean {
  if (isNonRetryable(err)) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (TERMINAL_RE.test(message)) return false;
  return TRANSIENT_RE.test(message);
}
