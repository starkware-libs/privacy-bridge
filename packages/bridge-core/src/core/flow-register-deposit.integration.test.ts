// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Cross-module INTEGRATION test for the make-private value path.
//
// Runs the REAL register → deposit chain wired together — register.ts,
// deposit.ts, proven-submit.ts (incl. its serialized manager-nonce manager),
// proving.ts and tx.ts all execute for real. Only the lowest boundaries are
// faked (the starknet provider/account via ./provider, and the SDK's proof
// builder), through the shared fake-chain harness.
//
// The unit tests cover each module in isolation; this covers the SEAMS between
// them — specifically the manager-paid submit sequencing where the live "code 52"
// nonce-collision bug lived (see proven-submit.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Call } from 'starknet';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';
import {
  ChainRecorder,
  fakeManager,
  fakeProvider,
  fakeTransfers,
  fakeUserAccount,
} from './__testkit__/fake-chain';

// Fake ONLY the chain boundary + the SDK proof builder; everything else is real.
vi.mock('./provider', () => ({ getRpcProvider: vi.fn(), makeAccount: vi.fn() }));
vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(),
  IndexerDiscoveryProvider: vi.fn(),
}));

import { getRpcProvider, makeAccount } from './provider';
import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk';
import { registerWithPool } from './register';
import { depositToPool } from './deposit';
import { invalidateManagerNonce } from './proven-submit';

const VIEWING_KEY = 123456789n;
const AMOUNT_WEI = 1_000_000n; // 1 USDC @ 6dp
const FEE_WEI = 50_000_000_000_000_000n; // 0.05 STRK pool fee

const recorder = new ChainRecorder();
// Built ONCE: proven-submit caches the manager Account in module state
// (sharedManager), so it must be a stable object across cases in this file.
const manager = fakeManager(recorder);

function nonceOf(d: Record<string, unknown>): bigint | undefined {
  return d.nonce === undefined ? undefined : BigInt(d.nonce as string | number | bigint);
}
function entrypointOf(call: Call | Call[]): string {
  return Array.isArray(call) ? (call[0]?.entrypoint ?? '') : call.entrypoint;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.reset();
  manager.reset();
  // Resets proven-submit's local nonce counter. Note: its `submitChain` mutex tail is
  // NOT reset, which is safe ONLY because every manager submit below is awaited to
  // completion (the chain settles before the next case). Keep that invariant: a future
  // case that leaves a manager submit un-awaited would leak its pending tail here.
  invalidateManagerNonce();

  vi.mocked(getRpcProvider).mockReturnValue(
    fakeProvider({ feeAmount: FEE_WEI, latestBlock: 1_000_000 }),
  );
  vi.mocked(makeAccount).mockReturnValue(manager);
  vi.mocked(createPrivateTransfers).mockImplementation(
    () => fakeTransfers() as unknown as PrivateTransfersInterface,
  );
});

