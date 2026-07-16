import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

// Core-level fund-safety tests for fundAccountFromPool() — the composed BUY steps
// 1-2 orchestrator (withdraw + CCTP burn → attest → Forwarding-Service mint) that
// owns the pmp.inflightBurn resume cursor. These are the assertions PORTED from
// the app's BidContext.test.tsx per the §5 test-migration gate — the four
// fund-safety properties that must survive the move into bridge-core:
//   1. no-double-burn on resume  (a valid cursor resumes from attest, NEVER re-burns)
//   2. cross-account guard        (the cursor is keyed per EVM address — funding a
//                                  DIFFERENT account never resumes another's burn)
//   3. corrupt-cursor drop        (a corrupt cursor is discarded → fresh burn)
//   4. clear-on-terminal          (a demonstrably-terminal attest failure clears the
//                                  cursor; any other failure PRESERVES it)
// plus spyOnSecretSinks() proving the raw signature + derived keys are never logged
// or persisted.
//
// The REAL fundAccountFromPool + REAL bridgeOut run; the low-level boundaries reuse
// bridgeOut.test.ts's fakes (SDK builder/factory, provider/account, proving/tx, the
// derivation + H utils), and the attest/mint leg (waitForBridgedMint) + the CCTP fee
// quote (cctpFees) are mocked so no network is touched. The account-index store is
// REAL (localStorage-backed) so index-consume behaviour is exercised. The
// cross-chain legs themselves are live-only (.claude/rules/verification.md).

// ---------------------------------------------------------------------------
// Fixtures (pure — no real keys).
// ---------------------------------------------------------------------------
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const EVM_ADDRESS_2 = '0x2222222222222222222222222222222222222222';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const ACCOUNT_INDEX = 0;
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp

const VIEWING_KEY = 123456789n;
const ACCOUNT_NONCE = 42n;
const CLAIM_SECRET =
  2069452701457285857209401669498930313539255917194012082327558716626330726443n;
const COMMITMENT_H =
  1184640639497699140437908751684073211882192473677451888065106092277727692916n;

const EOA_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EOA_PRIVATE_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const DEPOSIT_WALLET = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Valid 0x-hex burn tx hashes — the in-flight-cursor validator (Bundle A3)
// requires hex, so 'burn'/'dead' vanity strings would be rejected as corrupt.
const BURN_TX = '0xb017'; // the fresh burn hash the execute stub returns
const A2_BURN_TX = '0xa2b011'; // a distinct hash seeded in account 2's cursor
const FORWARD_TX = '0xfeedface' as `0x${string}`;

const INFLIGHT_BURN_KEY = 'pmp.inflightBurn';
const BID_INDEX_KEY = 'pmp.bidIndex';

// ---------------------------------------------------------------------------
// Mocks — mirror bridgeOut.test.ts so the REAL bridgeOut runs under
// fundAccountFromPool with faked network boundaries.
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
  deriveAccountNonce,
  createPrivateTransfers,
  transfers,
  account,
  execute,
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
    deriveStarknetPrivateKey: vi.fn((_signature: string): string => '0xsnpk'),
    deriveStarknetAccount: vi.fn((_privateKey: string, _classHash: string) => ({
      address: '0xacct',
      publicKey: '0xpub',
    })),
    deriveViewingKey: vi.fn((_signature: string): bigint => 123456789n),
    derivePolygonEoa: vi.fn((_signature: string, _index: number) => ({
      privateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    })),
    deriveClaimSecret: vi.fn(
      (_viewingKey: bigint, _nonce: bigint): bigint =>
        2069452701457285857209401669498930313539255917194012082327558716626330726443n,
    ),
    computeClaimH: vi.fn(
      (_args: ClaimHArgs): bigint =>
        1184640639497699140437908751684073211882192473677451888065106092277727692916n,
    ),
    deriveAccountNonce: vi.fn((_viewingKey: bigint, _index: number): bigint => 42n),
    createPrivateTransfers: vi.fn(() => transfers),
    transfers,
    account: { address: '0xacct', execute, getNonce: vi.fn(async () => '0x0') },
    execute,
  };
});

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  derivePolygonEoa,
  deriveClaimSecret,
  computeClaimH,
  deriveAccountNonce,
}));

