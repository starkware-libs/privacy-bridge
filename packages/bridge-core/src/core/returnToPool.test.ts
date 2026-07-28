// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Core-level fund-safety tests for returnToPool() — the composed Leg-A return
// orchestrator for the FOLDED single-tx return: reverse-CCTP burn + attest
// (returnBurnToPool) → ONE proven ComputeAndInvoke claim that MINTS (receive_message,
// folded) + hands the USDC into the pool (buildAndProveClaim → submitProvenClaim). It
// owns the inflight-return cursor's TRUST + all the sequencing. These are the fund-safety
// assertions that must survive the fold:
//   1. cross-account guard         (a cursor for a DIFFERENT account never resumes)
//   2. stale-cursor live-balance   (a cursor whose wallet still holds returnable USDC is
//      re-validation                dropped → the FRESH path re-sizes + re-burns)
//   3. corrupt-cursor drop         (a corrupt cursor is discarded → fresh path)
//   4. resume with a consumed CCTP nonce → the folded claim already landed → clear +
//      no claim (was the claimable_of cross-device check; there is no ledger anymore)
// plus spyOnSecretSinks() proving the raw signature + derived keys are never logged.
//
// NOTE: the old build-proof-CONCURRENTLY-with-attestation overlap is GONE. The folded
// claim's proof COMMITS the CCTP message, so it can only be built AFTER attestation —
// the sequence is strictly burn → attest → prove → submit (see returnToPool.parallelClaim.
// test.ts, which was DELETED with this change).
//
// REAL returnToPool + REAL returnBurnToPool + REAL derivation (crypto is genuine, so the
// bound commitment truly tracks the account) run; only the outermost edges are mocked:
// bridgeBack (the folded claim's buildAndProveClaim/submitProvenClaim), polygonMint's
// Iris poll, provider/tx, and config.inboundAnonymizerAddress. The Polymarket-coupled
// fresh-return prep (convert + size + gasless transport) is injected as a stub. The
// cross-chain legs themselves are live-only (.claude/rules/verification.md).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

// --- collaborators -------------------------------------------------------------
const {
  waitForAttestation,
  callContract,
  attestedMessage,
  claimToPool,
  buildAndProveClaim,
  submitProvenClaim,
  PROVEN,
} = vi.hoisted(() => {
  // Opaque proven-claim artifact buildAndProveClaim hands submitProvenClaim — the
  // orchestrator treats it as a black box, so a sentinel is enough to assert it is
  // forwarded unchanged.
  const PROVEN = { __proven: true } as const;
  return {
    waitForAttestation: vi.fn<
      (
        burnTx: string,
        opts: { sourceDomain?: number; onStatus?: (s: string) => void },
      ) => Promise<{ message: `0x${string}`; attestation: `0x${string}` }>
    >(),
    // Answers is_nonce_used (returnBurnToPool's resume detectAlreadyClaimed gate).
    callContract: vi.fn(async (_request?: { entrypoint?: string }) => ['0x0'] as string[]),
    attestedMessage: { value: '0x' as `0x${string}` },
    // claimToPool is only used by recoverBridgeIn now — returnToPool never calls it. Kept
    // as a stub so returnIn's import resolves; asserted NEVER called.
    claimToPool: vi.fn(async () => ({ claimTxHash: '0xc1a1m' })),
    // The folded claim: build the proof (commits the CCTP message) then submit it.
    buildAndProveClaim: vi.fn(async () => PROVEN),
    submitProvenClaim: vi.fn(async () => '0xc1a1m'),
    PROVEN,
  };
});

// A well-formed CCTP-v2 message (long enough for is_nonce_used's nonce extraction). The
// pre-flight message gate lives in the (mocked) buildAndProveClaim, so byte-exact
// recipient/destinationCaller fields aren't required here.
function buildCctpMessage(opts: {
  sourceDomain: number;
  destinationDomain: number;
  recipientField64: string;
  destinationCallerField64?: string;
}): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const destinationCaller = (opts.destinationCallerField64 ?? opts.recipientField64).toLowerCase();
  const header =
    u32(1) +
    u32(opts.sourceDomain) +
    u32(opts.destinationDomain) +
    '00'.repeat(32 * 3) +
    destinationCaller +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) +
    '00'.repeat(32) +
    opts.recipientField64.toLowerCase() +
    '00'.repeat(32) +
    '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

