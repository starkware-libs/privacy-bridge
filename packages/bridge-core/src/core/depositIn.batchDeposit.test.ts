// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// EIP-5792 single-signature deposit: fundFromMetaMask's fresh path should batch the
// ERC-20 approve + CCTP depositForBurn into ONE wallet_sendCalls when the wallet
// reports atomic support, and fall back to the two-transaction path otherwise. Both
// paths must thread the SAME burn tx hash downstream (attestation/mint).
//
// Batch-status resilience (the reported "This bundle id is unknown / has not been
// submitted" failure): a wallet can transiently answer wallet_getCallsStatus with
// UnknownBundleIdError (5730) right after sendCalls returns, while its background
// worker is still cold — a page reload then fixed it. fundFromMetaMask polls the
// status itself (waitForBatchStatus), tolerating an early 5730 up to the budget, and
// only when the wallet NEVER acknowledges the bundle does it fall back to two txs —
// gated on an on-chain balance check so a burn that actually landed is never re-burned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface WriteArg {
  functionName: string;
  args: unknown[];
  address: string;
}

const {
  writeContract,
  waitForTransactionReceipt,
  readContract,
  getBalance,
  getGasPrice,
  estimateFeesPerGas,
  estimateContractGas,
  getLogs,
  getBlockNumber,
  custom,
  http,
  defineChain,
  encodeFunctionData,
  getCapabilities,
  sendCalls,
  getCallsStatus,
  BaseError,
  UnknownBundleIdError,
} = vi.hoisted(() => {
  // Minimal stand-ins for viem's error classes so `error instanceof UnknownBundleIdError`
  // (and the static `.code`) behave as the production isUnknownBundleIdError check expects.
  class BaseErrorMock extends Error {
    walk(fn?: (error: unknown) => boolean): unknown {
      return fn ? (fn(this) ? this : null) : this;
    }
  }
  class UnknownBundleIdErrorMock extends BaseErrorMock {
    static code = 5730 as const;
    code = 5730;
    constructor() {
      super('This bundle id is unknown / has not been submitted');
      this.name = 'UnknownBundleIdError';
    }
  }
  return {
    writeContract: vi.fn(async (call: WriteArg) =>
      (call.functionName === 'approve' ? '0xapprovetx' : '0xburntx') as `0x${string}`,
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
    readContract: vi.fn(async (): Promise<bigint> => 1_000_000_000n),
    getBalance: vi.fn(async (): Promise<bigint> => 10n ** 18n),
    getGasPrice: vi.fn(async (): Promise<bigint> => 30_000_000_000n),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })),
    estimateContractGas: vi.fn(async (): Promise<bigint> => 50_000n),
    // publicClient.getLogs / getBlockNumber used by waitForBatchStatus's on-chain
    // burn-event scan. Default: no matching log (existing tests untouched); the
    // block-number snapshot returns a small placeholder.
    getLogs: vi.fn(async () => [] as unknown[]),
    getBlockNumber: vi.fn(async (): Promise<bigint> => 100n),
    custom: vi.fn((p: unknown) => ({ _custom: p })),
    http: vi.fn((url?: string) => ({ _http: url })),
    defineChain: vi.fn((c: { id: number }) => c),
    encodeFunctionData: vi.fn(
      (a: { functionName: string }) => `0x${a.functionName}` as `0x${string}`,
    ),
    // EIP-5792 actions (viem/actions). Configured per test.
    getCapabilities: vi.fn(async () => ({ atomic: { status: 'unsupported' as const } })),
    sendCalls: vi.fn(async () => ({ id: '0xbatchid' })),
    // wallet_getCallsStatus, polled by waitForBatchStatus. Default: settled successfully
    // on the first poll (one atomic receipt).
    getCallsStatus: vi.fn(async () => ({
      status: 'success' as const,
      statusCode: 200,
      receipts: [{ transactionHash: '0xbatchburn' as `0x${string}`, status: 'success' as const }],
    })),
    BaseError: BaseErrorMock,
    UnknownBundleIdError: UnknownBundleIdErrorMock,
  };
});

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({ writeContract })),
  createPublicClient: vi.fn(() => ({
    waitForTransactionReceipt,
    readContract,
    getBalance,
    getGasPrice,
    estimateFeesPerGas,
    estimateContractGas,
    getLogs,
    getBlockNumber,
  })),
  custom,
  http,
  defineChain,
  encodeFunctionData,
  BaseError,
  UnknownBundleIdError,
}));

