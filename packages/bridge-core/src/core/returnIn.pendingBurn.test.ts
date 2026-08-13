// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Regression tests for the STRANDED RETURN BURN: a gasless relayer batch the relayer
// ACCEPTED but whose outcome the client never observed.
//
// The incident this pins: the relayer's status poll gives up (its wait() polls ~200s while
// the signed batch stays valid for its full 10-minute deadline), the submitter throws, and
// historically returnBurnToPool threw with NOTHING persisted — the post-burn cursor is
// written only once a tx hash exists. The batch then mined, the USDC left the deposit
// wallet into CCTP, and because fold-only recovery is entirely cursor-driven there was no
// record that a burn had ever happened: a retry read an empty wallet ("nothing to return"),
// a reload found no cursor ("nothing to recover"), and the funds stayed burned-but-unclaimed.
//
// The fix asks the CHAIN what happened instead of guessing: on a submitter throw it scans
// for our own DepositForBurn, matched on the commitment we put in hookData. Everything the
// scan needs is already in returnBurnToPool's own arguments, so no transport change is
// involved and an unmodified submitter is fully covered. These tests pin all four outcomes
// — landed / never-landed / undecidable / unreadable — and, just as importantly, that an
// UNRESOLVED submission BLOCKS a second burn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { waitForAttestation, callContract, getLogs, getBlockNumber, getBlock, transports } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  callContract: vi.fn(async () => ['0x0'] as string[]),
  getLogs: vi.fn(async () => [] as unknown[]),
  getBlockNumber: vi.fn(async () => 1_000n),
  // Anchorless walks read block timestamps to decide when they've reached back past the
  // submit. Default: a RECENT block, so a walk cannot establish absence unless a test says so.
  getBlock: vi.fn(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) })),
  transports: [] as Array<string | undefined>,
}));

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({ getRpcProvider: vi.fn(() => ({ callContract })) }));
// The inline post-throw resolver polls between chain reads; a no-op sleep keeps the
// 12-attempt budget instant without changing how many times it actually reads.
vi.mock('./proving', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./proving')>();
  return { ...mod, sleep: vi.fn(async () => {}) };
});
// The burn/scan client is built per-chain from the source registry's rpcUrl. Intercept BOTH
// halves: `http` records the URL at the call site (the viem transport object doesn't expose
// it before instantiation), and `createPublicClient` returns the fake chain. `transports` is
// how the cross-chain test proves the scan queries the burn's OWN chain.
vi.mock('viem', async (importOriginal) => {
  const mod = await importOriginal<typeof import('viem')>();
  return {
    ...mod,
    http: vi.fn((url?: string) => {
      transports.push(url);
      return mod.http(url);
    }),
    createPublicClient: vi.fn(() => ({ getLogs, getBlockNumber, getBlock })),
  };
});
// A CONFIGURED environment: the getLogs pair set the way a real deployment sets it (a probed
// 10_000-block cap over a 120_000-block reach = 12 requests per walk). The unconfigured
// defaults are deliberately shallow — a ~100-block horizon — which would put every stranded
// burn these tests recover out of reach, so pin the pair rather than inherit the dev floor.
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      inboundAnonymizerAddress: '0x49abc',
      polygonGetLogsChunkBlocks: 10_000,
      polygonWalkReachBlocks: 120_000,
    },
  };
});

import { config } from './config';
import { isNonRetryable } from './errors';
import { hasAnyInflightTransfer } from './depositIn';
import {
  returnBurnToPool,
  recoverPendingReturnBurn,
  INFLIGHT_RETURN_KEY,
  type ReturnBurnCall,
} from './returnIn';
import {
  PENDING_RETURN_BURN_KEY,
  hasAnyPendingReturnBurn,
  readPendingReturnBurn,
  writePendingReturnBurn,
  type PendingReturnBurn,
} from './pendingReturnBurn';

const ACCOUNT_INDEX = 3;
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp
const COMMITMENT = 424242424242n;
const HOOK_DATA = `0x${COMMITMENT.toString(16).padStart(64, '0')}`;
const BURN_TX = '0xbeefcafe';
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const INBOUND_FIELD64 = config.inboundAnonymizerAddress
  .replace(/^0x/i, '')
  .toLowerCase()
  .padStart(64, '0');

