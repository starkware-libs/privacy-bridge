// C1 regression: pollIris (via waitForAttestation) must treat an OK 200 whose
// body is the JSON literal `null` as TRANSIENT, exactly like an empty/partial
// 200 (see polygonMint.emptyBody.test.ts).
//
// safeJsonParse("null") does NOT throw — JSON.parse("null") is valid JSON and
// returns null — so the body-parse try/catch never sets transient=true. The
// code then dereferences `body!.messages` on a null body, throwing a synchronous
// TypeError OUTSIDE the try/catch. That TypeError's message matches neither
// TRANSIENT_RE nor TERMINAL_RE, so isTransientError() === false → the orchestrator
// treats it as TERMINAL / non-resumable. Since the CCTP burn already happened,
// the deposit is stranded.
//
// The guard's own comment (polygonMint.ts ~144-147) says an OK-but-degenerate
// body "must be RETRIED like a transient 5xx/429 ... NOT escape the poll loop as
// a terminal throw." A top-level `null` is such a degenerate 200. These tests
// assert the CORRECT behavior (retry → recover, or time out as a TRANSIENT
// error), so they FAIL RED on the current buggy code (TypeError, non-transient).
//
// No network is touched: global.fetch is mocked for Circle Iris. vi.useFakeTimers
// + vi.runAllTimersAsync drive the retry/deadline without real waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation } from './polygonMint.js';
import { isTransientError } from './errors.js';

const BURN_TX = '0xabc123';
const EXPECTED_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) so the poll's
// "complete" branch resolves. Layout mirrors polygonMint.ts / the emptyBody test.
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
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;

/**
 * Build a mock fetch Response. `res(200, null)` yields text() === "null"
 * (JSON.stringify(null)), i.e. an OK 200 whose body is the JSON literal null.
 */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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

describe('pollIris — an OK 200 body of JSON `null` is transient, not a terminal crash', () => {
  it('retries a `null` 200 body and resolves on the next complete message', async () => {
    // First read: HTTP 200 with body === null — must back off and keep polling.
    // Second read: a normal complete attestation.
    fetchMock
      .mockResolvedValueOnce(res(200, null)) // OK-but-null 200 body
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    // Surface the rejection as a value so an unhandled synchronous throw doesn't
    // escape (the buggy path rejects with a TypeError on the first read).
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;

    if (!outcome.ok) {
      const msg = outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
      throw new Error(`expected recovery, but poll rejected with: ${msg}`);
    }
    expect(outcome.value).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a persistent `null` 200 body times out as a TRANSIENT (resumable) error, not a TypeError', async () => {
    // Iris keeps serving a degenerate null 200. Correct behavior: retry until the
    // deadline, then throw the transient `waitForAttestation: timed out`. Buggy
    // behavior: a synchronous, NON-transient TypeError on the very first read.
    fetchMock.mockResolvedValue(res(200, null));

    const promise = waitForAttestation(BURN_TX, {
      intervalMs: 10,
      timeoutMs: 50,
      backoffBaseMs: 1,
    });
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const msg = outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
      // The defect: a non-transient TypeError escapes the poll loop.
      expect(msg).not.toMatch(/Cannot read properties of null/i);
      expect(isTransientError(outcome.err)).toBe(true);
    }
  });
});
