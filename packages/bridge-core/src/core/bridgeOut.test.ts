// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract test for bridgeOut() — the one-click BUY steps 1-2 pool tx:
//   ONE signed apply_actions = Withdraw{recipient = OutboundAnonymizer, amount = D}
//   then ONE InvokeExternal -> OutboundAnonymizer.privacy_invoke(BuyParams{
//   mint_recipient, amount, max_fee, min_finality_threshold, destination_domain}).
//
// Expectations are derived from the interface (docs/bridge-interface.md
// §1, §2, §4), NOT from the implementation:
//   - withdraw recipient = the Anonymizer, amount = the fixed denomination D;
//   - the single InvokeExternal targets the Anonymizer and its calldata encodes
//       privacy_invoke(params: BuyParams), which serialises FLAT as
//       [mint_recipient:u256, amount:u256, max_fee:u256,
//        min_finality_threshold:u32, destination_domain:u32]  (8 felts, no enum
//        discriminant, NO commitment_h — the per-account H is no longer emitted
//        on-chain at burn time; destination_domain is the CCTP domain of the chosen
//        bridge-OUT chain, appended as the LAST felt)
//     with mint_recipient = the EOA's DEPOSIT WALLET (20-byte EVM addr left-padded
//     to 32 bytes as u256), amount = D, domain semantics;
//   - bridgeOut still RETURNS { burnTxHash, mintRecipient = deposit wallet,
//     eoaAddress = the owning EOA, commitmentH = H } — H is consumed by the M10
//     return leg, just not carried in the burn calldata.
//
// Every boundary is mocked: the SDK builder/factory, the RPC provider + account,
// proving/tx helpers, and the shared key-derivation + H utils. The derive/H
// utils are stubbed to deterministic fixtures so the test pins HOW bridgeOut
// wires them into the calldata, independent of the real Poseidon recipe (that
// recipe is the Cairo==TS oracle, asserted separately in
// packages/bridge-core/src/derivation/claim-commitment.test.ts).

// ---------------------------------------------------------------------------
// Fixtures (pure — no real keys). These stand in for the shared derive/H utils'
// outputs so we can assert exactly where bridgeOut threads each value.
// ---------------------------------------------------------------------------
const SIGNATURE = '0xsig';
const ACCOUNT_INDEX = 3;
const ACCOUNT_NONCE = 42n;
const AMOUNT = 1_000_000n; // fixed denomination D: 1 USDC @ 6dp

// A full-node-lag ValidationFailure: "block hash mismatch" + a ZERO "stored block hash"
// (matches proving.ts NODE_LAG_RE — the retryable, pre-broadcast code-156). Distinct from
// the NON-retryable code-156 (NON_ZERO_VALUE / burn-limit) that stays fail-closed above.
const NODE_LAG_MSG =
  'AVNU paymaster paymaster_executeTransaction error (code 156): ValidationFailure: ' +
  '"Invalid proof facts: Block hash mismatch for block 11830268. Proof block hash: 2599, ' +
  'stored block hash: 0."';

const VIEWING_KEY = 123456789n;
const CLAIM_SECRET = 2069452701457285857209401669498930313539255917194012082327558716626330726443n;
// Frozen §3 commitment H (note_binding bound to claim_secret). Used as the
// mocked computeClaimH return so these wiring tests pin HOW bridgeOut threads H
// into the calldata; the REAL recipe is exercised by the integration test below
// and by packages/bridge-core/src/derivation/claim-commitment.test.ts.
const COMMITMENT_H =
  1184640639497699140437908751684073211882192473677451888065106092277727692916n;

// Per-account Polygon EOA fixture. The address is a real 20-byte EVM hex; its u256
// form is the address left-padded to 32 bytes (= the numeric value of the addr).
const EOA_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EOA_PRIVATE_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const EOA_U256 = BigInt(EOA_ADDRESS); // numeric value of the bare EOA address

// The EOA's CREATE2 deposit wallet — the CCTP mint recipient (the EOA owns it +
// signs its orders). Distinct from EOA_ADDRESS so the assertions prove the burn
// targets the WALLET, not the bare EOA. Its u256 form is the addr left-padded.
const DEPOSIT_WALLET = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const DEPOSIT_WALLET_U256 = BigInt(DEPOSIT_WALLET); // numeric value of the addr

const ANONYMIZER = '0xANON';
const POOL_ADDRESS = '0x1'; // matches vitest.config.ts VITE_PRIVACY_POOL_ADDRESS

const BURN_TX_HASH = '0xburn';

// ---------------------------------------------------------------------------
// Mock: shared key-derivation + H utils. bridgeOut must recover the viewing key
// + per-account EOA from the signature and compute H from (claimSecret, amount,
// snDomain) — note_binding is bound to claim_secret, NOT a separate channel_key.
//
// vi.hoisted runs the spy declarations before the hoisted vi.mock factories so
// the factories can safely close over them (mirrors polygonMint.test.ts) — a
// plain top-level `const` would be in the temporal dead zone when the hoisted
// factory runs.
// ---------------------------------------------------------------------------
interface ClaimHArgs {
  claimSecret: bigint;
  amount: bigint;
  snDomain: bigint;
}

const {
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  derivePolygonEoa,
  deriveClaimSecret,
  computeClaimH,
  createPrivateTransfers,
  transfers,
  account,
  execute,
  discoverPrivateBalance,
} = vi.hoisted(() => {
  const execute = vi.fn(async () => ({ transaction_hash: '0xburn' }));
  const transfers = {
    build: vi.fn(),
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: {
        call: { contractAddress: '0xANON', calldata: [] },
        proof: { data: [], proofFacts: [] },
      },
    })),
    invalidateProofNonceCache: vi.fn(),
  };
  return {
    // bridgeOut re-derives the SN account from the signature; the address/key
    // only flow through the mocked makeAccount, so deterministic stubs suffice.
    deriveStarknetPrivateKey: vi.fn((_signature: string): string => '0xsnpk'),
    deriveStarknetAccount: vi.fn((_privateKey: string, _classHash: string) => ({
      address: '0xacct',
      publicKey: '0xpub',
    })),
    deriveViewingKey: vi.fn((_signature: string): bigint => 123456789n),
    derivePolygonEoa: vi.fn((_signature: string, _bidIndex: number) => ({
      privateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    })),
    deriveClaimSecret: vi.fn(
      (_viewingKey: bigint, _bidNonce: bigint): bigint =>
        2069452701457285857209401669498930313539255917194012082327558716626330726443n,
    ),
    computeClaimH: vi.fn(
      (_args: ClaimHArgs): bigint =>
        1184640639497699140437908751684073211882192473677451888065106092277727692916n,
    ),
    createPrivateTransfers: vi.fn(() => transfers),
    transfers,
    // getNonce: the manager-nonce manager reads it ONCE to seed its local counter on
    // the first manager submit (the fee-approve / proven withdraw+burn). makeAccount
    // resolves both the user and the manager to this stub, so it must expose it.
    account: { address: '0xacct', execute, getNonce: vi.fn(async () => '0x0') },
    execute,
    // Fee-buffer gate reads the in-pool balance; default AMPLE so the existing
    // happy-path tests clear the gate. Gate tests override with mockResolvedValueOnce.
    discoverPrivateBalance: vi.fn(async (): Promise<bigint> => 1_000_000_000n), // 1000 USDC
  };
});

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  derivePolygonEoa,
  deriveClaimSecret,
  computeClaimH,
}));

