// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// RESUME-ONLY entry into returnToPool — the counterpart of the deposit leg's
// resumeOnly suite (moveIntoPool.resumeOnly.test.ts). `resume: true` finishes an
// already-committed return and can NEVER start one:
//   - no cursor and no pending record        ⇒ NOTHING_TO_RESUME (non-retryable)
//   - a pending record that did not resolve  ⇒ the unresolved-submission refusal
//   - the stale-balance heuristic is SKIPPED ⇒ a resume never clears its own cursor
// The mocking surface mirrors returnToPool.test.ts: REAL returnToPool/returnBurnToPool/
// derivation, with only the outermost edges (bridgeBack, Iris, provider/tx, viem client,
// config) stubbed. The Polymarket-coupled fresh prep is the injected spy that must never
// fire — it owns every EVM signing step on this leg, so "prep never called" IS
// "the wallet was never touched".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  waitForAttestation,
  callContract,
  attestedMessage,
  claimToPool,
  buildAndProveClaim,
  submitProvenClaim,
  PROVEN,
  getLogs,
  getBlockNumber,
  request,
} = vi.hoisted(() => {
  const PROVEN = { __proven: true } as const;
  return {
    waitForAttestation:
      vi.fn<
        (
          burnTx: string,
          opts: { sourceDomain?: number; onStatus?: (s: string) => void },
        ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
      >(),
    callContract: vi.fn(async (_request?: { entrypoint?: string }) => ['0x0'] as string[]),
    attestedMessage: { value: '0x' as `0x${string}` },
    claimToPool: vi.fn(async () => ({ claimTxHash: '0xc1a1m' })),
    getLogs: vi.fn(async () => [] as unknown[]),
    getBlockNumber: vi.fn(async () => 1_000n),
    request: vi.fn(async (_args: { method: string; params?: unknown[] }) => null as unknown),
    buildAndProveClaim: vi.fn(async () => PROVEN),
    submitProvenClaim: vi.fn(async () => '0xc1a1m'),
    PROVEN,
  };
});

function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const destinationCaller = opts.recipientField64.toLowerCase();
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
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
  makeAccount: vi.fn(() => ({ address: '0xsnacct' })),
}));
vi.mock('./bridgeBack', () => ({ claimToPool, buildAndProveClaim, submitProvenClaim }));
vi.mock('viem', async (importOriginal) => {
  const mod = await importOriginal<typeof import('viem')>();
  return {
    ...mod,
    createPublicClient: vi.fn(() => ({ getLogs, getBlockNumber, request })),
  };
});
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import { isNonRetryable } from './errors';
import { PENDING_RETURN_BURN_KEY, PENDING_BURN_DEADLINE_GRACE_MS } from './pendingReturnBurn';
import { returnToPool, INFLIGHT_RETURN_KEY, type FreshReturnPlan } from './returnIn';
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';

const ACCOUNT_INDEX = 3;
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const INBOUND = config.inboundAnonymizerAddress;
const INBOUND_FIELD64 = INBOUND.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const FRESH_AMOUNT = 1_787_670n;
const POLYGON_DOMAIN = config.polygon.domain;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const BURN_TX = '0xbeefcafe';
const CURSOR_BURN_TX = '0x0ab12cd34e';

const VIEWING_KEY = deriveViewingKey(SIGNATURE);
const ACCOUNT_NONCE = deriveAccountNonce(VIEWING_KEY, ACCOUNT_INDEX);
const SN_PRIVATE_KEY = deriveStarknetPrivateKey(SIGNATURE);
const { address: SN_ADDRESS } = deriveStarknetAccount(SN_PRIVATE_KEY, config.ozClassHash);
const EXPECTED_COMMITMENT = deriveInboundCommitment({
  userAddr: BigInt(SN_ADDRESS),
  userPrivateKey: VIEWING_KEY,
  inboundAddr: BigInt(INBOUND),
  sourceDomain: POLYGON_DOMAIN,
  nonce: ACCOUNT_NONCE,
});

let submitGaslessBatch: ReturnType<typeof vi.fn<(calls: unknown[]) => Promise<string>>>;
let prepareFreshReturn: ReturnType<typeof vi.fn<() => Promise<FreshReturnPlan>>>;
let readReturnableBalance: ReturnType<typeof vi.fn<() => Promise<bigint>>>;

interface ReturnCursor {
  accountIndex: number;
  burnTx: string;
  sourceDomain: number;
  amount: string;
  commitment: string;
  evmChainId: number;
  inboundAnonymizer?: string;
  proven?: true;
}
function burnedCursor(overrides: Partial<ReturnCursor> = {}): ReturnCursor {
  return {
    accountIndex: ACCOUNT_INDEX,
    burnTx: CURSOR_BURN_TX,
    sourceDomain: POLYGON_DOMAIN,
    amount: FRESH_AMOUNT.toString(),
    commitment: EXPECTED_COMMITMENT.toString(),
    evmChainId: config.polygon.chainId,
    ...overrides,
  };
}
function seedCursor(record: unknown): void {
  localStorage.setItem(
    INFLIGHT_RETURN_KEY,
    JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: record }),
  );
}
function readCursor(): ReturnCursor | undefined {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, ReturnCursor>)[EVM_ADDRESS.toLowerCase()];
}

