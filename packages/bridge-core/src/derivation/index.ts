// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Client-side, in-memory key derivation from an EVM wallet signature.
// Pure functions only — no DOM/network/React. Never log or persist raw keys.
// (Absorbed from the former packages/shared.)

export {
  STARKNET_KEY_LABEL,
  VIEWING_KEY_LABEL,
  POLYGON_EOA_LABEL,
  RETURN_WAL_LABEL,
} from './messages.js';
export { deriveStarknetPrivateKey, deriveStarknetAccount } from './starknet-key.js';
export type { StarknetAccount } from './starknet-key.js';
export { MAX_VIEWING_KEY, deriveViewingKey } from './viewing-key.js';
export { derivePolygonEoa } from './polygon-key.js';
export type { PolygonEoa } from './polygon-key.js';
export { deriveReturnWalKeys } from './return-wal.js';
export type { ReturnWalKeys } from './return-wal.js';
export {
  CLAIM_TAG,
  BIND_TAG,
  H_TAG,
  ACCOUNT_NONCE_TAG,
  deriveAccountNonce,
  deriveClaimSecret,
  computeClaimH,
} from './claim-commitment.js';
export type { ClaimHArgs } from './claim-commitment.js';
export {
  IDENTITY_KEY_TAG,
  RETURN_DAPP_NAME,
  computeIdentityKey,
  computeInboundCommitment,
  deriveInboundCommitment,
  encodeCommitmentHookData,
} from './inbound-commitment.js';
export type { InboundCommitmentArgs, DeriveInboundCommitmentArgs } from './inbound-commitment.js';