// ---------------------------------------------------------------------------
// Mock: SDK. The builder is a fluent recorder — each terminal records the args
// bridgeOut passed, and .invoke() captures the callback so we can run it with a
// realistic context ({ poolAddress }) and inspect the returned InvokeExternal.
// ---------------------------------------------------------------------------
let withdrawArgs: { recipient: string; amount: bigint } | undefined;
const withdrawCalls: { recipient: string; amount: bigint }[] = [];
let invokeCallback: ((ctx: { poolAddress: string }) => { contractAddress: string; calldata: unknown[] }) | undefined;
let invokeResult: { contractAddress: string; calldata: unknown[] } | undefined;
let surplusToArg: string | undefined;
const withTokens: string[] = [];

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn((token: string, fn?: (t: typeof builder) => unknown) => {
    withTokens.push(token);
    if (fn) {
      fn(builder);
      return builder;
    }
    return builder;
  });
  builder.inputs = vi.fn(() => builder);
  builder.withdraw = vi.fn((a: { recipient: string; amount: bigint }) => {
    withdrawArgs = a;
    withdrawCalls.push(a);
    return builder;
  });
  builder.surplusTo = vi.fn((a: string) => {
    surplusToArg = a;
    return builder;
  });
  builder.invoke = vi.fn(
    (cb: (ctx: { poolAddress: string }) => { contractAddress: string; calldata: unknown[] }) => {
      invokeCallback = cb;
      invokeResult = cb({ poolAddress: POOL_ADDRESS });
      return builder;
    },
  );
  builder.done = vi.fn(() => builder);
  // Proving + submit surface (mirrors deposit.ts).
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers,
  IndexerDiscoveryProvider: class {},
}));

// Stub for the injected deposit-wallet resolver (no longer a module mock — bridgeOut
// now accepts resolveDepositWallet as a parameter). Returns DEPOSIT_WALLET so the
// test pins that the burn targets the WALLET, not the bare EOA.
const resolveDepositWallet = vi.fn(async (_signature: string, _bidIndex: number): Promise<string> =>
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
);

// ---------------------------------------------------------------------------
// Mock: provider / account / proving / tx. bridgeOut submits the proven call
// through account.execute and tracks it; submitAndTrack yields the burn tx hash.
// (account/execute are hoisted above so the ./provider factory can close over
// them.)
// ---------------------------------------------------------------------------
vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn() }),
  makeAccount: () => account,
}));

// Hoisted spies so a test can assert the proving ANCHOR proveAndSubmitBridgeOut hands
// to waitForProvingBlock. getCurrentBlock returns a distinctive head (7) so the anchor-
// seeding fix (undefined → head) is unambiguous vs a real dependency block.
const { waitForProvingBlockSpy, getCurrentBlockSpy } = vi.hoisted(() => ({
  waitForProvingBlockSpy: vi.fn(async () => 'block-1'),
  getCurrentBlockSpy: vi.fn(async () => 7),
}));
vi.mock('./proving', () => ({
  waitForProvingBlock: waitForProvingBlockSpy,
  getCurrentBlock: getCurrentBlockSpy,
  // Real values — proveAndSubmitBridgeOut imports both. Mirror proving.ts so the depth arg
  // the test asserts is meaningful and immediateBase = getCurrentBlock(7) − 12 → max(…,0) = 0.
  PROVING_BLOCK_DEPTH: 8,
  IMMEDIATE_PROVING_BLOCK_DEPTH: 12,
  // Real regex (proving.ts NODE_LAG_RE): a full-node-lag ValidationFailure with a ZERO
  // stored base-block hash. The proven-submit node-lag retry (nodeLagRetry.ts) gates on it.
  isNodeLagError: (err: unknown) =>
    /block hash mismatch[\s\S]*?stored block hash:\s*(?:0x)?0+\b/i.test(
      err instanceof Error ? err.message : String(err),
    ),
  // Instant sleep so the bounded node-lag retry loop runs without wall-clock delay.
  sleep: () => Promise.resolve(),
}));

// Discovery-at-block helper (the prove-early quiescence gate). Hoisted spy so each
// test controls the note-id sets returned at `immediateBase` vs head. Default:
// IDENTICAL sets at both blocks ⇒ quiescent ⇒ the immediate path fires (keeps the
// existing prove-early tests green). Per-test overrides key on args.blockIdentifier
// (numeric immediateBase vs the 'pre_confirmed' head) to model an in-window add/spend.
const { discoverNoteIdsAtBlockSpy } = vi.hoisted(() => ({
  discoverNoteIdsAtBlockSpy: vi.fn(async (_args: { blockIdentifier: unknown }): Promise<string[]> => ['1', '2']),
}));
// Single ./discover mock (merged): origin's prove-early note-id spy + our
// fee-buffer balance reader. importOriginal keeps formatUsdcCents/formatTokenAmount
// real (deposit.ts, in this graph, imports formatUsdcCents from here).
vi.mock('./discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./discover')>()),
  discoverNoteIdsAtBlock: discoverNoteIdsAtBlockSpy,
  discoverPrivateBalance,
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: vi.fn(async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
    const r = await send();
    return { transactionHash: r.transaction_hash, blockNumber: 1 };
  }),
  // Real regex (dedupe sweep moved this into tx.ts): proveAndSubmitBridgeOut's retry
  // guard classifies REVERTED/REJECTED via this predicate.
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

// Anonymizer address comes from config; override the env default to a fixture.
// The override values are inlined (not the top-level ANONYMIZER/POOL_ADDRESS
// consts) because this factory is hoisted above their declarations — they would
// be in the temporal dead zone. They must stay in sync with those fixtures.
vi.mock('./config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  // Pass the REAL module through (…resolveEvmCctpDestination etc. resolve the live
  // destination registry) and override only the two address fixtures on `config`.
  return {
    ...actual,
    config: {
      ...actual.config,
      anonymizerAddress: '0xANON',
      poolAddress: '0x1',
    },
  };
});

// AVNU client mock so the REAL proven-submit (paymasterBuildLeg/paymasterExecuteLeg)
// runs without network. buildTransaction returns a non-zero fee_action in the deposit
// token; executeTransaction returns the burn hash.
const { avnuBuild, avnuExecute } = vi.hoisted(() => ({
  avnuBuild: vi.fn(),
  avnuExecute: vi.fn(),
}));
vi.mock('./avnuPaymaster', () => ({
  buildTransaction: avnuBuild,
  executeTransaction: avnuExecute,
  toAvnuCall: (c: { contractAddress: string; entrypoint: string; calldata?: string[] }) => ({
    to: c.contractAddress,
    selector: c.entrypoint,
    calldata: (c.calldata ?? []).map(String),
  }),
}));

import { bridgeOut, bridgeOutToWallet, RETURN_FEE_BUFFER_WEI } from './bridgeOut';
import { config } from './config';
import { isTransientError } from './errors';
import { invalidateManagerNonce } from './proven-submit';
import { submitAndTrack } from './tx';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level manager-nonce counter so each test seeds fresh.
  invalidateManagerNonce();
  withdrawArgs = undefined;
  withdrawCalls.length = 0;
  invokeCallback = undefined;
  invokeResult = undefined;
  surplusToArg = undefined;
  withTokens.length = 0;
  // build() returns a fresh fluent recorder each call (cleared above).
  transfers.build.mockImplementation(() => makeBuilder());
  transfers.executeWithInvocation.mockResolvedValue({
    callAndProof: {
      call: { contractAddress: ANONYMIZER, calldata: [] },
      proof: { data: [], proofFacts: [] },
    },
  });
  execute.mockResolvedValue({ transaction_hash: BURN_TX_HASH });
  deriveViewingKey.mockReturnValue(VIEWING_KEY);
  derivePolygonEoa.mockReturnValue({ privateKey: EOA_PRIVATE_KEY, address: EOA_ADDRESS });
  deriveClaimSecret.mockReturnValue(CLAIM_SECRET);
  computeClaimH.mockReturnValue(COMMITMENT_H);
  // Default the quiescence gate to QUIESCENT (identical id-sets at both blocks) so
  // any flag-ON test that doesn't opt out takes the immediate path. clearAllMocks
  // above clears call history but not the implementation, so reset it explicitly.
  discoverNoteIdsAtBlockSpy.mockReset();
  discoverNoteIdsAtBlockSpy.mockResolvedValue(['1', '2']);
});

// felt252 / u256 decoding helpers — calldata entries may be bigint or 0x/decimal
// strings; normalise to bigint for value comparisons.
function asBig(x: unknown): bigint {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(x);
  if (typeof x === 'string') return BigInt(x);
  throw new Error(`not a felt-ish value: ${String(x)}`);
}

