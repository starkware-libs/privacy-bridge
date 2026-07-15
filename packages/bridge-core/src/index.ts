// Bridge-core: value-movement engine + key derivation for the starknet-privacy pool.
// Key derivation lives in ./derivation (physically absorbed from the former
// packages/shared — see docs/bridge-sdk-refactor.md Slice Z).
// Design: ../../docs/superpowers/specs/2026-06-29-bridge-split-design.md

// Key derivation (formerly packages/shared)
export {
  IDENTITY_SIGN_MESSAGE,
  BRIDGE_IDENTITY_SIGN_MESSAGE,
  STARKNET_KEY_LABEL,
  VIEWING_KEY_LABEL,
  POLYGON_EOA_LABEL,
} from './derivation/index';
export { deriveStarknetPrivateKey, deriveStarknetAccount } from './derivation/index';
export type { StarknetAccount } from './derivation/index';
export { MAX_VIEWING_KEY, deriveViewingKey } from './derivation/index';
export { derivePolygonEoa } from './derivation/index';
export type { PolygonEoa } from './derivation/index';
export {
  CLAIM_TAG,
  BIND_TAG,
  H_TAG,
  ACCOUNT_NONCE_TAG,
  deriveAccountNonce,
  deriveClaimSecret,
  computeClaimH,
} from './derivation/index';
export type { ClaimHArgs } from './derivation/index';
export {
  IDENTITY_KEY_TAG,
  RETURN_DAPP_NAME,
  computeIdentityKey,
  computeInboundCommitment,
  deriveInboundCommitment,
  encodeCommitmentHookData,
} from './derivation/index';
export type { InboundCommitmentArgs, DeriveInboundCommitmentArgs } from './derivation/index';

// Bridge engine modules
export * from './api';
