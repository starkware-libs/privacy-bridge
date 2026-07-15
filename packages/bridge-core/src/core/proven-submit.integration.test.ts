import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Call, RpcProvider } from 'starknet';

// =============================================================================
// REGRESSION TEST for the M2 make-private REGISTER failure (and the identical
// deposit / withdraw submit pattern), updated for the MANAGER-paid model.
//
// LIVE SYMPTOM: a proof-bearing `apply_actions` invoke to the privacy pool was
// rejected at submit; the sender's account nonce never advanced (tx never landed).
//
// DIAGNOSED ROOT CAUSE (client-encoding bug, NOT the SDK<->pool ABI drift):
// register.ts / deposit.ts / bridgeOut.ts submitted the proven call via
//     account.execute(call, { tip: 0n, ...proofDetails })   // <- NO resourceBounds
// In starknet@10.0.0-beta.6 `Account.execute` runs an implicit fee ESTIMATE FIRST
// whenever `resourceBounds` is absent. The proof and proofFacts ride ONLY on the
// final `invokeFunction` — the estimate path does NOT forward them. So the pool
// re-ran `apply_actions` WITHOUT its STARK proof during estimation, proof
// verification reverted, and `execute` threw before the proven invoke was submitted.
//
// FIX: submitProvenCall passes EXPLICIT resourceBounds so `execute` skips the
// proof-less estimate, and the proof reaches the pool on the one and only invoke.
//
// MANAGER-PAID MODEL: submitProvenCall now sends from the MANAGER account
// (config.admin), NOT the derived user account, so the user stays STRK-free. We mock
// ./provider so getManagerAccount resolves to the starknet@10 simulator below.
//
// WHAT THIS TEST DOES (offline, deterministic, CI-safe): it reimplements the EXACT
// starknet@10 `execute` branch (estimate-first iff no resourceBounds; proof only on
// the final invoke) wired to a POOL SIMULATOR that reverts any proof-less
// apply_actions, then drives the REAL `submitProvenCall`. Before the fix the estimate
// hits the pool proof-less and the simulator reverts — RED. After the fix the proven
// invoke lands — GREEN. A second test pins the inverse (the buggy no-bounds call
// reproduces the revert), proving the simulator is faithful.
// =============================================================================

// The pool's proof-verification revert seen on the diagnosed path.
const PROOF_REVERT = 'apply_actions: proof verification failed (no proof present)';

const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const APPLY_ACTIONS: Call = {
  contractAddress: POOL,
  entrypoint: 'apply_actions',
  calldata: ['0x3', '0x0', '0x1c3d38b6', '0x1', '0x2', '0x3'],
};
const PROOF_DETAILS = { proof: '0xstarkproofblob', proofFacts: ['0xfact1', '0xfact2'] };

// A latest-block header carrying per-unit gas prices, the shape the RPC returns
// and buildProofResourceBounds reads to set max_price_per_unit.
const BLOCK_HEADER = {
  l1_gas_price: { price_in_fri: '0x5d76cc47a648', price_in_wei: '0x79e608db' },
  l2_gas_price: { price_in_fri: '0x1dcd65000', price_in_wei: '0x26de7' }, // 8e9 fri
  l1_data_gas_price: { price_in_fri: '0x606db49f53', price_in_wei: '0x7dc3d3' },
};

// -----------------------------------------------------------------------------
// Faithful starknet@10 execute() simulator wired to a proof-aware pool. This stands
// in for the MANAGER account (the sender/fee-payer in the manager-paid model).
//   - if details.resourceBounds is absent -> estimate FIRST (no proof forwarded)
//   - the final invoke forwards proof/proofFacts only when present on details
// The pool simulator reverts unless proof verification sees the proof.
// -----------------------------------------------------------------------------
interface PoolCallRecord {
  phase: 'estimate' | 'invoke';
  hasProof: boolean;
}

// Hoisted manager spy so the ./provider mock factory can close over it. The current
// simulator's execute is swapped in per-test via managerExecute.mockImplementation.
const managerExecute = vi.fn();
// getNonce: read ONCE by the manager-nonce manager to seed its local counter.
const managerGetNonce = vi.fn(async (_tag?: string) => '0x0');
const managerAccount = {
  execute: managerExecute,
  getNonce: managerGetNonce,
} as unknown as Account;
vi.mock('./provider', () => ({
  getRpcProvider: () => ({}) as unknown as RpcProvider,
  makeAccount: () => managerAccount,
}));

import { invalidateManagerNonce, submitProvenCall } from './proven-submit';

