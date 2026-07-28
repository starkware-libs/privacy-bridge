// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Offline unit tests for the CCTP attestation poll + the Forwarding-Service mint
// poll (BUY 3-4), the frozen shape in docs/bridge-interface.md §4. No network is
// touched: global.fetch is mocked for Circle Iris. The fund-account leg no longer submits
// receiveMessage itself — Circle's Forwarding Service does — so we poll Iris for
// the forwardTxHash instead. The cross-chain leg itself can only be verified live
// (.claude/rules/verification.md) — here we pin the request/poll shapes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation, waitForForwardedMint } from './polygonMint.js';

// --- fixtures (no real keys) -------------------------------------------------
const BURN_TX = '0xabc123';
// The per-account mint recipient the synthetic message below mints to. The forwarded-
// mint poll validates the message recipient/domains against this (Bundle A1)
// before trusting the forward, so MESSAGE must be a well-formed CCTP-v2 message
// that decodes to it.
const EXPECTED_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const MESSAGE = buildCctpMessage({
  sourceDomain: config.cctp.starknetDomain,
  destinationDomain: config.polygon.domain,
  recipient: EXPECTED_RECIPIENT,
});
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const FORWARD_TX = '0xfeedface' as `0x${string}`;

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) so the A1
// validation gate passes. Layout mirrors polygonMint.ts: header 148 bytes,
// mintRecipient at body offset 36 (32-byte left-padded; EVM addr = last 20 bytes).
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

const IRIS = config.cctp.irisUrl;
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

