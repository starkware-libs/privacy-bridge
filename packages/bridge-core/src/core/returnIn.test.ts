// Behavioural tests for the return-funds Leg-A reverse-CCTP burn
// (returnBurnToPool). Exercises the REAL returnIn.ts against an INJECTED gasless
// submitter (no EVM RPC) and a mocked Iris attestation. The cross-chain leg itself is
// live-only (.claude/rules/verification.md); these pin the client behaviour: the burn is
// a GASLESS relayer batch FROM the deposit wallet (the EOA only signs — no POL
// precondition, no EOA tx), the approve+depositForBurnWithHook calls target the INBOUND
// ANONYMIZER on Starknet (mintRecipient AND destinationCaller, both the inbound felt —
// the bypass-proof requirement) with the bound commitment riding in hookData, and the
// attestation SOURCE domain (Polygon = 7).
//
// FOLD-ONLY: returnBurnToPool NO LONGER mints. It burns + attests and RETURNS the
// {message, attestation, sourceDomain, amount, alreadyClaimed} the folded pool claim
// (bridgeBack.ts) needs — the CCTP receive_message is folded INTO that proven claim. The
// post-burn cursor is a single "awaiting claim" state (no more 'cctp'/'claim' phases);
// resume idempotency comes from the CCTP nonce (a consumed nonce ⟺ the folded claim
// already landed → alreadyClaimed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';

// --- collaborators -------------------------------------------------------------
const { waitForAttestation, callContract, attestedMessage } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  // Answers is_nonce_used (returnBurnToPool's resume detectAlreadyClaimed gate). Default:
  // NOT used → a resume proceeds. The already-claimed test overrides to ['0x1'].
  callContract: vi.fn(async () => ['0x0'] as string[]),
  // Mutable holder so a test can override the attested message before the run; reset to a
  // valid one in beforeEach.
  attestedMessage: { value: '0x' as `0x${string}` },
}));

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body). Only the length /
// nonce bytes matter here (the recipient/destinationCaller gates moved to bridgeBack's
// pre-flight); kept realistic so is_nonce_used's nonce extraction has bytes to read.
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
  destinationCallerField64?: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const destinationCaller = (opts.destinationCallerField64 ?? opts.recipientField64).toLowerCase();
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 3) + // nonce + sender + (header) recipient
    destinationCaller +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + opts.recipientField64.toLowerCase() + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

// Mock only waitForAttestation (the network poll); keep the REAL isTerminalAttestFailure.
vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
}));

// Override ONLY inboundAnonymizerAddress to a real felt (the default is the '0x0'
// placeholder; the return path fails closed on it). Everything else is the REAL config.
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config, getEvmCctpSource } from './config';
import {
  returnBurnToPool,
  isValidInflightReturn,
  hasAnyInflightReturn,
  INFLIGHT_RETURN_KEY,
  type ReturnBurnCall,
} from './returnIn';

const ACCOUNT_INDEX = 3;
const INBOUND = config.inboundAnonymizerAddress;
const INBOUND_FIELD64 = INBOUND.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp
const COMMITMENT = 424242424242n;
const COMMITMENT_HOOK_DATA = `0x${COMMITMENT.toString(16).padStart(64, '0')}` as `0x${string}`;
const POLYGON = config.polygon;
const POLYGON_DOMAIN = config.polygon.domain; // 7
const SOURCE = getEvmCctpSource(config.polygon.chainId)!;
const TOKEN_MESSENGER = SOURCE.tokenMessenger;
const SOURCE_USDC = SOURCE.usdc;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const BURN_TX = '0xbeefcafe';

// The injected gasless submitter: returns the on-chain Polygon burn tx hash.
let submitGaslessBatch: ReturnType<typeof vi.fn<(calls: ReturnBurnCall[]) => Promise<string>>>;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
const DEPOSIT_FOR_BURN_WITH_HOOK_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

