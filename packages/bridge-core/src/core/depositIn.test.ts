// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Behavioural tests for the fund-from-MetaMask CCTP deposit-in leg
// (fundFromMetaMask). Exercises the REAL depositIn.ts against mocked viem (no EVM
// RPC), a mocked Iris attestation, and a mocked Starknet manager submit. The
// cross-chain leg itself is live-only (.claude/rules/verification.md); these pin
// the client behaviour: chain selection, approve+burn args, attestation source
// domain, and the receive_message manager submit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- viem mock: capture approve / depositForBurn writes without any RPC --------
interface WriteArg {
  functionName: string;
  args: unknown[];
  address: string;
  chain?: { id: number };
  // EIP-1559 fee overrides the leg now sets explicitly (gas-tip-below-minimum fix).
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
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
  burnStatus,
} = vi.hoisted(() => ({
  writeContract: vi.fn(
    async (call: WriteArg) =>
      (call.functionName === 'approve' ? '0xapprovetx' : '0xburntx') as `0x${string}`,
  ),
  waitForTransactionReceipt: vi.fn(
    async ({ hash }: { hash: string }): Promise<{ status: 'success' | 'reverted' }> => ({
      status: hash === '0xburntx' ? burnStatus.value : 'success',
    }),
  ),
  readContract: vi.fn(async (): Promise<bigint> => 1_000_000_000n),
  // Native (POL/ETH) gas pre-check (fresh path only). Defaults: a healthy native
  // balance + a typical testnet gas price so the gate passes; a test lowers
  // getBalance to exercise the shortfall.
  getBalance: vi.fn(async (): Promise<bigint> => 10n ** 18n), // 1 POL
  getGasPrice: vi.fn(async (): Promise<bigint> => 30_000_000_000n), // 30 gwei
  // EIP-1559 effective per-gas cap + precise approve gas estimate the robust
  // preflight consults (#192). Defaults: a typical 1559 fee + a realistic approve
  // cost, so the gate passes on the healthy-balance default.
  estimateFeesPerGas: vi.fn(
    async (): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> => ({
      maxFeePerGas: 30_000_000_000n, // 30 gwei
      maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    }),
  ),
  estimateContractGas: vi.fn(async (): Promise<bigint> => 50_000n),
  custom: vi.fn((p: unknown) => ({ _custom: p })),
  http: vi.fn((url?: string) => ({ _http: url })),
  defineChain: vi.fn((c: { id: number }) => c),
  burnStatus: { value: 'success' as 'success' | 'reverted' },
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
  encodeFunctionData: vi.fn((a: { functionName: string }) => `0x${a.functionName}` as `0x${string}`),
}));

// EIP-5792 actions: default to a wallet WITHOUT atomic-batch support, so these tests
// exercise the unchanged two-transaction (approve + burn) fallback. The single-sig
// batch path is covered in depositIn.batchDeposit.test.ts.
vi.mock('viem/actions', () => ({
  getCapabilities: vi.fn(async () => ({ atomic: { status: 'unsupported' as const } })),
  sendCalls: vi.fn(async () => ({ id: '0x0' })),
  getCallsStatus: vi.fn(async () => ({ status: 'success' as const, statusCode: 200, receipts: [] })),
}));

// Build a well-formed CCTP-v2 message (header + BurnMessageV2 body) that decodes
// to the given Starknet/destination domain + the FULL 32-byte mintRecipient
// field — so the deposit-in leg's A1 validation gate (assertCctpMessageMatches)
// passes. Layout mirrors polygonMint.ts: header 148 bytes, mintRecipient at body
// offset 36 (32-byte left-padded field; a Starknet felt fills the whole word).
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  // 32-byte mint recipient field as 64-hex (no 0x). For Starknet this is the
  // felt left-padded to 32 bytes.
  recipientField64: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) + // nonce + sender + recipient + destinationCaller
    u32(1000) + // minFinalityThreshold
    u32(1000); // finalityThresholdExecuted
  const body =
    u32(1) + // body version
    '00'.repeat(32) + // burnToken
    opts.recipientField64.toLowerCase() + // mintRecipient (full 32-byte field)
    '00'.repeat(32) + // amount
    '00'.repeat(32); // messageSender
  return `0x${header}${body}` as `0x${string}`;
}

// Bug1: a FULL BurnMessageV2 body (through feeExecuted + expirationBlock) so the minted
// amount decode (burn − feeExecuted) has real fields to read. The short buildCctpMessage
// above stops after messageSender (no fee field) → decodeCctpMintedAmount returns null →
// the maxFee-estimate fallback. This one carries a real `amount` and `feeExecuted`.
function buildFullCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
  amount: bigint;
  feeExecuted: bigint;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const u256 = (n: bigint) => n.toString(16).padStart(64, '0');
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 4) + // nonce + sender + recipient + destinationCaller
    u32(1000) + // minFinalityThreshold (Fast requested)
    u32(2000); // finalityThresholdExecuted (Standard executed — the live tier mismatch)
  const body =
    u32(1) + // body version
    '00'.repeat(32) + // burnToken
    opts.recipientField64.toLowerCase() + // mintRecipient (full 32-byte field)
    u256(opts.amount) + // amount (burned)
    '00'.repeat(32) + // messageSender
    '00'.repeat(32) + // maxFee (cap — irrelevant to the minted amount)
    u256(opts.feeExecuted) + // feeExecuted (what CCTP actually deducted)
    '00'.repeat(32); // expirationBlock
  return `0x${header}${body}` as `0x${string}`;
}

// --- collaborators -------------------------------------------------------------
type MintCall = { contractAddress: string; entrypoint: string; calldata: string[] };
const { waitForAttestation, managerExecute, switchChain, callContract, attestedMessage } =
  vi.hoisted(() => ({
    waitForAttestation:
      vi.fn<
        (
          burnTx: string,
          opts: { sourceDomain?: number; onStatus?: (s: string) => void },
        ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
      >(),
    managerExecute: vi.fn<
      (
        provider: unknown,
        call: MintCall,
        details?: unknown,
      ) => Promise<{ transaction_hash: string }>
    >(async () => ({ transaction_hash: '0xsnmint' })),
    switchChain: vi.fn<(provider: unknown, chainId: number, addParams?: unknown) => Promise<void>>(
      async () => {},
    ),
    // Typed with an explicit request param (not inferred) so tests can dispatch
    // per-entrypoint via mockImplementation (balance_of vs is_nonce_used).
    callContract: vi.fn<(req: MintCall, blockId?: unknown) => Promise<string[]>>(
      async () => ['0', '0'] as string[],
    ),
    // Mutable holder so a test can override the attested message (e.g. a tampered
    // recipient/domain) before the run; reset to a valid one in beforeEach.
    attestedMessage: { value: '0x' as `0x${string}` },
  }));

// Mock only waitForAttestation (the network poll); keep the REAL
// assertCctpMessageMatches so the A1 validation gate (Fix 2) actually runs.
vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./proven-submit', () => ({ managerExecute }));
// Keep the REAL finality constants but mock the (networked) forwarding-fee quote so
// the FAST path is deterministic offline. Slow path never calls fetchForwardMaxFee.
vi.mock('./cctpFees', () => ({
  FAST_FINALITY_THRESHOLD: 1000,
  STANDARD_FINALITY_THRESHOLD: 2000,
  fetchForwardMaxFee: vi.fn(),
  assertAboveForwardFloor: vi.fn(),
}));
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  // Pass-through: run the submit fn and surface its result.
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
}));

// eth chain id the fake MetaMask reports; mutable per test.
const chainIdHex = { value: '0x13882' }; // 80002 (Polygon Amoy)
const ethProvider = {
  request: vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? chainIdHex.value : null,
  ),
};

vi.mock('../lib/ethereum', () => ({
  switchChain,
}));

