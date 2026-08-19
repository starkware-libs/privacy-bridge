// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Bridge-core: value-movement engine + key derivation for the starknet-privacy pool.
// Key derivation lives in ./derivation (physically absorbed from the former
// packages/shared).

// Key derivation (formerly packages/shared)
export {
  STARKNET_KEY_LABEL,
  VIEWING_KEY_LABEL,
  POLYGON_EOA_LABEL,
  RETURN_WAL_LABEL,
} from './derivation/index.js';
export { deriveStarknetPrivateKey, deriveStarknetAccount } from './derivation/index.js';
export type { StarknetAccount } from './derivation/index.js';
export { MAX_VIEWING_KEY, deriveViewingKey } from './derivation/index.js';
export { derivePolygonEoa } from './derivation/index.js';
export type { PolygonEoa } from './derivation/index.js';
export { deriveReturnWalKeys } from './derivation/index.js';
export type { ReturnWalKeys } from './derivation/index.js';
export {
  CLAIM_TAG,
  BIND_TAG,
  H_TAG,
  ACCOUNT_NONCE_TAG,
  deriveAccountNonce,
  deriveClaimSecret,
  computeClaimH,
} from './derivation/index.js';
export type { ClaimHArgs } from './derivation/index.js';
export {
  IDENTITY_KEY_TAG,
  RETURN_DAPP_NAME,
  computeIdentityKey,
  computeInboundCommitment,
  deriveInboundCommitment,
  encodeCommitmentHookData,
} from './derivation/index.js';
export type { InboundCommitmentArgs, DeriveInboundCommitmentArgs } from './derivation/index.js';

// Bridge engine modules
export * from './api.js';