vi.mock('viem/actions', () => ({ getCapabilities, sendCalls, getCallsStatus }));

// --- collaborators (mirror depositIn.bughunt scaffold so the flow completes past burn)
const { waitForAttestation, managerExecute, switchChain, callContract } = vi.hoisted(() => ({
  waitForAttestation: vi.fn(async () => ({
    message: '0x' as `0x${string}`,
    attestation: '0x' as `0x${string}`,
  })),
  managerExecute: vi.fn(async () => ({ transaction_hash: '0xsnmint' })),
  switchChain: vi.fn(async () => {}),
  callContract: vi.fn(async () => ['0', '0'] as string[]),
}));

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./proven-submit', () => ({ managerExecute }));
vi.mock('./snMint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snMint')>()),
  submitStarknetMint: vi.fn(async () => {}),
}));
vi.mock('./cctpFees', () => ({
  FAST_FINALITY_THRESHOLD: 1000,
  STANDARD_FINALITY_THRESHOLD: 2000,
  fetchForwardMaxFee: vi.fn(),
  assertAboveForwardFloor: vi.fn(),
}));
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
}));
vi.mock('../lib/ethereum', () => ({ switchChain }));

const ethProvider = {
  request: vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? '0x13882' : null,
  ),
};

import { fundFromMetaMask } from './depositIn.js';

const SN_RECIPIENT = '0x49abc';
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT = {
  evmAddress: EVM_ADDRESS,
  snRecipient: SN_RECIPIENT,
  provider: ethProvider,
  amountWei: 1_000_000n,
  maxFee: 1000n,
  fast: true,
} as const;

