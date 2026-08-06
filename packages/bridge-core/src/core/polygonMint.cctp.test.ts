// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Adversarial CCTP attestation/forwarded-mint tests (BUY steps 3-4) — exercises
// the REAL exported code paths in polygonMint.ts against a MOCKED Iris endpoint.
// No network is touched. Complements polygonMint.test.ts (which pins the happy-
// path URL + the forwardTxHash poll) by covering the failure / terminal-status /
// timeout / transient-backoff edges the happy-path suite omits.
//
// The fund-account leg no longer submits receiveMessage itself — Circle's Forwarding
// Service does — so there is no viem write to mock; both pollers are pure fetch.
//
// Frozen shape. The cross-chain leg itself can only
// be verified live (.claude/rules/verification.md) — these pin client behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation, waitForForwardedMint } from './polygonMint.js';
import { isTransientError } from './errors.js';

// --- fixtures (no real keys) -------------------------------------------------
const BURN_TX = '0xabc123';
// The forwarded-mint poll validates the message recipient/domains (Bundle A1)
// before trusting the forward, so MESSAGE must be a well-formed CCTP-v2 message
// decoding to this.
const EXPECTED_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const FORWARD_TX = '0xfeedface' as `0x${string}`;

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) so the A1
// gate passes. Layout mirrors polygonMint.ts (header 148B; mintRecipient at body
// offset 36 — 32-byte left-padded field, EVM addr = last 20 bytes).
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipient: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const recipient40 = opts.recipient.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + '00'.repeat(12) + recipient40 + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

const MESSAGE = buildCctpMessage({
  sourceDomain: config.cctp.starknetDomain,
  destinationDomain: config.polygon.domain,
  recipient: EXPECTED_RECIPIENT,
});

const SN_DOMAIN = config.cctp.starknetDomain; // 25

/** Build a mock fetch Response. */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // The pollers read .text() and safe-parse (guards an empty / non-JSON Iris
    // body); keep .json() too for any other consumer.
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Drive a poller promise to settlement under fake timers. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: Error }> {
  const tracked = p.then(
    (value) => ({ ok: true as const, value }),
    (err: Error) => ({ ok: false as const, err }),
  );
  await vi.runAllTimersAsync();
  return tracked;
}

describe('waitForAttestation — Iris source domain & message encoding', () => {
  it('keys the poll by the STARKNET source domain (25), not the Polygon domain (7)', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    await waitForAttestation(BURN_TX, { intervalMs: 1 });

    const url = String(fetchMock.mock.calls[0][0]);
    // The burn happens on Starknet, so Iris must be queried under source-domain 25.
    expect(SN_DOMAIN).toBe(25);
    expect(config.polygon.domain).toBe(7);
    expect(url).toContain(`/v2/messages/${SN_DOMAIN}`);
    // Guard against accidentally polling under the DESTINATION domain.
    expect(url).not.toContain(`/v2/messages/${config.polygon.domain}?`);
  });

  it('returns the message+attestation bytes verbatim', async () => {
    // waitForAttestation does NOT decode/re-encode the CCTP message; it must pass
    // Iris's bytes through untouched (the fund-in leg replays them).
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );
    const result = await waitForAttestation(BURN_TX, { intervalMs: 1 });
    expect(result.message).toBe(MESSAGE);
    expect(result.attestation).toBe(ATTESTATION);
  });
});

describe('waitForAttestation — pending → complete transition', () => {
  it('keeps polling while status="pending_confirmations", resolves on "complete"', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { messages: [{ status: 'pending_confirmations' }] }))
      .mockResolvedValueOnce(res(200, { messages: [{ status: 'pending_confirmations' }] }))
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );

    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 10_000 }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('does NOT resolve on status="complete" with missing message/attestation', async () => {
    // Defends the guard `entry.status === 'complete' && entry.message && entry.attestation`.
    // A malformed "complete" (no bytes) must not resolve to { message: undefined }.
    fetchMock
      .mockResolvedValueOnce(res(200, { messages: [{ status: 'complete' }] }))
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 10_000 }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.message).toBe(MESSAGE);
      expect(out.value.attestation).toBe(ATTESTATION);
    }
  });
});

