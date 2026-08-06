// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Error-message humanization (Bundle B4). The orchestrators surface raw
// SDK/RPC/CCTP error text to the user; those messages are terse and full of
// on-chain jargon (NON_ZERO_VALUE, REVERTED, ERC20 transfer failures). Map the
// known signatures to short, ACTIONABLE copy here, leaving anything we don't
// recognize as the (already-sanitized) raw message.
//
// `humanizeError` ALWAYS runs sanitizeErrorMessage (tx.ts) first, so a mapped
// or fallen-through message can never echo a long felt/key/witness hex blob —
// the same defense-in-depth the fail(...) paths already relied on.

import { sanitizeErrorMessage } from './tx';
import { WALLET_UNAVAILABLE_COPY, WALLET_UNAVAILABLE_RE } from './walletErrors';

// Ordered table. ORDER MATTERS: first matching pattern wins, so list MORE SPECIFIC
// signatures before broad catch-alls. Entry shape:
//   - `message` present  → replace with that actionable copy.
//   - `message` absent    → PASSTHROUGH: keep the original (sanitized) text (used when
//       our own pre-check already threw a precise message; also preempts a later rule).
//   - `appendRaw: true`   → KEEP the copy AND append the sanitized cause in parens, so a
//       broad catch-all never fully HIDES where/why it fired (visibility during bring-up).
const ERROR_MAP: ReadonlyArray<{ pattern: RegExp; message?: string; appendRaw?: boolean }> = [
  // Dead/reloaded wallet extension: the inpage↔extension port was severed (MV3
  // worker suspended on idle / extension updated), so personal_sign rejects with an
  // opaque string or times out (see walletErrors.ts). Swap it for actionable copy.
  { pattern: WALLET_UNAVAILABLE_RE, message: WALLET_UNAVAILABLE_COPY },
  // Write-once register: the pool stores the viewing key once, so re-registering
  // an already-registered account reverts with NON_ZERO_VALUE.
  { pattern: /NON_ZERO_VALUE/i, message: 'This account is already registered.' },
  // Transient Starknet RPC/sequencer-gateway failure surfaced through AVNU's relayer
  // during simulation — a JSON-RPC -32603 "Internal error" whose data is
  // "pre-confirmed data unavailable: gateway error" (seen as an AVNU code-156
  // TRANSACTION_EXECUTION_ERROR). It is upstream-node infra, not a real revert: the tx
  // did not execute, and the deposit resumes without re-funding (moveIntoPool persists a
  // pool-deposit cursor before submitting → a retry Continues, never re-burns). Map the
  // raw code-156 dump to actionable copy. NOTE: this is display-only; errors.ts keeps it
  // classified NON-transient so the orchestrator never AUTO-retries a post-relay ambiguous
  // submit (the fail-closed double-burn guard stays intact — the user retries explicitly).
  {
    pattern: /pre-confirmed data unavailable|gateway error/i,
    message:
      'The Starknet relayer hit a temporary network/gateway error and could not process the ' +
      'transaction. Your funds are safe — please retry; an interrupted deposit resumes ' +
      'without re-funding.',
  },
  // Full-node lag: the validating node hasn't synced the proof's base block yet ("stored
  // block hash: 0"), an AVNU code-156 ValidationFailure. bridgeBack auto-retries the SAME
  // proof; this maps the raw code-156 blob to honest copy for the rare case retries exhaust
  // and the flow surfaces it as resumable. Matches proving.ts NODE_LAG_RE (narrow: zero
  // stored hash only). Must precede the generic REVERTED/REJECTED catch-alls below.
  {
    pattern: /block hash mismatch[\s\S]*?stored block hash:\s*(?:0x)?0+\b/i,
    message: 'The Starknet node is briefly behind — your funds are safe.',
  },
  // Single-tx deposit fold (CCTP receive_message folded INTO the pool deposit): an AVNU
  // code-156 `argent/multicall-failed, Nonce already used, ENTRYPOINT_FAILED` on the FIRST
  // attempt is the CCTP transmitter's already-consumed-nonce revert — moveIntoPool's own
  // confirm-poll (is_nonce_used) already tries to converge this to a silent success; this
  // covers the case where that bounded poll times out before the reflection lag clears. The
  // deposit committed or is still settling, never lost — display-only: NOT reclassified as
  // transient (errors.ts keeps the fail-closed markNonRetryable), so the orchestrator never
  // auto-resubmits (double-mint-fold guard stays intact).
  {
    pattern: /nonce already used/i,
    message:
      'Your deposit is taking a moment to confirm on-chain. Your funds are safe — tap ' +
      'Continue to check its status.',
  },
  // GAS-token shortfall on the source chain (depositIn/returnIn pre-checks). The raw
  // message already names the token (POL/ETH), the amounts, and a faucet — and is a
  // DIFFERENT problem from a USDC/balance gap. PASSTHROUGH so the broad balance rule
  // below can't collapse "Insufficient funds for gas: POL…" into the generic balance
  // copy (which made a POL-for-gas gap look like a missing-USDC problem). Must precede
  // that rule. The text still contains "insufficient funds" so errors.ts classifies it
  // TERMINAL — only the user-facing copy is preserved here, not the classification.
  { pattern: /insufficient funds for gas|\bfor gas:/i },
  // Balance shortfalls: STRK/deposit-token funding gaps, ERC20 transfer reverts. KEEP the
  // actionable copy but APPEND the raw cause — the generic copy alone hid WHICH token /
  // WHERE the shortfall was (e.g. a pool apply_actions revert vs an EVM transfer).
  {
    pattern: /insufficient (balance|funds)|ERC20:?\s*transfer|transfer amount exceeds balance/i,
    message: 'Insufficient balance — check your funds and retry.',
    appendRaw: true,
  },
  // Bare on-chain revert with no recognized reason — generic actionable fallback.
  {
    pattern: /\bREVERTED\b/i,
    message: 'The transaction was rejected on-chain. Check your account state and retry.',
  },
  // Sequencer/node REJECTED the tx before it ever landed on-chain (e.g. a stale
  // nonce or an invalid signature caught pre-execution) — distinct from a
  // REVERTED tx that did land. Never retried (errors.ts TERMINAL_RE).
  {
    pattern: /\bREJECTED\b/i,
    message: 'The transaction was rejected. Check your account state and retry.',
  },
];

