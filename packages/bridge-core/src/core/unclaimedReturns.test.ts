// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the FOLD-ONLY unclaimed-returns scan: it is now a CURSOR-DRIVEN local
// read (no on-chain claimable_of fan-out — the fold-only InboundAnonymizer has no
// per-commitment ledger to scan). It derives each probed account index's commitment
// (real derivation) and matches it against this device's persisted post-burn cursors,
// surfacing the frozen amount as the claimable hit. No RPC.

import { initTestConfig } from '../../vitest.setup';
import { config } from './config';
import { spyOnSecretSinks } from './__testkit__/secretSinks';
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
import { INFLIGHT_RETURN_KEY } from './returnIn';
import { MAX_CLAIMABLE_SCAN_INDICES, scanUnclaimedReturns } from './unclaimedReturns';

// Any 65-byte-style hex works — the derivation chain only hashes it.
const SIGNATURE = `0x${'ab'.repeat(65)}`;

// The commitment this identity's return for `index` would carry in its burn hookData —
// the exact string the scan matches a persisted cursor against. Mirrors returnToPool's
// derivation (VIEWING key as the pool identity private key).
function commitmentFor(index: number): string {
  const viewingKey = deriveViewingKey(SIGNATURE);
  const snPrivateKey = deriveStarknetPrivateKey(SIGNATURE);
  const { address } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  return deriveInboundCommitment({
    userAddr: BigInt(address),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(config.inboundAnonymizerAddress),
    sourceDomain: config.polygon.domain,
    nonce: deriveAccountNonce(viewingKey, index),
  }).toString();
}

// Seed a post-burn cursor (keyed by an arbitrary EVM address — the scan matches by
// commitment, not by address) for the given account index + amount.
function seedCursor(evmKey: string, index: number, amountWei: bigint): void {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[evmKey.toLowerCase()] = {
    accountIndex: index,
    burnTx: '0x0ab12cd34e',
    sourceDomain: config.polygon.domain,
    amount: amountWei.toString(),
    commitment: commitmentFor(index),
    evmChainId: config.polygon.chainId,
  };
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
}

// A cursor whose burn predates a config redeploy: it pins an OLD inbound address and its
// commitment is derived against THAT old address (not the current config).
function seedRedeployCursor(evmKey: string, index: number, amountWei: bigint, oldInbound: string): void {
  const viewingKey = deriveViewingKey(SIGNATURE);
  const snPrivateKey = deriveStarknetPrivateKey(SIGNATURE);
  const { address } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const commitment = deriveInboundCommitment({
    userAddr: BigInt(address),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(oldInbound),
    sourceDomain: config.polygon.domain,
    nonce: deriveAccountNonce(viewingKey, index),
  }).toString();
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[evmKey.toLowerCase()] = {
    accountIndex: index,
    burnTx: '0x0ab12cd34e',
    sourceDomain: config.polygon.domain,
    amount: amountWei.toString(),
    commitment,
    evmChainId: config.polygon.chainId,
    inboundAnonymizer: oldInbound,
  };
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
}

// A cursor for a return burned from a non-default account CHANNEL: its commitment is
// derived with the channel folded into the account nonce, and the channel is persisted on
// the cursor. The scan must re-derive with THIS channel (read from the cursor) to match —
// so it self-routes without the caller ever supplying the channel.
function seedChannelCursor(evmKey: string, index: number, amountWei: bigint, channel: string): void {
  const viewingKey = deriveViewingKey(SIGNATURE);
  const snPrivateKey = deriveStarknetPrivateKey(SIGNATURE);
  const { address } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const commitment = deriveInboundCommitment({
    userAddr: BigInt(address),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(config.inboundAnonymizerAddress),
    sourceDomain: config.polygon.domain,
    nonce: deriveAccountNonce(viewingKey, index, channel),
  }).toString();
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[evmKey.toLowerCase()] = {
    accountIndex: index,
    burnTx: '0x0ab12cd34e',
    sourceDomain: config.polygon.domain,
    amount: amountWei.toString(),
    commitment,
    evmChainId: config.polygon.chainId,
    channel,
  };
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  initTestConfig({ INBOUND_ANONYMIZER_ADDRESS: '0x49abc' });
});

afterEach(() => {
  localStorage.clear();
});