function validAttestedMessage(): `0x${string}` {
  return buildCctpMessage({
    sourceDomain: POLYGON_DOMAIN,
    destinationDomain: config.cctp.starknetDomain,
    recipientField64: INBOUND_FIELD64,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockResolvedValue(['0x0']);
  submitGaslessBatch = vi.fn(async () => BURN_TX);
  attestedMessage.value = validAttestedMessage();
  waitForAttestation.mockImplementation(async () => ({
    message: attestedMessage.value,
    attestation: ATTESTATION,
  }));
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// Convenience: invoke the fresh burn path with the injected gasless submitter.
function freshReturn(overrides: Record<string, unknown> = {}) {
  return returnBurnToPool({
    accountIndex: ACCOUNT_INDEX,
    amount: AMOUNT,
    evmAddress: EVM_ADDRESS,
    commitment: COMMITMENT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch,
    ...overrides,
  });
}

// A persisted inflight-return cursor as returnIn.ts writes it, keyed per EVM addr.
// (`phase` is a LEGACY optional field — pre-fold cursors carried it; it is ignored now.)
interface ReturnCursor {
  phase?: 'cctp' | 'claim';
  accountIndex: number;
  burnTx: string;
  sourceDomain: number;
  amount: string;
  commitment: string;
  evmChainId: number;
}
function seedReturnCursor(record: ReturnCursor): void {
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: record }));
}
function readReturnCursor(): ReturnCursor | undefined {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, ReturnCursor>)[EVM_ADDRESS.toLowerCase()];
}
function validCursor(): ReturnCursor {
  return {
    accountIndex: ACCOUNT_INDEX,
    burnTx: '0x0ab12cd34e',
    sourceDomain: POLYGON_DOMAIN,
    amount: AMOUNT.toString(),
    commitment: COMMITMENT.toString(),
    evmChainId: POLYGON.chainId,
  };
}

describe('returnBurnToPool — happy path (gasless burn from the deposit wallet; returns the folded-claim inputs)', () => {
  it('submits the gasless burn batch [approve, depositForBurnWithHook] toward Starknet/InboundAnonymizer (hookData = commitment), attests by POLYGON domain, returns {message, attestation}', async () => {
    const result = await freshReturn();

    // The burn was a SINGLE gasless relayer batch from the deposit wallet.
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    const calls = submitGaslessBatch.mock.calls[0][0];
    expect(calls).toHaveLength(2);

    // call[0] = approve(tokenMessenger, amount) on Polygon USDC — decode the calldata.
    expect(calls[0].target.toLowerCase()).toBe(SOURCE_USDC.toLowerCase());
    const approve = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: calls[0].data });
    expect(approve.functionName).toBe('approve');
    expect((approve.args[0] as string).toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
    expect(approve.args[1]).toBe(AMOUNT);

    // call[1] = depositForBurnWithHook toward STARKNET / the InboundAnonymizer.
    expect(calls[1].target.toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
    const burn = decodeFunctionData({ abi: DEPOSIT_FOR_BURN_WITH_HOOK_ABI, data: calls[1].data });
    expect(burn.functionName).toBe('depositForBurnWithHook');
    const [amount, destDomain, mintRecipient, burnToken, destCaller, maxFee, finality, hookData] =
      burn.args as [bigint, number, string, string, string, bigint, number, string];
    expect(amount).toBe(AMOUNT);
    // Destination is STARKNET, not the source (Polygon) domain.
    expect(destDomain).toBe(config.cctp.starknetDomain);
    // mintRecipient AND destinationCaller = the INBOUND ANONYMIZER left-padded to 32
    // bytes (the bypass-proof requirement — NOT zero, NOT the wallet/SN account).
    expect(mintRecipient).toBe('0x' + INBOUND_FIELD64);
    expect(destCaller).toBe('0x' + INBOUND_FIELD64);
    expect(burnToken.toLowerCase()).toBe(SOURCE_USDC.toLowerCase());
    expect(maxFee).toBe(0n); // fee-free return burn
    expect(finality).toBe(2000); // Standard default
    // hookData carries the bound commitment (32-byte big-endian).
    expect((hookData as string).toLowerCase()).toBe(COMMITMENT_HOOK_DATA);

    // Attestation polled by the POLYGON SOURCE domain (7), keyed on the relayer's burn tx.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe(BURN_TX);
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(POLYGON_DOMAIN);

    // It returns the folded-claim inputs — NO on-chain mint here (that is folded into the
    // proven claim). alreadyClaimed is false on a fresh burn.
    expect(result).toEqual({
      message: attestedMessage.value,
      attestation: ATTESTATION,
      sourceDomain: POLYGON_DOMAIN,
      amount: AMOUNT,
      alreadyClaimed: false,
    });
  });

  it('uses the EVM Polygon TokenMessengerV2 (NOT the Starknet messenger felt) as approve spender + burn target', async () => {
    await freshReturn();
    const calls = submitGaslessBatch.mock.calls[0][0];
    const approve = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: calls[0].data });
    expect((approve.args[0] as string).toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
    expect(calls[1].target.toLowerCase()).toBe(TOKEN_MESSENGER.toLowerCase());
    expect(calls[0].target.toLowerCase()).toBe(SOURCE_USDC.toLowerCase());
    // REGRESSION GUARD: the spender/target must NOT be the Starknet TokenMessengerMinter
    // felt — using a Starknet address on Polygon loses the wallet's funds.
    expect(TOKEN_MESSENGER.toLowerCase()).not.toBe(config.cctp.snTokenMessengerMinter.toLowerCase());
    expect((approve.args[0] as string).toLowerCase()).not.toBe(
      config.cctp.snTokenMessengerMinter.toLowerCase(),
    );
    expect(calls[1].target.toLowerCase()).not.toBe(config.cctp.snTokenMessengerMinter.toLowerCase());
  });

  it('reads NO POL/native balance and signs NO EOA tx — the burn is the injected gasless batch', async () => {
    await freshReturn();
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe(BURN_TX);
  });
});