describe('register → deposit (real manager-paid submit, faked chain)', () => {
  it('routes the value path correctly and sequences the manager nonce without re-reading RPC', async () => {
    const user: Account = fakeUserAccount(recorder, '0xUSERACCOUNT');

    await registerWithPool({ account: user, viewingKey: VIEWING_KEY });
    await depositToPool({ account: user, viewingKey: VIEWING_KEY, amountWei: AMOUNT_WEI });

    // Sender separation: ONLY the deposit-token approve is user-paid; the pool fee
    // + both proven apply_actions are manager-paid (derived account stays STRK-free).
    const userExecs = recorder.bySender('user');
    expect(userExecs).toHaveLength(1);
    expect(entrypointOf(userExecs[0]!.call)).toBe('approve');

    const managerExecs = recorder.bySender('manager');
    expect(managerExecs).toHaveLength(3); // fee-approve, register apply_actions, deposit apply_actions
    expect(managerExecs.map((e) => entrypointOf(e.call))).toEqual([
      'approve',
      'apply_actions',
      'apply_actions',
    ]);

    // The M2 seam: manager nonces are strictly sequential 0,1,2 and getNonce is read
    // EXACTLY ONCE (seeded, then locally authoritative — never re-read between the
    // back-to-back submits that previously collided as code 52).
    expect(managerExecs.map((e) => nonceOf(e.details))).toEqual([0n, 1n, 2n]);
    expect(recorder.nonceReads).toBe(1);

    // Proof rides on the proven submits with explicit resource bounds (so the
    // manager's execute skips the proof-dropping fee estimate); the fee-approve has none.
    expect(managerExecs[0]!.details.proof).toBeUndefined();
    expect(managerExecs[0]!.details.resourceBounds).toBeUndefined();
    for (const proven of [managerExecs[1]!, managerExecs[2]!]) {
      expect(proven.details.proof).toBeTruthy();
      expect(proven.details.proofFacts).toBeTruthy();
      expect(proven.details.resourceBounds).toBeDefined();
      expect(proven.details.tip).toBe(0n);
    }

    // The SDK's proven call is forwarded verbatim: register carries the 'register'
    // action tag, deposit the 'deposit' tag.
    expect((managerExecs[1]!.call as Call).calldata).toContain('register');
    expect((managerExecs[2]!.call as Call).calldata).toContain('deposit');
  });

  it('recovers in-call from a manager nonce collision (code 52) and still sequences', async () => {
    const user: Account = fakeUserAccount(recorder, '0xUSERACCOUNT');
    // Make the register proven submit (the 2nd manager execute) hit a code-52 once.
    manager.failOnExec(2, new Error('Invalid transaction nonce. Expected: 1, got: 0 (code: 52)'));

    await registerWithPool({ account: user, viewingKey: VIEWING_KEY });
    await depositToPool({ account: user, viewingKey: VIEWING_KEY, amountWei: AMOUNT_WEI });

    const managerExecs = recorder.bySender('manager');
    // The collision was transparent to register/deposit: 3 manager txs still committed,
    // still strictly sequential.
    expect(managerExecs).toHaveLength(3);
    expect(managerExecs.map((e) => nonceOf(e.details))).toEqual([0n, 1n, 2n]);
    // Recovery re-read the nonce once in-call (seed + one recovery read).
    expect(recorder.nonceReads).toBe(2);
  });

  it('keeps the manager nonce sequential when the RPC nonce LAGS (the real code-52 condition)', async () => {
    const user: Account = fakeUserAccount(recorder, '0xUSERACCOUNT');
    // Reproduce the actual failure condition: a just-submitted (pre-confirmed) tx does
    // NOT advance the RPC nonce, so every getNonce read returns the stale seed value.
    // The OLD bug re-read this lagging nonce per submit and fired 0,0,0 → code 52.
    manager.setNonceView(() => 0);

    await registerWithPool({ account: user, viewingKey: VIEWING_KEY });
    await depositToPool({ account: user, viewingKey: VIEWING_KEY, amountWei: AMOUNT_WEI });

    const managerExecs = recorder.bySender('manager');
    // The local counter is authoritative: nonces stay 0,1,2 despite the stale RPC view,
    // and getNonce is read exactly once (the seed) — never re-read into the lag.
    expect(managerExecs.map((e) => nonceOf(e.details))).toEqual([0n, 1n, 2n]);
    expect(recorder.nonceReads).toBe(1);
  });

  it('omits the proof from the submit when the prover returns no proof facts', async () => {
    // Drive the SDK fake to emit empty proofFacts so the real modules take their
    // `proofFacts?.length ? {proof,…} : {}` branch — the proof does NOT ride the invoke.
    vi.mocked(createPrivateTransfers).mockImplementation(
      () => fakeTransfers({ emptyProofFacts: true }) as unknown as PrivateTransfersInterface,
    );
    const user: Account = fakeUserAccount(recorder, '0xUSERACCOUNT');

    await registerWithPool({ account: user, viewingKey: VIEWING_KEY });

    const proven = recorder
      .bySender('manager')
      .find((e) => entrypointOf(e.call) === 'apply_actions');
    expect(proven).toBeDefined();
    expect(proven!.details.proof).toBeUndefined();
    expect(proven!.details.proofFacts).toBeUndefined();
    // The manager submit + explicit resource bounds still happen; only the proof is absent.
    expect(proven!.details.resourceBounds).toBeDefined();
  });
});