// The privacy_invoke(BuyParams) calldata the REAL bridgeOut hands the SDK builder,
// captured from the last .invoke() so a test can read the burn's declared
// min_finality_threshold (calldata[6]) — mirrors bridgeOut.test.ts's invokeResult.
let lastInvokeCalldata: unknown[] | undefined;

// calldata entries are decimal/hex strings or bigints; normalize for comparison.
function asBig(felt: unknown): bigint {
  return typeof felt === 'bigint' ? felt : BigInt(felt as string);
}

// SDK fluent builder recorder (mirrors bridgeOut.test.ts).
function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.with = vi.fn((_token: string, fn?: (t: typeof builder) => unknown) => {
    if (fn) fn(builder);
    return builder;
  });
  builder.inputs = vi.fn(() => builder);
  builder.withdraw = vi.fn(() => builder);
  builder.surplusTo = vi.fn(() => builder);
  builder.invoke = vi.fn((cb: () => { contractAddress: string; calldata: unknown[] }) => {
    lastInvokeCalldata = cb().calldata;
    return builder;
  });
  builder.done = vi.fn(() => builder);
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers,
  IndexerDiscoveryProvider: class {},
}));

// bridgeOut (fresh-burn path) now reads the in-pool balance to enforce the
// fee-buffer gate. Stub it AMPLE so these tests clear the gate; keep the rest of
// ./discover real (deposit.ts in this graph imports formatUsdcCents from here).
const { discoverPrivateBalance } = vi.hoisted(() => ({
  discoverPrivateBalance: vi.fn(async (): Promise<bigint> => 1_000_000_000n), // 1000 USDC
}));
vi.mock('./discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./discover')>()),
  discoverPrivateBalance,
}));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn() }),
  makeAccount: () => account,
}));

vi.mock('./proving', () => ({
  waitForProvingBlock: vi.fn(async () => 'block-1'),
  getCurrentBlock: vi.fn(async () => 1),
  // proveAndSubmitBridgeOut imports these to pick the proving depth (FIX 2).
  PROVING_BLOCK_DEPTH: 8,
  IMMEDIATE_PROVING_BLOCK_DEPTH: 12,
  // The proven-submit node-lag retry (nodeLagRetry.ts) classifies every submit failure via
  // isNodeLagError; real regex here so this suite's non-lag failure paths rethrow as before.
  isNodeLagError: (err: unknown) =>
    /block hash mismatch[\s\S]*?stored block hash:\s*(?:0x)?0+\b/i.test(
      err instanceof Error ? err.message : String(err),
    ),
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: vi.fn(
    async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
      const r = await send();
      return { transactionHash: r.transaction_hash, blockNumber: 1 };
    },
  ),
  // Real regex (dedupe sweep moved this into tx.ts): proveAndSubmitBridgeOut's retry
  // guard classifies REVERTED/REJECTED via this predicate.
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

vi.mock('./config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return {
    ...actual,
    config: { ...actual.config, anonymizerAddress: '0xANON', poolAddress: '0x1' },
  };
});

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

// The attest → forwarded-mint leg: controllable so a test can drive success, a
// TERMINAL Iris status, or a transient error. Also the CCTP fee quote (mocked so
// no network + a deterministic floor pass).
const { waitForBridgedMint } = vi.hoisted(() => ({ waitForBridgedMint: vi.fn() }));
vi.mock('./polygonMint', () => ({
  waitForBridgedMint,
  // Real regex (dedupe sweep moved this into polygonMint.ts): fundAccountFromPool's
  // clear-on-terminal guard classifies a demonstrably-terminal attest failure via
  // this predicate.
  isTerminalAttestFailure: (err: unknown) =>
    /attestation failed|recipient\/domain mismatch/i.test(
      err instanceof Error ? err.message : String(err),
    ),
}));

const { fetchForwardMaxFee, assertAboveForwardFloor } = vi.hoisted(() => ({
  fetchForwardMaxFee: vi.fn(),
  assertAboveForwardFloor: vi.fn(),
}));
vi.mock('./cctpFees', () => ({
  fetchForwardMaxFee,
  assertAboveForwardFloor,
  FAST_FINALITY_THRESHOLD: 1000,
  STANDARD_FINALITY_THRESHOLD: 2000,
}));