describe('bridgeOut — fee-buffer gate (Phase 3)', () => {
  const bid = () =>
    bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

  it('rejects a withdraw that would leave less than the fee-buffer', async () => {
    // balance exactly covers the bid but leaves nothing for the return fee.
    discoverPrivateBalance.mockResolvedValueOnce(AMOUNT);
    await expect(bid()).rejects.toThrow(/fee-buffer/i);
  });

  it('rejects one wei short of amount + buffer', async () => {
    discoverPrivateBalance.mockResolvedValueOnce(AMOUNT + RETURN_FEE_BUFFER_WEI - 1n);
    await expect(bid()).rejects.toThrow(/fee-buffer/i);
  });

  it('fails closed BEFORE any on-chain work (no proof built, no submit)', async () => {
    discoverPrivateBalance.mockResolvedValueOnce(AMOUNT);
    await expect(bid()).rejects.toThrow();
    expect(transfers.build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('surfaces the max spendable amount in the error', async () => {
    discoverPrivateBalance.mockResolvedValueOnce(AMOUNT); // 1 USDC; max = 1 - 0.20 = 0.80
    await expect(bid()).rejects.toThrow(/bridge at most 0\.8 USDC/);
  });

  it('allows a withdraw that leaves exactly the fee-buffer', async () => {
    discoverPrivateBalance.mockResolvedValueOnce(AMOUNT + RETURN_FEE_BUFFER_WEI);
    const res = await bid();
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
  });
});

describe('bridgeOut — withdraw + InvokeExternal shape (frozen interface)', () => {
  it('derives the per-account EOA from the signature + accountIndex', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(derivePolygonEoa).toHaveBeenCalledWith(SIGNATURE, ACCOUNT_INDEX, undefined);
  });

  it('withdraws the fixed denomination D to the Anonymizer (pool runs Withdraw first)', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(withdrawArgs).toBeDefined();
    expect(withdrawArgs!.recipient).toBe(ANONYMIZER);
    expect(withdrawArgs!.amount).toBe(AMOUNT);
  });

  it('emits exactly ONE InvokeExternal, targeting the Anonymizer', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(invokeCallback).toBeDefined();
    expect(invokeResult).toBeDefined();
    expect(invokeResult!.contractAddress).toBe(ANONYMIZER);
  });

  it('encodes privacy_invoke(BuyParams) calldata (flat, no discriminant): mint_recipient(u256)=deposit wallet, amount(u256)=D, max_fee(u256), finality(u32)', async () => {
    await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      minFinalityThreshold: 2000,
      maxFee: 0n,
      resolveDepositWallet,
    });
    const cd = invokeResult!.calldata;

    // privacy_invoke(params: BuyParams) serialises FLAT (no enum discriminant) as
    // [mint_recipient(u256), amount(u256), max_fee(u256),
    //  min_finality_threshold(u32), destination_domain(u32)]; u256 = [low, high], so:
    //   [mr_lo, mr_hi, amt_lo, amt_hi, fee_lo, fee_hi, finality, destination_domain] (8 felts)
    // NO commitment_h — the per-account H is no longer emitted on-chain at burn time.
    expect(cd).toHaveLength(8);

    const u256 = (lo: unknown, hi: unknown) => asBig(lo) + (asBig(hi) << 128n);

    // mint_recipient = the EOA's deposit wallet (20-byte addr left-padded to u256),
    // NOT the bare EOA — funds land where the order signs.
    expect(u256(cd[0], cd[1])).toBe(DEPOSIT_WALLET_U256);
    // amount = the fixed denomination D (burn amount == withdraw amount).
    expect(u256(cd[2], cd[3])).toBe(AMOUNT);
    // max_fee = 0 for Standard.
    expect(u256(cd[4], cd[5])).toBe(0n);
    // min_finality_threshold = 2000 (Standard).
    expect(asBig(cd[6])).toBe(2000n);
    // destination_domain (LAST felt) = the default destination's CCTP domain (Polygon = 7).
    expect(asBig(cd[7])).toBe(7n);
  });

  it('appends the CHOSEN destination CCTP domain as the LAST Buy felt (Polygon 7 AND Base 6)', async () => {
    // Default (no destChainId) → Polygon domain 7.
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(invokeResult!.calldata).toHaveLength(8);
    expect(asBig(invokeResult!.calldata[7])).toBe(7n);

    // Base (chainId 8453 mainnet / 84532 testnet, domain 6) → last felt 6.
    const baseChainId = config.network === 'mainnet' ? 8453 : 84532;
    await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      destChainId: baseChainId,
      resolveDepositWallet,
    });
    expect(invokeResult!.calldata).toHaveLength(8);
    expect(asBig(invokeResult!.calldata[7])).toBe(6n);
  });

  it('rejects an unsupported destination chain id (fails loud, never bridges to a wrong chain)', async () => {
    await expect(
      bridgeOut({
        signature: SIGNATURE,
        accountIndex: ACCOUNT_INDEX,
        accountNonce: ACCOUNT_NONCE,
        amount: AMOUNT,
        destChainId: 999999,
        resolveDepositWallet,
      }),
    ).rejects.toThrow(/Unsupported bridge-out destination chain 999999/);
  });

  it('defaults to Standard finality (2000) and zero fee when unset', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    const cd = invokeResult!.calldata;
    const u256 = (lo: unknown, hi: unknown) => asBig(lo) + (asBig(hi) << 128n);
    expect(u256(cd[4], cd[5])).toBe(0n); // max_fee default 0
    expect(asBig(cd[6])).toBe(2000n); // finality default Standard
  });

  it('computes H over claim_secret + amount + sn_domain(25), bound to claim_secret (no channel_key)', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    // claim_secret = deriveClaimSecret(viewingKey, accountNonce)
    expect(deriveClaimSecret).toHaveBeenCalledWith(VIEWING_KEY, ACCOUNT_NONCE);
    // H bound to the SAME claim_secret, amount D, and sn_domain = 25.
    expect(computeClaimH).toHaveBeenCalledTimes(1);
    const hArgs = computeClaimH.mock.calls[0][0];
    expect(hArgs.claimSecret).toBe(CLAIM_SECRET);
    expect(hArgs.amount).toBe(AMOUNT);
    expect(hArgs.snDomain).toBe(25n);
    // note_binding is bound to claim_secret on-chain (the frozen claim signature
    // carries no channel_key), so bridgeOut must NOT pass a separate channelKey
    // — passing one would record an H the Cairo claim could never recompute.
    expect('channelKey' in hArgs).toBe(false);
  });

  it('returns the burn tx hash, the deposit wallet as mint recipient, the owning EOA, and the commitment H', async () => {
    const res = await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      resolveDepositWallet,
    });
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(res.mintRecipient).toBe(DEPOSIT_WALLET);
    expect(res.eoaAddress).toBe(EOA_ADDRESS);
    expect(res.commitmentH).toBe(COMMITMENT_H);
  });

  it('returns change to the submitter account as a private note (surplusTo)', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(surplusToArg).toBe(account.address);
  });

  it('produces the frozen §3 commitment H end-to-end via the REAL deriveClaimSecret + computeClaimH (returned, not in calldata)', async () => {
    // The vacuous-mock gap: the suite above mocks computeClaimH to a constant, so
    // it can't catch bridgeOut feeding the wrong note_binding source. Here we run
    // the REAL shared recipe for the §3 fixtures (VK=123456789, account_nonce=42,
    // amount=1e6, sn_domain=25) and assert the H bridgeOut RETURNS equals the
    // frozen vector — the same number the Cairo claim recomputes. H is no longer
    // carried in the burn calldata (the burn no longer emits it), but it is still
    // produced + returned for the M10 return leg, which makes that leg reproducible.
    const actual = await vi.importActual<typeof import('../derivation/index')>(
      '../derivation/index',
    );
    const FROZEN_H =
      1184640639497699140437908751684073211882192473677451888065106092277727692916n;

    deriveViewingKey.mockReturnValueOnce(VIEWING_KEY);
    deriveClaimSecret.mockImplementationOnce(actual.deriveClaimSecret);
    computeClaimH.mockImplementationOnce(actual.computeClaimH);

    const res = await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE, // 42n — the frozen §3 account_nonce
      amount: AMOUNT, // 1e6 — the frozen §3 amount
      resolveDepositWallet,
    });

    // H is the value bridgeOut returns for the return leg (NOT a calldata felt).
    expect(res.commitmentH).toBe(FROZEN_H);
    // And the real computeClaimH was called with NO channel_key (bound to claim_secret).
    const hArgs = computeClaimH.mock.calls[0][0];
    expect('channelKey' in hArgs).toBe(false);
  });

  it('never logs/persists the EOA private key or the claim_secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => String(a))
      .join('\n');
    expect(logged).not.toContain(EOA_PRIVATE_KEY);
    expect(logged).not.toContain(CLAIM_SECRET.toString());
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Leg B: bridgeOutToWallet() — cash out from the pool to a USER-chosen Polygon
// destination. SAME withdraw + privacy_invoke(Buy) shape as bridgeOut(), but:
//   - mint_recipient = the destination address (no per-account EOA);
//   - NO per-account commitment H (a cash-out has no return claim, and the burn no
//     longer emits any H at all — bridge-plan.md, threat-model.md).
// Reuses the same SDK/provider/proving/tx + manager-paid submit mocks as above.
// ---------------------------------------------------------------------------
// A distinct user destination address (20-byte EVM hex), != the per-account EOA.
const DEST_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const DEST_U256 = BigInt(DEST_ADDRESS); // numeric value of the 20-byte address

describe('bridgeOutToWallet — Leg B cash-out (withdraw + decoy-H burn)', () => {
  it('withdraws the amount to the Anonymizer (pool runs Withdraw first)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(withdrawArgs).toBeDefined();
    expect(withdrawArgs!.recipient).toBe(ANONYMIZER);
    expect(withdrawArgs!.amount).toBe(AMOUNT);
  });

  it('emits exactly ONE InvokeExternal, targeting the Anonymizer', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(invokeCallback).toBeDefined();
    expect(invokeResult).toBeDefined();
    expect(invokeResult!.contractAddress).toBe(ANONYMIZER);
  });

  it('encodes privacy_invoke(BuyParams) flat (no discriminant), mint_recipient(u256) = the USER destination, amount(u256) = the burn amount', async () => {
    await bridgeOutToWallet({
      signature: SIGNATURE,
      amount: AMOUNT,
      destination: DEST_ADDRESS,
      minFinalityThreshold: 2000,
      maxFee: 0n,
    });
    const cd = invokeResult!.calldata;
    // [mr_lo, mr_hi, amt_lo, amt_hi, fee_lo, fee_hi, finality, destination_domain] (8 felts).
    // Same BUY shape as bridgeOut; flat BuyParams, NO commitment_h (no decoy, no H emitted).
    expect(cd).toHaveLength(8);
    const u256 = (lo: unknown, hi: unknown) => asBig(lo) + (asBig(hi) << 128n);
    // mint_recipient = the destination address (no per-account EOA), NOT the account EOA.
    expect(u256(cd[0], cd[1])).toBe(DEST_U256);
    expect(u256(cd[0], cd[1])).not.toBe(EOA_U256);
    // amount = the burn amount (== withdraw amount).
    expect(u256(cd[2], cd[3])).toBe(AMOUNT);
    // max_fee = 0, finality = 2000 (same Polygon burn semantics as bridgeOut).
    expect(u256(cd[4], cd[5])).toBe(0n);
    expect(asBig(cd[6])).toBe(2000n);
    // destination_domain (LAST felt) = the default destination's CCTP domain (Polygon = 7).
    expect(asBig(cd[7])).toBe(7n);
  });

  it('appends the CHOSEN destination CCTP domain as the LAST Buy felt (Polygon 7 AND Base 6)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(invokeResult!.calldata).toHaveLength(8);
    expect(asBig(invokeResult!.calldata[7])).toBe(7n);

    const baseChainId = config.network === 'mainnet' ? 8453 : 84532;
    await bridgeOutToWallet({
      signature: SIGNATURE,
      amount: AMOUNT,
      destination: DEST_ADDRESS,
      destChainId: baseChainId,
    });
    expect(invokeResult!.calldata).toHaveLength(8);
    expect(asBig(invokeResult!.calldata[7])).toBe(6n);
  });

  it('defaults to Standard finality (2000) and zero fee when unset (same Polygon burn as bridgeOut)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    const cd = invokeResult!.calldata;
    const u256 = (lo: unknown, hi: unknown) => asBig(lo) + (asBig(hi) << 128n);
    expect(u256(cd[4], cd[5])).toBe(0n); // max_fee default 0
    expect(asBig(cd[6])).toBe(2000n); // finality default Standard
  });

  it('records NO per-account commitment H for a cash-out (no return claim; burn no longer emits H)', async () => {
    // The cash-out has no return claim, so it must not compute or record an account H —
    // and the burn no longer emits any H at all (bridge-plan.md, threat-model.md).
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    // The BUY calldata is exactly 8 felts: no trailing H slot.
    expect(invokeResult!.calldata).toHaveLength(8);
    // And it never calls computeClaimH (no per-account commitment for a cash-out).
    expect(computeClaimH).not.toHaveBeenCalled();
  });

  it('is manager-paid via the shared proven-submit path (submitProvenCall -> account.execute)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    // The manager-paid submit routes the proven call through account.execute (the
    // same mock the BUY tests assert) — proving the cash-out reuses the shared
    // proveAndSubmitBridgeOut / submitProvenCall path, not a duplicate.
    expect(execute).toHaveBeenCalled();
  });

  it('returns the burn tx hash and the destination as mint recipient (no H for a cash-out)', async () => {
    const res = await bridgeOutToWallet({
      signature: SIGNATURE,
      amount: AMOUNT,
      destination: DEST_ADDRESS,
    });
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(res.mintRecipient).toBe(DEST_ADDRESS);
    // A cash-out has no return claim, so the result carries no commitment H.
    expect('commitmentH' in res).toBe(false);
  });

  it('returns change to the submitter account as a private note (surplusTo)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(surplusToArg).toBe(account.address);
  });

  it('does NOT derive a per-account Polygon EOA (no account index/nonce for a cash-out)', async () => {
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(derivePolygonEoa).not.toHaveBeenCalled();
  });
});