import { config, EVM_CCTP_SOURCES } from './config';
import {
  fundFromMetaMask,
  hasInflightDeposit,
  hasAnyInflightDeposit,
  hasAnyInflightTransfer,
  selectEip1559Fees,
  isNonceAlreadyUsedError,
} from './depositIn';
import { isTransientError } from './errors';
import { fetchForwardMaxFee, assertAboveForwardFloor } from './cctpFees';

const mFetchForwardMaxFee = vi.mocked(fetchForwardMaxFee);
const mAssertAboveForwardFloor = vi.mocked(assertAboveForwardFloor);

const SN_RECIPIENT = '0x49abc';
const SN_RECIPIENT_FIELD64 = '49abc'.padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp
const AMOY = EVM_CCTP_SOURCES[80002];
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
// localStorage key + record the resume cursor is persisted under (see depositIn.ts).
const INFLIGHT_DEPOSIT_KEY = 'pmp.inflightDeposit';

// A valid attested message that decodes to (destination = Starknet, recipient =
// the SN account) so the A1 gate passes by default. Built fresh per test in
// beforeEach so a tampering test can swap it out.
function validAttestedMessage(): `0x${string}` {
  return buildCctpMessage({
    sourceDomain: AMOY.domain,
    destinationDomain: config.cctp.starknetDomain,
    recipientField64: SN_RECIPIENT_FIELD64,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  chainIdHex.value = '0x13882';
  burnStatus.value = 'success';
  // Default: SN account unfunded → the full bridge runs.
  callContract.mockResolvedValue(['0', '0']);
  readContract.mockResolvedValue(1_000_000_000n);
  // Default: ample native gas + a typical gas price → the POL pre-check passes.
  getBalance.mockResolvedValue(10n ** 18n);
  getGasPrice.mockResolvedValue(30_000_000_000n);
  // Default EIP-1559 fee + approve estimate → the robust preflight passes on 1 POL.
  estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  estimateContractGas.mockResolvedValue(50_000n);
  writeContract.mockImplementation(
    async (call: WriteArg) =>
      (call.functionName === 'approve' ? '0xapprovetx' : '0xburntx') as `0x${string}`,
  );
  // Default attested message: valid (decodes to the SN recipient + Starknet domain).
  attestedMessage.value = validAttestedMessage();
  waitForAttestation.mockImplementation(async () => ({
    message: attestedMessage.value,
    attestation: ATTESTATION,
  }));
  // Default forwarding-fee quote (only consulted on the FAST path). 14k base units
  // = 10k forward + 4k protocol, finality 1000 — mirrors the fund/return fixtures.
  mFetchForwardMaxFee.mockResolvedValue({
    maxFee: 14_000n,
    forwardFee: 10_000n,
    protocolFee: 4_000n,
    finalityThreshold: 1000,
  });
  mAssertAboveForwardFloor.mockReturnValue(undefined);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('fundFromMetaMask — happy path (MetaMask on a supported source)', () => {
  it('approves, burns toward Starknet, attests by SOURCE domain, mints on Starknet', async () => {
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // Did NOT need to switch chains (already on Amoy).
    expect(switchChain).not.toHaveBeenCalled();

    // approve(tokenMessenger, amount) on the source USDC, then depositForBurn.
    const approve = writeContract.mock.calls.find((c) => c[0].functionName === 'approve')![0];
    expect(approve.address.toLowerCase()).toBe(AMOY.usdc.toLowerCase());
    expect(approve.args).toEqual([AMOY.tokenMessenger, AMOUNT]);

    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    expect(burn.address.toLowerCase()).toBe(AMOY.tokenMessenger.toLowerCase());
    const [amount, destDomain, mintRecipient, burnToken, destCaller, , finality] = burn.args as [
      bigint,
      number,
      string,
      string,
      string,
      bigint,
      number,
    ];
    expect(amount).toBe(AMOUNT);
    // Destination is STARKNET (25), not the source domain.
    expect(destDomain).toBe(config.cctp.starknetDomain);
    // mintRecipient = the SN recipient left-padded to 32 bytes.
    expect(mintRecipient).toBe('0x' + '49abc'.padStart(64, '0'));
    expect(burnToken.toLowerCase()).toBe(AMOY.usdc.toLowerCase());
    expect(destCaller).toBe('0x' + '00'.repeat(32));
    expect(finality).toBe(2000); // Standard

    // Attestation polled by the SOURCE (Amoy) domain, not Starknet's.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(AMOY.domain);

    // Starknet mint: receive_message on the configured transmitter, manager-submitted.
    expect(managerExecute).toHaveBeenCalledTimes(1);
    const mintCall = managerExecute.mock.calls[0][1];
    expect(mintCall.entrypoint).toBe('receive_message');
    expect(mintCall.contractAddress).toBe(config.cctp.snMessageTransmitter);
    // calldata = encodeCctpBytes(message) ++ encodeCctpBytes(attestation), each a
    // Cairo ByteArray [num_full_words, …31B words…, pending_word, pending_word_len].
    // The message is a 280-byte CCTP-v2 blob (148 header + 132 body) → 9 full 31-byte
    // words + a 1-byte pending word, so its num_full_words felt (0x9) leads the calldata.
    expect(mintCall.calldata[0]).toBe('0x9');
  });

  it('fires onBurned once with the burn tx hash + a source-chain explorer link (fresh path)', async () => {
    const burned: Array<{ burnTxHash: string; explorerUrl?: string }> = [];
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      onBurned: (info) => burned.push(info),
    });
    // The two-tx fallback burn returns '0xburntx'; the source is Amoy, whose configured
    // block-explorer base yields /tx/<hash> — so the app can link the EVM leg.
    expect(burned).toEqual([
      { burnTxHash: '0xburntx', explorerUrl: 'https://amoy.polygonscan.com/tx/0xburntx' },
    ]);
  });

  it('FAST: quotes the forwarding fee for the EVM→Starknet route, not Starknet→Polygon (issue #142)', async () => {
    // Bug: the fee was always quoted for starknetDomain(25)→polygonDomain(7) (the
    // fund/return route). Deposit-in burns EVM(Amoy, domain 7) → Starknet(25), so the
    // quote MUST carry sourceDomain = the EVM source domain and destDomain = Starknet.
    chainIdHex.value = '0x13882'; // Polygon Amoy (domain 7)
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });

    expect(mFetchForwardMaxFee).toHaveBeenCalledTimes(1);
    expect(mFetchForwardMaxFee.mock.calls[0][1]).toMatchObject({
      sourceDomain: AMOY.domain, // EVM source (Amoy = 7), NOT 25
      destDomain: config.cctp.starknetDomain, // Starknet = 25, NOT 7
    });
  });
});

describe('fundFromMetaMask — idempotent resume', () => {
  it('is a no-op when the SN account already holds enough USDC', async () => {
    callContract.mockResolvedValue([AMOUNT.toString(), '0']); // balance == amount
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    expect(writeContract).not.toHaveBeenCalled();
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
  });
});

describe('fundFromMetaMask — chain handling', () => {
  it('switches MetaMask to the default source when on an unsupported chain', async () => {
    chainIdHex.value = '0x1'; // Ethereum mainnet — not in EVM_CCTP_SOURCES
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    expect(switchChain).toHaveBeenCalledTimes(1);
    expect(switchChain.mock.calls[0][1]).toBe(config.cctp.defaultEvmSourceChainId);
    // Still proceeds to burn after the switch.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
  });

  it('does not switch when MetaMask is on Ethereum Sepolia (also supported)', async () => {
    chainIdHex.value = '0xaa36a7'; // 11155111
    // The attested message must carry the Sepolia SOURCE domain so the A1 gate
    // (which asserts the source domain) passes for this chain.
    attestedMessage.value = buildCctpMessage({
      sourceDomain: EVM_CCTP_SOURCES[11155111].domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: SN_RECIPIENT_FIELD64,
    });
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    expect(switchChain).not.toHaveBeenCalled();
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(
      EVM_CCTP_SOURCES[11155111].domain,
    );
  });
});