import { fundAccountFromPool, readInflightBurn } from './bridgeOut';
import { config } from './config';
import { invalidateManagerNonce } from './proven-submit';
import { submitAndTrack } from './tx';

const mSubmitAndTrack = vi.mocked(submitAndTrack);
const FEE_QUOTE = { maxFee: 14_000n, forwardFee: 10_000n, protocolFee: 4_000n, finalityThreshold: 2000 };

// A valid post-migration in-flight burn cursor (has depositWallet → the
// Forwarding-Service resume path).
function validCursor(
  overrides: Partial<{
    burnTxHash: string;
    eoaAddress: string;
    depositWallet: string;
    bidIndex: number;
    amountHuman: string;
  }> = {},
) {
  return {
    burnTxHash: BURN_TX,
    eoaAddress: EOA_ADDRESS,
    depositWallet: DEPOSIT_WALLET,
    bidIndex: 0,
    amountHuman: '1',
    ...overrides,
  };
}

function seedCursor(address: string, record: object): void {
  localStorage.setItem(INFLIGHT_BURN_KEY, JSON.stringify({ [address.toLowerCase()]: record }));
}

const resolveSignature = vi.fn(async () => SIGNATURE);
const resolveDepositWallet = vi.fn(async (_sig: string, _idx: number) => DEPOSIT_WALLET);