describe('bridgeOut — AVNU paymaster path (fee baked into the proof)', () => {
  const FORWARDER = '0xFEEFWD';
  const FEE = 148056n; // ~0.148 USDC pool fee, in the deposit token
  const realPaymaster = config.paymaster;

  beforeEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    };
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: { type: 'withdraw', recipient: FORWARDER, token: config.depositToken.address, amount: `0x${FEE.toString(16)}` },
    });
    avnuExecute.mockResolvedValue({ tracking_id: 'trk', transaction_hash: BURN_TX_HASH });
  });
  afterEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = realPaymaster;
  });

  it('bakes the pool fee in as a SECOND withdraw to the forwarder and submits via AVNU (not the manager)', async () => {
    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    // buildTransaction ran (apply_action) BEFORE proving to learn the fee.
    expect(avnuBuild).toHaveBeenCalledOnce();
    expect(avnuBuild.mock.calls[0]![0].transaction.type).toBe('apply_action');
    // Two withdraws: the account amount to the Anonymizer + the pool fee to the forwarder.
    expect(withdrawCalls).toEqual([
      { recipient: ANONYMIZER, amount: AMOUNT },
      { recipient: FORWARDER, amount: FEE },
    ]);
    // AVNU's relayer submitted the proven leg; the manager account.execute was NOT used.
    expect(avnuExecute).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
  });

  // A from-pool withdraw PROVES BY SPENDING A PRE-EXISTING POOL NOTE, and that note can be
  // from THIS session (Move Into Pool → Move From Pool within a few blocks) — i.e. the account
  // is NOT quiescent, so the (now-unconditional) prove-early probe must decline the immediate
  // path and age. The paymaster path has NO manager fee-approve tx to seed a proving anchor
  // from (the fee is baked into the proof), so it MUST seed from the CURRENT HEAD and age
  // PROVING_BLOCK_DEPTH past it — otherwise the proof's base block can predate the fresh
  // deposit's commitment and the pool `apply_actions` reverts on-chain. This asserts the anchor
  // is DEFINED (= head 7 from the getCurrentBlock spy), not `undefined`, and the depth is the
  // aging PROVING_BLOCK_DEPTH (8), not IMMEDIATE (12). RED before this fix (anchor was
  // undefined, depth 12).
  it('ages the withdraw proof from the CURRENT HEAD (anchor defined + PROVING_BLOCK_DEPTH) — a same-session deposited note must be buried', async () => {
    // Force non-quiescence (the fresh same-session note is visible at head but not yet at
    // immediateBase) so the probe declines prove-early and this test actually exercises aging.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2'] : ['1'],
    );
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });
    expect(waitForProvingBlockSpy).toHaveBeenCalled();
    const lastCall = waitForProvingBlockSpy.mock.calls.at(-1)!;
    // No fee-approve tx → the anchor is seeded from the live head (getCurrentBlock spy = 7).
    expect(getCurrentBlockSpy).toHaveBeenCalled();
    expect(lastCall[1]).toBe(7);
    // Normal aging depth (8), NOT the removed IMMEDIATE depth (12).
    expect(lastCall[3]).toBe(8);
  });

  it('throws if the AVNU fee token is not the deposit token', async () => {
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: { type: 'withdraw', recipient: FORWARDER, token: '0xdeadbeef', amount: `0x${FEE.toString(16)}` },
    });
    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/not the deposit token/i);
    expect(avnuExecute).not.toHaveBeenCalled();
  });

  // BUG 2 (double-burn class), live-observed 2026-07-03 (live-qa-avnu/stage4-result.json):
  // AVNU `paymaster_executeTransaction` returned JSON-RPC error 156 ("Burn amount exceeds
  // limit"), yet the relayer had ALREADY broadcast the withdraw+burn and it landed on-chain
  // (the error was spurious simulation noise). onRelayStart fires synchronously right before
  // executeTransaction, so once it fires the burn is potentially IN-FLIGHT. The shipped
  // proveAndSubmitBridgeOut catch has no post-relay guard: burnTxHash stays '' when execute
  // THROWS, so it invalidates the proof cache and re-proves over the SAME notes — a SECOND
  // pool withdrawal / CCTP burn, saved only by pool nullifiers. Fix mirrors deposit.ts's
  // `paymasterSubmissionStarted` guard: fail closed, never re-submit once the relay is
  // in-flight WITH NO HASH OBTAINED (the refined rule — see the (b)/(c)/(d) tests below).
  it('does NOT re-submit after the AVNU relay is in-flight — a paymaster execute throw is AMBIGUOUS (double-burn guard)', async () => {
    avnuExecute.mockReset();
    avnuExecute.mockRejectedValue(
      new Error('AVNU paymaster_executeTransaction error (code 156): Burn amount exceeds limit'),
    );

    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/156|burn amount exceeds limit/i);

    // The critical assertion: the AVNU relay (executeTransaction) must run EXACTLY ONCE.
    // Shipped code retries → 2 calls (double-burn). The guard fails closed at 1.
    expect(avnuExecute).toHaveBeenCalledTimes(1);
  });

  it('still RETRIES a pre-relay failure on the paymaster path (guard is post-relay only, genuinely-not-submitted still retries)', async () => {
    // A build failure happens BEFORE onRelayStart — nothing was submitted, the notes are
    // untouched, so a retry is safe. The double-burn guard must NOT block this legitimate
    // stale-nonce/proving retry.
    let buildCalls = 0;
    avnuBuild.mockReset();
    avnuBuild.mockImplementation(async () => {
      buildCalls += 1;
      if (buildCalls === 1) throw new Error('stale pool nonce (pre-relay)');
      return {
        type: 'apply_action',
        fee_action: { type: 'withdraw', recipient: FORWARDER, token: config.depositToken.address, amount: `0x${FEE.toString(16)}` },
      };
    });
    avnuExecute.mockReset();
    avnuExecute.mockResolvedValue({ tracking_id: 'trk', transaction_hash: BURN_TX_HASH });

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(avnuBuild).toHaveBeenCalledTimes(2); // first threw pre-relay; retry rebuilt
    expect(avnuExecute).toHaveBeenCalledTimes(1); // submitted exactly once, on the retry
  });

  // Bugbot refinement of the ambiguity guard: fail closed ONLY on the genuinely
  // ambiguous outcomes — (a) post-relay throw with NO hash (the test above), (b) hash
  // known but tracking status UNKNOWN (timeout). A hash tracked to terminal
  // REVERTED/REJECTED is (c) a DEFINITIVE no-burn (atomic revert, notes unspent) and
  // must keep the pre-existing one-shot rebuild retry, same as the manager path.
  it('(b) returns the landed hash WITHOUT re-submitting when the relay succeeded but tracking timed out (status unknown)', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    submitAndTrackMock.mockImplementationOnce(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        await send(); // relay succeeds → burnTxHash = BURN_TX_HASH
        throw new Error('tracking timeout');
      },
    );

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    // Fail closed on unknown status = NO re-submit; the landed hash is returned so the
    // caller persists the cursor and Iris polls it (the pre-existing C4 contract).
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(avnuExecute).toHaveBeenCalledTimes(1);
  });

  it('(c) retries ONCE after a burn tracked to terminal REVERTED — definitive no-burn, not ambiguous', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    let trackCalls = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        trackCalls += 1;
        if (trackCalls === 1) {
          // Attempt-1: the relay succeeds (hash '0xfirstreverted') but the burn MINES
          // and REVERTS — submitAndTrack reports the terminal revert (core/tx.ts wording).
          await send();
          throw new Error('Transaction REVERTED: insufficient something');
        }
        // Attempt-2 (the rebuild retry): lands cleanly.
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 2 };
      },
    );
    avnuExecute.mockReset();
    avnuExecute
      .mockResolvedValueOnce({ tracking_id: 'trk', transaction_hash: '0xfirstreverted' })
      .mockResolvedValueOnce({ tracking_id: 'trk', transaction_hash: '0xretryok' });

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    // A tracked revert moved NO value — the one-shot rebuild retry must fire (relay
    // called twice) and the retry's landed hash is the result. The over-reaching guard
    // rethrew instead (1 call, rejects) → RED.
    expect(avnuExecute).toHaveBeenCalledTimes(2);
    expect(res.burnTxHash).toBe('0xretryok');
  });

  it('(d) does NOT resurrect the REVERTED first hash when the rebuild retry then throws without a hash', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    let trackCalls = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        trackCalls += 1;
        // Attempt-1: relay succeeds ('0xfirstreverted') then tracks to terminal REVERTED.
        // Attempt-2: send() itself rejects (executeTransaction throws, NO hash) — the
        // ambiguous no-hash case, on the retry.
        await send();
        if (trackCalls === 1) throw new Error('Transaction REVERTED: it reverted');
        return { transactionHash: 'unreachable', blockNumber: 3 };
      },
    );
    avnuExecute.mockReset();
    avnuExecute
      .mockResolvedValueOnce({ tracking_id: 'trk', transaction_hash: '0xfirstreverted' })
      .mockRejectedValueOnce(new Error('AVNU paymaster_executeTransaction error (code 156): spurious'));

    // The REVERTED hash is definitively dead; the retry obtained NO hash. bridgeOut
    // must REJECT (ambiguous retry) — not resolve with the dead '0xfirstreverted' as
    // if it were a live burn (which would persist a cursor for a burn that never
    // happened and brick the account).
    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/156/);
    expect(avnuExecute).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// C4 BUG PROBE: proveAndSubmitBridgeOut retry loses the first burn tx hash.
