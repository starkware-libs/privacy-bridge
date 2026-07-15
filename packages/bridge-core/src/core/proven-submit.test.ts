import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Call, RpcProvider } from 'starknet';

// The MANAGER account the proven submit must use as sender/fee-payer. Mock
// ./provider so getManagerAccount(config.admin) resolves to this spy instead of a
// real on-chain Account — submitProvenCall builds the manager via makeAccount.
interface ExecDetails {
  resourceBounds: import('./proven-submit').ProofResourceBounds;
  tip: bigint;
  proof?: string;
  proofFacts?: string[];
}
const managerExecute = vi.fn(
  async (_call: Call, _details: ExecDetails) => ({ transaction_hash: '0xmanagerhash' }),
);
const userExecute = vi.fn(
  async (_call: Call, _details: ExecDetails) => ({ transaction_hash: '0xuserhash' }),
);
// getNonce is what the manager-nonce manager reads ONCE to seed its local counter on
// the first submit (Account.getNonce(blockTag)); a real Account exposes it.
const managerGetNonce = vi.fn(async (_tag?: string) => '0x0');
const managerAccount = {
  execute: managerExecute,
  getNonce: managerGetNonce,
} as unknown as Account;
vi.mock('./provider', () => ({
  getRpcProvider: () => ({}) as unknown as RpcProvider,
  // getManagerAccount calls makeAccount(admin.address, admin.privateKey, provider);
  // return the manager spy regardless of args so we can assert who submits.
  makeAccount: () => managerAccount,
}));

import {
  buildProofResourceBounds,
  invalidateManagerNonce,
  maxFeeFromBounds,
  submitProvenCall,
  MAX_L2_GAS,
  MAX_L1_DATA_GAS,
  MAX_L1_GAS,
  FLOOR_L2_GAS_PRICE,
  FLOOR_L1_DATA_GAS_PRICE,
  FLOOR_L1_GAS_PRICE,
  MAX_FEE_CEILING_WEI,
} from './proven-submit';

// Regression test for the register/deposit/withdraw proven-submit path.
//
// CORRECTED MODEL (see proven-submit.ts header): apply_actions invokes are PROVEN
// client-side by the SDK and then submitted to ACTUAL Starknet, where they cost REAL
// gas. To keep the derived user account STRK-free (unlinkability), a MANAGER account
// (config.admin) is the SENDER / fee-payer — the proven leg is sender-agnostic (the
// user identity rides in the proven calldata; the proof binds no sender). Two coupled
// guarantees the submit path rests on:
//   1. EXPLICIT resourceBounds on execute, so starknet@10 skips the proof-less fee
//      estimate (which would drop the proof and revert during estimation); the proof
//      rides on the one and only invoke.
//   2. REAL-fee v3 bounds sized off the golden on-chain apply_actions + live block
//      prices with modest headroom — the implied MAX fee stays a few STRK (bounded by
//      MAX_FEE_CEILING_WEI), which the manager treasury covers.

const HASH = '0xmanagerhash';
const PROOF = '0xproof'; // prover data blob (string)
const PROOF_FACTS = ['0xfact']; // felt-array facts (string[])
const STRK = 10n ** 18n;

// A latest-block header carrying per-unit gas prices, the shape the RPC returns and
// buildProofResourceBounds reads to set max_price_per_unit. l2 = 8e9 fri (below the
// 16e9 floor → floor wins); l1_data / l1 high enough to exercise the live-price path.
const BLOCK_HEADER = {
  l1_gas_price: { price_in_fri: (FLOOR_L1_GAS_PRICE).toString(), price_in_wei: '0x1' },
  l2_gas_price: { price_in_fri: '8000000000', price_in_wei: '0x1' }, // 8e9 < 16e9 floor
  l1_data_gas_price: { price_in_fri: (FLOOR_L1_DATA_GAS_PRICE).toString(), price_in_wei: '0x1' },
};

let provider: RpcProvider;

beforeEach(() => {
  vi.clearAllMocks();
  managerExecute.mockResolvedValue({ transaction_hash: HASH });
  managerGetNonce.mockResolvedValue('0x0');
  // Reset the module-level manager-nonce counter so each test re-seeds from chain.
  invalidateManagerNonce();
  // A provider whose block read returns the fixture header (real-fee bounds read it).
  provider = {
    getBlockWithTxHashes: vi.fn(async () => BLOCK_HEADER),
  } as unknown as RpcProvider;
});

// The (ignored) user account passed positionally — submitProvenCall must NOT send
// from it. A spy so we can assert it is never the sender.
const userAccount = { execute: userExecute } as unknown as Account;
const CALL: Call = { contractAddress: '0xpool', entrypoint: 'apply_actions', calldata: [] };

