// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// C3 — proves the "already-funded" no-op gate (gate 1) in fundFromMetaMask returns
// the WRONG net on an UPWARD CCTP fee drift.
//
// Mechanism (depositIn.ts):
//   - `netMintedWei = amountWei − maxFee` (line ~654) is computed from a FRESHLY
//     REQUOTED fetchForwardMaxFee (line ~646), NOT the fee the original burn used.
//   - Gate 1 (line ~719) fires when `balance >= netMintedWei` and RETURNS
//     `netMintedWei` (line ~722). It runs BEFORE the resume cursor is read
//     (line ~740), so the #229 persisted-fee fix (only in the resume branch,
//     lines ~749-758) is bypassed.
//
// CCTP mints exactly `amount − originalFee`. So the SN account holds
// `amount − originalFee`. When the fresh quote's fee is HIGHER than the original
// (upward drift), gate 1's threshold `amount − freshFee` is LOWER than the balance,
// the gate fires, and it returns `amount − freshFee` — LESS than what actually
// landed (`amount − originalFee`). The documented contract (comments ~597-612) says
// the returned NET must equal what actually landed → the caller deposits less than
// landed and strands dust.
//
// This is a focused red test; the mock harness mirrors depositIn.test.ts.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
} = vi.hoisted(() => ({
  writeContract: vi.fn(
    async (call: WriteArg) =>
      (call.functionName === 'approve' ? '0xapprovetx' : '0xburntx') as `0x${string}`,
  ),
  waitForTransactionReceipt: vi.fn(async (): Promise<{ status: 'success' }> => ({
    status: 'success',
  })),
  readContract: vi.fn(async (): Promise<bigint> => 1_000_000_000_000n),
  getBalance: vi.fn(async (): Promise<bigint> => 10n ** 18n),
  getGasPrice: vi.fn(async (): Promise<bigint> => 30_000_000_000n),
  estimateFeesPerGas: vi.fn(
    async (): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> => ({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
  ),
  estimateContractGas: vi.fn(async (): Promise<bigint> => 50_000n),
  custom: vi.fn((p: unknown) => ({ _custom: p })),
  http: vi.fn((url?: string) => ({ _http: url })),
  defineChain: vi.fn((c: { id: number }) => c),
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
}));

type SnCall = { contractAddress: string; entrypoint: string; calldata: string[] };
const { waitForAttestation, managerExecute, switchChain, callContract } = vi.hoisted(() => ({
  waitForAttestation: vi.fn(async () => ({
    message: '0x' as `0x${string}`,
    attestation: '0x' as `0x${string}`,
  })),
  managerExecute: vi.fn(async () => ({ transaction_hash: '0xsnmint' })),
  switchChain: vi.fn(async () => {}),
  callContract: vi.fn<(req: SnCall, blockId?: unknown) => Promise<string[]>>(
    async () => ['0', '0'] as string[],
  ),
}));

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./proven-submit', () => ({ managerExecute }));
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

const chainIdHex = { value: '0x13882' }; // 80002 (Polygon Amoy)
const ethProvider = {
  request: vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? chainIdHex.value : null,
  ),
};

vi.mock('../lib/ethereum', () => ({ switchChain }));

import { EVM_CCTP_SOURCES } from './config';
import { fundFromMetaMask } from './depositIn';
import { fetchForwardMaxFee, assertAboveForwardFloor } from './cctpFees';

const mFetchForwardMaxFee = vi.mocked(fetchForwardMaxFee);
const mAssertAboveForwardFloor = vi.mocked(assertAboveForwardFloor);

const SN_RECIPIENT = '0x49abc';
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const AMOY = EVM_CCTP_SOURCES[80002];
const INFLIGHT_DEPOSIT_KEY = 'pmp.inflightDeposit';

const AMOUNT = 100_000000n; // 100 USDC @ 6dp (gross burned)
const ORIGINAL_FEE = 1_000000n; // the fee the ORIGINAL burn actually used
const LANDED = AMOUNT - ORIGINAL_FEE; // 99 USDC — what CCTP actually minted on SN
const FRESH_FEE = 3_000000n; // a HIGHER live requote (upward drift)

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  chainIdHex.value = '0x13882';
  // The SN account already holds the ACTUALLY-MINTED net = amount − originalFee.
  callContract.mockResolvedValue([LANDED.toString(), '0']);
  // A fresh Fast quote drifts UPWARD to a higher fee than the original burn used.
  mFetchForwardMaxFee.mockResolvedValue({
    maxFee: FRESH_FEE,
    forwardFee: 0n,
    protocolFee: FRESH_FEE,
    finalityThreshold: 1000,
  });
  mAssertAboveForwardFloor.mockReturnValue(undefined);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('fundFromMetaMask — gate-1 already-funded no-op uses the FRESH fee (C3)', () => {
  it('returns the ACTUALLY-LANDED net (amount − originalFee), not amount − freshFee, on upward drift', async () => {
    // A cursor from the original burn records the fee that was ACTUALLY used (1 USDC).
    // Even so, gate 1 fires before this cursor is read and requotes the fee fresh.
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        [EVM_ADDRESS.toLowerCase()]: {
          burnTx: `0x${'ab'.repeat(32)}`,
          sourceDomain: AMOY.domain,
          amountWei: AMOUNT.toString(),
          snRecipient: SN_RECIPIENT,
          evmChainId: AMOY.chainId,
          maxFee: ORIGINAL_FEE.toString(),
        },
      }),
    );

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });

    // Gate 1 must be recognized as already-funded (never re-burns).
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );

    // CCTP minted exactly amount − originalFee = 99 USDC. The returned net MUST equal
    // what actually landed so the caller deposits exactly that.
    // CURRENT CODE returns amount − freshFee = 97 USDC (dust stranded) → RED.
    expect(net).toBe(LANDED);
  });
});
