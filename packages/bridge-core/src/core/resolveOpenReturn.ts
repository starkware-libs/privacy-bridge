// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Classifies ONE open-return WAL entry against chain state: what should the app's continue
// leg do for this slot?
//
// A COMMAND, not a query. The `continue-claim` verdict writes a recovered cursor to device
// storage as part of reaching it, so this must never be called speculatively (per render, per
// poll tick) — call it once per resume decision.
//
// The WAL replaces inference with a lookup — the entry says a return was intended and from
// which block — so this module only has to answer the question the entry cannot: did the burn
// happen, and was it already claimed. Every answer that ACTS (`reburn` re-submits a burn,
// `claimed` deletes the record) must therefore rest on a completed, matched, COMMITTED
// on-chain read; every failed or ambiguous read collapses to `unknown`, which acts on nothing.
//
// Four rules carry the whole design:
//
//   - `scanDepositForBurnLogs` filters by DEPOSITOR only. A depositor match alone is never
//     terminal here: a log counts as this entry's burn only when its hookData equals
//     encodeCommitmentHookData(entry.commitment). A burn bound to a stale commitment (an
//     InboundAnonymizer redeploy re-derives it) belongs to a different return.
//   - The scan runs BEFORE the balance is consulted. Full-balance burns make "balance above
//     dust" look like "never burned" the moment fresh proceeds land on a wallet whose burn
//     already succeeded. The scan's window stops at the relayer's contract-enforced batch
//     deadline rather than at the head; the balance is then read at the head, since a reburn
//     spends what is on the wallet now.
//     The window covers the DEADLINE term of (intentBlock → submit) + deadline, not the first:
//     the enforced deadline runs from the SUBMIT, so a burn submitted long after its intent was
//     written can mine past intentBlock + the window. What keeps that gap short is W3 writing
//     the `burned {txHash}` upgrade right after submit, which moves the entry off this path
//     entirely. The residual is one case: submitted, the upgrade PUT failed, AND more than the
//     window elapsed between the intent write and the submit.
//   - The scan is bounded in REQUESTS as well as blocks (MAX_INTENT_SCAN_REQUESTS), because the
//     request count is the window divided by the operator's chunk size. The budget fails CLOSED:
//     exhausting it yields `unknown`, never absence — absence is what licenses a second burn. A
//     burn found in an early slice still wins, since positive evidence needs no full coverage.
//   - A burn that has not been MINED yet is also indistinguishable from a burn never
//     submitted, and no chain read can separate them — only the age of the intent can. Inside
//     the relayer's own deadline window, absence stays `unknown`.
//   - `claimed` is read at COMMITTED state, never pre_confirmed. Deferring a delete costs
//     nothing (deletion is idempotent and convergent); deleting against a claim that never
//     commits loses the only handle on minted-but-unclaimed funds.
//
// `unknown.reason` is a fixed vocabulary, never a stringified error: provider errors embed the
// RPC endpoint (and its key) in their message, and this verdict is rendered by the app.
import type { PublicClient } from 'viem';

import { config, getEvmCctpSource } from './config';
import { LogRangeCapError, scanDepositForBurnLogs, type DepositForBurnLog } from './chunkedLogScan';
import {
  fetchCctpMessageByTxHash,
  IrisMessageUnavailableError,
  type CctpMessageMatch,
} from './polygonMint';
import { isCctpMessageNonceUsed } from './depositIn';
import {
  writeRecoveredInflightReturn,
  DEFAULT_BATCH_DEADLINE_MS,
  type RecoveredWriteOutcome,
} from './returnIn';
import { PENDING_BURN_DEADLINE_GRACE_MS, DEADLINE_WINDOW_BLOCKS } from './pendingReturnBurn';
import { sumErc20Balances } from './polygonClient';
import { snAddressToBytes32 } from './snMint';
import { encodeCommitmentHookData } from '../derivation/index';