describe('fundFromMetaMask — guards', () => {
  it('throws (no burn) on a zero amount', async () => {
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: 0n,
      }),
    ).rejects.toThrow(/greater than zero/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('surfaces a faucet-actionable error when the MetaMask USDC balance is short', async () => {
    readContract.mockResolvedValue(AMOUNT - 1n);
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/low on USDC.*faucet\.circle\.com/i);
    // Never burned.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
  });

  it('throws if the burn reverts and never mints on Starknet', async () => {
    burnStatus.value = 'reverted';
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/depositForBurn reverted/i);
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
  });
});

// A funder with USDC but ZERO native POL passes the USDC check and even
// eth_estimateGas, then fails only at broadcast with a raw "insufficient funds
// for gas" RPC error. The fresh path pre-checks native balance vs a conservative
// fixed gas budget × the live gas price BEFORE any approve/burn write, so the
// shortfall surfaces a faucet-actionable, TERMINAL error instead.
describe('fundFromMetaMask — native-gas (POL) pre-check (fresh path)', () => {
  it('throws a faucet-actionable POL error BEFORE any approve/burn when native balance is zero', async () => {
    getBalance.mockResolvedValue(0n);
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/Polygon Amoy.*faucet\.polygon\.technology/is);
    // Never approved, never burned — the gate is BEFORE any on-chain write.
    expect(writeContract).not.toHaveBeenCalled();
    expect(waitForAttestation).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
  });

  it('throws when native balance is below the gas budget (insufficient, not zero)', async () => {
    // A live gas price of 1000 gwei × ~300k units ≈ 3e14 wei required; 1e10 wei
    // (0.00000001 POL) is far short.
    getGasPrice.mockResolvedValue(1_000_000_000_000n);
    getBalance.mockResolvedValue(10_000_000_000n);
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/insufficient funds for gas/i);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
  });

  it('classifies the POL shortfall as TERMINAL (does not match the transient marker)', async () => {
    getBalance.mockResolvedValue(0n);
    const err = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    }).catch((e: unknown) => e);
    expect(isTransientError(err)).toBe(false);
  });

  it('proceeds to approve + burn when native balance covers the gas budget', async () => {
    getBalance.mockResolvedValue(10n ** 18n); // 1 POL — ample
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(true);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
  });

  // RED→GREEN (#192): the OLD estimate used getGasPrice() alone × a flat 300k × 2.
  // Here getGasPrice is a low 30 gwei but the EIP-1559 maxFeePerGas is 3000 gwei
  // (a spiked base fee) and the balance (0.1 POL) sits ABOVE the old required-wei
  // (300k×30gwei×2 = 1.8e16) but BELOW the robust one (200k×3000gwei×2 = 1.2e18).
  // The old logic would PASS (then leak a raw revert at broadcast); the robust
  // preflight catches it and throws the friendly, cheaper-chain-steering message.
  it('catches a shortfall the OLD flat getGasPrice() estimate MISSED (EIP-1559 maxFeePerGas)', async () => {
    getGasPrice.mockResolvedValue(30_000_000_000n); // 30 gwei — low
    estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 3_000_000_000_000n, // 3000 gwei — the real cap viem would use
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    getBalance.mockResolvedValue(10n ** 17n); // 0.1 POL — passes old, fails robust
    const err = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Insufficient funds for gas/i);
    expect((err as Error).message).toMatch(/cheaper source chain/i);
    // Threw BEFORE any on-chain write — no approve, no burn.
    expect(writeContract).not.toHaveBeenCalled();
    // TERMINAL, not resume-looping.
    expect(isTransientError(err)).toBe(false);
  });

  // Part 2 (#192): even with the robust preflight, gas price can spike between the
  // read and broadcast. If viem throws a RAW "insufficient funds for gas" at the
  // approve write, the leg must re-throw the SAME friendly message, never the raw
  // revert. Balance is ample here so the preflight passes → we exercise the catch.
  it('re-throws the FRIENDLY message (not the raw viem revert) when approve fails with insufficient funds at broadcast', async () => {
    getBalance.mockResolvedValue(10n ** 18n); // 1 POL — preflight passes
    // viem-style raw revert on the approve broadcast (first writeContract call).
    writeContract.mockRejectedValueOnce(
      new Error(
        'insufficient funds for gas * price + value: balance 139000000000000, tx cost 177000000000000',
      ),
    );
    const err = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Insufficient funds for gas/i);
    expect((err as Error).message).toMatch(/cheaper source chain/i);
    // Not the raw viem text.
    expect((err as Error).message).not.toMatch(/tx cost/i);
    // Never reached the burn (approve threw first).
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
  });
});

// A persisted inflight-deposit cursor as depositIn.ts writes it, keyed per funder.
function seedInflightCursor(record: {
  burnTx: string;
  sourceDomain: number;
  amountWei: string;
  snRecipient: string;
  evmChainId: number;
  maxFee?: string;
  fold?: boolean;
}): void {
  localStorage.setItem(
    INFLIGHT_DEPOSIT_KEY,
    JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: record }),
  );
}

describe('fundFromMetaMask — inflight-deposit resume cursor (Fix 1/A2)', () => {
  it('persists a resume cursor (with the burn tx hash) on the fresh burn path', async () => {
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    // Cleared on mint success — so it's gone after a full happy run.
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('RESUMES from a persisted cursor: skips approve+burn, attests off the cursor, mints', async () => {
    // A prior run already burned for THIS funder but didn't finish attest/mint.
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // Did NOT re-burn (no approve, no depositForBurn) — re-burning double-spends.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(false);
    // Resumed attest off the PERSISTED burn tx + its source domain.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(AMOY.domain);
    // …then minted on Starknet.
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(managerExecute.mock.calls[0][1].entrypoint).toBe('receive_message');
    // Cursor cleared on mint success.
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('fires onBurned from the cursor on resume (so the EVM leg links even when only attest/mint remain)', async () => {
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    const burned: Array<{ burnTxHash: string; explorerUrl?: string }> = [];
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      onBurned: (info) => burned.push(info),
    });

    // The burn tx + its explorer come from the cursor's own source chain (authoritative
    // on resume), never a fresh burn.
    expect(burned).toEqual([
      { burnTxHash: '0x0ab12cd34e', explorerUrl: 'https://amoy.polygonscan.com/tx/0x0ab12cd34e' },
    ]);
  });

  it('#229: RESUME returns the net computed from the PERSISTED maxFee, not a fresh requote', async () => {
    // The original burn used maxFee=14_000n (persisted on the cursor). The live fee
    // has since drifted to 30_000n — a resume must NOT use that new quote; the mint
    // already landed amount − 14_000n on Starknet.
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
      maxFee: '14000',
    });
    mFetchForwardMaxFee.mockResolvedValue({
      maxFee: 30_000n,
      forwardFee: 20_000n,
      protocolFee: 10_000n,
      finalityThreshold: 1000,
    });

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });

    // Pre-fix: net === AMOUNT - 30_000n (the drifted requote). FAILS.
    expect(net).toBe(AMOUNT - 14_000n);
  });

  it('#229: a LEGACY cursor with no persisted maxFee falls back to a fresh requote', async () => {
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
      // no maxFee — pre-#229 cursor shape
    });

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });

    expect(net).toBe(AMOUNT - 14_000n); // the default mocked quote
  });

  it('does NOT run the native-gas (POL) pre-check on the resume path (it does no EVM tx)', async () => {
    // Resume's only chain leg is the manager-gas-paid Starknet mint — no EVM tx,
    // so a funder with zero native POL must still be able to finish a burned
    // deposit. The fresh-path POL gate must not fire here.
    getBalance.mockResolvedValue(0n);
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // The native-balance read never ran (resume does no EVM tx), and the mint landed.
    expect(getBalance).not.toHaveBeenCalled();
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('clears the cursor after a successful mint (fresh path)', async () => {
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('ignores + clears a CORRUPT cursor and runs the fresh burn path', async () => {
    // A half-written / malformed record must not poison the resume path.
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: { burnTx: 123, garbage: true } }),
    );

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // Treated as a FRESH deposit: a real burn happened (not a resume off garbage).
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    // Attested off the fresh burn tx, not the corrupt record.
    expect(waitForAttestation.mock.calls[0][0]).toBe('0xburntx');
    // Mint landed → cursor cleared.
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('does NOT resume off a cursor written by a DIFFERENT funder', async () => {
    // Cursor is keyed per funder; a different EVM address must not be resumed.
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        '0x00000000000000000000000000000000000ffff': {
          burnTx: '0x0ffe12b04a',
          sourceDomain: AMOY.domain,
          amountWei: AMOUNT.toString(),
          snRecipient: SN_RECIPIENT,
          evmChainId: 80002,
        },
      }),
    );

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // Fresh burn (the other funder's cursor is not ours to resume).
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0xburntx');
  });
});

