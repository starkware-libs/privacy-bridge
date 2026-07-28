// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// On-ramp settlement poll — the authoritative "funds landed" check for the card
// funding flow. Moved out of apps/web (IdentityContext) so ALL bridging logic lives
// in bridge-core: useOnrampFunding now uses this by DEFAULT (the waitForBalance dep
// stays as an optional test seam). The app defines no poll loop of its own.
//
// Polls the derived account's deposit-token (USDC) balance until it grows by
// `targetWei` ABOVE `baselineWei`. The funding widget's success event only decides
// WHEN to start polling; this on-chain DELTA is the sole truth. `baselineWei` is the
// balance captured JUST BEFORE the widget opens, so an account that ALREADY holds
// >= targetWei (e.g. residual from a prior flow) can't resolve the poll on
// pre-existing funds — only genuinely NEW funds landing (balance >= baseline +
// target) satisfies the wait.

import { getDepositTokenBalance } from './deposit';
import { isTransientError } from './errors';

// Generous deadline for the settlement poll. Card/bank settlement runs through the
// on-ramp provider and can take MINUTES (KYC, payment rails), far longer than an L2
// commit — so this is ~12 min. Documented default; overridable via the poll's
// `deadlineMs` argument (and the useOnrampFunding `deadlineMs` dep).
export const ONRAMP_POLL_DEADLINE_MS = 720_000;

// Bounded grace window the close/cancel path uses to reconcile a payment that may
// have settled right as the user dismissed the widget. Far shorter than the full
// poll deadline — not waiting for a fresh payment, only catching one already (or
// about to be) on-chain. Documented default; overridable via the useOnrampFunding
// `graceMs` dep.
export const ONRAMP_CLOSE_GRACE_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDepositTokenBalance(
  snAddress: string,
  targetWei: bigint,
  baselineWei: bigint,
  onStatus: (m: string) => void,
  // Override the poll deadline. Defaults to the full ~12-min on-ramp window; the
  // close/cancel grace path passes a SHORT deadline (ONRAMP_CLOSE_GRACE_MS) to
  // reconcile an already-settling payment without blocking idle for minutes.
  deadlineMs: number = ONRAMP_POLL_DEADLINE_MS,
): Promise<void> {
  const requiredWei = baselineWei + targetWei;
  const deadline = Date.now() + deadlineMs;
  for (let waited = false; ; waited = true) {
    try {
      if ((await getDepositTokenBalance(snAddress)) >= requiredWei) return;
    } catch (err) {
      // The card/bank payment may have ALREADY settled by the time a transient RPC
      // blip (rate-limit, 5xx, network hiccup) hits a balance read — propagating it
      // would abandon a flow whose money is already spent. Swallow transient reads
      // and keep polling until the deadline; only a terminal error aborts.
      if (!isTransientError(err) || Date.now() > deadline) throw err;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the card payment to deliver USDC.');
    }
    if (!waited) onStatus('Waiting for your card payment to deliver USDC…');
    await sleep(2500);
  }
}