// One open return, as the WAL holds it. `burnTx` is REQUIRED once the state is `burned`;
// the two are checked together because a `burned` entry without it describes nothing.
export interface OpenReturnEntry {
  state: 'intent' | 'burned';
  accountIndex: number;
  channel?: string;
  commitment: string;
  intentBlock: bigint;
  sourceDomain: number;
  evmChainId: number;
  inboundAnonymizer: string;
  amountWei: bigint;
  burnTx?: `0x${string}`;
  // Wall clock at the intent write. OPTIONAL because a writer predating this field can exist;
  // absent is read as "past the deadline", the same rule returnIn applies to a missing burn
  // stamp. Only ever narrows `reburn` to `unknown`, never the reverse.
  intentAtMs?: number;
}

export type OpenReturnVerdict =
  // No burn carries this commitment and the funds are still on the wallet: re-run the fresh
  // return for the slot. Only reachable after a COMPLETED scan found nothing and the intent
  // is older than the window a submitted burn could still be executing in.
  // `orphanBurnTxs` lists burns from this wallet whose hookData matched a DIFFERENT
  // commitment — diagnostics only (they are somebody else's problem to claim), but they are
  // the only handle anyone has on them, so they are surfaced rather than dropped.
  | { kind: 'reburn'; orphanBurnTxs?: readonly `0x${string}`[] }
  // A hookData-matched burn exists on chain — upgrade the entry to `burned` under CAS.
  | { kind: 'burn-found'; burnTx: `0x${string}`; amountWei: bigint }
  // The CCTP nonce is unused: a cursor is in place, continue the mint+claim leg.
  // `write: 'occupied'` is NOT actionable — the cursor holding the slot belongs to a
  // DIFFERENT burn, so nothing was installed for this entry and continuing would drive the
  // other burn's claim. The caller must treat it as "another record owns this slot" and check
  // reciprocal occupancy (W3) rather than proceeding.
  | { kind: 'continue-claim'; write: RecoveredWriteOutcome }
  // The CCTP nonce is consumed at COMMITTED state — the mint+claim landed. Delete the entry.
  | { kind: 'claimed' }
  // The burn tx is mined and REVERTED, so no attestation for THAT tx will ever exist.
  // Actionable, which is why it is not `unknown` — an `unknown` here retries forever against a
  // tx that can never succeed.
  //
  // Required action: demote the entry to `intent` and re-resolve; NEVER delete. A reverted
  // burnTx proves only that THIS tx failed, not that no other burn for this commitment landed
  // — a second device resuming the same intent reverts on insufficient balance precisely
  // BECAUSE the first device's burn already took the funds. The demote path self-heals: the
  // reverted tx emitted no DepositForBurn log, so the re-scan finds only the burn that landed
  // and answers `burn-found`.
  | { kind: 'burn-reverted'; burnTx: `0x${string}` }
  // A read failed or answered ambiguously. NOT a classification: leave the entry alone.
  | { kind: 'unknown'; reason: UnknownReason };

// Closed vocabulary. Never derived from an error's text — a provider error carries the RPC
// URL and its key.
export type UnknownReason =
  | 'unsupported-chain'
  | 'head-read-failed'
  | 'head-behind-intent-block'
  | 'burn-scan-range-capped'
  | 'burn-scan-failed'
  // The request budget ran out before the deadline window was covered. Absence is UNPROVEN:
  // raise config.polygonGetLogsChunkBlocks to cover the window in fewer requests.
  | 'burn-scan-budget-exhausted'
  | 'multiple-matched-burns'
  | 'balance-read-failed'
  | 'no-burn-and-balance-at-dust'
  | 'intent-too-young'
  | 'iris-not-indexed'
  | 'iris-unmatched'
  | 'iris-incomplete'
  | 'iris-terminal'
  | 'nonce-read-failed';

const unknown = (reason: UnknownReason): OpenReturnVerdict => ({ kind: 'unknown', reason });