describe('waitForAttestation (Iris polling — bridge-interface.md §4)', () => {
  it('polls the right URL: /v2/messages/{snDomain=25}?transactionHash={burnTxHash}', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    const result = await waitForAttestation(BURN_TX, { intervalMs: 1 });

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    // source-domain is Starknet (25), keyed by the burn tx hash
    expect(calledUrl).toContain(`${IRIS}/v2/messages/${SN_DOMAIN}`);
    expect(calledUrl).toContain(`transactionHash=${BURN_TX}`);
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
  });

  it('resolves { message, attestation } once status == "complete"', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    const result = await waitForAttestation(BURN_TX, { intervalMs: 1 });
    expect(result.message).toBe(MESSAGE);
    expect(result.attestation).toBe(ATTESTATION);
  });

  it('keeps polling while Iris returns 404 (message not yet indexed)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('treats a thrown network error (fetch rejects) as transient — retries instead of rejecting (#92)', async () => {
    // A DNS hiccup / connection reset / CORS preflight failure throws out of
    // `fetch` itself (no Response), unlike an HTTP 5xx/429 which returns one.
    // The poll must classify this the same as a transient HTTP error: back off
    // and keep polling, not reject the whole poll on the first occurrence.
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps polling while status is pending, then resolves on complete', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(200, { messages: [{ status: 'pending_confirmations', attestation: 'PENDING' }] }),
      )
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }],
        }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('waitForForwardedMint (Forwarding-Service mint poll — bridge-interface.md §4)', () => {
  it('keeps polling until Iris reports a forwardTxHash, then returns it', async () => {
    // First Iris is still attesting (no forwardTxHash yet); then the Forwarding
    // Service submits the destination mint and Iris reports forwardTxHash.
    fetchMock
      .mockResolvedValueOnce(res(200, { messages: [{ status: 'pending_confirmations' }] }))
      .mockResolvedValueOnce(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      )
      .mockResolvedValue(
        res(200, {
          messages: [
            {
              status: 'complete',
              message: MESSAGE,
              attestation: ATTESTATION,
              forwardTxHash: FORWARD_TX,
            },
          ],
        }),
      );

    const promise = waitForForwardedMint(BURN_TX, {
      intervalMs: 10,
      expectedMintRecipient: EXPECTED_RECIPIENT,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
    // Polled the Starknet source domain keyed by the burn tx (same URL as attest).
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain(`${IRIS}/v2/messages/${SN_DOMAIN}`);
    expect(calledUrl).toContain(`transactionHash=${BURN_TX}`);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves on forwardTxHash even when Iris returns an EMPTY message (Forwarding-Service shape, #67)', async () => {
    // Iris's Forwarding-Service path legitimately returns forwardTxHash with an
    // EMPTY `message` (Circle's relayer minted directly — there is no relay message
    // to deliver). The mint has ALREADY landed on Polygon. Gating on `message`
    // (the old `&& entry.message`) made this poll the full 30-min deadline and then
    // throw a false timeout. The fix treats forwardTxHash as the success signal and
    // only validates when a message is present.
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          {
            status: 'complete',
            message: '', // empty — no relay message on the Forwarding-Service path
            attestation: '',
            forwardTxHash: FORWARD_TX,
          },
        ],
      }),
    );

    const result = await waitForForwardedMint(BURN_TX, {
      intervalMs: 1,
      expectedMintRecipient: EXPECTED_RECIPIENT,
    });

    // Resolves on the first read — does NOT poll to the deadline.
    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('still polls (does not resolve) while forwardTxHash is absent, even on a complete status', async () => {
    // Guard the fix is not over-broad: an entry WITHOUT forwardTxHash must keep
    // polling (the forward hasn't been submitted yet), then resolve once it appears.
    fetchMock
      .mockResolvedValueOnce(res(200, { messages: [{ status: 'complete', message: '', attestation: '' }] }))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: '', attestation: '', forwardTxHash: FORWARD_TX }] }),
      );

    const promise = waitForForwardedMint(BURN_TX, {
      intervalMs: 10,
      expectedMintRecipient: EXPECTED_RECIPIENT,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent: returns immediately when the forwardTxHash is already present', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          {
            status: 'complete',
            message: MESSAGE,
            attestation: ATTESTATION,
            forwardTxHash: FORWARD_TX,
          },
        ],
      }),
    );

    const result = await waitForForwardedMint(BURN_TX, {
      intervalMs: 1,
      expectedMintRecipient: EXPECTED_RECIPIENT,
    });

    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
    // No re-poll needed — the forward was already there on the first read.
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('REFUSES the forward when the message recipient differs from expected (redirect attack)', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          {
            status: 'complete',
            message: MESSAGE, // mints to EXPECTED_RECIPIENT
            attestation: ATTESTATION,
            forwardTxHash: FORWARD_TX,
          },
        ],
      }),
    );

    const attacker = '0x000000000000000000000000000000000000bEEF';
    await expect(
      waitForForwardedMint(BURN_TX, { intervalMs: 1, expectedMintRecipient: attacker }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('throws a resumable "waitForForwardedMint: timed out" once timeoutMs is exceeded', async () => {
    // Iris never reports a forwardTxHash (404 = not indexed yet) — the poll runs
    // until the deadline. The injected `sleep` advances the fake clock by `ms` so
    // Date.now() crosses `timeoutMs` deterministically without real waiting. The
    // exact "waitForForwardedMint: timed out" string is what errors.ts TRANSIENT_RE
    // matches to classify this as RESUMABLE (the burn is replayable by burnTxHash).
    fetchMock.mockResolvedValue(res(404, { error: 'not found' }));

    await expect(
      waitForForwardedMint(BURN_TX, {
        intervalMs: 10,
        timeoutMs: 50,
        sleep: async (ms) => {
          vi.advanceTimersByTime(ms);
        },
        expectedMintRecipient: EXPECTED_RECIPIENT,
      }),
    ).rejects.toThrow(/waitForForwardedMint: timed out/);
  });

  it('REFUSES the forward when the source domain is tampered (not Starknet 25)', async () => {
    const tampered = buildCctpMessage({
      sourceDomain: 0, // wrong source domain
      destinationDomain: config.polygon.domain,
      recipient: EXPECTED_RECIPIENT,
    });
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'complete', message: tampered, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
        ],
      }),
    );

    await expect(
      waitForForwardedMint(BURN_TX, {
        intervalMs: 1,
        expectedMintRecipient: EXPECTED_RECIPIENT,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('gates on the CHOSEN destination domain: accepts a Base-domain (6) mint when expectedDestinationDomain=6', async () => {
    // A forwarded mint to Base (destination domain 6) — the caller chose Base as the
    // bridge-OUT chain, so the A1 gate must accept it when told to expect domain 6.
    const baseMessage = buildCctpMessage({
      sourceDomain: config.cctp.starknetDomain,
      destinationDomain: 6,
      recipient: EXPECTED_RECIPIENT,
    });
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'complete', message: baseMessage, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
        ],
      }),
    );

    const result = await waitForForwardedMint(BURN_TX, {
      intervalMs: 1,
      expectedMintRecipient: EXPECTED_RECIPIENT,
      expectedDestinationDomain: 6,
    });
    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
  });

  it('REFUSES a mint whose destination domain differs from the CHOSEN one (Base message, expecting Polygon 7)', async () => {
    // Same Base-domain (6) message, but the caller expects the DEFAULT Polygon domain
    // (7): the A1 gate must reject the domain mismatch rather than mint on the wrong chain.
    const baseMessage = buildCctpMessage({
      sourceDomain: config.cctp.starknetDomain,
      destinationDomain: 6,
      recipient: EXPECTED_RECIPIENT,
    });
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'complete', message: baseMessage, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
        ],
      }),
    );

    await expect(
      waitForForwardedMint(BURN_TX, {
        intervalMs: 1,
        expectedMintRecipient: EXPECTED_RECIPIENT,
        expectedDestinationDomain: 7,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });
});