// A minimal well-formed CCTP-v2 message so the resume path's nonce read has bytes.
function attestedMessage(): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) +
    u32(config.polygon.domain) +
    u32(config.cctp.starknetDomain) +
    '00'.repeat(32 * 3) +
    INBOUND_FIELD64 +
    u32(1000) +
    u32(1000);
  const body = u32(1) + '00'.repeat(32) + INBOUND_FIELD64 + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

// A DepositForBurn log shaped as viem decodes it — this is the on-chain proof the burn
// happened. `hookData` carries our commitment, which is what binds it to this identity.
function burnLog(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    transactionHash: BURN_TX,
    args: {
      burnToken: '0xUSDC',
      amount: AMOUNT,
      depositor: DEPOSIT_WALLET,
      mintRecipient: `0x${INBOUND_FIELD64}`,
      destinationDomain: config.cctp.starknetDomain,
      hookData: HOOK_DATA,
      ...overrides,
    },
  };
}

function pendingRecord(overrides: Partial<PendingReturnBurn> = {}): PendingReturnBurn {
  const base: PendingReturnBurn = {
    accountIndex: ACCOUNT_INDEX,
    depositWallet: DEPOSIT_WALLET,
    amount: AMOUNT.toString(),
    commitment: COMMITMENT.toString(),
    sourceDomain: config.polygon.domain,
    evmChainId: config.polygon.chainId,
    inboundAnonymizer: config.inboundAnonymizerAddress,
    submittedAtMs: Date.now(),
    // The normal case: the pre-submit head read landed, so the window is EXACT and a
    // no-match past the deadline is conclusive. Tests that need the fallback drop it.
    fromBlock: '900',
    deadlineMs: Date.now() + 600_000,
    ...overrides,
  };
  // A real record's deadline is always its own submit + the batch lifetime, so keep the two
  // consistent when a test moves only one of them.
  if (overrides.deadlineMs === undefined && overrides.submittedAtMs !== undefined) {
    base.deadlineMs = overrides.submittedAtMs + 600_000;
  }
  return base;
}

function runReturn(submit: (calls: ReturnBurnCall[]) => Promise<string>) {
  return returnBurnToPool({
    accountIndex: ACCOUNT_INDEX,
    amount: AMOUNT,
    evmAddress: EVM_ADDRESS,
    commitment: COMMITMENT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch: submit,
  });
}

// An anchorless record on a chain deep enough that the walk cannot reach genesis, with
// block timestamps too RECENT to prove it got back past the submit — so absence stays
// unestablished. This is the genuinely-inconclusive shape.
function seedInconclusiveAnchorless(overrides: Partial<PendingReturnBurn> = {}) {
  getBlockNumber.mockResolvedValue(50_000_000n);
  // Every block the walk can reach is far NEWER than the submit, so it never establishes
  // that it got back past it — and the chain is deep enough that it cannot hit genesis.
  getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  const record = pendingRecord({ submittedAtMs: Date.now() - 86_400_000, ...overrides });
  delete record.fromBlock;
  writePendingReturnBurn(EVM_ADDRESS, record);
  return record;
}

function readCursor() {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  return raw ? JSON.parse(raw)[EVM_ADDRESS.toLowerCase()] : undefined;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  getLogs.mockResolvedValue([]);
  getBlockNumber.mockResolvedValue(1_000n);
  getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  transports.length = 0;
  callContract.mockResolvedValue(['0x0']);
  waitForAttestation.mockResolvedValue({ message: attestedMessage(), attestation: ATTESTATION });
});
afterEach(() => localStorage.clear());