// How long after the intent write a submitted burn may still be unmined. The relayer's own
// batch deadline plus the same grace the pending-record guard releases on — absence-of-tx is
// one ambiguity class, so it gets one number, not a second timeout of its own.
const BURN_COULD_STILL_LAND_MS = DEFAULT_BATCH_DEADLINE_MS + PENDING_BURN_DEADLINE_GRACE_MS;

// Whether absence of a burn is allowed to mean "never submitted". A missing/non-numeric stamp
// is past the deadline (writers predating the field); a FUTURE stamp is conservatively live —
// a wall-clock step backwards is not evidence that no burn was sent, and acting on it burns
// twice. Mirrors returnIn's burnCouldStillBeExecuting.
function intentTooYoungToReburn(intentAtMs: number | undefined, nowMs: number): boolean {
  if (typeof intentAtMs !== 'number' || !Number.isFinite(intentAtMs)) return false;
  return nowMs <= intentAtMs + BURN_COULD_STILL_LAND_MS;
}

// Shape violations THROW rather than becoming a verdict: an entry this classifier cannot read
// is a bug in the writer, and a verdict would hide it behind a retryable-looking state.
function assertEntry(entry: OpenReturnEntry, depositWallet: `0x${string}`): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(depositWallet)) {
    throw new Error(`resolveOpenReturn: ${depositWallet} is not an EVM address`);
  }
  if (entry.state !== 'intent' && entry.state !== 'burned') {
    throw new Error(`resolveOpenReturn: unknown entry state ${JSON.stringify(entry.state)}`);
  }
  if (!Number.isInteger(entry.accountIndex) || entry.accountIndex < 0) {
    throw new Error(`resolveOpenReturn: accountIndex ${entry.accountIndex} is not a slot index`);
  }
  if (entry.amountWei <= 0n) {
    throw new Error(`resolveOpenReturn: amountWei ${entry.amountWei} describes no burn`);
  }
  if (entry.intentBlock < 0n) {
    throw new Error(`resolveOpenReturn: intentBlock ${entry.intentBlock} is not a block number`);
  }
  // A commitment that fails to parse — or parses to ZERO — encodes to a hookData no real burn
  // carries, so the discriminator would silently match nothing and an existing burn would read
  // as absent. Checked here rather than left to the hook encoder, which accepts zero as a
  // canonical felt.
  assertNonZeroCommitment(entry.commitment);
  if (entry.state === 'burned' && !/^0x[0-9a-fA-F]{64}$/.test(entry.burnTx ?? '')) {
    throw new Error(
      `resolveOpenReturn: a burned entry needs a burnTx hash (got ${JSON.stringify(entry.burnTx)})`,
    );
  }
}

function assertNonZeroCommitment(commitment: string): void {
  if (typeof commitment !== 'string' || !/^([0-9]+|0x[0-9a-fA-F]+)$/.test(commitment)) {
    throw new Error(`resolveOpenReturn: commitment ${JSON.stringify(commitment)} is not a felt`);
  }
  if (BigInt(commitment) === 0n) {
    throw new Error('resolveOpenReturn: commitment 0 matches no burn — refusing to classify');
  }
}

// Required, not optional, `expectedHookData`: fetchCctpMessageByTxHash refuses a match without
// it, and it is the only field that tells two return burns apart.
type ReturnMessageMatch = CctpMessageMatch & { expectedHookData: `0x${string}` };

function returnMessageMatch(entry: OpenReturnEntry, hookData: `0x${string}`): ReturnMessageMatch {
  return {
    expectedSourceDomain: entry.sourceDomain,
    expectedDestinationDomain: config.cctp.starknetDomain,
    // From the ENTRY, never config: the entry pins the anonymizer the burn was built
    // against, so a later redeploy cannot retarget this claim.
    expectedRecipient: snAddressToBytes32(entry.inboundAnonymizer),
    expectedHookData: hookData,
  };
}

