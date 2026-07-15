// Bundle A1 — CCTP-v2 attested-message DECODER + mint-validation gate.
//
// We must NOT trust Iris's `message` / `forwardTxHash` unverified: Iris is a
// TRUSTED oblivious service (threat-model.md), so a compromised/MITM'd Iris could
// hand back a message that redirects the mint to an attacker EOA or a different
// chain. These tests pin the decoder offsets against a REAL attested Iris message
// (the GOLDEN fixture below) and prove the forwarded-mint gate rejects a tampered
// recipient/domain with a TERMINAL error before trusting the forward.
//
// No network is touched — the decoder is pure, and the forwarded-mint poll's
// fetch is mocked. The golden bytes are a captured live attestation (burn
// 0x2d3f…549b9), so the offsets are verified, not assumed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { decodeCctpMessage, waitForForwardedMint } from './polygonMint.js';
import { isTransientError } from './errors.js';

// --- GOLDEN fixture: a REAL attested Iris message (CCTP v2) ------------------
// Captured live from iris-api-sandbox /v2/messages/25?transactionHash=0x2d3f…549b9.
// Iris's own decodedMessage reports: sourceDomain 25, destinationDomain 7,
// decodedMessageBody.mintRecipient 0xac379d…b7921, amount 100000.
const GOLDEN_MESSAGE =
  '0x000000010000001900000007010a10ae78572dbfa6c0870f0143f0e7e1dc0d374877ac8937fd6abcfdf9942604bdde1e09a4b09a2f95d893d94a967b7717eb85a3f6deca8c080ee01fbc33700000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000003e8000003e8000000010512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343000000000000000000000000ac379d268ac099ab699b39c73ce623eca56b792100000000000000000000000000000000000000000000000000000000000186a003134168ba108079d32b25eaf37f49165c5e831df4c3b099daf09a8ee41d86ff0000000000000000000000000000000000000000000000000000000000000118000000000000000000000000000000000000000000000000000000000000008c0000000000000000000000000000000000000000000000000000000002679e55' as `0x${string}`;
const GOLDEN_RECIPIENT = '0xac379d268ac099ab699b39c73ce623eca56b7921';
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const FORWARD_TX = '0xfeedface' as `0x${string}`;
const BURN_TX = '0xabc123';

// Build a synthetic CCTP-v2 message (header + BurnMessageV2 body) — lets each
// test inject an arbitrary source/destination domain + mint recipient without a
// live burn. Layout mirrors polygonMint.ts: header 148 bytes, mintRecipient at
// body offset 36 (32-byte left-padded field; EVM addr = last 20 bytes).
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipient: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const recipient40 = opts.recipient.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  // header: version(4) src(4) dst(8) nonce(32) sender(32) recipient(32)
  //         destinationCaller(32) minFinality(4) finalityExecuted(4)
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) + // nonce + sender + recipient + destinationCaller
    u32(1000) + // minFinalityThreshold
    u32(1000); // finalityThresholdExecuted
  // body: version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32)
  const mintRecipientField = '00'.repeat(12) + recipient40; // left-pad 20 → 32 bytes
  const amount32 = (100000).toString(16).padStart(64, '0');
  const body = u32(1) + '00'.repeat(32) + mintRecipientField + amount32 + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

/** Build a mock fetch Response for the Iris poll. */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