function seedPending(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem(
    PENDING_RETURN_BURN_KEY,
    JSON.stringify({
      [EVM_ADDRESS.toLowerCase()]: {
        accountIndex: ACCOUNT_INDEX,
        depositWallet: DEPOSIT_WALLET,
        amount: FRESH_AMOUNT.toString(),
        commitment: EXPECTED_COMMITMENT.toString(),
        sourceDomain: POLYGON_DOMAIN,
        evmChainId: config.polygon.chainId,
        inboundAnonymizer: INBOUND,
        submittedAtMs: Date.now(),
        fromBlock: '900',
        deadlineMs: Date.now() + 600_000,
        ...overrides,
      },
    }),
  );
}
function readPending(): Record<string, unknown> | undefined {
  const raw = localStorage.getItem(PENDING_RETURN_BURN_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, Record<string, unknown>>)[EVM_ADDRESS.toLowerCase()];
}
function landedBurnLog() {
  return {
    transactionHash: BURN_TX,
    args: {
      burnToken: '0xUSDC',
      amount: FRESH_AMOUNT,
      depositor: DEPOSIT_WALLET,
      mintRecipient: `0x${INBOUND_FIELD64}`,
      destinationDomain: config.cctp.starknetDomain,
      hookData: `0x${EXPECTED_COMMITMENT.toString(16).padStart(64, '0')}`,
    },
  };
}

