// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Call, RpcProvider } from 'starknet';

// Unit test for the serialized manager-nonce manager in proven-submit.ts.
//
// THE INVARIANTS (maintainer constraint — see proven-submit.ts header):
//   (a) SEED ONCE: the chain nonce is read exactly once to seed the local counter;
//       sequential back-to-back submits then use N, N+1, N+2 with NO further RPC
//       reads (a just-pre-confirmed tx does NOT advance the RPC nonce, so re-reading
//       would re-use the stale value and collide — the diagnosed code-52 bug).
//   (b) SERIALIZED: concurrent managerExecute calls are run one-at-a-time, so no two
//       submits ever grab the same nonce (a deposit fires an approve + the proven
//       invoke in quick succession).
//   (c) CODE-52 RECOVERS IN-CALL: a rejected nonce (code 52) is reusable, so the call
//       re-reads at pre_confirmed and RETRIES in-place (bounded by MAX_NONCE_RETRIES),
//       surfacing SUCCESS — no settlement wait (the rejected tx never advances the
//       chain nonce, so polling for it to "catch up" would always time out).
//   (d) NON-NONCE FAILURE RE-SEEDS, DOESN'T ADVANCE: account.execute returns at SUBMIT
//       time (pre-acceptance), so a non-nonce throw (balance/RPC/network) did NOT consume
//       the nonce. The counter is invalidated (not advanced) so the next submit re-seeds
//       settlement-guarded — advancing would skip a nonce → a spurious code-52 next flow.
//       (A true on-chain revert never reaches this catch; it surfaces later via the
//       receipt poll, after execute already returned a tx hash.)
//   (e) SETTLEMENT-GUARDED RE-SEED IS THE FALLBACK: only a PERSISTENT code-52 (after
//       MAX_NONCE_RETRIES) invalidates the counter so the next submit re-seeds, WAITING
//       for the chain nonce to catch up past the last-used nonce before trusting it.
//
// We mock the manager Account (execute + getNonce) and reset the module-level counter
// before each test via the exported invalidateManagerNonce().

// The mock manager Account: execute records the explicit nonce it was handed; getNonce
// seeds the local counter. makeAccount resolves to this regardless of args.
const execute = vi.fn(async (_call: Call, _details: Record<string, unknown>) => ({
  transaction_hash: '0xhash',
}));
// Account.getNonce returns a felt; the manager-nonce manager wraps it in BigInt(),
// so the test may resolve either a hex string ('0x1a') or a bigint (5n).
const getNonce = vi.fn(async (_tag?: string): Promise<string | bigint> => '0x0');
const managerAccount = { execute, getNonce } as unknown as Account;
vi.mock('./provider', () => ({
  getRpcProvider: () => ({}) as unknown as RpcProvider,
  makeAccount: () => managerAccount,
}));

import { invalidateManagerNonce, managerExecute } from './proven-submit';

const provider = {} as unknown as RpcProvider;
const CALL: Call = { contractAddress: '0xpool', entrypoint: 'approve', calldata: [] };

// The nonce explicitly handed to each execute call, in call order.
function noncesUsed(): bigint[] {
  return execute.mock.calls.map((c) => (c[1] as { nonce: bigint }).nonce);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  execute.mockResolvedValue({ transaction_hash: '0xhash' });
  getNonce.mockResolvedValue('0x0');
  invalidateManagerNonce(); // cold-reset the module counter
});