describe('a submitted return burn whose outcome the client never observed', () => {
  it('RECOVERS the burn from chain when the submitter throws AFTER the relayer accepted it', async () => {
    // The exact incident: the relayer took the batch, its status poll then gave up, and the
    // batch mined anyway.
    getLogs.mockResolvedValue([burnLog()]);
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    const result = await runReturn(submit);

    // Before the fix this threw and the burn was invisible forever. Now it finishes.
    expect(result.amount).toBe(AMOUNT);
    expect(waitForAttestation).toHaveBeenCalledWith(BURN_TX, expect.anything());
    // The discovered burn is promoted to a real resume cursor...
    expect(readCursor()).toMatchObject({ burnTx: BURN_TX, accountIndex: ACCOUNT_INDEX });
    // ...and the pending record is retired only once that cursor exists.
    expect(readPendingReturnBurn(EVM_ADDRESS)).toBeNull();
    // Critically: exactly ONE submission. Recovery must never re-burn.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('reports an auto-recovering, NON-auto-retryable error while the outcome is undecidable', async () => {
    // Not on chain yet, deadline not passed: the batch may still mine. Nothing may
    // automatically re-submit, but the record must survive so a later attempt resolves it.
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    const err = await runReturn(submit).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/finish the return automatically/i);
    expect(isNonRetryable(err)).toBe(true);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('treats an UNREADABLE chain as undecidable, never as proof the burn never landed', async () => {
    // An RPC outage is not evidence. Even past the deadline, a failed scan must not clear
    // the record — clearing it would invite a second burn on the strength of a 429.
    getLogs.mockRejectedValue(new Error('HTTP 429 rate limited'));
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    await expect(runReturn(submit)).rejects.toThrow(/finish the return automatically/i);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('ACCEPTED COST: a submit the relayer never took is also held until the deadline', async () => {
    // The transport reports "rejected before broadcast" and "accepted, then unobservable"
    // identically — as a throw — so a credentials failure is guarded like a real submission.
    // The funds are untouched and visible in the wallet; the wait is bounded and self-
    // clearing (see the deadline test below). Wrong in the safe direction, and pinned here
    // so the cost is visible rather than a surprise.
    const submit = vi.fn(async () => {
      throw new Error('builder credentials rejected');
    });

    await expect(runReturn(submit)).rejects.toThrow(/finish the return automatically/i);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });
});

describe('the guard releases itself once the batch can no longer run', () => {
  it('clears a past-deadline record with no matching burn, and lets the next return proceed', async () => {
    // Past the deadline the batch is dead, so a clean scan PROVES the funds never moved.
    // This is what turns "never retry" into a bounded wait.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ deadlineMs: Date.now() - 600_000 }));

    const { resumable, stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);
    expect(resumable).toBeNull();
    expect(stillPending).toBe(false);
    expect(localStorage.getItem(PENDING_RETURN_BURN_KEY)).toBe('{}');

    // ...and a fresh return is now unblocked.
    const submit = vi.fn(async () => BURN_TX);
    await expect(runReturn(submit)).resolves.toMatchObject({ amount: AMOUNT });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear a past-deadline record when the scan itself failed', async () => {
    // Same deadline, but the chain is unreadable — so we learned nothing, and the record
    // must survive as the only handle on a burn that may have landed. (The BLOCKING role
    // expires with the deadline regardless; only the record's recovery role is at stake
    // here. Asserting a refusal too would just re-encode the scan-gated guard that
    // permanently bricked returns.)
    getLogs.mockRejectedValue(new Error('HTTP 429 rate limited'));
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ deadlineMs: Date.now() - 600_000 }));

    const { stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(stillPending).toBe(true);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('DOES block on an unreadable scan while the batch can still run', async () => {
    // The refusal that matters: inside the executable window an unreadable chain is not
    // permission to burn again.
    getLogs.mockRejectedValue(new Error('HTTP 429 rate limited'));
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ deadlineMs: Date.now() + 600_000 }));

    const submit = vi.fn(async () => BURN_TX);
    await expect(runReturn(submit)).rejects.toThrow(/submitted from this device/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('an unresolved submission blocks a second burn', () => {
  it('REFUSES a fresh return while a submitted burn is still unconfirmed', async () => {
    // The deposit wallet often still reads funded here (the first burn has not mined), so
    // without this guard the fresh path would happily burn the same USDC twice.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).rejects.toThrow(/submitted from this device/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it('RESUMES from attest — never re-burns — once the earlier burn is found on chain', async () => {
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog()]);
    const submit = vi.fn(async () => '0xshouldNotBeCalled');

    const result = await runReturn(submit);

    expect(submit).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith(BURN_TX, expect.anything());
    expect(result.amount).toBe(AMOUNT);
    expect(readCursor()).toMatchObject({ burnTx: BURN_TX });
  });

  it('does not match another burn from the same wallet that carries a different commitment', async () => {
    // The RPC filter only narrows to (TokenMessenger, depositor); the commitment in hookData
    // is what actually identifies OUR burn.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog({ hookData: `0x${'11'.repeat(32)}` })]);
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).rejects.toThrow(/submitted from this device/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('the happy path is unchanged', () => {
  it('burns once, writes the cursor, and leaves no pending record behind', async () => {
    const submit = vi.fn(async () => {
      return BURN_TX;
    });

    const result = await runReturn(submit);

    expect(result.amount).toBe(AMOUNT);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(readCursor()).toMatchObject({ burnTx: BURN_TX });
    expect(readPendingReturnBurn(EVM_ADDRESS)).toBeNull();
    // No scan needed when the submitter reported a hash.
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('needs no cooperation from the submitter (an unmodified transport works)', async () => {
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).resolves.toMatchObject({ amount: AMOUNT });
    expect(readCursor()).toMatchObject({ burnTx: BURN_TX });
  });
});

describe('recoverPendingReturnBurn (the sweep entry point)', () => {
  it('promotes a landed burn to a resumable cursor', async () => {
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog()]);

    const { resumable, stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toMatchObject({ burnTx: BURN_TX, accountIndex: ACCOUNT_INDEX });
    expect(stillPending).toBe(false);
    expect(readCursor()).toMatchObject({ burnTx: BURN_TX });
  });

  it('keeps an undecided record pending without inventing a cursor', async () => {
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());

    const { resumable, stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toBeNull();
    expect(stillPending).toBe(true);
    expect(readCursor()).toBeUndefined();
  });

  it('is a no-op when nothing is pending', async () => {
    await expect(recoverPendingReturnBurn(EVM_ADDRESS)).resolves.toEqual({
      resumable: null,
      stillPending: false,
    });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('keeps a record whose numeric fields are 0 (validated by SHAPE, not truthiness)', async () => {
    // accountIndex 0 is the FIRST bid — the most ordinary record there is. A store that
    // validated truthiness would drop it and strand exactly the users it should protect.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ accountIndex: 0, submittedAtMs: 0 }));
    expect(readPendingReturnBurn(EVM_ADDRESS)).toMatchObject({ accountIndex: 0, submittedAtMs: 0 });
  });

  it('keeps the scan window BOUNDED however old the record is', async () => {
    // The burn can only run between the submit and the deadline, so the window is that
    // span — not "everything since the submit". A week-old record must still be one
    // reasonably-sized getLogs call, or it exceeds the provider's range cap and fails as
    // 'unknown' forever, which would strand the funds it is meant to recover.
    getBlockNumber.mockResolvedValue(50_000_000n);
    writePendingReturnBurn(
      EVM_ADDRESS,
      pendingRecord({ submittedAtMs: Date.now() - 7 * 86_400_000, fromBlock: '41_000_000'.replace(/_/g, '') }),
    );

    await recoverPendingReturnBurn(EVM_ADDRESS);

    // The window is walked in provider-cap-sized chunks, so bound the UNION of them: first
    // chunk's start to last chunk's end is the span that has to stay reasonable.
    const calls = getLogs.mock.calls.map((c) => c[0] as { fromBlock: bigint; toBlock: bigint });
    const fromBlock = calls[0].fromBlock;
    const toBlock = calls[calls.length - 1].toBlock;
    // Starts just BELOW the anchor: the pre-submit head read races the submit, so the margin
    // absorbs an answer that arrived after the burn's own block.
    expect(fromBlock).toBeLessThan(41_000_000n);
    expect(fromBlock).toBeGreaterThan(40_990_000n);
    // ~12 min at the fastest assumed block time, plus margin — thousands, not millions.
    expect(toBlock - fromBlock).toBeLessThan(10_000n);
  });

  it('never reports never-landed until the walk reaches back past the submit', async () => {
    // Absence has to be EARNED. While the walk has not yet covered where the burn could be,
    // a clean scan past the deadline is 'unknown' — concluding otherwise would release the
    // double-burn guard on a guess.
    seedInconclusiveAnchorless({ deadlineMs: Date.now() - 600_000 });

    const { stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(stillPending).toBe(true);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('still PROVES a landed burn from an estimated window (a match needs no anchor)', async () => {
    // The commitment identifies the event, so a hit is conclusive either way — only the
    // negative result depends on the window being exact.
    const noAnchor = pendingRecord();
    delete noAnchor.fromBlock;
    writePendingReturnBurn(EVM_ADDRESS, noAnchor);
    getLogs.mockResolvedValue([burnLog()]);

    const { resumable } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toMatchObject({ burnTx: BURN_TX });
  });

  it('scans the chain the burn ran on, not always Polygon', async () => {
    // The record names its own chain; resolving that chain's TokenMessenger but querying
    // Polygon returns an empty log set, which past the deadline reads as "never happened".
    const other = Object.values(config.evmCctpSources).find(
      (s) => s.chainId !== config.polygon.chainId && s.rpcUrl !== config.polygon.rpcUrl,
    );
    if (!other) throw new Error('test config has no second EVM CCTP source to check against');
    writePendingReturnBurn(
      EVM_ADDRESS,
      pendingRecord({ evmChainId: other.chainId, sourceDomain: other.domain }),
    );

    await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(transports.at(-1)).toBe(other.rpcUrl);
    expect(transports.at(-1)).not.toBe(config.polygon.rpcUrl);
  });
});

describe('a storage write that fails must not discard proven evidence', () => {
  // Reject writes to ONE key while leaving the rest of localStorage working — the realistic
  // quota failure, and the only way to separate "the burn is unknown" from "we merely
  // couldn't write it down".
  function failWritesTo(key: string) {
    const real = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === key) throw new DOMException('QuotaExceededError');
      real.call(this, k, v);
    });
  }

  it('still resumes a PROVEN burn when the cursor write fails', async () => {
    // The burn is on chain and we are holding its hash. A failed cursor write is a
    // persistence problem, not an evidence problem — re-reading empty storage would drop
    // the hash and strand the run on the unresolved-submission guard, blocking the exact
    // recovery that just succeeded.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog()]);
    const spy = failWritesTo(INFLIGHT_RETURN_KEY);
    const submit = vi.fn(async () => '0xshouldNotBeCalled');

    const result = await runReturn(submit);

    expect(submit).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith(BURN_TX, expect.anything());
    expect(result.amount).toBe(AMOUNT);
    // The cursor genuinely did not persist — the resume came from the in-memory record.
    expect(readCursor()).toBeUndefined();
    spy.mockRestore();
  });

  it('tells the user to check the chain when the pending record could NOT be saved', async () => {
    // Without a stored record the next attempt has no guard and would take the fresh path
    // while this batch may still mine, so the usual "we saved this, just retry" copy would
    // be actively dangerous. The message has to say so.
    const spy = failWritesTo(PENDING_RETURN_BURN_KEY);
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    const err = await runReturn(submit).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/could not be|couldn't confirm/i);
    expect((err as Error).message).toMatch(/block explorer/i);
    expect((err as Error).message).not.toMatch(/we saved this submission/i);
    expect(isNonRetryable(err)).toBe(true);
    spy.mockRestore();
  });

  it('keeps the tracked copy when the record DID save', async () => {
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    const err = await runReturn(submit).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/we saved this submission/i);
    expect((err as Error).message).not.toMatch(/block explorer/i);
  });
});

describe('Bugbot round 3 — three ways a guard could be wrongly released', () => {
  it('names the DEPOSIT WALLET in the untracked error, not the connected wallet', async () => {
    // The connected wallet only keys the record; the deposit wallet is what burns. Sending a
    // user to the wrong address means they see nothing, conclude it never happened, and
    // retry into the double-burn this message exists to prevent.
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === PENDING_RETURN_BURN_KEY) throw new DOMException('QuotaExceededError');
      real.call(this, k, v);
    });
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    const err = await runReturn(submit).catch((e: unknown) => e);

    expect((err as Error).message).toContain(DEPOSIT_WALLET);
    expect((err as Error).message).not.toContain(EVM_ADDRESS);
    spy.mockRestore();
  });

  it('does NOT call a tip-only scan exact when the anchor sits above the head', async () => {
    // A reorg or a stale node can put the anchor past the head. Clamping keeps the range
    // from inverting, but the scan then covers only the tip — not the submit window — so a
    // clean no-match proves nothing and must not resolve never-landed.
    getBlockNumber.mockResolvedValue(500n);
    writePendingReturnBurn(
      EVM_ADDRESS,
      pendingRecord({ fromBlock: '9000', deadlineMs: Date.now() - 600_000 }),
    );

    const { stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(stillPending).toBe(true);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('retires the pending record on a terminal attestation failure', async () => {
    // The burn landed but its message will never mint. Both records describe that same dead
    // burn — leaving the pending one behind would re-promote it forever and swallow the
    // user's next return as "already claimed", and the deadline can never clear it because
    // the burn genuinely did land.
    //
    // The cursor write is failed on purpose: a successful promotion already retires the
    // pending record on its own, so only this path actually exercises the terminal clear.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog()]);
    waitForAttestation.mockRejectedValue(new Error('attestation failed'));
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === INFLIGHT_RETURN_KEY) throw new DOMException('QuotaExceededError');
      real.call(this, k, v);
    });
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).rejects.toThrow(/attestation failed/i);

    spy.mockRestore();
    expect(readPendingReturnBurn(EVM_ADDRESS)).toBeNull();
    expect(readCursor()).toBeUndefined();
  });
});

describe('Bugbot round 4 — the recovery must not undo itself', () => {
  it('keeps the pending record until the return ENDS, not until the cursor is written', async () => {
    // A cursor can still be dropped downstream (the stale-cursor re-validation nulls one
    // whose wallet looks full — which a lagging RPC reports right after a burn mines).
    // Retiring the only other handle at write time would make that drop unrecoverable.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    getLogs.mockResolvedValue([burnLog()]);

    const { resumable, stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toMatchObject({ burnTx: BURN_TX });
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
    // ...but a resolved burn is NOT an open question — the sweep must not read it as one.
    expect(stillPending).toBe(false);
  });

  it('is visible to the network-switch guard (its key is outside pmp.inflight*)', async () => {
    // A switch disconnects and wipes pmp.* state. For an unresolved submission that means
    // losing the only handle on a burn that may still be mining, so the guard has to see
    // this store — nothing in the pmp.inflight* naming can infer it.
    expect(hasAnyPendingReturnBurn()).toBe(false);
    expect(hasAnyInflightTransfer()).toBe(false);

    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());

    expect(hasAnyPendingReturnBurn()).toBe(true);
    // The composed guard is what the switch actually consults — asserting only the helper
    // would pass even with the store left unwired, which is exactly how this shipped.
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  it('scans BELOW the anchor so a late head read cannot skip past the burn', async () => {
    // The anchor read races the submit: a slow answer reports a height already past the
    // burn's block. Starting exactly at the anchor would scan above it, find nothing, and
    // past the deadline call a landed burn never-landed.
    getBlockNumber.mockResolvedValue(5_000n);
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ fromBlock: '4000' }));

    await recoverPendingReturnBurn(EVM_ADDRESS);

    const { fromBlock } = getLogs.mock.calls[0][0] as { fromBlock: bigint };
    expect(fromBlock).toBeLessThan(4_000n);
  });
});

describe('the anchor read is bounded, silent, and never breaks the burn', () => {
  it('survives a REJECTING head read on the happy path without an unhandled rejection', async () => {
    // The anchor is read un-awaited before the submit, so on the happy path nothing ever
    // looks at it — a rejection there must stay silent rather than surfacing as a console
    // error. (This held for the previous Promise.race form too: a race attaches handlers to
    // every racer, so a loser's rejection was already handled. Kept as a standing guard on
    // the property, since it is easy to lose when this read is next touched.)
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Reject on a LATER macrotask, so any timeout branch settles first — the exact
      // ordering that leaves the loser unhandled.
      getBlockNumber.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('rpc down')), 0);
          }),
      );
      const submit = vi.fn(async () => BURN_TX);

      await expect(runReturn(submit)).resolves.toMatchObject({ amount: AMOUNT });

      // Let the rejection land and the unhandled-rejection check run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('records the anchor when the head read succeeds', async () => {
    // The positive half: a healthy read is what makes a later no-match conclusive, so the
    // burn path must actually persist it — and it must do so DETERMINISTICALLY, not by
    // winning a microtask race against the mocked `sleep` this file installs.
    getBlockNumber.mockResolvedValue(4_321n);
    const submit = vi.fn(async () => {
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    await runReturn(submit).catch(() => undefined);

    expect(readPendingReturnBurn(EVM_ADDRESS)?.fromBlock).toBe('4321');
  });
});

