// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import type { Account, BlockIdentifier, constants } from 'starknet';
import { formatUnits } from 'viem';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  type Note,
} from '@starkware-libs/starknet-privacy-sdk';
import { config } from './config';
import { isUnexpectedEndOfJsonError } from '../lib/safe-json';

// The indexer's `/v1/sync/incoming_state` JSON parse lives inside the SDK's
// IndexerDiscoveryProvider (third-party — we can't guard its raw `resp.json()`
// at source). When the indexer returns a 500 / empty body, that `.json()` throws
// a bare "Unexpected end of JSON input" SyntaxError that would bubble up as a
// cryptic crash (the private-balance view showing "—"). Run the discovery call
// through this so an unparseable indexer response becomes a CLEAR, actionable
// error naming the endpoint; everything else (network, etc.) passes through.
async function withIndexerErrorMapping<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUnexpectedEndOfJsonError(err)) {
      throw new Error(
        'Indexer /v1/sync/incoming_state failed (non-JSON or empty response) — ' +
          'the discovery service may be down or returning a 500. Try again shortly.',
      );
    }
    throw err;
  }
}

// Discovers the user's PRIVATE (in-pool) balance: the sum of the amounts of the
// unspent notes the pool holds for this account in the configured deposit token.
//
// We construct `createPrivateTransfers` with the SAME wiring register.ts /
// deposit.ts use (in-memory account + viewingKeyProvider + provingProvider +
// IndexerDiscoveryProvider) so discovery shares that account/indexer context.
// The actual note lookup is `discoverNotes` on the IndexerDiscoveryProvider
// instance — exactly the reference demo's path
// (`starknet-privacy/demo/src/hooks/usePrivateState.ts`):
//
//   const { notes } = await indexer.discoverNotes(
//     BigInt(address), viewingKey, { tokens, blockIdentifier: 'pre_confirmed' });
//   // notes is an AddressMap<Note[]> keyed by token address; sum note.amount.
//
// `viewingKey` is in-memory only — never logged or persisted (callers hold it
// in a ref).
export interface DiscoverBalanceArgs {
  account: Account;
  viewingKey: bigint;
}

export async function discoverPrivateBalance(args: DiscoverBalanceArgs): Promise<bigint> {
  const { account, viewingKey } = args;

  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  // Build transfers the same way the writes do, so discovery runs in an
  // identical account/viewing-key/prover/indexer context. The note lookup
  // itself goes through the shared discoveryProvider (the demo's path).
  createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  const tokenAddress = BigInt(config.depositToken.address);
  const { notes } = await withIndexerErrorMapping(() =>
    discoveryProvider.discoverNotes(BigInt(account.address), viewingKey, {
      tokens: [tokenAddress],
      blockIdentifier: 'pre_confirmed',
    }),
  );

  // notes is an AddressMap<Note[]> keyed by token address (BigNumberish key).
  const tokenNotes = notes.get(tokenAddress) ?? [];
  return tokenNotes.reduce((sum: bigint, note: Note) => sum + BigInt(note.amount), 0n);
}

// Discovers the same PRIVATE balance as discoverPrivateBalance, but from the
// account ADDRESS + viewing key alone — no in-memory private key / Account
// object. Discovery is a read: the indexer lookup only needs the account address
// and the viewing key (the demo's path), so persisting the viewing key lets the
// dashboard show the in-pool balance on reconnect WITHOUT a re-sign. The viewing
// key is persisted by design (read-only capability — it can't move funds); the
// private key and the raw signature never are.
export async function discoverPrivateBalanceForAddress(args: {
  snAddress: string;
  viewingKey: bigint;
}): Promise<bigint> {
  const { snAddress, viewingKey } = args;
  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const tokenAddress = BigInt(config.depositToken.address);
  const { notes } = await withIndexerErrorMapping(() =>
    discoveryProvider.discoverNotes(BigInt(snAddress), viewingKey, {
      tokens: [tokenAddress],
      blockIdentifier: 'pre_confirmed',
    }),
  );
  const tokenNotes = notes.get(tokenAddress) ?? [];
  return tokenNotes.reduce((sum: bigint, note: Note) => sum + BigInt(note.amount), 0n);
}

