// Fixed strings the user signs / that scope key derivation.
//
// Each *_SIGN_MESSAGE below is the sole secret input to identity derivation: the
// EVM wallet signs it, and that signature seeds the Starknet account, the pool
// viewing key, and every per-account Polygon EOA. So the message string IS the
// identity domain — change it (text or "Version") and every derived key changes,
// orphaning existing funds. Never edit one except via a deliberate migration
// (re-derive + move funds), never a silent text tweak.
//
// The two apps derive DELIBERATELY-ISOLATED identities (see architecture.md Key
// decisions): the trade app (apps/web) signs IDENTITY_SIGN_MESSAGE, the bridge
// app (apps/bridge) signs BRIDGE_IDENTITY_SIGN_MESSAGE. They must stay distinct;
// each carries its own independent "Version". The domain-separation labels below
// are shared by both apps and are versioned independently of the messages.

// Trade app (apps/web). App-bound, human-readable, and explicit that it is
// off-chain and free — so the wallet's signing prompt is trustworthy at a glance.
export const IDENTITY_SIGN_MESSAGE = [
  'Polymarket Privacy — derive Starknet keys',
  '',
  'Sign this message to deterministically derive your Starknet account and',
  'privacy-pool viewing key in your browser. The signature never leaves this',
  'device and no keys are stored.',
  '',
  'This is an off-chain signature. It is not a transaction and costs no gas.',
  '',
  'Version: 1',
].join('\n');

// Bridge app (apps/bridge). A separate identity domain from IDENTITY_SIGN_MESSAGE
// above (isolated by design) — same reassurances, distinct first line + Version.
export const BRIDGE_IDENTITY_SIGN_MESSAGE = [
  'Enter the privacy pool bridge — derive Starknet keys',
  '',
  'Sign this message to deterministically derive your Starknet account and',
  'privacy-pool viewing key in your browser. The signature never leaves this',
  'device and no keys are stored.',
  '',
  'This is an off-chain signature. It is not a transaction and costs no gas.',
  '',
  'Version: 2',
].join('\n');

// Domain-separation labels appended to the EVM signature before hashing, so the
// account key and viewing key are derived from unrelated seeds.
export const STARKNET_KEY_LABEL = 'starknet-account:v1';
export const VIEWING_KEY_LABEL = 'viewing-key:v1';

// Scopes the per-account Polygon (EVM) trading EOA. Folded with a per-account
// index so every account derives a fresh, mutually-unlinkable address from the
// same EVM signature — distinct from the Starknet/viewing-key domains above
// (`bridge-plan.md` §5).
export const POLYGON_EOA_LABEL = 'polygon-eoa:v1';