vi.mock('./polygonMint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polygonMint')>();
  return { ...mod, waitForAttestation };
});
vi.mock('./tx', () => ({
  READ_BLOCK: 'pre_confirmed',
  submitAndTrack: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./provider', () => ({
  getRpcProvider: vi.fn(() => ({ callContract })),
  makeAccount: vi.fn(() => ({ address: '0xsnacct' })),
}));
// The folded claim is mocked at the module boundary (bridgeBack), so REAL returnToPool
// + REAL returnBurnToPool run but the proof build + submit are spies we can inspect.
vi.mock('./bridgeBack', () => ({ claimToPool, buildAndProveClaim, submitProvenClaim }));
vi.mock('./config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config')>();
  return { ...mod, config: { ...mod.config, inboundAnonymizerAddress: '0x49abc' } };
});

import { config } from './config';
import {
  returnToPool,
  INFLIGHT_RETURN_KEY,
  type FreshReturnPlan,
  type ReturnStep,
  type ReturnStepStatus,
} from './returnIn';
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';

const ACCOUNT_INDEX = 3;
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const INBOUND = config.inboundAnonymizerAddress;
const INBOUND_FIELD64 = INBOUND.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const FRESH_AMOUNT = 1_787_670n; // sized from the wallet's post-conversion balance
const POLYGON_DOMAIN = config.polygon.domain;
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;
const BURN_TX = '0xbeefcafe';

// REAL derivation: the SAME commitment returnBurnToPool must carry in the burn hookData,
// so tests can pin what the (real) burn call + cursor persist.
const VIEWING_KEY = deriveViewingKey(SIGNATURE);
const ACCOUNT_NONCE = deriveAccountNonce(VIEWING_KEY, ACCOUNT_INDEX);
const SN_PRIVATE_KEY = deriveStarknetPrivateKey(SIGNATURE);
const { address: SN_ADDRESS } = deriveStarknetAccount(SN_PRIVATE_KEY, config.ozClassHash);
// userPrivateKey = the VIEWING key — the pool identity's private key, which is what the
// pool's claim-time recompute proves against (see returnIn.ts).
const EXPECTED_COMMITMENT = deriveInboundCommitment({
  userAddr: BigInt(SN_ADDRESS),
  userPrivateKey: VIEWING_KEY,
  inboundAddr: BigInt(INBOUND),
  sourceDomain: POLYGON_DOMAIN,
  nonce: ACCOUNT_NONCE,
});

let submitGaslessBatch: ReturnType<typeof vi.fn<(calls: unknown[]) => Promise<string>>>;
let prepareFreshReturn: ReturnType<typeof vi.fn<() => Promise<FreshReturnPlan>>>;
let readReturnableBalance: ReturnType<typeof vi.fn<() => Promise<bigint>>>;

function validAttestedMessage(): `0x${string}` {
  return buildCctpMessage({
    sourceDomain: POLYGON_DOMAIN,
    destinationDomain: config.cctp.starknetDomain,
    recipientField64: INBOUND_FIELD64,
  });
}

// Post-burn cursor (single state — no phase). `commitment` matches this identity so
// findInflightReturnByCommitment / the cross-account guard behave realistically.
interface ReturnCursor {
  accountIndex: number;
  burnTx: string;
  sourceDomain: number;
  amount: string;
  commitment: string;
  evmChainId: number;
  inboundAnonymizer?: string;
}
function seedCursor(record: ReturnCursor): void {
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: record }));
}
function readCursor(): ReturnCursor | undefined {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, ReturnCursor>)[EVM_ADDRESS.toLowerCase()];
}
function burnedCursor(overrides: Partial<ReturnCursor> = {}): ReturnCursor {
  return {
    accountIndex: ACCOUNT_INDEX,
    burnTx: '0x0ab12cd34e',
    sourceDomain: POLYGON_DOMAIN,
    amount: FRESH_AMOUNT.toString(),
    commitment: EXPECTED_COMMITMENT.toString(),
    evmChainId: config.polygon.chainId,
    ...overrides,
  };
}

