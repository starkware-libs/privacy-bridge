// On the RETURN leg every burn in a relayer batch shares the SAME mintRecipient (the
// one inbound anonymizer), so domains + recipient cannot identify OUR message — a
// stranger's return could be latched, feeding a wrong attestation to the claim or
// false-clearing the cursor via its consumed nonce / failed status. Only the burn-bound
// commitment in hookData is unique per return, so the selector must match on it, and a
// response with no commitment match must stay RESUMABLE (cursor preserved), never latch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation } from './polygonMint.js';
import { isTransientError } from './errors.js';
import { encodeCommitmentHookData } from '../derivation/index.js';

const BURN_TX = '0xreturnbundle01';
// Every entry mints to the SHARED anonymizer — recipient/domain match for ALL of them.
const ANONYMIZER_RECIPIENT =
  '0x0000000000000000000000000000000000000000000000000000000000049abc';
const SOURCE_DOMAIN = 7;

const OUR_COMMITMENT = 123456789n;
const STRANGER_COMMITMENT = 987654321n;

function buildReturnCctpMessage(opts: {
  hookData?: `0x${string}`;
  // Legacy/short body that ends before the hookData region (undecodable hookData).
  truncated?: boolean;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const word = (body = '') => body.padStart(64, '0');
  const recipient64 = ANONYMIZER_RECIPIENT.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const header =
    u32(1) +
    u32(SOURCE_DOMAIN) +
    u32(config.cctp.starknetDomain) +
    '00'.repeat(32 * 4) +
    u32(1000) +
    u32(1000);
  // BurnMessageV2: version, burnToken, mintRecipient, amount, messageSender[, maxFee,
  // feeExecuted, expirationBlock, hookData].
  const shortBody = u32(1) + word() + recipient64 + word('0f4240') + word();
  if (opts.truncated) return `0x${header}${shortBody}` as `0x${string}`;
  const fixedBody = shortBody + word() + word() + word();
  const hook = (opts.hookData ?? '0x').replace(/^0x/, '');
  return `0x${header}${fixedBody}${hook}` as `0x${string}`;
}

const OUR_MESSAGE = buildReturnCctpMessage({
  hookData: encodeCommitmentHookData(OUR_COMMITMENT),
});
const STRANGER_MESSAGE = buildReturnCctpMessage({
  hookData: encodeCommitmentHookData(STRANGER_COMMITMENT),
});

const complete = (message: `0x${string}`, attestation: string) => ({
  status: 'complete',
  message,
  attestation,
});

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Exactly what returnIn's returnMessageMatch builds from the cursor.
const MATCH = {
  expectedSourceDomain: SOURCE_DOMAIN,
  expectedDestinationDomain: config.cctp.starknetDomain,
  expectedRecipient: ANONYMIZER_RECIPIENT,
  expectedHookData: encodeCommitmentHookData(OUR_COMMITMENT),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('waitForAttestation — return-leg selection by hookData commitment', () => {
  it('selects OUR return among same-recipient batch-mates by its commitment', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          complete(STRANGER_MESSAGE, `0x${'aa'.repeat(65)}`),
          complete(OUR_MESSAGE, `0x${'bb'.repeat(65)}`),
        ],
      }),
    );

    const result = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 50,
      sleep: async () => {},
    });

    expect(result.message).toBe(OUR_MESSAGE);
    expect(result.attestation).toBe(`0x${'bb'.repeat(65)}`);
  });

  it('no commitment match → resumable timeout; never latches a same-recipient fallback', async () => {
    // Both entries pass the old domains+recipient test. Resolving with either would
    // feed a stranger's attestation to the claim (or its consumed nonce would
    // false-signal alreadyClaimed and clear the cursor). Transient ⇒ the caller
    // (finishAttest / recover) preserves the cursor and resumes.
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          complete(STRANGER_MESSAGE, `0x${'aa'.repeat(65)}`),
          complete(buildReturnCctpMessage({ hookData: '0x' }), `0x${'cc'.repeat(65)}`),
        ],
      }),
    );

    const err = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isTransientError(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/attestation failed|mismatch/i);
  });

  it('hookData missing entirely (truncated body) is not ours — keep polling', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [complete(buildReturnCctpMessage({ truncated: true }), `0x${'aa'.repeat(65)}`)],
      }),
    );

    const err = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(isTransientError(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/attestation failed|mismatch/i);
  });

  it('a same-recipient stranger with a FAILED status cannot terminal-clear our poll', async () => {
    // Its body decodes (so it is provably attributable) and its hookData is not our
    // commitment — a stranger's failure, not ours. Terminal-classifying it is what
    // would wipe the cursor on our still-pending burn.
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'failed', message: STRANGER_MESSAGE, attestation: '0x' }] }),
    );

    const err = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect((err as Error).message).not.toMatch(/attestation failed/i);
    expect(isTransientError(err)).toBe(true);
  });

  it('regression: a single entry carrying OUR commitment still resolves', async () => {
    fetchMock.mockResolvedValue(res(200, { messages: [complete(OUR_MESSAGE, '0xdd')] }));

    const result = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 50,
      sleep: async () => {},
    });

    expect(result.message).toBe(OUR_MESSAGE);
  });
});
