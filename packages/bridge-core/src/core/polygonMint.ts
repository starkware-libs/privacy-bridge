// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// CCTP V2 Forwarding-Service flow: poll Circle Iris for the burn's attestation
// (the EVM->Starknet fund-in leg still needs the raw {message, attestation} to
// replay), and — on the Starknet->Polygon FUND-ACCOUNT leg — poll Iris for the
// `forwardTxHash`, the destination mint tx Circle's Forwarding Service submits
// FOR US once the burn used `deposit_for_burn_with_hook` with the static
// "cctp-forward" hook. We NEVER submit receiveMessage ourselves on the fund-account leg:
// there is no relayer key of ours and no user MetaMask mint. Circle deducts its
// forwarding fee IN USDC from the burned amount, so the recipient EOA receives
// `amount - maxFee` (the fee floor is enforced pre-flight in cctpFees.ts).
//
// Frozen shape. The fund-in leg's mint
// (depositIn.ts) and the decoder/validation gate below are unchanged.
//
// In-memory only — never log/persist the per-account EOA private key.

import { config, getDefaultEvmCctpDestination } from './config';
import { safeJsonParse } from '../lib/safe-json';

export interface AttestationResult {
  // CCTP message bytes (hex) to replay on the destination chain.
  message: `0x${string}`;
  // Circle's attestation signature over the message (hex).
  attestation: `0x${string}`;
}

// Result of the forwarded-mint poll: the destination mint tx Circle's Forwarding
// Service submitted on Polygon (no tx of ours). Idempotent + resumable — a present
// forwardTxHash means the mint already landed.
export interface ForwardedMintResult {
  forwardTxHash: `0x${string}`;
}

// Shape of a single message entry in the Iris v2 response.
interface IrisMessage {
  status: string;
  message: `0x${string}`;
  attestation: `0x${string}`;
  // Set by the Forwarding Service once it submits the destination mint for us.
  forwardTxHash?: `0x${string}`;
}

interface IrisResponse {
  messages?: IrisMessage[];
}

// Base Iris poll cadence for the STANDARD finality tier (threshold 2000). Standard
// finality on Polygon can take many minutes, so a tight interval would hammer Iris
// pointlessly for the whole window — 5s is the right cadence there.
const DEFAULT_POLL_INTERVAL_MS = 5_000;
// Iris poll cadence for the FAST finality tier (threshold 1000). A Fast burn attests
// in ~10-15s, so the fixed 5s Standard cadence wastes up to ~5s of that window on
// BOTH the attestation and the forwarded-mint poll. Polling ~3x tighter recovers
// most of that latency without meaningfully loading Iris (the Fast window is short).
const FAST_POLL_INTERVAL_MS = 1_500;
// Standard CCTP finality on Polygon can take many minutes; allow up to 30.
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60_000;

// Exponential-backoff bounds for TRANSIENT Iris HTTP errors (5xx / 429): the
// service is busy / rate-limiting, not permanently broken. Back off from ~1s,
// doubling, capped at ~30s, all within the existing poll deadline (Bundle B1).
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// True iff `err` is a DEMONSTRABLY-TERMINAL CCTP attest/mint failure — an Iris
// "attestation failed"/"rejected" status (thrown by pollIris above) or the
// recipient/domain-mismatch fund-safety gate (assertCctpMessageMatches below,
// and snMint.ts's destinationCaller check, which throws the identical message).
// Both prove the message will never mint here, so a caller's resume cursor can
// safely be cleared; every other failure (a one-off RPC blip, a poll timeout,
// an unclassified throw) is resumable and must PRESERVE the cursor. Shared by
// the four callers that clear-on-terminal after a failed attest/mint
// (bridgeOut.ts's fundAccountFromPool + cashOut, depositIn.ts, returnIn.ts) —
// byte-identical regex + `err instanceof Error ? err.message : String(err)`
// classification before this dedupe.
export function isTerminalAttestFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /attestation failed|recipient\/domain mismatch/i.test(message);
}