function run(overrides: Partial<Parameters<typeof returnToPool>[0]> = {}) {
  return returnToPool({
    signature: SIGNATURE,
    accountIndex: ACCOUNT_INDEX,
    evmAddress: EVM_ADDRESS,
    prepareFreshReturn,
    readReturnableBalance,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Default is_nonce_used answer: NOT used (the folded claim has not landed yet) so a
  // resume proceeds to claim. The already-claimed test overrides to used.
  callContract.mockImplementation(async (request?: { entrypoint?: string }) =>
    request?.entrypoint === 'is_nonce_used' ? ['0x0'] : ['0', '0'],
  );
  attestedMessage.value = validAttestedMessage();
  waitForAttestation.mockImplementation(async () => ({
    message: attestedMessage.value,
    attestation: ATTESTATION,
  }));
  submitGaslessBatch = vi.fn(async () => BURN_TX);
  prepareFreshReturn = vi.fn(async () => ({
    amount: FRESH_AMOUNT,
    depositWallet: DEPOSIT_WALLET,
    submitGaslessBatch,
  }));
  // Default: the wallet is DRAINED (consistent cursor) so a resume is honored.
  readReturnableBalance = vi.fn(async () => 0n);
  claimToPool.mockResolvedValue({ claimTxHash: '0xc1a1m' });
  buildAndProveClaim.mockResolvedValue(PROVEN);
  submitProvenClaim.mockResolvedValue('0xc1a1m');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('returnToPool — happy path (fresh: convert → burn → attest → folded claim)', () => {
  it('burns via the injected prep, folds the attested message into the claim, clears the cursor', async () => {
    const result = await run();

    // FRESH prep ran (no cursor) and produced the burn + attestation.
    expect(prepareFreshReturn).toHaveBeenCalledTimes(1);
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    expect(waitForAttestation).toHaveBeenCalledTimes(1);

    // returnToPool never uses the sequential claimToPool wrapper — it drives the folded
    // claim directly (buildAndProveClaim → submitProvenClaim).
    expect(claimToPool).not.toHaveBeenCalled();
    expect(buildAndProveClaim).toHaveBeenCalledTimes(1);
    // The claim carries the signature + derived nonce AND the folded CCTP message /
    // attestation / source domain — NO amount/claim_secret/H on this leg.
    const claimArgs = buildAndProveClaim.mock.calls[0][0] as {
      signature: string;
      accountIndex: number;
      accountNonce: bigint;
      message: `0x${string}`;
      attestation: `0x${string}`;
      sourceDomain: number;
    };
    expect(claimArgs.signature).toBe(SIGNATURE);
    expect(claimArgs.accountIndex).toBe(ACCOUNT_INDEX);
    expect(claimArgs.accountNonce).toBe(ACCOUNT_NONCE);
    expect(claimArgs.message).toBe(attestedMessage.value);
    expect(claimArgs.attestation).toBe(ATTESTATION);
    expect(claimArgs.sourceDomain).toBe(POLYGON_DOMAIN);
    expect(claimArgs).not.toHaveProperty('amount');
    // The proven artifact is forwarded UNCHANGED to the submit half.
    expect(submitProvenClaim).toHaveBeenCalledTimes(1);
    expect(submitProvenClaim.mock.calls[0][0]).toBe(PROVEN);

    expect(result).toMatchObject({
      amountReturned: FRESH_AMOUNT,
      claimTxHash: '0xc1a1m',
      ranFreshBurn: true,
    });
    // Cursor cleared on success.
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('carries the SAME real commitment (deriveInboundCommitment) in the burn hookData', async () => {
    await run();
    const calls = submitGaslessBatch.mock.calls[0][0] as { target: string; data: `0x${string}` }[];
    const burnCallData = calls[1].data;
    const expectedHex = EXPECTED_COMMITMENT.toString(16).padStart(64, '0');
    expect(burnCallData.toLowerCase()).toContain(expectedHex);
  });

  it('runs the steps IN ORDER: burn → attest → build proof → submit (proof built AFTER attestation)', async () => {
    await run();
    const burnOrder = submitGaslessBatch.mock.invocationCallOrder[0];
    const attestOrder = waitForAttestation.mock.invocationCallOrder[0];
    const buildOrder = buildAndProveClaim.mock.invocationCallOrder[0];
    const submitOrder = submitProvenClaim.mock.invocationCallOrder[0];
    expect(burnOrder).toBeLessThan(attestOrder);
    // The proof commits the message, so it is built strictly AFTER attestation (no overlap).
    expect(attestOrder).toBeLessThan(buildOrder);
    expect(buildOrder).toBeLessThan(submitOrder);
  });

  it('aborts (no burn/claim) when the fresh prep reports nothing to return', async () => {
    prepareFreshReturn.mockRejectedValueOnce(
      new Error("No returnable USDC on this account's deposit wallet — nothing to return."),
    );
    await expect(run()).rejects.toThrow(/nothing to return/i);
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(buildAndProveClaim).not.toHaveBeenCalled();
    expect(submitProvenClaim).not.toHaveBeenCalled();
  });
});

describe('returnToPool — fail-closed guard (InboundAnonymizer not deployed)', () => {
  it('refuses the WHOLE return before touching the wallet when inboundAnonymizerAddress is the "0x0" placeholder', async () => {
    const original = config.inboundAnonymizerAddress;
    (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = '0x0';
    try {
      await expect(run()).rejects.toThrow(/inboundAnonymizerAddress not configured/i);
      expect(prepareFreshReturn).not.toHaveBeenCalled();
      expect(submitGaslessBatch).not.toHaveBeenCalled();
      expect(buildAndProveClaim).not.toHaveBeenCalled();
    } finally {
      (config as { inboundAnonymizerAddress: string }).inboundAnonymizerAddress = original;
    }
  });
});

describe('returnToPool — FUND-SAFETY', () => {
  it('[cross-account guard] REFUSES a return while a DIFFERENT account is in flight — no burn, no claim, cursor intact', async () => {
    seedCursor(burnedCursor({ accountIndex: ACCOUNT_INDEX + 5, commitment: '999' }));

    await expect(run()).rejects.toThrow(/already in progress/i);

    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(buildAndProveClaim).not.toHaveBeenCalled();
    // The other account's cursor is left intact so it can still be finished.
    expect(readCursor()!.accountIndex).toBe(ACCOUNT_INDEX + 5);
  });

  it('[stale-cursor re-validation] a cursor whose wallet STILL holds funds is DROPPED → fresh path re-sizes + re-burns', async () => {
    // Tiny frozen amount (1n) — what a stale cursor would otherwise claim.
    seedCursor(burnedCursor({ amount: '1' }));
    // Live returnable balance > 0 (funds still on the wallet → the burn never landed).
    readReturnableBalance.mockResolvedValue(2_000_000n);
    prepareFreshReturn.mockResolvedValue({
      amount: 2_000_000n,
      depositWallet: DEPOSIT_WALLET,
      submitGaslessBatch,
    });

    const result = await run();

    expect(prepareFreshReturn).toHaveBeenCalledTimes(1);
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
    // Sized to the REAL balance (2_000_000n), NOT the frozen 1n.
    expect(result.amountReturned).toBe(2_000_000n);
    expect(result.ranFreshBurn).toBe(true);
  });

  it('[resume] a cursor whose wallet is DRAINED is KEPT → attest-only resume, folded claim (no fresh burn)', async () => {
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() }));
    readReturnableBalance.mockResolvedValue(0n); // drained → consistent cursor

    const result = await run();

    // Consistent cursor → resume (no fresh prep, no re-burn): attest off the cursor and
    // run the folded claim on the FROZEN amount.
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(buildAndProveClaim).toHaveBeenCalledTimes(1);
    expect(submitProvenClaim).toHaveBeenCalledTimes(1);
    expect(result.ranFreshBurn).toBe(false);
    expect(result.amountReturned).toBe(FRESH_AMOUNT);
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('[resume — dust leftover] a POST-BURN cursor whose wallet holds only DUST (< frozen amount) is KEPT → resume, NOT dropped on leftover pUSD/USDC.e', async () => {
    // FINDING #3: the return burns only NATIVE USDC; after a successful burn native ≈ 0 but
    // leftover pUSD/USDC.e can keep the injected returnable SUM positive. A `> 0` absolute
    // check would WRONGLY drop this valid post-burn cursor (losing its burnTx). The
    // discriminator must be a DELTA vs the frozen amount: dust (< frozen) ⇒ the burn landed
    // ⇒ resume, never re-size + re-burn.
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() }));
    readReturnableBalance.mockResolvedValue(5_000n); // dust << FRESH_AMOUNT (1_787_670n)

    const result = await run();

    // Resume (attest-only, folded claim) — NO fresh prep / re-burn, cursor survived.
    expect(prepareFreshReturn).not.toHaveBeenCalled();
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(waitForAttestation).toHaveBeenCalledTimes(1);
    expect(buildAndProveClaim).toHaveBeenCalledTimes(1);
    expect(result.ranFreshBurn).toBe(false);
    expect(result.amountReturned).toBe(FRESH_AMOUNT);
  });

  it('[resume — config redeploy] the folded claim targets the BURN-TIME inbound from the cursor, NOT the new config address', async () => {
    // FINDING A: this PR changes config.inboundAnonymizerAddress. An in-flight return's burn
    // pinned mintRecipient/destinationCaller/hookData-commitment to the address at BURN TIME.
    // A resume must claim against THAT contract (the on-chain recompute uses its address →
    // COMMITMENT_MISMATCH otherwise, and the CCTP funds sit on the OLD contract).
    const OLD_INBOUND = '0xdead0000beef';
    expect(OLD_INBOUND).not.toBe(config.inboundAnonymizerAddress); // config is the NEW addr
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString(), inboundAnonymizer: OLD_INBOUND }));
    readReturnableBalance.mockResolvedValue(0n); // drained → resume honored

    await run();

    expect(buildAndProveClaim).toHaveBeenCalledTimes(1);
    const claimArgs = buildAndProveClaim.mock.calls[0][0] as { inbound?: string };
    expect(claimArgs.inbound).toBe(OLD_INBOUND);
    expect(claimArgs.inbound).not.toBe(config.inboundAnonymizerAddress);
  });

  it('[resume — legacy cursor] a cursor WITHOUT inboundAnonymizer falls back to the current config address', async () => {
    // Backward-compat: a cursor written before FINDING A has no `inboundAnonymizer`; the
    // resume falls back to config (correct as long as the address has not changed).
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() })); // no inboundAnonymizer field
    readReturnableBalance.mockResolvedValue(0n);

    await run();

    expect(buildAndProveClaim).toHaveBeenCalledTimes(1);
    const claimArgs = buildAndProveClaim.mock.calls[0][0] as { inbound?: string };
    expect(claimArgs.inbound).toBe(config.inboundAnonymizerAddress);
  });

  it('[fresh] persists the BURN-TIME inbound (current config) into the cursor so a later resume is redeploy-safe', async () => {
    // A reverted claim leaves the cursor intact; observe that the fresh burn recorded the
    // burn-time inbound (= current config) so a resume AFTER a future config change still
    // targets the contract this burn was built against.
    submitProvenClaim.mockRejectedValueOnce(new Error('Transaction REVERTED: transient'));

    await expect(run()).rejects.toThrow(/REVERTED/);

    expect(submitGaslessBatch).toHaveBeenCalledTimes(1); // fresh burn ran
    expect(readCursor()?.inboundAnonymizer).toBe(config.inboundAnonymizerAddress);
  });

  it('[corrupt-cursor drop] a corrupt cursor is discarded → fresh path (never resumed off garbage)', async () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ [EVM_ADDRESS.toLowerCase()]: { burnTx: 123, garbage: true } }),
    );

    await run();

    expect(prepareFreshReturn).toHaveBeenCalledTimes(1);
    expect(submitGaslessBatch).toHaveBeenCalledTimes(1);
  });

  it('[resume] a CONSUMED CCTP nonce ⇒ the folded claim already landed → clears the cursor, no claim, no re-mint', async () => {
    // The folded claim (mint inside it) landed on a prior run/device. The resume must
    // detect the consumed nonce and finish WITHOUT re-proving/re-minting.
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() }));
    callContract.mockImplementation(async (request?: { entrypoint?: string }) =>
      request?.entrypoint === 'is_nonce_used' ? ['0x1'] : ['0', '0'],
    );

    const result = await run();

    expect(buildAndProveClaim).not.toHaveBeenCalled();
    expect(submitProvenClaim).not.toHaveBeenCalled();
    // FINDING #4: signal alreadyClaimed so the app promotes the bid to 'claimed' even when
    // leftover dust keeps the wallet's returnable sum > 0.
    expect(result).toEqual({ amountReturned: 0n, claimTxHash: '', ranFreshBurn: false, alreadyClaimed: true });
    // The stale cursor is gone — later returns for other accounts proceed.
    expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe('{}');
  });

  it('[resume] an is_nonce_used read FAILURE preserves the cursor and propagates (fail-closed, never mistaken for claimed)', async () => {
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() }));
    callContract.mockImplementation(async (request?: { entrypoint?: string }) => {
      if (request?.entrypoint === 'is_nonce_used') throw new Error('RPC down');
      return ['0', '0'];
    });

    await expect(run()).rejects.toThrow(/RPC down/i);
    // A read failure proves nothing → the cursor is PRESERVED for a later resume, and the
    // claim never ran.
    expect(buildAndProveClaim).not.toHaveBeenCalled();
    expect(readCursor()).toMatchObject({ amount: FRESH_AMOUNT.toString() });
  });
});