function fund(
  overrides: Partial<Parameters<typeof fundAccountFromPool>[0]> = {},
): Promise<Awaited<ReturnType<typeof fundAccountFromPool>>> {
  return fundAccountFromPool({
    resolveSignature,
    accountIndex: ACCOUNT_INDEX,
    amount: AMOUNT,
    evmAddress: EVM_ADDRESS,
    resolveDepositWallet,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  lastInvokeCalldata = undefined;
  invalidateManagerNonce();
  transfers.build.mockImplementation(() => makeBuilder());
  execute.mockResolvedValue({ transaction_hash: BURN_TX });
  deriveViewingKey.mockReturnValue(VIEWING_KEY);
  deriveAccountNonce.mockReturnValue(ACCOUNT_NONCE);
  derivePolygonEoa.mockReturnValue({ privateKey: EOA_PRIVATE_KEY, address: EOA_ADDRESS });
  deriveClaimSecret.mockReturnValue(CLAIM_SECRET);
  computeClaimH.mockReturnValue(COMMITMENT_H);
  resolveSignature.mockResolvedValue(SIGNATURE);
  resolveDepositWallet.mockResolvedValue(DEPOSIT_WALLET);
  // Mirror the real fetchForwardMaxFee: the quote's finalityThreshold reflects the
  // requested tier (Fast 1000 / Standard 2000), so bridgeOut's fee/finality
  // burn-boundary guard sees a matching pair on both the fast and standard paths.
  fetchForwardMaxFee.mockImplementation(
    async (_amount: bigint, opts?: { fast?: boolean }) => ({
      ...FEE_QUOTE,
      finalityThreshold: opts?.fast ? 1000 : 2000,
    }),
  );
  assertAboveForwardFloor.mockReturnValue(undefined);
  waitForBridgedMint.mockResolvedValue({
    forwardTxHash: FORWARD_TX,
    message: '0xmsg',
    attestation: '0xatt',
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('fundAccountFromPool — happy path (fresh burn)', () => {
  it('signs, burns (one SN tx), attests + mints, returns the funding + clears the cursor', async () => {
    const result = await fund();

    // Signed once; the account nonce was derived from the viewing key + index and
    // is what bridgeOut consumed (the app derives NO H/claim-secret itself).
    expect(resolveSignature).toHaveBeenCalledTimes(1);
    expect(deriveAccountNonce).toHaveBeenCalledWith(VIEWING_KEY, ACCOUNT_INDEX);
    // Exactly one burn submit (fee=0 → no fee-approve; one proven withdraw+burn).
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
    // The attest+mint leg was gated on the deposit wallet (A1 recipient gate).
    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][0]).toBe(BURN_TX);
    expect(waitForBridgedMint.mock.calls[0][1].expectedMintRecipient).toBe(DEPOSIT_WALLET);

    expect(result).toMatchObject({
      burnTxHash: BURN_TX,
      eoaAddress: EOA_ADDRESS,
      depositWallet: DEPOSIT_WALLET,
      commitmentH: COMMITMENT_H,
      forwardTxHash: FORWARD_TX,
    });
    // Index consumed after the successful burn; cursor cleared on success.
    expect(JSON.parse(localStorage.getItem(BID_INDEX_KEY)!)[EVM_ADDRESS.toLowerCase()]).toBe(1);
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBe('{}');
  });

  it('consumes on the channel named by channel, leaving the default counter untouched', async () => {
    // Funding from a separate channel advances THAT channel's counter
    // (`pmp.bidIndex:<id>`) and never the default `pmp.bidIndex`, so a channel fund
    // can't poison normal bidding. The index band (2^48+) is the caller's choice.
    const reservedIndex = 2 ** 48 + 3;
    const result = await fund({ channel: 'fast-session', accountIndex: reservedIndex });
    // The result echoes the channel so the app records the account under it...
    expect(result.channel).toBe('fast-session');
    // The channel's counter now points PAST this fund's index...
    expect(
      JSON.parse(localStorage.getItem('pmp.bidIndex:fast-session')!)[EVM_ADDRESS.toLowerCase()],
    ).toBe(reservedIndex + 1);
    // ...and the default per-account counter is NOT written (no cross-channel poison).
    expect(localStorage.getItem(BID_INDEX_KEY)).toBeNull();
    // The rest of the fund is unaffected — cursor still cleared on success.
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBe('{}');
  });

  it('does NOT consume the index when the burn leg fails (retry reuses the same index)', async () => {
    execute.mockRejectedValue(new Error('withdraw reverted'));
    await expect(fund()).rejects.toThrow();
    // No index burned by a failed bridge — the store is untouched.
    expect(localStorage.getItem(BID_INDEX_KEY)).toBeNull();
  });

  it('#232: persists the resume cursor BEFORE consuming the index (never the reverse)', async () => {
    // Pre-fix, consumeAccountIndex ran first — an interruption/failure landing
    // between the two writes leaves the index consumed with NO cursor recorded,
    // orphaning the just-burned EOA/deposit wallet (no resume path ever revisits
    // that index again). Assert the durable write order directly.
    const writeOrder: string[] = [];
    const realSetItem = Storage.prototype.setItem;
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === INFLIGHT_BURN_KEY || key === BID_INDEX_KEY) writeOrder.push(key);
        realSetItem.call(this, key, value);
      });
    try {
      await fund();
    } finally {
      spy.mockRestore();
    }
    expect(writeOrder.indexOf(INFLIGHT_BURN_KEY)).toBeGreaterThanOrEqual(0);
    expect(writeOrder.indexOf(BID_INDEX_KEY)).toBeGreaterThanOrEqual(0);
    // Pre-fix: writeOrder is [BID_INDEX_KEY, INFLIGHT_BURN_KEY]. FAILS.
    expect(writeOrder.indexOf(INFLIGHT_BURN_KEY)).toBeLessThan(writeOrder.indexOf(BID_INDEX_KEY));
  });

  it('fails on the bridge step BEFORE burning when below the forwarding-fee floor', async () => {
    assertAboveForwardFloor.mockImplementationOnce(() => {
      throw new Error('Amount is below the CCTP forwarding-fee floor.');
    });
    await expect(fund()).rejects.toThrow(/forwarding-fee floor/i);
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    expect(localStorage.getItem(BID_INDEX_KEY)).toBeNull();
  });
});