function run(overrides: Partial<Parameters<typeof returnToPool>[0]> = {}) {
  return returnToPool({
    signature: SIGNATURE,
    accountIndex: ACCOUNT_INDEX,
    evmAddress: EVM_ADDRESS,
    prepareFreshReturn,
    readReturnableBalance,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockImplementation(async (request?: { entrypoint?: string }) =>
    request?.entrypoint === 'is_nonce_used' ? ['0x0'] : ['0', '0'],
  );
  attestedMessage.value = buildCctpMessage({
    sourceDomain: POLYGON_DOMAIN,
    destinationDomain: config.cctp.starknetDomain,
    recipientField64: INBOUND_FIELD64,
  });
  waitForAttestation.mockImplementation(async () => ({
    message: attestedMessage.value,
    attestation: ATTESTATION,
  }));
  submitGaslessBatch = vi.fn(async () => BURN_TX);
  prepareFreshReturn = vi.fn(async () => ({
    amount: FRESH_AMOUNT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch,
  }));
  readReturnableBalance = vi.fn(async () => 0n);
  request.mockImplementation(async () => null);
  claimToPool.mockResolvedValue({ claimTxHash: '0xc1a1m' });
  buildAndProveClaim.mockResolvedValue(PROVEN);
  submitProvenClaim.mockResolvedValue('0xc1a1m');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('returnToPool({ resume: true }) — nothing to resume', () => {
  it('with NO cursor and NO pending record: throws NOTHING_TO_RESUME without touching the wallet or the chain', async () => {
    const err = await run({ resume: true }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'NOTHING_TO_RESUME' });
    // The prep owns every EVM signing step on this leg (convert, sizing, the gasless
    // submitter) — never calling it is what makes "a resume can never burn" structural.
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(buildAndProveClaim).not.toHaveBeenCalled();
    expect(submitProvenClaim).not.toHaveBeenCalled();
    // Zero eth_* traffic: nothing pending ⇒ no recovery scan, no receipt read.
    expect(request).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('NOTHING_TO_RESUME is non-retryable (an unattended watcher must not spin on it)', async () => {
    const err = await run({ resume: true }).catch((e: unknown) => e);
    expect(isNonRetryable(err)).toBe(true);
  });

  it('a CORRUPT cursor is nothing to resume — it must not fall through to a fresh burn', async () => {
    seedCursor({ accountIndex: ACCOUNT_INDEX, burnTx: 'not-a-hash' });

    const err = await run({ resume: true }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
  });

  it('[mutation guard] the SAME state without `resume` DOES take the fresh path', async () => {
    // Inverts the flag on the double: proves the assertions above pin the guard and not
    // some unrelated reason the fresh path was skipped.
    await expect(run()).resolves.toMatchObject({ ranFreshBurn: true });
    expect(prepareFreshReturn).toHaveBeenCalledTimes(1);
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
  });
});

describe('returnToPool({ resume: true }) — pending submission records', () => {
  it('an UNRESOLVED-but-executable record throws the unresolved-submission refusal, NOT NOTHING_TO_RESUME', async () => {
    seedPending();

    const err = await run({ resume: true }).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/submitted from this device/i);
    expect(err).not.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    // The record is the only handle on a burn that may be mining — it must survive.
    expect(readPending()).toMatchObject({ commitment: EXPECTED_COMMITMENT.toString() });
    expect(prepareFreshReturn).not.toHaveBeenCalled();
  });

  it('a record PAST its deadline that the scan cannot resolve is still not "nothing to resume"', async () => {
    // The double-burn guard releases on time so a FRESH return can proceed, but a resume has
    // no fresh path to release to. Reporting the terminal NOTHING_TO_RESUME over a record that
    // still points at a possibly-landed burn would tell an unattended watcher to stop looking.
    // A range-capped provider is the live case: it REJECTS the over-range getLogs, so the scan
    // resolves 'unknown' and the record outlives its deadline instead of being retired.
    seedPending({ deadlineMs: Date.now() - PENDING_BURN_DEADLINE_GRACE_MS - 60_000 });
    getLogs.mockRejectedValue(new Error('-32600: block range exceeds the 10 block limit'));

    const err = await run({ resume: true }).catch((e: unknown) => e);

    expect(err).not.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(isNonRetryable(err)).toBe(false);
    expect((err as Error).message).toMatch(/submitted from this device/i);
    expect(readPending()).toBeDefined();
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
  });

  it('a record that RESOLVES landed is promoted and the folded claim runs', async () => {
    seedPending();
    getLogs.mockResolvedValue([landedBurnLog()]);

    const result = await run({ resume: true });

    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith(BURN_TX, expect.anything());
    expect(submitProvenClaim).toHaveBeenCalledTimes(1);
    expect(result.claimTxHash).toBe('0xc1a1m');
    expect(result.ranFreshBurn).toBe(false);
  });
});

describe('returnToPool({ resume: true }) — the stale-balance heuristic is skipped', () => {
  it('a cursor whose wallet reads back the FULL frozen amount still resumes — no balance read, no clear', async () => {
    // Without the skip this is the heuristic's clear-and-re-burn case: balance == frozen,
    // and the default eth_* stubs answer "no receipt, no tx" (true absence) so S1's
    // chain-verify would clear the cursor and hand the run to the fresh path.
    seedCursor(burnedCursor());
    readReturnableBalance.mockResolvedValue(FRESH_AMOUNT);
    const onStaleCursorCleared = vi.fn();

    const result = await run({ resume: true, onStaleCursorCleared });

    expect(readReturnableBalance).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(onStaleCursorCleared).not.toHaveBeenCalled();
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith(CURSOR_BURN_TX, expect.anything());
    expect(result.amountReturned).toBe(FRESH_AMOUNT);
    expect(result.ranFreshBurn).toBe(false);
  });

  it('[mutation guard] the SAME state without `resume` runs the heuristic and re-burns fresh', async () => {
    seedCursor(burnedCursor());
    readReturnableBalance.mockResolvedValue(FRESH_AMOUNT);
    const onStaleCursorCleared = vi.fn();

    const result = await run({ onStaleCursorCleared });

    expect(readReturnableBalance).toHaveBeenCalledTimes(1);
    expect(onStaleCursorCleared).toHaveBeenCalledTimes(1);
    expect(prepareFreshReturn).toHaveBeenCalledTimes(1);
    expect(result.ranFreshBurn).toBe(true);
  });
});

describe('returnToPool({ resume: true }) — convergence is unchanged', () => {
  it('a CONSUMED CCTP nonce reports alreadyClaimed and retires both records — no burn', async () => {
    seedCursor(burnedCursor());
    seedPending();
    callContract.mockImplementation(async (request?: { entrypoint?: string }) =>
      request?.entrypoint === 'is_nonce_used' ? ['0x1'] : ['0', '0'],
    );

    const result = await run({ resume: true });

    expect(result).toMatchObject({ alreadyClaimed: true, amountReturned: 0n, claimTxHash: '' });
    expect(readCursor()).toBeUndefined();
    expect(readPending()).toBeUndefined();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(buildAndProveClaim).not.toHaveBeenCalled();
  });

  it('a TRANSIENT attestation failure rejects and PRESERVES the cursor', async () => {
    seedCursor(burnedCursor());
    waitForAttestation.mockRejectedValue(new Error('waitForAttestation: timed out'));

    await expect(run({ resume: true })).rejects.toThrow(/timed out/i);

    expect(readCursor()).toMatchObject({ burnTx: CURSOR_BURN_TX });
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(submitProvenClaim).not.toHaveBeenCalled();
  });

  it('a cursor for a DIFFERENT account is refused by the cross-account guard, not reported as resumable', async () => {
    seedCursor(burnedCursor({ accountIndex: ACCOUNT_INDEX + 5, commitment: '999' }));

    const err = await run({ resume: true }).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/already in progress/i);
    expect(err).not.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(readCursor()!.accountIndex).toBe(ACCOUNT_INDEX + 5);
    expect(prepareFreshReturn).not.toHaveBeenCalled();
  });
});
