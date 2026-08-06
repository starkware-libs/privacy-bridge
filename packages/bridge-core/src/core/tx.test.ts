// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcProvider } from 'starknet';
import { submitAndTrack, sanitizeErrorMessage } from './tx';

// Mirrors starknet.js RpcError: a verbose `.message` (method + multi-KB params dump,
// then the reason at the very end) plus the structured `.baseError`. The UI front-
// truncates, so the reason must be pulled from baseError — not left buried in message.
class FakeRpcError extends Error {
  baseError: { code: number; message: string; data?: unknown };
  constructor(method: string, base: { code: number; message: string; data?: unknown }) {
    super(
      `RPC: ${method} with params ${JSON.stringify({ transaction: { calls: ['0x' + 'a'.repeat(60)] } }, null, 2)}\n      ${base.code}: ${base.message}: ${JSON.stringify(base.data)}`,
    );
    this.baseError = base;
  }
}

describe('sanitizeErrorMessage — RpcError reason extraction', () => {
  it('surfaces the baseError reason (code + message + data) and the method, not the params dump', () => {
    const err = new FakeRpcError('paymaster_buildTransaction', {
      code: 163,
      message: 'An error occurred (UNKNOWN_ERROR)',
      data: 'x-paymaster-api-key is invalid',
    });
    const out = sanitizeErrorMessage(err);
    expect(out).toContain('paymaster_buildTransaction');
    expect(out).toContain('(163)');
    expect(out).toContain('x-paymaster-api-key is invalid');
    // The giant params blob is NOT what gets shown.
    expect(out).not.toContain('with params');
    expect(out.length).toBeLessThan(300);
  });

  it('falls back to the plain message when there is no baseError', () => {
    expect(sanitizeErrorMessage(new Error('plain failure'))).toBe('plain failure');
  });
});

// A failing starknet_call was surfacing to the user as the literal string
// "undefined: undefined: undefined" — starknet.js's RpcError constructor builds
// `.message` as `${code}: ${message}: ${data}` with no guard for a server error
// payload that ISN'T a proper {code,message,data} object (e.g. the dev proxy's 502
// "network not configured" stub, which replies `{ error: "<string>" }` or a raw
// HTTP status/body with no JSON-RPC envelope at all). These two cases reproduce
// the two shapes that trip the formatter today.
describe('sanitizeErrorMessage — non-JSON-RPC-shaped errors never print "undefined"', () => {
  it('falls back to a readable message for a plain Error carrying the raw undefined-triplet text', () => {
    // Mirrors errorHandler's `throw Error(otherError.message)` re-wrap path in
    // starknet.js: the structured baseError is lost, leaving a bare Error whose
    // message is exactly the broken "<code>: <message>: <data>" render.
    const err = new Error(
      'RPC: starknet_call with params {"request":[]}\n      undefined: undefined: undefined',
    );
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain('undefined');
    expect(out).toContain('starknet_call');
  });

  it('falls back to a readable message (with HTTP status + body preview) for an HTTP-502-text-body-shaped baseError', () => {
    // Mirrors the real dev-proxy trigger: the 502 response body isn't a
    // {code,message,data} object, so starknet.js's RpcError still bakes
    // "undefined: undefined: undefined" into .message, but .baseError carries
    // whatever the transport actually saw (here: status/statusText/body).
    const err = new FakeRpcError('starknet_call', {
      code: undefined as unknown as number,
      message: undefined as unknown as string,
      data: undefined,
    });
    (err as unknown as { baseError: unknown }).baseError = {
      status: 502,
      statusText: 'Bad Gateway',
      body: 'Network "testnet" rpc not configured in this dev server',
    };
    const out = sanitizeErrorMessage(err);
    expect(out).not.toContain('undefined');
    expect(out).toContain('502');
    expect(out).toContain('Bad Gateway');
    expect(out).toContain('not configured in this dev server');
  });
});

// Unit test for submitAndTrack's exponential poll backoff (tx.ts, Step 3 / B3).
//
// THE CONTRACT:
//   - Early polls stay snappy (base ~1000ms) for the PRE_CONFIRMED UX, then back
//     off ×1.5 per iteration, capped at maxIntervalMs (default 8000ms).
//   - timeoutMs remains the HARD total-wait cap — exceeding it throws.
//
// We observe the sleep intervals by spying on setTimeout under fake timers, and
// stub getTransactionStatus so the tx stays sub-target for N polls (so we can
// watch the backoff grow), then either reaches target (resolve) or never does
// (timeout throw).

const getTransactionStatus = vi.fn();
const getTransactionReceipt = vi.fn(async () => ({ block_number: 7 }));
const provider = {
  getTransactionStatus,
  getTransactionReceipt,
} as unknown as RpcProvider;

const submit = vi.fn(async () => ({ transaction_hash: '0xhash' }));

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ transaction_hash: '0xhash' });
  getTransactionReceipt.mockResolvedValue({ block_number: 7 });
});

afterEach(() => {
  vi.useRealTimers();
});