describe('managerExecute — seed once, local-authoritative', () => {
  it('(a) reads the chain nonce ONCE, then sequential submits use N, N+1, N+2 with no further RPC reads', async () => {
    getNonce.mockResolvedValue('0x1a'); // 26 — seed value

    await managerExecute(provider, CALL);
    await managerExecute(provider, CALL);
    await managerExecute(provider, CALL);

    // Exactly ONE chain read for the whole sequence (the seed) — never re-read.
    expect(getNonce).toHaveBeenCalledTimes(1);
    // Sequential explicit nonces from the single seed.
    expect(noncesUsed()).toEqual([26n, 27n, 28n]);
  });

  it('does NOT do max(rpcNonce, local): a stale-but-LOWER chain read after seeding never lowers the counter', async () => {
    getNonce.mockResolvedValue('0x5'); // seed = 5
    await managerExecute(provider, CALL); // uses 5, counter -> 6
    // Simulate the pre-confirmed lag: the RPC now reports an OLD, lower nonce.
    getNonce.mockResolvedValue('0x0');
    await managerExecute(provider, CALL); // must use 6, NOT re-read / drop to 0
    await managerExecute(provider, CALL); // must use 7

    expect(noncesUsed()).toEqual([5n, 6n, 7n]);
    // Still only the single seeding read — the lower value was never consulted.
    expect(getNonce).toHaveBeenCalledTimes(1);
  });
});

describe('managerExecute — serialized (async mutex)', () => {
  it('(b) concurrent submits are serialized: each gets a DISTINCT, sequential nonce', async () => {
    getNonce.mockResolvedValue('0x64'); // 100
    // A gate that lets us hold execute mid-flight so two managerExecute overlap if the
    // mutex is broken. Each execute waits on its own micro-delay before resolving.
    const resolves: Array<() => void> = [];
    execute.mockImplementation(
      (_call: Call, _details: Record<string, unknown>) =>
        new Promise((resolve) => {
          resolves.push(() => resolve({ transaction_hash: '0xhash' }));
        }),
    );

    // Fire three concurrently — do NOT await between them.
    const p1 = managerExecute(provider, CALL);
    const p2 = managerExecute(provider, CALL);
    const p3 = managerExecute(provider, CALL);

    // Drain: only the head should have started (serialized), so release in order.
    // Poll the microtask queue until each pending execute appears, then resolve it.
    for (let i = 0; i < 3; i++) {
      // allow the chained run to reach execute()
      for (let spins = 0; spins < 50 && resolves.length <= i; spins++) {
        await Promise.resolve();
      }
      resolves[i]?.();
    }
    await Promise.all([p1, p2, p3]);

    // Three distinct sequential nonces, no duplicates — the mutex held.
    expect(noncesUsed()).toEqual([100n, 101n, 102n]);
    expect(new Set(noncesUsed()).size).toBe(3);
    expect(getNonce).toHaveBeenCalledTimes(1); // seeded once for the whole batch
  });
});

