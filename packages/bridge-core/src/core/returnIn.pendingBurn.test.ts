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
// The fix records the submission at the moment the relayer accepts it, then asks the CHAIN
// what happened (our own DepositForBurn, matched on the commitment we put in hookData).
// These tests pin all four outcomes — landed / never-landed / undecidable / unreadable —
// and, just as importantly, that an UNRESOLVED submission BLOCKS a second burn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { waitForAttestation, callContract, getLogs, getBlockNumber } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(),
  callContract: vi.fn(async () => ['0x0'] as string[]),
  getLogs: vi.fn(async () => [] as unknown[]),
  getBlockNumber: vi.fn(async () => 1_000n),
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
vi.mock('./polygonClient', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonClient')>();
  return { ...mod, getPolygonPublicClient: vi.fn(() => ({ getLogs, getBlockNumber })) };
});
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import { isNonRetryable } from './errors';
import {
  returnBurnToPool,
  recoverPendingReturnBurn,
  INFLIGHT_RETURN_KEY,
  type ReturnBurnCall,
  type GaslessBatchSubmission,
} from './returnIn';
import {
  PENDING_RETURN_BURN_KEY,
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
  return {
    accountIndex: ACCOUNT_INDEX,
    depositWallet: DEPOSIT_WALLET,
    amount: AMOUNT.toString(),
    commitment: COMMITMENT.toString(),
    sourceDomain: config.polygon.domain,
    evmChainId: config.polygon.chainId,
    inboundAnonymizer: config.inboundAnonymizerAddress,
    submittedAtMs: Date.now(),
    deadlineMs: Date.now() + 600_000,
    transactionID: 'relayer-tx-1',
    ...overrides,
  };
}

function runReturn(submit: (calls: ReturnBurnCall[], hooks?: {
  onSubmitted?: (s: GaslessBatchSubmission) => void;
}) => Promise<string>) {
  return returnBurnToPool({
    accountIndex: ACCOUNT_INDEX,
    amount: AMOUNT,
    evmAddress: EVM_ADDRESS,
    commitment: COMMITMENT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch: submit,
  });
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
  callContract.mockResolvedValue(['0x0']);
  waitForAttestation.mockResolvedValue({ message: attestedMessage(), attestation: ATTESTATION });
});
afterEach(() => localStorage.clear());

describe('a submitted return burn whose outcome the client never observed', () => {
  it('RECOVERS the burn from chain when the submitter throws AFTER the relayer accepted it', async () => {
    // The exact incident: the relayer took the batch (so onSubmitted fires), the status
    // poll then gave up, and the batch mined anyway.
    getLogs.mockResolvedValue([burnLog()]);
    const submit = vi.fn(async (_calls, hooks) => {
      hooks?.onSubmitted?.({ transactionID: 'relayer-tx-1', deadlineMs: Date.now() + 600_000 });
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

  it('rethrows the ORIGINAL error and clears the record once the batch deadline has passed', async () => {
    // No matching burn and the batch can no longer execute ⇒ the funds never moved, so the
    // honest answer is the submitter's own error and a retry is safe.
    const original = new Error('relayer did not confirm an on-chain transaction');
    const submit = vi.fn(async (_calls, hooks) => {
      hooks?.onSubmitted?.({ transactionID: 'relayer-tx-1', deadlineMs: Date.now() - 600_000 });
      throw original;
    });

    await expect(runReturn(submit)).rejects.toThrow(original);
    expect(readPendingReturnBurn(EVM_ADDRESS)).toBeNull();
    expect(readCursor()).toBeUndefined();
  });

  it('reports an auto-recovering, NON-auto-retryable error while the outcome is undecidable', async () => {
    // Not on chain yet, deadline not passed: the batch may still mine. Nothing may
    // automatically re-submit, but the record must survive so a later attempt resolves it.
    const submit = vi.fn(async (_calls, hooks) => {
      hooks?.onSubmitted?.({ transactionID: 'relayer-tx-1', deadlineMs: Date.now() + 600_000 });
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
    const submit = vi.fn(async (_calls, hooks) => {
      hooks?.onSubmitted?.({ transactionID: 'relayer-tx-1', deadlineMs: Date.now() - 600_000 });
      throw new Error('relayer did not confirm an on-chain transaction');
    });

    await expect(runReturn(submit)).rejects.toThrow(/finish the return automatically/i);
    expect(readPendingReturnBurn(EVM_ADDRESS)).not.toBeNull();
  });

  it('leaves a PRE-submit throw exactly as it was (no record, original error)', async () => {
    // onSubmitted never fired ⇒ the relayer never took the batch ⇒ there is no burn to find.
    const original = new Error('builder credentials rejected');
    const submit = vi.fn(async () => {
      throw original;
    });

    await expect(runReturn(submit)).rejects.toThrow(original);
    expect(localStorage.getItem(PENDING_RETURN_BURN_KEY)).toBeNull();
  });
});

describe('an unresolved submission blocks a second burn', () => {
  it('REFUSES a fresh return while a submitted burn is still unconfirmed', async () => {
    // The deposit wallet often still reads funded here (the first burn has not mined), so
    // without this guard the fresh path would happily burn the same USDC twice.
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord());
    const submit = vi.fn(async () => BURN_TX);

    await expect(runReturn(submit)).rejects.toThrow(/already submitted from this device/i);
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

    await expect(runReturn(submit)).rejects.toThrow(/already submitted from this device/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('the happy path is unchanged', () => {
  it('burns once, writes the cursor, and leaves no pending record behind', async () => {
    const submit = vi.fn(async (_calls, hooks) => {
      hooks?.onSubmitted?.({ transactionID: 'relayer-tx-1', deadlineMs: Date.now() + 600_000 });
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

  it('still works with a submitter that ignores the onSubmitted hook (older consumers)', async () => {
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

  it('scans further back the longer ago the burn was submitted', async () => {
    // The window is derived from elapsed time, so recovery still works after the tab was
    // closed for hours — a fixed lookback would quietly stop finding old burns.
    getBlockNumber.mockResolvedValue(5_000_000n);
    writePendingReturnBurn(EVM_ADDRESS, pendingRecord({ submittedAtMs: Date.now() - 3_600_000 }));

    await recoverPendingReturnBurn(EVM_ADDRESS);

    const { fromBlock } = getLogs.mock.calls[0][0] as { fromBlock: bigint };
    // ~1h at 2s blocks ≈ 1800 blocks, plus the margin — and never past the head.
    expect(fromBlock).toBeLessThan(5_000_000n - 1_800n);
    expect(fromBlock).toBeGreaterThan(4_990_000n);
  });
});