describe('returnBurnToPool — guards', () => {
  it('throws (no burn) on a zero amount', async () => {
    await expect(freshReturn({ amount: 0n })).rejects.toThrow(/greater than zero/i);
    expect(submitGaslessBatch).not.toHaveBeenCalled();
  });

  it('throws (no burn) on a fresh return missing the deposit wallet / submitter', async () => {
    await expect(
      returnBurnToPool({
        accountIndex: ACCOUNT_INDEX,
        amount: AMOUNT,
        evmAddress: EVM_ADDRESS,
        commitment: COMMITMENT,
      }),
    ).rejects.toThrow(/deposit wallet|gasless submitter/i);
  });

  it('FAILS CLOSED (no burn) when inboundAnonymizerAddress is the "0x0" placeholder (not deployed)', async () => {
    const original = config.inboundAnonymizerAddress;
    (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = '0x0';
    try {
      await expect(freshReturn()).rejects.toThrow(/inboundAnonymizerAddress not configured/i);
      expect(submitGaslessBatch).not.toHaveBeenCalled();
    } finally {
      (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = original;
    }
  });
});

describe('returnBurnToPool — inflight-return resume cursor', () => {
  it('LEAVES the post-burn cursor in place after a fresh CCTP run (no phase advance; the claim stage clears it)', async () => {
    await freshReturn();
    const cursor = readReturnCursor();
    // NOT cleared — the burn landed but the folded claim (owned by the orchestrator) has
    // not. The cursor is a single post-burn state (no phase advance).
    expect(cursor).toBeDefined();
    expect(cursor!.burnTx).toBe(BURN_TX);
    expect(cursor!.commitment).toBe(COMMITMENT.toString());
    expect(cursor!.accountIndex).toBe(ACCOUNT_INDEX);
  });

  it('persists the post-burn cursor (with the burn tx + bound commitment) BEFORE attest', async () => {
    // Fail attestation so the run stops right after the cursor write.
    waitForAttestation.mockRejectedValueOnce(new Error('network error'));
    await expect(freshReturn()).rejects.toThrow();
    const cursor = readReturnCursor();
    expect(cursor).toBeDefined();
    expect(cursor!.burnTx).toBe(BURN_TX);
    expect(cursor!.commitment).toBe(COMMITMENT.toString());
  });

  it('RESUMES from a persisted cursor: skips the burn, attests off the cursor, returns the folded-claim inputs', async () => {
    seedReturnCursor(validCursor());

    // No depositWallet/submitter passed: a resume must NOT need them (it does not re-burn).
    const result = await returnBurnToPool({
      accountIndex: ACCOUNT_INDEX,
      amount: AMOUNT,
      evmAddress: EVM_ADDRESS,
      commitment: COMMITMENT,
    });

    // Did NOT re-burn (re-burning double-spends the wallet's USDC in the window).
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    // Resumed attest off the PERSISTED burn tx + its source domain.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(POLYGON_DOMAIN);
    // Returned the folded-claim inputs (nonce not consumed → not alreadyClaimed).
    expect(result.alreadyClaimed).toBe(false);
    expect(result.message).toBe(attestedMessage.value);
    // The cursor is left in place (the orchestrator's claim stage clears it).
    expect(readReturnCursor()).toBeDefined();
  });

  it('RESUMES from a cursor persisted with the legacy index field (migrate-on-read, Slice R)', async () => {
    const legacyCursor = { ...validCursor() } as Record<string, unknown>;
    delete legacyCursor.accountIndex;
    legacyCursor.bidIndex = ACCOUNT_INDEX;
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: legacyCursor }));

    const result = await returnBurnToPool({
      accountIndex: ACCOUNT_INDEX,
      amount: AMOUNT,
      evmAddress: EVM_ADDRESS,
      commitment: COMMITMENT,
    });

    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(result.alreadyClaimed).toBe(false);
  });

  it('REFUSES a cursor for a DIFFERENT account (cross-account guard): throws, no burn, no attest, cursor untouched', async () => {
    seedReturnCursor(validCursor());
    await expect(freshReturn({ accountIndex: ACCOUNT_INDEX + 96 })).rejects.toThrow(/already in progress/i);
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(readReturnCursor()!.accountIndex).toBe(ACCOUNT_INDEX);
  });

  it('resume with a CONSUMED CCTP nonce → alreadyClaimed (the folded claim landed), no re-burn (#102)', async () => {
    // A prior run's FOLDED claim already landed (mint inside it → nonce consumed). The
    // resume must detect it and signal alreadyClaimed WITHOUT re-burning (re-proving would
    // waste a proof and the folded receive_message would revert used_nonce).
    seedReturnCursor(validCursor());
    callContract.mockResolvedValue(['0x1']); // is_nonce_used → used

    const result = await returnBurnToPool({
      accountIndex: ACCOUNT_INDEX,
      amount: AMOUNT,
      evmAddress: EVM_ADDRESS,
      commitment: COMMITMENT,
    });

    expect(submitGaslessBatch).not.toHaveBeenCalled();
    // It still attests once (to obtain the message to check the nonce)…
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    // …and reports the claim already landed.
    expect(result.alreadyClaimed).toBe(true);
    // Cursor left in place — the orchestrator (returnToPool) clears it on alreadyClaimed.
    expect(readReturnCursor()).toBeDefined();
  });

  it('does NOT resume off a cursor written by a DIFFERENT EVM address', async () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({
        '0x00000000000000000000000000000000000ffff': { ...validCursor(), burnTx: '0x0ffe12b04a' },
      }),
    );

    await freshReturn();

    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe(BURN_TX);
  });
});

