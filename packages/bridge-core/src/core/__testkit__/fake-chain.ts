// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Offline fake-chain harness for cross-module INTEGRATION tests.
//
// Unlike the per-module unit tests (which mock the step modules wholesale), this
// lets the REAL register/deposit/proven-submit/proving/tx modules run wired
// together, faking ONLY the lowest boundaries: the starknet RpcProvider/Account
// and the SDK's proof builder. That exercises the seams between them — most
// importantly the serialized manager-nonce sequencing in proven-submit.ts, where
// the live "code 52" collision bug was found.
//
// vitest-free on purpose: the test file owns the `vi.mock(...)` wiring and feeds
// these fakes in via the mocked `./provider` + SDK exports.

import type { Account, Call, RpcProvider } from 'starknet';

/** A single recorded `execute(...)` against a fake account, in global call order. */
export interface ExecRecord {
  /** Logical sender label, e.g. 'manager' or 'user'. */
  sender: string;
  /** The call(s) passed to execute. */
  call: Call | Call[];
  /** The details passed (nonce, tip, resourceBounds, proof, proofFacts…). */
  details: Record<string, unknown>;
  /** The synthetic tx hash returned. */
  hash: string;
}

/** Shared, ordered ledger of every fake on-chain submit + the manager's nonce reads. */
export class ChainRecorder {
  readonly execs: ExecRecord[] = [];
  /** How many times any manager Account.getNonce was read (the seed + any recovery re-reads). */
  nonceReads = 0;
  private seq = 0;

  private nextHash(): string {
    this.seq += 1;
    return `0x${this.seq.toString(16).padStart(8, '0')}`;
  }

  /** Records an execute and returns its synthetic tx hash. */
  push(sender: string, call: Call | Call[], details: Record<string, unknown>): string {
    const hash = this.nextHash();
    this.execs.push({ sender, call, details, hash });
    return hash;
  }

  /** Execs from one sender, in order. */
  bySender(sender: string): ExecRecord[] {
    return this.execs.filter((e) => e.sender === sender);
  }

  reset(): void {
    this.execs.length = 0;
    this.nonceReads = 0;
    this.seq = 0;
  }
}

export interface FakeProviderOptions {
  /** Pool protocol fee (STRK wei) returned by `get_fee_amount`. */
  feeAmount?: bigint;
  /** Latest block height — kept far ahead so waitForProvingBlock's aging wait is a no-op. */
  latestBlock?: number;
}

/**
 * A fake starknet RpcProvider covering exactly the reads the register/deposit/
 * proven-submit/proving/tx chain performs offline:
 *   - callContract: `get_fee_amount` → [feeAmount]; anything else → ['0x0'].
 *   - getBlockNumber: a fixed, far-ahead height so waitForProvingBlock returns at once.
 *   - getBlockWithTxHashes: a header WITHOUT price fields → buildProofResourceBounds uses its floors.
 *   - getTransactionStatus/getTransactionReceipt: instant ACCEPTED_ON_L2 success + a low block number.
 */
export function fakeProvider(opts: FakeProviderOptions = {}): RpcProvider {
  const feeAmount = opts.feeAmount ?? 0n;
  const latestBlock = opts.latestBlock ?? 1_000_000;
  const provider = {
    callContract: async (params: { entrypoint: string }): Promise<string[]> =>
      params.entrypoint === 'get_fee_amount' ? [feeAmount.toString()] : ['0x0'],
    getBlockNumber: async (): Promise<number> => latestBlock,
    getBlockWithTxHashes: async (): Promise<Record<string, unknown>> => ({}),
    getTransactionStatus: async (): Promise<Record<string, string>> => ({
      finality_status: 'ACCEPTED_ON_L2',
      execution_status: 'SUCCEEDED',
    }),
    getTransactionReceipt: async (): Promise<{ block_number: number }> => ({ block_number: 1 }),
  };
  return provider as unknown as RpcProvider;
}

export interface FakeManager extends Account {
  /** Per-test reset of the manager's success counter, scripted failures + nonce view. */
  reset(): void;
  /** Throw `err` on the Nth (1-based) execute call's first attempt, once. */
  failOnExec(execIndex: number, err: Error): void;
  /**
   * Override what getNonce reports, given the count of committed txs. Models a
   * LAGGING / stale RPC nonce — a just-submitted (pre-confirmed) tx does NOT
   * advance the RPC nonce, so a re-read returns a stale-low value. The real "code
   * 52" collision came from re-reading that stale value; this lets a test prove
   * the local-authoritative counter ignores it. `reset()` restores the accurate view.
   */
  setNonceView(view: (committed: number) => number): void;
}

/**
 * A fake MANAGER Account whose nonce view mirrors a real chain: by default getNonce
 * returns the count of SUCCESSFULLY committed manager txs (so the seed reads 0, and a
 * post-collision recovery re-read reflects what actually committed). Use setNonceView
 * to model a lagging/stale RPC nonce. Records every execute on the shared recorder
 * with sender='manager'.
 */
