// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Behavioural tests for the shared manager-paid Starknet CCTP mint primitive
// (submitStarknetMint). This is the receive_message leg extracted from
// depositIn.ts so both the deposit-in (mint to derived SN account) and the
// returnIn (mint to the Anonymizer) callers share one implementation.
//
// The cross-chain mint is live-only (.claude/rules/verification.md); these pin
// the client behaviour: the A1 validation gate (real assertCctpMessageMatches),
// the receive_message call shape (transmitter address + cctpBytes calldata), and
// the manager-paid submit ({ tip: 0n } via managerExecute). Mocks only the
// boundaries snMint touches — ./proven-submit (manager submit) and ./tx (submit
// tracker); ./polygonMint is REAL so the gate actually runs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- collaborators -------------------------------------------------------------
type MintCall = { contractAddress: string; entrypoint: string; calldata: string[] };
const { managerExecute, submitAndTrack } = vi.hoisted(() => ({
  managerExecute: vi.fn<
    (provider: unknown, call: MintCall, details?: unknown) => Promise<{ transaction_hash: string }>
  >(async () => ({ transaction_hash: '0xsnmint' })),
  // Pass-through: run the submit fn and surface its result (mirrors depositIn.test.ts).
  // Typed with the optional 3rd opts arg so a test can assert `until`.
  submitAndTrack: vi.fn(
    async (_p: unknown, fn: () => Promise<unknown>, _opts?: { until?: string }) => fn(),
  ),
}));

vi.mock('./proven-submit', () => ({ managerExecute }));
vi.mock('./tx', () => ({ READ_BLOCK: 'pre_confirmed', submitAndTrack }));
// NOTE: ./polygonMint is intentionally NOT mocked — snMint imports the REAL
// assertCctpMessageMatches (a pure decoder/gate with no import-time side effects)
// so the gate genuinely runs.

import { config } from './config';
import { submitStarknetMint, assertReturnCctpMessage } from './snMint';

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) that decodes
// to the given source/destination domain + the FULL 32-byte mintRecipient field —
// so the A1 validation gate (assertCctpMessageMatches) passes. Layout mirrors
// polygonMint.ts: header 148 bytes, mintRecipient at body offset 36 (32-byte
// left-padded field; a Starknet felt fills the whole word). 148 + 132 = 280 bytes.
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string; // 64-hex (no 0x); felt left-padded to 32 bytes.
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) + // nonce + sender + recipient + destinationCaller
    u32(1000) + // minFinalityThreshold
    u32(1000); // finalityThresholdExecuted
  const body =
    u32(1) + // body version
    '00'.repeat(32) + // burnToken
    opts.recipientField64.toLowerCase() + // mintRecipient (full 32-byte field)
    '00'.repeat(32) + // amount
    '00'.repeat(32); // messageSender
  return `0x${header}${body}` as `0x${string}`;
}

const RECIPIENT = '0x49abc';
const RECIPIENT_FIELD64 = '49abc'.padStart(64, '0');
const SOURCE_DOMAIN = 7; // an EVM source (Polygon Amoy)
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
// The provider is only threaded to managerExecute/submitAndTrack (both mocked).
const provider = { _stub: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  managerExecute.mockResolvedValue({ transaction_hash: '0xsnmint' });
  // Default: no paymaster (manager-paid path). The AVNU describe block flips it.
  (config as { paymaster?: unknown }).paymaster =undefined;
});