// A resumed cursor's message can already be CONSUMED on the SN MessageTransmitter
// (a prior resume minted it, then depositToPool swept the derived account clean —
// so the balance no-op gate (1) reads 0 and can't recognize "already funded"). The
// resume path must detect this via is_nonce_used, clear the dead cursor, and fall
// through to a FRESH burn for the CURRENT amount — never loop re-attesting a dead
// message. A read FAILURE must NOT be treated as a detection (fail-closed): the
// cursor is preserved and the error rethrows.
describe('fundFromMetaMask — resume detects an already-consumed CCTP nonce', () => {
  it('used nonce: clears the dead cursor and falls through to a FRESH deposit for the current amount', async () => {
    const NONCE_RESULT = ['0x1'];
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? NONCE_RESULT : ['0', '0'], // balance_of stays 0: swept-balance zombie precondition
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    // Fresh path reached: MetaMask branch invoked (approve + depositForBurn).
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(true);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    // Attested twice: first the dead cursor tx (detects already-minted), then the
    // fresh burn tx.
    expect(waitForAttestation).toHaveBeenCalledTimes(2);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    expect(waitForAttestation.mock.calls[1][0]).toBe('0xburntx');
    // The nonce gate is resume-only: submitStarknetMint (→ managerExecute) never
    // ran for the dead cursor, only for the fresh mint.
    expect(managerExecute).toHaveBeenCalledTimes(1);
    // Dead cursor cleared, fresh cursor cleared on its own successful mint.
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
    // Returns the NET for the CURRENT args, not anything derived from the dead cursor.
    expect(net).toBe(AMOUNT);

    // Pin the wire: is_nonce_used read against the configured transmitter, keyed by
    // the fixture's all-zero nonce (buildCctpMessage zeroes nonce+sender+recipient+
    // destinationCaller).
    const nonceCall = callContract.mock.calls.find(([req]) => req.entrypoint === 'is_nonce_used');
    expect(nonceCall?.[0]).toEqual({
      contractAddress: config.cctp.snMessageTransmitter,
      entrypoint: 'is_nonce_used',
      calldata: ['0x0', '0x0'],
    });
  });

  it('is_nonce_used RPC failure fails closed: preserves the cursor and rethrows', async () => {
    callContract.mockImplementation(async (req) => {
      if (req.entrypoint === 'is_nonce_used') throw new Error('rpc unavailable 503');
      return ['0', '0'];
    });
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/rpc unavailable/);

    // Cursor is STILL present (a read failure proves nothing — never cleared).
    const map = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)!) as Record<string, unknown>;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeDefined();
    // Never fell through to a fresh burn, never minted.
    expect(writeContract).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
  });

  it('unused nonce: resume proceeds exactly as today (no fresh burn)', async () => {
    const NONCE_RESULT = ['0x0'];
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? NONCE_RESULT : ['0', '0'],
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(false);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });
});

// FIX 1 — FOLD-path resume must not re-consume an already-spent CCTP nonce.
// On the single-tx fold path the CCTP mint (receive_message) is folded INTO the
// atomic deposit tx, so a consumed nonce ⟺ that whole atomic deposit already
// committed. A resume that detected the nonce used must NOT (a) re-submit
// receive_message with the spent nonce (→ "Nonce already used" revert loop) nor
// (b) fall through to a FRESH re-burn (the standalone behavior). Instead it fires
// onMintAlreadyConsumed and returns the already-landed net so the caller converges
// on completion. A NOT-yet-used nonce re-folds exactly as today.
describe('fundFromMetaMask — FOLD-path resume vs a used CCTP nonce (Fix 1)', () => {
  it('deferMint + used nonce: fires onMintAlreadyConsumed, NO re-burn, NO re-fold, returns landed net', async () => {
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? ['0x1'] : ['0', '0'],
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
      fold: true, // the burn was started on the fold path
    });

    const onMintFold = vi.fn();
    const onMintAlreadyConsumed = vi.fn();
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      deferMint: true,
      onMintFold,
      onMintAlreadyConsumed,
    });

    // The fold-path completion signal fired; nothing was handed back to re-fold.
    expect(onMintAlreadyConsumed).toHaveBeenCalledTimes(1);
    expect(onMintFold).not.toHaveBeenCalled();
    // NO fresh re-burn (the bug this fix prevents) and NO standalone mint.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(false);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
    expect(managerExecute).not.toHaveBeenCalled();
    // Only the cursor tx was attested — never a fresh burn tx.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    // Dead cursor cleared (the atomic deposit that consumed the nonce already landed).
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
    // Returns the already-landed net (standard fee 0 → gross).
    expect(net).toBe(AMOUNT);
  });

  it('deferMint + UNused nonce: re-folds exactly as today (onMintFold fires, no re-burn)', async () => {
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? ['0x0'] : ['0', '0'],
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
    });

    const onMintFold = vi.fn();
    const onMintAlreadyConsumed = vi.fn();
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      deferMint: true,
      onMintFold,
      onMintAlreadyConsumed,
    });

    // Re-folded (bytes handed back), never signalled complete.
    expect(onMintFold).toHaveBeenCalledTimes(1);
    expect(onMintAlreadyConsumed).not.toHaveBeenCalled();
    // No fresh re-burn; the standalone mint is NOT submitted (it rides in the fold).
    expect(writeContract).not.toHaveBeenCalled();
    expect(managerExecute).not.toHaveBeenCalled();
    // The fold path leaves the burn cursor in place (caller clears it after the
    // folded deposit lands, via the clearMintCursor handed to onMintFold).
    const map = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)!) as Record<string, unknown>;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeDefined();
  });

  // Bugbot HIGH — "Fold resume misclassifies spent nonce". A burn STARTED on the fold
  // path (cursor.fold === true) but RESUMED with deferMint recomputed FALSE (the
  // single-tx flag toggled off, no paymaster, or non–a-priori sizing between the burn
  // and the resume) must STILL converge on completion off the persisted fold marker —
  // NEVER fall through to a fresh EVM re-burn of value that already reached the pool.
  // Red before the fix (old code branched on the live `deferMint` → 'already-minted' →
  // fresh re-burn = double-spend); green after (branches on the persisted cursor.fold).
  it('fold burn + deferMint FLIPPED false on resume: converges, does NOT re-burn (Bugbot HIGH)', async () => {
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? ['0x1'] : ['0', '0'],
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
      fold: true, // the burn was STARTED as a single-tx fold
    });

    const onMintFold = vi.fn();
    const onMintAlreadyConsumed = vi.fn();
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      deferMint: false, // config drifted: recomputed FALSE this resume run
      onMintFold,
      onMintAlreadyConsumed,
    });

    // Converged off the persisted fold marker, NOT the live deferMint.
    expect(onMintAlreadyConsumed).toHaveBeenCalledTimes(1);
    expect(onMintFold).not.toHaveBeenCalled();
    // THE bug: no fresh EVM re-burn (double-spend) and no standalone mint.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'approve')).toBe(false);
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
    expect(managerExecute).not.toHaveBeenCalled();
    // Only the cursor tx was attested — never a fresh burn tx.
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(waitForAttestation.mock.calls[0][0]).toBe('0x0ab12cd34e');
    // Dead cursor cleared; returns the already-landed net (standard fee 0 → gross).
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
    expect(net).toBe(AMOUNT);
  });
});

