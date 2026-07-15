// Tests for the Fast-aware Iris poll cadence + the merged attest→forwarded-mint
// loop (polygonMint.ts). No network is touched: global.fetch is mocked for Circle
// Iris and `sleep` is injected so the poll cadence is observable without real waiting.
//
// Two behaviors under test:
//   1. FAST tier (finality threshold 1000) polls ~1.5s between attempts vs 5s for
//      Standard, with an explicit intervalMs always overriding the tier.
//   2. waitForBridgedMint runs a SINGLE poll loop: once the attestation is found it
//      keeps inspecting the SAME loop for forwardTxHash (no fresh cycle), captures the
//      attested pair from the attestation poll even when the forward poll's message is
//      empty, fires onAttested exactly once, and preserves the A1 fund-safety gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation, waitForBridgedMint } from './polygonMint.js';

const BURN_TX = '0xabc123';
// The per-account mint recipient the synthetic message mints to; the A1 gate
// validates the message against this before trusting the forward.
const EXPECTED_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const FORWARD_TX = '0xfeedface' as `0x${string}`;

// Build a well-formed CCTP-v2 message (header 148B; mintRecipient at body offset 36 —
// 32-byte left-padded field, EVM addr = last 20 bytes) so the A1 gate passes.
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

/** Build a mock fetch Response (the pollers read .text() then safe-parse). */
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fast-aware poll cadence', () => {
  // The first poll 404s (not indexed) so the loop sleeps the base interval once before
  // the second poll resolves — the recorded sleep IS the tier's base cadence.
  const completeForward = {
    status: 'complete',
    message: MESSAGE,
    attestation: ATTESTATION,
    forwardTxHash: FORWARD_TX,
  };

  it('Fast tier polls at ~1.5s between attempts when no explicit intervalMs', async () => {
    const sleeps: number[] = [];
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(res(200, { messages: [completeForward] }));

    const result = await waitForBridgedMint(BURN_TX, {
      fast: true,
      expectedMintRecipient: EXPECTED_RECIPIENT,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.forwardTxHash).toBe(FORWARD_TX);
    expect(sleeps).toContain(1_500);
    expect(sleeps).not.toContain(5_000);
  });

  it('Standard tier keeps the 5s cadence (never hammers Iris on the slow tier)', async () => {
    const sleeps: number[] = [];
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(res(200, { messages: [completeForward] }));

    const result = await waitForBridgedMint(BURN_TX, {
      fast: false,
      expectedMintRecipient: EXPECTED_RECIPIENT,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.forwardTxHash).toBe(FORWARD_TX);
    expect(sleeps).toContain(5_000);
    expect(sleeps).not.toContain(1_500);
  });

  it('an explicit intervalMs ALWAYS overrides the tier (deterministic tests)', async () => {
    const sleeps: number[] = [];
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(res(200, { messages: [completeForward] }));

    await waitForBridgedMint(BURN_TX, {
      fast: true,
      intervalMs: 7,
      expectedMintRecipient: EXPECTED_RECIPIENT,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toContain(7);
    expect(sleeps).not.toContain(1_500);
  });

  it('the shared poller (waitForAttestation) is also fast-aware', async () => {
    const sleeps: number[] = [];
    fetchMock
      .mockResolvedValueOnce(res(404, { error: 'not found' }))
      .mockResolvedValue(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );

    await waitForAttestation(BURN_TX, {
      fast: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toContain(1_500);
  });
});

describe('waitForBridgedMint — merged attest→forwarded-mint loop', () => {
  it('captures the attested pair from the attestation poll, then resolves the forward in the SAME loop', async () => {
    // Poll 1: attestation completes (message + attestation, no forward yet). Poll 2:
    // the Forwarding-Service shape — forwardTxHash with an EMPTY message. The merged
    // loop must return the attested pair captured on poll 1 (not the empty poll-2 one)
    // and must NOT restart a fresh poll cycle: exactly 2 fetches, no re-attest.
    fetchMock
      .mockResolvedValueOnce(
        res(200, { messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      )
      .mockResolvedValue(
        res(200, {
          messages: [{ status: 'complete', message: '', attestation: '', forwardTxHash: FORWARD_TX }],
        }),
      );

    let attestedCount = 0;
    const attestStatuses: string[] = [];
    const mintStatuses: string[] = [];

    const result = await waitForBridgedMint(BURN_TX, {
      expectedMintRecipient: EXPECTED_RECIPIENT,
      sleep: async () => {},
      onAttested: () => (attestedCount += 1),
      onAttestStatus: (s) => attestStatuses.push(s),
      onMintStatus: (s) => mintStatuses.push(s),
    });

    expect(result).toEqual({ forwardTxHash: FORWARD_TX, message: MESSAGE, attestation: ATTESTATION });
    expect(attestedCount).toBe(1);
    // Status routed to the attest step before attestation, the mint step after.
    expect(attestStatuses.length).toBeGreaterThan(0);
    expect(mintStatuses.length).toBeGreaterThan(0);
    // One loop only — no fresh poll cycle was started for the mint step.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('is idempotent: attestation + forwardTxHash on the FIRST read resolve in a single fetch, onAttested once', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'complete', message: MESSAGE, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
        ],
      }),
    );

    let attestedCount = 0;
    const result = await waitForBridgedMint(BURN_TX, {
      expectedMintRecipient: EXPECTED_RECIPIENT,
      sleep: async () => {},
      onAttested: () => (attestedCount += 1),
    });

    expect(result).toEqual({ forwardTxHash: FORWARD_TX, message: MESSAGE, attestation: ATTESTATION });
    expect(attestedCount).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('PRESERVES the A1 fund-safety gate: refuses a forward whose message redirects the mint', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'complete', message: MESSAGE, attestation: ATTESTATION, forwardTxHash: FORWARD_TX },
        ],
      }),
    );

    const attacker = '0x000000000000000000000000000000000000bEEF';
    await expect(
      waitForBridgedMint(BURN_TX, {
        expectedMintRecipient: attacker,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('throws a RESUMABLE "waitForForwardedMint: timed out" once the deadline is exceeded', async () => {
    // The merged loop keeps ONE timeout label matched by errors.ts TRANSIENT_RE, so a
    // deadline exhaustion is still classified resumable (the burn replays by burnTxHash).
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(res(404, { error: 'not found' }));

    await expect(
      waitForBridgedMint(BURN_TX, {
        expectedMintRecipient: EXPECTED_RECIPIENT,
        intervalMs: 10,
        timeoutMs: 50,
        sleep: async (ms) => {
          vi.advanceTimersByTime(ms);
        },
      }),
    ).rejects.toThrow(/waitForForwardedMint: timed out/);

    vi.useRealTimers();
  });
});
