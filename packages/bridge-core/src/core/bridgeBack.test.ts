// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Contract test for claimToPool() — the RETURN leg's ONE Starknet step (privacy-
// compute, no sub-accounts): a proven pool apply_actions that creates a destination
// open note for the submitter and a `ComputeAndInvoke` ->
// InboundAnonymizer.privacy_compute(identity_key, dapp_name, nonce) ->
// privacy_invoke_with_computation(commitment, note_id), binding the freshly-created
// open note's id into `invoke_additional_data`.
//
// Expectations are derived from the FROZEN Cairo interface (inbound_anonymizer.cairo
// privacy_compute/privacy_invoke_with_computation) + the SDK note-binding semantics
// (transfer(Open) => CreateOpenNote => openNotes[0].noteId) + the SDK's
// ComputeAndInvoke dataBuilder contract, NOT from the implementation:
//   - the claim builds ONE proven apply_actions: surplusTo(account), a
//     transfer({recipient: account, amount: Open}) on the deposit token (the only
//     builder action that compiles to a CreateOpenNote — see builders.js/compiler.js),
//     and ONE computeAndInvoke(inboundAnonymizerAddress, dataBuilder) whose
//     dataBuilder returns compute_additional_data = [RETURN_DAPP_NAME, sourceDomain, accountNonce]
//     and invoke_additional_data = [noteId] where noteId is the openNotes[0].noteId
//     created in the SAME build;
//   - there is NO claim_secret, NO H, NO caller-supplied amount anywhere on this leg
//     (the ledger drains fully — the amount is not client-chosen);
//   - the viewing key / SN private key / signature are NEVER logged.
//
// Every boundary is mocked: the SDK builder/factory (incl. the `Open` symbol and
// `RETURN_DAPP_NAME`), the RPC provider + account, proving/tx helpers, and the
// shared derive utils. Mirrors bridgeOut.test.ts.

// ---------------------------------------------------------------------------
// Fixtures (pure — no real keys).
// ---------------------------------------------------------------------------
const SIGNATURE = '0xsig';
const ACCOUNT_INDEX = 3;
const ACCOUNT_NONCE = 42n;

const VIEWING_KEY = 123456789n;
const SN_PRIVATE_KEY = '0xsnpk';

// The destination open note's id, injected by the SDK builder mock's
// .computeAndInvoke() context — the id of the CreateOpenNote produced in the SAME build.
const NOTE_ID = 0xdeadbeefn;
const TOKEN = '0xdeadbeef';

const INBOUND = '0xINBOUND';
const POOL_ADDRESS = '0x1'; // matches vitest.config.ts VITE_PRIVACY_POOL_ADDRESS

const CLAIM_TX_HASH = '0xclaim';

// The CCTP message + attestation folded into the claim (the pre-flight
// assertReturnCctpMessage gate is mocked as a no-op below, so any hex blob works — only
// encodeCctpBytes's deterministic serialization matters for the invoke_additional_data
// assertion). SOURCE_DOMAIN is threaded to the (mocked) pre-flight gate.
const MESSAGE = '0xdeadbeefcafe' as `0x${string}`;
const ATTESTATION = '0xabcdef0123456789' as `0x${string}`;
const SOURCE_DOMAIN = 7;

// Shared claim args (the folded claim now REQUIRES message/attestation/sourceDomain).
const CLAIM_ARGS = {
  signature: SIGNATURE,
  accountIndex: ACCOUNT_INDEX,
  accountNonce: ACCOUNT_NONCE,
  message: MESSAGE,
  attestation: ATTESTATION,
  sourceDomain: SOURCE_DOMAIN,
};

