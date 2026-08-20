// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Read-only Polygon client + ERC-20 balance helpers (Polymarket-free).
import { createPublicClient, http, type PublicClient } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { config } from './config.js';

// Polygon USDC is 6-decimal native Circle USDC (config.ts:223 "Polygon Amoy USDC (6 dp)").
export const POLYGON_USDC_DECIMALS = 6;

// Minimal ERC-20 read ABI — mirrors the inline ABIs in depositIn.ts / polygonMint.ts.
const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// One reusable read-only Polygon client. Created on demand (no global singleton),
// matching the per-use pattern in polygonMint.ts:408 / depositIn.ts.
//
// The recovery/History scans fan out many balance + code + nonce reads in bursts,
// which (a) exhaust the browser's ~6-connections-per-host limit — surfacing as
// "Failed to fetch" — and (b) trip a provider's per-second method cap — surfacing as
// HTTP 429. Three mitigations, all provider-agnostic and correctness-neutral (same
// reads, fewer/paced requests):
//   - batch.multicall: viem folds concurrent plain `readContract` calls into ONE
//     Multicall3 eth_call, cutting both the request count and the compute units
//     billed. Needs `chain` for the multicall3 address (polygon/polygonAmoy both
//     carry the canonical deployment). NOTE this does NOT cover sumErc20Balances:
//     that issues an EXPLICIT client.multicall, and viem's call.ts excludes
//     aggregate3 calldata from the tick batcher (so aggregate3 never nests inside
//     aggregate3), which is why that helper batches ACROSS ADDRESSES itself —
//     see sumErc20BalancesMany.
//   - transport batch: coalesces the distinct JSON-RPC calls (getCode,
//     getTransactionCount, each aggregate3 eth_call) across concurrent probes into a
//     single HTTP request, so a burst no longer exhausts browser connections.
//   - retryCount/retryDelay: viem retries a 429 with exponential backoff, honouring
//     Retry-After when the provider sends one (buildRequest.js reads the header).
// NOTE: transport `batch` needs an RPC that accepts JSON-RPC batch arrays (the keyless
// default + Alchemy do). A provider that rejects them would 400 structurally (not
// retryable); the multicall batching alone still covers the balance-heavy reads.
//
// RETRY BUDGET. Deliberately small. viem's backoff doubles from retryDelay, so the
// tail dominates: at six retries a single throttled request costs seven POSTs and
// about sixteen seconds of wall clock before it ever rejects — long enough on its own
// to exhaust a caller's whole scan timeout, and it re-sends the SAME batch into a
// provider that is already shedding. At two, the same failure costs three POSTs and
// under a second, which is a retry budget for a transient blip rather than a
// self-inflicted stall.
//
// Retrying HARDER is also the wrong shape of fix, for the reason a per-worker sleep
// inside a fan-out is: it paces one request while every other worker keeps hammering
// the same endpoint. Backpressure belongs where it can hold the whole channel back
// after one 429 — the consuming app's request gate — not in each request's own
// private retry loop.
const RPC_RETRY_COUNT = 2;
const RPC_RETRY_DELAY_MS = 250;

export function getPolygonPublicClient(): PublicClient {
  const chain = config.polygon.chainId === polygon.id ? polygon : polygonAmoy;
  return createPublicClient({
    chain,
    batch: { multicall: true },
    transport: http(config.polygon.rpcUrl, {
      batch: true,
      retryCount: RPC_RETRY_COUNT,
      retryDelay: RPC_RETRY_DELAY_MS,
    }),
  });
}

// USDC balance (raw wei, 6 dp) of `address` on Polygon. The on-chain proof that a
// per-account EOA was funded by a CCTP mint (the recovery signal — see accountScan.ts).
export async function readUsdcBalance(
  client: PublicClient,
  address: `0x${string}`,
): Promise<bigint> {
  return client.readContract({
    address: config.polygon.usdc as `0x${string}`,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

/**
 * Sum of `balanceOf(address)` across an arbitrary ERC-20 token list on Polygon,
 * read ATOMICALLY: all balances are fetched in ONE Multicall3 `aggregate3` call —
 * a single eth_call, a single EVM execution, a single state root. Generic (no
 * Polymarket coupling); falsy entries are skipped, and a repeated address
 * (compared case-insensitively) is counted ONCE — a config that points two token
 * keys at one contract must not double its balance.
 *
 * WHY ONE CALL, NOT N PINNED READS. The summed tokens are often stations the SAME
 * funds pass through (pUSD → USDC.e → native USDC converts in place, one tx per
 * leg), so the sum is only meaningful at a single block. N parallel reads at
 * "latest" are not that: viem's tick batcher merges same-turn reads app-wide into
 * aggregate3 chunks and SPLITS them past its calldata cap, and split chunks are
 * separate eth_calls each answered at its own "latest" — a conversion landing
 * between their blocks counts the same money once per token (measured in the
 * field: a $30.20 wallet summing to $60.40 and $90.60 mid-redeem). A single
 * explicit aggregate3 cannot be split: it enters any outer batch as ONE entry, so
 * the atomicity boundary rides inside it whatever the batcher does around it.
 *
 * The multicall3 address is passed explicitly (the canonical deployment, byte-
 * identical across Polygon/Amoy and most chains) so the read also works on
 * clients built without a `chain` — test transports and minimal callers included.
 */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export async function sumErc20Balances(
  client: PublicClient,
  tokens: string[],
  address: `0x${string}`,
  // Pins the read to ONE height. A caller that compares this sum against another read of the
  // same chain (a log scan's window, say) needs both to describe the same block, or funds that
  // moved between the two are visible to neither. Omitted ⇒ latest, as before.
  opts?: { blockNumber?: bigint },
): Promise<bigint> {
  const distinctTokens = [
    ...new Map(
      tokens
        .filter((token): token is string => Boolean(token))
        .map((token) => [token.toLowerCase(), token] as const),
    ).values(),
  ];
  if (distinctTokens.length === 0) return 0n;
  const balances = await client.multicall({
    allowFailure: false,
    // This public helper promises one EVM state root even for an arbitrary token list.
    // Viem otherwise splits large contract arrays into multiple aggregate3 eth_calls.
    batchSize: 0,
    multicallAddress: MULTICALL3_ADDRESS,
    contracts: distinctTokens.map((token) => ({
      address: token as `0x${string}`,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address],
    })),
    ...(opts?.blockNumber === undefined ? {} : { blockNumber: opts.blockNumber }),
  });
  return (balances as bigint[]).reduce((sum, bal) => sum + bal, 0n);
}