describe('fundAccountFromPool — per-call CCTP finality tier (fast)', () => {
  // The burn declares min_finality_threshold as calldata[6] of privacy_invoke(BuyParams):
  // [mr_lo, mr_hi, amt_lo, amt_hi, fee_lo, fee_hi, finality, dest_domain].
  const FAST_FINALITY = 1000n;
  const STANDARD_FINALITY = 2000n;

  it('fast:true quotes Fast and burns Fast finality (1000)', async () => {
    await fund({ fast: true });
    // Pre-burn fee quote requested for the Fast tier.
    expect(fetchForwardMaxFee).toHaveBeenCalledWith(
      AMOUNT,
      expect.objectContaining({ fast: true }),
    );
    // The burn's declared min_finality_threshold matches (fund-safety: quote + burn agree).
    expect(lastInvokeCalldata).toBeDefined();
    expect(asBig(lastInvokeCalldata![6])).toBe(FAST_FINALITY);
  });

  it('fast:false quotes Standard and burns Standard finality (2000)', async () => {
    await fund({ fast: false });
    expect(fetchForwardMaxFee).toHaveBeenCalledWith(
      AMOUNT,
      expect.objectContaining({ fast: false }),
    );
    expect(asBig(lastInvokeCalldata![6])).toBe(STANDARD_FINALITY);
  });

  it('omitted falls back to config.cctp.fast for both the quote and the burn', async () => {
    await fund();
    const expectedFast = config.cctp.fast;
    expect(fetchForwardMaxFee).toHaveBeenCalledWith(
      AMOUNT,
      expect.objectContaining({ fast: expectedFast }),
    );
    expect(asBig(lastInvokeCalldata![6])).toBe(expectedFast ? FAST_FINALITY : STANDARD_FINALITY);
  });
});