// ---------------------------------------------------------------------------
// Mock: shared key-derivation utils. claimToPool must recover the SN account +
// viewing key from the signature; it derives NO claim_secret/H on this leg.
//
// vi.hoisted runs the spy declarations before the hoisted vi.mock factories so
// the factories can safely close over them (mirrors bridgeOut.test.ts).
// ---------------------------------------------------------------------------
const {
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  RETURN_DAPP_NAME,
  createPrivateTransfers,
  transfers,
  account,
  execute,
  Open,
  managerExecute,
  submitProvenCall,
  invalidateManagerNonce,
  paymasterBuildLeg,
  paymasterExecuteLeg,
} = vi.hoisted(() => {
  // `Open` + the proven-submit spies are hoisted with the other closed-over
  // values so the hoisted SDK / ./proven-submit vi.mock factories can reference
  // them without hitting the temporal dead zone.
  const Open = Symbol('Open');
  // Fixture felt — the real value is pinned in derivation/inbound-commitment.test.ts.
  const RETURN_DAPP_NAME = 987654321n;
  const managerExecute = vi.fn(
    async (
      _provider: unknown,
      _call: { contractAddress: string; entrypoint: string; calldata: unknown[] },
      _opts?: unknown,
    ) => ({ transaction_hash: '0xpoke' }),
  );
  const submitProvenCall = vi.fn(async () => ({ transaction_hash: '0xclaim' }));
  const invalidateManagerNonce = vi.fn();
  // Default: no fee_action (manager path / sponsored). The paymaster fee-injection
  // test overrides paymasterBuildLeg to return a non-zero fee_action.
  const paymasterBuildLeg = vi.fn(async () => ({
    type: 'apply_action',
    parameters: {},
    opts: {},
    feeAction: undefined as undefined | { recipient: string; token: string; amount: string },
  }));
  const paymasterExecuteLeg = vi.fn(async () => ({ transaction_hash: '0xclaim_pm' }));
  const execute = vi.fn(async () => ({ transaction_hash: '0xclaim' }));
  const transfers = {
    build: vi.fn(),
    executeWithInvocation: vi.fn(async () => ({
      callAndProof: {
        call: { contractAddress: '0xINBOUND', calldata: [] },
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
    RETURN_DAPP_NAME,
    createPrivateTransfers: vi.fn(() => transfers),
    transfers,
    // getNonce: the manager-nonce manager reads it ONCE to seed its local counter
    // on the first manager submit (the fee-approve / proven claim).
    account: { address: '0xacct', execute, getNonce: vi.fn(async () => '0x0') },
    execute,
    Open,
    managerExecute,
    submitProvenCall,
    invalidateManagerNonce,
    paymasterBuildLeg,
    paymasterExecuteLeg,
  };
});

vi.mock('../derivation/index', () => ({
  deriveStarknetPrivateKey,
  deriveStarknetAccount,
  deriveViewingKey,
  RETURN_DAPP_NAME,
  deriveAccountNonce: () => 7n,
  deriveInboundCommitment: () => 0x1234n,
}));

// ---------------------------------------------------------------------------
// Mock: SDK. The builder is a fluent recorder — each terminal records the args
// claimToPool passed. .computeAndInvoke() captures the dataBuilder and runs it with
// a realistic ComputeAndInvokeCalldataBuilderArgs ({ openNotes: [{ noteId, token }],
// ... }) so the test can inspect the returned compute/invoke_additional_data and
// assert note_id binding. `Open` is exported as a Symbol so the test asserts
// transfer was called with the SAME identity claimToPool imports (proves the
// CreateOpenNote path, not a numeric deposit which would compile to CreateEncNote
// and never surface in openNotes).
// (`Open` is declared in the vi.hoisted block above so the hoisted mock factory
// can close over it.)
// ---------------------------------------------------------------------------

let transferArgs: { recipient: string; amount: unknown } | undefined;
let withdrawArgs: { recipient: string; amount: unknown } | undefined;
let computeAndInvokeContract: string | undefined;
type ComputeAndInvokeDetails = {
  contractAddress: string;
  computeAdditionalData: bigint[];
  invokeAdditionalData: bigint[];
};
let computeAndInvokeCallback:
  | ((ctx: {
      openNotes: { noteId: bigint; token: string }[];
      withdrawals: unknown[];
      poolAddress: string;
    }) => ComputeAndInvokeDetails)
  | undefined;
let computeAndInvokeResult: ComputeAndInvokeDetails | undefined;
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
  builder.transfer = vi.fn((a: { recipient: string; amount: unknown }) => {
    transferArgs = a;
    return builder;
  });
  builder.withdraw = vi.fn((a: { recipient: string; amount: unknown }) => {
    withdrawArgs = a;
    return builder;
  });
  builder.deposit = vi.fn(() => builder);
  builder.surplusTo = vi.fn((a: string) => {
    surplusToArg = a;
    return builder;
  });
  builder.computeAndInvoke = vi.fn(
    (
      cb: (ctx: {
        openNotes: { noteId: bigint; token: string }[];
        withdrawals: unknown[];
        poolAddress: string;
      }) => ComputeAndInvokeDetails,
    ) => {
      computeAndInvokeCallback = cb;
      // The SDK passes the CreateOpenNote(s) of THIS build with their noteId.
      computeAndInvokeResult = cb({
        openNotes: [{ noteId: NOTE_ID, token: TOKEN }],
        withdrawals: [],
        poolAddress: POOL_ADDRESS,
      });
      // Published rc.3 API: the target contract address is carried IN the returned
      // details (contractAddress), not as a separate first arg.
      computeAndInvokeContract = computeAndInvokeResult.contractAddress;
      return builder;
    },
  );
  builder.done = vi.fn(() => builder);
  builder.createProofInvocation = vi.fn(async () => ({ invocation: true }));
  return builder;
}

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers,
  IndexerDiscoveryProvider: class {},
  Open,
}));

// ---------------------------------------------------------------------------
// Mock: provider / account / proving / tx / proven-submit. (managerExecute /
// submitProvenCall / invalidateManagerNonce spies are declared in the vi.hoisted
// block above so the hoisted ./proven-submit factory can close over them.)
// ---------------------------------------------------------------------------
vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract: vi.fn(async () => ['0x0']) }),
  makeAccount: () => account,
}));

// Hoisted spies so a test can assert the proving ANCHOR proveAndSubmitClaim hands to
// waitForProvingBlock. getCurrentBlock returns a distinctive head (7) so the anchor-
// seeding fix (undefined → head) is unambiguous.
const { waitForProvingBlockSpy, getCurrentBlockSpy } = vi.hoisted(() => ({
  waitForProvingBlockSpy: vi.fn(async () => 'block-1'),
  getCurrentBlockSpy: vi.fn(async () => 7),
}));
vi.mock('./proving', () => ({
  waitForProvingBlock: waitForProvingBlockSpy,
  getCurrentBlock: getCurrentBlockSpy,
  IMMEDIATE_PROVING_BLOCK_DEPTH: 12,
  PROVING_BLOCK_DEPTH: 8,
  // Real semantics: a proof-freshness revert carries these codes in its message.
  isProofExpiredError: (err: unknown) =>
    /PROOF_EXPIRED|INVALID_BASE_BLOCK_NUMBER/.test(
      err instanceof Error ? err.message : String(err),
    ),
  // Real regex (proving.ts NODE_LAG_RE): a full-node-lag ValidationFailure with a ZERO
  // stored base-block hash. The node-lag claim-retry gates on this.
  isNodeLagError: (err: unknown) =>
    /block hash mismatch[\s\S]*?stored block hash:\s*(?:0x)?0+\b/i.test(
      err instanceof Error ? err.message : String(err),
    ),
  // Instant sleep so the bounded node-lag retry loop runs without wall-clock delay.
  sleep: () => Promise.resolve(),
}));

// Discovery-at-block helper (the prove-early quiescence gate — mirrors bridgeOut.test.ts).
// Hoisted spy so each test controls the note-id sets returned at `immediateBase` vs head.
// Default: IDENTICAL sets at both blocks => quiescent => the immediate path fires.
const { discoverNoteIdsAtBlockSpy } = vi.hoisted(() => ({
  discoverNoteIdsAtBlockSpy: vi.fn(
    async (_args: { blockIdentifier: unknown }): Promise<string[]> => ['1', '2'],
  ),
}));
vi.mock('./discover', () => ({
  discoverNoteIdsAtBlock: discoverNoteIdsAtBlockSpy,
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
  // Real regex (dedupe sweep moved this into tx.ts): bridgeBack's proveAndSubmitClaim
  // retry guard classifies REVERTED/REJECTED via this predicate.
  isRevertedOrRejected: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
  // A tracked-terminal outcome (we HAVE the tx hash and observed an on-chain terminal
  // status). Modeled as the terminal REVERTED/REJECTED words for the tests; gates the
  // PART-C expiry re-anchor so an AMBIGUOUS expiry (no hash) is never re-anchored.
  isTrackedTerminalStatus: (err: unknown) =>
    /\bREVERTED\b|\bREJECTED\b/.test(err instanceof Error ? err.message : String(err)),
}));