describe('managerExecute — code-52 in-call recovery (no settlement wait)', () => {
  it('(#1) one code-52 then success: re-reads at pre_confirmed and retries IN-CALL, no re-wait', async () => {
    getNonce.mockResolvedValue('0x0'); // seed = 0
    await managerExecute(provider, CALL); // uses 0, counter -> 1
    expect(getNonce).toHaveBeenCalledTimes(1);

    // Next submit's first attempt is REJECTED with code 52. The rejected nonce (1) is
    // reusable: managerExecute re-reads the nonce at pre_confirmed and retries in the
    // SAME call — surfacing SUCCESS — WITHOUT entering the settlement-guarded re-seed.
    getNonce.mockResolvedValue('0x1'); // corrected nonce on the re-read
    execute
      .mockRejectedValueOnce(new Error('code 52: Invalid transaction nonce. Expected: 1, got: 1'))
      .mockResolvedValue({ transaction_hash: '0xhash' });

    // No fake timers / no advanceTimersByTimeAsync needed — recovery never polls
    // RESEED_POLL_*; if it did, this await would hang.
    const res = await managerExecute(provider, CALL);
    expect(res.transaction_hash).toBe('0xhash');

    // execute called twice for the recovered submit (rejected attempt + retry).
    expect(execute).toHaveBeenCalledTimes(3); // 1 first submit + 2 for the recovery
    // The corrected nonce was read at pre_confirmed (1 seed + 1 recovery re-read).
    expect(getNonce).toHaveBeenCalledTimes(2);
    // Used 0 (first ok), 1 (rejected), then the re-read 1 (retry succeeded).
    expect(noncesUsed()).toEqual([0n, 1n, 1n]);
  });

  it('(#91) in-call recovery never REGRESSES the local counter below a just-advanced value on a lagging pre_confirmed read', async () => {
    // Seed at chain nonce 5; first submit succeeds at 5, counter -> 6.
    getNonce.mockResolvedValueOnce('0x5');
    await managerExecute(provider, CALL);
    expect(noncesUsed()).toEqual([5n]);

    // Second submit's first attempt (at nonce 6) hits code-52. The in-call recovery
    // re-reads via fetchManagerNonce (pre_confirmed) — but that read LAGS and still
    // reports 5 (the just-accepted first submit hasn't surfaced yet). Pre-fix this
    // destructively overwrote localNonce = 5, retrying at the ALREADY-USED nonce 5 —
    // a spurious second collision. Fixed: max(rpcNonce, nonce) keeps 6.
    getNonce.mockResolvedValue('0x5'); // lagging pre_confirmed read
    execute
      .mockRejectedValueOnce(new Error('code 52: Invalid transaction nonce. Expected: 6, got: 6'))
      .mockResolvedValue({ transaction_hash: '0xhash' });

    await managerExecute(provider, CALL);

    // Never regresses to 5 on the retry — stays at the locally-known-good 6.
    expect(noncesUsed()).toEqual([5n, 6n, 6n]);
  });

  it('(#2) persistent code-52 rethrows after exactly MAX_NONCE_RETRIES, never loops forever', async () => {
    getNonce.mockResolvedValue('0x0'); // seed = 0
    // Every attempt rejects with code 52 — the re-read can't fix it.
    execute.mockRejectedValue(new Error('code 52: Invalid transaction nonce'));

    await expect(managerExecute(provider, CALL)).rejects.toThrow(/Invalid transaction nonce/);

    // 1 initial attempt + MAX_NONCE_RETRIES (3) in-call retries = 4 execute calls.
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('(#3) non-nonce error rethrows immediately and RE-SEEDS (nonce NOT consumed, not advanced)', async () => {
    getNonce.mockResolvedValue('0x0'); // seed = 0
    // A balance error — NOT a nonce error. account.execute throws at SUBMIT time
    // (pre-acceptance), so the nonce was NOT consumed.
    execute.mockRejectedValueOnce(new Error('Account balance is smaller than the transaction'));
    await expect(managerExecute(provider, CALL)).rejects.toThrow(/balance/);
    // Exactly one attempt — non-nonce errors are not auto-retried.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(noncesUsed()).toEqual([0n]);

    // The counter was INVALIDATED (not advanced): the unconsumed nonce 0 is reusable,
    // so the next submit RE-SEEDS (settlement-guarded) and uses 0 AGAIN — never skips
    // to 1 (which would fire N+1 against a chain expecting N → a spurious code-52).
    execute.mockResolvedValue({ transaction_hash: '0xhash' });
    await managerExecute(provider, CALL);
    expect(noncesUsed()).toEqual([0n, 0n]);
    // getNonce read again for the re-seed (seed + re-seed = 2), proving the invalidation.
    // The re-seed returns immediately (chainNonce 0 ≥ lastUsedNonce 0 → no poll/stall).
    expect(getNonce).toHaveBeenCalledTimes(2);
  });

  it('(#4) recovery preserves serialization: a queued submit still gets the next nonce', async () => {
    getNonce.mockResolvedValue('0x0'); // seed = 0
    getNonce.mockResolvedValue('0x0'); // re-read returns the same corrected nonce 0

    // Head submit: first attempt rejects with code 52, retry succeeds (uses 0).
    // A second submit is queued WHILE the head is mid-recovery — it must wait for the
    // head's nonce assignment and then get 1, never grabbing a nonce mid-recovery.
    execute
      .mockRejectedValueOnce(new Error('code 52: Invalid transaction nonce'))
      .mockResolvedValue({ transaction_hash: '0xhash' });

    const p1 = managerExecute(provider, CALL); // recovers in-call -> uses 0
    const p2 = managerExecute(provider, CALL); // queued -> uses 1
    await Promise.all([p1, p2]);

    // Head used 0 (rejected) then 0 (retry); queued used 1 — distinct & sequential
    // across the recovery boundary.
    expect(noncesUsed()).toEqual([0n, 0n, 1n]);
  });
});

describe('managerExecute — settlement-guarded re-seed (persistent-failure fallback)', () => {
  it('(e) after a PERSISTENT code-52 the next submit RE-SEEDS, and seeding does not regress', async () => {
    getNonce.mockResolvedValue('0x0'); // seed = 0
    await managerExecute(provider, CALL); // uses 0, counter -> 1
    expect(getNonce).toHaveBeenCalledTimes(1);

    // A submit whose every attempt is code-52 exhausts MAX_NONCE_RETRIES and rethrows,
    // dropping the local counter (lastUsedNonce kept) so the NEXT submit re-seeds.
    // The re-read also stays code-52 throughout the recovery (chain still lagging).
    getNonce.mockResolvedValue('0x1'); // re-read during in-call recovery (still N)
    execute.mockRejectedValue(new Error('code 52: Invalid transaction nonce'));
    await expect(managerExecute(provider, CALL)).rejects.toThrow(/Invalid transaction nonce/);

    // The chain has now SETTLED: getNonce reflects the advanced region.
    getNonce.mockResolvedValue('0x2'); // chain caught up past lastUsed
    execute.mockResolvedValue({ transaction_hash: '0xhash' });
    await managerExecute(provider, CALL); // re-seeds from the settled value

    // Re-seeded submit used the settled chain nonce (2), not a regressed value.
    expect(noncesUsed().at(-1)).toBe(2n);
  });

  it('(e) the re-seed WAITS for the chain to catch up past the last-used nonce', async () => {
    vi.useFakeTimers();
    getNonce.mockResolvedValue(5n); // seed = 5
    await managerExecute(provider, CALL); // uses 5, counter -> 6

    // A submit at nonce 6 hits a PERSISTENT code-52 (re-read keeps returning 6, every
    // attempt rejects) -> exhausts retries, drops the counter, lastUsedNonce = 6.
    getNonce.mockResolvedValue(6n); // re-read during in-call recovery
    execute.mockRejectedValue(new Error('code 52: Invalid transaction nonce'));
    await expect(managerExecute(provider, CALL)).rejects.toThrow(/Invalid transaction nonce/);

    // The in-flight tx used nonce 6, so a chain read of 6 (== lastUsedNonce) does NOT
    // prove it settled — the account nonce only advances to 7 AFTER the tx at 6 is
    // accepted. The re-seed (maybe-in-flight ⇒ strictly-greater) must keep POLLING
    // while the chain reports 6, and only seed once it advances PAST 6 (to 7). Seeding
    // at 6 here would re-hand the still-in-flight nonce to the next submit (#65).
    getNonce
      .mockResolvedValueOnce(6n) // initial read in seedManagerNonce: == lastUsed, NOT settled
      .mockResolvedValueOnce(6n) // first poll: still at 6 (in-flight tx not yet settled)
      .mockResolvedValue(7n); // chain advanced PAST lastUsed (the tx at 6 settled)
    execute.mockResolvedValue({ transaction_hash: '0xhash' });

    const p = managerExecute(provider, CALL);
    // Advance through the poll sleeps so the loop can re-read (2 polls × 1500ms).
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    // It seeded from the SETTLED value (7), not the still-in-flight 6 (the #65 fix:
    // pre-fix `<` exited at 6 and reused the in-flight nonce).
    expect(noncesUsed().at(-1)).toBe(7n);
    vi.useRealTimers();
  });

  it('(#65) maybe-in-flight re-seed does NOT seed at chainNonce === lastUsedNonce (off-by-one)', async () => {
    // Direct regression for #65. After a persistent code-52 the prior tx is in-flight;
    // the chain nonce will lag AT lastUsedNonce until that tx settles. The pre-fix
    // guard `chainNonce < lastUsedNonce` exited the moment chainNonce === lastUsedNonce
    // and re-seeded the NEXT submit to that still-pending nonce. The fix waits for a
    // STRICTLY-GREATER read. Here the chain sits AT lastUsedNonce (10) for several
    // polls, so the re-seed must NOT have seeded yet; only when it ticks to 11 does the
    // queued submit get a nonce — and that nonce is 11, never the in-flight 10.
    vi.useFakeTimers();
    getNonce.mockResolvedValue(10n); // seed = 10
    await managerExecute(provider, CALL); // uses 10, counter -> 11

    // A submit at nonce 11 hits a PERSISTENT code-52: the re-read during in-call
    // recovery stays at 11 (the chain hasn't advanced), every attempt rejects ->
    // exhausts retries, drops the counter, lastUsedNonce = 11.
    getNonce.mockResolvedValue(11n);
    execute.mockRejectedValue(new Error('code 52: Invalid transaction nonce'));
    await expect(managerExecute(provider, CALL)).rejects.toThrow(/Invalid transaction nonce/);

    // The chain stays AT lastUsedNonce (11) for the initial read + 3 polls, THEN
    // advances to 12. A pre-fix `<` would have seeded 11 (the in-flight nonce) on the
    // very first read; the fix keeps polling until 12.
    getNonce
      .mockResolvedValueOnce(11n) // initial read: == lastUsed, in-flight not settled
      .mockResolvedValueOnce(11n) // poll 1: still 11
      .mockResolvedValueOnce(11n) // poll 2: still 11
      .mockResolvedValue(12n); // settled: advanced past lastUsed
    execute.mockResolvedValue({ transaction_hash: '0xhash' });

    const p = managerExecute(provider, CALL);
    await vi.advanceTimersByTimeAsync(6000); // 3 polls × 1500ms
    await p;

    // The RE-SEEDED submit used the strictly-greater settled value (12), never the
    // still-in-flight 11. (Earlier entries DO include 11 — those are the rejected
    // code-52 attempts that legitimately tried 11; the bug is only about the next
    // submit's SEED, i.e. the final used nonce.) Pre-fix `<` would have made this 11n.
    expect(noncesUsed().at(-1)).toBe(12n);
    vi.useRealTimers();
  });

  it('(#65) unconsumed-nonce re-seed seeds at chainNonce === lastUsedNonce IMMEDIATELY (no stall)', async () => {
    // The flip side of the Option-B fix: a non-nonce reject (balance error) throws
    // pre-acceptance, so the nonce was NEVER consumed and the chain will never advance
    // past lastUsedNonce on its own. The re-seed must seed at chainNonce === lastUsed
    // IMMEDIATELY (a strictly-greater wait would stall the full poll timeout). Uses
    // REAL timers: if the fix wrongly polled here, this test would hang.
    getNonce.mockResolvedValue(0n); // seed = 0
    execute.mockRejectedValueOnce(new Error('Account balance is smaller than the transaction'));
    await expect(managerExecute(provider, CALL)).rejects.toThrow(/balance/); // lastUsedNonce = 0, unconsumed

    // Re-seed reads the chain nonce, still 0 (the failed tx never consumed it). Must
    // return 0 immediately — no poll, no stall.
    getNonce.mockResolvedValue(0n);
    execute.mockResolvedValue({ transaction_hash: '0xhash' });
    await managerExecute(provider, CALL); // re-seeds and uses 0 again

    expect(noncesUsed()).toEqual([0n, 0n]);
  });
});
