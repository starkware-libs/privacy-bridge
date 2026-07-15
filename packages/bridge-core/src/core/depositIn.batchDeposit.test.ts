// EIP-5792 single-signature deposit: fundFromMetaMask's fresh path should batch the
// ERC-20 approve + CCTP depositForBurn into ONE wallet_sendCalls when the wallet
// reports atomic support, and fall back to the two-transaction path otherwise. Both
// paths must thread the SAME burn tx hash downstream (attestation/mint).

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
  custom,
  http,
  defineChain,
  encodeFunctionData,
  getCapabilities,
  sendCalls,
  waitForCallsStatus,
} = vi.hoisted(() => ({
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
  custom: vi.fn((p: unknown) => ({ _custom: p })),
  http: vi.fn((url?: string) => ({ _http: url })),
  defineChain: vi.fn((c: { id: number }) => c),
  encodeFunctionData: vi.fn((a: { functionName: string }) => `0x${a.functionName}` as `0x${string}`),
  // EIP-5792 actions (viem/actions). Configured per test.
  getCapabilities: vi.fn(async () => ({ atomic: { status: 'unsupported' as const } })),
  sendCalls: vi.fn(async () => ({ id: '0xbatchid' })),
  waitForCallsStatus: vi.fn(async () => ({
    status: 'success' as const,
    statusCode: 200,
    receipts: [{ transactionHash: '0xbatchburn' as `0x${string}`, status: 'success' as const }],
  })),
}));

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({ writeContract })),
  createPublicClient: vi.fn(() => ({
    waitForTransactionReceipt,
    readContract,
    getBalance,
    getGasPrice,
    estimateFeesPerGas,
    estimateContractGas,
  })),
  custom,
  http,
  defineChain,
  encodeFunctionData,
}));

vi.mock('viem/actions', () => ({ getCapabilities, sendCalls, waitForCallsStatus }));

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
  waitForCallsStatus.mockResolvedValue({
    status: 'success',
    statusCode: 200,
    receipts: [{ transactionHash: '0xbatchburn', status: 'success' }],
  });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
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
    waitForCallsStatus.mockResolvedValue({
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
    waitForCallsStatus.mockResolvedValue({ status: 'failure', statusCode: 500, receipts: [] });

    await expect(fundFromMetaMask({ ...DEPOSIT })).rejects.toThrow(/batch/i);
    expect(writeContract).not.toHaveBeenCalled();
  });
});