describe('returnToPool — error propagation', () => {
  it('a CCTP attestation failure propagates and does NOT submit the claim', async () => {
    waitForAttestation.mockRejectedValueOnce(new Error('iris burn boom'));
    await expect(run()).rejects.toThrow(/iris burn boom/i);
    expect(buildAndProveClaim).not.toHaveBeenCalled();
    expect(submitProvenClaim).not.toHaveBeenCalled();
  });

  it('emits (step,error) for the failing step so the app can classify it', async () => {
    submitProvenClaim.mockRejectedValueOnce(new Error('submitAndTrack: timed out'));
    const steps: Array<[ReturnStep, ReturnStepStatus]> = [];
    await expect(run({ onStep: (s, st) => steps.push([s, st]) })).rejects.toThrow(/timed out/i);
    expect(steps).toContainEqual(['claim', 'error']);
  });

  // A rejected folded claim must NOT clear the inflight-return cursor: a reverted folded
  // claim consumes no CCTP nonce (the mint reverts with it), so a resume must be able to
  // replay it. returnToPool only clears the cursor after a RESOLVED submit.
  it('[claim REVERTED] a rejected claim leaves the inflight-return cursor INTACT (no resume cursor destroyed)', async () => {
    seedCursor(burnedCursor({ amount: FRESH_AMOUNT.toString() }));
    submitProvenClaim.mockRejectedValueOnce(
      new Error('Transaction REVERTED: assertion failed (COMMITMENT_MISMATCH)'),
    );

    await expect(run()).rejects.toThrow(/REVERTED/);

    // No fresh burn re-ran (still resuming), and the only resume cursor is STILL PRESENT.
    expect(submitGaslessBatch).not.toHaveBeenCalled();
    expect(readCursor()).toMatchObject({ amount: FRESH_AMOUNT.toString() });
  });
});

describe('returnToPool — secret hygiene (spyOnSecretSinks)', () => {
  it('never logs or persists the raw signature or any derived private key', async () => {
    const sinks = spyOnSecretSinks();
    try {
      await run();
    } finally {
      sinks.restore();
    }
    sinks.assertNeverLeaked(SIGNATURE, SN_PRIVATE_KEY, VIEWING_KEY.toString());
  });
});
