// Per-account claim commitment (the H scheme), IDENTICAL to the Cairo Anonymizer.
// Frozen interface + test vector: ../../../../docs/bridge-interface.md §2-3.
//
// Poseidon over a span, mirroring the pool's hashes.cairo idiom:
//   poseidon_hash_span (Cairo)  ==  hash.computePoseidonHashOnElements (TS).
//
// In-memory only — never log or persist claim_secret / the viewing key.

import { shortString } from 'starknet';
import { assertCanonicalFelt, poseidon } from './felt.js';

// Domain-separation felt tags (Cairo short-string literals `<NAME>:V<version>`).
// Decimal values are pinned in bridge-interface.md §2 and asserted by the tester.
export const CLAIM_TAG = BigInt(shortString.encodeShortString('CLAIM_TAG:V1'));
export const BIND_TAG = BigInt(shortString.encodeShortString('BIND_TAG:V1'));
export const H_TAG = BigInt(shortString.encodeShortString('H_TAG:V1'));
// Tag for the per-account nonce derivation. NOT part of the frozen §3 test
// vector (which treats account_nonce as an opaque felt input) — it only
// domain-separates the recovery recipe below. The literal string passed to
// encodeShortString below is FROZEN (a poseidon hash input, mirrored by the
// Cairo Anonymizer) — do not change it even though the identifier itself was
// renamed (bridge-sdk-refactor.md Slice R).
export const ACCOUNT_NONCE_TAG = BigInt(shortString.encodeShortString('BIDNONCE:V1'));

// account_nonce = poseidon([ACCOUNT_NONCE_TAG, viewing_key, trade_counter]).
// Recovery recipe (bridge-plan.md §4): the per-account nonce is a deterministic
// child of the viewing key + the non-secret per-account index (`trade_counter`),
// so the whole return is recomputable from the single MetaMask signature + the
// saved index — no persisted secret. Feeds deriveClaimSecret. In-memory only;
// never log/persist the viewing key.
export function deriveAccountNonce(viewingKey: bigint, tradeCounter: number | bigint): bigint {
  // Guard: reject unsafe JS numbers before they reach BigInt(). IEEE-754
  // rounding means any number > 2^53 may have already lost precision, so two
  // distinct intended counters could silently map to the same double and then
  // to the same BigInt — producing the same nonce / claim_secret (issue #42).
  if (typeof tradeCounter === 'number' && !Number.isSafeInteger(tradeCounter))
    throw new Error('tradeCounter exceeds safe integer range; pass a bigint');
  const counter = BigInt(tradeCounter);
  // Felt-range guards on BOTH Poseidon inputs. Anything ≥ P reduces silently
  // mod P inside the hash — two distinct bigints that are congruent mod P then
  // map to the same account_nonce → same claim_secret → same derived EOA
  // (silent collision, mirrors #41's guard on computeClaimH).
  assertCanonicalFelt('tradeCounter', counter);
  assertCanonicalFelt('viewingKey', viewingKey);
  return poseidon([ACCOUNT_NONCE_TAG, viewingKey, counter]);
}

// claim_secret = poseidon([CLAIM_TAG, viewing_key, account_nonce]).
// One-way Poseidon child of the viewing key; reveals neither the VK nor other
// accounts. The raw viewing key is an input here only and is never revealed
// on-chain. See bridge-interface.md §2.
export function deriveClaimSecret(viewingKey: bigint, accountNonce: bigint): bigint {
  // Felt-range guards on BOTH Poseidon inputs — mirror deriveAccountNonce above.
  // A non-canonical viewing key OR account nonce ≥ P reduces silently mod P and
  // collides two distinct intended inputs onto the same claim_secret.
  assertCanonicalFelt('viewingKey', viewingKey);
  assertCanonicalFelt('accountNonce', accountNonce);
  return poseidon([CLAIM_TAG, viewingKey, accountNonce]);
}

export interface ClaimHArgs {
  claimSecret: bigint;
  amount: bigint; // fixed denomination as a felt (1 USDC = 1_000_000 @ 6dp)
  snDomain: bigint; // 25
}

// note_binding = poseidon([BIND_TAG, claim_secret])
// H            = poseidon([H_TAG, claim_secret, amount, sn_domain, note_binding])
//
// note_binding is bound to `claim_secret` (NOT a separate channel_key). This is
// the single value the on-chain `claim(claim_secret, amount, note_id)` can
// recompute: its frozen signature carries only `claim_secret` (revealing the
// viewing key / pool channel key on-chain is a hard rule, threat-model.md), so
// any binding the contract verifies must be derivable from `claim_secret`
// alone. claim_secret is already a one-way, single-use, per-account child of
// the viewing key, so it carries the ownership/anti-replay binding; the real
// front-run hardening is the Schnorr-over-note_id upgrade (bridge-plan.md
// Decision 2), which keeps H pure-Poseidon so it drops in unchanged.
//
// Byte-identical to the Cairo Anonymizer.compute_h and the frozen §3 vector.
// In-memory only — never log/persist claim_secret. See bridge-interface.md §2.
export function computeClaimH({ claimSecret, amount, snDomain }: ClaimHArgs): bigint {
  // All three inputs must be canonical felts in [0, P). Values outside this
  // range reduce silently mod P inside Poseidon — two distinct inputs that are
  // congruent mod P produce the same H (silent commitment collision, issue #41).
  assertCanonicalFelt('amount', amount);
  assertCanonicalFelt('claimSecret', claimSecret);
  assertCanonicalFelt('snDomain', snDomain);
  const noteBinding = poseidon([BIND_TAG, claimSecret]);
  return poseidon([H_TAG, claimSecret, amount, snDomain, noteBinding]);
}