// A cursor from a SMALLER prior burn whose mint already landed (its net is still in
// the account) must NOT let gate 1 no-op a LARGER current request. Gate 1's threshold
// is the CURRENT amount's net; the cursor's persisted-fee net (#229's drift fix) only
// applies when the cursor is for THIS SAME gross amount. Otherwise the smaller landed
// balance satisfies the gate, which returns the smaller net and clears the cursor —
// stranding the extra the caller now wants to deposit (bugbot: gate-1 amount mismatch).
describe('fundFromMetaMask — gate-1 no-op ignores a cursor for a DIFFERENT amount', () => {
  it('a LARGER request does not no-op on a smaller cursor’s landed balance — burns fresh', async () => {
    const CURSOR_AMOUNT = 500_000n; // a prior 0.5 USDC deposit (smaller than the 1 USDC now requested)
    const CURSOR_FEE = 50_000n; // the fee it ACTUALLY burned with, persisted on the cursor
    const CURSOR_LANDED_NET = CURSOR_AMOUNT - CURSOR_FEE; // still sitting in the SN account
    // balance_of returns the smaller cursor's still-present landed net; is_nonce_used
    // reports the prior mint as consumed, so resume detects the dead cursor.
    callContract.mockImplementation(async (req) =>
      req.entrypoint === 'is_nonce_used' ? ['0x1'] : [CURSOR_LANDED_NET.toString(), '0'],
    );
    seedInflightCursor({
      burnTx: '0x0ab12cd34e',
      sourceDomain: AMOY.domain,
      amountWei: CURSOR_AMOUNT.toString(),
      snRecipient: SN_RECIPIENT,
      evmChainId: 80002,
      maxFee: CURSOR_FEE.toString(),
    });

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT, // LARGER than the cursor's amount
    });

    // Gate 1 did NOT no-op on the stale smaller net: resume detected the dead cursor
    // and fell through to a FRESH burn for the full current amount.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    // Returns the CURRENT request's net (no fee on the default path), never the
    // smaller cursor-derived net that the pre-fix gate 1 wrongly returned.
    expect(net).toBe(AMOUNT);
    expect(net).not.toBe(CURSOR_LANDED_NET);
  });
});

describe('fundFromMetaMask — attested-message validation gate (Fix 2/A1)', () => {
  it('REFUSES to mint when the attested message recipient differs (redirect attack)', async () => {
    // Tampered: same Starknet destination domain but a DIFFERENT mint recipient.
    attestedMessage.value = buildCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: 'beef'.padStart(64, '0'),
    });
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    // Crucially: never submitted receive_message on a bad message.
    expect(managerExecute).not.toHaveBeenCalled();
  });

  it('REFUSES to mint when the destination domain is wrong (not Starknet)', async () => {
    attestedMessage.value = buildCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.polygon.domain, // wrong destination chain
      recipientField64: SN_RECIPIENT_FIELD64,
    });
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(managerExecute).not.toHaveBeenCalled();
  });

  // Finding 2 (LOW): the PART B FOLD path skips submitStarknetMint (the mint rides
  // inside the caller's deposit tx), so the attested-message gate must run in the
  // deferMint branch too — a tampered recipient must be REJECTED, never silently
  // forwarded to onMintFold (which would fold a redirected mint into the deposit).
  it('deferMint fold REFUSES a wrong-recipient attested message (not forwarded to onMintFold)', async () => {
    attestedMessage.value = buildCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: 'beef'.padStart(64, '0'), // redirected mint recipient
    });
    let folded = false;
    let err: unknown;
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
        deferMint: true,
        onMintFold: () => {
          folded = true;
        },
      }).catch((e: unknown) => {
        err = e;
        throw e;
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    // The tampered bytes were NOT handed to the caller to fold.
    expect(folded).toBe(false);
    // Terminal (never resume-looped), same classification as the standalone mint gate.
    expect(isTransientError(err)).toBe(false);
  });

  it('deferMint fold REFUSES a wrong-destination-domain attested message', async () => {
    attestedMessage.value = buildCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.polygon.domain, // wrong destination chain
      recipientField64: SN_RECIPIENT_FIELD64,
    });
    let folded = false;
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
        deferMint: true,
        onMintFold: () => {
          folded = true;
        },
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    expect(folded).toBe(false);
  });
});

// The cursor's clear-vs-preserve lifecycle on a post-burn failure must mirror the
// fund-account leg: a DEMONSTRABLY-TERMINAL error clears it (resume can't help); ANY OTHER
// failure PRESERVES it so the next run resumes (the burn is replayable by tx hash).
describe('fundFromMetaMask — clear-on-terminal vs preserve (Fix 1/A2)', () => {
  it('CLEARS the cursor on a demonstrably-terminal message mismatch (after burn)', async () => {
    // Fresh path burns + persists the cursor, then the A1 gate rejects the
    // tampered attested message → terminal → the cursor must NOT be left to loop.
    attestedMessage.value = buildCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: 'beef'.padStart(64, '0'),
    });
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/recipient\/domain mismatch/i);
    // Burn DID happen (fresh path), but the terminal gate cleared the cursor.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    expect(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)).toBe('{}');
  });

  it('PRESERVES the cursor on an UNCLASSIFIED non-transient mint error (resume stays possible)', async () => {
    // A one-off Starknet error that matches neither TRANSIENT_RE nor TERMINAL_RE
    // must NOT strand the deposit — the burn is replayable, so keep the cursor.
    managerExecute.mockRejectedValueOnce(new Error('some unexpected starknet failure'));
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
      }),
    ).rejects.toThrow(/unexpected starknet failure/i);
    // The cursor survives (keyed by funder) so the next fundFromMetaMask resumes.
    const map = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY)!) as Record<string, unknown>;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeDefined();
  });
});

// VITE_CCTP_FAST must reach the deposit-in burn: when fast, the burn uses Fast
// finality (1000) + a quoted forwarding max_fee, and — because CCTP mints
// `amount − maxFee` on the destination — the leg's net-minted accounting (the
// no-op/resume balance threshold AND the value fed to the downstream pool deposit)
// must key on the NET, not the gross burn amount. Slow (fast=false) stays 2000/0.
describe('fundFromMetaMask — honors CCTP Fast (finality 1000 + quoted maxFee + net amount)', () => {
  it('FAST: burns with finality 1000 + the quoted maxFee, and floor-checks the burn', async () => {
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });

    // Quoted the forwarding fee for the burn amount on the fast tier + floor-checked.
    expect(mFetchForwardMaxFee).toHaveBeenCalledTimes(1);
    expect(mFetchForwardMaxFee.mock.calls[0][0]).toBe(AMOUNT);
    expect(mFetchForwardMaxFee.mock.calls[0][1]).toMatchObject({ fast: true });
    expect(mAssertAboveForwardFloor).toHaveBeenCalled();

    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    const [amount, , , , , maxFee, finality] = burn.args as [
      bigint,
      number,
      string,
      string,
      string,
      bigint,
      number,
    ];
    // The GROSS burn amount is what the user spends; the fee comes out of the mint.
    expect(amount).toBe(AMOUNT);
    expect(finality).toBe(1000); // Fast
    expect(maxFee).toBe(14_000n); // the quoted forwarding max_fee, NOT 0
  });

  it('FAST: returns the NET minted amount (amount − maxFee) for the downstream deposit', async () => {
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });
    expect(net).toBe(AMOUNT - 14_000n);
  });

  it('FAST: no-ops once the SN account holds the NET (amount − maxFee), not the gross', async () => {
    // The CCTP mint deposits `amount − maxFee`, so a resumed run must treat the NET
    // as "already funded" — requiring the gross would re-burn forever.
    callContract.mockResolvedValue([(AMOUNT - 14_000n).toString(), '0']);
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: true,
    });
    // Recognized as funded → never re-burned.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
    expect(managerExecute).not.toHaveBeenCalled();
    expect(net).toBe(AMOUNT - 14_000n);
  });

  it('SLOW (default fast=false): keeps finality 2000 / maxFee 0 and returns the gross', async () => {
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      fast: false,
    });
    // Slow path never quotes the forwarding fee.
    expect(mFetchForwardMaxFee).not.toHaveBeenCalled();
    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    const [, , , , , maxFee, finality] = burn.args as [
      bigint,
      number,
      string,
      string,
      string,
      bigint,
      number,
    ];
    expect(finality).toBe(2000); // Standard
    expect(maxFee).toBe(0n);
    // With no fee, net == gross.
    expect(net).toBe(AMOUNT);
  });
});