describe('scanUnclaimedReturns (cursor-driven)', () => {
  it('returns [] when accountIndexCount is 0', async () => {
    await expect(
      scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 0 }),
    ).resolves.toEqual({ unclaimedReturns: [], probedStart: 0, probedEnd: 0, truncated: false });
  });

  it('returns [] when the inbound anonymizer is the 0x0 placeholder', async () => {
    initTestConfig({ INBOUND_ANONYMIZER_ADDRESS: '0x0' });
    await expect(
      scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 3 }),
    ).resolves.toEqual({ unclaimedReturns: [], probedStart: 0, probedEnd: 0, truncated: false });
  });

  it('returns [] when there are no persisted cursors (nothing burned on this device)', async () => {
    await expect(
      scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 }),
    ).resolves.toMatchObject({ unclaimedReturns: [], probedEnd: 5, truncated: false });
  });

  it('surfaces post-burn cursors as hits (matched by per-index commitment), in index order', async () => {
    // Cursors for index 1 (250 wei) and index 3 (42 wei); the rest have none.
    seedCursor('0xaaa', 1, 250n);
    seedCursor('0xbbb', 3, 42n);
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    expect(scanResult).toEqual({
      unclaimedReturns: [
        { accountIndex: 1, amountWei: 250n },
        { accountIndex: 3, amountWei: 42n },
      ],
      probedStart: 0,
      probedEnd: 5,
      truncated: false,
    });
  });

  it('[channel] self-routes on a channel cursor — found WITHOUT a channel arg (Finding 1)', async () => {
    // A return burned from a 'fast-session' channel at index 2. The scan takes NO channel
    // arg; it must read the channel off the cursor and re-derive the commitment in that
    // keyspace, else the burned USDC would be stranded (a default-nonce probe never matches).
    seedChannelCursor('0xccc', 2, 777n, 'fast-session');
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    expect(scanResult.unclaimedReturns).toEqual([{ accountIndex: 2, amountWei: 777n }]);
  });

  it('[channel] one channel-blind sweep surfaces BOTH a default and a channel cursor', async () => {
    // A default-channel return at index 1 and a 'fast-session' return at index 3 are DISTINCT
    // accounts (distinct commitments). A single sweep with no channel arg must find both,
    // proving candidate-channel iteration covers every channel present on-device without the
    // caller enumerating them.
    seedCursor('0xaaa', 1, 100n);
    seedChannelCursor('0xbbb', 3, 200n, 'fast-session');
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    expect(scanResult.unclaimedReturns).toEqual([
      { accountIndex: 1, amountWei: 100n },
      { accountIndex: 3, amountWei: 200n },
    ]);
  });

  it('[channel] surfaces BOTH cursors at the SAME index in different channels (no stop-at-first-channel)', async () => {
    // Two DISTINCT accounts collide on index 2: the default channel (100n) and 'fast-session'
    // (200n), each with its own commitment. A recovery scan must surface BOTH — stopping at
    // the first channel hit would hide one stranded return (bugbot: "Scan stops at first
    // channel").
    seedCursor('0xaaa', 2, 100n);
    seedChannelCursor('0xbbb', 2, 200n, 'fast-session');
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    const amountsAtIndex2 = scanResult.unclaimedReturns
      .filter((u) => u.accountIndex === 2)
      .map((u) => u.amountWei)
      .sort();
    expect(amountsAtIndex2).toEqual([100n, 200n]);
  });

  it('[config redeploy] surfaces a cursor whose burn predates a config change (matched via the burn-time inbound)', async () => {
    // FINDING A: config is now the NEW address ('0x49abc') but this cursor's burn pinned the
    // OLD one — its commitment is derived against the OLD address. Deriving with ONLY the
    // current config would MISS it; the scan must also probe every burn-time address seen.
    const OLD_INBOUND = '0xbeef01';
    seedRedeployCursor('0xaaa', 2, 500n, OLD_INBOUND);
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    expect(scanResult.unclaimedReturns).toEqual([{ accountIndex: 2, amountWei: 500n }]);
  });

  it('does NOT surface a cursor whose commitment belongs to a DIFFERENT identity', async () => {
    // A cursor with a bogus commitment (not derivable from THIS signature) is ignored.
    const raw = JSON.stringify({
      '0xccc': {
        accountIndex: 2,
        burnTx: '0x0ab12cd34e',
        sourceDomain: config.polygon.domain,
        amount: '999',
        commitment: '123456789',
        evmChainId: config.polygon.chainId,
      },
    });
    localStorage.setItem(INFLIGHT_RETURN_KEY, raw);
    const scanResult = await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 5 });
    expect(scanResult.unclaimedReturns).toEqual([]);
  });

  it('resumes from startIndex and reports the probed window (sweep-cursor support)', async () => {
    seedCursor('0xaaa', 8, 100n); // inside [7, 12)
    seedCursor('0xbbb', 3, 100n); // BELOW the window → not surfaced this run
    const scanResult = await scanUnclaimedReturns({
      signature: SIGNATURE,
      accountIndexCount: 12,
      startIndex: 7,
    });
    expect(scanResult).toMatchObject({ probedStart: 7, probedEnd: 12, truncated: false });
    expect(scanResult.unclaimedReturns.map((hit) => hit.accountIndex)).toEqual([8]);
  });

  it('reports truncated=true when the corrupt-counter clamp cuts the window (cursor must not wrap)', async () => {
    // No cursors seeded → the derivation loop is skipped (fast); only the clamp/flag is
    // under test. A huge count clamps to MAX and must report truncated so the caller
    // keeps advancing rather than wrapping to 0.
    const scanResult = await scanUnclaimedReturns({
      signature: SIGNATURE,
      accountIndexCount: MAX_CLAIMABLE_SCAN_INDICES + 5,
    });
    expect(scanResult.truncated).toBe(true);
    expect(scanResult.probedEnd).toBe(MAX_CLAIMABLE_SCAN_INDICES);
  });

  it('reports progress once with the probed window total', async () => {
    const progressCalls: Array<[number, number]> = [];
    await scanUnclaimedReturns({
      signature: SIGNATURE,
      accountIndexCount: 6,
      onProgress: (probed, total) => progressCalls.push([probed, total]),
    });
    expect(progressCalls).toEqual([[6, 6]]);
  });

  it('never logs or persists the raw signature or any derived private key', async () => {
    seedCursor('0xaaa', 1, 100n);
    const sinks = spyOnSecretSinks();
    try {
      await scanUnclaimedReturns({ signature: SIGNATURE, accountIndexCount: 3 });
    } finally {
      sinks.restore();
    }
    sinks.assertNeverLeaked(
      SIGNATURE,
      deriveStarknetPrivateKey(SIGNATURE),
      deriveViewingKey(SIGNATURE).toString(),
    );
  });
});
