// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Classifies ONE open-return WAL entry against chain state: what should the app's continue
// leg do for this slot?
//
// The WAL replaces inference with a lookup — the entry says a return was intended and from
// which block — so this module only has to answer the question the entry cannot: did the burn
// happen, and was it already claimed. Every answer that ACTS (`reburn` re-submits a burn,
// `claimed` deletes the record) must therefore rest on a completed, matched on-chain read;
// every failed or ambiguous read collapses to `unknown`, which acts on nothing.
//
// Two attribution rules carry the whole design:
//
//   - `scanDepositForBurnLogs` filters by DEPOSITOR only. A depositor match alone is never
//     terminal here: a log counts as this entry's burn only when its hookData equals
//     encodeCommitmentHookData(entry.commitment). A burn bound to a stale commitment (an
//     InboundAnonymizer redeploy re-derives it) belongs to a different return.
//   - The scan runs BEFORE the balance is consulted, always. Full-balance burns make "balance
//     above dust" look like "never burned" the moment fresh proceeds land on a wallet whose
//     burn already succeeded, and that misreading is the one that burns twice.
//
// `unknown.reason` is a fixed vocabulary, never a stringified error: provider errors embed the
// RPC endpoint (and its key) in their message, and this verdict is rendered by the app.
import type { PublicClient } from 'viem';

import { config, getEvmCctpSource } from './config';
import { LogRangeCapError, scanDepositForBurnLogs } from './chunkedLogScan';
import { fetchCctpMessageByTxHash, type CctpMessageMatch } from './polygonMint';
import { isCctpMessageNonceUsed } from './depositIn';
import { writeRecoveredInflightReturn, type RecoveredWriteOutcome } from './returnIn';
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
}

export type OpenReturnVerdict =
  // No burn carries this commitment and the funds are still on the wallet: re-run the fresh
  // return for the slot. Only reachable after a COMPLETED scan found nothing.
  | { kind: 'reburn' }
  // A hookData-matched burn exists on chain — upgrade the entry to `burned` under CAS.
  | { kind: 'burn-found'; burnTx: `0x${string}`; amountWei: bigint }
  // The CCTP nonce is unused: a cursor is in place, continue the mint+claim leg.
  | { kind: 'continue-claim'; write: RecoveredWriteOutcome }
  // The CCTP nonce is consumed — the mint+claim already landed. Delete the entry.
  | { kind: 'claimed' }
  // A read failed or answered ambiguously. NOT a classification: leave the entry alone.
  | { kind: 'unknown'; reason: UnknownReason };

// Closed vocabulary. Never derived from an error's text — a provider error carries the RPC
// URL and its key.
export type UnknownReason =
  | 'head-read-failed'
  | 'head-behind-intent-block'
  | 'burn-scan-range-capped'
  | 'burn-scan-failed'
  | 'balance-read-failed'
  | 'no-burn-and-balance-at-dust'
  | 'iris-message-unavailable'
  | 'nonce-read-failed';

const unknown = (reason: UnknownReason): OpenReturnVerdict => ({ kind: 'unknown', reason });

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
  if (entry.state === 'burned' && !/^0x[0-9a-fA-F]{64}$/.test(entry.burnTx ?? '')) {
    throw new Error(
      `resolveOpenReturn: a burned entry needs a burnTx hash (got ${JSON.stringify(entry.burnTx)})`,
    );
  }
}

// Required, not optional, `expectedHookData`: fetchCctpMessageByTxHash refuses a match
// without it, and it is the only field that tells two return burns apart.
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
  withCursorWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<OpenReturnVerdict> {
  const { entry, client, depositWallet, dustFloorWei } = p;
  assertEntry(entry, depositWallet);
  // Outside every try: a commitment or anonymizer this cannot encode is a schema violation,
  // not an unreachable service.
  const hookData = encodeCommitmentHookData(BigInt(entry.commitment));
  const match = returnMessageMatch(entry, hookData);

  if (entry.state === 'burned') {
    return classifyBurned(entry, match, depositWallet, p.withCursorWriteLock);
  }
  return classifyIntent(entry, client, depositWallet, dustFloorWei, hookData, p.scanFirst ?? true);
}

async function classifyBurned(
  entry: OpenReturnEntry,
  match: ReturnMessageMatch,
  depositWallet: `0x${string}`,
  withCursorWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<OpenReturnVerdict> {
  let message: `0x${string}`;
  try {
    // Single-shot, never polled. EVERY throw is unknown — including Iris's own terminal
    // status: a terminal verdict here deletes the entry, and only a hookData-matched read
    // may conclude anything about this burn.
    ({ message } = await fetchCctpMessageByTxHash(entry.burnTx as `0x${string}`, {
      sourceDomain: entry.sourceDomain,
      match,
    }));
  } catch {
    return unknown('iris-message-unavailable');
  }

  let nonceUsed: boolean;
  try {
    nonceUsed = await isCctpMessageNonceUsed(message);
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
  // burn is worse than a retryable failure.
  return { kind: 'continue-claim', write: await (withCursorWriteLock?.(write) ?? write()) };
}

async function classifyIntent(
  entry: OpenReturnEntry,
  client: PublicClient,
  depositWallet: `0x${string}`,
  dustFloorWei: bigint,
  hookData: `0x${string}`,
  scanFirst: boolean,
): Promise<OpenReturnVerdict> {
  const source = getEvmCctpSource(entry.evmChainId);
  if (!source) throw new Error(`no EVM CCTP source configured for chain ${entry.evmChainId}`);
  const readBalance = () => sumErc20Balances(client, [source.usdc], depositWallet);

  // Eager only when the caller opted out of scan-first; the scan still runs and still gates
  // `reburn`, so the flag buys nothing but read order.
  let balanceWei: bigint | undefined;
  if (!scanFirst) {
    try {
      balanceWei = await readBalance();
    } catch {
      return unknown('balance-read-failed');
    }
  }

  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch {
    return unknown('head-read-failed');
  }
  // A head behind the intent block is a lagging node, not an empty window: scanning would
  // throw on the inverted range, and assuming a window would manufacture absence.
  if (head < entry.intentBlock) return unknown('head-behind-intent-block');

  let matchedBurn;
  try {
    // chunkBlocks omitted on purpose — the scanner takes it from
    // config.polygonGetLogsChunkBlocks, so an operator's provider cap flows through here.
    const logs = await scanDepositForBurnLogs(client, {
      depositors: [depositWallet],
      fromBlock: entry.intentBlock,
      toBlock: head,
      evmChainId: entry.evmChainId,
    });
    const want = hookData.toLowerCase();
    // Oldest-first (the scanner's order): the oldest matched burn is the one to claim first.
    matchedBurn = logs.find((log) => log.hookData.toLowerCase() === want);
  } catch (err) {
    return unknown(err instanceof LogRangeCapError ? 'burn-scan-range-capped' : 'burn-scan-failed');
  }
  if (matchedBurn) {
    return {
      kind: 'burn-found',
      burnTx: matchedBurn.transactionHash,
      amountWei: matchedBurn.amount,
    };
  }

  if (balanceWei === undefined) {
    try {
      balanceWei = await readBalance();
    } catch {
      return unknown('balance-read-failed');
    }
  }
  // Full-balance burns make this a decision: funds still present ⇒ the burn was never
  // submitted. Funds gone with no matched burn ⇒ they left some other way, which this
  // module cannot explain and must not paper over.
  return balanceWei > dustFloorWei ? { kind: 'reburn' } : unknown('no-burn-and-balance-at-dust');
}