vi.mock('./errorMessages', () => ({
  humanizeFinality: (f: unknown) => String(f),
}));

vi.mock('./proven-submit', () => ({
  managerExecute,
  submitProvenCall,
  invalidateManagerNonce,
  paymasterBuildLeg,
  paymasterExecuteLeg,
}));

// The RETURN-leg pre-flight message validation is exercised in snMint's own tests; stub
// it here as a no-op so bridgeBack tests don't have to hand-craft a byte-exact CCTP
// message that passes the source/dest/recipient/destinationCaller gates.
vi.mock('./snMint', () => ({
  assertReturnCctpMessage: vi.fn(),
}));

// Inbound Anonymizer + pool addresses come from config; override the env defaults to
// fixtures. Inlined (not the top-level consts) because this factory is hoisted
// above their declarations — must stay in sync with the consts above.
vi.mock('./config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return {
    config: {
      ...actual.config,
      inboundAnonymizerAddress: '0xINBOUND',
      poolAddress: '0x1',
      depositToken: { ...(actual.config.depositToken as object), address: '0xdeadbeef' },
    },
  };
});

import { claimToPool } from './bridgeBack';
import { encodeCctpBytes } from './cctpBytes';
import { submitAndTrack } from './tx';
import { config } from './config';

function asBig(x: unknown): bigint {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(x);
  if (typeof x === 'string') return BigInt(x);
  throw new Error(`not a felt-ish value: ${String(x)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  transferArgs = undefined;
  withdrawArgs = undefined;
  computeAndInvokeContract = undefined;
  computeAndInvokeCallback = undefined;
  computeAndInvokeResult = undefined;
  surplusToArg = undefined;
  withTokens.length = 0;
  transfers.build.mockImplementation(() => makeBuilder());
  submitProvenCall.mockResolvedValue({ transaction_hash: CLAIM_TX_HASH });
  // Default: no fee_action (manager path). The paymaster fee-injection test overrides.
  paymasterBuildLeg.mockResolvedValue({
    type: 'apply_action',
    parameters: {},
    opts: {},
    feeAction: undefined,
  });
  paymasterExecuteLeg.mockResolvedValue({ transaction_hash: CLAIM_TX_HASH });
  deriveStarknetPrivateKey.mockReturnValue(SN_PRIVATE_KEY);
  deriveViewingKey.mockReturnValue(VIEWING_KEY);
  // Default: no paymaster (manager-paid poke). The AVNU block flips it per test.
  (config as { paymaster?: unknown }).paymaster = undefined;
  (config as { inboundAnonymizerAddress?: string }).inboundAnonymizerAddress = INBOUND;
  // Default the quiescence gate to QUIESCENT (identical id-sets at both blocks) so any
  // test that doesn't opt out takes the immediate path. clearAllMocks above clears call
  // history but not the implementation, so reset it explicitly.
  discoverNoteIdsAtBlockSpy.mockReset();
  discoverNoteIdsAtBlockSpy.mockResolvedValue(['1', '2']);
});

describe('claimToPool — fail-closed guard (InboundAnonymizer not deployed)', () => {
  it('throws BEFORE any crypto/builder/submit side-effect when inboundAnonymizerAddress is the "0x0" placeholder', async () => {
    (config as { inboundAnonymizerAddress?: string }).inboundAnonymizerAddress = '0x0';
    await expect(
      claimToPool(CLAIM_ARGS),
    ).rejects.toThrow(/inboundAnonymizerAddress not configured/i);
    expect(deriveStarknetPrivateKey).not.toHaveBeenCalled();
    expect(deriveViewingKey).not.toHaveBeenCalled();
    expect(createPrivateTransfers).not.toHaveBeenCalled();
    expect(submitProvenCall).not.toHaveBeenCalled();
  });
});

// NOTE: recoverBridgeIn moved to returnIn.ts (fold-only recovery is cursor + nonce-used
// based, not a claimable_of read) — its tests live in returnIn.recover.test.ts.

describe('claimToPool — proven claim binding the created open note (ComputeAndInvoke)', () => {
  it('builds ONE apply_actions: transfer(Open) on the deposit token + computeAndInvoke, binding openNotes[0].noteId into invoke_additional_data', async () => {
    const res = await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // The destination open note is created via transfer({recipient: account, amount: Open}).
    // transfer(Open) is the ONLY builder action that compiles to a CreateOpenNote,
    // i.e. the only one whose noteId surfaces in openNotes[] for the dataBuilder callback.
    expect(withTokens).toContain(TOKEN);
    expect(transferArgs).toBeDefined();
    expect(transferArgs!.recipient).toBe(account.address);
    // The SAME Open symbol identity the SDK exports — proves CreateOpenNote, not a
    // numeric deposit (which compiles to CreateEncNote, filtered out of openNotes).
    expect(transferArgs!.amount).toBe(Open);

    // ONE computeAndInvoke, targeting the InboundAnonymizer.
    expect(computeAndInvokeCallback).toBeDefined();
    expect(computeAndInvokeResult).toBeDefined();
    expect(computeAndInvokeContract).toBe(INBOUND);

    // compute_additional_data = [RETURN_DAPP_NAME, sourceDomain, accountNonce] — the pool
    // prefixes identity_key itself (from the authenticated signer's proven private inputs),
    // so this leg supplies the dapp tag + source domain + nonce, matching the Cairo
    // privacy_compute(identity_key, dapp_name, source_domain, nonce) signature.
    expect(computeAndInvokeResult!.computeAdditionalData).toEqual([
      RETURN_DAPP_NAME,
      BigInt(SOURCE_DOMAIN),
      ACCOUNT_NONCE,
    ]);
    // invokeAdditionalData = [note_id, ...encodeCctpBytes(message), ...encodeCctpBytes(
    // attestation)] — note_id MUST equal the openNotes[0].noteId created in the SAME build,
    // followed by the CCTP message + attestation as Cairo ByteArray felts (folded so
    // privacy_invoke_with_computation can mint via receive_message). Serialized with the
    // SAME encodeCctpBytes snMint uses for receive_message, mapped to bigint felts.
    expect(computeAndInvokeResult!.invokeAdditionalData).toEqual([
      NOTE_ID,
      ...encodeCctpBytes(MESSAGE).map((felt) => BigInt(felt)),
      ...encodeCctpBytes(ATTESTATION).map((felt) => BigInt(felt)),
    ]);

    // No claim_secret / H / caller-supplied amount ANYWHERE in the built data.
    expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
    expect(res).not.toHaveProperty('commitmentH');
  });

  // Prove-early quiescence gate (mirrors proveAndSubmitBridgeOut / bridgeOut.test.ts):
  // when there is no manager fee-approve tx to seed the aging wait (paymaster or
  // zero-fee path), the claim used to always hand a fresh `getCurrentBlock()` anchor to
  // waitForProvingBlock — forcing the FULL aging wait even when the account committed
  // nothing recently (the "~8 more blocks" UX bug). The gate now checks whether the
  // account is QUIESCENT (identical spendable note-id set at latest−12 vs head) first.
  describe('proving anchor when there is no fee-approve tx (quiescence gate)', () => {
    it('quiescent (equal id-sets) → proves immediately at the gate\'s own base, does NOT age', async () => {
      await claimToPool(CLAIM_ARGS);

      expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
      const blocks = discoverNoteIdsAtBlockSpy.mock.calls.map((c) => c[0].blockIdentifier);
      expect(blocks).toContain('pre_confirmed');
      // The gate's OWN immediateBase is reused directly — no redundant second
      // waitForProvingBlock call (mirrors bridgeOut.ts's reuse of its captured anchor).
      expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
      // getCurrentBlockSpy → 7, IMMEDIATE_PROVING_BLOCK_DEPTH → 12: immediateBase = max(7-12,0) = 0.
      const execMock = transfers.executeWithInvocation as ReturnType<typeof vi.fn>;
      expect(execMock.mock.calls[0]![1]).toBe(0);
    });

    it('non-quiescent (id-sets differ — recent activity) → seeds the anchor from the current head (NON_ZERO_VALUE guard)', async () => {
      discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
        args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
      );

      await claimToPool(CLAIM_ARGS);

      expect(getCurrentBlockSpy).toHaveBeenCalled();
      const anchor = waitForProvingBlockSpy.mock.calls.at(-1)![1];
      expect(anchor).toBe(7); // the head — NOT undefined (which would skip aging → stale prove)
    });

    it('a gate discovery read throws → degrades to aging, the claim still proceeds', async () => {
      discoverNoteIdsAtBlockSpy.mockReset();
      discoverNoteIdsAtBlockSpy.mockRejectedValue(new Error('indexer historical block_ref unsupported'));

      const res = await claimToPool(CLAIM_ARGS);

      expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
      const anchor = waitForProvingBlockSpy.mock.calls.at(-1)![1];
      expect(anchor).toBe(7);
    });

    // SAFETY NET (mirrors bridgeOut.ts): the gate is a pre-check, not a guarantee — a
    // note can still land/spend in the race between the gate's read and this build. If
    // the immediate-path build/prove itself throws despite a quiescent gate, the claim
    // must fall back to the aged path ONCE rather than hard-failing.
    it('gate says quiescent but the immediate build/prove throws → falls back to aging and still succeeds', async () => {
      const execMock = transfers.executeWithInvocation as ReturnType<typeof vi.fn>;
      execMock.mockRejectedValueOnce(new Error('latest tagged 3 (indexer lag)'));
      execMock.mockResolvedValueOnce({
        callAndProof: {
          call: { contractAddress: '0xINBOUND', calldata: [] },
          proof: { data: [], proofFacts: [] },
        },
      });
      const statusMessages: string[] = [];

      const res = await claimToPool({ ...CLAIM_ARGS, onStatus: (s) => statusMessages.push(s) });

      expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(statusMessages.some((m) => /Immediate prove failed.*aging/i.test(m))).toBe(true);
      // The fallback attempt aged at PROVING_BLOCK_DEPTH (8) from a fresh head (7), not
      // the original undefined/IMMEDIATE_PROVING_BLOCK_DEPTH pair.
      const last = waitForProvingBlockSpy.mock.calls.at(-1)!;
      expect(last[1]).toBe(7);
      expect(last[3]).toBe(8);
    });

    // REGRESSION (Cursor Bugbot MEDIUM, "Quiescent rebuild lacks pinned block"): a
    // stale-nonce submit retry on the gate-eligible path must reuse the SAME resolved
    // proving block — re-running the immediate/fallback dance from scratch could land
    // on a DIFFERENT block than the one already proven, wasting the first proof.
    it('a stale-nonce submit retry reuses the SAME resolved block (no re-run of the gate/fallback dance)', async () => {
      const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
      let calls = 0;
      submitAndTrackMock.mockImplementation(
        async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
          calls += 1;
          if (calls === 1) {
            // A generic retryable submit failure (not PROOF_EXPIRED, not REVERTED/
            // REJECTED, not node-lag) — triggers the same-anchor stale-nonce rebuild().
            throw new Error('nonce already used, retrying');
          }
          const r = await send();
          return { transactionHash: r.transaction_hash, blockNumber: 1 };
        },
      );
      submitProvenCall.mockReset();
      submitProvenCall.mockResolvedValue({ transaction_hash: '0xclaim-retry' });
      const execMock = transfers.executeWithInvocation as ReturnType<typeof vi.fn>;

      const res = await claimToPool(CLAIM_ARGS);

      expect(res.claimTxHash).toBe('0xclaim-retry');
      // ONE build for the initial attempt, ONE for the stale-nonce rebuild — the
      // discovery gate itself only ran once (checked below), so the rebuild did NOT
      // re-run checkProveEarlyQuiescence.
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(discoverNoteIdsAtBlockSpy).toHaveBeenCalledTimes(2);
      // Both builds proved at the IDENTICAL block (the gate's immediateBase) — not
      // re-derived independently per attempt.
      const [firstBlock, secondBlock] = execMock.mock.calls.map((c) => c[1]);
      expect(secondBlock).toBe(firstBlock);
      expect(waitForProvingBlockSpy).not.toHaveBeenCalled();
    });
  });

  it('throws if no open note was created (defensive noteId guard)', async () => {
    transfers.build.mockImplementation(() => {
      const builder = makeBuilder();
      builder.computeAndInvoke = vi.fn((cb: (ctx: unknown) => unknown) => {
        // No open notes created this build — the callback throws before returning
        // (defensive noteId guard), so contractAddress is never captured.
        cb({ openNotes: [], withdrawals: [], poolAddress: POOL_ADDRESS });
        return builder;
      });
      return builder;
    });
    await expect(
      claimToPool(CLAIM_ARGS),
    ).rejects.toThrow(/no open note created/i);
  });

  it('submits the proven claim from the MANAGER (submitProvenCall), not the derived account', async () => {
    await claimToPool(CLAIM_ARGS);
    expect(submitProvenCall).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('PAYMASTER: bakes the AVNU pool fee as a withdraw to the forwarder + submits via the relayer (not the manager)', async () => {
    // Use a distinct token fixture for this paymaster test's fee-token-match guard.
    const dep = config as { depositToken: { address: string }; paymaster?: unknown };
    const originalToken = dep.depositToken.address;
    dep.depositToken.address = '0xdec0de';
    dep.paymaster = {
      endpoint: 'https://pm.test',
      apiKey: 'KEY',
      feeMode: 'sponsored_private',
      poolFeeToken: '0xdec0de',
    };
    paymasterBuildLeg.mockResolvedValue({
      type: 'apply_action',
      parameters: {},
      opts: {},
      feeAction: { recipient: '0xf0rwarder', token: '0xdec0de', amount: '0x21b53' },
    });
    try {
      const res = await claimToPool({
        signature: SIGNATURE,
        accountIndex: ACCOUNT_INDEX,
        accountNonce: ACCOUNT_NONCE,
        message: MESSAGE,
        attestation: ATTESTATION,
        sourceDomain: SOURCE_DOMAIN,
      });
      // Fee baked into the proof as a withdraw to the forwarder (AVNU collects it).
      expect(withdrawArgs).toBeDefined();
      expect(withdrawArgs!.recipient).toBe('0xf0rwarder');
      expect(asBig(withdrawArgs!.amount)).toBe(BigInt('0x21b53'));
      // The open note + computeAndInvoke still bind note_id (unchanged).
      expect(computeAndInvokeContract).toBe(INBOUND);
      // Submitted via AVNU's relayer (paymasterExecuteLeg), NOT the manager.
      expect(paymasterExecuteLeg).toHaveBeenCalledTimes(1);
      expect(submitProvenCall).not.toHaveBeenCalled();
      expect(managerExecute).not.toHaveBeenCalled();
      expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
    } finally {
      dep.depositToken.address = originalToken;
    }
  });

  it('PAYMASTER: rejects a fee in a NON-deposit token (cannot pay it from a USDC-only balance)', async () => {
    const dep = config as { depositToken: { address: string }; paymaster?: unknown };
    const originalToken = dep.depositToken.address;
    dep.depositToken.address = '0xdec0de';
    dep.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored', poolFeeToken: '' };
    // fee in a different token (e.g. STRK) → cannot be drawn from the USDC pool balance.
    paymasterBuildLeg.mockResolvedValue({
      type: 'apply_action',
      parameters: {},
      opts: {},
      feeAction: { recipient: '0xf0rwarder', token: '0xbeef', amount: '0x21b53' },
    });
    try {
      await expect(
        claimToPool(CLAIM_ARGS),
      ).rejects.toThrow(/not the claim token/i);
      expect(paymasterExecuteLeg).not.toHaveBeenCalled();
    } finally {
      dep.depositToken.address = originalToken;
    }
  });

  it('returns change to the submitter account as a private note (surplusTo)', async () => {
    await claimToPool(CLAIM_ARGS);
    expect(surplusToArg).toBe(account.address);
  });

  it('never logs/persists the viewing key, SN private key, or signature', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await claimToPool(CLAIM_ARGS);
    const logged = [
      ...logSpy.mock.calls,
      ...errSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...debugSpy.mock.calls,
    ]
      .flat()
      .map((a) => {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join('\n');
    expect(logged).not.toContain(VIEWING_KEY.toString());
    expect(logged).not.toContain(SN_PRIVATE_KEY);
    expect(logged).not.toContain(SIGNATURE);
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// C5 BUG PROBE: claimToPool retry loses the first claim tx hash.
//
// Same pattern as C4 in bridgeOut. When submitAndTrack calls send() (setting
// claimTxHash = '0xclaim1') but then throws, the catch calls attempt() again.
// The second attempt() has its own local `claimTxHash = ''` which gets set to
// '0xclaim2'. claimToPool returns '0xclaim2' — but the real claim tx that
// landed on-chain is '0xclaim1'.
//
// Correct behaviour: return '0xclaim1'.
// Current behaviour: return '0xclaim2' → test is RED.
// ---------------------------------------------------------------------------
describe('C5 — claimToPool: retry loses first claim tx hash', () => {
  it('C5: returns the FIRST claim tx hash when submitAndTrack throws after send() succeeds', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    let claimCallCount = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        claimCallCount += 1;
        if (claimCallCount === 1) {
          // The proven claim: send() runs (setting claimTxHash inside attempt to
          // '0xclaim1'), then submitAndTrack throws a timeout.
          await send(); // side-effect: sets claimTxHash = '0xclaim1' inside attempt
          throw new Error('tracking timeout');
        }
        // Retry: the second attempt's submitAndTrack — succeeds with '0xclaim2'.
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );

    // First submitProvenCall returns '0xclaim1'; second (retry) returns '0xclaim2'.
    submitProvenCall
      .mockResolvedValueOnce({ transaction_hash: '0xclaim1' })
      .mockResolvedValueOnce({ transaction_hash: '0xclaim2' });

    const res = await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // The first submitted claim is the one that landed. Correct answer: '0xclaim1'.
    // Current code returns '0xclaim2' → this assertion fails (RED).
    expect(res.claimTxHash).toBe('0xclaim1');
  });
});

// ---------------------------------------------------------------------------
// VP1 BUG PROBE: claimToPool's RETRY claim lands but the retry is un-guarded.
//
// Same shape as VP1 in bridgeOut. The C5 fix guards the FIRST attempt; the retry
// `await attempt()` is not wrapped. attempt-1 fails BEFORE send() (claimTxHash
// stays '' → first-attempt guard false → falls through to the retry); attempt-2's
// send() SUCCEEDS (claimTxHash = '0xretryclaim') but its submitAndTrack then times
// out → the throw escapes un-guarded → claimToPool REJECTS even though the claim
// already landed.
//
// Correct behaviour: RESOLVE with the retry's landed hash ('0xretryclaim').
// Pre-fix behaviour: rejects with 'tracking timeout' → test is RED.
// ---------------------------------------------------------------------------
describe('VP1 — claimToPool: retry claim lands but the retry is un-guarded', () => {
  it('VP1: resolves with the RETRY claim hash when attempt-1 fails pre-send and the retry send() lands then times out', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    let claimCallCount = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        claimCallCount += 1;
        if (claimCallCount === 1) {
          // Attempt-1: a pre-send proving/nonce error — send() is NEVER called.
          throw new Error('code: 52 invalid transaction nonce');
        }
        // Attempt-2 (the retry): send() SUCCEEDS, then submitAndTrack times out.
        await send();
        throw new Error('tracking timeout');
      },
    );

    // Reset first to clear any mockResolvedValueOnce queue left by C5.
    submitProvenCall.mockReset();
    submitProvenCall.mockResolvedValue({ transaction_hash: '0xretryclaim' });

    const res = await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // The retry claim IS in-flight — claimToPool must return its hash, not reject.
    expect(res.claimTxHash).toBe('0xretryclaim');
  });
});

// ---------------------------------------------------------------------------
// REVERT BUG PROBE: claimToPool must NOT treat a REVERTED/REJECTED claim as
// submitted. InboundAnonymizer's privacy_invoke_with_computation asserts +
// decrements ledger[commitment] in the SAME atomic apply_actions as the open-note
// creation, so a revert rolls back the whole tx — no open note, ledger untouched.
// Returning that dead hash (or resolving at all when EVERY attempt reverts) would
// make returnIn.ts's returnToPool report the claim done and clear the only resume
// cursor (pmp.inflightReturn) for a claim that never happened.
// ---------------------------------------------------------------------------
describe('claimToPool — a REVERTED attempt must not be treated as submitted', () => {
  it('retries and resolves with the RETRY hash when attempt-1 sends then reverts on-chain', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    let claimCallCount = 0;
    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        claimCallCount += 1;
        if (claimCallCount === 1) {
          // Attempt-1: send() lands ('0xclaim1') but the tx is tracked to a
          // terminal on-chain REVERT — a dead hash, not an in-flight claim.
          await send();
          throw new Error('Transaction REVERTED: assertion failed (ledger[commitment] < 0)');
        }
        // Retry: a clean, successful submit.
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );

    submitProvenCall
      .mockResolvedValueOnce({ transaction_hash: '0xclaim1' })
      .mockResolvedValueOnce({ transaction_hash: '0xclaim2' });

    const res = await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // The retry actually fired (not a short-circuit return of the dead hash).
    expect(submitProvenCall).toHaveBeenCalledTimes(2);
    // The resolved hash is the RETRY's, not the reverted first attempt's.
    expect(res.claimTxHash).toBe('0xclaim2');
  });

  it('REJECTS (does not resolve with a dead hash) when BOTH attempt-1 and the retry land REVERTED', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;

    submitAndTrackMock.mockImplementation(
      async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        // Every attempt sends (setting a hash) then reverts on-chain.
        await send();
        throw new Error('Transaction REVERTED: assertion failed (ledger[commitment] < 0)');
      },
    );

    submitProvenCall
      .mockResolvedValueOnce({ transaction_hash: '0xclaim1' })
      .mockResolvedValueOnce({ transaction_hash: '0xclaim2' });

    // Pins the bug: the pre-fix code returns the last-set hash instead of
    // propagating the REVERTED error — this must REJECT, not resolve.
    await expect(claimToPool(CLAIM_ARGS)).rejects.toThrow(/REVERTED/);
  });
});

// ---------------------------------------------------------------------------
// PART C — proof-EXPIRY re-anchor (Bugbot MEDIUM: "Overlapped claim proof can
// expire"). buildAndProveClaim runs CONCURRENTLY with the CCTP attestation +
// receive_and_bind (returnIn.ts), so the proof can finish well before a slow
// Standard attestation lands — pushing the first submit minutes later, possibly
// past the pool's proof-validity window. A tracked-terminal PROOF_EXPIRED /
// INVALID_BASE_BLOCK_NUMBER revert must NOT just re-prove against the SAME aged
// anchor (it would re-expire); it must re-anchor to a FRESH head at the IMMEDIATE
// depth and re-prove. Mirrors deposit.ts PART C.
// ---------------------------------------------------------------------------
describe('claimToPool — PART C: re-anchors + re-proves on a PROOF_EXPIRED revert', () => {
  it('a tracked-terminal PROOF_EXPIRED revert re-anchors to a FRESH head at the IMMEDIATE depth', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    let calls = 0;
    submitAndTrackMock.mockImplementation(
      async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        calls += 1;
        if (calls === 1) {
          // The submit landed on-chain but the proof's base block had aged out of the
          // validity window during the attestation wait → a tracked-terminal revert.
          await send();
          throw new Error('apply_actions REVERTED: PROOF_EXPIRED');
        }
        // The re-anchored (fresh) proof submits cleanly.
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );
    submitProvenCall.mockReset();
    submitProvenCall.mockResolvedValue({ transaction_hash: '0xclaim-fresh' });

    waitForProvingBlockSpy.mockClear();
    const invalidate = transfers.invalidateProofNonceCache as ReturnType<typeof vi.fn>;
    invalidate.mockClear();
    // Force the INITIAL build onto the aged path (non-quiescent) so this test can
    // exercise the re-anchor mechanics independent of the quiescence gate.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
    );

    const res = await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // Re-anchored + re-proved once, then the fresh submit landed.
    expect(res.claimTxHash).toBe('0xclaim-fresh');
    expect(calls).toBe(2);
    // rebuildFresh invalidated the SDK proof-nonce cache before re-proving.
    expect(invalidate).toHaveBeenCalled();
    // The FIRST build used the original aged anchor (getCurrentBlock → 7) at the default
    // aging depth (undefined → PROVING_BLOCK_DEPTH).
    const first = waitForProvingBlockSpy.mock.calls[0];
    expect(first[1]).toBe(7);
    // THE fix: the re-anchor read a FRESH base (undefined → latest) at the IMMEDIATE depth
    // (12) — NOT the original aged anchor. Pre-fix (same-anchor rebuild) → anchor still 7,
    // depth still undefined ⇒ RED.
    const last = waitForProvingBlockSpy.mock.calls.at(-1)!;
    expect(last[1]).toBeUndefined();
    expect(last[3]).toBe(12);
  });

  // REGRESSION: rebuildFresh's re-anchor is an EXPIRY re-anchor, not a quiescence-gate
  // decision — it must NOT be routed through proveWithImmediateFallback's race-safety
  // net (that net exists for the note-id race the gate itself can miss; it doesn't
  // apply here, and silently falling back to aging would hide a genuine re-prove
  // failure behind an unexpected extra attempt). A failure on rebuildFresh's single
  // build must propagate, exactly as it did before the quiescence gate was added.
  it('rebuildFresh does NOT get the immediate-fallback safety net — a failure on its build propagates', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    let calls = 0;
    submitAndTrackMock.mockImplementation(
      async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        calls += 1;
        if (calls === 1) {
          await send();
          throw new Error('apply_actions REVERTED: PROOF_EXPIRED');
        }
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );
    submitProvenCall.mockReset();
    submitProvenCall.mockResolvedValue({ transaction_hash: '0xclaim-fresh' });
    // Force the INITIAL build onto the aged path so this test isolates rebuildFresh's
    // behavior from the initial quiescence-gate decision.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
    );
    // rebuildFresh's build (executeWithInvocation) fails EVERY time — if rebuildFresh
    // were (incorrectly) wrapped in proveWithImmediateFallback, this would silently
    // retry at an aged block and this failing mock's SECOND call would also throw,
    // still propagating; the key assertion is that it does NOT silently succeed via
    // an unexpected extra build attempt this test doesn't account for.
    const execMock = transfers.executeWithInvocation as ReturnType<typeof vi.fn>;
    // First call = the INITIAL build (succeeds, matching the default mock shape);
    // second call = rebuildFresh's build (fails).
    execMock.mockResolvedValueOnce({
      callAndProof: { call: { contractAddress: '0xINBOUND', calldata: [] }, proof: { data: [], proofFacts: [] } },
    });
    execMock.mockRejectedValueOnce(new Error('latest tagged N (indexer lag)'));

    await expect(
      claimToPool({
        signature: SIGNATURE,
        accountIndex: ACCOUNT_INDEX,
        accountNonce: ACCOUNT_NONCE,
        message: MESSAGE,
        attestation: ATTESTATION,
        sourceDomain: SOURCE_DOMAIN,
      }),
    ).rejects.toThrow(/latest tagged N/);
    // Exactly TWO executeWithInvocation calls total: the initial build, then
    // rebuildFresh's single (failing) build. proveWithImmediateFallback would have
    // made a THIRD (aged-fallback) call instead of propagating the failure.
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-anchor an AMBIGUOUS expiry (no tracked-terminal status) — falls through to the fail-closed/rebuild path', async () => {
    const submitAndTrackMock = submitAndTrack as ReturnType<typeof vi.fn>;
    let calls = 0;
    submitAndTrackMock.mockImplementation(
      async (_p: unknown, send: () => Promise<{ transaction_hash: string }>) => {
        calls += 1;
        if (calls === 1) {
          // PROOF_EXPIRED but NOT tracked-terminal (no REVERTED/REJECTED word → the
          // mock's isTrackedTerminalStatus is false): an AMBIGUOUS expiry that must NOT
          // trigger the fresh re-anchor.
          throw new Error('proving failed: PROOF_EXPIRED (base too old)');
        }
        const r = await send();
        return { transactionHash: r.transaction_hash, blockNumber: 1 };
      },
    );
    submitProvenCall.mockReset();
    submitProvenCall.mockResolvedValue({ transaction_hash: '0xclaim-same' });
    waitForProvingBlockSpy.mockClear();
    // Force the INITIAL build onto the aged path (non-quiescent) so this test can
    // exercise the same-anchor rebuild mechanics independent of the quiescence gate.
    discoverNoteIdsAtBlockSpy.mockImplementation(async (args: { blockIdentifier: unknown }) =>
      args.blockIdentifier === 'pre_confirmed' ? ['1', '2', '3'] : ['1', '2'],
    );

    await claimToPool({
      signature: SIGNATURE,
      accountIndex: ACCOUNT_INDEX,
      accountNonce: ACCOUNT_NONCE,
      message: MESSAGE,
      attestation: ATTESTATION,
      sourceDomain: SOURCE_DOMAIN,
    });

    // The same-anchor rebuild path ran (not the fresh re-anchor): the retry's proving
    // block kept the ORIGINAL aged anchor (7), never re-anchored to undefined/IMMEDIATE.
    const last = waitForProvingBlockSpy.mock.calls.at(-1)!;
    expect(last[1]).toBe(7);
    expect(last[3]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FULL-NODE-LAG auto-retry (submitProvenClaim.submitReusingProofOnNodeLag). AVNU's
// validating node is briefly behind the proof's base block, so proof-fact validation
// fails PRE-BROADCAST with a code-156 ValidationFailure ("stored block hash: 0"). The
// proof is valid — resubmit the SAME proof (no rebuild/re-prove) after a short wait,
// bounded by MAX_NODE_LAG_RETRIES. Reusing an identical proof is inherently
// double-spend-safe, so it bypasses the fail-closed ambiguity guard.
// ---------------------------------------------------------------------------
describe('claimToPool — full-node-lag: auto-retry the SAME proof (no re-prove)', () => {
  // Field shape: contains "block hash mismatch" + a ZERO "stored block hash" (the mock's
  // isNodeLagError matches this). No REVERTED/REJECTED/PROOF_EXPIRED words → it is neither
  // reverted nor an expiry, so it exercises the dedicated node-lag path.
  const NODE_LAG_MSG =
    'AVNU paymaster paymaster_executeTransaction error (code 156): ValidationFailure: ' +
    '"Invalid proof facts: Block hash mismatch for block 11830268. Proof block hash: 2599, ' +
    'stored block hash: 0."';

  it('PAYMASTER: retries the SAME proof on node-lag, then resolves — no rebuild/re-prove', async () => {
    const dep = config as { paymaster?: unknown };
    dep.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored', poolFeeToken: '' };
    paymasterBuildLeg.mockResolvedValue({ type: 'apply_action', parameters: {}, opts: {}, feeAction: undefined });

    let calls = 0;
    paymasterExecuteLeg.mockImplementation(
      async (
        _a: unknown,
        _c: unknown,
        _p: unknown,
        _ctx: unknown,
        opts?: { onRelayStart?: () => void },
      ) => {
        calls += 1;
        opts?.onRelayStart?.(); // mirror the real relay-start boundary
        if (calls <= 2) throw new Error(NODE_LAG_MSG); // node behind on the first two tries
        return { transaction_hash: CLAIM_TX_HASH }; // node caught up
      },
    );

    const res = await claimToPool(CLAIM_ARGS);

    expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
    // 2 node-lag rejects + 1 success, all the SAME proof via the relayer.
    expect(paymasterExecuteLeg).toHaveBeenCalledTimes(3);
    expect(submitProvenCall).not.toHaveBeenCalled();
    // No rebuild/re-prove: the node-lag path reuses the identical proof.
    expect(transfers.invalidateProofNonceCache).not.toHaveBeenCalled();
  });

  it('PAYMASTER: a node-lag that never clears rejects (bounded) and never rebuilds', async () => {
    const dep = config as { paymaster?: unknown };
    dep.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored', poolFeeToken: '' };
    paymasterBuildLeg.mockResolvedValue({ type: 'apply_action', parameters: {}, opts: {}, feeAction: undefined });

    paymasterExecuteLeg.mockImplementation(
      async (
        _a: unknown,
        _c: unknown,
        _p: unknown,
        _ctx: unknown,
        opts?: { onRelayStart?: () => void },
      ) => {
        opts?.onRelayStart?.();
        throw new Error(NODE_LAG_MSG); // node never catches up
      },
    );

    await expect(
      claimToPool(CLAIM_ARGS),
    ).rejects.toThrow(/block hash mismatch/i);

    // Bounded: 1 initial + MAX_NODE_LAG_RETRIES (6) = 7 attempts, all the same proof.
    expect(paymasterExecuteLeg).toHaveBeenCalledTimes(7);
    // Exhaustion falls into the fail-closed guard (relay in-flight, no hash) → propagate,
    // never rebuild/re-prove (which would be a double-burn risk on the paymaster path).
    expect(transfers.invalidateProofNonceCache).not.toHaveBeenCalled();
    expect(submitProvenCall).not.toHaveBeenCalled();
  });

  it('MANAGER: node-lag on the post-rebuild (stale-nonce) submit also auto-retries the same proof', async () => {
    // Manager path (no paymaster). Attempt-1 hits a stale-nonce error → the existing
    // same-anchor rebuild fires ONCE; the post-rebuild submit then hits node-lag twice
    // before landing. The node-lag retries must NOT themselves trigger further rebuilds.
    let calls = 0;
    submitProvenCall.mockReset();
    submitProvenCall.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('stale proof nonce'); // → triggers one rebuild
      if (calls <= 3) throw new Error(NODE_LAG_MSG); // post-rebuild submits: node behind
      return { transaction_hash: CLAIM_TX_HASH }; // node caught up
    });

    const res = await claimToPool(CLAIM_ARGS);

    expect(res.claimTxHash).toBe(CLAIM_TX_HASH);
    // 1 stale-nonce + 2 node-lag + 1 success.
    expect(submitProvenCall).toHaveBeenCalledTimes(4);
    // Exactly ONE rebuild (the stale-nonce path) — node-lag retries reuse the same proof.
    expect(transfers.invalidateProofNonceCache).toHaveBeenCalledTimes(1);
  });

  it('MANAGER: a first-submit node-lag that never clears rejects (bounded) and never rebuilds', async () => {
    // Bugbot regression: on the manager path the fail-closed guard is false, so an EXHAUSTED
    // node-lag must be propagated explicitly (via isNodeLagError in the outer catch) and must
    // NOT fall through to working.rebuild() — a re-prove against the SAME still-lagging anchor
    // would just node-lag again (wasted work + violates the same-proof-only invariant).
    submitProvenCall.mockReset();
    submitProvenCall.mockImplementation(async () => {
      throw new Error(NODE_LAG_MSG); // node never catches up
    });

    await expect(
      claimToPool(CLAIM_ARGS),
    ).rejects.toThrow(/block hash mismatch/i);

    // 1 initial + MAX_NODE_LAG_RETRIES (6) = 7 attempts, all the SAME proof.
    expect(submitProvenCall).toHaveBeenCalledTimes(7);
    // NEVER rebuilt/re-proved — propagation happens before the fall-through to rebuild().
    expect(transfers.invalidateProofNonceCache).not.toHaveBeenCalled();
  });
});
