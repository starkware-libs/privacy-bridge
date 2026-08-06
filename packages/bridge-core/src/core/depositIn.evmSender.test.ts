// Injectable EVM submission seam: when the caller supplies `evmSender`, fundFromMetaMask's
// FRESH path hands it the approve+burn calls instead of probing EIP-5792 / sending two txs.
// The sender resolves only once mined with the canonical tx hash, so the cursor/attest flow
// downstream is byte-identical to the batch path. The seam is fresh-path only — a resume
// never calls it.

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
    writeContract: vi.fn(
      async (call: WriteArg) =>
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
    getLogs: vi.fn(async () => [] as unknown[]),
    getBlockNumber: vi.fn(async (): Promise<bigint> => 100n),
    custom: vi.fn((p: unknown) => ({ _custom: p })),
    http: vi.fn((url?: string) => ({ _http: url })),
    defineChain: vi.fn((c: { id: number }) => c),
    encodeFunctionData: vi.fn(
      (a: { functionName: string }) => `0x${a.functionName}` as `0x${string}`,
    ),
    getCapabilities: vi.fn(async () => ({ atomic: { status: 'unsupported' as const } })),
    sendCalls: vi.fn(async () => ({ id: '0xbatchid' })),
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

import { isTransientError, markNonRetryable } from './errors.js';
import { adoptInflightDepositBurn, fundFromMetaMask } from './depositIn.js';
import type { EvmCall, EvmSender } from './depositIn.js';

const SN_RECIPIENT = '0x49abc';
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const AMOY_CHAIN_ID = 80002;
const SENDER_TX = '0x5e4de47a' as `0x${string}`;
const INFLIGHT_KEY = 'pmp.inflightDeposit';

const DEPOSIT = {
  evmAddress: EVM_ADDRESS,
  snRecipient: SN_RECIPIENT,
  provider: ethProvider,
  amountWei: 1_000_000n,
  maxFee: 1000n,
  fast: true,
} as const;

type SenderCtx = { chainId: number; account: `0x${string}`; onStatus?: (s: string) => void };

const makeSender = (
  impl: (
    calls: readonly EvmCall[],
    ctx: SenderCtx,
  ) => Promise<{
    txHash: `0x${string}`;
    success: boolean;
  }>,
): ReturnType<typeof vi.fn> & EvmSender => vi.fn(impl) as ReturnType<typeof vi.fn> & EvmSender;

const readCursor = (): Record<string, { burnTx?: string }> | null => {
  const raw = localStorage.getItem(INFLIGHT_KEY);
  return raw ? (JSON.parse(raw) as Record<string, { burnTx?: string }>) : null;
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
  getCapabilities.mockResolvedValue({ atomic: { status: 'unsupported' } });
  getLogs.mockResolvedValue([]);
  getBlockNumber.mockResolvedValue(100n);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fundFromMetaMask — injectable EVM sender', () => {
  it('receives the approve+burn calls and its tx hash drives the cursor + attestation', async () => {
    // Snapshot the cursor from INSIDE attestation: finishAttestAndMint clears it on success.
    let cursorAtAttest: Record<string, { burnTx?: string }> | null = null;
    waitForAttestation.mockImplementation(async () => {
      cursorAtAttest = readCursor();
      return { message: '0x' as `0x${string}`, attestation: '0x' as `0x${string}` };
    });
    const evmSender = makeSender(async () => ({ txHash: SENDER_TX, success: true }));

    const net = await fundFromMetaMask({ ...DEPOSIT, evmSender });

    expect(evmSender).toHaveBeenCalledTimes(1);
    const [calls, ctx] = evmSender.mock.calls[0] as [EvmCall[], SenderCtx];
    // encodeFunctionData is mocked to `0x<functionName>`; approve MUST precede the burn.
    expect(calls.map((c) => c.data)).toEqual(['0xapprove', '0xdepositForBurn']);
    expect(calls[0]?.to?.toLowerCase()).toBe('0x00000000000000000000000000000000000000a4');
    expect(calls[1]?.to?.toLowerCase()).toBe('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa');
    expect(ctx.chainId).toBe(AMOY_CHAIN_ID);
    expect(ctx.account).toBe(EVM_ADDRESS);

    // No wallet-level submission of our own.
    expect(sendCalls).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();

    expect(waitForAttestation).toHaveBeenCalledWith(SENDER_TX, expect.anything());
    expect(cursorAtAttest?.[EVM_ADDRESS.toLowerCase()]?.burnTx).toBe(SENDER_TX);
    expect(net).toBe(999_000n); // amountWei - maxFee
  });

  it('skips the native-gas preflight and never probes getCapabilities', async () => {
    getBalance.mockResolvedValue(0n); // a paymaster-funded account holds zero native token
    const evmSender = makeSender(async () => ({ txHash: SENDER_TX, success: true }));

    const net = await fundFromMetaMask({ ...DEPOSIT, evmSender });

    expect(net).toBe(999_000n);
    expect(evmSender).toHaveBeenCalledTimes(1);
    expect(getCapabilities).not.toHaveBeenCalled();
  });

  it('mined-but-reverted (success:false): throws naming the tx, writes no cursor, never attests', async () => {
    const evmSender = makeSender(async () => ({ txHash: SENDER_TX, success: false }));

    await expect(fundFromMetaMask({ ...DEPOSIT, evmSender })).rejects.toThrow(SENDER_TX);

    expect(readCursor()).toBeNull();
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('a result with no tx hash reports THAT, never "reverted (tx undefined)"', async () => {
    const evmSender = makeSender(async () => ({ txHash: undefined as never, success: false }));

    await expect(fundFromMetaMask({ ...DEPOSIT, evmSender })).rejects.toThrow(
      /no transaction hash/i,
    );
    expect(readCursor()).toBeNull();
  });

  it('a throwing sender propagates and writes no cursor', async () => {
    const evmSender = makeSender(async () => {
      throw new Error('UserOp bundler rejected');
    });

    await expect(fundFromMetaMask({ ...DEPOSIT, evmSender })).rejects.toThrow(
      /UserOp bundler rejected/,
    );

    expect(readCursor()).toBeNull();
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('an AMBIGUOUS sender failure is submitted ONCE and cannot be auto-retried', async () => {
    // A post-submit ambiguous failure ('fetch failed' — in the SDK's transient set) is
    // marked by the sender. moveIntoPool's per-step guard is
    // `isTransientError(err) && attempt < MAX_STEP_RETRIES`, so the marker is what stops
    // a retry from preparing a SECOND UserOp over the same funds.
    const ambiguous = markNonRetryable(new Error('fetch failed'));
    const evmSender = makeSender(async () => {
      throw ambiguous;
    });

    const err = await fundFromMetaMask({ ...DEPOSIT, evmSender }).catch((e: unknown) => e);

    expect(evmSender).toHaveBeenCalledTimes(1);
    expect(err).toBe(ambiguous);
    expect(isTransientError(err)).toBe(false);
    // Contrast: the same message UNMARKED is what the orchestrator would retry.
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(readCursor()).toBeNull();
  });

  it('is ignored on resume: an existing cursor finishes attest/mint without calling the sender', async () => {
    localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({
        [EVM_ADDRESS.toLowerCase()]: {
          burnTx: '0xb0b0b0',
          sourceDomain: 7,
          amountWei: '1000000',
          snRecipient: SN_RECIPIENT,
          evmChainId: AMOY_CHAIN_ID,
          maxFee: '1000',
        },
      }),
    );
    // The resume path decodes the attested message (CCTP nonce gate), so it needs a
    // full-length body rather than the fresh path's placeholder.
    waitForAttestation.mockResolvedValue({
      message: `0x${'00'.repeat(148)}` as `0x${string}`,
      attestation: '0x' as `0x${string}`,
    });
    const evmSender = makeSender(async () => ({ txHash: SENDER_TX, success: true }));

    await fundFromMetaMask({ ...DEPOSIT, evmSender, resumeOnly: true });

    expect(evmSender).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledWith('0xb0b0b0', expect.anything());
  });

  it('an ADOPTED maxFee-less cursor actually resumes (attest+mint), not just round-trips', async () => {
    waitForAttestation.mockResolvedValue({
      message: `0x${'00'.repeat(148)}` as `0x${string}`,
      attestation: '0x' as `0x${string}`,
    });
    // Exactly what the app writes after a gasless burn is confirmed out of band: no
    // maxFee, because the quote lived inside the SDK run that died.
    expect(
      adoptInflightDepositBurn(EVM_ADDRESS, {
        burnTx: '0xb0b0b0',
        sourceDomain: 7,
        amountWei: '1000000',
        snRecipient: SN_RECIPIENT,
        evmChainId: AMOY_CHAIN_ID,
      }),
    ).toBe(true);

    await expect(
      fundFromMetaMask({ ...DEPOSIT, resumeOnly: true }),
    ).resolves.toBeTypeOf('bigint');

    expect(waitForAttestation).toHaveBeenCalledWith('0xb0b0b0', expect.anything());
  });

  it('without evmSender the wallet paths are unchanged (capabilities probe + two txs)', async () => {
    await fundFromMetaMask({ ...DEPOSIT });

    expect(getCapabilities).toHaveBeenCalled();
    const fns = writeContract.mock.calls.map((c) => (c[0] as WriteArg).functionName);
    expect(fns).toEqual(['approve', 'depositForBurn']);
    expect(waitForAttestation).toHaveBeenCalledWith('0xburntx', expect.anything());
  });
});