//
// When submitAndTrack calls send() (which sets burnTxHash = '0xfirst') but then
// throws (e.g. tracking timeout), the catch calls attempt() again. The second
// attempt() has its own local `burnTxHash = ''` which gets set to '0xsecond'.
// bridgeOut returns '0xsecond' — but the real burn that landed on-chain is
// '0xfirst'. Iris will poll the wrong hash.
//
// Correct behaviour: return '0xfirst' (the first submitted burn tx hash).
// Current behaviour: return '0xsecond' → test is RED.
//
// Note: feeAmount is mocked to 0 (callContract returns undefined → 0n), so there
// is NO fee-approve submitAndTrack call. The ONLY submitAndTrack call inside
// proveAndSubmitBridgeOut is the proven burn itself.
// ---------------------------------------------------------------------------
describe('C4 — proveAndSubmitBridgeOut: retry loses first burn tx hash', () => {
  it('C4: returns the FIRST burn tx hash when submitAndTrack throws after send() succeeds', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    let burnCallCount = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        burnCallCount += 1;
        if (burnCallCount === 1) {
          // The proven burn: send() runs (setting burnTxHash inside attempt to
          // '0xfirst'), then submitAndTrack throws a timeout.
          await send(); // side-effect: sets burnTxHash = '0xfirst' inside attempt
          throw new Error('tracking timeout');
        }
        // Retry: the second attempt's submitAndTrack — succeeds with '0xsecond'.
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );

    // First execute call returns '0xfirst'; second (retry) returns '0xsecond'.
    execute
      .mockResolvedValueOnce({ transaction_hash: '0xfirst' })
      .mockResolvedValueOnce({ transaction_hash: '0xsecond' });

    const res = await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      resolveDepositWallet,
    });

    // The first submitted burn is the one that landed. Correct answer: '0xfirst'.
    // Current code returns '0xsecond' → this assertion fails (RED).
    expect(res.burnTxHash).toBe('0xfirst');
  });
});

