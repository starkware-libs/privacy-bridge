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
// "Failed to fetch" — and (b) trip a provider's compute-units-per-second cap
// (Alchemy free tier, public nodes) — surfacing as HTTP 429. Three mitigations,
// all provider-agnostic and correctness-neutral (same reads, fewer/paced requests):
//   - batch.multicall: viem aggregates the concurrent ERC-20 balanceOf readContract
//     calls (sumErc20Balances) into ONE Multicall3 eth_call, cutting both the
//     request COUNT and the compute-units billed. Needs `chain` for the multicall3
//     address (polygon/polygonAmoy both carry the canonical deployment).
//   - transport batch: coalesces the remaining distinct JSON-RPC calls (getCode,
//     getTransactionCount, the multicall eth_call) across concurrent probes into a
//     single HTTP request, so a burst no longer exhausts browser connections.
//   - retryCount/retryDelay: viem retries 429 with exponential backoff, self-
//     throttling to the provider's sustainable rate (Retry-After honored if sent).
// NOTE: transport `batch` needs an RPC that accepts JSON-RPC batch arrays (the keyless
// default + Alchemy do). A provider that rejects them would 400 structurally (not
// retryable); the multicall batching alone still covers the balance-heavy reads.
export function getPolygonPublicClient(): PublicClient {
  const chain = config.polygon.chainId === polygon.id ? polygon : polygonAmoy;
  return createPublicClient({
    chain,
    batch: { multicall: true },
    transport: http(config.polygon.rpcUrl, { batch: true, retryCount: 6, retryDelay: 250 }),
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

// Most balanceOf reads one aggregate3 may carry. Everything this helper encodes is a fixed
// shape — balanceOf(address) — so a call count is a faithful proxy for the size, at a
// measured ~224 bytes of calldata per entry.
//
// SIZED BY CALLDATA, which is the binding constraint: 512 entries is ~112KB, comfortably
// under the ~1MB body limit providers typically impose, and the transport batches this call
// ALONGSIDE others into one POST so the budget cannot be spent all on us. Gas is not close
// to binding — ~2.9M against geth's default 50M eth_call cap, so ~17x of headroom even if
// the per-entry estimate is several times low.
//
// WHY A CAP AT ALL: without one the size is whatever a caller passes, an oversized call fails
// ALL-OR-NOTHING, and the callers above turn that into a hard scan failure rather than a
// degraded one. The realistic caller — a bid-scan wave, ten indices at two addresses each —
// is 60 entries, so this admits about eight times that before chunking, and never bites in
// practice. It is a robustness floor, not a tuning knob.
const MAX_BALANCE_CALLS_PER_AGGREGATE3 = 512;

export async function sumErc20Balances(
  client: PublicClient,
  tokens: string[],
  address: `0x${string}`,
  // Pins the read to ONE height. A caller that compares this sum against another read of the
  // same chain (a log scan's window, say) needs both to describe the same block, or funds that
  // moved between the two are visible to neither. Omitted ⇒ latest, as before.
  opts?: { blockNumber?: bigint },
): Promise<bigint> {
  const [sum] = await sumErc20BalancesMany(client, tokens, [address], opts);
  return sum ?? 0n;
}

/**
 * Sum of `balanceOf` across `tokens` for EACH of `addresses`, returned in the SAME ORDER,
 * from ONE Multicall3 `aggregate3` — a single eth_call for the whole set.
 *
 * WHY THIS EXISTS. `sumErc20Balances` is atomic per address, and that is what a caller
 * summing one wallet needs. But a caller sweeping MANY addresses in one pass — the bid-index
 * recovery scan probes a wave of indices, two addresses each — got one dedicated eth_call per
 * address, because an explicit `client.multicall` cannot be batched with anything: viem's
 * call.ts excludes aggregate3 calldata from its tick batcher (`shouldPerformMulticall` bails
 * on `data.startsWith(aggregate3Signature)`, so aggregate3 never nests inside aggregate3).
 * The per-address cost was therefore linear and unbatchable, and a wave of it is what trips a
 * provider's per-second method budget.
 *
 * This does NOT weaken the atomicity `sumErc20Balances` promises — it STRENGTHENS it. Every
 * balance in the set is read at one state root instead of one root per address, so an address
 * list can now be compared against itself as well: funds moving BETWEEN two addresses mid-sweep
 * can no longer be counted twice, which per-address sums could not rule out.
 *
 * `batchSize: 0` for the same reason as before: viem would otherwise split a long contract
 * array into several aggregate3 eth_calls, each answered at its own height, and the guarantee
 * above would quietly hold per chunk instead of per call. Chunking is done HERE instead, on
 * address boundaries and pinned to one height — see MAX_BALANCE_CALLS_PER_AGGREGATE3.
 *
 * A repeated address is read once per (address, token) pair as given — deduping addresses would
 * change the shape of the returned array, and the caller asked for a sum per entry.
 */
export async function sumErc20BalancesMany(
  client: PublicClient,
  tokens: string[],
  addresses: readonly `0x${string}`[],
  opts?: { blockNumber?: bigint },
): Promise<bigint[]> {
  const distinctTokens = [
    ...new Map(
      tokens
        .filter((token): token is string => Boolean(token))
        .map((token) => [token.toLowerCase(), token] as const),
    ).values(),
  ];
  // No tokens ⇒ every address sums to zero, and no request is worth sending. Same for no
  // addresses: return the (empty) array rather than an aggregate3 with no calls.
  if (distinctTokens.length === 0 || addresses.length === 0) {
    return addresses.map(() => 0n);
  }
  // Chunk on ADDRESS boundaries, never mid-address: a single address's sum must always land
  // in one aggregate3, because THAT is the atomicity the phantom-balance bug was about (the
  // three tokens are stations the same funds pass through). Cross-address atomicity is
  // preserved separately, by the pin below.
  //
  // Math.max(1, …) is the degenerate guard: a token list longer than the cap cannot fit one
  // address, and there the cap YIELDS — one address per chunk, over budget, rather than
  // splitting a sum. Exceeding a robustness limit is recoverable; a split sum is a money bug.
  const addressesPerChunk = Math.max(
    1,
    Math.floor(MAX_BALANCE_CALLS_PER_AGGREGATE3 / distinctTokens.length),
  );

  // One height for every chunk, so the documented guarantee — one state root for the WHOLE
  // set — stays literally true instead of quietly degrading to "per chunk" once a caller is
  // large enough to split. Costs one eth_blockNumber, and ONLY on the multi-chunk path: a
  // caller inside the cap (every realistic one) pays nothing and behaves exactly as before.
  // A caller that supplied its own blockNumber is already pinned and is left alone.
  let pinnedBlockNumber = opts?.blockNumber;
  if (pinnedBlockNumber === undefined && addresses.length > addressesPerChunk) {
    pinnedBlockNumber = await client.getBlockNumber();
  }

  const sums: bigint[] = [];
  // Serial, not Promise.all. Reaching here at all means an unusually large read; issuing
  // several multi-hundred-entry aggregate3s at once would either hand the provider a burst or
  // (once the transport batches them into one POST) rebuild the oversized body this cap
  // exists to avoid.
  for (let start = 0; start < addresses.length; start += addressesPerChunk) {
    const chunk = addresses.slice(start, start + addressesPerChunk);
    const balances = (await client.multicall({
      allowFailure: false,
      // The chunk must not be split again underneath us — see the note above.
      batchSize: 0,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: chunk.flatMap((address) =>
        distinctTokens.map((token) => ({
          address: token as `0x${string}`,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [address],
        })),
      ),
      ...(pinnedBlockNumber === undefined ? {} : { blockNumber: pinnedBlockNumber }),
    })) as bigint[];
    // Results come back in `contracts` order, which is address-major (flatMap above), so each
    // address's tokens are one contiguous run of length distinctTokens.length.
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const from = offset * distinctTokens.length;
      sums.push(
        balances
          .slice(from, from + distinctTokens.length)
          .reduce((total, balance) => total + balance, 0n),
      );
    }
  }
  return sums;
}
