// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Pins the transport's RETRY BUDGET, which is a cost contract rather than a behaviour: the
// reads succeed or fail identically at any retryCount, so nothing else in the suite would
// notice it changing. What changes is how many times a throttled request is RE-SENT into a
// provider that is already shedding, and how long the caller is blocked before it can react.
//
// viem's backoff DOUBLES from retryDelay, so the tail dominates and the cost is not linear
// in the count — which is why this is asserted rather than left to judgement. At six retries
// a single throttled request costs seven round trips and roughly sixteen seconds before the
// rejection surfaces, enough on its own to exhaust a caller's scan timeout. At two it is
// three round trips and under a second.
//
// Asserted against the transport's own config rather than by counting stubbed fetches: viem
// builds a real `Request` (and a timeout AbortSignal) before calling fetch, which a stubbed
// fetch in this environment cannot satisfy — a test written that way fails for reasons that
// have nothing to do with the budget, or worse passes vacuously because no retry was ever
// attempted. The config is the contract; the arithmetic below is what makes it meaningful.
import { describe, expect, it } from 'vitest';
import { getPolygonPublicClient } from './polygonClient';

// Worst-case wall clock viem spends before a rejection surfaces, for a doubling backoff:
// delay * (2^0 + 2^1 + ... + 2^(count-1)) == delay * (2^count - 1).
const backoffTotalMs = (retryCount: number, retryDelayMs: number): number =>
  retryDelayMs * (2 ** retryCount - 1);

describe('getPolygonPublicClient retry budget', () => {
  it('re-sends a throttled request at most twice', () => {
    expect(getPolygonPublicClient().transport.retryCount).toBeLessThanOrEqual(2);
  });

  it('still retries at least once — a transient blip must not fail the read outright', () => {
    // Guards the other direction: the point is a SMALL budget, not no budget.
    expect(getPolygonPublicClient().transport.retryCount).toBeGreaterThanOrEqual(1);
  });

  it('keeps the whole backoff well inside a caller scan timeout', () => {
    // The property that actually broke: a budget whose backoff alone can outlast the
    // caller's timeout turns a recoverable throttle into an unrecoverable stall. Consumers
    // bound a full chain scan at tens of seconds and issue many waves inside that, so one
    // request's retry tail has to stay a small fraction of it.
    const { retryCount, retryDelay } = getPolygonPublicClient().transport;
    expect(backoffTotalMs(retryCount as number, retryDelay as number)).toBeLessThan(2_000);
  });

  it('pins the arithmetic this budget was chosen against', () => {
    // Documents WHY six was wrong, so a future change is made with the shape in view rather
    // than by intuition: the cost is exponential in the count, not linear.
    expect(backoffTotalMs(2, 250)).toBe(750);
    expect(backoffTotalMs(6, 250)).toBe(15_750);
  });

  it('is still an HTTP transport, so a wave stays one round trip', () => {
    // Unrelated to the count but the same cost contract, and cheap to lose in a refactor of
    // the same options object.
    expect(getPolygonPublicClient().transport.type).toBe('http');
  });
});