describe('fundAccountFromPool — FUND-SAFETY (ported from BidContext.test.tsx)', () => {
  it('[no-double-burn on resume] a valid cursor resumes from attest and NEVER re-burns', async () => {
    seedCursor(EVM_ADDRESS, validCursor());

    const result = await fund();

    // Resume: no re-sign, no fee quote, and CRUCIALLY no burn submit.
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(fetchForwardMaxFee).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    // Attest+mint ran off the CURSOR's burn tx + recipient (authoritative on resume).
    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][0]).toBe(BURN_TX);
    expect(waitForBridgedMint.mock.calls[0][1].expectedMintRecipient).toBe(DEPOSIT_WALLET);
    expect(result.forwardTxHash).toBe(FORWARD_TX);
    // Cursor cleared after the resumed mint completes.
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBe('{}');
  });

  it('[no-double-burn on resume] a transient mint error PRESERVES the cursor without re-burning', async () => {
    seedCursor(EVM_ADDRESS, validCursor());
    waitForBridgedMint.mockRejectedValueOnce(new Error('waitForForwardedMint: timed out'));

    await expect(fund()).rejects.toThrow(/timed out/i);
    // Never re-burned; the cursor is preserved so the next run resumes.
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    expect(readInflightBurn(EVM_ADDRESS)?.burnTxHash).toBe(BURN_TX);
  });

  it('[cross-account guard] funding a DIFFERENT EVM address never resumes another account\'s burn', async () => {
    // Account 2 has an in-flight burn; funding account 1 (fresh) must burn its own
    // and never touch account 2's cursor (the cursor is keyed per EVM address).
    seedCursor(EVM_ADDRESS_2, validCursor({ burnTxHash: A2_BURN_TX }));

    await fund({ evmAddress: EVM_ADDRESS });

    // Account 1 burned fresh (signed + one burn submit); the mint ran off the FRESH
    // burn hash, NOT account 2's.
    expect(resolveSignature).toHaveBeenCalledTimes(1);
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
    expect(waitForBridgedMint.mock.calls[0][0]).toBe(BURN_TX);
    expect(waitForBridgedMint.mock.calls[0][0]).not.toBe(A2_BURN_TX);
    // Account 2's cursor is untouched.
    expect(readInflightBurn(EVM_ADDRESS_2)?.burnTxHash).toBe(A2_BURN_TX);
    // Account 1 completed and cleared only its own entry.
    expect(readInflightBurn(EVM_ADDRESS)).toBeNull();
  });

  it('[corrupt-cursor drop] a corrupt cursor is discarded → fresh burn (never resumed off garbage)', async () => {
    // A half-written cursor (bad bidIndex) must NOT be resumed — that would poll a
    // bad Iris URL / mint to garbage. Treat it as a fresh funding + purge it.
    seedCursor(EVM_ADDRESS, { burnTxHash: '0xdead', bidIndex: 'not-a-number' });

    await fund();

    // Re-signed + re-burned fresh (did NOT resume the corrupt cursor).
    expect(resolveSignature).toHaveBeenCalledTimes(1);
    expect(mSubmitAndTrack).toHaveBeenCalledTimes(1);
    // The fresh run completed and the (now valid) cursor was cleared on success —
    // the corrupt entry never poisoned the run.
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBe('{}');
  });

  it('[clear-on-terminal] a demonstrably-terminal attest failure CLEARS the cursor', async () => {
    seedCursor(EVM_ADDRESS, validCursor());
    waitForBridgedMint.mockRejectedValue(
      new Error('CCTP attestation failed (Iris status "failed") for burn 0xburn.'),
    );

    await expect(fund()).rejects.toThrow(/attestation failed/i);
    // Terminal → cursor cleared (the funds will never mint here; resume can't help).
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBe('{}');
    expect(readInflightBurn(EVM_ADDRESS)).toBeNull();
  });

  it('[clear-on-terminal] a NON-terminal attest error PRESERVES the resume cursor', async () => {
    seedCursor(EVM_ADDRESS, validCursor());
    waitForBridgedMint.mockRejectedValue(new Error('Unexpected attest error: gas estimation failed'));

    await expect(fund()).rejects.toThrow(/gas estimation/i);
    // Not the demonstrably-terminal status → the burn is replayable, cursor kept.
    expect(readInflightBurn(EVM_ADDRESS)?.burnTxHash).toBe(BURN_TX);
  });

  it('[reverted burn] a mined-but-REVERTED withdraw+burn writes NO cursor and does NOT consume the index', async () => {
    // submitAndTrack calls send() (which sets burnTxHash inside proveAndSubmitBridgeOut
    // from the execute result) then throws a REVERTED status: the withdraw+burn
    // reverted ATOMICALLY, so NO CCTP burn happened and the funds are still in the
    // pool. The retry guard must NOT treat the reverted hash as an in-flight burn —
    // returning it would consume the index + persist a resume cursor that can never
    // re-burn, bricking the account. Both the first attempt and the (nonce-cache)
    // retry revert, so bridgeOut rejects and fundAccountFromPool never persists.
    // Applies to BOTH the first attempt and the nonce-cache retry (both revert);
    // .mockImplementationOnce ×2 auto-drains so it never leaks into later tests.
    const revertOnce = async (
      _provider: unknown,
      send: () => Promise<{ transaction_hash: string }>,
    ): Promise<never> => {
      const r = await send(); // side-effect: sets burnTxHash inside attempt()
      throw new Error(`submitAndTrack: ${r.transaction_hash} REVERTED: withdraw failed`);
    };
    mSubmitAndTrack.mockImplementationOnce(revertOnce).mockImplementationOnce(revertOnce);

    await expect(fund()).rejects.toThrow(/REVERTED/i);

    // No in-flight cursor written for a burn that never happened → the account is
    // NOT bricked; a retry re-runs the fresh burn path.
    expect(localStorage.getItem(INFLIGHT_BURN_KEY)).toBeNull();
    expect(readInflightBurn(EVM_ADDRESS)).toBeNull();
    // The index was NOT consumed (the burn didn't land) so the retry reuses it.
    expect(localStorage.getItem(BID_INDEX_KEY)).toBeNull();
    // Attest/mint never ran (there is no in-flight burn to attest).
    expect(waitForBridgedMint).not.toHaveBeenCalled();
  });

  it('[persisted dest chain] a resume gates the mint-watch on the burn\'s PERSISTED chain, not a conflicting arg', async () => {
    // Finding 3: the cursor burned toward Base (evmChainId 84532, CCTP domain 6). A
    // resume passes a CONFLICTING destChainId arg (Polygon Amoy 80002, domain 7). The
    // mint-watch MUST use the burn's PERSISTED domain (6) — using the arg's domain (7)
    // would gate on the wrong domain, throw "recipient/domain mismatch", and CLEAR the
    // cursor → stranded funds.
    seedCursor(EVM_ADDRESS, validCursor({ evmChainId: 84532 }));

    await fund({ destChainId: 80002 });

    expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
    // Base's domain (persisted), NOT Polygon's (the conflicting arg).
    expect(waitForBridgedMint.mock.calls[0][1].destinationDomain).toBe(6);
    expect(waitForBridgedMint.mock.calls[0][1].destinationDomain).not.toBe(7);
  });

  it('[fresh burn] persists the destination chain on the cursor so a later resume is authoritative', async () => {
    // The fresh path must RECORD evmChainId on the cursor (Finding 3) — otherwise a
    // resume has no persisted chain to resolve the domain from. Burn to Base; the
    // written cursor must carry evmChainId 84532.
    // waitForBridgedMint hangs so the cursor is observable mid-flight (before clear).
    let release!: () => void;
    waitForBridgedMint.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ forwardTxHash: FORWARD_TX, message: '0x', attestation: '0x' }); }),
    );
    const p = fund({ destChainId: 84532 });
    await vi.waitFor(() => expect(readInflightBurn(EVM_ADDRESS)?.evmChainId).toBe(84532));
    release();
    await p;
  });

  it('[legacy cursor] a pre-migration cursor (no depositWallet) fails terminally without polling the mint', async () => {
    seedCursor(EVM_ADDRESS, {
      burnTxHash: BURN_TX,
      eoaAddress: EOA_ADDRESS,
      // depositWallet ABSENT — pre-Forwarding-Service burn.
      bidIndex: 0,
      amountHuman: '1',
    });

    await expect(fund()).rejects.toThrow(/deposit-wallet upgrade/i);
    // Never polled the mint (no 30-min timeout) and never re-burned.
    expect(waitForBridgedMint).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
    // Cursor PRESERVED — the user retains the burn tx hash for manual recovery.
    expect(readInflightBurn(EVM_ADDRESS)?.burnTxHash).toBe(BURN_TX);
  });
});

