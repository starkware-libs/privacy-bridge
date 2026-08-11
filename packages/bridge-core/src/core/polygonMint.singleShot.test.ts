// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// fetchCctpMessageByTxHash — ONE Iris GET, no poll loop. Return recovery classifies
// HISTORICAL burns, so it must never wait: one request per burn, and every outcome short
// of "our complete message" is a THROW the caller reads as UNKNOWN. The failure buckets
// (not indexed / Iris down / not ours / not attested yet / Circle rejected it) must stay
// distinguishable — collapsing them into one would let a stuck burn read as settled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import {
  fetchCctpMessageByTxHash,
  IrisMessageUnavailableError,
  isTerminalAttestFailure,
  waitForAttestation,
} from './polygonMint.js';
import { isTransientError } from './errors.js';

const BURN_TX = '0xdeadbeef01';
const SOURCE_DOMAIN = 7;
const RECIPIENT = '0x0000000000000000000000000000000000000000000000000000000000049abc';
const OUR_HOOK = `0x${'11'.repeat(32)}` as `0x${string}`;
const OTHER_HOOK = `0x${'22'.repeat(32)}` as `0x${string}`;
const ATTESTATION = `0x${'bb'.repeat(65)}`;

// MessageV2 header + a FULL BurnMessageV2 body (through expirationBlock) so hookData
// lands at its real offset — hookData is the only thing telling two return burns to the
// same inbound anonymizer apart.
function buildCctpMessage(hookData: `0x${string}`): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const recipient64 = RECIPIENT.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const header =
    u32(1) +
    u32(SOURCE_DOMAIN) +
    u32(config.cctp.starknetDomain) +
    '00'.repeat(32 * 4) +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + // version
    '00'.repeat(32) + // burnToken
    recipient64 + // mintRecipient
    '00'.repeat(32) + // amount
    '00'.repeat(32) + // messageSender
    '00'.repeat(32) + // maxFee
    '00'.repeat(32) + // feeExecuted
    '00'.repeat(32) + // expirationBlock
    hookData.replace(/^0x/, '').toLowerCase();
  return `0x${header}${body}` as `0x${string}`;
}

const OUR_MESSAGE = buildCctpMessage(OUR_HOOK);
const OTHER_MESSAGE = buildCctpMessage(OTHER_HOOK);

const match = (hookData: `0x${string}`) => ({
  expectedSourceDomain: SOURCE_DOMAIN,
  expectedDestinationDomain: config.cctp.starknetDomain,
  expectedRecipient: RECIPIENT,
  expectedHookData: hookData,
});

const entry = (message: `0x${string}`, status = 'complete') => ({
  status,
  message,
  attestation: ATTESTATION,
});

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reject = async (hookData: `0x${string}` = OUR_HOOK): Promise<unknown> =>
  fetchCctpMessageByTxHash(BURN_TX, {
    sourceDomain: SOURCE_DOMAIN,
    match: match(hookData),
  }).then(
    () => new Error('expected a rejection'),
    (e: unknown) => e,
  );

