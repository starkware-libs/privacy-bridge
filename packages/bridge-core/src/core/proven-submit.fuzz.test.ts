import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Call, RpcProvider } from 'starknet';

// The MANAGER account submitProvenCall must use as sender. Mock ./provider so
// getManagerAccount(config.admin) resolves to this spy instead of a real Account.
const managerExecute = vi.fn(
  async (_call: Call, _details?: Record<string, unknown>) => ({ transaction_hash: '0xfuzzhash' }),
);
// getNonce: read ONCE by the manager-nonce manager to seed its local counter; the
// 500 fuzz submits then reuse the counter with NO further RPC read (the maintainer
// constraint), so each iteration's execute is exactly one call.
const managerGetNonce = vi.fn(async (_tag?: string) => '0x0');
const managerAccount = {
  execute: managerExecute,
  getNonce: managerGetNonce,
} as unknown as Account;
vi.mock('./provider', () => ({
  getRpcProvider: () => ({}) as unknown as RpcProvider,
  makeAccount: () => managerAccount,
}));

import {
  buildProofResourceBounds,
  invalidateManagerNonce,
  maxFeeFromBounds,
  submitProvenCall,
  MAX_FEE_CEILING_WEI,
} from './proven-submit';

// OFFLINE fuzz/regression guard for the proof-bearing, MANAGER-paid submit path.
//
// CORRECTED MODEL (see proven-submit.ts header): apply_actions invokes are proven by
// the SDK and submitted to ACTUAL Starknet (real gas), sent from the MANAGER account
// (config.admin) so the derived user account stays STRK-free. The submit MUST
//   1. carry EXPLICIT resourceBounds so starknet@10's execute() skips the proof-less
//      fee estimate (which drops the proof and reverts), and
//   2. set REAL-fee v3 bounds whose implied MAX fee stays bounded & sane (a few STRK,
//      ≤ MAX_FEE_CEILING_WEI) — paid by the manager treasury.
// We drive the REAL submitProvenCall over MANY random payloads + random live block
// prices, asserting EVERY time:
//   1. the manager.execute (NOT the user account) is called with defined, complete
//      v3 resourceBounds whose implied fee is > 0 and ≤ MAX_FEE_CEILING_WEI, tip 0; and
//   2. the proof/proofFacts ride on that SAME execute call, verbatim.
// No network, no funds: pure mocks. Fixed-seed PRNG ⇒ reproducible.

// ── Reproducible randomness ────────────────────────────────────────────────
const FUZZ_SEED = 0x1d872b41; // fixed forever; logged below to reproduce
const N = 500;