describe('returnBurnToPool — corrupt cursor', () => {
  it('isValidInflightReturn rejects a malformed record but ACCEPTS a legacy phase field (ignored)', () => {
    expect(isValidInflightReturn({ burnTx: 123, garbage: true })).toBe(false);
    expect(isValidInflightReturn(null)).toBe(false);
    // A cursor with a leftover/legacy phase value is STILL valid — phase is not checked.
    expect(isValidInflightReturn({ ...validCursor(), phase: 'nope' })).toBe(true);
    expect(isValidInflightReturn({ ...validCursor(), phase: 'cctp' })).toBe(true);
    expect(isValidInflightReturn(validCursor())).toBe(true);
  });

  it('isValidInflightReturn rejects an unbounded-length amount OR commitment string (#110)', () => {
    expect(isValidInflightReturn({ ...validCursor(), amount: '9'.repeat(10_000) })).toBe(false);
    expect(isValidInflightReturn({ ...validCursor(), commitment: '9'.repeat(10_000) })).toBe(false);
    expect(isValidInflightReturn({ ...validCursor(), amount: '9'.repeat(78) })).toBe(true);
    expect(isValidInflightReturn({ ...validCursor(), commitment: '9'.repeat(78) })).toBe(true);
  });

  it('ignores + clears a CORRUPT cursor and runs the fresh burn path', async () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: { burnTx: 123, garbage: true } }),
    );

    await freshReturn();

    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe(BURN_TX);
  });
});

