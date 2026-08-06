// A 4337 BUNDLE transaction can carry several users' CCTP burns, so Iris returns
// MULTIPLE messages for one transactionHash. Taking messages[0] can hand a stranger's
// message to the mint path: the recipient/domain gate then throws TERMINALLY, which
// clears the resume cursor on a burn that already committed funds. The poller must
// select OUR message, and must never resolve with someone else's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { waitForAttestation } from './polygonMint.js';
import { isTransientError } from './errors.js';

const BURN_TX = '0xbundle01';
const OUR_RECIPIENT = '0x0000000000000000000000000000000000000000000000000000000000049abc';
const STRANGER_RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000badd1';
const SOURCE_DOMAIN = 7;

function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipient: string;
  amount?: number;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const recipient64 = opts.recipient.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) +
    u32(1000) +
    u32(1000);
  // BurnMessageV2: version, burnToken, mintRecipient(32), amount(32), messageSender(32)
  const body =
    u32(1) +
    '00'.repeat(32) +
    recipient64 +
    (opts.amount ?? 0).toString(16).padStart(64, '0') +
    '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

const OUR_MESSAGE = buildCctpMessage({
  sourceDomain: SOURCE_DOMAIN,
  destinationDomain: config.cctp.starknetDomain,
  recipient: OUR_RECIPIENT,
});
const STRANGER_MESSAGE = buildCctpMessage({
  sourceDomain: SOURCE_DOMAIN,
  destinationDomain: config.cctp.starknetDomain,
  recipient: STRANGER_RECIPIENT,
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

const MATCH = {
  expectedSourceDomain: SOURCE_DOMAIN,
  expectedDestinationDomain: config.cctp.starknetDomain,
  expectedRecipient: OUR_RECIPIENT,
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

describe('waitForAttestation — bundled transaction with several CCTP messages', () => {
  it('selects OUR message when a stranger’s is first in the list', async () => {
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

  it('an all-foreign response never resolves — it times out RESUMABLY, never terminally', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [complete(STRANGER_MESSAGE, `0x${'aa'.repeat(65)}`)] }),
    );

    const err = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // Transient ⇒ the caller keeps the cursor and can resume; a terminal classification
    // here is what wipes the only handle on a burn that already committed funds.
    expect(isTransientError(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/mismatch/i);
  });

  it('a stranger’s FAILED message does not abort our still-pending attestation', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'failed', message: STRANGER_MESSAGE, attestation: '0x' },
          { status: 'pending_confirmations', message: OUR_MESSAGE, attestation: '0x' },
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

    expect((err as Error).message).not.toMatch(/attestation failed/i);
    expect(isTransientError(err)).toBe(true);
  });

  it('our OWN failed message still short-circuits as terminal', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'failed', message: OUR_MESSAGE, attestation: '0x' }] }),
    );

    await expect(
      waitForAttestation(BURN_TX, {
        sourceDomain: SOURCE_DOMAIN,
        match: MATCH,
        intervalMs: 1,
        timeoutMs: 50,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/attestation failed/i);
  });

  it('N4: a genuinely failed attestation with NO decodable body still short-circuits', async () => {
    // Iris can report failed/rejected with an empty message, which the selector cannot
    // match on. Unambiguous (single entry) ⇒ it is ours ⇒ fail fast instead of burning
    // the full 30-minute window.
    fetchMock.mockResolvedValue(
      res(200, { messages: [{ status: 'failed', message: '0x', attestation: '0x' }] }),
    );

    await expect(
      waitForAttestation(BURN_TX, {
        sourceDomain: SOURCE_DOMAIN,
        match: MATCH,
        intervalMs: 1,
        timeoutMs: 50,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/attestation failed/i);
  });

  it('N7: a single DECODABLE non-matching failed entry is provably a stranger’s — keep polling', async () => {
    // Iris may have indexed only the stranger's message from our bundle tx so far. Its
    // body decodes and simply is not addressed to us, so terminal-clearing on it would
    // destroy the cursor for our still-pending burn.
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

  it('N4: an AMBIGUOUS bodiless failure alongside other messages does NOT short-circuit', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'failed', message: '0x', attestation: '0x' },
          complete(STRANGER_MESSAGE, `0x${'aa'.repeat(65)}`),
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

    // Cannot attribute it — stay resumable rather than declare someone else's failure ours.
    expect((err as Error).message).not.toMatch(/attestation failed/i);
    expect(isTransientError(err)).toBe(true);
  });

  it('N8: a stranger’s status is never reported as our progress', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        messages: [
          { status: 'stranger_specific_status', message: STRANGER_MESSAGE, attestation: '0x' },
        ],
      }),
    );
    const statuses: string[] = [];

    await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: MATCH,
      intervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
      onStatus: (m) => statuses.push(m),
    }).catch(() => undefined);

    expect(statuses.join(' ')).not.toMatch(/stranger_specific_status/);
  });

  it('without a match spec the historical single-message behavior is unchanged', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [complete(OUR_MESSAGE, `0x${'cc'.repeat(65)}`)] }),
    );

    const result = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      intervalMs: 1,
      timeoutMs: 50,
      sleep: async () => {},
    });

    expect(result.message).toBe(OUR_MESSAGE);
  });
});