describe('submitStarknetMint — manager-paid receive_message', () => {
  it('submits receive_message on the SN transmitter with cctpBytes calldata via the manager (tip 0)', async () => {
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: RECIPIENT_FIELD64,
    });

    await submitStarknetMint({
      provider,
      message,
      attestation: ATTESTATION,
      recipient: RECIPIENT,
      sourceDomain: SOURCE_DOMAIN,
    });

    // Exactly one manager submit.
    expect(managerExecute).toHaveBeenCalledTimes(1);
    const [submitProvider, mintCall, details] = managerExecute.mock.calls[0];
    // Threaded the provider through unchanged.
    expect(submitProvider).toBe(provider);
    // receive_message on the configured SN MessageTransmitterV2.
    expect(mintCall.entrypoint).toBe('receive_message');
    expect(mintCall.contractAddress).toBe(config.cctp.snMessageTransmitter);
    // calldata = encodeCctpBytes(message) ++ encodeCctpBytes(attestation), each a
    // Cairo ByteArray [num_full_words, …31B words…, pending_word, pending_word_len].
    // The message is a 280-byte CCTP-v2 blob → 9 full 31-byte words + a 1-byte
    // pending word, so its num_full_words felt (0x9) leads the calldata, and the
    // message ByteArray occupies 1 + 9 + 2 = 12 felts.
    expect(mintCall.calldata[0]).toBe('0x9');
    // …after which the 65-byte attestation ByteArray begins: 2 full words +
    // a 3-byte pending word → its leading num_full_words felt (0x2) at index 12.
    expect(mintCall.calldata[12]).toBe('0x2');
    expect(mintCall.calldata[mintCall.calldata.length - 1]).toBe('0x3'); // att pending_word_len
    // Manager-paid primitive: tip pinned to 0n (the deposit-in behaviour).
    expect(details).toEqual({ tip: 0n });

    // Tracked via submitAndTrack to ACCEPTED_ON_L2.
    expect(submitAndTrack).toHaveBeenCalledTimes(1);
    expect(submitAndTrack.mock.calls[0][2]).toMatchObject({ until: 'ACCEPTED_ON_L2' });
  });

  it('threads onStatus through during the mint', async () => {
    const statuses: string[] = [];
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: RECIPIENT_FIELD64,
    });
    await submitStarknetMint({
      provider,
      message,
      attestation: ATTESTATION,
      recipient: RECIPIENT,
      sourceDomain: SOURCE_DOMAIN,
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses.some((s) => /minting usdc on starknet/i.test(s))).toBe(true);
  });
});

describe('submitStarknetMint — AVNU sponsored paymaster (gasless, no manager)', () => {
  const PAYMASTER = {
    endpoint: 'https://pm.test',
    apiKey: 'KEY',
    feeMode: 'sponsored',
    poolFeeToken: '',
  } as never;

  it('submits receive_message GASLESS via the sponsored relayer when account + paymaster are set', async () => {
    (config as { paymaster?: unknown }).paymaster =PAYMASTER;
    const executePaymasterTransaction = vi.fn(async () => ({ transaction_hash: '0xsponsored' }));
    const account = { executePaymasterTransaction } as never;
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: RECIPIENT_FIELD64,
    });

    await submitStarknetMint({
      provider,
      account,
      message,
      attestation: ATTESTATION,
      recipient: RECIPIENT,
      sourceDomain: SOURCE_DOMAIN,
    });

    // Sponsored relayer path — NOT the manager (no admin needed in production).
    expect(executePaymasterTransaction).toHaveBeenCalledTimes(1);
    expect(managerExecute).not.toHaveBeenCalled();
    const [calls, feesDetails] = executePaymasterTransaction.mock.calls[0] as unknown as [
      MintCall[],
      unknown,
    ];
    expect(feesDetails).toEqual({ feeMode: { mode: 'sponsored' } });
    expect(calls[0].entrypoint).toBe('receive_message');
    expect(calls[0].contractAddress).toBe(config.cctp.snMessageTransmitter);
    // Calldata normalised to 0x-hex felts (AVNU rejects decimal).
    expect((calls[0].calldata as string[]).every((c) => c.startsWith('0x'))).toBe(true);
    // Still tracked to ACCEPTED_ON_L2.
    expect(submitAndTrack).toHaveBeenCalledTimes(1);
  });

  it('still runs the A1 gate BEFORE the sponsored submit (tampered message → never submits)', async () => {
    (config as { paymaster?: unknown }).paymaster =PAYMASTER;
    const executePaymasterTransaction = vi.fn();
    const account = { executePaymasterTransaction } as never;
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: 'beef'.padStart(64, '0'),
    });
    await expect(
      submitStarknetMint({
        provider,
        account,
        message,
        attestation: ATTESTATION,
        recipient: RECIPIENT,
        sourceDomain: SOURCE_DOMAIN,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(executePaymasterTransaction).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
  });

  it('falls back to the manager when no paymaster is configured (even with an account)', async () => {
    (config as { paymaster?: unknown }).paymaster =undefined;
    const executePaymasterTransaction = vi.fn();
    const account = { executePaymasterTransaction } as never;
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: RECIPIENT_FIELD64,
    });
    await submitStarknetMint({
      provider,
      account,
      message,
      attestation: ATTESTATION,
      recipient: RECIPIENT,
      sourceDomain: SOURCE_DOMAIN,
    });
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(executePaymasterTransaction).not.toHaveBeenCalled();
  });
});