// ---------------------------------------------------------------------------
// VP1 BUG PROBE: the RETRY's burn lands but the retry is un-guarded.
//
// The C4 fix guards the FIRST attempt (`if (burnTxHash) return burnTxHash`).
// But the retry `await attempt()` inside the catch is NOT wrapped. Trigger:
//   attempt-1 fails BEFORE send() (a proving/nonce error) → burnTxHash stays ''
//     → the first-attempt guard is false → falls through to the retry;
//   attempt-2's send() SUCCEEDS (burnTxHash = '0xretryburn') but its
//     submitAndTrack then times out → the throw escapes UN-guarded → bridgeOut
//     REJECTS even though the burn already landed on-chain.
//
// A rejecting bridgeOut means the caller never persists the resume cursor, so a
// later run re-derives the same EOA and burns AGAIN (double pool withdrawal).
//
// Correct behaviour: RESOLVE with the retry's landed hash ('0xretryburn').
// Pre-fix behaviour: rejects with 'tracking timeout' → test is RED.
// ---------------------------------------------------------------------------
describe('VP1 — proveAndSubmitBridgeOut: retry burn lands but the retry is un-guarded', () => {
  it('VP1: resolves with the RETRY burn hash when attempt-1 fails pre-send and the retry send() lands then times out', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    let burnCallCount = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        burnCallCount += 1;
        if (burnCallCount === 1) {
          // Attempt-1: a pre-send proving/nonce error — send() is NEVER called, so
          // burnTxHash stays '' and the first-attempt guard does not fire.
          throw new Error('code: 52 invalid transaction nonce');
        }
        // Attempt-2 (the retry): send() SUCCEEDS (sets burnTxHash = '0xretryburn'
        // inside attempt), then submitAndTrack times out tracking it.
        await send();
        throw new Error('tracking timeout');
      },
    );

    // The retry's submit lands '0xretryburn'. Reset first to clear any
    // mockResolvedValueOnce queue left by an earlier test in this file.
    execute.mockReset();
    execute.mockResolvedValue({ transaction_hash: '0xretryburn' });

    const res = await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      resolveDepositWallet,
    });

    // The retry burn IS in-flight on-chain — bridgeOut must return its hash, not
    // reject. Pre-fix code lets the throw escape → rejects (RED).
    expect(res.burnTxHash).toBe('0xretryburn');
  });
});

// ---------------------------------------------------------------------------
// CCTP finality-tier default follows config.cctp.fast (root-cause fix).
//
// The bug: the burn's default min_finality_threshold was a HARDCODED Standard
// (2000) while the fee quote defaulted to config.cctp.fast (TRUE on the bridge
// app). Fee quoted Fast (1000/14 bps), burn declared Standard (2000) → slow burn +
// tier mismatch. Now the default resolves via resolveFinalityThreshold() (the SAME
// function fetchForwardMaxFee uses), so CCTP_FAST=true ⇒ default 1000 for BOTH
// bridgeOut and bridgeOutToWallet. RED against the hardcoded-2000 default; GREEN now.
//
// The suite pins config.cctp.fast=false (vitest.setup), so the existing "defaults to
// Standard (2000)" tests above still hold. Here we flip fast on the MOCKED config
// snapshot (both bridgeOut.ts and cctpFees.ts import the same mocked ./config).
// ---------------------------------------------------------------------------
describe('bridgeOut finality default follows config.cctp.fast (tier-mismatch root cause)', () => {
  const realCctp = config.cctp;

  function setFast(fast: boolean): void {
    (config as unknown as { cctp: Record<string, unknown> }).cctp = { ...realCctp, fast };
  }
  afterEach(() => {
    (config as unknown as { cctp: Record<string, unknown> }).cctp = realCctp;
  });

  it('bridgeOut: CCTP_FAST=true → default min_finality_threshold is 1000 (Fast), not the hardcoded 2000', async () => {
    setFast(true);
    await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      resolveDepositWallet,
    });
    // cd[6] = min_finality_threshold (flat BuyParams). Fast tier = 1000.
    expect(asBig(invokeResult!.calldata[6])).toBe(1000n);
  });

  it('bridgeOutToWallet: CCTP_FAST=true → default min_finality_threshold is 1000 (Fast)', async () => {
    setFast(true);
    await bridgeOutToWallet({ signature: SIGNATURE, amount: AMOUNT, destination: DEST_ADDRESS });
    expect(asBig(invokeResult!.calldata[6])).toBe(1000n);
  });

  it('bridgeOut: CCTP_FAST=false → default stays 2000 (Standard) — the fee/burn agree in BOTH modes', async () => {
    setFast(false);
    await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      resolveDepositWallet,
    });
    expect(asBig(invokeResult!.calldata[6])).toBe(2000n);
  });
});