describe('buildProofResourceBounds', () => {
  it('(a) returns all three v3 legs with bigint amounts and prices', async () => {
    const rb = await buildProofResourceBounds(provider);
    for (const leg of [rb.l1_gas, rb.l2_gas, rb.l1_data_gas]) {
      expect(typeof leg.max_amount).toBe('bigint');
      expect(typeof leg.max_price_per_unit).toBe('bigint');
    }
  });

  it('(b) sizes amounts off the golden apply_actions (the exported MAX_* constants)', async () => {
    const rb = await buildProofResourceBounds(provider);
    expect(rb.l2_gas.max_amount).toBe(MAX_L2_GAS);
    expect(rb.l1_data_gas.max_amount).toBe(MAX_L1_DATA_GAS);
    expect(rb.l1_gas.max_amount).toBe(MAX_L1_GAS);
    expect(rb.l2_gas.max_amount).toBeGreaterThan(0n);
  });

  it('(c) prices floor below the live price (l2 live 8e9 < 16e9 floor → floor wins)', async () => {
    const rb = await buildProofResourceBounds(provider);
    expect(rb.l2_gas.max_price_per_unit).toBe(FLOOR_L2_GAS_PRICE);
    expect(rb.l1_data_gas.max_price_per_unit).toBeGreaterThanOrEqual(FLOOR_L1_DATA_GAS_PRICE);
    expect(rb.l1_gas.max_price_per_unit).toBeGreaterThanOrEqual(FLOOR_L1_GAS_PRICE);
  });

  it('(d) falls back to the static floors and never throws when the block read fails', async () => {
    const badProvider = {
      getBlockWithTxHashes: vi.fn(async () => {
        throw new Error('RPC down');
      }),
    } as unknown as RpcProvider;
    const rb = await buildProofResourceBounds(badProvider);
    expect(rb.l2_gas.max_price_per_unit).toBe(FLOOR_L2_GAS_PRICE);
    expect(rb.l1_data_gas.max_price_per_unit).toBe(FLOOR_L1_DATA_GAS_PRICE);
    expect(rb.l1_gas.max_price_per_unit).toBe(FLOOR_L1_GAS_PRICE);
  });
});

// =============================================================================
// The implied-fee invariant, restated for the REAL-fee model.
//
// The bound's IMPLIED max fee (Σ max_amount × max_price_per_unit) is what
// __validate__ checks against the SENDER's (manager's) balance up front. It must be
// a REALISTIC few STRK — NOT an astronomical ceiling (the old ~1812-STRK bug) — so it
// stays comfortably within the manager treasury. maxFeeFromBounds detects a regression
// that balloons the bound past MAX_FEE_CEILING_WEI.
// =============================================================================
describe('implied MAX fee (bounded & sane)', () => {
  it('the floor-priced bounds imply ≈9.72 STRK (a few STRK, not astronomical)', () => {
    const floorBounds = {
      l1_gas: { max_amount: MAX_L1_GAS, max_price_per_unit: FLOOR_L1_GAS_PRICE },
      l2_gas: { max_amount: MAX_L2_GAS, max_price_per_unit: FLOOR_L2_GAS_PRICE },
      l1_data_gas: { max_amount: MAX_L1_DATA_GAS, max_price_per_unit: FLOOR_L1_DATA_GAS_PRICE },
    };
    const fee = maxFeeFromBounds(floorBounds);
    expect(fee).toBeGreaterThan(0n);
    // 580M×16e9 (l2) + 20000×2e12 (l1_data) + 2000×2e14 (l1) = 9.72 STRK. The raised
    // MAX_L2_GAS for the folded claim dominates (was ≈4.04 STRK at 225M l2_gas).
    expect(fee).toBe(9_720_000_000_000_000_000n); // 9.72 STRK
    expect(fee).toBeLessThanOrEqual(MAX_FEE_CEILING_WEI);
  });

  it('the actual bounds buildProofResourceBounds returns stay ≤ MAX_FEE_CEILING_WEI', async () => {
    const rb = await buildProofResourceBounds(provider);
    expect(maxFeeFromBounds(rb)).toBeGreaterThan(0n);
    expect(maxFeeFromBounds(rb)).toBeLessThanOrEqual(MAX_FEE_CEILING_WEI);
  });

  // COVERAGE for the l2-headroom-ABOVE-floor branch the 8e9 fixture never exercises:
  // at the golden live l2 price (12e9) the ×1.5 headroom (18e9) beats the 16e9 floor,
  // so the implied fee rises to ≈11.1 STRK — above the floor/8e9 paths and above the
  // old 10-STRK ceiling, but within the (coarse) 15-STRK guard.
  it('at the golden live l2 price (12e9) the implied fee ≈11.1 STRK (headroom > floor), still ≤ ceiling', async () => {
    const goldenProvider = {
      getBlockWithTxHashes: vi.fn(async () => ({
        l1_gas_price: { price_in_fri: FLOOR_L1_GAS_PRICE.toString(), price_in_wei: '0x1' },
        l2_gas_price: { price_in_fri: '12000000000', price_in_wei: '0x1' }, // 12e9 golden → ×1.5 = 18e9 > 16e9 floor
        l1_data_gas_price: { price_in_fri: FLOOR_L1_DATA_GAS_PRICE.toString(), price_in_wei: '0x1' },
      })),
    } as unknown as RpcProvider;
    const rb = await buildProofResourceBounds(goldenProvider);
    expect(rb.l2_gas.max_price_per_unit).toBe(18_000_000_000n); // live×1.5 headroom, above the floor
    const fee = maxFeeFromBounds(rb);
    // 580M×18e9 + 2000×3e14 (l1 headroom) + 20000×3e12 (l1_data headroom) = 11.1 STRK.
    expect(fee).toBe(11_100_000_000_000_000_000n);
    expect(fee).toBeGreaterThan(10n * STRK); // proves the old ≤10-STRK claim was false at golden price
    expect(fee).toBeLessThanOrEqual(MAX_FEE_CEILING_WEI);
  });

  it('MAX_FEE_CEILING_WEI is a coarse few-tens-of-STRK guard (≤ ~15 STRK), not the old ~1812-STRK bug', () => {
    expect(MAX_FEE_CEILING_WEI).toBeGreaterThan(11n * STRK); // above the golden-price worst-case
    expect(MAX_FEE_CEILING_WEI).toBeLessThanOrEqual(15n * STRK);
  });

  it('MUTATION: an astronomical price ceiling implies an absurd fee that BLOWS the sane bound', () => {
    // The reverted bug used ~1e16-style price ceilings → implied bound ~1812 STRK,
    // which __validate__ weighed against balance (code 55). maxFeeFromBounds must
    // surface such a regression as far above the sane ceiling.
    const astronomical = {
      l1_gas: { max_amount: MAX_L1_GAS, max_price_per_unit: 0n },
      l2_gas: { max_amount: MAX_L2_GAS, max_price_per_unit: 10n ** 16n },
      l1_data_gas: { max_amount: MAX_L1_DATA_GAS, max_price_per_unit: 0n },
    };
    expect(maxFeeFromBounds(astronomical)).toBeGreaterThan(MAX_FEE_CEILING_WEI);
  });
});