function wireStarknet10Manager(poolCalls: PoolCallRecord[]): void {
  // The pool: apply_actions reverts if proof verification runs without the proof.
  const applyActionsAtPool = (phase: 'estimate' | 'invoke', proof: string | undefined) => {
    const hasProof = proof !== undefined;
    poolCalls.push({ phase, hasProof });
    if (!hasProof) {
      throw new Error(PROOF_REVERT); // proof verification with no proof -> revert
    }
    return { transaction_hash: '0xlanded' };
  };

  managerExecute.mockImplementation(async (_call: Call, details: Record<string, unknown> = {}) => {
    const resourceBounds = details.resourceBounds;
    // === starknet@10 execute branch ===
    if (!resourceBounds) {
      // estimate path does NOT forward proof/proofFacts → pool sees no proof.
      applyActionsAtPool('estimate', undefined);
    }
    // === final invokeFunction: proof rides HERE only ===
    return applyActionsAtPool('invoke', details.proof as string | undefined);
  });
}

function makeProvider(): RpcProvider {
  return {
    getBlockWithTxHashes: vi.fn(async () => BLOCK_HEADER),
  } as unknown as RpcProvider;
}

// The (ignored) user account passed positionally — submitProvenCall must NOT send
// from it; a throwing spy guards that it is never the sender.
const userAccount = {
  execute: vi.fn(async () => {
    throw new Error('user account must never be the sender (manager-paid)');
  }),
} as unknown as Account;

beforeEach(() => {
  vi.clearAllMocks();
  managerGetNonce.mockResolvedValue('0x0');
  // Reset the module-level manager-nonce counter so each test re-seeds from chain.
  invalidateManagerNonce();
});

describe('proof-bearing apply_actions submit (register/deposit/withdraw)', () => {
  it('FIXED PATH: submitProvenCall lands the proven invoke from the manager without the proof-less estimate revert', async () => {
    const poolCalls: PoolCallRecord[] = [];
    wireStarknet10Manager(poolCalls);
    const provider = makeProvider();

    const res = await submitProvenCall(provider, userAccount, APPLY_ACTIONS, PROOF_DETAILS);

    // It must NOT throw the diagnosed proof-verification revert, and must land.
    expect(res.transaction_hash).toBe('0xlanded');
    // The pool was hit exactly once — only the final proven invoke. No proof-less
    // estimate round-trip (that is what the explicit resourceBounds suppresses).
    expect(poolCalls).toEqual([{ phase: 'invoke', hasProof: true }]);
  });

  it('REPRODUCES THE LIVE FAILURE: the OLD no-resourceBounds submit reverts proof-less at estimate', async () => {
    // Models register.ts/deposit.ts/bridgeOut.ts BEFORE the fix:
    //   account.execute(call, { tip: 0n, ...proofDetails })  // no resourceBounds
    const poolCalls: PoolCallRecord[] = [];
    wireStarknet10Manager(poolCalls);

    const buggySubmit = () =>
      managerAccount.execute(APPLY_ACTIONS, { tip: 0n, ...PROOF_DETAILS }); // <- the bug

    await expect(buggySubmit()).rejects.toThrow(PROOF_REVERT);
    // The pool was hit by the ESTIMATE, proof-less — exactly the diagnosed cause.
    expect(poolCalls).toEqual([{ phase: 'estimate', hasProof: false }]);
  });

  it('FIX MECHANISM: submitProvenCall forwards proof onto the SAME call it sets bounds on (from the manager)', async () => {
    // Guards against a partial regression where bounds are set but the proof is
    // dropped (or vice versa) — both must be on the one invoke that reaches the pool.
    managerExecute.mockResolvedValue({ transaction_hash: '0xok' });
    const provider = makeProvider();

    await submitProvenCall(provider, userAccount, APPLY_ACTIONS, PROOF_DETAILS);

    expect(managerExecute).toHaveBeenCalledTimes(1);
    const [, details] = managerExecute.mock.calls[0] as unknown as [Call, Record<string, unknown>];
    expect(details.resourceBounds).toBeDefined(); // skips the proof-less estimate
    expect(details.proof).toBe(PROOF_DETAILS.proof); // proof rides on this invoke
    expect(details.proofFacts).toBe(PROOF_DETAILS.proofFacts);
  });

  it('keeps the user account STRK-free: it is never the sender', async () => {
    managerExecute.mockResolvedValue({ transaction_hash: '0xok' });
    const provider = makeProvider();
    await submitProvenCall(provider, userAccount, APPLY_ACTIONS, PROOF_DETAILS);
    expect(userAccount.execute).not.toHaveBeenCalled();
    expect(managerExecute).toHaveBeenCalledTimes(1);
  });
});
