// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Domain-separation labels for key derivation. These are part of the derivation
// contract: the EVM signature is folded with each label so the Starknet account
// key, the pool viewing key, and every per-account Polygon EOA derive from
// unrelated seeds. Change a label (text or version) and every derived key
// changes, orphaning existing funds — only via a deliberate migration.
//
// The signature MESSAGE the wallet signs is app-owned (each consuming app supplies
// its own, so the SDK carries no app branding); the SDK only defines the labels
// below, which both apps share.

// Appended to the EVM signature before hashing the Starknet account key.
export const STARKNET_KEY_LABEL = 'starknet-account:v1';
// Appended before hashing the pool viewing key.
export const VIEWING_KEY_LABEL = 'viewing-key:v1';
// Scopes the per-account Polygon (EVM) trading EOA. Folded with a per-account
// index so every account derives a fresh, mutually-unlinkable address from the
// same EVM signature — distinct from the Starknet/viewing-key domains above.
export const POLYGON_EOA_LABEL = 'polygon-eoa:v1';

// Validate a named account channel (the optional 2nd derivation domain). BOTH
// derivation roots (derivePolygonEoa, deriveAccountNonce) call this so their accepted
// channels are IDENTICAL — otherwise a channel could yield a Polygon EOA but throw
// when deriving the recoverable pool commitment (a wallet you can fund but not
// recover). Constraints: non-empty; ≤31 chars (encodes as a single Cairo short
// string for the nonce fold); slug charset only — ASCII, and excludes ':' so it can
// never blur the ':'-delimited EOA seed preimage. Channels are compile-time
// constants, so this is a fail-closed developer guard, not input sanitization.
export function assertValidChannel(channel: string): void {
  if (typeof channel !== 'string' || channel.length === 0 || channel.length > 31) {
    throw new Error('channel must be a non-empty string of at most 31 characters');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(channel)) {
    throw new Error('channel must be a slug matching [A-Za-z0-9._-] (ASCII, no ":")');
  }
}
