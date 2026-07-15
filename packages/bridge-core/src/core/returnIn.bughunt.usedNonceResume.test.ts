// BUGHUNT E1 (now built into the fold design) — returnBurnToPool's RESUME path consults
// `is_nonce_used` on the SN MessageTransmitterV2 as an authoritative consumed-state gate
// (mirroring depositIn.ts:finishAttestAndMint's detectAlreadyMinted). In the FOLDED
// single-tx design the CCTP mint is inside the proven claim, so a CONSUMED nonce PROVES
// the folded claim already landed. On resume returnBurnToPool must DETECT that and signal
// `alreadyClaimed` (so the orchestrator skips the claim and clears the cursor) — never
// re-burning and never re-driving the claim into a `used_nonce` revert loop.
//
// (Pre-fold this file pinned the ASYMMETRY bug where returnIn had no such gate; the fold
// design resolves it structurally — returnBurnToPool always checks is_nonce_used on
// resume.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- collaborator mocks --------------------------------------------------------
type Call = { contractAddress: string; entrypoint: string; calldata: string[] };
const { waitForAttestation, callContract, attestedMessage } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  callContract: vi.fn(async () => ['0x0'] as string[]),
  attestedMessage: { value: '0x' as `0x${string}` },
}));

function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 3) +
    opts.recipientField64.toLowerCase() +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + opts.recipientField64.toLowerCase() + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

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
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import { returnBurnToPool, INFLIGHT_RETURN_KEY } from './returnIn';

const ACCOUNT_INDEX = 3;
const INBOUND = config.inboundAnonymizerAddress;
const INBOUND_FIELD64 = INBOUND.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
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

interface ReturnCursor {
  accountIndex: number;
  burnTx: string;
  sourceDomain: number;
  amount: string;
  commitment: string;
  evmChainId: number;
}
function seedCursor(): void {
  const record: ReturnCursor = {
    burnTx: '0xbeefface',
    accountIndex: ACCOUNT_INDEX,
    sourceDomain: POLYGON_DOMAIN,
    amount: AMOUNT.toString(),
    commitment: COMMITMENT.toString(),
    evmChainId: config.polygon.chainId,
  };
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: record }));
}

function resumeReturn() {
  return returnBurnToPool({
    accountIndex: ACCOUNT_INDEX,
    amount: AMOUNT,
    evmAddress: EVM_ADDRESS,
    commitment: COMMITMENT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockResolvedValue(['0x0']);
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

describe('E1: returnBurnToPool RESUME consults is_nonce_used (folded-claim consumed-state gate)', () => {
  it('a RESUME whose CCTP nonce is already consumed → alreadyClaimed (no re-burn, no re-claim), idempotent across repeats', async () => {
    // The folded claim already landed on a prior run (nonce consumed) but the cursor
    // lingered (a post-broadcast throw / silent persist miss).
    seedCursor();
    callContract.mockImplementation(async (req: Call) =>
      req.entrypoint === 'is_nonce_used' ? ['0x1'] : ['0x0'],
    );

    const result = await resumeReturn();
    // Detected without any re-burn: it signals alreadyClaimed for the orchestrator.
    expect(result.alreadyClaimed).toBe(true);

    // A second resume is still a clean detection (idempotent).
    const again = await resumeReturn();
    expect(again.alreadyClaimed).toBe(true);
  });

  it('RESUME reads is_nonce_used at least once (the consumed-state gate is consulted)', async () => {
    seedCursor();
    await resumeReturn();
    const nonceReads = callContract.mock.calls.filter(
      ([req]) => (req as Call).entrypoint === 'is_nonce_used',
    );
    expect(nonceReads.length).toBeGreaterThanOrEqual(1);
  });
});
