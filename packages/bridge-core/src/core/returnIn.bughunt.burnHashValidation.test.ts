// BUGHUNT — returnBurnToPool trusts the injected submitGaslessBatch(calls) return
// value VERBATIM as an on-chain tx hash and persists it into the resume cursor
// without any format validation. If the relayer returns "" (empty), a non-0x-hex
// string, or some other garbage, the cursor is written with a burnTx that FAILS
// the same isValidInflightReturn regex (/^0x[0-9a-fA-F]+$/) the read-side
// enforces — so on the NEXT call, readInflightReturn DROPS the "corrupt" cursor,
// the fresh path takes over, and the deposit wallet's USDC is BURNED A SECOND
// TIME (double-burn — the exact class returnBurnToPool's cursor exists to prevent).
//
// The RED assertion: EITHER the function fails closed pre-cursor-write on a bad
// hash (throws), OR the persisted cursor must round-trip through the SAME
// validator the read-side uses. Today: neither — the burn "succeeds" and the
// cursor is bad.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- collaborator mocks (mirrors returnIn.test.ts) -----------------------------
type MintCall = { contractAddress: string; entrypoint: string; calldata: string[] };
const { waitForAttestation, managerExecute, callContract, attestedMessage } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  managerExecute: vi.fn<
    (provider: unknown, call: MintCall, details?: unknown) => Promise<{ transaction_hash: string }>
  >(async () => ({ transaction_hash: '0xsnmint' })),
  callContract: vi.fn(async () => ['0', '0'] as string[]),
  attestedMessage: { value: '0x' as `0x${string}` },
}));

// Build a well-formed CCTP-v2 message that decodes to the given source/destination
// domain + the FULL 32-byte mintRecipient field + the FULL 32-byte destinationCaller
// field so BOTH snMint gates pass. Mirrors returnIn.test.ts.
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
    '00'.repeat(32 * 3) +
    destinationCaller +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) +
    '00'.repeat(32) +
    opts.recipientField64.toLowerCase() +
    '00'.repeat(32) +
    '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./proven-submit', () => ({ managerExecute }));
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
}));
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import {
  returnBurnToPool,
  isValidInflightReturn,
  INFLIGHT_RETURN_KEY,
  type ReturnBurnCall,
} from './returnIn';

const ACCOUNT_INDEX = 3;
const INBOUND = config.inboundAnonymizerAddress;
const INBOUND_FIELD64 = INBOUND.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const AMOUNT = 1_000_000n;
const COMMITMENT = 424242424242n;
const POLYGON_DOMAIN = config.polygon.domain;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;

function validAttestedMessage(): `0x${string}` {
  return buildCctpMessage({
    sourceDomain: POLYGON_DOMAIN,
    destinationDomain: config.cctp.starknetDomain,
    recipientField64: INBOUND_FIELD64,
  });
}

let submitGaslessBatch: ReturnType<typeof vi.fn<(calls: ReturnBurnCall[]) => Promise<string>>>;

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

function readCursor(): { burnTx?: unknown } | undefined {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, { burnTx?: unknown }>)[EVM_ADDRESS.toLowerCase()];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockResolvedValue(['0', '0']);
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

describe('BUGHUNT A — returnBurnToPool does not validate the injected relayer return value as a tx hash', () => {
  it('empty-string burnTx: either FAIL CLOSED pre-mint, or the persisted cursor must round-trip through isValidInflightReturn', async () => {
    submitGaslessBatch = vi.fn(async () => ''); // relayer returned empty

    let threw = false;
    try {
      await freshReturn();
    } catch {
      threw = true;
    }
    // Contract: a caller MUST NOT be able to reach a "success" path with an
    // unusable burn tx hash — either fail closed here (before mint / after burn
    // if we're being conservative), OR make the persisted cursor a resumable one.
    if (threw) return;

    const cursor = readCursor();
    expect(cursor).toBeDefined();
    // The read side (readInflightReturn) uses isValidInflightReturn to drop
    // "corrupt" cursors — a cursor written by the WRITE side that fails the same
    // check is a self-inflicted corruption. Next call would take the FRESH path
    // and RE-BURN the deposit wallet's USDC (double-burn).
    expect(isValidInflightReturn(cursor)).toBe(true);
  });

  it('non-0x-hex burnTx: either FAIL CLOSED, or the persisted cursor must round-trip through isValidInflightReturn', async () => {
    submitGaslessBatch = vi.fn(async () => 'not-a-hash'); // relayer garbage

    let threw = false;
    try {
      await freshReturn();
    } catch {
      threw = true;
    }
    if (threw) return;

    const cursor = readCursor();
    expect(cursor).toBeDefined();
    expect(isValidInflightReturn(cursor)).toBe(true);
  });
});