// Turn a raw thrown value into user-facing copy: sanitize (strip hex / cap
// length) FIRST, then map known signatures to actionable text. Unknown errors
// fall through to the sanitized message unchanged.
export function humanizeError(raw: unknown): string {
  const sanitized = sanitizeErrorMessage(raw);
  for (const { pattern, message, appendRaw } of ERROR_MAP) {
    if (!pattern.test(sanitized)) continue;
    if (!message) return sanitized; // passthrough — keep the precise original text
    return appendRaw ? `${message} (${sanitized})` : message;
  }
  return sanitized;
}

// Friendly labels for the Starknet tx lifecycle (finality) codes that otherwise
// leak verbatim into the progress-tracker detail (e.g. "Submitting deposit
// (PRE_CONFIRMED)…"). Unknown codes pass through unchanged so an unanticipated
// status is never hidden; undefined → '' so callers can interpolate safely.
const FINALITY_LABELS: Readonly<Record<string, string>> = {
  RECEIVED: 'Submitted',
  PRE_CONFIRMED: 'Confirming…',
  ACCEPTED_ON_L2: 'Confirmed on Starknet',
  ACCEPTED_ON_L1: 'Finalized on Ethereum',
};

export function humanizeFinality(finality: string | undefined): string {
  if (!finality) return '';
  return FINALITY_LABELS[finality] ?? finality;
}