describe('submitStarknetMint — A1 validation gate (refuses to submit a bad message)', () => {
  it('rejects a tampered recipient and NEVER submits', async () => {
    // Same Starknet destination domain but a DIFFERENT mint recipient.
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: 'beef'.padStart(64, '0'),
    });
    await expect(
      submitStarknetMint({
        provider,
        message,
        attestation: ATTESTATION,
        recipient: RECIPIENT,
        sourceDomain: SOURCE_DOMAIN,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(managerExecute).not.toHaveBeenCalled();
    expect(submitAndTrack).not.toHaveBeenCalled();
  });

  it('rejects a wrong destination domain (not Starknet) and NEVER submits', async () => {
    const message = buildCctpMessage({
      sourceDomain: SOURCE_DOMAIN,
      destinationDomain: config.polygon.domain, // wrong destination chain
      recipientField64: RECIPIENT_FIELD64,
    });
    await expect(
      submitStarknetMint({
        provider,
        message,
        attestation: ATTESTATION,
        recipient: RECIPIENT,
        sourceDomain: SOURCE_DOMAIN,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(managerExecute).not.toHaveBeenCalled();
    expect(submitAndTrack).not.toHaveBeenCalled();
  });

  it('rejects a wrong source domain and NEVER submits', async () => {
    // Message carries a DIFFERENT source domain than the one asserted.
    const message = buildCctpMessage({
      sourceDomain: 0, // Ethereum, not the SOURCE_DOMAIN we assert
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: RECIPIENT_FIELD64,
    });
    await expect(
      submitStarknetMint({
        provider,
        message,
        attestation: ATTESTATION,
        recipient: RECIPIENT,
        sourceDomain: SOURCE_DOMAIN,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(managerExecute).not.toHaveBeenCalled();
  });
});

describe('assertReturnCctpMessage — honors the burn-time inbound override (redeploy resume)', () => {
  const field64 = (addr: string) => BigInt(addr).toString(16).padStart(64, '0');
  // A CCTP-v2 message whose header destinationCaller AND body mintRecipient are both `inbound`.
  function buildReturnMessage(inbound: string): `0x${string}` {
    const u32 = (n: number) => n.toString(16).padStart(8, '0');
    const f = field64(inbound);
    const header =
      u32(1) + u32(SOURCE_DOMAIN) + u32(config.cctp.starknetDomain) +
      '00'.repeat(32) + // nonce
      '00'.repeat(32) + // sender
      '00'.repeat(32) + // header recipient
      f + // destinationCaller = inbound
      u32(1000) + u32(1000);
    const body =
      u32(1) + '00'.repeat(32) /* burnToken */ + f /* mintRecipient = inbound */ +
      '00'.repeat(32) /* amount */ + '00'.repeat(32) /* messageSender */;
    return `0x${header}${body}` as `0x${string}`;
  }

  const OLD_INBOUND = '0x071dd3a349c25f9a504bed70824a2a3479721085ed7664b74f40d0ce39989697';
  const NEW_INBOUND = '0x0514f74b94e86020f96f3f84f9999da913272b348390e67ac3f2556b95890c75';

  it('validates against the passed burn-time inbound, not current config (fixes redeploy pre-flight)', () => {
    const prev = config.inboundAnonymizerAddress;
    (config as { inboundAnonymizerAddress?: string }).inboundAnonymizerAddress = NEW_INBOUND;
    try {
      const msg = buildReturnMessage(OLD_INBOUND); // burned against the OLD contract
      // Burn-time override ⇒ the OLD-address message is accepted (the claim targets OLD too).
      expect(() => assertReturnCctpMessage(msg, SOURCE_DOMAIN, OLD_INBOUND)).not.toThrow();
      // Default (current config = NEW) ⇒ the OLD-address message is (correctly) rejected.
      expect(() => assertReturnCctpMessage(msg, SOURCE_DOMAIN)).toThrow(/recipient\/domain mismatch/i);
    } finally {
      (config as { inboundAnonymizerAddress?: string }).inboundAnonymizerAddress = prev;
    }
  });
});