describe('waitForAttestation — failure / terminal status handling', () => {
  // CCTP v2 Iris can report a non-advancing status for a message that will never
  // attest (Circle docs: a message may be rejected / fail attestation).
  // waitForAttestation now short-circuits a terminal "failed"/"rejected" status
  // with a distinct, actionable error instead of polling until the timeout.
  it('rejects promptly with a "failed"-specific error on a terminal Iris status', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'failed', message: MESSAGE, attestation: ATTESTATION }] }),
    );
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 5_000 }));
    expect(out.ok).toBe(false);
    // A distinct, actionable error — NOT the generic timeout message.
    if (!out.ok) {
      expect(out.err.message).toMatch(/fail/i);
      expect(out.err.message).not.toMatch(/timed out/i);
    }
  });

  it('rejects promptly on a terminal "rejected" status without exhausting the poll window', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'rejected', message: MESSAGE, attestation: ATTESTATION }] }),
    );
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 5_000 }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.err.message).toMatch(/rejected|fail/i);
      expect(out.err.message).not.toMatch(/timed out/i);
    }
    // Short-circuited on the first terminal response (did not re-poll).
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe('Iris poll — transient HTTP backoff (Bundle B1)', () => {
  // 5xx and 429 from Iris are TRANSIENT: the service is busy / rate-limiting,
  // not a permanent failure. The pollers must NOT throw on these — they retry
  // with exponential backoff + jitter up to the existing deadline. Timing is
  // injected (sleep/random) so these are deterministic with NO real waiting (we
  // assert the recorded sleeps never block on real timers).

  /**
   * Deterministic injected timing: records each requested delay and ADVANCES the
   * fake clock by that amount (so Date.now()-based deadlines progress) WITHOUT
   * any real waiting — the promise resolves on the microtask queue.
   */
  function fakeTiming() {
    const sleeps: number[] = [];
    return {
      sleeps,
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        vi.advanceTimersByTime(ms);
        return Promise.resolve();
      },
      // Deterministic "jitter": mid-point of the jitter range.
      random: () => 0.5,
    };
  }

  it('does NOT throw on 503; backs off and resolves when Iris recovers (503,503,200)', async () => {
    const { sleep, sleeps, random } = fakeTiming();
    fetchMock
      .mockResolvedValueOnce(res(503, { error: 'busy' }))
      .mockResolvedValueOnce(res(503, { error: 'busy' }))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );
    const statuses: string[] = [];
    const result = await waitForAttestation(BURN_TX, {
      intervalMs: 10,
      timeoutMs: 60_000,
      backoffBaseMs: 1000,
      backoffCapMs: 30_000,
      sleep,
      random,
      onStatus: (s) => statuses.push(s),
    });
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBe(3);
    // The two 503s used the busy-retry backoff (NOT the base poll interval).
    expect(statuses.some((s) => /busy/i.test(s))).toBe(true);
    // Exponential growth (1000, 2000) + jitter; never the 10ms base interval.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it('does NOT throw on 429 (rate limited); backs off and resolves (429,200)', async () => {
    const { sleep, random } = fakeTiming();
    fetchMock
      .mockResolvedValueOnce(res(429, { error: 'rate limited' }))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );
    const result = await waitForAttestation(BURN_TX, {
      intervalMs: 10,
      timeoutMs: 60_000,
      backoffBaseMs: 1000,
      sleep,
      random,
    });
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('throws the (transient-classified) timeout error when 503 persists past the deadline', async () => {
    const { sleep, random } = fakeTiming();
    fetchMock.mockResolvedValue(res(503, { error: 'busy' }));
    let thrown: unknown;
    try {
      await waitForAttestation(BURN_TX, {
        intervalMs: 10,
        // Small deadline so the backoff loop exhausts it without real waiting.
        timeoutMs: 5_000,
        backoffBaseMs: 1000,
        sleep,
        random,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/timed out/i);
    // The deadline timeout is RESUMABLE (the burn already landed) — must be
    // classified transient so the flow offers resume, never a terminal failure.
    expect(isTransientError(thrown)).toBe(true);
  });

  it('throws IMMEDIATELY on a non-retryable HTTP error (403) — does not back off', async () => {
    const { sleep, random } = fakeTiming();
    fetchMock.mockResolvedValue(res(403, { error: 'forbidden' }));
    let thrown: unknown;
    try {
      await waitForAttestation(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 60_000,
        sleep,
        random,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('HTTP 403');
    // A hard, non-retryable error must not spin the poll loop.
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('keeps polling on 404 at the BASE interval (not-indexed), then resolves on complete', async () => {
    const { sleep, sleeps, random } = fakeTiming();
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );
    const result = await waitForAttestation(BURN_TX, {
      intervalMs: 10,
      timeoutMs: 60_000,
      backoffBaseMs: 1000,
      sleep,
      random,
    });
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    // 404 waits at the base poll interval (10ms), NOT the 1000ms busy backoff.
    expect(sleeps[0]).toBe(10);
  });

  it('terminates at the deadline even with a degenerate backoffBaseMs: 0 (no no-progress loop)', async () => {
    // NIT (B-logic audit): a backoffBaseMs of 0 would otherwise make the transient
    // branch compute waitMs = 0; with the clock-advancing injected sleep the
    // Date.now() deadline would never progress → an infinite loop. The clamp to
    // ≥ 1ms guarantees each backoff sleep advances the clock so the deadline fires.
    const { sleep, sleeps, random } = fakeTiming();
    fetchMock.mockResolvedValue(res(503, { error: 'busy' }));
    let thrown: unknown;
    try {
      await waitForAttestation(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 5_000,
        // Degenerate override: must NOT loop forever — the clamp keeps progress.
        backoffBaseMs: 0,
        sleep,
        random,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/timed out/i);
    // Resumable (burn already landed): the deadline timeout is transient-classified.
    expect(isTransientError(thrown)).toBe(true);
    // Each backoff sleep advanced the clock by at least the clamped 1ms minimum,
    // so the loop made progress and exhausted the 5s deadline instead of spinning.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms >= 1)).toBe(true);
  });
});

describe('waitForAttestation — HTTP error handling', () => {
  it('keeps polling on 404 (burn not yet indexed by Iris)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 10_000 }));
    expect(out.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws immediately on a non-retryable HTTP error (e.g. 400), without polling on', async () => {
    // 4xx other than 404/429 is a genuine, non-retryable client error (400/401/
    // 403). 5xx + 429 are handled by the transient-backoff suite (Bundle B1).
    fetchMock.mockResolvedValue(res(400, { error: 'bad request' }));
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 10_000 }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.err.message).toContain('HTTP 400');
    // A hard error must not spin the poll loop.
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('keeps polling when the messages array is empty (indexed shell, no entry yet)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { messages: [] }))
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 10_000 }));
    expect(out.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('waitForAttestation — timeout', () => {
  it('rejects with a timeout error once the deadline passes (404 forever)', async () => {
    fetchMock.mockResolvedValue(res(404, {}));
    const out = await settle(waitForAttestation(BURN_TX, { intervalMs: 10, timeoutMs: 50 }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.err.message).toMatch(/timed out/i);
      expect(out.err.message).toContain(BURN_TX);
    }
  });
});

describe('waitForForwardedMint — forward poll edges', () => {
  it('keeps polling while the forwardTxHash is absent, then returns it once present', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      )
      .mockResolvedValue(
        res(200, {
          messages: [
            { status: 'complete', message: MESSAGE, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
          ],
        }),
      );
    const out = await settle(
      waitForForwardedMint(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 10_000,
        expectedMintRecipient: EXPECTED_RECIPIENT,
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ forwardTxHash: FORWARD_TX });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects promptly on a terminal Iris status (never waits for a forward that will not come)', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'failed', message: MESSAGE, attestation: ATTESTATION }] }),
    );
    const out = await settle(
      waitForForwardedMint(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 5_000,
        expectedMintRecipient: EXPECTED_RECIPIENT,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.err.message).toMatch(/fail/i);
      expect(out.err.message).not.toMatch(/timed out/i);
    }
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('times out (transient-classified) when the forward never appears', async () => {
    // Iris keeps reporting "complete" but the Forwarding Service never reports a
    // forwardTxHash → the poll deadline fires; the burn already landed, so the
    // timeout must be RESUMABLE.
    const { sleep, random } = (() => {
      const advance = (ms: number): Promise<void> => {
        vi.advanceTimersByTime(ms);
        return Promise.resolve();
      };
      return { sleep: advance, random: () => 0.5 };
    })();
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );
    let thrown: unknown;
    try {
      await waitForForwardedMint(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 50,
        expectedMintRecipient: EXPECTED_RECIPIENT,
        sleep,
        random,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/timed out/i);
    expect(isTransientError(thrown)).toBe(true);
  });
});