// Clear-vs-preserve lifecycle on a post-burn failure mirrors depositIn: a
// DEMONSTRABLY-TERMINAL attestation failure clears the cursor (resume can't help); ANY
// OTHER failure PRESERVES it so the next run resumes (the burn is replayable by tx hash).
// (The recipient/domain + destinationCaller message gates moved to bridgeBack's pre-flight
// — see bridgeBack.ts:buildAndProveClaim / snMint.ts:assertReturnCctpMessage.)
describe('returnBurnToPool — clear-on-terminal vs preserve', () => {
  it('CLEARS the cursor on a demonstrably-terminal Iris attestation failure (after burn)', async () => {
    waitForAttestation.mockRejectedValueOnce(new Error('Iris: attestation failed for this message'));
    await expect(freshReturn()).rejects.toThrow(/attestation failed/i);
    // Burn DID happen (fresh path), but the terminal gate cleared the cursor.
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    expect(readReturnCursor()).toBeUndefined();
  });

  it('PRESERVES the cursor on an UNCLASSIFIED non-terminal attest error (resume stays possible)', async () => {
    waitForAttestation.mockRejectedValueOnce(new Error('some transient network blip'));
    await expect(freshReturn()).rejects.toThrow(/transient network blip/i);
    // The cursor survives so the next run resumes.
    expect(readReturnCursor()).toBeDefined();
    expect(readReturnCursor()!.burnTx).toBe(BURN_TX);
  });

  it('PRESERVES the cursor on an is_nonce_used read FAILURE (a read proves nothing → never treated as claimed)', async () => {
    seedReturnCursor(validCursor());
    callContract.mockRejectedValue(new Error('RPC down'));
    await expect(
      returnBurnToPool({
        accountIndex: ACCOUNT_INDEX,
        amount: AMOUNT,
        evmAddress: EVM_ADDRESS,
        commitment: COMMITMENT,
      }),
    ).rejects.toThrow(/RPC down/i);
    expect(readReturnCursor()).toBeDefined();
  });
});

// FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): the funder-AGNOSTIC
// return-cursor reader the network switch guard consults.
describe('hasAnyInflightReturn — funder-agnostic cursor detection (Bugbot HIGH)', () => {
  it('is false with no persisted cursor', () => {
    expect(hasAnyInflightReturn()).toBe(false);
  });

  it('is TRUE when SOME address has a valid cursor — WITHOUT passing an address', () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ '0x00000000000000000000000000000000000abcde': validCursor() }),
    );
    expect(hasAnyInflightReturn()).toBe(true);
  });

  it('is TRUE for a legacy claim-phase cursor too (phase ignored)', () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ '0xabc': { ...validCursor(), phase: 'claim' } }),
    );
    expect(hasAnyInflightReturn()).toBe(true);
  });

  it('is false when the ONLY persisted record is corrupt (not resumable off garbage)', () => {
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ '0xabc': { burnTx: 123 } }));
    expect(hasAnyInflightReturn()).toBe(false);
  });

  it('is TRUE when at least one of several records is valid (mixed corrupt + valid)', () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ '0xbad': { burnTx: 1 }, '0x9999': validCursor() }),
    );
    expect(hasAnyInflightReturn()).toBe(true);
  });
});