describe('fundAccountFromPool — storage double-spend guard (A2, ported from BidContext.test.tsx)', () => {
  it('[refuse-to-burn] throws BEFORE signing/burning when localStorage cannot persist the resume cursor', async () => {
    // FRESH-path pre-flight (assertStorageWritable): prove storage accepts a
    // write+read-back BEFORE burning. If setItem throws (private-browsing / disabled
    // storage / quota), a resume cursor written AFTER the burn would silently vanish
    // and a reload could re-burn (double pool withdrawal). So funding must throw a
    // TERMINAL error BEFORE the signature is requested and BEFORE any burn submit.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      await expect(fund()).rejects.toThrow(/storage is unavailable/i);
    } finally {
      spy.mockRestore();
    }
    // Never signed, never quoted the CCTP fee, never burned.
    expect(resolveSignature).not.toHaveBeenCalled();
    expect(fetchForwardMaxFee).not.toHaveBeenCalled();
    expect(mSubmitAndTrack).not.toHaveBeenCalled();
  });

  it('[post-burn cursor drop] completes the mint and warns "do NOT reload" when only the cursor write is lost', async () => {
    // The storage probe + index write succeed, but the INFLIGHT_BURN_KEY write is
    // silently dropped (e.g. the cursor payload trips a quota the tiny probe did
    // not). The burn already committed the funds to CCTP, so the flow must NOT abort
    // — it proceeds to attest+mint and surfaces a NON-fatal "do NOT reload" warning
    // on the bridge 'done' step so the user doesn't reload and re-burn.
    const realSetItem = Storage.prototype.setItem;
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === INFLIGHT_BURN_KEY) return; // drop ONLY the cursor write
        realSetItem.call(this, key, value);
      });
    const steps: Array<[string, string, string | undefined]> = [];
    try {
      const result = await fund({ onStep: (s, st, d) => steps.push([s, st, d]) });
      // The flow proceeded past the failed cursor write all the way to the mint.
      expect(waitForBridgedMint).toHaveBeenCalledTimes(1);
      expect(result.forwardTxHash).toBe(FORWARD_TX);
    } finally {
      spy.mockRestore();
    }
    // The 'bridge','done' step carried the non-fatal do-NOT-reload warning.
    const bridgeDone = steps.find(([s, st]) => s === 'bridge' && st === 'done');
    expect(bridgeDone?.[2]).toMatch(/do NOT reload/i);
  });
});

describe('fundAccountFromPool — secret hygiene (spyOnSecretSinks)', () => {
  it('never logs or persists the raw signature or any derived private key', async () => {
    const sinks = spyOnSecretSinks();
    try {
      await fund();
    } finally {
      sinks.restore();
    }
    // The raw signature, the derived per-account EOA private key, and the viewing
    // key must never reach console/localStorage/sessionStorage.
    sinks.assertNeverLeaked(SIGNATURE, EOA_PRIVATE_KEY, VIEWING_KEY.toString());
  });
});
