// Read-only Polygon client + ERC-20 balance helpers (Polymarket-free).
import { createPublicClient, http, type PublicClient } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { config } from './config';

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
 * read ATOMICALLY: every balance is taken at ONE explicit block. Generic (no
 * Polymarket coupling) — callers pass whichever token addresses are relevant to
 * them (e.g. apps/web sums native USDC + its Polymarket collateral tokens to size
 * a returnable balance). Falsy entries are skipped, and a repeated address
 * (compared case-insensitively) is counted ONCE — a config that points two token
 * keys at one contract must not double its balance.
 *
 * WHY THE PIN. The summed tokens are often stations the SAME funds pass through
 * (pUSD → USDC.e → native USDC converts in place, one tx per leg), so this sum is
 * only meaningful as a statement about a single state root. Reads at "latest" are
 * NOT that: viem's multicall batcher packs same-tick reads from the whole app into
 * aggregate3 chunks and SPLITS them past `batchSize` (1024 bytes of calldata), and
 * split chunks are separate eth_calls, each answered at its own "latest". Under
 * real load one wallet's token reads land in different chunks — and when a
 * conversion tx lands between those blocks, the same chunk of money is counted
 * once per token it passed through (measured in the field: a $30.20 wallet
 * reading $60.40 and $90.60 while a redeem's return legs were in flight).
 *
 * Pinning composes better than an explicit per-call multicall would: viem keys its
 * multicall scheduler by block tag, so same-block reads from a scan wave still
 * aggregate into shared aggregate3 calls (now carrying the block), while a forced
 * per-wallet `client.multicall` would fragment that wave into one call per wallet.
 * `getBlockNumber` is cached (viem cacheTime), so concurrent sums share one fetch.
 * A lagging node that hasn't seen the pinned block errors and viem's retry re-asks
 * — strictly better than silently answering from a different moment.
 *
 * `options.blockNumber` lets a caller pin several RELATED reads (e.g. a wallet's
 * sum and its EOA's sum) to one block; omitted, the latest block is fetched once.
 */
export async function sumErc20Balances(
  client: PublicClient,
  tokens: string[],
  address: `0x${string}`,
  options?: { blockNumber?: bigint },
): Promise<bigint> {
  const distinctTokens = [
    ...new Map(
      tokens
        .filter((token): token is string => Boolean(token))
        .map((token) => [token.toLowerCase(), token] as const),
    ).values(),
  ];
  if (distinctTokens.length === 0) return 0n;
  const blockNumber = options?.blockNumber ?? (await client.getBlockNumber());
  const balances = await Promise.all(
    distinctTokens.map((token) =>
      client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [address],
        blockNumber,
      }),
    ),
  );
  return balances.reduce((sum, bal) => sum + bal, 0n);
}
