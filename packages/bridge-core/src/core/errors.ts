// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Transient-vs-terminal error classification for the orchestrators.
//
// Text comes from `errorText`, the same extractor sanitizeErrorMessage uses, so what the
// user is shown and what the classifier judges are never different strings.
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

import { errorText } from './errorText.js';

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
// `signal timed out` (Chrome) / `The operation timed out.` (Safari) / `aborted due to
// timeout` (Node/undici) / a bare `TimeoutError` are the STRING forms of an
// `AbortSignal.timeout()` fetch abort — avnuPaymaster.ts's rpc() bounds every AVNU
// JSON-RPC call this way (2026-09-09 incident: a same-origin proxy hung on a stale
// upstream and the 30s abort surfaced as a terminal "signal timed out"). The object
// form is matched by name in isTransientError; see isAbortTimeout / isCallerAbort.
// `Load failed` (Safari/iOS) and `NetworkError when attempting to fetch resource.`
// (Firefox — one word, hence `network\s?error`) are those browsers' wording for what
// Chrome calls `Failed to fetch`.
// The HTTP allowlist spans 408 (request timeout), 429 and the whole 5xx range: the LB /
// nginx path in front of AVNU, the RPCs and Iris also answers 500 and Cloudflare
// 520-524. `(^|[^\w.])` keeps those digits from matching inside a hex string or a
// decimal fraction — a lookbehind would be a parse-time SyntaxError on Safari < 16.4.
const TRANSIENT_RE =
  /submitAndTrack: timed out|mint confirmation timed out|waitForAttestation: timed out|waitForForwardedMint: timed out|invalid transaction nonce|\bcode:?\s*52\b|nonce too (old|low|big)|attestation \w+…?|pending_confirmations|re-?seed|ECONNRESET|ETIMEDOUT|network\s?error|fetch failed|failed to fetch|\bload failed\b|empty body \(expected JSON\)|was not valid JSON|(^|[^\w.])(408|429|5\d\d)\b|temporarily unavailable|rate limit|signal timed out|operation timed out|aborted due to timeout|\bTimeoutError\b/i;

// An `AbortSignal.timeout()` abort, matched on the error OBJECT: browsers and Node reject
// the fetch with a DOMException named `TimeoutError` (viem / undici use the same name).
// Duck-typed on `name` rather than `instanceof DOMException` so a cross-realm or
// library-defined error classifies the same way.
function isAbortTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';
}

// A CALLER-initiated abort — `controller.abort()` — rejects with name `AbortError`, NOT
// `TimeoutError`. Nothing in this package lets one reach the classifier (strkPrice.ts and
// useWithdrawCctpFeeEstimate.ts abort their own fetches and swallow the rejection
// locally), so an AbortError here means a consumer cancelled the operation (unmount,
// account switch, user cancel). Cancelling is a decision, not a hiccup: never retry it.
// Checked by name only — Firefox words its AbortError "The operation was aborted.",
// which is why the STRING form deliberately does NOT match `operation was aborted` /
// `user aborted a request` (fail closed: a stringified abort of unknown kind is terminal).
function isCallerAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

// A thrown value and up to two `cause` levels — a wrapper's own message hides the
// network failure or the revert underneath it. Both verdicts read this same chain so a
// terminal cause can never be out-voted by a transient wrapper.
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [err];
  let current = err;
  for (let depth = 0; depth < 2; depth += 1) {
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) break;
    chain.push(cause);
    current = cause;
  }
  return chain;
}

// A handful of unambiguously TERMINAL markers that must NEVER be retried even
// if some transient keyword happens to appear in the same message.
// `recipient/domain mismatch` is the CCTP attested-message validation gate
// (polygonMint.ts): a redirected/tampered attestation must fail safely,
// never resume-loop — even though its message text contains the word
// "attestation" (which would otherwise match the transient `attestation \w+`).
// `user abort\b` (not `abort`) so Argent's `User abort` matches but the AbortError
// wording "The user aborted a request." does not — a caller abort is judged by name.
const TERMINAL_RE =
  /NON_ZERO_VALUE|insufficient (balance|funds)|proof (verification|invalid)|invalid proof|user (rejected|denied|abort\b)|rejected by user|attestation failed|recipient\/domain mismatch/i;

