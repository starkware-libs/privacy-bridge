// Inbound-bind commitment (CCTP → pool RETURN leg), IDENTICAL to what the pool's
// `ComputeAndInvoke` recomputes on-chain and to the Cairo `InboundAnonymizer`.
//
// The commitment is placed in the CCTP burn's `hookData` (32-byte big-endian) so
// the mint atomically binds to it; at claim the pool derives the SAME commitment
// from the authenticated signer, so only the owner can claim.
//
//   identity_key = poseidon([IDENTITY_KEY_TAG, user_addr, user_private_key, inbound_addr])
//                  (pool `hashes.cairo::compute_identity_key`)
//   partial      = poseidon([identity_key, dapp_name, source_domain])
//   commitment   = poseidon([partial, nonce])
//                  (our `InboundAnonymizer::privacy_compute` — the commitment binds the
//                   EVM CCTP source_domain the return is burned FROM, e.g. Polygon = 7)
//
// Poseidon parity, as elsewhere in this package:
//   poseidon_hash_span (Cairo)  ==  hash.computePoseidonHashOnElements (TS).
//
// In-memory only — never log or persist the Starknet private key. The commitment
// itself is a one-way hash (safe to place on-chain in the CCTP message).

import { shortString } from 'starknet';
import { assertCanonicalFelt, poseidon } from './felt.js';

// Domain-separation tag for identity_key — FROZEN, byte-identical to the pool's
// `hashes.cairo` `IDENTITY_KEY_TAG` (`'IDENTITY_KEY_TAG:V1'`). Do not change.
export const IDENTITY_KEY_TAG = BigInt(shortString.encodeShortString('IDENTITY_KEY_TAG:V1'));

// dapp_name for the return leg — FROZEN, must match the Cairo test/prod `dapp_name`
// short-string literal `'pmp-return'` passed into `privacy_compute`.
export const RETURN_DAPP_NAME = BigInt(shortString.encodeShortString('pmp-return'));

// identity_key = poseidon([IDENTITY_KEY_TAG, user_addr, user_private_key, inbound_addr]).
// Mirrors the pool's `compute_identity_key`; the pool recomputes it on-chain from
// the AUTHENTICATED signer's own addr/private key (never client-supplied), so only
// the true owner reproduces it. `userPrivateKey` mirrors the Cairo parameter name
// and MUST be the pool identity's private key — which in the SDK is the VIEWING
// key (compiler.ts createPool(userViewingKey); register stores the viewing
// pubkey), NOT the derived Starknet spending key. A commitment derived with any
// other key lands on a ledger slot the pool can never recompute (funds stranded;
// live-verified on mainnet, PR #350). In-memory only, never logged/persisted.
export function computeIdentityKey(
  userAddr: bigint,
  userPrivateKey: bigint,
  inboundAddr: bigint,
): bigint {
  assertCanonicalFelt('userAddr', userAddr);
  assertCanonicalFelt('userPrivateKey', userPrivateKey);
  assertCanonicalFelt('inboundAddr', inboundAddr);
  return poseidon([IDENTITY_KEY_TAG, userAddr, userPrivateKey, inboundAddr]);
}

export interface InboundCommitmentArgs {
  identityKey: bigint;
  // Defaults to RETURN_DAPP_NAME; override only if the deployed contract's dapp tag differs.
  dappName?: bigint;
  // CCTP SOURCE domain the return is burned FROM (e.g. Polygon = 7, Base = 6). Bound
  // into the commitment so a return can only be claimed against the chain it left on;
  // MUST equal the `source_domain` the pool feeds `privacy_compute` at claim time.
  sourceDomain: number | bigint;
  // Deterministic per-return nonce (a felt). Derive it deterministically (e.g. from
  // the viewing key + trade counter) so the return stays recomputable for recovery.
  nonce: bigint;
}

// commitment = poseidon([poseidon([identity_key, dapp_name, source_domain]), nonce]) —
// byte-identical to the Cairo `InboundAnonymizer::privacy_compute` (two-stage: the
// nonce-independent partial commitment folded with the nonce).
export function computeInboundCommitment({
  identityKey,
  dappName = RETURN_DAPP_NAME,
  sourceDomain,
  nonce,
}: InboundCommitmentArgs): bigint {
  const sourceDomainFelt = BigInt(sourceDomain);
  assertCanonicalFelt('identityKey', identityKey);
  assertCanonicalFelt('dappName', dappName);
  assertCanonicalFelt('sourceDomain', sourceDomainFelt);
  assertCanonicalFelt('nonce', nonce);
  const partial = poseidon([identityKey, dappName, sourceDomainFelt]);
  return poseidon([partial, nonce]);
}

export interface DeriveInboundCommitmentArgs {
  userAddr: bigint;
  userPrivateKey: bigint;
  inboundAddr: bigint;
  sourceDomain: number | bigint;
  nonce: bigint;
  dappName?: bigint;
}

// Convenience: full derivation from the raw account inputs to the commitment that
// goes into the CCTP hookData. Equivalent to the pool computing identity_key then
// our privacy_compute.
export function deriveInboundCommitment(args: DeriveInboundCommitmentArgs): bigint {
  const identityKey = computeIdentityKey(args.userAddr, args.userPrivateKey, args.inboundAddr);
  return computeInboundCommitment({
    identityKey,
    dappName: args.dappName,
    sourceDomain: args.sourceDomain,
    nonce: args.nonce,
  });
}

// Encode a commitment felt as the 32-byte big-endian CCTP hookData (opaque bytes;
// CCTP does NOT endianness-convert hookData, so this MUST match the on-chain
// big-endian read in `InboundAnonymizer` (`read_word` at HOOK_DATA_OFFSET)).
export function encodeCommitmentHookData(commitment: bigint): `0x${string}` {
  assertCanonicalFelt('commitment', commitment);
  return `0x${commitment.toString(16).padStart(64, '0')}`;
}