describe('submitProvenCall (manager-paid)', () => {
  it('submits from the MANAGER account, never from the (STRK-free) user account', async () => {
    await submitProvenCall(provider, userAccount, CALL, { proof: PROOF, proofFacts: PROOF_FACTS });
    expect(managerExecute).toHaveBeenCalledTimes(1);
    // The user account is NOT the sender — unlinkability rests on this.
    expect(userExecute).not.toHaveBeenCalled();
  });

  it('passes EXPLICIT resourceBounds so execute skips the proof-less estimate', async () => {
    await submitProvenCall(provider, userAccount, CALL, { proof: PROOF, proofFacts: PROOF_FACTS });
    const [, details] = managerExecute.mock.calls[0];
    // The crux: a DEFINED resourceBounds MUST be present. Without it, starknet@10
    // estimates the fee first and drops the proof — the diagnosed revert.
    expect(details.resourceBounds).toBeDefined();
    // Real-fee shape: all three legs present with non-zero amounts/prices, but the
    // implied total stays bounded (a few STRK) — paid by the manager.
    expect(details.resourceBounds.l2_gas.max_amount).toBeGreaterThan(0n);
    expect(details.resourceBounds.l2_gas.max_price_per_unit).toBeGreaterThan(0n);
    expect(maxFeeFromBounds(details.resourceBounds)).toBeGreaterThan(0n);
    expect(maxFeeFromBounds(details.resourceBounds)).toBeLessThanOrEqual(MAX_FEE_CEILING_WEI);
  });

  it('sets tip 0', async () => {
    await submitProvenCall(provider, userAccount, CALL, { proof: PROOF, proofFacts: PROOF_FACTS });
    const [, details] = managerExecute.mock.calls[0];
    expect(details.tip).toBe(0n);
  });

  it('forwards proof + proofFacts onto the same (proven) execute call', async () => {
    await submitProvenCall(provider, userAccount, CALL, { proof: PROOF, proofFacts: PROOF_FACTS });
    const [call, details] = managerExecute.mock.calls[0];
    expect(call).toBe(CALL);
    expect(details.proof).toBe(PROOF);
    expect(details.proofFacts).toBe(PROOF_FACTS);
  });

  it('still submits with explicit bounds when there are no proof facts ({} details)', async () => {
    await submitProvenCall(provider, userAccount, CALL, {});
    const [, details] = managerExecute.mock.calls[0];
    expect(details.resourceBounds).toBeDefined();
    expect(details.proof).toBeUndefined();
    expect(details.proofFacts).toBeUndefined();
  });

  it('returns the manager execute result (carries the transaction hash)', async () => {
    const res = await submitProvenCall(provider, userAccount, CALL, {});
    expect(res.transaction_hash).toBe(HASH);
  });
});