// Discovers the account's set of spendable NOTE IDs (canonical decimal strings,
// sorted) for the given tokens at a specific block. Backs the prove-early
// quiescence gate (bridgeOut.ts): if the id-set is IDENTICAL at `latest − 12` and
// at head, the account committed no state in-window, so a block-pinned build at
// `latest − 12` won't reuse an already-consumed write-once slot (→ NON_ZERO_VALUE
// revert). Any addition OR removal (spend) makes the sets differ ⇒ the caller ages
// instead. Compare by id SET, not count — a spent-with-no-change note is a removal
// a max-of-count/created gate would miss.
//
// Reuses the SAME discoverNotes path as discoverPrivateBalance* — `blockIdentifier`
// is threaded verbatim to the indexer's `block_ref` (indexer-discovery.js). A
// historical NUMERIC block may be unsupported by the indexer; the caller wraps this
// in try/catch and degrades to aging, so a throw here is safe (pre-relay read).
// `viewingKey` is in-memory only — never logged or persisted.
export interface NoteIdsAtBlockArgs {
  snAddress: string;
  viewingKey: bigint;
  tokens: readonly bigint[];
  blockIdentifier: BlockIdentifier;
}

export async function discoverNoteIdsAtBlock(args: NoteIdsAtBlockArgs): Promise<string[]> {
  const { snAddress, viewingKey, tokens, blockIdentifier } = args;
  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const { notes } = await withIndexerErrorMapping(() =>
    discoveryProvider.discoverNotes(BigInt(snAddress), viewingKey, {
      tokens: [...tokens],
      blockIdentifier,
    }),
  );
  const ids: string[] = [];
  for (const token of tokens) {
    for (const note of notes.get(token) ?? []) ids.push(BigInt(note.id).toString());
  }
  return ids.sort();
}

// Format a USDC/pUSD *total or balance* for display to the nearest cent (exactly
// 2 decimal places). DISPLAY-ONLY — the result is lossy by design; NEVER feed it
// back into parsing / receipt math / persisted `amountHuman` strings (use
// formatTokenAmount / fromRawAmount / toRawAmount for those, which preserve
// round-trip precision).
//
// Accepts a raw bigint (scaled by `decimals`), a plain Number, or an
// already-humanized string. Non-finite / empty input (e.g. a partial user-typed
// value) echoes back the original string (or '' for a non-string) rather than
// "NaN", so a mid-typing amount never renders as garbage.
//
// Output is a bare "12.34" — no "$" and no thousands separators; call sites append
// the symbol / "$" themselves.
export function formatUsdcCents(value: bigint | number | string, decimals = 6): string {
  let n: number;
  if (typeof value === 'bigint') {
    n = Number(formatUnits(value, decimals));
  } else if (typeof value === 'number') {
    n = value;
  } else {
    const trimmed = value.trim();
    if (trimmed === '') return value;
    n = Number(trimmed);
  }
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : '';
  return n.toFixed(2);
}

// Format a raw bigint token amount as a plain decimal string (trailing zeros
// trimmed). Mirrors the demo's `formatAmount` (demo/src/format.ts).
export function formatTokenAmount(value: bigint, decimals: number): string {
  if (decimals < 0) throw new RangeError('formatTokenAmount: decimals must be >= 0, got ' + String(decimals));
  // Normalise the sign ONCE up front: bigint '%'/'/ ' truncate toward zero, so a
  // negative value would otherwise mix a negative `whole` with a negative
  // `fraction` string, producing a mangled result like '-1.-5' instead of '-1.5'.
  if (value < 0n) return '-' + formatTokenAmount(-value, decimals);
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