// ---------------------------------------------------------------------------
// Burn-boundary fund-safety guard: a quoted finality tier that disagrees with the
// declared burn tier must THROW before any irreversible on-chain work — the primary
// defense against a fast-quoted fee paired with a Standard burn (or vice-versa).
// The guard is checked BEFORE proving/submitting, so a mismatch must NOT build a
// proof or submit a burn.
// ---------------------------------------------------------------------------
describe('bridgeOut/bridgeOutToWallet — quotedFinalityThreshold burn-boundary guard', () => {
  it('bridgeOut THROWS on a fee/burn finality mismatch and NEVER builds/submits a burn', async () => {
    await expect(
      bridgeOut({
        signature: SIGNATURE,
        accountIndex: ACCOUNT_INDEX,
        accountNonce: ACCOUNT_NONCE,
        amount: AMOUNT,
        minFinalityThreshold: 2000, // burn declares Standard…
        quotedFinalityThreshold: 1000, // …but the fee was quoted for Fast
        resolveDepositWallet,
      }),
    ).rejects.toThrow(/finality tier mismatch|quoted for finality threshold 1000 but the burn declares 2000/i);

    // Fail-closed BEFORE any irreversible work: no proof built, no burn submitted.
    expect(transfers.build).not.toHaveBeenCalled();
    expect(submitAndTrack).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('bridgeOutToWallet THROWS on a fee/burn finality mismatch and NEVER builds/submits a burn', async () => {
    await expect(
      bridgeOutToWallet({
        signature: SIGNATURE,
        amount: AMOUNT,
        destination: DEST_ADDRESS,
        minFinalityThreshold: 1000, // burn declares Fast…
        quotedFinalityThreshold: 2000, // …but the fee was quoted for Standard
      }),
    ).rejects.toThrow(/finality tier mismatch/i);

    expect(transfers.build).not.toHaveBeenCalled();
    expect(submitAndTrack).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does NOT throw when the quoted tier MATCHES the declared burn tier (burn proceeds)', async () => {
    await bridgeOut({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      amount: AMOUNT,
      minFinalityThreshold: 1000,
      quotedFinalityThreshold: 1000, // matches → no throw
      resolveDepositWallet,
    });
    // The burn proceeded through the shared proven-submit path.
    expect(submitAndTrack).toHaveBeenCalled();
    expect(asBig(invokeResult!.calldata[6])).toBe(1000n);
  });
});

// ---------------------------------------------------------------------------
// Prove-early bridge-OUT (now the unconditional default — no config flag).
//
// The withdraw proving leg first proves at `latest − IMMEDIATE_PROVING_BLOCK_DEPTH`
// (12) with NO aging wait; on ANY pre-relay build+prove failure it falls back ONCE to today's
// aging path. `executeWithInvocation(invocation, provingBlockId)` receives the SAME block that
// createProofInvocation was given, so its 2nd arg is the assertion target (a stable
// module-level spy). getCurrentBlock spy = 7 → immediateBase = max(7 − 12, 0) = 0; the aging
// path's waitForProvingBlock spy returns the sentinel 'block-1'.
// ---------------------------------------------------------------------------
describe('proveAndSubmitBridgeOut — immediate prove (unconditional default)', () => {
  const realPaymaster = config.paymaster;
  const IMMEDIATE_BASE = 0; // getCurrentBlock(7) − IMMEDIATE_PROVING_BLOCK_DEPTH(12) → max(…,0)
  const execMock = () => transfers.executeWithInvocation as ReturnType<typeof vi.fn>;

  afterEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = realPaymaster;
  });

  // (A) immediate build+prove SUCCEEDS → prove at immediateBase, NO aging wait.
  it('(A) proves at latest−12 and does NOT age when the buried notes cover the withdraw', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe(IMMEDIATE_BASE);
    expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
    expect(getCurrentBlockSpy).toHaveBeenCalled();
  });

  // (B) immediate prove throws /Insufficient balance/ (compile-time deficit) → ONE
  // aged fallback (head anchor + PROVING_BLOCK_DEPTH), then a single submit. No double-submit.
  it('(B) an Insufficient-balance immediate prove falls back ONCE to the aging path, then submits', async () => {
    execMock().mockReset();
    execMock()
      .mockRejectedValueOnce(new Error('Insufficient balance for token 0xUSDC: need 5 have 3'))
      .mockResolvedValue({
        callAndProof: { call: { contractAddress: ANONYMIZER, calldata: [] }, proof: { data: [], proofFacts: [] } },
      });
    const submitMock = submitAndTrack as ReturnType<typeof vi.fn>;

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    // Exactly one aged fallback, anchored at the live head (no fee-approve tx → anchor 7).
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![1]).toBe(7);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    // Immediate (0) then aged ('block-1'); submitted exactly once (no double-submit).
    expect(execMock()).toHaveBeenCalledTimes(2);
    expect(execMock().mock.calls[0]![1]).toBe(IMMEDIATE_BASE);
    expect(execMock().mock.calls[1]![1]).toBe('block-1');
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  // (C) immediate prove throws a NON-insufficient error (prove-step/network) → SAME
  // single aged fallback. Proves the catch is catch-ALL, not an /Insufficient balance/ match.
  it('(C) a NON-insufficient immediate-prove error falls back the same way (catch-all)', async () => {
    execMock().mockReset();
    execMock()
      .mockRejectedValueOnce(new Error('prover gateway 503 (network)'))
      .mockResolvedValue({
        callAndProof: { call: { contractAddress: ANONYMIZER, calldata: [] }, proof: { data: [], proofFacts: [] } },
      });
    const submitMock = submitAndTrack as ReturnType<typeof vi.fn>;

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    expect(execMock()).toHaveBeenCalledTimes(2);
    expect(execMock().mock.calls[0]![1]).toBe(IMMEDIATE_BASE);
    expect(execMock().mock.calls[1]![1]).toBe('block-1');
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  // (D) immediate prove SUCCEEDS then the SUBMIT phase fails pre-relay (stale nonce) →
  // the existing submit retry rebuilds+re-proves at the SAME immediateBase (no re-age;
  // waitForProvingBlock NOT called). The immediate→aged fallback does NOT re-fire post-prove.
  it('(D) the submit-phase stale-nonce retry reuses immediateBase (no re-age)', async () => {
    const submitMock = submitAndTrack as ReturnType<typeof vi.fn>;
    // First submit throws BEFORE send() (pre-relay nonce error → burnTxHash stays '' → retry);
    // the retry uses the default impl (send() → burnTxHash set).
    submitMock.mockImplementationOnce(async () => {
      throw new Error('code: 52 invalid transaction nonce');
    });

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    // No aging on either the first attempt or the retry — the pinned immediateBase is reused.
    expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
    expect(execMock()).toHaveBeenCalledTimes(2);
    expect(execMock().mock.calls[0]![1]).toBe(IMMEDIATE_BASE);
    expect(execMock().mock.calls[1]![1]).toBe(IMMEDIATE_BASE);
    expect(submitMock).toHaveBeenCalledTimes(2);
  });

  // (D-paymaster) with the paymaster: the immediate prove succeeds, then the AVNU relay is
  // in-flight and executeTransaction throws (code 156) — the onRelayStart ambiguity guard fails
  // CLOSED (relay called exactly once) and the immediate→aged fallback does NOT re-fire.
  it('(D) with the paymaster: a post-relay execute throw fails closed; the fallback does NOT re-fire', async () => {
    (config as { paymaster: typeof config.paymaster }).paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    };
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: { type: 'withdraw', recipient: '0xFEEFWD', token: config.depositToken.address, amount: '0x0' },
    });
    avnuExecute.mockReset();
    avnuExecute.mockRejectedValue(
      new Error('AVNU paymaster_executeTransaction error (code 156): Burn amount exceeds limit'),
    );

    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/156|burn amount exceeds limit/i);

    // Fail closed: exactly one relay attempt; the immediate prove succeeded so no aged fallback.
    expect(avnuExecute).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
  });

  // (E) NON-quiescent (note-id sets differ at immediateBase vs head) → today's aging path
  // exactly: waitForProvingBlock(anchor=head 7, depth 8) drives the proving block ('block-1');
  // immediateBase (0) is NEVER used. Drives aging through the quiescence gate — the flag no
  // longer exists to toggle this off directly.
  it('(E) non-quiescent: uses today’s aging path; immediateBase is never used as the proving block', async () => {
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
    );

    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![1]).toBe(7);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });
});