export function fakeManager(recorder: ChainRecorder): FakeManager {
  let committed = 0;
  let execCount = 0;
  const failures = new Map<number, Error>();
  const accurateView = (c: number): number => c;
  let nonceView: (committed: number) => number = accurateView;

  const manager = {
    getNonce: async (): Promise<string> => {
      recorder.nonceReads += 1;
      return `0x${nonceView(committed).toString(16)}`;
    },
    execute: async (
      call: Call | Call[],
      details: Record<string, unknown> = {},
    ): Promise<{ transaction_hash: string }> => {
      execCount += 1;
      const scripted = failures.get(execCount);
      if (scripted) {
        failures.delete(execCount);
        throw scripted; // pre-acceptance rejection: nothing commits, nonce stays reusable
      }
      const hash = recorder.push('manager', call, details);
      committed += 1;
      return { transaction_hash: hash };
    },
    reset: (): void => {
      committed = 0;
      execCount = 0;
      failures.clear();
      nonceView = accurateView;
    },
    failOnExec: (execIndex: number, err: Error): void => {
      failures.set(execIndex, err);
    },
    setNonceView: (view: (committed: number) => number): void => {
      nonceView = view;
    },
  };
  return manager as unknown as FakeManager;
}

/** A fake USER Account: records execute with sender=`label`; no nonce sequencing. */
export function fakeUserAccount(
  recorder: ChainRecorder,
  address = '0xUSER',
  label = 'user',
): Account {
  const account = {
    address,
    execute: async (
      call: Call | Call[],
      details: Record<string, unknown> = {},
    ): Promise<{ transaction_hash: string }> => ({
      transaction_hash: recorder.push(label, call, details),
    }),
  };
  return account as unknown as Account;
}

/** Tag distinguishing the register vs deposit proven action the fake SDK emits. */
type ActionKind = 'register' | 'deposit';

/**
 * A fake `createPrivateTransfers(...)` result. It records nothing on-chain itself;
 * it yields a tagged `apply_actions` Call + a canned proof, so the test can assert
 * the REAL register/deposit code forwards exactly that proven call to the manager
 * submit. `.build()/.register()/.surplusTo()/.with()` mirror the SDK builder shape
 * the modules call.
 */
export interface FakeTransfersOptions {
  /** Emit a proof with NO proof facts, so the real code takes its "proof doesn't ride
   *  the submit" branch (`proofFacts?.length ? {…} : {}`). Default: one fact. */
  emptyProofFacts?: boolean;
}

export function fakeTransfers(opts: FakeTransfersOptions = {}): {
  invalidateProofNonceCache: () => void;
  build: (...args: unknown[]) => unknown;
  executeWithInvocation: (invocation: { kind: ActionKind }) => Promise<unknown>;
  /** Deposit inputs via `.with(token, t => t.deposit(...))` — captured so tests can
   *  assert e.g. that the paymaster path deposits WITHOUT an explicit recipient (so the
   *  fee withdraw nets against it instead of being consumed by a recipient note). */
  deposits: { amount: bigint; recipient?: string }[];
  /** Withdraws baked into the proof builder via `.with(token, t => t.withdraw(...))` —
   *  the paymaster path adds the AVNU pool fee here; tests assert on it. */
  withdraws: { recipient: string; amount: bigint }[];
} {
  const deposits: { amount: bigint; recipient?: string }[] = [];
  const withdraws: { recipient: string; amount: bigint }[] = [];
  const tokenBuilder = {
    deposit: (a: { amount: bigint; recipient?: string }) => {
      deposits.push({ amount: a.amount, recipient: a.recipient });
      return tokenBuilder;
    },
    withdraw: (out: { recipient: string; amount: bigint }) => {
      withdraws.push({ recipient: out.recipient, amount: out.amount });
      return tokenBuilder;
    },
  };
  const builder = {
    kind: 'register' as ActionKind,
    register() {
      builder.kind = 'register';
      return builder;
    },
    surplusTo() {
      return builder;
    },
    with(_addr: string, fn: (t: typeof tokenBuilder) => unknown) {
      builder.kind = 'deposit';
      fn(tokenBuilder);
      return builder;
    },
    async createProofInvocation(): Promise<{ kind: ActionKind }> {
      return { kind: builder.kind };
    },
  };
  return {
    invalidateProofNonceCache: () => {},
    build: () => builder,
    deposits,
    withdraws,
    executeWithInvocation: async (invocation: { kind: ActionKind }) => ({
      callAndProof: {
        call: {
          contractAddress: '0xPOOL',
          entrypoint: 'apply_actions',
          calldata: [invocation.kind],
        },
        proof: {
          data: `0x${invocation.kind}proof`,
          proofFacts: opts.emptyProofFacts ? [] : ['0x0fact'],
        },
      },
    }),
  };
}
