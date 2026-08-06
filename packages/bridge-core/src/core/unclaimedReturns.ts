// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Unclaimed returns — detection of return legs whose final FOLDED claim never ran.
// The return burn commits the USDC to CCTP and persists a burn cursor
// (pmp.inflightReturn); the folded pool claim (bridgeBack.ts) then mints + claims it in
// one atomic tx. If that claim fails AFTER the burn (a paymaster rejection, a closed
// tab), the cursor lingers as "burned, awaiting claim". This scan surfaces those
// cursors as claimable hits.
//
// FOLD-ONLY / CURSOR-DRIVEN (was claimable_of): the fold-only InboundAnonymizer has NO
// per-commitment on-chain ledger to read, and the folded claim needs the CCTP
// message/attestation — obtainable ONLY from the persisted burn tx via Iris. So there
// is no cross-device on-chain scan anymore: detection is per-device, from the burn
// cursor. We match each probed account index's commitment (re-derived from the session
// signature exactly as returnToPool carried it in the burn hookData) against this
// device's post-burn cursors, so a hit belongs to THIS identity. Claiming a hit is
// recoverBridgeIn (returnIn.ts), which re-fetches the attestation and re-checks the CCTP
// nonce idempotently (a hit already claimed elsewhere degrades to a harmless no-op).
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
import { config } from './config';
import { listInflightReturns } from './returnIn';

// Corrupt-counter insurance ONLY — never the practical bound. accountIndexCount comes
// from a localStorage-backed counter, so a corrupt-but-integer value (e.g. 1e12) must
// not turn one sweep into an endless derive loop. It bounds the WINDOW SIZE of a single
// sweep (startIndex + this), not the absolute index — the resume cursor still covers
// arbitrarily high indices across successive sweeps. A clamped sweep reports
// truncated=true (see below) so the caller keeps advancing rather than wrapping to 0.
export const MAX_CLAIMABLE_SCAN_INDICES = 20_000;

export interface UnclaimedReturn {
  // The per-bid account index whose return leg burned the funds (feeds recoverBridgeIn
  // as-is).
  accountIndex: number;
  // The burned amount awaiting claim (deposit-token wei), from the persisted cursor.
  amountWei: bigint;
}

export interface ScanUnclaimedReturnsArgs {
  signature: string;
  // The account CHANNEL is NOT an arg: this sweep re-derives each commitment against every
  // channel seen across this device's cursors (like it does for the burn-time inbound +
  // source domain), so ONE sweep covers all channels' stuck returns — the caller never
  // enumerates channels. undefined (the default channel) is included when a default cursor
  // is present.
  //
  // Probe indices [startIndex, accountIndexCount) — pass the account's next-unused
  // index (index allocation is monotonic, so every lower index may have run a return).
  // Zero or negative → nothing to scan.
  accountIndexCount: number;
  // Resume point for a sweep previously cut by the window clamp (callers persist the
  // last `probedEnd` and wrap to 0 once a sweep reaches the end). Defaults to 0.
  startIndex?: number;
  // Accepted for signature compatibility with the old on-chain scan. This scan is a
  // cheap synchronous localStorage read, so it never actually times out. Unused.
  timeoutMs?: number;
  // Called once after the (single, local) sweep with (probedEnd, totalCount).
  onProgress?: (probedThroughIndex: number, totalCount: number) => void;
}

export interface ScanUnclaimedReturnsResult {
  // Post-burn cursor hits within the probed window, in index order.
  unclaimedReturns: UnclaimedReturn[];
  // The window [probedStart, probedEnd) that was actually read this run. Callers merging
  // into a cache must treat ONLY that window as authoritative.
  probedStart: number;
  probedEnd: number;
  // True when the window clamp cut the sweep short of accountIndexCount.
  truncated: boolean;
}