function makeRng(seed: number) {
  let x = (seed ^ 0x2545f491) >>> 0;
  let y = (seed ^ 0x4f1bbcdc) >>> 0 || 1;
  let z = (seed ^ 0xc2b2ae35) >>> 0 || 2;
  let w = (seed ^ 0x27d4eb2f) >>> 0 || 3;
  return function next(): number {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
}

const HEX = '0123456789abcdef';
function randomHex(rng: () => number, nibbles: number): string {
  let s = '0x';
  for (let i = 0; i < nibbles; i++) s += HEX[rng() % 16];
  return s;
}

// A random proofDetails payload, matching the real ProofDetails union: either a
// populated { proof, proofFacts } or the empty {} (no-facts) branch.
function randomProofDetails(rng: () => number):
  | { proof: string; proofFacts: string[] }
  | Record<string, never> {
  if (rng() % 4 === 0) return {}; // no-facts branch
  const factCount = rng() % 5; // 0..4 facts
  const proofFacts = Array.from({ length: factCount }, () => randomHex(rng, 2 + (rng() % 16)));
  return { proof: randomHex(rng, 4 + (rng() % 64)), proofFacts };
}

function randomCall(rng: () => number): Call {
  return {
    contractAddress: randomHex(rng, 40),
    entrypoint: 'apply_actions',
    calldata: Array.from({ length: rng() % 6 }, () => randomHex(rng, 2 + (rng() % 8))),
  };
}

// A provider whose block read returns RANDOM (but realistic-magnitude) per-unit gas
// prices, so buildProofResourceBounds exercises both the floor and live-price paths.
function randomProvider(rng: () => number): RpcProvider {
  const fri = (base: bigint) => (base + BigInt(rng() % 4_000_000_000)).toString();
  return {
    getBlockWithTxHashes: vi.fn(async () => ({
      l1_gas_price: { price_in_fri: fri(100_000_000_000_000n), price_in_wei: '0x1' },
      l2_gas_price: { price_in_fri: fri(6_000_000_000n), price_in_wei: '0x1' },
      l1_data_gas_price: { price_in_fri: fri(600_000_000_000n), price_in_wei: '0x1' },
    })),
  } as unknown as RpcProvider;
}

beforeEach(() => {
  vi.clearAllMocks();
  managerExecute.mockResolvedValue({ transaction_hash: '0xfuzzhash' });
  managerGetNonce.mockResolvedValue('0x0');
  // Reset the module-level manager-nonce counter so the suite seeds fresh.
  invalidateManagerNonce();
});

// Assert a resourceBounds object is a valid REAL-fee proven v3 shape: all three legs
// present with bigint amounts/prices, l2 max_amount > 0, AND its implied max fee is
// positive but bounded (a few STRK, ≤ MAX_FEE_CEILING_WEI). The user account never
// pays it — the manager does — but it must still be a sane, fundable bound.
function assertResourceBoundsValid(rb: unknown): void {
  expect(rb).toBeDefined();
  const bounds = rb as {
    l1_gas?: { max_amount?: bigint; max_price_per_unit?: bigint };
    l2_gas?: { max_amount?: bigint; max_price_per_unit?: bigint };
    l1_data_gas?: { max_amount?: bigint; max_price_per_unit?: bigint };
  };
  for (const leg of [bounds.l1_gas, bounds.l2_gas, bounds.l1_data_gas]) {
    expect(leg).toBeDefined();
    expect(typeof leg!.max_amount).toBe('bigint');
    expect(typeof leg!.max_price_per_unit).toBe('bigint');
  }
  // l2_gas carries the headline OS gas amount.
  expect(bounds.l2_gas!.max_amount as bigint).toBeGreaterThan(0n);
  // Implied max fee: positive (real gas) but bounded & sane (manager-fundable).
  const fee = maxFeeFromBounds(bounds as Parameters<typeof maxFeeFromBounds>[0]);
  expect(fee).toBeGreaterThan(0n);
  expect(fee).toBeLessThanOrEqual(MAX_FEE_CEILING_WEI);
}

describe(`submitProvenCall fuzz (N=${N}, seed=0x${FUZZ_SEED.toString(16)})`, () => {
  it('logs the seed so any failure is reproducible', () => {
    console.log(
      `[proven-submit.fuzz] PRNG seed = 0x${FUZZ_SEED.toString(16)} (N=${N}); ` +
        `re-run with this seed to reproduce.`,
    );
    expect(N).toBeGreaterThanOrEqual(500);
  });

  it('ALWAYS submits from the MANAGER with explicit bounded real-fee resourceBounds + tip 0 AND forwards the proof verbatim', async () => {
    const rng = makeRng(FUZZ_SEED);
    for (let i = 0; i < N; i++) {
      const call = randomCall(rng);
      const proofDetails = randomProofDetails(rng);
      const prov = randomProvider(rng);

      managerExecute.mockClear();
      await submitProvenCall(prov, {} as unknown as Account, call, proofDetails);

      // exactly one manager.execute — the proven invoke, no proof-less estimate leg.
      expect(managerExecute).toHaveBeenCalledTimes(1);
      const [passedCall, details] = managerExecute.mock.calls[0] as [Call, Record<string, unknown>];

      // (1) explicit, valid bounded real-fee resourceBounds — the thing that makes
      // starknet@10 skip the proof-less fee estimate, with a sane implied fee.
      assertResourceBoundsValid(details.resourceBounds);
      // tip 0.
      expect(details.tip).toBe(0n);

      // (2) the proof/proofFacts ride on this SAME call (forwarded verbatim).
      expect(passedCall).toBe(call);
      if ('proof' in proofDetails) {
        expect(details.proof).toBe(proofDetails.proof);
        expect(details.proofFacts).toBe(proofDetails.proofFacts);
      } else {
        expect(details.proof).toBeUndefined();
        expect(details.proofFacts).toBeUndefined();
      }
    }
  });

  it('buildProofResourceBounds is a valid bounded real-fee shape on EVERY (random-price) call', async () => {
    const rng = makeRng(FUZZ_SEED ^ 0x55);
    for (let i = 0; i < N; i++) {
      assertResourceBoundsValid(await buildProofResourceBounds(randomProvider(rng)));
    }
  });

  // ── Mutation check: the guard has teeth ──────────────────────────────────
  // (i) the reverted submit bug: no resourceBounds → assertion (1) FAILS.
  it('mutation: a submit WITHOUT resourceBounds FAILS the invariant (proving the guard catches a revert)', async () => {
    async function wrongSubmitWithoutBounds(
      acct: Account,
      call: Call,
      proofDetails: Record<string, unknown>,
    ): Promise<void> {
      // Pre-fix shape: no resourceBounds → starknet@10 would run the proof-less estimate.
      await acct.execute(call, { tip: 0n, ...proofDetails });
    }

    await wrongSubmitWithoutBounds(managerAccount, CALL_FIXTURE, { proof: '0xp', proofFacts: ['0xf'] });
    const [, details] = managerExecute.mock.calls[0] as [Call, Record<string, unknown>];

    // The bug-shaped call has NO resourceBounds; the invariant must reject it.
    expect(details.resourceBounds).toBeUndefined();
    expect(() => assertResourceBoundsValid(details.resourceBounds)).toThrow();
  });

  // (ii) an astronomical-price bounds shape implies an absurd fee — the old ~1812-STRK
  // ceiling bug (code-55 regime). maxFeeFromBounds must surface it ABOVE the sane
  // ceiling, and the bounded invariant must reject it.
  it('mutation: an astronomical-price bounds shape blows the sane fee ceiling (code-55 regime detected)', () => {
    const astronomical = {
      l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
      l2_gas: { max_amount: 225_000_000n, max_price_per_unit: 10n ** 16n },
      l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
    };
    expect(maxFeeFromBounds(astronomical)).toBeGreaterThan(MAX_FEE_CEILING_WEI);
    expect(() => assertResourceBoundsValid(astronomical)).toThrow();
  });
});

const CALL_FIXTURE: Call = { contractAddress: '0xpool', entrypoint: 'apply_actions', calldata: [] };