// ---------------------------------------------------------------------------
// Prove-early QUIESCENCE GATE (collision-prevention fix).
//
// Prove-early is only SAFE when the account committed NO state in the ~12-block
// window: its spendable note-id set must be IDENTICAL at `immediateBase` (latest−12)
// and at head. Otherwise the stale `latest−12` view can reuse an already-consumed
// write-once slot → a VALID proof that reverts ON-CHAIN (NON_ZERO_VALUE), a hard
// fail the user must rerun. The gate discovers the id-set at both blocks and takes
// the immediate path ONLY on equality; any add/spend (or a discovery failure)
// degrades to today's aging path. Fund-safety is identical either way (both fail
// closed) — this is a USABILITY layer.
//
// getCurrentBlock spy = 7 → immediateBase = max(7−12, 0) = 0; the aging path's
// waitForProvingBlock spy returns the sentinel 'block-1'. discoverNoteIdsAtBlockSpy
// is keyed on blockIdentifier: numeric 0 = the base read, 'pre_confirmed' = head.
// ---------------------------------------------------------------------------
describe('proveAndSubmitBridgeOut — prove-early quiescence gate (collision prevention)', () => {
  const realPaymaster = config.paymaster;
  const IMMEDIATE_BASE = 0;
  const execMock = () => transfers.executeWithInvocation as ReturnType<typeof vi.fn>;

  afterEach(() => {
    (config as { paymaster: typeof config.paymaster }).paymaster = realPaymaster;
  });

  // (A) id-sets EQUAL at immediateBase vs head → quiescent → prove at
  // immediateBase, NO aging wait. (The default spy already returns equal sets.)
  it('(A) quiescent (equal id-sets) → proves at latest−12, does NOT age', async () => {
    await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    // The gate read BOTH blocks: numeric immediateBase (0) and the head ('pre_confirmed').
    expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
    const blocks = discoverNoteIdsAtBlockSpy.mock.calls.map((c) => c[0].blockIdentifier);
    expect(blocks).toContain(IMMEDIATE_BASE);
    expect(blocks).toContain('pre_confirmed');
    // Immediate path: proved at immediateBase, no aging wait.
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe(IMMEDIATE_BASE);
    expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
  });

  // (B) an ADDED note in-window (head has an id the base lacks) → sets DIFFER
  // → aging path (head anchor 7 + PROVING_BLOCK_DEPTH 8); immediateBase NOT used.
  it('(B) an ADDED in-window note (sets differ) → ages, never proves at immediateBase', async () => {
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
    );

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    // Aging path: head anchor (7), aging depth (8); immediateBase never used to prove.
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![1]).toBe(7);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });

  // (C) a SPENT note in-window (a REMOVAL — the base has an id head lacks) →
  // sets DIFFER → aging. This is the case a max(created)/count gate would MISS: a
  // spend with no change note lowers the head set but never raises a max-of-current.
  it('(C) a SPENT in-window note (a removal) → ages (the case a count/max gate misses)', async () => {
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      // Base sees 3 notes; by head one was spent with no change note → only 2 remain.
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2'] : ['1', '2', '3'],
    );

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });

  // (E) flag ON, a gate discovery read THROWS (indexer down / historical numeric
  // block_ref unsupported) → degrade to aging; the withdraw PROCEEDS (no abort/hang).
  it('(E) a gate discovery read throws → degrades to aging, withdraw proceeds', async () => {
    discoverNoteIdsAtBlockSpy.mockReset();
    discoverNoteIdsAtBlockSpy.mockRejectedValue(new Error('indexer historical block_ref unsupported'));

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    // No abort: the burn still lands via the aging path.
    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });

  // (F) REGRESSION (v1 hole stays closed): quiescent (immediate path), a paymaster
  // submit failure (code-156 / NON_ZERO_VALUE, NO hash, post-onRelayStart) STILL
  // fail-closes exactly as today — the relay runs ONCE, no re-submit, nothing
  // reclassified. Drives the REAL submit/catch path (not a stub).
  it('(F) paymaster code-156 (no hash, post-relay) STILL fail-closes; nothing reclassified', async () => {
    (config as { paymaster: typeof config.paymaster }).paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    };
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: { type: 'withdraw', recipient: '0xFEEFWD', token: config.depositToken.address, amount: '0x0' },
    });
    avnuExecute.mockReset();
    avnuExecute.mockRejectedValue(
      new Error('AVNU paymaster_executeTransaction error (code 156): Burn amount exceeds limit / NON_ZERO_VALUE'),
    );

    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/156|burn amount exceeds limit/i);

    // Fail closed: exactly ONE relay attempt (no double-burn re-submit).
    expect(avnuExecute).toHaveBeenCalledTimes(1);
    // The gate ran (immediate path) — quiescent, so no aging.
    expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
    expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
    // The code-156 / NON_ZERO_VALUE class is NOT auto-retryable — classifier unchanged.
    expect(
      isTransientError(new Error('AVNU paymaster_executeTransaction error (code 156): NON_ZERO_VALUE')),
    ).toBe(false);
  });

  // (F-nodelag) the retryable sibling of (F): a full-node-lag code-156 ("stored block hash:
  // 0", NO hash, PRE-broadcast) means AVNU's node is briefly behind the proof's base block.
  // A lag that never clears rejects (bounded) and NEVER rebuilds — the exhausted node-lag
  // propagates BEFORE the fail-closed/rebuild path (a re-prove against the still-lagging
  // anchor would just node-lag again), reusing the SAME proof throughout. Reuses the shared
  // node-lag retry (nodeLagRetry.ts) — the same primitive as the claim leg (bridgeBack.ts).
  it('(F-nodelag) a paymaster node-lag that never clears rejects (bounded), reusing the same proof', async () => {
    (config as { paymaster: typeof config.paymaster }).paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '',
    };
    avnuBuild.mockResolvedValue({
      type: 'apply_action',
      fee_action: { type: 'withdraw', recipient: '0xFEEFWD', token: config.depositToken.address, amount: '0x0' },
    });
    avnuExecute.mockReset();
    avnuExecute.mockRejectedValue(new Error(NODE_LAG_MSG)); // node never catches up

    await expect(
      bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet }),
    ).rejects.toThrow(/block hash mismatch/i);

    // 1 initial + 6 (MAX_NODE_LAG_RETRIES) = 7 attempts, all the SAME proof.
    expect(avnuExecute).toHaveBeenCalledTimes(7);
    // Proof built once; exhaustion never re-proves.
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(transfers.invalidateProofNonceCache).not.toHaveBeenCalled();
  });

  // (G) REGRESSION — EDGE CASE 1: "funds/notes arrived within the last 12 blocks."
  // A fresh note id is visible at head ('pre_confirmed') but NOT yet at immediateBase
  // (latest−12) — the account is NOT quiescent. The probe MUST detect the set
  // inequality and refuse the immediate path: it must NOT prove at immediateBase, and
  // must instead age via waitForProvingBlock (today's full aging wait). This is the
  // highest-value regression for the now-unconditional prove-early default: if someone
  // ever makes the probe skip the set-equality check (e.g. treats discovery success as
  // automatically quiescent), this test goes red — execMock would be called with
  // IMMEDIATE_BASE instead of the aged 'block-1' sentinel, and waitForProvingBlockSpy
  // would never fire.
  it('(G) a fresh note arriving within the last 12 blocks forces aging, never prove-early', async () => {
    // Base (immediateBase = latest−12) sees only the old note '1'; head sees an
    // ADDITIONAL fresh note '2' that landed inside the 12-block window.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2'] : ['1'],
    );

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    // The gate read both blocks and detected the inequality.
    expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
    // MUST age: waitForProvingBlock drives the proving block (head anchor 7, depth 8).
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![1]).toBe(7);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    // MUST NOT prove-early: the proof is built at the aged block, never at immediateBase.
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });

  // (H) REGRESSION — SAME-COUNT SWAP: an in-window note was SPENT and a different one
  // CREATED, so the id-set CHANGES but its LENGTH does not (base ['1','2'] → head
  // ['1','3']). The account is NOT quiescent. This closes the hole (G) leaves open: a
  // weakened gate that checks only `atBase.length === atHead.length` (dropping the
  // `.every(id-identity)` part) would treat this as quiescent and WRONGLY prove-early.
  // A length-only predicate FAILS this test — it would build at IMMEDIATE_BASE and never
  // call waitForProvingBlock. So this goes red the instant the id-identity check is dropped.
  it('(H) a same-count in-window note SWAP (id-set differs, length equal) forces aging, never prove-early', async () => {
    // Base sees notes '1','2'; by head '2' was spent and '3' created — same count (2), different set.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '3'] : ['1', '2'],
    );

    const res = await bridgeOut({ signature: SIGNATURE, accountIndex: ACCOUNT_INDEX, accountNonce: ACCOUNT_NONCE, amount: AMOUNT, resolveDepositWallet });

    expect(res.burnTxHash).toBe(BURN_TX_HASH);
    // The gate read both blocks and detected the id-set change despite the equal length.
    expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
    // MUST age: waitForProvingBlock drives the proving block (head anchor 7, depth 8).
    expect(waitForProvingBlockSpy).toHaveBeenCalledTimes(1);
    expect(waitForProvingBlockSpy.mock.calls[0]![1]).toBe(7);
    expect(waitForProvingBlockSpy.mock.calls[0]![3]).toBe(8);
    // MUST NOT prove-early: the proof is built at the aged block, never at immediateBase.
    expect(execMock()).toHaveBeenCalledTimes(1);
    expect(execMock().mock.calls[0]![1]).toBe('block-1');
    expect(execMock().mock.calls[0]![1]).not.toBe(IMMEDIATE_BASE);
  });
});