// Probes account indices for a burned-but-unclaimed return by matching each index's
// commitment against this device's post-burn cursors. Returns only positive hits, plus
// the window actually covered. Never throws (a corrupt/disabled localStorage reads as
// "nothing in flight" via listInflightReturns).
export async function scanUnclaimedReturns(
  args: ScanUnclaimedReturnsArgs,
): Promise<ScanUnclaimedReturnsResult> {
  const { signature, onProgress } = args;
  const inbound = config.inboundAnonymizerAddress;
  const probedStart = Math.max(0, args.startIndex ?? 0);
  // The clamp bounds this sweep's WINDOW, not the absolute index. A clamped sweep must
  // report truncated=true even when it finishes its window — claiming completeness would
  // make the caller wrap its resume cursor to 0 and skip the indices beyond the clamp
  // (audit on #350).
  const accountIndexCount = Math.min(
    args.accountIndexCount,
    probedStart + MAX_CLAIMABLE_SCAN_INDICES,
  );
  const clampedByMax = args.accountIndexCount > accountIndexCount;
  // FAIL CLOSED on the '0x0' string placeholder (mirrors claimToPool's guard).
  if (!inbound || inbound === '0x0' || accountIndexCount <= probedStart) {
    return { unclaimedReturns: [], probedStart, probedEnd: probedStart, truncated: false };
  }

  // Same derivation chain as recoverBridgeIn/returnToPool (in-memory only; the keys are
  // never logged or persisted).
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);

  // Index this device's post-burn cursors by commitment (decimal-encoded felt). A cursor
  // exists ⟺ we burned and the folded claim has not been confirmed cleared.
  const cursorByCommitment = new Map<string, bigint>();
  // The commitment binds the burn-time InboundAnonymizer address. A cursor whose burn
  // predates a config `inboundAnonymizerAddress` redeploy pins the OLD address, so probing
  // with only the current config address would MISS it (its funds sit on the old contract).
  // Probe every burn-time address seen across cursors PLUS current config.
  const candidateInbounds = new Set<string>([inbound]);
  // The commitment also binds the burn-time CCTP SOURCE domain, so the probe must try
  // every source domain seen across cursors (a return can leave from Polygon 7/Base 6/…).
  const candidateSourceDomains = new Set<number>();
  // The commitment also binds the account CHANNEL (via the nonce), so the probe must try
  // every channel seen across cursors — including undefined (the default) when present.
  const candidateChannels = new Set<string | undefined>();
  for (const { record } of listInflightReturns()) {
    // A malformed amount (should not happen — isValidInflightReturn guarantees a decimal
    // string) is skipped rather than throwing the whole sweep.
    try {
      cursorByCommitment.set(record.commitment, BigInt(record.amount));
    } catch {
      // ignore a corrupt entry.
    }
    if (record.inboundAnonymizer) candidateInbounds.add(record.inboundAnonymizer);
    candidateSourceDomains.add(record.sourceDomain);
    candidateChannels.add(record.channel);
  }

  const unclaimedReturns: UnclaimedReturn[] = [];
  if (cursorByCommitment.size > 0) {
    for (let accountIndex = probedStart; accountIndex < accountIndexCount; accountIndex++) {
      // Each channel at this index is a DISTINCT account with its own commitment, so probe
      // every candidate channel and collect a hit for EACH — do NOT stop at the first
      // channel (different channels can leave separate stuck returns at the same index; the
      // burn cursor's single-slot-per-address invariant makes that rare, but a recovery scan
      // must never hide a stranded return).
      for (const candidateChannel of candidateChannels) {
        // The nonce depends on the channel, so derive it per candidate channel. A corrupt
        // cursor channel throws in deriveAccountNonce → skip that candidate (never the sweep).
        let nonce: bigint;
        try {
          nonce = deriveAccountNonce(viewingKey, accountIndex, candidateChannel);
        } catch {
          continue;
        }
        // inbound × source_domain are ALTERNATIVE bindings for THIS (index, channel) cursor,
        // so the first match is that cursor — stop probing combos for this channel, then move
        // on to the next channel.
        channelHit: for (const candidateInbound of candidateInbounds) {
          for (const candidateSourceDomain of candidateSourceDomains) {
            // userPrivateKey MUST be the VIEWING key — the pool's proven identity key (see
            // returnToPool's bind-time comment; the probe must match the SAME commitment the
            // burn carried and the folded claim asserts). The commitment also binds the
            // burn-time source domain + channel, so probe each candidate (channel × inbound ×
            // source_domain).
            const commitment = deriveInboundCommitment({
              userAddr: BigInt(snAddress),
              userPrivateKey: viewingKey,
              inboundAddr: BigInt(candidateInbound),
              sourceDomain: candidateSourceDomain,
              nonce,
            });
            const amountWei = cursorByCommitment.get(commitment.toString());
            if (amountWei !== undefined && amountWei > 0n) {
              unclaimedReturns.push({ accountIndex, amountWei });
              break channelHit;
            }
          }
        }
      }
    }
  }
  onProgress?.(accountIndexCount, accountIndexCount);
  return { unclaimedReturns, probedStart, probedEnd: accountIndexCount, truncated: clampedByMax };
}
