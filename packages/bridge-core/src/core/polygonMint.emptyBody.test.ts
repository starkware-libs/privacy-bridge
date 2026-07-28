// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// pollIris (via waitForAttestation) must treat an OK-but-empty/non-JSON 200 body
// as transient. Circle's Iris occasionally serves a blank or partial 200 mid-
// attestation; the body parse must be retried like a 5xx/429 rather than escaping
// the poll loop as a terminal "empty body (expected JSON)" throw, and the message
// must classify as transient so auto-resume can recover.
//
// No network is touched: global.fetch is mocked for Circle Iris (mirrors
// polygonMint.test.ts). vi.useFakeTimers + vi.runAllTimersAsync drive the retry
// without real waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation } from './polygonMint.js';
import { isTransientError } from './errors.js';

const BURN_TX = '0xabc123';
const EXPECTED_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) so the poll's
// "complete" branch resolves. Layout mirrors polygonMint.ts.
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

/** Build a mock fetch Response. `body === undefined` → an EMPTY body ('' text). */
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

describe('pollIris — an OK-but-empty 200 body is transient, not terminal', () => {
  it('retries an empty 200 body and resolves on the next complete message', async () => {
    // First read: HTTP 200 with an empty body — backs off and keeps polling.
    // Second read: a normal complete attestation.
    fetchMock
      .mockResolvedValueOnce(res(200, undefined)) // OK-but-empty 200 body
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies the empty-body parse failure as transient', () => {
    expect(
      isTransientError(new Error('Iris /v2/messages (200): empty body (expected JSON).')),
    ).toBe(true);
  });
});