export async function resolveOpenReturn(p: {
  entry: OpenReturnEntry;
  client: PublicClient;
  depositWallet: `0x${string}`;
  dustFloorWei: bigint;
  scanFirst?: boolean;
  nowMs?: number;
  withCursorWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<OpenReturnVerdict> {
  const { entry, client, depositWallet, dustFloorWei } = p;
  assertEntry(entry, depositWallet);
  // Outside every try: a commitment or anonymizer this cannot encode is a schema violation,
  // not an unreachable service.
  const hookData = encodeCommitmentHookData(BigInt(entry.commitment));
  const match = returnMessageMatch(entry, hookData);

  if (entry.state === 'burned') {
    return classifyBurned(entry, match, client, depositWallet, p.withCursorWriteLock);
  }
  return classifyIntent({
    entry,
    client,
    depositWallet,
    dustFloorWei,
    hookData,
    scanFirst: p.scanFirst ?? true,
    nowMs: p.nowMs ?? Date.now(),
  });
}

function irisFailureReason(err: unknown): UnknownReason {
  if (err instanceof IrisMessageUnavailableError) {
    if (err.reason === 'not-indexed') return 'iris-not-indexed';
    if (err.reason === 'unmatched') return 'iris-unmatched';
    return 'iris-incomplete';
  }
  // Iris rejected the attestation, or the read itself failed. Both mean "no usable message",
  // and neither may conclude anything about the burn's fate on its own.
  return 'iris-terminal';
}

// A MINED failure receipt for the burn tx — the one absence signal strong enough to be
// terminal. Anything else (no receipt, a read failure, a client on another chain whose empty
// answer proves nothing) is `false`, leaving the caller's weaker verdict in place.
async function burnTxRevertedOnChain(
  client: PublicClient,
  entry: OpenReturnEntry,
): Promise<boolean> {
  try {
    if ((await client.getChainId()) !== entry.evmChainId) return false;
    const receipt = await client.getTransactionReceipt({ hash: entry.burnTx as `0x${string}` });
    return receipt.status === 'reverted';
  } catch {
    return false;
  }
}

async function classifyBurned(
  entry: OpenReturnEntry,
  match: ReturnMessageMatch,
  client: PublicClient,
  depositWallet: `0x${string}`,
  withCursorWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<OpenReturnVerdict> {
  let message: `0x${string}`;
  try {
    // Single-shot, never polled. EVERY throw is non-terminal on its own — including Iris's own
    // terminal status: only a hookData-matched read may conclude anything about this burn.
    ({ message } = await fetchCctpMessageByTxHash(entry.burnTx as `0x${string}`, {
      sourceDomain: entry.sourceDomain,
      match,
    }));
  } catch (err) {
    const reason = irisFailureReason(err);
    // Iris having NO message of ours is the one case a receipt can explain: a reverted burn
    // produces no CCTP message, ever. The other buckets mean Iris HAS our message, so the
    // burn plainly succeeded and a receipt read would only cost an RPC.
    if (reason === 'iris-not-indexed' || reason === 'iris-unmatched') {
      if (await burnTxRevertedOnChain(client, entry)) {
        return { kind: 'burn-reverted', burnTx: entry.burnTx as `0x${string}` };
      }
    }
    return unknown(reason);
  }

  let nonceUsed: boolean;
  try {
    // 'latest' (COMMITTED), not the default pre_confirmed: this read's `true` deletes the
    // entry, and a pre-confirmed claim can still be rolled back.
    nonceUsed = await isCctpMessageNonceUsed(message, { blockIdentifier: 'latest' });
  } catch {
    return unknown('nonce-read-failed');
  }
  if (nonceUsed) return { kind: 'claimed' };

  const write = async () =>
    writeRecoveredInflightReturn(depositWallet, {
      accountIndex: entry.accountIndex,
      burnTx: entry.burnTx as string,
      sourceDomain: entry.sourceDomain,
      amountWei: entry.amountWei,
      commitment: entry.commitment,
      evmChainId: entry.evmChainId,
      inboundAnonymizer: entry.inboundAnonymizer,
      ...(entry.channel === undefined ? {} : { channel: entry.channel }),
    });
  // A lock throw PROPAGATES: no lock means no serialized write, and a second cursor for one
  // burn is worse than a retryable failure. The lock is also the seam W3 uses to make its
  // reciprocal-occupancy check atomic with this write.
  return { kind: 'continue-claim', write: await (withCursorWriteLock?.(write) ?? write()) };
}

// Hard ceiling on eth_getLogs requests one intent resolution may spend. The deadline window
// bounds the scan in BLOCKS; this bounds it in CALLS, which is what a resume pass over many
// slots actually pays. Fails CLOSED: an exhausted budget answers `unknown`, never absence.
//
// An operator whose chunk size covers the window within this budget — chunk >= window/10, i.e.
// >= 841 blocks for today's 8401-block inclusive window — sees no behavior change at all.
export const MAX_INTENT_SCAN_REQUESTS = 10;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// Degraded path: the window needs more requests than the budget allows, so full coverage is
// off the table. Walk chunk-wide slices forward from the intent block and stop the moment a
// matched burn appears — positive evidence stays positive under partial coverage, and it is the
// verdict that PREVENTS a second burn. Absence gets the opposite treatment: an exhausted budget
// may never conclude "no burn happened".
//
// Each slice is its own complete scanDepositForBurnLogs call, one chunk wide, so that module's
// contract ("cover the whole range or throw, never a partial answer") holds per call — the
// partiality lives here, where it is named in the verdict.
async function scanOnBudget(p: {
  client: PublicClient;
  depositWallet: `0x${string}`;
  want: string;
  evmChainId: number;
  fromBlock: bigint;
  chunkBlocks: bigint;
}): Promise<OpenReturnVerdict> {
  let from = p.fromBlock;
  for (let spent = 0; spent < MAX_INTENT_SCAN_REQUESTS; spent += 1) {
    const logs = oldestFirst(
      await scanDepositForBurnLogs(p.client, {
        depositors: [p.depositWallet],
        fromBlock: from,
        toBlock: from + p.chunkBlocks - 1n,
        chunkBlocks: p.chunkBlocks,
        evmChainId: p.evmChainId,
      }),
    );
    const matched = logs.filter((log) => log.hookData.toLowerCase() === p.want);
    if (matched.length > 1) return unknown('multiple-matched-burns');
    const burn = matched[0];
    if (burn) return { kind: 'burn-found', burnTx: burn.transactionHash, amountWei: burn.amount };
    from += p.chunkBlocks;
  }
  return unknown('burn-scan-budget-exhausted');
}

// Ascending (blockNumber, logIndex). Provider log order is not part of any contract, and the
// reported orphan list is oldest-first regardless of it. Determinism of the matched PICK is
// enforced upstream instead — two matches refuse rather than choose.
function oldestFirst(logs: DepositForBurnLog[]): DepositForBurnLog[] {
  return [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}

async function classifyIntent(p: {
  entry: OpenReturnEntry;
  client: PublicClient;
  depositWallet: `0x${string}`;
  dustFloorWei: bigint;
  hookData: `0x${string}`;
  scanFirst: boolean;
  nowMs: number;
}): Promise<OpenReturnVerdict> {
  const { entry, client, depositWallet, dustFloorWei, hookData, scanFirst, nowMs } = p;
  // A VERDICT, not a throw: one stale entry naming a retired chain must not abort a whole
  // resume pass over the user's other slots.
  const source = getEvmCctpSource(entry.evmChainId);
  if (!source) return unknown('unsupported-chain');

  // Head first even in the eager-balance branch: both reads must name the same height, and
  // only the head read can supply it.
  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch {
    return unknown('head-read-failed');
  }
  // A head behind the intent block is a lagging node, not an empty window: scanning would
  // throw on the inverted range and assuming a window would manufacture absence.
  if (head < entry.intentBlock) return unknown('head-behind-intent-block');

  // The scan stops at the deadline window, not at the head: the relayer's batch deadline is
  // contract-enforced, so a burn submitted for THIS intent cannot execute past it — the same
  // property that licenses concluding "never landed" instead of "not yet". Bounds the request to
  // a FIXED span rather than one that grows with the entry's age (see the module header for the
  // intent→submit gap this does not cover).
  const deadlineEnd = entry.intentBlock + DEADLINE_WINDOW_BLOCKS;
  const scanTo = head < deadlineEnd ? head : deadlineEnd;

  // Balance at the HEAD, deliberately not at `scanTo`: the scan asks how far a burn could have
  // landed, the balance asks what is on the wallet NOW, and a reburn spends what is there now.
  // Reading it later than the scan cannot hide a burn, because past `scanTo` no burn for this
  // intent can exist. In the uncapped regime the two heights coincide.
  const readBalance = () =>
    sumErc20Balances(client, [source.usdc], depositWallet, { blockNumber: head });

  let balanceWei: bigint | undefined;
  if (!scanFirst) {
    try {
      balanceWei = await readBalance();
    } catch {
      return unknown('balance-read-failed');
    }
  }

  const want = hookData.toLowerCase();
  // The window is bounded in BLOCKS, but its cost in requests is that span divided by the
  // operator's chunk size — so a small chunk turns a bounded window into an unbounded scan.
  const chunkBlocks = BigInt(config.polygonGetLogsChunkBlocks);
  const requestsNeeded = ceilDiv(scanTo - entry.intentBlock + 1n, chunkBlocks);

  let matched: DepositForBurnLog[];
  let orphanBurnTxs: `0x${string}`[];
  try {
    if (requestsNeeded > BigInt(MAX_INTENT_SCAN_REQUESTS)) {
      return await scanOnBudget({
        client,
        depositWallet,
        want,
        evmChainId: entry.evmChainId,
        fromBlock: entry.intentBlock,
        chunkBlocks,
      });
    }
    // chunkBlocks omitted on purpose — the scanner takes it from
    // config.polygonGetLogsChunkBlocks, the value the budget above was measured against.
    const logs = oldestFirst(
      await scanDepositForBurnLogs(client, {
        depositors: [depositWallet],
        fromBlock: entry.intentBlock,
        toBlock: scanTo,
        evmChainId: entry.evmChainId,
      }),
    );
    matched = logs.filter((log) => log.hookData.toLowerCase() === want);
    orphanBurnTxs = [
      ...new Set(
        logs.filter((log) => log.hookData.toLowerCase() !== want).map((log) => log.transactionHash),
      ),
    ];
  } catch (err) {
    return unknown(err instanceof LogRangeCapError ? 'burn-scan-range-capped' : 'burn-scan-failed');
  }
  // Two burns carrying one commitment is a state this module cannot explain, and picking one
  // would send the app to claim a burn it cannot prove is the right one.
  if (matched.length > 1) return unknown('multiple-matched-burns');
  const burn = matched[0];
  if (burn) {
    return { kind: 'burn-found', burnTx: burn.transactionHash, amountWei: burn.amount };
  }

  if (balanceWei === undefined) {
    try {
      balanceWei = await readBalance();
    } catch {
      return unknown('balance-read-failed');
    }
  }
  // Full-balance burns make this a decision: funds still present ⇒ the burn was never
  // submitted. Funds gone with no matched burn ⇒ they left some other way, which this module
  // cannot explain and must not paper over.
  if (balanceWei <= dustFloorWei) return unknown('no-burn-and-balance-at-dust');
  // Funds present AND the burn could still be executing: the two states are identical on
  // chain, so only the clock separates them, and only silence is safe.
  if (intentTooYoungToReburn(entry.intentAtMs, nowMs)) return unknown('intent-too-young');
  return {
    kind: 'reburn',
    ...(orphanBurnTxs.length === 0 ? {} : { orphanBurnTxs }),
  };
}