describe('Bugbot round 6 — the guard is bounded by the DEADLINE, not by the scan', () => {
  it('releases an anchorless record once the batch can no longer run', async () => {
    // THE BRICK. Without an anchor the window is estimated, so a clean no-match can only
    // ever be 'unknown' — never 'never-landed'. Gating the guard on that verdict meant a
    // submit the relayer REFUSED blocked every future return for this wallet, permanently,
    // despite being documented as a bounded wait.
    seedInconclusiveAnchorless({ deadlineMs: Date.now() - 3_600_000 });

    // Still unresolvable — the walk cannot prove absence here, and must not pretend to.
    const { stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);
    expect(stillPending).toBe(true);

    // ...yet a fresh return proceeds, because the old batch is past its deadline and can no
    // longer spend the wallet. Whatever the scan concluded, a second burn cannot collide.
    const submit = vi.fn(async () => BURN_TX);
    await expect(runReturn(submit)).resolves.toMatchObject({ amount: AMOUNT });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('still blocks while the batch CAN run', async () => {
    // The guard's actual job, unchanged: inside the executable window a second burn could
    // collide with the first, so it is refused.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ deadlineMs: Date.now() + 600_000 }));
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).rejects.toThrow(/submitted from this device/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the record past the deadline so a landed burn is still recoverable', async () => {
    // Expiring the BLOCKING role must not discard the record: it is the only handle on a
    // burn that may have landed, and losing it is the strand this PR exists to remove.
    seedInconclusiveAnchorless({ deadlineMs: Date.now() - 3_600_000 });

    await recoverPendingReturnBurn(EVM_ADDRESS);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();

    // And it is still promotable the moment the chain does show the burn.
    getLogs.mockResolvedValue([burnLog()]);
    const { resumable } = await recoverPendingReturnBurn(EVM_ADDRESS);
    expect(resumable).toMatchObject({ burnTx: BURN_TX });
  });
});

describe('Bugbot round 7 — an anchorless walk must reach an OLD burn', () => {
  it('FINDS a burn that sits below the first chunk from the head', async () => {
    // THE GAP. The anchorless window used to be pinned to the head, capped at one lookback,
    // so a delayed retry searched recent blocks instead of the submit→deadline span and a
    // landed burn was never matched — stranding funds an anchored scan would have found.
    getBlockNumber.mockResolvedValue(50_000_000n);
    getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
    // The burn is ~35k blocks down: past the first chunk, well within the walk's budget.
    getLogs.mockImplementation(async (args: { fromBlock: bigint; toBlock: bigint }) =>
      args.fromBlock <= 49_965_000n && args.toBlock >= 49_965_000n ? [burnLog()] : [],
    );
    const record = pendingRecord({ submittedAtMs: Date.now() - 86_400_000 });
    delete record.fromBlock;
    writePendingReturnBurn(EVM_ADDRESS, record);

    const { resumable } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toMatchObject({ burnTx: BURN_TX });
    // Several chunks were walked to get there — not one window at the tip.
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
  });

  it('CAN conclude never-landed once the walk passes the submit', async () => {
    // The other half of earning a negative: reaching a block older than the submit means
    // every block the burn could occupy has been searched, so absence is real and the record
    // clears — an anchorless record is no longer permanently inconclusive.
    getBlockNumber.mockResolvedValue(50_000_000n);
    getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor((Date.now() - 172_800_000) / 1000)) });
    const record = pendingRecord({ submittedAtMs: Date.now() - 86_400_000 });
    delete record.fromBlock;
    writePendingReturnBurn(EVM_ADDRESS, record);

    const { resumable, stillPending } = await recoverPendingReturnBurn(EVM_ADDRESS);

    expect(resumable).toBeNull();
    expect(stillPending).toBe(false);
    expect(readPendingReturnBurn(EVM_ADDRESS)).toBeNull();
  });

  it('stops at the configured reach rather than scanning forever', async () => {
    // The walk is bounded: an unreachable submit must cost a fixed number of reads and end
    // 'unknown', not grind through the whole chain. That count is reach ÷ chunk — the pair of
    // config knobs — which at the safe-anywhere defaults is 120_000 / 10.
    seedInconclusiveAnchorless();

    await recoverPendingReturnBurn(EVM_ADDRESS);

    // Ceiling, matching walkChunkBudget: a pair that does not divide exactly still costs a
    // whole final request, and a fractional expectation here would assert nothing.
    expect(getLogs.mock.calls.length).toBe(
      Math.ceil(config.polygonWalkReachBlocks / config.polygonGetLogsChunkBlocks),
    );
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });
});