describe('fundFromMetaMask — sourceChainId (Tier 2 Feature A: multi-chain picker)', () => {
  it('switches to the preferred chain and burns using its source config', async () => {
    // MetaMask is on Amoy (default); we pass Sepolia as the preferred source.
    // The burn must use Sepolia's USDC + tokenMessenger + domain.
    const SEPOLIA = EVM_CCTP_SOURCES[11155111];
    // The attested message must carry the Sepolia source domain so the A1 gate passes.
    attestedMessage.value = buildCctpMessage({
      sourceDomain: SEPOLIA.domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: SN_RECIPIENT_FIELD64,
    });
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      sourceChainId: 11155111,
    });

    // MetaMask switched to Sepolia (the preferred chain).
    expect(switchChain).toHaveBeenCalledTimes(1);
    expect(switchChain.mock.calls[0][1]).toBe(11155111);

    // Approve used Sepolia USDC.
    const approve = writeContract.mock.calls.find((c) => c[0].functionName === 'approve')![0];
    expect(approve.address.toLowerCase()).toBe(SEPOLIA.usdc.toLowerCase());

    // depositForBurn used Sepolia tokenMessenger + Sepolia's source domain is NOT
    // the destination domain (destination is always Starknet).
    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    expect(burn.address.toLowerCase()).toBe(SEPOLIA.tokenMessenger.toLowerCase());
    const [, destDomain] = burn.args as [bigint, number, ...unknown[]];
    expect(destDomain).toBe(config.cctp.starknetDomain);

    // Attestation polled by Sepolia's source domain.
    expect(waitForAttestation.mock.calls[0][1].sourceDomain).toBe(SEPOLIA.domain);
  });

  it('omitting sourceChainId preserves existing behavior (no extra switchChain when already on a supported chain)', async () => {
    // MetaMask is on Amoy; omitting sourceChainId must NOT trigger an extra switch.
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      // No sourceChainId — auto-detect path.
    });
    expect(switchChain).not.toHaveBeenCalled();
    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    // Burn still happened using the auto-detected Amoy source.
    expect(burn.address.toLowerCase()).toBe(AMOY.tokenMessenger.toLowerCase());
  });

  it('THROWS on an unsupported explicit sourceChainId — never silently burns on the wallet chain (MED #1)', async () => {
    // 999999 is an EXPLICIT pick that is not a registered source. MetaMask is on
    // Amoy. The old behavior silently auto-detected → would burn on Amoy (chain Y)
    // when the user explicitly chose 999999 (chain X) — a user-intent violation.
    // It must now throw and NOT switch chains or burn anything.
    await expect(
      fundFromMetaMask({
        evmAddress: EVM_ADDRESS,
        snRecipient: SN_RECIPIENT,
        provider: ethProvider,
        amountWei: AMOUNT,
        sourceChainId: 999999, // unsupported explicit pick
      }),
    ).rejects.toThrow(/not a supported CCTP source/i);
    // Did NOT silently switch to (or burn on) the wallet's current chain.
    expect(switchChain).not.toHaveBeenCalled();
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(
      false,
    );
  });
});

// MEDIUM-1 (fund-safety): a persisted burn-but-not-yet-minted deposit cursor is an
// IN-FLIGHT CCTP transfer that survives a reload. hasInflightDeposit(funder) is the
// synchronous reader the UI consults on mount / funder change to keep the network
// switch BLOCKED (a switch mid-transfer would resume the mint against the
// WRONG-network transmitter/domain and misroute funds). This is the RED→GREEN unit
// proving the reader; the MoveIntoPool wiring OR's it into setFlowInFlight.
describe('hasInflightDeposit — persisted cursor drives the in-flight block (MED-1)', () => {
  // burnTx must be strict 0x-hex (isValidInflightDeposit rejects non-hex like the
  // '0xburntx' mock label), else the record reads as corrupt → treated as no cursor.
  const VALID_CURSOR = {
    burnTx: `0x${'ab'.repeat(32)}`,
    sourceDomain: AMOY.domain,
    amountWei: AMOUNT.toString(),
    snRecipient: SN_RECIPIENT,
    evmChainId: AMOY.chainId,
  };

  it('is false with no persisted cursor', () => {
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(false);
  });

  it('is TRUE when a valid persisted cursor exists for the funder', () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(true);
  });

  it('is case-insensitive on the funder key (cursor keyed lowercased)', () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasInflightDeposit(EVM_ADDRESS.toUpperCase())).toBe(true);
  });

  it('is false for a DIFFERENT funder (not this account\'s in-flight transfer)', () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasInflightDeposit('0x0000000000000000000000000000000000000001')).toBe(false);
  });

  it('is false for an empty address (no connected funder)', () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasInflightDeposit('')).toBe(false);
  });

  it('is false for a CORRUPT cursor (treated as fresh, not resumable off garbage)', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: { burnTx: 123, garbage: true } }),
    );
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(false);
  });

  it('flips back to false once the transfer resolves (cursor cleared after mint)', async () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(true);
    // A full happy deposit clears the cursor on mint success (proven above).
    await fundFromMetaMask({ evmAddress: EVM_ADDRESS, snRecipient: SN_RECIPIENT, provider: ethProvider, amountWei: AMOUNT });
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(false);
  });
});

// FUND-SAFETY (Bugbot HIGH — "Deposit cursor switch gap"): the network toggle in
// the always-present NavBar can be clicked while SIGNED OUT (no funder known), so
// the per-funder hasInflightDeposit(addr) can't guard it. hasAnyInflightDeposit()
// is the funder-AGNOSTIC reader NetworkContext uses to block the switch (and thus
// the cursor-wiping disconnect) whenever ANY funder has an unresolved deposit.
describe('hasAnyInflightDeposit — funder-agnostic cursor detection (Bugbot HIGH)', () => {
  const VALID_CURSOR = {
    burnTx: `0x${'ab'.repeat(32)}`,
    sourceDomain: AMOY.domain,
    amountWei: AMOUNT.toString(),
    snRecipient: SN_RECIPIENT,
    evmChainId: AMOY.chainId,
  };

  it('is false with no persisted cursor', () => {
    expect(hasAnyInflightDeposit()).toBe(false);
  });

  it('is TRUE when SOME funder has a valid cursor — WITHOUT passing an address', () => {
    // Seeded under a funder the caller never names (signed-out toggle case).
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({ '0x00000000000000000000000000000000000abcde': VALID_CURSOR }),
    );
    expect(hasAnyInflightDeposit()).toBe(true);
  });

  it('is TRUE for the connected funder\'s own cursor too', () => {
    seedInflightCursor(VALID_CURSOR);
    expect(hasAnyInflightDeposit()).toBe(true);
  });

  it('is false when the ONLY persisted record is corrupt (not resumable off garbage)', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({ '0x00000000000000000000000000000000000abcde': { burnTx: 123, garbage: true } }),
    );
    expect(hasAnyInflightDeposit()).toBe(false);
  });

  it('is TRUE when at least one of several records is valid (mixed corrupt + valid)', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        '0x0000000000000000000000000000000000000bad': { burnTx: 'nope' },
        '0x0000000000000000000000000000000000009999': VALID_CURSOR,
      }),
    );
    expect(hasAnyInflightDeposit()).toBe(true);
  });

  it('is false for an empty map (all cursors cleared)', () => {
    localStorage.setItem(INFLIGHT_DEPOSIT_KEY, '{}');
    expect(hasAnyInflightDeposit()).toBe(false);
  });
});

// FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): the switch guard
// wiped ALL pmp.* on disconnect but only CHECKED the deposit cursor, so an account BURN
// (pmp.inflightBurn) or a RETURN (pmp.inflightReturn) in flight could be stranded.
// hasAnyInflightTransfer must OR all three funder-agnostic readers.
describe('hasAnyInflightTransfer — covers deposit + burn + return cursors (Bugbot HIGH)', () => {
  const INFLIGHT_BURN_KEY = 'pmp.inflightBurn';
  const INFLIGHT_RETURN_KEY = 'pmp.inflightReturn';
  const VALID_DEPOSIT = {
    burnTx: `0x${'ab'.repeat(32)}`,
    sourceDomain: AMOY.domain,
    amountWei: AMOUNT.toString(),
    snRecipient: SN_RECIPIENT,
    evmChainId: AMOY.chainId,
  };
  // Mirrors the app's own InflightBurn required-field shape.
  const VALID_BURN = {
    burnTxHash: `0x${'cd'.repeat(32)}`,
    eoaAddress: '0x000000000000000000000000000000000000dEaD',
    bidIndex: 0,
    amountHuman: '1',
  };
  // Mirrors returnIn's InflightReturn shape.
  const VALID_RETURN = {
    phase: 'cctp',
    accountIndex: 0,
    burnTx: `0x${'ef'.repeat(32)}`,
    sourceDomain: 7,
    amount: AMOUNT.toString(),
    commitment: '123456789',
    evmChainId: AMOY.chainId,
  };

  beforeEach(() => {
    localStorage.removeItem(INFLIGHT_DEPOSIT_KEY);
    localStorage.removeItem(INFLIGHT_BURN_KEY);
    localStorage.removeItem(INFLIGHT_RETURN_KEY);
  });

  it('is false when NO cursor of any kind is persisted', () => {
    expect(hasAnyInflightTransfer()).toBe(false);
  });

  it('is TRUE from a persisted DEPOSIT cursor alone', () => {
    localStorage.setItem(INFLIGHT_DEPOSIT_KEY, JSON.stringify({ '0xabc': VALID_DEPOSIT }));
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  // RED before the fix: hasAnyInflightDeposit ignores this key, so the switch guard
  // let a burn-but-not-minted account be stranded by the disconnect() cursor wipe.
  it('is TRUE from a persisted BURN cursor alone (previously ignored → strand)', () => {
    localStorage.setItem(INFLIGHT_BURN_KEY, JSON.stringify({ '0xabc': VALID_BURN }));
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  // RED before the fix: same gap for the return leg.
  it('is TRUE from a persisted RETURN cursor alone (previously ignored → strand)', () => {
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ '0xabc': VALID_RETURN }));
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  it('is false when the ONLY burn/return records are corrupt (not resumable off garbage)', () => {
    localStorage.setItem(INFLIGHT_BURN_KEY, JSON.stringify({ '0xabc': { burnTxHash: 123 } }));
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ '0xabc': { phase: 'bogus' } }));
    expect(hasAnyInflightTransfer()).toBe(false);
  });
});

// isValidInflightDeposit is observed through hasInflightDeposit / hasAnyInflightDeposit.
// Deposit-in is native-gas only: a valid cursor needs a 0x-hex burnTx. A legacy cursor
// may carry an extra `path: 'native'` field (from before deposit-in became native-only) —
// an unknown extra field must be IGNORED, not rejected (back-compat).
describe('isValidInflightDeposit — native-only validity', () => {
  const NATIVE_BURN_TX = `0x${'bb'.repeat(32)}`;

  it('a cursor with a 0x-hex burnTx is VALID', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        [EVM_ADDRESS.toLowerCase()]: {
          burnTx: NATIVE_BURN_TX,
          sourceDomain: AMOY.domain,
          amountWei: AMOUNT.toString(),
          snRecipient: SN_RECIPIENT,
          evmChainId: 80002,
        },
      }),
    );
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(true);
    expect(hasAnyInflightDeposit()).toBe(true);
  });

  it('back-compat: a legacy cursor with an extra path:"native" field still reads back', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        [EVM_ADDRESS.toLowerCase()]: {
          burnTx: NATIVE_BURN_TX,
          sourceDomain: AMOY.domain,
          amountWei: AMOUNT.toString(),
          snRecipient: SN_RECIPIENT,
          evmChainId: 80002,
          path: 'native',
        },
      }),
    );
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(true);
  });

  it('a cursor with an EMPTY burnTx is INVALID', () => {
    localStorage.setItem(
      INFLIGHT_DEPOSIT_KEY,
      JSON.stringify({
        [EVM_ADDRESS.toLowerCase()]: {
          burnTx: '',
          sourceDomain: AMOY.domain,
          amountWei: AMOUNT.toString(),
          snRecipient: SN_RECIPIENT,
          evmChainId: 80002,
        },
      }),
    );
    expect(hasInflightDeposit(EVM_ADDRESS)).toBe(false);
  });
});

// RED→GREEN (gas-tip-below-minimum, 2026-07-08): the Amoy approve/depositForBurn
// were submitted with NO explicit EIP-1559 fee, so viem/the wallet picked the tip —
// which sampled a hair UNDER Amoy's enforced 25-gwei minimum (24.25 gwei) or fell
// back to a far-too-low default (1.5 gwei), and the RPC rejected the submit with
// "gas tip cap … below minimum". The fix reads the live fee and floors+bumps the
// tip to the chain minimum (selectEip1559Fees + EvmCctpSource.minPriorityFeeGwei),
// passing it EXPLICITLY to writeContract. Pre-fix the captured tip is undefined →
// these fail; post-fix it is ≥ 25 gwei.
const AMOY_MIN_TIP_WEI = 25_000_000_000n; // AMOY.minPriorityFeeGwei (25) in wei.

describe('fundFromMetaMask — EVM tip floored to the network minimum (gas-tip-below-min fix)', () => {
  it('floors a slightly-STALE under-estimate (24.25 gwei) up to ≥ the Amoy 25-gwei minimum on both writes', async () => {
    // The exact live-reported under-estimate: 24.25 gwei ≈ 0.97 × the 25-gwei floor.
    estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 26_000_000_000n,
      maxPriorityFeePerGas: 24_250_000_000n,
    });

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    const approve = writeContract.mock.calls.find((c) => c[0].functionName === 'approve')![0];
    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    for (const call of [approve, burn]) {
      // The submitted tip must be at/above the network minimum (pre-fix: undefined).
      expect(call.maxPriorityFeePerGas).toBeGreaterThanOrEqual(AMOY_MIN_TIP_WEI);
      // …and the cap must still cover the tip (viem invariant maxFee ≥ tip).
      expect(call.maxFeePerGas!).toBeGreaterThanOrEqual(call.maxPriorityFeePerGas!);
    }
  });

  it('floors a too-low wallet-default tip (1.5 gwei) up to ≥ the Amoy 25-gwei minimum', async () => {
    estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
    });

    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
    });

    const burn = writeContract.mock.calls.find((c) => c[0].functionName === 'depositForBurn')![0];
    expect(burn.maxPriorityFeePerGas).toBeGreaterThanOrEqual(AMOY_MIN_TIP_WEI);
  });
});