// One Iris response carrying a forwarded mint for the given message.
function forwardedRes(message: `0x${string}`): Response {
  return res(200, {
    messages: [{ status: 'complete', message, attestation: ATTESTATION, forwardTxHash: FORWARD_TX }],
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decodeCctpMessage — golden Iris fixture (offsets verified live)', () => {
  it('decodes the real attested message: sourceDomain 25, destinationDomain 7, recipient', () => {
    const decoded = decodeCctpMessage(GOLDEN_MESSAGE);
    expect(decoded.sourceDomain).toBe(25);
    expect(decoded.destinationDomain).toBe(7);
    expect(decoded.mintRecipient).toBe(GOLDEN_RECIPIENT);
    // Sanity: 25/7 are exactly the configured Starknet/Polygon CCTP domains.
    expect(decoded.sourceDomain).toBe(config.cctp.starknetDomain);
    expect(decoded.destinationDomain).toBe(config.polygon.domain);
  });

  it('extracts the recipient as the LAST 20 bytes of the 32-byte left-padded field', () => {
    // The 12 leading bytes of the mintRecipient field are zero padding.
    const decoded = decodeCctpMessage(GOLDEN_MESSAGE);
    expect(decoded.mintRecipient).toHaveLength(42); // 0x + 40 hex
    expect(decoded.mintRecipient).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('round-trips a synthetic message built from the documented layout', () => {
    const msg = buildCctpMessage({
      sourceDomain: 25,
      destinationDomain: 7,
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    });
    expect(decodeCctpMessage(msg)).toEqual({
      sourceDomain: 25,
      destinationDomain: 7,
      mintRecipient: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      // Full 32-byte field = left-padded 20-byte EVM addr (Bundle A1 symmetry).
      mintRecipientFull: '0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8',
    });
  });

  it('rejects a message too short to contain the burn body', () => {
    expect(() => decodeCctpMessage(`0x${'aa'.repeat(64)}` as `0x${string}`)).toThrow(/too short/i);
  });

  it('rejects non-hex message bytes', () => {
    expect(() => decodeCctpMessage('0xnothex' as `0x${string}`)).toThrow(/not valid hex/i);
  });

  it('rejects an odd-length hex string (keeps the decoder total — no fractional bytes)', () => {
    // An odd nibble count would yield a fractional byteLen and silently mis-slice;
    // the decoder must reject it rather than decode a malformed message.
    expect(() => decodeCctpMessage('0xabc' as `0x${string}`)).toThrow(/not valid hex/i);
  });

  it('rejects a message with a wrong HEADER version (not CCTP v2 "1") (#107)', () => {
    // Same golden layout, but with the header version field ([0..4)) set to 2 —
    // e.g. a tampered/MITM'd Iris response, or a future CCTP layout change. Must
    // throw rather than silently decode against the wrong field offsets.
    const tampered = `0x00000002${GOLDEN_MESSAGE.slice(10)}` as `0x${string}`;
    expect(() => decodeCctpMessage(tampered)).toThrow(/unsupported cctp message version/i);
  });

  it('rejects a message with a wrong BODY version (not CCTP v2 "1") (#107)', () => {
    // The BurnMessageV2 body version field starts right after the 148-byte header
    // (body offset [+0..+4)); tamper only that u32 to 2, header stays valid (1).
    const headerHex = GOLDEN_MESSAGE.slice(2, 2 + 148 * 2);
    const bodyHex = GOLDEN_MESSAGE.slice(2 + 148 * 2);
    const tampered = `0x${headerHex}00000002${bodyHex.slice(8)}` as `0x${string}`;
    expect(() => decodeCctpMessage(tampered)).toThrow(/unsupported cctp message version/i);
  });
});

describe('waitForForwardedMint — A1 validation gate (refuse a tampered/redirected forward)', () => {
  it('returns the forward when the golden message matches the expected recipient + domains', async () => {
    fetchMock.mockResolvedValue(forwardedRes(GOLDEN_MESSAGE));
    const result = await waitForForwardedMint(BURN_TX, {
      intervalMs: 1,
      expectedMintRecipient: GOLDEN_RECIPIENT,
    });
    expect(result).toEqual({ forwardTxHash: FORWARD_TX });
  });

  it('matches the expected recipient case-insensitively (checksummed vs lower)', async () => {
    // bridgeOut hands us an EIP-55 checksummed address; the message carries it
    // lowercased. The gate must accept the same address regardless of case.
    const checksummed = '0xac379D268aC099Ab699b39C73ce623eca56B7921';
    fetchMock.mockResolvedValue(forwardedRes(GOLDEN_MESSAGE));
    await expect(
      waitForForwardedMint(BURN_TX, { intervalMs: 1, expectedMintRecipient: checksummed }),
    ).resolves.toEqual({ forwardTxHash: FORWARD_TX });
  });

  it('REFUSES the forward when the message recipient differs from expected (redirect attack)', async () => {
    fetchMock.mockResolvedValue(forwardedRes(GOLDEN_MESSAGE)); // mints to GOLDEN_RECIPIENT
    const attacker = '0x000000000000000000000000000000000000bEEF';
    await expect(
      waitForForwardedMint(BURN_TX, { intervalMs: 1, expectedMintRecipient: attacker }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('REFUSES the forward when the source domain is wrong (not Starknet 25)', async () => {
    const msg = buildCctpMessage({
      sourceDomain: 0, // tampered source domain
      destinationDomain: 7,
      recipient: GOLDEN_RECIPIENT,
    });
    fetchMock.mockResolvedValue(forwardedRes(msg));
    await expect(
      waitForForwardedMint(BURN_TX, { intervalMs: 1, expectedMintRecipient: GOLDEN_RECIPIENT }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('REFUSES the forward when the destination domain is wrong (not Polygon 7)', async () => {
    const msg = buildCctpMessage({
      sourceDomain: 25,
      destinationDomain: 0, // wrong destination chain
      recipient: GOLDEN_RECIPIENT,
    });
    fetchMock.mockResolvedValue(forwardedRes(msg));
    await expect(
      waitForForwardedMint(BURN_TX, { intervalMs: 1, expectedMintRecipient: GOLDEN_RECIPIENT }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
  });

  it('classifies the mismatch error as TERMINAL (never resume-loops)', () => {
    // The fund-account orchestrator must treat a tampered attestation as terminal, not as
    // a transient it keeps retrying. Assert the exact thrown wording is terminal.
    const mismatch = new Error(
      'CCTP message recipient/domain mismatch — refusing to submit (possible attestation tampering).',
    );
    expect(isTransientError(mismatch)).toBe(false);
  });
});