// True for a TRANSIENT Iris HTTP status worth retrying with backoff: 429 (rate
// limited) or any 5xx (server busy / temporary). Everything else in the non-404
// branch (400/401/403, …) is a genuine, non-retryable error (Bundle B1).
function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Tuning knobs shared by both Iris pollers (waitForAttestation +
// waitForForwardedMint). Timing (sleep/random) + the backoff bounds are injectable
// so tests are deterministic without real waiting.
interface PollOpts {
  // Poll cadence. An explicit `intervalMs` ALWAYS wins (tests inject a tiny value);
  // otherwise the interval is derived from the finality tier via `fast` below.
  intervalMs?: number;
  // Finality tier of the burn, threaded from the caller (fundAccountFromPool /
  // cashOut already know config.cctp.fast). When no explicit `intervalMs` is given,
  // Fast polls at FAST_POLL_INTERVAL_MS (~1.5s) and Standard at DEFAULT_POLL_INTERVAL_MS
  // (5s). Only selects the base cadence — the transient (5xx/429) backoff is unchanged.
  fast?: boolean;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  onStatus?: (s: string) => void;
  // Injectable for deterministic tests; default to the real timers / RNG.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Generic Iris poller: GET the same /v2/messages/{sourceDomain}?transactionHash=
// URL on a loop until `extract` returns a non-null value, retrying 404 (not yet
// indexed) at the base interval and transient 5xx/429 with exponential backoff +
// jitter, all bounded by a single deadline. `extract` inspects the first message
// entry and returns the resolved value (done) or null (keep polling); it may also
// throw a TERMINAL error to short-circuit. `timeoutLabel` names the throw on
// deadline exhaustion. Shared by both pollers so the retry/backoff logic lives once.
async function pollIris<T>(
  burnTxHash: string,
  sourceDomain: number,
  extract: (entry: IrisMessage | undefined) => T | null,
  opts: PollOpts | undefined,
  statusLabel: string,
  timeoutLabel: string,
): Promise<T> {
  // Explicit interval wins; otherwise pick the tier's base cadence (Fast ~1.5s vs
  // Standard 5s). Only the base poll interval is tier-aware — the transient-error
  // backoff bounds (base/cap) below are unchanged for both tiers.
  const intervalMs =
    opts?.intervalMs ?? (opts?.fast ? FAST_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  // Clamp the effective backoff base to ≥ 1ms (NIT, B-logic audit): a degenerate
  // `backoffBaseMs: 0` override would make the transient (5xx/429) branch compute
  // waitMs = 0, and with an injected sleep that advances the clock by `ms`, the
  // Date.now()-based deadline would NEVER progress → a no-progress infinite loop.
  // The floor guarantees each backoff sleep advances the clock so the deadline
  // check below can always fire.
  const backoffBaseMs = Math.max(1, opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const backoffCapMs = opts?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const onStatus = opts?.onStatus;
  const sleepFn = opts?.sleep ?? sleep;
  const randomFn = opts?.random ?? Math.random;

  const { irisUrl } = config.cctp;
  const base = irisUrl.replace(/\/+$/, '');
  const url = `${base}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Number of CONSECUTIVE transient-HTTP responses — drives the backoff
  // exponent. Reset whenever Iris responds non-transiently (ok or 404).
  let transientStreak = 0;
  for (;;) {
    attempt += 1;
    onStatus?.(`${statusLabel} (attempt ${attempt})…`);

    // Interval to wait before the NEXT poll. Defaults to the base poll interval
    // (404 / pending / ok-but-not-done); a transient 5xx/429 (or a caught network
    // error, below) overrides it with an exponential backoff + jitter delay.
    let waitMs = intervalMs;

    // A thrown network error (DNS hiccup, connection reset, CORS preflight
    // failure, Wi-Fi drop) is caught here and classified exactly like a transient
    // 5xx/429 below — `networkError` stands in for `res` not being `ok`/404/etc.
    let res: Response | undefined;
    let networkError = false;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      networkError = true;
    }

    // Set when the response should be retried with exponential backoff exactly
    // like a 5xx/429: a network fetch failure, a transient HTTP status, OR an
    // OK-but-empty/non-JSON body (below). The backoff is applied once, after the
    // branch, so the transient-handling lives in a single place.
    let transient = false;

    if (res && res.ok) {
      // Guard the body parse: an OK response with an empty/non-JSON body must be
      // RETRIED like a transient 5xx/429 (Circle occasionally serves a blank or
      // partial 200 mid-attestation) — NOT escape the poll loop as a terminal
      // "empty body (expected JSON)" throw (which auto-resume would treat terminal).
      let body: IrisResponse | undefined;
      try {
        body = safeJsonParse<IrisResponse>(await res.text(), `Iris /v2/messages (${res.status})`);
        // safeJsonParse does NOT throw on the JSON literal `null` (JSON.parse("null")
        // is valid) or a bare primitive, so a degenerate-but-parseable 200 body slips
        // past the catch. Dereferencing `body!.messages` on `null` would then throw a
        // TERMINAL `Cannot read properties of null` OUTSIDE this guard. Treat any
        // non-object body as transient — retry it exactly like the empty/non-JSON case.
        if (!body || typeof body !== 'object') {
          transient = true;
        }
      } catch {
        transient = true;
      }
      if (!transient) {
        transientStreak = 0;
        const entry = body!.messages?.[0];
        const resolved = extract(entry);
        if (resolved !== null) return resolved;
        // TERMINAL status: Circle can reject / fail a message that will never
        // attest. Short-circuit with a distinct, actionable error instead of
        // wasting the full poll window (default 30 min) on a "timed out" that
        // misrepresents the cause. (Anything else — e.g. "pending_confirmations"
        // — is non-terminal and keeps polling.)
        if (entry && /^(failed|rejected)$/i.test(entry.status)) {
          throw new Error(
            `CCTP attestation failed (Iris status "${entry.status}") for burn ${burnTxHash}.`,
          );
        }
        // Indexed but not yet done (status e.g. "pending_confirmations").
        onStatus?.(`${entry?.status ?? 'pending'}…`);
      }
    } else if (!networkError && res!.status === 404) {
      // Not indexed yet — keep polling at the base interval.
      transientStreak = 0;
    } else if (networkError || isTransientHttpStatus(res!.status)) {
      // TRANSIENT (Bundle B1) — a busy/rate-limiting Iris (5xx/429) OR a caught
      // network-level fetch failure. The deadline-exceeded throw below is
      // transient-classified, so a persistent failure still surfaces as resumable.
      transient = true;
    } else {
      // Genuine non-retryable HTTP error (400/401/403, …) — throw as before.
      throw new Error(`Iris poll failed: HTTP ${res!.status}`);
    }

    if (transient) {
      // Back off exponentially (base · 2^streak, capped) with full jitter and keep
      // polling until the deadline — shared by the 5xx/429, network-failure and
      // empty/non-JSON-body cases above.
      transientStreak += 1;
      const exp = Math.min(backoffCapMs, backoffBaseMs * 2 ** (transientStreak - 1));
      // Decorrelated full jitter in [base, exp]: never below base, never above
      // the capped exponential — keeps growth monotonic in expectation while
      // de-synchronizing concurrent clients.
      const jittered = backoffBaseMs + randomFn() * Math.max(0, exp - backoffBaseMs);
      waitMs = Math.min(backoffCapMs, jittered);
      onStatus?.('Circle service is busy — retrying…');
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${timeoutLabel}: timed out after ${Math.round(timeoutMs / 60_000)} min for burn ${burnTxHash}`,
      );
    }
    await sleepFn(waitMs);
  }
}

// Poll Iris by SOURCE domain + burn tx hash until status == "complete".
// Idempotent — safe to re-run with the same burnTxHash (e.g. after a tab reload);
// keep the tab open (minutes for Standard). A 404 means Iris hasn't indexed the
// burn yet → keep polling at the base interval. A 5xx/429 means Iris is busy →
// keep polling with EXPONENTIAL backoff + jitter (Bundle B1), still bounded by
// the same poll deadline. Timing (sleep/random) and the backoff bounds are
// injectable so tests are deterministic without real waiting.
//
// `opts.sourceDomain` is the CCTP domain of the chain the burn happened on:
//   - the fund-account leg burns on Starknet → defaults to config.cctp.starknetDomain (25);
//   - the fund-from-MetaMask deposit-in leg burns on an EVM chain → pass that
//     source's domain (Polygon Amoy = 7, Ethereum Sepolia = 0).
//
// Still used by the EVM->Starknet fund-in leg (depositIn.ts), which submits the
// Starknet mint itself. The Starknet->Polygon fund-account leg uses waitForForwardedMint
// instead (Circle's Forwarding Service submits that mint).
export async function waitForAttestation(
  burnTxHash: string,
  opts?: PollOpts & { sourceDomain?: number },
): Promise<AttestationResult> {
  const { starknetDomain } = config.cctp;
  const sourceDomain = opts?.sourceDomain ?? starknetDomain;
  return pollIris<AttestationResult>(
    burnTxHash,
    sourceDomain,
    (entry) => {
      if (entry && entry.status === 'complete' && entry.message && entry.attestation) {
        return { message: entry.message, attestation: entry.attestation };
      }
      return null;
    },
    opts,
    'Waiting for Circle attestation',
    'waitForAttestation',
  );
}

// Poll Iris by SOURCE domain + burn tx hash until the Forwarding Service has
// submitted the destination mint and Iris reports its `forwardTxHash`. The
// fund-account leg burns on Starknet via deposit_for_burn_with_hook("cctp-forward"),
// so Circle mints to the per-account EOA on Polygon FOR US — we never submit receiveMessage.
// Idempotent + resumable: a present forwardTxHash = done (e.g. after a tab reload
// the resume re-polls and immediately sees it). Before returning, the attested
// `message` is validated via assertCctpMessageMatches (a TRUSTED-Iris fund-safety
// gate, Bundle A1): even though Circle submits the mint, a tampered/MITM'd Iris
// could redirect funds, so we still assert source/destination domain + the
// expected per-account recipient. 404/5xx/429 retry handling mirrors waitForAttestation.
//
// `opts.sourceDomain` defaults to config.cctp.starknetDomain (the fund-account leg burns
// on Starknet); `opts.expectedMintRecipient` is the per-account EOA the mint must
// land on; `opts.expectedDestinationDomain` is the CCTP domain of the chosen bridge-OUT
// chain (defaults to the default destination's domain — Polygon).
export async function waitForForwardedMint(
  burnTxHash: string,
  opts: PollOpts & {
    sourceDomain?: number;
    expectedMintRecipient: string;
    expectedDestinationDomain?: number;
  },
): Promise<ForwardedMintResult> {
  const { starknetDomain } = config.cctp;
  const sourceDomain = opts.sourceDomain ?? starknetDomain;
  const destinationDomain =
    opts.expectedDestinationDomain ?? getDefaultEvmCctpDestination().domain;
  return pollIris<ForwardedMintResult>(
    burnTxHash,
    sourceDomain,
    (entry) => {
      // A present forwardTxHash IS the success signal: Circle's Forwarding Service
      // already submitted the destination mint on Polygon (no tx of ours), so the
      // mint has LANDED regardless of what we do next — done (idempotent across
      // resumes). The Forwarding-Service path legitimately returns forwardTxHash
      // with an EMPTY `message` (there is no relay message to deliver — Circle's
      // relayer minted directly), so gating on `message` would poll the full
      // deadline (default 30 min) and time out despite a completed mint (#67).
      if (entry && entry.forwardTxHash) {
        // FUND-SAFETY GATE (Bundle A1): when an attested `message` IS present,
        // validate it against the burn we issued — Iris is a trusted oblivious
        // service, so a redirected / tampered attestation must fail
        // (terminal) rather than report a forward to an attacker. The fund-account leg burns
        // on Starknet toward Polygon, minting to the per-account EVM EOA. When `message`
        // is absent (the Forwarding-Service shape), there is nothing to validate and
        // nothing of ours to gate — the return value is only a completion signal /
        // display hash, it drives no fund-moving action — so we accept the forward.
        if (entry.message) {
          assertCctpMessageMatches(entry.message, {
            expectedSourceDomain: starknetDomain,
            expectedDestinationDomain: destinationDomain,
            expectedRecipient: opts.expectedMintRecipient,
          });
        }
        return { forwardTxHash: entry.forwardTxHash };
      }
      return null;
    },
    opts,
    'Waiting for Circle to forward the Polygon mint',
    'waitForForwardedMint',
  );
}

// Combined attest → forwarded-mint leg (Slice F). The fund-account leg
// (fundAccountFromPool) and the cash-out leg (cashOut, Slice G) both need the SAME
// milestones — surface the attestation progress (and catch a terminal Iris status
// early), then wait for the mint Circle's Forwarding Service submits for us, gated
// on expectedMintRecipient via the A1 fund-safety check. This wrapper owns the
// sequence + the mint-recipient gate in ONE place.
//
// MERGED into a SINGLE Iris poll loop: attestation and forwardTxHash ride the SAME
// Iris message shape, so once the attestation is found we keep inspecting the SAME
// loop's responses for forwardTxHash instead of tearing down and restarting a fresh
// poll cycle (which re-paid the base interval from scratch — up to a full interval
// of dead latency between the two steps). `onAttested` still fires exactly once, the
// first poll the attestation completes, so a caller with a per-leg progress tracker
// can flip its attest step done + its mint step running; status callbacks route to
// onAttestStatus before that point and onMintStatus after.
//
// Idempotent + resumable: re-running with the same burnTxHash re-polls and — when
// the mint already landed — sees the attested pair + forwardTxHash on the FIRST read
// (attestation and forward captured in the same extract call, onAttested still fires).
// The A1 fund-safety gate on the forward-bearing message is UNCHANGED.
export interface WaitForBridgedMintOpts {
  // The per-account EVM recipient the forwarded mint MUST land on (the A1 gate).
  expectedMintRecipient: string;
  // CCTP source domain of the burn (defaults to config.cctp.starknetDomain — the
  // Starknet→Polygon fund/cash-out leg). Forwarded to BOTH pollers.
  sourceDomain?: number;
  // CCTP destination domain of the chosen bridge-OUT chain (the forwarded-mint
  // fund-safety gate). Defaults to the default destination's domain (Polygon).
  destinationDomain?: number;
  // Live attestation-poll status strings (waitForAttestation).
  onAttestStatus?: (s: string) => void;
  // Fires once, after the attestation resolves and before the forwarded-mint poll.
  onAttested?: () => void;
  // Live forwarded-mint-poll status strings (waitForForwardedMint).
  onMintStatus?: (s: string) => void;
  // Finality tier of the burn (config.cctp.fast). Selects the poll cadence for the
  // merged attest→mint loop (Fast ~1.5s vs Standard 5s) when no explicit intervalMs.
  fast?: boolean;
  // Deterministic-test knobs forwarded to the poller (no real waiting in tests).
  intervalMs?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface BridgedMintResult {
  // The destination mint tx Circle's Forwarding Service submitted on Polygon.
  forwardTxHash: `0x${string}`;
  // The attested CCTP message + signature (present via waitForAttestation). The
  // Forwarding-Service path may return an empty message on the forwarded-mint poll,
  // but waitForAttestation resolves the real attested pair first, so both are set.
  message?: `0x${string}`;
  attestation?: `0x${string}`;
}

export async function waitForBridgedMint(
  burnTxHash: string,
  opts: WaitForBridgedMintOpts,
): Promise<BridgedMintResult> {
  const { starknetDomain } = config.cctp;
  const sourceDomain = opts.sourceDomain ?? starknetDomain;
  const destinationDomain =
    opts.destinationDomain ?? getDefaultEvmCctpDestination().domain;

  // The attested pair, captured the FIRST poll it appears on. The Forwarding-Service
  // shape can later report forwardTxHash with an EMPTY message, so we must remember
  // the real attestation from the earlier poll rather than re-read it off the last one.
  let message: `0x${string}` | undefined;
  let attestation: `0x${string}` | undefined;
  // onAttested fires exactly once; afterwards status callbacks route to the mint step.
  let attestedFired = false;
  const fireAttested = (): void => {
    if (attestedFired) return;
    attestedFired = true;
    opts.onAttested?.();
  };

  const { forwardTxHash } = await pollIris<{ forwardTxHash: `0x${string}` }>(
    burnTxHash,
    sourceDomain,
    (entry) => {
      // Attestation milestone: capture the pair + flip to the mint step the first poll
      // a complete attestation appears, even if forwardTxHash is not present yet.
      if (!attestedFired && entry?.status === 'complete' && entry.message && entry.attestation) {
        message = entry.message;
        attestation = entry.attestation;
        fireAttested();
      }
      if (entry?.forwardTxHash) {
        // FUND-SAFETY GATE (Bundle A1) — UNCHANGED: validate the attested message on
        // the forward-bearing entry (when present) against the burn we issued before
        // trusting Circle's forward. An empty message (Forwarding-Service shape) has
        // nothing of ours to gate — it is only a completion signal / display hash.
        if (entry.message) {
          assertCctpMessageMatches(entry.message, {
            expectedSourceDomain: starknetDomain,
            expectedDestinationDomain: destinationDomain,
            expectedRecipient: opts.expectedMintRecipient,
          });
          // A forward-bearing entry that ALSO carries the attested pair (idempotent
          // resume / same-poll completion) may be the only poll we see — capture it.
          if (!message && entry.attestation) {
            message = entry.message;
            attestation = entry.attestation;
          }
        }
        // Guarantee onAttested fires before completion even when attestation and
        // forwardTxHash land on the SAME poll (resume: the mint already landed).
        fireAttested();
        return { forwardTxHash: entry.forwardTxHash };
      }
      return null;
    },
    {
      fast: opts.fast,
      intervalMs: opts.intervalMs,
      timeoutMs: opts.timeoutMs,
      backoffBaseMs: opts.backoffBaseMs,
      backoffCapMs: opts.backoffCapMs,
      sleep: opts.sleep,
      random: opts.random,
      // Route status to the attest step before the attestation completes, the mint
      // step after — one loop reported as two phases (the flip driven by onAttested).
      onStatus: (s) => (attestedFired ? opts.onMintStatus : opts.onAttestStatus)?.(s),
    },
    'Waiting for Circle attestation + forwarded mint',
    'waitForForwardedMint',
  );

  return { forwardTxHash, message, attestation };
}

// --- CCTP v2 message decoder (fund-safety gate, Bundle A1) -------------------
// We MUST NOT trust Iris's `message`/`forwardTxHash` unverified: Iris is a
// TRUSTED oblivious service (docs/threat-model.md), so a compromised / MITM'd Iris
// could hand back a message that redirects the mint to an attacker EOA or a
// different chain. Before accepting the forwarded mint we decode the message and
// assert it matches what bridgeOut burned: our Starknet source domain, the
// Polygon destination domain, and the expected per-account mint recipient.
//
// Byte layout — Circle CCTP v2 (MessageV2 header + BurnMessageV2 body),
// verified against a live attested Iris message (burn
// 0x2d3f…549b9) AND bridgeOut's deposit_for_burn:
//
//   MessageV2 header (148 bytes):
//     [0..4)    version                   uint32
//     [4..8)    sourceDomain              uint32   (Starknet = 25)
//     [8..12)   destinationDomain         uint32   (Polygon  = 7)
//     [12..44)  nonce                     bytes32
//     [44..76)  sender                    bytes32
//     [76..108) recipient                 bytes32
//     [108..140) destinationCaller        bytes32
//     [140..144) minFinalityThreshold     uint32
//     [144..148) finalityThresholdExecuted uint32
//   BurnMessageV2 body (starts at byte 148) — Circle BurnMessageV2.sol fixed
//   layout (all offsets relative to the body start; hookData is dynamic + last):
//     [+0..+4)    version                  uint32
//     [+4..+36)   burnToken                bytes32
//     [+36..+68)  mintRecipient            bytes32  (EVM addr = last 20 bytes)
//     [+68..+100) amount                   uint256
//     [+100..+132) messageSender           bytes32
//     [+132..+164) maxFee                  uint256
//     [+164..+196) feeExecuted             uint256
//     [+196..+228) expirationBlock         uint256
//     [+228..)     hookData                bytes (dynamic, last)
//   Only version/burnToken/mintRecipient/amount through mintRecipient are read
//   here; the trailing fixed fields + hookData are not needed for the gate.
const MSG_HEADER_LEN = 148;
const OFF_SOURCE_DOMAIN = 4;
const OFF_DEST_DOMAIN = 8;
// nonce is a bytes32 starting at header byte 12.
const OFF_NONCE = 12;
const NONCE_LEN = 32;
// mintRecipient is a 32-byte left-padded field; its EVM address is the last 20 bytes.
const OFF_MINT_RECIPIENT_FIELD = MSG_HEADER_LEN + 36;
const MINT_RECIPIENT_FIELD_LEN = 32;
const EVM_ADDR_LEN = 20;
// BurnMessageV2 body uint256 fields (offsets relative to the message start = header +
// the documented body offset above): the burned `amount` and the `feeExecuted` CCTP
// actually deducted. minted = amount − feeExecuted (see decodeCctpMintedAmount).
const OFF_BODY_AMOUNT = MSG_HEADER_LEN + 68;
const OFF_BODY_FEE_EXECUTED = MSG_HEADER_LEN + 164;
const U256_LEN = 32;

// Extract the 32-byte nonce from a CCTP v2 message header (bytes 12–44).
// Retained for callers that need the message nonce (e.g. idempotency keying).
function extractCctpNonce(message: `0x${string}`): `0x${string}` {
  const hex = message.startsWith('0x') ? message.slice(2) : message;
  return `0x${hex.slice(OFF_NONCE * 2, (OFF_NONCE + NONCE_LEN) * 2)}` as `0x${string}`;
}

export interface DecodedCctpMessage {
  sourceDomain: number;
  destinationDomain: number;
  // The 20-byte EVM mint recipient, lowercased 0x-hex (no checksum). Convenience
  // for the EVM-destination (fund-account) leg, whose recipient is an EVM address.
  mintRecipient: `0x${string}`;
  // The FULL 32-byte mintRecipient field, lowercased 0x-hex (64 hex digits, no
  // truncation). The Starknet-destination (deposit-in) leg needs the whole word
  // because a Starknet felt occupies up to 32 bytes (not the last-20-bytes EVM form).
  mintRecipientFull: `0x${string}`;
}

// Read a big-endian uint32 from a hex-byte view at byte offset `byteOff`.
function readUint32BE(hex: string, byteOff: number): number {
  const start = byteOff * 2;
  return parseInt(hex.slice(start, start + 8), 16);
}

// Read a big-endian uint256 from a hex-byte view at byte offset `byteOff`.
function readUint256BE(hex: string, byteOff: number): bigint {
  const start = byteOff * 2;
  return BigInt(`0x${hex.slice(start, start + U256_LEN * 2)}`);
}

// The ACTUAL amount a CCTP v2 burn mints on the destination = burned `amount` −
// `feeExecuted`, BOTH read from the attested BurnMessageV2 body (mainnet blocker):
// the pre-submit `maxFee` is only a CAP/estimate, so on a nonzero Fast fee — or a
// Fast-requested/Standard-executed tier mismatch — `minted` differs from
// `amount − maxFee`, and sizing an approve/pool-pull to the gross burn (or the
// maxFee estimate) over-states the balance the pool can pull → the `apply_action`
// reverts. Callers on the atomic fold path (which can't read a post-mint balance)
// MUST size the deposit approve + pull to THIS value. Returns null when the message
// is too short to contain the fee field (a truncated/legacy blob) so callers fall
// back to their maxFee estimate (no worse than before); also null if the message is
// non-hex or the decoded amounts are degenerate (amount 0 or fee ≥ amount).
export function decodeCctpMintedAmount(message: `0x${string}`): bigint | null {
  const hex = message.startsWith('0x') ? message.slice(2) : message;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const byteLen = hex.length / 2;
  if (byteLen < OFF_BODY_FEE_EXECUTED + U256_LEN) return null;
  const amount = readUint256BE(hex, OFF_BODY_AMOUNT);
  const feeExecuted = readUint256BE(hex, OFF_BODY_FEE_EXECUTED);
  if (amount === 0n || feeExecuted > amount) return null;
  return amount - feeExecuted;
}

// Decode the minimum CCTP-v2 fields needed to gate the mint: source/destination
// domain (header) and the burn-body mint recipient. `message` is the raw Iris
// bytes (0x-hex). Throws if the message is too short to contain the burn body.
export function decodeCctpMessage(message: `0x${string}`): DecodedCctpMessage {
  const hex = message.startsWith('0x') ? message.slice(2) : message;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    // Reject non-hex AND odd-nibble strings so the decoder is total: an odd
    // length would yield a fractional byteLen and silently mis-slice fields.
    throw new Error('CCTP message is not valid hex — refusing to submit.');
  }
  const byteLen = hex.length / 2;
  const minLen = OFF_MINT_RECIPIENT_FIELD + MINT_RECIPIENT_FIELD_LEN;
  if (byteLen < minLen) {
    throw new Error(
      `CCTP message too short (${byteLen} bytes, need ≥ ${minLen}) — refusing to submit.`,
    );
  }
  // Version gate (Bundle A1): both the MessageV2 header version [0..4) and the
  // BurnMessageV2 body version [+0..+4) must be 1 — a tampered/MITM'd Iris message
  // (or a future CCTP layout change) with a different version would otherwise
  // silently decode against the wrong field offsets.
  if (readUint32BE(hex, 0) !== 1) {
    throw new Error('Unsupported CCTP message version (header) — refusing to submit.');
  }
  if (readUint32BE(hex, MSG_HEADER_LEN) !== 1) {
    throw new Error('Unsupported CCTP message version (body) — refusing to submit.');
  }
  const sourceDomain = readUint32BE(hex, OFF_SOURCE_DOMAIN);
  const destinationDomain = readUint32BE(hex, OFF_DEST_DOMAIN);
  // Full 32-byte mintRecipient field (left-padded). The SN-destination leg needs
  // the whole word; the EVM leg uses the last 20 bytes as its address convenience.
  const fieldStart = OFF_MINT_RECIPIENT_FIELD * 2;
  const fieldHex = hex.slice(fieldStart, fieldStart + MINT_RECIPIENT_FIELD_LEN * 2).toLowerCase();
  const mintRecipientFull = `0x${fieldHex}` as `0x${string}`;
  // EVM address = last 20 bytes of the 32-byte left-padded mintRecipient field.
  // (148 header + 36 body offset + 32 field − 20 addr = byte 196 = hex index 392.)
  const mintRecipient = `0x${fieldHex.slice((MINT_RECIPIENT_FIELD_LEN - EVM_ADDR_LEN) * 2)}` as `0x${string}`;
  return { sourceDomain, destinationDomain, mintRecipient, mintRecipientFull };
}

// Normalize an expected mint recipient (EVM-20 or Starknet felt-32) to the
// matching decoded field for comparison. Returns the lowercased hex body (no
// 0x) plus which decoded field to compare against:
//   - a ≤20-byte (≤40-hex) value is an EVM address → compare the decoded 20-byte
//     `mintRecipient` (the fund-account leg's per-account EOA);
//   - a longer value (a Starknet felt) is compared against the FULL 32-byte
//     `mintRecipientFull`, both zero-left-padded to 64 hex so e.g. 0x49abc and
//     its 32-byte form match.
function normalizeExpectedRecipient(expected: string): { hex: string; full: boolean } {
  const body = expected.replace(/^0x/i, '').toLowerCase();
  if (body.length <= EVM_ADDR_LEN * 2) {
    return { hex: body.padStart(EVM_ADDR_LEN * 2, '0'), full: false };
  }
  return { hex: body.padStart(MINT_RECIPIENT_FIELD_LEN * 2, '0'), full: true };
}

// Assert a decoded attested message matches the burn we actually issued. Throws
// a DISTINCT, NON-transient error (classified TERMINAL by isTransientError via
// `recipient/domain mismatch`) so a tampered/redirected attestation fails
// safely instead of resume-looping.
//
// Shared by BOTH CCTP legs (Bundle A1, full symmetry):
//   - fund-account leg (Starknet→Polygon): expectedDestinationDomain = polygonDomain,
//     expectedSourceDomain = starknetDomain, recipient = the per-account EVM EOA;
//   - deposit-in leg (Polygon→Starknet): expectedDestinationDomain =
//     starknetDomain, expectedSourceDomain = the EVM source's domain, recipient
//     = the derived SN account (a felt → compared on the full 32-byte field).
// `expectedRecipient` is compared case-insensitively; an EVM-20 value matches
// the decoded 20-byte recipient, a longer (felt) value the full 32-byte field.
export function assertCctpMessageMatches(
  message: `0x${string}`,
  opts: {
    expectedSourceDomain: number;
    expectedDestinationDomain: number;
    expectedRecipient: string;
  },
): void {
  const decoded = decodeCctpMessage(message);
  const { hex, full } = normalizeExpectedRecipient(opts.expectedRecipient);
  const actual = (full ? decoded.mintRecipientFull : decoded.mintRecipient).slice(2);
  if (
    decoded.sourceDomain !== opts.expectedSourceDomain ||
    decoded.destinationDomain !== opts.expectedDestinationDomain ||
    actual !== hex
  ) {
    throw new Error(
      'CCTP message recipient/domain mismatch — refusing to submit (possible attestation tampering).',
    );
  }
}

// Retained for callers needing the message nonce; not used internally now that
// the fund-account leg no longer submits receiveMessage (Forwarding Service does).
export { extractCctpNonce };