// Unit coverage for the pure fee selector: max(estimatedTip, floor) × margin, cap
// keeps the estimate's base-fee headroom. (The live submit stays testnet/human-gated
// per .claude/rules/verification.md; this pins the pure selection.)
describe('selectEip1559Fees — floor + upward margin', () => {
  it('lifts an at/below-minimum estimated tip to ABOVE the floor', () => {
    const out = selectEip1559Fees(
      { maxFeePerGas: 26_000_000_000n, maxPriorityFeePerGas: 24_250_000_000n },
      AMOY_MIN_TIP_WEI,
    );
    expect(out.maxPriorityFeePerGas).toBeGreaterThanOrEqual(AMOY_MIN_TIP_WEI);
    expect(out.maxFeePerGas).toBeGreaterThanOrEqual(out.maxPriorityFeePerGas);
  });

  it('bumps an ABOVE-floor tip upward by the margin (headroom over the floor)', () => {
    const out = selectEip1559Fees(
      { maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 40_000_000_000n },
      AMOY_MIN_TIP_WEI,
    );
    // 40 gwei > 25 floor → margin (×2) applies to the estimate, not the floor.
    expect(out.maxPriorityFeePerGas).toBe(80_000_000_000n);
    // Base-fee portion (100 − 40 = 60 gwei) preserved + bumped tip (80) = 140 gwei.
    expect(out.maxFeePerGas).toBe(140_000_000_000n);
  });

  it('with no floor (undefined) just applies the margin — no minimum imposed', () => {
    const out = selectEip1559Fees({
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    expect(out.maxPriorityFeePerGas).toBe(4_000_000_000n); // 2 gwei × 2
    expect(out.maxFeePerGas).toBe(12_000_000_000n); // base 8 + tip 4
  });
});


// PART B — single-tx deposit fold: `deferMint` hands the attested bytes back instead
// of submitting the standalone Starknet mint, so the caller can fold receive_message
// into the atomic pool-deposit tx. The in-flight burn cursor is PRESERVED (the mint
// lands inside the deposit tx; the caller clears it via clearMintCursor after that
// commits). NOTE: the live AVNU-server acceptance of the folded multicall is UNPROVEN
// offline — this pins only the client-side defer behavior + control flow.
describe('fundFromMetaMask — Part B deferMint fold', () => {
  it('deferMint:true → skips the standalone mint, fires onMintFold, preserves the burn cursor', async () => {
    let fold:
      | { message: `0x${string}`; attestation: `0x${string}`; clearMintCursor: () => void }
      | undefined;

    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      deferMint: true,
      onMintFold: (f) => {
        fold = f;
      },
    });

    // The burn still happened (approve + depositForBurn), and attestation was polled.
    expect(writeContract.mock.calls.some((c) => c[0].functionName === 'depositForBurn')).toBe(true);
    expect(waitForAttestation).toHaveBeenCalledTimes(1);

    // The standalone Starknet mint (manager receive_message) was NOT submitted — the
    // mint is deferred into the caller's deposit tx.
    expect(managerExecute).not.toHaveBeenCalled();

    // onMintFold fired with the attested bytes.
    expect(fold).toBeDefined();
    expect(fold!.attestation).toBe(ATTESTATION);
    expect(fold!.message).toBe(attestedMessage.value);

    // Standard finality (maxFee 0) → net == gross.
    expect(net).toBe(AMOUNT);

    // The in-flight burn cursor is PRESERVED (not cleared) until the deposit lands.
    const map = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeDefined();

    // clearMintCursor is what actually drops it (the caller invokes it post-deposit).
    fold!.clearMintCursor();
    const after = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(after[EVM_ADDRESS.toLowerCase()]).toBeUndefined();
  });

  // Bug1 (mainnet blocker): the deposit approve + pool pull must be sized to what CCTP
  // ACTUALLY mints (burn − feeExecuted, read from the attested body), NOT the pre-submit
  // maxFee estimate. On mainnet Fast the fee is nonzero — and a Fast-requested/
  // Standard-executed tier mismatch makes maxFee (0 for the requested Standard fallback,
  // or a stale Fast quote) ≠ the fee CCTP deducted — so sizing the atomic fold to the
  // gross burn over-states the minted balance → apply_action reverts. RED before the fix
  // (returns the gross AMOUNT via the maxFee-0 estimate); GREEN after (AMOUNT − feeExecuted).
  it('deferMint: sizes the deposit to burn − feeExecuted (from the attested message), NOT the gross burn', async () => {
    const FEE = 14_000n; // ~14 bps mainnet-style Fast fee on 1 USDC
    // A FULL message carrying a NONZERO feeExecuted. Standard finality (fast omitted) →
    // maxFee 0 → the pre-fix net estimate is the GROSS burn (AMOUNT).
    attestedMessage.value = buildFullCctpMessage({
      sourceDomain: AMOY.domain,
      destinationDomain: config.cctp.starknetDomain,
      recipientField64: SN_RECIPIENT_FIELD64,
      amount: AMOUNT,
      feeExecuted: FEE,
    });

    let fold:
      | { message: `0x${string}`; attestation: `0x${string}`; clearMintCursor: () => void }
      | undefined;
    const net = await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      deferMint: true,
      onMintFold: (f) => {
        fold = f;
      },
    });

    // The mint was deferred (folded), so onMintFold fired with the attested bytes.
    expect(fold).toBeDefined();
    expect(fold!.message).toBe(attestedMessage.value);
    // The value the caller sizes the approve + pool pull to = the ACTUAL minted amount.
    expect(net).toBe(AMOUNT - FEE);
    // …and NOT the gross burn (the pre-fix maxFee-estimate behavior on a 0 maxFee).
    expect(net).not.toBe(AMOUNT);
  });

  it('deferMint omitted (default) → submits the standalone mint (unchanged 2-tx flow)', async () => {
    let folded = false;
    await fundFromMetaMask({
      evmAddress: EVM_ADDRESS,
      snRecipient: SN_RECIPIENT,
      provider: ethProvider,
      amountWei: AMOUNT,
      onMintFold: () => {
        folded = true;
      },
    });

    // The standalone mint ran; no fold.
    expect(managerExecute).toHaveBeenCalledTimes(1);
    expect(managerExecute.mock.calls[0][1].entrypoint).toBe('receive_message');
    expect(folded).toBe(false);
    // Cursor cleared after a successful standalone mint.
    const map = JSON.parse(localStorage.getItem(INFLIGHT_DEPOSIT_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(map[EVM_ADDRESS.toLowerCase()]).toBeUndefined();
  });
});

// The fold-resume convergence (moveIntoPool, issue #432) gates on this classifier, so its
// match must be tight: it MUST catch the CCTP transmitter's "Nonce already used" revert and
// MUST NOT collide with Starknet ACCOUNT-nonce errors (which would wrongly converge a
// genuinely-failed deposit → silent fund loss).
describe('isNonceAlreadyUsedError', () => {
  it('matches the AVNU code-156 folded-multicall revert', () => {
    expect(
      isNonceAlreadyUsedError(
        new Error(
          "AVNU paymaster paymaster_executeTransaction error (code 156): " +
            "'argent/multicall-failed', 'Nonce already used', 'ENTRYPOINT_FAILED'",
        ),
      ),
    ).toBe(true);
    // Case-insensitive + accepts a bare string (not only Error).
    expect(isNonceAlreadyUsedError('nonce already used')).toBe(true);
  });

  it('does NOT match Starknet account-nonce errors (no false convergence)', () => {
    for (const msg of [
      'Invalid transaction nonce',
      'nonce too low',
      'nonce too old',
      'nonce too big',
      'account: invalid tx nonce',
      'apply_actions reverted on-chain',
    ]) {
      expect(isNonceAlreadyUsedError(new Error(msg))).toBe(false);
    }
  });
});
