// A1 (bughunt): fundFromMetaMask's `assertAboveForwardFloor` guard is INSIDE the
// `if (maxFee === undefined && fast)` branch (depositIn.ts:626-648), so any caller
// passing an EXPLICIT `args.maxFee >= amountWei` bypasses the floor entirely and
// reaches line 654 with `netMintedWei = amountWei - maxFee` <= 0. The subsequent
// resume/no-op gate at line 719 tests `getSnDepositTokenBalance(...) >= netMintedWei`
// — for any non-negative bigint balance (incl. 0n) this is trivially true when
// netMintedWei is negative or zero, so the function short-circuits as "already
// funded" and RETURNS the non-positive netMintedWei to the caller. No burn, no
// mint, no error — a silently-broken value path.
//
// Sibling peekInflightDeposit already enforces the invariant with a
// `gross > fee ? gross - fee : gross` guard (line 305-308); the top-of-body
// derivation in depositIn just doesn't for explicit-maxFee calls.
//
// This is a red-only test intended to FAIL on current main.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- viem mock: no RPC. The bug short-circuits BEFORE any burn/approve, so all
// these get called only for the balance/gas gates.
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

// --- collaborators
const { waitForAttestation, managerExecute, switchChain, callContract } = vi.hoisted(() => ({
  waitForAttestation: vi.fn<
    (
      burnTx: string,
      opts: { sourceDomain?: number; onStatus?: (s: string) => void },
    ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
  >(async () => ({ message: '0x' as `0x${string}`, attestation: '0x' as `0x${string}` })),
  managerExecute: vi.fn<
    (provider: unknown, call: unknown) => Promise<{ transaction_hash: string }>
  >(async () => ({ transaction_hash: '0xsnmint' })),
  switchChain: vi.fn<
    (provider: unknown, chainId: number, addParams?: unknown) => Promise<void>
  >(async () => {}),
  // The `callContract` used by getSnDepositTokenBalance — returns a u256 [low, high].
  // 0n balance is the natural "unfunded" default.
  callContract: vi.fn<
    (req: { entrypoint: string; calldata: string[] }, blockId?: unknown) => Promise<string[]>
  >(async () => ['0', '0'] as string[]),
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

const ethProvider = {
  request: vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? '0x13882' : null,
  ),
};

vi.mock('../lib/ethereum', () => ({
  switchChain,
}));

import { fundFromMetaMask } from './depositIn.js';
import { assertAboveForwardFloor } from './cctpFees.js';

const mAssertAboveForwardFloor = vi.mocked(assertAboveForwardFloor);

const SN_RECIPIENT = '0x49abc';
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Default: SN account unfunded (balance = 0). Bug: 0n >= (negative bigint) is TRUE.
  callContract.mockResolvedValue(['0', '0']);
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
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('A1 bughunt — explicit maxFee >= amountWei bypasses assertAboveForwardFloor', () => {
  it('DOES NOT accept a non-positive net (either throws below-floor OR floor-guards the input)', async () => {
    // Explicit maxFee (20n) > amountWei (10n) → the FAST-branch floor guard at
    // depositIn.ts:626-648 is SKIPPED (maxFee !== undefined), so the function
    // reaches netMintedWei = amountWei - maxFee = -10n and short-circuits the
    // resume no-op (0n balance >= -10n).
    //
    // The invariant the caller relies on: the function EITHER throws with a
    // below-floor message OR never returns a non-positive net. Fails on main.
    let returned: bigint | undefined;
    let threw: unknown;
    try {
      returned = await fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: 10n,
        maxFee: 20n,
        fast: true,
      });
    } catch (err) {
      threw = err;
    }

    if (threw !== undefined) {
      // If it threw, the message must be below-floor / invariant-y (not a mock
      // artefact). Any actionable error covering the floor invariant is fine.
      const msg = threw instanceof Error ? threw.message : String(threw);
      expect(msg).toMatch(/floor|below|maxFee|amount/i);
      return;
    }
    // Otherwise, it MUST NOT have returned a non-positive net.
    expect(returned).toBeDefined();
    expect(returned! > 0n).toBe(true);
  });

  it('the floor guard runs even when maxFee is passed explicitly (assertAboveForwardFloor is called)', async () => {
    // The floor invariant is universal: the CCTP mint is `amount - maxFee`, so
    // `maxFee >= amount` is a below-floor input regardless of who computed the
    // fee. On current main assertAboveForwardFloor is inside `if (maxFee ===
    // undefined && fast)`, so an explicit fee skips it entirely.
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: 10n,
      maxFee: 20n,
      fast: true,
    }).catch(() => {
      // A below-floor throw is fine — either way, the guard must have RUN.
    });
    // Fails on current main (guard bypassed for explicit maxFee).
    expect(mAssertAboveForwardFloor).toHaveBeenCalled();
  });

  it('with maxFee === amountWei (net exactly 0), the function must NOT silently short-circuit as "already funded"', async () => {
    // Boundary: netMintedWei = 0. Any bigint balance is >= 0n, so the resume
    // no-op silently returns 0n without burning or minting — the caller sees
    // "success" with zero movement. Assert either a throw or a strictly-positive
    // net (nothing was actually deposited otherwise).
    let returned: bigint | undefined;
    let threw: unknown;
    try {
      returned = await fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: 10n,
        maxFee: 10n, // net exactly 0
        fast: true,
      });
    } catch (err) {
      threw = err;
    }
    if (threw !== undefined) return; // any throw is acceptable at the boundary.
    expect(returned).toBeDefined();
    // On main this returns 0n from the resume short-circuit — fails.
    expect(returned! > 0n).toBe(true);
  });
});