describe('fetchCctpMessageByTxHash — the attested pair from exactly one GET', () => {
  it('resolves the matching entry and issues exactly one request', async () => {
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OUR_MESSAGE)] }));

    const result = await fetchCctpMessageByTxHash(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: match(OUR_HOOK),
    });

    expect(result).toEqual({ message: OUR_MESSAGE, attestation: ATTESTATION });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const base = config.cctp.irisUrl.replace(/\/+$/, '');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${base}/v2/messages/${SOURCE_DOMAIN}?transactionHash=${BURN_TX}`,
    );
  });

  it('picks OUR burn out of several with the same recipient, keyed on hookData', async () => {
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OTHER_MESSAGE), entry(OUR_MESSAGE)] }));

    const result = await fetchCctpMessageByTxHash(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: match(OUR_HOOK),
    });

    expect(result.message).toBe(OUR_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCctpMessageByTxHash — every failure throws after ONE request', () => {
  it('404 (not indexed) rejects immediately, without retrying', async () => {
    fetchMock.mockResolvedValue(res(404, { messages: [] }));

    const err = await reject();

    expect(err).toBeInstanceOf(IrisMessageUnavailableError);
    expect((err as IrisMessageUnavailableError).reason).toBe('not-indexed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 5xx rejects after ONE request — no backoff, no second attempt', async () => {
    fetchMock.mockResolvedValue(res(503, { messages: [] }));

    const err = await reject();

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IrisMessageUnavailableError);
    expect((err as Error).message).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network failure rejects after ONE request', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    const err = await reject();

    expect(err).not.toBeInstanceOf(IrisMessageUnavailableError);
    expect((err as Error).message).toContain('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an OK-but-empty body rejects with the labelled parse failure, after ONE request', async () => {
    fetchMock.mockResolvedValue(res(200, undefined));

    const err = await reject();

    expect((err as Error).message).toContain(
      'Iris /v2/messages (200): empty body (expected JSON).',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a response holding only OTHER burns rejects as unmatched — never resolves a stranger', async () => {
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OTHER_MESSAGE)] }));

    const err = await reject();

    expect(err).toBeInstanceOf(IrisMessageUnavailableError);
    expect((err as IrisMessageUnavailableError).reason).toBe('unmatched');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an indexed-but-unattested entry rejects as incomplete', async () => {
    fetchMock.mockResolvedValue(
      res(200, { messages: [entry(OUR_MESSAGE, 'pending_confirmations')] }),
    );

    const err = await reject();

    expect(err).toBeInstanceOf(IrisMessageUnavailableError);
    expect((err as IrisMessageUnavailableError).reason).toBe('incomplete');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // An empty shell is what the POLLER keeps waiting on, so it cannot be the bucket a caller
  // may read as "definitively not our burn".
  it.each([[[]], [undefined]])(
    'a 200 whose messages array is %j rejects as not-indexed, never unmatched',
    async (messages) => {
      fetchMock.mockResolvedValue(res(200, { messages }));

      const err = await reject();

      expect((err as IrisMessageUnavailableError).reason).toBe('not-indexed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('a rejected/failed Iris status rejects with the poller’s terminal wording', async () => {
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OUR_MESSAGE, 'failed')] }));

    const err = await reject();

    expect((err as Error).message).toContain('CCTP attestation failed (Iris status "failed")');
    expect(isTerminalAttestFailure(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a non-retryable HTTP status keeps the existing wording', async () => {
    fetchMock.mockResolvedValue(res(400, { messages: [] }));

    const err = await reject();

    expect((err as Error).message).toContain('Iris poll failed: HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '0x'])(
    'a match whose expectedHookData is %s fails loud, without touching the network',
    async (hookData) => {
      const err = await fetchCctpMessageByTxHash(BURN_TX, {
        sourceDomain: SOURCE_DOMAIN,
        // A JS caller (or a widened type) can drop the one field that discriminates.
        match: { ...match(OUR_HOOK), expectedHookData: hookData } as Parameters<
          typeof fetchCctpMessageByTxHash
        >[1]['match'],
      }).catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/expectedHookData is required/);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    },
  );

  it('a sourceDomain contradicting the match fails loud, without touching the network', async () => {
    const err = await fetchCctpMessageByTxHash(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN + 1,
      match: match(OUR_HOOK),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/source domain/i);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('fetchCctpMessageByTxHash — a failed read is UNKNOWN, never "no message"', () => {
  it('keeps the four read-failure buckets distinguishable', async () => {
    fetchMock.mockResolvedValue(res(404, { messages: [] }));
    const notIndexed = await reject();
    fetchMock.mockResolvedValue(res(503, { messages: [] }));
    const serverError = await reject();
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const network = await reject();
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OTHER_MESSAGE)] }));
    const unmatched = await reject();

    // Iris-said-nothing vs Iris-unreachable are different classes; the two
    // IrisMessageUnavailable cases differ by `reason`.
    expect((notIndexed as IrisMessageUnavailableError).reason).toBe('not-indexed');
    expect((unmatched as IrisMessageUnavailableError).reason).toBe('unmatched');
    expect(serverError).not.toBeInstanceOf(IrisMessageUnavailableError);
    expect(network).not.toBeInstanceOf(IrisMessageUnavailableError);
    expect(
      new Set([notIndexed, serverError, network, unmatched].map((e) => (e as Error).message)).size,
    ).toBe(4);
  });

  it('never reports a read failure as a TERMINAL attest failure (that clears cursors)', async () => {
    const cases: unknown[] = [];
    fetchMock.mockResolvedValue(res(404, { messages: [] }));
    cases.push(await reject());
    fetchMock.mockResolvedValue(res(503, { messages: [] }));
    cases.push(await reject());
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    cases.push(await reject());
    fetchMock.mockResolvedValue(res(200, undefined));
    cases.push(await reject());
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OTHER_MESSAGE)] }));
    cases.push(await reject());
    fetchMock.mockResolvedValue(
      res(200, { messages: [entry(OUR_MESSAGE, 'pending_confirmations')] }),
    );
    cases.push(await reject());

    expect(cases.map((e) => isTerminalAttestFailure(e))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('pins how isTransientError reads each bucket', async () => {
    // EVERY "Iris failed to answer" shape is transient — retryability must not depend on
    // which 5xx Iris picked, nor on whether the 200 was blank or merely non-object.
    fetchMock.mockResolvedValue(res(503, { messages: [] }));
    expect(isTransientError(await reject())).toBe(true);
    fetchMock.mockResolvedValue(res(500, { messages: [] }));
    expect(isTransientError(await reject())).toBe(true);
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    expect(isTransientError(await reject())).toBe(true);
    fetchMock.mockResolvedValue(res(200, undefined));
    expect(isTransientError(await reject())).toBe(true);
    fetchMock.mockResolvedValue(res(200, null));
    expect(isTransientError(await reject())).toBe(true);
    // Iris answering "nothing here" / "not yours" is not a transient shape.
    fetchMock.mockResolvedValue(res(404, { messages: [] }));
    expect(isTransientError(await reject())).toBe(false);
    fetchMock.mockResolvedValue(res(200, { messages: [entry(OTHER_MESSAGE)] }));
    expect(isTransientError(await reject())).toBe(false);
    // `incomplete` is retryable for EVERY status, not only Iris's own transient-sounding one.
    for (const status of ['pending_confirmations', 'minted', 'anything_else']) {
      fetchMock.mockResolvedValue(res(200, { messages: [entry(OUR_MESSAGE, status)] }));
      expect(isTransientError(await reject())).toBe(true);
    }
  });
});

// REGRESSION PIN (green before this PR): the poller shares the single-GET core and must
// still poll — a 404 is "not indexed yet" there, not an answer.
describe('waitForAttestation — still polls over the shared core', () => {
  it('retries a 404 and resolves on the next complete message', async () => {
    fetchMock
      .mockResolvedValueOnce(res(404, { messages: [] }))
      .mockResolvedValue(res(200, { messages: [entry(OUR_MESSAGE)] }));

    const result = await waitForAttestation(BURN_TX, {
      sourceDomain: SOURCE_DOMAIN,
      match: match(OUR_HOOK),
      intervalMs: 1,
      timeoutMs: 500,
      sleep: async () => {},
    });

    expect(result).toEqual({ message: OUR_MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
