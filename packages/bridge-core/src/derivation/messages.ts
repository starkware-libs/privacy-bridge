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