const SUCCESS_STATUS = {
  status: 'success' as const,
  statusCode: 200,
  receipts: [{ transactionHash: '0xbatchburn' as `0x${string}`, status: 'success' as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  callContract.mockResolvedValue(['0', '0']); // SN account unfunded → fresh burn path
  readContract.mockResolvedValue(1_000_000_000n);
  getBalance.mockResolvedValue(10n ** 18n);
  getGasPrice.mockResolvedValue(30_000_000_000n);
  estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  estimateContractGas.mockResolvedValue(50_000n);
  writeContract.mockImplementation(async (call: WriteArg) =>
    (call.functionName === 'approve' ? '0xapprovetx' : '0xburntx') as `0x${string}`,
  );
  getCallsStatus.mockResolvedValue(SUCCESS_STATUS);
  // Scan defaults: no on-chain burn visible (existing tests unaffected).
  getLogs.mockResolvedValue([]);
  getBlockNumber.mockResolvedValue(100n);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fundFromMetaMask — EIP-5792 single-signature deposit', () => {
  it('SUPPORTING wallet: batches approve+burn via sendCalls (one signature), no writeContract', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });

    const net = await fundFromMetaMask({ ...DEPOSIT });

    expect(sendCalls).toHaveBeenCalledTimes(1);
    const batchArg = sendCalls.mock.calls[0]?.[1] as {
      calls: { to: string; data: string }[];
      forceAtomic?: boolean;
    };
    expect(batchArg.forceAtomic).toBe(true);
    // Exactly two calls, in the required ORDER: approve BEFORE burn (a burn before the
    // allowance exists would revert). encodeFunctionData is mocked to `0x<functionName>`.
    expect(batchArg.calls.map((c) => c.data)).toEqual(['0xapprove', '0xdepositForBurn']);
    // No individual approve/burn transactions in the atomic path.
    expect(writeContract).not.toHaveBeenCalled();
    // The batch's burn tx hash is threaded to attestation/mint.
    expect(waitForAttestation).toHaveBeenCalledWith('0xbatchburn', expect.anything());
    expect(net).toBe(999_000n); // amountWei - maxFee
  });

  it('SUPPORTING but batched as SEPARATE txs: threads the LAST (burn) receipt, not the approve', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    // A wallet that returns one receipt per call (approve first, burn last).
    getCallsStatus.mockResolvedValue({
      status: 'success',
      statusCode: 200,
      receipts: [
        { transactionHash: '0xapprovehash', status: 'success' },
        { transactionHash: '0xburnhash', status: 'success' },
      ],
    });

    await fundFromMetaMask({ ...DEPOSIT });

    // Must use the LAST receipt (the burn), never the approve.
    expect(waitForAttestation).toHaveBeenCalledWith('0xburnhash', expect.anything());
    expect(waitForAttestation).not.toHaveBeenCalledWith('0xapprovehash', expect.anything());
  });

  it('NON-SUPPORTING wallet: falls back to two writeContract txs (approve then burn)', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'unsupported' } });

    const net = await fundFromMetaMask({ ...DEPOSIT });

    expect(sendCalls).not.toHaveBeenCalled();
    const fns = writeContract.mock.calls.map((c) => (c[0] as WriteArg).functionName);
    expect(fns).toEqual(['approve', 'depositForBurn']);
    expect(waitForAttestation).toHaveBeenCalledWith('0xburntx', expect.anything());
    expect(net).toBe(999_000n);
  });

  it('wallet without wallet_getCapabilities (probe throws): falls back to two txs', async () => {
    getCapabilities.mockRejectedValue(new Error('method wallet_getCapabilities not supported'));

    await fundFromMetaMask({ ...DEPOSIT });

    expect(sendCalls).not.toHaveBeenCalled();
    const fns = writeContract.mock.calls.map((c) => (c[0] as WriteArg).functionName);
    expect(fns).toEqual(['approve', 'depositForBurn']);
  });

  it('SUPPORTING but the batch fails: surfaces an error (no silent success)', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'ready' } });
    getCallsStatus.mockResolvedValue({ status: 'failure', statusCode: 500, receipts: [] });

    await expect(fundFromMetaMask({ ...DEPOSIT })).rejects.toThrow(/batch/i);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('fundFromMetaMask — batch-status (5730) resilience', () => {
  it('TRANSIENT unknown-bundle-id then success: completes via the batch (no reload needed)', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    // First status poll rejects with 5730 (wallet still cold), then it settles successfully —
    // exactly the sequence a manual page reload used to be needed for.
    getCallsStatus
      .mockRejectedValueOnce(new UnknownBundleIdError())
      .mockResolvedValue(SUCCESS_STATUS);

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT });
    await vi.runAllTimersAsync();
    const net = await promise;

    // Still a single batch — no re-signing, no two-tx fallback.
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(writeContract).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith('0xbatchburn', expect.anything());
    expect(net).toBe(999_000n);
  });

  it('PERSISTENT unknown-bundle-id: errors without re-burning (never re-burns once sendCalls was issued)', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    // The wallet accepted wallet_sendCalls (it returned a bundle id) but reports 5730 for the
    // whole budget. Since the batch may still be mining, a second approve+burn could double-burn
    // — no balance snapshot can prove otherwise (a pending burn is invisible; inbound USDC can
    // mask a real one). So we must NOT fall back to the two-tx path.
    getCallsStatus.mockRejectedValue(new UnknownBundleIdError());

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(sendCalls).toHaveBeenCalledTimes(1); // batch was attempted
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/could not be confirmed/i);
    // No second burn — a batch we can't confirm must never be doubled up on.
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('bundle ACKNOWLEDGED but never confirmed (pending to deadline): errors, does not re-burn', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    getCallsStatus.mockResolvedValue({ status: 'pending', statusCode: 100, receipts: [] });

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/could not be confirmed/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('non-5730 status error propagates (not swallowed as a retry)', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    getCallsStatus.mockRejectedValue(new Error('RPC connection reset'));

    await expect(fundFromMetaMask({ ...DEPOSIT })).rejects.toThrow(/connection reset/i);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('fundFromMetaMask — burn-event scan (chain-truth fallback for a wallet stuck on 5730)', () => {
  // snAddressToBytes32('0x49abc') left-pads to 32 bytes lowercase.
  const MINT_RECIPIENT_BYTES32 =
    '0x0000000000000000000000000000000000000000000000000000000000049abc' as const;
  // POLYGON_USDC_ADDRESS fixture (vitest.setup.ts) → source.usdc for the Amoy source.
  const SOURCE_USDC = '0x00000000000000000000000000000000000000a4' as const;
  // config.cctp.starknetDomain defaults to 25 when CCTP_STARKNET_DOMAIN is unset.
  const STARKNET_DOMAIN = 25;
  const buildBurnLog = (
    over: Partial<{
      amount: bigint;
      mintRecipient: `0x${string}`;
      destinationDomain: number;
      burnToken: `0x${string}`;
      transactionHash: `0x${string}`;
    }> = {},
  ) => ({
    address: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    args: {
      burnToken: over.burnToken ?? SOURCE_USDC,
      amount: over.amount ?? 1_000_000n,
      depositor: EVM_ADDRESS.toLowerCase(),
      mintRecipient: over.mintRecipient ?? MINT_RECIPIENT_BYTES32,
      destinationDomain: over.destinationDomain ?? STARKNET_DOMAIN,
      destinationTokenMessenger: `0x${'00'.repeat(32)}` as const,
      destinationCaller: `0x${'00'.repeat(32)}` as const,
      maxFee: 1000n,
      minFinalityThreshold: 1000,
      hookData: '0x' as const,
    },
    transactionHash: over.transactionHash ?? ('0xscanburn' as `0x${string}`),
    blockNumber: 101n,
    logIndex: 0,
  });

  it('wallet stuck on 5730 but burn is visible on chain: breaks the 180s wait via the on-chain scan', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    // MetaMask permanently returns "No matching bundle found" — the exact user-reported
    // failure the fix is for. Without the scan this would time out at 180s.
    getCallsStatus.mockRejectedValue(new UnknownBundleIdError());
    // Chain shows our own burn on the second poll iteration.
    getLogs.mockResolvedValueOnce([]).mockResolvedValue([buildBurnLog()]);

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT });
    await vi.runAllTimersAsync();
    const net = await promise;

    // Single batch — we did NOT fall through to the two-tx path.
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(writeContract).not.toHaveBeenCalled();
    // Attest is driven by the scan-discovered tx hash, not any receipt from the wallet.
    expect(waitForAttestation).toHaveBeenCalledWith('0xscanburn', expect.anything());
    expect(net).toBe(999_000n);
    // Block-number snapshot was taken BEFORE sendCalls (so a same-block burn is covered).
    expect(getBlockNumber).toHaveBeenCalled();
    const snapshotOrder = getBlockNumber.mock.invocationCallOrder[0];
    const sendCallsOrder = sendCalls.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(sendCallsOrder);
  });

  it('scan filter: non-matching logs (wrong amount / recipient / depositor) are NOT treated as our burn', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    getCallsStatus.mockRejectedValue(new UnknownBundleIdError());
    // Every poll returns burn logs that DON'T match this submission: wrong amount, wrong
    // recipient, and a stale-looking log from a different depositor. None should match.
    getLogs.mockResolvedValue([
      buildBurnLog({ amount: 999_999n, transactionHash: '0xwrongamount' }),
      buildBurnLog({
        mintRecipient: `0x${'00'.repeat(31)}ff` as `0x${string}`,
        transactionHash: '0xwrongrecipient',
      }),
      buildBurnLog({ destinationDomain: 99, transactionHash: '0xwrongdomain' }),
      buildBurnLog({
        burnToken: '0x00000000000000000000000000000000000000ff',
        transactionHash: '0xwrongtoken',
      }),
    ]);

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const result = await promise;

    // No spurious match → still hits the 180s timeout, same as pre-fix behavior.
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/could not be confirmed/i);
    // Critically: no re-burn was attempted from a wrong-log false positive.
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('getLogs throws on every iteration: scan hiccup does NOT abort the outer poll — getCallsStatus success still wins', async () => {
    getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    // Two 5730s, then a genuine batch success from the wallet. Meanwhile getLogs is broken.
    getCallsStatus
      .mockRejectedValueOnce(new UnknownBundleIdError())
      .mockRejectedValueOnce(new UnknownBundleIdError())
      .mockResolvedValue(SUCCESS_STATUS);
    getLogs.mockRejectedValue(new Error('RPC 429 rate-limited'));

    vi.useFakeTimers();
    const promise = fundFromMetaMask({ ...DEPOSIT });
    await vi.runAllTimersAsync();
    const net = await promise;

    // The scan RPC error was swallowed silently — no propagation, no re-burn.
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(writeContract).not.toHaveBeenCalled();
    // Downstream still uses the getCallsStatus receipt (not any scan artefact).
    expect(waitForAttestation).toHaveBeenCalledWith('0xbatchburn', expect.anything());
    expect(net).toBe(999_000n);
  });
});
