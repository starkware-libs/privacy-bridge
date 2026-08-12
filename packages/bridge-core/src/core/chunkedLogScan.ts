// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Chunked DepositForBurn scan — the burn half of return recovery.
//
// The caller counts what this returns and compares the count against the pool's Claimed
// events; equal counts mean every burn was claimed. That inference is only as sound as the
// window, so this module's job is to make a short result impossible to mistake for an empty
// one:
//
//   - the window is walked in chunks no wider than the provider's getLogs range cap, which
//     is a property of the RPC PLAN (as low as 10 blocks) and therefore config, not a
//     constant;
//   - a provider that REJECTS a range surfaces as LogRangeCapError, with no partial result;
//   - a log missing the fields a count needs throws rather than being filtered out. A
//     dropped log turns matched > Claimed into matched == Claimed, i.e. a stuck burn read
//     as `settled` — the one wrong answer that loses money.
//
// Cap-vs-generic classification is message-based because JSON-RPC codes do not discriminate
// (-32600 is "invalid request" for any reason). A heuristic is acceptable because BOTH
// misreadings fail closed: a cap error read as generic propagates and fails the whole sweep,
// a generic error read as a cap degrades the slot to absence-unproven. Both withhold the
// completeness claim; neither can grant one.
//
// A provider that SILENTLY truncates instead of erroring defeats all of this, so the caller
// must keep treating a suspiciously short result as suspect.
import type { PublicClient } from 'viem';

import { config, getEvmCctpSource } from './config';
import { TOKEN_MESSENGER_EVENT_ABI } from './pendingReturnBurn';

// The provider refused the requested block range. Distinct from every other failure because
// the caller's response differs: absence is unproven for this slot and the window must be
// reported truncated, rather than the sweep failing outright.
export class LogRangeCapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LogRangeCapError';
  }
}

// One matched burn. `blockNumber`/`logIndex` order repeat burns from one wallet (the caller
// rebuilds the OLDEST unclaimed one first); `transactionHash` is what unlocks Iris, which
// has no address lookup.
export interface DepositForBurnLog {
  depositor: `0x${string}`;
  amount: bigint;
  destinationDomain: number;
  hookData: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

// Provider phrasings for "your range was too wide". Matched against the whole error chain
// because viem puts the provider's own text on the inner RpcRequestError's `details` while
// the outer error's shortMessage stays generic.
const RANGE_CAP_HINTS: readonly RegExp[] = [
  /block range/i,
  /\d+ blocks? (range|request|limit|window)/i,
  /range is too (large|wide)/i,
  /exceeds? (the )?maximum (block )?range/i,
  /(larger|wider) (block )?ranges?/i,
  /query returned more than \d+ results/i,
  /response size exceeded/i,
  /too many (logs|results)/i,
  /\bblocks? limit\b/i,
];

function errorChainText(err: unknown): string {
  const parts: string[] = [];
  for (let node: unknown = err, depth = 0; node && depth < 6; depth += 1) {
    const rec = node as Record<string, unknown>;
    for (const key of ['message', 'details', 'shortMessage']) {
      if (typeof rec[key] === 'string') parts.push(rec[key] as string);
    }
    node = rec.cause;
  }
  return parts.join('\n');
}

function isRangeCapRejection(err: unknown): boolean {
  const text = errorChainText(err);
  return RANGE_CAP_HINTS.some((hint) => hint.test(text));
}

type RawLog = {
  transactionHash: `0x${string}` | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  args: {
    depositor?: `0x${string}`;
    amount?: bigint;
    destinationDomain?: number;
    hookData?: `0x${string}`;
  };
};

// A log the caller can count on, or a throw. Never a silent omission.
function toDepositForBurnLog(log: RawLog): DepositForBurnLog {
  const { depositor, amount, destinationDomain, hookData } = log.args;
  if (
    depositor === undefined ||
    amount === undefined ||
    destinationDomain === undefined ||
    hookData === undefined ||
    log.transactionHash === null ||
    log.blockNumber === null ||
    log.logIndex === null
  ) {
    throw new Error(
      `incomplete DepositForBurn log at block ${log.blockNumber} — cannot be counted`,
    );
  }
  return {
    depositor,
    amount,
    destinationDomain,
    hookData,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

// Scan [fromBlock, toBlock] INCLUSIVE for DepositForBurn events from any of `depositors`.
// Results are oldest-first: chunks ascend and each provider response is block-ordered.
//
// `client` MUST be connected to `evmChainId`'s network — the same fund-safety rule
// resolvePendingReturnBurn follows, since a filter resolved for one chain and queried on
// another returns an empty log set that reads as "no burn happened". ASSERTED, not documented:
// that answer is indistinguishable from a real absence, so a comment cannot enforce it.
export async function scanDepositForBurnLogs(
  client: PublicClient,
  p: {
    depositors: `0x${string}`[];
    fromBlock: bigint;
    toBlock: bigint;
    chunkBlocks?: bigint;
    evmChainId?: number;
  },
): Promise<DepositForBurnLog[]> {
  // No depositor is a vacuous query, not an empty answer — and an empty `depositor` filter
  // would match every burn on the chain.
  if (p.depositors.length === 0) return [];
  if (p.fromBlock > p.toBlock) {
    throw new Error(`inverted scan range ${p.fromBlock}..${p.toBlock} — no window to scan`);
  }
  const chunkBlocks = p.chunkBlocks ?? BigInt(config.polygonGetLogsChunkBlocks);
  if (chunkBlocks <= 0n) {
    throw new Error(`getLogs chunk size must be a positive block count (got ${chunkBlocks})`);
  }
  const evmChainId = p.evmChainId ?? config.polygon.chainId;
  const source = getEvmCctpSource(evmChainId);
  if (!source) throw new Error(`no EVM CCTP source configured for chain ${evmChainId}`);
  // A PLAIN error, never LogRangeCapError: a cap means "absence unproven on the right chain",
  // which a caller may act on as a partial answer. A mismatch invalidates the whole query.
  const connectedChainId = await client.getChainId();
  if (connectedChainId !== evmChainId) {
    throw new Error(
      `refusing to scan chain ${evmChainId} on a client connected to chain ${connectedChainId} — ` +
        'its empty log set would read as proof that no burn happened',
    );
  }

  const out: DepositForBurnLog[] = [];
  for (let from = p.fromBlock; from <= p.toBlock; from += chunkBlocks) {
    const chunkEnd = from + chunkBlocks - 1n;
    const to = chunkEnd > p.toBlock ? p.toBlock : chunkEnd;
    let logs: RawLog[];
    try {
      logs = (await client.getLogs({
        address: source.tokenMessenger as `0x${string}`,
        event: TOKEN_MESSENGER_EVENT_ABI[0],
        args: { depositor: p.depositors },
        fromBlock: from,
        toBlock: to,
      })) as unknown as RawLog[];
    } catch (err) {
      if (isRangeCapRejection(err)) {
        throw new LogRangeCapError(
          `provider refused the ${to - from + 1n}-block range ${from}..${to}`,
          { cause: err },
        );
      }
      throw err;
    }
    for (const log of logs) out.push(toDepositForBurnLog(log));
  }
  return out;
}