// The tx-status markers, CASE-SENSITIVE: `REVERTED` / `REJECTED` are the literal tokens
// submitAndTrack puts in its message (tx.ts isRevertedOrRejected matches them the same
// way). Case-insensitively they also matched prose — a WAF block page ("The requested
// URL was rejected…") that safe-json.ts appends to a 503 status line made a plain
// gateway failure terminal, killing the retry.
const TERMINAL_TX_STATUS_RE = /\bREVERTED\b|\bREJECTED\b/;

function isTerminalText(text: string): boolean {
  return TERMINAL_TX_STATUS_RE.test(text) || TERMINAL_RE.test(text);
}

// Object-brand for "this error MUST NOT be retried, whatever its message says."
// Callers set this on an error before rethrowing when a normally-transient shape
// carries hidden ambiguity — the classic case is an AVNU paymaster relay throw
// that lands AFTER broadcast (bug-hunt E2): `fetch failed` / `HTTP 503` /
// `ECONNRESET` all match TRANSIENT_RE, but a retry would re-prove over disjoint
// notes and double-submit an already-broadcast leg. Preferred over string tags in
// the message because sanitization / wrapping strips text but not properties.
export const NON_RETRYABLE = Symbol.for('bridge-core.NON_RETRYABLE');

// Accepts any object (not just `Error`) so a thrown DOMException or a library error that
// does not extend Error can still be branded — the brand is what keeps a post-relay
// paymaster throw out of the transient-retry loop, whatever its prototype chain.
export function markNonRetryable<E extends object>(err: E): E {
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

// The mirror of NON_RETRYABLE: "this error IS retryable, whatever its wording says." For a
// refusal that is transient by CONSTRUCTION — it preserves the state a retry needs and asks
// for a later attempt — but shares no vocabulary with TRANSIENT_RE. Wording it into the regex
// instead makes a copy-edit a behavior change, and leaves the classification silently wrong
// until someone re-reads both files. TERMINAL_RE and NON_RETRYABLE still win over the brand.
export const TRANSIENT = Symbol.for('bridge-core.TRANSIENT');

export function markTransient<E extends Error>(err: E): E {
  (err as unknown as Record<PropertyKey, unknown>)[TRANSIENT] = true;
  return err;
}

function isMarkedTransient(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[TRANSIENT] === true
  );
}

// A resume-only entry point found nothing to finish. Callers branch on `code`, so the
// deposit and return legs raise the SAME one from here rather than each minting its own.
// Always NON_RETRYABLE: retrying cannot conjure the missing cursor, and an unattended
// watcher must stop rather than spin.
export type NothingToResumeError = Error & { code: 'NOTHING_TO_RESUME' };

export function nothingToResumeError(message: string): NothingToResumeError {
  const err = new Error(message) as NothingToResumeError;
  err.code = 'NOTHING_TO_RESUME';
  return markNonRetryable(err);
}

// Precedence: NON_RETRYABLE brand → terminal wording → caller abort (all terminal), then
// the TRANSIENT brand / an AbortSignal timeout by name / TRANSIENT_RE by wording. Every
// wording and name check runs over the whole cause chain; the brands are read off the
// thrown object only, since call sites set them on what they rethrow.
export function isTransientError(err: unknown): boolean {
  if (isNonRetryable(err)) return false;
  const chain = errorChain(err);
  const texts = chain.map(errorText);
  if (texts.some(isTerminalText)) return false;
  if (chain.some(isCallerAbort)) return false;
  return (
    isMarkedTransient(err) ||
    chain.some(isAbortTimeout) ||
    texts.some((text) => TRANSIENT_RE.test(text))
  );
}