// Capture each setTimeout delay (the poll sleep). We only care about the
// positive-delay sleeps the loop schedules.
function captureSleepDelays(): number[] {
  const delays: number[] = [];
  const orig = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (typeof ms === 'number' && ms > 0) delays.push(ms);
    return (orig as typeof setTimeout)(fn, ms, ...rest);
  }) as typeof setTimeout);
  return delays;
}

describe('submitAndTrack — exponential poll backoff', () => {
  it('(#9) backoff grows ~1000→1500→2250… and caps at maxIntervalMs', async () => {
    vi.useFakeTimers();
    const delays = captureSleepDelays();
    // Stay RECEIVED (rank 0 < PRE_CONFIRMED rank 1) so the loop keeps polling and
    // we can watch the interval grow over many iterations.
    getTransactionStatus.mockResolvedValue({ finality_status: 'RECEIVED' });

    // No timeout pressure for this run: huge timeout so it only stops when we let
    // it. We pump a bounded number of iterations then assert the captured deltas.
    const p = submitAndTrack(provider, submit, {
      intervalMs: 1000,
      maxIntervalMs: 8000,
      timeoutMs: 10_000_000,
      until: 'ACCEPTED_ON_L2',
    });

    // Advance through enough sleeps to exceed the cap. Each iteration schedules
    // one sleep; advance generously so the captured delays accumulate.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(8000);
    }

    // Let it finally reach target so the promise resolves and the test ends.
    getTransactionStatus.mockResolvedValue({
      finality_status: 'ACCEPTED_ON_L2',
      execution_status: 'SUCCEEDED',
    });
    await vi.advanceTimersByTimeAsync(8000);
    await p;

    // First few sleeps follow the ×1.5 schedule from the 1000ms base.
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(1500);
    expect(delays[2]).toBe(2250);
    expect(delays[3]).toBe(3375);
    // It grows monotonically until it hits the cap, then stays capped.
    expect(Math.max(...delays)).toBe(8000);
    // Never exceeds the cap.
    for (const d of delays) expect(d).toBeLessThanOrEqual(8000);
    // The cap is reached and held (more than one sleep at 8000).
    expect(delays.filter((d) => d === 8000).length).toBeGreaterThan(1);
  });

  it('(#9b) timeoutMs is still the hard cap — throws once exceeded', async () => {
    vi.useFakeTimers();
    // Never reaches PRE_CONFIRMED, so the loop runs until the deadline.
    getTransactionStatus.mockResolvedValue({ finality_status: 'RECEIVED' });

    const p = submitAndTrack(provider, submit, {
      intervalMs: 1000,
      maxIntervalMs: 8000,
      timeoutMs: 5000,
    });
    // Surface the rejection as a settled outcome so the assertion is clean.
    const settled = p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e as Error }),
    );

    // Push past the 5s deadline.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(8000);
    }
    const out = await settled;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.err.message).toMatch(/timed out after 5000ms/);
  });
});

// #93: a missing execution_status must NOT be treated as success once finality
// is at/above PRE_CONFIRMED — per the Starknet RPC TXN_STATUS spec,
// execution_status is only legitimately absent at RECEIVED (rank 0). A
// node/wire bug reporting a higher finality with no execution_status must keep
// polling (and eventually time out), not silently resolve as success.
describe('submitAndTrack — execution_status gating by finality rank (#93)', () => {
  it('does not resolve as success at ACCEPTED_ON_L2 with execution_status omitted', async () => {
    vi.useFakeTimers();
    getTransactionStatus.mockResolvedValue({ finality_status: 'ACCEPTED_ON_L2' });

    const p = submitAndTrack(provider, submit, {
      intervalMs: 100,
      maxIntervalMs: 100,
      timeoutMs: 500,
      until: 'ACCEPTED_ON_L2',
    });
    const settled = p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e as Error }),
    );

    await vi.advanceTimersByTimeAsync(600);
    const out = await settled;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.err.message).toMatch(/timed out after 500ms/);
  });

  it('still resolves at RECEIVED with execution_status omitted (rank 0 stays exempt)', async () => {
    vi.useFakeTimers();
    getTransactionStatus.mockResolvedValue({ finality_status: 'RECEIVED' });

    const p = submitAndTrack(provider, submit, {
      intervalMs: 100,
      maxIntervalMs: 100,
      timeoutMs: 5000,
      until: 'RECEIVED',
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ transaction_hash: '0xhash' });
  });

  it('resolves once execution_status explicitly reports SUCCEEDED at ACCEPTED_ON_L2', async () => {
    vi.useFakeTimers();
    getTransactionStatus.mockResolvedValue({
      finality_status: 'ACCEPTED_ON_L2',
      execution_status: 'SUCCEEDED',
    });

    const p = submitAndTrack(provider, submit, {
      intervalMs: 100,
      maxIntervalMs: 100,
      timeoutMs: 5000,
      until: 'ACCEPTED_ON_L2',
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ transaction_hash: '0xhash' });
  });
});
